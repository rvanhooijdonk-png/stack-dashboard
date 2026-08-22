/**
 * AUTOCODING_SHIELD — doelselectie voor de trusted statuswriter.
 *
 * WAT HIER VERANDERDE EN WAAROM. De vorige vorm liet iedere aanleiding ALLE open PR's invalideren en
 * daarna een met `github.run_number` roterende batch doormeten. Dat was een reparatie van één
 * eigenschap van de toenmalige globale writerlock: er was één groep voor de hele workflow, GitHub
 * bewaart per groep hooguit één WACHTENDE run, en een derde aanleiding annuleerde die wachtende run.
 * Een versmalde overlevende run liet de invalidatie van de geannuleerde voorganger dan vallen, dus
 * moest elke run alles doen.
 *
 * Die globale sweep loste dat op ten koste van twee nieuwe defecten, allebei door Codex gemeten
 * (review `4998729801`):
 *
 *   1. Het `GITHUB_TOKEN`-quotum van duizend verzoeken per uur is GEDEELD per repository, niet per
 *      run. Eén volledige ronde over 126 open PR's kostte ~926 verzoeken. Een tweede aanleiding in
 *      hetzelfde uur raakte dus halverwege de invalidatiefase leeg, en een PR die daarvóór net
 *      `success` had gekregen hield die stale groene status terwijl de run rood werd
 *      (inline `3834885350`).
 *   2. `github.run_number` loopt óók door voor runs die als wachtende run geannuleerd worden. De
 *      runs die werkelijk DRAAIEN hoeven daardoor geen opeenvolgende residuen modulo `batchCount` te
 *      bezoeken: bij twee blokken kan een herhaald aanleidingspatroon alle oneven runs annuleren,
 *      waarna elke overlevende run hetzelfde blok meet en het andere blok eindeloos op `pending`
 *      zet (inline `3834885354`).
 *
 * De oorzaak van beide was dezelfde: één globale rij dwong iedere aanleiding tot een ronde over de
 * hele repository. Die rij is nu weg. De writer serialiseert PER PULL REQUEST — jobconcurrency op
 * exact het gemeten PR-nummer, `cancel-in-progress: false`, `queue: max` — en daarmee mag de
 * selectie weer klein zijn:
 *
 *   - `issue_comment` draait volgens GitHub uitsluitend de definitie op de DEFAULT BRANCH en draagt
 *     `github.event.issue.number` plus `github.event.issue.pull_request`. Dat is een feit van
 *     GitHub, geen veld uit een door een PR geleverde run, dus is het bruikbaar als doelselectie.
 *     Precies één PR.
 *   - `workflow_run` na de onprivileged shield draagt `workflow_run.pull_requests`, dat GitHub zelf
 *     vult. De bronrun wordt eerst op naam, pad én bronevent getoetst; daarna telt uitsluitend een
 *     EENDUIDIGE associatie met precies één geldig, positief PR-nummer. Nul of meerdere is
 *     ambigu en levert een no-op op, met de schedule als vangnet.
 *   - `schedule` is de convergentiefallback en meet een kleine, deterministische bucket.
 *
 * Waarom dit nu WEL veilig is terwijl hintversmalling het eerder niet was: met `queue: max` op een
 * per-PR-groep annuleert een nieuwe aanleiding voor PR B nooit meer de wachtende beurt van PR A. Er
 * is dus geen aanleiding meer die een andere kan opeten, en daarmee vervalt de reden om alles te
 * doen. Wat een aanleiding wél nog kan overkomen is samenvallen met een gelijke beurt voor DEZELFDE
 * PR; dat is onschadelijk, want elke beurt leest ná de lock alle bewijs opnieuw en publiceert dus
 * dezelfde uitspraak.
 *
 * WAT V12 DAARAAN TOEVOEGT. De budgetgetallen hieronder waren in V11 nog een SCHATTING: de writer
 * haalde zijn bewijslijsten en zijn open-PR-lijst op met `gh api --paginate`, dat de `Link`-header
 * tot de laatste pagina volgt. Beide plekken lopen nu via `scripts/autocoding/gh-bounded-pages.sh`,
 * met een harde grens van `LIST_PAGE_BUDGET` respectievelijk `SELECTION_PAGE_BUDGET` pagina's.
 * Daarmee zijn de getallen hieronder werkelijke bovengrenzen. Een lijst die op die grens afgekapt
 * kan zijn eindigt fail-closed: bewijs wordt `failure` op de gemeten head, en een afgekapte
 * open-PR-lijst levert `OPEN_PULL_REQUESTS_TRUNCATED` op in plaats van een halve rotatie.
 *
 * Van de payload wordt NIETS anders gebruikt dan de PR-ASSOCIATIE. Geen `head_sha`, geen
 * `head_branch`, geen outputs, geen artifacts, geen cache. De head wordt door de writerjob zelf
 * opnieuw via de API gemeten, ná het verkrijgen van de per-PR-lock.
 */

import { pathToFileURL } from 'node:url';

import { flattenPages } from './collect-shield-input.mjs';

/**
 * De bron die de trusted writer als `workflow_run`-aanleiding accepteert. Naam ÉN pad moeten
 * kloppen: een PR kan een nieuw workflowbestand toevoegen met de naam `autocoding-shield` op een
 * ander pad, en die mag de writer niet als vertrouwde aanleiding kunnen gebruiken.
 *
 * `issue_comment` staat hier NIET meer bij. De trusted writer verwerkt dat event zelf, direct vanaf
 * de default branch, en de onprivileged shield is er daarom uit verwijderd. Zou het er nog staan,
 * dan werd één comment twee keer gedispatcht: één keer direct en één keer via de shieldrun.
 */
export const EXPECTED_SOURCE = Object.freeze({
  workflowName: 'autocoding-shield',
  workflowPath: '.github/workflows/autocoding-shield.yml',
  events: Object.freeze(['pull_request', 'pull_request_review', 'pull_request_review_comment']),
});

/**
 * Eén eventaanleiding meet hooguit ÉÉN pull request. Dit is geen smaak maar de budgetgrens uit
 * bevinding `3834885350`: zolang een event een volledige ronde kon veroorzaken, kon één comment
 * 126 heads invalideren en het gedeelde uurbudget leegtrekken.
 */
export const EVENT_TARGET_LIMIT = 1;

/** De bovengrens op de scheduledbucket. Zie `SCHEDULE_REQUEST_BUDGET` voor de rekensom. */
export const SCHEDULE_BUCKET_LIMIT = 25;

/**
 * De lengte van een tijdslot, in seconden. De schedule draait elk uur, dus is één slot één uur en
 * krijgen opeenvolgende scheduleruns opeenvolgende slotnummers.
 */
export const SCHEDULE_SLOT_SECONDS = 3600;

/**
 * Het aantal pagina's dat één BEWIJSLIJST van één pull request hoogstens kost.
 *
 * Dit getal was er in V11 al, maar het stond nergens tegenover een werkelijke grens: de writer haalde
 * de vijf lijsten op met `gh api --paginate --slurp`, en `--paginate` volgt de `Link`-header tot de
 * LAATSTE pagina. Het budget hieronder was daarmee een schatting en geen bovengrens — een PR met veel
 * commits, comments, reviews of bestanden kon het gedeelde uurquotum alsnog leegtrekken, nadat
 * `pending` al gepubliceerd was. `scripts/autocoding/gh-bounded-pages.sh` vervangt `--paginate` door
 * een harde grens van precies dit aantal verzoeken per lijst; `GH_BOUNDED_EVIDENCE_PAGES` daar is
 * hetzelfde getal, en `test/autocoding-live-gate-targets.test.mjs` bindt de twee aan elkaar.
 */
export const LIST_PAGE_BUDGET = 4;

/**
 * Het aantal pagina's dat de CHECK-RUNS van één commit hoogstens kosten.
 *
 * Alleen de finalizer leest dit eindpunt; de diagnostische writer heeft er niets aan. Het staat hier
 * en niet in de finalizer omdat deze module de enige plaats is waar paginabudgetten wonen, en omdat
 * `test/autocoding-live-gate-targets.test.mjs` de constanten hier aan hun spiegelbeeld in
 * `scripts/autocoding/gh-bounded-pages.sh` bindt — `GH_BOUNDED_CHECKS_PAGES` draagt hetzelfde getal.
 */
export const CHECKS_PAGE_BUDGET = 4;

/**
 * Het maximale aantal API-verzoeken dat één writerjob aan ÉÉN pull request besteedt, exact geteld
 * naar de stappen in `.github/workflows/autocoding-shield-live-gate.yml`:
 *
 *   3  hermeting van het PR-object (`repos/{r}/pulls/{n}`, hoogstens drie pogingen)
 *   1  onmiddellijke `pending`-POST op de opnieuw gemeten head
 *   1  `git/commits/{sha}`
 *  20  vijf bewijslijsten maal `LIST_PAGE_BUDGET` pagina's — een HARDE grens
 *   1  de afsluitende status-POST op diezelfde head
 *  --
 *  26
 *
 * De open-PR-lijst van de V17-HEADISOLATIE stond hier tot V18 voor vier verzoeken in, en is er nu
 * uit omdat de meting zelf weg is. Codex-bevindingen `3835364972` en `3835364974` toonden waarom:
 * een commitstatus hangt aan de COMMIT, dus kan geen enkele puntmeting op het publicatiemoment
 * voorkomen dat een LATER geopende pull request diezelfde `success` erft, en een offsetgepagineerde
 * lijst is bovendien geen consistente momentopname. Vier verzoeken per pull request kochten daarmee
 * geen grens maar een kleinere kans. De autorisatie is verplaatst naar de PR-gebonden finalizer; wat
 * hier overblijft is diagnostiek die nooit `success` publiceert.
 *
 * Truncatiedetectie staat bewust niet in deze som en hoort daar ook niet: of de laatst toegestane
 * pagina vol was, wordt afgelezen aan de pagina die al is opgehaald. Er gaat geen verzoek naartoe.
 * Er zijn verder geen herhaalpogingen: alleen de hermeting herhaalt, en die drie staan hierboven.
 */
export const PER_PULL_REQUEST_REQUEST_BUDGET = 3 + 1 + 1 + (5 * LIST_PAGE_BUDGET) + 1;

/**
 * De paginering van de open-PR-lijst in de selectiejob. Vier pagina's van honderd is 400 open PR's;
 * de gemeten stand was er 126. Ook hier is `--paginate` weg: zonder grens was de selectiekost een
 * functie van het aantal open PR's, en dus geen bovengrens. Is de vierde pagina VOL, dan is de lijst
 * mogelijk onvolledig en wordt er niets gemeten — zie `OPEN_PULL_REQUESTS_TRUNCATED`.
 *
 * `SELECTION_REQUEST_BUDGET` is gelijk aan het paginagetal: de `rate_limit`-meting die ernaast staat
 * telt niet mee voor het core-quotum. Voor een EVENTaanleiding wordt de lijst helemaal niet
 * opgehaald (nul verzoeken); dat de eventbegroting hem toch meerekent is bewuste conservatie.
 */
export const SELECTION_PAGE_BUDGET = 4;
export const SELECTION_REQUEST_BUDGET = SELECTION_PAGE_BUDGET;

/**
 * Het gedeelde uurlijkse `GITHUB_TOKEN`-quotum per repository, en de reserve die daar altijd van af
 * blijft. De reserve is de mechanische invulling van bevinding `3834885350`: het budget hoort niet
 * bij een RUN maar bij de repository, dus moet een run zijn eigen bovengrens afmeten tegen wat er op
 * dat moment werkelijk over is.
 */
export const SHARED_HOURLY_REQUEST_QUOTA = 1000;
export const QUOTA_RESERVE = 100;

/** De bovengrenzen per aanleidingssoort, inclusief de selectiejob die eraan voorafgaat. */
export const EVENT_REQUEST_BUDGET = SELECTION_REQUEST_BUDGET
  + (EVENT_TARGET_LIMIT * PER_PULL_REQUEST_REQUEST_BUDGET);
export const SCHEDULE_REQUEST_BUDGET = SELECTION_REQUEST_BUDGET
  + (SCHEDULE_BUCKET_LIMIT * PER_PULL_REQUEST_REQUEST_BUDGET);

export const TARGET_REASON = Object.freeze({
  SOURCE_NOT_TRUSTED: 'SOURCE_NOT_TRUSTED',
  EVENT_NOT_SUPPORTED: 'EVENT_NOT_SUPPORTED',
  EVENT_ASSOCIATION_EMPTY: 'EVENT_ASSOCIATION_EMPTY',
  EVENT_ASSOCIATION_AMBIGUOUS: 'EVENT_ASSOCIATION_AMBIGUOUS',
  OPEN_PULL_REQUESTS_UNREADABLE: 'OPEN_PULL_REQUESTS_UNREADABLE',
  OPEN_PULL_REQUESTS_TRUNCATED: 'OPEN_PULL_REQUESTS_TRUNCATED',
  SCHEDULE_SLOT_UNUSABLE: 'SCHEDULE_SLOT_UNUSABLE',
  NO_OPEN_PULL_REQUESTS: 'NO_OPEN_PULL_REQUESTS',
  API_BUDGET_RESERVED: 'API_BUDGET_RESERVED',
  API_QUOTA_UNKNOWN: 'API_QUOTA_UNKNOWN',
  ARGUMENTS_INVALID: 'ARGUMENTS_INVALID',
  EVENT_PAYLOAD_UNREADABLE: 'EVENT_PAYLOAD_UNREADABLE',
});

/**
 * De selectievormen. `ALL_OPEN_PULL_REQUESTS` bestaat NIET meer en mag niet terugkeren: die vorm was
 * de globale sweep waarvan bevinding `3834885350` aantoonde dat één event het gedeelde uurbudget kan
 * leegtrekken.
 */
export const TARGET_SELECTION = Object.freeze({
  EVENT_PULL_REQUEST: 'EVENT_PULL_REQUEST',
  SCHEDULE_SLOT_BUCKET: 'SCHEDULE_SLOT_BUCKET',
});

/** Uitkomsten die de aanroeper uit elkaar moet houden. */
export const TARGET_OUTCOME = Object.freeze({
  MEASURE: 'MEASURE',
  /** Geen fout van ons: een onverwachte of ambigue aanleiding schrijft niets en is geen rode run. */
  NO_OP: 'NO_OP',
  /** Wel een fout: de selectie kon niet worden bepaald, dus wordt er niets gepubliceerd. */
  FAIL: 'FAIL',
});

/**
 * Toetst de aanleiding van een `workflow_run`. Alleen de voltooiing van de verwachte onprivileged
 * shield, gestart door een verwacht bronevent, telt. Alles daarbuiten — een andere workflow, een
 * gelijknamige workflow op een ander pad, een `workflow_dispatch`, een `push`, een `issue_comment` —
 * is geen aanleiding.
 */
export function isTrustedWorkflowRunSource(workflowRun, expected = EXPECTED_SOURCE) {
  if (!workflowRun || typeof workflowRun !== 'object' || Array.isArray(workflowRun)) return false;
  if (workflowRun.name !== expected.workflowName) return false;
  if (workflowRun.path !== expected.workflowPath) return false;
  return expected.events.includes(workflowRun.event);
}

/** Alleen een positief geheel getal telt als PR-nummer. */
function pullRequestNumber(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * De PR die een `issue_comment` aanwijst.
 *
 * `issue.pull_request` is het veld waarmee GitHub een issue van een pull request onderscheidt;
 * ontbreekt het, dan gaat de comment over een gewoon issue en is er niets te meten. Het nummer komt
 * uit dezelfde, door GitHub gevulde payload en wordt nergens anders vandaan gehaald.
 */
export function issueCommentTarget(event) {
  const issue = event && typeof event === 'object' ? event.issue : null;
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)) return null;
  const link = issue.pull_request;
  if (!link || typeof link !== 'object' || Array.isArray(link)) return null;
  return pullRequestNumber(issue.number);
}

/**
 * De PR's die GitHub aan een `workflow_run` heeft gekoppeld.
 *
 * Dit veld wordt door GitHub gevuld op grond van de branch van de run, niet door de run zelf; het is
 * dus geen door een PR beheerste waarde. Een onbruikbare vermelding maakt de HELE lijst onbruikbaar
 * (`null`) in plaats van stilzwijgend te worden overgeslagen: bij een gedeeltelijk leesbare lijst is
 * niet bekend welke associatie er nog meer had moeten staan.
 */
export function workflowRunTargets(workflowRun) {
  const list = workflowRun && typeof workflowRun === 'object' ? workflowRun.pull_requests : null;
  if (!Array.isArray(list)) return null;
  const numbers = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const number = pullRequestNumber(entry.number);
    if (number === null) return null;
    numbers.push(number);
  }
  return [...new Set(numbers)].sort((a, b) => a - b);
}

/** Normaliseert de API-lijst met open PR's tot nummers. Eén onbruikbare vermelding is fataal. */
export function normaliseOpenPullRequests(payload) {
  // `flattenPages` leest alles wat geen array is als "geen pagina's". Voor de bewijsverzameling is
  // dat de juiste keuze, maar hier zou het een STILLE lege ronde opleveren op een antwoord dat
  // helemaal geen lijst is: nul statussen gepubliceerd terwijl een eerder groene head groen blijft.
  // Een lijst die niet als lijst leesbaar is, is ONLEESBAAR en niet leeg.
  if (!Array.isArray(payload)) return null;
  const entries = flattenPages(payload);
  const out = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const number = pullRequestNumber(entry.number);
    if (number === null) return null;
    out.push(number);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Het TIJDSLOT waarin een scheduleronde valt: `floor(epochSeconden / slotSeconden)`.
 *
 * Dit vervangt `github.run_number` en dat is de hele reparatie van bevinding `3834885354`. Een
 * run-nummer telt RUNS, ook runs die als wachtende run geannuleerd worden, dus hoeven de runs die
 * werkelijk draaien geen opeenvolgende residuen te bezoeken. Een tijdslot telt UREN. Het is
 * onafhankelijk van hoeveel runs er gestart, geannuleerd of overgeslagen zijn: de scheduletrigger
 * staat op één keer per uur, dus krijgen opeenvolgende scheduleruns per constructie opeenvolgende
 * slotnummers, en `count` opeenvolgende slots dekken de hele lijst.
 */
export function scheduleSlotOf(nowEpochSeconds, slotSeconds = SCHEDULE_SLOT_SECONDS) {
  if (!Number.isInteger(nowEpochSeconds) || nowEpochSeconds < 0) return null;
  if (!Number.isInteger(slotSeconds) || slotSeconds <= 0) return null;
  return Math.floor(nowEpochSeconds / slotSeconds);
}

/**
 * Verdeelt de open-PR-lijst in vaste blokken van hoogstens `limit` en kiest het blok van dit slot.
 *
 * De lijst is oplopend gesorteerd en ontdubbeld, dus de indeling is deterministisch: dezelfde lijst
 * en hetzelfde slot geven altijd dezelfde bucket. Over de slots `s … s + count - 1` komt iedere PR
 * precies één keer aan de beurt, ongeacht welke runs er tussendoor zijn geannuleerd.
 *
 * `limit` is de VASTE partitiegrootte en mag nooit uit het resterende quotum worden afgeleid — dan
 * zou de indeling zelf met het budget meebewegen. Het budget begrenst alleen het deelvenster binnen
 * de gekozen bucket; zie `selectBucketWindow`.
 *
 * Een onbruikbare `limit` valt terug op de canonieke `SCHEDULE_BUCKET_LIMIT`. Zou hij op `0` blijven
 * staan, dan is `Math.ceil(n / 0)` `Infinity`, `slot % Infinity` `NaN` en `slice(NaN, NaN)` leeg —
 * een ronde die niets meet en dus nooit convergeert.
 */
export function selectScheduleBucket(numbers, slot, limit = SCHEDULE_BUCKET_LIMIT) {
  const list = Array.isArray(numbers) ? numbers : [];
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : SCHEDULE_BUCKET_LIMIT;
  if (list.length === 0) return { bucket: [], index: 0, count: 1, limit: safeLimit };
  const count = Math.ceil(list.length / safeLimit);
  // JavaScript's `%` levert bij een negatief slot een negatief residu; dat zou buiten de lijst
  // snijden. De dubbele modulo maakt de index altijd een geldig blokindex.
  const index = Number.isInteger(slot) ? (((slot % count) + count) % count) : 0;
  return {
    bucket: list.slice(index * safeLimit, (index * safeLimit) + safeLimit),
    index,
    count,
    limit: safeLimit,
  };
}

/**
 * Hoeveel pull requests er nog binnen het GEDEELDE uurbudget passen, gegeven wat er van het core-
 * quotum over is. `null` betekent "het resterende budget is ONBEKEND" en is uitdrukkelijk geen
 * getal: `selectTargets()` maakt daar `API_QUOTA_UNKNOWN` van en meet niets. Eerder gold onbekend
 * als "dan de vaste bovengrens", en dat maakte een mislukte `rate_limit`-meting tot toestemming
 * voor de grootste batch (bevinding `3835186662`).
 */
export function affordablePullRequests(remainingQuota, {
  perPullRequest = PER_PULL_REQUEST_REQUEST_BUDGET,
  reserve = QUOTA_RESERVE,
  selectionCost = SELECTION_REQUEST_BUDGET,
} = {}) {
  if (!Number.isInteger(remainingQuota) || remainingQuota < 0) return null;
  const usable = remainingQuota - reserve - selectionCost;
  if (usable <= 0) return 0;
  return Math.floor(usable / perPullRequest);
}

/**
 * Het HOEVEELSTE bezoek dit slot aan zijn eigen vaste bucket is.
 *
 * Bucket `i` komt terug op de slots `i`, `i + count`, `i + 2·count`, … — dus is het bezoeknummer
 * `floor(slot / count)`. Dat getal loopt per constructie met precies één op bij iedere volgende
 * beurt van DEZELFDE bucket, ongeacht wat er tussendoor met het quotum gebeurt. Daar hangt de
 * convergentie hieronder aan: het venster schuift op de bezoekteller, niet op de capaciteit.
 *
 * `Math.floor` is de juiste metgezel van de vloermodulo in `selectScheduleBucket`: ook bij een
 * negatief slot verschillen twee opeenvolgende bezoeken exact één.
 */
export function scheduleBucketVisit(slot, count) {
  if (!Number.isInteger(slot)) return 0;
  if (!Number.isInteger(count) || count <= 0) return 0;
  return Math.floor(slot / count);
}

/**
 * Kiest binnen een VASTE bucket een circulair deelvenster van hoogstens `capacity` leden.
 *
 * Dit is de reparatie van bevinding `3835186656`. De vorige vorm gaf het betaalbare aantal door als
 * bucketGROOTTE, waardoor het quotum de partitionering zelf veranderde: bij 126 open PR's en
 * capaciteit 25 waren er zes buckets, bij capaciteit 1 honderdzesentwintig, en een lijst die tussen
 * beide heen en weer sprong bezocht steeds weer de lage nummers terwijl de hoge nooit aan de beurt
 * kwamen. De indeling ligt nu vast op `SCHEDULE_BUCKET_LIMIT`; alleen HOEVEEL leden van de gekozen
 * bucket deze beurt gemeten worden hangt van het budget af.
 *
 * Het startanker is `visit mod bucketgrootte`. Omdat `visit` bij elke terugkeer van dezelfde bucket
 * met één oploopt, schuift het anker elke beurt één positie op — onafhankelijk van de capaciteit.
 * Daardoor is ieder bucketlid binnen hoogstens `bucketgrootte` bezoeken minstens één keer het
 * startanker geweest, óók als de capaciteit blijft wisselen tussen 25 en 1: geen starvation.
 *
 * De teruggegeven leden staan oplopend, zodat de doelenlijst dezelfde canonieke vorm houdt als
 * vóór deze wijziging; `start` legt vast wáár het venster begon.
 */
export function selectBucketWindow(bucket, visit, capacity) {
  const list = Array.isArray(bucket) ? bucket : [];
  const size = list.length;
  if (size === 0) return { window: [], start: 0, size: 0 };
  const wanted = Number.isInteger(capacity) && capacity > 0 ? Math.min(capacity, size) : size;
  const anchor = Number.isInteger(visit) ? (((visit % size) + size) % size) : 0;
  const window = [];
  for (let i = 0; i < wanted; i += 1) window.push(list[(anchor + i) % size]);
  return { window: window.sort((a, b) => a - b), start: anchor, size: wanted };
}

/**
 * Bepaalt welke PR's deze aanleiding meet. Hoogstens één bij een event, hoogstens
 * `SCHEDULE_BUCKET_LIMIT` bij de schedule, en nooit de hele open lijst.
 */
export function selectTargets({
  eventName, event, openPullRequests, openPullRequestsComplete = true,
  nowEpochSeconds = null, remainingQuota = null,
  expected = EXPECTED_SOURCE, scheduleBucketLimit = SCHEDULE_BUCKET_LIMIT,
  slotSeconds = SCHEDULE_SLOT_SECONDS,
}) {
  const noOp = (reason) => ({ outcome: TARGET_OUTCOME.NO_OP, reason, targets: [] });
  const fail = (reason) => ({ outcome: TARGET_OUTCOME.FAIL, reason, targets: [] });
  const affordable = affordablePullRequests(remainingQuota);

  if (eventName === 'issue_comment' || eventName === 'workflow_run') {
    let candidates;
    if (eventName === 'issue_comment') {
      const number = issueCommentTarget(event);
      if (number === null) return noOp(TARGET_REASON.EVENT_ASSOCIATION_EMPTY);
      candidates = [number];
    } else {
      const workflowRun = event && typeof event === 'object' ? event.workflow_run : null;
      if (!isTrustedWorkflowRunSource(workflowRun, expected)) {
        return noOp(TARGET_REASON.SOURCE_NOT_TRUSTED);
      }
      candidates = workflowRunTargets(workflowRun);
      if (candidates === null || candidates.length === 0) {
        return noOp(TARGET_REASON.EVENT_ASSOCIATION_EMPTY);
      }
      // Meer dan één associatie is ambigu. Gokken zou of te veel meten (budget) of de verkeerde PR
      // meten; de schedule vangt dit binnen één slot alsnog op.
      if (candidates.length > EVENT_TARGET_LIMIT) {
        return noOp(TARGET_REASON.EVENT_ASSOCIATION_AMBIGUOUS);
      }
    }
    // Bevinding `3835186662`: een onleesbaar restant is GEEN toestemming. Vóór deze reparatie liet
    // `affordable === null` de vaste bovengrens staan, dus startte een mislukte `rate_limit`-meting
    // gewoon de maximale batch. Onbekend budget is nu een eigen, zichtbare FAIL zonder schrijver —
    // niet stil, niet groen, en met een andere code dan het bekende-maar-te-krappe budget eronder.
    if (affordable === null) return fail(TARGET_REASON.API_QUOTA_UNKNOWN);
    if (affordable < candidates.length) return noOp(TARGET_REASON.API_BUDGET_RESERVED);
    return {
      outcome: TARGET_OUTCOME.MEASURE,
      selection: TARGET_SELECTION.EVENT_PULL_REQUEST,
      targets: candidates,
      bucketIndex: 0,
      bucketCount: 1,
      slot: null,
    };
  }

  if (eventName !== 'schedule') {
    // De workflow kent maar drie events. Een vierde betekent dat bestand en script uit elkaar zijn
    // gelopen; dat is een defect en geen ruis, dus wordt het rood in plaats van stil.
    return fail(TARGET_REASON.EVENT_NOT_SUPPORTED);
  }

  // De rotatie verdeelt de VOLLEDIGE lijst in blokken en bezoekt er per slot één. Is de lijst zelf
  // afgekapt op de paginagrens, dan is er geen volledige lijst om over te roteren: alles voorbij
  // `SELECTION_PAGE_BUDGET * 100` zou dan nooit aan de beurt komen en voor altijd op een oude status
  // blijven staan, terwijl de ronde er gezond uitziet. Een onvolledige lijst is daarom geen
  // gedeeltelijke rotatie maar een meetfout: er wordt niets gepubliceerd en de run wordt rood.
  if (openPullRequestsComplete !== true) return fail(TARGET_REASON.OPEN_PULL_REQUESTS_TRUNCATED);

  const open = normaliseOpenPullRequests(openPullRequests);
  if (open === null) return fail(TARGET_REASON.OPEN_PULL_REQUESTS_UNREADABLE);
  if (open.length === 0) return noOp(TARGET_REASON.NO_OPEN_PULL_REQUESTS);

  // Zonder bruikbare klok is er geen eerlijk slot, en zou elke ronde blok 0 meten terwijl de rest
  // van de lijst nooit aan de beurt komt. Dat is starvation, dus wordt het rood en zichtbaar in
  // plaats van stil scheef.
  const slot = scheduleSlotOf(nowEpochSeconds, slotSeconds);
  if (slot === null) return fail(TARGET_REASON.SCHEDULE_SLOT_UNUSABLE);

  // Zie de eventtak: onbekend restant is fail-closed, ook hier, en juist hier — dit is de enige
  // aanleiding die een hele bucket ineens kan aanzetten.
  if (affordable === null) return fail(TARGET_REASON.API_QUOTA_UNKNOWN);

  // DE INDELING IS QUOTUMVRIJ. `partitionLimit` komt uitsluitend uit de vaste constante (of uit de
  // expliciete testparameter) en NOOIT uit `affordable`: bucketindex, bucketaantal en bucketleden
  // moeten hetzelfde zijn bij een vol en bij een bijna leeg quotum. Alleen het venster binnen de
  // bucket krimpt.
  const partitionLimit = Number.isInteger(scheduleBucketLimit) && scheduleBucketLimit > 0
    ? scheduleBucketLimit
    : SCHEDULE_BUCKET_LIMIT;
  const { bucket, index, count } = selectScheduleBucket(open, slot, partitionLimit);

  const capacity = Math.min(bucket.length, affordable);
  if (capacity < 1) return noOp(TARGET_REASON.API_BUDGET_RESERVED);

  const visit = scheduleBucketVisit(slot, count);
  const { window, start, size } = selectBucketWindow(bucket, visit, capacity);
  return {
    outcome: TARGET_OUTCOME.MEASURE,
    selection: TARGET_SELECTION.SCHEDULE_SLOT_BUCKET,
    targets: window,
    bucketIndex: index,
    bucketCount: count,
    bucketSize: bucket.length,
    visit,
    windowStart: start,
    windowSize: size,
    slot,
  };
}

export const TARGET_VALUE_OPTIONS = Object.freeze([
  '--event-name', '--event', '--open-pulls', '--open-pulls-complete', '--now-epoch',
  '--remaining-quota', '--out',
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
 * Leest een teller die de aanroeper als decimaal getal doorgeeft. Alleen cijfers tellen; `-` is de
 * afgesproken "onbekend"-vorm en levert net als elke andere onleesbare waarde `null` op.
 */
export function parseCounter(value) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Leest de volledigheidsvlag van de open-PR-lijst. Alleen de twee letterlijke waarden tellen;
 * `null` betekent onleesbaar en is een argumentfout, geen stilzwijgend "volledig".
 *
 * Dit is met opzet geen `value === 'true'`-test: die zou elke tikfout, elke lege waarde en elke
 * onbedoeld weggevallen vlag als ONVOLLEDIG lezen, en dat is weliswaar fail-closed maar onzichtbaar.
 * Een onleesbare waarde hoort een argumentfout te zijn, zodat het defect in de aanroeper zit en niet
 * als een eeuwige truncatiemelding rondzwerft.
 */
export function parseCompleteness(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

/**
 * Schrijft de doel-PR's als JSON-array naar `--out`. Dat is de matrixvorm die de writerjob via
 * `fromJSON()` inleest; per element ontstaat één job met een eigen per-PR concurrencygroep.
 *
 * rc 0: er zijn doelen, en `--out` draagt ze. rc 2: geen aanleiding of geen budget — publiceer
 * niets, geen fout. rc 1: de selectie kon niet worden bepaald, dus wordt er niets gepubliceerd en is
 * de run rood. Bij rc 1 en rc 2 wordt `--out` op een lege array gezet, zodat de matrixjob ook bij
 * een halve mislukking nooit een oude lijst kan erven.
 */
export function runSelect(argv, { readFile, writeFile } = {}) {
  const parsed = parseTargetArgs(argv);
  if (!parsed.ok) {
    console.log(`LIVE_GATE_TARGETS_${TARGET_REASON.ARGUMENTS_INVALID}`);
    return 1;
  }
  const args = parsed.values;

  const emit = (targets) => {
    writeFile(args.get('--out'), `${JSON.stringify(targets)}\n`);
  };

  let event;
  let openPullRequests;
  try {
    event = JSON.parse(readFile(args.get('--event')));
    openPullRequests = JSON.parse(readFile(args.get('--open-pulls')));
  } catch {
    try { emit([]); } catch { /* de uitkomst is toch al rood */ }
    console.log(`LIVE_GATE_TARGETS_${TARGET_REASON.EVENT_PAYLOAD_UNREADABLE}`);
    return 1;
  }

  // `-` (of elke andere onleesbare waarde) blijft `null`; `selectTargets()` maakt daar een rode
  // `API_QUOTA_UNKNOWN` van. De losse informatieve regel die hier stond is weg: hij zei hetzelfde
  // als de terminale redencode en suggereerde dat de ronde daarna gewoon doorliep.
  const remainingQuota = parseCounter(args.get('--remaining-quota'));

  const openPullRequestsComplete = parseCompleteness(args.get('--open-pulls-complete'));
  if (openPullRequestsComplete === null) {
    try { emit([]); } catch { /* de uitkomst is toch al rood */ }
    console.log(`LIVE_GATE_TARGETS_${TARGET_REASON.ARGUMENTS_INVALID}`);
    return 1;
  }

  const result = selectTargets({
    eventName: args.get('--event-name'),
    event,
    openPullRequests,
    openPullRequestsComplete,
    nowEpochSeconds: parseCounter(args.get('--now-epoch')),
    remainingQuota,
  });

  try {
    emit(result.outcome === TARGET_OUTCOME.MEASURE ? result.targets : []);
  } catch {
    console.log('LIVE_GATE_TARGETS_OUTPUT_UNWRITABLE');
    return 1;
  }

  if (result.outcome !== TARGET_OUTCOME.MEASURE) {
    console.log(`LIVE_GATE_TARGETS_${result.reason}`);
    return result.outcome === TARGET_OUTCOME.NO_OP ? 2 : 1;
  }

  console.log(`LIVE_GATE_TARGETS_${result.selection}_${result.targets.length}`);
  if (result.selection === TARGET_SELECTION.SCHEDULE_SLOT_BUCKET) {
    console.log(
      `LIVE_GATE_SLOT_${result.slot}_BUCKET_${result.bucketIndex + 1}_OF_${result.bucketCount}`,
    );
    // De vaste bucket én het deelvenster daarbinnen, zodat in de runlog terug te lezen is dat de
    // indeling niet met het quotum meebewoog en waar het venster deze beurt begon.
    console.log(
      `LIVE_GATE_BUCKET_SIZE_${result.bucketSize}`
      + `_VISIT_${result.visit}_WINDOW_${result.windowStart}_COUNT_${result.windowSize}`,
    );
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFileSync, writeFileSync } = await import('node:fs');
  process.exitCode = runSelect(process.argv.slice(2), {
    readFile: (path) => readFileSync(path, 'utf8'),
    writeFile: (path, data) => writeFileSync(path, data),
  });
}
