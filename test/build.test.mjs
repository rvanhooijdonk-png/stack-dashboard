import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toPublicSnapshot, readTextPolicy, planningFromBouwlijst, parseClientPollOrigin } from '../scripts/build.mjs';

/**
 * Een collectorresultaat met velden die nooit gepubliceerd mogen worden (interne notitie,
 * bronpad, bewijs-URL, workflownaam). Gedeeld met contract.test.mjs: één nepbron, twee vragen —
 * "wordt het juiste weggelaten" hier, "past wat overblijft in het contract" daar.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = JSON.parse(await readFile(join(ROOT, 'test/fixtures/raw-snapshot.json'), 'utf8'));

test('de publieke DTO kopieert alleen expliciet toegestane velden', () => {
  const pub = toPublicSnapshot(raw);
  const json = JSON.stringify(pub);
  assert.equal(json.includes('internNotitie'), false);
  assert.equal(json.includes('https://intern'), false);
  assert.equal(json.includes('INTERN/PAD'), false);
  assert.equal(json.includes('proofUrl'), false);
  assert.equal(json.includes('sourceRef'), false);
  assert.equal(json.includes('geheime-workflow-naam'), false);
});

test('één niet-geverifieerde bron maakt de hele stand DEGRADED', () => {
  assert.equal(toPublicSnapshot(raw).overallStatus, 'DEGRADED');
  const clean = structuredClone(raw);
  clean.tracker.evidence.trust = 'VERIFIED_CURRENT';
  assert.equal(toPublicSnapshot(clean).overallStatus, 'OK');
});

test('het aantal verborgen repo\'s blijft behouden', () => {
  assert.equal(toPublicSnapshot(raw).pullRequests.hiddenRepositories, 3);
});

// --- Bevindingen uit de tweede dubbele review van 23-07-2026 (Codex + Gemini) ---

test('de probe van Codex haalt de publieke DTO niet — vrije tekst staat er standaard niet in', () => {
  // "Project Saffier: overname van klant Zephyr gaat vrijdag live" passeerde elke patroongate.
  // Precies daarom gaat vrije tekst er niet in: geen regex herkent bedrijfsinhoud.
  const json = JSON.stringify(toPublicSnapshot(raw));
  assert.equal(json.includes('Zephyr'), false);
  assert.equal(json.includes('Saffier'), false);
  assert.equal(json.includes('KLANTGEHEIM'), false);
  assert.equal(json.includes('journaalkop'), false);
});

test('de structuur blijft wél staan — nummers, ID\'s en datums dragen de status', () => {
  const pub = toPublicSnapshot(raw);
  assert.equal(pub.tracker.updates[0].number, 24);
  assert.equal(pub.tracker.updates[0].title, null);
  assert.equal(pub.tracker.decisionPoints[0].id, '24a');
  assert.equal(pub.decisions.entries[0].id, 'D-0013');
  assert.equal(pub.decisions.entries[0].decision, null);
  assert.equal(pub.tracker.updatesTextWithheld, true);
  assert.equal(pub.tracker.decisionPointsTextWithheld, true);
  assert.equal(pub.decisions.textWithheld, true);
  assert.equal(pub.logbook.textWithheld, true);
});

// --- Bevindingen uit de derde dubbele review van 23-07-2026 (Codex) ---

test('de roadmap was het gat: workstreams gingen ongefilterd mee — bewezen probe van Codex', () => {
  const ws = toPublicSnapshot(raw).workstreams;
  const json = JSON.stringify(ws);
  assert.equal(json.includes('Saffier'), false, 'zonder public:true gaat de titel er niet in');
  assert.equal(json.includes('Zephyr'), false);
  assert.equal(json.includes('internNotitie'), false);
  assert.equal(ws[1].title, null, 'WS02 draagt geen public-vlag');
  assert.equal(ws[1].estimate, null);
});

test('een raming is een duur, geen statusregel', () => {
  const ws = toPublicSnapshot(raw).workstreams;
  assert.equal(ws[0].estimate, '1-2 dagen', 'een echte duur blijft staan');
  assert.equal(ws[2].title, 'Vrijgegeven maar met statustekst i.p.v. duur', 'de titel is wél vrijgegeven');
  assert.equal(ws[2].estimate, null, 'maar "Railway-diagnose: klaar, wacht op Richard" is geen duur');
});

test('een bronpad verlaat de machine niet — evidence draagt geen source meer', () => {
  const pub = toPublicSnapshot(raw);
  assert.equal('source' in pub.tracker.evidence, false);
  assert.deepEqual(Object.keys(pub.ci.evidence).sort(), ['errorCode', 'retrievedAt', 'trust']);
});

test('"false" als tekst zet de poort niet open — hij breekt de build', () => {
  // Truthiness liet de string "false" door en publiceerde de hele sectie. Bewezen probe.
  assert.throws(() => readTextPolicy({ decisions: 'false' }), /moet true of false zijn/);
  assert.throws(() => readTextPolicy({ besluiten: true }), /onbekende sleutel/);
  assert.deepEqual(readTextPolicy({ _toelichting: 'commentaar mag', decisions: true }).decisions, true);
});

test('vrijgeven is een expliciete handeling, per sectie', () => {
  const pub = toPublicSnapshot(raw, { decisions: true });
  assert.match(pub.decisions.entries[0].decision, /Saffier/);
  assert.equal(pub.decisions.textWithheld, false);
  assert.equal(pub.tracker.updates[0].title, null, 'andere secties blijven dicht');
});

// --- Bevindingen uit de vierde dubbele review van 23-07-2026 (Codex + Gemini) ---

test('de fouttekst van een collector komt de publieke DTO niet in — beide reviewers, bewezen probe', () => {
  // "Project Saffier staat in CONTROL/KLANTEN/Zephyr.md" stond via evidence.error op de pagina,
  // en passeerde sanitize én contract met nul bevindingen. Een uitzonderingstekst is vrije tekst.
  const json = JSON.stringify(toPublicSnapshot(raw));
  assert.equal(json.includes('KLANTEN'), false);
  assert.equal(json.includes('/Users/'), false);
  assert.equal(json.includes('error"'), false, 'het veld heet errorCode en draagt een code');
});

test('de foutcode is afgeleid van trust, niet gekopieerd — dus gesloten van vorm', () => {
  const pub = toPublicSnapshot(raw);
  assert.equal(pub.tracker.evidence.errorCode, 'NIET_GEVERIFIEERD');
  assert.equal(pub.ci.evidence.errorCode, null, 'een geverifieerde bron heeft geen foutcode');
});

test('een klantnaam in het workstream-id breekt de build — hij verschijnt niet op de pagina', () => {
  // Titel en raming werden ingehouden, maar String(w.id) publiceerde élke waarde. Bewezen probe.
  const vies = structuredClone(raw);
  vies.workstreams[1].id = 'PROBE-NIET-VRIJGEGEVEN-KLANT-ORION';
  assert.throws(() => toPublicSnapshot(vies), /regel 2 heeft geen tweecijferig nummer/);
  // De melding zelf noemt de waarde niet: een CI-log van een openbare repo is zelf openbaar.
  assert.throws(() => toPublicSnapshot(vies), (err) => !err.message.includes('ORION'));
});

test('enkelvoudige duren zijn ook duren', () => {
  const ws = (estimate) => toPublicSnapshot({
    ...raw, workstreams: [{ id: '01', title: 'Titel', estimate, public: true }],
  }).workstreams[0].estimate;
  assert.equal(ws('1 dag'), '1 dag');
  assert.equal(ws('1 week'), '1 week');
  assert.equal(ws('1 minuut'), '1 minuut');
  assert.equal(ws('vrijdag live'), null, 'proza blijft proza');
});

test('een tekstbeleid dat geen object is, wordt niet als "alles uit" gelezen', () => {
  assert.throws(() => readTextPolicy(null), /verwacht een object/);
  assert.throws(() => readTextPolicy(true), /verwacht een object/);
  // `key in TEXT_OFF` hield prototypenamen voor bekende sleutels.
  assert.throws(() => readTextPolicy({ toString: true }), /onbekende sleutel/);
  assert.throws(() => readTextPolicy({ constructor: true }), /onbekende sleutel/);
});

// --- Bevinding uit de vijfde ronde (Codex, 23-07-2026): trust was óók een gekopieerd veld ---

test('een trust-waarde buiten de gesloten lijst breekt de build, niet pas het contract', () => {
  const vies = structuredClone(raw);
  vies.tracker.evidence.trust = 'vreemde-Project Orion klant AlphaZeven';
  assert.throws(() => toPublicSnapshot(vies), /gesloten lijst/);
  assert.throws(() => toPublicSnapshot(vies), (err) => !err.message.includes('Orion'));
});

test('ook de trust van een losse track wordt gekeurd', () => {
  const vies = structuredClone(raw);
  vies.tracks.tracks[0].trust = 'GROEN-GENOEG';
  assert.throws(() => toPublicSnapshot(vies), /gesloten lijst/);
});

test('verborgen CI-repo\'s worden geteld, niet benoemd', () => {
  const pub = toPublicSnapshot(raw);
  assert.equal(pub.ci.hiddenCiRepositories, 1);
});

// --- v2.1 (24-07-2026): tracks (klaar-rapport-leeftijd) + afgeleid categorielabel ---

test('het tracks-blok draagt alleen afgeleide leeftijd, nooit een rapport-bestandsnaam', () => {
  const pub = toPublicSnapshot(raw);
  const t = pub.tracks.tracks[0];
  assert.equal(t.track, 'VOORBEELD');
  assert.equal(t.lastReportAt, '2026-07-22T00:00:00Z');
  assert.equal(t.reportCount, 2);
  assert.equal(t.trust, 'VERIFIED_CURRENT');
  // De collector hing er een interne notitie aan; de handgebouwde DTO kopieert die niet mee.
  assert.equal('internNotitie' in t, false);
  assert.equal(JSON.stringify(pub.tracks).includes('internNotitie'), false);
  // Geen hiddenTracks meer: we itereren niet over de rapportenmap, we tellen per bekende track.
  assert.equal('hiddenTracks' in pub.tracks, false);
});

test('het afgeleide categorielabel gaat mee — ook als de titel is ingehouden', () => {
  const pub = toPublicSnapshot(raw);
  // Titel/besluit blijven null (tekst ingehouden), maar de categorie is een gesloten-lijst-label
  // en zegt "waar het over gaat" zonder de inhoud prijs te geven.
  assert.equal(pub.tracker.decisionPoints[0].title, null);
  assert.equal(pub.tracker.decisionPoints[0].category, 'accounts');
  assert.equal(pub.decisions.entries[0].decision, null);
  assert.equal(pub.decisions.entries[0].category, 'planning');
});

test('een categorie buiten de gesloten woordenschat breekt de build, niet pas het contract', () => {
  const vies = structuredClone(raw);
  vies.decisions.entries[0].category = 'klant-Zephyr-geheim';
  assert.throws(() => toPublicSnapshot(vies), /gesloten lijst/);
  assert.throws(() => toPublicSnapshot(vies), (err) => !err.message.includes('Zephyr'));
  const vies2 = structuredClone(raw);
  vies2.tracker.decisionPoints[0].category = 'iets-nieuws';
  assert.throws(() => toPublicSnapshot(vies2), /gesloten lijst/);
});

// --- Bevinding Codex-review 28-07-2026 (too_large-check, W-41-vervolg): het signaal verdween
// stil zodra buildSnapshot() alleen `.text` las van `collectBouwlijst()`'s `{text, tooLarge, size}`.

test('een te grote bouwlijst-bron toont LEEG op de plaat, maar tooLarge verdwijnt niet uit de interne snapshot', () => {
  const gewaarschuwd = [];
  const origWarn = console.warn;
  console.warn = (msg) => gewaarschuwd.push(msg);
  try {
    const planning = planningFromBouwlijst({ text: null, tooLarge: true, size: 1183240, spiegelAt: null });
    assert.equal(planning.available, false);
    assert.equal(planning.reason, 'LEEG', 'het contract kent nog geen derde stand — dat is het NOOIT_GEMETEN-voorstel');
    assert.equal(planning.bronTooLarge, true);
    assert.equal(planning.bronSize, 1183240);
    assert.equal(gewaarschuwd.length, 1, 'het signaal moet naar de build-log, niet stil verdwijnen');
    assert.match(gewaarschuwd[0], /1183240/);
  } finally {
    console.warn = origWarn;
  }
});

test('een gewoon leesbare bouwlijst-bron zet bronTooLarge op false en waarschuwt niet', () => {
  const gewaarschuwd = [];
  const origWarn = console.warn;
  console.warn = (msg) => gewaarschuwd.push(msg);
  const feed = JSON.stringify({
    meetlat: { sha: 'e0049dcabc123def456' },
    totaal_bouwbaar: 4,
    publish_veilig: 1,
    taken: [{
      task_id: 'T-0001',
      feature_label: 'Dagelijkse automatische contentpublicatie',
      verwachte_duur: '1-2 dagen',
      richard_poort: 'geen',
      prioriteit_tier: 3,
      status: 'READY',
      is_twijfel: false,
      afhankelijkheden: 2,
    }],
  });
  try {
    const planning = planningFromBouwlijst({ text: feed, tooLarge: false, size: 812, spiegelAt: '2026-07-28T10:00:00Z' });
    assert.equal(planning.available, true);
    assert.equal(planning.bronTooLarge, false);
    assert.equal(planning.bronSize, 812);
    assert.equal(planning.bron.spiegelAt, '2026-07-28T10:00:00Z');
    assert.equal(gewaarschuwd.length, 0);
  } finally {
    console.warn = origWarn;
  }
});

test('een ontbrekend bouwlijst-object crasht niet — leeg, geen tooLarge', () => {
  const planning = planningFromBouwlijst(undefined);
  assert.equal(planning.available, false);
  assert.equal(planning.bronTooLarge, false);
  assert.equal(planning.bronSize, null);
});

test('een track met een telling die niet strookt met zijn datum breekt de build (fail-closed)', () => {
  // "0 rapporten" met tóch een (groene) datum, of andersom, mag niet stil de pagina op.
  const vies = structuredClone(raw);
  vies.tracks.tracks[0] = { track: 'X', lastReportAt: '2026-07-22T00:00:00Z', reportCount: 0, trust: 'VERIFIED_CURRENT' };
  assert.throws(() => toPublicSnapshot(vies), /strookt niet|niet strookt/);
  const vies2 = structuredClone(raw);
  vies2.tracks.tracks[0] = { track: 'X', lastReportAt: null, reportCount: 3, trust: 'UNVERIFIED' };
  assert.throws(() => toPublicSnapshot(vies2), /strookt niet|niet strookt/);
});

// --- --client-poll-origin (Route C, dashboard-client-polling-c) ---

test('parseClientPollOrigin: geen waarde ⇒ null (standaardpad ongewijzigd)', () => {
  assert.equal(parseClientPollOrigin(undefined), null);
  assert.equal(parseClientPollOrigin(''), null);
});

test('parseClientPollOrigin: accepteert een kale http(s)-origin en normaliseert hem', () => {
  assert.equal(parseClientPollOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(parseClientPollOrigin('https://feed.example.com'), 'https://feed.example.com');
  assert.equal(parseClientPollOrigin('https://feed.example.com/'), 'https://feed.example.com');
});

test('parseClientPollOrigin: weigert alles behalve een kale origin (fail-closed)', () => {
  assert.throws(() => parseClientPollOrigin('http://127.0.0.1:8787/runtime-feed.json'), /kale http\(s\)-origin/);
  assert.throws(() => parseClientPollOrigin('http://127.0.0.1:8787?x=1'), /kale http\(s\)-origin/);
  assert.throws(() => parseClientPollOrigin('http://127.0.0.1:8787#frag'), /kale http\(s\)-origin/);
  assert.throws(() => parseClientPollOrigin('http://user:pass@127.0.0.1:8787'), /kale http\(s\)-origin/);
  assert.throws(() => parseClientPollOrigin('ftp://127.0.0.1:8787'), /kale http\(s\)-origin/);
  assert.throws(() => parseClientPollOrigin('niet-een-url'), /geen geldige URL/);
});
