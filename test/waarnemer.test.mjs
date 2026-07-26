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
} from '../scripts/lib/waarnemer.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(join(ROOT, 'data/fixture.json'), 'utf8'));

const NU = Date.parse('2026-07-26T12:00:00.000Z');
const KOP = ['| datum-tijd | tab-rol | onderwerp | status | actie voor |',
  '| --- | --- | --- | --- | --- |'].join('\n');

const spiegelMet = (...rijen) => [KOP, ...rijen].join('\n');
const rij = (datum, tab, onderwerp, status = 'AFGEROND', actie = 'niemand') => `| ${datum} | ${tab} | ${onderwerp} | ${status} | ${actie} |`;

/** Een pagina zoals de plaat hem echt bouwt, met een kanaalpost uit deze spiegeltekst. */
function pagina(spiegelTekst, { contract = KANAALPOST_VANAF, generatedAt = '2026-07-26T11:55:00.000Z' } = {}) {
  const snap = structuredClone(fixture);
  snap.contractVersion = contract;
  snap.generatedAt = generatedAt;
  snap.kanaalpost = toPublicKanaalpost(kanaalpostUitTekst(spiegelTekst));
  return renderHtml(snap);
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
  assert.equal(r.waarschuwingen.length, 1);
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
  assert.match(r, /…/, 'te lange tekst hoort zichtbaar afgekapt te zijn');
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
