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
 * De enige drie events waarop de trusted writer mag draaien.
 *
 * `workflow_run` en `schedule` triggeren volgens de officiële GitHub-documentatie uitsluitend een
 * workflowbestand dat OP DE DEFAULT BRANCH bestaat, en `workflow_run` is expliciet bedoeld om na een
 * onprivileged workflow een privileged workflow te starten.
 *
 * `issue_comment` heeft diezelfde eigenschap — GitHub draait dat event alleen wanneer het
 * workflowbestand op de default branch staat — en is hier toegelaten omdat het als ENIG event de
 * PR-associatie zelf meedraagt (`github.event.issue.number` plus `github.event.issue.pull_request`).
 * Zonder dat event moet iedere commentwijziging via de onprivileged shield worden omgeleid, en dan
 * wordt dezelfde comment twee keer gedispatcht.
 *
 * Dit is bewust GEEN generieke verruiming: de toelating geldt alleen voor het fysiek gescheiden
 * writerbestand, en daar bovenop blijven alle andere writergrenzen gelden (één schrijvende job,
 * alleen `statuses: write`, geen PR-headcheckout, geen artifacts, per-PR gequeueëde jobconcurrency).
 * In elk ANDER workflowbestand is `issue_comment` naast een schrijfscope een overtreding; zie
 * `ISSUE_COMMENT_WRITE_OUTSIDE_TRUSTED_WRITER`. Elk direct PR- of reviewevent blijft ook hier een
 * harde overtreding.
 */
export const TRUSTED_WRITER_TRIGGERS = Object.freeze(['workflow_run', 'schedule', 'issue_comment']);

/** De enige schrijfscope die de trusted writer mag dragen. */
export const ALLOWED_TRUSTED_WRITE_SCOPES = Object.freeze(['statuses']);

/**
 * De enige events waarop de MERGEFINALIZER mag draaien: alleen `schedule`.
 *
 * Dat is strenger dan de writer, en met reden. `workflow_run` zou de finalizer laten starten door de
 * voltooiing van een run waarvan de PR de definitie levert; `issue_comment` zou iedere commentator
 * een directe trekker naar een token met MERGErechten geven. `workflow_dispatch` staat er evenmin
 * bij: dat event draait de definitie van de GEKOZEN ref, dus zou een pull request zijn eigen
 * finalizer kunnen voorstellen. Blijft over: een klok, die niemand kan richten.
 *
 * De prijs is latentie — een kandidaat wacht hoogstens één ronde. Dat is precies de goede ruil voor
 * de enige job in deze repository die iets onomkeerbaars kan doen.
 */
export const TRUSTED_FINALIZER_TRIGGERS = Object.freeze(['schedule']);

/**
 * De enige schrijfscope die de mergefinalizer mag dragen. `contents: write` staat er NIET bij: de
 * merge-endpoint schrijft zelf naar de basebranch met de PR-scope, en een finalizer met
 * contentsrechten zou daarnaast rechtstreeks naar elke branch kunnen pushen.
 */
export const ALLOWED_FINALIZER_WRITE_SCOPES = Object.freeze(['pull-requests']);

/** De vaste naam van de repositorybrede rij van de mergefinalizer. */
export const FINALIZER_REPOSITORY_LOCK_GROUP = 'autocoding-merge-finalizer-repository';

/**
 * De enige refvorm waarmee de finalizer mag uitchecken. Niet "geen PR-code" maar "aantoonbaar de
 * default branch": de zwakkere eis laat een weggelaten `ref:` toe, en die betekent bij een
 * `schedule` weliswaar de default branch, maar bij elke latere triggerwijziging iets anders. De
 * sterke vorm blijft ook dán kloppen.
 */
const DEFAULT_BRANCH_REF_RE = /^\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}$/;

/**
 * De enige trigger waarop de MERGE-GROUP-POORT mag draaien: `merge_group`.
 *
 * Dit event is de reden dat dit bestand fysiek gescheiden staat van shield, writer en finalizer.
 * GitHub laadt een `merge_group`-run met de workflowdefinitie van de DEFAULT BRANCH (net als
 * `workflow_run`/`schedule`), maar het event zelf kan uitsluitend ontstaan doordat GitHub een reeds
 * goedgekeurde pull request in de merge-wachtrij plaatst — geen PR-actor kan dit event rechtstreeks
 * richten op een zelfgekozen definitie. `workflow_dispatch` staat er nadrukkelijk niet bij, om
 * dezelfde reden als bij de finalizer: dat event draait de definitie van de gekozen ref.
 */
export const TRUSTED_MERGE_GROUP_GATE_TRIGGERS = Object.freeze(['merge_group']);

/**
 * De enige schrijfscope die de merge-group-poort mag dragen: `checks`. Dat is de API waarmee een
 * check-run aan een specifieke SHA gebonden wordt (`POST /repos/{o}/{r}/check-runs`) — de merge-
 * group-commit is immers een synthetische, per-inschrijving-unieke SHA, dus is een check-run hier
 * de correcte GitHub-vereiste vorm en niet de `statuses`-scope van de trusted writer.
 */
export const ALLOWED_MERGE_GROUP_GATE_WRITE_SCOPES = Object.freeze(['checks']);

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
  TRUSTED_WRITER_WRITE_JOB_NOT_UNIQUE: 'TRUSTED_WRITER_WRITE_JOB_NOT_UNIQUE',
  TRUSTED_WRITER_WRITE_JOB_NOT_PER_PULL_REQUEST_QUEUED:
    'TRUSTED_WRITER_WRITE_JOB_NOT_PER_PULL_REQUEST_QUEUED',
  TRUSTED_WRITER_NOT_REPOSITORY_QUEUED: 'TRUSTED_WRITER_NOT_REPOSITORY_QUEUED',
  TRUSTED_WRITER_WRITE_SCOPE_NOT_ALLOWED: 'TRUSTED_WRITER_WRITE_SCOPE_NOT_ALLOWED',
  TRUSTED_WRITER_WORKFLOW_LEVEL_WRITE: 'TRUSTED_WRITER_WORKFLOW_LEVEL_WRITE',
  TRUSTED_WRITER_USES_SECRETS: 'TRUSTED_WRITER_USES_SECRETS',
  TRUSTED_WRITER_CHECKS_OUT_PR_CODE: 'TRUSTED_WRITER_CHECKS_OUT_PR_CODE',
  TRUSTED_WRITER_USES_PR_ARTIFACTS: 'TRUSTED_WRITER_USES_PR_ARTIFACTS',
  STATUSES_WRITE_OUTSIDE_TRUSTED_WRITER: 'STATUSES_WRITE_OUTSIDE_TRUSTED_WRITER',
  // De mergefinalizer. Zelfde grenzen als de writer, met twee verschillen: hij mag alleen op een
  // klok draaien, en hij is de ENIGE plaats in de hele repository waar `pull-requests: write` mag
  // bestaan. Die scope is wat de merge-endpoint bedient, dus is elke andere drager ervan een tweede
  // weg naar dezelfde onomkeerbare actie.
  PULL_REQUESTS_WRITE_OUTSIDE_FINALIZER: 'PULL_REQUESTS_WRITE_OUTSIDE_FINALIZER',
  TRUSTED_FINALIZER_MISSING: 'TRUSTED_FINALIZER_MISSING',
  TRUSTED_FINALIZER_HAS_UNTRUSTED_TRIGGER: 'TRUSTED_FINALIZER_HAS_UNTRUSTED_TRIGGER',
  TRUSTED_FINALIZER_TRIGGER_NOT_ALLOWED: 'TRUSTED_FINALIZER_TRIGGER_NOT_ALLOWED',
  TRUSTED_FINALIZER_HAS_NO_TRIGGER: 'TRUSTED_FINALIZER_HAS_NO_TRIGGER',
  TRUSTED_FINALIZER_WRITE_JOB_NOT_UNIQUE: 'TRUSTED_FINALIZER_WRITE_JOB_NOT_UNIQUE',
  TRUSTED_FINALIZER_WRITE_JOB_NOT_PER_PULL_REQUEST_QUEUED:
    'TRUSTED_FINALIZER_WRITE_JOB_NOT_PER_PULL_REQUEST_QUEUED',
  TRUSTED_FINALIZER_NOT_REPOSITORY_QUEUED: 'TRUSTED_FINALIZER_NOT_REPOSITORY_QUEUED',
  TRUSTED_FINALIZER_WRITE_SCOPE_NOT_ALLOWED: 'TRUSTED_FINALIZER_WRITE_SCOPE_NOT_ALLOWED',
  TRUSTED_FINALIZER_WORKFLOW_LEVEL_WRITE: 'TRUSTED_FINALIZER_WORKFLOW_LEVEL_WRITE',
  TRUSTED_FINALIZER_USES_SECRETS: 'TRUSTED_FINALIZER_USES_SECRETS',
  TRUSTED_FINALIZER_CHECKS_OUT_PR_CODE: 'TRUSTED_FINALIZER_CHECKS_OUT_PR_CODE',
  TRUSTED_FINALIZER_USES_PR_ARTIFACTS: 'TRUSTED_FINALIZER_USES_PR_ARTIFACTS',
  ISSUE_COMMENT_WRITE_OUTSIDE_TRUSTED_WRITER: 'ISSUE_COMMENT_WRITE_OUTSIDE_TRUSTED_WRITER',
  TRIGGER_MAPPING_UNPARSEABLE: 'TRIGGER_MAPPING_UNPARSEABLE',
  PR_SHIELD_CHECKS_OUT_CODE_OUTSIDE_PULL_REQUEST: 'PR_SHIELD_CHECKS_OUT_CODE_OUTSIDE_PULL_REQUEST',
  // De merge-group-poort. Precies één trigger (`merge_group`), precies één schrijfscope (`checks`),
  // repositorybreed de ENIGE plaats waar die scope mag bestaan — dezelfde concentratielogica als
  // `pull-requests: write` bij de finalizer, hier toegepast op de scope die de merge-queue-vereiste
  // status-check publiceert.
  CHECKS_WRITE_OUTSIDE_MERGE_GROUP_GATE: 'CHECKS_WRITE_OUTSIDE_MERGE_GROUP_GATE',
  TRUSTED_MERGE_GROUP_GATE_MISSING: 'TRUSTED_MERGE_GROUP_GATE_MISSING',
  TRUSTED_MERGE_GROUP_GATE_HAS_UNTRUSTED_TRIGGER: 'TRUSTED_MERGE_GROUP_GATE_HAS_UNTRUSTED_TRIGGER',
  TRUSTED_MERGE_GROUP_GATE_TRIGGER_NOT_ALLOWED: 'TRUSTED_MERGE_GROUP_GATE_TRIGGER_NOT_ALLOWED',
  TRUSTED_MERGE_GROUP_GATE_HAS_NO_TRIGGER: 'TRUSTED_MERGE_GROUP_GATE_HAS_NO_TRIGGER',
  TRUSTED_MERGE_GROUP_GATE_WRITE_JOB_NOT_UNIQUE: 'TRUSTED_MERGE_GROUP_GATE_WRITE_JOB_NOT_UNIQUE',
  TRUSTED_MERGE_GROUP_GATE_WRITE_JOB_NOT_PER_MERGE_GROUP_QUEUED:
    'TRUSTED_MERGE_GROUP_GATE_WRITE_JOB_NOT_PER_MERGE_GROUP_QUEUED',
  TRUSTED_MERGE_GROUP_GATE_WRITE_SCOPE_NOT_ALLOWED: 'TRUSTED_MERGE_GROUP_GATE_WRITE_SCOPE_NOT_ALLOWED',
  TRUSTED_MERGE_GROUP_GATE_WORKFLOW_LEVEL_WRITE: 'TRUSTED_MERGE_GROUP_GATE_WORKFLOW_LEVEL_WRITE',
  TRUSTED_MERGE_GROUP_GATE_USES_SECRETS: 'TRUSTED_MERGE_GROUP_GATE_USES_SECRETS',
  TRUSTED_MERGE_GROUP_GATE_CHECKS_OUT_PR_CODE: 'TRUSTED_MERGE_GROUP_GATE_CHECKS_OUT_PR_CODE',
  TRUSTED_MERGE_GROUP_GATE_USES_PR_ARTIFACTS: 'TRUSTED_MERGE_GROUP_GATE_USES_PR_ARTIFACTS',
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

/**
 * De positie van de eerste `:` die niet binnen een quote of een geneste flow-collectie staat, of
 * `-1`. Nodig omdat een flow-waarde zelf dubbelepunten kan bevatten (`{ a: { b: c } }`) en omdat een
 * concurrencygroep een expressie kan dragen waarin `${{ ... }}` als geneste haken telt.
 */
function topLevelColon(text) {
  let depth = 0;
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
    if (ch === '{' || ch === '[') { depth += 1; continue; }
    if (ch === '}' || ch === ']') { depth -= 1; continue; }
    if (ch === ':' && depth === 0) return i;
  }
  return -1;
}

/**
 * Leest een YAML FLOW-MAPPING (`{ a: 1, b: { c: 2 } }`) tot zijn sleutels op het bovenste niveau.
 *
 * Waarom dit moest bestaan — Codex P1, review `4998729801`, inline `3834885357`. De vorige
 * `extractTriggers()` behandelde elke inline waarde achter `on:` als één trigger-NAAM. Bij de
 * volstrekt geldige vorm `on: { pull_request: {} }` leverde dat de trigger `"{ pull_request: {} }"`
 * op. Die naam staat in geen enkele lijst, dus zag `findTrustBoundaryViolations()` GEEN untrusted
 * trigger en mocht datzelfde bestand `statuses: write` dragen. Daarmee kon een PR-gestuurde
 * statuswriter langs de repositorybrede vertrouwenstest — precies het defect dat deze scanner moet
 * vangen.
 *
 * De parser is bewust klein en STRIKT: hij herkent de vorm die GitHub accepteert, en weigert alles
 * wat hij niet met zekerheid kan lezen (`{ ok: false }`). Die weigering is geen gemak maar de
 * fail-closed richting: de aanroeper maakt er een overtreding van, zodat een onleesbare `on:`-vorm
 * nooit stil als "geen trigger" wordt gelezen. Onafgesloten quotes, ongebalanceerde haken, een lege
 * of dubbele sleutel, tekst achter de sluitende accolade en een segment zonder dubbelepunt zijn
 * allemaal een weigering.
 *
 * `${{ ... }}` telt hier gewoon als twee geneste accolades. Dat is precies goed: de haken zijn
 * gebalanceerd, dus een komma of dubbelepunt binnen een expressie wordt nooit als scheidingsteken
 * gelezen.
 */
export function parseFlowMapping(text) {
  const source = String(text ?? '').trim();
  const fail = Object.freeze({ ok: false, entries: null });
  if (!source.startsWith('{')) return fail;

  const segments = [];
  let depth = 0;
  let quote = null;
  let segmentStart = -1;
  let closedAt = -1;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote === '"') {
      if (ch === '\\') { i += 1; continue; }
      if (ch === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") {
        if (source[i + 1] === "'") { i += 1; continue; }
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{' || ch === '[') {
      depth += 1;
      if (depth === 1) segmentStart = i + 1;
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth < 0) return fail;
      if (depth === 0) { segments.push(source.slice(segmentStart, i)); closedAt = i; break; }
      continue;
    }
    if (ch === ',' && depth === 1) {
      segments.push(source.slice(segmentStart, i));
      segmentStart = i + 1;
    }
  }
  if (closedAt === -1 || quote !== null) return fail;
  if (source.slice(closedAt + 1).trim() !== '') return fail;

  const entries = new Map();
  for (const segment of segments) {
    const body = segment.trim();
    // `{}` levert precies één leeg segment op en is een geldige lege mapping. Een leeg segment
    // NAAST andere segmenten (`{ a: 1, }`) is ambigu en wordt daarom geweigerd.
    if (body === '') {
      if (segments.length === 1) continue;
      return fail;
    }
    const colon = topLevelColon(body);
    if (colon === -1) return fail;
    const key = unquote(body.slice(0, colon));
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key) || entries.has(key)) return fail;
    entries.set(key, body.slice(colon + 1).trim());
  }
  return { ok: true, entries };
}

/**
 * Leest de triggernamen uit het `on:`-blok, in alle YAML-vormen die GitHub accepteert: de scalar
 * (`on: push`), de flow-sequence (`on: [push, pull_request]`), de FLOW-MAPPING
 * (`on: { pull_request: {} }`), de blokmapping en de bloksequence.
 *
 * Levert `null` op zodra de vorm niet met zekerheid te lezen is. Dat is een DERDE uitkomst naast
 * "geen triggers" en "deze triggers", en het verschil is veiligheidsrelevant: een onleesbare vorm
 * die als lege lijst wordt gelezen, verbergt precies de trigger waarop de scanner moet aanslaan.
 * De aanroeper vertaalt `null` naar `TRIGGER_MAPPING_UNPARSEABLE`.
 */
export function extractTriggers(lines) {
  const index = lines.findIndex((l) => l.indent === 0 && /^["']?on["']?\s*:/.test(l.text));
  if (index === -1) return [];
  const inline = lines[index].text.replace(/^["']?on["']?\s*:/, '').trim();

  if (inline.startsWith('{')) {
    const flow = parseFlowMapping(inline);
    if (!flow.ok) return null;
    return [...flow.entries.keys()];
  }
  if (inline.startsWith('[')) {
    // Een flow-sequence die op deze regel niet sluit, loopt over meerdere regels door; die vorm
    // leest deze regelgebaseerde scanner niet, dus weigert hij hem.
    if (!inline.endsWith(']')) return null;
    return inline.slice(1, -1).split(',').map(unquote).filter((v) => v.length > 0);
  }
  if (inline.length > 0) {
    const name = unquote(inline);
    return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) ? [name] : null;
  }

  const triggers = [];
  let childIndent = null;
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.indent === 0) break;
    if (childIndent === null) childIndent = line.indent;
    if (line.indent !== childIndent) continue;
    const name = line.text.trim().match(/^-?\s*["']?([A-Za-z_][A-Za-z0-9_-]*)["']?\s*:?/)?.[1];
    // Een kindregel op triggerniveau die geen naam oplevert, is een vorm die deze scanner niet
    // kent. Stil overslaan zou de trigger onzichtbaar maken, dus wordt ook dit een weigering.
    if (!name) return null;
    triggers.push(name);
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

/**
 * Leest één `concurrency:`-blok op de plek waar het staat: `lines[index]` IS de sleutelregel.
 *
 * Dezelfde drie YAML-vormen komen op jobniveau en op workflowniveau voor, dus wordt de lezer gedeeld
 * in plaats van gedupliceerd. Een tweede, net iets andere lezer zou de globale rij anders kunnen
 * beoordelen dan de per-PR-rij, en juist die twee moeten hier tegen elkaar gehouden worden.
 *
 * `unparseable: true` betekent "wel aanwezig, niet met zekerheid te lezen"; de aanroeper behandelt
 * dat als een overtreding, want een onleesbare rij is geen rij.
 *
 * De scalarvorm `concurrency: <groep>` wordt gelezen maar levert per definitie geen `queue:` op, dus
 * valt hij vanzelf door elke rij-eis heen: zonder `queue: max` vervangt GitHub de vorige WACHTENDE
 * beurt in plaats van hem te bewaren, en dan kan een aanleiding stil verdwijnen.
 */
function readConcurrencyBlock(lines, index) {
  const line = lines[index];
  const unreadable = { unparseable: true, group: '', cancelInProgress: '', queue: '' };
  const inline = line.text.replace(/^\s*["']?concurrency["']?\s*:/, '').trim();

  if (inline.startsWith('{')) {
    const flow = parseFlowMapping(inline);
    if (!flow.ok) return unreadable;
    return {
      unparseable: false,
      group: unquote(flow.entries.get('group') ?? ''),
      cancelInProgress: unquote(flow.entries.get('cancel-in-progress') ?? ''),
      queue: unquote(flow.entries.get('queue') ?? ''),
    };
  }
  if (inline.length > 0) {
    return { unparseable: false, group: unquote(inline), cancelInProgress: '', queue: '' };
  }

  const children = blockChildren(lines, index);
  if (children.length === 0) return unreadable;
  const keyIndent = Math.min(...children.map((l) => l.indent));
  const read = (key) => {
    const found = children.find(
      (l) => l.indent === keyIndent && new RegExp(`^\\s*["']?${key}["']?\\s*:`).test(l.text),
    );
    return found ? unquote(found.text.replace(/^\s*["']?[A-Za-z][A-Za-z0-9_-]*["']?\s*:/, '')) : '';
  };
  return {
    unparseable: false,
    group: read('group'),
    cancelInProgress: read('cancel-in-progress'),
    queue: read('queue'),
  };
}

/**
 * Leest de `concurrency:` van ÉÉN job — de per-PR schrijfrij van de writer. `null` betekent "deze
 * job heeft geen jobconcurrency".
 */
export function extractJobConcurrency(job) {
  const line = jobLevelKeys(job).find((l) => /^\s*["']?concurrency["']?\s*:/.test(l.text));
  if (!line) return null;
  return readConcurrencyBlock(job.lines, job.lines.indexOf(line));
}

/**
 * Leest de `concurrency:` op WORKFLOWNIVEAU — de repositorybrede rij van de writer. Alleen
 * inspringing 0 telt; een sleutel dieper in het document is een jobrij en geen runrij. `null`
 * betekent "dit bestand serialiseert zijn runs niet".
 */
export function extractWorkflowConcurrency(lines) {
  const index = lines.findIndex(
    (l) => l.indent === 0 && /^["']?concurrency["']?\s*:/.test(l.text),
  );
  if (index === -1) return null;
  return readConcurrencyBlock(lines, index);
}

/** De sleutels van `strategy.matrix` van één job; leeg als de job geen matrix draait. */
export function extractJobMatrixKeys(job) {
  const strategy = jobLevelKeys(job).find((l) => /^\s*["']?strategy["']?\s*:/.test(l.text));
  if (!strategy) return [];
  const strategyBlock = blockChildren(job.lines, job.lines.indexOf(strategy));
  const matrixIndex = strategyBlock.findIndex((l) => /^\s*["']?matrix["']?\s*:/.test(l.text));
  if (matrixIndex === -1) return [];
  const matrixBlock = blockChildren(strategyBlock, matrixIndex);
  if (matrixBlock.length === 0) return [];
  const keyIndent = Math.min(...matrixBlock.map((l) => l.indent));
  return matrixBlock
    .filter((l) => l.indent === keyIndent)
    .map((l) => l.text.trim().match(/^["']?([A-Za-z_][A-Za-z0-9_-]*)["']?\s*:/)?.[1] ?? '')
    // `include` en `exclude` zijn GEEN matrixdimensies maar bijstellingen op de dimensies. Een
    // concurrencygroep die op `matrix.include` sleutelt bestaat niet, dus mag zo'n sleutel de
    // per-PR-eis ook niet kunnen vervullen.
    .filter((v) => v.length > 0 && v !== 'include' && v !== 'exclude');
}

/** Volledige statische meting van één workflowbestand. Pure functie: tekst in, feiten uit. */
export function analyzeWorkflow(text) {
  const lines = structureLines(text);
  const jobs = extractJobs(lines);
  const jobLines = new Set(jobs.flatMap((job) => job.lines));
  const outsideJobs = lines.filter((line) => !jobLines.has(line));

  const parsedTriggers = extractTriggers(lines);
  const nameLine = lines.find((l) => l.indent === 0 && /^["']?name["']?\s*:/.test(l.text));
  const workflowConcurrency = extractWorkflowConcurrency(lines);

  return {
    name: nameLine ? unquote(nameLine.text.replace(/^["']?name["']?\s*:/, '')) : '',
    // `triggers` is altijd een lijst, ook bij een onleesbare vorm; `triggersUnparseable` draagt het
    // verschil, zodat een onleesbare `on:` nooit stil als "geen trigger" kan doorgaan.
    triggers: parsedTriggers ?? [],
    triggersUnparseable: parsedTriggers === null,
    // Een workflowbrede `concurrency:` coalesceert HELE runs — inclusief de leesjob die het
    // resterende quotum meet. Tot en met V12 was dat hier een verboden vorm; sinds V13 is precies
    // deze vorm de REPARATIE, en daarom draagt de analyse nu het gelezen blok en niet enkel het
    // feit dat er iets staat. Wat de vorm moet zijn staat in `isRepositoryWideQueuedLock()`.
    // Alleen inspringing 0 telt als workflowniveau.
    workflowConcurrency,
    workflowLevelConcurrency: workflowConcurrency !== null,
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
      concurrency: extractJobConcurrency(job),
      matrixKeys: extractJobMatrixKeys(job),
    })),
    usesSecrets: lines.some((l) => /\bsecrets\s*\./.test(l.text)),
    checkoutRefs: lines
      .filter((l) => /^\s*ref\s*:/.test(l.text))
      .map((l) => unquote(l.text.replace(/^\s*ref\s*:/, ''))),
    // Bewust op de ACTIENAAM en niet op de eigenaar. De vorige vorm eiste het voorvoegsel
    // `actions/`, waardoor `dawidd6/action-download-artifact`, een gevorkte `someone/cache` of
    // welke herverpakking dan ook er ongemoeid doorheen liep — terwijl juist die acties de
    // artifacts van de ONBEVOORRECHTE bronrun de trusted job in kunnen trekken. Over-benaderend in
    // de veilige richting: `\S*` dekt ook de eigenaar, dus `cache-corp/iets` slaat ook aan. Dat kost
    // hooguit een vals alarm. Comment- en blok-scalarruis kan hier niet binnenkomen, want `lines`
    // komt uit `structureLines()` en die heeft beide al verwijderd.
    usesArtifactsOrCache: lines.some(
      (l) => /uses\s*:\s*\S*(cache|download-artifact|upload-artifact)/.test(l.text),
    ),
  };
}

/**
 * Refvormen die PR-GECONTROLEERDE code uitchecken. De puntvorm alleen volstond niet: de
 * `workflow_run`-payload draagt dezelfde velden met een UNDERSCORE
 * (`github.event.workflow_run.head_sha`, `.head_branch`), en die payload komt van een run waarvan de
 * definitie door de pull request geleverd kan zijn. Een writer die daarop uitcheckt, checkt dus
 * PR-code uit terwijl hij `statuses: write` draagt. `head_commit` staat er preventief bij, want
 * `push`- en `workflow_run`-payloads dragen dat veld ook.
 */
const PR_CODE_REF_RE = /pull_request|pull\/|head[._](sha|ref|branch|commit)|github\.head_ref/;
/** Een jobconditie die de job aantoonbaar tot het `pull_request`-event beperkt. */
const PR_ONLY_RE = /github\.event_name\s*==\s*['"]pull_request['"]/;

/** De verwijzing naar de matrixwaarde waarop de schrijfrij per PR gesleuteld moet zijn. */
const MATRIX_GROUP_REF_RE = /\$\{\{\s*matrix\.([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/;

/**
 * Contextvelden die per RUN verschillen in plaats van per PR. Staat er zoiets in de groep, dan
 * vallen twee aanleidingen voor dezelfde PR in verschillende rijen en meten ze weer gelijktijdig —
 * exact de vorm die de gedeelde statuscontext eerder stuk maakte.
 */
const VOLATILE_GROUP_RE = /github\.(run_id|run_number|run_attempt|event|sha|ref|actor|job)/;

/**
 * De schrijvende job moet PER PULL REQUEST geserialiseerd zijn, en wel zo dat een gequeueëde
 * aanleiding niet verdwijnt.
 *
 *   - de groep sleutelt op een matrixwaarde die deze job werkelijk als matrixdimensie draagt, en op
 *     niets wat per run verschilt: twee aanleidingen voor PR 74 delen dan één rij, terwijl PR 74 en
 *     PR 75 elkaar niet blokkeren;
 *   - `cancel-in-progress: false`: een lopende schrijfbeurt wordt nooit halverwege afgekapt, want
 *     dan zou een head op `pending` blijven staan;
 *   - `queue: max`: GitHub bewaart standaard (`single`) hooguit ÉÉN wachtende job per groep en
 *     annuleert de vorige. Met `max` blijven wachtende beurten in de rij staan tot de
 *     maximumlengte, dus kan een aanleiding niet stil verdwijnen.
 */
export function isPerPullRequestQueuedWriteJob(job) {
  const concurrency = job?.concurrency;
  if (!concurrency || concurrency.unparseable) return false;
  if (concurrency.cancelInProgress !== 'false') return false;
  if (concurrency.queue !== 'max') return false;
  if (VOLATILE_GROUP_RE.test(concurrency.group)) return false;
  const reference = MATRIX_GROUP_REF_RE.exec(concurrency.group);
  if (!reference) return false;
  return Array.isArray(job.matrixKeys) && job.matrixKeys.includes(reference[1]);
}

/**
 * De verwijzing naar de merge-group-SHA waarop de merge-group-poort per unit geserialiseerd moet
 * zijn — het analogon van `matrix.pr` bij de writer/finalizer, maar dan voor een job ZONDER matrix:
 * de merge-group-poort draait als één vaste job per `merge_group`-aanleiding, dus is er geen
 * matrixdimensie om op te sleutelen. `github.event.merge_group.head_sha` is de enige per-aanleiding
 * waarde die GitHub voor dit event levert en die niet per RUN maar per MERGE-GROUP verschilt (twee
 * herinschrijvingen van dezelfde group delen dezelfde head_sha totdat de queue-commit verandert).
 */
const MERGE_GROUP_SHA_GROUP_RE = /\$\{\{\s*github\.event\.merge_group\.head_sha\s*\}\}/;

/**
 * De schrijvende job van de merge-group-poort moet PER MERGE-GROUP-SHA geserialiseerd zijn.
 *
 * `VOLATILE_GROUP_RE` verbiedt élke `github.event`-verwijzing — een bewust brede regel, want de
 * schrijvers waarvoor hij oorspronkelijk geschreven is (de trusted writer, de finalizer) hebben geen
 * enkele legitieme reden om op een `github.event.*`-veld te sleutelen. Voor DEZE job is dat anders:
 * `github.event.merge_group.head_sha` is precies de per-eenheid sleutel die de queue-poort nodig
 * heeft, op dezelfde manier als `matrix.pr` dat voor de writer is. Deze validator staat daarom
 * UITSLUITEND die ene verwijzing toe: hij knipt de toegestane substring uit de groepstekst en toetst
 * wat overblijft opnieuw aan `VOLATILE_GROUP_RE` — elke ANDERE vluchtige `github.*`-verwijzing in
 * dezelfde groep blijft dus alsnog een overtreding.
 */
export function isPerMergeGroupQueuedWriteJob(job) {
  const concurrency = job?.concurrency;
  if (!concurrency || concurrency.unparseable) return false;
  if (concurrency.cancelInProgress !== 'false') return false;
  if (!MERGE_GROUP_SHA_GROUP_RE.test(concurrency.group)) return false;
  const remainder = concurrency.group.replace(MERGE_GROUP_SHA_GROUP_RE, '');
  return !VOLATILE_GROUP_RE.test(remainder);
}

/**
 * De vaste naam van de repositorybrede schrijfrij van de trusted writer.
 *
 * Hij is met opzet een LITERAL zonder één expressie. Een groep met een `${{ ... }}`-suffix — welk
 * veld dan ook — valt per run, per event of per PR uiteen in verschillende groepen, en dan
 * serialiseert er niets meer. Dat is exact de vorm die de gedeelde quotumteller liet racen.
 */
export const TRUSTED_WRITER_REPOSITORY_LOCK_GROUP = 'autocoding-shield-live-gate-repository';

/** Elke GitHub-expressie. In de globale groep is er geen enkele toegestaan. */
const EXPRESSION_RE = /\$\{\{/;

/**
 * De HELE writerrun moet repositorybreed geserialiseerd zijn, en wel in een WACHTENDE rij.
 *
 * Codex-review-bevinding op V12: de per-PR-jobrij begrenst één run correct, maar de quotummeting is
 * daarmee nog niet atomair over RUNS heen. Twee eventruns voor VERSCHILLENDE PR's vallen in
 * verschillende jobrijen, meten dus tegelijk hetzelfde `rate_limit.remaining`, en reserveren ieder
 * hetzelfde restant. Het uurquotum van duizend verzoeken is per REPOSITORY gedeeld, dus konden een
 * schedule van hoogstens 654 verzoeken en een reeks eventruns er samen overheen gaan terwijl elke
 * run afzonderlijk binnen zijn eigen begroting bleef.
 *
 * De rij die dat sluit heeft precies deze vorm, en elke afwijking is fail-closed:
 *
 *   - de groep is een VASTE literal, gelijk voor elk event, elke PR en elke run: alleen dan vallen
 *     twee aanleidingen in dezelfde rij en meet de tweede pas ná wat de eerste heeft uitgegeven;
 *   - `cancel-in-progress: false`: een lopende schrijfbeurt wordt nooit afgekapt, want dan blijft
 *     een head op `pending` staan;
 *   - `queue: max`: met de standaard `single` bewaart GitHub hooguit ÉÉN wachtende run per groep en
 *     annuleert de vorige. Dat was in V11 de reden om een globale rij juist te WEIGEREN. Met `max`
 *     blijven wachtende runs staan, en pas daardoor is een globale rij bruikbaar in plaats van een
 *     stille verliespost.
 *
 * Omdat de rij op WORKFLOWNIVEAU staat, is hij verworven vóór de eerste job — dus vóór de selectie
 * en vóór de `rate_limit`-meting — en komt hij pas vrij als alle matrixwriters klaar zijn.
 */
export function isRepositoryWideQueuedLock(concurrency, {
  group = TRUSTED_WRITER_REPOSITORY_LOCK_GROUP,
} = {}) {
  if (!concurrency || concurrency.unparseable) return false;
  if (concurrency.cancelInProgress !== 'false') return false;
  if (concurrency.queue !== 'max') return false;
  if (EXPRESSION_RE.test(concurrency.group)) return false;
  if (VOLATILE_GROUP_RE.test(concurrency.group)) return false;
  return concurrency.group === group;
}

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
export function findTrustBoundaryViolations({
  workflows, prShieldPath, trustedWriterPath, trustedFinalizerPath, trustedMergeGroupGatePath,
}) {
  const violations = [];
  const add = (code, path) => violations.push(`${code}:${path}`);
  const list = Array.isArray(workflows) ? workflows : [];

  let sawPrShield = false;
  let sawTrustedWriter = false;
  let sawTrustedFinalizer = false;
  let sawTrustedMergeGroupGate = false;

  // De naam waarop de writer zijn `workflow_run` moet pinnen komt uit het SHIELDBESTAND zelf, niet
  // uit een losse literal: zo kan een hernoemde shield de keten niet stil loskoppelen.
  const shieldEntry = list.find((w) => w?.path === prShieldPath);
  const shieldWorkflowName = shieldEntry ? analyzeWorkflow(shieldEntry.text).name : '';

  for (const { path, text } of list) {
    const wf = analyzeWorkflow(text);
    const untrusted = wf.triggers.filter((t) => UNTRUSTED_TRIGGERS.includes(t));

    // Fail-closed op een `on:`-vorm die niet met zekerheid te lezen is. Zonder deze regel leest een
    // onleesbare vorm als "geen triggers" en mag het bestand dus een schrijfscope dragen.
    if (wf.triggersUnparseable) add(TRUST_VIOLATION.TRIGGER_MAPPING_UNPARSEABLE, path);

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
    // `issue_comment` draait de default-branch-definitie en is daarom in de trusted writer
    // toegelaten — maar uitsluitend daar. Elk ander schrijvend bestand dat dit event opent, geeft
    // iedere commentator een directe trekker naar een token met schrijfrechten.
    if (path !== trustedWriterPath && wf.triggers.includes('issue_comment') && wf.writeGrants.length > 0) {
      add(TRUST_VIOLATION.ISSUE_COMMENT_WRITE_OUTSIDE_TRUSTED_WRITER, path);
    }
    // De mergescope is repositorybreed geconcentreerd op één bestand. `write-all` telt mee: die
    // vorm draagt `pull-requests: write` zonder het woord te noemen, en juist die stille vorm zou de
    // concentratie ongemerkt opheffen.
    if (path !== trustedFinalizerPath
      && wf.writeGrants.some((g) => g.scope === 'pull-requests' || g.scope === '*')) {
      add(TRUST_VIOLATION.PULL_REQUESTS_WRITE_OUTSIDE_FINALIZER, path);
    }
    // De check-runscope is repositorybreed geconcentreerd op de merge-group-poort, om dezelfde reden
    // als bij `pull-requests: write`: dit is de enige plek die een merge-queue-vereiste status mag
    // publiceren, en elke andere drager van die scope zou een tweede, ongecontroleerde weg naar
    // diezelfde vereiste context openen.
    if (path !== trustedMergeGroupGatePath
      && wf.writeGrants.some((g) => g.scope === 'checks' || g.scope === '*')) {
      add(TRUST_VIOLATION.CHECKS_WRITE_OUTSIDE_MERGE_GROUP_GATE, path);
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
      // De allowlist is strenger dan "niet untrusted": alleen `workflow_run`, `schedule` en
      // `issue_comment` laden gegarandeerd de default-branch-definitie. Bij de eerste twee kan een
      // PR-actor het event niet richten; bij `issue_comment` wel, maar dan nog steeds uitsluitend
      // tegen de definitie die op de default branch staat — en de PR-associatie komt uit een veld
      // dat GitHub vult. Zie `TRUSTED_WRITER_TRIGGERS`.
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
      // De writer bestaat nu uit een LEZENDE selectiejob en een SCHRIJVENDE matrixjob. De grens is
      // daarom niet meer "precies één job" maar "precies één job met een schrijfscope", plus de eis
      // dat juist die job per PR geserialiseerd is.
      const writeJobs = wf.jobs.filter((job) => job.writeGrants.length > 0);
      if (writeJobs.length !== 1) add(TRUST_VIOLATION.TRUSTED_WRITER_WRITE_JOB_NOT_UNIQUE, path);
      for (const job of writeJobs) {
        if (!isPerPullRequestQueuedWriteJob(job)) {
          add(TRUST_VIOLATION.TRUSTED_WRITER_WRITE_JOB_NOT_PER_PULL_REQUEST_QUEUED, path);
        }
      }
      // De repositorybrede rij is sinds V13 VERPLICHT en alleen in deze ene vorm toegestaan.
      // Ontbrekend, onleesbaar, dynamisch, `queue: single`, geen `queue` of `cancel-in-progress:
      // true` zijn allemaal dezelfde overtreding: zonder wachtende rij op één vaste groep kunnen
      // twee runs hetzelfde resterende quotum reserveren.
      if (!isRepositoryWideQueuedLock(wf.workflowConcurrency)) {
        add(TRUST_VIOLATION.TRUSTED_WRITER_NOT_REPOSITORY_QUEUED, path);
      }
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

    // DE MERGEFINALIZER. Dezelfde vorm als de writer — één schrijvende job, per PR gequeued,
    // repositorybreed geserialiseerd, geen secrets, geen artifacts, geen PR-code — met twee
    // verschillen: alleen een klok mag hem starten, en zijn enige toegestane schrijfscope is
    // `pull-requests`. De checkout-eis is hier bovendien POSITIEF geformuleerd: niet "geen PR-code"
    // maar "aantoonbaar de default branch".
    if (path === trustedFinalizerPath) {
      sawTrustedFinalizer = true;
      if (untrusted.length > 0) add(TRUST_VIOLATION.TRUSTED_FINALIZER_HAS_UNTRUSTED_TRIGGER, path);
      if (wf.triggers.some((t) => !TRUSTED_FINALIZER_TRIGGERS.includes(t))) {
        add(TRUST_VIOLATION.TRUSTED_FINALIZER_TRIGGER_NOT_ALLOWED, path);
      }
      if (wf.triggers.length === 0) add(TRUST_VIOLATION.TRUSTED_FINALIZER_HAS_NO_TRIGGER, path);

      const finalizerWriteJobs = wf.jobs.filter((job) => job.writeGrants.length > 0);
      if (finalizerWriteJobs.length !== 1) {
        add(TRUST_VIOLATION.TRUSTED_FINALIZER_WRITE_JOB_NOT_UNIQUE, path);
      }
      for (const job of finalizerWriteJobs) {
        if (!isPerPullRequestQueuedWriteJob(job)) {
          add(TRUST_VIOLATION.TRUSTED_FINALIZER_WRITE_JOB_NOT_PER_PULL_REQUEST_QUEUED, path);
        }
      }
      if (!isRepositoryWideQueuedLock(wf.workflowConcurrency, {
        group: FINALIZER_REPOSITORY_LOCK_GROUP,
      })) {
        add(TRUST_VIOLATION.TRUSTED_FINALIZER_NOT_REPOSITORY_QUEUED, path);
      }
      if (wf.workflowLevelWriteGrants.length > 0) {
        add(TRUST_VIOLATION.TRUSTED_FINALIZER_WORKFLOW_LEVEL_WRITE, path);
      }
      if (!scopesOf(wf.writeGrants).every((s) => ALLOWED_FINALIZER_WRITE_SCOPES.includes(s))) {
        add(TRUST_VIOLATION.TRUSTED_FINALIZER_WRITE_SCOPE_NOT_ALLOWED, path);
      }
      if (wf.usesSecrets) add(TRUST_VIOLATION.TRUSTED_FINALIZER_USES_SECRETS, path);
      if (wf.checkoutRefs.length === 0
        || !wf.checkoutRefs.every((ref) => DEFAULT_BRANCH_REF_RE.test(ref))) {
        add(TRUST_VIOLATION.TRUSTED_FINALIZER_CHECKS_OUT_PR_CODE, path);
      }
      if (wf.usesArtifactsOrCache) add(TRUST_VIOLATION.TRUSTED_FINALIZER_USES_PR_ARTIFACTS, path);
    }

    // DE MERGE-GROUP-POORT. Zelfde grondvorm als writer/finalizer — één schrijvende job, geen
    // secrets, geen artifacts, aantoonbaar de default branch uitgecheckt — met drie verschillen: de
    // enige toegestane trigger is `merge_group`, de enige toegestane schrijfscope is `checks`, en de
    // per-eenheid rij sleutelt op de merge-group-SHA in plaats van op een matrixwaarde (er is geen
    // matrix: dit is één vaste job per aanleiding). Anders dan de finalizer heeft deze job GEEN
    // repositorybrede rij nodig: een merge-group-SHA is al uniek per inschrijving, dus ontbreekt hier
    // het gedeelde-quotumprobleem dat de writer/finalizer wél hebben.
    if (path === trustedMergeGroupGatePath) {
      sawTrustedMergeGroupGate = true;
      if (untrusted.length > 0) add(TRUST_VIOLATION.TRUSTED_MERGE_GROUP_GATE_HAS_UNTRUSTED_TRIGGER, path);
      if (wf.triggers.some((t) => !TRUSTED_MERGE_GROUP_GATE_TRIGGERS.includes(t))) {
        add(TRUST_VIOLATION.TRUSTED_MERGE_GROUP_GATE_TRIGGER_NOT_ALLOWED, path);
      }
      if (wf.triggers.length === 0) add(TRUST_VIOLATION.TRUSTED_MERGE_GROUP_GATE_HAS_NO_TRIGGER, path);

      const gateWriteJobs = wf.jobs.filter((job) => job.writeGrants.length > 0);
      if (gateWriteJobs.length !== 1) {
        add(TRUST_VIOLATION.TRUSTED_MERGE_GROUP_GATE_WRITE_JOB_NOT_UNIQUE, path);
      }
      for (const job of gateWriteJobs) {
        if (!isPerMergeGroupQueuedWriteJob(job)) {
          add(TRUST_VIOLATION.TRUSTED_MERGE_GROUP_GATE_WRITE_JOB_NOT_PER_MERGE_GROUP_QUEUED, path);
        }
      }
      if (wf.workflowLevelWriteGrants.length > 0) {
        add(TRUST_VIOLATION.TRUSTED_MERGE_GROUP_GATE_WORKFLOW_LEVEL_WRITE, path);
      }
      if (!scopesOf(wf.writeGrants).every((s) => ALLOWED_MERGE_GROUP_GATE_WRITE_SCOPES.includes(s))) {
        add(TRUST_VIOLATION.TRUSTED_MERGE_GROUP_GATE_WRITE_SCOPE_NOT_ALLOWED, path);
      }
      if (wf.usesSecrets) add(TRUST_VIOLATION.TRUSTED_MERGE_GROUP_GATE_USES_SECRETS, path);
      if (wf.checkoutRefs.length === 0
        || !wf.checkoutRefs.every((ref) => DEFAULT_BRANCH_REF_RE.test(ref))) {
        add(TRUST_VIOLATION.TRUSTED_MERGE_GROUP_GATE_CHECKS_OUT_PR_CODE, path);
      }
      if (wf.usesArtifactsOrCache) add(TRUST_VIOLATION.TRUSTED_MERGE_GROUP_GATE_USES_PR_ARTIFACTS, path);
    }
  }

  if (prShieldPath && !sawPrShield) add(TRUST_VIOLATION.PR_SHIELD_MISSING, prShieldPath);
  if (trustedWriterPath && !sawTrustedWriter) add(TRUST_VIOLATION.TRUSTED_WRITER_MISSING, trustedWriterPath);
  if (trustedFinalizerPath && !sawTrustedFinalizer) {
    add(TRUST_VIOLATION.TRUSTED_FINALIZER_MISSING, trustedFinalizerPath);
  }
  if (trustedMergeGroupGatePath && !sawTrustedMergeGroupGate) {
    add(TRUST_VIOLATION.TRUSTED_MERGE_GROUP_GATE_MISSING, trustedMergeGroupGatePath);
  }
  return violations;
}
