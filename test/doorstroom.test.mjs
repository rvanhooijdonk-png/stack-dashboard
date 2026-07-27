/**
 * DOORSTROOM + VLOOTSTAND — de proeven staan hier vóór de code, en ze horen eerst ROOD te zijn.
 *
 * Wat er kapot was, gemeten op 2026-07-27 05:00 UTC: zestien spiegelrijen stonden in negen open
 * voorstellen op `data/kanaalpost-publiek.md`, waarvan er acht BOTSTEN met de hoofdlijn. Elk venster
 * vult hetzelfde bestand achteraan aan, dus twee vensters tegelijk botsen per constructie. De
 * ontsnappingsroute was een handmatige bundel (#30 → #32 → #33, elk "vervangt" de vorige), en die
 * bundels sneuvelden op hun beurt. Al die tijd stonden 392 proeven groen: er was geen enkele toets
 * die van ACHTERSTAND een uitkomst maakte. Stilte was niet te onderscheiden van rust.
 *
 * Daar komen deze proeven vandaan, en ze meten drie dingen die geen van alle bestonden:
 *   1. een bronrij die na X minuten niet gepubliceerd is → ROOD;
 *   2. een stempel ouder dan Y minuten zonder verklaring → ROOD;
 *   3. een venster dat leeg gaat zonder het te melden → ONBEKEND, nooit stil WERKT.
 *
 * En één ontwerpeis die net zo hard is: één slechte rij mag de hele overzetting niet laten sneuvelen.
 * Dat is precies waar de handmatige bundels op stukliepen — één rij op de verkeerde plek nam er zes
 * mee. Per rij oordelen, per rij weigeren, de rest gaat door.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  ACHTERSTAND_MINUTEN, STEMPEL_MINUTEN, VLOOT_ONBEKEND_MINUTEN,
  overzetting, achterstandsOordeel, stempelOordeel, vlootstand, vlootstandBlok, bronRijUitTekst,
  toPublicVlootstand, bronRijenOordeel,
} from '../scripts/lib/doorstroom.mjs';
import { alleenAangevuld } from '../scripts/lib/spiegelwet.mjs';
import { spiegelUitTekst } from '../scripts/lib/kanaalpost.mjs';

const KOP = '| datum-tijd | tab-rol | onderwerp | status | actie voor |';
const SCH = '| --- | --- | --- | --- | --- |';
const R = (d, tab, ond, status = 'AFGEROND', actie = 'niemand') => `| ${d} | ${tab} | ${ond} | ${status} | ${actie} |`;

/** Een spiegel zoals hij op main staat: uitleg, kop, scheiding, rijen. */
const spiegel = (...rijen) => [
  '# KANAALPOST — publieke spiegel',
  '',
  KOP,
  SCH,
  ...rijen,
  '',
].join('\n');

const NU = new Date('2026-07-27T06:00:00Z');
const minutenGeleden = (m) => new Date(NU.getTime() - m * 60_000);
/** Bronrijen dragen een tijdstip van AANLEVERING; de datumkolom is van de melding zelf. */
const bron = (regel, geleverdMinutenGeleden, id = regel.slice(0, 24)) => ({
  id, regel, geleverdOp: minutenGeleden(geleverdMinutenGeleden),
});

// ─── 1. de overzetting zelf ─────────────────────────────────────────────────────────────────────

test('doorstroom: nieuwe rijen komen erachter, en er verdwijnt niets', () => {
  const oud = spiegel(R('2026-07-26 10:00', 'CONTROL', 'Eerste.'));
  const uit = overzetting(oud, [bron(R('2026-07-27 05:50', 'AUTOPILOT', 'Tweede.'), 5)]);

  assert.equal(uit.overgezet.length, 1);
  assert.equal(uit.geweigerd.length, 0);
  assert.equal(alleenAangevuld(oud, uit.tekst).ok, true, 'de wet: niets mag verdwijnen');
  assert.equal(alleenAangevuld(oud, uit.tekst).opOrde, true, 'en de oude tekst blijft vooraan staan');
  const rijen = spiegelUitTekst(uit.tekst);
  assert.equal(rijen.length, 2);
  assert.equal(rijen[1].tab, 'AUTOPILOT', 'de nieuwe rij staat achteraan, niet ertussen');
});

test('doorstroom: twee keer draaien voegt niets toe — een rij die er al staat is klaar, geen dubbele', () => {
  const oud = spiegel(R('2026-07-26 10:00', 'CONTROL', 'Eerste.'));
  const rij = bron(R('2026-07-27 05:50', 'AUTOPILOT', 'Tweede.'), 5);
  const een = overzetting(oud, [rij]);
  const twee = overzetting(een.tekst, [rij]);

  assert.equal(twee.overgezet.length, 0, 'niets nieuws');
  assert.equal(twee.ongewijzigd, true);
  assert.equal(twee.tekst, een.tekst, 'byte-gelijk: een lege ronde raakt het bestand niet aan');
});

test('doorstroom: ÉÉN slechte rij laat de rest niet sneuvelen — dit is waar de bundels op stukliepen', () => {
  const oud = spiegel(R('2026-07-26 10:00', 'CONTROL', 'Eerste.'));
  const uit = overzetting(oud, [
    bron(R('2026-07-27 05:40', 'AUTOPILOT', 'Goed een.'), 20),
    // Een verticale streep in de tekst breekt de kolommen: precies het soort rij dat een hele
    // handmatige bundel liet klappen.
    bron('| 2026-07-27 05:45 | MARKT | kapot | want | te veel | kolommen |', 15),
    bron(R('2026-07-27 05:50', 'CHIEF', 'Goed twee.'), 10),
  ]);

  assert.equal(uit.overgezet.length, 2, 'de twee goede rijen gaan gewoon door');
  assert.equal(uit.geweigerd.length, 1, 'de kapotte rij blijft achter');
  assert.ok(uit.geweigerd[0].reden, 'met een reden, want stil inhouden is het probleem zelf');
  assert.equal(alleenAangevuld(oud, uit.tekst).ok, true);
  assert.equal(spiegelUitTekst(uit.tekst).length, 3);
});

test('doorstroom: een rij met een onzichtbaar teken wordt geweigerd én geteld, niet stil weggelaten', () => {
  const oud = spiegel(R('2026-07-26 10:00', 'CONTROL', 'Eerste.'));
  const uit = overzetting(oud, [bron(R('2026-07-27 05:50', 'AUTOPILOT', 'Met​zero-width.'), 5)]);

  assert.equal(uit.overgezet.length, 0);
  assert.equal(uit.geweigerd.length, 1);
  assert.equal(uit.geweigerd[0].reden, 'ONZICHTBAAR_TEKEN');
  assert.equal(uit.tekst, oud, 'niets aan het bestand veranderd');
});

test('doorstroom: de bron mag de spiegelvorm niet breken — een rij die het bestand onleesbaar maakt gaat niet mee', () => {
  const oud = spiegel(R('2026-07-26 10:00', 'CONTROL', 'Eerste.'));
  // Een regel met een harde regelscheider erin zou de tabel in tweeën hakken.
  const uit = overzetting(oud, [bron(`${R('2026-07-27 05:50', 'AUTOPILOT', 'Tweede.')} extra`, 5)]);

  assert.equal(uit.overgezet.length, 0);
  assert.equal(uit.geweigerd.length, 1);
  assert.equal(uit.tekst, oud);
});

test('bronRijUitTekst: leest een aangeleverd bestandje, of zegt waaróm het geen rij is', () => {
  const goed = bronRijUitTekst('2026-07-27-0550-autopilot.md', `${R('2026-07-27 05:50', 'AUTOPILOT', 'Tweede.')}\n`);
  assert.equal(goed.ok, true);
  assert.equal(goed.id, '2026-07-27-0550-autopilot.md');

  const leeg = bronRijUitTekst('leeg.md', '\n\n');
  assert.equal(leeg.ok, false);
  assert.equal(leeg.reden, 'GEEN_RIJ');

  const twee = bronRijUitTekst('twee.md', `${R('2026-07-27 05:50', 'A', 'Een.')}\n${R('2026-07-27 05:51', 'B', 'Twee.')}\n`);
  assert.equal(twee.ok, false);
  assert.equal(twee.reden, 'MEER_DAN_EEN_RIJ', 'één bestand is één rij — anders botsen twee vensters weer op één bestand');
});

// ─── 2. de rode proef op de achterstand ─────────────────────────────────────────────────────────

test('ROOD: een bronrij die na X minuten nog niet gepubliceerd is', () => {
  const spiegelTekst = spiegel(R('2026-07-26 10:00', 'CONTROL', 'Eerste.'));
  const wachtend = bron(R('2026-07-27 04:00', 'MARKT', 'Al twee uur onderweg.'), ACHTERSTAND_MINUTEN + 90);

  const oordeel = achterstandsOordeel([wachtend], spiegelTekst, { nu: NU });
  assert.equal(oordeel.uitkomst, 'ROOD');
  assert.equal(oordeel.achterstallig.length, 1);
  assert.ok(oordeel.oudsteMinuten >= ACHTERSTAND_MINUTEN);
  assert.ok(oordeel.reden, 'een rood oordeel draagt altijd een reden');
});

test('GROEN: een rij die net binnen is, is geen achterstand', () => {
  const spiegelTekst = spiegel(R('2026-07-26 10:00', 'CONTROL', 'Eerste.'));
  const vers = bron(R('2026-07-27 05:58', 'MARKT', 'Net binnen.'), 2);

  const oordeel = achterstandsOordeel([vers], spiegelTekst, { nu: NU });
  assert.equal(oordeel.uitkomst, 'GROEN');
  assert.equal(oordeel.achterstallig.length, 0);
});

test('GROEN: een rij die al gepubliceerd is telt niet mee, hoe oud hij ook is', () => {
  const rij = R('2026-07-26 10:00', 'CONTROL', 'Eerste.');
  const oordeel = achterstandsOordeel([bron(rij, 5000)], spiegel(rij), { nu: NU });
  assert.equal(oordeel.uitkomst, 'GROEN');
});

test('ROOD blijft ROOD als de spiegel onleesbaar is — geen bron is geen groen', () => {
  const oordeel = achterstandsOordeel([bron(R('2026-07-27 04:00', 'MARKT', 'Wacht.'), 200)], null, { nu: NU });
  assert.equal(oordeel.uitkomst, 'ROOD');
  assert.equal(oordeel.reden, 'SPIEGEL_ONLEESBAAR');
});

// ─── 3. de rode proef op het stempel ────────────────────────────────────────────────────────────

test('ROOD: een stempel ouder dan Y minuten zonder verklaring', () => {
  const oordeel = stempelOordeel({ generatedAt: minutenGeleden(STEMPEL_MINUTEN + 5).toISOString(), nu: NU });
  assert.equal(oordeel.uitkomst, 'ROOD');
  assert.equal(oordeel.reden, 'STEMPEL_TE_OUD');
  assert.ok(oordeel.ouderdomMinuten >= STEMPEL_MINUTEN);
});

test('GROEN: een vers stempel', () => {
  const oordeel = stempelOordeel({ generatedAt: minutenGeleden(3).toISOString(), nu: NU });
  assert.equal(oordeel.uitkomst, 'GROEN');
  assert.equal(oordeel.ouderdomMinuten, 3);
});

test('een oud stempel MET verklaring is geen ROOD maar wel zichtbaar — anders wordt de verklaring een doofpot', () => {
  const oordeel = stempelOordeel({
    generatedAt: minutenGeleden(STEMPEL_MINUTEN + 5).toISOString(), nu: NU, verklaring: 'ONDERHOUD',
  });
  assert.equal(oordeel.uitkomst, 'GEEL');
  assert.equal(oordeel.verklaring, 'ONDERHOUD');
});

test('ROOD: geen stempel of onleesbaar stempel — dat is erger dan oud, niet beter', () => {
  assert.equal(stempelOordeel({ generatedAt: null, nu: NU }).uitkomst, 'ROOD');
  assert.equal(stempelOordeel({ generatedAt: 'gisteren', nu: NU }).reden, 'STEMPEL_ONLEESBAAR');
  assert.equal(stempelOordeel({ generatedAt: minutenGeleden(-120).toISOString(), nu: NU }).reden, 'STEMPEL_UIT_DE_TOEKOMST');
});

// ─── 4. vlootstand: leegstand is een uitkomst, geen stilte ──────────────────────────────────────

const VENSTERS = [
  { venster: 'AUTOPILOT', rol: 'bouwt en repareert' },
  { venster: 'CHIEF', rol: 'agenda en klantwerk' },
  { venster: 'MARKT', rol: 'markt en signalen' },
];

test('ROOD-vorm: een venster dat leeg gaat ZONDER melding staat op ONBEKEND, nooit op WERKT', () => {
  const tekst = spiegel(
    R('2026-07-27 05:55', 'AUTOPILOT', 'Net iets afgerond.'),
    // CHIEF meldde voor het laatst ruim buiten de grens en zei niets over leegstand.
    R('2026-07-26 20:00', 'CHIEF', 'Iets afgerond, daarna niets meer.'),
  );
  const stand = vlootstand(tekst, { vensters: VENSTERS, nu: NU });
  const per = Object.fromEntries(stand.map((s) => [s.venster, s]));

  assert.equal(per.AUTOPILOT.toestand, 'WERKT');
  assert.equal(per.CHIEF.toestand, 'ONBEKEND', 'zwijgen na een afronding is geen bewijs van werk');
  assert.notEqual(per.CHIEF.toestand, 'WERKT');
  assert.equal(per.MARKT.toestand, 'ONBEKEND', 'een venster dat nooit meldde is ook ONBEKEND, niet afwezig');
  assert.ok(per.CHIEF.stilMinuten >= VLOOT_ONBEKEND_MINUTEN);
});

test('LEEG: een venster dat zijn lege voorraad MELDT staat op LEEG, met het tijdstip erbij', () => {
  const tekst = spiegel(
    R('2026-07-27 05:40', 'MARKT', 'Voorraad leeg sinds 05:40, wachtend op werk.', 'AFGEROND', 'Richard'),
  );
  const stand = vlootstand(tekst, { vensters: VENSTERS, nu: NU });
  const markt = stand.find((s) => s.venster === 'MARKT');

  assert.equal(markt.toestand, 'LEEG');
  assert.equal(markt.laatste, '2026-07-27 05:40');
});

test('een gemelde leegstand veroudert ook — na X minuten weet niemand meer of het venster nog leeg is', () => {
  const tekst = spiegel(R('2026-07-26 12:00', 'MARKT', 'Voorraad leeg sinds 12:00, wachtend op werk.'));
  const markt = vlootstand(tekst, { vensters: VENSTERS, nu: NU }).find((s) => s.venster === 'MARKT');
  assert.equal(markt.toestand, 'ONBEKEND');
});

test('vlootstandBlok: één regel per venster, en de vorm blijft kanoniek', () => {
  const tekst = spiegel(R('2026-07-27 05:55', 'AUTOPILOT', 'Net iets afgerond.'));
  const blok = vlootstandBlok(vlootstand(tekst, { vensters: VENSTERS, nu: NU }), { nu: NU });

  assert.equal(blok.split('\n').filter((r) => r.startsWith('| ')).length, VENSTERS.length + 2, 'kop + scheiding + één regel per venster');
  assert.ok(blok.includes('AUTOPILOT'));
  assert.ok(!/[^\S \t]/u.test(blok.replace(/\n/g, '')), 'geen vreemde witruimte — de vormpoort leest dit bestand ook');
});

/**
 * En hier botste de opdracht met de wet, dus staat het als proef en niet als aanname.
 *
 * Gevraagd was "voeg aan de spiegel een vaste kop toe: VLOOTSTAND". Maar de publieke spiegel is
 * append-only met een HARDE laag: geen regel die er stond mag verdwijnen (`spiegelwet.mjs`, na een
 * echt incident geschreven). Een kop die bij elke ronde wordt BIJGEWERKT, verwijdert per definitie de
 * vorige kop — dat is precies de beweging die de wet verbiedt, en de waarnemer zou er terecht op
 * afgaan. Een uitzondering in de wet maken zou de sterkste garantie op het publieke bestand
 * verzwakken om een afgeleid overzicht te huisvesten.
 *
 * Daarom: de vlootstand wordt AFGELEID uit dezelfde rijen en apart weggeschreven, en verschijnt als
 * vaste kop op de PLAAT — daar waar Richard hem leest. Het append-only bestand blijft onaangeraakt.
 * Wat de opdracht wil (één regel lezen in plaats van tabs aflopen) blijft volledig overeind; alleen
 * de plek verschuift van het logboek naar de plaat.
 */
test('de vlootstand raakt het append-only bestand NIET aan — hij wordt afgeleid, niet ingeschreven', () => {
  const oud = spiegel(R('2026-07-26 10:00', 'CONTROL', 'Eerste.'));
  const uit = overzetting(oud, [], { vensters: VENSTERS, nu: NU });

  assert.equal(uit.tekst, oud, 'een ronde zonder nieuwe rijen laat het bestand byte-gelijk');
  assert.ok(!uit.tekst.includes('VLOOTSTAND'), 'de stand hoort op de plaat, niet in het logboek');
  assert.equal(alleenAangevuld(oud, uit.tekst).ok, true);
  assert.equal(spiegelUitTekst(uit.tekst).length, 1, 'de vlootstand voegt geen spiegelrijen toe');
});

// --- De vlootstand naar de openbare plaat ---------------------------------------------------
//
// Alles hieronder gaat over één vraag: wat mag er van een intern oordeel op een PUBLIEKE pagina
// terechtkomen? De vensternamen staan al in deze repo, de standen komen uit een gesloten lijst — maar
// de rol komt uit een bestand dat een mens vult, en dat is vrije tekst. Die gaat daarom door dezelfde
// poort als elk ander veld op deze pagina: erdoor of eruit, nooit half.

const STAND = (venster, toestand, extra = {}) => ({
  venster, rol: null, toestand, laatste: '2026-07-27 05:00', stilMinuten: 30, ...extra,
});

test('de publieke vlootstand telt de drie standen en houdt de volgorde van de vloot aan', () => {
  const dto = toPublicVlootstand({
    bronOk: true,
    grensMinuten: 240,
    standen: [STAND('CONTROL', 'WERKT'), STAND('AUTOPILOT', 'LEEG'), STAND('MARKT', 'ONBEKEND', { laatste: null, stilMinuten: null })],
  });
  assert.equal(dto.available, true);
  assert.equal(dto.reason, null);
  assert.equal(dto.grensMinuten, 240);
  assert.deepEqual(dto.vensters.map((v) => v.venster), ['CONTROL', 'AUTOPILOT', 'MARKT']);
  assert.deepEqual(dto.telling, { werkt: 1, leeg: 1, onbekend: 1 });
});

test('een rol die niet in de smalle vorm past wordt null — niet afgekapt en niet gepubliceerd', () => {
  const dto = toPublicVlootstand({
    bronOk: true,
    standen: [
      STAND('CONTROL', 'WERKT', { rol: 'controlekanaal' }),
      STAND('MARKT', 'WERKT', { rol: 'let op: richard@voorbeeld.nl belt hierover, zie /Users/iemand/geheim.md' }),
    ],
  });
  assert.equal(dto.vensters[0].rol, 'controlekanaal', 'een net woord mag gewoon door');
  assert.equal(dto.vensters[1].rol, null, 'vrije tekst met adressen en paden komt er niet half in');
});

test('een naam die geen vensterlabel is, maakt de HELE sectie onbeschikbaar in plaats van stil te verdwijnen', () => {
  const dto = toPublicVlootstand({ bronOk: true, standen: [STAND('CONTROL', 'WERKT'), STAND('stack-control', 'WERKT')] });
  assert.equal(dto.available, false);
  assert.equal(dto.reason, 'BRON_ONBEREIKBAAR');
  assert.deepEqual(dto.vensters, [], 'liever één nette melding dan een lijst waar er stiekem één uit is');
});

test('een onbekende toestand wordt ONBEKEND, nooit stilzwijgend WERKT', () => {
  const dto = toPublicVlootstand({ bronOk: true, standen: [STAND('CONTROL', 'DRAAIT LEKKER')] });
  assert.equal(dto.vensters[0].toestand, 'ONBEKEND');
  assert.deepEqual(dto.telling, { werkt: 0, leeg: 0, onbekend: 1 });
});

test('geen leesbare spiegel en geen vloot geven allebei een eigen, eerlijke eindstand', () => {
  assert.deepEqual(
    [toPublicVlootstand({ bronOk: false, standen: [] }).reason, toPublicVlootstand({ bronOk: true, standen: [] }).reason],
    ['BRON_ONBEREIKBAAR', 'LEEG'],
  );
  assert.equal(toPublicVlootstand(null).available, false, 'niets aanleveren is ook een antwoord: geen stand');
});

test('een onleesbaar of ontbrekend stiltegetal wordt null en telt als ONBEKEND-bewijs, niet als activiteit', () => {
  const dto = toPublicVlootstand({
    bronOk: true,
    standen: [STAND('CONTROL', 'ONBEKEND', { stilMinuten: 'lang', laatste: 'gisteren' })],
  });
  assert.equal(dto.vensters[0].stilMinuten, null);
  assert.equal(dto.vensters[0].laatste, null, 'een datum die geen datum is, is geen datum');
});

// --- Achterstand per bron, geteld in rijen -----------------------------------------------------

test('een bron die rijen laat vallen is ROOD, met het aantal erbij', () => {
  const o = bronRijenOordeel([
    { key: 'decisions', rijen: { inBron: 98, herkend: 30, getoond: 10, afgekapt: 0 } },
    { key: 'tracker', rijen: { inBron: 8, herkend: 8, getoond: 8, afgekapt: 2 } },
    { key: 'ci', rijen: null },
  ]);
  assert.equal(o.uitkomst, 'ROOD');
  assert.equal(o.gevallen, 68, 'precies de gemeten breuk van 27-07');
  assert.match(o.reden, /decisions 68\/98/);
});

test('afkappen alleen is geen rood — het is gemeld, en dat was de eis', () => {
  const o = bronRijenOordeel([{ key: 'decisions', rijen: { inBron: 98, herkend: 98, getoond: 10, afgekapt: 12 } }]);
  assert.equal(o.uitkomst, 'GROEN');
  assert.equal(o.afgekapt, 12, 'maar het staat er wel');
});

test('een plaat zonder rijentelling is GEEL, niet ROOD en niet stil groen', () => {
  assert.equal(bronRijenOordeel([{ key: 'ci', rijen: null }]).uitkomst, 'GEEL');
  assert.equal(bronRijenOordeel(null).uitkomst, 'GEEL');
  assert.equal(bronRijenOordeel([]).reden, 'PLAAT_NOG_ZONDER_RIJENTELLING');
});
