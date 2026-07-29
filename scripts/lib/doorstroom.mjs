/**
 * DOORSTROOM — van bron naar publieke spiegel, per rij, zonder mensenhand in het pad.
 *
 * WAAROM DIT BESTAAT. Gemeten op 2026-07-27 05:00 UTC: zestien spiegelrijen stonden in negen open
 * voorstellen op `data/kanaalpost-publiek.md`; acht daarvan botsten met de hoofdlijn. Dat is geen
 * slordigheid maar de vorm zelf: élk venster vult hetzelfde bestand achteraan aan, dus twee vensters
 * tegelijk botsen per constructie. De uitwijk was een handmatige bundel (#30 → #32 → #33, elk
 * "vervangt" de vorige), en één rij op de verkeerde plek nam er telkens zes mee. Twee dagen lang
 * stond ondertussen alles groen: er was geen enkele toets die van ACHTERSTAND een uitkomst maakte.
 *
 * DE OMKERING. Niet één bestand dat iedereen bewerkt, maar één rij per bestand, en één schrijver die
 * ze overzet. Bestandsnamen botsen niet, dus de botsing verdwijnt bij de bron in plaats van dat hij
 * later opgelost moet worden. En de overzetting oordeelt PER RIJ: een rij die de poort niet haalt
 * blijft liggen met een reden, de rest gaat gewoon door. Dat is het enige wat de bundels nooit
 * konden.
 *
 * WAT DEZE MODULE NIET DOET. Hij haalt niets op en schrijft niets weg — dat doet `scripts/doorstroom.mjs`.
 * Hier zit alleen het oordeel, zodat het te beproeven is zonder netwerk en zonder schijf.
 *
 * DE GRENS MET DE WET. De publieke spiegel is append-only met een harde laag: geen regel die er stond
 * mag verdwijnen (`spiegelwet.mjs`). Deze module voegt daarom uitsluitend TOE, achteraan, en raakt
 * bestaande regels niet aan. De gevraagde VLOOTSTAND-kop is om diezelfde reden geen kop ín dit
 * bestand — een kop die je bijwerkt, verwijdert de vorige — maar een afgeleide stand die de plaat
 * toont. Zie `vlootstand()` onderaan.
 */

import {
  bevatOnzichtbaar, cellenVanRegel, kanoniekeSpiegelvorm, spiegelUitTekst, publiekeRijenUitTekst,
} from './kanaalpost.mjs';

/** Een bronrij die X minuten na aanlevering nog niet gepubliceerd is, is achterstand. */
export const ACHTERSTAND_MINUTEN = 30;
/** Een stempel op de plaat dat ouder is dan Y minuten en niets uitlegt, is rood. */
export const STEMPEL_MINUTEN = 45;
/** Een venster dat zo lang niets meldde, is ONBEKEND — nooit stil groen. */
export const VLOOT_ONBEKEND_MINUTEN = 240;

/** Vier uitkomsten, en `GEEL` bestaat alleen voor "oud MET verklaring". Fail-closed: twijfel is rood. */
export const UITKOMSTEN = ['GROEN', 'GEEL', 'ROOD'];
/** Drie vensterstanden. `WERKT` is de enige die iets belooft, en wordt daarom het strengst verdiend. */
export const VLOOTSTANDEN = ['WERKT', 'LEEG', 'ONBEKEND'];

const KOPNAMEN = ['datum-tijd', 'tab-rol', 'onderwerp', 'status', 'actie voor'];
/** Een melding van bewezen lege voorraad. Vrije tekst, dus ruim herkend en niet op één zin gepind. */
const LEEG_MELDING = /voorraad\s+leeg/i;

// De cellezer van de spiegelwet zelf, niet een tweede uitvoering ernaast. GEMETEN 27-07-2026: deze
// module splitste hard op `|`, dus een rij met `A \| B` in de tekst telde als zes cellen en kreeg
// `GEEN_RIJ` — terwijl de spiegellezer diezelfde rij als vijf nette cellen ziet. Twee lezers die het
// oneens zijn over waar de kolommen liggen is precies wat hier niet mag: de rij werd geweigerd onder
// een reden die niet klopte, en de weigering wees dus naar niets. Sindsdien is er één uitvoering
// (`cellenVanRegel`) en houdt niemand hier een eigen kopie op na.
const cellenVan = (regel) => {
  const c = cellenVanRegel(regel);
  return c && c.length === KOPNAMEN.length ? c : null;
};

const isKop = (c) => c.every((v, i) => v.toLowerCase() === KOPNAMEN[i]);
const isScheiding = (c) => c.every((v) => /^:?-{3,}:?$/.test(v));
const lijktSpiegelrij = (regel) => {
  const c = cellenVan(regel);
  return Boolean(c && !isKop(c) && !isScheiding(c));
};

const regelsVan = (tekst) => String(tekst ?? '').split(/\r\n|\r|\n/);
const minutenTussen = (later, eerder) => Math.floor((later.getTime() - eerder.getTime()) / 60_000);

/**
 * Lees een aangeleverd bestandje: precies één spiegelrij, verder niets dat telt.
 *
 * `{ ok: true, id, regel }` of `{ ok: false, reden }`. Twee rijen in één bestand is een fout en geen
 * gemak: zodra één bestand meerdere rijen mag dragen, is de reden dat bestandsnamen niet botsen weg.
 */
export function bronRijUitTekst(naam, tekst) {
  const kandidaten = regelsVan(tekst).filter((r) => r.trim() !== '' && lijktSpiegelrij(r.trim()));
  if (kandidaten.length === 0) return { ok: false, reden: 'GEEN_RIJ', id: naam };
  if (kandidaten.length > 1) return { ok: false, reden: 'MEER_DAN_EEN_RIJ', id: naam };
  return { ok: true, id: naam, regel: kandidaten[0].trim() };
}

/**
 * Mag deze regel de publieke spiegel in? `null` als hij mag, anders een reden uit een gesloten lijst.
 *
 * De volgorde is niet vrijblijvend: eerst de onzichtbare tekens (die breken geen kolom en glippen dus
 * langs elke vormtoets), dan de kanonieke vorm van de bron, dan de kolomstructuur, en pas als laatste
 * de publicatiepoort die over de INHOUD gaat. Zo draagt de weigering altijd de eerste échte oorzaak.
 */
function weigering(regel) {
  if (bevatOnzichtbaar(regel)) return 'ONZICHTBAAR_TEKEN';
  const vorm = kanoniekeSpiegelvorm(regel);
  if (!vorm.ok) return vorm.reden;
  if (!lijktSpiegelrij(regel)) return 'GEEN_RIJ';
  // Eén regel is geen tabel: de scanner leest alleen onder een echte kop, dus wordt de rij in een
  // minimale tabel gezet om er hetzelfde oordeel over te krijgen als in het echte bestand.
  const proef = [`| ${KOPNAMEN.join(' | ')} |`, '| --- | --- | --- | --- | --- |', regel].join('\n');
  if (spiegelUitTekst(proef).length !== 1) return 'VORM';
  // `publiekeRijenUitTekst` geeft `{ rijen, ingehouden }`: ingehouden is precies het geval waarin de
  // rij wél leesbaar is maar niet publiceerbaar. Dat is een weigering en geen vormfout.
  if (publiekeRijenUitTekst(proef).rijen.length !== 1) return 'POORT';
  return null;
}

/** Staat deze regel er al? Vergelijking op de kale regel: de spiegel is letterlijk, niet semantisch. */
const staatEr = (regels, regel) => regels.some((r) => r.trim() === regel.trim());

/**
 * Zet aangeleverde rijen over naar de spiegel — achteraan, per rij beoordeeld, nooit alles-of-niets.
 *
 * `{ tekst, overgezet, geweigerd, ongewijzigd }`. Een rij die er al staat is géén weigering en géén
 * overzetting: die is gewoon klaar. Is de spiegel zelf onleesbaar, dan gaat er niets over en dragen
 * alle rijen dezelfde reden — een kapot doelbestand repareer je niet door er in te schrijven.
 */
export function overzetting(spiegelTekst, bronRijen = []) {
  const tekst = String(spiegelTekst ?? '');
  const leeg = { tekst, overgezet: [], geweigerd: [], ongewijzigd: true };

  const vorm = kanoniekeSpiegelvorm(tekst);
  if (!vorm.ok) {
    return { ...leeg, geweigerd: bronRijen.map((b) => ({ id: b.id, reden: 'SPIEGEL_ONLEESBAAR' })) };
  }

  const regels = regelsVan(tekst);
  const overgezet = [];
  const geweigerd = [];
  const toe = [];

  for (const b of bronRijen) {
    const regel = String(b?.regel ?? '').trim();
    if (!regel) { geweigerd.push({ id: b?.id ?? null, reden: 'GEEN_RIJ' }); continue; }
    if (staatEr(regels, regel) || toe.includes(regel)) continue;
    const reden = weigering(regel);
    if (reden) { geweigerd.push({ id: b.id, reden }); continue; }
    toe.push(regel);
    overgezet.push({ id: b.id, regel });
  }

  if (toe.length === 0) return { ...leeg, geweigerd };

  // Achter de laatste rij, niet achter het bestand: onder de tabel staat vaak nog een lege regel, en
  // een rij daaronder valt buiten de aaneengesloten tabel en wordt dus door niemand meer gelezen.
  // `isScheiding([])` is waar — `every` op een lege lijst is dat altijd — dus de lege regel onder de
  // tabel gold als scheidingsregel en de nieuwe rij belandde erbuiten. Vandaar de expliciete null.
  let na = -1;
  for (let i = regels.length - 1; i >= 0; i -= 1) {
    const cellen = cellenVan(regels[i].trim());
    if (!cellen) continue;
    if (lijktSpiegelrij(regels[i].trim()) || isScheiding(cellen)) { na = i; break; }
  }
  if (na === -1) return { ...leeg, geweigerd: [...geweigerd, ...toe.map((r) => ({ id: r, reden: 'GEEN_TABEL' }))], overgezet: [] };

  const nieuw = [...regels.slice(0, na + 1), ...toe, ...regels.slice(na + 1)].join('\n');
  return { tekst: nieuw, overgezet, geweigerd, ongewijzigd: false };
}

/**
 * Ligt er bron te wachten die al te lang niet gepubliceerd is?
 *
 * Dit is de toets die twee dagen ontbrak. Hij kijkt niet of de overzetting DRAAIDE maar of hij
 * AANKWAM: een rij die er na `minuten` nog niet staat, is rood — of de machinerie nu foutloos liep of
 * niet. Een onleesbare spiegel is óók rood, want dan is er geen enkele grond om groen te zeggen.
 */
export function achterstandsOordeel(bronRijen = [], spiegelTekst, { nu = new Date(), minuten = ACHTERSTAND_MINUTEN } = {}) {
  const tekst = spiegelTekst === null || spiegelTekst === undefined ? null : String(spiegelTekst);
  const vormBron = tekst === null ? null : kanoniekeSpiegelvorm(tekst);
  if (vormBron === null || !vormBron.ok) {
    // De reden van de vormpoort reist mee. Zonder dat zegt het alarm alleen "onleesbaar", en dan
    // begint de zoektocht bij nul terwijl de poort de plek en de soort al wist. Beide zijn
    // getallen en gesloten-lijst-namen — geen brontekst, want dit belandt in een publieke log.
    const soort = vormBron === null ? 'GEEN_BRON' : `${vormBron.reden}@${vormBron.regel}`;
    return { uitkomst: 'ROOD', reden: `SPIEGEL_ONLEESBAAR/${soort}`, achterstallig: [], oudsteMinuten: null };
  }

  const regels = regelsVan(tekst);
  const achterstallig = [];
  let oudste = 0;
  for (const b of bronRijen) {
    const regel = String(b?.regel ?? '').trim();
    if (!regel || staatEr(regels, regel)) continue;
    const wacht = minutenTussen(nu, new Date(b.geleverdOp));
    if (wacht >= minuten) { achterstallig.push({ id: b.id, wachtMinuten: wacht }); oudste = Math.max(oudste, wacht); }
  }

  return achterstallig.length > 0
    ? { uitkomst: 'ROOD', reden: 'BRON_NIET_GEPUBLICEERD', achterstallig, oudsteMinuten: oudste }
    : { uitkomst: 'GROEN', reden: null, achterstallig: [], oudsteMinuten: 0 };
}

/**
 * Is het stempel op de plaat nog vers?
 *
 * `GROEN` vers · `GEEL` oud maar uitgelegd · `ROOD` oud, ontbrekend, onleesbaar of uit de toekomst.
 * Een verklaring maakt oud dus NIET groen: dan zou "onderhoud" invullen een manier worden om de
 * meter stil te zetten. Geel blijft zichtbaar, en dat is het hele verschil.
 */
export function stempelOordeel({ generatedAt, nu = new Date(), minuten = STEMPEL_MINUTEN, verklaring = null } = {}) {
  const basis = { ouderdomMinuten: null, verklaring: verklaring ?? null };
  if (generatedAt === null || generatedAt === undefined || generatedAt === '') {
    return { ...basis, uitkomst: 'ROOD', reden: 'STEMPEL_ONTBREEKT' };
  }
  const t = new Date(generatedAt);
  if (Number.isNaN(t.getTime())) return { ...basis, uitkomst: 'ROOD', reden: 'STEMPEL_ONLEESBAAR' };

  const ouderdom = minutenTussen(nu, t);
  // Een klein negatief verschil is klokdrift tussen twee machines; een uur is een verkeerd stempel.
  if (ouderdom < -5) return { ...basis, ouderdomMinuten: ouderdom, uitkomst: 'ROOD', reden: 'STEMPEL_UIT_DE_TOEKOMST' };
  if (ouderdom < minuten) return { ...basis, ouderdomMinuten: Math.max(ouderdom, 0), uitkomst: 'GROEN', reden: null };
  return verklaring
    ? { ...basis, ouderdomMinuten: ouderdom, uitkomst: 'GEEL', reden: 'STEMPEL_TE_OUD_MET_VERKLARING' }
    : { ...basis, ouderdomMinuten: ouderdom, uitkomst: 'ROOD', reden: 'STEMPEL_TE_OUD' };
}

/**
 * VLOOTSTAND — welk venster werkt, welk staat leeg, en van welk weten we het niet.
 *
 * De blinde vlek die dit dicht: vensters melden alleen AFRONDINGEN. "Ik wacht" is geen afronding en
 * verscheen dus nergens, waardoor Richard zelf tabs moest aflopen. Nu geldt: stilte is nooit groen.
 * Een venster is `WERKT` alleen als het recent iets meldde, `LEEG` als het zijn lege voorraad zélf
 * meldde, en verder `ONBEKEND` — ook als het nooit iets meldde, en ook als de leegmelding zelf oud
 * is, want dan weet niemand meer of hij nog geldt.
 *
 * De stand wordt AFGELEID uit de spiegel en nergens ingeschreven: het logboek is append-only, en een
 * kop die je bijwerkt verwijdert de vorige. De plaat toont hem.
 */
export function vlootstand(spiegelTekst, { vensters = [], nu = new Date(), minuten = VLOOT_ONBEKEND_MINUTEN } = {}) {
  const rijen = kanoniekeSpiegelvorm(String(spiegelTekst ?? '')).ok ? spiegelUitTekst(spiegelTekst) : [];

  return vensters.map(({ venster, rol = null }) => {
    const eigen = rijen.filter((r) => r.tab === venster);
    const laatste = eigen.length ? eigen[eigen.length - 1] : null;
    if (!laatste) return { venster, rol, laatste: null, stilMinuten: null, toestand: 'ONBEKEND' };

    // De datumkolom is de meldtijd in UTC; een rij zonder tijd telt als het begin van die dag.
    const moment = new Date(`${laatste.datum.length === 10 ? `${laatste.datum} 00:00` : laatste.datum}:00Z`.replace(' ', 'T'));
    const stil = Number.isNaN(moment.getTime()) ? null : minutenTussen(nu, moment);
    if (stil === null || stil >= minuten) return { venster, rol, laatste: laatste.datum, stilMinuten: stil, toestand: 'ONBEKEND' };
    const toestand = LEEG_MELDING.test(laatste.onderwerp) ? 'LEEG' : 'WERKT';
    return { venster, rol, laatste: laatste.datum, stilMinuten: stil, toestand };
  });
}

/** Zelfde vorm als een tab-label in de spiegel: kapitalen, geen repo-naam, geen persoon. */
const VENSTER_RE = /^[A-Z][A-Z0-9]*(?:[ -][A-Z0-9]+)*$/;
/** Een rol is een kort woord, geen alinea. Wat hier niet doorheen komt wordt null, niet afgekapt. */
const ROL_RE = /^[A-Za-z0-9][A-Za-z0-9 ./-]{0,39}$/;

/**
 * De vlootstand als publiek DTO. Twee dingen gebeuren hier en nergens anders:
 *
 * 1. De rol gaat door een smalle poort of wordt null. `data/vloot.json` is vrije tekst van een mens,
 *    en deze pagina staat openbaar — dus geldt hier dezelfde regel als overal: wat niet uit een
 *    vastgelegde vorm komt, komt er niet in. Er wordt niet afgekapt; afkappen zou een halve zin
 *    publiceren en dat is precies zo lek als een hele.
 * 2. Een venster met een naam die niet als vensterlabel te lezen is, maakt de HELE sectie
 *    onbeschikbaar in plaats van stil te verdwijnen. De vensterlijst is gesloten (`LANES`); staat
 *    daar iets in dat er niet in hoort, dan klopt de lijst niet, en dan is elke stand eruit een
 *    gok. Liever één nette melding dan veertien regels waarvan er één ontbreekt.
 */
export function toPublicVlootstand(raw) {
  const leeg = (reason) => ({ available: false, reason, grensMinuten: VLOOT_ONBEKEND_MINUTEN, vensters: [], telling: { werkt: 0, leeg: 0, onbekend: 0 } });
  if (!raw || raw.bronOk !== true || !Array.isArray(raw.standen)) return leeg('BRON_ONBEREIKBAAR');
  if (!raw.standen.length) return leeg('LEEG');
  if (!raw.standen.every((s) => VENSTER_RE.test(String(s?.venster ?? '')))) return leeg('BRON_ONBEREIKBAAR');

  const grensMinuten = Number.isInteger(raw.grensMinuten) && raw.grensMinuten > 0 ? raw.grensMinuten : VLOOT_ONBEKEND_MINUTEN;
  const vensters = raw.standen.map((s) => ({
    venster: s.venster,
    rol: typeof s.rol === 'string' && ROL_RE.test(s.rol) ? s.rol : null,
    toestand: VLOOTSTANDEN.includes(s.toestand) ? s.toestand : 'ONBEKEND',
    laatste: typeof s.laatste === 'string' && /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(s.laatste) ? s.laatste : null,
    stilMinuten: Number.isInteger(s.stilMinuten) && s.stilMinuten >= 0 ? s.stilMinuten : null,
  }));
  const tel = (t) => vensters.filter((v) => v.toestand === t).length;
  return {
    available: true,
    reason: null,
    grensMinuten,
    vensters,
    telling: { werkt: tel('WERKT'), leeg: tel('LEEG'), onbekend: tel('ONBEKEND') },
  };
}

/**
 * De vlootstand als tabel — één regel per venster, en verder niets. Bewust dezelfde kanonieke vorm
 * als de spiegel zelf, zodat de vormpoort er net zo hard overheen kan.
 */
export function vlootstandBlok(standen = [], { nu = new Date() } = {}) {
  const stil = (s) => (s.stilMinuten === null ? 'nooit gemeld' : `${s.stilMinuten} min stil`);
  const regels = standen.map((s) => `| ${s.venster} | ${s.rol ?? '-'} | ${s.laatste ?? '-'} | ${stil(s)} | ${s.toestand} |`);
  return [
    `<!-- VLOOTSTAND — afgeleid, niet ingeschreven. Peilmoment ${nu.toISOString()}. -->`,
    '| venster | rol | laatste melding | stilte | stand |',
    '| --- | --- | --- | --- | --- |',
    ...regels,
  ].join('\n');
}

/**
 * Achterstand PER BRON, geteld in rijen (opdracht PUBLICATIE-ACHTERSTAND-GEMETEN, 27-07-2026).
 *
 * De acceptatie is niet "de kanaalpost stroomt door" maar "élke gepubliceerde bron stroomt door".
 * De gemeten breuk was geen transport maar een lezer: 68 van de 98 besluiten vielen stil weg omdat
 * hun tekst langer was dan 160 tekens, en de plaat toonde D-0094 alsof dat de jongste was. Sinds de
 * lezers `{ inBron, herkend, getoond, afgekapt }` publiceren in `status.json` is dat te zien:
 * `herkend < inBron` betekent dat er rijen zijn weggevallen — dat is ROOD, met het aantal erbij.
 *
 * Geen telling op de plaat is GEEL, geen ROOD: een pagina van vóór dit contract is achterstallig
 * gebouwd, niet kapot. Zodra de nieuwe build live staat wordt dat vanzelf een echte meting.
 */
/** Bronnen die rijen lezen. Ontbreekt hier een telling, dan is er niet gemeten — dat is GEEL. */
export const ROW_SOURCES = ['tracker', 'decisions', 'logbook'];

export function bronRijenOordeel(sources) {
  if (!Array.isArray(sources)) {
    return { uitkomst: 'GEEL', reden: 'PLAAT_ZONDER_BRONNEN', bronnen: [], gevallen: 0, afgekapt: 0 };
  }
  const bronnen = sources
    .filter((s) => s && typeof s.key === 'string' && s.rijen && Number.isInteger(s.rijen.inBron))
    .map((s) => ({
      key: s.key,
      inBron: s.rijen.inBron,
      herkend: Number.isInteger(s.rijen.herkend) ? s.rijen.herkend : 0,
      afgekapt: Number.isInteger(s.rijen.afgekapt) ? s.rijen.afgekapt : 0,
    }))
    .map((b) => ({ ...b, gevallen: Math.max(0, b.inBron - b.herkend) }));

  if (!bronnen.length) {
    return { uitkomst: 'GEEL', reden: 'PLAAT_NOG_ZONDER_RIJENTELLING', bronnen: [], gevallen: 0, afgekapt: 0 };
  }
  // Fail-open dichtgezet (Codex, 27-07): een bron zónder telling telde niet mee zodra één andere
  // bron er wél een had, en alles op nul was gewoon GROEN. Beide zien er uit als "niets aan de
  // hand" terwijl er niets gemeten is.
  const zonderTelling = sources
    .filter((s) => s && ROW_SOURCES.includes(s.key) && !(s.rijen && Number.isInteger(s.rijen.inBron)))
    .map((s) => s.key);
  if (zonderTelling.length) {
    return {
      uitkomst: 'GEEL', reden: `BRON_ZONDER_RIJENTELLING: ${zonderTelling.join(', ')}`, bronnen, gevallen: 0, afgekapt: 0,
    };
  }
  if (bronnen.every((b) => b.inBron === 0)) {
    return { uitkomst: 'GEEL', reden: 'ALLE_BRONNEN_NUL', bronnen, gevallen: 0, afgekapt: 0 };
  }
  const kwijt = bronnen.filter((b) => b.gevallen > 0);
  const gevallen = kwijt.reduce((n, b) => n + b.gevallen, 0);
  const afgekapt = bronnen.reduce((n, b) => n + b.afgekapt, 0);
  return {
    uitkomst: kwijt.length ? 'ROOD' : 'GROEN',
    reden: kwijt.length ? `RIJEN_WEGGEVALLEN: ${kwijt.map((b) => `${b.key} ${b.gevallen}/${b.inBron}`).join(', ')}` : null,
    bronnen,
    gevallen,
    afgekapt,
  };
}

/**
 * HET EINDOORDEEL — één plek waar de deeloordelen samenkomen, zodat de regel te toetsen is.
 *
 * Drie waarden, niet twee: "niet gemeten" is GEEL en werd hier eerder afgerond naar GROEN.
 * Nieuw (27-07): een BRONMAP DIE NIET BESTAAT telt als niet-gemeten. De doorstroom las een
 * ontbrekende inbox als "0 rijen aangeleverd" en oordeelde groen — want zonder aanvoer kan niets
 * achterlopen. Dat is afwezigheid gelezen als gezondheid: dezelfde klasse die dit bouwsel bestrijdt,
 * in het bouwsel zelf. Ontbreekt de map, dan is er niets bewezen en mag het nooit groen zijn.
 *
 * @param {object} p
 * @param {string[]} p.delen        de deeloordelen (GROEN/GEEL/ROOD)
 * @param {boolean}  p.bronOk       is de bron überhaupt gelezen
 * @param {string|null} p.inboxMap  'AANWEZIG' | 'ONTBREEKT' | null (niet vastgesteld)
 */
export function eindoordeel({ delen = [], bronOk = true, inboxMap = null } = {}) {
  // ELKE onbekende waarde is GEEL, niet GROEN (bevinding Gemini 27-07). Een deeloordeel dat
  // `undefined`, `null` of `'FOUT'` teruggeeft, is een stuk dat niet gemeten heeft — en dat viel er
  // hier stil doorheen: `.includes('ROOD')` en `.includes('GEEL')` zeiden allebei nee, en dan bleef
  // GROEN over. Een kapotte meter die groen licht geeft is precies de klasse die dit alarm bestrijdt.
  const gewogen = delen.map((d) => (UITKOMSTEN.includes(d) ? d : 'GEEL'));
  // Zo ook de map: alleen het uitdrukkelijke 'AANWEZIG' en het niet-gestelde `null` zijn geen
  // bezwaar. 'ONTBREEKT' en elke andere waarde vergelen — anders zou een nieuwe foutstatus
  // (bijvoorbeeld 'ERROR') stilzwijgend als gezond tellen.
  const kaart = inboxMap === 'AANWEZIG' || inboxMap === null || inboxMap === undefined ? 'GROEN' : 'GEEL';
  const alles = [...gewogen, kaart];
  if (!bronOk || alles.includes('ROOD')) return 'ROOD';
  return alles.includes('GEEL') ? 'GEEL' : 'GROEN';
}
