import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCockpit, renderProducts, renderTicker, ownerGates, activeWork } from '../scripts/lib/render-cockpit.mjs';
import { buildProductModel, lifecycleEvents, validateProductCanon } from '../scripts/lib/product-model.mjs';
import { renderHtml } from '../scripts/lib/render.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const snapshot = JSON.parse(await readFile(join(ROOT, 'data/fixture.json'), 'utf8'));
const canon = JSON.parse(await readFile(join(ROOT, 'data/product-canon.json'), 'utf8'));
const products = buildProductModel(canon, snapshot);
const ticker = lifecycleEvents(snapshot);

test('hoofdpagina bevat uitsluitend de zeven rustige hoofdsecties', () => {
  const html = renderCockpit(snapshot, { products, ticker });
  const ids = [...html.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['wacht-op-richard', 'nu-actief', 'vandaag-geleverd', 'producten', 'incidenten', 'accountcapaciteit', 'laatste-ticker-events']);
});

test('cockpit is semantische, mobiele, scriptloze HTML', () => {
  const html = renderCockpit(snapshot, { products, ticker });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /name="viewport" content="width=device-width,initial-scale=1"/);
  assert.match(html, /@media \(max-width:42rem\)/);
  assert.match(html, /<header>[\s\S]*<main>[\s\S]*<footer>/);
  assert.match(html, /aria-label="Hoofdnavigatie"/);
  assert.equal(/<script/i.test(html), false);
  assert.equal(/(src|href)=["']https?:/i.test(html), false);
});

test('elke statische pagina ververst naar zichzelf en niet terug naar de cockpit', () => {
  assert.match(renderCockpit(snapshot, { products, ticker }), /content="900; url=\.\/\?v=\d+"/);
  assert.match(renderProducts(snapshot, products), /content="900; url=\.\/producten\.html\?v=\d+"/);
  assert.match(renderTicker(snapshot, ticker), /content="900; url=\.\/stack-ticker\.html\?v=\d+"/);
  assert.match(renderHtml(snapshot, { pagePath: './contentstroom.html' }), /content="900; url=\.\/contentstroom\.html\?v=\d+"/);
});

test('ontbrekende planning is UNKNOWN en nooit groen of een nulstand', () => {
  const missing = structuredClone(snapshot); missing.planning.available = false; missing.planning.features = [];
  const html = renderCockpit(missing, { products: buildProductModel(canon, missing), ticker });
  assert.match(html, /UNKNOWN — planningbron niet beschikbaar/);
  assert.doesNotMatch(html, /0 actief|0 geleverd|alles groen/i);
});

test('onbekende vlootlanes staan eenmaal geaggregeerd op de rustige hoofdpagina', () => {
  const input = structuredClone(snapshot);
  input.vlootstand.vensters.push({ venster: 'TWEEDE', toestand: 'ONBEKEND', rol: null });
  const html = renderCockpit(input, { products, ticker });
  assert.match(html, /2 vlootlanes/);
  assert.match(html, /details op technische drill-down/);
  assert.doesNotMatch(html, />MARKT<|>TWEEDE</);
});

test('Wacht op Richard bevat alleen expliciete owner-gates', () => {
  const result = ownerGates(snapshot);
  assert.equal(result.unavailable.length, 0);
  assert.equal(result.gates.length, 3, 'PR-merge, planning-ownerpoort en kanaalpost-ownerpoort');
  assert.ok(result.gates.some((gate) => gate.label.includes('open pull request')));
  assert.ok(result.gates.some((gate) => gate.label === 'Tijdstempel in Nederlandse tijd'));
  assert.ok(result.gates.some((gate) => gate.label.includes('integratiegaten')));
});

test('een wachtstatus zonder owner, afhankelijkheid of akkoordactie is geen owner-gate', () => {
  const input = structuredClone(snapshot);
  input.planning.features.push({ label: 'Geen echte ownerpoort', status: 'wacht-op-Richard', worker: null, afhankelijkheid: null });
  input.kanaalpost.rows.push({ tab: 'CONTROL', onderwerp: 'Alleen geblokkeerd', status: 'GEBLOKKEERD', actie: 'worker', datum: '2026-07-25 20:12' });
  assert.equal(ownerGates(input).gates.some((gate) => gate.label === 'Geen echte ownerpoort'), false);
  assert.equal(ownerGates(input).gates.some((gate) => gate.label === 'Alleen geblokkeerd'), false);
});

test('waarnemer-zelfmeldingen bezetten de ownerpoort niet', async () => {
  const { ALARM_KOP } = await import('../scripts/lib/waarnemer.mjs');
  const input = structuredClone(snapshot);
  input.kanaalpost.rows.push({
    tab: 'WAARNEMER', onderwerp: `${ALARM_KOP.replace(/\*/g, '')} de plaat wijkt af.`,
    status: 'WACHT OP AKKOORD', actie: 'Richard', datum: '2026-07-25 20:12',
  });
  assert.equal(ownerGates(input).gates.some((gate) => gate.label.includes('plaat wijkt af')), false);
});

test('uitgevallen ownerbronnen blijven UNKNOWN en tellen niet als gate', () => {
  const input = structuredClone(snapshot);
  input.pullRequests.available = false;
  input.planning.available = false;
  const result = ownerGates(input);
  assert.equal(result.unavailable.length, 2);
  const html = renderCockpit(input, { products, ticker });
  assert.match(html, /2 bronnen UNKNOWN/);
  assert.match(html, /geen meting — geen nulstand/);
});

test('Nu actief wordt niet groen zonder worker, actor, start en verse heartbeat', () => {
  const state = activeWork(snapshot);
  assert.equal(state.active.length, 0);
  assert.equal(state.incomplete, 1, 'fixture heeft één in-bouwregel zonder volledig bewijs');
  const html = renderCockpit(snapshot, { products, ticker });
  const section = html.slice(html.indexOf('id="nu-actief"'), html.indexOf('id="vandaag-geleverd"'));
  assert.doesNotMatch(section, /dot ok/);
  assert.match(section, /worker, actor, start of verse heartbeat ontbreekt/);
});

test('Nu actief wordt pas groen met geordend en vers volledig bewijs', () => {
  const input = structuredClone(snapshot);
  input.generatedAt = '2026-07-23T12:00:00.000Z';
  const feature = input.planning.features.find((item) => item.status === 'in-bouw');
  Object.assign(feature, { actor: 'CODEX1', startedAt: '2026-07-23T11:00:00.000Z', heartbeatAt: '2026-07-23T11:50:00.000Z' });
  assert.equal(activeWork(input).active.length, 1);
  const html = renderCockpit(input, { products, ticker });
  const section = html.slice(html.indexOf('id="nu-actief"'), html.indexOf('id="vandaag-geleverd"'));
  assert.match(section, /dot ok/);
  assert.match(section, /CODEX1/);
});

test('een stale heartbeat levert nooit groene ontwikkelstatus', () => {
  const input = structuredClone(snapshot);
  const feature = input.planning.features.find((item) => item.status === 'in-bouw');
  Object.assign(feature, { actor: 'CODEX1', startedAt: '2026-07-23T10:00:00.000Z', heartbeatAt: '2026-07-23T11:00:00.000Z' });
  assert.equal(activeWork(input).active.length, 0);
  assert.equal(activeWork(input).incomplete, 1);
});

test('alle hoofdproducten en exact hun canonieke features staan op de drill-down', () => {
  const html = renderProducts(snapshot, products);
  assert.equal(products.products.length, canon.products.length);
  for (const p of canon.products) {
    const model = products.products.find((item) => item.id === p.id);
    assert.equal(model.denominator, p.features.length);
    assert.equal(model.features.length, p.features.length, `${p.name} houdt exact de canonieke noemer`);
    assert.match(html, new RegExp(`id="${p.id}"`));
    for (const feature of p.features) assert.ok(html.includes(feature), `${p.name}: ${feature}`);
  }
  for (const label of ['Fase', 'Echt af', 'Nu', 'Volgende mijlpaal', 'Blocker', 'Freshness', 'Evidence']) assert.ok(html.includes(label));
});

test('productstatus blijft UNKNOWN en toont geen fictief percentage', () => {
  const html = renderProducts(snapshot, products);
  assert.match(html, /Freshness: UNKNOWN/);
  assert.match(html, /statuspercentages worden niet berekend/);
  assert.doesNotMatch(html, /geleverd \d+%|bekend \d+%/);
});

test('dubbele feature-identiteit, extra velden en hostile canon worden fail-closed geweigerd', () => {
  const duplicate = structuredClone(canon); duplicate.products[0].features.push('Dagelijkse-cockpit');
  duplicate.products[0].features[0] = 'Dagelijkse cockpit';
  assert.throws(() => validateProductCanon(duplicate), /dubbele feature-identiteit/);
  const extra = structuredClone(canon); extra.products[0].status = 'groen';
  assert.throws(() => validateProductCanon(extra), /onbekende velden/);
  const hostile = structuredClone(canon); hostile.products[0].features[0] = '<img src=x onerror=alert(1)>';
  assert.throws(() => validateProductCanon(hostile), /ongeldig label/);
});

test('hostile operationele tekst wordt op elke renderer als tekst geëscaped', () => {
  const hostileTicker = structuredClone(ticker); hostileTicker.events[0].summary = '<img src=x onerror=alert(1)>';
  const tickerHtml = renderTicker(snapshot, hostileTicker);
  assert.match(tickerHtml, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(tickerHtml, /<img src=x/);
  const hostileSnapshot = structuredClone(snapshot);
  hostileSnapshot.planning.features.find((item) => item.status === 'wacht-op-Richard').afhankelijkheid = '<svg onload=alert(1)>';
  const cockpitHtml = renderCockpit(hostileSnapshot, { products, ticker });
  assert.match(cockpitHtml, /&lt;svg onload=alert\(1\)&gt;/);
  assert.doesNotMatch(cockpitHtml, /<svg onload/);
});

test('lange tickertekst kan op mobiel breken zonder inhoud af te kappen', () => {
  const html = renderTicker(snapshot, ticker);
  assert.match(html, /\.ticker li\{[^}]*overflow-wrap:anywhere/);
  assert.ok(html.includes(ticker.events[0].summary));
});

test('ticker toont alle gesloten lifecyclewaarden, sorteert en dedupliceert', () => {
  const input = structuredClone(snapshot);
  input.generatedAt = '2026-08-11T12:00:00.000Z';
  input.kanaalpost.rows = [
    { tab: 'CONTROL', onderwerp: 'Geblokkeerd feit', status: 'GEBLOKKEERD', actie: 'niemand', datum: '2026-07-26 10:00' },
    { tab: 'CONTROL', onderwerp: 'Geblokkeerd feit', status: 'GEBLOKKEERD', actie: 'niemand', datum: '2026-07-26 10:00' },
    ...input.kanaalpost.rows,
  ];
  const data = lifecycleEvents(input);
  assert.equal(data.events.filter((event) => event.summary === 'Geblokkeerd feit').length, 1);
  assert.equal(data.events[0].lifecycle, 'GEBLOKKEERD');
  assert.equal(data.freshness, 'STALE');
});

test('ticker met ontbrekende, lege of ongeldige bron is UNKNOWN en verzint geen events', () => {
  const missing = structuredClone(snapshot); missing.kanaalpost.available = false;
  assert.deepEqual(lifecycleEvents(missing), { freshness: 'UNKNOWN', events: [] });
  const empty = structuredClone(snapshot); empty.kanaalpost.rows = [];
  assert.deepEqual(lifecycleEvents(empty), { freshness: 'UNKNOWN', events: [] });
  const invalid = structuredClone(snapshot); invalid.kanaalpost.rows = [{ tab: 'X', onderwerp: 'Y', status: 'AFGEROND', datum: '2026-02-30 10:00' }];
  assert.deepEqual(lifecycleEvents(invalid), { freshness: 'UNKNOWN', events: [] });
});

test('afsprakenspoor blijft op de technische drill-down zichtbaar zonder afspraaktekst', () => {
  const html = renderHtml(snapshot);
  assert.match(html, /id="afsprakenspoor"/);
  assert.match(html, /Afsprakenspoor \(44\)/);
  assert.match(html, /Laatste bronwijziging: 2026-07-23 09:00 UTC/);
  assert.doesNotMatch(html, /A44/);
});
