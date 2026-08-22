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
  scheduleBucketVisit, selectBucketWindow,
  parseTargetArgs, parseCounter, parseCompleteness, runSelect,
  EXPECTED_SOURCE, EVENT_TARGET_LIMIT, SCHEDULE_BUCKET_LIMIT, SCHEDULE_SLOT_SECONDS,
  LIST_PAGE_BUDGET, SELECTION_PAGE_BUDGET,
  PER_PULL_REQUEST_REQUEST_BUDGET, SELECTION_REQUEST_BUDGET, EVENT_REQUEST_BUDGET,
  SCHEDULE_REQUEST_BUDGET, SHARED_HOURLY_REQUEST_QUOTA, QUOTA_RESERVE,
  TARGET_OUTCOME, TARGET_REASON, TARGET_SELECTION,
} from '../scripts/autocoding/select-live-gate-targets.mjs';
import {
  analyzeWorkflow, isRepositoryWideQueuedLock, TRUSTED_WRITER_REPOSITORY_LOCK_GROUP,
} from '../scripts/autocoding/workflow-trust.mjs';
import { resolvePublication } from '../scripts/autocoding/publish-live-status.mjs';

/**
 * Een ruim, BEKEND restquotum. Sinds de reparatie van bevinding `3835186662` is een ONBEKEND
 * restant fail-closed: elke aanleiding die werkelijk wil meten moet een gemeten getal doorgeven,
 * precies zoals de workflow dat doet. Tests die het budget niet onderzoeken gebruiken dit getal.
 */
const RUIM_QUOTUM = 1000;

const SELECTOR = 'scripts/autocoding/select-live-gate-targets.mjs';
const BOUNDED_PAGES = 'scripts/autocoding/gh-bounded-pages.sh';
const BOUNDED_TEKST = readFileSync(BOUNDED_PAGES, 'utf8');
const TRUSTED_WRITER = '.github/workflows/autocoding-shield-live-gate.yml';
const WRITER_TEKST = readFileSync(TRUSTED_WRITER, 'utf8');

/**
 * Een getalconstante uit de gedeelde shell-lib, letterlijk uit het BESTAND gelezen.
 *
 * De paginagrens leeft in bash (daar worden de verzoeken gedaan) en in JavaScript (daar wordt het
 * budget uitgerekend). Zolang die twee alleen naast elkaar bestaan, kan er één veranderen zonder de
 * ander — en dan is het budgetgetal weer een schatting. Deze lezer bindt ze aan elkaar.
 */
function shellConstante(naam, tekst = BOUNDED_TEKST) {
  const treffer = tekst.match(new RegExp(`^${naam}=([0-9]+)$`, 'm'));
  assert.ok(treffer, `constante ontbreekt in ${BOUNDED_PAGES}: ${naam}`);
  return Number(treffer[1]);
}

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
    remainingQuota: RUIM_QUOTUM,
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
    remainingQuota: RUIM_QUOTUM,
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
    const met = selectTargets({ ...invoer, openPullRequests: open, remainingQuota: RUIM_QUOTUM });
    const zonder = selectTargets({ ...invoer, openPullRequests: [], remainingQuota: RUIM_QUOTUM });
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
  const invoer = {
    eventName: 'issue_comment', event: commentOpPr(74), openPullRequests: open,
    remainingQuota: RUIM_QUOTUM,
  };

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
    remainingQuota: RUIM_QUOTUM,
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
    eventName: 'schedule', event: {}, openPullRequests: [openPr(7), openPr(8)],
    nowEpochSeconds: 99 * uur, remainingQuota: RUIM_QUOTUM,
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
    hermetingPogingen + publicaties + enkelvoudig + (gepagineerd * LIST_PAGE_BUDGET),
    'het budget per PR volgt uit de stap zelf',
  );
  assert.equal(PER_PULL_REQUEST_REQUEST_BUDGET, 26);

  // En de paginagrens is een GRENS, niet een schatting. Zij komt uit de gedeelde shell-lib die de
  // verzoeken werkelijk doet; `--paginate` volgde de `Link`-header tot de laatste pagina en maakte
  // het getal hierboven onwaar. Loopt bash of JavaScript weg van de ander, dan is dit rood.
  assert.equal(shellConstante('GH_BOUNDED_EVIDENCE_PAGES'), LIST_PAGE_BUDGET);
  assert.equal(shellConstante('GH_BOUNDED_SELECTION_PAGES'), SELECTION_PAGE_BUDGET);
  assert.equal(shellConstante('GH_BOUNDED_PAGE_SIZE'), 100, 'GitHub levert nooit meer per pagina');
  assert.equal(SELECTION_REQUEST_BUDGET, SELECTION_PAGE_BUDGET);
  assert.equal(LIST_PAGE_BUDGET, 4);
  assert.equal(SELECTION_PAGE_BUDGET, 4);

  // MUTATIE: één van de twee getallen verzetten. De ene kant meet dan meer pagina's dan de andere
  // begroot, en precies dat mag niet stil kunnen gebeuren.
  assert.throws(
    () => assert.equal(shellConstante('GH_BOUNDED_EVIDENCE_PAGES',
      BOUNDED_TEKST.replace('GH_BOUNDED_EVIDENCE_PAGES=4', 'GH_BOUNDED_EVIDENCE_PAGES=5')), LIST_PAGE_BUDGET),
    'een vijfde pagina in bash zonder budgetverhoging moet rood zijn',
  );
  assert.throws(
    () => assert.equal(shellConstante('GH_BOUNDED_EVIDENCE_PAGES',
      BOUNDED_TEKST.replace('GH_BOUNDED_EVIDENCE_PAGES=4', 'GH_BOUNDED_EVIDENCE_PAGES=3')), LIST_PAGE_BUDGET),
    'een te laag budgetgetal moet evengoed rood zijn',
  );

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
  // Onbekend quotum meet NIETS meer. Zie S21b voor de volle behandeling van die grens.
  assert.equal(schedule(null).outcome, TARGET_OUTCOME.FAIL);
  assert.equal(schedule(null).reason, TARGET_REASON.API_QUOTA_UNKNOWN);
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
    '--open-pulls-complete', 'true', '--now-epoch', '1000', '--remaining-quota', '900',
    '--out', 't.json',
  ];
  assert.equal(parseTargetArgs(volledig).ok, true);

  // De volledigheidsvlag is VERPLICHT. Zou hij mogen ontbreken, dan zou een aanroeper die vergeet
  // hem door te geven stilzwijgend "volledig" krijgen — en dat is precies de aanname die een
  // afgekapte open-PR-lijst weer als volledige rotatie zou laten doorgaan.
  assert.equal(
    parseTargetArgs(volledig.filter((v, i) => v !== '--open-pulls-complete'
      && volledig[i - 1] !== '--open-pulls-complete')).ok,
    false,
    'zonder volledigheidsvlag',
  );

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

  // De volledigheidsvlag kent precies twee waarden. Alles daarbuiten is een argumentfout en geen
  // stilzwijgend "volledig": een tikfout hoort in de aanroeper zichtbaar te worden.
  assert.equal(parseCompleteness('true'), true);
  assert.equal(parseCompleteness('false'), false);
  for (const stuk of ['True', 'FALSE', '1', '0', 'ja', '', ' true', '-', null, true]) {
    assert.equal(parseCompleteness(stuk), null, String(stuk));
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
  const argv = (eventName, compleet = 'true') => [
    '--event-name', eventName, '--event', 'e.json', '--open-pulls', 'o.json',
    '--open-pulls-complete', compleet, '--now-epoch', '1696118400', '--remaining-quota', '900',
    '--out', join(dir, 'targets.json'),
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

  // Een AFGEKAPTE open-PR-lijst is rood en meet niets. Dezelfde lijst die zojuist een bucket
  // opleverde, mag dat niet meer zodra zij als onvolledig is gemeten: over een halve lijst
  // roteren zou alles voorbij de paginagrens voor altijd op een oude status laten staan.
  const afgekapt = [];
  const logAf = (regel) => afgekapt.push(regel);
  const echteLog = console.log;
  console.log = logAf;
  const rc = runSelect(argv('schedule', 'false'), { readFile, writeFile });
  console.log = echteLog;
  assert.equal(rc, 1);
  assert.deepEqual(uit(), []);
  assert.ok(afgekapt.includes(`LIVE_GATE_TARGETS_${TARGET_REASON.OPEN_PULL_REQUESTS_TRUNCATED}`),
    afgekapt.join(','));

  // En een onleesbare vlag is een argumentfout, met dezelfde lege matrix.
  assert.equal(runSelect(argv('schedule', 'misschien'), { readFile, writeFile }), 1);
  assert.deepEqual(uit(), []);
});

// --- De selectiestap van de workflow zelf --------------------------------------------------------

test('S10. de selectiestap haalt de open-PR-lijst alleen op bij een SCHEDULE', () => {
  // De echte shell uit het workflowbestand, met gestubde `gh` en `date`. Een eventaanleiding mag de
  // lijst niet aanraken: zou hij dat wel doen, dan kon één comment weer een repositorybrede ronde
  // veroorzaken. `node` blijft hier ECHT — de selector is de code die gemeten wordt.
  const script = stapScript(WRITER_TEKST, SELECTIE_STAP);

  // `gh` is per PAGINA gestubd, niet per eindpunt. Dat is geen detail: de begrensde paginering
  // vraagt `page=1`, `page=2`, … en stopt bij de eerste niet-volle pagina, dus een stub die elke
  // aanroep hetzelfde antwoord geeft zou de grens niet kunnen meten.
  const draai = (eventName, event, { paginas = null, faaltOpPagina = null } = {}) => {
    const { dir, bin, runnerTemp } = werkmap('live-gate-selectie-');
    const ghLog = join(dir, 'gh.txt');
    const pagesDir = join(dir, 'pages');
    mkdirSync(pagesDir);
    (paginas ?? []).forEach((items, i) => {
      writeFileSync(join(pagesDir, `${i + 1}.json`), JSON.stringify(items));
    });
    stub(bin, 'gh', [
      'echo "$*" >> "$GH_LOG"',
      'case "$*" in',
      '  *rate_limit*) echo 900 ;;',
      '  *state=open*)',
      // `${*##...}` snijdt PER positioneel argument en levert dus "api 1"; het laatste argument is
      // het volledige pad, en daar staat de paginaparameter in.
      '    for a in "$@"; do laatste="$a"; done',
      '    p="${laatste##*page=}"',
      faaltOpPagina === null ? '' : `    if [ "$p" = "${faaltOpPagina}" ]; then exit 1; fi`,
      '    if [ -f "$PAGES/$p.json" ]; then cat "$PAGES/$p.json"; else echo "[]"; fi ;;',
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
        PAGES: pagesDir,
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

  // De schedule haalt de lijst wél op, en meet er hoogstens 25. 126 open PR's is één VOLLE pagina
  // van honderd plus een halve tweede; de tweede is niet vol, dus is de lijst daar volledig en
  // wordt er geen derde pagina opgevraagd.
  const nummers = Array.from({ length: 126 }, (_, i) => openPr(i + 1));
  const schedule = draai('schedule', {}, { paginas: [nummers.slice(0, 100), nummers.slice(100)] });
  assert.equal(schedule.status, 0);
  assert.match(schedule.output, /measure=true/);
  const doelen = JSON.parse(schedule.output.match(/pull_requests=(\[.*\])/)[1]);
  assert.equal(doelen.length, SCHEDULE_BUCKET_LIMIT);
  const lijstAanroepen = schedule.ghAanroepen.filter((regel) => regel.includes('state=open'));
  assert.equal(lijstAanroepen.length, 2, 'precies twee pagina\'s, en geen derde');
  assert.ok(lijstAanroepen.every((regel) => regel.includes('per_page=100')));
  assert.deepEqual(lijstAanroepen.map((r) => r.match(/[&?]page=([0-9]+)/)[1]), ['1', '2']);

  // Een onbereikbare lijst is rood en meet niets: stil doorgaan zou nul statussen publiceren.
  const kapot = draai('schedule', {}, { paginas: [nummers.slice(0, 100)], faaltOpPagina: 1 });
  assert.equal(kapot.status, 1);
  assert.match(kapot.stdout, /OPEN_PULL_REQUEST_LIST_UNAVAILABLE/);

  // Ook een fout HALVERWEGE de paginering is rood. Een half opgehaalde lijst is geen lijst.
  const halfKapot = draai('schedule', {}, {
    paginas: [nummers.slice(0, 100), nummers.slice(100)], faaltOpPagina: 2,
  });
  assert.equal(halfKapot.status, 1);
  assert.match(halfKapot.stdout, /OPEN_PULL_REQUEST_LIST_UNAVAILABLE/);
});

test('S10b. een open-PR-lijst die niet binnen de paginagrens past, roteert NIET half', () => {
  // Vier volle pagina's: er kunnen meer open PR's bestaan dan deze lijst draagt. De rotatie
  // verdeelt de VOLLEDIGE lijst in blokken, dus zou alles voorbij de grens nooit aan de beurt
  // komen en voor altijd op een oude status blijven staan — terwijl de ronde er groen uitziet.
  const vol = (start) => Array.from({ length: 100 }, (_, i) => openPr(start + i));
  const { dir, bin, runnerTemp } = werkmap('live-gate-truncatie-');
  const ghLog = join(dir, 'gh.txt');
  const pagesDir = join(dir, 'pages');
  mkdirSync(pagesDir);
  for (let i = 1; i <= 6; i += 1) {
    writeFileSync(join(pagesDir, `${i}.json`), JSON.stringify(vol(((i - 1) * 100) + 1)));
  }
  stub(bin, 'gh', [
    'echo "$*" >> "$GH_LOG"',
    'case "$*" in',
    '  *rate_limit*) echo 900 ;;',
    '  *state=open*) for a in "$@"; do laatste="$a"; done; p="${laatste##*page=}"; cat "$PAGES/$p.json" ;;',
    '  *) echo "[]" ;;',
    'esac',
  ].join('\n'));
  stub(bin, 'date', 'echo 1696118400');
  const eventPad = join(dir, 'event.json');
  writeFileSync(eventPad, '{}');
  const outputPad = join(dir, 'output.txt');
  writeFileSync(outputPad, '');
  const uitkomst = draaiStap(stapScript(WRITER_TEKST, SELECTIE_STAP), {
    dir,
    bin,
    env: {
      GH_LOG: ghLog,
      PAGES: pagesDir,
      GH_TOKEN: 'x',
      REPOSITORY: 'owner/repo',
      EVENT_NAME: 'schedule',
      RUNNER_TEMP: runnerTemp,
      GITHUB_EVENT_PATH: eventPad,
      GITHUB_OUTPUT: outputPad,
    },
  });
  const output = readFileSync(outputPad, 'utf8');
  const aanroepen = readFileSync(ghLog, 'utf8').trim().split('\n')
    .filter((regel) => regel.includes('state=open'));

  // Precies de toegestane pagina's, en geen enkele daarbuiten.
  assert.equal(aanroepen.length, SELECTION_PAGE_BUDGET, aanroepen.join(' | '));
  assert.deepEqual(
    aanroepen.map((r) => Number(r.match(/[&?]page=([0-9]+)/)[1])),
    Array.from({ length: SELECTION_PAGE_BUDGET }, (_, i) => i + 1),
  );
  assert.ok(!aanroepen.some((r) => r.includes(`&page=${SELECTION_PAGE_BUDGET + 1}`)),
    'nooit een pagina voorbij de grens');

  // En de uitkomst is rood en leeg, niet een halve rotatie.
  assert.equal(uitkomst.status, 1);
  assert.match(uitkomst.stdout, new RegExp(`LIVE_GATE_TARGETS_${TARGET_REASON.OPEN_PULL_REQUESTS_TRUNCATED}`));
  assert.match(output, /pull_requests=\[\]/);
  assert.match(output, /measure=false/);
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

  // Deze rij staat op JOBNIVEAU en per PR. Daarnaast draagt het bestand sinds V13 een
  // REPOSITORYBREDE rij op workflowniveau: die serialiseert het gedeelde QUOTUM over runs heen, wat
  // een per-PR-rij per definitie niet kan. De twee vullen elkaar aan; zie S13.
  assert.equal(isRepositoryWideQueuedLock(analyse.workflowConcurrency), true);
  assert.equal(analyse.workflowConcurrency.group, TRUSTED_WRITER_REPOSITORY_LOCK_GROUP);
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
  // De repositorybrede rij hoort er te ZIJN en in precies één vorm. Zonder haar meten twee runs voor
  // verschillende PR's gelijktijdig hetzelfde resterende quotum; met een dynamische groep evengoed.
  if (!isRepositoryWideQueuedLock(analyse.workflowConcurrency)) {
    bevindingen.push('GEEN_REPOSITORYBREDE_LOCK');
  }

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

  // MUTATIE 1: de repositorybrede rij dynamisch maken. Dan valt elke run in zijn eigen groep en
  // meet er niets meer na elkaar — precies de vorm waarin twee runs hetzelfde restant reserveren.
  const dynamischeLock = WRITER_TEKST.replace(
    `group: ${TRUSTED_WRITER_REPOSITORY_LOCK_GROUP}\n`,
    `group: ${TRUSTED_WRITER_REPOSITORY_LOCK_GROUP}-\${{ github.run_id }}\n`,
  );
  assert.ok(lockBevindingen(dynamischeLock).includes('GEEN_REPOSITORYBREDE_LOCK'));

  // MUTATIE 1b: de repositorybrede rij helemaal weghalen — de V12-vorm.
  const zonderLock = WRITER_TEKST.replace(
    `concurrency:\n  group: ${TRUSTED_WRITER_REPOSITORY_LOCK_GROUP}\n  cancel-in-progress: false\n  queue: max\n`,
    '',
  );
  assert.ok(lockBevindingen(zonderLock).includes('GEEN_REPOSITORYBREDE_LOCK'));

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
function draaiSchrijfstap({
  pr, prJson, ghFaalt = [], publishFaalt = [], beslissing = 'GO', lijstPaginas = {},
}) {
  const { dir, bin } = werkmap('live-gate-schrijf-');
  const runnerTemp = join(dir, 'runner');
  const log = join(dir, 'log.txt');

  // De bewijslijsten worden PER PAGINA gestubd. Een stub die elke aanroep hetzelfde antwoord geeft
  // kan het verschil tussen "de lijst is op" en "er is mogelijk meer" niet dragen, en juist dat
  // verschil is hier de hele eigenschap.
  const pagesDir = join(dir, 'pages');
  mkdirSync(pagesDir);
  const sleutelVan = (padDeel) => `repos/owner/repo/${padDeel}`.replace(/\//g, '-');
  for (const [padDeel, paginas] of Object.entries(lijstPaginas)) {
    paginas.forEach((items, i) => {
      if (items === 'FOUT') return;
      writeFileSync(join(pagesDir, `${sleutelVan(padDeel)}-${i + 1}.json`), JSON.stringify(items));
    });
  }
  const foutPaginas = Object.entries(lijstPaginas).flatMap(([padDeel, paginas]) => paginas
    .map((items, i) => (items === 'FOUT' ? `${sleutelVan(padDeel)}-${i + 1}` : null))
    .filter(Boolean));

  stub(bin, 'gh', [
    'for arg in "$@"; do path="$arg"; done',
    'echo "GET $path" >> "$LOG"',
    'case "$path" in',
    ...ghFaalt.map((patroon) => `  *${patroon}*) exit 1 ;;`),
    `  */pulls/${pr}) cat "$PR_JSON" ;;`,
    '  *)',
    '    p="${path##*page=}"',
    '    zonderQuery="${path%%\\?*}"',
    '    sleutel="${zonderQuery//\\//-}-$p"',
    ...foutPaginas.map((sleutel) => `    if [ "$sleutel" = "${sleutel}" ]; then exit 1; fi`),
    '    if [ -f "$PAGES/$sleutel.json" ]; then cat "$PAGES/$sleutel.json"; else echo "[]"; fi ;;',
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
      PAGES: pagesDir,
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


// --- De gedeelde begrensde paginering ------------------------------------------------------------

/**
 * Draait `gh_bounded_pages` uit de gedeelde shell-lib in echte bash, met een paginabewuste `gh`.
 *
 * Dit is de functie waar de hele bovengrens op rust: zolang de vijf bewijslijsten met `--paginate`
 * werden opgehaald, was `PER_PULL_REQUEST_REQUEST_BUDGET` een schatting. Hier wordt geteld wat er
 * werkelijk aan verzoeken uitgaat.
 */
function draaiBoundedFetch({
  paginas, maxPages = LIST_PAGE_BUDGET, pad = 'repos/owner/repo/pulls/74/commits', strikt = false,
}) {
  const { dir, bin } = werkmap('gh-bounded-');
  const pagesDir = join(dir, 'pages');
  mkdirSync(pagesDir);
  const fouten = [];
  paginas.forEach((items, i) => {
    if (items === 'FOUT') { fouten.push(i + 1); return; }
    writeFileSync(join(pagesDir, `${i + 1}.json`), JSON.stringify(items));
  });

  stub(bin, 'gh', [
    'for arg in "$@"; do laatste="$arg"; done',
    'echo "$laatste" >> "$LOG"',
    'p="${laatste##*page=}"',
    ...fouten.map((nr) => `if [ "$p" = "${nr}" ]; then exit 1; fi`),
    'if [ -f "$PAGES/$p.json" ]; then cat "$PAGES/$p.json"; else echo "geen-lijst" ; fi',
  ].join('\n'));

  const log = join(dir, 'gh.txt');
  const out = join(dir, 'out.json');
  const script = [
    // `strikt` draait de functie onder `set -e`. Dat is geen theorie: een `[ ... ] && break` in de
    // paginalus levert een non-zero status zodra hij NIET breekt, en zou onder een aanroeper met
    // `set -e` de hele stap na de eerste volle pagina laten stoppen — met een halve oogst.
    strikt ? 'set -euo pipefail' : 'set -uo pipefail',
    '. scripts/autocoding/gh-bounded-pages.sh',
    'rc=0',
    `gh_bounded_pages "${pad}" "$OUT" "${maxPages}" "$SCRATCH" || rc=$?`,
    'echo "RC=$rc"',
  ].join('\n');

  const uitkomst = draaiStap(script, {
    dir, bin, env: { LOG: log, PAGES: pagesDir, OUT: out, SCRATCH: join(dir, 'scratch') },
  });
  return {
    rc: Number(uitkomst.stdout.match(/RC=([0-9]+)/)[1]),
    aanroepen: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [],
    inhoud: existsSync(out) ? readFileSync(out, 'utf8') : null,
  };
}

const volleP = (start) => Array.from({ length: 100 }, (_, i) => ({ number: start + i }));

test('S18. de gedeelde paginering stopt bij de eerste NIET-volle pagina', () => {
  // Eén halve pagina: de lijst is op, dus er wordt geen tweede opgevraagd.
  const kort = draaiBoundedFetch({ paginas: [[{ number: 1 }, { number: 2 }]] });
  assert.equal(kort.rc, 0);
  assert.equal(kort.aanroepen.length, 1);
  assert.match(kort.aanroepen[0], /per_page=100&page=1$/);
  // De uitvoer is de `--slurp`-vorm: een array VAN PAGINA's. `flattenPages` leest die ongewijzigd.
  assert.deepEqual(JSON.parse(kort.inhoud), [[{ number: 1 }, { number: 2 }]]);

  // Een volle pagina gevolgd door een halve: precies twee verzoeken, en beide pagina's in de oogst.
  const twee = draaiBoundedFetch({ paginas: [volleP(1), [{ number: 101 }]] });
  assert.equal(twee.rc, 0);
  assert.equal(twee.aanroepen.length, 2);
  const geoogst = JSON.parse(twee.inhoud);
  assert.equal(geoogst.length, 2);
  assert.equal(geoogst.flat().length, 101);

  // Een LEGE eerste pagina is ook een einde, geen fout.
  const leeg = draaiBoundedFetch({ paginas: [[]] });
  assert.equal(leeg.rc, 0);
  assert.equal(leeg.aanroepen.length, 1);
  assert.deepEqual(JSON.parse(leeg.inhoud), [[]]);

  // Drie volle pagina's en een vierde die niet vol is: vier verzoeken, volledige oogst, rc 0.
  const vier = draaiBoundedFetch({ paginas: [volleP(1), volleP(101), volleP(201), [{ number: 301 }]] });
  assert.equal(vier.rc, 0);
  assert.equal(vier.aanroepen.length, LIST_PAGE_BUDGET);
  assert.equal(JSON.parse(vier.inhoud).flat().length, 301);

  // En dat geldt óók onder `set -e`. De aanroepende stappen draaien nu met `set -uo pipefail`, maar
  // een functie die alleen buiten `set -e` correct doorloopt is een valstrik voor de volgende
  // aanroeper: die zou na de eerste volle pagina stilvallen met een halve oogst.
  const streng = draaiBoundedFetch({
    paginas: [volleP(1), volleP(101), [{ number: 201 }]], strikt: true,
  });
  assert.equal(streng.rc, 0);
  assert.equal(streng.aanroepen.length, 3);
  assert.equal(JSON.parse(streng.inhoud).flat().length, 201);
});

test('S18b. een VOLLE laatste toegestane pagina is truncatie, en er komt nooit een vijfde', () => {
  // Vier volle pagina's: er kan een vijfde bestaan. Die wordt NIET opgevraagd — het budget is een
  // grens en geen richtlijn — en de aanroeper krijgt rc 2 in plaats van een halve oogst als
  // volledig bewijs.
  const paginas = [volleP(1), volleP(101), volleP(201), volleP(301), volleP(401)];
  const truncatie = draaiBoundedFetch({ paginas, strikt: true });
  assert.equal(truncatie.rc, 2);
  assert.equal(truncatie.aanroepen.length, LIST_PAGE_BUDGET, truncatie.aanroepen.join(' | '));
  assert.ok(!truncatie.aanroepen.some((r) => r.endsWith(`page=${LIST_PAGE_BUDGET + 1}`)),
    'nooit een pagina voorbij de grens');
  assert.equal(JSON.parse(truncatie.inhoud).flat().length, 400, 'wat er is opgehaald blijft leesbaar');

  // De grens is het MEEGEGEVEN getal en niet iets vasts: met één toegestane pagina is één volle
  // pagina al truncatie. Zo kan een aanroeper zijn eigen budget niet stil overschrijden.
  const eenPagina = draaiBoundedFetch({ paginas, maxPages: 1 });
  assert.equal(eenPagina.rc, 2);
  assert.equal(eenPagina.aanroepen.length, 1);

  // Een onbruikbare grens haalt niets op in plaats van ongelimiteerd door te lopen.
  for (const grens of ['0', '-1', 'veel', '']) {
    const kapot = draaiBoundedFetch({ paginas, maxPages: grens });
    assert.equal(kapot.rc, 1, grens);
    assert.deepEqual(kapot.aanroepen, [], grens);
  }
});

test('S18c. een fout HALVERWEGE de paginering levert geen halve oogst op', () => {
  // Pagina 1 goed, pagina 2 stuk: de oogst is niet compleet en mag dus niet als lijst gelden.
  const halverwege = draaiBoundedFetch({ paginas: [volleP(1), 'FOUT'] });
  assert.equal(halverwege.rc, 1);
  assert.equal(halverwege.aanroepen.length, 2, 'er wordt gestopt, niet doorgelopen');
  assert.equal(halverwege.inhoud, null, 'geen uitvoerbestand om per ongeluk te lezen');

  // Een antwoord dat geen JSON-lijst is, is evenmin een lege lijst.
  const geenLijst = draaiBoundedFetch({ paginas: [], pad: 'repos/owner/repo/pulls/74/files' });
  assert.equal(geenLijst.rc, 1);
  assert.equal(geenLijst.inhoud, null);
});

/**
 * Draait `gh_bounded_pages` met een gekozen WERKMAP-parameter, tegen stubs voor `gh`, `rm` én
 * `mkdir` die alleen loggen en falen. Zo is meetbaar wát de functie zou muteren of opvragen — niet
 * alleen welke exitcode zij oplevert. `bronMutatie` draait één regel uit de gedeelde lib terug en
 * laadt de MUTANT, zodat de weigering zelf een negatieve controle heeft.
 */
function draaiMetWerkmap(scratch, bronMutatie = null) {
  const { dir, bin } = werkmap('gh-bounded-scratch-');
  const log = join(dir, 'aanroepen.txt');
  const out = join(dir, 'out.json');
  for (const naam of ['gh', 'rm', 'mkdir']) {
    // Falen na het loggen: de functie stopt dan bij de eerste mutatie, dus is de log het volledige
    // beeld van wat zij aanraakte en schrijft geen enkele stub iets naar de echte schijf.
    // `argc` staat erbij omdat een LEGE parameter in `$*` onzichtbaar is: `rm -rf ""` en een `rm`
    // zonder werkmap leveren dezelfde tekst op, en juist dat verschil wordt hier gemeten.
    stub(bin, naam, [`echo "${naam} argc=$# $*" >> "$LOG"`, 'exit 1'].join('\n'));
  }

  let lib = 'scripts/autocoding/gh-bounded-pages.sh';
  if (bronMutatie) {
    const bron = readFileSync(lib, 'utf8');
    assert.equal(bron.split(bronMutatie).length - 1, 1, 'het mutatieanker moet precies één keer voorkomen');
    lib = join(dir, 'gh-bounded-pages.mutant.sh');
    writeFileSync(lib, bron.replace(bronMutatie, ''));
  }

  const uitkomst = draaiStap([
    'set -uo pipefail',
    `. ${JSON.stringify(lib)}`,
    'rc=0',
    // De werkmap komt hier als LETTERLIJKE parameter binnen, niet via een variabele: dit is exact de
    // vorm waarin een aanroeper met een niet-gezette of leeg geraakte variabele hem doorgeeft.
    `gh_bounded_pages "repos/owner/repo/pulls/74/commits" "$OUT" 4 ${JSON.stringify(scratch)} || rc=$?`,
    'echo "RC=$rc"',
  ].join('\n'), { dir, bin, env: { LOG: log, OUT: out } });

  return {
    rc: Number(uitkomst.stdout.match(/RC=([0-9]+)/)[1]),
    aanroepen: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [],
    uitvoerBestaat: existsSync(out),
  };
}

test('S18d. een LEGE werkmap wordt geweigerd vóór `rm`, vóór `mkdir` en vóór het eerste verzoek', () => {
  // Gemini-bevinding 3835091134: de werkmap wordt hier ONVOORWAARDELIJK gewist. Is de vierde
  // parameter leeg — een niet-gezette variabele bij een aanroeper zonder `set -u`, of een tikfout in
  // de env-naam — dan is `rm -rf ""` het eerste wat er gebeurt. De weigering moet dus vóór die
  // regel staan, niet erna.
  const leeg = draaiMetWerkmap('');
  assert.equal(leeg.rc, 1, 'een lege werkmap is een onbruikbare parameter, geen bruikbare oogst');
  assert.deepEqual(leeg.aanroepen, [], 'geen rm, geen mkdir, en geen enkel verzoek van het quotum');
  assert.equal(leeg.uitvoerBestaat, false, 'geen uitvoerbestand om per ongeluk als lijst te lezen');

  // MUTATIE (negatieve controle): de weigering weghalen. Dan is `rm -rf ""` aantoonbaar het eerste
  // wat de functie doet — dezelfde exitcode, maar een heel andere voetafdruk. Zonder deze controle
  // zou de test ook groen zijn op een functie die om een andere reden vroeg faalt.
  const zonderWeigering = draaiMetWerkmap('', '  [ -n "$scratch" ] || return 1\n');
  assert.equal(zonderWeigering.rc, 1);
  assert.deepEqual(zonderWeigering.aanroepen, ['rm argc=2 -rf'],
    'ongewapend gaat de lege string als werkelijk argument naar `rm -rf`');

  // De weigering raakt alleen de LEGE vorm: een gewone werkmap loopt ongewijzigd door tot de eerste
  // mutatie, dus is er geen pad stilgezet dat wel hoorde te werken.
  const gevuld = draaiMetWerkmap('/tmp/wel-een-werkmap');
  assert.deepEqual(gevuld.aanroepen, ['rm argc=2 -rf /tmp/wel-een-werkmap']);
});

// --- De bewijsoogst van de schrijfstap ------------------------------------------------------------

/** Elke plek waar de trusted writer nog onbegrensd zou kunnen pagineren. */
function pagineringsBevindingen(text) {
  const bevindingen = [];
  for (const [naam, stapNaam] of [['SELECTIE', SELECTIE_STAP], ['SCHRIJF', SCHRIJF_STAP]]) {
    const stap = stapScript(text, stapNaam);
    // Alleen UITVOERBARE regels tellen. De stap legt in commentaar uit waarom `--paginate` weg is,
    // en die uitleg mag de meting niet zelf rood maken.
    const code = stap.split('\n').filter((regel) => !/^\s*#/.test(regel)).join('\n');
    if (/--paginate/.test(code)) bevindingen.push(`ONBEGRENSDE_PAGINERING_${naam}`);
    if (!stap.includes('. scripts/autocoding/gh-bounded-pages.sh')) {
      bevindingen.push(`GEDEELDE_GRENS_NIET_GELADEN_${naam}`);
    }
  }
  // De gedeelde lib hoort bij de bestanden die op de default branch moeten staan; zonder die check
  // zou de stap op een oudere default branch stilvallen op een ontbrekend bestand.
  const bootstraps = text.split('[ -f scripts/autocoding/gh-bounded-pages.sh ]').length - 1;
  if (bootstraps !== 2) bevindingen.push(`BOOTSTRAPCHECK_ONVOLLEDIG_${bootstraps}`);
  return bevindingen;
}

test('S19. de writer pagineert nergens meer onbegrensd, en dat is mechanisch afgedwongen', () => {
  assert.deepEqual(pagineringsBevindingen(WRITER_TEKST), []);

  // MUTATIE: `--paginate` terugzetten op de bewijslijsten. Dat is exact de V11-vorm waarin het
  // budget een schatting was, en die moet aantoonbaar rood worden.
  const terugNaarPaginate = WRITER_TEKST.replace(
    'gh_bounded_pages "repos/$REPOSITORY/$path"',
    'gh api --paginate --slurp "repos/$REPOSITORY/$path"',
  );
  assert.notEqual(terugNaarPaginate, WRITER_TEKST, 'het mutatieanker moet bestaan');
  assert.ok(pagineringsBevindingen(terugNaarPaginate).includes('ONBEGRENSDE_PAGINERING_SCHRIJF'));

  // MUTATIE: `--paginate` terugzetten op de open-PR-lijst van de selectiejob.
  const selectiePaginate = WRITER_TEKST.replace(
    'gh_bounded_pages "repos/$REPOSITORY/pulls?state=open"',
    'gh api --paginate --slurp "repos/$REPOSITORY/pulls?state=open"',
  );
  assert.ok(pagineringsBevindingen(selectiePaginate).includes('ONBEGRENSDE_PAGINERING_SELECTIE'));
});

test('S20. een AFGEKAPTE bewijsoogst wordt failure op de gemeten head, nooit success', () => {
  const head = sha(7);
  const afgekapt = draaiSchrijfstap({
    pr: 74,
    prJson: { state: 'open', merged: false, head: { sha: head } },
    lijstPaginas: {
      'pulls/74/files': [volleP(1), volleP(101), volleP(201), volleP(301), volleP(401)],
    },
  });

  // Precies de toegestane pagina's voor die lijst, en geen enkele daarbuiten.
  const bestandsGets = afgekapt.regels.filter((r) => r.includes('/pulls/74/files'));
  assert.equal(bestandsGets.length, LIST_PAGE_BUDGET, bestandsGets.join(' | '));
  assert.ok(!bestandsGets.some((r) => r.endsWith(`page=${LIST_PAGE_BUDGET + 1}`)));

  // De uitspraak wordt niet eens berekend: een onvolledige oogst lijkt precies op een schone PR —
  // geen tegenstem gevonden — en dat is exact de vergissing die hier niet gemaakt mag worden.
  assert.deepEqual(afgekapt.regels.filter((r) => r === 'VERIFY'), []);

  const finaal = afgekapt.regels.filter((r) => r.startsWith('FINAL '));
  assert.equal(finaal.length, 1, 'precies één eindstatus');
  assert.match(finaal[0], /--execution-error GATE_EXECUTION_ERROR/);
  assert.match(finaal[0], new RegExp(`--head-sha ${head}`), 'op de al gemeten head');
  assert.match(afgekapt.stdout, /PR_74_EVIDENCE_TRUNCATED_files/, 'de categorie haalt het joblog');

  // En die uitvoeringsfout KAN geen `success` opleveren. Dat is geen aanname over de publisher maar
  // dezelfde pure functie die de publisher gebruikt, met exact de vlag die de stap doorgeeft.
  const publicatie = resolvePublication({
    headSha: head,
    statusContext: 'autocoding-shield-live-receipts',
    gateResult: { decision: 'GO', reasons: [] },
    executionError: 'GATE_EXECUTION_ERROR',
  });
  assert.equal(publicatie.state, 'failure');

  // Het totaal blijft binnen de bovengrens per PR, ook nu de zwaarste lijst vier pagina's kostte.
  assert.ok(afgekapt.regels.filter((r) => r.startsWith('GET ')).length
    + afgekapt.regels.filter((r) => /^(PENDING|FINAL) /.test(r)).length
    <= PER_PULL_REQUEST_REQUEST_BUDGET,
  afgekapt.regels.join(' | '));
});

test('S20b. een API-fout halverwege een bewijslijst is dezelfde fail-closed uitkomst', () => {
  const head = sha(5);
  const stuk = draaiSchrijfstap({
    pr: 74,
    prJson: { state: 'open', merged: false, head: { sha: head } },
    lijstPaginas: { 'issues/74/comments': [volleP(1), 'FOUT'] },
  });

  const commentGets = stuk.regels.filter((r) => r.includes('/issues/74/comments'));
  assert.equal(commentGets.length, 2, 'er wordt gestopt, niet doorgelopen');
  assert.deepEqual(stuk.regels.filter((r) => r === 'VERIFY'), []);
  const finaal = stuk.regels.filter((r) => r.startsWith('FINAL '));
  assert.equal(finaal.length, 1);
  assert.match(finaal[0], /--execution-error GATE_EXECUTION_ERROR/);
  assert.match(finaal[0], new RegExp(`--head-sha ${head}`));

  // En de volledig gelezen buurlijsten veranderen daar niets aan: één onvolledige lijst is genoeg.
  assert.ok(stuk.regels.some((r) => r.includes('/pulls/74/reviews')), 'de ronde loopt wel af');
});

test('S21. het quotum vlak boven en vlak onder de grens beslist voorspelbaar', () => {
  const open = Array.from({ length: 126 }, (_, i) => openPr(i + 1));
  const schedule = (remainingQuota) => selectTargets({
    eventName: 'schedule', event: {}, openPullRequests: open, nowEpochSeconds: 0, remainingQuota,
  });

  // De exacte grens waarop precies ÉÉN pull request nog past.
  const eenPr = QUOTA_RESERVE + SELECTION_REQUEST_BUDGET + PER_PULL_REQUEST_REQUEST_BUDGET;
  assert.equal(affordablePullRequests(eenPr), 1);
  assert.equal(schedule(eenPr).targets.length, 1);
  assert.equal(schedule(eenPr).outcome, TARGET_OUTCOME.MEASURE);

  // Eén verzoek minder en er past er geen enkele meer. Dan wordt er NIETS gepubliceerd; halverwege
  // leegraken zou heads op `pending` laten staan.
  assert.equal(affordablePullRequests(eenPr - 1), 0);
  assert.equal(schedule(eenPr - 1).outcome, TARGET_OUTCOME.NO_OP);
  assert.equal(schedule(eenPr - 1).reason, TARGET_REASON.API_BUDGET_RESERVED);

  // En de grens waarop de volle bucket past.
  const volleBucket = QUOTA_RESERVE + SCHEDULE_REQUEST_BUDGET;
  assert.equal(schedule(volleBucket).targets.length, SCHEDULE_BUCKET_LIMIT);
  assert.equal(schedule(volleBucket - PER_PULL_REQUEST_REQUEST_BUDGET).targets.length,
    SCHEDULE_BUCKET_LIMIT - 1);

  // ONBEKEND quotum opent al helemaal niets: het is een eigen rode uitkomst zonder doelen.
  const onbekend = schedule(null);
  assert.equal(onbekend.outcome, TARGET_OUTCOME.FAIL);
  assert.equal(onbekend.reason, TARGET_REASON.API_QUOTA_UNKNOWN);
  assert.deepEqual(onbekend.targets, []);
});


// --- De repositorybrede quotumrij (V13) ----------------------------------------------------------

/**
 * Eén uur aan aanleidingen tegen het GEDEELDE quotum, doorgerekend met de ECHTE selector en de echte
 * budgetten. Geen nabouw van `selectTargets()`: alleen de volgorde waarin de runs meten wordt
 * gemodelleerd, want dát is precies wat de concurrencyrij bepaalt.
 *
 *   `geserialiseerd: true`  — de repositorybrede rij van V13. Run N+1 start pas als run N klaar is,
 *                             dus meet zij het restant NA wat run N werkelijk heeft uitgegeven.
 *   `geserialiseerd: false` — de V12-vorm. De per-PR-jobrij scheidt runs voor verschillende PR's
 *                             niet, dus lezen ze allemaal hetzelfde `rate_limit.remaining` en
 *                             reserveren ze allemaal datzelfde restant.
 *
 * Een run die MEET geeft zijn eigen begroting uit: de selectiekost plus het perp-PR-budget maal het
 * aantal doelen. Een no-op geeft niets uit — een eventaanleiding raakt de open-PR-lijst niet aan.
 */
function simuleerUur({ aanleidingen, geserialiseerd, quotum = SHARED_HOURLY_REQUEST_QUOTA }) {
  let besteed = 0;
  const metingen = [];
  const uitkomsten = [];
  for (const aanleiding of aanleidingen) {
    const gemeten = geserialiseerd ? quotum - besteed : quotum;
    metingen.push(gemeten);
    const uitkomst = selectTargets({ ...aanleiding, remainingQuota: gemeten });
    uitkomsten.push(uitkomst);
    if (uitkomst.outcome === TARGET_OUTCOME.MEASURE) {
      besteed += SELECTION_REQUEST_BUDGET
        + (uitkomst.targets.length * PER_PULL_REQUEST_REQUEST_BUDGET);
    }
  }
  return { besteed, resterend: quotum - besteed, metingen, uitkomsten };
}

const eventAanleiding = (nummer) => ({
  eventName: 'issue_comment', event: commentOpPr(nummer), openPullRequests: [],
});
const scheduleAanleiding = (open) => ({
  eventName: 'schedule', event: {}, openPullRequests: open, nowEpochSeconds: 0,
});

test('S22. NEGATIEVE CONTROLE: zonder repositorybrede rij trekken 40 geburste events het gedeelde quotum leeg', () => {
  // De exacte rekensom uit de bevinding, gebonden aan de echte constanten in plaats van aan een
  // getal in proza: één event kost hoogstens 30 verzoeken, veertig events dus 1200 — meer dan het
  // gedeelde uurquotum van duizend.
  assert.equal(EVENT_REQUEST_BUDGET, 30);
  assert.equal(SCHEDULE_REQUEST_BUDGET, 654);
  assert.equal(SHARED_HOURLY_REQUEST_QUOTA, 1000);

  const burst = Array.from({ length: 40 }, (_, i) => eventAanleiding(100 + i));
  const zonderRij = simuleerUur({ aanleidingen: burst, geserialiseerd: false });

  // ALLE VEERTIG beslissen tegen DEZELFDE teller. Dat is de race, letterlijk gemeten.
  assert.equal(new Set(zonderRij.metingen).size, 1);
  assert.deepEqual([...new Set(zonderRij.metingen)], [SHARED_HOURLY_REQUEST_QUOTA]);
  assert.equal(zonderRij.uitkomsten.filter((u) => u.outcome === TARGET_OUTCOME.MEASURE).length, 40);

  // En samen gaan ze over het quotum heen terwijl elke run afzonderlijk binnen zijn begroting bleef.
  assert.equal(zonderRij.besteed, 40 * EVENT_REQUEST_BUDGET);
  assert.ok(zonderRij.besteed > SHARED_HOURLY_REQUEST_QUOTA, 'quotum overschreden');
  assert.ok(zonderRij.resterend < QUOTA_RESERVE, 'de reserve is opgegeten');
});

test('S22a. MET de repositorybrede rij kan geen enkele run tegen een al gereserveerd restant beslissen', () => {
  const burst = Array.from({ length: 40 }, (_, i) => eventAanleiding(100 + i));
  const metRij = simuleerUur({ aanleidingen: burst, geserialiseerd: true });

  // Geen twee metende runs zien hetzelfde restant: elke volgende meet ná de uitgave van de vorige.
  const metend = metRij.uitkomsten
    .map((u, i) => [u, metRij.metingen[i]])
    .filter(([u]) => u.outcome === TARGET_OUTCOME.MEASURE)
    .map(([, gemeten]) => gemeten);
  assert.equal(new Set(metend).size, metend.length, 'elke metende run ziet een eigen restant');
  for (let i = 1; i < metend.length; i += 1) {
    assert.ok(metend[i] < metend[i - 1], 'de gemeten teller loopt strikt af');
    assert.equal(metend[i - 1] - metend[i], EVENT_REQUEST_BUDGET);
  }

  // Het quotum wordt nooit overschreden en de reserve blijft staan. Dat is de hele eigenschap.
  assert.ok(metRij.besteed <= SHARED_HOURLY_REQUEST_QUOTA - QUOTA_RESERVE);
  assert.equal(metRij.resterend, QUOTA_RESERVE);
  assert.equal(metend.length, 30);

  // De overgebleven tien aanleidingen verdwijnen niet stil: ze meten niets en zeggen waarom. Dat is
  // ook precies waarom de rij `queue: max` draagt — met `single` waren ze geannuleerd in plaats van
  // afgewezen, en dan had niemand geweten dat er iets niet gemeten was.
  const afgewezen = metRij.uitkomsten.filter((u) => u.outcome === TARGET_OUTCOME.NO_OP);
  assert.equal(afgewezen.length, 10);
  assert.ok(afgewezen.every((u) => u.reason === TARGET_REASON.API_BUDGET_RESERVED));
});

test('S22b. schedule én event delen dezelfde rij, dus tellen hun begrotingen na elkaar', () => {
  // De gemengde vorm uit de bevinding: een schedule van hoogstens 654 verzoeken NAAST eventruns.
  // Twaalf events erbij is 1014 — over het quotum, terwijl beide soorten afzonderlijk keurig binnen
  // hun eigen begroting blijven.
  const open = Array.from({ length: 126 }, (_, i) => openPr(i + 1));
  const gemengd = [
    scheduleAanleiding(open),
    ...Array.from({ length: 12 }, (_, i) => eventAanleiding(200 + i)),
  ];

  const zonderRij = simuleerUur({ aanleidingen: gemengd, geserialiseerd: false });
  assert.equal(new Set(zonderRij.metingen).size, 1, 'schedule en events meten hetzelfde restant');
  assert.equal(zonderRij.besteed, SCHEDULE_REQUEST_BUDGET + (12 * EVENT_REQUEST_BUDGET));
  assert.ok(zonderRij.besteed > SHARED_HOURLY_REQUEST_QUOTA);

  // Met de rij meet elk event pas ná de schedule, en stopt de reeks vanzelf bij de reserve.
  const metRij = simuleerUur({ aanleidingen: gemengd, geserialiseerd: true });
  assert.equal(metRij.metingen[0], SHARED_HOURLY_REQUEST_QUOTA);
  assert.equal(metRij.metingen[1], SHARED_HOURLY_REQUEST_QUOTA - SCHEDULE_REQUEST_BUDGET);
  assert.equal(metRij.uitkomsten[0].targets.length, SCHEDULE_BUCKET_LIMIT);
  assert.ok(metRij.besteed <= SHARED_HOURLY_REQUEST_QUOTA - QUOTA_RESERVE);
  assert.ok(metRij.resterend >= QUOTA_RESERVE);

  // En de schedule krimpt zelf mee zodra events hem voor zijn geweest: dezelfde ronde in omgekeerde
  // volgorde meet minder PR's per beurt in plaats van over het quotum heen te gaan.
  const andersom = simuleerUur({
    aanleidingen: [...gemengd.slice(1), gemengd[0]], geserialiseerd: true,
  });
  const scheduleUitkomst = andersom.uitkomsten[andersom.uitkomsten.length - 1];
  assert.ok(scheduleUitkomst.targets.length < SCHEDULE_BUCKET_LIMIT);
  assert.ok(andersom.besteed <= SHARED_HOURLY_REQUEST_QUOTA - QUOTA_RESERVE);
  assert.ok(andersom.resterend >= QUOTA_RESERVE);
});


// --- V15: de indeling ligt vast, alleen het venster erbinnen krimpt -------------------------------

/** Het restquotum waarbij precies `capaciteit` pull requests betaalbaar zijn. */
const quotumVoor = (capaciteit) => QUOTA_RESERVE + SELECTION_REQUEST_BUDGET
  + (capaciteit * PER_PULL_REQUEST_REQUEST_BUDGET);

const OPEN_126 = Array.from({ length: 126 }, (_, i) => openPr(i + 1));

const scheduleRonde = (slot, remainingQuota, open = OPEN_126) => selectTargets({
  eventName: 'schedule',
  event: {},
  openPullRequests: open,
  nowEpochSeconds: slot * SCHEDULE_SLOT_SECONDS,
  remainingQuota,
});

/** Alles wat een reeks slots werkelijk meet, gegeven een capaciteit per slot. */
function dekking(capaciteitVoorSlot, slots, selector = selectTargets) {
  const gezien = new Set();
  for (let slot = 0; slot < slots; slot += 1) {
    const uitkomst = selector({
      eventName: 'schedule',
      event: {},
      openPullRequests: OPEN_126,
      nowEpochSeconds: slot * SCHEDULE_SLOT_SECONDS,
      remainingQuota: quotumVoor(capaciteitVoorSlot(slot)),
    });
    if (uitkomst.outcome === TARGET_OUTCOME.MEASURE) for (const n of uitkomst.targets) gezien.add(n);
  }
  return gezien;
}

test('S23. het quotum verandert de bucketINDELING niet, alleen het venster daarbinnen', () => {
  // Bevinding `3835186656`. De betaalbare limiet ging vóór de partitionering in, dus bepaalde het
  // quotum hoeveel buckets er waren en wie erin zat. Nu is de indeling een functie van de LIJST en
  // het SLOT, en van niets anders.
  for (let slot = 0; slot < 24; slot += 1) {
    const vol = scheduleRonde(slot, quotumVoor(SCHEDULE_BUCKET_LIMIT));
    assert.equal(vol.bucketCount, 6, `slot ${slot}`);
    assert.equal(vol.bucketIndex, slot % 6, `slot ${slot}`);
    assert.equal(vol.bucketSize, slot % 6 === 5 ? 1 : SCHEDULE_BUCKET_LIMIT, `slot ${slot}`);
    assert.deepEqual(vol.targets, vol.targets.slice().sort((a, b) => a - b), 'doelen blijven oplopend');

    for (const capaciteit of [1, 2, 7, 13, 24, 25]) {
      const krap = scheduleRonde(slot, quotumVoor(capaciteit));
      assert.equal(krap.bucketIndex, vol.bucketIndex, `slot ${slot}, capaciteit ${capaciteit}`);
      assert.equal(krap.bucketCount, vol.bucketCount, `slot ${slot}, capaciteit ${capaciteit}`);
      assert.equal(krap.bucketSize, vol.bucketSize, `slot ${slot}, capaciteit ${capaciteit}`);
      // Het venster is een DEELverzameling van de vaste bucket, nooit iets van buiten.
      assert.equal(krap.targets.length, Math.min(capaciteit, vol.bucketSize));
      for (const nummer of krap.targets) {
        assert.ok(vol.targets.includes(nummer), `${nummer} hoort niet in bucket ${vol.bucketIndex}`);
      }
      // En de begroting van deze beurt past in wat er betaalbaar was.
      assert.ok(SELECTION_REQUEST_BUDGET + (krap.targets.length * PER_PULL_REQUEST_REQUEST_BUDGET)
        <= quotumVoor(capaciteit) - QUOTA_RESERVE);
    }
  }
});

test('S24. het venster schuift op de BEZOEKteller, dus geen enkele PR verhongert bij wisselend quota', () => {
  // De bezoekteller loopt met één op bij elke terugkeer van dezelfde bucket, ongeacht het quotum.
  for (const count of [1, 6, 7, 126]) {
    for (const slot of [0, 3, 41, 999]) {
      assert.equal(scheduleBucketVisit(slot + count, count), scheduleBucketVisit(slot, count) + 1);
    }
  }
  // En het startanker volgt die teller, niet de capaciteit.
  const bucket = Array.from({ length: 25 }, (_, i) => i + 1);
  for (let visit = 0; visit < 30; visit += 1) {
    const ankers = [1, 3, 25].map((cap) => selectBucketWindow(bucket, visit, cap).start);
    assert.deepEqual(ankers, [visit % 25, visit % 25, visit % 25], `visit ${visit}`);
    const venster = selectBucketWindow(bucket, visit, 1);
    assert.deepEqual(venster.window, [bucket[visit % 25]], `visit ${visit}`);
  }
  assert.deepEqual(selectBucketWindow(bucket, 3, 25).window, bucket, 'volle capaciteit = hele bucket');
  assert.deepEqual(selectBucketWindow([], 0, 5), { window: [], start: 0, size: 0 });

  // VOLLE CAPACITEIT: alle 126 binnen de zes vaste buckets, in zes slots.
  assert.equal(dekking(() => SCHEDULE_BUCKET_LIMIT, 6).size, 126);

  // CAPACITEIT ÉÉN: eindige convergentie. Zes buckets maal hoogstens 25 leden is 150 slots.
  assert.equal(dekking(() => 1, 150).size, 126, 'capaciteit één convergeert eindig');

  // AFWISSELEND 25/1 en 1/25 — de reeks uit de negatieve controle. Geen enkel nummer overgeslagen.
  const afwisselend = dekking((slot) => (slot % 2 === 0 ? SCHEDULE_BUCKET_LIMIT : 1), 150);
  assert.equal(afwisselend.size, 126, '25/1 slaat niets over');
  const omgekeerd = dekking((slot) => (slot % 2 === 0 ? 1 : SCHEDULE_BUCKET_LIMIT), 150);
  assert.equal(omgekeerd.size, 126, '1/25 slaat niets over');
  assert.deepEqual([...afwisselend].sort((a, b) => a - b), OPEN_126.map((pr) => pr.number));

  // WILLEKEURIGE positieve reeks, deterministisch gezaaid.
  let zaad = 20260822;
  const volgende = () => {
    zaad = (zaad * 1103515245 + 12345) % 2147483648;
    return 1 + (zaad % SCHEDULE_BUCKET_LIMIT);
  };
  assert.equal(dekking(() => volgende(), 200).size, 126, 'willekeurige capaciteit convergeert');
});

test('S25. NEGATIEVE MUTATIE: quotum vóór de partitionering laat PR\'s bij wisselend budget verhongeren', async () => {
  // Exact de vorm van vóór deze reparatie: de betaalbare limiet is óók de bucketgrootte.
  const gemuteerd = await mutantVanDeSelector(
    'quotum-in-de-indeling',
    '  const { bucket, index, count } = selectScheduleBucket(open, slot, partitionLimit);',
    '  const { bucket, index, count } = selectScheduleBucket(open, slot, Math.min(partitionLimit, affordable));',
  );

  const wisselend = (slot) => (slot % 2 === 0 ? SCHEDULE_BUCKET_LIMIT : 1);
  const mutantDekking = dekking(wisselend, 600, gemuteerd.selectTargets);
  const echteDekking = dekking(wisselend, 150);

  assert.ok(mutantDekking.size < 126,
    `de mutant meet ${mutantDekking.size} van 126 in 600 slots en laat de rest staan`);
  assert.equal(echteDekking.size, 126, 'de echte selector heeft er dan al 126 gehad in 150 slots');

  // De overgeslagen nummers zijn geen ruis: ze komen ook in tien keer zoveel slots niet aan de beurt.
  const gemist = OPEN_126.map((pr) => pr.number).filter((n) => !mutantDekking.has(n));
  assert.ok(gemist.length > 0);
  for (const nummer of gemist) assert.ok(echteDekking.has(nummer), `${nummer} wordt wél gemeten`);

  // En de oorzaak, direct gemeten: bij de mutant hangt de INDELING zelf aan het quotum.
  const volleIndeling = gemuteerd.selectTargets({
    eventName: 'schedule', event: {}, openPullRequests: OPEN_126, nowEpochSeconds: 0,
    remainingQuota: quotumVoor(SCHEDULE_BUCKET_LIMIT),
  });
  const krappeIndeling = gemuteerd.selectTargets({
    eventName: 'schedule', event: {}, openPullRequests: OPEN_126, nowEpochSeconds: 0,
    remainingQuota: quotumVoor(1),
  });
  assert.notEqual(volleIndeling.bucketCount, krappeIndeling.bucketCount);
  assert.equal(scheduleRonde(0, quotumVoor(SCHEDULE_BUCKET_LIMIT)).bucketCount,
    scheduleRonde(0, quotumVoor(1)).bucketCount, 'bij de echte selector niet');
});

test('S26. een ONBEKEND restquotum start geen enkele schrijver — event noch schedule', () => {
  // Bevinding `3835186662`. Onbekend is geen toestemming; het is een eigen, rode uitkomst.
  const scheduleOnbekend = scheduleRonde(0, null);
  assert.equal(scheduleOnbekend.outcome, TARGET_OUTCOME.FAIL);
  assert.equal(scheduleOnbekend.reason, TARGET_REASON.API_QUOTA_UNKNOWN);
  assert.deepEqual(scheduleOnbekend.targets, []);

  for (const stuk of [null, undefined, '900', -1, 1.5, Number.NaN, Infinity, {}]) {
    assert.equal(affordablePullRequests(stuk), null, String(stuk));
    const viaSchedule = scheduleRonde(3, stuk);
    assert.equal(viaSchedule.outcome, TARGET_OUTCOME.FAIL, String(stuk));
    assert.equal(viaSchedule.reason, TARGET_REASON.API_QUOTA_UNKNOWN, String(stuk));

    for (const invoer of [
      { eventName: 'issue_comment', event: commentOpPr(74) },
      { eventName: 'workflow_run', event: { workflow_run: shieldRun() } },
    ]) {
      const viaEvent = selectTargets({ ...invoer, openPullRequests: [], remainingQuota: stuk });
      assert.equal(viaEvent.outcome, TARGET_OUTCOME.FAIL, `${invoer.eventName} ${String(stuk)}`);
      assert.equal(viaEvent.reason, TARGET_REASON.API_QUOTA_UNKNOWN, `${invoer.eventName}`);
      assert.deepEqual(viaEvent.targets, []);
    }
  }

  // Onbekend en te-krap zijn UITDRUKKELIJK verschillende uitkomsten: een bekend budget dat niet
  // voor één PR volstaat blijft de expliciete, stille budgetuitkomst.
  const teKrap = scheduleRonde(0, quotumVoor(1) - 1);
  assert.equal(teKrap.outcome, TARGET_OUTCOME.NO_OP);
  assert.equal(teKrap.reason, TARGET_REASON.API_BUDGET_RESERVED);
  assert.notEqual(TARGET_REASON.API_QUOTA_UNKNOWN, TARGET_REASON.API_BUDGET_RESERVED);
});

test('S26b. NEGATIEVE MUTATIE: onbekend quotum dat de vaste bovengrens opent, start 25 schrijvers', async () => {
  // De V14-vorm: `null` betekende "niet krimpen", dus mat een mislukte `rate_limit`-meting de VOLLE
  // bucket. Dat is precies wat er niet mag: de teller waarop de begroting rust was onleesbaar.
  const gemuteerd = await mutantVanDeSelector(
    'onbekend-quotum-is-maximum',
    '  if (!Number.isInteger(remainingQuota) || remainingQuota < 0) return null;',
    '  if (!Number.isInteger(remainingQuota) || remainingQuota < 0) return SCHEDULE_BUCKET_LIMIT;',
  );

  const mutantSchedule = gemuteerd.selectTargets({
    eventName: 'schedule', event: {}, openPullRequests: OPEN_126, nowEpochSeconds: 0,
    remainingQuota: null,
  });
  assert.equal(mutantSchedule.outcome, TARGET_OUTCOME.MEASURE);
  assert.equal(mutantSchedule.targets.length, SCHEDULE_BUCKET_LIMIT,
    'de mutant zet 25 schrijvers aan op een onleesbare teller');

  const mutantEvent = gemuteerd.selectTargets({
    eventName: 'issue_comment', event: commentOpPr(74), openPullRequests: [], remainingQuota: null,
  });
  assert.equal(mutantEvent.outcome, TARGET_OUTCOME.MEASURE);

  // De echte selector doet in exact dezelfde situatie niets, en wordt rood.
  assert.equal(scheduleRonde(0, null).outcome, TARGET_OUTCOME.FAIL);
  assert.deepEqual(scheduleRonde(0, null).targets, []);
});

test('S27. de CLI maakt van een onleesbaar quotum een RODE ronde en publiceert de vensterkeuze', () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-gate-quota-'));
  const bestanden = new Map([
    ['e.json', '{}'],
    ['o.json', JSON.stringify(OPEN_126)],
  ]);
  const geschreven = new Map();
  const readFile = (pad) => {
    if (!bestanden.has(pad)) throw new Error('ENOENT');
    return bestanden.get(pad);
  };
  const writeFile = (pad, data) => geschreven.set(pad, data);
  const uit = () => JSON.parse(geschreven.get(join(dir, 'targets.json')));
  const argv = (quota) => [
    '--event-name', 'schedule', '--event', 'e.json', '--open-pulls', 'o.json',
    '--open-pulls-complete', 'true', '--now-epoch', String(3600 * 7), '--remaining-quota', quota,
    '--out', join(dir, 'targets.json'),
  ];
  const draai = (quota) => {
    const regels = [];
    const echteLog = console.log;
    console.log = (regel) => regels.push(regel);
    try {
      return { rc: runSelect(argv(quota), { readFile, writeFile }), regels };
    } finally {
      console.log = echteLog;
    }
  };

  // `-` is de vorm die de workflow doorgeeft als `gh api rate_limit` niets bruikbaars opleverde.
  const onbekend = draai('-');
  assert.equal(onbekend.rc, 1, 'rc 1 = rode run');
  assert.deepEqual(uit(), [], 'geen matrix, dus geen schrijver');
  assert.ok(onbekend.regels.includes(`LIVE_GATE_TARGETS_${TARGET_REASON.API_QUOTA_UNKNOWN}`),
    onbekend.regels.join(','));

  // Een BEKEND maar te krap budget blijft rc 2: stil, geen schrijver, geen rode run.
  const krap = draai(String(quotumVoor(1) - 1));
  assert.equal(krap.rc, 2);
  assert.deepEqual(uit(), []);
  assert.ok(krap.regels.includes(`LIVE_GATE_TARGETS_${TARGET_REASON.API_BUDGET_RESERVED}`));

  // En een gewone ronde publiceert de vaste bucket ÉN het deelvenster, zodat in de runlog terug te
  // lezen is dat de indeling niet met het quotum meebewoog.
  const vol = draai(String(quotumVoor(SCHEDULE_BUCKET_LIMIT)));
  assert.equal(vol.rc, 0);
  assert.equal(uit().length, SCHEDULE_BUCKET_LIMIT);
  assert.ok(vol.regels.some((r) => /^LIVE_GATE_SLOT_7_BUCKET_2_OF_6$/.test(r)), vol.regels.join(','));
  assert.ok(vol.regels.some((r) => /^LIVE_GATE_BUCKET_SIZE_25_VISIT_1_WINDOW_1_COUNT_25$/.test(r)),
    vol.regels.join(','));

  const smal = draai(String(quotumVoor(3)));
  assert.equal(smal.rc, 0);
  assert.equal(uit().length, 3);
  // Zelfde slot, zelfde bucket: alleen het aantal in het venster verschilt.
  assert.ok(smal.regels.some((r) => /^LIVE_GATE_SLOT_7_BUCKET_2_OF_6$/.test(r)), smal.regels.join(','));
  assert.ok(smal.regels.some((r) => /^LIVE_GATE_BUCKET_SIZE_25_VISIT_1_WINDOW_1_COUNT_3$/.test(r)),
    smal.regels.join(','));

  // De workflow geeft precies deze `-`-vorm door en vertaalt rc 1 naar een rode run.
  assert.match(WRITER_TEKST, /remaining='-' ;;/);
  assert.match(WRITER_TEKST, /--remaining-quota "\$remaining"/);
});
