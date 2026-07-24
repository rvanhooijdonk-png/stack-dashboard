import test from 'node:test';
import assert from 'node:assert/strict';

import { renderOverzicht } from '../scripts/lib/overzicht.mjs';
import { renderRegels } from '../scripts/lib/regels.mjs';
import { tabNav } from '../scripts/lib/nav.mjs';

/**
 * De twee nieuwe tabbladen zijn STATISCH: geen brondata, met de hand geschreven. Deze tests
 * bewaken twee dingen — dat de inhoud er staat (lagen, wetten, nav) en dat de pagina's zich aan
 * dezelfde beloftes houden als de rest: geen JavaScript, geen lokale paden, geen brondata-lek.
 */

test('de Overzicht-plaat draagt alle vier de lagen en de legenda', () => {
  const html = renderOverzicht({ generatedAt: '2026-07-24T09:00:00Z' });
  for (const laag of ['Richard', 'Kamers', 'De fabriek', 'Waar het draait']) {
    assert.ok(html.includes(`>${laag}</h2>`), `laag "${laag}" ontbreekt`);
  }
  // De fabrieksstroom en de bewakers.
  for (const stap of ['Taakwachtrij', 'Workers', 'Dubbele review', 'Merge-poort', 'Git als geheugen']) {
    assert.ok(html.includes(stap), `fabrieksstap "${stap}" ontbreekt`);
  }
  for (const bewaker of ['gitleaks', 'sanitize', 'kostenplafonds', 'PIEP']) {
    assert.ok(html.includes(bewaker), `bewaker "${bewaker}" ontbreekt`);
  }
  // De legenda met de drie functionele kleuren.
  assert.ok(html.includes('in gebruik') && html.includes('in aanbouw') && html.includes('wacht op Richard'));
});

test('de Overzicht-plaat draagt de sanitize-wet onverkort', () => {
  const html = renderOverzicht();
  assert.ok(html.includes('Sanitize-wet — onverkort'));
  assert.ok(html.includes('uitsluitend structuur'));
  assert.ok(html.includes('fail-closed'));
  assert.ok(html.includes('Een afgeleid label lekt zijn bron niet'));
});

test('de Regels-pagina draagt alle tien de wetten', () => {
  const html = renderRegels({ generatedAt: '2026-07-24T09:00:00Z' });
  const wetten = ['Reviewwet', 'Eén schrijver per repo', 'Fail-closed', 'Afgeleid lekt niet',
    'No-loss', 'Eigenaarspoort', 'Gates', 'Rol = tab', 'Richard-vorm', 'Vertaalwet'];
  for (const w of wetten) assert.ok(html.includes(`>${w}</h2>`), `wet "${w}" ontbreekt`);
  // Genummerd 1..10.
  for (let i = 1; i <= 10; i++) assert.ok(html.includes(`>${i}</span>`), `nummer ${i} ontbreekt`);
});

test('de statische pagina\'s draaien geen JavaScript en tonen geen lokaal pad', () => {
  for (const html of [renderOverzicht({ generatedAt: '2026-07-24T09:00:00Z' }), renderRegels({ generatedAt: '2026-07-24T09:00:00Z' })]) {
    assert.equal(html.includes('<script'), false, 'geen script-tag');
    assert.equal(html.includes('/Users/'), false, 'geen absoluut pad');
    assert.equal(/\bghp_|\bgithub_pat_|xox[baprs]-/.test(html), false, 'geen tokenvorm');
    assert.ok(html.startsWith('<!doctype html>'), 'volledige HTML-pagina');
    // Strikte CSP staat op elke pagina.
    assert.ok(html.includes("default-src 'none'"), 'CSP ontbreekt');
  }
});

test('de tabbalk markeert precies de actieve tab en linkt de andere', () => {
  const nav = tabNav('overzicht');
  // Drie tabbladen, in vaste volgorde.
  assert.ok(nav.includes('href="index.html"'));
  assert.ok(nav.includes('href="overzicht.html"'));
  assert.ok(nav.includes('href="regels.html"'));
  // Alleen de actieve draagt aria-current.
  assert.equal((nav.match(/aria-current="page"/g) || []).length, 1);
  assert.match(nav, /href="overzicht\.html" aria-current="page"/);
});
