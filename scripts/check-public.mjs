#!/usr/bin/env node
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPublishFiles, CLIENT_POLL_FILES } from './lib/publish-files.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Spiegelt build.mjs's --client-poll-origin: zonder de vlag blijft de poort de bestaande
// strikte zes-bestanden-allowlist (geen gedragswijziging voor de huidige publish.yml-aanroep).
const clientPoll = process.argv.includes('--client-poll');
assertPublishFiles(join(root, 'public'), { extra: clientPoll ? CLIENT_POLL_FILES : [] })
  .then((files) => console.log(`public-allowlist ok: ${files.join(', ')}`))
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
