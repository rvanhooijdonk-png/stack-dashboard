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

/** Events waarop GitHub een door de PR VOORGESTELDE workflowdefinitie kan uitvoeren. */
export const UNTRUSTED_TRIGGERS = Object.freeze(['pull_request', 'pull_request_target']);

/** De enige schrijfscope die de trusted writer mag dragen. */
export const ALLOWED_TRUSTED_WRITE_SCOPES = Object.freeze(['statuses']);

export const TRUST_VIOLATION = Object.freeze({
  UNTRUSTED_TRIGGER_WITH_WRITE_PERMISSION: 'UNTRUSTED_TRIGGER_WITH_WRITE_PERMISSION',
  PULL_REQUEST_TARGET_PRESENT: 'PULL_REQUEST_TARGET_PRESENT',
  PR_SHIELD_HAS_WRITE_PERMISSION: 'PR_SHIELD_HAS_WRITE_PERMISSION',
  PR_SHIELD_MISSING: 'PR_SHIELD_MISSING',
  TRUSTED_WRITER_MISSING: 'TRUSTED_WRITER_MISSING',
  TRUSTED_WRITER_HAS_UNTRUSTED_TRIGGER: 'TRUSTED_WRITER_HAS_UNTRUSTED_TRIGGER',
  TRUSTED_WRITER_HAS_NO_TRIGGER: 'TRUSTED_WRITER_HAS_NO_TRIGGER',
  TRUSTED_WRITER_HAS_MULTIPLE_JOBS: 'TRUSTED_WRITER_HAS_MULTIPLE_JOBS',
  TRUSTED_WRITER_WRITE_SCOPE_NOT_ALLOWED: 'TRUSTED_WRITER_WRITE_SCOPE_NOT_ALLOWED',
  TRUSTED_WRITER_WORKFLOW_LEVEL_WRITE: 'TRUSTED_WRITER_WORKFLOW_LEVEL_WRITE',
  TRUSTED_WRITER_USES_SECRETS: 'TRUSTED_WRITER_USES_SECRETS',
  TRUSTED_WRITER_CHECKS_OUT_PR_CODE: 'TRUSTED_WRITER_CHECKS_OUT_PR_CODE',
  TRUSTED_WRITER_USES_PR_ARTIFACTS: 'TRUSTED_WRITER_USES_PR_ARTIFACTS',
  STATUSES_WRITE_OUTSIDE_TRUSTED_WRITER: 'STATUSES_WRITE_OUTSIDE_TRUSTED_WRITER',
});

const BLOCK_SCALAR_RE = /:\s*[|>][+-]?\d*\s*$/;

function indentOf(line) {
  return line.length - line.trimStart().length;
}

/**
 * Verwijdert een YAML-commentaar aan het eind van een regel. `#` telt alleen als commentaarstart aan
 * het regelbegin of na witruimte, en nooit binnen een aanhalingsteken — anders zou
 * `ref: 'a#b'` halverwege afgekapt worden.
 */
export function stripInlineComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
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

/** Volledige statische meting van één workflowbestand. Pure functie: tekst in, feiten uit. */
export function analyzeWorkflow(text) {
  const lines = structureLines(text);
  const jobs = extractJobs(lines);
  const jobLines = new Set(jobs.flatMap((job) => job.lines));
  const outsideJobs = lines.filter((line) => !jobLines.has(line));

  return {
    triggers: extractTriggers(lines),
    writeGrants: extractWriteGrants(lines),
    workflowLevelWriteGrants: extractWriteGrants(outsideJobs),
    jobs: jobs.map((job) => ({ id: job.id, writeGrants: extractWriteGrants(job.lines) })),
    usesSecrets: lines.some((l) => /\bsecrets\s*\./.test(l.text)),
    checkoutRefs: lines
      .filter((l) => /^\s*ref\s*:/.test(l.text))
      .map((l) => unquote(l.text.replace(/^\s*ref\s*:/, ''))),
    usesArtifactsOrCache: lines.some(
      (l) => /uses\s*:\s*\S*actions\/(cache|download-artifact)/.test(l.text),
    ),
  };
}

const PR_CODE_REF_RE = /pull_request|pull\/|head\.(sha|ref)|github\.head_ref/;

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
    }

    if (path === trustedWriterPath) {
      sawTrustedWriter = true;
      if (untrusted.length > 0) add(TRUST_VIOLATION.TRUSTED_WRITER_HAS_UNTRUSTED_TRIGGER, path);
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
