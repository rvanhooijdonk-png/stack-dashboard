/** Rustige cockpit en drill-downs; pure renderers op reeds gesaneerde modellen. */
import { esc, num, buildStamp, titelStamp, STYLE, TRUST_LABEL, VLOOT_KLEUR } from './render.mjs';
import { ALARM_KOP } from './waarnemer.mjs';

const PAGE_PATHS = new Set(['./', './producten.html', './stack-ticker.html']);
const SOURCE_NAMES = {
  pullRequests: 'open pull requests', merged: 'gemerged', tracker: 'tracker', decisions: 'besluitenregister',
  tracks: 'tracks', logbook: 'journaal', ci: 'CI-ampels', afspraken: 'afsprakenspoor',
};

const page = (s, title, body, nav, refreshSeconds = 900, pagePath = './') => {
  const refresh = Math.min(3600, Math.max(60, Math.trunc(Number(refreshSeconds)) || 900));
  const bust = String(s.generatedAt).replace(/[^0-9]/g, '') || '0';
  const refreshPath = PAGE_PATHS.has(pagePath) ? pagePath : './';
  return `<!doctype html>
<html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${refresh}; url=${refreshPath}?v=${bust}"><meta name="robots" content="noindex,nofollow">
<meta http-equiv="content-security-policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
<title>${esc(title)} — ${esc(titelStamp(s.generatedAt))}</title><style>${STYLE}
.product-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(16rem,100%),1fr));gap:1rem}.product{display:block;text-decoration:none;color:inherit}.metric{font-size:1.35rem;font-weight:700}.unknown{color:#936b00}.feature{margin:1rem 0;padding-top:1rem;border-top:1px solid #ddd}.feature dl{display:grid;grid-template-columns:minmax(8rem,12rem) minmax(0,1fr);gap:.35rem 1rem}.feature dt{color:#667}.feature dd{margin:0;overflow-wrap:anywhere}.ticker{list-style:none;padding:0}.ticker li{padding:.8rem 0;border-bottom:1px solid #ddd;overflow-wrap:anywhere}.topnav{display:flex;flex-wrap:wrap;gap:.5rem 1rem;margin-bottom:1rem}.topnav a{min-height:2.75rem;display:inline-flex;align-items:center}.evidence-warning{border-left:.25rem solid #936b00;padding-left:.75rem}
@media (max-width:42rem){.wrap{padding:.75rem}.feature dl{grid-template-columns:1fr;gap:.1rem}.feature dd{margin:0 0 .65rem}.product-grid{grid-template-columns:1fr}.topnav a{flex:1 1 9rem}.owner-gates li,.ticker-summary li,.capacity-list li{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:start}.owner-gates li .repo,.capacity-list li .repo{grid-column:2}.owner-gates li .muted,.ticker-summary li .muted,.capacity-list li .muted{grid-column:2}.incident-list li{display:grid;grid-template-columns:minmax(7rem,auto) minmax(0,1fr);align-items:start}}
</style></head><body><div class="wrap"><nav class="topnav" aria-label="Hoofdnavigatie">${nav}</nav><header><h1>${esc(title)}</h1><p class="stamp">Laatst bijgewerkt: <strong>${esc(buildStamp(s.generatedAt))}</strong></p></header>
<main>${body}</main><footer>Statische, read-only weergave van gevalideerde bronnen. UNKNOWN is geen nulstand.</footer></div></body></html>`;
};

const list = (items, empty) => items.length ? `<ul class="lights">${items.join('')}</ul>` : `<p class="empty">${esc(empty)}</p>`;
const featureName = (f) => `<span class="repo">${esc(f.label)}</span>`;
const normalized = (value) => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const SELF_REPORT_PREFIX = ALARM_KOP.replace(/\*/g, '').trim();
const isSelfReport = (row) => normalized(row?.tab) === 'waarnemer'
  && String(row?.onderwerp ?? '').replace(/^[\s*]+/, '').startsWith(SELF_REPORT_PREFIX);

/**
 * WACHT OP RICHARD — alleen expliciete ownerhandelingen op zijn poort, uit drie gesloten bronnen:
 * mergebare pull requests, planningfeatures op wacht-op-Richard, en kanaalpost-rijen die hem als
 * actiehouder noemen minus de waarnemer-zelfmeldingen over de plaat zelf (die zijn ruis, geen
 * gate). Een bron die niet leesbaar was telt niet als "geen gates" — die krijgt een eigen
 * UNKNOWN-regel, want ontbrekende meting is geen nulstand.
 *
 * De planningpoort gaat op de STATUS, niet op het workerveld: `wacht-op-Richard` betekent per
 * contract al "wacht op Richard" en het contract garandeert geen consistente `worker`-waarde bij
 * die status. Filteren op `worker === 'richard'` erbovenop liet een geldige maar inconsistente
 * feature (worker null/'review'/…) stil verdwijnen — fail-open op precies de gate die nooit mag
 * ontbreken (bevinding Codex, 2026-08-11). `worker` wordt nu getoond, niet gebruikt om te filteren.
 */
export function ownerGates(snapshot) {
  const unavailable = [];
  const gates = [];
  if (snapshot?.pullRequests?.available === true) {
    const ready = snapshot.pullRequests.totals?.ready;
    if (Number.isInteger(ready) && ready > 0) gates.push({
      identity: 'pull-requests:non-draft',
      label: `${ready} open pull request(s) zonder draft-status`,
      detail: 'merge is de ownerpoort; mergebaarheid en checks zijn hier niet gemeten',
    });
  } else unavailable.push('Mergepoorten UNKNOWN — pull-requestbron niet leesbaar.');

  if (snapshot?.planning?.available === true) {
    for (const feature of snapshot.planning.features ?? []) {
      const dependency = typeof feature?.afhankelijkheid === 'string' ? feature.afhankelijkheid.trim() : '';
      if (feature?.status === 'wacht-op-Richard') {
        const worker = feature.worker ? `worker ${feature.worker}` : 'worker UNKNOWN';
        gates.push({
          identity: `planning:${normalized(feature.label)}`,
          label: feature.label,
          detail: `${dependency || 'geen afhankelijkheid geregistreerd'} · ${worker}`,
        });
      }
    }
  } else unavailable.push('Planning-ownerpoorten UNKNOWN — planningbron niet leesbaar.');

  if (snapshot?.kanaalpost?.available === true) {
    for (const row of snapshot.kanaalpost.rows ?? []) {
      const isOwner = /\brichard\b/i.test(String(row?.actie ?? ''));
      if (isOwner && row?.status === 'WACHT OP AKKOORD' && !isSelfReport(row)) {
        gates.push({
          identity: `kanaalpost:${normalized(row.datum)}|${normalized(row.tab)}|${normalized(row.onderwerp)}|${normalized(row.actie)}`,
          label: row.onderwerp || 'Ownerbesluit zonder publiek onderwerp',
          detail: row.tab ? `bronrol ${row.tab}` : 'kanaalpost',
        });
      }
    }
  } else unavailable.push('Kanaalpost-ownerpoorten UNKNOWN — spiegel niet leesbaar.');

  const seen = new Set();
  return { unavailable, gates: gates.filter((gate) => !seen.has(gate.identity) && seen.add(gate.identity)) };
}

function renderOwnerGates(snapshot) {
  const result = ownerGates(snapshot);
  const warnings = result.unavailable.map((message) => `<li><span class="dot bad"></span><span class="repo">${esc(message)}</span><span class="muted">geen meting — geen nulstand</span></li>`);
  const gates = result.gates.map((gate) => `<li><span class="dot warn"></span><span class="repo">${esc(gate.label)}</span><span class="muted">${esc(gate.detail)}</span></li>`);
  const body = warnings.length || gates.length
    ? `<ul class="lights owner-gates">${[...warnings, ...gates].join('')}</ul>`
    : '<p class="empty">Alle drie de ownerbronnen zijn gelezen; er staat geen gevalideerde ownerpoort open.</p>';
  return `<section id="wacht-op-richard" class="card wide"><h2>Wacht op Richard <span class="badge warn">${num(gates.length)}</span>${warnings.length ? ` <span class="badge bad">${num(warnings.length)} bron${warnings.length === 1 ? '' : 'nen'} UNKNOWN</span>` : ''}</h2>${body}</section>`;
}

// Zelfde 24-uursgrens als product-model.mjs's freshness(): een planningspiegel ouder dan een dag
// (of zonder spiegelAt) is STALE/UNKNOWN, ook als de feature zelf nog 'in-bouw' zegt.
function planningFreshness(snapshot) {
  if (!snapshot?.planning?.available || !snapshot.planning.bron?.spiegelAt) return 'UNKNOWN';
  const age = Date.parse(snapshot.generatedAt) - Date.parse(snapshot.planning.bron.spiegelAt);
  return Number.isFinite(age) && age >= 0 && age <= 24 * 60 * 60 * 1000 ? 'CURRENT' : 'STALE';
}

/**
 * NU ACTIEF — het contract (`planning.features[]`) kent geen actor-, starttijd- of
 * heartbeatveld; dat kan alleen met een schema-versiebump en een nieuwe upstream bron (open
 * vraag, zie de opleverreceipt). Zolang die er niet is tonen we wél wat wél bekend is — taak,
 * status, workerrol — en merken actor/starttijd/heartbeat elk apart als UNKNOWN. Dat is de
 * bestaande systeemsemantiek (UNKNOWN is geen nulstand): een hele sectie permanent leeg laten
 * omdat drie velden structureel ontbreken zou een taak die wél volgens de planning loopt
 * onzichtbaar maken.
 *
 * `freshness` gaat mee: zonder die vlag presenteerde een verouderde planningspiegel zich hier
 * altijd als een groene, actuele "nu actief"-melding — precies de stille schijn-actualiteit die
 * de rest van het systeem elders al blokkeert (bevinding Codex, 2026-08-11).
 */
export function activeWork(snapshot) {
  if (snapshot?.planning?.available !== true) return { available: false, active: [], freshness: 'UNKNOWN' };
  const active = (snapshot.planning.features ?? []).filter((f) => ['in-bouw', 'in-review'].includes(f?.status));
  return { available: true, active, freshness: planningFreshness(snapshot) };
}

function renderActive(snapshot) {
  const state = activeWork(snapshot);
  if (!state.available) {
    return '<section id="nu-actief" class="card"><h2>Nu actief</h2><p class="unknown">UNKNOWN — planningbron niet beschikbaar.</p></section>';
  }
  const dot = state.freshness === 'CURRENT' ? 'ok' : state.freshness === 'STALE' ? 'warn' : 'bad';
  const staleNote = state.freshness !== 'CURRENT' ? ` <span class="unknown">planning ${esc(state.freshness)} — status kan achterlopen</span>` : '';
  const items = state.active.map((f) => `<li><span class="dot ${dot}"></span>${featureName(f)} <span class="muted">${esc(f.status)}${f.worker ? ` · rol ${esc(f.worker)}` : ''}</span>${staleNote} <span class="unknown">actor UNKNOWN · starttijd UNKNOWN · heartbeat UNKNOWN</span></li>`);
  const noot = state.active.length
    ? '<p class="muted">Actor, starttijd en heartbeat staan niet in het huidige contract — dit toont uitsluitend de planningstatus.</p>'
    : '';
  return `<section id="nu-actief" class="card"><h2>Nu actief</h2>${list(items, 'Geen feature met planningstatus in-bouw of in-review.')}${noot}</section>`;
}

function incidentFacts(snapshot) {
  const facts = (snapshot.sources ?? []).filter((x) => x.trust !== 'VERIFIED_CURRENT').map((x) => ({
    identity: `source:${x.key}`, label: SOURCE_NAMES[x.key] ?? x.key, detail: TRUST_LABEL[x.trust] ?? x.trust,
  }));
  const unknownLanes = (snapshot.vlootstand?.available ? snapshot.vlootstand.vensters ?? [] : [])
    .filter((lane) => lane.toestand === 'ONBEKEND').length;
  if (unknownLanes > 0) facts.push({
    identity: 'fleet:unknown', label: `${unknownLanes} vlootlane${unknownLanes === 1 ? '' : 's'}`,
    detail: 'stand UNKNOWN; details op technische drill-down',
  });
  for (const light of snapshot.ci?.available ? snapshot.ci.lights ?? [] : []) {
    if (light.state === 'ROOD') facts.push({ identity: `ci:${light.repository}`, label: light.repository, detail: 'CI rood' });
  }
  const seen = new Set();
  return facts.filter((fact) => !seen.has(fact.identity) && seen.add(fact.identity));
}

/**
 * ACCOUNTCAPACITEIT — de vlootstand (WERKT/LEEG/ONBEKEND per venster) is al beschikbaar op
 * `snapshot.vlootstand` maar stond hier tot dusver hardcoded op UNKNOWN, terwijl de bron er wel
 * was. Elk venster krijgt zijn eigen regel; stilte wordt hier nooit stilzwijgend groen (zelfde
 * grensMinuten-regel als de Contentstroom-vlootstandtabel). `generatedAt` is het meettijdstip:
 * dit is een snapshot-systeem, geen losse per-account polling.
 */
function accountCapaciteit(snapshot) {
  const v = snapshot.vlootstand;
  if (!v?.available) {
    return `<section id="accountcapaciteit" class="card"><h2>Accountcapaciteit</h2><p class="unknown">UNKNOWN — vlootstandbron niet beschikbaar of leeg bij deze build.</p></section>`;
  }
  const items = v.vensters.map((r) => `<li><span class="dot ${VLOOT_KLEUR[r.toestand] ?? 'bad'}"></span><span class="repo">${esc(r.venster)}</span><span class="muted">${esc(r.toestand)}${r.laatste ? ` · laatst gemeld ${esc(r.laatste)}` : ' · nooit gemeld'}</span></li>`);
  return `<section id="accountcapaciteit" class="card"><h2>Accountcapaciteit <span class="badge">${num(v.telling.werkt)} werkt · ${num(v.telling.leeg)} leeg · ${num(v.telling.onbekend)} onbekend</span></h2>
  <p class="muted">Gemeten op ${esc(buildStamp(snapshot.generatedAt))} · een venster stiller dan ${num(v.grensMinuten)} min geldt als ONBEKEND, nooit als groen.</p>
  <ul class="lights capacity-list">${items.join('')}</ul></section>`;
}

export function renderCockpit(snapshot, { products, ticker, refreshSeconds = 900 } = {}) {
  const today = String(snapshot.generatedAt).slice(0, 10);
  const delivered = snapshot.planning?.available ? snapshot.planning.features.filter((f) => f.status === 'live' && f.oplevering?.date === today) : [];
  const incidents = incidentFacts(snapshot);
  const productCards = (products?.products ?? []).map((p) => `<a class="card product" href="./producten.html#${esc(p.id)}"><h3>${esc(p.name)}</h3><span class="metric">${num(p.known)}/${num(p.denominator)} bekend</span><p class="muted">${num(p.denominator)} canonieke features</p></a>`);
  const events = (ticker?.events ?? []).slice(0, 5).map((e) => `<li><span class="tag">${esc(e.lifecycle)}</span> <span class="repo">${esc(e.product)}</span> <span class="muted">${esc(e.at)}</span></li>`);
  const body = `${renderOwnerGates(snapshot)}
${renderActive(snapshot)}
<section id="vandaag-geleverd" class="card"><h2>Vandaag geleverd</h2>${snapshot.planning?.available ? list(delivered.map((f) => `<li>${featureName(f)}</li>`), 'Niets met een gevalideerde opleverdatum van vandaag.') : '<p class="unknown">UNKNOWN — planningbron niet beschikbaar.</p>'}</section>
<section id="producten" class="card wide"><h2>Producten</h2><div class="product-grid">${productCards.join('')}</div></section>
<section id="incidenten" class="card"><h2>Incidenten</h2>${incidents.length ? `<ul class="lights incident-list">${incidents.map((x) => `<li><span class="repo">${esc(x.label)}</span> <span class="unknown">${esc(x.detail)}</span></li>`).join('')}</ul>` : '<p class="empty">Geen gevalideerde bron-, vloot- of CI-incidenten.</p>'}</section>
${accountCapaciteit(snapshot)}
<section id="laatste-ticker-events" class="card wide"><h2>Laatste ticker-events</h2><p class="muted">${ticker?.freshness === 'CURRENT' ? 'Actuele statische snapshot' : `${esc(ticker?.freshness ?? 'UNKNOWN')} — events kunnen vertraagd zijn`}. GitHub-data is niet realtime.</p>${list(events, 'Geen gevalideerde lifecycle-events.')}</section>`;
  return page(snapshot, 'Richards cockpit', body, '<a href="./producten.html">Producten</a><a href="./stack-ticker.html">STACK-TICKER</a><a href="./contentstroom.html">Technische drill-down</a>', refreshSeconds, './');
}

const value = (v) => v === null || v === undefined ? '<span class="unknown">UNKNOWN</span>' : esc(v);
export function renderProducts(snapshot, model, { refreshSeconds = 900 } = {}) {
  const products = model.products.map((p) => {
    const percentage = p.known === p.denominator && p.denominator > 0
      ? `geleverd ${num(Math.round(p.delivered / p.denominator * 100))}%`
      : 'PERCENTAGE_ONBEKEND — niet elke fase heeft bewijs';
    return `<section id="${esc(p.id)}" class="card wide"><h2>${esc(p.name)}</h2><p class="muted">Canonieke noemer: ${num(p.denominator)} features · ${esc(percentage)}</p>${p.features.map((f) => `<article class="feature"><h3>${esc(f.name)}</h3><dl><dt>Fase</dt><dd>${esc(f.phase.replaceAll('_', ' ').toLowerCase())}</dd><dt>Echt af</dt><dd>${value(f.done)}</dd><dt>Nu</dt><dd>${value(f.now)}</dd><dt>Volgende mijlpaal</dt><dd>${value(f.next)}</dd><dt>Blocker</dt><dd>${value(f.blocker)}</dd><dt>Freshness</dt><dd>${esc(f.freshness)}</dd><dt>Evidence</dt><dd>${esc(f.evidence)}</dd></dl></article>`).join('')}</section>`;
  }).join('');
  return page(snapshot, 'Producten en features', products, '<a href="./">Cockpit</a><a href="./stack-ticker.html">STACK-TICKER</a><a href="./contentstroom.html">Technische drill-down</a>', refreshSeconds, './producten.html');
}

export function renderTicker(snapshot, ticker, { refreshSeconds = 900 } = {}) {
  const rows = ticker.events.map((e) => `<li><span class="tag">${esc(e.lifecycle)}</span> <strong>${esc(e.product)}</strong><br><span>${esc(e.summary)}</span><br><span class="muted">${esc(e.at)} · gevalideerde statische snapshot</span></li>`);
  const timeline = rows.length ? `<ol class="ticker">${rows.join('')}</ol>` : '<p class="empty">Geen gevalideerde lifecycle-events; de tijdlijn is UNKNOWN.</p>';
  const body = `<section class="card wide"><h2>Lifecycle-events</h2><p class="${ticker.freshness === 'CURRENT' ? 'muted' : 'unknown'}">Freshness: ${esc(ticker.freshness)}. Statische GitHub-bron; nooit realtime. STALE betekent dat het nieuwste event ouder is dan 24 uur.</p>${timeline}</section>`;
  return page(snapshot, 'STACK-TICKER', body, '<a href="./">Cockpit</a><a href="./producten.html">Producten</a><a href="./contentstroom.html">Technische drill-down</a>', refreshSeconds, './stack-ticker.html');
}
