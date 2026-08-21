/**
 * AUTOCODING_SHIELD — adaptertests.
 *
 * De fixtures in `test/fixtures/autocoding-shield/` zijn deterministische kopieën van de vorm die
 * `gh api` in de workflow oplevert (pagina-arrays van `--paginate --slurp`). Ze bevatten bewust
 * tegelijk: geldig actueel vendorbewijs, bewijs van een VORIGE head, een gespoofd comment met exact
 * dezelfde succestekst, menselijk proza, een ownerreceipt en een gewijzigd gevoelig pad. Zo toetst
 * één set fixtures de hele adapter tegen alle ordergevallen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  buildShieldInput, buildCommitIndex, resolveCommitRef, extractTaskId, touchesSensitivePaths,
  groupReviewComments, flattenPages,
} from '../scripts/autocoding/collect-shield-input.mjs';
import { evaluateShield, REASON } from '../scripts/autocoding/verify-review-gate.mjs';

const FIXTURES = 'test/fixtures/autocoding-shield';
const HEAD = 'b9df1f8398aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TREE = 'e'.repeat(40);
const PREV_HEAD = '7c1d0e5f22bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const POLICY = JSON.parse(readFileSync('CONTROL/AUTOCODING/policy.v1.json', 'utf8'));

function raw(name) {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

function fixtureInput(overrides = {}) {
  return {
    pr: raw('pr'),
    headCommit: raw('head-commit'),
    prCommits: raw('pr-commits'),
    issueComments: raw('issue-comments'),
    reviews: raw('reviews'),
    reviewComments: raw('review-comments'),
    changedFiles: raw('files'),
    policy: POLICY,
    ...overrides,
  };
}

test('A1. de adapter meet head, tree, bouwer en task-id uit de API, niet uit PR-proza', () => {
  const { context } = buildShieldInput(fixtureInput());
  assert.deepEqual(context, {
    pr_head_sha: HEAD,
    pr_tree_sha: TREE,
    builder_actor: 'claude2-cloud',
    task_id: 'AUTOCODING_STACK_DASHBOARD_LIVE_GATE_COMPLETION_PR_V1',
  });
});

test('A2. de volledige fixtureset levert precies vier bewijsstukken op — proza en spoof vallen weg', () => {
  const { shieldInput } = buildShieldInput(fixtureInput());
  // Vijf issue-comments en drie reviews in de fixture; alleen de twee echte Codex-comments en de
  // twee echte Gemini-reviews zijn bewijs, waarvan er per vendor één naar de vorige head wijst.
  assert.equal(shieldInput.nativeEvidence.length, 4);
  assert.deepEqual(
    shieldInput.nativeEvidence.map((e) => e.vendor).sort(),
    ['codex', 'codex', 'gemini', 'gemini'],
  );
  for (const e of shieldInput.nativeEvidence) {
    assert.ok(['chatgpt-codex-connector[bot]', 'gemini-code-assist[bot]'].includes(e.claimed_actor));
  }
});

test('A3. een gespoofd comment met identieke Codex-succestekst levert geen bewijsstuk op', () => {
  const { shieldInput } = buildShieldInput(fixtureInput());
  assert.ok(!shieldInput.nativeEvidence.some((e) => e.claimed_actor === 'aanvaller'));
  // En een menselijke "APPROVED"-review met Gemini's marker evenmin.
  assert.ok(!shieldInput.nativeEvidence.some((e) => e.claimed_actor === 'een-willekeurige-lezer'));
});

test('A4. de afgekorte Codex-commit wordt tegen de PR-commits geresolveerd, nooit geloofd', () => {
  const { shieldInput } = buildShieldInput(fixtureInput());
  const codex = shieldInput.nativeEvidence.filter((e) => e.vendor === 'codex');
  const heads = codex.map((e) => e.resolved_head_sha).sort();
  assert.deepEqual(heads, [PREV_HEAD, HEAD].sort());
  const current = codex.find((e) => e.resolved_head_sha === HEAD);
  assert.equal(current.resolved_tree_sha, TREE);
  assert.equal(current.verdict, 'GO');
});

test('A5. de fixtureset als geheel is GO: stale rondes blokkeren niet, actueel bewijs telt', () => {
  const { context, shieldInput } = buildShieldInput(fixtureInput());
  const r = evaluateShield({ ...shieldInput, context, policy: POLICY });
  assert.deepEqual(r, { decision: 'GO', reasons: [] });
});

test('A6. zonder het actuele Codex-comment blijft alleen stale bewijs over => nooit GO', () => {
  const comments = flattenPages(raw('issue-comments'));
  const zonderActueel = [comments.filter((c) => !c.body.includes('`b9df1f8398`') || c.user.login === 'aanvaller')];
  const { context, shieldInput } = buildShieldInput(fixtureInput({ issueComments: zonderActueel }));
  const r = evaluateShield({ ...shieldInput, context, policy: POLICY });
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.INSUFFICIENT_GO));
});

test('A7. de gewijzigde workflow markeert de PR als gevoelig en eist het ownerreceipt', () => {
  const { shieldInput } = buildShieldInput(fixtureInput());
  assert.equal(shieldInput.sensitivePathsTouched, true);
  assert.equal(shieldInput.ownerReceipts.length, 1);
  assert.equal(shieldInput.ownerReceipts[0].transport_actor, 'rvanhooijdonk-png');
});

test('A8. zonder ownerreceipt is dezelfde gevoelige PR rood', () => {
  const comments = flattenPages(raw('issue-comments'));
  const zonderOwner = [comments.filter((c) => c.user.login !== 'rvanhooijdonk-png')];
  const { context, shieldInput } = buildShieldInput(fixtureInput({ issueComments: zonderOwner }));
  const r = evaluateShield({ ...shieldInput, context, policy: POLICY });
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.OWNER_GATE_REQUIRED));
});

test('A9. Gemini-review met inline bevindingen levert nooit een geldig GO-bewijsstuk', () => {
  // De stale ronde in de fixture draagt één echte bevindingsbadge; hang diezelfde comments aan de
  // ACTUELE review en de PR moet rood worden ondanks state COMMENTED.
  const reviews = flattenPages(raw('reviews'));
  const actueel = reviews.find((r) => r.commit_id === HEAD && r.user.login === 'gemini-code-assist[bot]');
  const verplaatst = [flattenPages(raw('review-comments')).map((c) => ({ ...c, pull_request_review_id: actueel.id }))];
  const { context, shieldInput } = buildShieldInput(fixtureInput({ reviewComments: verplaatst }));
  const r = evaluateShield({ ...shieldInput, context, policy: POLICY });
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.NATIVE_FINDINGS_PRESENT));
});

test('A10. een lege API-oogst is nooit groen', () => {
  const leeg = fixtureInput({ issueComments: [], reviews: [], reviewComments: [], changedFiles: [] });
  const { context, shieldInput } = buildShieldInput(leeg);
  assert.equal(shieldInput.nativeEvidence.length, 0);
  // Geen zicht op gewijzigde bestanden => gevoelig, nooit een stilzwijgende vrijstelling.
  assert.equal(shieldInput.sensitivePathsTouched, true);
  const r = evaluateShield({ ...shieldInput, context, policy: POLICY });
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.NO_RECEIPTS));
  assert.ok(r.reasons.includes(REASON.OWNER_GATE_REQUIRED));
});

test('A11. een dubbelzinnige of onbekende commit-prefix resolveert niet', () => {
  const index = buildCommitIndex({
    prCommits: [[
      { sha: `abc1234${'0'.repeat(33)}`, commit: { tree: { sha: '1'.repeat(40) } } },
      { sha: `abc1234${'1'.repeat(33)}`, commit: { tree: { sha: '2'.repeat(40) } } },
    ]],
    headSha: HEAD,
    headCommit: raw('head-commit'),
  });
  assert.equal(resolveCommitRef('abc1234', index), null, 'twee treffers is geen meting');
  assert.equal(resolveCommitRef('9999999', index), null, 'nul treffers is geen meting');
  assert.equal(resolveCommitRef('ZZZZZZZ', index), null, 'geen hex is geen referentie');
  assert.equal(resolveCommitRef(null, index), null);
  assert.deepEqual(resolveCommitRef('b9df1f8398', index), { head_sha: HEAD, tree_sha: TREE });
});

test('A12. een half commit-antwoord levert geen resolutiegrond op', () => {
  const index = buildCommitIndex({
    prCommits: [[{ sha: HEAD, commit: {} }, { sha: 'kort', commit: { tree: { sha: TREE } } }]],
    headSha: HEAD,
    headCommit: {},
  });
  assert.equal(index.size, 0);
  assert.equal(resolveCommitRef(HEAD, index), null);
});

test('A13. task-id komt uit een exacte regel, niet uit vrije tekst', () => {
  assert.equal(extractTaskId('task_id=ABC'), 'ABC');
  assert.equal(extractTaskId('intro\ntask_id=ABC\nslot'), 'ABC');
  assert.equal(extractTaskId('de task_id=ABC staat midden in een zin'), '');
  assert.equal(extractTaskId('task_id= ABC'), '');
  assert.equal(extractTaskId(undefined), '');
});

test('A14. gevoelige paden: prefixmatch, met fail-closed bij ontbrekend zicht', () => {
  const globs = POLICY.owner_gate.sensitive_path_globs;
  assert.equal(touchesSensitivePaths([[{ filename: 'docs/README.md' }]], globs), false);
  assert.equal(touchesSensitivePaths([[{ filename: 'CONTROL/AUTOCODING/policy.v1.json' }]], globs), true);
  assert.equal(touchesSensitivePaths([[{ filename: '.github/workflows/x.yml' }]], globs), true);
  assert.equal(touchesSensitivePaths([], globs), true, 'geen bestandslijst => gevoelig');
  assert.equal(touchesSensitivePaths(null, globs), true);
  assert.equal(touchesSensitivePaths([[{ filename: 'docs/README.md' }]], []), true, 'geen globs => gevoelig');
});

test('A15. inline comments worden op review-id gegroepeerd, niet op auteur of volgorde', () => {
  const grouped = groupReviewComments([[
    { pull_request_review_id: 1, body: 'a' },
    { pull_request_review_id: 2, body: 'b' },
    { pull_request_review_id: 1, body: 'c' },
    { body: 'losse comment zonder review' },
  ]]);
  assert.deepEqual(grouped.get(1), ['a', 'c']);
  assert.deepEqual(grouped.get(2), ['b']);
  assert.equal(grouped.size, 2);
});

test('A16. flattenPages accepteert zowel --slurp-pagina\'s als één enkele array', () => {
  assert.deepEqual(flattenPages([[1, 2], [3]]), [1, 2, 3]);
  assert.deepEqual(flattenPages([{ a: 1 }]), [{ a: 1 }]);
  assert.deepEqual(flattenPages(null), []);
  assert.deepEqual(flattenPages({ message: 'Not Found' }), []);
});

test('A17. de adapter-CLI schrijft context en shield-input die de beslisser groen keurt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shield-adapter-'));
  const rawDir = join(dir, 'raw');
  mkdirSync(rawDir);
  cpSync(FIXTURES, rawDir, { recursive: true });
  const contextPath = join(dir, 'context.json');
  const inputPath = join(dir, 'shield-input.json');

  const collect = spawnSync(process.execPath, [
    'scripts/autocoding/collect-shield-input.mjs', '--raw', rawDir, '--policy',
    'CONTROL/AUTOCODING/policy.v1.json', '--out-context', contextPath, '--out-shield-input', inputPath,
  ], { encoding: 'utf8' });
  assert.equal(collect.status, 0, collect.stdout + collect.stderr);

  const verify = spawnSync(process.execPath, [
    'scripts/autocoding/verify-review-gate.mjs', '--shield-input', inputPath, '--context', contextPath,
    '--policy', 'CONTROL/AUTOCODING/policy.v1.json',
  ], { encoding: 'utf8' });
  assert.equal(verify.stderr, '');
  assert.deepEqual(JSON.parse(verify.stdout), { decision: 'GO', reasons: [] });
  assert.equal(verify.status, 0);
});

test('A18. de adapter-CLI faalt hard op ontbrekende of kapotte ruwe invoer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shield-adapter-'));
  const rawDir = join(dir, 'raw');
  mkdirSync(rawDir);
  const run = () => spawnSync(process.execPath, [
    'scripts/autocoding/collect-shield-input.mjs', '--raw', rawDir, '--policy',
    'CONTROL/AUTOCODING/policy.v1.json', '--out-context', join(dir, 'c.json'),
    '--out-shield-input', join(dir, 's.json'),
  ], { encoding: 'utf8' });

  const missing = run();
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /COLLECT_RAW_INPUT_UNREADABLE/);

  cpSync(FIXTURES, rawDir, { recursive: true });
  writeFileSync(join(rawDir, 'reviews.json'), '{kapot');
  const broken = run();
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /COLLECT_RAW_INPUT_UNREADABLE/);

  const noArgs = spawnSync(process.execPath, ['scripts/autocoding/collect-shield-input.mjs'], { encoding: 'utf8' });
  assert.equal(noArgs.status, 1);
  assert.match(noArgs.stdout, /COLLECT_ARGS_MISSING/);
});

test('A19. de adapter lekt geen bewijsinhoud naar stdout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shield-adapter-'));
  const rawDir = join(dir, 'raw');
  mkdirSync(rawDir);
  cpSync(FIXTURES, rawDir, { recursive: true });
  const collect = spawnSync(process.execPath, [
    'scripts/autocoding/collect-shield-input.mjs', '--raw', rawDir, '--policy',
    'CONTROL/AUTOCODING/policy.v1.json', '--out-context', join(dir, 'c.json'),
    '--out-shield-input', join(dir, 's.json'),
  ], { encoding: 'utf8' });
  assert.equal(collect.stdout, '');
  assert.equal(collect.stderr, '');
});
