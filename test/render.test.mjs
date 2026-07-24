import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderHtml, esc } from '../scripts/lib/render.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(join(ROOT, 'data/fixture.json'), 'utf8'));

test('rendert een volledige pagina met verversing en tijdstempel', () => {
  const html = renderHtml(fixture, { refreshSeconds: 900 });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<meta http-equiv="refresh" content="900">/);
  assert.match(html, /Laatst bijgewerkt/);
  assert.match(html, /2026-07-23 12:00 UTC/);
});

test('toont een onbereikbare bron als zodanig, niet als groen', () => {
  const html = renderHtml(fixture);
  assert.match(html, /bron onbereikbaar/);
  assert.match(html, /Een onbereikbare bron toont hier nooit een oude groene stand/);
});

test('haalt geen externe bronnen op en draait geen script', () => {
  const html = renderHtml(fixture);
  assert.equal(/<script/i.test(html), false, 'geen script-tags');
  assert.equal(/https?:\/\/(?!github\.com)/i.test(html.replace(/<style>[\s\S]*?<\/style>/, '')), false,
    'geen externe hosts buiten github.com-bronverwijzingen');
  assert.equal(/(src|href)=["']https?:/i.test(html), false, 'geen externe assets');
});

test('escapet HTML uit bronnen', () => {
  const evil = structuredClone(fixture);
  evil.tracker.updates[0].title = '<img src=x onerror=alert(1)>';
  const html = renderHtml(evil);
  assert.equal(html.includes('<img src=x'), false);
  assert.match(html, /&lt;img src=x/);
});

test('esc dekt alle vijf de tekens', () => {
  assert.equal(esc(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
});

test('rendert de roadmapsectie met de workstreams', () => {
  const html = renderHtml(fixture);
  assert.match(html, /Roadmap — 19 workstreams/);
  assert.match(html, /Voorbeeldworkstream/);
});

test('rendert alle CI-ampeltoestanden zonder te breken', () => {
  const html = renderHtml(fixture);
  assert.match(html, /dot ok/);
  assert.match(html, /geen CI/);
});

// --- Bevindingen uit de dubbele review van 23-07-2026 (Codex + Gemini) ---

test('een "getal" dat stiekem HTML is, komt er niet in — bewezen probe van Codex', () => {
  const evil = structuredClone(fixture);
  evil.pullRequests.repositories[0].open = '</td><script>alert(1)</script><td>';
  evil.pullRequests.totals.open = '</p><script>alert(2)</script><p>';
  const html = renderHtml(evil);
  assert.equal(/<script/i.test(html), false, 'numerieke velden moeten door num() gaan');
});

test('refreshSeconds kan geen meta-tag-injectie worden', () => {
  const html = renderHtml(fixture, { refreshSeconds: '0; url=javascript:alert(1)' });
  assert.equal(html.includes('javascript:'), false);
  assert.match(html, /<meta http-equiv="refresh" content="900">/);
});

test('draagt een restrictieve CSP', () => {
  const html = renderHtml(fixture);
  assert.match(html, /content-security-policy/i);
  assert.match(html, /default-src 'none'/);
});

test('waarschuwt zichtbaar dat een oude stempel betekent dat er niets gepubliceerd is', () => {
  // Stond hier eerst als "ouder dan een uur betekent dat de build stukstaat". Dat is gemeten
  // onwaar: de geplande kwartierrun van GitHub vuurt hier niet (drie slots achter elkaar
  // overgeslagen), dus een oude stempel zegt alleen dat er sindsdien niet gepubliceerd is.
  const html = renderHtml(fixture);
  assert.match(html, /er is sindsdien niets gepubliceerd/i);
});

test('de pagina belooft geen verversingsinterval dat we niet waarmaken', () => {
  // De stempelregel mag zeggen dat de bróuwser opnieuw ophaalt — dat doet de meta-refresh echt.
  // Ze mag niet suggereren dat de dáta elk kwartier ververst, want dat hangt aan een scheduler
  // die hier niet betrouwbaar draait. De lijst met verboden formuleringen staat in
  // data/verboden-beloftes.json en wordt in publiekepaginas.test.mjs op béide publieke pagina's
  // toegepast; hier staat alleen wat deze pagina in de plaats zegt.
  const html = renderHtml(fixture);
  assert.match(html, /niet op een gegarandeerd interval/i);
  assert.match(html, /bij elke push naar main en bij een handmatige run/i);
});

test('meldt verborgen repo\'s in plaats van ze bij naam te noemen', () => {
  const html = renderHtml(fixture);
  assert.match(html, /2 PR's staan in repo's die niet bij naam getoond worden/);
});

// --- Bevindingen uit de tweede dubbele review van 23-07-2026 (Codex + Gemini) ---

test('zegt zichtbaar dát de titels ingehouden zijn — geen stille leegte', () => {
  const html = renderHtml(fixture);
  assert.match(html, /Titels worden hier niet getoond/);
  assert.match(html, /de structuur — nummers, ID's, datums en aantallen/);
});

test('een ingehouden titel wordt een streepje, geen "null"', () => {
  const html = renderHtml(fixture);
  assert.equal(/>\s*null\s*</.test(html), false, 'null mag nooit als tekst op de pagina staan');
});

// --- v2.1 (24-07-2026): tracks-blok (klaar-rapport-leeftijd) + categoriechips ---

test('het tracks-blok toont leeftijd en telling, en "geen rapport" als eerlijke leegte', () => {
  const html = renderHtml(fixture);
  assert.match(html, /Tracks — leeftijd laatste klaar-rapport/);
  assert.match(html, /VOORBEELD/);
  assert.match(html, /ZONDER-RAPPORT/);
  // De track zonder rapport toont geen groen en geen datum, maar een expliciete leegte.
  assert.match(html, /geen rapport/);
});

test('rendert het afgeleide categorielabel als chip, ook bij ingehouden tekst', () => {
  const html = renderHtml(fixture);
  // fixture: beslispunt-categorie 'merge-beleid', besluit-categorie 'security'.
  assert.match(html, /tag cat">merge-beleid</);
  assert.match(html, /tag cat">security</);
});

test('een categorielabel wordt geëscaped als tekst, nooit als markup uitgevoerd', () => {
  const evil = structuredClone(fixture);
  evil.decisions.entries[0].category = '<b>x</b>';
  const html = renderHtml(evil);
  assert.equal(html.includes('<b>x</b>'), false);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
});
