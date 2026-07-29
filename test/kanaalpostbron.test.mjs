import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bronRijenUitKanaalpost, spiegelrijUitBronrij, standUitTekst, weigeringsregel,
} from '../scripts/lib/kanaalpostbron.mjs';
import { BRON_REDENEN } from '../scripts/lib/kanaalpostbron.mjs';
import { overzetting } from '../scripts/lib/doorstroom.mjs';
import { cellenVanRegel, celVeilig, spiegelUitTekst } from '../scripts/lib/kanaalpost.mjs';

const BRONKOP = [
  '| Tab | Wat klaar is | Sha | Richard / Fable | Datum-tijd (UTC) |',
  '|-----|--------------|-----|-----------------|------------------|',
];

const bronrij = (tab, tekst, actie, datum) => `| ${tab} | ${tekst} | \`x@abc1234\` | ${actie} | ${datum} |`;

const GOED = (n = 1) => bronrij('CHIEF', `**STAND:** AFGEROND — melding ${n}`, 'Richard', `2026-07-27 0${n}:00`);

/** Een document met een commentaarkop, precies zoals de echte bron er bovenaan uitziet. */
const KOP = ['<!--', '  KANAALPOST — het doorgeefluik van de stack. Append-only.', '-->', '', '# KANAALPOST', '', ...BRONKOP];
const document = (...rijen) => [...KOP, ...rijen, ''].join('\n');

/** Het regelnummer van de eerste inhoudsrij — een weigering wijst met een regelnummer terug. */
const EERSTE = KOP.length + 1;

test('een commentaarkop weigert niet langer het hele document', () => {
  // DIT IS DE MEETING. `kanoniekeSpiegelvorm` weigert dit document op regel 1 (HTML_COMMENTAAR).
  // Zolang de bron als DOCUMENT beoordeeld werd, leverde dat nul rijen op — zonder dat ergens te
  // zien was dat de kop van het bestand de oorzaak was.
  const r = bronRijenUitKanaalpost(document(GOED(1), GOED(2)));
  assert.equal(r.rijen.length, 2);
  assert.equal(r.geweigerd.length, 0);
});

test('ROOD: één misvormde rij kost één rij, niet het bestand', () => {
  // De rode toets die gevraagd is: laat één misvormde rij staan en bewijs dat de rest doorstroomt.
  const stuk = '| CHIEF | geen stand hier | `x@abc1234` | Richard | 2026-07-27 09:00 |';
  const r = bronRijenUitKanaalpost(document(GOED(1), stuk, GOED(2), GOED(3)));
  assert.equal(r.gezien, 4);
  assert.equal(r.rijen.length, 3, 'de drie goede rijen stromen door');
  assert.deepEqual(r.geweigerd, [{ id: EERSTE + 1, reden: 'GEEN_STAND' }]);
  assert.equal(weigeringsregel(r), '1 rijen geweigerd: GEEN_STAND 1');
});

test('de telling noemt elke weigergrond met een aantal', () => {
  const r = bronRijenUitKanaalpost(document(
    GOED(1),
    '| CHIEF | geen stand | `x` | Richard | 2026-07-27 09:00 |',
    '| CHIEF | ook geen stand | `x` | Richard | 2026-07-27 09:01 |',
    '| deck/ws11 | **STAND:** AFGEROND — wel een stand | `x` | Richard | 2026-07-27 09:02 |',
    '| CHIEF | **STAND:** AFGEROND — zonder datum | `x` | Richard | gisteren |',
  ));
  assert.equal(r.rijen.length, 1);
  assert.deepEqual(r.telling, { GEEN_STAND: 2, TAB_VORM: 1, GEEN_DATUM: 1 });
  assert.equal(weigeringsregel(r), '4 rijen geweigerd: GEEN_STAND 2, TAB_VORM 1, GEEN_DATUM 1');
});

test('geen weigering is ook een telling', () => {
  assert.equal(weigeringsregel(bronRijenUitKanaalpost(document(GOED(1)))), '0 rijen geweigerd');
});

test('een stand die de spiegel niet kent wordt niet stil vertaald', () => {
  // MERGEABLE is een echte stand in het werkwijze-sjabloon, maar niet in de statuslijst van de
  // spiegel. Hem op AFGEROND zetten zou een niet-gemeten status publiceren die er precies zo
  // uitziet als een gemeten status.
  const r = bronRijenUitKanaalpost(document(bronrij('CHIEF', '**STAND:** MERGEABLE — klaar', 'Richard', '2026-07-27 09:00')));
  assert.deepEqual(r.geweigerd, [{ id: EERSTE, reden: 'STAND_ONBEKEND' }]);
  assert.equal(standUitTekst('**STAND:** MERGEABLE — klaar').gevonden, 'MERGEABLE');
});

test('een ge-escapete pipe blijft één cel en blijft er één', () => {
  // Twee kanten: de bron leest `\|` als tekst, en de omgezette rij schrijft hem terug als tekst.
  // Zonder het tweede werd de rij een kolom breder en viel hij als GEEN_RIJ om — geweigerd om iets
  // wat de omzetting zelf had gedaan.
  const r = spiegelrijUitBronrij(bronrij('CHIEF', '**MELD @ CHIEF \\| 08:12** **STAND:** AFGEROND', 'Richard', '2026-07-27 08:12'));
  assert.equal(r.ok, true);
  assert.equal(r.regel.slice(1, -1).split(/(?<!\\)\|/).length, 5);
  const gelezen = spiegelUitTekst([
    '| datum-tijd | tab-rol | onderwerp | status | actie voor |',
    '| --- | --- | --- | --- | --- |',
    r.regel,
  ].join('\n'));
  assert.equal(gelezen.length, 1);
  assert.match(gelezen[0].onderwerp, /MELD @ CHIEF \| 08:12/);
});

test('de kop en de scheidingsregel van de bron tellen niet als rij', () => {
  const r = bronRijenUitKanaalpost(document(GOED(1)));
  assert.equal(r.gezien, 1);
});

test('een rij met te weinig of te veel kolommen draagt KOLOMMEN', () => {
  const r = bronRijenUitKanaalpost(document('| CHIEF | te kort | 2026-07-27 09:00 |'));
  assert.deepEqual(r.geweigerd, [{ id: EERSTE, reden: 'KOLOMMEN' }]);
});

test('de aanlevertijd komt uit de rij zelf, niet uit de bouwtijd', () => {
  // Anders lijkt elke rij vers op het moment dat de doorstroom draait, en dan meet de
  // achterstandstoets zijn eigen looptijd in plaats van de achterstand.
  const r = bronRijenUitKanaalpost(document(bronrij('CHIEF', '**STAND:** AFGEROND — x', 'Richard', '2026-07-26 07:15')));
  assert.equal(r.rijen[0].geleverdOp.toISOString(), '2026-07-26T07:15:00.000Z');
});

test('de omgezette rijen komen door de spiegelpoort zonder de wet te raken', () => {
  const spiegel = [
    '| datum-tijd | tab-rol | onderwerp | status | actie voor |',
    '| --- | --- | --- | --- | --- |',
    '| 2026-07-25 22:15 | CHIEF | een bestaande rij | AFGEROND | - |',
  ].join('\n');
  const r = bronRijenUitKanaalpost(document(GOED(1), GOED(2)));
  const uit = overzetting(spiegel, r.rijen);
  assert.equal(uit.overgezet.length, 2);
  assert.equal(uit.geweigerd.length, 0);
  assert.match(uit.tekst, /een bestaande rij/, 'de bestaande regel blijft staan');
  assert.equal(spiegelUitTekst(uit.tekst).length, 3);
});

test('een rij die er al staat is geen weigering en geen overzetting', () => {
  const r = bronRijenUitKanaalpost(document(GOED(1)));
  const spiegel = [
    '| datum-tijd | tab-rol | onderwerp | status | actie voor |',
    '| --- | --- | --- | --- | --- |',
    r.rijen[0].regel,
  ].join('\n');
  const uit = overzetting(spiegel, r.rijen);
  assert.equal(uit.overgezet.length, 0);
  assert.equal(uit.geweigerd.length, 0);
  assert.equal(uit.ongewijzigd, true);
});

test('een onbestaande datum is geen datum', () => {
  const r = bronRijenUitKanaalpost(document(bronrij('CHIEF', '**STAND:** AFGEROND — x', 'Richard', '2026-02-30 09:00')));
  assert.deepEqual(r.geweigerd, [{ id: EERSTE, reden: 'GEEN_DATUM' }]);
});

test('een tijd met een andere zone gaat NIET door als UTC', () => {
  // Deze rij zou anders twee uur te vroeg gepubliceerd worden — een fout die er op de plaat
  // precies zo uitziet als een goede rij, en die de achterstandstoets vervolgens meet.
  const zone = bronRijenUitKanaalpost(document(bronrij('CHIEF', '**STAND:** AFGEROND — x', 'Richard', '2026-07-27 13:41 CEST')));
  assert.deepEqual(zone.geweigerd, [{ id: EERSTE, reden: 'GEEN_DATUM' }]);
  const utc = bronRijenUitKanaalpost(document(bronrij('CHIEF', '**STAND:** AFGEROND — x', 'Richard', '2026-07-27 13:41 UTC')));
  assert.equal(utc.rijen[0].geleverdOp.toISOString(), '2026-07-27T13:41:00.000Z');
});

test('een toelichting ACHTER de UTC-markering mag, ervoor niet', () => {
  // Beide vormen staan in de echte bron. Het verschil is niet cosmetisch: bij de eerste is de tijd
  // vóór de haakjes de UTC-tijd, bij de tweede is dat de lokale tijd en staat de UTC-tijd erin.
  const mag = bronRijenUitKanaalpost(document(bronrij('CHIEF', '**STAND:** AFGEROND — x', 'Richard', '2026-07-26 06:47 UTC (08:47 lokaal)')));
  assert.equal(mag.rijen[0]?.geleverdOp.toISOString(), '2026-07-26T06:47:00.000Z');
  const magNiet = bronRijenUitKanaalpost(document(bronrij('CHIEF', '**STAND:** AFGEROND — x', 'Richard', '2026-07-27 13:32 NL (11:32 UTC)')));
  assert.deepEqual(magNiet.geweigerd, [{ id: EERSTE, reden: 'GEEN_DATUM' }]);
});

test('een toelichting kan geen kolom of opmaak de plaat in dragen', () => {
  // De publieke datum wordt opnieuw opgebouwd uit de vangsten; wat er tussen de haakjes staat
  // haalt de plaat nooit. Een rij zónder hoofdtijd maar mét een tijd in de toelichting wordt
  // geweigerd — anders publiceerde hij als middernacht.
  // De pipe staat ge-escaped in de bron: kaal zou hij een ECHTE kolomgrens zijn en strandde de rij
  // al op KOLOMMEN. Ge-escaped komt hij als tekst in de datumcel — en juist dan is de vraag echt.
  const r = bronRijenUitKanaalpost(document(bronrij('CHIEF', '**STAND:** AFGEROND — x', 'Richard', '2026-07-26 06:47 UTC (08:47 \\| lokaal <b>)')));
  assert.equal(r.rijen.length, 1);
  assert.match(r.rijen[0].regel, /^\| 2026-07-26 06:47 \| CHIEF \|/);
  assert.doesNotMatch(r.rijen[0].regel, /lokaal|<b>/);
  const zonderHoofdtijd = bronRijenUitKanaalpost(document(bronrij('CHIEF', '**STAND:** AFGEROND — x', 'Richard', '2026-07-26 UTC (08:47 lokaal)')));
  assert.deepEqual(zonderHoofdtijd.geweigerd, [{ id: EERSTE, reden: 'GEEN_DATUM' }]);
});

test('rommel rondom een datum wordt niet stil weggeknipt', () => {
  const r = bronRijenUitKanaalpost(document(bronrij('CHIEF', '**STAND:** AFGEROND — x', 'Richard', 'circa 2026-07-27 09:00 (schatting)')));
  assert.deepEqual(r.geweigerd, [{ id: EERSTE, reden: 'GEEN_DATUM' }]);
});

test('rijen in een codeblok of commentaar zijn BUITEN_TABEL, niet onzichtbaar', () => {
  // Fail-closed én zichtbaar: ze tellen mee in `gezien` en dragen een grond, zodat een bron die
  // per ongeluk in een codeblok belandt niet als "niets aangeleverd" verschijnt.
  const r = bronRijenUitKanaalpost(document(GOED(1), '```', GOED(2), '```', GOED(3)));
  assert.equal(r.gezien, 3);
  assert.equal(r.rijen.length, 2);
  assert.deepEqual(r.geweigerd, [{ id: EERSTE + 2, reden: 'BUITEN_TABEL' }]);
});

test('een merge-conflict weigert wél het HELE document', () => {
  // De enige plek waar documentweigering nog juist is: bij twee armen weet niemand welke waar is,
  // en per rij doorlaten zou beide publiceren.
  const r = bronRijenUitKanaalpost(document(GOED(1), '<<<<<<< HEAD', GOED(2), '=======', GOED(3), '>>>>>>> tak'));
  assert.equal(r.ok, false);
  assert.equal(r.reden, 'BRON_CONFLICT');
  assert.equal(r.rijen.length, 0);
});

test('een bron zonder kop levert niets en zegt dat', () => {
  const r = bronRijenUitKanaalpost(['# KANAALPOST', '', GOED(1)].join('\n'));
  assert.equal(r.ok, false);
  assert.equal(r.reden, 'BRON_GEEN_KOP');
  assert.equal(r.rijen.length, 0);
  assert.deepEqual(r.geweigerd, [{ id: 3, reden: 'BUITEN_TABEL' }]);
});

test('elke weigergrond komt uit de gesloten lijst', () => {
  // Anders lekt een grond uit een ander mechanisme de telling in, en betekent dezelfde naam
  // morgen iets anders dan vandaag.
  const r = bronRijenUitKanaalpost(document(
    GOED(1),
    '| CHIEF | geen stand | `x` | Richard | 2026-07-27 09:00 |',
    '| deck/ws11 | **STAND:** AFGEROND — x | `x` | Richard | 2026-07-27 09:01 |',
    '| CHIEF | te kort |',
    bronrij('CHIEF', '**STAND:** MERGEABLE — x', 'Richard', '2026-07-27 09:02'),
    bronrij('CHIEF', '**STAND:** AFGEROND — x', 'Richard', 'gisteren'),
  ));
  for (const g of r.geweigerd) assert.ok(BRON_REDENEN.includes(g.reden), `onbekende grond: ${g.reden}`);
});

test('een dubbele backslash vlak voor een pipe is een kolomgrens, geen tekst', () => {
  // `\\|` is een ge-escapete backslash gevolgd door een ECHTE grens. Een lezer die alleen naar het
  // teken ervoor kijkt, plakt hier twee kolommen aan elkaar — en dan zijn er twee lezers die het
  // oneens zijn over waar de kolommen liggen.
  assert.deepEqual(cellenVanRegel('| a\\\\ | b |'), ['a\\', 'b']);
  assert.deepEqual(cellenVanRegel('| a\\| b |'), ['a| b']);
  assert.equal(cellenVanRegel('geen rij'), null);
});

test('celVeilig is de omkering van de lezer', () => {
  for (const tekst of ['a|b', 'a\\b', 'a\\|b', 'a\\\\|b', 'gewoon']) {
    assert.deepEqual(cellenVanRegel(`| ${celVeilig(tekst)} | x |`), [tekst, 'x'], tekst);
  }
});
