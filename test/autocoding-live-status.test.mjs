/**
 * AUTOCODING_SHIELD — tests van de statuspublicatie.
 *
 * Deze tests bewijzen de eigenschap waar de hele live poort op rust: de gepubliceerde commitstatus
 * is een pure functie van de API-momentopname op de GEMETEN PR-head. Welk event de run startte, in
 * welke volgorde het bewijs binnenkwam, en of er tussendoor iets is bewerkt, verwijderd of dismissed
 * mag de uitkomst niet beïnvloeden — alleen het bewijs zelf mag dat. En alles wat geen bewezen GO is,
 * schrijft `failure` op precies dezelfde commit; er bestaat geen zwijgend pad dat een oude groene
 * uitspraak laat staan.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildShieldInput } from '../scripts/autocoding/collect-shield-input.mjs';
import { evaluateShield, REASON } from '../scripts/autocoding/verify-review-gate.mjs';
import {
  describeReasons, resolvePublication, publishStatus, runPublish,
  PUBLISH_ERROR, DESCRIPTION_LIMIT, STATUS_CONTEXT_RE,
} from '../scripts/autocoding/publish-live-status.mjs';

const FIXTURES = 'test/fixtures/autocoding-shield';
const HEAD = 'b9df1f8398aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const POLICY = JSON.parse(readFileSync('CONTROL/AUTOCODING/policy.v1.json', 'utf8'));
const CONTEXT_NAME = POLICY.live_status_context;

function raw(name) {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

/** Eén pagina met exact de meegegeven items — de vorm die `gh api --paginate --slurp` oplevert. */
function page(items) {
  return [items];
}

function flatten(name) {
  return raw(name).flat();
}

/**
 * Draait de complete keten zoals de workflow hem draait: momentopname → adapter → beslisser →
 * publicatie. `mutate` mag de momentopname aanpassen zoals een event dat zou doen.
 */
function publicationFor(mutate = (s) => s, { executionError } = {}) {
  const snapshot = mutate({
    pr: raw('pr'),
    headCommit: raw('head-commit'),
    prCommits: raw('pr-commits'),
    issueComments: page(flatten('issue-comments')),
    reviews: page(flatten('reviews')),
    reviewComments: raw('review-comments'),
    changedFiles: raw('files'),
    policy: POLICY,
  });
  const { context, shieldInput } = buildShieldInput(snapshot);
  const gateResult = evaluateShield({ ...shieldInput, context, policy: POLICY });
  return resolvePublication({
    headSha: context.pr_head_sha, statusContext: CONTEXT_NAME, gateResult, executionError,
  });
}

test('L1. de fixture-momentopname publiceert success op de gemeten head onder de vaste context', () => {
  const publication = publicationFor();
  assert.deepEqual(publication, {
    ok: true,
    sha: HEAD,
    context: CONTEXT_NAME,
    state: 'success',
    description: 'GO: native two-vendor review verified on this head',
  });
  assert.match(CONTEXT_NAME, STATUS_CONTEXT_RE);
});

test('L2. convergentie: elke volgorde van hetzelfde bewijs levert byte-identiek dezelfde status', () => {
  const baseline = publicationFor();
  const comments = flatten('issue-comments');
  const reviews = flatten('reviews');

  const permutations = [
    // Codex ná Gemini, en Gemini ná Codex: het event dat de run startte staat achteraan resp. vooraan.
    (s) => ({ ...s, issueComments: page([...comments].reverse()), reviews: page(reviews) }),
    (s) => ({ ...s, issueComments: page(comments), reviews: page([...reviews].reverse()) }),
    (s) => ({ ...s, issueComments: page([...comments].reverse()), reviews: page([...reviews].reverse()) }),
    // Gepagineerd binnengekomen in plaats van in één keer: dezelfde feiten, andere transportvorm.
    (s) => ({ ...s, issueComments: comments.map((c) => [c]), reviews: reviews.map((r) => [r]) }),
  ];

  for (const permutation of permutations) {
    assert.deepEqual(publicationFor(permutation), baseline);
  }
});

test('L3. een verwijderd Codex-comment maakt dezelfde head rood, niet stil groen', () => {
  const publication = publicationFor((s) => ({
    ...s,
    // Precies wat een `issue_comment: deleted` oplevert: het schone Codex-bewijs op deze head is weg.
    issueComments: page(flatten('issue-comments').filter((c) => c.id !== 4)),
  }));
  assert.equal(publication.sha, HEAD, 'dezelfde commit als de groene uitspraak');
  assert.equal(publication.context, CONTEXT_NAME, 'dezelfde context overschrijft de vorige status');
  assert.equal(publication.state, 'failure');
  assert.match(publication.description, /INSUFFICIENT_GO/);
});

test('L4. een dismissed Gemini-review maakt dezelfde head rood', () => {
  const publication = publicationFor((s) => ({
    ...s,
    reviews: page(flatten('reviews').map((r) => (
      r.id === 4997700001 ? { ...r, state: 'DISMISSED' } : r
    ))),
  }));
  assert.equal(publication.sha, HEAD);
  assert.equal(publication.state, 'failure');
  assert.match(publication.description, /INSUFFICIENT_GO/);
});

test('L5. een bewerkt Codex-comment dat zijn succesvorm verliest maakt dezelfde head rood', () => {
  const publication = publicationFor((s) => ({
    ...s,
    issueComments: page(flatten('issue-comments').map((c) => (
      c.id === 4
        ? { ...c, body: 'Codex Review: 2 comment(s) generated.\n\n**Reviewed commit:** `b9df1f8398`\n' }
        : c
    ))),
  }));
  assert.equal(publication.sha, HEAD);
  assert.equal(publication.state, 'failure');
});

test('L6. success uitsluitend bij een bewezen GO: elke andere uitkomst is failure op dezelfde head', () => {
  const cases = [
    ['NO_GO met redenen', { decision: 'NO_GO', reasons: [REASON.INSUFFICIENT_GO] }, ''],
    ['NO_GO zonder redenen', { decision: 'NO_GO', reasons: [] }, ''],
    ['onleesbaar resultaat', null, ''],
    ['leeg object', {}, ''],
    ['GO met resterende redenen', { decision: 'GO', reasons: [REASON.OWNER_GATE_REQUIRED] }, ''],
    ['GO naast een uitvoeringsfout', { decision: 'GO', reasons: [] }, PUBLISH_ERROR.GATE_EXECUTION_ERROR],
    ['truncatie', { decision: 'NO_GO', reasons: [REASON.FILES_INCOMPLETE] }, ''],
    ['parsefout van de beslisser', { decision: 'NO_GO', reasons: [REASON.PARSE_ERROR] }, ''],
  ];
  for (const [label, gateResult, executionError] of cases) {
    const publication = resolvePublication({
      headSha: HEAD, statusContext: CONTEXT_NAME, gateResult, executionError,
    });
    assert.equal(publication.ok, true, label);
    assert.equal(publication.sha, HEAD, label);
    assert.equal(publication.context, CONTEXT_NAME, label);
    assert.equal(publication.state, 'failure', label);
    assert.ok(publication.description.startsWith('NO_GO: '), label);
  }
  // En de enige groene vorm blijft groen.
  assert.equal(
    resolvePublication({ headSha: HEAD, statusContext: CONTEXT_NAME, gateResult: { decision: 'GO', reasons: [] } }).state,
    'success',
  );
});

test('L7. zonder gemeten head of geldige context wordt er niets gepubliceerd, ook niet groen', () => {
  for (const headSha of ['', undefined, 'b9df1f8398', `${HEAD}Z`, HEAD.toUpperCase()]) {
    const publication = resolvePublication({
      headSha, statusContext: CONTEXT_NAME, gateResult: { decision: 'GO', reasons: [] },
    });
    assert.deepEqual(publication, { ok: false, blocked: PUBLISH_ERROR.HEAD_UNMEASURED });
  }
  for (const statusContext of ['', undefined, '/leading-slash', 'met spatie']) {
    const publication = resolvePublication({
      headSha: HEAD, statusContext, gateResult: { decision: 'GO', reasons: [] },
    });
    assert.deepEqual(publication, { ok: false, blocked: PUBLISH_ERROR.STATUS_CONTEXT_INVALID });
  }
});

test('L8. de omschrijving is een gesloten, gesorteerde codelijst binnen de GitHub-limiet', () => {
  const sorted = describeReasons([REASON.OWNER_GATE_REQUIRED, REASON.FILES_INCOMPLETE, REASON.STALE_HEAD]);
  assert.equal(sorted, `NO_GO: ${[REASON.FILES_INCOMPLETE, REASON.OWNER_GATE_REQUIRED, REASON.STALE_HEAD].sort().join(',')}`);
  // Volgorde van binnenkomst en dubbelingen mogen de tekst niet veranderen: twee runs met dezelfde
  // bevindingen schrijven dezelfde regel.
  assert.equal(describeReasons([REASON.STALE_HEAD, REASON.FILES_INCOMPLETE, REASON.OWNER_GATE_REQUIRED, REASON.STALE_HEAD]), sorted);

  // Onbekende inhoud wordt nooit doorgegeven, maar evenmin verzwegen.
  const injected = describeReasons(['ruwe stderr: https://example.invalid/pad/naar/geheim', 42, null]);
  assert.equal(injected, `NO_GO: ${PUBLISH_ERROR.UNRECOGNISED_REASON}`);
  assert.ok(!injected.includes('http'));
  assert.equal(describeReasons([]), `NO_GO: ${PUBLISH_ERROR.UNSPECIFIED}`);

  // Alle codes tegelijk past niet in 140 tekens; dan blijft het aantal weggelaten codes zichtbaar.
  const all = describeReasons(Object.values(REASON));
  assert.ok(all.length <= DESCRIPTION_LIMIT, `te lang: ${all.length}`);
  assert.match(all, /,\+\d+$/);
  for (const part of all.slice('NO_GO: '.length).split(',')) {
    assert.ok(/^\+\d+$/.test(part) || Object.values(REASON).includes(part), `afgekapte code: ${part}`);
  }
});

test('L9. publishStatus schrijft op /statuses/<gemeten sha> en lekt het token niet', () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { status: 201 };
  };
  const publication = {
    ok: true, sha: HEAD, context: CONTEXT_NAME, state: 'failure', description: 'NO_GO: INSUFFICIENT_GO',
  };
  return publishStatus({
    repository: 'rvanhooijdonk-png/stack-dashboard', publication, token: 'x-token-x', fetchImpl,
  }).then(async (posted) => {
    assert.deepEqual(posted, { ok: true, status: 201 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://api.github.com/repos/rvanhooijdonk-png/stack-dashboard/statuses/${HEAD}`);
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      state: 'failure', context: CONTEXT_NAME, description: 'NO_GO: INSUFFICIENT_GO',
    });

    // Een niet-201 is geen publicatie: fail-closed, en de reden is de HTTP-code, niet het antwoord.
    const rejected = await publishStatus({
      repository: 'rvanhooijdonk-png/stack-dashboard', publication, token: 'x-token-x',
      fetchImpl: async () => ({ status: 403, body: 'geheime foutmelding' }),
    });
    assert.deepEqual(rejected, { ok: false, status: 403 });

    // Een reponaam die geen `owner/repo` is bereikt de API nooit.
    let touched = false;
    const invalid = await publishStatus({
      repository: '../../etc', publication, token: 'x-token-x',
      fetchImpl: async () => { touched = true; return { status: 201 }; },
    });
    assert.deepEqual(invalid, { ok: false, blocked: PUBLISH_ERROR.REPOSITORY_INVALID });
    assert.equal(touched, false);
  });
});

test('L10. de CLI publiceert alleen bij een leesbaar GO-resultaat en geeft anders rc 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'autocoding-live-status-'));
  const goPath = join(dir, 'go.json');
  const noGoPath = join(dir, 'no-go.json');
  const brokenPath = join(dir, 'broken.json');
  writeFileSync(goPath, JSON.stringify({ decision: 'GO', reasons: [] }));
  writeFileSync(noGoPath, JSON.stringify({ decision: 'NO_GO', reasons: [REASON.INSUFFICIENT_GO] }));
  writeFileSync(brokenPath, '{ dit is geen json');

  const logged = [];
  const original = console.log;
  console.log = (line) => logged.push(String(line));
  const readFile = (path) => readFileSync(path, 'utf8');
  try {
    const base = ['--repository', 'rvanhooijdonk-png/stack-dashboard', '--head-sha', HEAD,
      '--status-context', CONTEXT_NAME];

    assert.equal(await runPublish([...base, '--gate-result', goPath, '--dry-run'], { readFile }), 0);
    assert.equal(JSON.parse(logged.at(-1)).state, 'success');

    assert.equal(await runPublish([...base, '--gate-result', noGoPath, '--dry-run'], { readFile }), 1);
    assert.equal(JSON.parse(logged.at(-1)).state, 'failure');

    // Onleesbaar resultaat: nog steeds een publicatie, op dezelfde head, en rood.
    assert.equal(await runPublish([...base, '--gate-result', brokenPath, '--dry-run'], { readFile }), 1);
    assert.deepEqual(JSON.parse(logged.at(-1)), {
      ok: true, sha: HEAD, context: CONTEXT_NAME, state: 'failure',
      description: `NO_GO: ${PUBLISH_ERROR.GATE_RESULT_UNREADABLE}`,
    });

    // Ontbrekend bestand (de gate-stap kwam nooit tot schrijven) idem.
    assert.equal(await runPublish([...base, '--gate-result', join(dir, 'weg.json'), '--dry-run'], { readFile }), 1);
    assert.match(logged.at(-1), new RegExp(PUBLISH_ERROR.GATE_RESULT_UNREADABLE));

    // Een gemelde uitvoeringsfout overstemt zelfs een GO-bestand.
    assert.equal(await runPublish([
      ...base, '--gate-result', goPath, '--execution-error', PUBLISH_ERROR.GATE_EXECUTION_ERROR, '--dry-run',
    ], { readFile }), 1);
    assert.equal(JSON.parse(logged.at(-1)).state, 'failure');

    // Zonder gemeten head is er niets om op te publiceren; dat wordt gemeld, niet verzwegen.
    assert.equal(await runPublish([
      '--repository', 'rvanhooijdonk-png/stack-dashboard', '--head-sha', '',
      '--status-context', CONTEXT_NAME, '--gate-result', goPath, '--dry-run',
    ], { readFile }), 1);
    assert.equal(logged.at(-1), `LIVE_STATUS_NOT_PUBLISHABLE_${PUBLISH_ERROR.HEAD_UNMEASURED}`);

    for (const line of logged) {
      assert.ok(!line.includes('x-token-x'), 'geen tokenmateriaal in de uitvoer');
    }
  } finally {
    console.log = original;
  }
});

test('L11. de CLI als losse binary schrijft geen stderr en lekt geen argumenten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'autocoding-live-status-cli-'));
  const goPath = join(dir, 'go.json');
  writeFileSync(goPath, JSON.stringify({ decision: 'GO', reasons: [] }));
  const cli = spawnSync(process.execPath, [
    'scripts/autocoding/publish-live-status.mjs',
    '--repository', 'rvanhooijdonk-png/stack-dashboard', '--head-sha', HEAD,
    '--status-context', CONTEXT_NAME, '--gate-result', goPath, '--dry-run',
  ], { encoding: 'utf8', env: { ...process.env, GITHUB_TOKEN: 'x-token-x' } });
  assert.equal(cli.status, 0);
  assert.equal(cli.stderr, '');
  const publication = JSON.parse(cli.stdout);
  assert.equal(publication.state, 'success');
  assert.equal(publication.sha, HEAD);
  assert.ok(!cli.stdout.includes('x-token-x'));
});

test('L12. de workflow publiceert altijd, op de gemeten head, met de enige schrijfscope in de stack', () => {
  const workflow = readFileSync('.github/workflows/autocoding-shield.yml', 'utf8');
  const yaml = workflow.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  const liveGate = yaml.slice(yaml.indexOf('\n  autocoding-shield-live-gate:'));
  const headJob = yaml.slice(yaml.indexOf('\n  autocoding-shield:'), yaml.indexOf('\n  autocoding-shield-live-gate:'));

  // De statuscontext is bewust geen jobnaam: zo kan de required check nooit samenvallen met een
  // Actions-run die aan de default-branch-SHA hangt.
  assert.ok(!yaml.includes(`  ${CONTEXT_NAME}:`), 'de statuscontext mag geen jobnaam zijn');
  assert.notEqual(CONTEXT_NAME, 'autocoding-shield');
  assert.notEqual(CONTEXT_NAME, 'autocoding-shield-live-gate');

  // Alleen de trusted job mag statussen schrijven, en die job checkt de default branch uit.
  assert.match(liveGate, /^\s+statuses: write$/m);
  assert.ok(!/:\s*write\b/.test(headJob), 'de PR-head-job heeft geen schrijfscope');
  assert.equal(yaml.split('\n').filter((l) => /^\s+[a-z-]+:\s*write\b/.test(l)).length, 1);

  // De publicatie draait ook als de poortstap zelf ontplofte, en uitsluitend op de GEMETEN head.
  assert.match(liveGate, /if: always\(\) && steps\.snapshot\.outputs\.head_sha != ''/);
  assert.match(liveGate, /--head-sha "\$HEAD_SHA"/);
  assert.match(liveGate, /HEAD_SHA: \$\{\{ steps\.snapshot\.outputs\.head_sha \}\}/);
  assert.ok(
    !/--head-sha "\$\{\{ github\.event/.test(liveGate),
    'de head mag nooit uit het eventpayload komen',
  );
  assert.match(liveGate, /continue-on-error: true/);
  assert.match(liveGate, /node scripts\/autocoding\/publish-live-status\.mjs/);
});
