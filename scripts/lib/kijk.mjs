/**
 * KIJK — de bronvaste, fail-closed waarnemer.
 *
 * De bestaande waarnemer (`waarnemer.mjs`) beantwoordt de vraag "ziet de pagina er gezond uit".
 * Deze module beantwoordt een strengere vraag: "is wat ik lees aantoonbaar de ACTUELE werkelijkheid".
 * Dat verschil is gemeten, niet bedacht — `scripts/kijk-nulmeting.mjs` legt de acht gevallen uit
 * KIJK-FIXEN-V2 aan de oude waarnemer voor en geen enkel geval krijgt het juiste antwoord.
 *
 * DRIE UITKOMSTEN, NIET TWEE. De zwaarste fout van de oude opzet is niet dat hij soms verkeerd
 * oordeelt, maar dat hij altijd móet oordelen: `ok` is een boolean, dus onwetendheid kan zich alleen
 * voordoen als kennis. Hier bestaat GEEN OORDEEL als eigen uitkomst. Een tijdelijke storing in de
 * leesketen is dan niet langer een publieke beschuldiging aan het adres van de plaat.
 *
 * BRONVAST. De oude leesketen haalde `…/main/…` op: een bewegende ref, dus twee opeenvolgende fetches
 * kunnen uit twee verschillende werelden komen en niets in het antwoord verraadt dat. Hier wordt eerst
 * de kop van main opgelost, daarna de inhoud op exact die volledige SHA opgehaald, en daarna de kop
 * opnieuw gelezen. Bewoog hij, dan telt de hele lezing niet. Een ETag mag dat verkeer besparen maar
 * geldt nooit als bewijs — een cache die "niet gewijzigd" zegt, zegt iets over zichzelf.
 *
 * WAT HIER NIET STAAT, met opzet (addendum Fable op KIJK-FIXEN-V2, 26-07-2026): er wordt GEEN eigen
 * gebeurtenissenlog gebouwd. Het kanonieke log met event-ID's, monotone sequence en statusmachine
 * bestaat al bij de orchestrator (`task_events`); de spiegel-exporter gaat daaruit publiceren. Zolang
 * die exporter niet live is levert `kijkStateUitSpiegel` een TIJDELIJKE vertaling uit de huidige
 * spiegel, en die draagt het merk OVERGANG in de state én in het manifest — zodat geen enkele lezer
 * kan denken dat hij de kanonieke bron al leest. De koppeltaak staat bij CONTROL (EQ-01626d6c80d1).
 */

import { createHash } from 'node:crypto';

import { kanaalpostUitTekst, ontdaan } from './kanaalpost.mjs';

/** De zes canonieke toestanden van een WERKOBJECT. Gesloten lijst; een zevende waarde is een fout. */
export const TOESTANDEN = ['MERGEABLE', 'WACHT OP AKKOORD', 'GEBLOKKEERD', 'MERGED', 'EFFECT-BEWEZEN', 'LEEG'];

/**
 * De uitkomst van één EVENT, streng gescheiden van de toestand van het werkobject. Dat onderscheid is
 * de reden dat het er staat: "de poging is afgebroken" en "het werk is geblokkeerd" zien er in een
 * platte lijst hetzelfde uit, en juist daar ontstaat het valse groen — een afgebroken meting die als
 * een gezonde toestand wordt gelezen.
 */
export const EVENT_UITKOMSTEN = ['GEACCEPTEERD', 'GEWEIGERD', 'AFGEBROKEN', 'GEEN'];

/** Wat de kijk als geheel kan zeggen. GEEN OORDEEL is een volwaardige uitkomst, geen foutafhandeling. */
export const UITKOMSTEN = ['GROEN', 'PARTIAL', 'ROOD', 'GEEN OORDEEL'];

/**
 * Gesloten lijst met redenen, elk met één zin in gewone taal. Deze zinnen mogen publiek worden, dus
 * er staat geen pad, geen adres en geen naam in — en er is geen enkele manier om er vrije tekst aan
 * toe te voegen. Dat is precies de eis "geen vrije publieke tekst: alleen gesloten velden en
 * goedgekeurde reasonCodes".
 */
export const REDENEN = {
  KOP_ONBEPAALBAAR: 'de actuele kop van de hoofdtak was niet vast te stellen',
  KOP_BEWOOG: 'de hoofdtak bewoog tijdens het lezen, dus de lezing is niet één samenhangend moment',
  KOP_ONGELDIG: 'de opgegeven kop is geen volledige commit-aanduiding',
  BRON_ONBEREIKBAAR: 'de bron was niet op te halen',
  BRON_ONLEESBAAR: 'de bron was op te halen maar niet te lezen',
  BRON_LEEG: 'de bron kwam leeg terug',
  PAGINA_ONBEREIKBAAR: 'de openbare pagina was niet op te halen',
  PAGINA_ZONDER_HERKOMST: 'de pagina draagt geen herkomst, dus er valt niets aan te toetsen',
  PAGINA_ANDERE_COMMIT: 'de pagina is gebouwd uit een andere commit dan de actuele kop',
  PAGINA_ANDERE_TOESTAND: 'de pagina toont een andere toestand dan de bron op diezelfde kop',
  PAGINA_ANDER_WATERMERK: 'de pagina en de bron staan op een verschillende stand van de teller',
  WATERMERK_DAALT: 'de teller van de bron staat lager dan bij de vorige waarneming',
  TOESTAND_WISSELT_BIJ_GELIJKE_STAND: 'de bron veranderde zonder dat de teller meebewoog',
  LANE_VEROUDERD: 'een spoor meldt al langer niets terwijl andere sporen doormelden',
  VELD_NIET_GESLOTEN: 'de bron bevat een veld dat niet uit een vastgelegde lijst komt',
  BEWIJS_ONVOLLEDIG: 'niet alle bewijsstukken zijn aangeleverd, dus er valt niets vast te stellen',
  GEEN_SPOREN: 'de bron leverde geen enkel spoor op',
  TOESTAND_NIET_BIJ_BYTES: 'de aangeleverde toestand hoort niet bij de aangeleverde bytes',
  ALLES_STIL: 'alle sporen zwijgen al langer dan afgesproken',
  TOESTAND_ONBEKEND: 'de bron noemt een toestand die niet in de vastgelegde lijst staat',
  HASHFOUT: 'de meegeleverde controlesom hoort niet bij de inhoud',
};

/**
 * Sporen die een eigen stand hebben. Gesloten lijst: een onbekend spoor is een fout, geen nieuw spoor.
 *
 * De lijst is niet bedacht maar GETELD: dit zijn de sporen die op 2026-07-26 in de spiegel voorkomen
 * (kop 7f9c99c), aangevuld met AUTOPILOT en MINI, die wel bestaan maar in die momentopname geen rij
 * hadden. Een gesloten lijst die achterloopt op de werkelijkheid is gevaarlijk zodra hij rijen stil
 * laat verdwijnen — daarom wordt een onbekend spoor niet weggegooid maar geteld, en maakt elke
 * weggevallen rij de uitkomst rood (zie `kijkStateUitSpiegel` en `oordeel`). Een nieuw spoor kost dus
 * één regel hier; hem vergeten kost een rode plaat, niet een stille.
 */
export const LANES = [
  'ARCHEOLOGIE', 'AUTOPILOT', 'CHIEF', 'COMMAND-CANON', 'CONTENT', 'CONTROL', 'DASHBOARD',
  'INSTROOM', 'MARKT', 'MINI', 'NQ-RADAR', 'ORCHESTRATOR', 'PRESENTATIES', 'TRECHTER', 'WAARNEMER',
];

const UUR = 3600 * 1000;

/**
 * Hoe lang een spoor mag zwijgen voordat het "verouderd" heet, ALS er ondertussen andere sporen
 * melden. Zonder die tweede voorwaarde zou een rustige nacht acht rode meldingen opleveren; met die
 * voorwaarde betekent stilte alleen iets wanneer aantoonbaar iemand anders wél doorwerkte.
 */
export const LANE_STIL_UREN = 6;

/**
 * Het korte operationele venster van de "kijk", STRENG GESCHEIDEN van de vijftien uur waarmee
 * `waarnemer.mjs` de gezondheid van de plaat beoordeelt (KIJK-FIXEN-V2, laatste bouwpunt). Die
 * vijftien uur is er omdat er 's nachts niet gebouwd wordt; hem hier hergebruiken zou betekenen dat
 * "kijk" een pagina van veertien uur oud groen noemt. Dit is een andere vraag met een ander antwoord:
 * bij een kijk telt alleen of de kop, de toestand en de teller nú kloppen, en de tijd doet niet mee.
 */
export const KIJK_SLO_MINUTEN = 20;

const HEX40 = /^[0-9a-f]{40}$/;

/** Is dit een volledige commit-aanduiding? Zeven tekens is geen bewijs: een prefix kan botsen. */
export const volledigeSha = (v) => typeof v === 'string' && HEX40.test(v);

/** SHA-256 over exact deze bytes. Geen JSON-herserialisatie onderweg: de bytes zijn het bewijs. */
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * De kanonieke bytes van een kijk-state: sleutels gesorteerd, twee spaties inspringing, afsluitende
 * regelovergang. Zonder één vaste vorm is de hash geen bewijs maar een eigenschap van de serializer,
 * en dan zou dezelfde toestand op twee machines twee hashes kunnen krijgen.
 */
export function kanoniekeBytes(obj) {
  const sorteer = (v) => {
    if (Array.isArray(v)) return v.map(sorteer);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorteer(v[k])]));
    }
    return v;
  };
  return Buffer.from(`${JSON.stringify(sorteer(obj), null, 2)}\n`, 'utf8');
}

/**
 * Het UTC-moment van een NL-tijd zonder zone, ECHT omgerekend.
 *
 * De oude `rijMoment` las de NL-kolom als UTC en noemde dat "behoudend": de rij zou er jonger
 * uitzien, en dat zou de waarnemer alleen milder maken. Dat klopte niet, en het productiegeval laat
 * zien waarom. Milder betekent hier: het respijtvenster schuift een rij op. Bij 19:00 NL viel de
 * verse regel van 18:40 daardoor "in de toekomst", schoof het venster één plaats door, en mocht de
 * pagina de rij DAARONDER tonen — 14:16, vier uur oud. Zie proef 3 van de nulmeting: `toets().ok`
 * kwam op `true` uit terwijl de bron 18:40 was en de pagina 14:16 toonde.
 *
 * Hier wordt de zone opgezocht in plaats van weggeredeneerd. `Intl` kent de echte zomertijdregels van
 * Europe/Amsterdam, inclusief de twee dagen per jaar waarop een lokale tijd dubbel of niet bestaat.
 */
export function momentUitNlTijd(datum) {
  const m = String(datum ?? '').match(/^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/);
  if (!m) return null;
  const [, jj, mm, dd, hh = '00', mi = '00'] = m;
  const alsUtc = Date.UTC(+jj, +mm - 1, +dd, +hh, +mi, 0);
  if (Number.isNaN(alsUtc)) return null;
  // `Date.UTC` rekent een onmogelijke kalenderdatum stilzwijgend om: 30 februari wordt 2 maart, en 32
  // januari wordt 1 februari. Zonder deze controle zou een verzonnen datum dus gewoon een geldig
  // moment opleveren. De heenweg wordt daarom teruggerekend en moet exact opleveren wat er stond.
  const d = new Date(alsUtc);
  if (d.getUTCFullYear() !== +jj || d.getUTCMonth() !== +mm - 1 || d.getUTCDate() !== +dd
    || d.getUTCHours() !== +hh || d.getUTCMinutes() !== +mi) {
    return null;
  }
  // Twee stappen: schat de verschuiving op het geschatte moment, corrigeer, en meet opnieuw. De
  // tweede meting vangt de overgangsnacht, waarin de eerste schatting er een uur naast kan zitten.
  let t = alsUtc;
  let vorige = alsUtc;
  for (let i = 0; i < 2; i += 1) {
    vorige = t;
    const verschuiving = zoneVerschuiving(t);
    t = alsUtc - verschuiving;
  }

  // Controleer of het antwoord de gevraagde wandklok ECHT teruggeeft. Zo niet, dan bestond die
  // lokale tijd niet: het is de nacht waarin 02:00 meteen 03:00 wordt, en 02:30 heeft nooit bestaan.
  //
  // Zonder deze stap schuift zo'n niet-bestaande tijd een uur vooruit en komt hij NA 03:00 te liggen,
  // terwijl hij in de kolom ervóór staat. Dan loopt de tijd achteruit, en een reeks waarin de tijd
  // achteruit loopt maakt elke uitspraak over volgorde waardeloos — precies wat de teller en het
  // stilte-alarm nodig hebben. Daarom wordt de hele ontbrekende uurgap op één moment vastgezet: het
  // moment waarop de klok verspringt. Alles in het gat krijgt dus dezelfde tijd als 03:00, en de
  // reeks loopt niet meer achteruit.
  if (zoneVerschuiving(t) !== alsUtc - t) {
    let lo = Math.min(vorige, t);
    let hi = Math.max(vorige, t);
    const verschuivingLo = zoneVerschuiving(lo);
    while (hi - lo > 1) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (zoneVerschuiving(mid) === verschuivingLo) lo = mid; else hi = mid;
    }
    return hi;
  }
  return t;
}

/**
 * Hoeveel ligt Europe/Amsterdam op dit moment vóór op UTC, in milliseconden.
 *
 * Het moment wordt eerst op hele seconden afgerond. De formatter kent geen milliseconden, dus zonder
 * die afronding lekt het millisecondendeel van `t` in het antwoord en is de verschuiving geen veelvoud
 * van een uur meer. Twee verschuivingen zijn dan bijna nooit gelijk, en dat breekt elke vergelijking
 * die erop steunt — zoals de zoektocht naar het moment waarop de klok verspringt.
 */
function zoneVerschuiving(tRuw) {
  const t = Math.floor(tRuw / 1000) * 1000;
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const d = Object.fromEntries(f.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  const lokaalAlsUtc = Date.UTC(+d.year, +d.month - 1, +d.day, +(d.hour === '24' ? '00' : d.hour), +d.minute, +d.second);
  return lokaalAlsUtc - t;
}

/**
 * Lees de bron BRONVAST: kop bepalen, inhoud op exact die kop ophalen, kop opnieuw bepalen.
 *
 * `kopVan()` en `inhoudVan(sha)` worden ingespoten, zodat elke tak zonder netwerk te beproeven is —
 * en zodat de tijdrace uit proef 2 in een test exact te ensceneren valt, in plaats van te moeten
 * hopen dat main toevallig beweegt tijdens een echte run.
 *
 * Bewoog de kop, dan wordt de HELE lezing overgedaan, niet alleen de inhoudsfetch: een tweede fetch
 * op de oude kop zou een consistent maar verouderd antwoord opleveren, en dat is precies het geval
 * dat proef 1 beschrijft. Blijft hij bewegen, dan is de uitkomst GEEN OORDEEL — nooit een gok.
 */
export async function leesBronvast({ kopVan, inhoudVan, pogingen = 3 } = {}) {
  const geprobeerd = [];
  for (let poging = 1; poging <= pogingen; poging += 1) {
    const kop = await kopVan();
    if (!kop || kop.ok !== true) return { ok: false, reden: 'KOP_ONBEPAALBAAR', pogingen: poging, geprobeerd };
    if (!volledigeSha(kop.sha)) return { ok: false, reden: 'KOP_ONGELDIG', pogingen: poging, geprobeerd };

    const inhoud = await inhoudVan(kop.sha);
    if (!inhoud || inhoud.ok !== true) {
      return { ok: false, reden: inhoud?.reden === 'LEEG' ? 'BRON_LEEG' : 'BRON_ONBEREIKBAAR', pogingen: poging, geprobeerd };
    }

    const naKop = await kopVan();
    if (!naKop || naKop.ok !== true) return { ok: false, reden: 'KOP_ONBEPAALBAAR', pogingen: poging, geprobeerd };
    geprobeerd.push({ voor: kop.sha, na: naKop.sha });
    if (naKop.sha === kop.sha) {
      return { ok: true, sha: kop.sha, tekst: inhoud.tekst, blobSha: inhoud.blobSha ?? null, pogingen: poging, geprobeerd };
    }
    // De kop bewoog: alles weggooien en opnieuw beginnen bij het bepalen van de kop.
  }
  return { ok: false, reden: 'KOP_BEWOOG', pogingen, geprobeerd };
}

/**
 * De OVERGANG-vertaling van spiegelstatus naar canonieke werkobjecttoestand.
 *
 * Twee van de drie spiegelstatussen zijn letterlijk een canonieke toestand. `AFGEROND` is dat NIET, en
 * daar wordt niets van gemaakt: de spiegel onderscheidt MERGEABLE, MERGED en EFFECT-BEWEZEN niet, dus
 * een vertaling die er één van kiest zou een bewering verzinnen die in de bron niet staat — precies de
 * soort stille aanname waar deze hele opdracht tegen is. `AFGEROND` wordt daarom `LEEG`: geen
 * vastgestelde toestand. Dat is het verlies dat deze overgang zichtbaar maakt, en het is de reden dat
 * de echte bron `task_events` moet worden (koppeltaak EQ-01626d6c80d1).
 */
export const OVERGANG_TOESTAND = {
  'WACHT OP AKKOORD': 'WACHT OP AKKOORD',
  GEBLOKKEERD: 'GEBLOKKEERD',
  AFGEROND: 'LEEG',
};

/** Het merk dat elke lezer moet zien: dit is nog niet de kanonieke bron. */
export const OVERGANG_MERK = 'OVERGANG_SPIEGEL_NIET_TASK_EVENTS';

/**
 * Bouw de kijk-state uit een spiegeltekst. TIJDELIJK — zie het merk hierboven.
 *
 * WAT ER NIET IN KOMT is het belangrijkste kenmerk van deze functie: geen `onderwerp`, geen `actie`,
 * geen enkel vrij tekstveld. De state draagt alleen gesloten waarden (spoor, toestand, teller, moment,
 * object-aanduiding). Een spiegelregel met een klantnaam, een incidentbeschrijving of een pad levert
 * dus een state waarin die tekst niet voorkomt — niet omdat een filter hem tegenhield, maar omdat er
 * geen veld is waarin hij past. Dat is de enige vorm van "geen vrije publieke tekst" die niet afhangt
 * van de vraag of iemand alle patronen heeft bedacht (AUD-002: negen vormen kwamen langs alle patronen).
 *
 * De teller is de APPENDPOSITIE, niet de datumkolom. Het spiegelbestand is append-only, dus de positie
 * loopt monotoon op ook wanneer iemand een regel met een oudere tijd toevoegt — en juist die
 * niet-chronologische volgorde is een van de vier manieren waarop de oude waarnemer vals groen gaf.
 */
export function kijkStateUitSpiegel(tekst, { commitSha = null } = {}) {
  const raw = kanaalpostUitTekst(String(tekst ?? ''));
  const fouten = [];
  const lanes = {};
  let teller = 0;

  if (raw.available !== true || !Array.isArray(raw.rows)) {
    // De onleesbare bron leverde eerder een keurige lege toestand op: nul sporen, nul fouten in de
    // toestand zelf, en dus een oordeel dat GROEN kon worden. De reviewronde op kop 579ad57 wees dit
    // aan als de zwaarste fail-open van het geheel — "ik kon de bron niet lezen" kwam eruit als "er is
    // niets aan de hand". De mislukking staat nu IN de toestand, zodat hij niet te negeren is.
    return {
      state: {
        schemaVersie: KIJK_SCHEMA, bronSoort: OVERGANG_MERK, bronCommitSha: commitSha,
        eventHighWatermark: 0, eventCount: 0, verworpenRijen: 1, lanes: {},
      },
      fouten: [raw.reason === 'LEEG' ? 'BRON_LEEG' : 'BRON_ONLEESBAAR'],
    };
  }

  for (const r of raw.rows) {
    teller += 1;
    const laneId = ontdaan(r.tab ?? '');
    const status = ontdaan(r.status ?? '');
    if (!LANES.includes(laneId)) { fouten.push('VELD_NIET_GESLOTEN'); continue; }
    const toestand = OVERGANG_TOESTAND[status];
    if (toestand === undefined) { fouten.push('TOESTAND_ONBEKEND'); continue; }
    const moment = momentUitNlTijd(ontdaan(r.datum ?? ''));
    lanes[laneId] = {
      laneId,
      sequence: teller,
      // De aanduiding van het werkobject komt uit gesloten delen: spoor plus positie. Geen tekst uit
      // de bron, dus ook geen tekst die per ongeluk publiek wordt.
      objectId: `${laneId}#${teller}`,
      toestand,
      // Event-uitkomst en werkobjecttoestand zijn gescheiden velden. De overgang kan de uitkomst niet
      // uit de spiegel afleiden, dus die is expliciet GEEN in plaats van stilzwijgend afwezig.
      eventUitkomst: 'GEEN',
      momentUtc: moment === null ? null : new Date(moment).toISOString(),
    };
  }

  return {
    state: {
      schemaVersie: KIJK_SCHEMA,
      bronSoort: OVERGANG_MERK,
      bronCommitSha: commitSha,
      eventHighWatermark: teller,
      eventCount: teller,
      // Het aantal bronrijen dat het gesloten schema NIET haalde. Dit veld bestaat omdat de eerste
      // live-lezing (kop 7f9c99c) liet zien dat 41 van de 54 rijen stil verdwenen: hun spoor stond
      // niet in de lijst, dus vielen ze buiten de state zonder dat de uitkomst er iets over zei. Een
      // rij die stil verdwijnt is dezelfde fout als een lane die stil zwijgt — daarom telt hij mee en
      // maakt hij de uitkomst rood in plaats van dat hij nergens opduikt.
      verworpenRijen: fouten.length,
      lanes,
    },
    fouten,
  };
}

/** De schemaversie van kijk-state en kijk-manifest. Eén nummer voor beide: ze horen bij elkaar. */
export const KIJK_SCHEMA = '1.0.0';

/**
 * Keur een kijk-state tegen het gesloten schema. Alles wat niet uit een vastgelegde lijst komt is een
 * fout, ook als het er onschuldig uitziet: een onbekend spoor is geen nieuw spoor maar een gat in de
 * lijst, en dat hoort iemand te repareren in plaats van dat de kijk het stilzwijgend accepteert.
 */
/** Precies de sleutels die een kijk-state mag hebben, en precies die van één spoor. */
const STATE_SLEUTELS = ['schemaVersie', 'bronSoort', 'bronCommitSha', 'eventHighWatermark', 'eventCount', 'verworpenRijen', 'lanes'];
const LANE_SLEUTELS = ['laneId', 'sequence', 'objectId', 'toestand', 'eventUitkomst', 'momentUtc'];

export function keurState(state) {
  const fouten = [];
  if (!state || typeof state !== 'object') return { ok: false, fouten: ['BRON_ONLEESBAAR'] };
  if (state.schemaVersie !== KIJK_SCHEMA) fouten.push('VELD_NIET_GESLOTEN');

  // Onbekende velden worden GEWEIGERD, niet genegeerd. Zonder deze regel rust de belofte "geen vrije
  // publieke tekst" alleen op de huidige vertaler: wie er een `onderwerp` met brontekst bij zet, kreeg
  // een geldig verklaarde toestand die gehasht en weggeschreven werd. Het schema hoort de garantie te
  // dragen, niet de ene functie die hem nu toevallig invult.
  if (Object.keys(state).some((k) => !STATE_SLEUTELS.includes(k))) fouten.push('VELD_NIET_GESLOTEN');

  // Een toestand zonder enig spoor is geen gezonde toestand maar een mislukte lezing. Er valt niets te
  // vergelijken, dus er valt niets goed te keuren.
  if (!state.lanes || typeof state.lanes !== 'object' || Object.keys(state.lanes).length === 0) {
    fouten.push('GEEN_SPOREN');
  }
  if (!Number.isInteger(state.eventHighWatermark) || state.eventHighWatermark < 0) fouten.push('VELD_NIET_GESLOTEN');
  // Verworpen rijen zijn een schemafout van de BRON, geen ruis van de lezer: er staat iets in de
  // spiegel dat het gesloten schema niet kent, en zolang dat zo is dekt de state de bron niet.
  const verworpen = state.verworpenRijen ?? 0;
  if (!Number.isInteger(verworpen) || verworpen < 0 || verworpen > 0) fouten.push('VELD_NIET_GESLOTEN');
  for (const [sleutel, lane] of Object.entries(state.lanes ?? {})) {
    if (!LANES.includes(sleutel) || lane?.laneId !== sleutel) { fouten.push('VELD_NIET_GESLOTEN'); continue; }
    if (Object.keys(lane).some((k) => !LANE_SLEUTELS.includes(k))) fouten.push('VELD_NIET_GESLOTEN');
    if (!TOESTANDEN.includes(lane.toestand)) fouten.push('TOESTAND_ONBEKEND');
    if (!EVENT_UITKOMSTEN.includes(lane.eventUitkomst)) fouten.push('VELD_NIET_GESLOTEN');
    if (!Number.isInteger(lane.sequence) || lane.sequence < 1) fouten.push('VELD_NIET_GESLOTEN');
    // De objectaanduiding moet uit gesloten delen zijn opgebouwd. Zonder deze toets zou hier alsnog
    // vrije tekst binnenkomen langs een veld dat "technisch" heet.
    if (lane.objectId !== `${sleutel}#${lane.sequence}`) fouten.push('VELD_NIET_GESLOTEN');
    if (lane.momentUtc !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(String(lane.momentUtc))) {
      fouten.push('VELD_NIET_GESLOTEN');
    }
  }
  return { ok: fouten.length === 0, fouten: [...new Set(fouten)] };
}

/**
 * Het manifest naast de state. Het draagt de controlesom van de state-BYTES, niet van een object: een
 * hash over een opnieuw geserialiseerd object bewijst iets over de serializer en niet over het bestand
 * dat een lezer echt binnenhaalt.
 */
export function manifestVoor(state, { bronCommitSha, bronBlobSha = null, generatedAt }) {
  const bytes = kanoniekeBytes(state);
  return {
    manifest: {
      schemaVersie: KIJK_SCHEMA,
      bronSoort: state.bronSoort,
      bronCommitSha,
      bronBlobSha,
      eventHighWatermark: state.eventHighWatermark,
      eventCount: state.eventCount,
      generatedAt,
      stateSha256: sha256(bytes),
    },
    bytes,
  };
}

/**
 * Klopt het manifest bij deze state-bytes? Een manifest dat zichzelf niet dekt is erger dan geen
 * manifest: het wekt vertrouwen dat het niet verdient.
 */
export function manifestDekt(manifest, bytes) {
  return Boolean(manifest) && manifest.stateSha256 === sha256(bytes);
}

/**
 * Welke sporen zwijgen te lang, gegeven dat andere sporen wél doormelden?
 *
 * De tweede voorwaarde is de hele truc. "Dit spoor meldde zes uur niets" is 's nachts geen bevinding
 * maar de normale gang van zaken. "Dit spoor meldde zes uur niets terwijl er ondertussen wél is
 * doorgemeld" is dat wel: dan is er activiteit geweest waarin dit spoor ontbrak, en dat is precies de
 * stille uitval die zich anders als een groen totaaloordeel voordoet (proef 5 van de nulmeting).
 */
export function verouderdeLanes(state, stilMs = LANE_STIL_UREN * UUR) {
  const lanes = Object.values(state?.lanes ?? {});
  const momenten = lanes.map((l) => (l.momentUtc ? Date.parse(l.momentUtc) : null)).filter((t) => t !== null);
  if (!momenten.length) return [];
  // Gemeten tegen het JONGSTE spoor, niet tegen de klok. Draait de kijk een uur later dan gepland, dan
  // zijn niet ineens alle sporen verouderd; wat telt is de afstand tússen de sporen onderling. De
  // absolute leeftijd van de hele plaat is een andere vraag, en die hoort bij het 15-uurs
  // gezondheidscontract van `waarnemer.mjs` — hier expres niet hergebruikt (KIJK_SLO_MINUTEN).
  const jongste = Math.max(...momenten);
  return lanes
    .filter((l) => {
      const t = l.momentUtc ? Date.parse(l.momentUtc) : null;
      return t === null || jongste - t > stilMs;
    })
    .map((l) => l.laneId)
    .sort();
}

/**
 * HET OORDEEL. Alles komt hier samen, en de volgorde van de takken is zelf een ontwerpbeslissing:
 * onwetendheid gaat vóór rood, en rood gaat vóór partial. Andersom zou een leesfout zich kunnen
 * voordoen als een bevinding over de plaat (proef 8: vier storingsvormen leverden bij de oude
 * waarnemer een publieke alarmregel die de plaat beschuldigde).
 *
 * `getuigenis` is wat de ONAFHANKELIJKE getuige zich herinnert van de vorige keer: de laatst geziene
 * teller, commit en toestandshash. Die getuige hoort buiten deze repo te draaien (taak EQ-e2bc34e069cd,
 * voorkeurslocatie de mini-worker, activeren is een Richard-poort). Zolang hij er niet is mag deze
 * functie hem missen — dan vervallen alleen de twee toetsen die geheugen nodig hebben, en dat is
 * zichtbaar in `gemeten.getuigeAanwezig` in plaats van stilzwijgend.
 */
export function oordeel({
  lezing, paginaHerkomst = null, state = null, manifest = null, stateBytes = null,
  getuigenis = null, stilMs = LANE_STIL_UREN * UUR, nu = null,
} = {}) {
  const redenen = [];
  const gemeten = {
    kopSha: null, paginaCommitSha: null, stateSha256: null, watermerk: null,
    getuigeAanwezig: getuigenis !== null, verouderdeLanes: [], pogingen: lezing?.pogingen ?? null,
  };
  const uit = (uitkomst) => ({ uitkomst, redenen: [...new Set(redenen)], gemeten });

  // ── 1. kon er überhaupt bronvast gelezen worden? Zo nee: GEEN OORDEEL, nooit iets anders.
  if (!lezing || lezing.ok !== true) {
    redenen.push(lezing?.reden && REDENEN[lezing.reden] ? lezing.reden : 'BRON_ONBEREIKBAAR');
    return uit('GEEN OORDEEL');
  }
  gemeten.kopSha = lezing.sha;

  // ── 2. is het bewijs überhaupt compleet aangeleverd?
  //
  // Dit is de reparatie van een fail-open die de reviewronde op kop 579ad57 blootlegde. De hash- en
  // manifestcontroles hieronder stonden onder `if (manifest && stateBytes && …)`, en die voorwaarde
  // sloeg de controle stilzwijgend over wanneer een aanroeper het manifest of de bytes wegliet. Een
  // pagina met een verzonnen toestandshash kwam er dan als GROEN uit — gemeten, niet vermoed. Een
  // ontbrekend bewijsstuk is onwetendheid, en onwetendheid hoort hier één uitkomst te hebben.
  if (!state || !manifest || !stateBytes) {
    redenen.push('BEWIJS_ONVOLLEDIG');
    return uit('GEEN OORDEEL');
  }

  // ── 2b. dekt het manifest exact deze state-bytes?
  if (!manifestDekt(manifest, stateBytes)) {
    redenen.push('HASHFOUT');
    return uit('GEEN OORDEEL');
  }

  // ── 2c. horen de bytes ook echt bij DEZE toestand?
  //
  // Het manifest bewijst iets over de bytes, en de bytes bewijzen iets over zichzelf — maar tot hier
  // bewees niets dat het object dat straks beoordeeld wordt dezelfde toestand is als de bytes die
  // gehasht zijn. Een aanroeper kon de bytes van toestand A aanleveren en toestand B laten beoordelen,
  // en de hele hashketen bleef kloppen. De ketting was dus nergens aan de toestand vastgemaakt.
  if (!kanoniekeBytes(state).equals(Buffer.from(stateBytes))) {
    redenen.push('TOESTAND_NIET_BIJ_BYTES');
    return uit('GEEN OORDEEL');
  }
  gemeten.stateSha256 = manifest?.stateSha256 ?? null;
  gemeten.watermerk = state?.eventHighWatermark ?? null;

  // ── 3. is de state zelf gesloten? Een state met een onbekend spoor of een zevende toestand is een
  // meting die niet klopt, en dat is rood — niet "geen oordeel", want hier IS iets waarneembaar mis.
  const keuring = keurState(state);
  if (!keuring.ok) redenen.push(...keuring.fouten);

  // ── 4. de pagina moet haar herkomst dragen en die moet exact kloppen. Exact: de volledige SHA, de
  // toestandshash en de teller. Tijd doet hier NIET mee — een verse stempel op de verkeerde inhoud is
  // precies het geval dat de oude waarnemer niet kon zien (proef 4).
  if (paginaHerkomst === null) {
    redenen.push('PAGINA_ONBEREIKBAAR');
  } else if (!volledigeSha(paginaHerkomst.commitSha) || !paginaHerkomst.stateSha256
    || !Number.isInteger(paginaHerkomst.eventHighWatermark)) {
    redenen.push('PAGINA_ZONDER_HERKOMST');
  } else {
    gemeten.paginaCommitSha = paginaHerkomst.commitSha;
    if (paginaHerkomst.commitSha !== lezing.sha) redenen.push('PAGINA_ANDERE_COMMIT');
    if (manifest && paginaHerkomst.stateSha256 !== manifest.stateSha256) redenen.push('PAGINA_ANDERE_TOESTAND');
    if (state && paginaHerkomst.eventHighWatermark !== state.eventHighWatermark) redenen.push('PAGINA_ANDER_WATERMERK');
  }

  // ── 5. wat weet de getuige nog? Twee vormen van bederf die zonder geheugen onzichtbaar zijn: een
  // teller die daalt, en een toestand die verandert terwijl de teller stilstaat. Beide kunnen groen
  // ogen omdat bron en pagina onderling perfect overeenkomen.
  if (getuigenis && state) {
    if (Number.isInteger(getuigenis.sequence) && state.eventHighWatermark < getuigenis.sequence) {
      redenen.push('WATERMERK_DAALT');
    } else if (Number.isInteger(getuigenis.sequence) && state.eventHighWatermark === getuigenis.sequence
      && getuigenis.stateSha256 && manifest && getuigenis.stateSha256 !== manifest.stateSha256) {
      redenen.push('TOESTAND_WISSELT_BIJ_GELIJKE_STAND');
    }
  }

  if (redenen.length) return uit('ROOD');

  // ── 5b. staat ALLES stil?
  //
  // De onderlinge meting hieronder heeft een blinde vlek waar beide reviewers onafhankelijk op wezen:
  // stoppen alle sporen tegelijk — de orchestrator valt om, de stroom valt weg — dan is hun onderlinge
  // afstand nul en is er dus geen enkel verouderd spoor. Precies de totale uitval kwam er zo als GROEN
  // uit. Daarom is er één absolute vloer, en die geldt alleen als de aanroeper een moment meegeeft:
  // zonder klok wordt er geen uitspraak over de klok gedaan.
  const momenten = Object.values(state.lanes)
    .map((l) => (l.momentUtc ? Date.parse(l.momentUtc) : null))
    .filter((t) => t !== null && !Number.isNaN(t));
  if (nu !== null && momenten.length && nu - Math.max(...momenten) > stilMs) {
    redenen.push('ALLES_STIL');
    gemeten.verouderdeLanes = Object.keys(state.lanes).sort();
    return uit('PARTIAL');
  }

  // ── 6. pas als alles hierboven klopt is een stil spoor het onderwerp. Eerder zou het een bijzaak
  // zijn naast een echte fout, en dan verdwijnt het uit beeld.
  const stil = verouderdeLanes(state, stilMs);
  gemeten.verouderdeLanes = stil;
  if (stil.length) {
    redenen.push('LANE_VEROUDERD');
    return uit('PARTIAL');
  }
  return uit('GROEN');
}

/**
 * De publieke regel die bij een uitkomst hoort — uitsluitend uit gesloten delen samengesteld. Er is
 * geen parameter waarmee je er tekst in krijgt; wie een detail wil toevoegen moet eerst een reasonCode
 * aan `REDENEN` toevoegen, en dat is een leesbare wijziging in een pull request.
 */
export function publiekeRegel({ uitkomst, redenen = [], lanes = [] }) {
  if (!UITKOMSTEN.includes(uitkomst)) return null;
  const zinnen = redenen.filter((r) => REDENEN[r]).map((r) => REDENEN[r]);
  const sporen = lanes.filter((l) => LANES.includes(l));
  const staart = sporen.length ? ` (${sporen.join(', ')})` : '';
  return { uitkomst, uitleg: zinnen.length ? zinnen.join('; ') + staart : 'de kijk kwam overeen met de bron' };
}
