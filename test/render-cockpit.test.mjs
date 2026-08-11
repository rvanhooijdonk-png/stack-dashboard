import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCockpit, renderProducts, renderTicker, ownerGates } from '../scripts/lib/render-cockpit.mjs';
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
  assert.match(html, /PERCENTAGE_ONBEKEND/);
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

test('accountcapaciteit toont elk venster met kleur, telling en meettijdstip', () => {
  const html = renderCockpit(snapshot, { products, ticker });
  assert.match(html, /<section id="accountcapaciteit"/);
  assert.match(html, /1 werkt · 1 leeg · 1 onbekend/);
  assert.match(html, /DASHBOARD[\s\S]*?WERKT[\s\S]*?laatst gemeld 2026-07-26 09:16/);
  assert.match(html, /MARKT[\s\S]*?ONBEKEND[\s\S]*?nooit gemeld/);
  assert.match(html, /een venster stiller dan 240 min geldt als ONBEKEND, nooit als groen/);
});

test('accountcapaciteit zonder vlootstandbron is UNKNOWN, nooit een lege nulstand', () => {
  const missing = structuredClone(snapshot); missing.vlootstand = { available: false, reason: 'BRON_ONBEREIKBAAR' };
  const html = renderCockpit(missing, { products, ticker });
  assert.match(html, /<section id="accountcapaciteit"[\s\S]*?UNKNOWN — vlootstandbron niet beschikbaar/);
  assert.doesNotMatch(html, /0 werkt · 0 leeg · 0 onbekend/);
});

test('een wacht-op-Richard-feature blijft een ownerpoort, ook met een inconsistente of ontbrekende worker', () => {
  const inconsistent = structuredClone(snapshot);
  const feature = inconsistent.planning.features.find((f) => f.status === 'wacht-op-Richard');
  feature.worker = null;
  const html = renderCockpit(inconsistent, { products: buildProductModel(canon, inconsistent), ticker });
  assert.match(html, /Tijdstempel in Nederlandse tijd/);
  assert.match(html, /worker UNKNOWN/);
  assert.doesNotMatch(html, /Alle drie de ownerbronnen zijn gelezen; er staat geen gevalideerde ownerpoort open\./);
});

test('verouderde planningspiegel toont Nu actief nooit als groen actueel', () => {
  const stale = structuredClone(snapshot);
  stale.planning.bron.spiegelAt = '2026-07-01T00:00:00.000Z';
  const html = renderCockpit(stale, { products: buildProductModel(canon, stale), ticker });
  const section = html.slice(html.indexOf('<section id="nu-actief"'), html.indexOf('<section id="vandaag-geleverd"'));
  assert.match(section, /dot warn/);
  assert.match(section, /planning STALE — status kan achterlopen/);
  assert.doesNotMatch(section, /dot ok/);
});

test('planningfeature in-bouw zonder workerrol blijft zichtbaar in Nu actief, zonder verzonnen rol', () => {
  const noWorker = structuredClone(snapshot);
  const feature = noWorker.planning.features.find((f) => f.status === 'in-bouw');
  feature.worker = null;
  const html = renderCockpit(noWorker, { products: buildProductModel(canon, noWorker), ticker });
  assert.match(html, /Planning-plaat op het dashboard/);
  assert.match(html, /actor UNKNOWN · starttijd UNKNOWN · heartbeat UNKNOWN/);
  assert.doesNotMatch(html, /Planning-plaat op het dashboard[^<]*<\/span> <span class="muted">in-bouw · rol/);
});

test('dubbele kanaalpost-ownergates op dezelfde melding worden één keer getoond', () => {
  const dup = structuredClone(snapshot);
  const row = dup.kanaalpost.rows.find((r) => /richard/i.test(r.actie ?? '')) ?? {
    tab: 'CONTROL', onderwerp: 'Zelfde besluit twee keer gemeld', status: 'WACHT OP AKKOORD', actie: 'richard beslist', datum: '2026-07-26 09:16',
  };
  dup.kanaalpost.rows.push({ ...row }, { ...row });
  const { gates } = ownerGates(dup);
  const matching = gates.filter((g) => g.label === row.onderwerp);
  assert.equal(matching.length, 1, 'dezelfde ownergate mag maar één keer in de lijst staan');
});

test('twee verschillende ownerbesluiten met hetzelfde onderwerp op andere datum blijven allebei zichtbaar', () => {
  const dup = structuredClone(snapshot);
  const base = { tab: 'CONTROL', onderwerp: 'Zelfde onderwerp, ander besluit', status: 'WACHT OP AKKOORD', actie: 'richard beslist' };
  dup.kanaalpost.rows.push({ ...base, datum: '2026-07-25 09:00' }, { ...base, datum: '2026-07-26 09:16' });
  const { gates } = ownerGates(dup);
  const matching = gates.filter((g) => g.label === base.onderwerp);
  assert.equal(matching.length, 2, 'verschillende datums zijn verschillende besluiten, geen duplicaat');
});

test('hostile HTML in venstername, ownergate-onderwerp en featurelabel wordt overal geëscaped', () => {
  const hostile = structuredClone(snapshot);
  hostile.vlootstand.vensters[0].venster = '<img src=x onerror=alert(1)>';
  hostile.kanaalpost.rows.push({ tab: 'CONTROL', onderwerp: '<script>alert(2)</script>', status: 'WACHT OP AKKOORD', actie: 'richard beslist', datum: '2026-07-26 09:16' });
  hostile.planning.features.find((f) => f.status === 'in-bouw').label = '<svg onload=alert(3)>';
  const html = renderCockpit(hostile, { products: buildProductModel(canon, hostile), ticker });
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.doesNotMatch(html, /<script>alert\(2\)/);
  assert.doesNotMatch(html, /<svg onload=alert\(3\)>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
});

test('unicode en zeer lange operationele tekst breekt de rendering niet', () => {
  const wild = structuredClone(snapshot);
  const long = 'Ω'.repeat(2000) + ' — 长文本 · émoji 🚀 · null-byte-tekst';
  wild.planning.features.find((f) => f.status === 'in-bouw').label = long;
  const html = renderCockpit(wild, { products: buildProductModel(canon, wild), ticker });
  assert.match(html, /Ω{2000}/);
  assert.match(html, /🚀/);
});

test('cockpit-HTML bevat geen inline event-handlers of positieve tabindex — puur navigeerbaar via links', () => {
  const html = renderCockpit(snapshot, { products, ticker });
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /tabindex\s*=\s*["']?[1-9]/i);
});

test('de mobiele media query dekt ook de nieuwe accountcapaciteit-lijst', () => {
  const html = renderCockpit(snapshot, { products, ticker });
  const media = html.match(/@media \(max-width:42rem\)\{[^}]*\}[^}]*\}/);
  assert.ok(media, 'mobiele media query ontbreekt');
  assert.match(html, /@media \(max-width:42rem\)[\s\S]*capacity-list/);
});
