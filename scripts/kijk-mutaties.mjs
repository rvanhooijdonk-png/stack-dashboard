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
  ? '\nAlle acht mechanismen zijn aantoonbaar nodig: haal er één weg en de bijbehorende proef valt om.'
  : '\nLET OP: niet elke mutatie sloeg aan — dat is een bevinding, geen detail.');
process.exit(alleAangeslagen && na.length === 0 ? 0 : 1);
