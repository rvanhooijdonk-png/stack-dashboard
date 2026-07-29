#!/usr/bin/env node
/**
 * DOORSTROOM (uitvoerder) — haalt aangeleverde spiegelrijen op, laat `scripts/lib/doorstroom.mjs`
 * oordelen, en schrijft alleen de publieke spiegel bij. Verder niets.
 *
 * TWEE BRONNEN, allebei op `rvanhooijdonk-png/stack-control`, tak `rapporten`:
 *
 *   1. de map `CONTROL/SPIEGEL/INBOX/` — één rij per bestand, naam `YYYY-MM-DDTHH-MM-<venster>-<slug>.md`.
 *      Die vorm doet twee dingen: twee vensters kunnen nooit hetzelfde bestand raken (dus geen
 *      botsing), en het tijdstip van AANLEVERING staat in de naam — zonder extra API-verkeer, en
 *      zichtbaar voor een mens die de map opent. GEMETEN 27-07-2026: die map BESTAAT NIET. Niemand
 *      schrijft er ooit in; de doorstroom las dat als "0 rij(en) aangeleverd";
 *   2. het bestand `CONTROL/KANAALPOST.md` — het doorgeefluik waar de vensters wél in schrijven, dat
 *      op 27-07 naar 277 rijen groeide terwijl de publieke spiegel stilstond. Dit is de bron die de
 *      doorstroom hoort te lezen, en `scripts/lib/kanaalpostbron.mjs` leest hem PER RIJ.
 *
 * PER RIJ, en dat is de reparatie van vandaag. De kanaalpost werd eerder als DOCUMENT beoordeeld en
 * viel dan op regel 1 om (`HTML_COMMENTAAR`: de kop van het bestand is een commentaarblok). Een
 * document weigeren is fail-closed en levert nul op zonder dat iemand ziet wélke rij het probleem
 * was. Nu kost één misvormde rij één rij, en elke weigering draagt een reden uit een gesloten lijst
 * die geteld wordt afgedrukt.
 *
 * DE LEESVOLGORDE is dezelfde als bij de kijk en om dezelfde reden: eerst de kop van de tak oplossen,
 * daarna de inhoud op exact die SHA. Een bewegende ref zegt niet uit welke wereld het antwoord komt.
 *
 * WAT DIT NIET DOET. Niets mergen, niets naar buiten publiceren, geen enkele bestaande regel
 * aanraken. De publieke spiegel is append-only; deze uitvoerder voegt uitsluitend achteraan toe en
 * controleert dat zelf nog eens met de spiegelwet vóór hij schrijft.
 *
 * Aanroep:
 *   node scripts/doorstroom.mjs                → kijken en oordelen, niets wegschrijven
 *   node scripts/doorstroom.mjs --schrijf      → de spiegel daadwerkelijk bijwerken
 *   node scripts/doorstroom.mjs --uitvoer <p>  → schrijf het oordeel als JSON weg (voor de alarmstap)
 *
 * Een token wordt gebruikt als `CONTROL_READ_TOKEN` in de omgeving staat; de bronrepo is privé, dus
 * zonder token is er geen bron en dat is een ROOD oordeel, geen stille nul. De waarde wordt nergens
 * afgedrukt.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACHTERSTAND_MINUTEN, achterstandsOordeel, bronRijenOordeel, bronRijUitTekst, eindoordeel,
  overzetting, stempelOordeel, vlootstand,
} from './lib/doorstroom.mjs';
import { bronRijenUitKanaalpost, weigeringsregel } from './lib/kanaalpostbron.mjs';
import { LANES } from './lib/kijk.mjs';
import { loadDenyTerms } from './lib/sanitize.mjs';
import { alleenAangevuld } from './lib/spiegelwet.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const BRON_REPO = process.env.DOORSTROOM_BRON_REPO || 'rvanhooijdonk-png/stack-control';
const BRON_TAK = process.env.DOORSTROOM_BRON_TAK || 'rapporten';
const BRON_MAP = process.env.DOORSTROOM_BRON_MAP || 'CONTROL/SPIEGEL/INBOX';
const BRON_KANAALPOST = process.env.DOORSTROOM_BRON_KANAALPOST || 'CONTROL/KANAALPOST.md';
const SPIEGEL = process.env.DOORSTROOM_SPIEGEL || 'data/kanaalpost-publiek.md';
/** Alleen ROLLEN per venster; wie tot de vloot behoort staat in `LANES` en nergens anders. */
const VLOOT = process.env.DOORSTROOM_VLOOT || 'data/vloot.json';

const args = process.argv.slice(2);
const schrijven = args.includes('--schrijf');
const uitvoerPad = args.includes('--uitvoer') ? args[args.indexOf('--uitvoer') + 1] : null;

const koppen = {
  accept: 'application/vnd.github+json',
  'user-agent': 'stack-dashboard-doorstroom',
  ...(process.env.CONTROL_READ_TOKEN ? { authorization: `Bearer ${process.env.CONTROL_READ_TOKEN}` } : {}),
};

// GEMETEN 29-07-2026: `CONTROL/KANAALPOST.md` staat op 1.662.777 bytes — over de 1 MB-grens van het
// GEWONE contents-antwoord. Boven die grens levert GitHub `encoding: "none"`, `content: ""` terug,
// geen fout, geen 404 — gewoon een lege bron met status 200. Daar viel `leesKanaalpost` stil op
// `BRON_GEEN_KOP`: geen kop gezien, want geen tekst gezien. Het `raw`-mediatype omzeilt de
// JSON+base64-verpakking (en daarmee die 1 MB-grens) tot 100 MB en levert de bytes rechtstreeks.
const koppenRuw = { ...koppen, accept: 'application/vnd.github.raw+json' };

/** Eén ophaal met tijdsbudget. Een fout is een UITKOMST, geen uitzondering — en draagt geen URL mee. */
async function haal(url, headers = koppen) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    return { status: r.status, tekst: await r.text() };
  } catch {
    return { status: 0, tekst: '' };
  }
}

/** Zelfde ophaal, maar de RUWE bestandsinhoud — geen JSON-omslag, dus geen 1 MB-plafond. */
const haalRuw = (url) => haal(url, koppenRuw);

/** `YYYY-MM-DDTHH-MM-...` uit de bestandsnaam. Geen tijdstempel = geen bewijs van aanlevering. */
function geleverdUitNaam(naam) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-/.exec(naam);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function leesInbox() {
  const kop = await haal(`https://api.github.com/repos/${BRON_REPO}/commits/${BRON_TAK}`);
  if (kop.status !== 200) return { ok: false, reden: `BRON_HTTP_${kop.status}`, rijen: [], stuk: [] };
  let sha = null;
  try { sha = JSON.parse(kop.tekst)?.sha ?? null; } catch { sha = null; }
  if (!sha) return { ok: false, reden: 'BRON_GEEN_SHA', rijen: [], stuk: [] };

  const lijst = await haal(`https://api.github.com/repos/${BRON_REPO}/contents/${BRON_MAP}?ref=${sha}`);
  // Een map die NIET BESTAAT is iets anders dan een map die leeg is, en het verschil is precies de
  // klasse die dit hele bouwsel bestrijdt. GEMETEN 27-07-2026: `CONTROL/SPIEGEL/INBOX` op de
  // rapporten-tak geeft HTTP 404 — en de doorstroom meldde daarop "gelezen, 0 rij(en) aangeleverd"
  // met een GROENE achterstand, want zonder bron kan niets achterlopen. Dat is afwezigheid gelezen
  // als gezondheid, in mijn eigen alarm. De map wordt daarom apart gemeld en het eindoordeel kan er
  // niet groen op staan.
  if (lijst.status === 404) return { ok: true, sha, rijen: [], stuk: [], map: 'ONTBREEKT' };
  if (lijst.status !== 200) return { ok: false, reden: `INBOX_HTTP_${lijst.status}`, rijen: [], stuk: [] };

  let items = [];
  try { items = JSON.parse(lijst.tekst); } catch { return { ok: false, reden: 'INBOX_ONLEESBAAR', rijen: [], stuk: [] }; }
  if (!Array.isArray(items)) return { ok: false, reden: 'INBOX_GEEN_MAP', rijen: [], stuk: [] };

  const rijen = [];
  const stuk = [];
  for (const item of items.filter((i) => i?.type === 'file' && /\.md$/.test(i?.name ?? '')).sort((a, b) => a.name.localeCompare(b.name))) {
    const geleverdOp = geleverdUitNaam(item.name);
    if (!geleverdOp) { stuk.push({ id: item.name, reden: 'GEEN_TIJDSTEMPEL_IN_NAAM' }); continue; }
    const inhoud = await haalRuw(`https://api.github.com/repos/${BRON_REPO}/contents/${encodeURI(item.path)}?ref=${sha}`);
    if (inhoud.status !== 200) { stuk.push({ id: item.name, reden: `RIJ_HTTP_${inhoud.status}` }); continue; }
    const gelezen = bronRijUitTekst(item.name, inhoud.tekst);
    if (!gelezen.ok) { stuk.push({ id: item.name, reden: gelezen.reden }); continue; }
    rijen.push({ ...gelezen, geleverdOp });
  }
  return { ok: true, sha, rijen, stuk, map: 'AANWEZIG' };
}

/**
 * De kanaalpost op exact dezelfde SHA als de inbox — één wereld, twee bronnen. Een tweede oplossing
 * van de tak zou twee verschillende momenten kunnen lezen en dan is "wat stond er" niet één antwoord.
 *
 * Een leesfout is hier GEEN nul. Nul rijen uit een append-only logboek dat de hele dag groeit ziet er
 * precies zo uit als een gezonde stille dag, en dat verschil is het onderwerp van dit hele bouwsel.
 */
async function leesKanaalpost(sha) {
  const r = await haalRuw(`https://api.github.com/repos/${BRON_REPO}/contents/${encodeURI(BRON_KANAALPOST)}?ref=${sha}`);
  if (r.status !== 200) return { ok: false, reden: `KANAALPOST_HTTP_${r.status}`, rijen: [], geweigerd: [], telling: {}, gezien: 0 };
  // `id` wordt een regelnummer met een voorvoegsel: de bron is privé en deze log is openbaar, dus er
  // mag geen brontekst in — maar het moet wel te onderscheiden zijn van een inbox-bestandsnaam.
  const gelezen = bronRijenUitKanaalpost(r.tekst);
  return {
    ...gelezen,
    rijen: gelezen.rijen.map((rij) => ({ ...rij, id: `KANAALPOST:${rij.id}` })),
    geweigerd: gelezen.geweigerd.map((g) => ({ ...g, id: `KANAALPOST:${g.id}` })),
  };
}

const leesTekst = (pad) => { try { return readFileSync(pad, 'utf8'); } catch { return null; } };
const leesJson = (pad) => { try { return JSON.parse(readFileSync(pad, 'utf8')); } catch { return null; } };

// DE DENY-LIJST MOET GELADEN ZIJN VÓÓR ER ÉÉN RIJ BEOORDEELD WORDT (review Codex, 27-07-2026).
// `publishVeilig` slaat de termencheck stilzwijgend over zolang `loadDenyTerms` niet is aangeroepen,
// en dat gebeurde alleen in `build.mjs`. Deze uitvoerder draait als eigen proces en schrijft
// rechtstreeks naar een bestand in een OPENBARE repo: een naam die alléén door `data/deny-terms.json`
// wordt tegengehouden, stond zo in de publieke git-historie vóór de plaat er ooit aan te pas kwam.
// Blokkeren tijdens de latere sitebouw is dan te laat — gepubliceerde historie draai je niet terug.
// `strict` is met opzet: een ontbrekende of kapotte lijst stopt de doorstroom luidruchtig.
const termen = loadDenyTerms(join(ROOT, 'data/deny-terms.json'), { strict: true });
console.log(`deny-lijst: ${termen} term(en) geladen`);

const nu = new Date();
const inbox = await leesInbox();
const post = inbox.ok
  ? await leesKanaalpost(inbox.sha)
  : { ok: false, reden: inbox.reden, rijen: [], geweigerd: [], telling: {}, gezien: 0 };
const spiegelOud = leesTekst(SPIEGEL);

console.log(`doorstroom — bron ${BRON_REPO}@${BRON_TAK}`);
if (!inbox.ok) console.log(`bron niet gelezen: ${inbox.reden}`);
else console.log(`inbox ${BRON_MAP}: kop ${inbox.sha}, ${inbox.rijen.length} rij(en) aangeleverd, ${inbox.stuk.length} onbruikbaar`
  + `${inbox.map === 'ONTBREEKT' ? ` — LET OP: deze map bestaat niet op deze tak` : ''}`);
console.log(post.ok
  ? `kanaalpost ${BRON_KANAALPOST}: ${post.gezien} rij(en) gezien, ${post.rijen.length} bruikbaar, ${weigeringsregel(post)}`
  : `kanaalpost ${BRON_KANAALPOST}: NIET GELEZEN (${post.reden})`);

// De bron is een logboek waar veertien vensters doorheen schrijven, en twee vensters die binnen
// dezelfde minuut melden landen daar in de volgorde waarin ze de commit wonnen — niet in die van de
// klok. Ongesorteerd doorzetten zet een rij van 08:16 ONDER een rij van 08:29, en wie de spiegel als
// tijdlijn leest, leest daar een volgorde uit die er niet is. Sorteren mag alleen over de NIEUWE
// rijen: de reeds gepubliceerde regels blijven staan waar ze staan, dat is de spiegelwet.
const aangeleverd = [...inbox.rijen, ...post.rijen]
  .map((rij, i) => ({ rij, i }))
  .sort((a, b) => (a.rij.geleverdOp?.getTime() ?? 0) - (b.rij.geleverdOp?.getTime() ?? 0) || a.i - b.i)
  .map(({ rij }) => rij);
const uit = overzetting(spiegelOud, aangeleverd);
// De achterstandsmeter kijkt naar wat er nog MOET aankomen, niet naar wat zichtbaar geweigerd is.
// Een rij die de publieke poort tegenhoudt komt daar nooit doorheen; hem als achterstallig blijven
// tellen zet het alarm permanent op rood, en een meter die altijd rood staat meet net zo weinig als
// een meter die altijd groen staat. Dat mag alleen omdat de weigering ELDERS wel een meter heeft:
// zie `postOordeel` verderop, dat op de verhouding geweigerd/gezien staat. Zonder die tweede meter
// zou dit filter een storing wegpoetsen in plaats van hem te verplaatsen.
const geweigerdeIds = new Set(uit.geweigerd.map((g) => g.id));
const onderweg = aangeleverd.filter((r) => !geweigerdeIds.has(r.id));
const achterstand = inbox.ok
  ? achterstandsOordeel(onderweg, spiegelOud, { nu })
  : { uitkomst: 'ROOD', reden: inbox.reden, achterstallig: [], oudsteMinuten: null };

// Het stempel komt van de GEPUBLICEERDE pagina, niet van een bestand in deze werkboom. De vraag is
// of de plaat die Richard opent vers is; een net gebouwd `status.json` op schijf beantwoordt die
// vraag niet en zou juist groen liegen op het moment dat publiceren stukloopt.
async function leesStempel() {
  // Zelfde standaard als `waarnemer.mjs` en `napublicatie.mjs`: één adres, op één plek te wijzigen
  // via de omgeving, maar nooit stilzwijgend afwezig — een ontbrekend adres zou de stempeltoets uit
  // zetten en dat is precies de blinde vlek die deze toets moet dichten.
  const url = process.env.DOORSTROOM_PLAAT_URL || 'https://rvanhooijdonk-png.github.io/stack-dashboard/';
  const r = await haal(`${url.replace(/\/$/, '')}/status.json`);
  if (r.status !== 200) return { generatedAt: null, sources: null, herkomst: `PLAAT_HTTP_${r.status}` };
  try {
    const j = JSON.parse(r.tekst);
    return { generatedAt: j?.generatedAt ?? null, sources: j?.sources ?? null, herkomst: 'PLAAT' };
  } catch { return { generatedAt: null, sources: null, herkomst: 'PLAAT_ONLEESBAAR' }; }
}
const stempelBron = await leesStempel();
const stempel = { ...stempelOordeel({ generatedAt: stempelBron.generatedAt, nu }), herkomst: stempelBron.herkomst };
// Dezelfde `status.json` draagt de rijentelling per bron: één ophaalactie, twee vragen — is de plaat
// vers, en heeft elke bron zijn rijen ook echt gehaald.
const bronRijen = bronRijenOordeel(stempelBron.sources);

// De vloot komt uit `LANES` — de lijst die de kijk al als gesloten veld gebruikt. Een tweede lijst
// zou meteen uit elkaar lopen, en dan is "welk venster staat leeg" afhankelijk van wélke lijst je
// pakt. `data/vloot.json` mag alleen ROLLEN toevoegen; wie erin staat wordt daar niet bepaald.
const rollen = leesJson(VLOOT) ?? {};
const standen = vlootstand(spiegelOud, { vensters: LANES.map((venster) => ({ venster, rol: rollen[venster] ?? null })), nu });

console.log(`overzetting: ${uit.overgezet.length} overgezet, ${uit.geweigerd.length} geweigerd`);
// De Actions-log van deze repo is openbaar. `g.id` is een bestandsnaam uit de PRIVATE inbox en
// draagt vaak een slug met onderwerp erin; die hoort daar niet in (Codex, 27-07). Het volgnummer,
// de gesloten redencode en de telling zijn genoeg om een geweigerde rij terug te vinden in de bron.
const afgekeurd = [...uit.geweigerd, ...inbox.stuk];
const tally = {};
for (const g of afgekeurd) tally[g.reden] = (tally[g.reden] ?? 0) + 1;
if (afgekeurd.length) {
  console.log(`  redenen: ${Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(', ')}`);
}
// Nooit stil afkappen: wat er niet staat wordt geteld en benoemd, anders leest een korte lijst als
// een volledige lijst.
const TOON = 25;
afgekeurd.slice(0, TOON).forEach((g, i) => console.log(`  geweigerd #${i + 1}: ${g.reden}`));
if (afgekeurd.length > TOON) console.log(`  … en nog ${afgekeurd.length - TOON} geweigerde rij(en), zie de telling hierboven`);
console.log(`achterstand: ${achterstand.uitkomst}${achterstand.reden ? ` (${achterstand.reden})` : ''}`
  + `${achterstand.achterstallig.length ? ` — oudste ${achterstand.oudsteMinuten} min, grens ${ACHTERSTAND_MINUTEN}` : ''}`);
console.log(`stempel: ${stempel.uitkomst}${stempel.reden ? ` (${stempel.reden}` : ''}`
  + `${stempel.ouderdomMinuten === null ? '' : `, ${stempel.ouderdomMinuten} min oud`}${stempel.reden ? ')' : ''}`);
console.log(`bronrijen: ${bronRijen.uitkomst}${bronRijen.reden ? ` (${bronRijen.reden})` : ''}`
  + `${bronRijen.afgekapt ? ` — ${bronRijen.afgekapt} rij(en) ingekort` : ''}`);
for (const s of standen) console.log(`  vloot ${s.venster}: ${s.toestand}${s.laatste ? ` (laatste ${s.laatste})` : ''}`);

if (schrijven && !uit.ongewijzigd) {
  // Laatste controle vóór het schrijven, met de wet zelf en niet met het vertrouwen dat de module
  // hierboven zich gedraagt. Faalt hij, dan gaat er niets naar schijf.
  const wet = alleenAangevuld(spiegelOud, uit.tekst);
  if (!wet.ok) { console.error('GEWEIGERD: de overzetting zou regels laten verdwijnen'); process.exit(1); }
  writeFileSync(SPIEGEL, uit.tekst, 'utf8');
  console.log(`geschreven: ${SPIEGEL} (+${uit.overgezet.length} rij(en))`);
}

// DE WEIGERING MOET ZELF EEN METER HEBBEN (review Codex + Gemini, 27-07-2026). Beide merkten op dat
// geweigerde rijen uit de achterstandsmeter gehaald worden en verder nergens meer opduiken: dan kan
// een bron die vanaf morgen door een vormwijziging volledig geweigerd wordt, groen blijven staan
// terwijl er niets meer doorkomt. Daarom oordeelt de kanaalpost apart, over de VERHOUDING:
//
//   ROOD  niet gelezen — of gelezen en onbruikbaar (merge-conflict, geen kop);
//   GEEL  gelezen, maar nul rijen gezien, of meer dan de helft geweigerd;
//   GROEN gelezen en de meerderheid stroomt door.
//
// De helft is een grens en geen natuurwet; hij staat hier zodat "de bron en de spiegel zijn het over
// de vorm oneens" zichtbaar wordt vóór het nul wordt. GEMETEN 27-07-2026: 262 van 280 rijen
// geweigerd, dus dit staat vandaag bewust op GEEL — die rijen dragen geen statuskolom en de
// publieke statuslijst is gesloten. Dat is een openstaande beslissing, geen storing die zich als
// groen mag voordoen.
const HELFT = 0.5;
const postOordeel = !post.ok ? 'ROOD'
  : (post.gezien === 0 || post.geweigerd.length > post.gezien * HELFT) ? 'GEEL' : 'GROEN';

const oordeel = {
  nu: nu.toISOString(),
  bron: { ok: inbox.ok, reden: inbox.ok ? null : inbox.reden, sha: inbox.sha ?? null, aangeleverd: inbox.rijen.length, onbruikbaar: inbox.stuk, map: inbox.map ?? null },
  kanaalpost: {
    ok: post.ok, reden: post.reden, pad: BRON_KANAALPOST, gezien: post.gezien,
    bruikbaar: post.rijen.length, geweigerd: post.geweigerd.length, telling: post.telling,
    uitkomst: postOordeel,
  },
  overzetting: { overgezet: uit.overgezet.map((o) => o.id), geweigerd: uit.geweigerd },
  achterstand,
  stempel,
  bronRijen,
  vlootstand: standen,
  // Eén veld waar de alarmstap op kijkt: elk rood telt, ongeacht welke van de drie het was.
  // Drie waarden, niet twee (Codex, 27-07): een GEEL deeloordeel — "niet gemeten" — werd hier
  // afgerond naar GROEN en sloot daarmee het alarm. Niet-gemeten is geen goed nieuws.
  uitkomst: eindoordeel({
    delen: [achterstand.uitkomst, stempel.uitkomst, bronRijen.uitkomst, postOordeel],
    bronOk: inbox.ok,
    inboxMap: inbox.map ?? null,
  }),
};
if (uitvoerPad) writeFileSync(uitvoerPad, `${JSON.stringify(oordeel, null, 2)}\n`, 'utf8');
console.log(`\nuitkomst: ${oordeel.uitkomst}`);
