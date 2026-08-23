import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { PUBLISH_ALLOWLIST, CLIENT_POLL_FILES, assertPublishFiles, outputDirectory } from '../scripts/lib/publish-files.mjs';

test('publicatie-allowlist bevat exact de zes pagina’s, status en nojekyll', () => {
  assert.deepEqual(PUBLISH_ALLOWLIST, [
    '.nojekyll', 'code-ticker.html', 'contentstroom.html', 'index.html',
    'producten.html', 'stack-ticker.html', 'status.json', 'transacties.html',
  ]);
});

test('CLIENT_POLL_FILES bevat exact de negen bronbestanden die --client-poll-origin kopieert', () => {
  assert.deepEqual(CLIENT_POLL_FILES, [
    'format.mjs', 'validate.mjs', 'sanitize.mjs', 'runtime-feed.mjs',
    'runtime-feed-input.mjs', 'runtime-feed-view.mjs',
    'panel-contracts.mjs', 'paneel-nu-bezig.mjs', 'runtime-poll.mjs',
  ]);
});

/** Relatieve import in alle drie de quotevormen — `from './x.mjs'`, met dubbele quotes, of met backticks. */
const IMPORT_RELATIEF = /^\s*(?:import|export)[^'"`]*from\s+(?:'(\.\/[^']+)'|"(\.\/[^"]+)"|`(\.\/[^`]+)`)/gm;
/** Niet-relatieve (kale) import in dezelfde drie vormen. */
const IMPORT_KAAL = /^\s*(?:import|export)[^'"`]*from\s+(?:'([^'.][^']*)'|"([^".][^"]*)"|`([^`.][^`]*)`)/gm;

test('CLIENT_POLL_FILES dekt de VOLLEDIGE importboom vanaf runtime-poll.mjs', async () => {
  // De lijst hierboven is een opsomming; deze proef is de eigenschap erachter. De browser laadt
  // `runtime-poll.mjs` als module en volgt zijn `import`-regels zelf: ontbreekt één bestand, dan is
  // dat geen degradatie maar een 404 midden in de modulegraaf — de polling laadt dan helemaal niet
  // en de pagina blijft stil staan zonder foutmelding. Een latere paneelvuller die een import
  // toevoegt en de lijst vergeet, valt hier om in plaats van in productie.
  const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts/lib');
  const gezien = new Set();
  const wachtrij = ['runtime-poll.mjs'];
  while (wachtrij.length) {
    const bestand = wachtrij.pop();
    if (gezien.has(bestand)) continue;
    gezien.add(bestand);
    const bron = await readFile(join(LIB, bestand), 'utf8');
    // Alle drie de quotevormen, niet alleen de enkele. De repository schrijft consequent met enkele
    // quotes, maar een wachter die de andere twee niet ziet wordt stil omzeild door één regel in de
    // huisstijl van iemand anders — en het gevolg (een 404 midden in de importgraaf) is juist het
    // stille falen dat deze proef moet vangen (review Gemini, ronde 1).
    for (const match of bron.matchAll(IMPORT_RELATIEF)) {
      const doel = (match[1] ?? match[2] ?? match[3]).slice(2);
      assert.ok(CLIENT_POLL_FILES.includes(doel),
        `${bestand} importeert ./${doel}, maar dat bestand wordt niet meegekopieerd (CLIENT_POLL_FILES)`);
      wachtrij.push(doel);
    }
    // Een niet-relatieve import (node:fs, een pakket) haalt de browser nooit op; die hoort hier
    // niet te bestaan. Anders faalt de module pas in de browser, niet in deze suite.
    for (const match of bron.matchAll(IMPORT_KAAL)) {
      assert.fail(`${bestand} importeert '${match[1] ?? match[2] ?? match[3]}' — dat kan de browser niet laden`);
    }
  }
  // Elk gekopieerd bestand hoort ook echt bereikbaar te zijn vanaf de ingang; dode ballast in de
  // publicatiemap is precies wat de allowlist elders juist tegenhoudt.
  assert.deepEqual([...gezien].sort(), [...CLIENT_POLL_FILES].sort());
});

test('allowlist accepteert uitsluitend exact de gewone bestanden uit PUBLISH_ALLOWLIST', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-publish-'));
  for (const file of PUBLISH_ALLOWLIST) await writeFile(join(directory, file), '', 'utf8');
  assert.deepEqual(await assertPublishFiles(directory), PUBLISH_ALLOWLIST);
  await writeFile(join(directory, 'onverwacht.txt'), '', 'utf8');
  await assert.rejects(assertPublishFiles(directory), /wijkt af van allowlist/);
});

test('extra-optie verruimt de allowlist alleen expliciet, nooit stilzwijgend', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-publish-'));
  for (const file of PUBLISH_ALLOWLIST) await writeFile(join(directory, file), '', 'utf8');
  // Zonder client-side bestanden op schijf blijft de aanroep zonder `extra` strikt afwijzen —
  // de standaard-/productie-/CI-poort verandert niet door het bestaan van deze optie.
  await writeFile(join(directory, 'runtime-poll.mjs'), '', 'utf8');
  await assert.rejects(assertPublishFiles(directory), /wijkt af van allowlist/);
  assert.deepEqual(
    (await assertPublishFiles(directory, { extra: ['runtime-poll.mjs'] })).sort(),
    [...PUBLISH_ALLOWLIST, 'runtime-poll.mjs'].sort(),
  );
});

test('allowlist weigert submappen en output buiten de repository', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-publish-'));
  for (const file of PUBLISH_ALLOWLIST) await writeFile(join(directory, file), '', 'utf8');
  await mkdir(join(directory, 'assets'));
  await assert.rejects(assertPublishFiles(directory), /geen gewoon bestand/);
  assert.throws(() => outputDirectory('/workspace/repo', '../buiten'), /submap/);
  assert.equal(outputDirectory('/workspace/repo', 'build'), '/workspace/repo/build');
});
