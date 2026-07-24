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
