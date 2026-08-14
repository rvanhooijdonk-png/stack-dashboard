/**
 * RUNTIME-FEED-ADAPTER — het strenge, fail-closed consumercontract voor de gesanitiseerde
 * runtimefeed die CODEX2 levert (control-plane: planner/watcher/supervisor, wachtrijen, actoren,
 * accounts). Deze module bouwt niet de cockpit — CODEX1 is de integrator. Ze doet precies twee
 * dingen: (1) het rauwe schema keuren (vorm — `data/runtime-feed.schema.json` via `validate.mjs`),
 * (2) de inhoud vertalen naar een vaste, veilige, gesloten-vocabulaire vorm die nooit meer data
 * beweert dan bewezen is.
 *
 * VIER TOESTANDEN, één gesloten lijst (`FRESHNESS`): CURRENT (bewezen vers), STALE (bewezen te
 * oud), UNKNOWN (geen betrouwbaar oordeel mogelijk — ontbrekend, onleesbaar of in de toekomst),
 * CONFLICT (twee bronnen binnen de feed spreken elkaar tegen). Nooit een vijfde waarde, nooit een
 * percentage dat op stilte is gebaseerd — zie `sanitize.mjs` se motto: liever geen dashboard dan
 * een dashboard dat iets verzint.
 *
 * TWEE STERKTES FAIL-CLOSED, zelfde onderscheid als `planning-bron.mjs`:
 *  - HARD (hele feed afgekeurd, `available:false`): het schema zelf klopt niet (vorm-afwijking,
 *    onbekend veld ergens in de boom). Dat betekent dat de feed iets anders is geworden dan dit
 *    contract verwacht — geen enkele regel is dan nog te vertrouwen.
 *  - ZACHT, twee niveaus:
 *      · RECORD-lokaal (één actor, één account, één wachtrij-regel): de fout blijft daar hangen
 *        (`findings` erbij, CONFLICT/UNKNOWN op dát veld), de rest van de feed blijft bruikbaar.
 *        Dit is de expliciete eis "één actorfout blijft actor-lokaal" veralgemeniseerd naar elk
 *        recordtype — een account met een tegenstrijdige status hoort niet de hele feed te doven.
 *      · IDENTITEIT (dubbele actor-ID, dubbele task-ID): geen van beide regels is meer uniek aan
 *        te wijzen, dus BEIDE betrokken regels krijgen CONFLICT — nooit één ervan stilzwijgend
 *        gekozen als "de echte".
 *
 * SANITIZE-GATE hergebruikt, niet herbouwd (`sanitize.mjs`). Elke vrije-tekstwaarde (control_host,
 * account-label, incident-notitie, boot_id, loaded_sha) gaat door `sanitizeString` vóór hij in de
 * uitvoer belandt — tokens, secret-achtige namen, absolute paden, e-mails en te lange tekst worden
 * daar al geredigeerd. Structurele ID's (actor_id, task_id, incident_id, account_id) worden op de
 * RAUWE waarde vergeleken voor dubbel-detectie (identiteit mag niet van redactie afhangen) en
 * daarna óók gesaneerd voor weergave — een ID kan evengoed een ingesmokkeld geheim dragen.
 *
 * WAT DEZE MODULE NIET DOET: geen bestand lezen, geen netwerkverkeer, geen render. Puur
 * data-in/data-out, zodat elke regel zonder fixture-bestand te testen is.
 */

import { validate, auditSchema } from './validate.mjs';
import { sanitizeString } from './sanitize.mjs';

/** Gesloten vocabulaire voor freshness. Geen vijfde waarde, nooit stilzwijgend uitgebreid. */
export const FRESHNESS = ['CURRENT', 'STALE', 'UNKNOWN', 'CONFLICT'];

/**
 * Hoe oud een heartbeat/tijdstempel mag zijn voordat hij STALE heet. Dit is een control-plane-feed
 * (planner/watcher/supervisor heartbeats, actor-heartbeats) — geen publicatieklok zoals
 * `waarnemer.mjs` se DREMPEL_UREN (15 uur, gebouwd rond twee vaste publicatiemomenten per dag).
 * Hier verwachten we een levend proces dat zichzelf met minuten-regelmaat meldt. Tien minuten is
 * een voorlopige, expliciet als zodanig gemarkeerde default: CODEX2's echte heartbeat-interval is
 * nog niet bevestigd. Elke caller kan `staleMs` overschrijven zodra dat interval bekend is —
 * dit is dus een parameter met een verdedigbare default, geen ingebakken aanname.
 */
export const STALE_DREMPEL_MS = 10 * 60 * 1000;

/**
 * Toegestane klokspeling vóór een tijdstempel als "in de toekomst" telt. Zelfde soort speling als
 * `waarnemer.mjs` se KLOKSPELING_MS, hier los gehouden omdat dit een ander soort klok bewaakt
 * (procesheartbeats, niet een publicatiestempel).
 */
export const FUTURE_SKEW_MS = 5 * 60 * 1000;

/** Elke code krijgt één zin in gewone taal — geen paden, geen waarden, alleen wat er is vastgesteld. */
export const CODES = {
  SCHEMA_ONBEKEND: 'de feed voldoet niet aan het vaste contract (onbekend veld of verkeerde vorm)',
  ONTBREEKT: 'geen tijdstempel aanwezig',
  ONLEESBAAR: 'tijdstempel is geen leesbare, zone-bewuste ISO-8601-waarde',
  TOEKOMST: 'tijdstempel ligt voorbij de toegestane klokspeling in de toekomst',
  VEROUDERD: 'tijdstempel is ouder dan de versheidsdrempel',
  DUBBELE_ACTOR_ID: 'twee of meer actoren delen dezelfde actor_id',
  DUBBELE_TASK_ID: 'twee of meer regels delen dezelfde task_id',
  NEGATIEVE_QUEUECOUNT: 'wachtrij-teller is negatief en is geweigerd',
  GEEN_WORKERSTART: 'taak heeft geen worker_started — geen bewijs van actief werk',
  GEEN_HEARTBEAT: 'taak heeft een worker_started maar nog geen last_heartbeat',
  HEARTBEAT_VOOR_START: 'last_heartbeat ligt niet aantoonbaar ná worker_started — geen bewijs van voortgang',
  STATUS_VERSUS_LAST_SEEN: 'zelfgerapporteerde status spreekt de gemeten versheid van last_seen tegen',
  GEEN_PICKUP: 'geen bewezen pickup — order/start alleen is geen bewijs van actief werk',
  ONGELDIGE_PICKUP_EVIDENCE: 'pickup claimt bewezen maar mist een geldige evidence_ref',
  ORDERED_PICKUP_UNPROVEN: 'taak is besteld/gestart maar de pickup is niet bewezen',
  PICKUP_ZONDER_START: 'pickup is bewezen maar er is geen geldige worker_started — geen bewijs van actief werk',
  PICKUP_TIJD_ONGELDIG: 'pickup is bewezen maar het claimtijdstip ontbreekt, is onleesbaar of ligt in de toekomst',
  PICKUP_VOOR_START: 'pickup-tijdstip ligt vóór worker_started — geen bewijs van deze taak',
  PICKUP_NA_HEARTBEAT: 'pickup-tijdstip ligt ná de laatste heartbeat — geen bewijs van huidige voortgang',
  ONGELDIGE_TERMINAL_ORDERING: 'afgeronde taak heeft een tijdsvolgorde die niet klopt (afgesloten vóór start) — status is niet te vertrouwen',
  GEEN_TERMINAL_RECEIPT: 'afgeronde taak claimt succes maar mist een geldig, onveranderlijk bewijskenmerk',
};

/** Gesloten vocabulaire voor het soort onveranderlijke bewijsverwijzing achter een claim. */
export const EVIDENCE_KINDS = ['RECEIPT_ID', 'ISSUE_COMMENT_ID', 'COMMIT_SHA', 'PR_NUMBER', 'EVENT_ID'];

/**
 * Per `kind` een eigen, onveranderlijke-referentievorm — B7: een gesloten `kind`-vocabulaire alleen
 * bewijst niets als élke niet-lege string als `ref` wordt geaccepteerd. Een branchnaam als "main" is
 * geen commit-SHA; een willekeurig woord is geen PR- of commentaar-ID. RECEIPT_ID/EVENT_ID hebben
 * geen extern canoniek formaat, dus krijgen ze een opaque-maar-ID-achtige vorm (geen spaties, geen
 * los woord) — en, zoals alle vijf soorten, mogen ze nooit een bekende MUTABLE gitref-naam zijn.
 */
const EVIDENCE_REF_SHAPE = {
  // PR69 B7 (Codex-correctie, herzien) — Codex signaleerde terecht dat een AFGEKORTE hex-SHA
  // (7-40 tekens) niet te onderscheiden is van een toevallig hex-achtige, muteerbare branch-/
  // tagnaam. De volle 40-teken SHA-1 zou dat sluiten (git weigert refs die ambigu zijn met een
  // volledige SHA), maar bleek onverenigbaar met bestaande, eerder gereviewde architectuur: élke
  // `ref`-waarde loopt via `sanitizeString` (zie modulekop) en die redigeert sinds de Gemini-
  // review van 23-07-2026 bewust élke losstaande 40+ tekens hoge-entropiestring naar
  // `[REDACTED]` (`sanitize.mjs` HIGH_ENTROPY, met expliciete toelichting dat de publieke DTO
  // geen volle SHA's meer draagt). Een eis van precies 40 hex-tekens maakt dus élk geldig
  // COMMIT_SHA-bewijs onherroepelijk `[REDACTED]` in de publieke cockpit — dat is een
  // architectuurwijziging aan de sanitize-gate, buiten de scope van deze correctie (alleen
  // B5/B6/B7). In plaats daarvan een proportionele verscherping binnen het bestaande bereik:
  // uitsluitend kleine letters (echte git-SHA-output is altijd lowercase; hoofdletters in een
  // hexreeks zijn een sterke aanwijzing voor een toevallige branch-/tagnaam, geen commit).
  COMMIT_SHA: /^[0-9a-f]{7,40}$/,
  ISSUE_COMMENT_ID: /^[1-9][0-9]{0,18}$/,
  PR_NUMBER: /^[1-9][0-9]{0,9}$/,
  RECEIPT_ID: /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/,
  EVENT_ID: /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/,
};

/** Bekende mutabele gitref-namen — nooit geldig als "onveranderlijke" bewijsverwijzing, ongeacht kind. */
const MUTABLE_REF_DENYLIST = new Set(['main', 'master', 'head', 'latest', 'trunk', 'develop', 'release', 'stable']);

/** Keurt zowel de vorm (gesloten `kind` + niet-lege `ref`) als de kind-specifieke, onveranderlijke referentievorm. */
function evidenceRefGeldig(ev) {
  if (!isObject(ev)) return false;
  if (typeof ev.kind !== 'string' || !EVIDENCE_KINDS.includes(ev.kind)) return false;
  if (typeof ev.ref !== 'string') return false;
  const ref = ev.ref.trim();
  if (ref.length === 0) return false;
  if (MUTABLE_REF_DENYLIST.has(ref.toLowerCase())) return false;
  const vorm = EVIDENCE_REF_SHAPE[ev.kind];
  return vorm ? vorm.test(ref) : false;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** ISO-8601 met verplichte, expliciete zone (Z of ±HH:MM) — "timestamps timezone-aware". */
const TZ_AWARE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const ISO_KALENDERDEEL = /^(\d{4})-(\d{2})-(\d{2})T/;

/**
 * PR69 B5 (Codex-correctie) — V8's `Date.parse` normaliseert een onmogelijke kalenderdatum in
 * plaats van hem te weigeren: "2026-02-30" rolt stilzwijgend door naar 2 maart. Zonder deze
 * check zou een pickup/heartbeat/worker_started-claim met een onbestaande datum alsnog een
 * geldig (verschoven) tijdstip opleveren — precies het soort claim dat deze module juist als
 * onleesbaar/ongeldig hoort te weigeren, niet stilzwijgend hoort te herstellen.
 */
function kalenderGeldig(value) {
  const m = ISO_KALENDERDEEL.exec(value);
  if (!m) return false;
  const jaar = Number(m[1]);
  const maand = Number(m[2]);
  const dag = Number(m[3]);
  const proef = new Date(Date.UTC(jaar, maand - 1, dag));
  return proef.getUTCFullYear() === jaar && proef.getUTCMonth() === maand - 1 && proef.getUTCDate() === dag;
}

/**
 * Ontleedt één tijdstempel-string. Geeft `null` terug bij ontbreken/onleesbaarheid — de caller zet
 * dat om in het juiste freshness-veld met de juiste code. Bewust géén naakte `new Date(string)` op
 * een string zonder zone: dat leest V8 stilzwijgend als lokale tijd of UTC afhankelijk van de
 * vorm, en precies dát vertekent "is dit vers" (zie ook `waarnemer.mjs` se ZONE_SPELING_MS-notitie
 * over diezelfde valkuil).
 */
function parseTijdstempel(value) {
  if (typeof value !== 'string' || !TZ_AWARE.test(value)) return null;
  if (!kalenderGeldig(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Berekent freshness voor één tijdstempelveld. `nowMs`/`staleMs`/`futureSkewMs` komen van de
 * caller zodat tests deterministisch zijn (geen `Date.now()` in deze module — zie ook de
 * workflow-beperking elders in deze sessie: geen impliciete klok in gedeeld-getest code).
 */
function freshnessVan(value, { nowMs, staleMs, futureSkewMs }) {
  if (value === null || value === undefined) return { state: 'UNKNOWN', code: 'ONTBREEKT', ms: null };
  const ms = parseTijdstempel(value);
  if (ms === null) return { state: 'UNKNOWN', code: 'ONLEESBAAR', ms: null };
  if (ms > nowMs + futureSkewMs) return { state: 'UNKNOWN', code: 'TOEKOMST', ms };
  if (nowMs - ms > staleMs) return { state: 'STALE', code: 'VEROUDERD', ms };
  return { state: 'CURRENT', code: null, ms };
}

/** Saneert één vrije-tekstwaarde voor weergave en verzamelt de bevinding-ID's (nooit de waarden). */
function weergave(value, path, findings) {
  if (typeof value !== 'string') return value;
  const { value: schoon, findings: f } = sanitizeString(value, { path });
  for (const fnd of f) findings.push({ code: 'SANITIZE', path: fnd.path, pattern: fnd.id });
  return schoon;
}

/**
 * Saneert een RUWE ID uitsluitend voor gebruik in diagnostische `path`-strings van findings — nooit
 * voor identiteit/dedup (die blijft op de rauwe waarde, zie moduledoc). Een actor_id/task_id kan
 * zelf een ingesmokkeld geheim of absoluut pad dragen, en `findings[].path` is onderdeel van de
 * gepubliceerde uitvoer — dus moet ook déze route door de SANITIZE-GATE.
 */
function veiligPad(value) {
  if (typeof value !== 'string') return String(value);
  return sanitizeString(value, { path: '' }).value;
}

function onbeschikbaar(reason) {
  return {
    available: false,
    reason,
    note: CODES[reason] ?? reason,
    measured_at: null,
    freshness: 'UNKNOWN',
    control_host: null,
    processes: { planner: null, watcher: null, supervisor: null },
    queue_counts: [],
    actors: [],
    accounts: [],
    summary: null,
    findings: [],
  };
}

function vertaalProcess(raw, naam, ctx, findings) {
  if (!isObject(raw)) return null;
  const hb = freshnessVan(raw.heartbeat, ctx);
  if (hb.code) findings.push({ code: hb.code, path: `processes.${naam}.heartbeat` });
  return {
    pid: Number.isInteger(raw.pid) ? raw.pid : null,
    boot_id: weergave(raw.boot_id, `processes.${naam}.boot_id`, findings),
    loaded_sha: weergave(raw.loaded_sha, `processes.${naam}.loaded_sha`, findings),
    heartbeat: { value: raw.heartbeat ?? null, freshness: hb.state },
  };
}

function vertaalQueueCounts(raw, findings) {
  return raw.map((q, i) => {
    if (typeof q.count !== 'number' || q.count < 0) {
      findings.push({ code: 'NEGATIEVE_QUEUECOUNT', path: `queue_counts[${i}]` });
      return { name: weergave(q.name, `queue_counts[${i}].name`, findings), count: null, valid: false };
    }
    return { name: weergave(q.name, `queue_counts[${i}].name`, findings), count: q.count, valid: true };
  });
}

/**
 * Beoordeelt de pickup-claim op een taak, los van worker_started/heartbeat. Een pickup is alleen
 * bewezen (`proven:true`) wanneer `proven===true` ÉN er een structureel geldige `evidence_ref` bij
 * zit (gesloten `kind`-vocabulaire + niet-lege `ref`) — een kale `proven:true` zonder bewijs is
 * evenveel waard als geen pickup. Ontbreekt het hele `pickup`-object (bv. oudere producer, feed die
 * dit veld nog niet vult), dan is dat GEEN_PICKUP, geen schemafout — het veld is bewust optioneel.
 */
function beoordeelPickup(raw) {
  if (!isObject(raw)) return { proven: false, code: 'GEEN_PICKUP', at: null, evidence_ref: null };
  if (raw.proven !== true) return { proven: false, code: 'GEEN_PICKUP', at: raw.at ?? null, evidence_ref: null };
  const ev = raw.evidence_ref;
  if (!evidenceRefGeldig(ev)) return { proven: false, code: 'ONGELDIGE_PICKUP_EVIDENCE', at: raw.at ?? null, evidence_ref: null };
  return { proven: true, code: null, at: raw.at ?? null, evidence_ref: ev };
}

/**
 * Actief werk vereist ALLEMAAL tegelijk: een geldige WORKER_STARTED, een expliciet bewezen pickup
 * (`pickup.proven===true` mét geldige evidence_ref), een verse heartbeat die aantoonbaar ná
 * worker_started ligt, en geen enkel van de tijdstempels onleesbaar/toekomstig. Order/start zonder
 * bewezen pickup is nooit actief werk — hoogstens "besteld, pickup onbewezen"
 * (`ORDERED_PICKUP_UNPROVEN`). Een bewezen pickup zonder geldige worker_started wordt evenmin actief
 * (`PICKUP_ZONDER_START`) — pickup-bewijs alleen bewijst geen huidige uitvoering.
 *
 * B5 — pickup.at is ZELF onderdeel van de bewijsketen, niet een kaal meegegeven veld: een bewezen
 * pickup met een ontbrekend/onleesbaar/toekomstig claimtijdstip (`PICKUP_TIJD_ONGELDIG`), een
 * claimtijdstip vóór worker_started (`PICKUP_VOOR_START`) of ná de laatste heartbeat
 * (`PICKUP_NA_HEARTBEAT`) is nooit bewijs van huidige actieve uitvoering — een expliciet
 * pickup-object bewijst dan wel dat er ÉÉN gebeurtenis geclaimd is, maar niet dat die gebeurtenis
 * ook werkelijk, op een aantoonbaar juist moment, bij DEZE taak hoorde.
 *
 * `hbFresh` komt van de caller (al berekend voor het `last_heartbeat`-veld) zodat hier niet twee keer
 * dezelfde freshness wordt bepaald. `ctx` (nowMs/futureSkewMs) is nodig om `pickup.at` met dezelfde
 * klok en dezelfde toekomst-speling te keuren als elk ander tijdstempel in dit contract.
 */
function beoordeelActiefWerk(task, hbFresh, ctx) {
  const pickup = beoordeelPickup(task.pickup);
  const startAanwezig = task.worker_started !== null && task.worker_started !== undefined;
  const start = startAanwezig ? parseTijdstempel(task.worker_started) : null;
  const startGeldig = start !== null;

  if (pickup.proven && !startGeldig) return { active: false, code: 'PICKUP_ZONDER_START', pickup };
  if (!pickup.proven) {
    if (startGeldig) return { active: false, code: 'ORDERED_PICKUP_UNPROVEN', pickup };
    return { active: false, code: startAanwezig ? 'ONLEESBAAR' : 'GEEN_WORKERSTART', pickup };
  }

  const pickupFresh = freshnessVan(pickup.at, ctx);
  if (pickupFresh.state === 'UNKNOWN') return { active: false, code: 'PICKUP_TIJD_ONGELDIG', pickup };
  if (pickupFresh.ms < start) return { active: false, code: 'PICKUP_VOOR_START', pickup };

  if (task.last_heartbeat === null || task.last_heartbeat === undefined) {
    return { active: false, code: 'GEEN_HEARTBEAT', pickup };
  }
  const hb = parseTijdstempel(task.last_heartbeat);
  if (hb === null) return { active: false, code: 'ONLEESBAAR', pickup };
  if (hb <= start) return { active: false, code: 'HEARTBEAT_VOOR_START', pickup };
  if (pickupFresh.ms > hb) return { active: false, code: 'PICKUP_NA_HEARTBEAT', pickup };
  if (hbFresh.state !== 'CURRENT') return { active: false, code: hbFresh.code ?? 'VEROUDERD', pickup };
  return { active: true, code: null, pickup };
}

/**
 * Beoordeelt één afgeronde taak (`closed[]`-regel). "AFGEROND OK" mag alleen verschijnen wanneer
 * ALLES tegelijk klopt: resultaat is OK, closed_at is een geldige (niet-toekomstige, leesbare)
 * tijdstempel, de volgorde na worker_started klopt (indien meegegeven — ontbreekt worker_started,
 * dan kan de volgorde niet bewezen worden en blijft OK dus onbewijsbaar), én er is een structureel
 * geldige, onveranderlijke `evidence_ref`. Ontbreekt één daarvan bij result:OK, dan is de weergave
 * "BEWIJS ONVOLLEDIG" — nooit stilzwijgend toch OK. FAILED/TIMEOUT/UNKNOWN claimen geen succes en
 * worden dus niet door dezelfde bewijs-eis tegengehouden. Een ongeldige tijdsvolgorde (afgesloten
 * vóór start, of een onleesbare/toekomstige closed_at) maakt ELK resultaat UNKNOWN — dat is een
 * signaal dat de regel zelf niet te vertrouwen is, los van welk resultaat hij claimt.
 */
function beoordeelAfgerondeTaak(raw, closedFresh) {
  const timeKnown = closedFresh.state === 'CURRENT' || closedFresh.state === 'STALE';
  if (!timeKnown) return { display: 'UNKNOWN', code: closedFresh.code };

  const closedMs = closedFresh.ms;
  let orderingKnown = false;
  let orderingOk = true;
  if (raw.worker_started !== null && raw.worker_started !== undefined) {
    const startMs = parseTijdstempel(raw.worker_started);
    orderingKnown = true;
    orderingOk = startMs !== null && closedMs > startMs;
  }
  if (orderingKnown && !orderingOk) return { display: 'UNKNOWN', code: 'ONGELDIGE_TERMINAL_ORDERING' };

  if (raw.result !== 'OK') return { display: raw.result, code: null };

  const evGeldig = evidenceRefGeldig(raw.evidence_ref);
  if (evGeldig && orderingKnown && orderingOk) return { display: 'OK', code: null };
  return { display: 'BEWIJS_ONVOLLEDIG', code: !evGeldig ? 'GEEN_TERMINAL_RECEIPT' : 'ONGELDIGE_TERMINAL_ORDERING' };
}

function vertaalActor(raw, ctx, findings, dubbeleActorIds, taskIdOccurrences) {
  const actorId = raw.actor_id;
  const actorPad = veiligPad(actorId);
  const isDubbeleId = dubbeleActorIds.has(actorId);
  if (isDubbeleId) findings.push({ code: 'DUBBELE_ACTOR_ID', path: `actors[actor_id=${JSON.stringify(actorPad)}]` });

  let currentTask = null;
  if (isObject(raw.current_task)) {
    const t = raw.current_task;
    const wsFresh = freshnessVan(t.worker_started, ctx);
    const hbFresh = freshnessVan(t.last_heartbeat, ctx);
    const oordeel = beoordeelActiefWerk(t, hbFresh, ctx);
    if (oordeel.code) findings.push({ code: oordeel.code, path: `actors[${actorPad}].current_task` });

    // task_id-conflict over de HELE feed: elk voorkomen van deze task_id — als lopende taak van
    // eender welke actor, of als closed-regel van eender welke actor — telt mee. Geteld op POSITIE
    // (elk current_task/closed-record apart), niet op actor_id: zo blijft de conflictdetectie
    // correct ook wanneer actor_id zelf al dubbel is (dan zou tellen-op-actor_id het gemis maskeren).
    const taskConflict = (taskIdOccurrences.get(t.task_id) ?? 0) > 1;
    if (taskConflict) findings.push({ code: 'DUBBELE_TASK_ID', path: `actors[${actorPad}].current_task.task_id` });

    currentTask = {
      task_id: weergave(t.task_id, `actors[${actorPad}].current_task.task_id`, findings),
      worker_started: { value: t.worker_started ?? null, freshness: wsFresh.state },
      last_heartbeat: { value: t.last_heartbeat ?? null, freshness: hbFresh.state },
      active: oordeel.active,
      active_reason: oordeel.code,
      identity: taskConflict ? 'CONFLICT' : 'OK',
      pickup: {
        proven: oordeel.pickup.proven,
        at: oordeel.pickup.at,
        evidence_ref: oordeel.pickup.evidence_ref
          ? {
              kind: oordeel.pickup.evidence_ref.kind,
              ref: weergave(oordeel.pickup.evidence_ref.ref, `actors[${actorPad}].current_task.pickup.evidence_ref.ref`, findings),
              url: weergave(oordeel.pickup.evidence_ref.url ?? null, `actors[${actorPad}].current_task.pickup.evidence_ref.url`, findings),
            }
          : null,
      },
    };
  }

  // Dubbele task_id in closed[]: zelfde globale telling als hierboven, dus ook gedekt: binnen
  // dezelfde actor, over meerdere actoren heen, én tegen een current_task elders. Geweigerde regels
  // worden apart geteld — de rest van de actor blijft bruikbaar.
  const closed = [];
  let closedGeweigerd = 0;
  for (const [i, c] of raw.closed.entries()) {
    if ((taskIdOccurrences.get(c.task_id) ?? 0) > 1) {
      findings.push({ code: 'DUBBELE_TASK_ID', path: `actors[${actorPad}].closed[${i}]` });
      closedGeweigerd += 1;
      continue;
    }
    const closedFresh = freshnessVan(c.closed_at, ctx);
    if (closedFresh.code) findings.push({ code: closedFresh.code, path: `actors[${actorPad}].closed[${i}].closed_at` });
    const oordeel = beoordeelAfgerondeTaak(c, closedFresh);
    if (oordeel.code) findings.push({ code: oordeel.code, path: `actors[${actorPad}].closed[${i}]` });
    const ev = c.evidence_ref;
    closed.push({
      task_id: weergave(c.task_id, `actors[${actorPad}].closed[${i}].task_id`, findings),
      closed_at: { value: c.closed_at ?? null, freshness: closedFresh.state },
      result: c.result,
      display_result: oordeel.display,
      display_reason: oordeel.code,
      worker_started: c.worker_started ?? null,
      evidence_ref: isObject(ev)
        ? {
            kind: ev.kind,
            ref: weergave(ev.ref, `actors[${actorPad}].closed[${i}].evidence_ref.ref`, findings),
            url: weergave(ev.url ?? null, `actors[${actorPad}].closed[${i}].evidence_ref.url`, findings),
          }
        : null,
    });
  }

  const incidents = raw.incidents.map((inc, i) => {
    const openedFresh = freshnessVan(inc.opened_at, ctx);
    if (openedFresh.code) findings.push({ code: openedFresh.code, path: `actors[${actorPad}].incidents[${i}].opened_at` });
    return {
      incident_id: weergave(inc.incident_id, `actors[${actorPad}].incidents[${i}].incident_id`, findings),
      opened_at: { value: inc.opened_at ?? null, freshness: openedFresh.state },
      severity: inc.severity,
      note: weergave(inc.note, `actors[${actorPad}].incidents[${i}].note`, findings),
    };
  });

  return {
    actor_id: weergave(actorId, `actors[actor_id]`, findings),
    identity: isDubbeleId ? 'CONFLICT' : 'OK',
    current_task: currentTask,
    closed,
    closed_geweigerd: closedGeweigerd,
    incidents,
  };
}

function vertaalAccount(raw, ctx, findings) {
  const accountPad = veiligPad(raw.account_id);
  const seenFresh = freshnessVan(raw.last_seen, ctx);
  if (seenFresh.code) findings.push({ code: seenFresh.code, path: `accounts[${accountPad}].last_seen` });
  // Een zelfgerapporteerde OK-status naast een aantoonbaar verouderde/toekomstige last_seen is een
  // tegenspraak binnen dezelfde regel — dat is precies waar CONFLICT voor bestaat, en blijft
  // record-lokaal: alleen déze account krijgt het label, de rest van de feed niet.
  const tegenstrijdig = raw.status === 'OK' && (seenFresh.state === 'STALE' || seenFresh.state === 'UNKNOWN');
  if (tegenstrijdig) findings.push({ code: 'STATUS_VERSUS_LAST_SEEN', path: `accounts[${accountPad}]` });
  return {
    account_id: weergave(raw.account_id, `accounts[account_id]`, findings),
    label: weergave(raw.label, `accounts[${accountPad}].label`, findings),
    status: tegenstrijdig ? 'CONFLICT' : raw.status,
    last_seen: { value: raw.last_seen ?? null, freshness: seenFresh.state },
  };
}

/**
 * Hoofdfunctie. `raw` is de reeds JSON-geparste feed (bestandslezen/netwerkverkeer is aan de
 * caller). `now`/`staleMs`/`futureSkewMs` zijn injecteerbaar zodat tests deterministisch zijn.
 * Gooit NOOIT — elke fout wordt een `{available:false, reason, ...}`-vorm met vaste velden, zodat
 * een aanroeper nooit een try/catch om deze functie hoeft te bouwen (zelfde patroon als
 * `vertaalBouwlijst` in `planning-bron.mjs`).
 */
export function parseRuntimeFeed(raw, { now = new Date(), staleMs = STALE_DREMPEL_MS, futureSkewMs = FUTURE_SKEW_MS } = {}) {
  if (!isObject(raw)) return onbeschikbaar('SCHEMA_ONBEKEND');

  const schemaFouten = validate(RUNTIME_FEED_SCHEMA, raw);
  if (schemaFouten.length > 0) {
    // Bewust GEEN foutdetails doorgeven: validate.mjs se enum-foutmelding bevat de aangetroffen
    // waarde zelf ("<waarde> staat niet in de enum"), en die waarde kan precies de hostile/secret-
    // achtige tekst zijn die deze module moet tegenhouden. Alleen het aantal wordt geteld.
    return { ...onbeschikbaar('SCHEMA_ONBEKEND'), note: `${CODES.SCHEMA_ONBEKEND} (${schemaFouten.length} schending(en))` };
  }

  const ctx = { nowMs: now.getTime(), staleMs, futureSkewMs };
  const findings = [];

  const actorIds = raw.actors.map((a) => a.actor_id);
  const actorIdCount = new Map();
  for (const id of actorIds) actorIdCount.set(id, (actorIdCount.get(id) ?? 0) + 1);
  const dubbeleActorIds = new Set([...actorIdCount].filter(([, n]) => n > 1).map(([id]) => id));

  // Eén globale telling per task_id over de HELE feed (current_task ÉN closed[], alle actoren
  // samen) — op POSITIE geteld, niet op actor_id, zodat een dubbele actor_id de detectie niet kan
  // maskeren (zie vertaalActor).
  const taskIdOccurrences = new Map();
  const telTaskId = (id) => taskIdOccurrences.set(id, (taskIdOccurrences.get(id) ?? 0) + 1);
  for (const a of raw.actors) {
    if (isObject(a.current_task)) telTaskId(a.current_task.task_id);
    for (const c of a.closed) telTaskId(c.task_id);
  }

  const measuredFresh = freshnessVan(raw.measured_at, ctx);
  if (measuredFresh.code) findings.push({ code: measuredFresh.code, path: 'measured_at' });

  const processes = {
    planner: vertaalProcess(raw.processes.planner, 'planner', ctx, findings),
    watcher: vertaalProcess(raw.processes.watcher, 'watcher', ctx, findings),
    supervisor: vertaalProcess(raw.processes.supervisor, 'supervisor', ctx, findings),
  };
  const queueCounts = vertaalQueueCounts(raw.queue_counts, findings);
  const actors = raw.actors.map((a) => vertaalActor(a, ctx, findings, dubbeleActorIds, taskIdOccurrences));
  const accounts = raw.accounts.map((a) => vertaalAccount(a, ctx, findings));

  const summary = {
    actors_totaal: actors.length,
    // "nooit 0% verzinnen": actief werk telt alleen mee als het bewezen is (active:true) OP EEN
    // ONDUBBELZINNIGE regel — een actor met een dubbele actor_id, of een taak met een dubbele
    // task_id (identity:'CONFLICT'), is per definitie niet meer uniek toe te wijzen en telt dus
    // niet mee als bewezen actief werk, ook al staat active:true op die regel.
    actors_actief: actors.filter(
      (a) => a.identity === 'OK' && a.current_task?.identity === 'OK' && a.current_task?.active === true,
    ).length,
    incidenten_open: actors.reduce((n, a) => n + a.incidents.length, 0),
    closed_ok: actors.reduce((n, a) => n + a.closed.filter((c) => c.result === 'OK').length, 0),
    closed_failed: actors.reduce((n, a) => n + a.closed.filter((c) => c.result === 'FAILED').length, 0),
    closed_unknown: actors.reduce((n, a) => n + a.closed.filter((c) => c.result === 'UNKNOWN').length, 0),
  };

  return {
    available: true,
    reason: null,
    note: null,
    measured_at: { value: raw.measured_at ?? null, freshness: measuredFresh.state },
    freshness: measuredFresh.state,
    control_host: weergave(raw.control_host, 'control_host', findings),
    processes,
    queue_counts: queueCounts,
    actors,
    accounts,
    summary,
    findings,
  };
}

/** Zelf-toets: het contract dat deze module afdwingt, moet ook zélf door `auditSchema` heen kunnen. */
export function auditRuntimeFeedSchema() {
  return auditSchema(RUNTIME_FEED_SCHEMA);
}

/**
 * Bevriest een object en al zijn geneste object/array-waarden. `validate()` leest bij elke aanroep
 * de LEVENDE `RUNTIME_FEED_SCHEMA`-referentie — zonder bevriezing zou in-process mutatie (bv.
 * `RUNTIME_FEED_SCHEMA.additionalProperties = true`) de fail-closed schemapoort stilzwijgend voor
 * de rest van het proces uitschakelen. Geen externe-data-aanvalsvector (de feed zelf kan dit niet
 * triggeren), maar wel een reële hardeningslacune in dezelfde procesruimte.
 */
function deepFreeze(obj) {
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val !== null && typeof val === 'object') deepFreeze(val);
  }
  return Object.freeze(obj);
}

/**
 * Het schema staat hier als JS-object-literaal (niet met readFileSync geladen) zodat deze module,
 * net als de rest van scripts/lib, geen bestandssysteemtoegang nodig heeft om te draaien —
 * testbaar met alleen een geparste JSON-waarde. Dit is bewust een DUPLICAAT van
 * `data/runtime-feed.schema.json`: `test/runtime-feed.test.mjs` toetst dat het bestand op de schijf
 * en dit object byte-voor-byte hetzelfde JSON opleveren, zodat de twee nooit uiteen kunnen lopen.
 */
export const RUNTIME_FEED_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'runtime-feed.schema.json',
  title: 'RuntimeFeedRawV1',
  description:
    "Gesanitiseerde runtimefeed die CODEX2 levert (control-plane: planner/watcher/supervisor, wachtrijen, actoren, accounts). Dit schema keurt uitsluitend de VORM van het contract — inhoudelijke regels (vervaldrempels, dubbele ID's, negatieve tellers, toekomstige tijdstempels, secret-achtige tekst) zitten in scripts/lib/runtime-feed.mjs, niet hier. Elk trefwoord buiten scripts/lib/validate.mjs se ondersteunde subset (zie het KNOWN-blok daar) is een schemafout, geen stilzwijgende no-op. additionalProperties: false staat overal — één onbekend veld ergens in de boom keurt de héle feed af (SCHEMA_ONBEKEND), precies zoals de startopdracht eist: \"onbekende velden fail-closed ... volgens één vast contract\".",
  type: 'object',
  additionalProperties: false,
  required: ['measured_at', 'control_host', 'processes', 'queue_counts', 'actors', 'accounts'],
  properties: {
    measured_at: {
      type: ['string', 'null'],
      description: 'ISO-8601-tijdstempel van de meting, met expliciete zone (Z of ±HH:MM). null = onbekend meetmoment (mag, wordt UNKNOWN).',
    },
    control_host: {
      type: ['string', 'null'],
      description: 'Opaque host-/machine-ID van de control-plane-machine. Geen hostname-validatie hier — vrije tekst gaat door de SANITIZE-GATE in runtime-feed.mjs.',
    },
    processes: {
      type: 'object',
      additionalProperties: false,
      required: ['planner', 'watcher', 'supervisor'],
      properties: {
        planner: { $ref: '#/$defs/Process' },
        watcher: { $ref: '#/$defs/Process' },
        supervisor: { $ref: '#/$defs/Process' },
      },
    },
    queue_counts: { type: 'array', items: { $ref: '#/$defs/QueueCount' } },
    actors: { type: 'array', items: { $ref: '#/$defs/Actor' } },
    accounts: { type: 'array', items: { $ref: '#/$defs/Account' } },
  },
  $defs: {
    Process: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['pid', 'boot_id', 'loaded_sha', 'heartbeat'],
      properties: {
        pid: { type: ['integer', 'null'] },
        boot_id: { type: ['string', 'null'] },
        loaded_sha: { type: ['string', 'null'] },
        heartbeat: { type: ['string', 'null'] },
      },
    },
    QueueCount: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'count'],
      properties: { name: { type: 'string' }, count: { type: 'integer' } },
    },
    CurrentTask: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['task_id', 'worker_started', 'last_heartbeat'],
      properties: {
        task_id: { type: 'string' },
        worker_started: { type: ['string', 'null'] },
        last_heartbeat: { type: ['string', 'null'] },
        pickup: { $ref: '#/$defs/Pickup' },
      },
    },
    ClosedResult: {
      type: 'object',
      additionalProperties: false,
      required: ['task_id', 'closed_at', 'result'],
      properties: {
        task_id: { type: 'string' },
        closed_at: { type: ['string', 'null'] },
        result: { type: 'string', enum: ['OK', 'FAILED', 'UNKNOWN', 'TIMEOUT'] },
        worker_started: { type: ['string', 'null'] },
        evidence_ref: { $ref: '#/$defs/EvidenceRef' },
      },
    },
    EvidenceRef: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['kind', 'ref'],
      properties: {
        kind: { type: 'string', enum: ['RECEIPT_ID', 'ISSUE_COMMENT_ID', 'COMMIT_SHA', 'PR_NUMBER', 'EVENT_ID'] },
        ref: { type: 'string' },
        url: { type: ['string', 'null'] },
      },
    },
    Pickup: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['proven', 'at', 'evidence_ref'],
      properties: {
        proven: { type: 'boolean' },
        at: { type: ['string', 'null'] },
        evidence_ref: { $ref: '#/$defs/EvidenceRef' },
      },
    },
    Incident: {
      type: 'object',
      additionalProperties: false,
      required: ['incident_id', 'opened_at', 'severity', 'note'],
      properties: {
        incident_id: { type: 'string' },
        opened_at: { type: ['string', 'null'] },
        severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
        note: { type: ['string', 'null'] },
      },
    },
    Actor: {
      type: 'object',
      additionalProperties: false,
      required: ['actor_id', 'current_task', 'closed', 'incidents'],
      properties: {
        actor_id: { type: 'string' },
        current_task: { $ref: '#/$defs/CurrentTask' },
        closed: { type: 'array', items: { $ref: '#/$defs/ClosedResult' } },
        incidents: { type: 'array', items: { $ref: '#/$defs/Incident' } },
      },
    },
    Account: {
      type: 'object',
      additionalProperties: false,
      required: ['account_id', 'label', 'status', 'last_seen'],
      properties: {
        account_id: { type: 'string' },
        label: { type: ['string', 'null'] },
        status: { type: 'string', enum: ['OK', 'DEGRADED', 'DOWN', 'UNKNOWN'] },
        last_seen: { type: ['string', 'null'] },
      },
    },
  },
};

deepFreeze(RUNTIME_FEED_SCHEMA);
