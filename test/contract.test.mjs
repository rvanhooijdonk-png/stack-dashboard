import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toPublicSnapshot } from '../scripts/build.mjs';
import { validate } from '../scripts/lib/validate.mjs';

// Een contract dat niemand controleert, is een wens. De eerste versie van deze test keek alleen
// naar topniveau-sleutelnamen — die had een fout diep in een sectie nooit gezien. Sinds de derde
// review (Codex, 23-07-2026) loopt alles door een echte schemavalidatie.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = async (p) => JSON.parse(await readFile(join(ROOT, p), 'utf8'));

const schema = await read('contracts/dashboard-snapshot.schema.json');
const statusSchema = await read('contracts/status-json.schema.json');
const fixture = await read('data/fixture.json');
const raw = await read('test/fixtures/raw-snapshot.json');

test('de fixture voldoet aan het gepubliceerde contract', () => {
  assert.deepEqual(validate(schema, fixture), []);
});

test('de DTO-uitvoer van build.mjs voldoet aan het contract', () => {
  assert.deepEqual(validate(schema, toPublicSnapshot(raw)), []);
});

test('status.json heeft zijn eigen contract — en voldoet eraan', () => {
  const dto = toPublicSnapshot(raw);
  const status = {
    contractVersion: dto.contractVersion,
    generatedAt: dto.generatedAt,
    overallStatus: dto.overallStatus,
    sources: dto.sources,
  };
  assert.deepEqual(validate(statusSchema, status), []);
  // Het snapshot-schema eist acht secties die status.json bewust niet heeft: één schema voor
  // twee bestanden kon nooit slagen. Deze assertie legt vast dat het twee contracten blijven.
  assert.ok(validate(schema, status).length > 0, 'status.json is géén volledige snapshot');
});

test('een onbekend veld in de DTO breekt de contractcontrole', () => {
  const vies = { ...toPublicSnapshot(raw), stiekemVeld: 'ongereviewde publicatie' };
  const fouten = validate(schema, vies);
  assert.equal(fouten.length, 1);
  assert.match(fouten[0], /onbekend veld/);
});

test('de validator weigert een schema met een trefwoord dat hij niet kent', () => {
  // Anders zou een `not`/`oneOf` in het contract stilzwijgend genegeerd worden — een gate die
  // niets doet is gevaarlijker dan geen gate.
  const fouten = validate({ type: 'object', oneOf: [] }, {});
  assert.match(fouten.join(' '), /niet-ondersteund trefwoord "oneOf"/);
});
