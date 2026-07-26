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

import { kanaalpostUitTekst, spiegelScan, ontdaan } from './kanaalpost.mjs';

/** De zes canonieke toestanden van een WERKOBJECT. Gesloten lijst; een zevende waarde is een fout. */
export const TOESTANDEN = Object.freeze(['MERGEABLE', 'WACHT OP AKKOORD', 'GEBLOKKEERD', 'MERGED', 'EFFECT-BEWEZEN', 'LEEG']);

/**
 * De uitkomst van één EVENT, streng gescheiden van de toestand van het werkobject. Dat onderscheid is
 * de reden dat het er staat: "de poging is afgebroken" en "het werk is geblokkeerd" zien er in een
 * platte lijst hetzelfde uit, en juist daar ontstaat het valse groen — een afgebroken meting die als
 * een gezonde toestand wordt gelezen.
 */
export const EVENT_UITKOMSTEN = Object.freeze(['GEACCEPTEERD', 'GEWEIGERD', 'AFGEBROKEN', 'GEEN']);

/** Wat de kijk als geheel kan zeggen. GEEN OORDEEL is een volwaardige uitkomst, geen foutafhandeling. */
export const UITKOMSTEN = Object.freeze(['GROEN', 'PARTIAL', 'ROOD', 'GEEN OORDEEL']);

/**
 * Gesloten lijst met redenen, elk met één zin in gewone taal. Deze zinnen mogen publiek worden, dus
 * er staat geen pad, geen adres en geen naam in — en er is geen enkele manier om er vrije tekst aan
 * toe te voegen. Dat is precies de eis "geen vrije publieke tekst: alleen gesloten velden en
 * goedgekeurde reasonCodes".
 *
 * De lijst is BEVROREN, en dat is geen stijlkeuze. `const` bindt de naam, niet de inhoud: één regel
 * `REDENEN.ALLES_STIL = 'incident bij klant X op /vrij/pad'` in dezelfde procesruimte en die tekst
 * rolt letterlijk uit `publiekeRegel` de publieke plaat op. Gemeten, en daarmee de laatste route
 * waarlangs vrije publieke tekst nog bestond. Om dezelfde reden is elke andere gesloten lijst in dit
 * bestand bevroren: `LANES.push('VRIJE TEKST ALS SPOOR')` werkte net zo goed.
 */
export const REDENEN = Object.freeze({
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
  KLOK_ONBEKEND: 'er is geen betrouwbaar tijdstip om de versheid aan te meten',
  TOESTAND_NIET_BIJ_BYTES: 'de aangeleverde toestand hoort niet bij de aangeleverde bytes',
  ALLES_STIL: 'alle sporen zwijgen al langer dan afgesproken',
  TOESTAND_NIET_BIJ_BRON: 'de aangeleverde toestand hoort niet bij de bron die is gelezen',
  TIJD_UIT_DE_TOEKOMST: 'de bron draagt een tijdstip dat nog niet geweest is',
  TOESTAND_ONBEKEND: 'de bron noemt een toestand die niet in de vastgelegde lijst staat',
  HASHFOUT: 'de meegeleverde controlesom hoort niet bij de inhoud',
  GETUIGE_ONBRUIKBAAR: 'de onafhankelijke getuige leverde iets aan dat niet te lezen is',
  DREMPEL_ONBRUIKBAAR: 'de afgesproken stiltedrempel is geen bruikbaar aantal milliseconden',
});

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
export const LANES = Object.freeze([
  'ARCHEOLOGIE', 'AUTOPILOT', 'CHIEF', 'COMMAND-CANON', 'CONTENT', 'CONTROL', 'DASHBOARD',
  'INSTROOM', 'MARKT', 'MINI', 'NQ-RADAR', 'ORCHESTRATOR', 'PRESENTATIES', 'TRECHTER', 'WAARNEMER',
]);

const UUR = 3600 * 1000;

/**
 * Hoe lang een spoor mag zwijgen voordat het "verouderd" heet, ALS er ondertussen andere sporen
 * melden. Zonder die tweede voorwaarde zou een rustige nacht acht rode meldingen opleveren; met die
 * voorwaarde betekent stilte alleen iets wanneer aantoonbaar iemand anders wél doorwerkte.
 */
export const LANE_STIL_UREN = 6;

/**
 * Hoeveel een bronmoment vóór mag lopen op de klok van de lezer zonder dat het een bevinding is. Vijf
 * minuten dekt de gewone speling tussen twee machines; alles daarboven is geen speling meer maar een
 * tijd die nog niet geweest is — en juist die zet de stiltemeting uit, want één rij van volgende week
 * maakt elk werkelijk stilstaand spoor "recent".
 */
export const TOEKOMST_MARGE = 5 * 60 * 1000;

/**
 * Het korte operationele venster van de "kijk", STRENG GESCHEIDEN van de vijftien uur waarmee
 * `waarnemer.mjs` de gezondheid van de plaat beoordeelt (KIJK-FIXEN-V2, laatste bouwpunt). Die
 * vijftien uur is er omdat er 's nachts niet gebouwd wordt; hem hier hergebruiken zou betekenen dat
 * "kijk" een pagina van veertien uur oud groen noemt. Dit is een andere vraag met een ander antwoord:
 * bij een kijk telt alleen of de kop, de toestand en de teller nú kloppen, en de tijd doet niet mee.
 */
export const KIJK_SLO_MINUTEN = 20;

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** Is dit een volledige commit-aanduiding? Zeven tekens is geen bewijs: een prefix kan botsen. */
export const volledigeSha = (v) => typeof v === 'string' && HEX40.test(v);

/** Is dit een volledige toestandshash? */
export const volledigeStateSha = (v) => typeof v === 'string' && HEX64.test(v);

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
  // Zoek NIET één antwoord, maar TEL de antwoorden. De twee verschuivingen die rond dit moment kunnen
  // gelden staan een halve dag ervoor en erna; elke kandidaat levert een moment op, en dat moment telt
  // alleen mee als de zone dáár ook echt die verschuiving heeft. Zo komt het aantal geldige momenten
  // eruit rollen in plaats van dat er één gekozen moet worden.
  const kandidaten = new Set([zoneVerschuiving(alsUtc - 12 * UUR), zoneVerschuiving(alsUtc + 12 * UUR)]);
  const momenten = new Set();
  for (const verschuiving of kandidaten) {
    const t = alsUtc - verschuiving;
    if (zoneVerschuiving(t) === verschuiving) momenten.add(t);
  }

  // GEEN of TWEE antwoorden is geen antwoord, en dat is een verandering ten opzichte van de vorige
  // opzet. Die zette een niet-bestaande tijd (02:30 in de nacht waarin 02:00 meteen 03:00 wordt) vast
  // op het moment van de sprong, en gaf een dubbele tijd (02:30 in de nacht die twee keer voorkomt)
  // stilzwijgend de eerste van de twee. Beide zijn een VERZONNEN moment: de bron zegt niet welk van de
  // twee, en bij een gat zegt de bron iets dat niet bestaat. Gemeten uitwerking van het oude gedrag:
  // `2026-10-25 02:30` werd 01:30 UTC terwijl 00:30 UTC even goed kon, en de rij werd zonder één
  // opmerking geaccepteerd — verworpen: 0. Een uur ernaast is genoeg om een spoor "vers" te noemen dat
  // het niet is. Hier levert het `null`, en `kijkStateUitSpiegel` verwerpt de rij; verwerping is
  // zichtbaar (`verworpenRijen`) en maakt de uitkomst rood, dus onwetendheid wordt niet stil.
  if (momenten.size !== 1) return null;
  return [...momenten][0];
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
  // Een geworpen fout is GEEN gesloten uitkomst. Zonder dit vangnet verwierp deze functie bij de
  // eerste netwerkstoring de belofte, en dan bestaat er helemaal geen uitkomst meer om over te
  // oordelen: de aanroeper valt om, en wat de aanroeper daarna met die fout doet is niet hier
  // vastgelegd. Gemeten: een `kopVan` die gooit gaf `Error kapot` in plaats van een reden. Precies de
  // route uit rode proef 8 (API-timeout/403/404) waarvan de opdracht eist dat hij op GEEN OORDEEL
  // uitkomt en nooit op gecacht groen. Elke wacht hieronder loopt daarom door hetzelfde net.
  const veilig = async (fn, reden) => {
    try {
      return await fn();
    } catch {
      // De fout zelf gaat niet mee naar buiten: hij kan een adres, een token of een responsdeel
      // bevatten, en alles wat deze functie teruggeeft kan publiek worden.
      return { ok: false, reden };
    }
  };
  for (let poging = 1; poging <= pogingen; poging += 1) {
    const kop = await veilig(() => kopVan(), 'KOP_ONBEPAALBAAR');
    if (!kop || kop.ok !== true) return { ok: false, reden: 'KOP_ONBEPAALBAAR', pogingen: poging, geprobeerd };
    if (!volledigeSha(kop.sha)) return { ok: false, reden: 'KOP_ONGELDIG', pogingen: poging, geprobeerd };

    const inhoud = await veilig(() => inhoudVan(kop.sha), 'ONBEREIKBAAR');
    if (!inhoud || inhoud.ok !== true) {
      return { ok: false, reden: inhoud?.reden === 'LEEG' ? 'BRON_LEEG' : 'BRON_ONBEREIKBAAR', pogingen: poging, geprobeerd };
    }

    const naKop = await veilig(() => kopVan(), 'KOP_ONBEPAALBAAR');
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

  // Tellen gebeurt over de KANDIDATEN en niet over de geaccepteerde rijen. Het verschil is niet
  // theoretisch: de vormtoets van de spiegel gooit een rij met een niet-bestaande datum (`2026-02-30`)
  // weg vóórdat deze lus hem ooit ziet, dus zonder deze lezing verdween zo'n rij ongeteld én schoof
  // elke positie erna een plaats op. Twee bronrijen leverden dan één spoor met teller 1, en niets in
  // de toestand verried dat er iets weg was. Dat is dezelfde stille verdwijning als de 41 van de 54.
  for (const r of spiegelScan(String(tekst ?? '')).kandidaten) {
    teller += 1;
    if (r === null) { fouten.push('VELD_NIET_GESLOTEN'); continue; }
    const laneId = ontdaan(r.tab ?? '');
    const status = ontdaan(r.status ?? '');
    if (!LANES.includes(laneId)) { fouten.push('VELD_NIET_GESLOTEN'); continue; }
    const toestand = OVERGANG_TOESTAND[status];
    if (toestand === undefined) { fouten.push('TOESTAND_ONBEKEND'); continue; }
    const moment = momentUitNlTijd(ontdaan(r.datum ?? ''));
    // De vormtoets van de spiegel liet deze rij door, maar de tijdlezing hier komt er niet uit. Dat is
    // onenigheid tussen twee lezers over dezelfde bytes, en dan is de rij niet vast te stellen. Zonder
    // deze regel belandde er een spoor met een lege tijd in de toestand, en een toestand waarin geen
    // enkele tijd staat glipt langs élke stiltemeting — die meet immers niets als er niets te meten is.
    if (moment === null) { fouten.push('VELD_NIET_GESLOTEN'); continue; }
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
      momentUtc: new Date(moment).toISOString(),
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
const STATE_SLEUTELS = Object.freeze(['schemaVersie', 'bronSoort', 'bronCommitSha', 'eventHighWatermark', 'eventCount', 'verworpenRijen', 'lanes']);
const LANE_SLEUTELS = Object.freeze(['laneId', 'sequence', 'objectId', 'toestand', 'eventUitkomst', 'momentUtc']);

export function keurState(state) {
  const fouten = [];
  if (!state || typeof state !== 'object') return { ok: false, fouten: ['BRON_ONLEESBAAR'] };
  if (state.schemaVersie !== KIJK_SCHEMA) fouten.push('VELD_NIET_GESLOTEN');

  // Onbekende velden worden GEWEIGERD, niet genegeerd. Zonder deze regel rust de belofte "geen vrije
  // publieke tekst" alleen op de huidige vertaler: wie er een `onderwerp` met brontekst bij zet, kreeg
  // een geldig verklaarde toestand die gehasht en weggeschreven werd. Het schema hoort de garantie te
  // dragen, niet de ene functie die hem nu toevallig invult.
  if (Object.keys(state).some((k) => !STATE_SLEUTELS.includes(k))) fouten.push('VELD_NIET_GESLOTEN');

  // Een gesloten SLEUTELlijst is niet hetzelfde als een gesloten WAARDEdomein, en dat verschil was een
  // gat: een toestand met `bronSoort: "klant Van der Berg"` en `bronCommitSha: "/Users/…/geheim"`
  // haalde de keuring, werd gehasht en kwam als groen naar buiten. De sleutels waren immers precies de
  // afgesproken zeven. Elk van deze drie velden gaat de publieke kant op, dus elk heeft een domein.
  if (state.bronSoort !== OVERGANG_MERK) fouten.push('VELD_NIET_GESLOTEN');
  if (state.bronCommitSha !== null && !volledigeSha(state.bronCommitSha)) fouten.push('VELD_NIET_GESLOTEN');
  if (!Number.isInteger(state.eventCount) || state.eventCount < 0) fouten.push('VELD_NIET_GESLOTEN');

  // Een toestand zonder enig spoor is geen gezonde toestand maar een mislukte lezing. Er valt niets te
  // vergelijken, dus er valt niets goed te keuren.
  // `Array.isArray` staat er expliciet bij: een array is ook een object, en `state.lanes = []` haalde
  // daardoor de vormtoets. Wat daarna volgt rekent op sleutels die een spoor heten.
  if (!state.lanes || typeof state.lanes !== 'object' || Array.isArray(state.lanes)
    || Object.keys(state.lanes).length === 0) {
    fouten.push('GEEN_SPOREN');
  }
  if (!Number.isInteger(state.eventHighWatermark) || state.eventHighWatermark < 0) fouten.push('VELD_NIET_GESLOTEN');
  // Verworpen rijen zijn een schemafout van de BRON, geen ruis van de lezer: er staat iets in de
  // spiegel dat het gesloten schema niet kent, en zolang dat zo is dekt de state de bron niet.
  // `?? 0` stond hier en dat maakte het veld optioneel: een toestand zónder `verworpenRijen` kreeg er
  // stilzwijgend een nul bij en haalde de keuring. Precies het veld dat moet melden dát er iets is
  // afgekeurd, mocht dus ontbreken. Het is nu verplicht aanwezig en verplicht nul.
  const verworpen = state.verworpenRijen;
  if (!Number.isInteger(verworpen) || verworpen !== 0) fouten.push('VELD_NIET_GESLOTEN');
  for (const [sleutel, lane] of Object.entries(state.lanes ?? {})) {
    if (!lane || typeof lane !== 'object' || Array.isArray(lane)) { fouten.push('VELD_NIET_GESLOTEN'); continue; }
    if (!LANES.includes(sleutel) || lane.laneId !== sleutel) { fouten.push('VELD_NIET_GESLOTEN'); continue; }
    if (Object.keys(lane).some((k) => !LANE_SLEUTELS.includes(k))) fouten.push('VELD_NIET_GESLOTEN');
    if (!TOESTANDEN.includes(lane.toestand)) fouten.push('TOESTAND_ONBEKEND');
    if (!EVENT_UITKOMSTEN.includes(lane.eventUitkomst)) fouten.push('VELD_NIET_GESLOTEN');
    if (!Number.isInteger(lane.sequence) || lane.sequence < 1) fouten.push('VELD_NIET_GESLOTEN');
    // De objectaanduiding moet uit gesloten delen zijn opgebouwd. Zonder deze toets zou hier alsnog
    // vrije tekst binnenkomen langs een veld dat "technisch" heet.
    if (lane.objectId !== `${sleutel}#${lane.sequence}`) fouten.push('VELD_NIET_GESLOTEN');
    // Een spoor MOET een tijd dragen; `null` was hier toegestaan en dat was de laatste fail-open route
    // van de tweede review. Elke stiltemeting rekent over de tijden die er zijn, dus een toestand
    // waarin ze allemaal ontbreken meet niets en komt als GROEN naar buiten — gemeten: twee sporen van
    // een halfjaar oud, `momentUtc` op null, uitkomst GROEN met een lege redenenlijst. De vorm alléén
    // controleren volstond niet, want de afwezigheid glipte langs de vormtoets heen.
    // De vorm alléén volstaat niet: `Date.parse` rekent 30 februari stilzwijgend om naar 2 maart, dus
    // een onmogelijke kalenderdatum haalde de toets en kwam in de publieke toestand terecht. De
    // heenweg wordt daarom teruggerekend en moet exact opleveren wat er stond — dezelfde eis die
    // `momentUitNlTijd` aan de bronkant al stelt.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(String(lane.momentUtc))
      || Number.isNaN(Date.parse(lane.momentUtc))
      || new Date(Date.parse(lane.momentUtc)).toISOString() !== lane.momentUtc) {
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

const MANIFEST_SLEUTELS = ['schemaVersie', 'bronSoort', 'bronCommitSha', 'bronBlobSha',
  'eventHighWatermark', 'eventCount', 'generatedAt', 'stateSha256'];

/**
 * Het manifest wordt naast de toestand gepubliceerd en werd nergens gekeurd — alleen de hash erin
 * werd gebruikt. Gemeten: een manifest met een klantnaam in `generatedAt` en een lokaal pad in
 * `bronBlobSha` kwam er als GROEN uit, want `manifestDekt` kijkt naar één veld. Het manifest gaat de
 * publieke kant op en heeft dus hetzelfde gesloten schema nodig als de toestand zelf.
 */
export function keurManifest(manifest, state = null) {
  const fouten = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, fouten: ['BRON_ONLEESBAAR'] };
  }
  if (Object.keys(manifest).some((k) => !MANIFEST_SLEUTELS.includes(k))) fouten.push('VELD_NIET_GESLOTEN');
  if (manifest.schemaVersie !== KIJK_SCHEMA) fouten.push('VELD_NIET_GESLOTEN');
  if (manifest.bronSoort !== OVERGANG_MERK) fouten.push('VELD_NIET_GESLOTEN');
  if (!volledigeSha(manifest.bronCommitSha)) fouten.push('VELD_NIET_GESLOTEN');
  if (manifest.bronBlobSha !== null && !volledigeSha(manifest.bronBlobSha)) fouten.push('VELD_NIET_GESLOTEN');
  if (!Number.isInteger(manifest.eventHighWatermark) || manifest.eventHighWatermark < 0) fouten.push('VELD_NIET_GESLOTEN');
  if (!Number.isInteger(manifest.eventCount) || manifest.eventCount < 0) fouten.push('VELD_NIET_GESLOTEN');
  if (typeof manifest.stateSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.stateSha256)) {
    fouten.push('VELD_NIET_GESLOTEN');
  }
  // `generatedAt` is de enige vrije-ogende tekst in het manifest en dus de plek waar een klantnaam of
  // een incidentregel binnenkomt. Een tijdstempel is geen vrij veld: hij moet exact terugrekenen.
  if (typeof manifest.generatedAt !== 'string'
    || Number.isNaN(Date.parse(manifest.generatedAt))
    || new Date(Date.parse(manifest.generatedAt)).toISOString() !== manifest.generatedAt) {
    fouten.push('VELD_NIET_GESLOTEN');
  }
  // Waar manifest en toestand hetzelfde beweren, moeten ze het ook eens zijn. Twee bewijsstukken die
  // uiteenlopen zijn geen twee bewijzen maar één tegenspraak.
  if (state) {
    if (manifest.eventHighWatermark !== state.eventHighWatermark) fouten.push('VELD_NIET_GESLOTEN');
    if (manifest.eventCount !== state.eventCount) fouten.push('VELD_NIET_GESLOTEN');
    if (manifest.bronSoort !== state.bronSoort) fouten.push('VELD_NIET_GESLOTEN');
  }
  return { ok: fouten.length === 0, fouten: [...new Set(fouten)] };
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
    getuigeAanwezig: getuigenis !== null, klokAanwezig: nu !== null,
    verouderdeLanes: [], pogingen: lezing?.pogingen ?? null,
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

  // ── 2a. de klok is óók een bewijsstuk, en zonder klok is er geen uitspraak over versheid mogelijk.
  //
  // Hier stond eerst een optionele klok, waarbij de afwezigheid alleen in `gemeten.klokAanwezig` werd
  // gemeld. De twee reviewfamilies waren het daar aanvankelijk oneens over en zijn dat na deze ronde
  // niet meer: beide wijzen het af, en met dezelfde meting. Een halfjaar oude toestand gaf zónder klok
  // GROEN en mét klok PARTIAL/ALLES_STIL, dus de uitkomst hing af van een weglating. `NaN` was nog
  // erger: dat meldde `klokAanwezig: true` én GROEN, want elke vergelijking met NaN is onwaar. Een
  // ontbrekend bewijsstuk hoort in GEEN OORDEEL te landen — dat is de hele regel, en de klok is geen
  // uitzondering erop.
  if (!Number.isFinite(nu)) {
    redenen.push('KLOK_ONBEKEND');
    return uit('GEEN OORDEEL');
  }

  // ── 2a-bis. de drempel is dat ook. Zonder deze toets kon de versheidsmeting van buitenaf worden
  // uitgezet zonder één zichtbaar spoor: `stilMs: NaN` maakt elke vergelijking onwaar, en `Infinity`
  // maakt geen enkele stilte lang genoeg. Gemeten op dezelfde bytes: normaal PARTIAL met ALLES_STIL,
  // met NaN GROEN en met Infinity GROEN, redenen leeg. Dat is dezelfde fout als bij de klok — een
  // ontbrekend of onbruikbaar bewijsstuk dat zich voordoet als een schone meting. Negatief is
  // evenmin een drempel: dan is élk spoor per definitie te stil. Nul mag: dat betekent "geen respijt".
  if (!Number.isFinite(stilMs) || stilMs < 0) {
    redenen.push('DREMPEL_ONBRUIKBAAR');
    return uit('GEEN OORDEEL');
  }

  // ── 2a-ter. en een aangeleverde getuigenis is ook bewijs, dus die moet leesbaar zijn.
  //
  // De vorige opzet gebruikte `Number.isInteger(...)` verderop als stille zeef: een getuigenis met
  // `sequence: 'geen getal'` meldde `getuigeAanwezig: true`, deed vervolgens niets, en kwam er GROEN
  // uit met lege redenen — gemeten. Dat is de gevaarlijkste vorm die er is, want de meting ziet er
  // bewaakt uit terwijl de bewaking uit staat, en juist de twee toetsen die hij aanstuurt zijn de
  // enige die bederf zien dat bron en pagina samen verbergen. Een getuige die nog niets weet hoort
  // `null` te sturen, niet een half ingevuld geheugen. Alle drie de velden moeten er zijn: de opdracht
  // vraagt de getuige de laatst geziene sequence, commit én hash te bewaren, en met twee ervan is de
  // tweede toets blind.
  if (getuigenis !== null) {
    const leesbaar = typeof getuigenis === 'object' && !Array.isArray(getuigenis)
      && Number.isInteger(getuigenis.sequence) && getuigenis.sequence >= 0
      && volledigeSha(getuigenis.commitSha) && volledigeStateSha(getuigenis.stateSha256);
    if (!leesbaar) {
      redenen.push('GETUIGE_ONBRUIKBAAR');
      return uit('GEEN OORDEEL');
    }
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

  // ── 2d. en horen toestand én manifest bij de BRON die zojuist gelezen is?
  //
  // Tot hier sloot de ketting op zichzelf: manifest ↔ bytes ↔ toestand. Wat nergens vastlag, is dat
  // die ketting iets zegt over de lezing die ernaast lag. Aangetoond: lezing op kop A, toestand plus
  // bytes plus manifest van kop B, pagina die netjes A als commit en B als hash noemt — en dat kwam er
  // als GROEN uit, want elke schakel klopte met de volgende. Een bewijs dat niet aan de bron vastzit
  // bewijst alleen zichzelf.
  if (state.bronCommitSha !== lezing.sha || manifest.bronCommitSha !== lezing.sha) {
    redenen.push('TOESTAND_NIET_BIJ_BRON');
    return uit('GEEN OORDEEL');
  }

  // ── 2d-bis. het manifest draagt óók een bronblob-SHA, en die werd nergens tegen de lezing gehouden.
  //
  // Het veld staat er niet voor niets: de commit zegt uit welke wereld de bron komt, de blob zegt welk
  // BESTAND daarin gelezen is. Gemeten: een lezing met blob `cccc…` en een manifest met blob `bbbb…`
  // kwam er GROEN uit, redenen leeg — het veld werd geschreven en daarna nooit gelezen. Zolang de
  // spiegel de bron is dekt de herleiding hieronder dat af, maar zodra het OVERGANG-merk vervalt is
  // deze vergelijking precies de binding die ervoor in de plaats komt (zie 2e). Hij weigert alleen als
  // beide kanten iets te zeggen hebben: ontbreekt één van de twee, dan is er niets vergeleken en gaat
  // die weglating verderop door de gewone weg.
  if (manifest.bronBlobSha && lezing.blobSha && manifest.bronBlobSha !== lezing.blobSha) {
    redenen.push('TOESTAND_NIET_BIJ_BRON');
    return uit('GEEN OORDEEL');
  }

  // ── 2e. en dat was NOG steeds een vergelijking van etiketten, niet van inhoud.
  //
  // Twee claims die hetzelfde commitlabel dragen bewijzen alleen dat iemand tweemaal hetzelfde heeft
  // opgeschreven. Gemeten: een toestand afgeleid uit bron B, gestempeld met de SHA van de zojuist
  // gelezen bron A, met een intern kloppend manifest en een kloppende pagina — uitkomst GROEN, terwijl
  // de toestand nergens uit de gelezen tekst volgde. Zolang de spiegel de bron IS, moet de toestand
  // exact uit de gelezen tekst te herleiden zijn; dat is de enige binding die niet op een etiket rust.
  //
  // De toets hangt aan het OVERGANG-merk: zodra de exporter uit task_events publiceert komt de
  // toestand niet meer uit deze tekst, en dan hoort hier de bron-blobhash van het manifest te worden
  // vergeleken in plaats van een herleiding. Tot die tijd geldt de strengere eis.
  if (state.bronSoort === OVERGANG_MERK) {
    const herleid = kijkStateUitSpiegel(lezing.tekst, { commitSha: lezing.sha }).state;
    if (!kanoniekeBytes(herleid).equals(kanoniekeBytes(state))) {
      redenen.push('TOESTAND_NIET_BIJ_BRON');
      return uit('GEEN OORDEEL');
    }
  }

  // ── 2f. en het manifest zelf gaat óók publiek, dus het heeft hetzelfde gesloten schema nodig.
  const manifestKeuring = keurManifest(manifest, state);
  if (!manifestKeuring.ok) {
    redenen.push(...manifestKeuring.fouten);
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
    if (state.eventHighWatermark < getuigenis.sequence) {
      redenen.push('WATERMERK_DAALT');
    } else if (state.eventHighWatermark === getuigenis.sequence
      && manifest && getuigenis.stateSha256 !== manifest.stateSha256) {
      redenen.push('TOESTAND_WISSELT_BIJ_GELIJKE_STAND');
    }
  }

  // ── 5c. draagt de bron een tijdstip dat nog niet geweest is? Dat is geen stilte maar een onmogelijke
  // meting, en zonder deze toets is het bovendien de goedkoopste manier om de stiltemeting uit te
  // zetten: één rij met een tijd van volgende maand maakt elk werkelijk stilstaand spoor "recent".
  // `state.lanes` wordt hier gelezen terwijl de keuring erboven al kan hebben gefaald, en die keuring
  // schrijft alleen een reden op zonder terug te keren. Met `lanes: null` of één spoor op `null` gooide
  // dit een TypeError — en een lezer die fail-closed hoort te zijn maar een uitzondering gooit heeft
  // helemaal geen uitkomst: wat de aanroeper daarmee doet ligt buiten dit contract. Vandaar de
  // vraagtekens; de keuring zelf houdt de bevinding vast.
  const momenten = Object.values(state.lanes ?? {})
    .map((l) => (l?.momentUtc ? Date.parse(l.momentUtc) : null))
    .filter((t) => t !== null && !Number.isNaN(t));
  if (momenten.some((t) => t > nu + TOEKOMST_MARGE)) redenen.push('TIJD_UIT_DE_TOEKOMST');

  if (redenen.length) return uit('ROOD');

  // ── 6. de twee stiltevragen, en ze worden SAMEN beantwoord.
  //
  // (a) Staat alles stil? De onderlinge meting hieronder heeft een blinde vlek waar beide reviewers
  //     onafhankelijk op wezen: stoppen alle sporen tegelijk — de orchestrator valt om, de stroom valt
  //     weg — dan is hun onderlinge afstand nul en is er dus geen enkel verouderd spoor. Precies de
  //     totale uitval kwam er zo als GROEN uit. Vandaar één absolute vloer. Dat de klok er is, is
  //     hierboven bij stap 2a al afgedwongen: zonder klok is er geen oordeel, dus ook geen groen.
  // (b) Zwijgt één spoor terwijl de rest doormeldt?
  //
  // Eerst stond (a) vóór (b) met een eigen `return`, en dat maskeerde (b): bij totale uitval verdween
  // de bevinding dat MINI daarbovenop al acht uur langer zweeg dan de rest. Twee verschillende
  // waarnemingen horen niet om voorrang te strijden; ze horen allebei in dezelfde uitkomst te staan.
  const allesStil = momenten.length > 0 && nu - Math.max(...momenten) > stilMs;
  const stil = verouderdeLanes(state, stilMs);
  gemeten.verouderdeLanes = allesStil
    ? [...new Set([...Object.keys(state.lanes ?? {}), ...stil])].sort()
    : stil;
  if (allesStil) redenen.push('ALLES_STIL');
  if (stil.length) redenen.push('LANE_VEROUDERD');
  if (redenen.length) return uit('PARTIAL');
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
