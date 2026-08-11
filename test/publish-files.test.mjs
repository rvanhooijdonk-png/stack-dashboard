import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PUBLISH_ALLOWLIST, assertPublishFiles, outputDirectory } from '../scripts/lib/publish-files.mjs';

test('publicatie-allowlist bevat exact de vier pagina’s, status en nojekyll', () => {
  assert.deepEqual(PUBLISH_ALLOWLIST, ['.nojekyll', 'contentstroom.html', 'index.html', 'producten.html', 'stack-ticker.html', 'status.json']);
});

test('allowlist accepteert uitsluitend exact zes gewone bestanden', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-publish-'));
  for (const file of PUBLISH_ALLOWLIST) await writeFile(join(directory, file), '', 'utf8');
  assert.deepEqual(await assertPublishFiles(directory), PUBLISH_ALLOWLIST);
  await writeFile(join(directory, 'onverwacht.txt'), '', 'utf8');
  await assert.rejects(assertPublishFiles(directory), /wijkt af van allowlist/);
});

test('allowlist weigert submappen en output buiten de repository', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-publish-'));
  for (const file of PUBLISH_ALLOWLIST) await writeFile(join(directory, file), '', 'utf8');
  await mkdir(join(directory, 'assets'));
  await assert.rejects(assertPublishFiles(directory), /geen gewoon bestand/);
  assert.throws(() => outputDirectory('/workspace/repo', '../buiten'), /submap/);
  assert.equal(outputDirectory('/workspace/repo', 'build'), '/workspace/repo/build');
});
