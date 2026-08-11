import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCockpit, renderProducts, renderTicker } from '../scripts/lib/render-cockpit.mjs';
import { buildProductModel, lifecycleEvents, validateProductCanon } from '../scripts/lib/product-model.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const snapshot = JSON.parse(await readFile(join(ROOT, 'data/fixture.json'), 'utf8'));
const canon = JSON.parse(await readFile(join(ROOT, 'data/product-canon.json'), 'utf8'));
const products = buildProductModel(canon, snapshot);
const ticker = lifecycleEvents(snapshot);

test('hoofdpagina bevat uitsluitend de zeven afgesproken hoofdsecties', () => {
  const html = renderCockpit(snapshot, { products, ticker });
  const ids = [...html.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['wacht-op-richard', 'nu-actief', 'vandaag-geleverd', 'producten', 'incidenten', 'accountcapaciteit', 'laatste-ticker-events']);
});

test('cockpit is semantische, mobiele, scriptloze HTML', () => {
  const html = renderCockpit(snapshot, { products, ticker });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /name="viewport" content="width=device-width,initial-scale=1"/);
  assert.match(html, /<header>[\s\S]*<main>[\s\S]*<footer>/);
  assert.equal(/<script/i.test(html), false);
  assert.equal(/(src|href)=["']https?:/i.test(html), false);
});

test('ontbrekende planning is UNKNOWN en nooit groen of een nulstand', () => {
  const missing = structuredClone(snapshot); missing.planning.available = false; missing.planning.features = [];
  const html = renderCockpit(missing, { products: buildProductModel(canon, missing), ticker });
  assert.match(html, /UNKNOWN — planningbron niet beschikbaar/);
  assert.doesNotMatch(html, /0 actief|0 geleverd|alles groen/i);
});

test('alle hoofdproducten en alle canonieke features staan op de drill-down', () => {
  const html = renderProducts(snapshot, products);
  for (const p of canon.products) {
    assert.match(html, new RegExp(`id="${p.id}"`));
    for (const f of p.features) assert.ok(html.includes(f), `${p.name}: ${f}`);
  }
  for (const label of ['Fase', 'Echt af', 'Nu', 'Volgende mijlpaal', 'Blocker', 'Freshness', 'Evidence']) assert.ok(html.includes(label));
});

test('percentage verschijnt alleen met een volledig bekende canonieke noemer', () => {
  const html = renderProducts(snapshot, products);
  assert.match(html, /percentage ingehouden zolang fasen UNKNOWN zijn/);
  assert.doesNotMatch(html, /geleverd \d+%/);
});

test('stale planning wordt zichtbaar en nooit CURRENT', () => {
  const stale = structuredClone(snapshot); stale.generatedAt = '2026-08-11T12:00:00.000Z';
  const model = buildProductModel(canon, stale);
  const observed = model.products.find((p) => p.id === 'cockpit').features.find((f) => f.name === 'Planning-plaat op het dashboard');
  assert.equal(observed.freshness, 'STALE');
});

test('dubbele productfacts en hostile canonstrings worden fail-closed geweigerd', () => {
  const duplicate = structuredClone(canon); duplicate.products[0].features.push(duplicate.products[0].features[0]);
  assert.throws(() => validateProductCanon(duplicate), /dubbele feature/);
  const hostile = structuredClone(canon); hostile.products[0].features[0] = '<img src=x onerror=alert(1)>';
  assert.throws(() => validateProductCanon(hostile), /ongeldig label/);
});

test('hostile operationele tekst wordt bij rendering geëscaped', () => {
  const hostile = structuredClone(ticker); hostile.events[0].summary = '<img src=x onerror=alert(1)>';
  const html = renderTicker(snapshot, hostile);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
});

test('ticker toont gevalideerde lifecycle, stale en expliciet niet-realtime', () => {
  const staleSnapshot = structuredClone(snapshot); staleSnapshot.generatedAt = '2026-08-11T12:00:00.000Z';
  const data = lifecycleEvents(staleSnapshot);
  const html = renderTicker(staleSnapshot, data);
  assert.equal(data.freshness, 'STALE');
  assert.match(html, /GELEVERD|GEBLOKKEERD/);
  assert.match(html, /nooit realtime/);
});

test('ticker met ontbrekende bron heeft UNKNOWN en geen verzonnen events', () => {
  const missing = structuredClone(snapshot); missing.kanaalpost.available = false;
  assert.deepEqual(lifecycleEvents(missing), { freshness: 'UNKNOWN', events: [] });
});
