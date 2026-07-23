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
