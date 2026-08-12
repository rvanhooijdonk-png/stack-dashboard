/**
 * Expliciete ingang voor het runtimefeedcontract.
 *
 * Er is bewust geen stil ingebouwde GitHub-locatie: de producerbestanden staan nog niet op
 * stack-control/main. Een niet-aangeleverde, ontbrekende of onleesbare feed wordt daarom UNKNOWN.
 * Zodra de producer bestaat kan de build met `--runtime-feed <bestand>` exact hetzelfde contract
 * consumeren, zonder dat een lokaal pad of parsefout in de publieke output terechtkomt.
 */

import { readFile } from 'node:fs/promises';

import { parseRuntimeFeed } from './runtime-feed.mjs';

export function runtimeFeedFromText(text, options = {}) {
  if (typeof text !== 'string' || text.trim() === '') return parseRuntimeFeed(null, options);
  try {
    return parseRuntimeFeed(JSON.parse(text), options);
  } catch {
    return parseRuntimeFeed(null, options);
  }
}

export async function loadRuntimeFeed(path, options = {}) {
  if (typeof path !== 'string' || path.trim() === '') return parseRuntimeFeed(null, options);
  try {
    return runtimeFeedFromText(await readFile(path, 'utf8'), options);
  } catch {
    return parseRuntimeFeed(null, options);
  }
}
