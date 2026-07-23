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
const foutpagina = () => {
  const start = publish.indexOf("<<'HTML'");
  assert.notEqual(start, -1, 'foutpagina-heredoc niet gevonden in publish.yml');
  const einde = publish.indexOf('\n          HTML\n', start);
  assert.notEqual(einde, -1, 'einde van de foutpagina-heredoc niet gevonden');
  return publish.slice(start + "<<'HTML'".length, einde);
};

const paginas = [
  ['de gewone pagina', () => renderHtml(fixture)],
  ['de foutpagina uit publish.yml', foutpagina],
];

for (const [naam, maak] of paginas) {
  test(`${naam} belooft geen verversing die we niet waarmaken`, () => {
    const html = maak();
    for (const patroon of verboden.patronen) {
      assert.equal(new RegExp(patroon, 'i').test(html), false,
        `${naam} bevat de verboden belofte "${patroon}" — zie data/verboden-beloftes.json`);
    }
  });
}

test('de lijst met verboden beloftes is niet stilletjes leeggehaald', () => {
  // Zonder dit is de bewaking hierboven met één lege array uit te schakelen zonder dat een
  // test rood wordt.
  assert.ok(verboden.patronen.length >= 4, 'de lijst hoort minstens de vier gemeten formuleringen te bevatten');
  assert.ok(verboden.patronen.includes('ververst automatisch'));
  assert.ok(verboden.patronen.includes('herstelt vanzelf'));
});

test('beide pagina\'s zeggen wél wat er dan wel gebeurt', () => {
  assert.match(renderHtml(fixture), /bij elke push naar main en bij een handmatige run/i);
  assert.match(foutpagina(), /push naar main of bij\s+een handmatige run/i);
});
