/**
 * PANEEL RICHARD-QUEUE — vult het gelijknamige slot uit het paneelcontract met de TELLING achter de
 * sectie "Wacht op Richard": hoeveel ownerpoorten er bij deze bouw bewezen open stonden, en hoeveel
 * van de drie ownerbronnen daarbij geen meting konden leveren.
 *
 * DIT PANEEL TELT, DE SECTIE NOEMT DE POORTEN. Net als bij NU-BEZIG herhaalt het paneel de rijen
 * bewust niet: `renderOwnerGates()` somt de afzonderlijke poorten met hun bronrol op, en twee
 * plekken die dezelfde rijen zelf opmaken lopen vroeg of laat uiteen.
 *
 * NOG STRAKKER GEKOPPELD DAN NU-BEZIG. Dat paneel deelt met zijn sectie dezelfde FUNCTIE
 * (`activeWork()`); dit paneel krijgt letterlijk HETZELFDE OBJECT. `renderCockpit()` roept
 * `ownerGates(snapshot)` één keer aan en geeft de uitkomst aan de sectie én aan dit paneel.
 * `renderOwnerGates()` krijgt de snapshot niet eens meer, dus een tweede meting is daar niet alleen
 * ongewenst maar onmogelijk — dat is een sterkere garantie dan een test kan geven.
 *
 * WAT DIT PANEEL BEWUST NIET DOET: een nulstand melden uit bronnen die niets hebben gemeten.
 * `ownerGates()` levert per ownerbron hoogstens één BRONSTATUS in `unavailable`, met de bronnaam
 * erbij (`ownerbronnen.mjs`). Zwijgen alle drie, dan is "0 open poorten" geen waarneming maar
 * stilte, en dan blijft de telling hier leeg. Zwijgt er één, dan is de telling een ONDERGRENS en
 * zegt het paneel dat ook: GEDEELTELIJK, niet WACHT.
 */
import { esc } from './format.mjs';
import { ageSince } from './runtime-feed-view.mjs';
import { OWNER_SOURCES, OWNER_SOURCE_COUNT, isBronstatus } from './ownerbronnen.mjs';

/**
 * De gesloten statuslijst van dit paneel, met de badgeklasse erbij. Vier waarden:
 *  - WACHT         alle drie de ownerbronnen leverden een meting, en er staat minstens één poort open
 *  - LEEG          alle drie leverden een meting en er staat er geen open — een echte, gemeten nulstand
 *  - GEDEELTELIJK  minstens één ownerbron kon niets meten, of een gelezen bron was onvolledig; de
 *                  telling is dan een ondergrens en geen totaal
 *  - UNKNOWN       geen enkele ownerbron leverde een meting, of het ownerresultaat heeft niet de
 *                  vorm waarop iets te tellen valt
 *
 * GEEN AFWIJKING, en dat is een keuze, geen omissie. Bij NU-BEZIG bestaat die stand omdat twee
 * feedregels dezelfde identiteit kunnen claimen en de telling dan dubbeltelt. Hier vouwt
 * `ownerGates()` gelijke identiteiten juist bewust samen, en de drie bronnen dragen elk een eigen
 * voorvoegsel (`planning:`, `kanaalpost:`), dus een botsing tussen bronnen kan niet ontstaan. Wat
 * er wél samenvouwt binnen één bron wordt hieronder als apart feit getoond, niet als afwijking —
 * twee meldingen over hetzelfde onderwerp zijn één besluit voor Richard, geen tegenspraak.
 */
const BADGE = Object.freeze({ WACHT: 'warn', LEEG: 'ok', GEDEELTELIJK: 'warn', UNKNOWN: 'warn' });

/**
 * Een bouwstempel is een ISO-8601-tijdstip in UTC en niets anders. Vóór deze controle werd IEDERE
 * tekenreeks in `generatedAt` letterlijk als stempel afgedrukt — `esc()` maakt daar geen markup
 * van, maar redigeert ook geen pad (bevinding Codex, P2). Wat hier niet doorheen komt, verschijnt
 * nergens: niet in de regel "Gebouwd" en niet in de contractregel "Gemeten om".
 */
const ISO_STEMPEL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const geldigStempel = (waarde) => (typeof waarde === 'string'
  && ISO_STEMPEL.test(waarde)
  && Number.isFinite(Date.parse(waarde)) ? waarde : null);

/**
 * De klok mag alleen een echte `Date` of een eindig getal zijn. Een algemene `Number(now)`-conversie
 * werpt op een `Symbol` en op elk object met een werpende `valueOf()` — en een paneel dat werpt
 * neemt de hele plaat mee (bevinding Codex, P3).
 */
function klokVan(now) {
  if (now instanceof Date) return Number.isFinite(now.getTime()) ? now.getTime() : null;
  return typeof now === 'number' && Number.isFinite(now) ? now : null;
}

/**
 * Is dit ownerresultaat in zijn geheel telbaar? Atomair, want half geldig bestaat hier niet: één
 * poort zonder identiteit of één bronstatus zonder bron maakt élk getal uit dit object onbetrouwbaar
 * (bevinding Codex, P2). Ook een dubbele bron is contractbreuk — `ownerGates()` levert er per bron
 * hoogstens één, en juist op die eigenschap rust de teller hieronder.
 */
function telbaarResultaat(res) {
  if (!Array.isArray(res.gates) || !Array.isArray(res.unavailable)) return false;
  const geldigePoort = (gate) => !!gate && typeof gate === 'object'
    && typeof gate.identity === 'string' && gate.identity.trim() !== ''
    && typeof gate.label === 'string';
  if (!res.gates.every(geldigePoort)) return false;
  if (!res.unavailable.every(isBronstatus)) return false;
  const bronnen = res.unavailable.map(({ source }) => source);
  return new Set(bronnen).size === bronnen.length && bronnen.length <= OWNER_SOURCE_COUNT;
}

/**
 * Berekent de inhoud van het RICHARD-QUEUE-paneel. Geeft altijd een object terug; nooit een
 * exception, ook niet op een ontbrekende snapshot, een misvormd ownerresultaat of een kapotte klok.
 *
 * `owner` is de uitkomst van `ownerGates(snapshot)` — bewust een PARAMETER en geen eigen aanroep,
 * zodat sectie en paneel niet twee keer kunnen meten. `now` is de wandklok van het bouwmoment,
 * alleen voor de "x geleden"-weergave bij het bouwstempel.
 */
export function richardQueuePaneel(snapshot, owner, opties) {
  const snap = (snapshot && typeof snapshot === 'object') ? snapshot : {};
  const res = (owner && typeof owner === 'object') ? owner : {};
  const keuzes = (opties && typeof opties === 'object') ? opties : {};
  const klok = klokVan(keuzes.now === undefined ? new Date() : keuzes.now);

  const telbaar = telbaarResultaat(res);
  const poorten = telbaar ? res.gates.length : 0;
  // Elke bronstatus is één ownerbron die geen meting kon leveren. Geteld worden UNIEKE bronnen, niet
  // regels: twee diagnoses van dezelfde bron zijn één zwijgende bron. Dat verschil was op de oude
  // `string[]` niet te maken en werd toen met een `Math.min()` weggemoffeld — een cap verbergt
  // contractbreuk in plaats van hem te melden (bevinding Codex + Gemini, P2).
  //
  // `telbaarResultaat()` heeft de uniciteit hierboven al afgedwongen, dus `size` is hier per
  // constructie gelijk aan `length`; die twee zijn met een test niet uit elkaar te houden. De Set
  // staat er dan ook voor de `has('kanaalpost')` hieronder, die de bronnaam wél nodig heeft.
  const stilleBronnen = telbaar
    ? new Set(res.unavailable.map(({ source }) => source))
    : new Set(OWNER_SOURCES);
  const ongemeten = stilleBronnen.size;

  // Een gelezen bron kan zelf onvolledig zijn: de kanaalpost-spiegel houdt rijen tegen die de
  // publicatiepoort niet halen. Die rijen bestaan, ze zijn alleen niet publiek — een ownerpoort kan
  // er dus in zitten zonder dat iemand hem hier ziet. Gelezen maar onvolledig is niet hetzelfde als
  // ongemeten, dus dit verandert de status wel en de noemer niet.
  //
  // Is de kanaalpost-bron zélf ongemeten, of draagt de spiegel geen geldige telling, dan is dit
  // getal ONBEKEND en niet nul — een `?? 0` had daar een gemeten nulstand van gemaakt (bevinding
  // Codex, P1).
  const kanaalpostGemeten = telbaar && !stilleBronnen.has('kanaalpost');
  const ruwIngehouden = snap.kanaalpost?.ingehouden;
  const ingehouden = kanaalpostGemeten && Number.isInteger(ruwIngehouden) && ruwIngehouden >= 0
    ? ruwIngehouden
    : null;

  const stempel = geldigStempel(snap.generatedAt);
  const leeftijd = stempel !== null && klok !== null ? ageSince(stempel, klok) : null;

  let status;
  let reden;
  if (!telbaar) {
    status = 'UNKNOWN';
    reden = 'het ownerresultaat heeft niet de vorm waarop hier iets te tellen valt — een getal uit een gebroken contract is geen meting';
  } else if (ongemeten >= OWNER_SOURCE_COUNT) {
    status = 'UNKNOWN';
    reden = 'geen van de drie ownerbronnen leverde een meting — een lege wachtrij is hier geen waarneming maar stilte';
  } else if (ongemeten > 0) {
    status = 'GEDEELTELIJK';
    reden = `${ongemeten} van de ${OWNER_SOURCE_COUNT} ownerbronnen kon niets meten — ${poorten} is een ondergrens, geen totaal`;
  } else if (ingehouden === null) {
    status = 'GEDEELTELIJK';
    reden = `alle drie de ownerbronnen zijn gelezen, maar de spiegel meldt niet hoeveel rijen de publicatiepoort niet haalden — ${poorten} is daarmee een ondergrens, geen totaal`;
  } else if (ingehouden > 0) {
    status = 'GEDEELTELIJK';
    reden = `alle drie de ownerbronnen zijn gelezen, maar ${ingehouden} spiegelrij${ingehouden === 1 ? '' : 'en'} haalde de publicatiepoort niet — daar kan een ownerpoort in zitten die hier niet meetelt`;
  } else if (poorten === 0) {
    status = 'LEEG';
    reden = 'alle drie de ownerbronnen zijn gelezen en er staat geen gevalideerde ownerpoort open';
  } else {
    status = 'WACHT';
    reden = `${poorten} gevalideerde ownerpoort${poorten === 1 ? '' : 'en'} open, uit drie gelezen ownerbronnen`;
  }

  // Bij UNKNOWN blijft de TELLING leeg, om dezelfde reden als in het NU-BEZIG-paneel: nul poorten
  // uit nul metingen is geen nul. Het aantal ONGEMETEN bronnen blijft wél staan — dat getal is juist
  // wél gemeten, en het is precies de melding. Alleen bij een gebroken ownerresultaat is ook dat
  // getal niets waard, want dan is er geen bron waarop het slaat.
  const toonTelling = status !== 'UNKNOWN';
  const regels = [
    { label: 'Bewezen open', waarde: toonTelling ? `${poorten} queue-item${poorten === 1 ? '' : 's'}` : null },
    { label: 'Ongemeten ownerbronnen', waarde: telbaar ? `${ongemeten} van ${OWNER_SOURCE_COUNT}` : null },
    { label: 'Ingehouden spiegelrijen', waarde: ingehouden === null ? null : `${ingehouden}` },
    { label: 'Gebouwd', waarde: stempel ? `${stempel}${leeftijd ? ` · ${leeftijd} geleden` : ''}` : null },
  ];

  return {
    status,
    reden,
    measuredAt: stempel,
    leegTekst: 'UNKNOWN — geen meting',
    regels,
    poorten,
    ongemeten,
    ingehouden,
  };
}

/**
 * De blinde vlekken staan op de pagina zelf, want ze zijn hier groter dan bij NU-BEZIG.
 *
 * (1) De kanaalpost-kant kijkt alleen naar de vijftien rijen die de publieke spiegel nog toont; een
 *     oudere rij die op akkoord wacht en van de lijst is geschoven, telt hier niet mee.
 * (2) Alleen de stand WACHT OP AKKOORD telt. Een spiegelrij die GEBLOKKEERD staat en Richard bij
 *     naam noemt, telt hier NIET mee — `ownerGates()` rekent alleen een expliciet gevraagd akkoord
 *     als ownerhandeling. Dat is een bestaand en getest oordeel van de sectie, niet iets wat dit
 *     paneel opnieuw beoordeelt; maar op de echte plaat staat het verschil op elf rijen, en dan is
 *     "0 queue-items" zonder die uitleg misleidend precies waar het telt.
 * (3) Een open pull-request die op Richard wacht wordt NOOIT een queue-item: mergebaarheid en
 *     vereiste checks worden niet gemeten, dus die bron levert hoogstens een ongemeten-melding.
 * (4) Dit is de stand van het bouwmoment. Anders dan NU-BEZIG ververst dit paneel niet in de
 *     browser — de ownerbronnen zitten in de statische snapshot, niet in de runtimefeed.
 */
const BLINDE_VLEK = 'Geteld wordt alleen wat expliciet op akkoord wacht: een melding die GEBLOKKEERD staat en Richard bij naam noemt, valt hier buiten. Deze telling ziet bovendien alleen de vijftien rijen die de publieke spiegel nog toont, dus een ouder besluit dat van die lijst is geschoven telt niet mee. Een open pull-request wordt hier nooit een queue-item, omdat mergebaarheid en vereiste checks niet gemeten worden. En dit is de stand van het bouwmoment: dit paneel ververst niet in de browser.';

/** Rendert de body van het RICHARD-QUEUE-paneel. Alle tekst gaat door `esc()`, zonder uitzondering
 *  per regel: het model levert kale tekst, het ontsnappen gebeurt hier en alleen hier. */
export function renderRichardQueueBody(paneel) {
  const regels = paneel.regels.map((r) => (r.waarde !== null
    ? `<li><span class="repo">${esc(r.label)}</span><span class="muted">${esc(r.waarde)}</span></li>`
    : `<li><span class="repo">${esc(r.label)}</span><span class="unknown">${esc(paneel.leegTekst)}</span></li>`)).join('');
  const klasse = paneel.status === 'LEEG' ? 'muted' : 'unknown';
  const kop = `<p class="${klasse}">${esc(paneel.status)} — ${esc(paneel.reden)}.</p>`;
  return `${kop}<ul class="lights">${regels}</ul><p class="muted">${esc(BLINDE_VLEK)}</p>`;
}

export const richardQueueBadge = (paneel) => BADGE[paneel?.status] ?? 'warn';
