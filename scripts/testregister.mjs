#!/usr/bin/env node
/**
 * TESTREGISTER — niet-gedraaid is rood.
 *
 * HET PROBLEEM. `node --test` zonder argumenten zoekt zelf zijn testbestanden op, en meldt exit 0
 * als het er nul vindt. Een hernoemd bestand, een verplaatste map, een verkeerd glob-patroon, een
 * `import` die stilletjes faalt in één bestand terwijl de rest doorloopt: in al die gevallen wordt
 * de suite groener dan hij is, want proeven die niet gedraaid hebben, kunnen ook niet falen. De
 * bestaande ondergrens (TESTS_ONDERGRENS in publish.yml) ving alleen de totale instorting — negen
 * spiegeltests die stilvallen terwijl er elders vijftig bijkomen, blijft daar onzichtbaar.
 *
 * DE OPLOSSING. `test/register.json` verklaart per bestand hoeveel proeven het minstens oplevert en
 * welke proeven er met naam en al bij horen. Dit script draait elk geregistreerd bestand APART, zodat
 * de telling per bestand toe te rekenen is (in één gezamenlijke run is de TAP-uitvoer vlak en kun je
 * niet zien welk bestand welke proef leverde). Dan controleert het drie dingen:
 *
 *   1. de verzameling bestanden op schijf is exact de verzameling in het register — een nieuw
 *      testbestand dat niemand registreert is net zo goed onzichtbaar als een bestand dat weg is;
 *   2. per bestand: nul fouten, en minstens het verklaarde aantal geslaagde proeven;
 *   3. per bestand: elke met-naam-verklaarde proef staat er, en staat er als `ok`.
 *
 * Punt 3 is wat de negen auditvormen duurzaam maakt. Wie `M-NEG-004` weghaalt of hernoemt, moet dat
 * in het register doen — en dat is een zichtbare regel in een diff, geen stilte.
 *
 * WAT DIT NIET DOET. Het bewijst niet dat de proeven ergens over gáán; een lege `test()` telt mee.
 * Het is een aanwezigheidspoort, geen kwaliteitsoordeel. Die grens is met opzet: een poort die
 * inhoud probeert te beoordelen, wordt een poort die je leert omzeilen.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TESTMAP = join(ROOT, 'test');
const REGISTER = join(TESTMAP, 'register.json');

/**
 * De bestanden die `node --test` in `test/` als proefbestand zou oppakken.
 *
 * Dit moet MEER zijn dan `*.test.mjs`, en dat is niet vanzelfsprekend. Node behandelt élk
 * `.js`/`.mjs`/`.cjs`-bestand in een map die `test` heet als testbestand — ook zonder `.test.` in de
 * naam, en ook in onderliggende mappen als `test/fixtures/`. Gemeten op node 24.14.1: van
 * `a.test.mjs`, `b.test.js`, `c.spec.js`, `gewoon.mjs`, `fixtures/d.mjs` en `fixtures/e.test.mjs`
 * werden alle zes gedraaid.
 *
 * Keek dit alleen naar `*.test.mjs` — zoals de eerste versie deed — dan was er een gat: een bestand
 * `test/onveilig.test.js` draait wel mee in CI maar staat buiten het register (bevinding review
 * Gemini, 26-07-2026, hier nagemeten en breder gebleken dan gemeld). Dan kun je proeven toevoegen
 * die niemand heeft verklaard, en dat is precies de blinde vlek die dit register moet wegnemen.
 */
export function testbestandenOpSchijf(map = TESTMAP, prefix = '') {
  const uit = [];
  for (const item of readdirSync(map, { withFileTypes: true })) {
    const pad = `${prefix}${item.name}`;
    if (item.isDirectory()) uit.push(...testbestandenOpSchijf(join(map, item.name), `${pad}/`));
    else if (/\.(?:js|mjs|cjs)$/.test(item.name)) uit.push(pad);
  }
  return uit.sort();
}

export function leesRegister(pad = REGISTER) {
  const raw = JSON.parse(readFileSync(pad, 'utf8'));
  if (raw?.versie !== 1) throw new Error('register: onbekende versie');
  if (!raw.bestanden || typeof raw.bestanden !== 'object') throw new Error('register: geen bestanden');
  return raw;
}

/** Symmetrisch verschil tussen register en schijf. Leeg = in orde. */
export function registerVerschil(register, opSchijf) {
  const verklaard = Object.keys(register.bestanden).sort();
  return {
    nietGeregistreerd: opSchijf.filter((n) => !verklaard.includes(n)),
    ontbreektOpSchijf: verklaard.filter((n) => !opSchijf.includes(n)),
  };
}

/** Leest uit een TAP-tekst de namen van geslaagde proeven, plus de tellingen. */
export function leesTap(tekst) {
  const geslaagd = new Set();
  const gefaald = [];
  for (const regel of tekst.split('\n')) {
    const ok = /^ok \d+ - (.*)$/.exec(regel);
    if (ok) { geslaagd.add(ok[1].trim()); continue; }
    const niet = /^not ok \d+ - (.*)$/.exec(regel);
    if (niet) gefaald.push(niet[1].trim());
  }
  const getal = (label) => {
    const m = new RegExp(`^# ${label} (\\d+)$`, 'm').exec(tekst);
    return m ? Number(m[1]) : null;
  };
  return { geslaagd, gefaald, pass: getal('pass'), fail: getal('fail') };
}

function main() {
  const register = leesRegister();
  const opSchijf = testbestandenOpSchijf();
  const fouten = [];

  const verschil = registerVerschil(register, opSchijf);
  for (const n of verschil.nietGeregistreerd) fouten.push(`${n}: staat op schijf maar niet in test/register.json — voeg toe, anders kan dit bestand ongemerkt stilvallen`);
  for (const n of verschil.ontbreektOpSchijf) fouten.push(`${n}: staat in het register maar niet op schijf — hernoemd of verwijderd?`);

  let totaal = 0;
  for (const [naam, eis] of Object.entries(register.bestanden)) {
    if (verschil.ontbreektOpSchijf.includes(naam)) continue;
    const uit = spawnSync(process.execPath, ['--test', '--test-reporter=tap', join(TESTMAP, naam)], { encoding: 'utf8' });
    const tap = leesTap(`${uit.stdout ?? ''}\n${uit.stderr ?? ''}`);
    const aantal = tap.pass ?? 0;
    totaal += aantal;
    if (tap.fail) fouten.push(`${naam}: ${tap.fail} proef(en) rood — ${tap.gefaald.slice(0, 3).join(' | ')}`);
    if (aantal < eis.minimaal) fouten.push(`${naam}: ${aantal} geslaagde proeven < verklaard minimum ${eis.minimaal}`);
    for (const moet of eis.moetBevatten ?? []) {
      if (!tap.geslaagd.has(moet)) fouten.push(`${naam}: verklaarde proef ontbreekt of is niet groen — "${moet}"`);
    }
    console.log(`${aantal.toString().padStart(3)} ✓  ${naam}${(eis.moetBevatten ?? []).length ? ` (${eis.moetBevatten.length} met naam verklaard)` : ''}`);
  }

  if (totaal < register.ondergrens_totaal) {
    fouten.push(`totaal ${totaal} geslaagde proeven < ondergrens ${register.ondergrens_totaal}`);
  }

  if (fouten.length) {
    for (const f of fouten) console.error(`::error title=Testregister::${f}`);
    console.error(`\nTestregister: ${fouten.length} bevinding(en). Niet-gedraaid is rood — er wordt niet gepubliceerd.`);
    process.exit(1);
  }
  console.log(`\nTestregister in orde: ${opSchijf.length} bestanden, ${totaal} geslaagde proeven (ondergrens ${register.ondergrens_totaal}).`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
