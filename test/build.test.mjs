import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toPublicSnapshot } from '../scripts/build.mjs';

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
