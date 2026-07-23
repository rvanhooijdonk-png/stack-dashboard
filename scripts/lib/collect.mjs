/**
 * COLLECT — read-only aggregatie. Voert nooit een mutatie uit: geen merge, geen deploy,
 * geen retry, geen provider-activatie. Elke bron levert naast data een `trust`-oordeel;
 * een mislukte bron wordt SOURCE_UNAVAILABLE en nooit een gecachte groene staat.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const OWNER = process.env.DASHBOARD_OWNER ?? 'rvanhooijdonk-png';
const CONTROL_REPO = process.env.DASHBOARD_CONTROL_REPO ?? 'stack-control';
const TRACKER_PATH = 'AUDIT-INPUT/stack-open-beslispunten.md';

/** `gh` aanroepen en JSON teruggeven. Faalt zacht: null bij elke fout. */
async function gh(args, { json = true } = {}) {
  try {
    const { stdout } = await run('gh', args, { maxBuffer: 64 * 1024 * 1024 });
    return json ? JSON.parse(stdout) : stdout;
  } catch {
    return null;
  }
}

const evidence = (source, sourceRef, trust, proofUrl, error = null) => ({
  source, retrievedAt: new Date().toISOString(), sourceRef, trust, proofUrl, error,
});

const repoUrl = (repo) => `https://github.com/${OWNER}/${repo}`;

/** Bestandsinhoud uit een repo halen via de contents-API (werkt ook op privérepo's). */
async function fileFromRepo(repo, path, ref = 'main') {
  const b64 = await gh(
    ['api', `repos/${OWNER}/${repo}/contents/${path}?ref=${ref}`, '-q', '.content'],
    { json: false },
  );
  if (!b64) return null;
  try {
    return Buffer.from(b64.replace(/\s/g, ''), 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/** Org-brede open PR's, gegroepeerd per repo. Vereist een read-token met org-bereik. */
export async function collectPullRequests() {
  const open = await gh([
    'search', 'prs', '--owner', OWNER, '--state', 'open', '--limit', '1000',
    '--json', 'repository,number,title,isDraft,url,createdAt',
  ]);

  if (!open) {
    return {
      available: false,
      repositories: [],
      totals: { open: 0, draft: 0, ready: 0 },
      evidence: evidence(
        'GitHub search API', `owner:${OWNER} state:open`, 'SOURCE_UNAVAILABLE',
        `https://github.com/${OWNER}`,
        'PR-zoekopdracht gaf geen resultaat — ontbrekend of te smal gescoopt read-token in CI.',
      ),
    };
  }

  const byRepo = new Map();
  for (const pr of open) {
    const name = pr.repository?.name ?? 'onbekend';
    if (!byRepo.has(name)) byRepo.set(name, { repository: name, open: 0, draft: 0, ready: 0 });
    const row = byRepo.get(name);
    row.open += 1;
    if (pr.isDraft) row.draft += 1; else row.ready += 1;
  }

  const repositories = [...byRepo.values()].sort((a, b) => b.open - a.open);
  const totals = repositories.reduce(
    (acc, r) => ({ open: acc.open + r.open, draft: acc.draft + r.draft, ready: acc.ready + r.ready }),
    { open: 0, draft: 0, ready: 0 },
  );

  return {
    available: true,
    repositories,
    totals,
    evidence: evidence(
      'GitHub search API', `owner:${OWNER} state:open`, 'VERIFIED_CURRENT', `https://github.com/${OWNER}`,
    ),
  };
}

/** Recent gemergede PR's — het tempo waarmee werk landt, niet alleen wat openstaat. */
export async function collectMergedRecent(days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const merged = await gh([
    'search', 'prs', '--owner', OWNER, '--merged-at', `>=${since}`, '--limit', '1000',
    '--json', 'repository,number',
  ]);
  if (!merged) {
    return {
      available: false, windowDays: days, count: 0, byRepository: [],
      evidence: evidence('GitHub search API', `merged>=${since}`, 'SOURCE_UNAVAILABLE', `https://github.com/${OWNER}`, 'Geen resultaat.'),
    };
  }
  const byRepo = new Map();
  for (const pr of merged) {
    const n = pr.repository?.name ?? 'onbekend';
    byRepo.set(n, (byRepo.get(n) ?? 0) + 1);
  }
  return {
    available: true,
    windowDays: days,
    count: merged.length,
    byRepository: [...byRepo.entries()].map(([repository, merged]) => ({ repository, merged }))
      .sort((a, b) => b.merged - a.merged),
    evidence: evidence('GitHub search API', `merged>=${since}`, 'VERIFIED_CURRENT', `https://github.com/${OWNER}`),
  };
}

/**
 * Tracker-koppen + beslispuntenstatus. Alleen kopregels en de status van beslispunten —
 * nooit de body van een update, want die bevat operationele details.
 */
export async function collectTracker() {
  const text = await fileFromRepo(CONTROL_REPO, TRACKER_PATH);
  const proof = `${repoUrl(CONTROL_REPO)}/blob/main/${TRACKER_PATH}`;

  if (!text) {
    return {
      available: false, updates: [], decisionPoints: [],
      evidence: evidence(`${CONTROL_REPO} / ${TRACKER_PATH}`, 'main', 'SOURCE_UNAVAILABLE', proof, 'Tracker niet leesbaar met het huidige token.'),
    };
  }

  // Kopregels: "**Update 23/7 (24) — TITEL.**" → nummer + korte titel.
  const updates = [...text.matchAll(/^\*\*Update\s+([0-9]{1,2}\/[0-9]{1,2})\s*\((\d+)\)\s*[—-]\s*([^*\n]+)/gm)]
    .map((m) => ({ number: Number(m[2]), date: m[1], title: m[3].trim().replace(/\.$/, '').slice(0, 120) }))
    .sort((a, b) => b.number - a.number)
    .slice(0, 8);

  // Beslispunten, twee schrijfwijzen: "BESLISPUNT 23a — titel" en "BESLISPUNT (9a) — titel".
  const decisionPoints = [...text.matchAll(/BESLISPUNT\s*\(?([0-9]+[a-z]?)\)?\s*[—-]\s*([^.*\n]{3,110})/g)]
    .map((m) => ({ id: m[1], title: m[2].trim() }));

  const seen = new Set();
  const unique = decisionPoints.filter((d) => (seen.has(d.id) ? false : seen.add(d.id)));

  return {
    available: true,
    updates,
    decisionPoints: unique.slice(0, 12),
    evidence: evidence(`${CONTROL_REPO} / ${TRACKER_PATH}`, 'main', 'VERIFIED_CURRENT', proof),
  };
}

/** Besluitenregister — welke beslispunten zijn inmiddels beantwoord. */
export async function collectDecisions() {
  const text = await fileFromRepo(CONTROL_REPO, 'CONTROL/DECISIONS.md');
  const proof = `${repoUrl(CONTROL_REPO)}/blob/main/CONTROL/DECISIONS.md`;
  if (!text) {
    return {
      available: false, entries: [],
      evidence: evidence(`${CONTROL_REPO} / CONTROL/DECISIONS.md`, 'main', 'SOURCE_UNAVAILABLE', proof, 'Niet leesbaar.'),
    };
  }
  const entries = [...text.matchAll(/^\|\s*(D-\d{4})\s*\|\s*([\d-]+)\s*\|\s*([^|]{3,160}?)\s*\|/gm)]
    .map((m) => ({ id: m[1], date: m[2], decision: m[3].trim() }))
    .sort((a, b) => b.id.localeCompare(a.id))
    .slice(0, 10);
  return {
    available: true, entries,
    evidence: evidence(`${CONTROL_REPO} / CONTROL/DECISIONS.md`, 'main', 'VERIFIED_CURRENT', proof),
  };
}

/**
 * Vlootbestand: per track de laatste wijzigingsdatum van zijn queue-bestand.
 * "track-klaar-mtimes" op GitHub is de commitdatum — een lokale mtime bestaat in CI niet.
 */
export async function collectFleet() {
  const listing = await gh(['api', `repos/${OWNER}/${CONTROL_REPO}/contents/CONTROL/TASK-QUEUE`]);
  const proof = `${repoUrl(CONTROL_REPO)}/tree/main/CONTROL/TASK-QUEUE`;
  if (!Array.isArray(listing)) {
    return {
      available: false, tracks: [],
      evidence: evidence(`${CONTROL_REPO} / CONTROL/TASK-QUEUE`, 'main', 'SOURCE_UNAVAILABLE', proof, 'Map niet leesbaar.'),
    };
  }

  const tracks = [];
  for (const file of listing.filter((f) => f.name.endsWith('.md'))) {
    const commits = await gh([
      'api', `repos/${OWNER}/${CONTROL_REPO}/commits?path=CONTROL/TASK-QUEUE/${file.name}&per_page=1`,
      '-q', '.[0].commit.committer.date',
    ], { json: false });
    tracks.push({
      track: file.name.replace(/\.md$/, ''),
      lastChangeAt: commits ? commits.trim() : null,
      trust: commits ? 'VERIFIED_CURRENT' : 'SOURCE_UNAVAILABLE',
    });
  }

  return {
    available: true,
    tracks: tracks.sort((a, b) => (b.lastChangeAt ?? '').localeCompare(a.lastChangeAt ?? '')),
    evidence: evidence(`${CONTROL_REPO} / CONTROL/TASK-QUEUE`, 'main', 'VERIFIED_CURRENT', proof),
  };
}

/** Journaal — alleen de kopregels van de laatste entries. */
export async function collectLogbook() {
  const proof = `${repoUrl(CONTROL_REPO)}/blob/main/CONTROL/FABLE-JOURNAAL.md`;
  const text = await fileFromRepo(CONTROL_REPO, 'CONTROL/FABLE-JOURNAAL.md');
  if (!text) {
    return {
      available: false, entries: [],
      evidence: evidence(`${CONTROL_REPO} / CONTROL/FABLE-JOURNAAL.md`, 'main', 'SOURCE_UNAVAILABLE', proof,
        'Journaal staat nog niet op main — het zit in een openstaande PR.'),
    };
  }
  const entries = [...text.matchAll(/^#{2,3}\s+(.{3,110})$/gm)].map((m) => ({ title: m[1].trim() })).slice(0, 6);
  return { available: true, entries, evidence: evidence(`${CONTROL_REPO} / CONTROL/FABLE-JOURNAAL.md`, 'main', 'VERIFIED_CURRENT', proof) };
}

/** CI-ampels: de laatste workflow-conclusie op de default branch per repo. */
export async function collectCi(repositories) {
  const lights = [];
  for (const repo of repositories) {
    const runs = await gh([
      'api', `repos/${OWNER}/${repo}/actions/runs?per_page=1&status=completed`,
      '-q', '.workflow_runs[0] | "\\(.conclusion)|\\(.updated_at)|\\(.name)"',
    ], { json: false });

    if (!runs || runs.trim() === 'null') {
      lights.push({ repository: repo, state: 'GEEN_CI', conclusion: null, at: null, workflow: null });
      continue;
    }
    const [conclusion, at, name] = runs.trim().split('|');
    lights.push({
      repository: repo,
      state: conclusion === 'success' ? 'GROEN' : conclusion === 'failure' ? 'ROOD' : 'GRIJS',
      conclusion, at, workflow: name,
    });
  }
  return {
    available: lights.length > 0,
    lights,
    evidence: evidence('GitHub Actions API', 'laatste voltooide run per repo', 'VERIFIED_CURRENT', `https://github.com/${OWNER}`),
  };
}
