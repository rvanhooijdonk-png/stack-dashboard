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
  UNTRUSTED_TRIGGERS, TRUSTED_WRITER_TRIGGERS, parseFlowMapping, extractJobConcurrency,
  extractJobMatrixKeys, isPerPullRequestQueuedWriteJob,
  extractWorkflowConcurrency, isRepositoryWideQueuedLock, TRUSTED_WRITER_REPOSITORY_LOCK_GROUP,
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

/**
 * De schone V11-writervorm. Sinds de per-PR-rij bestaat de writer uit TWEE jobs: een lezende
 * selectiejob die de doel-PR's als matrix uitschrijft, en precies één schrijvende matrixjob die per
 * gemeten pull request zijn eigen concurrencygroep krijgt met `cancel-in-progress: false` en
 * `queue: max`. Elke synthetische writer hieronder vertrekt vanaf deze vorm, zodat een test die één
 * regel varieert ook werkelijk alleen die regel meet en niet per ongeluk de rijvorm sloopt.
 */
const WRITER_ON = [
  'on:',
  '  issue_comment:',
  '    types: [created, edited, deleted]',
  '  workflow_run:',
  '    workflows: [autocoding-shield]',
  '    types: [completed]',
  '  schedule:',
  "    - cron: '23 * * * *'",
];

const WRITER_SELECTEER = [
  '  selecteer:',
  '    permissions:',
  '      contents: read',
  '      pull-requests: read',
  '    outputs:',
  '      pull_requests: ${{ steps.doelen.outputs.pull_requests }}',
];

const WRITER_RIJ = [
  '    concurrency:',
  '      group: autocoding-shield-live-gate-pr-${{ matrix.pr }}',
  '      cancel-in-progress: false',
  '      queue: max',
];

/**
 * De repositorybrede rij van V13, op WORKFLOWNIVEAU. Zij staat naast de per-PR-rij en niet in plaats
 * daarvan: deze serialiseert de hele RUN — dus ook de selectie en de `rate_limit`-meting — zodat
 * twee aanleidingen nooit hetzelfde resterende quotum kunnen reserveren; de per-PR-rij bewaakt
 * daarbinnen dat twee beurten voor dezelfde PR niet door elkaar heen schrijven.
 */
const WRITER_GLOBALE_RIJ = [
  'concurrency:',
  `  group: ${TRUSTED_WRITER_REPOSITORY_LOCK_GROUP}`,
  '  cancel-in-progress: false',
  '  queue: max',
];

/**
 * Bouwt een writer. `on` vervangt het hele triggerblok, `scopes` voegt permissieregels aan de
 * schrijfjob toe, `rij` vervangt het concurrencyblok van die job, `globaleRij` vervangt de
 * repositorybrede rij op workflowniveau, `schrijf` voegt regels binnen de schrijfjob toe (stappen,
 * env) en `jobs` voegt hele extra jobs achteraan toe.
 */
function schoneWriter({
  on = WRITER_ON, scopes = [], rij = WRITER_RIJ, globaleRij = WRITER_GLOBALE_RIJ,
  schrijf = [], jobs = [],
} = {}) {
  return [
    'name: autocoding-shield-live-gate',
    ...on,
    'permissions: {}',
    ...globaleRij,
    'jobs:',
    ...WRITER_SELECTEER,
    '  schrijf:',
    '    needs: selecteer',
    '    permissions:',
    '      statuses: write',
    ...scopes.map((scope) => `      ${scope}`),
    '    strategy:',
    '      matrix:',
    '        pr: ${{ fromJSON(needs.selecteer.outputs.pull_requests) }}',
    ...rij,
    ...schrijf,
    ...jobs,
  ].join('\n');
}

/** Een verder schone writer met precies één uitcheckref, zodat alleen die ref gemeten wordt. */
const WRITER_MET_REF = (ref) => schoneWriter({
  schrijf: [
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    `          ref: ${ref}`,
  ],
});

/** Idem met precies één extra actie, zodat alleen die `uses:` gemeten wordt. */
const WRITER_MET_ACTIE = (uses) => schoneWriter({ schrijf: ['    steps:', `      - uses: ${uses}`] });

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

  // Codex P1, review 4998729801, inline 3834885357. De VIERDE vorm is de flow-stijl mapping. Die
  // stond niet in de lijst hierboven en werd door de oude lezer stilzwijgend als LEEG gelezen:
  // `on: { pull_request: {} }` leverde `[]` op, waarna een bestand met `statuses: write` geen enkele
  // untrusted trigger meer leek te hebben. Precies de bypass die deze meter moest afvangen.
  assert.deepEqual(extractTriggers(structureLines('on: { pull_request: {} }\n')), ['pull_request']);
  assert.deepEqual(
    extractTriggers(structureLines('on: { pull_request: { branches: [main] }, schedule: [] }\n')),
    ['pull_request', 'schedule'],
  );
  assert.deepEqual(extractTriggers(structureLines("on: { 'pull_request_target': {} }\n")), ['pull_request_target']);
  assert.deepEqual(extractTriggers(structureLines('on: {}\n')), []);

  // En wat de lezer NIET betrouwbaar kan ontleden wordt fail-closed `null`, niet stilzwijgend leeg.
  // `null` is hier het signaal dat de meter geen uitspraak mag doen; `[]` zou "geen triggers,
  // dus geen risico" betekenen en is daarom de gevaarlijke richting.
  for (const onaf of [
    'on: { pull_request: {}\n',
    'on: { pull_request }\n',
    'on: { pull_request: {}, pull_request: {} }\n',
    'on: { : {} }\n',
    "on: { pull_request: {} } extra\n",
    'on: [push, pull_request\n',
    'on: !!python/object/apply:os.system\n',
  ]) {
    assert.equal(extractTriggers(structureLines(onaf)), null, onaf);
  }
});

test('T2a. de flow-mappinglezer is een eigen, toetsbare parser', () => {
  const sleutels = (tekst) => {
    const uitkomst = parseFlowMapping(tekst);
    return uitkomst.ok ? [...uitkomst.entries.keys()] : null;
  };
  assert.deepEqual(sleutels('{}'), []);
  assert.deepEqual(sleutels('{ a: 1, b: 2 }'), ['a', 'b']);
  // Geneste haken en `${{ }}`-expressies tellen als één waarde, niet als scheidingsteken.
  assert.deepEqual(sleutels('{ a: { b: [1, 2] }, c: ${{ github.event.number }} }'), ['a', 'c']);
  // Een komma binnen aanhalingstekens scheidt niets.
  assert.deepEqual(sleutels("{ a: 'x, y', b: 2 }"), ['a', 'b']);
  // En elke onbetrouwbare vorm is `null`.
  for (const stuk of ['{ a: 1', 'a: 1 }', '{ a }', '{ a: 1, a: 2 }', "{ a: 'onaf }", '{ a: 1 } rest']) {
    assert.equal(sleutels(stuk), null, stuk);
  }
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
  const basis = (extraOn, extraPerm) =>
    schoneWriter({ on: [...WRITER_ON, ...extraOn], scopes: extraPerm });

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
    const gevonden = writerViolations(basis([], [scope]));
    assert.ok(
      gevonden.includes(`${TRUST_VIOLATION.TRUSTED_WRITER_WRITE_SCOPE_NOT_ALLOWED}:${TRUSTED_WRITER}`),
      scope,
    );
  }

  // Een TWEEDE SCHRIJVENDE job, een schrijfscope op workflowniveau, secrets, PR-headcheckout en
  // PR-cache zijn allemaal eigen overtredingen. De grens is sinds V11 niet meer "precies één job"
  // maar "precies één job MET een schrijfscope": de lezende selectiejob mag ernaast bestaan, want
  // die kan zonder schrijfrechten niets publiceren.
  const tweedeSchrijver = schoneWriter({
    jobs: ['  extra:', '    permissions:', '      statuses: write'],
  });
  assert.ok(writerViolations(tweedeSchrijver)
    .includes(`${TRUST_VIOLATION.TRUSTED_WRITER_WRITE_JOB_NOT_UNIQUE}:${TRUSTED_WRITER}`));

  // Een tweede LEZENDE job daarentegen is geen overtreding.
  const tweedeLezer = schoneWriter({
    jobs: ['  extra:', '    permissions:', '      contents: read'],
  });
  assert.deepEqual(writerViolations(tweedeLezer), []);

  const topLevelWrite = basis([], []).replace('permissions: {}', 'permissions:\n  statuses: write');
  assert.ok(writerViolations(topLevelWrite)
    .includes(`${TRUST_VIOLATION.TRUSTED_WRITER_WORKFLOW_LEVEL_WRITE}:${TRUSTED_WRITER}`));

  const metSecret = schoneWriter({ schrijf: ['    env:', '      TOKEN: ${{ secrets.PAT }}'] });
  assert.ok(writerViolations(metSecret)
    .includes(`${TRUST_VIOLATION.TRUSTED_WRITER_USES_SECRETS}:${TRUSTED_WRITER}`));

  const metPrHead = WRITER_MET_REF('${{ github.event.pull_request.head.sha }}');
  assert.ok(writerViolations(metPrHead)
    .includes(`${TRUST_VIOLATION.TRUSTED_WRITER_CHECKS_OUT_PR_CODE}:${TRUSTED_WRITER}`));

  const metCache = WRITER_MET_ACTIE('actions/cache@v4');
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
  const schoon = schoneWriter({
    schrijf: [
      '    steps:',
      '      # nooit: uses: dawidd6/action-download-artifact@v6',
      '      - uses: actions/checkout@v4',
      '      - run: |',
      '          echo "uses: actions/upload-artifact@v4 staat hier alleen als tekst"',
      '          echo "en uses: buildjet/cache@v4 ook"',
    ],
  });
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
  // `issue_comment` is hier per V11 WEG: de trusted writer luistert daar zelf op, en dubbel
  // signaleren zou één comment twee keer laten meten zonder één extra feit op te leveren.
  // `pull_request_review_comment` is er juist bij gekomen, want een losse reviewcomment levert geen
  // `pull_request_review`-event op en moest anders door de uurlijkse schedule opgevangen worden.
  assert.deepEqual(shield.triggers,
    ['pull_request', 'pull_request_review', 'pull_request_review_comment']);
  assert.deepEqual(shield.writeGrants, [], 'de PR-shield draagt geen schrijfscope');
  assert.deepEqual(shield.jobs.map((j) => j.id), ['autocoding-shield', 'autocoding-shield-signal']);
  assert.equal(shield.usesSecrets, false);
  // De enige uitcheckende job is tot `pull_request` beperkt; de signaaljob checkt niets uit.
  assert.deepEqual(shield.jobs.map((j) => [j.id, j.checksOutCode]),
    [['autocoding-shield', true], ['autocoding-shield-signal', false]]);
  assert.match(shield.jobs[0].condition, /github\.event_name == 'pull_request'/);

  const writer = analyzeWorkflow(readFileSync(TRUSTED_WRITER, 'utf8'));
  assert.deepEqual(writer.triggers, ['issue_comment', 'workflow_run', 'schedule']);
  assert.equal(writer.triggersUnparseable, false);
  assert.deepEqual(writer.workflowRunSources, ['autocoding-shield']);
  assert.deepEqual(writer.writeGrants.map((g) => g.scope), ['statuses']);
  assert.deepEqual(writer.workflowLevelWriteGrants, []);
  // Twee jobs: de selectie leest alleen, de schrijver draagt als enige `statuses: write`.
  assert.deepEqual(writer.jobs.map((j) => [j.id, j.writeGrants.map((g) => g.scope)]),
    [['selecteer', []], ['schrijf', ['statuses']]]);
  // En die schrijfjob is per PR geserialiseerd: één matrixwaarde, één rij, niets dat per run
  // verschilt, en een rij die WACHT in plaats van te annuleren.
  const schrijf = writer.jobs.find((j) => j.id === 'schrijf');
  assert.deepEqual(schrijf.matrixKeys, ['pr']);
  assert.deepEqual(schrijf.concurrency, {
    unparseable: false,
    group: 'autocoding-shield-live-gate-pr-${{ matrix.pr }}',
    cancelInProgress: 'false',
    queue: 'max',
  });
  assert.equal(isPerPullRequestQueuedWriteJob(schrijf), true);
  // En daarnaast draagt het bestand sinds V13 de REPOSITORYBREDE rij op workflowniveau: één vaste
  // groep zonder enige expressie, wachtend in plaats van annulerend. Die rij is verworven vóór de
  // eerste job, dus vóór de selectie en vóór de `rate_limit`-meting.
  assert.equal(writer.workflowLevelConcurrency, true);
  assert.deepEqual(writer.workflowConcurrency, {
    unparseable: false,
    group: TRUSTED_WRITER_REPOSITORY_LOCK_GROUP,
    cancelInProgress: 'false',
    queue: 'max',
  });
  assert.equal(isRepositoryWideQueuedLock(writer.workflowConcurrency), true);
  assert.equal(writer.usesSecrets, false);
  assert.equal(writer.usesArtifactsOrCache, false);
  assert.deepEqual(writer.checkoutRefs, [
    '${{ github.event.repository.default_branch }}',
    '${{ github.event.repository.default_branch }}',
  ]);
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

  // `issue_comment` is sinds V11 wél toegestaan IN de writer, en dat is geen versoepeling van deze
  // regel maar een gevolg ervan: GitHub draait dat event uitsluitend tegen de definitie op de
  // DEFAULT BRANCH, precies zoals `workflow_run` en `schedule`. Wat een commentator kan richten is
  // het moment, niet de code. Wat NIET verandert is de rest van de grens — het onderstaande blijft
  // vallen op zijn schrijfjob, niet op zijn trigger.
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
  const commentGevonden = writerViolations(alleenComment);
  assert.ok(!commentGevonden.includes(`${TRUST_VIOLATION.TRUSTED_WRITER_TRIGGER_NOT_ALLOWED}:${TRUSTED_WRITER}`));
  assert.ok(commentGevonden.includes(
    `${TRUST_VIOLATION.TRUSTED_WRITER_WRITE_JOB_NOT_PER_PULL_REQUEST_QUEUED}:${TRUSTED_WRITER}`,
  ));

  // De toegestane keten zelf levert geen enkele overtreding op.
  const trusted = schoneWriter({
    scopes: ['contents: read'],
    schrijf: [
      '    steps:',
      '      - uses: actions/checkout@v4',
      '        with:',
      '          ref: ${{ github.event.repository.default_branch }}',
    ],
  });
  assert.deepEqual(writerViolations(trusted), []);
  assert.deepEqual(TRUSTED_WRITER_TRIGGERS, ['workflow_run', 'schedule', 'issue_comment']);
});

test('T10. de workflow_run-bron moet op de shieldnaam gepind zijn', () => {
  const writer = (onBlock) => schoneWriter({ on: ['on:', ...onBlock] });
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

// --- De flow-stijl bypass en de per-PR-rij ------------------------------------------------------

test('T13. NEGATIEVE CONTROLE: `on: { pull_request: {} }` plus `statuses: write` wordt geweigerd', () => {
  // Codex P1, review 4998729801, inline 3834885357. YAML kent voor mappings twee schrijfwijzen. De
  // meter las alleen de blokvorm; de flow-vorm leverde LEEG op. Een bestand met flow-triggers en een
  // schrijfscope leek daardoor "geen untrusted trigger" te hebben, terwijl GitHub het gewoon op
  // `pull_request` draait — met de door de PR VOORGESTELDE definitie.
  const flowShield = [
    'name: autocoding-shield',
    'on: { pull_request: { branches: [main] }, pull_request_review: { types: [submitted] } }',
    'permissions: {}',
    'jobs:',
    '  autocoding-shield:',
    '    permissions:',
    '      statuses: write',
  ].join('\n');

  const gevonden = violations([{ path: PR_SHIELD, text: flowShield }, { path: TRUSTED_WRITER, text: schoneWriter() }]);
  assert.ok(gevonden.includes(`${TRUST_VIOLATION.UNTRUSTED_TRIGGER_WITH_WRITE_PERMISSION}:${PR_SHIELD}`));
  assert.ok(gevonden.includes(`${TRUST_VIOLATION.PR_SHIELD_HAS_WRITE_PERMISSION}:${PR_SHIELD}`));
  assert.ok(gevonden.includes(`${TRUST_VIOLATION.STATUSES_WRITE_OUTSIDE_TRUSTED_WRITER}:${PR_SHIELD}`));

  // `pull_request_target` in flow-vorm is even goed zichtbaar.
  const flowTarget = 'on: { pull_request_target: {} }\njobs:\n  a:\n    permissions:\n      contents: read';
  assert.ok(
    violations([{ path: 'x.yml', text: flowTarget }])
      .includes(`${TRUST_VIOLATION.PULL_REQUEST_TARGET_PRESENT}:x.yml`),
  );
});

test('T13a. wat de triggerlezer niet kan ontleden is fail-closed, niet stilzwijgend leeg', () => {
  // Over-benaderen in de VEILIGE richting. Een vorm die de lezer niet aankan mag nooit als "geen
  // triggers" doorgaan, want dan verdwijnt elke triggergebonden regel eruit. Hij wordt gemeld.
  const onleesbaar = [
    'name: iets',
    'on: { pull_request: {}',
    'jobs:',
    '  a:',
    '    permissions:',
    '      contents: read',
  ].join('\n');
  const analyse = analyzeWorkflow(onleesbaar);
  assert.equal(analyse.triggersUnparseable, true);
  assert.deepEqual(analyse.triggers, []);
  assert.ok(
    violations([{ path: 'x.yml', text: onleesbaar }])
      .includes(`${TRUST_VIOLATION.TRIGGER_MAPPING_UNPARSEABLE}:x.yml`),
  );

  // Ook een onbekende KINDREGEL in de blokvorm maakt de lijst onbetrouwbaar: als er iets tussen de
  // triggers staat dat de lezer niet herkent, kan hij niet meer beweren de lijst compleet te hebben.
  assert.equal(extractTriggers(structureLines('on:\n  pull_request:\n  ???!\n')), null);
});

test('T13b. NEGATIEVE MUTATIE: de oude blok-only lezer laat de flow-vorm door', async () => {
  // De regel uit T13 is pas bewezen als de OUDE lezer er aantoonbaar op stukloopt. De mutant krijgt
  // de vorm van vóór deze commit terug: alles wat niet met `[` begint werd als losse scalar gelezen,
  // dus `{ pull_request: {} }` werd één onherkenbare "triggernaam" — en daarmee geen `pull_request`.
  const gemuteerd = await mutantVanDeMeter(
    'flow-mapping',
    `  if (inline.startsWith('{')) {
    const flow = parseFlowMapping(inline);
    if (!flow.ok) return null;
    return [...flow.entries.keys()];
  }`,
    `  if (inline.startsWith('{')) {
    return [];
  }`,
  );

  const flowShield = [
    'name: autocoding-shield',
    'on: { pull_request: { branches: [main] } }',
    'permissions: {}',
    'jobs:',
    '  autocoding-shield:',
    '    permissions:',
    '      statuses: write',
  ].join('\n');

  // De mutant ziet geen enkele untrusted trigger meer en laat de schrijfscope dus staan...
  assert.deepEqual(gemuteerd.analyzeWorkflow(flowShield).triggers, []);
  assert.ok(
    !gemuteerd.findTrustBoundaryViolations({
      workflows: [{ path: PR_SHIELD, text: flowShield }, { path: TRUSTED_WRITER, text: schoneWriter() }],
      prShieldPath: PR_SHIELD, trustedWriterPath: TRUSTED_WRITER,
    }).includes(`${TRUST_VIOLATION.UNTRUSTED_TRIGGER_WITH_WRITE_PERMISSION}:${PR_SHIELD}`),
  );
  // ...terwijl de echte meter hem precies daar op afkeurt.
  assert.deepEqual(analyzeWorkflow(flowShield).triggers, ['pull_request']);
  assert.ok(
    violations([{ path: PR_SHIELD, text: flowShield }, { path: TRUSTED_WRITER, text: schoneWriter() }])
      .includes(`${TRUST_VIOLATION.UNTRUSTED_TRIGGER_WITH_WRITE_PERMISSION}:${PR_SHIELD}`),
  );
});

test('T14. de schrijfjob moet PER PULL REQUEST in een WACHTENDE rij staan', () => {
  // Codex P1, review 4998729801, inline 3834885350/3834885354. Een enkele globale rij betekende dat
  // twee aanleidingen voor VERSCHILLENDE PR's elkaar verdrongen, en dat één run de heads van alle
  // openstaande PR's aanraakte. De rij hoort daarom aan de GEMETEN PR te hangen — en te wachten in
  // plaats van te annuleren, want een geannuleerde wachtende beurt is een PR die niemand hermeet.
  assert.equal(isPerPullRequestQueuedWriteJob(
    analyzeWorkflow(schoneWriter()).jobs.find((j) => j.id === 'schrijf'),
  ), true);

  const nietGeserialiseerd = `${TRUST_VIOLATION.TRUSTED_WRITER_WRITE_JOB_NOT_PER_PULL_REQUEST_QUEUED}:${TRUSTED_WRITER}`;

  // MUTATIE 1: `queue: single` in plaats van `max`. Dan wordt een wachtende beurt geannuleerd zodra
  // er een nieuwe aanleiding voor DEZELFDE PR binnenkomt, en meet die tweede aanleiding een oudere
  // toestand nooit opnieuw.
  const single = schoneWriter({
    rij: [
      '    concurrency:',
      '      group: autocoding-shield-live-gate-pr-${{ matrix.pr }}',
      '      cancel-in-progress: false',
      '      queue: single',
    ],
  });
  assert.ok(writerViolations(single).includes(nietGeserialiseerd));

  // MUTATIE 2: annuleren in plaats van wachten.
  const annuleert = schoneWriter({
    rij: [
      '    concurrency:',
      '      group: autocoding-shield-live-gate-pr-${{ matrix.pr }}',
      '      cancel-in-progress: true',
      '      queue: max',
    ],
  });
  assert.ok(writerViolations(annuleert).includes(nietGeserialiseerd));

  // MUTATIE 3: de rij op een RUN-eigenschap sleutelen in plaats van op de PR. Dan valt elke run in
  // zijn eigen rij en serialiseert er niets meer. `github.run_number` is precies de vorm die de
  // vorige ronde gebruikte.
  for (const vluchtig of [
    'autocoding-shield-live-gate-${{ github.run_number }}',
    'autocoding-shield-live-gate-${{ github.run_id }}',
    'autocoding-shield-live-gate-${{ github.event.pull_request.number }}',
    'autocoding-shield-live-gate',
  ]) {
    const vorm = schoneWriter({
      rij: [
        '    concurrency:',
        `      group: ${vluchtig}`,
        '      cancel-in-progress: false',
        '      queue: max',
      ],
    });
    assert.ok(writerViolations(vorm).includes(nietGeserialiseerd), vluchtig);
  }

  // MUTATIE 4: helemaal geen rij.
  assert.ok(writerViolations(schoneWriter({ rij: [] })).includes(nietGeserialiseerd));

  // MUTATIE 5: een rij die naar een matrixsleutel wijst die de job niet heeft. Dan is de groep in
  // de praktijk leeg en vallen alle PR's alsnog in één rij.
  const verkeerdeSleutel = schoneWriter({
    rij: [
      '    concurrency:',
      '      group: autocoding-shield-live-gate-pr-${{ matrix.nummer }}',
      '      cancel-in-progress: false',
      '      queue: max',
    ],
  });
  assert.ok(writerViolations(verkeerdeSleutel).includes(nietGeserialiseerd));

  // MUTATIE 6: de per-PR-rij weghalen terwijl de globale rij blijft staan. De twee rijen zijn geen
  // alternatieven — de globale serialiseert het quotum, de per-PR-rij de schrijfbeurten per head —
  // dus mag het wegvallen van de ene niet door de andere gedekt worden.
  assert.ok(writerViolations(schoneWriter({ rij: [] })).includes(nietGeserialiseerd));
  assert.ok(!writerViolations(schoneWriter({ rij: [] }))
    .includes(`${TRUST_VIOLATION.TRUSTED_WRITER_NOT_REPOSITORY_QUEUED}:${TRUSTED_WRITER}`));
});

test('T14a. verschillende PR-nummers leveren verschillende rijen op, dezelfde PR precies één', () => {
  // De eigenschap die telt is niet de tekst van de groep maar wat hij per PR OPLEVERT. De groep
  // wordt hier met echte matrixwaarden ingevuld, zoals Actions dat doet.
  const job = analyzeWorkflow(schoneWriter()).jobs.find((j) => j.id === 'schrijf');
  const groepVan = (pr) => job.concurrency.group.replace(/\$\{\{\s*matrix\.pr\s*\}\}/, String(pr));

  assert.notEqual(groepVan(74), groepVan(75));
  // Twee aanleidingen voor DEZELFDE PR delen de rij, ook al zijn het aparte runs: er staat niets
  // runafhankelijks in de groep.
  assert.equal(groepVan(74), groepVan(74));
  assert.equal(new Set([74, 75, 76, 74].map(groepVan)).size, 3);
  // En de rij WACHT, dus de tweede beurt voor PR 74 wordt niet weggegooid.
  assert.equal(job.concurrency.queue, 'max');
  assert.equal(job.concurrency.cancelInProgress, 'false');
});

test('T14b. de concurrency- en matrixlezer zijn zelf gemeten, niet aangenomen', () => {
  const lees = (regels) => extractJobConcurrency({ lines: structureLines(regels.join('\n')) });

  assert.equal(lees(['  a:', '    runs-on: ubuntu-latest']), null);
  assert.deepEqual(
    lees(['  a:', '    concurrency:', '      group: g-${{ matrix.pr }}', '      cancel-in-progress: false', '      queue: max']),
    { unparseable: false, group: 'g-${{ matrix.pr }}', cancelInProgress: 'false', queue: 'max' },
  );
  // Flow-vorm en scalarvorm zijn dezelfde YAML.
  assert.deepEqual(
    lees(['  a:', '    concurrency: { group: g-${{ matrix.pr }}, cancel-in-progress: false, queue: max }']),
    { unparseable: false, group: 'g-${{ matrix.pr }}', cancelInProgress: 'false', queue: 'max' },
  );
  // De scalarvorm zet alleen de groep; `queue` valt dan terug op de GitHub-standaard `single`, wat
  // geen wachtende rij is. Fail-closed betekent hier dus: geen aanname over de rest.
  assert.deepEqual(
    lees(['  a:', '    concurrency: alleen-een-groep']),
    { unparseable: false, group: 'alleen-een-groep', cancelInProgress: '', queue: '' },
  );
  // En een flow-vorm die niet te ontleden is, is `unparseable` — nooit stilzwijgend goed.
  assert.equal(lees(['  a:', '    concurrency: { group: g'])?.unparseable, true);
  assert.equal(isPerPullRequestQueuedWriteJob({ concurrency: lees(['  a:', '    concurrency: { group: g']), matrixKeys: ['pr'] }), false);

  const matrix = (regels) => extractJobMatrixKeys({ lines: structureLines(regels.join('\n')) });
  assert.deepEqual(matrix(['  a:', '    runs-on: ubuntu-latest']), []);
  assert.deepEqual(
    matrix(['  a:', '    strategy:', '      matrix:', '        pr: ${{ fromJSON(x) }}', '        os: [ubuntu]']),
    ['pr', 'os'],
  );
  // `include`/`exclude` zijn geen matrixdimensies om een rij op te sleutelen.
  assert.deepEqual(
    matrix(['  a:', '    strategy:', '      fail-fast: false', '      matrix:', '        pr: [1]', '        include:', '          - pr: 2']),
    ['pr'],
  );
});

test('T15. `issue_comment` met schrijfrechten mag alleen in de trusted writer staan', () => {
  // `issue_comment` draait weliswaar altijd de default-branch-definitie, maar de writer is het enige
  // bestand waarin de rest van de grens gemeten wordt: één schrijfjob, per-PR-rij, geen PR-code,
  // geen secrets, alleen `statuses`. Zou een willekeurige andere workflow op datzelfde event mogen
  // schrijven, dan was die grens een eigenschap van één bestand in plaats van van de repository.
  const elders = [
    'name: iets-anders',
    'on:',
    '  issue_comment:',
    '    types: [created]',
    'jobs:',
    '  reageer:',
    '    permissions:',
    '      pull-requests: write',
  ].join('\n');
  const gevonden = violations([
    { path: PR_SHIELD, text: SCHONE_SHIELD },
    { path: TRUSTED_WRITER, text: schoneWriter() },
    { path: 'other.yml', text: elders },
  ]);
  assert.ok(gevonden.includes(`${TRUST_VIOLATION.ISSUE_COMMENT_WRITE_OUTSIDE_TRUSTED_WRITER}:other.yml`));

  // Zonder schrijfscope is hetzelfde event geen overtreding: het gaat om de combinatie.
  const lezendElders = elders.replace('      pull-requests: write', '      contents: read');
  assert.ok(
    !violations([
      { path: PR_SHIELD, text: SCHONE_SHIELD },
      { path: TRUSTED_WRITER, text: schoneWriter() },
      { path: 'other.yml', text: lezendElders },
    ]).includes(`${TRUST_VIOLATION.ISSUE_COMMENT_WRITE_OUTSIDE_TRUSTED_WRITER}:other.yml`),
  );

  // En in de writer zelf is het toegestaan.
  assert.deepEqual(writerViolations(schoneWriter()), []);
});


// --- De repositorybrede quotumrij (V13) ----------------------------------------------------------

test('T16. de trusted writer serialiseert de HELE run repositorybreed, vóór de quotummeting', () => {
  // De bevinding die dit sluit: de per-PR-jobrij begrenst één run correct, maar de quotummeting is
  // daarmee nog niet atomair over RUNS. Twee eventruns voor verschillende pull requests vallen in
  // verschillende jobrijen, lezen dus tegelijk hetzelfde `rate_limit.remaining` en reserveren
  // allebei datzelfde restant — terwijl het uurquotum per REPOSITORY gedeeld is.
  const tekst = readFileSync(TRUSTED_WRITER, 'utf8');
  const writer = analyzeWorkflow(tekst);

  assert.equal(isRepositoryWideQueuedLock(writer.workflowConcurrency), true);
  assert.deepEqual(writer.workflowConcurrency, {
    unparseable: false,
    group: TRUSTED_WRITER_REPOSITORY_LOCK_GROUP,
    cancelInProgress: 'false',
    queue: 'max',
  });

  // De groep draagt GEEN enkele expressie. Was er één, dan viel hij per run, per event of per PR
  // uiteen in verschillende groepen en serialiseerde hij niets.
  assert.doesNotMatch(writer.workflowConcurrency.group, /\$\{\{/);
  assert.doesNotMatch(writer.workflowConcurrency.group,
    /github\.(run_id|run_number|run_attempt|event|sha|ref|actor|job)/);

  // DE VOLGORDE IS DE HELE EIGENSCHAP: de rij staat op workflowniveau en dus vóór `jobs:`. GitHub
  // verwerft een workflowbrede groep vóór de eerste job start, dus vallen zowel de selectie als de
  // `rate_limit`-meting BINNEN de lock, en komt de lock pas vrij als alle matrixwriters klaar zijn.
  //
  // De posities worden in de RUWE tekst gemeten en niet in `structureLines()`: de meetopdracht zelf
  // staat in een `run:`-blok-scalar, en die wordt door de structuurlezer bewust overgeslagen.
  const ruw = tekst.split('\n');
  const rijIndex = ruw.findIndex((l) => /^concurrency:/.test(l));
  const jobsIndex = ruw.findIndex((l) => /^jobs:/.test(l));
  const meetIndex = ruw.findIndex((l) => /gh api rate_limit/.test(l));
  const selectieIndex = ruw.findIndex((l) => /^  selecteer:/.test(l));
  assert.notEqual(rijIndex, -1, 'de repositorybrede rij staat in het bestand');
  assert.notEqual(meetIndex, -1, 'de rate_limit-meting staat in het bestand');
  assert.ok(rijIndex < jobsIndex, 'de rij staat vóór het jobsblok');
  assert.ok(jobsIndex < selectieIndex, 'de selectiejob staat binnen het jobsblok');
  assert.ok(selectieIndex < meetIndex, 'de rate_limit-meting staat in de selectiejob');
  // En die meting staat in de LEZENDE selectiejob, dus vóór elke schrijfbeurt en binnen de lock.
  assert.ok(meetIndex < ruw.findIndex((l) => /^  schrijf:/.test(l)));

  // En de per-PR-rij staat er nog steeds naast: de globale rij serialiseert het QUOTUM, de per-PR-rij
  // de schrijfbeurten op één head. De ene vervangt de andere niet.
  const schrijf = writer.jobs.find((j) => j.id === 'schrijf');
  assert.equal(isPerPullRequestQueuedWriteJob(schrijf), true);
  assert.equal(schrijf.concurrency.queue, 'max');
  assert.equal(schrijf.concurrency.cancelInProgress, 'false');
});

test('T16a. elke aanleiding valt in DEZELFDE repositorybrede groep — event, event, schedule', () => {
  // De groep bevat geen expressie, dus is er niets om in te vullen: welke render je ook probeert,
  // het resultaat is dezelfde string. Dat wordt hier uitgevoerd in plaats van beweerd, met de
  // contextvelden die per aanleiding verschillen.
  const groep = analyzeWorkflow(readFileSync(TRUSTED_WRITER, 'utf8')).workflowConcurrency.group;
  const render = (context) => groep.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g,
    (_, expr) => String(context[expr] ?? ''));

  const aanleidingen = [
    { 'github.event_name': 'issue_comment', 'github.event.issue.number': 74, 'github.run_id': 1 },
    { 'github.event_name': 'issue_comment', 'github.event.issue.number': 75, 'github.run_id': 2 },
    { 'github.event_name': 'workflow_run', 'github.event.workflow_run.id': 9, 'github.run_id': 3 },
    { 'github.event_name': 'schedule', 'github.run_id': 4 },
  ];
  const groepen = new Set(aanleidingen.map(render));
  assert.equal(groepen.size, 1, 'twee eventruns én een schedule delen één repositorybrede rij');
  assert.deepEqual([...groepen], [TRUSTED_WRITER_REPOSITORY_LOCK_GROUP]);

  // Veertig geburste events leveren evengoed één groep op. Wat daarvan het GEVOLG is voor de
  // gedeelde teller — dat er nooit twee runs tegelijk tegen hetzelfde restant beslissen — wordt in
  // `test/autocoding-live-gate-targets.test.mjs` met de echte budgetten doorgerekend.
  const burst = Array.from({ length: 40 }, (_, i) => render({
    'github.event_name': 'issue_comment', 'github.event.issue.number': 100 + i, 'github.run_id': i,
  }));
  assert.equal(new Set(burst).size, 1);

  // De per-PR-groep doet juist het tegenovergestelde en moet dat blijven doen.
  const schrijf = analyzeWorkflow(schoneWriter()).jobs.find((j) => j.id === 'schrijf');
  const perPr = (n) => schrijf.concurrency.group.replace(/\$\{\{\s*matrix\.pr\s*\}\}/, String(n));
  assert.equal(new Set([74, 75, 76].map(perPr)).size, 3);
});

test('T16b. elke afwijkende vorm van de repositorybrede rij is fail-closed', () => {
  const nietRepositoryBreed = `${TRUST_VIOLATION.TRUSTED_WRITER_NOT_REPOSITORY_QUEUED}:${TRUSTED_WRITER}`;
  assert.deepEqual(writerViolations(schoneWriter()), []);

  const globaal = (regels) => writerViolations(schoneWriter({ globaleRij: regels }));

  // MUTATIE 1: helemaal geen repositorybrede rij — de V12-vorm. Twee eventruns voor verschillende
  // PR's meten dan weer gelijktijdig hetzelfde resterende quotum.
  assert.ok(globaal([]).includes(nietRepositoryBreed));

  // MUTATIE 2: een DYNAMISCHE groep. Elke suffix die per run, per event of per PR verschilt splitst
  // de rij op en serialiseert dus niets meer. `github.run_number` is precies de vorm die eerder al
  // een defect opleverde.
  for (const dynamisch of [
    '${{ github.run_id }}',
    'autocoding-shield-live-gate-repository-${{ github.run_number }}',
    'autocoding-shield-live-gate-repository-${{ github.event_name }}',
    'autocoding-shield-live-gate-repository-${{ github.event.issue.number }}',
    'autocoding-shield-live-gate-repository-${{ matrix.pr }}',
    'een-andere-vaste-groep',
  ]) {
    assert.ok(globaal([
      'concurrency:',
      `  group: ${dynamisch}`,
      '  cancel-in-progress: false',
      '  queue: max',
    ]).includes(nietRepositoryBreed), dynamisch);
  }

  // MUTATIE 3: `queue: single`. GitHub bewaart dan hooguit ÉÉN wachtende run per groep en annuleert
  // de vorige — precies de eigenschap waarom een globale rij tot en met V12 geweigerd werd. Zonder
  // `max` is de rij een verliespost in plaats van een serialisatie.
  assert.ok(globaal([
    'concurrency:',
    `  group: ${TRUSTED_WRITER_REPOSITORY_LOCK_GROUP}`,
    '  cancel-in-progress: false',
    '  queue: single',
  ]).includes(nietRepositoryBreed));

  // MUTATIE 4: `queue` weglaten. De GitHub-standaard is `single`, dus is dit dezelfde stille
  // verliespost — en een ontbrekende sleutel mag nooit als "waarschijnlijk goed" gelezen worden.
  assert.ok(globaal([
    'concurrency:',
    `  group: ${TRUSTED_WRITER_REPOSITORY_LOCK_GROUP}`,
    '  cancel-in-progress: false',
  ]).includes(nietRepositoryBreed));

  // MUTATIE 5: annuleren in plaats van wachten. Dan kapt een nieuwe aanleiding een lopende
  // schrijfbeurt af en blijft een head op `pending` staan.
  assert.ok(globaal([
    'concurrency:',
    `  group: ${TRUSTED_WRITER_REPOSITORY_LOCK_GROUP}`,
    '  cancel-in-progress: true',
    '  queue: max',
  ]).includes(nietRepositoryBreed));

  // MUTATIE 6: onleesbare en scalaire vormen. Een rij die niet met zekerheid te lezen is, is geen
  // rij; de scalarvorm draagt per definitie geen `queue`.
  assert.ok(globaal(['concurrency: { group: autocoding-shield-live-gate-repository'])
    .includes(nietRepositoryBreed));
  assert.ok(globaal([`concurrency: ${TRUSTED_WRITER_REPOSITORY_LOCK_GROUP}`])
    .includes(nietRepositoryBreed));

  // En de flow-vorm met alle drie de sleutels is dezelfde YAML en dus WEL toegestaan; anders zou de
  // regel niet meer meten maar alleen nog op opmaak blokkeren.
  assert.deepEqual(globaal([
    `concurrency: { group: ${TRUSTED_WRITER_REPOSITORY_LOCK_GROUP}, cancel-in-progress: false, queue: max }`,
  ]), []);
});

test('T16c. de lezer van de workflowbrede rij is zelf gemeten, niet aangenomen', () => {
  const lees = (regels) => extractWorkflowConcurrency(structureLines(regels.join('\n')));

  // Geen rij op workflowniveau.
  assert.equal(lees(['name: x', 'jobs:', '  a:', '    runs-on: ubuntu-latest']), null);

  // Een rij op JOBNIVEAU is géén workflowbrede rij. Zou de lezer die meetellen, dan zou de per-PR-rij
  // de globale eis kunnen vervullen en was de quotumrace niet gesloten.
  assert.equal(lees([
    'name: x', 'jobs:', '  a:', '    concurrency:', '      group: g', '      queue: max',
  ]), null);

  assert.deepEqual(
    lees(['name: x', 'concurrency:', '  group: g', '  cancel-in-progress: false', '  queue: max']),
    { unparseable: false, group: 'g', cancelInProgress: 'false', queue: 'max' },
  );
  assert.deepEqual(
    lees(['name: x', 'concurrency: { group: g, cancel-in-progress: false, queue: max }']),
    { unparseable: false, group: 'g', cancelInProgress: 'false', queue: 'max' },
  );
  assert.deepEqual(
    lees(['name: x', 'concurrency: alleen-een-groep']),
    { unparseable: false, group: 'alleen-een-groep', cancelInProgress: '', queue: '' },
  );
  assert.equal(lees(['name: x', 'concurrency: { group: g'])?.unparseable, true);

  // En de predicaat-kant: onleesbaar, leeg en de standaardwaarden zijn allemaal onvoldoende.
  assert.equal(isRepositoryWideQueuedLock(null), false);
  assert.equal(isRepositoryWideQueuedLock({ unparseable: true, group: TRUSTED_WRITER_REPOSITORY_LOCK_GROUP, cancelInProgress: 'false', queue: 'max' }), false);
  assert.equal(isRepositoryWideQueuedLock({ unparseable: false, group: TRUSTED_WRITER_REPOSITORY_LOCK_GROUP, cancelInProgress: 'false', queue: 'max' }), true);

  // De vaste groepsnaam is zelf een literal zonder expressie — anders was de hele eis leeg.
  assert.doesNotMatch(TRUSTED_WRITER_REPOSITORY_LOCK_GROUP, /\$\{\{/);
});
