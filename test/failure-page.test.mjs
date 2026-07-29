import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  failurePageHtml,
  classifyServedPage,
  FAILURE_MARKER,
  GITHUB_404_SIGNATURE,
} from '../scripts/failure-page.mjs';

// Gap 2 — de noodpagina krijgt een live-inhouds-test. Stond eerder als heredoc in publish.yml en
// werd door niets bewaakt. Deze test is de poort: sloopt iemand de marker, injecteert brondata of
// leegt de pagina, dan valt hij hier om vóór publicatie.

test('foutpagina is een geldige, volledige HTML-pagina', () => {
  const html = failurePageHtml();
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="nl">/);
  assert.match(html, /<\/html>\s*$/);
  assert.ok(html.length > 400, 'pagina is niet leeg/afgeknot');
});

test('foutpagina draagt de vaste noodpagina-eisen', () => {
  const html = failurePageHtml();
  assert.match(html, /<meta http-equiv="refresh" content="900">/, 'meta-refresh 900s');
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/, 'robots noindex,nofollow');
  assert.ok(html.includes(FAILURE_MARKER), 'unieke marker aanwezig');
  assert.match(html, /Geen actuele stand beschikbaar/, 'menszichtbare kop');
  assert.match(html, /een verouderde groene pagina is misleidender/, 'de kern-uitleg');
});

test('foutpagina bevat GEEN brondata (het hele punt van fail-closed)', () => {
  const html = failurePageHtml();
  // Geen enkel veld uit de echte snapshot mag hier lekken.
  for (const verboden of [
    'overallStatus', 'generatedAt', 'contractVersion', 'sources',
    'trust', 'VERIFIED', 'pullRequests', 'planning', 'workstreams',
  ]) {
    assert.ok(!html.includes(verboden), `foutpagina mag geen brondata-veld "${verboden}" bevatten`);
  }
});

test('foutpagina lijkt NIET op de GitHub-Pages-404', () => {
  const html = failurePageHtml();
  assert.ok(!html.includes(GITHUB_404_SIGNATURE), 'noodpagina bevat nooit de GitHub-404-signatuur');
});

// De discriminatie-logica die de CI-stap `verify-failure` gebruikt. Hier bewezen op alle drie de
// takken, zodat de detectie klopt ook al kan de live-CI-bedrading pas door een échte gefaalde build
// worden uitgeoefend (gepusht is niet live — de logica is wél getest).
// OPDRACHT/DE-PLAAT-MELDT-MAAR-ZEGT-NIET-WAT (2026-07-28): de melding moet de gemeten stap
// noemen i.p.v. drie mogelijkheden op te sommen — maar alleen als de CI dat ook echt meet.
test('zonder info blijft de oude, generieke drie-mogelijkheden-tekst de fallback', () => {
  const html = failurePageHtml();
  assert.match(html, /een test, de sanitize-gate of de secretsscan gaf een fout/);
  assert.ok(html.includes(FAILURE_MARKER), 'marker blijft aanwezig zonder info');
});

test('met info noemt de pagina de gemeten stap en foutlocatie, niet de drie mogelijkheden', () => {
  const html = failurePageHtml({
    step: 'Tests',
    detail: "de echte spiegel voldoet (test/spiegelwet.test.mjs:138:1)",
  });
  assert.match(html, /De stap <strong>Tests<\/strong> is afgebroken/);
  assert.match(html, /test\/spiegelwet\.test\.mjs:138:1/);
  assert.ok(!html.includes('een test, de sanitize-gate of de secretsscan gaf een fout'),
    'de oude drie-mogelijkheden-tekst verdwijnt zodra er een gemeten stap is');
  assert.ok(html.includes(FAILURE_MARKER), 'marker blijft aanwezig mét info');
  assert.equal(classifyServedPage(html), 'noodpagina', 'blijft classificeren als noodpagina');
});

test('info met HTML-gevoelige tekens wordt geëscaped, niet geïnjecteerd', () => {
  const html = failurePageHtml({ step: '<script>kwaad()</script>', detail: 'a & b < c' });
  assert.ok(!html.includes('<script>kwaad()'), 'stapnaam wordt geëscaped');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /a &amp; b &lt; c/);
});

test('zonder bruikbare stapnaam (leeg) blijft de generieke tekst gelden', () => {
  const html = failurePageHtml({ step: '', detail: 'iets' });
  assert.match(html, /een test, de sanitize-gate of de secretsscan gaf een fout/);
});

test('classifyServedPage onderscheidt noodpagina / github-404 / anders', () => {
  assert.equal(classifyServedPage(failurePageHtml()), 'noodpagina');
  assert.equal(
    classifyServedPage(`<html><body><h1>404</h1><p>${GITHUB_404_SIGNATURE}</p></body></html>`),
    'github-404',
  );
  // Een oudere, nog-gecachte datastand is GEEN fout — dat is CDN-lag, niet de 404-gat-toestand.
  assert.equal(
    classifyServedPage('{"overallStatus":"OK","generatedAt":"2026-07-25T00:00:00.000Z"}'),
    'anders',
  );
  assert.equal(classifyServedPage(''), 'anders');
  assert.equal(classifyServedPage(null), 'anders');
});
