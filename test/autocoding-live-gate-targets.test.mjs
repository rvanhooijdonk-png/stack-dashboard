/**
 * AUTOCODING_SHIELD — doelselectie en ronde-afhandeling van de trusted statuswriter.
 *
 * De writer wordt niet meer direct door een PR-, comment- of reviewevent gestart maar door
 * `workflow_run` (na de onprivileged shield) en `schedule`. Daarmee verschuift het risico: de
 * aanleiding zegt niets betrouwbaars meer over WELKE pull request gemeten moet worden, en de
 * bronrun kan een door een PR geleverde definitie hebben gehad. Twee eigenschappen worden hier
 * daarom gemeten in plaats van beloofd:
 *
 *   1. De doel-PR's komen uit een read-only API-lijst, niet uit de eventpayload, en de payload mag
 *      die lijst NIET versmallen. Iedere aanleiding invalideert eerst alle open heads.
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
  selectTargets, selectEvaluationBatch, isTrustedWorkflowRunSource, normaliseOpenPullRequests,
  parseTargetArgs, parseRunNumber, runSelect, EVALUATION_BATCH_LIMIT,
  EXPECTED_SOURCE, TARGET_OUTCOME, TARGET_REASON, TARGET_SELECTION,
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

test('S3. GEEN enkele hint versmalt de ronde nog, ook niet bij een eenduidige treffer', () => {
  // Codex P1, review 4998653669, inline 3834812708. De writergroep is een constante en GitHub houdt
  // daar hooguit één WACHTENDE run van aan. Verwijdert iemand een receipt op PR 2 (run A gaat in de
  // wachtrij) en komt er daarna een event op PR 3, dan ANNULEERT GitHub run A. Versmalde de
  // overlevende run B op zijn eigen hint, dan deed niemand de invalidatie van PR 2 en bleef diens
  // `success` bruikbaar tot de volgende uurlijkse ronde. Elke aanleiding doet daarom nu een
  // volledige ronde — dan draagt de overlevende run het werk van elke geannuleerde voorganger.
  const open = [openPr(2), openPr(3)];

  for (const event of EXPECTED_SOURCE.events) {
    for (const hint of [{}, { head_sha: sha(9) }, { head_sha: sha(9), head_branch: 'weg' }]) {
      const ronde = selectTargets({
        eventName: 'workflow_run',
        workflowRun: shieldRun({ event, ...hint }),
        openPullRequests: open,
      });
      const label = `${event} ${JSON.stringify(hint)}`;
      assert.equal(ronde.selection, TARGET_SELECTION.ALL_OPEN_PULL_REQUESTS, label);
      assert.deepEqual(ronde.targets, [2, 3], label);
      assert.deepEqual(ronde.heads.map((h) => h.number), [2, 3], label);
    }
  }

  // De selectievorm bestaat niet eens meer, dus kan geen enkel pad hem nog kiezen.
  assert.deepEqual(Object.keys(TARGET_SELECTION), ['ALL_OPEN_PULL_REQUESTS']);
  const code = readFileSync(SELECTOR, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /head_sha|head_branch/, 'de hintvelden worden nergens meer gelezen');

  // Een hint die naar een gesloten of onbekende PR wijst, voegt die PR ook niet toe.
  const onbekend = selectTargets({
    eventName: 'workflow_run',
    workflowRun: shieldRun({ head_sha: sha(9), head_branch: 'weg' }),
    openPullRequests: open,
  });
  assert.deepEqual(onbekend.targets, [2, 3]);
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

test('S4b. NEGATIEVE MUTATIE: de teruggezette hintversmalling verliest een invalidatie', () => {
  // Het gemeten scenario uit de bevinding, nagespeeld op de module. PR 74 (het receipt is zojuist
  // verwijderd) en PR 75 staan open; de overlevende writerrun is aan PR 75 gebonden. De mutant — de
  // OUDE versmalling, terug in de code — meet alleen PR 75 en laat de head van PR 74 dus ongemoeid.
  // De echte module invalideert er twee.
  const bron = readFileSync(SELECTOR, 'utf8');
  const anker = '  const targets = [...new Set(open.map((pr) => pr.number))].sort((a, b) => a - b);';
  assert.equal(bron.split(anker).length - 1, 1, 'het mutatieanker moet precies één keer voorkomen');

  const oudeVersmalling = [
    '  const hint = workflowRun;',
    '  if (hint) {',
    "    const bySha = open.filter((pr) => pr.headSha !== '' && pr.headSha === hint.head_sha);",
    '    if (bySha.length === 1) {',
    '      return {',
    '        outcome: TARGET_OUTCOME.MEASURE,',
    '        selection: TARGET_SELECTION.ALL_OPEN_PULL_REQUESTS,',
    '        targets: [bySha[0].number],',
    "        heads: [{ number: bySha[0].number, headSha: bySha[0].headSha }],",
    '        batch: [bySha[0].number],',
    '        batchIndex: 0, batchCount: 1, batchRotated: false,',
    '      };',
    '    }',
    '  }',
    anker,
  ].join('\n');
  const collect = pathToFileURL(resolve('scripts/autocoding/collect-shield-input.mjs')).href;
  const mutant = bron
    .replace(anker, oudeVersmalling)
    .replace("'./collect-shield-input.mjs'", JSON.stringify(collect));
  assert.notEqual(mutant, bron, 'de mutatie moet daadwerkelijk zijn aangebracht');

  const dir = mkdtempSync(join(tmpdir(), 'live-gate-hint-mutant-'));
  const pad = join(dir, 'select-live-gate-targets.hint.mjs');
  writeFileSync(pad, mutant);
  return import(pathToFileURL(pad).href).then((gemuteerd) => {
    const open = [openPr(74), openPr(75)];
    const aanleiding = {
      eventName: 'workflow_run',
      workflowRun: shieldRun({ event: 'pull_request_review', head_sha: sha(75), head_branch: 'branch-75' }),
      openPullRequests: open,
    };

    const mutantRonde = gemuteerd.selectTargets(aanleiding);
    assert.deepEqual(mutantRonde.targets, [75], 'de mutant versmalt op zijn eigen hint');
    assert.deepEqual(
      mutantRonde.heads.map((h) => h.number),
      [75],
      'de head van PR 74 wordt door de mutant nooit geïnvalideerd: diens success blijft staan',
    );

    const echt = selectTargets(aanleiding);
    assert.deepEqual(echt.targets, [74, 75]);
    assert.deepEqual(echt.heads.map((h) => h.number), [74, 75],
      'de echte module invalideert ook de head van de geannuleerde aanleiding');
  });
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

  // De 126 heads gaan ALLEMAAL de invalidatieronde in; alleen de MEETbatch is begrensd.
  assert.equal(gepagineerd.heads.length, 126, 'iedere open head wordt geïnvalideerd');
  assert.equal(gepagineerd.batch.length, EVALUATION_BATCH_LIMIT);

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

  // `EVALUATION_BATCH_LIMIT` is wél een limiet, maar een andere soort: hij begrenst hoeveel PR's
  // deze run DOORMEET, nooit hoeveel er in de ronde zitten. Dat verschil wordt gemeten, niet
  // beloofd — bij elke lengte blijven `targets` en `heads` compleet.
  for (const aantal of [1, 99, 100, 101, 126, 250]) {
    const veel = Array.from({ length: aantal }, (_, i) => openPr(i + 1));
    const ronde = selectTargets({ eventName: 'schedule', openPullRequests: veel, runNumber: 1 });
    assert.equal(ronde.outcome, TARGET_OUTCOME.MEASURE, String(aantal));
    assert.equal(ronde.targets.length, aantal, `${aantal}: de ronde blijft compleet`);
    assert.equal(ronde.heads.length, aantal, `${aantal}: iedere head wordt geïnvalideerd`);
    assert.ok(ronde.batch.length <= EVALUATION_BATCH_LIMIT, `${aantal}: de meetbatch is begrensd`);
  }
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
  const goed = ['--event-name', 'schedule', '--event', 'e.json', '--open-pulls', 'o.json',
    '--run-number', '7', '--out-heads', 'h.txt', '--out', 't.txt'];
  assert.equal(parseTargetArgs(goed).ok, true);
  assert.equal(parseTargetArgs([...goed, '--onbekend', 'x']).ok, false);
  assert.equal(parseTargetArgs([...goed, '--out', 'tweede.txt']).ok, false);
  assert.equal(parseTargetArgs(goed.slice(0, 8)).ok, false, 'een ontbrekende sleutel is een weigering');
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

  const argv = ['--event-name', 'workflow_run', '--event', 'e.json', '--open-pulls', 'o.json',
    '--run-number', '7', '--out-heads', 'h.txt', '--out', 't.txt'];
  assert.equal(runSelect(argv, io), 0);
  // De hint wees op PR 2; de ronde bevat er twee, en beide heads gaan de invalidatie in.
  assert.equal(written.get('t.txt'), '2\n3\n');
  assert.equal(written.get('h.txt'), `2 ${sha(2)}\n3 ${sha(3)}\n`);

  // Een PR waarvan de LIJST geen bruikbare head gaf, krijgt `-`. De workflow maakt dat record rood
  // in plaats van het stil over te slaan: zo'n head kan niet geïnvalideerd worden.
  files.set('o.json', JSON.stringify([{ number: 5 }]));
  written.clear();
  assert.equal(runSelect(argv, io), 0);
  assert.equal(written.get('h.txt'), '5 -\n');
  assert.equal(written.get('t.txt'), '5\n');

  // Onverwachte bron: rc 2 (niets publiceren, geen rode run) en geen doelbestand.
  files.set('e.json', JSON.stringify({ workflow_run: shieldRun({ name: 'publish' }) }));
  files.set('o.json', JSON.stringify([openPr(2), openPr(3)]));
  written.clear();
  assert.equal(runSelect(argv, io), 2);
  assert.equal(written.size, 0);

  // Onleesbare invoer en kapotte argumenten zijn rc 1.
  files.delete('o.json');
  assert.equal(runSelect(argv, io), 1);
  assert.equal(runSelect(['--event-name'], io), 1);
});

test('S7b. het run-nummer roteert de batch en weigert de ronde nooit', () => {
  // De rotatie is SCHEDULING, geen poort: alle heads staan na de invalidatieronde al op `pending`,
  // dus kan een onbruikbaar run-nummer hooguit een uitspraak uitstellen. De ronde weigeren zou juist
  // gevaarlijk zijn — dan wordt er niets geïnvalideerd en blijft elke oude `success` staan.
  assert.equal(parseRunNumber('1'), 1);
  assert.equal(parseRunNumber('4211'), 4211);
  for (const kapot of ['', '0', '-3', '2.5', 'zeven', ' 7', '7 ', undefined, null, 7]) {
    assert.equal(parseRunNumber(kapot), null, JSON.stringify(kapot));
  }

  const nummers = Array.from({ length: 126 }, (_, i) => i + 1);
  assert.deepEqual(
    selectEvaluationBatch(nummers, 1),
    { batch: nummers.slice(0, 100), index: 0, count: 2, rotated: true },
  );
  assert.deepEqual(selectEvaluationBatch(nummers, 2).batch, nummers.slice(100));
  assert.deepEqual(selectEvaluationBatch(nummers, 3).batch, nummers.slice(0, 100), 'runnummer 3 begint opnieuw');

  // Elke open PR komt binnen `count` opeenvolgende runs aan de beurt — hier dus binnen twee.
  for (const aantal of [101, 126, 250, 401]) {
    const lijst = Array.from({ length: aantal }, (_, i) => i + 1);
    const eerste = selectEvaluationBatch(lijst, 1);
    const gezien = new Set();
    for (let run = 1; run <= eerste.count; run += 1) {
      for (const nummer of selectEvaluationBatch(lijst, run).batch) gezien.add(nummer);
    }
    assert.deepEqual([...gezien].sort((a, b) => a - b), lijst,
      `${aantal} PR's zijn binnen ${eerste.count} runs allemaal geëvalueerd`);
  }
  // En dat blijft gelden vanaf een willekeurig run-nummer, niet alleen vanaf 1.
  const lijst = Array.from({ length: 126 }, (_, i) => i + 1);
  const vanaf = new Set();
  for (let run = 4210; run < 4212; run += 1) {
    for (const nummer of selectEvaluationBatch(lijst, run).batch) vanaf.add(nummer);
  }
  assert.equal(vanaf.size, 126);

  // Een onbruikbaar run-nummer valt terug op blok 0 en laat de ronde en de invalidatie heel.
  const ronde = selectTargets({
    eventName: 'schedule',
    openPullRequests: Array.from({ length: 126 }, (_, i) => openPr(i + 1)),
    runNumber: null,
  });
  assert.equal(ronde.outcome, TARGET_OUTCOME.MEASURE, 'nooit een weigering');
  assert.equal(ronde.heads.length, 126, 'alle heads worden alsnog geïnvalideerd');
  assert.equal(ronde.batchRotated, false);
  assert.deepEqual(ronde.batch, ronde.targets.slice(0, 100));
});

test('S7c. een verschoven head levert TWEE invalidaties op, en de PR blijft één doel', () => {
  // `--paginate` kan dezelfde PR met twee verschillende heads opleveren als de lijst tussen twee
  // pagina's verschuift. Op allebei die heads kan een oude `success` staan, dus worden ze allebei
  // geïnvalideerd; voor de meting telt de PR daarna gewoon één keer.
  const ronde = selectTargets({
    eventName: 'schedule',
    openPullRequests: [
      [openPr(30, { headSha: sha(1) }), openPr(31)],
      [openPr(30, { headSha: sha(2) }), openPr(31)],
    ],
  });
  assert.deepEqual(ronde.targets, [30, 31], 'de PR blijft één doel');
  assert.deepEqual(
    ronde.heads,
    [{ number: 30, headSha: sha(1) }, { number: 30, headSha: sha(2) }, { number: 31, headSha: sha(31) }],
    'beide heads van PR 30 worden geïnvalideerd',
  );
  // Een identieke herhaling levert géén tweede invalidatie op: dat zou alleen budget kosten.
  const zelfde = selectTargets({
    eventName: 'schedule',
    openPullRequests: [[openPr(30)], [openPr(30)]],
  });
  assert.deepEqual(zelfde.heads, [{ number: 30, headSha: sha(30) }]);
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

test('S7d. een onbruikbare batchlimiet valt terug op de canonieke limiet, nooit op Infinity', () => {
  // Een niet positief-gehele limiet was een STILLE lege ronde: `Math.ceil(126 / 0)` is `Infinity`,
  // dus `(runNumber - 1) % count` is `NaN` en `slice(NaN, NaN)` levert een lege batch. De run
  // invalideerde dan alle 126 heads en mat er vervolgens nul — iedereen bleef op `pending` staan.
  const lijst = Array.from({ length: 126 }, (_, i) => i + 1);
  const canoniek = selectEvaluationBatch(lijst, 1, EVALUATION_BATCH_LIMIT);
  assert.equal(canoniek.count, 2);
  assert.equal(canoniek.batch.length, 100);

  const onbruikbaar = [
    0, -1, -100, 2.5, 0.5, -0.5, Number.NaN, Infinity, -Infinity,
    null, undefined, '100', '', 'honderd', true, false, {}, [], [100], () => 100,
  ];
  for (const limiet of onbruikbaar) {
    const uitkomst = selectEvaluationBatch(lijst, 1, limiet);
    const naam = `limiet ${String(limiet)}`;
    assert.deepEqual(uitkomst, canoniek, naam);
    assert.ok(Number.isInteger(uitkomst.count) && uitkomst.count > 0, `${naam}: eindig aantal blokken`);
    assert.ok(Number.isInteger(uitkomst.index) && uitkomst.index >= 0, `${naam}: eindige index`);
    assert.ok(uitkomst.batch.length > 0, `${naam}: nooit een lege meting op een niet-lege lijst`);

    // De dekkingsgarantie mag niet van de aanroeper afhangen: iedere PR komt binnen `count` runs
    // alsnog aan de beurt, ook als de limiet onzin was.
    const gezien = new Set();
    for (let run = 1; run <= uitkomst.count; run += 1) {
      for (const nummer of selectEvaluationBatch(lijst, run, limiet).batch) gezien.add(nummer);
    }
    assert.deepEqual([...gezien].sort((a, b) => a - b), lijst, `${naam}: volledige dekking`);
  }

  // Een lijst KORTER dan de canonieke limiet mag door een kapotte limiet evenmin worden afgekapt.
  for (const limiet of [0, -1, 2.5, 'honderd']) {
    assert.deepEqual(
      selectEvaluationBatch([7, 8, 9], 1, limiet),
      { batch: [7, 8, 9], index: 0, count: 1, rotated: false },
      `korte lijst bij limiet ${String(limiet)}`,
    );
  }

  // En de grens is niet te ruim: een geldige eigen limiet blijft gewoon gelden.
  const eigen = selectEvaluationBatch(lijst, 1, 50);
  assert.equal(eigen.count, 3);
  assert.deepEqual(eigen.batch, lijst.slice(0, 50));
  assert.deepEqual(selectEvaluationBatch(lijst, 3, 50).batch, lijst.slice(100));

  // Ook via `selectTargets`, want daar komt de limiet binnen als parameter: de ronde blijft volledig
  // geïnvalideerd én meet een niet-lege batch.
  for (const batchLimit of [0, -5, 3.7, 'honderd', null]) {
    const ronde = selectTargets({
      eventName: 'schedule',
      openPullRequests: Array.from({ length: 126 }, (_, i) => openPr(i + 1)),
      runNumber: 1,
      batchLimit,
    });
    const naam = `selectTargets bij batchLimit ${String(batchLimit)}`;
    assert.equal(ronde.outcome, TARGET_OUTCOME.MEASURE, naam);
    assert.equal(ronde.heads.length, 126, `${naam}: alle heads geïnvalideerd`);
    assert.equal(ronde.batchCount, 2, naam);
    assert.deepEqual(ronde.batch, ronde.targets.slice(0, EVALUATION_BATCH_LIMIT), naam);
  }
});

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

/**
 * Voert de DRIE stappen van de writer echt uit, met gestubde `gh` en `node`, en houdt één gedeeld
 * logboek bij van alles wat de buitenwereld raakt. Daarmee is de VOLGORDE tussen de fasen meetbaar
 * in plaats van beloofd.
 *
 * De selectiestap draait op ECHTE productiecode: alleen `gh` levert de open-PR-lijst. Wat gestubd is
 * zijn de netwerkkant (`gh`) en de publisher, want die zouden anders werkelijk POST'en.
 */
function draaiRonde({ aantalOpenPrs, runNumber, metMeting = true }) {
  const dir = mkdtempSync(join(tmpdir(), 'live-gate-budget-'));
  const bin = join(dir, 'bin');
  const runnerTemp = join(dir, 'runner');
  mkdirSync(bin);
  mkdirSync(runnerTemp);

  const headVan = (n) => String(n).padStart(40, '0');
  const pagina = (van, tot) => Array.from({ length: tot - van + 1 }, (_, i) => ({
    number: van + i, head: { sha: headVan(van + i), ref: `branch-${van + i}` },
  }));
  // Exact de vorm van `gh api --paginate --slurp`: een array van pagina's van 100.
  const lijst = [pagina(1, Math.min(100, aantalOpenPrs))];
  if (aantalOpenPrs > 100) lijst.push(pagina(101, aantalOpenPrs));
  writeFileSync(join(dir, 'open-pulls.json'), JSON.stringify(lijst));
  writeFileSync(join(dir, 'event.json'), JSON.stringify({}));
  writeFileSync(join(dir, 'github-output.txt'), '');

  const stub = (name, body) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path, 0o755);
  };

  // `gh` logt IEDER verzoek. De lijst-GET is er één; alle andere zijn detailverzoeken per PR.
  stub('gh', [
    'for arg in "$@"; do path="$arg"; done',
    'case "$path" in',
    '  *state=open*) echo "LIST" >> "$STUB_LOG"; cat "$LIST_JSON"; exit 0 ;;',
    'esac',
    'echo "GET $path" >> "$STUB_LOG"',
    'case "$path" in',
    '  */pulls/*[0-9]) n="${path##*/}"; printf \'{"head":{"sha":"%040d"}}\\n\' "$n" ;;',
    '  *) echo "[]" ;;',
    'esac',
  ].join('\n'));
  stub('sleep', 'exit 0');
  stub('node', [
    // De doelselectie en de head-extractie zijn productiecode en draaien dus echt.
    'if [ "$1" = "-e" ] || [ "$1" = "-p" ]; then exec "$REAL_NODE" "$@"; fi',
    'case "$1" in',
    '  */select-live-gate-targets.mjs) exec "$REAL_NODE" "$@" ;;',
    'esac',
    'script="$1"; shift',
    'head=""; pending=0',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --head-sha) head="$2" ;;',
    '    --pending) pending=1 ;;',
    '  esac',
    '  shift',
    'done',
    'case "$script" in',
    '  */publish-live-status.mjs)',
    '    if [ "$pending" = 1 ]; then echo "PENDING $head" >> "$STUB_LOG";',
    '    else echo "PUBLISH $head" >> "$STUB_LOG"; fi',
    '    exit 0 ;;',
    '  */verify-review-gate.mjs) echo \'{"decision":"NO_GO","reasons":[]}\'; exit 1 ;;',
    'esac',
    'exit 0',
  ].join('\n'));

  const log = join(dir, 'log.txt');
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    REAL_NODE: process.execPath,
    RUNNER_TEMP: runnerTemp,
    REPOSITORY: 'owner/repo',
    EVENT_NAME: 'schedule',
    RUN_NUMBER: String(runNumber),
    STATUS_CONTEXT: 'autocoding-shield-live-receipts',
    GH_TOKEN: 'x',
    GITHUB_TOKEN: 'x',
    GITHUB_EVENT_PATH: join(dir, 'event.json'),
    GITHUB_OUTPUT: join(dir, 'github-output.txt'),
    LIST_JSON: join(dir, 'open-pulls.json'),
    STUB_LOG: log,
  };

  const stappen = [
    "Bepaal de doel-PR's opnieuw via read-only API",
    'Invalideer eerst iedere open head',
    ...(metMeting ? ['Meet, beslis en publiceer per doel-PR'] : []),
  ];
  const codes = [];
  for (const [i, naam] of stappen.entries()) {
    const pad = join(dir, `stap-${i}.sh`);
    writeFileSync(pad, stepScript(TRUSTED_WRITER, naam));
    try {
      execFileSync('bash', [pad], { env, stdio: 'pipe' });
      codes.push(0);
    } catch (error) {
      codes.push(error.status);
    }
  }

  return {
    codes,
    log: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [],
    targets: readFileSync(join(runnerTemp, 'targets.txt'), 'utf8').trim().split('\n').filter(Boolean),
    heads: readFileSync(join(runnerTemp, 'heads.txt'), 'utf8').trim().split('\n').filter(Boolean),
    output: readFileSync(join(dir, 'github-output.txt'), 'utf8'),
    headVan,
  };
}

test('S14. bij 126 open PR\'s zijn ALLE 126 heads geïnvalideerd vóór de eerste detail-GET', () => {
  // Codex P2, review 4998653669, inline 3834812711. Zeven verzoeken per PR maal 126 PR's overschrijdt
  // het uurlijkse `GITHUB_TOKEN`-quotum van duizend. Wie per PR volledig afhandelt, raakt halverwege
  // leeg — en de PR's die dan nog niet aan de beurt waren, houden hun oude `success`. Deze test voert
  // de ECHTE shell van de drie stappen uit en meet de volgorde in één gedeeld logboek.
  const ronde = draaiRonde({ aantalOpenPrs: 126, runNumber: 1 });
  const { log, headVan } = ronde;

  // 1. Alle 126 invalidaties zijn geprobeerd.
  const pending = log.filter((l) => l.startsWith('PENDING '));
  assert.equal(pending.length, 126, 'iedere open head krijgt een pendingpoging');
  assert.deepEqual(
    pending.map((l) => l.slice('PENDING '.length)),
    Array.from({ length: 126 }, (_, i) => headVan(i + 1)),
    'en wel op precies de 126 heads uit de open-PR-lijst',
  );

  // 2. Ze zijn ALLEMAAL geprobeerd vóórdat er één detailverzoek is gedaan. Dit is de hele eis: na
  //    deze grens kan geen enkele geselecteerde head nog een oude `success` dragen, dus is elke
  //    verdere budgetuitputting hooguit een uitgestelde uitspraak.
  const laatstePending = log.findLastIndex((l) => l.startsWith('PENDING '));
  const eersteDetail = log.findIndex((l) => l.startsWith('GET '));
  assert.ok(eersteDetail !== -1, 'de meetronde doet werkelijk detailverzoeken');
  assert.ok(
    laatstePending < eersteDetail,
    `de laatste invalidatie (${laatstePending}) moet vóór het eerste detailverzoek (${eersteDetail}) komen`,
  );
  // De invalidatieronde zelf kost geen enkele GET: alleen de lijst-GET gaat eraan vooraf.
  assert.deepEqual(log.slice(0, laatstePending + 1).filter((l) => l.startsWith('GET ')), []);

  // 3. Daarna wordt hoogstens de gekozen batch geëvalueerd, en dat past binnen het budget.
  assert.deepEqual(ronde.targets, Array.from({ length: 100 }, (_, i) => String(i + 1)));
  const gemeten = new Set(
    log.filter((l) => l.startsWith('GET '))
      .map((l) => /\/(?:pulls|issues)\/(\d+)/.exec(l)?.[1])
      .filter(Boolean),
  );
  assert.deepEqual(
    [...gemeten].map(Number).sort((a, b) => a - b),
    Array.from({ length: 100 }, (_, i) => i + 1),
    'precies de honderd PR\'s van de batch worden doorgemeten, en geen enkele daarbuiten',
  );
  // Het budget, exact geteld in plaats van geschat. Vóór de grens: één lijst-GET plus 126 POST's =
  // 127 verzoeken om ALLE heads niet-groen te krijgen. Daarna hoogstens 100 x (1 + 6) GET's plus
  // 100 POST's. Samen blijft de hele ronde onder het uurlijkse quotum van duizend.
  assert.equal(laatstePending + 1, 127, 'alle heads zijn niet-groen na 127 verzoeken');
  const verzoeken = log.length;
  assert.equal(verzoeken, 927);
  assert.ok(verzoeken <= 1000, `de hele ronde kost ${verzoeken} verzoeken, binnen het uurlijkse quotum`);
  assert.equal(log.filter((l) => l.startsWith('PUBLISH ')).length, 100);

  // 4. En de ronde is groen op de invalidatie: `pending_failed=0`.
  assert.match(ronde.output, /pending_failed=0/);
});

test('S15. de batch roteert met het run-nummer, dus komt iedere PR aan de beurt', () => {
  // Run 1 meet 1..100 (zie S14). Run 2 moet de rest meten — anders zouden PR 101..126 voor altijd
  // op `pending` blijven staan. De invalidatie is in beide runs volledig; alleen de MEETbatch
  // verschuift. Zonder meetstap, want die eigenschap is in S14 al gemeten en 26 PR's doormeten kost
  // alleen tijd.
  const tweede = draaiRonde({ aantalOpenPrs: 126, runNumber: 2, metMeting: false });
  assert.equal(tweede.log.filter((l) => l.startsWith('PENDING ')).length, 126,
    'ook run 2 invalideert alle 126 heads, niet alleen zijn eigen batch');
  assert.deepEqual(
    tweede.targets,
    Array.from({ length: 26 }, (_, i) => String(i + 101)),
    'run 2 meet precies het tweede blok door',
  );
  assert.deepEqual(tweede.codes, [0, 0]);

  // Run 3 begint weer bij het eerste blok: de rotatie is periodiek, dus eindig.
  const derde = draaiRonde({ aantalOpenPrs: 126, runNumber: 3, metMeting: false });
  assert.deepEqual(derde.targets, Array.from({ length: 100 }, (_, i) => String(i + 1)));
});

test('S16. een mislukte invalidatie stopt de volgende niet en maakt de ronde alsnog rood', () => {
  // Record-lokaal, net als bij de meting: zou de eerste mislukte POST de lus afbreken, dan hielden
  // alle latere heads hun oude `success`. De stap eindigt bewust rc 0 zodat de meetronde nog draait;
  // de rode kleur loopt via `pending_failed`, dat de afsluitende stap oppikt.
  const script = stepScript(TRUSTED_WRITER, 'Invalideer eerst iedere open head');
  const dir = mkdtempSync(join(tmpdir(), 'live-gate-invalidatie-'));
  const bin = join(dir, 'bin');
  const runnerTemp = join(dir, 'runner');
  mkdirSync(bin);
  mkdirSync(runnerTemp);
  const head = (n) => String(n).padStart(40, '0');
  writeFileSync(join(runnerTemp, 'heads.txt'), [
    `1 ${head(1)}`,
    `2 ${head(2)}`,   // deze POST faalt
    '3 -',            // de lijst gaf geen bruikbare head
    '4 nogeenhead',   // geen 40 hextekens
    `5 ${head(5)}`,
    '',               // lege regel: geen record, geen fout
  ].join('\n'));
  writeFileSync(join(dir, 'ronde.sh'), script);
  writeFileSync(join(dir, 'github-output.txt'), '');

  const path = join(bin, 'node');
  writeFileSync(path, ['#!/usr/bin/env bash',
    'head=""',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "--head-sha" ]; then head="$2"; fi',
    '  shift',
    'done',
    'echo "$head" >> "$STUB_LOG"',
    'case "$head" in',
    '  0000000000000000000000000000000000000002) exit 1 ;;',
    'esac',
    'exit 0',
  ].join('\n'));
  chmodSync(path, 0o755);

  const log = join(dir, 'log.txt');
  let status = 0;
  try {
    execFileSync('bash', [join(dir, 'ronde.sh')], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        RUNNER_TEMP: runnerTemp,
        REPOSITORY: 'owner/repo',
        STATUS_CONTEXT: 'autocoding-shield-live-receipts',
        GITHUB_TOKEN: 'x',
        GITHUB_OUTPUT: join(dir, 'github-output.txt'),
        STUB_LOG: log,
      },
      stdio: 'pipe',
    });
  } catch (error) {
    status = error.status;
  }

  assert.equal(status, 0, 'de invalidatiestap blokkeert de meetronde nooit');
  assert.deepEqual(
    readFileSync(log, 'utf8').trim().split('\n'),
    [head(1), head(2), head(5)],
    'PR 5 krijgt zijn invalidatiepoging ondanks de mislukking bij 2 en de kapotte heads bij 3 en 4',
  );
  assert.match(
    readFileSync(join(dir, 'github-output.txt'), 'utf8'),
    /pending_failed=1/,
    'de mislukking wordt doorgegeven en maakt de job rood',
  );
});

test('S17. verschuift de head tussen lijst en meting, dan is de OUDE pending en de NIEUWE gemeten', () => {
  // De lijst gaf head A; tegen de tijd dat de meetronde bij PR 40 is, staat de PR op head B. De eis:
  // A staat op `pending` (dus niet groen) en de uitspraak landt uitsluitend op de OPNIEUW gemeten
  // head B. Op B stond nog geen status van deze context, dus is ook B niet groen.
  const headA = '0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const headB = '0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const dir = mkdtempSync(join(tmpdir(), 'live-gate-headshift-'));
  const bin = join(dir, 'bin');
  const runnerTemp = join(dir, 'runner');
  mkdirSync(bin);
  mkdirSync(runnerTemp);
  writeFileSync(join(runnerTemp, 'heads.txt'), `40 ${headA}\n`);
  writeFileSync(join(runnerTemp, 'targets.txt'), '40\n');
  writeFileSync(join(dir, 'github-output.txt'), '');

  const stub = (name, body) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path, 0o755);
  };
  // De API levert bij de detailmeting de NIEUWE head.
  stub('gh', [
    'for arg in "$@"; do path="$arg"; done',
    'case "$path" in',
    `  */pulls/40) echo '{"head":{"sha":"${headB}"}}' ;;`,
    '  *) echo "[]" ;;',
    'esac',
  ].join('\n'));
  stub('sleep', 'exit 0');
  stub('node', [
    'if [ "$1" = "-e" ]; then exec "$REAL_NODE" "$@"; fi',
    'script="$1"; shift',
    'head=""; pending=0',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --head-sha) head="$2" ;;',
    '    --pending) pending=1 ;;',
    '  esac',
    '  shift',
    'done',
    'case "$script" in',
    '  */publish-live-status.mjs)',
    '    if [ "$pending" = 1 ]; then echo "PENDING $head" >> "$STUB_LOG";',
    '    else echo "PUBLISH $head" >> "$STUB_LOG"; fi',
    '    exit 0 ;;',
    '  */verify-review-gate.mjs) echo \'{"decision":"NO_GO","reasons":[]}\'; exit 1 ;;',
    'esac',
    'exit 0',
  ].join('\n'));

  const log = join(dir, 'log.txt');
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    REAL_NODE: process.execPath,
    RUNNER_TEMP: runnerTemp,
    REPOSITORY: 'owner/repo',
    STATUS_CONTEXT: 'autocoding-shield-live-receipts',
    GH_TOKEN: 'x',
    GITHUB_TOKEN: 'x',
    GITHUB_OUTPUT: join(dir, 'github-output.txt'),
    STUB_LOG: log,
  };
  for (const naam of ['Invalideer eerst iedere open head', 'Meet, beslis en publiceer per doel-PR']) {
    const pad = join(dir, `${naam.split(' ')[0]}.sh`);
    writeFileSync(pad, stepScript(TRUSTED_WRITER, naam));
    try {
      execFileSync('bash', [pad], { env, stdio: 'pipe' });
    } catch { /* de meetronde is rood op een NO_GO; dat is de uitkomst, niet de eigenschap */ }
  }

  assert.deepEqual(
    readFileSync(log, 'utf8').trim().split('\n'),
    [`PENDING ${headA}`, `PUBLISH ${headB}`],
    'de oude head blijft pending en de uitspraak landt alleen op de opnieuw gemeten head',
  );
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
