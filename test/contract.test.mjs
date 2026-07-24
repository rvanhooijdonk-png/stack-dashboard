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

// --- Bevindingen uit de vierde dubbele review van 23-07-2026 (Codex + Gemini) ---

test('een veld met een prototypenaam is óók een onbekend veld', () => {
  // `!(key in properties)` gaf false voor `toString`: de eigenschap zat op Object.prototype.
  const vies = { ...toPublicSnapshot(raw), toString: 'PROBE' };
  assert.match(validate(schema, vies).join(' '), /toString: onbekend veld/);
});

test('het schema wordt gekeurd, ook waar geen data staat', () => {
  // Onder een leeg array werd een onbekend trefwoord nooit bereikt: de validator liep mee met
  // de instance in plaats van met het schema. Een lege lijst betekende dus "contract in orde".
  const fouten = validate({ type: 'array', items: { type: 'string', maxLength: 3 } }, []);
  assert.match(fouten.join(' '), /niet-ondersteund trefwoord "maxLength"/);
});

test('een $ref die nergens heen wijst is een fout, geen leeg schema', () => {
  const fouten = validate({ $defs: {}, $ref: '#/$defs/toString' }, { wat: 'dan ook' });
  assert.match(fouten.join(' '), /onbekende \$ref/);
});

test('een $ref-keten wordt helemaal gevolgd', () => {
  const ketenSchema = {
    $defs: { binnen: { type: 'string' }, buiten: { $ref: '#/$defs/binnen' } },
    $ref: '#/$defs/buiten',
  };
  assert.deepEqual(validate(ketenSchema, 'tekst'), []);
  assert.match(validate(ketenSchema, 42).join(' '), /verwacht string, kreeg number/);
});

test('naast een $ref blijven de geërfde properties gelden', () => {
  // Een platte spread liet de lokale `properties` de geërfde overschrijven, waarna geldige
  // geërfde velden als "onbekend veld" werden afgekeurd.
  const s = {
    $defs: { basis: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false } },
    $ref: '#/$defs/basis',
    properties: { b: { type: 'number' } },
  };
  assert.deepEqual(validate(s, { a: 'x', b: 1 }), []);
  assert.match(validate(s, { c: true }).join(' '), /c: onbekend veld/);
});

test('additionalProperties:false geldt ook zonder properties-blok', () => {
  const fouten = validate({ type: 'object', additionalProperties: false }, { wat: 'dan ook' });
  assert.match(fouten.join(' '), /wat: onbekend veld/);
});

// --- Bevindingen uit de vijfde ronde (Codex, 23-07-2026) — vijf schemavormen die "geldig" heetten ---

test('een schemavorm die de validator niet kan controleren, keurt hij af', () => {
  const afgekeurd = (schema, value) => assert.ok(validate(schema, value).length > 0, JSON.stringify(schema));
  afgekeurd(false, 'wat dan ook');                                   // booleanschema
  afgekeurd({ type: 'array', items: [] }, ['wat dan ook']);          // tuple-items
  afgekeurd({ type: 'object', additionalProperties: { type: 'string' } }, { x: 42 });
  afgekeurd({ type: 'object', properties: { x: { type: 'string', pattern: '[' } } }, {});
});

test('naast een $ref blijven ook de geërfde required-velden gelden', () => {
  const s = {
    $defs: { basis: { type: 'object', required: ['a'], properties: { a: { type: 'string' } } } },
    $ref: '#/$defs/basis',
    required: ['b'],
    properties: { b: { type: 'number' } },
  };
  assert.match(validate(s, { b: 1 }).join(' '), /\/a: verplicht veld ontbreekt/);
  assert.deepEqual(validate(s, { a: 'x', b: 1 }), []);
});

test('het contract eist de datumvelden die de DTO altijd levert', () => {
  const zonderDatum = structuredClone(toPublicSnapshot(raw));
  delete zonderDatum.tracks.tracks[0].lastReportAt;
  delete zonderDatum.ci.lights[0].at;
  const fouten = validate(schema, zonderDatum).join(' ');
  assert.match(fouten, /lastReportAt: verplicht veld ontbreekt/);
  assert.match(fouten, /at: verplicht veld ontbreekt/);
});

// --- v2.1 (24-07-2026): categorie-enum en tracks-vorm zijn nu contractueel afgedwongen ---

test('een categorie buiten de gesloten enum valt door de contractcontrole', () => {
  const vies = structuredClone(toPublicSnapshot(raw));
  vies.decisions.entries[0].category = 'klant-geheim';
  assert.match(validate(schema, vies).join(' '), /category/);
});

test('het contract eist het afgeleide categorielabel op besluiten én beslispunten', () => {
  const zonder = structuredClone(toPublicSnapshot(raw));
  delete zonder.decisions.entries[0].category;
  delete zonder.tracker.decisionPoints[0].category;
  const fouten = validate(schema, zonder).join(' ');
  assert.match(fouten, /category: verplicht veld ontbreekt/);
});
