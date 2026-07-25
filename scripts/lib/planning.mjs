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

/**
 * Gesloten woordenschat voor de duur-indicatie die de bron zelf meelevert. Alleen deze waarden mogen
 * naar buiten. Dit is expliciet GEEN meetsysteem: de waarde wordt nergens naar een datum herrekend en
 * raakt het THROUGHPUT-LOG niet — hij staat op de plaat als startschatting van de bron.
 */
export const DUUR_INDICATIES = ['2-4 uur', '1-2 dagen', '3-5 dagen', '1-2 weken'];

/** Een naam is een naam, geen alinea. Langer = iemand plakt iets waar het niet hoort. */
export const MAX_LABEL = 120;
/** Een kanaalpost-onderwerp is een korte regel; de vrije tekst blijft door de sanitize-gate gaan. */
const MAX_KANAAL = 200;
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
  return { available: false, reason, note, generatedAt: null, features: [], throughput: {}, kanaalpost: [] };
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
    kanaalpost: Array.isArray(data.kanaalpost) ? data.kanaalpost : [],
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
  // Spoedspoor-markering (bron: `prioriteit_tier === 0`). Alleen een echte `true` markeert; alles anders
  // — ontbrekend, null, "ja", 1 — is geen spoedspoor. Zo kan een slordige bron nooit per ongeluk 693
  // regels als spoedeisend laten oplichten.
  const tier0 = f.tier0 === true;
  // Duur-indicatie van de BRON, geen tweede meetsysteem: hij wordt nergens naar een datum herrekend en
  // raakt het throughput-log niet. Alleen een waarde uit de gesloten lijst komt hier binnen (de vertaler
  // keurt de rest hard af); een §B-bestand zónder dit veld levert simpelweg null.
  const duurIndicatie = DUUR_INDICATIES.includes(f.duur_indicatie) ? f.duur_indicatie : null;
  return {
    label,
    status: f.status,
    worker,
    oplevering: verwachteOplevering(f, throughput, buildIso),
    afhankelijkheid,
    tier0,
    duurIndicatie,
  };
}

/** Eén kanaalpost-rij, gestructureerd en gecapt. Vrije `onderwerp`-tekst blijft langs de sanitize-gate gaan. */
function publicKanaal(r) {
  const o = isObject(r) ? r : {};
  const cap = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_KANAAL) : null);
  return {
    datum: isYmd(o.datum) ? o.datum : null,
    doelchat: typeof o.doelchat === 'string' && /^\d{2}$/.test(o.doelchat) ? o.doelchat : null,
    onderwerp: cap(o.onderwerp),
    status: cap(o.status),
  };
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
  // Vierde tegel. Met de backlog-bron staan af/draait/wacht alle drie op 0 — waar en toch misleidend,
  // want er wachten wél honderden regels. `gepland` maakt de band inhoudelijk eerlijk zolang de
  // uitvoerings-stand nog uit een andere bron moet komen (review Codex, 25-07-2026).
  let gepland = 0;
  for (const f of features) {
    if (f.status === 'gepland') gepland += 1;
    if (f.status === 'in-bouw') draaitNu += 1;
    if (f.status === 'wacht-op-Richard') wachtOpRichard += 1;
    if (f.status === 'live' && gisteren !== null && f.oplevering && f.oplevering.date
        && f.oplevering.date >= gisteren) {
      afSindsGisteren += 1;
    }
  }
  return { afSindsGisteren, draaitNu, wachtOpRichard, gepland };
}

function unavailableDto(reason) {
  return {
    available: false,
    reason,
    features: [],
    counters: { afSindsGisteren: 0, draaitNu: 0, wachtOpRichard: 0, gepland: 0 },
    kanaalpost: [],
    bron: null,
  };
}

/**
 * Herkomst van de bouwlijst, opnieuw getoetst op de grens naar de publieke DTO. De plaat toont deze
 * regel zodat niemand een gespiegelde backlog voor de operationele waarheid houdt: welke bron-commit,
 * hoe oud de spiegel is, en hoeveel regels de bron zelf al had weggelaten. Alles wat niet de verwachte
 * vorm heeft valt weg — een provenance-regel mag zelf nooit iets doorlaten.
 */
function publicBron(b) {
  if (!isObject(b)) return null;
  const nat = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  return {
    sha: typeof b.sha === 'string' && /^[0-9a-f]{7,40}$/.test(b.sha) ? b.sha : null,
    bouwbaar: nat(b.bouwbaar),
    publishVeilig: nat(b.publishVeilig),
    weggelaten: nat(b.weggelaten) ?? 0,
    // ISO-tijdstempel van de laatste wijziging van de spiegel; null = onbekend, en onbekend is niet vers.
    spiegelAt: typeof b.spiegelAt === 'string' && !Number.isNaN(new Date(b.spiegelAt).getTime())
      ? new Date(b.spiegelAt).toISOString() : null,
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
    const kanaalpost = (Array.isArray(parsed.kanaalpost) ? parsed.kanaalpost : []).slice(-10).map(publicKanaal);
    return {
      available: true,
      reason: null,
      features,
      counters: planningCounters(features, buildIso),
      kanaalpost,
      // Herkomst; `null` voor een §B-bron die geen spiegel-provenance meelevert (het voorbeeldbestand).
      bron: publicBron(parsed.bron),
    };
  } catch {
    return unavailableDto('CORRUPT');
  }
}
