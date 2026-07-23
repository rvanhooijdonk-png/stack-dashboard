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
