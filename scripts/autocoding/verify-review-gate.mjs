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
  // Zicht op de diff zelf. `/pulls/{n}/files` levert maximaal 3000 bestanden; een onvolledige oogst
  // is geen schone PR maar een blinde vlek, en krijgt daarom een eigen vaste categorie.
  FILES_INCOMPLETE: 'FILES_INCOMPLETE',
  // Owner-autorisatie (AUTOCODING_OWNER_APPROVAL_V1) — een eigen poort, geen reviewvendor. Deze
  // codes zijn bewust apart van de reviewredenen: een ownerprobleem mag nooit als vendorprobleem
  // gelezen worden, en andersom evenmin.
  OWNER_GATE_REQUIRED: 'OWNER_GATE_REQUIRED',
  OWNER_APPROVAL_MISSING: 'OWNER_APPROVAL_MISSING',
  OWNER_APPROVAL_SCHEMA_MISMATCH: 'OWNER_APPROVAL_SCHEMA_MISMATCH',
  OWNER_APPROVAL_UNKNOWN_FIELD: 'OWNER_APPROVAL_UNKNOWN_FIELD',
  OWNER_APPROVAL_ACTOR_NOT_ALLOWED: 'OWNER_APPROVAL_ACTOR_NOT_ALLOWED',
  OWNER_APPROVAL_CARRIER_NOT_ACTIVE: 'OWNER_APPROVAL_CARRIER_NOT_ACTIVE',
  OWNER_APPROVAL_STALE_HEAD: 'OWNER_APPROVAL_STALE_HEAD',
  OWNER_APPROVAL_TREE_MISMATCH: 'OWNER_APPROVAL_TREE_MISMATCH',
  OWNER_APPROVAL_TASK_MISMATCH: 'OWNER_APPROVAL_TASK_MISMATCH',
  OWNER_APPROVAL_NOT_APPROVE: 'OWNER_APPROVAL_NOT_APPROVE',
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

function positiveInteger(v) {
  return Number.isInteger(v) && v > 0;
}

/**
 * Toetst de identiteit van de drager (issuecomment of review) tegen de GEPINDE vendoridentiteit.
 * Alle drie de velden komen van GitHub, niet uit het lichaam: `user.login`, de numerieke `user.id`
 * en `user.type`. De numerieke ID is de sterkste van de drie — een login is hernoembaar, een
 * user-ID niet.
 *
 * `performed_via_github_app` bestaat alleen op issuecomments; reviews dragen dat veld niet (gemeten
 * op PR #74, review 4998216880). Op de commentroute is het daarom VERPLICHT en moet het exact de
 * gepinde app-ID zijn; op de reviewroute mag het ontbreken, maar áls het er staat moet het kloppen.
 */
function nativeIdentityVerified(carrier, cfg, { requireApp }) {
  const user = carrier?.user;
  if (user?.login !== cfg.actor) return false;
  if (!positiveInteger(cfg.user_id) || user?.id !== cfg.user_id) return false;
  if (!isNonEmptyString(cfg.user_type) || user?.type !== cfg.user_type) return false;
  const app = carrier?.performed_via_github_app;
  if (requireApp) return positiveInteger(cfg.app_id) && app?.id === cfg.app_id;
  if (app === undefined || app === null) return true;
  return positiveInteger(cfg.app_id) && app?.id === cfg.app_id;
}

/**
 * De reviewstates waarin een pull-request-review ACTIEF bewijs is. Gesloten en niet door beleid te
 * verruimen: `DISMISSED` (ingetrokken), `PENDING` (nog niet ingediend) en `CHANGES_REQUESTED` (geen
 * afgeronde ronde) kunnen hier per definitie niet in vallen, hoe de policy ook wordt bewerkt.
 *
 * Waarom intrekken bewijs moet WEGHALEN in plaats van rood te maken: wie een review dismisst, laat
 * het lichaam én de inline bevindingen letterlijk staan; GitHub verandert alleen `state`. Zolang zo'n
 * review als NO_GO-bewijs bleef meetellen, bleef zijn reden (`NATIVE_FINDINGS_PRESENT`) in de
 * actuele bewijsset hangen — en kon geen enkele nieuwe, schone review de PR ooit nog groen krijgen.
 * Ingetrokken bewijs verdwijnt daarom volledig uit de selectie. Dat kan nooit een `GO` opleveren: een
 * vendor zonder actief bewijs mist gewoon zijn vereiste `GO` en levert `INSUFFICIENT_GO`.
 */
export const NATIVE_REVIEW_ACTIVE_STATES = Object.freeze(['COMMENTED', 'APPROVED']);

/**
 * Toetst of een pull-request-review in een actieve, door de vendorpolicy toegestane state staat.
 * Ontbrekende, lege, onbekende of niet-allowlisted states leveren `false` — fail-closed, nooit
 * "waarschijnlijk nog geldig". Geldt uitsluitend voor de REVIEW-route; de Codex-issuecommentroute
 * draagt geen state en wordt hier niet langs geleid.
 */
export function nativeReviewStateIsActive(review, cfg) {
  const allowed = cfg?.allowed_states;
  if (!Array.isArray(allowed) || allowed.length === 0) return false;
  const state = review?.state;
  return isNonEmptyString(state)
    && allowed.includes(state)
    && NATIVE_REVIEW_ACTIVE_STATES.includes(state);
}

/**
 * Toetst of een lichaam met een van de gepinde canonieke terminale succesvormen begint. De lijst is
 * een gesloten allowlist van letterlijke prefixen uit de policy; een lege of ontbrekende lijst
 * betekent "geen enkele vorm is succes", nooit "alles is succes". Voorafgaande witruimte wordt
 * genegeerd (GitHub levert reviewlichamen soms met een leidende newline); dat kan een
 * bevindingenlichaam nooit op een succesmarker laten lijken.
 */
function matchesTerminalSuccessMarker(body, markers) {
  if (typeof body !== 'string') return false;
  if (!Array.isArray(markers) || markers.length === 0) return false;
  const trimmed = body.trimStart();
  return markers.some((marker) => isNonEmptyString(marker) && trimmed.startsWith(marker));
}

/**
 * De gedeelde kern voor Codex-bewijs, ongeacht of het via een issuecomment of via een
 * pull-request-review binnenkwam. GO vereist alle drie: gepinde identiteit (door `bindNativeEvidence`
 * getoetst), een canonieke terminale succesvorm, en NUL inline bevindingen. Afwezigheid van
 * bevindingen is uitdrukkelijk géén GO op zichzelf — Codex plaatst bij een schone review helemaal
 * geen review, dus "geen bevindingen" is even goed verenigbaar met "nooit gedraaid".
 */
function codexEvidence(carrier, inlineComments, resolved, policy, requireApp) {
  const cfg = policy?.native_review?.codex;
  if (!cfg || !isNonEmptyString(cfg.actor)) return null;
  const login = carrier?.user?.login;
  if (login !== cfg.actor) return null;

  const extra_reasons = [];
  if (!matchesTerminalSuccessMarker(carrier?.body, cfg.terminal_success_markers)) {
    extra_reasons.push(REASON.NATIVE_TERMINAL_MARKER_MISSING);
  }
  const comments = Array.isArray(inlineComments) ? inlineComments : [];
  if (comments.length > 0) extra_reasons.push(REASON.NATIVE_FINDINGS_PRESENT);

  return {
    vendor: 'codex',
    claimed_actor: login,
    transport_actor: login,
    identity_verified: nativeIdentityVerified(carrier, cfg, { requireApp }),
    verdict: extra_reasons.length === 0 ? 'GO' : 'NO_GO',
    extra_reasons,
    resolved_head_sha: resolved?.head_sha ?? '',
    resolved_tree_sha: resolved?.tree_sha ?? '',
  };
}

/**
 * Zet één ruwe `chatgpt-codex-connector[bot]`-ISSUECOMMENT om naar genormaliseerd native bewijs.
 * `resolved` is het door de caller mechanisch opgezochte commit-object voor de in de comment
 * genoemde korte SHA — deze functie vertrouwt geen zelfgerapporteerde SHA. Geeft `null` als het
 * comment niet van de gepinde vendoractor komt (geen bewijs, geen ruis).
 */
export function extractCodexNativeEvidence(comment, resolved, policy) {
  return codexEvidence(comment, [], resolved, policy, true);
}

/**
 * Zet één ruwe `chatgpt-codex-connector[bot]`-PULL-REQUEST-REVIEW om naar genormaliseerd native
 * bewijs. Codex levert bevindingen als review met inline comments (gemeten op PR #74, review
 * 4998216880) — die vorm moet dus ondersteund worden, fail-closed: elke inline bevinding maakt deze
 * vendorronde NO_GO, en proza zonder canonieke succesvorm is nooit GO.
 */
export function extractCodexReviewEvidence(review, inlineComments, resolved, policy) {
  const cfg = policy?.native_review?.codex;
  // Een ingetrokken (`DISMISSED`), nog niet ingediende (`PENDING`) of anderszins niet-actieve review
  // is GEEN bewijsstuk — ook geen negatief. Zie `NATIVE_REVIEW_ACTIVE_STATES`.
  if (!nativeReviewStateIsActive(review, cfg)) return null;
  return codexEvidence(review, inlineComments, resolved, policy, false);
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
  // Zelfde regel als op de Codex-reviewroute: ingetrokken of niet-actief reviewbewijs verdwijnt uit
  // de selectie in plaats van er als permanente NO_GO-reden in te blijven hangen.
  if (!nativeReviewStateIsActive(review, cfg)) return null;
  const extra_reasons = [];
  if (!matchesTerminalSuccessMarker(review?.body, cfg.terminal_success_markers)) {
    extra_reasons.push(REASON.NATIVE_TERMINAL_MARKER_MISSING);
  }
  // Gemini's ernstvocabulaire is hier niet volledig gemeten, dus wordt het niet geïnterpreteerd:
  // elke inline reviewcomment telt als bevinding, ongeacht badge of tekst. "Schoon" is uitsluitend
  // nul reviewcomments op deze review — dat is de fail-closed lezing.
  const comments = Array.isArray(inlineComments) ? inlineComments : [];
  if (comments.length > 0) extra_reasons.push(REASON.NATIVE_FINDINGS_PRESENT);
  return {
    vendor: 'gemini',
    claimed_actor: login,
    transport_actor: login,
    identity_verified: nativeIdentityVerified(review, cfg, { requireApp: false }),
    verdict: extra_reasons.length === 0 ? 'GO' : 'NO_GO',
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
 * Weigert een policy waarvan de gepinde native-vendoridentiteit onvolledig, wildcard of leeg is —
 * nooit fail-open. Elke vendor moet een letterlijke actor, een positief-gehele numerieke user-ID,
 * een user-type en minstens één letterlijke terminale succesmarker dragen; de commentroute vereist
 * bovendien een positief-gehele app-ID.
 *
 * Weigert bovendien elke policy waarin de ownergate en de reviewvendors elkaar kunnen vervangen:
 * een owneractor die ook als vendoractor voorkomt zou één identiteit twee onafhankelijke poorten
 * laten passeren.
 */
export function assertNativeVendorsSafe(policy) {
  const nr = policy?.native_review;
  if (!nr || typeof nr !== 'object' || Array.isArray(nr)) throw new Error(REASON.UNSAFE_POLICY);
  if (!Array.isArray(nr.required_vendors) || nr.required_vendors.length === 0) {
    throw new Error(REASON.UNSAFE_POLICY);
  }

  const ownerActors = new Set(ownerActorList(policy?.owner_gate));

  const seenVendors = new Set();
  for (const vendor of nr.required_vendors) {
    if (!isNonEmptyString(vendor) || vendor === '*') throw new Error(REASON.UNSAFE_POLICY);
    if (seenVendors.has(vendor)) throw new Error(REASON.UNSAFE_POLICY);
    seenVendors.add(vendor);
    const cfg = nr[vendor];
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(REASON.UNSAFE_POLICY);
    if (!isNonEmptyString(cfg.actor) || cfg.actor === '*') throw new Error(REASON.UNSAFE_POLICY);
    if (ownerActors.has(cfg.actor)) throw new Error(REASON.UNSAFE_POLICY);
    if (!positiveInteger(cfg.user_id)) throw new Error(REASON.UNSAFE_POLICY);
    if (!isNonEmptyString(cfg.user_type) || cfg.user_type === '*') throw new Error(REASON.UNSAFE_POLICY);
    if ('app_id' in cfg && !positiveInteger(cfg.app_id)) throw new Error(REASON.UNSAFE_POLICY);
    // De reviewroute bestaat voor BEIDE vendors, dus beide moeten een begrensde actieve-statelijst
    // declareren. Een policy die `DISMISSED`, `PENDING` of `CHANGES_REQUESTED` probeert toe te laten
    // is onveilig, niet "ruimer afgesteld".
    if (!Array.isArray(cfg.allowed_states) || cfg.allowed_states.length === 0) {
      throw new Error(REASON.UNSAFE_POLICY);
    }
    for (const state of cfg.allowed_states) {
      if (!NATIVE_REVIEW_ACTIVE_STATES.includes(state)) throw new Error(REASON.UNSAFE_POLICY);
    }
    if (!Array.isArray(cfg.terminal_success_markers) || cfg.terminal_success_markers.length === 0) {
      throw new Error(REASON.UNSAFE_POLICY);
    }
    for (const marker of cfg.terminal_success_markers) {
      if (!isNonEmptyString(marker) || marker === '*') throw new Error(REASON.UNSAFE_POLICY);
    }
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

// --- Owner-autorisatie (AUTOCODING_OWNER_APPROVAL_V1) ---------------------------------------------
//
// Owner-autorisatie is GEEN review. De eigenaar is geen Codex/Gemini-vendor, kan een ontbrekende
// vendor nooit vervangen, en mag daarom ook niet door reviewerlogica lopen. Dat is niet alleen
// principieel: de gemeten PR-auteur en de toegestane owner zijn op deze repository dezelfde
// GitHub-identiteit (`rvanhooijdonk-png`), dus de reviewer-zelfreviewregel maakte ownergoedkeuring
// structureel onmogelijk. Het schema hieronder is daarom klein, exact en zonder builder-velden:
// alleen "deze eigenaar autoriseert exact deze task op exact deze head/tree".

export const OWNER_APPROVAL_SCHEMA = 'AUTOCODING_OWNER_APPROVAL_V1';

const OWNER_APPROVAL_FIELDS = new Set(['schema', 'task_id', 'head_sha', 'tree_sha', 'decision']);

/**
 * Haalt een owner-autorisatie uit een comment-/reviewlichaam. Alleen een letterlijk fenced blok met
 * infostring `autocoding-owner-approval-v1` telt; proza ("wat mij betreft akkoord") nooit.
 */
export function extractOwnerApprovalFromBody(body) {
  if (typeof body !== 'string') return null;
  const match = body.match(/```autocoding-owner-approval-v1\s*\n([\s\S]*?)```/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim());
  } catch {
    return null;
  }
}

function ownerActorList(gate) {
  const actors = gate?.allowed_owner_actors;
  return Array.isArray(actors) ? actors.filter((a) => isNonEmptyString(a)) : [];
}

/** Gesloten sleutelverzameling van de ownergate: een onbekende (of oude) sleutel is UNSAFE_POLICY. */
const OWNER_GATE_FIELDS = new Set([
  'schema', 'sensitive_path_prefixes', 'allowed_owner_actors', 'allowed_review_states',
]);

/**
 * De enige reviewstates die de eigenaar zelf actief kan produceren en die een dismissal NIET
 * overleven. GitHub zet een ingetrokken review op `DISMISSED`; die staat kan hier dus nooit binnen
 * de allowlist vallen, hoe de policy ook wordt bewerkt. `PENDING` is een nog niet ingediende
 * review, `CHANGES_REQUESTED` is geen autorisatie.
 */
const OWNER_REVIEW_ACTIVE_STATES = Object.freeze(['COMMENTED', 'APPROVED']);

/** Glob-meta, backslash en controltekens. Een prefix is een letterlijk pad, geen patroon. */
const UNSAFE_PREFIX_RE = /[*?[\]{}!\\\u0000-\u001f]/;

/**
 * De matching op gevoelige paden is bewust LETTERLIJKE prefixvergelijking (`String.startsWith`), geen
 * glob-expansie. Deze functie bewaakt dat contract aan de invoerkant: alles wat eruitziet als een
 * patroon, als een absoluut pad of als een traversal wordt geweigerd, zodat een prefix nooit
 * geruisloos "niet matcht" terwijl de policy suggereert dat hij een hele boom afdekt.
 *
 * Toegestaan is uitsluitend een relatief repo-pad van niet-lege segmenten, eventueel met één
 * afsluitende `/` (`CONTROL/AUTOCODING/`). Geweigerd worden: leeg, `*`, glob-meta, backslash,
 * controltekens, een leidende `/`, `.`/`..`-segmenten en dubbele slashes.
 */
export function isSafeSensitivePrefix(value) {
  if (!isNonEmptyString(value)) return false;
  if (UNSAFE_PREFIX_RE.test(value)) return false;
  if (value.startsWith('/')) return false;
  const segments = value.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment === '.' || segment === '..') return false;
    // Een lege segmentwaarde mag alleen de afsluitende slash zijn, nooit `//` of een leidende slash.
    if (segment === '' && i !== segments.length - 1) return false;
  }
  return true;
}

/**
 * Weigert een ownergate die niet exact is. Wordt ALTIJD bij het laden gedraaid, ook wanneer de diff
 * geen gevoelig pad raakt: een kapotte ownergate mag niet pas zichtbaar worden op het moment dat hij
 * nodig is.
 *
 * De sleutelverzameling is gesloten. De oude naam `sensitive_path_globs` beloofde glob-semantiek die
 * de implementatie nooit had; een policy die hem nog draagt is daarom niet "compatibel" maar
 * UNSAFE_POLICY — nooit ownergate-vrij.
 */
export function assertOwnerGateSafe(policy) {
  const gate = policy?.owner_gate;
  if (!gate || typeof gate !== 'object' || Array.isArray(gate)) throw new Error(REASON.UNSAFE_POLICY);
  for (const key of Object.keys(gate)) {
    if (!OWNER_GATE_FIELDS.has(key)) throw new Error(REASON.UNSAFE_POLICY);
  }
  if (gate.schema !== OWNER_APPROVAL_SCHEMA) throw new Error(REASON.UNSAFE_POLICY);

  const prefixes = gate.sensitive_path_prefixes;
  if (!Array.isArray(prefixes) || prefixes.length === 0) throw new Error(REASON.UNSAFE_POLICY);
  for (const prefix of prefixes) {
    if (!isSafeSensitivePrefix(prefix)) throw new Error(REASON.UNSAFE_POLICY);
  }

  const states = gate.allowed_review_states;
  if (!Array.isArray(states) || states.length === 0) throw new Error(REASON.UNSAFE_POLICY);
  for (const state of states) {
    if (!OWNER_REVIEW_ACTIVE_STATES.includes(state)) throw new Error(REASON.UNSAFE_POLICY);
  }

  const actors = gate.allowed_owner_actors;
  if (!Array.isArray(actors) || actors.length === 0) throw new Error(REASON.UNSAFE_POLICY);
  for (const actor of actors) {
    if (!isNonEmptyString(actor) || actor === '*') throw new Error(REASON.UNSAFE_POLICY);
  }
}

/**
 * Toetst de DRAGER van een owner-autorisatie, los van de inhoud van het blok.
 *
 * Een pull-request-review draagt een `state` die na het schrijven nog kan veranderen: wie een review
 * intrekt, laat het lichaam — en dus het autorisatieblok — ongewijzigd staan terwijl GitHub de state
 * op `DISMISSED` zet. Zonder statefilter bleef die ingetrokken autorisatie de gevoelige-padpoort
 * groen houden. Alleen een expliciet allowlisted ACTIEVE state telt daarom; ontbrekend, onbekend,
 * `DISMISSED`, `PENDING` of `CHANGES_REQUESTED` nooit.
 *
 * Een issuecomment kent geen state: die route staat los en wordt hier niet beperkt. Een drager
 * zonder herkenbare herkomst telt nooit — fail-closed, niet "waarschijnlijk een comment".
 */
function ownerCarrierIsActive(envelope, gate) {
  const source = envelope?.source;
  const state = envelope?.review_state;
  if (source === 'issue_comment') return state === undefined || state === null;
  if (source !== 'review') return false;
  const allowed = gate?.allowed_review_states;
  if (!Array.isArray(allowed) || allowed.length === 0) return false;
  return isNonEmptyString(state) && allowed.includes(state) && OWNER_REVIEW_ACTIVE_STATES.includes(state);
}

/**
 * Evalueert één owner-autorisatie tegen de gemeten waarheid. De dragende GitHub-auteur
 * (`transport_actor`) komt uitsluitend uit de API; het blok zelf draagt geen actorveld, juist zodat
 * er niets te verzinnen valt. Geen zelfreviewregel: de eigenaar mág de PR-auteur zijn.
 */
export function evaluateOwnerApproval(envelope, rawContext, rawGate) {
  const context = rawContext ?? {};
  const gate = rawGate ?? {};
  const reasons = [];
  const add = (r) => { if (!reasons.includes(r)) reasons.push(r); };

  const approval = envelope?.approval;
  const transportActor = envelope?.transport_actor;
  if (typeof approval !== 'object' || approval === null || Array.isArray(approval)) {
    return { valid: false, reasons: [REASON.OWNER_APPROVAL_SCHEMA_MISMATCH] };
  }

  for (const key of Object.keys(approval)) {
    if (!OWNER_APPROVAL_FIELDS.has(key)) add(REASON.OWNER_APPROVAL_UNKNOWN_FIELD);
  }
  if (approval.schema !== OWNER_APPROVAL_SCHEMA) add(REASON.OWNER_APPROVAL_SCHEMA_MISMATCH);
  if (!isNonEmptyString(approval.task_id)) add(REASON.OWNER_APPROVAL_SCHEMA_MISMATCH);
  if (!SHA_RE.test(approval.head_sha) || !SHA_RE.test(approval.tree_sha)) add(REASON.BAD_SHA_FORMAT);
  if (reasons.length > 0) return { valid: false, reasons };

  if (!ownerActorList(gate).includes(transportActor)) add(REASON.OWNER_APPROVAL_ACTOR_NOT_ALLOWED);
  if (!ownerCarrierIsActive(envelope, gate)) add(REASON.OWNER_APPROVAL_CARRIER_NOT_ACTIVE);
  if (!isNonEmptyString(context.task_id) || approval.task_id !== context.task_id) {
    add(REASON.OWNER_APPROVAL_TASK_MISMATCH);
  }
  if (!SHA_RE.test(context.pr_head_sha) || approval.head_sha !== context.pr_head_sha) {
    add(REASON.OWNER_APPROVAL_STALE_HEAD);
  }
  if (!SHA_RE.test(context.pr_tree_sha) || approval.tree_sha !== context.pr_tree_sha) {
    add(REASON.OWNER_APPROVAL_TREE_MISMATCH);
  }
  if (approval.decision !== 'APPROVE') add(REASON.OWNER_APPROVAL_NOT_APPROVE);

  return { valid: reasons.length === 0, reasons };
}

/**
 * Evalueert de volledige set owner-autorisaties voor één PR-head. Eén geldige autorisatie van een
 * allowlisted eigenaar op de actuele head/tree/task is genoeg; nul is nooit genoeg. Autorisaties van
 * een auteur buiten de allowlist zijn ruis: ze kunnen geen reden en geen blokkade injecteren.
 */
export function evaluateOwnerApprovals(envelopes, rawContext, rawGate) {
  const context = rawContext ?? {};
  const gate = rawGate ?? {};
  const list = (Array.isArray(envelopes) ? envelopes : []).filter((e) => e != null);
  const allowed = new Set(ownerActorList(gate));
  const trusted = list.filter((e) => allowed.has(e?.transport_actor));
  if (trusted.length === 0) {
    return { decision: 'NO_GO', reasons: [REASON.OWNER_APPROVAL_MISSING] };
  }

  // Alleen een GOED GEVORMDE autorisatie voor een andere head is een afgesloten ronde; een malformed
  // blok blijft geselecteerd en faalt gesloten op zijn eigen categorie.
  const current = trusted.filter((e) => {
    const head = e?.approval?.head_sha;
    return !(SHA_RE.test(head) && SHA_RE.test(context.pr_head_sha) && head !== context.pr_head_sha);
  });
  if (current.length === 0) {
    return {
      decision: 'NO_GO',
      reasons: [REASON.OWNER_APPROVAL_MISSING, REASON.OWNER_APPROVAL_STALE_HEAD],
    };
  }

  const evaluated = current.map((e) => evaluateOwnerApproval(e, context, gate));
  if (evaluated.some((e) => e.valid)) return { decision: 'GO', reasons: [] };
  const reasons = new Set();
  for (const e of evaluated) for (const r of e.reasons) reasons.add(r);
  return { decision: 'NO_GO', reasons: Array.from(reasons) };
}

/**
 * De volledige Shield-uitspraak.
 *
 *  - Native tweevendorbewijs (Codex én Gemini) is altijd vereist.
 *  - `filesComplete` is de gemeten volledigheid van `/pulls/{n}/files` tegen `pr.changed_files`.
 *    Onvolledig zicht is een eigen NO_GO-grond ÉN maakt de PR gevoelig: bij een blinde vlek wordt de
 *    ownergate juist wél geëist, nooit overgeslagen.
 *  - De ownergate is een afzonderlijke poort met een eigen schema en een eigen allowlist. Hij telt
 *    nooit als vendor en kan een ontbrekende vendor nooit vervangen.
 *
 * De ownergate-policy wordt altijd gevalideerd, ook op een niet-gevoelige PR.
 */
export function evaluateShield({
  nativeEvidence, ownerApprovals, sensitivePathsTouched, filesComplete, context, policy,
}) {
  try {
    assertOwnerGateSafe(policy);
  } catch {
    return { decision: 'NO_GO', reasons: [REASON.UNSAFE_POLICY] };
  }

  const nativeResult = evaluateNativeReview(nativeEvidence, context, policy);
  const reasons = new Set(nativeResult.reasons);

  const filesAreComplete = filesComplete === true;
  if (!filesAreComplete) reasons.add(REASON.FILES_INCOMPLETE);

  if (sensitivePathsTouched || !filesAreComplete) {
    const ownerResult = evaluateOwnerApprovals(ownerApprovals, context, policy?.owner_gate);
    if (ownerResult.decision !== 'GO') {
      reasons.add(REASON.OWNER_GATE_REQUIRED);
      for (const r of ownerResult.reasons) reasons.add(r);
    }
  }
  return { decision: reasons.size === 0 ? 'GO' : 'NO_GO', reasons: Array.from(reasons) };
}

/** Sleutels die precies één niet-lege waarde nemen. Alle vier zijn bestandspaden. */
export const VERIFY_VALUE_OPTIONS = Object.freeze([
  '--context', '--policy', '--receipts', '--shield-input',
]);

/**
 * Zelfde fail-closed argumentlezing als de publisher en de targetselector: token voor token in
 * plaats van in VASTE PAREN.
 *
 * De paarlezing (`for (i = 0; i < argv.length; i += 2)`) las elke oneven positie als sleutel en elke
 * even positie als waarde. Eén extra of ontbrekend token verschoof daardoor STIL de hele rest:
 * `--policy` kon het pad van `--receipts` krijgen, en een onbekend argument werd zonder klacht als
 * sleutel opgeslagen. De poort besliste dan over ANDERE bestanden dan de aanroeper bedoelde, zonder
 * dat er iets aan de uitvoer te zien was.
 *
 * Weigeringen: een onbekend argument, een dubbel opgegeven sleutel, een sleutel zonder waarde
 * (inclusief oneven argv), een lege waarde en een waarde die zelf een bekende sleutel is.
 *
 * De bronkeuze blijft exclusief: precies één van `--receipts` of `--shield-input`. Beide tegelijk is
 * geen rijkere invoer maar een dubbelzinnige opdracht — welke bron de uitspraak droeg zou dan van de
 * implementatievolgorde afhangen in plaats van van de aanroep.
 */
export function parseVerifyArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const options = new Set(VERIFY_VALUE_OPTIONS);
  const values = new Map();
  const reject = { ok: false };

  for (let i = 0; i < list.length; i += 1) {
    const token = list[i];
    if (typeof token !== 'string') return reject;
    if (!options.has(token)) return reject;
    if (values.has(token)) return reject;
    i += 1;
    const value = list[i];
    if (typeof value !== 'string' || value.length === 0) return reject;
    if (options.has(value)) return reject;
    values.set(token, value);
  }
  if (!values.has('--context') || !values.has('--policy')) return reject;
  if (values.has('--receipts') === values.has('--shield-input')) return reject;
  return { ok: true, values };
}

async function runCli() {
  const { readFileSync } = await import('node:fs');
  const parsed = parseVerifyArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.log(JSON.stringify({ decision: 'NO_GO', reasons: [REASON.PARSE_ERROR] }));
    process.exitCode = 1;
    return;
  }
  const args = parsed.values;

  const contextPath = args.get('--context');
  const policyPath = args.get('--policy');
  const receiptsPath = args.get('--receipts');
  const shieldInputPath = args.get('--shield-input');

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

  // Geen policyvalidatie meer op CLI-niveau: `evaluateShield` (via `assertOwnerGateSafe` en
  // `evaluateNativeReview` -> `assertNativeVendorsSafe`) en `evaluateReceipts` (via
  // `assertPolicyIsSafe`) valideren allebei zelf en geven UNSAFE_POLICY terug in plaats van te
  // gooien. Een tweede try/catch hier voegde geen enkele weigering toe en suggereerde ten onrechte
  // dat de fail-closed garantie aan de CLI hing in plaats van aan de centrale evaluatoren.
  const result = shieldInputPath
    ? evaluateShield({
      nativeEvidence: shieldInput?.nativeEvidence,
      ownerApprovals: shieldInput?.ownerApprovals,
      sensitivePathsTouched: Boolean(shieldInput?.sensitivePathsTouched),
      filesComplete: shieldInput?.filesComplete === true,
      context,
      policy,
    })
    : evaluateReceipts(receipts, context, policy);
  console.log(JSON.stringify(result));
  process.exitCode = result.decision === 'GO' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
