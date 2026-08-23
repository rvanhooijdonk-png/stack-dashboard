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
 *   SABOTAGE=bronnen node scripts/waarnemer.mjs → dwingt de bronstandtoets te falen (acceptatiebewijs)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
  toets, alarmRij, magAppenden, alarmRijPubliceerbaar, zelfRouteUitUrl, statusUitTekst,
  DREMPEL_UREN, GRACE_MINUTEN,
} from './lib/waarnemer.mjs';

const BASE_URL = process.env.BASE_URL || 'https://rvanhooijdonk-png.github.io/stack-dashboard/contentstroom.html';
const SPIEGEL_URL = process.env.SPIEGEL_URL
  || 'https://raw.githubusercontent.com/rvanhooijdonk-png/stack-dashboard/main/data/kanaalpost-publiek.md';
// Het statusbestand staat naast de pagina op dezelfde publicatie. Afgeleid uit BASE_URL, zodat
// een proef tegen een lokale kopie automatisch óók de lokale status.json leest.
const STATUS_URL = process.env.STATUS_URL || new URL('./status.json', BASE_URL).toString();
const SABOTAGE = process.env.SABOTAGE || 'geen';
const RIJ_BESTAND = process.env.RIJ_BESTAND || '';
const PAGINA_ROUTE = zelfRouteUitUrl(BASE_URL);
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

/**
 * Het contract van het statusbestand, uit de repo waarin deze waakvlam draait (`waarnemer.yml` doet
 * een checkout vóór deze stap, dus het bestand staat er). Zonder schema keurt `JSON.parse` niets en
 * zou een leeg of half bestand als geldige meting doorgaan; lukt het lezen niet, dan gaat er
 * bewust `null` door en meldt de toets dat hij de bronstand niet kon keuren.
 */
function schemaLezen() {
  try {
    return JSON.parse(readFileSync(new URL('../contracts/status-json.schema.json', import.meta.url), 'utf8'));
  } catch {
    return null;
  }
}
const STATUS_SCHEMA = schemaLezen();

const [pagina, spiegel, statusbestand] = await Promise.all([haal(BASE_URL), haal(SPIEGEL_URL), haal(STATUS_URL)]);
const gelezen = statusUitTekst(statusbestand.status, statusbestand.tekst, STATUS_SCHEMA);

// De contractversie van de PAGINA, uit haar eigen voettekst. Deze regel stond hier al vóór de
// bronstandtoets en is bij het invoeren daarvan per ongeluk vervangen door de versie uit
// `status.json` — waardoor een pagina die haar voettekst kwijt was groen bleef en het statusbestand
// bovendien zijn eigen keuring kon sturen (bevinding Codex, ronde 6). De twee versies zijn
// verschillende dingen en blijven daarom gescheiden: `contract` beschrijft de plaat, `gelezen.contract`
// het statusbestand.
// Bewust de volledige voettekstvorm, niet de eerste losse "(contract x.y.z)" in het document: de
// INHOUD van de plaat kan die haakjes ook bevatten, en een lager gelezen versienummer zou de
// zelf-bewapening van toets 3 stilletjes uitzetten.
const contract = pagina.tekst
  .match(/Gegenereerd door <code>stack-dashboard<\/code> \(contract ([0-9]+\.[0-9]+\.[0-9]+)\)/)?.[1] ?? null;
const nu = Date.now();

// De sabotage grijpt precies één toets aan en verandert verder niets: de drempel gaat naar nul, dus
// elke stempel is per definitie te oud. Zo bewijst de acceptatietest de hele keten (rode run +
// automatische spiegelregel) zonder dat er iets echts stuk hoeft.
const drempelMs = SABOTAGE === 'stempel' ? 0 : getal('DREMPEL_UREN', DREMPEL_UREN) * UUR;

/**
 * Dezelfde gedachte voor toets 5, maar aan de andere kant: hier gaat er geen drempel naar nul, hier
 * wordt het BRONSTAND-MERK in de opgehaalde kop verlaagd naar nul bewezen. De toets zelf blijft
 * ongemoeid, zodat de proef de echte keten bewijst (rode run + spiegelregel) en niet zijn eigen
 * uitzondering.
 *
 * MET POSTCONDITIES, want een sabotage die stilletjes niets doet is geen proef maar een vals bewijs
 * (bevinding Codex, 23-08-2026). De uitgangsstand moet leesbaar zijn en minstens één bewezen bron
 * hebben — anders was de pagina al stuk en bewijst het rood niets — en na de ingreep moet de stand
 * leesbaar zijn met hetzelfde totaal en nul bewezen. Klopt dat niet, dan stopt de proef hardop.
 */
function saboteerBronnen(voor) {
  if (!voor.leesbaar || voor.bewezen < 1) {
    console.log(`::error::sabotageproef kan niets bewijzen: het statusbestand gaf geen leesbare bronstand met minstens één bewezen bron (${JSON.stringify(voor)}).`);
    process.exit(2);
  }
  const na = { ...voor, bewezen: 0 };
  if (!na.leesbaar || na.bewezen !== 0 || na.totaal !== voor.totaal) {
    console.log(`::error::sabotageproef greep niet aan: stand ging van ${JSON.stringify(voor)} naar ${JSON.stringify(na)}.`);
    process.exit(2);
  }
  console.log(`sabotage: bronstand verlaagd van ${voor.bewezen} naar 0 van ${voor.totaal}`);
  return na;
}
const bronstand = SABOTAGE === 'bronnen' ? saboteerBronnen(gelezen.bronnen) : gelezen.bronnen;

const r = toets({
  paginaStatus: pagina.status,
  paginaHtml: pagina.tekst,
  paginaRoute: PAGINA_ROUTE,
  spiegelStatus: spiegel.status,
  spiegelTekst: spiegel.tekst,
  contractVersie: contract,
  bronstand,
  bronContractVersie: gelezen.contract,
  nu,
  drempelMs,
  graceMs: getal('GRACE_MINUTEN', GRACE_MINUTEN) * MIN,
});

console.log(`waarnemer — pagina http ${pagina.status}, logboek http ${spiegel.status}, statusbestand http ${statusbestand.status}, contract pagina ${contract ?? 'onbekend'}, contract statusbestand ${gelezen.contract ?? 'onbekend'}`);
console.log(`bronstand — bouw ${gelezen.bronnen.gebouwdOp ?? 'onbekend'}, ${
  gelezen.bronnen.getoetst ? 'tegen het volle contract getoetst'
    : gelezen.bronnen.leesbaar ? 'alleen op de kernvelden getoetst'
      : 'niet gekeurd'}, verschil met de pagina ${
  r.gemeten.bouwVerschilMs === null ? 'onbekend' : `${Math.round(r.gemeten.bouwVerschilMs / 1000)} s`}`);
console.log(`stempel ${r.gemeten.stempelIso ?? 'onbekend'}, leeftijd ${
  r.gemeten.leeftijdMs === null ? 'onbekend' : `${Math.round(r.gemeten.leeftijdMs / MIN)} min`}, drempel ${
  SABOTAGE === 'stempel' ? '0 (SABOTAGE)' : `${getal('DREMPEL_UREN', DREMPEL_UREN)} uur`}`);
const bs = r.gemeten.bronnen;
console.log(`bronnen: ${bs && bs.leesbaar
  ? `${bs.bewezen} van ${bs.totaal} geverifieerd${SABOTAGE === 'bronnen' ? ' (SABOTAGE)' : ''}`
  : (bs && bs.reden) || 'geen leesbare bronstand'}`);
if (r.gemeten.bronRij) console.log(`bron bovenaan: ${r.gemeten.bronRij.tab} ${r.gemeten.bronRij.datum}`);
if (r.gemeten.paginaRij) console.log(`plaat bovenaan: ${r.gemeten.paginaRij.tab} ${r.gemeten.paginaRij.datum}`);
for (const w of r.waarschuwingen) console.log(`waarschuwing: ${w}`);

// Ook op een groene ronde: hoeveel bronnen zich bewezen noemden zonder herkomst hoort in het
// receipt van de run te staan, niet alleen in een logregel (orderdiscipline R2). De openbare
// spiegel krijgt op een groene ronde per ontwerp geen regel -- daar is dit het receipt.
uitvoer('ongeteld', String(r.gemeten.bronnen?.ongeteld ?? 0));

if (r.ok) {
  console.log('✓ geen afwijking: de plaat komt overeen met de bron.');
  uitvoer('afwijking', 'nee');
  process.exit(0);
}

for (const b of r.bevindingen) console.log(`AFWIJKING ${b.code}: ${b.uitleg}`);

const rij = alarmRij({ bevindingen: r.bevindingen, nevenpunten: r.nevenpunten, nu, sabotage: SABOTAGE !== 'geen' });
// Dezelfde punten aan beide kanten: de herhaalcontrole leest de controlepunten terug UIT de
// geschreven regel, dus een punt dat wel in de regel staat en niet in deze lijst zou elke melding
// eeuwig "nieuw" maken.
const mag = magAppenden(spiegel.tekst, [...r.bevindingen, ...(r.nevenpunten ?? [])].map((b) => b.code), nu);
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
