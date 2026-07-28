/**
 * KANAALPOSTBRON — leest `CONTROL/KANAALPOST.md` PER RIJ, niet als document.
 *
 * WAAROM DIT BESTAAT. Gemeten op 27-07-2026: de publieke spiegel liep uren achter terwijl de bron
 * die dag naar 277 rijen groeide. De doorstroom meldde "bron: gelezen, 0 rij(en) aangeleverd" en
 * stond daarmee stil zonder dat iemand zag waarom. Drie muren, elk goed voor een nul op zichzelf:
 *
 *   1. de doorstroom leest `CONTROL/SPIEGEL/INBOX/` — die map bestaat niet (HTTP 404);
 *   2. `kanoniekeSpiegelvorm` weigert de HELE bron op regel 1 (`HTML_COMMENTAAR`: de kop van het
 *      bestand is een commentaarblok). Een document weigeren is fail-closed en levert nul op zonder
 *      dat iemand ziet welke rij het probleem was;
 *   3. de bron heeft ANDERE kolommen dan de spiegel: `Tab | Wat klaar is | Sha | Richard / Fable |
 *      Datum-tijd (UTC)` tegenover `datum-tijd | tab-rol | onderwerp | status | actie voor`.
 *      `spiegelUitTekst` leest er daarom 0.
 *
 * DE OMKERING. Hier wordt geen document beoordeeld maar een rij. Elke bronrij wordt op zichzelf
 * omgezet naar spiegelvorm en op zichzelf getoetst; wat niet door de poort komt draagt een reden uit
 * een gesloten lijst, en de rest gaat gewoon door. Eén misvormde rij kost één rij.
 *
 * WAT HIER NIET GEBEURT. Geen netwerk, geen schijf, geen versoepeling van de publieke poort. De
 * omgezette rij gaat door exact dezelfde toetsen als elke andere rij die de spiegel in wil — deze
 * module maakt de weigering alleen PER RIJ en TELBAAR in plaats van documentbreed en stil.
 */

import { bevatOnzichtbaar, cellenVanRegel, celVeilig, kanoniekeSpiegelvorm, STATUSSEN } from './kanaalpost.mjs';

/** De kop die de bron voert. Staat die er niet, dan is dit niet het doorgeefluik. */
export const BRON_KOPNAMEN = ['tab', 'wat klaar is', 'sha', 'richard / fable', 'datum-tijd (utc)'];

/**
 * De vertaling van bron naar spiegel. Vier van de vijf kolommen zijn een verhuizing; de vijfde
 * bestaat in de bron niet en wordt uit de tekst gehaald — zie `standUitTekst`.
 */
const KOLOM = { tab: 0, onderwerp: 1, sha: 2, actie: 3, datum: 4 };

/**
 * Redenen. GESLOTEN lijst, en dat is een belofte die de code moet houden: dit belandt in een
 * openbare Actions-log en op de plaat. Elke reden die van elders komt (de vormpoort kent er meer)
 * wordt naar `VORM` gebracht — anders lekt er een naam naar buiten die hier niet is afgesproken.
 */
export const BRON_REDENEN = [
  'KOLOMMEN', 'GEEN_DATUM', 'TAB_VORM', 'GEEN_ONDERWERP', 'GEEN_STAND', 'STAND_ONBEKEND',
  'ONZICHTBAAR_TEKEN', 'BUITEN_TABEL', 'VORM',
];

const bekendeReden = (reden) => (BRON_REDENEN.includes(reden) ? reden : 'VORM');

/** De cellezer van de spiegelwet zelf: één uitvoering, zodat beide lezers dezelfde kolommen zien. */
const cellenVan = cellenVanRegel;

const kaal = (s) => String(s ?? '').replace(/[`*]+/g, '').trim();
const isScheiding = (c) => c.length > 0 && c.every((cel) => /^:?-{3,}:?$/.test(cel));
const isBronKop = (c) => c.length === BRON_KOPNAMEN.length
  && c.every((cel, i) => kaal(cel).toLowerCase() === BRON_KOPNAMEN[i]);

/**
 * `2026-07-27 13:41` of `2026-07-27 13:41 UTC` → `2026-07-27 13:41`. Zonder tijd blijft de kale
 * datum staan.
 *
 * VERANKERD, aan beide kanten (review Codex + Gemini, 27-07-2026). Een losse zoektocht naar een
 * datum ergens in de cel maakte drie ongelijke dingen gelijk: `... 13:41 UTC`, `... 13:41 CEST` en
 * `rommel 13:41 rommel` kregen alle drie hetzelfde publieke tijdstip, terwijl de tweede er twee uur
 * naast zit en de derde helemaal niet gemeten is. De kolom heet in de bron `Datum-tijd (UTC)`; alles
 * wat daar niet naar staat is GEEN_DATUM en blijft liggen. Een verkeerd tijdstip publiceren is erger
 * dan een rij niet publiceren, want een verkeerd tijdstip is niet van een goed tijdstip te
 * onderscheiden.
 *
 * Eén uitzondering, gemeten in de echte bron: zes rijen schrijven `06:47 UTC (08:47 lokaal)`. Daar
 * staat de UTC-markering wél direct achter de tijd en is de haakjestekst enkel een vriendelijkheid
 * voor de lezer. Een toelichting achter een eenduidige markering mag dus. Wat NIET mag is de
 * omgekeerde vorm `13:32 NL (11:32 UTC)` — daar is de eerste tijd niet de UTC-tijd, en juist het
 * ontbreken van de markering direct achter de tijd is het enige wat dat verraadt.
 *
 * De haakjestekst zelf wordt NOOIT gepubliceerd: de publieke datum wordt hieronder opnieuw
 * opgebouwd uit de vangsten 1 t/m 3. Wat er tussen de haakjes staat kan dus geen kolomgrens,
 * opmaak of onzichtbaar teken de publieke plaat in dragen (review Codex, 27-07-2026). Wat de vorm
 * wél moet tegenhouden is `2026-07-26 UTC (08:47 lokaal)`: een rij zónder hoofdtijd waarvan de
 * enige tijd in de toelichting staat, zou als middernacht op de plaat komen — precies het
 * verkeerde-tijdstip-probleem waar deze regel voor bestaat. Zie de vangst-4-toets in `datumUit`.
 */
const DATUM = /^(\d{4}-\d{2}-\d{2})(?:[ \tT]+([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?)?(?:[ \t]*(?:UTC|Z|\+00:?00)([ \t]*\([^)]*\))?)?$/;

function datumUit(cel) {
  const m = DATUM.exec(kaal(cel));
  if (!m) return null;
  // Een toelichting zonder hoofdtijd: de enige tijd in de cel staat tussen de haakjes en die lezen
  // we niet. Doorlaten zou hem als middernacht publiceren — een tijd die niemand geschreven heeft.
  if (m[4] && !m[2]) return null;
  // Een echte datum, niet alleen de vorm: 2026-02-30 leest als vorm goed en bestaat niet.
  const [jj, mm, dd] = m[1].split('-').map(Number);
  const proef = new Date(Date.UTC(jj, mm - 1, dd));
  if (proef.getUTCFullYear() !== jj || proef.getUTCMonth() !== mm - 1 || proef.getUTCDate() !== dd) return null;
  return m[2] ? `${m[1]} ${m[2].padStart(2, '0')}:${m[3]}` : m[1];
}

/** Dezelfde vorm die de publieke poort van een tab-label eist. */
const TAB_PUBLIEK = /^[A-Z][A-Z0-9]*(?:[ -][A-Z0-9]+)*$/;

/**
 * De stand uit de tekst. De bron heeft geen statuskolom — vensters schrijven hun stand ín de
 * melding, als `**STAND:** WACHT OP AKKOORD`. Die tekst is de enige plek waar het staat, dus daar
 * wordt hij gelezen; wat er niet staat wordt NIET geraden. Een rij zonder stand krijgt `GEEN_STAND`
 * en blijft liggen — een verzonnen status is erger dan een ontbrekende rij, want hij ziet er
 * hetzelfde uit als een gemeten status.
 */
const STAND_RE = /\bSTAND\s*:?\s*\**\s*:?\s*([A-Z][A-Z -]{2,24}?)(?=\s*(?:[—–\-·●|<*.]|$))/;

export function standUitTekst(tekst) {
  const m = STAND_RE.exec(kaal(tekst));
  if (!m) return { ok: false, reden: 'GEEN_STAND' };
  const gevonden = m[1].trim().toUpperCase();
  if (!STATUSSEN.includes(gevonden)) return { ok: false, reden: 'STAND_ONBEKEND', gevonden };
  return { ok: true, stand: gevonden };
}

/**
 * Eén bronrij → één spiegelrij, of één reden.
 *
 * `{ ok: true, regel }` of `{ ok: false, reden }`. De volgorde van de toetsen is de volgorde waarin
 * een mens de oorzaak zou zoeken: eerst of het überhaupt een rij is, dan de velden, en pas als
 * laatste de vorm van de rij die eruit komt.
 */
export function spiegelrijUitBronrij(regel) {
  const c = cellenVan(regel);
  if (!c || c.length !== BRON_KOPNAMEN.length) return { ok: false, reden: 'KOLOMMEN' };

  const datum = datumUit(c[KOLOM.datum]);
  if (!datum) return { ok: false, reden: 'GEEN_DATUM' };

  const tab = kaal(c[KOLOM.tab]);
  if (!TAB_PUBLIEK.test(tab)) return { ok: false, reden: 'TAB_VORM' };

  const onderwerp = String(c[KOLOM.onderwerp] ?? '').trim();
  if (!kaal(onderwerp)) return { ok: false, reden: 'GEEN_ONDERWERP' };

  const stand = standUitTekst(onderwerp);
  if (!stand.ok) return { ok: false, reden: stand.reden, gevonden: stand.gevonden ?? null };

  const actie = String(c[KOLOM.actie] ?? '').trim() || '-';
  // De cellezer haalt `\|` terug naar een kale pipe; wie die kale pipe vervolgens in een nieuwe rij
  // schrijft, maakt er een kolomgrens van. GEMETEN: negen rijen kwamen zo als `GEEN_RIJ` terug —
  // geweigerd om iets wat de omzetting zélf had gedaan, met een reden die naar de bron wees.
  // `celVeilig` is de letterlijke omkering van de cellezer, dus lezen-en-terugschrijven levert
  // dezelfde tekst op — ook als er een backslash in staat.
  const uit = `| ${datum} | ${tab} | ${celVeilig(onderwerp)} | ${stand.stand} | ${celVeilig(actie)} |`;

  // De vorm van de rij die de spiegel in zou gaan — niet die van het document eromheen. Dit is het
  // hele punt: de bron mag een commentaarkop, codehekken en inspringing bevatten zonder dat één
  // enkele rij daardoor tegengehouden wordt.
  if (bevatOnzichtbaar(uit)) return { ok: false, reden: 'ONZICHTBAAR_TEKEN' };
  const vorm = kanoniekeSpiegelvorm(uit);
  if (!vorm.ok) return { ok: false, reden: bekendeReden(vorm.reden) };

  return { ok: true, regel: uit };
}

/**
 * Lees de hele bron per rij.
 *
 * `{ ok, reden, rijen, geweigerd, telling, gezien }` — `rijen` in de vorm die `overzetting()`
 * verwacht (`{ id, regel, geleverdOp }`), `geweigerd` als `{ id, reden }`, en `telling` als
 * `{ <reden>: aantal }` zodat de uitvoerder "N rijen geweigerd, reden X" kan afdrukken.
 *
 * `ok: false` is voorbehouden aan de twee gevallen waarin het DOCUMENT niets zegt: een onopgelost
 * merge-conflict en een ontbrekende kop. Alle andere bezwaren gelden één rij.
 *
 * `id` is een REGELNUMMER en geen tekst uit de bron: de bron is privé en de log is openbaar. Een
 * regelnummer is genoeg om de rij terug te vinden en draagt niets mee.
 */
const CONFLICT = /^(?:<{7}|={7}|>{7})(?:\s|$)/;
const HEK = /^\s*(?:```|~~~)/;

export function bronRijenUitKanaalpost(tekst) {
  const regels = String(tekst ?? '').split(/\r\n|\r|\n/);
  const rijen = [];
  const geweigerd = [];
  let gezien = 0;
  let inHek = false;
  let inCommentaar = false;
  let naKop = false;

  for (let i = 0; i < regels.length; i += 1) {
    const ruw = regels[i].trim();

    // EEN CONFLICTMARKERING IS HET ENE GEVAL WAARIN HET HELE DOCUMENT ONBRUIKBAAR IS (review Codex,
    // 27-07-2026). Bij een onopgelost merge-conflict staan er twee versies van dezelfde waarheid in
    // het bestand, allebei met nette rijen. Per rij oordelen zou beide armen publiceren, en de lezer
    // ziet niet welke van de twee gold. Hier is stoppen dus geen stilte maar een uitspraak: de
    // aanroeper krijgt `ok: false` met een reden en het alarm gaat rood.
    if (!inHek && CONFLICT.test(ruw)) {
      return { ok: false, reden: 'BRON_CONFLICT', rijen: [], geweigerd: [], telling: {}, gezien: 0 };
    }
    // Rijen binnen een codehek of een commentaarblok zijn GEEN meldingen — het zijn voorbeelden.
    // Ze worden wel geteld en benoemd: wat onzichtbaar overgeslagen wordt, leest later als
    // "er stond niets".
    if (HEK.test(ruw)) { inHek = !inHek; continue; }
    if (!inHek && ruw.startsWith('<!--')) inCommentaar = !ruw.includes('-->');
    else if (inCommentaar && ruw.includes('-->')) { inCommentaar = false; continue; }

    if (!ruw.startsWith('|')) continue;
    const c = cellenVan(ruw);
    if (c && isBronKop(c)) { naKop = !inHek && !inCommentaar; continue; }
    if (c && isScheiding(c)) continue;
    gezien += 1;
    // Een rij vóór de kop of binnen een hek staat buiten de tabel. Fail-closed én zichtbaar: hij
    // telt mee in `gezien` en krijgt een reden, in plaats van stil te verdwijnen.
    if (inHek || inCommentaar || !naKop) { geweigerd.push({ id: i + 1, reden: 'BUITEN_TABEL' }); continue; }

    const uit = spiegelrijUitBronrij(ruw);
    if (!uit.ok) { geweigerd.push({ id: i + 1, reden: uit.reden }); continue; }
    // De aanlevertijd is de meldtijd uit de rij zelf. De bron heeft geen bestandsnaam met een
    // tijdstempel, en de bouwtijd nemen zou elke rij vers laten lijken op het moment dat de
    // doorstroom draait — precies de meting die de achterstandstoets moet doen.
    const d = /^(\d{4}-\d{2}-\d{2})(?: (\d{2}):(\d{2}))?/.exec(uit.regel.split('|')[1].trim());
    const geleverdOp = new Date(`${d[1]}T${d[2] ?? '00'}:${d[3] ?? '00'}:00Z`);
    rijen.push({ id: i + 1, regel: uit.regel, geleverdOp });
  }

  const telling = {};
  for (const g of geweigerd) telling[g.reden] = (telling[g.reden] ?? 0) + 1;
  // Geen kop gezien is geen lege kanaalpost maar een onherkenbaar bestand. Nul rijen uit een bestand
  // dat er niet uitziet zoals afgesproken mag nooit als "vandaag was het rustig" langskomen.
  if (!naKop) return { ok: false, reden: 'BRON_GEEN_KOP', rijen: [], geweigerd, telling, gezien };
  return { ok: true, reden: null, rijen, geweigerd, telling, gezien };
}

/** "13 rijen geweigerd: TAB_VORM 13" — één regel, telbaar, zonder brontekst. */
export function weigeringsregel({ geweigerd = [], telling = {} } = {}) {
  if (!geweigerd.length) return '0 rijen geweigerd';
  const delen = Object.entries(telling).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`);
  return `${geweigerd.length} rijen geweigerd: ${delen.join(', ')}`;
}
