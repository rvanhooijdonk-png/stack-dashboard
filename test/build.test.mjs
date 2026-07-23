import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toPublicSnapshot, readTextPolicy } from '../scripts/build.mjs';

/**
 * Een collectorresultaat met velden die nooit gepubliceerd mogen worden (interne notitie,
 * bronpad, bewijs-URL, workflownaam). Gedeeld met contract.test.mjs: één nepbron, twee vragen —
 * "wordt het juiste weggelaten" hier, "past wat overblijft in het contract" daar.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = JSON.parse(await readFile(join(ROOT, 'test/fixtures/raw-snapshot.json'), 'utf8'));

test('de publieke DTO kopieert alleen expliciet toegestane velden', () => {
  const pub = toPublicSnapshot(raw);
  const json = JSON.stringify(pub);
  assert.equal(json.includes('internNotitie'), false);
  assert.equal(json.includes('https://intern'), false);
  assert.equal(json.includes('INTERN/PAD'), false);
  assert.equal(json.includes('proofUrl'), false);
  assert.equal(json.includes('sourceRef'), false);
  assert.equal(json.includes('geheime-workflow-naam'), false);
});

test('één niet-geverifieerde bron maakt de hele stand DEGRADED', () => {
  assert.equal(toPublicSnapshot(raw).overallStatus, 'DEGRADED');
  const clean = structuredClone(raw);
  clean.tracker.evidence.trust = 'VERIFIED_CURRENT';
  assert.equal(toPublicSnapshot(clean).overallStatus, 'OK');
});

test('het aantal verborgen repo\'s blijft behouden', () => {
  assert.equal(toPublicSnapshot(raw).pullRequests.hiddenRepositories, 3);
});

// --- Bevindingen uit de tweede dubbele review van 23-07-2026 (Codex + Gemini) ---

test('de probe van Codex haalt de publieke DTO niet — vrije tekst staat er standaard niet in', () => {
  // "Project Saffier: overname van klant Zephyr gaat vrijdag live" passeerde elke patroongate.
  // Precies daarom gaat vrije tekst er niet in: geen regex herkent bedrijfsinhoud.
  const json = JSON.stringify(toPublicSnapshot(raw));
  assert.equal(json.includes('Zephyr'), false);
  assert.equal(json.includes('Saffier'), false);
  assert.equal(json.includes('KLANTGEHEIM'), false);
  assert.equal(json.includes('journaalkop'), false);
});

test('de structuur blijft wél staan — nummers, ID\'s en datums dragen de status', () => {
  const pub = toPublicSnapshot(raw);
  assert.equal(pub.tracker.updates[0].number, 24);
  assert.equal(pub.tracker.updates[0].title, null);
  assert.equal(pub.tracker.decisionPoints[0].id, '24a');
  assert.equal(pub.decisions.entries[0].id, 'D-0013');
  assert.equal(pub.decisions.entries[0].decision, null);
  assert.equal(pub.tracker.updatesTextWithheld, true);
  assert.equal(pub.tracker.decisionPointsTextWithheld, true);
  assert.equal(pub.decisions.textWithheld, true);
  assert.equal(pub.logbook.textWithheld, true);
});

// --- Bevindingen uit de derde dubbele review van 23-07-2026 (Codex) ---

test('de roadmap was het gat: workstreams gingen ongefilterd mee — bewezen probe van Codex', () => {
  const ws = toPublicSnapshot(raw).workstreams;
  const json = JSON.stringify(ws);
  assert.equal(json.includes('Saffier'), false, 'zonder public:true gaat de titel er niet in');
  assert.equal(json.includes('Zephyr'), false);
  assert.equal(json.includes('internNotitie'), false);
  assert.equal(ws[1].title, null, 'WS02 draagt geen public-vlag');
  assert.equal(ws[1].estimate, null);
});

test('een raming is een duur, geen statusregel', () => {
  const ws = toPublicSnapshot(raw).workstreams;
  assert.equal(ws[0].estimate, '1-2 dagen', 'een echte duur blijft staan');
  assert.equal(ws[2].title, 'Vrijgegeven maar met statustekst i.p.v. duur', 'de titel is wél vrijgegeven');
  assert.equal(ws[2].estimate, null, 'maar "Railway-diagnose: klaar, wacht op Richard" is geen duur');
});

test('een bronpad verlaat de machine niet — evidence draagt geen source meer', () => {
  const pub = toPublicSnapshot(raw);
  assert.equal('source' in pub.tracker.evidence, false);
  assert.deepEqual(Object.keys(pub.ci.evidence).sort(), ['error', 'retrievedAt', 'trust']);
});

test('"false" als tekst zet de poort niet open — hij breekt de build', () => {
  // Truthiness liet de string "false" door en publiceerde de hele sectie. Bewezen probe.
  assert.throws(() => readTextPolicy({ decisions: 'false' }), /moet true of false zijn/);
  assert.throws(() => readTextPolicy({ besluiten: true }), /onbekende sleutel/);
  assert.deepEqual(readTextPolicy({ _toelichting: 'commentaar mag', decisions: true }).decisions, true);
});

test('vrijgeven is een expliciete handeling, per sectie', () => {
  const pub = toPublicSnapshot(raw, { decisions: true });
  assert.match(pub.decisions.entries[0].decision, /Saffier/);
  assert.equal(pub.decisions.textWithheld, false);
  assert.equal(pub.tracker.updates[0].title, null, 'andere secties blijven dicht');
});

test('verborgen tracks en CI-repo\'s worden geteld, niet benoemd', () => {
  const pub = toPublicSnapshot(raw);
  assert.equal(pub.fleet.hiddenTracks, 2);
  assert.equal(pub.ci.hiddenCiRepositories, 1);
});
