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
const DOEL = join(ROOT, 'scripts/lib/kijk.mjs');
const SUITE = join(ROOT, 'test/kijk.test.mjs');
const ORIGINEEL = readFileSync(DOEL, 'utf8');

/** Per proef: waar hij over gaat, en welke ingreep het mechanisme eronder weghaalt. */
const MUTATIES = [
  {
    proef: 1,
    raakt: 'proef 1',
    wat: 'de vergelijking van de paginacommit met de actuele kop vervalt',
    van: "if (paginaHerkomst.commitSha !== lezing.sha) redenen.push('PAGINA_ANDERE_COMMIT');",
    naar: '/* mutatie: commitvergelijking weg */',
  },
  {
    proef: 2,
    raakt: 'proef 2',
    wat: 'de kop wordt na het ophalen niet opnieuw gelezen',
    van: '    const naKop = await kopVan();',
    naar: '    const naKop = { ok: true, sha: kop.sha }; // mutatie: nooit opnieuw lezen',
  },
  {
    proef: 3,
    raakt: 'proef 3',
    wat: 'de NL-kolom wordt weer als UTC gelezen, zoals de oude rijMoment deed',
    van: '  let t = alsUtc;',
    naar: '  return alsUtc; let t = alsUtc; // mutatie: zone niet opzoeken',
  },
  {
    proef: 4,
    raakt: 'proef 4',
    wat: 'de toestandshash van de pagina wordt niet meer vergeleken',
    van: "    if (manifest && paginaHerkomst.stateSha256 !== manifest.stateSha256) redenen.push('PAGINA_ANDERE_TOESTAND');",
    naar: '    /* mutatie: hashvergelijking weg */',
  },
  {
    proef: 5,
    raakt: 'proef 5',
    wat: 'stille sporen worden niet meer opgespoord',
    van: '  const lanes = Object.values(state?.lanes ?? {});\n  const momenten',
    naar: '  const lanes = []; const _weg = Object.values(state?.lanes ?? {});\n  const momenten',
  },
  {
    proef: 6,
    raakt: 'proef 6',
    wat: 'de publieke toestand krijgt er één vrij tekstveld bij',
    van: '      eventUitkomst: \'GEEN\',',
    naar: '      eventUitkomst: \'GEEN\',\n      onderwerp: r.onderwerp, // mutatie: vrije tekst in de publieke toestand',
  },
  {
    proef: 7,
    raakt: 'proef 7',
    wat: 'het geheugen van de getuige wordt niet meer geraadpleegd',
    van: '  if (getuigenis && state) {',
    naar: '  if (false && getuigenis && state) { // mutatie: getuige genegeerd',
  },
  {
    proef: 8,
    raakt: 'proef 8',
    wat: 'een mislukte lezing levert weer een gewoon oordeel in plaats van GEEN OORDEEL',
    van: "    return uit('GEEN OORDEEL');\n  }\n  gemeten.kopSha = lezing.sha;",
    naar: "    return uit('GROEN'); // mutatie: onwetendheid doet zich voor als kennis\n  }\n  gemeten.kopSha = lezing.sha;",
  },
  // ── de zes reparaties uit de dubbele review op kop 579ad57. Codex' punt was expliciet dat de acht
  // mutaties hierboven de ANKERS bewijzen en niet het fail-closed-contract; deze zes sluiten dat gat.
  {
    proef: '1 (reviewgat)',
    raakt: 'reviewgat 1',
    wat: 'een toestand zonder enig spoor telt weer als een gezonde lege toestand',
    van: "    fouten.push('GEEN_SPOREN');",
    naar: '    /* mutatie: nul sporen is weer geen bevinding */',
  },
  {
    proef: '2 (reviewgat)',
    raakt: 'reviewgat 2',
    wat: 'een weggelaten manifest of weggelaten bytes slaat de hashcontrole weer stilzwijgend over',
    van: '  if (!state || !manifest || !stateBytes) {',
    naar: '  if (false) { // mutatie: ontbrekend bewijs mag weer doorlopen',
  },
  {
    proef: '3 (reviewgat)',
    raakt: 'reviewgat 3',
    wat: 'de bytes worden niet meer aan déze toestand vastgemaakt',
    van: '  if (!kanoniekeBytes(state).equals(Buffer.from(stateBytes))) {',
    naar: '  if (false) { // mutatie: bytes van A mogen weer bij toestand B',
  },
  {
    proef: '4 (reviewgat)',
    raakt: 'reviewgat 4',
    wat: 'de sleutellijst van de toestand is niet meer gesloten',
    van: "  if (Object.keys(state).some((k) => !STATE_SLEUTELS.includes(k))) fouten.push('VELD_NIET_GESLOTEN');",
    naar: '  /* mutatie: onbekende velden bovenin de toestand mogen weer */',
  },
  {
    proef: '5 (reviewgat)',
    raakt: 'reviewgat 5',
    wat: 'de absolute vloer onder de totale uitval vervalt',
    van: '  const allesStil = nu !== null && momenten.length > 0 && nu - Math.max(...momenten) > stilMs;',
    naar: '  const allesStil = false; // mutatie: alles tegelijk stil is weer groen',
  },
  {
    proef: '6 (reviewgat)',
    raakt: 'reviewgat 6',
    wat: 'de kalenderterugrekening vervalt, dus 30 februari wordt weer een geldig moment',
    van: '  if (d.getUTCFullYear() !== +jj || d.getUTCMonth() !== +mm - 1 || d.getUTCDate() !== +dd',
    naar: '  if (false && d.getUTCFullYear() !== +jj || false && d.getUTCMonth() !== +mm - 1 || false && d.getUTCDate() !== +dd',
  },
  // ── de zes reparaties uit de tweede dubbele review, op kop 31984b5. Beide families gaven daar
  // BLOKKEREND; Codex mat elke route zelf na. Ook hier geldt: pas als de reparatie eruit halen een
  // proef omvergooit, meet die proef het contract en niet alleen zijn eigen anker.
  {
    proef: '7 (reviewgat)',
    raakt: 'reviewgat 7',
    wat: 'een rij die de vormtoets niet haalt telt weer niet mee, dus schuift alles erna een plaats op',
    van: "    if (r === null) { fouten.push('VELD_NIET_GESLOTEN'); continue; }",
    naar: '    if (r === null) { teller -= 1; continue; } // mutatie: stille verdwijning vóór de teller',
  },
  {
    proef: '8 (reviewgat)',
    raakt: 'reviewgat 8',
    wat: 'een aangeleverd spoor mag zijn tijd weer missen, en dan meet geen enkele stiltemeting iets',
    // Bewust NIET geankerd op de gelijknamige wacht in `kijkStateUitSpiegel`: de vormtoets van de
    // spiegel keurt datum en tijd al even streng, dus die tak is via de spiegel niet te bereiken en een
    // mutatie erop zou groen blijven zonder dat dat iets zegt. Hij blijft als tweede riem staan voor het
    // geval de twee lezers ooit uiteenlopen. De tak die WEL bereikbaar is, is deze: `oordeel()` krijgt
    // de toestand aangeleverd, en daar liet de vormtoets een lege tijd door.
    // De twee helften vangen elk apart een lege tijd (`String(null)` haalt de vorm niet én
    // `Date.parse(null)` is NaN), dus één regel wegnemen laat de controle staan. De hele toets moet
    // eruit om te bewijzen dat de proef hem meet.
    van: "    if (!/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/.test(String(lane.momentUtc))\n"
      + '      || Number.isNaN(Date.parse(lane.momentUtc))) {\n'
      + "      fouten.push('VELD_NIET_GESLOTEN');\n"
      + '    }',
    naar: '    /* mutatie: een aangeleverd spoor mag zijn tijd weer missen */',
  },
  {
    proef: '9 (reviewgat)',
    raakt: 'reviewgat 9',
    wat: 'de bewijsketen wordt niet meer aan de gelezen bron vastgemaakt',
    van: '  if (state.bronCommitSha !== lezing.sha || manifest.bronCommitSha !== lezing.sha) {',
    naar: '  if (false) { // mutatie: een bewijs dat alleen zichzelf bewijst mag weer',
  },
  {
    proef: '10 (reviewgat)',
    raakt: 'reviewgat 10',
    wat: 'de toegestane sleutels krijgen hun waardedomein niet meer gecontroleerd',
    van: "  if (state.bronSoort !== OVERGANG_MERK) fouten.push('VELD_NIET_GESLOTEN');",
    naar: '  /* mutatie: gesloten sleutel, vrije waarde */',
  },
  {
    proef: '11 (reviewgat)',
    raakt: 'reviewgat 11',
    wat: 'de absolute vloer krijgt haar oude eigen return terug en maskeert de onderlinge meting weer',
    van: "  if (allesStil) redenen.push('ALLES_STIL');",
    naar: "  if (allesStil) { redenen.push('ALLES_STIL'); return uit('PARTIAL'); } // mutatie: (a) verbergt (b)",
  },
  {
    proef: '12 (reviewgat)',
    raakt: 'reviewgat 12',
    wat: 'een tijdstip uit de toekomst is weer geen bevinding, en zet daarmee de stiltemeting uit',
    van: "  if (nu !== null && momenten.some((t) => t > nu + TOEKOMST_MARGE)) redenen.push('TIJD_UIT_DE_TOEKOMST');",
    naar: '  /* mutatie: volgende maand telt weer als recent */',
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
  if (!ORIGINEEL.includes(m.van)) {
    console.log(`proef ${m.proef}: MUTATIE PAST NIET — het ankerfragment staat niet in kijk.mjs`);
    alleAangeslagen = false;
    continue;
  }
  writeFileSync(DOEL, ORIGINEEL.replace(m.van, m.naar), 'utf8');
  const gefaald = gefaaldeProeven();
  writeFileSync(DOEL, ORIGINEEL, 'utf8');

  const geraakt = gefaald.filter((naam) => naam.startsWith(m.raakt));
  const aangeslagen = geraakt.length > 0;
  if (!aangeslagen) alleAangeslagen = false;
  console.log(`proef ${m.proef}: ${aangeslagen ? 'ROOD zoals bedoeld' : 'BLEEF GROEN — de proef meet niets'}`);
  console.log(`   ingreep: ${m.wat}`);
  console.log(`   gevallen proeven: ${gefaald.length ? gefaald.map((n) => `"${n.slice(0, 60)}…"`).join(', ') : 'geen'}`);
}

const na = gefaaldeProeven();
console.log(`\nna herstel is de suite weer groen: ${na.length === 0}`);
console.log(alleAangeslagen
  ? `\nAlle ${MUTATIES.length} mechanismen zijn aantoonbaar nodig: haal er één weg en de bijbehorende proef valt om.`
  : '\nLET OP: niet elke mutatie sloeg aan — dat is een bevinding, geen detail.');
process.exit(alleAangeslagen && na.length === 0 ? 0 : 1);
