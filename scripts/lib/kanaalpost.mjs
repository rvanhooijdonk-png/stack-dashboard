/**
 * VLOOT-KANAALPOST — het gedeelde doorgeefluik van álle vensters op de plaat.
 *
 * De bron is `data/kanaalpost-publiek.md`: de GESCHOONDE, publieke spiegel die elk venster zelf
 * bijhoudt. Bewust niet het interne `CONTROL/KANAALPOST.md` op de rapporten-branch, waar een eerdere
 * opzet van deze sectie naar keek. Dat interne logboek draagt repo-namen, paden, PR-nummers en
 * bewijsregels; de plaat is OPENBAAR. Eén bron, en het is de bron die al voor publiek geschreven is —
 * schonen bij het lezen is altijd zwakker dan schonen bij het schrijven (batch-opdracht 26-07-2026:
 * "stap over op de spiegel zodra die bestaat, één waarheid").
 *
 * Het bestand staat in deze repo, dus wat de plaat toont hoort per definitie bij de commit die hem
 * publiceerde. Er is geen netwerkronde en geen tweede stand die achter kan lopen.
 *
 * TWEE POORTEN, BEWUST GESCHEIDEN (review Codex + Gemini, 26-07-2026):
 *  - de PARSER beantwoordt één vraag: is dit een spiegelrij? Hij eist de exacte vijf kopnamen, een
 *    scheidingsregel er direct onder, en leest alleen de aaneengesloten tabel daaronder. Elke
 *    niet-tabelregel sluit die tabel weer. Zonder die drie eisen werd élke latere vijfkolomstabel
 *    in het bestand — ook eentje in een HTML-commentaar of onder een eigen kop — als kanaalpost
 *    gelezen, en schoof een andere kolomvolgorde vreemde velden naar `onderwerp`/`status`.
 *  - de DTO beantwoordt de tweede vraag: mag deze rij publiek? Vorm, statuslijst, rollabel en
 *    inhoudspoort zitten dáár, zodat een rij die niet door de poort komt wordt GETELD en niet stil
 *    verdwijnt. Wat de parser weggooit is geen rij; wat de DTO tegenhoudt is een ingehouden rij.
 *
 * Fail-closed in drie te onderscheiden eindstanden, want de plaat moet kunnen zeggen wát er mis is:
 * bron onbereikbaar · bron leesbaar maar geen herkende rij (dan is de parser verdacht, niet de
 * vloot) · er wás post maar geen enkele rij kwam door de publicatie-poort.
 *
 * EERLIJKE GRENS. Deze module is fail-on-known-pattern plus een handvol vormregels, geen begrip.
 * Een klantnaam of codenaam die nergens in een patroon of in `deny-terms.json` voorkomt, gaat hier
 * doorheen — precies zoals in `sanitize.mjs` beschreven staat. De echte verdediging is dat elk
 * venster zijn eigen regel al voor publicatie schrijft; dit is het vangnet, niet de muur.
 * OPERATIONELE KEUZE, expliciet: `kanaalpost` staat niet in `sources`, dus een onbereikbare spiegel
 * maakt de bouw niet rood — alleen deze sectie meldt het. Dat houdt één kapotte bron weg van de
 * rest van de plaat; de prijs is dat een status-API-lezer de storing niet ziet.
 */

import { denyTermsMaxLen, sanitizeString } from './sanitize.mjs';

/** De plaat toont het staartstuk van het doorgeefluik: de laatste vijftien rijen, nieuwste boven. */
export const KANAAL_RIJEN = 15;

/** De gesloten statuslijst uit de kop van de spiegel zelf. Alles daarbuiten wordt ingehouden. */
export const STATUSSEN = ['AFGEROND', 'WACHT OP AKKOORD', 'GEBLOKKEERD'];

const MAX_TAB = 40;
/**
 * De spiegelrijen zijn hele alinea's in gewone taal — dat is hun waarde. Afkappen mag daarom pas
 * ruim, en zichtbaar: een afgekapte regel eindigt op `…` zodat niemand een half verhaal voor het
 * hele verhaal houdt.
 */
const MAX_ONDERWERP = 600;
const MAX_STATUS = 60;
const MAX_ACTIE = 80;
const MAX_DATUM = 16;

/**
 * Vensterbreedte voor de publish-poort. `sanitizeString` kapt zelf af boven 2000 tekens en scant
 * dan NIET meer — dus wie een lange regel in één keer aanbiedt, krijgt "oversized" terug en heeft
 * de patronen nooit gezien. Daarom wordt de volledige cel in overlappende vensters gescand: de
 * overlap is ruimer dan het langste deny-patroon, zodat een sleutel op een vensterrand niet tussen
 * twee vensters door glipt. De overlap is bovendien afgetopt op de helft van het venster: zonder
 * dat plafond zou één absurd lange deny-term de stap op 1 zetten en de bouw praktisch stilleggen
 * (review Gemini, 26-07-2026). `loadDenyTerms` weigert zulke termen in strikte modus al bij het
 * laden, dus het plafond is de tweede lijn, niet de enige.
 */
const VENSTER = 1500;
const OVERLAP = 300;
const MAX_OVERLAP = VENSTER / 2;

/**
 * Datum-tijd-cel: kale dagdatum, eventueel gevolgd door HH:MM — en verder niets. Het eind-anker en
 * de uur-/minuutgrenzen zijn geen muggenzifterij: zonder anker matcht `2026-07-25 /pad/naar/iets`
 * gewoon, waarna de parser de rest van de cel weggooit en de rij als geldig doorlaat.
 */
const DATUM = /^(\d{4}-\d{2}-\d{2})(?:\s+([01]?\d|2[0-3]):([0-5]\d))?$/;
/** Dezelfde vorm, maar zoals de DTO hem uitgeeft: altijd tweecijferige uren. */
const DATUM_UIT = /^\d{4}-\d{2}-\d{2}(?: [0-2]\d:[0-5]\d)?$/;
/** Ruime vorm-eis in de parser: is dit überhaupt een rollabel en geen zin of markup? */
const TAB = /^[A-Za-z0-9 ()._/-]{1,40}$/;
/**
 * Strenge eis in de DTO: een rollabel is een ROL in kapitalen (`CONTROL`, `COMMAND-CANON`), geen
 * repository. Repo-namen zijn kleingeschreven met koppeltekens (`stack-control`) en vallen hier dus
 * buiten — precies het geval dat de review als lek aanwees. Wat afwijkt wordt geteld, niet verstopt.
 */
const TAB_PUBLIEK = /^[A-Z][A-Z0-9]*(?:[ -][A-Z0-9]+)*$/;

/**
 * Onzichtbare tekens. Een U+200B midden in `AWS_SECRET_KEY` of in een e-mailadres maakt élk
 * deny-patroon blind terwijl de browser vrijwel dezelfde tekst toont (review Codex + Gemini,
 * 26-07-2026). Ze worden daarom verwijderd vóór er gescand én vóór er getoond wordt: gescand
 * wordt precies wat er op de plaat komt.
 */
const ONZICHTBAAR = new RegExp(
  '[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u00AD\\u034F\\u061C\\u115F\\u1160'
  + '\\u17B4\\u17B5\\u180B-\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F'
  + '\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0]',
  'g',
);

/**
 * Normaliseer vrije tekst tot de vorm waarop we oordelen: NFKC (zodat breedbeeld-varianten van
 * letters gewone letters worden), zonder onzichtbare tekens, met witruimte tot één spatie
 * teruggebracht. Dat laatste is ook een poort: `password` + 1600 spaties + `: geheim` matcht anders
 * nooit binnen één scanvenster.
 */
export function ontdaan(waarde) {
  return String(waarde ?? '').normalize('NFKC').replace(ONZICHTBAAR, '').replace(/\s+/g, ' ').trim();
}

/**
 * Markdown-nadruk weghalen zodat de plaat gewone tekst toont. Bewust NIET `_`: dat zou
 * `SERVICE_TOKEN` tot `SERVICETOKEN` maken en daarmee juist het secret-naam-patroon blind maken.
 */
const kaal = (s) => ontdaan(String(s ?? '').replace(/[`*]+/g, ''));

/**
 * Wat de spiegel volgens zijn eigen kop niet mag dragen en wat geen enkel `sanitize`-patroon vangt:
 * mappaden zonder `/Users/`-prefix en telefoonnummers. Getoetst tegen alle bestaande spiegelrijen —
 * geen van de 33 raakt deze patronen, dus dit houdt niets tegen wat er nu al staat.
 */
const EXTRA_VERBODEN = [
  // Drie of meer padsegmenten, of twee segmenten met een bestandsextensie: `CONTROL/RAPPORTEN/x.md`.
  /(?:^|[\s(])[\w.-]+\/[\w.-]+\/[\w.-]+/,
  /(?:^|[\s(])[\w.-]+\/[\w.-]+\.(?:md|json|mjs|js|ts|py|sh|ya?ml|txt|html?|csv|env|sql)\b/i,
  // Nederlands telefoonnummer, met of zonder landcode.
  /(?:\+\d{1,3}[\s-]?)?\b0[1-9][\d\s-]{7,12}\b/,
];

/** Strikte YYYY-MM-DD-toets: vorm én een echt bestaande datum (geen 2026-13-40). */
function isEchteDatum(v) {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Cellen van één tabelregel, of `null` als het geen tabelregel is. Splitsen gebeurt op een
 * NIET-ge-escapete pipe: `A \| B` is in markdown één cel met een pipe erin, en hard splitsen
 * schoof daar een halve cel naar de volgende kolom (review Gemini, 26-07-2026).
 */
function cellenVan(regel) {
  const r = String(regel ?? '').trim();
  if (!r.startsWith('|') || !r.endsWith('|')) return null;
  return r.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

const KOPNAMEN = ['datum-tijd', 'tab-rol', 'onderwerp', 'status', 'actie voor'];
const isKop = (c) => c.length === KOPNAMEN.length
  && c.every((cel, i) => kaal(cel).toLowerCase() === KOPNAMEN[i]);
const isScheiding = (c) => c.length > 0 && c.every((cel) => /^:?-{3,}:?$/.test(cel));

/** Vorm-toets op één datarij. Geen oordeel over publiceerbaarheid — dat doet de DTO. */
function rijUitCellen(c) {
  const d = DATUM.exec(ontdaan(c[0]));
  if (!d || !isEchteDatum(d[1])) return null;
  const tab = kaal(c[1]);
  const onderwerp = kaal(c[2]);
  if (!TAB.test(tab) || !onderwerp) return null;
  return {
    tab,
    onderwerp,
    status: kaal(c[3]),
    actie: kaal(c[4]),
    // Een handgeschreven `9:05` telt mee maar wordt als `09:05` getoond: de kolom moet uitlijnen,
    // en een rij stil laten wegvallen op een ontbrekende nul is te streng.
    datum: d[2] ? `${d[1]} ${d[2].padStart(2, '0')}:${d[3]}` : d[1],
  };
}

/**
 * Lees de spiegel: één rij per melding, vijf velden.
 * `| datum-tijd | tab-rol | onderwerp | status | actie voor |`
 *
 * Alleen de aaneengesloten tabel onder een exacte spiegelkop telt. De kolom-uitleg bovenaan het
 * bestand (twee kolommen) en elke andere tabel blijven daardoor buiten beeld.
 */
export function spiegelUitTekst(tekst) {
  const regels = String(tekst ?? '').split('\n');
  const rijen = [];
  let inTabel = false;
  for (let i = 0; i < regels.length; i += 1) {
    const c = cellenVan(regels[i]);
    // Elke niet-tabelregel — lege regel, kop, proza, `<!--` — sluit de lopende tabel.
    if (!c) { inTabel = false; continue; }
    if (isKop(c)) {
      const volgende = cellenVan(regels[i + 1]);
      inTabel = Boolean(volgende && volgende.length === KOPNAMEN.length && isScheiding(volgende));
      // De scheidingsregel hoort bij de kop en wordt hier opgegeten. Daardoor is élke látere
      // scheidingsregel het begin van een andere tabel — ook zonder lege regel ertussen.
      if (inTabel) i += 1;
      continue;
    }
    if (!inTabel) continue;
    // Een afwijkend kolomaantal of een tweede scheidingsregel is een andere tabel: sluiten, niet
    // raden welke cel welk veld is.
    if (isScheiding(c) || c.length !== KOPNAMEN.length) { inTabel = false; continue; }
    const rij = rijUitCellen(c);
    if (rij) rijen.push(rij);
  }
  return rijen;
}

/**
 * Is deze vrije tekst publiceerbaar? Geen bevinding = ja. Bewust een JA/NEE-poort en geen redactie:
 * een spiegelrij met `[REDACTED]` erin is onleesbaar én verhult dat er iets misging bij het venster
 * dat hem schreef. Een verdachte rij wordt ingehouden en geteld.
 *
 * Volgorde is de hele truc: eerst scannen op de VOLLEDIGE tekst, pas daarna cappen. Andersom
 * publiceert de gate de eerste zeshonderd tekens van een regel waarvan het geheim op teken 2500
 * staat — en ziet dat geheim nooit.
 */
export function publishVeilig(tekst) {
  const s = ontdaan(tekst);
  if (EXTRA_VERBODEN.some((re) => re.test(s))) return false;
  // De overlap moet minstens zo breed zijn als het langste patroon dat over een naad kan vallen.
  // Alle regex-patronen zijn na de witruimte-normalisatie begrensd en ruim onder 300; alleen een
  // deny-term is vrije mensentekst en kan langer zijn — die meet de gate daarom zelf op.
  const overlap = Math.min(Math.max(OVERLAP, denyTermsMaxLen()), MAX_OVERLAP);
  const stap = VENSTER - overlap;
  for (let i = 0; i === 0 || i < s.length; i += stap) {
    if (sanitizeString(s.slice(i, i + VENSTER)).findings.length > 0) return false;
  }
  return true;
}

/**
 * Vorm-poort van de DTO: alle vijf velden aanwezig en gevuld, status uit de gesloten lijst, rollabel
 * een rol en geen repo, datum in de uitgiftevorm. Faalt er iets, dan is dit geen publieke rij —
 * `null`, en de aanroeper telt hem als ingehouden. Nooit een rij vol `—` publiceren: corrupte
 * invoer mag geen geldige publieke data worden (review Codex, 26-07-2026).
 */
function publiekeVorm(r) {
  if (!r || typeof r !== 'object') return null;
  const veld = (v) => (typeof v === 'string' ? ontdaan(v) : '');
  const rij = {
    tab: veld(r.tab),
    onderwerp: veld(r.onderwerp),
    status: veld(r.status),
    actie: veld(r.actie),
    datum: veld(r.datum),
  };
  if (!rij.tab || !rij.onderwerp || !rij.actie) return null;
  if (!TAB_PUBLIEK.test(rij.tab) || rij.tab.length > MAX_TAB) return null;
  if (!STATUSSEN.includes(rij.status)) return null;
  if (!DATUM_UIT.test(rij.datum) || !isEchteDatum(rij.datum.slice(0, 10))) return null;
  return rij;
}

/**
 * Reduceer de spiegel tot de publieke plaat-DTO: elke rij eerst door vorm- en publicatiepoort,
 * daarna de laatste vijftien die overbleven, nieuwste boven, en pas als laatste stap afgekapt.
 *
 * ÁLLE rijen worden getoetst, niet alleen de vijftien die in beeld komen. Andersom zou de teller
 * `ingehouden: 0` melden terwijl een oudere rij nooit langs de poort is geweest — een geruststelling
 * die niets bewijst (review Codex, 26-07-2026). Nu betekent 0 wat het zegt: geen enkele rij in het
 * hele spiegelbestand raakt een patroon.
 *
 * De volgorde is de BRONVOLGORDE omgedraaid, niet een sortering op de datumkolom. Het bestand is
 * append-only ("nieuwste onderaan", en de kop zegt er expliciet bij dat de volgorde die van het
 * toevoegen is), dus de laatste vijftien regels zijn per afspraak de laatste vijftien meldingen;
 * een venster dat een rij met een oudere tijd aanvult, hoort niet ineens bovenaan te springen.
 */
export function toPublicKanaalpost(raw) {
  const leeg = (reason, ingehouden = 0) => ({ available: false, reason, rows: [], ingehouden });
  if (!raw || raw.available !== true || !Array.isArray(raw.rows)) {
    return leeg(raw?.reason === 'LEEG' ? 'LEEG' : 'BRON_ONBEREIKBAAR');
  }
  const cap = (v, max) => (v.length > max ? `${v.slice(0, max - 1).trimEnd()}…` : v);
  const veilig = [];
  let ingehouden = 0;
  for (const r of raw.rows) {
    const rij = publiekeVorm(r);
    if (!rij || ![rij.tab, rij.onderwerp, rij.status, rij.actie, rij.datum].every(publishVeilig)) {
      ingehouden += 1;
      continue;
    }
    veilig.push(rij);
  }
  const rows = veilig.slice(-KANAAL_RIJEN).reverse().map((rij) => ({
    tab: cap(rij.tab, MAX_TAB),
    onderwerp: cap(rij.onderwerp, MAX_ONDERWERP),
    status: cap(rij.status, MAX_STATUS),
    actie: cap(rij.actie, MAX_ACTIE),
    datum: cap(rij.datum, MAX_DATUM),
  }));
  if (!rows.length) return leeg(ingehouden ? 'INGEHOUDEN' : 'LEEG', ingehouden);
  return { available: true, reason: null, rows, ingehouden };
}

/**
 * Lees de spiegel uit tekst naar de collector-vorm. Gescheiden van het lezen van het BESTAND, zodat
 * de vorm-eisen zonder schijf getest kunnen worden.
 */
export function kanaalpostUitTekst(tekst) {
  if (typeof tekst !== 'string' || tekst.trim() === '') {
    return { available: false, reason: 'BRON_ONBEREIKBAAR', rows: [] };
  }
  const rows = spiegelUitTekst(tekst);
  if (!rows.length) return { available: false, reason: 'LEEG', rows: [] };
  return { available: true, reason: null, rows };
}
