/**
 * RENDER — statische HTML uit een gesaneerde snapshot. Geen fetch, geen externe assets,
 * geen inline data die niet al door de sanitize-gate is gegaan. De pagina ververst zichzelf
 * via <meta http-equiv="refresh">; er draait geen JavaScript dat iets ophaalt.
 */

const AMBER = {
  GROEN: { dot: 'ok', label: 'groen' },
  ROOD: { dot: 'bad', label: 'rood' },
  GRIJS: { dot: 'warn', label: 'onbekend' },
  GEEN_CI: { dot: 'none', label: 'geen CI' },
};

const TRUST_LABEL = {
  VERIFIED_CURRENT: 'geverifieerd',
  STALE: 'verouderd',
  UNVERIFIED: 'ongeverifieerd',
  SOURCE_UNAVAILABLE: 'bron onbereikbaar',
  CONFLICTING_EVIDENCE: 'tegenstrijdig',
};

/** HTML-escape. Alles wat uit een bron komt gaat hier doorheen, zonder uitzondering. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const dt = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
};

const ago = (iso) => {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const d = Math.floor(ms / 86400000);
  if (d > 0) return `${d} d geleden`;
  const h = Math.floor(ms / 3600000);
  return h > 0 ? `${h} u geleden` : 'zojuist';
};

/** Bronbadge: elke sectie draagt zichtbaar hoe betrouwbaar hij is. */
function badge(ev) {
  if (!ev) return '';
  const cls = ev.trust === 'VERIFIED_CURRENT' ? 'ok' : ev.trust === 'SOURCE_UNAVAILABLE' ? 'bad' : 'warn';
  return `<span class="badge ${cls}" title="${esc(ev.source)} · ${esc(dt(ev.retrievedAt))}">${esc(TRUST_LABEL[ev.trust] ?? ev.trust)}</span>`;
}

function unavailable(ev) {
  return `<p class="empty">Geen data. <strong>${esc(TRUST_LABEL[ev?.trust] ?? 'bron onbereikbaar')}</strong>${
    ev?.error ? ` — ${esc(ev.error)}` : ''}<br><span class="muted">Een onbereikbare bron toont hier nooit een oude groene stand.</span></p>`;
}

function section(id, title, ev, body) {
  return `<section id="${esc(id)}" class="card">
  <h2>${esc(title)} ${badge(ev)}</h2>
  ${body}
</section>`;
}

function pullRequests(pr) {
  if (!pr?.available) return section('prs', 'Open pull requests', pr?.evidence, unavailable(pr?.evidence));
  const rows = pr.repositories.map((r) => `<tr>
      <td>${esc(r.repository)}</td><td class="num">${r.open}</td>
      <td class="num">${r.ready}</td><td class="num muted">${r.draft}</td></tr>`).join('\n');
  return section('prs', 'Open pull requests', pr.evidence, `
  <p class="lead"><strong>${pr.totals.open}</strong> open over <strong>${pr.repositories.length}</strong> repo's · ${pr.totals.ready} klaar · ${pr.totals.draft} draft</p>
  <div class="scroll"><table>
    <thead><tr><th>Repo</th><th class="num">open</th><th class="num">klaar</th><th class="num">draft</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`);
}

function merged(m) {
  if (!m?.available) return section('merged', 'Gemerged', m?.evidence, unavailable(m?.evidence));
  const rows = m.byRepository.slice(0, 12)
    .map((r) => `<tr><td>${esc(r.repository)}</td><td class="num">${r.merged}</td></tr>`).join('\n');
  return section('merged', `Gemerged (${m.windowDays} dagen)`, m.evidence, `
  <p class="lead"><strong>${m.count}</strong> pull requests gemerged</p>
  <div class="scroll"><table><thead><tr><th>Repo</th><th class="num">merges</th></tr></thead><tbody>${rows}</tbody></table></div>`);
}

function tracker(t) {
  if (!t?.available) return section('tracker', 'Tracker', t?.evidence, unavailable(t?.evidence));
  const updates = t.updates.map((u) => `<li><span class="tag">${u.number}</span> ${esc(u.title)} <span class="muted">${esc(u.date)}</span></li>`).join('\n');
  const points = t.decisionPoints.length
    ? `<ul class="chips">${t.decisionPoints.map((d) => `<li><span class="tag warn">${esc(d.id)}</span> ${esc(d.title)}</li>`).join('')}</ul>`
    : '<p class="empty">Geen open beslispunten in de tracker.</p>';
  return section('tracker', 'Tracker — laatste updates', t.evidence, `
  <ul class="list">${updates}</ul>
  <h3>Beslispunten</h3>${points}`);
}

function decisions(d) {
  if (!d?.available) return section('decisions', 'Besluiten', d?.evidence, unavailable(d?.evidence));
  const rows = d.entries.map((e) => `<tr><td class="nowrap">${esc(e.id)}</td><td class="nowrap muted">${esc(e.date)}</td><td>${esc(e.decision)}</td></tr>`).join('\n');
  return section('decisions', 'Besluitenregister', d.evidence,
    `<div class="scroll"><table><thead><tr><th>ID</th><th>datum</th><th>besluit</th></tr></thead><tbody>${rows}</tbody></table></div>`);
}

function fleet(f) {
  if (!f?.available) return section('fleet', 'Vloot', f?.evidence, unavailable(f?.evidence));
  const rows = f.tracks.map((t) => `<tr>
      <td>${esc(t.track)}</td>
      <td class="nowrap">${esc(dt(t.lastChangeAt))}</td>
      <td class="muted nowrap">${esc(ago(t.lastChangeAt))}</td></tr>`).join('\n');
  return section('fleet', 'Vloot — laatste wijziging per track', f.evidence, `
  <p class="lead muted">Commitdatum van het queue-bestand; in CI bestaat geen lokale mtime.</p>
  <div class="scroll"><table><thead><tr><th>Track</th><th>laatst gewijzigd</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`);
}

function logbook(l) {
  if (!l?.available) return section('logbook', 'Journaal', l?.evidence, unavailable(l?.evidence));
  return section('logbook', 'Journaal — laatste entries', l.evidence,
    `<ul class="list">${l.entries.map((e) => `<li>${esc(e.title)}</li>`).join('')}</ul>`);
}

function ci(c) {
  if (!c?.available) return section('ci', 'CI-ampels', c?.evidence, unavailable(c?.evidence));
  const items = c.lights.map((l) => {
    const a = AMBER[l.state] ?? AMBER.GRIJS;
    return `<li><span class="dot ${a.dot}"></span><span class="repo">${esc(l.repository)}</span>
      <span class="muted">${esc(a.label)}${l.at ? ` · ${esc(ago(l.at))}` : ''}</span></li>`;
  }).join('\n');
  return section('ci', 'CI-ampels', c.evidence, `<ul class="lights">${items}</ul>`);
}

function workstreams(ws) {
  if (!ws?.length) return '';
  const rows = ws.map((w) => `<tr>
      <td class="nowrap">${esc(w.id)}</td><td>${esc(w.title)}</td><td class="nowrap muted">${esc(w.estimate ?? '')}</td></tr>`).join('\n');
  return `<section id="roadmap" class="card">
  <h2>Roadmap — 19 workstreams <span class="badge warn">handmatig vastgelegd</span></h2>
  <p class="lead muted">Overgenomen uit het roadmap-overzicht. Deze sectie vervangt de losse handmatige refreshes.</p>
  <div class="scroll"><table><thead><tr><th>WS</th><th>Workstream</th><th>raming</th></tr></thead><tbody>${rows}</tbody></table></div>
</section>`;
}

const STYLE = `
:root{--bg:#0f1115;--card:#171a21;--line:#252a34;--fg:#e6e8ec;--mut:#9aa3b2;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--acc:#58a6ff}
@media (prefers-color-scheme:light){:root{--bg:#f6f7f9;--card:#fff;--line:#e3e6ea;--fg:#1c2027;--mut:#5c6470;--acc:#0969da}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:28px 20px 64px}
header{display:flex;flex-wrap:wrap;gap:10px 20px;align-items:baseline;justify-content:space-between;margin-bottom:8px}
h1{font-size:22px;margin:0;letter-spacing:-.01em}
h2{font-size:15px;margin:0 0 12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
h3{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:18px 0 8px}
.stamp{color:var(--mut);font-size:13px}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));margin-top:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px}
.card.wide{grid-column:1/-1}
.lead{margin:0 0 12px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-weight:600;color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.05em;padding:0 8px 6px 0;border-bottom:1px solid var(--line)}
td{padding:6px 8px 6px 0;border-bottom:1px solid var(--line)}
tr:last-child td{border-bottom:0}
.num{text-align:right;font-variant-numeric:tabular-nums;width:1%;white-space:nowrap}
.nowrap{white-space:nowrap}
.muted{color:var(--mut)}
.scroll{overflow-x:auto}
.list{margin:0;padding:0;list-style:none}
.list li{padding:5px 0;border-bottom:1px solid var(--line)}
.list li:last-child{border-bottom:0}
.chips{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
.tag{display:inline-block;min-width:22px;text-align:center;background:var(--line);border-radius:5px;padding:1px 6px;font-size:12px;font-variant-numeric:tabular-nums}
.tag.warn{background:color-mix(in srgb,var(--warn) 22%,transparent);color:var(--warn)}
.badge{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:2px 7px;border-radius:20px;border:1px solid currentColor}
.badge.ok{color:var(--ok)}.badge.warn{color:var(--warn)}.badge.bad{color:var(--bad)}
.empty{color:var(--mut);margin:0}
.lights{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
.lights li{display:flex;align-items:center;gap:9px}
.repo{flex:0 1 auto}
.dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;background:var(--mut)}
.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}.dot.none{background:var(--line);border:1px solid var(--mut)}
footer{margin-top:28px;color:var(--mut);font-size:12.5px;border-top:1px solid var(--line);padding-top:14px}
a{color:var(--acc)}
`;

/** Bouw de volledige pagina. `snapshot` moet al door assertPublishable zijn gegaan. */
export function renderHtml(snapshot, { refreshSeconds = 900 } = {}) {
  const s = snapshot;
  const stale = s.sources.filter((x) => x.trust !== 'VERIFIED_CURRENT');

  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${refreshSeconds}">
<meta name="robots" content="noindex,nofollow">
<title>Stack-dashboard — ${esc(s.generatedAt.slice(0, 16).replace('T', ' '))} UTC</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>Stack-dashboard</h1>
  <p class="stamp">Laatst bijgewerkt: <strong>${esc(dt(s.generatedAt))}</strong> · ververst automatisch elke ${Math.round(refreshSeconds / 60)} min</p>
</header>
<p class="muted">Weergave van bestaande canon — nooit een tweede waarheid. Alles is read-only en gesaneerd;
${stale.length === 0 ? 'alle bronnen zijn geverifieerd.' : `<strong>${stale.length}</strong> van ${s.sources.length} bronnen is niet geverifieerd (zie de badges).`}</p>

<div class="grid">
  ${pullRequests(s.pullRequests)}
  ${ci(s.ci)}
  ${tracker(s.tracker)}
  ${decisions(s.decisions)}
  ${fleet(s.fleet)}
  ${merged(s.merged)}
  ${logbook(s.logbook)}
</div>

${workstreams(s.workstreams)}

<footer>
  Gegenereerd door <code>stack-dashboard</code> (contract ${esc(s.contractVersion)}) uit publieke en
  gecureerde bronnen op GitHub. Deze pagina toont geen secretnamen, tokens, klantdata of lokale paden:
  elke build passeert een sanitize-gate die fail-closed is. Bij een onbereikbare bron staat er
  <em>bron onbereikbaar</em> — geen gecachte groene stand.
</footer>
</div>
</body>
</html>
`;
}
