/**
 * WAARNEMER — de plaat bewaakt zichzelf.
 *
 * Alles hierboven in deze repo bewijst dat een BOUW is geslaagd. Niets bewees tot nu toe dat de
 * PAGINA die een bezoeker ziet ook klopt. Dat is een andere vraag: een geslaagde build kan naast een
 * pagina staan die uren oud is, een sectie mist, of rijen toont die niet meer in de bron staan.
 * Deze module beantwoordt die tweede vraag, en niets anders — hij haalt niets op en schrijft niets
 * weg (dat doet `scripts/waarnemer.mjs`), zodat elke toets zonder netwerk te testen is.
 *
 * VIER TOETSEN (opdracht 26-07-2026):
 *  1. de pagina is bereikbaar en draagt een bouwstempel;
 *  2. de stempel is jonger dan de drempel, ÓF de pagina zegt zelf eerlijk dat ze verouderd is;
 *  3. de kanaalpost-sectie staat er, en de bovenste rij op de pagina is dezelfde melding als de
 *     laatste rij in de bron-spiegel — precies de klasse "pagina toont oude data";
 *  4. de verplichte secties staan er, geen lege of kapotte blokken.
 *
 * WAT DEZE MODULE NIET KAN, expliciet. GitHub Pages/Fastly gebruikt de query-string NIET als
 * cachesleutel — gemeten 24-07-2026 en vastgelegd in `publish.yml`. Een "verse fetch met
 * cache-busting" haalt dus nog steeds een CDN-kopie op die tot ongeveer tien minuten oud kan zijn.
 * De waarnemer kan daarom niet onderscheiden of de pagina zelf oud is of alleen de kopie in de
 * cache. Dat is geen bug maar de reden dat de drempel (uren) en het respijt (minuten) allebei ruim
 * boven dat cachevenster liggen: binnen dat venster mag de waarnemer niets beweren.
 *
 * ZELF-BEWAPENEND, geen fail-open. De kanaalpost-toets kan niets eisen van een pagina die is
 * gebouwd vóór die sectie bestond. Daarom kijkt hij naar de contractversie die de pagina zelf
 * meldt: onder `KANAALPOST_VANAF` is het een waarschuwing (de sectie is nog niet gepubliceerd),
 * vanaf die versie een harde fout. De toets zet zichzelf aan zodra de plaat hem kan halen; er is
 * geen schakelaar die iemand kan vergeten om te zetten. Sinds 02-08-2026 geldt datzelfde mechanisme
 * voor élke sectie die later op de plaat kwam, via `SECTIES_VANAF` — één tabel in plaats van één
 * ingebakken uitzondering.
 */

import { kanaalpostUitTekst, toPublicKanaalpost, ontdaan } from './kanaalpost.mjs';
import { validate } from './validate.mjs';
import { canoniek } from './spiegelwet.mjs';
// HERGEBRUIK-EERST: dezelfde strikte tijdstipontleding die de runtime-feed al gebruikt. `Date.parse`
// is géén validator -- V8 leest `"0"` als 31-12-1999 en rolt `2026-02-30` stilzwijgend door naar
// 2 maart. Beide kochten daarmee bewijs op de plekken hieronder (bevinding Codex, ronde 10).
import { parseTijdstempel } from './runtime-feed.mjs';

/** Vanaf deze contractversie MOET de pagina een kanaalpost-sectie hebben. */
export const KANAALPOST_VANAF = '2.4.0';

/**
 * Hoe oud mag de stempel zijn. De publicatie draait op twee vaste momenten (05:45 en 15:45 UTC)
 * plus elke push; tussen de avond- en ochtendrun zit dus veertien uur waarin een stille dag
 * volstrekt normaal is. Vijftien uur is die veertien plus bouw-, deploy- en cachetijd. Strenger kan
 * pas als er vaker gebouwd wordt — dat is een beslissing over publicatiefrequentie, geen instelling
 * die de waarnemer in zijn eentje mag aanscherpen.
 */
export const DREMPEL_UREN = 15;

/**
 * Respijt voor de rij-vergelijking. Een verse regel in de spiegel moet eerst een bouw en een deploy
 * doorlopen en daarna nog door de CDN-cache heen. Drie kwartier is ruim boven die keten; binnen dat
 * respijt mag de pagina achterlopen zonder dat het een afwijking heet.
 */
export const GRACE_MINUTEN = 45;

/** Zolang dit venster loopt herhaalt de waarnemer dezelfde melding niet in de spiegel. */
export const HERHAAL_UREN = 12;

/**
 * De ontsnapping van toets 2. Een statische pagina kan haar eigen leeftijd niet weten, dus vandaag
 * bestaat deze melding nog niet — de drempel is nu de enige tak. Het merkteken staat er wel al,
 * zodat een latere plaat die zichzelf wél verouderd durft te noemen (client-side, plaat v2) niet
 * ineens rood wordt voor eerlijkheid.
 */
export const VEROUDERD_MARKER = 'data-verouderd="ja"';
const SELF_REFRESH_ROUTES = new Set(['./', './producten.html', './stack-ticker.html', './contentstroom.html']);

/** Leid de vaste relatieve self-refreshroute af zonder een willekeurig URL-pad te vertrouwen. */
export function zelfRouteUitUrl(url) {
  try {
    const pathname = new URL(String(url)).pathname;
    const bestand = pathname.endsWith('/') ? '' : pathname.split('/').pop();
    const route = bestand ? `./${bestand}` : './';
    return SELF_REFRESH_ROUTES.has(route) ? route : null;
  } catch {
    return null;
  }
}

/**
 * Secties die er op élke bouw horen te staan, ongeacht de contractversie. Ze bestaan sinds 2.0.0 en
 * `render.mjs` geeft ze in beide takken terug — ook als hun bron onbereikbaar is, dan met de
 * `Geen data`-uitleg. Hun afwezigheid is dus nooit een leeftijdskwestie maar altijd een renderfout.
 *
 * `decisions` stond hier tot 02-08-2026 niet in, zonder aanwijsbare reden: het besluitenregister
 * staat sinds de eerste bouw op de plaat en heeft nooit een eigen versiepoort gehad.
 *
 * BEWUST NIET IN DEZE LIJST: `roadmap`. Die sectie is voorwaardelijk — `workstreams()` geeft een
 * lege string terug bij een lege lijst, dus een roadmaploze bouw hóórt hem niet te tonen. Verplicht
 * stellen zou de waarnemer vals rood maken op een pagina die precies doet wat ze moet doen.
 */
export const VERPLICHTE_SECTIES = ['overzicht', 'planning', 'prs', 'ci', 'tracker', 'decisions', 'tracks', 'merged', 'logbook'];

/**
 * Secties die pas vanaf een bepaalde contractversie op de plaat staan, met dezelfde zelf-bewapening
 * als `KANAALPOST_VANAF`: onder die versie eist de waarnemer ze niet, vanaf die versie hard. Zo kan
 * een oudere gepubliceerde kopie niet rood worden voor iets wat ze onmogelijk kon hebben, en hoeft
 * niemand een schakelaar om te zetten zodra de nieuwe versie live gaat.
 *
 * De versies zijn gemeten aan de bump waarin de sectie gegarandeerd meekomt, niet aan de commit
 * waarin ze ontstond. Dat verschil is bij `gedeelde-weergave` echt: die landde in #51 mídden in
 * 2.5.0 zonder eigen bump, dus een 2.5.0-pagina kan hem hebben of niet — 2.6.0 (#53) is de eerste
 * versie waarin zijn aanwezigheid vaststaat. `vlootstand` kwam mét zijn bump mee in 2.5.0 (#39).
 */
export const SECTIES_VANAF = {
  kanaalpost: KANAALPOST_VANAF,
  vlootstand: '2.5.0',
  'gedeelde-weergave': '2.6.0',
};

/**
 * Sporen van een renderfout die er als data uitzien. Bewust op de GERENDERDE vorm (`>undefined<`)
 * en niet op het kale woord: "undefined" kan in gewone tekst staan, `>undefined<` is altijd een
 * waarde die nooit is ingevuld.
 */
const KAPOT_SPOREN = ['[object Object]', 'Invalid Date', '>undefined<', '>NaN<', '>null<'];

/** Elke code krijgt één zin in gewone taal. Die zin gaat óók de publieke spiegel in, dus: geen
 *  paden, geen adressen, geen jargon dat alleen de bouwer begrijpt. */
export const CODES = {
  PAGINA_ONBEREIKBAAR: 'de openbare pagina was niet op te halen',
  PAGINA_LEEG: 'de openbare pagina kwam leeg terug',
  STEMPEL_ONTBREEKT: 'op de pagina staat geen bouwstempel',
  STEMPEL_ONLEESBAAR: 'de bouwstempel op de pagina was niet te lezen',
  STEMPEL_INCONSISTENT: 'de twee tijdsvermeldingen op de pagina spreken elkaar tegen',
  STEMPEL_TE_OUD: 'de pagina is ouder dan de afgesproken drempel en zegt dat zelf niet',
  STEMPEL_IN_TOEKOMST: 'de bouwstempel op de pagina ligt in de toekomst, dus de leeftijd klopt niet',
  SPIEGEL_ONBEREIKBAAR: 'het openbare logboek was niet op te halen',
  SPIEGEL_ONLEESBAAR: 'in het openbare logboek stond geen enkele leesbare regel',
  KANAALPOST_ONTBREEKT: 'de logboek-sectie ontbreekt op de pagina',
  KANAALPOST_ZONDER_RIJEN: 'de logboek-sectie op de pagina toont geen enkele regel terwijl de bron er wel heeft',
  PAGINA_TOONT_OUDE_DATA: 'de bovenste regel op de pagina is niet de laatste regel uit de bron',
  SECTIE_ONTBREEKT: 'een verplichte sectie ontbreekt op de pagina',
  SECTIE_LEEG: 'een sectie op de pagina is leeg zonder uitleg',
  PAGINA_KAPOT: 'op de pagina staat een lege of onberekende waarde in plaats van gegevens',
  GEEN_GEVERIFIEERDE_BRON: 'de pagina staat er wel, maar geen enkele bron erachter is geverifieerd',
  BRONSTAND_ONLEESBAAR: 'er is niet te lezen hoeveel van de bronnen achter de plaat geverifieerd zijn',
  BRONSTAND_ANDERE_BOUW: 'de bronstand hoort bij een andere bouw dan de pagina die nu geserveerd wordt',
  CONTRACT_ONLEESBAAR: 'er is niet te lezen welke versie van de plaat dit is',
  CONTRACT_UITEEN: 'de plaat en het statusbestand noemen verschillende contractversies terwijl ze uit dezelfde bouw komen',
  // Een NEVENPUNT: het maakt op zichzelf geen ronde rood, maar het reist wél mee in de publieke
  // melding zodra er om een andere reden alarm is. Zie NEVENPUNTEN hieronder.
  BRON_ZONDER_HERKOMST: 'er zijn bronnen die zich geverifieerd noemen zonder herkomst; die tellen niet mee',
};

const UUR = 3600 * 1000;
const MIN = 60 * 1000;

/** Klokverschil tussen bouwmachine en controlemachine dat we normaal vinden. Alles daarbuiten in de
 *  toekomst is geen speling meer maar een kapotte stempel. */
const KLOKSPELING_MS = 5 * MIN;

/**
 * Hoe ver in de "toekomst" een spiegelrij mag liggen voordat we hem als verzonnen beschouwen. Ruimer
 * dan de klokspeling, en met opzet: de datumkolom is NL-tijd zonder zone en wordt hier behoudend als
 * UTC gelezen (zie `rijMoment`), waardoor een verse regel tot twee uur in de toekomst lijkt te
 * liggen. Drie uur laat die zomertijd-speling toe; een regel uit 2099 valt er ruim buiten.
 */
const ZONE_SPELING_MS = 3 * UUR;

/** Versievergelijking op drie getallen; alles wat niet leesbaar is telt als "ouder dan". */
export function versieMinstens(gevonden, minimaal) {
  // Begrensd lezen: zie VERSIE_VORM. Een cijferreeks die `parseInt` naar `Infinity` tilt is geen
  // versie maar een aanval op de vergelijking zelf.
  if (!VERSIE_VORM.test(String(gevonden ?? ''))) return false;
  const lees = (v) => String(v ?? '').split('.').map((x) => Number.parseInt(x, 10));
  const a = lees(gevonden);
  const b = lees(minimaal);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

/**
 * De pagina draagt haar eigen bouwmoment op twee plekken: leesbaar in de kop ("gebouwd om HH:MM
 * NL-tijd (HH:MM UTC)") en machinaal in de cache-buster van de zelf-refresh, die de cijfers van
 * `generatedAt` bevat. De refresh mag uitsluitend naar een van de vier vaste pagina-routes wijzen;
 * sinds de multi-pagebouw ververst elke pagina naar zichzelf. De machinale vorm is compleet (datum
 * + tijd + milliseconden), de leesbare niet — daarom rekent de waarnemer met de eerste en gebruikt
 * hij de tweede als kruiscontrole.
 * Zo hangt de leeftijdstoets niet aan `status.json`, dat door de CDN uit een ándere publicatie kan
 * komen dan de pagina die ernaast wordt geserveerd.
 */
export function stempelUitHtml(html, { route } = {}) {
  const s = String(html ?? '');
  // Alleen in de kop zoeken, en precies één treffer eisen. Anders kan de INHOUD van de plaat de
  // stempel namaken: één kanaalpost-regel die letterlijk `url=./?v=<17 cijfers>` bevat zou een
  // weggevallen refresh-tag maskeren, en dat is precies het soort groen dat niets bewijst.
  const kopEind = s.indexOf('</head>');
  const kop = kopEind === -1 ? '' : s.slice(0, kopEind);
  const busters = [...kop.matchAll(
    /url=(\.\/(?:(?:producten|stack-ticker|contentstroom)\.html)?)\?v=(\d{17})\b/g,
  )];
  const buster = busters.length === 1 && (route === undefined || busters[0][1] === route)
    ? busters[0] : null;
  const leesbaar = s.match(/class="stamp">Laatst bijgewerkt: <strong>gebouwd om (\d{2}):(\d{2}) NL-tijd \((\d{2}):(\d{2}) UTC\)<\/strong>/);
  const zicht = leesbaar
    ? { utcHhmm: `${leesbaar[3]}:${leesbaar[4]}`, nlHhmm: `${leesbaar[1]}:${leesbaar[2]}` }
    : { utcHhmm: null, nlHhmm: null };
  if (!busters.length && !leesbaar) return { gevonden: false, iso: null, ...zicht, leesbaar: null };
  if (!buster || !leesbaar) return { gevonden: true, iso: null, ...zicht, leesbaar: Boolean(leesbaar) };
  const d = buster[2];
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(8, 10)}:${d.slice(10, 12)}:${d.slice(12, 14)}.${d.slice(14, 17)}Z`;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime()) || t.toISOString() !== iso) {
    return { gevonden: true, iso: null, ...zicht, leesbaar: true };
  }
  return { gevonden: true, iso, ...zicht, leesbaar: true };
}

/**
 * De binnenkant van één sectie. De plaat nest geen secties (de grid-kaarten staan naast elkaar in
 * een `div`), dus het eerstvolgende sluitelement hoort bij deze sectie.
 */
export function sectieUitHtml(html, id) {
  const s = String(html ?? '');
  // Niet vastpinnen op de volgorde van de attributen: een sectie die morgen `<section class="card"
  // id="planning">` heet is dezelfde sectie, en een waarnemer die daarop rood wordt roept vals alarm.
  const treffer = s.match(new RegExp(`<section\\s[^>]*\\bid="${id}"[^>]*>`, 'i'));
  if (!treffer) return null;
  const start = treffer.index;
  const eind = s.indexOf('</section>', start);
  return eind === -1 ? null : s.slice(start, eind);
}

const ZONDER_TAGS = (h) => String(h ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** Terug van de weergave naar de tekst, zodat een pagina-cel met de bron vergeleken kan worden. */
export function unesc(v) {
  return String(v ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * De bovenste kanaalpost-rij zoals de pagina hem toont. Terugvertaald naar dezelfde velden als de
 * bron, zodat de vergelijking op inhoud gaat en niet op opmaak.
 */
export function eersteKanaalpostRij(sectieHtml) {
  // Sluiten op `</tbody>`, niet op `</table>`: anders leest een tabel zonder sluitende tbody alsnog
  // "goed" en kan een anders opgebouwde tabel inhoud van buiten de body meenemen.
  const body = String(sectieHtml ?? '').match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (!body) return null;
  const rij = body[1].match(/<tr>([\s\S]*?)<\/tr>/);
  if (!rij) return null;
  const ruw = [...rij[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
  const cel = (h) => ontdaan(unesc(ZONDER_TAGS(h)));
  const cellen = ruw.map(cel);
  if (cellen.length < 4 || cellen.slice(0, 4).some((c) => c === '')) return null;
  // De statuskolom draagt TWEE dingen: de stand, en achter een `<br>` de actiehouder in een grijze
  // span (zie `render.mjs`: "actie voor staat in dezelfde cel als de status"). Alles plat slaan maakt
  // van `AFGEROND` + actiehouder één lange string, die per definitie nooit gelijk is aan de `AFGEROND`
  // uit de bron. Gevolg: elke rij MET actiehouder gaf een onterecht rood. Gemeten op de echte plaat,
  // 26-07-2026: `status` kwam terug als "AFGEROND Richard: één keuze. Ga ik door met…".
  // `<br\b[^>]*>` en niet `<br\s*\/?>`: zodra `render.mjs` ooit `<br class="…">` schrijft, splitst de
  // strakke vorm niet meer en is de actiehouder wéér onderdeel van de status — vals rood (Codex E,
  // Gemini E2). De losse vorm splitst elke schrijfwijze van hetzelfde element.
  return { tab: cellen[0], onderwerp: cellen[1], status: cel(ruw[2].split(/<br\b[^>]*>/i)[0]), datum: cellen[3] };
}

/**
 * Het moment van een spiegelrij, behoudend geschat. De datumkolom is NL-tijd zonder zone; die hier
 * als UTC lezen legt het moment tot twee uur LATER dan het echt was, dus de rij lijkt jonger dan
 * hij is en valt eerder binnen het respijt. Die kant op mag de fout: hij maakt de waarnemer milder,
 * nooit ten onrechte rood.
 */
export function rijMoment(datum) {
  const m = String(datum ?? '').match(/^(\d{4}-\d{2}-\d{2})(?: (\d{2}):(\d{2}))?$/);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2] ?? '00'}:${m[3] ?? '00'}:00Z`);
  return Number.isNaN(t) ? null : t;
}

/** De vorm van een contractversie. BEGRENSD, want `versieMinstens()` zet de delen om met
 *  `parseInt`: bij een paar honderd cijfers wordt dat `Infinity` en heet elke versie ineens
 *  "ouder" — waarmee elke versiepoort zichzelf uitschakelt (bevinding Codex ronde 4, 23-08-2026).
 *  Dezelfde vorm geldt overal: wat de vergelijker niet aankan, heet ook niet leesbaar. */
export const VERSIE_VORM = /^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$/;

/**
 * De velden die een bron IDENTIFICEERBAAR en DATEERBAAR maken. Alleen een bron die ze alle drie
 * draagt mag als bewijs meetellen; dat is wat een verzonnen `{ trust: "VERIFIED_CURRENT" }` zonder
 * herkomst tegenhoudt (bevinding Codex, ronde 7).
 *
 * Dit is met opzet een KORTE, met de hand genoemde kern en niet het hele schema. Ronde 8 liet zien
 * waarom: een uit het schema afgeleide vormkeuring bindt onvermijdelijk óók de `required`-lijst en
 * de enums van ÉÉN versie, en dan geeft elke schemabump een luide ronde op een kerngezonde oudere
 * kopie — Codex reproduceerde dat met een 2.8-schema tegen een gezonde 2.7-plaat (8 afwijkingen) en
 * met een nieuwe trust-waarde tegen het oude schema (1 afwijking). Zo'n alarm komt bovendien
 * blijvend in het openbare logboek te staan. De kern hieronder verandert niet mee met het contract
 * en heeft dat venster dus niet.
 *
 * De prijs is afdrijving, en die is afgedekt: een test bindt dat elk kernveld ook in het schema
 * `required` is (orderdiscipline R2 — elke lijst met vaste literalen krijgt een test). De kern mag
 * krimpen, nooit groeien: een veld toevoegen is precies het venster dat we hier vermijden.
 */
export const KERN_BRONVELDEN = ['key', 'trust', 'retrievedAt'];

/**
 * Draagt deze bron de kern? Leeg of niet-tekst telt niet als "draagt", en `retrievedAt` moet een
 * LEESBAAR TIJDSTIP zijn en niet zomaar tekst: tot ronde 9 kwam `"geen datum"` er gewoon doorheen
 * en kocht daarmee bewijs (bevinding Codex, ronde 9). Een tijdstip is een tijdstip in elke
 * contractversie, dus deze eis heeft het bumpvenster niet dat het vormschema wél had.
 *
 * De eis is in ronde 10 aangescherpt van `Date.parse` naar `parseTijdstempel`: `Date.parse("0")`
 * leverde een geldig getal en dus bewijs, en `2026-02-30` werd stilzwijgend rechtgezet naar 2
 * maart. Een tijdstip moet zonebewust ISO-8601 zijn én op de kalender bestaan; anders is het geen
 * herkomst maar tekst die eruitziet als herkomst (bevinding Codex, ronde 10).
 */
export function kernCompleet(bron) {
  if (!bron || typeof bron !== 'object' || Array.isArray(bron)) return false;
  if (!KERN_BRONVELDEN.every((veld) => typeof bron[veld] === 'string' && bron[veld].trim() !== '')) return false;
  return parseTijdstempel(bron.retrievedAt) !== null;
}

/**
 * Het machineleesbare statusbestand van de plaat (`public/status.json`), gelezen met een parser.
 *
 * Vier reviewrondes lang stond de meting in de HTML-kop en vier keer vond de review daar hetzelfde
 * soort gat: een zelfgeschreven scanner is geen HTML5-parser, en de klasse "leest anders dan een
 * browser" liet zich niet per geval dichtmetselen (`<noscript>`, `<div>` dat de kop impliciet
 * sluit, `<!doctype html <meta>>`, karakterverwijzingen). Een echte parser meenemen kan niet:
 * de waakvlam draait `node scripts/waarnemer.mjs` zonder installatiestap.
 *
 * Daarom leest de waakvlam de meting niet meer uit opmaak maar uit het kanaal dat er al voor
 * bestond: `status.json` staat op de publicatie-allowlist, heeft een eigen schema
 * (`contracts/status-json.schema.json`) met `contractVersion` en per bron een `trust`, en komt uit
 * dezelfde build als de pagina. JSON.parse kent geen dubbelzinnigheid; een tweede, tegensprekende
 * waarde bestaat er niet. Het merk in de kop van de pagina blijft staan als eerlijke mededeling
 * aan wie de pagina zelf bekijkt, maar het is niet meer wat de waakvlam beoordeelt.
 */
export function statusUitTekst(httpStatus, tekst, schema = null) {
  const leeg = { totaal: null, bewezen: null, ongeteld: null, gebouwdOp: null, getoetst: false };
  const mis = (reden) => ({ contract: null, bronnen: { leesbaar: false, reden, ...leeg } });

  if (Number(httpStatus) !== 200) return mis(`statusbestand http ${Number(httpStatus) || 0}`);
  let json;
  try { json = JSON.parse(String(tekst ?? '')); } catch { return mis('statusbestand is geen geldige JSON'); }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return mis('statusbestand is geen object');

  const contract = VERSIE_VORM.test(String(json.contractVersion ?? '')) ? String(json.contractVersion) : null;
  // De bouwidentiteit. `generatedAt` is hetzelfde tijdstip dat de pagina als cache-buster in haar
  // refresh-tag zet; op de live publicatie gemeten (23-08-2026): status.json
  // `2026-08-23T09:14:09.272Z` naast paginabuster `?v=20260823091409272`, dezelfde bouw tot op de
  // milliseconde. Zonder dit veld is een statusbestand niet aan een pagina toe te schrijven.
  // Ook hier de strikte ontleding en niet `Date.parse`: met `generatedAt: "0"` werd 31-12-1999 een
  // geldig bouwmoment, en dat bouwmoment kocht via het respijt de CDN-vrijstelling waarmee de
  // bronstand ongemoeid bleef -- groen op nul bronnen (bevinding Codex, ronde 10).
  const gebouwdOp = parseTijdstempel(json.generatedAt) !== null ? json.generatedAt : null;
  // `getoetst` zegt of de KEURING heeft plaatsgevonden, niet of ze slaagde. Een bestand dat op zijn
  // eigen schema valt is wél gekeurd; het tegenovergestelde melden zou de oorzaak wegpoetsen op
  // precies het pad waar hij gevonden is (orderdiscipline R2).
  const onleesbaar = (reden, gekeurd = false) => ({
    contract, bronnen: { leesbaar: false, reden, ...leeg, gebouwdOp, getoetst: gekeurd },
  });

  // Een onleesbare contractversie is zelf een afwijking, precies zoals bij de PAGINA. Zonder
  // leesbare versie is niet te zeggen welk contract dit bestand beweert te volgen, en tot ronde 8
  // kocht juist die onleesbaarheid een vrijstelling van de volle keuring: `getoetst` werd `false`
  // en daarmee gold alleen de kern (bevinding Codex, ronde 8).
  if (contract === null) return onleesbaar('contractversie van het statusbestand is niet te lezen');

  // Het schema is de enige plek waar de vorm van dit bestand vastligt; `JSON.parse` alleen keurt
  // niets (bevinding Codex, ronde 5). Er wordt op TWEE niveaus gekeurd:
  //
  //  - Beweert het bestand ONZE contractversie, dan is ons schema er het gezag over en geldt het
  //    volle contract, `additionalProperties: false` incluis. Vals alarm kan hier niet: het bestand
  //    zegt zelf dat het deze versie is.
  //  - Beweert het een ANDERE versie, dan mag ons schema niet het laatste woord hebben — een oudere
  //    of nieuwere gepubliceerde kopie kent per definitie andere verplichte velden en andere enums.
  //    Daar geldt alleen de kern (`KERN_BRONVELDEN`), en die geldt per bron, niet over het hele
  //    bestand: een bron zonder herkomst telt niet mee, de rest wordt gewoon geteld.
  //
  // Wat hier NIET meer staat is een versiepoort: er is geen tak die het oordeel overslaat op gezag
  // van het bestand zelf. Een vreemde versie maakt de keuring milder, nooit afwezig, en de TELLING
  // wordt altijd geveld.
  if (schema === null) return onleesbaar('geen schema om het statusbestand aan te toetsen');
  const schemaVersie = schema?.properties?.contractVersion?.const ?? null;
  const getoetst = schemaVersie !== null && contract === schemaVersie;
  if (getoetst) {
    const fouten = validate(schema, json);
    if (fouten.length) {
      return onleesbaar(`statusbestand volgt zijn eigen contract niet (${fouten.length} afwijking${fouten.length === 1 ? '' : 'en'})`, true);
    }
  }

  if (!Array.isArray(json.sources)) return onleesbaar('statusbestand noemt geen bronnen');
  // Alleen een bron met de kern telt als bewijs. `ongeteld` houdt bij hoeveel er zich WEL bewezen
  // noemden maar geen herkomst droegen — dat mag niet in stilte verdwijnen (orderdiscipline R2).
  const beweren = json.sources.filter((x) => x && typeof x === 'object' && x.trust === 'VERIFIED_CURRENT');
  const bewezen = beweren.filter(kernCompleet).length;
  const ongeteld = beweren.length - bewezen;
  return {
    contract,
    bronnen: { leesbaar: true, reden: null, totaal: json.sources.length, bewezen, ongeteld, gebouwdOp, getoetst },
  };
}

/*
 * Hier stond `BRONSTAND_VANAF = '2.7.0'`: de versiepoort waarmee een oudere kopie van de plaat
 * buiten de bronstandtoets viel. Die is weg (Codex ronde 6). Hij hoorde bij het merk in de KOP van
 * de pagina, dat pas vanaf 2.7.0 bestaat — maar de meting komt niet uit de kop, ze komt uit
 * `status.json`, en dat draagt `sources` met `trust` al veel langer. De poort stelde dus niets vrij
 * dat vrijstelling nodig had, en las zijn voorwaarde uit hetzelfde bestand dat hij vrijstelde.
 * De rest van de zelf-bewapening (`KANAALPOST_VANAF`, `SECTIES_VANAF`) blijft ongemoeid: díe
 * toetsen lezen wél de pagina, en daar is de versiepoort op zijn plaats.
 */

/**
 * Hoeveel bronnen achter de pagina zijn bewezen? De plaat draagt dat als machinemerk in haar kop
 * (`bronstandMerk` in render.mjs). Alleen de KOP wordt gelezen en er moet precies één treffer zijn
 * — dezelfde tuchtregel als bij de bouwstempel, en om dezelfde reden: de body van de plaat bevat
 * gesaneerde bronregels, en die mogen een meetwaarde nooit kunnen namaken of verdubbelen.
 *
 * Onmogelijke getallen tellen als onleesbaar, niet als stand. Meer bewezen dan gelezen bronnen,
 * een negatief aantal of iets buiten het veilige integerbereik betekent dat de kop niet klopt; dan
 * hoort de waarnemer te zeggen dat hij het niet weet in plaats van door te rekenen op onzin.
 */
/**
 * Elementen waarvan de INHOUD geen opmaak is. Wat hierin staat ziet de browser als tekst, dus de
 * waarnemer mag het ook niet als element lezen. `template` staat er bewust bij: de inhoud daarvan
 * is wél DOM, maar inert — een merk daarin meet niets.
 */

/**
 * De hele toetsing over binnengehaalde tekst. Geen netwerk, geen klok van zichzelf: `nu` komt van
 * buiten zodat elke uitkomst in een test exact te zetten is.
 */
/**
 * Nevenpunten zijn geen bevindingen: ze maken een ronde niet rood. Ze reizen wél mee in de publieke
 * alarmregel zodra er om een andere reden alarm is, want een reductie mag de oorzaak niet weggooien
 * (orderdiscipline R2). Tot ronde 9 bleef `ongeteld` steken in een waarschuwing die alleen in de
 * runlog stond; in de openbare melding was er niets van terug te vinden (bevinding Codex, ronde 9).
 *
 * Gesloten lijst van vaste literalen — een nevenpunt is altijd een sleutel uit `CODES`.
 */
export const NEVENPUNTEN = Object.freeze(['BRON_ZONDER_HERKOMST']);

export function toets({
  paginaStatus, paginaHtml, spiegelStatus, spiegelTekst,
  paginaRoute, contractVersie = null, bronstand = null, bronContractVersie = null, nu = 0,
  drempelMs = DREMPEL_UREN * UUR, graceMs = GRACE_MINUTEN * MIN,
} = {}) {
  const bevindingen = [];
  const waarschuwingen = [];
  const nevenpunten = [];
  const gemeten = { stempelIso: null, leeftijdMs: null, paginaRij: null, bronRij: null, contract: contractVersie, bronnen: null, bouwVerschilMs: null };
  const meld = (code, extra = '') => bevindingen.push({ code, uitleg: CODES[code] + (extra ? ` (${extra})` : '') });

  // 1 — bereikbaar en bestempeld.
  if (Number(paginaStatus) !== 200) {
    meld('PAGINA_ONBEREIKBAAR');
    return { ok: false, bevindingen, waarschuwingen, nevenpunten, gemeten };
  }
  const html = String(paginaHtml ?? '');
  if (html.trim().length < 200) {
    meld('PAGINA_LEEG');
    return { ok: false, bevindingen, waarschuwingen, nevenpunten, gemeten };
  }
  // 1b -- de plaat moet zelf zeggen welke contractversie haar bouwde. Zonder leesbare versie is
  // ELKE versiepoort hieronder blind: `null` leest daar als "ouder dan", waardoor toets 3, 4 en 5
  // zichzelf uitschakelen op precies de pagina die de waarnemer niet herkent. Codex bewees dat gat
  // (P2, 23-08-2026): met de contractvoettekst weggehaald gaf `toets()` `contract=null, ok=true,
  // bevindingen=[]`. Een onherkenbare plaat is daarom zelf een bevinding, en die valt VOOR de
  // poorten -- niet erna, want dan zou de bevinding afhangen van de poort die ze moet redden.
  const contractLeesbaar = VERSIE_VORM.test(String(contractVersie ?? ''));
  if (!contractLeesbaar) meld('CONTRACT_ONLEESBAAR');

  const stempel = stempelUitHtml(html, { route: paginaRoute });
  if (!stempel.gevonden) meld('STEMPEL_ONTBREEKT');
  else if (!stempel.iso) meld('STEMPEL_ONLEESBAAR');
  else {
    gemeten.stempelIso = stempel.iso;
    // 2 — leeftijd onder de drempel, óf de pagina zegt zelf dat ze verouderd is.
    // De zichtbare tijd wordt aan BEIDE kanten gecontroleerd: de UTC-tijd tegen de stempel, en de
    // NL-tijd tegen diezelfde stempel omgerekend naar Amsterdam. Anders blijft een pagina die "00:00
    // NL-tijd (11:55 UTC)" toont groen, terwijl de mens juist naar die eerste tijd kijkt.
    if (stempel.utcHhmm && stempel.utcHhmm !== stempel.iso.slice(11, 16)) meld('STEMPEL_INCONSISTENT');
    else if (stempel.nlHhmm && stempel.nlHhmm !== nlTijd(Date.parse(stempel.iso)).slice(11, 16)) meld('STEMPEL_INCONSISTENT');
    const leeftijd = Number(nu) - Date.parse(stempel.iso);
    gemeten.leeftijdMs = leeftijd;
    // Een stempel in de toekomst is nooit "vers": zo'n negatieve leeftijd zou elke drempel passeren
    // en de leeftijdstoets permanent uitschakelen. Een paar minuten klokverschil mag.
    if (leeftijd < -KLOKSPELING_MS) meld('STEMPEL_IN_TOEKOMST');
    if (leeftijd > drempelMs && !html.includes(VEROUDERD_MARKER)) {
      meld('STEMPEL_TE_OUD', leeftijd < UUR
        ? `leeftijd ongeveer ${Math.round(leeftijd / MIN)} minuten`
        : `leeftijd ongeveer ${Math.round(leeftijd / UUR)} uur`);
    }
  }

  // 3 — de bovenste rij op de pagina is de laatste melding uit de bron.
  const kanaalpostVerplicht = versieMinstens(contractVersie, KANAALPOST_VANAF);
  const sectie = sectieUitHtml(html, 'kanaalpost');
  const publiek = toPublicKanaalpost(kanaalpostUitTekst(String(spiegelTekst ?? '')));
  if (Number(spiegelStatus) !== 200) {
    bevindingen.push({ code: 'SPIEGEL_ONBEREIKBAAR', uitleg: CODES.SPIEGEL_ONBEREIKBAAR });
  } else if (!publiek.available) {
    // Een bron waarin geen enkele rij door de poort komt is een echte afwijking: dan is óf het
    // formaat gewijzigd, óf de hele post wordt ingehouden. Beide horen zichtbaar te zijn.
    bevindingen.push({ code: 'SPIEGEL_ONLEESBAAR', uitleg: CODES.SPIEGEL_ONLEESBAAR });
  } else if (!sectie) {
    if (kanaalpostVerplicht) meld('KANAALPOST_ONTBREEKT');
    else waarschuwingen.push('de logboek-sectie staat nog niet op de gepubliceerde pagina; die komt met een nieuwere versie van de plaat, dus dit telt nog niet als afwijking');
  } else {
    const paginaRij = eersteKanaalpostRij(sectie);
    gemeten.paginaRij = paginaRij;
    gemeten.bronRij = publiek.rows[0] ?? null;
    if (!paginaRij) meld('KANAALPOST_ZONDER_RIJEN');
    else {
      // Hoeveel rijen mag de pagina achterlopen? Precies de rijen die nog binnen het respijt vallen:
      // die konden de bouw- en cacheketen nog niet doorlopen hebben. Zijn alle rijen ouder, dan moet
      // de bovenste op de pagina exact de bovenste uit de bron zijn.
      let respijt = 0;
      while (respijt < publiek.rows.length) {
        const moment = rijMoment(publiek.rows[respijt].datum);
        if (moment === null || Number(nu) - moment > graceMs) break;
        respijt += 1;
      }
      // Ook de status vergelijken: een pagina die een AFGEROND-melding als GEBLOKKEERD toont (of
      // andersom) toont de verkeerde werkelijkheid, ook al klopt de tekst. De actiehouder blijft
      // buiten de vergelijking — die staat in de gerenderde tabel niet als eigen kolom.
      // Eén verschil egaliseren, niet de hele normalisatie. `ontdaan` doet NFKC, en NFKC maakt van het
      // afkap-teken `…` de drie punten `...`. De bron krijgt haar `…` er ná de normalisatie op (`cap()`
      // in kanaalpost.mjs), de pagina gaat er nog een keer door — dus liep elke AFGEKAPTE rij uiteen op
      // precies het laatste teken. Gemeten op de echte plaat, 26-07-2026: pagina "…bel uit..." tegen
      // bron "…bel uit…", eerste verschil op teken 599 van 600.
      // Waarom NIET `ontdaan(x) === ontdaan(y)`, wat de eerste reparatie deed: beide velden zijn al
      // genormaliseerd (de bron in de parser, de pagina in `eersteKanaalpostRij`), dus een tweede
      // `ontdaan` erover repareert niets extra en voegt wél iets toe — `ontdaan` doet eerst NFKC en
      // strípt daarna onzichtbare tekens, en is in die volgorde niet universeel idempotent, zoals Codex
      // aanwees met `A​̊`. Alleen het afkap-teken hoefde tolerantie. Elk ander verschil dat
      // hierna overblijft wordt ROOD, niet groen; die kant mag de fout op.
      // Wat deze regel NIET oplost, expliciet: `eersteKanaalpostRij` normaliseert de paginakant met
      // NFKC, en NFKC is niet injectief — een pagina die `10²` toont waar de bron `102` zegt, of `ﬀ`
      // waar `ff` staat, wordt gelijk genoemd. Die tolerantie zat er al vóór deze ronde in en wordt
      // erdoor niet groter. Ze is begrensd doordat de pagina uit diezelfde genormaliseerde bron wordt
      // gerenderd; de tekens kunnen daar niet ongelijk in terechtkomen zonder een fout in `render.mjs`.
      // Als open punt naar Richard/Fable, niet stil weggelaten (zie §6 van het rapport).
      const ellips = (v) => String(v ?? '').replaceAll('…', '...');
      const gelijk = (x, y) => ellips(x) === ellips(y);
      const zelfde = (a, b) => Boolean(a) && Boolean(b) && gelijk(a.tab, b.tab) && gelijk(a.datum, b.datum)
        && gelijk(a.onderwerp, b.onderwerp) && gelijk(a.status, b.status);
      const treffer = publiek.rows.slice(0, respijt + 1).some((r) => zelfde(paginaRij, r));
      if (!treffer) meld('PAGINA_TOONT_OUDE_DATA', `de pagina toont bovenaan een melding van ${paginaRij.datum || 'onbekende datum'}`);
    }
  }

  // 4 — verplichte secties aanwezig, niet leeg, niet kapot. De versie-gepoorte secties komen uit
  // één tabel, zodat een nieuwe sectie hier niet vergeten kan worden zoals `vlootstand` en
  // `gedeelde-weergave` dat tot 02-08-2026 waren: `kanaalpost` was de enige die een eigen poort had,
  // dus elke sectie die daarna op de plaat kwam viel stilzwijgend buiten toets 4.
  const verplicht = [
    ...VERPLICHTE_SECTIES,
    ...Object.entries(SECTIES_VANAF).filter(([, vanaf]) => versieMinstens(contractVersie, vanaf)).map(([id]) => id),
  ];
  for (const id of verplicht) {
    const inhoud = sectieUitHtml(html, id);
    if (inhoud === null) { meld('SECTIE_ONTBREEKT', `sectie ${id}`); continue; }
    // Een markering is nog geen inhoud: `<p class="empty"></p>` en `<tr></tr>` zijn allebei leeg.
    // Daarom wordt er op zichtbare tekst geoordeeld, met de kop eraf — die staat er altijd.
    const zonderKop = inhoud.replace(/<h2\b[\s\S]*?<\/h2>/i, ' ');
    const zichtbaar = ZONDER_TAGS(zonderKop);
    const heeftCel = /<td[^>]*>\s*(?:<[^>]+>\s*)*[^\s<]/.test(zonderKop);
    if (!heeftCel && zichtbaar.length < 12) meld('SECTIE_LEEG', `sectie ${id}`);
  }
  const spoor = KAPOT_SPOREN.find((k) => html.includes(k));
  if (spoor) meld('PAGINA_KAPOT');

  // 5 — de plaat rust op minstens een bewezen bron. Toets 1 t/m 4 kijken naar de VORM van de
  // pagina: staat ze er, is ze vers, staan de secties erin. Ze kijken niet naar de vraag of er nog
  // iets ACHTER die vorm zit. Op 22-08-2026 bleek dat gat echt: vanaf 14:24 UTC leverde de bouw
  // vijftien uur lang een plaat af waarin geen enkele bron geverifieerd was, en de waarnemer draaide
  // in datzelfde venster 81 keer groen (gemeten met `gh run list --workflow=waarnemer.yml`). De
  // pagina was namelijk keurig vers en compleet; alleen leeg vanbinnen. Een bewaker die dat groen
  // noemt bewaakt de lijst en niet de plaat.
  //
  // GEEN PUBLICATIEPOORT. Deze toets houdt niets tegen. De plaat hoort eerlijk te publiceren met
  // "niet geverifieerd" erop -- dat is haar fail-closed-gedrag en dat is goed. Wat ontbrak was het
  // SIGNAAL: rood in de run en een regel in de spiegel, zodat een lege plaat niet stil kan blijven.
  //
  // De meting komt binnen als al gelezen feit uit `statusUitTekst()` -- het statusbestand van de
  // plaat, niet haar opmaak. Deze toets oordeelt, hij parseert niet.
  const gemetenBron = bronstand
    ?? { leesbaar: false, reden: 'geen bronstand gemeten', totaal: null, bewezen: null, ongeteld: null, gebouwdOp: null, getoetst: false };
  gemeten.bronnen = gemetenBron;

  // De bouwidentiteit bindt de meting aan DEZE pagina. Zonder die band oordeelt de waakvlam over een
  // willekeurig ander bestand: een statusbestand uit een oudere bouw kon zowel de telling leveren als
  // de versie waarmee die telling zichzelf vrijstelt (bevinding Codex, ronde 5). De vergelijking is
  // exact — `generatedAt` en de cache-buster van de pagina zijn hetzelfde tijdstip — maar op het
  // TIJDSTIP, niet op de schrijfwijze. Tot ronde 12 stonden hier twee tekenreeksen naast elkaar,
  // terwijl de pagina haar stempel altijd als `...Z` opbouwt (`stempelUitHtml`) en `status.json` net
  // zo goed `...+00:00` mag dragen: dezelfde bouw gold dan als twee bouwen, en dat kocht precies de
  // naijlingsvrijstelling die het oordeel overslaat (bevinding Gemini, ronde 10).
  //
  // Het respijt meet hoe VERS de nieuwste van de twee bouwen is, niet hoe ver ze uit elkaar liggen.
  // Dat onderscheid is een correctie op ronde 6: naijling van de CDN duurt hooguit ongeveer tien
  // minuten, maar twee opeenvolgende bouwen kunnen uren uit elkaar liggen (publish draait 05:45 en
  // 15:45). Op het verschil tussen de bouwen afgaan gaf daardoor vals rood op precies het moment dat
  // een gezonde publicatie half was doorgezakt naar de CDN. Wat telt is: is er zojuist gepubliceerd?
  // Dan is een mengsel van oud en nieuw te verwachten en oordeelt de waakvlam deze ronde niet, met
  // een zichtbare waarschuwing. Staat de nieuwste bouw al langer dan het respijt stil en lopen de
  // twee bestanden nog steeds uiteen, dan is de publicatie blijven steken en is dat een bevinding.
  const stempelMs = gemeten.stempelIso === null ? null : Date.parse(gemeten.stempelIso);
  const bronMs = gemetenBron.gebouwdOp === null ? null : Date.parse(gemetenBron.gebouwdOp);
  const zelfdeBouw = bronMs !== null && stempelMs !== null
    && Number.isFinite(bronMs) && Number.isFinite(stempelMs) && bronMs === stempelMs;
  const nieuwsteBouwMs = [stempelMs, bronMs].filter((x) => x !== null && Number.isFinite(x))
    .reduce((a, b) => Math.max(a, b), Number.NEGATIVE_INFINITY);
  // Het venster loopt naar twee kanten, maar niet even ver. Naar ACHTEREN het volle respijt: zo lang
  // mag een publicatie erover doen om overal aan te komen. Naar VOREN alleen de klokspeling tussen
  // bouwmachine en controlemachine — een bouwstempel dat verder in de toekomst ligt is geen verse
  // publicatie maar een verzet uurwerk of een verzonnen stempel, en zo'n stempel mag zichzelf niet
  // als naijling voordoen. Tot ronde 7 stond hier `-graceMs`, waardoor een stempel tot drie kwartier
  // vooruit juist wél als vers gold; dat was precies de vrijstelling die een verzonnen tijd kon
  // kopen (bevinding Codex, ronde 7).
  const bouwOuderdomMs = Number.isFinite(nieuwsteBouwMs) ? nu - nieuwsteBouwMs : null;
  const verseBouw = bouwOuderdomMs !== null && bouwOuderdomMs >= -KLOKSPELING_MS && bouwOuderdomMs <= graceMs;
  gemeten.bouwVerschilMs = stempelMs !== null && bronMs !== null && Number.isFinite(stempelMs) && Number.isFinite(bronMs)
    ? Math.abs(bronMs - stempelMs)
    : null;
  // Is het statusbestand het VERSTE dat we van deze publicatie kunnen zien? Dan loopt het nergens op
  // achter en is er geen reden om zijn telling uit te stellen (bevinding Codex, ronde 11).
  // Gelijk hoeft hier niet meegeteld: twee gelijke tijdstippen zijn sinds ronde 12 dezelfde bouw en
  // komen niet op dit pad. Een dode gelijkheidshelft zou bovendien precies zijn wat Codex in ronde
  // 12 aanwees: een tak die geen enkele test kan raken.
  const bronIsNieuwste = bronMs !== null && Number.isFinite(bronMs)
    && (stempelMs === null || !Number.isFinite(stempelMs) || bronMs > stempelMs);

  // Dezelfde categorie op elke plek waar de telling werkelijk beoordeeld wordt: een reductie mag de
  // oorzaak niet weggooien, ook niet op een tweede pad (orderdiscipline R2).
  const meldOngeteld = () => {
    if (!gemetenBron.ongeteld) return;
    waarschuwingen.push(`${gemetenBron.ongeteld} bron(nen) noemden zich bewezen zonder herkomst (${KERN_BRONVELDEN.join(', ')}) en tellen dus niet mee`);
    nevenpunten.push({ code: 'BRON_ZONDER_HERKOMST', uitleg: `${CODES.BRON_ZONDER_HERKOMST} (${gemetenBron.ongeteld} van ${gemetenBron.totaal})` });
  };

  // Geen enkele tak mag het bronstandoordeel nog OVERSLAAN op gezag van het statusbestand zelf.
  // Er stonden hier twee zulke ontsnappingen — een versiepoort (`BRONSTAND_VANAF`) en de
  // schemakeuring — en allebei lazen ze hun voorwaarde uit hetzelfde bestand dat ze vrijstelden
  // (bevinding Codex, ronde 6). De versiepoort was bovendien een overblijfsel: hij hoorde bij het
  // merk in de kop van de pagina, dat pas vanaf 2.7.0 bestond. `status.json` draagt `sources` met
  // `trust` al veel langer — de LIVE 2.6.0-plaat levert er gewoon `4 van 8` uit — dus een oudere
  // kopie kán deze toets doorstaan en hoeft er niet van vrijgesteld te worden. Wat overblijft is één
  // regel zonder uitzonderingen: is de stand leesbaar en hoort hij bij deze bouw, dan wordt hij
  // beoordeeld. Een ongekeurd bestand (andere contractversie dan het schema) wordt óók beoordeeld;
  // dat het niet gekeurd kon worden is een waarschuwing, geen vrijbrief.
  if (!gemetenBron.leesbaar) meld('BRONSTAND_ONLEESBAAR', gemetenBron.reden ?? undefined);
  else if (!zelfdeBouw) {
    // De naijlingsvrijstelling stelt het oordeel over de bronstand één ronde uit omdat er zojuist
    // gepubliceerd is en een mengsel van oud en nieuw dan te verwachten is. Ze vraagt daarom een
    // statusbestand dat AAN EEN BOUW VASTZIT: zonder bruikbaar `generatedAt` is er niets om het
    // oordeel naar door te schuiven, en is het bestand niet "onderweg" maar niet toe te schrijven.
    // Zonder deze eis kocht een stempel als `"0"` de vrijstelling zolang de PAGINA maar vers was --
    // en de vrijstelling slaat juist de telling over. Echte reproductie: pagina 5 min oud,
    // `generatedAt: "0"`, `bronnen: 0 van 2 geverifieerd`, exit 0 (bevinding Gemini, ronde 8).
    if (!(verseBouw && gemetenBron.gebouwdOp !== null)) {
      meld('BRONSTAND_ANDERE_BOUW', gemetenBron.gebouwdOp === null
        ? 'geen bouwtijd om aan te knopen'
        : (bouwOuderdomMs !== null && bouwOuderdomMs < -KLOKSPELING_MS
          ? `de nieuwste van de twee bouwen ligt ${Math.round(-bouwOuderdomMs / 60000)} min in de toekomst, meer dan de klokspeling van ${Math.round(KLOKSPELING_MS / 60000)} min`
          : `de nieuwste van de twee bouwen is ${Math.round((bouwOuderdomMs ?? 0) / 60000)} min oud, ruim buiten het respijt van ${Math.round(graceMs / 60000)} min`));
    } else if (bronIsNieuwste && gemetenBron.bewezen === 0) {
      // Het respijt bestaat om NIET te oordelen op een bestand dat mogelijk achterloopt. Is het
      // statusbestand juist de NIEUWSTE van de twee, dan loopt het nergens op achter: dan is het het
      // verste dat we van deze publicatie kunnen zien, en meldt het nul bewezen bronnen. Daar valt
      // niets meer op te wachten -- dat IS het incident van 22-08, alleen tijdens een publicatie.
      // Echte reproductie: pagina 4 uur oud uit de cache, statusbestand 1 min oud, beide 2.7.0,
      // beide nul bewezen -- `exit 0` met een naijlingswaarschuwing (bevinding Codex, ronde 11).
      // De andere kant blijft ongemoeid: een OUDER nul-statusbestand naast een NIEUWERE pagina mag
      // een gezonde verse publicatie niet vals rood maken, en houdt dus het respijt.
      waarschuwingen.push('het statusbestand komt van een andere bouw dan de pagina die nu geserveerd wordt; het is wél de nieuwste van de twee, dus de bronstand wordt beoordeeld en niet uitgesteld');
      meldOngeteld();
      meld('GEEN_GEVERIFIEERDE_BRON', `0 van ${gemetenBron.totaal} bronnen (uit de nieuwste van de twee bouwen)`);
    } else {
      waarschuwingen.push('het statusbestand komt van een andere bouw dan de pagina die nu geserveerd wordt; er is zojuist gepubliceerd, dus dit telt als naijling van de CDN en de bronstand is deze ronde niet beoordeeld');
    }
  } else {
    // Pagina en statusbestand komen hier aantoonbaar uit DEZELFDE bouw (`zelfdeBouw` hierboven, op
    // `generatedAt` = de cache-buster van de pagina). Eén bouw kan maar één contractversie hebben.
    // Noemen ze er twee, dan is minstens één van beide verzonnen of verwisseld -- en precies dat was
    // het groene pad dat Codex in ronde 9 reproduceerde: een pagina met 2.7.0 en nul bewezen bronnen
    // naast een statusbestand dat zich 9.9.9 noemde, daarmee de volle keuring uitschakelde en met
    // drie losse strings zijn eigen bewijs leverde. De milde kernkeuring hoort bij een ECHTE oudere
    // of nieuwere gepubliceerde kopie -- dan draagt de PAGINA diezelfde vreemde versie ook.
    if (bronContractVersie !== null && contractLeesbaar && bronContractVersie !== contractVersie) {
      meld('CONTRACT_UITEEN', `plaat ${contractVersie}, statusbestand ${bronContractVersie}`);
    }
    if (!gemetenBron.getoetst) {
      waarschuwingen.push('het statusbestand draagt een andere contractversie dan het schema dat de waakvlam kent; alleen de kernvelden per bron zijn gekeurd, niet het volle contract — de telling wordt wél beoordeeld');
    }
    meldOngeteld();
    if (gemetenBron.bewezen === 0) meld('GEEN_GEVERIFIEERDE_BRON', `0 van ${gemetenBron.totaal} bronnen`);
  }

  return { ok: bevindingen.length === 0, bevindingen, waarschuwingen, nevenpunten, gemeten };
}

/** `STEMPEL_TE_OUD` → `stempel-te-oud`: leesbaar in de spiegel én weer terug te lezen bij de
 *  herhaalcontrole. */
export const codeWoord = (code) => String(code).toLowerCase().replace(/_/g, '-');

const nlTijd = (ms) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};

/**
 * De vaste kop van élke zelfmelding van de waarnemer. Geëxporteerd omdat hij het ENIGE
 * machinekenmerk is waaraan een lezer een zelfmelding kan herkennen zonder te raden: de tab alleen
 * volstaat niet, want dezelfde tab kan ook een inhoudelijke poort melden. Wie hierop filtert leest
 * mee met de schrijver — daarom is deze constante de bron, en heeft niemand een eigen kopie.
 */
export const ALARM_KOP = '**De automatische controle ziet de openbare plaat afwijken van de bron.**';

/**
 * De alarmregel voor de publieke spiegel. Falen hoort zichtbaar te zijn op de plek waar Richard
 * kijkt, niet alleen in een logboek dat niemand opent — dus schrijft de waarnemer zijn eigen melding
 * in dezelfde spiegel als elk ander venster, in dezelfde vorm en langs dezelfde poort.
 *
 * De tekst blijft bewust arm: wát er afwijkt, in gewone taal, zonder adressen, paden of nummers.
 * Wie het naadje wil weten leest de run; de spiegel is de plek van het signaal.
 */
export function alarmRij({ bevindingen, nevenpunten = [], nu, sabotage = false, maxOnderwerp = 560 }) {
  // Nevenpunten staan achteraan: de aanleiding van het alarm hoort vooraan te blijven staan, ook als
  // de tekst wordt afgekapt. Hun categorie zit in de staart met controlepunten en overleeft het
  // afkappen dus hoe dan ook (orderdiscipline R2).
  const alles = [...bevindingen, ...nevenpunten.filter((n) => NEVENPUNTEN.includes(n?.code))];
  const codes = [...new Set(alles.map((b) => b.code))];
  const zinnen = [...new Set(alles.map((b) => b.uitleg))].join('; ');
  const staart = ` (controlepunten: ${codes.map(codeWoord).join(', ')})`;
  const test = sabotage ? ' Dit is een geplande sabotagetest van de waarnemer zelf, geen echte storing.' : '';
  const kop = ALARM_KOP;
  const ruimte = maxOnderwerp - kop.length - test.length - staart.length - 2;
  // Afkappen met drie punten en niet met het teken `…`: de spiegel eist op de schrijfkant één
  // canonieke vorm (besluit Fable, punt 3), en `…` is niet zijn eigen NFKC-vorm. De waarnemer krijgt
  // daar geen uitzondering op — juist de bewaker moet door de poort die hij bewaakt.
  // De punt hoort BINNEN deze keuze, niet erachter: met een punt erachter eindigde een afgekapte tekst
  // op vier punten (`....`), en de eerste test hierop keek met `includes('...')` en zag dat niet
  // (bevinding Codex, 26-07-2026).
  const kern = zinnen.length > ruimte ? `${zinnen.slice(0, Math.max(0, ruimte - 3)).trimEnd()}...` : `${zinnen}.`;
  const onderwerp = `${kop} ${kern}${test}${staart}`;
  return `| ${nlTijd(nu)} | WAARNEMER | ${onderwerp} | GEBLOKKEERD | Richard of Fable |`;
}

/**
 * Komt de alarmregel zelf door de publicatiepoort? Een alarm dat wordt ingehouden is geen alarm —
 * dan hoort de run rood te blijven en er niets in de spiegel te komen, in plaats van een regel die
 * de plaat vervolgens stilletjes weglaat. Getoetst langs exact dezelfde weg als elke andere rij:
 * de echte parser en de echte DTO, niet een kopie van hun regels.
 */
export function alarmRijPubliceerbaar(rij) {
  const proef = ['| datum-tijd | tab-rol | onderwerp | status | actie voor |',
    '| --- | --- | --- | --- | --- |', String(rij ?? '')].join('\n');
  const uit = toPublicKanaalpost(kanaalpostUitTekst(proef));
  // Ook de schrijfkant-eis, hier al: een regel die de spiegelwet later toch tegenhoudt hoort niet eens
  // uit deze functie te komen. Anders schrijft de waarnemer een alarm dat in CI blijft steken, en dat
  // is precies de stille uitval waar hij tegen is.
  return canoniek(rij) && uit.available === true && uit.rows.length === 1 && uit.ingehouden === 0;
}

/**
 * Niet elke ronde opnieuw dezelfde melding. Een storing die twaalf uur duurt hoort één regel te
 * krijgen, geen vierentwintig — anders verdrinkt de spiegel in zijn eigen alarm en leest niemand
 * hem nog. Zodra de combinatie van controlepunten verandert, is het een ander bericht en mag het
 * wél meteen.
 */
export function magAppenden(spiegelTekst, codes, nu, vensterMs = HERHAAL_UREN * UUR) {
  const doel = [...new Set(codes.map(codeWoord))].sort().join(',');
  // Alleen regels die zelf door de publicatiepoort komen tellen mee, en alleen regels met een
  // geloofwaardig moment: anders kan één handgeschreven WAARNEMER-regel met een datum in 2099 alle
  // toekomstige alarmen voorgoed monddood maken.
  const publiek = toPublicKanaalpost(kanaalpostUitTekst(String(spiegelTekst ?? '')));
  const binnenVenster = (publiek.rows ?? []).filter((r) => {
    if (ontdaan(r.tab) !== 'WAARNEMER') return false;
    const moment = rijMoment(r.datum);
    if (moment === null) return false;
    const ouderdom = Number(nu) - moment;
    return ouderdom >= -ZONE_SPELING_MS && ouderdom <= vensterMs;
  });
  if (!binnenVenster.length) return { mag: true, reden: 'geen eerdere melding van de waarnemer binnen het herhaalvenster' };
  // Niet alleen tegen de láátste melding vergelijken: twee storingen die elkaar afwisselen zouden
  // elkaar dan om beurten "nieuw" maken en de spiegel eindeloos volschrijven.
  const zelfde = binnenVenster.some((r) => {
    const eerder = String(r.onderwerp ?? '').match(/\(controlepunten: ([a-z0-9,\s-]+)\)/);
    return eerder ? eerder[1].split(',').map((x) => x.trim()).filter(Boolean).sort().join(',') === doel : false;
  });
  if (zelfde) return { mag: false, reden: 'dezelfde melding staat al in de spiegel binnen het herhaalvenster' };
  return { mag: true, reden: 'andere combinatie van controlepunten dan de meldingen binnen het venster' };
}
