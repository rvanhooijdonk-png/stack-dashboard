import test from 'node:test';
import assert from 'node:assert/strict';

import { oorzaakCode, oorzaakCodeUitTekst, stabielDeel, magMelden, HERHAAL_UREN } from '../scripts/lib/alarm-drempel.mjs';

const UUR = 3600 * 1000;

// --- Bevinding 28-07-2026 (order ALARM-DAT-ELKE-RUN-MAILT, rode test A4) ---

test('twee runs met dezelfde oorzaak binnen het venster geven één melding, een derde met een andere oorzaak wél', () => {
  const nu0 = Date.parse('2026-07-28T00:00:00Z');
  const eerdereMeldingen = [];

  // Run 1: nieuwe oorzaak (kanaalpost geen-stand) — mag.
  const r1 = magMelden(eerdereMeldingen, 'kanaalpost-geen-stand', nu0);
  assert.equal(r1.mag, true);
  eerdereMeldingen.push({ code: 'kanaalpost-geen-stand', momentMs: nu0 });

  // Run 2, twee uur later, zelfde oorzaak — mag niet nog eens.
  const nu1 = nu0 + 2 * UUR;
  const r2 = magMelden(eerdereMeldingen, 'kanaalpost-geen-stand', nu1);
  assert.equal(r2.mag, false);
  assert.match(r2.reden, /al gemeld binnen het herhaalvenster/);

  // Run 3, vier uur later, ANDERE oorzaak — mag wél.
  const nu2 = nu0 + 4 * UUR;
  const r3 = magMelden(eerdereMeldingen, 'achterstand-bron-niet-gepubliceerd', nu2);
  assert.equal(r3.mag, true);
});

test('na afloop van het herhaalvenster mag dezelfde oorzaak opnieuw', () => {
  const nu0 = Date.parse('2026-07-28T00:00:00Z');
  const eerdereMeldingen = [{ code: 'uitvoerder-gefaald', momentMs: nu0 }];
  const buitenVenster = nu0 + (HERHAAL_UREN + 1) * UUR;
  const r = magMelden(eerdereMeldingen, 'uitvoerder-gefaald', buitenVenster);
  assert.equal(r.mag, true);
});

test('twee afwisselende oorzaken maken elkaar niet om beurten "nieuw"', () => {
  // Vergelijk tegen ALLE meldingen in het venster, niet alleen de laatste.
  const nu0 = Date.parse('2026-07-28T00:00:00Z');
  const eerdereMeldingen = [
    { code: 'a', momentMs: nu0 },
    { code: 'b', momentMs: nu0 + 1 * UUR },
  ];
  const r = magMelden(eerdereMeldingen, 'a', nu0 + 2 * UUR);
  assert.equal(r.mag, false, '"a" stond al in het venster, ook al was "b" de laatste melding');
});

test('een melding zonder geldig moment telt niet mee als eerdere melding', () => {
  const nu = Date.parse('2026-07-28T00:00:00Z');
  const r = magMelden([{ code: 'x', momentMs: NaN }, { code: 'x' }], 'x', nu);
  assert.equal(r.mag, true);
});

// --- oorzaakCode: stabiel, gesorteerd, alleen niet-groene delen ---

test('oorzaakCode negeert groene deeloordelen en sorteert de rest', () => {
  const oordeel = {
    bron: { ok: true },
    kanaalpost: { uitkomst: 'GEEL', reden: null },
    achterstand: { uitkomst: 'ROOD', reden: 'BRON_NIET_GEPUBLICEERD' },
    stempel: { uitkomst: 'GROEN' },
    bronRijen: { uitkomst: 'ROOD', reden: 'RIJEN_WEGGEVALLEN' },
  };
  const code = oorzaakCode(oordeel);
  assert.equal(code, 'achterstand-bron-niet-gepubliceerd,bronrijen-rijen-weggevallen,kanaalpost-geel');
});

test('oorzaakCode is deterministisch ongeacht sleutelvolgorde in het object', () => {
  const a = oorzaakCode({ achterstand: { uitkomst: 'ROOD', reden: 'X' }, stempel: { uitkomst: 'ROOD', reden: 'Y' } });
  const b = oorzaakCode({ stempel: { uitkomst: 'ROOD', reden: 'Y' }, achterstand: { uitkomst: 'ROOD', reden: 'X' } });
  assert.equal(a, b);
});

test('ontbrekend of niet-object oordeel geeft de vaste uitvoerder-gefaald-code', () => {
  assert.equal(oorzaakCode(null), 'uitvoerder-gefaald');
  assert.equal(oorzaakCode(undefined), 'uitvoerder-gefaald');
  assert.equal(oorzaakCode('kapot'), 'uitvoerder-gefaald');
});

test('alle deeloordelen groen geeft de onbekend-code, niet een lege string', () => {
  const code = oorzaakCode({ achterstand: { uitkomst: 'GROEN' }, stempel: { uitkomst: 'GROEN' } });
  assert.equal(code, 'onbekend');
});

// --- terugvinden uit eerder geplaatste alarmtekst ---

test('oorzaakCodeUitTekst leest het merkteken uit een geplaatste alarmtekst terug', () => {
  const tekst = 'Run: https://x/y/actions/runs/1\nMoment: 2026-07-28T04:48:56Z (aanleiding: schedule)\n\n'
    + 'kanaalpost: 282 gezien — GEEL\noorzaakcode: kanaalpost-geel';
  assert.equal(oorzaakCodeUitTekst(tekst), 'kanaalpost-geel');
});

test('ontbrekend merkteken geeft null, geen gok', () => {
  assert.equal(oorzaakCodeUitTekst('geen merkteken hier'), null);
});

// --- Codex-bevinding 2 (28-07-2026): stabielDeel saneert vluchtige delen vóór opname in de code ---

test('stabielDeel strip vrije tekst/dynamische teller na ": "', () => {
  assert.equal(stabielDeel('RIJEN_WEGGEVALLEN: tracker 3/10'), 'RIJEN_WEGGEVALLEN');
  assert.equal(stabielDeel('BRON_ZONDER_RIJENTELLING: X, Y'), 'BRON_ZONDER_RIJENTELLING');
});

test('stabielDeel strip een dynamisch regelnummer achteraan, laat samengestelde code intact', () => {
  assert.equal(stabielDeel('SPIEGEL_ONLEESBAAR/GEEN_TABEL@42'), 'SPIEGEL_ONLEESBAAR/GEEN_TABEL');
  assert.equal(stabielDeel('SPIEGEL_ONLEESBAAR/GEEN_TABEL@7'), 'SPIEGEL_ONLEESBAAR/GEEN_TABEL');
});

test('stabielDeel laat vaste, vlakke codes ongemoeid', () => {
  assert.equal(stabielDeel('STEMPEL_TE_OUD'), 'STEMPEL_TE_OUD');
  assert.equal(stabielDeel('BRON_HTTP_404'), 'BRON_HTTP_404');
});

test('oorzaakCode van twee runs met dezelfde structurele fout maar andere teller wordt identiek', () => {
  const a = oorzaakCode({ bronRijen: { uitkomst: 'ROOD', reden: 'RIJEN_WEGGEVALLEN: tracker 3/10' } });
  const b = oorzaakCode({ bronRijen: { uitkomst: 'ROOD', reden: 'RIJEN_WEGGEVALLEN: tracker 7/10' } });
  assert.equal(a, b, 'de tellerwaarde mag het oorzaakcode niet laten verschillen');
});

test('oorzaakCode van twee runs met hetzelfde patroon maar ander regelnummer wordt identiek', () => {
  const a = oorzaakCode({ kanaalpost: { uitkomst: 'ROOD', reden: 'SPIEGEL_ONLEESBAAR/GEEN_TABEL@42' } });
  const b = oorzaakCode({ kanaalpost: { uitkomst: 'ROOD', reden: 'SPIEGEL_ONLEESBAAR/GEEN_TABEL@99' } });
  assert.equal(a, b, 'het regelnummer mag het oorzaakcode niet laten verschillen');
});

// --- Codex-bevinding 2 (28-07-2026): magMelden vergelijkt per losse deel-oorzaak ---

test('gedeeltelijk herstel (a,b → a) blijft herkend als al bekend, niet als een nieuwe oorzaak', () => {
  const nu0 = Date.parse('2026-07-28T00:00:00Z');
  const eerdereMeldingen = [{ code: 'a,b', momentMs: nu0 }];
  const r = magMelden(eerdereMeldingen, 'a', nu0 + 1 * UUR);
  assert.equal(r.mag, false, '"a" was al onderdeel van de eerder gemelde combinatie "a,b"');
});

test('een nieuwe tweede deel-oorzaak naast een bekende blijft wél een reden om te melden', () => {
  const nu0 = Date.parse('2026-07-28T00:00:00Z');
  const eerdereMeldingen = [{ code: 'a', momentMs: nu0 }];
  const r = magMelden(eerdereMeldingen, 'a,c', nu0 + 1 * UUR);
  assert.equal(r.mag, true, '"c" is nieuw, ook al was "a" al bekend');
  assert.match(r.reden, /nieuwe deel-oorzaak/);
});

test('twee runs met dezelfde structurele fout maar een andere dynamische teller dedupliceren nu wél', () => {
  const nu0 = Date.parse('2026-07-28T00:00:00Z');
  const code1 = oorzaakCode({ bronRijen: { uitkomst: 'ROOD', reden: 'RIJEN_WEGGEVALLEN: tracker 3/10' } });
  const eerdereMeldingen = [{ code: code1, momentMs: nu0 }];
  const code2 = oorzaakCode({ bronRijen: { uitkomst: 'ROOD', reden: 'RIJEN_WEGGEVALLEN: tracker 9/10' } });
  const r = magMelden(eerdereMeldingen, code2, nu0 + 1 * UUR);
  assert.equal(r.mag, false, 'zelfde structurele oorzaak, alleen de teller liep door — dit moet nu matchen');
});
