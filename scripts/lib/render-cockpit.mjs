/**
 * COCKPIT — de voorpagina. Tien-secondenbord: rood eerst, wat draait, taken voor jou (Richards
 * open gates), afsprakenspoor, stackkaart. Consumeert dezelfde al-gesaneerde/contract-gated snapshot als
 * renderHtml() (de Contentstroom-pagina) — geen eigen databron, geen eigen sanitize-oppervlak.
 * Pure functie: geen fetch, geen state, alles komt uit `snapshot`.
 */

import {
  esc, num, dt, buildStamp, titelStamp, rollup, VLOOT_KLEUR, TRUST_LABEL, STYLE,
} from './render.mjs';
import { ALARM_KOP } from './waarnemer.mjs';

const BRON_NAAM = {
  pullRequests: 'open pull requests',
  merged: 'gemerged',
  tracker: 'tracker',
  decisions: 'besluitenregister',
  tracks: 'tracks',
  logbook: 'journaal',
  ci: 'CI-ampels',
};

/**
 * ROOD EERST — CI-ampels op rood, bronnen die niet VERIFIED_CURRENT zijn, en vlootstand-vensters
 * op ONBEKEND (stil genoeg om niet te weten of ze werken). Drie gesloten bronnen, geen vierde.
 */
function roodEerst(s) {
  const r = rollup(s);
  const items = [];
  if (r.ci.available && r.ci.rood > 0) {
    items.push(`<li><span class="dot bad"></span><span class="repo">${r.ci.roodRepos
      ? `CI rood: ${r.ci.roodRepos.map((x) => esc(x)).join(', ')}`
      : `${num(r.ci.rood)} repo('s) CI rood`}</span></li>`);
  }
  (s.sources ?? []).filter((x) => x.trust !== 'VERIFIED_CURRENT').forEach((x) => {
    items.push(`<li><span class="dot warn"></span><span class="repo">${esc(BRON_NAAM[x.key] ?? x.key)}</span>
      <span class="muted">${esc(TRUST_LABEL[x.trust] ?? x.trust)}</span></li>`);
  });
  (s.vlootstand?.available ? s.vlootstand.vensters : [])
    .filter((v) => v.toestand === 'ONBEKEND')
    .forEach((v) => {
      items.push(`<li><span class="dot bad"></span><span class="repo">${esc(v.venster)}</span>
      <span class="muted">stil, stand onbekend</span></li>`);
    });
  if (items.length === 0) {
    return `<section id="rood-eerst" class="card wide">
  <h2>Rood eerst</h2>
  <p class="lead muted">Niets roods: geen CI in het rood, alle bronnen geverifieerd, geen venster stil
  genoeg om onbekend te zijn.</p>
</section>`;
  }
  return `<section id="rood-eerst" class="card wide">
  <h2>Rood eerst <span class="badge bad">${num(items.length)}</span></h2>
  <ul class="lights">${items.join('\n')}</ul>
</section>`;
}

/** WAT DRAAIT — vensters die WERKT melden, features die in-bouw staan. */
function watDraait(s) {
  const werkend = s.vlootstand?.available ? s.vlootstand.vensters.filter((v) => v.toestand === 'WERKT') : [];
  const inBouw = s.planning?.available ? s.planning.features.filter((f) => f.status === 'in-bouw') : [];
  const items = [
    ...werkend.map((v) => `<li><span class="dot ok"></span><span class="repo">${esc(v.venster)}</span>${
      v.rol ? `<span class="muted">${esc(v.rol)}</span>` : ''}</li>`),
    ...inBouw.map((f) => `<li><span class="dot ok"></span><span class="repo">${esc(f.label)}</span>${
      f.worker ? `<span class="muted">${esc(f.worker)}</span>` : ''}</li>`),
  ];
  if (items.length === 0) {
    return `<section id="wat-draait" class="card wide">
  <h2>Wat draait</h2>
  <p class="empty">Geen venster meldt WERKT en geen feature staat op in-bouw.</p>
</section>`;
  }
  return `<section id="wat-draait" class="card wide">
  <h2>Wat draait <span class="badge ok">${num(items.length)}</span></h2>
  <ul class="lights">${items.join('\n')}</ul>
</section>`;
}

/**
 * Wanneer is een waarnemer-rij een zelfmelding over de plaat, en wanneer een echte poort?
 *
 * Op de tab alleen filteren was te breed (bevinding Codex T2c-0198, 01-08-2026, middel): de
 * waarnemer kan óók een inhoudelijke rij schrijven waar Richard wél over moet beslissen, en die
 * verdween dan uit precies de sectie die al zijn gates moet tonen. Het kenmerk is daarom de vaste
 * kop die `alarmRij()` in `waarnemer.mjs` vóór élke zelfmelding zet — geïmporteerd, niet
 * overgeschreven, zodat de twee kanten niet uit elkaar kunnen lopen.
 *
 * De publieke DTO levert die kop zónder de nadrukken aan: gemeten op `data/kanaalpost-publiek.md`
 * (02-08-2026, alle vier de waarnemer-rijen) beginnen de onderwerpen met de kale zin. Er wordt
 * daarom op de kale vorm vergeleken, en met `startsWith` en niet op gelijkheid — het onderwerp
 * draagt achter de kop de bevindingen en wordt bovendien op 600 tekens afgekapt.
 *
 * Fail-open in de eerlijke richting: herkent deze toets een rij niet, dan blijft hij als gate staan.
 * Een rij te veel op de poort is een last; een gate te weinig is een gemist besluit.
 */
const ZELFMELDING_KOP = ALARM_KOP.replace(/\*/g, '').trim();

const isZelfmelding = (row) => String(row?.tab ?? '').trim().toUpperCase() === 'WAARNEMER'
  && String(row?.onderwerp ?? '').replace(/^[\s*]+/, '').startsWith(ZELFMELDING_KOP);

/**
 * De drie bronnen van deze sectie, met de tekst die verschijnt zodra er één niet leesbaar was.
 * Los benoemd, want "de PR-bron viel uit" is een ander bericht dan "de spiegel viel uit".
 */
const GATE_BRONNEN = [
  { key: 'pullRequests', tekst: 'mergepoorten onbekend — de bron met open pull requests was bij deze build niet leesbaar' },
  { key: 'planning', tekst: 'wacht-op-Richard onbekend — de planningbron was bij deze build niet leesbaar' },
  { key: 'kanaalpost', tekst: 'kanaalpost-gates onbekend — de spiegel was bij deze build niet leesbaar' },
];

/**
 * TAKEN VOOR JOU — Z12-eis (Richard, via REGIE-5, 01-08-2026): de voorpagina toont permanent wat er
 * op Richards poort staat. Drie gesloten bronnen, in volgorde van hardheid:
 *  1. open, niet-draft pull requests — merges zijn per werkwijze-regel een Richard-gate;
 *  2. planning-features op `wacht-op-Richard`;
 *  3. kanaalpost-rijen die hem als actiehouder noemen, MINUS de zelfmeldingen van de waarnemer.
 *
 * Die aftrek is de kern van de eis. Gemeten op de live-plaat van 01-08 bestond deze sectie voor
 * 4 van de 4 rijen uit waarnemer-alarm over de plaat zelf en toonde hij nul echte gates: de sectie
 * stond er wel, maar de plaats was bezet door ruis. De ingehouden rijen staan onverkort op de
 * Contentstroom-pagina (`kanaalpost`-sectie); hier staat alleen hoeveel het er waren.
 *
 * De sectie rendert ALTIJD — ook leeg. "Geen gate open" is zelf een antwoord dat Richard in tien
 * seconden moet kunnen aflezen; een sectie die bij leegte verdwijnt laat hem raden of hij hem mist.
 *
 * ONBEKEND IS GEEN NUL, en dat onderscheid is de kern (bevinding Codex T2c-0198, 01-08-2026, hoog).
 * Een uitgevallen bron gaf hier eerst nul gates, en nul gates gaf de zin "er staat op dit moment
 * niets op jouw poort" — de plaat verklaarde dus geruststellend dat Richard vrij was terwijl ze het
 * niet wist. Elke bron die niet aantoonbaar `available === true` is, krijgt daarom een eigen rode
 * regel bovenaan, en de geruststelling verschijnt uitsluitend als alle drie de bronnen gelezen zijn
 * én leeg. De onbekend-regels staan vóór de echte gates: dat een gate onzichtbaar kan zijn, is
 * dringender dan de gates die je wél ziet.
 */
function takenVoorJou(s) {
  const features = s.planning?.available ? s.planning.features.filter((f) => f.status === 'wacht-op-Richard') : [];
  const genoemd = s.kanaalpost?.available
    ? s.kanaalpost.rows.filter((row) => typeof row.actie === 'string' && row.actie.toLowerCase().includes('richard'))
    : [];
  const zelfmeldingen = genoemd.filter((row) => isZelfmelding(row));
  const rows = genoemd.filter((row) => !isZelfmelding(row));
  const teMergen = s.pullRequests?.available ? (s.pullRequests.totals?.ready ?? 0) : 0;
  const onbekend = GATE_BRONNEN.filter((b) => s[b.key]?.available !== true);
  const items = [
    ...onbekend.map((b) => `<li><span class="dot bad"></span><span class="repo">${esc(b.tekst)}</span>
      <span class="muted">geen meting — geen nulstand</span></li>`),
    ...(teMergen > 0 ? [`<li><span class="dot warn"></span><span class="repo">${num(teMergen)} open pull request(s) staan klaar om gemerged te worden</span>
      <span class="muted">merge is jouw poort</span></li>`] : []),
    ...features.map((f) => `<li><span class="dot warn"></span><span class="repo">${esc(f.label)}</span>${
      f.afhankelijkheid ? `<span class="muted">${esc(f.afhankelijkheid)}</span>` : ''}</li>`),
    ...rows.map((row) => `<li><span class="dot warn"></span><span class="repo">${
      row.onderwerp ? esc(row.onderwerp) : '<span class="muted">—</span>'}</span>${
      row.tab ? `<span class="tag">${esc(row.tab)}</span>` : ''}</li>`),
  ];
  const voetnoot = zelfmeldingen.length > 0
    ? `\n  <p class="muted">${num(zelfmeldingen.length)} rij(en) van de automatische controle over de plaat zelf
  staan hier bewust niet tussen — dat is geen gate op jouw poort. Ze staan onverkort op de Contentstroom-pagina.</p>`
    : '';
  if (items.length === 0) {
    // Bereikbaar zolang `onbekend` leeg is — alle drie de bronnen zijn dus gelezen en leeg.
    return `<section id="taken-voor-jou" class="card wide">
  <h2>Taken voor jou</h2>
  <p class="lead muted">Alle drie de bronnen zijn gelezen: geen pull request klaar om te mergen, niets op
  wacht-op-Richard, geen kanaalpost-rij met jou als actiehouder. Er staat op dit moment niets op jouw poort.</p>${voetnoot}
</section>`;
  }
  return `<section id="taken-voor-jou" class="card wide">
  <h2>Taken voor jou <span class="badge ${onbekend.length ? 'bad' : 'warn'}">${num(items.length)}</span></h2>
  <ul class="lights">${items.join('\n')}</ul>${voetnoot}
</section>`;
}

/** Vaste weergavelabels voor de gesloten AFSPRAKEN-statuslijst — zelfde volgorde als CONTROL/AFSPRAKEN.md. */
const AFSPRAKEN_STATUS_LABEL = {
  VASTGELEGD: 'vastgelegd',
  UITGEZET: 'uitgezet (in bak)',
  'IN BOUW': 'in bouw',
  VERWERKT: 'verwerkt',
  STAAND: 'staand',
};
const AFSPRAKEN_STATUS_VOLGORDE = ['VASTGELEGD', 'UITGEZET', 'IN BOUW', 'VERWERKT', 'STAAND'];

/**
 * AFSPRAKENSPOOR — CONTROL/AFSPRAKEN.md (privé stack-control), tweede spoor naast de
 * vlootstand-hartslag. REGIE-besluit 30-07-2026: publiek toont uitsluitend structuur — tellers
 * per status en het tijdstip van de laatste bestandswijziging. De afspraaktekst zelf, de ID's en
 * de bewijsverwijzingen zijn onvoorwaardelijk intern (zie `toPublicSnapshot` in build.mjs); dit
 * blok kent daarom bewust geen lijst van afzonderlijke rijen, alleen aantallen.
 */
function afsprakenspoor(a) {
  if (!a?.available) {
    return `<section id="afsprakenspoor" class="card wide">
  <h2>Afsprakenspoor</h2>
  <p class="empty">CONTROL/AFSPRAKEN.md is bij deze build niet leesbaar — geen tellers te tonen.</p>
</section>`;
  }
  const totaal = AFSPRAKEN_STATUS_VOLGORDE.reduce((sum, k) => sum + (a.statusCounts?.[k] ?? 0), 0);
  const items = AFSPRAKEN_STATUS_VOLGORDE
    .filter((k) => (a.statusCounts?.[k] ?? 0) > 0)
    .map((k) => `<li><span class="dot"></span><span class="repo">${esc(AFSPRAKEN_STATUS_LABEL[k])}</span><span class="tag">${num(a.statusCounts[k])}</span></li>`)
    .join('\n');
  return `<section id="afsprakenspoor" class="card wide">
  <h2>Afsprakenspoor <span class="badge">${num(totaal)}</span></h2>
  <p class="lead muted">Alleen structuur — de afspraaktekst zelf is intern. Laatste wijziging: ${
    a.lastChangedAt ? esc(dt(a.lastChangedAt)) : '<span class="muted">onbekend</span>'}.</p>
  ${items ? `<ul class="lights">${items}</ul>` : '<p class="empty">Geen enkele rij herkend.</p>'}
</section>`;
}

/**
 * STACKKAART — vereenvoudigde versie van CONTROL/ONTWERP/stackkaart-v2-referentie.html. De volledige
 * v2-norm groepeert per business-lane met fase-kleuren (gepland/in-aanbouw/werkt-lokaal/in-gebruik);
 * die groepering bestaat als data niet in dit repo. Deze kaart toont daarom de 15 vaste lanes op hun
 * ECHTE vlootstand (WERKT/LEEG/ONBEKEND) — een bewuste vereenvoudiging, geen v2-norm-claim.
 */
function stackkaart(v) {
  if (!v?.available) {
    return `<section id="stackkaart" class="card wide">
  <h2>Stackkaart</h2>
  <p class="empty">Geen vlootstand beschikbaar — geen kaart te tonen.</p>
</section>`;
  }
  const rows = v.vensters.map((r) => `<li><span class="dot ${VLOOT_KLEUR[r.toestand] ?? 'bad'}"></span><span class="repo">${esc(r.venster)}</span>${
    r.rol ? `<span class="muted">${esc(r.rol)}</span>` : ''}</li>`).join('\n');
  return `<section id="stackkaart" class="card wide">
  <h2>Stackkaart <span class="badge">${num(v.vensters.length)} lanes</span></h2>
  <p class="lead muted">Vereenvoudigde kaart op echte vlootstand-data — niet de volledige
  business-lane/fase-indeling uit het v2-referentieontwerp; die groepering bestaat als data nog niet in
  deze repo.</p>
  <ul class="lights">${rows}</ul>
</section>`;
}

/**
 * Bouw de cockpit-pagina. `snapshot` moet al door assertPublishable zijn gegaan — zelfde contract
 * als renderHtml(). `nav` is een vaste, intern door build.mjs samengestelde HTML-snippet (link naar
 * de Contentstroom-pagina), géén vrije of brongebonden tekst.
 */
export function renderCockpit(snapshot, { refreshSeconds = 900, nav = '' } = {}) {
  const s = snapshot;
  const refresh = Math.min(3600, Math.max(60, Math.trunc(Number(refreshSeconds)) || 900));
  const cacheBust = String(s.generatedAt).replace(/[^0-9]/g, '') || '0';

  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${refresh}; url=./?v=${cacheBust}">
<meta name="robots" content="noindex,nofollow">
<meta http-equiv="content-security-policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
<title>Stack-dashboard — ${esc(titelStamp(s.generatedAt))}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
${nav ? `${nav}\n` : ''}<header>
  <h1>Stack-dashboard <small class="gedeeld">— cockpit</small></h1>
  <p class="stamp">Laatst bijgewerkt: <strong>${esc(buildStamp(s.generatedAt))}</strong> · deze pagina haalt zichzelf elke ${num(refresh / 60)} min opnieuw op</p>
</header>

${roodEerst(s)}

${watDraait(s)}

${takenVoorJou(s)}

${afsprakenspoor(s.afspraken)}

${stackkaart(s.vlootstand)}

<footer>
  Gegenereerd door <code>stack-dashboard</code> (contract ${esc(s.contractVersion)}) uit gecureerde bronnen
  op GitHub. Dit is het 10-secondenbord; de volledige doorstroom-plaat staat op de Contentstroom-pagina.
</footer>
</div>
</body>
</html>
`;
}
