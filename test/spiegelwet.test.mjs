/**
 * SPIEGELWET — tests op de regel die ik zelf heb overtreden (zie `lib/spiegelwet.mjs`). De eerste
 * test is exact het geval dat toen misging: een regel die er stond, is er niet meer.
 *
 * De tweede groep test de grens die na de review van Codex is verschoven: een regel die van plaats
 * verandert doordat twee takken elk hebben aangevuld, is GEEN overtreding maar een melding. Zonder
 * die grens piept de bewaker vals bij elke samenvoeging, en een bewaker die vals piept gaat uit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alleenAangevuld } from '../scripts/lib/spiegelwet.mjs';

const drie = 'kop\n| a |\n| b |\n';

// --- hard: niets mag verdwijnen -----------------------------------------------------------------

test('een verwijderde regel is een overtreding, ook als de rest klopt', () => {
  const r = alleenAangevuld(drie, 'kop\n| a |\n');
  assert.equal(r.ok, false);
  assert.equal(r.verdwenen, 1);
});

test('een herschreven regel is een overtreding: de oude tekst is dan verdwenen', () => {
  const r = alleenAangevuld(drie, 'kop\n| A |\n| b |\n');
  assert.equal(r.ok, false);
  assert.equal(r.verdwenen, 1);
});

test('twee identieke regels mogen niet stilletjes één worden', () => {
  const r = alleenAangevuld('kop\n| a |\n| a |\n', 'kop\n| a |\n');
  assert.equal(r.ok, false);
  assert.equal(r.verdwenen, 1);
});

test('aanvullen achteraan mag', () => {
  const r = alleenAangevuld(drie, `${drie}| c |\n`);
  assert.equal(r.ok, true);
  assert.equal(r.opOrde, true);
});

test('niets veranderen mag', () => {
  assert.equal(alleenAangevuld(drie, drie).ok, true);
});

test('een nog niet bestaande spiegel mag met inhoud beginnen', () => {
  assert.equal(alleenAangevuld('', 'kop\n| a |\n').ok, true);
});

// --- zacht: de volgorde ------------------------------------------------------------------------

test('een regel die door een samenvoeging opschuift is geen overtreding, maar wel een melding', () => {
  const r = alleenAangevuld(drie, 'kop\n| tussen |\n| a |\n| b |\n');
  assert.equal(r.ok, true, 'niets verdwenen, dus geen overtreding');
  assert.equal(r.opOrde, false, 'de volgorde is wel afgeweken');
  assert.equal(r.eerste, 2);
});

test('twee takken die elk aanvullen zijn te verenigen zonder vals alarm', () => {
  const takA = `${drie}| uit tak A |\n`;
  const samen = `${drie}| uit main |\n| uit tak A |\n`;
  assert.equal(alleenAangevuld(takA, samen).ok, true);
  assert.equal(alleenAangevuld(drie, samen).ok, true);
});

// --- de uitkomst lekt niets --------------------------------------------------------------------

test('de uitkomst bevat geen inhoud uit de spiegel', () => {
  const r = alleenAangevuld('kop\n| gevoelig onderwerp |\n', 'kop\n');
  assert.equal(JSON.stringify(r).includes('gevoelig'), false);
});
