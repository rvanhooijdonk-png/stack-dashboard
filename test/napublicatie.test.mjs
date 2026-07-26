/**
 * NA-PUBLICATIE-CONTROLE — de tests staan vóór de bouw, en de eerste groep test precies het punt
 * waar deze controle om te doen is: een controle die géén uitspraak deed is ROOD.
 *
 * Waarom dat het gevoeligste punt is. Een wachtende controle heeft drie natuurlijke uitkomsten:
 * gelukt, niet gelukt, en "we weten het niet" (deadline, netwerkfout, job overgeslagen, run
 * geannuleerd). Die derde is de gevaarlijke: in de meeste opzetten wordt hij stilletjes groen of
 * verdwijnt hij uit het overzicht, en dan bewaakt de bewaker niets meer. Besluit Fable, 26-07-2026:
 * nooit "onbekend" — overgeslagen en geannuleerd tellen als rood.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  jobUitkomstKleur, versheidRonde, versheidEindstand,
  POLL_MS, DEADLINE_MS, SPIEGELALARM_AAN, VERSHEID_MARGE_MS,
} from '../scripts/lib/napublicatie.mjs';

/**
 * De nepagina wordt op dezelfde manier gestempeld als de echte: de 17-cijferige buster in de kop is
 * de machinale stempel, de zichtbare regel de menselijke. Bewust geen eigen stempelvorm in deze test
 * — dan zou de test iets bewijzen over een pagina die niet bestaat.
 */
const stempel17 = (ms) => new Date(ms).toISOString().replace(/[-:T.Z]/g, '').slice(0, 17);
const nlHhmm = (ms) => new Intl.DateTimeFormat('nl-NL', {
  timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(ms));
const pagina = (stempelMs) => {
  const utc = new Date(stempelMs).toISOString().slice(11, 16);
  return `<html><head><meta http-equiv="refresh" content="900; url=./?v=${stempel17(stempelMs)}">`
    + '</head><body><p class="stamp">Laatst bijgewerkt: '
    + `<strong>gebouwd om ${nlHhmm(stempelMs)} NL-tijd (${utc} UTC)</strong></p></body></html>`;
};

// --- 1. geen uitspraak = rood -------------------------------------------------------------------

test('een job-uitkomst die geen succes is, is rood — ook overgeslagen, geannuleerd en leeg', () => {
  for (const uitkomst of ['skipped', 'cancelled', 'failure', '', null, undefined, 'onbekend', 'neutral']) {
    assert.equal(jobUitkomstKleur(uitkomst), 'rood', `uitkomst ${JSON.stringify(uitkomst)} hoort rood te zijn`);
  }
  assert.equal(jobUitkomstKleur('success'), 'groen');
});

test('de deadline verstrijken zonder verse stempel is rood, niet onbekend', () => {
  const eind = versheidEindstand({ vers: false, verstrekenMs: DEADLINE_MS + 1, rondes: 16 });
  assert.equal(eind.kleur, 'rood');
  assert.equal(eind.code, 'DEADLINE_ZONDER_VERSE_STEMPEL');
});

test('een lus die nul ronden deed is rood — niets gemeten is niet hetzelfde als niets aan de hand', () => {
  const eind = versheidEindstand({ vers: false, verstrekenMs: 0, rondes: 0 });
  assert.equal(eind.kleur, 'rood');
  assert.equal(eind.code, 'GEEN_UITSPRAAK');
});

test('er bestaat geen derde kleur: elke eindstand is groen of rood', () => {
  const gevallen = [
    { vers: true, verstrekenMs: 0, rondes: 1 },
    { vers: true, verstrekenMs: DEADLINE_MS + 60_000, rondes: 20 },
    { vers: false, verstrekenMs: 1000, rondes: 3 },
    { vers: null, verstrekenMs: 1000, rondes: 3 },
  ];
  for (const g of gevallen) assert.ok(['groen', 'rood'].includes(versheidEindstand(g).kleur));
});

// --- 2. het wachten zelf -----------------------------------------------------------------------

test('een verse stempel is groen en stopt de lus onmiddellijk', () => {
  const referentieMs = Date.parse('2026-07-26T08:00:00Z');
  const r = versheidRonde({
    paginaStatus: 200, paginaHtml: pagina(referentieMs + 30_000), referentieMs, nu: referentieMs + 60_000,
  });
  assert.equal(r.vers, true);
  assert.equal(versheidEindstand({ vers: true, verstrekenMs: 60_000, rondes: 2 }).kleur, 'groen');
});

test('de stempel van de VORIGE bouw geldt niet als vers', () => {
  const referentieMs = Date.parse('2026-07-26T08:00:00Z');
  const r = versheidRonde({
    paginaStatus: 200,
    paginaHtml: pagina(referentieMs - VERSHEID_MARGE_MS - 60_000),
    referentieMs,
    nu: referentieMs + 60_000,
  });
  assert.equal(r.vers, false);
  assert.equal(r.code, 'STEMPEL_NOG_OUD');
});

test('een stempel van één seconde vóór de publicatie is niet vers — anders wint de vorige bouw', () => {
  // Het gat dat Codex en Gemini onafhankelijk vonden: met speling naar het verleden meldt een
  // publicatie die kort op de vorige volgt meteen groen, terwijl de nieuwe plaat nog niet live is.
  const referentieMs = Date.parse('2026-07-26T08:00:00Z');
  const r = versheidRonde({
    paginaStatus: 200, paginaHtml: pagina(referentieMs - 1000), referentieMs, nu: referentieMs + 30_000,
  });
  assert.equal(r.vers, false);
  assert.equal(r.code, 'STEMPEL_NOG_OUD');
  assert.equal(VERSHEID_MARGE_MS, 0);
});

test('een verkort venster levert de deadline-uitkomst, niet "afgebroken"', () => {
  // De zelftest verkort het wachten 60x. Zonder het venster mee te geven zou juist die test een
  // andere code opleveren dan de echte ronde, en dan bewijst de acceptatietest het verkeerde pad.
  const eind = versheidEindstand({ vers: false, verstrekenMs: 8100, rondes: 16, deadlineMs: 8000 });
  assert.equal(eind.kleur, 'rood');
  assert.equal(eind.code, 'DEADLINE_ZONDER_VERSE_STEMPEL');
});

test('een onbereikbare pagina is geen verse stempel, maar ook geen harde stop', () => {
  const referentieMs = Date.parse('2026-07-26T08:00:00Z');
  const r = versheidRonde({ paginaStatus: 0, paginaHtml: '', referentieMs, nu: referentieMs + 1000 });
  assert.equal(r.vers, false);
  assert.equal(r.code, 'PAGINA_ONBEREIKBAAR');
});

test('een pagina zonder leesbare stempel is niet vers', () => {
  const referentieMs = Date.parse('2026-07-26T08:00:00Z');
  const r = versheidRonde({
    paginaStatus: 200, paginaHtml: '<html><body>niets</body></html>', referentieMs, nu: referentieMs + 1000,
  });
  assert.equal(r.vers, false);
  assert.equal(r.code, 'GEEN_STEMPEL');
});

test('een stempel ver in de toekomst is niet vers — dan klopt de klok of de pagina niet', () => {
  const referentieMs = Date.parse('2026-07-26T08:00:00Z');
  const r = versheidRonde({
    paginaStatus: 200, paginaHtml: pagina(referentieMs + 48 * 3600 * 1000), referentieMs, nu: referentieMs + 1000,
  });
  assert.equal(r.vers, false);
  assert.equal(r.code, 'STEMPEL_IN_TOEKOMST');
});

test('het ritme is dat van het besluit: elke 30 seconden, maximaal 8 minuten', () => {
  assert.equal(POLL_MS, 30_000);
  assert.equal(DEADLINE_MS, 8 * 60 * 1000);
});

// --- 3. het publieke alarm staat aantoonbaar UIT ------------------------------------------------

test('deze controle zet niets in de publieke spiegel tot hij zich bewezen heeft', () => {
  assert.equal(SPIEGELALARM_AAN, false);
});

test('de eindstand levert een regel voor het bouwlogboek, zonder URL of foutdetail', () => {
  const eind = versheidEindstand({ vers: false, verstrekenMs: DEADLINE_MS + 1, rondes: 16 });
  assert.match(eind.uitleg, /publicatie/i);
  assert.doesNotMatch(eind.uitleg, /https?:|github\.io|raw\./);
});
