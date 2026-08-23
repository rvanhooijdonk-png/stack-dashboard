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
  SECTIES_VANAF, zelfRouteUitUrl, bronstandUitHtml, contractUitHtml, BRONSTAND_VANAF,
} from '../scripts/lib/waarnemer.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(join(ROOT, 'data/fixture.json'), 'utf8'));

const NU = Date.parse('2026-07-26T12:00:00.000Z');
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
    paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: basisSpiegel, contractVersie: KANAALPOST_VANAF, nu: NU,
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
    paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: basisSpiegel, contractVersie: NIEUWSTE_CONTRACT, nu: NU,
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
    paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: basisSpiegel, contractVersie: NIEUWSTE_CONTRACT, nu: NU,
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
// Deze toetsen draaien op een ECHT gerenderde pagina, niet op handgeschreven HTML: de waarnemer
// leest een merk dat `render.mjs` in de kop zet, dus als dat merk van vorm verandert of verdwijnt
// horen deze tests om te vallen en niet de productie.

/** Dezelfde plaat als `pagina()`, maar met een bronnenlijst en contractversie die de test bepaalt. */
function paginaMetBronnen(sources, { contract = BRONSTAND_VANAF, spiegelTekst = basisSpiegel } = {}) {
  const snap = structuredClone(fixture);
  snap.contractVersion = contract;
  snap.generatedAt = '2026-07-26T11:55:00.000Z';
  snap.kanaalpost = toPublicKanaalpost(kanaalpostUitTekst(spiegelTekst));
  snap.sources = sources;
  return renderHtml(snap, {});
}

/** De vorm van 22-08-2026: acht bronnen gelezen, geen enkele bewezen. */
const BRONNEN_LEEG = Array.from({ length: 8 }, (_, i) => ({
  key: `bron${i}`,
  retrievedAt: '2026-07-26T11:50:00.000Z',
  trust: i === 0 ? 'UNVERIFIED' : 'SOURCE_UNAVAILABLE',
  rijen: null,
}));
const ALLES_BEWEZEN = BRONNEN_LEEG.map((b) => ({ ...b, trust: 'VERIFIED_CURRENT' }));

const toetsVan = (html, contract = BRONSTAND_VANAF) => toets({
  paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: basisSpiegel,
  contractVersie: contract, nu: NU,
});

test('een verse, complete pagina waar geen enkele bron achter bewezen is, is een afwijking', () => {
  const r = toetsVan(paginaMetBronnen(BRONNEN_LEEG));
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['GEEN_GEVERIFIEERDE_BRON']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.gemeten.bronnen, { leesbaar: true, totaal: 8, bewezen: 0 });
});

test('NEGATIEVE CONTROLE — precies die pagina komt door toets 1 t/m 4 heen', () => {
  // Dit is de reden dat toets 5 bestaat. De pagina is vers, draagt een kloppende stempel, toont de
  // laatste bronregel en heeft al haar verplichte secties: elke bestaande toets zegt "in orde".
  // Op 22-08-2026 draaide de waarnemer daarom 81 keer groen over een plaat zonder inhoud.
  const r = toetsVan(paginaMetBronnen(BRONNEN_LEEG));
  const oude = r.bevindingen.map((b) => b.code).filter((c) => c !== 'GEEN_GEVERIFIEERDE_BRON');
  assert.deepEqual(oude, [], 'toets 1 t/m 4 vinden niets — dat was precies het gat');
  assert.equal(r.gemeten.stempelIso, '2026-07-26T11:55:00.000Z', 'de pagina was wel degelijk vers');
});

test('één bewezen bron is genoeg om niet te alarmeren', () => {
  const bijna = BRONNEN_LEEG.map((b, i) => (i === 3 ? { ...b, trust: 'VERIFIED_CURRENT' } : b));
  const r = toetsVan(paginaMetBronnen(bijna));
  assert.deepEqual(r.bevindingen, []);
  assert.deepEqual(r.gemeten.bronnen, { leesbaar: true, totaal: 8, bewezen: 1 });
});

test('alleen VERIFIED_CURRENT telt als bewijs — STALE is dat niet', () => {
  const stale = BRONNEN_LEEG.map((b) => ({ ...b, trust: 'STALE' }));
  const r = toetsVan(paginaMetBronnen(stale));
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['GEEN_GEVERIFIEERDE_BRON'],
    'acht verouderde bronnen zijn nul bewijzen');
});

test('een plaat waarvan alle bronnen bewezen zijn, meldt niets', () => {
  const r = toetsVan(paginaMetBronnen(ALLES_BEWEZEN));
  assert.deepEqual(r.bevindingen, []);
  assert.deepEqual(r.gemeten.bronnen, { leesbaar: true, totaal: 8, bewezen: 8 });
});

test('een plaat zonder ENKELE gelezen bron is een afwijking, geen "alles in orde"', () => {
  // Het ergste geval, en tot 23-08-2026 het stilste: `sources: []` maakte `stale.length === 0`, dus
  // de plaat zei "alle bronnen zijn geverifieerd" en kwam door alle vier de bestaande toetsen heen
  // — gemeten, niet aangenomen.
  const r = toetsVan(paginaMetBronnen([]));
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['GEEN_GEVERIFIEERDE_BRON']);
  assert.deepEqual(r.gemeten.bronnen, { leesbaar: true, totaal: 0, bewezen: 0 });
});

test('het merk wordt uit de ECHTE pagina gelezen, dus een hernoeming valt hier om', () => {
  assert.deepEqual(bronstandUitHtml(paginaMetBronnen(BRONNEN_LEEG)), { leesbaar: true, totaal: 8, bewezen: 0 });
  assert.deepEqual(bronstandUitHtml(paginaMetBronnen(ALLES_BEWEZEN)), { leesbaar: true, totaal: 8, bewezen: 8 });
});

test('verdwijnt het merk uit de kop, dan zwijgt de waarnemer niet maar meldt hij dat', () => {
  const html = paginaMetBronnen(ALLES_BEWEZEN).replace(/<meta name="bronstand"[^>]*>/, '');
  const codes = toetsVan(html).bevindingen.map((b) => b.code);
  assert.deepEqual(codes, ['BRONSTAND_ONLEESBAAR']);
});

test('inhoud van de plaat kan het merk niet namaken: alleen de kop telt', () => {
  // De body draagt gesaneerde bronregels. Zou de parser de hele pagina lezen, dan kon één melding
  // een weggevallen merk vervangen (vals groen) of een gezond merk verdubbelen (vals rood).
  // Bevinding Codex 23-08-2026; opgelost door alleen vóór `</head>` te kijken.
  const namaak = '<meta name="bronstand" content="bewezen=99 totaal=99">';

  const zonderKop = paginaMetBronnen(BRONNEN_LEEG).replace(/<meta name="bronstand"[^>]*>/, '');
  const vervangen = zonderKop.replace('<body>', `<body>${namaak}`);
  assert.deepEqual(toetsVan(vervangen).bevindingen.map((b) => b.code), ['BRONSTAND_ONLEESBAAR'],
    'een merk in de body mag een weggevallen merk niet vervangen');

  const gezond = paginaMetBronnen(ALLES_BEWEZEN).replace('<body>', `<body>${namaak}`);
  assert.deepEqual(toetsVan(gezond).bevindingen, [],
    'en mag een gezonde pagina ook niet vals rood maken');
});

test('twee merken in de kop is onleesbaar, niet "de eerste maar nemen"', () => {
  const html = paginaMetBronnen(ALLES_BEWEZEN)
    .replace('</head>', '<meta name="bronstand" content="bewezen=0 totaal=8"></head>');
  assert.deepEqual(toetsVan(html).bevindingen.map((b) => b.code), ['BRONSTAND_ONLEESBAAR']);
});

test('onmogelijke aantallen zijn geen stand', () => {
  // Meer bewezen dan gelezen kan niet. Doorrekenen op onzin levert een groen dat niets betekent.
  const html = paginaMetBronnen(BRONNEN_LEEG)
    .replace(/<meta name="bronstand"[^>]*>/, '<meta name="bronstand" content="bewezen=9 totaal=8">');
  assert.deepEqual(bronstandUitHtml(html), { leesbaar: false, totaal: null, bewezen: null });
  assert.deepEqual(toetsVan(html).bevindingen.map((b) => b.code), ['BRONSTAND_ONLEESBAAR']);
});

test('een kopie van vóór de bronstand-versie wordt niet rood, maar zwijgt ook niet', () => {
  // Zelf-bewapening: een 2.6.0-plaat kan het merk onmogelijk dragen. Die mag daar niet om vallen,
  // maar de uitzondering hangt aan een versie — niet aan een datum of aan iemands geheugen.
  const oud = paginaMetBronnen([], { contract: '2.6.0' }).replace(/<meta name="bronstand"[^>]*>/, '');
  const r = toetsVan(oud, '2.6.0');
  assert.deepEqual(r.bevindingen, [], 'een oude kopie is geen afwijking');
  assert.equal(r.waarschuwingen.length, 1, 'maar hij zegt wel hardop dat hij niet kon kijken');
  assert.equal(versieMinstens('2.7.0', BRONSTAND_VANAF), true, 'en vanaf 2.7.0 is de toets hard');
});

// --- de drie gaten die Codex vond in de eerste versie van toets 5 (23-08-2026) ---

/**
 * Zoals de EXECUTOR het doet: contractversie uit de pagina lezen, niet injecteren. `toetsVan()`
 * hierboven geeft de versie mee en dekt daardoor precies de fout niet die Codex vond — daar zat de
 * verdenking op de brug tussen productie en test, dus die brug wordt hier zelf getest.
 */
const toetsAlsExecutor = (html) => toets({
  paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: basisSpiegel,
  contractVersie: contractUitHtml(html), nu: NU,
});

test('de executor en de test lezen dezelfde contractversie uit dezelfde plaat', () => {
  // Bindt de gedeelde extractie aan de echte plaat: verandert de voettekst van vorm, dan valt dit
  // om in plaats van dat productie stilletjes `null` gaat lezen.
  assert.equal(contractUitHtml(paginaMetBronnen(ALLES_BEWEZEN)), BRONSTAND_VANAF);
  assert.equal(contractUitHtml(paginaMetBronnen([], { contract: '2.6.0' })), '2.6.0');
  assert.equal(contractUitHtml('<html><body>geen voettekst</body></html>'), null);
});

test('een plaat zonder leesbare contractversie is geen oude kopie, maar een afwijking', () => {
  // Codex P1, letterlijk zijn proef: haal op een verder gezonde 2.7-pagina zowel het merk als de
  // contractvoettekst weg. In de eerste versie leverde dat `ok: true` met nul bevindingen op — de
  // overgangsuitzondering voor oude kopieën dekte óók de pagina die haar versie niet meer zegt.
  const html = paginaMetBronnen(ALLES_BEWEZEN)
    .replace(/<meta name="bronstand"[^>]*>/, '')
    .replace(/Gegenereerd door <code>stack-dashboard<\/code> \(contract [0-9.]+\)/, 'Gegenereerd door iets anders');
  assert.equal(contractUitHtml(html), null, 'de proef moet de voettekst echt onleesbaar maken');
  const r = toetsAlsExecutor(html);
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['CONTRACT_ONLEESBAAR', 'BRONSTAND_ONLEESBAAR']);
  assert.equal(r.ok, false);
});

test('een échte oude kopie krijgt de uitzondering nog steeds — ook via de executor-route', () => {
  // De tegenhanger: de uitzondering mag door de reparatie hierboven niet stilletjes verdwijnen,
  // anders wordt elke gecachte 2.6.0-plaat vals rood.
  const oud = paginaMetBronnen([], { contract: '2.6.0' }).replace(/<meta name="bronstand"[^>]*>/, '');
  const r = toetsAlsExecutor(oud);
  assert.deepEqual(r.bevindingen, []);
  assert.equal(r.waarschuwingen.filter((w) => w.includes('bronstand')).length, 1);
});

test('een tweede bronstand-merk telt mee, ook in een andere attribuutvolgorde', () => {
  // Codex P3: "precies één treffer" mag niet "precies één treffer van MIJN schrijfwijze" betekenen.
  // Een tegensprekend merk dat de attributen omdraait moet de meting onleesbaar maken, niet
  // onzichtbaar zijn. Beide richtingen: het mag niet vals groen (0 bewezen naast 8) en niet vals
  // rood (8 naast 8) worden — het antwoord op tegenspraak is "ik weet het niet".
  for (const namaak of [
    '<meta content="bewezen=0 totaal=8" name="bronstand">',
    "<meta name='bronstand' content='bewezen=0 totaal=8'>",
    '<meta name=bronstand content="bewezen=0 totaal=8">',
  ]) {
    const html = paginaMetBronnen(ALLES_BEWEZEN).replace('</head>', `${namaak}</head>`);
    assert.deepEqual(bronstandUitHtml(html), { leesbaar: false, totaal: null, bewezen: null },
      `een tweede merk als ${namaak} hoort de meting onleesbaar te maken`);
    assert.deepEqual(toetsVan(html).bevindingen.map((b) => b.code), ['BRONSTAND_ONLEESBAAR']);
  }
});

test('een meta die alleen maar op bronstand lijkt, telt niet mee', () => {
  // De keerzijde van de regel hierboven: was de naamherkenning te ruim, dan zou een ongerelateerde
  // `<meta name="bronstandaard">` de gezonde meting onleesbaar maken — vals rood door een woord.
  const html = paginaMetBronnen(ALLES_BEWEZEN)
    .replace('</head>', '<meta name="bronstandaard" content="bewezen=0 totaal=8"></head>');
  assert.deepEqual(bronstandUitHtml(html), { leesbaar: true, totaal: 8, bewezen: 8 });
  assert.deepEqual(toetsVan(html).bevindingen, []);
});

test('de waarde van het enige merk moet exact de afgesproken vorm hebben', () => {
  // Eén kandidaat, maar met een waarde die iets anders zegt dan afgesproken: dan hoort de waarnemer
  // te zeggen dat hij het niet kan lezen — niet welwillend te gaan interpreteren.
  const html = paginaMetBronnen(ALLES_BEWEZEN)
    .replace(/<meta name="bronstand"[^>]*>/, '<meta name="bronstand" content="bewezen=8/8">');
  assert.deepEqual(bronstandUitHtml(html), { leesbaar: false, totaal: null, bewezen: null });
});

test('een merk in andere hoofdletters of volgorde blijft leesbaar — typografie is geen betekenis', () => {
  // Gemini P2/P4: de eerste opzet las de tag als één vaste tekenreeks. Een tussenlaag die
  // attribuutnamen normaliseert of herordent maakte de bewaker dan blind op een KERNGEZONDE
  // pagina, en een bewaker die vals rood slaat wordt uitgezet. Hoofdletters en volgorde
  // veranderen niets aan wat er staat; de waarde blijft wel op de letter getoetst.
  for (const vorm of [
    '<META NAME="bronstand" CONTENT="bewezen=8 totaal=8">',
    '<meta content="bewezen=8 totaal=8" name="bronstand">',
    "<meta  name='bronstand'   content='bewezen=8 totaal=8'>",
  ]) {
    const html = paginaMetBronnen(ALLES_BEWEZEN).replace(/<meta name="bronstand"[^>]*>/, vorm);
    assert.deepEqual(bronstandUitHtml(html), { leesbaar: true, totaal: 8, bewezen: 8 }, `${vorm} hoort leesbaar te zijn`);
    assert.deepEqual(toetsVan(html).bevindingen, []);
  }
});

test('tekst BINNEN een andere meta-waarde telt niet als tweede merk', () => {
  // Gemini P3: zocht de teller in de ruwe tagtekst, dan maakte een beschrijving die toevallig
  // "name=bronstand" bevat de meting onleesbaar. De attribuut-tokenizer eet een waarde tussen
  // aanhalingstekens in zijn geheel op, dus zoiets kan geen kandidaat meer worden.
  const html = paginaMetBronnen(ALLES_BEWEZEN)
    .replace('</head>', '<meta name="description" content="documentatie over name=bronstand in deze app"></head>');
  assert.deepEqual(bronstandUitHtml(html), { leesbaar: true, totaal: 8, bewezen: 8 });
  assert.deepEqual(toetsVan(html).bevindingen, []);
});

test('een merk met een extra attribuut is niet ons merk', () => {
  // De keerzijde van de soepelheid hierboven: soepel op vorm mag niet soepel op inhoud worden.
  // Wat de bouw schrijft heeft precies twee attributen; iets anders is een pagina die wij niet
  // hebben gemaakt, en dan is "ik weet het niet" het juiste antwoord.
  const html = paginaMetBronnen(ALLES_BEWEZEN)
    .replace(/<meta name="bronstand"[^>]*>/, '<meta name="bronstand" content="bewezen=8 totaal=8" data-bron="elders">');
  assert.deepEqual(bronstandUitHtml(html), { leesbaar: false, totaal: null, bewezen: null });
  assert.deepEqual(toetsVan(html).bevindingen.map((b) => b.code), ['BRONSTAND_ONLEESBAAR']);
});

// --- ronde 2 van de review: wat er wel STAAT maar niet WERKT (Codex, 23-08-2026) ---

test('een uitgecommentarieerd of ingesloten merk telt niet als meting', () => {
  // Codex' probe: drie pagina's zonder één werkend bronstand-element leverden alle drie
  // `{leesbaar: true, bewezen: 8}` op. Een merk in commentaar kon de bewaking dus groen houden —
  // precies de stille groenmelding waar deze hele toets tegen is.
  const namaak = '<meta name="bronstand" content="bewezen=8 totaal=8">';
  for (const ruis of [
    `<!-- ${namaak} -->`,
    `<script>const x = '${namaak}'</script>`,
    `<title>${namaak}</title>`,
    `<style>/* ${namaak} */</style>`,
  ]) {
    const html = paginaMetBronnen(BRONNEN_LEEG)
      .replace(/<meta name="bronstand"[^>]*>/, '')
      .replace('</head>', `${ruis}</head>`);
    assert.deepEqual(bronstandUitHtml(html), { leesbaar: false, totaal: null, bewezen: null },
      `${ruis} is geen element en mag geen meting opleveren`);
    assert.deepEqual(toetsVan(html).bevindingen.map((b) => b.code), ['BRONSTAND_ONLEESBAAR']);
  }
});

test('ruis náást het echte merk maakt de meting niet stuk, en verandert haar ook niet', () => {
  // De keerzijde: het weghalen van commentaar en script-inhoud mag het echte merk niet meesleuren,
  // en een tegensprekend getal in commentaar mag de meting ook niet overschrijven.
  const html = paginaMetBronnen(ALLES_BEWEZEN)
    .replace('</head>', '<!-- <meta name="bronstand" content="bewezen=0 totaal=8"> --></head>');
  assert.deepEqual(bronstandUitHtml(html), { leesbaar: true, totaal: 8, bewezen: 8 });
  assert.deepEqual(toetsVan(html).bevindingen, []);
});

test('een los attribuut of een herhaald attribuut telt gewoon mee', () => {
  // Met een object als tokenizer verdwenen deze twee vormen uit de telling en glipten ze langs de
  // eis "precies twee attributen" (Codex ronde 2). Een tag met een tweede, tegensprekende
  // content-waarde is per definitie geen leesbare stand.
  for (const vorm of [
    '<meta disabled name="bronstand" content="bewezen=8 totaal=8">',
    '<meta name="bronstand" content="bewezen=8 totaal=8" content="bewezen=0 totaal=8">',
  ]) {
    const html = paginaMetBronnen(ALLES_BEWEZEN).replace(/<meta name="bronstand"[^>]*>/, vorm);
    assert.deepEqual(bronstandUitHtml(html), { leesbaar: false, totaal: null, bewezen: null },
      `${vorm} hoort onleesbaar te zijn`);
  }
});

test('</HEAD> is dezelfde grens als </head>', () => {
  // Hoofdlettergevoelig zoeken maakte een semantisch geldige pagina vals rood.
  const html = paginaMetBronnen(ALLES_BEWEZEN).replace('</head>', '</HEAD >');
  assert.deepEqual(bronstandUitHtml(html), { leesbaar: true, totaal: 8, bewezen: 8 });
});

test('een tweede contractvoettekst is geen versie, ook niet in commentaar', () => {
  // Codex ronde 2: een nagebootste 2.6-voettekst vóór de echte 2.7-voettekst leverde `2.6.0` op en
  // zette daarmee de overgangsuitzondering weer aan op een pagina die het merk hoorde te dragen.
  const echt = paginaMetBronnen(ALLES_BEWEZEN);
  assert.equal(contractUitHtml(echt), BRONSTAND_VANAF, 'nulmeting: één voettekst leest gewoon');
  const namaak = '<!-- Gegenereerd door <code>stack-dashboard</code> (contract 2.6.0) -->';
  const vervalst = echt.replace('<body>', `<body>${namaak}`).replace(/<meta name="bronstand"[^>]*>/, '');
  assert.equal(contractUitHtml(vervalst), null, 'twee voetteksten die elkaar tegenspreken = geen versie');
  const r = toetsAlsExecutor(vervalst);
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['CONTRACT_ONLEESBAAR', 'BRONSTAND_ONLEESBAAR']);
});

// --- ronde 3: tekst die eruitziet als opmaak (Codex, 23-08-2026) ---

test('een merk dat als TEKST in een andere attribuutwaarde staat, is geen element', () => {
  // Codex' probe. `<meta\b[^>]*>` stopte bij de `>` binnen de aanhalingstekens, waardoor de
  // ingesloten tekst als echt merk werd gelezen: met het echte merk weggehaald kwam er
  // `ok: true, bewezen: 8` uit — een pagina zonder bronnen die groen bleef.
  const namaak = `<meta name="description" content='x > <meta name="bronstand" content="bewezen=8 totaal=8">'>`;
  const html = paginaMetBronnen(BRONNEN_LEEG)
    .replace(/<meta name="bronstand"[^>]*>/, '')
    .replace('</head>', `${namaak}</head>`);
  assert.deepEqual(bronstandUitHtml(html), { leesbaar: false, totaal: null, bewezen: null });
  assert.deepEqual(toetsVan(html).bevindingen.map((b) => b.code), ['BRONSTAND_ONLEESBAAR']);
});

test('een merk in <template> of achter een onafgesloten comment werkt niet', () => {
  for (const ruis of [
    '<template><meta name="bronstand" content="bewezen=8 totaal=8"></template>',
    '<!-- <meta name="bronstand" content="bewezen=8 totaal=8">',
  ]) {
    const html = paginaMetBronnen(BRONNEN_LEEG)
      .replace(/<meta name="bronstand"[^>]*>/, '')
      .replace('</head>', `${ruis}</head>`);
    assert.deepEqual(bronstandUitHtml(html), { leesbaar: false, totaal: null, bewezen: null },
      `${ruis} hoort geen meting op te leveren`);
  }
});

test('een <!-- BINNEN een attribuutwaarde eet het echte merk niet op', () => {
  // De keerzijde: de vorige opzet knipte vanaf zo'n `<!--` tot een veel latere `-->` en nam het
  // ECHTE merk mee. Vals rood op een pagina die de browser probleemloos leest (Codex ronde 3).
  const html = paginaMetBronnen(ALLES_BEWEZEN)
    .replace('</head>', '<meta name="description" content="<!--"><!-- einde --></head>');
  assert.deepEqual(bronstandUitHtml(html), { leesbaar: true, totaal: 8, bewezen: 8 });
  assert.deepEqual(toetsVan(html).bevindingen, []);
});

test('een pagina zonder afgesloten kop levert geen meting op', () => {
  assert.deepEqual(bronstandUitHtml('<html><head><meta name="bronstand" content="bewezen=1 totaal=1">'),
    { leesbaar: false, totaal: null, bewezen: null });
});

test('een onleesbare contractversie is zelf een afwijking, vóór de versiepoorten', () => {
  // Codex ronde 3, P2. Zijn probe: haal ALLEEN de contractvoettekst weg en laat de pagina verder
  // volledig gezond (merk intact, alle bronnen bewezen). `contractUitHtml()` gaf dan `null`, en
  // `null` leest bij ELKE versiepoort als "ouder dan" — dus toets 3 (KANAALPOST_VANAF), toets 4
  // (SECTIES_VANAF) én de overgangsuitzondering van toets 5 schakelden zichzelf uit. Uitkomst:
  // `contract=null, ok=true, bevindingen=[]` op een pagina die de waarnemer niet herkende.
  const gezond = paginaMetBronnen(ALLES_BEWEZEN);
  assert.deepEqual(toetsAlsExecutor(gezond).bevindingen, [], 'nulmeting: de gezonde plaat is groen');

  const zonderVersie = gezond
    .replace(/Gegenereerd door <code>stack-dashboard<\/code> \(contract [0-9.]+\)/, 'Gegenereerd door iets anders');
  assert.equal(contractUitHtml(zonderVersie), null, 'de proef moet de versie echt onleesbaar maken');
  const r = toetsAlsExecutor(zonderVersie);
  // Het merk is er nog en alle bronnen zijn bewezen, dus toets 5 zwijgt terecht. De bevinding komt
  // van de plaat zelf: wie zijn versie niet zegt, mag niet door de poorten heen groen blijven.
  assert.deepEqual(r.bevindingen.map((b) => b.code), ['CONTRACT_ONLEESBAAR']);
  assert.equal(r.ok, false);
  assert.equal(r.gemeten.bronnen.bewezen, 8, 'de bronstand blijft gewoon leesbaar');
});
