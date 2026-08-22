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
  describeReasons, resolvePublication, resolvePendingPublication, publishStatus, runPublish,
  parsePublishArgs, PUBLISH_ERROR, DESCRIPTION_LIMIT, STATUS_CONTEXT_RE, PENDING_PUBLICATION,
  PENDING_INCOMPATIBLE_OPTIONS,
} from '../scripts/autocoding/publish-live-status.mjs';

const FIXTURES = 'test/fixtures/autocoding-shield';
const HEAD = 'b9df1f8398aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const POLICY = JSON.parse(readFileSync('CONTROL/AUTOCODING/policy.v1.json', 'utf8'));
const CONTEXT_NAME = POLICY.live_status_context;

function raw(name) {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

/** Eén pagina met exact de meegegeven items — de vorm die `gh-bounded-pages.sh` oplevert. */
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

test('L9b. een ongemeten publicatie doet NUL fetches en heet HEAD_UNMEASURED', async () => {
  // `publishStatus` is los aanroepbaar, dus mag hij niet leunen op de resolvers die de head al
  // afdwingen. Vóór deze grens was `publication.sha` een onbewaakte property-read met twee
  // verschillende gevolgen: `null` gooide een TypeError die de transportafvang verkleedde als
  // `STATUS_TRANSPORT_ERROR`, en een object ZONDER geldige sha gooide niets maar stuurde een echte
  // POST naar `/statuses/undefined` — of, bij een sha met `/` of `..` erin, naar een heel ander pad.
  let touched = 0;
  const fetchImpl = async () => { touched += 1; return { status: 201 }; };
  const ongemeten = [
    null,
    undefined,
    {},
    { state: 'pending', context: CONTEXT_NAME, description: 'x' },
    { sha: null, state: 'pending', context: CONTEXT_NAME },
    { sha: '', state: 'pending', context: CONTEXT_NAME },
    { sha: HEAD.slice(0, 39), state: 'pending', context: CONTEXT_NAME },
    { sha: `${HEAD}0`, state: 'pending', context: CONTEXT_NAME },
    { sha: HEAD.toUpperCase(), state: 'pending', context: CONTEXT_NAME },
    { sha: `../../${HEAD}`, state: 'pending', context: CONTEXT_NAME },
    { sha: `${HEAD}/../../../repos/elders/statuses/${HEAD}`, state: 'pending', context: CONTEXT_NAME },
    { sha: 42, state: 'pending', context: CONTEXT_NAME },
    'not-an-object',
    42,
    [{ sha: HEAD, state: 'pending', context: CONTEXT_NAME }],
  ];
  for (const publication of ongemeten) {
    const posted = await publishStatus({
      repository: 'rvanhooijdonk-png/stack-dashboard', publication, token: 'x-token-x', fetchImpl,
    });
    assert.deepEqual(
      posted, { ok: false, blocked: PUBLISH_ERROR.HEAD_UNMEASURED },
      `ongemeten publicatie: ${JSON.stringify(publication) ?? String(publication)}`,
    );
  }
  assert.equal(touched, 0, 'geen enkele fetch op een ongemeten head');

  // De reponaamgrens blijft de eerste poort: bij twee kapotte invoeren is de uitkomst deterministisch
  // en niet afhankelijk van de volgorde waarin de aanroeper toevallig iets vergat.
  assert.deepEqual(
    await publishStatus({ repository: '../../etc', publication: null, token: 'x', fetchImpl }),
    { ok: false, blocked: PUBLISH_ERROR.REPOSITORY_INVALID },
  );
  assert.equal(touched, 0);

  // En de grens is niet te ruim: een volledig gemeten head gaat er gewoon doorheen.
  const goed = await publishStatus({
    repository: 'rvanhooijdonk-png/stack-dashboard', token: 'x-token-x', fetchImpl,
    publication: { ok: true, sha: HEAD, context: CONTEXT_NAME, ...PENDING_PUBLICATION },
  });
  assert.deepEqual(goed, { ok: true, status: 201 });
  assert.equal(touched, 1);
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

test('L10a. een falende fetch eindigt in EEN vaste categorie, nooit in een crash of foutlek', async () => {
  // De GitHub-API kan wegvallen: DNS, TLS, timeout, reset. `fetch` gooit dan. Zonder afvang werd dat
  // een onafgevangen promise-rejection met stacktrace in het joblog; nu is het een gesloten
  // categorie zonder een letter uit de exceptie.
  const publication = {
    ok: true, sha: HEAD, context: CONTEXT_NAME, state: 'success', description: 'GO: ...',
  };
  const geheim = 'ECONNREFUSED api.github.com token=x-token-x';
  const stukkeFetches = [
    async () => { throw new Error(geheim); },
    () => { throw new Error(geheim); },              // synchroon falende impl
    () => Promise.reject(new Error(geheim)),         // afgewezen promise zonder throw
    {},                                               // geen aanroepbare fetch in deze runtime
  ];
  for (const fetchImpl of stukkeFetches) {
    const posted = await publishStatus({
      repository: 'rvanhooijdonk-png/stack-dashboard', publication, token: 'x-token-x', fetchImpl,
    });
    assert.deepEqual(posted, { ok: false, blocked: PUBLISH_ERROR.STATUS_TRANSPORT_ERROR });
  }
});

test('L10b. runPublish eindigt rc 1 op een transportfout en logt alleen de vaste categorie', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'autocoding-live-status-'));
  const goPath = join(dir, 'go.json');
  writeFileSync(goPath, JSON.stringify({ decision: 'GO', reasons: [] }));
  const readFile = (path) => readFileSync(path, 'utf8');
  const geheim = 'getaddrinfo ENOTFOUND api.github.com (bearer x-token-x)';

  const logged = [];
  const original = console.log;
  console.log = (line) => logged.push(String(line));
  try {
    const rc = await runPublish([
      '--repository', 'rvanhooijdonk-png/stack-dashboard', '--head-sha', HEAD,
      '--status-context', CONTEXT_NAME, '--gate-result', goPath,
    ], { readFile, fetchImpl: async () => { throw new Error(geheim); } });

    // Rood, niet stil groen: een mislukte publicatie is nooit een geslaagde poort.
    assert.equal(rc, 1);
    assert.deepEqual(logged, [`LIVE_STATUS_POST_REJECTED_${PUBLISH_ERROR.STATUS_TRANSPORT_ERROR}`]);
    for (const line of logged) {
      assert.ok(!line.includes('x-token-x'), 'geen tokenmateriaal in de uitvoer');
      assert.ok(!line.includes('ENOTFOUND'), 'geen exceptietekst in de uitvoer');
      assert.ok(!line.includes('api.github.com'), 'geen endpoint in de uitvoer');
      assert.ok(!line.includes(geheim));
    }
  } finally {
    console.log = original;
  }
});

test('L10c. een transportfout in een APART PROCES geeft rc 1 zonder unhandled rejection', () => {
  // De echte regressie zat op procesniveau: een afgewezen `fetch` verliet `publishStatus` als
  // onafgevangen promise-rejection, met stacktrace op stderr. Dit draait de CLI-lus daarom in een
  // eigen Node-proces met een gooiende `fetch` — geen netwerk, wel een echt proces.
  const dir = mkdtempSync(join(tmpdir(), 'autocoding-live-status-cli-'));
  const goPath = join(dir, 'go.json');
  writeFileSync(goPath, JSON.stringify({ decision: 'GO', reasons: [] }));
  const geheim = 'getaddrinfo ENOTFOUND api.github.com (bearer x-token-x)';
  const script = `
    globalThis.fetch = () => Promise.reject(new Error(${JSON.stringify(geheim)}));
    const { readFileSync } = await import('node:fs');
    const { runPublish } = await import('./scripts/autocoding/publish-live-status.mjs');
    process.exitCode = await runPublish([
      '--repository', 'rvanhooijdonk-png/stack-dashboard',
      '--head-sha', ${JSON.stringify(HEAD)},
      '--status-context', ${JSON.stringify(CONTEXT_NAME)},
      '--gate-result', ${JSON.stringify(goPath)},
    ], { readFile: (path) => readFileSync(path, 'utf8') });
  `;
  const cli = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { ...process.env, GITHUB_TOKEN: 'x-token-x' },
  });
  assert.equal(cli.status, 1);
  assert.equal(cli.stderr, '', 'geen stacktrace, geen unhandled rejection');
  assert.equal(cli.stdout.trim(), `LIVE_STATUS_POST_REJECTED_${PUBLISH_ERROR.STATUS_TRANSPORT_ERROR}`);
  assert.ok(!cli.stdout.includes('x-token-x'));
  assert.ok(!cli.stdout.includes('ENOTFOUND'));
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
  const strip = (path) => readFileSync(path, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  // De statuswriter staat in een APART bestand dat door geen enkele PR-gecontroleerde event start.
  const liveGate = strip('.github/workflows/autocoding-shield-live-gate.yml');
  const prShield = strip('.github/workflows/autocoding-shield.yml');

  // De statuscontext is bewust geen jobnaam: zo kan de required check nooit samenvallen met een
  // Actions-run die aan de default-branch-SHA hangt.
  assert.ok(!liveGate.includes(`  ${CONTEXT_NAME}:`), 'de statuscontext mag geen jobnaam zijn');
  assert.notEqual(CONTEXT_NAME, 'autocoding-shield');
  assert.notEqual(CONTEXT_NAME, 'autocoding-shield-live-gate');

  // Alleen de trusted job mag statussen schrijven, en die job checkt de default branch uit. Het
  // PR-bestand — de enige dat op een `pull_request`-event zijn eigen voorgestelde definitie draait —
  // heeft geen enkele schrijfscope, dus is er geen event waarop PR-YAML `statuses: write` krijgt.
  assert.match(liveGate, /^\s+statuses: write$/m);
  assert.ok(!/:\s*write\b/.test(prShield), 'de PR-shield heeft geen schrijfscope');
  assert.ok(!/^ {2}pull_request(_target)?:$/m.test(liveGate), 'de trusted writer kent geen PR-event');
  assert.equal(liveGate.split('\n').filter((l) => /^\s+[a-z-]+:\s*write\b/.test(l)).length, 1);

  // De publicatie draait ook als de poortstap zelf ontplofte, en uitsluitend op de GEMETEN head:
  // `$head_sha` komt uit een eigen read-only API-lezing binnen de lus, nooit uit het eventpayload.
  assert.match(liveGate, /node scripts\/autocoding\/publish-live-status\.mjs/);
  assert.match(liveGate, /--head-sha "\$head_sha"/);
  assert.ok(
    !/--head-sha "\$\{\{ github\.event/.test(liveGate),
    'de head mag nooit uit het eventpayload komen',
  );
  // Een crash van de poortstap wordt opgevangen (`|| true`) en als uitvoeringsfout doorgegeven,
  // zodat de publicatie eronder hoe dan ook draait.
  assert.match(liveGate, /verify-review-gate\.mjs[\s\S]*?\|\| true/);
  assert.match(liveGate, /--execution-error "\$execution_error"/);

  // Record-lokale foutafhandeling: een mislukte invalidatie of een kapotte poortstap maakt de job
  // rood, maar breekt hem niet halverwege af — afbreken zou een `pending` laten staan zonder ooit
  // een uitspraak te publiceren.
  assert.ok(!/^\s*set -euo pipefail$/m.test(publishStep(liveGate)), 'de stap mag niet vroegtijdig stoppen');
  assert.match(publishStep(liveGate), /^\s*set -uo pipefail$/m);
  assert.match(liveGate, /overall=1/);
  assert.match(liveGate, /exit "\$overall"/);
});

/** Het `run:`-blok van de publicatiestap; daarbinnen mag geen `set -e` staan. */
function publishStep(liveGate) {
  const start = liveGate.indexOf(`      - name: ${SCHRIJFSTAP}`);
  assert.ok(start !== -1, 'publicatiestap ontbreekt');
  return liveGate.slice(start);
}

/** De naam van de enige stap die statussen schrijft; sinds V11 meet die precies één PR. */
const SCHRIJFSTAP = 'Meet, beslis en publiceer deze pull request';


// --- Argumentparser -------------------------------------------------------------------------------
//
// Gemini medium, review 4998403781, inline 3834607793. `runPublish()` las argv in VASTE PAREN. Eén
// losse booleaanse vlag middenin de lijst verschoof daardoor elk volgend key/valuepaar met één plek:
// `--head-sha` kreeg de waarde van `--status-context`, en de laatste sleutel verloor zijn waarde.
// Dat gebeurde STIL — de vlaggen bleven herkenbaar, alleen de bindingen klopten niet meer.

test('L13. --dry-run is positie-onafhankelijk: begin, midden en einde binden identiek', () => {
  const paren = [
    ['--repository', 'rvanhooijdonk-png/stack-dashboard'],
    ['--head-sha', HEAD],
    ['--status-context', CONTEXT_NAME],
    ['--gate-result', '/tmp/gate-result.json'],
  ];
  const vlak = paren.flat();
  const verwacht = {
    '--repository': 'rvanhooijdonk-png/stack-dashboard',
    '--head-sha': HEAD,
    '--status-context': CONTEXT_NAME,
    '--gate-result': '/tmp/gate-result.json',
  };

  // Elke invoegpositie op een paargrens — begin, alle tussenposities, einde.
  for (let i = 0; i <= paren.length; i += 1) {
    const argv = [...paren.slice(0, i).flat(), '--dry-run', ...paren.slice(i).flat()];
    const parsed = parsePublishArgs(argv);
    assert.equal(parsed.ok, true, `positie ${i}`);
    assert.equal(parsed.dryRun, true, `positie ${i}`);
    assert.deepEqual(Object.fromEntries(parsed.values), verwacht, `positie ${i}`);
  }

  // Het scherpe geval uit de bevinding: de vlag MIDDEN IN een paar-lijst. De oude paarlezing
  // (`i += 2`) las hier `--head-sha` als waarde van `--dry-run` en verschoof alles daarna.
  const middenin = ['--repository', 'rvanhooijdonk-png/stack-dashboard', '--dry-run',
    '--head-sha', HEAD, '--status-context', CONTEXT_NAME, '--gate-result', '/tmp/gate-result.json'];
  const oud = new Map();
  for (let i = 0; i < middenin.length; i += 2) oud.set(middenin[i], middenin[i + 1]);
  // De vlag op een ONEVEN positie schuift alles erna een plek op: `--head-sha` belandt als WAARDE
  // van `--dry-run` en verdwijnt als sleutel, terwijl de gemeten head zelf sleutel wordt.
  assert.equal(oud.get('--dry-run'), '--head-sha', 'de oude paarlezing verschoof daadwerkelijk');
  assert.equal(oud.get('--head-sha'), undefined, 'de gemeten head raakte kwijt');
  assert.equal(oud.get(HEAD), '--status-context');
  // De nieuwe parser bindt elke sleutel aan zijn eigen waarde, ongeacht waar de vlag staat.
  assert.equal(parsePublishArgs(middenin).values.get('--head-sha'), HEAD);
  assert.equal(parsePublishArgs(middenin).values.get('--status-context'), CONTEXT_NAME);
  assert.equal(parsePublishArgs(middenin).values.get('--gate-result'), '/tmp/gate-result.json');

  // En zonder de vlag is `dryRun` gewoon false.
  assert.equal(parsePublishArgs(vlak).dryRun, false);
});

test('L13a. onbekende, dubbele en waardeloze argumenten eindigen fail-closed', () => {
  const goed = ['--repository', 'rvanhooijdonk-png/stack-dashboard', '--head-sha', HEAD,
    '--status-context', CONTEXT_NAME, '--gate-result', '/tmp/gate-result.json'];
  assert.equal(parsePublishArgs(goed).ok, true);

  const fout = [
    ['--head-sha'],                                   // sleutel zonder waarde, aan het einde
    [...goed, '--execution-error'],                   // idem, na een geldige lijst
    ['--head-sha', '--status-context', CONTEXT_NAME], // waarde is zelf een sleutel
    ['--head-sha', '--dry-run'],                      // waarde is zelf een vlag
    ['--onbekend', 'x'],                              // onbekende sleutel
    ['--dry-runs'],                                   // bijna-vlag
    [...goed, 'losse-waarde'],                        // positioneel argument zonder sleutel
    ['--head-sha', HEAD, '--head-sha', HEAD],         // dubbele sleutel
    [...goed, '--dry-run', '--dry-run'],              // dubbele vlag
    [42],                                             // niet-string token
  ];
  for (const argv of fout) {
    const parsed = parsePublishArgs(argv);
    assert.equal(parsed.ok, false, JSON.stringify(argv));
    assert.equal(parsed.error, PUBLISH_ERROR.ARGUMENTS_INVALID, JSON.stringify(argv));
  }
});

test('L13b. runPublish weigert kapotte argv en publiceert dan niets', async () => {
  const logged = [];
  const original = console.log;
  console.log = (line) => logged.push(String(line));
  let touched = false;
  const fetchImpl = async () => { touched = true; return { status: 201 }; };
  try {
    const rc = await runPublish(
      ['--repository', 'rvanhooijdonk-png/stack-dashboard', '--onbekend', 'x'],
      { fetchImpl, readFile: () => JSON.stringify({ decision: 'GO', reasons: [] }) },
    );
    assert.equal(rc, 1);
    assert.equal(touched, false, 'een kapotte aanroep bereikt de API nooit');
    assert.equal(logged.at(-1), `LIVE_STATUS_NOT_PUBLISHABLE_${PUBLISH_ERROR.ARGUMENTS_INVALID}`);
  } finally {
    console.log = original;
  }
});

// --- Invalidatie (pendingmodus) ------------------------------------------------------------------
//
// Codex P1, review 4998653669, inline 3834812708. De writerlock houdt hooguit één WACHTENDE run aan.
// Wordt die door een nieuwe aanleiding geannuleerd, dan verdween de invalidatie die hij had moeten
// doen — en bleef een eerder gepubliceerde `success` bruikbaar. De reparatie is dat iedere writer
// EERST elke open head op `pending` zet, vóór er ook maar één detail-GET is gedaan. Dat maakt de
// publisher de enige plek waar die invalidatie vandaan komt, dus wordt hij hier gemeten.

test('L14. de pendingstatus is vast, draagt geen uitspraak en staat op de gemeten head', () => {
  const invalidatie = resolvePendingPublication({ headSha: HEAD, statusContext: CONTEXT_NAME });
  assert.equal(invalidatie.ok, true);
  assert.equal(invalidatie.state, 'pending');
  assert.notEqual(invalidatie.state, 'success', 'een invalidatie mag nooit groen zijn');
  assert.equal(invalidatie.sha, HEAD, 'altijd op de gemeten head');
  assert.equal(invalidatie.context, CONTEXT_NAME, 'exact dezelfde context als de uitspraak');
  assert.equal(invalidatie.description, PENDING_PUBLICATION.description);
  assert.ok(invalidatie.description.length <= DESCRIPTION_LIMIT);

  // Twee aanroepen met dezelfde head leveren byte-identiek dezelfde status: de invalidatie is een
  // constante, geen momentopname.
  assert.deepEqual(resolvePendingPublication({ headSha: HEAD, statusContext: CONTEXT_NAME }), invalidatie);

  // Zonder gemeten head of zonder geldige context wordt er niets geschreven — ook geen pending.
  for (const kapot of ['', 'HEAD', HEAD.slice(0, 39), `${HEAD}0`]) {
    const geweigerd = resolvePendingPublication({ headSha: kapot, statusContext: CONTEXT_NAME });
    assert.equal(geweigerd.ok, false, JSON.stringify(kapot));
    assert.equal(geweigerd.blocked, PUBLISH_ERROR.HEAD_UNMEASURED);
  }
  const geenContext = resolvePendingPublication({ headSha: HEAD, statusContext: '' });
  assert.equal(geenContext.ok, false);
  assert.equal(geenContext.blocked, PUBLISH_ERROR.STATUS_CONTEXT_INVALID);
});

test('L15. --pending geeft rc 0 UITSLUITEND als de pendingstatus werkelijk geplaatst is', async () => {
  const argv = ['--pending', '--repository', 'rvanhooijdonk-png/stack-dashboard',
    '--head-sha', HEAD, '--status-context', CONTEXT_NAME];
  const logged = [];
  const original = console.log;
  console.log = (line) => logged.push(String(line));
  try {
    // Geaccepteerd: 201 → rc 0, en de POST draagt state `pending` op de gemeten head.
    const verzoeken = [];
    const ok = async (url, init) => {
      verzoeken.push({ url, body: JSON.parse(init.body) });
      return { status: 201 };
    };
    assert.equal(await runPublish(argv, { fetchImpl: ok }), 0);
    assert.equal(verzoeken.length, 1);
    assert.equal(verzoeken[0].url, `https://api.github.com/repos/rvanhooijdonk-png/stack-dashboard/statuses/${HEAD}`);
    assert.deepEqual(verzoeken[0].body, {
      state: 'pending', context: CONTEXT_NAME, description: PENDING_PUBLICATION.description,
    });
    assert.equal(logged.at(-1), 'LIVE_STATUS_PENDING_PUBLISHED');

    // Geweigerd door de API → rc 1. De head kan dan nog groen staan, dus moet de job dat weten.
    assert.equal(await runPublish(argv, { fetchImpl: async () => ({ status: 422 }) }), 1);
    assert.equal(logged.at(-1), 'LIVE_STATUS_PENDING_POST_REJECTED_422');

    // Transportfout → rc 1, één vaste categorie, geen stacktrace en geen verzoekdetails.
    assert.equal(await runPublish(argv, { fetchImpl: () => { throw new Error('boom'); } }), 1);
    assert.equal(logged.at(-1), `LIVE_STATUS_PENDING_POST_REJECTED_${PUBLISH_ERROR.STATUS_TRANSPORT_ERROR}`);

    // Geen gemeten head → er wordt niets gePOST en de rc is 1.
    let geraakt = false;
    const rc = await runPublish(
      ['--pending', '--repository', 'rvanhooijdonk-png/stack-dashboard', '--head-sha', '',
        '--status-context', CONTEXT_NAME],
      { fetchImpl: async () => { geraakt = true; return { status: 201 }; } },
    );
    assert.equal(rc, 1);
    assert.equal(geraakt, false);
    assert.equal(logged.at(-1), `LIVE_STATUS_PENDING_NOT_PUBLISHABLE_${PUBLISH_ERROR.HEAD_UNMEASURED}`);
  } finally {
    console.log = original;
  }
});

test('L16. de pending-CLI heeft een GESLOTEN vorm en kan geen uitspraak meesmokkelen', () => {
  const basis = ['--pending', '--repository', 'rvanhooijdonk-png/stack-dashboard',
    '--head-sha', HEAD, '--status-context', CONTEXT_NAME];
  const goed = parsePublishArgs(basis);
  assert.equal(goed.ok, true);
  assert.equal(goed.pending, true);
  assert.equal(parsePublishArgs(basis.slice(1)).pending, false, 'zonder de vlag is er geen pendingmodus');

  // Een poortresultaat of uitvoeringsfout heeft in deze modus geen betekenis. Stil negeren zou de
  // aanroeper laten denken dat er een uitspraak is gepubliceerd; de vorm bestaat dus niet.
  assert.deepEqual([...PENDING_INCOMPATIBLE_OPTIONS], ['--gate-result', '--execution-error']);
  for (const optie of PENDING_INCOMPATIBLE_OPTIONS) {
    const parsed = parsePublishArgs([...basis, optie, '/tmp/x.json']);
    assert.equal(parsed.ok, false, optie);
    assert.equal(parsed.error, PUBLISH_ERROR.ARGUMENTS_INVALID, optie);
  }
  // Ook andersom: de uitspraakvorm mag de vlag niet per ongeluk oppikken.
  assert.equal(parsePublishArgs([...basis, '--pending']).ok, false, 'dubbele vlag');
  assert.equal(parsePublishArgs(['--head-sha', '--pending']).ok, false, 'de vlag als waarde telt niet');

  // De vlag is positie-onafhankelijk, net als `--dry-run`.
  const achteraan = ['--repository', 'rvanhooijdonk-png/stack-dashboard', '--head-sha', HEAD,
    '--status-context', CONTEXT_NAME, '--pending'];
  assert.equal(parsePublishArgs(achteraan).pending, true);
  assert.equal(parsePublishArgs(achteraan).values.get('--head-sha'), HEAD);
});

test('L17. de writer invalideert de HERMETEN head vóór de eerste detail-GET, ná de per-PR-lock', () => {
  // V11 heeft de globale invalidatieronde vervangen door één invalidatie per PR, binnen de job die
  // de per-PR-lock houdt. De volgorde is de hele waarde ervan: wie eerst bewijs verzamelt en pas
  // daarna invalideert, laat een eerder groene head groen staan zolang die verzameling loopt.
  const liveGate = readFileSync('.github/workflows/autocoding-shield-live-gate.yml', 'utf8');
  const stap = publishStep(liveGate);

  const hermeting = stap.indexOf('repos/$REPOSITORY/pulls/$number');
  const pending = stap.indexOf('--pending');
  const detail = stap.indexOf('for endpoint in');
  assert.ok(hermeting !== -1, 'de hermeting bestaat');
  assert.ok(pending !== -1, 'de invalidatie bestaat');
  assert.ok(detail !== -1, 'de bewijsverzameling bestaat');
  assert.ok(hermeting < pending, 'er wordt hermeten vóór de invalidatie');
  assert.ok(pending < detail, 'de invalidatie staat vóór de eerste detail-GET');

  // De `pending` gaat naar dezelfde context en dezelfde HERMETEN head als de uitspraak.
  assert.match(stap, /publish-live-status\.mjs \\\n\s+--pending/);
  assert.match(stap, /--head-sha "\$head_sha"/);
  assert.match(stap, /--status-context "\$STATUS_CONTEXT"/);

  // Een mislukte invalidatie maakt de job rood, maar stopt hem niet: doorgaan levert alsnog een
  // uitspraak op die de oude status overschrijft, afbreken zou de oude status juist laten staan.
  assert.match(stap, /PR_\$\{number\}_NOT_INVALIDATED[\s\S]{0,40}overall=1/);
  assert.match(stap, /exit "\$overall"/);

  // Niets uit de aanleiding: de schrijfstap kent het eventpayload niet eens.
  const env = stap.slice(stap.indexOf('env:'), stap.indexOf('run: |'));
  assert.ok(!env.includes('GITHUB_EVENT_PATH'), 'de schrijfstap leest het eventpayload niet');
  assert.match(env, /PULL_REQUEST: \$\{\{ matrix\.pr \}\}/);
});

test('L13c. de vorm die de workflow werkelijk doorgeeft blijft geldig, inclusief lege --execution-error', () => {
  // De workflow geeft `--execution-error ""` door zodra er geen uitvoeringsfout is. De lege string is
  // dus een LEGITIEME waarde; ontbreken is iets anders dan leeg zijn.
  const workflowVorm = ['--repository', 'rvanhooijdonk-png/stack-dashboard', '--head-sha', HEAD,
    '--status-context', CONTEXT_NAME, '--gate-result', '/tmp/gate-result.json',
    '--execution-error', ''];
  const parsed = parsePublishArgs(workflowVorm);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dryRun, false);
  assert.equal(parsed.values.get('--execution-error'), '');
  assert.equal(parsed.values.get('--head-sha'), HEAD);
});
