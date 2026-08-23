/**
 * RUNTIME-FEED-VIEW — "Nu actief"-classificatie en -rendering. Verplaatst (niet gekopieerd) uit
 * render-cockpit.mjs zodat dezelfde functies letterlijk door zowel de statische Node-build als
 * de browser (runtime-poll.mjs, client-side polling) gebruikt worden — nooit een tweede
 * interpretatie van dezelfde waarheid. Puur: geen fs, geen network, geen DOM-aanraking.
 */
import { esc, num, list } from './format.mjs';
import { CODES } from './runtime-feed.mjs';

const validIso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));

/**
 * Groen actief komt uitsluitend uit het runtimecontract. De renderer herhaalt de bewijscheck
 * defensief: task-id, actor, WORKER_STARTED, aantoonbaar latere heartbeat en CURRENT-freshness.
 * Een planning/backlogregel kan hierdoor nooit meer zelf als actieve runtimeclaim verschijnen.
 */
export function activeWork(runtimeFeed) {
  if (runtimeFeed?.available !== true) return { available: false, active: [], incomplete: 0 };
  const active = [];
  let incomplete = 0;
  for (const actor of runtimeFeed.actors ?? []) {
    const task = actor?.current_task;
    if (!task) continue;
    const actorId = typeof actor.actor_id === 'string' ? actor.actor_id.trim() : '';
    const taskId = typeof task.task_id === 'string' ? task.task_id.trim() : '';
    const visibleIdentity = actorId && taskId
      && !actorId.includes('[REDACTED') && !taskId.includes('[REDACTED');
    const startedAt = task.worker_started?.value;
    const heartbeatAt = task.last_heartbeat?.value;
    const ordered = validIso(startedAt) && validIso(heartbeatAt)
      && Date.parse(heartbeatAt) > Date.parse(startedAt);
    const proven = runtimeFeed.freshness === 'CURRENT'
      && actor.identity === 'OK' && task.identity === 'OK' && task.active === true
      && visibleIdentity && ordered && task.last_heartbeat?.freshness === 'CURRENT';
    if (proven) {
      active.push({ actor: actorId, taskId, startedAt, heartbeatAt, evidenceRef: task.pickup?.evidence_ref ?? null });
    } else incomplete += 1;
  }
  return { available: true, active, incomplete };
}

const AGE_UNITS = [['d', 86400000], ['u', 3600000], ['m', 60000], ['s', 1000]];
/** Leeftijd t.o.v. `nowMs`. Bij de statische Node-build is dat het bouwmoment
 * (`snapshot.generatedAt`, elke meta-refresh herrekent dit vanaf een vers bouwmoment); bij
 * client-side polling (runtime-poll.mjs) is dat bewust de echte browserklok — daar dient dit juist
 * wél als live "x geleden"-weergave, want die pagina draait al met JS-polling in plaats van een
 * no-JS meta-refresh. */
export function ageSince(iso, nowMs) {
  if (typeof iso !== 'string' || !Number.isFinite(nowMs)) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || nowMs < ms) return null;
  const delta = nowMs - ms;
  for (const [unit, size] of AGE_UNITS) if (delta >= size) return `${Math.floor(delta / size)}${unit}`;
  return '0s';
}

export const REASON_LABEL = {
  ...CODES,
  FEED_VEROUDERD: 'de metingsklok van de hele feed is veroudered — een losse verse heartbeat bewijst geen huidige activiteit',
  GEREDIGEERDE_IDENTITEIT: 'actor- of task-id is voor publicatie geredigeerd — geen zichtbaar identiteitsbewijs',
  DUBBELE_IDENTITEIT: 'twee of meer regels delen dezelfde identiteit — niet eenduidig toe te wijzen',
};

/** Bewijspointer met uitsluitend al-gepubliceerde, al-gesaneerde velden — geen nieuwe URL verzonnen. */
export function evidencePointer(runtimeFeed) {
  const when = typeof runtimeFeed.measured_at?.value === 'string' ? runtimeFeed.measured_at.value : 'onbekend meetmoment';
  const host = typeof runtimeFeed.control_host === 'string' && runtimeFeed.control_host ? ` op ${runtimeFeed.control_host}` : '';
  return `bewijs: meting ${when}${host}`;
}

/**
 * Claimbewijs per record — géén prose meer, maar een echte verwijzing naar het onveranderlijke
 * bewijskenmerk achter DEZE claim (`pickup.evidence_ref` voor actief werk, `closed[].evidence_ref`
 * voor AFGEROND OK). Alleen een github.com-URL onder een TOEGESTANE EIGENAAR wordt klikbaar
 * gemaakt — elke andere of ontbrekende URL toont uitsluitend het opaque kenmerk (`kind:ref`), nooit
 * een verzonnen link. `ref`/`url` zijn al door de SANITIZE-GATE in runtime-feed.mjs; hier alleen
 * nog HTML-escapen voor opname in de pagina.
 *
 * De lijst toegestane eigenaars is opzettelijk klein en groeit alleen op twee manieren:
 *
 *  - `HISTORISCHE_BEWIJS_EIGENAAR` staat er ALTIJD in. Al het bewijsmateriaal dat vóór de
 *    organisatieoverdracht is vastgelegd, wijst naar commits onder dat account; die commits
 *    verhuizen niet mee met een repository-overdracht en zouden anders na de overdracht hun link
 *    verliezen. Dit is dus geen achterstallige hardcodering maar een gedocumenteerde historische
 *    verwijzing.
 *  - de eigenaar waaronder deze repository nu draait, en alleen als de Actions-context die noemt.
 *    Ontbreekt die context, dan wordt de lijst NIET geraden: er verschijnt dan hooguit een label
 *    zonder link, en dat is de veilige kant van deze poort.
 */
const HISTORISCHE_BEWIJS_EIGENAAR = 'rvanhooijdonk-png';
export function evidenceUrlPrefixes(env = process.env) {
  const eigenaars = new Set([HISTORISCHE_BEWIJS_EIGENAAR]);
  const nu = typeof env?.GITHUB_REPOSITORY_OWNER === 'string' ? env.GITHUB_REPOSITORY_OWNER : '';
  if (/^[A-Za-z0-9._-]{1,100}$/.test(nu)) eigenaars.add(nu);
  return [...eigenaars].map((eigenaar) => `https://github.com/${eigenaar}/`);
}
export function claimEvidence(evidenceRef, { prefixes = evidenceUrlPrefixes() } = {}) {
  if (!evidenceRef || typeof evidenceRef.ref !== 'string' || !evidenceRef.ref) return '';
  const idLabel = `${evidenceRef.kind}:${evidenceRef.ref}`;
  const url = typeof evidenceRef.url === 'string' && prefixes.some((p) => evidenceRef.url.startsWith(p))
    ? evidenceRef.url : null;
  return url
    ? ` · claimbewijs: <a href="${esc(url)}" rel="noopener">${esc(idLabel)}</a>`
    : ` · claimbewijs: ${esc(idLabel)}`;
}

/**
 * Classificeert één actor.current_task voor weergave BUITEN de al-bewezen ACTIVE-lijst
 * (`activeWork()`, ongewijzigd gelaten). STALE dekt twee losse paden: de heartbeat zelf is
 * verouderd (`active_reason==='VEROUDERD'`), óf de heartbeat is op zichzelf vers maar de hele feed
 * is dat niet (`task.active===true` bij `runtimeFeed.freshness!=='CURRENT'`) — exact het scenario
 * uit de bestaande test "een stale feed kan met een los verse heartbeat geen actief werk claimen".
 */
export function classifyCurrentTask(runtimeFeed, actor, task) {
  if (actor.identity === 'CONFLICT' || task.identity === 'CONFLICT') return { state: 'CONFLICT', code: 'DUBBELE_IDENTITEIT' };
  const actorId = typeof actor.actor_id === 'string' ? actor.actor_id.trim() : '';
  const taskId = typeof task.task_id === 'string' ? task.task_id.trim() : '';
  const visibleIdentity = actorId && taskId && !actorId.includes('[REDACTED') && !taskId.includes('[REDACTED');
  if (task.active === true) {
    if (!visibleIdentity) return { state: 'UNKNOWN', code: 'GEREDIGEERDE_IDENTITEIT' };
    return runtimeFeed.freshness === 'CURRENT' ? { state: 'ACTIVE', code: null } : { state: 'STALE', code: 'FEED_VEROUDERD' };
  }
  if (task.active_reason === 'VEROUDERD') return { state: 'STALE', code: 'VEROUDERD' };
  return { state: 'UNKNOWN', code: task.active_reason ?? (visibleIdentity ? null : 'GEREDIGEERDE_IDENTITEIT') };
}

export function renderActive(runtimeFeed, nowMs) {
  const state = activeWork(runtimeFeed);
  if (!state.available) return '<section id="nu-actief" class="card"><h2>Nu actief</h2><p class="unknown">UNKNOWN — runtimefeed niet beschikbaar of niet contractgeldig.</p></section>';
  const evidence = evidencePointer(runtimeFeed);
  const items = state.active.map((task) => {
    const age = ageSince(task.heartbeatAt, nowMs);
    return `<li><span class="dot ok"></span><span class="repo">IN UITVOERING · ${esc(task.taskId)}</span> <span class="muted">${esc(task.actor)} · WORKER_STARTED ${esc(task.startedAt)} · heartbeat ${esc(task.heartbeatAt)}${age ? ` (${esc(age)} geleden)` : ''} · ${esc(evidence)}${claimEvidence(task.evidenceRef)}</span></li>`;
  });
  const incomplete = state.incomplete
    ? `<p class="unknown evidence-warning">${num(state.incomplete)} kandidaat/kandidaten niet als actief getoond: task-id, actor, WORKER_STARTED of latere verse heartbeat ontbreekt.</p>` : '';

  const staleOrUnknown = [];
  const terminal = [];
  for (const actor of runtimeFeed.actors ?? []) {
    const task = actor.current_task;
    if (task) {
      const classification = classifyCurrentTask(runtimeFeed, actor, task);
      if (classification.state === 'STALE' || classification.state === 'UNKNOWN') {
        const hbAge = ageSince(task.last_heartbeat?.value, nowMs);
        const label = classification.state === 'STALE' ? 'VEROUDERD' : 'ONBEKEND';
        const dot = classification.state === 'STALE' ? 'warn' : 'bad';
        const reason = REASON_LABEL[classification.code] ?? classification.code ?? 'onvoldoende bewijs';
        staleOrUnknown.push(`<li><span class="dot ${dot}"></span><span class="repo">${label} · ${esc(task.task_id)}</span> <span class="unknown">${esc(actor.actor_id)}${task.last_heartbeat?.value ? ` · heartbeat ${esc(task.last_heartbeat.value)}${hbAge ? ` (${esc(hbAge)} geleden)` : ''}` : ''} · ${esc(reason)} · ${esc(evidence)}</span></li>`);
      }
    }
    for (const closed of actor.closed ?? []) {
      // `display_result`/`display_reason` komen uit beoordeelAfgerondeTaak() (runtime-feed.mjs) —
      // "AFGEROND OK" mag nooit verschijnen zonder gelijktijdig geldig bewijs+volgorde; ontbreekt dat
      // bij een geclaimd OK-resultaat, dan toont de pagina "BEWIJS ONVOLLEDIG" i.p.v. het geclaimde
      // resultaat stilzwijgend te vertrouwen. `result` zelf blijft ongewijzigd in het model (het is
      // wat de bron claimde); alleen de WEERGAVE volgt `display_result`.
      const displayResult = closed.display_result ?? closed.result;
      const label = displayResult === 'BEWIJS_ONVOLLEDIG' ? 'AFGEROND — BEWIJS ONVOLLEDIG' : `AFGEROND ${displayResult}`;
      const dot = displayResult === 'OK' ? 'ok' : displayResult === 'FAILED' ? 'bad' : 'warn';
      const age = ageSince(closed.closed_at?.value, nowMs);
      const reden = displayResult === 'BEWIJS_ONVOLLEDIG' || displayResult === 'UNKNOWN'
        ? ` · ${esc(REASON_LABEL[closed.display_reason] ?? closed.display_reason ?? 'onvoldoende bewijs')}` : '';
      const claim = displayResult === 'OK' ? claimEvidence(closed.evidence_ref) : '';
      terminal.push(`<li><span class="dot ${dot}"></span><span class="repo">${esc(label)} · ${esc(closed.task_id)}</span> <span class="muted">${esc(actor.actor_id)}${closed.closed_at?.value ? ` · ${esc(closed.closed_at.value)}${age ? ` (${esc(age)} geleden)` : ''}` : ''} · ${esc(evidence)}${reden}${claim}</span></li>`);
    }
  }

  const processFreshness = Object.entries(runtimeFeed.processes ?? {})
    .map(([name, process]) => `${name}: ${process?.heartbeat?.freshness ?? 'UNKNOWN'}`).join(' · ');
  const queues = (runtimeFeed.queue_counts ?? [])
    .map((queue) => `${queue.name}: ${queue.valid ? num(queue.count) : 'UNKNOWN'}`).join(' · ');
  const feedAge = ageSince(runtimeFeed.measured_at?.value, nowMs);
  // PR69 B2 — als loadRuntimeFeed() op een terugval naar de laatst bekende geldige meting draaide
  // (live lezen mislukte), moet de pagina dat expliciet tonen — nooit stilzwijgend een oude meting
  // als actuele weergeven. `fallback` bestaat alleen wanneer runtime-feed-input.mjs een cachePath
  // kreeg én de terugval daadwerkelijk gebruikt is.
  const fallbackBanner = runtimeFeed.fallback?.used
    ? `<p class="unknown evidence-warning">TERUGVAL — dit is de laatst bekende geldige meting, niet een live lezing; het live ophalen mislukte (${esc(String(runtimeFeed.fallback.reason ?? 'onbekende reden'))}).</p>`
    : '';
  return `<section id="nu-actief" class="card"><h2>Nu actief</h2><p class="${runtimeFeed.freshness === 'CURRENT' ? 'muted' : 'unknown'}">Runtime freshness: ${esc(runtimeFeed.freshness)}${feedAge ? ` · meting ${esc(feedAge)} geleden` : ''}${processFreshness ? ` · ${esc(processFreshness)}` : ''}</p>${fallbackBanner}${list(items, 'Geen werk met volledig task-id/actor/WORKER_STARTED/heartbeatbewijs.')}${incomplete}${staleOrUnknown.length ? `<ul class="lights">${staleOrUnknown.join('')}</ul>` : ''}${terminal.length ? `<h3>Recent afgerond</h3><ul class="lights">${terminal.join('')}</ul>` : ''}${queues ? `<p class="muted">Wachtrijen · ${esc(queues)}</p>` : ''}</section>`;
}
