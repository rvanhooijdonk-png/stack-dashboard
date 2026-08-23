import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCockpit, renderProducts, renderTicker, ownerGates, activeWork } from '../scripts/lib/render-cockpit.mjs';
import { buildProductModel, lifecycleEvents, validateProductCanon } from '../scripts/lib/product-model.mjs';
import { renderHtml } from '../scripts/lib/render.mjs';
import { parseRuntimeFeed } from '../scripts/lib/runtime-feed.mjs';
import { PANEL_CONTRACTS, renderPanelSlot } from '../scripts/lib/panel-contracts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const snapshot = JSON.parse(await readFile(join(ROOT, 'data/fixture.json'), 'utf8'));
const canon = JSON.parse(await readFile(join(ROOT, 'data/product-canon.json'), 'utf8'));
const products = buildProductModel(canon, snapshot);
const ticker = lifecycleEvents(snapshot);
const runtimeRaw = JSON.parse(await readFile(join(ROOT, 'test/fixtures/runtime-feed/volledig-gezond.json'), 'utf8'));
const runtimeHealthy = parseRuntimeFeed(runtimeRaw, { now: new Date('2026-08-12T12:00:00Z') });

test('hoofdpagina bevat uitsluitend de tien rustige hoofdsecties inclusief de drie vaste paneelslots', () => {
  const html = renderCockpit(snapshot, { products, ticker });
  const ids = [...html.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, [
    'wacht-op-richard', 'nu-actief',
    'paneel-richard-queue', 'paneel-nu-bezig', 'paneel-statusgen',
    'vandaag-geleverd', 'producten', 'incidenten', 'accountcapaciteit', 'laatste-ticker-events',
  ]);
});

test('de nog ongekoppelde paneelslots (b/RICHARD-QUEUE, k/NU-BEZIG) renderen altijd, met UNKNOWN zolang hun bron ontbreekt', () => {
  const html = renderCockpit(snapshot, { products, ticker });
  for (const id of ['paneel-richard-queue', 'paneel-nu-bezig']) {
    const section = html.match(new RegExp(`<section id="${id}"[\\s\\S]*?</section>`));
    assert.ok(section, `paneelslot ${id} ontbreekt`);
    assert.match(section[0], /UNKNOWN — bron nog niet gekoppeld\./, `paneelslot ${id} mist de UNKNOWN-regel`);
    assert.match(section[0], /Contract: /, `paneelslot ${id} mist de contractregel`);
    assert.match(section[0], /Noemer: /, `paneelslot ${id} mist de noemerregel`);
    assert.match(section[0], /Gemeten om: <span class="unknown">UNKNOWN<\/span>\./, `paneelslot ${id} mist de gemeten-om-stempel`);
  }
  assert.match(html, /<h2>RICHARD-QUEUE /);
  assert.match(html, /<h2>NU-BEZIG /);
  assert.match(html, /<h2>STATUSGEN /);
});

test('het paneelcontract bindt de volledige tuple: slot-key, id en titel horen bij elkaar en liggen vast', () => {
  assert.deepEqual(
    PANEL_CONTRACTS.map(({ slot, id, title }) => [slot, id, title]),
    [
      ['b', 'paneel-richard-queue', 'RICHARD-QUEUE'],
      ['k', 'paneel-nu-bezig', 'NU-BEZIG'],
      ['statusgen', 'paneel-statusgen', 'STATUSGEN'],
    ],
  );
  // elk contract draagt ook de twee velden waar een latere vuller op steunt
  for (const contract of PANEL_CONTRACTS) {
    assert.equal(typeof contract.inputSource, 'string');
    assert.ok(contract.inputSource.length > 0, `${contract.slot} mist inputSource`);
    assert.equal(typeof contract.denominatorLabel, 'string');
    assert.ok(contract.denominatorLabel.length > 0, `${contract.slot} mist denominatorLabel`);
  }
});

test('de slot-key staat als data-panel-slot in de plaat en kan niet stil worden verwisseld', () => {
  const html = renderCockpit(snapshot, { products, ticker });
  for (const { slot, id } of PANEL_CONTRACTS) {
    const section = html.match(new RegExp(`<section id="${id}"[^>]*>`));
    assert.ok(section, `paneelslot ${id} ontbreekt`);
    assert.match(section[0], new RegExp(`data-panel-slot="${slot}"`), `${id} draagt niet slot-key ${slot}`);
  }
  const slots = [...html.matchAll(/data-panel-slot="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(slots, ['b', 'k', 'statusgen']);
});

test('het paneelcontract is bevroren: een latere vuller kan de vorm niet in-process omschrijven', () => {
  assert.equal(Object.isFrozen(PANEL_CONTRACTS), true);
  for (const contract of PANEL_CONTRACTS) assert.equal(Object.isFrozen(contract), true);
});

test('een gevulde meetstempel wordt getoond én ontsnapt; een kapot optieargument valt terug op UNKNOWN', () => {
  const [contract] = PANEL_CONTRACTS;
  const gevuld = renderPanelSlot(contract, { measuredAt: '<img src=x onerror=alert(1)>' });
  assert.match(gevuld, /Gemeten om: &lt;img src=x onerror=alert\(1\)&gt;\./);
  assert.equal(/<img src=x/.test(gevuld), false);
  // de rest van het paneel blijft fail-closed zolang er geen bron is
  assert.match(gevuld, /UNKNOWN — bron nog niet gekoppeld\./);
  for (const kapot of [null, undefined, 'niet-een-object', 0]) {
    assert.match(
      renderPanelSlot(contract, kapot),
      /Gemeten om: <span class="unknown">UNKNOWN<\/span>\./,
      `optieargument ${JSON.stringify(kapot)} hoort UNKNOWN te geven, niet te klappen`,
    );
  }
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

test('een synthetische preview is in de pagina zelf ondubbelzinnig als niet-live gemarkeerd', () => {
  const html = renderCockpit(snapshot, { products, ticker, runtimeFeed: runtimeHealthy, preview: true });
  assert.match(html, /TESTPREVIEW/);
  assert.match(html, /synthetische runtimefeed; dit is geen live stand/);
});

test('elke statische pagina ververst naar zichzelf en niet terug naar de cockpit', () => {
  assert.match(renderCockpit(snapshot, { products, ticker }), /content="10; url=\.\/\?v=\d+"/);
  assert.match(renderProducts(snapshot, products), /content="900; url=\.\/producten\.html\?v=\d+"/);
  assert.match(renderTicker(snapshot, ticker), /content="900; url=\.\/stack-ticker\.html\?v=\d+"/);
  assert.match(renderHtml(snapshot, { pagePath: './contentstroom.html' }), /content="900; url=\.\/contentstroom\.html\?v=\d+"/);
});

test('cockpit refresh is standaard ≤10s en de vloer is 5s, niet 60s', () => {
  assert.match(renderCockpit(snapshot, { products, ticker }), /content="10; /);
  assert.match(renderCockpit(snapshot, { products, ticker, refreshSeconds: 3 }), /content="5; /);
  assert.match(renderCockpit(snapshot, { products, ticker, refreshSeconds: 4000 }), /content="3600; /);
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
  assert.equal(result.unavailable.length, 1, 'non-draft zonder mergeability/checks blijft UNKNOWN');
  assert.equal(result.gates.length, 2, 'alleen planning- en kanaalpost-ownerpoort zijn bewezen');
  assert.equal(result.gates.some((gate) => gate.label.includes('open pull request')), false);
  assert.ok(result.gates.some((gate) => gate.label === 'Tijdstempel in Nederlandse tijd'));
  assert.ok(result.gates.some((gate) => gate.label.includes('integratiegaten')));
  const html = renderCockpit(snapshot, { products, ticker });
  assert.match(html, /2 niet-draft PRs; mergebaarheid en vereiste checks zijn niet gemeten/);
  assert.match(html, /2<\/span> <span class="badge bad">1 bron UNKNOWN/);
});

test('nul non-draft PRs is geen gate en een ongeldige telling blijft UNKNOWN', () => {
  const empty = structuredClone(snapshot);
  empty.pullRequests.totals.open = empty.pullRequests.totals.draft;
  empty.pullRequests.totals.ready = 0;
  assert.equal(ownerGates(empty).unavailable.length, 0);
  assert.equal(ownerGates(empty).gates.some((gate) => gate.identity.startsWith('pull-requests:')), false);

  const corrupt = structuredClone(snapshot);
  corrupt.pullRequests.totals.ready = '2';
  const result = ownerGates(corrupt);
  assert.equal(result.unavailable.length, 1);
  assert.match(result.unavailable[0], /geldige pull-requesttelling ontbreekt/);

  const inconsistent = structuredClone(empty);
  inconsistent.pullRequests.totals.open += 1;
  assert.equal(ownerGates(inconsistent).unavailable.length, 1, 'open moet exact draft + ready zijn');
});

test('een beschikbare maar niet-geverifieerde PR-bron blijft UNKNOWN, ook bij een consistente nul', () => {
  for (const trust of ['UNVERIFIED', 'CONFLICTING_EVIDENCE', 'SOURCE_UNAVAILABLE', undefined]) {
    const input = structuredClone(snapshot);
    input.pullRequests.totals = { open: 0, draft: 0, ready: 0 };
    input.pullRequests.evidence.trust = trust;
    input.planning.features = [];
    input.kanaalpost.rows = [];

    const result = ownerGates(input);
    assert.equal(result.gates.length, 0, trust);
    assert.equal(result.unavailable.length, 1, trust);
    assert.match(result.unavailable[0], /pull-requestbron niet geverifieerd/, trust);

    const html = renderCockpit(input, { products: buildProductModel(canon, input), ticker });
    assert.match(html, /Mergepoorten UNKNOWN/, trust);
    assert.doesNotMatch(html, /Alle drie de ownerbronnen zijn gelezen/, trust);
  }
});

test('VERIFIED_CURRENT en STALE zijn de gesloten bruikbare trustlijst voor de PR-bron', () => {
  for (const trust of ['VERIFIED_CURRENT', 'STALE']) {
    const input = structuredClone(snapshot);
    input.pullRequests.totals = { open: 0, draft: 0, ready: 0 };
    input.pullRequests.evidence.trust = trust;
    assert.equal(ownerGates(input).unavailable.length, 0, trust);
  }
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

test('Nu actief wordt niet groen zonder task-id, actor, WORKER_STARTED en latere verse heartbeat', () => {
  const raw = structuredClone(runtimeRaw);
  raw.actors[0].current_task.worker_started = null;
  const runtimeIncomplete = parseRuntimeFeed(raw, { now: new Date('2026-08-12T12:00:00Z') });
  const state = activeWork(runtimeIncomplete);
  assert.equal(state.active.length, 0);
  assert.equal(state.incomplete, 1);
  const html = renderCockpit(snapshot, { products, ticker, runtimeFeed: runtimeIncomplete });
  const section = html.slice(html.indexOf('id="nu-actief"'), html.indexOf('id="vandaag-geleverd"'));
  // "dot ok" mag hier wél voorkomen voor een AFGEROND OK-taak uit closed[] (bewezen terminaal
  // bewijs) — alleen een IN UITVOERING-claim mag nooit groen zijn zonder het volledige bewijs.
  assert.doesNotMatch(section, /IN UITVOERING/);
  assert.match(section, /task-id, actor, WORKER_STARTED of latere verse heartbeat ontbreekt/);
  assert.match(section, /ONBEKEND · task-100/);
  // De fixture heeft inmiddels een bewezen pickup (PR69 B1) — zonder worker_started is de precieze
  // reden dus PICKUP_ZONDER_START, niet het oudere GEEN_WORKERSTART (dat gold zonder pickup-veld).
  assert.match(section, /pickup is bewezen maar er is geen geldige worker_started/);
});

test('Nu actief wordt pas groen met geordend en vers volledig bewijs', () => {
  assert.equal(activeWork(runtimeHealthy).active.length, 1);
  const html = renderCockpit(snapshot, { products, ticker, runtimeFeed: runtimeHealthy });
  const section = html.slice(html.indexOf('id="nu-actief"'), html.indexOf('id="vandaag-geleverd"'));
  assert.match(section, /dot ok/);
  assert.match(section, /IN UITVOERING · task-100/);
  assert.match(section, /actor-alpha/);
  assert.match(section, /WORKER_STARTED 2026-08-12T11:50:00Z/);
  assert.match(section, /heartbeat 2026-08-12T11:58:00Z/);
});

test('een stale heartbeat levert nooit groene ontwikkelstatus', () => {
  const raw = structuredClone(runtimeRaw);
  raw.actors[0].current_task.worker_started = '2026-08-12T10:00:00Z';
  raw.actors[0].current_task.last_heartbeat = '2026-08-12T10:10:00Z';
  const stale = parseRuntimeFeed(raw, { now: new Date('2026-08-12T12:00:00Z') });
  assert.equal(activeWork(stale).active.length, 0);
  assert.equal(activeWork(stale).incomplete, 1);
});

test('planningvelden kunnen zonder runtimebewijs nooit IN UITVOERING veroorzaken', () => {
  const input = structuredClone(snapshot);
  const feature = input.planning.features.find((item) => item.status === 'in-bouw');
  Object.assign(feature, {
    task_id: 'planning-is-geen-runtime', actor: 'CODEX1',
    startedAt: '2026-08-12T11:00:00Z', heartbeatAt: '2026-08-12T11:59:00Z',
  });
  const html = renderCockpit(input, { products, ticker });
  const section = html.slice(html.indexOf('id="nu-actief"'), html.indexOf('id="vandaag-geleverd"'));
  assert.match(section, /UNKNOWN — runtimefeed niet beschikbaar/);
  assert.doesNotMatch(section, /IN UITVOERING/);
});

test('runtime task-id vergroot de gesloten productcanon niet', () => {
  const voor = products.products.map((product) => [product.id, product.denominator]);
  renderCockpit(snapshot, { products, ticker, runtimeFeed: runtimeHealthy });
  assert.deepEqual(products.products.map((product) => [product.id, product.denominator]), voor);
  assert.equal(products.products.reduce((total, product) => total + product.denominator, 0), 52);
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

test('een stale feed toont de laatst bekende taakdata nog steeds — VEROUDERD, niet weggeveegd', () => {
  const raw = structuredClone(runtimeRaw); raw.actors[0].current_task = null;
  const runtimeFeed = parseRuntimeFeed(raw, { now: new Date('2026-08-12T13:00:00Z') });
  assert.equal(runtimeFeed.freshness, 'STALE');
  const html = renderCockpit(snapshot, { products, ticker, runtimeFeed });
  const section = html.slice(html.indexOf('id="nu-actief"'), html.indexOf('id="vandaag-geleverd"'));
  assert.match(section, /Runtime freshness: STALE/);
  assert.doesNotMatch(section, /IN UITVOERING/);
});

test('een op zichzelf verse heartbeat op een verouderde feed toont VEROUDERD met het volledige task-bewijs intact, niet als opaque teller', () => {
  const raw = structuredClone(runtimeRaw); raw.measured_at = '2026-08-12T10:00:00Z';
  const runtimeFeed = parseRuntimeFeed(raw, { now: new Date('2026-08-12T12:00:00Z') });
  assert.equal(runtimeFeed.freshness, 'STALE');
  assert.equal(runtimeFeed.actors[0].current_task.last_heartbeat.freshness, 'CURRENT');
  const html = renderCockpit(snapshot, { products, ticker, runtimeFeed });
  const section = html.slice(html.indexOf('id="nu-actief"'), html.indexOf('id="vandaag-geleverd"'));
  assert.doesNotMatch(section, /IN UITVOERING/);
  assert.match(section, /VEROUDERD · task-100/);
  assert.match(section, /actor-alpha/);
  assert.match(section, /heartbeat 2026-08-12T11:58:00Z/);
  assert.match(section, /metingsklok van de hele feed is veroudered/);
});

test('afgeronde taken (OK, FAILED, UNKNOWN) verschijnen als terminale bewijsregels met evidence-pointer', () => {
  const raw = structuredClone(runtimeRaw);
  raw.actors[0].closed.push(
    { task_id: 'task-097', closed_at: '2026-08-12T11:30:00Z', result: 'FAILED' },
    { task_id: 'task-096', closed_at: '2026-08-12T11:20:00Z', result: 'UNKNOWN' },
  );
  const runtimeFeed = parseRuntimeFeed(raw, { now: new Date('2026-08-12T12:00:00Z') });
  const html = renderCockpit(snapshot, { products, ticker, runtimeFeed });
  const section = html.slice(html.indexOf('id="nu-actief"'), html.indexOf('id="vandaag-geleverd"'));
  assert.match(section, /AFGEROND OK · task-099/);
  assert.match(section, /AFGEROND FAILED · task-097/);
  assert.match(section, /AFGEROND UNKNOWN · task-096/);
  assert.match(section, /bewijs: meting 2026-08-12T11:59:00Z op control-host-01/);
});

test('AFGEROND OK toont een klikbaar claimbewijs naar de github.com/rvanhooijdonk-png-bron', () => {
  const runtimeFeed = parseRuntimeFeed(runtimeRaw, { now: new Date('2026-08-12T12:00:00Z') });
  const html = renderCockpit(snapshot, { products, ticker, runtimeFeed });
  const section = html.slice(html.indexOf('id="nu-actief"'), html.indexOf('id="vandaag-geleverd"'));
  assert.match(section, /claimbewijs: <a href="https:\/\/github\.com\/rvanhooijdonk-png\/stack-dashboard\/commit\/a1b2c3d" rel="noopener">COMMIT_SHA:a1b2c3d<\/a>/);
});

test('een geclaimd OK-resultaat zonder geldig terminaal bewijskenmerk toont BEWIJS ONVOLLEDIG, nooit stilzwijgend OK', () => {
  const raw = structuredClone(runtimeRaw);
  delete raw.actors[0].closed[0].evidence_ref;
  raw.actors[0].closed[0].evidence_ref = null;
  const runtimeFeed = parseRuntimeFeed(raw, { now: new Date('2026-08-12T12:00:00Z') });
  const html = renderCockpit(snapshot, { products, ticker, runtimeFeed });
  const section = html.slice(html.indexOf('id="nu-actief"'), html.indexOf('id="vandaag-geleverd"'));
  assert.match(section, /AFGEROND — BEWIJS ONVOLLEDIG · task-099/);
  assert.match(section, /mist een geldig, onveranderlijk bewijskenmerk/);
  assert.doesNotMatch(section, /AFGEROND OK · task-099/);
  const task099Row = section.slice(section.indexOf('task-099'), section.indexOf('</li>', section.indexOf('task-099')));
  assert.doesNotMatch(task099Row, /claimbewijs:/);
});

test('een afgeronde taak vóór zijn eigen worker_started wordt op de pagina UNKNOWN, ongeacht het geclaimde resultaat', () => {
  const raw = structuredClone(runtimeRaw);
  raw.actors[0].closed[0].worker_started = '2026-08-12T12:00:00Z';
  const runtimeFeed = parseRuntimeFeed(raw, { now: new Date('2026-08-12T12:00:00Z') });
  const html = renderCockpit(snapshot, { products, ticker, runtimeFeed });
  const section = html.slice(html.indexOf('id="nu-actief"'), html.indexOf('id="vandaag-geleverd"'));
  assert.match(section, /AFGEROND UNKNOWN · task-099/);
  assert.match(section, /tijdsvolgorde die niet klopt/);
});

test('een niet-github claimbewijs-URL wordt nooit klikbaar gemaakt, alleen het opaque kenmerk wordt getoond', () => {
  const raw = structuredClone(runtimeRaw);
  raw.actors[0].closed[0].evidence_ref.url = 'https://evil.example/x';
  const runtimeFeed = parseRuntimeFeed(raw, { now: new Date('2026-08-12T12:00:00Z') });
  const html = renderCockpit(snapshot, { products, ticker, runtimeFeed });
  assert.doesNotMatch(html, /evil\.example/);
  assert.match(html, /claimbewijs: COMMIT_SHA:a1b2c3d/);
});

test('bewezen actief werk krijgt ook een evidence-pointer en een leeftijdsaanduiding op de heartbeat', () => {
  // Leeftijd wordt vast berekend t.o.v. snapshot.generatedAt (het bouwmoment) — zelfde klok als
  // build.mjs aan loadRuntimeFeed geeft. Hier expliciet uitgelijnd zodat de leeftijd zinvol is.
  const raw = structuredClone(runtimeRaw);
  raw.measured_at = snapshot.generatedAt;
  raw.actors[0].current_task.worker_started = '2026-07-23T11:50:00Z';
  raw.actors[0].current_task.last_heartbeat = '2026-07-23T11:58:00Z';
  const runtimeFeed = parseRuntimeFeed(raw, { now: new Date(snapshot.generatedAt) });
  const html = renderCockpit(snapshot, { products, ticker, runtimeFeed });
  const section = html.slice(html.indexOf('id="nu-actief"'), html.indexOf('id="vandaag-geleverd"'));
  assert.match(section, /heartbeat 2026-07-23T11:58:00Z \(2m geleden\)/);
  assert.match(section, new RegExp(`bewijs: meting ${snapshot.generatedAt} op control-host-01`));
});

test('dubbele task-pickup (twee actoren, dezelfde task_id) verschijnt als incident, nooit als twee actieve werkers', async () => {
  const raw = JSON.parse(await readFile(join(ROOT, 'test/fixtures/runtime-feed/conflicterende-status.json'), 'utf8'));
  const runtimeFeed = parseRuntimeFeed(raw, { now: new Date('2026-08-12T12:00:00Z') });
  const html = renderCockpit(snapshot, { products, ticker, runtimeFeed });
  assert.equal(activeWork(runtimeFeed).active.length, 0);
  const activeSection = html.slice(html.indexOf('id="nu-actief"'), html.indexOf('id="vandaag-geleverd"'));
  assert.doesNotMatch(activeSection, /IN UITVOERING/);
  const incidentSection = html.slice(html.indexOf('id="incidenten"'), html.indexOf('id="accountcapaciteit"'));
  assert.match(incidentSection, /Dubbele task-ID · task-shared/);
});

test('dubbele actor-ID verschijnt als incident op de rustige hoofdpagina', async () => {
  const raw = JSON.parse(await readFile(join(ROOT, 'test/fixtures/runtime-feed/dubbele-actors.json'), 'utf8'));
  const runtimeFeed = parseRuntimeFeed(raw, { now: new Date('2026-08-12T12:00:00Z') });
  const html = renderCockpit(snapshot, { products, ticker, runtimeFeed });
  const incidentSection = html.slice(html.indexOf('id="incidenten"'), html.indexOf('id="accountcapaciteit"'));
  assert.match(incidentSection, /Dubbele actor-ID · actor-alpha/);
});

test('een actor-gemelde incident wordt op de hoofdpagina getoond, geredigeerd en zonder gefabriceerd percentage', () => {
  const raw = structuredClone(runtimeRaw);
  raw.actors[0].incidents.push({
    incident_id: 'inc-1', opened_at: '2026-08-12T11:45:00Z', severity: 'HIGH', note: 'dubbele opstart gedetecteerd',
  });
  const runtimeFeed = parseRuntimeFeed(raw, { now: new Date('2026-08-12T12:00:00Z') });
  const html = renderCockpit(snapshot, { products, ticker, runtimeFeed });
  const incidentSection = html.slice(html.indexOf('id="incidenten"'), html.indexOf('id="accountcapaciteit"'));
  assert.match(incidentSection, /actor-alpha · inc-1/);
  assert.match(incidentSection, /HIGH/);
  assert.match(incidentSection, /dubbele opstart gedetecteerd/);
});

test('hostile task-id/actor-id/incidentnotitie in de nieuwe VEROUDERD-, AFGEROND- en incidentregels wordt geëscaped, nooit als markup', () => {
  const raw = structuredClone(runtimeRaw);
  raw.actors[0].current_task.worker_started = null;
  raw.actors[0].current_task.task_id = '<img src=x onerror=alert(1)>';
  raw.actors[0].closed[0].task_id = '<svg onload=alert(2)>';
  raw.actors[0].incidents.push({
    incident_id: '<b>i</b>', opened_at: '2026-08-12T11:45:00Z', severity: 'LOW', note: '<script>alert(3)</script>',
  });
  const runtimeFeed = parseRuntimeFeed(raw, { now: new Date('2026-08-12T12:00:00Z') });
  const html = renderCockpit(snapshot, { products, ticker, runtimeFeed });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<svg onload/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;svg onload=alert\(2\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
});

test('absolute lokale paden in evidence-relevante velden (control_host) worden vóór weergave geredigeerd', () => {
  const raw = structuredClone(runtimeRaw);
  raw.control_host = '/Users/richard/geheim';
  const runtimeFeed = parseRuntimeFeed(raw, { now: new Date('2026-08-12T12:00:00Z') });
  const html = renderCockpit(snapshot, { products, ticker, runtimeFeed });
  assert.equal(html.includes('/Users/'), false);
});

test('een leeg actorenoverzicht laat exact nul onbewezen actieve werkers zien — geen enkele fictieve IN UITVOERING-regel', () => {
  const raw = structuredClone(runtimeRaw); raw.actors = [];
  const runtimeFeed = parseRuntimeFeed(raw, { now: new Date('2026-08-12T12:00:00Z') });
  assert.equal(activeWork(runtimeFeed).active.length, 0);
  const html = renderCockpit(snapshot, { products, ticker, runtimeFeed });
  const section = html.slice(html.indexOf('id="nu-actief"'), html.indexOf('id="vandaag-geleverd"'));
  assert.doesNotMatch(section, /IN UITVOERING/);
});

test('afsprakenspoor blijft op de technische drill-down zichtbaar zonder afspraaktekst', () => {
  const html = renderHtml(snapshot);
  assert.match(html, /id="afsprakenspoor"/);
  assert.match(html, /Afsprakenspoor \(44\)/);
  assert.match(html, /Laatste bronwijziging: 2026-07-23 09:00 UTC/);
  assert.doesNotMatch(html, /A44/);
});
