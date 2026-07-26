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
 * geen schakelaar die iemand kan vergeten om te zetten.
 */

import { kanaalpostUitTekst, toPublicKanaalpost, ontdaan } from './kanaalpost.mjs';

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

/** Secties die er altijd horen te staan. `kanaalpost` komt erbij vanaf `KANAALPOST_VANAF`. */
export const VERPLICHTE_SECTIES = ['overzicht', 'planning', 'prs', 'ci', 'tracker', 'tracks', 'merged', 'logbook'];

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
  SPIEGEL_ONBEREIKBAAR: 'het openbare logboek was niet op te halen',
  SPIEGEL_ONLEESBAAR: 'in het openbare logboek stond geen enkele leesbare regel',
  KANAALPOST_ONTBREEKT: 'de logboek-sectie ontbreekt op de pagina',
  KANAALPOST_ZONDER_RIJEN: 'de logboek-sectie op de pagina toont geen enkele regel terwijl de bron er wel heeft',
  PAGINA_TOONT_OUDE_DATA: 'de bovenste regel op de pagina is niet de laatste regel uit de bron',
  SECTIE_ONTBREEKT: 'een verplichte sectie ontbreekt op de pagina',
  SECTIE_LEEG: 'een sectie op de pagina is leeg zonder uitleg',
  PAGINA_KAPOT: 'op de pagina staat een lege of onberekende waarde in plaats van gegevens',
};

const UUR = 3600 * 1000;
const MIN = 60 * 1000;

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
 * `generatedAt` bevat. De machinale vorm is compleet (datum + tijd + milliseconden), de leesbare
 * niet — daarom rekent de waarnemer met de eerste en gebruikt hij de tweede als kruiscontrole.
 * Zo hangt de leeftijdstoets niet aan `status.json`, dat door de CDN uit een ándere publicatie kan
 * komen dan de pagina die ernaast wordt geserveerd.
 */
export function stempelUitHtml(html) {
  const s = String(html ?? '');
  const buster = s.match(/url=\.\/\?v=(\d{17})\b/);
  const leesbaar = s.match(/class="stamp">Laatst bijgewerkt: <strong>gebouwd om (\d{2}):(\d{2}) NL-tijd \((\d{2}):(\d{2}) UTC\)<\/strong>/);
  if (!buster && !leesbaar) return { gevonden: false, iso: null, utcHhmm: null, leesbaar: null };
  if (!buster || !leesbaar) return { gevonden: true, iso: null, utcHhmm: null, leesbaar: Boolean(leesbaar) };
  const d = buster[1];
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(8, 10)}:${d.slice(10, 12)}:${d.slice(12, 14)}.${d.slice(14, 17)}Z`;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime()) || t.toISOString() !== iso) {
    return { gevonden: true, iso: null, utcHhmm: `${leesbaar[3]}:${leesbaar[4]}`, leesbaar: true };
  }
  return { gevonden: true, iso, utcHhmm: `${leesbaar[3]}:${leesbaar[4]}`, leesbaar: true };
}

/**
 * De binnenkant van één sectie. De plaat nest geen secties (de grid-kaarten staan naast elkaar in
 * een `div`), dus het eerstvolgende sluitelement hoort bij deze sectie.
 */
export function sectieUitHtml(html, id) {
  const s = String(html ?? '');
  const start = s.indexOf(`<section id="${id}"`);
  if (start === -1) return null;
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
  const body = String(sectieHtml ?? '').match(/<tbody>([\s\S]*?)<\/table>/);
  if (!body) return null;
  const rij = body[1].match(/<tr>([\s\S]*?)<\/tr>/);
  if (!rij) return null;
  const cellen = [...rij[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => ontdaan(unesc(ZONDER_TAGS(m[1]))));
  if (cellen.length < 4) return null;
  return { tab: cellen[0], onderwerp: cellen[1], status: cellen[2], datum: cellen[3] };
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
 * De hele toetsing over binnengehaalde tekst. Geen netwerk, geen klok van zichzelf: `nu` komt van
 * buiten zodat elke uitkomst in een test exact te zetten is.
 */
export function toets({
  paginaStatus, paginaHtml, spiegelStatus, spiegelTekst,
  contractVersie = null, nu = 0,
  drempelMs = DREMPEL_UREN * UUR, graceMs = GRACE_MINUTEN * MIN,
} = {}) {
  const bevindingen = [];
  const waarschuwingen = [];
  const gemeten = { stempelIso: null, leeftijdMs: null, paginaRij: null, bronRij: null, contract: contractVersie };
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
  const stempel = stempelUitHtml(html);
  if (!stempel.gevonden) meld('STEMPEL_ONTBREEKT');
  else if (!stempel.iso) meld('STEMPEL_ONLEESBAAR');
  else {
    gemeten.stempelIso = stempel.iso;
    // 2 — leeftijd onder de drempel, óf de pagina zegt zelf dat ze verouderd is.
    if (stempel.utcHhmm && stempel.utcHhmm !== stempel.iso.slice(11, 16)) meld('STEMPEL_INCONSISTENT');
    const leeftijd = Number(nu) - Date.parse(stempel.iso);
    gemeten.leeftijdMs = leeftijd;
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
      const zelfde = (a, b) => a && b && a.tab === b.tab && a.datum === b.datum && a.onderwerp === b.onderwerp;
      const treffer = publiek.rows.slice(0, respijt + 1).some((r) => zelfde(paginaRij, r));
      if (!treffer) meld('PAGINA_TOONT_OUDE_DATA', `de pagina toont bovenaan een melding van ${paginaRij.datum || 'onbekende datum'}`);
    }
  }

  // 4 — verplichte secties aanwezig, niet leeg, niet kapot.
  const verplicht = kanaalpostVerplicht ? [...VERPLICHTE_SECTIES, 'kanaalpost'] : VERPLICHTE_SECTIES;
  for (const id of verplicht) {
    const inhoud = sectieUitHtml(html, id);
    if (inhoud === null) { meld('SECTIE_ONTBREEKT', `sectie ${id}`); continue; }
    const heeftUitleg = inhoud.includes('class="empty"');
    if (!heeftUitleg && !inhoud.includes('<tr') && ZONDER_TAGS(inhoud).length < 40) meld('SECTIE_LEEG', `sectie ${id}`);
  }
  const spoor = KAPOT_SPOREN.find((k) => html.includes(k));
  if (spoor) meld('PAGINA_KAPOT');

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
  const kop = '**De automatische controle ziet de openbare plaat afwijken van de bron.**';
  const ruimte = maxOnderwerp - kop.length - test.length - staart.length - 2;
  const kern = zinnen.length > ruimte ? `${zinnen.slice(0, Math.max(0, ruimte - 1)).trimEnd()}…` : zinnen;
  const onderwerp = `${kop} ${kern}.${test}${staart}`;
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
  return uit.available === true && uit.rows.length === 1 && uit.ingehouden === 0;
}

/**
 * Niet elke ronde opnieuw dezelfde melding. Een storing die twaalf uur duurt hoort één regel te
 * krijgen, geen vierentwintig — anders verdrinkt de spiegel in zijn eigen alarm en leest niemand
 * hem nog. Zodra de combinatie van controlepunten verandert, is het een ander bericht en mag het
 * wél meteen.
 */
export function magAppenden(spiegelTekst, codes, nu, vensterMs = HERHAAL_UREN * UUR) {
  const doel = [...new Set(codes.map(codeWoord))].sort().join(',');
  const rijen = kanaalpostUitTekst(String(spiegelTekst ?? '')).rows ?? [];
  const laatste = [...rijen].reverse().find((r) => ontdaan(r.tab) === 'WAARNEMER');
  if (!laatste) return { mag: true, reden: 'eerste melding van de waarnemer in de spiegel' };
  const eerder = String(laatste.onderwerp ?? '').match(/\(controlepunten: ([a-z0-9,\s-]+)\)/);
  const zelfde = eerder ? eerder[1].split(',').map((x) => x.trim()).filter(Boolean).sort().join(',') === doel : false;
  const moment = rijMoment(laatste.datum);
  const oud = moment === null || Number(nu) - moment > vensterMs;
  if (zelfde && !oud) return { mag: false, reden: 'dezelfde melding staat al in de spiegel binnen het herhaalvenster' };
  return { mag: true, reden: zelfde ? 'zelfde melding, maar het herhaalvenster is verstreken' : 'andere combinatie van controlepunten dan de vorige melding' };
}
