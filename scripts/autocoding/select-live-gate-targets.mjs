/**
 * AUTOCODING_SHIELD — doelselectie voor de trusted statuswriter.
 *
 * De writer wordt gestart door `workflow_run` (na de onprivileged shield) of door `schedule`. Geen
 * van beide events draagt betrouwbare PR-informatie:
 *
 *   - De `workflow_run`-payload komt van een run waarvan de DEFINITIE door de PR geleverd kan zijn.
 *     Naam, pad, `head_sha` en `head_branch` zijn dus hooguit een HINT, nooit een feit waarop een
 *     status geschreven mag worden. Outputs, artifacts en cache van die run worden hier niet gelezen
 *     en mogen dat ook nooit gaan doen.
 *   - Bij een `issue_comment` draait de shield op de default branch, dus binden `head_sha` en
 *     `head_branch` aan die branch en niet aan de becommentarieerde PR. Bij `schedule` bestaat er
 *     überhaupt geen hint.
 *
 * Daarom bepaalt deze module de doel-PR's OPNIEUW uit een read-only API-lijst van open pull
 * requests, en gebruikt hij de hint HELEMAAL NIET meer om die lijst te versmallen. Iedere
 * geaccepteerde aanleiding meet ALLE open PR's.
 *
 * Waarom de hint zelfs bij een head-gebonden bronevent moest sneuvelen — een eigenschap van de
 * writerlock, niet van de hint. Er is één globale writergroep en GitHub houdt daarvan hooguit één
 * WACHTENDE run aan: komt er een derde aanleiding, dan ANNULEERT hij de wachtende. Het gemeten
 * gevolg: iemand verwijdert een receipt op PR A (run A gaat in de wachtrij), er komt een event op
 * PR B, GitHub annuleert run A, en de overlevende run B versmalde op zijn eigen hint tot alleen B.
 * De invalidatie van A was dan weg, en A's eerdere `success` bleef bruikbaar tot de volgende
 * uurlijkse ronde. Een volledige ronde bij elke aanleiding heeft die eigenschap niet: de
 * overlevende run doet automatisch óók het werk van elke geannuleerde voorganger.
 *
 * Waarom die bovengrens weg moest. `OPEN_PULL_REQUEST_LIMIT = 25` weigerde de hele ronde zodra er
 * meer open PR's waren: nul statussen gepubliceerd en een rode writerrun. Dat is niet fail-closed
 * maar fail-STALE. Een al gepubliceerde `success` op een PR-head blijft namelijk gewoon groen als er
 * niets overheen wordt geschreven. Wie na een groene uitspraak zijn receipt verwijdert of bewerkt,
 * kreeg dus precies wat hij wilde: de writer werd rood op de default branch, de PR-head bleef groen,
 * en de uurlijkse fallback kon dat nooit repareren zolang de teller boven de limiet bleef. Een
 * ontbrekende status is stil; een verkeerde status is groen. Alleen de tweede is gevaarlijk.
 *
 * Wat er WEL fail-closed blijft: een onleesbare of onbruikbare lijst. Dan is niet bekend WELKE PR's
 * bestaan, dus is elke ronde per definitie onvolledig en wordt er niets gepubliceerd. Het verschil
 * met de oude limiet is dat een volledig leesbare lijst nu altijd volledig GEÏNVALIDEERD wordt, hoe
 * lang hij ook is. De kosten daarvan (zes GET's per gemeten PR) zijn een budgetkwestie; loopt dat
 * budget leeg, dan faalt dat per record en levert het `failure` op de gemeten head op — zichtbaar,
 * niet stil groen.
 *
 * De uitspraak zelf is een pure functie van de API-momentopname per PR, dus een PR twee keer meten
 * levert twee keer dezelfde status op. Te veel meten kost API-budget; te weinig meten laat een stale
 * status staan. De asymmetrie bepaalt de keuze.
 *
 * INVALIDATE-FIRST. Dat budget is eindig en dus zelf een risico: zeven GET's en een POST per PR
 * betekent bij 126 open PR's meer dan duizend verzoeken, en het uurlijkse `GITHUB_TOKEN`-quotum is
 * duizend. Wie de PR's één voor één volledig afhandelt, raakt halverwege door zijn budget heen — en
 * de PR's die dan nog niet aan de beurt waren, houden hun oude `success`. De volgorde is daarom
 * omgekeerd: EERST krijgt iedere head uit de volledige lijst één goedkope `pending`-POST (126
 * verzoeken, geen GET's), en pas daarna wordt er gemeten. Vanaf dat moment kan geen enkele
 * geselecteerde head nog groen staan, dus is elke verdere uitputting hooguit een uitgestelde
 * uitspraak in plaats van een stale groene.
 *
 * Die tweede fase is begrensd op `EVALUATION_BATCH_LIMIT` PR's en roteert met het run-nummer, zodat
 * elke open PR binnen eindig veel writerruns aan de beurt komt. De rotatie is UITSLUITEND
 * scheduling: ze bepaalt wanneer een head zijn uitspraak terugkrijgt, nooit of hij groen mag
 * blijven.
 */

import { pathToFileURL } from 'node:url';

import { flattenPages } from './collect-shield-input.mjs';

/**
 * De bron die de trusted writer als aanleiding accepteert. Naam ÉN pad moeten kloppen: een PR kan
 * een nieuw workflowbestand toevoegen met de naam `autocoding-shield` op een ander pad, en die mag
 * de writer niet als vertrouwde aanleiding kunnen gebruiken.
 */
export const EXPECTED_SOURCE = Object.freeze({
  workflowName: 'autocoding-shield',
  workflowPath: '.github/workflows/autocoding-shield.yml',
  events: Object.freeze(['pull_request', 'issue_comment', 'pull_request_review']),
});

/**
 * De bovengrens op het aantal PR's dat ÉÉN writerrun volledig doormeet.
 *
 * Honderd is geen ronde smaak maar de rekensom: zes detail-GET's plus een status-POST per PR, plus
 * de paginering van de open-PR-lijst, past bij honderd PR's ruim binnen het uurlijkse
 * `GITHUB_TOKEN`-quotum van duizend verzoeken — inclusief de invalidatieronde die er in dezelfde run
 * al aan vooraf is gegaan. Bij 126 open PR's kost die eerste ronde 126 POST's en de tweede hoogstens
 * 700 GET's plus 100 POST's: samen onder de duizend.
 *
 * Deze grens weigert NOOIT een ronde. Hij bepaalt alleen hoeveel heads deze run hun uitspraak
 * terugkrijgen; alle andere heads staan op dat moment al op `pending` en zijn dus niet groen.
 */
export const EVALUATION_BATCH_LIMIT = 100;

export const TARGET_REASON = Object.freeze({
  SOURCE_NOT_TRUSTED: 'SOURCE_NOT_TRUSTED',
  EVENT_NOT_SUPPORTED: 'EVENT_NOT_SUPPORTED',
  OPEN_PULL_REQUESTS_UNREADABLE: 'OPEN_PULL_REQUESTS_UNREADABLE',
  ARGUMENTS_INVALID: 'ARGUMENTS_INVALID',
  EVENT_PAYLOAD_UNREADABLE: 'EVENT_PAYLOAD_UNREADABLE',
});

/**
 * Er is nog maar ÉÉN selectievorm. De twee `HINT_MATCHED_*`-vormen zijn verwijderd en mogen niet
 * terugkeren: elke hintversmalling herstelt het verlies van invalidaties bij een door GitHub
 * geannuleerde wachtende writerrun.
 */
export const TARGET_SELECTION = Object.freeze({
  ALL_OPEN_PULL_REQUESTS: 'ALL_OPEN_PULL_REQUESTS',
});

/** Uitkomsten die de aanroeper uit elkaar moet houden. */
export const TARGET_OUTCOME = Object.freeze({
  MEASURE: 'MEASURE',
  /** Geen fout van ons: een onverwachte aanleiding schrijft niets en is geen rode run. */
  NO_OP: 'NO_OP',
  /** Wel een fout: de ronde kan niet volledig zijn, dus wordt er niets gepubliceerd en is het rood. */
  FAIL: 'FAIL',
});

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Toetst de aanleiding van een `workflow_run`. Alleen de voltooiing van de verwachte onprivileged
 * shield, gestart door een verwacht bronevent, telt. Alles daarbuiten — een andere workflow, een
 * gelijknamige workflow op een ander pad, een `workflow_dispatch`, een `push` — is geen aanleiding.
 */
export function isTrustedWorkflowRunSource(workflowRun, expected = EXPECTED_SOURCE) {
  if (!workflowRun || typeof workflowRun !== 'object' || Array.isArray(workflowRun)) return false;
  if (workflowRun.name !== expected.workflowName) return false;
  if (workflowRun.path !== expected.workflowPath) return false;
  return expected.events.includes(workflowRun.event);
}

/** Normaliseert de API-lijst met open PR's. Eén onbruikbare vermelding maakt de lijst onbruikbaar. */
export function normaliseOpenPullRequests(payload) {
  const entries = flattenPages(payload);
  const out = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const number = entry.number;
    if (!Number.isInteger(number) || number <= 0) return null;
    const head = entry.head && typeof entry.head === 'object' ? entry.head : {};
    out.push({
      number,
      headSha: typeof head.sha === 'string' && SHA_RE.test(head.sha) ? head.sha : '',
      headRef: typeof head.ref === 'string' ? head.ref : '',
    });
  }
  return out;
}

/**
 * Verdeelt de volledige doellijst in vaste blokken en kiest er één op grond van het RUN-NUMMER.
 *
 * `index = (runNumber - 1) % count` betekent dat opeenvolgende writerruns blok 0, 1, … , count-1, 0
 * doorlopen. Elke open PR komt dus binnen `count` runs aan de beurt — bij 126 PR's binnen twee, en
 * met de uurlijkse `schedule` erbij dus binnen twee uur, ook als er verder niets gebeurt.
 *
 * Waarom een ONBRUIKBAAR run-nummer hier niet fataal is: de rotatie is scheduling, geen poort. Bij
 * een onbruikbaar nummer valt hij terug op blok 0. Het gevolg is hoogstens dat sommige heads langer
 * op `pending` blijven staan — en `pending` is niet groen. De ronde weigeren zou juist wél gevaarlijk
 * zijn, want dan wordt er niets geïnvalideerd en blijft élke oude `success` staan.
 */
export function selectEvaluationBatch(numbers, runNumber, limit = EVALUATION_BATCH_LIMIT) {
  const list = Array.isArray(numbers) ? numbers : [];
  if (list.length <= limit) return { batch: [...list], index: 0, count: 1, rotated: false };
  const count = Math.ceil(list.length / limit);
  const usable = Number.isInteger(runNumber) && runNumber > 0;
  const index = usable ? (runNumber - 1) % count : 0;
  return { batch: list.slice(index * limit, index * limit + limit), index, count, rotated: usable };
}

/**
 * Bepaalt welke PR's deze ronde meedoen, en in welke rol.
 *
 * De uitkomst kent drie lijsten, en het verschil ertussen is het hele ontwerp:
 *
 *   - `heads` — iedere (nummer, head)-combinatie uit de volledige open-PR-lijst. Deze krijgen ALLE
 *     eerst een `pending`-status. De hint uit de bronrun doet hier niets: hij mag de lijst niet
 *     versmallen, want dan verdwijnen de invalidaties van een geannuleerde wachtende run.
 *   - `targets` — dezelfde PR's als nummers, ontdubbeld en oplopend. Dit is de volledige ronde.
 *   - `batch` — het begrensde, met het run-nummer roterende deel van `targets` dat deze run
 *     werkelijk doormeet.
 *
 * `heads` wordt ontdubbeld op de PAAR (nummer, head) en niet op nummer alleen. `--paginate` kan
 * dezelfde PR met twee verschillende heads opleveren als de lijst tussen twee pagina's verschuift;
 * op allebei die heads kan een oude `success` staan, dus worden ze allebei geïnvalideerd. Voor de
 * meting telt de PR daarna gewoon één keer.
 */
export function selectTargets({
  eventName, workflowRun, openPullRequests, runNumber = null,
  expected = EXPECTED_SOURCE, batchLimit = EVALUATION_BATCH_LIMIT,
}) {
  if (eventName === 'workflow_run') {
    if (!isTrustedWorkflowRunSource(workflowRun, expected)) {
      return { outcome: TARGET_OUTCOME.NO_OP, reason: TARGET_REASON.SOURCE_NOT_TRUSTED, targets: [] };
    }
  } else if (eventName !== 'schedule') {
    // De workflow kent maar twee events. Een derde betekent dat bestand en script uit elkaar zijn
    // gelopen; dat is een defect en geen ruis, dus wordt het rood in plaats van stil.
    return { outcome: TARGET_OUTCOME.FAIL, reason: TARGET_REASON.EVENT_NOT_SUPPORTED, targets: [] };
  }

  const open = normaliseOpenPullRequests(openPullRequests);
  if (open === null) {
    return {
      outcome: TARGET_OUTCOME.FAIL, reason: TARGET_REASON.OPEN_PULL_REQUESTS_UNREADABLE, targets: [],
    };
  }

  // De volledige lijst, zonder bovengrens en zonder stilzwijgende truncatie. Oplopend gesorteerd en
  // ontdubbeld, zodat de ronde deterministisch is: `--paginate` kan een PR twee keer opleveren als de
  // lijst tussen twee pagina's verschuift, en tweemaal dezelfde PR meten is verspilling, geen extra
  // bewijs. Ontdubbelen verwijdert nooit een PR-NUMMER uit de ronde, alleen een herhaling ervan.
  const targets = [...new Set(open.map((pr) => pr.number))].sort((a, b) => a - b);

  const seen = new Set();
  const heads = [];
  for (const pr of open) {
    const key = `${pr.number} ${pr.headSha}`;
    if (seen.has(key)) continue;
    seen.add(key);
    heads.push({ number: pr.number, headSha: pr.headSha });
  }
  heads.sort((a, b) => (a.number - b.number) || (a.headSha < b.headSha ? -1 : 1));

  const { batch, index, count, rotated } = selectEvaluationBatch(targets, runNumber, batchLimit);
  return {
    outcome: TARGET_OUTCOME.MEASURE,
    selection: TARGET_SELECTION.ALL_OPEN_PULL_REQUESTS,
    targets,
    heads,
    batch,
    batchIndex: index,
    batchCount: count,
    batchRotated: rotated,
  };
}

export const TARGET_VALUE_OPTIONS = Object.freeze([
  '--event-name', '--event', '--open-pulls', '--out', '--out-heads', '--run-number',
]);

/** Zelfde fail-closed argumentlezing als de publisher: geen stilzwijgende herinterpretatie. */
export function parseTargetArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const options = new Set(TARGET_VALUE_OPTIONS);
  const values = new Map();
  const reject = { ok: false };

  for (let i = 0; i < list.length; i += 1) {
    const token = list[i];
    if (typeof token !== 'string') return reject;
    if (!options.has(token)) return reject;
    if (values.has(token)) return reject;
    i += 1;
    const value = list[i];
    if (typeof value !== 'string' || value.length === 0) return reject;
    if (options.has(value)) return reject;
    values.set(token, value);
  }
  for (const option of options) if (!values.has(option)) return reject;
  return { ok: true, values };
}

/** Alleen een decimaal, positief geheel getal telt als run-nummer; al het andere is onbruikbaar. */
export function parseRunNumber(value) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Schrijft twee bestanden, in de volgorde waarin de workflow ze gebruikt.
 *
 *   - `--out-heads`: `<nummer> <head>` per regel, over de VOLLEDIGE open-PR-lijst. Dit is de
 *     invalidatieronde. Een PR waarvan de lijst geen geldige head opleverde krijgt `-`; de workflow
 *     maakt dat record rood in plaats van het stil over te slaan, want zo'n head kan niet
 *     geïnvalideerd worden.
 *   - `--out`: de PR-nummers van de begrensde, roterende evaluatiebatch.
 *
 * rc 0: de bestanden staan er. rc 2: geen aanleiding, publiceer niets, geen fout. rc 1: de lijst is
 * onleesbaar, dus is niet bekend WELKE PR's bestaan — publiceer niets en word rood. Een lange lijst
 * is géén rc 1 meer.
 */
export function runSelect(argv, { readFile, writeFile } = {}) {
  const parsed = parseTargetArgs(argv);
  if (!parsed.ok) {
    console.log(`LIVE_GATE_TARGETS_${TARGET_REASON.ARGUMENTS_INVALID}`);
    return 1;
  }
  const args = parsed.values;

  let event;
  let openPullRequests;
  try {
    event = JSON.parse(readFile(args.get('--event')));
    openPullRequests = JSON.parse(readFile(args.get('--open-pulls')));
  } catch {
    console.log(`LIVE_GATE_TARGETS_${TARGET_REASON.EVENT_PAYLOAD_UNREADABLE}`);
    return 1;
  }

  const result = selectTargets({
    eventName: args.get('--event-name'),
    workflowRun: event?.workflow_run,
    openPullRequests,
    runNumber: parseRunNumber(args.get('--run-number')),
  });

  if (result.outcome !== TARGET_OUTCOME.MEASURE) {
    console.log(`LIVE_GATE_TARGETS_${result.reason}`);
    return result.outcome === TARGET_OUTCOME.NO_OP ? 2 : 1;
  }

  const lines = (rows) => (rows.length === 0 ? '' : `${rows.join('\n')}\n`);
  try {
    // De invalidatielijst eerst: raakt de tweede schrijfactie stuk, dan is de fase die de heads
    // niet-groen maakt in elk geval nog compleet weggeschreven.
    writeFile(
      args.get('--out-heads'),
      lines(result.heads.map((h) => `${h.number} ${h.headSha === '' ? '-' : h.headSha}`)),
    );
    writeFile(args.get('--out'), lines(result.batch));
  } catch {
    console.log('LIVE_GATE_TARGETS_OUTPUT_UNWRITABLE');
    return 1;
  }
  console.log(`LIVE_GATE_TARGETS_${result.selection}_${result.targets.length}`);
  console.log(
    `LIVE_GATE_BATCH_${result.batchIndex + 1}_OF_${result.batchCount}_SIZE_${result.batch.length}`,
  );
  if (result.batchCount > 1 && !result.batchRotated) console.log('LIVE_GATE_RUN_NUMBER_UNUSABLE');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFileSync, writeFileSync } = await import('node:fs');
  process.exitCode = runSelect(process.argv.slice(2), {
    readFile: (path) => readFileSync(path, 'utf8'),
    writeFile: (path, data) => writeFileSync(path, data),
  });
}
