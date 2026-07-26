/**
 * SPIEGEL-CATALOGUS — de gesloten lijst van wat de publieke plaat mag zeggen.
 *
 * WAAROM DIT BESTAAT. De kanaalpost publiceerde tot nu toe vrije tekst uit
 * `data/kanaalpost-publiek.md` en hield die alleen tegen als een patroon aansloeg
 * (`publishVeilig`, fail-on-known-pattern). Een externe audit (AUD-002, 26-07-2026) bood negen
 * vormen aan die geen enkel patroon raken — een verkort thuispad, een sleutelachtige
 * underscore-vorm, een adres zonder puntdomein, een adres met hex-staart, een CamelCase-sleutelnaam,
 * een persoonsnaam, een tijdelijk pad, een kort systeemrootpad en een codenaamzin — en alle negen
 * stonden daarna in de HTML, in beide schema's, en gitleaks bleef groen. Dat is geen lek in één
 * stap: de hele toegestane route accepteert die vormen. Zelf nagemeten op `3a72950`: 14 gevallen,
 * 2 door, 12 rood. Codex heeft de negen in dezelfde checkout opnieuw door `publishVeilig()` gehaald
 * en kreeg negen keer `true` terug.
 *
 * Een patroonlijst kán dit niet dichten. Een codenaam of een persoonsnaam die nergens in een
 * patroon voorkomt is per definitie onbekend, en onbekend is precies wat er niet naar buiten mag.
 *
 * DE OMSLAG. Publiek is voortaan een PROJECTIE, geen filter. De bronrij selecteert alleen nog; de
 * gepubliceerde tekst komt uit dit bestand. Staat een rij er niet in, dan verschijnt hij niet — en
 * hij wordt geteld, zodat hij niet stil verdwijnt. Wat er ná de beoordeling nog aan de bron
 * verandert, kan de uitvoer niet meer veranderen: de bron levert geen bytes meer.
 *
 * HELE RIJEN, GEEN LOSSE VELDEN (review Codex, 26-07-2026). Een eerste opzet hield drie gesloten
 * lijsten bij: goedgekeurde rollen, goedgekeurde onderwerpen, goedgekeurde acties. Dat had op
 * celniveau precies het recombinatiegat waarom de woord-allowlist was afgewezen — een goedgekeurd
 * onderwerp naast een goedgekeurde andere status vormt een bewering die niemand ooit heeft gelezen.
 * Een catalogusregel is daarom een VIERTAL (`tab`, `onderwerp`, `status`, `actie`) dat als geheel is
 * beoordeeld. De invariant is daarmee controleerbaar in één zin: iedere publieke rij staat, in zijn
 * geheel, in dit bestand.
 *
 * `datum` hoort niet in de catalogus. Dat veld is strikt getypeerd, draagt geen bewering, en een
 * lijst die elke mogelijke datum moet bevatten is geen lijst.
 *
 * TWEE KANTEN PER REGEL:
 *  - `bron`   — het viertal zoals de PARSER het uit de spiegel haalt. Dit is alleen een sleutel;
 *               er wordt niets van gepubliceerd.
 *  - `publiek`— het viertal dat de plaat toont. Weglaten mag als het gelijk is aan `bron`; dat is
 *               het gewone geval. Het bestaat voor de rijen waarvan de bronzin langer is dan de
 *               plaat toelaat: dan staat hier de ingekorte zin die als zodanig is goedgekeurd, in
 *               plaats van een `slice()` die midden in een woord — of midden in een teken — knipt.
 *
 * CANONIEKE SCHRIJFKANT, NORMALISERENDE LEESKANT (besluit Fable, 26-07-2026). Elke waarde in dit
 * bestand moet al in de vorm staan die de parser oplevert: `kaal(waarde) === waarde`. Niet alleen
 * `ontdaan` — `kaal` haalt ook backticks en sterretjes weg, en een catalogusregel mét die tekens zou
 * wél laden maar nooit matchen, waarna een goedgekeurde rij stil werd ingehouden (bevinding Gemini,
 * 26-07-2026). Vergelijken gebeurt op de genormaliseerde bron, zodat een rij met een zero-width
 * space of een breedbeeld-letter erin dezelfde regel selecteert.
 *
 * DE CATALOGUS BEWAAKT ZICHZELF. Elke `publiek`-waarde gaat bij het laden door
 * `publiekViertalGeldig` — dezelfde eisen die de DTO stelt, inclusief `publishVeilig` en de
 * lengtegrenzen. De patroonscanner is daarmee verhuisd van de live uitvoer naar de catalogus: hij is
 * geen poort meer maar een tweede paar ogen op een lijst die toch al met de hand wordt beoordeeld.
 *
 * ÉÉN FOUTE REGEL BEDERFT DE HELE CATALOGUS. Er wordt niet gefilterd (review Codex, 26-07-2026):
 * een catalogus waaruit stilletjes regels vallen is een catalogus waarvan niemand meer weet wat hij
 * bevat. Ontbrekend, onleesbaar, onbekende sleutel, verkeerd type, niet-canoniek, te lang, dubbel,
 * of een patroon in een publieke waarde → `geladen: false`, en dan publiceert `toPublicKanaalpost`
 * niets én breekt de bouw af, zodat de laatste goede Pages-versie blijft staan.
 *
 * DE TRUST BOUNDARY, expliciet (Codex, punt 1). De echte beveiligingspoort is de menselijke review
 * van DIT bestand. `publishVeilig` houdt hier niets tegen wat het ook in de oude opzet niet
 * tegenhield — alle negen auditvormen komen er ook hier doorheen als iemand ze erin zet. De winst
 * is niet dat publiceren onmogelijk wordt, maar dat het een bewuste toevoeging vereist aan een
 * bestand waarvan het enige doel "dit mag naar buiten" is, en dat een wijziging aan de bron ná de
 * beoordeling de uitvoer niet meer kan veranderen.
 *
 * WAT DIT ONTWERP NIET DOET (Codex, punt 5). De bron staat in dezelfde OPENBARE repo. Een slechte
 * bronrij is dus al openbaar via GitHub en de git-geschiedenis, ook als de plaat hem inhoudt. Dit
 * beschermt de projectie, niet de vertrouwelijkheid van de repository; wat werkelijk nergens
 * openbaar mag worden, moet vóór de push tegengehouden worden of buiten deze repo blijven.
 */

import { readFileSync } from 'node:fs';

import {
  STATUSSEN, kaal, publiekViertalGeldig, viertalSleutel,
} from './kanaalpost.mjs';

const CATALOGUS_PAD = new URL('../../data/spiegel-catalogus.json', import.meta.url);

/** Het enige formaat dat deze lezer kent. Een ander nummer is geen catalogus voor hém. */
const VERSIE = 1;

/**
 * Ondergrens. Geen "het juiste aantal" maar een instortdetector: een catalogus die tot bijna niets
 * is teruggevallen is geen catalogus meer, en dan is fail-closed beter dan een plaat die nog net één
 * zin toont. De spiegel is append-only en telt er nu 44, dus deze grens staat er ruim onder.
 */
const MIN_REGELS = 20;

/** Bovengrens. Een catalogus van duizenden regels is geen met de hand beoordeelde lijst meer. */
const MAX_REGELS = 2000;

/** Bovengrens op één bronwaarde. De bronkant kent geen plaatgrens, maar wel een bodemloze put. */
const MAX_BRON_LENGTE = 4000;

const VELDEN = ['tab', 'onderwerp', 'status', 'actie'];

const mislukt = (reden) => ({ geladen: false, reden, regels: new Map() });

/** Precies deze sleutels, niet meer en niet minder. Een onbekende sleutel is een niet-gelezen veld. */
function sleutelsExact(obj, toegestaan) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const eigen = Object.keys(obj);
  return eigen.length === toegestaan.length && toegestaan.every((k) => eigen.includes(k));
}

/**
 * De BRON-kant van een regel: alleen een sleutel, dus geen lengtegrens van de plaat en geen
 * patroonscan — die waarden worden nooit uitgegeven. Wel canoniek (anders matcht hij nooit) en wel
 * een status uit de gesloten lijst (een andere status kan per definitie geen geldige rij zijn, dus
 * zo'n regel is dode ballast en een teken dat de catalogus niet is bijgehouden).
 */
function bronGeldig(v) {
  if (!sleutelsExact(v, VELDEN)) return false;
  return VELDEN.every((k) => {
    const s = v[k];
    return typeof s === 'string' && s !== '' && s.length <= MAX_BRON_LENGTE && kaal(s) === s;
  }) && STATUSSEN.includes(v.status);
}

/**
 * Laad de catalogus. Zonder argument het meegeleverde bestand; met een pad voor tests, zodat de
 * testgevallen niet in de productielijst hoeven te staan.
 *
 * LET OP DE VOLGORDE (review Codex, 26-07-2026): `publishVeilig` leunt op de deny-termen die
 * `loadDenyTerms` in modulestaat zet. Roep deze functie dus pas aan NADAT die geladen zijn, anders
 * keurt de catalogus zichzelf met een lege termenlijst. `scripts/build.mjs` doet dat in die volgorde
 * en geeft het resultaat als expliciet argument door — niet via een impliciete importvolgorde.
 */
export function laadSpiegelCatalogus(pad = CATALOGUS_PAD) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(pad, 'utf8'));
  } catch {
    return mislukt('CATALOGUS_ONLEESBAAR');
  }
  if (!sleutelsExact(raw, ['versie', 'regels'])) return mislukt('CATALOGUS_ONGELDIG');
  if (raw.versie !== VERSIE) return mislukt('CATALOGUS_VERSIE_ONBEKEND');
  if (!Array.isArray(raw.regels)) return mislukt('CATALOGUS_ONGELDIG');
  if (raw.regels.length < MIN_REGELS || raw.regels.length > MAX_REGELS) {
    return mislukt('CATALOGUS_ONGELDIG');
  }

  const regels = new Map();
  for (const regel of raw.regels) {
    if (!sleutelsExact(regel, ['bron']) && !sleutelsExact(regel, ['bron', 'publiek'])) {
      return mislukt('CATALOGUS_ONGELDIG');
    }
    if (!bronGeldig(regel.bron)) return mislukt('CATALOGUS_ONGELDIG');
    // Weglaten mag: dan is de goedgekeurde publieke tekst de brontekst zelf. Dat is het gewone
    // geval, en het scheelt de beoordelaar een bestand met alles er twee keer in.
    const publiek = regel.publiek ?? regel.bron;
    if (!sleutelsExact(publiek, VELDEN) || !publiekViertalGeldig(publiek)) {
      return mislukt('CATALOGUS_ONGELDIG');
    }
    const sleutel = viertalSleutel(regel.bron);
    // Twee regels met dezelfde sleutel: welke van de twee gepubliceerd wordt hangt dan van de
    // volgorde in het bestand af. Dat is geen keuze die je impliciet wilt maken.
    if (regels.has(sleutel)) return mislukt('CATALOGUS_ONGELDIG');
    regels.set(sleutel, Object.freeze({
      tab: publiek.tab, onderwerp: publiek.onderwerp, status: publiek.status, actie: publiek.actie,
    }));
  }

  return { geladen: true, reden: null, regels };
}
