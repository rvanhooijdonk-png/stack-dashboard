import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderCockpit } from '../scripts/lib/render-cockpit.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(join(ROOT, 'data/fixture.json'), 'utf8'));

test('rendert een volledige pagina met verversing, CSP en tijdstempel', () => {
  const html = renderCockpit(fixture, { refreshSeconds: 900 });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<meta http-equiv="refresh" content="900; url=\.\/\?v=\d+">/);
  assert.match(html, /content-security-policy/i);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /Laatst bijgewerkt: <strong>gebouwd om 14:00 NL-tijd \(12:00 UTC\)<\/strong>/);
});

test('haalt geen externe bronnen op en draait geen script', () => {
  const html = renderCockpit(fixture);
  assert.equal(/<script/i.test(html), false, 'geen script-tags');
  assert.equal(/(src|href)=["']https?:/i.test(html), false, 'geen externe assets');
});

test('"rood eerst" toont de niet-VERIFIED_CURRENT bron en het ONBEKEND-venster uit de fixture', () => {
  const html = renderCockpit(fixture);
  assert.match(html, /id="rood-eerst"/);
  assert.match(html, /journaal/, 'logbook staat in de fixture op SOURCE_UNAVAILABLE');
  assert.match(html, /ongeverifieerd|bron onbereikbaar/i);
  assert.match(html, /MARKT/, 'MARKT staat in de fixture op ONBEKEND');
  assert.match(html, /stil, stand onbekend/);
});

test('"rood eerst" toont een eerlijke leegmelding zonder enig roodpunt', () => {
  const schoon = structuredClone(fixture);
  schoon.sources = schoon.sources.map((s) => ({ ...s, trust: 'VERIFIED_CURRENT' }));
  schoon.vlootstand.vensters = schoon.vlootstand.vensters.map((v) => ({ ...v, toestand: 'WERKT' }));
  schoon.ci.lights = schoon.ci.lights.map((l) => ({ ...l, state: 'GROEN' }));
  const html = renderCockpit(schoon);
  assert.match(html, /Niets roods/);
});

test('"wat draait" toont het WERKT-venster en de in-bouw-feature uit de fixture', () => {
  const html = renderCockpit(fixture);
  assert.match(html, /id="wat-draait"/);
  assert.match(html, /DASHBOARD/);
  assert.match(html, /Planning-plaat op het dashboard/);
});

test('"taken voor jou" toont de wacht-op-Richard-feature en de gate-rijen met actie Richard', () => {
  const html = renderCockpit(fixture);
  assert.match(html, /id="taken-voor-jou"/);
  assert.match(html, /Tijdstempel in Nederlandse tijd/);
  assert.match(html, /Twee integratiegaten in het centrale modellenregister gedicht/);
});

test('"taken voor jou" zet de te mergen pull requests als eerste gate bovenaan', () => {
  const html = renderCockpit(fixture);
  // fixture: totals.ready = 2 (3 open, waarvan 1 draft)
  assert.match(html, /2 open pull request\(s\) zonder draft-status/);
  assert.match(html, /merge is jouw poort/);
});

test('"taken voor jou" belooft geen mergebaarheid die de teller niet meet', () => {
  const html = renderCockpit(fixture);
  // `totals.ready` telt in collect.mjs uitsluitend `!pr.isDraft` — niets over mergeable,
  // checks of reviews. De regel mag dus niet "klaar om gemerged te worden" beweren.
  assert.equal(html.includes('staan klaar om gemerged te worden'), false);
  assert.match(html, /mergebaarheid en checks zijn hier niet gemeten/);
});

test('"taken voor jou" rendert ook als er geen enkele gate open staat', () => {
  const leeg = structuredClone(fixture);
  leeg.gates = {
    available: true, reason: 'GEEN_GATE', rows: [], totaal: 0, zelfalarm: 0,
  };
  leeg.planning.features = leeg.planning.features.filter((f) => f.status !== 'wacht-op-Richard');
  leeg.pullRequests.totals = { open: 0, draft: 0, ready: 0 };
  const html = renderCockpit(leeg);
  assert.match(html, /id="taken-voor-jou"/);
  assert.match(html, /Alle drie de bronnen zijn gelezen/);
  assert.match(html, /Er staat op dit moment niets op jouw poort/);
  assert.equal(html.includes('geen meting — geen nulstand'), false);
  // Niets ingehouden: dan is de onvoorwaardelijke deelzin waar en hoort er geen uitzondering bij.
  assert.match(html, /geen kanaalpost-rij met jou als actiehouder\. Er staat/);
});

test('de lege staat spreekt de aftrek niet tegen: de ingehouden rijen staan in dezelfde zin', () => {
  const leeg = structuredClone(fixture);
  leeg.planning.features = leeg.planning.features.filter((f) => f.status !== 'wacht-op-Richard');
  leeg.pullRequests.totals = { open: 0, draft: 0, ready: 0 };
  // Enige gates met Richard als actiehouder zijn zelfalarm: de bron sprak wél, de plaat hield in.
  leeg.gates = {
    available: true, reason: 'GEEN_GATE', rows: [], totaal: 0, zelfalarm: 2,
  };
  const html = renderCockpit(leeg);
  assert.match(html, /behalve de 2 hieronder genoemde/);
  assert.equal(html.includes('geen kanaalpost-rij met jou als actiehouder. Er staat'), false,
    'de geruststelling mag niet beweren dat de bron zweeg terwijl er is ingehouden');
  assert.match(html, /2 melding\(en\) hier komen van de automatische controle zelf/);
});

test('"taken voor jou" meldt een uitgevallen PR-bron als onbekend en nooit als "niets op jouw poort"', () => {
  const leeg = structuredClone(fixture);
  leeg.gates = {
    available: true, reason: 'GEEN_GATE', rows: [], totaal: 0, zelfalarm: 0,
  };
  leeg.planning.features = leeg.planning.features.filter((f) => f.status !== 'wacht-op-Richard');
  // Precies wat collectPullRequests() bij een mislukte zoekopdracht teruggeeft.
  leeg.pullRequests = { ...leeg.pullRequests, available: false, totals: { open: 0, draft: 0, ready: 0 } };
  const html = renderCockpit(leeg);
  assert.match(html, /mergepoorten onbekend/);
  assert.match(html, /geen meting — geen nulstand/);
  assert.equal(html.includes('Er staat op dit moment niets op jouw poort'), false,
    'een onleesbare bron mag nooit als geruststelling verschijnen');
});

test('"taken voor jou" meldt een uitgevallen planning- of gates-bron apart als onbekend', () => {
  const leeg = structuredClone(fixture);
  leeg.planning = { ...leeg.planning, available: false, features: [] };
  leeg.gates = {
    available: false, reason: 'BRON_ONBEREIKBAAR', rows: [], totaal: 0, zelfalarm: 0,
  };
  const html = renderCockpit(leeg);
  assert.match(html, /wacht-op-Richard onbekend/);
  assert.match(html, /kanaalpost-gates onbekend/);
  assert.equal(html.includes('mergepoorten onbekend'), false, 'de PR-bron is hier wél leesbaar');
  assert.equal(html.includes('Er staat op dit moment niets op jouw poort'), false);
});

test('"taken voor jou" zet de onbekend-melding bovenaan en kleurt de teller rood', () => {
  const uit = structuredClone(fixture);
  uit.pullRequests = { ...uit.pullRequests, available: false, totals: { open: 0, draft: 0, ready: 0 } };
  const html = renderCockpit(uit);
  assert.match(html, /Taken voor jou <span class="badge warn">\d+<\/span> <span class="badge bad">1 bron onbekend<\/span>/);
  const sectie = html.slice(html.indexOf('id="taken-voor-jou"'));
  assert.ok(sectie.indexOf('mergepoorten onbekend') < sectie.indexOf('Twee integratiegaten'),
    'de onbekende bron staat vóór de bekende gates');
});

test('de teller in de kop telt taken, niet meetstoringen', () => {
  const uit = structuredClone(fixture);
  uit.pullRequests = { ...uit.pullRequests, available: false, totals: { open: 0, draft: 0, ready: 0 } };
  const taken = renderCockpit(fixture).match(/Taken voor jou <span class="badge warn">(\d+)<\/span>/)[1];
  const html = renderCockpit(uit);
  const metStoring = html.match(/Taken voor jou <span class="badge warn">(\d+)<\/span>/)[1];
  // De uitgevallen PR-bron kost één gate-regel (de te-mergen-regel valt weg) en voegt één
  // onbekend-regel toe. De takenteller mag daardoor niet omhoog gaan.
  assert.equal(Number(metStoring), Number(taken) - 1);
  assert.match(html, /<span class="badge bad">1 bron onbekend<\/span>/);
});

test('twee uitgevallen bronnen tellen als "2 bronnen onbekend", meervoud en al', () => {
  const uit = structuredClone(fixture);
  uit.planning = { ...uit.planning, available: false, features: [] };
  uit.gates = {
    available: false, reason: 'BRON_ONBEREIKBAAR', rows: [], totaal: 0, zelfalarm: 0,
  };
  const html = renderCockpit(uit);
  assert.match(html, /<span class="badge bad">2 bronnen onbekend<\/span>/);
});

test('"taken voor jou" leest de gates, niet het venster van vijftien kanaalpost-rijen', () => {
  // De kern van v2.7: een gate die uit het staartstuk is geschoven blijft staan. In de fixture staat
  // de PR-OPSCHONING-gate (18-07) WEL in `gates` en NIET in de laatste kanaalpost-rijen.
  const onderwerpen = fixture.kanaalpost.rows.map((r) => r.onderwerp);
  assert.equal(onderwerpen.some((o) => o.startsWith('Acht scraper-voorstellen')), false, 'fixture-aanname');
  const html = renderCockpit(fixture);
  assert.match(html, /Acht scraper-voorstellen beoordeeld/);
});

test('een gate leidt met de actie; de melding erachter is kort en zichtbaar afgekapt', () => {
  const lang = structuredClone(fixture);
  lang.gates.rows[0].actie = 'Richard: merge PR 61 of wijs hem af';
  lang.gates.rows[0].onderwerp = `${'w'.repeat(400)}EINDE`;
  const html = renderCockpit(lang);
  assert.match(html, /<span class="repo">Richard: merge PR 61 of wijs hem af<\/span>/);
  assert.equal(html.includes('EINDE'), false, 'de alinea van 400 tekens hoort niet voluit op het bord');
  assert.match(html, /w{119}…/);
});

test('"taken voor jou" toont het aantal zelfalarmen dat bewust buiten de lijst blijft', () => {
  const html = renderCockpit(fixture);
  assert.match(html, /3 melding\(en\) hier komen van de automatische controle zelf/);
});

test('"taken voor jou" meldt hoeveel oudere gates niet in de lijst passen', () => {
  const meer = structuredClone(fixture);
  meer.gates.totaal = 9;
  const html = renderCockpit(meer);
  assert.match(html, /7 oudere gate\(s\) passen niet in deze lijst/);
});

test('"taken voor jou" onderscheidt "niets te doen" van "niet gemeten"', () => {
  const leeg = structuredClone(fixture);
  leeg.planning.features = leeg.planning.features.filter((f) => f.status !== 'wacht-op-Richard');
  leeg.pullRequests.totals = { open: 0, draft: 0, ready: 0 };
  leeg.gates = {
    available: true, reason: 'GEEN_GATE', rows: [], totaal: 0, zelfalarm: 0,
  };
  assert.match(renderCockpit(leeg), /Er staat op dit moment niets op jouw poort/);

  const stuk = structuredClone(leeg);
  stuk.gates = {
    available: false, reason: 'BRON_ONBEREIKBAAR', rows: [], totaal: 0, zelfalarm: 0,
  };
  const html = renderCockpit(stuk);
  assert.match(html, /kanaalpost-gates onbekend/);
  assert.equal(html.includes('Er staat op dit moment niets op jouw poort'), false);
});

test('een snapshot zonder gates-veld telt als onbekende bron, geen valse leegte', () => {
  const oud = structuredClone(fixture);
  delete oud.gates;
  const html = renderCockpit(oud);
  assert.match(html, /kanaalpost-gates onbekend/);
  assert.equal(html.includes('Er staat op dit moment niets op jouw poort'), false);
});

test('het afsprakenspoor toont tellers per status en de laatste-wijziging-datum, geen afspraaktekst', () => {
  const html = renderCockpit(fixture);
  assert.match(html, /id="afsprakenspoor"/);
  assert.match(html, /Afsprakenspoor <span class="badge">44<\/span>/);
  assert.match(html, />vastgelegd<[\s\S]*?<span class="tag">3<\/span>/);
  assert.match(html, />uitgezet \(in bak\)<[\s\S]*?<span class="tag">15<\/span>/);
  assert.match(html, />verwerkt<[\s\S]*?<span class="tag">20<\/span>/);
  assert.match(html, />staand<[\s\S]*?<span class="tag">5<\/span>/);
  assert.match(html, /Laatste wijziging: 2026-07-23 09:00 UTC/);
  // Geen enkel veld uit de interne `entries` (id, afspraaktekst, bewijs) hoort op de publieke plaat.
  assert.equal(html.includes('A44'), false);
});

test('het afsprakenspoor toont een eerlijke leegmelding als de bron onbereikbaar is', () => {
  const zonder = structuredClone(fixture);
  zonder.afspraken = {
    available: false,
    statusCounts: { VASTGELEGD: 0, UITGEZET: 0, 'IN BOUW': 0, VERWERKT: 0, STAAND: 0 },
    lastChangedAt: null,
    evidence: { retrievedAt: fixture.generatedAt, trust: 'SOURCE_UNAVAILABLE', errorCode: 'BRON_ONBEREIKBAAR' },
  };
  const html = renderCockpit(zonder);
  assert.match(html, /id="afsprakenspoor"/);
  assert.match(html, /niet leesbaar — geen tellers te tonen/);
});

test('de stackkaart toont de vensters van de fixture met hun echte vlootstand-kleur', () => {
  const html = renderCockpit(fixture);
  assert.match(html, /id="stackkaart"/);
  assert.match(html, /niet de volledige\s*\n?\s*business-lane\/fase-indeling/);
  for (const venster of ['DASHBOARD', 'CONTROL', 'MARKT']) assert.match(html, new RegExp(`>${venster}<`));
});

test('escapet HTML uit bronnen (gate-onderwerp)', () => {
  const evil = structuredClone(fixture);
  evil.gates.rows[0].onderwerp = '<img src=x onerror=alert(1)>';
  const html = renderCockpit(evil);
  assert.equal(html.includes('<img src=x'), false);
  assert.match(html, /&lt;img src=x/);
});

test('escapet HTML uit bronnen (gate-actie)', () => {
  const evil = structuredClone(fixture);
  evil.gates.rows[0].actie = '<img src=y onerror=alert(1)>';
  const html = renderCockpit(evil);
  assert.equal(html.includes('<img src=y'), false);
  assert.match(html, /&lt;img src=y/);
});

test('een nav-snippet wordt vlak na de wrap-opening geïnjecteerd', () => {
  const html = renderCockpit(fixture, { nav: '<nav id="test-nav">naar contentstroom</nav>' });
  assert.match(html, /<div class="wrap">\n<nav id="test-nav">naar contentstroom<\/nav>\n<header>/);
});

test('zonder nav-argument staat er geen lege regel of nav-element in de pagina', () => {
  const html = renderCockpit(fixture);
  assert.equal(html.includes('<nav'), false);
});
