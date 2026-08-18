import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PUBLISH_ALLOWLIST, CLIENT_POLL_FILES, assertPublishFiles, outputDirectory } from '../scripts/lib/publish-files.mjs';

test('publicatie-allowlist bevat exact de zes pagina’s, status en nojekyll', () => {
  assert.deepEqual(PUBLISH_ALLOWLIST, [
    '.nojekyll', 'code-ticker.html', 'contentstroom.html', 'index.html',
    'producten.html', 'stack-ticker.html', 'status.json', 'transacties.html',
  ]);
});

test('CLIENT_POLL_FILES bevat exact de zeven bronbestanden die --client-poll-origin kopieert', () => {
  assert.deepEqual(CLIENT_POLL_FILES, [
    'format.mjs', 'validate.mjs', 'sanitize.mjs', 'runtime-feed.mjs',
    'runtime-feed-input.mjs', 'runtime-feed-view.mjs', 'runtime-poll.mjs',
  ]);
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
