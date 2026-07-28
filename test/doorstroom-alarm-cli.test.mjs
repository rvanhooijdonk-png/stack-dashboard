/**
 * DOORSTROOM-ALARM CLI — proeft de daadwerkelijke subprocess-aanroep, niet alleen de pure lib.
 *
 * Bevinding Codex-review (derde ronde, ALARM-DAT-ELKE-RUN-MAILT A2-A4, gereproduceerd): de CLI las en
 * parsete `--oordeel` vóórdat hij naar `--oorzaak-override` keek. Een storing in "Overzetten" kan
 * `/tmp/oordeel.json` halverwege geschreven en dus ONGELDIG JSON achterlaten — en dat liet de CLI
 * crashen op `JSON.parse` vóórdat de override ooit kon redden. Precies het scenario waarin de override
 * moest voorkomen dat een stale/kapotte oordeel-staat de meldbeslissing overneemt.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const CLI = fileURLToPath(new URL('../scripts/doorstroom-alarm.mjs', import.meta.url));

function draaiBeslis(extraArgs) {
  const dir = mkdtempSync(join(tmpdir(), 'doorstroom-alarm-cli-'));
  const oordeelPad = join(dir, 'oordeel.json');
  const issueBodyPad = join(dir, 'issue-body.txt');
  writeFileSync(oordeelPad, '{"uitkomst":"GROEN"', 'utf8'); // met opzet KAPOTTE JSON
  writeFileSync(issueBodyPad, '', 'utf8');
  const uitvoer = execFileSync('node', [
    CLI, 'beslis',
    '--oordeel', oordeelPad, '--tap', join(dir, 'ontbreekt.tap'),
    '--issue-body', issueBodyPad, '--issue-open', 'true', '--periode-uur', '24',
    ...extraArgs,
  ], { encoding: 'utf8' });
  return JSON.parse(uitvoer);
}

test('CLI beslis: --oorzaak-override overleeft een kapot/ongeldig oordeel.json (Codex-bevinding, gereproduceerd)', () => {
  const resultaat = draaiBeslis(['--oorzaak-override', 'VASTLEGGEN_GEFAALD']);
  assert.equal(resultaat.uitkomst, 'ROOD');
  assert.equal(resultaat.causeSig, 'STAP_GEFAALD:VASTLEGGEN_GEFAALD');
  assert.equal(resultaat.melden, true);
});

test('CLI beslis: zonder override geeft hetzelfde kapotte oordeel.json wél een fout (dus de override is geen stille fallback)', () => {
  assert.throws(() => draaiBeslis([]), (err) => err.status === 1);
});
