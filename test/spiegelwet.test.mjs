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

import { createHash } from 'node:crypto';

import {
  alleenAangevuld, canoniek, nietCanoniekeRegels, nieuweNietCanoniekeRegels, nieuweDuplicaten,
  publiekeAfwijkingen,
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

// De uitzonderingen op de vormeis in het ECHTE bestand, elk vastgezet op de exacte regel.
//
// Waarom een hash en niet alleen het teken: bindt je de uitzondering aan "ergens één regel met een
// U+2026", dan kan iemand de historische regel weghalen en elders een verse regel met een ellips
// neerzetten — de telling blijft één en de test blijft groen (bevinding Gemini + Codex, 26-07-2026,
// met een bewezen tegenvoorbeeld waarin een NFD-accent aan dezelfde regel werd toegevoegd). Met de
// hash erbij is de uitzondering die ene regel, en niets anders.
//
// U+2026 is de horizontale ellips (…). NFKC maakt daar drie losse punten van, dus de ellips haalt de
// schrijfeis niet. Deze regel van 14:10 stond al op de hoofdlijn toen de eis er kwam en mag daar niet
// meer weg (append-only), dus hij blijft staan als waarschuwing. Nieuwe regels typen drie punten.
// Dat de eis normale typografie raakt, is een openstaand punt voor Fable — zie het rapport.
const UITZONDERINGEN = [
  { regel: 68, tekens: ['U+2026'], sha256: 'c67cd796b0af5e0c4b7d6ab30f9a55ea637ec6896bd2e781cb824aaadcc2dbc9' },
];

test('de echte spiegel voldoet — de nulmeting die deze eis draagt', () => {
  // De harde eis geldt voor NIEUWE regels; een regel die al gepubliceerd is mag niet verdwijnen, dus
  // een oude regel die de vorm niet haalt blijft staan en is een waarschuwing. Wordt deze test rood,
  // dan is er een regel bijgekomen die de eis niet haalt, of is een uitzonderingsregel herschreven —
  // in beide gevallen is de fout die regel en niet deze test.
  const bestand = readFileSync(join(ROOT, 'data/kanaalpost-publiek.md'), 'utf8');
  const regels = bestand.split('\n');
  const gevonden = nietCanoniekeRegels(bestand);

  assert.deepEqual(
    gevonden.map((b) => ({ regel: b.regel, tekens: b.tekens })),
    UITZONDERINGEN.map((u) => ({ regel: u.regel, tekens: u.tekens })),
  );
  for (const u of UITZONDERINGEN) {
    const hash = createHash('sha256').update(regels[u.regel - 1] ?? '', 'utf8').digest('hex');
    assert.equal(hash, u.sha256, `regel ${u.regel} is niet meer de regel waarvoor de uitzondering geldt`);
  }
});

test('het bestand eindigt op een regeleinde — anders plakt de volgende melding vast aan de vorige', () => {
  // Zonder afsluitend regeleinde schrijft de volgende toevoeging zijn rij achter de laatste rij aan.
  // Dat herschrijft een gepubliceerde regel én laat de nieuwe melding als aparte rij verdwijnen: twee
  // meldingen worden één (bevinding Gemini, 26-07-2026 — de fout stond op dat moment echt in dit
  // bestand, ik had hem er bij het oplossen van een conflict in gezet).
  //
  // Wat hier eerst stond en niet klopte: dat geen van beide poorten dat ziet. `alleenAangevuld` telt de
  // vastgeplakte regel wél als verdwenen (nagemeten Codex, 26-07-2026 — zie de test hieronder). Het
  // gevolg is dus geen stille publicatie maar een alarm dat niet geschreven kán worden, en dat is
  // even stil. Vandaar dat de bot het regeleinde zelf rechtzet in plaats van erop te vertrouwen.
  const bestand = readFileSync(join(ROOT, 'data/kanaalpost-publiek.md'), 'utf8');
  assert.equal(bestand.endsWith('\n'), true);
  assert.equal(bestand.endsWith('\n\n'), false);
});

test('een samengesteld teken lift niet mee op een los teken dat al gemeld werd', () => {
  // Het bewezen tegenvoorbeeld van Codex: zet naast de ellips ook een NFD-accent in dezelfde regel.
  // Vóór de fix bleef de melding letterlijk ['U+2026'] en bleef een test die daarop vertrouwde groen.
  const met = nietCanoniekeRegels('| 2026-07-26 14:10 | X | tekst… en café | AFGEROND | geen |');
  assert.deepEqual(met, [{ regel: 1, tekens: ['U+2026', 'samengesteld teken (NFD-accent of ligatuur)'] }]);
  // En zonder dat accent blijft de melding precies dat ene teken — geen valse tweede oorzaak.
  const zonder = nietCanoniekeRegels('| 2026-07-26 14:10 | X | tekst… en café'.normalize('NFC') + ' |');
  assert.deepEqual(zonder, [{ regel: 1, tekens: ['U+2026'] }]);
});

// --- de andere kant van de wet: er mag ook niet stilletjes een regel BIJ komen ------------------

test('dezelfde regel er een tweede keer bij is een overtreding', () => {
  // Precies wat er bij het omhangen van deze tak gebeurde: een samenvoeging plakte dezelfde
  // WAARNEMER-regel nog een keer onderaan, en append-only zag daar niets van (bevinding Codex).
  const uit = nieuweDuplicaten('kop\n| a |\n| b |\n', 'kop\n| a |\n| b |\n| a |\n');
  assert.deepEqual(uit, [{ regel: 4, aantal: 2, toegestaan: 1 }]);
});

test('gewoon aanvullen is geen duplicaat', () => {
  assert.deepEqual(nieuweDuplicaten('kop\n| a |\n', 'kop\n| a |\n| b |\n'), []);
});

test('twee gelijke regels die er al stonden mogen blijven — weghalen mag immers niet', () => {
  assert.deepEqual(nieuweDuplicaten('kop\n| a |\n| a |\n', 'kop\n| a |\n| a |\n| b |\n'), []);
  // Maar een DERDE exemplaar is nieuw.
  assert.deepEqual(
    nieuweDuplicaten('kop\n| a |\n| a |\n', 'kop\n| a |\n| a |\n| a |\n'),
    [{ regel: 4, aantal: 3, toegestaan: 2 }],
  );
});

test('proza dat toevallig twee keer voorkomt telt niet mee — alleen tabelregels', () => {
  assert.deepEqual(nieuweDuplicaten('kop\nzelfde zin\n', 'kop\nzelfde zin\nzelfde zin\n'), []);
});

test('de echte spiegel heeft geen enkele dubbele rij ten opzichte van de hoofdlijn', () => {
  // Nulmeting-variant: het bestand zoals het nu is, tegen zichzelf zonder de tak-regels is niet
  // beschikbaar in een test. Wat hier wél kan: geen enkele tabelregel komt twee keer voor.
  const rijen = readFileSync(join(ROOT, 'data/kanaalpost-publiek.md'), 'utf8')
    .split('\n').filter((r) => r.startsWith('|'));
  const dubbel = rijen.filter((r, i) => rijen.indexOf(r) !== i);
  assert.deepEqual(dubbel, []);
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

// --- de derde laag: tellen wat de LEZER ziet, niet wat er in de brontekst staat -----------------
//
// Beide gevallen hieronder zijn de letterlijke tegenvoorbeelden van Codex (26-07-2026, hoog). Ze
// hebben één ding gemeen: de twee lagen hierboven blijven groen, terwijl de plaat verandert.

const KOP = '| datum-tijd | tab-rol | onderwerp | status | actie voor |\n|---|---|---|---|---|\n';
const rij = (n) => `| 2026-07-26 14:${String(10 + n).padStart(2, '0')} | AUTOPILOT | melding ${n} | AFGEROND | Richard |\n`;
const SPIEGEL = KOP + rij(1) + rij(2) + rij(3);

test('een lege regel middenin de tabel laat geen regel verdwijnen en tóch de halve plaat', () => {
  // Codex, tegenvoorbeeld 1. Er wordt niets weggehaald en niets herschreven: er komt alleen een lege
  // regel bij. Een lege regel sluit de tabel, dus alles eronder wordt niet meer gepubliceerd.
  const na = KOP + rij(1) + '\n' + rij(2) + rij(3);

  // De twee oude lagen zien er niets in — precies het gat.
  assert.equal(alleenAangevuld(SPIEGEL, na).ok, true, 'geen enkele regel verdwenen uit de brontekst');
  assert.deepEqual(nieuweDuplicaten(SPIEGEL, na), [], 'en geen duplicaat');

  // De derde laag wel: twee van de drie rijen komen er publiek niet meer uit.
  const p = publiekeAfwijkingen(SPIEGEL, na);
  assert.equal(p.ok, false);
  assert.equal(p.verdwenen, 2);
  assert.equal(p.aantal, 1);
});

test('een rij die alleen in celopvulling verschilt is publiek een duplicaat', () => {
  // Codex, tegenvoorbeeld 2. Als brontekst is dit een nieuwe, unieke regel; na normalisatie is het
  // exact dezelfde publieke rij en staat de melding twee keer op de plaat.
  const kopie = rij(3).replace('| melding 3 |', '|  melding 3   |');
  const na = SPIEGEL + kopie;
  assert.notEqual(kopie, rij(3), 'de brontekstregels moeten echt verschillen, anders bewijst dit niets');

  assert.deepEqual(nieuweDuplicaten(SPIEGEL, na), [], 'op brontekst is er niets aan de hand');

  const p = publiekeAfwijkingen(SPIEGEL, na);
  assert.equal(p.ok, false);
  assert.deepEqual(p.dubbel, [{ rij: 4, aantal: 2, toegestaan: 1 }]);
});

test('gewoon aanvullen blijft groen op de publieke telling', () => {
  const p = publiekeAfwijkingen(SPIEGEL, SPIEGEL + rij(4));
  assert.equal(p.ok, true);
  assert.equal(p.verdwenen, 0);
  assert.equal(p.aantal, 4);
});

test('de publieke telling knipt NIET op vijftien — anders is veroudering een overtreding', () => {
  // Zonder deze eigenschap zou elke zestiende melding de zestien-min-vijftien oudste rijen als
  // "verdwenen" laten gelden en stond de poort permanent rood.
  let veel = KOP;
  for (let i = 1; i <= 20; i += 1) veel += rij(i);
  const p = publiekeAfwijkingen(veel, veel + rij(21));
  assert.equal(p.ok, true);
  assert.equal(p.aantal, 21);
});

test('een regel die wordt vastgeplakt aan de vorige wordt wél gezien — door beide lagen', () => {
  // De correctie op wat hierboven eerst beweerd werd: de oude regel is dan verdwenen (hij is nu een
  // langere regel), dus `alleenAangevuld` slaat aan, én de publieke rij verandert mee.
  const vastgeplakt = KOP + rij(1) + rij(2) + rij(3).replace(/\n$/, '') + rij(4).trimStart();
  const r = alleenAangevuld(SPIEGEL, vastgeplakt);
  assert.equal(r.ok, false);
  assert.equal(r.verdwenen, 1);
  assert.equal(publiekeAfwijkingen(SPIEGEL, vastgeplakt).ok, false);
});
