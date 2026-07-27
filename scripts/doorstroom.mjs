#!/usr/bin/env node
/**
 * DOORSTROOM (uitvoerder) — haalt aangeleverde spiegelrijen op, laat `scripts/lib/doorstroom.mjs`
 * oordelen, en schrijft alleen de publieke spiegel bij. Verder niets.
 *
 * DE BRON. `rvanhooijdonk-png/stack-control`, tak `rapporten`, map `CONTROL/SPIEGEL/INBOX/`. Eén rij
 * per bestand, bestandsnaam `YYYY-MM-DDTHH-MM-<venster>-<slug>.md`. Die vorm doet twee dingen: twee
 * vensters kunnen nooit hetzelfde bestand raken (dus geen botsing), en het tijdstip van AANLEVERING
 * staat in de naam — zonder extra API-verkeer, en zichtbaar voor een mens die de map opent.
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

import {
  ACHTERSTAND_MINUTEN, achterstandsOordeel, bronRijenOordeel, bronRijUitTekst, overzetting,
  stempelOordeel, vlootstand,
} from './lib/doorstroom.mjs';
import { LANES } from './lib/kijk.mjs';
import { alleenAangevuld } from './lib/spiegelwet.mjs';

const BRON_REPO = process.env.DOORSTROOM_BRON_REPO || 'rvanhooijdonk-png/stack-control';
const BRON_TAK = process.env.DOORSTROOM_BRON_TAK || 'rapporten';
const BRON_MAP = process.env.DOORSTROOM_BRON_MAP || 'CONTROL/SPIEGEL/INBOX';
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

/** Eén ophaal met tijdsbudget. Een fout is een UITKOMST, geen uitzondering — en draagt geen URL mee. */
async function haal(url) {
  try {
    const r = await fetch(url, { headers: koppen, signal: AbortSignal.timeout(20000) });
    return { status: r.status, tekst: await r.text() };
  } catch {
    return { status: 0, tekst: '' };
  }
}

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
  // Een lege of nog niet bestaande map is geen storing: dan is er simpelweg niets aangeleverd.
  if (lijst.status === 404) return { ok: true, sha, rijen: [], stuk: [] };
  if (lijst.status !== 200) return { ok: false, reden: `INBOX_HTTP_${lijst.status}`, rijen: [], stuk: [] };

  let items = [];
  try { items = JSON.parse(lijst.tekst); } catch { return { ok: false, reden: 'INBOX_ONLEESBAAR', rijen: [], stuk: [] }; }
  if (!Array.isArray(items)) return { ok: false, reden: 'INBOX_GEEN_MAP', rijen: [], stuk: [] };

  const rijen = [];
  const stuk = [];
  for (const item of items.filter((i) => i?.type === 'file' && /\.md$/.test(i?.name ?? '')).sort((a, b) => a.name.localeCompare(b.name))) {
    const geleverdOp = geleverdUitNaam(item.name);
    if (!geleverdOp) { stuk.push({ id: item.name, reden: 'GEEN_TIJDSTEMPEL_IN_NAAM' }); continue; }
    const inhoud = await haal(`https://api.github.com/repos/${BRON_REPO}/contents/${encodeURI(item.path)}?ref=${sha}`);
    if (inhoud.status !== 200) { stuk.push({ id: item.name, reden: `RIJ_HTTP_${inhoud.status}` }); continue; }
    let tekst = '';
    try {
      const blob = JSON.parse(inhoud.tekst);
      tekst = blob?.encoding === 'base64' ? Buffer.from(blob.content, 'base64').toString('utf8') : String(blob?.content ?? '');
    } catch { stuk.push({ id: item.name, reden: 'RIJ_ONLEESBAAR' }); continue; }
    const gelezen = bronRijUitTekst(item.name, tekst);
    if (!gelezen.ok) { stuk.push({ id: item.name, reden: gelezen.reden }); continue; }
    rijen.push({ ...gelezen, geleverdOp });
  }
  return { ok: true, sha, rijen, stuk };
}

const leesTekst = (pad) => { try { return readFileSync(pad, 'utf8'); } catch { return null; } };
const leesJson = (pad) => { try { return JSON.parse(readFileSync(pad, 'utf8')); } catch { return null; } };

const nu = new Date();
const inbox = await leesInbox();
const spiegelOud = leesTekst(SPIEGEL);

console.log(`doorstroom — bron ${BRON_REPO}@${BRON_TAK}/${BRON_MAP}`);
if (!inbox.ok) console.log(`bron niet gelezen: ${inbox.reden}`);
else console.log(`bron: kop ${inbox.sha}, ${inbox.rijen.length} rij(en) aangeleverd, ${inbox.stuk.length} onbruikbaar`);

const uit = overzetting(spiegelOud, inbox.rijen);
const achterstand = inbox.ok
  ? achterstandsOordeel(inbox.rijen, spiegelOud, { nu })
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
for (const g of [...uit.geweigerd, ...inbox.stuk]) console.log(`  geweigerd ${g.id}: ${g.reden}`);
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

const oordeel = {
  nu: nu.toISOString(),
  bron: { ok: inbox.ok, reden: inbox.ok ? null : inbox.reden, sha: inbox.sha ?? null, aangeleverd: inbox.rijen.length, onbruikbaar: inbox.stuk },
  overzetting: { overgezet: uit.overgezet.map((o) => o.id), geweigerd: uit.geweigerd },
  achterstand,
  stempel,
  bronRijen,
  vlootstand: standen,
  // Eén veld waar de alarmstap op kijkt: elk rood telt, ongeacht welke van de drie het was.
  uitkomst: [achterstand.uitkomst, stempel.uitkomst, bronRijen.uitkomst].includes('ROOD') || !inbox.ok
    ? 'ROOD' : 'GROEN',
};
if (uitvoerPad) writeFileSync(uitvoerPad, `${JSON.stringify(oordeel, null, 2)}\n`, 'utf8');
console.log(`\nuitkomst: ${oordeel.uitkomst}`);
