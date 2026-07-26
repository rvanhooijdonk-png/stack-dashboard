import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parsePlanning, toPublicPlanning, publicFeature, verwachteOplevering,
  planningCounters, leadDagenVoor, isYmd,
  PLANNING_STATUS, WORKER_ROLES,
} from '../scripts/lib/planning.mjs';
import { renderHtml } from '../scripts/lib/render.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(join(ROOT, 'data/fixture.json'), 'utf8'));
const BUILD = '2026-07-25T12:00:00.000Z';

const geldigeBouwlijst = () => JSON.stringify({
  generatedAt: '2026-07-25T02:00:00.000Z',
  throughput: { leadDagenPerKlasse: { 'render-fix': 1, 'nieuwe-sectie': 3 } },
  features: [
    { feature_label: 'Iets in aanbouw', status: 'in-bouw', worker: 'worker', throughput_klasse: 'nieuwe-sectie' },
    { feature_label: 'Iets af', status: 'live', worker: 'worker', af_sinds: '2026-07-25', throughput_klasse: 'render-fix' },
  ],
  kanaalpost: [{ datum: '2026-07-25', doelchat: '02', onderwerp: 'Test', status: 'gemerged' }],
});

// --- parsePlanning: fail-closed op leeg en corrupt ---

test('een leeg bouwlijst-bestand levert LEEG, geen throw', () => {
  assert.equal(parsePlanning('').reason, 'LEEG');
  assert.equal(parsePlanning('   \n  ').reason, 'LEEG');
  assert.equal(parsePlanning(undefined).reason, 'LEEG');
});

test('een corrupt (niet-JSON) bouwlijst-bestand levert CORRUPT, geen throw', () => {
  assert.equal(parsePlanning('{ dit is geen json').reason, 'CORRUPT');
  assert.equal(parsePlanning('null').reason, 'CORRUPT');
  assert.equal(parsePlanning('[1,2,3]').reason, 'CORRUPT');
});

test('een bouwlijst zonder features is LEEG, niet corrupt', () => {
  assert.equal(parsePlanning(JSON.stringify({ features: [] })).reason, 'LEEG');
  assert.equal(parsePlanning(JSON.stringify({})).reason, 'LEEG');
});

test('een geldige bouwlijst parseert naar available=true met zijn features', () => {
  const p = parsePlanning(geldigeBouwlijst());
  assert.equal(p.available, true);
  assert.equal(p.features.length, 2);
});

// --- De harde schoon-poort: gesloten woordenschat ---

test('publicFeature gooit bij een status buiten de gesloten lijst', () => {
  assert.throws(() => publicFeature(
    { feature_label: 'x', status: 'zomaar-iets', throughput_klasse: 'render-fix' }, 0, {}, BUILD,
  ), /status buiten de gesloten lijst/);
});

test('publicFeature gooit bij een worker die geen neutrale rol is (F5 §C)', () => {
  assert.throws(() => publicFeature(
    { feature_label: 'x', status: 'gepland', worker: 'richard@futurezone.ai' }, 0, {}, BUILD,
  ), /geen neutrale rol/);
});

test('publicFeature gooit bij een ontbrekende naam en bij een niet-object', () => {
  assert.throws(() => publicFeature({ status: 'gepland' }, 0, {}, BUILD), /mist een leesbare naam/);
  assert.throws(() => publicFeature(null, 0, {}, BUILD), /geen object/);
});

test('worker null (nog niet toegewezen) is toegestaan', () => {
  const f = publicFeature({ feature_label: 'x', status: 'gepland', worker: null }, 0, {}, BUILD);
  assert.equal(f.worker, null);
});

test('de gesloten lijsten bevatten precies de afgesproken waarden', () => {
  assert.deepEqual(PLANNING_STATUS, ['gepland', 'in-bouw', 'in-review', 'wacht-op-Richard', 'live']);
  assert.deepEqual(WORKER_ROLES, ['worker', 'control', 'review', 'richard']);
});

// --- toPublicPlanning: één afgekeurde regel keurt de hele plaat af, page blijft staan ---

test('één feature buiten de gesloten lijst keurt de HELE plaat af als CORRUPT', () => {
  const parsed = parsePlanning(JSON.stringify({
    features: [
      { feature_label: 'goed', status: 'gepland' },
      { feature_label: 'fout', status: 'HACK' },
    ],
  }));
  const dto = toPublicPlanning(parsed, BUILD);
  assert.equal(dto.available, false);
  assert.equal(dto.reason, 'CORRUPT');
  assert.deepEqual(dto.features, []);
});

test('een onbeschikbare parsed-invoer geeft een geldige onbeschikbare DTO', () => {
  const dto = toPublicPlanning(parsePlanning(''), BUILD);
  assert.equal(dto.available, false);
  assert.equal(dto.reason, 'LEEG');
  assert.deepEqual(dto.counters, { afSindsGisteren: 0, draaitNu: 0, wachtOpRichard: 0, gepland: 0 });
  // Ook de herkomst-regel is dan leeg: geen bron betekent geen provenance om te tonen.
  assert.equal(dto.bron, null);
});

test('interne velden lekken niet mee: alleen de whitelist blijft over', () => {
  const parsed = parsePlanning(JSON.stringify({
    features: [{
      feature_label: 'Publieke naam', status: 'in-bouw', worker: 'worker',
      throughput_klasse: 'render-fix', internNotitie: 'KLANT ZEPHYR', secretRef: 'CONTROL/KLANTEN/Zephyr.md',
    }],
  }));
  const dto = toPublicPlanning(parsed, BUILD);
  const f = dto.features[0];
  assert.deepEqual(Object.keys(f).sort(),
    ['afhankelijkheid', 'duurIndicatie', 'label', 'oplevering', 'status', 'tier0', 'worker']);
  assert.equal(JSON.stringify(dto).includes('Zephyr'), false);
  assert.equal(JSON.stringify(dto).includes('internNotitie'), false);
});

// --- verwachte oplevering: herrekend op het throughput-log, geen tweede meetsysteem ---

test('een live feature telt als opgeleverd, met zijn opleverdatum als die echt is', () => {
  assert.deepEqual(verwachteOplevering({ status: 'live', af_sinds: '2026-07-24' }, {}, BUILD),
    { kind: 'opgeleverd', date: '2026-07-24' });
  // Onechte datum ⇒ opgeleverd zonder datum, nooit een kapotte datum de plaat op.
  assert.deepEqual(verwachteOplevering({ status: 'live', af_sinds: 'gisteren' }, {}, BUILD),
    { kind: 'opgeleverd', date: null });
});

test('een bekende klasse levert bouwmoment + gemeten doorlooptijd', () => {
  const tp = { leadDagenPerKlasse: { 'nieuwe-sectie': 3 } };
  assert.deepEqual(verwachteOplevering({ status: 'in-bouw', throughput_klasse: 'nieuwe-sectie' }, tp, BUILD),
    { kind: 'verwacht', date: '2026-07-28' });
});

test('een klasse zonder gemeten doorlooptijd is onbekend, nooit een verzonnen datum', () => {
  assert.deepEqual(verwachteOplevering({ status: 'gepland', throughput_klasse: 'onbekende-klasse' }, {}, BUILD),
    { kind: 'onbekend', date: null });
  assert.equal(leadDagenVoor({}, 'x'), null);
  assert.equal(leadDagenVoor({ leadDagenPerKlasse: { x: -1 } }, 'x'), null);
});

test('een absurde doorlooptijd wordt onbekend op feature-niveau, geen RangeError of afgekeurde plaat', () => {
  // Gemini-bevinding 25-07: een enorme (maar eindige) lead overschreed de Date-range → RangeError →
  // hele plaat CORRUPT. Nu: die klasse levert onbekend, en de plaat blijft gewoon beschikbaar.
  const tp = { leadDagenPerKlasse: { boem: 1e20 } };
  assert.deepEqual(verwachteOplevering({ status: 'in-bouw', throughput_klasse: 'boem' }, tp, BUILD),
    { kind: 'onbekend', date: null });
  const dto = toPublicPlanning(parsePlanning(JSON.stringify({
    throughput: tp, features: [{ feature_label: 'x', status: 'in-bouw', throughput_klasse: 'boem' }],
  })), BUILD);
  assert.equal(dto.available, true);
  assert.equal(dto.features[0].oplevering.kind, 'onbekend');
});

test('af-sinds-gisteren telt een feature die gisteren live ging, ook bij een middag-build', () => {
  // Gemini-bevinding 25-07: een rollend 24-uursvenster liet een gisterenochtend-oplevering 's middags
  // wegvallen. Kalender-semantiek telt hem wél mee.
  const middag = '2026-07-25T14:00:00.000Z';
  const features = [{ status: 'live', oplevering: { kind: 'opgeleverd', date: '2026-07-24' } }];
  assert.equal(planningCounters(features, middag).afSindsGisteren, 1);
  // Een feature van eergisteren telt niet meer mee.
  const ouder = [{ status: 'live', oplevering: { kind: 'opgeleverd', date: '2026-07-23' } }];
  assert.equal(planningCounters(ouder, middag).afSindsGisteren, 0);
});

// --- kop-band-tellers ---

test('de kop-band telt draait-nu, wacht-op-Richard, af-sinds-gisteren en gepland', () => {
  const features = [
    { status: 'in-bouw', oplevering: { kind: 'verwacht', date: '2026-07-28' } },
    { status: 'in-bouw', oplevering: { kind: 'verwacht', date: '2026-07-28' } },
    { status: 'wacht-op-Richard', oplevering: { kind: 'onbekend', date: null } },
    { status: 'gepland', oplevering: { kind: 'onbekend', date: null } },
    { status: 'gepland', oplevering: { kind: 'onbekend', date: null } },
    { status: 'gepland', oplevering: { kind: 'onbekend', date: null } },
    { status: 'live', oplevering: { kind: 'opgeleverd', date: '2026-07-25' } },
    { status: 'live', oplevering: { kind: 'opgeleverd', date: '2026-07-10' } },
  ];
  assert.deepEqual(planningCounters(features, BUILD),
    { afSindsGisteren: 1, draaitNu: 2, wachtOpRichard: 1, gepland: 3 });
});

// --- kanaalpost: laatste tien, ongeldige velden fail-closed naar null ---

test('kanaalpost toont alleen de laatste tien rijen', () => {
  const rijen = Array.from({ length: 14 }, (_, i) => ({ datum: '2026-07-25', doelchat: '02', onderwerp: `r${i}`, status: 'x' }));
  const dto = toPublicPlanning(parsePlanning(JSON.stringify({
    features: [{ feature_label: 'x', status: 'gepland' }], kanaalpost: rijen,
  })), BUILD);
  assert.equal(dto.kanaalpost.length, 10);
  assert.equal(dto.kanaalpost[0].onderwerp, 'r4');
  assert.equal(dto.kanaalpost[9].onderwerp, 'r13');
});

test('een ongeldige datum of doelchat in kanaalpost wordt null, niet doorgelaten', () => {
  const dto = toPublicPlanning(parsePlanning(JSON.stringify({
    features: [{ feature_label: 'x', status: 'gepland' }],
    kanaalpost: [{ datum: 'niet-een-datum', doelchat: 'kwaad', onderwerp: 'o', status: 's' }],
  })), BUILD);
  assert.equal(dto.kanaalpost[0].datum, null);
  assert.equal(dto.kanaalpost[0].doelchat, null);
  assert.equal(dto.kanaalpost[0].onderwerp, 'o');
});

test('isYmd keurt vorm én echte datum, en weigert onzin', () => {
  assert.equal(isYmd('2026-07-25'), true);
  assert.equal(isYmd('2026-13-40'), false);
  assert.equal(isYmd('2026-7-5'), false);
  assert.equal(isYmd('gisteren'), false);
});

// --- render: de plaat staat op de pagina, fail-closed toont een melding, XSS wordt geëscaped ---

test('de planning-plaat rendert met kop-band, features en kanaalpost', () => {
  const html = renderHtml(fixture);
  assert.match(html, /id="planning"/);
  assert.match(html, /Af sinds gisteren/);
  assert.match(html, /Draait nu/);
  assert.match(html, /Wacht op Richard/);
  assert.match(html, /Planning-plaat op het dashboard/);
  assert.match(html, /Kanaalpost — laatste/);
});

test('een lege bouwlijst toont een nette melding op de plaat, geen kapotte pagina', () => {
  const leeg = structuredClone(fixture);
  leeg.planning = toPublicPlanning(parsePlanning(''), BUILD);
  const html = renderHtml(leeg);
  assert.match(html, /id="planning"/);
  assert.match(html, /nog geen bouwlijst geleverd/i);
  // De rest van de pagina staat er nog gewoon — fail-closed op de sectie, niet op de pagina.
  assert.match(html, /Stack-dashboard/);
  assert.match(html, /id="overzicht"/);
});

test('een corrupte bouwlijst toont de afgekeurd-melding, niet de features', () => {
  const stuk = structuredClone(fixture);
  stuk.planning = toPublicPlanning(parsePlanning('{ kapot'), BUILD);
  const html = renderHtml(stuk);
  assert.match(html, /niet veilig worden gelezen/i);
  assert.equal(html.includes('Planning-plaat op het dashboard'), false);
});

test('een feature-naam met HTML wordt geëscaped, nooit als markup uitgevoerd', () => {
  const evil = structuredClone(fixture);
  evil.planning.features[0].label = '<img src=x onerror=alert(1)>';
  const html = renderHtml(evil);
  assert.equal(html.includes('<img src=x'), false);
  assert.match(html, /&lt;img src=x/);
});
