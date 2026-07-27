import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ageTrust, categoriseer, CATEGORIEEN, parseTrackDefs, isEchteDatum, tracksFromListing,
  leesBesluiten, leesTracker, leesJournaal,
} from '../scripts/lib/collect.mjs';

// --- Bevinding uit de derde review (Codex, 23-07-2026): de leeftijdsgrens lekte een dag ---

test('veertien dagen is veertien dagen, niet bijna vijftien', () => {
  const now = Date.parse('2026-07-23T12:00:00.000Z');
  const dagenGeleden = (d) => new Date(now - d * 86400000).toISOString();
  // Math.floor op hele dagen liet een bron van 14 dagen en 23 uur nog groen staan.
  assert.equal(ageTrust(dagenGeleden(13.9), now).trust, 'VERIFIED_CURRENT');
  assert.equal(ageTrust(dagenGeleden(14.1), now).trust, 'STALE');
  assert.equal(ageTrust(null, now).trust, 'UNVERIFIED', 'onbekende datum is niet "vers"');
  assert.equal(ageTrust('geen datum', now).trust, 'UNVERIFIED');
});

// --- Bevinding uit de vierde review (Codex, 23-07-2026): een kapotte klok gaf groen ---

test('een datum in de toekomst is geen verse bron', () => {
  const now = Date.parse('2026-07-23T12:00:00.000Z');
  const over = (ms) => new Date(now + ms).toISOString();
  assert.equal(ageTrust(over(86400000), now).trust, 'UNVERIFIED', 'een dag vooruit klopt niet');
  assert.equal(ageTrust(over(60000), now).trust, 'VERIFIED_CURRENT', 'een minuut klokverschil mag');
});

test('de grens ligt op veertien dagen, niet erna', () => {
  const now = Date.parse('2026-07-23T12:00:00.000Z');
  assert.equal(ageTrust(new Date(now - 14 * 86400000).toISOString(), now).trust, 'STALE');
});

// --- v2.1 (24-07-2026): afgeleid categorielabel — pure classifier ---

test('categoriseer legt tekst op de eerste passende categorie, in vaste volgorde', () => {
  assert.equal(categoriseer('SSRF-lek in de netsafe, gitleaks meldt een token'), 'security');
  assert.equal(categoriseer('nieuwe OAuth-login voor account 2'), 'accounts');
  assert.equal(categoriseer('budget en usage-meter lopen op, quota bijna vol'), 'kosten');
  assert.equal(categoriseer('squash-merge van de pull request na review-regime'), 'merge-beleid');
  assert.equal(categoriseer('planning van de pilot: volgorde en prioriteit'), 'planning');
});

test('categoriseer valt terug op de expliciete restklasse, nooit undefined', () => {
  assert.equal(categoriseer('een zin zonder herkenbaar onderwerp'), 'overig');
  assert.equal(categoriseer(''), 'overig');
  assert.equal(categoriseer(null), 'overig');
  assert.equal(categoriseer(undefined), 'overig');
});

test('elke uitkomst van categoriseer zit in de gesloten woordenschat', () => {
  for (const s of ['security token', 'oauth', 'budget', 'merge', 'planning', 'iets vaags', '']) {
    assert.ok(CATEGORIEEN.includes(categoriseer(s)), `"${s}" → ${categoriseer(s)}`);
  }
});

test('de volgorde is deterministisch: security wint van merge als beide matchen', () => {
  // "pentest van de merge-flow" raakt zowel security als merge-beleid; security staat eerder.
  assert.equal(categoriseer('pentest van de merge-flow'), 'security');
});

// --- v2.1 review-bevindingen (Codex + Gemini, 24-07-2026): slug-lengte + segment-match + datum ---

test('een slug van één teken wordt op élke route geweigerd — string, fallback én expliciet', () => {
  // Beide reviewers: "C" of {name:"C"} leverde slug "c", die matcht bijna elk rapport.
  assert.deepEqual(parseTrackDefs(['C']), [], 'stringvorm met 1-letter-naam levert geen slug');
  assert.deepEqual(parseTrackDefs([{ name: 'C' }]), [], 'object-fallback op de naam ook niet');
  assert.deepEqual(parseTrackDefs([{ name: 'COA', slugs: ['c'] }]), [], 'expliciete 1-letter-slug ook niet');
  // Een geldige slug blijft wél staan.
  assert.deepEqual(parseTrackDefs([{ name: 'COA', slugs: ['coa', 'x'] }]), [{ name: 'COA', slugs: ['coa'] }]);
});

test('slug-matching koppelt op hele segmenten, niet op substrings', () => {
  const defs = parseTrackDefs([{ name: 'COA', slugs: ['coa'] }]);
  // "charcoal" en "coaching" bevatten "coa" als substring maar niet als segment: geen match.
  const vreemd = tracksFromListing(defs, [
    { name: '2026-07-24-overname-charcoal.md', type: 'file' },
    { name: '2026-07-20-coaching-klant-x.md', type: 'file' },
  ]);
  assert.equal(vreemd[0].reportCount, 0, 'geen valse positief op charcoal/coaching');
  assert.equal(vreemd[0].lastReportAt, null);
  assert.equal(vreemd[0].trust, 'UNVERIFIED');
  // Een écht COA-rapport (coa als eigen segment) matcht wél.
  const echt = tracksFromListing(defs, [{ name: '2026-07-24-coa-briefing.md', type: 'file' }]);
  assert.equal(echt[0].reportCount, 1);
  assert.equal(echt[0].lastReportAt, '2026-07-24T00:00:00Z');
});

test('een onmogelijke kalenderdatum in een naam telt niet mee', () => {
  assert.equal(isEchteDatum('2026-02-30'), false);
  assert.equal(isEchteDatum('2026-13-01'), false);
  assert.equal(isEchteDatum('2026-07-24'), true);
  const defs = parseTrackDefs([{ name: 'DECK', slugs: ['deck'] }]);
  // 30 februari past op de regex maar is geen datum: het rapport telt niet mee.
  const uit = tracksFromListing(defs, [{ name: '2026-02-30-deck-verzin.md', type: 'file' }]);
  assert.equal(uit[0].reportCount, 0);
});

test('alleen echte bestanden tellen — een submap met een datumnaam niet', () => {
  const defs = parseTrackDefs([{ name: 'DECK', slugs: ['deck'] }]);
  const uit = tracksFromListing(defs, [
    { name: '2026-07-24-deck-map', type: 'dir' },
    { name: '2026-07-24-deck-echt.md', type: 'file' },
  ]);
  assert.equal(uit[0].reportCount, 1, 'de dir telt niet, het bestand wel');
});

test('tracksFromListing lekt nooit een bestandsnaam of onderwerp', () => {
  const defs = parseTrackDefs([{ name: 'DECK', slugs: ['deck'] }]);
  const uit = tracksFromListing(defs, [{ name: '2026-07-24-deck-klant-zephyr-geheim.md', type: 'file' }]);
  const json = JSON.stringify(uit);
  assert.equal(json.includes('zephyr'), false);
  assert.equal(json.includes('geheim'), false);
  assert.equal(json.includes('.md'), false);
  assert.equal(uit[0].reportCount, 1, 'de telling klopt wél');
});

// --- 27-07-2026: de lezer die rijen liet vallen ------------------------------------------------
//
// Gemeten op de echte bron (`CONTROL/DECISIONS.md` op main, 27-07 05:30 UTC): 98 besluitrijen in het
// bestand, 30 herkend door de lezer, 68 stil weggevallen — waaronder de vijf nieuwste (D-0095 t/m
// D-0099). Op de plaat stond D-0094 als jongste besluit, en dat zag er precies zo uit als een bron
// die niets nieuws had. De oorzaak was geen transport maar een bovengrens in de regex: een besluit
// met meer dan 160 tekens tekst paste niet in het patroon en verdween zonder spoor.
//
// Wat deze proeven vastleggen: een rij wordt herkend aan zijn ANKER (het ID), niet aan zijn lengte,
// en wat de lezer niet begrijpt wordt GETELD. Stil weglaten is de fout zelf.

test('een besluit met een lange tekst wordt gewoon gelezen — lengte bepaalt niet wat bestaat', () => {
  const lang = 'x'.repeat(400);
  const tekst = [
    '| ID | Date | Decision | Owner | Status | Evidence |',
    '| --- | --- | --- | --- | --- | --- |',
    '| D-0094 | 2026-07-26 | Kort besluit. | Richard | active | bewijs |',
    `| D-0099 | 2026-07-26 | ${lang} | Richard | active | bewijs |`,
  ].join('\n');
  const { entries, telling } = leesBesluiten(tekst);
  assert.deepEqual(entries.map((e) => e.id), ['D-0099', 'D-0094'], 'nieuwste boven, en de lange telt mee');
  assert.deepEqual(telling, { inBron: 2, herkend: 2, getoond: 2, afgekapt: 1 }, 'de lange is ingekort — en dat wordt gemeld');
});

test('wat de lezer niet begrijpt, wordt geteld en niet stil weggelaten', () => {
  const tekst = [
    '| D-0001 | 2026-07-15 | Een echt besluit. | Richard | active | bewijs |',
    '| D-0002 | geen datum | Deze rij draagt geen datum. | Richard | active | bewijs |',
  ].join('\n');
  const { entries, telling } = leesBesluiten(tekst);
  assert.equal(entries.length, 1);
  assert.equal(telling.inBron, 2, 'de bron had twee rijen');
  assert.equal(telling.herkend, 1, 'en de lezer begreep er één — dat verschil hoort zichtbaar te zijn');
});

test('de vensterlimiet van tien is een weergavekeuze, geen meting: getoond ≠ herkend mag', () => {
  const rijen = Array.from({ length: 14 }, (_, i) => `| D-${String(i + 1).padStart(4, '0')} | 2026-07-26 | Besluit ${i + 1}. | Richard | active | bewijs |`);
  const { entries, telling } = leesBesluiten(rijen.join('\n'));
  assert.equal(entries.length, 10);
  assert.deepEqual(telling, { inBron: 14, herkend: 14, getoond: 10, afgekapt: 0 });
});

test('tracker: een lange updatetitel valt niet weg, hij wordt alleen ingekort', () => {
  const tekst = `**Update 26/7 (44) — ${'a'.repeat(300)}.**`;
  const { updates, telling } = leesTracker(tekst);
  assert.equal(updates.length, 1, 'de update bestaat, hoe lang de titel ook is');
  assert.ok(updates[0].title.length <= 120, 'inkorten mag — weglaten niet');
  assert.equal(telling.inBron, 1);
});

test('journaal: een lange kop valt niet weg', () => {
  const { entries, telling } = leesJournaal(`## ${'b'.repeat(300)}`);
  assert.equal(entries.length, 1);
  assert.ok(entries[0].title.length <= 110);
  assert.equal(telling.inBron, 1);
});

// --- 27-07-2026, aanscherping Richard: de verwachting komt van de bronkant ----------------------
//
// "Een lezer die telt wat hij overhoudt, telt wat hij al heeft weggegooid en meldt dat alles klopt."
// Daarom telt `inBron` de kandidaten zoals de bron ze aanbiedt — vóór het filter.

test('een rij die de lezer niet begrijpt telt toch mee aan de bronkant', () => {
  const tekst = [
    '| D-0001 | 2026-07-15 | Een echt besluit. | Richard | active | bewijs |',
    '| D-95 | 2026-07-26 | Scheve ID-vorm, maar onmiskenbaar een besluitrij. | Richard | active | x |',
  ].join('\n');
  const { telling } = leesBesluiten(tekst);
  assert.equal(telling.inBron, 2, 'de bron bood twee besluitrijen aan');
  assert.equal(telling.herkend, 1, 'de lezer begreep er één');
  // Zou `inBron` het anker zelf gebruiken, dan stond hier 1 = 1 en meldde de lezer "alles klopt".
});

test('een trackerregel in een onbekende schrijfwijze verdwijnt niet uit de telling', () => {
  const { updates, telling } = leesTracker('**Update 26/7 zonder nummer — iets belangrijks.**');
  assert.equal(updates.length, 0);
  assert.equal(telling.inBron, 1, 'hij stond er wel');
  assert.equal(telling.herkend, 0);
});

test('afkappen wordt gemeld, ook in het journaal', () => {
  const { telling } = leesJournaal(`## kort\n## ${'b'.repeat(300)}`);
  assert.deepEqual(telling, { inBron: 2, herkend: 2, getoond: 2, afgekapt: 1 });
});

// --- Gemini-review 27-07-2026: twee manieren waarop de telling zelf loog ------------------------

test('een beslispunt dat twee keer genoemd wordt is geen weggevallen rij', () => {
  const tekst = 'BESLISPUNT 12a — moet dit publiek.\nBESLISPUNT 12a — moet dit publiek.';
  const { decisionPoints, telling } = leesTracker(tekst);
  assert.equal(decisionPoints.length, 1, 'één beslispunt');
  assert.equal(telling.herkend, telling.inBron, 'ontdubbelen mag nooit als achterstand tellen');
});

test('voorloopruimte of een kleine letter maakt een rij niet onzichtbaar', () => {
  const { telling } = leesBesluiten('  | d-0099 | 2026-07-26 | Ingesprongen rij met kleine letter. | R | active | x |');
  assert.equal(telling.inBron, 1, 'de bron bood hem aan — de lezer begrijpt hem niet, en dat is te zien');
  assert.equal(telling.herkend, 0);
  assert.equal(leesJournaal('  ## ingesprongen kop').telling.inBron, 1);
});

test('een beslispunt in een onbekende schrijfwijze telt aan de bronkant mee', () => {
  // `BESLISPUNT 12a: titel` haalde het anker niet en telde ook niet mee: nul en nul, en dat ziet
  // eruit als "er zijn geen beslispunten" (Codex, 27-07-2026).
  const { decisionPoints, telling } = leesTracker('BESLISPUNT 12a: met een dubbele punt.');
  assert.equal(decisionPoints.length, 0);
  assert.equal(telling.inBron, 1, 'hij stond er');
  assert.equal(telling.herkend, 0, 'en het verschil is de uitkomst');
});
