#!/usr/bin/env node
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPublishFiles } from './lib/publish-files.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
assertPublishFiles(join(root, 'public'))
  .then((files) => console.log(`public-allowlist ok: ${files.join(', ')}`))
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
