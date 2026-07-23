import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toPublicSnapshot } from '../scripts/build.mjs';

// Een contract dat niemand controleert, is een wens. Deze test is met opzet klein: geen
// validator-afhankelijkheid, wél de twee eigenschappen die er hier toe doen — géén onbekende
// velden (want additionalProperties: false is precies de belofte "dit lekt niets extra's")
// en geen ontbrekende verplichte velden.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(await readFile(join(ROOT, 'contracts/dashboard-snapshot.schema.json'), 'utf8'));
const fixture = JSON.parse(await readFile(join(ROOT, 'data/fixture.json'), 'utf8'));

test('de fixture voldoet aan het gepubliceerde contract', () => {
  const toegestaan = new Set(Object.keys(schema.properties));
  const onbekend = Object.keys(fixture).filter((k) => !toegestaan.has(k));
  assert.deepEqual(onbekend, [], 'onbekende topvelden zijn per definitie ongereviewde publicatie');
  for (const veld of schema.required) {
    assert.ok(veld in fixture, `verplicht veld ontbreekt: ${veld}`);
  }
});

test('evidence draagt nooit meer dan de vier toegestane velden', () => {
  const toegestaan = new Set(Object.keys(schema.$defs.evidence.properties));
  for (const [sectie, waarde] of Object.entries(fixture)) {
    if (!waarde || typeof waarde !== 'object' || !('evidence' in waarde)) continue;
    const onbekend = Object.keys(waarde.evidence).filter((k) => !toegestaan.has(k));
    assert.deepEqual(onbekend, [], `${sectie}.evidence lekt extra velden`);
  }
});

test('de DTO-uitvoer van build.mjs blijft binnen het contract', async () => {
  const raw = JSON.parse(await readFile(join(ROOT, 'test/fixtures/raw-snapshot.json'), 'utf8'));
  const dto = toPublicSnapshot(raw);
  const toegestaan = new Set(Object.keys(schema.properties));
  assert.deepEqual(Object.keys(dto).filter((k) => !toegestaan.has(k)), []);
  for (const veld of schema.required) assert.ok(veld in dto, `ontbreekt: ${veld}`);
});
