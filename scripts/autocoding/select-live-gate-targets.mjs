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
 * requests, en gebruikt hij de hint alleen om die lijst te versmallen wanneer het bronevent de
 * bronrun werkelijk aan de PR-head bindt ÉN de hint precies één open PR aanwijst. Lukt dat niet, dan
 * worden ALLE open PR's gemeten. Er is geen bovengrens meer op dat aantal.
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
 * met de oude limiet is dat een volledig leesbare lijst nu altijd volledig verwerkt wordt, hoe lang
 * hij ook is. De kosten daarvan (zes GET's per PR) zijn een budgetkwestie; loopt dat budget leeg,
 * dan faalt dat per record en levert het `failure` op de gemeten head op — zichtbaar, niet stil groen.
 *
 * De uitspraak zelf is een pure functie van de API-momentopname per PR, dus een PR twee keer meten
 * levert twee keer dezelfde status op. Te veel meten kost API-budget; te weinig meten laat een stale
 * status staan. De asymmetrie bepaalt de keuze.
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
 * De bronevents waarvan GitHub de bronrun WERKELIJK aan de PR-head bindt: bij `pull_request` en
 * `pull_request_review` draait de shield in de context van die ene pull request, dus wijzen
 * `head_sha` en `head_branch` naar diens head.
 *
 * `issue_comment` staat hier bewust NIET bij. Die run draait op de default branch, dus draagt hij
 * de head van `main` — een hint die naar de verkeerde PR wijst zodra precies één open PR (een fork
 * kan dat gewoon) `main` als head heeft. Versmallen op zo'n hint laat alle andere open PR's stale
 * achter, en dat is duurder dan de extra metingen van een volledige ronde.
 */
export const HEAD_BOUND_SOURCE_EVENTS = Object.freeze(['pull_request', 'pull_request_review']);

export const TARGET_REASON = Object.freeze({
  SOURCE_NOT_TRUSTED: 'SOURCE_NOT_TRUSTED',
  EVENT_NOT_SUPPORTED: 'EVENT_NOT_SUPPORTED',
  OPEN_PULL_REQUESTS_UNREADABLE: 'OPEN_PULL_REQUESTS_UNREADABLE',
  ARGUMENTS_INVALID: 'ARGUMENTS_INVALID',
  EVENT_PAYLOAD_UNREADABLE: 'EVENT_PAYLOAD_UNREADABLE',
});

export const TARGET_SELECTION = Object.freeze({
  HINT_MATCHED_HEAD_SHA: 'HINT_MATCHED_HEAD_SHA',
  HINT_MATCHED_HEAD_BRANCH: 'HINT_MATCHED_HEAD_BRANCH',
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
 * Bepaalt welke PR-nummers deze ronde gemeten worden.
 *
 * De hint doet alleen mee als het BRONEVENT hem aan een PR-head bindt, en versmalt dan alleen bij
 * een EENDUIDIGE treffer. Twee open PR's met dezelfde branchnaam (bij een fork heel gewoon) leveren
 * dus geen keuze op maar een volledige ronde: extra meten is onschadelijk, de verkeerde PR meten zou
 * een stale status laten staan.
 */
export function selectTargets({
  eventName, workflowRun, openPullRequests,
  expected = EXPECTED_SOURCE, headBoundEvents = HEAD_BOUND_SOURCE_EVENTS,
}) {
  let hint = null;
  if (eventName === 'workflow_run') {
    if (!isTrustedWorkflowRunSource(workflowRun, expected)) {
      return { outcome: TARGET_OUTCOME.NO_OP, reason: TARGET_REASON.SOURCE_NOT_TRUSTED, targets: [] };
    }
    // Alleen een head-gebonden bronevent levert een bruikbare hint; bij `issue_comment` worden
    // `head_sha` en `head_branch` volledig genegeerd in plaats van als zwakke aanwijzing gebruikt.
    hint = headBoundEvents.includes(workflowRun.event) ? workflowRun : null;
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

  if (hint) {
    const bySha = open.filter((pr) => pr.headSha !== '' && pr.headSha === hint.head_sha);
    if (bySha.length === 1) {
      return {
        outcome: TARGET_OUTCOME.MEASURE,
        selection: TARGET_SELECTION.HINT_MATCHED_HEAD_SHA,
        targets: [bySha[0].number],
      };
    }
    const byRef = open.filter((pr) => pr.headRef !== '' && pr.headRef === hint.head_branch);
    if (byRef.length === 1) {
      return {
        outcome: TARGET_OUTCOME.MEASURE,
        selection: TARGET_SELECTION.HINT_MATCHED_HEAD_BRANCH,
        targets: [byRef[0].number],
      };
    }
  }

  // De volledige lijst, zonder bovengrens en zonder stilzwijgende truncatie. Oplopend gesorteerd en
  // ontdubbeld, zodat de ronde deterministisch is: `--paginate` kan een PR twee keer opleveren als de
  // lijst tussen twee pagina's verschuift, en tweemaal dezelfde PR meten is verspilling, geen extra
  // bewijs. Ontdubbelen verwijdert nooit een PR-NUMMER uit de ronde, alleen een herhaling ervan.
  const targets = [...new Set(open.map((pr) => pr.number))].sort((a, b) => a - b);
  return {
    outcome: TARGET_OUTCOME.MEASURE,
    selection: TARGET_SELECTION.ALL_OPEN_PULL_REQUESTS,
    targets,
  };
}

export const TARGET_VALUE_OPTIONS = Object.freeze([
  '--event-name', '--event', '--open-pulls', '--out',
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

/**
 * rc 0: meet de weggeschreven nummers, hoeveel het er ook zijn. rc 2: geen aanleiding, publiceer
 * niets, geen fout. rc 1: de lijst is onleesbaar, dus is niet bekend WELKE PR's bestaan — publiceer
 * niets en word rood. Een lange lijst is géén rc 1 meer.
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
  });

  if (result.outcome !== TARGET_OUTCOME.MEASURE) {
    console.log(`LIVE_GATE_TARGETS_${result.reason}`);
    return result.outcome === TARGET_OUTCOME.NO_OP ? 2 : 1;
  }

  try {
    writeFile(args.get('--out'), result.targets.length === 0 ? '' : `${result.targets.join('\n')}\n`);
  } catch {
    console.log('LIVE_GATE_TARGETS_OUTPUT_UNWRITABLE');
    return 1;
  }
  console.log(`LIVE_GATE_TARGETS_${result.selection}_${result.targets.length}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFileSync, writeFileSync } = await import('node:fs');
  process.exitCode = runSelect(process.argv.slice(2), {
    readFile: (path) => readFileSync(path, 'utf8'),
    writeFile: (path, data) => writeFileSync(path, data),
  });
}
