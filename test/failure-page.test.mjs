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
