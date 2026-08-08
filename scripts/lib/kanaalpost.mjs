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

/** Hoeveel gates de cockpit toont. Los van `KANAAL_RIJEN`: zie `toPublicGates`. */
export const GATE_RIJEN = 12;

/**
 * Het venster waarbinnen naar Richard-gates wordt gezocht is de HELE spiegel, niet het staartstuk.
 * Gemeten aanleiding (01-08-2026): de vier rijen onder *Wacht op Richard* op de voorpagina waren alle
 * vier automatische controle-meldingen, en nul echte gates — niet omdat er geen gates waren, maar
 * omdat `toPublicKanaalpost` op de laatste vijftien rijen knipt en de echte gates (28-07: RAFFINADERIJ,
 * TRECHTER, PR-OPSCHONING, KEYNOTE-2) daar buiten waren geschoven. Een gate veroudert niet vanzelf; hij
 * blijft staan tot Richard hem sluit. Daarom leest deze functie álle rijen.
 */
const GATE_ACTIE = /richard/i;
/**
 * De automatische controle schrijft haar eigen alarm terug in de spiegel met actie "Richard of Fable".
 * Die rijen zijn geen gate maar zelfalarm: de plaat zou dan om aandacht vragen voor haar eigen meting.
 * Ze worden hier geteld, niet weggemoffeld — de cockpit meldt het aantal.
 */
const ZELFALARM_TAB = /^WAARNEMER$/i;

/** De gesloten statuslijst uit de kop van de spiegel zelf. Alles daarbuiten wordt ingehouden. */
export const STATUSSEN = ['AFGEROND', 'WACHT OP AKKOORD', 'GEBLOKKEERD'];

/**
 * De twee statussen die "nog niet gesloten" betekenen. Expliciet opgesomd en niet afgeleid als
 * `!== 'AFGEROND'`, zodat een vierde status die later aan `STATUSSEN` wordt toegevoegd niet stil als
 * open gate binnenkomt maar hier zichtbaar een keuze afdwingt.
 *
 * Gemeten aanleiding (bevinding Codex, 02-08-2026, middel): `toPublicGates` selecteerde alleen op de
 * actie-cel. Op de kandidaatbron leverde dat 43 rijen op, waarvan 7 met status `AFGEROND` — voltooide,
 * historische meldingen die de cockpit onder "TAKEN VOOR JOU" als actuele taak presenteerde.
 */
const OPEN_STATUSSEN = ['WACHT OP AKKOORD', 'GEBLOKKEERD'];

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
export const ONZICHTBARE_KLASSE = '[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u00AD\\u034F\\u061C\\u115F\\u1160'
  + '\\u17B4\\u17B5\\u180B-\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F'
  + '\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0]';

const ONZICHTBAAR = new RegExp(ONZICHTBARE_KLASSE, 'g');

/**
 * Dezelfde verzameling, als vraag in plaats van als schrapper — voor de schrijfkant (`spiegelwet.mjs`).
 * Bewust hier en niet daar: de eerste versie van de spiegelwet had zijn eigen, veel kortere lijstje, en
 * twee definities van "onzichtbaar" betekent dat de ene poort doorlaat wat de andere verwijdert
 * (bevinding Codex, 26-07-2026). Eén bron, twee gebruiken.
 *
 * GEEN gedeelde regex met `g`: die onthoudt `lastIndex` tussen aanroepen en geeft dan om en om
 * true en false op dezelfde invoer.
 */
const ONZICHTBAAR_EEN = new RegExp(ONZICHTBARE_KLASSE);
export const bevatOnzichtbaar = (tekst) => ONZICHTBAAR_EEN.test(String(tekst ?? ''));

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
 *
 * De backslash telt op PARITEIT, niet op aanwezigheid (review Codex + Gemini, 27-07-2026). Een
 * lookbehind `(?<!\\)\|` keek alleen naar het teken ervoor, en dan is `A \\| B` — een ge-escapete
 * backslash gevolgd door een ECHTE kolomgrens — ineens één cel. Dat schoof de rest van de rij een
 * kolom op en de rij viel om onder een reden die naar de bron wees in plaats van naar de lezer.
 *
 * DIT IS DE ENIGE UITVOERING. `lib/doorstroom.mjs` en `lib/kanaalpostbron.mjs` roepen deze functie
 * aan en houden er geen eigen kopie op na: twee lezers die het oneens zijn over waar de kolommen
 * liggen is precies de storing die deze ronde is opgespoord.
 */
export function cellenVanRegel(regel) {
  const r = String(regel ?? '').trim();
  if (!r.startsWith('|') || !r.endsWith('|')) return null;
  const binnen = r.slice(1, -1);
  const cellen = [];
  let cel = '';
  for (let i = 0; i < binnen.length; i += 1) {
    const teken = binnen[i];
    if (teken === '\\' && i + 1 < binnen.length) {
      const volgend = binnen[i + 1];
      // Een backslash escapet precies één teken. Voor `|` en `\` valt de backslash weg (dat is de
      // ontsnapping ongedaan maken); voor al het andere blijft hij staan, want dan hoort hij bij de
      // tekst — `\n` in een melding is geen regelovergang maar twee tekens.
      cel += volgend === '|' || volgend === '\\' ? volgend : `\\${volgend}`;
      i += 1;
      continue;
    }
    if (teken === '|') { cellen.push(cel); cel = ''; continue; }
    cel += teken;
  }
  cellen.push(cel);
  return cellen.map((c) => c.trim());
}

/**
 * De omkering van `cellenVanRegel`: maak tekst veilig om ALS cel in een tabelregel te zetten.
 * Backslash eerst, anders escapet de tweede stap zijn eigen ontsnappingsteken nog een keer.
 */
export const celVeilig = (tekst) => String(tekst ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

const cellenVan = cellenVanRegel;

const KOPNAMEN = ['datum-tijd', 'tab-rol', 'onderwerp', 'status', 'actie voor'];
const isKop = (c) => c.length === KOPNAMEN.length
  && c.every((cel, i) => kaal(cel).toLowerCase() === KOPNAMEN[i]);
const isScheiding = (c) => c.length > 0 && c.every((cel) => /^:?-{3,}:?$/.test(cel));

/**
 * Een markdown-codehek: drie of meer backticks of tildes, hoogstens drie spaties ingesprongen. Het
 * teken en de lengte worden bewaard, want sluiten mag alleen met hetzelfde teken en minstens
 * dezelfde lengte — dat is de markdown-regel. Blind wisselen bij elk hek was grover én verkeerd om:
 * een voorbeeldhek van drie backticks bínnen een blok van vier sloot dat blok, waarna de
 * voorbeeldtabel eronder weer echte toestand werd. Bij twijfel blijven we dus binnen het blok: te
 * lang binnen maakt een rij hoogstens AFGEKEURD, te vroeg buiten laat hem als toestand binnen.
 */
const HEK = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/**
 * Een backtick-hek met een backtick in zijn taalaanduiding is volgens markdown GÉÉN hek. Zonder die
 * eis opende ```js `foo` een blok dat er nooit was, en werd de tabel eronder AFGEKEURD terwijl hij
 * gewoon toestand is — gemeten {"sporen":["CONTROL"],"telling":2,"verworpen":1}. Dat is de veilige
 * kant (een afkeuring, geen stille toestand), maar het blijft een onterechte afkeuring, dus dicht.
 * Voor tilde-hekken geldt de eis niet: daar mag alles in de taalaanduiding staan.
 */
const hekGeldig = (hek) => hek[1][0] === '~' || !hek[2].includes('`');
/**
 * Sluiten mag bovendien alleen met een KALE hekregel: een openend hek draagt een taalaanduiding
 * (```markdown), een sluitend hek nooit. Zonder die eis sluit `````js` binnen een blok van vier
 * backticks dat blok — gemeten: {"sporen":["CONTROL","MINI"],"afgekeurd":0}, dus de voorbeeldrij
 * werd weer echte toestand (bevinding Codex op de tweede hekronde).
 */
const SLUITHEK = /^ {0,3}(?:`{3,}|~{3,})[ \t]*$/;
/**
 * Een hek mag in een lijstitem of een blockquote staan, en dan gaat er een containerteken aan vooraf:
 * `- ```markdown` of `> ```markdown`. Die tekens worden voor de hektoets weggenomen, anders werd zo'n
 * hek niet gezien en kwam de voorbeeldtabel eronder als echte toestand binnen — gemeten
 * {"sporen":["CONTROL","MINI"],"telling":2,"verworpen":0} (bevinding Codex, vijfde ronde).
 *
 * Dit is bewust GROVER dan markdown: het maakt eerder iets een hek dan minder. Dat is de veilige kant,
 * want de prijs van te veel hek is een zichtbare AFKEURING, en de prijs van te weinig hek is uitleg die
 * als toestand doorgaat. Een tabelregel begint met een `|` en wordt hier dus nooit geraakt.
 */
const hekKern = (regel) => String(regel).replace(/^[ \t]*(?:(?:>[ \t]*)+)?(?:[-*+]|\d{1,9}[.)])?[ \t]*/, '');

/**
 * DE VORMPOORT — en de reden dat de scanner hieronder niet langer alléén staat.
 *
 * Zes reviewrondes lang is dezelfde fout in dezelfde vorm teruggekomen: de scanner ziet MINDER
 * "binnen" dan markdown, en daardoor komt uitleg als echte toestand binnen. Ronde zes leverde acht
 * nieuwe gemeten gevallen op, van twee onafhankelijke reviewfamilies, waarvan vier alleen te vinden
 * waren met een échte CommonMark-lezer (markdown-it) ernaast:
 *   `<!-- x --> y <!--` op één regel · een sluithek met vier spaties ervoor · een hek in een lijstitem
 *   dat op kolom 0 gesloten wordt · `<!--` in een blockquote gevolgd door een hek · `<!--` als
 *   ingesprongen codeblok · een `<div>`-blok dat volgens markdown tot EOF loopt · een dubbel genest
 *   lijstitem · U+2028 in de taalaanduiding van een hek.
 * Elk daarvan is met de hand te dichten, en elke ronde bewijst opnieuw dat de volgende ronde er weer
 * acht vindt. Markdown namaken is de verkeerde opgave.
 *
 * Daarom deze omkering: het spiegelBESTAND moet in kanonieke vorm staan. Geen codehek, geen
 * HTML-commentaar, geen rauwe HTML, geen ingesprongen regel, geen blockquote of lijstitem, geen
 * exotische regelscheider. Staat er één zo'n constructie in, dan is het HELE bestand onleesbaar en
 * komt er GEEN OORDEEL uit — niet een gedeeltelijke lezing waarvan niemand de scope kan narekenen.
 * Zo hoeft de lezer geen markdown meer te modelleren; hij hoeft alleen te zien dat er niets in staat
 * wat scope kan maken. Alle acht bevindingen hebben minstens één van deze constructies nodig.
 *
 * Gemeten op het echte bestand (85 regels, 26-07-2026): 0 hekken, 0 commentaren, 0 rauwe HTML,
 * 0 ingesprongen regels, 0 containertekens, geen CR. De poort raakt de productie-inhoud dus niet.
 * De prijs staat er wel: schrijft iemand ooit een opsomming in dit logboek, dan valt de plaat om in
 * een zichtbare storing. Dat is de veilige kant — luide uitval boven stille uitleg-als-toestand — en
 * het is een bewuste keuze die als beslispunt in het rapport staat.
 *
 * De scanner hieronder blijft ongewijzigd staan als tweede laag: raakt deze poort ooit verzwakt, dan
 * is er nog steeds scope-afhandeling. Twee lagen die hetzelfde bedoelen, niet één die het moet halen.
 */
/**
 * Springt deze regel in? In kanonieke vorm begint iedere regel op kolom nul, dus dit is een ja/nee en
 * geen telling meer.
 *
 * ZEVENDE REVIEWRONDE (Codex, kop 726cdb7). De toets was `/^(?: {4}|\t)/` en keek dus alleen naar een
 * tab op kolom nul, terwijl markdown inspringing in KOLOMMEN telt en een tab naar het eerstvolgende
 * veelvoud van vier springt. `" \t"` is vier kolommen — een ingesprongen codeblok — maar twee tekens.
 * Gemeten met een tab achter één, twee en drie spaties, met de drie tabelregels erachter:
 *   poort PASSEERT · scanner leest 1 rij · beschikbaar true · markdown-it: 0 tabellen
 * Daarop is deze functie eerst een kolomteller geworden, met de grens op vier.
 *
 * ACHTSTE REVIEWRONDE (Codex, kop 9f92535). Die grens hield geen stand. Bij een kale `-` en de drie
 * tabelregels op onderling verschillende inspringing van nul tot drie spaties — allemaal ONDER de
 * codeblokgrens en dus toegestaan — vallen kop, scheiding en rij in verschillende containers: markdown
 * ziet geen tabel, de scanner leest de rij als echte toestand. De hele ruimte doorgemeten (448
 * gevallen, zie de proef): 102 daarvan waren gevaarlijk. Zolang inspringing überhaupt mag is die
 * klasse niet uit te putten, dus ligt de grens nu op één kolom — en daarmee is de kolomtelling zelf
 * overbodig geworden: bij een grens van één maken tabstops geen verschil meer.
 *
 * Een regel die ALLEEN uit witruimte bestaat is voor markdown een lege regel, hoeveel witruimte er ook
 * staat, en kan dus nooit een codeblok of container openen. Die telt hier niet als inspringing — anders
 * maakt één spatie op een verder lege regel het hele logboek onleesbaar zonder dat er iets te winnen is.
 */
function springtIn(regel) {
  const r = String(regel);
  if (/^[ \t]*$/.test(r)) return false; // alleen witruimte: voor markdown een lege regel
  return /^[ \t]/.test(r);
}

/**
 * Draagt deze REGEL een onopgeloste samenvoegmarkering? Losstaand en vormonafhankelijk, want de
 * vormpoort hierboven geldt alleen voor de publieke spiegel: het INTERNE `CONTROL/KANAALPOST.md`
 * opent met een HTML-commentaarkop en wordt door die poort sowieso geweigerd (GEMETEN 27-07-2026 op
 * zes opeenvolgende versies: alle zes `HTML_COMMENTAAR` op regel 1, óók de twee die echt corrupt
 * waren). Een toets die alleen ín de vormpoort leeft, kan het bestand dat corrupt raakte dus niet
 * bewaken. Daarom staat hij hier apart en is hij op elk tekstbestand te draaien.
 *
 * Alle vier de vormen die git achterlaat, inclusief `|||||||` van de diff3-stijl. MINSTENS zeven
 * tekens (bevinding Codex 27-07: `conflict-marker-size` in `.gitattributes` mag groter dan zeven
 * zijn, en dan zou een vaste zeven de markering missen) en dan witruimte of regeleinde — zes is geen
 * markering en zeven met tekst eraan vast evenmin.
 */
export const isConflictmarkering = (regel) => /^(?:<{7,}|={7,}|>{7,}|\|{7,})(?:[ \t]|$)/.test(String(regel ?? ''))
  || /^<{7,}/.test(String(regel ?? ''));

/**
 * Alleen de OPENINGS- en SLUITMARKERING.
 *
 * De opening mag ZONDER witruimte erachter (bevinding Gemini 27-07: `<<<<<<<HEAD` komt voor bij
 * handmatig bewerken en bij externe samenvoegtools; git zelf zet er een spatie tussen). Zeven punthaken
 * aan het begin van een regel zijn in geen enkele markdown of HTML iets legitiems, dus daar kost het
 * niets. Bij de SLUITING blijft de witruimte-eis wél staan, en dat is geen slordigheid: `>>>>>>>tekst`
 * is zevenvoudig geneste blokcitatie — zeldzaam, maar geldige markdown. Liever daar één vorm missen
 * dan een geldig document weigeren; de opening staat er in een echt conflict altijd bij.
 */
const isConflictAnker = (regel) => /^<{7,}/.test(String(regel ?? '')) || /^>{7,}(?:[ \t]|$)/.test(String(regel ?? ''));

/**
 * De REGELNUMMERS (1-gebaseerd) met een samenvoegmarkering. Leeg = schoon. Nooit brontekst terug.
 *
 * MET ÉÉN ANKEREIS (bevinding Codex 27-07, en hij heeft gelijk): `=======` op zichzelf is géén bewijs
 * van een conflict — het is ook de onderstreping van een setext-kop, en `|||||||` lijkt op een lege
 * tabelregel. Zonder anker zou een geldig document geweigerd worden en dan blokkeert de poort de hele
 * spiegel om niets. Een `=`- of `|`-markering telt daarom alleen mee als er in hetzelfde document ook
 * een `<<<<<<<` of `>>>>>>>` staat. Git laat die altijd achter — de gemeten corruptie had alle drie.
 */
export function conflictmarkeringen(tekst) {
  const regels = String(tekst ?? '').split(/\r\n|\r|\n/);
  const heeftAnker = regels.some(isConflictAnker);
  return regels
    .map((r, i) => ((heeftAnker ? isConflictmarkering(r) : isConflictAnker(r)) ? i + 1 : 0))
    .filter((n) => n > 0);
}

const KANONIEK_VERBODEN = Object.freeze([
  // Een onopgeloste samenvoeging. GEMETEN geval (27-07-2026): `CONTROL/KANAALPOST.md` op de
  // rapporten-tak droeg twee keer op één ochtend een `<<<<<<< HEAD` / `=======` / `>>>>>>> <sha>`
  // blok — één keer 5 minuten, één keer minder dan één minuut — en werd beide keren gewoon
  // gepubliceerd. Deze regel staat BEWUST vóór `RAUWE_HTML` en `CONTAINER`: die twee weigerden de
  // openings- en sluitmarkering al, maar onder een reden die naar het verkeerde ding wijst, en de
  // middelste markering (`=======`) glipte er langs. Een poort die weigert maar de verkeerde naam
  // noemt, stuurt de zoeker weg van de corruptie. De reden hoort de vondst te zijn.
  // (de toets zelf staat documentbreed in `kanoniekeSpiegelvorm` — hij heeft het hele document nodig)
  // Een codehek waar dan ook op de regel. Bewust grover dan markdown: `HEK` eist hoogstens drie
  // spaties inspringing, hier is elk voorkomen genoeg. Vangt Gemini B, Codex 1/4/5/6.
  { reden: 'CODEHEK', test: (r) => /(`{3,}|~{3,})/.test(r) },
  // Beide helften van een HTML-commentaar, ook los. Vangt Gemini A/C/D, Codex 2/3/7.
  { reden: 'HTML_COMMENTAAR', test: (r) => r.includes('<!--') || r.includes('-->') },
  // Een regel die met een tag begint: markdown houdt zo'n blok open tot een lege regel of EOF, en
  // alles ertussen is geen tabel. Vangt Codex 4 ook zonder hek.
  { reden: 'RAUWE_HTML', test: (r) => /^ {0,3}</.test(r) },
  // ELKE inspringing, niet pas vier kolommen — zie `springtIn` voor de meting die dat afdwong.
  // Een regel die alleen uit witruimte bestaat blijft een lege regel.
  { reden: 'INSPRINGING', test: springtIn },
  // Blockquote of lijstitem: containers verplaatsen de kolom waarop alles telt. Ook een markering
  // die ALLEEN op de regel staat opent een lijstitem — die had geen spatie erachter en glipte
  // daarmee langs de vorige versie (Codex, achtste ronde).
  { reden: 'CONTAINER', test: (r) => /^(?:>|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/.test(r) },
  // U+2028/U+2029 en de form feed zijn regelscheiders voor sommige lezers en gewone tekens voor
  // andere. Twee lezers die het over de regelindeling oneens zijn is precies wat hier niet mag.
  { reden: 'REGELSCHEIDER', test: (r) => /[\u2028\u2029\f\v]/.test(r) },
  // NEGENDE RONDE (Codex), aangescherpt in de TIENDE. Elke andere witruimte dan spatie en tab. De
  // scanner knipt cellen met JavaScripts `trim()`, en die neemt méér weg dan markdown witruimte
  // noemt: markdown kent alleen spatie, tab en de regeleindes. Zet zo'n teken vóór de
  // SCHEIDINGSREGEL en markdown ziet geen scheidingsregel meer, dus geen tabel — terwijl de scanner
  // de rij eronder gewoon leest. Dat is de gevaarlijke kant.
  // De klasse is AFGELEID en niet opgesomd (Codex wees er terecht op dat een opsomming achterloopt):
  // elk codepunt dat `trim()` wegneemt en geen spatie of tab is — 23 stuks, 19 daarvan binnen één
  // regel. GEMETEN over alle 19 maal drie plaatsen = 57 gevallen, met markdown-it ernaast in beide
  // presets (tabellen expliciet aan). De uitkomst hangt af van de IMPLEMENTATIE, en dat is zelf een
  // bevinding (dertiende ronde): markdown-it-py telt 20 gevallen waarin de scanner MEER rijen leest
  // dan markdown ziet, markdown-it JS telt er 19; ze verschillen over U+FEFF op de kopregel. In
  // beide geldt: alle 19 tekens voor de scheidingsregel zijn gevaarlijk, nergens ziet de scanner
  // minder, en de poort weigert alle 57. Dat twee lezers het oneens zijn over "wat markdown ziet"
  // is de reden dat hier geen parser wordt nagebootst maar kanonieke vorm wordt geeist.
  // De diepere oorzaak is de asymmetrie tussen `trim()` en markdown; die wordt hier bij de bron
  // afgesloten in plaats van de gedeelde scanner te veranderen (twee lagen, zie de kop hierboven).
  { reden: 'VREEMDE_WITRUIMTE', test: (r) => /[^\S \t]/u.test(r) },
]);

/**
 * Staat dit bestand in kanonieke spiegelvorm? `{ ok: true }` of `{ ok: false, reden, regel }`.
 * `reden` komt uit een bevroren lijst en `regel` is een REGELNUMMER — geen brontekst, want de uitkomst
 * hiervan kan op de publieke plaat belanden.
 */
export function kanoniekeSpiegelvorm(tekst) {
  const regels = String(tekst ?? '').split(/\r\n|\r|\n/);
  // BEWUST als eerste, vóór `RAUWE_HTML` en `CONTAINER`: die twee weigerden de openings- en
  // sluitmarkering al, maar onder een reden die naar het verkeerde ding wijst. De reden hoort de
  // vondst te zijn. Documentbreed en niet per regel, want `=======` is pas een markering als er ook
  // een anker in hetzelfde document staat.
  const conflict = conflictmarkeringen(tekst);
  if (conflict.length > 0) return { ok: false, reden: 'CONFLICTMARKERING', regel: conflict[0] };
  for (let i = 0; i < regels.length; i += 1) {
    for (const v of KANONIEK_VERBODEN) {
      if (v.test(regels[i])) return { ok: false, reden: v.reden, regel: i + 1 };
    }
  }
  return { ok: true, reden: null, regel: 0 };
}

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
  return spiegelScan(tekst).kandidaten.filter(Boolean);
}

/**
 * Dezelfde lezing, maar mét de afgekeurde rijen op hun plek.
 *
 * `spiegelUitTekst` gooit een rij die de vormtoets niet haalt weg, en dat is voor de publicatiekant
 * precies goed: die rij hoort niet naar buiten. Voor een TELLENDE lezer is het een gat — een rij die
 * stil verdwijnt schuift bovendien elke positie erna op, zodat de zoveelste rij ineens iets anders
 * aanwijst. `kandidaten` houdt de bronvolgorde intact en zet `null` waar de vormtoets afketste, zodat
 * een lezer zowel kan tellen als kan zien dát er iets is afgekeurd.
 */
/**
 * "Ziet eruit als een spiegelrij": vijf kolommen, geen kop, geen scheidingsregel. Bewust vormvrij —
 * of de rij ook geldig is beslist `rijUitCellen`. Deze toets bepaalt alleen of het wegvallen van een
 * regel geteld moet worden, en dat is de vraag die op drie plekken terugkomt.
 */
function lijktSpiegelrij(regel) {
  const c = cellenVan(regel);
  return Boolean(c && c.length === KOPNAMEN.length && !isKop(c) && !isScheiding(c));
}

export function spiegelScan(tekst) {
  // Markdown kent drie regeleindes: LF, CRLF en een losse CR. Splitsen op alleen `\n` liet bij een
  // CRLF-bestand een `\r` aan elke regel plakken, en dat brak twee dingen tegelijk: `.` in een regex
  // slaat `\r` als regeleinde over, dus een openend hek werd niet meer herkend, en een sluithek was
  // niet meer kaal. Gemeten op een CRLF-versie van hetzelfde bestand:
  // {"sporen":["CHIEF","CONTROL","MINI"],"telling":3,"verworpen":0} — de voorbeeldrij MÍDDEN in het
  // codeblok kwam als echte toestand binnen (bevinding Codex, vijfde ronde).
  const regels = String(tekst ?? '').split(/\r\n|\r|\n/);
  const kandidaten = [];
  let inTabel = false;
  let inCommentaar = false;
  let hekOpen = null;
  for (let i = 0; i < regels.length; i += 1) {
    // De regel als LOSSE waarde, want een commentaar kan middenin sluiten en dan telt de staart erna
    // gewoon weer mee. Zie de commentaartak hieronder.
    let regel = regels[i];
    // HTML-commentaar is GEEN gegeven. Zonder deze scope werd een volledige tabel tussen `<!--` en
    // `-->` gewoon meegelezen: de commentaaropener sloot de tabel, maar de exacte kop op de regel
    // erna opende hem weer. Gemeten: een verborgen MINI-rij kwam als echt spoor in de toestand en de
    // uitkomst was GROEN. Uitgecommentarieerde tekst die als waarheid wordt gelezen is de omgekeerde
    // fout van een rij die stil verdwijnt, en even erg.
    if (inCommentaar) {
      const dicht = regel.indexOf('-->');
      if (dicht === -1) {
        inTabel = false;
        // Symmetrisch met het codehek: verstoppen kost zichtbaarheid. Een rij tussen `<!--` en `-->`
        // verdween hiervoor spoorloos — gemeten {"sporen":["CONTROL"],"telling":1,"verworpen":0},
        // terwijl de naam van proef 20 al beloofde dat zoiets geteld of afgekeurd wordt.
        if (lijktSpiegelrij(regel)) kandidaten.push(null);
        continue;
      }
      inCommentaar = false;
      // Alles ná `-->` staat buiten het commentaar en telt weer mee. Met een kale `continue` werd
      // `--> ``` ` een regel zonder gevolg: het hek opende nooit en de voorbeeldtabel eronder kwam
      // als echte toestand binnen — gemeten {"sporen":["CONTROL"],"telling":1,"verworpen":0}.
      regel = regel.slice(dicht + 3);
      inTabel = false;
    }
    // Een markdown-codehek is de tweede vorm van "dit is geen gegeven", en hij ontbrak. Gemeten op kop
    // 9f413d8: een voorbeeldtabel in een ```-blok — kop, scheiding, één MINI-rij — leverde
    // `{"sporen":["CONTROL","MINI"],"telling":2,"verworpen":0}`. Een rij die in de uitleg staat als
    // vóórbeeld werd dus gemeten toestand, met nul afkeuringen. De pagina zou dat niet vangen: die
    // wordt door dezelfde lezer gebouwd, dus beide kanten zijn het eens en de uitkomst is GROEN.
    // De naam van de bestaande toets (`… of codeblok telt niet mee`) beloofde dit al; alleen het
    // commentaargeval stond erin.
    // Sluiten mag alleen met hetzelfde teken en minstens dezelfde lengte. Gemeten op kop f0fca13
    // met een blok van vier backticks waarin een voorbeeld van drie stond: het binnenste hek sloot
    // het buitenste, en de MINI-rij in dat voorbeeld kwam als `{"kandidaten":[CONTROL,MINI],
    // "afgekeurd":0}` terug — echte toestand, nul afkeuringen. Een hek dat niet sluit is nu gewoon
    // inhoud van het blok.
    const hek0 = HEK.exec(hekKern(regel));
    const hek = hek0 && hekGeldig(hek0) ? hek0 : null;
    if (hek && hekOpen === null) {
      hekOpen = hek[1];
      inTabel = false;
      continue;
    }
    const sluit = hek && hekOpen !== null && SLUITHEK.test(hekKern(regel))
      && hek[1][0] === hekOpen[0] && hek[1].length >= hekOpen.length;
    if (sluit) {
      hekOpen = null;
      inTabel = false;
      continue;
    }
    // Binnen het hek opent geen kop een tabel — maar een regel die eruitziet als een spiegelrij wordt
    // wél als AFGEKEURD geteld en niet stil overgeslagen. Anders is het hek zelf een verstopplaats:
    // drie backticks om bestaande rijen zetten zou ze spoorloos laten verdwijnen, en dat is dezelfde
    // fout in spiegelbeeld. Zo kost verstoppen zichtbaarheid in plaats van dat het hem oplevert.
    if (hekOpen !== null) {
      inTabel = false;
      if (lijktSpiegelrij(regel)) kandidaten.push(null);
      continue;
    }
    // Een `<!--` BINNEN een tabelcel opent geen commentaar. Deed hij dat wel, dan brak één rij met die
    // vier tekens in zijn tekst niet alleen zichzelf maar alles eronder af, en beide verdwenen stil —
    // gemeten met drie rijen: {"sporen":["CONTROL"],"telling":1,"verworpen":0}. Een regel die een
    // volwaardige spiegelrij ís, wordt daarom als spiegelrij behandeld en niet als opmaak.
    if (regel.includes('<!--') && !regel.includes('-->') && !lijktSpiegelrij(regel)) {
      inCommentaar = true;
      inTabel = false;
      continue;
    }
    const c = cellenVan(regel);
    // Elke niet-tabelregel — lege regel, kop, proza — sluit de lopende tabel.
    if (!c) { inTabel = false; continue; }
    if (isKop(c)) {
      const volgende = cellenVan(regels[i + 1]);
      inTabel = Boolean(volgende && volgende.length === KOPNAMEN.length && isScheiding(volgende));
      // De scheidingsregel hoort bij de kop en wordt hier opgegeten. Daardoor is élke látere
      // scheidingsregel het begin van een andere tabel — ook zonder lege regel ertussen.
      if (inTabel) i += 1;
      continue;
    }
    // Buiten een tabel telt een regel die er precies uitziet als een SPIEGELRIJ — vijf kolommen, geen
    // kop, geen scheiding — als afkeuring en niet als niets. Reden: een lege regel of een prozaregel
    // sloot de tabel, en elke rij daarna verdween spoorloos. Gemeten: kop, één CONTROL-rij, een lege
    // regel, een MINI-rij → `eventCount: 1`, `verworpenRijen: 0`, uitkomst GROEN. Dezelfde stille
    // verdwijning als bij een kapotte rij, alleen met de lege regel als oorzaak.
    // Andere tabellen blijven buiten beeld doordat de toets op EXACT vijf kolommen staat: de
    // kolom-uitleg bovenaan het bestand heeft er twee en raakt hierdoor niets.
    if (!inTabel) {
      if (c.length === KOPNAMEN.length && !isScheiding(c)) kandidaten.push(null);
      continue;
    }
    // Een tweede scheidingsregel is het begin van een andere tabel: sluiten, niet raden.
    if (isScheiding(c)) { inTabel = false; continue; }
    // Een afwijkend kolomaantal sloot hier eerst óók de tabel, en dat was een stille verdwijning van
    // de ergste soort: gemeten met een geldige rij, een rij met twee kolommen en dan weer een geldige
    // rij bleef er één kandidaat over, nul afkeuringen, `eventCount: 1` en de uitkomst GROEN. Niet
    // alleen de kapotte rij verdween, alles eráchter verdween mee — precies de vorm waarin ooit 41 van
    // de 54 regels wegvielen. Een regel die nog steeds een tabelregel ís hoort een AFGEKEURDE rij te
    // zijn die zijn plaats houdt; alleen een regel die geen tabelregel meer is sluit de tabel.
    if (c.length !== KOPNAMEN.length) { kandidaten.push(null); continue; }
    kandidaten.push(rijUitCellen(c));
  }
  return { kandidaten, afgekeurd: kandidaten.filter((r) => r === null).length };
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
 * daarna de laatste vijftien die overbleven, nieuwste boven. Afkappen gebeurt sinds de spiegelwet de
 * publieke rijen telt in `veiligePubliekeRijen`, dus vóór het knippen op vijftien in plaats van erna;
 * dat verandert de uitkomst niet (`slice` telt posities, geen tekens) en houdt één definitie van "de
 * publieke rij" over voor beide gebruikers.
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
const cap = (v, max) => (v.length > max ? `${v.slice(0, max - 1).trimEnd()}…` : v);

/**
 * Botsing tussen twee eigen poorten, opgelost zonder een van beide te verzwakken (Codex-review,
 * 29-07-2026): de spiegelwet eist de VOLLE 40-teken git-SHA in de bron (geen ellipsis-afkapping,
 * op één grandfathered regel na — zie spiegelwet.test.mjs), maar diezelfde 40 hex-tekens matchen
 * ook het HIGH_ENTROPY-restpatroon in sanitize.mjs en worden dan als mogelijk geheim ingehouden.
 *
 * Geen generieke "elke lowercase-hex-40 is een SHA"-regex: een raw hex-secret heeft dezelfde vorm
 * en zou zo ongemerkt langs de poort glippen — precies de bescherming die 26-07-2026 bewust werd
 * verwijderd. In plaats daarvan een allowlist van SHA's die met de hand zijn nagekeken en die al
 * elders in dezelfde bron in hun korte vorm voorkomen (bv. "sha `49a20e4`"). Alleen die worden
 * verkort tot de gangbare git-vorm; elke andere 40-tekenreeks blijft onaangeroerd en dus ingehouden.
 */
const PUBLIEKE_GIT_SHA1 = new Set([
  'b694235cae13d681d485040b9c3309a239b225ec', // RAFFINADERIJ 2026-07-27 08:16/09:53 (regels 90, 93)
]);
const shaVerkort = (v) =>
  v.replace(/\b[0-9a-f]{40}\b/g, (m) => (PUBLIEKE_GIT_SHA1.has(m) ? `${m.slice(0, 7)}…` : m));

/**
 * Alle rijen die de publieke kant HERKENT, in bronvolgorde en zonder de limiet van vijftien: elke rij
 * door vorm- en publicatiepoort, daarna afgekapt zoals hij op de plaat komt te staan.
 *
 * Apart van `toPublicKanaalpost`, en dat is de hele reden dat deze functie bestaat. De spiegelwet moet
 * kunnen tellen wat de LEZER ziet, niet wat er in de brontekst staat, en zij mag daarbij niet op de
 * laatste vijftien knippen — dan zou een rij die door normale veroudering uit beeld schuift als
 * "verdwenen" gelden en de poort permanent rood staan.
 */
function veiligePubliekeRijen(raw) {
  const veilig = [];
  let ingehouden = 0;
  for (const r of raw.rows) {
    const rij = publiekeVorm(r);
    if (rij) rij.onderwerp = shaVerkort(rij.onderwerp);
    if (!rij || ![rij.tab, rij.onderwerp, rij.status, rij.actie, rij.datum].every(publishVeilig)) {
      ingehouden += 1;
      continue;
    }
    veilig.push({
      tab: cap(rij.tab, MAX_TAB),
      onderwerp: cap(rij.onderwerp, MAX_ONDERWERP),
      status: cap(rij.status, MAX_STATUS),
      actie: cap(rij.actie, MAX_ACTIE),
      datum: cap(rij.datum, MAX_DATUM),
    });
  }
  return { veilig, ingehouden };
}

/**
 * De publieke rijen van een spiegelBESTAND, in bronvolgorde, ongelimiteerd. Dit is de vorm waarop de
 * spiegelwet zijn oordeel baseert (zie `publiekeAfwijkingen` in `spiegelwet.mjs`).
 *
 * Waarom dit er is, met het tegenvoorbeeld erbij (bevinding Codex, 26-07-2026, hoog): de wet telde
 * letterlijke brontekstregels. Zet iemand één LEGE regel vóór een bestaande rij, dan is er geen enkele
 * regel verdwenen — en toch sluit die lege regel de tabel, waarna alles eronder niet meer gepubliceerd
 * wordt. Andersom kan een rij die textueel verschilt (dubbele spatie, andere celopvulling) na
 * normalisatie dezelfde publieke rij worden, en dan staat die rij twee keer op de plaat terwijl de
 * duplicatentelling op brontekst niets ziet. Beide gaten sluiten alleen door te tellen wat hier
 * uitkomt.
 */
export function publiekeRijenUitTekst(tekst) {
  const raw = kanaalpostUitTekst(tekst);
  if (raw.available !== true || !Array.isArray(raw.rows)) return { rijen: [], ingehouden: 0 };
  const { veilig, ingehouden } = veiligePubliekeRijen(raw);
  return { rijen: veilig, ingehouden };
}

export function toPublicKanaalpost(raw) {
  const leeg = (reason, ingehouden = 0) => ({ available: false, reason, rows: [], ingehouden });
  if (!raw || raw.available !== true || !Array.isArray(raw.rows)) {
    return leeg(raw?.reason === 'LEEG' ? 'LEEG' : 'BRON_ONBEREIKBAAR');
  }
  const { veilig, ingehouden } = veiligePubliekeRijen(raw);
  // Afkappen gebeurt in `veiligePubliekeRijen`, vóór het knippen op vijftien. Dat verandert niets aan
  // de selectie — `slice` telt posities, geen tekens — en houdt één definitie van "de publieke rij".
  const rows = veilig.slice(-KANAAL_RIJEN).reverse();
  if (!rows.length) return leeg(ingehouden ? 'INGEHOUDEN' : 'LEEG', ingehouden);
  return { available: true, reason: null, rows, ingehouden };
}

/**
 * GATES — de rijen uit de spiegel die Richard als actiehouder noemen, over de HELE spiegel en niet
 * over het venster van vijftien. Zelfde sanitize- en publicatiepoort als `toPublicKanaalpost`
 * (`veiligePubliekeRijen`), zodat hier geen tweede publicatie-oppervlak ontstaat: wat de gates-lijst
 * kan tonen, kan de kanaalpost-sectie ook tonen.
 *
 * `zelfalarm` telt de rijen die wél Richard noemen maar van de automatische controle komen. Die staan
 * bewust niet in `rows`; het getal blijft zichtbaar zodat "0 gates" niet kan betekenen "wel meldingen,
 * maar allemaal verstopt".
 *
 * `totaal` is het aantal echte gates vóór het knippen op `max`, zodat de plaat kan tonen dat er meer
 * zijn dan er passen.
 *
 * OPEN, niet alleen genoemd. Een rij telt pas als gate wanneer haar status in `OPEN_STATUSSEN` staat.
 * `AFGEROND` is een eindstatus: die melding is klaar en hoort niet onder "TAKEN VOOR JOU". Dit is een
 * mechanische toets op een gesloten statuslijst, geen tekstheuristiek — precies daarom mag hij hier
 * wél filteren waar de actie-cel dat niet mag.
 *
 * EERLIJKE GRENS, tweemaal. (1) De selectie is verder één patroon op de actie-cel: een rij die
 * "Richard: geen actie" schrijft telt hier mee als gate. Dat is bewust — de andere kant op filteren
 * betekent intentie raden uit vrije tekst, en dan verdwijnt er stil een echte gate. Die grens
 * verdwijnt pas met een expliciet gate-veld in de bron, niet met een nieuwe heuristiek. (2) Twee
 * identieke meldingen in de spiegel zijn hier twee gates; deze functie ontdubbelt niet.
 */
export function toPublicGates(raw, { max = GATE_RIJEN } = {}) {
  const leeg = (reason) => ({ available: false, reason, rows: [], totaal: 0, zelfalarm: 0 });
  if (!raw || raw.available !== true || !Array.isArray(raw.rows)) {
    return leeg(raw?.reason === 'LEEG' ? 'LEEG' : 'BRON_ONBEREIKBAAR');
  }
  const { veilig } = veiligePubliekeRijen(raw);
  // Geen enkele leesbare rij is iets anders dan "wel rijen, geen gate": in het eerste geval is er niets
  // gemeten en mag de plaat geen geruststelling tonen. Vandaar twee verschillende eindstanden.
  if (!veilig.length) return leeg(raw.rows.length ? 'INGEHOUDEN' : 'LEEG');
  const open = veilig.filter((r) => OPEN_STATUSSEN.includes(r.status));
  const genoemd = open.filter((r) => GATE_ACTIE.test(r.actie));
  const zelfalarm = genoemd.filter((r) => ZELFALARM_TAB.test(r.tab)).length;
  const echt = genoemd.filter((r) => !ZELFALARM_TAB.test(r.tab));
  const rows = echt.slice(-Math.max(1, Math.trunc(max))).reverse();
  if (!rows.length) return { available: true, reason: 'GEEN_GATE', rows: [], totaal: 0, zelfalarm };
  return { available: true, reason: null, rows, totaal: echt.length, zelfalarm };
}

/**
 * Lees de spiegel uit tekst naar de collector-vorm. Gescheiden van het lezen van het BESTAND, zodat
 * de vorm-eisen zonder schijf getest kunnen worden.
 */
export function kanaalpostUitTekst(tekst) {
  if (typeof tekst !== 'string' || tekst.trim() === '') {
    return { available: false, reason: 'BRON_ONBEREIKBAAR', rows: [] };
  }
  // De vormpoort staat vóór de scanner, niet erin. Een bestand dat scope kan maken wordt in zijn
  // geheel geweigerd; er komt dan geen gedeeltelijke lezing uit waarvan de scope niet na te rekenen
  // is. Zie `kanoniekeSpiegelvorm` voor de acht gemeten gevallen die hiertoe leidden.
  const vorm = kanoniekeSpiegelvorm(tekst);
  if (!vorm.ok) return { available: false, reason: 'NIET_CANONIEK', vorm, rows: [] };
  const rows = spiegelUitTekst(tekst);
  if (!rows.length) return { available: false, reason: 'LEEG', rows: [] };
  return { available: true, reason: null, rows };
}
