import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { renderFeatures, validateProductCatalog } from '../scripts/lib/render-features.mjs';

const catalog = JSON.parse(await readFile(new URL('../data/product-features.json', import.meta.url), 'utf8'));

test('productfeaturecatalogus valideert en bevat brede productdekking', () => {
  assert.equal(validateProductCatalog(catalog), catalog);
  assert.ok(catalog.products.length >= 13);
  const ids = new Set(catalog.products.map((product) => product.id));
  for (const required of ['keynote', 'chief-coa', 'studio-content-factory', 'research-intelligence', 'nq-radar', 'autocoding', 'cockpit']) {
    assert.ok(ids.has(required), `ontbrekend product: ${required}`);
  }
});

test('iedere productfamilie bevat echte featuregroepen en unieke feature-ids', () => {
  const all = [];
  for (const product of catalog.products) {
    assert.ok(product.featureGroups.length > 0, product.id);
    for (const group of product.featureGroups) {
      assert.ok(group.features.length > 0, `${product.id}/${group.id}`);
      all.push(...group.features.map((feature) => feature.id));
    }
  }
  assert.equal(new Set(all).size, all.length);
  assert.ok(all.length >= 80, `te weinig features: ${all.length}`);
});

test('renderer toont drill-down, statussen en veilige tellingen', () => {
  const html = renderFeatures(catalog, { generatedAt: '2026-08-11T06:00:00Z', refreshSeconds: 900, nav: '<nav>terug</nav>' });
  assert.match(html, /Alle producten en features/);
  assert.match(html, /KEYNOTE/);
  assert.match(html, /CHIEF \/ COA/);
  assert.match(html, /Artikel schrijven — long copy/);
  assert.match(html, /Productdetail met alle features/);
  assert.match(html, /onbekend|ontbreekt|gedeeltelijk/);
  assert.match(html, /<details/);
  assert.doesNotMatch(html, /undefined/);
});

test('renderer escaped vrije labels', () => {
  const hostile = structuredClone(catalog);
  hostile.products[0].label = '<img src=x onerror=alert(1)>';
  const html = renderFeatures(hostile, { generatedAt: '2026-08-11T06:00:00Z' });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img/);
});

test('dubbele feature-id faalt gesloten', () => {
  const invalid = structuredClone(catalog);
  invalid.products[1].featureGroups[0].features[0].id = invalid.products[0].featureGroups[0].features[0].id;
  assert.throws(() => validateProductCatalog(invalid), /dubbele feature-id/);
});

test('onbekende status faalt gesloten', () => {
  const invalid = structuredClone(catalog);
  invalid.products[0].featureGroups[0].features[0].state = 'GREENISH';
  assert.throws(() => validateProductCatalog(invalid), /featurestatus/);
});
