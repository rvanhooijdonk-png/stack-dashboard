#!/usr/bin/env node
/**
 * DASHBOARD-FEED-GENERATOR — TRANSACTIE-TICKER + CODE-TICKER.
 *
 * Richard-akkoord 18-08-2026 (FABLE-AKKOORD, vier randvoorwaarden):
 *   1. Publicatiepatroon = zelfde patroon als de bestaande stack-ticker: gepubliceerd via de
 *      contents-API op een DEDICATED branch (`dashboard-feeds`) van stack-control, nooit main,
 *      nooit de `rapporten`-branch (die heeft al een eigen schrijver: REGIE). Alleen committen
 *      als de inhoud echt wijzigt (geen commit-vervuiling).
 *   2. Sanering blijft hard: vóór elke publicatie lopen beide feeds door de ECHTE
 *      parseTransactieFeed()/parseCodeTickerFeed() uit stack-dashboard (dezelfde adversarial
 *      tests als de testsuite). Faalt één van de twee → GEEN publicatie, van geen van beide.
 *   3. Bronnen strikt read-only: dispatcher-functielog (state/director-dispatcher.jsonl),
 *      watchdog-heartbeat (state/director_watchdog_heartbeat.json), receipts
 *      (outbox/*_RECEIPT.md — uitsluitend het vaste key=value-kopblok, nooit de vrije
 *      '## Actoruitvoer'-body), en `gh pr list` voor git-events. Raakt NOOIT de queue
 *      (queue-packages/, execution-queue/), het lockbestand, of de lopende Proef B.
 *   4. Launchd-plist voor dit script wordt apart geleverd, klaar voor Richard — dit script
 *      laadt zichzelf nooit in launchd.
 *
 * Cadans: de generator mag zo vaak draaien als hij wil, maar publiceren heeft toch geen zin
 * vaker dan de site zelf herbouwt (~15 min: com.rvh.dashboard-heartbeat StartInterval=900 +
 * publish.yml). Het meegeleverde launchd-plist gebruikt daarom ook StartInterval=900.
 */

import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD_ROOT =
  process.env.DASHBOARD_FEED_GENERATOR_DASHBOARD_ROOT ?? join(ROOT, '..', 'stack-dashboard');

const OWNER = 'rvanhooijdonk-png';
const CONTROL_REPO = 'stack-control';
const DASHBOARD_REPO = 'stack-dashboard';
const FEEDS_REF = 'dashboard-feeds';
const BASE_REF = 'main';
const FEEDS_PATH = {
  transactie: 'CONTROL/FEEDS/transactie-feed.json',
  codeTicker: 'CONTROL/FEEDS/code-ticker-feed.json',
};

const LANES = ['claude1', 'claude2', 'claude3', 'claude4', 'codex1', 'codex2'];
const HEARTBEAT_STALE_MS = 3 * 60 * 1000; // 3x het watchdog-eigen 60s-interne-loopritme
const CAP = 500;

function log(msg) {
  process.stderr.write(`[dashboard-feed-generator] ${msg}\n`);
}

function gh(args, { input } = {}) {
  const r = spawnSync('gh', args, { encoding: 'utf8', input });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function ghApiGet(path) {
  const r = gh(['api', path]);
  if (r.status !== 0) {
    if (/HTTP 404|Not Found/i.test(r.stderr)) return { status: 404, json: null };
    throw new Error(`gh api GET ${path} faalde: ${r.stderr.trim()}`);
  }
  return { status: 200, json: JSON.parse(r.stdout) };
}

function ghApiSend(method, path, body) {
  const r = gh(['api', path, '-X', method, '--input', '-'], { input: JSON.stringify(body) });
  if (r.status !== 0) throw new Error(`gh api ${method} ${path} faalde: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
}

function isoFromEpochSeconds(sec) {
  return new Date(sec * 1000).toISOString();
}

function clampDetail(s) {
  return String(s ?? '').slice(0, 200);
}

// ---------------------------------------------------------------------------
// Bron 1: dispatcher-functielog (read-only) — state/director-dispatcher.jsonl
// ---------------------------------------------------------------------------
const PACKAGE_OUTCOME_KIND = {
  already_ingested: 'TASK_ALREADY_INGESTED',
  ingested_ready: 'TASK_INGESTED_READY',
  ingress_blocked_exit_1: 'TASK_INGRESS_BLOCKED',
  ingress_blocked_exit_3: 'TASK_INGRESS_BLOCKED',
};

async function dispatcherEvents() {
  const events = [];
  let text;
  try {
    text = await readFile(join(ROOT, 'state/director-dispatcher.jsonl'), 'utf8');
  } catch {
    return events;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // nooit gokken op een kapotte regel
    }
    if (typeof rec.at !== 'number') continue;
    const at = isoFromEpochSeconds(rec.at);
    events.push({
      at,
      source: 'dispatcher',
      kind: 'DISPATCHER_RUN',
      detail: clampDetail(
        `${rec.orders_seen ?? 0} orders gezien, ${rec.tasks_geseed ?? 0} geseed, ${rec.runs_gestart ?? 0} runs gestart`,
      ),
    });
    for (const outcome of rec.package_outcomes ?? []) {
      const kind = PACKAGE_OUTCOME_KIND[outcome?.action];
      if (!kind || !outcome?.file) continue; // onbekende action: nooit gokken
      events.push({
        at,
        source: 'queue',
        kind,
        detail: clampDetail(`${outcome.file} (${outcome.action})`),
      });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Bron 2: watchdog-heartbeat (read-only) — state/director_watchdog_heartbeat.json
// ---------------------------------------------------------------------------
async function healthEvents() {
  let raw;
  try {
    raw = await readFile(join(ROOT, 'state/director_watchdog_heartbeat.json'), 'utf8');
  } catch {
    return [];
  }
  let hb;
  try {
    hb = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!hb?.heartbeat) return [];
  const ageMs = Date.now() - Date.parse(hb.heartbeat);
  if (!Number.isFinite(ageMs)) return [];
  const kind = ageMs <= HEARTBEAT_STALE_MS ? 'HEALTH_OK' : 'HEALTH_STALE';
  return [
    {
      at: hb.heartbeat,
      source: 'health',
      kind,
      detail: clampDetail(`watchdog-heartbeat, ${Math.round(ageMs / 1000)}s oud`),
    },
  ];
}

// ---------------------------------------------------------------------------
// Bron 3: git-events (read-only) — gh pr list, geen titels/free-text, alleen repo#nummer
// ---------------------------------------------------------------------------
async function gitEvents() {
  const events = [];
  for (const repo of [CONTROL_REPO, DASHBOARD_REPO]) {
    const r = gh([
      'pr', 'list', '--repo', `${OWNER}/${repo}`, '--state', 'all', '--limit', '30',
      '--json', 'number,createdAt,mergedAt',
    ]);
    if (r.status !== 0) {
      log(`gh pr list voor ${repo} faalde, sla git-events voor deze repo over: ${r.stderr.trim()}`);
      continue;
    }
    let prs;
    try {
      prs = JSON.parse(r.stdout);
    } catch {
      continue;
    }
    for (const pr of prs) {
      const detail = clampDetail(`${repo}#${pr.number}`);
      if (pr.createdAt) events.push({ at: pr.createdAt, source: 'git', kind: 'GIT_PR_OPENED', detail });
      if (pr.mergedAt) events.push({ at: pr.mergedAt, source: 'git', kind: 'GIT_PR_MERGED', detail });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Bron 4: outbox/*_RECEIPT.md — UITSLUITEND het vaste key=value-kopblok van bin/dispatch-actor.
// De vrije '## Actoruitvoer'-body wordt nooit gelezen/geparsed.
// ---------------------------------------------------------------------------
function orderIdFromFilename(filename) {
  const stem = basename(filename).replace(/_RECEIPT\.md$/, '');
  const cleaned = stem.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 80);
  return /^[A-Z0-9]/.test(cleaned) ? cleaned : null;
}

function parseReceiptHeader(text) {
  const m = text.match(/```text\n([\s\S]*?)\n```/);
  if (!m) return null;
  const kv = {};
  for (const line of m[1].split('\n')) {
    const kvm = line.match(/^([A-Za-z_]+)=(.*)$/);
    if (kvm) kv[kvm[1]] = kvm[2];
  }
  if (!kv.actor || !kv.started_at || !kv.ended_at || kv.exit_code === undefined) return null;
  return kv;
}

async function receiptEntries() {
  const entries = [];
  let files;
  try {
    files = (await readdir(join(ROOT, 'outbox'))).filter((f) => f.endsWith('_RECEIPT.md'));
  } catch {
    return entries;
  }
  for (const f of files) {
    let text;
    try {
      text = await readFile(join(ROOT, 'outbox', f), 'utf8');
    } catch {
      continue;
    }
    const kv = parseReceiptHeader(text);
    if (!kv) continue; // geen exacte match op het vaste kopblok: overslaan, nooit gokken
    if (!LANES.includes(kv.actor)) continue;
    const exitCode = Number.parseInt(kv.exit_code, 10);
    if (!Number.isInteger(exitCode)) continue;
    const orderId = orderIdFromFilename(f);
    entries.push({ at: kv.started_at, lane: kv.actor, action: 'DISPATCH_START', result: 'STARTED', orderId });
    entries.push({
      at: kv.ended_at,
      lane: kv.actor,
      action: 'DISPATCH_END',
      result: exitCode === 0 ? 'OK' : 'FAIL',
      exitCode,
      orderId,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Samenstellen + het adversarial gate (poort 2, condition 2): de ECHTE parsers uit
// stack-dashboard beslissen, niet dit script.
// ---------------------------------------------------------------------------
function sortAscendingByAt(items) {
  return items
    .filter((x) => Number.isFinite(Date.parse(x.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function capped(items, label) {
  const sorted = sortAscendingByAt(items);
  if (sorted.length <= CAP) return sorted;
  log(`${label}: ${sorted.length - CAP} oudste items afgekapt (cap=${CAP}) — alleen de meest recente ${CAP} gepubliceerd.`);
  return sorted.slice(sorted.length - CAP);
}

async function buildFeeds() {
  const [dEvents, hEvents, gEvents, rEntries] = await Promise.all([
    dispatcherEvents(),
    healthEvents(),
    gitEvents(),
    receiptEntries(),
  ]);
  const generatedAt = new Date().toISOString();
  return {
    transactieFeed: {
      generatedAt,
      events: capped([...dEvents, ...hEvents, ...gEvents], 'transactie-feed'),
    },
    codeTickerFeed: {
      generatedAt,
      entries: capped(rEntries, 'code-ticker-feed'),
    },
  };
}

async function loadValidators() {
  const { parseTransactieFeed } = await import(join(DASHBOARD_ROOT, 'scripts/lib/transactie-feed.mjs'));
  const { parseCodeTickerFeed } = await import(join(DASHBOARD_ROOT, 'scripts/lib/code-ticker-feed.mjs'));
  const transactieSchema = JSON.parse(
    await readFile(join(DASHBOARD_ROOT, 'data/transactie-feed.schema.json'), 'utf8'),
  );
  const codeTickerSchema = JSON.parse(
    await readFile(join(DASHBOARD_ROOT, 'data/code-ticker-feed.schema.json'), 'utf8'),
  );
  return { parseTransactieFeed, parseCodeTickerFeed, transactieSchema, codeTickerSchema };
}

// ---------------------------------------------------------------------------
// Publicatie — contents-API op de dedicated `dashboard-feeds`-branch van stack-control.
// Nooit main, nooit de `rapporten`-branch. Alleen committen bij echte inhoudswijziging.
// ---------------------------------------------------------------------------
function ensureFeedsBranch() {
  const existing = ghApiGet(`repos/${OWNER}/${CONTROL_REPO}/git/ref/heads/${FEEDS_REF}`);
  if (existing.status === 200) return;
  const base = ghApiGet(`repos/${OWNER}/${CONTROL_REPO}/git/ref/heads/${BASE_REF}`);
  if (base.status !== 200) throw new Error(`kan basis-ref ${BASE_REF} niet lezen`);
  ghApiSend('POST', `repos/${OWNER}/${CONTROL_REPO}/git/refs`, {
    ref: `refs/heads/${FEEDS_REF}`,
    sha: base.json.object.sha,
  });
  log(`branch ${FEEDS_REF} aangemaakt vanaf ${BASE_REF}@${base.json.object.sha}`);
}

function publishFile(path, obj, label) {
  const contentText = `${JSON.stringify(obj, null, 2)}\n`;
  const contentB64 = Buffer.from(contentText, 'utf8').toString('base64');
  const existing = ghApiGet(
    `repos/${OWNER}/${CONTROL_REPO}/contents/${path}?ref=${FEEDS_REF}`,
  );
  if (existing.status === 200) {
    const currentText = Buffer.from(existing.json.content, 'base64').toString('utf8');
    if (currentText === contentText) {
      log(`${label}: inhoud ongewijzigd, geen commit (geen commit-vervuiling).`);
      return { published: false };
    }
  }
  const body = {
    message: `feeds: ${label} bijgewerkt (dashboard-feed-generator)`,
    content: contentB64,
    branch: FEEDS_REF,
    ...(existing.status === 200 ? { sha: existing.json.sha } : {}),
  };
  const res = ghApiSend('PUT', `repos/${OWNER}/${CONTROL_REPO}/contents/${path}`, body);
  log(`${label}: gepubliceerd, commit ${res.commit?.sha ?? '?'}`);
  return { published: true, sha: res.commit?.sha };
}

async function main() {
  const { transactieFeed, codeTickerFeed } = await buildFeeds();
  const { parseTransactieFeed, parseCodeTickerFeed, transactieSchema, codeTickerSchema } =
    await loadValidators();

  const tResult = parseTransactieFeed(transactieFeed, transactieSchema, { now: new Date() });
  const cResult = parseCodeTickerFeed(codeTickerFeed, codeTickerSchema, { now: new Date() });

  if (!tResult.available) {
    log(`GEEN publicatie: transactie-feed valt niet door de adversarial gate (code=${tResult.code}).`);
    process.exitCode = 1;
    return;
  }
  if (!cResult.available) {
    log(`GEEN publicatie: code-ticker-feed valt niet door de adversarial gate (code=${cResult.code}).`);
    process.exitCode = 1;
    return;
  }

  ensureFeedsBranch();
  publishFile(FEEDS_PATH.transactie, transactieFeed, 'transactie-feed');
  publishFile(FEEDS_PATH.codeTicker, codeTickerFeed, 'code-ticker-feed');
  log('klaar.');
}

main().catch((err) => {
  log(`FOUT: ${err.stack ?? err.message}`);
  process.exitCode = 1;
});
