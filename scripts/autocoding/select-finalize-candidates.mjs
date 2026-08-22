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
  assertMergeFinalizerPolicySafe,
  finalizerRequestBudget,
} from './finalize-merge.mjs';
import { flattenPages } from './collect-shield-input.mjs';
import {
  SHARED_HOURLY_REQUEST_QUOTA, QUOTA_RESERVE, parseCounter,
} from './select-live-gate-targets.mjs';

export const CANDIDATE_REASON = Object.freeze({
  FINALIZER_DISABLED: FINALIZE_REASON.FINALIZER_DISABLED,
  FINALIZER_POLICY_UNSAFE: FINALIZE_REASON.FINALIZER_POLICY_UNSAFE,
  ARGUMENTS_INVALID: FINALIZE_REASON.ARGUMENTS_INVALID,
  OPEN_PULL_REQUESTS_UNREADABLE: 'OPEN_PULL_REQUESTS_UNREADABLE',
  OPEN_PULL_REQUESTS_TRUNCATED: 'OPEN_PULL_REQUESTS_TRUNCATED',
  NO_CANDIDATES: 'NO_CANDIDATES',
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
 * De volgorde is die van GitHub zelf en wordt niet herschikt: er wordt afgekapt op
 * `candidate_limit`, en dat getal is de bovengrens waarop de budgetsom hieronder rust.
 */
export function selectFinalizationCandidates({ openPulls, openPullsComplete, policy }) {
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
  const cfg = policy.merge_finalizer;
  const lijst = flattenPages(openPulls);
  const kandidaten = lijst
    .filter((pr) => pr?.state === 'open' && pr?.draft !== true && pr?.merged !== true)
    .filter((pr) => cfg.allowed_base_refs.includes(pr?.base?.ref))
    .filter((pr) => cfg.allowed_builder_actors.includes(pr?.user?.login))
    .map((pr) => (Number.isInteger(pr?.number) && pr.number > 0 ? pr.number : 0))
    .filter((n) => n > 0)
    .slice(0, cfg.candidate_limit);

  if (kandidaten.length === 0) {
    return { ok: false, candidates: [], reasons: [CANDIDATE_REASON.NO_CANDIDATES] };
  }
  return { ok: true, candidates: kandidaten, reasons: [] };
}

/**
 * Krimpt de kandidatenlijst op het WERKELIJK resterende gedeelde uurquotum.
 *
 * `-` is de afgesproken ONBEKEND-vorm en betekent hier: geen ronde. De teller waarop de hele
 * begroting rust was onleesbaar, dus valt er niets te begroten — dat is dezelfde lijn als in de
 * targetselector van de diagnostische route.
 *
 * Er wordt gekrompen en niet geweigerd: past er nog één kandidaat binnen het restant min de vaste
 * reserve, dan wordt die ene gedaan. Past er geen enkele, dan doet deze ronde niets.
 */
export function fitCandidatesToQuota(candidates, remainingQuota) {
  const lijst = Array.isArray(candidates) ? candidates : [];
  // DEZELFDE strenge lezer als de doelenselector, en met opzet geen `Number()`. `Number('')` en
  // `Number(' ')` zijn allebei 0, dus zou een leeggevallen meting hier als "nul verzoeken over"
  // binnenkomen: fail-closed, maar met de verkeerde reden. Een onleesbaar quotum is ONBEKEND, niet
  // uitgeput, en die twee horen in het log niet op elkaar te lijken.
  const remaining = parseCounter(remainingQuota);
  if (remaining === null || remaining > SHARED_HOURLY_REQUEST_QUOTA) {
    return { ok: false, candidates: [], reasons: [CANDIDATE_REASON.API_QUOTA_UNKNOWN] };
  }
  const beschikbaar = remaining - QUOTA_RESERVE;
  let passend = 0;
  while (passend < lijst.length && finalizerRequestBudget(passend + 1) <= beschikbaar) {
    passend += 1;
  }
  if (passend === 0) {
    return { ok: false, candidates: [], reasons: [CANDIDATE_REASON.API_BUDGET_RESERVED] };
  }
  return { ok: true, candidates: lijst.slice(0, passend), reasons: [] };
}

/** Sleutels die precies één niet-lege waarde nemen. */
export const CANDIDATE_VALUE_OPTIONS = Object.freeze([
  '--open-pulls', '--open-pulls-complete', '--policy', '--remaining-quota', '--out',
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
    openPulls, openPullsComplete: parsed.openPullsComplete, policy,
  });
  if (!gekozen.ok) {
    schrijf([]);
    meld(gekozen.reasons);
    return 0;
  }
  const passend = fitCandidatesToQuota(gekozen.candidates, args.get('--remaining-quota'));
  schrijf(passend.candidates);
  if (!passend.ok) {
    meld(passend.reasons);
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
