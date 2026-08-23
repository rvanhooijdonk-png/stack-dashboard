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
 *
 * Bekende, bewust geaccepteerde restpunten na Codex/Gemini-review op PR#71 (2026-08-18):
 *  - De twee publicaties (transactie/code-ticker) zijn twee losse PUTs, niet één atomaire
 *    transactie. Slaagt de eerste en faalt de tweede, dan staat er tijdelijk een half
 *    bijgewerkte set — zichtbaar via de non-zero exit + FOUT-logregel, en zelfherstellend op de
 *    volgende cyclus (~15 min) omdat elke run idempotent opnieuw alle bronnen leest.
 *  - `orderIdFromFilename()` haalt verboden tekens weg i.p.v. af te wijzen: twee verschillende
 *    receipt-bestandsnamen kunnen zo in theorie tot hetzelfde orderId leiden. Alleen een
 *    weergave-kwestie (geen datalek, geen route naar de queue) — niet opgelost, wel benoemd.
 */

import { readFile, readdir, lstat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD_ROOT =
  process.env.DASHBOARD_FEED_GENERATOR_DASHBOARD_ROOT ?? join(ROOT, '..', 'stack-dashboard');

// De eigenaar van `stack-control` en van de bewaakte persoonlijke repo's. Die verhuizen NIET mee
// met een organisatieoverdracht van `stack-dashboard`; dit is dus geen achterstallige hardcodering
// maar de eigenaar van een ander object. Zie `scripts/lib/repo-identity.mjs`.
const CONTROL_OWNER = 'rvanhooijdonk-png';
const CONTROL_REPO = 'stack-control';
const DASHBOARD_REPO = 'stack-dashboard';

/**
 * Waar `stack-dashboard` op DIT moment staat. Alleen bronnen die het HEDEN kennen tellen: een
 * expliciete `DASHBOARD_REPOSITORY` of de Actions-context.
 *
 * De afleiding staat hier BEWUST NIET nog een keer opgeschreven. Zij komt uit `resolveIdentity()`
 * in `scripts/lib/repo-identity.mjs` van de dashboardboom — dezelfde functie die de workflows
 * gebruiken, langs dezelfde weg als de twee feed-validators hieronder. Een tweede parser met
 * "ongeveer dezelfde" regels is precies hoe de twee stelsels uit elkaar lopen: die van hierboven
 * onderscheidde AFWEZIG niet van MISVORMD, zodat een tikfout in de override (`RVH-Speaking` zonder
 * repositorynaam) als "niets ingevuld" langskwam en de feed daarna zonder dashboardevents werd
 * gepubliceerd. `??` maakte het dubbel scheef: een lege `DASHBOARD_REPOSITORY` — de vorm waarin
 * Actions een niet-ingevulde `env:`-waarde doorgeeft — blokkeerde de terugval op een geldige
 * `GITHUB_REPOSITORY`, want leeg is niet `null`.
 *
 * Wat `resolveIdentity()` daarvoor in de plaats geeft:
 *  - MISVORMD en niet-leeg → werpt. Dat komt hier als een luide FOUT uit `main()` en er wordt niets
 *    gepubliceerd; een uitdrukkelijke aanwijzing die niet klopt, mag geen halve meting opleveren.
 *  - LEEG, alleen spaties, of AFWEZIG → geen override, en dan telt `GITHUB_REPOSITORY`.
 *  - Niets bruikbaars → `null`, en dan slaat deze bron over mét reden in het log.
 *
 * De `origin`-remote van de dashboard-werkboom telt niet mee, hoe verleidelijk ook — deze generator
 * draait juist lokaal onder launchd, waar die remote altijd voorhanden is. Maar hij bewaart wat er
 * bij het klonen is opgeschreven: GitHub verplaatst een repository server-side en blijft de oude
 * naam doorverwijzen, dus na de overdracht noemt `origin` nog de vorige eigenaar terwijl alles
 * blijft werken. Die stand hier vertrouwen levert git-events over een verhuisd object op zonder dat
 * er iets rood wordt.
 *
 * Onder launchd is er geen Actions-context. Het meegeleverde plist zet daarom zelf
 * `DASHBOARD_REPOSITORY`; zonder die sleutel slaat deze bron over en publiceert de generator een
 * feed zonder dashboardevents. Zie `README.md` hiernaast.
 */
export async function dashboardRepositorySlug(env = process.env) {
  const { resolveIdentity, repositorySlug } = await import(
    join(DASHBOARD_ROOT, 'scripts/lib/repo-identity.mjs')
  );
  const identiteit = resolveIdentity(env);
  return identiteit ? repositorySlug(identiteit) : null;
}
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

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function isoFromEpochSeconds(sec) {
  const d = new Date(sec * 1000);
  const iso = d.toISOString();
  if (!ISO_RE.test(iso)) throw new Error(`onbruikbaar epoch: ${sec}`);
  return iso;
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
    // Elke regel volledig geïsoleerd: een kapotte/onverwachte regel (verkeerd type, extreem
    // epoch, non-array package_outcomes) mag nooit de rest van het bestand meeslepen — alleen
    // die regel wordt overgeslagen, nooit gegokt.
    try {
      const rec = JSON.parse(line);
      if (typeof rec.at !== 'number' || !Number.isFinite(rec.at)) continue;
      const at = isoFromEpochSeconds(rec.at);
      events.push({
        at,
        source: 'dispatcher',
        kind: 'DISPATCHER_RUN',
        detail: clampDetail(
          `${rec.orders_seen ?? 0} orders gezien, ${rec.tasks_geseed ?? 0} geseed, ${rec.runs_gestart ?? 0} runs gestart`,
        ),
      });
      const outcomes = Array.isArray(rec.package_outcomes) ? rec.package_outcomes : [];
      for (const outcome of outcomes) {
        const kind = PACKAGE_OUTCOME_KIND[outcome?.action];
        if (!kind || typeof outcome?.file !== 'string' || !outcome.file) continue; // onbekend: nooit gokken
        events.push({
          at,
          source: 'queue',
          kind,
          detail: clampDetail(`${outcome.file} (${outcome.action})`),
        });
      }
    } catch {
      continue;
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
  // Detail is bewust STATISCH (geen live "Xs oud"): zo'n waarde verandert bij elke generatorrun
  // onafhankelijk van of er echt iets nieuws is, en ondermijnt daardoor de anti-commit-
  // vervuilingsbeveiliging net als de generatedAt-bug hierboven (zelfde grondoorzaak, een laag
  // dieper — Codex/Gemini-review PR#71). De echte tijd staat al in `at`.
  return [
    {
      at: hb.heartbeat,
      source: 'health',
      kind,
      detail: 'watchdog-heartbeat',
    },
  ];
}

// ---------------------------------------------------------------------------
// Bron 3: git-events (read-only) — gh pr list, geen titels/free-text, alleen repo#nummer
// ---------------------------------------------------------------------------
async function gitEvents() {
  const events = [];
  const dashboardSlug = await dashboardRepositorySlug();
  if (!dashboardSlug) {
    log(`kan niet vaststellen waar ${DASHBOARD_REPO} nu staat (geen DASHBOARD_REPOSITORY, geen `
      + 'GITHUB_REPOSITORY; de origin van de werkboom telt niet, die overleeft een overdracht '
      + 'ongewijzigd) — git-events voor die repo worden overgeslagen.');
  }
  const bronnen = [
    { repo: CONTROL_REPO, slug: `${CONTROL_OWNER}/${CONTROL_REPO}` },
    ...(dashboardSlug ? [{ repo: DASHBOARD_REPO, slug: dashboardSlug }] : []),
  ];
  for (const { repo, slug } of bronnen) {
    const r = gh([
      'pr', 'list', '--repo', slug, '--state', 'all', '--limit', '30',
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

const EXIT_CODE_RE = /^-?\d+$/;

/**
 * Zoekt het vaste key=value-kopblok van bin/dispatch-actor — en NERGENS anders. De vrije
 * '## Actoruitvoer'-body wordt eerst hard afgeknipt vóór er ook maar naar een fenced block
 * gezocht wordt, zodat een kapot/ontbrekend kopblok een ```text-fragment ín de body nooit per
 * ongeluk als kopblok kan laten doorgaan (Codex-bevinding PR#71).
 */
function parseReceiptHeader(text) {
  const bodyIdx = text.indexOf('\n## Actoruitvoer');
  const headerZone = bodyIdx === -1 ? text : text.slice(0, bodyIdx);
  const m = headerZone.match(/^# RECEIPT[^\n]*\n+```text\n([\s\S]*?)\n```\s*$/);
  if (!m) return null;
  const kv = {};
  for (const line of m[1].split('\n')) {
    const kvm = line.match(/^([A-Za-z_]+)=(.*)$/);
    if (kvm) kv[kvm[1]] = kvm[2];
  }
  if (!kv.actor || !ISO_RE.test(kv.started_at) || !ISO_RE.test(kv.ended_at)) return null;
  if (!EXIT_CODE_RE.test(kv.exit_code ?? '')) return null;
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
    const full = join(ROOT, 'outbox', f);
    try {
      // Symlinks nooit volgen: een *_RECEIPT.md-symlink zou anders buiten outbox/ kunnen lezen
      // (Codex-bevinding PR#71) — precies het soort ongewenst zij-effect dat condition 3 verbiedt.
      const st = await lstat(full);
      if (!st.isFile()) continue;
      const text = await readFile(full, 'utf8');
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
    } catch {
      continue; // één kapotte receipt mag de rest nooit meeslepen
    }
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
  const existing = ghApiGet(`repos/${CONTROL_OWNER}/${CONTROL_REPO}/git/ref/heads/${FEEDS_REF}`);
  if (existing.status === 200) return;
  const base = ghApiGet(`repos/${CONTROL_OWNER}/${CONTROL_REPO}/git/ref/heads/${BASE_REF}`);
  if (base.status !== 200) throw new Error(`kan basis-ref ${BASE_REF} niet lezen`);
  ghApiSend('POST', `repos/${CONTROL_OWNER}/${CONTROL_REPO}/git/refs`, {
    ref: `refs/heads/${FEEDS_REF}`,
    sha: base.json.object.sha,
  });
  log(`branch ${FEEDS_REF} aangemaakt vanaf ${BASE_REF}@${base.json.object.sha}`);
}

/**
 * Payload zonder `generatedAt` — die verandert bij elke run, dus een vergelijking die hem
 * meeneemt zou NOOIT gelijk zijn en publiceert dan bij elke run een loze commit (Gemini- én
 * Codex-bevinding PR#71). Commit-vervuiling wordt beoordeeld op de functionele inhoud, niet op
 * het generatiemoment.
 */
function functioneleInhoud(obj) {
  const { generatedAt, ...rest } = obj;
  return JSON.stringify(rest);
}

function publishFile(path, obj, label) {
  const contentText = `${JSON.stringify(obj, null, 2)}\n`;
  const contentB64 = Buffer.from(contentText, 'utf8').toString('base64');
  const existing = ghApiGet(
    `repos/${CONTROL_OWNER}/${CONTROL_REPO}/contents/${path}?ref=${FEEDS_REF}`,
  );
  if (existing.status === 200) {
    const currentText = Buffer.from(existing.json.content, 'base64').toString('utf8');
    let currentObj = null;
    try {
      currentObj = JSON.parse(currentText);
    } catch {
      currentObj = null; // onleesbare remote-inhoud: behandel als "anders", forceer een verse publicatie
    }
    if (currentObj && functioneleInhoud(currentObj) === functioneleInhoud(obj)) {
      log(`${label}: inhoud functioneel ongewijzigd, geen commit (geen commit-vervuiling).`);
      return { published: false };
    }
  }
  const body = {
    message: `feeds: ${label} bijgewerkt (dashboard-feed-generator)`,
    content: contentB64,
    branch: FEEDS_REF,
    ...(existing.status === 200 ? { sha: existing.json.sha } : {}),
  };
  const res = ghApiSend('PUT', `repos/${CONTROL_OWNER}/${CONTROL_REPO}/contents/${path}`, body);
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

/**
 * Alleen draaien als dit bestand ZELF is aangeroepen — zoals launchd het aanroept, met het pad als
 * `argv[1]`. Zonder deze poort start een `import` van deze module meteen een volledige run met
 * publicatie, en dan kan geen enkele toets de identiteitsroute hierboven meten zonder de echte
 * feeds aan te raken.
 *
 * De vergelijking loopt over `realpath`, want een LaunchAgent mag naar een symlink wijzen. Faalt
 * die (het pad bestaat niet meer), dan valt hij terug op de letterlijke vergelijking. Staat de
 * uitkomst onverhoopt op `false`, dan doet de generator niets en blijven de feeds staan waar ze
 * stonden — zichtbaar in het log en aan een oude `generatedAt`, en niet als een verkeerde publicatie.
 */
export function rechtstreeksAangeroepen() {
  const aanroep = process.argv[1];
  if (!aanroep) return false;
  const zelf = fileURLToPath(import.meta.url);
  try {
    return realpathSync(aanroep) === realpathSync(zelf);
  } catch {
    return resolve(aanroep) === zelf;
  }
}

if (rechtstreeksAangeroepen()) {
  main().catch((err) => {
    log(`FOUT: ${err.stack ?? err.message}`);
    process.exitCode = 1;
  });
}
