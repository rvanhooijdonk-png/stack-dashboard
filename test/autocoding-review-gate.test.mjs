/**
 * AUTOCODING_REVIEW_RECEIPT_V1 — de bindende testmatrix uit de opdracht (12 genummerde gevallen),
 * plus de machineblok-extractie en de policy-veiligheidscheck die de validator zelf ook gebruikt.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  evaluateReceipts, evaluateReceipt, extractReceiptFromCommentBody, assertPolicyIsSafe,
  REASON, RECEIPT_SCHEMA,
  extractCodexNativeEvidence, extractCodexReviewEvidence, extractGeminiNativeEvidence,
  bindNativeEvidence, assertNativeVendorsSafe, assertOwnerGateSafe, evaluateNativeReview,
  evaluateShield, evaluateOwnerApprovals, extractOwnerApprovalFromBody, OWNER_APPROVAL_SCHEMA,
  isSafeSensitivePrefix, parseVerifyArgs, VERIFY_VALUE_OPTIONS,
} from '../scripts/autocoding/verify-review-gate.mjs';

const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const OLD_HEAD = 'c'.repeat(40);
const OLD_TREE = 'd'.repeat(40);

const CONTEXT = Object.freeze({
  pr_head_sha: HEAD,
  pr_tree_sha: TREE,
  builder_actor: 'claude1-cloud',
  task_id: 'AUTOCODING_GITHUB_NATIVE_SHIELD_STACK_DASHBOARD_V1',
});

const POLICY = Object.freeze({
  required_distinct_vendors: 2,
  allowed_reviewer_actors: Object.freeze({
    codex: Object.freeze(['codex-bot-alpha', 'codex-bot-beta']),
    gemini: Object.freeze(['gemini-bot-alpha']),
  }),
});

function uuid(n) {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function baseReceipt(overrides = {}) {
  return {
    schema: RECEIPT_SCHEMA,
    task_id: 'AUTOCODING_GITHUB_NATIVE_SHIELD_STACK_DASHBOARD_V1',
    reviewer_actor: 'codex-bot-alpha',
    reviewer_vendor: 'codex',
    receipt_uuid: uuid(1),
    head_sha: HEAD,
    tree_sha: TREE,
    verdict: 'GO',
    checks_executed: ['unit-tests'],
    builder_actor: 'claude1-cloud',
    ...overrides,
  };
}

function signed(receipt, transport_actor = receipt.reviewer_actor) {
  return { receipt, transport_actor };
}

const goCodex = (overrides = {}) => baseReceipt({
  reviewer_actor: 'codex-bot-alpha', reviewer_vendor: 'codex', receipt_uuid: uuid(1), ...overrides,
});
const goGemini = (overrides = {}) => baseReceipt({
  reviewer_actor: 'gemini-bot-alpha', reviewer_vendor: 'gemini', receipt_uuid: uuid(2), ...overrides,
});

// --- de 12 bindende gevallen --------------------------------------------------------------------

test('1. twee leveranciers, actuele sha/tree, niet-bouwer, beide GO => GO', () => {
  const r = evaluateReceipts([signed(goCodex()), signed(goGemini())], CONTEXT, POLICY);
  assert.equal(r.decision, 'GO');
  assert.deepEqual(r.reasons, []);
});

test('2. één receipt op vorige head => NO_GO (STALE_HEAD)', () => {
  const r = evaluateReceipts([signed(goCodex({ head_sha: OLD_HEAD })), signed(goGemini({ head_sha: OLD_HEAD }))], CONTEXT, POLICY);
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.STALE_HEAD));
});

test('3. juiste head maar verkeerde tree => NO_GO (TREE_MISMATCH)', () => {
  const r = evaluateReceipts([signed(goCodex()), signed(goGemini({ tree_sha: OLD_TREE }))], CONTEXT, POLICY);
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.TREE_MISMATCH));
});

test('4. twee actors van dezelfde leverancier => NO_GO (DUPLICATE_VENDOR)', () => {
  const r = evaluateReceipts([
    signed(goCodex({ reviewer_actor: 'codex-bot-alpha', receipt_uuid: uuid(1) })),
    signed(goCodex({ reviewer_actor: 'codex-bot-beta', receipt_uuid: uuid(2) })),
  ], CONTEXT, POLICY);
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.DUPLICATE_VENDOR));
});

test('5. bouwer keurt zichzelf goed => NO_GO (SELF_REVIEW)', () => {
  const r = evaluateReceipts([
    signed(goCodex({ reviewer_actor: 'claude1-cloud', builder_actor: 'claude1-cloud' }), 'codex-bot-alpha'),
    signed(goGemini()),
  ], CONTEXT, POLICY);
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.SELF_REVIEW));
});

test('6. dubbele receipt-UUID => NO_GO (DUPLICATE_UUID)', () => {
  const dup = uuid(9);
  const r = evaluateReceipts([signed(goCodex({ receipt_uuid: dup })), signed(goGemini({ receipt_uuid: dup }))], CONTEXT, POLICY);
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.DUPLICATE_UUID));
});

test('7. leeg checks_executed => NO_GO (EMPTY_CHECKS)', () => {
  const r = evaluateReceipts([signed(goCodex({ checks_executed: [] })), signed(goGemini())], CONTEXT, POLICY);
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.EMPTY_CHECKS));
});

test('8a. ontbrekend receipt (maar één leverancier aanwezig) => NO_GO (INSUFFICIENT_GO)', () => {
  const r = evaluateReceipts([signed(goCodex())], CONTEXT, POLICY);
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.INSUFFICIENT_GO));
});

test('8b. geen enkel receipt => NO_GO (NO_RECEIPTS)', () => {
  const r = evaluateReceipts([], CONTEXT, POLICY);
  assert.equal(r.decision, 'NO_GO');
  assert.deepEqual(r.reasons, [REASON.NO_RECEIPTS]);
});

test('9. NO_GO naast GO => NO_GO (NO_GO_VERDICT_PRESENT)', () => {
  const r = evaluateReceipts([signed(goCodex({ verdict: 'NO_GO' })), signed(goGemini())], CONTEXT, POLICY);
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.NO_GO_VERDICT_PRESENT));
});

test('10. skipped/missing check als succesclaim => NO_GO (SKIPPED_OR_MISSING_CHECK)', () => {
  const r = evaluateReceipts([
    signed(goCodex({ checks_executed: [{ name: 'unit-tests', rc: null }] })),
    signed(goGemini()),
  ], CONTEXT, POLICY);
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.SKIPPED_OR_MISSING_CHECK));
});

test('11. lege rc0-output => NO_GO (EMPTY_CHECK_OUTPUT)', () => {
  const r = evaluateReceipts([
    signed(goCodex({ checks_executed: [{ name: 'unit-tests', rc: 0, output_bytes: 0 }] })),
    signed(goGemini()),
  ], CONTEXT, POLICY);
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.EMPTY_CHECK_OUTPUT));
});

test('12a. wildcard transportidentiteit => NO_GO (WILDCARD_IDENTITY)', () => {
  const r = evaluateReceipts([signed(goCodex({ reviewer_actor: '*' }), 'codex-bot-alpha'), signed(goGemini())], CONTEXT, POLICY);
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.WILDCARD_IDENTITY));
});

test('12b. onbekende (onbewezen) actor => NO_GO (UNKNOWN_ACTOR)', () => {
  const r = evaluateReceipts([signed(goCodex({ reviewer_actor: 'onbewezen-account' }), 'codex-bot-alpha'), signed(goGemini())], CONTEXT, POLICY);
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.UNKNOWN_ACTOR));
});

test('12c. onbekende leverancier => NO_GO (UNKNOWN_VENDOR)', () => {
  const r = evaluateReceipts([signed(goCodex({ reviewer_vendor: 'onbekend-vendor' })), signed(goGemini())], CONTEXT, POLICY);
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.UNKNOWN_VENDOR));
});

// --- aanvullend: machineblok, onbekende velden, sha-vorm, policyveiligheid ----------------------

test('narratieve claim zonder machineblok levert geen receipt op', () => {
  assert.equal(extractReceiptFromCommentBody('Ziet er goed uit, GO van mij!'), null);
});

test('machineblok met geldige JSON wordt uitgelezen', () => {
  const body = `Review klaar.\n\n\`\`\`autocoding-review-receipt-v1\n${JSON.stringify(goCodex())}\n\`\`\`\n`;
  const extracted = extractReceiptFromCommentBody(body);
  assert.equal(extracted.reviewer_actor, 'codex-bot-alpha');
});

test('machineblok met kapotte JSON telt niet als receipt', () => {
  assert.equal(extractReceiptFromCommentBody('```autocoding-review-receipt-v1\n{niet geldig json\n```'), null);
});

test('onbekend veld maakt het receipt ongeldig (overschrijft geen securitysemantiek)', () => {
  const r = evaluateReceipt(signed(goCodex({ trusted: true })), CONTEXT, POLICY);
  assert.equal(r.valid, false);
  assert.ok(r.reasons.includes(REASON.UNKNOWN_FIELD));
});

test('afgekorte sha wordt geweigerd', () => {
  const r = evaluateReceipt(signed(goCodex({ head_sha: HEAD.slice(0, 7) })), CONTEXT, POLICY);
  assert.equal(r.valid, false);
  assert.ok(r.reasons.includes(REASON.BAD_SHA_FORMAT));
});

test('policy met wildcard-actor wordt geweigerd', () => {
  assert.throws(() => assertPolicyIsSafe({ allowed_reviewer_actors: { codex: ['*'] } }));
});

const UNSAFE_ACTOR_POLICIES = [
  ['string-actorlijst met matchende substring', { allowed_reviewer_actors: { codex: 'codex-bot-alpha-extra' } }],
  ['null-actorlijst', { allowed_reviewer_actors: { codex: null } }],
  ['primitieve actorlijst', { allowed_reviewer_actors: { codex: 42 } }],
  ['object-actorlijst', { allowed_reviewer_actors: { codex: { 0: 'codex-bot-alpha' } } }],
  ['wildcard-actor', { allowed_reviewer_actors: { codex: ['*'] } }],
  ['lege actornaam', { allowed_reviewer_actors: { codex: [''] } }],
  ['wildcard-vendor', { allowed_reviewer_actors: { '*': ['codex-bot-alpha'] } }],
  ['lege vendornaam', { allowed_reviewer_actors: { '': ['codex-bot-alpha'] } }],
];

test('evaluateReceipt laat actor nooit toe via een niet-array allowlist', () => {
  for (const [, policy] of UNSAFE_ACTOR_POLICIES.slice(0, 4)) {
    const r = evaluateReceipt(signed(goCodex()), CONTEXT, policy);
    assert.equal(r.valid, false);
    assert.ok(r.reasons.includes(REASON.UNKNOWN_ACTOR));
  }
});

test('evaluateReceipts weigert iedere onveilige policy vóór vertrouwensselectie zonder throw', () => {
  for (const [name, policy] of UNSAFE_ACTOR_POLICIES) {
    assert.doesNotThrow(() => evaluateReceipts([signed(goCodex()), signed(goGemini())], CONTEXT, policy), name);
    assert.deepEqual(
      evaluateReceipts([signed(goCodex()), signed(goGemini())], CONTEXT, policy),
      { decision: 'NO_GO', reasons: [REASON.UNSAFE_POLICY] },
      name,
    );
  }
});

test('lege allowlist is een toegestane fail-closed default', () => {
  assert.doesNotThrow(() => assertPolicyIsSafe({ allowed_reviewer_actors: { codex: [], gemini: [] } }));
});

test('zelfverklaarde reviewer van onbekende GitHub-auteur wordt als ruis genegeerd', () => {
  const r = evaluateReceipts([
    signed(goCodex(), 'aanvaller'), signed(goGemini()),
  ], CONTEXT, POLICY);
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.INSUFFICIENT_GO));
  assert.ok(!r.reasons.includes(REASON.TRANSPORT_ACTOR_MISMATCH));
});

// --- regressies: trusted selectie, actuele-headselectie, defensieve API en workflowbootstrap ------

test('twee actuele trusted receipts plus forged duplicate van onbekende auteur => GO', () => {
  const forged = signed(goCodex({ receipt_uuid: uuid(1) }), 'publieke-aanvaller');
  const r = evaluateReceipts([signed(goCodex()), signed(goGemini()), forged], CONTEXT, POLICY);
  assert.deepEqual(r, { decision: 'GO', reasons: [] });
});

test('uitsluitend forged/untrusted receipts => NO_GO zonder geldige receipts', () => {
  const r = evaluateReceipts([
    signed(goCodex(), 'aanvaller-1'), signed(goGemini(), 'aanvaller-2'),
  ], CONTEXT, POLICY);
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.NO_RECEIPTS));
});

test('malformed receipt van allowlisted transportactor => NO_GO', () => {
  const r = evaluateReceipts([
    { receipt: null, transport_actor: 'codex-bot-alpha' }, signed(goGemini()),
  ], CONTEXT, POLICY);
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.PARSE_ERROR));
});

test('twee actuele geldige trusted receipts plus stale oud receipt => GO', () => {
  const stale = signed(goCodex({ head_sha: OLD_HEAD, tree_sha: OLD_TREE, receipt_uuid: uuid(9) }));
  const r = evaluateReceipts([stale, signed(goCodex()), signed(goGemini())], CONTEXT, POLICY);
  assert.deepEqual(r, { decision: 'GO', reasons: [] });
});

test('stale-only receipts leveren nooit GO voor een nieuwe head', () => {
  const r = evaluateReceipts([
    signed(goCodex({ head_sha: OLD_HEAD })), signed(goGemini({ head_sha: OLD_HEAD })),
  ], CONTEXT, POLICY);
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.NO_RECEIPTS));
});

test('evaluateReceipt geeft bij null/undefined context en policy deterministisch NO_GO-data', () => {
  for (const [context, policy] of [[null, null], [undefined, undefined]]) {
    const r = evaluateReceipt(signed(goCodex()), context, policy);
    assert.equal(r.valid, false);
    assert.ok(r.reasons.includes(REASON.STALE_HEAD));
    assert.ok(r.reasons.includes(REASON.UNKNOWN_VENDOR));
  }
});

test('evaluateReceipts geeft bij null/undefined context en policy deterministisch NO_GO', () => {
  for (const [context, policy] of [[null, null], [undefined, undefined]]) {
    const r = evaluateReceipts([signed(goCodex()), signed(goGemini())], context, policy);
    assert.equal(r.decision, 'NO_GO');
    assert.deepEqual(r.reasons, [REASON.UNSAFE_POLICY]);
  }
});

test('CLI schrijft beslis-JSON bij ontbrekende argumenten naar stdout en eindigt met rc 1', () => {
  const cli = spawnSync(process.execPath, ['scripts/autocoding/verify-review-gate.mjs'], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.equal(cli.stderr, '');
  assert.deepEqual(JSON.parse(cli.stdout), { decision: 'NO_GO', reasons: [REASON.PARSE_ERROR] });
});

test('CLI schrijft geëvalueerde NO_GO als JSON naar stdout en eindigt met rc 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'autocoding-shield-'));
  const paths = ['receipts.json', 'context.json', 'policy.json'].map((name) => join(dir, name));
  writeFileSync(paths[0], '[]');
  writeFileSync(paths[1], JSON.stringify(CONTEXT));
  writeFileSync(paths[2], JSON.stringify(POLICY));
  const cli = spawnSync(process.execPath, [
    'scripts/autocoding/verify-review-gate.mjs', '--receipts', paths[0], '--context', paths[1],
    '--policy', paths[2],
  ], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.equal(cli.stderr, '');
  assert.equal(JSON.parse(cli.stdout).decision, 'NO_GO');
});

test('CLI behoudt UNSAFE_POLICY voor een parseerbare onveilige policy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'autocoding-shield-'));
  const paths = ['receipts.json', 'context.json', 'policy.json'].map((name) => join(dir, name));
  writeFileSync(paths[0], JSON.stringify([signed(goCodex())]));
  writeFileSync(paths[1], JSON.stringify(CONTEXT));
  writeFileSync(paths[2], JSON.stringify({ allowed_reviewer_actors: { codex: 'codex-bot-alpha-extra' } }));
  const cli = spawnSync(process.execPath, [
    'scripts/autocoding/verify-review-gate.mjs', '--receipts', paths[0], '--context', paths[1],
    '--policy', paths[2],
  ], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.equal(cli.stderr, '');
  assert.deepEqual(JSON.parse(cli.stdout), { decision: 'NO_GO', reasons: [REASON.UNSAFE_POLICY] });
});

test('CLI behoudt PARSE_ERROR voor syntactisch kapotte JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'autocoding-shield-'));
  const paths = ['receipts.json', 'context.json', 'policy.json'].map((name) => join(dir, name));
  writeFileSync(paths[0], '[]');
  writeFileSync(paths[1], JSON.stringify(CONTEXT));
  writeFileSync(paths[2], '{kapotte json');
  const cli = spawnSync(process.execPath, [
    'scripts/autocoding/verify-review-gate.mjs', '--receipts', paths[0], '--context', paths[1],
    '--policy', paths[2],
  ], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.equal(cli.stderr, '');
  assert.deepEqual(JSON.parse(cli.stdout), { decision: 'NO_GO', reasons: [REASON.PARSE_ERROR] });
});

const PR_SHIELD_PATH = '.github/workflows/autocoding-shield.yml';
const LIVE_GATE_PATH = '.github/workflows/autocoding-shield-live-gate.yml';

/** Alleen de werkelijke YAML; toelichtende commentaarregels mogen elke naam noemen. */
function yamlOnly(path) {
  return readFileSync(path, 'utf8').split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
}

/** De jobnamen van een workflowbestand; `on:`-sleutels hebben dezelfde inspringing en tellen niet. */
function jobNames(path) {
  const lines = yamlOnly(path).split('\n');
  const start = lines.findIndex((l) => l === 'jobs:');
  assert.ok(start !== -1, `geen jobs-blok: ${path}`);
  return lines.slice(start + 1)
    .filter((l) => /^ {2}[a-z][a-z0-9-]*:$/.test(l))
    .map((l) => l.trim());
}

test('workflow-eventmatrix houdt bootstrap-events groen en live gate uit', () => {
  const shield = yamlOnly(PR_SHIELD_PATH);
  const liveGate = yamlOnly(LIVE_GATE_PATH);
  const policy = JSON.parse(readFileSync('CONTROL/AUTOCODING/policy.v1.json', 'utf8'));

  // De onprivileged shield ontvangt PR- en reviewevents; PR-code draait alleen op `pull_request`,
  // de rest is een signaaljob zonder inhoud. `issue_comment` hoort hier NIET meer: dat event draait
  // altijd de default-branch-definitie en gaat sinds V11 rechtstreeks naar de trusted writer. Zou de
  // shield het óók signaleren, dan leverde één comment twee aanleidingen op.
  assert.match(shield, /^on:\n {2}pull_request:$/m);
  for (const event of ['pull_request_review:', 'pull_request_review_comment:']) {
    assert.ok(shield.includes(event), `signaalevent ontbreekt op de shield: ${event}`);
  }
  assert.ok(!shield.includes('issue_comment'), 'issue_comment hoort niet meer op de shield');
  assert.match(shield, /if: github\.event_name == 'pull_request'/);

  // De trusted writer kent GEEN `pull_request*`-event. Dat is de gemeten grens: Actions-run
  // 32542688290 draaide op `pull_request_review` een writerbestand dat op `main` 404 gaf — de
  // definitie kwam dus van de PR-head. `workflow_run`, `schedule` en `issue_comment` laden
  // gegarandeerd de default-branch-definitie.
  for (const event of ['workflow_run:', 'schedule:', 'issue_comment:']) {
    assert.ok(liveGate.includes(event), `trusted event ontbreekt: ${event}`);
  }
  assert.match(liveGate, /^ {2}workflow_run:\n {4}workflows: \[autocoding-shield\]$/m);
  for (const verboden of ['pull_request_review', 'pull_request_target']) {
    assert.ok(!liveGate.includes(verboden), `de trusted writer mag niet op ${verboden} draaien`);
  }
  assert.ok(!/^ {2}pull_request(_target)?:$/m.test(liveGate), 'de trusted writer heeft geen PR-event');

  assert.match(liveGate, /BOOTSTRAP_TRUSTED_GATE_FILES_NOT_ON_DEFAULT_BRANCH/);
  assert.match(liveGate, /BOOTSTRAP_RECEIPT_GATE_DISABLED/);
  assert.match(liveGate, /Bepaal poortstand en statuscontext\n\s+id: enabled\n\s+if: steps\.bootstrap\.outputs\.trusted_gate_files == 'true'/);

  // De poort blijft in deze PR uit, en de statuscontext waaronder hij later publiceert is geen jobnaam.
  assert.equal(policy.live_receipt_gate_enabled, false);
  assert.equal(policy.live_status_context, 'autocoding-shield-live-receipts');
  assert.ok(!/^ {2}autocoding-shield-live-receipts:$/m.test(liveGate), 'de statuscontext is geen jobnaam');
});

test('W1. de stabiele checknaam draait alleen op pull_request en heeft geen API-rechten', () => {
  const shield = yamlOnly(PR_SHIELD_PATH);
  // Twee jobs: de stabiele checknaam en het onprivileged signaal dat de trusted keten aanstoot.
  assert.deepEqual(jobNames(PR_SHIELD_PATH), ['autocoding-shield:', 'autocoding-shield-signal:']);
  // De signaaljob voert geen repositorycode uit: geen checkout, geen tests, geen scripts.
  const signaal = shield.slice(shield.indexOf('  autocoding-shield-signal:'));
  assert.ok(!signaal.includes('actions/checkout'), 'het signaal checkt niets uit');
  assert.ok(!signaal.includes('node '), 'het signaal voert geen code uit');
  assert.match(signaal, /permissions: \{\}/);
  // De job die PR-headcode uitvoert leest zelf niets uit de GitHub-API en krijgt daar ook geen
  // rechten voor: alleen `contents: read` om de head te kunnen uitchecken.
  assert.ok(!shield.includes('gh api'), 'de PR-head-job mag de API niet bevragen');
  assert.ok(!shield.includes('pull-requests: read'), 'de PR-head-job heeft die scope niet nodig');
  assert.ok(!shield.includes('issues: read'), 'de PR-head-job heeft die scope niet nodig');
  assert.ok(!shield.includes('GH_TOKEN'), 'de PR-head-job krijgt geen token');
});

test('W1b. de statuswriter staat in een APART bestand; PR-voorgestelde YAML krijgt nooit statuses: write', () => {
  // Dit is de kern van de reparatie. Een `pull_request`-run gebruikt de workflowdefinitie uit de PR
  // zelf. Zolang de schrijfscope in datzelfde bestand stond, kon een same-repo branch de stappen
  // vervangen en de receiptstatus zelf groen schrijven — het uitchecken van de default branch
  // beschermt de scripts, niet de YAML die job en tokenpermissies definieert.
  const shield = yamlOnly(PR_SHIELD_PATH);
  assert.ok(!/:\s*write\b/.test(shield), 'de PR-shield mag geen enkele schrijfscope dragen');
  assert.match(shield, /^permissions: \{\}$/m);

  // Twee jobs sinds V11: een read-only selectie en één matrixjob per doel-PR. Alleen die tweede
  // draagt een schrijfscope, en het blijft bij die ene.
  const liveGate = yamlOnly(LIVE_GATE_PATH);
  assert.deepEqual(jobNames(LIVE_GATE_PATH), ['selecteer:', 'schrijf:']);
  assert.deepEqual(
    liveGate.split('\n').filter((line) => /^\s+[a-z-]+:\s*write\b/.test(line)).map((l) => l.trim()),
    ['statuses: write'],
  );
  const selecteer = liveGate.slice(liveGate.indexOf('  selecteer:'), liveGate.indexOf('  schrijf:'));
  assert.ok(!/:\s*write\b/.test(selecteer), 'de selectiejob mag geen schrijfscope dragen');
  assert.match(liveGate, /^permissions: \{\}$/m);
});

test('W2. de live poort voert nooit PR-headcode uit en checkt uitsluitend de default branch uit', () => {
  const liveGate = yamlOnly(LIVE_GATE_PATH);
  assert.match(liveGate, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.ok(
    !/ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/.test(liveGate),
    'de live-gate-job mag de PR-head niet uitchecken',
  );
  assert.ok(!liveGate.includes('node --test'), 'de live-gate-job mag geen PR-headtests draaien');
  assert.ok(!/actions\/(cache|download-artifact)/.test(liveGate), 'geen PR-artifacts of -cache');
  // De writer serialiseert PER PULL REQUEST, niet globaal: de groep sleutelt op de matrixwaarde,
  // zodat twee aanleidingen voor dezelfde PR achter elkaar aanschuiven (`queue: max`) terwijl
  // verschillende PR's elkaar niet blokkeren. Een `concurrency` op WORKFLOWniveau zou die rijen
  // weer samenvoegen en is daarom verboden.
  assert.match(liveGate, /^ {6}group: autocoding-shield-live-gate-pr-\$\{\{ matrix\.pr \}\}$/m);
  assert.match(liveGate, /^ {6}cancel-in-progress: false$/m);
  assert.match(liveGate, /^ {6}queue: max$/m);
  assert.ok(!/^concurrency:$/m.test(liveGate), 'geen concurrency op workflowniveau in de writer');
  assert.match(yamlOnly(PR_SHIELD_PATH), /^ {2}group: autocoding-shield-/m);
});

test('W3. geen pull_request_target, geen secrets, uitsluitend read-only GETs', () => {
  for (const path of [PR_SHIELD_PATH, LIVE_GATE_PATH]) {
    const yaml = yamlOnly(path);
    assert.ok(!yaml.includes('pull_request_target'), `pull_request_target is verboden: ${path}`);
    assert.ok(!/contents:\s*write/.test(yaml), `geen contents: write: ${path}`);
    assert.ok(!/actions:\s*write/.test(yaml), `geen actions: write: ${path}`);
    assert.ok(!/pull-requests:\s*write/.test(yaml), `geen pull-requests: write: ${path}`);
    assert.ok(!/id-token:\s*write/.test(yaml), `geen id-token: write: ${path}`);
    assert.ok(!/secrets\./.test(yaml), `de workflow mag geen secrets lezen: ${path}`);
    assert.ok(!yaml.includes('workflow_dispatch'), `geen handmatige trigger op dit pad: ${path}`);
    assert.ok(!yaml.includes('environment:'), `geen environment op dit pad: ${path}`);
    // Elke API-aanroep is een read-only GET: geen -X/--method, geen -f/--field payloads.
    for (const line of yaml.split('\n').filter((l) => l.includes('gh api'))) {
      assert.ok(!/(^|\s)(-X|--method|-f |--field|--input)/.test(line), `niet read-only: ${line.trim()}`);
    }
  }
});

test('W4. de live poort roept adapter én beslisser aan, niet één van beide', () => {
  const liveGate = readFileSync(LIVE_GATE_PATH, 'utf8');
  assert.match(liveGate, /node scripts\/autocoding\/collect-shield-input\.mjs/);
  assert.match(liveGate, /node scripts\/autocoding\/verify-review-gate\.mjs \\\n\s+--shield-input/);
  // Zonder deze bestanden op de default branch is er geen poort: de bootstrapcheck moet ze allebei
  // noemen, anders zou een halve checkout stilzwijgend als "poort actief" gelden.
  assert.match(liveGate, /-f scripts\/autocoding\/collect-shield-input\.mjs/);
});

test('N1. echte Codex-successtekst + representatief schone Gemini-review, actuele head/tree => GO', () => {
  const codex = extractCodexNativeEvidence(codexComment(), resolved(), NATIVE_POLICY);
  const gemini = extractGeminiNativeEvidence(geminiReview(), [], resolved(), NATIVE_POLICY);
  const r = evaluateNativeReview([codex, gemini], NATIVE_CONTEXT, NATIVE_POLICY);
  assert.deepEqual(r, { decision: 'GO', reasons: [] });
});

test('N2. niet-gevoelige PR heeft geen ownerbewijs nodig (positief)', () => {
  const codex = extractCodexNativeEvidence(codexComment(), resolved(), NATIVE_POLICY);
  const gemini = extractGeminiNativeEvidence(geminiReview(), [], resolved(), NATIVE_POLICY);
  const r = evaluateShield({
    nativeEvidence: [codex, gemini], ownerApprovals: [], sensitivePathsTouched: false,
    filesComplete: true,
    context: NATIVE_CONTEXT, policy: NATIVE_POLICY,
  });
  assert.deepEqual(r, { decision: 'GO', reasons: [] });
});

test('N3. gevoelige PR met geldige owner-autorisatie => GO', () => {
  const codex = extractCodexNativeEvidence(codexComment(), resolved(), NATIVE_POLICY);
  const gemini = extractGeminiNativeEvidence(geminiReview(), [], resolved(), NATIVE_POLICY);
  const r = evaluateShield({
    nativeEvidence: [codex, gemini], ownerApprovals: [ownerApprovalEnvelope()],
    sensitivePathsTouched: true, filesComplete: true,
    context: NATIVE_CONTEXT, policy: NATIVE_POLICY,
  });
  assert.deepEqual(r, { decision: 'GO', reasons: [] });
});

test('N3a. de ECHTE gedeelde identiteit: PR-auteur en owner zijn dezelfde GitHub-gebruiker => GO', () => {
  // Dit is het gemeten geval op deze repository: PR-auteur `rvanhooijdonk-png` is ook de enige
  // toegestane owner. Onder de oude opzet liep de ownergate door de reviewer-zelfreviewregel en
  // was goedkeuring dáárdoor structureel onmogelijk — de poort kon nooit dichtgaan én nooit open.
  // Owner-autorisatie is geen review, dus die regel geldt hier niet. Wél blijft gelden dat de
  // owner nooit een vendor vervangt: de twee vendor-GO's zijn er nog steeds bij nodig.
  const ownerIsBuilder = { ...NATIVE_CONTEXT, builder_actor: 'rvanhooijdonk-png' };
  const codex = extractCodexNativeEvidence(codexComment(), resolved(), NATIVE_POLICY);
  const gemini = extractGeminiNativeEvidence(geminiReview(), [], resolved(), NATIVE_POLICY);
  const r = evaluateShield({
    nativeEvidence: [codex, gemini], ownerApprovals: [ownerApprovalEnvelope()],
    sensitivePathsTouched: true, filesComplete: true,
    context: ownerIsBuilder, policy: NATIVE_POLICY,
  });
  assert.deepEqual(r, { decision: 'GO', reasons: [] });

  // Zonder de twee vendorronden blijft dezelfde ownergoedkeuring rood.
  const zonderVendors = evaluateShield({
    nativeEvidence: [], ownerApprovals: [ownerApprovalEnvelope()],
    sensitivePathsTouched: true, filesComplete: true,
    context: ownerIsBuilder, policy: NATIVE_POLICY,
  });
  assert.equal(zonderVendors.decision, 'NO_GO');
  assert.ok(zonderVendors.reasons.includes(REASON.INSUFFICIENT_GO));
  assert.ok(!zonderVendors.reasons.includes(REASON.OWNER_GATE_REQUIRED), 'de ownergate zelf is voldaan');
});

test('N4. spoofing: aanvaller-login met identieke succestekst levert geen bewijs op', () => {
  const spoofed = codexComment({ user: { login: 'aanvaller' }, performed_via_github_app: undefined });
  assert.equal(extractCodexNativeEvidence(spoofed, resolved(), NATIVE_POLICY), null);
});

test('N4b. spoofing: juiste login maar verkeerde GitHub-App-id => NATIVE_IDENTITY_UNVERIFIED', () => {
  const spoofed = codexComment({ performed_via_github_app: { id: 999999 } });
  const evidence = extractCodexNativeEvidence(spoofed, resolved(), NATIVE_POLICY);
  const bound = bindNativeEvidence(evidence, NATIVE_CONTEXT);
  assert.equal(bound.valid, false);
  assert.ok(bound.reasons.includes(REASON.NATIVE_IDENTITY_UNVERIFIED));
});

test('N5. op owner-autorisatie geldt GEEN builder-zelfreviewregel — dat is de hele scheiding', () => {
  // Regressie op de gemeten blokkade: de ownergate hergebruikte het reviewerreceipt, inclusief
  // `SELF_REVIEW`. Omdat PR-auteur en owner op deze repository dezelfde identiteit zijn, kon de
  // eigenaar zijn eigen gevoelige PR structureel niet autoriseren. De owner is geen reviewer.
  const ownerIsBuilder = { ...NATIVE_CONTEXT, builder_actor: 'rvanhooijdonk-png' };
  const r = evaluateOwnerApprovals([ownerApprovalEnvelope()], ownerIsBuilder, NATIVE_POLICY.owner_gate);
  assert.deepEqual(r, { decision: 'GO', reasons: [] });
  assert.ok(!r.reasons.includes(REASON.SELF_REVIEW));
});

test('N5a. een niet-allowlisted actor die zich als owner voordoet is ruis, geen redencode-injectie', () => {
  // Een willekeurige commenter mag geen redencodes kunnen injecteren: zijn blok wordt vóór elke
  // inhoudelijke toets als ruis verworpen. De uitslag blijft NO_GO, maar op OWNER_APPROVAL_MISSING.
  const spoof = ownerApprovalEnvelope({}, NATIVE_CONTEXT.builder_actor);
  const r = evaluateShield({
    nativeEvidence: [], ownerApprovals: [spoof], sensitivePathsTouched: true, filesComplete: true,
    context: NATIVE_CONTEXT, policy: NATIVE_POLICY,
  });
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.OWNER_APPROVAL_MISSING));
  assert.ok(!r.reasons.includes(REASON.SELF_REVIEW));
});

test('N5c. de owner kan nooit een ontbrekende vendor vervangen, ook niet met een geldig blok', () => {
  const r = evaluateShield({
    nativeEvidence: [extractGeminiNativeEvidence(geminiReview(), [], resolved(), NATIVE_POLICY)],
    ownerApprovals: [ownerApprovalEnvelope()], sensitivePathsTouched: true, filesComplete: true,
    context: NATIVE_CONTEXT, policy: NATIVE_POLICY,
  });
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.INSUFFICIENT_GO), 'Codex ontbreekt en blijft ontbreken');
});

test('N5b. self-review op native bewijs zelf (defensief, ook al is de bot nooit de bouwer)', () => {
  const evidence = extractCodexNativeEvidence(codexComment(), resolved(), NATIVE_POLICY);
  const ctx = { ...NATIVE_CONTEXT, builder_actor: 'chatgpt-codex-connector[bot]' };
  const bound = bindNativeEvidence(evidence, ctx);
  assert.equal(bound.valid, false);
  assert.ok(bound.reasons.includes(REASON.SELF_REVIEW));
});

test('N6. stale head: Codex-bewijs wijst naar een vorige head => STALE_HEAD', () => {
  const evidence = extractCodexNativeEvidence(codexComment(), resolved(NATIVE_OLD_HEAD), NATIVE_POLICY);
  const bound = bindNativeEvidence(evidence, NATIVE_CONTEXT);
  assert.equal(bound.valid, false);
  assert.ok(bound.reasons.includes(REASON.STALE_HEAD));
});

test('N6b. stale tree: Gemini-bewijs wijst naar een vorige tree => TREE_MISMATCH', () => {
  const evidence = extractGeminiNativeEvidence(geminiReview(), [], resolved(NATIVE_HEAD, NATIVE_OLD_TREE), NATIVE_POLICY);
  const bound = bindNativeEvidence(evidence, NATIVE_CONTEXT);
  assert.equal(bound.valid, false);
  assert.ok(bound.reasons.includes(REASON.TREE_MISMATCH));
});

test('N7. verkeerde/ontbrekende task-id op de PR => TASK_MISMATCH', () => {
  const codex = extractCodexNativeEvidence(codexComment(), resolved(), NATIVE_POLICY);
  const bound = bindNativeEvidence(codex, { ...NATIVE_CONTEXT, task_id: '' });
  assert.equal(bound.valid, false);
  assert.ok(bound.reasons.includes(REASON.TASK_MISMATCH));
});

test('N8. elk veld van de owner-autorisatie wordt tegen de gemeten waarheid gelegd', () => {
  const gate = NATIVE_POLICY.owner_gate;
  const geval = (overrides, actor) => evaluateOwnerApprovals(
    [ownerApprovalEnvelope(overrides, actor)], NATIVE_CONTEXT, gate,
  );
  assert.deepEqual(geval({}), { decision: 'GO', reasons: [] });

  assert.ok(geval({ decision: 'REJECT' }).reasons.includes(REASON.OWNER_APPROVAL_NOT_APPROVE));
  assert.ok(geval({ task_id: 'EEN_ANDERE_TAAK' }).reasons.includes(REASON.OWNER_APPROVAL_TASK_MISMATCH));
  assert.ok(geval({ tree_sha: NATIVE_OLD_TREE }).reasons.includes(REASON.OWNER_APPROVAL_TREE_MISMATCH));
  assert.ok(geval({ schema: 'IETS_ANDERS' }).reasons.includes(REASON.OWNER_APPROVAL_SCHEMA_MISMATCH));
  assert.ok(geval({ head_sha: 'kort' }).reasons.includes(REASON.BAD_SHA_FORMAT));
  // Een onbekend veld mag nooit securitysemantiek toevoegen of overschrijven.
  assert.ok(geval({ reviewer_actor: 'iemand' }).reasons.includes(REASON.OWNER_APPROVAL_UNKNOWN_FIELD));
  // Een geldige autorisatie van een auteur BUITEN de allowlist is ruis, geen goedkeuring.
  const buiten = geval({}, 'aanvaller');
  assert.equal(buiten.decision, 'NO_GO');
  assert.deepEqual(buiten.reasons, [REASON.OWNER_APPROVAL_MISSING]);
});

test('N8a. een owner-autorisatie voor een VORIGE head geldt nooit opnieuw', () => {
  const stale = evaluateOwnerApprovals(
    [ownerApprovalEnvelope({ head_sha: NATIVE_OLD_HEAD })], NATIVE_CONTEXT, NATIVE_POLICY.owner_gate,
  );
  assert.equal(stale.decision, 'NO_GO');
  assert.ok(stale.reasons.includes(REASON.OWNER_APPROVAL_STALE_HEAD));
  assert.ok(stale.reasons.includes(REASON.OWNER_APPROVAL_MISSING));
});

test('N8b. het owner-blok wordt letterlijk uit een machineblok gelezen, nooit uit proza', () => {
  assert.equal(extractOwnerApprovalFromBody('Wat mij betreft akkoord, APPROVE!'), null);
  assert.equal(extractOwnerApprovalFromBody('```autocoding-owner-approval-v1\n{kapot\n```'), null);
  const body = `Akkoord.\n\n\`\`\`autocoding-owner-approval-v1\n${JSON.stringify(ownerApproval())}\n\`\`\`\n`;
  assert.deepEqual(extractOwnerApprovalFromBody(body), ownerApproval());
});

test('N9. Gemini COMMENTED zonder terminal marker => NATIVE_TERMINAL_MARKER_MISSING', () => {
  const evidence = extractGeminiNativeEvidence(geminiReview({ body: 'Ziet er prima uit!' }), [], resolved(), NATIVE_POLICY);
  const bound = bindNativeEvidence(evidence, NATIVE_CONTEXT);
  assert.equal(bound.valid, false);
  assert.ok(bound.reasons.includes(REASON.NATIVE_TERMINAL_MARKER_MISSING));
});

test('N10. gewijzigde allowlist: wildcard-vendoractor in policy => UNSAFE_POLICY', () => {
  const tampered = {
    native_review: {
      required_vendors: ['codex', 'gemini'],
      codex: { actor: '*' },
      gemini: NATIVE_POLICY.native_review.gemini,
    },
  };
  assert.throws(() => assertNativeVendorsSafe(tampered));
  assert.deepEqual(
    evaluateNativeReview([], NATIVE_CONTEXT, tampered),
    { decision: 'NO_GO', reasons: [REASON.UNSAFE_POLICY] },
  );
});

test('N11. ontbrekende owner-autorisatie op een gevoelig pad => OWNER_GATE_REQUIRED', () => {
  const codex = extractCodexNativeEvidence(codexComment(), resolved(), NATIVE_POLICY);
  const gemini = extractGeminiNativeEvidence(geminiReview(), [], resolved(), NATIVE_POLICY);
  const r = evaluateShield({
    nativeEvidence: [codex, gemini], ownerApprovals: [], sensitivePathsTouched: true,
    filesComplete: true, context: NATIVE_CONTEXT, policy: NATIVE_POLICY,
  });
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.OWNER_GATE_REQUIRED));
  assert.ok(r.reasons.includes(REASON.OWNER_APPROVAL_MISSING));
});

test('N12. stale owner-autorisatie op een gevoelig pad => OWNER_GATE_REQUIRED + STALE', () => {
  const codex = extractCodexNativeEvidence(codexComment(), resolved(), NATIVE_POLICY);
  const gemini = extractGeminiNativeEvidence(geminiReview(), [], resolved(), NATIVE_POLICY);
  const staleOwner = ownerApprovalEnvelope({ head_sha: NATIVE_OLD_HEAD });
  const r = evaluateShield({
    nativeEvidence: [codex, gemini], ownerApprovals: [staleOwner], sensitivePathsTouched: true,
    filesComplete: true, context: NATIVE_CONTEXT, policy: NATIVE_POLICY,
  });
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.OWNER_GATE_REQUIRED));
  assert.ok(r.reasons.includes(REASON.OWNER_APPROVAL_STALE_HEAD));
});

test('N13. gespoofde owner-autorisatie (auteur buiten de allowlist) => OWNER_GATE_REQUIRED', () => {
  const codex = extractCodexNativeEvidence(codexComment(), resolved(), NATIVE_POLICY);
  const gemini = extractGeminiNativeEvidence(geminiReview(), [], resolved(), NATIVE_POLICY);
  const spoofedOwner = ownerApprovalEnvelope({}, 'aanvaller');
  const r = evaluateShield({
    nativeEvidence: [codex, gemini], ownerApprovals: [spoofedOwner], sensitivePathsTouched: true,
    filesComplete: true, context: NATIVE_CONTEXT, policy: NATIVE_POLICY,
  });
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.OWNER_GATE_REQUIRED));
  assert.ok(r.reasons.includes(REASON.OWNER_APPROVAL_MISSING));
});

test('N14. echte Gemini-bevindingsbadge blokkeert, ook bij state COMMENTED => NATIVE_FINDINGS_PRESENT', () => {
  const evidence = extractGeminiNativeEvidence(geminiReview(), [GEMINI_FINDING_COMMENT_BODY], resolved(), NATIVE_POLICY);
  const bound = bindNativeEvidence(evidence, NATIVE_CONTEXT);
  assert.equal(bound.valid, false);
  assert.ok(bound.reasons.includes(REASON.NATIVE_FINDINGS_PRESENT));
});

test('N15. Gemini CHANGES_REQUESTED/DISMISSED/PENDING levert geen actief bewijsstuk op', () => {
  for (const state of ['CHANGES_REQUESTED', 'DISMISSED', 'PENDING', 'ONBEKEND', '', undefined]) {
    const evidence = extractGeminiNativeEvidence(geminiReview({ state }), [], resolved(), NATIVE_POLICY);
    assert.equal(evidence, null, String(state));
  }
  // En zonder actief bewijs is er geen GO: de vendor mist gewoon zijn vereiste ronde.
  const codex = extractCodexNativeEvidence(codexComment(), resolved(), NATIVE_POLICY);
  const r = evaluateNativeReview([codex], NATIVE_CONTEXT, NATIVE_POLICY);
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.INSUFFICIENT_GO));
});

test('N16. Codex zonder canonieke succesvorm => NATIVE_TERMINAL_MARKER_MISSING, nooit impliciet GO', () => {
  // Gemeten vorm van een Codex-ronde MET bevindingen. Deze tekst is geen canonieke succesvorm, en
  // "geen inline-opmerking gezien" mag daarom nooit als GO gelden.
  const withFindings = codexComment({ body: 'Codex Review: 2 comment(s) generated.\n\n**Reviewed commit:** `b9df1f8398`\n' });
  const evidence = extractCodexNativeEvidence(withFindings, resolved(), NATIVE_POLICY);
  const bound = bindNativeEvidence(evidence, NATIVE_CONTEXT);
  assert.equal(bound.valid, false);
  assert.ok(bound.reasons.includes(REASON.NATIVE_TERMINAL_MARKER_MISSING));
});

test('N17. ontbrekend native bewijs => NO_RECEIPTS + INSUFFICIENT_GO, nooit impliciet GO', () => {
  const r = evaluateNativeReview([], NATIVE_CONTEXT, NATIVE_POLICY);
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.NO_RECEIPTS));
  assert.ok(r.reasons.includes(REASON.INSUFFICIENT_GO));
});

test('N18. slechts één van de twee vendors aanwezig => INSUFFICIENT_GO', () => {
  const codex = extractCodexNativeEvidence(codexComment(), resolved(), NATIVE_POLICY);
  const r = evaluateNativeReview([codex], NATIVE_CONTEXT, NATIVE_POLICY);
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.INSUFFICIENT_GO));
});

test('N19. policy.v1.json op de PR draagt de echte gemeten identiteiten en blijft live-gate uit', () => {
  const policy = JSON.parse(readFileSync('CONTROL/AUTOCODING/policy.v1.json', 'utf8'));
  assert.equal(policy.live_receipt_gate_enabled, false);
  assert.equal(policy.native_review.codex.actor, 'chatgpt-codex-connector[bot]');
  assert.equal(policy.native_review.codex.app_id, 1144995);
  assert.equal(policy.native_review.gemini.actor, 'gemini-code-assist[bot]');
  assert.deepEqual(policy.native_review.required_vendors, ['codex', 'gemini']);
  assert.doesNotThrow(() => assertNativeVendorsSafe(policy));

  // Het prefixcontract van de echte policy: de gevoelige bereiken blijven exact, de sleutel heet
  // `sensitive_path_prefixes` (nooit meer `..._globs`), en de ownerreviewstates zijn actief.
  assert.doesNotThrow(() => assertOwnerGateSafe(policy));
  assert.deepEqual(policy.owner_gate.sensitive_path_prefixes,
    ['.github/workflows/', 'CONTROL/AUTOCODING/']);
  assert.ok(!('sensitive_path_globs' in policy.owner_gate));
  assert.deepEqual(policy.owner_gate.allowed_review_states, ['COMMENTED']);
});

test('N20. afgeronde reviewronde van een vorige head blokkeert een schone actuele head niet', () => {
  const staleCodex = extractCodexNativeEvidence(codexComment(), resolved(NATIVE_OLD_HEAD, NATIVE_OLD_TREE), NATIVE_POLICY);
  const codex = extractCodexNativeEvidence(codexComment(), resolved(), NATIVE_POLICY);
  const gemini = extractGeminiNativeEvidence(geminiReview(), [], resolved(), NATIVE_POLICY);
  const r = evaluateNativeReview([staleCodex, codex, gemini], NATIVE_CONTEXT, NATIVE_POLICY);
  assert.deepEqual(r, { decision: 'GO', reasons: [] });
});

test('N21. uitsluitend bewijs van een vorige head => NO_RECEIPTS + STALE_HEAD, nooit GO', () => {
  const staleCodex = extractCodexNativeEvidence(codexComment(), resolved(NATIVE_OLD_HEAD, NATIVE_OLD_TREE), NATIVE_POLICY);
  const staleGemini = extractGeminiNativeEvidence(geminiReview(), [], resolved(NATIVE_OLD_HEAD, NATIVE_OLD_TREE), NATIVE_POLICY);
  const r = evaluateNativeReview([staleCodex, staleGemini], NATIVE_CONTEXT, NATIVE_POLICY);
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.NO_RECEIPTS));
  assert.ok(r.reasons.includes(REASON.STALE_HEAD));
  assert.ok(r.reasons.includes(REASON.INSUFFICIENT_GO));
});

test('N22. onresolveerbaar bewijs van een gepinde bot blijft staan en faalt gesloten', () => {
  // Geen resolutie (lege SHA) is iets anders dan "stale": het wordt NIET weggefilterd, want een
  // gepinde bot die naar een onbekende commit wijst is een anomalie, geen afgesloten ronde.
  const unresolved = extractCodexNativeEvidence(codexComment(), null, NATIVE_POLICY);
  const gemini = extractGeminiNativeEvidence(geminiReview(), [], resolved(), NATIVE_POLICY);
  const r = evaluateNativeReview([unresolved, gemini], NATIVE_CONTEXT, NATIVE_POLICY);
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.STALE_HEAD));
  assert.ok(r.reasons.includes(REASON.INSUFFICIENT_GO));
});

test('N23. de owner telt nooit als reviewvendor: een owner-autorisatie vervangt Codex of Gemini niet', () => {
  // Het owner-schema kent geen vendorveld: wie er een probeert bij te schrijven, maakt het blok
  // ongeldig in plaats van zichzelf tot leverancier te promoveren.
  const asVendor = ownerApprovalEnvelope({ reviewer_vendor: 'codex' });
  const withVendor = evaluateShield({
    nativeEvidence: [], ownerApprovals: [asVendor], sensitivePathsTouched: true,
    filesComplete: true, context: NATIVE_CONTEXT, policy: NATIVE_POLICY,
  });
  assert.equal(withVendor.decision, 'NO_GO');
  assert.ok(withVendor.reasons.includes(REASON.OWNER_APPROVAL_UNKNOWN_FIELD));

  // En zelfs een volledig geldige owner-autorisatie laat het native pad onaangeroerd leeg.
  const valid = evaluateShield({
    nativeEvidence: [], ownerApprovals: [ownerApprovalEnvelope()], sensitivePathsTouched: true,
    filesComplete: true, context: NATIVE_CONTEXT, policy: NATIVE_POLICY,
  });
  assert.equal(valid.decision, 'NO_GO');
  assert.ok(valid.reasons.includes(REASON.INSUFFICIENT_GO));
  assert.ok(valid.reasons.includes(REASON.NO_RECEIPTS));
  assert.ok(!valid.reasons.includes(REASON.OWNER_GATE_REQUIRED), 'de ownerpoort zelf is wél voldaan');
});

test('N24. policy waarin owner en reviewvendor elkaar kunnen vervangen => UNSAFE_POLICY', () => {
  const ownerAsVendor = {
    native_review: {
      required_vendors: ['codex', 'owner'],
      codex: NATIVE_POLICY.native_review.codex,
      owner: { actor: 'rvanhooijdonk-png' },
    },
    owner_gate: NATIVE_POLICY.owner_gate,
  };
  assert.throws(() => assertNativeVendorsSafe(ownerAsVendor));

  const sharedActor = {
    native_review: {
      required_vendors: ['codex', 'gemini'],
      codex: { ...NATIVE_POLICY.native_review.codex, actor: 'rvanhooijdonk-png' },
      gemini: NATIVE_POLICY.native_review.gemini,
    },
    owner_gate: NATIVE_POLICY.owner_gate,
  };
  assert.throws(() => assertNativeVendorsSafe(sharedActor));

  const duplicateVendor = {
    native_review: {
      required_vendors: ['codex', 'codex'],
      codex: NATIVE_POLICY.native_review.codex,
    },
    owner_gate: NATIVE_POLICY.owner_gate,
  };
  assert.throws(() => assertNativeVendorsSafe(duplicateVendor));
});

test('N25. proza zonder machineblok levert geen enkel bewijsstuk op', () => {
  const prose = {
    user: { login: 'rvanhooijdonk-png', type: 'User' },
    body: 'Ziet er goed uit, wat mij betreft GO. verdict: GO, head_sha klopt.',
  };
  assert.equal(extractReceiptFromCommentBody(prose.body), null);
  assert.equal(extractCodexNativeEvidence(prose, resolved(), NATIVE_POLICY), null);
  assert.equal(extractGeminiNativeEvidence({ ...prose, state: 'APPROVED' }, [], resolved(), NATIVE_POLICY), null);
});

test('N26. de CLI beslist de shield-route fail-closed en logt geen bewijsinhoud', () => {
  const dir = mkdtempSync(join(tmpdir(), 'autocoding-shield-cli-'));
  const paths = ['shield-input.json', 'context.json', 'policy.json'].map((name) => join(dir, name));
  writeFileSync(paths[0], JSON.stringify({
    nativeEvidence: [], ownerReceipts: [], sensitivePathsTouched: true,
  }));
  writeFileSync(paths[1], JSON.stringify(NATIVE_CONTEXT));
  writeFileSync(paths[2], JSON.stringify(NATIVE_POLICY));
  const cli = spawnSync(process.execPath, [
    'scripts/autocoding/verify-review-gate.mjs', '--shield-input', paths[0], '--context', paths[1],
    '--policy', paths[2],
  ], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.equal(cli.stderr, '');
  const out = JSON.parse(cli.stdout);
  assert.equal(out.decision, 'NO_GO');
  assert.ok(out.reasons.includes(REASON.OWNER_GATE_REQUIRED));
  assert.ok(!cli.stdout.includes(NATIVE_CONTEXT.builder_actor), 'geen actornamen in de uitvoer');
});

test('N27. de shield-CLI faalt gesloten op een onveilige policy in plaats van fail-open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'autocoding-shield-cli-'));
  const paths = ['shield-input.json', 'context.json', 'policy.json'].map((name) => join(dir, name));
  writeFileSync(paths[0], JSON.stringify({ nativeEvidence: [], ownerReceipts: [] }));
  writeFileSync(paths[1], JSON.stringify(NATIVE_CONTEXT));
  writeFileSync(paths[2], JSON.stringify({ native_review: { required_vendors: [] } }));
  const cli = spawnSync(process.execPath, [
    'scripts/autocoding/verify-review-gate.mjs', '--shield-input', paths[0], '--context', paths[1],
    '--policy', paths[2],
  ], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.deepEqual(JSON.parse(cli.stdout), { decision: 'NO_GO', reasons: [REASON.UNSAFE_POLICY] });
});

test('N28. een DISMISSED owner-review telt nooit meer, ook al blijft het blok in het lichaam staan', () => {
  // Gemeten mechanisme: wie een review intrekt, laat het lichaam ongewijzigd staan; GitHub zet
  // alleen `state` op DISMISSED. Zonder statefilter bleef die ingetrokken autorisatie de
  // gevoelige-padpoort dus groen houden.
  const codex = extractCodexNativeEvidence(codexComment(), resolved(), NATIVE_POLICY);
  const gemini = extractGeminiNativeEvidence(geminiReview(), [], resolved(), NATIVE_POLICY);
  const dismissed = ownerApprovalReview('DISMISSED');

  const single = evaluateOwnerApprovals([dismissed], NATIVE_CONTEXT, NATIVE_POLICY.owner_gate);
  assert.equal(single.decision, 'NO_GO');
  assert.ok(single.reasons.includes(REASON.OWNER_APPROVAL_CARRIER_NOT_ACTIVE));

  const shield = evaluateShield({
    nativeEvidence: [codex, gemini], ownerApprovals: [dismissed], sensitivePathsTouched: true,
    filesComplete: true, context: NATIVE_CONTEXT, policy: NATIVE_POLICY,
  });
  assert.equal(shield.decision, 'NO_GO');
  assert.ok(shield.reasons.includes(REASON.OWNER_GATE_REQUIRED));
  assert.ok(shield.reasons.includes(REASON.OWNER_APPROVAL_CARRIER_NOT_ACTIVE));

  // Exact hetzelfde blok in een ACTIEVE reviewstate is wél geldig — de dismissal is het verschil.
  assert.deepEqual(
    evaluateOwnerApprovals([ownerApprovalReview('COMMENTED')], NATIVE_CONTEXT, NATIVE_POLICY.owner_gate),
    { decision: 'GO', reasons: [] },
  );

  // En ander, actueel geldig ownerbewijs op dezelfde momentopname blijft gewoon tellen.
  const metIssueComment = evaluateShield({
    nativeEvidence: [codex, gemini], ownerApprovals: [dismissed, ownerApprovalEnvelope()],
    sensitivePathsTouched: true, filesComplete: true, context: NATIVE_CONTEXT, policy: NATIVE_POLICY,
  });
  assert.deepEqual(metIssueComment, { decision: 'GO', reasons: [] });
});

test('N28a. geen enkele niet-actieve of onbekende dragerstaat levert ownerbewijs op', () => {
  const gate = NATIVE_POLICY.owner_gate;
  for (const state of ['DISMISSED', 'CHANGES_REQUESTED', 'PENDING', 'APPROVED', 'commented', 'ONBEKEND', '']) {
    const r = evaluateOwnerApprovals([ownerApprovalReview(state)], NATIVE_CONTEXT, gate);
    assert.equal(r.decision, 'NO_GO', state);
    assert.ok(r.reasons.includes(REASON.OWNER_APPROVAL_CARRIER_NOT_ACTIVE), state);
  }
  // Ontbrekende state op een review, en een drager zonder herkenbare herkomst: allebei fail-closed.
  for (const carrier of [
    { source: 'review' },
    { source: 'review', review_state: null },
    { source: 'onbekend', review_state: 'COMMENTED' },
    {},
  ]) {
    const envelope = { approval: ownerApproval(), transport_actor: 'rvanhooijdonk-png', ...carrier };
    const r = evaluateOwnerApprovals([envelope], NATIVE_CONTEXT, gate);
    assert.equal(r.decision, 'NO_GO', JSON.stringify(carrier));
    assert.ok(r.reasons.includes(REASON.OWNER_APPROVAL_CARRIER_NOT_ACTIVE), JSON.stringify(carrier));
  }
  // Een issuecomment kent geen state en blijft de eigen, ongewijzigde route.
  assert.deepEqual(
    evaluateOwnerApprovals([ownerApprovalEnvelope()], NATIVE_CONTEXT, gate),
    { decision: 'GO', reasons: [] },
  );
});

test('N28b. een ownergate zonder of met een niet-actieve reviewstate-allowlist => UNSAFE_POLICY', () => {
  const gate = NATIVE_POLICY.owner_gate;
  for (const states of [undefined, [], ['DISMISSED'], ['COMMENTED', 'DISMISSED'], ['*'], [''], 'COMMENTED']) {
    const policy = { ...NATIVE_POLICY, owner_gate: { ...gate, allowed_review_states: states } };
    assert.throws(() => assertOwnerGateSafe(policy), JSON.stringify(states ?? null));
    assert.deepEqual(
      evaluateShield({
        nativeEvidence: [], ownerApprovals: [], sensitivePathsTouched: false, filesComplete: true,
        context: NATIVE_CONTEXT, policy,
      }),
      { decision: 'NO_GO', reasons: [REASON.UNSAFE_POLICY] },
    );
  }
});

test('N29. de OUDE sleutel `sensitive_path_globs` maakt de policy UNSAFE_POLICY, nooit ownergate-vrij', () => {
  // De implementatie matcht letterlijke prefixen. De oude sleutelnaam beloofde glob-semantiek die
  // er nooit was; hem stilzwijgend blijven accepteren zou precies de misleiding bestendigen.
  const { sensitive_path_prefixes: prefixes, ...rest } = NATIVE_POLICY.owner_gate;
  for (const gate of [
    { ...rest, sensitive_path_globs: prefixes },
    { ...NATIVE_POLICY.owner_gate, sensitive_path_globs: prefixes },
    { ...NATIVE_POLICY.owner_gate, een_onbekende_sleutel: true },
  ]) {
    const policy = { ...NATIVE_POLICY, owner_gate: gate };
    assert.throws(() => assertOwnerGateSafe(policy));
    // Ook op een niet-gevoelige PR met verder volledig bewijs: fail-closed, nooit fail-open.
    const codex = extractCodexNativeEvidence(codexComment(), resolved(), NATIVE_POLICY);
    const gemini = extractGeminiNativeEvidence(geminiReview(), [], resolved(), NATIVE_POLICY);
    assert.deepEqual(
      evaluateShield({
        nativeEvidence: [codex, gemini], ownerApprovals: [ownerApprovalEnvelope()],
        sensitivePathsTouched: false, filesComplete: true, context: NATIVE_CONTEXT, policy,
      }),
      { decision: 'NO_GO', reasons: [REASON.UNSAFE_POLICY] },
    );
  }
});

test('N29a. een prefix met globmeta, wildcard, traversal of absoluut pad => UNSAFE_POLICY', () => {
  for (const prefix of [
    '*', '**', '.github/workflows/**', '.github/workflows/*.yml', 'CONTROL/{AUTOCODING,X}/',
    'CONTROL/AUTOCODING/?', 'CONTROL/AUTOCODING/[a-z]', '!CONTROL/', '/etc/passwd', '../secrets/',
    'CONTROL/../../etc/', './CONTROL/', 'CONTROL//AUTOCODING/', 'CONTROL\\AUTOCODING\\', '', '.', 42, null,
  ]) {
    assert.equal(isSafeSensitivePrefix(prefix), false, String(prefix));
    const policy = {
      ...NATIVE_POLICY,
      owner_gate: { ...NATIVE_POLICY.owner_gate, sensitive_path_prefixes: ['.github/workflows/', prefix] },
    };
    assert.throws(() => assertOwnerGateSafe(policy), String(prefix));
    assert.deepEqual(
      evaluateShield({
        nativeEvidence: [], ownerApprovals: [], sensitivePathsTouched: true, filesComplete: true,
        context: NATIVE_CONTEXT, policy,
      }),
      { decision: 'NO_GO', reasons: [REASON.UNSAFE_POLICY] },
    );
  }
  // De twee gevoelige bereiken van deze repository blijven exact geldig, met en zonder submap.
  for (const prefix of ['.github/workflows/', 'CONTROL/AUTOCODING/', 'CONTROL/AUTOCODING/sub/x.json']) {
    assert.equal(isSafeSensitivePrefix(prefix), true, prefix);
  }
  // Een lege lijst is nooit "niets is gevoelig".
  assert.throws(() => assertOwnerGateSafe({
    ...NATIVE_POLICY, owner_gate: { ...NATIVE_POLICY.owner_gate, sensitive_path_prefixes: [] },
  }));
});

// --- Native reviewbewijs (chatgpt-codex-connector[bot] / gemini-code-assist[bot]) ------------------
//
// De fixtures hieronder zijn LETTERLIJK opgehaald uit deze repository's eigen GitHub-geschiedenis
// (PR #72, comment 5376132338, GitHub App 1144995; PR #73, review 4997642205 en zijn eerste
// bevindingsregel) — geen verzonnen tekst. Alleen de SHA's zijn herschreven naar de teststandaard
// HEAD/TREE hieronder; het commit-prefix in de Codex-body blijft de echte "b9df1f8398".

const NATIVE_HEAD = `b9df1f8398${'a'.repeat(30)}`;
const NATIVE_OLD_HEAD = 'f'.repeat(40);
const NATIVE_TREE = 'e'.repeat(40);
const NATIVE_OLD_TREE = 'd'.repeat(40);

const NATIVE_CONTEXT = Object.freeze({
  pr_head_sha: NATIVE_HEAD,
  pr_tree_sha: NATIVE_TREE,
  builder_actor: 'claude2-cloud',
  task_id: 'AUTOCODING_LIVE_GATE_COMPLETION_V1',
});

// De numerieke bot-ID's zijn gemeten op PR #74 (reviews 4998216880 en 4998213986): Codex
// 199175422, Gemini 176961590. Een login is hernoembaar, een user-ID niet.
const CODEX_USER_ID = 199175422;
const GEMINI_USER_ID = 176961590;

const NATIVE_POLICY = Object.freeze({
  native_review: Object.freeze({
    required_vendors: Object.freeze(['codex', 'gemini']),
    codex: Object.freeze({
      actor: 'chatgpt-codex-connector[bot]',
      user_id: CODEX_USER_ID,
      user_type: 'Bot',
      app_id: 1144995,
      allowed_states: Object.freeze(['COMMENTED']),
      terminal_success_markers: Object.freeze(["Codex Review: Didn't find any major issues. :tada:"]),
    }),
    gemini: Object.freeze({
      actor: 'gemini-code-assist[bot]',
      user_id: GEMINI_USER_ID,
      user_type: 'Bot',
      allowed_states: Object.freeze(['COMMENTED', 'APPROVED']),
      terminal_success_markers: Object.freeze(['## Code Review']),
    }),
  }),
  owner_gate: Object.freeze({
    schema: 'AUTOCODING_OWNER_APPROVAL_V1',
    sensitive_path_prefixes: Object.freeze(['.github/workflows/', 'CONTROL/AUTOCODING/']),
    allowed_review_states: Object.freeze(['COMMENTED']),
    allowed_owner_actors: Object.freeze(['rvanhooijdonk-png']),
  }),
});

function resolved(headSha = NATIVE_HEAD, treeSha = NATIVE_TREE) {
  return { head_sha: headSha, tree_sha: treeSha };
}

// Letterlijk PR #72, comment 5376132338 (chatgpt-codex-connector[bot], GitHub App 1144995).
const CODEX_SUCCESS_COMMENT = Object.freeze({
  user: Object.freeze({ login: 'chatgpt-codex-connector[bot]', id: CODEX_USER_ID, type: 'Bot' }),
  performed_via_github_app: Object.freeze({ id: 1144995 }),
  body: 'Codex Review: Didn\'t find any major issues. :tada:\n\n**Reviewed commit:** `b9df1f8398`\n\n'
    + '<details> <summary>ℹ️ About Codex in GitHub</summary>\n<br/>\n\n'
    + '[Your team has set up Codex to review pull requests in this repo]'
    + '(https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you\n'
    + '- Open a pull request for review\n- Mark a draft as ready\n- Comment "@codex review".\n\n'
    + 'If Codex has suggestions, it will comment; otherwise it will react with 👍.\n\n\n\n'
    + 'Codex can also answer questions or update the PR. Try commenting "@codex address that feedback".'
    + '\n            \n</details>',
});

function codexComment(overrides = {}) {
  return {
    ...CODEX_SUCCESS_COMMENT,
    ...overrides,
    user: { ...CODEX_SUCCESS_COMMENT.user, ...(overrides.user ?? {}) },
  };
}

// Zelfde structuurmarker als in PR #73's vier echte Gemini-reviews ("## Code Review\n\n...").
function geminiReview(overrides = {}) {
  return {
    user: { login: 'gemini-code-assist[bot]', id: GEMINI_USER_ID, type: 'Bot' },
    state: 'COMMENTED',
    commit_id: NATIVE_HEAD,
    body: '## Code Review\n\nDeze PR is representatief schoon: geen openstaande bevindingen.',
    ...overrides,
  };
}

// Letterlijke eerste bevindingsregel uit PR #73, review 4997642205.
const GEMINI_FINDING_COMMENT_BODY = '![security-critical](https://www.gstatic.com/codereviewagent/security-critical.svg) '
  + '![critical](https://www.gstatic.com/codereviewagent/critical.svg)\n\n'
  + '### Critical Security Vulnerability: Denial of Service (DoS) via Raw Duplicate Checks';

function ownerApproval(overrides = {}) {
  return {
    schema: OWNER_APPROVAL_SCHEMA,
    task_id: NATIVE_CONTEXT.task_id,
    head_sha: NATIVE_HEAD,
    tree_sha: NATIVE_TREE,
    decision: 'APPROVE',
    ...overrides,
  };
}

// Het blok draagt zelf GEEN actorveld: de dragende auteur komt uitsluitend uit de GitHub-API.
// De DRAGER hoort er wél bij: een issuecomment kent geen state, een review wel, en die state
// verandert na een dismiss zonder dat het lichaam meebeweegt.
function ownerApprovalEnvelope(overrides = {}, transport_actor = 'rvanhooijdonk-png', carrier = {}) {
  return {
    approval: ownerApproval(overrides),
    transport_actor,
    source: 'issue_comment',
    review_state: null,
    ...carrier,
  };
}

/** Dezelfde autorisatie, maar gedragen door een pull-request-review met een expliciete state. */
function ownerApprovalReview(state, overrides = {}, transport_actor = 'rvanhooijdonk-png') {
  return ownerApprovalEnvelope(overrides, transport_actor, { source: 'review', review_state: state });
}


// --- Ingetrokken reviewbewijs (Codex-reviewroute) -------------------------------------------------
//
// Codex P2, inline 3834611209. Een dismissed Codex-review met inline bevindingen bleef als HUIDIG
// NO_GO-bewijs meetellen: GitHub laat lichaam én inline comments letterlijk staan en zet alleen
// `state` op `DISMISSED`. De reden `NATIVE_FINDINGS_PRESENT` bleef daardoor voor altijd in de
// actuele bewijsset hangen, zodat geen enkele latere schone ronde de PR nog groen kon krijgen.

test('N30. een DISMISSED Codex-review levert geen enkel bewijsstuk op, ook niet met inline bevindingen', () => {
  const dismissed = extractCodexReviewEvidence(
    codexReview({ state: 'DISMISSED' }), ['P1: kapotte grens'], resolved(), NATIVE_POLICY,
  );
  assert.equal(dismissed, null);
});

test('N30a. geen enkele niet-actieve of onbekende reviewstate levert Codex-reviewbewijs op', () => {
  for (const state of ['DISMISSED', 'PENDING', 'CHANGES_REQUESTED', 'APPROVED', 'ONBEKEND', '', null, undefined]) {
    const evidence = extractCodexReviewEvidence(
      codexReview({ state }), [], resolved(), NATIVE_POLICY,
    );
    assert.equal(evidence, null, String(state));
  }
  // Alleen de werkelijk door de bot gebruikte, allowlisted actieve state telt.
  assert.notEqual(extractCodexReviewEvidence(codexReview(), [], resolved(), NATIVE_POLICY), null);
});

test('N30b. dismissal haalt het bewijs uit de selectie: een nieuwe schone ronde telt daarna normaal', () => {
  const gemini = extractGeminiNativeEvidence(geminiReview(), [], resolved(), NATIVE_POLICY);

  // Vóór de reparatie bleef de ingetrokken ronde als NO_GO-bewijs staan; nu verdwijnt hij.
  const dismissed = extractCodexReviewEvidence(
    codexReview({ state: 'DISMISSED' }), ['P1: kapotte grens'], resolved(), NATIVE_POLICY,
  );
  assert.equal(dismissed, null);

  // Uitsluitend de dismissal levert géén GO op — er is dan simpelweg geen Codex-ronde.
  const zonderCodex = evaluateNativeReview([dismissed, gemini], NATIVE_CONTEXT, NATIVE_POLICY);
  assert.equal(zonderCodex.decision, 'NO_GO');
  assert.ok(zonderCodex.reasons.includes(REASON.INSUFFICIENT_GO));

  // En daarna telt een nieuwe, actuele, schone Codex-ronde gewoon weer mee.
  const verse = extractCodexNativeEvidence(codexComment(), resolved(), NATIVE_POLICY);
  const daarna = evaluateNativeReview([dismissed, verse, gemini], NATIVE_CONTEXT, NATIVE_POLICY);
  assert.deepEqual(daarna, { decision: 'GO', reasons: [] });
});

test('N30c. een ACTIEVE Codex-review met inline bevindingen blijft gewoon blokkeren', () => {
  const evidence = extractCodexReviewEvidence(
    codexReview(), ['P1: kapotte grens'], resolved(), NATIVE_POLICY,
  );
  const bound = bindNativeEvidence(evidence, NATIVE_CONTEXT);
  assert.equal(bound.valid, false);
  assert.ok(bound.reasons.includes(REASON.NATIVE_FINDINGS_PRESENT));
});

test('N30d. een vendorpolicy zonder of met een niet-actieve statelijst => UNSAFE_POLICY', () => {
  const withCodexStates = (allowed_states) => ({
    ...NATIVE_POLICY,
    native_review: {
      ...NATIVE_POLICY.native_review,
      codex: { ...NATIVE_POLICY.native_review.codex, allowed_states },
    },
  });
  for (const allowed of [undefined, [], ['DISMISSED'], ['COMMENTED', 'DISMISSED'], ['PENDING'], ['*']]) {
    assert.throws(() => assertNativeVendorsSafe(withCodexStates(allowed)), /UNSAFE_POLICY/, String(allowed));
    const r = evaluateNativeReview([], NATIVE_CONTEXT, withCodexStates(allowed));
    assert.deepEqual(r, { decision: 'NO_GO', reasons: [REASON.UNSAFE_POLICY] });
  }
  assert.doesNotThrow(() => assertNativeVendorsSafe(withCodexStates(['COMMENTED', 'APPROVED'])));
});

/**
 * De gemeten vorm van een Codex-PULL-REQUEST-REVIEW (PR #74, review 4998216880). Een reviewobject
 * draagt géén `performed_via_github_app`, wél een `state` en een `commit_id`.
 */
function codexReview(overrides = {}) {
  return {
    user: { login: 'chatgpt-codex-connector[bot]', id: CODEX_USER_ID, type: 'Bot' },
    state: 'COMMENTED',
    commit_id: NATIVE_HEAD,
    body: "Codex Review: Didn't find any major issues. :tada:",
    ...overrides,
  };
}

/**
 * N31. De CLI-argumentgrens. Gemeten defect: de oude paarlezing (`i += 2`) las elke oneven positie
 * als sleutel, dus één extra of ontbrekend token verschoof alle volgende bindingen STIL. Deze test
 * gebruikt bewust een receiptset die met correcte argv GO oplevert: alleen zo bewijst een rc 1 dat
 * de WEIGERING de uitkomst droeg en niet de inhoud.
 */
test('N31. onleesbare argv eindigt nonzero en levert nooit een GO', () => {
  const dir = mkdtempSync(join(tmpdir(), 'autocoding-argv-'));
  const receipts = join(dir, 'receipts.json');
  const context = join(dir, 'context.json');
  const policy = join(dir, 'policy.json');
  const shieldInput = join(dir, 'shield-input.json');
  writeFileSync(receipts, JSON.stringify([signed(goCodex()), signed(goGemini())]));
  writeFileSync(context, JSON.stringify(CONTEXT));
  writeFileSync(policy, JSON.stringify(POLICY));
  writeFileSync(shieldInput, JSON.stringify({ nativeEvidence: [], ownerApprovals: [] }));

  const run = (argv) => spawnSync(process.execPath, [
    'scripts/autocoding/verify-review-gate.mjs', ...argv,
  ], { encoding: 'utf8' });

  const goed = ['--receipts', receipts, '--context', context, '--policy', policy];
  const groen = run(goed);
  assert.equal(groen.status, 0, groen.stdout + groen.stderr);
  assert.deepEqual(JSON.parse(groen.stdout), { decision: 'GO', reasons: [] });

  const kwaad = {
    'onbekende optie': [...goed, '--onbekend', 'x'],
    'onbekend los token': [...goed, 'x'],
    'dubbele optie': [...goed, '--policy', policy],
    'ontbrekende waarde': [...goed, '--shield-input'],
    'oneven argv': ['--receipts', receipts, '--context', context, '--policy'],
    'optie als waarde': ['--receipts', '--context', '--context', context, '--policy', policy],
    'lege waarde': ['--receipts', '', '--context', context, '--policy', policy],
    'ontbrekende context': ['--receipts', receipts, '--policy', policy],
    'ontbrekende policy': ['--receipts', receipts, '--context', context],
    'geen bron': ['--context', context, '--policy', policy],
    'beide bronnen': [...goed, '--shield-input', shieldInput],
  };
  for (const [naam, argv] of Object.entries(kwaad)) {
    const cli = run(argv);
    assert.equal(cli.status, 1, `${naam} moet nonzero eindigen`);
    assert.equal(cli.stderr, '', naam);
    assert.deepEqual(
      JSON.parse(cli.stdout), { decision: 'NO_GO', reasons: [REASON.PARSE_ERROR] }, naam,
    );
  }
});

test('N32. parseVerifyArgs weigert per vorm en houdt de bronkeuze exclusief', () => {
  assert.deepEqual(
    [...VERIFY_VALUE_OPTIONS].sort(),
    ['--context', '--policy', '--receipts', '--shield-input'],
    'de toegestane verzameling is gesloten en expliciet',
  );
  const goed = ['--receipts', 'r.json', '--context', 'c.json', '--policy', 'p.json'];
  assert.equal(parseVerifyArgs(goed).ok, true);
  assert.equal(parseVerifyArgs(['--shield-input', 's.json', '--context', 'c.json', '--policy', 'p.json']).ok, true);
  assert.equal(parseVerifyArgs([...goed, '--onbekend', 'x']).ok, false, 'onbekende optie');
  assert.equal(parseVerifyArgs([...goed, '--policy', 'p2.json']).ok, false, 'dubbele optie');
  assert.equal(parseVerifyArgs([...goed, '--shield-input']).ok, false, 'ontbrekende waarde');
  assert.equal(parseVerifyArgs(goed.slice(0, 5)).ok, false, 'oneven argv');
  assert.equal(parseVerifyArgs(['--receipts', '--context', '--context', 'c.json', '--policy', 'p.json']).ok, false);
  assert.equal(parseVerifyArgs(['--receipts', '', '--context', 'c.json', '--policy', 'p.json']).ok, false);
  assert.equal(parseVerifyArgs([...goed, '--shield-input', 's.json']).ok, false, 'twee bronnen');
  assert.equal(parseVerifyArgs(['--context', 'c.json', '--policy', 'p.json']).ok, false, 'geen bron');
  assert.equal(parseVerifyArgs([]).ok, false);
  assert.equal(parseVerifyArgs(null).ok, false);
  // De positieverschuiving zelf: een los token vóór de rest mag niets stil hernoemen.
  assert.equal(parseVerifyArgs(['--dry-run', ...goed]).ok, false, 'geen vlaggen op deze grens');
});
