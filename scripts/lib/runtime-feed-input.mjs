/**
 * Expliciete ingang voor het runtimefeedcontract.
 *
 * Er is bewust geen stil ingebouwde GitHub-locatie: de producerbestanden staan nog niet op
 * stack-control/main. Een niet-aangeleverde, ontbrekende of onleesbare feed wordt daarom UNKNOWN.
 * Zodra de producer bestaat kan de build met `--runtime-feed <bestand>` exact hetzelfde contract
 * consumeren, zonder dat een lokaal pad of parsefout in de publieke output terechtkomt.
 *
 * PR69 B2 — LAST-KNOWN-GOOD BIJ EEN LEVENDE LEESFOUT. Een niet-lezen/niet-parsen/schema-afwijzen
 * van de LIVE feed hoeft niet meteen alle taakstatus te wissen: als er eerder al een bewezen
 * schema-geldige meting is opgeslagen, wordt DIE opnieuw door het volledige contract gehaald
 * (schema + sanitize + freshness, met het HUIDIGE bouwmoment als klok — een oude meting wordt dus
 * vanzelf weer STALE, nooit stilzwijgend CURRENT) en als `fallback`-gemarkeerd resultaat
 * teruggegeven. Bestaat er nog geen cache, dan blijft het gewone UNKNOWN-pad staan; er wordt nooit
 * iets verzonnen. De cache leeft uitsluitend onder `.local/` (nooit gepubliceerd, nooit in git —
 * dezelfde grens die `build.mjs` al gebruikt voor `.local/snapshot.json`), en bevat exact de RUWE
 * feed-tekst die al één keer schema-geldig was — geen afgeleide of samengevatte waarden.
 */

// `node:fs/promises`/`node:path` zijn alleen nodig voor de Node-only bestandsfuncties hieronder
// (loadRuntimeFeed/schrijfLastKnownGood/leesLastKnownGood). `runtimeFeedFromText` zelf raakt geen
// bestand aan en is de client-side ingang (runtime-poll.mjs) — top-level await i.p.v. een
// dynamische import binnen elke functie houdt hun bestaande async-signatuur ongewijzigd en maakt
// dit bestand toch door de browser laadbaar, die geen `node:fs` kent.
// Zie sanitize.mjs: property-lezing op `globalThis`, nooit de kale global.
const isNode = !!globalThis.process?.versions?.node;
const fsMod = isNode ? await import('node:fs/promises') : null;
const pathMod = isNode ? await import('node:path') : null;

import { parseRuntimeFeed } from './runtime-feed.mjs';

const CACHE_VERSION = 1;

export function runtimeFeedFromText(text, options = {}) {
  if (typeof text !== 'string' || text.trim() === '') return parseRuntimeFeed(null, options);
  try {
    return parseRuntimeFeed(JSON.parse(text), options);
  } catch {
    return parseRuntimeFeed(null, options);
  }
}

/** Best-effort schrijven — een niet-schrijfbare cache mag de build nooit laten falen. */
async function schrijfLastKnownGood(cachePath, raw) {
  if (typeof cachePath !== 'string' || cachePath.trim() === '' || raw === null || raw === undefined) return;
  try {
    await fsMod.mkdir(pathMod.dirname(cachePath), { recursive: true });
    const inhoud = JSON.stringify({ cacheVersion: CACHE_VERSION, raw }, null, 2);
    await fsMod.writeFile(cachePath, `${inhoud}\n`, 'utf8');
  } catch {
    // stil: de live feed zelf is al geslaagd, een cacheschrijffout mag dat resultaat niet raken.
  }
}

/**
 * Leest de cache en haalt de bewaarde ruwe feed opnieuw door `parseRuntimeFeed` — nooit de
 * gecachete velden blind hergebruiken. Een verkeerde/oudere `cacheVersion`, onleesbaar bestand, of
 * een cache die zelf niet meer schema-geldig blijkt (contract kan ondertussen gewijzigd zijn) telt
 * als "geen cache", niet als een tweede foutpad.
 */
async function leesLastKnownGood(cachePath, parseOptions) {
  if (typeof cachePath !== 'string' || cachePath.trim() === '') return null;
  try {
    const parsed = JSON.parse(await fsMod.readFile(cachePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || parsed.cacheVersion !== CACHE_VERSION) return null;
    const opnieuw = parseRuntimeFeed(parsed.raw, parseOptions);
    return opnieuw.available === true ? opnieuw : null;
  } catch {
    return null;
  }
}

/**
 * `options.cachePath` is optioneel: zonder cachePath is dit functioneel identiek aan de oude
 * versie (geen terugval, geen bestandsschrijving) — bestaande aanroepers zonder B2 blijven exact
 * hetzelfde gedrag houden.
 */
export async function loadRuntimeFeed(path, options = {}) {
  const { cachePath, ...parseOptions } = options;

  let rawParsed = null;
  if (typeof path === 'string' && path.trim() !== '') {
    try {
      const text = await fsMod.readFile(path, 'utf8');
      if (text.trim() !== '') rawParsed = JSON.parse(text);
    } catch {
      rawParsed = null;
    }
  }

  const result = parseRuntimeFeed(rawParsed, parseOptions);
  if (result.available === true) {
    await schrijfLastKnownGood(cachePath, rawParsed);
    return result;
  }

  const fallback = await leesLastKnownGood(cachePath, parseOptions);
  // PR69 B6 (Codex-correctie) — een terugval bewijst per definitie dat de LIVE bron nu niet
  // leesbaar is, dus CURRENT mag nooit blijven staan. Maar UNKNOWN is een ANDER, slechter signaal
  // dan STALE (onleesbaar/toekomstig vs. "wel leesbaar, gewoon oud") — het onvoorwaardelijk
  // overschrijven met STALE verzweeg dus juist een ergere waarheid. Alleen CURRENT→STALE is een
  // correcte verlaging; een reeds STALE of UNKNOWN cacheresultaat blijft exact wat het al was.
  if (fallback) {
    return {
      ...fallback,
      freshness: fallback.freshness === 'CURRENT' ? 'STALE' : fallback.freshness,
      fallback: { used: true, reason: result.reason },
    };
  }
  return result;
}
