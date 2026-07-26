#!/usr/bin/env node
/**
 * WAARNEMER (uitvoerder) — haalt de LIVE pagina en het LIVE logboek op zoals een bezoeker dat doet,
 * laat `scripts/lib/waarnemer.mjs` erover oordelen, en levert bij een afwijking de kant-en-klare
 * alarmregel voor de publieke spiegel.
 *
 * Deze laag doet bewust géén oordeel en geen schrijfactie: ophalen, doorgeven, rapporteren. Het
 * schrijven naar de spiegel gebeurt in de workflow, in een aparte job met schrijfrechten — zodat de
 * toetsende stap zelf nooit meer rechten heeft dan lezen.
 *
 * Verse fetch met cache-busting, met een eerlijke kanttekening die in `publish.yml` is gemeten:
 * GitHub Pages/Fastly gebruikt de query-string niet als cachesleutel. De buster en de no-store-kop
 * doen wat ze kunnen (browsercache, tussenliggende proxies), maar de CDN mag alsnog een kopie van
 * maximaal ongeveer tien minuten oud teruggeven. Daarom liggen drempel en respijt daar ruim boven.
 *
 * Aanroep:
 *   node scripts/waarnemer.mjs            → toetst en rapporteert; exit 1 bij afwijking
 *   SABOTAGE=stempel node scripts/waarnemer.mjs → dwingt de stempeltoets te falen (acceptatiebewijs)
 */

import { writeFileSync } from 'node:fs';
import {
  toets, alarmRij, magAppenden, alarmRijPubliceerbaar, DREMPEL_UREN, GRACE_MINUTEN,
} from './lib/waarnemer.mjs';

const BASE_URL = process.env.BASE_URL || 'https://rvanhooijdonk-png.github.io/stack-dashboard/';
const SPIEGEL_URL = process.env.SPIEGEL_URL
  || 'https://raw.githubusercontent.com/rvanhooijdonk-png/stack-dashboard/main/data/kanaalpost-publiek.md';
const SABOTAGE = process.env.SABOTAGE || 'geen';
const RIJ_BESTAND = process.env.RIJ_BESTAND || '';
const UUR = 3600 * 1000;
const MIN = 60 * 1000;

const getal = (naam, standaard) => {
  const v = Number.parseFloat(process.env[naam] ?? '');
  return Number.isFinite(v) && v > 0 ? v : standaard;
};

/** Eén ophaal, met tijdsbudget. Een fout is geen uitzondering maar een uitkomst: status 0. */
async function haal(url) {
  const gescheiden = url.includes('?') ? '&' : '?';
  const doel = `${url}${gescheiden}cb=${Date.now()}`;
  try {
    const r = await fetch(doel, {
      cache: 'no-store',
      headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
      signal: AbortSignal.timeout(20000),
    });
    const tekst = await r.text();
    return { status: r.status, tekst };
  } catch {
    // Geen fouttekst doorgeven: die kan de volledige URL bevatten en die hoort niet in een melding
    // die mogelijk in de publieke spiegel belandt.
    return { status: 0, tekst: '' };
  }
}

const uitvoer = (sleutel, waarde) => {
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `${sleutel}=${waarde}\n`, { flag: 'a' });
};

const [pagina, spiegel] = await Promise.all([haal(BASE_URL), haal(SPIEGEL_URL)]);
const contract = pagina.tekst.match(/\(contract ([0-9]+\.[0-9]+\.[0-9]+)\)/)?.[1] ?? null;
const nu = Date.now();

// De sabotage grijpt precies één toets aan en verandert verder niets: de drempel gaat naar nul, dus
// elke stempel is per definitie te oud. Zo bewijst de acceptatietest de hele keten (rode run +
// automatische spiegelregel) zonder dat er iets echts stuk hoeft.
const drempelMs = SABOTAGE === 'stempel' ? 0 : getal('DREMPEL_UREN', DREMPEL_UREN) * UUR;

const r = toets({
  paginaStatus: pagina.status,
  paginaHtml: pagina.tekst,
  spiegelStatus: spiegel.status,
  spiegelTekst: spiegel.tekst,
  contractVersie: contract,
  nu,
  drempelMs,
  graceMs: getal('GRACE_MINUTEN', GRACE_MINUTEN) * MIN,
});

console.log(`waarnemer — pagina http ${pagina.status}, logboek http ${spiegel.status}, contract ${contract ?? 'onbekend'}`);
console.log(`stempel ${r.gemeten.stempelIso ?? 'onbekend'}, leeftijd ${
  r.gemeten.leeftijdMs === null ? 'onbekend' : `${Math.round(r.gemeten.leeftijdMs / MIN)} min`}, drempel ${
  SABOTAGE === 'stempel' ? '0 (SABOTAGE)' : `${getal('DREMPEL_UREN', DREMPEL_UREN)} uur`}`);
if (r.gemeten.bronRij) console.log(`bron bovenaan: ${r.gemeten.bronRij.tab} ${r.gemeten.bronRij.datum}`);
if (r.gemeten.paginaRij) console.log(`plaat bovenaan: ${r.gemeten.paginaRij.tab} ${r.gemeten.paginaRij.datum}`);
for (const w of r.waarschuwingen) console.log(`waarschuwing: ${w}`);

if (r.ok) {
  console.log('✓ geen afwijking: de plaat komt overeen met de bron.');
  uitvoer('afwijking', 'nee');
  process.exit(0);
}

for (const b of r.bevindingen) console.log(`AFWIJKING ${b.code}: ${b.uitleg}`);

const rij = alarmRij({ bevindingen: r.bevindingen, nu, sabotage: SABOTAGE !== 'geen' });
const mag = magAppenden(spiegel.tekst, r.bevindingen.map((b) => b.code), nu);
const gate = alarmRijPubliceerbaar(rij);

if (!gate) {
  console.log('::error::de alarmregel komt niet door de publicatiepoort — er wordt niets aan de spiegel toegevoegd.');
} else if (!mag.mag) {
  console.log(`spiegel niet aangevuld: ${mag.reden}`);
} else {
  console.log(`spiegel wordt aangevuld: ${mag.reden}`);
  if (RIJ_BESTAND) writeFileSync(RIJ_BESTAND, `${rij}\n`, 'utf8');
  uitvoer('rij_b64', Buffer.from(`${rij}\n`, 'utf8').toString('base64'));
}
uitvoer('afwijking', 'ja');
uitvoer('appenden', gate && mag.mag ? 'ja' : 'nee');
console.log(`::error::de openbare plaat wijkt af op ${r.bevindingen.length} punt(en) — zie de meldingen hierboven.`);
process.exit(1);
