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
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  selectTargets, isTrustedWorkflowRunSource, normaliseOpenPullRequests, parseTargetArgs, runSelect,
  EXPECTED_SOURCE, OPEN_PULL_REQUEST_LIMIT, TARGET_OUTCOME, TARGET_REASON, TARGET_SELECTION,
} from '../scripts/autocoding/select-live-gate-targets.mjs';

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

test('S5. de volledige ronde is expliciet begrensd en faalt gesloten', () => {
  const veel = Array.from({ length: OPEN_PULL_REQUEST_LIMIT + 1 }, (_, i) => openPr(i + 1));
  const over = selectTargets({ eventName: 'schedule', openPullRequests: veel });
  assert.equal(over.outcome, TARGET_OUTCOME.FAIL);
  assert.equal(over.reason, TARGET_REASON.OPEN_PULL_REQUEST_LIMIT_EXCEEDED);
  assert.deepEqual(over.targets, [], 'bij overschrijding wordt er geen enkele status geschreven');

  // Precies op de grens mag nog wel.
  const opDeGrens = selectTargets({ eventName: 'schedule', openPullRequests: veel.slice(0, OPEN_PULL_REQUEST_LIMIT) });
  assert.equal(opDeGrens.outcome, TARGET_OUTCOME.MEASURE);
  assert.equal(opDeGrens.targets.length, OPEN_PULL_REQUEST_LIMIT);

  // Een eenduidige hint heeft de volledige lijst niet nodig en wordt dus niet door de limiet geraakt.
  const metHint = selectTargets({
    eventName: 'workflow_run',
    workflowRun: shieldRun({ head_sha: veel[0].head.sha, head_branch: veel[0].head.ref }),
    openPullRequests: veel,
  });
  assert.equal(metHint.outcome, TARGET_OUTCOME.MEASURE);
  assert.deepEqual(metHint.targets, [1]);
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
