/**
 * AUTOCODING_SHIELD — ISOLATIE VAN DE VASTE COMMITSTATUS TEGEN GEDEELDE HEADS.
 *
 * WAT HIER GEMETEN IS. Codex-bevinding `3835302930`: de poort evalueert bewijs en ownerautorisatie
 * PER PULL REQUEST, maar publiceert onder ÉÉN vaste commitstatuscontext op de COMMIT. Een commit
 * hoort niet bij een pull request; hij hoort bij de repository. Twee open pull requests kunnen
 * daardoor exact dezelfde volledige head-SHA dragen — bijvoorbeeld wanneer dezelfde branch tegen
 * twee bases wordt geopend, of wanneer twee branches naar dezelfde commit wijzen. Schrijft de poort
 * dan `success` voor de PR die werkelijk GO is, dan staat diezelfde `success` op GitHub óók op de
 * andere PR, want die deelt de head. Een required check op die context is voor de tweede PR groen
 * zonder dat er ooit bewijs voor is gezien.
 *
 * WAAROM DE BESTAANDE LOCKS DIT NIET VANGEN. De per-PR-rij en de repositorybrede rij ORDENEN de
 * schrijfacties: ze zorgen dat twee beurten nooit door elkaar heen schrijven en dat het gedeelde
 * quotum serieel wordt gemeten. Geen van beide isoleert de BETEKENIS. Twee PR's met dezelfde head
 * vallen in twee verschillende per-PR-groepen, dus schrijven ze keurig na elkaar — en dan wint de
 * laatst geschreven status voor allebei. Serialisatie maakt de uitkomst deterministisch, niet juist.
 *
 * WAAROM DE CONTEXT NIET DYNAMISCH WORDT. Een status per PR (`…-pr-74`) zou het probleem oplossen en
 * een groter probleem maken: een required check moet één canonieke naam houden, anders is er geen
 * naam om als vereist in te stellen en kan een nieuwe PR zijn eigen contextnaam kiezen. De context
 * blijft dus vast, en de ISOLATIE wordt hier afgedwongen.
 *
 * DE REGEL. Een uitspraak mag deze head alleen bereiken wanneer er op het moment van meten precies
 * ÉÉN open pull request bestaat met deze volledige head-SHA, en dat is exact de pull request die de
 * writer meet. Nul, twee of meer, een lijst die niet leesbaar is, een lijst die op de paginagrens
 * afgekapt kan zijn, of een ongeldige parameter leveren geen uitspraak op maar één vaste
 * fail-closed redencode — `HEAD_NOT_ISOLATED` — en daarmee een `failure`-status op die head. Nooit
 * `success`.
 *
 * VOLLEDIGE SHA's, NOOIT EEN BRANCHNAAM EN NOOIT EEN PREFIX. De vergelijking gaat over
 * `head.sha` in zijn volle veertig tekens. Een branchnaam zegt niets: twee verschillende branches
 * kunnen naar dezelfde commit wijzen, en dezelfde branchnaam kan in twee forks iets anders
 * betekenen. Een prefixvergelijking zegt evenmin genoeg: twee verschillende commits kunnen dezelfde
 * korte vorm delen, en dan zou de poort een PR blokkeren die niets deelt — of, erger, twee PR's die
 * alleen in het staartstuk verschillen als één zien.
 *
 * WAT DIT BESTAND NOOIT DOET: een PR-nummer, een branchnaam, een pad, een SHA of ruwe API-inhoud
 * naar stdout schrijven. De uitvoer is één literal uit een gesloten verzameling, zodat de runlog en
 * de statusomschrijving geen bewijsinhoud kunnen dragen.
 */

import { pathToFileURL } from 'node:url';

import { PUBLISH_ERROR } from './publish-live-status.mjs';
import { ISOLATION_PAGE_BUDGET } from './select-live-gate-targets.mjs';

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Het paginabudget van deze meting leeft in de budgetmodule, want daar wordt
 * `PER_PULL_REQUEST_REQUEST_BUDGET` uit opgebouwd. Het wordt hier alleen doorgegeven, zodat een
 * lezer van deze module niet hoeft te raden welk getal er geldt en er geen tweede definitie
 * ontstaat die van de eerste kan weglopen. Spiegelbeeld in bash: `GH_BOUNDED_ISOLATION_PAGES`.
 */
export { ISOLATION_PAGE_BUDGET };

/**
 * De ENIGE redencode die deze meting naar de publisher stuurt. Alle uitkomsten hieronder — geen
 * enkele PR met deze head, twee of meer, een andere PR dan de gemeten, een onleesbare lijst, een
 * afgekapte lijst, een onbruikbare parameter — leveren dezelfde code op. Dat is opzet: de
 * statusomschrijving mag niet verraden hoeveel of welke andere pull requests deze commit dragen.
 */
export const HEAD_ISOLATION_REASON = PUBLISH_ERROR.HEAD_NOT_ISOLATED;

/**
 * De categorieën die uitsluitend het JOBLOG halen, nooit de commitstatus. Ook dit is een gesloten
 * verzameling vaste literalen: een operator moet kunnen zien of het zicht ontbrak of dat er
 * werkelijk een tweede pull request op deze commit staat, zonder dat er één identificerend gegeven
 * in de log terechtkomt.
 */
export const ISOLATION_DETAIL = Object.freeze({
  ARGUMENTS_INVALID: 'ARGUMENTS_INVALID',
  OPEN_LIST_TRUNCATED: 'OPEN_LIST_TRUNCATED',
  OPEN_LIST_UNREADABLE: 'OPEN_LIST_UNREADABLE',
  HEAD_ABSENT: 'HEAD_ABSENT',
  HEAD_SHARED: 'HEAD_SHARED',
  HEAD_ON_OTHER_PULL_REQUEST: 'HEAD_ON_OTHER_PULL_REQUEST',
});

/**
 * Leest de begrensde-pagineringsvorm (`[[...],[...]]`) om tot paren van PR-nummer en volledige
 * head-SHA.
 *
 * Dit is met opzet strenger dan `normaliseOpenPullRequests` in de selector. Daar volstaat het
 * nummer; hier is de SHA het hele meetinstrument. Een vermelding zonder bruikbare head is dus geen
 * vermelding die overgeslagen mag worden: dan is onbekend of juist DIE pull request deze commit
 * draagt, en een blinde vlek in een uniciteitstoets is precies een gedeelde head die niet gezien
 * wordt. Eén onbruikbare vermelding maakt daarom de HELE lijst onleesbaar.
 *
 * De buitenste vorm moet een array van PAGINA's zijn — exact wat `gh_bounded_pages` schrijft. Een
 * andere vorm is geen lege lijst maar een onbruikbaar antwoord.
 *
 * `null` betekent onleesbaar; een `Map` van nummer naar SHA betekent leesbaar.
 */
export function normaliseOpenHeads(payload) {
  if (!Array.isArray(payload)) return null;
  const heads = new Map();
  for (const page of payload) {
    if (!Array.isArray(page)) return null;
    for (const entry of page) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const number = entry.number;
      if (!Number.isInteger(number) || number <= 0) return null;
      const head = entry.head;
      if (!head || typeof head !== 'object' || Array.isArray(head)) return null;
      const sha = head.sha;
      if (typeof sha !== 'string' || !SHA_RE.test(sha)) return null;
      // Pagina's kunnen overlappen wanneer de lijst tijdens het pagineren verschuift. Dezelfde PR
      // twee keer met DEZELFDE head is dan één pull request; dezelfde PR met twee verschillende
      // heads betekent dat de lijst onder de meting is bewogen, en dan is er niets betrouwbaars te
      // tellen.
      const eerder = heads.get(number);
      if (eerder !== undefined && eerder !== sha) return null;
      heads.set(number, sha);
    }
  }
  return heads;
}

/**
 * Beslist of deze head bij precies deze ene open pull request hoort. Pure functie: geen IO, geen
 * tijd, geen netwerk.
 *
 * De volgorde van de toetsen is de fail-closed volgorde: eerst of de parameters überhaupt een
 * meting toelaten, dan of het ZICHT volledig is, dan of het LEESBAAR is, en pas daarna wat er
 * geteld wordt. Een afgekapte lijst wordt dus afgewezen ook als de gemeten pull request binnen de
 * gelezen pagina's toevallig uniek lijkt — de tweede drager kan op de pagina staan die nooit is
 * opgehaald.
 */
export function resolveHeadIsolation({ openPullRequests, complete, pullRequest, headSha }) {
  const blocked = (detail) => ({ isolated: false, detail, reason: HEAD_ISOLATION_REASON });

  if (!Number.isInteger(pullRequest) || pullRequest <= 0) {
    return blocked(ISOLATION_DETAIL.ARGUMENTS_INVALID);
  }
  if (typeof headSha !== 'string' || !SHA_RE.test(headSha)) {
    return blocked(ISOLATION_DETAIL.ARGUMENTS_INVALID);
  }
  if (complete !== true) return blocked(ISOLATION_DETAIL.OPEN_LIST_TRUNCATED);

  const heads = normaliseOpenHeads(openPullRequests);
  if (heads === null) return blocked(ISOLATION_DETAIL.OPEN_LIST_UNREADABLE);

  const dragers = [];
  for (const [number, sha] of heads) if (sha === headSha) dragers.push(number);

  if (dragers.length === 0) return blocked(ISOLATION_DETAIL.HEAD_ABSENT);
  if (dragers.length > 1) return blocked(ISOLATION_DETAIL.HEAD_SHARED);
  if (dragers[0] !== pullRequest) return blocked(ISOLATION_DETAIL.HEAD_ON_OTHER_PULL_REQUEST);
  return { isolated: true, detail: null, reason: null };
}

export const ISOLATION_VALUE_OPTIONS = Object.freeze([
  '--open-pulls', '--open-pulls-complete', '--pull-request', '--head-sha',
]);

/**
 * Zelfde fail-closed argumentlezing als de publisher en de selector: een onbekend argument, een
 * dubbele sleutel, een sleutel zonder waarde of een waarde die zelf een sleutel is, is een
 * weigering en geen herinterpretatie. Alle vier de sleutels zijn verplicht.
 */
export function parseIsolationArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const options = new Set(ISOLATION_VALUE_OPTIONS);
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
 * De CLI. rc 0 uitsluitend wanneer de isolatie BEWEZEN is; elke andere uitkomst is rc 1, zodat de
 * aanroepende stap de vaste redencode kan doorgeven aan de publisher.
 *
 * De uitvoer bestaat uit precies één regel met één literal uit een gesloten verzameling. Er wordt
 * geen nummer, geen SHA, geen branchnaam, geen pad en geen enkel veld uit het antwoord gelogd.
 */
export function runVerifyHeadIsolation(argv, { readFile } = {}) {
  const parsed = parseIsolationArgs(argv);
  if (!parsed.ok) {
    console.log(`HEAD_ISOLATION_BLOCKED_${ISOLATION_DETAIL.ARGUMENTS_INVALID}`);
    return 1;
  }
  const args = parsed.values;

  const rawNumber = args.get('--pull-request');
  const pullRequest = /^[0-9]+$/.test(rawNumber) ? Number.parseInt(rawNumber, 10) : null;

  const rawComplete = args.get('--open-pulls-complete');
  if (rawComplete !== 'true' && rawComplete !== 'false') {
    // Een onleesbare volledigheidsvlag is een defect in de AANROEPER, niet een eeuwige
    // truncatiemelding. Dat verschil hoort zichtbaar te zijn.
    console.log(`HEAD_ISOLATION_BLOCKED_${ISOLATION_DETAIL.ARGUMENTS_INVALID}`);
    return 1;
  }

  let openPullRequests = null;
  try {
    if (typeof readFile !== 'function') throw new Error('unreadable');
    openPullRequests = JSON.parse(readFile(args.get('--open-pulls')));
  } catch {
    console.log(`HEAD_ISOLATION_BLOCKED_${ISOLATION_DETAIL.OPEN_LIST_UNREADABLE}`);
    return 1;
  }

  const uitkomst = resolveHeadIsolation({
    openPullRequests,
    complete: rawComplete === 'true',
    pullRequest: Number.isSafeInteger(pullRequest) ? pullRequest : null,
    headSha: args.get('--head-sha'),
  });
  if (!uitkomst.isolated) {
    console.log(`HEAD_ISOLATION_BLOCKED_${uitkomst.detail}`);
    return 1;
  }
  console.log('HEAD_ISOLATION_SINGLE_OPEN_HEAD');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFileSync } = await import('node:fs');
  process.exitCode = runVerifyHeadIsolation(process.argv.slice(2), {
    readFile: (path) => readFileSync(path, 'utf8'),
  });
}
