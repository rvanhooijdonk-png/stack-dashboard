/**
 * BROWSERVEILIGHEID — draaien de modules die de plaat NAAR DE BROWSER kopieert ook zónder `process`?
 *
 * Dit is de proef die er niet was. `CLIENT_POLL_FILES` (publish-files.mjs) verhuist negen modules
 * naar `public/`, waar ze in een echte browser draaien. Daar bestaat `process` niet — maar élke
 * Node-test draait mét `process`, dus een Node-only verwijzing in die modules is in deze suite
 * onzichtbaar. Zo kon `evidenceUrlPrefixes(env = process.env)` als standaardwaarde blijven staan:
 * groen in 1231 tests, en in Chrome een ReferenceError zodra `renderActive()` één record met
 * claimbewijs tegenkwam. Die fout werd door `pollOnce()` opgevangen en als UNKNOWN getoond, dus de
 * plaat meldde niet dat ze stuk was — client-side polling toonde nooit één gerenderde feed.
 * Vastgesteld tegen een draaiende Chrome (CDP), niet tegen een mock.
 *
 * Twee tanden, expres allebei:
 *  - de STATISCHE tand leest de bronbestanden en verbiedt Node-only constructies in de hele
 *    clientgraaf, zodat een nieuwe module niet opnieuw langs deze kant kan binnenkomen;
 *  - de DYNAMISCHE tand haalt `process` werkelijk uit `globalThis` en rendert dan een echte feed.
 *    Alleen die tand bewijst dat de standaardwaarde ook echt niet meer geëvalueerd wordt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execPath } from 'node:process';
import { CLIENT_POLL_FILES } from '../scripts/lib/publish-files.mjs';
import { parseRuntimeFeed } from '../scripts/lib/runtime-feed.mjs';
import { renderActive } from '../scripts/lib/runtime-feed-view.mjs';
import { nuBezigPaneel, renderNuBezigBody } from '../scripts/lib/paneel-nu-bezig.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NU = new Date('2026-08-12T12:00:00Z');

/**
 * De wachter leest de bron, niet een AST — de repository heeft nul afhankelijkheden en er komt geen
 * parser bij voor deze proef. Dat maakt de VORM van de regel belangrijk: een tekstuele wachter is
 * precies zo sterk als zijn zwakste omweg. De eerste versie had er vier (review Gemini, ronde 1):
 * een regel met zowel een geldige `typeof`-wachter als een kale `process.env` glipte er langs; de
 * wachter accepteerde alleen enkele quotes rond `'undefined'`; `const p = process` en
 * `const { env } = process` — allebei net zo fataal in de browser — matchten niet; en een lokale
 * variabele die toevallig `process` heet gaf vals alarm.
 *
 * Die vier verdwijnen niet door de regex slimmer te maken maar door de REGEL simpeler te maken:
 * geen enkele kale `process` in de clientgraaf, punt. De drie plekken die de Node-omgeving echt
 * nodig hebben lezen nu `globalThis.process?…` — een property-lezing die in de browser gewoon
 * `undefined` oplevert in plaats van te werpen, en die deze wachter niet raakt omdat er een punt
 * vóór staat. De enige lokale variabele die `process` heette is hernoemd (`runtime-feed-view.mjs`,
 * `[name, proces]`), zodat de wachter geen uitzondering hoeft te kennen — en dus ook niet per
 * ongeluk te ruim kan staan.
 *
 * Commentaar en tekenreeksen worden weggesneden vóór het meten: het woord `process` in een uitleg
 * of in een foutmelding is geen lezing van de global.
 *
 * STATISCHE `node:`-imports zijn verboden, DYNAMISCHE niet. `import … from 'node:fs'` draait altijd
 * en breekt de module in de browser; `isNode ? await import('node:fs') : null` is juist het patroon
 * waarmee deze bestanden aan beide kanten laadbaar blijven.
 */
const LEZING = /(?<![.\w$])process(?![\w$])/g;
const NODE_IMPORT = /from\s+['"`]node:|(?<![.\w$])require\s*\(/;

/** Snijdt blok- en regelcommentaar weg; tekenreeksen blijven staan tot na de regelsplitsing. */
function zonderCommentaar(bron) {
  return bron.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Snijdt tekenreeksen weg — `'process.env'` als tekst is geen lezing van de global. */
function zonderTekenreeksen(regel) {
  return regel
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

/**
 * True zodra deze coderegel iets doet wat in een browser stukloopt. De twee wachters kijken
 * bewust naar een andere versie van de regel: `LEZING` naar de regel ZONDER tekenreeksen (het woord
 * in een foutmelding is geen lezing van de global), `NODE_IMPORT` juist naar de regel MÉT — het
 * modulepad staat immers zelf in een tekenreeks.
 */
function isOvertreding(regel) {
  LEZING.lastIndex = 0;
  return LEZING.test(zonderTekenreeksen(regel)) || NODE_IMPORT.test(regel);
}

test('geen enkele naar de browser gekopieerde module leest een Node-only global', async () => {
  const overtredingen = [];
  for (const naam of CLIENT_POLL_FILES) {
    const bron = await readFile(join(ROOT, 'scripts/lib', naam), 'utf8');
    zonderCommentaar(bron).split('\n').forEach((regel, i) => {
      if (isOvertreding(regel)) overtredingen.push(`${naam}:${i + 1}: ${regel.trim()}`);
    });
  }
  assert.deepEqual(overtredingen, [], `Node-only verwijzing in een browsermodule:\n${overtredingen.join('\n')}`);
});

test('de wachter zelf laat de bekende omwegen niet door', () => {
  // Zonder deze proef is de vorige test alleen zo sterk als zijn regex, en dat is precies waar de
  // eerste versie op stukliep. Elke regel hieronder is een omweg die er ooit langs kwam.
  for (const regel of [
    "const isNode = typeof process !== 'undefined'; const env = process.env;",
    'const p = process;',
    'const { env } = process;',
    'const waarde = process["env"];',
    "import { readFile } from 'node:fs/promises';",
    'import { readFile } from "node:fs/promises";',
    "const fs = require('node:fs');",
  ]) assert.equal(isOvertreding(regel), true, `omweg glipte langs de wachter: ${regel}`);

  // En de keerzijde: de correcte vormen mogen niet als overtreding gelden, anders wordt de wachter
  // genegeerd zodra hij vals alarm geeft.
  for (const regel of [
    'const isNode = !!globalThis.process?.versions?.node;',
    'return globalThis.process?.env ?? {};',
    "const tekst = 'process.env in een tekenreeks';",
    'const namen = Object.keys(feed.processes ?? {});',
    "const fsMod = isNode ? await import('node:fs') : null;",
  ]) assert.equal(isOvertreding(regel), false, `vals alarm op een toegestane vorm: ${regel}`);
});

test('de HELE clientgraaf laadt in een proces zonder globale process', async () => {
  // De derde tand, en de scherpste (review Codex, ronde 1). De twee proeven hierboven meten de
  // brontekst en één renderpad, maar allebei nádat de modules al geladen zijn — mét `process`
  // aanwezig. Een Node-global op MODULENIVEAU (`const x = process.env.FOO` buiten elke functie)
  // wordt daardoor door geen van beide dynamisch geraakt: die werpt bij het LADEN, en op dat moment
  // bestond `process` nog.
  //
  // Daarom een apart proces: daar wordt `globalThis.process` verwijderd VÓÓR de eerste import en
  // pas erna teruggezet. Dat is precies de volgorde van een browser. In deze suite zelf kan het
  // niet, want tussen de imports liggen ticks waarin de testrunner zélf `process` nodig heeft.
  const imports = CLIENT_POLL_FILES
    .map((naam) => `  await import(${JSON.stringify(pathToFileURL(join(ROOT, 'scripts/lib', naam)).href)});`)
    .join('\n');
  const script = [
    // runtime-poll.mjs raakt bij het laden de DOM aan (fail-closed pad). Een minimale stub, want
    // deze proef meet of de modules LADEN, niet wat ze renderen — dat doet de proef hierboven.
    'globalThis.document = { querySelector: () => null, getElementById: () => null };',
    'const echte = globalThis.process;',
    'delete globalThis.process;',
    'let fout = null;',
    'try {',
    imports,
    '} catch (f) { fout = f; }',
    'globalThis.process = echte;',
    'if (fout) { console.error(String(fout.stack ?? fout)); process.exitCode = 1; }',
    "else console.log('clientgraaf geladen zonder process');",
  ].join('\n');

  const { stdout } = await promisify(execFile)(execPath, ['--input-type=module', '-e', script]);
  assert.match(stdout, /clientgraaf geladen zonder process/);
});

test('renderActive() en het NU-BEZIG-paneel renderen een echte feed zonder globale process', async () => {
  const ruw = JSON.parse(await readFile(join(ROOT, 'test/fixtures/runtime-feed/volledig-gezond.json'), 'utf8'));
  const feed = parseRuntimeFeed(ruw, { now: NU });
  // De fixture draagt claimbewijs; juist dát record raakt `evidenceUrlPrefixes()`. Zonder die
  // controle zou deze proef ook groen zijn op een feed die de standaardwaarde nooit aanroept.
  assert.equal(feed.actors.some((a) => a?.current_task?.pickup?.evidence_ref?.ref), true);

  const echte = globalThis.process;
  let sectie; let paneel; let fout = null;
  try {
    // Alles hierbinnen is synchroon: de testrunner zelf leunt op `process`, dus het gat mag geen
    // enkele tick duren.
    delete globalThis.process;
    try {
      sectie = renderActive(feed, NU.getTime());
      paneel = renderNuBezigBody(nuBezigPaneel(feed, NU.getTime()));
    } catch (f) { fout = f; }
  } finally {
    globalThis.process = echte;
  }

  assert.equal(fout, null, `renderen faalde zonder process: ${fout && fout.stack}`);
  assert.match(sectie, /IN UITVOERING · /);
  // Zonder `process` is er geen Actions-context, dus alleen de historische eigenaar blijft over —
  // de link hoort te blijven werken, niet stilletjes te verdwijnen.
  assert.match(sectie, /claimbewijs: RECEIPT_ID:receipt-task-100/);
  assert.match(paneel, /1 van 1 taakregels/);
});
