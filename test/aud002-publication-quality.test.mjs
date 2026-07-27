/**
 * AUD-002 quality measurements for stack-dashboard @ 905a300.
 *
 * Reproduce by placing this file at
 * `test/aud002-publication-quality.test.mjs` in an isolated checkout and run:
 *
 *   node --test --test-reporter=tap test/aud002-publication-quality.test.mjs
 *
 * The negative cases intentionally fail at the measured source version. They
 * are audit evidence, not a repair to the owner repository.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { toPublicKanaalpost } from '../scripts/lib/kanaalpost.mjs';
import { toetsLabel } from '../scripts/lib/labeltoets.mjs';
import { toPublicSnapshot } from '../scripts/build.mjs';

const row = (onderwerp) => ({
  tab: 'AUDIT',
  onderwerp,
  status: 'AFGEROND',
  actie: 'niemand',
  datum: '2026-07-26 10:00',
});
const channel = (onderwerp) => toPublicKanaalpost({
  available: true,
  reason: null,
  rows: [row(onderwerp)],
});

test('spiegel: een gewone geldige regel wordt doorgelaten', () => {
  assert.equal(channel('Routinecontrole afgerond').rows.length, 1);
});

const mirrorMustReject = [
  ['$HOME-pad', '$HOME/voorbeeld/poller.py'],
  ['underscore-sleutelvorm', 'sk_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['verkorte adresvorm', 'jan@abcdef1'],
  ['hex-verpakking', 'key@d3b07384d113edec49eaa6238ad5ff00'],
  ['camelcase-sleutelnaam', 'MySecretToken'],
  ['synthetische persoonsnaam', 'Jan Jansen'],
  ['tijdelijk absoluut pad', '/tmp/__B__/pad'],
  ['systeemroot', '/etc'],
  ['synthetische codenaamzin', 'Project Saffier gaat vrijdag live'],
];

for (const [name, value] of mirrorMustReject) {
  test(`spiegel weigert ${name}`, () => {
    const result = channel(value);
    assert.equal(
      result.rows.length,
      0,
      `ongeldige vorm werd publiek geprojecteerd: ${name}`,
    );
  });
}

test('planning: een gewoon bouwlabel wordt doorgelaten', () => {
  assert.equal(toetsLabel('Dagelijkse automatische contentpublicatie').ok, true);
});

for (const value of [
  'Geld via app versturen',
  'Betaalde order automatisch uitvoeren',
]) {
  test(`planning weigert semantisch ongeschikte recombinatie: ${value}`, () => {
    assert.equal(toetsLabel(value).ok, false);
  });
}

test('machine-status is niet OK als planning en spiegel onbeschikbaar zijn', async () => {
  const { readFile } = await import('node:fs/promises');
  const raw = JSON.parse(await readFile('test/fixtures/raw-snapshot.json', 'utf8'));
  for (const key of [
    'pullRequests',
    'merged',
    'tracker',
    'decisions',
    'tracks',
    'logbook',
    'ci',
  ]) {
    raw[key].evidence.trust = 'VERIFIED_CURRENT';
  }
  raw.planning = {
    available: false,
    reason: 'CORRUPT',
    features: [],
    throughput: {},
  };
  raw.kanaalpost = {
    available: false,
    reason: 'BRON_ONBEREIKBAAR',
    rows: [],
  };
  const snapshot = toPublicSnapshot(raw, {});
  assert.notEqual(snapshot.overallStatus, 'OK');
});
