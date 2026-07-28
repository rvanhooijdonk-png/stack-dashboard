/**
 * DOORSTROOM-ALARM — de proeven staan hier vóór het gedrag opnieuw vertrouwd wordt.
 *
 * Gemeten op 2026-07-28: `doorstroom.yml` mailde op ELKE trigger, ook toen de onderliggende oorzaak
 * (een kapotte regressietest, zie CONTROL/RAPPORTEN ALARM-DAT-ELKE-RUN-MAILT A1) al vier runs lang
 * dezelfde was. Nul debounce, dus nul verschil tussen "nog steeds hetzelfde probleem" en "opnieuw
 * misgegaan". De kernproef hieronder (A4 uit de opdracht) bewijst het tegendeel: twee opeenvolgende
 * runs met dezelfde oorzaak → precies één melding; een derde run met een andere oorzaak → een nieuwe.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  normaliseerReden, falendeTestNamen, causeSignature, bepaalOorzaak, leesMarker, schrijfMarker, beslisMelding,
} from '../scripts/lib/doorstroom-alarm.mjs';

const NU = new Date('2026-07-28T05:00:00Z');
const later = (uren) => new Date(NU.getTime() + uren * 3_600_000);

const OORDEEL_ROOD_ACHTERSTAND = {
  uitkomst: 'ROOD',
  bron: { ok: true },
  kanaalpost: { ok: true },
  achterstand: { uitkomst: 'ROOD', reden: 'BRON_NIET_GEPUBLICEERD' },
  stempel: { uitkomst: 'GROEN', reden: null },
  bronRijen: { uitkomst: 'GROEN', reden: null },
};

const OORDEEL_ROOD_BRONRIJEN = {
  uitkomst: 'ROOD',
  bron: { ok: true },
  kanaalpost: { ok: true },
  achterstand: { uitkomst: 'GROEN', reden: null },
  stempel: { uitkomst: 'GROEN', reden: null },
  bronRijen: { uitkomst: 'ROOD', reden: 'RIJEN_WEGGEVALLEN: tracker 17/36' },
};

const OORDEEL_GROEN = {
  uitkomst: 'GROEN',
  bron: { ok: true },
  kanaalpost: { ok: true },
  achterstand: { uitkomst: 'GROEN', reden: null },
  stempel: { uitkomst: 'GROEN', reden: null },
  bronRijen: { uitkomst: 'GROEN', reden: null },
};

// ─── normaliseerReden / falendeTestNamen ───────────────────────────────────────────────────────────

test('normaliseerReden: de vaste code blijft over, de variabele telling niet', () => {
  assert.equal(normaliseerReden('RIJEN_WEGGEVALLEN: tracker 17/36, decisions 1/1'), 'RIJEN_WEGGEVALLEN');
  assert.equal(normaliseerReden('SPIEGEL_ONLEESBAAR/GEEN_BRON@iets'), 'SPIEGEL_ONLEESBAAR');
  assert.equal(normaliseerReden('BRON_NIET_GEPUBLICEERD'), 'BRON_NIET_GEPUBLICEERD');
  assert.equal(normaliseerReden(null), '?');
});

test('falendeTestNamen: leest alle testnamen uit een tap-uitvoer, gesorteerd, of een lege lijst zonder falen', () => {
  const tap = [
    'TAP version 13',
    'ok 1 - iets dat werkt',
    'not ok 388 - de echte spiegel voldoet — de nulmeting die deze eis draagt',
    '  ---',
    '  ...',
    'not ok 42 - achtergrondtaak ruimt op',
  ].join('\n');
  assert.deepEqual(falendeTestNamen(tap), [
    'achtergrondtaak ruimt op',
    'de echte spiegel voldoet — de nulmeting die deze eis draagt',
  ]);
  assert.deepEqual(falendeTestNamen('ok 1 - alles groen'), []);
  assert.deepEqual(falendeTestNamen(null), []);
});

test('falendeTestNamen: ontdubbelt herhaalde testnamen', () => {
  const tap = ['not ok 1 - iets stuk', 'not ok 2 - iets stuk'].join('\n');
  assert.deepEqual(falendeTestNamen(tap), ['iets stuk']);
});

// ─── causeSignature ─────────────────────────────────────────────────────────────────────────────────

test('causeSignature: gelijk bij een ongewijzigde oorzaak, ook als tellingen verschuiven', () => {
  const a = causeSignature(OORDEEL_ROOD_BRONRIJEN);
  const b = causeSignature({
    ...OORDEEL_ROOD_BRONRIJEN,
    bronRijen: { uitkomst: 'ROOD', reden: 'RIJEN_WEGGEVALLEN: tracker 1/36' },
  });
  assert.equal(a, b);
});

test('causeSignature: verschillend bij een andere structurele oorzaak', () => {
  assert.notEqual(causeSignature(OORDEEL_ROOD_ACHTERSTAND), causeSignature(OORDEEL_ROOD_BRONRIJEN));
});

test('causeSignature: UITVOERDER_GEFAALD draagt de falende testnamen, en is anders dan ONBEKEND', () => {
  const metTest = causeSignature(null, { testNamen: ['de echte spiegel voldoet'] });
  const zonderTest = causeSignature(null, {});
  assert.equal(metTest, 'UITVOERDER_GEFAALD:de echte spiegel voldoet');
  assert.equal(zonderTest, 'UITVOERDER_GEFAALD:ONBEKEND');
  assert.notEqual(metTest, zonderTest);
});

test('causeSignature: een NIEUWE falende test naast een aanhoudende verandert de handtekening (Codex-bevinding)', () => {
  // De bug die dit bewijst: bleef alleen de EERSTE falende testnaam meetellen, dan bleef de
  // handtekening op "test A" hangen zodra "test B" erbij kwam terwijl A bleef falen — en werd B dus
  // stilzwijgend gedebouncet. Met de volledige, gesorteerde verzameling verandert de handtekening
  // zodra de VERZAMELING falende tests verandert, ongeacht welke er het eerst in de tap-uitvoer staat.
  const alleenA = causeSignature(null, { testNamen: falendeTestNamen('not ok 1 - test A') });
  const aEnB = causeSignature(null, { testNamen: falendeTestNamen(['not ok 1 - test A', 'not ok 2 - test B'].join('\n')) });
  const bEnA = causeSignature(null, { testNamen: falendeTestNamen(['not ok 2 - test B', 'not ok 1 - test A'].join('\n')) });
  assert.notEqual(alleenA, aEnB);
  assert.equal(aEnB, bEnA);
});

// ─── bepaalOorzaak (--oorzaak-override, ALARM-DAT-ELKE-RUN-MAILT A2-A4, derde Codex-bevinding) ────────

test('bepaalOorzaak: zonder override valt terug op het gewone oordeel/tap-pad', () => {
  assert.deepEqual(
    bepaalOorzaak({ oordeel: OORDEEL_GROEN }),
    { uitkomst: 'GROEN', causeSig: 'GROEN', testNamen: [] },
  );
  assert.deepEqual(
    bepaalOorzaak({ oordeel: null, tap: 'not ok 1 - iets stuk' }),
    { uitkomst: 'ROOD', causeSig: 'UITVOERDER_GEFAALD:iets stuk', testNamen: ['iets stuk'] },
  );
});

test('bepaalOorzaak: met override is de code de oorzaak en wordt ROOD geforceerd — ook bij een (stale) GROEN oordeel', () => {
  // De bug die dit bewijst: een mislukte push in "Aanvulling vastleggen" laat `/tmp/oordeel.json` GROEN
  // achter (geschreven vóór de push, door "Overzetten"). Zonder deze override zou de Alarm-stap dat
  // GROEN geloven en een openstaand issue ten onrechte als "opgelost" sluiten, terwijl de aanvulling
  // nooit op main is beland.
  assert.deepEqual(
    bepaalOorzaak({ oordeel: OORDEEL_GROEN, oorzaakOverride: 'VASTLEGGEN_GEFAALD' }),
    { uitkomst: 'ROOD', causeSig: 'STAP_GEFAALD:VASTLEGGEN_GEFAALD', testNamen: [] },
  );
});

test('bepaalOorzaak: een lege override telt als geen override', () => {
  assert.deepEqual(
    bepaalOorzaak({ oordeel: OORDEEL_GROEN, oorzaakOverride: '' }),
    { uitkomst: 'GROEN', causeSig: 'GROEN', testNamen: [] },
  );
});

// ─── marker lezen/schrijven ─────────────────────────────────────────────────────────────────────────

test('marker: schrijven en teruglezen geeft dezelfde staat, bestaande tekst blijft staan', () => {
  const staat = { causeSig: 'ACHTERSTAND:ROOD:BRON_NIET_GEPUBLICEERD', laatstGemeldOp: NU.toISOString() };
  const body = schrijfMarker('Uitleg die niet mag verdwijnen.', staat);
  assert.match(body, /Uitleg die niet mag verdwijnen\./);
  assert.deepEqual(leesMarker(body), staat);
});

test('marker: state null verwijdert de marker, laat de rest staan', () => {
  const staat = { causeSig: 'X', laatstGemeldOp: NU.toISOString() };
  const met = schrijfMarker('Rest van de tekst.', staat);
  const zonder = schrijfMarker(met, null);
  assert.equal(leesMarker(zonder), null);
  assert.match(zonder, /Rest van de tekst\./);
});

test('marker: onleesbare of ontbrekende marker geeft null, geen crash', () => {
  assert.equal(leesMarker(''), null);
  assert.equal(leesMarker('geen marker hier'), null);
  assert.equal(leesMarker('<!-- doorstroom-alarm-state: {kapot json -->'), null);
});

// ─── beslisMelding — A4: de kernproef uit de opdracht ──────────────────────────────────────────────

test('A4: twee runs met dezelfde oorzaak → precies één melding; een derde met een andere oorzaak → een nieuwe', () => {
  const causeA = causeSignature(OORDEEL_ROOD_ACHTERSTAND);
  const causeB = causeSignature(OORDEEL_ROOD_BRONRIJEN);
  let opgeslagen = null;
  const gemeld = [];

  // Run 1: eerste keer met oorzaak A.
  let uit = beslisMelding({ uitkomst: 'ROOD', causeSig: causeA, opgeslagen, issueOpen: false, nu: later(0) });
  assert.equal(uit.reden, 'EERSTE_KEER');
  if (uit.melden) gemeld.push(uit.reden);
  opgeslagen = uit.nieuweState;

  // Run 2: zelfde oorzaak A, twee uur later — ruim binnen de periode van 24 uur.
  uit = beslisMelding({
    uitkomst: 'ROOD', causeSig: causeA, opgeslagen, issueOpen: true, nu: later(2), periodeUur: 24,
  });
  assert.equal(uit.melden, false);
  assert.equal(uit.reden, 'ONVERANDERD');
  if (uit.melden) gemeld.push(uit.reden);
  opgeslagen = uit.nieuweState;

  // Run 3: oorzaak B — structureel anders (bronrijen i.p.v. achterstand).
  uit = beslisMelding({
    uitkomst: 'ROOD', causeSig: causeB, opgeslagen, issueOpen: true, nu: later(3), periodeUur: 24,
  });
  assert.equal(uit.melden, true);
  assert.equal(uit.reden, 'NIEUWE_OORZAAK');
  gemeld.push(uit.reden);

  assert.deepEqual(gemeld, ['EERSTE_KEER', 'NIEUWE_OORZAAK']);
});

test('beslisMelding: dezelfde oorzaak meldt opnieuw na de periode, gerekend vanaf de laatste MELDING', () => {
  const causeA = causeSignature(OORDEEL_ROOD_ACHTERSTAND);
  let uit = beslisMelding({ uitkomst: 'ROOD', causeSig: causeA, opgeslagen: null, nu: later(0) });
  const staatNaEersteMelding = uit.nieuweState;

  // Twee controles binnen de periode: geen van beide meldt, en de staat (dus het "laatst gemeld"
  // tijdstip) verandert niet — anders zou de klok bij elke stille controle opnieuw beginnen.
  uit = beslisMelding({
    uitkomst: 'ROOD', causeSig: causeA, opgeslagen: staatNaEersteMelding, nu: later(10), periodeUur: 24,
  });
  assert.equal(uit.melden, false);
  assert.deepEqual(uit.nieuweState, staatNaEersteMelding);

  uit = beslisMelding({
    uitkomst: 'ROOD', causeSig: causeA, opgeslagen: staatNaEersteMelding, nu: later(23), periodeUur: 24,
  });
  assert.equal(uit.melden, false);

  // Na 24 uur sinds de LAATSTE melding (niet sinds de laatste controle) meldt hij opnieuw.
  uit = beslisMelding({
    uitkomst: 'ROOD', causeSig: causeA, opgeslagen: staatNaEersteMelding, nu: later(25), periodeUur: 24,
  });
  assert.equal(uit.melden, true);
  assert.equal(uit.reden, 'PERIODIEK');
});

// ─── beslisMelding — A3: opgelost meldt precies één keer ──────────────────────────────────────────

test('A3: GROEN met een open issue meldt "opgelost" precies één keer, daarna niet opnieuw', () => {
  const causeA = causeSignature(OORDEEL_ROOD_ACHTERSTAND);
  const naRood = beslisMelding({ uitkomst: 'ROOD', causeSig: causeA, opgeslagen: null, nu: later(0) }).nieuweState;

  const opgelost = beslisMelding({
    uitkomst: 'GROEN', causeSig: causeSignature(OORDEEL_GROEN), opgeslagen: naRood, issueOpen: true, nu: later(1),
  });
  assert.equal(opgelost.melden, true);
  assert.equal(opgelost.reden, 'OPGELOST');
  assert.equal(opgelost.nieuweState, null);

  // Het issue is nu dicht: een volgende GROEN-run zonder open issue meldt niets nieuws.
  const nogGroen = beslisMelding({
    uitkomst: 'GROEN', causeSig: causeSignature(OORDEEL_GROEN), opgeslagen: opgelost.nieuweState, issueOpen: false, nu: later(2),
  });
  assert.equal(nogGroen.melden, false);
  assert.equal(nogGroen.reden, 'GEEN_ALARM_OPEN');
});

test('GROEN sluit ook een issue zonder marker (migratiegeval: issue van vóór deze reparatie)', () => {
  const uit = beslisMelding({
    uitkomst: 'GROEN', causeSig: causeSignature(OORDEEL_GROEN), opgeslagen: null, issueOpen: true, nu: later(0),
  });
  assert.equal(uit.melden, true);
  assert.equal(uit.reden, 'OPGELOST');
});

// ─── beslisMelding — GEEL blijft ongewijzigd ───────────────────────────────────────────────────────

test('GEEL meldt niet, sluit niet, en laat de staat ongemoeid', () => {
  const staat = { causeSig: 'X', laatstGemeldOp: NU.toISOString() };
  const uit = beslisMelding({ uitkomst: 'GEEL', causeSig: 'Y', opgeslagen: staat, issueOpen: true, nu: later(0) });
  assert.equal(uit.melden, false);
  assert.equal(uit.reden, 'GEEL_ONGEWIJZIGD');
  assert.deepEqual(uit.nieuweState, staat);
});
