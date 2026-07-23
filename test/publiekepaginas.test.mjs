import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderHtml } from '../scripts/lib/render.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(join(ROOT, 'data/fixture.json'), 'utf8'));
const verboden = JSON.parse(await readFile(join(ROOT, 'data/verboden-beloftes.json'), 'utf8'));
const publish = await readFile(join(ROOT, '.github/workflows/publish.yml'), 'utf8');

// Er gaan twee verschillende HTML-pagina's naar buiten: de gewone, en de foutpagina die de
// workflow zelf schrijft als de build afbreekt. De tweede werd hier eerst niet getest, en juist
// dáár stond de belofte nog dat de pagina "het elk kwartier opnieuw probeert en vanzelf herstelt"
// — op precies het moment dat een lezer op betrouwbaarheid moet kunnen rekenen. Gevonden door
// Codex in de review van deze PR. Beide paden lopen nu langs dezelfde lijst.
// Anker op de hele regel, niet op de losse delimiter: een tweede heredoc met dezelfde naam
// elders in het bestand zou anders stilletjes de verkeerde pagina laten toetsen.
const OPENER = "cat > public/index.html <<'HTML'";
const foutpagina = () => {
  // Regelankers erbij (m-vlag): de openingsopdracht moet een hele regel zijn, niet toevallig
  // ergens in een langere regel of in een YAML-commentaar staan.
  const opener = new RegExp(`^\\s*${OPENER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'gm');
  const treffers = [...publish.matchAll(opener)];
  assert.equal(treffers.length, 1, `verwacht precies één foutpagina-heredoc, gevonden: ${treffers.length}`);
  const start = treffers[0].index + treffers[0][0].length;
  const einde = publish.indexOf('\n          HTML\n', start);
  assert.notEqual(einde, -1, 'einde van de foutpagina-heredoc niet gevonden');
  return publish.slice(start, einde);
};

const paginas = [
  ['de gewone pagina', () => renderHtml(fixture)],
  ['de foutpagina uit publish.yml', foutpagina],
];

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
  assert.match(fout, /push naar main, bij een handmatige run, of bij de ingestelde/i);
  // De foutpagina mag de kwartierrun noemen — hij bestáát — maar moet er in dezelfde adem bij
  // zeggen dat je er niet op kunt rekenen. Codex' punt: onbetrouwbaar is niet hetzelfde als
  // afwezig, en "geen geplande run" zou net zo onwaar zijn als de belofte die we net weghaalden.
  assert.match(fout, /kun je hier niet vertrouwen/i);
  assert.match(fout, /pas nadat build\s+én publicatie slagen/i);
});
