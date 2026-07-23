#!/usr/bin/env node
/**
 * BUILD — verzamel, reduceer, saneer, render. In die volgorde, zonder uitzondering.
 *
 *   node scripts/build.mjs [--out public] [--fixture data/fixture.json] [--no-strict]
 *
 * Belangrijkste ontwerpbesluit na de review van 23-07-2026: de volledige snapshot wordt
 * **niet** gepubliceerd. Er gaat één expliciet samengestelde publieke DTO naar de renderer;
 * alles wat daar niet in staat, verlaat deze machine niet. De interne snapshot blijft in
 * `.local/` (niet in de Pages-artefact, niet in git).
 */

import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertPublishable, loadDenyTerms } from './lib/sanitize.mjs';
import { renderHtml } from './lib/render.mjs';
import {
  collectPullRequests, collectMergedRecent, collectTracker,
  collectDecisions, collectFleet, collectLogbook, collectCi, setPublicRepos, setPublicTracks,
} from './lib/collect.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_VERSION = '1.0.0';
const REFRESH_SECONDS = 900;

/** Precies deze drie bestanden mogen gepubliceerd worden. Niets anders. */
const PUBLISH_ALLOWLIST = ['index.html', 'status.json', '.nojekyll'];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const readJson = async (p, fallback) => {
  try { return JSON.parse(await readFile(join(ROOT, p), 'utf8')); } catch { return fallback; }
};

/**
 * Standaardbeleid voor vrije tekst: niets. Zie `data/publish-text.json` en de probe die dit
 * afdwong (Codex, 23-07-2026): "Project Saffier: overname van klant Zephyr gaat vrijdag live"
 * passeerde elke gate en stond gewoon op de pagina. Geen enkel patroon herkent zoiets — dus
 * gaat de tekst er standaard niet in, en draagt de structuur eromheen de status.
 */
const TEXT_OFF = { trackerUpdates: false, trackerDecisionPoints: false, decisions: false, logbook: false };

/**
 * Reduceer de interne snapshot tot wat de pagina toont — veld voor veld, met de hand.
 * Er is bewust geen spread: een nieuw veld in een collector verschijnt hier niet vanzelf.
 */
export function toPublicSnapshot(raw, textPolicy = {}) {
  const t = { ...TEXT_OFF, ...textPolicy };
  /** Vrije tekst komt er alleen in als iemand die sectie expliciet heeft vrijgegeven. */
  const text = (allowed, value) => (allowed ? value : null);
  const ev = (e) => ({ source: e.source, retrievedAt: e.retrievedAt, trust: e.trust, error: e.error ?? null });

  const sources = ['pullRequests', 'merged', 'tracker', 'decisions', 'fleet', 'logbook', 'ci']
    .map((key) => ({ key, trust: raw[key].evidence.trust, retrievedAt: raw[key].evidence.retrievedAt }));

  return {
    contractVersion: CONTRACT_VERSION,
    generatedAt: raw.generatedAt,
    overallStatus: sources.every((s) => s.trust === 'VERIFIED_CURRENT') ? 'OK' : 'DEGRADED',
    sources,
    workstreams: raw.workstreams.map((w) => ({ id: w.id, title: w.title, estimate: w.estimate ?? null })),
    pullRequests: {
      available: raw.pullRequests.available,
      repositories: raw.pullRequests.repositories.map((r) => ({
        repository: r.repository, open: r.open, draft: r.draft, ready: r.ready,
      })),
      hiddenRepositories: raw.pullRequests.hiddenRepositories ?? 0,
      totals: raw.pullRequests.totals,
      evidence: ev(raw.pullRequests.evidence),
    },
    merged: {
      available: raw.merged.available,
      windowDays: raw.merged.windowDays,
      count: raw.merged.count,
      byRepository: raw.merged.byRepository.map((r) => ({ repository: r.repository, merged: r.merged })),
      evidence: ev(raw.merged.evidence),
    },
    tracker: {
      available: raw.tracker.available,
      textWithheld: !(t.trackerUpdates && t.trackerDecisionPoints),
      updates: raw.tracker.updates.map((u) => ({
        number: u.number, date: u.date, title: text(t.trackerUpdates, u.title),
      })),
      decisionPoints: raw.tracker.decisionPoints.map((d) => ({
        id: d.id, title: text(t.trackerDecisionPoints, d.title),
      })),
      evidence: ev(raw.tracker.evidence),
    },
    decisions: {
      available: raw.decisions.available,
      textWithheld: !t.decisions,
      entries: raw.decisions.entries.map((e) => ({
        id: e.id, date: e.date, decision: text(t.decisions, e.decision),
      })),
      evidence: ev(raw.decisions.evidence),
    },
    fleet: {
      available: raw.fleet.available,
      tracks: raw.fleet.tracks.map((x) => ({ track: x.track, lastChangeAt: x.lastChangeAt, trust: x.trust })),
      hiddenTracks: raw.fleet.hiddenTracks ?? 0,
      evidence: ev(raw.fleet.evidence),
    },
    logbook: {
      available: raw.logbook.available,
      textWithheld: !t.logbook,
      entries: raw.logbook.entries.map((e) => ({ title: text(t.logbook, e.title) })),
      evidence: ev(raw.logbook.evidence),
    },
    ci: {
      available: raw.ci.available,
      lights: raw.ci.lights.map((l) => ({ repository: l.repository, state: l.state, at: l.at })),
      hiddenCiRepositories: raw.ci.hiddenCiRepositories ?? 0,
      evidence: ev(raw.ci.evidence),
    },
  };
}

export async function buildSnapshot({ fixture = null } = {}) {
  if (fixture) return JSON.parse(await readFile(fixture, 'utf8'));

  setPublicRepos(await readJson('data/public-repos.json', []));
  setPublicTracks((await readJson('data/public-tracks.json', {})).tracks ?? []);
  const workstreams = await readJson('data/workstreams.json', []);
  const ciRepos = await readJson('data/ci-repos.json', ['stack-control']);

  const [pullRequests, merged, tracker, decisions, fleet, logbook, ci] = await Promise.all([
    collectPullRequests(), collectMergedRecent(7), collectTracker(),
    collectDecisions(), collectFleet(), collectLogbook(), collectCi(ciRepos),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    workstreams,
    pullRequests, merged, tracker, decisions, fleet, logbook, ci,
  };
}

async function main() {
  const outName = arg('out', 'public');
  const outDir = join(ROOT, outName);
  const strict = !process.argv.includes('--no-strict');

  const termCount = loadDenyTerms(join(ROOT, 'data/deny-terms.json'));

  const textPolicy = await readJson('data/publish-text.json', {});
  const raw = await buildSnapshot({ fixture: arg('fixture') });
  const reduced = arg('fixture') ? raw : toPublicSnapshot(raw, textPolicy);

  // SANITIZE-GATE — fail-closed. Alles hierna is publicabel of we publiceren niet.
  const { snapshot, findings } = assertPublishable(reduced, { strict });
  if (findings.length) console.warn(`sanitize: ${findings.length} bevinding(en) geredigeerd (niet-strikte modus)`);

  const html = renderHtml(snapshot, { refreshSeconds: REFRESH_SECONDS });

  // Verse directory: nooit een oud of per ongeluk meegekomen bestand mee-uploaden.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'index.html'), html, 'utf8');
  await writeFile(join(outDir, 'status.json'), `${JSON.stringify({
    contractVersion: snapshot.contractVersion,
    generatedAt: snapshot.generatedAt,
    overallStatus: snapshot.overallStatus,
    sources: snapshot.sources,
  }, null, 2)}\n`, 'utf8');
  await writeFile(join(outDir, '.nojekyll'), '', 'utf8');

  // De volledige interne snapshot blijft lokaal — buiten de publicatiemap, buiten git.
  await mkdir(join(ROOT, '.local'), { recursive: true });
  await writeFile(join(ROOT, '.local/snapshot.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

  const degraded = snapshot.sources.filter((s) => s.trust !== 'VERIFIED_CURRENT');
  console.log(`gebouwd: ${relative(ROOT, join(outDir, 'index.html'))} (allowlist: ${PUBLISH_ALLOWLIST.join(', ')})`);
  console.log(`deny-terms geladen: ${termCount}`);
  const vrijgegeven = ['trackerUpdates', 'trackerDecisionPoints', 'decisions', 'logbook'].filter((k) => textPolicy[k]);
  console.log(`vrije tekst gepubliceerd: ${vrijgegeven.length ? vrijgegeven.join(', ') : 'geen (alleen structuur)'}`);
  console.log(`status: ${snapshot.overallStatus}${degraded.length ? ` · niet-geverifieerd: ${degraded.map((s) => `${s.key}=${s.trust}`).join(', ')}` : ''}`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  // Alleen de melding, nooit de stack: een stacktrace bevat absolute runnerpaden.
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
