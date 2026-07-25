/**
 * PLANNING-BRON — de vertaler van TRECHTER's backlog-feed naar het plaat-schema (§B).
 *
 * Elke poort krijgt hier zijn eigen test, want de vertaler is de enige plek waar honderden regels
 * vrije brontekst de publieke pagina binnenkomen. De rode draad van de tests: nooit iets raden, en
 * bij twijfel de HELE plaat afkeuren in plaats van een half-gevulde lijst tonen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { vertaalTaak, vertaalBouwlijst, BRON_STATUS_READY, PLAAT_STATUS_GEPLAND } from '../scripts/lib/planning-bron.mjs';
import { toPublicPlanning } from '../scripts/lib/planning.mjs';
import { validate } from '../scripts/lib/validate.mjs';
import { renderHtml } from '../scripts/lib/render.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(join(ROOT, 'data/fixture.json'), 'utf8'));
const schema = JSON.parse(await readFile(join(ROOT, 'contracts/dashboard-snapshot.schema.json'), 'utf8'));
const BUILD = '2026-07-25T12:00:00.000Z';

/** Eén geldige bron-taak, zoals TRECHTER die levert. Losse velden per test overschreven. */
const taak = (over = {}) => ({
  task_id: 'T-0001',
  feature_label: 'Voorbeeldregel uit de bouwlijst',
  verwachte_duur: '1-2 dagen',
  richard_poort: 'geen',
  prioriteit_tier: 3,
  status: BRON_STATUS_READY,
  is_twijfel: false,
  afhankelijkheden: 2,
  ...over,
});

const feed = (taken, over = {}) => JSON.stringify({
  meetlat: { sha: 'e0049dcabc123def456' },
  totaal_bouwbaar: taken.length + 3,
  publish_veilig: taken.length,
  taken,
  ...over,
});

// --- de kern-afspraak: een backlog levert alleen geplande regels ---

test('een geldige bron-taak wordt een geplande plaatregel zonder rol en zonder datum', () => {
  const f = vertaalTaak(taak(), 0);
  assert.equal(f.status, PLAAT_STATUS_GEPLAND);
  assert.equal(f.worker, null);
  assert.equal(f.throughput_klasse, null);
  assert.equal(f.af_sinds, null);
  assert.equal(f.afhankelijkheid, null, 'een AANTAL afhankelijkheden is geen tekst — niets verzinnen');
  assert.equal(f.duur_indicatie, '1-2 dagen');
  assert.equal(f.tier0, false);
});

test('alleen prioriteit_tier 0 is spoedspoor — een slordige waarde markeert niets', () => {
  assert.equal(vertaalTaak(taak({ prioriteit_tier: 0 }), 0).tier0, true);
  assert.equal(vertaalTaak(taak({ prioriteit_tier: 2 }), 0).tier0, false);
});

// --- harde poorten: liever een lege plaat dan regels waarvan de betekenis niet vaststaat ---

test('een status buiten READY keurt de regel af', () => {
  assert.throws(() => vertaalTaak(taak({ status: 'DONE' }), 0), /niet READY/);
  assert.throws(() => vertaalTaak(taak({ status: undefined }), 0), /niet READY/);
});

test('is_twijfel moet EXPLICIET false zijn — afwezigheid is geen bewijs van geen twijfel', () => {
  assert.throws(() => vertaalTaak(taak({ is_twijfel: true }), 0), /is_twijfel=false/);
  assert.throws(() => vertaalTaak(taak({ is_twijfel: undefined }), 0), /is_twijfel=false/);
  assert.throws(() => vertaalTaak(taak({ is_twijfel: null }), 0), /is_twijfel=false/);
});

test('een regel zonder task_id of zonder leesbare naam wordt afgekeurd', () => {
  assert.throws(() => vertaalTaak(taak({ task_id: '' }), 0), /mist een task_id/);
  assert.throws(() => vertaalTaak(taak({ task_id: 42 }), 0), /mist een task_id/);
  assert.throws(() => vertaalTaak(taak({ feature_label: '  ' }), 0), /leesbare naam/);
  assert.throws(() => vertaalTaak(null, 0), /geen object/);
});

test('een prioriteit_tier die geen niet-negatief geheel getal is, wordt afgekeurd', () => {
  assert.throws(() => vertaalTaak(taak({ prioriteit_tier: '0' }), 0), /prioriteit_tier/);
  assert.throws(() => vertaalTaak(taak({ prioriteit_tier: -1 }), 0), /prioriteit_tier/);
  assert.throws(() => vertaalTaak(taak({ prioriteit_tier: 1.5 }), 0), /prioriteit_tier/);
});

test('een duur-indicatie buiten de gesloten lijst is een contractwijziging, geen stil streepje', () => {
  // Hard, niet zacht: de waarde staat op de plaat, dus iemand moet een nieuwe waarde zien.
  assert.throws(() => vertaalTaak(taak({ verwachte_duur: '3 maanden' }), 0), /gesloten lijst/);
  assert.throws(() => vertaalTaak(taak({ verwachte_duur: undefined }), 0), /gesloten lijst/);
});

// --- de feed als geheel ---

test('een lege of onleesbare feed levert LEEG/CORRUPT, nooit een throw naar de build', () => {
  assert.equal(vertaalBouwlijst('').reason, 'LEEG');
  assert.equal(vertaalBouwlijst(undefined).reason, 'LEEG');
  assert.equal(vertaalBouwlijst('{ dit is geen json').reason, 'CORRUPT');
  assert.equal(vertaalBouwlijst('[1,2,3]').reason, 'CORRUPT');
  assert.equal(vertaalBouwlijst('null').reason, 'CORRUPT');
});

test('een feed zonder taken is LEEG, niet corrupt', () => {
  assert.equal(vertaalBouwlijst(feed([])).reason, 'LEEG');
  assert.equal(vertaalBouwlijst(JSON.stringify({ taken: 'geen array' })).reason, 'LEEG');
});

test('één afgekeurde regel keurt de HELE feed af — geen half-gevulde lijst', () => {
  const res = vertaalBouwlijst(feed([taak(), taak({ task_id: 'T-2', status: 'HACK' })]));
  assert.equal(res.available, false);
  assert.equal(res.reason, 'CORRUPT');
  assert.deepEqual(res.features, []);
});

test('een dubbele task_id maakt de feed onbetrouwbaar (CORRUPT)', () => {
  const res = vertaalBouwlijst(feed([taak(), taak({ feature_label: 'andere naam' })]));
  assert.equal(res.reason, 'CORRUPT');
});

test('dezelfde naam twee keer mag wél — task_id is de identiteit, niet het label', () => {
  const res = vertaalBouwlijst(feed([taak(), taak({ task_id: 'T-0002' })]));
  assert.equal(res.available, true);
  assert.equal(res.features.length, 2);
});

test('de herkomst komt mee: korte sha, aantallen en het aantal weggelaten regels', () => {
  const res = vertaalBouwlijst(feed([taak(), taak({ task_id: 'T-0002' })]));
  assert.equal(res.bron.sha, 'e0049dcabc12', 'sha wordt gecapt op twaalf tekens');
  assert.equal(res.bron.bouwbaar, 5);
  assert.equal(res.bron.publishVeilig, 2);
  assert.equal(res.bron.weggelaten, 0);
});

test('een niet-hexadecimale sha wordt niet doorgegeven maar null', () => {
  const res = vertaalBouwlijst(feed([taak()], { meetlat: { sha: 'main; rm -rf /' } }));
  assert.equal(res.bron.sha, null);
});

// --- de per-regel schoon-poort: geteld, nooit stil ---

test('een label dat een deny-patroon raakt valt weg en wordt GETELD, de rest blijft', () => {
  // Zou zo'n label doorgaan, dan breekt de strikte sanitize-gate later de HELE publicatie af en
  // verouderde de plaat stil. Eén regel eruit, zichtbaar geteld, is het kleinere kwaad.
  const res = vertaalBouwlijst(feed([
    taak(),
    taak({ task_id: 'T-0002', feature_label: 'Mail sturen naar iemand@example.com' }),
    taak({ task_id: 'T-0003' }),
  ]));
  assert.equal(res.available, true);
  assert.equal(res.features.length, 2);
  assert.equal(res.bron.weggelaten, 1);
  assert.equal(JSON.stringify(res).includes('example.com'), false);
});

test('valt ALLES weg door de schoon-poort, dan is de plaat CORRUPT, niet stil leeg', () => {
  const res = vertaalBouwlijst(feed([taak({ feature_label: 'ORG_PR_READ_TOKEN roteren' })]));
  assert.equal(res.available, false);
  assert.equal(res.reason, 'CORRUPT');
});

// --- de weg naar de publieke DTO en het contract ---

test('de vertaalde feed levert een contract-geldige plaat: alles gepland, oplevering onbekend', () => {
  const parsed = vertaalBouwlijst(feed([
    taak({ prioriteit_tier: 0, verwachte_duur: '2-4 uur' }),
    taak({ task_id: 'T-0002' }),
    taak({ task_id: 'T-0003' }),
  ]));
  parsed.bron.spiegelAt = '2026-07-25T09:00:00.000Z';
  const dto = toPublicPlanning(parsed, BUILD);

  assert.equal(dto.available, true);
  assert.equal(dto.features.length, 3);
  assert.deepEqual([...new Set(dto.features.map((f) => f.status))], ['gepland']);
  assert.deepEqual([...new Set(dto.features.map((f) => f.worker))], [null]);
  assert.deepEqual([...new Set(dto.features.map((f) => f.oplevering.kind))], ['onbekend'],
    'geen throughput-klasse in de bron ⇒ onbekend, nooit een verzonnen datum');
  assert.deepEqual(dto.counters, { afSindsGisteren: 0, draaitNu: 0, wachtOpRichard: 0, gepland: 3 });
  assert.equal(dto.features[0].tier0, true);
  assert.equal(dto.bron.spiegelAt, '2026-07-25T09:00:00.000Z');
  assert.deepEqual(dto.kanaalpost, [], 'kanaalpost hoort bij de operationele stand, niet bij een backlog');

  // Het volledige gegenereerde §B-blok tegen het echte contract (review Codex, 25-07-2026).
  const snapshot = structuredClone(fixture);
  snapshot.planning = dto;
  assert.deepEqual(validate(schema, snapshot), []);
});

test('een spiegelmoment dat geen datum is, wordt null in plaats van doorgegeven', () => {
  const parsed = vertaalBouwlijst(feed([taak()]));
  parsed.bron.spiegelAt = 'gisteren rond een uurtje';
  assert.equal(toPublicPlanning(parsed, BUILD).bron.spiegelAt, null);
});

// --- render: wat Richard op de pagina ziet ---

test('de plaat toont de vierde tegel, het spoedspoor-badge en de duur-kolom', () => {
  const html = renderHtml(fixture);
  assert.match(html, /Gepland/);
  assert.match(html, /bouwbaar, nog niet toegewezen/);
  assert.match(html, /spoedspoor/);
  assert.match(html, /indicatie duur \(bron\)/);
  assert.match(html, /2-4 uur/);
});

test('de plaat noemt zijn herkomst: bron-commit, spiegelleeftijd en de aantallen', () => {
  const html = renderHtml(fixture);
  assert.match(html, /Bron: TRECHTER-bouwlijst, commit <code>e0049dc<\/code>/);
  assert.match(html, /gespiegeld op de rapporten-branch van stack-control/);
  // fixture: bouwmoment 2026-07-23T12:00Z, spiegel 2026-07-23T11:00Z ⇒ zelfde dag.
  assert.match(html, /2026-07-23, vandaag gespiegeld/);
  assert.match(html, /696 bouwbaar, waarvan 693 publiceerbaar/);
  assert.match(html, /Dit is de <strong>backlog<\/strong>, niet de/);
});

test('een oude spiegel leest als oud, geen groen vinkje op een verouderde kopie', () => {
  const oud = structuredClone(fixture);
  oud.planning.bron.spiegelAt = '2026-07-20T11:00:00.000Z';
  assert.match(renderHtml(oud), /spiegel 3 dagen oud/);
  const gisteren = structuredClone(fixture);
  gisteren.planning.bron.spiegelAt = '2026-07-22T11:00:00.000Z';
  assert.match(renderHtml(gisteren), /spiegel 1 dag oud/);
  const onbekend = structuredClone(fixture);
  onbekend.planning.bron.spiegelAt = null;
  assert.match(renderHtml(onbekend), /spiegelmoment onbekend/);
});

test('zonder herkomst (§B-bron) blijft de plaat gewoon staan, zonder herkomst-regel', () => {
  const zonder = structuredClone(fixture);
  zonder.planning.bron = null;
  const html = renderHtml(zonder);
  assert.match(html, /id="planning"/);
  assert.equal(html.includes('Bron: TRECHTER-bouwlijst'), false);
});
