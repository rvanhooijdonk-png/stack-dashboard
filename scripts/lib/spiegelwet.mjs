/**
 * SPIEGELWET — de publieke spiegel is APPEND-ONLY, en dat wordt niet meer op discipline vertrouwd.
 *
 * Waarom dit bestaat. Op 26-07-2026 heeft de waarnemer tijdens zijn eigen acceptatietest een
 * GEBLOKKEERD-regel in `data/kanaalpost-publiek.md` gezet, en heb IK die regel daarna weggehaald bij
 * het opruimen (commit 211faaf, één regel `-`). Dat is precies de fout die de append-only-regel moet
 * voorkomen: het logboek is geen werkbestand maar een verslag, en een verslag waaruit de vervelende
 * regel verdwijnt is geen verslag meer. De regel is inmiddels teruggezet met een correctie eronder;
 * deze module zorgt dat de volgende keer niet van oplettendheid afhangt.
 *
 * DE WET, in twee lagen — en de eerste versie hiervan had er maar één, ten onrechte.
 *
 * Laag 1, HARD: geen enkele regel die er stond mag verdwijnen. Dat is de belofte die het logboek een
 * verslag maakt, en precies de belofte die ik brak.
 *
 * Laag 2, ZACHT: nieuwe regels horen erachter, niet ertussen. Dit is geen rode kaart, want er is een
 * legitiem geval waarin de volgorde wél schuift: twee takken die elk een regel aanvullen. Wordt main
 * in zo'n tak samengevoegd, dan staat de eigen regel ná die van main terwijl hij er eerst vóór stond.
 * Een harde prefix-eis maakt zulke takken onverenigbaar en zou de bewaker vooral vals laten piepen —
 * en een bewaker die vals piept wordt uitgezet (bevinding Codex, 26-07-2026). Ordeverstoring wordt
 * dus gemeld, niet bestraft.
 */

import { bevatOnzichtbaar } from './kanaalpost.mjs';

const regels = (tekst) => String(tekst ?? '').replace(/\n+$/, '').split('\n');
const isLeeg = (r) => r.length === 0 || (r.length === 1 && r[0] === '');

/**
 * Vergelijk twee versies van de spiegel.
 *
 * `{ ok, verdwenen, opOrde, eerste }` — `ok` is de harde wet (niets verdwenen), `verdwenen` is het
 * aantal regels dat niet meer voorkomt, `opOrde` zegt of de oude tekst nog letterlijk vooraan staat,
 * `eerste` is het 1-gebaseerde regelnummer waar de volgorde voor het eerst afwijkt (of null).
 *
 * Regels worden vergeleken op INHOUD, met hun aantal: twee identieke regels mogen niet stilletjes één
 * worden. Bewust GEEN inhoud in de uitkomst: dit oordeel belandt in een logregel.
 */
export function alleenAangevuld(oud, nieuw) {
  const a = regels(oud);
  const b = regels(nieuw);
  const oudeRegels = isLeeg(a) ? [] : a;
  const nieuweRegels = isLeeg(b) ? [] : b;

  // Tellen, niet alleen bestaan: verdwijnt één van twee gelijke regels, dan is er toch een regel weg.
  const telling = new Map();
  for (const r of nieuweRegels) telling.set(r, (telling.get(r) ?? 0) + 1);
  let verdwenen = 0;
  for (const r of oudeRegels) {
    const n = telling.get(r) ?? 0;
    if (n === 0) verdwenen += 1;
    else telling.set(r, n - 1);
  }

  let eerste = null;
  for (let i = 0; i < oudeRegels.length; i += 1) {
    if (nieuweRegels[i] !== oudeRegels[i]) { eerste = i + 1; break; }
  }
  return { ok: verdwenen === 0, verdwenen, opOrde: eerste === null, eerste };
}

/**
 * DE SCHRIJFKANT — één canonieke vorm in de spiegel zelf (besluit Fable, 26-07-2026, punt 3).
 *
 * De leeskant mág normaliseren: de waarnemer vergelijkt pagina en bron met NFKC-genormaliseerde tekst,
 * anders valt hij over het afkap-teken. Maar NFKC is niet injectief — `10²` en `102` worden daar gelijk,
 * net als `ﬀ` en `ff`. Op de leeskant is dat een tolerantie die je niet weg krijgt zonder de hele
 * terugleesketen om te bouwen. Op de SCHRIJFkant is het simpel: laat die vormen er niet in.
 *
 * Wat "canoniek" hier betekent, en niet meer dan dat:
 *  - de regel is gelijk aan zijn eigen NFKC-vorm (dus geen compatibiliteitstekens die later stilletjes
 *    iets anders worden), en
 *  - de regel bevat geen onzichtbare tekens — dezelfde verzameling die de leeskant al weghaalt: zero-
 *    width, bidi-overrides, variation selectors, stuurtekens, soft hyphen, BOM. Die zijn in een
 *    verslag nooit bedoeld en maken twee ogenschijnlijk gelijke regels ongelijk.
 *
 * TWEE STRENGTES, bewust: wat er NIEUW bij komt wordt geweigerd (`nieuweNietCanoniekeRegels`), wat er
 * al stond wordt gemeld (`nietCanoniekeRegels`). Zie de uitleg bij de poort hieronder — samen met
 * append-only zou één harde eis op het hele bestand de deur permanent op slot kunnen zetten.
 *
 * Nulmeting bij invoering: alle 44 regels in `data/kanaalpost-publiek.md` die met een pipe beginnen
 * voldeden al — dat zijn de 35 publieke spiegelrijen plus de kop, de scheidingsregel en de zeven
 * regels van het verklarende tabelletje erboven. De eis legt dus niets recht met terugwerkende kracht;
 * hij houdt de vorm vast die er nu is.
 */
// De verzameling onzichtbare tekens komt uit `kanaalpost.mjs`, waar de leeskant hem al gebruikt om ze
// weg te halen. De eerste versie hier had zijn eigen, veel kortere lijstje - en twee definities van
// "onzichtbaar" betekent dat de schrijfkant doorlaat wat de leeskant stilletjes weghaalt, precies het
// verschil waarmee twee ogenschijnlijk gelijke regels ongelijk worden (bevinding Codex, 26-07-2026).

/**
 * Is deze tekst al zijn eigen canonieke vorm?
 *
 * EERLIJKE GRENS: dit is geen neutrale "Unicode-canonicalisatie" maar een huisstijl. NFKC keurt naast
 * onzichtbare tekens ook `…`, `½`, `²`, `Ĳ`, `ﬁ` en losse NFD-accenten af, terwijl gedachtestreepjes
 * en samengestelde accenten gewoon door mogen. Dat is bewust — de spiegel is een regelbestand, geen
 * zetwerk — maar het hoort er zo te staan, want wie uit Word plakt begrijpt anders niet waarom zijn
 * regel rood is (bevinding Codex, 26-07-2026).
 */
export function canoniek(waarde) {
  const t = String(waarde ?? '');
  return t.normalize('NFKC') === t && !bevatOnzichtbaar(t);
}

/**
 * Ziet deze regel eruit als een tabelregel? Bewust ruimer dan de parser, die ook een sluitende pipe
 * eist: wat er als spiegelrij UITZIET moet door de vormcontrole, ook als de parser hem later weggooit.
 * De selectie kijkt door onzichtbare tekens heen, want een regel die met een zero-width space begint
 * is voor het oog een rij en zou anders volledig buiten de controle vallen (bevinding Codex).
 */
const isTabelregel = (ruw) => {
  const r = String(ruw ?? '').replace(/\r$/, '');
  const kop = r.slice(0, r.indexOf('|') === -1 ? r.length : r.indexOf('|'));
  return r.includes('|') && kop.split('').every((c) => /\s/.test(c) || bevatOnzichtbaar(c));
};

const SAMENGESTELD = 'samengesteld teken (NFD-accent of ligatuur)';

/** Welke tekens maken deze regel niet-canoniek — en als het geen los teken is, zeg dát dan. */
const bevinding = (ruw, i) => {
  // Per teken kijken lukt niet altijd: bij een NFD-accent (`e` + combining acute) is élk codepoint op
  // zichzelf canoniek en de regel toch niet. Zonder terugval stond er `regel 12 ()` in de foutmelding
  // en wist niemand wat er mis was (bevinding Codex, 26-07-2026).
  const t = String(ruw);
  const tekens = [...new Set([...t].filter((c) => !canoniek(c)))]
    .map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
  // En de twee soorten rommel worden ONAFHANKELIJK gemeld. Anders liftte een samengesteld teken mee
  // op een los teken dat toch al in de lijst stond: zet naast een `…` ook een NFD-accent in dezelfde
  // regel, en de melding bleef letterlijk `['U+2026']` — waardoor een test die op die uitkomst
  // vertrouwt groen bleef terwijl de regel viezer werd (bewezen tegenvoorbeeld Codex, 26-07-2026).
  const zonderLosseFouten = [...t].filter((c) => canoniek(c)).join('');
  if (zonderLosseFouten.normalize('NFKC') !== zonderLosseFouten) tekens.push(SAMENGESTELD);
  return { regel: i + 1, tekens: tekens.length ? tekens : [SAMENGESTELD] };
};

/**
 * AUDIT — álle tabelregels in het bestand die niet canoniek zijn, met regelnummer en de tekens die het
 * veroorzaken. Leeg = de spiegel voldoet. Proza, kop en uitleg vallen erbuiten.
 *
 * De RUWE regel wordt beoordeeld en niet de getrimde: `trim()` haalt in JavaScript óók een BOM en een
 * harde spatie weg, dus een regel die met een BOM begint zou getrimd slagen terwijl de parser hem
 * daarna gewoon publiceert (bevinding Codex, 26-07-2026). Selecteren mag op de ontdane vorm; oordelen
 * niet.
 */
export function nietCanoniekeRegels(tekst) {
  const gevonden = [];
  String(tekst ?? '').split('\n').forEach((ruw, i) => {
    const r = ruw.replace(/\r$/, '');
    if (!isTabelregel(r) || canoniek(r)) return;
    gevonden.push(bevinding(r, i));
  });
  return gevonden;
}

/**
 * DE POORT — alleen de tabelregels die in `nieuw` staan en niet in `oud`. Dit is wat hard geweigerd
 * wordt; de audit hierboven is wat gemeld wordt.
 *
 * Waarom dat onderscheid er moet zijn. Append-only en een harde eis op het HELE bestand sluiten elkaar
 * op zodra er ooit één vuile regel doorheen glipt: herstellen mag niet (de oude regel zou verdwijnen),
 * en laten staan houdt élke volgende commit rood — ook die van iemand die de spiegel niet aanraakt.
 * Datzelfde gebeurt zodra deze eis ooit strenger wordt. Beide reviewers wezen dat aan (Codex D,
 * Gemini D). Het besluit van Fable gaat over de SCHRIJFkant, en dat is precies deze verzameling: wat
 * er nieuw in komt. Wat er al stond blijft zichtbaar als waarschuwing — niet stil, maar ook geen
 * dichtgeslagen deur voor een ander.
 */
/**
 * DE ANDERE KANT VAN DEZELFDE WET — een regel mag er ook niet stilletjes BIJ komen.
 *
 * `alleenAangevuld` bewijst dat elke oude regel er nog minstens even vaak staat; een extra exemplaar
 * blijft daar groen (bevinding Codex, 26-07-2026). Dat gat is niet theoretisch: bij het omhangen van
 * de waarnemer-tak naar main plakte een samenvoeging dezelfde WAARNEMER-regel een tweede keer
 * onderaan, en de append-only-poort zag daar niets van. Een verslag met dezelfde melding er twee keer
 * in liegt net zo hard als een verslag waar er één uit is.
 *
 * Wat hier "nieuw duplicaat" heet: een tabelregel die in `nieuw` vaker voorkomt dan in `oud`, én
 * vaker dan één keer. Stonden er in `oud` al twee gelijke regels, dan blijven die twee toegestaan —
 * weghalen mag immers niet. Alleen het extra exemplaar is de overtreding.
 */
export function nieuweDuplicaten(oud, nieuw) {
  const tel = (tekst) => {
    const m = new Map();
    for (const ruw of String(tekst ?? '').split('\n')) {
      const r = ruw.replace(/\r$/, '');
      if (!isTabelregel(r)) continue;
      m.set(r, (m.get(r) ?? 0) + 1);
    }
    return m;
  };
  const oudeTelling = tel(oud);
  const nieuweTelling = tel(nieuw);
  const gevonden = [];
  const regels = String(nieuw ?? '').split('\n');
  for (const [regel, aantal] of nieuweTelling) {
    const toegestaan = Math.max(oudeTelling.get(regel) ?? 0, 1);
    if (aantal <= toegestaan) continue;
    // Het regelnummer van het LAATSTE exemplaar: dat is het exemplaar dat erbij kwam.
    let laatste = 0;
    regels.forEach((ruw, i) => { if (ruw.replace(/\r$/, '') === regel) laatste = i + 1; });
    gevonden.push({ regel: laatste, aantal, toegestaan });
  }
  return gevonden;
}

export function nieuweNietCanoniekeRegels(oud, nieuw) {
  const telling = new Map();
  for (const r of String(oud ?? '').split('\n')) telling.set(r, (telling.get(r) ?? 0) + 1);
  const gevonden = [];
  String(nieuw ?? '').split('\n').forEach((ruw, i) => {
    const n = telling.get(ruw) ?? 0;
    // Stond deze regel er al letterlijk zo in, dan is hij niet nieuw — tellen, zodat twee gelijke
    // regels niet één oude regel als dekmantel delen.
    if (n > 0) { telling.set(ruw, n - 1); return; }
    const r = ruw.replace(/\r$/, '');
    if (!isTabelregel(r) || canoniek(r)) return;
    gevonden.push(bevinding(r, i));
  });
  return gevonden;
}
