/**
 * PROEVEN OP HET TESTREGISTER ZELF.
 *
 * Een poort die zelf niet beproefd is, is een poort waarvan niemand weet of hij dichtgaat. Deze
 * proeven doen twee dingen. Ze houden het register synchroon met de schijf — dat werkt ook lokaal,
 * bij een gewone `npm test`, dus een nieuw testbestand valt op zodra je het toevoegt en niet pas in
 * CI. En ze tonen aan dat de TAP-lezer echt onderscheid maakt tussen groen, rood en afwezig; anders
 * zou het register kunnen "slagen" op een uitvoer waarin niets gedraaid heeft.
 *
 * Het register wordt hier NIET uitgevoerd (geen `node --test` in een `node --test`): dat kost een
 * proces per bestand en zou zichzelf recursief aanroepen. De uitvoerende kant draait als eigen stap
 * in publish.yml — juist omdat die stap niet mag afhangen van het slagen van de suite die hij bewaakt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { leesRegister, leesTap, registerVerschil, testbestandenOpSchijf } from '../scripts/testregister.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTER = leesRegister();

test('elk testbestand op schijf staat in het register, en omgekeerd', () => {
  const verschil = registerVerschil(REGISTER, testbestandenOpSchijf());
  assert.deepEqual(verschil.nietGeregistreerd, [], 'nieuw testbestand? zet het in test/register.json');
  assert.deepEqual(verschil.ontbreektOpSchijf, [], 'geregistreerd bestand bestaat niet meer');
});

test('het register verklaart de negen gemeten auditvormen met naam', () => {
  const namen = REGISTER.bestanden['spiegel-catalogus.test.mjs'].moetBevatten;
  for (let i = 1; i <= 9; i += 1) {
    const code = `M-NEG-${String(i).padStart(3, '0')}`;
    assert.ok(namen.some((n) => n.startsWith(`${code} `)), `${code} hoort met naam in het register te staan`);
  }
});

test('elke met naam verklaarde proef is te herleiden tot het bestand waar hij is verklaard', () => {
  // Zonder deze proef kan het register namen bevatten die nergens meer voorkomen; de uitvoerende
  // stap zou dan pas in CI struikelen, en op een moment dat niemand het verwacht.
  //
  // Er wordt op het ANKER gezocht — het stuk vóór de gedachtestreep — en niet op de hele naam. Reden:
  // de negen auditproeven krijgen hun naam bij het draaien uit een tabel (`M-NEG-004 — ${wat} komt
  // niet op de plaat…`), dus die volledige zin staat nergens letterlijk in de bron. Het anker (`M-NEG-004`)
  // staat er wél, en dat is precies het deel dat je niet ongemerkt kunt weghalen. De volledige naam
  // wordt alsnog gecontroleerd, maar tegen de echte TAP-uitvoer — in scripts/testregister.mjs.
  for (const [bestand, eis] of Object.entries(REGISTER.bestanden)) {
    const tekst = readFileSync(join(ROOT, 'test', bestand), 'utf8');
    for (const naam of eis.moetBevatten ?? []) {
      const anker = naam.split(' — ')[0];
      assert.ok(tekst.includes(anker), `"${anker}" is verklaard voor ${bestand} maar staat daar niet in`);
    }
  }
});

test('de ontdekking ziet alles wat node zelf als testbestand draait, niet alleen *.test.mjs', () => {
  // ROOD: keek de ontdekking alleen naar `*.test.mjs` in de bovenste laag, dan draaide `test/x.test.js`
  // of `test/submap/y.mjs` wél mee in CI maar stond het buiten het register — een proefbestand dat
  // niemand heeft verklaard (bevinding review Gemini + Codex, 26-07-2026). Nagemeten op node 24.14.1:
  // node draait élk .js/.mjs/.cjs-bestand onder `test/`, ook in onderliggende mappen.
  const map = mkdtempSync(join(tmpdir(), 'ontdekking-'));
  mkdirSync(join(map, 'submap'));
  for (const naam of ['a.test.mjs', 'b.test.js', 'c.spec.js', 'gewoon.mjs', 'd.cjs', 'submap/e.mjs', 'leesmij.md', 'data.json']) {
    writeFileSync(join(map, naam), '');
  }
  assert.deepEqual(testbestandenOpSchijf(map), ['a.test.mjs', 'b.test.js', 'c.spec.js', 'd.cjs', 'gewoon.mjs', 'submap/e.mjs']);
});

test('de TAP-lezer telt groen, rood en namen los van elkaar', () => {
  const tap = leesTap(['TAP version 13', 'ok 1 - eerste proef', 'not ok 2 - tweede proef', '1..2', '# tests 2', '# pass 1', '# fail 1'].join('\n'));
  assert.equal(tap.pass, 1);
  assert.equal(tap.fail, 1);
  assert.deepEqual([...tap.geslaagd], ['eerste proef']);
  assert.deepEqual(tap.gefaald, ['tweede proef']);
});

test('een uitvoer waarin niets gedraaid heeft, telt als nul — niet als "geen fouten"', () => {
  // Dit is de hele grond onder het register: `node --test` meldt exit 0 en `# fail 0` als het geen
  // enkel bestand vindt. Zo'n uitvoer mag nooit als geslaagd gelezen worden.
  const tap = leesTap(['TAP version 13', '1..0', '# tests 0', '# pass 0', '# fail 0'].join('\n'));
  assert.equal(tap.pass, 0);
  assert.equal(tap.fail, 0);
  assert.equal(tap.geslaagd.size, 0);
});

test('een lege of onbekende TAP-tekst geeft geen stilzwijgend geslaagde telling', () => {
  const tap = leesTap('');
  assert.equal(tap.pass, null, 'geen telling gevonden hoort null te zijn, niet 0-als-in-orde');
  assert.equal(tap.geslaagd.size, 0);
});

test('de verklaarde minima liggen niet boven wat de bestanden nu leveren', () => {
  // Een minimum dat al bij het schrijven te hoog stond, is een poort die rood staat om zichzelf.
  // Hier wordt alleen de vorm gecontroleerd; het echte tellen doet scripts/testregister.mjs.
  for (const [bestand, eis] of Object.entries(REGISTER.bestanden)) {
    assert.ok(Number.isInteger(eis.minimaal) && eis.minimaal > 0, `${bestand}: minimaal hoort een positief geheel getal te zijn`);
    assert.ok(Array.isArray(eis.moetBevatten), `${bestand}: moetBevatten hoort een lijst te zijn`);
  }
  assert.ok(Number.isInteger(REGISTER.ondergrens_totaal) && REGISTER.ondergrens_totaal > 0);
});
