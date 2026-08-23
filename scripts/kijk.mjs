#!/usr/bin/env node
/**
 * KIJK (uitvoerder) — haalt op, laat `scripts/lib/kijk.mjs` oordelen, schrijft niets naar buiten.
 *
 * De scheiding is dezelfde als bij de waarnemer en om dezelfde reden: deze laag mag alleen lezen. Wat
 * hier anders is dan bij `scripts/waarnemer.mjs` is de LEESVOLGORDE. Daar werd `…/main/…` opgehaald —
 * een bewegende ref, waarvan het antwoord niet zegt uit welke wereld het komt. Hier wordt eerst de kop
 * van main opgelost via de API, daarna de inhoud op exact die volledige SHA gehaald, en daarna de kop
 * opnieuw gelezen. Bewoog hij, dan telt de hele lezing niet.
 *
 * Aanroep:
 *   node scripts/kijk.mjs                       → lees en oordeel over de echte repo
 *   node scripts/kijk.mjs --stale-replay        → speel na dat bron én pagina samen oud zijn
 *   node scripts/kijk.mjs --schrijf <map>       → schrijf kijk-state.json en kijk-manifest.json weg
 *
 * Een token wordt gebruikt als GITHUB_TOKEN in de omgeving staat (alleen om de limiet te verruimen;
 * de repo is publiek). De waarde wordt nergens afgedrukt en belandt nergens in de uitvoer.
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  leesBronvast, kijkStateUitSpiegel, manifestVoor, oordeel, publiekeRegel, kanoniekeBytes,
} from './lib/kijk.mjs';
import { detectIdentity, repositorySlug } from './lib/repo-identity.mjs';

// De gelezen repository is per definitie deze repository; het adres volgt de eigenaar mee.
const REPO = process.env.KIJK_REPO || repositorySlug(detectIdentity());
const TAK = process.env.KIJK_TAK || 'main';
const PAD = process.env.KIJK_PAD || 'data/kanaalpost-publiek.md';
const args = process.argv.slice(2);
const staleReplay = args.includes('--stale-replay');
const schrijfMap = args.includes('--schrijf') ? args[args.indexOf('--schrijf') + 1] : null;

const koppen = {
  accept: 'application/vnd.github+json',
  'user-agent': 'stack-dashboard-kijk',
  ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

/** Eén ophaal met tijdsbudget. Een fout is een UITKOMST, geen uitzondering — en draagt geen URL mee. */
async function haal(url, extra = {}) {
  try {
    const r = await fetch(url, { headers: { ...koppen, ...extra }, signal: AbortSignal.timeout(20000) });
    return { status: r.status, tekst: await r.text() };
  } catch {
    return { status: 0, tekst: '' };
  }
}

/** De actuele kop van de tak, als volledige SHA. Niet de tag, niet een prefix. */
async function kopVan() {
  const r = await haal(`https://api.github.com/repos/${REPO}/commits/${TAK}`);
  if (r.status !== 200) return { ok: false, reden: `HTTP_${r.status}` };
  try {
    const sha = JSON.parse(r.tekst)?.sha;
    return sha ? { ok: true, sha } : { ok: false, reden: 'GEEN_SHA' };
  } catch {
    return { ok: false, reden: 'ONLEESBAAR' };
  }
}

/**
 * De git-blob-aanduiding van deze bytes, ZELF gerekend. Git hasht niet de kale inhoud maar
 * `blob <lengte>\0` gevolgd door de bytes; dat is de hele reden dat dit hier staat en niet elders
 * wordt overgenomen. Een zelf gerekende hash is het enige getal in deze keten dat niemand onderweg
 * kan aanleveren.
 */
function blobShaVan(tekst) {
  const inhoud = Buffer.from(tekst, 'utf8');
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${inhoud.length}\0`), inhoud])).digest('hex');
}

/**
 * Wat de boom van DEZE commit zegt dat het bestand is. Losstaand van wat `raw` teruggeeft, en dat is
 * het punt: de ene kant zegt wat er in de commit hoort te staan, de andere levert bytes. Vallen die
 * uiteen — een cache, een proxy, een spiegel die iets anders doorgeeft — dan is dat zichtbaar in
 * plaats van onzichtbaar. Lukt het niet, dan is er niets vergeleken en blijft het veld leeg.
 */
async function declaredBlobVan(sha) {
  const r = await haal(`https://api.github.com/repos/${REPO}/contents/${PAD}?ref=${sha}`);
  if (r.status !== 200) return null;
  try {
    const s = JSON.parse(r.tekst)?.sha;
    return typeof s === 'string' && /^[0-9a-f]{40}$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

/** De inhoud op exact deze commit. `raw` met een volledige SHA is inhoudsadressering, geen ref. */
async function inhoudVan(sha) {
  const r = await haal(`https://raw.githubusercontent.com/${REPO}/${sha}/${PAD}`);
  if (r.status !== 200) return { ok: false, reden: `HTTP_${r.status}` };
  if (!r.tekst.trim()) return { ok: false, reden: 'LEEG' };
  return { ok: true, tekst: r.tekst, blobSha: blobShaVan(r.tekst) };
}

const lezing = await leesBronvast({ kopVan, inhoudVan });
if (!lezing.ok) {
  const o = oordeel({ lezing });
  console.log(`kijk — ${o.uitkomst}: ${publiekeRegel({ uitkomst: o.uitkomst, redenen: o.redenen }).uitleg}`);
  console.log(`pogingen: ${lezing.pogingen}`);
  // GEEN OORDEEL is geen fout van de plaat en dus geen exit 1: het is de eerlijke uitkomst
  // "ik weet het niet". Exit 2 houdt dat onderscheid ook voor een aanroeper zichtbaar.
  process.exit(2);
}

const { state, fouten } = kijkStateUitSpiegel(lezing.tekst, { commitSha: lezing.sha });
const { manifest, bytes } = manifestVoor(state, {
  bronCommitSha: lezing.sha,
  bronBlobSha: await declaredBlobVan(lezing.sha),
  generatedAt: new Date().toISOString(),
});

console.log(`kijk — repo ${REPO}, tak ${TAK}`);
console.log(`kop: ${lezing.sha} (pogingen: ${lezing.pogingen})`);
console.log(`bronsoort: ${state.bronSoort}`);
console.log(`teller: ${state.eventHighWatermark} (${state.eventCount} regels), sporen: ${Object.keys(state.lanes).join(', ') || 'geen'}`);
console.log(`toestandshash: ${manifest.stateSha256}`);
if (fouten.length) {
  const geteld = fouten.reduce((acc, f) => ({ ...acc, [f]: (acc[f] ?? 0) + 1 }), {});
  const som = Object.entries(geteld).map(([f, n]) => `${f}×${n}`).join(', ');
  console.log(`bronrijen die het gesloten schema niet haalden: ${fouten.length} van ${state.eventCount} (${som})`);
}

if (schrijfMap) {
  writeFileSync(join(schrijfMap, 'kijk-state.json'), bytes);
  writeFileSync(join(schrijfMap, 'kijk-manifest.json'), kanoniekeBytes(manifest));
  console.log(`geschreven: kijk-state.json en kijk-manifest.json in ${schrijfMap}`);
}

// De pagina draagt haar herkomst nog niet — dat is de bouwkant, en die zit achter de plaat-poort. Tot
// dan wordt de herkomst hier expliciet als ONTBREKEND aangeboden, zodat de uitkomst eerlijk rood is
// in plaats van dat de toets stilzwijgend wordt overgeslagen.
let paginaHerkomst = { commitSha: null, stateSha256: null, eventHighWatermark: null };

if (staleReplay) {
  // STALE-REPLAY, zoals de opdracht hem vraagt: bron én pagina SAMEN oud. De pagina wordt hier niet
  // half nagebootst maar echt gebouwd — de spiegel wordt opgehaald op een oudere commit, daar wordt
  // een volledige state en een volledig manifest uit gemaakt, en dát is de herkomst die de pagina
  // draagt. Pagina en de bron waaruit zij komt zijn dus onderling volmaakt consistent: zelfde commit,
  // zelfde toestandshash, zelfde teller. Een toets die pagina met "de bron" vergelijkt zonder te
  // vragen WELKE bron, noemt dit groen — dat is precies de oude fout. Alleen de vergelijking met de
  // actuele kop kan het zien.
  const oudeKop = process.env.KIJK_OUDE_KOP;
  const oudeInhoud = oudeKop ? await inhoudVan(oudeKop) : null;
  if (!oudeInhoud?.ok) {
    console.log('\nstale-replay: de oude kop is niet op te halen — geen replay, en dus ook geen uitspraak.');
    process.exit(2);
  }
  const oud = kijkStateUitSpiegel(oudeInhoud.tekst, { commitSha: oudeKop });
  const oudManifest = manifestVoor(oud.state, { bronCommitSha: oudeKop, generatedAt: new Date().toISOString() });
  paginaHerkomst = {
    commitSha: oudeKop,
    stateSha256: oudManifest.manifest.stateSha256,
    eventHighWatermark: oud.state.eventHighWatermark,
  };
  console.log('\nstale-replay — de pagina is gebouwd uit een oudere bron en is daarmee volledig consistent:');
  console.log(`  oude kop:  ${oudeKop} · teller ${oud.state.eventHighWatermark} · hash ${oudManifest.manifest.stateSha256.slice(0, 16)}…`);
  console.log(`  actuele kop: ${lezing.sha} · teller ${state.eventHighWatermark} · hash ${manifest.stateSha256.slice(0, 16)}…`);
}

// `nu` is de klok van de uitvoerder, en die hoort hier thuis en niet in de bibliotheek: alleen wie de
// kijk daadwerkelijk draait weet wanneer dat is. Zonder deze regel blijft de totale-uitvalvloer dood
// (reviewgat 5) — de sporen staan dan onderling perfect gelijk terwijl er al een dag niets gebeurt.
const o = oordeel({ lezing, paginaHerkomst, state, manifest, stateBytes: bytes, nu: Date.now() });
const regel = publiekeRegel({ uitkomst: o.uitkomst, redenen: o.redenen, lanes: o.gemeten.verouderdeLanes });
console.log(`\nuitkomst: ${o.uitkomst}`);
console.log(`publieke regel: ${regel.uitleg}`);
if (staleReplay) console.log(`redenen: ${o.redenen.join(', ')}`);
process.exit(o.uitkomst === 'GROEN' ? 0 : 1);
