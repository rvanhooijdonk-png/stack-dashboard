/**
 * Tests voor de waarnemer. Twee soorten, bewust naast elkaar:
 *
 *  - ECHTE PAGINA: de toetsen draaien over de uitvoer van `renderHtml` zelf. Verandert de vorm van
 *    de stempel, de sectie of de tabel, dan valt de waarnemer hier om — en niet pas in productie,
 *    waar hij dan stilletjes niets meer zou vinden. Dat is het hele punt van een bewaker: hij mag
 *    niet blind kunnen worden zonder dat iemand het merkt.
 *  - LOSSE GEVALLEN: handgemaakte HTML voor de randen (kapotte stempel, lege sectie, oude rij).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderHtml } from '../scripts/lib/render.mjs';
import { kanaalpostUitTekst, toPublicKanaalpost } from '../scripts/lib/kanaalpost.mjs';
import {
  toets, alarmRij, magAppenden, alarmRijPubliceerbaar, stempelUitHtml, sectieUitHtml,
  eersteKanaalpostRij, rijMoment, versieMinstens, codeWoord, CODES, VEROUDERD_MARKER, KANAALPOST_VANAF,
  SECTIES_VANAF, zelfRouteUitUrl, statusUitTekst, VERSIE_VORM, KERN_BRONVELDEN, NEVENPUNTEN,
} from '../scripts/lib/waarnemer.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(join(ROOT, 'data/fixture.json'), 'utf8'));
/** Hetzelfde schema dat build.mjs gebruikt om status.json te keuren vóór publicatie (build.mjs:477).
 *  De waakvlam keurt de opgehaalde kopie ermee, dus producent en bewaker houden elkaar vast. */
const STATUS_SCHEMA = JSON.parse(await readFile(join(ROOT, 'contracts/status-json.schema.json'), 'utf8'));
/** De vaste bronkeys, uit het contract zelf — niet nagetypt. */
const BRONKEYS = STATUS_SCHEMA.properties.sources.items.properties.key.enum;
/** De contractversie die het schema pint — de enige die de schemakeuring aankan. */
const CONTRACT_NU = STATUS_SCHEMA.properties.contractVersion.const;

const NU = Date.parse('2026-07-26T12:00:00.000Z');

/** Een gezonde bronstand: de meting is gelukt en er staat bewijs achter de plaat. Toetsen die iets
 *  anders onderzoeken geven die mee, zodat toets 5 hun uitkomst niet vertroebelt. */
const BRONSTAND_OK = {
  leesbaar: true, reden: null, totaal: 8, bewezen: 8,
  gebouwdOp: '2026-07-26T11:55:00.000Z', getoetst: true,
};
/** De contractversie die de plaat vandaag stempelt — uit de fixture, niet nagetypt. */
const NIEUWSTE_CONTRACT = fixture.contractVersion;
const KOP = ['| datum-tijd | tab-rol | onderwerp | status | actie voor |',
  '| --- | --- | --- | --- | --- |'].join('\n');

const spiegelMet = (...rijen) => [KOP, ...rijen].join('\n');
const rij = (datum, tab, onderwerp, status = 'AFGEROND', actie = 'niemand') => `| ${datum} | ${tab} | ${onderwerp} | ${status} | ${actie} |`;

/** Een pagina zoals de plaat hem echt bouwt, met een kanaalpost uit deze spiegeltekst. */
function pagina(spiegelTekst, {
  contract = KANAALPOST_VANAF,
  generatedAt = '2026-07-26T11:55:00.000Z',
  pagePath = './',
} = {}) {
  const snap = structuredClone(fixture);
  snap.contractVersion = contract;
  snap.generatedAt = generatedAt;
  snap.kanaalpost = toPublicKanaalpost(kanaalpostUitTekst(spiegelTekst));
  return renderHtml(snap, { pagePath });
}

const basisSpiegel = spiegelMet(
  rij('2026-07-26 08:00', 'CONTROL', 'Een eerdere melding uit de vloot.'),
  rij('2026-07-26 09:00', 'DASHBOARD', 'De laatste melding die op de plaat hoort te staan.'),
);

// --- de gelukkige weg, over een echt gerenderde pagina ---

test('een verse pagina die de laatste bronregel toont, is in orde', () => {
  const html = pagina(basisSpiegel);
  const r = toets({
    paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: basisSpiegel, contractVersie: KANAALPOST_VANAF,
    bronstand: BRONSTAND_OK, nu: NU,
  });
  assert.deepEqual(r.bevindingen, []);
  assert.equal(r.ok, true);
  assert.equal(r.gemeten.stempelIso, '2026-07-26T11:55:00.000Z');
  assert.equal(r.gemeten.paginaRij.tab, 'DASHBOARD');
  assert.equal(r.gemeten.bronRij.datum, '2026-07-26 09:00');
});

test('de stempel wordt uit de echte pagina gelezen, niet uit een tweede bron', () => {
  const s = stempelUitHtml(pagina(basisSpiegel, { generatedAt: '2026-07-26T11:55:00.000Z' }));
  assert.equal(s.gevonden, true);
  assert.equal(s.iso, '2026-07-26T11:55:00.000Z');
  // 11:55 UTC is 13:55 in NL — de leesbare stempel toont die UTC-helft, en die moet kloppen.
  assert.equal(s.utcHhmm, '11:55');
});

test('de stempelparser accepteert alleen de vier vaste zelfroutes', () => {
  const contentstroom = stempelUitHtml(pagina(basisSpiegel, {
    generatedAt: '2026-07-26T11:55:00.000Z',
    pagePath: './contentstroom.html',
  }));
  assert.equal(contentstroom.iso, '2026-07-26T11:55:00.000Z',
    'de live waarnemer leest contentstroom.html, dus deze zelfroute is verplicht');

  const root = pagina(basisSpiegel, { generatedAt: '2026-07-26T11:55:00.000Z' });
  for (const route of ['./', './producten.html', './stack-ticker.html']) {
    const html = root.replace('url=./?v=', `url=${route}?v=`);
    assert.equal(stempelUitHtml(html).iso, '2026-07-26T11:55:00.000Z', route);
  }

  const onbekend = root.replace('url=./?v=', 'url=./beheer.html?v=');
  assert.equal(stempelUitHtml(onbekend).iso, null, 'een willekeurige route is geen bouwbewijs');
});

test('een bekende kruisroute is geen self-refreshbewijs voor de opgehaalde pagina', () => {
  const contentstroom = pagina(basisSpiegel, {
    generatedAt: '2026-07-26T11:55:00.000Z',
    pagePath: './contentstroom.html',
  });
  const kruisroute = contentstroom.replace('url=./contentstroom.html?v=', 'url=./?v=');

  assert.equal(stempelUitHtml(kruisroute).iso, '2026-07-26T11:55:00.000Z',
    'zonder route blijft de backwards-compatible vier-routelijst gelden');
  assert.equal(stempelUitHtml(kruisroute, { route: './contentstroom.html' }).iso, null,
    'met de opgehaalde route moet een kruis-verversing fail-closed worden geweigerd');

  const oordeel = toets({
    paginaStatus: 200,
    paginaHtml: kruisroute,
    paginaRoute: './contentstroom.html',
    spiegelStatus: 200,
    spiegelTekst: basisSpiegel,
    contractVersie: KANAALPOST_VANAF,
    nu: NU,
  });
  assert.ok(oordeel.bevindingen.some((item) => item.code === 'STEMPEL_ONLEESBAAR'));
});

test('alleen de vier publieke paginaroutes zijn uit een URL af te leiden', () => {
  assert.equal(zelfRouteUitUrl('https://example.invalid/stack-dashboard/'), './');
  assert.equal(zelfRouteUitUrl('https://example.invalid/stack-dashboard/producten.html?x=1'), './producten.html');
  assert.equal(zelfRouteUitUrl('https://example.invalid/stack-dashboard/stack-ticker.html'), './stack-ticker.html');
  assert.equal(zelfRouteUitUrl('https://example.invalid/stack-dashboard/contentstroom.html'), './contentstroom.html');
  assert.equal(zelfRouteUitUrl('https://example.invalid/stack-dashboard/beheer.html'), null);
  assert.equal(zelfRouteUitUrl('geen URL'), null);
});

// --- toets 1: bereikbaar en bestempeld ---

test('een onbereikbare pagina is één harde bevinding en verder niets', () => {
  const r = toets({ paginaStatus: 502, paginaHtml: '', spiegelStatus: 200, spiegelTekst: basisSpiegel, nu: NU });
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['PAGINA_ONBEREIKBAAR']);
});

test('een lege pagina met status 200 telt niet als geslaagd', () => {
  const r = toets({ paginaStatus: 200, paginaHtml: '   ', spiegelStatus: 200, spiegelTekst: basisSpiegel, nu: NU });
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['PAGINA_LEEG']);
});

test('een pagina zonder stempel valt op', () => {
  const html = pagina(basisSpiegel).replace(/<p class="stamp">[\s\S]*?<\/p>/, '').replace(/url=\.\/\?v=\d+/, 'url=./');
  const r = toets({ paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: basisSpiegel, contractVersie: KANAALPOST_VANAF, nu: NU });
  assert.ok(r.bevindingen.some((b) => b.code === 'STEMPEL_ONTBREEKT'));
});

test('twee tijdsvermeldingen die elkaar tegenspreken is een bevinding', () => {
  // Let op de precieze vervanging: de UTC-tijd staat óók in de tabtitel, en die eerste treffer is
  // niet de stempel. Alleen de kop-stempel verzetten, anders toetst deze test niets.
  const html = pagina(basisSpiegel).replace('gebouwd om 13:55 NL-tijd (11:55 UTC)', 'gebouwd om 13:55 NL-tijd (09:12 UTC)');
  const r = toets({ paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: basisSpiegel, contractVersie: KANAALPOST_VANAF, nu: NU });
  assert.ok(r.bevindingen.some((b) => b.code === 'STEMPEL_INCONSISTENT'));
});

test('een onmogelijke datum in de machinale stempel telt als onleesbaar, niet als geldig', () => {
  const s = stempelUitHtml('<meta http-equiv="refresh" content="900; url=./?v=20260231259999999">'
    + '<p class="stamp">Laatst bijgewerkt: <strong>gebouwd om 02:59 NL-tijd (25:99 UTC)</strong></p>');
  assert.equal(s.gevonden, true);
  assert.equal(s.iso, null);
});

// --- toets 2: leeftijd onder de drempel, óf eerlijk verouderd ---

test('een pagina boven de drempel is rood', () => {
  const html = pagina(basisSpiegel, { generatedAt: '2026-07-25T12:00:00.000Z' });
  const r = toets({
    paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: basisSpiegel, contractVersie: KANAALPOST_VANAF, nu: NU,
  });
  const bev = r.bevindingen.find((b) => b.code === 'STEMPEL_TE_OUD');
  assert.ok(bev, 'oude stempel moet een bevinding geven');
  assert.match(bev.uitleg, /leeftijd ongeveer 24 uur/);
});

test('een pagina die zelf eerlijk zegt dat ze verouderd is, mag oud zijn', () => {
  const html = pagina(basisSpiegel, { generatedAt: '2026-07-25T12:00:00.000Z' })
    .replace('<body>', `<body ${VEROUDERD_MARKER}>`);
  const r = toets({
    paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: basisSpiegel, contractVersie: KANAALPOST_VANAF, nu: NU,
  });
  assert.equal(r.bevindingen.some((b) => b.code === 'STEMPEL_TE_OUD'), false);
});

test('de drempel is instelbaar en de sabotage (drempel nul) maakt élke pagina te oud', () => {
  const html = pagina(basisSpiegel);
  const r = toets({
    paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: basisSpiegel, contractVersie: KANAALPOST_VANAF, nu: NU, drempelMs: 0,
  });
  const bev = r.bevindingen.find((b) => b.code === 'STEMPEL_TE_OUD');
  assert.ok(bev);
  assert.match(bev.uitleg, /leeftijd ongeveer 5 minuten/);
});

// --- toets 3: de plaat toont de laatste bronregel ---

test('een nieuwe bronregel die ouder is dan het respijt en niet op de plaat staat, is een afwijking', () => {
  const html = pagina(basisSpiegel);
  const nieuwer = `${basisSpiegel}\n${rij('2026-07-26 10:00', 'CONTROL', 'Deze melding is de plaat nooit gehaald.')}`;
  const r = toets({
    paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: nieuwer, contractVersie: KANAALPOST_VANAF, nu: NU,
  });
  const bev = r.bevindingen.find((b) => b.code === 'PAGINA_TOONT_OUDE_DATA');
  assert.ok(bev, 'een gemiste bronregel moet zichtbaar worden');
  assert.match(bev.uitleg, /2026-07-26 09:00/);
});

test('binnen het respijt mag de plaat achterlopen — bouwen en cache kosten tijd', () => {
  const html = pagina(basisSpiegel);
  const netBinnen = `${basisSpiegel}\n${rij('2026-07-26 11:50', 'CONTROL', 'Deze regel is nog geen tien minuten oud.')}`;
  const r = toets({
    paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: netBinnen, contractVersie: KANAALPOST_VANAF, nu: NU,
  });
  assert.equal(r.bevindingen.some((b) => b.code === 'PAGINA_TOONT_OUDE_DATA'), false);
});

test('respijt geldt alleen voor de verse rijen: daarachter blijft de eis staan', () => {
  // Eén verse rij (binnen respijt) én één oude gemiste rij. De plaat mag de verse missen, de oude niet.
  const html = pagina(basisSpiegel);
  const tekst = `${basisSpiegel}\n${rij('2026-07-26 10:00', 'CONTROL', 'Oude gemiste melding.')}\n${rij('2026-07-26 11:55', 'CONTROL', 'Verse melding.')}`;
  const r = toets({
    paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: tekst, contractVersie: KANAALPOST_VANAF, nu: NU,
  });
  assert.ok(r.bevindingen.some((b) => b.code === 'PAGINA_TOONT_OUDE_DATA'));
});

test('een onbereikbaar logboek is een bevinding, geen stilte', () => {
  const r = toets({
    paginaStatus: 200, paginaHtml: pagina(basisSpiegel), spiegelStatus: 404, spiegelTekst: '', contractVersie: KANAALPOST_VANAF, nu: NU,
  });
  assert.ok(r.bevindingen.some((b) => b.code === 'SPIEGEL_ONBEREIKBAAR'));
});

test('een logboek zonder herkende regels is een bevinding — mogelijk is het formaat gewijzigd', () => {
  const r = toets({
    paginaStatus: 200, paginaHtml: pagina(basisSpiegel), spiegelStatus: 200, spiegelTekst: '# alleen proza, geen tabel', contractVersie: KANAALPOST_VANAF, nu: NU,
  });
  assert.ok(r.bevindingen.some((b) => b.code === 'SPIEGEL_ONLEESBAAR'));
});

// --- zelf-bewapening op de contractversie ---

test('onder de armeringsversie is een ontbrekende logboek-sectie een waarschuwing, geen fout', () => {
  const html = pagina(basisSpiegel, { contract: '2.3.0' }).replace(/<section id="kanaalpost"[\s\S]*?<\/section>/, '');
  const r = toets({
    paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: basisSpiegel, contractVersie: '2.3.0', nu: NU,
  });
  assert.equal(r.bevindingen.some((b) => b.code === 'KANAALPOST_ONTBREEKT'), false);
  assert.equal(r.waarschuwingen.filter((w) => w.includes('logboek-sectie')).length, 1);
});

test('vanaf de armeringsversie is dezelfde ontbrekende sectie hard rood', () => {
  const html = pagina(basisSpiegel).replace(/<section id="kanaalpost"[\s\S]*?<\/section>/, '');
  const r = toets({
    paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: basisSpiegel, contractVersie: KANAALPOST_VANAF, nu: NU,
  });
  assert.ok(r.bevindingen.some((b) => b.code === 'KANAALPOST_ONTBREEKT'));
});

test('een onleesbare contractversie armeert niet, maar dooft ook niets anders', () => {
  assert.equal(versieMinstens(null, '2.4.0'), false);
  assert.equal(versieMinstens('2.4', '2.4.0'), false);
  assert.equal(versieMinstens('2.4.0', '2.4.0'), true);
  assert.equal(versieMinstens('2.10.0', '2.4.0'), true);
  assert.equal(versieMinstens('2.3.9', '2.4.0'), false);
  assert.equal(versieMinstens('3.0.0', '2.4.0'), true);
});

// --- toets 4: verplichte secties, leeg en kapot ---

test('een ontbrekende verplichte sectie wordt gemeld met naam', () => {
  const html = pagina(basisSpiegel).replace(/<section id="tracks"[\s\S]*?<\/section>/, '');
  const r = toets({
    paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: basisSpiegel, contractVersie: KANAALPOST_VANAF, nu: NU,
  });
  const bev = r.bevindingen.find((b) => b.code === 'SECTIE_ONTBREEKT');
  assert.ok(bev);
  assert.match(bev.uitleg, /sectie tracks/);
});

test('een sectie zonder inhoud én zonder uitleg is kapot; met uitleg is hij eerlijk leeg', () => {
  const kaal = '<section id="ci" class="card"><h2>CI</h2></section>';
  const eerlijk = '<section id="ci" class="card"><h2>CI</h2><p class="empty">Bron onbereikbaar.</p></section>';
  const bouw = (sectie) => pagina(basisSpiegel).replace(/<section id="ci"[\s\S]*?<\/section>/, sectie);
  const leeg = toets({
    paginaStatus: 200, paginaHtml: bouw(kaal), spiegelStatus: 200, spiegelTekst: basisSpiegel, contractVersie: KANAALPOST_VANAF, nu: NU,
  });
  assert.ok(leeg.bevindingen.some((b) => b.code === 'SECTIE_LEEG'));
  const uitleg = toets({
    paginaStatus: 200, paginaHtml: bouw(eerlijk), spiegelStatus: 200, spiegelTekst: basisSpiegel, contractVersie: KANAALPOST_VANAF, nu: NU,
  });
  assert.equal(uitleg.bevindingen.some((b) => b.code === 'SECTIE_LEEG'), false);
});

test('een onberekende waarde op de pagina is een afwijking', () => {
  const html = pagina(basisSpiegel).replace('</footer>', '<span>undefined</span></footer>');
  const r = toets({
    paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: basisSpiegel, contractVersie: KANAALPOST_VANAF, nu: NU,
  });
  assert.ok(r.bevindingen.some((b) => b.code === 'PAGINA_KAPOT'));
});

// --- toets 4: de lijst dekt de plaat zoals die vandaag gebouwd wordt ---

/** Haalt één sectie uit de gerenderde pagina weg, zoals een renderfout dat zou doen. */
const zonderSectie = (html, id) => html.replace(new RegExp(`<section id="${id}"[\\s\\S]*?</section>`), '');

test('de verplichte-sectielijst eist niets wat de plaat op de huidige contractversie niet bouwt', () => {
  // De belangrijkste toets van deze ronde en bewust twee kanten op: een lijst die te weinig eist maakt
  // de waarnemer blind, een lijst die te veel eist maakt hem permanent rood. Een volledig gerenderde
  // pagina op de nieuwste contractversie moet dus zonder één bevinding door alle vier de toetsen.
  for (const [id, vanaf] of Object.entries(SECTIES_VANAF)) {
    assert.ok(versieMinstens(NIEUWSTE_CONTRACT, vanaf), `poort ${id} (${vanaf}) ligt boven contract ${NIEUWSTE_CONTRACT}`);
  }
  const html = pagina(basisSpiegel, { contract: NIEUWSTE_CONTRACT });
  const r = toets({
    paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: basisSpiegel, contractVersie: NIEUWSTE_CONTRACT,
    bronstand: BRONSTAND_OK, nu: NU,
  });
  assert.deepEqual(r.bevindingen, []);
});

test('een weggevallen besluitenregister wordt gemeld — die sectie staat er sinds 2.0.0 altijd', () => {
  const html = zonderSectie(pagina(basisSpiegel), 'decisions');
  const r = toets({
    paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: basisSpiegel, contractVersie: KANAALPOST_VANAF, nu: NU,
  });
  const bev = r.bevindingen.find((b) => b.code === 'SECTIE_ONTBREEKT');
  assert.ok(bev);
  assert.match(bev.uitleg, /sectie decisions/);
});

test('vlootstand is verplicht vanaf 2.5.0 en daarvóór niet — de toets wapent zichzelf', () => {
  const bouw = (contract) => zonderSectie(pagina(basisSpiegel, { contract }), 'vlootstand');
  const meld = (contract) => toets({
    paginaStatus: 200, paginaHtml: bouw(contract), spiegelStatus: 200, spiegelTekst: basisSpiegel, contractVersie: contract, nu: NU,
  }).bevindingen.filter((b) => b.code === 'SECTIE_ONTBREEKT');
  assert.equal(meld('2.4.0').length, 0);
  assert.match(meld(SECTIES_VANAF.vlootstand)[0].uitleg, /sectie vlootstand/);
});

test('de gedeelde-weergave-kop is verplicht vanaf 2.6.0, niet vanaf 2.5.0 waarin hij ontstond', () => {
  // Hij landde in #51 mídden in 2.5.0, zonder eigen versiebump. Een 2.5.0-pagina kan hem dus wél of
  // niet hebben; 2.6.0 is de eerste versie waarin zijn aanwezigheid vaststaat. De waarnemer eist niet
  // meer dan de versie belooft.
  const bouw = (contract) => zonderSectie(pagina(basisSpiegel, { contract }), 'gedeelde-weergave');
  const meld = (contract) => toets({
    paginaStatus: 200, paginaHtml: bouw(contract), spiegelStatus: 200, spiegelTekst: basisSpiegel, contractVersie: contract, nu: NU,
  }).bevindingen.filter((b) => b.code === 'SECTIE_ONTBREEKT');
  assert.equal(meld('2.5.0').length, 0);
  assert.match(meld(SECTIES_VANAF['gedeelde-weergave'])[0].uitleg, /sectie gedeelde-weergave/);
});

test('de roadmap-sectie is bewust niet verplicht: zonder workstreams hoort ze er niet te staan', () => {
  // `workstreams()` geeft een lege string terug bij een lege lijst — die sectie is voorwaardelijk en
  // hoort daarom niet in de lijst. Stond ze er wél in, dan was elke roadmaploze bouw vals rood.
  const snap = structuredClone(fixture);
  snap.contractVersion = NIEUWSTE_CONTRACT;
  snap.generatedAt = '2026-07-26T11:55:00.000Z';
  snap.kanaalpost = toPublicKanaalpost(kanaalpostUitTekst(basisSpiegel));
  snap.workstreams = [];
  const html = renderHtml(snap);
  assert.equal(sectieUitHtml(html, 'roadmap'), null);
  const r = toets({
    paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: basisSpiegel, contractVersie: NIEUWSTE_CONTRACT,
    bronstand: BRONSTAND_OK, nu: NU,
  });
  assert.deepEqual(r.bevindingen, []);
});

// --- leeshulpjes ---

test('de sectie-uitsnede pakt precies één sectie', () => {
  const s = sectieUitHtml('<section id="a">A</section><section id="b">B</section>', 'a');
  assert.match(s, /A$/);
  assert.equal(sectieUitHtml('<section id="a">A</section>', 'zz'), null);
});

test('de bovenste tabelrij wordt terugvertaald naar bronvelden, inclusief ontsnapte tekens', () => {
  const html = pagina(spiegelMet(rij('2026-07-26 09:00', 'CONTROL', 'Tekst met <haken> & een "citaat".')));
  const r = eersteKanaalpostRij(sectieUitHtml(html, 'kanaalpost'));
  assert.equal(r.tab, 'CONTROL');
  assert.equal(r.onderwerp, 'Tekst met <haken> & een "citaat".');
  assert.equal(r.datum, '2026-07-26 09:00');
});

test('een rijmoment zonder tijd valt terug op middernacht; onzin geeft niets', () => {
  assert.equal(rijMoment('2026-07-26 09:00'), Date.parse('2026-07-26T09:00:00Z'));
  assert.equal(rijMoment('2026-07-26'), Date.parse('2026-07-26T00:00:00Z'));
  assert.equal(rijMoment('gisteren'), null);
});

// --- de alarmregel ---

test('de alarmregel komt zelf door de publicatiepoort', () => {
  const r = alarmRij({
    bevindingen: [{ code: 'STEMPEL_TE_OUD', uitleg: 'de pagina is ouder dan de afgesproken drempel en zegt dat zelf niet' }],
    nu: NU,
  });
  const uit = toPublicKanaalpost(kanaalpostUitTekst(spiegelMet(r)));
  assert.equal(uit.available, true);
  assert.equal(uit.ingehouden, 0);
  assert.equal(uit.rows.length, 1);
  assert.equal(uit.rows[0].tab, 'WAARNEMER');
  assert.equal(uit.rows[0].status, 'GEBLOKKEERD');
  // NU is 12:00 UTC = 14:00 NL: de spiegel schrijft in Richards tijd, net als elk ander venster.
  assert.equal(uit.rows[0].datum, '2026-07-26 14:00');
});

test('de alarmregel noemt de controlepunten en blijft binnen de publicatiegrens', () => {
  const bevindingen = Array.from({ length: 12 }, (_, i) => ({
    code: 'SECTIE_LEEG', uitleg: `een sectie op de pagina is leeg zonder uitleg en dat is de zoveelste keer dat dit gebeurt in deze ronde, nummer ${i}`,
  }));
  const r = alarmRij({ bevindingen, nu: NU });
  assert.match(r, /\(controlepunten: sectie-leeg\)/);
  // Drie punten en niet het teken `…`: de spiegel eist op de schrijfkant één canonieke vorm, en `…`
  // is niet zijn eigen NFKC-vorm (besluit Fable 26-07-2026, punt 3). De waarnemer krijgt daar geen
  // uitzondering op — zie `test/spiegelwet.test.mjs` voor de eis zelf.
  assert.match(r, /\.\.\./, 'te lange tekst hoort zichtbaar afgekapt te zijn');
  assert.equal(r.includes('…'), false);
  assert.equal(alarmRijPubliceerbaar(r), true);
});

test('élke code levert een regel op die door de publicatiepoort komt — ook alle codes tegelijk', () => {
  const codes = Object.keys(CODES);
  for (const code of codes) {
    assert.equal(alarmRijPubliceerbaar(alarmRij({ bevindingen: [{ code, uitleg: CODES[code] }], nu: NU })), true, code);
  }
  const alles = codes.map((code) => ({ code, uitleg: CODES[code] }));
  assert.equal(alarmRijPubliceerbaar(alarmRij({ bevindingen: alles, nu: NU })), true);
});

test('een alarmregel die de poort NIET haalt, wordt als zodanig herkend — fail-closed, geen stille rij', () => {
  // Dit is geen theorie: een bevindingstekst met een lange, tekenloze brok haalt de entropiepoort
  // niet, en dan hoort er niets in de spiegel te komen (de run blijft rood). Gemeten gedrag, niet
  // aangenomen — daarom staat het hier als test en niet als opmerking.
  const vies = alarmRij({ bevindingen: [{ code: 'SECTIE_LEEG', uitleg: `rare brok ${'x'.repeat(80)}` }], nu: NU });
  assert.equal(alarmRijPubliceerbaar(vies), false);
});

test('een sabotagetest zegt in de spiegel zelf dat hij een test is', () => {
  const r = alarmRij({ bevindingen: [{ code: 'STEMPEL_TE_OUD', uitleg: 'te oud' }], nu: NU, sabotage: true });
  assert.match(r, /geplande sabotagetest/);
});

test('codewoorden zijn leesbaar en weer terug te lezen', () => {
  assert.equal(codeWoord('PAGINA_TOONT_OUDE_DATA'), 'pagina-toont-oude-data');
});

// --- herhaling ---

test('dezelfde melding wordt binnen het herhaalvenster niet nog eens in de spiegel gezet', () => {
  const eerder = alarmRij({ bevindingen: [{ code: 'STEMPEL_TE_OUD', uitleg: 'te oud' }], nu: NU - 3600 * 1000 });
  const m = magAppenden(spiegelMet(eerder), ['STEMPEL_TE_OUD'], NU);
  assert.equal(m.mag, false);
});

test('een andere combinatie van controlepunten mag meteen wél', () => {
  const eerder = alarmRij({ bevindingen: [{ code: 'STEMPEL_TE_OUD', uitleg: 'te oud' }], nu: NU - 3600 * 1000 });
  const m = magAppenden(spiegelMet(eerder), ['STEMPEL_TE_OUD', 'SECTIE_LEEG'], NU);
  assert.equal(m.mag, true);
});

test('na het herhaalvenster mag dezelfde melding opnieuw', () => {
  const eerder = alarmRij({ bevindingen: [{ code: 'STEMPEL_TE_OUD', uitleg: 'te oud' }], nu: NU - 20 * 3600 * 1000 });
  const m = magAppenden(spiegelMet(eerder), ['STEMPEL_TE_OUD'], NU);
  assert.equal(m.mag, true);
});

test('zonder eerdere waarnemer-regel mag de eerste melding altijd', () => {
  assert.equal(magAppenden(basisSpiegel, ['STEMPEL_TE_OUD'], NU).mag, true);
});

// --- aanscherpingen na de dubbele review (Codex + Gemini) ---
// Elk van deze tests staat voor één manier waarop de waarnemer groen kón blijven terwijl er iets
// mis was. Ze horen bij elkaar: een bewaker die te bedriegen is, is geen bewaker.

test('een bouwstempel in de toekomst is geen "verse" pagina', () => {
  const html = pagina(basisSpiegel, { generatedAt: '2099-01-01T00:00:00.000Z' });
  const r = toets({
    paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: basisSpiegel, contractVersie: KANAALPOST_VANAF, nu: NU,
  });
  assert.ok(r.bevindingen.some((b) => b.code === 'STEMPEL_IN_TOEKOMST'));
});

test('de zichtbare NL-tijd wordt óók tegen de stempel gehouden, niet alleen de UTC-tijd', () => {
  const html = pagina(basisSpiegel).replace('gebouwd om 13:55 NL-tijd', 'gebouwd om 00:00 NL-tijd');
  const r = toets({
    paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: basisSpiegel, contractVersie: KANAALPOST_VANAF, nu: NU,
  });
  assert.ok(r.bevindingen.some((b) => b.code === 'STEMPEL_INCONSISTENT'));
});

test('inhoud van de plaat kan de machinale stempel niet namaken', () => {
  // Een kanaalpost-regel die letterlijk de cache-buster-vorm bevat, terwijl de echte stempel in de
  // kop weg is: dat mag nooit als "stempel gevonden" tellen.
  const vals = spiegelMet(rij('2026-07-26 09:00', 'CONTROL', 'letterlijke url=./?v=20260726115500000 in de tekst'));
  const html = pagina(vals).replace(/<meta http-equiv="refresh"[^>]*>/, '');
  const s = stempelUitHtml(html);
  assert.equal(s.iso, null);
  const r = toets({ paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: vals, contractVersie: KANAALPOST_VANAF, nu: NU });
  assert.ok(r.bevindingen.some((b) => b.code === 'STEMPEL_ONLEESBAAR'));
});

test('een sectie vinden hangt niet aan de volgorde van de attributen', () => {
  const html = '<section class="card" id="ci"><h2>CI</h2><p>inhoud die er toe doet</p></section>';
  assert.match(sectieUitHtml(html, 'ci') ?? '', /inhoud die er toe doet/);
});

test('een lege markering telt niet als eerlijke uitleg', () => {
  const kaal = '<section id="ci" class="card"><h2>CI</h2><p class="empty"></p></section>';
  const html = pagina(basisSpiegel).replace(/<section id="ci"[\s\S]*?<\/section>/, kaal);
  const r = toets({ paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: basisSpiegel, contractVersie: KANAALPOST_VANAF, nu: NU });
  assert.ok(r.bevindingen.some((b) => b.code === 'SECTIE_LEEG'));
});

test('een tabel met alleen lege cellen telt niet als inhoud', () => {
  assert.equal(eersteKanaalpostRij('<table><tbody><tr><td></td><td></td><td></td><td></td></tr></tbody></table>'), null);
});

test('een verkeerde status op de pagina is een afwijking, ook bij dezelfde tekst', () => {
  const html = pagina(basisSpiegel).replace('AFGEROND', 'GEBLOKKEERD');
  const r = toets({ paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: basisSpiegel, contractVersie: KANAALPOST_VANAF, nu: NU });
  assert.ok(r.bevindingen.some((b) => b.code === 'PAGINA_TOONT_OUDE_DATA'));
});

test('twee storingen die elkaar afwisselen schrijven de spiegel niet vol', () => {
  // Zonder deze regel zou A de melding van B "nieuw" maken en B die van A, eindeloos heen en weer.
  const a = alarmRij({ bevindingen: [{ code: 'STEMPEL_TE_OUD', uitleg: 'te oud' }], nu: NU - 2 * 3600 * 1000 });
  const b = alarmRij({ bevindingen: [{ code: 'PAGINA_ONBEREIKBAAR', uitleg: 'niet op te halen' }], nu: NU - 3600 * 1000 });
  assert.equal(magAppenden(spiegelMet(a, b), ['STEMPEL_TE_OUD'], NU).mag, false);
});

test('een verzonnen waarnemer-regel uit de verre toekomst legt de waarnemer niet stil', () => {
  const ver = alarmRij({ bevindingen: [{ code: 'STEMPEL_TE_OUD', uitleg: 'te oud' }], nu: Date.parse('2099-01-01T00:00:00Z') });
  assert.equal(magAppenden(spiegelMet(ver), ['STEMPEL_TE_OUD'], NU).mag, true);
});


// --- toets 5: rust de plaat nog op een bewezen bron? ---
//
// De meting komt NIET uit de opmaak van de pagina maar uit `status.json`, het machineleesbare
// bestand dat de build naast de pagina publiceert en dat een eigen schema heeft. Vier reviewrondes
// lang stond de meting in een `<meta>` in de kop en vier keer vond de review daar hetzelfde soort
// gat: een zelfgeschreven scanner is geen HTML5-parser (`<noscript>`, een `<div>` dat de kop
// impliciet sluit, `<!doctype html <meta>>`, karakterverwijzingen). Een echte parser meenemen kan
// niet — de waakvlam draait zonder installatiestap. JSON.parse kent die dubbelzinnigheid niet.

/** Precies zoals `build.mjs` `status.json` samenstelt: vier velden uit hetzelfde snapshot. */
function statusTekstVan(sources, contract = CONTRACT_NU, gebouwdOp = '2026-07-26T11:55:00.000Z') {
  return JSON.stringify({
    contractVersion: contract,
    generatedAt: gebouwdOp,
    overallStatus: 'OK',
    sources,
  }, null, 2);
}

/** Lezen zoals de executor het doet: mét het schema uit de repo. */
const lees = (httpStatus, tekst) => statusUitTekst(httpStatus, tekst, STATUS_SCHEMA);

/** De vorm van 22-08-2026: acht bronnen gelezen, geen enkele bewezen. */
const BRONNEN_LEEG = BRONKEYS.map((key, i) => ({
  key,
  retrievedAt: '2026-07-26T11:50:00.000Z',
  trust: i === 0 ? 'UNVERIFIED' : 'SOURCE_UNAVAILABLE',
  rijen: null,
}));
const ALLES_BEWEZEN = BRONNEN_LEEG.map((b) => ({ ...b, trust: 'VERIFIED_CURRENT' }));

/** Dezelfde plaat als `pagina()`, maar met een bronnenlijst en contractversie die de test bepaalt. */
function paginaMetBronnen(sources, {
  contract = CONTRACT_NU, spiegelTekst = basisSpiegel, gebouwdOp = '2026-07-26T11:55:00.000Z',
} = {}) {
  const snap = structuredClone(fixture);
  snap.contractVersion = contract;
  snap.generatedAt = gebouwdOp;
  snap.kanaalpost = toPublicKanaalpost(kanaalpostUitTekst(spiegelTekst));
  snap.sources = sources;
  return renderHtml(snap, {});
}

/**
 * De executor-route, in één stuk: het opgehaalde statusbestand wordt gelezen zoals productie het
 * leest, en wat daaruit komt gaat als gemeten feit de toets in. Zo kan de test niet groen blijven
 * op een leesroute die productie helemaal niet gebruikt.
 */
function toetsMetStatus(sources, {
  contract = CONTRACT_NU, httpStatus = 200, tekst = null,
  paginaContract = contract, paginaGebouwdOp = '2026-07-26T11:55:00.000Z',
} = {}) {
  const gelezen = lees(httpStatus, tekst ?? statusTekstVan(sources, contract));
  return toets({
    paginaStatus: 200,
    paginaHtml: paginaMetBronnen(sources, { contract: paginaContract, gebouwdOp: paginaGebouwdOp }),
    spiegelStatus: 200,
    spiegelTekst: basisSpiegel,
    // De contractversie komt van de PAGINA, precies zoals `scripts/waarnemer.mjs` hem uit de
    // voettekst leest. Stond hier eerst `gelezen.contract` — dat was de bug van Codex ronde 6:
    // het statusbestand bepaalde dan mede zijn eigen beoordeling.
    contractVersie: paginaContract,
    bronstand: gelezen.bronnen,
    // Ook de versie die het STATUSBESTAND van zichzelf beweert gaat mee. Eén bouw kan er maar één
    // hebben; twee verschillende betekent dat er één verzonnen is (bevinding Codex, ronde 9).
    bronContractVersie: gelezen.contract,
    nu: NU,
  });
}

test('een verse, complete plaat waar geen enkele bron achter bewezen is, is een afwijking', () => {
  // Precies het incident van 22-08-2026: de pagina stond er, was vers en compleet, en de waakvlam
  // draaide in diezelfde periode 81 keer groen — omdat niemand naar de bronnen keek.
  const r = toetsMetStatus(BRONNEN_LEEG);
  assert.equal(r.ok, false);
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['GEEN_GEVERIFIEERDE_BRON']);
  assert.match(r.bevindingen[0].uitleg, /0 van 8/);
  assert.deepEqual(r.gemeten.bronnen, {
    leesbaar: true, reden: null, totaal: 8, bewezen: 0, ongeteld: 0,
    gebouwdOp: '2026-07-26T11:55:00.000Z', getoetst: true,
  });
});

test('NEGATIEVE CONTROLE — precies die plaat komt door toets 1 t/m 4 heen', () => {
  // Zonder deze controle bewijst de test hierboven niets: dan zou de plaat om een héél andere
  // reden rood kunnen zijn en zou toets 5 nog steeds kunnen ontbreken.
  const r = toets({
    paginaStatus: 200,
    paginaHtml: paginaMetBronnen(BRONNEN_LEEG),
    spiegelStatus: 200,
    spiegelTekst: basisSpiegel,
    contractVersie: CONTRACT_NU,
    bronstand: { ...BRONSTAND_OK, totaal: 8, bewezen: 1 },
    nu: NU,
  });
  assert.deepEqual(r.bevindingen, [], 'de plaat zelf is volgens toets 1 t/m 4 in orde');
});

test('één bewezen bron is genoeg om niet te alarmeren', () => {
  const bijna = BRONNEN_LEEG.map((b, i) => (i === 3 ? { ...b, trust: 'VERIFIED_CURRENT' } : b));
  assert.deepEqual(toetsMetStatus(bijna).bevindingen, []);
});

test('alleen VERIFIED_CURRENT telt als bewijs — STALE is dat niet', () => {
  const verlopen = BRONNEN_LEEG.map((b) => ({ ...b, trust: 'STALE' }));
  assert.deepEqual(toetsMetStatus(verlopen).bevindingen.map((b) => b.code), ['GEEN_GEVERIFIEERDE_BRON']);
});

test('een plaat zonder ENKELE gelezen bron is een afwijking, geen "alles in orde"', () => {
  // Nul van nul is geen bewijs van gezondheid maar het ontbreken van elk bewijs.
  assert.deepEqual(toetsMetStatus([]).bevindingen.map((b) => b.code), ['GEEN_GEVERIFIEERDE_BRON']);
});

// --- het statusbestand zelf: gelezen met een parser, gekeurd met zijn eigen contract ---

test('de meting komt uit hetzelfde statusbestand dat build.mjs publiceert', () => {
  // Bindend: verandert de vorm van status.json, dan valt deze test om en niet de productie.
  const gelezen = lees(200, statusTekstVan(ALLES_BEWEZEN));
  assert.equal(gelezen.contract, CONTRACT_NU);
  assert.deepEqual(gelezen.bronnen, {
    leesbaar: true, reden: null, totaal: 8, bewezen: 8, ongeteld: 0,
    gebouwdOp: '2026-07-26T11:55:00.000Z', getoetst: true,
  });
});

test('een statusbestand dat er niet is, is geen "geen bronnen" maar onleesbaar', () => {
  for (const http of [0, 404, 500]) {
    const gelezen = lees(http, '');
    assert.equal(gelezen.contract, null);
    assert.equal(gelezen.bronnen.leesbaar, false);
    assert.match(gelezen.bronnen.reden, new RegExp(`http ${http}`));
  }
});

test('onleesbare inhoud van het statusbestand is een afwijking, geen stilte', () => {
  for (const tekst of ['', 'geen json', '[]', 'null', '"tekst"', '{"sources": "geen lijst"}']) {
    const gelezen = lees(200, tekst);
    assert.equal(gelezen.bronnen.leesbaar, false, `${tekst} hoort onleesbaar te zijn`);
  }
  // Alleen de bronstand valt om; de pagina zelf is in orde en draagt haar eigen contractvoettekst.
  // Vóór ronde 6 stond hier ook `CONTRACT_ONLEESBAAR` — dát was het teken dat de versie van de
  // pagina in werkelijkheid uit het statusbestand kwam.
  const r = toetsMetStatus(ALLES_BEWEZEN, { tekst: 'geen json' });
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['BRONSTAND_ONLEESBAAR']);
});

// --- Codex ronde 5, P1 #2: JSON.parse keurt niets ---

test('het statusbestand wordt tegen zijn EIGEN schema gehouden, niet alleen tegen JSON.parse', () => {
  // Zonder schemakeuring telde de waakvlam elk object met een `trust`-veld mee. Een bestand met een
  // verzonnen bronkey, een verzonnen trust-waarde of zonder de verplichte velden ging dan door voor
  // een geldige meting — en juist die vorm is wat een halve build oplevert.
  // Beweert het bestand ONZE contractversie, dan is ons schema er het gezag over en geldt het volle
  // contract — `additionalProperties: false` incluis. Vals alarm kan hier niet: het bestand zegt
  // zelf dat het deze versie is.
  const gevallen = [
    [[{ ...ALLES_BEWEZEN[0], key: 'verzonnen-bron' }], 'een bronkey die niet in het contract staat'],
    [[{ ...ALLES_BEWEZEN[0], trust: 'PRIMA' }], 'een trust-waarde die niet in het contract staat'],
    [[{ key: BRONKEYS[0], trust: 'VERIFIED_CURRENT' }], 'een bron zonder retrievedAt en rijen'],
    [[{ ...ALLES_BEWEZEN[0], extra: 'iets' }], 'een bron met een veld dat het contract niet kent'],
  ];
  for (const [sources, waarom] of gevallen) {
    const gelezen = lees(200, statusTekstVan(sources));
    assert.equal(gelezen.bronnen.leesbaar, false, `${waarom} hoort onleesbaar te zijn`);
    assert.match(gelezen.bronnen.reden, /volgt zijn eigen contract niet/);
    assert.equal(gelezen.bronnen.getoetst, true, `${waarom} is wél gekeurd — hij viel er alleen op`);
  }
});

test('NEGATIEVE CONTROLE — precies dezelfde vorm mét geldige velden komt er wél door', () => {
  const gelezen = lees(200, statusTekstVan([ALLES_BEWEZEN[0]]));
  assert.equal(gelezen.bronnen.leesbaar, true);
  assert.deepEqual([gelezen.bronnen.totaal, gelezen.bronnen.bewezen], [1, 1]);
});

test('zonder schema keurt de waakvlam niets en zegt dat ook', () => {
  // Faalt het lezen van het contractbestand, dan is het antwoord "ik weet het niet" — geen groen.
  const gelezen = statusUitTekst(200, statusTekstVan(ALLES_BEWEZEN), null);
  assert.equal(gelezen.bronnen.leesbaar, false);
  assert.match(gelezen.bronnen.reden, /geen schema/);
});

test('een kopie met een andere contractversie wordt niet gekeurd, maar wél beoordeeld', () => {
  // Het schema pint `contractVersion` op één waarde. Een oudere of nieuwere gepubliceerde kopie zou
  // er per definitie op vallen; die heet daarom ongetoetst, niet fout. Ongetoetst was tot ronde 6
  // óók een vrijstelling van de telling — en die voorwaarde las het statusbestand uit zichzelf.
  // Nu is het alleen nog een waarschuwing over de VORM; het AANTAL wordt gewoon geveld.
  const gelezen = lees(200, statusTekstVan(BRONNEN_LEEG, '9.9.9'));
  assert.equal(gelezen.bronnen.leesbaar, true);
  assert.equal(gelezen.bronnen.getoetst, false);
  const r = toetsMetStatus(BRONNEN_LEEG, { contract: '9.9.9', paginaContract: '9.9.9' });
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['GEEN_GEVERIFIEERDE_BRON']);
  assert.match(r.waarschuwingen.join(' '), /de telling wordt wél beoordeeld/);
});

// --- Codex ronde 5, P1 #1: het statusbestand moet bij DEZE pagina horen ---

test('een statusbestand uit een andere bouw levert geen oordeel en geen vrijstelling', () => {
  // De reproductie van Codex: een verse 2.7.0-pagina met nul bewezen bronnen naast een apart
  // opgehaald status.json met contractVersion 2.6.0 gaf letterlijk ok:true. Dat oude bestand
  // leverde zowel de telling als de versie waarmee die telling zichzelf vrijstelde.
  // Sinds ronde 6 staat de pagina hier op 09:00 in plaats van 11:55: het respijt kijkt naar hoe
  // vers de NIEUWSTE bouw is, dus met een pagina van vijf minuten oud zou dit terecht naijling
  // heten. Buiten het respijt blijft het wat het was: een oordeel over een vreemd bestand.
  const r = toetsMetStatus(BRONNEN_LEEG, {
    contract: '2.6.0',
    paginaContract: CONTRACT_NU,
    paginaGebouwdOp: '2026-07-26T09:00:00.000Z',
    tekst: statusTekstVan(BRONNEN_LEEG, '2.6.0', '2026-07-25T11:55:00.000Z'),
  });
  assert.equal(r.ok, false, 'een vreemd statusbestand mag nooit stil groen opleveren');
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['BRONSTAND_ANDERE_BOUW']);
});

test('binnen het respijt heet een ander bouwmoment naijling van de CDN, geen defect', () => {
  // De waakvlam draait direct na `publish`; GitHub Pages/Fastly mag dan nog ongeveer tien minuten
  // een oudere kopie serveren. Een hard rood daarop zou bij bijna elke publicatie afgaan.
  const r = toetsMetStatus(ALLES_BEWEZEN, {
    tekst: statusTekstVan(ALLES_BEWEZEN, CONTRACT_NU, '2026-07-26T11:45:00.000Z'),
  });
  assert.deepEqual(r.bevindingen, []);
  assert.match(r.waarschuwingen.join(' '), /andere bouw/);
  assert.equal(r.gemeten.bouwVerschilMs, 10 * 60 * 1000);
});

test('buiten het respijt is een achterlopend statusbestand wél een afwijking', () => {
  // Beide bouwen staan stil: de pagina van 09:00, het statusbestand van 08:00, de meting om 12:00.
  // Er is dus niet zojuist gepubliceerd en het verschil is geen naijling maar een halve publicatie.
  const r = toetsMetStatus(ALLES_BEWEZEN, {
    paginaGebouwdOp: '2026-07-26T09:00:00.000Z',
    tekst: statusTekstVan(ALLES_BEWEZEN, CONTRACT_NU, '2026-07-26T08:00:00.000Z'),
  });
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['BRONSTAND_ANDERE_BOUW']);
  assert.match(r.bevindingen[0].uitleg, /buiten het respijt/);
});

// --- Codex ronde 6, P1-A: naijling is een kwestie van HOE VERS, niet van HOE VER UIT ELKAAR ---

test('een half doorgezakte publicatie is geen defect, ook als de vorige bouw uren ouder is', () => {
  // De reproductie van Codex: `publish` draait om 05:45 en 15:45, dus twee opeenvolgende bouwen
  // liggen uren uit elkaar. Wordt het nieuwe statusbestand al geserveerd en de pagina nog uit de
  // cache, dan was `abs(verschil) > 45 min` en ging de waakvlam rood op een kerngezonde publicatie.
  const r = toetsMetStatus(ALLES_BEWEZEN, {
    paginaGebouwdOp: '2026-07-26T08:00:00.000Z',
    tekst: statusTekstVan(ALLES_BEWEZEN, CONTRACT_NU, '2026-07-26T11:59:00.000Z'),
  });
  assert.deepEqual(r.bevindingen, [], 'een verse publicatie mag niet rood worden om haar eigen cache');
  assert.match(r.waarschuwingen.join(' '), /zojuist gepubliceerd/);
  assert.equal(r.gemeten.bouwVerschilMs, (3 * 60 + 59) * 60 * 1000, 'het verschil wordt nog steeds gemeten');
});

test('een bouwstempel uit de toekomst is geen verse publicatie', () => {
  // Het venster loopt naar twee kanten. Zonder de ondergrens zou een verzet uurwerk of een
  // verzonnen `generatedAt` zich eeuwig als naijling kunnen voordoen en het oordeel wegnemen.
  const r = toetsMetStatus(BRONNEN_LEEG, {
    paginaGebouwdOp: '2026-07-26T09:00:00.000Z',
    tekst: statusTekstVan(BRONNEN_LEEG, CONTRACT_NU, '2026-07-26T23:00:00.000Z'),
  });
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['BRONSTAND_ANDERE_BOUW']);
});

// --- Codex ronde 7, P1-A: de toekomstgrens is klokspeling, geen respijt ---

test('een bouwstempel iets in de toekomst is klokspeling en telt nog als naijling', () => {
  // De bovengrens is klein en met opzet: klokken van twee machines lopen niet gelijk. Vijf minuten
  // vooruit is speling; daarbuiten begint het bedrog.
  const r = toetsMetStatus(ALLES_BEWEZEN, {
    paginaGebouwdOp: '2026-07-26T09:00:00.000Z',
    tekst: statusTekstVan(ALLES_BEWEZEN, CONTRACT_NU, '2026-07-26T12:04:00.000Z'),
  });
  assert.deepEqual(r.bevindingen, [], '4 min vooruit valt binnen de klokspeling');
  assert.match(r.waarschuwingen.join(' '), /zojuist gepubliceerd/);
});

test('een bouwstempel ruim in de toekomst koopt géén vrijstelling meer', () => {
  // De reproductie van Codex: een stempel tot 45 minuten vooruit gold als "verse publicatie" en nam
  // daarmee het bronoordeel weg — precies de vrijstelling die een verzonnen tijd kon kopen. De zone
  // `nu < stempel <= nu + graceMs` wordt hier aan beide randen gebonden.
  for (const [stempel, wat] of [
    ['2026-07-26T12:06:00.000Z', 'net buiten de klokspeling'],
    ['2026-07-26T12:44:00.000Z', 'binnen het oude respijt, ruim buiten de speling'],
  ]) {
    const r = toetsMetStatus(BRONNEN_LEEG, {
      paginaGebouwdOp: '2026-07-26T09:00:00.000Z',
      tekst: statusTekstVan(BRONNEN_LEEG, CONTRACT_NU, stempel),
    });
    assert.equal(r.ok, false, `${wat} hoort niet groen te zijn`);
    assert.deepEqual(r.bevindingen.map((b) => b.code), ['BRONSTAND_ANDERE_BOUW']);
    assert.match(r.bevindingen[0].uitleg, /in de toekomst/);
  }
});

// --- Codex ronde 7, P1-B: het bestand kan zijn eigen keuring niet meer uitzetten ---

test('een vreemde contractversie koopt geen bewijs zonder herkomst', () => {
  // De reproductie van Codex ronde 7: `contractVersion: "9.9.9"` schakelde de hele schemakeuring
  // uit, waarna één verzonnen `{ trust: "VERIFIED_CURRENT" }` zonder key, tijdstip of rijen als
  // bewijs meetelde en de waakvlam groen liet. De kernvelden gelden nu op ELKE versie: zo'n bron
  // telt niet mee, en dat is zichtbaar in `ongeteld`.
  const verzonnen = JSON.stringify({
    contractVersion: '9.9.9',
    generatedAt: '2026-07-26T11:55:00.000Z',
    overallStatus: 'OK',
    sources: [{ trust: 'VERIFIED_CURRENT' }],
  });
  const gelezen = lees(200, verzonnen);
  assert.equal(gelezen.bronnen.leesbaar, true, 'het bestand zelf is leesbaar — de BRON telt niet');
  assert.deepEqual([gelezen.bronnen.totaal, gelezen.bronnen.bewezen, gelezen.bronnen.ongeteld], [1, 0, 1]);

  const r = toetsMetStatus(ALLES_BEWEZEN, { tekst: verzonnen, paginaContract: '9.9.9' });
  assert.equal(r.ok, false, 'een zelfgekozen versie mag geen groen kopen');
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['GEEN_GEVERIFIEERDE_BRON']);
  assert.match(r.waarschuwingen.join(' '), /zonder herkomst/);
});

test('NEGATIEVE CONTROLE — dezelfde vreemde versie mét herkomst wordt gewoon geteld', () => {
  // Zo blijft bewezen dat de kernkeuring geen versiepoort in vermomming is: een oudere of nieuwere
  // gepubliceerde kopie die herkomst draagt, wordt gewoon geteld en op haar TELLING geveld.
  const r = toetsMetStatus(BRONNEN_LEEG, {
    contract: '9.9.9', paginaContract: '9.9.9',
    tekst: statusTekstVan(BRONNEN_LEEG, '9.9.9'),
  });
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['GEEN_GEVERIFIEERDE_BRON']);
  assert.match(r.waarschuwingen.join(' '), /andere contractversie/);
  const g = toetsMetStatus(ALLES_BEWEZEN, {
    contract: '9.9.9', paginaContract: '9.9.9',
    tekst: statusTekstVan(ALLES_BEWEZEN, '9.9.9'),
  });
  assert.deepEqual(g.bevindingen, [], 'acht bewezen bronnen op een vreemde versie blijven groen');
});

test('de kern kan niet van het contract afdrijven', () => {
  // Orderdiscipline R2: elke met de hand genoemde lijst krijgt een test die hem aan vaste literalen
  // bindt. Deze test bewaakt BEIDE richtingen. Tot ronde 9 stond hier alleen de bovengrens
  // (`kern ⊆ contract`), en Codex toonde wat die niet zag: de kern zelf laten KRIMPEN — `key`
  // eruit — hield alle tests groen, terwijl een bron zonder key daarna gewoon als bewijs meetelde.
  // Krimpen is toegestaan als het contract krimpt, maar nooit stilzwijgend.
  const verplicht = STATUS_SCHEMA.properties.sources.items.required;
  for (const veld of KERN_BRONVELDEN) {
    assert.equal(verplicht.includes(veld), true, `${veld} moet ook in het contract verplicht zijn`);
    assert.equal(typeof veld, 'string');
  }
  // De ondergrens: dit is de kern, letterlijk. Wie hem wil wijzigen wijzigt deze regel mee en legt
  // in dezelfde beweging uit waarom een bron zonder dat veld nog herkenbaar is.
  assert.deepEqual(KERN_BRONVELDEN, ['key', 'trust', 'retrievedAt']);
});

test('een tijdstip dat geen tijdstip is, koopt geen bewijs', () => {
  // Reproductie van Codex ronde 9 (P1, deel 1): op een vreemde contractversie bleven van de kern
  // drie niet-lege strings over, dus `retrievedAt: "geen datum"` telde als herkomst.
  const gelogen = JSON.stringify({
    contractVersion: '9.9.9',
    generatedAt: '2026-07-26T11:55:00.000Z',
    overallStatus: 'OK',
    sources: [{ key: 'x', trust: 'VERIFIED_CURRENT', retrievedAt: 'geen datum' }],
  });
  const gelezen = lees(200, gelogen);
  assert.deepEqual([gelezen.bronnen.totaal, gelezen.bronnen.bewezen, gelezen.bronnen.ongeteld], [1, 0, 1]);

  // NEGATIEVE CONTROLE — precies dezelfde bron met een echt tijdstip telt wél mee.
  const echt = JSON.stringify({
    contractVersion: '9.9.9',
    generatedAt: '2026-07-26T11:55:00.000Z',
    overallStatus: 'OK',
    sources: [{ key: 'x', trust: 'VERIFIED_CURRENT', retrievedAt: '2026-07-26T11:54:00.000Z' }],
  });
  assert.deepEqual([lees(200, echt).bronnen.bewezen, lees(200, echt).bronnen.ongeteld], [1, 0]);
});

test('plaat en statusbestand uit dezelfde bouw mogen niet twee contractversies noemen', () => {
  // De volledige reproductie van Codex ronde 9 (P1): een PAGINA op 2.7.0 met nul bewezen bronnen,
  // naast een statusbestand uit dezelfde bouw dat zich 9.9.9 noemt en zo de volle keuring uitzet.
  // Eén bouw heeft één contractversie; noemen ze er twee, dan is er één verzonnen of verwisseld.
  const vreemd = JSON.stringify({
    contractVersion: '9.9.9',
    generatedAt: '2026-07-26T11:55:00.000Z',
    overallStatus: 'OK',
    sources: [{ key: 'x', trust: 'VERIFIED_CURRENT', retrievedAt: '2026-07-26T11:54:00.000Z' }],
  });
  const r = toetsMetStatus(BRONNEN_LEEG, { tekst: vreemd, paginaContract: CONTRACT_NU });
  assert.equal(r.ok, false, 'een statusbestand mag zichzelf geen andere versie geven dan de plaat');
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['CONTRACT_UITEEN']);
  assert.match(r.bevindingen[0].uitleg, /plaat 2\.7\.0, statusbestand 9\.9\.9/);

  // NEGATIEVE CONTROLE — een ECHTE nieuwere kopie draagt die versie ook op de PAGINA, en dan is de
  // milde kernkeuring gewoon op haar plaats.
  const g = toetsMetStatus(ALLES_BEWEZEN, {
    contract: '9.9.9', paginaContract: '9.9.9', tekst: statusTekstVan(ALLES_BEWEZEN, '9.9.9'),
  });
  assert.deepEqual(g.bevindingen, [], 'dezelfde vreemde versie aan beide kanten is geen afwijking');
});

test('de categorie van een ongetelde bron haalt de openbare melding', () => {
  // Orderdiscipline R2: een reductie mag de oorzaak niet weggooien. Tot ronde 9 bleef `ongeteld`
  // steken in een waarschuwing die alleen in de runlog stond — in de spiegelregel was er niets van
  // terug te vinden, ook niet als er om een andere reden alarm was (bevinding Codex, ronde 9).
  const vreemd = JSON.stringify({
    contractVersion: '9.9.9',
    generatedAt: '2026-07-26T11:55:00.000Z',
    overallStatus: 'OK',
    sources: [{ trust: 'VERIFIED_CURRENT' }],
  });
  const r = toetsMetStatus(ALLES_BEWEZEN, { tekst: vreemd, paginaContract: '9.9.9' });
  assert.deepEqual(r.nevenpunten.map((n) => n.code), ['BRON_ZONDER_HERKOMST']);

  const rij = alarmRij({ bevindingen: r.bevindingen, nevenpunten: r.nevenpunten, nu: NU });
  assert.match(rij, /controlepunten: [^)]*bron-zonder-herkomst/);
  assert.match(rij, /zonder herkomst/);
  assert.equal(alarmRijPubliceerbaar(rij), true, 'de regel moet nog steeds door de publicatiepoort');

  // De herhaalcontrole leest de controlepunten TERUG uit de geschreven regel. Staat het nevenpunt
  // wel in de regel en niet in de lijst waarmee wordt vergeleken, dan is elke melding eeuwig nieuw.
  const codes = [...r.bevindingen, ...r.nevenpunten].map((b) => b.code);
  const spiegelMetRij = `${basisSpiegel}\n${rij}`;
  assert.equal(magAppenden(spiegelMetRij, codes, NU).mag, false, 'dezelfde melding mag niet twee keer');

  // NEGATIEVE CONTROLE — zonder nevenpunt staat de categorie er niet in.
  const kaal = alarmRij({ bevindingen: r.bevindingen, nu: NU });
  assert.equal(/bron-zonder-herkomst/.test(kaal), false);
});

test('nevenpunten zijn een gesloten lijst van vaste literalen', () => {
  // Orderdiscipline R2: elke allowlist krijgt een test die bindt dat elk lid een vaste literaal is
  // én dat het een categorie is die de melding kan uitleggen.
  assert.deepEqual(NEVENPUNTEN, ['BRON_ZONDER_HERKOMST']);
  for (const code of NEVENPUNTEN) {
    assert.equal(typeof CODES[code], 'string', `${code} moet een uitleg in CODES hebben`);
    assert.match(codeWoord(code), /^[a-z-]+$/);
  }
  // Een verzonnen nevenpunt haalt de melding niet: alleen leden van de lijst reizen mee.
  const rij = alarmRij({
    bevindingen: [{ code: 'GEEN_GEVERIFIEERDE_BRON', uitleg: CODES.GEEN_GEVERIFIEERDE_BRON }],
    nevenpunten: [{ code: 'VERZONNEN_PUNT', uitleg: 'dit hoort er niet te staan' }],
    nu: NU,
  });
  assert.equal(/verzonnen-punt|dit hoort er niet/.test(rij), false);
});

test('een schemabump geeft GEEN vals alarm op een gezonde oudere of nieuwere kopie', () => {
  // De reproductie van Codex ronde 8: een uit het schema afgeleide vormkeuring bindt onvermijdelijk
  // ook de `required`-lijst en de enums van ÉÉN versie. Een 2.8-schema tegen een gezonde 2.7-plaat
  // gaf toen 8 afwijkingen, een nieuwe trust-waarde tegen het oude schema 1 — en zulke alarmen
  // komen blijvend in het openbare logboek te staan. De kern verandert niet mee en heeft dat niet.
  const nieuwerVerplichtVeld = JSON.parse(statusTekstVan(ALLES_BEWEZEN, '9.9.9'));
  for (const bron of nieuwerVerplichtVeld.sources) delete bron.rijen;   // veld dat 2.8 pas kent
  const a = lees(200, JSON.stringify(nieuwerVerplichtVeld));
  assert.equal(a.bronnen.leesbaar, true);
  assert.deepEqual([a.bronnen.bewezen, a.bronnen.ongeteld], [8, 0], 'geen enkele bron valt weg');

  const nieuweTrust = JSON.parse(statusTekstVan(ALLES_BEWEZEN, '9.9.9'));
  nieuweTrust.sources[0].trust = 'VERIFIED_BY_WITNESS';
  nieuweTrust.nieuwVeld = 'iets wat 2.8.0 zal kennen';
  const b = lees(200, JSON.stringify(nieuweTrust));
  assert.equal(b.bronnen.leesbaar, true, 'een onbekende trust-waarde is geen vormfout meer');
  assert.deepEqual([b.bronnen.bewezen, b.bronnen.ongeteld], [7, 0], 'hij telt alleen niet als bewijs');
});

test('een statusbestand zonder bouwmoment is nergens aan vast te knopen', () => {
  // Twee wegen naar hetzelfde antwoord, en allebei nodig. Draagt het bestand de contractversie die
  // het schema kent, dan valt het al op de volle keuring: `generatedAt` is daar verplicht. Draagt
  // het een ándere versie, dan geldt alleen de kern en vangt de bouwtoets het — want zonder
  // bouwtijd is er niets om deze meting aan deze pagina vast te knopen.
  const gekeurd = JSON.stringify({ contractVersion: CONTRACT_NU, overallStatus: 'OK', sources: ALLES_BEWEZEN });
  const r1 = toetsMetStatus(ALLES_BEWEZEN, { tekst: gekeurd });
  assert.equal(r1.ok, false);
  assert.deepEqual(r1.bevindingen.map((b) => b.code), ['BRONSTAND_ONLEESBAAR']);
  assert.match(r1.bevindingen[0].uitleg, /volgt zijn eigen contract niet/);

  const ongekeurd = JSON.stringify({ contractVersion: '9.9.9', overallStatus: 'OK', sources: ALLES_BEWEZEN });
  const r2 = toetsMetStatus(ALLES_BEWEZEN, {
    tekst: ongekeurd, paginaContract: '9.9.9', paginaGebouwdOp: '2026-07-26T09:00:00.000Z',
  });
  assert.equal(r2.ok, false);
  assert.deepEqual(r2.bevindingen.map((b) => b.code), ['BRONSTAND_ANDERE_BOUW']);
  assert.match(r2.bevindingen[0].uitleg, /geen bouwtijd/);
});

test('NEGATIEVE CONTROLE — hetzelfde bestand mét het bouwmoment van de pagina oordeelt wél', () => {
  const r = toetsMetStatus(BRONNEN_LEEG);
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['GEEN_GEVERIFIEERDE_BRON']);
});

// --- geen enkele versiepoort staat nog tussen de bronstand en zijn oordeel (Codex ronde 6) ---

test('een oudere kopie van de plaat wordt óók geveld, want status.json droeg de bronnen altijd al', () => {
  // Hier zat de overgangsuitzondering: een plaat van vóór 2.7.0 werd niet beoordeeld. Die poort
  // hoorde bij het merk in de KOP van de pagina, dat inderdaad pas vanaf 2.7.0 bestaat — maar de
  // meting komt uit `status.json`, en dat draagt `sources` met `trust` al veel langer. De LIVE
  // 2.6.0-plaat levert er `4 van 8` uit. Een oudere kopie kan deze toets dus gewoon doorstaan.
  const r = toetsMetStatus(BRONNEN_LEEG, { contract: '2.6.0', paginaContract: '2.6.0' });
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['GEEN_GEVERIFIEERDE_BRON']);
});

test('dezelfde plaat op 2.7.0 is even rood — de versie doet er niet meer toe', () => {
  assert.deepEqual(toetsMetStatus(BRONNEN_LEEG, { contract: CONTRACT_NU }).bevindingen.map((b) => b.code),
    ['GEEN_GEVERIFIEERDE_BRON']);
});

test('een onleesbare contractversie is zelf een afwijking, vóór de versiepoorten', () => {
  // Codex ronde 3, P2. `null` leest bij ELKE versiepoort als "ouder dan", dus toets 3, 4 én de
  // overgangsuitzondering van toets 5 schakelden zichzelf uit op precies de plaat die de waarnemer
  // niet herkende. Uitkomst was `contract=null, ok=true, bevindingen=[]`.
  const r = toetsMetStatus(ALLES_BEWEZEN, { paginaContract: null });
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['CONTRACT_ONLEESBAAR']);
  assert.equal(r.ok, false);
  assert.equal(r.gemeten.bronnen.bewezen, 8, 'de bronstand blijft gewoon leesbaar');
});

test('een pagina zonder leesbare contractvoettekst blijft rood, wat status.json ook beweert', () => {
  // Codex ronde 6, P1-B, letterlijk zijn reproductie: een verder gezonde 2.7.0-plaat waarvan alleen
  // de contractvoettekst weg is. Die was rood op main en werd groen toen de executor de versie uit
  // `status.json` ging halen in plaats van uit de pagina. De twee versies zijn nu weer gescheiden.
  const html = paginaMetBronnen(ALLES_BEWEZEN)
    .replace(/Gegenereerd door <code>stack-dashboard<\/code> \(contract [0-9.]+\)/, 'contract onbekend');
  const uitPagina = html
    .match(/Gegenereerd door <code>stack-dashboard<\/code> \(contract ([0-9]+\.[0-9]+\.[0-9]+)\)/)?.[1] ?? null;
  assert.equal(uitPagina, null, 'de voettekst is er echt uit');
  const gelezen = lees(200, statusTekstVan(ALLES_BEWEZEN));
  assert.equal(gelezen.contract, CONTRACT_NU, 'het statusbestand noemt zichzelf nog wél 2.7.0');
  const r = toets({
    paginaStatus: 200,
    paginaHtml: html,
    spiegelStatus: 200,
    spiegelTekst: basisSpiegel,
    contractVersie: uitPagina,
    bronstand: gelezen.bronnen,
    nu: NU,
  });
  assert.equal(r.ok, false, 'een plaat zonder eigen versie mag niet groen zijn');
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['CONTRACT_ONLEESBAAR']);
});

test('een versie die de vergelijker niet aankan, heet ook niet leesbaar', () => {
  // Codex ronde 4: `versieMinstens()` zet delen om met parseInt. Een paar honderd cijfers wordt
  // `Infinity` en dan heet elke versie "ouder" — waarmee elke versiepoort zichzelf uitschakelde.
  const absurd = `${'9'.repeat(309)}.0.0`;
  assert.equal(VERSIE_VORM.test(absurd), false);
  assert.equal(versieMinstens(absurd, CONTRACT_NU), false, 'de vergelijker noemt hem niet nieuwer');
  const r = toetsMetStatus(BRONNEN_LEEG, { contract: absurd, paginaContract: absurd });
  assert.equal(r.ok, false, 'geen stille groenmelding op een versie die niemand kan lezen');
  // Twee losse afwijkingen, en dat hoort: de versie van de PAGINA is onleesbaar, en die van het
  // statusbestand ook — sinds ronde 8 is dat laatste zelf een afwijking, want een onleesbare versie
  // kocht anders een vrijstelling van de volle keuring (bevinding Codex ronde 8).
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['CONTRACT_ONLEESBAAR', 'BRONSTAND_ONLEESBAAR']);
  assert.match(r.bevindingen[1].uitleg, /contractversie van het statusbestand is niet te lezen/);
});

test('de plaat blijft haar bronstand ook zelf zeggen', () => {
  // Het merk in de kop wordt niet meer BEOORDEELD, maar het hoort er wel te staan: wie de pagina
  // zelf bekijkt, moet kunnen zien waar ze op rust. De vorm is dezelfde rekensom als in status.json.
  const html = paginaMetBronnen(BRONNEN_LEEG);
  const kop = html.slice(0, html.indexOf('</head>'));
  assert.equal(kop.includes('<meta name="bronstand" content="bewezen=0 totaal=8">'), true);
  assert.equal(paginaMetBronnen(ALLES_BEWEZEN).includes('content="bewezen=8 totaal=8"'), true);
});

test('Date.parse is geen tijdstipkeuring — parseerbare onzin koopt geen bewijs', () => {
  // Reproductie van Codex ronde 10 (P1). Ronde 9 eiste een "leesbaar tijdstip" en gebruikte daar
  // `Date.parse` voor. Dat is geen validator: V8 leest `"0"` als 31-12-1999 en rolt `2026-02-30`
  // stilzwijgend door naar 2 maart. Codex' echte HTTP-reproductie draaide `rc=0` met
  // `bronnen: 1 van 1 geverifieerd` op één bron met `retrievedAt: "0"`.
  //
  // Zonder zone is de derde: `2026-07-26T11:54:00` leest V8 als LOKALE tijd, dus dezelfde tekst
  // betekent iets anders op een andere machine. Herkomst die van de tijdzone van de controlemachine
  // afhangt is geen herkomst.
  const geenTijdstip = ['0', '2026-02-30T11:54:00.000Z', '2026-07-26T11:54:00', '2026-07-26', 'nu'];
  for (const retrievedAt of geenTijdstip) {
    const gelezen = lees(200, JSON.stringify({
      contractVersion: '9.9.9',
      generatedAt: '2026-07-26T11:55:00.000Z',
      overallStatus: 'OK',
      sources: [{ key: 'x', trust: 'VERIFIED_CURRENT', retrievedAt }],
    }));
    assert.deepEqual(
      [gelezen.bronnen.totaal, gelezen.bronnen.bewezen, gelezen.bronnen.ongeteld], [1, 0, 1],
      `${JSON.stringify(retrievedAt)} is geen tijdstip en mag dus geen bewijs kopen`,
    );
  }
  // NEGATIEVE CONTROLE — de kalender wordt echt gelezen: 28 februari bestaat wél.
  const bestaat = lees(200, JSON.stringify({
    contractVersion: '9.9.9',
    generatedAt: '2026-07-26T11:55:00.000Z',
    overallStatus: 'OK',
    sources: [{ key: 'x', trust: 'VERIFIED_CURRENT', retrievedAt: '2026-02-28T11:54:00.000Z' }],
  }));
  assert.deepEqual([bestaat.bronnen.bewezen, bestaat.bronnen.ongeteld], [1, 0]);
});

test('een bouwstempel dat geen tijdstip is, koopt geen naijlingsvrijstelling', () => {
  // Het tweede been van Codex ronde 10 (P1), op `generatedAt`. De naijlingsvrijstelling — "er is
  // zojuist gepubliceerd, dus de bronstand wordt deze ronde niet beoordeeld" — hangt aan de
  // NIEUWSTE van de twee bouwmomenten. Las de waakvlam dat moment met `Date.parse`, dan kon een
  // statusbestand zichzelf vers rekenen met een stempel zonder zone: dezelfde tekst betekent op de
  // controlemachine iets anders dan op de bouwmachine. Hieronder staat de pagina drie uur stil en
  // is er nul bewezen bron; alleen het verzonnen stempel hield de zaak groen.
  const l = new Date(NU);
  const tweeCijfers = (n) => String(n).padStart(2, '0');
  // Exact het lokale wandkloktijdstip van NU, zonder zone: `Date.parse` leest dit als "nu", in elke
  // tijdzone. Zo is de test niet afhankelijk van de zone van de machine die hem draait.
  const zonderZone = `${l.getFullYear()}-${tweeCijfers(l.getMonth() + 1)}-${tweeCijfers(l.getDate())}`
    + `T${tweeCijfers(l.getHours())}:${tweeCijfers(l.getMinutes())}:${tweeCijfers(l.getSeconds())}.000`;
  assert.equal(Date.parse(zonderZone), NU, 'de opzet klopt alleen als V8 dit als "nu" leest');

  const paginaGebouwdOp = new Date(NU - 3 * 3600 * 1000).toISOString();
  const gelezen = lees(200, statusTekstVan(BRONNEN_LEEG, CONTRACT_NU, zonderZone));
  assert.equal(gelezen.bronnen.gebouwdOp, null, 'een stempel zonder zone is geen bouwidentiteit');

  const r = toets({
    paginaStatus: 200,
    paginaHtml: paginaMetBronnen(BRONNEN_LEEG, { gebouwdOp: paginaGebouwdOp }),
    spiegelStatus: 200,
    spiegelTekst: basisSpiegel,
    contractVersie: CONTRACT_NU,
    bronstand: gelezen.bronnen,
    bronContractVersie: gelezen.contract,
    nu: NU,
  });
  assert.equal(r.ok, false, 'nul bewezen bronnen mag niet groen blijven op een verzonnen stempel');
  assert.equal(r.bevindingen.some((b) => b.code === 'BRONSTAND_ANDERE_BOUW'), true);
  assert.match(r.bevindingen.find((b) => b.code === 'BRONSTAND_ANDERE_BOUW').uitleg, /geen bouwtijd/);

  // NEGATIEVE CONTROLE — hetzelfde tijdstip mét zone is wél een bouwidentiteit, en dan is de
  // naijlingsvrijstelling gewoon op haar plaats: er is aantoonbaar zojuist gepubliceerd.
  // (De bronnen zijn hier bewezen: sinds ronde 11 wordt een NIEUWSTE statusbestand dat zélf nul
  // bewezen bronnen meldt wél beoordeeld, dus met een lege stand zou deze controle om een andere
  // reden rood worden en niets meer over de vrijstelling zeggen.)
  const metZone = lees(200, statusTekstVan(ALLES_BEWEZEN, CONTRACT_NU, new Date(NU).toISOString()));
  assert.equal(metZone.bronnen.gebouwdOp, new Date(NU).toISOString());
  const g = toets({
    paginaStatus: 200,
    paginaHtml: paginaMetBronnen(BRONNEN_LEEG, { gebouwdOp: paginaGebouwdOp }),
    spiegelStatus: 200,
    spiegelTekst: basisSpiegel,
    contractVersie: CONTRACT_NU,
    bronstand: metZone.bronnen,
    bronContractVersie: metZone.contract,
    nu: NU,
  });
  assert.equal(g.bevindingen.some((b) => b.code === 'BRONSTAND_ANDERE_BOUW'), false);
  assert.equal(g.waarschuwingen.some((w) => /naijling van de CDN/.test(w)), true);
});

test('de lijst met nevenpunten is bevroren', () => {
  // Codex ronde 10 (P3): `NEVENPUNTEN` is de allowlist waar de publieke alarmregel op filtert. Een
  // lijst die in te vullen is vanaf een andere module is geen allowlist maar een suggestie — één
  // `push` en willekeurige tekst reist mee in de openbare melding.
  assert.equal(Object.isFrozen(NEVENPUNTEN), true);
  assert.throws(() => { NEVENPUNTEN.push('VERZONNEN_PUNT'); }, TypeError);
  assert.deepEqual(NEVENPUNTEN, ['BRON_ZONDER_HERKOMST'], 'en de inhoud is er niet van veranderd');
});

test('de sabotagekeuze in de workflow biedt precies de proeven die de executor kent', async () => {
  // Codex ronde 10 (P3): `SABOTAGE=bronnen` is de acceptatieproef van deze hele PR, maar hij was
  // alleen vanaf de omgevingsvariabele te draaien. De keuzelijst in de workflow en de takken in de
  // executor moeten elkaar dekken — anders bestaat er een knop die niets doet, of een proef die
  // niemand kan indrukken. Deze test LEEST `.github/` en wijzigt er niets: die map is in deze order
  // verboden terrein op die ene, vooraf afgestemde regel na.
  const yml = await readFile(join(ROOT, '.github/workflows/waarnemer.yml'), 'utf8');
  const keuze = yml.match(/^\s*options:\s*\[([^\]]*)\]\s*$/m);
  assert.notEqual(keuze, null, 'de sabotage-invoer moet een keuzelijst hebben');
  const opties = keuze[1].split(',').map((s) => s.trim());
  assert.deepEqual(opties, ['geen', 'stempel', 'bronnen']);

  // De andere kant van het contract: elke keuze behalve `geen` grijpt aantoonbaar een tak aan in de
  // executor, en de standaardwaarde is de tak die niets doet.
  const executor = await readFile(join(ROOT, 'scripts/waarnemer.mjs'), 'utf8');
  for (const optie of opties.filter((o) => o !== 'geen')) {
    assert.match(executor, new RegExp(`SABOTAGE === '${optie}'`), `${optie} moet een tak hebben`);
  }
  assert.match(yml, /^\s*default:\s*geen\s*$/m);
  assert.match(executor, /const SABOTAGE = process\.env\.SABOTAGE \|\| 'geen';/);
});

test('een verse PAGINA koopt geen vrijstelling voor een statusbestand zonder bouwtijd', () => {
  // Reproductie van Gemini ronde 8 (P1), zelf nagedraaid over http vóór de reparatie: pagina 5 min
  // oud, `generatedAt: "0"` in het statusbestand, `bronnen: 0 van 2 geverifieerd` -- en tóch exit 0.
  // De naijlingsvrijstelling keek naar de NIEUWSTE van de twee bouwen; was de pagina vers, dan was
  // die de nieuwste, en werd de telling van een bestand dat aan geen enkele bouw vastzit
  // overgeslagen. Dat is het incident van 22-08 opnieuw, gekocht met één ongeldig stempel.
  const zonderBouwtijd = JSON.stringify({
    contractVersion: CONTRACT_NU,
    generatedAt: '0',
    overallStatus: 'OK',
    sources: BRONNEN_LEEG,
  });
  const gelezen = lees(200, zonderBouwtijd);
  assert.equal(gelezen.bronnen.gebouwdOp, null, 'de opzet klopt alleen zonder bruikbaar bouwmoment');

  const r = toets({
    paginaStatus: 200,
    // De PAGINA is kersvers -- dat was precies de voorwaarde die de vrijstelling kocht.
    paginaHtml: paginaMetBronnen(BRONNEN_LEEG, { gebouwdOp: new Date(NU - 5 * 60000).toISOString() }),
    spiegelStatus: 200,
    spiegelTekst: basisSpiegel,
    contractVersie: CONTRACT_NU,
    bronstand: gelezen.bronnen,
    bronContractVersie: gelezen.contract,
    nu: NU,
  });
  assert.equal(r.ok, false, 'nul bewezen bronnen mag niet groen blijven op een verse pagina alleen');
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['BRONSTAND_ANDERE_BOUW']);
  assert.match(r.bevindingen[0].uitleg, /geen bouwtijd om aan te knopen/);
  assert.equal(r.waarschuwingen.some((w) => /naijling van de CDN/.test(w)), false,
    'een bestand zonder bouwtijd is niet "onderweg" maar niet toe te schrijven');

  // NEGATIEVE CONTROLE — de vrijstelling zelf blijft bestaan: mét een geldig bouwmoment uit een
  // andere, verse bouw is een mengsel van oud en nieuw gewoon te verwachten en oordeelt de
  // waakvlam deze ronde niet.
  // Bewezen bronnen, om dezelfde reden als hierboven: sinds ronde 11 oordeelt de waakvlam wél op een
  // NIEUWSTE statusbestand dat nul bewezen bronnen meldt.
  const metBouwtijd = lees(200, statusTekstVan(ALLES_BEWEZEN, CONTRACT_NU, new Date(NU - 60000).toISOString()));
  const g = toets({
    paginaStatus: 200,
    paginaHtml: paginaMetBronnen(BRONNEN_LEEG, { gebouwdOp: new Date(NU - 5 * 60000).toISOString() }),
    spiegelStatus: 200,
    spiegelTekst: basisSpiegel,
    contractVersie: CONTRACT_NU,
    bronstand: metBouwtijd.bronnen,
    bronContractVersie: metBouwtijd.contract,
    nu: NU,
  });
  assert.deepEqual(g.bevindingen, []);
  assert.equal(g.waarschuwingen.some((w) => /naijling van de CDN/.test(w)), true);
});

test('het NIEUWSTE bestand van de twee koopt geen respijt voor zijn eigen nulstand', () => {
  // Reproductie van Codex ronde 11 (P1), zelf nagedraaid over http vóór de reparatie: de PAGINA komt
  // vier uur oud uit de CDN-cache, het STATUSBESTAND is één minuut oud, beide dragen 2.7.0 en het
  // statusbestand meldt `0 van 2 geverifieerd` -- en tóch exit 0. Het respijt bestaat om NIET te
  // oordelen op een bestand dat mogelijk achterloopt; is dat bestand juist de nieuwste van de twee,
  // dan loopt het nergens op achter en is er niets meer om op te wachten. Dat is het incident van
  // 22-08 opnieuw, nu gekocht met een verse publicatie ernaast.
  const status = lees(200, statusTekstVan(BRONNEN_LEEG, CONTRACT_NU, new Date(NU - 60000).toISOString()));
  const r = toets({
    paginaStatus: 200,
    paginaHtml: paginaMetBronnen(BRONNEN_LEEG, { gebouwdOp: new Date(NU - 4 * 3600 * 1000).toISOString() }),
    spiegelStatus: 200,
    spiegelTekst: basisSpiegel,
    contractVersie: CONTRACT_NU,
    bronstand: status.bronnen,
    bronContractVersie: status.contract,
    nu: NU,
  });
  assert.equal(r.ok, false, 'nul bewezen bronnen in het nieuwste bestand mag niet groen blijven');
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['GEEN_GEVERIFIEERDE_BRON']);
  assert.match(r.bevindingen[0].uitleg, /uit de nieuwste van de twee bouwen/);
  assert.equal(r.waarschuwingen.some((w) => /niet beoordeeld/.test(w)), false,
    'juist niet uitstellen: het oordeel valt deze ronde');
  assert.equal(r.waarschuwingen.some((w) => /wél de nieuwste van de twee/.test(w)), true,
    'en de reden staat er zichtbaar bij');

  // NEGATIEVE CONTROLE 1 — de andere kant blijft ongemoeid. Een OUDER nul-statusbestand naast een
  // NIEUWERE pagina is precies de gezonde verse publicatie die het respijt beschermt: daar loopt het
  // statusbestand wél achter en mag de waakvlam niet vals rood worden.
  const ouder = lees(200, statusTekstVan(BRONNEN_LEEG, CONTRACT_NU, new Date(NU - 10 * 60000).toISOString()));
  const g = toets({
    paginaStatus: 200,
    paginaHtml: paginaMetBronnen(ALLES_BEWEZEN, { gebouwdOp: new Date(NU - 60000).toISOString() }),
    spiegelStatus: 200,
    spiegelTekst: basisSpiegel,
    contractVersie: CONTRACT_NU,
    bronstand: ouder.bronnen,
    bronContractVersie: ouder.contract,
    nu: NU,
  });
  assert.deepEqual(g.bevindingen, [], 'een achterlopend nul-bestand houdt het respijt');
  assert.equal(g.waarschuwingen.some((w) => /niet beoordeeld/.test(w)), true);

  // NEGATIEVE CONTROLE 2 — het nieuwste bestand mét bewezen bronnen blijft ook gewoon groen; de
  // nieuwe tak oordeelt over de nulstand, niet over het nieuwer-zijn op zichzelf.
  const nieuwsteBewezen = lees(200, statusTekstVan(ALLES_BEWEZEN, CONTRACT_NU, new Date(NU - 60000).toISOString()));
  const b = toets({
    paginaStatus: 200,
    paginaHtml: paginaMetBronnen(BRONNEN_LEEG, { gebouwdOp: new Date(NU - 4 * 3600 * 1000).toISOString() }),
    spiegelStatus: 200,
    spiegelTekst: basisSpiegel,
    contractVersie: CONTRACT_NU,
    bronstand: nieuwsteBewezen.bronnen,
    bronContractVersie: nieuwsteBewezen.contract,
    nu: NU,
  });
  assert.deepEqual(b.bevindingen, []);
  assert.equal(b.waarschuwingen.some((w) => /niet beoordeeld/.test(w)), true);
});

test('op het nieuwe oordeelpad reist de categorie van een bron zonder herkomst mee', () => {
  // Orderdiscipline R2: waar de telling werkelijk beoordeeld wordt, moet de vaste categorie tot in
  // de publieke alarmregel overleven -- ook op het pad dat ronde 11 erbij zette. Zonder de gedeelde
  // `meldOngeteld()` viel `BRON_ZONDER_HERKOMST` hier stil weg en bleef alleen "0 van 1" over.
  const zonderHerkomst = [{ trust: 'VERIFIED_CURRENT' }];
  const status = lees(200, statusTekstVan(zonderHerkomst, '9.9.9', new Date(NU - 60000).toISOString()));
  assert.equal(status.bronnen.ongeteld, 1, 'de opzet klopt alleen met één ongetelde bron');
  const r = toets({
    paginaStatus: 200,
    paginaHtml: paginaMetBronnen(BRONNEN_LEEG, { gebouwdOp: new Date(NU - 4 * 3600 * 1000).toISOString() }),
    spiegelStatus: 200,
    spiegelTekst: basisSpiegel,
    contractVersie: CONTRACT_NU,
    bronstand: status.bronnen,
    bronContractVersie: status.contract,
    nu: NU,
  });
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['GEEN_GEVERIFIEERDE_BRON']);
  assert.deepEqual(r.nevenpunten.map((n) => n.code), ['BRON_ZONDER_HERKOMST']);
  assert.match(r.nevenpunten[0].uitleg, /1 van 1/);
});

test('twee schrijfwijzen van hetzelfde tijdstip laten de nulstand niet ontsnappen', () => {
  // Codex ronde 12 (P3) zette dit geval neer: pagina `...Z`, statusbestand `...+00:00`, hetzelfde
  // milliseconde-tijdstip; zijn mutant `>` op `bronMs >= stempelMs` liet toen alle waarnemertests
  // groen en kocht over http `exit 0` op nul bewezen bronnen. Gemini wees in ronde 10 de oorzaak
  // een laag dieper aan: `zelfdeBouw` vergeleek TEKENREEKSEN, dus dezelfde bouw gold als twee
  // bouwen en kwam op het respijtpad terecht -- terwijl de pagina haar stempel altijd als `...Z`
  // opbouwt en `status.json` net zo goed `...+00:00` mag dragen. Sinds ronde 12 vergelijkt
  // `zelfdeBouw` het tijdstip: dit is ÉÉN bouw, dus geen naijlingswaarschuwing en een kale telling.
  // De mutant die deze test doodt is de terugkeer naar de tekenreeksvergelijking.
  const zelfdeMoment = new Date(NU - 60000);
  const metZ = zelfdeMoment.toISOString();                       // ...T11:53:00.000Z
  const metOffset = metZ.replace(/Z$/, '+00:00');                // ...T11:53:00.000+00:00
  assert.notEqual(metZ, metOffset, 'de opzet vraagt twee verschillende tekenreeksen');
  assert.equal(Date.parse(metZ), Date.parse(metOffset), 'die naar hetzelfde tijdstip wijzen');

  const status = lees(200, statusTekstVan(BRONNEN_LEEG, CONTRACT_NU, metOffset));
  const r = toets({
    paginaStatus: 200,
    paginaHtml: paginaMetBronnen(BRONNEN_LEEG, { gebouwdOp: metZ }),
    spiegelStatus: 200,
    spiegelTekst: basisSpiegel,
    contractVersie: CONTRACT_NU,
    bronstand: status.bronnen,
    bronContractVersie: status.contract,
    nu: NU,
  });
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['GEEN_GEVERIFIEERDE_BRON'],
    'hetzelfde tijdstip in twee schrijfwijzen is één bouw, en die stand wordt gewoon geteld');
  assert.match(r.bevindingen[0].uitleg, new RegExp(`\\(0 van ${BRONNEN_LEEG.length} bronnen\\)$`),
    'geen respijt-achtige toevoeging: er is niets uit te stellen, dit is dezelfde bouw');
  assert.ok(!r.waarschuwingen.some((w) => /andere bouw/.test(w)),
    'twee schrijfwijzen van hetzelfde moment mogen geen bouwverschil melden');
});

test('een uur-24-stempel bindt niet als dezelfde bouw', () => {
  // Codex ronde 13 (P2). RFC 3339 -- waar `date-time` in het schema op staat -- kent alleen de uren
  // 00 t/m 23, maar V8 rolt `T24:00:00.000Z` stilzwijgend door naar middernacht van de VOLGENDE
  // dag. Sinds de bouwidentiteit op milliseconden vergelijkt (ronde 12) was dat geen schoonheids-
  // foutje meer: het statusbestand bond dan als DEZELFDE bouw als de pagina van die middernacht en
  // kwam op het volle-contractpad. Codex' reproductie over http: pagina `2026-08-23T00:00:00.000Z`,
  // status `2026-08-22T24:00:00.000Z`, één VERIFIED_CURRENT bron, `verschil ... 0 s`, exit 0 --
  // terwijl de pagina 784 min oud was en met de oude tekenreeksvergelijking gewoon was afgekeurd.
  const middernacht = '2026-07-26T00:00:00.000Z';           // de pagina, 12 uur oud op NU
  const uurVierentwintig = '2026-07-25T24:00:00.000Z';      // ongeldig, maar V8 leest hetzelfde ms
  assert.equal(Date.parse(uurVierentwintig), Date.parse(middernacht),
    'de opzet vraagt twee tekenreeksen die V8 op dezelfde milliseconde legt');

  const status = lees(200, statusTekstVan(ALLES_BEWEZEN, CONTRACT_NU, uurVierentwintig));
  const r = toets({
    paginaStatus: 200,
    paginaHtml: paginaMetBronnen(ALLES_BEWEZEN, { gebouwdOp: middernacht }),
    spiegelStatus: 200,
    spiegelTekst: basisSpiegel,
    contractVersie: CONTRACT_NU,
    bronstand: status.bronnen,
    bronContractVersie: status.contract,
    nu: NU,
  });
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['BRONSTAND_ANDERE_BOUW'],
    'een onleesbaar bouwstempel hoort nergens aan te binden, ook niet aan hetzelfde tijdstip');
  assert.match(r.bevindingen[0].uitleg, /geen bouwtijd om aan te knopen/);

  // Negatieve controle: de GELDIGE schrijfwijze van precies dat moment bindt wel, en dan is er
  // niets aan de hand -- anders zou de begrenzing gezonde publicaties rood maken.
  const g = toets({
    paginaStatus: 200,
    paginaHtml: paginaMetBronnen(ALLES_BEWEZEN, { gebouwdOp: middernacht }),
    spiegelStatus: 200,
    spiegelTekst: basisSpiegel,
    contractVersie: CONTRACT_NU,
    bronstand: lees(200, statusTekstVan(ALLES_BEWEZEN, CONTRACT_NU, middernacht)).bronnen,
    bronContractVersie: CONTRACT_NU,
    nu: NU,
  });
  assert.deepEqual(g.bevindingen.map((b) => b.code), []);
});
