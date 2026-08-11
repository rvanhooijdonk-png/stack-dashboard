/**
 * PRODUCTEN & FEATURES — volledige drill-down naast de rustige cockpit.
 *
 * Deze module ontvangt uitsluitend het gecureerde, gesloten productfeaturecontract.
 * Geen netwerk, geen vrije bronfetch en geen HTML uit de data. Alles wordt ge-escaped.
 */

import { buildStamp, esc, STYLE, titelStamp } from './render.mjs';

const STATES = new Set(['WORKING', 'BUILT', 'PARTIAL', 'MISSING', 'UNKNOWN', 'STALE', 'BLOCKED']);
const LIFECYCLES = new Set(['DISCOVERY', 'BUILD', 'PILOT', 'LIVE', 'RECOVERY', 'UNKNOWN']);
const FRESHNESS = new Set(['CURRENT', 'STALE', 'UNMEASURED', 'CONFLICTING']);
const CATEGORIES = new Set(['PRODUCT', 'KNOWLEDGE', 'PLATFORM', 'OPERATIONS']);
const ID_RE = /^[a-z0-9][a-z0-9-]{2,79}$/;
const EVIDENCE_RE = /^[A-Z0-9][A-Z0-9._-]{2,99}$/;

const text = (value, label, max = 120) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    throw new Error(`productfeaturecontract: ${label} is ongeldig`);
  }
  return value;
};

const id = (value, label) => {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new Error(`productfeaturecontract: ${label} heeft geen geldige id`);
  }
  return value;
};

function unique(values, label) {
  if (new Set(values).size !== values.length) {
    throw new Error(`productfeaturecontract: dubbele ${label}`);
  }
}

/** Strikte tweede poort naast JSON Schema: ids zijn catalogusbreed uniek. */
export function validateProductCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new Error('productfeaturecontract: root moet een object zijn');
  }
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.products) || catalog.products.length === 0) {
    throw new Error('productfeaturecontract: versie of producten ontbreekt');
  }
  if (!['PARTIAL', 'VERIFIED_CURRENT', 'STALE', 'CONFLICTING_EVIDENCE'].includes(catalog.catalogStatus)) {
    throw new Error('productfeaturecontract: catalogStatus is ongeldig');
  }

  const productIds = [];
  const featureIds = [];
  for (const product of catalog.products) {
    if (!product || typeof product !== 'object' || Array.isArray(product)) {
      throw new Error('productfeaturecontract: product moet object zijn');
    }
    productIds.push(id(product.id, 'product'));
    text(product.label, 'productlabel', 100);
    text(product.source, 'source', 120);
    if (!CATEGORIES.has(product.category) || !LIFECYCLES.has(product.lifecycle)
      || !FRESHNESS.has(product.freshness) || !STATES.has(product.status)) {
      throw new Error(`productfeaturecontract: gesloten waarden wijken af voor ${product.id}`);
    }
    if (typeof product.evidenceId !== 'string' || !EVIDENCE_RE.test(product.evidenceId)) {
      throw new Error(`productfeaturecontract: evidenceId wijkt af voor ${product.id}`);
    }
    if (!Array.isArray(product.featureGroups) || product.featureGroups.length === 0) {
      throw new Error(`productfeaturecontract: featureGroups ontbreken voor ${product.id}`);
    }
    const groupIds = [];
    for (const group of product.featureGroups) {
      groupIds.push(id(group.id, 'featuregroep'));
      text(group.label, 'featuregroeplabel', 100);
      if (!Array.isArray(group.features) || group.features.length === 0) {
        throw new Error(`productfeaturecontract: lege featuregroep ${group.id}`);
      }
      const localFeatureIds = [];
      for (const feature of group.features) {
        const featureId = id(feature.id, 'feature');
        localFeatureIds.push(featureId);
        featureIds.push(featureId);
        text(feature.label, 'featurelabel', 100);
        if (!STATES.has(feature.state)) {
          throw new Error(`productfeaturecontract: featurestatus wijkt af voor ${featureId}`);
        }
      }
      unique(localFeatureIds, `feature-id in ${group.id}`);
    }
    unique(groupIds, `featuregroep-id in ${product.id}`);
  }
  unique(productIds, 'product-id');
  unique(featureIds, 'feature-id in volledige catalogus');
  return catalog;
}

const stateClass = (state) => ({
  WORKING: 'ok',
  BUILT: 'ok',
  PARTIAL: 'warn',
  MISSING: 'bad',
  UNKNOWN: 'warn',
  STALE: 'warn',
  BLOCKED: 'bad',
}[state] ?? 'warn');

const stateLabel = (state) => ({
  WORKING: 'werkt',
  BUILT: 'gebouwd',
  PARTIAL: 'gedeeltelijk',
  MISSING: 'ontbreekt',
  UNKNOWN: 'onbekend',
  STALE: 'verouderd',
  BLOCKED: 'geblokkeerd',
}[state] ?? state);

function featureRow(feature) {
  return `<li><span class="dot ${stateClass(feature.state)}"></span><span class="repo">${esc(feature.label)}</span><span class="muted">${esc(stateLabel(feature.state))}</span></li>`;
}

function productCard(product) {
  const groups = product.featureGroups.map((group) => `<section class="featuregroup">
    <h3>${esc(group.label)} <span class="badge">${group.features.length}</span></h3>
    <ul class="lights">${group.features.map(featureRow).join('\n')}</ul>
  </section>`).join('\n');
  const total = product.featureGroups.reduce((sum, group) => sum + group.features.length, 0);
  return `<details class="card wide productfeatures" id="product-${esc(product.id)}">
  <summary><strong>${esc(product.label)}</strong> <span class="badge ${stateClass(product.status)}">${esc(stateLabel(product.status))}</span> <span class="muted">${total} features · ${esc(product.lifecycle.toLowerCase())} · ${esc(product.freshness.toLowerCase())}</span></summary>
  <p class="muted">Bron: ${esc(product.source)} · bewijs-id: <code>${esc(product.evidenceId)}</code></p>
  ${groups}
</details>`;
}

export function renderFeatures(catalog, { generatedAt, refreshSeconds = 900, nav = '' } = {}) {
  validateProductCatalog(catalog);
  const stamp = generatedAt ?? new Date().toISOString();
  const refresh = Math.min(3600, Math.max(60, Math.trunc(Number(refreshSeconds)) || 900));
  const products = catalog.products.map(productCard).join('\n');
  const featureCount = catalog.products.reduce(
    (sum, product) => sum + product.featureGroups.reduce((n, group) => n + group.features.length, 0),
    0,
  );

  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${refresh}">
<meta name="robots" content="noindex,nofollow">
<meta http-equiv="content-security-policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
<title>Alle producten en features — ${esc(titelStamp(stamp))}</title>
<style>${STYLE}
.productfeatures summary{cursor:pointer;padding:.35rem 0}.productfeatures[open] summary{margin-bottom:1rem}.featuregroup{margin:1rem 0;padding-top:.5rem;border-top:1px solid rgba(255,255,255,.08)}.featuregroup h3{display:flex;gap:.6rem;align-items:center}.productmeta{margin-bottom:1.2rem}</style>
</head>
<body>
<div class="wrap">
${nav ? `${nav}\n` : ''}<header>
  <h1>Alle producten en features</h1>
  <p class="stamp">Laatst bijgewerkt: <strong>${esc(buildStamp(stamp))}</strong> · ${catalog.products.length} producten · ${featureCount} features</p>
  <p class="lead productmeta">Volledige drill-down. De hoofdcockpit blijft compact; hier staat per onderdeel wat werkt, gedeeltelijk is, ontbreekt of nog niet vers is gemeten.</p>
</header>
${products}
<footer>Gecureerde, publieke featurecatalogus. Een onbekende of verouderde status wordt nooit als groen weergegeven.</footer>
</div>
</body>
</html>`;
}
