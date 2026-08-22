/**
 * AUTOCODING_SHIELD — adaptertests.
 *
 * De fixtures in `test/fixtures/autocoding-shield/` zijn deterministische kopieën van de vorm die
 * `gh api` in de workflow oplevert (pagina-arrays uit `gh-bounded-pages.sh`). Ze bevatten bewust
 * tegelijk: geldig actueel vendorbewijs, bewijs van een VORIGE head, een gespoofd comment met exact
 * dezelfde succestekst, menselijk proza, een ownerreceipt en een gewijzigd gevoelig pad. Zo toetst
 * één set fixtures de hele adapter tegen alle ordergevallen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  buildShieldInput, buildCommitIndex, resolveCommitRef, extractTaskId, touchesSensitivePaths,
  groupReviewComments, flattenPages, measureFilesCompleteness, FILES_API_LIMIT,
  parseCollectArgs, COLLECT_VALUE_OPTIONS, resolveReviewCommit,
} from '../scripts/autocoding/collect-shield-input.mjs';
import { evaluateShield, bindNativeEvidence, REASON } from '../scripts/autocoding/verify-review-gate.mjs';

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

test('A2. de volledige fixtureset levert precies vijf bewijsstukken op — proza en spoof vallen weg', () => {
  const { shieldInput } = buildShieldInput(fixtureInput());
  // Vijf issue-comments en vier reviews in de fixture. Bewijs zijn: de twee echte Codex-comments,
  // de twee echte Gemini-reviews en de echte Codex-REVIEW met bevindingen. Per vendor wijst een
  // deel daarvan naar de vorige head. Proza, spoof en de menselijke review leveren niets op.
  assert.equal(shieldInput.nativeEvidence.length, 5);
  assert.deepEqual(
    shieldInput.nativeEvidence.map((e) => e.vendor).sort(),
    ['codex', 'codex', 'codex', 'gemini', 'gemini'],
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
  assert.deepEqual(heads, [PREV_HEAD, PREV_HEAD, HEAD].sort());
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

test('A7. de gewijzigde workflow markeert de PR als gevoelig en eist de owner-autorisatie', () => {
  const { shieldInput } = buildShieldInput(fixtureInput());
  assert.equal(shieldInput.sensitivePathsTouched, true);
  assert.equal(shieldInput.ownerApprovals.length, 1);
  assert.equal(shieldInput.ownerApprovals[0].transport_actor, 'rvanhooijdonk-png');
  assert.equal(shieldInput.ownerApprovals[0].source, 'issue_comment');
  assert.equal(shieldInput.ownerApprovals[0].review_state, null);
  // Het blok draagt zelf geen actorveld: er valt niets te verzinnen, de auteur komt uit de API.
  assert.deepEqual(Object.keys(shieldInput.ownerApprovals[0].approval).sort(),
    ['decision', 'head_sha', 'schema', 'task_id', 'tree_sha']);
});

test('A8. zonder owner-autorisatie is dezelfde gevoelige PR rood', () => {
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
  // Geen bestandslijst is ook geen VOLLEDIGE bestandslijst: dat is een eigen grond, geen bijvangst.
  assert.equal(shieldInput.filesComplete, false);
  assert.ok(r.reasons.includes(REASON.FILES_INCOMPLETE));
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

test('A13b. regelafsluiting: CRLF blijft werken en trailing witruimte wist de task-id niet meer', () => {
  // GEMETEN, niet aangenomen: `$` matcht in JS-multiline OOK vóór een `\r`, dus een kale CRLF-PR
  // werkte al. Wat wél stil faalde is een regel met trailing spatie/tab — dan matchte de oude
  // `/^task_id=(\S+)$/m` niet, en het gevolg was geen foutmelding maar een LEGE task-id, en dus
  // TASK_MISMATCH met een reden die naar de reviewer wees in plaats van naar de parser.
  assert.equal(extractTaskId('intro\r\ntask_id=ABC\r\nslot\r\n'), 'ABC');
  assert.equal(extractTaskId('task_id=ABC\r\n'), 'ABC');
  assert.equal(extractTaskId('task_id=ABC\r'), 'ABC');
  assert.equal(extractTaskId('task_id=ABC  \r\n'), 'ABC', 'trailing spaties wisten de task-id niet');
  assert.equal(extractTaskId('task_id=ABC\t\n'), 'ABC', 'trailing tab evenmin');
  // Een CR MIDDEN in de waarde eindigt de regel: `A\rB` is twee regels, dus de waarde is `A`.
  // Dat is geen defect maar de regeldefinitie zelf, en het blijft ongewijzigd.
  assert.equal(extractTaskId('task_id=A\rB\r\n'), 'A');
});

test('A14. gevoelige paden: LETTERLIJKE prefixmatch, met fail-closed bij ontbrekend zicht', () => {
  const prefixes = POLICY.owner_gate.sensitive_path_prefixes;
  assert.equal(touchesSensitivePaths([[{ filename: 'docs/README.md' }]], prefixes), false);
  assert.equal(touchesSensitivePaths([[{ filename: 'CONTROL/AUTOCODING/policy.v1.json' }]], prefixes), true);
  assert.equal(touchesSensitivePaths([[{ filename: '.github/workflows/x.yml' }]], prefixes), true);
  assert.equal(touchesSensitivePaths([], prefixes), true, 'geen bestandslijst => gevoelig');
  assert.equal(touchesSensitivePaths(null, prefixes), true);
  assert.equal(touchesSensitivePaths([[{ filename: 'docs/README.md' }]], []), true, 'geen prefixen => gevoelig');
});

test('A14a. een patroonachtige prefix matcht niet stilzwijgend niets maar maakt de PR gevoelig', () => {
  // Het contract is prefixmatching. Een waarde die eruitziet als een glob zou met `startsWith`
  // nergens op matchen — en dus de ownergate uitschakelen precies waar hij bedoeld was. Zulke
  // waarden worden daarom niet als prefix geteld; blijft er geen enkele veilige prefix over, dan
  // geldt de PR als gevoelig. (De policyvalidatie weigert zo'n policy bovendien helemaal.)
  const files = [[{ filename: 'docs/README.md' }]];
  for (const onveilig of ['.github/workflows/**', '*', '/etc/', '../', 'CONTROL/AUTOCODING/*']) {
    assert.equal(touchesSensitivePaths(files, [onveilig]), true, onveilig);
  }
  // Naast een onveilige waarde blijft een veilige prefix gewoon werken — geen match is geen match.
  assert.equal(touchesSensitivePaths(files, ['*', 'CONTROL/AUTOCODING/']), false);
  assert.equal(
    touchesSensitivePaths([[{ filename: 'CONTROL/AUTOCODING/policy.v1.json' }]], ['*', 'CONTROL/AUTOCODING/']),
    true,
  );
});

test('A14c. een RENAME telt op beide paden: `previous_filename` verbergt de gevoelige bron niet', () => {
  // Codex P1, inline 3834611208. De classificatie las alleen `filename`. Bij een rename van
  // `.github/workflows/gate.yml` naar een onbeschermd pad staat de GEVOELIGE bron in
  // `previous_filename` — en dan sloeg de ownergate over, precies bij de zwaarste wijziging die er
  // is: een workflow weghalen.
  const prefixes = POLICY.owner_gate.sensitive_path_prefixes;

  const weg = raw('files-renamed-away');
  const naartoe = raw('files-renamed-into');
  assert.equal(flattenPages(weg)[0].status, 'renamed');
  assert.equal(flattenPages(naartoe)[0].status, 'renamed');

  // Beide richtingen zijn gevoelig.
  assert.equal(touchesSensitivePaths(weg, prefixes), true, 'gevoelig => onbeschermd');
  assert.equal(touchesSensitivePaths(naartoe, prefixes), true, 'onbeschermd => gevoelig');

  // Het defect zelf, expliciet gereproduceerd: op alleen `filename` gelezen was de wegrename schoon.
  const alleenFilename = [flattenPages(weg).map(({ filename }) => ({ filename }))];
  assert.equal(touchesSensitivePaths(alleenFilename, prefixes), false);
});

test('A14d. de rename gaat door de volledige adapter heen en sluit de ownergate', () => {
  const zonderOwner = [
    flattenPages(raw('issue-comments')).filter((c) => c.user.login !== 'rvanhooijdonk-png'),
  ];
  for (const fixture of ['files-renamed-away', 'files-renamed-into']) {
    const pr = { ...raw('pr'), changed_files: 2 };
    const { context, shieldInput } = buildShieldInput(
      fixtureInput({ pr, changedFiles: raw(fixture), issueComments: zonderOwner }),
    );
    assert.equal(shieldInput.sensitivePathsTouched, true, fixture);
    const r = evaluateShield({ ...shieldInput, context, policy: POLICY });
    assert.equal(r.decision, 'NO_GO', fixture);
    assert.ok(r.reasons.includes(REASON.OWNER_GATE_REQUIRED), fixture);
  }
});

test('A14e. onbruikbare padvelden in een bestandsvermelding blijven fail-closed', () => {
  const prefixes = POLICY.owner_gate.sensitive_path_prefixes;
  // Een aanwezig maar ongeldig `previous_filename` is GEEN "dan maar alleen filename lezen".
  for (const kapot of [
    [[{ filename: 'docs/README.md', previous_filename: '' }]],
    [[{ filename: 'docs/README.md', previous_filename: 42 }]],
    [[{ filename: 'docs/README.md', previous_filename: {} }]],
    [[{ filename: '' }]],
    [[{ filename: 42 }]],
    [[{}]],
    [[null]],
    [['docs/README.md']],
    [[{ filename: 'docs/README.md' }, { status: 'renamed' }]],
  ]) {
    assert.equal(touchesSensitivePaths(kapot, prefixes), true, JSON.stringify(kapot));
  }
  // `previous_filename: null` is de normale vorm voor een niet-hernoemd bestand en blijft schoon.
  assert.equal(
    touchesSensitivePaths([[{ filename: 'docs/README.md', previous_filename: null }]], prefixes),
    false,
  );
});

test('A14b. de adapter geeft de DRAGER van een owner-autorisatie door, inclusief reviewstate', () => {
  // Een review draagt een state die na een dismiss verandert zonder dat het lichaam meebeweegt.
  // De adapter mag die state dus niet weggooien: de validator kan een ingetrokken autorisatie
  // anders niet van een actuele onderscheiden.
  const ownerBlok = flattenPages(raw('issue-comments'))
    .find((c) => c.user.login === 'rvanhooijdonk-png').body;
  const reviews = flattenPages(raw('reviews'));
  const alsReview = [[...reviews, {
    id: 4997700099,
    user: { login: 'rvanhooijdonk-png', id: 1, type: 'User' },
    state: 'DISMISSED',
    commit_id: HEAD,
    body: ownerBlok,
  }]];
  const { shieldInput } = buildShieldInput(fixtureInput({ reviews: alsReview }));
  assert.equal(shieldInput.ownerApprovals.length, 2);

  const uitComment = shieldInput.ownerApprovals.find((a) => a.source === 'issue_comment');
  assert.equal(uitComment.review_state, null, 'een issuecomment heeft geen state');
  const uitReview = shieldInput.ownerApprovals.find((a) => a.source === 'review');
  assert.equal(uitReview.review_state, 'DISMISSED');

  // De ingetrokken review telt niet mee; de actuele issuecomment nog wel, dus de PR blijft GO.
  const { context } = buildShieldInput(fixtureInput({ reviews: alsReview }));
  const r = evaluateShield({ ...shieldInput, context, policy: POLICY });
  assert.deepEqual(r, { decision: 'GO', reasons: [] });

  // Zonder die issuecomment blijft alléén de ingetrokken review over => de ownergate gaat dicht.
  const comments = flattenPages(raw('issue-comments'));
  const zonderOwnerComment = [comments.filter((c) => c.user.login !== 'rvanhooijdonk-png')];
  const alleenDismissed = buildShieldInput(
    fixtureInput({ reviews: alsReview, issueComments: zonderOwnerComment }),
  );
  assert.deepEqual(alleenDismissed.shieldInput.ownerApprovals.map((a) => a.review_state), ['DISMISSED']);
  const dicht = evaluateShield({
    ...alleenDismissed.shieldInput, context: alleenDismissed.context, policy: POLICY,
  });
  assert.equal(dicht.decision, 'NO_GO');
  assert.ok(dicht.reasons.includes(REASON.OWNER_GATE_REQUIRED));
  assert.ok(dicht.reasons.includes(REASON.OWNER_APPROVAL_CARRIER_NOT_ACTIVE));
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

test('A20. de bestandsoogst wordt tegen pr.changed_files gelegd, niet aangenomen', () => {
  // `/pulls/{n}/files` levert maximaal 3000 bestanden. Zonder deze meting ziet een afgekapte oogst
  // er precies zo uit als een kleine, schone PR — en zou een gevoelig pad buiten beeld kunnen vallen.
  const two = [[{ filename: 'a' }, { filename: 'b' }]];
  assert.deepEqual(measureFilesCompleteness(two, 2), { complete: true, collected: 2, expected: 2 });
  assert.equal(measureFilesCompleteness(two, 3).complete, false, 'minder verzameld dan gemeld');
  assert.equal(measureFilesCompleteness(two, 1).complete, false, 'meer verzameld dan gemeld');
  assert.equal(measureFilesCompleteness(two, undefined).complete, false, 'geen telling is geen zicht');
  assert.equal(measureFilesCompleteness(two, null).complete, false);
  assert.equal(measureFilesCompleteness(two, '2').complete, false, 'een string is geen telling');
  assert.equal(measureFilesCompleteness([], 0).complete, false, 'een PR zonder bestanden is geen bewijs');
  // Exact op de grens is nog volledig; erboven is per definitie afgekapt.
  const many = (n) => [Array.from({ length: n }, (_, i) => ({ filename: `f${i}` }))];
  assert.equal(measureFilesCompleteness(many(FILES_API_LIMIT), FILES_API_LIMIT).complete, true);
  assert.equal(measureFilesCompleteness(many(FILES_API_LIMIT + 1), FILES_API_LIMIT + 1).complete, false);
  // Een entry zonder bruikbare naam telt niet mee en veroorzaakt dus een ongelijkheid.
  assert.equal(measureFilesCompleteness([[{ filename: 'a' }, { status: 'added' }]], 2).complete, false);
});

test('A21. afgekapte bestandsdata is NO_GO én gevoelig — nooit een ownergate-vrijstelling', () => {
  const pr = { ...raw('pr'), changed_files: 4000 };
  const { context, shieldInput } = buildShieldInput(fixtureInput({ pr }));
  assert.equal(shieldInput.filesComplete, false);
  const r = evaluateShield({ ...shieldInput, context, policy: POLICY });
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.FILES_INCOMPLETE));

  // En zelfs met een niet-gevoelige bestandslijst blijft de ownergate gelden zolang het zicht
  // onvolledig is: onbekend is nooit onschuldig.
  const onzichtbaar = buildShieldInput(fixtureInput({
    pr, changedFiles: [[{ filename: 'docs/README.md' }]],
  }));
  assert.equal(onzichtbaar.shieldInput.sensitivePathsTouched, false);
  const zonderOwner = evaluateShield({
    ...onzichtbaar.shieldInput, ownerApprovals: [], context: onzichtbaar.context, policy: POLICY,
  });
  assert.ok(zonderOwner.reasons.includes(REASON.OWNER_GATE_REQUIRED));
  assert.ok(zonderOwner.reasons.includes(REASON.FILES_INCOMPLETE));
});

test('A22. de Codex-REVIEW met inline bevindingen wordt als bewijs verzameld, niet gemist', () => {
  // Gemeten op PR #74: Codex leverde bevindingen als `pull_request_review` met inline comments,
  // terwijl de adapter Codex alleen uit issuecomments haalde. Die ronde was daardoor onzichtbaar.
  const { shieldInput } = buildShieldInput(fixtureInput());
  const review = shieldInput.nativeEvidence.find(
    (e) => e.vendor === 'codex' && e.extra_reasons.includes(REASON.NATIVE_FINDINGS_PRESENT),
  );
  assert.ok(review, 'de Codex-review moet een bewijsstuk opleveren');
  assert.equal(review.verdict, 'NO_GO');
  assert.equal(review.identity_verified, true, 'reviews dragen geen app-id; login/id/type zijn gepind');
  assert.equal(review.resolved_head_sha, PREV_HEAD, 'commit_id is een API-veld en gaat voor');
});

test('A23. een Codex-review met bevindingen op de ACTUELE head maakt die vendorronde rood', () => {
  const reviews = flattenPages(raw('reviews')).map(
    (r) => (r.user.login === 'chatgpt-codex-connector[bot]' ? { ...r, commit_id: HEAD } : r),
  );
  const { context, shieldInput } = buildShieldInput(fixtureInput({ reviews: [reviews] }));
  const r = evaluateShield({ ...shieldInput, context, policy: POLICY });
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.NATIVE_FINDINGS_PRESENT));
  // Het schone Codex-issuecomment op dezelfde head heft de bevindingen niet op.
  assert.ok(shieldInput.nativeEvidence.some(
    (e) => e.vendor === 'codex' && e.verdict === 'GO' && e.resolved_head_sha === HEAD,
  ));
});

test('A24. een gespoofde bot-identiteit met de juiste login faalt op de numerieke user-ID', () => {
  // Een login is hernoembaar, een numerieke user-ID niet. Beide routes (issuecomment én review)
  // moeten daarop pinnen, anders is er een route waarlangs een hernoemd account bewijs levert.
  const spoof = (item) => (item.user.login === 'chatgpt-codex-connector[bot]'
    ? { ...item, user: { ...item.user, id: 1 } } : item);
  const { context, shieldInput } = buildShieldInput(fixtureInput({
    issueComments: [flattenPages(raw('issue-comments')).map(spoof)],
    reviews: [flattenPages(raw('reviews')).map(spoof)],
  }));
  const codex = shieldInput.nativeEvidence.filter((e) => e.vendor === 'codex' && e.identity_verified);
  assert.equal(codex.length, 0, 'een verkeerde user-ID levert nooit een geverifieerde identiteit op');
  const r = evaluateShield({ ...shieldInput, context, policy: POLICY });
  assert.equal(r.decision, 'NO_GO');
  assert.ok(r.reasons.includes(REASON.NATIVE_IDENTITY_UNVERIFIED));
});

test('A25. de adapter scheidt een leesfout van een schrijffout', () => {
  // Beide faalden eerder onder dezelfde code. Een onleesbaar API-antwoord en een niet-schrijfbaar
  // uitvoerpad zijn verschillende defecten; ze in één code samenvatten stuurt de diagnose weg van
  // de oorzaak.
  const dir = mkdtempSync(join(tmpdir(), 'shield-adapter-'));
  const rawDir = join(dir, 'raw');
  mkdirSync(rawDir);
  cpSync(FIXTURES, rawDir, { recursive: true });

  const unwritable = spawnSync(process.execPath, [
    'scripts/autocoding/collect-shield-input.mjs', '--raw', rawDir, '--policy',
    'CONTROL/AUTOCODING/policy.v1.json',
    '--out-context', join(dir, 'bestaat-niet', 'c.json'),
    '--out-shield-input', join(dir, 's.json'),
  ], { encoding: 'utf8' });
  assert.equal(unwritable.status, 1);
  assert.match(unwritable.stdout, /COLLECT_OUTPUT_UNWRITABLE/);
  assert.doesNotMatch(unwritable.stdout, /COLLECT_RAW_INPUT_UNREADABLE/);
});

/**
 * A26. De CLI-argumentgrens van de adapter. Twee van de vier sleutels zijn SCHRIJFpaden, dus een
 * stille verschuiving legt het bewijsbestand ergens anders neer dan de beslisser leest. Deze test
 * meet daarom niet alleen de exitcode, maar ook dat er bij een weigering GEEN enkel uitvoerbestand
 * ontstaat — een half geschreven oogst zou als een echte oogst gelezen kunnen worden.
 */
test('A26. onleesbare argv eindigt nonzero en schrijft geen enkel uitvoerbestand', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shield-adapter-argv-'));
  const rawDir = join(dir, 'raw');
  mkdirSync(rawDir);
  cpSync(FIXTURES, rawDir, { recursive: true });
  const POLICY_PATH = 'CONTROL/AUTOCODING/policy.v1.json';

  let teller = 0;
  const run = (bouw) => {
    teller += 1;
    const outContext = join(dir, `c${teller}.json`);
    const outShieldInput = join(dir, `s${teller}.json`);
    const cli = spawnSync(process.execPath, [
      'scripts/autocoding/collect-shield-input.mjs', ...bouw(outContext, outShieldInput),
    ], { encoding: 'utf8' });
    return { cli, outContext, outShieldInput };
  };

  const goedeArgv = (c, s) => [
    '--raw', rawDir, '--policy', POLICY_PATH, '--out-context', c, '--out-shield-input', s,
  ];
  const groen = run(goedeArgv);
  assert.equal(groen.cli.status, 0, groen.cli.stdout + groen.cli.stderr);
  assert.equal(existsSync(groen.outContext), true);
  assert.equal(existsSync(groen.outShieldInput), true);

  const kwaad = {
    'onbekende optie': (c, s) => [...goedeArgv(c, s), '--onbekend', 'x'],
    'onbekend los token': (c, s) => [...goedeArgv(c, s), 'x'],
    'dubbele optie': (c, s) => [...goedeArgv(c, s), '--raw', rawDir],
    'ontbrekende waarde': (c, s) => [...goedeArgv(c, s), '--policy'],
    'oneven argv': (c) => ['--raw', rawDir, '--policy', POLICY_PATH, '--out-context', c, '--out-shield-input'],
    'optie als waarde': (c, s) => ['--raw', '--policy', '--policy', POLICY_PATH, '--out-context', c, '--out-shield-input', s],
    'lege waarde': (c, s) => ['--raw', '', '--policy', POLICY_PATH, '--out-context', c, '--out-shield-input', s],
  };
  for (const [naam, bouw] of Object.entries(kwaad)) {
    const { cli, outContext, outShieldInput } = run(bouw);
    assert.equal(cli.status, 1, `${naam} moet nonzero eindigen`);
    assert.equal(cli.stderr, '', naam);
    assert.match(cli.stdout, /^COLLECT_ARGS_INVALID\n$/, naam);
    assert.equal(existsSync(outContext), false, `${naam} schreef alsnog een context`);
    assert.equal(existsSync(outShieldInput), false, `${naam} schreef alsnog een shield-input`);
  }

  // Een argv die wél te lezen is maar een vereiste sleutel mist, is een ANDER defect en houdt zijn
  // eigen code — zodat de diagnose niet naar een vormfout wordt gestuurd.
  const ontbrekend = run((c) => ['--raw', rawDir, '--policy', POLICY_PATH, '--out-context', c]);
  assert.equal(ontbrekend.cli.status, 1);
  assert.match(ontbrekend.cli.stdout, /^COLLECT_ARGS_MISSING\n$/);
  assert.equal(existsSync(ontbrekend.outContext), false);
});

test('A27. parseCollectArgs weigert per vorm en scheidt vormfout van ontbrekende sleutel', () => {
  assert.deepEqual(
    [...COLLECT_VALUE_OPTIONS].sort(),
    ['--out-context', '--out-shield-input', '--policy', '--raw'],
    'de toegestane verzameling is gesloten en expliciet',
  );
  const goed = ['--raw', 'r', '--policy', 'p', '--out-context', 'c', '--out-shield-input', 's'];
  assert.equal(parseCollectArgs(goed).ok, true);
  for (const argv of [
    [...goed, '--onbekend', 'x'],
    [...goed, 'x'],
    [...goed, '--raw', 'r2'],
    [...goed, '--policy'],
    goed.slice(0, 7),
    ['--raw', '--policy', '--policy', 'p', '--out-context', 'c', '--out-shield-input', 's'],
    ['--raw', '', '--policy', 'p', '--out-context', 'c', '--out-shield-input', 's'],
    ['--dry-run', ...goed],
  ]) {
    assert.deepEqual(parseCollectArgs(argv), { ok: false, error: 'COLLECT_ARGS_INVALID' }, String(argv));
  }
  for (const argv of [[], goed.slice(0, 6), null]) {
    assert.deepEqual(parseCollectArgs(argv), { ok: false, error: 'COLLECT_ARGS_MISSING' }, String(argv));
  }
});


// --- De reviewbinding: API-veld, lichaam, of niets ------------------------------------------------

const CODEX_SUCCES = "Codex Review: Didn't find any major issues. :tada:";

/**
 * Vervangt de Codex-review in de fixtureset door één review met een gekozen `commit_id` en lichaam,
 * en levert het bewijsstuk dat de adapter eruit haalt. `commit_id: undefined` betekent hier het
 * werkelijk ONTBREKENDE veld: de sleutel wordt dan uit het object weggelaten, niet op undefined
 * gezet, zodat de vorm gelijk is aan wat GitHub levert als er geen binding is.
 */
function codexReviewBewijs({ commit_id, bodyRef, inline = false }) {
  const review = {
    id: 999000001,
    user: { login: 'chatgpt-codex-connector[bot]', id: 199175422, type: 'Bot' },
    state: 'COMMENTED',
    body: `${inline ? '### 💡 Codex Review' : CODEX_SUCCES}\n\n**Reviewed commit:** \`${bodyRef}\``,
  };
  if (commit_id !== undefined) review.commit_id = commit_id;
  const { context, shieldInput } = buildShieldInput(fixtureInput({ reviews: [[review]] }));
  const bewijs = shieldInput.nativeEvidence.filter((e) => e.vendor === 'codex' && e.claimed_actor === review.user.login);
  return { context, bewijs: bewijs[bewijs.length - 1] };
}

test('A28. de reviewbinding is drieledig: aanwezig-maar-onoplosbaar valt NOOIT terug op het lichaam', () => {
  // Codex-review 3835094262 op deze PR: met `api ?? body` verving een MISLUKTE resolutie van een
  // aanwezig `commit_id` de gezaghebbende API-binding door de "Reviewed commit"-regel uit het
  // lichaam. Na een force-push verdwijnt de gereviewde commit uit de PR-index, dus resolveerde het
  // API-veld niet meer — en precies dan ging de zelfgerapporteerde regel wegen. Een review die
  // aantoonbaar op een verdwenen commit was geschreven, kon zo aan de ACTUELE head binden.

  // 1. `commit_id` ONTBREEKT werkelijk => het mechanisch geresolveerde lichaam is de enige binding.
  const zonderApi = codexReviewBewijs({ commit_id: undefined, bodyRef: HEAD.slice(0, 10) });
  assert.equal(zonderApi.bewijs.resolved_head_sha, HEAD, 'zonder API-veld telt de geresolveerde regel');
  assert.equal(zonderApi.bewijs.verdict, 'GO');
  assert.deepEqual(bindNativeEvidence(zonderApi.bewijs, zonderApi.context).reasons, [],
    'en dan is het een geldige actuele ronde');

  // 2. `commit_id` AANWEZIG maar onbekend in deze PR (de force-pushvorm), lichaam claimt de actuele
  //    head => onopgelost blijft onopgelost. Dit is de kern van de bevinding.
  const stale = codexReviewBewijs({ commit_id: 'a'.repeat(40), bodyRef: HEAD.slice(0, 10) });
  assert.equal(stale.bewijs.resolved_head_sha, '', 'geen terugval op de tekstclaim');
  assert.equal(stale.bewijs.resolved_tree_sha, '');
  assert.ok(bindNativeEvidence(stale.bewijs, stale.context).reasons.includes(REASON.STALE_HEAD),
    'en onopgelost bewijs haalt de headvergelijking nooit');

  // 3. Dezelfde regel voor elke andere vorm van AANWEZIG-maar-onbruikbaar: een leeg veld, een
  //    verkeerd type, en een dubbelzinnige prefix die op twee PR-commits past.
  for (const kapot of ['', 42, {}, [], true, 'geen-sha', HEAD.slice(0, 3)]) {
    const b = codexReviewBewijs({ commit_id: kapot, bodyRef: HEAD.slice(0, 10) });
    assert.equal(b.bewijs.resolved_head_sha, '', `commit_id=${JSON.stringify(kapot)}`);
  }

  // 4. `commit_id` AANWEZIG en oplosbaar => de API wint, ook als het lichaam iets anders beweert.
  const apiWint = codexReviewBewijs({ commit_id: HEAD, bodyRef: PREV_HEAD.slice(0, 10) });
  assert.equal(apiWint.bewijs.resolved_head_sha, HEAD, 'het API-veld gaat vóór de tekstclaim');
  assert.deepEqual(bindNativeEvidence(apiWint.bewijs, apiWint.context).reasons, []);

  // En andersom: een API-veld op de VORIGE head bindt daar, hoe actueel het lichaam ook klinkt.
  const apiStale = codexReviewBewijs({ commit_id: PREV_HEAD, bodyRef: HEAD.slice(0, 10) });
  assert.equal(apiStale.bewijs.resolved_head_sha, PREV_HEAD);
  assert.ok(bindNativeEvidence(apiStale.bewijs, apiStale.context).reasons.includes(REASON.STALE_HEAD));
});

test('A28b. resolveReviewCommit onderscheidt ontbrekend van leeg, en kent geen enkele andere bron', () => {
  const index = buildCommitIndex({
    prCommits: raw('pr-commits'), headSha: HEAD, headCommit: raw('head-commit'),
  });
  const lichaam = `**Reviewed commit:** \`${HEAD.slice(0, 10)}\``;

  // Alleen deze twee vormen zijn ONTBREKEND. Alles anders is aanwezig.
  assert.equal(resolveReviewCommit({ body: lichaam }, index).head_sha, HEAD);
  assert.equal(resolveReviewCommit({ commit_id: null, body: lichaam }, index).head_sha, HEAD);
  assert.equal(resolveReviewCommit({ commit_id: undefined, body: lichaam }, index).head_sha, HEAD);

  // Aanwezig en onbruikbaar => null, ongeacht wat het lichaam zegt.
  for (const aanwezig of ['', '   ', 0, false, NaN, 'zzzzzzz', 'b'.repeat(40)]) {
    assert.equal(resolveReviewCommit({ commit_id: aanwezig, body: lichaam }, index), null,
      JSON.stringify(String(aanwezig)));
  }

  // Aanwezig en oplosbaar => de API, nooit het lichaam.
  assert.equal(resolveReviewCommit({ commit_id: PREV_HEAD, body: lichaam }, index).head_sha, PREV_HEAD);

  // Zonder bruikbaar lichaam levert de ontbrekende vorm evengoed niets op — de terugval is een
  // MECHANISCHE resolutie, geen vrijbrief.
  assert.equal(resolveReviewCommit({ body: '**Reviewed commit:** `c9c9c9c9c9`' }, index), null);
  assert.equal(resolveReviewCommit({ body: 'geen regel' }, index), null);
  assert.equal(resolveReviewCommit(null, index), null);
});

// --- De gemeten Codex-succesvorm: twee feestwoorden, één betekenis ---------------------------------

/**
 * A29. Codex schrijft achter zijn schone eerste zin een wisselend feestwoord: `:tada:` op PR #72
 * (comment 5376132338), `Swish!` op PR #74 (comment 5378185484). De fixtureset draagt daarom nu
 * beide vormen — de ACTUELE head de live `Swish!`-vorm, de vorige ronde de oudere `:tada:`-vorm —
 * en de hele keten van ruwe API-oogst tot einduitspraak moet ze allebei als bewijs dragen.
 */
test('A29. de adapter draagt beide gemeten Codex-succesvormen door de hele keten', () => {
  const comments = flattenPages(raw('issue-comments'));
  const bot = comments.filter((c) => c.user.login === 'chatgpt-codex-connector[bot]');
  assert.ok(bot.some((c) => c.body.startsWith("Codex Review: Didn't find any major issues. Swish!")),
    'de fixture draagt de live vorm');
  assert.ok(bot.some((c) => c.body.startsWith("Codex Review: Didn't find any major issues. :tada:")),
    'en de eerder gemeten vorm blijft staan');

  const { context, shieldInput } = buildShieldInput(fixtureInput());
  // Beide commentrondes leveren een GO-bewijsstuk: de live vorm op de ACTUELE head, de oudere vorm
  // op de vorige. De derde Codex-bewijsvorm in de fixture is de REVIEW met bevindingen en blijft
  // terecht NO_GO — die draagt geen succesvorm.
  const codexGo = shieldInput.nativeEvidence.filter((e) => e.vendor === 'codex' && e.verdict === 'GO');
  assert.deepEqual(codexGo.map((e) => e.resolved_head_sha).sort(), [HEAD, PREV_HEAD].sort());
  for (const e of codexGo) assert.deepEqual(e.extra_reasons, [], 'geen enkele vorm ketst op de marker af');
  assert.deepEqual(evaluateShield({ ...shieldInput, context, policy: POLICY }), { decision: 'GO', reasons: [] });

  // Wissel de twee vormen om: welke ronde welk feestwoord droeg mag de uitkomst niet raken.
  const omgewisseld = [comments.map((c) => (c.user.login === 'chatgpt-codex-connector[bot]'
    ? { ...c, body: c.body.replace('. Swish!', '. :tada:X').replace('. :tada:', '. Swish!').replace('. :tada:X', '. :tada:') }
    : c))];
  const gewisseld = buildShieldInput(fixtureInput({ issueComments: omgewisseld }));
  assert.deepEqual(
    evaluateShield({ ...gewisseld.shieldInput, context: gewisseld.context, policy: POLICY }),
    { decision: 'GO', reasons: [] },
  );
});

test('A30. de live succesvorm zonder identiteit, binding of schone ronde blijft rood', () => {
  const comments = flattenPages(raw('issue-comments'));
  const live = comments.find((c) => c.user.login === 'chatgpt-codex-connector[bot]' && c.body.includes('Swish!'));

  // 1. Dezelfde live tekst van een andere actor of via een andere App => geen bewijsstuk.
  for (const vervalst of [
    { ...live, user: { login: 'aanvaller', id: 6666, type: 'User' } },
    { ...live, performed_via_github_app: { id: 999 } },
  ]) {
    const vervangen = [comments.map((c) => (c.id === live.id ? vervalst : c))];
    const { context, shieldInput } = buildShieldInput(fixtureInput({ issueComments: vervangen }));
    const r = evaluateShield({ ...shieldInput, context, policy: POLICY });
    assert.equal(r.decision, 'NO_GO', JSON.stringify(vervalst.user.login));
  }

  // 2. Live tekst zonder `**Reviewed commit:**`-regel => niets om mechanisch aan te binden, dus
  //    geen actueel bewijs. De schone zin alleen bindt aan geen enkele head.
  const zonderRegel = [comments.map((c) => (c.id === live.id
    ? { ...c, body: "Codex Review: Didn't find any major issues. Swish!" }
    : c))];
  const los = buildShieldInput(fixtureInput({ issueComments: zonderRegel }));
  const losBewijs = los.shieldInput.nativeEvidence.find((e) => e.vendor === 'codex' && e.resolved_head_sha === '');
  assert.ok(losBewijs, 'het bewijsstuk bestaat, maar bindt aan niets');
  assert.ok(bindNativeEvidence(losBewijs, los.context).reasons.includes(REASON.STALE_HEAD));
  const rLos = evaluateShield({ ...los.shieldInput, context: los.context, policy: POLICY });
  assert.equal(rLos.decision, 'NO_GO');
  assert.ok(rLos.reasons.includes(REASON.INSUFFICIENT_GO));

  // 3. Near-miss semantiek op de actuele head => de vendor mist zijn schone ronde.
  const bijna = [comments.map((c) => (c.id === live.id
    ? { ...c, body: c.body.replace('major issues. Swish!', 'major issues, op één na. Swish!') }
    : c))];
  const nb = buildShieldInput(fixtureInput({ issueComments: bijna }));
  const rBijna = evaluateShield({ ...nb.shieldInput, context: nb.context, policy: POLICY });
  assert.equal(rBijna.decision, 'NO_GO');
  assert.ok(rBijna.reasons.includes(REASON.NATIVE_TERMINAL_MARKER_MISSING));
});
