import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRuntimeFeed, runtimeFeedFromText } from '../scripts/lib/runtime-feed-input.mjs';
import { activeWork, renderCockpit } from '../scripts/lib/render-cockpit.mjs';
import { buildProductModel, lifecycleEvents } from '../scripts/lib/product-model.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-08-12T12:00:00Z');
const fixture = await readFile(join(ROOT, 'test/fixtures/runtime-feed/volledig-gezond.json'), 'utf8');
const snapshot = JSON.parse(await readFile(join(ROOT, 'data/fixture.json'), 'utf8'));
const canon = JSON.parse(await readFile(join(ROOT, 'data/product-canon.json'), 'utf8'));

test('ontbrekende, lege en kapotte input blijven UNKNOWN en lekken geen parser- of bronpad', async () => {
  assert.equal((await loadRuntimeFeed(null, { now: NOW })).available, false);
  assert.equal(runtimeFeedFromText('', { now: NOW }).available, false);
  assert.equal(runtimeFeedFromText('{geen-json', { now: NOW }).available, false);
  assert.equal((await loadRuntimeFeed('/private/dit-bestaat-niet/runtime.json', { now: NOW })).available, false);
});

test('expliciet bestand doorloopt contract en levert bewezen activiteit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtimefeed-'));
  const path = join(dir, 'feed.json');
  await writeFile(path, fixture);
  const runtimeFeed = await loadRuntimeFeed(path, { now: NOW });
  assert.equal(runtimeFeed.available, true);
  assert.equal(activeWork(runtimeFeed).active.length, 1);
});

test('systeempaden worden vóór cockpitweergave geredigeerd', () => {
  const raw = JSON.parse(fixture);
  raw.control_host = '/private/tmp/control';
  raw.processes.planner.boot_id = '/etc/host-id';
  raw.processes.planner.loaded_sha = '/var/run/loaded';
  raw.actors[0].incidents.push({
    incident_id: 'i-path', opened_at: '2026-08-12T11:58:00Z', severity: 'HIGH',
    note: 'zie /private/tmp/log en /etc/hosts en /var/log/runtime',
  });
  const runtimeFeed = runtimeFeedFromText(JSON.stringify(raw), { now: NOW });
  const html = renderCockpit(snapshot, {
    products: buildProductModel(canon, snapshot), ticker: lifecycleEvents(snapshot), runtimeFeed,
  });
  for (const prefix of ['/private/', '/etc/', '/var/']) {
    assert.equal(JSON.stringify(runtimeFeed).includes(prefix), false, prefix);
    assert.equal(html.includes(prefix), false, prefix);
  }
});

test('renderer herhaalt bewijscheck en vertrouwt geen handmatig active=true zonder identiteit', () => {
  const runtimeFeed = runtimeFeedFromText(fixture, { now: NOW });
  runtimeFeed.actors[0].actor_id = '';
  runtimeFeed.actors[0].current_task.active = true;
  assert.equal(activeWork(runtimeFeed).active.length, 0);
  assert.equal(activeWork(runtimeFeed).incomplete, 1);
});

test('een stale feed kan met een los verse heartbeat geen actief werk claimen', () => {
  const raw = JSON.parse(fixture);
  raw.measured_at = '2026-08-12T10:00:00Z';
  const runtimeFeed = runtimeFeedFromText(JSON.stringify(raw), { now: NOW });
  assert.equal(runtimeFeed.freshness, 'STALE');
  assert.equal(runtimeFeed.actors[0].current_task.last_heartbeat.freshness, 'CURRENT');
  assert.equal(activeWork(runtimeFeed).active.length, 0);
  assert.equal(activeWork(runtimeFeed).incomplete, 1);
});

test('een geredigeerde actor- of task-identiteit is geen zichtbaar activiteitsbewijs', () => {
  for (const veld of ['actor_id', 'task_id']) {
    const raw = JSON.parse(fixture);
    if (veld === 'actor_id') raw.actors[0].actor_id = 'sk-ABCDEFGHIJKLMNOPQRSTUV';
    else raw.actors[0].current_task.task_id = 'sk-ABCDEFGHIJKLMNOPQRSTUV';
    const runtimeFeed = runtimeFeedFromText(JSON.stringify(raw), { now: NOW });
    assert.equal(activeWork(runtimeFeed).active.length, 0, veld);
    assert.equal(activeWork(runtimeFeed).incomplete, 1, veld);
  }
});

// PR69 B2 — last-known-good-terugval. Elke test krijgt zijn eigen tmp-cachepad zodat de tests
// elkaar niet kunnen raken.
test('een geslaagde live lezing schrijft de cache weg, herleesbaar en zonder fallback-markering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtimefeed-b2-'));
  const feedPath = join(dir, 'feed.json');
  const cachePath = join(dir, 'cache.json');
  await writeFile(feedPath, fixture);

  const runtimeFeed = await loadRuntimeFeed(feedPath, { now: NOW, cachePath });
  assert.equal(runtimeFeed.available, true);
  assert.equal(runtimeFeed.fallback, undefined);

  const cached = JSON.parse(await readFile(cachePath, 'utf8'));
  assert.equal(cached.cacheVersion, 1);
  assert.deepEqual(cached.raw, JSON.parse(fixture));
});

test('een mislukte live lezing valt terug op een eerder bewezen geldige cache, gemarkeerd als fallback en STALE', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtimefeed-b2-'));
  const feedPath = join(dir, 'feed.json');
  const cachePath = join(dir, 'cache.json');
  await writeFile(feedPath, fixture);

  // Eerst een geslaagde build op t=meting zelf, zodat de cache gevuld raakt.
  await loadRuntimeFeed(feedPath, { now: new Date('2026-08-12T12:00:00Z'), cachePath });

  // Nu mislukt de live feed (bestand weg), een ruime tijd later — de cache moet nog steeds
  // bruikbare, maar zichtbaar verouderde, taakdata leveren.
  await rm(feedPath);
  const later = new Date('2026-08-12T12:20:00Z');
  const fallbackResult = await loadRuntimeFeed(feedPath, { now: later, cachePath });

  assert.equal(fallbackResult.available, true);
  assert.equal(fallbackResult.fallback?.used, true);
  assert.equal(typeof fallbackResult.fallback.reason, 'string');
  assert.equal(fallbackResult.freshness, 'STALE');
  // Taakbewijs uit de cache blijft intact (nooit weggeveegd door de terugval), ook al is het
  // inmiddels te oud om als ACTIEF te tellen — dat is precies het punt van last-known-good.
  assert.equal(fallbackResult.actors[0].closed[0].task_id, 'task-099');
  assert.equal(fallbackResult.actors[0].closed[0].display_result, 'OK');

  const html = renderCockpit(snapshot, {
    products: buildProductModel(canon, snapshot), ticker: lifecycleEvents(snapshot), runtimeFeed: fallbackResult,
  });
  assert.match(html, /TERUGVAL/);
  assert.match(html, /task-099/);
});

test('een mislukte live lezing zonder enige cache blijft het gewone UNKNOWN-pad, geen fallback verzonnen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtimefeed-b2-'));
  const cachePath = join(dir, 'nooit-geschreven.json');
  const result = await loadRuntimeFeed(join(dir, 'ontbreekt.json'), { now: NOW, cachePath });
  assert.equal(result.available, false);
  assert.equal(result.fallback, undefined);
});

test('een corrupte of verkeerd-versie cache telt als "geen cache", nooit blind vertrouwd', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtimefeed-b2-'));
  const cachePath = join(dir, 'cache.json');

  await writeFile(cachePath, 'dit-is-geen-json{{{');
  let result = await loadRuntimeFeed(join(dir, 'ontbreekt.json'), { now: NOW, cachePath });
  assert.equal(result.available, false);
  assert.equal(result.fallback, undefined);

  await writeFile(cachePath, JSON.stringify({ cacheVersion: 99, raw: JSON.parse(fixture) }));
  result = await loadRuntimeFeed(join(dir, 'ontbreekt.json'), { now: NOW, cachePath });
  assert.equal(result.available, false);
  assert.equal(result.fallback, undefined);
});

// PR69 B6 — een terugval mag nooit CURRENT ogen, ook niet vlak (binnen de STALE_DREMPEL_MS) ná
// een geslaagde live meting. Vóór de fix rekende de terugval alleen measured_at vs. nu uit, dus
// een mislukking één minuut na een gezonde build las nog steeds als CURRENT/ACTIEF — een vals
// gevoel van versheid over data die het live-kanaal op dit moment aantoonbaar niet kan bevestigen.
test('een terugval direct ná een geslaagde meting oogt nooit als CURRENT, ook al ligt measured_at ruim binnen de stale-drempel', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtimefeed-b6-'));
  const feedPath = join(dir, 'feed.json');
  const cachePath = join(dir, 'cache.json');
  await writeFile(feedPath, fixture);

  const t0 = new Date('2026-08-12T12:00:00Z');
  const gezond = await loadRuntimeFeed(feedPath, { now: t0, cachePath });
  assert.equal(gezond.available, true);
  assert.equal(gezond.freshness, 'CURRENT');

  // Eén minuut later mislukt de live lezing — ruim binnen elke redelijke stale-drempel.
  await rm(feedPath);
  const t1 = new Date('2026-08-12T12:01:00Z');
  const terugval = await loadRuntimeFeed(feedPath, { now: t1, cachePath });

  assert.equal(terugval.available, true);
  assert.equal(terugval.fallback?.used, true);
  assert.equal(terugval.freshness, 'STALE');
});

// PR69 B6 (Codex-oordeel op deze correctie zelf) — een terugval mag CURRENT nooit ophogen naar
// STALE zonder onderscheid, want een cache die zelf al UNKNOWN was (bijv. measured_at ontbreekt)
// is een ANDER, slechter signaal dan "gewoon oud" en mag niet stilzwijgend als STALE ogen — dat
// verzwijgt juist dat er geen bruikbaar tijdstip is. Alleen CURRENT→STALE is een verlaging;
// UNKNOWN blijft UNKNOWN.
test('een terugval op een cache die zelf al UNKNOWN was, blijft UNKNOWN — nooit opgehoogd naar STALE', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtimefeed-b6-unknown-'));
  const feedPath = join(dir, 'feed.json');
  const cachePath = join(dir, 'cache.json');
  const onbekendFixture = await readFile(join(ROOT, 'test/fixtures/runtime-feed/alles-onbekend.json'), 'utf8');
  await writeFile(feedPath, onbekendFixture);

  const t0 = new Date('2026-08-12T12:00:00Z');
  const gezond = await loadRuntimeFeed(feedPath, { now: t0, cachePath });
  assert.equal(gezond.available, true);
  assert.equal(gezond.freshness, 'UNKNOWN');

  await rm(feedPath);
  const t1 = new Date('2026-08-12T12:01:00Z');
  const terugval = await loadRuntimeFeed(feedPath, { now: t1, cachePath });

  assert.equal(terugval.available, true);
  assert.equal(terugval.fallback?.used, true);
  assert.equal(terugval.freshness, 'UNKNOWN');
});

test('zonder cachePath is loadRuntimeFeed functioneel ongewijzigd — geen bestandsschrijving, geen fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtimefeed-b2-'));
  const feedPath = join(dir, 'feed.json');
  await writeFile(feedPath, fixture);

  const ok = await loadRuntimeFeed(feedPath, { now: NOW });
  assert.equal(ok.available, true);
  assert.equal(ok.fallback, undefined);

  const missing = await loadRuntimeFeed(join(dir, 'ontbreekt.json'), { now: NOW });
  assert.equal(missing.available, false);
  assert.equal(missing.fallback, undefined);
});
