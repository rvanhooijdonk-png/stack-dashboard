/**
 * AUTOCODING_SHIELD — statische vertrouwensgrens tussen de PR-shield en de statuswriter.
 *
 * Codex P1, review 4998406843, inline 3834611207. Een `pull_request`-run gebruikt de door de PR
 * VOORGESTELDE workflowdefinitie. Zolang dezelfde YAML een job met `statuses: write` bevatte, kon een
 * same-repo branch de stappen van die job vervangen en de receiptstatus zelf groen schrijven. Het
 * uitchecken van de default branch beschermt de SCRIPTS, niet de YAML die de job en zijn
 * tokenpermissies definieert.
 *
 * Die grens is een eigenschap van de BESTANDEN, dus wordt hij hier gemeten in plaats van beloofd:
 * eerst op synthetische YAML (zodat de meter zelf getoetst is, inclusief het gerapporteerde defect),
 * daarna op alle werkelijke workflowbestanden van deze repository.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import {
  analyzeWorkflow, structureLines, extractTriggers, extractWriteGrants, extractJobs,
  extractWorkflowRunSources, stripInlineComment, findTrustBoundaryViolations, TRUST_VIOLATION,
  UNTRUSTED_TRIGGERS, TRUSTED_WRITER_TRIGGERS,
} from '../scripts/autocoding/workflow-trust.mjs';

const WORKFLOW_DIR = '.github/workflows';
const PR_SHIELD = `${WORKFLOW_DIR}/autocoding-shield.yml`;
const TRUSTED_WRITER = `${WORKFLOW_DIR}/autocoding-shield-live-gate.yml`;

function allWorkflows() {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => ({ path: join(WORKFLOW_DIR, name), text: readFileSync(join(WORKFLOW_DIR, name), 'utf8') }));
}

function violations(workflows) {
  return findTrustBoundaryViolations({
    workflows, prShieldPath: PR_SHIELD, trustedWriterPath: TRUSTED_WRITER,
  });
}

/** Een minimale, schone PR-shield. De writer pint zijn `workflow_run` op DEZE naam. */
const SCHONE_SHIELD = [
  'name: autocoding-shield',
  'on:',
  '  pull_request:',
  '    branches: [main]',
  'permissions: {}',
  'jobs:',
  '  autocoding-shield:',
  "    if: github.event_name == 'pull_request'",
  '    permissions:',
  '      contents: read',
  '    steps:',
  '      - uses: actions/checkout@v4',
].join('\n');

/** De grens meten mét een schone shield ernaast, zodat alleen het writerdefect overblijft. */
function writerViolations(text) {
  return violations([{ path: PR_SHIELD, text: SCHONE_SHIELD }, { path: TRUSTED_WRITER, text }]);
}

/** Een verder schone writer met precies één uitcheckref, zodat alleen die ref gemeten wordt. */
const WRITER_MET_REF = (ref) => [
  'name: autocoding-shield-live-gate',
  'on:',
  '  workflow_run:',
  '    workflows: [autocoding-shield]',
  '    types: [completed]',
  'permissions: {}',
  'jobs:',
  '  autocoding-shield-live-gate:',
  '    permissions:',
  '      statuses: write',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '        with:',
  `          ref: ${ref}`,
].join('\n');

/** Idem met precies één extra actie, zodat alleen die `uses:` gemeten wordt. */
const WRITER_MET_ACTIE = (uses) => [
  'name: autocoding-shield-live-gate',
  'on:',
  '  workflow_run:',
  '    workflows: [autocoding-shield]',
  '    types: [completed]',
  'permissions: {}',
  'jobs:',
  '  autocoding-shield-live-gate:',
  '    permissions:',
  '      statuses: write',
  '    steps:',
  `      - uses: ${uses}`,
].join('\n');

// --- De meter zelf ------------------------------------------------------------------------------

test('T1. commentaar en blok-scalars tellen niet mee als YAML-structuur', () => {
  assert.equal(stripInlineComment('  statuses: write # toelichting'), '  statuses: write ');
  assert.equal(stripInlineComment("  ref: 'a#b'"), "  ref: 'a#b'");
  assert.equal(stripInlineComment('# hele regel'), '');

  // Een `run:`-blok bevat shell, geen YAML. Wat daarin staat mag nooit als permissie gelezen worden,
  // en wat erbuiten staat mag nooit door dat blok verstopt raken.
  const yaml = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - run: |',
    '          echo "statuses: write"',
    '          echo "pull_request_target"',
    '      - name: klaar',
  ].join('\n');
  assert.deepEqual(extractWriteGrants(structureLines(yaml)), []);
  assert.ok(!structureLines(yaml).some((l) => l.text.includes('pull_request_target')));
});

test('T2. triggers worden in alle drie de YAML-vormen gelezen', () => {
  assert.deepEqual(extractTriggers(structureLines('on: push\n')), ['push']);
  assert.deepEqual(extractTriggers(structureLines('on: [push, pull_request]\n')), ['push', 'pull_request']);
  assert.deepEqual(
    extractTriggers(structureLines('on:\n  pull_request:\n    branches: [main]\n  issue_comment:\n    types: [created]\n')),
    ['pull_request', 'issue_comment'],
  );
  assert.deepEqual(extractTriggers(structureLines('on:\n  - push\n  - pull_request_target\n')), ['push', 'pull_request_target']);
  // Een `schedule:`-sequence mag geen fantoomtrigger opleveren.
  assert.deepEqual(extractTriggers(structureLines("on:\n  schedule:\n    - cron: '0 * * * *'\n")), ['schedule']);
});

test('T3. elke schrijfvorm wordt herkend, ook flow-stijl en write-all', () => {
  const scopes = (yaml) => extractWriteGrants(structureLines(yaml)).map((g) => g.scope);
  assert.deepEqual(scopes('permissions:\n  statuses: write\n'), ['statuses']);
  assert.deepEqual(scopes('permissions: { contents: read, statuses: write }\n'), ['statuses']);
  assert.deepEqual(scopes('permissions: write-all\n'), ['*']);
  assert.deepEqual(scopes('permissions:\n  contents: read\n'), []);
  assert.deepEqual(scopes('permissions: {}\n'), []);
});

test('T4. schrijfscopes worden aan de juiste job toegerekend', () => {
  const yaml = [
    'on:',
    '  push:',
    'jobs:',
    '  leest:',
    '    permissions:',
    '      contents: read',
    '  schrijft:',
    '    permissions:',
    '      statuses: write',
  ].join('\n');
  const jobs = extractJobs(structureLines(yaml));
  assert.deepEqual(jobs.map((j) => j.id), ['leest', 'schrijft']);
  const analysed = analyzeWorkflow(yaml);
  assert.deepEqual(analysed.jobs.map((j) => [j.id, j.writeGrants.map((g) => g.scope)]),
    [['leest', []], ['schrijft', ['statuses']]]);
  assert.deepEqual(analysed.workflowLevelWriteGrants, []);
});

// --- De grens zelf ------------------------------------------------------------------------------

test('T5. NEGATIEVE CONTROLE: de gemeten vorm van 07659bd wordt als overtreding herkend', () => {
  // Letterlijk de structuur die de reviewbevinding beschrijft: één bestand met zowel het
  // `pull_request`-event als een job met `statuses: write`. Op dat event draait GitHub de door de PR
  // voorgestelde definitie, dus kan de PR zijn eigen statuswriterstappen vervangen.
  const kwetsbaar = [
    'name: autocoding-shield',
    'on:',
    '  pull_request:',
    '    branches: [main]',
    '  issue_comment:',
    '    types: [created]',
    'permissions: {}',
    'jobs:',
    '  autocoding-shield:',
    "    if: github.event_name == 'pull_request'",
    '    permissions:',
    '      contents: read',
    '  autocoding-shield-live-gate:',
    '    permissions:',
    '      statuses: write',
  ].join('\n');
  const gevonden = violations([{ path: PR_SHIELD, text: kwetsbaar }]);
  assert.ok(gevonden.includes(`${TRUST_VIOLATION.UNTRUSTED_TRIGGER_WITH_WRITE_PERMISSION}:${PR_SHIELD}`));
  assert.ok(gevonden.includes(`${TRUST_VIOLATION.PR_SHIELD_HAS_WRITE_PERMISSION}:${PR_SHIELD}`));
  assert.ok(gevonden.includes(`${TRUST_VIOLATION.STATUSES_WRITE_OUTSIDE_TRUSTED_WRITER}:${PR_SHIELD}`));
  assert.ok(gevonden.includes(`${TRUST_VIOLATION.TRUSTED_WRITER_MISSING}:${TRUSTED_WRITER}`));
});

test('T6. een trusted writer die zelf een PR-event of extra schrijfscope krijgt, valt om', () => {
  const basis = (extraOn, extraPerm) => [
    'name: autocoding-shield-live-gate',
    'on:',
    '  workflow_run:',
    '    workflows: [autocoding-shield]',
    '    types: [completed]',
    ...extraOn,
    'permissions: {}',
    'jobs:',
    '  autocoding-shield-live-gate:',
    '    permissions:',
    '      statuses: write',
    ...extraPerm,
  ].join('\n');

  for (const trigger of UNTRUSTED_TRIGGERS) {
    const gevonden = writerViolations(basis([`  ${trigger}:`], []));
    assert.ok(
      gevonden.includes(`${TRUST_VIOLATION.TRUSTED_WRITER_HAS_UNTRUSTED_TRIGGER}:${TRUSTED_WRITER}`),
      trigger,
    );
    assert.ok(
      gevonden.includes(`${TRUST_VIOLATION.UNTRUSTED_TRIGGER_WITH_WRITE_PERMISSION}:${TRUSTED_WRITER}`),
      trigger,
    );
  }

  for (const scope of ['contents: write', 'actions: write', 'pull-requests: write', 'id-token: write']) {
    const gevonden = writerViolations(basis([], [`      ${scope}`]));
    assert.ok(
      gevonden.includes(`${TRUST_VIOLATION.TRUSTED_WRITER_WRITE_SCOPE_NOT_ALLOWED}:${TRUSTED_WRITER}`),
      scope,
    );
  }

  // Een tweede job, een schrijfscope op workflowniveau, secrets, PR-headcheckout en PR-cache
  // zijn allemaal eigen overtredingen.
  const tweedeJob = `${basis([], [])}\n  extra:\n    runs-on: ubuntu-latest`;
  assert.ok(writerViolations(tweedeJob)
    .includes(`${TRUST_VIOLATION.TRUSTED_WRITER_HAS_MULTIPLE_JOBS}:${TRUSTED_WRITER}`));

  const topLevelWrite = basis([], []).replace('permissions: {}', 'permissions:\n  statuses: write');
  assert.ok(writerViolations(topLevelWrite)
    .includes(`${TRUST_VIOLATION.TRUSTED_WRITER_WORKFLOW_LEVEL_WRITE}:${TRUSTED_WRITER}`));

  const metSecret = `${basis([], [])}\n    env:\n      TOKEN: \${{ secrets.PAT }}`;
  assert.ok(writerViolations(metSecret)
    .includes(`${TRUST_VIOLATION.TRUSTED_WRITER_USES_SECRETS}:${TRUSTED_WRITER}`));

  const metPrHead = `${basis([], [])}\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}`;
  assert.ok(writerViolations(metPrHead)
    .includes(`${TRUST_VIOLATION.TRUSTED_WRITER_CHECKS_OUT_PR_CODE}:${TRUSTED_WRITER}`));

  const metCache = `${basis([], [])}\n    steps:\n      - uses: actions/cache@v4`;
  assert.ok(writerViolations(metCache)
    .includes(`${TRUST_VIOLATION.TRUSTED_WRITER_USES_PR_ARTIFACTS}:${TRUSTED_WRITER}`));
});

test('T6a. de headref van de BRONRUN is net zo goed PR-code als `head.sha`', () => {
  // Gemini security-high, review 4998655866, inline 3834814303. De writer wordt door `workflow_run`
  // gestart, en die payload draagt de PR-head onder een UNDERSCORE: `head_sha`, `head_branch`,
  // `head_commit`. De bronrun kan een door de PR geleverde definitie hebben gehad, dus is die head
  // even onbetrouwbaar als `github.event.pull_request.head.sha` — maar de oude puntvorm van
  // `PR_CODE_REF_RE` liet hem gewoon door. Een writer met `statuses: write` checkte dan PR-code uit.
  const onveilig = [
    '${{ github.event.workflow_run.head_sha }}',
    '${{ github.event.workflow_run.head_branch }}',
    '${{ github.event.workflow_run.head_commit.id }}',
    '${{ github.event.pull_request.head.sha }}',
    '${{ github.event.pull_request.head.ref }}',
    '${{ github.head_ref }}',
    'refs/pull/74/merge',
  ];
  for (const ref of onveilig) {
    assert.ok(
      writerViolations(WRITER_MET_REF(ref))
        .includes(`${TRUST_VIOLATION.TRUSTED_WRITER_CHECKS_OUT_PR_CODE}:${TRUSTED_WRITER}`),
      ref,
    );
  }

  // En de enige vorm die de writer werkelijk gebruikt blijft toegestaan; anders zou de regel niet
  // meer meten maar alleen nog blokkeren.
  for (const ref of ['${{ github.event.repository.default_branch }}', 'main', 'refs/heads/main']) {
    assert.deepEqual(writerViolations(WRITER_MET_REF(ref)), [], ref);
  }
});

test('T6b. artifact- en cacheacties worden op de ACTIENAAM geweigerd, niet op de eigenaar', () => {
  // Gemini security-high, review 4998655866, inline 3834814309. De oude vorm eiste het voorvoegsel
  // `actions/`. Derdepartijacties als `dawidd6/action-download-artifact` doen precies hetzelfde —
  // ze trekken de artifacts van de ONBEVOORRECHTE bronrun de trusted job in — en liepen er zo
  // ongemoeid doorheen.
  const verboden = [
    'actions/cache@v4',
    'actions/cache/restore@v4',
    'actions/download-artifact@v4',
    'actions/upload-artifact@v4',
    'dawidd6/action-download-artifact@v6',
    'buildjet/cache@v4',
    'Swatinem/rust-cache@v2',
    'aochmann/actions-download-artifact@v3',
  ];
  for (const uses of verboden) {
    assert.ok(
      writerViolations(WRITER_MET_ACTIE(uses))
        .includes(`${TRUST_VIOLATION.TRUSTED_WRITER_USES_PR_ARTIFACTS}:${TRUSTED_WRITER}`),
      uses,
    );
  }

  // Over-benaderend mag, vals alarm op TEKST mag niet: een commentaarregel en een shellregel in een
  // blok-scalar zijn geen `uses:`-structuur. Dat onderscheid komt uit `structureLines()`, dus wordt
  // het hier gemeten en niet aangenomen.
  const schoon = [
    'name: autocoding-shield-live-gate',
    'on:',
    '  workflow_run:',
    '    workflows: [autocoding-shield]',
    '    types: [completed]',
    'permissions: {}',
    'jobs:',
    '  autocoding-shield-live-gate:',
    '    permissions:',
    '      statuses: write',
    '    steps:',
    '      # nooit: uses: dawidd6/action-download-artifact@v6',
    '      - uses: actions/checkout@v4',
    '      - run: |',
    '          echo "uses: actions/upload-artifact@v4 staat hier alleen als tekst"',
    '          echo "en uses: buildjet/cache@v4 ook"',
  ].join('\n');
  assert.equal(analyzeWorkflow(schoon).usesArtifactsOrCache, false);
  assert.deepEqual(writerViolations(schoon), []);
});

const TRUST_MODULE = 'scripts/autocoding/workflow-trust.mjs';

/** Eén regel uit de meter terugdraaien naar zijn oude vorm en de MUTANT importeren. */
function mutantVanDeMeter(naam, oud, nieuw) {
  const bron = readFileSync(TRUST_MODULE, 'utf8');
  assert.equal(bron.split(oud).length - 1, 1, 'het mutatieanker moet precies één keer voorkomen');
  const dir = mkdtempSync(join(tmpdir(), `workflow-trust-${naam}-`));
  const pad = join(dir, `workflow-trust.${naam}.mjs`);
  writeFileSync(pad, bron.replace(oud, nieuw));
  return import(pathToFileURL(pad).href);
}

test('T6c. NEGATIEVE MUTATIE: de oude puntvorm laat de headref van de bronrun door', async () => {
  // De regel uit T6a is pas bewezen als de OUDE vorm er aantoonbaar op stukloopt. De mutant krijgt
  // exact de regex van vóór deze commit terug; hij mist dan precies de underscorevelden die de
  // `workflow_run`-payload draagt, terwijl de echte meter ze alle drie afkeurt.
  const gemuteerd = await mutantVanDeMeter(
    'pr-code-ref',
    'const PR_CODE_REF_RE = /pull_request|pull\\/|head[._](sha|ref|branch|commit)|github\\.head_ref/;',
    'const PR_CODE_REF_RE = /pull_request|pull\\/|head\\.sha|head\\.ref|github\\.head_ref/;',
  );

  const workflows = (ref) => [
    { path: PR_SHIELD, text: SCHONE_SHIELD },
    { path: TRUSTED_WRITER, text: WRITER_MET_REF(ref) },
  ];
  const gemist = `${TRUST_VIOLATION.TRUSTED_WRITER_CHECKS_OUT_PR_CODE}:${TRUSTED_WRITER}`;
  for (const ref of [
    '${{ github.event.workflow_run.head_sha }}',
    '${{ github.event.workflow_run.head_branch }}',
    '${{ github.event.workflow_run.head_commit.id }}',
  ]) {
    assert.deepEqual(
      gemuteerd.findTrustBoundaryViolations({
        workflows: workflows(ref), prShieldPath: PR_SHIELD, trustedWriterPath: TRUSTED_WRITER,
      }),
      [],
      `de mutant laat ${ref} door`,
    );
    assert.ok(writerViolations(WRITER_MET_REF(ref)).includes(gemist), ref);
  }
});

test('T6d. NEGATIEVE MUTATIE: de oude `actions/`-eis laat derdepartijartifacts door', async () => {
  // Zelfde bewijslast voor de eigenaar-eis. De mutant weigert alleen nog wat van `actions/` komt en
  // laat elke derdepartijvariant binnen; de echte meter kijkt naar de actienaam.
  const gemuteerd = await mutantVanDeMeter(
    'artifacts',
    "(l) => /uses\\s*:\\s*\\S*(cache|download-artifact|upload-artifact)/.test(l.text),",
    "(l) => /uses\\s*:\\s*actions\\/(cache|download-artifact|upload-artifact)/.test(l.text),",
  );

  const gemist = `${TRUST_VIOLATION.TRUSTED_WRITER_USES_PR_ARTIFACTS}:${TRUSTED_WRITER}`;
  for (const uses of [
    'dawidd6/action-download-artifact@v6',
    'buildjet/cache@v4',
    'Swatinem/rust-cache@v2',
    'aochmann/actions-download-artifact@v3',
  ]) {
    assert.equal(gemuteerd.analyzeWorkflow(WRITER_MET_ACTIE(uses)).usesArtifactsOrCache, false);
    assert.deepEqual(
      gemuteerd.findTrustBoundaryViolations({
        workflows: [
          { path: PR_SHIELD, text: SCHONE_SHIELD },
          { path: TRUSTED_WRITER, text: WRITER_MET_ACTIE(uses) },
        ],
        prShieldPath: PR_SHIELD, trustedWriterPath: TRUSTED_WRITER,
      }),
      [],
      `de mutant laat ${uses} door`,
    );
    assert.ok(writerViolations(WRITER_MET_ACTIE(uses)).includes(gemist), uses);
  }
});

test('T7. geen enkel workflowbestand in deze repository overtreedt de grens', () => {
  assert.deepEqual(violations(allWorkflows()), []);
});

test('T8. de gemeten vorm van de twee shieldbestanden is precies de bedoelde', () => {
  const shield = analyzeWorkflow(readFileSync(PR_SHIELD, 'utf8'));
  assert.deepEqual(shield.triggers, ['pull_request', 'issue_comment', 'pull_request_review']);
  assert.deepEqual(shield.writeGrants, [], 'de PR-shield draagt geen schrijfscope');
  assert.deepEqual(shield.jobs.map((j) => j.id), ['autocoding-shield', 'autocoding-shield-signal']);
  assert.equal(shield.usesSecrets, false);
  // De enige uitcheckende job is tot `pull_request` beperkt; de signaaljob checkt niets uit.
  assert.deepEqual(shield.jobs.map((j) => [j.id, j.checksOutCode]),
    [['autocoding-shield', true], ['autocoding-shield-signal', false]]);
  assert.match(shield.jobs[0].condition, /github\.event_name == 'pull_request'/);

  const writer = analyzeWorkflow(readFileSync(TRUSTED_WRITER, 'utf8'));
  assert.deepEqual(writer.triggers, ['workflow_run', 'schedule']);
  assert.deepEqual(writer.workflowRunSources, ['autocoding-shield']);
  assert.deepEqual(writer.writeGrants.map((g) => g.scope), ['statuses']);
  assert.deepEqual(writer.workflowLevelWriteGrants, []);
  assert.deepEqual(writer.jobs.map((j) => [j.id, j.writeGrants.map((g) => g.scope)]),
    [['autocoding-shield-live-gate', ['statuses']]]);
  assert.equal(writer.usesSecrets, false);
  assert.equal(writer.usesArtifactsOrCache, false);
  assert.deepEqual(writer.checkoutRefs, ['${{ github.event.repository.default_branch }}']);
});

test('T9. NEGATIEVE CONTROLE: de gemeten V4-vorm (run 32542688290) wordt afgekeurd', () => {
  // Dit is geen bedachte dreiging maar een gemeten gebeurtenis. Actions-run `32542688290` draaide
  // op event `pull_request_review`, head `a2e7a64…`, het bestand
  // `.github/workflows/autocoding-shield-live-gate.yml`, terwijl de Contents API dat pad op
  // `?ref=main` met 404 beantwoordde: het bestand bestond NIET op de default branch en werd tóch
  // uitgevoerd, inclusief de job met `statuses: write`. Dat de statusstappen daar oversloegen was
  // een gevolg van de uitgeschakelde poort, niet van een grens. Deze vorm moet dus vallen.
  const v4 = [
    'name: autocoding-shield-live-gate',
    'on:',
    '  issue_comment:',
    '    types: [created, edited, deleted]',
    '  pull_request_review:',
    '    types: [submitted, edited, dismissed]',
    'permissions: {}',
    'jobs:',
    '  autocoding-shield-live-gate:',
    '    permissions:',
    '      contents: read',
    '      statuses: write',
  ].join('\n');
  const gevonden = writerViolations(v4);

  // `pull_request_review` draait PR-voorgestelde YAML: untrusted trigger MET schrijfscope.
  assert.ok(gevonden.includes(`${TRUST_VIOLATION.TRUSTED_WRITER_HAS_UNTRUSTED_TRIGGER}:${TRUSTED_WRITER}`));
  assert.ok(gevonden.includes(`${TRUST_VIOLATION.UNTRUSTED_TRIGGER_WITH_WRITE_PERMISSION}:${TRUSTED_WRITER}`));
  // En allebei de events staan buiten de allowlist van de writer.
  assert.ok(gevonden.includes(`${TRUST_VIOLATION.TRUSTED_WRITER_TRIGGER_NOT_ALLOWED}:${TRUSTED_WRITER}`));

  // Ook de op zichzelf "default-branch" gewaande variant met alleen `issue_comment` valt: een event
  // dat elke commentator direct op de schrijvende workflow kan richten is geen vertrouwensgrens.
  const alleenComment = [
    'name: autocoding-shield-live-gate',
    'on:',
    '  issue_comment:',
    '    types: [created]',
    'permissions: {}',
    'jobs:',
    '  autocoding-shield-live-gate:',
    '    permissions:',
    '      statuses: write',
  ].join('\n');
  assert.ok(writerViolations(alleenComment)
    .includes(`${TRUST_VIOLATION.TRUSTED_WRITER_TRIGGER_NOT_ALLOWED}:${TRUSTED_WRITER}`));

  // De toegestane keten zelf levert geen enkele overtreding op.
  const trusted = [
    'name: autocoding-shield-live-gate',
    'on:',
    '  workflow_run:',
    '    workflows: [autocoding-shield]',
    '    types: [completed]',
    '  schedule:',
    "    - cron: '23 * * * *'",
    'permissions: {}',
    'jobs:',
    '  autocoding-shield-live-gate:',
    '    permissions:',
    '      contents: read',
    '      statuses: write',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          ref: ${{ github.event.repository.default_branch }}',
  ].join('\n');
  assert.deepEqual(writerViolations(trusted), []);
  assert.deepEqual(TRUSTED_WRITER_TRIGGERS, ['workflow_run', 'schedule']);
});

test('T10. de workflow_run-bron moet op de shieldnaam gepind zijn', () => {
  const writer = (onBlock) => [
    'name: autocoding-shield-live-gate',
    'on:',
    ...onBlock,
    'permissions: {}',
    'jobs:',
    '  autocoding-shield-live-gate:',
    '    permissions:',
    '      statuses: write',
  ].join('\n');
  const unpinned = `${TRUST_VIOLATION.TRUSTED_WRITER_WORKFLOW_RUN_SOURCE_UNPINNED}:${TRUSTED_WRITER}`;

  // Geen `workflows:`-pin: elke voltooide workflow in de repository zou de writer starten, ook een
  // die een PR zelf toevoegt.
  assert.ok(writerViolations(writer(['  workflow_run:', '    types: [completed]'])).includes(unpinned));
  // Een andere bron dan de shield.
  assert.ok(writerViolations(writer(['  workflow_run:', '    workflows: [publish]'])).includes(unpinned));
  // Een tweede bron erbij is even goed ongepind: dan is er geen enkele bron meer.
  assert.ok(writerViolations(writer(['  workflow_run:', '    workflows: [autocoding-shield, publish]'])).includes(unpinned));
  // Exact de shieldnaam, in beide YAML-vormen, is wél goed.
  assert.ok(!writerViolations(writer(['  workflow_run:', '    workflows: [autocoding-shield]'])).includes(unpinned));
  assert.ok(!writerViolations(writer(['  workflow_run:', '    workflows:', '      - autocoding-shield'])).includes(unpinned));

  assert.equal(extractWorkflowRunSources(structureLines('on:\n  schedule:\n')), null);
  assert.deepEqual(extractWorkflowRunSources(structureLines('on:\n  workflow_run:\n    types: [completed]\n')), []);
  assert.deepEqual(
    extractWorkflowRunSources(structureLines("on:\n  workflow_run:\n    workflows: ['autocoding-shield']\n")),
    ['autocoding-shield'],
  );
});

test('T11. de PR-shield mag buiten pull_request geen code uitchecken', () => {
  const shield = (conditie) => [
    'name: autocoding-shield',
    'on:',
    '  pull_request:',
    '    branches: [main]',
    '  pull_request_review:',
    '    types: [submitted]',
    'permissions: {}',
    'jobs:',
    '  autocoding-shield:',
    ...conditie,
    '    steps:',
    '      - uses: actions/checkout@v4',
  ].join('\n');
  const code = `${TRUST_VIOLATION.PR_SHIELD_CHECKS_OUT_CODE_OUTSIDE_PULL_REQUEST}:${PR_SHIELD}`;

  assert.ok(violations([{ path: PR_SHIELD, text: shield([]) }]).includes(code));
  assert.ok(violations([{ path: PR_SHIELD, text: shield(['    if: always()']) }]).includes(code));
  assert.ok(
    !violations([{ path: PR_SHIELD, text: shield(["    if: github.event_name == 'pull_request'"]) }])
      .includes(code),
  );

  // Een signaaljob zonder checkout is geen overtreding, ook zonder eventconditie.
  const metSignaal = [
    shield(["    if: github.event_name == 'pull_request'"]),
    '  autocoding-shield-signal:',
    '    permissions: {}',
    '    steps:',
    '      - run: echo signaal',
  ].join('\n');
  assert.ok(!violations([{ path: PR_SHIELD, text: metSignaal }]).includes(code));
});

test('T12. stripInlineComment volgt de escaperegels van beide YAML-quotesoorten', () => {
  // Gemini review 4998459978, inline 3834665340. Een `\"` sluit een double-quoted scalar NIET af;
  // de oude lus dacht van wel, zag daarna ` # ` als commentaarstart en gooide echte inhoud weg.
  assert.equal(stripInlineComment('  name: "a\\" # b" # echt commentaar'), '  name: "a\\" # b" ');
  assert.equal(stripInlineComment('  name: "a\\\\" # echt commentaar'), '  name: "a\\\\" ');
  // In een single-quoted scalar bestaat geen backslash-escape; `\'` sluit daar juist wél af, en de
  // verdubbelde quote is het enige escape.
  assert.equal(stripInlineComment("  name: 'a\\' # echt commentaar"), "  name: 'a\\' ");
  assert.equal(stripInlineComment("  name: 'it''s # geen commentaar' # wel"), "  name: 'it''s # geen commentaar' ");
  // Een `#` zonder voorafgaande witruimte is geen commentaar, binnen noch buiten quotes.
  assert.equal(stripInlineComment('  ref: refs/heads/a#b'), '  ref: refs/heads/a#b');

  // Malformed: een onafgesloten quote laat geen betrouwbare grens over. Fail-closed is hier MEER
  // tekst behouden, want weggegooide tekst kan een schrijfscope bevatten.
  assert.equal(stripInlineComment('  a: "onaf # statuses: write'), '  a: "onaf # statuses: write');
  assert.equal(stripInlineComment("  a: 'onaf # statuses: write"), "  a: 'onaf # statuses: write");
  assert.equal(stripInlineComment('  a: "eindigt met backslash \\'), '  a: "eindigt met backslash \\');
  assert.equal(stripInlineComment(null), '');
  assert.equal(stripInlineComment(undefined), '');

  // En het gevolg dat telt: een schrijfscope achter een quote-escape blijft zichtbaar.
  const yaml = [
    'on:',
    '  pull_request:',
    'jobs:',
    '  a:',
    '    env:',
    '      NAAM: "x\\" # y"',
    '    permissions:',
    '      statuses: write',
  ].join('\n');
  assert.deepEqual(extractWriteGrants(structureLines(yaml)).map((g) => g.scope), ['statuses']);
});
