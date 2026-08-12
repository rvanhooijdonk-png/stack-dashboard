import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
