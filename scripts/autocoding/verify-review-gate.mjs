/**
 * AUTOCODING_REVIEW_RECEIPT_V1 — fail-closed validator.
 *
 * Kern: `evaluateReceipts(receipts, context, policy)` is een pure functie. Ze rekent zelf niets uit
 * over GitHub — `context.pr_head_sha` / `context.pr_tree_sha` / `context.builder_actor` moeten al
 * gemeten zijn uit de actuele PR (door de caller, buiten dit bestand). De validator vertrouwt geen
 * enkel veld uit een receipt zelf als bewijs van identiteit of actualiteit: alles wordt tegen de
 * gemeten waarheid gelegd.
 *
 * Output is altijd een lijst redencodes (`REASON.*`), nooit de rauwe receiptinhoud — een redencode
 * kan veilig in een PR-check of issue-comment terechtkomen, receiptvelden (mogelijk namen, paden,
 * interne notities) niet.
 */

const SHA_RE = /^[0-9a-f]{40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RECEIPT_FIELDS = new Set([
  'schema', 'task_id', 'reviewer_actor', 'reviewer_vendor', 'receipt_uuid',
  'head_sha', 'tree_sha', 'verdict', 'checks_executed', 'builder_actor',
]);

const CHECK_ITEM_FIELDS = new Set(['name', 'rc', 'output_bytes']);

export const RECEIPT_SCHEMA = 'AUTOCODING_REVIEW_RECEIPT_V1';

export const REASON = Object.freeze({
  NO_RECEIPTS: 'NO_RECEIPTS',
  PARSE_ERROR: 'PARSE_ERROR',
  SCHEMA_MISMATCH: 'SCHEMA_MISMATCH',
  UNKNOWN_FIELD: 'UNKNOWN_FIELD',
  BAD_SHA_FORMAT: 'BAD_SHA_FORMAT',
  STALE_HEAD: 'STALE_HEAD',
  TREE_MISMATCH: 'TREE_MISMATCH',
  TASK_MISMATCH: 'TASK_MISMATCH',
  UNKNOWN_VENDOR: 'UNKNOWN_VENDOR',
  UNKNOWN_ACTOR: 'UNKNOWN_ACTOR',
  TRANSPORT_ACTOR_MISMATCH: 'TRANSPORT_ACTOR_MISMATCH',
  WILDCARD_IDENTITY: 'WILDCARD_IDENTITY',
  BUILDER_ACTOR_MISMATCH: 'BUILDER_ACTOR_MISMATCH',
  SELF_REVIEW: 'SELF_REVIEW',
  EMPTY_CHECKS: 'EMPTY_CHECKS',
  SKIPPED_OR_MISSING_CHECK: 'SKIPPED_OR_MISSING_CHECK',
  EMPTY_CHECK_OUTPUT: 'EMPTY_CHECK_OUTPUT',
  NO_GO_VERDICT_PRESENT: 'NO_GO_VERDICT_PRESENT',
  DUPLICATE_ACTOR: 'DUPLICATE_ACTOR',
  DUPLICATE_VENDOR: 'DUPLICATE_VENDOR',
  DUPLICATE_UUID: 'DUPLICATE_UUID',
  INSUFFICIENT_GO: 'INSUFFICIENT_GO',
  UNSAFE_POLICY: 'UNSAFE_POLICY',
});

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function checkItemValid(item) {
  if (isNonEmptyString(item)) return { ok: true };
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return { ok: false, reason: REASON.SCHEMA_MISMATCH };
  }
  for (const key of Object.keys(item)) {
    if (!CHECK_ITEM_FIELDS.has(key)) return { ok: false, reason: REASON.UNKNOWN_FIELD };
  }
  if (!isNonEmptyString(item.name)) return { ok: false, reason: REASON.SCHEMA_MISMATCH };
  // rc/output_bytes zijn optioneel op een bare-string item, maar zodra een item ze draagt gelden ze
  // als de claim "ik heb echt gedraaid en geslaagd" — en die claim wordt hier getoetst, niet geloofd.
  if ('rc' in item && item.rc !== 0) return { ok: false, reason: REASON.SKIPPED_OR_MISSING_CHECK };
  if ('output_bytes' in item && !(Number.isInteger(item.output_bytes) && item.output_bytes > 0)) {
    return { ok: false, reason: REASON.EMPTY_CHECK_OUTPUT };
  }
  return { ok: true };
}

/**
 * Evalueert één receipt tegen de gemeten waarheid (`context`) en het beleid (`policy`).
 * Retourneert altijd `{ valid, reasons, vendor, actor, uuid, verdict }` — de laatste vier velden
 * zijn alleen betrouwbaar als het basisschema klopte (anders `undefined`).
 */
export function evaluateReceipt(envelope, context, policy) {
  const reasons = [];
  const add = (r) => { if (!reasons.includes(r)) reasons.push(r); };

  // Een receipt is pas bewijs als GitHub zelf ook de auteur van het dragende comment/review levert.
  // Een kaal receipt-object zou anders zijn eigen reviewer_actor kunnen verzinnen.
  const receipt = envelope?.receipt;
  const transportActor = envelope?.transport_actor;

  if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) {
    return { valid: false, reasons: [REASON.PARSE_ERROR] };
  }

  for (const key of Object.keys(receipt)) {
    if (!RECEIPT_FIELDS.has(key)) add(REASON.UNKNOWN_FIELD);
  }
  if (receipt.schema !== RECEIPT_SCHEMA) add(REASON.SCHEMA_MISMATCH);
  for (const field of [
    'task_id', 'reviewer_actor', 'reviewer_vendor', 'receipt_uuid', 'head_sha', 'tree_sha', 'builder_actor',
  ]) {
    if (!isNonEmptyString(receipt[field])) add(REASON.SCHEMA_MISMATCH);
  }
  if (receipt.verdict !== 'GO' && receipt.verdict !== 'NO_GO') add(REASON.SCHEMA_MISMATCH);
  if (!Array.isArray(receipt.checks_executed)) add(REASON.SCHEMA_MISMATCH);

  // Basisvorm kapot → diepere velden zijn niet betrouwbaar genoeg om nog iets zinnigs over te zeggen.
  if (reasons.length > 0) return { valid: false, reasons };

  if (!UUID_RE.test(receipt.receipt_uuid)) add(REASON.SCHEMA_MISMATCH);
  if (!SHA_RE.test(receipt.head_sha)) add(REASON.BAD_SHA_FORMAT);
  if (!SHA_RE.test(receipt.tree_sha)) add(REASON.BAD_SHA_FORMAT);

  if (receipt.checks_executed.length === 0) {
    add(REASON.EMPTY_CHECKS);
  } else {
    for (const item of receipt.checks_executed) {
      const r = checkItemValid(item);
      if (!r.ok) add(r.reason);
    }
  }

  if (reasons.length > 0) return { valid: false, reasons };

  // Vanaf hier tegen de gemeten waarheid, nooit tegen wat het receipt zelf beweert te zijn.
  if (receipt.head_sha !== context.pr_head_sha) add(REASON.STALE_HEAD);
  if (receipt.tree_sha !== context.pr_tree_sha) add(REASON.TREE_MISMATCH);
  if (!isNonEmptyString(context.task_id) || receipt.task_id !== context.task_id) add(REASON.TASK_MISMATCH);
  if (receipt.builder_actor !== context.builder_actor) add(REASON.BUILDER_ACTOR_MISMATCH);
  if (receipt.reviewer_actor === receipt.builder_actor) add(REASON.SELF_REVIEW);
  if (!isNonEmptyString(transportActor) || transportActor !== receipt.reviewer_actor) {
    add(REASON.TRANSPORT_ACTOR_MISMATCH);
  }

  if (receipt.reviewer_actor === '*' || receipt.reviewer_vendor === '*') {
    add(REASON.WILDCARD_IDENTITY);
  } else if (!Object.prototype.hasOwnProperty.call(policy.allowed_reviewer_actors ?? {}, receipt.reviewer_vendor)) {
    add(REASON.UNKNOWN_VENDOR);
  } else if (!(policy.allowed_reviewer_actors[receipt.reviewer_vendor] ?? []).includes(receipt.reviewer_actor)) {
    add(REASON.UNKNOWN_ACTOR);
  }

  if (receipt.verdict === 'NO_GO') add(REASON.NO_GO_VERDICT_PRESENT);

  return {
    valid: reasons.length === 0,
    reasons,
    vendor: receipt.reviewer_vendor,
    actor: receipt.reviewer_actor,
    uuid: receipt.receipt_uuid,
    verdict: receipt.verdict,
  };
}

/**
 * Evalueert de volledige receiptset voor één PR-head. Twee-van-twee-leveranciers, geen NO_GO, geen
 * dubbele actor/vendor/uuid, geen zelfreview — anders rood. Geeft nooit "GO" terug op basis van een
 * lege of onvolledige set.
 */
export function evaluateReceipts(receipts, context, policy) {
  if (!Array.isArray(receipts) || receipts.length === 0) {
    return { decision: 'NO_GO', reasons: [REASON.NO_RECEIPTS] };
  }

  const reasons = new Set();

  // Dubbele actor/vendor/uuid is zelf al de aanval — dat geldt ook als de rest van zo'n receipt
  // verder correct is, dus dit wordt op de RUWE set getoetst, niet pas na validatie.
  const seenUuid = new Set();
  const seenActor = new Set();
  const seenVendor = new Set();
  let sawDupUuid = false;
  let sawDupActor = false;
  let sawDupVendor = false;
  for (const envelope of receipts) {
    const r = envelope?.receipt;
    if (!r || typeof r !== 'object') continue;
    if (isNonEmptyString(r.receipt_uuid)) {
      if (seenUuid.has(r.receipt_uuid)) sawDupUuid = true;
      seenUuid.add(r.receipt_uuid);
    }
    if (isNonEmptyString(r.reviewer_actor) && r.reviewer_actor !== '*') {
      if (seenActor.has(r.reviewer_actor)) sawDupActor = true;
      seenActor.add(r.reviewer_actor);
    }
    if (isNonEmptyString(r.reviewer_vendor) && r.reviewer_vendor !== '*') {
      if (seenVendor.has(r.reviewer_vendor)) sawDupVendor = true;
      seenVendor.add(r.reviewer_vendor);
    }
  }
  if (sawDupUuid) reasons.add(REASON.DUPLICATE_UUID);
  if (sawDupActor) reasons.add(REASON.DUPLICATE_ACTOR);
  if (sawDupVendor) reasons.add(REASON.DUPLICATE_VENDOR);

  const evaluated = receipts.map((r) => evaluateReceipt(r, context, policy));
  for (const e of evaluated) for (const r of e.reasons) reasons.add(r);

  const validGoVendors = new Set(
    evaluated.filter((e) => e.valid && e.verdict === 'GO').map((e) => e.vendor),
  );
  const required = policy.required_distinct_vendors ?? 2;
  if (validGoVendors.size < required) reasons.add(REASON.INSUFFICIENT_GO);

  return { decision: reasons.size === 0 ? 'GO' : 'NO_GO', reasons: Array.from(reasons) };
}

/**
 * Haalt een receipt uit een PR-comment/review-body. Alleen een letterlijk fenced blok met infostring
 * `autocoding-review-receipt-v1` telt — proza eromheen ("ik heb dit bekeken, GO!") wordt genegeerd.
 * Geeft `null` terug als er geen machineblok is, of als het geen geldige JSON bevat.
 */
export function extractReceiptFromCommentBody(body) {
  if (typeof body !== 'string') return null;
  const match = body.match(/```autocoding-review-receipt-v1\s*\n([\s\S]*?)```/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim());
  } catch {
    return null;
  }
}

/** Weigert een policy met een wildcard of lege identiteit in een allowlist — nooit fail-open. */
export function assertPolicyIsSafe(policy) {
  const map = policy?.allowed_reviewer_actors;
  if (!map || typeof map !== 'object') throw new Error(REASON.UNSAFE_POLICY);
  for (const [vendor, actors] of Object.entries(map)) {
    if (!isNonEmptyString(vendor) || vendor === '*') throw new Error(REASON.UNSAFE_POLICY);
    if (!Array.isArray(actors)) throw new Error(REASON.UNSAFE_POLICY);
    for (const actor of actors) {
      if (!isNonEmptyString(actor) || actor === '*') throw new Error(REASON.UNSAFE_POLICY);
    }
  }
}

async function runCli() {
  const { readFileSync } = await import('node:fs');
  const args = new Map();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) args.set(argv[i], argv[i + 1]);

  const receiptsPath = args.get('--receipts');
  const contextPath = args.get('--context');
  const policyPath = args.get('--policy');
  if (!receiptsPath || !contextPath || !policyPath) {
    console.error(JSON.stringify({ decision: 'NO_GO', reasons: [REASON.PARSE_ERROR] }));
    process.exitCode = 1;
    return;
  }

  let receipts;
  let context;
  let policy;
  try {
    receipts = JSON.parse(readFileSync(receiptsPath, 'utf8'));
    context = JSON.parse(readFileSync(contextPath, 'utf8'));
    policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    assertPolicyIsSafe(policy);
  } catch {
    console.log(JSON.stringify({ decision: 'NO_GO', reasons: [REASON.PARSE_ERROR] }));
    process.exitCode = 1;
    return;
  }

  const result = evaluateReceipts(receipts, context, policy);
  console.log(JSON.stringify(result));
  process.exitCode = result.decision === 'GO' ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runCli();
}
