/**
 * AUTOCODING_SHIELD — DIAGNOSTISCHE STATUSPUBLISHER. GEEN AUTORISATIE.
 *
 * WAT HIER VERANDERDE, EN WAAROM HET GEEN VERFIJNING MAAR EEN AFSCHAFFING IS. Tot en met V17 droeg
 * deze route de uitspraak van de poort als een COMMITSTATUS met de bedoeling ooit een required check
 * te worden. Codex-bevinding `3835364972` bewees dat die constructie principieel niet kan werken:
 * een commitstatus is SHA-scoped en hoort dus bij de COMMIT, niet bij de pull request. Een tweede
 * pull request die later op dezelfde volledige head-SHA wordt geopend ziet een eerder geschreven
 * `success` onmiddellijk als de zijne — er is geen moment waarop een puntmeting dat nog kan
 * voorkomen, want de erfenis ontstaat NA de meting. Bevinding `3835364974` sloot de tweede uitweg:
 * uniciteit bewijzen uit een offset-gepagineerde open-PR-lijst is geen atomische momentopname, dus
 * ook de V17-isolatie was geen grens maar een gok met een net kleinere kans.
 *
 * De conclusie is niet "beter meten" maar "niet meer autoriseren". Deze route publiceert daarom
 * STRUCTUREEL geen `success` meer, in welk codepad dan ook:
 *
 *   - `resolvePublication` kent nog maar twee uitkomsten, `pending` en `failure`;
 *   - `PUBLISHABLE_STATES` is een gesloten allowlist, en `publishStatus` weigert vóór elk
 *     netwerkverkeer elke publicatie met een state daarbuiten. Een mutant die ergens weer `success`
 *     laat ontstaan haalt het transport dus niet, en de test die daarop staat wordt rood;
 *   - de context heet sinds V18 `diagnostic_status_context` en draagt de naam
 *     `autocoding-shield-diagnostic`. De oude naam `autocoding-shield-live-receipts` is verlaten en
 *     wordt nooit meer geschreven. Er is geen head waarop die oude context ooit `success` heeft
 *     gedragen: de poort stond de hele bootstrap uit (`live_receipt_gate_enabled: false`), dus geen
 *     enkele publicatiestap heeft ooit gedraaid.
 *
 * WAAROM DEZE ROUTE DAN BLIJFT BESTAAN. Zij is de enige plek waar een mens op de pull request zelf
 * kan zien WAAROM de poort niets toestaat. Redencodes in een joblog zijn onvindbaar zodra de run uit
 * beeld is; een `failure` op de head met dezelfde codes blijft staan. Dat is diagnostiek, geen
 * bevoegdheid: `pending` en `failure` kunnen niets toestaan, alleen iets tonen. De autorisatie zelf
 * is verplaatst naar `scripts/autocoding/finalize-merge.mjs`, die per PULL REQUEST beslist en zijn
 * uitkomst nergens als herbruikbaar artefact achterlaat.
 *
 * DEZE CONTEXT WORDT NOOIT ALS REQUIRED CHECK GECONFIGUREERD. Dat is niet alleen een afspraak in
 * `CONTROL/AUTOCODING/README.md`: de finalizerpolicy WEIGERT een `required_checks`-lijst waarin de
 * diagnostische context voorkomt (`assertMergeFinalizerPolicySafe`), dus kan het beleid zichzelf hier
 * niet opnieuw van afhankelijk maken.
 *
 * Wat wél gebleven is, is de convergentie-eigenschap. De uitspraak is een pure functie van de
 * API-momentopname en niet van het event, dus produceren Codex-na-Gemini, Gemini-na-Codex, een edit,
 * een delete en een dismiss byte-identiek dezelfde status. En er is geen pad dat zwijgt: alles wat
 * geen schone meting is — parsefout, API-truncatie, ontbrekend bewijs, uitvoeringsfout — schrijft
 * `failure` op precies dezelfde head.
 *
 * De omschrijving bevat uitsluitend redencodes uit een gesloten allowlist; nooit ruwe stderr, een
 * URL, een pad, een modelnaam of bewijsinhoud. De codes worden gesorteerd zodat twee runs met
 * dezelfde bevindingen ook dezelfde tekst schrijven.
 */

import { pathToFileURL } from 'node:url';

import { REASON } from './verify-review-gate.mjs';

const SHA_RE = /^[0-9a-f]{40}$/;
const REPOSITORY_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** GitHub accepteert een statuscontext van maximaal 255 tekens. */
export const STATUS_CONTEXT_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
/** GitHub kapt `description` af op 140 tekens; we kappen zelf, op codegrens. */
export const DESCRIPTION_LIMIT = 140;

/**
 * Fouten die buiten de beslisser zelf ontstaan. Ook dit is een gesloten allowlist van vaste
 * literalen: een uitvoeringsfout mag onherkenbaar worden gereduceerd tot zijn categorie, maar de
 * categorie moet het terminale bericht halen.
 */
export const PUBLISH_ERROR = Object.freeze({
  GATE_EXECUTION_ERROR: 'GATE_EXECUTION_ERROR',
  GATE_RESULT_UNREADABLE: 'GATE_RESULT_UNREADABLE',
  HEAD_UNMEASURED: 'HEAD_UNMEASURED',
  /**
   * De laatste poort vóór het netwerk. Een publicatie met een state buiten `PUBLISHABLE_STATES`
   * wordt niet verzonden — niet gecorrigeerd, niet gedegradeerd, niet gelogd met inhoud. Deze code
   * bestaat opdat een mutant die ergens weer `success` laat ontstaan mechanisch stukloopt in plaats
   * van een herbruikbaar groen artefact op een gedeelde commit achter te laten.
   */
  STATUS_STATE_NOT_ALLOWED: 'STATUS_STATE_NOT_ALLOWED',
  STATUS_CONTEXT_INVALID: 'STATUS_CONTEXT_INVALID',
  REPOSITORY_INVALID: 'REPOSITORY_INVALID',
  STATUS_TRANSPORT_ERROR: 'STATUS_TRANSPORT_ERROR',
  UNRECOGNISED_REASON: 'UNRECOGNISED_REASON',
  UNSPECIFIED: 'UNSPECIFIED',
  ARGUMENTS_INVALID: 'ARGUMENTS_INVALID',
});

const KNOWN_CODES = new Set([...Object.values(REASON), ...Object.values(PUBLISH_ERROR)]);

/**
 * Bouwt de omschrijving uit gesorteerde, allowlisted codes. Onbekende codes worden niet doorgegeven
 * maar evenmin verzwegen: ze worden vervangen door de vaste literal `UNRECOGNISED_REASON`, zodat er
 * nooit een leeg of misleidend "clean" bericht ontstaat.
 */
export function describeReasons(codes, limit = DESCRIPTION_LIMIT) {
  const list = Array.isArray(codes) ? codes : [];
  const known = new Set();
  let sawUnknown = false;
  for (const code of list) {
    if (typeof code === 'string' && KNOWN_CODES.has(code)) known.add(code);
    else sawUnknown = true;
  }
  if (sawUnknown) known.add(PUBLISH_ERROR.UNRECOGNISED_REASON);
  if (known.size === 0) known.add(PUBLISH_ERROR.UNSPECIFIED);

  // `limit` is uitsluitend een TESTHAAK op dezelfde functie: de productieaanroep laat hem staan op
  // `DESCRIPTION_LIMIT`. Hij bestaat zodat de afkap- en telgrens met de ECHTE functie beproefd kan
  // worden in plaats van met een nabouw.
  const max = Number.isInteger(limit) && limit > 0 ? limit : DESCRIPTION_LIMIT;
  const sorted = Array.from(known).sort();
  const prefix = 'NO_GO: ';
  const kept = [];
  let length = prefix.length;
  for (const code of sorted) {
    const cost = kept.length === 0 ? code.length : code.length + 1;
    if (length + cost > max) break;
    kept.push(code);
    length += cost;
  }
  if (kept.length === sorted.length) return prefix + kept.join(',');

  // De "+N"-teller telt de codes die NIET in het bericht staan, dus verandert hij bij iedere pop.
  // Hij een keer vooraf berekenen was de fout uit bevinding `3835177564`: elke pop verwijdert nog
  // een code, dus werd `+1` gemeld terwijl er twee waren weggelaten. De teller kan bovendien zelf
  // langer worden (`+9` -> `+10`), waardoor de lengtetoets met een verouderde teller rekende. Hij
  // wordt daarom binnen de lus telkens opnieuw afgeleid uit het WERKELIJKE verschil, en de toets
  // meet de string die ook echt gepubliceerd wordt.
  const counterFor = () => `+${sorted.length - kept.length}`;
  const rendered = () => prefix + [...kept, counterFor()].join(',');
  while (kept.length > 0 && rendered().length > max) kept.pop();
  return rendered();
}

/**
 * DE GESLOTEN VERZAMELING STATES DIE DEZE ROUTE MAG SCHRIJVEN.
 *
 * `success` staat er met opzet NIET in, en dat is de hele V18-reparatie in één constante. Een
 * `success` op een commit is overdraagbaar naar iedere pull request die diezelfde commit als head
 * krijgt — ook een pull request die pas ná de meting wordt geopend. `pending` en `failure` zijn dat
 * evengoed, maar zij kunnen niets toestaan: wie ze erft, erft een niet-uitspraak of een weigering.
 * Overdraagbaarheid is alleen gevaarlijk in de toestemmende richting.
 */
export const PUBLISHABLE_STATES = Object.freeze(['pending', 'failure']);

/**
 * De vaste omschrijving voor een gemeten GO. Zij bestaat omdat zwijgen erger zou zijn: zonder deze
 * publicatie zou een head na een schone meting de `failure` van de vorige ronde blijven dragen, en
 * dan wijst de diagnostiek een lezer op bewijs dat er niet meer is.
 *
 * De tekst zegt uitdrukkelijk wat deze status NIET is. Er is geen state waarin GitHub "gemeten en
 * schoon, maar niet autoriserend" kan uitdrukken, dus wordt het `pending` — de state die het dichtst
 * bij "hier staat geen uitspraak" ligt — met de betekenis in de omschrijving.
 */
export const DIAGNOSTIC_GO_DESCRIPTION = 'MEASURED_GO: diagnostic only, not a merge authorization';

/**
 * Zet de gemeten head, de poortuitspraak en een eventuele uitvoeringsfout om naar precies de
 * commitstatus die gepubliceerd moet worden. Pure functie: geen IO, geen event, geen tijd.
 *
 * Er is GEEN pad naar `success`. Een bewezen GO levert `pending` met een vaste diagnostische
 * omschrijving; elke andere uitkomst — NO_GO, parsefout, truncatie, ontbrekend bewijs,
 * uitvoeringsfout, onleesbaar resultaat — levert `failure` op dezelfde head. De mergeautorisatie
 * leeft in `scripts/autocoding/finalize-merge.mjs` en laat op de commit niets achter dat een andere
 * pull request kan erven.
 */
export function resolvePublication({ headSha, statusContext, gateResult, executionError }) {
  if (!SHA_RE.test(headSha ?? '')) {
    return { ok: false, blocked: PUBLISH_ERROR.HEAD_UNMEASURED };
  }
  if (!STATUS_CONTEXT_RE.test(statusContext ?? '')) {
    return { ok: false, blocked: PUBLISH_ERROR.STATUS_CONTEXT_INVALID };
  }

  const error = typeof executionError === 'string' && executionError.length > 0 ? executionError : null;
  const decision = gateResult?.decision;
  const reasons = Array.isArray(gateResult?.reasons) ? gateResult.reasons : [];

  if (!error && decision === 'GO' && reasons.length === 0) {
    return {
      ok: true,
      sha: headSha,
      context: statusContext,
      state: 'pending',
      description: DIAGNOSTIC_GO_DESCRIPTION,
    };
  }

  const codes = [...reasons];
  if (error) codes.push(error);
  if (!error && decision !== 'NO_GO' && decision !== 'GO') codes.push(PUBLISH_ERROR.GATE_RESULT_UNREADABLE);
  return {
    ok: true,
    sha: headSha,
    context: statusContext,
    state: 'failure',
    description: describeReasons(codes),
  };
}

/**
 * De VASTE invalidatiestatus. Hij wordt vóór elke detailmeting op iedere geldig gemeten head van de
 * volledige open-PR-lijst geschreven, onder exact dezelfde context als de uitspraak zelf.
 *
 * Waarom dit bestaat. De writerlock houdt per groep hooguit één WACHTENDE run aan; een nieuwe
 * aanleiding annuleert die wachtende run. De invalidatie die zo'n geannuleerde run had moeten doen,
 * was daarmee weg — en een eerder gepubliceerde uitspraak bleef staan tot de volgende uurlijkse
 * ronde. Door iedere overlevende writer de gemeten head eerst op `pending` te zetten, draagt hij de
 * invalidaties van elke geannuleerde voorganger vanzelf mee: er valt niets meer te verliezen, want
 * de status die verloren kon gaan is al weg.
 *
 * Sinds V18 kan er geen `success` meer staan om te verdringen. Wat hier wordt weggehaald is een
 * `failure` of een `pending` van een vorige beurt, en dat is nog steeds de moeite: een oude rode
 * diagnose die als actueel oordeel blijft staan terwijl deze beurt meet, wijst een lezer naar bewijs
 * dat er misschien niet meer is.
 *
 * `pending` en niet `failure`: dit is geen uitspraak over het bewijs maar de expliciete afwezigheid
 * van een uitspraak over deze head. Deze context is geen required check en autoriseert niets, dus
 * gaat het verschil alleen over wat een lezer eraan afleest — en dan hoort "ik meet nog" niet als
 * "ik heb iets gevonden" te lezen.
 */
export const PENDING_PUBLICATION = Object.freeze({
  state: 'pending',
  description: 'PENDING: re-measuring native two-vendor review on this head',
});

/**
 * Zet een gemeten head om naar de vaste pendingstatus. Zelfde poortwachters als de uitspraak: geen
 * geldige head of geen geldige context betekent niet publiceren, nooit een gok.
 */
export function resolvePendingPublication({ headSha, statusContext }) {
  if (!SHA_RE.test(headSha ?? '')) {
    return { ok: false, blocked: PUBLISH_ERROR.HEAD_UNMEASURED };
  }
  if (!STATUS_CONTEXT_RE.test(statusContext ?? '')) {
    return { ok: false, blocked: PUBLISH_ERROR.STATUS_CONTEXT_INVALID };
  }
  return {
    ok: true,
    sha: headSha,
    context: statusContext,
    state: PENDING_PUBLICATION.state,
    description: PENDING_PUBLICATION.description,
  };
}

/**
 * Publiceert de commitstatus. De enige schrijfactie in de hele shield, en de enige reden dat de
 * trusted job `statuses: write` heeft. Er wordt niets van het antwoord gelogd behalve de HTTP-code.
 *
 * Transportfouten worden hier volledig ingesloten. Een DNS-fout, een afgebroken TLS-verbinding, een
 * timeout of een ontbrekende `fetch` laat `fetch` gooien (of, bij een synchroon falende impl,
 * meteen throwen) — zonder deze afvang eindigde de CLI in een onafgevangen promise-rejection, met
 * een stacktrace en mogelijk verzoekdetails in het joblog. Elke zo'n fout wordt daarom gereduceerd
 * tot ÉÉN vaste categorie: `STATUS_TRANSPORT_ERROR`. De exceptietekst wordt niet gelezen, niet
 * doorgegeven en niet gelogd.
 *
 * Wat dit uitdrukkelijk NIET doet: het herstelt de status niet. Faalt de POST, dan blijft een
 * eerdere status van deze context op deze head onaangeroerd staan — die kan dus ouder bewijs
 * weerspiegelen. De run wordt daarvan wel rood (rc 1). Het restrisico is beperkt tot wat een lezer
 * ziet: een verouderde diagnose blijft tijdens een API-storing zichtbaar. Er kan niets groens
 * blijven staan, want deze route publiceert geen `success` en deze context is nergens vereist. Dat
 * is bewust: deze poort kan met `statuses: write` alleen schrijven, en een status die niet
 * geschreven kan worden kan ook niet ingetrokken worden.
 */
export async function publishStatus({ repository, publication, token, fetchImpl }) {
  if (!REPOSITORY_RE.test(repository ?? '')) {
    return { ok: false, blocked: PUBLISH_ERROR.REPOSITORY_INVALID };
  }
  // In de CLI-lus komt `publication` altijd uit `resolvePublication` of `resolvePendingPublication`,
  // en die dwingen de volledige head al af. Deze functie is echter ook los aanroepbaar, en dan was
  // `publication.sha` een ONBEWAAKTE property-read met twee verschillende gevolgen, allebei fout:
  //
  //   - `null` of `undefined` gooide een TypeError. Die viel binnen de transportafvang hieronder en
  //     kwam er dus uit als `STATUS_TRANSPORT_ERROR` — een netwerkdiagnose voor een aanroepfout.
  //   - Een object ZONDER geldige sha gooide niets: de URL werd letterlijk opgebouwd met `undefined`
  //     of met de meegegeven tekst, en er ging een echte POST naar api.github.com. Bij een sha met
  //     `/` of `..` erin wijst dat pad bovendien niet meer naar het statuseindpunt van deze head.
  //
  // Daarom eerst valideren, dan pas lezen. De uitkomst is dezelfde vaste code die de resolvers voor
  // een ongemeten head gebruiken, zodat een ontbrekende head overal één naam heeft.
  if (!publication || typeof publication !== 'object' || Array.isArray(publication)
    || !SHA_RE.test(publication.sha ?? '')) {
    return { ok: false, blocked: PUBLISH_ERROR.HEAD_UNMEASURED };
  }
  // DE LAATSTE POORT VÓÓR HET NETWERK. `resolvePublication` en `resolvePendingPublication` kunnen
  // vandaag geen `success` produceren, maar deze functie is los aanroepbaar en de resolvers zijn
  // bewerkbaar. Zonder deze toets zou één regel elders volstaan om weer een herbruikbaar groen
  // artefact op een gedeelde commit te zetten. De weigering staat vóór `fetch`, dus een mutant die
  // `success` terugbrengt doet nul verzoeken in plaats van één te veel.
  if (!PUBLISHABLE_STATES.includes(publication.state)) {
    return { ok: false, blocked: PUBLISH_ERROR.STATUS_STATE_NOT_ALLOWED };
  }
  let response;
  try {
    const doFetch = fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== 'function') throw new Error(PUBLISH_ERROR.STATUS_TRANSPORT_ERROR);
    response = await doFetch(
      `https://api.github.com/repos/${repository}/statuses/${publication.sha}`,
      {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'autocoding-shield',
          'x-github-api-version': '2022-11-28',
        },
        body: JSON.stringify({
          state: publication.state,
          context: publication.context,
          description: publication.description,
        }),
      },
    );
  } catch {
    return { ok: false, blocked: PUBLISH_ERROR.STATUS_TRANSPORT_ERROR };
  }
  return { ok: response?.status === 201, status: response?.status ?? 0 };
}

/** Vlaggen zonder waarde. Hun POSITIE in argv mag niets aan de betekenis van de rest veranderen. */
export const PUBLISH_BOOLEAN_FLAGS = Object.freeze(['--dry-run', '--pending']);

/**
 * De sleutels die in pendingmodus GEEN betekenis hebben. De pendingstatus is per definitie de
 * afwezigheid van een uitspraak, dus zou een meegegeven poortresultaat of uitvoeringsfout stil
 * genegeerd worden. Stil negeren is precies het soort herinterpretatie dat deze parser weigert:
 * `--pending` samen met een van deze sleutels is een gesloten vorm die niet bestaat.
 */
export const PENDING_INCOMPATIBLE_OPTIONS = Object.freeze(['--gate-result', '--execution-error']);

/** Sleutels die precies één waarde nemen. Een lege waarde is geldig; een ontbrekende nooit. */
export const PUBLISH_VALUE_OPTIONS = Object.freeze([
  '--repository', '--head-sha', '--status-context', '--gate-result', '--execution-error',
]);

/**
 * Parst argv token voor token in plaats van in VASTE PAREN.
 *
 * De paarlezing (`for (i = 0; i < argv.length; i += 2)`) was positieafhankelijk: één losse
 * booleaanse vlag middenin de lijst verschoof elk volgend key/valuepaar met één plek, waardoor
 * `--head-sha` de waarde van `--status-context` kreeg en de laatste sleutel zijn waarde verloor. Dat
 * verschoof STIL — de vlaggen bleven herkenbaar, alleen de bindingen klopten niet meer.
 *
 * Deze parser is daarom positie-onafhankelijk én fail-closed: een onbekend argument, een dubbel
 * opgegeven sleutel of vlag, een sleutel zonder waarde en een waarde die zelf een bekende sleutel of
 * vlag is, leveren allemaal een weigering op in plaats van een stilzwijgende herinterpretatie.
 */
export function parsePublishArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const flags = new Set(PUBLISH_BOOLEAN_FLAGS);
  const options = new Set(PUBLISH_VALUE_OPTIONS);
  const values = new Map();
  const seenFlags = new Set();
  const reject = { ok: false, error: PUBLISH_ERROR.ARGUMENTS_INVALID };

  for (let i = 0; i < list.length; i += 1) {
    const token = list[i];
    if (typeof token !== 'string') return reject;
    if (flags.has(token)) {
      if (seenFlags.has(token)) return reject;
      seenFlags.add(token);
      continue;
    }
    if (!options.has(token)) return reject;
    if (values.has(token)) return reject;
    i += 1;
    const value = list[i];
    // De lege string is een LEGITIEME waarde: de workflow geeft `--execution-error ""` door zodra er
    // geen uitvoeringsfout is. Ontbreken is iets anders dan leeg zijn.
    if (typeof value !== 'string') return reject;
    if (flags.has(value) || options.has(value)) return reject;
    values.set(token, value);
  }
  const pending = seenFlags.has('--pending');
  if (pending && PENDING_INCOMPATIBLE_OPTIONS.some((option) => values.has(option))) return reject;
  return { ok: true, values, dryRun: seenFlags.has('--dry-run'), pending };
}

/**
 * De CLI-lus. Twee modi, allebei met dezelfde harde regel: rc 0 uitsluitend als de bedoelde status
 * WERKELIJK is geplaatst.
 *
 *   - Zonder `--pending`: de diagnostiek. rc 0 alleen wanneer de gemeten GO als `pending` is
 *     geplaatst; een `failure` — dus elke NO_GO, parsefout of uitvoeringsfout — geeft rc 1, zodat de
 *     run rood is en er geen stille groene beurt bestaat. rc 0 is hier GEEN autorisatie: hij zegt
 *     alleen dat de bedoelde diagnostische status op de gemeten head staat.
 *   - Met `--pending`: de invalidatie. rc 0 alleen als de `pending`-status is geaccepteerd.
 */
export async function runPublish(argv, { fetchImpl, readFile } = {}) {
  const parsed = parsePublishArgs(argv);
  if (!parsed.ok) {
    console.log(`LIVE_STATUS_NOT_PUBLISHABLE_${PUBLISH_ERROR.ARGUMENTS_INVALID}`);
    return 1;
  }
  const { values: args, dryRun, pending } = parsed;

  const repository = args.get('--repository') ?? '';
  const headSha = args.get('--head-sha') ?? '';
  const statusContext = args.get('--status-context') ?? '';
  const resultPath = args.get('--gate-result') ?? '';
  let executionError = args.get('--execution-error') ?? '';

  if (pending) {
    const invalidation = resolvePendingPublication({ headSha, statusContext });
    if (!invalidation.ok) {
      console.log(`LIVE_STATUS_PENDING_NOT_PUBLISHABLE_${invalidation.blocked}`);
      return 1;
    }
    if (dryRun) {
      console.log(JSON.stringify(invalidation));
      return 0;
    }
    const invalidated = await publishStatus({
      repository, publication: invalidation, token: process.env.GITHUB_TOKEN, fetchImpl,
    });
    if (!invalidated.ok) {
      console.log(`LIVE_STATUS_PENDING_POST_REJECTED_${invalidated.blocked ?? invalidated.status}`);
      return 1;
    }
    console.log('LIVE_STATUS_PENDING_PUBLISHED');
    return 0;
  }

  let gateResult = null;
  if (resultPath) {
    try {
      if (typeof readFile !== 'function') throw new Error(PUBLISH_ERROR.GATE_RESULT_UNREADABLE);
      gateResult = JSON.parse(readFile(resultPath));
    } catch {
      gateResult = null;
      if (!executionError) executionError = PUBLISH_ERROR.GATE_RESULT_UNREADABLE;
    }
  } else if (!executionError) {
    executionError = PUBLISH_ERROR.GATE_RESULT_UNREADABLE;
  }

  const publication = resolvePublication({ headSha, statusContext, gateResult, executionError });
  if (!publication.ok) {
    console.log(`LIVE_STATUS_NOT_PUBLISHABLE_${publication.blocked}`);
    return 1;
  }

  if (dryRun) {
    console.log(JSON.stringify(publication));
    return publication.state === 'pending' ? 0 : 1;
  }

  const posted = await publishStatus({
    repository, publication, token: process.env.GITHUB_TOKEN, fetchImpl,
  });
  if (!posted.ok) {
    console.log(`LIVE_STATUS_POST_REJECTED_${posted.blocked ?? posted.status}`);
    return 1;
  }
  console.log(`LIVE_STATUS_PUBLISHED_${publication.state.toUpperCase()}`);
  return publication.state === 'pending' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFileSync } = await import('node:fs');
  process.exitCode = await runPublish(process.argv.slice(2), {
    readFile: (path) => readFileSync(path, 'utf8'),
  });
}
