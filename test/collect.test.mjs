import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ageTrust, categoriseer, CATEGORIEEN, parseTrackDefs, isEchteDatum, tracksFromListing,
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
  assert.deepEqual(parseTrackDefs([{ name: 'COA', slugs: ['coa', 'x'] }]), [{ name: 'COA', slugs: ['coa'], kanaal: [] }]);
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

test('een track meldt zich ook via de kanaalpost, niet alleen via een klaar-rapport', () => {
  // ROOD vóór deze koppeling: NQ-RADAR werkt in een eigen repo en schrijft geen rapport in
  // CONTROL/RAPPORTEN. De plaat las dat als "geen bewijs van werk" terwijl de track dagelijks
  // aftekent in de kanaalpost — een verkeerde bron, geen eerlijke leegte.
  const defs = parseTrackDefs([{ name: 'NQ', slugs: ['nq'], kanaal: ['NQ-RADAR'] }]);
  assert.deepEqual(defs[0].kanaal, ['nq-radar'], 'tabnamen worden hoofdletterongevoelig vergeleken');

  const zonder = tracksFromListing(defs, [], []);
  assert.equal(zonder[0].lastReportAt, null);
  assert.equal(zonder[0].trust, 'UNVERIFIED');

  const met = tracksFromListing(defs, [], [
    { tab: 'NQ-RADAR', datum: '2026-07-26 05:00' },
    { tab: 'DECK', datum: '2026-07-26 05:10' },
  ]);
  assert.equal(met[0].lastReportAt, '2026-07-26T00:00:00Z');
  assert.equal(met[0].reportCount, 1, 'alleen de eigen tab telt mee');
});

test('rapport en kanaalpost tellen samen; de nieuwste datum wint', () => {
  const defs = parseTrackDefs([{ name: 'DECK', slugs: ['deck'], kanaal: ['DECK'] }]);
  const uit = tracksFromListing(
    defs,
    [{ name: '2026-07-20-deck-slot.md', type: 'file' }],
    [{ tab: 'DECK', datum: '2026-07-25 04:52' }, { tab: 'DECK', datum: 'nietsdatum' }],
  );
  assert.equal(uit[0].reportCount, 2, 'de onzin-datum telt niet mee');
  assert.equal(uit[0].lastReportAt, '2026-07-25T00:00:00Z');
});

test('een track zonder kanaal-koppeling raapt geen vreemde kanaalpost-rijen op', () => {
  const defs = parseTrackDefs([{ name: 'COA', slugs: ['coa'] }]);
  const uit = tracksFromListing(defs, [], [{ tab: 'COA', datum: '2026-07-26' }]);
  assert.equal(uit[0].reportCount, 0, 'zonder expliciete kanaal-lijst blijft de koppeling dicht');
});
