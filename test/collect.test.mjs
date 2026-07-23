import test from 'node:test';
import assert from 'node:assert/strict';

import { ageTrust } from '../scripts/lib/collect.mjs';

// --- Bevinding uit de derde review (Codex, 23-07-2026): de leeftijdsgrens lekte een dag ---

test('veertien dagen is veertien dagen, niet bijna vijftien', () => {
  const now = Date.parse('2026-07-23T12:00:00.000Z');
  const dagenGeleden = (d) => new Date(now - d * 86400000).toISOString();
  // Math.floor op hele dagen liet een bron van 14 dagen en 23 uur nog groen staan.
  assert.equal(ageTrust(dagenGeleden(13.9), now).trust, 'VERIFIED_CURRENT');
  assert.equal(ageTrust(dagenGeleden(14.1), now).trust, 'STALE');
  assert.equal(ageTrust(null, now).trust, 'UNVERIFIED', 'onbekende datum is niet "vers"');
  assert.equal(ageTrust('geen datum', now).trust, 'UNVERIFIED');
});

// --- Bevinding uit de vierde review (Codex, 23-07-2026): een kapotte klok gaf groen ---

test('een datum in de toekomst is geen verse bron', () => {
  const now = Date.parse('2026-07-23T12:00:00.000Z');
  const over = (ms) => new Date(now + ms).toISOString();
  assert.equal(ageTrust(over(86400000), now).trust, 'UNVERIFIED', 'een dag vooruit klopt niet');
  assert.equal(ageTrust(over(60000), now).trust, 'VERIFIED_CURRENT', 'een minuut klokverschil mag');
});

test('de grens ligt op veertien dagen, niet erna', () => {
  const now = Date.parse('2026-07-23T12:00:00.000Z');
  assert.equal(ageTrust(new Date(now - 14 * 86400000).toISOString(), now).trust, 'STALE');
});
