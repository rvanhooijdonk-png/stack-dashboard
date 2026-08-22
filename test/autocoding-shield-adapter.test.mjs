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
  groupReviewComments, flattenPages, measureFilesCompleteness, FILES_API_LIMIT,
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
