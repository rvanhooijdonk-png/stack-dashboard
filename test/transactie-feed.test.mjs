/**
 * Tests voor het transactie-feed-adaptercontract (pagina 1 van de TRANSACTIE-TICKER/CODE-TICKER-
 * claim). Kleiner en platter dan runtime-feed.schema.json — één schrijver, geen actor-identiteit
 * die kan botsen — dus geen apart fixtures/-dossier: de scenario's staan inline per test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTransactieFeed, FRESHNESS, CODES, STALE_DREMPEL_MS, FUTURE_SKEW_MS } from '../scripts/lib/transactie-feed.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NU = new Date('2026-08-18T12:00:00.000Z');

async function schema() {
  return JSON.parse(await readFile(join(ROOT, 'data/transactie-feed.schema.json'), 'utf8'));
}

const EVENT_OK = { at: '2026-08-18T11:59:30Z', source: 'dispatcher', kind: 'DISPATCHER_RUN', detail: '3 orders gezien, 1 geseed' };

test('volledig-gezond: available, freshness CURRENT, events onaangeroerd doorgegeven', async () => {
  const raw = { generatedAt: '2026-08-18T12:00:00Z', events: [EVENT_OK] };
  const r = parseTransactieFeed(raw, await schema(), { now: NU });
  assert.equal(r.available, true);
  assert.equal(r.code, null);
  assert.equal(r.freshness, 'CURRENT');
  assert.deepEqual(r.events, [EVENT_OK]);
});

test('leeg-maar-geldig: nul events is geen schemafout', async () => {
  const raw = { generatedAt: '2026-08-18T12:00:00Z', events: [] };
  const r = parseTransactieFeed(raw, await schema(), { now: NU });
  assert.equal(r.available, true);
  assert.deepEqual(r.events, []);
});

test('onbekend-schema: extra veld op het top-niveau geeft SCHEMA_ONBEKEND, nooit een gok', async () => {
  const raw = { generatedAt: '2026-08-18T12:00:00Z', events: [], extra: 'verrassing' };
  const r = parseTransactieFeed(raw, await schema(), { now: NU });
  assert.equal(r.available, false);
  assert.equal(r.code, 'SCHEMA_ONBEKEND');
  assert.equal(r.freshness, 'UNKNOWN');
  assert.deepEqual(r.events, []);
});

test('onbekend-schema: event met een niet-toegestane kind-waarde geeft SCHEMA_ONBEKEND', async () => {
  const raw = { generatedAt: '2026-08-18T12:00:00Z', events: [{ ...EVENT_OK, kind: 'VERZONNEN_KIND' }] };
  const r = parseTransactieFeed(raw, await schema(), { now: NU });
  assert.equal(r.available, false);
  assert.equal(r.code, 'SCHEMA_ONBEKEND');
});

test('ontbrekend: geen generatedAt geeft UNKNOWN/ONTBREEKT, blijft available', async () => {
  const raw = { generatedAt: '', events: [] };
  const r = parseTransactieFeed(raw, await schema(), { now: NU });
  assert.equal(r.available, true);
  assert.equal(r.freshness, 'UNKNOWN');
  assert.equal(r.code, 'ONTBREEKT');
});

test('onleesbaar: generatedAt zonder tijdzone-aanduiding geeft UNKNOWN/ONLEESBAAR', async () => {
  const raw = { generatedAt: '2026-08-18 12:00:00', events: [] };
  const r = parseTransactieFeed(raw, await schema(), { now: NU });
  assert.equal(r.freshness, 'UNKNOWN');
  assert.equal(r.code, 'ONLEESBAAR');
});

test('toekomst: generatedAt ruim voorbij de klokspeling geeft UNKNOWN/TOEKOMST', async () => {
  const raw = { generatedAt: '2026-08-18T12:10:00Z', events: [] };
  const r = parseTransactieFeed(raw, await schema(), { now: NU, futureSkewMs: FUTURE_SKEW_MS });
  assert.equal(r.freshness, 'UNKNOWN');
  assert.equal(r.code, 'TOEKOMST');
});

test('binnen-klokspeling: een paar seconden in de toekomst blijft CURRENT', async () => {
  const raw = { generatedAt: '2026-08-18T12:00:02Z', events: [] };
  const r = parseTransactieFeed(raw, await schema(), { now: NU });
  assert.equal(r.freshness, 'CURRENT');
});

test('stale: generatedAt ouder dan de drempel geeft STALE/VEROUDERD', async () => {
  const raw = { generatedAt: '2026-08-18T11:00:00Z', events: [] };
  const r = parseTransactieFeed(raw, await schema(), { now: NU, staleMs: STALE_DREMPEL_MS });
  assert.equal(r.freshness, 'STALE');
  assert.equal(r.code, 'VEROUDERD');
});

test('grens-exact op de staleMs-drempel is nog niet stale, één ms erover wel', async () => {
  const s = await schema();
  const netAan = parseTransactieFeed({ generatedAt: '2026-08-18T11:57:00Z', events: [] }, s, { now: NU, staleMs: STALE_DREMPEL_MS });
  assert.equal(netAan.freshness, 'CURRENT');
  const netOver = parseTransactieFeed({ generatedAt: '2026-08-18T11:56:59.999Z', events: [] }, s, { now: NU, staleMs: STALE_DREMPEL_MS });
  assert.equal(netOver.freshness, 'STALE');
});

test('freshness- en codes-vocabulaire is en blijft gesloten', () => {
  assert.deepEqual(FRESHNESS, ['CURRENT', 'STALE', 'UNKNOWN']);
  assert.deepEqual(Object.keys(CODES).sort(), ['ONLEESBAAR', 'ONTBREEKT', 'SCHEMA_ONBEKEND', 'TOEKOMST', 'VEROUDERD'].sort());
});
