/** Rustige cockpit en drill-downs; pure renderers op reeds gesaneerde modellen. */
import { esc, num, buildStamp, titelStamp, STYLE, TRUST_LABEL } from './render.mjs';

const page = (s, title, body, nav, refreshSeconds = 900) => {
  const refresh = Math.min(3600, Math.max(60, Math.trunc(Number(refreshSeconds)) || 900));
  const bust = String(s.generatedAt).replace(/[^0-9]/g, '') || '0';
  return `<!doctype html>
<html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${refresh}; url=./?v=${bust}"><meta name="robots" content="noindex,nofollow">
<meta http-equiv="content-security-policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
<title>${esc(title)} — ${esc(titelStamp(s.generatedAt))}</title><style>${STYLE}
.product-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:1rem}.product{display:block;text-decoration:none;color:inherit}.metric{font-size:1.6rem;font-weight:700}.unknown{color:#936b00}.feature{margin:1rem 0;padding-top:1rem;border-top:1px solid #ddd}.feature dl{display:grid;grid-template-columns:minmax(8rem,12rem) 1fr;gap:.35rem 1rem}.feature dt{color:#667}.feature dd{margin:0}.ticker{list-style:none;padding:0}.ticker li{padding:.8rem 0;border-bottom:1px solid #ddd}.topnav a{margin-right:1rem}
</style></head><body><div class="wrap"><nav class="topnav">${nav}</nav><header><h1>${esc(title)}</h1><p class="stamp">Laatst bijgewerkt: <strong>${esc(buildStamp(s.generatedAt))}</strong></p></header>
<main>${body}</main><footer>Statische, read-only weergave van gevalideerde bronnen. UNKNOWN is geen nulstand.</footer></div></body></html>`;
};

const list = (items, empty) => items.length ? `<ul class="lights">${items.join('')}</ul>` : `<p class="empty">${esc(empty)}</p>`;
const featureName = (f) => `<span class="repo">${esc(f.label)}</span>`;

export function renderCockpit(snapshot, { products, ticker, refreshSeconds = 900 } = {}) {
  const waiting = snapshot.planning?.available ? snapshot.planning.features.filter((f) => f.status === 'wacht-op-Richard') : [];
  const active = snapshot.planning?.available ? snapshot.planning.features.filter((f) => ['in-bouw', 'in-review'].includes(f.status)) : [];
  const today = String(snapshot.generatedAt).slice(0, 10);
  const delivered = snapshot.planning?.available ? snapshot.planning.features.filter((f) => f.status === 'live' && f.oplevering?.date === today) : [];
  const incidents = (snapshot.sources ?? []).filter((x) => x.trust !== 'VERIFIED_CURRENT');
  const productCards = (products?.products ?? []).map((p) => `<a class="card product" href="./producten.html#${esc(p.id)}"><h3>${esc(p.name)}</h3><span class="metric">${p.known ? `${num(p.known)}/${num(p.denominator)} bekend` : 'UNKNOWN'}</span><p class="muted">${num(p.denominator)} canonieke features</p></a>`);
  const events = (ticker?.events ?? []).slice(0, 5).map((e) => `<li><span class="tag">${esc(e.lifecycle)}</span> <span class="repo">${esc(e.product)}</span> <span class="muted">${esc(e.at)}</span></li>`);
  const body = `<section id="wacht-op-richard" class="card"><h2>Wacht op Richard</h2>${snapshot.planning?.available ? list(waiting.map((f) => `<li>${featureName(f)}</li>`), 'Geen gevalideerde wachtende items.') : '<p class="unknown">UNKNOWN — planningbron niet beschikbaar.</p>'}</section>
<section id="nu-actief" class="card"><h2>Nu actief</h2>${snapshot.planning?.available ? list(active.map((f) => `<li>${featureName(f)} <span class="muted">${esc(f.status)}</span></li>`), 'Geen gevalideerde actieve items.') : '<p class="unknown">UNKNOWN — planningbron niet beschikbaar.</p>'}</section>
<section id="vandaag-geleverd" class="card"><h2>Vandaag geleverd</h2>${snapshot.planning?.available ? list(delivered.map((f) => `<li>${featureName(f)}</li>`), 'Niets met een gevalideerde opleverdatum van vandaag.') : '<p class="unknown">UNKNOWN — planningbron niet beschikbaar.</p>'}</section>
<section id="producten" class="card wide"><h2>Producten</h2><div class="product-grid">${productCards.join('')}</div></section>
<section id="incidenten" class="card"><h2>Incidenten</h2>${list(incidents.map((x) => `<li><span class="repo">${esc(x.key)}</span> <span class="unknown">${esc(TRUST_LABEL[x.trust] ?? x.trust)}</span></li>`), 'Geen gevalideerde bronincidenten.')}</section>
<section id="accountcapaciteit" class="card"><h2>Accountcapaciteit</h2><p class="unknown">UNKNOWN — geen canonieke capaciteitsbron aangesloten.</p></section>
<section id="laatste-ticker-events" class="card wide"><h2>Laatste ticker-events</h2><p class="muted">${ticker?.freshness === 'CURRENT' ? 'Actuele statische snapshot' : `${esc(ticker?.freshness ?? 'UNKNOWN')} — events kunnen vertraagd zijn`}. GitHub-data is niet realtime.</p>${list(events, 'Geen gevalideerde lifecycle-events.')}</section>`;
  return page(snapshot, 'Richards cockpit', body, '<a href="./producten.html">Producten</a><a href="./stack-ticker.html">STACK-TICKER</a><a href="./contentstroom.html">Technische drill-down</a>', refreshSeconds);
}

const value = (v) => v === null || v === undefined ? '<span class="unknown">UNKNOWN</span>' : esc(v);
export function renderProducts(snapshot, model, { refreshSeconds = 900 } = {}) {
  const products = model.products.map((p) => `<section id="${esc(p.id)}" class="card wide"><h2>${esc(p.name)}</h2><p class="muted">Canonieke noemer: ${num(p.denominator)} features${p.known === p.denominator ? ` · geleverd ${num(Math.round(p.delivered / p.denominator * 100))}%` : ' · percentage ingehouden zolang fasen UNKNOWN zijn'}</p>${p.features.map((f) => `<article class="feature"><h3>${esc(f.name)}</h3><dl><dt>Fase</dt><dd>${esc(f.phase.replaceAll('_', ' ').toLowerCase())}</dd><dt>Echt af</dt><dd>${value(f.done)}</dd><dt>Nu</dt><dd>${value(f.now)}</dd><dt>Volgende mijlpaal</dt><dd>${value(f.next)}</dd><dt>Blocker</dt><dd>${value(f.blocker)}</dd><dt>Freshness</dt><dd>${esc(f.freshness)}</dd><dt>Evidence</dt><dd>${esc(f.evidence)}</dd></dl></article>`).join('')}</section>`).join('');
  return page(snapshot, 'Producten en features', products, '<a href="./">Cockpit</a><a href="./stack-ticker.html">STACK-TICKER</a>', refreshSeconds);
}

export function renderTicker(snapshot, ticker, { refreshSeconds = 900 } = {}) {
  const rows = ticker.events.map((e) => `<li><span class="tag">${esc(e.lifecycle)}</span> <strong>${esc(e.product)}</strong><br><span>${esc(e.summary)}</span><br><span class="muted">${esc(e.at)} · gevalideerde statische snapshot</span></li>`);
  const body = `<section class="card wide"><h2>Lifecycle-events</h2><p class="${ticker.freshness === 'CURRENT' ? 'muted' : 'unknown'}">Freshness: ${esc(ticker.freshness)}. Statische GitHub-bron; nooit realtime. STALE betekent dat het nieuwste event ouder is dan 24 uur.</p><ol class="ticker">${rows.join('')}</ol></section>`;
  return page(snapshot, 'STACK-TICKER', body, '<a href="./">Cockpit</a><a href="./producten.html">Producten</a>', refreshSeconds);
}
