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
import { canoniek } from './spiegelwet.mjs';

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
  BRONSTAND_ONLEESBAAR: 'op de pagina is niet te lezen hoeveel van haar bronnen geverifieerd zijn',
  CONTRACT_ONLEESBAAR: 'op de pagina is niet te lezen welke versie van de plaat dit is',
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
  const lees = (v) => String(v ?? '').split('.').map((x) => Number.parseInt(x, 10));
  const a = lees(gevonden);
  const b = lees(minimaal);
  if (a.length !== 3 || a.some((x) => !Number.isInteger(x))) return false;
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

/**
 * De contractversie zoals de plaat die zelf in haar voettekst zet. Stond eerst als losse regex in
 * `scripts/waarnemer.mjs`, waardoor de tests de versie injecteerden terwijl productie haar uit de
 * HTML haalde — precies het soort scheiding waarin een gat kan blijven zitten dat groen test
 * (bevinding Codex P1, 23-08-2026). Eén bron, door beide gebruikt.
 *
 * Bewust de volledige voettekstvorm en niet de eerste losse "(contract x.y.z)" in het document: de
 * INHOUD van de plaat kan die haakjes ook bevatten, en een lager gelezen versienummer zou de
 * zelf-bewapening van de versiepoorten stilletjes uitzetten.
 */
export function contractUitHtml(html) {
  // Precies één treffer, net als bij de bouwstempel en het bronstand-merk. De eerste treffer nemen
  // was fout: Codex zette een 2.6-voettekst in een comment vóór de echte 2.7-voettekst en kreeg
  // `contract=2.6.0` terug — waarmee de overgangsuitzondering weer aan stond op een pagina die het
  // merk hoorde te dragen (bevinding Codex ronde 2, 23-08-2026). Tegenspraak is geen versie.
  const treffers = [...String(html ?? '').matchAll(
    /Gegenereerd door <code>stack-dashboard<\/code> \(contract ([0-9]+\.[0-9]+\.[0-9]+)\)/g,
  )];
  return treffers.length === 1 ? treffers[0][1] : null;
}

/**
 * Vanaf deze contractversie MOET de pagina het bronstand-merk in haar kop dragen. Zelfde
 * zelf-bewapening als `KANAALPOST_VANAF` en `SECTIES_VANAF`: een kopie die vóór deze versie is
 * gebouwd kan het merk onmogelijk hebben en mag daar niet rood van worden, maar de uitzondering is
 * gebonden aan een versie en niet aan een datum of aan iemands geheugen. Zodra de plaat 2.7.0
 * stempelt is de toets hard, zonder dat iemand een schakelaar hoeft om te zetten.
 *
 * Dit vervangt een eerdere opzet waarin de oude vorm een onbeperkte waarschuwing kreeg: die
 * verontschuldigde ook een toekomstige rendererregressie voor altijd (bevinding Codex, 23-08-2026).
 */
export const BRONSTAND_VANAF = '2.7.0';

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
const INERTE_ELEMENTEN = new Set(['script', 'style', 'title', 'textarea', 'template']);

/**
 * De `<meta>`-elementen die in de kop ECHT werken — niet de tekst die er alleen maar uitziet als
 * een element. Dit is met opzet een kleine scanner en geen regex meer.
 *
 * Drie keer op rij vond de review hier hetzelfde soort gat, en telkens was de oorzaak dezelfde:
 * een regex kent de grammatica van HTML niet. `<meta\b[^>]*>` stopt bij een `>` BINNEN een
 * aanhalingsteken, waardoor een merk dat als tekst in een andere attribuutwaarde staat als echt
 * element werd gelezen (Codex ronde 3). Een globale comment-regex knipt vanaf een `<!--` binnen
 * een attribuutwaarde tot een veel latere `-->` en neemt het ECHTE merk mee (Codex ronde 3).
 * En een uitgecommentarieerd merk werd als meting geteld (Codex ronde 2). Eén scanner die
 * aanhalingstekens, commentaar en inerte elementen kent, maakt die hele klasse onmogelijk in
 * plaats van er per geval een regex bij te zetten.
 *
 * Levert `null` als de kop niet wordt afgesloten: dan is de pagina geen pagina en hoort de
 * waarnemer te zeggen dat hij het niet weet.
 */
function metasUitKop(html) {
  const tekst = String(html ?? '');
  const metas = [];
  let i = 0;
  while (i < tekst.length) {
    const punt = tekst.indexOf('<', i);
    if (punt === -1) return null;
    // Commentaar: alles tot `-->`. Zonder afsluiting leest een browser de REST van het document als
    // commentaar — dan is er geen kop meer en dus geen meting.
    if (tekst.startsWith('<!--', punt)) {
      const eind = tekst.indexOf('-->', punt + 4);
      if (eind === -1) return null;
      i = eind + 3;
      continue;
    }
    const naam = tekst.slice(punt).match(/^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/);
    if (!naam) { i = punt + 1; continue; }
    // Het einde van de tag, met aanhalingstekens: een `>` binnen een waarde sluit niets af.
    let j = punt + 1 + naam[0].length - 1;
    let aanhaling = null;
    while (j < tekst.length) {
      const c = tekst[j];
      if (aanhaling) { if (c === aanhaling) aanhaling = null; }
      else if (c === '"' || c === "'") aanhaling = c;
      else if (c === '>') break;
      j += 1;
    }
    if (j >= tekst.length) return null;
    const tag = tekst.slice(punt, j + 1);
    const element = naam[2].toLowerCase();
    const sluit = naam[1] === '/';
    if (sluit && element === 'head') return metas;
    if (!sluit && element === 'meta') metas.push(tag);
    if (!sluit && INERTE_ELEMENTEN.has(element) && !/\/>$/.test(tag)) {
      const dicht = tekst.slice(j + 1).search(new RegExp(`</${element}\\s*>`, 'i'));
      if (dicht === -1) return null;
      i = j + 1 + dicht;
      continue;
    }
    i = j + 1;
  }
  return null;
}

/**
 * Alle attributen van één tag, links naar rechts, INCLUSIEF losse (waardeloze) attributen en
 * herhalingen. Bewust een lijst en geen object: met een object verdwenen
 * `<meta disabled name=... content=...>` en een tweede, tegensprekende `content=` stilletjes uit
 * de telling, waardoor ze langs de eis "precies twee attributen" glipten (bevinding Codex ronde 2).
 */
function attribuutlijst(tag) {
  const binnen = String(tag).replace(/^<\s*[a-zA-Z][^\s/>]*/, '').replace(/\/?>$/, '');
  const uit = [];
  for (const a of binnen.matchAll(/([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]*))?/g)) {
    uit.push([a[1].toLowerCase(), a[2] === undefined ? null : a[2].replace(/^["']|["']$/g, '')]);
  }
  return uit;
}

export function bronstandUitHtml(html) {
  const onbekend = { leesbaar: false, totaal: null, bewezen: null };
  const metas = metasUitKop(html);
  if (metas === null) return onbekend;
  // Eerst ELKE meta tellen die zich bronstand noemt, ongeacht schrijfwijze — pas als er precies één
  // kandidaat is, wordt die gelezen. Zou hier meteen op één vaste schrijfwijze worden gezocht, dan
  // telt een tweede merk in een ándere attribuutvolgorde niet mee: het eerste blijft dan "de enige
  // treffer" en de tegenspraak ernaast wordt stil ingeslikt (bevinding Codex ronde 1).
  const kandidaten = metas.map(attribuutlijst)
    .filter((attrs) => attrs.some(([k, v]) => k === 'name' && String(v).toLowerCase() === 'bronstand'));
  if (kandidaten.length !== 1) return onbekend;
  // Getoetst wordt de BETEKENIS, niet de typografie: precies deze twee attributen, elk één keer,
  // en een content-waarde die exact aan de afgesproken vorm voldoet. Hoofdletters of een omgekeerde
  // volgorde veranderen niets aan wat er staat en horen de bewaker dus niet blind te maken
  // (bevinding Gemini P2/P4) — een waarde die iets ánders zegt, of een attribuut te veel, wel.
  const namen = kandidaten[0].map(([k]) => k).sort();
  if (namen.length !== 2 || namen[0] !== 'content' || namen[1] !== 'name') return onbekend;
  const inhoud = kandidaten[0].find(([k]) => k === 'content')[1];
  const vorm = String(inhoud).match(/^bewezen=(\d{1,9}) totaal=(\d{1,9})$/);
  if (!vorm) return onbekend;
  const bewezen = Number(vorm[1]);
  const totaal = Number(vorm[2]);
  if (!Number.isSafeInteger(bewezen) || !Number.isSafeInteger(totaal)) return onbekend;
  if (bewezen > totaal) return onbekend;
  return { leesbaar: true, totaal, bewezen };
}

/**
 * De hele toetsing over binnengehaalde tekst. Geen netwerk, geen klok van zichzelf: `nu` komt van
 * buiten zodat elke uitkomst in een test exact te zetten is.
 */
export function toets({
  paginaStatus, paginaHtml, spiegelStatus, spiegelTekst,
  paginaRoute, contractVersie = null, nu = 0,
  drempelMs = DREMPEL_UREN * UUR, graceMs = GRACE_MINUTEN * MIN,
} = {}) {
  const bevindingen = [];
  const waarschuwingen = [];
  const gemeten = { stempelIso: null, leeftijdMs: null, paginaRij: null, bronRij: null, contract: contractVersie, bronnen: null };
  const meld = (code, extra = '') => bevindingen.push({ code, uitleg: CODES[code] + (extra ? ` (${extra})` : '') });

  // 1 — bereikbaar en bestempeld.
  if (Number(paginaStatus) !== 200) {
    meld('PAGINA_ONBEREIKBAAR');
    return { ok: false, bevindingen, waarschuwingen, gemeten };
  }
  const html = String(paginaHtml ?? '');
  if (html.trim().length < 200) {
    meld('PAGINA_LEEG');
    return { ok: false, bevindingen, waarschuwingen, gemeten };
  }
  // 1b -- de plaat moet zelf zeggen welke contractversie haar bouwde. Zonder leesbare versie is
  // ELKE versiepoort hieronder blind: `null` leest daar als "ouder dan", waardoor toets 3, 4 en 5
  // zichzelf uitschakelen op precies de pagina die de waarnemer niet herkent. Codex bewees dat gat
  // (P2, 23-08-2026): met de contractvoettekst weggehaald gaf `toets()` `contract=null, ok=true,
  // bevindingen=[]`. Een onherkenbare plaat is daarom zelf een bevinding, en die valt VOOR de
  // poorten -- niet erna, want dan zou de bevinding afhangen van de poort die ze moet redden.
  const contractLeesbaar = /^[0-9]+\.[0-9]+\.[0-9]+$/.test(String(contractVersie ?? ''));
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
  const bronstand = bronstandUitHtml(html);
  gemeten.bronnen = bronstand;
  // De overgangsuitzondering geldt alleen voor een pagina die zélf zegt dat ze ouder is. Kan de
  // contractversie niet uit de plaat worden gelezen, dan is dat GEEN oude kopie maar een pagina
  // die de waarnemer niet herkent (zie 1b), en dan hoort ook deze toets hard te zijn.
  if (contractLeesbaar && !versieMinstens(contractVersie, BRONSTAND_VANAF)) {
    waarschuwingen.push('deze kopie van de plaat is gebouwd vóór de bronstand op de pagina kwam; die telt nog niet als afwijking');
  } else if (!bronstand.leesbaar) meld('BRONSTAND_ONLEESBAAR');
  else if (bronstand.bewezen === 0) {
    meld('GEEN_GEVERIFIEERDE_BRON', `0 van ${bronstand.totaal} bronnen`);
  }

  return { ok: bevindingen.length === 0, bevindingen, waarschuwingen, gemeten };
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
export function alarmRij({ bevindingen, nu, sabotage = false, maxOnderwerp = 560 }) {
  const codes = [...new Set(bevindingen.map((b) => b.code))];
  const zinnen = [...new Set(bevindingen.map((b) => b.uitleg))].join('; ');
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
