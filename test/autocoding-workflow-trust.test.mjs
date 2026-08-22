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
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  analyzeWorkflow, structureLines, extractTriggers, extractWriteGrants, extractJobs,
  stripInlineComment, findTrustBoundaryViolations, TRUST_VIOLATION, UNTRUSTED_TRIGGERS,
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
    '  issue_comment:',
    '    types: [created]',
    ...extraOn,
    'permissions: {}',
    'jobs:',
    '  autocoding-shield-live-gate:',
    '    permissions:',
    '      statuses: write',
    ...extraPerm,
  ].join('\n');

  for (const trigger of UNTRUSTED_TRIGGERS) {
    const gevonden = violations([{ path: TRUSTED_WRITER, text: basis([`  ${trigger}:`], []) }]);
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
    const gevonden = violations([{ path: TRUSTED_WRITER, text: basis([], [`      ${scope}`]) }]);
    assert.ok(
      gevonden.includes(`${TRUST_VIOLATION.TRUSTED_WRITER_WRITE_SCOPE_NOT_ALLOWED}:${TRUSTED_WRITER}`),
      scope,
    );
  }

  // Een tweede job, een schrijfscope op workflowniveau, secrets, PR-headcheckout en PR-cache
  // zijn allemaal eigen overtredingen.
  const tweedeJob = `${basis([], [])}\n  extra:\n    runs-on: ubuntu-latest`;
  assert.ok(violations([{ path: TRUSTED_WRITER, text: tweedeJob }])
    .includes(`${TRUST_VIOLATION.TRUSTED_WRITER_HAS_MULTIPLE_JOBS}:${TRUSTED_WRITER}`));

  const topLevelWrite = basis([], []).replace('permissions: {}', 'permissions:\n  statuses: write');
  assert.ok(violations([{ path: TRUSTED_WRITER, text: topLevelWrite }])
    .includes(`${TRUST_VIOLATION.TRUSTED_WRITER_WORKFLOW_LEVEL_WRITE}:${TRUSTED_WRITER}`));

  const metSecret = `${basis([], [])}\n    env:\n      TOKEN: \${{ secrets.PAT }}`;
  assert.ok(violations([{ path: TRUSTED_WRITER, text: metSecret }])
    .includes(`${TRUST_VIOLATION.TRUSTED_WRITER_USES_SECRETS}:${TRUSTED_WRITER}`));

  const metPrHead = `${basis([], [])}\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}`;
  assert.ok(violations([{ path: TRUSTED_WRITER, text: metPrHead }])
    .includes(`${TRUST_VIOLATION.TRUSTED_WRITER_CHECKS_OUT_PR_CODE}:${TRUSTED_WRITER}`));

  const metCache = `${basis([], [])}\n    steps:\n      - uses: actions/cache@v4`;
  assert.ok(violations([{ path: TRUSTED_WRITER, text: metCache }])
    .includes(`${TRUST_VIOLATION.TRUSTED_WRITER_USES_PR_ARTIFACTS}:${TRUSTED_WRITER}`));
});

test('T7. geen enkel workflowbestand in deze repository overtreedt de grens', () => {
  assert.deepEqual(violations(allWorkflows()), []);
});

test('T8. de gemeten vorm van de twee shieldbestanden is precies de bedoelde', () => {
  const shield = analyzeWorkflow(readFileSync(PR_SHIELD, 'utf8'));
  assert.deepEqual(shield.triggers, ['pull_request']);
  assert.deepEqual(shield.writeGrants, [], 'de PR-shield draagt geen schrijfscope');
  assert.deepEqual(shield.jobs.map((j) => j.id), ['autocoding-shield']);
  assert.equal(shield.usesSecrets, false);

  const writer = analyzeWorkflow(readFileSync(TRUSTED_WRITER, 'utf8'));
  assert.deepEqual(writer.triggers, ['issue_comment', 'pull_request_review']);
  assert.deepEqual(writer.writeGrants.map((g) => g.scope), ['statuses']);
  assert.deepEqual(writer.workflowLevelWriteGrants, []);
  assert.deepEqual(writer.jobs.map((j) => [j.id, j.writeGrants.map((g) => g.scope)]),
    [['autocoding-shield-live-gate', ['statuses']]]);
  assert.equal(writer.usesSecrets, false);
  assert.equal(writer.usesArtifactsOrCache, false);
  assert.deepEqual(writer.checkoutRefs, ['${{ github.event.repository.default_branch }}']);
});
