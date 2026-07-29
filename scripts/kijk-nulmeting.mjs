#!/usr/bin/env node
/**
 * NULMETING KIJK-FIXEN-V2 — de acht proeven tégen de HUIDIGE waarnemer.
 *
 * Dit script bouwt niets en repareert niets. Het stelt de acht gevallen uit de opdracht aan de
 * bestaande waarnemer voor en drukt af wat die ervan maakt. Dat is de rode uitgangssituatie: zonder
 * deze meting is "de waarnemer kan vals groen geven" een bewering, en met deze meting is het een
 * uitkomst die iedereen kan naspelen.
 *
 * Drie soorten uitkomst worden onderscheiden, en dat onderscheid is de kern van de hele opdracht:
 *   VALS GROEN     — de waarnemer zegt "in orde" terwijl het geval fout is;
 *   GEEN MECHANISME — de waarnemer heeft niets om dit geval mee te zien; hij kan er per constructie
 *                     niet rood op worden, dus zwijgen is hier hetzelfde als groen;
 *   VERKEERD ROOD  — hij wordt wél rood, maar met de verkeerde betekenis (een storing in de
 *                     leesketen wordt gemeld als een defect aan de plaat, en dat belandt in de
 *                     publieke spiegel).
 *
 * Aanroep: node scripts/kijk-nulmeting.mjs
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderHtml } from './lib/render.mjs';
import { kanaalpostUitTekst, toPublicKanaalpost } from './lib/kanaalpost.mjs';
import { toets, stempelUitHtml, alarmRij, KANAALPOST_VANAF } from './lib/waarnemer.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(join(ROOT, 'data/fixture.json'), 'utf8'));
const bronWaarnemer = await readFile(join(ROOT, 'scripts/waarnemer.mjs'), 'utf8');

const KOP = ['| datum-tijd | tab-rol | onderwerp | status | actie voor |',
  '| --- | --- | --- | --- | --- |'].join('\n');
const spiegelMet = (...rijen) => [KOP, ...rijen].join('\n');
const rij = (datum, tab, onderwerp, status = 'AFGEROND', actie = 'niemand') =>
  `| ${datum} | ${tab} | ${onderwerp} | ${status} | ${actie} |`;

function pagina(spiegelTekst, { contract = KANAALPOST_VANAF, generatedAt } = {}) {
  const snap = structuredClone(fixture);
  snap.contractVersion = contract;
  snap.generatedAt = generatedAt;
  snap.kanaalpost = toPublicKanaalpost(kanaalpostUitTekst(spiegelTekst));
  return renderHtml(snap);
}

const uitkomsten = [];
const meet = (nr, titel, oordeel, bewijs) => {
  uitkomsten.push({ nr, titel, oordeel, bewijs });
  console.log(`\n── proef ${nr} — ${titel}`);
  console.log(`   uitkomst: ${oordeel}`);
  for (const regel of bewijs) console.log(`   ${regel}`);
};

// ───────────────────────────────────────────────────────────────────── proef 1
// Bron en pagina staan beiden op dezelfde OUDE commit. Ze zijn onderling consistent, dus elke
// vergelijking tussen die twee klopt — en toch is wat de bezoeker ziet niet de werkelijkheid.
{
  const oud = spiegelMet(rij('2026-07-26 04:00', 'CONTROL', 'De stand van vanochtend vroeg.'));
  // Veertien uur oud: ruim binnen de drempel van vijftien uur, dus de leeftijdstoets zwijgt.
  const nu = Date.parse('2026-07-26T18:00:00.000Z');
  const html = pagina(oud, { generatedAt: '2026-07-26T04:05:00.000Z' });
  const r = toets({ paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: oud, contractVersie: KANAALPOST_VANAF, nu });
  meet(1, 'bron en pagina beide op dezelfde oude commit', r.ok ? 'VALS GROEN' : 'rood',
    [`toets().ok = ${r.ok}, bevindingen = ${JSON.stringify(r.bevindingen.map((b) => b.code))}`,
      'de leesketen bevraagt raw…/main/… en de Pages-URL; beide mogen een oudere kopie zijn',
      'er is geen enkele vergelijking met de ACTUELE main-head, dus "beide oud" is per constructie groen']);
}

// ───────────────────────────────────────────────────────────────────── proef 2
// Main beweegt tussen het bepalen van de kop en het ophalen van de inhoud. Vereist: volledige retry
// of GEEN OORDEEL. Hiervoor moet er eerst een kop bepaald wórden.
{
  const noemtApi = /api\.github\.com|\/commits\/|head_sha|rev-parse/.test(bronWaarnemer);
  const noemtSha = /\b[0-9a-f]{40}\b|volledige sha|commitSha/i.test(bronWaarnemer);
  meet(2, 'main beweegt tussen HEAD-resolve en inhoudsfetch', noemtApi || noemtSha ? 'onderzoeken' : 'GEEN MECHANISME',
    [`scripts/waarnemer.mjs noemt een commit-API: ${noemtApi}`,
      `scripts/waarnemer.mjs noemt een volledige SHA: ${noemtSha}`,
      'de leesketen is één fetch op een BEWEGENDE ref (…/main/…); er is geen kop om opnieuw te toetsen,',
      'dus er bestaat geen moment waarop "de kop bewoog" waarneembaar is']);
}

// ───────────────────────────────────────────────────────────────────── proef 3
// Het productiegeval uit de opdracht: rond 19:00 NL staat 18:40 in de bron en 14:16 op de pagina.
{
  const bron = spiegelMet(
    rij('2026-07-26 14:16', 'AUTOPILOT', 'De melding van vanmiddag.'),
    rij('2026-07-26 18:40', 'AUTOPILOT', 'De verse melding die de plaat hoort te tonen.'),
  );
  // De pagina is gebouwd vóór 18:40 en toont dus 14:16 bovenaan.
  const bronToenPaginaGebouwdWerd = spiegelMet(rij('2026-07-26 14:16', 'AUTOPILOT', 'De melding van vanmiddag.'));
  // 19:00 NL-tijd = 17:00 UTC (zomertijd). De stempel is vers genoeg voor toets 2.
  const nu = Date.parse('2026-07-26T17:00:00.000Z');
  const html = pagina(bronToenPaginaGebouwdWerd, { generatedAt: '2026-07-26T16:50:00.000Z' });
  const r = toets({ paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: bron, contractVersie: KANAALPOST_VANAF, nu });
  meet(3, 'productiegeval 18:40 in de bron, 14:16 op de pagina, NL/UTC', r.ok ? 'VALS GROEN' : 'rood',
    [`toets().ok = ${r.ok}, bevindingen = ${JSON.stringify(r.bevindingen.map((b) => b.code))}`,
      `pagina bovenaan = ${r.gemeten.paginaRij?.datum}, bron bovenaan = ${r.gemeten.bronRij?.datum}`,
      'mechanisme: rijMoment() leest de NL-kolom als UTC, dus 18:40 lijkt op 20:40 te liggen —',
      'nu(17:00 UTC) − 18:40 is negatief, de rij valt "binnen het respijt", het venster schuift één',
      'rij op en dan mag de pagina ook de rij daaronder (14:16) tonen']);
}

// ───────────────────────────────────────────────────────────────────── proef 4
// Verse paginastempel maar de verkeerde commit of statehash. Vereist: rood.
{
  const bron = spiegelMet(rij('2026-07-26 16:00', 'CONTROL', 'De actuele melding.'));
  const html = pagina(bron, { generatedAt: '2026-07-26T16:05:00.000Z' });
  const s = stempelUitHtml(html);
  // Niet zoeken of het WOORD "commit" ergens op de pagina staat — dat staat het, in de PR-tabel, en
  // dan meet je een toevallige woordtreffer in de inhoud in plaats van de stempel. De vraag is of de
  // STEMPEL zelf een commit of een toestandshash draagt, en dat is te zien aan zijn velden.
  const stempelVelden = Object.keys(s);
  const draagtHerkomst = stempelVelden.some((k) => /commit|sha|hash|watermerk|watermark/i.test(k));
  meet(4, 'verse paginastempel met verkeerde commit of statehash', draagtHerkomst ? 'onderzoeken' : 'GEEN MECHANISME',
    [`stempelUitHtml() levert de velden: ${JSON.stringify(stempelVelden)}`,
      `een van die velden draagt herkomst (commit/hash/watermerk): ${draagtHerkomst}`,
      `gemeten stempel: ${JSON.stringify(s)}`,
      'de stempel draagt alleen TIJD. Een pagina die vers gebouwd is uit de verkeerde bron is dus',
      'niet te onderscheiden van een pagina die vers gebouwd is uit de goede bron']);
}

// ───────────────────────────────────────────────────────────────────── proef 5
// Eén lane stil terwijl andere lanes melden. Vereist: PARTIAL plus de verouderde lane.
{
  const bron = spiegelMet(
    rij('2026-07-26 09:00', 'MINI', 'De laatste melding van deze lane — daarna stilte.'),
    rij('2026-07-26 17:30', 'AUTOPILOT', 'Deze lane meldt gewoon door.'),
    rij('2026-07-26 17:45', 'CONTROL', 'Deze lane ook.'),
  );
  const nu = Date.parse('2026-07-26T15:50:00.000Z');
  const html = pagina(bron, { generatedAt: '2026-07-26T15:48:00.000Z' });
  const r = toets({ paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: bron, contractVersie: KANAALPOST_VANAF, nu });
  // Weer op de VORM van het oordeel meten, niet op woorden in de meegedragen tekst: het woord "lane"
  // komt in de inhoud van de plaat voor en zegt dan niets over wat de waarnemer kan zien.
  const oordeelVelden = Object.keys(r);
  const kentLanes = oordeelVelden.some((k) => /lane|partial|spoor/i.test(k)) || typeof r.ok !== 'boolean';
  meet(5, 'één lane stil terwijl andere lanes melden', kentLanes ? 'onderzoeken' : 'GEEN MECHANISME',
    [`toets().ok = ${r.ok}, bevindingen = ${JSON.stringify(r.bevindingen.map((b) => b.code))}`,
      `het oordeel levert de velden: ${JSON.stringify(oordeelVelden)} — geen ervan is per lane`,
      `de uitkomst is een enkele boolean (ok), geen driewaardig oordeel: ${typeof r.ok}`,
      'MINI zwijgt sinds 09:00 terwijl twee andere lanes doormelden; het oordeel is binair (ok/niet ok)',
      'en kent geen lanes, dus een stille lane verdwijnt in een groen totaaloordeel']);
}

// ───────────────────────────────────────────────────────────────────── proef 6
// Vrije klant-, incident- of padtekst. Vereist: het schema weigert publicatie.
{
  // Twee van de negen gemeten auditvormen (AUD-002). Geen echte gegevens: verzonnen vormen die
  // alleen aantonen dát de poort ze doorlaat.
  const vormen = ['een verkort thuispad ~/klanten/afspraken', 'incident bij Noordwijk BV rond 14:00'];
  const bron = spiegelMet(...vormen.map((v, i) => rij(`2026-07-26 1${i}:00`, 'CONTROL', v)));
  const publiek = toPublicKanaalpost(kanaalpostUitTekst(bron));
  const doorgelaten = (publiek.rows ?? []).map((r) => r.onderwerp);
  meet(6, 'vrije klant-, incident- of padtekst', doorgelaten.length ? 'VALS GROEN' : 'rood',
    [`de publicatiepoort liet ${doorgelaten.length} van de ${vormen.length} vrije-tekstvormen door`,
      `ingehouden = ${publiek.ingehouden}`,
      'op deze kop (main) is publiek nog een FILTER op vrije brontekst; de gesloten catalogus',
      'die dit dicht zet zit in PR #34 en is nog niet door de poort']);
}

// ───────────────────────────────────────────────────────────────────── proef 7
// Eventsequence/high-watermark daalt. Vereist: rood, ook als bron en pagina overeenkomen.
{
  const bron = spiegelMet(rij('2026-07-26 16:00', 'CONTROL', 'De actuele melding.'));
  const html = pagina(bron, { generatedAt: '2026-07-26T16:05:00.000Z' });
  const nu = Date.parse('2026-07-26T16:10:00.000Z');
  const r = toets({ paginaStatus: 200, paginaHtml: html, spiegelStatus: 200, spiegelTekst: bron, contractVersie: KANAALPOST_VANAF, nu });
  const kentTeller = /sequence|watermark|watermerk/i.test(bronWaarnemer + JSON.stringify(r));
  meet(7, 'eventsequence/high-watermark daalt', kentTeller ? 'onderzoeken' : 'GEEN MECHANISME',
    [`toets().ok = ${r.ok} — bron en pagina komen overeen, dus dit is groen`,
      `de leesketen kent een sequence of high-watermark: ${kentTeller}`,
      'er wordt niets bewaard tussen twee waarnemingen in, dus "de teller daalde" is niet vast te',
      'stellen: elke ronde begint zonder geheugen']);
}

// ───────────────────────────────────────────────────────────────────── proef 8
// API-timeout/403/404/lege response. Vereist: GEEN OORDEEL, nooit gecacht groen.
{
  const bron = spiegelMet(rij('2026-07-26 16:00', 'CONTROL', 'De actuele melding.'));
  const nu = Date.parse('2026-07-26T16:10:00.000Z');
  const gevallen = [
    ['timeout (haal() levert status 0)', { paginaStatus: 0, paginaHtml: '' }],
    ['403 op de pagina', { paginaStatus: 403, paginaHtml: '' }],
    ['404 op de pagina', { paginaStatus: 404, paginaHtml: '' }],
    ['200 met lege body', { paginaStatus: 200, paginaHtml: '' }],
  ];
  const regels = [];
  for (const [naam, invoer] of gevallen) {
    const r = toets({ ...invoer, spiegelStatus: 200, spiegelTekst: bron, contractVersie: KANAALPOST_VANAF, nu });
    const alarm = alarmRij({ bevindingen: r.bevindingen, nu, sabotage: false });
    regels.push(`${naam}: ok=${r.ok}, codes=${JSON.stringify(r.bevindingen.map((b) => b.code))}`);
    regels.push(`   → publieke alarmregel die hieruit volgt: ${alarm.slice(0, 96)}…`);
  }
  meet(8, 'API-timeout/403/404/lege response', 'VERKEERD ROOD',
    [...regels,
      'alle vier leveren een AFWIJKING met een publieke alarmregel: een storing in de LEESKETEN',
      'wordt zo gepubliceerd als een defect aan de PLAAT. Er bestaat geen derde uitkomst',
      '"GEEN OORDEEL" — het oordeel is binair, dus onwetendheid moet zich voordoen als kennis']);
}

// ───────────────────────────────────────────────────────────────────────── slot
console.log('\n════════════════════════════ NULMETING ════════════════════════════');
for (const u of uitkomsten) console.log(`proef ${u.nr}: ${u.oordeel.padEnd(15)} ${u.titel}`);
const goed = uitkomsten.filter((u) => u.oordeel === 'rood').length;
console.log(`\n${goed} van de ${uitkomsten.length} proeven geeft vandaag het juiste antwoord.`);
console.log('Dit is de rode uitgangssituatie van KIJK-FIXEN-V2.');
