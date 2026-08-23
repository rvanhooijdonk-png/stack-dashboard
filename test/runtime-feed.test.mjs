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
  STALE_DREMPEL_MS, FUTURE_SKEW_MS, parseTijdstempel,
} from '../scripts/lib/runtime-feed.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXDIR = join(ROOT, 'test/fixtures/runtime-feed');
const NU = new Date('2026-08-12T12:00:00.000Z');
const PICKUP_OK = { proven: true, at: '2026-08-12T11:41:00Z', evidence_ref: { kind: 'RECEIPT_ID', ref: 'evidence-1', url: null } };

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

test('geen actief werk zonder worker_started (pickup bewezen, maar geen start)', () => {
  const raw = {
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
    actors: [{
      actor_id: 'a1',
      current_task: { task_id: 't1', worker_started: null, last_heartbeat: '2026-08-12T11:58:00Z', pickup: PICKUP_OK },
      closed: [], incidents: [],
    }],
    accounts: [],
  };
  const r = parseRuntimeFeed(raw, { now: NU });
  assert.equal(r.actors[0].current_task.active, false);
  assert.equal(r.actors[0].current_task.active_reason, 'PICKUP_ZONDER_START');
});

test('order/start zonder bewezen pickup is niet actief (ORDERED_PICKUP_UNPROVEN)', () => {
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
  assert.equal(r.actors[0].current_task.active, false);
  assert.equal(r.actors[0].current_task.active_reason, 'ORDERED_PICKUP_UNPROVEN');
  assert.equal(r.summary.actors_actief, 0);
});

test('pickup bewezen met proven:true maar ongeldige evidence_ref telt niet als bewezen', () => {
  const raw = {
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
    actors: [{
      actor_id: 'a1',
      current_task: {
        task_id: 't1', worker_started: '2026-08-12T11:40:00Z', last_heartbeat: '2026-08-12T11:58:00Z',
        pickup: { proven: true, at: null, evidence_ref: null },
      },
      closed: [], incidents: [],
    }],
    accounts: [],
  };
  const r = parseRuntimeFeed(raw, { now: NU });
  assert.equal(r.actors[0].current_task.active, false);
  assert.equal(r.actors[0].current_task.active_reason, 'ORDERED_PICKUP_UNPROVEN');
});

test('geen actief werk zonder latere heartbeat (worker_started zonder last_heartbeat)', () => {
  const raw = {
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
    actors: [{
      actor_id: 'a1',
      current_task: {
        task_id: 't1', worker_started: '2026-08-12T11:40:00Z', last_heartbeat: null,
        pickup: { proven: true, at: '2026-08-12T11:41:00Z', evidence_ref: PICKUP_OK.evidence_ref },
      },
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
      current_task: {
        task_id: 't1', worker_started: '2026-08-12T11:50:00Z', last_heartbeat: '2026-08-12T11:40:00Z',
        pickup: { proven: true, at: '2026-08-12T11:50:00Z', evidence_ref: PICKUP_OK.evidence_ref },
      },
      closed: [], incidents: [],
    }],
    accounts: [],
  };
  const r = parseRuntimeFeed(raw, { now: NU });
  assert.equal(r.actors[0].current_task.active, false);
  assert.equal(r.actors[0].current_task.active_reason, 'HEARTBEAT_VOOR_START');
});

test('worker_started, bewezen pickup EN latere heartbeat samen geven wel actief werk (positief pad, geen valse UNKNOWN)', () => {
  const raw = {
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
    actors: [{
      actor_id: 'a1',
      current_task: { task_id: 't1', worker_started: '2026-08-12T11:40:00Z', last_heartbeat: '2026-08-12T11:58:00Z', pickup: PICKUP_OK },
      closed: [], incidents: [],
    }],
    accounts: [],
  };
  const r = parseRuntimeFeed(raw, { now: NU });
  assert.equal(r.actors[0].current_task.active, true);
  assert.equal(r.summary.actors_actief, 1);
});

test('AFGEROND OK vereist tegelijk een geldige evidence_ref EN een geordende worker_started', () => {
  const basis = {
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [], accounts: [],
  };
  const zonderBewijs = parseRuntimeFeed({
    ...basis,
    actors: [{ actor_id: 'a1', current_task: null,
      closed: [{ task_id: 'c1', closed_at: '2026-08-12T11:00:00Z', result: 'OK' }], incidents: [] }],
  }, { now: NU });
  assert.equal(zonderBewijs.actors[0].closed[0].display_result, 'BEWIJS_ONVOLLEDIG');
  assert.equal(zonderBewijs.actors[0].closed[0].display_reason, 'GEEN_TERMINAL_RECEIPT');
  assert.equal(zonderBewijs.actors[0].closed[0].result, 'OK');

  const metBewijs = parseRuntimeFeed({
    ...basis,
    actors: [{ actor_id: 'a1', current_task: null,
      closed: [{
        task_id: 'c1', closed_at: '2026-08-12T11:00:00Z', result: 'OK',
        worker_started: '2026-08-12T10:30:00Z',
        evidence_ref: { kind: 'ISSUE_COMMENT_ID', ref: '918273645', url: null },
      }], incidents: [] }],
  }, { now: NU });
  assert.equal(metBewijs.actors[0].closed[0].display_result, 'OK');
});

test('een afgeronde taak vóór zijn eigen worker_started wordt UNKNOWN, ongeacht het geclaimde resultaat', () => {
  const r = parseRuntimeFeed({
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [], accounts: [],
    actors: [{ actor_id: 'a1', current_task: null,
      closed: [{
        task_id: 'c1', closed_at: '2026-08-12T10:00:00Z', result: 'OK',
        worker_started: '2026-08-12T10:30:00Z',
        evidence_ref: { kind: 'COMMIT_SHA', ref: 'deadbeef', url: null },
      }], incidents: [] }],
  }, { now: NU });
  assert.equal(r.actors[0].closed[0].display_result, 'UNKNOWN');
  assert.equal(r.actors[0].closed[0].display_reason, 'ONGELDIGE_TERMINAL_ORDERING');
  assert.ok(r.findings.some((f) => f.code === 'ONGELDIGE_TERMINAL_ORDERING'));
});

test('FAILED en TIMEOUT blijven eigen terminale statussen, ook zonder evidence_ref', () => {
  const r = parseRuntimeFeed({
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [], accounts: [],
    actors: [{ actor_id: 'a1', current_task: null,
      closed: [
        { task_id: 'c1', closed_at: '2026-08-12T11:00:00Z', result: 'FAILED' },
        { task_id: 'c2', closed_at: '2026-08-12T11:05:00Z', result: 'TIMEOUT' },
      ], incidents: [] }],
  }, { now: NU });
  assert.equal(r.actors[0].closed[0].display_result, 'FAILED');
  assert.equal(r.actors[0].closed[1].display_result, 'TIMEOUT');
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
      current_task: {
        task_id: 't1', worker_started: '2026-08-12T11:00:00Z', last_heartbeat: '2026-08-12T11:10:00Z',
        pickup: { proven: true, at: '2026-08-12T11:05:00Z', evidence_ref: PICKUP_OK.evidence_ref },
      },
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
      current_task: { task_id: 't1', worker_started: '2026-08-12T11:00:00Z', last_heartbeat: '2099-01-01T00:00:00Z', pickup: PICKUP_OK },
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
      current_task: {
        task_id: 't1', worker_started: '2026-08-12T11:58:00Z', last_heartbeat: '2026-08-12T11:58:00Z',
        pickup: { proven: true, at: '2026-08-12T11:58:00Z', evidence_ref: PICKUP_OK.evidence_ref },
      },
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

// PR69-correctie B5 — pickup.at is zelf een claim en moet dezelfde waarheidsketen doorlopen als
// worker_started/last_heartbeat: onleesbaar/toekomstig/vóór start/ná heartbeat mag nooit stil
// ACTIEF worden. Dit zijn de exacte vier vijandige controles uit reviewcomment 5290091023.
for (const [naam, pickupAt] of [
  ['ontbreekt (null)', null],
  ['is geen leesbaar tijdstip', 'niet-een-tijdstip'],
  ['ligt in de toekomst', '2099-01-01T00:00:00Z'],
]) {
  test(`B5: pickup.at die ${naam} geeft PICKUP_TIJD_ONGELDIG, geen actief werk`, () => {
    const raw = {
      measured_at: '2026-08-12T11:59:00Z', control_host: null,
      processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
      actors: [{
        actor_id: 'a1',
        current_task: {
          task_id: 't1', worker_started: '2026-08-12T11:40:00Z', last_heartbeat: '2026-08-12T11:58:00Z',
          pickup: { proven: true, at: pickupAt, evidence_ref: PICKUP_OK.evidence_ref },
        },
        closed: [], incidents: [],
      }],
      accounts: [],
    };
    const r = parseRuntimeFeed(raw, { now: NU });
    assert.equal(r.actors[0].current_task.active, false);
    assert.equal(r.actors[0].current_task.active_reason, 'PICKUP_TIJD_ONGELDIG');
  });
}

test('B5: pickup.at ná last_heartbeat geeft PICKUP_NA_HEARTBEAT, geen actief werk', () => {
  const raw = {
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
    actors: [{
      actor_id: 'a1',
      current_task: {
        task_id: 't1', worker_started: '2026-08-12T11:40:00Z', last_heartbeat: '2026-08-12T11:50:00Z',
        pickup: { proven: true, at: '2026-08-12T11:55:00Z', evidence_ref: PICKUP_OK.evidence_ref },
      },
      closed: [], incidents: [],
    }],
    accounts: [],
  };
  const r = parseRuntimeFeed(raw, { now: NU });
  assert.equal(r.actors[0].current_task.active, false);
  assert.equal(r.actors[0].current_task.active_reason, 'PICKUP_NA_HEARTBEAT');
});

test('B5: pickup.at vóór worker_started geeft PICKUP_VOOR_START, geen actief werk', () => {
  const raw = {
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
    actors: [{
      actor_id: 'a1',
      current_task: {
        task_id: 't1', worker_started: '2026-08-12T11:40:00Z', last_heartbeat: '2026-08-12T11:58:00Z',
        pickup: { proven: true, at: '2026-08-12T11:35:00Z', evidence_ref: PICKUP_OK.evidence_ref },
      },
      closed: [], incidents: [],
    }],
    accounts: [],
  };
  const r = parseRuntimeFeed(raw, { now: NU });
  assert.equal(r.actors[0].current_task.active, false);
  assert.equal(r.actors[0].current_task.active_reason, 'PICKUP_VOOR_START');
});

// PR69-correctie B7 — een gesloten kind-vocabulaire alleen bewijst niet dat een ref onveranderlijk
// is: `{kind:'COMMIT_SHA', ref:'main'}` is exact het geval uit reviewcomment 5290091023 (een
// geldig kind met een muteerbare branchnaam als ref). Elke kind heeft nu ook een vormregel, en een
// muteerbare naam wordt geweigerd ongeacht welk kind erbij geclaimd wordt.
for (const kind of ['COMMIT_SHA', 'RECEIPT_ID', 'EVENT_ID']) {
  test(`B7: {kind:'${kind}', ref:'main'} is geen bewijs — muteerbare ref geweigerd ongeacht kind`, () => {
    const raw = {
      measured_at: '2026-08-12T11:59:00Z', control_host: null,
      processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
      actors: [{
        actor_id: 'a1',
        current_task: {
          task_id: 't1', worker_started: '2026-08-12T11:40:00Z', last_heartbeat: '2026-08-12T11:58:00Z',
          pickup: { proven: true, at: '2026-08-12T11:41:00Z', evidence_ref: { kind, ref: 'main', url: null } },
        },
        closed: [], incidents: [],
      }],
      accounts: [],
    };
    const r = parseRuntimeFeed(raw, { now: NU });
    assert.equal(r.actors[0].current_task.active, false);
    assert.equal(r.actors[0].current_task.active_reason, 'ORDERED_PICKUP_UNPROVEN');
  });
}

test('B7: evidence_ref.ref die niet bij de vorm van zijn kind past wordt geweigerd (ISSUE_COMMENT_ID moet numeriek zijn)', () => {
  const raw = {
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
    actors: [{
      actor_id: 'a1',
      current_task: {
        task_id: 't1', worker_started: '2026-08-12T11:40:00Z', last_heartbeat: '2026-08-12T11:58:00Z',
        pickup: { proven: true, at: '2026-08-12T11:41:00Z', evidence_ref: { kind: 'ISSUE_COMMENT_ID', ref: 'ic-1', url: null } },
      },
      closed: [], incidents: [],
    }],
    accounts: [],
  };
  const r = parseRuntimeFeed(raw, { now: NU });
  assert.equal(r.actors[0].current_task.active, false);
  assert.equal(r.actors[0].current_task.active_reason, 'ORDERED_PICKUP_UNPROVEN');
});

test('B7: een echte numerieke ISSUE_COMMENT_ID en een echte hex COMMIT_SHA blijven wel geldig bewijs', () => {
  for (const ev of [
    { kind: 'ISSUE_COMMENT_ID', ref: '5290091023', url: null },
    { kind: 'COMMIT_SHA', ref: '47cac37df085f01d3f537fbc8a65735249139c54', url: null },
  ]) {
    const raw = {
      measured_at: '2026-08-12T11:59:00Z', control_host: null,
      processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
      actors: [{
        actor_id: 'a1',
        current_task: {
          task_id: 't1', worker_started: '2026-08-12T11:40:00Z', last_heartbeat: '2026-08-12T11:58:00Z',
          pickup: { proven: true, at: '2026-08-12T11:41:00Z', evidence_ref: ev },
        },
        closed: [], incidents: [],
      }],
      accounts: [],
    };
    const r = parseRuntimeFeed(raw, { now: NU });
    assert.equal(r.actors[0].current_task.active, true, ev.kind);
  }
});

// PR69-correctie B7 (Codex-oordeel op deze correctie zelf, herzien) — Codex signaleerde terecht
// dat een afgekorte hex-SHA niet te onderscheiden is van een toevallig hex-achtige, muteerbare
// branchnaam. De volle 40-teken SHA-1 zou dat sluiten, maar botst met de bestaande sanitize-gate
// (`sanitize.mjs` HIGH_ENTROPY): élke losstaande 40+ tekens hoge-entropiestring wordt daar altijd
// naar `[REDACTED]` geredigeerd (Gemini-review 23-07-2026), dus een eis van precies 40 tekens zou
// élk geldig COMMIT_SHA-bewijs juist onleesbaar maken in de publieke cockpit. Zie de toelichting
// bij `EVIDENCE_REF_SHAPE.COMMIT_SHA` in runtime-feed.mjs. In plaats daarvan blijft de vorm
// {7,40} tekens, maar uitsluitend kleine letters — echte git-SHA-output is altijd lowercase, dus
// dit vangt in elk geval het geval uit reviewcomment 5290091023 (`main`, al gedekt door de
// MUTABLE_REF_DENYLIST) én elke hoofdletter-bevattende hex-lookalike zonder de sanitize-gate te
// breken.
for (const nietGeldig of ['ABC1234', 'DeadBeef', '123456', '']) {
  test(`B7: ongeldige hex-SHA-vorm '${nietGeldig}' is geen bewijs`, () => {
    const raw = {
      measured_at: '2026-08-12T11:59:00Z', control_host: null,
      processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
      actors: [{
        actor_id: 'a1',
        current_task: {
          task_id: 't1', worker_started: '2026-08-12T11:40:00Z', last_heartbeat: '2026-08-12T11:58:00Z',
          pickup: { proven: true, at: '2026-08-12T11:41:00Z', evidence_ref: { kind: 'COMMIT_SHA', ref: nietGeldig, url: null } },
        },
        closed: [], incidents: [],
      }],
      accounts: [],
    };
    const r = parseRuntimeFeed(raw, { now: NU });
    assert.equal(r.actors[0].current_task.active, false);
    assert.equal(r.actors[0].current_task.active_reason, 'ORDERED_PICKUP_UNPROVEN');
  });
}

test("B7: een geldige AFGEKORTE lowercase hex-SHA ('a1b2c3d') blijft geldig bewijs — nodig omdat de sanitize-gate volle 40-teken SHA's redigeert", () => {
  const raw = {
    measured_at: '2026-08-12T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
    actors: [{
      actor_id: 'a1',
      current_task: {
        task_id: 't1', worker_started: '2026-08-12T11:40:00Z', last_heartbeat: '2026-08-12T11:58:00Z',
        pickup: { proven: true, at: '2026-08-12T11:41:00Z', evidence_ref: { kind: 'COMMIT_SHA', ref: 'a1b2c3d', url: null } },
      },
      closed: [], incidents: [],
    }],
    accounts: [],
  };
  const r = parseRuntimeFeed(raw, { now: NU });
  assert.equal(r.actors[0].current_task.active, true);
});

// PR69-correctie B5 (Codex-oordeel op deze correctie zelf) — V8's Date.parse normaliseert een
// onmogelijke kalenderdatum (30 februari bestaat niet) in plaats van hem te weigeren; zonder de
// kalendercheck in parseTijdstempel zou dit stilzwijgend als een geldig, verschoven tijdstip
// doorgaan en ACTIEF kunnen worden — precies de vijandige claim die PICKUP_TIJD_ONGELDIG moet
// vangen.
for (const [naam, onmogelijk] of [
  ['30 februari', '2026-02-30T11:41:00Z'],
  ['32 januari', '2026-01-32T11:41:00Z'],
  ['maand 13', '2026-13-01T11:41:00Z'],
  ['29 februari in een niet-schrikkeljaar', '2026-02-29T11:41:00Z'],
]) {
  test(`B5: pickup.at op een onmogelijke kalenderdatum (${naam}) geeft PICKUP_TIJD_ONGELDIG, geen actief werk`, () => {
    const raw = {
      measured_at: '2026-08-12T11:59:00Z', control_host: null,
      processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
      actors: [{
        actor_id: 'a1',
        current_task: {
          task_id: 't1', worker_started: '2026-08-12T11:40:00Z', last_heartbeat: '2026-08-12T11:58:00Z',
          pickup: { proven: true, at: onmogelijk, evidence_ref: PICKUP_OK.evidence_ref },
        },
        closed: [], incidents: [],
      }],
      accounts: [],
    };
    const r = parseRuntimeFeed(raw, { now: NU });
    assert.equal(r.actors[0].current_task.active, false);
    assert.equal(r.actors[0].current_task.active_reason, 'PICKUP_TIJD_ONGELDIG');
  });
}

test('B5: een geldige schrikkeldag (29 februari 2024) blijft wel een leesbaar tijdstip', () => {
  const raw = {
    measured_at: '2024-02-29T11:59:00Z', control_host: null,
    processes: { planner: null, watcher: null, supervisor: null }, queue_counts: [],
    actors: [{
      actor_id: 'a1',
      current_task: {
        task_id: 't1', worker_started: '2024-02-29T11:40:00Z', last_heartbeat: '2024-02-29T11:58:00Z',
        pickup: { proven: true, at: '2024-02-29T11:41:00Z', evidence_ref: PICKUP_OK.evidence_ref },
      },
      closed: [], incidents: [],
    }],
    accounts: [],
  };
  const r = parseRuntimeFeed(raw, { now: new Date('2024-02-29T12:00:00Z') });
  assert.equal(r.actors[0].current_task.active, true);
});

// Codex ronde 13 (P2) -- `date-time` in JSON Schema staat op RFC 3339, en daar loopt het uur van 00
// t/m 23 (§5.6). V8 rekt dat op: `T24:00:00.000Z` rolt stilzwijgend door naar middernacht van de
// volgende dag. Dat is dezelfde stille normalisatie als 30 februari hierboven, en met een
// millisecondevergelijking op de bouwidentiteit bond zo'n stempel als DEZELFDE bouw als de pagina
// van middernacht erna. Reproductie van Codex over http: pagina `2026-08-23T00:00:00.000Z`,
// statusbestand `2026-08-22T24:00:00.000Z`, één VERIFIED_CURRENT bron -> `verschil ... 0 s`, exit 0.
test('parseTijdstempel weigert het uur 24, dat V8 stilzwijgend doorrolt', () => {
  assert.equal(parseTijdstempel('2026-08-22T24:00:00.000Z'), null,
    'RFC 3339 kent geen uur 24; V8 maakt er middernacht van de volgende dag van');
  assert.equal(Date.parse('2026-08-22T24:00:00.000Z'), Date.parse('2026-08-23T00:00:00.000Z'),
    'en juist dat maakt het gevaarlijk: het bindt op de milliseconde aan een ander tijdstip');
  assert.equal(parseTijdstempel('2026-08-23T00:00:00.000Z'), Date.parse('2026-08-23T00:00:00.000Z'),
    'de geldige schrijfwijze van hetzelfde moment blijft gewoon leesbaar');
});

// Dezelfde begrenzing, de andere klokdelen en de zone. Minuten en seconden weigerde `Date.parse`
// al; ze staan nu ook in de vorm, zodat de eis leesbaar is in plaats van afhankelijk van V8.
for (const [naam, ongeldig] of [
  ['uur 24', '2026-08-22T24:00:00.000Z'],
  ['uur 99', '2026-08-22T99:00:00.000Z'],
  ['minuut 60', '2026-08-22T12:60:00.000Z'],
  ['seconde 60 (schrikkelseconde)', '2026-08-22T23:59:60.000Z'],
  ['zone-uur 24', '2026-08-22T12:00:00.000+24:00'],
  ['zone-minuut 60', '2026-08-22T12:00:00.000+02:60'],
]) {
  test(`parseTijdstempel weigert een klokdeel buiten zijn bereik (${naam})`, () => {
    assert.equal(parseTijdstempel(ongeldig), null);
  });
}

// Negatieve controle op diezelfde begrenzing: de randen die WEL geldig zijn moeten blijven werken,
// anders is de vorm te streng geworden en verdwijnen echte bouwstempels stilletjes in ONLEESBAAR.
for (const geldig of [
  '2026-08-22T00:00:00.000Z',
  '2026-08-22T23:59:59.999Z',
  '2026-08-22T23:59:59.999+23:59',
  '2026-08-22T12:00:00.000-05:30',
  '2026-08-22T12:00:00Z',
]) {
  test(`parseTijdstempel houdt de geldige rand leesbaar (${geldig})`, () => {
    assert.equal(parseTijdstempel(geldig), Date.parse(geldig));
  });
}
