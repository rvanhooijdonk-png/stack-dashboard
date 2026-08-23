/**
 * PANEEL NU-BEZIG — vult het gelijknamige slot uit het paneelcontract met de TELLING achter de
 * "Nu actief"-sectie: hoeveel taakregels heeft de runtimefeed bij deze meting laten zien, en
 * hoeveel daarvan dragen het volledige bewijs dat de sectie hierboven eist.
 *
 * DIT PANEEL TELT, DE SECTIE TOONT DE REGELS. `renderActive()` (runtime-feed-view.mjs) somt de
 * afzonderlijke actoren, heartbeats en bewijsverwijzingen op; dit paneel herhaalt die regels
 * bewust NIET. Twee plekken die dezelfde rijen zelf opmaken lopen vroeg of laat uiteen, en dan
 * staan er twee waarheden op één plaat. Het paneel voegt precies toe wat de sectie niet geeft: de
 * noemer uit het paneelcontract — `aantal actief-bezig-regels` — met de teller ernaast.
 *
 * DAAROM GEEN EIGEN CLASSIFICATIE. Wie "bezig" is, wordt hier niet opnieuw beoordeeld: dat oordeel
 * komt letterlijk uit `activeWork()`, dezelfde functie die de sectie en de browserpolling gebruiken.
 * Zou dit paneel zijn eigen bewijstoets schrijven, dan kon het "3 bezig" melden boven een sectie die
 * er twee toont. De teller/noemer hieronder zijn dus per constructie dezelfde waarheid, anders
 * gepresenteerd.
 *
 * WAT DIT PANEEL BEWUST NIET DOET: een nulstand melden uit een meting die dat niet kan dragen. Is
 * de feed onbeschikbaar, teruggevallen op de laatst bekende meting, of niet CURRENT, dan is "0
 * bezig" geen waarneming maar stilte — en stilte hoort UNKNOWN te heten (zie `sanitize.mjs`: liever
 * geen dashboard dan een dashboard dat iets verzint). Alleen een verse meting die nul taakregels
 * noemt levert een echte nulstand op, en die heet hier LEEG.
 */
import { esc } from './format.mjs';
import { activeWork, ageSince } from './runtime-feed-view.mjs';

/**
 * De gesloten statuslijst van dit paneel, met de badgeklasse erbij. Vijf waarden, nooit
 * stilzwijgend een zesde:
 *  - BEZIG        elke gelezen taakregel draagt volledig bewijs, en het zijn er meer dan nul
 *  - LEEG         de meting is vers en noemt geen enkele taakregel — een echte, gemeten nulstand
 *  - GEDEELTELIJK er is minstens één taakregel zonder volledig bewijs
 *  - AFWIJKING    de feed spreekt zichzelf tegen (dubbele identiteit) — de telling is niet eenduidig
 *  - UNKNOWN      er is geen meting waar een telling op mag steunen
 */
const BADGE = Object.freeze({
  BEZIG: 'ok', LEEG: 'ok', GEDEELTELIJK: 'warn', AFWIJKING: 'bad', UNKNOWN: 'warn',
});

/**
 * Een dubbele actor- of task-identiteit maakt de noemer onwaar: twee regels die dezelfde taak
 * kunnen zijn tellen als twee, of als één, en niemand kan zeggen welke. `parseRuntimeFeed()` heeft
 * dat al vastgesteld en beide betrokken regels op CONFLICT gezet — hier wordt dat oordeel alleen
 * gelezen, niet opnieuw afgeleid.
 */
function heeftIdentiteitsconflict(runtimeFeed) {
  for (const actor of runtimeFeed.actors ?? []) {
    if (actor?.identity === 'CONFLICT') return true;
    if (actor?.current_task?.identity === 'CONFLICT') return true;
  }
  return false;
}

/**
 * Berekent de inhoud van het NU-BEZIG-paneel. Geeft altijd een object terug; nooit een exception,
 * ook niet op een ontbrekende of misvormde feed — een paneel dat klapt neemt de hele plaat mee.
 *
 * `nowMs` is dezelfde klok die `renderActive()` krijgt: bij de statische build het bouwmoment
 * (`snapshot.generatedAt`), bij browserpolling `Date.now()`. Alleen gebruikt voor de "x geleden"-
 * weergave van het meetmoment; het versheidsoordeel zelf komt uit de feed en wordt hier niet
 * overgedaan.
 */
export function nuBezigPaneel(runtimeFeed, nowMs) {
  const feed = (runtimeFeed && typeof runtimeFeed === 'object') ? runtimeFeed : {};
  const beschikbaar = feed.available === true;
  // `activeWork()` geeft op een onbeschikbare feed zelf al `{available:false, active:[], incomplete:0}`,
  // dus deze aanroep is ook in het UNKNOWN-pad veilig.
  const werk = activeWork(feed);
  const gelezen = werk.active.length + werk.incomplete;
  const meting = typeof feed.measured_at?.value === 'string' ? feed.measured_at.value : null;
  const metingLeesbaar = meting !== null && feed.measured_at?.freshness !== 'UNKNOWN';
  const leeftijd = metingLeesbaar ? ageSince(meting, nowMs) : null;

  let status;
  let reden;
  if (!beschikbaar) {
    status = 'UNKNOWN';
    reden = 'de runtimefeed is niet beschikbaar of niet contractgeldig';
  } else if (feed.fallback?.used === true) {
    // Een terugval draagt de laatst bekende geldige meting. `loadRuntimeFeed()` zet zo'n meting
    // nooit op CURRENT, dus de regel hieronder zou hem ook vangen — maar dan met de verkeerde
    // reden. De lezer hoort te zien dát het live lezen mislukte, niet alleen dát de meting oud is.
    status = 'UNKNOWN';
    reden = `dit is de laatst bekende geldige meting, geen live lezing (${String(feed.fallback.reason ?? 'onbekende reden')})`;
  } else if (feed.freshness !== 'CURRENT') {
    status = 'UNKNOWN';
    reden = `de meting van de feed is ${String(feed.freshness ?? 'UNKNOWN')} — een telling uit een niet-verse meting is geen nulstand`;
  } else if (heeftIdentiteitsconflict(feed)) {
    status = 'AFWIJKING';
    reden = 'twee of meer regels delen dezelfde actor- of task-identiteit — een telling over dubbeltellend materiaal is geen telling';
  } else if (gelezen === 0) {
    status = 'LEEG';
    reden = 'de meting is vers en noemt geen enkele taakregel — er is niemand aantoonbaar bezig';
  } else if (werk.incomplete > 0) {
    status = 'GEDEELTELIJK';
    reden = `${werk.incomplete} van de ${gelezen} taakregels draagt geen volledig bewijs van actief werk`;
  } else {
    status = 'BEZIG';
    reden = `elk van de ${gelezen} gelezen taakregels draagt volledig bewijs van actief werk`;
  }

  // Bij UNKNOWN blijft de TELLING leeg. Dat is niet uit voorzichtigheid maar omdat de telling daar
  // liegt: een verouderde feed levert via `activeWork()` per definitie nul bewezen regels op (dat
  // vereist `freshness === 'CURRENT'`), dus "0 van 3 bezig" zou een nulstand tonen die niemand heeft
  // gemeten. Het MEETMOMENT blijft wél staan zolang de feed er is — dat is juist de melding: er is
  // gemeten, alleen niet vers genoeg om op te tellen.
  //
  // Bij AFWIJKING blijft de telling om DEZELFDE reden leeg, en dat is een correctie op de eerste
  // versie van dit paneel (review Gemini, ronde 1). Daar bleef "0 van 0 taakregels" staan onder een
  // regel die zei dat de telling niet eenduidig was — het paneel sprak zichzelf tegen in twee
  // opeenvolgende regels, en de gedrukte nul was precies de nulstand die dit paneel nergens mag
  // tonen. Twee regels die dezelfde identiteit claimen leveren geen getal op dat iets betekent.
  const telbaar = status !== 'UNKNOWN' && status !== 'AFWIJKING';
  const regels = [
    { label: 'Bewezen bezig', waarde: telbaar ? `${werk.active.length} van ${gelezen} taakregels` : null },
    { label: 'Zonder volledig bewijs', waarde: telbaar ? `${werk.incomplete} taakregel${werk.incomplete === 1 ? '' : 's'}` : null },
    {
      label: 'Meting',
      waarde: beschikbaar
        ? `${String(feed.freshness ?? 'UNKNOWN')}${leeftijd ? ` · ${leeftijd} geleden` : ''}`
        : null,
    },
  ];

  return {
    status,
    reden,
    // Alleen een meetmoment dat de feed zelf leesbaar noemde wordt getoond; anders blijft het slot
    // op UNKNOWN staan in plaats van een onleesbare tekenreeks als tijdstip te presenteren.
    measuredAt: metingLeesbaar ? meting : null,
    // Waarom er niets staat waar een getal hoort. Bij UNKNOWN is er geen bruikbare meting; bij
    // AFWIJKING is die er wél maar telt ze dubbel. Eén tekst voor beide zou de lezer bij AFWIJKING
    // laten denken dat er niet gemeten is, terwijl juist de meting het probleem aanwijst.
    leegTekst: status === 'AFWIJKING' ? 'NIET TELBAAR — dubbele identiteit' : 'UNKNOWN — geen meting',
    regels,
    bezig: werk.active.length,
    gelezen,
  };
}

/**
 * De blinde vlek staat op de pagina zelf. "Bezig" betekent hier precies één ding: de feed toonde bij
 * deze meting een heartbeat ná de start, binnen de versheidsdrempel, met zichtbare identiteit en
 * bewezen pickup. Dat een proces zich meldt is geen bewijs dat het werk vordert — en op een pagina
 * zonder JavaScript is dit de telling van het bouwmoment, niet van nu.
 */
const BLINDE_VLEK = 'Bezig betekent: bij deze meting meldde de actor zich ná zijn start en binnen de versheidsdrempel. Dat bewijst een levend proces, geen voortgang in het werk. Zonder client-side polling is dit bovendien de telling van het bouwmoment — vergelijk het meetmoment met je eigen klok.';

/** Rendert de body van het NU-BEZIG-paneel. Alle tekst gaat door `esc()`; geen rauwe brontekst. */
export function renderNuBezigBody(paneel) {
  const regels = paneel.regels.map((r) => (r.waarde !== null
    ? `<li><span class="repo">${esc(r.label)}</span><span class="muted">${esc(r.waarde)}</span></li>`
    : `<li><span class="repo">${esc(r.label)}</span><span class="unknown">${esc(paneel.leegTekst)}</span></li>`)).join('');
  const klasse = paneel.status === 'BEZIG' || paneel.status === 'LEEG' ? 'muted' : 'unknown';
  const kop = `<p class="${klasse}">${esc(paneel.status)} — ${esc(paneel.reden)}.</p>`;
  return `${kop}<ul class="lights">${regels}</ul><p class="muted">${esc(BLINDE_VLEK)}</p>`;
}

export const nuBezigBadge = (paneel) => BADGE[paneel.status] ?? 'warn';
