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
 *
 * Geëxporteerd omdat de spiegel-catalogus dezelfde canonieke vorm moet eisen als de parser
 * oplevert. Deed hij dat niet — bijvoorbeeld met alleen `ontdaan` — dan zou een catalogusregel mét
 * backticks laden, terwijl de parser diezelfde regel zónder backticks aanbiedt, en werd een
 * goedgekeurde rij toch ingehouden (bevinding Gemini, 26-07-2026). Eén functie, dus dat kan niet.
 */
export const kaal = (s) => ontdaan(String(s ?? '').replace(/[`*]+/g, ''));

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
 * De SLEUTEL van een rij: het viertal vrije velden in canonieke vorm, als één ondubbelzinnige
 * string. `JSON.stringify` van een array en niet een zelfgekozen scheidingsteken — elk teken dat je
 * kiest kan in de tekst zelf voorkomen, en dan zouden twee verschillende viertallen dezelfde sleutel
 * krijgen. `datum` hoort er niet bij: dat veld is strikt getypeerd en draagt geen bewering.
 */
export function viertalSleutel(v) {
  return JSON.stringify([kaal(v?.tab), kaal(v?.onderwerp), kaal(v?.status), kaal(v?.actie)]);
}

/**
 * Draagt deze string geen onzichtbare tekens en geen losse witruimte? Dit is `ontdaan` MINUS de
 * NFKC-stap, en dat verschil is met opzet.
 *
 * `ontdaan(s) === s` eisen op tekst die GETOOND wordt kan niet: `cap()` sluit een afgekapte zin af
 * met `…`, en NFKC ontleedt dat teken tot drie punten. Elke afgekapte regel zou dus als
 * "niet-canoniek" worden geweigerd — en op de spiegel is op dit moment 20 van de 44 onderwerpen
 * langer dan de plaat toelaat. NFKC-stabiliteit is ook geen veiligheidseigenschap: `publishVeilig`
 * normaliseert zelf vóór het scannen, dus een breedbeeld-variant wordt gescand alsof hij gewoon
 * geschreven was. Wat wél een veiligheidseigenschap is, staat hieronder: geen onzichtbare tekens
 * (die maken elk deny-patroon blind) en geen witruimte waarin een patroon zich kan verstoppen.
 */
const netjes = (s) => s === s.replace(ONZICHTBAAR, '').replace(/\s+/g, ' ').trim();

/**
 * Voldoet een viertal aan álles wat de DTO van een PUBLIEKE rij eist — zonder dat er nog iets
 * afgekapt of gerepareerd hoeft te worden? Dit is de enige plek waar die eisen staan, en de
 * spiegel-catalogus gebruikt exact deze functie om zijn eigen `publiek`-kant te keuren.
 *
 * Dat is geen nettigheid maar de kern van de omslag: doordat elke cataloguswaarde hier al doorheen
 * moet, is wat de plaat toont LETTERLIJK de byte-reeks die in het catalogusbestand staat. Zou de
 * catalogus langere waarden toestaan, dan zou `cap()` er alsnog een half-afgekapte zin van maken en
 * publiceerde de plaat iets wat niemand in die vorm heeft goedgekeurd (review Codex, 26-07-2026).
 */
export function publiekViertalGeldig(v) {
  if (!v || typeof v !== 'object') return false;
  const { tab, onderwerp, status, actie } = v;
  const velden = [tab, onderwerp, status, actie];
  if (!velden.every((s) => typeof s === 'string' && s !== '' && netjes(s))) return false;
  if (!TAB_PUBLIEK.test(tab) || tab.length > MAX_TAB) return false;
  if (!STATUSSEN.includes(status) || status.length > MAX_STATUS) return false;
  if (onderwerp.length > MAX_ONDERWERP || actie.length > MAX_ACTIE) return false;
  return velden.every(publishVeilig);
}

/**
 * Projecteer één rij uit de CATALOGUS. De bronrij selecteert alleen: zijn vier vrije velden vormen
 * samen één sleutel, en wat teruggegeven wordt zijn de strings uit het catalogusbestand.
 *
 * HET VIERTAL IS ONDEELBAAR (review Codex, 26-07-2026). Een eerdere opzet hield drie losse lijsten
 * bij — goedgekeurde rollen, goedgekeurde onderwerpen, goedgekeurde acties — en had daarmee op
 * celniveau precies het recombinatiegat waarvoor de woord-allowlist was afgewezen: een goedgekeurd
 * onderwerp naast een goedgekeurde andere status is een bewering die niemand ooit heeft gelezen.
 * Nu komt een publieke rij als GEHEEL in de catalogus voor, of hij verschijnt niet.
 *
 * `datum` blijft uit de bron komen: strikt getypeerd, geen vrije tekst, en een lijst die elke
 * mogelijke datum moet bevatten is geen lijst.
 */
function projecteerUitCatalogus(rij, catalogus) {
  const publiek = catalogus.regels.get(viertalSleutel(rij));
  if (publiek === undefined) return null;
  return { ...publiek, datum: rij.datum };
}

/**
 * Reduceer de spiegel tot de publieke plaat-DTO: elke rij eerst door de vormpoort, dan door de
 * CATALOGUS, daarna de laatste vijftien die overbleven, nieuwste boven, en pas als laatste stap
 * afgekapt.
 *
 * DE OMSLAG (AUD-002, 26-07-2026). Tot deze versie was de inhoudspoort `publishVeilig`: een
 * patroonscanner. Een externe audit bood negen vormen aan die geen patroon raken — een verkort
 * thuispad, een sleutelachtige underscore-vorm, een adres zonder puntdomein, een adres met
 * hex-staart, een CamelCase-sleutelnaam, een persoonsnaam, een tijdelijk pad, een kort
 * systeemrootpad en een codenaamzin — en alle negen kwamen op de plaat, door beide schema's, langs
 * gitleaks. Patronen kúnnen dit niet dichten: onbekend is precies wat er niet naar buiten mag.
 * Daarom is publiek nu een PROJECTIE uit `data/spiegel-catalogus.json` en geen filter meer op de
 * bron. De bron levert geen bytes; hij kiest alleen welke goedgekeurde regel getoond wordt.
 *
 * Zonder geladen catalogus verschijnt er niets. Dat is de bedoeling: een plaat die publiceert
 * omdat de lijst met wat mag niet geladen kon worden, publiceert per definitie onbeoordeeld.
 *
 * ÁLLE rijen worden getoetst, niet alleen de vijftien die in beeld komen. Andersom zou de teller
 * `ingehouden: 0` melden terwijl een oudere rij nooit langs de poort is geweest — een geruststelling
 * die niets bewijst (review Codex, 26-07-2026). Nu betekent 0 wat het zegt: elke rij in het hele
 * spiegelbestand staat in de catalogus.
 *
 * De volgorde is de BRONVOLGORDE omgedraaid, niet een sortering op de datumkolom. Het bestand is
 * append-only ("nieuwste onderaan", en de kop zegt er expliciet bij dat de volgorde die van het
 * toevoegen is), dus de laatste vijftien regels zijn per afspraak de laatste vijftien meldingen;
 * een venster dat een rij met een oudere tijd aanvult, hoort niet ineens bovenaan te springen.
 */
export function toPublicKanaalpost(raw, catalogus, meldIngehouden = null) {
  const leeg = (reason, ingehouden = 0) => ({ available: false, reason, rows: [], ingehouden });
  if (!raw || raw.available !== true || !Array.isArray(raw.rows)) {
    return leeg(raw?.reason === 'LEEG' ? 'LEEG' : 'BRON_ONBEREIKBAAR');
  }
  // Fail-closed en met een eigen eindstand: "de catalogus laadde niet" is iets anders dan "er is
  // niets goedgekeurd", en de plaat moet kunnen zeggen wát er mis is. Alle rijen tellen mee als
  // ingehouden, zodat het aantal niet stilletjes nul wordt terwijl er post lag.
  if (!catalogus?.geladen) return leeg('CATALOGUS_ONBESCHIKBAAR', raw.rows.length);
  const cap = (v, max) => (v.length > max ? `${v.slice(0, max - 1).trimEnd()}…` : v);
  const veilig = [];
  const gezien = new Set();
  let ingehouden = 0;
  for (const r of raw.rows) {
    const vorm = publiekeVorm(r);
    // VERDRINGING. Het venster toont de laatste vijftien; wie hetzelfde viertal vijftien keer in de
    // bron zet, drukt daarmee alle andere meldingen van de plaat af — zonder één onbeoordeelde byte
    // te publiceren, dus de catalogus houdt dat niet tegen (bevinding review Gemini, 26-07-2026).
    // Eén viertal telt daarom één keer mee. Op de spiegel van vandaag is dit een no-op: 44 rijen,
    // 44 unieke viertallen, gemeten. Een échte herhaling van precies hetzelfde viertal is trouwens
    // ook redactioneel geen tweede melding — het is dezelfde melding, opnieuw geplakt.
    const sleutel = vorm && viertalSleutel(vorm);
    if (sleutel !== null && gezien.has(sleutel)) {
      ingehouden += 1;
      if (meldIngehouden) meldIngehouden(DATUM_UIT.test(vorm.datum) ? vorm.datum : 'onbekende datum');
      continue;
    }
    const rij = vorm && projecteerUitCatalogus(vorm, catalogus);
    // De patroonscan is sinds de omslag overbodig-door-constructie: de vier vrije velden komen uit
    // de catalogus en zijn daar bij het laden al door `publiekViertalGeldig` gegaan, en `datum` is
    // een strikte vorm. Hij blijft staan als tweede lijn — als een latere wijziging een van die
    // aannames breekt, mag dat niet meteen publicatie betekenen.
    if (!rij || ![rij.tab, rij.onderwerp, rij.status, rij.actie, rij.datum].every(publishVeilig)) {
      ingehouden += 1;
      // Wie een rij mist, moet hem kunnen vinden zonder de hele spiegel af te lopen. Maar dit is een
      // OPENBAAR bouwlogboek: er gaat alleen een datum uit, nooit de tekst waar het om gaat. Precies
      // het onbeoordeelde onderwerp in de log zetten zou het lek zijn dat deze poort moet dichten
      // (afweging bij de suggestie van Gemini, 26-07-2026). De datum is genoeg om de regel te vinden.
      if (meldIngehouden) meldIngehouden(DATUM_UIT.test(vorm?.datum ?? '') ? vorm.datum : 'onbekende datum');
      continue;
    }
    gezien.add(sleutel);
    veilig.push(rij);
  }
  // `cap` is voor de vier catalogusvelden een no-op: `publiekViertalGeldig` heeft ze bij het laden
  // al binnen dezelfde grenzen gehouden. Dat is met opzet zo — wat hier uitkomt is letterlijk de
  // goedgekeurde tekst, en niemand publiceert een halve zin met een `…` die zo nooit is gelezen.
  // De aanroep blijft staan voor `datum` en als tweede lijn.
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
