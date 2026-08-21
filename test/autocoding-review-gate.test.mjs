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
  extractCodexNativeEvidence, extractGeminiNativeEvidence, bindNativeEvidence,
  assertNativeVendorsSafe, evaluateNativeReview, evaluateShield,
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

test('workflow-eventmatrix houdt bootstrap-events groen en live gate uit', () => {
  const workflow = readFileSync('.github/workflows/autocoding-shield.yml', 'utf8');
  const policy = JSON.parse(readFileSync('CONTROL/AUTOCODING/policy.v1.json', 'utf8'));
  for (const event of ['pull_request:', 'issue_comment:', 'pull_request_review:']) {
    assert.ok(workflow.includes(event), `event ontbreekt: ${event}`);
  }
  assert.match(workflow, /BOOTSTRAP_TRUSTED_GATE_FILES_NOT_ON_DEFAULT_BRANCH/);
  assert.match(workflow, /BOOTSTRAP_RECEIPT_GATE_DISABLED/);
  assert.match(workflow, /Live receiptpoort\n\s+if: steps\.bootstrap\.outputs\.trusted_gate_files == 'true'/);
  assert.equal(policy.live_receipt_gate_enabled, false);
});

test('W1. de stabiele checknaam draait alleen op pull_request; comment/review-events kunnen hem niet groen maken', () => {
  const workflow = readFileSync('.github/workflows/autocoding-shield.yml', 'utf8');
  // De job `autocoding-shield` is de stabiele checknaam. Zijn enige toegangsvoorwaarde moet het
  // pull_request-event zijn: anders zou een issue_comment onder diezelfde naam succes schrijven.
  assert.match(workflow, /^ {2}autocoding-shield:\n {4}if: github\.event_name == 'pull_request'$/m);
  // De live poort draait onder een EIGEN, andere jobnaam.
  assert.match(workflow, /^ {2}autocoding-shield-live-gate:$/m);

  // De job die PR-headcode uitvoert leest zelf niets uit de GitHub-API en krijgt daar ook geen
  // rechten voor: alleen `contents: read` om de head te kunnen uitchecken.
  const start = workflow.indexOf('\n  autocoding-shield:');
  const headJob = workflow.slice(start, workflow.indexOf('\n  autocoding-shield-live-gate:'));
  assert.ok(headJob.length > 0);
  assert.ok(!headJob.includes('gh api'), 'de PR-head-job mag de API niet bevragen');
  assert.ok(!headJob.includes('pull-requests: read'), 'de PR-head-job heeft die scope niet nodig');
  assert.ok(!headJob.includes('issues: read'), 'de PR-head-job heeft die scope niet nodig');
  assert.ok(!headJob.includes('GH_TOKEN'), 'de PR-head-job krijgt geen token');
});

test('W2. de live poort voert nooit PR-headcode uit en checkt uitsluitend de default branch uit', () => {
  const workflow = readFileSync('.github/workflows/autocoding-shield.yml', 'utf8');
  const liveGate = workflow.slice(workflow.indexOf('\n  autocoding-shield-live-gate:'));
  assert.ok(liveGate.length > 0);
  assert.match(liveGate, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.ok(
    !/ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/.test(liveGate),
    'de live-gate-job mag de PR-head niet uitchecken',
  );
  assert.ok(!liveGate.includes('node --test'), 'de live-gate-job mag geen PR-headtests draaien');
});

test('W3. geen pull_request_target, geen schrijfrechten, geen secrets in de shieldworkflow', () => {
  const workflow = readFileSync('.github/workflows/autocoding-shield.yml', 'utf8');
  // Toelichtende commentaarregels mogen deze namen noemen; het gaat om de werkelijke YAML.
  const yaml = workflow.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  assert.ok(!yaml.includes('pull_request_target'), 'pull_request_target is verboden');
  assert.ok(!/:\s*write\b/.test(yaml), 'geen enkele permission mag write zijn');
  assert.ok(!/secrets\./.test(yaml), 'de workflow mag geen secrets lezen');
  assert.ok(!yaml.includes('workflow_dispatch'), 'geen handmatige trigger op dit pad');
  // Elke API-aanroep is een read-only GET: geen -X/--method, geen -f/--field payloads.
  for (const line of yaml.split('\n').filter((l) => l.includes('gh api'))) {
    assert.ok(!/(^|\s)(-X|--method|-f |--field|--input)/.test(line), `niet read-only: ${line.trim()}`);
  }
});

test('W4. de live poort roept adapter én beslisser aan, niet één van beide', () => {
  const workflow = readFileSync('.github/workflows/autocoding-shield.yml', 'utf8');
  assert.match(workflow, /node scripts\/autocoding\/collect-shield-input\.mjs/);
  assert.match(workflow, /node scripts\/autocoding\/verify-review-gate\.mjs \\\n\s+--shield-input/);
  // Zonder deze bestanden op de default branch is er geen poort: de bootstrapcheck moet ze allebei
  // noemen, anders zou een halve checkout stilzwijgend als "poort actief" gelden.
  assert.match(workflow, /-f scripts\/autocoding\/collect-shield-input\.mjs/);
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
    nativeEvidence: [codex, gemini], ownerReceipts: [], sensitivePathsTouched: false,
    context: NATIVE_CONTEXT, policy: NATIVE_POLICY,
  });
  assert.deepEqual(r, { decision: 'GO', reasons: [] });
});

test('N3. gevoelige PR met geldig ownerreceipt => GO', () => {
  const codex = extractCodexNativeEvidence(codexComment(), resolved(), NATIVE_POLICY);
  const gemini = extractGeminiNativeEvidence(geminiReview(), [], resolved(), NATIVE_POLICY);
  const r = evaluateShield({
    nativeEvidence: [codex, gemini], ownerReceipts: [ownerReceiptEnvelope()], sensitivePathsTouched: true,
    context: NATIVE_CONTEXT, policy: NATIVE_POLICY,
  });
  assert.deepEqual(r, { decision: 'GO', reasons: [] });
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

test('N5. owner/self-review: de owner opent de PR zelf en tekent zijn eigen receipt => SELF_REVIEW', () => {
  // De owner is hier de GEMETEN bouwer. Zijn transportactor staat wél in de allowlist, dus het
  // receipt wordt geselecteerd en niet als ruis weggefilterd — en faalt dan mechanisch op
  // SELF_REVIEW. Dat is het scherpe geval: een toegestane identiteit die zichzelf goedkeurt.
  const ownerIsBuilder = { ...NATIVE_CONTEXT, builder_actor: 'rvanhooijdonk-png' };
  const selfReceipt = ownerReceiptEnvelope({ builder_actor: 'rvanhooijdonk-png' });
  const r = evaluateShield({
    nativeEvidence: [], ownerReceipts: [selfReceipt], sensitivePathsTouched: true,
    context: ownerIsBuilder, policy: NATIVE_POLICY,
  });
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.SELF_REVIEW));
});

test('N5a. een niet-allowlisted actor die zich als owner voordoet is ruis, geen SELF_REVIEW', () => {
  // Spiegelgeval van N5: dezelfde vorm, maar de bouwer staat niet in de ownerallowlist. Zijn
  // receipt wordt vóór elke inhoudelijke toets als ruis verworpen — de uitslag blijft NO_GO, maar
  // op NO_RECEIPTS. Zo kan een willekeurige commenter geen redencodes injecteren.
  const selfReceipt = ownerReceiptEnvelope({ reviewer_actor: NATIVE_CONTEXT.builder_actor });
  const r = evaluateShield({
    nativeEvidence: [], ownerReceipts: [selfReceipt], sensitivePathsTouched: true,
    context: NATIVE_CONTEXT, policy: NATIVE_POLICY,
  });
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.NO_RECEIPTS));
  assert.ok(!r.reasons.includes(REASON.SELF_REVIEW));
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

test('N8. dubbel ownerreceipt (dezelfde UUID) => NO_GO via het generieke receiptschema', () => {
  const dupUuid = '00000000-0000-4000-8000-000000000097';
  const r = evaluateShield({
    nativeEvidence: [],
    ownerReceipts: [ownerReceiptEnvelope({ receipt_uuid: dupUuid }), ownerReceiptEnvelope({ receipt_uuid: dupUuid })],
    sensitivePathsTouched: true,
    context: NATIVE_CONTEXT, policy: NATIVE_POLICY,
  });
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.DUPLICATE_UUID));
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

test('N11. ontbrekend ownerbewijs op een gevoelig pad => OWNER_GATE_REQUIRED', () => {
  const codex = extractCodexNativeEvidence(codexComment(), resolved(), NATIVE_POLICY);
  const gemini = extractGeminiNativeEvidence(geminiReview(), [], resolved(), NATIVE_POLICY);
  const r = evaluateShield({
    nativeEvidence: [codex, gemini], ownerReceipts: [], sensitivePathsTouched: true,
    context: NATIVE_CONTEXT, policy: NATIVE_POLICY,
  });
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.OWNER_GATE_REQUIRED));
  assert.ok(r.reasons.includes(REASON.NO_RECEIPTS));
});

test('N12. stale ownerbewijs op een gevoelig pad => OWNER_GATE_REQUIRED + STALE_HEAD', () => {
  const codex = extractCodexNativeEvidence(codexComment(), resolved(), NATIVE_POLICY);
  const gemini = extractGeminiNativeEvidence(geminiReview(), [], resolved(), NATIVE_POLICY);
  const staleOwner = ownerReceiptEnvelope({ head_sha: NATIVE_OLD_HEAD });
  const r = evaluateShield({
    nativeEvidence: [codex, gemini], ownerReceipts: [staleOwner], sensitivePathsTouched: true,
    context: NATIVE_CONTEXT, policy: NATIVE_POLICY,
  });
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.OWNER_GATE_REQUIRED));
});

test('N13. gespoofd ownerbewijs (transportactor buiten de allowlist) => OWNER_GATE_REQUIRED + NO_RECEIPTS', () => {
  const codex = extractCodexNativeEvidence(codexComment(), resolved(), NATIVE_POLICY);
  const gemini = extractGeminiNativeEvidence(geminiReview(), [], resolved(), NATIVE_POLICY);
  const spoofedOwner = ownerReceiptEnvelope({ reviewer_actor: 'aanvaller' });
  const r = evaluateShield({
    nativeEvidence: [codex, gemini], ownerReceipts: [spoofedOwner], sensitivePathsTouched: true,
    context: NATIVE_CONTEXT, policy: NATIVE_POLICY,
  });
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.OWNER_GATE_REQUIRED));
  assert.ok(r.reasons.includes(REASON.NO_RECEIPTS));
});

test('N14. echte Gemini-bevindingsbadge blokkeert, ook bij state COMMENTED => NATIVE_FINDINGS_PRESENT', () => {
  const evidence = extractGeminiNativeEvidence(geminiReview(), [GEMINI_FINDING_COMMENT_BODY], resolved(), NATIVE_POLICY);
  const bound = bindNativeEvidence(evidence, NATIVE_CONTEXT);
  assert.equal(bound.valid, false);
  assert.ok(bound.reasons.includes(REASON.NATIVE_FINDINGS_PRESENT));
});

test('N15. Gemini CHANGES_REQUESTED/DISMISSED/PENDING telt nooit als terminal GO', () => {
  for (const state of ['CHANGES_REQUESTED', 'DISMISSED', 'PENDING']) {
    const evidence = extractGeminiNativeEvidence(geminiReview({ state }), [], resolved(), NATIVE_POLICY);
    const bound = bindNativeEvidence(evidence, NATIVE_CONTEXT);
    assert.equal(bound.valid, false, state);
    assert.ok(bound.reasons.includes(REASON.NATIVE_STATE_NOT_ALLOWED), state);
  }
});

test('N16. Codex zonder succestekst (bevindingen) => NO_GO_VERDICT_PRESENT, nooit impliciet GO', () => {
  const withFindings = codexComment({ body: 'Codex Review: 2 comment(s) generated.\n\n**Reviewed commit:** `b9df1f8398`\n' });
  const evidence = extractCodexNativeEvidence(withFindings, resolved(), NATIVE_POLICY);
  const bound = bindNativeEvidence(evidence, NATIVE_CONTEXT);
  assert.equal(bound.valid, false);
  assert.ok(bound.reasons.includes(REASON.NO_GO_VERDICT_PRESENT));
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

test('N23. de owner telt nooit als reviewvendor: een ownerreceipt vervangt Codex of Gemini niet', () => {
  const ownerAsCodex = ownerReceiptEnvelope({ reviewer_vendor: 'codex' });
  const r = evaluateShield({
    nativeEvidence: [], ownerReceipts: [ownerAsCodex], sensitivePathsTouched: true,
    context: NATIVE_CONTEXT, policy: NATIVE_POLICY,
  });
  assert.equal(r.decision, 'NO_GO');
  // Het native pad heeft nog steeds nul bewijs; het ownerreceipt raakt dat pad niet.
  assert.ok(r.reasons.includes(REASON.INSUFFICIENT_GO));
  assert.ok(r.reasons.includes(REASON.NO_RECEIPTS));
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

const NATIVE_POLICY = Object.freeze({
  native_review: Object.freeze({
    required_vendors: Object.freeze(['codex', 'gemini']),
    codex: Object.freeze({
      actor: 'chatgpt-codex-connector[bot]',
      app_id: 1144995,
      success_marker: "Codex Review: Didn't find any major issues. :tada:",
    }),
    gemini: Object.freeze({
      actor: 'gemini-code-assist[bot]',
      allowed_states: Object.freeze(['COMMENTED', 'APPROVED']),
      terminal_marker: '## Code Review',
    }),
  }),
  owner_gate: Object.freeze({
    sensitive_path_globs: Object.freeze(['.github/workflows/', 'CONTROL/AUTOCODING/']),
    required_distinct_vendors: 1,
    allowed_reviewer_actors: Object.freeze({ owner: Object.freeze(['rvanhooijdonk-png']) }),
  }),
});

function resolved(headSha = NATIVE_HEAD, treeSha = NATIVE_TREE) {
  return { head_sha: headSha, tree_sha: treeSha };
}

// Letterlijk PR #72, comment 5376132338 (chatgpt-codex-connector[bot], GitHub App 1144995).
const CODEX_SUCCESS_COMMENT = Object.freeze({
  user: Object.freeze({ login: 'chatgpt-codex-connector[bot]', type: 'Bot' }),
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
    user: { login: 'gemini-code-assist[bot]', type: 'Bot' },
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

function ownerReceiptEnvelope(overrides = {}) {
  return {
    receipt: {
      schema: RECEIPT_SCHEMA,
      task_id: NATIVE_CONTEXT.task_id,
      reviewer_actor: 'rvanhooijdonk-png',
      reviewer_vendor: 'owner',
      receipt_uuid: '00000000-0000-4000-8000-000000000099',
      head_sha: NATIVE_HEAD,
      tree_sha: NATIVE_TREE,
      verdict: 'GO',
      checks_executed: ['owner-review'],
      builder_actor: NATIVE_CONTEXT.builder_actor,
      ...overrides,
    },
    transport_actor: overrides.reviewer_actor ?? 'rvanhooijdonk-png',
  };
}
