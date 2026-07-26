/**
 * SPIEGELWET — tests op de regel die ik zelf heb overtreden (zie `lib/spiegelwet.mjs`). De eerste
 * test is exact het geval dat toen misging: een regel die er stond, is er niet meer.
 *
 * De tweede groep test de grens die na de review van Codex is verschoven: een regel die van plaats
 * verandert doordat twee takken elk hebben aangevuld, is GEEN overtreding maar een melding. Zonder
 * die grens piept de bewaker vals bij elke samenvoeging, en een bewaker die vals piept gaat uit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  alleenAangevuld, canoniek, nietCanoniekeRegels, nieuweNietCanoniekeRegels,
} from '../scripts/lib/spiegelwet.mjs';
import { alarmRij, alarmRijPubliceerbaar } from '../scripts/lib/waarnemer.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const drie = 'kop\n| a |\n| b |\n';

// --- hard: niets mag verdwijnen -----------------------------------------------------------------

test('een verwijderde regel is een overtreding, ook als de rest klopt', () => {
  const r = alleenAangevuld(drie, 'kop\n| a |\n');
  assert.equal(r.ok, false);
  assert.equal(r.verdwenen, 1);
});

test('een herschreven regel is een overtreding: de oude tekst is dan verdwenen', () => {
  const r = alleenAangevuld(drie, 'kop\n| A |\n| b |\n');
  assert.equal(r.ok, false);
  assert.equal(r.verdwenen, 1);
});

test('twee identieke regels mogen niet stilletjes één worden', () => {
  const r = alleenAangevuld('kop\n| a |\n| a |\n', 'kop\n| a |\n');
  assert.equal(r.ok, false);
  assert.equal(r.verdwenen, 1);
});

test('aanvullen achteraan mag', () => {
  const r = alleenAangevuld(drie, `${drie}| c |\n`);
  assert.equal(r.ok, true);
  assert.equal(r.opOrde, true);
});

test('niets veranderen mag', () => {
  assert.equal(alleenAangevuld(drie, drie).ok, true);
});

test('een nog niet bestaande spiegel mag met inhoud beginnen', () => {
  assert.equal(alleenAangevuld('', 'kop\n| a |\n').ok, true);
});

// --- zacht: de volgorde ------------------------------------------------------------------------

test('een regel die door een samenvoeging opschuift is geen overtreding, maar wel een melding', () => {
  const r = alleenAangevuld(drie, 'kop\n| tussen |\n| a |\n| b |\n');
  assert.equal(r.ok, true, 'niets verdwenen, dus geen overtreding');
  assert.equal(r.opOrde, false, 'de volgorde is wel afgeweken');
  assert.equal(r.eerste, 2);
});

test('twee takken die elk aanvullen zijn te verenigen zonder vals alarm', () => {
  const takA = `${drie}| uit tak A |\n`;
  const samen = `${drie}| uit main |\n| uit tak A |\n`;
  assert.equal(alleenAangevuld(takA, samen).ok, true);
  assert.equal(alleenAangevuld(drie, samen).ok, true);
});

// --- de uitkomst lekt niets --------------------------------------------------------------------

test('de uitkomst bevat geen inhoud uit de spiegel', () => {
  const r = alleenAangevuld('kop\n| gevoelig onderwerp |\n', 'kop\n');
  assert.equal(JSON.stringify(r).includes('gevoelig'), false);
});

// --- de schrijfkant: één canonieke vorm in de spiegel zelf --------------------------------------
// Besluit Fable 26-07-2026, punt 3: normaliseren mag op de leeskant, maar de spiegel zelf houdt één
// vorm aan. Anders bestaan er twee schrijfwijzen van dezelfde regel die de leeskant gelijk noemt.

test('gewone tekst met accenten en gedachtestreepjes is canoniek', () => {
  assert.equal(canoniek('| 2026-07-26 14:35 | CONTROL | héél gewoon — met streepje | AFGEROND | niemand |'), true);
});

test('een compatibiliteitsteken is niet canoniek — juist die worden later stilletijk gelijk', () => {
  assert.equal(canoniek('10²'), false, 'NFKC maakt hier 102 van');
  assert.equal(canoniek('tekst…'), false, 'NFKC maakt hier drie punten van');
  assert.equal(canoniek('eﬀect'), false, 'NFKC maakt hier ff van');
});

test('een onzichtbaar teken is niet canoniek', () => {
  assert.equal(canoniek('a​b'), false);
  assert.equal(canoniek('a﻿b'), false);
  assert.equal(canoniek('a­b'), false);
});

test('tweemaal dezelfde vraag geeft tweemaal hetzelfde antwoord', () => {
  // Met een `g`-vlag onthoudt de regex zijn `lastIndex` en antwoordt om en om true/false. Een bewaker
  // die afwisselend werkt is geen bewaker, dus dit staat vast in een test.
  const zw = 'a​b';
  assert.equal(canoniek(zw), false);
  assert.equal(canoniek(zw), false);
  assert.equal(canoniek(zw), false);
});

test('alleen tabelregels tellen, met regelnummer en de tekens erbij', () => {
  const uit = nietCanoniekeRegels('| a | 10² | b |\nproza met ² valt erbuiten\n| c​d |\n| schoon |');
  assert.deepEqual(uit, [
    { regel: 1, tekens: ['U+00B2'] },
    { regel: 3, tekens: ['U+200B'] },
  ]);
});

test('de echte spiegel voldoet — de nulmeting die deze eis draagt', () => {
  // Als deze test ooit rood wordt, is er een regel bijgekomen die de eis niet haalt; dan is de fout
  // die regel en niet deze test.
  assert.deepEqual(nietCanoniekeRegels(readFileSync(join(ROOT, 'data/kanaalpost-publiek.md'), 'utf8')), []);
});

// --- de gaten die de review van 26-07-2026 aanwees ----------------------------------------------

test('een BOM voor de regel ontsnapt niet meer aan de vormcontrole', () => {
  // `trim()` haalt in JavaScript ook een BOM en een harde spatie weg. Wie de getrimde regel
  // beoordeelde noemde deze rij canoniek, terwijl de parser hem daarna gewoon publiceert.
  const uit = nietCanoniekeRegels('\uFEFF| 2026-07-26 14:35 | CONTROL | tekst | AFGEROND | niemand |');
  assert.deepEqual(uit, [{ regel: 1, tekens: ['U+FEFF'] }]);
});

test('een harde spatie aan het eind van de regel evenmin', () => {
  const uit = nietCanoniekeRegels('| a | b |\u00A0');
  assert.deepEqual(uit, [{ regel: 1, tekens: ['U+00A0'] }]);
});

test('een regel die met een zero-width space begint valt nog steeds binnen de controle', () => {
  const uit = nietCanoniekeRegels('\u200B| a | b |');
  assert.deepEqual(uit, [{ regel: 1, tekens: ['U+200B'] }]);
});

test('een NFD-accent krijgt een leesbare melding in plaats van een lege', () => {
  const uit = nietCanoniekeRegels('| cafe\u0301 | b |');
  assert.equal(uit.length, 1);
  assert.deepEqual(uit[0].tekens, ['samengesteld teken (NFD-accent of ligatuur)']);
});

test('de bredere tekenverzameling van de leeskant geldt nu ook op de schrijfkant', () => {
  // Deze drie zaten NIET in het eerste, eigen lijstje van de spiegelwet, wel in dat van kanaalpost:
  // een bidi-override, een variation selector en een C1-stuurteken.
  assert.equal(canoniek('a\u202Eb'), false);
  assert.equal(canoniek('a\uFE0Fb'), false);
  assert.equal(canoniek('a\u0085b'), false);
});

test('de poort kijkt naar wat er NIEUW bij komt, niet naar wat er al stond', () => {
  const oud = '| a | 10\u00B2 |\n| schoon |';
  const nieuw = `${oud}\n| ook schoon |`;
  assert.deepEqual(nieuweNietCanoniekeRegels(oud, nieuw), [], 'een oude vuile regel blokkeert de deur niet');
  assert.equal(nietCanoniekeRegels(nieuw).length, 1, 'maar hij blijft wel zichtbaar in de audit');
});

test('een nieuwe vuile regel wordt wel geweigerd, ook als hij op een oude lijkt', () => {
  const oud = '| a | 10\u00B2 |';
  const uit = nieuweNietCanoniekeRegels(oud, `${oud}\n| a | 10\u00B2 |`);
  assert.deepEqual(uit, [{ regel: 2, tekens: ['U+00B2'] }], 'twee gelijke regels delen niet een oude regel als dekmantel');
});

// --- de waarnemer krijgt geen uitzondering op zijn eigen wet -------------------------------------

test('een afgekapte alarmregel eindigt op drie punten en blijft canoniek', () => {
  const rij = alarmRij({ bevindingen: [{ code: 'PAGINA_TOONT_OUDE_DATA', uitleg: 'x'.repeat(900) }], nu: Date.parse('2026-07-26T14:35:00Z') });
  assert.ok(rij.includes('...'), 'de lange uitleg hoort afgekapt te zijn');
  assert.equal(rij.includes('....'), false, 'en niet op vier punten — de punt van de zin hoort dan te vervallen');
  assert.equal(rij.includes('…'), false, 'niet met het teken dat NFKC ontleedt');
  assert.equal(canoniek(rij), true);
});

test('een niet-canonieke regel wordt niet publiceerbaar genoemd', () => {
  const goed = alarmRij({ bevindingen: [{ code: 'STEMPEL_TE_OUD', uitleg: 'de pagina is ouder dan de drempel' }], nu: Date.parse('2026-07-26T14:35:00Z') });
  assert.equal(alarmRijPubliceerbaar(goed), true);
  assert.equal(alarmRijPubliceerbaar(goed.replace('drempel', 'drempel​')), false, 'onzichtbaar teken hoort hem tegen te houden');
  assert.equal(alarmRijPubliceerbaar(goed.replace('drempel', 'drempel…')), false, 'afkap-teken ook');
});
