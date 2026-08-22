/**
 * PUBLISH-CACHEPOORT — het contract rond de runtime-feed-cache in `.github/workflows/publish.yml`.
 *
 * Issue #77. De groene `publish`-run `32596205038` (main @`24db715`) meldde op de savestap
 * `Path Validation Error: Path(s) specified in the action for caching do(es) not exist` gevolgd
 * door `Cache save failed`, terwijl het commentaar erboven beweerde dat `actions/cache/save` een
 * ontbrekend bestand stil overslaat. Die belofte stond in PROZA en werd daarom nooit weerlegd.
 * Hier staat hij als MEETBAAR contract, zodat dezelfde onwaarheid geen tweede keer kan ontstaan.
 *
 * De gemeten oorzaak zit niet in de actie: `publish.yml` start `scripts/build.mjs` zonder
 * `--runtime-feed`, en `loadRuntimeFeed()` schrijft de cache uitsluitend ná een geslaagde LIVE
 * lezing. Het pad bestaat op een verse runner dus structureel niet, en een onvoorwaardelijke save
 * is daarmee per definitie een save van niets.
 *
 * HERGEBRUIK: de lexicale YAML-lezer (`structureLines`, `extractJobs`) wordt geleend van
 * `scripts/autocoding/workflow-trust.mjs` in plaats van hier een tweede te bouwen. Dit project
 * heeft bewust nul dependencies en dus geen YAML-parser; twee eigen lezers zouden onvermijdelijk
 * uit elkaar gaan lopen, en dan meet de ene poort iets anders dan de andere.
 *
 * Blok-scalars (`run: |`, `restore-keys: |`) laat die lezer bewust vallen — het zijn geen
 * YAML-structuurregels. Wat dit bestand daarvan nodig heeft, leest het daarom apart uit de RUWE
 * tekst; zie `blockScalarOf()`.
 */

import { structureLines, extractJobs } from '../autocoding/workflow-trust.mjs';

/** Het enige pad dat gecachet wordt. Drie stappen moeten het exact eender spellen. */
export const RUNTIME_CACHE_PATH = '.local/runtime-feed-last-known-good.json';

/**
 * De sleutel is per ref gescoped (`github.ref_name`, zodat geen enkele ref de cache van een andere
 * kan lezen) én per poging onveranderlijk (`run_id` + `run_attempt`, omdat caches immutable zijn en
 * een tweede poging anders stil zou falen op een bestaande sleutel). Beide eigenschappen zijn
 * eerdere reviewcorrecties; ze staan hier zodat een latere "opschoning" ze niet ongemerkt sloopt.
 */
export const RUNTIME_CACHE_KEY =
  'runtime-feed-lkg-${{ github.ref_name }}-${{ github.run_id }}-${{ github.run_attempt }}';

/** De prefix waarmee de herstelstap de meest recente eerdere cache van DEZELFDE ref oppakt. */
export const RUNTIME_CACHE_RESTORE_KEY = 'runtime-feed-lkg-${{ github.ref_name }}-';

export const CACHE_VIOLATION = Object.freeze({
  SAVE_STEP_MISSING: 'SAVE_STEP_MISSING',
  RESTORE_STEP_MISSING: 'RESTORE_STEP_MISSING',
  SAVE_NOT_GUARDED_BY_PROBE: 'SAVE_NOT_GUARDED_BY_PROBE',
  SAVE_NOT_ALWAYS: 'SAVE_NOT_ALWAYS',
  PROBE_STEP_MISSING: 'PROBE_STEP_MISSING',
  PROBE_AFTER_SAVE: 'PROBE_AFTER_SAVE',
  PROBE_NOT_ALWAYS: 'PROBE_NOT_ALWAYS',
  PROBE_PATH_MISMATCH: 'PROBE_PATH_MISMATCH',
  PROBE_OUTPUT_NOT_WRITTEN: 'PROBE_OUTPUT_NOT_WRITTEN',
  PROBE_FOLLOWS_SYMLINK: 'PROBE_FOLLOWS_SYMLINK',
  CACHE_PATH_MISMATCH: 'CACHE_PATH_MISMATCH',
  CACHE_KEY_MISMATCH: 'CACHE_KEY_MISMATCH',
  RESTORE_KEY_MISMATCH: 'RESTORE_KEY_MISMATCH',
});

const PAD_RE = RUNTIME_CACHE_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `[ -f pad ]` DEREFERENCEERT: een symlink naar een regulier bestand geeft true. Gemeten in de
 * Codex-review op deze branch, en daarmee is "alleen een regulier bestand" met `-f` alleen niet
 * gehaald. De meetstap moet dus BEIDE tests dragen: het doel is een regulier bestand (`-f`) én het
 * pad is zelf geen symlink (`! -L`). Deze functie meet die twee los, zodat de melding kan zeggen
 * welke helft ontbrak in plaats van alleen dat er iets mis is.
 */
function reguliereBestandspoortIn(script) {
  return {
    regulier: new RegExp(`\\[\\s*-f\\s+["']?${PAD_RE}["']?\\s*\\]`).test(script),
    geenSymlink: new RegExp(`\\[\\s*!\\s+-L\\s+["']?${PAD_RE}["']?\\s*\\]`).test(script),
  };
}

const SAVE_ACTION = 'actions/cache/save';
const RESTORE_ACTION = 'actions/cache/restore';

function unquote(value) {
  return String(value ?? '').replace(/^["']|["']$/g, '').trim();
}

/**
 * Splitst het `steps:`-blok van één job in losse stappen. Een lijstitem begint met `- `; de sleutel
 * die op diezelfde regel staat (`- name: ...`) wordt als gewone stapsleutel meegenomen, anders zou
 * juist de naam van elke stap onzichtbaar zijn.
 */
export function extractSteps(job) {
  const lines = job?.lines ?? [];
  const index = lines.findIndex((l) => /^["']?steps["']?\s*:\s*$/.test(l.text.trim()));
  if (index === -1) return [];
  const stepsIndent = lines[index].indent;
  const steps = [];
  let itemIndent = null;
  let current = null;
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.indent <= stepsIndent) break;
    const isItem = /^-(\s|$)/.test(line.text.trim()) && (itemIndent === null || line.indent === itemIndent);
    if (isItem) {
      itemIndent = line.indent;
      const rest = line.text.trim().replace(/^-\s*/, '');
      current = { keyIndent: null, lines: [] };
      steps.push(current);
      if (rest !== '') current.lines.push({ indent: line.indent + 2, text: rest });
      continue;
    }
    if (current) current.lines.push(line);
  }
  return steps.map((step) => {
    const keyIndent = Math.min(...step.lines.map((l) => l.indent));
    const keys = {};
    for (const line of step.lines) {
      if (line.indent !== keyIndent) continue;
      const m = line.text.trim().match(/^["']?([A-Za-z_][A-Za-z0-9_-]*)["']?\s*:\s*(.*)$/);
      if (m) keys[m[1]] = m[2].trim();
    }
    const withIndex = step.lines.findIndex((l) => l.indent === keyIndent && /^["']?with["']?\s*:/.test(l.text.trim()));
    const inputs = {};
    if (withIndex !== -1) {
      for (let i = withIndex + 1; i < step.lines.length; i += 1) {
        const line = step.lines[i];
        if (line.indent <= keyIndent) break;
        const m = line.text.trim().match(/^["']?([A-Za-z_][A-Za-z0-9_-]*)["']?\s*:\s*(.*)$/);
        if (m && line.indent === step.lines[withIndex + 1].indent) inputs[m[1]] = m[2].trim();
      }
    }
    return {
      name: unquote(keys.name ?? ''),
      id: unquote(keys.id ?? ''),
      if: keys.if ?? '',
      uses: unquote(keys.uses ?? ''),
      with: inputs,
      lines: step.lines,
    };
  });
}

/**
 * Leest de inhoud van een blok-scalar (`sleutel: |`) uit de RUWE workflowtekst, binnen de stap met
 * het opgegeven `id`. De structuurlezer laat blok-scalars vallen, dus zonder dit zou de shell van de
 * meetstap en de `restore-keys:`-lijst onzichtbaar blijven — precies de twee plekken waar dit
 * contract echt over gaat.
 */
export function blockScalarOf(text, stepId, key) {
  const raw = String(text ?? '').split(/\r?\n/);
  const idRe = new RegExp(`^\\s*(?:-\\s+)?id:\\s*["']?${stepId}["']?\\s*$`);
  const start = raw.findIndex((l) => idRe.test(l));
  if (start === -1) return null;
  const stepIndent = raw[start].length - raw[start].trimStart().length;
  const keyRe = new RegExp(`^\\s*["']?${key}["']?\\s*:\\s*[|>][+-]?\\d*\\s*$`);
  for (let i = start + 1; i < raw.length; i += 1) {
    const line = raw[i];
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    // Terug op of boven het niveau van de stapsleutels én een nieuw lijstitem: stap voorbij.
    if (indent < stepIndent || (indent === stepIndent && /^\s*-\s/.test(line))) break;
    if (!keyRe.test(line)) continue;
    const blockIndent = indent;
    const body = [];
    for (let j = i + 1; j < raw.length; j += 1) {
      const inner = raw[j];
      if (inner.trim() === '') { body.push(''); continue; }
      if (inner.length - inner.trimStart().length <= blockIndent) break;
      body.push(inner);
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    return body.join('\n');
  }
  return null;
}

/** `always() && steps.x.outputs.y == 'true'` → `{ step: 'x', output: 'y' }`. */
function probeReferenceIn(expression) {
  const m = String(expression ?? '').match(
    /steps\.([A-Za-z_][A-Za-z0-9_-]*)\.outputs\.([A-Za-z_][A-Za-z0-9_-]*)\s*==\s*'true'/,
  );
  return m ? { step: m[1], output: m[2] } : null;
}

/**
 * Meet het volledige cachecontract van een workflowtekst. Leeg resultaat = poort dicht.
 *
 * De kern: een `actions/cache/save` mag niet draaien zonder dat een stap in dezelfde job eerst
 * heeft GEMETEN dat het te bewaren bestand bestaat. Dat is exact de situatie die op main een
 * `Path Validation Error` opleverde, en die situatie moet hier rood worden.
 */
export function findPublishCacheViolations(text) {
  const lines = structureLines(text);
  const violations = [];
  const meld = (code, detail) => violations.push({ code, detail });

  const jobs = extractJobs(lines);
  let saveStep = null;
  let restoreStep = null;
  let saveJob = null;
  for (const job of jobs) {
    for (const step of extractSteps(job)) {
      if (step.uses.startsWith(`${SAVE_ACTION}@`)) { saveStep = step; saveJob = job; }
      if (step.uses.startsWith(`${RESTORE_ACTION}@`)) restoreStep = step;
    }
  }

  if (!restoreStep) meld(CACHE_VIOLATION.RESTORE_STEP_MISSING, RESTORE_ACTION);
  if (!saveStep) {
    meld(CACHE_VIOLATION.SAVE_STEP_MISSING, SAVE_ACTION);
    return violations;
  }

  for (const [rol, step] of [['save', saveStep], ['restore', restoreStep]]) {
    if (!step) continue;
    if (step.with.path !== RUNTIME_CACHE_PATH) {
      meld(CACHE_VIOLATION.CACHE_PATH_MISMATCH, `${rol}: ${step.with.path ?? '<geen>'}`);
    }
    if (step.with.key !== RUNTIME_CACHE_KEY) {
      meld(CACHE_VIOLATION.CACHE_KEY_MISMATCH, `${rol}: ${step.with.key ?? '<geen>'}`);
    }
  }

  if (restoreStep) {
    const restoreKeys = blockScalarOf(text, restoreStep.id, 'restore-keys');
    const gemeten = (restoreKeys ?? restoreStep.with['restore-keys'] ?? '').trim();
    if (gemeten !== RUNTIME_CACHE_RESTORE_KEY) {
      meld(CACHE_VIOLATION.RESTORE_KEY_MISMATCH, gemeten || '<geen>');
    }
  }

  // `always()` blijft de eis: een gefaalde bouwstap mag een wél weggeschreven verse momentopname
  // niet laten vallen. De poort erbij is de MEETSTAP, niet het schrappen van `always()`.
  if (!/\balways\(\)/.test(saveStep.if)) meld(CACHE_VIOLATION.SAVE_NOT_ALWAYS, saveStep.if || '<geen if>');

  const referentie = probeReferenceIn(saveStep.if);
  if (!referentie) {
    meld(CACHE_VIOLATION.SAVE_NOT_GUARDED_BY_PROBE, saveStep.if || '<geen if>');
    return violations;
  }

  const jobSteps = extractSteps(saveJob);
  const probeIndex = jobSteps.findIndex((step) => step.id === referentie.step);
  const probe = probeIndex === -1 ? null : jobSteps[probeIndex];
  if (!probe) {
    meld(CACHE_VIOLATION.PROBE_STEP_MISSING, referentie.step);
    return violations;
  }
  // Een meetstap ná de save meet niets: de output bestaat dan nog niet, de conditie is leeg en de
  // cache wordt voor altijd stil overgeslagen. Dat is geen waarschuwing meer, maar wel een
  // permanent dode terugval — dus rood, niet stil.
  const saveIndex = jobSteps.findIndex((step) => step.uses.startsWith(`${SAVE_ACTION}@`));
  if (probeIndex > saveIndex) {
    meld(CACHE_VIOLATION.PROBE_AFTER_SAVE, `${probe.id} staat na ${saveStep.id || SAVE_ACTION}`);
  }
  if (!/\balways\(\)/.test(probe.if)) meld(CACHE_VIOLATION.PROBE_NOT_ALWAYS, probe.if || '<geen if>');

  const script = blockScalarOf(text, probe.id, 'run') ?? '';
  if (!script.includes(RUNTIME_CACHE_PATH)) {
    meld(CACHE_VIOLATION.PROBE_PATH_MISMATCH, probe.id);
  }
  if (!new RegExp(`${referentie.output}=`).test(script) || !script.includes('GITHUB_OUTPUT')) {
    meld(CACHE_VIOLATION.PROBE_OUTPUT_NOT_WRITTEN, `${probe.id}.${referentie.output}`);
  }

  // Terugval naar alleen `-f` is precies de gemeten HIGH-finding: de save ging open voor een pad
  // dat zelf een symlink was. Rood, zodat een latere "vereenvoudiging" van deze shell niet
  // stilzwijgend de fail-closed eis opgeeft.
  const poort = reguliereBestandspoortIn(script);
  if (!poort.regulier || !poort.geenSymlink) {
    meld(CACHE_VIOLATION.PROBE_FOLLOWS_SYMLINK,
      `${probe.id}: -f=${poort.regulier} !-L=${poort.geenSymlink}`);
  }

  return violations;
}
