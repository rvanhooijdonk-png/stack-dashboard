#!/usr/bin/env node
/**
 * MUTATIEPROEF — bewijst dat elke proef ook echt rood KAN worden.
 *
 * De nulmeting (`kijk-nulmeting.mjs`) laat zien dat de OUDE waarnemer alle acht gevallen fout doet.
 * Dat bewijst dat het probleem bestond. Het bewijst nog niet dat de nieuwe proeven het probleem ook
 * echt meten: een test die groen blijft als je het mechanisme eronder weghaalt, meet niets.
 *
 * Daarom wordt hier per proef precies één mechanisme uit `scripts/lib/kijk.mjs` gesloopt, de suite
 * gedraaid, en gekeken of de bijbehorende proef omvalt. Daarna wordt het bestand teruggezet.
 * Slaat een mutatie niet aan, dan is dat een BEVINDING en geen detail.
 *
 * Aanroep: node scripts/kijk-mutaties.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUITE = join(ROOT, 'test/kijk.test.mjs');

/**
 * Het standaarddoel is de kijk-module zelf. Eén reparatie zit echter in de GEDEELDE lezer
 * (`scripts/lib/kanaalpost.mjs`), waar de waarnemer en de publicatieweg ook op leunen; die mutatie
 * wijst met `bestand` naar dat bestand. Zonder die uitbreiding zou juist de reparatie met de grootste
 * raakvlakken de enige zijn die niet bewezen werd.
 */
const STANDAARDDOEL = 'scripts/lib/kijk.mjs';
const bronnen = new Map();
const lees = (rel) => {
  if (!bronnen.has(rel)) bronnen.set(rel, readFileSync(join(ROOT, rel), 'utf8'));
  return bronnen.get(rel);
};

/** Per proef: waar hij over gaat, en welke ingreep het mechanisme eronder weghaalt. */
const MUTATIES = [
  {
    proef: 1,
    raakt: 'proef 1 —',
    wat: 'de vergelijking van de paginacommit met de actuele kop vervalt',
    van: "if (paginaHerkomst.commitSha !== lezing.sha) redenen.push('PAGINA_ANDERE_COMMIT');",
    naar: '/* mutatie: commitvergelijking weg */',
  },
  {
    proef: 2,
    raakt: 'proef 2 —',
    wat: 'de kop wordt na het ophalen niet opnieuw gelezen',
    van: "    const naKop = await veilig(() => kopVan(), 'KOP_ONBEPAALBAAR');",
    naar: '    const naKop = { ok: true, sha: kop.sha }; // mutatie: nooit opnieuw lezen',
  },
  {
    proef: 3,
    raakt: 'proef 3 —',
    wat: 'de NL-kolom wordt weer als UTC gelezen, zoals de oude rijMoment deed',
    van: '  const kandidaten = new Set([zoneVerschuiving(alsUtc - 12 * UUR), zoneVerschuiving(alsUtc + 12 * UUR)]);',
    naar: '  return alsUtc; // mutatie: zone niet opzoeken\n  const kandidaten = new Set();',
  },
  {
    proef: 4,
    raakt: 'proef 4 —',
    wat: 'de toestandshash van de pagina wordt niet meer vergeleken',
    van: "    if (manifest && paginaHerkomst.stateSha256 !== manifest.stateSha256) redenen.push('PAGINA_ANDERE_TOESTAND');",
    naar: '    /* mutatie: hashvergelijking weg */',
  },
  {
    proef: 5,
    raakt: 'proef 5 —',
    wat: 'stille sporen worden niet meer opgespoord',
    van: '  const lanes = Object.values(state?.lanes ?? {});\n  const momenten',
    naar: '  const lanes = []; const _weg = Object.values(state?.lanes ?? {});\n  const momenten',
  },
  {
    proef: 6,
    raakt: 'proef 6 —',
    wat: 'de publieke toestand krijgt er één vrij tekstveld bij',
    van: '      eventUitkomst: \'GEEN\',',
    naar: '      eventUitkomst: \'GEEN\',\n      onderwerp: r.onderwerp, // mutatie: vrije tekst in de publieke toestand',
  },
  {
    proef: 7,
    raakt: 'proef 7 —',
    wat: 'het geheugen van de getuige wordt niet meer geraadpleegd',
    van: '  if (getuigenis && state) {',
    naar: '  if (false && getuigenis && state) { // mutatie: getuige genegeerd',
  },
  {
    proef: 8,
    raakt: 'proef 8 —',
    wat: 'een mislukte lezing levert weer een gewoon oordeel in plaats van GEEN OORDEEL',
    van: "    return uit('GEEN OORDEEL');\n  }\n  gemeten.kopSha = lezing.sha;",
    naar: "    return uit('GROEN'); // mutatie: onwetendheid doet zich voor als kennis\n  }\n  gemeten.kopSha = lezing.sha;",
  },
  // ── de zes reparaties uit de dubbele review op kop 579ad57. Codex' punt was expliciet dat de acht
  // mutaties hierboven de ANKERS bewijzen en niet het fail-closed-contract; deze zes sluiten dat gat.
  {
    proef: '1 (reviewgat)',
    raakt: 'reviewgat 1 —',
    wat: 'een toestand zonder enig spoor telt weer als een gezonde lege toestand',
    van: "    fouten.push('GEEN_SPOREN');",
    naar: '    /* mutatie: nul sporen is weer geen bevinding */',
  },
  {
    proef: '2 (reviewgat)',
    raakt: 'reviewgat 2 —',
    wat: 'een weggelaten manifest of weggelaten bytes slaat de hashcontrole weer stilzwijgend over',
    van: '  if (!state || !manifest || !stateBytes) {',
    naar: '  if (false) { // mutatie: ontbrekend bewijs mag weer doorlopen',
  },
  {
    proef: '3 (reviewgat)',
    raakt: 'reviewgat 3 —',
    wat: 'de bytes worden niet meer aan déze toestand vastgemaakt',
    van: '  if (!kanoniekeBytes(state).equals(Buffer.from(stateBytes))) {',
    naar: '  if (false) { // mutatie: bytes van A mogen weer bij toestand B',
  },
  {
    proef: '4 (reviewgat)',
    raakt: 'reviewgat 4 —',
    wat: 'de sleutellijst van de toestand is niet meer gesloten',
    van: "  if (Object.keys(state).some((k) => !STATE_SLEUTELS.includes(k))) fouten.push('VELD_NIET_GESLOTEN');",
    naar: '  /* mutatie: onbekende velden bovenin de toestand mogen weer */',
  },
  {
    proef: '5 (reviewgat)',
    raakt: 'reviewgat 5 —',
    wat: 'de absolute vloer onder de totale uitval vervalt',
    van: '  const allesStil = momenten.length > 0 && nu - Math.max(...momenten) > stilMs;',
    naar: '  const allesStil = false; // mutatie: alles tegelijk stil is weer groen',
  },
  {
    proef: '6 (reviewgat)',
    raakt: 'reviewgat 6 —',
    wat: 'de kalenderterugrekening vervalt, dus 30 februari wordt weer een geldig moment',
    van: '  if (d.getUTCFullYear() !== +jj || d.getUTCMonth() !== +mm - 1 || d.getUTCDate() !== +dd',
    naar: '  if (false && d.getUTCFullYear() !== +jj || false && d.getUTCMonth() !== +mm - 1 || false && d.getUTCDate() !== +dd',
  },
  // ── de zes reparaties uit de tweede dubbele review, op kop 31984b5. Beide families gaven daar
  // BLOKKEREND; Codex mat elke route zelf na. Ook hier geldt: pas als de reparatie eruit halen een
  // proef omvergooit, meet die proef het contract en niet alleen zijn eigen anker.
  {
    proef: '7 (reviewgat)',
    raakt: 'reviewgat 7 —',
    wat: 'een rij die de vormtoets niet haalt telt weer niet mee, dus schuift alles erna een plaats op',
    van: "    if (r === null) { fouten.push('VELD_NIET_GESLOTEN'); continue; }",
    naar: '    if (r === null) { teller -= 1; continue; } // mutatie: stille verdwijning vóór de teller',
  },
  {
    proef: '8 (reviewgat)',
    raakt: 'reviewgat 8 —',
    wat: 'een aangeleverd spoor mag zijn tijd weer missen, en dan meet geen enkele stiltemeting iets',
    // Bewust NIET geankerd op de gelijknamige wacht in `kijkStateUitSpiegel`: de vormtoets van de
    // spiegel keurt datum en tijd al even streng, dus die tak is via de spiegel niet te bereiken en een
    // mutatie erop zou groen blijven zonder dat dat iets zegt. Hij blijft als tweede riem staan voor het
    // geval de twee lezers ooit uiteenlopen. De tak die WEL bereikbaar is, is deze: `oordeel()` krijgt
    // de toestand aangeleverd, en daar liet de vormtoets een lege tijd door.
    // De helften vangen elk apart een lege tijd (`String(null)` haalt de vorm niet én
    // `Date.parse(null)` is NaN), dus één regel wegnemen laat de controle staan. De hele toets moet
    // eruit om te bewijzen dat de proef hem meet. Codex vroeg in de derde ronde om een APARTE mutant
    // per helft; die staat hieronder als reviewgat 18, en die haalt alléén de kalenderterugrekening weg.
    van: "    if (!/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/.test(String(lane.momentUtc))\n"
      + '      || Number.isNaN(Date.parse(lane.momentUtc))\n'
      + '      || new Date(Date.parse(lane.momentUtc)).toISOString() !== lane.momentUtc) {\n'
      + "      fouten.push('VELD_NIET_GESLOTEN');\n"
      + '    }',
    naar: '    /* mutatie: een aangeleverd spoor mag zijn tijd weer missen */',
  },
  {
    proef: '9 (reviewgat)',
    raakt: 'reviewgat 9 —',
    wat: 'de bewijsketen wordt niet meer aan de gelezen bron vastgemaakt',
    van: '  if (state.bronCommitSha !== lezing.sha || manifest.bronCommitSha !== lezing.sha) {',
    naar: '  if (false) { // mutatie: een bewijs dat alleen zichzelf bewijst mag weer',
  },
  {
    proef: '10 (reviewgat)',
    raakt: 'reviewgat 10 —',
    wat: 'de toegestane sleutels krijgen hun waardedomein niet meer gecontroleerd',
    van: "  if (state.bronSoort !== OVERGANG_MERK) fouten.push('VELD_NIET_GESLOTEN');",
    naar: '  /* mutatie: gesloten sleutel, vrije waarde */',
  },
  {
    proef: '11 (reviewgat)',
    raakt: 'reviewgat 11 —',
    wat: 'de absolute vloer krijgt haar oude eigen return terug en maskeert de onderlinge meting weer',
    van: "  if (allesStil) redenen.push('ALLES_STIL');",
    naar: "  if (allesStil) { redenen.push('ALLES_STIL'); return uit('PARTIAL'); } // mutatie: (a) verbergt (b)",
  },
  {
    proef: '12 (reviewgat)',
    raakt: 'reviewgat 12 —',
    wat: 'een tijdstip uit de toekomst is weer geen bevinding, en zet daarmee de stiltemeting uit',
    van: "  if (momenten.some((t) => t > nu + TOEKOMST_MARGE)) redenen.push('TIJD_UIT_DE_TOEKOMST');",
    naar: '  /* mutatie: volgende maand telt weer als recent */',
  },
  // ── de zeven reparaties uit de DERDE dubbele review, op kop e9f1d19. Beide families gaven opnieuw
  // BLOKKEREND. Eén ervan zit buiten kijk.mjs, in de gedeelde lezer — vandaar `bestand`.
  {
    proef: '13 (reviewgat)',
    raakt: 'reviewgat 13 —',
    bestand: 'scripts/lib/kanaalpost.mjs',
    wat: 'een rij met een afwijkend kolomaantal sluit de tabel weer, dus alles erna verdwijnt stil',
    van: '    if (c.length !== KOPNAMEN.length) { kandidaten.push(null); continue; }',
    naar: '    if (c.length !== KOPNAMEN.length) { inTabel = false; continue; } // mutatie: kapotte rij kapt de tabel af',
  },
  {
    proef: '14 (reviewgat)',
    raakt: 'reviewgat 14 —',
    wat: 'de toestand hoeft niet meer uit de GELEZEN tekst te volgen; een gelijk etiket volstaat weer',
    van: '  if (state.bronSoort === OVERGANG_MERK) {',
    naar: '  if (false) { // mutatie: etiketgelijkheid gaat weer door voor inhoudsbinding',
  },
  {
    proef: '15 (reviewgat)',
    raakt: 'reviewgat 15 —',
    wat: 'het manifest gaat publiek zonder dat zijn eigen schema gekeurd is',
    van: '  const manifestKeuring = keurManifest(manifest, state);',
    naar: '  const manifestKeuring = { ok: true, fouten: [] }; // mutatie: manifest ongekeurd publiek',
  },
  {
    proef: '16 (reviewgat)',
    raakt: 'reviewgat 16 —',
    wat: 'de stiltemeting leest de sporen weer zonder vangnet, dus een kapotte toestand gooit een uitzondering',
    // GEMETEN: deze mutatie slaat NIET aan, en dat is hier geen zwakke proef maar een gevolg van de
    // volgorde. Elke route die een kapotte `lanes` tot híér kan brengen wordt eerder gesloten: bij het
    // OVERGANG-merk herleidt stap 2e de toestand uit de gelezen tekst (een met de hand aangepaste
    // toestand valt daar om), en zonder dat merk keurt stap 2f het manifest af, want `bronSoort` moet
    // het merk dragen. Het vangnet is dus een tweede riem zonder bereikbaar gat. Het blijft staan omdat
    // de volgorde van die poorten kan veranderen en een fail-closed lezer die een uitzondering gooit
    // helemaal geen uitkomst heeft. Dat het onbereikbaar is, staat hier expliciet in plaats van dat het
    // als "20/20" wordt weggeschreven — een niet-aanslaande mutatie verzwijgen is precies de fout die
    // deze hele proefopstelling moet voorkomen.
    bereikbaar: false,
    van: '  const momenten = Object.values(state.lanes ?? {})\n    .map((l) => (l?.momentUtc ? Date.parse(l.momentUtc) : null))',
    naar: '  const momenten = Object.values(state.lanes)\n    .map((l) => (l.momentUtc ? Date.parse(l.momentUtc) : null))',
  },
  {
    proef: '17 (reviewgat)',
    raakt: 'reviewgat 17 —',
    wat: 'verworpenRijen mag weer ontbreken en krijgt er stilzwijgend een nul bij',
    van: '  const verworpen = state.verworpenRijen;',
    naar: '  const verworpen = state.verworpenRijen ?? 0; // mutatie: het meldveld mag zelf ontbreken',
  },
  {
    proef: '18 (reviewgat)',
    raakt: 'reviewgat 18 —',
    wat: 'alléén de kalenderterugrekening op een aangeleverd spoor vervalt; de vormtoets blijft staan',
    van: '      || new Date(Date.parse(lane.momentUtc)).toISOString() !== lane.momentUtc) {',
    naar: '      || false) { // mutatie: 30 februari mag weer door de vormtoets heen',
  },
  {
    proef: '19 (reviewgat)',
    raakt: 'reviewgat 19 —',
    wat: 'de klok is weer optioneel, dus een weglating bepaalt de uitkomst in plaats van de meting',
    van: '  if (!Number.isFinite(nu)) {',
    naar: '  if (false) { // mutatie: zonder klok toch een oordeel',
  },
  // ── de zeven reparaties uit de VIERDE dubbele review, op kop 4deb499. Codex gaf BLOKKEREND met acht
  // routes, Gemini gaf AKKOORD. Die twee zijn niet tegen elkaar weggestreept maar nagemeten: zeven van
  // de acht routes bleken echt en staan hieronder, de achtste is weerlegd en staat als weerlegging in
  // de suite. Twee mutaties wijzen naar de GEDEELDE lezer, waar ook de waarnemer en de publicatieweg
  // op leunen.
  {
    proef: '20a (reviewgat)',
    raakt: 'reviewgat 20 —',
    bestand: 'scripts/lib/kanaalpost.mjs',
    wat: 'een rij buiten de tabel verdwijnt weer stil in plaats van te worden afgekeurd',
    van: '      if (c.length === KOPNAMEN.length && !isScheiding(c)) kandidaten.push(null);',
    naar: '      /* mutatie: een verweesde spiegelrij telt weer als niets */',
  },
  {
    proef: '20b (reviewgat)',
    raakt: 'reviewgat 20 —',
    bestand: 'scripts/lib/kanaalpost.mjs',
    wat: 'wat in HTML-commentaar staat telt weer als gegeven',
    van: "    if (regel.includes('<!--') && !regel.includes('-->') && !lijktSpiegelrij(regel)) {\n      inCommentaar = true;",
    naar: '    if (false) { // mutatie: verborgen tabellen worden weer gelezen\n      inCommentaar = true;',
  },
  {
    proef: '21 (reviewgat)',
    raakt: 'reviewgat 21 —',
    wat: 'een onleesbare getuigenis meldt zich weer als aanwezige getuige zonder iets te toetsen',
    van: '  if (getuigenis !== null) {\n    const leesbaar =',
    naar: '  if (false) { // mutatie: onleesbaar bewijs telt weer als bewaking\n    const leesbaar =',
  },
  {
    proef: '22 (reviewgat)',
    raakt: 'reviewgat 22 —',
    wat: 'de stiltedrempel mag weer NaN of oneindig zijn, en dan meet de versheidsmeting niets',
    van: '  if (!Number.isFinite(stilMs) || stilMs < 0 || stilMs > DREMPEL_MAX_MS) {',
    naar: '  if (false) { // mutatie: de meting is van buitenaf uit te zetten',
  },
  {
    proef: '23 (reviewgat)',
    raakt: 'reviewgat 23 —',
    wat: 'de bronblob van het manifest wordt weer nergens tegen de lezing gehouden',
    van: '  if (blobKanten === 2 && manifest.bronBlobSha !== lezing.blobSha) {',
    naar: '  if (false) { // mutatie: het blobveld wordt weer geschreven en nooit gelezen',
  },
  {
    proef: '24 (reviewgat)',
    raakt: 'reviewgat 24 —',
    wat: 'de gesloten redenenlijst is weer muteerbaar, dus vrije publieke tekst kan er weer in',
    van: 'export const REDENEN = Object.freeze({',
    naar: 'export const REDENEN = ({ // mutatie: gesloten in naam, open in werking',
  },
  {
    proef: '25 (reviewgat)',
    raakt: 'reviewgat 25 —',
    wat: 'een ophaler die gooit laat de lezer weer verwerpen in plaats van een reden op te leveren',
    van: '    const kop = await veilig(() => kopVan(), \'KOP_ONBEPAALBAAR\');',
    naar: '    const kop = await kopVan(); // mutatie: geen vangnet om de ophaal',
  },
  {
    proef: '26a (reviewgat)',
    raakt: 'reviewgat 26 —',
    bestand: 'scripts/lib/kanaalpost.mjs',
    wat: 'het codehek wisselt de stand niet meer, dus een voorbeeldtabel wordt weer echte toestand',
    van: '    if (hek && hekOpen === null) {',
    naar: '    if (false) { // mutatie: een ```-hek opent geen blok meer',
  },
  {
    proef: '26c (reviewgat)',
    raakt: 'reviewgat 26 —',
    bestand: 'scripts/lib/kanaalpost.mjs',
    wat: 'elk hek sluit weer, ook een korter of anders getekend hek — het geneste voorbeeld wordt weer toestand',
    van: '      && hek[1][0] === hekOpen[0] && hek[1].length >= hekOpen.length;',
    naar: '      && true; // mutatie: elk hek sluit, ongeacht teken of lengte',
  },
  {
    proef: '26b (reviewgat)',
    raakt: 'reviewgat 26 —',
    bestand: 'scripts/lib/kanaalpost.mjs',
    wat: 'wat binnen het hek staat wordt stil overgeslagen in plaats van afgekeurd — verstoppen wordt gratis',
    van: '    if (hekOpen !== null) {\n      inTabel = false;\n      if (lijktSpiegelrij(regel)) kandidaten.push(null);',
    naar: '    if (hekOpen !== null) {\n      inTabel = false;\n      // mutatie: binnen het hek verdwijnt alles spoorloos',
  },
  {
    proef: '27a (reviewgat)',
    raakt: 'reviewgat 27 —',
    bestand: 'scripts/lib/kanaalpost.mjs',
    wat: 'vier tekens <!-- in een tabelcel zetten de commentaarstand weer aan — de rij en alles eronder verdwijnen',
    van: "    if (regel.includes('<!--') && !regel.includes('-->') && !lijktSpiegelrij(regel)) {",
    naar: "    if (regel.includes('<!--') && !regel.includes('-->')) { // mutatie: ook een spiegelrij opent commentaar",
  },
  {
    proef: '27b (reviewgat)',
    raakt: 'reviewgat 27 —',
    bestand: 'scripts/lib/kanaalpost.mjs',
    wat: 'de staart ná --> telt niet meer mee, dus een hek op die regel opent nooit',
    van: '      regel = regel.slice(dicht + 3);',
    naar: '      inTabel = false; continue; // mutatie: alles ná --> valt weg',
  },
  {
    proef: '27c (reviewgat)',
    raakt: 'reviewgat 27 —',
    bestand: 'scripts/lib/kanaalpost.mjs',
    wat: 'een rij tussen <!-- en --> verdwijnt weer spoorloos in plaats van geteld te worden',
    van: '        if (lijktSpiegelrij(regel)) kandidaten.push(null);',
    naar: '        // mutatie: in commentaar verdwijnt alles spoorloos',
  },
  {
    proef: '27d (reviewgat)',
    raakt: 'reviewgat 27 —',
    bestand: 'scripts/lib/kanaalpost.mjs',
    wat: 'een backtick in de taalaanduiding opent weer een blok dat er niet is — een echte tabel wordt onterecht afgekeurd',
    van: "const hekGeldig = (hek) => hek[1][0] === '~' || !hek[2].includes('`');",
    naar: 'const hekGeldig = () => true; // mutatie: elke hekachtige regel opent',
  },
  {
    proef: '30-schrijfpoort (reviewgat)',
    raakt: 'reviewgat 30 —',
    bestand: 'scripts/lib/spiegelwet.mjs',
    wat: 'de schrijfkant weigert niets meer, dus een venster kan de plaat donker schrijven zonder waarschuwing',
    van: "    if (!vorm.ok) gevonden.push({ regel: i + 1, reden: `VORM_${vorm.reden}` });",
    naar: '    void vorm; // mutatie: de schrijfpoort meldt niets meer',
  },
  {
    proef: '30-alleennieuw (reviewgat)',
    raakt: 'reviewgat 30 —',
    bestand: 'scripts/lib/spiegelwet.mjs',
    wat: 'de schrijfkant kijkt naar ALLE regels in plaats van alleen de nieuwe — dan sluit één oude vuile regel de deur voor iedereen',
    van: "    if (n > 0) { telling.set(ruw, n - 1); return; }\n    const vorm = kanoniekeSpiegelvorm(ruw.replace(/\\r$/, ''));",
    naar: "    void n; // mutatie: ook oude regels tellen mee\n    const vorm = kanoniekeSpiegelvorm(ruw.replace(/\\r$/, ''));",
  },
  {
    proef: '29-poort (reviewgat)',
    raakt: 'reviewgat 29 —',
    bestand: 'scripts/lib/kanaalpost.mjs',
    wat: 'de vormpoort laat alles door, dus alle acht routes van de zesde ronde staan weer open',
    van: "  if (!vorm.ok) return { available: false, reason: 'NIET_CANONIEK', vorm, rows: [] };",
    naar: '  void vorm; // mutatie: de vormpoort weigert niets meer',
  },
  {
    proef: '29-hek (reviewgat)',
    raakt: 'reviewgat 29 —',
    bestand: 'scripts/lib/kanaalpost.mjs',
    wat: 'een codehek is geen reden meer om het bestand te weigeren',
    van: "  { reden: 'CODEHEK', test: (r) => /(`{3,}|~{3,})/.test(r) },",
    naar: '  { reden: \'CODEHEK\', test: () => false }, // mutatie: hekken zijn toegestaan',
  },
  {
    proef: '29-commentaar (reviewgat)',
    raakt: 'reviewgat 29 —',
    bestand: 'scripts/lib/kanaalpost.mjs',
    wat: 'een HTML-commentaar is geen reden meer om het bestand te weigeren',
    van: "  { reden: 'HTML_COMMENTAAR', test: (r) => r.includes('<!--') || r.includes('-->') },",
    naar: '  { reden: \'HTML_COMMENTAAR\', test: () => false }, // mutatie: commentaar is toegestaan',
  },
  {
    proef: '29-html (reviewgat)',
    raakt: 'reviewgat 29 —',
    bestand: 'scripts/lib/kanaalpost.mjs',
    wat: 'een regel die met een tag begint is geen reden meer om te weigeren — het <div>-geval van Codex staat weer open',
    van: "  { reden: 'RAUWE_HTML', test: (r) => /^ {0,3}</.test(r) },",
    naar: '  { reden: \'RAUWE_HTML\', test: () => false }, // mutatie: rauwe HTML is toegestaan',
  },
  {
    proef: '29-inspringing (reviewgat)',
    raakt: 'reviewgat 29 —',
    bestand: 'scripts/lib/kanaalpost.mjs',
    wat: 'een ingesprongen regel is geen reden meer om te weigeren — het ingesprongen-codeblok-geval staat weer open',
    van: "  { reden: 'INSPRINGING', test: (r) => /^(?: {4}|\\t)/.test(r) },",
    naar: '  { reden: \'INSPRINGING\', test: () => false }, // mutatie: inspringing is toegestaan',
  },
  {
    proef: '29-container (reviewgat)',
    raakt: 'reviewgat 29 —',
    bestand: 'scripts/lib/kanaalpost.mjs',
    wat: 'blockquote en lijstitem zijn geen reden meer om te weigeren — de containergevallen staan weer open',
    van: "  { reden: 'CONTAINER', test: (r) => /^ {0,3}(?:>|(?:[-*+]|\\d{1,9}[.)])[ \\t])/.test(r) },",
    naar: '  { reden: \'CONTAINER\', test: () => false }, // mutatie: containertekens zijn toegestaan',
  },
  {
    proef: '29-regelscheider (reviewgat)',
    raakt: 'reviewgat 29 —',
    bestand: 'scripts/lib/kanaalpost.mjs',
    wat: 'U+2028/U+2029 zijn geen reden meer om te weigeren — twee lezers mogen het weer oneens zijn over de regelindeling',
    van: "  { reden: 'REGELSCHEIDER', test: (r) => /[\\u2028\\u2029\\f\\v]/.test(r) },",
    naar: '  { reden: \'REGELSCHEIDER\', test: () => false }, // mutatie: exotische scheiders zijn toegestaan',
  },
  {
    proef: '28a (reviewgat)',
    raakt: 'reviewgat 28 —',
    bestand: 'scripts/lib/kanaalpost.mjs',
    wat: 'alleen LF telt als regeleinde, dus een CRLF-bestand laat een voorbeeldrij als toestand binnen',
    // TWEE regels als anker, en dat is geen netheid. De vormpoort splitst inmiddels op dezelfde
    // manier en staat EERDER in het bestand; met alleen de split-regel als anker muteerde
    // `String.replace` de poort in plaats van de scanner en bleef proef 28 groen — gemeten.
    van: "  // {\"sporen\":[\"CHIEF\",\"CONTROL\",\"MINI\"],\"telling\":3,\"verworpen\":0} — de voorbeeldrij MÍDDEN in het\n"
      + "  // codeblok kwam als echte toestand binnen (bevinding Codex, vijfde ronde).\n"
      + "  const regels = String(tekst ?? '').split(/\\r\\n|\\r|\\n/);",
    naar: "  const regels = String(tekst ?? '').split('\\n'); // mutatie: CRLF blijft plakken",
  },
  {
    proef: '28b (reviewgat)',
    raakt: 'reviewgat 28 —',
    bestand: 'scripts/lib/kanaalpost.mjs',
    wat: 'een containerteken voor het hek maakt het hek weer onzichtbaar — de voorbeeldtabel in een lijstitem wordt toestand',
    van: "const hekKern = (regel) => String(regel).replace(/^[ \\t]*(?:(?:>[ \\t]*)+)?(?:[-*+]|\\d{1,9}[.)])?[ \\t]*/, '');",
    naar: 'const hekKern = (regel) => String(regel); // mutatie: containertekens blijven staan',
  },
  {
    proef: '26d (reviewgat)',
    raakt: 'reviewgat 26 —',
    bestand: 'scripts/lib/kanaalpost.mjs',
    wat: 'een hek met taalaanduiding mag weer sluiten, dus ````js sluit een blok van vier backticks',
    van: '    const sluit = hek && hekOpen !== null && SLUITHEK.test(hekKern(regel))',
    naar: '    const sluit = hek && hekOpen !== null // mutatie: een sluithek mag een taalaanduiding dragen',
  },
  {
    proef: '27 (reviewgat 22, tweede meting)',
    raakt: 'reviewgat 22 —',
    wat: 'de bovengrens op de stiltedrempel vervalt, dus een drempel van duizend jaar mag weer',
    van: '  if (!Number.isFinite(stilMs) || stilMs < 0 || stilMs > DREMPEL_MAX_MS) {',
    naar: '  if (!Number.isFinite(stilMs) || stilMs < 0) { // mutatie: alleen de vorm, niet de betekenis',
  },
  {
    proef: '28 (reviewgat 23, tweede meting)',
    raakt: 'reviewgat 23 —',
    wat: 'één kant van de bestandshash mag weer ontbreken zonder dat er iets wordt gemeld',
    van: '  if (blobKanten === 1) {',
    naar: '  if (false) { // mutatie: ontbrekend tegenbewijs gaat weer stil door',
  },
];

/** Draai de suite en geef terug welke proeven faalden. */
function gefaaldeProeven() {
  try {
    execFileSync(process.execPath, ['--test', '--test-reporter=tap', SUITE], { cwd: ROOT, encoding: 'utf8' });
    return [];
  } catch (e) {
    const tap = `${e.stdout ?? ''}`;
    return [...tap.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
  }
}

const basis = gefaaldeProeven();
if (basis.length) {
  console.log('De suite is niet groen vóór de mutaties; eerst repareren:');
  for (const p of basis) console.log(`  ${p}`);
  process.exit(1);
}
console.log('uitgangspunt: de suite is groen zonder mutaties.\n');

let alleAangeslagen = true;
for (const m of MUTATIES) {
  const rel = m.bestand ?? STANDAARDDOEL;
  const doel = join(ROOT, rel);
  const origineel = lees(rel);
  if (!origineel.includes(m.van)) {
    console.log(`proef ${m.proef}: MUTATIE PAST NIET — het ankerfragment staat niet in ${rel}`);
    alleAangeslagen = false;
    continue;
  }
  writeFileSync(doel, origineel.replace(m.van, m.naar), 'utf8');
  const gefaald = gefaaldeProeven();
  writeFileSync(doel, origineel, 'utf8');

  // De naamvergelijking loopt tot en met het liggende streepje, niet tot de spatie ervoor. Zonder dat
  // streepje zou `reviewgat 2` ook `reviewgat 20` t/m `reviewgat 25` opeisen en `proef 3` ook `proef
  // 3b` — dan lijkt een mutatie aan te slaan terwijl een heel andere proef omvalt.
  const geraakt = gefaald.filter((naam) => naam.startsWith(m.raakt));
  const aangeslagen = geraakt.length > 0;
  // Eén mutatie is vooraf als ONBEREIKBAAR aangemerkt: een vangnet waar geen route meer naartoe loopt
  // omdat eerdere poorten alles afvangen. Die mag groen blijven — maar dan wél als afwijking gemeld,
  // en NIET als hij tegen de verwachting in tóch aanslaat, want dan is de route er wel degelijk.
  const verwachtBereikbaar = m.bereikbaar !== false;
  const inOrde = verwachtBereikbaar ? aangeslagen : !aangeslagen;
  if (!inOrde) alleAangeslagen = false;
  const oordeelRegel = verwachtBereikbaar
    ? (aangeslagen ? 'ROOD zoals bedoeld' : 'BLEEF GROEN — de proef meet niets')
    : (aangeslagen ? 'SLOEG AAN terwijl hij onbereikbaar heette — de aanname klopt niet' : 'BLEEF GROEN, zoals vooraf verklaard (vangnet zonder bereikbaar pad)');
  console.log(`proef ${m.proef}: ${oordeelRegel}`);
  console.log(`   ingreep: ${m.wat}`);
  console.log(`   gevallen proeven: ${gefaald.length ? gefaald.map((n) => `"${n.slice(0, 60)}…"`).join(', ') : 'geen'}`);
}

const onbereikbaar = MUTATIES.filter((m) => m.bereikbaar === false).length;
const na = gefaaldeProeven();
console.log(`\nna herstel is de suite weer groen: ${na.length === 0}`);
console.log(alleAangeslagen
  ? `\n${MUTATIES.length - onbereikbaar} van de ${MUTATIES.length} mechanismen zijn aantoonbaar nodig: haal er één weg en de bijbehorende proef valt om.`
    + `\n${onbereikbaar} staat er als vooraf verklaard vangnet zonder bereikbaar pad; de reden staat bij de mutatie zelf.`
  : '\nLET OP: niet elke mutatie deed wat ervan verwacht werd — dat is een bevinding, geen detail.');
process.exit(alleAangeslagen && na.length === 0 ? 0 : 1);
