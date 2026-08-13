/**
 * Tests voor het runtime-feed-adaptercontract. Twee lagen:
 *  - FIXTURES: elk bestand in test/fixtures/runtime-feed/ dekt één met de startopdracht afgesproken
 *    scenario (gezond, onbekend, stale, conflict, hostile, ...). Elke test laadt zijn eigen fixture
 *    en toetst uitsluitend het gedrag dat dat scenario belooft — geen gedeelde aannames.
 *  - CONTRACT: schema/JS-object-gelijkheid, en de losse regels (negatieve teller, geen actief werk
 *    zonder workerstart+latere heartbeat, nooit een vijfde freshness-waarde) met handgemaakte input.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseRuntimeFeed, auditRuntimeFeedSchema, RUNTIME_FEED_SCHEMA, FRESHNESS, CODES,
  STALE_DREMPEL_MS, FUTURE_SKEW_MS,
} from '../scripts/lib/runtime-feed.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXDIR = join(ROOT, 'test/fixtures/runtime-feed');
const NU = new Date('2026-08-12T12:00:00.000Z');

async function laad(naam) {
  return JSON.parse(await readFile(join(FIXDIR, `${naam}.json`), 'utf8'));
}

test('schema-audit: RUNTIME_FEED_SCHEMA gebruikt uitsluitend ondersteunde sleutelwoorden', () => {
  const fouten = auditRuntimeFeedSchema();
  assert.deepEqual(fouten, []);
});

test('schema-gelijkheid: data/runtime-feed.schema.json en RUNTIME_FEED_SCHEMA zijn byte-voor-byte hetzelfde JSON', async () => {
  const opSchijf = JSON.parse(await readFile(join(ROOT, 'data/runtime-feed.schema.json'), 'utf8'));
  assert.deepEqual(opSchijf, RUNTIME_FEED_SCHEMA);
});

test('volledig-gezond: available, freshness CURRENT, geen findings', async () => {
  const r = parseRuntimeFeed(await laad('volledig-gezond'), { now: NU });
  assert.equal(r.available, true);
  assert.equal(r.freshness, 'CURRENT');
  assert.equal(r.findings.length, 0);
});

test('alles-onbekend: lege/nulwaarden geven UNKNOWN, nooit een verzonnen 0%', async () => {
  const r = parseRuntimeFeed(await laad('alles-onbekend'), { now: NU });
  assert.equal(r.available, true);
  assert.equal(r.freshness, 'UNKNOWN');
  assert.equal(r.summary.actors_totaal, 0);
  assert.equal(r.summary.actors_actief, 0);
});

test('stale-feed: measured_at ouder dan de drempel geeft freshness STALE', async () => {
  const r = parseRuntimeFeed(await laad('stale-feed'), { now: NU });
  assert.equal(r.available, true);
  assert.equal(r.freshness, 'STALE');
});

test('gedeeltelijk-defect-account: één stale account blijft record-lokaal, feed blijft bruikbaar', async () => {
  const r = parseRuntimeFeed(await laad('gedeeltelijk-defect-account'), { now: NU });
  assert.equal(r.available, true);
  const mini = r.accounts.find((a) => a.account_id === 'acct-mini');
  const macbook = r.accounts.find((a) => a.account_id === 'acct-macbook');
  assert.equal(mini.status, 'CONFLICT');
  assert.equal(macbook.status, 'OK');
});

test('mini-rood-macbook-groen: elk account draagt zijn eigen status, geen kruisbesmetting', async () => {
  const r = parseRuntimeFeed(await laad('mini-rood-macbook-groen'), { now: NU });
  const mini = r.accounts.find((a) => a.account_id === 'acct-mini');
  const macbook = r.accounts.find((a) => a.account_id === 'acct-macbook');
  assert.equal(mini.status, 'DOWN');
  assert.equal(macbook.status, 'OK');
});

test('planner-leeft-worker-ontbreekt: planner CURRENT, geen actoren actief', async () => {
  const r = parseRuntimeFeed(await laad('planner-leeft-worker-ontbreekt'), { now: NU });
  assert.equal(r.processes.planner.heartbeat.freshness, 'CURRENT');
  assert.equal(r.summary.actors_actief, 0);
  assert.equal(r.actors.length, 2);
});

test('hostile-tekst: prompt-injectie-achtige notitie is inerte data, geen crash, geen effect op parsing', async () => {
  const r = parseRuntimeFeed(await laad('hostile-tekst'), { now: NU });
  assert.equal(r.available, true);
  assert.equal(typeof r.actors[0].incidents[0].note, 'string');
  assert.equal(r.actors[0].identity, 'OK');
});

test('zeer-lange-tekst: notitie boven de lengtedrempel wordt geredigeerd, niet afgekapt-maar-zichtbaar', async () => {
  const r = parseRuntimeFeed(await laad('zeer-lange-tekst'), { now: NU });
  assert.equal(r.actors[0].incidents[0].note, '[REDACTED — te lang]');
  assert.ok(r.findings.some((f) => f.pattern === 'oversized'));
});

test('onbekend-schema: onbekend top-level veld keurt de hele feed af (SCHEMA_ONBEKEND)', async () => {
  const r = parseRuntimeFeed(await laad('onbekend-schema'), { now: NU });
  assert.equal(r.available, false);
  assert.equal(r.reason, 'SCHEMA_ONBEKEND');
  assert.equal(r.actors.length, 0);
});

test('future-timestamp: tijdstempel voorbij de klokspeling geeft UNKNOWN, nooit stilzwijgend CURRENT', async () => {
  const r = parseRuntimeFeed(await laad('future-timestamp'), { now: NU });
  assert.equal(r.freshness, 'UNKNOWN');
  assert.ok(r.findings.some((f) => f.code === 'TOEKOMST'));
});

test('dubbele-actors: beide regels met dezelfde actor_id krijgen CONFLICT, geen stille voorkeur', async () => {
  const r = parseRuntimeFeed(await laad('dubbele-actors'), { now: NU });
  assert.equal(r.actors.length, 2);
  assert.ok(r.actors.every((a) => a.identity === 'CONFLICT'));
  assert.ok(r.findings.some((f) => f.code === 'DUBBELE_ACTOR_ID'));
});

test('secret-achtige-velden: token in notitie en key-achtig label worden geredigeerd, nooit gepubliceerd', async () => {
  const r = parseRuntimeFeed(await laad('secret-achtige-velden'), { now: NU });
  assert.ok(!r.actors[0].incidents[0].note.includes('ghp_'));
  assert.ok(!r.accounts[0].label.includes('sk-'));
});

test('absolute-lokale-paden: thuismap-pad in notitie wordt geredigeerd, nooit gepubliceerd', async () => {
  const r = parseRuntimeFeed(await laad('absolute-lokale-paden'), { now: NU });
  assert.ok(!r.actors[0].incidents[0].note.includes('/Users/'));
});

test('B-1-padset: alle voorheen gelekte lokale roots worden in zichtbare feedvelden geredigeerd', () => {
  const gelektePaden = [
    '/tmp/stack-control/feed.json',
    '/opt/homebrew/run/agent.sock',
    '/usr/local/share/stack/state.json',
    '/Library/Application Support/Stack/feed.json',
    '/Volumes/Backup/test.json',
    '/Applications/Stack.app/state.json',
    '/mnt/stack/feed.json',
    '/srv/stack/feed.json',
    '~/stack/feed.json',
  ];
  const raw = {
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null },
    queue_counts: gelektePaden.slice(0, 5).map((name, count) => ({ name, count })),
    actors: [{
      actor_id: `actor-alpha ${gelektePaden[8]}`,
      current_task: {
        task_id: `task-100 ${gelektePaden[2]}`,
        worker_started: '2026-08-12T11:50:00Z',
        last_heartbeat: '2026-08-12T11:58:00Z',
      },
      closed: [], incidents: [],
    }],
    accounts: gelektePaden.slice(5, 8).map((label, i) => ({
      account_id: `acct-${i}`, label, status: 'OK', last_seen: '2026-08-12T11:59:00Z',
    })),
  };
  const r = parseRuntimeFeed(raw, { now: NU });
  const publiek = JSON.stringify(r);
  for (const pad of gelektePaden) assert.equal(publiek.includes(pad), false, pad);
  assert.ok(r.findings.filter((finding) => finding.pattern === 'system-path').length >= 9);
});

test('conflicterende-status: twee actoren op dezelfde task_id krijgen beide CONFLICT, rest van de actor blijft intact', async () => {
  const r = parseRuntimeFeed(await laad('conflicterende-status'), { now: NU });
  assert.equal(r.actors[0].current_task.identity, 'CONFLICT');
  assert.equal(r.actors[1].current_task.identity, 'CONFLICT');
  assert.ok(r.findings.filter((f) => f.code === 'DUBBELE_TASK_ID').length >= 2);
});

test('geen actief werk zonder worker_started', () => {
  const raw = {
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
    actors: [{
      actor_id: 'a1',
      current_task: { task_id: 't1', worker_started: null, last_heartbeat: '2026-08-12T11:58:00Z' },
      closed: [], incidents: [],
    }],
    accounts: [],
  };
  const r = parseRuntimeFeed(raw, { now: NU });
  assert.equal(r.actors[0].current_task.active, false);
  assert.equal(r.actors[0].current_task.active_reason, 'GEEN_WORKERSTART');
});

test('geen actief werk zonder latere heartbeat (worker_started zonder last_heartbeat)', () => {
  const raw = {
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
    actors: [{
      actor_id: 'a1',
      current_task: { task_id: 't1', worker_started: '2026-08-12T11:40:00Z', last_heartbeat: null },
      closed: [], incidents: [],
    }],
    accounts: [],
  };
  const r = parseRuntimeFeed(raw, { now: NU });
  assert.equal(r.actors[0].current_task.active, false);
  assert.equal(r.actors[0].current_task.active_reason, 'GEEN_HEARTBEAT');
});

test('heartbeat vóór worker_started is tegenstrijdig, geen actief werk', () => {
  const raw = {
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
    actors: [{
      actor_id: 'a1',
      current_task: { task_id: 't1', worker_started: '2026-08-12T11:50:00Z', last_heartbeat: '2026-08-12T11:40:00Z' },
      closed: [], incidents: [],
    }],
    accounts: [],
  };
  const r = parseRuntimeFeed(raw, { now: NU });
  assert.equal(r.actors[0].current_task.active, false);
  assert.equal(r.actors[0].current_task.active_reason, 'HEARTBEAT_VOOR_START');
});

test('worker_started EN latere heartbeat samen geven wel actief werk (positief pad, geen valse UNKNOWN)', () => {
  const raw = {
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
    actors: [{
      actor_id: 'a1',
      current_task: { task_id: 't1', worker_started: '2026-08-12T11:40:00Z', last_heartbeat: '2026-08-12T11:58:00Z' },
      closed: [], incidents: [],
    }],
    accounts: [],
  };
  const r = parseRuntimeFeed(raw, { now: NU });
  assert.equal(r.actors[0].current_task.active, true);
  assert.equal(r.summary.actors_actief, 1);
});

test('negatieve queue-count wordt geweigerd, record-lokaal, count wordt null', () => {
  const raw = {
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null },
    queue_counts: [{ name: 'q1', count: -1 }, { name: 'q2', count: 3 }],
    actors: [], accounts: [],
  };
  const r = parseRuntimeFeed(raw, { now: NU });
  assert.equal(r.queue_counts[0].valid, false);
  assert.equal(r.queue_counts[0].count, null);
  assert.equal(r.queue_counts[1].valid, true);
  assert.equal(r.queue_counts[1].count, 3);
  assert.ok(r.findings.some((f) => f.code === 'NEGATIEVE_QUEUECOUNT'));
});

test('dubbele task_id binnen closed[] van één actor: die regels worden geweigerd, rest van de actor blijft bruikbaar', () => {
  const raw = {
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
    actors: [{
      actor_id: 'a1', current_task: null,
      closed: [
        { task_id: 'dup', closed_at: '2026-08-12T11:00:00Z', result: 'OK' },
        { task_id: 'dup', closed_at: '2026-08-12T11:05:00Z', result: 'FAILED' },
        { task_id: 'uniek', closed_at: '2026-08-12T11:10:00Z', result: 'OK' },
      ],
      incidents: [],
    }],
    accounts: [],
  };
  const r = parseRuntimeFeed(raw, { now: NU });
  assert.equal(r.actors[0].closed.length, 1);
  assert.equal(r.actors[0].closed[0].task_id, 'uniek');
  assert.equal(r.actors[0].closed_geweigerd, 2);
});

test('niet-object input geeft SCHEMA_ONBEKEND in plaats van een crash', () => {
  for (const raw of [null, undefined, 'tekst', 42, [], true]) {
    const r = parseRuntimeFeed(raw, { now: NU });
    assert.equal(r.available, false);
    assert.equal(r.reason, 'SCHEMA_ONBEKEND');
  }
});

test('FRESHNESS is en blijft precies vier waarden, geen vijfde stilzwijgend toegevoegd', () => {
  assert.deepEqual(FRESHNESS, ['CURRENT', 'STALE', 'UNKNOWN', 'CONFLICT']);
});

test('elke CODES-sleutel is één niet-lege zin zonder pad of waarde erin', () => {
  for (const [code, zin] of Object.entries(CODES)) {
    assert.equal(typeof zin, 'string');
    assert.ok(zin.length > 0, code);
    assert.ok(!zin.includes('/Users/'), code);
  }
});

test('STALE_DREMPEL_MS en FUTURE_SKEW_MS zijn positieve, eindige getallen', () => {
  assert.ok(Number.isFinite(STALE_DREMPEL_MS) && STALE_DREMPEL_MS > 0);
  assert.ok(Number.isFinite(FUTURE_SKEW_MS) && FUTURE_SKEW_MS > 0);
});

// --- Regressietests op Codex-second-opinion-bevindingen (fixronde 1) ---------------------------

test('task_id in current_task en closed[] gaat door de sanitize-gate, net als actor_id', () => {
  const raw = {
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
    actors: [{
      actor_id: 'a1',
      current_task: { task_id: 'sk-ABCDEFGHIJKLMNOPQRST', worker_started: '2026-08-12T11:50:00Z', last_heartbeat: '2026-08-12T11:58:00Z' },
      closed: [{ task_id: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', closed_at: '2026-08-12T11:55:00Z', result: 'OK' }],
      incidents: [],
    }],
    accounts: [],
  };
  const r = parseRuntimeFeed(raw, { now: NU });
  assert.ok(!r.actors[0].current_task.task_id.includes('sk-ABCDEFGHIJKLMNOPQRST'));
  assert.ok(!r.actors[0].closed[0].task_id.includes('ghp_'));
});

test('findings[].path bevat nooit de rauwe actor_id/task_id ongesaneerd', () => {
  const raw = {
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
    actors: [{
      actor_id: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      current_task: null, closed: [], incidents: [],
    }, {
      actor_id: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      current_task: null, closed: [], incidents: [],
    }],
    accounts: [],
  };
  const r = parseRuntimeFeed(raw, { now: NU });
  for (const f of r.findings) assert.ok(!f.path.includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'), f.path);
});

test('dubbele task_id wordt óók gevonden als de claimende actor_id zelf al dubbel is', () => {
  const raw = {
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
    actors: [
      { actor_id: 'zelfde', current_task: { task_id: 'zelfde-taak', worker_started: '2026-08-12T11:50:00Z', last_heartbeat: '2026-08-12T11:58:00Z' }, closed: [], incidents: [] },
      { actor_id: 'zelfde', current_task: { task_id: 'zelfde-taak', worker_started: '2026-08-12T11:50:00Z', last_heartbeat: '2026-08-12T11:58:00Z' }, closed: [], incidents: [] },
    ],
    accounts: [],
  };
  const r = parseRuntimeFeed(raw, { now: NU });
  assert.equal(r.actors[0].current_task.identity, 'CONFLICT');
  assert.equal(r.actors[1].current_task.identity, 'CONFLICT');
  // een dubbelzinnige claim mag nooit als bewezen actief werk meetellen
  assert.equal(r.summary.actors_actief, 0);
});

test('closed[].task_id-dubbel wordt ook over verschillende actoren heen gevonden', () => {
  const raw = {
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
    actors: [
      { actor_id: 'a', current_task: null, closed: [{ task_id: 'gedeeld', closed_at: '2026-08-12T11:55:00Z', result: 'OK' }], incidents: [] },
      { actor_id: 'b', current_task: null, closed: [{ task_id: 'gedeeld', closed_at: '2026-08-12T11:56:00Z', result: 'FAILED' }], incidents: [] },
    ],
    accounts: [],
  };
  const r = parseRuntimeFeed(raw, { now: NU });
  assert.equal(r.actors[0].closed.length, 0);
  assert.equal(r.actors[0].closed_geweigerd, 1);
  assert.equal(r.actors[1].closed.length, 0);
  assert.equal(r.actors[1].closed_geweigerd, 1);
});

test('een current_task.task_id die elders als closed[] staat, is ook een conflict', () => {
  const raw = {
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
    actors: [
      { actor_id: 'a', current_task: { task_id: 'gedeeld', worker_started: '2026-08-12T11:50:00Z', last_heartbeat: '2026-08-12T11:58:00Z' }, closed: [], incidents: [] },
      { actor_id: 'b', current_task: null, closed: [{ task_id: 'gedeeld', closed_at: '2026-08-12T11:56:00Z', result: 'OK' }], incidents: [] },
    ],
    accounts: [],
  };
  const r = parseRuntimeFeed(raw, { now: NU });
  assert.equal(r.actors[0].current_task.identity, 'CONFLICT');
  assert.equal(r.actors[1].closed_geweigerd, 1);
});

test('een verouderde heartbeat ná worker_started bewijst geen actief werk', () => {
  const raw = {
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
    actors: [{
      actor_id: 'a1',
      current_task: { task_id: 't1', worker_started: '2026-08-12T11:00:00Z', last_heartbeat: '2026-08-12T11:10:00Z' },
      closed: [], incidents: [],
    }],
    accounts: [],
  };
  const r = parseRuntimeFeed(raw, { now: NU });
  assert.equal(r.actors[0].current_task.active, false);
  assert.equal(r.actors[0].current_task.active_reason, 'VEROUDERD');
  assert.equal(r.summary.actors_actief, 0);
});

test('een toekomstige heartbeat ná worker_started bewijst geen actief werk', () => {
  const raw = {
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
    actors: [{
      actor_id: 'a1',
      current_task: { task_id: 't1', worker_started: '2026-08-12T11:00:00Z', last_heartbeat: '2099-01-01T00:00:00Z' },
      closed: [], incidents: [],
    }],
    accounts: [],
  };
  const r = parseRuntimeFeed(raw, { now: NU });
  assert.equal(r.actors[0].current_task.active, false);
  assert.equal(r.actors[0].current_task.active_reason, 'TOEKOMST');
});

test('een heartbeat gelijk aan worker_started is geen bewijs van voortgang', () => {
  const raw = {
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
    actors: [{
      actor_id: 'a1',
      current_task: { task_id: 't1', worker_started: '2026-08-12T11:58:00Z', last_heartbeat: '2026-08-12T11:58:00Z' },
      closed: [], incidents: [],
    }],
    accounts: [],
  };
  const r = parseRuntimeFeed(raw, { now: NU });
  assert.equal(r.actors[0].current_task.active, false);
  assert.equal(r.actors[0].current_task.active_reason, 'HEARTBEAT_VOOR_START');
});

test('RUNTIME_FEED_SCHEMA is bevroren — in-process mutatie kan de fail-closed poort niet uitschakelen', () => {
  assert.throws(() => { RUNTIME_FEED_SCHEMA.additionalProperties = true; }, TypeError);
  assert.equal(RUNTIME_FEED_SCHEMA.additionalProperties, false);
  assert.throws(() => { RUNTIME_FEED_SCHEMA.$defs.Actor.additionalProperties = true; }, TypeError);
});
