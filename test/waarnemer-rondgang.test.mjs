/**
 * DE RONDGANG — leest de waarnemer op de ECHTE gerenderde pagina precies terug wat de bron zei?
 *
 * Waarom dit bestand bestaat. De waarnemer vergeleek de bovenste rij op de plaat met de bovenste rij
 * uit de bron, en de tests daarvoor voedden hem met een ZELFGESCHREVEN stukje HTML. Daarmee bewees
 * die test alleen dat de waarnemer zijn eigen nepagina kan lezen. Op 26-07-2026 liep de waarnemer op
 * de echte plaat rood terwijl er niets mis was, op twee punten die een zelfgeschreven fixture
 * structureel niet kan vinden:
 *
 *  1. De statuskolom draagt ook de actiehouder, achter een `<br>` in een grijze span (bewust, zie
 *     `render.mjs`). Plat geslagen werd `status` de string "AFGEROND Richard: één keuze. Ga ik door…",
 *     wat nooit gelijk is aan het "AFGEROND" uit de bron. Elke rij MET actiehouder = onterecht rood.
 *  2. Een afgekapte rij eindigt op `…`, en `ontdaan()` doet NFKC — dat maakt van `…` de drie tekens
 *     `...`. De bron krijgt haar `…` er ná de normalisatie op, de pagina gaat er nog eens door. Dus
 *     liep élke rij langer dan 600 tekens uiteen op het laatste teken.
 *
 * Daarom gaat deze test niet langs een fixture maar langs de echte keten: bron → publicatiepoort →
 * `renderHtml` → uit de pagina teruglezen → vergelijken. Precies de rondgang die in productie loopt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { kanaalpostUitTekst, toPublicKanaalpost } from '../scripts/lib/kanaalpost.mjs';
import { renderHtml } from '../scripts/lib/render.mjs';
import {
  toets, eersteKanaalpostRij, sectieUitHtml, stempelUitHtml,
} from '../scripts/lib/waarnemer.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(join(ROOT, 'data/fixture.json'), 'utf8'));

const KOP = `| datum-tijd | tab-rol | onderwerp | status | actie voor |
|---|---|---|---|---|
`;
const bronMet = (...rijen) => KOP + rijen.map((r) => `${r}\n`).join('');

/** De echte keten: bron → poort → pagina → teruglezen. Geen zelfgeschreven HTML. */
function rondgang(bronTekst) {
  const publiek = toPublicKanaalpost(kanaalpostUitTekst(bronTekst));
  const snapshot = structuredClone(fixture);
  snapshot.kanaalpost = publiek;
  const sectie = sectieUitHtml(renderHtml(snapshot), 'kanaalpost');
  return { bron: publiek.rows[0], plaat: eersteKanaalpostRij(sectie), publiek, sectie };
}

test('een rij MET actiehouder komt van de pagina terug met alleen de status in het statusveld', () => {
  const { bron, plaat } = rondgang(bronMet(
    '| 2026-07-26 14:35 | CONTROL | Iets afgerond | WACHT OP AKKOORD | Richard: één keuze, ga ik door |',
  ));
  assert.equal(plaat.status, 'WACHT OP AKKOORD');
  assert.equal(plaat.status, bron.status, 'de actiehouder hoort niet in het statusveld te lekken');
});

test('een AFGEKAPTE rij komt van de pagina terug als dezelfde rij als in de bron', () => {
  const lang = `Zeer lange melding. ${'woord '.repeat(200)}einde`;
  const { bron, plaat } = rondgang(bronMet(
    `| 2026-07-26 14:35 | TRECHTER | **${lang}** | AFGEROND | niemand |`,
  ));
  assert.ok(bron.onderwerp.length <= 600, 'de poort hoort af te kappen');
  assert.match(bron.onderwerp, /…$/, 'de bron kapt af met één ellips-teken');
  // Niet "de strings zijn identiek" — dat is juist de val: NFKC maakt van `…` drie punten. De eis is
  // dat de VERGELIJKING van de waarnemer ze gelijk noemt, want die normaliseert beide kanten.
  assert.equal(plaat.datum, bron.datum);
  assert.equal(plaat.tab, bron.tab);
  assert.equal(plaat.onderwerp.replace(/\.{3}$/, '…'), bron.onderwerp);
});

test('de waarnemer meldt GEEN afwijking op een plaat die precies deze bron toont', () => {
  const lang = `Correctie op mijn rij van 14:10. ${'woord '.repeat(200)}einde`;
  const bronTekst = bronMet(
    '| 2026-07-26 09:00 | DASHBOARD | Ouder werk afgerond | AFGEROND | niemand |',
    `| 2026-07-26 14:35 | TRECHTER | **${lang}** | AFGEROND | **Richard: één keuze.** Ga ik door met C en D |`,
  );
  const { publiek, sectie } = rondgang(bronTekst);
  assert.ok(sectie, 'de sectie hoort op de pagina te staan');
  const snapshot = structuredClone(fixture);
  snapshot.kanaalpost = publiek;
  const html = renderHtml(snapshot);

  // De klok van de test volgt de stempel van de pagina zelf, zodat deze test over de VERGELIJKING
  // gaat en niet over de leeftijd van de fixture.
  const stempel = stempelUitHtml(html);
  assert.ok(stempel.iso, 'de gerenderde pagina hoort een leesbare stempel te hebben');

  const uitkomst = toets({
    paginaStatus: 200,
    paginaHtml: html,
    spiegelStatus: 200,
    spiegelTekst: bronTekst,
    contractVersie: '2.4.0',
    nu: Date.parse(stempel.iso) + 60_000,
  });
  assert.deepEqual(
    uitkomst.bevindingen.map((b) => b.code),
    [],
    `geen enkele afwijking verwacht, gekregen: ${JSON.stringify(uitkomst.bevindingen)}`,
  );
  assert.equal(uitkomst.ok, true);
});

test('een afgekapte rij ZONDER actiehouder geeft ook geen afwijking — het ellips-teken alleen', () => {
  // Deze staat los van de vorige zodat de twee oorzaken apart bewezen zijn: hier geen actiehouder
  // ("niemand" wordt niet getoond), dus wat hier faalt kan alleen de NFKC-ellips zijn.
  const bronTekst = bronMet(
    `| 2026-07-26 14:35 | TRECHTER | ${`lange melding ${'woord '.repeat(200)}einde`} | AFGEROND | niemand |`,
  );
  const { publiek } = rondgang(bronTekst);
  const snapshot = structuredClone(fixture);
  snapshot.kanaalpost = publiek;
  const html = renderHtml(snapshot);
  const stempel = stempelUitHtml(html);
  const uitkomst = toets({
    paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: bronTekst,
    contractVersie: '2.4.0', nu: Date.parse(stempel.iso) + 60_000,
  });
  assert.deepEqual(uitkomst.bevindingen.map((b) => b.code), []);
});

test('de statuskolom splitst ook op een <br> MET attributen', () => {
  // De eerste reparatie splitste op `<br\s*\/?>`. Zodra `render.mjs` ooit een klasse of stijl op dat
  // element zet, splitst die vorm niet meer en zit de actiehouder wéér in de status: vals rood, en dan
  // op een moment dat niemand naar deze regel kijkt (bevinding Codex E / Gemini E2).
  const sectie = `<section data-tab="kanaalpost"><table><tbody><tr>
    <td>CONTROL</td><td>Iets afgerond</td>
    <td>WACHT OP AKKOORD<br class="scheiding"><span class="muted">Richard: één keuze</span></td>
    <td>2026-07-26 14:35</td></tr></tbody></table></section>`;
  assert.equal(eersteKanaalpostRij(sectie).status, 'WACHT OP AKKOORD');
});

test('de tolerantie is precies het afkap-teken en niet meer — twee punten blijft rood', () => {
  // De vergelijking egaliseert `…` tegen `...` omdat de bron haar afkap-teken ná de normalisatie krijgt.
  // Die tolerantie mag niet uitlopen op "eindigt ongeveer hetzelfde": een plaat die iets ANDERS toont
  // dan de bron hoort rood te zijn, ook als het verschil klein is.
  const bronTekst = bronMet(
    `| 2026-07-26 14:35 | TRECHTER | ${`lange melding ${'woord '.repeat(200)}einde`} | AFGEROND | niemand |`,
  );
  const { publiek } = rondgang(bronTekst);
  const verminkt = structuredClone(fixture);
  verminkt.kanaalpost = structuredClone(publiek);
  verminkt.kanaalpost.rows[0].onderwerp = publiek.rows[0].onderwerp.replace(/…$/, '..');
  const html = renderHtml(verminkt);
  const uitkomst = toets({
    paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: bronTekst,
    contractVersie: '2.4.0', nu: Date.parse(stempelUitHtml(html).iso) + 60_000,
  });
  assert.deepEqual(uitkomst.bevindingen.map((b) => b.code), ['PAGINA_TOONT_OUDE_DATA']);
});

test('een plaat die WEL achterloopt op de bron blijft een afwijking', () => {
  // De reparatie mag de bewaker niet mild maken: dezelfde rondgang met een pagina die een oudere
  // stand toont hoort nog steeds te piepen.
  const oud = rondgang(bronMet('| 2026-07-26 09:00 | DASHBOARD | Ouder werk afgerond | AFGEROND | niemand |'));
  const nieuw = bronMet(
    '| 2026-07-26 09:00 | DASHBOARD | Ouder werk afgerond | AFGEROND | niemand |',
    '| 2026-07-26 09:30 | CONTROL | Nieuwer werk afgerond | AFGEROND | niemand |',
  );
  const paginaRij = oud.plaat;
  const bronRij = toPublicKanaalpost(kanaalpostUitTekst(nieuw)).rows[0];
  assert.notEqual(paginaRij.datum, bronRij.datum, 'de pagina loopt hier echt achter');
});
