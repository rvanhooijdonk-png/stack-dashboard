/**
 * LABELTOETS — de krant-toets op vrije labels.
 *
 * Deze poort bestaat omdat de plaat OPENBAAR is en publiceren onomkeerbaar. Bijna elke test hieronder
 * is daarom een rode proef: hij bewijst dat iets NIET doorkomt. De groene proef (gewoon bouwwerk komt
 * er wél door) staat er expliciet naast — een poort die alles tegenhoudt is net zo waardeloos als
 * een poort die niets tegenhoudt.
 *
 * De bypass-tests hieronder zijn één op één de gaten die Codex en Gemini vonden in de eerste versie
 * (26-07-2026), die alleen hoofdletterwoorden toetste. Ze staan er zodat die versie niet per ongeluk
 * terugkomt.
 *
 * Bewust géén echte klant- of persoonsnaam in dit bestand: de tests draaien in een openbare repo.
 * Waar een geblokkeerde naam nodig is, gebruiken we een verzonnen naam.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toetsLabel,
  woordenVan,
  normaliseer,
  laadLabelPoort,
  resetLabelPoort,
} from '../scripts/lib/labeltoets.mjs';

const REDENEN = new Set(['onbekend', 'onderwerp', 'verwijzing', 'teken', 'getal', 'leeg', 'poort-onbeschikbaar']);

test('gewoon bouwwerk komt er gewoon door', () => {
  for (const label of [
    'Dagelijkse automatische contentpublicatie',
    'Model-routing / control plane',
    'Stuck-detectie: taken die blijven liggen automatisch signaleren',
    'Wekelijkse research-scan met `code` → publicatie',
  ]) {
    assert.equal(toetsLabel(label).ok, true, label);
  }
});

test('een onbekende eigennaam zakt, ook zonder dat de poort hem kent', () => {
  // Dit is de kern: de allowlist hoeft de nieuwe klant-, merk- of persoonsnaam niet te KENNEN.
  const res = toetsLabel('Koppeling met Zephyrion Holding bouwen');
  assert.equal(res.ok, false);
  assert.equal(res.reden, 'onbekend');
});

test('KLEINGESCHREVEN onbekende naam zakt ook — het gat van de eerste versie', () => {
  // De eerste versie toetste alleen woorden mét hoofdletter; Codex en Gemini vonden dit onafhankelijk.
  assert.equal(toetsLabel('koppeling met zephyrion bouwen').ok, false);
});

test('de hoofdletter-omzeilingen uit de review zakken allemaal', () => {
  for (const label of [
    "Koppeling met 'Zephyrion bouwen", // leesteken ervoor
    'Koppeling met 3Zephyrion', // cijfer ervoor
    'Koppeling met ZEPHYRION', // volledig kapitaal
    'Koppeling met zephyrions database', // meervoud
  ]) {
    assert.equal(toetsLabel(label).ok, false, label);
  }
});

test('samenstellingen om een geblokkeerd onderwerp heen zakken op de allowlist', () => {
  // Prefix-match alleen zou `kantoorverhuizing` en `jaaromzet` doorlaten (bevinding Gemini).
  for (const label of ['kantoorverhuizing plannen', 'jaaromzet bijwerken', 'huizen bekijken']) {
    assert.equal(toetsLabel(label).ok, false, label);
  }
});

test('onderwerpen die zonder eigennaam zakken voor de krant-toets vallen ook af', () => {
  for (const label of [
    'Slaap verbeteren met een app',
    'Cashflow automatisch bijwerken',
    'Verhuizing organiseren en begroten',
    'Persoonlijke aankooplijst bijhouden',
  ]) {
    const res = toetsLabel(label);
    assert.equal(res.ok, false, label);
    assert.equal(res.reden, 'onderwerp', label);
  }
});

test('een ander schrift of een homoglief zakt op de tekenset', () => {
  // Zonder deze poort levert een volledig Cyrillisch label NUL woorden op en zou het ongetoetst
  // doorgaan; een Cyrillische `а` middenin een woord zou de allowlist omzeilen (bevinding Gemini).
  assert.equal(toetsLabel('Внутренний документ').reden, 'teken');
  assert.equal(toetsLabel('sаmen werken').reden, 'teken');
  assert.equal(toetsLabel('Factuur van € 250 betalen').reden, 'teken');
});

test('onzichtbare tekens breken een geblokkeerd woord niet open', () => {
  // Zero-width space middenin `verhuizing` (bevinding Codex/Gemini).
  const res = toetsLabel('ver​huizing organiseren');
  assert.equal(res.ok, false);
  assert.equal(res.reden, 'onderwerp');
  assert.equal(normaliseer('ver​huizing'), 'verhuizing');
});

test('lange cijferreeksen zakken: datums, bedragen, telefoon- en rekeningnummers', () => {
  for (const label of ['bel 0612345678', 'factuur van 250000 euro', 'oplevering op 12-08-2026']) {
    const res = toetsLabel(label);
    assert.equal(res.ok, false, label);
    assert.equal(res.reden, 'getal', label);
  }
});

test('links, domeinen en @-handles vallen af — ook met spaties eromheen', () => {
  // De punt en de apestaart staan niet meer in de tekenset, dus ook `voorbeeld .nl` en
  // `info @ voorbeeld .com` zakken — die glipten langs een pure regex (her-review Gemini).
  for (const label of [
    'Wekelijkse scan van voorbeeld.nl',
    'Automatisch ophalen via https://ergens/pad',
    'Bericht naar @iemand sturen',
    'Bekijk voorbeeld.be',
    'Scan van d.nl',
    'Scan van voorbeeld .nl',
    'Mail naar info @ voorbeeld .com',
    'Ophalen via ftp://voorbeeld.xyz/pad',
  ]) {
    const res = toetsLabel(label);
    assert.equal(res.ok, false, label);
    assert.ok(res.reden === 'verwijzing' || res.reden === 'teken', `${label}: ${res.reden}`);
  }
});

test('tekens die in een naam niets te zoeken hebben zakken — laag boven de render-escape', () => {
  assert.equal(toetsLabel('<img src=x onerror=1>').reden, 'teken');
});

test('een naam die met losse letters is gespeld zakt ook', () => {
  // Eén-letterwoorden staan niet op de allowlist; anders spelt `T-I-M` de naam alsnog voluit
  // (bevinding Codex, her-review 26-07-2026).
  assert.equal(toetsLabel('T-I-M koppelen').ok, false);
  assert.equal(toetsLabel('T1i1m koppelen').ok, false);
});

test('cijfers tellen over het HELE label, niet per aaneengesloten reeks', () => {
  // `06-123-456-78` en `250 000` zouden anders langs een reeks-toets glippen (bevinding Codex).
  for (const label of ['bel 06-123-456-78', 'begroting 250 000', 'oplevering 20 26']) {
    assert.equal(toetsLabel(label).reden, 'getal', label);
  }
  // Maar een gewoon technisch label met een kort getal mag blijven.
  assert.equal(toetsLabel('200ms hot path bewaken').ok, true);
});

test('de reden noemt nooit het afgekeurde woord zelf', () => {
  // Anders lekt een klantnaam alsnog via een logregel of foutmelding.
  const res = toetsLabel('Migratie voor Zephyrion Holding');
  assert.equal(res.ok, false);
  assert.ok(REDENEN.has(res.reden), `onbekende reden: ${res.reden}`);
  assert.equal(res.reden.toLowerCase().includes('zephyrion'), false);
});

test('een leeg, blanco of woordloos label komt er niet door', () => {
  assert.equal(toetsLabel('').ok, false);
  assert.equal(toetsLabel('   ').ok, false);
  assert.equal(toetsLabel(null).ok, false);
  assert.equal(toetsLabel('--- 12 ---').reden, 'leeg');
});

test('woorden zijn letterreeksen: cijfers en leestekens scheiden', () => {
  assert.deepEqual(woordenVan('Klant-AI / notitie'), ['Klant', 'AI', 'notitie']);
  assert.deepEqual(woordenVan('3Zephyrion'), ['Zephyrion']);
});

test('het meegeleverde poortbestand laadt en heeft een gevulde allowlist', () => {
  const p = laadLabelPoort();
  assert.equal(p.geladen, true);
  assert.ok(p.toegestaan.size > 500, 'een magere allowlist zou de toets zinloos maken');
  assert.ok(p.geblokkeerd.length > 20);
});

test('poortbestand onbereikbaar ⇒ ALLES zakt (fail-closed, geen publicatie)', () => {
  try {
    const p = laadLabelPoort('/bestaat/echt/niet/label-poort.json');
    assert.equal(p.geladen, false);
    const res = toetsLabel('Dagelijkse automatische contentpublicatie');
    assert.equal(res.ok, false, 'zonder poort mag er niets gepubliceerd worden');
    assert.equal(res.reden, 'poort-onbeschikbaar');
  } finally {
    resetLabelPoort();
  }
});

test('een te mager of tegenstrijdig poortbestand telt ook als geen poort', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'poort-'));
  const schrijf = (naam, obj) => {
    const pad = join(dir, naam);
    writeFileSync(pad, JSON.stringify(obj));
    return pad;
  };
  const veelWoorden = (prefix) => Array.from({ length: 60 }, (_, i) => `${prefix}${i}`);
  try {
    // Te mager: één toegestaan woord is geen poort — dan zou alles behalve dat woord zakken, maar
    // een half gevulde lijst geeft juist de illusie van dekking.
    assert.equal(laadLabelPoort(schrijf('mager.json', { woorden_toegestaan: ['taak'], woorden_geblokkeerd: veelWoorden('blok') })).geladen, false);
    // Tegenstrijdig: een toegestaan woord dat op een geblokkeerd onderwerp begint.
    assert.equal(
      laadLabelPoort(
        schrijf('strijdig.json', {
          woorden_toegestaan: [...veelWoorden('woord'), 'slaapritme'],
          woorden_geblokkeerd: [...veelWoorden('blok'), 'slaap'],
        }),
      ).geladen,
      false,
    );
  } finally {
    resetLabelPoort();
  }
});
