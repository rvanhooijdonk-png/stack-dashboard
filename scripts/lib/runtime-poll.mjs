/**
 * RUNTIME-POLL — dunne browseradapter voor client-side polling van de "Nu actief"-sectie.
 * Bevat zelf GEEN classificatie-/waarheidslogica: parseren (`runtimeFeedFromText`,
 * runtime-feed-input.mjs) en renderen (`renderActive`, runtime-feed-view.mjs) zijn letterlijk
 * dezelfde functies als de statische Node-build gebruikt — dit bestand doet uitsluitend
 * fetch/timeout/backoff/DOM-vervanging, nooit een tweede interpretatie van de feed.
 *
 * Alleen actief wanneer build.mjs met --client-poll-origin draaide (zie render-cockpit.mjs
 * `page()`); zonder die vlag wordt dit bestand niet gekopieerd en niet ingeladen, en verandert er
 * niets aan de bestaande statische pagina's.
 *
 * Origin komt uit de door build.mjs geïnjecteerde <meta name="runtime-feed-origin">-tag (al
 * gevalideerd als kale origin vóór publicatie); het feedpad zelf staat hardcoded hieronder — de
 * configureerbare waarde draagt nooit een pad, query of token, zodat de publieke CSP/meta-tag
 * nooit meer dan een origin kan lekken.
 */
import { runtimeFeedFromText } from './runtime-feed-input.mjs';
import { renderActive } from './runtime-feed-view.mjs';

const ENDPOINT_PATH = '/runtime-feed.json';
const POLL_MS = 5000;
const TIMEOUT_MS = 8000;
const MAX_BACKOFF_MS = 60000;
// De feed is kleine JSON; groter is per definitie corrupt of kwaadaardig. Zonder plafond kan een
// oversized antwoord de hoofdthread laten hangen tijdens parse/sanitize/render, ná het moment
// waarop de timeout nog kon ingrijpen (review Codex, dashboard-client-polling-c).
const MAX_BODY_BYTES = 1_000_000;

/** Alleen een kale http(s)-origin — geen pad, geen query, geen credentials-in-URL. */
function readOrigin() {
  const content = document.querySelector('meta[name="runtime-feed-origin"]')?.getAttribute('content') ?? '';
  try {
    const url = new URL(content);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** Vervangt #nu-actief door de gegeven feed-render — fail-closed: geen fetch-/parsefout mag ooit
 * als CURRENT/ACTIVE tonen, dus foutpaden roepen dit aan met `{ available: false }`. */
function renderFeed(feed) {
  const section = document.getElementById('nu-actief');
  if (section) section.outerHTML = renderActive(feed, Date.now());
}
const renderUnknown = () => renderFeed({ available: false });

/** Leest het antwoord gestreamd en breekt (via dezelfde AbortController) af zodra MAX_BODY_BYTES
 * wordt overschreden — een `response.text()` had het hele lichaam eerst gebufferd. */
async function readBounded(response, controller) {
  const reader = response.body?.getReader?.();
  if (!reader) return response.text();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) { controller.abort(); throw new Error('runtime-feed te groot'); }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

/** Eén poll, altijd afgerond vóór de volgende wordt gepland — nooit twee verzoeken tegelijk. */
async function pollOnce(origin) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${origin}${ENDPOINT_PATH}`, {
      signal: controller.signal, cache: 'no-store', credentials: 'omit',
    });
    if (!response.ok) { renderUnknown(); return false; }
    const text = await readBounded(response, controller);
    const feed = runtimeFeedFromText(text, { now: new Date() });
    if (feed.available !== true) { renderUnknown(); return false; }
    renderFeed(feed);
    return true;
  } catch {
    renderUnknown();
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Begrensde backoff: verdubbelt op fouten tot MAX_BACKOFF_MS, herstelt meteen na één geslaagde poll. */
function startPolling(origin) {
  let delayMs = POLL_MS;
  const tick = async () => {
    const ok = await pollOnce(origin);
    delayMs = ok ? POLL_MS : Math.min(MAX_BACKOFF_MS, delayMs * 2);
    setTimeout(tick, delayMs);
  };
  setTimeout(tick, 0);
}

const origin = readOrigin();
if (origin) startPolling(origin);
else renderUnknown();
