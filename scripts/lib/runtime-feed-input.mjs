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

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

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
    await mkdir(dirname(cachePath), { recursive: true });
    const inhoud = JSON.stringify({ cacheVersion: CACHE_VERSION, raw }, null, 2);
    await writeFile(cachePath, `${inhoud}\n`, 'utf8');
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
    const parsed = JSON.parse(await readFile(cachePath, 'utf8'));
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
      const text = await readFile(path, 'utf8');
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
  if (fallback) return { ...fallback, fallback: { used: true, reason: result.reason } };
  return result;
}
