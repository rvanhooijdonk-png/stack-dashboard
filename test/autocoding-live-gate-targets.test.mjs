/**
 * AUTOCODING_SHIELD — doelselectie en ronde-afhandeling van de trusted statuswriter.
 *
 * De writer wordt niet meer direct door een PR-, comment- of reviewevent gestart maar door
 * `workflow_run` (na de onprivileged shield) en `schedule`. Daarmee verschuift het risico: de
 * aanleiding zegt niets betrouwbaars meer over WELKE pull request gemeten moet worden, en de
 * bronrun kan een door een PR geleverde definitie hebben gehad. Twee eigenschappen worden hier
 * daarom gemeten in plaats van beloofd:
 *
 *   1. De doel-PR's komen uit een read-only API-lijst, niet uit de eventpayload. De payload mag die
 *      lijst hooguit versmallen tot één eenduidige treffer.
 *   2. Eén kapotte PR maakt de ronde rood maar stopt hem niet — anders zou de eerste kapotte PR alle
 *      andere statussen stale laten staan. Die eigenschap zit in de shell van het workflowbestand,
 *      dus wordt die shell hier echt uitgevoerd met gestubde `gh` en `node`.
 *   3. Alle aanleidingen delen één writerlock, zodat een oudere momentopname nooit ná een nieuwere
 *      op dezelfde statuscontext kan publiceren.
 *   4. De ronde kent geen bovengrens op het aantal open PR's: een weigering zou nul statussen
 *      publiceren en een eerder groene head groen laten staan.
 *
 * Bij 3 en 4 hoort een negatieve mutatie: de OUDE vorm wordt hier teruggezet en er wordt gemeten dat
 * die zich fout gedraagt. Zonder dat bewijs zegt een groene test niet dat hij de regressie vangt.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  selectTargets, isTrustedWorkflowRunSource, normaliseOpenPullRequests, parseTargetArgs, runSelect,
  EXPECTED_SOURCE, HEAD_BOUND_SOURCE_EVENTS, TARGET_OUTCOME, TARGET_REASON, TARGET_SELECTION,
} from '../scripts/autocoding/select-live-gate-targets.mjs';

const SELECTOR = 'scripts/autocoding/select-live-gate-targets.mjs';

const TRUSTED_WRITER = '.github/workflows/autocoding-shield-live-gate.yml';

const sha = (n) => String(n).repeat(40).slice(0, 40).replace(/[^0-9a-f]/g, '0');

function openPr(number, { headSha, headRef } = {}) {
  return {
    number,
    head: { sha: headSha ?? sha(number === 1 ? 'a' : number), ref: headRef ?? `branch-${number}` },
  };
}

function shieldRun(overrides = {}) {
  return {
    name: EXPECTED_SOURCE.workflowName,
    path: EXPECTED_SOURCE.workflowPath,
    event: 'pull_request',
    head_sha: sha(2),
    head_branch: 'branch-2',
    ...overrides,
  };
}

// --- Bronbegrenzing -----------------------------------------------------------------------------

test('S1. alleen de verwachte shieldrun op het verwachte pad en bronevent telt als aanleiding', () => {
  assert.equal(isTrustedWorkflowRunSource(shieldRun()), true);
  for (const event of EXPECTED_SOURCE.events) {
    assert.equal(isTrustedWorkflowRunSource(shieldRun({ event })), true, event);
  }
  // Een gelijknamige workflow op een ANDER pad is precies wat een PR kan toevoegen.
  assert.equal(isTrustedWorkflowRunSource(shieldRun({ path: '.github/workflows/nep.yml' })), false);
  assert.equal(isTrustedWorkflowRunSource(shieldRun({ name: 'publish' })), false);
  assert.equal(isTrustedWorkflowRunSource(shieldRun({ event: 'workflow_dispatch' })), false);
  assert.equal(isTrustedWorkflowRunSource(shieldRun({ event: 'push' })), false);
  for (const kapot of [null, undefined, 'autocoding-shield', [], 42]) {
    assert.equal(isTrustedWorkflowRunSource(kapot), false, String(kapot));
  }
});

test('S2. een onverwachte bron publiceert niets en is geen fout van deze poort', () => {
  const result = selectTargets({
    eventName: 'workflow_run',
    workflowRun: shieldRun({ name: 'publish' }),
    openPullRequests: [openPr(2)],
  });
  assert.equal(result.outcome, TARGET_OUTCOME.NO_OP);
  assert.equal(result.reason, TARGET_REASON.SOURCE_NOT_TRUSTED);
  assert.deepEqual(result.targets, []);

  // Een event dat de workflow helemaal niet kent, betekent dat bestand en script uit elkaar zijn
  // gelopen. Dat is een defect en wordt rood, niet stil.
  for (const eventName of ['pull_request_review', 'issue_comment', 'pull_request', '']) {
    const drift = selectTargets({ eventName, workflowRun: shieldRun(), openPullRequests: [] });
    assert.equal(drift.outcome, TARGET_OUTCOME.FAIL, eventName);
    assert.equal(drift.reason, TARGET_REASON.EVENT_NOT_SUPPORTED, eventName);
  }
});

// --- Doelbepaling -------------------------------------------------------------------------------

test('S3. de hint versmalt alleen bij een eenduidige treffer, en voegt nooit een PR toe', () => {
  const open = [openPr(2), openPr(3)];

  const opSha = selectTargets({ eventName: 'workflow_run', workflowRun: shieldRun(), openPullRequests: open });
  assert.equal(opSha.selection, TARGET_SELECTION.HINT_MATCHED_HEAD_SHA);
  assert.deepEqual(opSha.targets, [2]);

  // Head verschoven sinds de bronrun: de SHA matcht niet meer, de branch wel.
  const opBranch = selectTargets({
    eventName: 'workflow_run',
    workflowRun: shieldRun({ head_sha: sha(9) }),
    openPullRequests: open,
  });
  assert.equal(opBranch.selection, TARGET_SELECTION.HINT_MATCHED_HEAD_BRANCH);
  assert.deepEqual(opBranch.targets, [2]);

  // Een hint die naar een gesloten of onbekende PR wijst mag die PR niet toevoegen; hij levert een
  // volledige ronde over de open PR's op.
  const onbekend = selectTargets({
    eventName: 'workflow_run',
    workflowRun: shieldRun({ head_sha: sha(9), head_branch: 'weg' }),
    openPullRequests: open,
  });
  assert.equal(onbekend.selection, TARGET_SELECTION.ALL_OPEN_PULL_REQUESTS);
  assert.deepEqual(onbekend.targets, [2, 3]);

  // Twee open PR's met dezelfde branchnaam (fork + eigen branch) zijn niet eenduidig.
  const dubbel = selectTargets({
    eventName: 'workflow_run',
    workflowRun: shieldRun({ head_sha: sha(9) }),
    openPullRequests: [openPr(2), openPr(3, { headRef: 'branch-2' })],
  });
  assert.equal(dubbel.selection, TARGET_SELECTION.ALL_OPEN_PULL_REQUESTS);
  assert.deepEqual(dubbel.targets, [2, 3]);
});

test('S4. issue_comment- en schedule-aanleidingen meten alle open PR\'s', () => {
  const open = [openPr(7), openPr(2), openPr(4)];

  // Een `issue_comment` draait de shield op de default branch, dus wijst de hint naar `main` en
  // niet naar de becommentarieerde PR. Precies daarom bestaat de volledige ronde.
  const naComment = selectTargets({
    eventName: 'workflow_run',
    workflowRun: shieldRun({ event: 'issue_comment', head_sha: sha(0), head_branch: 'main' }),
    openPullRequests: open,
  });
  assert.equal(naComment.selection, TARGET_SELECTION.ALL_OPEN_PULL_REQUESTS);
  assert.deepEqual(naComment.targets, [2, 4, 7]);

  const gepland = selectTargets({ eventName: 'schedule', workflowRun: undefined, openPullRequests: open });
  assert.equal(gepland.outcome, TARGET_OUTCOME.MEASURE);
  assert.deepEqual(gepland.targets, [2, 4, 7]);

  // Geen open PR's is een geldige lege ronde, geen fout.
  const leeg = selectTargets({ eventName: 'schedule', openPullRequests: [] });
  assert.equal(leeg.outcome, TARGET_OUTCOME.MEASURE);
  assert.deepEqual(leeg.targets, []);
});

test('S4b. een issue_comment-hint versmalt nooit, ook niet als hij precies één PR aanwijst', () => {
  // Live gereproduceerd: een commentrun draagt de head van de default branch. Staat er precies één
  // open fork-PR met `head.ref=main` (en dus ook diens `head.sha`), dan MATCHT de hint eenduidig —
  // op de verkeerde PR. Versmallen zou hier PR 74 zonder verse status laten. Beide hintvelden wijzen
  // in deze opstelling naar PR 75; de eis is dat 74 én 75 gemeten worden.
  const forkOpMain = openPr(75, { headSha: sha(5), headRef: 'main' });
  const open = [openPr(74, { headRef: 'claude2/autocoding-live-gate-completion-20260822' }), forkOpMain];
  const naComment = selectTargets({
    eventName: 'workflow_run',
    workflowRun: shieldRun({ event: 'issue_comment', head_sha: sha(5), head_branch: 'main' }),
    openPullRequests: open,
  });
  assert.equal(naComment.outcome, TARGET_OUTCOME.MEASURE);
  assert.equal(naComment.selection, TARGET_SELECTION.ALL_OPEN_PULL_REQUESTS);
  assert.deepEqual(naComment.targets, [74, 75]);

  // De hint blijft wél gelden waar GitHub de bronrun echt aan één PR-head bindt. Zonder die
  // versmalling zou elke review een volledige ronde kosten; mét een niet-gebonden bronevent erbij
  // zou hij de verkeerde PR meten. Beide eigenschappen zitten in dezelfde lijst.
  assert.deepEqual([...HEAD_BOUND_SOURCE_EVENTS], ['pull_request', 'pull_request_review']);
  for (const event of HEAD_BOUND_SOURCE_EVENTS) {
    const gebonden = selectTargets({
      eventName: 'workflow_run',
      workflowRun: shieldRun({ event, head_sha: sha(5), head_branch: 'main' }),
      openPullRequests: open,
    });
    assert.equal(gebonden.selection, TARGET_SELECTION.HINT_MATCHED_HEAD_SHA, event);
    assert.deepEqual(gebonden.targets, [75], event);
  }

  // Elk vertrouwd bronevent dat niet head-gebonden is, meet de volledige lijst — ook als er later
  // een bronevent bij komt dat wél een eenduidige treffer oplevert.
  for (const event of EXPECTED_SOURCE.events.filter((e) => !HEAD_BOUND_SOURCE_EVENTS.includes(e))) {
    const ongebonden = selectTargets({
      eventName: 'workflow_run',
      workflowRun: shieldRun({ event, head_sha: sha(5), head_branch: 'main' }),
      openPullRequests: open,
    });
    assert.equal(ongebonden.selection, TARGET_SELECTION.ALL_OPEN_PULL_REQUESTS, event);
    assert.deepEqual(ongebonden.targets, [74, 75], event);
  }
});

test('S5. de volledige ronde kent geen bovengrens en truncateert nooit stilzwijgend', () => {
  // De oude `OPEN_PULL_REQUEST_LIMIT = 25` maakte van te veel open PR's een weigering: nul
  // gepubliceerde statussen. Een eerder groene head bleef daardoor groen terwijl het bewijs eronder
  // al was weggehaald — precies de toestand die deze poort moet uitsluiten. 26 en 100 open PR's
  // moeten dus allemaal, volledig en deterministisch, in de ronde belanden.
  for (const aantal of [26, 100]) {
    const veel = Array.from({ length: aantal }, (_, i) => openPr(i + 1));
    const ronde = selectTargets({ eventName: 'schedule', openPullRequests: veel });
    assert.equal(ronde.outcome, TARGET_OUTCOME.MEASURE, String(aantal));
    assert.equal(ronde.selection, TARGET_SELECTION.ALL_OPEN_PULL_REQUESTS, String(aantal));
    assert.equal(ronde.targets.length, aantal, `${aantal} open PR's leveren ${aantal} doelen`);
    assert.deepEqual(
      ronde.targets,
      Array.from({ length: aantal }, (_, i) => i + 1),
      'oplopend gesorteerd, dus dezelfde lijst bij dezelfde momentopname',
    );
    // Dezelfde invoer in een andere volgorde geeft dezelfde ronde: deterministisch, niet API-volgorde.
    const omgekeerd = selectTargets({ eventName: 'schedule', openPullRequests: [...veel].reverse() });
    assert.deepEqual(omgekeerd.targets, ronde.targets, 'volgorde van de API bepaalt de ronde niet');
  }

  // Ook via de echte `--paginate --slurp`-vorm (een array van pagina's van 100) blijft de ronde heel.
  const paginas = [
    Array.from({ length: 100 }, (_, i) => openPr(i + 1)),
    Array.from({ length: 26 }, (_, i) => openPr(i + 101)),
  ];
  const gepagineerd = selectTargets({ eventName: 'schedule', openPullRequests: paginas });
  assert.equal(gepagineerd.targets.length, 126, 'geen pagina wordt stilzwijgend weggelaten');
  assert.equal(gepagineerd.targets.at(-1), 126);

  // `--paginate` kan een PR twee keer opleveren als de lijst tussen twee pagina's verschuift. Dat
  // ontdubbelt deterministisch en haalt nooit een NUMMER uit de ronde.
  const metDubbel = selectTargets({
    eventName: 'schedule',
    openPullRequests: [[openPr(30), openPr(31)], [openPr(31), openPr(32)]],
  });
  assert.deepEqual(metDubbel.targets, [30, 31, 32]);

  // Een eenduidige hint versmalt nog steeds, ongeacht de lengte van de lijst.
  const veel = Array.from({ length: 100 }, (_, i) => openPr(i + 1));
  const metHint = selectTargets({
    eventName: 'workflow_run',
    workflowRun: shieldRun({ head_sha: veel[0].head.sha, head_branch: veel[0].head.ref }),
    openPullRequests: veel,
  });
  assert.equal(metHint.outcome, TARGET_OUTCOME.MEASURE);
  assert.deepEqual(metHint.targets, [1]);

  // Er bestaat geen weigeringsgrond meer die op de LENGTE van de lijst slaat.
  assert.deepEqual(
    Object.keys(TARGET_REASON).filter((k) => /LIMIT/.test(k)),
    [],
    'een limietweigering zou weer nul statussen publiceren',
  );
  // De constante mag ook niet als dode code terugkeren. De moduledoc mag hem uitleggen, dus wordt
  // hier de CODE getoetst en niet het commentaar.
  const code = readFileSync(SELECTOR, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /OPEN_PULL_REQUEST_LIMIT/, 'geen limietconstante in de code');
  assert.doesNotMatch(code, /\blimit\b/, 'geen limietparameter in de selectie');
});

test('S5b. negatieve mutatie: de teruggezette limietweigering laat 26 open PR\'s zonder status', async () => {
  // Bewijs dat S5 de regressie werkelijk vangt: hier wordt de OUDE weigering terug in de module
  // gemonteerd en wordt gemeten dat die mutant zich fout gedraagt. Slaat het inbouwen niet aan, dan
  // faalt deze test ook — dan is de mutatie geen bewijs meer.
  const bron = readFileSync(SELECTOR, 'utf8');
  const anker = '  const targets = [...new Set(open.map((pr) => pr.number))].sort((a, b) => a - b);';
  assert.equal(bron.split(anker).length - 1, 1, 'het mutatieanker moet precies één keer voorkomen');

  const oudeWeigering = [
    '  if (open.length > 25) {',
    "    return { outcome: TARGET_OUTCOME.FAIL, reason: 'OPEN_PULL_REQUEST_LIMIT_EXCEEDED', targets: [] };",
    '  }',
    anker,
  ].join('\n');
  const collect = pathToFileURL(resolve('scripts/autocoding/collect-shield-input.mjs')).href;
  const mutant = bron
    .replace(anker, oudeWeigering)
    .replace("'./collect-shield-input.mjs'", JSON.stringify(collect));
  assert.notEqual(mutant, bron, 'de mutatie moet daadwerkelijk zijn aangebracht');

  const dir = mkdtempSync(join(tmpdir(), 'live-gate-mutant-'));
  const pad = join(dir, 'select-live-gate-targets.mutant.mjs');
  writeFileSync(pad, mutant);
  const gemuteerd = await import(pathToFileURL(pad).href);

  const veel = Array.from({ length: 26 }, (_, i) => openPr(i + 1));
  const mutantRonde = gemuteerd.selectTargets({ eventName: 'schedule', openPullRequests: veel });
  assert.equal(mutantRonde.outcome, TARGET_OUTCOME.FAIL, 'de mutant weigert de ronde');
  assert.deepEqual(mutantRonde.targets, [], 'de mutant publiceert nul statussen en laat groen staan');

  // Dezelfde invoer door de echte module: alle 26 worden hermeten.
  const echt = selectTargets({ eventName: 'schedule', openPullRequests: veel });
  assert.equal(echt.outcome, TARGET_OUTCOME.MEASURE);
  assert.equal(echt.targets.length, 26);
});

test('S6. een onbruikbare PR-lijst is nooit een lege ronde', () => {
  // `gh api --paginate --slurp` levert een array van pagina\'s; die vorm moet gewoon werken.
  assert.deepEqual(
    normaliseOpenPullRequests([[openPr(2)], [openPr(3)]]).map((p) => p.number),
    [2, 3],
  );
  // Eén vermelding zonder bruikbaar nummer maakt de HELE lijst onbruikbaar: stil overslaan zou een
  // PR voor altijd zonder status laten.
  for (const kapot of [[{}], [{ number: 0 }], [{ number: '2' }], [null], ['2'], [42]]) {
    assert.equal(normaliseOpenPullRequests(kapot), null, JSON.stringify(kapot));
  }
  assert.deepEqual(normaliseOpenPullRequests(null), []);

  const result = selectTargets({ eventName: 'schedule', openPullRequests: [{ nummer: 2 }] });
  assert.equal(result.outcome, TARGET_OUTCOME.FAIL);
  assert.equal(result.reason, TARGET_REASON.OPEN_PULL_REQUESTS_UNREADABLE);

  // Een ontbrekende head blokkeert de PR niet: de head wordt toch opnieuw via de API gemeten.
  const zonderHead = selectTargets({ eventName: 'schedule', openPullRequests: [{ number: 5 }] });
  assert.deepEqual(zonderHead.targets, [5]);
});

// --- CLI ----------------------------------------------------------------------------------------

test('S7. de CLI leest zijn argumenten fail-closed en vertaalt uitkomsten naar exitcodes', () => {
  const goed = ['--event-name', 'schedule', '--event', 'e.json', '--open-pulls', 'o.json', '--out', 't.txt'];
  assert.equal(parseTargetArgs(goed).ok, true);
  assert.equal(parseTargetArgs([...goed, '--onbekend', 'x']).ok, false);
  assert.equal(parseTargetArgs([...goed, '--out', 'tweede.txt']).ok, false);
  assert.equal(parseTargetArgs(goed.slice(0, 6)).ok, false, 'een ontbrekende sleutel is een weigering');
  assert.equal(parseTargetArgs(['--event-name', '--event']).ok, false, 'een sleutel als waarde telt niet');
  assert.equal(parseTargetArgs(['--event-name', '']).ok, false);

  const files = new Map([
    ['e.json', JSON.stringify({ workflow_run: shieldRun() })],
    ['o.json', JSON.stringify([openPr(2), openPr(3)])],
  ]);
  const written = new Map();
  const io = {
    readFile: (path) => {
      if (!files.has(path)) throw new Error('ENOENT');
      return files.get(path);
    },
    writeFile: (path, data) => written.set(path, data),
  };

  const argv = ['--event-name', 'workflow_run', '--event', 'e.json', '--open-pulls', 'o.json', '--out', 't.txt'];
  assert.equal(runSelect(argv, io), 0);
  assert.equal(written.get('t.txt'), '2\n');

  // Onverwachte bron: rc 2 (niets publiceren, geen rode run) en geen doelbestand.
  files.set('e.json', JSON.stringify({ workflow_run: shieldRun({ name: 'publish' }) }));
  written.clear();
  assert.equal(runSelect(argv, io), 2);
  assert.equal(written.size, 0);

  // Onleesbare invoer en kapotte argumenten zijn rc 1.
  files.delete('o.json');
  assert.equal(runSelect(argv, io), 1);
  assert.equal(runSelect(['--event-name'], io), 1);
});

// --- De ronde zelf ------------------------------------------------------------------------------

/** Snijdt het `run:`-blok van een stap uit het workflowbestand en haalt de inspringing eraf. */
function stepScript(workflowPath, stepName) {
  const lines = readFileSync(workflowPath, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  assert.ok(start !== -1, `stap ontbreekt: ${stepName}`);
  const runIndex = lines.findIndex((l, i) => i > start && l.trim() === 'run: |');
  assert.ok(runIndex !== -1, `stap zonder run-blok: ${stepName}`);
  const body = [];
  for (let i = runIndex + 1; i < lines.length; i += 1) {
    if (lines[i].trim() !== '' && !lines[i].startsWith('          ')) break;
    body.push(lines[i].slice(10));
  }
  return body.join('\n');
}

test('S8. een kapotte PR maakt de ronde rood maar stopt hem niet', () => {
  // Dit voert de ECHTE shell uit het workflowbestand uit, met gestubde `gh`, `node` en `sleep`.
  // PR 11 levert geen head op (record-lokale fout), PR 12 publiceert een `failure`, PR 13 een
  // `success`. De eis: 12 en 13 worden alsnog gemeten en gepubliceerd, en de ronde eindigt rood.
  const script = stepScript(TRUSTED_WRITER, 'Meet, beslis en publiceer per doel-PR');
  const dir = mkdtempSync(join(tmpdir(), 'live-gate-round-'));
  const bin = join(dir, 'bin');
  const runnerTemp = join(dir, 'runner');
  mkdirSync(bin);
  mkdirSync(runnerTemp);
  writeFileSync(join(runnerTemp, 'targets.txt'), '11\n12\n13\n');
  writeFileSync(join(dir, 'ronde.sh'), script);

  const stub = (name, body) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path, 0o755);
  };

  // `gh api …/pulls/11` faalt altijd; de rest levert bruikbare JSON.
  stub('gh', [
    'for arg in "$@"; do path="$arg"; done',
    'case "$path" in',
    '  */pulls/11) exit 1 ;;',
    '  */pulls/12) echo \'{"head":{"sha":"1212121212121212121212121212121212121212"}}\' ;;',
    '  */pulls/13) echo \'{"head":{"sha":"1313131313131313131313131313131313131313"}}\' ;;',
    '  *) echo "[]" ;;',
    'esac',
  ].join('\n'));
  stub('sleep', 'exit 0');
  stub('node', [
    // De head-extractie is echte productiecode en wordt dus door de echte node gedraaid.
    'if [ "$1" = "-e" ]; then exec "$REAL_NODE" "$@"; fi',
    'script="$1"; shift',
    'head=""',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "--head-sha" ]; then head="$2"; fi',
    '  shift',
    'done',
    'case "$script" in',
    '  */collect-shield-input.mjs) exit 0 ;;',
    '  */verify-review-gate.mjs) echo \'{"decision":"NO_GO","reasons":[]}\'; exit 1 ;;',
    '  */publish-live-status.mjs)',
    '    echo "$head" >> "$STUB_LOG"',
    '    case "$head" in',
    '      13*) exit 0 ;;',
    '      *) exit 1 ;;',
    '    esac ;;',
    'esac',
    'exit 0',
  ].join('\n'));

  const log = join(dir, 'gepubliceerd.txt');
  let status = 0;
  try {
    execFileSync('bash', [join(dir, 'ronde.sh')], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        REAL_NODE: process.execPath,
        RUNNER_TEMP: runnerTemp,
        REPOSITORY: 'owner/repo',
        STATUS_CONTEXT: 'autocoding-shield-live-receipts',
        GH_TOKEN: 'x',
        GITHUB_TOKEN: 'x',
        STUB_LOG: log,
      },
      stdio: 'pipe',
    });
  } catch (error) {
    status = error.status;
  }

  assert.equal(status, 1, 'een ronde met een kapotte of niet-groene PR is rood');
  const gepubliceerd = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  assert.deepEqual(gepubliceerd, [
    '1212121212121212121212121212121212121212',
    '1313131313131313131313131313131313131313',
  ], 'PR 12 en 13 worden gepubliceerd ondanks de fout bij PR 11');
});

test('S9. de ronde publiceert op de GEMETEN head, ook zonder bruikbare API-nevenverzoeken', () => {
  // Alleen `pulls/{n}` levert hier iets bruikbaars; elke andere GET faalt. De uitspraak moet dan
  // alsnog als `failure` op de gemeten head landen in plaats van te verdwijnen.
  const script = stepScript(TRUSTED_WRITER, 'Meet, beslis en publiceer per doel-PR');
  const dir = mkdtempSync(join(tmpdir(), 'live-gate-round-'));
  const bin = join(dir, 'bin');
  const runnerTemp = join(dir, 'runner');
  mkdirSync(bin);
  mkdirSync(runnerTemp);
  writeFileSync(join(runnerTemp, 'targets.txt'), '21\n');
  writeFileSync(join(dir, 'ronde.sh'), script);

  const stub = (name, body) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path, 0o755);
  };
  stub('gh', [
    'for arg in "$@"; do path="$arg"; done',
    'case "$path" in',
    '  */pulls/21) echo \'{"head":{"sha":"2121212121212121212121212121212121212121"}}\' ;;',
    '  *) exit 1 ;;',
    'esac',
  ].join('\n'));
  stub('sleep', 'exit 0');
  stub('node', [
    'if [ "$1" = "-e" ]; then exec "$REAL_NODE" "$@"; fi',
    'script="$1"; shift',
    'args="$*"',
    'case "$script" in',
    '  */publish-live-status.mjs) echo "$args" >> "$STUB_LOG"; exit 1 ;;',
    'esac',
    'exit 0',
  ].join('\n'));

  const log = join(dir, 'aanroep.txt');
  let status = 0;
  try {
    execFileSync('bash', [join(dir, 'ronde.sh')], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        REAL_NODE: process.execPath,
        RUNNER_TEMP: runnerTemp,
        REPOSITORY: 'owner/repo',
        STATUS_CONTEXT: 'autocoding-shield-live-receipts',
        GH_TOKEN: 'x',
        GITHUB_TOKEN: 'x',
        STUB_LOG: log,
      },
      stdio: 'pipe',
    });
  } catch (error) {
    status = error.status;
  }

  assert.equal(status, 1);
  const aanroep = readFileSync(log, 'utf8').trim();
  assert.match(aanroep, /--head-sha 2121212121212121212121212121212121212121/);
  assert.match(aanroep, /--status-context autocoding-shield-live-receipts/);
  // Mislukte nevenverzoeken worden als uitvoeringsfout doorgegeven, niet verzwegen.
  assert.match(aanroep, /--execution-error GATE_EXECUTION_ERROR/);
});

// --- De gedeelde writerlock ---------------------------------------------------------------------

/** Leest de workflowbrede `concurrency`-sleutel: alleen inspringing 0 telt als workflowniveau. */
function workflowConcurrency(workflowPath) {
  const lines = readFileSync(workflowPath, 'utf8').split('\n');
  const start = lines.findIndex((l) => l === 'concurrency:');
  assert.ok(start !== -1, 'de trusted writer moet een workflowbrede concurrency-sleutel hebben');
  const out = { line: start };
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || line.startsWith('#')) continue;
    if (!line.startsWith('  ')) break;
    const match = /^ {2}([a-z-]+):\s*(.*)$/.exec(line);
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

/**
 * Minimale evaluator voor `${{ a.b || c.d }}` in een concurrency-groep. Genoeg om te METEN of een
 * groep contextafhankelijk is in plaats van dat te beweren.
 */
function evalGroup(template, context) {
  const resolvePath = (path) => {
    let current = context;
    for (const key of path.split('.')) {
      if (current === null || typeof current !== 'object') return '';
      current = current[key];
    }
    return current === null || current === undefined ? '' : String(current);
  };
  return template.replace(/\$\{\{([^}]*)\}\}/g, (_, expr) => {
    for (const term of expr.split('||')) {
      const value = resolvePath(term.trim());
      if (value !== '') return value;
    }
    return '';
  });
}

/** De drie aanleidingen die dezelfde statuscontext op dezelfde head kunnen schrijven. */
const AANLEIDINGEN = Object.freeze({
  review: {
    github: {
      event_name: 'workflow_run',
      run_id: '1001',
      event: { workflow_run: { event: 'pull_request_review', head_branch: 'claude2/pr-74' } },
    },
  },
  comment: {
    github: {
      event_name: 'workflow_run',
      run_id: '1002',
      event: { workflow_run: { event: 'issue_comment', head_branch: 'main' } },
    },
  },
  schedule: { github: { event_name: 'schedule', run_id: '1003', event: {} } },
});

test('S10. review-, comment- en scheduleaanleidingen delen exact één writergroep', () => {
  const concurrency = workflowConcurrency(TRUSTED_WRITER);

  // De groep is een constante. Elke `${{ ... }}` erin zou de groep laten meebewegen met de
  // aanleiding, en dat is precies hoe twee writers gelijktijdig dezelfde statuscontext gingen
  // schrijven.
  assert.doesNotMatch(concurrency.group, /\$\{\{/, 'de writergroep mag geen expressie bevatten');
  assert.equal(concurrency.group, 'autocoding-shield-live-gate');

  // Een lopende ronde wordt nooit halverwege afgekapt: dat zou al geselecteerde maar nog niet
  // gepubliceerde PR's stale laten staan.
  assert.equal(concurrency['cancel-in-progress'], 'false');

  const groepen = new Set(
    Object.values(AANLEIDINGEN).map((context) => evalGroup(concurrency.group, context)),
  );
  assert.equal(groepen.size, 1, 'alle drie de aanleidingen vallen in dezelfde groep');

  const tekst = readFileSync(TRUSTED_WRITER, 'utf8');

  // De lock moet vóór de eerste stap worden verworven, dus vóór ELKE meting. Dat is alleen zo als
  // `concurrency` op workflowniveau staat — een groep binnen `jobs:` zou pas per job gelden.
  const jobsRegel = tekst.split('\n').findIndex((l) => l === 'jobs:');
  assert.ok(jobsRegel !== -1);
  assert.ok(concurrency.line < jobsRegel, 'de writerlock staat op workflowniveau, boven `jobs:`');
  assert.equal(
    tekst.split('\n').filter((l) => l.trimStart().startsWith('concurrency:')).length,
    1,
    'één lock, niet per job een tweede',
  );

  // Er wordt niets gemeten buiten de vergrendelde job: elke API-lezing staat in het enige job-blok.
  const regels = tekst.split('\n');
  const jobKeys = regels.slice(jobsRegel + 1).filter((l) => /^ {2}[a-z0-9-]+:$/.test(l));
  assert.deepEqual(jobKeys, ['  autocoding-shield-live-gate:'], 'precies één job onder de lock');
  const ghRegels = regels.map((regel, i) => ({ regel, i })).filter(({ regel }) => regel.includes('gh api'));
  assert.ok(ghRegels.length > 0, 'de writer meet werkelijk via de API');
  for (const { i } of ghRegels) {
    assert.ok(i > jobsRegel, 'elke meting gebeurt binnen de job, dus nadat de writerlock er is');
  }
});

test('S11. negatieve mutatie: de oude branch-/run-id-groep splitst de writers weer op', () => {
  // Bewijs dat S10 de regressie vangt. De oude expressie sleutelde op de bronbranch met de run-id
  // als terugval; hieronder wordt gemeten dat die vorm de drie aanleidingen in DRIE groepen legt,
  // waardoor een review-run, een commentrun en de uurlijkse ronde gelijktijdig konden draaien en de
  // oudste momentopname als laatste kon publiceren.
  const oud = 'autocoding-shield-live-gate-${{ github.event.workflow_run.head_branch || github.run_id }}';
  const oudeGroepen = Object.values(AANLEIDINGEN).map((context) => evalGroup(oud, context));
  assert.deepEqual(oudeGroepen, [
    'autocoding-shield-live-gate-claude2/pr-74',
    'autocoding-shield-live-gate-main',
    'autocoding-shield-live-gate-1003',
  ]);
  assert.equal(new Set(oudeGroepen).size, 3, 'de oude groep serialiseerde de writers niet');

  // Dezelfde toets als in S10, maar op een workflowtekst waarin de oude groep is teruggezet: die
  // moet aantoonbaar rood worden.
  const gemuteerd = readFileSync(TRUSTED_WRITER, 'utf8')
    .replace('  group: autocoding-shield-live-gate\n', `  group: ${oud}\n`);
  assert.notEqual(gemuteerd, readFileSync(TRUSTED_WRITER, 'utf8'), 'de mutatie moet aanslaan');

  const dir = mkdtempSync(join(tmpdir(), 'live-gate-lock-mutant-'));
  const pad = join(dir, 'writer.yml');
  writeFileSync(pad, gemuteerd);
  const mutantGroep = workflowConcurrency(pad).group;
  assert.match(mutantGroep, /\$\{\{/);
  assert.equal(
    new Set(Object.values(AANLEIDINGEN).map((context) => evalGroup(mutantGroep, context))).size,
    3,
    'de gemuteerde writer valt uiteen in drie groepen en zou S10 rood maken',
  );
});

test('S12. een kapotte PR blokkeert de resterende 25 van een ronde van 26 niet', () => {
  // De limiet is weg, dus een ronde kan nu groter zijn dan 25. De eis uit S8 moet ook op die schaal
  // gelden: een fout bij het eerste record blijft record-lokaal, alle latere records publiceren
  // gewoon, en de ronde eindigt rood.
  const script = stepScript(TRUSTED_WRITER, 'Meet, beslis en publiceer per doel-PR');
  const dir = mkdtempSync(join(tmpdir(), 'live-gate-grote-ronde-'));
  const bin = join(dir, 'bin');
  const runnerTemp = join(dir, 'runner');
  mkdirSync(bin);
  mkdirSync(runnerTemp);
  const nummers = Array.from({ length: 26 }, (_, i) => i + 1);
  writeFileSync(join(runnerTemp, 'targets.txt'), `${nummers.join('\n')}\n`);
  writeFileSync(join(dir, 'ronde.sh'), script);

  const stub = (name, body) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path, 0o755);
  };

  // PR 1 levert nooit een head op; elke andere PR krijgt een head van 40 cijfers (geldige hex).
  stub('gh', [
    'for arg in "$@"; do path="$arg"; done',
    'case "$path" in',
    '  */pulls/1) exit 1 ;;',
    '  */pulls/[0-9]|*/pulls/[0-9][0-9])',
    '    n="${path##*/}"',
    '    printf \'{"head":{"sha":"%040d"}}\\n\' "$n" ;;',
    '  *) echo "[]" ;;',
    'esac',
  ].join('\n'));
  stub('sleep', 'exit 0');
  stub('node', [
    'if [ "$1" = "-e" ]; then exec "$REAL_NODE" "$@"; fi',
    'script="$1"; shift',
    'head=""',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "--head-sha" ]; then head="$2"; fi',
    '  shift',
    'done',
    'case "$script" in',
    '  */publish-live-status.mjs) echo "$head" >> "$STUB_LOG"; exit 0 ;;',
    'esac',
    'exit 0',
  ].join('\n'));

  const log = join(dir, 'gepubliceerd.txt');
  let status = 0;
  try {
    execFileSync('bash', [join(dir, 'ronde.sh')], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        REAL_NODE: process.execPath,
        RUNNER_TEMP: runnerTemp,
        REPOSITORY: 'owner/repo',
        STATUS_CONTEXT: 'autocoding-shield-live-receipts',
        GH_TOKEN: 'x',
        GITHUB_TOKEN: 'x',
        STUB_LOG: log,
      },
      stdio: 'pipe',
    });
  } catch (error) {
    status = error.status;
  }

  assert.equal(status, 1, 'de niet te meten PR 1 maakt de ronde rood');
  const gepubliceerd = readFileSync(log, 'utf8').trim().split('\n');
  assert.deepEqual(
    gepubliceerd,
    nummers.slice(1).map((n) => String(n).padStart(40, '0')),
    'PR 2 tot en met 26 krijgen alle 25 een verse status, in doelvolgorde',
  );
});

/**
 * Model van de GitHub-concurrencysemantiek: runs met dezelfde groepssleutel draaien nooit
 * gelijktijdig, runs met verschillende sleutels wel. Dit is een MODEL, geen meting aan GitHub — wat
 * er hier wordt getoetst is de gevolgtrekking uit dat model: bij één gedeelde sleutel kan een
 * oudere momentopname niet ná een nieuwere publiceren, bij gesplitste sleutels wel.
 *
 * Elke run meet de gedeelde toestand op het moment dat hij START (dus nadat hij de lock heeft) en
 * publiceert op het moment dat hij EINDIGT.
 */
function speelWritersAf({ groupTemplate, runs, bewijsWijzigingen }) {
  const bewijsOp = (tijd) => bewijsWijzigingen
    .filter((wijziging) => wijziging.tijd <= tijd)
    .at(-1).verdict;

  const vrijVanaf = new Map();
  const publicaties = [];
  for (const run of [...runs].sort((a, b) => a.aankomst - b.aankomst)) {
    const groep = evalGroup(groupTemplate, run.context);
    const start = Math.max(run.aankomst, vrijVanaf.get(groep) ?? 0);
    const eind = start + run.duur;
    vrijVanaf.set(groep, eind);
    publicaties.push({ naam: run.naam, groep, gemeten: bewijsOp(start), eind });
  }
  return publicaties.sort((a, b) => a.eind - b.eind);
}

test('S13. een oudere meting kan de nieuwere uitspraak niet overschrijven', () => {
  // Het scenario uit de bevinding: een reviewrun meet het bewijs terwijl het receipt er nog is, en
  // is traag. Ondertussen wordt het receipt verwijderd en start de uurlijkse ronde, die het
  // ontbreken meteen ziet. Wie als LAATSTE publiceert bepaalt de kleur van de gedeelde
  // statuscontext op die head.
  const runs = [
    { naam: 'review', aankomst: 0, duur: 10, context: AANLEIDINGEN.review },
    { naam: 'schedule', aankomst: 2, duur: 3, context: AANLEIDINGEN.schedule },
  ];
  const bewijsWijzigingen = [
    { tijd: 0, verdict: 'success' },
    { tijd: 1, verdict: 'failure' }, // het receipt wordt verwijderd
  ];

  const oud = 'autocoding-shield-live-gate-${{ github.event.workflow_run.head_branch || github.run_id }}';
  const zonderLock = speelWritersAf({ groupTemplate: oud, runs, bewijsWijzigingen });
  assert.equal(new Set(zonderLock.map((p) => p.groep)).size, 2, 'de oude sleutel splitst de runs');
  assert.equal(
    zonderLock.at(-1).gemeten,
    'success',
    'zonder gedeelde lock publiceert de OUDERE momentopname als laatste: stale groen',
  );

  const groupTemplate = workflowConcurrency(TRUSTED_WRITER).group;
  const metLock = speelWritersAf({ groupTemplate, runs, bewijsWijzigingen });
  assert.equal(new Set(metLock.map((p) => p.groep)).size, 1, 'één gedeelde writergroep');
  assert.equal(
    metLock.at(-1).gemeten,
    'failure',
    'met de gedeelde lock meet de laatste run pas ná de eerste, dus wint de nieuwste toestand',
  );

  // Sterker: onder één lock is de meting van elke volgende publicatie nooit ouder dan de vorige.
  for (let i = 1; i < metLock.length; i += 1) {
    assert.ok(
      metLock[i].eind > metLock[i - 1].eind,
      'publicaties zijn geserialiseerd, dus er is een strikte volgorde',
    );
  }

  // En dat geldt voor elke volgorde en duur van de drie aanleidingen, niet alleen voor dit ene paar.
  const alledrie = Object.entries(AANLEIDINGEN)
    .map(([naam, context], i) => ({ naam, aankomst: i, duur: 7 - i * 2, context }));
  const geserialiseerd = speelWritersAf({ groupTemplate, runs: alledrie, bewijsWijzigingen });
  assert.equal(new Set(geserialiseerd.map((p) => p.groep)).size, 1);
  assert.equal(geserialiseerd.at(-1).gemeten, 'failure');
});
