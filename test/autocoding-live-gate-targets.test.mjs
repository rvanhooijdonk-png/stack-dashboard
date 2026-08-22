/**
 * AUTOCODING_SHIELD — doelselectie, per-PR schrijfrij en budgetgrenzen van de trusted statuswriter.
 *
 * De writer wordt door geen enkel direct PR- of reviewevent gestart, maar door `issue_comment`,
 * `workflow_run` (na de onprivileged shield) en `schedule`. Codex-review `4998729801` mat in de
 * vorige vorm drie defecten, en dit bestand meet de reparatie ervan in plaats van haar te beloven:
 *
 *   1. inline `3834885350` — het `GITHUB_TOKEN`-quotum van duizend verzoeken per uur is GEDEELD per
 *      repository. Zolang iedere aanleiding een repositorybrede ronde veroorzaakte, kon één comment
 *      126 heads invalideren, het budget leegtrekken en de rest van de PR's op `pending` laten
 *      staan. Een event meet daarom nu hooguit ÉÉN pull request en raakt de open-PR-lijst niet aan;
 *      een schedule meet er hooguit `SCHEDULE_BUCKET_LIMIT`, en krimpt mee met wat er van het
 *      gedeelde quotum werkelijk over is.
 *   2. inline `3834885354` — `github.run_number` loopt door voor runs die als WACHTENDE run worden
 *      geannuleerd, dus bezoeken de runs die werkelijk draaien geen opeenvolgende blokken. De
 *      rotatie hangt nu aan een TIJDSLOT, en dat verschil wordt hier met een expliciete negatieve
 *      controle gemeten.
 *   3. de schrijfrij is per PULL REQUEST in plaats van globaal, met `cancel-in-progress: false` en
 *      `queue: max`, en er wordt pas ná die rij gemeten.
 *
 * Waar de eigenschap in de SHELL van het workflowbestand zit, wordt die shell hier echt uitgevoerd
 * met gestubde `gh`, `node` en `date` — niet nagebouwd.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  selectTargets, isTrustedWorkflowRunSource, issueCommentTarget, workflowRunTargets,
  normaliseOpenPullRequests, scheduleSlotOf, selectScheduleBucket, affordablePullRequests,
  parseTargetArgs, parseCounter, runSelect,
  EXPECTED_SOURCE, EVENT_TARGET_LIMIT, SCHEDULE_BUCKET_LIMIT, SCHEDULE_SLOT_SECONDS,
  PER_PULL_REQUEST_REQUEST_BUDGET, SELECTION_REQUEST_BUDGET, EVENT_REQUEST_BUDGET,
  SCHEDULE_REQUEST_BUDGET, SHARED_HOURLY_REQUEST_QUOTA, QUOTA_RESERVE,
  TARGET_OUTCOME, TARGET_REASON, TARGET_SELECTION,
} from '../scripts/autocoding/select-live-gate-targets.mjs';
import { analyzeWorkflow } from '../scripts/autocoding/workflow-trust.mjs';

const SELECTOR = 'scripts/autocoding/select-live-gate-targets.mjs';
const TRUSTED_WRITER = '.github/workflows/autocoding-shield-live-gate.yml';
const WRITER_TEKST = readFileSync(TRUSTED_WRITER, 'utf8');

const SELECTIE_STAP = "Bepaal de doel-PR's read-only";
const SCHRIJF_STAP = 'Meet, beslis en publiceer deze pull request';

/** Een geldige veertigtekens-SHA die uit één cijfer is op te maken, zodat logs leesbaar blijven. */
const sha = (n) => String(n).repeat(40).slice(0, 40);

const openPr = (number) => ({ number, head: { sha: sha(number % 10), ref: `branch-${number}` } });

function shieldRun(overrides = {}) {
  return {
    name: EXPECTED_SOURCE.workflowName,
    path: EXPECTED_SOURCE.workflowPath,
    event: 'pull_request',
    pull_requests: [{ number: 74 }],
    ...overrides,
  };
}

const commentOpPr = (number) => ({ issue: { number, pull_request: { url: `x/${number}` } } });

/** Snijdt het `run:`-blok van een stap uit workflowTEKST en haalt de inspringing eraf. */
function stapScript(text, stepName) {
  const lines = text.split('\n');
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

/** Zet een uitvoerbare stub op `PATH`. */
function stub(bin, name, body) {
  const path = join(bin, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

/** Een verse werkmap met een `bin/` voor stubs en een `runner/` als `RUNNER_TEMP`. */
function werkmap(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const bin = join(dir, 'bin');
  const runnerTemp = join(dir, 'runner');
  mkdirSync(bin);
  mkdirSync(runnerTemp);
  return { dir, bin, runnerTemp };
}

/** Draait een stapscript in echte bash en levert exitcode plus uitvoer. */
function draaiStap(script, { dir, bin, env }) {
  const pad = join(dir, 'stap.sh');
  writeFileSync(pad, script);
  try {
    const stdout = execFileSync('bash', [pad], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, ...env },
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status, stdout: String(error.stdout ?? '') };
  }
}

/** Eén regel uit de selector terugdraaien en de MUTANT importeren. */
function mutantVanDeSelector(naam, oud, nieuw) {
  const bron = readFileSync(SELECTOR, 'utf8');
  assert.equal(bron.split(oud).length - 1, 1, 'het mutatieanker moet precies één keer voorkomen');
  const dir = mkdtempSync(join(tmpdir(), `select-targets-${naam}-`));
  const pad = join(dir, `select-live-gate-targets.${naam}.mjs`);
  // De mutant leeft buiten de repository, dus moeten zijn imports absoluut worden.
  writeFileSync(pad, bron.replace(oud, nieuw).replace(
    "from './collect-shield-input.mjs'",
    `from ${JSON.stringify(pathToFileURL('scripts/autocoding/collect-shield-input.mjs').href)}`,
  ));
  return import(pathToFileURL(pad).href);
}

// --- Bronbegrenzing -----------------------------------------------------------------------------

test('S1. alleen de verwachte shieldrun op het verwachte pad en bronevent telt als aanleiding', () => {
  for (const event of EXPECTED_SOURCE.events) {
    assert.equal(isTrustedWorkflowRunSource(shieldRun({ event })), true, event);
  }
  // Naam, pad en bronevent moeten alle drie kloppen. Een PR kan een NIEUW workflowbestand toevoegen
  // met dezelfde naam op een ander pad; die mag de writer nooit kunnen starten.
  assert.equal(isTrustedWorkflowRunSource(shieldRun({ name: 'anders' })), false);
  assert.equal(isTrustedWorkflowRunSource(shieldRun({ path: '.github/workflows/kopie.yml' })), false);
  for (const event of ['push', 'workflow_dispatch', 'schedule', 'issue_comment', '']) {
    assert.equal(isTrustedWorkflowRunSource(shieldRun({ event })), false, event);
  }
  for (const stuk of [null, undefined, 'autocoding-shield', 42, [], [shieldRun()]]) {
    assert.equal(isTrustedWorkflowRunSource(stuk), false, String(stuk));
  }

  // `issue_comment` staat bewust NIET in de bronlijst: dat event verwerkt de writer zelf, direct
  // vanaf de default branch. Zou het hier óók staan, dan werd één comment twee keer gedispatcht.
  assert.ok(!EXPECTED_SOURCE.events.includes('issue_comment'));
  assert.deepEqual([...EXPECTED_SOURCE.events],
    ['pull_request', 'pull_request_review', 'pull_request_review_comment']);
});

test('S2. een onvertrouwde bron publiceert niets en is geen fout van deze poort', () => {
  const uitkomst = selectTargets({
    eventName: 'workflow_run',
    event: { workflow_run: shieldRun({ name: 'iets-anders' }) },
    openPullRequests: [openPr(74), openPr(75)],
  });
  assert.equal(uitkomst.outcome, TARGET_OUTCOME.NO_OP);
  assert.equal(uitkomst.reason, TARGET_REASON.SOURCE_NOT_TRUSTED);
  assert.deepEqual(uitkomst.targets, []);

  // Een vierde eventsoort is wél een defect: bestand en script zijn dan uit elkaar gelopen.
  for (const eventName of ['pull_request', 'push', 'workflow_dispatch', '', undefined]) {
    const vreemd = selectTargets({ eventName, event: {}, openPullRequests: [] });
    assert.equal(vreemd.outcome, TARGET_OUTCOME.FAIL, String(eventName));
    assert.equal(vreemd.reason, TARGET_REASON.EVENT_NOT_SUPPORTED, String(eventName));
  }
});

// --- Eventselectie: precies één pull request ----------------------------------------------------

test('S3. een issue_comment selecteert exact de PR uit zijn eigen payload, en verder niets', () => {
  const uitkomst = selectTargets({
    eventName: 'issue_comment',
    event: commentOpPr(74),
    openPullRequests: Array.from({ length: 126 }, (_, i) => openPr(i + 1)),
  });
  assert.equal(uitkomst.outcome, TARGET_OUTCOME.MEASURE);
  assert.equal(uitkomst.selection, TARGET_SELECTION.EVENT_PULL_REQUEST);
  assert.deepEqual(uitkomst.targets, [74], 'exact één doel: PR 74');
  assert.equal(uitkomst.targets.length, EVENT_TARGET_LIMIT);
  assert.equal(uitkomst.slot, null, 'een event roteert niet');

  // Een comment op een gewoon ISSUE wijst geen PR aan. `issue.pull_request` is het veld waarmee
  // GitHub dat onderscheid maakt; zonder dat veld is er niets te meten en is stil zwijgen juist.
  for (const payload of [
    { issue: { number: 74 } },
    { issue: { number: 74, pull_request: null } },
    { issue: { number: 0, pull_request: {} } },
    { issue: { number: -3, pull_request: {} } },
    { issue: { number: '74', pull_request: {} } },
    { issue: null },
    {},
  ]) {
    assert.equal(issueCommentTarget(payload), null, JSON.stringify(payload));
    const stil = selectTargets({ eventName: 'issue_comment', event: payload, openPullRequests: [] });
    assert.equal(stil.outcome, TARGET_OUTCOME.NO_OP);
    assert.equal(stil.reason, TARGET_REASON.EVENT_ASSOCIATION_EMPTY);
    assert.deepEqual(stil.targets, []);
  }
});

test('S4. een workflow_run selecteert exact één PR; meer dan één associatie is ambigu', () => {
  const enkel = selectTargets({
    eventName: 'workflow_run',
    event: { workflow_run: shieldRun({ pull_requests: [{ number: 74 }] }) },
    openPullRequests: Array.from({ length: 126 }, (_, i) => openPr(i + 1)),
  });
  assert.deepEqual(enkel.targets, [74]);
  assert.equal(enkel.selection, TARGET_SELECTION.EVENT_PULL_REQUEST);

  // Twee associaties: gokken zou óf te veel meten óf de verkeerde PR meten. De schedule vangt dit
  // binnen één slot alsnog op, dus is stil zwijgen hier de goedkope én juiste uitkomst.
  const ambigu = selectTargets({
    eventName: 'workflow_run',
    event: { workflow_run: shieldRun({ pull_requests: [{ number: 74 }, { number: 75 }] }) },
    openPullRequests: [],
  });
  assert.equal(ambigu.outcome, TARGET_OUTCOME.NO_OP);
  assert.equal(ambigu.reason, TARGET_REASON.EVENT_ASSOCIATION_AMBIGUOUS);
  assert.deepEqual(ambigu.targets, []);

  // Eén onbruikbare vermelding maakt de HELE lijst onbruikbaar. Bij een gedeeltelijk leesbare lijst
  // is niet bekend welke associatie er nog meer had moeten staan, dus mag er niets uit gekozen.
  assert.equal(workflowRunTargets({ pull_requests: [{ number: 74 }, { number: 'x' }] }), null);
  assert.equal(workflowRunTargets({ pull_requests: [{ number: 74 }, null] }), null);
  assert.equal(workflowRunTargets({ pull_requests: 'geen lijst' }), null);
  assert.deepEqual(workflowRunTargets({ pull_requests: [{ number: 75 }, { number: 74 }, { number: 74 }] }), [74, 75]);

  for (const lijst of [[], null, undefined, [{ number: 0 }]]) {
    const leeg = selectTargets({
      eventName: 'workflow_run',
      event: { workflow_run: shieldRun({ pull_requests: lijst }) },
      openPullRequests: [],
    });
    assert.equal(leeg.outcome, TARGET_OUTCOME.NO_OP, JSON.stringify(lijst));
    assert.equal(leeg.reason, TARGET_REASON.EVENT_ASSOCIATION_EMPTY, JSON.stringify(lijst));
  }
});

test('S5. een eventaanleiding is NOOIT een volledige sweep, hoeveel PR\'s er ook open staan', () => {
  // Dit is bevinding `3834885350` als eigenschap: de open-PR-lijst mag de uitkomst van een event
  // niet kunnen vergroten. Bij 126 open PR's blijft het doel er precies één, en dat doel hangt
  // uitsluitend aan de door GITHUB gevulde eventpayload.
  const open = Array.from({ length: 126 }, (_, i) => openPr(i + 1));
  for (const [naam, invoer] of [
    ['issue_comment', { eventName: 'issue_comment', event: commentOpPr(74) }],
    ['workflow_run', { eventName: 'workflow_run', event: { workflow_run: shieldRun() } }],
  ]) {
    const met = selectTargets({ ...invoer, openPullRequests: open });
    const zonder = selectTargets({ ...invoer, openPullRequests: [] });
    assert.deepEqual(met.targets, [74], naam);
    assert.deepEqual(met.targets, zonder.targets, `${naam}: de open lijst verandert niets`);
    assert.ok(met.targets.length <= EVENT_TARGET_LIMIT, naam);
    // En de selectievorm van de globale sweep bestaat niet meer.
    assert.equal(met.selection, TARGET_SELECTION.EVENT_PULL_REQUEST, naam);
  }
  assert.deepEqual(Object.keys(TARGET_SELECTION), ['EVENT_PULL_REQUEST', 'SCHEDULE_SLOT_BUCKET']);
  assert.equal(TARGET_SELECTION.ALL_OPEN_PULL_REQUESTS, undefined);
});

test('S5b. NEGATIEVE MUTATIE: een event dat tóch de hele lijst pakt, blaast de budgetgrens op', async () => {
  // De regel uit S5 is pas bewezen als de OUDE vorm er aantoonbaar op stukloopt. De mutant laat een
  // eventaanleiding weer alle open PR's meten; dat is precies de vorm die 126 heads invalideerde.
  const gemuteerd = await mutantVanDeSelector(
    'globale-sweep',
    `      selection: TARGET_SELECTION.EVENT_PULL_REQUEST,
      targets: candidates,`,
    `      selection: TARGET_SELECTION.EVENT_PULL_REQUEST,
      targets: normaliseOpenPullRequests(openPullRequests) ?? candidates,`,
  );

  const open = Array.from({ length: 126 }, (_, i) => openPr(i + 1));
  const invoer = { eventName: 'issue_comment', event: commentOpPr(74), openPullRequests: open };

  const sweep = gemuteerd.selectTargets(invoer);
  assert.equal(sweep.targets.length, 126, 'de mutant meet de hele lijst');
  const kosten = SELECTION_REQUEST_BUDGET + (sweep.targets.length * PER_PULL_REQUEST_REQUEST_BUDGET);
  assert.ok(kosten > SHARED_HOURLY_REQUEST_QUOTA,
    `de mutant kost ${kosten} verzoeken en overschrijdt het gedeelde uurquotum`);

  // De echte selector blijft bij één doel en ruim binnen het budget.
  assert.deepEqual(selectTargets(invoer).targets, [74]);
  assert.ok(EVENT_REQUEST_BUDGET < SHARED_HOURLY_REQUEST_QUOTA - QUOTA_RESERVE);
});

// --- Scheduleselectie: een eindig, eerlijk roterend blok -----------------------------------------

test('S6. de schedulebucket is hoogstens 25 en dekt alle 126 PR\'s over opeenvolgende tijdslots', () => {
  const open = Array.from({ length: 126 }, (_, i) => openPr(i + 1));
  const alleNummers = open.map((pr) => pr.number);
  const uur = SCHEDULE_SLOT_SECONDS;

  const ronde = (slot) => selectTargets({
    eventName: 'schedule', event: {}, openPullRequests: open, nowEpochSeconds: slot * uur,
  });

  const eerste = ronde(0);
  assert.equal(eerste.outcome, TARGET_OUTCOME.MEASURE);
  assert.equal(eerste.selection, TARGET_SELECTION.SCHEDULE_SLOT_BUCKET);
  assert.equal(eerste.bucketCount, Math.ceil(126 / SCHEDULE_BUCKET_LIMIT));
  assert.equal(eerste.bucketCount, 6);

  // Elke bucket blijft binnen de grens, en `bucketCount` opeenvolgende slots dekken de hele lijst
  // precies één keer — geen PR dubbel, geen PR overgeslagen.
  const gezien = [];
  for (let slot = 0; slot < eerste.bucketCount; slot += 1) {
    const uitkomst = ronde(slot);
    assert.ok(uitkomst.targets.length <= SCHEDULE_BUCKET_LIMIT, `slot ${slot}`);
    assert.ok(uitkomst.targets.length > 0, `slot ${slot}: nooit een lege ronde op een niet-lege lijst`);
    assert.equal(uitkomst.bucketIndex, slot % eerste.bucketCount, `slot ${slot}`);
    assert.equal(uitkomst.slot, slot, `slot ${slot}`);
    gezien.push(...uitkomst.targets);
  }
  assert.deepEqual([...gezien].sort((a, b) => a - b), alleNummers, 'volledige dekking');
  assert.equal(new Set(gezien).size, 126, 'geen enkele PR twee keer in dezelfde ronde');

  // De dekking begint niet per se bij slot 0: welk uur er ook toevallig eerst is, `bucketCount`
  // opeenvolgende uren daarna is iedereen geweest.
  for (const start of [1, 5, 471234, 999999]) {
    const dekking = new Set();
    for (let i = 0; i < eerste.bucketCount; i += 1) for (const n of ronde(start + i).targets) dekking.add(n);
    assert.equal(dekking.size, 126, `startslot ${start}`);
  }

  // Een lijst die korter is dan de limiet wordt niet afgekapt en roteert niet.
  const kort = selectTargets({
    eventName: 'schedule', event: {}, openPullRequests: [openPr(7), openPr(8)], nowEpochSeconds: 99 * uur,
  });
  assert.deepEqual(kort.targets, [7, 8]);
  assert.equal(kort.bucketCount, 1);
  assert.equal(kort.bucketIndex, 0);

  // Geen open PR's is geen fout.
  const leeg = selectTargets({ eventName: 'schedule', event: {}, openPullRequests: [], nowEpochSeconds: 0 });
  assert.equal(leeg.outcome, TARGET_OUTCOME.NO_OP);
  assert.equal(leeg.reason, TARGET_REASON.NO_OPEN_PULL_REQUESTS);

  // Een onleesbare lijst is wél een fout: stil doorgaan zou nul statussen opleveren terwijl een
  // eerder groene head groen blijft staan.
  for (const stuk of [[{ number: 'x' }], [null], 'geen lijst', 42]) {
    const kapot = selectTargets({
      eventName: 'schedule', event: {}, openPullRequests: stuk, nowEpochSeconds: 0,
    });
    assert.equal(kapot.outcome, TARGET_OUTCOME.FAIL, JSON.stringify(stuk));
    assert.equal(kapot.reason, TARGET_REASON.OPEN_PULL_REQUESTS_UNREADABLE, JSON.stringify(stuk));
  }
  assert.equal(normaliseOpenPullRequests([[openPr(2)], [openPr(1)]]).join(), '1,2', 'slurp-pagina\'s');
});

test('S6b. NEGATIEVE CONTROLE: rotatie op RUN-NUMMER verliest PR\'s, rotatie op TIJDSLOT niet', () => {
  // Bevinding `3834885354`. Een run-nummer telt RUNS — ook runs die als WACHTENDE run geannuleerd
  // worden en dus nooit draaien. De runs die wél draaien bezoeken daardoor geen opeenvolgende
  // residuen. Een tijdslot telt UREN en is onafhankelijk van hoeveel runs er zijn gestart,
  // geannuleerd of overgeslagen.
  const nummers = Array.from({ length: 126 }, (_, i) => i + 1);
  const count = Math.ceil(nummers.length / SCHEDULE_BUCKET_LIMIT);

  /** Precies de oude vorm: het blok volgt uit `github.run_number`. */
  const runNummerBucket = (runNumber) => {
    const index = (runNumber - 1) % count;
    return nummers.slice(index * SCHEDULE_BUCKET_LIMIT, (index * SCHEDULE_BUCKET_LIMIT) + SCHEDULE_BUCKET_LIMIT);
  };

  // Zes runs die werkelijk draaien, terwijl er tussendoor wachtende runs zijn geannuleerd. De
  // run-nummers lopen dan wél door maar niet aaneengesloten: 1, 7, 13, 19, 25, 31.
  const gedraaideRuns = [1, 7, 13, 19, 25, 31];
  const viaRunNummer = new Set(gedraaideRuns.flatMap(runNummerBucket));
  assert.equal(viaRunNummer.size, SCHEDULE_BUCKET_LIMIT,
    'zes draaiende runs bezoeken zes keer hetzelfde blok en zien maar 25 van de 126 PR\'s');
  assert.ok(viaRunNummer.size < nummers.length, 'de rest verhongert');

  // Dezelfde zes runs, maar dan met het uur waarin ze draaien als sleutel. De schedule staat op één
  // keer per uur, dus zijn dat per constructie zes OPEENVOLGENDE slots — hoeveel runs er tussendoor
  // ook geannuleerd zijn.
  const startUur = 471234;
  const viaTijdslot = new Set();
  for (let i = 0; i < gedraaideRuns.length; i += 1) {
    const slot = scheduleSlotOf((startUur + i) * SCHEDULE_SLOT_SECONDS);
    for (const n of selectScheduleBucket(nummers, slot).bucket) viaTijdslot.add(n);
  }
  assert.equal(viaTijdslot.size, 126, 'iedere PR komt binnen zes uur aan de beurt');
  assert.deepEqual([...viaTijdslot].sort((a, b) => a - b), nummers);

  // En het slot hangt aan de klok, niet aan de run: hetzelfde uur geeft hetzelfde blok, ongeacht
  // welke of hoeveelste run het is.
  assert.equal(scheduleSlotOf(471234 * 3600), scheduleSlotOf((471234 * 3600) + 3599));
  assert.equal(scheduleSlotOf(471235 * 3600), scheduleSlotOf(471234 * 3600) + 1);
});

test('S6c. een onbruikbare klok is ROOD, nooit stilzwijgend altijd blok 0', () => {
  // Zou een onbruikbare klok op blok 0 terugvallen, dan mat elke ronde dezelfde 25 PR's en kwam de
  // rest nooit aan de beurt. Dat is starvation met een groene run eromheen, dus wordt het rood.
  for (const klok of [null, undefined, -1, 1.5, Number.NaN, Infinity, '1000', {}]) {
    assert.equal(scheduleSlotOf(klok), null, String(klok));
    const uitkomst = selectTargets({
      eventName: 'schedule', event: {}, openPullRequests: [openPr(1)], nowEpochSeconds: klok,
    });
    assert.equal(uitkomst.outcome, TARGET_OUTCOME.FAIL, String(klok));
    assert.equal(uitkomst.reason, TARGET_REASON.SCHEDULE_SLOT_UNUSABLE, String(klok));
    assert.deepEqual(uitkomst.targets, [], String(klok));
  }
  assert.equal(scheduleSlotOf(3600, 0), null, 'een slotlengte van nul is geen slotlengte');
  assert.equal(scheduleSlotOf(3600, -1), null);

  // En een negatief of onleesbaar slot in de bucketkiezer snijdt nooit buiten de lijst: `%` levert
  // in JavaScript een negatief residu, en `slice` met een negatieve index telt vanaf achteren.
  const nummers = Array.from({ length: 126 }, (_, i) => i + 1);
  for (const slot of [-1, -7, -126, null, undefined, Number.NaN, 2.5]) {
    const uitkomst = selectScheduleBucket(nummers, slot);
    assert.ok(uitkomst.index >= 0 && uitkomst.index < uitkomst.count, String(slot));
    assert.ok(uitkomst.bucket.length > 0 && uitkomst.bucket.length <= SCHEDULE_BUCKET_LIMIT, String(slot));
  }

  // Een onbruikbare limiet valt terug op de canonieke limiet in plaats van op `Infinity`: zou
  // `count` `Infinity` worden, dan is `slot % Infinity` `NaN` en `slice(NaN, NaN)` leeg — een ronde
  // die niets meet en dus nooit convergeert.
  const canoniek = selectScheduleBucket(nummers, 0);
  for (const limiet of [0, -1, 2.5, Number.NaN, Infinity, null, undefined, '25', {}, []]) {
    const uitkomst = selectScheduleBucket(nummers, 0, limiet);
    assert.deepEqual(uitkomst, canoniek, `limiet ${String(limiet)}`);
    assert.ok(Number.isInteger(uitkomst.count) && uitkomst.count > 0, `limiet ${String(limiet)}`);
    assert.ok(uitkomst.bucket.length > 0, `limiet ${String(limiet)}`);
  }
});

// --- Het gedeelde API-budget --------------------------------------------------------------------

test('S7. de API-bovengrenzen liggen vast en blijven onder het gedeelde uurquotum', () => {
  // De rekensom staat naast de constanten in de selector; hier wordt hij tegen de WERKELIJKE stap
  // gehouden, zodat bestand en getal niet uit elkaar kunnen lopen.
  const stap = stapScript(WRITER_TEKST, SCHRIJF_STAP);
  const hermetingPogingen = stap.match(/for attempt in ([0-9 ]+); do/)[1].trim().split(/\s+/).length;
  const publicaties = (stap.match(/publish-live-status\.mjs/g) ?? []).length;
  // De bewijs-GET's staan in één lus over een vaste lijst `pad:naam`-paren; alleen `head-commit`
  // is ongepagineerd. Zo volgt het getal uit het BESTAND en niet uit een aanname.
  const endpoints = stap.match(/for endpoint in \\\n([\s\S]*?); do\n/)[1].match(/"[^"]+:[a-z-]+"/g);
  const gepagineerd = endpoints.filter((e) => !e.includes(':head-commit')).length;
  const enkelvoudig = endpoints.length - gepagineerd;

  assert.equal(hermetingPogingen, 3, 'hoogstens drie hermetingspogingen');
  assert.equal(publicaties, 2, 'precies één pending-POST en één eind-POST');
  assert.equal(endpoints.length, 6);
  assert.equal(gepagineerd, 5);
  assert.equal(enkelvoudig, 1);
  assert.equal(
    PER_PULL_REQUEST_REQUEST_BUDGET,
    hermetingPogingen + publicaties + enkelvoudig + (gepagineerd * 4),
    'het budget per PR volgt uit de stap zelf',
  );
  assert.equal(PER_PULL_REQUEST_REQUEST_BUDGET, 26);

  assert.equal(EVENT_REQUEST_BUDGET, SELECTION_REQUEST_BUDGET + PER_PULL_REQUEST_REQUEST_BUDGET);
  assert.equal(EVENT_REQUEST_BUDGET, 30);
  assert.equal(SCHEDULE_REQUEST_BUDGET, SELECTION_REQUEST_BUDGET + (25 * PER_PULL_REQUEST_REQUEST_BUDGET));
  assert.equal(SCHEDULE_REQUEST_BUDGET, 654);

  // Allebei passen ze met de vaste reserve binnen het GEDEELDE uurquotum, en een eventronde kost
  // minder dan een twintigste daarvan — zodat een druk uur vol events de schedule niet uithongert.
  assert.ok(EVENT_REQUEST_BUDGET + QUOTA_RESERVE < SHARED_HOURLY_REQUEST_QUOTA);
  assert.ok(SCHEDULE_REQUEST_BUDGET + QUOTA_RESERVE < SHARED_HOURLY_REQUEST_QUOTA);
  assert.ok(EVENT_REQUEST_BUDGET * 20 < SHARED_HOURLY_REQUEST_QUOTA);
  // En de oude volledige ronde over 126 PR's paste er juist NIET in. Dat is de bevinding zelf.
  assert.ok(SELECTION_REQUEST_BUDGET + (126 * PER_PULL_REQUEST_REQUEST_BUDGET) > SHARED_HOURLY_REQUEST_QUOTA);
});

test('S7b. de ronde krimpt mechanisch mee met wat er van het GEDEELDE quotum over is', () => {
  const open = Array.from({ length: 126 }, (_, i) => openPr(i + 1));
  const schedule = (remainingQuota) => selectTargets({
    eventName: 'schedule', event: {}, openPullRequests: open, nowEpochSeconds: 0, remainingQuota,
  });

  // Vol quotum: de volle bucket.
  assert.equal(schedule(SHARED_HOURLY_REQUEST_QUOTA).targets.length, SCHEDULE_BUCKET_LIMIT);
  // Onbekend quotum: de vaste bovengrens, die sowieso binnen het uurquotum past.
  assert.equal(schedule(null).targets.length, SCHEDULE_BUCKET_LIMIT);
  assert.equal(affordablePullRequests(null), null);
  assert.equal(affordablePullRequests('900'), null);

  // Halfvol: de bucket krimpt tot wat er ná de reserve nog past.
  const half = schedule(400);
  assert.equal(affordablePullRequests(400), Math.floor((400 - QUOTA_RESERVE - SELECTION_REQUEST_BUDGET) / 26));
  assert.equal(half.targets.length, affordablePullRequests(400));
  assert.ok(half.targets.length < SCHEDULE_BUCKET_LIMIT && half.targets.length > 0);
  assert.ok(SELECTION_REQUEST_BUDGET + (half.targets.length * PER_PULL_REQUEST_REQUEST_BUDGET) <= 400 - QUOTA_RESERVE);

  // Bijna leeg: er past niet eens één PR meer bij, dus wordt er niets gepubliceerd. Dat is een
  // no-op en geen fout — de volgende ronde vangt het op, en de reserve blijft staan.
  for (const rest of [0, 50, QUOTA_RESERVE, QUOTA_RESERVE + SELECTION_REQUEST_BUDGET + 25]) {
    const krap = schedule(rest);
    assert.equal(krap.outcome, TARGET_OUTCOME.NO_OP, String(rest));
    assert.equal(krap.reason, TARGET_REASON.API_BUDGET_RESERVED, String(rest));
    assert.deepEqual(krap.targets, [], String(rest));
  }

  // Ook een EVENT wijkt voor de reserve. Eén PR is 26 verzoeken; past dat er niet meer bij, dan
  // publiceert deze aanleiding niets in plaats van halverwege leeg te raken.
  const eventKrap = selectTargets({
    eventName: 'issue_comment', event: commentOpPr(74), openPullRequests: [], remainingQuota: QUOTA_RESERVE + 10,
  });
  assert.equal(eventKrap.outcome, TARGET_OUTCOME.NO_OP);
  assert.equal(eventKrap.reason, TARGET_REASON.API_BUDGET_RESERVED);
  const eventRuim = selectTargets({
    eventName: 'issue_comment', event: commentOpPr(74), openPullRequests: [], remainingQuota: 900,
  });
  assert.deepEqual(eventRuim.targets, [74]);
});

// --- De CLI -------------------------------------------------------------------------------------

test('S8. de CLI leest zijn argumenten fail-closed', () => {
  const volledig = [
    '--event-name', 'schedule', '--event', 'e.json', '--open-pulls', 'o.json',
    '--now-epoch', '1000', '--remaining-quota', '900', '--out', 't.json',
  ];
  assert.equal(parseTargetArgs(volledig).ok, true);

  // Ontbrekend, dubbel, onbekend, waardeloos of een optie als waarde: alles wordt geweigerd in
  // plaats van stilzwijgend geherinterpreteerd.
  assert.equal(parseTargetArgs(volledig.slice(0, -2)).ok, false, 'ontbrekende optie');
  assert.equal(parseTargetArgs([...volledig, '--out', 'x.json']).ok, false, 'dubbele optie');
  assert.equal(parseTargetArgs([...volledig, '--vreemd', 'x']).ok, false, 'onbekende optie');
  assert.equal(parseTargetArgs([...volledig, '--out']).ok, false, 'optie zonder waarde');
  assert.equal(
    parseTargetArgs(volledig.map((v) => (v === 't.json' ? '--event' : v))).ok, false, 'optie als waarde',
  );
  assert.equal(parseTargetArgs(volledig.map((v) => (v === '900' ? '' : v))).ok, false, 'lege waarde');
  assert.equal(parseTargetArgs('geen lijst').ok, false);

  // De teller leest alleen decimale cijfers; `-` is de afgesproken onbekend-vorm.
  assert.equal(parseCounter('900'), 900);
  assert.equal(parseCounter('0'), 0);
  for (const stuk of ['-', '', ' 900', '9e2', '-1', '1.5', '0x10', null, 900]) {
    assert.equal(parseCounter(stuk), null, String(stuk));
  }
});

test('S9. de CLI vertaalt uitkomsten naar exitcodes en schrijft ALTIJD een geldige matrix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-gate-cli-'));
  const bestanden = new Map();
  const readFile = (pad) => {
    if (!bestanden.has(pad)) throw new Error('ENOENT');
    return bestanden.get(pad);
  };
  const geschreven = new Map();
  const writeFile = (pad, data) => geschreven.set(pad, data);
  const argv = (eventName) => [
    '--event-name', eventName, '--event', 'e.json', '--open-pulls', 'o.json',
    '--now-epoch', '1696118400', '--remaining-quota', '900', '--out', join(dir, 'targets.json'),
  ];
  const uit = () => JSON.parse(geschreven.get(join(dir, 'targets.json')));

  // rc 0 met doelen: de matrixvorm die `fromJSON()` inleest.
  bestanden.set('e.json', JSON.stringify(commentOpPr(74)));
  bestanden.set('o.json', '[]');
  assert.equal(runSelect(argv('issue_comment'), { readFile, writeFile }), 0);
  assert.deepEqual(uit(), [74]);

  // rc 2 bij een no-op, met een LEGE matrix: nooit een oude lijst erven.
  bestanden.set('e.json', JSON.stringify({ issue: { number: 74 } }));
  assert.equal(runSelect(argv('issue_comment'), { readFile, writeFile }), 2);
  assert.deepEqual(uit(), []);

  // rc 1 bij een echte fout, eveneens met een lege matrix.
  bestanden.set('e.json', '{}');
  bestanden.set('o.json', '"geen lijst"');
  assert.equal(runSelect(argv('schedule'), { readFile, writeFile }), 1);
  assert.deepEqual(uit(), []);

  // Onleesbare invoer is rood, niet stil.
  bestanden.set('o.json', 'geen json');
  assert.equal(runSelect(argv('schedule'), { readFile, writeFile }), 1);
  assert.deepEqual(uit(), []);

  // Kapotte argumenten zijn rood vóór er iets gelezen wordt.
  assert.equal(runSelect(['--out'], { readFile, writeFile }), 1);

  // En een schedule met open PR's levert een bucket van hoogstens 25 nummers op.
  bestanden.set('e.json', '{}');
  bestanden.set('o.json', JSON.stringify(Array.from({ length: 126 }, (_, i) => openPr(i + 1))));
  assert.equal(runSelect(argv('schedule'), { readFile, writeFile }), 0);
  const bucket = uit();
  assert.ok(Array.isArray(bucket) && bucket.length === SCHEDULE_BUCKET_LIMIT);
  assert.ok(bucket.every((n) => Number.isInteger(n) && n > 0));
});

// --- De selectiestap van de workflow zelf --------------------------------------------------------

test('S10. de selectiestap haalt de open-PR-lijst alleen op bij een SCHEDULE', () => {
  // De echte shell uit het workflowbestand, met gestubde `gh` en `date`. Een eventaanleiding mag de
  // lijst niet aanraken: zou hij dat wel doen, dan kon één comment weer een repositorybrede ronde
  // veroorzaken. `node` blijft hier ECHT — de selector is de code die gemeten wordt.
  const script = stapScript(WRITER_TEKST, SELECTIE_STAP);

  const draai = (eventName, event, ghExtra = '') => {
    const { dir, bin, runnerTemp } = werkmap('live-gate-selectie-');
    const ghLog = join(dir, 'gh.txt');
    stub(bin, 'gh', [
      'echo "$*" >> "$GH_LOG"',
      'case "$*" in',
      "  *rate_limit*) echo 900 ;;",
      ghExtra,
      '  *) echo "[]" ;;',
      'esac',
    ].join('\n'));
    stub(bin, 'date', 'echo 1696118400');
    const eventPad = join(dir, 'event.json');
    writeFileSync(eventPad, JSON.stringify(event));
    const outputPad = join(dir, 'output.txt');
    writeFileSync(outputPad, '');
    const uitkomst = draaiStap(script, {
      dir,
      bin,
      env: {
        GH_LOG: ghLog,
        GH_TOKEN: 'x',
        REPOSITORY: 'owner/repo',
        EVENT_NAME: eventName,
        RUNNER_TEMP: runnerTemp,
        GITHUB_EVENT_PATH: eventPad,
        GITHUB_OUTPUT: outputPad,
      },
    });
    return {
      ...uitkomst,
      output: readFileSync(outputPad, 'utf8'),
      ghAanroepen: existsSync(ghLog) ? readFileSync(ghLog, 'utf8').trim().split('\n') : [],
    };
  };

  const comment = draai('issue_comment', commentOpPr(74));
  assert.equal(comment.status, 0);
  assert.match(comment.output, /pull_requests=\[74\]/);
  assert.match(comment.output, /measure=true/);
  assert.deepEqual(
    comment.ghAanroepen.filter((regel) => regel.includes('state=open')), [],
    'een eventaanleiding raakt de open-PR-lijst niet aan',
  );
  assert.equal(comment.ghAanroepen.length, 1, 'alleen de gratis rate_limit-meting');

  // Een comment op een gewoon issue schrijft niets en is geen rode run.
  const geenPr = draai('issue_comment', { issue: { number: 74 } });
  assert.equal(geenPr.status, 0);
  assert.match(geenPr.output, /pull_requests=\[\]/);
  assert.match(geenPr.output, /measure=false/);

  // De schedule haalt de lijst wél op, en meet er hoogstens 25.
  const lijst = JSON.stringify(Array.from({ length: 126 }, (_, i) => openPr(i + 1))).replace(/'/g, '');
  const schedule = draai('schedule', {}, `  *state=open*) echo '${lijst}' ;;`);
  assert.equal(schedule.status, 0);
  assert.match(schedule.output, /measure=true/);
  const doelen = JSON.parse(schedule.output.match(/pull_requests=(\[.*\])/)[1]);
  assert.equal(doelen.length, SCHEDULE_BUCKET_LIMIT);
  assert.ok(schedule.ghAanroepen.some((regel) => regel.includes('state=open')));

  // Een onbereikbare lijst is rood en meet niets: stil doorgaan zou nul statussen publiceren.
  const kapot = draai('schedule', {}, '  *state=open*) exit 1 ;;');
  assert.equal(kapot.status, 1);
  assert.match(kapot.stdout, /OPEN_PULL_REQUEST_LIST_UNAVAILABLE/);
});

// --- De per-PR schrijfrij -------------------------------------------------------------------------

/** De concurrencygroep van de schrijfjob, met een echte matrixwaarde ingevuld. */
function groepVoor(prNummer, text = WRITER_TEKST) {
  const schrijf = analyzeWorkflow(text).jobs.find((job) => job.id === 'schrijf');
  assert.ok(schrijf?.concurrency && !schrijf.concurrency.unparseable, 'de schrijfjob heeft een rij');
  return schrijf.concurrency.group.replace(/\$\{\{\s*matrix\.pr\s*\}\}/g, String(prNummer));
}

test('S11. PR 74 en PR 75 krijgen verschillende rijen; twee beurten voor PR 74 delen er één', () => {
  const analyse = analyzeWorkflow(WRITER_TEKST);
  const schrijf = analyse.jobs.find((job) => job.id === 'schrijf');

  // Verschillende PR's blokkeren elkaar niet.
  assert.notEqual(groepVoor(74), groepVoor(75));
  assert.equal(new Set([74, 75, 76].map((n) => groepVoor(n))).size, 3);

  // Twee AANLEIDINGEN voor dezelfde PR — een comment en een reviewrun, in verschillende workflowruns
  // met verschillende run-id's — vallen in exact dezelfde groep. Er staat immers niets runafhankelijks
  // in de sleutel, en dat is precies wat de groep serialiseerbaar maakt.
  assert.equal(groepVoor(74), groepVoor(74));
  assert.doesNotMatch(schrijf.concurrency.group, /github\.(run_id|run_number|run_attempt|event|sha|ref|job)/);
  assert.match(schrijf.concurrency.group, /\$\{\{\s*matrix\.pr\s*\}\}/);
  assert.deepEqual(schrijf.matrixKeys, ['pr']);

  // De rij WACHT in plaats van te annuleren. Met de standaard `single` zou een derde aanleiding de
  // tweede opeten en kon een invalidatie stil verdwijnen; `cancel-in-progress: true` zou een lopende
  // beurt afkappen en een head op `pending` laten staan.
  assert.equal(schrijf.concurrency.queue, 'max');
  assert.equal(schrijf.concurrency.cancelInProgress, 'false');

  // En de rij staat op JOBNIVEAU. Een groep op workflowniveau zou hele runs coalesceren, inclusief
  // hun schrijfjobs, en de per-PR-rijen weer samenvoegen.
  assert.equal(analyse.workflowLevelConcurrency, false);
  assert.equal(analyse.jobs.find((job) => job.id === 'selecteer').concurrency, null);

  // De matrix komt uit de selectiejob, dus per doel-PR ontstaat er één job met een eigen rij.
  assert.match(WRITER_TEKST, /pr: \$\{\{ fromJSON\(needs\.selecteer\.outputs\.pull_requests\) \}\}/);
});

/**
 * De structurele eis "er wordt pas ná de lock gemeten", als toetsbare functie. Alle drie de
 * onderdelen zijn nodig: de rij moet op de schrijfjob zitten (dan is hij verworven vóór de eerste
 * stap), de selectiefase mag niets dan NUMMERS doorgeven (geen head, geen momentopname), en de
 * schrijfstap moet zelf hermeten vóór hij publiceert.
 */
function lockBevindingen(text) {
  const bevindingen = [];
  const analyse = analyzeWorkflow(text);
  const schrijf = analyse.jobs.find((job) => job.id === 'schrijf');
  if (!schrijf) return ['SCHRIJFJOB_ONTBREEKT'];
  if (!schrijf.concurrency || schrijf.concurrency.unparseable) bevindingen.push('SCHRIJFJOB_ZONDER_EIGEN_RIJ');
  if (analyse.workflowLevelConcurrency) bevindingen.push('RIJ_OP_WORKFLOWNIVEAU');

  // De uitvoer van de selectiefase, letterlijk uit het bestand: alles tussen `outputs:` en de
  // volgende sleutel op hetzelfde niveau.
  const uitvoerBlok = text.match(/\n    outputs:\n((?:      \S.*\n)+)/)?.[1] ?? '';
  if (/^ {6}(heads?|sha|head_sha|snapshot)\s*:/m.test(uitvoerBlok)) {
    bevindingen.push('SELECTIE_GEEFT_EEN_MOMENTOPNAME_DOOR');
  }

  const stap = stapScript(text, SCHRIJF_STAP);
  const hermeting = stap.indexOf('repos/$REPOSITORY/pulls/$number');
  const publicatie = stap.indexOf('publish-live-status.mjs');
  if (hermeting === -1) bevindingen.push('GEEN_HERMETING_NA_LOCK');
  else if (publicatie !== -1 && publicatie < hermeting) bevindingen.push('PUBLICATIE_VOOR_HERMETING');
  return bevindingen;
}

test('S12. er wordt pas NA de per-PR-lock gemeten, en elke afwijking daarvan is aantoonbaar rood', () => {
  assert.deepEqual(lockBevindingen(WRITER_TEKST), []);

  // De schrijfjob krijgt uit de selectiefase uitsluitend het PR-NUMMER mee. Geen head, geen
  // momentopname, geen artifact, geen cache — anders zou een gequeueëde beurt een toestand
  // publiceren die vóór haar lock is gemeten.
  const stap = stapScript(WRITER_TEKST, SCHRIJF_STAP);
  assert.match(WRITER_TEKST, /PULL_REQUEST: \$\{\{ matrix\.pr \}\}/);
  assert.doesNotMatch(stap, /needs\.selecteer/);
  assert.doesNotMatch(stap, /github\.event\.[a-z_]*\.?head/);
  assert.doesNotMatch(stap, /workflow_run/);

  // MUTATIE 1: de rij naar workflowniveau verplaatsen. Dan coalesceren hele runs weer.
  const werkstroomRij = WRITER_TEKST.replace(
    'permissions: {}\n',
    'permissions: {}\nconcurrency:\n  group: autocoding-shield-live-gate\n  cancel-in-progress: false\n',
  );
  assert.ok(lockBevindingen(werkstroomRij).includes('RIJ_OP_WORKFLOWNIVEAU'));

  // MUTATIE 2: de rij van de schrijfjob weghalen. Dan meet elke beurt zonder te wachten.
  const zonderRij = WRITER_TEKST
    .replace('    concurrency:\n      group: autocoding-shield-live-gate-pr-${{ matrix.pr }}\n      cancel-in-progress: false\n      queue: max\n', '');
  assert.ok(lockBevindingen(zonderRij).includes('SCHRIJFJOB_ZONDER_EIGEN_RIJ'));

  // MUTATIE 3: de selectiefase een head laten doorgeven. Dan is de gepubliceerde toestand vóór de
  // lock gemeten en kan een oudere beurt een nieuwere overschrijven.
  const metMomentopname = WRITER_TEKST.replace(
    '      measure: ${{ steps.doelen.outputs.measure }}\n',
    '      measure: ${{ steps.doelen.outputs.measure }}\n      head_sha: ${{ steps.doelen.outputs.head_sha }}\n',
  );
  assert.ok(lockBevindingen(metMomentopname).includes('SELECTIE_GEEFT_EEN_MOMENTOPNAME_DOOR'));

  // MUTATIE 4: publiceren vóór er hermeten is.
  const teVroeg = WRITER_TEKST.replace(
    '          overall=0\n',
    '          overall=0\n          node scripts/autocoding/publish-live-status.mjs --pending\n',
  );
  assert.ok(lockBevindingen(teVroeg).includes('PUBLICATIE_VOOR_HERMETING'));

  // MUTATIE 5: helemaal niet hermeten.
  const zonderHermeting = WRITER_TEKST.replace('repos/$REPOSITORY/pulls/$number', 'repos/$REPOSITORY/pulls/1');
  assert.ok(lockBevindingen(zonderHermeting).includes('GEEN_HERMETING_NA_LOCK'));
});

// --- De schrijfstap zelf, in echte bash ----------------------------------------------------------

/**
 * Voert de echte schrijfstap uit voor één PR, met gestubde `gh`, `node` en `sleep`.
 *
 * `gh` en de publisher zijn gestubd omdat ze anders werkelijk het netwerk op zouden gaan; de
 * VOLGORDE en de bijbehorende argumenten worden in één gedeeld logboek vastgelegd, zodat "eerst
 * pending, dan bewijs, dan de eindstatus op dezelfde head" meetbaar is in plaats van beloofd.
 */
function draaiSchrijfstap({ pr, prJson, ghFaalt = [], publishFaalt = [], beslissing = 'GO' }) {
  const { dir, bin } = werkmap('live-gate-schrijf-');
  const runnerTemp = join(dir, 'runner');
  const log = join(dir, 'log.txt');

  stub(bin, 'gh', [
    'for arg in "$@"; do path="$arg"; done',
    'echo "GET $path" >> "$LOG"',
    'case "$path" in',
    ...ghFaalt.map((patroon) => `  *${patroon}*) exit 1 ;;`),
    `  */pulls/${pr}) cat "$PR_JSON" ;;`,
    '  *) echo "[]" ;;',
    'esac',
  ].join('\n'));
  stub(bin, 'sleep', 'exit 0');
  stub(bin, 'node', [
    // De head-extractie is echte productiecode en draait dus op de echte node.
    'if [ "$1" = "-e" ]; then exec "$REAL_NODE" "$@"; fi',
    'script="$1"; shift',
    'args="$*"',
    'case "$script" in',
    '  */publish-live-status.mjs)',
    '    case "$args" in',
    '      *--pending*) echo "PENDING $args" >> "$LOG" ;;',
    '      *) echo "FINAL $args" >> "$LOG" ;;',
    '    esac',
    ...publishFaalt.map((patroon) => `    case "$args" in *${patroon}*) exit 1 ;; esac`),
    '    exit 0 ;;',
    '  */collect-shield-input.mjs) echo "COLLECT" >> "$LOG"; exit 0 ;;',
    `  */verify-review-gate.mjs) echo "VERIFY" >> "$LOG"; echo '{"decision":"${beslissing}"}'; exit 0 ;;`,
    'esac',
    'exit 0',
  ].join('\n'));

  const prPad = join(dir, 'pr.json');
  writeFileSync(prPad, JSON.stringify(prJson));

  const uitkomst = draaiStap(stapScript(WRITER_TEKST, SCHRIJF_STAP), {
    dir,
    bin,
    env: {
      REAL_NODE: process.execPath,
      RUNNER_TEMP: runnerTemp,
      REPOSITORY: 'owner/repo',
      STATUS_CONTEXT: 'autocoding-shield-live-receipts',
      GH_TOKEN: 'x',
      GITHUB_TOKEN: 'x',
      PULL_REQUEST: String(pr),
      PR_JSON: prPad,
      LOG: log,
    },
  });
  return {
    ...uitkomst,
    regels: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [],
  };
}

test('S13. een event voor PR 74 publiceert uitsluitend op PR 74, en op de HERMETEN head', () => {
  const head = sha(7);
  const { status, regels } = draaiSchrijfstap({
    pr: 74, prJson: { state: 'open', merged: false, head: { sha: head } },
  });

  assert.equal(status, 0, 'een bewezen GO is groen');

  // 1. eerst hermeten, 2. dan onmiddellijk pending op die head, 3. dan pas het overige bewijs,
  // 4. en de eindstatus op precies dezelfde head.
  assert.equal(regels[0], 'GET repos/owner/repo/pulls/74');
  assert.match(regels[1], /^PENDING /);
  assert.match(regels[1], new RegExp(`--head-sha ${head}`));
  assert.ok(regels.slice(2).some((r) => r.startsWith('GET ')), 'het bewijs komt ná de invalidatie');
  const finaal = regels.filter((r) => r.startsWith('FINAL '));
  assert.equal(finaal.length, 1, 'precies één eindstatus');
  assert.match(finaal[0], new RegExp(`--head-sha ${head}`));
  assert.match(finaal[0], /--status-context autocoding-shield-live-receipts/);

  // Er wordt precies één PR aangeraakt. Geen andere PR, geen open-PR-lijst, geen tweede head.
  const gets = regels.filter((r) => r.startsWith('GET '));
  assert.ok(gets.every((r) => !/pulls\/(?!74\b)[0-9]+/.test(r)), 'geen enkele andere PR');
  assert.ok(gets.every((r) => !r.includes('state=open')), 'geen repositorybrede lijst');
  const koppen = new Set(regels.filter((r) => /--head-sha/.test(r)).map((r) => r.match(/--head-sha (\S+)/)[1]));
  assert.deepEqual([...koppen], [head], 'alle statussen landen op één en dezelfde head');

  // En het aantal API-verzoeken van deze beurt blijft onder de vastgelegde bovengrens per PR.
  assert.ok(regels.length <= PER_PULL_REQUEST_REQUEST_BUDGET,
    `${regels.length} verzoeken, budget ${PER_PULL_REQUEST_REQUEST_BUDGET}`);
});

test('S14. een samengevoegde of gesloten PR krijgt GEEN gegokte status', () => {
  for (const prJson of [
    { state: 'closed', merged: true, head: { sha: sha(3) } },
    { state: 'closed', merged: false, head: { sha: sha(3) } },
    { state: 'open', merged: true, head: { sha: sha(3) } },
  ]) {
    const { status, stdout, regels } = draaiSchrijfstap({ pr: 74, prJson });
    assert.equal(status, 0, 'geen fout: er is alleen niets meer te meten');
    assert.match(stdout, /PR_74_NOT_OPEN_NO_STATUS/);
    assert.deepEqual(regels.filter((r) => /PENDING|FINAL/.test(r)), [], JSON.stringify(prJson));
  }
});

test('S15. een head die niet te meten is, is ROOD zonder status', () => {
  // Zonder head is er geen commit om de uitspraak op te schrijven. Gokken zou de verkeerde head
  // markeren, dus wordt de run rood en blijft de status ongewijzigd.
  const drieKeerStuk = draaiSchrijfstap({ pr: 74, prJson: {}, ghFaalt: ['/pulls/74'] });
  assert.equal(drieKeerStuk.status, 1);
  assert.match(drieKeerStuk.stdout, /PR_74_HEAD_UNMEASURED/);
  assert.deepEqual(drieKeerStuk.regels.filter((r) => /PENDING|FINAL/.test(r)), []);
  assert.equal(drieKeerStuk.regels.filter((r) => r.startsWith('GET ')).length, 3, 'hoogstens drie pogingen');

  // Een leesbaar antwoord zonder bruikbare SHA telt evenmin als meting.
  for (const prJson of [{ state: 'open', head: {} }, { state: 'open', head: { sha: 'kort' } }, {}]) {
    const uitkomst = draaiSchrijfstap({ pr: 74, prJson });
    assert.equal(uitkomst.status, 1, JSON.stringify(prJson));
    assert.deepEqual(uitkomst.regels.filter((r) => /PENDING|FINAL/.test(r)), [], JSON.stringify(prJson));
  }

  // Een niet-numeriek matrixnummer is een defect, geen ruis.
  const { status, stdout } = draaiSchrijfstap({ pr: 'x; rm -rf /', prJson: {} });
  assert.equal(status, 1);
  assert.match(stdout, /PULL_REQUEST_NUMBER_INVALID/);
});

test('S16. een mislukte invalidatie stopt de beurt niet, maar maakt hem wel rood', () => {
  // De eindstatus overschrijft dezelfde head en is de echte invalidatie, dus doorgaan is beter dan
  // stoppen — maar het record moet rood zijn, anders blijft een gemiste invalidatie onzichtbaar.
  const head = sha(4);
  const { status, regels } = draaiSchrijfstap({
    pr: 74, prJson: { state: 'open', merged: false, head: { sha: head } }, publishFaalt: ['--pending'],
  });
  assert.equal(status, 1);
  assert.equal(regels.filter((r) => r.startsWith('PENDING ')).length, 1);
  const finaal = regels.filter((r) => r.startsWith('FINAL '));
  assert.equal(finaal.length, 1, 'de eindstatus wordt alsnog gepubliceerd');
  assert.match(finaal[0], new RegExp(`--head-sha ${head}`));

  // Mislukte bewijs-GET's worden als uitvoeringsfout doorgegeven, niet verzwegen, en landen alsnog
  // als uitspraak op de gemeten head.
  const zonderBewijs = draaiSchrijfstap({
    pr: 74,
    prJson: { state: 'open', merged: false, head: { sha: head } },
    ghFaalt: ['reviews', 'comments', 'files', 'commits'],
  });
  const uitspraak = zonderBewijs.regels.filter((r) => r.startsWith('FINAL '));
  assert.equal(uitspraak.length, 1);
  assert.match(uitspraak[0], /--execution-error GATE_EXECUTION_ERROR/);
  assert.match(uitspraak[0], new RegExp(`--head-sha ${head}`));
  // Bij een uitvoeringsfout wordt de uitspraak niet eens meer berekend: er is geen bewijs om op te
  // beslissen, dus zou een `GO` een gok zijn.
  assert.deepEqual(zonderBewijs.regels.filter((r) => r === 'VERIFY'), []);
});

test('S17. een gequeueëde OUDERE beurt herleest al haar bewijs en publiceert de NIEUWSTE head', () => {
  // Twee aanleidingen voor PR 74 staan in dezelfde rij en draaien dus na elkaar. De tweede beurt is
  // ouder — zij is eerder aangemaakt en heeft staan wachten — maar zij leest haar head pas NA de
  // lock. Tussen de twee beurten verschuift de head; de tweede publicatie moet de nieuwe dragen.
  const oud = sha(1);
  const nieuw = sha(9);

  const eerste = draaiSchrijfstap({
    pr: 74, prJson: { state: 'open', merged: false, head: { sha: oud } },
  });
  const tweede = draaiSchrijfstap({
    pr: 74, prJson: { state: 'open', merged: false, head: { sha: nieuw } },
  });

  const eindstatus = (uitkomst) => uitkomst.regels.filter((r) => r.startsWith('FINAL '))[0];
  assert.match(eindstatus(eerste), new RegExp(`--head-sha ${oud}`));
  assert.match(eindstatus(tweede), new RegExp(`--head-sha ${nieuw}`),
    'de wachtende beurt publiceert op de head die zij ZELF na de lock mat');

  // De beurt draagt geen enkele waarde uit haar aanleiding mee: haar enige invoer is het PR-nummer,
  // en al het bewijs komt uit verzoeken die ná de lock worden gedaan.
  assert.equal(tweede.regels[0], 'GET repos/owner/repo/pulls/74');
  assert.ok(tweede.regels.filter((r) => r.startsWith('GET ')).length >= 6, 'al het bewijs opnieuw');
  const stap = stapScript(WRITER_TEKST, SCHRIJF_STAP);
  assert.doesNotMatch(stap, /GITHUB_EVENT_PATH/, 'geen enkel veld uit de eventpayload');
});
