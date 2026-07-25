import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderHtml } from '../scripts/lib/render.mjs';
import { failurePageHtml } from '../scripts/failure-page.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(join(ROOT, 'data/fixture.json'), 'utf8'));
const verboden = JSON.parse(await readFile(join(ROOT, 'data/verboden-beloftes.json'), 'utf8'));
const publish = await readFile(join(ROOT, '.github/workflows/publish.yml'), 'utf8');

// Er gaan twee verschillende HTML-pagina's naar buiten: de gewone, en de foutpagina die de
// workflow schrijft als de build afbreekt. De tweede werd hier eerst niet getest, en juist dáár
// stond de belofte nog dat de pagina "het elk kwartier opnieuw probeert en vanzelf herstelt" — op
// precies het moment dat een lezer op betrouwbaarheid moet kunnen rekenen (Codex-review). De
// foutpagina staat nu in één getest bestand (scripts/failure-page.mjs) i.p.v. een heredoc; beide
// paden lopen nog steeds langs dezelfde verboden-belofte-lijst.
const foutpagina = () => failurePageHtml();

const paginas = [
  ['de gewone pagina', () => renderHtml(fixture)],
  ['de foutpagina (scripts/failure-page.mjs)', foutpagina],
];

test('publish.yml genereert de foutpagina uit het geteste bestand (geen losse heredoc-kopie)', () => {
  // Bewaakt de koppeling CI ↔ bron: zou iemand teruggaan naar een inline heredoc, dan test deze
  // suite de ene pagina terwijl de workflow een andere publiceert. Dat mag niet stil kunnen.
  assert.match(publish, /node scripts\/failure-page\.mjs > public\/index\.html/,
    'de failure-page-job hoort de noodpagina uit scripts/failure-page.mjs te genereren');
});

// De patronen zijn letterlijke formuleringen, geen regexen. Zonder escapen zou een punt of
// haakje in een later toegevoegde zin stilletjes iets anders gaan betekenen dan bedoeld.
const letterlijk = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

for (const [naam, maak] of paginas) {
  test(`${naam} belooft geen verversing die we niet waarmaken`, () => {
    const html = maak();
    for (const patroon of verboden.patronen) {
      assert.equal(letterlijk(patroon).test(html), false,
        `${naam} bevat de verboden belofte "${patroon}" — zie data/verboden-beloftes.json`);
    }
  });
}

test('de lijst met verboden beloftes is niet stilletjes uitgekleed', () => {
  // Zonder dit is de bewaking hierboven uit te zetten met een lege array — of, subtieler, door
  // een patroon door onzin te vervangen — zonder dat een test rood wordt. Alle vier de gemeten
  // formuleringen staan hier daarom met naam en toenaam.
  const verplicht = [
    'ververst automatisch',
    'elk kwartier opnieuw',
    'probeert het elk kwartier',
    'herstelt vanzelf',
  ];
  for (const patroon of verplicht) {
    assert.ok(verboden.patronen.includes(patroon), `"${patroon}" hoort in data/verboden-beloftes.json te staan`);
  }
});

test('beide pagina\'s zeggen wél wat er dan wel gebeurt', () => {
  assert.match(renderHtml(fixture), /bij elke push naar main en bij een handmatige run/i);
  const fout = foutpagina();
  assert.match(fout, /push\s+naar\s+main,\s+bij\s+een\s+handmatige\s+run,\s+of\s+bij\s+een\s+geplande/i);
  // De foutpagina mag de geplande run noemen — hij bestáát — maar moet er in dezelfde adem bij
  // zeggen dat je er niet op kunt rekenen. Codex' punt: onbetrouwbaar is niet hetzelfde als
  // afwezig, en "geen geplande run" zou net zo onwaar zijn als de belofte die we net weghaalden.
  assert.match(fout, /kun je hier niet vertrouwen/i);
  // Whitespace-tolerant per woordgrens: dit toetst de inhoud, niet waar de regelafbreking van de
  // heredoc toevallig valt — een herformattering van de <p> mag deze bewaking niet stil breken.
  assert.match(fout, /pas nadat\s+build\s+én\s+publicatie\s+slagen/i);
});
