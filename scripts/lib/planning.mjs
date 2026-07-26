/**
 * PLANNING — de bouwlijst-plaat. Leest de machine-leesbare bouwlijst die TRECHTER op de
 * rapporten-branch levert en zet die om naar de publieke plaat-DTO.
 *
 * F5 (Richard): alles openbaar, mét een harde schoon-poort. Concreet betekent dat hier:
 *  - status en worker-rol komen uit een GESLOTEN woordenschat; een waarde daarbuiten keurt de
 *    hele plaat af (net als trust/category in build.mjs — "één losse waarde is geen gate").
 *  - de worker is een NEUTRALE ROL, nooit een account, mailadres of id (F5 §C).
 *  - de feature-naam is een korte, publiceerbare naam (gecapt), geen alinea.
 *  - fail-closed op een leeg of corrupt bestand: dan een nette melding op de plaat, nooit een
 *    lege of kapotte pagina (de noodpagina-les van 25-07-2026).
 *
 * "Geen tweede meetsysteem": de verwachte oplevering wordt HERREKEND op de doorlooptijden uit het
 * bestaande D-0023 THROUGHPUT-LOG, die TRECHTER ín de bouwlijst meelevert (`throughput.leadDagenPerKlasse`).
 * De plaat meet zelf niets — hij telt alleen de gemeten doorlooptijd bij het bouwmoment op. Een klasse
 * zonder gemeten doorlooptijd levert `onbekend`, nooit een verzonnen datum.
 */

/** Gesloten statuslijst. Buiten de lijst = de plaat wordt afgekeurd (harde schoon-poort). */
export const PLANNING_STATUS = ['gepland', 'in-bouw', 'in-review', 'wacht-op-Richard', 'live'];

/**
 * Worker = een neutrale ROL, nooit een account/mail/id (F5 §C). `null` = nog niet toegewezen.
 * Elke andere waarde dan deze rollen (of null) keurt de plaat af — zo kan er nooit een naam of
 * adres via dit veld naar buiten lekken.
 */
export const WORKER_ROLES = ['worker', 'control', 'review', 'richard'];

/** Een oplevering is een gemeten verwachting, geen belofte: drie eerlijke uitkomsten. */
export const OPLEVERING_KIND = ['opgeleverd', 'verwacht', 'onbekend'];

/** Een naam is een naam, geen alinea. Langer = iemand plakt iets waar het niet hoort. */
const MAX_LABEL = 120;
const DAG_MS = 86400000;
/**
 * Bovengrens op een gemeten doorlooptijd. Een lead van meer dan tien jaar is geen echte raming maar
 * een kapotte of vervuilde log-waarde; die zou bij optellen bij het bouwmoment de Date-range kunnen
 * overschrijden (Invalid Date → RangeError bij toISOString). We behandelen zo'n waarde als "geen
 * bruikbare doorlooptijd" → de oplevering wordt `onbekend` op FEATURE-niveau, i.p.v. dat één rare
 * waarde de hele plaat afkeurt (review Gemini, 25-07-2026).
 */
const MAX_LEAD_DAGEN = 3650;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Strikte YYYY-MM-DD-toets: vorm én een echt bestaande datum (geen 2026-13-40). */
export function isYmd(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function unavailableParsed(reason, note) {
  return { available: false, reason, note, generatedAt: null, features: [], throughput: {} };
}

/**
 * Lees de rauwe bouwlijst-tekst fail-closed. Leeg of geen geldige JSON of niet de verwachte vorm
 * ⇒ een nette, expliciete onbeschikbaarheid (LEEG/CORRUPT) i.p.v. een throw — de plaat toont dan
 * een melding en de rest van de pagina blijft staan. Dit is de enige plek die rauwe tekst aanraakt.
 */
export function parsePlanning(rawText) {
  if (typeof rawText !== 'string' || rawText.trim() === '') {
    return unavailableParsed('LEEG', 'Bouwlijst-bestand is leeg of ontbreekt.');
  }
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    return unavailableParsed('CORRUPT', 'Bouwlijst-bestand is geen geldige JSON.');
  }
  if (!isObject(data)) {
    return unavailableParsed('CORRUPT', 'Bouwlijst-bestand heeft niet de verwachte vorm.');
  }
  if (!Array.isArray(data.features) || data.features.length === 0) {
    return unavailableParsed('LEEG', 'Bouwlijst bevat nog geen features.');
  }
  return {
    available: true,
    reason: null,
    note: null,
    generatedAt: typeof data.generatedAt === 'string' ? data.generatedAt : null,
    features: data.features,
    throughput: isObject(data.throughput) ? data.throughput : {},
  };
}

/** Gemeten doorlooptijd (dagen) voor een klasse, of null als het log die klasse niet kent. */
export function leadDagenVoor(throughput, klasse) {
  const tbl = isObject(throughput) ? throughput.leadDagenPerKlasse : null;
  if (!isObject(tbl)) return null;
  const v = tbl[klasse];
  return Number.isFinite(v) && v >= 0 && v <= MAX_LEAD_DAGEN ? v : null;
}

/**
 * Verwachte oplevering, herrekend op het THROUGHPUT-LOG — de plaat rekent alleen datum + gemeten
 * doorlooptijd, hij meet niets zelf.
 *  - status `live`  ⇒ opgeleverd (met de opleverdatum als die een echte datum is).
 *  - klasse bekend  ⇒ bouwmoment + gemeten doorlooptijd (dagen), als YYYY-MM-DD.
 *  - klasse onbekend ⇒ `onbekend` — nooit een verzonnen datum (fail-closed).
 */
export function verwachteOplevering(feature, throughput, buildIso) {
  if (feature.status === 'live') {
    return { kind: 'opgeleverd', date: isYmd(feature.af_sinds) ? feature.af_sinds : null };
  }
  const lead = leadDagenVoor(throughput, feature.throughput_klasse);
  const base = new Date(buildIso);
  if (lead === null || Number.isNaN(base.getTime())) {
    return { kind: 'onbekend', date: null };
  }
  const d = new Date(base.getTime() + lead * DAG_MS);
  // Belt-and-suspenders: mocht de som tóch buiten de Date-range vallen, dan onbekend i.p.v. een
  // RangeError bij toISOString(). MAX_LEAD_DAGEN dekt dit al af, maar de plaat mag hier nooit breken.
  if (Number.isNaN(d.getTime())) return { kind: 'onbekend', date: null };
  return { kind: 'verwacht', date: d.toISOString().slice(0, 10) };
}

/**
 * Reduceer één feature tot zijn publieke vorm — en GOOI bij een schoon-poort-schending. De caller
 * (`toPublicPlanning`) vangt dat en keurt de hele plaat af; nooit een half-gevulde lijst. Export
 * zodat de test de poort direct kan bewijzen.
 */
export function publicFeature(f, index, throughput, buildIso) {
  const nr = index + 1;
  if (!isObject(f)) throw new Error(`planning: feature ${nr} is geen object`);
  if (!PLANNING_STATUS.includes(f.status)) {
    throw new Error(`planning: feature ${nr} heeft een status buiten de gesloten lijst`);
  }
  const worker = f.worker == null ? null : f.worker;
  if (worker !== null && !WORKER_ROLES.includes(worker)) {
    throw new Error(`planning: feature ${nr} heeft een worker die geen neutrale rol is`);
  }
  const label = typeof f.feature_label === 'string' && f.feature_label.trim()
    ? f.feature_label.trim().slice(0, MAX_LABEL) : null;
  if (label === null) throw new Error(`planning: feature ${nr} mist een leesbare naam`);
  const afhankelijkheid = typeof f.afhankelijkheid === 'string' && f.afhankelijkheid.trim()
    ? f.afhankelijkheid.trim().slice(0, MAX_LABEL) : null;
  return { label, status: f.status, worker, oplevering: verwachteOplevering(f, throughput, buildIso), afhankelijkheid };
}

/** De kop-band: af-sinds-gisteren · draait-nu · wacht-op-Richard. Puur afgeleid, geen extra bron. */
export function planningCounters(features, buildIso) {
  const base = new Date(buildIso);
  // "Af sinds gisteren" op KALENDER-niveau: opgeleverd op de bouwdag of de dag ervoor. Bewust geen
  // rollend 24-uursvenster — af_sinds is een kale datum zonder tijd, dus een venster op het
  // build-tijdstip zou een feature die gisterenochtend live ging 's middags al niet meer meetellen
  // (review Gemini, 25-07-2026). String-vergelijking op YYYY-MM-DD is chronologisch.
  const gisteren = Number.isNaN(base.getTime())
    ? null : new Date(base.getTime() - DAG_MS).toISOString().slice(0, 10);
  let afSindsGisteren = 0;
  let draaitNu = 0;
  let wachtOpRichard = 0;
  for (const f of features) {
    if (f.status === 'in-bouw') draaitNu += 1;
    if (f.status === 'wacht-op-Richard') wachtOpRichard += 1;
    if (f.status === 'live' && gisteren !== null && f.oplevering && f.oplevering.date
        && f.oplevering.date >= gisteren) {
      afSindsGisteren += 1;
    }
  }
  return { afSindsGisteren, draaitNu, wachtOpRichard };
}

function unavailableDto(reason) {
  return {
    available: false,
    reason,
    features: [],
    counters: { afSindsGisteren: 0, draaitNu: 0, wachtOpRichard: 0 },
  };
}

/**
 * Zet de geparste bouwlijst om naar de publieke plaat-DTO. Één afgekeurde regel keurt de HELE plaat
 * af (reason CORRUPT) — nooit een half-gevulde of inconsistente lijst, maar ook nooit de hele pagina
 * neer: alleen deze sectie toont dan een nette melding. `buildIso` is het bouwmoment (waartegen de
 * doorlooptijden worden herrekend) — voor de dashboard-build is dat `raw.generatedAt`.
 */
export function toPublicPlanning(parsed, buildIso) {
  if (!isObject(parsed) || parsed.available !== true) {
    return unavailableDto(parsed && parsed.reason ? parsed.reason : 'LEEG');
  }
  try {
    const throughput = isObject(parsed.throughput) ? parsed.throughput : {};
    const features = parsed.features.map((f, i) => publicFeature(f, i, throughput, buildIso));
    return {
      available: true,
      reason: null,
      features,
      counters: planningCounters(features, buildIso),
    };
  } catch {
    return unavailableDto('CORRUPT');
  }
}
