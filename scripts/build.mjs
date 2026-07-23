#!/usr/bin/env node
/**
 * BUILD — verzamel, saneer, render. In die volgorde, zonder uitzondering.
 *
 *   node scripts/build.mjs [--out public] [--fixture data/fixture.json] [--no-strict]
 *
 * De sanitize-gate zit tussen verzamelen en renderen. Er is geen pad waarlangs ruwe
 * brontekst de HTML bereikt.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertPublishable } from './lib/sanitize.mjs';
import { renderHtml } from './lib/render.mjs';
import {
  collectPullRequests, collectMergedRecent, collectTracker,
  collectDecisions, collectFleet, collectLogbook, collectCi,
} from './lib/collect.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_VERSION = '1.0.0';
const REFRESH_SECONDS = 900;

/** Repo's waarvan we een CI-ampel tonen. Bewust een korte, expliciete lijst. */
const CI_REPOS = (process.env.DASHBOARD_CI_REPOS ?? 'stack-control,command-canon,vault-mirror')
  .split(',').map((s) => s.trim()).filter(Boolean);

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

export async function buildSnapshot({ fixture = null } = {}) {
  if (fixture) return JSON.parse(await readFile(fixture, 'utf8'));

  const workstreams = JSON.parse(await readFile(join(ROOT, 'data/workstreams.json'), 'utf8'));

  const [pullRequests, merged, tracker, decisions, fleet, logbook] = await Promise.all([
    collectPullRequests(), collectMergedRecent(7), collectTracker(),
    collectDecisions(), collectFleet(), collectLogbook(),
  ]);
  const ci = await collectCi(CI_REPOS);

  const parts = { pullRequests, merged, tracker, decisions, fleet, logbook, ci };
  const sources = Object.entries(parts).map(([key, p]) => ({ key, ...p.evidence }));
  const worst = sources.some((s) => s.trust === 'SOURCE_UNAVAILABLE') ? 'DEGRADED' : 'OK';

  return {
    contractVersion: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    overallStatus: worst,
    sources,
    workstreams,
    ...parts,
  };
}

async function main() {
  const outDir = join(ROOT, arg('out', 'public'));
  const strict = !process.argv.includes('--no-strict');

  const raw = await buildSnapshot({ fixture: arg('fixture') });

  // SANITIZE-GATE — fail-closed. Alles hierna is publicabel of we publiceren niet.
  const { snapshot, findings } = assertPublishable(raw, { strict });
  if (findings.length) {
    console.warn(`sanitize: ${findings.length} bevinding(en) geredigeerd (niet-strikte modus)`);
  }

  const html = renderHtml(snapshot, { refreshSeconds: REFRESH_SECONDS });

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'index.html'), html, 'utf8');
  await writeFile(join(outDir, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  await writeFile(join(outDir, '.nojekyll'), '', 'utf8');

  const unavailable = snapshot.sources.filter((s) => s.trust === 'SOURCE_UNAVAILABLE').map((s) => s.key);
  console.log(`gebouwd: ${join(outDir, 'index.html')}`);
  console.log(`status: ${snapshot.overallStatus}${unavailable.length ? ` · onbereikbaar: ${unavailable.join(', ')}` : ''}`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
