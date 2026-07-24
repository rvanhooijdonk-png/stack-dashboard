import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PUBLISH_ALLOWLIST } from '../scripts/build.mjs';

/**
 * De publicatiemap kent TWEE poortwachters die exact hetzelfde moeten toestaan:
 *   1. PUBLISH_ALLOWLIST in scripts/build.mjs — wat de build wegschrijft.
 *   2. De `find public ... ! -name '...'`-stap in .github/workflows/publish.yml — wat CI
 *      accepteert vóór publicatie; alles daarbuiten is "onverwacht" en flipt naar de foutpagina.
 *
 * Bevinding Codex (24-07-2026, PR 1): de JS-lijst kreeg twee nieuwe pagina's, de CI-lijst niet —
 * CI zou de tabbladen als onverwacht bestempeld en nooit gepubliceerd hebben, terwijl alle tests
 * groen bleven. Geen enkele test vergeleek de twee. Deze test doet dat wél: drift = rood.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('de CI-allowlist in publish.yml is exact gelijk aan PUBLISH_ALLOWLIST', async () => {
  const yml = await readFile(join(ROOT, '.github/workflows/publish.yml'), 'utf8');

  // Pak het find-blok dat de publicatiemap keurt en haal daar de `! -name '<x>'`-tokens uit.
  const blok = yml.match(/find public -mindepth 1[\s\S]*?-printf/);
  assert.ok(blok, 'de find-stap die public keurt is niet gevonden in publish.yml');
  const ciNames = [...blok[0].matchAll(/!\s*-name\s+'([^']+)'/g)].map((m) => m[1]);

  assert.deepEqual(
    ciNames.slice().sort(),
    PUBLISH_ALLOWLIST.slice().sort(),
    `CI-allowlist ${JSON.stringify(ciNames)} wijkt af van PUBLISH_ALLOWLIST ${JSON.stringify(PUBLISH_ALLOWLIST)}`,
  );
});
