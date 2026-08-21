/**
 * AUTOCODING_REVIEW_RECEIPT_V1 — de bindende testmatrix uit de opdracht (12 genummerde gevallen),
 * plus de machineblok-extractie en de policy-veiligheidscheck die de validator zelf ook gebruikt.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateReceipts, evaluateReceipt, extractReceiptFromCommentBody, assertPolicyIsSafe,
  REASON, RECEIPT_SCHEMA,
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
    signed(goCodex({ reviewer_actor: 'claude1-cloud', builder_actor: 'claude1-cloud' })),
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
  const r = evaluateReceipts([signed(goCodex({ reviewer_actor: '*' })), signed(goGemini())], CONTEXT, POLICY);
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.WILDCARD_IDENTITY));
});

test('12b. onbekende (onbewezen) actor => NO_GO (UNKNOWN_ACTOR)', () => {
  const r = evaluateReceipts([signed(goCodex({ reviewer_actor: 'onbewezen-account' })), signed(goGemini())], CONTEXT, POLICY);
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

test('lege allowlist is een toegestane fail-closed default', () => {
  assert.doesNotThrow(() => assertPolicyIsSafe({ allowed_reviewer_actors: { codex: [], gemini: [] } }));
});

test('zelfverklaarde reviewer zonder overeenkomende GitHub-auteur wordt geweigerd', () => {
  const r = evaluateReceipts([
    signed(goCodex(), 'aanvaller'), signed(goGemini()),
  ], CONTEXT, POLICY);
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.TRANSPORT_ACTOR_MISMATCH));
});
