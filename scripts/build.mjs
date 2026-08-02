#!/usr/bin/env node
/**
 * BUILD — verzamel, reduceer, saneer, render. In die volgorde, zonder uitzondering.
 *
 *   node scripts/build.mjs [--out public] [--fixture data/fixture.json] [--no-strict]
 *
 * Belangrijkste ontwerpbesluit na de review van 23-07-2026: de volledige snapshot wordt
 * **niet** gepubliceerd. Er gaat één expliciet samengestelde publieke DTO naar de renderer;
 * alles wat daar niet in staat, verlaat deze machine niet. De interne snapshot blijft in
 * `.local/` (niet in de Pages-artefact, niet in git).
 */

import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertPublishable, loadDenyTerms } from './lib/sanitize.mjs';
import { renderHtml } from './lib/render.mjs';
import { renderCockpit } from './lib/render-cockpit.mjs';
import { validate } from './lib/validate.mjs';
import { toPublicPlanning } from './lib/planning.mjs';
import { vertaalBouwlijst } from './lib/planning-bron.mjs';
import { kanaalpostUitTekst, toPublicKanaalpost, toPublicGates } from './lib/kanaalpost.mjs';
import { VLOOT_ONBEKEND_MINUTEN, toPublicVlootstand, vlootstand as vlootstandVan } from './lib/doorstroom.mjs';
import { LANES } from './lib/kijk.mjs';
import {
  collectPullRequests, collectMergedRecent, collectTracker,
  collectDecisions, collectTracks, collectLogbook, collectCi, collectBouwlijst,
  collectAfspraken,
  setPublicRepos, setPublicTracks,
  CATEGORIEEN,
} from './lib/collect.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 2.0.0: de derde review sloopte velden uit het contract (evidence.source, vrije tekst).
 * 2.1.0: vloot → tracks (klaar-rapport-leeftijd) + afgeleid categorielabel op besluiten/beslispunten.
 * 2.2.0: planning-plaat (bouwlijst met status + op throughput herrekende oplevering + kanaalpost).
 *        Planning staat bewust NIET in `sources`: een lege/corrupte bouwlijst degradeert de hele
 *        pagina niet, hij toont zijn eigen nette melding (fail-closed per sectie).
 * 2.3.0: de plaat leest de ECHTE bouwlijst — TRECHTER's backlog-feed, gespiegeld op de rapporten-branch
 *        en via `planning-bron.mjs` vertaald naar het §B-schema. Nieuw in het contract: `planning.bron`
 *        (herkomst + spiegelleeftijd), `counters.gepland` en per feature `tier0` + `duurIndicatie`.
 *        Overbrugging tot er een echte execution-queue-export in §B-vorm is; daarom staat alles op
 *        `gepland` en blijft de rol leeg — een backlog weet niet wat er draait.
 * 2.4.0: kanaalpost wordt een eigen sectie met een eigen bron: de publieke spiegel
 *        `data/kanaalpost-publiek.md`, waar élk venster van de vloot in meldt. Tot 2.3.0 hing de
 *        kanaalpost aan de bouwlijst en toonde de plaat dus alleen de meldingen van dit venster —
 *        een lege bouwlijst nam dan de post van de hele vloot mee. Daarom is `planning.kanaalpost`
 *        vervallen: één bron, geen tweede stille route.
 * 2.5.0: vlootstand — welk venster WERKT, LEEG staat of ONBEKEND is. De spiegel toont afrondingen;
 *        wie niets meldt kwam daar per definitie niet in voor, dus was leegstand alleen te zien door
 *        zelf de tabs af te lopen. Afgeleid uit dezelfde spiegel (geen tweede bron) en bewust NIET
 *        erin geschreven: het logboek is append-only, en een kop die je bijwerkt wist de vorige.
 * 2.6.0: afsprakenspoor — CONTROL/AFSPRAKEN.md (privé stack-control), tweede spoor naast de
 *        vlootstand-hartslag (REGIE-besluit 30-07-2026). Strenger dan tracker/decisions/logbook:
 *        geen `publish-text.json`-schakelaar en geen `entries`-veld — de afspraaktekst zelf, de
 *        ID's en de bewijsverwijzingen zijn onvoorwaardelijk intern. Publiek blijft alleen de
 *        structuur: tellers per status (gesloten enum) en het tijdstip van de laatste
 *        bestandswijziging. De volledige laatste-5 staat alleen in `.local/snapshot.json`.
 * 2.7.0: gates — de kanaalpost-rijen die Richard als actiehouder noemen, gelezen over de HELE spiegel
 *        in plaats van over het venster van vijftien dat `kanaalpost` toont. Zelfde bron en zelfde
 *        publicatiepoort, ander venster: een gate veroudert niet vanzelf, hij blijft staan tot hij
 *        gesloten wordt, en schoof daardoor stil uit beeld (gemeten 01-08-2026: 4 van de 4 rijen
 *        onder *Wacht op Richard* waren zelfalarm van de automatische controle, 0 echte gates).
 */
const CONTRACT_VERSION = '2.7.0';
const REFRESH_SECONDS = 900;
/** Een titel is een naam, geen alinea. Langer = iemand plakt iets waar het niet hoort. */
const MAX_TITLE = 80;
/** Een raming is een duur. Alles wat daar niet op lijkt is status- of proza-tekst. */
const ESTIMATE_RE = /^(?:\d{1,3}(?:[.,]\d)?(?:\s*[–-]\s*\d{1,3}(?:[.,]\d)?)?\s*)?(?:minuten|minuut|min|uren|uur|dagen|dag|weken|week)$/i;
/** Een workstreamnummer is een nummer. Zie `publicWorkstream()` — dit was een bewezen lek. */
const WORKSTREAM_ID_RE = /^\d{2}$/;

/**
 * De publieke foutmelding is een code uit een gesloten lijst, nooit de tekst van de collector.
 * Vierde review (Codex + Gemini, 23-07-2026): `evidence.error` ging ongefilterd mee en werd
 * gerenderd. De probe `"Project Saffier staat in CONTROL/KLANTEN/Zephyr.md"` passeerde sanitize
 * én contract met nul bevindingen. Een foutmelding is vrije tekst zodra er een uitzondering in
 * belandt — en vrije tekst gaat er niet in. De code volgt hier uit `trust`, zodat er geen enkele
 * route van collectortekst naar de pagina overblijft; de volledige melding staat in `.local/`.
 */
const ERROR_CODE_BY_TRUST = {
  VERIFIED_CURRENT: null,
  STALE: 'VEROUDERD',
  UNVERIFIED: 'NIET_GEVERIFIEERD',
  SOURCE_UNAVAILABLE: 'BRON_ONBEREIKBAAR',
  CONFLICTING_EVIDENCE: 'TEGENSTRIJDIG',
};

/**
 * Precies deze bestanden mogen gepubliceerd worden. Niets anders.
 * `index.html` is sinds de cockpit-ombouw (REGIE-3, 2026-07-30) het 10-secondenbord;
 * `contentstroom.html` is de vaste doorstroom-plaat die tot dan de voorpagina was — volledig
 * behouden, alleen verhuisd naar een eigen tab. `.github/workflows/publish.yml` heeft een eigen,
 * hard-coded CI-poort met dezelfde lijst; die moet in lockstep meegroeien.
 */
const PUBLISH_ALLOWLIST = ['index.html', 'contentstroom.html', 'status.json', '.nojekyll'];

/** Vaste, niet-brongebonden navigatie tussen de twee publieke pagina's. Geen sanitize-oppervlak. */
const NAV_NAAR_CONTENTSTROOM = '<nav class="pagenav"><a href="./contentstroom.html">Contentstroom — de volledige doorstroom-plaat →</a></nav>';
const NAV_NAAR_COCKPIT = '<nav class="pagenav"><a href="./">← terug naar de cockpit</a></nav>';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const readJson = async (p, fallback) => {
  try { return JSON.parse(await readFile(join(ROOT, p), 'utf8')); } catch { return fallback; }
};

/** Rauwe tekst uit de repo. Onleesbaar ⇒ lege string: de sectie die hem leest is fail-closed. */
const readText = async (p) => {
  try { return await readFile(join(ROOT, p), 'utf8'); } catch { return ''; }
};

/**
 * Standaardbeleid voor vrije tekst: niets. Zie `data/publish-text.json` en de probe die dit
 * afdwong (Codex, 23-07-2026): "Project Saffier: overname van klant Zephyr gaat vrijdag live"
 * passeerde elke gate en stond gewoon op de pagina. Geen enkel patroon herkent zoiets — dus
 * gaat de tekst er standaard niet in, en draagt de structuur eromheen de status.
 */
const TEXT_OFF = { trackerUpdates: false, trackerDecisionPoints: false, decisions: false, logbook: false };

/**
 * Lees het tekstbeleid streng. `"false"` is een string en dus truthy — een tikfout in JSON zou
 * onder een losse truthiness-check de hele sectie openzetten (bewezen probe, Codex 23-07-2026).
 * Daarom: alleen bekende sleutels, alleen echte booleans, anders breekt de build af.
 */
export function readTextPolicy(input = {}) {
  // Een root die geen object is (`true`, `1`, `null`) werd stilzwijgend als "alles uit" gelezen —
  // het juiste resultaat om de verkeerde reden, en dus geen strikte parsing. Nu breekt het.
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`publish-text.json: verwacht een object, kreeg ${input === null ? 'null' : typeof input}`);
  }
  const policy = { ...TEXT_OFF };
  for (const [key, value] of Object.entries(input)) {
    if (key.startsWith('_')) continue;
    // `key in TEXT_OFF` liet `toString`, `constructor` en `__proto__` door als bekende sleutel.
    if (!Object.hasOwn(TEXT_OFF, key)) throw new Error(`publish-text.json: onbekende sleutel "${key}"`);
    if (typeof value !== 'boolean') throw new Error(`publish-text.json: "${key}" moet true of false zijn, geen ${typeof value}`);
    policy[key] = value;
  }
  return policy;
}

/**
 * Roadmapregel: publiceren is een expliciete boolean per regel, de titel is een naam en de
 * raming is een duur. Voldoet iets daar niet aan, dan valt die regel terug op alleen zijn nummer.
 *
 * Het nummer zelf was het volgende lek (Codex, vierde review): titel en raming werden keurig
 * ingehouden, maar `String(w.id)` publiceerde élke waarde — de probe zette een klantnaam in `id`
 * en die stond op de pagina. Een id is nu een tweecijferig nummer of de build stopt. Terugvallen
 * op een placeholder kan niet: het nummer is waar de regel aan hangt. De melding noemt de
 * afgekeurde waarde bewust níét — een CI-log van een openbare repo is zelf openbaar.
 */
function publicWorkstream(w, index) {
  const id = String(w.id);
  if (!WORKSTREAM_ID_RE.test(id)) {
    throw new Error(`workstreams.json: regel ${index + 1} heeft geen tweecijferig nummer als id`);
  }
  const open = w.public === true;
  const title = open && typeof w.title === 'string' && w.title.length <= MAX_TITLE ? w.title : null;
  const estimate = open && typeof w.estimate === 'string' && ESTIMATE_RE.test(w.estimate.trim())
    ? w.estimate.trim() : null;
  return { id, title, estimate };
}

/**
 * Reduceer de interne snapshot tot wat de pagina toont — veld voor veld, met de hand.
 * Er is bewust geen spread: een nieuw veld in een collector verschijnt hier niet vanzelf.
 */
export function toPublicSnapshot(raw, textPolicy = {}) {
  const t = readTextPolicy(textPolicy);
  /** Vrije tekst komt er alleen in als iemand die sectie expliciet heeft vrijgegeven. */
  const text = (allowed, value) => (allowed ? value : null);
  // `source` is een intern bronpad ("stack-control / AUDIT-INPUT/…") en gaat er niet in:
  // op een openbare pagina is het pad zelf een aanwijzing. De sectiekop zegt genoeg.
  // `error` gaat er evenmin in — zie ERROR_CODE_BY_TRUST. De code wordt afgeleid, niet gekopieerd.
  // Ook `trust` wordt niet blind gekopieerd. Codex zette in de vijfde ronde een klantnaam ín de
  // trust-waarde; die kwam zo de DTO in en werd pas door de contract-gate gestopt. Eén gate is
  // geen gate: een waarde die niet in de gesloten lijst staat, breekt de build hier al.
  const trustOf = (e) => {
    if (!Object.hasOwn(ERROR_CODE_BY_TRUST, e.trust)) {
      throw new Error('een bron leverde een trust-waarde die niet in de gesloten lijst staat');
    }
    return e.trust;
  };
  // Het categorielabel is afgeleid (nooit brontekst), maar hetzelfde gesloten-lijst-principe geldt:
  // een categorie buiten de vaste woordenschat is een categorie waar niemand naar keek. Die breekt
  // de build hier al, net als een onbekende trust-waarde — één losse waarde is geen gate.
  const categoryOf = (item) => {
    if (!CATEGORIEEN.includes(item.category)) {
      throw new Error('een bron leverde een categorie die niet in de gesloten lijst staat');
    }
    return item.category;
  };
  // Een track-telling en zijn datum moeten samen kloppen: geen rapport ⇒ geen datum, en omgekeerd.
  // Zo kan een bron geen "0 rapporten" met tóch een (groene) datum de pagina op sturen — fail-closed
  // op dezelfde manier als de trust- en categorie-poort. De sectie-rollup zelf blijft, net als bij
  // álle andere bronnen, het oordeel van de collector (evidence.trust); tracks krijgen geen aparte
  // herberekening die de overige zes secties niet ook hebben.
  const trackOf = (x) => {
    if ((x.reportCount === 0) !== (x.lastReportAt === null)) {
      throw new Error('een track meldt een rapporttelling die niet strookt met de rapportdatum');
    }
    return { track: x.track, lastReportAt: x.lastReportAt, reportCount: x.reportCount, trust: trustOf(x) };
  };
  const ev = (e) => ({
    retrievedAt: e.retrievedAt,
    trust: trustOf(e),
    errorCode: ERROR_CODE_BY_TRUST[e.trust],
  });

  // Rijentelling per bron (27-07-2026). Een lezer die rijen laat vallen zag er tot vandaag uit als
  // een bron die niets nieuws had; `herkend < inBron` maakt dat verschil meetbaar — en `doorstroom`
  // maakt er ROOD van. Alleen getallen, dus veilig in de publieke `status.json`.
  const rijenVan = (bron) => {
    const r = bron?.rijen;
    return r && [r.inBron, r.herkend, r.getoond, r.afgekapt].every((n) => Number.isInteger(n) && n >= 0)
      ? {
        inBron: r.inBron, herkend: r.herkend, getoond: r.getoond, afgekapt: r.afgekapt,
      }
      : null;
  };
  const sources = ['pullRequests', 'merged', 'tracker', 'decisions', 'tracks', 'logbook', 'ci', 'afspraken']
    .map((key) => ({
      key,
      trust: trustOf(raw[key].evidence),
      retrievedAt: raw[key].evidence.retrievedAt,
      rijen: rijenVan(raw[key]),
    }));

  return {
    contractVersion: CONTRACT_VERSION,
    generatedAt: raw.generatedAt,
    overallStatus: sources.every((s) => s.trust === 'VERIFIED_CURRENT') ? 'OK' : 'DEGRADED',
    sources,
    // De oplevering wordt herrekend op het bouwmoment (`raw.generatedAt`) + de gemeten doorlooptijd
    // uit het THROUGHPUT-LOG dat in de bouwlijst zit — geen tweede meetsysteem. Planning is geen
    // `sources`-bron: fail-closed op deze sectie neemt de rest van de pagina niet mee.
    planning: toPublicPlanning(raw.planning, raw.generatedAt),
    // Vloot-breed doorgeefluik, zelfde fail-closed-per-sectie-regel als planning: geen `sources`-bron,
    // dus een onleesbare spiegel degradeert de rest van de pagina niet.
    kanaalpost: toPublicKanaalpost(raw.kanaalpost),
    // Zelfde bron als `kanaalpost`, zelfde publicatiepoort, ANDER venster: alle rijen in plaats van de
    // laatste vijftien. Een gate wacht tot hij gesloten wordt en mag dus niet uit beeld verouderen.
    gates: toPublicGates(raw.kanaalpost),
    // Zelfde fail-closed-per-sectie-regel: een onleesbare spiegel maakt deze sectie onbeschikbaar met
    // een nette melding en laat de rest van de pagina staan.
    vlootstand: toPublicVlootstand(raw.vlootstand),
    workstreams: raw.workstreams.map((w, i) => publicWorkstream(w, i)),
    pullRequests: {
      available: raw.pullRequests.available,
      repositories: raw.pullRequests.repositories.map((r) => ({
        repository: r.repository, open: r.open, draft: r.draft, ready: r.ready,
      })),
      hiddenRepositories: raw.pullRequests.hiddenRepositories ?? 0,
      totals: raw.pullRequests.totals,
      evidence: ev(raw.pullRequests.evidence),
    },
    merged: {
      available: raw.merged.available,
      windowDays: raw.merged.windowDays,
      count: raw.merged.count,
      byRepository: raw.merged.byRepository.map((r) => ({ repository: r.repository, merged: r.merged })),
      evidence: ev(raw.merged.evidence),
    },
    tracker: {
      available: raw.tracker.available,
      // Twee schakelaars, twee vlaggen. Eén gecombineerde vlag beweerde "alle titels verborgen"
      // terwijl er een halve sectie wél tekst toonde.
      updatesTextWithheld: !t.trackerUpdates,
      decisionPointsTextWithheld: !t.trackerDecisionPoints,
      updates: raw.tracker.updates.map((u) => ({
        number: u.number, date: u.date, title: text(t.trackerUpdates, u.title),
      })),
      // Het categorielabel is afgeleid uit de interne tekst en mag wél mee — het is geen brontekst
      // maar een gesloten-lijst-classificatie. De titel blijft achter de tekst-schakelaar.
      decisionPoints: raw.tracker.decisionPoints.map((d) => ({
        id: d.id, title: text(t.trackerDecisionPoints, d.title), category: categoryOf(d),
      })),
      evidence: ev(raw.tracker.evidence),
    },
    decisions: {
      available: raw.decisions.available,
      textWithheld: !t.decisions,
      entries: raw.decisions.entries.map((e) => ({
        id: e.id, date: e.date, decision: text(t.decisions, e.decision), category: categoryOf(e),
      })),
      evidence: ev(raw.decisions.evidence),
    },
    tracks: {
      available: raw.tracks.available,
      // Geen bestandsnaam, alleen de afgeleide rapport-leeftijd per track. `trackOf` valideert de
      // gesloten trust-lijst én de telling↔datum-samenhang; een track kan `lastReportAt: null` hebben
      // (geen bewijs = geen vers), maar dan móét de telling 0 zijn.
      tracks: raw.tracks.tracks.map(trackOf),
      evidence: ev(raw.tracks.evidence),
    },
    logbook: {
      available: raw.logbook.available,
      textWithheld: !t.logbook,
      entries: raw.logbook.entries.map((e) => ({ title: text(t.logbook, e.title) })),
      evidence: ev(raw.logbook.evidence),
    },
    ci: {
      available: raw.ci.available,
      lights: raw.ci.lights.map((l) => ({ repository: l.repository, state: l.state, at: l.at })),
      hiddenCiRepositories: raw.ci.hiddenCiRepositories ?? 0,
      evidence: ev(raw.ci.evidence),
    },
    // AFSPRAKENSPOOR (REGIE-besluit 30-07-2026): geen `entries`, geen tekst-schakelaar — strenger
    // dan tracker/decisions/logbook hierboven. `statusCounts` wordt hier met de hand overgenomen,
    // veld voor veld uit de gesloten lijst in collect.mjs, precies zoals de rest van deze functie
    // nooit spreadt: een toekomstige zesde status in de bron verschijnt hier niet vanzelf.
    afspraken: {
      available: raw.afspraken.available,
      statusCounts: {
        VASTGELEGD: raw.afspraken.statusCounts.VASTGELEGD,
        UITGEZET: raw.afspraken.statusCounts.UITGEZET,
        'IN BOUW': raw.afspraken.statusCounts['IN BOUW'],
        VERWERKT: raw.afspraken.statusCounts.VERWERKT,
        STAAND: raw.afspraken.statusCounts.STAAND,
      },
      lastChangedAt: raw.afspraken.lastChangedAt,
      evidence: ev(raw.afspraken.evidence),
    },
  };
}

/**
 * Vertaalt de bouwlijst-collectorrespons naar de interne planning-sectie. Los van `buildSnapshot()`
 * zodat dit zonder netwerk te toetsen is (zelfde patroon als `decodeContentsResponse`).
 *
 * Bevinding Codex-review 28-07-2026 (W-41-vervolg, too_large-check): `collectBouwlijst()` geeft
 * sinds vandaag `tooLarge`/`size` terug, maar deze functie zag voorheen alleen `.text` — een te
 * grote bron werd zo ononderscheidbaar van een lege, óók in de interne snapshot, niet alleen op de
 * plaat. Het publieke contract kent nog geen derde stand naast LEEG/CORRUPT (dat is het
 * `NOOIT_GEMETEN`-voorstel, wacht op Richards akkoord) — tot dan blijft de plaat zelf LEEG tonen,
 * maar het signaal verdwijnt hier niet meer stil: het gaat naar de build-log (zelfde `console.warn`-
 * patroon als de sanitize-bevindingen hieronder) en blijft op het interne planning-object staan.
 */
export function planningFromBouwlijst(bouwlijst) {
  if (bouwlijst?.tooLarge) {
    console.warn(`bouwlijst: bron is te groot om te lezen (±1MB-grens contents-API, grootte ${bouwlijst.size ?? 'onbekend'} bytes) — plaat toont LEEG, dit is een grens, geen storing`);
  }
  const planning = vertaalBouwlijst(bouwlijst?.text ?? '');
  // Het spiegelmoment hoort bij de HERKOMST, niet bij de vertaling: de vertaler kent alleen de tekst.
  if (planning.bron) planning.bron.spiegelAt = bouwlijst?.spiegelAt ?? null;
  // Niet in het publieke contract (toPublicPlanning bouwt zijn eigen sleutels, kopieert dit niet mee)
  // — puur voor wie de interne snapshot leest of logt, zodat "te groot" hier vindbaar blijft.
  planning.bronTooLarge = bouwlijst?.tooLarge === true;
  planning.bronSize = bouwlijst?.size ?? null;
  return planning;
}

/**
 * Er is één weg naar publicatie. De vorige `--fixture`-modus sloeg `toPublicSnapshot()` over en
 * schreef een bestand rechtstreeks naar `public/` — een tweede, ongecontroleerde publicatiebuild
 * (bewezen probe, Codex 23-07-2026). Die modus is weg; fixtures dienen de tests, niet de output.
 */
export async function buildSnapshot() {
  setPublicRepos(await readJson('data/public-repos.json', []));
  setPublicTracks((await readJson('data/public-tracks.json', {})).tracks ?? []);
  const workstreams = (await readJson('data/workstreams.json', {})).workstreams ?? [];
  const ciRepos = await readJson('data/ci-repos.json', ['stack-control']);
  const [pullRequests, merged, tracker, decisions, tracks, logbook, ci, bouwlijst, afspraken] = await Promise.all([
    collectPullRequests(), collectMergedRecent(7), collectTracker(),
    collectDecisions(), collectTracks(), collectLogbook(), collectCi(ciRepos), collectBouwlijst(),
    collectAfspraken(),
  ]);

  // De bouwlijst komt uit de SPIEGEL op de rapporten-branch en gaat door de vertaler (backlog → §B).
  // Fail-closed en zonder terugval op het oude voorbeeldbestand: onleesbaar of onvertaalbaar wordt
  // LEEG/CORRUPT met een nette melding op de plaat. Vijf verzonnen features tonen omdat de echte bron
  // even niet leesbaar is, zou de plaat laten liegen — en de plaat is er juist tegen dat misverstand.
  const planning = planningFromBouwlijst(bouwlijst);

  // De vloot-kanaalpost komt uit de publieke spiegel in DEZE repo, niet uit het interne logboek op de
  // rapporten-branch: wat de plaat toont, hoort bij de commit die hem publiceerde, en de bron is al
  // voor publiek geschreven. Ontbreekt of hapert het bestand, dan meldt de sectie dat zelf.
  const spiegelTekst = await readText('data/kanaalpost-publiek.md');
  const kanaalpost = kanaalpostUitTekst(spiegelTekst);

  // De VLOOTSTAND komt uit dezelfde spiegel, maar beantwoordt de omgekeerde vraag: niet "wat is er
  // afgerond" maar "wie zwijgt". Die stand wordt hier AFGELEID en nergens ingeschreven — de spiegel
  // is append-only, dus een kop die elke ronde herschreven wordt kan er niet in staan. De vensterlijst
  // is `LANES`, dezelfde gesloten lijst die de kijk gebruikt; `data/vloot.json` mag er alleen ROLLEN
  // bij zetten en bepaalt niet wie meetelt. Ontbreekt dat bestand, dan blijft de rol leeg: een rol
  // verzinnen zou een omschrijving op de openbare plaat zetten die niemand heeft vastgesteld.
  const rollen = await readJson('data/vloot.json', {});
  const vlootstand = {
    bronOk: typeof spiegelTekst === 'string' && spiegelTekst.length > 0,
    grensMinuten: VLOOT_ONBEKEND_MINUTEN,
    standen: vlootstandVan(spiegelTekst ?? '', {
      vensters: LANES.map((venster) => ({ venster, rol: rollen?.[venster] ?? null })),
    }),
  };

  return {
    generatedAt: new Date().toISOString(),
    workstreams,
    planning,
    kanaalpost,
    vlootstand,
    pullRequests, merged, tracker, decisions, tracks, logbook, ci, afspraken,
  };
}

async function main() {
  const outName = arg('out', 'public');
  const outDir = join(ROOT, outName);
  const strict = !process.argv.includes('--no-strict');

  // Strikt: een ontbrekend of kapot policybestand stopt de bouw. Zonder dat draaide de publieke
  // build stilzwijgend verder met een lege lijst — één ontbrekende komma in de JSON en elke naam
  // die geweerd moest worden stond weer op de openbare pagina (review Codex, 26-07-2026).
  const termCount = loadDenyTerms(join(ROOT, 'data/deny-terms.json'), { strict: true });

  const textPolicy = readTextPolicy(await readJson('data/publish-text.json', {}));
  const raw = await buildSnapshot();
  const reduced = toPublicSnapshot(raw, textPolicy);

  // SANITIZE-GATE — fail-closed. Alles hierna is publicabel of we publiceren niet.
  const { snapshot, findings } = assertPublishable(reduced, { strict });
  if (findings.length) console.warn(`sanitize: ${findings.length} bevinding(en) geredigeerd (niet-strikte modus)`);

  // CONTRACT-GATE — werkelijk tegen het schema, niet alleen op sleutelnamen. Een veld dat het
  // contract niet kent, is een veld waar niemand naar gekeken heeft: dat gaat er niet uit.
  const status = {
    contractVersion: snapshot.contractVersion,
    generatedAt: snapshot.generatedAt,
    overallStatus: snapshot.overallStatus,
    sources: snapshot.sources,
  };
  const errors = [
    ...validate(await readJson('contracts/dashboard-snapshot.schema.json', {}), snapshot),
    ...validate(await readJson('contracts/status-json.schema.json', {}), status),
  ];
  if (errors.length) throw new Error(`contract geschonden:\n- ${errors.join('\n- ')}`);

  const cockpitHtml = renderCockpit(snapshot, { refreshSeconds: REFRESH_SECONDS, nav: NAV_NAAR_CONTENTSTROOM });
  const contentstroomHtml = renderHtml(snapshot, { refreshSeconds: REFRESH_SECONDS, nav: NAV_NAAR_COCKPIT });

  // Verse directory: nooit een oud of per ongeluk meegekomen bestand mee-uploaden.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'index.html'), cockpitHtml, 'utf8');
  await writeFile(join(outDir, 'contentstroom.html'), contentstroomHtml, 'utf8');
  await writeFile(join(outDir, 'status.json'), `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  await writeFile(join(outDir, '.nojekyll'), '', 'utf8');

  // De volledige interne snapshot blijft lokaal — buiten de publicatiemap, buiten git.
  await mkdir(join(ROOT, '.local'), { recursive: true });
  await writeFile(join(ROOT, '.local/snapshot.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

  const degraded = snapshot.sources.filter((s) => s.trust !== 'VERIFIED_CURRENT');
  console.log(`gebouwd: ${relative(ROOT, join(outDir, 'index.html'))} (allowlist: ${PUBLISH_ALLOWLIST.join(', ')})`);
  console.log(`deny-terms geladen: ${termCount}`);
  const vrijgegeven = ['trackerUpdates', 'trackerDecisionPoints', 'decisions', 'logbook'].filter((k) => textPolicy[k]);
  console.log(`vrije tekst gepubliceerd: ${vrijgegeven.length ? vrijgegeven.join(', ') : 'geen (alleen structuur)'}`);
  console.log(`status: ${snapshot.overallStatus}${degraded.length ? ` · niet-geverifieerd: ${degraded.map((s) => `${s.key}=${s.trust}`).join(', ')}` : ''}`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  // Alleen de melding, nooit de stack: een stacktrace bevat absolute runnerpaden.
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
