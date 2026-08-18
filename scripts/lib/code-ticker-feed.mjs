/**
 * CODE-TICKER-FEED-ADAPTER — fail-closed consumercontract voor `data/code-ticker-feed.json`.
 *
 * Bewust STRUCTUUR-ONLY (Richard-akkoord 18-08-2026, tijdens deze bouwsessie): de kandidaatbron
 * voor "ruwe handelingen" (`~/Stack-Director/scratchpad/dispatch_*.log`) bevat volledige
 * taakopdrachten, worktree-paden en session-ID's — vrije proza die een patroon-sanitizer niet
 * betrouwbaar kan redigeren (zelfde risico als de `publish-text.json`-secties elders in deze repo,
 * bewezen met de "Project Saffier"-probe). Deze feed draagt daarom alleen gesloten-vocabulaire
 * velden (lane, actie, resultaat, exitcode, order-ID in een streng gevormd patroon) — geen
 * commando's, geen promptregels, geen outputregels. Uitklap-detail met ruwe regels is uitgesteld
 * tot een apart mensenreview-traject, niet stilzwijgend meegebouwd.
 *
 * Zelfde patroon als `transactie-feed.mjs`: één schrijver, geen identiteitsbotsingen, schema +
 * gesloten FRESHNESS + hergebruikte sanitize-gate — publicatie op de `dashboard-feeds`-branch van
 * stack-control (`CONTROL/FEEDS/code-ticker-feed.json`, nooit main), gelezen via
 * `collectCodeTickerFeedRaw()` in collect.mjs.
 *
 * Bron van de entries: alleen het vaste key=value-kopblok van `outbox/*_RECEIPT.md`
 * (actor/started_at/ended_at/exit_code, zoals `bin/dispatch-actor` dat zelf al schrijft) — nooit
 * de vrije "## Actoruitvoer"-body onder dat kopblok.
 */

import { validate } from './validate.mjs';

export const FRESHNESS = ['CURRENT', 'STALE', 'UNKNOWN'];
/** Zelfde bottleneck-redenering als transactie-feed.mjs: 3× de ~15 min publicatiecadans. */
export const STALE_DREMPEL_MS = 45 * 60 * 1000;
export const FUTURE_SKEW_MS = 5 * 60 * 1000;

export const CODES = {
  SCHEMA_ONBEKEND: 'de feed voldoet niet aan het vaste contract (onbekend veld of verkeerde vorm)',
  ONTBREEKT: 'geen tijdstempel aanwezig',
  ONLEESBAAR: 'tijdstempel is geen leesbare, zone-bewuste ISO-8601-waarde',
  TOEKOMST: 'tijdstempel ligt voorbij de toegestane klokspeling in de toekomst',
  VEROUDERD: 'tijdstempel is ouder dan de versheidsdrempel',
};

const TZ_AWARE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function freshnessVan(iso, { nowMs, staleMs, futureSkewMs }) {
  if (!iso) return { freshness: 'UNKNOWN', code: 'ONTBREEKT' };
  if (typeof iso !== 'string' || !TZ_AWARE.test(iso)) return { freshness: 'UNKNOWN', code: 'ONLEESBAAR' };
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { freshness: 'UNKNOWN', code: 'ONLEESBAAR' };
  if (t - nowMs > futureSkewMs) return { freshness: 'UNKNOWN', code: 'TOEKOMST' };
  if (nowMs - t > staleMs) return { freshness: 'STALE', code: 'VEROUDERD' };
  return { freshness: 'CURRENT', code: null };
}

export function parseCodeTickerFeed(raw, schema, { now = new Date(), staleMs = STALE_DREMPEL_MS, futureSkewMs = FUTURE_SKEW_MS } = {}) {
  const nowMs = now.getTime();
  const schemaErrors = validate(schema, raw);
  if (schemaErrors.length) {
    return { available: false, code: 'SCHEMA_ONBEKEND', freshness: 'UNKNOWN', generatedAt: null, entries: [] };
  }
  const { freshness, code } = freshnessVan(raw.generatedAt, { nowMs, staleMs, futureSkewMs });
  return {
    available: true,
    code,
    freshness,
    generatedAt: raw.generatedAt,
    entries: raw.entries,
  };
}
