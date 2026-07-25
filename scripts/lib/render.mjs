/**
 * RENDER — statische HTML uit een gesaneerde snapshot. Geen fetch, geen externe assets,
 * geen inline data die niet al door de sanitize-gate is gegaan. De pagina ververst zichzelf
 * via <meta http-equiv="refresh">; er draait geen JavaScript dat iets ophaalt.
 */

const AMBER = {
  GROEN: { dot: 'ok', label: 'groen' },
  ROOD: { dot: 'bad', label: 'rood' },
  GRIJS: { dot: 'warn', label: 'afgebroken of overgeslagen' },
  GEEN_CI: { dot: 'none', label: 'geen CI' },
  ONBEKEND: { dot: 'warn', label: 'niet op te halen' },
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

/**
 * Getallen worden als getal geïnterpoleerd, niet als string. Een "aantal" dat stiekem een
 * string met HTML erin is, werd anders rauw in de pagina gezet — review Codex, bewezen probe.
 */
export function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.trunc(n)) : '—';
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
  // Geen bronnaam in de tooltip: het pad naar een privé-bestand is zelf een aanwijzing.
  return `<span class="badge ${cls}" title="opgehaald ${esc(dt(ev.retrievedAt))}">${esc(TRUST_LABEL[ev.trust] ?? ev.trust)}</span>`;
}

/**
 * Vaste publieke teksten bij een gesloten codelijst. De vorige versie rendeerde de fouttekst van
 * de collector zelf; een uitzondering met een intern pad of een klantnaam kwam daarmee zo op de
 * pagina (bewezen probe, vierde review). Wat hier staat is door een mens geschreven, niet door
 * een runtime.
 */
const ERROR_TEXT = {
  BRON_ONBEREIKBAAR: 'de bron kon niet worden opgehaald',
  NIET_GEVERIFIEERD: 'de bron leverde niets bruikbaars op',
  VEROUDERD: 'de bron is al geruime tijd niet gewijzigd',
  TEGENSTRIJDIG: 'de bronnen spreken elkaar tegen',
  ONBEKEND: 'onbekende toestand',
};

function unavailable(ev) {
  const uitleg = ev?.errorCode ? ` — ${esc(ERROR_TEXT[ev.errorCode] ?? ERROR_TEXT.ONBEKEND)}` : '';
  return `<p class="empty">Geen data. <strong>${esc(TRUST_LABEL[ev?.trust] ?? 'bron onbereikbaar')}</strong>${
    uitleg}<br><span class="muted">Een onbereikbare bron toont hier nooit een oude groene stand.</span></p>`;
}

/**
 * OVERZICHT-PLAAT — rollup.
 *
 * Puur afgeleid uit dezelfde snapshot die de secties hieronder voeden; geen extra bron, geen
 * extra fetch. De enige echte regel hier is fail-closed: een tak waarvan de bron ontbreekt of
 * onbereikbaar is levert `available: false` met `null`-tellingen op. Niet 0 — nul leest als
 * "niets aan de hand", en dat is precies wat we in dat geval niet weten.
 */
export const VERS_DAGEN = 7;
const ROOD_NAMEN_MAX = 3;

/**
 * Alleen deze twee trust-waarden dragen een bruikbaar cijfer. `UNVERIFIED` betekent hier iets
 * heel concreets: de collector zet die vlag óók bij een telling van nul (`trustFor`) en bij een
 * datum in de toekomst (`ageTrust`) — precies de gevallen waarin een kaal "0" of "vers" als
 * geruststelling zou worden gelezen terwijl er niets bewezen is. De plaat mag die nuance niet
 * wegpoetsen; review Codex 24-07-2026, bevestigd in collect.mjs.
 */
const BRUIKBARE_TRUST = new Set(['VERIFIED_CURRENT', 'STALE']);
const bruikbaar = (sectie) => Boolean(sectie?.available) && BRUIKBARE_TRUST.has(sectie?.evidence?.trust);

/**
 * Trust-waarden die een sectie hoe dan ook onbruikbaar maken, óók als `available` true is —
 * een schema-geldige maar tegenstrijdige combinatie. Voor CI gebruiken we deze zwarte lijst in
 * plaats van de witte lijst hierboven: `UNVERIFIED` moet daar juist wél door (de collector zet
 * dat al zodra één ampel onbekend is), maar een onbereikbare bron nooit (her-pass Codex).
 */
const ONBRUIKBARE_TRUST = new Set(['SOURCE_UNAVAILABLE', 'CONFLICTING_EVIDENCE']);

// Eén referentietijdstip per rollup: anders schuift de klok tijdens het sorteren en is de
// comparator formeel non-deterministisch (review Gemini).
const leeftijdDagen = (iso, nu) => {
  if (!iso) return null;
  const ms = nu - new Date(iso).getTime();
  return Number.isFinite(ms) ? ms / 86400000 : null;
};

function ciRollup(c) {
  // Bewust géén sectie-brede trust-poort: de collector zet CI op UNVERIFIED zodra één ampel
  // ONBEKEND is (collect.mjs, `unknown ? 'UNVERIFIED'`). Die poort zou dus precies het geval
  // {ROOD, ONBEKEND} volledig wegdrukken tot "onbekend" — beide signalen kwijt, terwijl juist
  // die stand het hardst gezien moet worden. De toets zit daarom per ampel (her-pass Codex).
  if (!c?.available || ONBRUIKBARE_TRUST.has(c?.evidence?.trust) || !Array.isArray(c.lights)) {
    return { available: false, groen: null, rood: null, onbekend: null, totaal: null, verborgen: null, roodRepos: null };
  }
  const tel = (st) => c.lights.filter((l) => l?.state === st);
  const rood = tel('ROOD');
  // Verborgen repo's tellen mee in de noemer: hun ampel staat niet op deze pagina, dus "1/1 groen"
  // terwijl er twee verzwegen zijn is een te mooie voorstelling (review Codex).
  const verborgen = Number.isFinite(Number(c.hiddenCiRepositories)) ? Math.trunc(Number(c.hiddenCiRepositories)) : 0;
  return {
    available: true,
    groen: tel('GROEN').length,
    rood: rood.length,
    onbekend: tel('ONBEKEND').length,
    totaal: c.lights.length + verborgen,
    verborgen,
    // Tot en met drie bij naam: anders is het cijfer een raadsel dat je moet gaan zoeken.
    // Daarboven zou de plaat een muur van namen worden en verliest hij zijn functie.
    roodRepos: rood.length > 0 && rood.length <= ROOD_NAMEN_MAX ? rood.map((l) => l.repository) : null,
  };
}

function tracksRollup(tr, nu) {
  if (!tr?.available || !Array.isArray(tr.tracks)) {
    return { available: false, vers: null, verouderd: null, zonder: null, totaal: null, koudste: null };
  }
  // Let op: hier bewust géén sectie-brede trust-poort. De collector zet de tracks-sectie al op
  // UNVERIFIED zodra één track geen rapport heeft — dat is juist de stand die deze plaat moet
  // tónen, niet verbergen. De trust-toets zit daarom per track.
  const lijst = tr.tracks;
  const bruikbaarRapport = (t) => BRUIKBARE_TRUST.has(t?.trust) && leeftijdDagen(t?.lastReportAt, nu) !== null;
  const met = lijst.filter(bruikbaarRapport);
  // Geen rapport, een onleesbare datum én een niet te vertrouwen datum vallen samen: er is geen
  // bruikbaar bewijs van werk. Een toekomstdatum (kapotte klok) mag nooit als "vers" tellen.
  const zonder = lijst.filter((t) => !bruikbaarRapport(t));
  const koudsteMet = met
    .slice()
    .sort((a, b) => leeftijdDagen(b.lastReportAt, nu) - leeftijdDagen(a.lastReportAt, nu))[0] ?? null;
  return {
    available: true,
    vers: met.filter((t) => leeftijdDagen(t.lastReportAt, nu) < VERS_DAGEN).length,
    verouderd: met.filter((t) => leeftijdDagen(t.lastReportAt, nu) >= VERS_DAGEN).length,
    zonder: zonder.length,
    totaal: lijst.length,
    // Een track zonder bruikbaar rapport is kouder dan welke leeftijd ook — die wint altijd.
    koudste: zonder[0] ?? koudsteMet,
  };
}

export function rollup(snapshot, nu = Date.now()) {
  const s = snapshot ?? {};
  const pr = s.pullRequests;
  const tk = s.tracker;
  return {
    ci: ciRollup(s.ci),
    tracks: tracksRollup(s.tracks, nu),
    // num(null) rendert als "0" (Number(null) === 0), dus een ontbrekend totaal zou alsnog een
    // gezaghebbende nul worden. Alleen een écht eindig getal telt (her-pass Codex).
    // Strikt op type: Number(null), Number('') en Number(false) zijn allemaal 0, dus een
    // coercie-controle laat een lege of ontbrekende waarde alsnog als nul door. En een telling
    // is een geheel getal dat niet negatief kan zijn — het contract zegt alleen "integer", dus
    // een -1 uit een kapotte bron zou hier anders als echte stand op de plaat komen (her-pass Codex).
    prs: bruikbaar(pr) && Number.isInteger(pr.totals?.open) && pr.totals.open >= 0
      ? { available: true, open: pr.totals.open }
      : { available: false, open: null },
    beslispunten: bruikbaar(tk) && Array.isArray(tk.decisionPoints)
      ? { available: true, open: tk.decisionPoints.length }
      : { available: false, open: null },
  };
}

const ONBEKEND_WAARDE = '<span class="unknown">onbekend</span>';
const ONBEKEND_DETAIL = '<span class="muted">bron niet beschikbaar — geen stand af te leiden</span>';

/** Eén tegel. `waarde` en `detail` zijn al-geëscapete fragmenten, nooit rauwe brontekst. */
function stat(label, waarde, detail, cls) {
  return `<li class="stat${cls ? ` ${cls}` : ''}">
    <span class="stat-label">${esc(label)}</span>
    <span class="stat-value">${waarde}</span>
    <span class="stat-detail">${detail}</span>
  </li>`;
}

/** Een koude hoek zonder bruikbaar rapport is rood; verder telt de echte leeftijd. */
function koudsteKlasse(k) {
  const d = BRUIKBARE_TRUST.has(k?.trust) ? leeftijdDagen(k?.lastReportAt, Date.now()) : null;
  if (d === null) return 'bad';
  return d >= VERS_DAGEN ? 'warn' : 'ok';
}

function koudsteDetail(k) {
  if (!BRUIKBARE_TRUST.has(k?.trust) || !k?.lastReportAt) {
    return '<span class="rood">geen bruikbaar klaar-rapport</span>';
  }
  return `<span class="muted">laatste rapport ${esc(ago(k.lastReportAt))}</span>`;
}

function overzicht(s) {
  const r = rollup(s);

  // Rood én onbekend naast elkaar tonen: bij {ROOD, ONBEKEND} verdween de onbereikbare repo
  // eerder volledig uit beeld (review Codex). Alles wat de stand vertroebelt hoort zichtbaar.
  const ciDelen = [];
  if (r.ci.available) {
    if (r.ci.rood > 0) {
      ciDelen.push(r.ci.roodRepos
        ? `<span class="rood">rood: ${r.ci.roodRepos.map((x) => esc(x)).join(', ')}</span>`
        : `<span class="rood">${num(r.ci.rood)} repo's rood</span>`);
    }
    if (r.ci.onbekend > 0) ciDelen.push(`<span class="unknown">${num(r.ci.onbekend)} niet op te halen</span>`);
    if (r.ci.verborgen > 0) ciDelen.push(`<span class="muted">${num(r.ci.verborgen)} niet bij naam getoond</span>`);
    if (ciDelen.length === 0) ciDelen.push('<span class="muted">geen rood</span>');
  }
  // `ok` alleen als élke gevolgde repo daadwerkelijk groen is. Grijs, "geen CI" en verzwegen
  // repo's zijn geen bewijs van "alles in orde" — hooguit afwezigheid van bewijs (review Codex).
  const ciKlasse = r.ci.rood > 0 ? 'bad'
    : r.ci.onbekend > 0 ? 'warn'
      : (r.ci.totaal > 0 && r.ci.groen === r.ci.totaal ? 'ok' : '');

  const ciTegel = r.ci.available
    ? stat('CI-ampels', `${num(r.ci.groen)}/${num(r.ci.totaal)} groen`, ciDelen.join(' · '), ciKlasse)
    : stat('CI-ampels', ONBEKEND_WAARDE, ONBEKEND_DETAIL);

  const trackTegel = r.tracks.available
    ? stat('Tracks', `${num(r.tracks.vers)}/${num(r.tracks.totaal)} vers`,
      `<span class="muted">${num(r.tracks.verouderd)} verouderd · ${num(r.tracks.zonder)} zonder bruikbaar rapport</span>`,
      // Een lege tracklijst is geen prestatie: "0/0 vers" in het groen zou een gezonde stand
      // suggereren waar simpelweg niets gevolgd wordt (her-pass Codex).
      r.tracks.totaal === 0 ? '' : (r.tracks.zonder > 0 || r.tracks.verouderd > 0 ? 'warn' : 'ok'))
    : stat('Tracks', ONBEKEND_WAARDE, ONBEKEND_DETAIL);

  // De koudste hoek draagt de NAAM, niet alleen een cijfer: anders moet je gaan zoeken welke
  // hoek koud is (aanscherping Richard, 24-07-2026).
  const koudsteTegel = !r.tracks.available
    ? stat('Koudste hoek', ONBEKEND_WAARDE, ONBEKEND_DETAIL)
    : (r.tracks.koudste
      ? stat('Koudste hoek', esc(r.tracks.koudste.track),
        koudsteDetail(r.tracks.koudste),
        // Op werkelijke leeftijd, niet op "heeft een rapport": als de koudste hoek zelf nog vers
        // is, is er niets te waarschuwen en zou oranje alert-moeheid kweken (review Gemini).
        koudsteKlasse(r.tracks.koudste))
      : stat('Koudste hoek', '<span class="muted">—</span>', '<span class="muted">geen tracks gevolgd</span>'));

  const prTegel = r.prs.available
    ? stat('Open PR\'s', num(r.prs.open), '<span class="muted">over alle gevolgde repo\'s</span>')
    : stat('Open PR\'s', ONBEKEND_WAARDE, ONBEKEND_DETAIL);

  const bpTegel = r.beslispunten.available
    ? stat('Open beslispunten', num(r.beslispunten.open), '<span class="muted">wachten op een besluit</span>')
    : stat('Open beslispunten', ONBEKEND_WAARDE, ONBEKEND_DETAIL);

  return `<section id="overzicht" class="card plaat">
  <h2>Overzicht</h2>
  <p class="lead muted">Samenvatting van de secties hieronder, afgeleid uit dezelfde build — geen aparte bron.
  <em>Vers</em> betekent hier: een klaar-rapport jonger dan ${num(VERS_DAGEN)} dagen. Voor de ouderdom van
  deze weergave geldt de stempel bovenaan; een tak zonder bruikbare bron staat op <em>onbekend</em> en
  wordt nooit als in orde geteld.</p>
  <ul class="stats">${ciTegel}${trackTegel}${koudsteTegel}${prTegel}${bpTegel}</ul>
</section>`;
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
      <td>${esc(r.repository)}</td><td class="num">${num(r.open)}</td>
      <td class="num">${num(r.ready)}</td><td class="num muted">${num(r.draft)}</td></tr>`).join('\n');
  const hidden = pr.hiddenRepositories
    ? `<p class="lead muted">${num(pr.hiddenRepositories)} PR's staan in repo's die niet bij naam getoond worden; die zijn samengevoegd tot “overige repo's”.</p>`
    : '';
  return section('prs', 'Open pull requests', pr.evidence, `
  <p class="lead"><strong>${num(pr.totals.open)}</strong> open · ${num(pr.totals.ready)} klaar · ${num(pr.totals.draft)} draft</p>
  ${hidden}
  <div class="scroll"><table>
    <thead><tr><th>Repo</th><th class="num">open</th><th class="num">klaar</th><th class="num">draft</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`);
}

function merged(m) {
  if (!m?.available) return section('merged', 'Gemerged', m?.evidence, unavailable(m?.evidence));
  const rows = m.byRepository.slice(0, 12)
    .map((r) => `<tr><td>${esc(r.repository)}</td><td class="num">${num(r.merged)}</td></tr>`).join('\n');
  return section('merged', `Gemerged (${num(m.windowDays)} dagen)`, m.evidence, `
  <p class="lead"><strong>${num(m.count)}</strong> pull requests gemerged</p>
  <div class="scroll"><table><thead><tr><th>Repo</th><th class="num">merges</th></tr></thead><tbody>${rows}</tbody></table></div>`);
}

/**
 * Vrije tekst uit de canon staat hier standaard niet. Wat je ziet is de structuur: nummers,
 * ID's, datums, aantallen. De tekst zelf is bedrijfsinhoud en die hoort niet op een openbare
 * pagina — zie `data/publish-text.json`.
 */
const WITHHELD = '<p class="lead muted">Titels worden hier niet getoond: dit is een openbare pagina en de brontekst is intern. Wat blijft staan is de structuur — nummers, ID\'s, datums en aantallen.</p>';

/** Toon een titel, of een streepje als de tekst is ingehouden. */
const txt = (value) => (value == null ? '<span class="muted">—</span>' : esc(value));

/**
 * Afgeleid categorielabel als chip. Dit is géén brontekst maar een gesloten-lijst-classificatie
 * (categoriseer() in collect.mjs). Het label mag daarom mee, ook als de titel is ingehouden —
 * het zegt "waar dit besluit over gaat" zonder de inhoud prijs te geven.
 */
const catChip = (c) => `<span class="tag cat">${esc(c)}</span>`;

function tracker(t) {
  if (!t?.available) return section('tracker', 'Tracker', t?.evidence, unavailable(t?.evidence));
  const updates = t.updates.map((u) => `<li><span class="tag">${num(u.number)}</span> ${txt(u.title)} <span class="muted">${esc(u.date)}</span></li>`).join('\n');
  const points = t.decisionPoints.length
    ? `<ul class="chips">${t.decisionPoints.map((d) => `<li><span class="tag warn">${esc(d.id)}</span> ${catChip(d.category)} ${txt(d.title)}</li>`).join('')}</ul>`
    : '<p class="empty">Geen open beslispunten in de tracker.</p>';
  return section('tracker', 'Tracker — laatste updates', t.evidence, `
  ${t.updatesTextWithheld ? WITHHELD : ''}
  <ul class="list">${updates}</ul>
  <h3>Beslispunten (${num(t.decisionPoints.length)})</h3>
  ${t.decisionPointsTextWithheld ? WITHHELD : ''}${points}`);
}

function decisions(d) {
  if (!d?.available) return section('decisions', 'Besluiten', d?.evidence, unavailable(d?.evidence));
  const rows = d.entries.map((e) => `<tr><td class="nowrap">${esc(e.id)}</td><td class="nowrap muted">${esc(e.date)}</td><td class="nowrap">${catChip(e.category)}</td><td>${txt(e.decision)}</td></tr>`).join('\n');
  return section('decisions', 'Besluitenregister', d.evidence,
    `${d.textWithheld ? WITHHELD : ''}
  <div class="scroll"><table><thead><tr><th>ID</th><th>datum</th><th>categorie</th><th>besluit</th></tr></thead><tbody>${rows}</tbody></table></div>`);
}

function tracks(tr) {
  if (!tr?.available) return section('tracks', 'Tracks', tr?.evidence, unavailable(tr?.evidence));
  const rows = tr.tracks.map((t) => `<tr>
      <td>${esc(t.track)}</td>
      <td class="num">${num(t.reportCount)}</td>
      <td class="nowrap">${t.lastReportAt ? esc(dt(t.lastReportAt)) : '<span class="muted">—</span>'}</td>
      <td class="muted nowrap">${t.lastReportAt ? esc(ago(t.lastReportAt)) : 'geen rapport'}</td></tr>`).join('\n');
  return section('tracks', 'Tracks — leeftijd laatste klaar-rapport', tr.evidence, `
  <p class="lead muted">Per track de datum van het meest recente klaar-rapport (CONTROL/RAPPORTEN). Geen bestandsnaam — die kan een project- of klantnaam dragen. Een track zonder rapport is geen groen: er is geen bewijs van werk.</p>
  <div class="scroll"><table><thead><tr><th>Track</th><th class="num">rapporten</th><th>laatste</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`);
}

function logbook(l) {
  if (!l?.available) return section('logbook', 'Journaal', l?.evidence, unavailable(l?.evidence));
  const body = l.textWithheld
    ? `<p class="lead"><strong>${num(l.entries.length)}</strong> entries in het journaal.</p>${WITHHELD}`
    : `<ul class="list">${l.entries.map((e) => `<li>${txt(e.title)}</li>`).join('')}</ul>`;
  return section('logbook', 'Journaal — laatste entries', l.evidence, body);
}

function ci(c) {
  if (!c?.available) return section('ci', 'CI-ampels', c?.evidence, unavailable(c?.evidence));
  const items = c.lights.map((l) => {
    const a = AMBER[l.state] ?? AMBER.GRIJS;
    return `<li><span class="dot ${a.dot}"></span><span class="repo">${esc(l.repository)}</span>
      <span class="muted">${esc(a.label)}${l.at ? ` · ${esc(ago(l.at))}` : ''}</span></li>`;
  }).join('\n');
  const hidden = c.hiddenCiRepositories
    ? `<p class="lead muted">${num(c.hiddenCiRepositories)} repo(s) worden niet bij naam getoond.</p>`
    : '';
  return section('ci', 'CI-ampels', c.evidence, `${hidden}<ul class="lights">${items}</ul>`);
}

function workstreams(ws) {
  if (!ws?.length) return '';
  const rows = ws.map((w) => `<tr>
      <td class="nowrap">${esc(w.id)}</td><td>${txt(w.title)}</td><td class="nowrap muted">${txt(w.estimate)}</td></tr>`).join('\n');
  const withheld = ws.filter((w) => w.title == null).length;
  return `<section id="roadmap" class="card">
  <h2>Roadmap — 19 workstreams <span class="badge warn">handmatig vastgelegd</span></h2>
  <p class="lead muted">Overgenomen uit het roadmap-overzicht. Deze sectie vervangt de losse handmatige refreshes.${
  withheld ? ` <strong>${num(withheld)}</strong> workstream(s) zijn niet vrijgegeven voor publicatie en tonen alleen hun nummer.` : ''}</p>
  <div class="scroll"><table><thead><tr><th>WS</th><th>Workstream</th><th>raming</th></tr></thead><tbody>${rows}</tbody></table></div>
</section>`;
}

/**
 * PLANNING-PLAAT — de bouwlijst. Kop-band (af-sinds-gisteren · draait-nu · wacht-op-Richard),
 * daaronder per feature de naam, status, de op het THROUGHPUT-LOG herrekende oplevering en de
 * afhankelijkheid, en tot slot de laatste tien kanaalpost-rijen. Fail-closed: een lege of afgekeurde
 * bouwlijst toont hier een nette melding, nooit een lege of kapotte pagina.
 */
const PLANNING_STATUS_KLASSE = {
  gepland: '',
  'in-bouw': 'ok',
  'in-review': 'warn',
  'wacht-op-Richard': 'warn',
  live: 'ok',
};

const PLANNING_REDEN = {
  LEEG: 'Er is nog geen bouwlijst geleverd. Zodra TRECHTER de machine-leesbare bouwlijst plaatst, verschijnt hier de planning.',
  CORRUPT: 'De geleverde bouwlijst kon niet veilig worden gelezen en wordt daarom niet getoond — liever een lege plaat dan een onbetrouwbare.',
};

/** De oplevering als tekst — eerlijk over wat gemeten is en wat niet. */
function opleveringTekst(o) {
  if (!o) return '<span class="muted">—</span>';
  if (o.kind === 'opgeleverd') return o.date ? `opgeleverd · ${esc(o.date)}` : 'opgeleverd';
  if (o.kind === 'verwacht' && o.date) return `verwacht ${esc(o.date)}`;
  return `${ONBEKEND_WAARDE}`;
}

function planning(p) {
  if (!p?.available) {
    const reden = PLANNING_REDEN[p?.reason] ?? PLANNING_REDEN.LEEG;
    return `<section id="planning" class="card plaat">
  <h2>Planning-plaat</h2>
  <p class="empty">${esc(reden)}</p>
</section>`;
  }
  const c = p.counters ?? { afSindsGisteren: 0, draaitNu: 0, wachtOpRichard: 0 };
  const band = [
    stat('Af sinds gisteren', num(c.afSindsGisteren), '<span class="muted">live gegaan sinds gisteren</span>',
      c.afSindsGisteren > 0 ? 'ok' : ''),
    stat('Draait nu', num(c.draaitNu), '<span class="muted">features in aanbouw</span>',
      c.draaitNu > 0 ? 'ok' : ''),
    stat('Wacht op Richard', num(c.wachtOpRichard), '<span class="muted">features die op een akkoord staan</span>',
      c.wachtOpRichard > 0 ? 'warn' : ''),
  ].join('');

  const rows = p.features.map((f) => `<tr>
      <td>${esc(f.label)}</td>
      <td class="nowrap"><span class="tag ${PLANNING_STATUS_KLASSE[f.status] ?? ''}">${esc(f.status)}</span></td>
      <td class="nowrap muted">${f.worker ? esc(f.worker) : '<span class="muted">—</span>'}</td>
      <td class="nowrap">${opleveringTekst(f.oplevering)}</td>
      <td>${f.afhankelijkheid ? esc(f.afhankelijkheid) : '<span class="muted">—</span>'}</td></tr>`).join('\n');

  const kanaalRows = p.kanaalpost.length
    ? p.kanaalpost.map((k) => `<tr>
      <td class="nowrap muted">${k.datum ? esc(k.datum) : '—'}</td>
      <td class="nowrap"><span class="tag">${k.doelchat ? esc(k.doelchat) : '—'}</span></td>
      <td>${k.onderwerp ? esc(k.onderwerp) : '<span class="muted">—</span>'}</td>
      <td class="nowrap muted">${k.status ? esc(k.status) : '—'}</td></tr>`).join('\n')
    : '';

  return `<section id="planning" class="card plaat">
  <h2>Planning-plaat</h2>
  <p class="lead muted">De bouwlijst: wat gepland staat, wat nu draait en wat op een akkoord wacht. De
  verwachte oplevering is herrekend op de gemeten doorlooptijd uit het throughput-log — geen tweede
  meetsysteem, en een klasse zonder gemeten doorlooptijd staat op <em>onbekend</em>, nooit een verzonnen datum.</p>
  <ul class="stats">${band}</ul>
  <div class="scroll"><table>
    <thead><tr><th>Feature</th><th>status</th><th>rol</th><th>oplevering</th><th>afhankelijkheid</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <h3>Kanaalpost — laatste ${num(p.kanaalpost.length)}</h3>
  ${kanaalRows
    ? `<div class="scroll"><table><thead><tr><th>datum</th><th>chat</th><th>onderwerp</th><th>status</th></tr></thead><tbody>${kanaalRows}</tbody></table></div>`
    : '<p class="empty">Nog geen kanaalpost-rijen.</p>'}
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
.tag.ok{background:color-mix(in srgb,var(--ok) 20%,transparent);color:var(--ok)}
.tag.cat{min-width:0;background:color-mix(in srgb,var(--acc) 16%,transparent);color:var(--acc);text-transform:uppercase;letter-spacing:.04em;font-size:11px}
.badge{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:2px 7px;border-radius:20px;border:1px solid currentColor}
.badge.ok{color:var(--ok)}.badge.warn{color:var(--warn)}.badge.bad{color:var(--bad)}
.empty{color:var(--mut);margin:0}
.lights{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
.lights li{display:flex;align-items:center;gap:9px}
.repo{flex:0 1 auto}
.dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;background:var(--mut)}
.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}.dot.none{background:var(--line);border:1px solid var(--mut)}
.plaat{margin-bottom:18px}
.stats{margin:12px 0 0;padding:0;list-style:none;display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}
.stat{border:1px solid var(--line);border-left:3px solid var(--mut);border-radius:6px;padding:9px 11px;display:flex;flex-direction:column;gap:2px;min-width:0}
.stat.ok{border-left-color:var(--ok)}.stat.warn{border-left-color:var(--warn)}.stat.bad{border-left-color:var(--bad)}
.stat-label{font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut)}
.stat-value{font-size:19px;font-weight:600;overflow-wrap:anywhere}
.stat-detail{font-size:12.5px;overflow-wrap:anywhere}
.unknown{color:var(--warn)}
.rood{color:var(--bad)}
footer{margin-top:28px;color:var(--mut);font-size:12.5px;border-top:1px solid var(--line);padding-top:14px}
a{color:var(--acc)}
`;

/** Bouw de volledige pagina. `snapshot` moet al door assertPublishable zijn gegaan. */
export function renderHtml(snapshot, { refreshSeconds = 900 } = {}) {
  const s = snapshot;
  const stale = s.sources.filter((x) => x.trust !== 'VERIFIED_CURRENT');
  // Harde integer: deze waarde staat in een meta-tag en mag daar niets anders kunnen worden.
  const refresh = Math.min(3600, Math.max(60, Math.trunc(Number(refreshSeconds)) || 900));
  // Cache-buster voor de zelf-refresh. GitHub Pages serveert met cache-control: max-age=600 en
  // wij kunnen die header niet zetten; zonder buster kan een browser bij de meta-refresh dezelfde
  // `./` uit zijn eigen cache serveren i.p.v. de verse publicatie op te halen. Door de refresh naar
  // `./?v=<stempel>` te sturen krijgt elke nieuwe publicatie een eigen URL: de browser heeft daar nog
  // geen cache-kopie van en trekt vers. Alleen cijfers uit generatedAt — dezelfde tuchtregel als bij
  // `refresh`: wat in een meta-tag staat mag niets anders kunnen worden dan bedoeld.
  const cacheBust = String(s.generatedAt).replace(/[^0-9]/g, '') || '0';

  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${refresh}; url=./?v=${cacheBust}">
<meta name="robots" content="noindex,nofollow">
<meta http-equiv="content-security-policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
<title>Stack-dashboard — ${esc(s.generatedAt.slice(0, 16).replace('T', ' '))} UTC</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>Stack-dashboard</h1>
  <p class="stamp">Laatst bijgewerkt: <strong>${esc(dt(s.generatedAt))}</strong> · deze pagina haalt zichzelf elke ${num(refresh / 60)} min opnieuw op</p>
</header>
<p class="muted">Weergave van bestaande canon — nooit een tweede waarheid. Alles is read-only en gesaneerd;
${stale.length === 0 ? 'alle bronnen zijn geverifieerd.' : `<strong>${num(stale.length)}</strong> van ${num(s.sources.length)} bronnen is niet geverifieerd (zie de badges).`}
<strong>Lees altijd eerst de stempel hierboven:</strong> deze pagina is statisch en wordt opnieuw gebouwd
bij elke push naar main en bij een handmatige run — <strong>niet op een gegarandeerd interval</strong>.
De geplande kwartierrun staat wel ingesteld, maar GitHub voert die hier niet betrouwbaar uit. Een oude
stempel betekent dat déze pagina-kopie oud is — niet per se dat er niets is gepubliceerd: een verse
publicatie kan door browser- of CDN-cache tot tien minuten later pas zichtbaar worden. De stempel geeft
de leeftijd van déze kopie; losse brondata kan ouder zijn, dus lees ook de badges per bron.</p>

${overzicht(s)}

${planning(s.planning)}

<div class="grid">
  ${pullRequests(s.pullRequests)}
  ${ci(s.ci)}
  ${tracker(s.tracker)}
  ${decisions(s.decisions)}
  ${tracks(s.tracks)}
  ${merged(s.merged)}
  ${logbook(s.logbook)}
</div>

${workstreams(s.workstreams)}

<footer>
  Gegenereerd door <code>stack-dashboard</code> (contract ${esc(s.contractVersion)}) uit gecureerde bronnen
  op GitHub. Wat hier staat is met de hand geselecteerd: tellingen, ID's, datums en statussen.
  De vrije tekst uit de bronnen staat er standaard <strong>niet</strong> in — geen documentinhoud,
  geen tokens, geen secretnamen, geen lokale paden. Elke build passeert een
  sanitize-gate die fail-closed is, plus een onafhankelijke secretsscan vóór publicatie.
  Bij een onbereikbare bron staat er <em>bron onbereikbaar</em> — geen gecachte groene stand.
</footer>
</div>
</body>
</html>
`;
}
