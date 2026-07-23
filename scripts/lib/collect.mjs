/**
 * COLLECT — read-only aggregatie. Voert nooit een mutatie uit: geen merge, geen deploy,
 * geen retry, geen provider-activatie.
 *
 * Twee regels die uit de review van 23-07-2026 komen en die hier leidend zijn:
 *
 * 1. **Een fout is geen leegte.** `gh()` geeft `{ok:false}` bij een mislukte aanroep en
 *    `{ok:true, data:null}` bij een geslaagde aanroep zonder resultaat. Wie dat door elkaar
 *    haalt, publiceert "geen CI" waar "we konden het niet vaststellen" hoort te staan.
 * 2. **Een leesbare bron met nul herkende regels is niet geverifieerd.** Dan is de parser stuk,
 *    en dat is een `UNVERIFIED`-toestand, geen groene.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const OWNER = validName(process.env.DASHBOARD_OWNER ?? 'rvanhooijdonk-png', 'DASHBOARD_OWNER');
const CONTROL_REPO = validName(process.env.DASHBOARD_CONTROL_REPO ?? 'stack-control', 'DASHBOARD_CONTROL_REPO');
const TRACKER_PATH = 'AUDIT-INPUT/stack-open-beslispunten.md';
const GH_TIMEOUT_MS = 60_000;

/** GitHub-namen zijn alfanumeriek met `-._`. Alles daarbuiten is geen naam maar een poging. */
function validName(value, label) {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(value)) throw new Error(`ongeldige ${label}`);
  return value;
}

/**
 * Repo's die bij naam getoond mogen worden. De rest wordt geaggregeerd als "overige repo's",
 * want een openbare pagina hoort geen inventaris van privérepo-namen te zijn.
 * Uitbreiden = één regel in `data/public-repos.json`.
 */
let publicRepos = new Set();
export function setPublicRepos(names) {
  publicRepos = new Set((names ?? []).filter((n) => /^[A-Za-z0-9._-]{1,100}$/.test(n)));
}
const shown = (name) => (publicRepos.has(name) ? name : null);

/** `gh` aanroepen. Onderscheidt expliciet "mislukt" van "geslaagd maar leeg". */
async function gh(args, { json = true } = {}) {
  try {
    const { stdout } = await run('gh', args, { maxBuffer: 32 * 1024 * 1024, timeout: GH_TIMEOUT_MS });
    if (!json) return { ok: true, data: stdout };
    const text = stdout.trim();
    return { ok: true, data: text === '' ? null : JSON.parse(text) };
  } catch {
    return { ok: false, data: null };
  }
}

const evidence = (source, sourceRef, trust, proofUrl, error = null) => ({
  source, retrievedAt: new Date().toISOString(), sourceRef, trust, proofUrl, error,
});

const repoUrl = (repo) => `https://github.com/${OWNER}/${repo}`;
const seg = (s) => encodeURIComponent(s);

/** Bestandsinhoud uit een repo halen via de contents-API. */
async function fileFromRepo(repo, path, ref = 'main') {
  const encoded = path.split('/').map(seg).join('/');
  const res = await gh(
    ['api', `repos/${OWNER}/${repo}/contents/${encoded}?ref=${seg(ref)}`, '-q', '.content'],
    { json: false },
  );
  if (!res.ok || !res.data?.trim()) return null;
  try {
    return Buffer.from(res.data.replace(/\s/g, ''), 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/** Een bron die leesbaar was maar niets herkenbaars opleverde, is niet geverifieerd. */
const trustFor = (count) => (count > 0 ? 'VERIFIED_CURRENT' : 'UNVERIFIED');
const parserNote = (count) => (count > 0 ? null : 'Bron gelezen, maar geen enkele regel herkend — parser mogelijk verouderd.');

/** Org-brede open PR's, gegroepeerd per repo. Vereist een read-token met org-bereik. */
export async function collectPullRequests() {
  const res = await gh([
    'search', 'prs', '--owner', OWNER, '--state', 'open', '--limit', '1000',
    '--json', 'repository,isDraft',
  ]);

  if (!res.ok) {
    return {
      available: false, repositories: [], hiddenRepositories: 0, totals: { open: 0, draft: 0, ready: 0 },
      evidence: evidence('GitHub search API', `owner:${OWNER} state:open`, 'SOURCE_UNAVAILABLE',
        `https://github.com/${OWNER}`,
        'PR-zoekopdracht mislukt — ontbrekend of te smal gescoopt read-token in CI.'),
    };
  }

  const open = res.data ?? [];
  const byRepo = new Map();
  const totals = { open: 0, draft: 0, ready: 0 };
  let hidden = 0;

  for (const pr of open) {
    const name = shown(pr.repository?.name ?? '');
    const key = name ?? '__overig__';
    if (!name) hidden += 1;
    if (!byRepo.has(key)) byRepo.set(key, { repository: name ?? 'overige repo\'s', open: 0, draft: 0, ready: 0 });
    const row = byRepo.get(key);
    row.open += 1; totals.open += 1;
    if (pr.isDraft) { row.draft += 1; totals.draft += 1; } else { row.ready += 1; totals.ready += 1; }
  }

  return {
    available: true,
    repositories: [...byRepo.values()].sort((a, b) => b.open - a.open),
    hiddenRepositories: hidden,
    totals,
    evidence: evidence('GitHub search API', `owner:${OWNER} state:open`, trustFor(open.length),
      `https://github.com/${OWNER}`, open.length ? null : 'Nul open PR\'s gerapporteerd — controleer het tokenbereik.'),
  };
}

/** Recent gemergede PR's — het tempo waarmee werk landt, niet alleen wat openstaat. */
export async function collectMergedRecent(days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const res = await gh([
    'search', 'prs', '--owner', OWNER, '--merged-at', `>=${since}`, '--limit', '1000',
    '--json', 'repository',
  ]);
  if (!res.ok) {
    return {
      available: false, windowDays: days, count: 0, byRepository: [],
      evidence: evidence('GitHub search API', `merged>=${since}`, 'SOURCE_UNAVAILABLE',
        `https://github.com/${OWNER}`, 'Zoekopdracht mislukt.'),
    };
  }
  const merged = res.data ?? [];
  const byRepo = new Map();
  for (const pr of merged) {
    const name = shown(pr.repository?.name ?? '') ?? 'overige repo\'s';
    byRepo.set(name, (byRepo.get(name) ?? 0) + 1);
  }
  return {
    available: true,
    windowDays: days,
    count: merged.length,
    byRepository: [...byRepo.entries()].map(([repository, count]) => ({ repository, merged: count }))
      .sort((a, b) => b.merged - a.merged),
    evidence: evidence('GitHub search API', `merged>=${since}`, 'VERIFIED_CURRENT', `https://github.com/${OWNER}`),
  };
}

/** Tracker: alleen kopregels en beslispunttitels — nooit de body van een update. */
export async function collectTracker() {
  const text = await fileFromRepo(CONTROL_REPO, TRACKER_PATH);
  const proof = `${repoUrl(CONTROL_REPO)}/blob/main/${TRACKER_PATH}`;
  const src = `${CONTROL_REPO} / tracker`;

  if (!text) {
    return {
      available: false, updates: [], decisionPoints: [],
      evidence: evidence(src, 'main', 'SOURCE_UNAVAILABLE', proof, 'Tracker niet leesbaar met het huidige token.'),
    };
  }

  // Kopregels: "**Update 23/7 (24) — TITEL.**"
  const updates = [...text.matchAll(/^\*\*Update\s+([0-9]{1,2}\/[0-9]{1,2})\s*\((\d+)\)\s*[—-]\s*([^*\n]{1,200})/gm)]
    .map((m) => ({ number: Number(m[2]), date: m[1], title: m[3].trim().replace(/\.$/, '').slice(0, 120) }))
    .sort((a, b) => b.number - a.number)
    .slice(0, 8);

  // Beslispunten, twee schrijfwijzen: "BESLISPUNT 23a — titel" en "BESLISPUNT (9a) — titel".
  const seen = new Set();
  const decisionPoints = [...text.matchAll(/BESLISPUNT\s*\(?([0-9]{1,3}[a-z]?)\)?\s*[—-]\s*([^.*\n]{3,110})/g)]
    .map((m) => ({ id: m[1], title: m[2].trim() }))
    .filter((d) => (seen.has(d.id) ? false : seen.add(d.id)))
    .slice(0, 12);

  const n = updates.length + decisionPoints.length;
  return {
    available: true, updates, decisionPoints,
    evidence: evidence(src, 'main', trustFor(n), proof, parserNote(n)),
  };
}

/** Besluitenregister — welke beslispunten zijn inmiddels beantwoord. */
export async function collectDecisions() {
  const text = await fileFromRepo(CONTROL_REPO, 'CONTROL/DECISIONS.md');
  const proof = `${repoUrl(CONTROL_REPO)}/blob/main/CONTROL/DECISIONS.md`;
  const src = `${CONTROL_REPO} / besluitenregister`;
  if (!text) {
    return {
      available: false, entries: [],
      evidence: evidence(src, 'main', 'SOURCE_UNAVAILABLE', proof, 'Niet leesbaar.'),
    };
  }
  const entries = [...text.matchAll(/^\|\s*(D-\d{4})\s*\|\s*([\d-]{4,12})\s*\|\s*([^|]{3,160}?)\s*\|/gm)]
    .map((m) => ({ id: m[1], date: m[2], decision: m[3].trim() }))
    .sort((a, b) => b.id.localeCompare(a.id))
    .slice(0, 10);
  return {
    available: true, entries,
    evidence: evidence(src, 'main', trustFor(entries.length), proof, parserNote(entries.length)),
  };
}

/**
 * Vlootbestand: per track de laatste wijzigingsdatum van zijn queue-bestand.
 * "track-klaar-mtimes" op GitHub is de commitdatum — een lokale mtime bestaat in CI niet.
 */
export async function collectFleet() {
  const listing = await gh(['api', `repos/${OWNER}/${CONTROL_REPO}/contents/CONTROL/TASK-QUEUE`]);
  const proof = `${repoUrl(CONTROL_REPO)}/tree/main/CONTROL/TASK-QUEUE`;
  const src = `${CONTROL_REPO} / task-queue`;

  if (!listing.ok || !Array.isArray(listing.data)) {
    return {
      available: false, tracks: [],
      evidence: evidence(src, 'main', 'SOURCE_UNAVAILABLE', proof, 'Map niet leesbaar.'),
    };
  }

  const files = listing.data.filter((f) => typeof f.name === 'string' && f.name.endsWith('.md'));
  const tracks = await Promise.all(files.map(async (file) => {
    const res = await gh([
      'api', `repos/${OWNER}/${CONTROL_REPO}/commits?path=CONTROL/TASK-QUEUE/${seg(file.name)}&per_page=1`,
      '-q', '.[0].commit.committer.date',
    ], { json: false });
    const date = res.ok ? (res.data ?? '').trim() : '';
    return {
      track: file.name.replace(/\.md$/, ''),
      lastChangeAt: date && date !== 'null' ? date : null,
      trust: res.ok ? 'VERIFIED_CURRENT' : 'SOURCE_UNAVAILABLE',
    };
  }));

  // Eén mislukte track maakt de hele sectie onbetrouwbaar — niet stilzwijgend groen.
  const failed = tracks.filter((t) => t.trust !== 'VERIFIED_CURRENT').length;
  return {
    available: true,
    tracks: tracks.sort((a, b) => (b.lastChangeAt ?? '').localeCompare(a.lastChangeAt ?? '')),
    evidence: evidence(src, 'main', failed ? 'UNVERIFIED' : trustFor(tracks.length), proof,
      failed ? `${failed} van ${tracks.length} tracks kon niet worden opgehaald.` : parserNote(tracks.length)),
  };
}

/** Journaal — alleen de kopregels van de laatste entries. */
export async function collectLogbook() {
  const proof = `${repoUrl(CONTROL_REPO)}/blob/main/CONTROL/FABLE-JOURNAAL.md`;
  const src = `${CONTROL_REPO} / journaal`;
  const text = await fileFromRepo(CONTROL_REPO, 'CONTROL/FABLE-JOURNAAL.md');
  if (!text) {
    return {
      available: false, entries: [],
      evidence: evidence(src, 'main', 'SOURCE_UNAVAILABLE', proof,
        'Journaal staat nog niet op main — het zit in een openstaande PR.'),
    };
  }
  const entries = [...text.matchAll(/^#{2,3}\s+(.{3,110})$/gm)].map((m) => ({ title: m[1].trim() })).slice(0, 6);
  return {
    available: true, entries,
    evidence: evidence(src, 'main', trustFor(entries.length), proof, parserNote(entries.length)),
  };
}

/** CI-ampels: de laatste voltooide run op de default branch, per repo. */
export async function collectCi(repositories) {
  const lights = await Promise.all(repositories.map(async (repo) => {
    validName(repo, 'DASHBOARD_CI_REPOS');

    const meta = await gh(['api', `repos/${OWNER}/${seg(repo)}`, '-q', '.default_branch'], { json: false });
    if (!meta.ok) return { repository: repo, state: 'ONBEKEND', conclusion: null, at: null, workflow: null };
    const branch = (meta.data ?? '').trim() || 'main';

    const res = await gh([
      'api', `repos/${OWNER}/${seg(repo)}/actions/runs?per_page=1&status=completed&branch=${seg(branch)}`,
      '-q', '.workflow_runs[0] | if . == null then "" else "\\(.conclusion)|\\(.updated_at)|\\(.name)" end',
    ], { json: false });

    if (!res.ok) return { repository: repo, state: 'ONBEKEND', conclusion: null, at: null, workflow: null };

    const line = (res.data ?? '').trim();
    if (!line || line.startsWith('null|')) {
      return { repository: repo, state: 'GEEN_CI', conclusion: null, at: null, workflow: null };
    }
    const [conclusion, at] = line.split('|');
    return {
      repository: repo,
      state: conclusion === 'success' ? 'GROEN' : conclusion === 'failure' ? 'ROOD' : 'GRIJS',
      conclusion, at, workflow: null,
    };
  }));

  const unknown = lights.filter((l) => l.state === 'ONBEKEND').length;
  return {
    available: lights.length > 0,
    lights,
    evidence: evidence('GitHub Actions API', 'laatste voltooide run op de default branch',
      unknown ? 'UNVERIFIED' : trustFor(lights.length), `https://github.com/${OWNER}`,
      unknown ? `${unknown} van ${lights.length} repo's kon niet worden opgehaald.` : null),
  };
}
