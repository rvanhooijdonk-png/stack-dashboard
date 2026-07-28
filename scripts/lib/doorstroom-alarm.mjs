/**
 * DOORSTROOM-ALARM — de meldbeslissing als apart, beproefd stapje vóór de workflow ernaar handelt.
 *
 * WAAROM DIT BESTAAT. `doorstroom.yml` faalde op 2026-07-28 op ELKE trigger door een kapotte
 * regressietest die live spiegeldata tegen een vaste momentopname toetst (zie CONTROL/RAPPORTEN,
 * ALARM-DAT-ELKE-RUN-MAILT A1). De workflow zelf deed wat hij moest: ROOD → `exit 1` → GitHub-mail,
 * op elke run. Wat ontbrak was een debounce: een AANHOUDENDE oorzaak hoort niet elke run opnieuw te
 * mailen, en een VERDWENEN oorzaak hoort precies één "opgelost"-melding te geven. Deze module beslist
 * dat. De reparatie van de kapotte test zelf hoort hier NIET bij — dat is een apart spoor.
 *
 * DE STAAT reist mee in het lichaam van het alarmissue, als een verborgen marker-regel. Geen los
 * bestand, geen extra permissie: `issues: write` bestond al, `contents: write` blijft ongebruikt
 * voor dit doel. Sluit het issue, dan verdwijnt de marker gewoon mee — dat is precies goed.
 *
 * Puur en zonder netwerk: de workflow leest het oordeel/de teststaart/het issuebody VAN TEVOREN in,
 * geeft ze hier binnen, en handelt daarna naar het antwoord. Dat maakt de beslissing zelf beproefbaar
 * zonder een echte GitHub-run — zie test/doorstroom-alarm.test.mjs.
 */

const MARKER_RE = /<!-- doorstroom-alarm-state: (.*?) -->/;

/**
 * Reden-codes dragen soms variabele tellingen ("RIJEN_WEGGEVALLEN: tracker 17/36",
 * "SPIEGEL_ONLEESBAAR/GEEN_BRON@..."). Voor de oorzaak-handtekening telt alleen de vaste code
 * ervoor — anders is elke schommeling in een teller een "nieuwe" oorzaak, en dat is precies het
 * gedrag dat dit bestand bestrijdt.
 */
export function normaliseerReden(reden) {
  if (reden === null || reden === undefined) return '?';
  return String(reden).split(/[:/]/)[0].trim() || '?';
}

/**
 * ALLE falende testnamen uit een tap-uitvoer, gesorteerd en ontdubbeld — niet alleen de eerste.
 *
 * Bewust plurale vorm: bleef bij de eerdere, enkelvoudige versie test A falen en kwam test B erbij,
 * dan bleef de handtekening op A hangen en werd B stilzwijgend gedebouncet — precies het gedrag dat
 * dit bestand bestrijdt, nu toegepast op de UITVOERDER_GEFAALD-tak zelf (bevinding Codex-review,
 * ALARM-DAT-ELKE-RUN-MAILT A2-A4).
 */
export function falendeTestNamen(tapTekst) {
  const regels = String(tapTekst ?? '').split(/\r\n|\r|\n/);
  const namen = regels
    .filter((r) => /^not ok \d+/.test(r.trim()))
    .map((r) => r.trim().replace(/^not ok \d+\s*-\s*/, '').trim())
    .filter(Boolean);
  return [...new Set(namen)].sort();
}

/**
 * De oorzaak-handtekening: stabiel zolang de STRUCTURELE oorzaak gelijk blijft, ongeacht tellingen.
 *
 * `oordeel` is `null` als de uitvoerder zelf niet draaide (UITVOERDER_GEFAALD, geen `oordeel.json`)
 * — dan telt de VOLLEDIGE verzameling falende testnamen als oorzaak, of `ONBEKEND` als die leeg is.
 * Dat onderscheid is bewust: "dezelfde test faalt nog steeds" en "een ANDERE test is nu OOK stuk"
 * zijn twee verschillende oorzaken en verdienen elk hun eigen eerste melding.
 */
export function causeSignature(oordeel, { testNamen = [] } = {}) {
  if (!oordeel) {
    return testNamen.length ? `UITVOERDER_GEFAALD:${testNamen.join('|')}` : 'UITVOERDER_GEFAALD:ONBEKEND';
  }

  const delen = [];
  if (oordeel.bron?.ok === false) delen.push(`BRON:ROOD:${normaliseerReden(oordeel.bron.reden)}`);
  if (oordeel.kanaalpost?.ok === false) delen.push(`KANAALPOST:ROOD:${normaliseerReden(oordeel.kanaalpost.reden)}`);
  for (const [label, deel] of [
    ['ACHTERSTAND', oordeel.achterstand],
    ['STEMPEL', oordeel.stempel],
    ['BRONRIJEN', oordeel.bronRijen],
  ]) {
    if (deel && deel.uitkomst && deel.uitkomst !== 'GROEN') {
      delen.push(`${label}:${deel.uitkomst}:${normaliseerReden(deel.reden)}`);
    }
  }
  if (delen.length === 0) return oordeel.uitkomst === 'GROEN' ? 'GROEN' : `ONBEKEND:${oordeel.uitkomst ?? '?'}`;
  // Gesorteerd: de volgorde waarin de deeloordelen toevallig in het object staan mag de
  // handtekening niet laten wisselen terwijl de verzameling oorzaken gelijk blijft.
  return delen.sort().join('|');
}

/**
 * Bepaal (uitkomst, causeSig, testNamen) uit oordeel/tap, plus een optionele `oorzaakOverride` voor
 * een storing BUITEN de uitvoerder om — bv. de push in "Aanvulling vastleggen" faalde. Er is dan geen
 * betrouwbaar `oordeel` om op te vertrouwen (kan zelfs een stale GROEN zijn, geschreven vóór de
 * storing): de override-code IS dan de oorzaak, en `uitkomst` wordt altijd ROOD. Puur, dus beproefbaar
 * zonder bestanden of een echte GitHub-run (ALARM-DAT-ELKE-RUN-MAILT A2-A4, derde Codex-bevinding: een
 * mislukte push kon eerder een openstaand issue ten onrechte als "opgelost" laten sluiten).
 */
export function bepaalOorzaak({ oordeel = null, tap = null, oorzaakOverride = null } = {}) {
  if (oorzaakOverride) {
    return { uitkomst: 'ROOD', causeSig: `STAP_GEFAALD:${oorzaakOverride}`, testNamen: [] };
  }
  const testNamen = oordeel ? [] : falendeTestNamen(tap);
  const causeSig = causeSignature(oordeel, { testNamen });
  // Ontbreekt `oordeel`, dan viel de uitvoerder zelf om — dat is ROOD, geen "onbekend".
  const uitkomst = oordeel ? oordeel.uitkomst : 'ROOD';
  return { uitkomst, causeSig, testNamen };
}

/** Lees de verborgen staat-marker uit een issuebody. `null` als er geen (leesbare) marker in staat. */
export function leesMarker(body) {
  const m = MARKER_RE.exec(String(body ?? ''));
  if (!m) return null;
  try {
    const state = JSON.parse(m[1]);
    return state && typeof state === 'object'
      && typeof state.causeSig === 'string' && typeof state.laatstGemeldOp === 'string'
      ? state
      : null;
  } catch {
    return null;
  }
}

/** Vervang (of voeg toe) de marker in een issuebody. `state: null` verwijdert de marker. */
export function schrijfMarker(body, state) {
  const zonder = String(body ?? '').replace(MARKER_RE, '').replace(/^\n+/, '').trimEnd();
  if (!state) return zonder;
  const regel = `<!-- doorstroom-alarm-state: ${JSON.stringify(state)} -->`;
  return zonder ? `${regel}\n\n${zonder}` : regel;
}

/**
 * DE BESLISSING.
 *
 * - ROOD: eerste keer of nieuwe oorzaak → melden. Dezelfde oorzaak → pas weer melden na
 *   `periodeUur` sinds de LAATSTE MELDING (niet sinds de laatste run — anders schuift de klok elke
 *   keer dat we controleren, ook als we bewust niets meldden).
 * - GROEN: alleen melden (en sluiten) als er een issue OPEN staat. Dit hangt bewust af van
 *   `issueOpen`, niet van de marker: een issue van vóór deze reparatie heeft nog geen marker, en
 *   moet toch gewoon dichtgaan zodra het weer groen is. Fail-open zou hier zijn: "geen marker dus
 *   niets te sluiten" — en dat is exact de fout die dit bestand bestrijdt.
 * - GEEL: ongewijzigd — waarschuwen, niet melden, niet sluiten, staat blijft staan. Dat gedrag
 *   bestond al vóór dit bestand ("Sluiten mag ALLEEN op GROEN") en verandert hier niet.
 */
export function beslisMelding({
  uitkomst, causeSig, opgeslagen = null, issueOpen = false, nu = new Date(), periodeUur = 24,
} = {}) {
  const vorig = opgeslagen && typeof opgeslagen === 'object' ? opgeslagen : null;

  if (uitkomst === 'ROOD') {
    if (!vorig) {
      return { melden: true, reden: 'EERSTE_KEER', nieuweState: { causeSig, laatstGemeldOp: nu.toISOString() } };
    }
    if (vorig.causeSig !== causeSig) {
      return { melden: true, reden: 'NIEUWE_OORZAAK', nieuweState: { causeSig, laatstGemeldOp: nu.toISOString() } };
    }
    const vorigMoment = new Date(vorig.laatstGemeldOp);
    const urenSinds = Number.isNaN(vorigMoment.getTime())
      ? Infinity
      : (nu.getTime() - vorigMoment.getTime()) / 3_600_000;
    if (urenSinds >= periodeUur) {
      return { melden: true, reden: 'PERIODIEK', nieuweState: { causeSig, laatstGemeldOp: nu.toISOString() } };
    }
    return { melden: false, reden: 'ONVERANDERD', nieuweState: vorig };
  }

  if (uitkomst === 'GROEN') {
    return issueOpen
      ? { melden: true, reden: 'OPGELOST', nieuweState: null }
      : { melden: false, reden: 'GEEN_ALARM_OPEN', nieuweState: null };
  }

  return { melden: false, reden: 'GEEL_ONGEWIJZIGD', nieuweState: vorig };
}
