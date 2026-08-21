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

import { pathToFileURL } from 'node:url';

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
  // Native reviewbewijs (chatgpt-codex-connector[bot] / gemini-code-assist[bot]) — geen zelfgeschreven
  // JSON-receipt, dus geen receipt_uuid/checks_executed. Deze redenen zijn eigen aan die route.
  NATIVE_IDENTITY_UNVERIFIED: 'NATIVE_IDENTITY_UNVERIFIED',
  NATIVE_TERMINAL_MARKER_MISSING: 'NATIVE_TERMINAL_MARKER_MISSING',
  NATIVE_FINDINGS_PRESENT: 'NATIVE_FINDINGS_PRESENT',
  NATIVE_STATE_NOT_ALLOWED: 'NATIVE_STATE_NOT_ALLOWED',
  OWNER_GATE_REQUIRED: 'OWNER_GATE_REQUIRED',
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
export function evaluateReceipt(envelope, rawContext, rawPolicy) {
  const context = rawContext ?? {};
  const policy = rawPolicy ?? {};
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
  } else if (!Array.isArray(policy.allowed_reviewer_actors[receipt.reviewer_vendor])
    || !policy.allowed_reviewer_actors[receipt.reviewer_vendor].includes(receipt.reviewer_actor)) {
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
export function evaluateReceipts(receipts, rawContext, rawPolicy) {
  const context = rawContext ?? {};
  const policy = rawPolicy ?? {};
  try {
    assertPolicyIsSafe(policy);
  } catch {
    return { decision: 'NO_GO', reasons: [REASON.UNSAFE_POLICY] };
  }
  if (!Array.isArray(receipts) || receipts.length === 0) {
    return { decision: 'NO_GO', reasons: [REASON.NO_RECEIPTS] };
  }

  const reasons = new Set();
  const actorMap = policy.allowed_reviewer_actors;
  const allowedTransportActors = new Set(
    Object.values(actorMap ?? {}).flatMap((actors) => Array.isArray(actors) ? actors : []),
  );

  // Selectievolgorde is securitykritisch: vertrouw eerst uitsluitend de door GitHub gemeten
  // transportactor. Een publieke commenter buiten de exacte allowlist is ruis en kan dus geen
  // foutreden of duplicaat injecteren. Daarna horen alleen receipts voor de actuele PR-head bij
  // deze beslissing; geldige historische reviews blijven auditdata, maar gelden nooit opnieuw.
  // Een kapot receipt van een toegestane transportactor blijft geselecteerd en faalt gesloten.
  const trusted = receipts.filter((envelope) => allowedTransportActors.has(envelope?.transport_actor));
  const selected = trusted.filter((envelope) => {
    const head = envelope?.receipt?.head_sha;
    return !(SHA_RE.test(head) && SHA_RE.test(context.pr_head_sha) && head !== context.pr_head_sha);
  });

  if (selected.length === 0) {
    reasons.add(REASON.NO_RECEIPTS);
    if (trusted.length > 0) reasons.add(REASON.STALE_HEAD);
    return { decision: 'NO_GO', reasons: Array.from(reasons) };
  }

  // Duplicaten worden alleen binnen de trusted, actuele selectie gemeten. Daardoor blijven echte
  // conflicten fail-closed zonder dat een onbekende commenter een geldige set kan blokkeren.
  const seenUuid = new Set();
  const seenActor = new Set();
  const seenVendor = new Set();
  let sawDupUuid = false;
  let sawDupActor = false;
  let sawDupVendor = false;
  for (const envelope of selected) {
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

  const evaluated = selected.map((r) => evaluateReceipt(r, context, policy));
  for (const e of evaluated) for (const r of e.reasons) reasons.add(r);

  const validGoVendors = new Set(
    evaluated.filter((e) => e.valid && e.verdict === 'GO').map((e) => e.vendor),
  );
  const required = policy?.required_distinct_vendors ?? 2;
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
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error(REASON.UNSAFE_POLICY);
  for (const [vendor, actors] of Object.entries(map)) {
    if (!isNonEmptyString(vendor) || vendor === '*') throw new Error(REASON.UNSAFE_POLICY);
    if (!Array.isArray(actors)) throw new Error(REASON.UNSAFE_POLICY);
    for (const actor of actors) {
      if (!isNonEmptyString(actor) || actor === '*') throw new Error(REASON.UNSAFE_POLICY);
    }
  }
}

// --- Native reviewbewijs -------------------------------------------------------------------------
//
// De twee vendors kunnen geen `autocoding-review-receipt-v1`-blok schrijven — ze kennen dat schema
// niet. Bewijs is daarom hun eigen, ongewijzigde GitHub-uitvoer: een issue-comment (Codex) of een
// pull-request-review (Gemini). Geen van beide draagt een task_id, tree_sha of receipt_uuid; die
// concepten bestaan hier niet. Wat wél mechanisch te meten is — GitHub-gerapporteerde transportactor,
// het commit-object waarnaar het bewijs verwijst (door de caller al opgezocht via de GitHub-API, nooit
// uit tekst geloofd), en of de PR zelf een task_id draagt — wordt daarom door ÉÉN vendor-onafhankelijke
// functie getoetst: `bindNativeEvidence`. Alleen de vendor-eigen extractievorm (het exacte succesbericht
// van Codex, de statustekst en bevindingsbadges van Gemini) leeft in de twee `extract*`-functies
// eronder. Een aanvaller kan `user.login` en `performed_via_github_app` niet zelf zetten — dat zijn
// GitHub-velden, geen tekst uit het comment/review-lichaam — dus is er geen zelfclaim meer te
// wantrouwen zoals bij het generieke receipt-schema hierboven.

const CODEX_COMMIT_RE = /\*\*Reviewed commit:\*\*\s*`([0-9a-f]{7,40})`/;

/**
 * Leest de door Codex genoemde (meestal afgekorte) commit-referentie uit een commentlichaam.
 * Dit is een tekstclaim, geen bewijs: de caller moet hem mechanisch tegen de werkelijke PR-commits
 * resolveren. Geeft `null` als de comment geen zo'n regel draagt.
 */
export function codexReviewedCommitRef(body) {
  if (typeof body !== 'string') return null;
  return body.match(CODEX_COMMIT_RE)?.[1] ?? null;
}

/**
 * Zet één ruwe `chatgpt-codex-connector[bot]`-issuecomment om naar genormaliseerd native bewijs.
 * `resolved` is het resultaat van het door de caller (workflow) mechanisch opgezocht commit-object
 * voor de in de comment genoemde korte SHA — deze functie vertrouwt geen zelfgerapporteerde SHA.
 * Geeft `null` als het comment niet van de gepinde vendoractor komt (geen bewijs, geen ruis).
 */
export function extractCodexNativeEvidence(comment, resolved, policy) {
  const cfg = policy?.native_review?.codex;
  if (!cfg || !isNonEmptyString(cfg.actor)) return null;
  const login = comment?.user?.login;
  if (login !== cfg.actor) return null;
  const body = comment?.body;
  const identity_verified = comment?.performed_via_github_app?.id === cfg.app_id;
  const extra_reasons = [];
  let verdict = 'NO_GO';
  if (typeof body === 'string' && isNonEmptyString(cfg.success_marker) && body.startsWith(cfg.success_marker)) {
    if (codexReviewedCommitRef(body)) verdict = 'GO';
  }
  if (verdict !== 'GO') extra_reasons.push(REASON.NO_GO_VERDICT_PRESENT);
  return {
    vendor: 'codex',
    claimed_actor: login,
    transport_actor: login,
    identity_verified,
    verdict,
    extra_reasons,
    resolved_head_sha: resolved?.head_sha ?? '',
    resolved_tree_sha: resolved?.tree_sha ?? '',
  };
}

/**
 * Zet één ruwe `gemini-code-assist[bot]`-pull-request-review om naar genormaliseerd native bewijs.
 * `inlineComments` zijn de review-comments die bij DEZE review horen (door de caller al op
 * `pull_request_review_id` gegroepeerd) — hun aantal komt van GitHub, niet uit een zelfgerapporteerd
 * veld in het reviewlichaam. `resolved` is het door de caller opgezochte commit-object voor
 * `review.commit_id`.
 */
export function extractGeminiNativeEvidence(review, inlineComments, resolved, policy) {
  const cfg = policy?.native_review?.gemini;
  if (!cfg || !isNonEmptyString(cfg.actor)) return null;
  const login = review?.user?.login;
  if (login !== cfg.actor) return null;
  const identity_verified = review?.user?.type === 'Bot';
  const body = review?.body;
  const extra_reasons = [];
  const stateAllowed = Array.isArray(cfg.allowed_states) && cfg.allowed_states.includes(review?.state);
  if (!stateAllowed) extra_reasons.push(REASON.NATIVE_STATE_NOT_ALLOWED);
  const hasTerminalMarker = typeof body === 'string' && isNonEmptyString(cfg.terminal_marker)
    && body.startsWith(cfg.terminal_marker);
  if (!hasTerminalMarker) extra_reasons.push(REASON.NATIVE_TERMINAL_MARKER_MISSING);
  // Gemini's ernstvocabulaire is hier niet volledig gemeten, dus wordt het niet geïnterpreteerd:
  // elke inline reviewcomment telt als bevinding, ongeacht badge of tekst. "Schoon" is uitsluitend
  // nul reviewcomments op deze review — dat is de fail-closed lezing.
  const comments = Array.isArray(inlineComments) ? inlineComments : [];
  if (comments.length > 0) extra_reasons.push(REASON.NATIVE_FINDINGS_PRESENT);
  const verdict = extra_reasons.length === 0 ? 'GO' : 'NO_GO';
  return {
    vendor: 'gemini',
    claimed_actor: login,
    transport_actor: login,
    identity_verified,
    verdict,
    extra_reasons,
    resolved_head_sha: resolved?.head_sha ?? '',
    resolved_tree_sha: resolved?.tree_sha ?? '',
  };
}

/**
 * De ene provider-onafhankelijke adapter: bindt genormaliseerd native bewijs (van welke extractor dan
 * ook) aan de gemeten waarheid. Kent geen vendorkennis meer — alleen transportactor-gelijkheid,
 * actuele head/tree, een gedeclareerd task_id op de PR, zelfreview en het al-berekende verdict.
 */
export function bindNativeEvidence(evidence, rawContext) {
  const e = evidence ?? {};
  const ctx = rawContext ?? {};
  const reasons = [];
  const add = (r) => { if (!reasons.includes(r)) reasons.push(r); };

  if (!isNonEmptyString(e.transport_actor) || e.transport_actor !== e.claimed_actor) {
    add(REASON.TRANSPORT_ACTOR_MISMATCH);
  }
  if (!e.identity_verified) add(REASON.NATIVE_IDENTITY_UNVERIFIED);
  if (!isNonEmptyString(ctx.task_id)) add(REASON.TASK_MISMATCH);
  if (!SHA_RE.test(e.resolved_head_sha) || e.resolved_head_sha !== ctx.pr_head_sha) add(REASON.STALE_HEAD);
  if (!SHA_RE.test(e.resolved_tree_sha) || e.resolved_tree_sha !== ctx.pr_tree_sha) add(REASON.TREE_MISMATCH);
  if (isNonEmptyString(e.claimed_actor) && e.claimed_actor === ctx.builder_actor) add(REASON.SELF_REVIEW);
  if (e.verdict !== 'GO') {
    const extra = Array.isArray(e.extra_reasons) ? e.extra_reasons : [];
    if (extra.length === 0) add(REASON.NO_GO_VERDICT_PRESENT);
    else for (const r of extra) add(r);
  }

  return { valid: reasons.length === 0, reasons, vendor: e.vendor, actor: e.claimed_actor };
}

/**
 * Weigert een policy waarvan de gepinde native-vendoractor wildcard of leeg is — nooit fail-open.
 * Weigert bovendien elke policy waarin de ownergate en de reviewvendors elkaar kunnen vervangen:
 * een owner-vendornaam of owner-actor die ook als vereiste reviewvendor of vendoractor voorkomt,
 * zou één identiteit twee onafhankelijke poorten laten passeren.
 */
export function assertNativeVendorsSafe(policy) {
  const nr = policy?.native_review;
  if (!nr || typeof nr !== 'object' || Array.isArray(nr)) throw new Error(REASON.UNSAFE_POLICY);
  if (!Array.isArray(nr.required_vendors) || nr.required_vendors.length === 0) {
    throw new Error(REASON.UNSAFE_POLICY);
  }

  const ownerMap = policy?.owner_gate?.allowed_reviewer_actors;
  const ownerVendors = new Set(ownerMap && typeof ownerMap === 'object' && !Array.isArray(ownerMap)
    ? Object.keys(ownerMap) : []);
  const ownerActors = new Set(Object.values(ownerMap ?? {})
    .flatMap((actors) => Array.isArray(actors) ? actors : []));

  const seenVendors = new Set();
  for (const vendor of nr.required_vendors) {
    if (!isNonEmptyString(vendor) || vendor === '*') throw new Error(REASON.UNSAFE_POLICY);
    if (seenVendors.has(vendor)) throw new Error(REASON.UNSAFE_POLICY);
    seenVendors.add(vendor);
    if (ownerVendors.has(vendor)) throw new Error(REASON.UNSAFE_POLICY);
    const cfg = nr[vendor];
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(REASON.UNSAFE_POLICY);
    if (!isNonEmptyString(cfg.actor) || cfg.actor === '*') throw new Error(REASON.UNSAFE_POLICY);
    if (ownerActors.has(cfg.actor)) throw new Error(REASON.UNSAFE_POLICY);
  }
}

/**
 * Evalueert de volledige set native bewijsstukken voor één PR-head. Elk vereist vendor uit
 * `policy.native_review.required_vendors` moet minstens één geldig GO-bewijs leveren; anders NO_GO.
 *
 * De selectievolgorde spiegelt `evaluateReceipts`: bewijs dat mechanisch naar een ANDERE bekende head
 * resolveert is een afgeronde reviewronde van een vorige push — auditdata, nooit opnieuw geldig, en
 * evenmin een blokkade voor de actuele head. Bewijs dat helemaal niet resolveert blijft wél staan en
 * faalt gesloten: een gepinde bot die naar een onbekende commit wijst is een anomalie, geen ruis.
 */
export function evaluateNativeReview(evidenceItems, rawContext, rawPolicy) {
  const context = rawContext ?? {};
  const policy = rawPolicy ?? {};
  try {
    assertNativeVendorsSafe(policy);
  } catch {
    return { decision: 'NO_GO', reasons: [REASON.UNSAFE_POLICY] };
  }
  const items = (Array.isArray(evidenceItems) ? evidenceItems : []).filter((e) => e != null);
  const selected = items.filter((e) => !(
    SHA_RE.test(e?.resolved_head_sha) && SHA_RE.test(context.pr_head_sha)
    && e.resolved_head_sha !== context.pr_head_sha
  ));

  const reasons = new Set();
  const validGoVendors = new Set();
  for (const item of selected) {
    const bound = bindNativeEvidence(item, context);
    for (const r of bound.reasons) reasons.add(r);
    if (bound.valid) validGoVendors.add(bound.vendor);
  }
  if (selected.length === 0) {
    reasons.add(REASON.NO_RECEIPTS);
    if (items.length > 0) reasons.add(REASON.STALE_HEAD);
  }
  for (const vendor of policy.native_review.required_vendors) {
    if (!validGoVendors.has(vendor)) reasons.add(REASON.INSUFFICIENT_GO);
  }
  return { decision: reasons.size === 0 ? 'GO' : 'NO_GO', reasons: Array.from(reasons) };
}

/**
 * De volledige Shield-uitspraak: native tweevendorbewijs, plus — alléén als de diff gevoelige paden
 * raakt (`.github/workflows/**`, `CONTROL/AUTOCODING/**`) — een apart OWNER_GATE-receipt (hergebruikt
 * het generieke receiptschema hierboven, met `policy.owner_gate` als zijn eigen kleine policy). De
 * owneractor telt nooit mee als een van de twee vereiste vendors — dat receipt heeft vendor `"owner"`,
 * nooit `"codex"`/`"gemini"`, dus `evaluateNativeReview` en dit receipt kunnen elkaar niet vervangen.
 */
export function evaluateShield({ nativeEvidence, ownerReceipts, sensitivePathsTouched, context, policy }) {
  const nativeResult = evaluateNativeReview(nativeEvidence, context, policy);
  const reasons = new Set(nativeResult.reasons);
  if (sensitivePathsTouched) {
    const ownerResult = evaluateReceipts(ownerReceipts, context, policy?.owner_gate);
    if (ownerResult.decision !== 'GO') {
      reasons.add(REASON.OWNER_GATE_REQUIRED);
      for (const r of ownerResult.reasons) reasons.add(r);
    }
  }
  return { decision: reasons.size === 0 ? 'GO' : 'NO_GO', reasons: Array.from(reasons) };
}

async function runCli() {
  const { readFileSync } = await import('node:fs');
  const args = new Map();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) args.set(argv[i], argv[i + 1]);

  const contextPath = args.get('--context');
  const policyPath = args.get('--policy');
  const receiptsPath = args.get('--receipts');
  const shieldInputPath = args.get('--shield-input');

  if (!contextPath || !policyPath || !(receiptsPath || shieldInputPath)) {
    console.log(JSON.stringify({ decision: 'NO_GO', reasons: [REASON.PARSE_ERROR] }));
    process.exitCode = 1;
    return;
  }

  let context;
  let policy;
  let receipts;
  let shieldInput;
  try {
    context = JSON.parse(readFileSync(contextPath, 'utf8'));
    policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    if (shieldInputPath) shieldInput = JSON.parse(readFileSync(shieldInputPath, 'utf8'));
    else receipts = JSON.parse(readFileSync(receiptsPath, 'utf8'));
  } catch {
    console.log(JSON.stringify({ decision: 'NO_GO', reasons: [REASON.PARSE_ERROR] }));
    process.exitCode = 1;
    return;
  }

  // De shield-route (native reviewbewijs + optioneel ownergate) heeft zijn eigen policyveiligheid
  // (`assertNativeVendorsSafe`); de oudere generieke-receiptroute blijft op `assertPolicyIsSafe` staan.
  // Beide falen gesloten op UNSAFE_POLICY, nooit fail-open.
  let result;
  if (shieldInputPath) {
    try {
      assertNativeVendorsSafe(policy);
    } catch {
      console.log(JSON.stringify({ decision: 'NO_GO', reasons: [REASON.UNSAFE_POLICY] }));
      process.exitCode = 1;
      return;
    }
    result = evaluateShield({
      nativeEvidence: shieldInput?.nativeEvidence,
      ownerReceipts: shieldInput?.ownerReceipts,
      sensitivePathsTouched: Boolean(shieldInput?.sensitivePathsTouched),
      context,
      policy,
    });
  } else {
    try {
      assertPolicyIsSafe(policy);
    } catch {
      console.log(JSON.stringify({ decision: 'NO_GO', reasons: [REASON.UNSAFE_POLICY] }));
      process.exitCode = 1;
      return;
    }
    result = evaluateReceipts(receipts, context, policy);
  }
  console.log(JSON.stringify(result));
  process.exitCode = result.decision === 'GO' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
