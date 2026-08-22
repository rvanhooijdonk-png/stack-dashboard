/**
 * PANEEL STATUSGEN — vult het gelijknamige slot uit het paneelcontract met de generatie- en
 * buildmetadata van de statuslaag zelf: welke contractversie de plaat bouwde, wanneer hij is
 * gebouwd, welke overall-status eruit kwam, en hoeveel van de gelezen bronnen niet-geverifieerd
 * waren.
 *
 * WAT DIT PANEEL BEWUST NIET DOET (Codex-review 2026-08-22, P1). Een eerdere opzet gaf het
 * bouwstempel een CURRENT/STALE-oordeel: "is deze plaat nog vers?". Dat oordeel is op een
 * statische pagina onmeetbaar en daarmee fail-open. `scripts/build.mjs` zet `generatedAt` op het
 * moment van verzamelen, en de renderer draait milliseconden later — gemeten in de echte build
 * liggen alle acht bronstempels binnen 12 s van `generatedAt`. Elke geslaagde bouw werd dus
 * CURRENT, en juist het geval dat ertoe doet — de bouwketen staat stil — levert helemaal geen
 * nieuwe bouw op: de browser haalt via `<meta http-equiv="refresh">` dezelfde oude HTML op,
 * inclusief het groene CURRENT-vinkje van uren geleden. De STALE-tak kon in productie nooit
 * afgaan en het vinkje zou juist liegen op het moment dat het telt.
 *
 * Daarom oordeelt dit paneel alleen over wat op bouwmoment écht meetbaar is: is het stempel
 * leesbaar (UNKNOWN zo niet), ligt het niet in de toekomst (AFWIJKING zo wel), en hoeveel bronnen
 * zijn niet geverifieerd (GEDEELTELIJK vs VOLLEDIG). Het stempel zelf wordt getoond als feit, met
 * de blinde vlek er expliciet bij, in plaats van overgeschilderd met een oordeel dat de pagina
 * niet kan waarmaken.
 */
import { esc } from './format.mjs';
import { buildStamp } from './render.mjs';
import { parseTijdstempel, FUTURE_SKEW_MS } from './runtime-feed.mjs';

/**
 * De enige trust-waarde die bewijs is. Alles daarbuiten telt als niet-geverifieerd: niet alleen
 * UNVERIFIED/SOURCE_UNAVAILABLE/STALE, maar ook `CONFLICTING_EVIDENCE` uit
 * `contracts/status-json.schema.json`, een lege string, een typefout en elke waarde die het schema
 * later nog krijgt. Allowlist, geen denylist — een onbekende waarde hoort naar de veilige kant te
 * vallen, niet stilzwijgend als bewezen mee te tellen. Dezelfde keuze als de rest van de repo, die
 * overal `trust !== 'VERIFIED_CURRENT'` hanteert. (Codex + Gemini, beide onafhankelijk, P1/P2.)
 */
const BEWEZEN = 'VERIFIED_CURRENT';

/**
 * Telt één bron alleen als bewijs wanneer hij ook de vorm heeft die
 * `contracts/status-json.schema.json` eist: `key`, `trust`, `retrievedAt` en `rijen` zijn daar alle
 * vier verplicht. Een object dat wél `trust: 'VERIFIED_CURRENT'` roept maar de rest mist, is geen
 * geverifieerde bron maar een misvormde regel — en die hoort naar de onbewezen kant, niet naar de
 * groene (Codex, derde ronde). `rijen` mag per schema `null` zijn (PR-tellingen, CI-ampels), maar
 * niet ontbreken.
 */
/**
 * Toetst of een rijentelling logisch kan bestaan. Het schema eist de vier velden en hun type, maar
 * kan hun onderlinge orde niet uitdrukken: `{inBron:1, herkend:2, getoond:3, afgekapt:4}` haalt
 * beide schema's moeiteloos (Codex, vijfde ronde). Een lezer kan niet méér rijen herkennen dan er
 * in de bron stonden, niet meer tonen dan hij herkende, en niet meer afkappen dan hij toonde.
 *
 * De andere richting is bewust géén reden om de bron af te keuren: `herkend < inBron` betekent dat
 * de lezer rijen heeft laten vallen, en dat is per `doorstroom.mjs` een echte, rapporteerbare
 * achterstand — daar heeft de doorstroommeter zijn eigen rode melding voor. Hier telt alleen het
 * onmogelijke, niet het onwelkome.
 */
function rijenZijnMogelijk(rijen) {
  if (rijen === null || rijen === undefined) return true;
  if (typeof rijen !== 'object' || Array.isArray(rijen)) return false;
  const { inBron, herkend, getoond, afgekapt } = rijen;
  const tellingen = [inBron, herkend, getoond, afgekapt];
  if (!tellingen.every((n) => Number.isInteger(n) && n >= 0)) return false;
  return inBron >= herkend && herkend >= getoond && getoond >= afgekapt;
}

function bronIsBewezen(s, referentieMs) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
  if (s.trust !== BEWEZEN) return false;
  if (typeof s.key !== 'string' || s.key === '') return false;
  if (!('rijen' in s) || (s.rijen !== null && typeof s.rijen !== 'object')) return false;
  if (!rijenZijnMogelijk(s.rijen)) return false;
  const opgehaald = parseTijdstempel(s.retrievedAt);
  if (opgehaald === null) return false;
  // Een bron die is opgehaald ná het moment waarop de plaat werd gebouwd, is logisch onmogelijk —
  // en het is precies het soort claim dat een JSON Schema niet kan tegenhouden: gemeten met
  // `contracts/dashboard-snapshot.schema.json` komt een `retrievedAt` van 2099 er gewoon doorheen,
  // terwijl elke andere vormschending daar al wordt geweigerd. Deze kruisveldtoets is dus geen
  // duplicaat van het contract maar het gat erin (Codex + Gemini, vierde ronde).
  if (Number.isFinite(referentieMs) && opgehaald > referentieMs + FUTURE_SKEW_MS) return false;
  return true;
}

/**
 * Leest het bouwstempel. Bewust via de strikte `parseTijdstempel` uit `runtime-feed.mjs` en niet
 * via een kale `new Date(string)`: die normaliseert een onmogelijke kalenderdatum stilzwijgend
 * (`2026-02-30` rolt door naar 2 maart) en leest een string zonder zone als lokale tijd. De repo
 * documenteert die val al bij `kalenderGeldig()`; hier hergebruikt in plaats van herhaald.
 */
function leesStempel(iso, nowMs) {
  // Een onleesbare referentieklok mag nooit stilzwijgend "geldig" opleveren: `NaN` maakt elke
  // vergelijking hieronder `false` en zou anders álles doorlaten (Gemini, P1). `Number.isFinite`
  // alleen is niet genoeg: `1e20` is eindig maar valt buiten het Date-bereik (±8,64e15 ms) en gaf
  // zo alsnog een groen oordeel — vandaar ook de bereiktoets (Codex, tweede ronde).
  if (!Number.isFinite(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) {
    return { status: 'UNKNOWN', reden: 'de referentieklok is onleesbaar' };
  }
  const ms = parseTijdstempel(iso);
  if (ms === null) {
    return { status: 'UNKNOWN', reden: 'geen leesbaar bouwstempel met expliciete tijdzone' };
  }
  if (ms > nowMs + FUTURE_SKEW_MS) {
    return { status: 'AFWIJKING', ms, reden: 'het bouwstempel ligt in de toekomst — deze plaat is niet te vertrouwen' };
  }
  return { status: 'GELDIG', ms, reden: null };
}

/**
 * Berekent de inhoud van het STATUSGEN-paneel. Geeft altijd een object terug; nooit een exception,
 * ook niet op een lege of misvormde snapshot — een paneel dat klapt neemt de hele plaat mee.
 */
export function statusgenPaneel(snapshot, { now = new Date() } = {}) {
  const snap = (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) ? snapshot : {};
  // Bewust geen `Number(now)`: dat maakt van `null` stilzwijgend 0 (1970) en dus van elk stempel
  // een toekomstmelding. Alleen een Date of een echt getal telt als klok; de rest is onleesbaar.
  const nowMs = now instanceof Date ? now.getTime() : (typeof now === 'number' ? now : NaN);
  const stempel = leesStempel(snap.generatedAt, nowMs);

  const sources = Array.isArray(snap.sources) ? snap.sources : null;
  // Referentie voor de bronstempels is het bouwmoment zelf; is dat onleesbaar, dan de klok.
  const referentieMs = Number.isFinite(stempel.ms) ? stempel.ms : nowMs;
  const onbewezen = sources === null ? null : sources.filter((s) => !bronIsBewezen(s, referentieMs)).length;
  // Twee regels met dezelfde bronkey maken de noemer onwaar: "8 gelezen" suggereert dan acht
  // bronnen waar er zeven zijn. Geen van beide contracten pint dit vast — `uniqueItems` vergelijkt
  // hele objecten, dus twee regels met dezelfde key en een ander tijdstempel glippen erdoor
  // (gemeten: minItems/maxItems/uniqueItems ontbreken in beide schema's). Codex, zesde ronde.
  const keys = sources ? sources.map((s) => (s && typeof s === 'object' ? s.key : null)) : [];
  const dubbel = sources ? keys.length !== new Set(keys).size : false;

  const regels = [
    typeof snap.contractVersion === 'string' && snap.contractVersion
      ? { label: 'Contractversie', waarde: snap.contractVersion, bewezen: true }
      : { label: 'Contractversie', waarde: null, bewezen: false },
    typeof snap.overallStatus === 'string' && snap.overallStatus
      ? { label: 'Overall-status', waarde: snap.overallStatus, bewezen: true }
      : { label: 'Overall-status', waarde: null, bewezen: false },
    sources
      ? { label: 'Bronnen', waarde: `${sources.length} gelezen · ${onbewezen} niet-geverifieerd`, bewezen: true }
      : { label: 'Bronnen', waarde: null, bewezen: false },
  ];
  // Een groene badge boven regels die zelf UNKNOWN melden is een tegenspraak op één kaart. De
  // paneelstatus steunt daarom óók op de regels, niet alleen op de bronnentelling (Codex, derde ronde).
  const onbewezenRegels = regels.filter((r) => !r.bewezen).map((r) => r.label);

  let status;
  let reden;
  if (stempel.status !== 'GELDIG') {
    status = stempel.status;
    reden = stempel.reden;
  } else if (sources === null) {
    status = 'UNKNOWN';
    reden = 'de snapshot noemt geen bronnenlijst';
  } else if (sources.length === 0) {
    status = 'UNKNOWN';
    reden = 'de bronnenlijst is leeg — er is niets gelezen';
  } else if (dubbel) {
    status = 'AFWIJKING';
    reden = 'de bronnenlijst noemt een bron twee keer — de telling hieronder klopt dan niet';
  } else if (onbewezen > 0) {
    status = 'GEDEELTELIJK';
    reden = `${onbewezen} van de ${sources.length} bronnen is niet geverifieerd`;
  } else if (onbewezenRegels.length > 0) {
    status = 'GEDEELTELIJK';
    reden = `de snapshot noemt geen ${onbewezenRegels.join(' en geen ').toLowerCase()}`;
  } else {
    status = 'VOLLEDIG';
    reden = 'elke gelezen bron is geverifieerd';
  }

  return {
    status,
    reden,
    // Alleen een stempel dat de strikte parser haalde wordt getoond; anders blijft het slot UNKNOWN.
    measuredAt: stempel.status === 'UNKNOWN' ? null : buildStamp(snap.generatedAt),
    regels,
  };
}

const BADGE = { VOLLEDIG: 'ok', GEDEELTELIJK: 'warn', AFWIJKING: 'bad', UNKNOWN: 'warn' };

/**
 * De blinde vlek staat op de pagina zelf. Een lezer die dit paneel groen ziet mag daaruit niet
 * afleiden dat de bouwketen nog draait — dat kan een pagina zonder JavaScript niet over zichzelf
 * vaststellen. Het stempel benoemen en de grens erbij zeggen is eerlijker dan een oordeel dat
 * blijft staan als de bouw stopt.
 */
const BLINDE_VLEK = 'Het stempel is het bouwmoment. Een pagina zonder JavaScript kan niet zien of de bouwketen sindsdien is gestopt — vergelijk het stempel met je eigen klok.';

/** Rendert de body van het STATUSGEN-paneel. Alle tekst gaat door `esc()`; geen rauwe brontekst. */
export function renderStatusgenBody(paneel) {
  const regels = paneel.regels.map((r) => (r.bewezen
    ? `<li><span class="repo">${esc(r.label)}</span><span class="muted">${esc(r.waarde)}</span></li>`
    : `<li><span class="repo">${esc(r.label)}</span><span class="unknown">UNKNOWN — niet in de snapshot</span></li>`)).join('');
  const klasse = paneel.status === 'VOLLEDIG' ? 'muted' : 'unknown';
  const kop = `<p class="${klasse}">${esc(paneel.status)} — ${esc(paneel.reden)}.</p>`;
  return `${kop}<ul class="lights">${regels}</ul><p class="muted">${esc(BLINDE_VLEK)}</p>`;
}

export const statusgenBadge = (paneel) => BADGE[paneel.status] ?? 'warn';
