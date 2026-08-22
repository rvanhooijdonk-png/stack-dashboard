/**
 * PUBLISH-CACHEPOORT — issue #77.
 *
 * De groene run `32596205038` (main @`24db715`) meldde op de savestap
 * `Path Validation Error: Path(s) specified in the action for caching do(es) not exist` en
 * `Cache save failed`, terwijl het workflowcommentaar beloofde dat een ontbrekend bestand stil
 * wordt overgeslagen. De belofte stond in proza; daarom kon niets hem weerleggen.
 *
 * Deze suite meet drie dingen in plaats van ze te beloven:
 *   1. de HUIDIGE workflow voldoet aan het cachecontract (positieve controle);
 *   2. de stap ZOALS HIJ OP MAIN STOND wordt afgekeurd — verbatim, inclusief `if: always()`
 *      (negatieve controle: zonder de reparatie is deze suite rood);
 *   3. de meetstap doet wat hij belooft, door zijn shell ECHT te draaien met en zonder het
 *      bestand — een string-match op YAML zou alleen bewijzen dat er iets staat, niet dat het werkt.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  CACHE_VIOLATION,
  RUNTIME_CACHE_PATH,
  RUNTIME_CACHE_KEY,
  RUNTIME_CACHE_RESTORE_KEY,
  findPublishCacheViolations,
  blockScalarOf,
} from '../scripts/lib/publish-cache-guard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const publish = await readFile(join(ROOT, '.github/workflows/publish.yml'), 'utf8');

const codes = (text) => findPublishCacheViolations(text).map((v) => v.code);

/** Bouwt een minimale maar realistische workflow rond een gegeven blok cachestappen. */
const workflow = (stappen) => `name: proef
on:
  push:
    branches: [main]
permissions: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - id: checkout
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5

${stappen}
      - name: Genereren (read-only aggregatie)
        id: genereren
        run: node scripts/build.mjs
`;

const HERSTELSTAP = `      - name: Runtime-feed last-known-good cache herstellen
        id: runtime_cache_restore
        uses: actions/cache/restore@caa296126883cff596d87d8935842f9db880ef25 # v5.1.0
        with:
          path: ${RUNTIME_CACHE_PATH}
          key: ${RUNTIME_CACHE_KEY}
          restore-keys: |
            ${RUNTIME_CACHE_RESTORE_KEY}
`;

const MEETSTAP = `      - name: Meten of de runtime-feed-cache iets te bewaren heeft
        id: runtime_cache_probe
        if: always()
        run: |
          if [ -f ${RUNTIME_CACHE_PATH} ]; then
            echo "aanwezig=true" >> "$GITHUB_OUTPUT"
          else
            echo "aanwezig=false" >> "$GITHUB_OUTPUT"
          fi
`;

const BEWAAKTE_SAVE = `      - name: Runtime-feed last-known-good cache opslaan
        id: runtime_cache_save
        if: always() && steps.runtime_cache_probe.outputs.aanwezig == 'true'
        uses: actions/cache/save@caa296126883cff596d87d8935842f9db880ef25 # v5.1.0
        with:
          path: ${RUNTIME_CACHE_PATH}
          key: ${RUNTIME_CACHE_KEY}
`;

/**
 * VERBATIM de savestap zoals die op `24db715` in main stond — inclusief de onvoorwaardelijke
 * `if: always()` en de Node 20-pin. Dit is de nulmeting; hij mag nooit stilzwijgend terugkeren.
 */
const SAVE_ZOALS_OP_MAIN = `      - name: Runtime-feed last-known-good cache opslaan
        id: runtime_cache_save
        if: always()
        uses: actions/cache/save@0057852bfaa89a56745cba8c7296529d2fc39830 # v4.3.0
        with:
          path: .local/runtime-feed-last-known-good.json
          key: runtime-feed-lkg-\${{ github.ref_name }}-\${{ github.run_id }}-\${{ github.run_attempt }}
`;

test('POSITIEF — de huidige publish.yml voldoet aan het volledige cachecontract', () => {
  assert.deepEqual(findPublishCacheViolations(publish), [],
    'de echte workflow hoort schoon door de cachepoort te komen');
});

test('POSITIEF — de synthetische bewaakte vorm is schoon (de meter keurt niet alles af)', () => {
  assert.deepEqual(codes(workflow(HERSTELSTAP + '\n' + MEETSTAP + '\n' + BEWAAKTE_SAVE)), []);
});

test('NEGATIEVE CONTROLE — de onvoorwaardelijke save van main wordt afgekeurd', () => {
  // Dit is de kern van issue #77: precies deze vorm produceerde `Path Validation Error` +
  // `Cache save failed` op een pad dat structureel niet bestaat. Zonder de reparatie in
  // publish.yml is deze assertie het bewijs dat de poort bijt.
  const gemeten = codes(workflow(HERSTELSTAP + '\n' + SAVE_ZOALS_OP_MAIN));
  assert.ok(gemeten.includes(CACHE_VIOLATION.SAVE_NOT_GUARDED_BY_PROBE),
    `een save zonder meetstap hoort te worden afgekeurd, gemeten: ${gemeten.join(', ') || '<niets>'}`);
});

test('NEGATIEVE CONTROLE — een meetstap die een ANDER pad meet, dekt de save niet', () => {
  const scheveMeting = MEETSTAP.replace(RUNTIME_CACHE_PATH, '.local/iets-anders.json');
  const gemeten = codes(workflow(HERSTELSTAP + '\n' + scheveMeting + '\n' + BEWAAKTE_SAVE));
  assert.ok(gemeten.includes(CACHE_VIOLATION.PROBE_PATH_MISMATCH),
    `padverschuiving hoort rood te zijn, gemeten: ${gemeten.join(', ') || '<niets>'}`);
});

test('NEGATIEVE CONTROLE — een meetstap zonder always() valt weg zodra de build faalt', () => {
  // Zonder `always()` slaat de meting over bij een gefaalde bouwstap, blijft de output leeg en
  // gaat een wél verse momentopname alsnog verloren — de terugval die #77 juist in leven houdt.
  const zonderAlways = MEETSTAP.replace('        if: always()\n', '');
  const gemeten = codes(workflow(HERSTELSTAP + '\n' + zonderAlways + '\n' + BEWAAKTE_SAVE));
  assert.ok(gemeten.includes(CACHE_VIOLATION.PROBE_NOT_ALWAYS),
    `een meetstap zonder always() hoort rood te zijn, gemeten: ${gemeten.join(', ') || '<niets>'}`);
});

test('NEGATIEVE CONTROLE — een meetstap ná de save meet niets en is dus een dode terugval', () => {
  const gemeten = codes(workflow(HERSTELSTAP + '\n' + BEWAAKTE_SAVE + '\n' + MEETSTAP));
  assert.ok(gemeten.includes(CACHE_VIOLATION.PROBE_AFTER_SAVE),
    `volgorde hoort te tellen, gemeten: ${gemeten.join(', ') || '<niets>'}`);
});

test('NEGATIEVE CONTROLE — de refscope mag niet uit de cachesleutel verdwijnen', () => {
  // Eerdere reviewcorrectie: zonder `github.ref_name` is de cache over refs heen leesbaar.
  const zonderRef = (BEWAAKTE_SAVE + HERSTELSTAP).replaceAll('runtime-feed-lkg-${{ github.ref_name }}-', 'runtime-feed-lkg-');
  const gemeten = codes(workflow(zonderRef + '\n' + MEETSTAP));
  assert.ok(gemeten.includes(CACHE_VIOLATION.CACHE_KEY_MISMATCH),
    `een ref-loze sleutel hoort rood te zijn, gemeten: ${gemeten.join(', ') || '<niets>'}`);
});

test('NEGATIEVE CONTROLE — run_attempt mag niet uit de sleutel verdwijnen (caches zijn immutable)', () => {
  const zonderAttempt = BEWAAKTE_SAVE.replace('-${{ github.run_attempt }}', '');
  const gemeten = codes(workflow(HERSTELSTAP + '\n' + MEETSTAP + '\n' + zonderAttempt));
  assert.ok(gemeten.includes(CACHE_VIOLATION.CACHE_KEY_MISMATCH),
    `een sleutel zonder run_attempt hoort rood te zijn, gemeten: ${gemeten.join(', ') || '<niets>'}`);
});

test('NEGATIEVE CONTROLE — de restore-prefix blijft per ref gescoped', () => {
  // Alleen de regel ONDER `restore-keys:`; dezelfde prefix staat ook aan het begin van `key:`.
  const scheveRestore = HERSTELSTAP.replace(
    `\n            ${RUNTIME_CACHE_RESTORE_KEY}`, '\n            runtime-feed-lkg-');
  const gemeten = codes(workflow(scheveRestore + '\n' + MEETSTAP + '\n' + BEWAAKTE_SAVE));
  assert.ok(gemeten.includes(CACHE_VIOLATION.RESTORE_KEY_MISMATCH),
    `een ref-loze restore-prefix hoort rood te zijn, gemeten: ${gemeten.join(', ') || '<niets>'}`);
});

test('NEGATIEVE CONTROLE — de save mag zijn always() niet kwijtraken bij het toevoegen van de poort', () => {
  const zonderAlways = BEWAAKTE_SAVE.replace('if: always() && steps', 'if: steps');
  const gemeten = codes(workflow(HERSTELSTAP + '\n' + MEETSTAP + '\n' + zonderAlways));
  assert.ok(gemeten.includes(CACHE_VIOLATION.SAVE_NOT_ALWAYS),
    `de save hoort always() te houden, gemeten: ${gemeten.join(', ') || '<niets>'}`);
});

/**
 * De shell van de meetstap draait hier ECHT, in een lege tijdelijke map, met exact de shellvorm
 * die GitHub gebruikt (`bash -e`). Alleen zo is bewezen dat de poort meet in plaats van beweert.
 */
async function draaiMeetstap({ bestandAanwezig }) {
  const script = blockScalarOf(publish, 'runtime_cache_probe', 'run');
  assert.ok(script && script.trim() !== '', 'de meetstap hoort een uitvoerbare shell te hebben');
  const werkmap = await mkdtemp(join(tmpdir(), 'publish-cache-'));
  try {
    if (bestandAanwezig) {
      const doel = join(werkmap, RUNTIME_CACHE_PATH);
      await mkdir(dirname(doel), { recursive: true });
      await writeFile(doel, '{"contractVersion":1}\n', 'utf8');
    }
    const scriptPad = join(werkmap, 'stap.sh');
    const outputPad = join(werkmap, 'github-output');
    await writeFile(scriptPad, script, 'utf8');
    await writeFile(outputPad, '', 'utf8');
    execFileSync('bash', ['-e', scriptPad], {
      cwd: werkmap, env: { ...process.env, GITHUB_OUTPUT: outputPad }, stdio: 'pipe',
    });
    return await readFile(outputPad, 'utf8');
  } finally {
    await rm(werkmap, { recursive: true, force: true });
  }
}

test('GEDRAG — zonder cachebestand meldt de meetstap "aanwezig=false" en blijft de save dus uit', async () => {
  // Dit is de exacte productieconditie van run 32596205038: een verse runner zonder het bestand.
  assert.match(await draaiMeetstap({ bestandAanwezig: false }), /^aanwezig=false$/m);
});

test('GEDRAG — mét cachebestand meldt de meetstap "aanwezig=true" en wordt er wél opgeslagen', async () => {
  // De reparatie mag de bestaande terugval niet uitschakelen: bestaat het bestand, dan gaat het
  // gewoon de cache in — onder dezelfde sleutel als voorheen.
  assert.match(await draaiMeetstap({ bestandAanwezig: true }), /^aanwezig=true$/m);
});

test('GEDRAG — de conditie van de save leest exact de output die de meetstap schrijft', () => {
  // Een poort die naar een output kijkt die niemand schrijft, staat permanent dicht. Naam en
  // stap-id worden hier tegen elkaar gemeten in plaats van los aangenomen.
  const script = blockScalarOf(publish, 'runtime_cache_probe', 'run') ?? '';
  const conditie = publish.match(/if: always\(\) && steps\.(\w+)\.outputs\.(\w+) == 'true'/);
  assert.ok(conditie, 'de save hoort op een gemeten output te wachten');
  const [, stapId, outputNaam] = conditie;
  assert.equal(stapId, 'runtime_cache_probe');
  assert.match(script, new RegExp(`${outputNaam}=(true|false)`),
    `de meetstap hoort "${outputNaam}" te schrijven`);
});

test('PIN — beide cachestappen draaien op de officiële Node 24-release', () => {
  // Tweede gemeten waarschuwing in #77: v4.3.0 verklaart `using: node20`, v5.1.0 `using: node24`,
  // met een identieke inputs/outputs-oppervlakte. Zelfde patroon als de eerdere pinbumps voor
  // upload-pages-artifact en deploy-pages in test/publiekepaginas.test.mjs.
  const pin = 'actions/cache/save@caa296126883cff596d87d8935842f9db880ef25 # v5.1.0';
  const herstelPin = 'actions/cache/restore@caa296126883cff596d87d8935842f9db880ef25 # v5.1.0';
  assert.equal(publish.split(pin).length - 1, 1, 'de savestap hoort de v5.1.0-pin te gebruiken');
  assert.equal(publish.split(herstelPin).length - 1, 1, 'de herstelstap hoort dezelfde pin te gebruiken');
  assert.doesNotMatch(publish, /actions\/cache\/(save|restore)@0057852bfaa89a56745cba8c7296529d2fc39830/,
    'de Node 20-pin v4.3.0 mag niet terugkomen');
});

test('het workflowcommentaar belooft niet langer dat een ontbrekend bestand stil wordt overgeslagen', () => {
  // De onjuiste belofte uit #77, letterlijk. Ze mag niet terugkeren zonder dat iemand het merkt.
  assert.doesNotMatch(publish, /slaat actions\/cache\/save dit\n\s*# zelf over/,
    'de weerlegde belofte "actions/cache/save slaat dit zelf over" hoort weg te blijven');
});
