import test from 'node:test';
import assert from 'node:assert/strict';

import { statusgenPaneel, renderStatusgenBody, statusgenBadge } from '../scripts/lib/paneel-statusgen.mjs';
import { FUTURE_SKEW_MS } from '../scripts/lib/runtime-feed.mjs';
import { renderCockpit } from '../scripts/lib/render-cockpit.mjs';

const NU = new Date('2026-08-22T20:00:00.000Z');
const nuPlus = (ms) => new Date(new Date(NU).getTime() + ms).toISOString();

// Een volwaardige bron zoals contracts/status-json.schema.json hem eist: key, trust, retrievedAt
// en rijen zijn alle vier verplicht.
// Bronkeys komen uit de enum van contracts/status-json.schema.json. Fixtures met meerdere bronnen
// dragen verschillende keys, net als de echte snapshot; de key is expliciet zodat een test niet
// afhangt van de volgorde waarin andere tests deze helper aanroepen.
const bron = (trust, key = 'tracker') => ({ key, trust, retrievedAt: nuPlus(-1000), rijen: null });

const snapshot = (extra = {}) => ({
  generatedAt: nuPlus(-1000),
  contractVersion: '2.7.0',
  overallStatus: 'DEGRADED',
  sources: [bron('VERIFIED_CURRENT', 'tracker'), bron('STALE', 'logbook')],
  ...extra,
});

test('alle bronnen geverifieerd → VOLLEDIG met een groene badge', () => {
  const p = statusgenPaneel(snapshot({ sources: [bron('VERIFIED_CURRENT', 'tracker'), bron('VERIFIED_CURRENT', 'ci')] }), { now: NU });
  assert.equal(p.status, 'VOLLEDIG');
  assert.equal(statusgenBadge(p), 'ok');
  assert.equal(p.regels.find((r) => r.label === 'Bronnen').waarde, '2 gelezen · 0 niet-geverifieerd');
});

test('elke trust-waarde behalve VERIFIED_CURRENT telt als niet-geverifieerd (allowlist, niet denylist)', () => {
  // CONFLICTING_EVIDENCE staat in contracts/status-json.schema.json en ontbrak in de eerste opzet;
  // een onbekende string en een ontbrekend veld horen naar dezelfde veilige kant te vallen.
  const sources = [
    bron('VERIFIED_CURRENT', 'pullRequests'),
    bron('CONFLICTING_EVIDENCE', 'merged'),
    bron('UNVERIFIED', 'tracker'),
    bron('SOURCE_UNAVAILABLE', 'decisions'),
    bron('STALE', 'tracks'),
    bron('IETS_NIEUWS_UIT_DE_TOEKOMST', 'logbook'),
    bron('', 'ci'),
    { key: 'afspraken', retrievedAt: nuPlus(-1000), rijen: null },
    null,
  ];
  const p = statusgenPaneel(snapshot({ sources }), { now: NU });
  assert.equal(p.regels.find((r) => r.label === 'Bronnen').waarde, '9 gelezen · 8 niet-geverifieerd');
  assert.equal(p.status, 'GEDEELTELIJK');
  assert.equal(statusgenBadge(p), 'warn');
});

test('een stempel precies op de toekomstgrens is nog geldig, één ms erover is AFWIJKING', () => {
  const opDeGrens = statusgenPaneel(snapshot({ generatedAt: nuPlus(FUTURE_SKEW_MS) }), { now: NU });
  assert.notEqual(opDeGrens.status, 'AFWIJKING');
  const erover = statusgenPaneel(snapshot({ generatedAt: nuPlus(FUTURE_SKEW_MS + 1) }), { now: NU });
  assert.equal(erover.status, 'AFWIJKING');
  assert.equal(statusgenBadge(erover), 'bad');
});

test('een onmogelijke kalenderdatum of een stempel zonder tijdzone wordt geweigerd, niet gladgestreken', () => {
  // `new Date("2026-02-30T20:00:00Z")` rolt stilzwijgend door naar 2 maart; zonder zone leest V8
  // de string als lokale tijd. Beide moeten UNKNOWN geven, geen geldig (verschoven) tijdstip.
  for (const kapot of ['2026-02-30T20:00:00Z', '2026-08-22T20:00:00', '2026-08-22', 'gisteren', '', null, undefined, 12345]) {
    const p = statusgenPaneel(snapshot({ generatedAt: kapot }), { now: NU });
    assert.equal(p.status, 'UNKNOWN', `verwachtte UNKNOWN voor ${JSON.stringify(kapot)}`);
    assert.equal(p.measuredAt, null);
  }
});

test('een onleesbare referentieklok laat niets door', () => {
  // NaN maakt elke vergelijking false; zonder aparte bewaking zou álles hier geldig worden.
  // `undefined` staat er bewust niet bij: dat valt terug op de defaultparameter (de echte klok).
  // `1e20` is eindig maar ligt buiten het Date-bereik (±8,64e15 ms) — `Number.isFinite` alleen
  // laat die door en gaf een groen oordeel.
  for (const klok of [new Date(NaN), NaN, 'straks', null, {}, 1e20, 8640000000000001, -8640000000000001]) {
    const p = statusgenPaneel(snapshot(), { now: klok });
    assert.equal(p.status, 'UNKNOWN', `verwachtte UNKNOWN voor klok ${String(klok)}`);
  }
});

test('een misvormde snapshot klapt niet en levert UNKNOWN', () => {
  for (const rommel of [null, undefined, 'tekst', 42, [], { sources: 'geen array' }]) {
    const p = statusgenPaneel(rommel, { now: NU });
    assert.equal(p.status, 'UNKNOWN');
    assert.equal(p.regels.length, 3);
    assert.ok(p.regels.every((r) => r.bewezen === false));
  }
});

test('vijandige tekst uit de snapshot komt geëscapet op de plaat', () => {
  const p = statusgenPaneel(snapshot({ contractVersion: '<script>alert(1)</script>' }), { now: NU });
  const html = renderStatusgenBody(p);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('het paneel benoemt zijn eigen blinde vlek in plaats van hem te overschilderen', () => {
  const html = renderStatusgenBody(statusgenPaneel(snapshot(), { now: NU }));
  assert.ok(/bouwketen sindsdien is gestopt/.test(html));
  // Geen enkele status mag beweren dat de plaat "vers" of "current" is — dat is niet meetbaar.
  for (const s of ['VOLLEDIG', 'GEDEELTELIJK', 'AFWIJKING', 'UNKNOWN']) {
    assert.ok(!/CURRENT|vers\b/i.test(renderStatusgenBody({ status: s, reden: 'reden', regels: [] })));
  }
});

test('het slot op de echte cockpitpagina is gevuld, niet meer het lege skelet', () => {
  const html = renderCockpit(snapshot(), { products: [], ticker: null, runtimeFeed: null, now: NU });
  const slot = html.slice(html.indexOf('data-panel-slot="statusgen"'));
  const eind = slot.indexOf('</section>');
  const paneel = slot.slice(0, eind);
  assert.ok(paneel.includes('2.7.0'), 'contractversie hoort op de plaat te staan');
  assert.ok(paneel.includes('DEGRADED'), 'overall-status hoort op de plaat te staan');
  assert.ok(paneel.includes('2 gelezen · 1 niet-geverifieerd'));
  assert.ok(!paneel.includes('bron nog niet gekoppeld'), 'het lege skelet hoort weg te zijn');
});

test('een bron die VERIFIED_CURRENT roept maar de schemavorm mist, telt niet als bewijs', () => {
  // contracts/status-json.schema.json eist key, trust, retrievedAt en rijen. Een object dat alleen
  // het trust-veld draagt is een misvormde regel, geen geverifieerde bron.
  const misvormd = [
    { trust: 'VERIFIED_CURRENT' },
    { key: 'tracker', trust: 'VERIFIED_CURRENT', rijen: null },
    { key: '', trust: 'VERIFIED_CURRENT', retrievedAt: nuPlus(-1000), rijen: null },
    { key: 'tracker', trust: 'VERIFIED_CURRENT', retrievedAt: '2026-02-30T12:00:00Z', rijen: null },
    { key: 'tracker', trust: 'VERIFIED_CURRENT', retrievedAt: nuPlus(-1000) },
  ];
  for (const s of misvormd) {
    const p = statusgenPaneel(snapshot({ sources: [s] }), { now: NU });
    assert.equal(p.status, 'GEDEELTELIJK', `verwachtte onbewezen voor ${JSON.stringify(s)}`);
    assert.equal(p.regels.find((r) => r.label === 'Bronnen').waarde, '1 gelezen · 1 niet-geverifieerd');
  }
});

test('een groene badge boven een UNKNOWN-regel bestaat niet', () => {
  for (const ontbreekt of ['contractVersion', 'overallStatus']) {
    const s = snapshot({ sources: [bron('VERIFIED_CURRENT')] });
    delete s[ontbreekt];
    const p = statusgenPaneel(s, { now: NU });
    assert.notEqual(p.status, 'VOLLEDIG', `${ontbreekt} ontbreekt en de badge bleef groen`);
    assert.equal(statusgenBadge(p), 'warn');
  }
});

test('een bron die is opgehaald na het bouwmoment telt niet als bewijs', () => {
  // Het contract laat dit door — gemeten met contracts/dashboard-snapshot.schema.json komt een
  // retrievedAt van 2099 er ongehinderd doorheen, terwijl elke vormschending daar wél sneuvelt.
  // Een JSON Schema kan nu eenmaal niet zeggen "dit tijdstip mag niet ná dat tijdstip liggen".
  const gebouwd = nuPlus(-1000);
  const opDeGrens = { ...bron('VERIFIED_CURRENT'), retrievedAt: nuPlus(-1000 + FUTURE_SKEW_MS) };
  const erover = { ...bron('VERIFIED_CURRENT'), retrievedAt: nuPlus(-1000 + FUTURE_SKEW_MS + 1) };
  assert.equal(statusgenPaneel({ ...snapshot(), generatedAt: gebouwd, sources: [opDeGrens] }, { now: NU }).status, 'VOLLEDIG');
  const p = statusgenPaneel({ ...snapshot(), generatedAt: gebouwd, sources: [erover] }, { now: NU });
  assert.equal(p.status, 'GEDEELTELIJK');
  assert.equal(p.regels.find((r) => r.label === 'Bronnen').waarde, '1 gelezen · 1 niet-geverifieerd');
});

test('een rijentelling die niet kan bestaan telt niet als bewijs', () => {
  // Het schema eist de vier velden en hun type, maar kan hun onderlinge orde niet uitdrukken:
  // {inBron:1, herkend:2, getoond:3, afgekapt:4} haalt beide schema's moeiteloos.
  const onmogelijk = [
    { inBron: 1, herkend: 2, getoond: 3, afgekapt: 4 },
    { inBron: 10, herkend: 5, getoond: 6, afgekapt: 0 },
    { inBron: 10, herkend: 5, getoond: 5, afgekapt: 6 },
    { inBron: -1, herkend: 0, getoond: 0, afgekapt: 0 },
    { inBron: 1.5, herkend: 1, getoond: 1, afgekapt: 0 },
    { inBron: 10, herkend: 5, getoond: 5 },
  ];
  for (const rijen of onmogelijk) {
    const p = statusgenPaneel(snapshot({ sources: [{ ...bron('VERIFIED_CURRENT'), rijen }] }), { now: NU });
    assert.equal(p.status, 'GEDEELTELIJK', `verwachtte onbewezen voor ${JSON.stringify(rijen)}`);
  }
  // Een achterstand (herkend < inBron) is een echte toestand, geen onmogelijkheid: die keurt dit
  // paneel niet af — doorstroom.mjs meldt hem apart.
  const achterstand = { inBron: 10, herkend: 4, getoond: 4, afgekapt: 1 };
  const p = statusgenPaneel(snapshot({ sources: [{ ...bron('VERIFIED_CURRENT'), rijen: achterstand }] }), { now: NU });
  assert.equal(p.status, 'VOLLEDIG');
});

test('een bronkey die twee keer voorkomt maakt de telling onwaar en dus de plaat rood', () => {
  // `uniqueItems` in JSON Schema vergelijkt hele objecten; twee regels met dezelfde key en een
  // ander tijdstempel glippen daar doorheen. Gemeten: beide contracten missen minItems,
  // maxItems én uniqueItems op `sources`.
  const sources = [
    { ...bron('VERIFIED_CURRENT'), key: 'tracker' },
    { ...bron('VERIFIED_CURRENT'), key: 'tracker', retrievedAt: nuPlus(-2000) },
  ];
  const p = statusgenPaneel(snapshot({ sources }), { now: NU });
  assert.equal(p.status, 'AFWIJKING');
  assert.equal(statusgenBadge(p), 'bad');
  // Twee verschillende keys zijn gewoon goed.
  const goed = statusgenPaneel(snapshot({
    sources: [{ ...bron('VERIFIED_CURRENT'), key: 'tracker' }, { ...bron('VERIFIED_CURRENT'), key: 'logbook' }],
  }), { now: NU });
  assert.equal(goed.status, 'VOLLEDIG');
});
