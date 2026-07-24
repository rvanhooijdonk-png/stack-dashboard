import test from 'node:test';
import assert from 'node:assert/strict';

import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderOverzicht } from '../scripts/lib/overzicht.mjs';
import { renderRegels } from '../scripts/lib/regels.mjs';
import { tabNav } from '../scripts/lib/nav.mjs';
import { PUBLISH_ALLOWLIST, assertStaticPagePublishable } from '../scripts/build.mjs';
import { loadDenyTerms } from '../scripts/lib/sanitize.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * De twee nieuwe tabbladen zijn STATISCH: geen brondata, met de hand geschreven. Deze tests
 * bewaken twee dingen — dat de inhoud er staat (lagen, wetten, nav) en dat de pagina's zich aan
 * dezelfde beloftes houden als de rest: geen JavaScript, geen lokale paden, geen brondata-lek.
 */

test('de Overzicht-plaat draagt alle vier de lagen en de legenda', () => {
  const html = renderOverzicht();
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

test('de Overzicht-plaat draagt de sanitize-wet, mét de per-sectie-uitzondering', () => {
  const html = renderOverzicht();
  assert.ok(html.includes('Sanitize-wet — wat wél en niet naar buiten gaat'));
  assert.ok(html.includes('alleen bewust samengestelde structuur'));
  assert.ok(html.includes('fail-closed'));
  // De uitzondering staat er expliciet in — geen absolute "nooit", zodat de plaat niet strenger
  // klinkt dan de Regels-pagina (doctrine-consistentie, Codex 24-07-2026).
  assert.ok(html.includes('De enige uitzondering is tekst die per sectie, met de hand'));
  assert.ok(html.includes('Een afgeleid label lekt zijn bron'));
});

test('de Regels-pagina draagt alle tien de wetten', () => {
  const html = renderRegels();
  const wetten = ['Reviewwet', 'Eén schrijver per werkkopie', 'Fail-closed', 'Afgeleid lekt niet',
    'No-loss', 'Eigenaarspoort', 'Gates', 'Rol = tab', 'Richard-vorm', 'Vertaalwet'];
  for (const w of wetten) assert.ok(html.includes(`>${w}</h2>`), `wet "${w}" ontbreekt`);
  // Genummerd 1..10.
  for (let i = 1; i <= 10; i++) assert.ok(html.includes(`>${i}</span>`), `nummer ${i} ontbreekt`);
});

test('geen van beide statische pagina\'s draagt nog een generatedAt-stempel', () => {
  // Een verse tijd op met-de-hand-geschreven inhoud zou verouderde tekst vers laten lijken.
  for (const html of [renderOverzicht(), renderRegels()]) {
    assert.equal(/\bUTC\b/.test(html), false, 'geen UTC-tijdstempel op een statische pagina');
    assert.equal(/vastgelegd:/i.test(html), false, 'geen "vastgelegd:"-stempel');
  }
});

test('de statische pagina\'s draaien geen JavaScript en tonen geen lokaal pad', () => {
  for (const html of [renderOverzicht(), renderRegels()]) {
    assert.equal(/<script/i.test(html), false, 'geen script-tag (hoofdletterongevoelig)');
    assert.equal(html.includes('/Users/'), false, 'geen absoluut pad');
    assert.equal(/\bghp_|\bgithub_pat_|xox[baprs]-/.test(html), false, 'geen tokenvorm');
    assert.ok(html.startsWith('<!doctype html>'), 'volledige HTML-pagina');
    // Strikte CSP staat op elke pagina.
    assert.ok(html.includes("default-src 'none'"), 'CSP ontbreekt');
  }
});

test('de echte leak-gate laat beide pagina\'s door én breekt fail-closed op een geplant lek', () => {
  // Roep de ECHTE geëxporteerde poort aan (geen gekopieerd algoritme): de schone pagina's passeren.
  for (const [naam, html] of [['overzicht', renderOverzicht()], ['regels', renderRegels()]]) {
    assert.doesNotThrow(() => assertStaticPagePublishable(html, naam), `schone pagina ${naam} zou moeten passeren`);
  }
  // Positieve controle — analoog aan de gitleaks-zelftest in publish.yml: een geplant lek MOET de
  // poort laten breken, anders is de poort een placebo.
  const token = `ghp_${'A'.repeat(20)}`;
  assert.throws(() => assertStaticPagePublishable(`<p>een token ${token}</p>`, 'probe-token'),
    /geblokkeerd door leak-scan/, 'een aaneengesloten token moet de poort breken');
  // Door markup onderbroken token: alleen de ZICHTBARE-pass (tags→niets) vangt dit — bewijst dat de
  // documentbewuste tweede pass echt iets toevoegt boven een naïeve regel-voor-regel-scan.
  assert.throws(() => assertStaticPagePublishable(`<p>ghp_<span>${'A'.repeat(20)}</span></p>`, 'probe-split'),
    /geblokkeerd door leak-scan/, 'een door-markup-gesplitst token moet via de zichtbare-pass breken');
  // Home-pad in een attribuut (ruwe pass).
  assert.throws(() => assertStaticPagePublishable('<a href="/Users/iemand/geheim">x</a>', 'probe-pad'),
    /geblokkeerd door leak-scan/, 'een home-pad moet de poort breken');
  // Codex-probes (Fable-tiebreak, bindend): een token verstopt achter een HTML-entity of achter een
  // `>` binnen een attribuutwaarde toont in de browser een geldig token en MOET dus breken.
  const tail = 'A'.repeat(19);
  assert.throws(() => assertStaticPagePublishable(`<p>ghp_&#65;${tail}</p>`, 'probe-entity-dec'),
    /geblokkeerd door leak-scan/, 'decimale-entity-token moet breken');
  assert.throws(() => assertStaticPagePublishable(`<p>ghp_&#x41;${tail}</p>`, 'probe-entity-hex'),
    /geblokkeerd door leak-scan/, 'hex-entity-token moet breken');
  assert.throws(() => assertStaticPagePublishable(`<p>ghp_<span title=">">${'A'.repeat(20)}</span></p>`, 'probe-attr-gt'),
    /geblokkeerd door leak-scan/, 'token achter een > in een attribuutwaarde moet breken');
});

test('de leak-gate vangt een geplante deny-term, ook over markup heen', () => {
  // Exercisert het deny-term-pad expliciet (Codex: de vorige test laadde geen deny-terms).
  const f = join(tmpdir(), 'stack-dashboard-deny-probe.json');
  try {
    writeFileSync(f, JSON.stringify({ terms: ['zephyr'] }), 'utf8');
    loadDenyTerms(f);
    assert.throws(() => assertStaticPagePublishable('<p>klant Zephyr gaat live</p>', 'probe-deny'),
      /geblokkeerd door leak-scan/, 'een deny-term moet de poort breken');
    assert.throws(() => assertStaticPagePublishable('<p>klant Zeph<em>yr</em> live</p>', 'probe-deny-split'),
      /geblokkeerd door leak-scan/, 'een door-markup-gesplitste deny-term moet via de zichtbare-pass breken');
    // Deny-term gesplitst door een tag mét een `>` in de attribuutwaarde (quote-bewuste strip).
    assert.throws(() => assertStaticPagePublishable('<p>klant Zeph<em title=">">yr</em> live</p>', 'probe-deny-attr'),
      /geblokkeerd door leak-scan/, 'deny-term achter een > in een attribuutwaarde moet breken');
    // En de echte pagina's blijven schoon met deze deny-term geladen.
    for (const html of [renderOverzicht(), renderRegels()]) {
      assert.doesNotThrow(() => assertStaticPagePublishable(html, 'schoon'));
    }
  } finally {
    // Herstel de module-state naar de echte (lege) lijst, zodat latere tests niet vervuild raken.
    loadDenyTerms(join(ROOT, 'data/deny-terms.json'));
    rmSync(f, { force: true });
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

test('elke actieve tab markeert zichzelf, en elke tab-href staat op de PUBLISH_ALLOWLIST', () => {
  // Voor elke pagina precies één aria-current, en de actieve tab houdt bewust zijn eigen href.
  for (const [active, href] of [['status', 'index.html'], ['overzicht', 'overzicht.html'], ['regels', 'regels.html']]) {
    const nav = tabNav(active);
    assert.equal((nav.match(/aria-current="page"/g) || []).length, 1, `${active}: precies één actieve tab`);
    assert.match(nav, new RegExp(`href="${href.replace('.', '\\.')}" aria-current="page"`), `${active} markeert zichzelf`);
  }
  // Geen enkele tab mag naar een bestand wijzen dat niet gepubliceerd wordt (dode link / 404).
  const hrefs = [...tabNav('status').matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  for (const href of hrefs) {
    assert.ok(PUBLISH_ALLOWLIST.includes(href), `tab-href "${href}" staat niet op de PUBLISH_ALLOWLIST`);
  }
});
