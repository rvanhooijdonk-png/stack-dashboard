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
import { validate } from './lib/validate.mjs';
import {
  collectPullRequests, collectMergedRecent, collectTracker,
  collectDecisions, collectFleet, collectLogbook, collectCi, setPublicRepos, setPublicTracks,
} from './lib/collect.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** 2.0.0: de derde review sloopte velden uit het contract (evidence.source, vrije tekst). */
const CONTRACT_VERSION = '2.0.0';
const REFRESH_SECONDS = 900;
/** Een titel is een naam, geen alinea. Langer = iemand plakt iets waar het niet hoort. */
const MAX_TITLE = 80;
/** Een raming is een duur. Alles wat daar niet op lijkt is status- of proza-tekst. */
const ESTIMATE_RE = /^(?:\d{1,3}(?:[.,]\d)?(?:\s*[–-]\s*\d{1,3}(?:[.,]\d)?)?\s*)?(?:minuten|min|uur|uren|dagen|weken)$/i;

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
 * Lees het tekstbeleid streng. `"false"` is een string en dus truthy — een tikfout in JSON zou
 * onder een losse truthiness-check de hele sectie openzetten (bewezen probe, Codex 23-07-2026).
 * Daarom: alleen bekende sleutels, alleen echte booleans, anders breekt de build af.
 */
export function readTextPolicy(input = {}) {
  const policy = { ...TEXT_OFF };
  for (const [key, value] of Object.entries(input)) {
    if (key.startsWith('_')) continue;
    if (!(key in TEXT_OFF)) throw new Error(`publish-text.json: onbekende sleutel "${key}"`);
    if (typeof value !== 'boolean') throw new Error(`publish-text.json: "${key}" moet true of false zijn, geen ${typeof value}`);
    policy[key] = value;
  }
  return policy;
}

/**
 * Roadmapregel: publiceren is een expliciete boolean per regel, de titel is een naam en de
 * raming is een duur. Voldoet iets daar niet aan, dan valt die regel terug op alleen zijn nummer.
 */
function publicWorkstream(w) {
  const open = w.public === true;
  const title = open && typeof w.title === 'string' && w.title.length <= MAX_TITLE ? w.title : null;
  const estimate = open && typeof w.estimate === 'string' && ESTIMATE_RE.test(w.estimate.trim())
    ? w.estimate.trim() : null;
  return { id: String(w.id), title, estimate };
}

/**
 * Reduceer de interne snapshot tot wat de pagina toont — veld voor veld, met de hand.
 * Er is bewust geen spread: een nieuw veld in een collector verschijnt hier niet vanzelf.
 */
export function toPublicSnapshot(raw, textPolicy = {}) {
  const t = readTextPolicy(textPolicy);
  /** Vrije tekst komt er alleen in als iemand die sectie expliciet heeft vrijgegeven. */
  const text = (allowed, value) => (allowed ? value : null);
  // `source` is een intern bronpad ("stack-control / AUDIT-INPUT/…") en gaat er niet in:
  // op een openbare pagina is het pad zelf een aanwijzing. De sectiekop zegt genoeg.
  const ev = (e) => ({ retrievedAt: e.retrievedAt, trust: e.trust, error: e.error ?? null });

  const sources = ['pullRequests', 'merged', 'tracker', 'decisions', 'fleet', 'logbook', 'ci']
    .map((key) => ({ key, trust: raw[key].evidence.trust, retrievedAt: raw[key].evidence.retrievedAt }));

  return {
    contractVersion: CONTRACT_VERSION,
    generatedAt: raw.generatedAt,
    overallStatus: sources.every((s) => s.trust === 'VERIFIED_CURRENT') ? 'OK' : 'DEGRADED',
    sources,
    workstreams: raw.workstreams.map(publicWorkstream),
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
      // Twee schakelaars, twee vlaggen. Eén gecombineerde vlag beweerde "alle titels verborgen"
      // terwijl er een halve sectie wél tekst toonde.
      updatesTextWithheld: !t.trackerUpdates,
      decisionPointsTextWithheld: !t.trackerDecisionPoints,
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

/**
 * Er is één weg naar publicatie. De vorige `--fixture`-modus sloeg `toPublicSnapshot()` over en
 * schreef een bestand rechtstreeks naar `public/` — een tweede, ongecontroleerde publicatiebuild
 * (bewezen probe, Codex 23-07-2026). Die modus is weg; fixtures dienen de tests, niet de output.
 */
export async function buildSnapshot() {
  setPublicRepos(await readJson('data/public-repos.json', []));
  setPublicTracks((await readJson('data/public-tracks.json', {})).tracks ?? []);
  const workstreams = (await readJson('data/workstreams.json', {})).workstreams ?? [];
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

  const textPolicy = readTextPolicy(await readJson('data/publish-text.json', {}));
  const raw = await buildSnapshot();
  const reduced = toPublicSnapshot(raw, textPolicy);

  // SANITIZE-GATE — fail-closed. Alles hierna is publicabel of we publiceren niet.
  const { snapshot, findings } = assertPublishable(reduced, { strict });
  if (findings.length) console.warn(`sanitize: ${findings.length} bevinding(en) geredigeerd (niet-strikte modus)`);

  // CONTRACT-GATE — werkelijk tegen het schema, niet alleen op sleutelnamen. Een veld dat het
  // contract niet kent, is een veld waar niemand naar gekeken heeft: dat gaat er niet uit.
  const status = {
    contractVersion: snapshot.contractVersion,
    generatedAt: snapshot.generatedAt,
    overallStatus: snapshot.overallStatus,
    sources: snapshot.sources,
  };
  const errors = [
    ...validate(await readJson('contracts/dashboard-snapshot.schema.json', {}), snapshot),
    ...validate(await readJson('contracts/status-json.schema.json', {}), status),
  ];
  if (errors.length) throw new Error(`contract geschonden:\n- ${errors.join('\n- ')}`);

  const html = renderHtml(snapshot, { refreshSeconds: REFRESH_SECONDS });

  // Verse directory: nooit een oud of per ongeluk meegekomen bestand mee-uploaden.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'index.html'), html, 'utf8');
  await writeFile(join(outDir, 'status.json'), `${JSON.stringify(status, null, 2)}\n`, 'utf8');
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
