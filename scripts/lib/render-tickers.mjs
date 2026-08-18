/**
 * RENDER-TICKERS — de twee ticker-pagina's uit de TRANSACTIE-TICKER/CODE-TICKER-claim.
 *
 * Zelfde discipline als render.mjs: statische HTML, geen fetch, geen client-JS, zelf-refresh via
 * <meta http-equiv="refresh">. Beide pagina's tonen een reeds geschema-valideerde en (voor
 * CODE-TICKER) structuur-only feed — hier gebeurt geen sanering, alleen weergave.
 *
 * CODE-TICKER is bewust structuur-only (Richard-akkoord 18-08-2026): geen ruwe commando's,
 * promptregels of outputregels — alleen gesloten-vocabulaire velden. Zie
 * `scripts/lib/code-ticker-feed.mjs` voor de motivatie.
 */

import { esc, num } from './format.mjs';
import { STYLE, klokTijden } from './render.mjs';

/**
 * Zelfde ritme-regel als de order: de klok telt als ROOD zodra ze ouder is dan 3× de bottleneck-
 * cadans. Die bottleneck is niet het lokale generator-ritme maar de publicatiecadans van de site
 * zelf (~15 min, `REFRESH_SECONDS`) — vandaar `STALE_DREMPEL_MS = 45 min` in de feed-adapters.
 */
export const KLOK_ROOD_FACTOR = 3;

const klokTijdMetSeconden = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return `${p.hour}:${p.minute}:${p.second}`;
};

const gemetenOmStamp = (iso) => {
  const k = klokTijden(iso);
  return k ? `gemeten om ${k.nl} NL-tijd (${k.utc} UTC)` : '—';
};

/** Nieuwste boven; een onleesbare tijdstempel zakt naar onderaan i.p.v. de sortering te breken. */
function sorteerNieuwsteBoven(items) {
  const tijd = (x) => {
    const t = Date.parse(x?.at);
    return Number.isFinite(t) ? t : -Infinity;
  };
  return items.slice().sort((a, b) => tijd(b) - tijd(a));
}

function klokBadge(freshness) {
  if (freshness === 'STALE') return '<span class="badge bad">klok verouderd</span>';
  if (freshness === 'UNKNOWN') return '<span class="badge warn">klok onbekend</span>';
  return '<span class="badge ok">klok actueel</span>';
}

function paginaSchil({ title, stampLabel, refreshSeconds, pagePath, generatedAt, robotsMeta = true, body }) {
  const refresh = Math.min(3600, Math.max(60, Math.trunc(Number(refreshSeconds)) || 60));
  // Zelfde cache-buster-tuchtregel als render.mjs: alleen cijfers uit generatedAt, nooit de
  // weergavetekst — en de refresh wijst naar de EIGEN pagina, niet naar de cockpit (`./`).
  const cacheBust = String(generatedAt ?? '').replace(/[^0-9]/g, '') || '0';
  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${refresh}; url=${pagePath}?v=${cacheBust}">
${robotsMeta ? '<meta name="robots" content="noindex,nofollow">' : ''}
<meta http-equiv="content-security-policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
<title>${esc(title)}</title>
<style>${STYLE}
.ticker{margin:0;padding:0;list-style:none;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
.ticker li{display:flex;gap:10px;padding:5px 0;border-bottom:1px solid var(--line);align-items:baseline}
.ticker li:last-child{border-bottom:0}
.ticker .t{color:var(--mut);flex:0 0 auto;white-space:nowrap}
.ticker .src{flex:0 0 auto;white-space:nowrap}
.ticker .kind{flex:0 0 auto;white-space:nowrap}
.ticker .detail{flex:1 1 auto;overflow-wrap:anywhere}
.term{background:#0a0c10;border-radius:8px;padding:2px 4px}
.term .ticker li{border-bottom:1px solid #1c2029}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>${esc(title)}</h1>
  <p class="stamp">${esc(stampLabel)}</p>
</header>
${body}
<footer>
  Gegenereerd door een lokale generator op Stack-Director, gepubliceerd via stack-control en
  hierin opgenomen bij de eigen bouwcadans van deze site (~15 min). Read-only weergave — deze
  pagina bestuurt niets. Bij een verouderde klok (&gt;${num(KLOK_ROOD_FACTOR)}× die cadans, 45 min)
  staat de klokbadge op rood.
</footer>
</div>
</body>
</html>
`;
}

/**
 * PAGINA 1 — TRANSACTIE-TICKER. Event-feed van dispatcher-runs, taak-transities, health-metingen
 * en git-events. `detail` komt al machinaal-gesloten uit de generator (schema-gevalideerd).
 */
const TRANSACTIE_SOURCE_LABEL = { dispatcher: 'dispatcher', queue: 'queue', health: 'health', git: 'git' };
const TRANSACTIE_KIND_LABEL = {
  DISPATCHER_RUN: 'dispatcher-run',
  TASK_ALREADY_INGESTED: 'taak al binnengehaald',
  TASK_INGESTED_READY: 'taak binnengehaald → klaar',
  TASK_INGRESS_BLOCKED: 'taak-inname geblokkeerd',
  HEALTH_OK: 'health OK',
  HEALTH_STALE: 'health verouderd',
  GIT_PR_OPENED: 'PR geopend',
  GIT_PR_MERGED: 'PR gemerged',
};

export function renderTransactieTicker(feed, { refreshSeconds = 900 } = {}) {
  if (!feed?.available) {
    return paginaSchil({
      title: 'Transactie-ticker',
      stampLabel: 'Geen feed beschikbaar — de generator heeft nog niets bruikbaars gepubliceerd.',
      refreshSeconds,
      pagePath: './transacties.html',
      generatedAt: null,
      body: '<section class="card"><p class="empty">Geen data.</p></section>',
    });
  }
  const events = sorteerNieuwsteBoven(feed.events);
  const rows = events.map((e) => `<li>
      <span class="t">${esc(klokTijdMetSeconden(e.at) ?? '—')}</span>
      <span class="src tag">${esc(TRANSACTIE_SOURCE_LABEL[e.source] ?? e.source)}</span>
      <span class="kind">${esc(TRANSACTIE_KIND_LABEL[e.kind] ?? e.kind)}</span>
      <span class="detail muted">${esc(e.detail)}</span></li>`).join('\n');
  return paginaSchil({
    title: 'Transactie-ticker',
    stampLabel: `${gemetenOmStamp(feed.generatedAt)} — ${events.length ? `${num(events.length)} events` : 'geen events'}`,
    refreshSeconds,
    pagePath: './transacties.html',
    generatedAt: feed.generatedAt,
    body: `<section class="card wide">
  <p>${klokBadge(feed.freshness)}</p>
  ${events.length
      ? `<ul class="ticker">${rows}</ul>`
      : '<p class="empty">Geen events in deze publicatie.</p>'}
</section>`,
  });
}

/**
 * PAGINA 2 — CODE-TICKER. Structuur-only (Richard-akkoord 18-08-2026): lane, actietype,
 * resultaat/exitcode, eventueel een streng-gevormd order-ID. Bewust GEEN vrije tekst, commando's
 * of outputregels — die wachten op een apart mensenreview-traject.
 */
const CODE_ACTION_LABEL = {
  DISPATCH_START: 'dispatch start',
  DISPATCH_END: 'dispatch einde',
  HEALTH_CHECK: 'health-check',
};
const CODE_RESULT_LABEL = {
  STARTED: 'gestart', OK: 'OK', FAIL: 'FAIL', STALE: 'verouderd', UNKNOWN: 'onbekend',
};
const CODE_RESULT_CLASS = { STARTED: '', OK: 'ok', FAIL: 'bad', STALE: 'warn', UNKNOWN: 'warn' };

export function renderCodeTicker(feed, { refreshSeconds = 900 } = {}) {
  if (!feed?.available) {
    return paginaSchil({
      title: 'Code-ticker',
      stampLabel: 'Geen feed beschikbaar — de generator heeft nog niets bruikbaars gepubliceerd.',
      refreshSeconds,
      pagePath: './code-ticker.html',
      generatedAt: null,
      body: '<section class="card"><p class="empty">Geen data.</p></section>',
    });
  }
  const entries = sorteerNieuwsteBoven(feed.entries);
  const rows = entries.map((e) => {
    const cls = CODE_RESULT_CLASS[e.result] ?? '';
    const extra = [];
    if (Number.isInteger(e.exitCode)) extra.push(`rc=${num(e.exitCode)}`);
    if (e.orderId) extra.push(esc(e.orderId));
    return `<li>
      <span class="t">${esc(klokTijdMetSeconden(e.at) ?? '—')}</span>
      <span class="src tag">${esc(e.lane)}</span>
      <span class="kind">${esc(CODE_ACTION_LABEL[e.action] ?? e.action)}</span>
      <span class="detail${cls ? ` ${cls}` : ''}">${esc(CODE_RESULT_LABEL[e.result] ?? e.result)}${
      extra.length ? ` <span class="muted">· ${extra.join(' · ')}</span>` : ''}</span></li>`;
  }).join('\n');
  return paginaSchil({
    title: 'Code-ticker',
    stampLabel: `${gemetenOmStamp(feed.generatedAt)} — ${entries.length ? `${num(entries.length)} regels` : 'geen regels'}`,
    refreshSeconds,
    pagePath: './code-ticker.html',
    generatedAt: feed.generatedAt,
    body: `<section class="card wide term">
  <p>${klokBadge(feed.freshness)}</p>
  <p class="muted">Structuur-only: lane, actie en resultaat. Geen ruwe commando's, promptregels of
  outputregels — die wachten op een apart mensenreview-traject.</p>
  ${entries.length
      ? `<ul class="ticker">${rows}</ul>`
      : '<p class="empty">Geen regels in deze publicatie.</p>'}
</section>`,
  });
}
