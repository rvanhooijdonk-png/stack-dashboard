/**
 * AUTOCODING_SHIELD — statische vertrouwensgrens over workflowbestanden.
 *
 * Het defect dat dit bewaakt is een eigenschap van GitHub zelf, geen bug in een script: op een
 * `pull_request`-run draait GitHub de workflowdefinitie ZOALS DIE IN DE PULL REQUEST STAAT, niet de
 * versie op de default branch. Zolang de statuswriter in hetzelfde bestand woonde als de
 * `pull_request`-shield, kon een same-repo branch de stappen van de `statuses: write`-job vervangen
 * en de receiptstatus zelf groen schrijven. Default-branch-checkout beschermt de SCRIPTS; het
 * beschermt niet de YAML die de job en zijn tokenpermissies definieert.
 *
 * De enige echte grens is fysieke scheiding: het bestand met de schrijfscope mag door geen enkele
 * PR-gecontroleerde event startbaar zijn. Dat is een eigenschap van de BESTANDEN, dus wordt hij hier
 * statisch gemeten in plaats van in proza beloofd.
 *
 * Bewust LEXICAAL en OVER-BENADEREND. Er is geen YAML-parser in dit project (nul dependencies), en
 * een half-complete parser zou stil verkeerd kunnen lezen. Deze scanner leest daarom regels, niet
 * documenten, en is zo afgesteld dat hij eerder te veel dan te weinig als schrijfscope of als
 * untrusted trigger herkent. Een vals alarm kost een commit; een gemiste schrijfscope kost de poort.
 *
 * Blok-scalars (`run: |`, `run: >-`) worden expliciet overgeslagen: shellinhoud is geen YAML-
 * structuur en zou anders onzinnige treffers opleveren.
 */

/**
 * Events waarop GitHub een door de PR VOORGESTELDE workflowdefinitie uitvoert.
 *
 * `pull_request_review` staat hier op grond van een LIVE METING, niet van proza. Actions-run
 * `32542688290` op PR #74 draaide op event `pull_request_review`, head `a2e7a64…`, het bestand
 * `.github/workflows/autocoding-shield-live-gate.yml` — terwijl de Contents API op `?ref=main` voor
 * dat pad 404 gaf. Het bestand bestond dus NIET op de default branch en werd toch uitgevoerd: de
 * definitie kwam van de PR-head. Daarmee is de eerdere aanname dat review- en commentevents altijd
 * een default-branch-definitie garanderen weerlegd voor de hele `pull_request_*`-familie.
 * `pull_request_review_comment` hoort tot dezelfde familie en staat er daarom preventief bij.
 */
export const UNTRUSTED_TRIGGERS = Object.freeze([
  'pull_request', 'pull_request_target', 'pull_request_review', 'pull_request_review_comment',
]);

/**
 * De enige twee events waarop de trusted writer mag draaien.
 *
 * `workflow_run` en `schedule` triggeren volgens de officiële GitHub-documentatie uitsluitend een
 * workflowbestand dat OP DE DEFAULT BRANCH bestaat, en `workflow_run` is expliciet bedoeld om na een
 * onprivileged workflow een privileged workflow te starten. Elk direct PR-, comment- of reviewevent
 * is hier een harde overtreding — ook `issue_comment`, dat weliswaar een default-branch-definitie
 * draait maar door iedere commentator direct op de schrijvende workflow gericht kan worden.
 */
export const TRUSTED_WRITER_TRIGGERS = Object.freeze(['workflow_run', 'schedule']);

/** De enige schrijfscope die de trusted writer mag dragen. */
export const ALLOWED_TRUSTED_WRITE_SCOPES = Object.freeze(['statuses']);

export const TRUST_VIOLATION = Object.freeze({
  UNTRUSTED_TRIGGER_WITH_WRITE_PERMISSION: 'UNTRUSTED_TRIGGER_WITH_WRITE_PERMISSION',
  PULL_REQUEST_TARGET_PRESENT: 'PULL_REQUEST_TARGET_PRESENT',
  PR_SHIELD_HAS_WRITE_PERMISSION: 'PR_SHIELD_HAS_WRITE_PERMISSION',
  PR_SHIELD_MISSING: 'PR_SHIELD_MISSING',
  TRUSTED_WRITER_MISSING: 'TRUSTED_WRITER_MISSING',
  TRUSTED_WRITER_HAS_UNTRUSTED_TRIGGER: 'TRUSTED_WRITER_HAS_UNTRUSTED_TRIGGER',
  TRUSTED_WRITER_TRIGGER_NOT_ALLOWED: 'TRUSTED_WRITER_TRIGGER_NOT_ALLOWED',
  TRUSTED_WRITER_WORKFLOW_RUN_SOURCE_UNPINNED: 'TRUSTED_WRITER_WORKFLOW_RUN_SOURCE_UNPINNED',
  TRUSTED_WRITER_HAS_NO_TRIGGER: 'TRUSTED_WRITER_HAS_NO_TRIGGER',
  TRUSTED_WRITER_HAS_MULTIPLE_JOBS: 'TRUSTED_WRITER_HAS_MULTIPLE_JOBS',
  TRUSTED_WRITER_WRITE_SCOPE_NOT_ALLOWED: 'TRUSTED_WRITER_WRITE_SCOPE_NOT_ALLOWED',
  TRUSTED_WRITER_WORKFLOW_LEVEL_WRITE: 'TRUSTED_WRITER_WORKFLOW_LEVEL_WRITE',
  TRUSTED_WRITER_USES_SECRETS: 'TRUSTED_WRITER_USES_SECRETS',
  TRUSTED_WRITER_CHECKS_OUT_PR_CODE: 'TRUSTED_WRITER_CHECKS_OUT_PR_CODE',
  TRUSTED_WRITER_USES_PR_ARTIFACTS: 'TRUSTED_WRITER_USES_PR_ARTIFACTS',
  STATUSES_WRITE_OUTSIDE_TRUSTED_WRITER: 'STATUSES_WRITE_OUTSIDE_TRUSTED_WRITER',
  PR_SHIELD_CHECKS_OUT_CODE_OUTSIDE_PULL_REQUEST: 'PR_SHIELD_CHECKS_OUT_CODE_OUTSIDE_PULL_REQUEST',
});

const BLOCK_SCALAR_RE = /:\s*[|>][+-]?\d*\s*$/;

function indentOf(line) {
  return line.length - line.trimStart().length;
}

/**
 * Verwijdert een YAML-commentaar aan het eind van een regel. `#` telt alleen als commentaarstart aan
 * het regelbegin of na witruimte, en nooit binnen een aanhalingsteken — anders zou `ref: 'a#b'`
 * halverwege afgekapt worden.
 *
 * De twee quotesoorten van YAML escapen VERSCHILLEND, en dat verschil is hier veiligheidsrelevant
 * (Gemini review `4998459978`, inline `3834665340`):
 *
 *   - In een DOUBLE-quoted scalar escapet `\` het volgende teken. In `name: "a\" # b"` sloot de oude
 *     lus de string al bij `\"`, zag daarna ` # ` als commentaarstart en gooide de rest van de regel
 *     weg. Dat is de GEVAARLIJKE richting: weggegooide tekst kan een schrijfscope bevatten die de
 *     scanner dan nooit ziet.
 *   - In een SINGLE-quoted scalar bestaat GEEN backslash-escape; het enige escape is de verdubbelde
 *     quote `''`. Een parser die daar wél een backslash-escape modelleert (zoals het simpele
 *     tegenvoorstel) leest `'a\'` als "nog open" en verschuift alle volgende grenzen.
 *
 * Bij een ONAFGESLOTEN quote bestaat er geen betrouwbare commentaargrens meer. Fail-closed betekent
 * hier MEER tekst behouden, niet minder: deze scanner is over-benaderend, dus tekst behouden kost
 * hooguit een vals alarm, terwijl tekst weggooien een schrijfscope onzichtbaar maakt. Een niet-string
 * invoer wordt om dezelfde reden gecoerceerd in plaats van tot een lege regel gereduceerd.
 */
export function stripInlineComment(line) {
  const text = typeof line === 'string' ? line : String(line ?? '');
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === '"') {
      if (ch === '\\') { i += 1; continue; }
      if (ch === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") {
        if (text[i + 1] === "'") { i += 1; continue; }
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i);
  }
  return text;
}

/**
 * Reduceert een workflowbestand tot zijn STRUCTUURREGELS: commentaar weg, lege regels weg, en de
 * volledige inhoud van elke blok-scalar overgeslagen. Wat overblijft is uitsluitend YAML-mapping, en
 * dus het enige waar permissies en triggers in kunnen staan.
 */
export function structureLines(text) {
  const out = [];
  let blockIndent = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (blockIndent !== null) {
      if (raw.trim() === '') continue;
      if (indentOf(raw) > blockIndent) continue;
      blockIndent = null;
    }
    const line = stripInlineComment(raw);
    if (line.trim() === '') continue;
    out.push({ indent: indentOf(line), text: line });
    if (BLOCK_SCALAR_RE.test(line)) blockIndent = indentOf(line);
  }
  return out;
}

function unquote(value) {
  return value.replace(/^["']|["']$/g, '').trim();
}

/** Leest de triggernamen uit het `on:`-blok, in alle drie de YAML-vormen die GitHub accepteert. */
export function extractTriggers(lines) {
  const index = lines.findIndex((l) => l.indent === 0 && /^["']?on["']?\s*:/.test(l.text));
  if (index === -1) return [];
  const inline = lines[index].text.replace(/^["']?on["']?\s*:/, '').trim();
  if (inline.startsWith('[')) {
    return inline.replace(/^\[|\]$/g, '').split(',').map(unquote).filter((v) => v.length > 0);
  }
  if (inline.length > 0) return [unquote(inline)].filter((v) => v.length > 0);

  const triggers = [];
  let childIndent = null;
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.indent === 0) break;
    if (childIndent === null) childIndent = line.indent;
    if (line.indent !== childIndent) continue;
    const name = line.text.trim().match(/^-?\s*["']?([A-Za-z_][A-Za-z0-9_-]*)["']?\s*:?/)?.[1];
    if (name) triggers.push(name);
  }
  return triggers;
}

/**
 * De structuurregels die STRIKT ONDER `lines[index]` hangen, tot de eerstvolgende regel op dezelfde
 * of kleinere inspringing. Indents zijn absoluut, dus dit werkt ook op een al uitgesneden deelblok.
 */
function blockChildren(lines, index) {
  const out = [];
  for (let i = index + 1; i < lines.length; i += 1) {
    if (lines[i].indent <= lines[index].indent) break;
    out.push(lines[i]);
  }
  return out;
}

/**
 * Leest de `workflows:`-pin onder de `workflow_run`-trigger.
 *
 * Dit is de bronbegrenzing van de trusted keten: een `workflow_run`-writer zonder pin zou door de
 * voltooiing van ELKE workflow in de repository gestart worden, ook door een workflow die een PR
 * zelf toevoegt. `null` betekent "geen `workflow_run`-trigger", een lege lijst betekent
 * "trigger aanwezig maar ongepind" — twee verschillende feiten die niet mogen samenvallen.
 */
export function extractWorkflowRunSources(lines) {
  const onIndex = lines.findIndex((l) => l.indent === 0 && /^["']?on["']?\s*:/.test(l.text));
  if (onIndex === -1) return null;
  const onBlock = blockChildren(lines, onIndex);
  const runIndex = onBlock.findIndex((l) => /^\s*-?\s*["']?workflow_run["']?\s*:/.test(l.text));
  if (runIndex === -1) return null;
  const runBlock = blockChildren(onBlock, runIndex);
  const listIndex = runBlock.findIndex((l) => /^\s*["']?workflows["']?\s*:/.test(l.text));
  if (listIndex === -1) return [];
  const inline = runBlock[listIndex].text.replace(/^\s*["']?workflows["']?\s*:/, '').trim();
  if (inline.startsWith('[')) {
    return inline.replace(/^\[|\]$/g, '').split(',').map(unquote).filter((v) => v.length > 0);
  }
  if (inline.length > 0) return [unquote(inline)].filter((v) => v.length > 0);
  return blockChildren(runBlock, listIndex)
    .filter((l) => /^\s*-/.test(l.text))
    .map((l) => unquote(l.text.replace(/^\s*-\s*/, '')))
    .filter((v) => v.length > 0);
}

/**
 * Herkent elke schrijfscope-toekenning op een structuurregel: `statuses: write`, de flow-vorm
 * `permissions: { statuses: write }` en de allesomvattende `permissions: write-all`. Bewust ruim:
 * een naam-met-waarde-`write` telt altijd, ook als hij nergens onder `permissions:` hangt.
 */
export function extractWriteGrants(lines) {
  const grants = [];
  for (const { text } of lines) {
    if (/["']?permissions["']?\s*:\s*["']?write-all["']?\s*$/.test(text)) {
      grants.push({ scope: '*', text: text.trim() });
      continue;
    }
    for (const m of text.matchAll(
      /(?:^|[\s{,])["']?([A-Za-z][A-Za-z0-9_-]*)["']?\s*:\s*["']?write["']?(?=\s*(?:[,}]|$))/g,
    )) {
      grants.push({ scope: m[1], text: text.trim() });
    }
  }
  return grants;
}

/** Splitst het `jobs:`-blok in losse jobs, zodat een schrijfscope aan één job toe te rekenen is. */
export function extractJobs(lines) {
  const index = lines.findIndex((l) => l.indent === 0 && /^["']?jobs["']?\s*:/.test(l.text));
  if (index === -1) return [];
  const jobs = [];
  let jobIndent = null;
  let current = null;
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.indent === 0) break;
    if (jobIndent === null) jobIndent = line.indent;
    if (line.indent === jobIndent) {
      const id = line.text.trim().match(/^["']?([A-Za-z_][A-Za-z0-9_-]*)["']?\s*:/)?.[1] ?? '';
      current = { id, lines: [line] };
      jobs.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return jobs;
}

/** De sleutels die direct onder de jobnaam hangen — dus `if:`, `permissions:`, `runs-on:`. */
function jobLevelKeys(job) {
  const children = job.lines.slice(1);
  if (children.length === 0) return [];
  const keyIndent = Math.min(...children.map((l) => l.indent));
  return children.filter((l) => l.indent === keyIndent);
}

/** Volledige statische meting van één workflowbestand. Pure functie: tekst in, feiten uit. */
export function analyzeWorkflow(text) {
  const lines = structureLines(text);
  const jobs = extractJobs(lines);
  const jobLines = new Set(jobs.flatMap((job) => job.lines));
  const outsideJobs = lines.filter((line) => !jobLines.has(line));

  return {
    name: lines.find((l) => l.indent === 0 && /^["']?name["']?\s*:/.test(l.text))
      ? unquote(lines.find((l) => l.indent === 0 && /^["']?name["']?\s*:/.test(l.text))
        .text.replace(/^["']?name["']?\s*:/, ''))
      : '',
    triggers: extractTriggers(lines),
    workflowRunSources: extractWorkflowRunSources(lines),
    writeGrants: extractWriteGrants(lines),
    workflowLevelWriteGrants: extractWriteGrants(outsideJobs),
    jobs: jobs.map((job) => ({
      id: job.id,
      writeGrants: extractWriteGrants(job.lines),
      // Alleen de sleutels op JOBNIVEAU tellen als jobconditie; een `if:` binnen een step zegt niets
      // over de vraag of de job zelf op dit event mag draaien.
      condition: jobLevelKeys(job)
        .filter((l) => /^\s*if\s*:/.test(l.text))
        .map((l) => l.text.replace(/^\s*if\s*:/, '').trim())
        .join(' '),
      checksOutCode: job.lines.some((l) => /uses\s*:\s*\S*actions\/checkout/.test(l.text)),
    })),
    usesSecrets: lines.some((l) => /\bsecrets\s*\./.test(l.text)),
    checkoutRefs: lines
      .filter((l) => /^\s*ref\s*:/.test(l.text))
      .map((l) => unquote(l.text.replace(/^\s*ref\s*:/, ''))),
    usesArtifactsOrCache: lines.some(
      (l) => /uses\s*:\s*\S*actions\/(cache|download-artifact|upload-artifact)/.test(l.text),
    ),
  };
}

const PR_CODE_REF_RE = /pull_request|pull\/|head\.(sha|ref)|github\.head_ref/;
/** Een jobconditie die de job aantoonbaar tot het `pull_request`-event beperkt. */
const PR_ONLY_RE = /github\.event_name\s*==\s*['"]pull_request['"]/;

function scopesOf(grants) {
  return Array.from(new Set(grants.map((g) => g.scope)));
}

/**
 * De vertrouwensgrens zelf, als een lijst overtredingen. Leeg is de enige aanvaardbare uitkomst.
 *
 * `workflows` is een lijst `{ path, text }` over ALLE workflowbestanden van de repository — de regel
 * "geen schrijfscope op een untrusted trigger" is repositorybreed, niet iets wat alleen voor de
 * shield geldt.
 */
export function findTrustBoundaryViolations({ workflows, prShieldPath, trustedWriterPath }) {
  const violations = [];
  const add = (code, path) => violations.push(`${code}:${path}`);
  const list = Array.isArray(workflows) ? workflows : [];

  let sawPrShield = false;
  let sawTrustedWriter = false;

  // De naam waarop de writer zijn `workflow_run` moet pinnen komt uit het SHIELDBESTAND zelf, niet
  // uit een losse literal: zo kan een hernoemde shield de keten niet stil loskoppelen.
  const shieldEntry = list.find((w) => w?.path === prShieldPath);
  const shieldWorkflowName = shieldEntry ? analyzeWorkflow(shieldEntry.text).name : '';

  for (const { path, text } of list) {
    const wf = analyzeWorkflow(text);
    const untrusted = wf.triggers.filter((t) => UNTRUSTED_TRIGGERS.includes(t));

    if (wf.triggers.includes('pull_request_target')) {
      add(TRUST_VIOLATION.PULL_REQUEST_TARGET_PRESENT, path);
    }
    // De kernregel. Een bestand dat op een PR-gecontroleerde event kan draaien, draait de door de PR
    // voorgestelde definitie — en mag dus nergens in het bestand een schrijfscope kunnen krijgen.
    if (untrusted.length > 0 && wf.writeGrants.length > 0) {
      add(TRUST_VIOLATION.UNTRUSTED_TRIGGER_WITH_WRITE_PERMISSION, path);
    }
    if (path !== trustedWriterPath && wf.writeGrants.some((g) => g.scope === 'statuses' || g.scope === '*')) {
      add(TRUST_VIOLATION.STATUSES_WRITE_OUTSIDE_TRUSTED_WRITER, path);
    }

    if (path === prShieldPath) {
      sawPrShield = true;
      if (wf.writeGrants.length > 0) add(TRUST_VIOLATION.PR_SHIELD_HAS_WRITE_PERMISSION, path);
      // De shield mag review- en commentevents ontvangen als onprivileged SIGNAAL, maar op die
      // events mag hij geen PR-code uitchecken of uitvoeren. Elke job die uitcheckt moet daarom op
      // jobniveau tot `pull_request` beperkt zijn.
      if (wf.jobs.some((job) => job.checksOutCode && !PR_ONLY_RE.test(job.condition))) {
        add(TRUST_VIOLATION.PR_SHIELD_CHECKS_OUT_CODE_OUTSIDE_PULL_REQUEST, path);
      }
    }

    if (path === trustedWriterPath) {
      sawTrustedWriter = true;
      if (untrusted.length > 0) add(TRUST_VIOLATION.TRUSTED_WRITER_HAS_UNTRUSTED_TRIGGER, path);
      // De allowlist is strenger dan "niet untrusted": alleen `workflow_run` en `schedule` laden
      // gegarandeerd de default-branch-definitie zonder dat een PR-actor het event zelf richt.
      if (wf.triggers.some((t) => !TRUSTED_WRITER_TRIGGERS.includes(t))) {
        add(TRUST_VIOLATION.TRUSTED_WRITER_TRIGGER_NOT_ALLOWED, path);
      }
      // Een ongepinde of verkeerd gepinde `workflow_run` zou door elke andere workflow — ook een
      // door een PR toegevoegde met dezelfde naam op een ander pad — gestart kunnen worden.
      if (wf.triggers.includes('workflow_run')) {
        const sources = wf.workflowRunSources ?? [];
        if (
          shieldWorkflowName.length === 0
          || sources.length !== 1
          || sources[0] !== shieldWorkflowName
        ) {
          add(TRUST_VIOLATION.TRUSTED_WRITER_WORKFLOW_RUN_SOURCE_UNPINNED, path);
        }
      }
      if (wf.triggers.length === 0) add(TRUST_VIOLATION.TRUSTED_WRITER_HAS_NO_TRIGGER, path);
      if (wf.jobs.length !== 1) add(TRUST_VIOLATION.TRUSTED_WRITER_HAS_MULTIPLE_JOBS, path);
      if (wf.workflowLevelWriteGrants.length > 0) {
        add(TRUST_VIOLATION.TRUSTED_WRITER_WORKFLOW_LEVEL_WRITE, path);
      }
      if (!scopesOf(wf.writeGrants).every((s) => ALLOWED_TRUSTED_WRITE_SCOPES.includes(s))) {
        add(TRUST_VIOLATION.TRUSTED_WRITER_WRITE_SCOPE_NOT_ALLOWED, path);
      }
      if (wf.usesSecrets) add(TRUST_VIOLATION.TRUSTED_WRITER_USES_SECRETS, path);
      if (wf.checkoutRefs.some((ref) => PR_CODE_REF_RE.test(ref))) {
        add(TRUST_VIOLATION.TRUSTED_WRITER_CHECKS_OUT_PR_CODE, path);
      }
      if (wf.usesArtifactsOrCache) add(TRUST_VIOLATION.TRUSTED_WRITER_USES_PR_ARTIFACTS, path);
    }
  }

  if (prShieldPath && !sawPrShield) add(TRUST_VIOLATION.PR_SHIELD_MISSING, prShieldPath);
  if (trustedWriterPath && !sawTrustedWriter) add(TRUST_VIOLATION.TRUSTED_WRITER_MISSING, trustedWriterPath);
  return violations;
}
