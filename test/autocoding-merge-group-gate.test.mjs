/**
 * V20 scope-item 1/2 — MERGE-GROUP-POORT. De drie regressies die de opdracht met naam noemt (N1
 * verstaald bewijs, N2 ingetrokken eigenaarsbewijs ná inschrijving, N3 gevoelige mede-inzittende PR
 * in dezelfde wachtrij) plus de eenheidsdekking van `resolve-merge-group.mjs` zelf.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseMergeGroupHeadRef, resolveMergeGroupBinding, evaluateMergeGroupGate,
  evaluateMergeGroupCheck, MERGE_GROUP_REASON,
} from '../scripts/autocoding/resolve-merge-group.mjs';
import {
  evaluateShield, evaluateMergeAuthorizations, extractCodexNativeEvidence,
  extractGeminiNativeEvidence, OWNER_APPROVAL_SCHEMA, REASON,
} from '../scripts/autocoding/verify-review-gate.mjs';
import {
  parseMergeGroupGateArgs, runMergeGroupGate, runVerifyMergeGroupGate,
  PR_MEASUREMENT_FILES, MERGE_GROUP_GATE_DECISION, MERGE_GROUP_GATE_ERROR,
} from '../scripts/autocoding/verify-merge-group-gate.mjs';

const BASE = 'a'.repeat(40);
const OLD_BASE = 'f'.repeat(40);
// PR_HEAD begint bewust met `b9df1f8398` — de letterlijke, echte reviewed-commit-prefix uit de
// Codex-succesbody (zie ook `NATIVE_HEAD` in test/autocoding-review-gate.test.mjs), zodat de
// CLI-integratietests hieronder de ECHTE `resolveCommitRef`-prefixresolutie doorlopen in plaats van
// een kunstmatig al-opgeloste `resolved`.
const PR_HEAD = 'b9df1f8398'.padEnd(40, '0');
const NEW_PR_HEAD = 'b9df1f8398'.padEnd(40, '1');
const PR_TREE = 'c'.repeat(40);
const MERGE_GROUP_TREE = 'd'.repeat(40);
const OTHER_PR_HEAD = 'e'.repeat(40);
const PR_NUMBER = 74;
const TASK_ID = 'AUTOCODING_LIVE_GATE_COMPLETION_V1';

const CODEX_USER_ID = 199175422;
const GEMINI_USER_ID = 176961590;

const POLICY = Object.freeze({
  native_review: Object.freeze({
    required_vendors: Object.freeze(['codex', 'gemini']),
    codex: Object.freeze({
      actor: 'chatgpt-codex-connector[bot]', user_id: CODEX_USER_ID, user_type: 'Bot', app_id: 1144995,
      allowed_states: Object.freeze(['COMMENTED']),
      terminal_success_markers: Object.freeze(["Codex Review: Didn't find any major issues."]),
    }),
    gemini: Object.freeze({
      actor: 'gemini-code-assist[bot]', user_id: GEMINI_USER_ID, user_type: 'Bot',
      allowed_states: Object.freeze(['COMMENTED', 'APPROVED']),
      terminal_success_markers: Object.freeze(['## Code Review']),
    }),
  }),
  owner_gate: Object.freeze({
    schema: OWNER_APPROVAL_SCHEMA,
    sensitive_path_prefixes: Object.freeze(['.github/workflows/', 'CONTROL/AUTOCODING/']),
    allowed_review_states: Object.freeze(['COMMENTED']),
    allowed_owner_actors: Object.freeze(['rvanhooijdonk-png']),
  }),
});

function freshPullRequest(overrides = {}) {
  return {
    number: PR_NUMBER, state: 'open', merged: false,
    head: { sha: PR_HEAD }, base: { sha: BASE },
    ...overrides,
  };
}

function headRefFor(pr = PR_NUMBER, sha = PR_HEAD) {
  return `gh-readonly-queue/main/pr-${pr}-${sha}`;
}

function shieldContext(overrides = {}) {
  return {
    pr_head_sha: PR_HEAD, pr_tree_sha: PR_TREE, pr_number: PR_NUMBER, pr_base_sha: BASE,
    builder_actor: 'claude2-cloud', task_id: TASK_ID,
    ...overrides,
  };
}

function codexEvidence() {
  const comment = {
    user: { login: 'chatgpt-codex-connector[bot]', id: CODEX_USER_ID, type: 'Bot' },
    performed_via_github_app: { id: 1144995 },
    body: 'Codex Review: Didn\'t find any major issues. :tada:\n\n**Reviewed commit:** `b9df1f8398`',
  };
  return extractCodexNativeEvidence(comment, { head_sha: PR_HEAD, tree_sha: PR_TREE }, POLICY);
}

function geminiEvidence() {
  const review = {
    user: { login: 'gemini-code-assist[bot]', id: GEMINI_USER_ID, type: 'Bot' },
    state: 'COMMENTED', commit_id: PR_HEAD,
    body: '## Code Review\n\nDeze PR is representatief schoon.',
  };
  return extractGeminiNativeEvidence(review, [], { head_sha: PR_HEAD, tree_sha: PR_TREE }, POLICY);
}

function ownerEnvelope({ treeSha = MERGE_GROUP_TREE, state = null, source = 'issue_comment' } = {}) {
  return {
    approval: {
      schema: OWNER_APPROVAL_SCHEMA, task_id: TASK_ID, head_sha: PR_HEAD, tree_sha: treeSha,
      pull_request: PR_NUMBER, base_sha: BASE, decision: 'APPROVE',
    },
    transport_actor: 'rvanhooijdonk-png', source, review_state: state,
  };
}

function throwingShield() {
  throw new Error('evaluateShield had niet aangeroepen mogen worden ná een gefaalde binding');
}
function throwingMergeAuthorizations() {
  throw new Error('evaluateMergeAuthorizations had niet aangeroepen mogen worden ná een gefaalde binding');
}

// --- parseMergeGroupHeadRef -------------------------------------------------------------------

test('R1. parseMergeGroupHeadRef leest de door GitHub gegenereerde queue-ref', () => {
  const parsed = parseMergeGroupHeadRef(headRefFor());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.baseRef, 'main');
  assert.equal(parsed.pullRequest, PR_NUMBER);
  assert.equal(parsed.headShaHint, PR_HEAD);
});

test('R1a. parseMergeGroupHeadRef aanvaardt het refs/heads/-voorvoegsel', () => {
  const parsed = parseMergeGroupHeadRef(`refs/heads/${headRefFor()}`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.pullRequest, PR_NUMBER);
});

test('R1b. een onherkenbare ref is altijd ok:false, nooit een gok', () => {
  for (const bad of [undefined, null, '', 'main', 'refs/heads/main', 'gh-readonly-queue/main/pr-74']) {
    assert.equal(parseMergeGroupHeadRef(bad).ok, false, String(bad));
  }
});

// --- resolveMergeGroupBinding ----------------------------------------------------------------

test('R2. de gezonde binding: precies twee ouders, base én verse PR-head komen overeen', () => {
  const r = resolveMergeGroupBinding({
    headRef: headRefFor(), mergeGroupBaseSha: BASE, mergeGroupParents: [BASE, PR_HEAD],
    freshPullRequest: freshPullRequest(),
  });
  assert.equal(r.ok, true);
  assert.equal(r.pullRequest, PR_NUMBER);
  assert.deepEqual(r.reasons, []);
});

test('N1. VERSTALED bewijs: de PR ging na inschrijving verder — haar huidige head is geen ouder meer', () => {
  const r = resolveMergeGroupBinding({
    headRef: headRefFor(), mergeGroupBaseSha: BASE, mergeGroupParents: [BASE, PR_HEAD],
    freshPullRequest: freshPullRequest({ head: { sha: NEW_PR_HEAD } }),
  });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes(MERGE_GROUP_REASON.MERGE_GROUP_HEAD_STALE));
});

test('N1a. BASE-drift: de basebranch verplaatste tussen meting en inschrijving', () => {
  const r = resolveMergeGroupBinding({
    headRef: headRefFor(), mergeGroupBaseSha: OLD_BASE, mergeGroupParents: [OLD_BASE, PR_HEAD],
    freshPullRequest: freshPullRequest(),
  });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes(MERGE_GROUP_REASON.MERGE_GROUP_BASE_MISMATCH));
});

test('N3-binding. een CO-TENANT-merge-group (drie ouders) is nooit aan één PR toe te schrijven', () => {
  const r = resolveMergeGroupBinding({
    headRef: headRefFor(), mergeGroupBaseSha: BASE,
    mergeGroupParents: [BASE, PR_HEAD, OTHER_PR_HEAD],
    freshPullRequest: freshPullRequest(),
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, [MERGE_GROUP_REASON.MERGE_GROUP_PARENTS_NOT_TWO]);
});

test('R2a. onherkenbare ref → alleen MERGE_GROUP_REF_UNPARSEABLE, geen andere reden', () => {
  const r = resolveMergeGroupBinding({
    headRef: 'niet-een-queue-ref', mergeGroupBaseSha: BASE, mergeGroupParents: [BASE, PR_HEAD],
    freshPullRequest: freshPullRequest(),
  });
  assert.deepEqual(r.reasons, [MERGE_GROUP_REASON.MERGE_GROUP_REF_UNPARSEABLE]);
});

test('R2b. het PR-nummer in de ref moet de verse PR matchen', () => {
  const r = resolveMergeGroupBinding({
    headRef: headRefFor(75), mergeGroupBaseSha: BASE, mergeGroupParents: [BASE, PR_HEAD],
    freshPullRequest: freshPullRequest(),
  });
  assert.ok(r.reasons.includes(MERGE_GROUP_REASON.MERGE_GROUP_PULL_REQUEST_MISMATCH));
});

test('R2c. een gesloten of al gemergede PR levert nooit een binding op', () => {
  for (const overrides of [{ state: 'closed' }, { merged: true }]) {
    const r = resolveMergeGroupBinding({
      headRef: headRefFor(), mergeGroupBaseSha: BASE, mergeGroupParents: [BASE, PR_HEAD],
      freshPullRequest: freshPullRequest(overrides),
    });
    assert.ok(r.reasons.includes(MERGE_GROUP_REASON.MERGE_GROUP_PULL_REQUEST_NOT_OPEN), JSON.stringify(overrides));
  }
});

// --- evaluateMergeGroupGate: de boomgebonden eigenaarsautorisatie -----------------------------

test('HEADGREEN. de eigen head van de PR is volledig groen, maar de merge-group-tree draagt géén '
  + 'herleidbare autorisatie — dat blijft NO_GO', () => {
  const gate = evaluateMergeGroupGate({
    evaluateShield, evaluateMergeAuthorizations,
    shieldContext: shieldContext(), mergeGroupTreeSha: MERGE_GROUP_TREE, policy: POLICY,
    shieldInput: {
      nativeEvidence: [codexEvidence(), geminiEvidence()], ownerApprovals: [],
      sensitivePathsTouched: false, filesComplete: true,
    },
  });
  assert.equal(gate.decision, 'NO_GO');
  assert.ok(gate.reasons.includes(MERGE_GROUP_REASON.MERGE_GROUP_TREE_AUTHORIZATION_MISSING));
});

test('een autorisatie die aan de EIGEN PR-tree bindt (niet de merge-group-tree) telt niet mee '
  + 'voor de merge-group-poort', () => {
  const gate = evaluateMergeGroupGate({
    evaluateShield, evaluateMergeAuthorizations,
    shieldContext: shieldContext(), mergeGroupTreeSha: MERGE_GROUP_TREE, policy: POLICY,
    shieldInput: {
      nativeEvidence: [codexEvidence(), geminiEvidence()],
      ownerApprovals: [ownerEnvelope({ treeSha: PR_TREE })],
      sensitivePathsTouched: false, filesComplete: true,
    },
  });
  assert.equal(gate.decision, 'NO_GO');
  assert.ok(gate.reasons.includes(REASON.OWNER_APPROVAL_TREE_MISMATCH));
});

test('ALLGREEN. native bewijs én een autorisatie die expliciet aan de merge-group-tree bindt → GO', () => {
  const gate = evaluateMergeGroupGate({
    evaluateShield, evaluateMergeAuthorizations,
    shieldContext: shieldContext(), mergeGroupTreeSha: MERGE_GROUP_TREE, policy: POLICY,
    shieldInput: {
      nativeEvidence: [codexEvidence(), geminiEvidence()],
      ownerApprovals: [ownerEnvelope({ treeSha: MERGE_GROUP_TREE })],
      sensitivePathsTouched: false, filesComplete: true,
    },
  });
  assert.equal(gate.decision, 'GO');
  assert.deepEqual(gate.reasons, []);
});

// --- N2: ingetrokken eigenaarsbewijs ná inschrijving -------------------------------------------

test('N2. een DISMISSED review-autorisatie blijft geen geldig mergebewijs, ook al bond hij ooit '
  + 'aan de merge-group-tree', () => {
  const dismissed = ownerEnvelope({ treeSha: MERGE_GROUP_TREE, source: 'review', state: 'DISMISSED' });
  const gate = evaluateMergeGroupGate({
    evaluateShield, evaluateMergeAuthorizations,
    shieldContext: shieldContext(), mergeGroupTreeSha: MERGE_GROUP_TREE, policy: POLICY,
    shieldInput: {
      nativeEvidence: [codexEvidence(), geminiEvidence()], ownerApprovals: [dismissed],
      sensitivePathsTouched: false, filesComplete: true,
    },
  });
  assert.equal(gate.decision, 'NO_GO');
  assert.ok(gate.reasons.includes(MERGE_GROUP_REASON.MERGE_GROUP_TREE_AUTHORIZATION_MISSING));
  assert.ok(gate.reasons.includes(REASON.OWNER_APPROVAL_CARRIER_NOT_ACTIVE));

  // Positieve controle: dezelfde autorisatie, vóór intrekking (state COMMENTED), levert wél GO —
  // het is dus specifiek de intrekking die de poort sluit, niet de vorm van het blok.
  const actief = ownerEnvelope({ treeSha: MERGE_GROUP_TREE, source: 'review', state: 'COMMENTED' });
  const gateActief = evaluateMergeGroupGate({
    evaluateShield, evaluateMergeAuthorizations,
    shieldContext: shieldContext(), mergeGroupTreeSha: MERGE_GROUP_TREE, policy: POLICY,
    shieldInput: {
      nativeEvidence: [codexEvidence(), geminiEvidence()], ownerApprovals: [actief],
      sensitivePathsTouched: false, filesComplete: true,
    },
  });
  assert.equal(gateActief.decision, 'GO');
});

// --- evaluateMergeGroupCheck: de tweetraps-orkestratie die de workflow aanroept ----------------

test('N1-check. een verstaald bewijs sluit de poort AL in trap 1 — trap 2 wordt nooit aangeroepen', () => {
  const result = evaluateMergeGroupCheck({
    headRef: headRefFor(), mergeGroupBaseSha: BASE, mergeGroupParents: [BASE, PR_HEAD],
    freshPullRequest: freshPullRequest({ head: { sha: NEW_PR_HEAD } }),
    mergeGroupTreeSha: MERGE_GROUP_TREE,
    evaluateShield: throwingShield, evaluateMergeAuthorizations: throwingMergeAuthorizations,
    shieldContext: shieldContext(), policy: POLICY,
    shieldInput: {
      nativeEvidence: [codexEvidence(), geminiEvidence()],
      ownerApprovals: [ownerEnvelope({ treeSha: MERGE_GROUP_TREE })],
      sensitivePathsTouched: false, filesComplete: true,
    },
  });
  assert.equal(result.decision, 'NO_GO');
  assert.deepEqual(result.reasons, [MERGE_GROUP_REASON.MERGE_GROUP_HEAD_STALE]);
});

test('N3-ALLGREEN. co-tenant-merge-group: zelfs met volledig groen bewijs (native + boomgebonden '
  + 'autorisatie) sluit de bindingscontrole de poort zonder ooit het bewijs te herwegen', () => {
  const shieldInput = {
    nativeEvidence: [codexEvidence(), geminiEvidence()],
    ownerApprovals: [ownerEnvelope({ treeSha: MERGE_GROUP_TREE })],
    sensitivePathsTouched: false, filesComplete: true,
  };

  // Controle: zonder de mede-inzittende PR (twee ouders) zou dit bewijs GO opleveren.
  const isolatedGate = evaluateMergeGroupGate({
    evaluateShield, evaluateMergeAuthorizations,
    shieldContext: shieldContext(), mergeGroupTreeSha: MERGE_GROUP_TREE, policy: POLICY, shieldInput,
  });
  assert.equal(isolatedGate.decision, 'GO');

  // Met een derde ouder (de gevoelige mede-inzittende PR) sluit trap 1 de poort — trap 2 wordt
  // nooit aangeroepen, dus het "groene" bewijs hierboven wordt letterlijk nooit herwogen.
  const result = evaluateMergeGroupCheck({
    headRef: headRefFor(), mergeGroupBaseSha: BASE,
    mergeGroupParents: [BASE, PR_HEAD, OTHER_PR_HEAD],
    freshPullRequest: freshPullRequest(), mergeGroupTreeSha: MERGE_GROUP_TREE,
    evaluateShield: throwingShield, evaluateMergeAuthorizations: throwingMergeAuthorizations,
    shieldContext: shieldContext(), policy: POLICY, shieldInput,
  });
  assert.equal(result.decision, 'NO_GO');
  assert.deepEqual(result.reasons, [MERGE_GROUP_REASON.MERGE_GROUP_PARENTS_NOT_TWO]);
});

test('N3-HEADGREEN. co-tenant-merge-group: ook wanneer alleen de EIGEN head van de PR groen is '
  + '(en de boomgebonden autorisatie sowieso zou ontbreken) blokkeert dezelfde bindingscontrole — '
  + 'met dezelfde reden, ongeacht welk onderliggend defect er ook nog was', () => {
  const shieldInput = {
    nativeEvidence: [codexEvidence(), geminiEvidence()], ownerApprovals: [],
    sensitivePathsTouched: false, filesComplete: true,
  };

  // Controle buiten de merge-group-vraag om: de eigen head-shield is groen; de tree-autorisatie
  // ontbreekt sowieso, wat die vraag los van het co-tenant-defect al NO_GO zou maken.
  const isolatedGate = evaluateMergeGroupGate({
    evaluateShield, evaluateMergeAuthorizations,
    shieldContext: shieldContext(), mergeGroupTreeSha: MERGE_GROUP_TREE, policy: POLICY, shieldInput,
  });
  assert.equal(isolatedGate.decision, 'NO_GO');
  assert.ok(isolatedGate.reasons.includes(MERGE_GROUP_REASON.MERGE_GROUP_TREE_AUTHORIZATION_MISSING));

  const result = evaluateMergeGroupCheck({
    headRef: headRefFor(), mergeGroupBaseSha: BASE,
    mergeGroupParents: [BASE, PR_HEAD, OTHER_PR_HEAD],
    freshPullRequest: freshPullRequest(), mergeGroupTreeSha: MERGE_GROUP_TREE,
    evaluateShield: throwingShield, evaluateMergeAuthorizations: throwingMergeAuthorizations,
    shieldContext: shieldContext(), policy: POLICY, shieldInput,
  });
  assert.equal(result.decision, 'NO_GO');
  assert.deepEqual(result.reasons, [MERGE_GROUP_REASON.MERGE_GROUP_PARENTS_NOT_TWO]);
});

// --- verify-merge-group-gate.mjs: de CLI-schakel ------------------------------------------------

test('C1. parseMergeGroupGateArgs is dezelfde fail-closed tokenlezing als de rest van de CLI\'s', () => {
  const goed = ['--raw', 'a', '--merge-group', 'b', '--policy', 'c', '--evidence-complete', 'true'];
  assert.deepEqual(parseMergeGroupGateArgs(goed).ok, true);
  const goedFalse = ['--raw', 'a', '--merge-group', 'b', '--policy', 'c', '--evidence-complete', 'false'];
  assert.deepEqual(parseMergeGroupGateArgs(goedFalse).ok, true);
  const slecht = [
    [],
    ['--raw', 'a', '--merge-group', 'b'],
    ['--raw', 'a', '--merge-group', 'b', '--policy', 'c'],
    ['--raw', 'a', '--merge-group', 'b', '--policy', 'c', '--evidence-complete', 'true', '--onbekend', 'd'],
    ['--raw', 'a', '--raw', 'x', '--merge-group', 'b', '--policy', 'c', '--evidence-complete', 'true'],
    ['--raw', '', '--merge-group', 'b', '--policy', 'c', '--evidence-complete', 'true'],
    ['--raw', '--merge-group', '--merge-group', 'b', '--policy', 'c', '--evidence-complete', 'true'],
    // V21 (Gemini1 V20-bevinding, HIGH): --evidence-complete draagt een GESLOTEN allowlist —
    // elke waarde buiten letterlijk 'true'/'false' is even ongeldig als een ontbrekende sleutel.
    ['--raw', 'a', '--merge-group', 'b', '--policy', 'c', '--evidence-complete', 'TRUE'],
    ['--raw', 'a', '--merge-group', 'b', '--policy', 'c', '--evidence-complete', 'yes'],
    ['--raw', 'a', '--merge-group', 'b', '--policy', 'c', '--evidence-complete', ''],
    'string',
  ];
  for (const argv of slecht) assert.equal(parseMergeGroupGateArgs(argv).ok, false, JSON.stringify(argv));
});

const CODEX_SUCCESS_BODY = 'Codex Review: Didn\'t find any major issues. :tada:\n\n'
  + '**Reviewed commit:** `b9df1f8398`';

function schrijfPrMeting({ treeSha = PR_TREE, ownerBlokTreeSha = MERGE_GROUP_TREE, ownerBlokState = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'merge-group-pr-'));
  const owner = ownerBlokState === null
    ? { user: { login: 'rvanhooijdonk-png' }, body: ownerApprovalCommentBody(ownerBlokTreeSha) }
    : null;
  const files = { pr: null, headCommit: null, prCommits: [], issueComments: [], reviews: [], reviewComments: [], changedFiles: [] };
  files.pr = {
    number: PR_NUMBER, state: 'open', merged: false,
    head: { sha: PR_HEAD }, base: { sha: BASE, ref: 'main' },
    changed_files: 1, body: `task_id=${TASK_ID}\n`, user: { login: 'rvanhooijdonk-png' },
  };
  files.headCommit = { sha: PR_HEAD, tree: { sha: treeSha }, parents: [{ sha: BASE }] };
  files.issueComments = [
    { user: { login: 'chatgpt-codex-connector[bot]', id: CODEX_USER_ID, type: 'Bot' },
      performed_via_github_app: { id: 1144995 }, body: CODEX_SUCCESS_BODY },
  ];
  if (owner) files.issueComments.push(owner);
  files.reviews = [
    { user: { login: 'gemini-code-assist[bot]', id: GEMINI_USER_ID, type: 'Bot' },
      state: 'COMMENTED', commit_id: PR_HEAD, body: '## Code Review\n\nSchoon.' },
  ];
  if (ownerBlokState !== null) {
    files.reviews.push({
      user: { login: 'rvanhooijdonk-png' }, state: ownerBlokState, commit_id: PR_HEAD,
      body: ownerApprovalCommentBody(ownerBlokTreeSha),
    });
  }
  files.changedFiles = [{ filename: 'src/voorbeeld.js' }];
  for (const [sleutel, bestand] of Object.entries(PR_MEASUREMENT_FILES)) {
    writeFileSync(join(dir, bestand), JSON.stringify(files[sleutel]));
  }
  return dir;
}

function ownerApprovalCommentBody(treeSha) {
  const blok = {
    schema: OWNER_APPROVAL_SCHEMA, task_id: TASK_ID, head_sha: PR_HEAD, tree_sha: treeSha,
    pull_request: PR_NUMBER, base_sha: BASE, decision: 'APPROVE',
  };
  return '```autocoding-owner-approval-v1\n' + JSON.stringify(blok) + '\n```';
}

function schrijfMergeGroepMeting({ parents = [{ sha: BASE }, { sha: PR_HEAD }], baseSha = BASE, headRef = headRefFor() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'merge-group-mg-'));
  writeFileSync(join(dir, 'event.json'), JSON.stringify({ head_ref: headRef, base_sha: baseSha }));
  writeFileSync(join(dir, 'commit.json'), JSON.stringify({ parents, tree: { sha: MERGE_GROUP_TREE } }));
  return dir;
}

function schrijfPolicyBestand() {
  const dir = mkdtempSync(join(tmpdir(), 'merge-group-policy-'));
  const pad = join(dir, 'policy.v1.json');
  writeFileSync(pad, JSON.stringify(POLICY));
  return pad;
}

const lees = (pad) => readFileSync(pad, 'utf8');

test('C2. runMergeGroupGate: de volle weg van rauwe bewijsmappen naar GO, via buildShieldInput', () => {
  const raw = schrijfPrMeting({ ownerBlokTreeSha: MERGE_GROUP_TREE });
  const mergeGroup = schrijfMergeGroepMeting();
  const uitkomst = runMergeGroupGate({
    rawDir: raw, mergeGroupDir: mergeGroup, policy: POLICY, readFile: lees, evidenceComplete: true,
  });
  assert.equal(uitkomst.decision, MERGE_GROUP_GATE_DECISION.GO);
  assert.deepEqual(uitkomst.reasons, []);
  assert.equal(uitkomst.pull_request, PR_NUMBER);
});

test('C2a. runMergeGroupGate: evidenceComplete false blokkeert fail-closed vóór elke GO-check, ook '
  + 'met overigens volledig groen bewijs — de Gemini1 V20-bevinding (HIGH): een blokkerend '
  + 'review-/evidence-item buiten de paginagrens mag nooit stilzwijgend als afwezig gelden', () => {
  const raw = schrijfPrMeting({ ownerBlokTreeSha: MERGE_GROUP_TREE });
  const mergeGroup = schrijfMergeGroepMeting();
  const uitkomst = runMergeGroupGate({
    rawDir: raw, mergeGroupDir: mergeGroup, policy: POLICY, readFile: lees, evidenceComplete: false,
  });
  assert.equal(uitkomst.decision, MERGE_GROUP_GATE_DECISION.NO_GO);
  assert.deepEqual(uitkomst.reasons, [MERGE_GROUP_GATE_ERROR.EVIDENCE_INCOMPLETE]);
  assert.equal(uitkomst.pull_request, undefined);
});

test('C3. runMergeGroupGate: een owner-autorisatie die alleen aan de EIGEN PR-tree bindt is '
  + 'onvoldoende voor de merge-group-poort, ook via de volle CLI-weg', () => {
  const raw = schrijfPrMeting({ ownerBlokTreeSha: PR_TREE });
  const mergeGroup = schrijfMergeGroepMeting();
  const uitkomst = runMergeGroupGate({
    rawDir: raw, mergeGroupDir: mergeGroup, policy: POLICY, readFile: lees, evidenceComplete: true,
  });
  assert.equal(uitkomst.decision, MERGE_GROUP_GATE_DECISION.NO_GO);
  assert.ok(uitkomst.reasons.includes(MERGE_GROUP_REASON.MERGE_GROUP_TREE_AUTHORIZATION_MISSING));
});

test('C4. runMergeGroupGate: co-tenant-merge-group (drie ouders) blokkeert vóór enige bewijsherweging', () => {
  const raw = schrijfPrMeting({ ownerBlokTreeSha: MERGE_GROUP_TREE });
  const mergeGroup = schrijfMergeGroepMeting({ parents: [{ sha: BASE }, { sha: PR_HEAD }, { sha: OTHER_PR_HEAD }] });
  const uitkomst = runMergeGroupGate({
    rawDir: raw, mergeGroupDir: mergeGroup, policy: POLICY, readFile: lees, evidenceComplete: true,
  });
  assert.equal(uitkomst.decision, MERGE_GROUP_GATE_DECISION.NO_GO);
  assert.deepEqual(uitkomst.reasons, [MERGE_GROUP_REASON.MERGE_GROUP_PARENTS_NOT_TWO]);
});

test('C5. runMergeGroupGate: een DISMISSED eigenaarsreview via de volle CLI-weg blokkeert de poort', () => {
  const raw = schrijfPrMeting({ ownerBlokTreeSha: MERGE_GROUP_TREE, ownerBlokState: 'DISMISSED' });
  const mergeGroup = schrijfMergeGroepMeting();
  const uitkomst = runMergeGroupGate({
    rawDir: raw, mergeGroupDir: mergeGroup, policy: POLICY, readFile: lees, evidenceComplete: true,
  });
  assert.equal(uitkomst.decision, MERGE_GROUP_GATE_DECISION.NO_GO);
  assert.ok(uitkomst.reasons.includes(REASON.OWNER_APPROVAL_CARRIER_NOT_ACTIVE));
});

test('C6. runVerifyMergeGroupGate: precies één uitvoerregel, rc 0 bij GO en rc 1 bij NO_GO', async () => {
  const raw = schrijfPrMeting({ ownerBlokTreeSha: MERGE_GROUP_TREE });
  const mergeGroup = schrijfMergeGroepMeting();
  const argv = [
    '--raw', raw, '--merge-group', mergeGroup, '--policy', schrijfPolicyBestand(),
    '--evidence-complete', 'true',
  ];
  const regels = [];
  const origineel = console.log;
  console.log = (regel) => regels.push(regel);
  let rc;
  try {
    rc = await runVerifyMergeGroupGate(argv, { readFile: lees });
  } finally {
    console.log = origineel;
  }
  assert.equal(regels.length, 1, 'precies één uitvoerregel');
  assert.equal(rc, 0);
  assert.equal(JSON.parse(regels[0]).decision, MERGE_GROUP_GATE_DECISION.GO);
});

test('C7. runVerifyMergeGroupGate: onleesbare mappen zijn MEASUREMENT_UNREADABLE, geen crash', async () => {
  const argv = [
    '--raw', '/bestaat-niet', '--merge-group', '/bestaat-ook-niet', '--policy', schrijfPolicyBestand(),
    '--evidence-complete', 'true',
  ];
  const regels = [];
  const origineel = console.log;
  console.log = (regel) => regels.push(regel);
  let rc;
  try {
    rc = await runVerifyMergeGroupGate(argv, { readFile: lees });
  } finally {
    console.log = origineel;
  }
  assert.equal(rc, 1);
  assert.deepEqual(JSON.parse(regels[0]), {
    decision: MERGE_GROUP_GATE_DECISION.NO_GO, reasons: [MERGE_GROUP_GATE_ERROR.MEASUREMENT_UNREADABLE],
  });
});

test('C8. runVerifyMergeGroupGate: ongeldige argumenten worden geweigerd vóór er iets gelezen wordt', async () => {
  const regels = [];
  const origineel = console.log;
  console.log = (regel) => regels.push(regel);
  let rc;
  try {
    rc = await runVerifyMergeGroupGate(['--raw', 'a'], {
      readFile: () => { throw new Error('er mag hier niets gelezen worden'); },
    });
  } finally {
    console.log = origineel;
  }
  assert.equal(rc, 1);
  assert.deepEqual(JSON.parse(regels[0]), {
    decision: MERGE_GROUP_GATE_DECISION.NO_GO, reasons: [MERGE_GROUP_GATE_ERROR.ARGUMENTS_INVALID],
  });
});

test('R3. de gezonde weg door de volledige orkestratie: binding OK, bewijs OK → GO', () => {
  const result = evaluateMergeGroupCheck({
    headRef: headRefFor(), mergeGroupBaseSha: BASE, mergeGroupParents: [BASE, PR_HEAD],
    freshPullRequest: freshPullRequest(), mergeGroupTreeSha: MERGE_GROUP_TREE,
    evaluateShield, evaluateMergeAuthorizations,
    shieldContext: shieldContext(), policy: POLICY,
    shieldInput: {
      nativeEvidence: [codexEvidence(), geminiEvidence()],
      ownerApprovals: [ownerEnvelope({ treeSha: MERGE_GROUP_TREE })],
      sensitivePathsTouched: false, filesComplete: true,
    },
  });
  assert.equal(result.decision, 'GO');
  assert.equal(result.pullRequest, PR_NUMBER);
});
