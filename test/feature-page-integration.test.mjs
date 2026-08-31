import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('build genereert features.html en valideert het featurecontract', async () => {
  const build = await read('scripts/build.mjs');
  assert.match(build, /renderFeatures/);
  assert.match(build, /contracts\/product-features\.schema\.json/);
  assert.match(build, /data\/product-features\.json/);
  assert.match(build, /writeFile\(join\(outDir, 'features\.html'\)/);
  assert.match(build, /PUBLISH_ALLOWLIST[^\n]+features\.html/);
});

test('cockpit en contentstroom linken naar volledige featurepagina', async () => {
  const build = await read('scripts/build.mjs');
  assert.match(build, /Alle producten en features/);
  assert.match(build, /\.\/features\.html/);
});

test('publish-workflow laat uitsluitend de vijf afgesproken artefacten toe', async () => {
  const workflow = await read('.github/workflows/publish.yml');
  assert.match(workflow, /features\.html/);
  assert.match(workflow, /index\.html/);
  assert.match(workflow, /contentstroom\.html/);
  assert.match(workflow, /status\.json/);
  assert.match(workflow, /\.nojekyll/);
});
