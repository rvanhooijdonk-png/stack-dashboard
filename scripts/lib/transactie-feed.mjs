/**
 * TRANSACTIE-FEED-ADAPTER — fail-closed consumercontract voor de event-feed die een lokale
 * generator op Stack-Director publiceert (dispatcher-runs, taak-transities, health-metingen,
 * git-events) naar `CONTROL/FEEDS/transactie-feed.json` op de `dashboard-feeds`-branch van
 * stack-control (zelfde branch-patroon als AFSPRAKEN.md/rapporten — nooit main). Deze repo leest
 * dat bestand via de contents-API op buildtijd (`collectTransactieFeedRaw()` in collect.mjs).
 *
 * Anders dan `runtime-feed.mjs`: die feed komt van een externe, adversariale actor-laag met
 * meerdere gelijktijdige schrijvers (vandaar de CONFLICT-identiteitslogica bij dubbele actor-/
 * task-ID's). Deze feed heeft precies één schrijver (de lokale generator), events dragen geen
 * eigen identiteit die kan botsen, en het bestand ligt al in git — er is dus geen `--flag`-inname
 * en geen last-known-good-cache nodig. Wat overblijft van dat patroon: schema keuren via
 * `validate.mjs`, gesloten FRESHNESS-vocabulaire, en de sanitize-gate hergebruikt (niet herbouwd)
 * als tweede, onafhankelijke poort bovenop de generator-eigen sanering (de generator draait
 * dezelfde `parseTransactieFeed()` vóór elke publicatie; deze module is dus poort 1 én poort 2).
 *
 * WAT DEZE MODULE NIET DOET: geen bestand lezen, geen render. Puur data-in/data-out.
 */

import { validate } from './validate.mjs';

export const FRESHNESS = ['CURRENT', 'STALE', 'UNKNOWN'];

/**
 * Niet gekoppeld aan het lokale generator-ritme — gekoppeld aan de bottleneck: de site herbouwt
 * hoogstens elke ~15 min (`REFRESH_SECONDS`/de bestaande publish-cadans van `dashboard-heartbeat.sh`
 * + `publish.yml`). 3× die cadans, conform de "klok >3× interval = ROOD"-regel uit de order.
 */
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

/**
 * Vertaalt de rauwe, geschema-valideerde feed naar de vorm die de renderer gebruikt: een
 * beschikbaarheidsvlag, de afgeleide freshness van het generatormoment, en de events zelf
 * (al gesloten-vocabulair per schema — hier geen tweede vertaalslag nodig).
 */
export function parseTransactieFeed(raw, schema, { now = new Date(), staleMs = STALE_DREMPEL_MS, futureSkewMs = FUTURE_SKEW_MS } = {}) {
  const nowMs = now.getTime();
  const schemaErrors = validate(schema, raw);
  if (schemaErrors.length) {
    return { available: false, code: 'SCHEMA_ONBEKEND', freshness: 'UNKNOWN', generatedAt: null, events: [] };
  }
  const { freshness, code } = freshnessVan(raw.generatedAt, { nowMs, staleMs, futureSkewMs });
  return {
    available: true,
    code,
    freshness,
    generatedAt: raw.generatedAt,
    events: raw.events,
  };
}
