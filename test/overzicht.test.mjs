/**
 * OVERZICHT-PLAAT — de rollup bovenaan de pagina.
 *
 * Deze plaat is een synthese van wat elders op de pagina al staat; hij haalt niets nieuws op.
 * Daarom is de kern van deze suite niet "telt hij goed" maar "liegt hij nooit": een bron die
 * ontbreekt of onbereikbaar is mag nergens als groen of als nul verschijnen. Die eerlijkheidsregel
 * is te belangrijk om alleen als code-regel te bestaan (opdracht Richard/Fable 24-07-2026) en
 * staat hieronder daarom als probe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderHtml, rollup, VERS_DAGEN } from '../scripts/lib/render.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(join(ROOT, 'data/fixture.json'), 'utf8'));
const verbodenBeloftes = JSON.parse(await readFile(join(ROOT, 'data/verboden-beloftes.json'), 'utf8'));

const dagenGeleden = (n) => new Date(Date.now() - n * 86400000).toISOString();

/** Alleen de overzicht-sectie: assertions over "nergens groen" mogen niet de rest van de pagina meenemen. */
const plaatVan = (html) => {
  const i = html.indexOf('id="overzicht"');
  assert.notEqual(i, -1, 'de plaat hoort op de pagina te staan');
  return html.slice(i, html.indexOf('</section>', i));
};

/** Eén tegel op zijn label — anders lekt de klasse van een buurtegel in de assertion. */
const tegelVan = (plaat, label) => {
  // Labels staan geëscaped in de HTML ("Open PR&#39;s"), dus zoek op dezelfde vorm.
  const l = plaat.indexOf(`>${label.replace(/'/g, '&#39;')}<`);
  assert.notEqual(l, -1, `tegel "${label}" ontbreekt`);
  return plaat.slice(plaat.lastIndexOf('<li class="stat', l), plaat.indexOf('</li>', l));
};

// --- rollup-telling ---

test('rollup telt de CI-ampels: groen, rood en totaal', () => {
  const s = structuredClone(fixture);
  s.ci.lights = [
    { repository: 'a', state: 'GROEN', at: null },
    { repository: 'b', state: 'GROEN', at: null },
    { repository: 'c', state: 'ROOD', at: null },
    { repository: 'd', state: 'GEEN_CI', at: null },
  ];
  const r = rollup(s);
  assert.equal(r.ci.available, true);
  assert.equal(r.ci.groen, 2);
  assert.equal(r.ci.rood, 1);
  assert.equal(r.ci.totaal, 4);
});

test('rood tot en met drie repo\'s wordt bij naam genoemd, daarboven alleen de telling', () => {
  // Anders is het cijfer een raadsel dat Richard moet gaan zoeken (aanscherping 24-07-2026).
  const s = structuredClone(fixture);
  const rood = (n) => Array.from({ length: n }, (_, i) => ({ repository: `repo-${i}`, state: 'ROOD', at: null }));

  s.ci.lights = rood(3);
  const drie = rollup(s);
  assert.deepEqual(drie.ci.roodRepos, ['repo-0', 'repo-1', 'repo-2']);

  s.ci.lights = rood(4);
  const vier = rollup(s);
  assert.equal(vier.ci.rood, 4);
  assert.equal(vier.ci.roodRepos, null, 'boven drie: geen namenlijst, alleen de telling');
});

test('rollup verdeelt tracks in vers, verouderd en zonder rapport', () => {
  const s = structuredClone(fixture);
  s.tracks.tracks = [
    { track: 'VERS', lastReportAt: dagenGeleden(1), reportCount: 2, trust: 'VERIFIED_CURRENT' },
    { track: 'OUD', lastReportAt: dagenGeleden(VERS_DAGEN + 5), reportCount: 1, trust: 'VERIFIED_CURRENT' },
    { track: 'NOOIT', lastReportAt: null, reportCount: 0, trust: 'UNVERIFIED' },
  ];
  const r = rollup(s);
  assert.equal(r.tracks.vers, 1);
  assert.equal(r.tracks.verouderd, 1);
  assert.equal(r.tracks.zonder, 1);
});

test('de koudste hoek draagt de tracknaam, niet alleen een leeftijd', () => {
  const s = structuredClone(fixture);
  s.tracks.tracks = [
    { track: 'WARM', lastReportAt: dagenGeleden(1), reportCount: 5, trust: 'VERIFIED_CURRENT' },
    { track: 'KOUDSTE', lastReportAt: dagenGeleden(40), reportCount: 1, trust: 'VERIFIED_CURRENT' },
  ];
  const r = rollup(s);
  assert.equal(r.tracks.koudste.track, 'KOUDSTE');

  const html = renderHtml(s);
  assert.match(html, /KOUDSTE/, 'de naam van de koude hoek hoort zichtbaar op de plaat');
});

test('een track zonder enig rapport is de koudste hoek — kouder dan welke leeftijd ook', () => {
  const s = structuredClone(fixture);
  s.tracks.tracks = [
    { track: 'OUD-MAAR-BESTAAT', lastReportAt: dagenGeleden(90), reportCount: 1, trust: 'VERIFIED_CURRENT' },
    { track: 'STIL', lastReportAt: null, reportCount: 0, trust: 'UNVERIFIED' },
  ];
  const r = rollup(s);
  assert.equal(r.tracks.koudste.track, 'STIL');
  assert.equal(r.tracks.koudste.lastReportAt, null);
  assert.match(renderHtml(s), /STIL/);
});

test('rollup neemt open PR\'s en open beslispunten over', () => {
  const s = structuredClone(fixture);
  s.pullRequests.totals.open = 7;
  s.tracker.decisionPoints = [{ id: '1a', title: null, category: 'x' }, { id: '2b', title: null, category: 'y' }];
  const r = rollup(s);
  assert.equal(r.prs.open, 7);
  assert.equal(r.beslispunten.open, 2);
});

// --- eerlijkheid: de kernprobe ---

test('PROBE — een ontbrekende of onbereikbare bron toont "onbekend" en nergens groen', () => {
  const s = structuredClone(fixture);
  // CI onbereikbaar, tracks-bron weg, PR-sectie niet beschikbaar, tracker helemaal afwezig.
  s.ci = { available: false, lights: [], evidence: { trust: 'SOURCE_UNAVAILABLE', errorCode: 'BRON_ONBEREIKBAAR', retrievedAt: null } };
  s.tracks = { available: false, tracks: [], evidence: { trust: 'SOURCE_UNAVAILABLE', errorCode: 'BRON_ONBEREIKBAAR', retrievedAt: null } };
  s.pullRequests.available = false;
  delete s.tracker;

  const r = rollup(s);
  for (const [naam, tak] of Object.entries(r)) {
    assert.equal(tak.available, false, `${naam} moet als onbeschikbaar gelden`);
  }
  // Geen enkele telling mag stilletjes 0 worden: 0 leest als "niets mis", en dat weten we niet.
  assert.equal(r.ci.groen, null);
  assert.equal(r.ci.rood, null);
  assert.equal(r.tracks.koudste, null);
  assert.equal(r.prs.open, null);
  assert.equal(r.beslispunten.open, null);

  const html = renderHtml(s);
  const plaat = html.slice(html.indexOf('id="overzicht"'), html.indexOf('</section>', html.indexOf('id="overzicht"')));
  assert.match(plaat, /onbekend/i, 'de plaat benoemt de onbekende stand expliciet');
  assert.equal(/dot ok|class="[^"]*\bok\b/.test(plaat), false, 'geen groen ampeltje bij een onbekende stand');
  assert.equal(/\bgroen\b/i.test(plaat), false, 'het woord groen hoort hier niet te staan');
});

test('PROBE — een niet-op-te-halen ampel maakt de CI-tegel nooit groen', () => {
  // "Geen rood" is geen bewijs van "alles in orde" zolang een ampel onbekend is. Zelf gevonden
  // tijdens de eerste echte build: de tegel kreeg een groene rand bij rood=0 én onbekend>0.
  const s = structuredClone(fixture);
  s.ci.lights = [
    { repository: 'a', state: 'GROEN', at: null },
    { repository: 'b', state: 'ONBEKEND', at: null },
  ];
  const html = renderHtml(s);
  const plaat = html.slice(html.indexOf('id="overzicht"'), html.indexOf('</section>', html.indexOf('id="overzicht"')));
  const ciTegel = plaat.slice(plaat.indexOf('<li class="stat'), plaat.indexOf('</li>'));
  assert.equal(/class="stat ok"/.test(ciTegel), false, 'geen groene tegel zolang een ampel onbekend is');
  assert.match(ciTegel, /class="stat warn"/);
  assert.match(ciTegel, /niet op te halen/);
});

test('PROBE — een half-lege bron maakt alleen díé tak onbekend, niet de hele plaat', () => {
  const s = structuredClone(fixture);
  s.ci.available = false;
  const r = rollup(s);
  assert.equal(r.ci.available, false);
  assert.equal(r.prs.available, true, 'de PR-tak blijft gewoon geldig');
});

// --- fail-open-gaten uit de dubbele review van 24-07-2026 (Codex + Gemini) ---

test('PROBE — een rapport met een datum in de toekomst telt nooit als vers', () => {
  // collect.mjs/ageTrust() zet zo'n track bewust op UNVERIFIED: een toekomstdatum is geen verse
  // bron maar een kapotte klok. De plaat mag die nuance niet wegpoetsen (Codex, hoog).
  const s = structuredClone(fixture);
  s.tracks.tracks = [{
    track: 'KAPOTTE-KLOK',
    lastReportAt: new Date(Date.now() + 5 * 86400000).toISOString(),
    reportCount: 1,
    trust: 'UNVERIFIED',
  }];
  const r = rollup(s);
  assert.equal(r.tracks.vers, 0, 'een onbetrouwbare datum is geen vers rapport');
  assert.equal(r.tracks.zonder, 1);
  assert.equal(r.tracks.koudste.track, 'KAPOTTE-KLOK');

  const plaat = plaatVan(renderHtml(s));
  assert.equal(/class="stat ok"/.test(plaat), false, 'niets groens bij een kapotte klok');
  assert.match(plaat, /geen bruikbaar klaar-rapport/);
});

test('PROBE — een nul uit een onbetrouwbare bron is "onbekend", geen gezaghebbende 0', () => {
  // trustFor(count) in collect.mjs markeert elke telling van nul als UNVERIFIED: een kapot token
  // of een stukke parser levert óók nul op. "0 open PR's" leest als "niets te doen" (Codex, hoog).
  const s = structuredClone(fixture);
  s.pullRequests.totals.open = 0;
  s.pullRequests.evidence.trust = 'UNVERIFIED';
  s.tracker.decisionPoints = [];
  s.tracker.evidence.trust = 'UNVERIFIED';

  const r = rollup(s);
  assert.equal(r.prs.available, false);
  assert.equal(r.prs.open, null, 'geen kale 0 uit een onbetrouwbare bron');
  assert.equal(r.beslispunten.available, false);
  assert.equal(r.beslispunten.open, null);
  assert.match(plaatVan(renderHtml(s)), /onbekend/i);
});

test('PROBE — bij rood én onbekend blijven beide zichtbaar', () => {
  // Eerder toonde {ROOD, ONBEKEND} alleen de rode repo; de onbereikbare verdween (Codex, hoog).
  // De sectietrust staat hier op UNVERIFIED omdat de collector dat óók doet zodra één ampel
  // ONBEKEND is. Een sectie-brede trust-poort zou dus juist dit geval wegdrukken — de eerste
  // versie van deze test liet trust op VERIFIED_CURRENT staan en miste dat (her-pass Codex).
  const s = structuredClone(fixture);
  s.ci.lights = [
    { repository: 'stuk-repo', state: 'ROOD', at: null },
    { repository: 'stille-repo', state: 'ONBEKEND', at: null },
  ];
  s.ci.evidence.trust = 'UNVERIFIED';
  const plaat = plaatVan(renderHtml(s));
  assert.match(plaat, /stuk-repo/, 'de rode repo bij naam');
  assert.match(plaat, /niet op te halen/, 'de onbekende ampel blijft zichtbaar naast het rood');
});

test('PROBE — alleen grijs of "geen CI" levert nooit een groene tegel op', () => {
  // 0/2 groen met een groene rand was de oude uitkomst (Codex, hoog).
  const s = structuredClone(fixture);
  s.ci.lights = [
    { repository: 'a', state: 'GEEN_CI', at: null },
    { repository: 'b', state: 'GRIJS', at: null },
  ];
  const plaat = plaatVan(renderHtml(s));
  assert.equal(/class="stat ok"/.test(plaat), false, 'geen groen zonder één groene ampel');
  assert.match(plaat, /0\/2 groen/);
});

test('PROBE — verborgen repo\'s tellen mee in de noemer', () => {
  // "1/1 groen" terwijl er twee verzwegen zijn is een te mooie voorstelling (Codex, middel).
  const s = structuredClone(fixture);
  s.ci.lights = [{ repository: 'zichtbaar', state: 'GROEN', at: null }];
  s.ci.hiddenCiRepositories = 2;
  const r = rollup(s);
  assert.equal(r.ci.totaal, 3);
  const plaat = plaatVan(renderHtml(s));
  assert.match(plaat, /1\/3 groen/);
  assert.match(plaat, /niet bij naam getoond/);
  assert.equal(/class="stat ok"/.test(plaat), false, 'onbekende verborgen ampels maken het niet groen');
});

test('een koudste hoek die zelf nog vers is, waarschuwt niet', () => {
  // Anders staat er een oranje rand op een volledig gezond overzicht: alert-moeheid (Gemini).
  const s = structuredClone(fixture);
  s.tracks.tracks = [
    { track: 'A', lastReportAt: dagenGeleden(1), reportCount: 3, trust: 'VERIFIED_CURRENT' },
    { track: 'B', lastReportAt: dagenGeleden(2), reportCount: 3, trust: 'VERIFIED_CURRENT' },
  ];
  const tegel = tegelVan(plaatVan(renderHtml(s)), 'Koudste hoek');
  assert.match(tegel, /class="stat ok"/, 'een verse koudste hoek is groen, geen waarschuwing');
  assert.match(tegel, /laatste rapport/);
});

test('rollup is deterministisch bij een vast referentietijdstip', () => {
  // De comparator gebruikte Date.now() per vergelijking (Gemini): formeel non-deterministisch.
  const s = structuredClone(fixture);
  s.tracks.tracks = [
    { track: 'A', lastReportAt: dagenGeleden(3), reportCount: 1, trust: 'VERIFIED_CURRENT' },
    { track: 'B', lastReportAt: dagenGeleden(30), reportCount: 1, trust: 'VERIFIED_CURRENT' },
  ];
  const nu = Date.parse('2026-07-24T12:00:00.000Z');
  assert.deepEqual(rollup(s, nu), rollup(s, nu));
  assert.equal(rollup(s, nu).tracks.koudste.track, 'B');
});

// --- her-pass 24-07-2026 (Codex, over alleen de fix-diff) ---

test('PROBE — een ontbrekend PR-totaal wordt onbekend, niet stilletjes 0', () => {
  // num(null) rendert als "0" omdat Number(null) === 0: de tak leek fail-closed maar was het niet.
  const s = structuredClone(fixture);
  delete s.pullRequests.totals.open;
  const r = rollup(s);
  assert.equal(r.prs.available, false);
  assert.equal(r.prs.open, null);
  const tegel = tegelVan(plaatVan(renderHtml(s)), 'Open PR\'s');
  assert.match(tegel, /onbekend/i);
  assert.equal(/>0</.test(tegel), false, 'geen kale nul bij een ontbrekend totaal');
});

test('PROBE — een lege tracklijst wordt nooit groen', () => {
  // "0/0 vers" in het groen suggereert een gezonde stand waar niets gevolgd wordt.
  const s = structuredClone(fixture);
  s.tracks.tracks = [];
  const tegel = tegelVan(plaatVan(renderHtml(s)), 'Tracks');
  assert.equal(/class="stat ok"/.test(tegel), false);
  assert.match(tegel, /0\/0 vers/);
});

test('PROBE — CI blijft per ampel beoordeeld, ook als de sectie UNVERIFIED heet', () => {
  // De collector zet de CI-sectie op UNVERIFIED zodra één ampel onbekend is. Een sectie-brede
  // poort zou dan élk signaal wegdrukken, inclusief een echte rode ampel.
  const s = structuredClone(fixture);
  s.ci.lights = [
    { repository: 'kapot', state: 'ROOD', at: null },
    { repository: 'stil', state: 'ONBEKEND', at: null },
  ];
  s.ci.evidence.trust = 'UNVERIFIED';
  const r = rollup(s);
  assert.equal(r.ci.available, true, 'de ampels blijven beoordeelbaar');
  assert.equal(r.ci.rood, 1);
  assert.equal(r.ci.onbekend, 1);
  const tegel = tegelVan(plaatVan(renderHtml(s)), 'CI-ampels');
  assert.match(tegel, /class="stat bad"/, 'rood weegt het zwaarst');
  assert.match(tegel, /kapot/);
  assert.match(tegel, /niet op te halen/);
});

// --- publicatiedoctrine: escaping en geen valse beloftes ---

test('de plaat escapet een tracknaam die stiekem HTML is', () => {
  const s = structuredClone(fixture);
  s.tracks.tracks = [{ track: '<img src=x onerror=alert(1)>', lastReportAt: dagenGeleden(30), reportCount: 1, trust: 'VERIFIED_CURRENT' }];
  const html = renderHtml(s);
  assert.equal(html.includes('<img src=x'), false);
  assert.match(html, /&lt;img src=x/);
});

test('de plaat escapet een reponaam die stiekem HTML is', () => {
  const s = structuredClone(fixture);
  s.ci.lights = [{ repository: '</span><script>alert(1)</script><span>', state: 'ROOD', at: null }];
  const html = renderHtml(s);
  assert.equal(/<script/i.test(html), false);
});

test('een telling die stiekem HTML is komt er niet als markup in', () => {
  const s = structuredClone(fixture);
  s.pullRequests.totals.open = '</p><script>alert(1)</script><p>';
  const html = renderHtml(s);
  assert.equal(/<script/i.test(html), false, 'tellingen moeten door num() gaan');
});

test('de plaat belooft geen versheid die de CDN niet waarmaakt', () => {
  // Gemeten 24-07-2026: GitHub Pages/Fastly serveert tot ~10 min een gecachte kopie (zelfde
  // x-github-request-id over verschillende query-strings). Een plaat die "live" of een interval
  // onder tien minuten suggereert, liegt dus per constructie.
  const html = renderHtml(fixture);
  const plaat = html.slice(html.indexOf('id="overzicht"'), html.indexOf('</section>', html.indexOf('id="overzicht"')));
  for (const p of verbodenBeloftes.patronen) {
    assert.equal(plaat.toLowerCase().includes(p.toLowerCase()), false, `verboden belofte op de plaat: "${p}"`);
  }
  assert.equal(/\blive\b/i.test(plaat), false, 'de plaat mag zich niet "live" noemen');
  assert.equal(/realtime|real-time|actueel op de minuut/i.test(plaat), false);
});
