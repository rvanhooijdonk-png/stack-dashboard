/**
 * PLANNING-BRON — de vertaler van TRECHTER's bouwlijst naar het plaat-schema (§B).
 *
 * Waarom deze module bestaat. De plaat (`planning.mjs`) leest het §B-schema: `features[]` met een
 * status uit een gesloten lijst, een neutrale worker-rol, een `throughput_klasse` en een `af_sinds`.
 * Wat TRECHTER levert is een ánder data-product: `data/planning-bouwlijst.json` met `taken[]` —
 * de BACKLOG (wat bouwbaar is, in bouwvolgorde), niet de operationele stand. Die feed heeft geen
 * worker, geen doorlooptijd-klasse, geen opleverdatum, en zijn `status` is voor élk item `READY`
 * ("bouwbaar"), wat iets anders betekent dan de plaat-status `in-bouw`. Rechtstreeks doorgeven zou
 * de plaat leeg maken (geen `features`-sleutel) of, geforceerd, een verkeerde stand tonen.
 *
 * Deze vertaler is de OVERBRUGGING (besluit A): tot er een echte execution-queue-export in §B-vorm
 * is, vult de backlog de plaat — eerlijk als backlog. Vandaar de kern-afspraak:
 *
 *   ALLES KOMT OP `gepland`. Niet één regel krijgt hier een uitvoerings-status. Een backlog weet niet
 *   wat er draait; dat weet straks de execution-queue. Zolang de vertaler dat niet kan weten, is
 *   `gepland` de enige eerlijke waarde, en blijft de kop-band (draait nu / wacht op Richard) leeg.
 *
 * Wat WEL uit de bron komt: de bouwvolgorde (die laten we ongemoeid — TRECHTER sorteert spoedspoor
 * eerst), de spoedspoor-markering (`prioriteit_tier === 0`) en de eigen duur-indicatie van de bron.
 * Die laatste is expliciet géén tweede meetsysteem: hij wordt niet naar een datum herrekend en niet
 * met het THROUGHPUT-LOG vermengd — hij gaat door als de startschatting van de bron, met bronvermelding.
 *
 * Fail-closed, in twee sterktes:
 *  - HARD (hele plaat afgekeurd, `CORRUPT`): alles wat betekent dat de feed iets anders is geworden
 *    dan we denken. Een onbekende `status`, een als twijfel gemarkeerde regel (de anti-stille-promotie-
 *    invariant van de bron zelf), een regel zonder leesbare naam, een tier die geen getal is. Liever
 *    een lege plaat met een melding dan 693 regels waarvan de betekenis niet meer vaststaat.
 *  - ZACHT (veld op null): een waarde die alleen dít veld raakt, niets verkeerd kan zeggen zolang hij
 *    wegvalt, en die de bron ook echt als optioneel bedoelt. Hier is dat alleen het aantal
 *    afhankelijkheden: een getal is geen tekst die zegt waarop iets wacht, dus dat veld blijft leeg.
 *    Nooit vrije tekst doorlaten, nooit een waarde raden.
 *
 * De duur-indicatie is bewust HARD: zodra hij op de plaat staat, is die gesloten lijst een contract met
 * de bron. Een nieuwe waarde is dan een contractwijziging die iemand moet zien, niet een veld dat stil
 * op een streepje valt (review Codex, 25-07-2026).
 */

import { DUUR_INDICATIES } from './planning.mjs';
import { sanitizeString } from './sanitize.mjs';
import { toetsLabel } from './labeltoets.mjs';

/** De enige status die de backlog-feed kent. Iets anders = de feed betekent iets anders dan we denken. */
export const BRON_STATUS_READY = 'READY';

/** Elke bouwbare regel wordt op de plaat een geplande regel. Eén waarde, expliciet als constante. */
export const PLAAT_STATUS_GEPLAND = 'gepland';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function onbeschikbaar(reason, note) {
  return { available: false, reason, note, generatedAt: null, features: [], throughput: {}, kanaalpost: [] };
}

/**
 * Een sha-achtige verwijzing is hex; alles anders laten we vallen i.p.v. door te geven.
 * Hoofdletters zijn geldige hex: eerst normaliseren naar kleine letters, dan toetsen — anders valt een
 * `E0049DC` stil weg naar `null` terwijl het een correcte sha is (review Gemini, 25-07-2026).
 */
const korteSha = (v) => {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(s) ? s.slice(0, 12) : null;
};

/**
 * Vertaal één bouwlijst-taak naar een §B-feature. GOOIT bij een harde poort-schending; de caller keurt
 * dan de hele plaat af. Export zodat de tests elke poort los kunnen bewijzen.
 */
export function vertaalTaak(t, index) {
  const nr = index + 1;
  if (!isObject(t)) throw new Error(`planning-bron: taak ${nr} is geen object`);
  if (t.status !== BRON_STATUS_READY) {
    throw new Error(`planning-bron: taak ${nr} heeft status "${String(t.status)}", niet ${BRON_STATUS_READY}`);
  }
  // De bron markeert zelf welke regels nog twijfel zijn en houdt die BUITEN de bouwlijst (zijn eigen
  // anti-stille-promotie-invariant). We eisen de vlag EXPLICIET op `false` — een ontbrekende of null-vlag
  // is geen bewijs van "geen twijfel", en juist bij deze invariant mag afwezigheid niet als groen lezen
  // (review Codex, 25-07-2026). Een gemarkeerde twijfel promoveren wij hier zeker niet stil naar de plaat.
  if (t.is_twijfel !== false) {
    throw new Error(`planning-bron: taak ${nr} heeft geen expliciete is_twijfel=false`);
  }
  if (typeof t.task_id !== 'string' || t.task_id.trim() === '') {
    throw new Error(`planning-bron: taak ${nr} mist een task_id`);
  }
  if (typeof t.feature_label !== 'string' || t.feature_label.trim() === '') {
    throw new Error(`planning-bron: taak ${nr} mist een leesbare naam`);
  }
  if (!Number.isInteger(t.prioriteit_tier) || t.prioriteit_tier < 0) {
    throw new Error(`planning-bron: taak ${nr} heeft geen geldige prioriteit_tier`);
  }
  // Hard, niet zacht: deze waarde wordt getoond, dus de gesloten lijst is een contract met de bron.
  if (!DUUR_INDICATIES.includes(t.verwachte_duur)) {
    throw new Error(`planning-bron: taak ${nr} heeft een duur-indicatie buiten de gesloten lijst`);
  }
  const duur = t.verwachte_duur;
  return {
    task_id: t.task_id.trim(),
    // Het label wordt in `publicFeature` getrimd en gecapt; hier alleen doorgeven.
    feature_label: t.feature_label,
    status: PLAAT_STATUS_GEPLAND,
    // Een backlog wijst niemand toe. `null` = nog niet toegewezen — geen rol raden.
    worker: null,
    // Geen throughput_klasse in de bron ⇒ de oplevering wordt `onbekend`. Bewust: `verwachte_duur` naar
    // een gemeten doorlooptijd mappen zou een tweede meetsysteem zijn (D-0023 is de enige meetlat).
    throughput_klasse: null,
    af_sinds: null,
    // De bron heeft alleen een AANTAL afhankelijkheden, geen tekst die zegt waarop iets wacht. Een
    // tekst maken van een getal zou iets beweren wat er niet staat.
    afhankelijkheid: null,
    tier0: t.prioriteit_tier === 0,
    duur_indicatie: duur,
  };
}

/**
 * Vertaal de rauwe bouwlijst-tekst naar dezelfde vorm die `parsePlanning` oplevert, zodat
 * `toPublicPlanning` er ongewijzigd mee verder kan. Leeg/onleesbaar/andere vorm ⇒ nette
 * onbeschikbaarheid (LEEG/CORRUPT), nooit een throw naar de build.
 */
export function vertaalBouwlijst(rawText) {
  if (typeof rawText !== 'string' || rawText.trim() === '') {
    return onbeschikbaar('LEEG', 'Bouwlijst-bestand is leeg of ontbreekt.');
  }
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    return onbeschikbaar('CORRUPT', 'Bouwlijst-bestand is geen geldige JSON.');
  }
  if (!isObject(data)) {
    return onbeschikbaar('CORRUPT', 'Bouwlijst-bestand heeft niet de verwachte vorm.');
  }
  // Een `taken` van het verkeerde TYPE is geen leegte maar een schema-afwijking: de feed is iets anders
  // geworden dan we denken. Dat als LEEG tonen zou het maskeren (review Codex, 25-07-2026). Alleen een
  // ontbrekende of lege lijst is echte leegte.
  if (data.taken !== undefined && !Array.isArray(data.taken)) {
    return onbeschikbaar('CORRUPT', 'Bouwlijst heeft geen taken-lijst maar een andere vorm.');
  }
  if (!Array.isArray(data.taken) || data.taken.length === 0) {
    return onbeschikbaar('LEEG', 'Bouwlijst bevat nog geen taken.');
  }
  const nat = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  const bouwbaar = nat(data.totaal_bouwbaar);
  const publishVeilig = nat(data.publish_veilig);
  let features;
  let weggelaten = 0;
  try {
    // De bron doet zelf een publiceerbaarheids-oordeel per taak en houdt het aantal bij. Dat oordeel is
    // onze belangrijkste bescherming tegen semantisch lekken (een klantnaam matcht geen enkel patroon),
    // dus toetsen we of zijn boekhouding klopt met wat hij aflevert (review Codex, 25-07-2026).
    // Bewust ASYMMETRISCH: minder afgeleverd dan veilig-geacht mag (de bron is dan conservatiever dan
    // zijn eigen teller), MEER afgeleverd dan veilig-geacht mag niet — dan zou het surplus ongetoetst
    // op een publieke pagina komen.
    if (publishVeilig !== null && bouwbaar !== null && publishVeilig > bouwbaar) {
      throw new Error('planning-bron: publish_veilig is groter dan totaal_bouwbaar');
    }
    if (publishVeilig !== null && publishVeilig < data.taken.length) {
      throw new Error(
        `planning-bron: bron levert ${data.taken.length} taken maar acht er maar ${publishVeilig} publiceerbaar`,
      );
    }
    // Bouwvolgorde van de bron blijft staan: TRECHTER zet spoedspoor eerst, dan de rest. Zelf
    // hersorteren zou een tweede prioritering introduceren.
    features = data.taken.map((t, i) => vertaalTaak(t, i));
    // Identiteit is `task_id`, niet het label (twee taken mogen dezelfde naam dragen). Een dubbele
    // task_id betekent dat de bron zichzelf tegenspreekt; dan is geen enkele regel meer te vertrouwen.
    const ids = new Set(features.map((f) => f.task_id));
    if (ids.size !== features.length) {
      throw new Error('planning-bron: dubbele task_id in de bouwlijst');
    }
    // Eén-op-één: elke taak wordt precies één plaatregel. Deze assert kost niets en vangt een latere
    // filter/flatMap-bewerking die stil regels zou laten verdwijnen (review Codex, 25-07-2026).
    if (features.length !== data.taken.length) {
      throw new Error('planning-bron: aantal vertaalde regels wijkt af van het aantal taken');
    }
    // Per-regel schoon-poort vóór de pagina-brede sanitize-gate. De bron levert honderden vrije
    // labels aan; raakt er ooit één een deny-patroon (mailadres, secret-naam, IP), dan zou de
    // strikte gate later de HELE publicatie afbreken — de plaat zou stil verouderen omdat er niets
    // meer gepubliceerd wordt. Zo'n regel valt hier weg en wordt GETELD, nooit stil weggelaten:
    // dezelfde keuze die de bron zelf maakt (3 geblokkeerde labels weggelaten, niet geraden).
    // Gemeten op de echte feed van 25-07-2026: 0 van 693 labels raakt een patroon.
    // Toets het VOLLEDIGE label, niet de afgekapte versie: kapt de cap (MAX_LABEL) een mailadres of
    // token middendoor, dan matcht het patroon niet meer en zou het verminkte restant alsnog op de
    // pagina komen — sanitize vóór afkappen, afkappen pas in `publicFeature` (review Codex + Gemini,
    // 25-07-2026).
    //
    // Daar bovenop de KRANT-TOETS (`labeltoets.mjs`, 26-07-2026). Bij het handmatig nalezen van alle
    // 693 labels bleek de patroon-gate hier veel te dun: de feed bevat privé-, gezondheids-, woon-,
    // geld- en klantregels die geen enkel patroon raken en die niemand op een openbare pagina wil
    // zien. Een naam-blokkeerlijst alleen redt dat niet — de meeste van die regels bevatten geen
    // eigennaam. Vandaar een volledige allowlist-poort: alleen labels waarvan élk woord vooraf
    // beoordeeld is, gaan mee; één onbekend woord houdt de hele regel tegen.
    // Gemeten op de feed van 26-07-2026: 328 van 693 door, 365 ingehouden en geteld.
    const schoon = features.filter(
      (f) => sanitizeString(f.feature_label).findings.length === 0 && toetsLabel(f.feature_label).ok,
    );
    weggelaten = features.length - schoon.length;
    features = schoon;
    if (features.length === 0) {
      throw new Error('planning-bron: geen enkele regel haalde de schoon-poort');
    }
  } catch (err) {
    return onbeschikbaar('CORRUPT', err instanceof Error ? err.message : 'Bouwlijst kon niet worden vertaald.');
  }
  return {
    available: true,
    reason: null,
    note: null,
    // De feed heeft geen eigen bouwmoment; het bouwmoment van de plaat is het bouwmoment van de build.
    generatedAt: null,
    features,
    // Geen throughput-tabel in de backlog-feed: de oplevering blijft `onbekend` i.p.v. verzonnen.
    throughput: {},
    // Kanaalpost hoort bij de operationele stand, niet bij een backlog.
    kanaalpost: [],
    bron: {
      sha: korteSha(isObject(data.meetlat) ? data.meetlat.sha : null),
      bouwbaar,
      publishVeilig,
      weggelaten,
    },
  };
}
