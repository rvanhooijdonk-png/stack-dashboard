// AUTOCODING_SHIELD — KANDIDAATSELECTIE VOOR DE MERGEFINALIZER.
//
// DIT IS SELECTIE, GEEN AUTORISATIE. Het onderscheid is de hele reden dat dit bestand los staat van
// `finalize-merge.mjs`, en het is ook het antwoord op Codex-bevinding `3835364974` over de
// offsetgepagineerde open-PR-lijst.
//
// Die bevinding klopt: een lijst die per offset wordt gepagineerd is geen atomaire momentopname. Een
// invoeging tijdens het pagineren verschuift de rest, dus kan er een pull request tussenuit vallen.
// In V17 was dat dodelijk, want die lijst DROEG toen de autorisatie: als hij een tweede drager van
// dezelfde head niet zag, werd er ten onrechte groen gepubliceerd. Hier draagt hij niets. Wat deze
// lijst hoogstens veroorzaakt is dat een kandidaat deze ronde niet wordt bekeken — en dan gebeurt er
// niets, wat precies de fail-closed richting is. Elke kandidaat die wél doorkomt wordt vervolgens
// uitsluitend op zijn EIGEN hermeten bewijs beoordeeld; deze lijst levert alleen het nummer.
//
// Wat hier bewust NIET wordt gedaan: bewijs beoordelen, reviews lezen, autorisaties uitleggen. De
// filters hieronder zijn goedkope vooruitzichten die verzoeken besparen, geen poort. Alles wat ze
// doorlaten wordt in `resolveFinalization` opnieuw en volledig getoetst.

import {
  FINALIZE_REASON,
  FINALIZER_PER_CANDIDATE_REQUEST_BUDGET,
  assertMergeFinalizerPolicySafe,
} from './finalize-merge.mjs';
import { flattenPages } from './collect-shield-input.mjs';
import {
  SHARED_HOURLY_REQUEST_QUOTA, QUOTA_RESERVE, SELECTION_PAGE_BUDGET, parseCounter,
  scheduleSlotOf, selectScheduleBucket, scheduleBucketVisit, selectBucketWindow,
  affordablePullRequests,
} from './select-live-gate-targets.mjs';

export const CANDIDATE_REASON = Object.freeze({
  FINALIZER_DISABLED: FINALIZE_REASON.FINALIZER_DISABLED,
  FINALIZER_POLICY_UNSAFE: FINALIZE_REASON.FINALIZER_POLICY_UNSAFE,
  ARGUMENTS_INVALID: FINALIZE_REASON.ARGUMENTS_INVALID,
  OPEN_PULL_REQUESTS_UNREADABLE: 'OPEN_PULL_REQUESTS_UNREADABLE',
  OPEN_PULL_REQUESTS_TRUNCATED: 'OPEN_PULL_REQUESTS_TRUNCATED',
  NO_CANDIDATES: 'NO_CANDIDATES',
  SCHEDULE_SLOT_UNUSABLE: 'SCHEDULE_SLOT_UNUSABLE',
  API_QUOTA_UNKNOWN: 'API_QUOTA_UNKNOWN',
  API_BUDGET_RESERVED: 'API_BUDGET_RESERVED',
});

/**
 * Kiest de kandidaten van deze ronde.
 *
 * Een AFGEKAPTE lijst levert nul kandidaten op en niet "wat we toevallig zagen". Niet omdat een
 * gemiste kandidaat gevaarlijk is — dat is hij niet, hij wordt gewoon niet gefinaliseerd — maar
 * omdat een halve lijst als volledige ronde behandelen de rotatie stil onvolledig maakt terwijl de
 * run groen oogt.
 *
 * CODEX `3835523942` (P2). Vóór V19 werd hier een vaste PREFIX van de GitHub-volgorde genomen
 * (`.slice(0, candidate_limit)`). Zolang er meer dan `candidate_limit` in aanmerking komende pull
 * requests open blijven staan, verhongert alles ná die prefix voor onbepaalde tijd: dezelfde eerste
 * paar nummers winnen elke ronde opnieuw. Er is daarom GEEN vaste prefix meer. In plaats daarvan
 * wordt de STABIELE, GESORTEERDE (op PR-nummer, niet op GitHub-volgorde) verzameling in aanmerking
 * komende nummers verdeeld in vaste emmers ter grootte van `SCHEDULE_BUCKET_LIMIT`
 * (`select-live-gate-targets.mjs`, dezelfde constante als de diagnostische route), en wordt per ronde
 * exact één emmer bezocht — welke, bepaald door een TIJDSLOT, niet door een lokaal
 * voortgangsbestand. Bij een vaste emmergrootte en een aantal emmers `count` bezoekt slot `s`
 * dezelfde emmer als slot `s + count`, dus doorloopt elke ronde uiterlijk na `count` sloten de
 * volledige verzameling — ongeacht welke ronde toevallig als eerste draait, en zonder dat er ergens
 * een voortgangsbestand hoeft te bestaan dat kan verdwijnen, corrumperen of dubbel gebruikt worden.
 *
 * `candidate_limit` blijft bestaan, maar krijgt een ANDERE rol dan vroeger: het is niet langer de
 * partitiegrootte maar uitsluitend de CAPACITEIT van het venster binnen de gekozen emmer — exact
 * dezelfde scheiding als bevinding `3835186656` al voor de doelenselector afdwong, en om dezelfde
 * reden: zou `candidate_limit` de indeling zelf bepalen, dan verschuiven de emmergrenzen zodra een
 * operator die waarde in de policy wijzigt, en begint de rotatie stilzwijgend opnieuw.
 *
 * `nowEpochSeconds` moet een gehele, niet-negatieve seconde-teller zijn. Onleesbare of ontbrekende
 * tijd is ONBEKEND en niet "sloot nul": een sloot-nul-fallback zou stilzwijgend altijd dezelfde
 * eerste emmer bevoordelen zodra de klok een keer onleesbaar is, en dat is exact dezelfde
 * verhongering in een nieuwe vermomming.
 *
 * CODEX `3835810736`. Vóór V20 kreeg `selectBucketWindow` hier alleen `candidate_limit` als
 * capaciteit; het quotum werd DAARNA, in een aparte functie (`fitCandidatesToQuota`), als een platte
 * `.slice(0, passend)`-voorvoegsel op het AL GEROTEERDE en AL GESORTEERDE venster toegepast. Die
 * tweede stap negeerde het anker volledig: welk lid van het venster ook het ronde-anker was, de
 * quotumslice pakte altijd de LAAGSTE nummers van het venster — en omdat een gewrapt venster
 * (bijvoorbeeld `[1, 22, 23, 24, 25]`) bijna altijd een laag nummer bevat, won dat lage nummer bij
 * een krap quotum elke ronde opnieuw. Bij `candidate_limit=5` en quotum-voor-1 bleven de PR's 22-25
 * daardoor blijvend verhongerd, ondanks de tijdslotrotatie eronder.
 *
 * Het quotum wordt daarom hier, in DEZELFDE stap als `candidate_limit`, in de capaciteit gevouwen —
 * exact het patroon van `selectTargets()` in `select-live-gate-targets.mjs`
 * (`Math.min(bucket.length, affordable)`, vóór `selectBucketWindow`). Zo bepaalt het anker zelf,
 * niet een sorteervolgorde erna, welk lid bij een capaciteit van 1 wordt gekozen — en schuift dat
 * ene lid gewoon met de rotatie mee.
 */
export function selectFinalizationCandidates({
  openPulls, openPullsComplete, policy, nowEpochSeconds, remainingQuota = null,
}) {
  if (policy?.merge_finalizer_enabled !== true) {
    return { ok: false, candidates: [], reasons: [CANDIDATE_REASON.FINALIZER_DISABLED] };
  }
  try {
    assertMergeFinalizerPolicySafe(policy);
  } catch {
    return { ok: false, candidates: [], reasons: [CANDIDATE_REASON.FINALIZER_POLICY_UNSAFE] };
  }
  if (openPullsComplete !== true) {
    return { ok: false, candidates: [], reasons: [CANDIDATE_REASON.OPEN_PULL_REQUESTS_TRUNCATED] };
  }
  const slot = scheduleSlotOf(nowEpochSeconds);
  if (slot === null) {
    return { ok: false, candidates: [], reasons: [CANDIDATE_REASON.SCHEDULE_SLOT_UNUSABLE] };
  }
  const cfg = policy.merge_finalizer;
  const lijst = flattenPages(openPulls);
  const inAanmerking = Array.from(new Set(lijst
    .filter((pr) => pr?.state === 'open' && pr?.draft !== true && pr?.merged !== true)
    .filter((pr) => cfg.allowed_base_refs.includes(pr?.base?.ref))
    .filter((pr) => cfg.allowed_builder_actors.includes(pr?.user?.login))
    .map((pr) => (Number.isInteger(pr?.number) && pr.number > 0 ? pr.number : 0))
    .filter((n) => n > 0)))
    .sort((a, b) => a - b);

  if (inAanmerking.length === 0) {
    return { ok: false, candidates: [], reasons: [CANDIDATE_REASON.NO_CANDIDATES] };
  }

  // De INDELING blijft QUOTUM- en LIMIETVRIJ: `selectScheduleBucket` krijgt hier expres geen derde
  // argument, dus valt hij terug op de vaste `SCHEDULE_BUCKET_LIMIT`. Alleen de CAPACITEIT van het
  // venster erbinnen hangt af van `candidate_limit` én van het quotum — en dat gebeurt in ÉÉN stap
  // vóór `selectBucketWindow`, nooit erna.
  const { bucket, count } = selectScheduleBucket(inAanmerking, slot);

  // DEZELFDE strenge lezer als de doelenselector: een quotum groter dan de totale gedeelde
  // uurlimiet is geen ruim quotum maar een onaannemelijke meting, en telt daarom als ONBEKEND —
  // exact de bovengrenstoets die vóór V20 in `fitCandidatesToQuota` stond.
  if (!Number.isInteger(remainingQuota) || remainingQuota < 0
    || remainingQuota > SHARED_HOURLY_REQUEST_QUOTA) {
    return { ok: false, candidates: [], reasons: [CANDIDATE_REASON.API_QUOTA_UNKNOWN] };
  }
  const affordable = affordablePullRequests(remainingQuota, {
    perPullRequest: FINALIZER_PER_CANDIDATE_REQUEST_BUDGET,
    reserve: QUOTA_RESERVE,
    selectionCost: SELECTION_PAGE_BUDGET,
  });

  const capaciteit = Math.min(bucket.length, cfg.candidate_limit, affordable);
  if (capaciteit < 1) {
    return { ok: false, candidates: [], reasons: [CANDIDATE_REASON.API_BUDGET_RESERVED] };
  }

  const bezoek = scheduleBucketVisit(slot, count);
  const { window } = selectBucketWindow(bucket, bezoek, capaciteit);

  if (window.length === 0) {
    return { ok: false, candidates: [], reasons: [CANDIDATE_REASON.NO_CANDIDATES] };
  }
  return { ok: true, candidates: window, reasons: [] };
}

/** Sleutels die precies één niet-lege waarde nemen. */
export const CANDIDATE_VALUE_OPTIONS = Object.freeze([
  '--open-pulls', '--open-pulls-complete', '--policy', '--remaining-quota', '--now-epoch', '--out',
]);

/** Dezelfde fail-closed, positie-onafhankelijke argumentlezing als elders in deze poort. */
export function parseCandidateArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const options = new Set(CANDIDATE_VALUE_OPTIONS);
  const values = new Map();
  const reject = { ok: false, error: CANDIDATE_REASON.ARGUMENTS_INVALID };

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
  for (const option of CANDIDATE_VALUE_OPTIONS) {
    if (!values.has(option)) return reject;
  }
  const compleet = values.get('--open-pulls-complete');
  if (compleet !== 'true' && compleet !== 'false') return reject;
  return { ok: true, values, openPullsComplete: compleet === 'true' };
}

/**
 * De CLI. Schrijft ALTIJD een geldige JSON-array naar `--out`, ook bij een weigering: de workflow
 * leest dat bestand onvoorwaardelijk als matrixbron, en een ontbrekend bestand zou daar een
 * onduidelijke fout opleveren in plaats van een lege ronde.
 *
 *   rc 0 — er zijn kandidaten, of er is een normale reden om er geen te hebben.
 *   rc 1 — de invoer of de policy was onbruikbaar.
 */
export function runSelectCandidates(argv, { readFile, writeFile } = {}) {
  const parsed = parseCandidateArgs(argv);
  const meld = (reasons) => console.log(reasons.join(' '));
  // Zonder geldige argumenten is er geen `--out` om naartoe te schrijven. De workflow maakt het
  // bestand daarom zelf al leeg aan vóór deze aanroep, zodat een weigering hier nooit een ontbrekend
  // matrixbestand achterlaat.
  if (!parsed.ok) {
    meld([CANDIDATE_REASON.ARGUMENTS_INVALID]);
    return 1;
  }
  const args = parsed.values;
  const schrijf = (lijst) => {
    if (typeof writeFile !== 'function') return;
    writeFile(args.get('--out'), JSON.stringify(lijst));
  };

  let policy;
  let openPulls;
  try {
    if (typeof readFile !== 'function') throw new Error(CANDIDATE_REASON.ARGUMENTS_INVALID);
    policy = JSON.parse(readFile(args.get('--policy')));
    openPulls = JSON.parse(readFile(args.get('--open-pulls')));
  } catch {
    schrijf([]);
    meld([CANDIDATE_REASON.OPEN_PULL_REQUESTS_UNREADABLE]);
    return 1;
  }

  const gekozen = selectFinalizationCandidates({
    openPulls,
    openPullsComplete: parsed.openPullsComplete,
    policy,
    nowEpochSeconds: parseCounter(args.get('--now-epoch')),
    remainingQuota: parseCounter(args.get('--remaining-quota')),
  });
  schrijf(gekozen.candidates);
  if (!gekozen.ok) {
    meld(gekozen.reasons);
    return 0;
  }
  meld(['CANDIDATES_SELECTED']);
  return 0;
}

// Alleen bij directe aanroep. Bij `import` mag hier niets draaien: de tests importeren dit bestand.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync, writeFileSync } = await import('node:fs');
  process.exitCode = runSelectCandidates(process.argv.slice(2), {
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, d) => writeFileSync(p, d),
  });
}
