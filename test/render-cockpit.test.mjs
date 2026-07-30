import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderCockpit } from '../scripts/lib/render-cockpit.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(join(ROOT, 'data/fixture.json'), 'utf8'));

test('rendert een volledige pagina met verversing, CSP en tijdstempel', () => {
  const html = renderCockpit(fixture, { refreshSeconds: 900 });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<meta http-equiv="refresh" content="900; url=\.\/\?v=\d+">/);
  assert.match(html, /content-security-policy/i);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /Laatst bijgewerkt: <strong>gebouwd om 14:00 NL-tijd \(12:00 UTC\)<\/strong>/);
});

test('haalt geen externe bronnen op en draait geen script', () => {
  const html = renderCockpit(fixture);
  assert.equal(/<script/i.test(html), false, 'geen script-tags');
  assert.equal(/(src|href)=["']https?:/i.test(html), false, 'geen externe assets');
});

test('"rood eerst" toont de niet-VERIFIED_CURRENT bron en het ONBEKEND-venster uit de fixture', () => {
  const html = renderCockpit(fixture);
  assert.match(html, /id="rood-eerst"/);
  assert.match(html, /journaal/, 'logbook staat in de fixture op SOURCE_UNAVAILABLE');
  assert.match(html, /ongeverifieerd|bron onbereikbaar/i);
  assert.match(html, /MARKT/, 'MARKT staat in de fixture op ONBEKEND');
  assert.match(html, /stil, stand onbekend/);
});

test('"rood eerst" toont een eerlijke leegmelding zonder enig roodpunt', () => {
  const schoon = structuredClone(fixture);
  schoon.sources = schoon.sources.map((s) => ({ ...s, trust: 'VERIFIED_CURRENT' }));
  schoon.vlootstand.vensters = schoon.vlootstand.vensters.map((v) => ({ ...v, toestand: 'WERKT' }));
  schoon.ci.lights = schoon.ci.lights.map((l) => ({ ...l, state: 'GROEN' }));
  const html = renderCockpit(schoon);
  assert.match(html, /Niets roods/);
});

test('"wat draait" toont het WERKT-venster en de in-bouw-feature uit de fixture', () => {
  const html = renderCockpit(fixture);
  assert.match(html, /id="wat-draait"/);
  assert.match(html, /DASHBOARD/);
  assert.match(html, /Planning-plaat op het dashboard/);
});

test('"wacht op Richard" toont de wacht-op-Richard-feature en de kanaalpost-rij met actie Richard', () => {
  const html = renderCockpit(fixture);
  assert.match(html, /id="wacht-op-richard"/);
  assert.match(html, /Tijdstempel in Nederlandse tijd/);
  assert.match(html, /Twee integratiegaten in het centrale modellenregister gedicht/);
});

test('het afsprakenspoor toont tellers per status en de laatste-wijziging-datum, geen afspraaktekst', () => {
  const html = renderCockpit(fixture);
  assert.match(html, /id="afsprakenspoor"/);
  assert.match(html, /Afsprakenspoor <span class="badge">44<\/span>/);
  assert.match(html, />vastgelegd<[\s\S]*?<span class="tag">3<\/span>/);
  assert.match(html, />uitgezet \(in bak\)<[\s\S]*?<span class="tag">15<\/span>/);
  assert.match(html, />verwerkt<[\s\S]*?<span class="tag">20<\/span>/);
  assert.match(html, />staand<[\s\S]*?<span class="tag">5<\/span>/);
  assert.match(html, /Laatste wijziging: 2026-07-23 09:00 UTC/);
  // Geen enkel veld uit de interne `entries` (id, afspraaktekst, bewijs) hoort op de publieke plaat.
  assert.equal(html.includes('A44'), false);
});

test('het afsprakenspoor toont een eerlijke leegmelding als de bron onbereikbaar is', () => {
  const zonder = structuredClone(fixture);
  zonder.afspraken = {
    available: false,
    statusCounts: { VASTGELEGD: 0, UITGEZET: 0, 'IN BOUW': 0, VERWERKT: 0, STAAND: 0 },
    lastChangedAt: null,
    evidence: { retrievedAt: fixture.generatedAt, trust: 'SOURCE_UNAVAILABLE', errorCode: 'BRON_ONBEREIKBAAR' },
  };
  const html = renderCockpit(zonder);
  assert.match(html, /id="afsprakenspoor"/);
  assert.match(html, /niet leesbaar — geen tellers te tonen/);
});

test('de stackkaart toont de vensters van de fixture met hun echte vlootstand-kleur', () => {
  const html = renderCockpit(fixture);
  assert.match(html, /id="stackkaart"/);
  assert.match(html, /niet de volledige\s*\n?\s*business-lane\/fase-indeling/);
  for (const venster of ['DASHBOARD', 'CONTROL', 'MARKT']) assert.match(html, new RegExp(`>${venster}<`));
});

test('escapet HTML uit bronnen (kanaalpost-onderwerp)', () => {
  const evil = structuredClone(fixture);
  evil.kanaalpost.rows[1].onderwerp = '<img src=x onerror=alert(1)>';
  const html = renderCockpit(evil);
  assert.equal(html.includes('<img src=x'), false);
  assert.match(html, /&lt;img src=x/);
});

test('een nav-snippet wordt vlak na de wrap-opening geïnjecteerd', () => {
  const html = renderCockpit(fixture, { nav: '<nav id="test-nav">naar contentstroom</nav>' });
  assert.match(html, /<div class="wrap">\n<nav id="test-nav">naar contentstroom<\/nav>\n<header>/);
});

test('zonder nav-argument staat er geen lege regel of nav-element in de pagina', () => {
  const html = renderCockpit(fixture);
  assert.equal(html.includes('<nav'), false);
});
