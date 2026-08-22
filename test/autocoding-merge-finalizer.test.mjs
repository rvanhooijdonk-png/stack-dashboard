/**
 * AUTOCODING_SHIELD — tests van de PR-GEBONDEN MERGEFINALIZER.
 *
 * Deze suite bewijst de kern van V18: de mergebevoegdheid hangt niet meer aan een artefact dat een
 * TWEEDE pull request kan oppakken, maar aan een beslissing over ÉÉN hermeten pull request, gevolgd
 * door één aanroep die dat PR-nummer in het pad en de volledige gemeten head in het lichaam draagt.
 *
 * De fixtures zijn dezelfde deterministische API-vormen als in de adaptertests, met precies drie
 * wijzigingen die de finalizer nodig heeft: een gemeten `base.ref`, een bouwer uit de allowlist, en
 * een ownerautorisatie die óók het PR-nummer en de base noemt. Alles wat verder in de fixture zit —
 * gespoofd vendorbewijs, bewijs van een vorige head, menselijk proza — blijft staan, zodat elke GO
 * hieronder een GO is ONDANKS die ruis.
 *
 * IN DEZE PR STAAN ALLE VLAGGEN UIT. De tests die een effect meten zetten `merge_finalizer_enabled`
 * op `true` in een LOKAAL policyobject; het bestand in de repository blijft `false` (M2), en er gaat
 * nooit een verzoek naar een echte host: elke `fetchImpl` hieronder is een teller.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  MERGE_FINALIZER_SCHEMA, FINALIZE_DECISION, FINALIZE_REASON, FINALIZE_ERROR,
  ALLOWED_MERGE_METHODS, CANDIDATE_LIMIT_MAX,
  FINALIZER_MEASUREMENT_REQUEST_BUDGET, FINALIZER_PER_CANDIDATE_REQUEST_BUDGET,
  finalizerRequestBudget, assertMergeFinalizerPolicySafe, normaliseCheckRuns,
  resolveRequiredChecks, measurementFingerprint, resolveFinalization, mergePullRequest,
  parseFinalizeArgs, FINALIZE_VALUE_OPTIONS, FINALIZE_BOOLEAN_FLAGS, MEASUREMENT_FILES,
  readMeasurement, runFinalize, hasActiveMergeQueueRule, SERVER_GATE_MODE,
  REJECTED_SERVER_GATE_MODE, OWNER_ACTION_REQUIRED_EXIT_CODE, OWNER_MERGE_PACKAGE_SCHEMA,
  OWNER_MERGE_PACKAGE_FIELDS, OWNER_PACKAGE_REASON, OWNER_PACKAGE_MAX_AGE_SECONDS_MAX,
  buildOwnerMergePackage, verifyOwnerMergePackage,
} from '../scripts/autocoding/finalize-merge.mjs';
import {
  CANDIDATE_REASON, CANDIDATE_VALUE_OPTIONS, selectFinalizationCandidates,
  parseCandidateArgs, runSelectCandidates,
} from '../scripts/autocoding/select-finalize-candidates.mjs';
import { REASON } from '../scripts/autocoding/verify-review-gate.mjs';
import {
  SHARED_HOURLY_REQUEST_QUOTA, QUOTA_RESERVE, SELECTION_PAGE_BUDGET,
  SCHEDULE_SLOT_SECONDS, SCHEDULE_BUCKET_LIMIT, scheduleSlotOf, selectScheduleBucket,
} from '../scripts/autocoding/select-live-gate-targets.mjs';

const FINALIZER = 'scripts/autocoding/finalize-merge.mjs';
const FIXTURES = 'test/fixtures/autocoding-shield';
const HEAD = 'b9df1f8398aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TREE = 'e'.repeat(40);
const BASE = '2af69bc6259caf5c2f1e03a2c59e56c810ac9831';
// V23 — de LIVE head van de base-branch, apart gemeten en met opzet ONGELIJK aan `BASE`: de base mag
// legitiem verder staan dan het basispunt van deze pull request.
const BASE_HEAD = 'f414ba1655bf37296f6a9ef405978029c8c19d80';
// De sha van de MERGE-COMMIT die GitHub in de STRICT-tak teruggeeft — nooit gelijk aan de head die
// is aangevraagd.
const ANDERE_BASE = '9'.repeat(40);
const TASK = 'AUTOCODING_STACK_DASHBOARD_LIVE_GATE_COMPLETION_PR_V1';
const PR_A = 74;
const PR_B = 75;
const OWNER = 'rvanhooijdonk-png';
const CHECK = 'autocoding-shield';
// V21 (Gemini1 V20-bevinding, HIGH #2): de toekomstige merge-group-poort moet, ook al draait ze
// alleen op een `merge_group`-commit en dus NOOIT als check-run op de PR-eigen head, wél als
// vereiste, producent-app-gebonden check in de required_status_checks-regel van de merge-queue
// bestaan — vandaar een aparte context-naam naast `CHECK`, uitsluitend in `mergeQueueRules`.
const CHECK_MG = 'autocoding-merge-group-gate';
// Slot 0: bij een bucket van één (elke lijst hieronder is korter dan `SCHEDULE_BUCKET_LIMIT`) is
// `bezoek` 0 en begint het venster bij index 0 — dezelfde canonieke volgorde als vóór de rotatie.
const NU = 0;

const POLICY_BESTAND = Object.freeze(
  JSON.parse(readFileSync('CONTROL/AUTOCODING/policy.v1.json', 'utf8')),
);

function kloon(waarde) {
  return JSON.parse(JSON.stringify(waarde));
}

function raw(naam) {
  return JSON.parse(readFileSync(join(FIXTURES, `${naam}.json`), 'utf8'));
}

/** Het bestandspolicy met de vlaggen die een test nodig heeft — nooit het bestand zelf. */
function policy(overrides = {}, finalizerOverrides = {}) {
  const p = kloon(POLICY_BESTAND);
  return {
    ...p,
    ...overrides,
    merge_finalizer: { ...p.merge_finalizer, ...finalizerOverrides },
  };
}

/**
 * De policy zoals hij in de repository STAAT — sinds V24 `server_gate_mode: MANUAL_OWNER_GATE`, de
 * eigenaarsstand voor dit persoonlijke repository — met uitsluitend de activatievlag omgezet. Dit is
 * de default van `beslis`/`draai`: de baan die op dit object werkelijk bereikbaar is, wordt ook
 * werkelijk getest.
 */
const POLICY_MANUAL = policy({ merge_finalizer_enabled: true });

/**
 * De GEWEIGERDE stand van V23. Geen enkele test mag hem als werkende modus gebruiken — hij staat hier
 * uitsluitend om te bewijzen dat hij nergens meer doorheen komt (O1).
 */
const POLICY_GEWEIGERD = policy(
  { merge_finalizer_enabled: true }, { server_gate_mode: 'STRICT_STATUS_CHECKS' },
);

/**
 * De DORMANTE legacy-modus, sinds V23 expliciet gezet in plaats van geërfd uit het bestand. Op dit
 * persoonlijke repository is zij onbereikbaar (GitHub weigert er een `merge_queue`-ruleset met 422),
 * maar de tak bestaat nog voor een organisatie-object en blijft daarom volledig gemeten.
 */
const POLICY_QUEUE = policy({ merge_finalizer_enabled: true }, { server_gate_mode: 'MERGE_QUEUE' });

function ownerBlok(overrides = {}) {
  const blok = {
    schema: 'AUTOCODING_OWNER_APPROVAL_V1',
    task_id: TASK,
    head_sha: HEAD,
    tree_sha: TREE,
    base_sha: BASE,
    pull_request: PR_A,
    decision: 'APPROVE',
    ...overrides,
  };
  return `Eigenaarsakkoord op de gevoelige paden.\n\n\`\`\`autocoding-owner-approval-v1\n${
    JSON.stringify(blok)}\n\`\`\`\n`;
}

/** Vervangt het ownercomment in de fixture door een blok met de VOLLEDIGE mergebinding. */
function issueCommentsMet(blok) {
  const pagina = kloon(raw('issue-comments'));
  for (const page of pagina) {
    for (const comment of page) {
      if (comment?.user?.login === OWNER) comment.body = blok;
    }
  }
  return pagina;
}

function checkRun(overrides = {}) {
  return {
    name: CHECK, head_sha: HEAD, status: 'completed', conclusion: 'success', ...overrides,
  };
}

/**
 * Een volledige meting van PR #74 die GO oplevert. Elke test verandert er precies één ding aan, zodat
 * de reden van een NO_GO nooit aan een tweede afwijking kan liggen.
 */
function meting(overrides = {}) {
  return {
    pr: {
      ...kloon(raw('pr')),
      state: 'open',
      draft: false,
      merged: false,
      user: { login: OWNER, type: 'User' },
      base: { sha: BASE, ref: 'main' },
      // V23 — GitHubs eigen mergebaarheidsoordeel. `clean` is de enige stand die telt.
      mergeable: true,
      mergeable_state: 'clean',
    },
    headCommit: kloon(raw('head-commit')),
    prCommits: kloon(raw('pr-commits')),
    issueComments: issueCommentsMet(ownerBlok()),
    reviews: kloon(raw('reviews')),
    reviewComments: kloon(raw('review-comments')),
    changedFiles: kloon(raw('files')),
    checkRuns: [[checkRun()]],
    // V20 — scope-item 3/5: de atomaire inschrijvingsvoorwaarde eist niet meer alleen het TYPE
    // `merge_queue`, maar ook de mergemethode (hoofdletters, zoals GitHub die levert) en een
    // `required_status_checks`-regel die elke vereiste check dekt met de gepinde producent-app.
    // V21 — Gemini1 V20-bevinding HIGH #2: die regel dekt nu ook `CHECK_MG`, want
    // `cfg.required_merge_queue_checks` (uit het echte policybestand) draagt sinds V21 beide namen.
    // V23 — deze regelset bedient BEIDE modi tegelijk, zodat elke mode-onafhankelijke test hieronder
    // in beide standen dezelfde GO oplevert en een NO_GO dus nooit aan de modus kan liggen:
    // `merge_queue` + `required_merge_queue_checks` voor `MERGE_QUEUE`, en `pull_request` met
    // `allowed_merge_methods` + `strict_required_status_checks_policy` voor `STRICT_STATUS_CHECKS`.
    // GitHub levert `allowed_merge_methods` in kleine letters en `merge_method` in hoofdletters; die
    // asymmetrie staat er met opzet in.
    mergeQueueRules: [
      { type: 'merge_queue', parameters: { merge_method: 'SQUASH' } },
      { type: 'pull_request', parameters: { allowed_merge_methods: ['squash'] } },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [
            { context: CHECK, integration_id: 15368 },
            { context: CHECK_MG, integration_id: 15368 },
          ],
        },
      },
    ],
    // V23 — waar de BASE-BRANCH op meetmoment werkelijk staat (`git/ref/heads/{base_ref}`). Bewust
    // een ANDERE sha dan `pr.base.sha`: de finalizer eist tussen die twee geen gelijkheid, en deze
    // fixture houdt die eis daarmee ook echt uit de GO-baan.
    baseHead: { ref: 'refs/heads/main', object: { sha: BASE_HEAD, type: 'commit' } },
    evidenceComplete: true,
    checksComplete: true,
    mergeQueueRulesComplete: true,
    ...overrides,
  };
}

function beslis(overrides = {}, p = POLICY_MANUAL, nummer = PR_A) {
  return resolveFinalization({ pullRequest: nummer, measurement: meting(overrides), policy: p });
}

/** Een `fetch` die nooit bereikt hoort te worden. Bereikt hij de test tóch, dan faalt die. */
function verbodenFetch() {
  const aanroepen = [];
  const impl = async (url, init) => {
    aanroepen.push({ url, init });
    return { status: 200 };
  };
  impl.aanroepen = aanroepen;
  return impl;
}

/**
 * Een `fetch` die op de `PUT` één vaste status teruggeeft, met — voor 200/202 — een LICHAAM erbij.
 * Zonder `lichaam` bouwt de fixture zelf een bewezen `enqueued`-antwoord op de `sha` uit het verzoek,
 * zodat de bestaande tests die alleen de HTTP-status toetsten (van vóór V20) ongewijzigd een geldige
 * inschrijving blijven zien. Statuscodes buiten 200/202 lezen het lichaam niet — precies zoals de
 * echte `mergePullRequest` dat ook niet doet — dus daar is geen `.json()` nodig.
 */
function antwoordFetch(status, lichaam) {
  const impl = verbodenFetch();
  return Object.assign(async (url, init) => {
    impl.aanroepen.push({ url, init });
    if (status !== 200 && status !== 202) return { status };
    const inhoud = lichaam !== undefined ? lichaam : (() => {
      const verzoek = init?.body ? JSON.parse(init.body) : {};
      return {
        status: 'enqueued',
        details: { merge_action: 'merge_queue', expected_head_sha: verzoek.sha ?? '' },
      };
    })();
    return { status, json: async () => inhoud };
  }, { aanroepen: impl.aanroepen });
}

// --- De beslissing ------------------------------------------------------------------------------

test('M1. een volledig bewezen pull request levert GO met exact de gemeten mergegegevens', () => {
  const uitkomst = beslis();
  assert.deepEqual(uitkomst.reasons, []);
  assert.equal(uitkomst.decision, FINALIZE_DECISION.GO);
  // Klasse A: de fixture raakt gevoelige paden, en klasse B staat bovendien uit.
  assert.equal(uitkomst.finalization_class, 'A');
  assert.deepEqual(uitkomst.merge, {
    pull_request: PR_A,
    sha: HEAD,
    merge_method: POLICY_BESTAND.merge_finalizer.merge_method,
    // V23 — de modus reist mee met de beslissing, zodat het effect hem niet zelf hoeft af te leiden.
    server_gate_mode: POLICY_BESTAND.merge_finalizer.server_gate_mode,
  });
  // De sha in het mergeobject is de VOLLEDIGE gemeten head — geen branch, geen afkorting.
  assert.match(uitkomst.merge.sha, /^[0-9a-f]{40}$/);
});

test('M2. het policybestand in de repository staat UIT en is toch volledig exact', () => {
  // De hele PR rust hierop: er is niets geactiveerd. Zou een van deze drie ooit ongemerkt omgaan,
  // dan faalt deze test vóór er iets kan mergen.
  assert.equal(POLICY_BESTAND.merge_finalizer_enabled, false);
  assert.equal(POLICY_BESTAND.class_b_auto_merge_enabled, false);
  assert.equal(POLICY_BESTAND.live_receipt_gate_enabled, false);
  // Uit betekent niet ongecontroleerd: een kapotte policy moet nú zichtbaar zijn, niet pas op het
  // moment dat iemand de vlag omzet.
  assert.doesNotThrow(() => assertMergeFinalizerPolicySafe(POLICY_BESTAND));
  assert.equal(POLICY_BESTAND.merge_finalizer.schema, MERGE_FINALIZER_SCHEMA);
  // En met de vlag uit is elke beslissing NO_GO, hoe compleet het bewijs ook is.
  const uit = beslis({}, POLICY_BESTAND);
  assert.equal(uit.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(uit.reasons.includes(FINALIZE_REASON.FINALIZER_DISABLED));
  assert.equal(uit.merge, undefined);
});

test('M3. een onexacte finalizerpolicy is UNSAFE en levert precies één reden op', () => {
  const varianten = [
    ['geen blok', policy({ merge_finalizer_enabled: true })],
    ['onbekende sleutel', policy({ merge_finalizer_enabled: true }, { extra: 1 })],
    ['ander schema', policy({ merge_finalizer_enabled: true }, { schema: 'IETS_ANDERS' })],
    ['onbekende methode', policy({ merge_finalizer_enabled: true }, { merge_method: 'fast-forward' })],
    ['lege bases', policy({ merge_finalizer_enabled: true }, { allowed_base_refs: [] })],
    ['ster als base', policy({ merge_finalizer_enabled: true }, { allowed_base_refs: ['*'] })],
    ['lege bouwers', policy({ merge_finalizer_enabled: true }, { allowed_builder_actors: [] })],
    ['ster als bouwer', policy({ merge_finalizer_enabled: true }, { allowed_builder_actors: ['*'] })],
    ['limiet 0', policy({ merge_finalizer_enabled: true }, { candidate_limit: 0 })],
    ['limiet te hoog', policy({ merge_finalizer_enabled: true }, { candidate_limit: CANDIDATE_LIMIT_MAX + 1 })],
    ['limiet geen geheel getal', policy({ merge_finalizer_enabled: true }, { candidate_limit: 2.5 })],
    ['geen checks', policy({ merge_finalizer_enabled: true }, { required_checks: [] })],
    ['ster als check', policy({ merge_finalizer_enabled: true }, { required_checks: ['*'] })],
    ['dubbele check', policy({ merge_finalizer_enabled: true }, { required_checks: [CHECK, CHECK] })],
    // V21 (Gemini1 V20-bevinding, HIGH #2): `required_merge_queue_checks` valideert via dezelfde
    // `assertCheckNameList`-sluiting als `required_checks` — dus dezelfde vier defectvormen.
    ['geen merge-queue-checks', policy({ merge_finalizer_enabled: true }, { required_merge_queue_checks: [] })],
    ['ster als merge-queue-check', policy({ merge_finalizer_enabled: true }, { required_merge_queue_checks: ['*'] })],
    ['dubbele merge-queue-check', policy(
      { merge_finalizer_enabled: true }, { required_merge_queue_checks: [CHECK_MG, CHECK_MG] },
    )],
    // V25 — `owner_package_max_age_seconds` valideert net zo gesloten als `candidate_limit`: geen
    // ontbrekend, nul, negatief, niet-geheel of te hoog getal.
    ['pakketverval ontbreekt', policy(
      { merge_finalizer_enabled: true }, { owner_package_max_age_seconds: undefined },
    )],
    ['pakketverval 0', policy({ merge_finalizer_enabled: true }, { owner_package_max_age_seconds: 0 })],
    ['pakketverval negatief', policy(
      { merge_finalizer_enabled: true }, { owner_package_max_age_seconds: -1 },
    )],
    ['pakketverval geen geheel getal', policy(
      { merge_finalizer_enabled: true }, { owner_package_max_age_seconds: 3600.5 },
    )],
    ['pakketverval te hoog', policy(
      { merge_finalizer_enabled: true },
      { owner_package_max_age_seconds: OWNER_PACKAGE_MAX_AGE_SECONDS_MAX + 1 },
    )],
  ];
  varianten[0][1].merge_finalizer = undefined;

  for (const [naam, p] of varianten) {
    assert.throws(() => assertMergeFinalizerPolicySafe(p), /FINALIZER_POLICY_UNSAFE/, naam);
    // De beslisser meet niet verder op een policy die zelf niet klopt: één reden, geen halve analyse
    // die suggereert dat de rest wél is gewogen.
    assert.deepEqual(
      resolveFinalization({ pullRequest: PR_A, measurement: meting(), policy: p }),
      { decision: FINALIZE_DECISION.NO_GO, reasons: [FINALIZE_REASON.FINALIZER_POLICY_UNSAFE] },
      naam,
    );
  }
});

test('M4. de DIAGNOSTISCHE statuscontext mag nooit een vereiste check zijn', () => {
  // Dit is de directe vertaling van bevinding 3835364972: een commitstatus is overdraagbaar, dus zou
  // hem als required check opvoeren de hele overdraagbaarheid terugzetten die deze finalizer oplost.
  const naam = POLICY_BESTAND.diagnostic_status_context;
  assert.equal(typeof naam, 'string');
  assert.ok(naam.length > 0);
  assert.ok(!POLICY_BESTAND.merge_finalizer.required_checks.includes(naam));
  assert.throws(
    () => assertMergeFinalizerPolicySafe(policy({}, { required_checks: [CHECK, naam] })),
    /FINALIZER_POLICY_UNSAFE/,
  );
  // De naam wordt uit de policy zelf gelezen: een hernoeming sleept de weigering mee in plaats van
  // hem stil te laten vervallen.
  assert.throws(
    () => assertMergeFinalizerPolicySafe(policy(
      { diagnostic_status_context: 'iets-heel-anders' }, { required_checks: ['iets-heel-anders'] },
    )),
    /FINALIZER_POLICY_UNSAFE/,
  );
  // En een CHECK RUN met dezelfde naam als de diagnostische context is nog steeds geen doorgang:
  // de weigering hangt aan de naam, niet aan het soort artefact.
  assert.doesNotThrow(() => assertMergeFinalizerPolicySafe(policy({}, { required_checks: [CHECK] })));

  // V21 (Gemini1 V20-bevinding, HIGH #2): dezelfde weigering geldt letterlijk voor
  // `required_merge_queue_checks` — de diagnostische context mag ook daar nooit in staan.
  assert.ok(!POLICY_BESTAND.merge_finalizer.required_merge_queue_checks.includes(naam));
  assert.throws(
    () => assertMergeFinalizerPolicySafe(policy({}, { required_merge_queue_checks: [CHECK_MG, naam] })),
    /FINALIZER_POLICY_UNSAFE/,
  );
  assert.doesNotThrow(
    () => assertMergeFinalizerPolicySafe(policy({}, { required_merge_queue_checks: [CHECK, CHECK_MG] })),
  );
});

test('M5. een meting van een ANDER PR-nummer kan deze finalisatie niet dragen', () => {
  // Het gevraagde nummer en het gemeten nummer moeten hetzelfde zijn. Zonder deze toets zou de
  // meting van PR A de merge van PR B kunnen autoriseren zodra beide dezelfde head hebben.
  const verkeerd = beslis({}, POLICY_QUEUE, PR_B);
  assert.equal(verkeerd.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(verkeerd.reasons.includes(FINALIZE_REASON.PULL_REQUEST_MISMATCH));

  for (const nummer of [0, -1, 1.5, null, undefined, '74']) {
    const u = resolveFinalization({ pullRequest: nummer, measurement: meting(), policy: POLICY_QUEUE });
    assert.ok(u.reasons.includes(FINALIZE_REASON.PULL_REQUEST_MISMATCH), String(nummer));
  }
  for (const gemeten of [0, -3, null, 'zesenzeventig']) {
    const u = beslis({ pr: { ...meting().pr, number: gemeten } });
    assert.ok(u.reasons.includes(FINALIZE_REASON.PULL_REQUEST_MISMATCH), String(gemeten));
  }
});

test('M6. PR B op DEZELFDE head erft niets van PR A — ook niet als B later wordt geopend', () => {
  // Het scenario uit bevinding 3835364972, nu op de finalizer losgelaten. B is een nieuwe pull
  // request op exact dezelfde commit, dezelfde boom, dezelfde base en dezelfde bouwer. Al haar
  // vendorbewijs is identiek, want dat hangt aan de commit. Het ENIGE dat niet meekomt is de
  // ownerautorisatie: die noemt PR #74.
  const bMeting = meting({
    pr: { ...meting().pr, number: PR_B },
  });
  const b = resolveFinalization({ pullRequest: PR_B, measurement: bMeting, policy: POLICY_QUEUE });
  assert.equal(b.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(b.reasons.includes(FINALIZE_REASON.MERGE_AUTHORIZATION_MISSING));
  assert.ok(b.reasons.includes(REASON.OWNER_APPROVAL_PULL_REQUEST_MISMATCH));
  assert.equal(b.merge, undefined);

  // En met een autorisatie die WEL op B slaat is B op eigen kracht groen — het is geen erfenis maar
  // een eigen, expliciet gegeven akkoord.
  const eigen = resolveFinalization({
    pullRequest: PR_B,
    measurement: meting({
      pr: { ...meting().pr, number: PR_B },
      issueComments: issueCommentsMet(ownerBlok({ pull_request: PR_B })),
    }),
    policy: POLICY_QUEUE,
  });
  assert.deepEqual(eigen.reasons, []);
  assert.equal(eigen.merge.pull_request, PR_B);
});

test('M7. de beslissing over A hangt van GEEN ENKELE andere pull request af', () => {
  // V17 probeerde overdraagbaarheid af te vangen met een repositorybrede open-PR-lijst. Die lijst is
  // offsetgepagineerd en dus geen atomaire momentopname (bevinding 3835364974). De beslisser heeft
  // daarom geen invoerkanaal meer waarlangs een andere pull request iets kan veranderen: er zijn
  // precies drie argumenten, en geen daarvan is een lijst van open pull requests.
  const a = beslis();
  assert.equal(a.decision, FINALIZE_DECISION.GO);

  // "B wordt geopend ná de GO-evaluatie van A" is voor deze functie letterlijk geen gebeurtenis:
  // dezelfde invoer levert dezelfde uitkomst, hoeveel PR's er intussen ook bijkomen.
  const naB = beslis();
  assert.deepEqual(naB, a);

  // En de vorm van de aanroep laat geen ruimte voor zo'n lijst: een meegegeven open-PR-lijst wordt
  // niet gelezen en kan de uitkomst dus niet kleuren.
  const metRuis = resolveFinalization({
    pullRequest: PR_A, measurement: meting(), policy: POLICY_MANUAL,
    openPulls: [[{ number: PR_B, head: { sha: HEAD } }]],
  });
  assert.deepEqual(metRuis, a);
});

test('M8. dezelfde head tegen een ANDERE base is een andere merge — en geen geërfde', () => {
  // Twee branches kunnen dezelfde commit als head hebben tegen verschillende bases. De boom is dan
  // identiek terwijl de merge iets heel anders doet, dus mag een autorisatie die de base noemt nooit
  // op de andere slaan.
  const andereBase = beslis({
    pr: { ...meting().pr, base: { sha: ANDERE_BASE, ref: 'main' } },
  });
  assert.equal(andereBase.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(andereBase.reasons.includes(REASON.OWNER_APPROVAL_BASE_MISMATCH));

  // Een base die buiten de allowlist valt is sowieso geen finalisatiedoel.
  const verkeerdeRef = beslis({
    pr: { ...meting().pr, base: { sha: BASE, ref: 'productie' } },
  });
  assert.ok(verkeerdeRef.reasons.includes(FINALIZE_REASON.BASE_REF_NOT_ALLOWED));

  // Een ONMEETBARE base is geen ontbrekende eis maar een eigen grond.
  const zonderBase = beslis({ pr: { ...meting().pr, base: { ref: 'main' } } });
  assert.ok(zonderBase.reasons.includes(FINALIZE_REASON.BASE_UNMEASURED));
});

test('M9. alleen een OPEN, niet-draft, niet-gemergede pull request kan gefinaliseerd worden', () => {
  const gesloten = beslis({ pr: { ...meting().pr, state: 'closed' } });
  assert.ok(gesloten.reasons.includes(FINALIZE_REASON.PULL_REQUEST_NOT_OPEN));
  const gemerged = beslis({ pr: { ...meting().pr, merged: true } });
  assert.ok(gemerged.reasons.includes(FINALIZE_REASON.PULL_REQUEST_NOT_OPEN));
  const concept = beslis({ pr: { ...meting().pr, draft: true } });
  assert.ok(concept.reasons.includes(FINALIZE_REASON.PULL_REQUEST_DRAFT));
  // Ontbrekende state is niet "waarschijnlijk open".
  const zonderState = beslis({ pr: { ...meting().pr, state: undefined } });
  assert.ok(zonderState.reasons.includes(FINALIZE_REASON.PULL_REQUEST_NOT_OPEN));
});

test('M10. head, tree, bouwer en task-id komen uit de meting en moeten alle vier kloppen', () => {
  const zonderHead = beslis({ pr: { ...meting().pr, head: { sha: 'b9df1f8' } } });
  assert.ok(zonderHead.reasons.includes(FINALIZE_REASON.HEAD_UNMEASURED));

  const zonderTree = beslis({ headCommit: { sha: HEAD } });
  assert.ok(zonderTree.reasons.includes(FINALIZE_REASON.TREE_UNMEASURED));

  const vreemdeBouwer = beslis({ pr: { ...meting().pr, user: { login: 'iemand-anders' } } });
  assert.ok(vreemdeBouwer.reasons.includes(FINALIZE_REASON.BUILDER_ACTOR_NOT_ALLOWED));

  const zonderTask = beslis({ pr: { ...meting().pr, body: 'Geen task-id in dit proza.' } });
  assert.ok(zonderTask.reasons.includes(FINALIZE_REASON.TASK_ID_UNMEASURED));
});

test('M11. onvolledig bewijs is nooit schoon bewijs', () => {
  // Een op de paginagrens afgekapte lijst LIJKT op een pull request zonder tegenstem.
  const afgekapt = beslis({ evidenceComplete: false });
  assert.equal(afgekapt.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(afgekapt.reasons.includes(FINALIZE_REASON.EVIDENCE_INCOMPLETE));

  // Een blinde vlek in de bestandenlijst is bovendien een reviewpoortgrond op zichzelf.
  const blindeVlek = beslis({ pr: { ...meting().pr, changed_files: 900 } });
  assert.equal(blindeVlek.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(blindeVlek.reasons.includes(FINALIZE_REASON.REVIEW_GATE_NO_GO));
});

test('M12. de reviewwet wordt ONGEWIJZIGD overgenomen, met haar eigen redennamen', () => {
  // Geen tweede parser en geen tweede vocabulaire: valt de reviewpoort om, dan draagt de finalizer
  // haar redencodes letterlijk mee.
  const zonderVendors = beslis({ issueComments: [[]], reviews: [[]], reviewComments: [[]] });
  assert.equal(zonderVendors.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(zonderVendors.reasons.includes(FINALIZE_REASON.REVIEW_GATE_NO_GO));
  assert.ok(zonderVendors.reasons.some((r) => Object.values(REASON).includes(r)));

  // Een nieuwe inline BEVINDING op de actuele head haalt het groen weg.
  // De bevinding hangt aan de Gemini-review OP DE ACTUELE HEAD (4997700001); een inline comment op
  // een review van een vorige head is geen actueel bewijs en zou hier niets bewijzen.
  const metBevinding = kloon(meting().reviewComments);
  metBevinding[0].push({
    id: 999999,
    pull_request_review_id: 4997700001,
    user: { login: 'gemini-code-assist[bot]', type: 'Bot' },
    path: 'scripts/autocoding/finalize-merge.mjs',
    body: 'P1: dit is een blokkerende bevinding.',
  });
  const bevinding = beslis({ reviewComments: metBevinding });
  assert.equal(bevinding.decision, FINALIZE_DECISION.NO_GO);
});

test('M13. een ownerakkoord op een VORIGE head autoriseert niets', () => {
  const oud = beslis({ issueComments: issueCommentsMet(ownerBlok({ head_sha: '7'.repeat(40) })) });
  assert.equal(oud.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(oud.reasons.includes(FINALIZE_REASON.MERGE_AUTHORIZATION_MISSING));

  // Een akkoord ZONDER PR- en basebinding is geen zwakkere mergeautorisatie maar geen enkele.
  const zonderBinding = beslis({
    issueComments: issueCommentsMet(ownerBlok({ pull_request: undefined, base_sha: undefined })),
  });
  assert.ok(zonderBinding.reasons.includes(REASON.OWNER_APPROVAL_BINDING_INCOMPLETE));

  // Een INGETROKKEN reviewdrager telt niet, ook al staat het blok er nog letterlijk.
  const dismissed = meting();
  dismissed.issueComments = [[]];
  dismissed.reviews = kloon(dismissed.reviews);
  dismissed.reviews[0].push({
    id: 424242, state: 'DISMISSED', commit_id: HEAD,
    user: { login: OWNER, type: 'User' }, body: ownerBlok(),
  });
  const ingetrokken = resolveFinalization({
    pullRequest: PR_A, measurement: dismissed, policy: POLICY_QUEUE,
  });
  assert.ok(ingetrokken.reasons.includes(FINALIZE_REASON.MERGE_AUTHORIZATION_MISSING));
});

test('M14. de vereiste checks moeten op EXACT deze head groen zijn', () => {
  const ontbreekt = beslis({ checkRuns: [[checkRun({ name: 'iets-anders' })]] });
  assert.ok(ontbreekt.reasons.includes(FINALIZE_REASON.REQUIRED_CHECK_MISSING));

  const andereCommit = beslis({ checkRuns: [[checkRun({ head_sha: '3'.repeat(40) })]] });
  assert.ok(andereCommit.reasons.includes(FINALIZE_REASON.REQUIRED_CHECK_HEAD_MISMATCH));

  // `skipped` heeft niets gemeten. Een poort die dat met goedgekeurd verwart is geen poort.
  const overgeslagen = beslis({ checkRuns: [[checkRun({ conclusion: 'skipped' })]] });
  assert.ok(overgeslagen.reasons.includes(FINALIZE_REASON.REQUIRED_CHECK_NOT_GREEN));

  const nogBezig = beslis({ checkRuns: [[checkRun({ status: 'in_progress', conclusion: '' })]] });
  assert.ok(nogBezig.reasons.includes(FINALIZE_REASON.REQUIRED_CHECK_NOT_GREEN));

  // Een geslaagde HERSTART naast een mislukte eerste poging is geen bewijs dat het groen is.
  const herstart = beslis({
    checkRuns: [[checkRun({ conclusion: 'failure' }), checkRun()]],
  });
  assert.ok(herstart.reasons.includes(FINALIZE_REASON.REQUIRED_CHECK_NOT_GREEN));

  const geen = beslis({ checkRuns: [[]] });
  assert.ok(geen.reasons.includes(FINALIZE_REASON.CHECK_RUNS_UNREADABLE));

  const afgekapt = beslis({ checksComplete: false });
  assert.ok(afgekapt.reasons.includes(FINALIZE_REASON.CHECK_RUNS_INCOMPLETE));
});

test('M15. `resolveRequiredChecks` onderscheidt ontbrekend, verkeerde commit en niet-groen', () => {
  const groen = [checkRun()];
  assert.deepEqual(resolveRequiredChecks(groen, [CHECK], HEAD), { ok: true, reasons: [] });

  assert.deepEqual(
    resolveRequiredChecks([], [CHECK], HEAD).reasons, [FINALIZE_REASON.REQUIRED_CHECK_MISSING],
  );
  assert.deepEqual(
    resolveRequiredChecks([checkRun({ head_sha: '3'.repeat(40) })], [CHECK], HEAD).reasons,
    [FINALIZE_REASON.REQUIRED_CHECK_HEAD_MISMATCH],
  );
  // Dezelfde naam op deze én op een andere commit: het zicht is dan niet eenduidig.
  assert.deepEqual(
    resolveRequiredChecks([checkRun(), checkRun({ head_sha: '3'.repeat(40) })], [CHECK], HEAD).reasons,
    [FINALIZE_REASON.REQUIRED_CHECK_HEAD_MISMATCH],
  );
  // Zonder gemeten head valt er niets te toetsen; dat is een eigen grond, geen stille doorgang.
  for (const sha of ['', 'b9df1f8', undefined, null, 'X'.repeat(40)]) {
    assert.deepEqual(
      resolveRequiredChecks(groen, [CHECK], sha),
      { ok: false, reasons: [FINALIZE_REASON.HEAD_UNMEASURED] }, String(sha),
    );
  }
  // Een lege eisenlijst levert geen groen op omdat er niets te toetsen viel — de policy weigert die
  // vorm al (M3), zodat dit pad nooit een merge kan dragen.
  assert.deepEqual(resolveRequiredChecks(groen, [], HEAD), { ok: true, reasons: [] });
});

test('M16. een onleesbare check verdwijnt niet als afwezige check', () => {
  const genormaliseerd = normaliseCheckRuns([[checkRun(), null, 'kapot', { name: 42 }]]);
  assert.equal(genormaliseerd.length, 4);
  assert.deepEqual(genormaliseerd[1], { name: '', head_sha: '', status: '', conclusion: '' });
  assert.deepEqual(genormaliseerd[3], { name: '', head_sha: '', status: '', conclusion: '' });
  // Afwezig en kapot leiden tot verschillende redencodes, dus mogen ze nooit op elkaar lijken.
  assert.deepEqual(
    resolveRequiredChecks(normaliseCheckRuns([[null]]), [CHECK], HEAD).reasons,
    [FINALIZE_REASON.REQUIRED_CHECK_MISSING],
  );
});

// --- De vingerafdruk ----------------------------------------------------------------------------

test('M17. de vingerafdruk verandert bij ELKE verschuiving die de uitspraak kan omdraaien', () => {
  const basis = measurementFingerprint(meting());
  assert.match(basis, /^[0-9a-f]{64}$/);
  // Twee identieke metingen zijn dezelfde waarheid — de vingerafdruk mag geen klok of volgorde zien.
  assert.equal(measurementFingerprint(meting()), basis);

  const verschuivingen = {
    head: { pr: { ...meting().pr, head: { sha: '4'.repeat(40) } } },
    tree: { headCommit: { ...meting().headCommit, tree: { sha: '5'.repeat(40) } } },
    base: { pr: { ...meting().pr, base: { sha: ANDERE_BASE, ref: 'main' } } },
    baseRef: { pr: { ...meting().pr, base: { sha: BASE, ref: 'release' } } },
    nummer: { pr: { ...meting().pr, number: PR_B } },
    draft: { pr: { ...meting().pr, draft: true } },
    state: { pr: { ...meting().pr, state: 'closed' } },
    bouwer: { pr: { ...meting().pr, user: { login: 'iemand-anders' } } },
    prLichaam: { pr: { ...meting().pr, body: 'ander proza' } },
    check: { checkRuns: [[checkRun({ conclusion: 'failure' })]] },
    bewijsvolledigheid: { evidenceComplete: false },
    checkvolledigheid: { checksComplete: false },
  };
  for (const [naam, overrides] of Object.entries(verschuivingen)) {
    assert.notEqual(measurementFingerprint(meting(overrides)), basis, naam);
  }
});

test('M17a. een INGETROKKEN of BEWERKTE review verschuift de vingerafdruk zonder de head te raken', () => {
  const basis = measurementFingerprint(meting());

  const ingetrokken = kloon(meting().reviews);
  ingetrokken[0][0].state = 'DISMISSED';
  assert.notEqual(measurementFingerprint(meting({ reviews: ingetrokken })), basis);

  const bewerkt = kloon(meting().reviews);
  bewerkt[0][0].body = `${bewerkt[0][0].body}\n\nToevoeging achteraf.`;
  assert.notEqual(measurementFingerprint(meting({ reviews: bewerkt })), basis);

  const nieuweBevinding = kloon(meting().reviewComments);
  nieuweBevinding[0].push({
    id: 987654,
    pull_request_review_id: 4997700001,
    user: { login: 'gemini-code-assist[bot]', type: 'Bot' },
    path: 'scripts/autocoding/finalize-merge.mjs',
    body: 'P1: nieuw.',
  });
  assert.notEqual(measurementFingerprint(meting({ reviewComments: nieuweBevinding })), basis);

  const verwijderdeAutorisatie = meting({ issueComments: [[]] });
  assert.notEqual(measurementFingerprint(verwijderdeAutorisatie), basis);

  // Alle vier laten de HEAD ongemoeid: een kale sha-vergelijking zou ze allemaal missen.
  for (const m of [
    meting({ reviews: ingetrokken }), meting({ reviews: bewerkt }),
    meting({ reviewComments: nieuweBevinding }), verwijderdeAutorisatie,
  ]) {
    assert.equal(m.pr.head.sha, HEAD);
  }
});

test('M17b. de volgorde waarin GitHub pagineert verandert de vingerafdruk NIET', () => {
  // Anders zou elke ronde drift melden op ruis in plaats van op een echte verschuiving.
  const omgekeerd = meting();
  omgekeerd.reviewComments = [kloon(omgekeerd.reviewComments).flat().reverse()];
  omgekeerd.changedFiles = [kloon(omgekeerd.changedFiles).flat().reverse()];
  omgekeerd.checkRuns = [[checkRun({ name: 'b' }), checkRun()]];
  const zelfde = meting({ checkRuns: [[checkRun(), checkRun({ name: 'b' })]] });
  omgekeerd.issueComments = meting().issueComments;
  omgekeerd.reviews = meting().reviews;
  assert.equal(
    measurementFingerprint(omgekeerd),
    measurementFingerprint({ ...zelfde, reviewComments: omgekeerd.reviewComments, changedFiles: omgekeerd.changedFiles }),
  );
});

// --- Het effect ---------------------------------------------------------------------------------

test('M18. met de vlag UIT doet elke effectpoging NUL verzoeken', () => {
  const fetchImpl = verbodenFetch();
  return mergePullRequest({
    repository: 'rvanhooijdonk-png/stack-dashboard',
    pullRequest: PR_A,
    sha: HEAD,
    mergeMethod: POLICY_BESTAND.merge_finalizer.merge_method,
    policy: POLICY_BESTAND,
    token: 'x',
    fetchImpl,
  }).then((uitkomst) => {
    assert.deepEqual(uitkomst, {
      ok: false, blocked: FINALIZE_ERROR.FINALIZER_DISABLED, requests: 0,
    });
    assert.equal(fetchImpl.aanroepen.length, 0);
  });
});

test('M19. elk onexact argument blokkeert VÓÓR het transport', async () => {
  const goed = {
    repository: 'rvanhooijdonk-png/stack-dashboard',
    pullRequest: PR_A,
    sha: HEAD,
    mergeMethod: POLICY_QUEUE.merge_finalizer.merge_method,
    policy: POLICY_QUEUE,
    token: 'x',
  };
  const gevallen = [
    [{ repository: 'geen-repo' }, FINALIZE_ERROR.REPOSITORY_INVALID],
    [{ repository: 'a/b/c' }, FINALIZE_ERROR.REPOSITORY_INVALID],
    [{ repository: '' }, FINALIZE_ERROR.REPOSITORY_INVALID],
    [{ pullRequest: 0 }, FINALIZE_ERROR.PULL_REQUEST_INVALID],
    [{ pullRequest: '74' }, FINALIZE_ERROR.PULL_REQUEST_INVALID],
    // De AFGEKORTE sha: zeven tekens zijn geen identiteit maar een prefix.
    [{ sha: 'b9df1f8' }, FINALIZE_ERROR.SHA_INVALID],
    [{ sha: HEAD.toUpperCase() }, FINALIZE_ERROR.SHA_INVALID],
    [{ sha: `${HEAD}\n` }, FINALIZE_ERROR.SHA_INVALID],
    [{ sha: 'refs/heads/main' }, FINALIZE_ERROR.SHA_INVALID],
    [{ sha: '' }, FINALIZE_ERROR.SHA_INVALID],
    [{ mergeMethod: 'fast-forward' }, FINALIZE_ERROR.MERGE_METHOD_NOT_ALLOWED],
    // Een op zichzelf toegestane methode die NIET de methode uit de policy is, telt ook niet.
    [{ mergeMethod: ALLOWED_MERGE_METHODS.find((m) => m !== goed.mergeMethod) },
      FINALIZE_ERROR.MERGE_METHOD_NOT_ALLOWED],
    [{ policy: policy({ merge_finalizer_enabled: true }, { candidate_limit: 0 }) },
      FINALIZE_REASON.FINALIZER_POLICY_UNSAFE],
  ];
  for (const [afwijking, code] of gevallen) {
    const fetchImpl = verbodenFetch();
    const uitkomst = await mergePullRequest({ ...goed, ...afwijking, fetchImpl });
    assert.deepEqual(uitkomst, { ok: false, blocked: code, requests: 0 }, JSON.stringify(afwijking));
    assert.equal(fetchImpl.aanroepen.length, 0, JSON.stringify(afwijking));
  }
});

test('M20. de merge-aanroep is PRECIES één merge-queue-PUT met het PR-nummer in het pad en de volle sha erin', async () => {
  const fetchImpl = antwoordFetch(200);
  const uitkomst = await mergePullRequest({
    repository: 'rvanhooijdonk-png/stack-dashboard',
    pullRequest: PR_A,
    sha: HEAD,
    mergeMethod: POLICY_QUEUE.merge_finalizer.merge_method,
    policy: POLICY_QUEUE,
    token: 'geheim',
    fetchImpl,
  });
  assert.deepEqual(uitkomst, { ok: true, status: 200, requests: 1, effect: 'MERGE_QUEUED' });
  assert.equal(fetchImpl.aanroepen.length, 1);

  const [{ url, init }] = fetchImpl.aanroepen;
  // V19 (Codex `3835523940`): geen klassieke `.../merge` meer, maar de asynchrone inschrijving.
  assert.equal(
    url,
    `https://api.github.com/repos/rvanhooijdonk-png/stack-dashboard/pulls/${PR_A}/merge-async`,
  );
  assert.equal(init.method, 'PUT');
  const body = JSON.parse(init.body);
  // DE MUTANTTOETS: zonder `sha` in het lichaam merget GitHub de HUIDIGE head, wat die ook is.
  assert.equal(body.sha, HEAD);
  assert.equal(body.merge_method, POLICY_QUEUE.merge_finalizer.merge_method);
  // DE MUTANTTOETS VOOR P1: `merge_action` moet PRECIES `merge_queue` zijn — nooit `direct_merge`
  // en nooit `default`, want beide zouden GitHub een merge buiten de wachtrij om kunnen laten kiezen.
  assert.equal(body.merge_action, 'merge_queue');
  // Er staat NIETS anders in: geen branchnaam, geen titel, geen ref.
  assert.deepEqual(Object.keys(body).sort(), ['merge_action', 'merge_method', 'sha']);
});

/** Eén fetch-reeks per verzoek — de eerste aanroep krijgt `reeks[0]`, de tweede `reeks[1]`, enz. De
 * laatste waarde herhaalt zich zodra de reeks op is. Een item mag ook een functie zijn, zodat een
 * transportfout op een LATERE poging even goed te simuleren is als op de eerste.
 */
function opeenvolgendeFetch(reeks) {
  const aanroepen = [];
  let i = 0;
  const impl = async (url, init) => {
    aanroepen.push({ url, init });
    const stap = reeks[Math.min(i, reeks.length - 1)];
    i += 1;
    if (typeof stap === 'function') return stap();
    return stap;
  };
  impl.aanroepen = aanroepen;
  return impl;
}

function jsonAntwoord(status, inhoud) {
  return { status, json: async () => inhoud };
}

/**
 * Een `sleepImpl` die geen enkele echte tijd kost maar wél precies vastlegt met welke duur, en hoe
 * vaak, hij is aangeroepen (V22, Gemini1-bevinding `5000494458`). Een pollende test injecteert deze
 * in plaats van de echte tijdklok, zodat hij de wachttijd kan METEN zonder hem uit te zitten.
 */
function geenWacht() {
  const aanroepen = [];
  const impl = async (ms) => { aanroepen.push(ms); };
  impl.aanroepen = aanroepen;
  return impl;
}

test(
  'M20a. CLAUDE4/CODEX V20: een 202 zonder leesbaar lichaam is GEEN bewezen inschrijving',
  async () => {
    // Precies de bevinding: het HTTP-statusnummer alleen bewijst niets. Een lichaam dat niet eens
    // JSON is, blokkeert vóór er ooit een `MERGE_QUEUED` kan volgen.
    const fetchImpl = opeenvolgendeFetch([
      { status: 202, json: async () => { throw new Error('geen json'); } },
    ]);
    const uitkomst = await mergePullRequest({
      repository: 'a/b', pullRequest: PR_A, sha: HEAD,
      mergeMethod: POLICY_QUEUE.merge_finalizer.merge_method, policy: POLICY_QUEUE, token: 'x', fetchImpl,
    });
    assert.deepEqual(uitkomst, {
      ok: false, blocked: FINALIZE_ERROR.MERGE_RESPONSE_INVALID, status: 202, requests: 1,
    });
  },
);

test(
  'M20b. een lichaam met een ONBEKENDE `status`-waarde is onleesbaar, geen vijfde toestand',
  async () => {
    for (const inhoud of [
      {}, { status: 'queued' }, { status: null }, { status: 200 }, 'enqueued', null,
      { status: 'enqueued', details: 'geen object' },
    ]) {
      const fetchImpl = opeenvolgendeFetch([jsonAntwoord(202, inhoud)]);
      const uitkomst = await mergePullRequest({
        repository: 'a/b', pullRequest: PR_A, sha: HEAD,
        mergeMethod: POLICY_QUEUE.merge_finalizer.merge_method, policy: POLICY_QUEUE, token: 'x', fetchImpl,
      });
      assert.equal(uitkomst.blocked, FINALIZE_ERROR.MERGE_RESPONSE_INVALID, JSON.stringify(inhoud));
      assert.equal(uitkomst.requests, 1, JSON.stringify(inhoud));
    }
  },
);

test(
  'M20c. terminaal `merged` of `failed` is uitdrukkelijk GEEN bewezen wachtrij-inschrijving',
  async () => {
    for (const status of ['merged', 'failed']) {
      const fetchImpl = opeenvolgendeFetch([
        jsonAntwoord(200, { status, details: { message: 'x' } }),
      ]);
      const uitkomst = await mergePullRequest({
        repository: 'a/b', pullRequest: PR_A, sha: HEAD,
        mergeMethod: POLICY_QUEUE.merge_finalizer.merge_method, policy: POLICY_QUEUE, token: 'x', fetchImpl,
      });
      assert.deepEqual(uitkomst, {
        ok: false, blocked: FINALIZE_ERROR.MERGE_RESULT_NOT_ENQUEUED, status: 200, requests: 1,
      }, status);
    }
  },
);

test(
  'M20d. een terminaal `enqueued` met de VERKEERDE actie of de VERKEERDE head is een DIVERGENT'
    + ' antwoord, geen bewezen inschrijving',
  async () => {
    const gevallen = [
      { merge_action: 'direct_merge', expected_head_sha: HEAD },
      { merge_action: 'default', expected_head_sha: HEAD },
      { merge_action: 'merge_queue', expected_head_sha: '4'.repeat(40) },
      { merge_action: 'merge_queue', expected_head_sha: '' },
    ];
    for (const details of gevallen) {
      const fetchImpl = opeenvolgendeFetch([jsonAntwoord(202, { status: 'enqueued', details })]);
      const uitkomst = await mergePullRequest({
        repository: 'a/b', pullRequest: PR_A, sha: HEAD,
        mergeMethod: POLICY_QUEUE.merge_finalizer.merge_method, policy: POLICY_QUEUE, token: 'x', fetchImpl,
      });
      assert.deepEqual(uitkomst, {
        ok: false, blocked: FINALIZE_ERROR.MERGE_RESULT_MISMATCH, status: 202, requests: 1,
      }, JSON.stringify(details));
    }
  },
);

test(
  'M20e. `pending` polt begrensd door tot een TERMINALE `enqueued` — en telt elke pollpoging mee',
  async () => {
    const uuid = '630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42';
    const fetchImpl = opeenvolgendeFetch([
      jsonAntwoord(202, { status: 'pending', details: { uuid, merge_method: 'squash', merge_action: 'default', expected_head_sha: HEAD } }),
      jsonAntwoord(200, { status: 'pending', details: { uuid } }),
      jsonAntwoord(200, {
        status: 'enqueued',
        details: { uuid, merge_action: 'merge_queue', expected_head_sha: HEAD },
      }),
    ]);
    const sleepImpl = geenWacht();
    const uitkomst = await mergePullRequest({
      repository: 'a/b', pullRequest: PR_A, sha: HEAD,
      mergeMethod: POLICY_QUEUE.merge_finalizer.merge_method, policy: POLICY_QUEUE, token: 'x', fetchImpl,
      sleepImpl,
    });
    assert.deepEqual(uitkomst, {
      ok: true, status: 202, requests: 3, effect: 'MERGE_QUEUED',
    });
    assert.equal(fetchImpl.aanroepen.length, 3);
    // De tweede en derde aanroep zijn LEZENDE `GET`-pollpogingen op exact deze `uuid` — geen tweede
    // `PUT`, en dus geen tweede inschrijvingsverzoek.
    assert.equal(fetchImpl.aanroepen[1].init.method, 'GET');
    assert.ok(fetchImpl.aanroepen[1].url.endsWith(`/pulls/${PR_A}/merge-async/${uuid}`));
    assert.equal(fetchImpl.aanroepen[2].init.method, 'GET');
    // V22: precies twee lezende pollpogingen, dus precies twee wachtpogingen ervoor — nooit vóór de
    // eerste schrijvende PUT.
    assert.deepEqual(sleepImpl.aanroepen, [2000, 2000]);
  },
);

test(
  'M20f. een `pending` die het pollbudget UITPUT levert NO_GO op, geen stille aanname van succes',
  async () => {
    const uuid = '630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42';
    // Het eerste verzoek (202) plus PRECIES `MERGE_ASYNC_POLL_BUDGET` (3) daaropvolgende
    // pollpogingen (elk HTTP 200, zoals de echte `GET .../merge-async/{uuid}`), allemaal nog
    // `pending` — nooit een terminale status.
    const fetchImpl = opeenvolgendeFetch([
      jsonAntwoord(202, { status: 'pending', details: { uuid } }),
      jsonAntwoord(200, { status: 'pending', details: { uuid } }),
    ]);
    const sleepImpl = geenWacht();
    const uitkomst = await mergePullRequest({
      repository: 'a/b', pullRequest: PR_A, sha: HEAD,
      mergeMethod: POLICY_QUEUE.merge_finalizer.merge_method, policy: POLICY_QUEUE, token: 'x', fetchImpl,
      sleepImpl,
    });
    assert.deepEqual(uitkomst, {
      ok: false, blocked: FINALIZE_ERROR.MERGE_POLL_EXHAUSTED, status: 202, requests: 4,
    });
    assert.equal(fetchImpl.aanroepen.length, 4, 'PUT + drie begrensde pollpogingen, geen vierde');
    // V22: precies `MERGE_ASYNC_POLL_BUDGET` (3) wachtpogingen — begrensd zoals de pollpogingen zelf.
    assert.deepEqual(sleepImpl.aanroepen, [2000, 2000, 2000]);
  },
);

test(
  'M20g. `pending` zonder een geldige `uuid` kan nooit gepolt worden en blokkeert direct',
  async () => {
    for (const details of [{}, { uuid: 'geen-uuid' }, { uuid: 123 }, undefined]) {
      const fetchImpl = opeenvolgendeFetch([jsonAntwoord(202, { status: 'pending', details })]);
      const uitkomst = await mergePullRequest({
        repository: 'a/b', pullRequest: PR_A, sha: HEAD,
        mergeMethod: POLICY_QUEUE.merge_finalizer.merge_method, policy: POLICY_QUEUE, token: 'x', fetchImpl,
      });
      assert.deepEqual(uitkomst, {
        ok: false, blocked: FINALIZE_ERROR.MERGE_RESPONSE_INVALID, status: 202, requests: 1,
      }, JSON.stringify(details));
    }
  },
);

test(
  'M20h. een TRANSPORTFOUT of een ONLEESBAAR lichaam TIJDENS het pollen stopt de poging',
  async () => {
    const uuid = '630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42';
    const transport = opeenvolgendeFetch([
      jsonAntwoord(202, { status: 'pending', details: { uuid } }),
      () => { throw new Error('netwerk weg'); },
    ]);
    const transportWacht = geenWacht();
    const uitkomstTransport = await mergePullRequest({
      repository: 'a/b', pullRequest: PR_A, sha: HEAD,
      mergeMethod: POLICY_QUEUE.merge_finalizer.merge_method, policy: POLICY_QUEUE, token: 'x',
      fetchImpl: transport, sleepImpl: transportWacht,
    });
    assert.deepEqual(uitkomstTransport, {
      ok: false, blocked: FINALIZE_ERROR.MERGE_POLL_TRANSPORT_ERROR, status: 202, requests: 2,
    });
    assert.deepEqual(transportWacht.aanroepen, [2000]);

    const onleesbaar = opeenvolgendeFetch([
      jsonAntwoord(202, { status: 'pending', details: { uuid } }),
      { status: 200, json: async () => { throw new Error('kapotte json'); } },
    ]);
    const onleesbaarWacht = geenWacht();
    const uitkomstOnleesbaar = await mergePullRequest({
      repository: 'a/b', pullRequest: PR_A, sha: HEAD,
      mergeMethod: POLICY_QUEUE.merge_finalizer.merge_method, policy: POLICY_QUEUE, token: 'x',
      fetchImpl: onleesbaar, sleepImpl: onleesbaarWacht,
    });
    assert.deepEqual(uitkomstOnleesbaar, {
      ok: false, blocked: FINALIZE_ERROR.MERGE_RESPONSE_INVALID, status: 202, requests: 2,
    });
    assert.deepEqual(onleesbaarWacht.aanroepen, [2000]);
  },
);

test('M21. 400, 403, 404, 409 en 422 zijn TERMINAAL — er volgt nooit een tweede poging', async () => {
  const gevallen = [
    [400, FINALIZE_ERROR.MERGE_NOT_READY],
    [403, FINALIZE_ERROR.MERGE_FORBIDDEN],
    [404, FINALIZE_ERROR.MERGE_RESOURCE_NOT_FOUND],
    [409, FINALIZE_ERROR.MERGE_ALREADY_QUEUED],
    [422, FINALIZE_ERROR.MERGE_REJECTED],
    [500, FINALIZE_ERROR.MERGE_STATUS_UNEXPECTED],
    [200, null],
    [202, null],
  ];
  for (const [status, code] of gevallen) {
    const fetchImpl = antwoordFetch(status);
    const sleepImpl = geenWacht();
    const uitkomst = await mergePullRequest({
      repository: 'a/b', pullRequest: PR_A, sha: HEAD,
      mergeMethod: POLICY_QUEUE.merge_finalizer.merge_method, policy: POLICY_QUEUE, token: 'x', fetchImpl,
      sleepImpl,
    });
    // Eén verzoek, altijd. Opnieuw proberen na een van deze codes zou ofwel een dubbele inschrijving
    // ofwel een nooit beoordeelde commit riskeren.
    assert.equal(fetchImpl.aanroepen.length, 1, String(status));
    assert.equal(uitkomst.requests, 1, String(status));
    if (code) assert.equal(uitkomst.blocked, code, String(status));
    else assert.equal(uitkomst.ok, true, String(status));
    // Een TERMINALE statuscode wacht nooit: de wachttijd geldt uitsluitend TUSSEN lezende
    // pollpogingen op een reeds aanvaard `pending`-verzoek (zie M20e/M20f/M20h), nooit rond een
    // terminale respons op de eerste PUT.
    assert.deepEqual(sleepImpl.aanroepen, [], String(status));
  }
  // De broncode kent geen enkele retryconstructie op een TERMINALE statuscode. `setTimeout` is sinds
  // V22 (Gemini1-bevinding `5000494458`) opzettelijk UITGESLOTEN van deze bewaking: dat woord draagt
  // nu de begrensde, dependency-injected wachttijd tussen `pending`-pollpogingen (`defaultSleep`,
  // hierboven zelf apart bewezen in M20e/M20f/M20h en M20i/M20j) — geen retry op een geweigerd
  // verzoek, en dus geen tegenstrijdigheid met deze toets.
  const bron = readFileSync(FINALIZER, 'utf8');
  assert.equal(/retry|opnieuw proberen|while \(/i.test(bron.replace(/^\s*(\/\/|\*).*$/gm, '')), false);
});

test('M21a. `hasActiveMergeQueueRule` eist het TYPE `merge_queue`, en niets minder', () => {
  assert.equal(hasActiveMergeQueueRule([{ type: 'merge_queue' }]), true);
  assert.equal(hasActiveMergeQueueRule([{ type: 'pull_request' }, { type: 'merge_queue' }]), true);
  for (const onvoldoende of [
    [], [{ type: 'pull_request' }], [{ type: 'required_status_checks' }], [{}], [null],
    null, undefined, 'merge_queue', {},
  ]) {
    assert.equal(hasActiveMergeQueueRule(onvoldoende), false, JSON.stringify(onvoldoende));
  }
});

test('M21b. ONTBREKEND of ONVOLDOENDE mergequeue-bewijs is NO_GO — nooit een directe merge', () => {
  // Bevinding `3835523940` (P1): zonder een ACTIEVE `merge_queue`-regel op de base van deze pull
  // request is er geen bewijs dat GitHub zelf de laatste beoordelaar op mergemoment is, dus mag er
  // geen inschrijving volgen.
  const onleesbaar = beslis({ mergeQueueRules: undefined }, POLICY_QUEUE);
  assert.equal(onleesbaar.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(onleesbaar.reasons.includes(FINALIZE_REASON.MERGE_QUEUE_RULES_UNREADABLE));

  const geenArray = beslis({ mergeQueueRules: 'geen lijst' }, POLICY_QUEUE);
  assert.equal(geenArray.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(geenArray.reasons.includes(FINALIZE_REASON.MERGE_QUEUE_RULES_UNREADABLE));

  const leeg = beslis({ mergeQueueRules: [] }, POLICY_QUEUE);
  assert.equal(leeg.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(leeg.reasons.includes(FINALIZE_REASON.SERVER_MERGE_QUEUE_PROOF_MISSING));

  const verkeerdType = beslis({ mergeQueueRules: [{ type: 'pull_request' }] }, POLICY_QUEUE);
  assert.equal(verkeerdType.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(verkeerdType.reasons.includes(FINALIZE_REASON.SERVER_MERGE_QUEUE_PROOF_MISSING));

  // Vandaag levert de echte repository `[]` op (`gh api repos/.../rules/branches/main`) — dit
  // pad is dus GEEN hypothese maar de huidige werkelijke stand.
  assert.equal(hasActiveMergeQueueRule([]), false);
});

test('M21c. mergequeue-DRIFT tussen de twee metingen levert nul verzoeken op', async () => {
  // Beide metingen blijven op zichzelf GO — er komt in B een TWEEDE actieve regel bij naast
  // `merge_queue` — zodat dit werkelijk de driftvergelijking raakt en niet al strandt op
  // `SERVER_MERGE_QUEUE_PROOF_MISSING` zoals M25a/M25b voor de head/review doen.
  const fetchImpl = verbodenFetch();
  const gewijzigd = meting({
    mergeQueueRules: [...meting().mergeQueueRules, { type: 'pull_request' }],
  });
  const { rc, uitkomst } = await draai({
    a: meting(), b: gewijzigd, p: POLICY_QUEUE, dryRun: false, fetchImpl,
  });
  assert.equal(rc, 1);
  assert.deepEqual(uitkomst, {
    decision: FINALIZE_DECISION.NO_GO, reasons: [FINALIZE_REASON.MEASUREMENT_DRIFT],
  });
  assert.equal(fetchImpl.aanroepen.length, 0);

  // Verdwijnt de regel juist WEG tussen A en B, dan is B op zichzelf al NO_GO — dezelfde lijn als
  // M25a/M25b: het bewijs ontbreekt al vóór de driftvergelijking wordt bereikt.
  const ingetrokken = meting({ mergeQueueRules: [] });
  const tweede = await draai({
    a: meting(), b: ingetrokken, p: POLICY_QUEUE, dryRun: false, fetchImpl,
  });
  assert.equal(tweede.rc, 1);
  assert.equal(tweede.uitkomst.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(tweede.uitkomst.reasons.includes(FINALIZE_REASON.SERVER_MERGE_QUEUE_PROOF_MISSING));
  assert.equal(fetchImpl.aanroepen.length, 0);
});

test('M21d. `rules/branches` is BEGRENSD gepagineerd (V20, scope-item 6): pagina 2 telt mee, '
  + 'en een AFGEKAPTE laatste pagina is nooit stilzwijgend volledig bewijs', () => {
  // De workflow levert `merge-queue-rules.json` sinds V20 als array-VAN-PAGINA'S, dezelfde vorm als
  // de vijf bewijslijsten en de check-runs (`gh_bounded_pages`). Een regel op de TWEEDE pagina moet
  // hier evengoed het merge-queue-bewijs leveren — dat bewijst dat `flattenPages` echt wordt
  // toegepast, en niet alleen de eerste pagina wordt gelezen.
  const tweedeePaginaRegel = beslis({
    mergeQueueRules: [[{ type: 'pull_request' }], meting().mergeQueueRules],
  }, POLICY_QUEUE);
  assert.equal(tweedeePaginaRegel.decision, FINALIZE_DECISION.GO);
  assert.deepEqual(tweedeePaginaRegel.reasons, []);

  // Een volle laatste toegestane pagina levert exitcode 2 van `gh_bounded_pages` op, en de workflow
  // schrijft dan `merge-queue-rules-complete=false`. Ook als de al opgehaalde pagina('s) toevallig al
  // de VOLLEDIGE atomaire voorwaarde (merge_queue + required_status_checks) bevatten, is dat GEEN
  // volledig bewijs: er kan op de níét-opgehaalde pagina een regel staan die de rest van de
  // conjunctie (V20, scope-item 3) had moeten breken, of — in de andere richting — de afwezigheid
  // van bewijs mag nooit stilzwijgend als "compleet en leeg" gelden. Fail-closed: dit moet NO_GO
  // zijn, ondanks een reeds gevonden en op zichzelf voldoende regelset.
  const afgekaptMaarGevonden = beslis({
    mergeQueueRules: [meting().mergeQueueRules],
    mergeQueueRulesComplete: false,
  }, POLICY_QUEUE);
  assert.equal(afgekaptMaarGevonden.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(afgekaptMaarGevonden.reasons.includes(FINALIZE_REASON.MERGE_QUEUE_RULES_INCOMPLETE));

  // Dezelfde afkapping zonder gevonden regel draagt BEIDE redenen — cumulatief, niet alleen de
  // eerste tegenstem.
  const afgekaptEnLeeg = beslis(
    { mergeQueueRules: [[]], mergeQueueRulesComplete: false }, POLICY_QUEUE,
  );
  assert.equal(afgekaptEnLeeg.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(afgekaptEnLeeg.reasons.includes(FINALIZE_REASON.MERGE_QUEUE_RULES_INCOMPLETE));
  assert.ok(afgekaptEnLeeg.reasons.includes(FINALIZE_REASON.SERVER_MERGE_QUEUE_PROOF_MISSING));

  // Een VOLLEDIGE meting met de regel op de enige pagina blijft ongewijzigd GO — de nieuwe vlag voegt
  // een grond toe, ze vervangt de oude toets niet.
  assert.equal(
    beslis({ mergeQueueRulesComplete: true }, POLICY_QUEUE).decision, FINALIZE_DECISION.GO,
  );

  // De afkappingsvlag zit in de vingerafdruk: kapt meting B af waar A dat niet deed, dan is dat
  // MEASUREMENT_DRIFT, geen stille doorgang naar een merge op onvolledig bewijs.
  const gedreven = meting({ mergeQueueRulesComplete: false });
  assert.notEqual(measurementFingerprint(meting()), measurementFingerprint(gedreven));
});

test('M21e. de atomaire inschrijvingsvoorwaarde (V20, scope-item 3/5) eist mergemethode ÉN de '
  + 'gepinde CHECK-APP tegelijk — elke afwijkende regel heeft haar eigen gesloten reden', () => {
  // Een `merge_queue`-regel met een ANDERE methode dan de policy (`squash`/`SQUASH`) is geen
  // bevestiging van de queue-inschrijving, ook al staat de regel er wel.
  const verkeerdeMethode = beslis({
    mergeQueueRules: [
      { type: 'merge_queue', parameters: { merge_method: 'REBASE' } },
      meting().mergeQueueRules[2],
    ],
  }, POLICY_QUEUE);
  assert.equal(verkeerdeMethode.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(verkeerdeMethode.reasons.includes(FINALIZE_REASON.MERGE_QUEUE_METHOD_MISMATCH));

  // Geen enkele `required_status_checks`-regel op de branch: de vereiste check hangt dan aan NIETS.
  const geenRequiredChecksRegel = beslis(
    { mergeQueueRules: [meting().mergeQueueRules[0]] }, POLICY_QUEUE,
  );
  assert.equal(geenRequiredChecksRegel.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(
    geenRequiredChecksRegel.reasons.includes(FINALIZE_REASON.REQUIRED_STATUS_CHECKS_RULE_MISSING),
  );

  // Een `required_status_checks`-regel die de vereiste CONTEXT niet noemt — de regel bestaat, maar
  // dekt niet de check waar de finalizer op leunt.
  const contextOntbreekt = beslis({
    mergeQueueRules: [
      meting().mergeQueueRules[0],
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'een-andere-check', integration_id: 15368 }] },
      },
    ],
  }, POLICY_QUEUE);
  assert.equal(contextOntbreekt.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(
    contextOntbreekt.reasons.includes(FINALIZE_REASON.REQUIRED_STATUS_CHECKS_CONTEXT_MISSING),
  );

  // De context is er, maar de `integration_id` wijst naar een ANDERE producent-app dan de gepinde
  // `required_check_app_id` (15368, empirisch gemeten op de echte repository) — precies het lek dat
  // scope-item 5 dicht: een naamgelijke check van een niet-vertrouwde app mag niet meetellen.
  const verkeerdeApp = beslis({
    mergeQueueRules: [
      meting().mergeQueueRules[0],
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: CHECK, integration_id: 999999 }] },
      },
    ],
  }, POLICY_QUEUE);
  assert.equal(verkeerdeApp.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(verkeerdeApp.reasons.includes(FINALIZE_REASON.REQUIRED_CHECK_APP_ID_MISMATCH));

  // De volledige, correcte conjunctie blijft ongewijzigd GO — deze toets voegt gronden toe, ze
  // verzwaart de bestaande GO-baan niet.
  assert.equal(beslis({}, POLICY_QUEUE).decision, FINALIZE_DECISION.GO);
});

test('M21f. de merge-group-poort (V21, Gemini1 V20-bevinding HIGH #2) telt even zwaar mee in de '
  + 'atomaire inschrijvingsvoorwaarde als de shield: AFWEZIG, VERKEERD GENAAMD en '
  + 'VERKEERD-APPGEBONDEN falen elk met hun eigen gesloten reden, ondanks dat de shield-context zelf '
  + 'volledig gedekt en correct app-gebonden blijft', () => {
  // AFWEZIG: de `required_status_checks`-regel dekt alleen `CHECK`, `CHECK_MG` ontbreekt volledig —
  // exact de situatie van vandaag op de echte repository (die check-run bestaat nog niet).
  const afwezig = beslis({
    mergeQueueRules: [
      meting().mergeQueueRules[0],
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: CHECK, integration_id: 15368 }] },
      },
    ],
  }, POLICY_QUEUE);
  assert.equal(afwezig.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(afwezig.reasons.includes(FINALIZE_REASON.REQUIRED_STATUS_CHECKS_CONTEXT_MISSING));

  // VERKEERD GENAAMD: de regel draagt een context die op de merge-group-poort lijkt maar er niet
  // letterlijk mee overeenkomt — een contextnaam is geen namespace, dus dit telt als afwezig.
  const verkeerdGenaamd = beslis({
    mergeQueueRules: [
      meting().mergeQueueRules[0],
      {
        type: 'required_status_checks',
        parameters: {
          required_status_checks: [
            { context: CHECK, integration_id: 15368 },
            { context: 'autocoding-merge-group-gate-oud', integration_id: 15368 },
          ],
        },
      },
    ],
  }, POLICY_QUEUE);
  assert.equal(verkeerdGenaamd.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(verkeerdGenaamd.reasons.includes(FINALIZE_REASON.REQUIRED_STATUS_CHECKS_CONTEXT_MISSING));

  // VERKEERD-APPGEBONDEN: de context heet precies goed, maar de `integration_id` wijst naar een
  // niet-vertrouwde publiceerder — de shield-context blijft ondertussen correct gedekt.
  const verkeerdeApp = beslis({
    mergeQueueRules: [
      meting().mergeQueueRules[0],
      {
        type: 'required_status_checks',
        parameters: {
          required_status_checks: [
            { context: CHECK, integration_id: 15368 },
            { context: CHECK_MG, integration_id: 999999 },
          ],
        },
      },
    ],
  }, POLICY_QUEUE);
  assert.equal(verkeerdeApp.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(verkeerdeApp.reasons.includes(FINALIZE_REASON.REQUIRED_CHECK_APP_ID_MISMATCH));
  assert.ok(!verkeerdeApp.reasons.includes(FINALIZE_REASON.REQUIRED_STATUS_CHECKS_CONTEXT_MISSING));

  // De volledige, correcte conjunctie (beide contexten, beide op de gepinde app) blijft ongewijzigd
  // GO — deze toets voegt een grond toe, ze verzwaart de bestaande GO-baan niet.
  assert.equal(beslis({}, POLICY_QUEUE).decision, FINALIZE_DECISION.GO);
});

test(
  'MUT6. een finalizer zonder MERGEQUEUE-BEWIJSPOORT gaat rood op een lege regelset',
  async () => {
    const gemuteerd = await mutantVanDeFinalizer(
      'zonder-mergequeue-poort',
      "  if (!Array.isArray(measurement?.mergeQueueRules)) {\n"
        + '    add(FINALIZE_REASON.MERGE_QUEUE_RULES_UNREADABLE);\n'
        + '  } else {\n'
        + '    if (measurement?.mergeQueueRulesComplete !== true) {\n'
        + '      add(FINALIZE_REASON.MERGE_QUEUE_RULES_INCOMPLETE);\n'
        + '    }\n'
        + '    for (const r of evaluateServerGatePrecondition(flattenPages(measurement.mergeQueueRules), cfg)) {\n'
        + '      add(r);\n'
        + '    }\n  }',
      '  if (false) {\n    add(FINALIZE_REASON.MERGE_QUEUE_RULES_UNREADABLE);\n  }',
    );
    // Precies de stand van vandaag: de echte repository draagt geen mergequeue-regel. De mutant
    // laat dat toch een GO worden — de echte finalizer moet dat weigeren.
    const gemuteerdeUitkomst = gemuteerd.resolveFinalization({
      pullRequest: PR_A, measurement: meting({ mergeQueueRules: [] }), policy: POLICY_QUEUE,
    });
    assert.equal(gemuteerdeUitkomst.decision, FINALIZE_DECISION.GO);
    const echt = resolveFinalization({
      pullRequest: PR_A, measurement: meting({ mergeQueueRules: [] }), policy: POLICY_QUEUE,
    });
    assert.equal(echt.decision, FINALIZE_DECISION.NO_GO);
    assert.ok(echt.reasons.includes(FINALIZE_REASON.SERVER_MERGE_QUEUE_PROOF_MISSING));
  },
);

test('M22. een transportfout wordt tot één categorie gereduceerd, zonder de exceptietekst', async () => {
  const uitkomst = await mergePullRequest({
    repository: 'a/b', pullRequest: PR_A, sha: HEAD,
    mergeMethod: POLICY_QUEUE.merge_finalizer.merge_method, policy: POLICY_QUEUE, token: 'x',
    fetchImpl: async () => { throw new Error(`https://api.github.com met token geheim`); },
  });
  assert.deepEqual(uitkomst, {
    ok: false, blocked: FINALIZE_ERROR.MERGE_TRANSPORT_ERROR, requests: 1,
  });
  // Geen enkele URL, header of tokentekst in de uitkomst.
  assert.equal(JSON.stringify(uitkomst).includes('geheim'), false);

  // Zonder bruikbare `fetch` is er geen stille doorgang.
  const zonder = await mergePullRequest({
    repository: 'a/b', pullRequest: PR_A, sha: HEAD,
    mergeMethod: POLICY_QUEUE.merge_finalizer.merge_method, policy: POLICY_QUEUE, token: 'x',
    fetchImpl: 'geen functie',
  });
  assert.equal(zonder.blocked, FINALIZE_ERROR.MERGE_TRANSPORT_ERROR);
});

// --- De argumentvorm ----------------------------------------------------------------------------

test('M23. de argumentlezing is gesloten, positie-onafhankelijk en volledig verplicht', () => {
  const goed = [
    '--repository', 'a/b', '--pull-request', '74',
    '--raw', '/tmp/a', '--raw-recheck', '/tmp/b', '--policy', '/tmp/p',
  ];
  const gelezen = parseFinalizeArgs(goed);
  assert.equal(gelezen.ok, true);
  assert.equal(gelezen.pullRequest, 74);
  assert.equal(gelezen.dryRun, false);
  assert.equal(parseFinalizeArgs([...goed, '--dry-run']).dryRun, true);
  // De POSITIE van de vlag mag niets aan de rest veranderen.
  assert.equal(parseFinalizeArgs(['--dry-run', ...goed]).dryRun, true);

  const slecht = [
    ['onbekende sleutel', [...goed, '--force', 'ja']],
    ['losse waarde', [...goed, 'zomaar']],
    ['dubbele sleutel', [...goed, '--repository', 'c/d']],
    ['dubbele vlag', [...goed, '--dry-run', '--dry-run']],
    ['sleutel zonder waarde', goed.slice(0, -1)],
    ['lege waarde', ['--repository', '', ...goed.slice(2)]],
    ['waarde is zelf een sleutel', ['--repository', '--policy', ...goed.slice(2)]],
    ['nul argumenten', []],
    ['geen hermeting', goed.filter((t, i) => t !== '--raw-recheck' && goed[i - 1] !== '--raw-recheck')],
    ['zelfde map twee keer', ['--raw', '/tmp/a', '--raw-recheck', '/tmp/a', ...goed.slice(0, 4), '--policy', '/tmp/p']],
    ['pr-nummer geen getal', ['--pull-request', 'vier', ...goed.slice(0, 2), ...goed.slice(4)]],
    ['pr-nummer nul', ['--pull-request', '0', ...goed.slice(0, 2), ...goed.slice(4)]],
    ['pr-nummer negatief', ['--pull-request', '-74', ...goed.slice(0, 2), ...goed.slice(4)]],
    ['pr-nummer met komma', ['--pull-request', '74.5', ...goed.slice(0, 2), ...goed.slice(4)]],
    ['geen array', 'string'],
  ];
  for (const [naam, argv] of slecht) {
    assert.deepEqual(
      parseFinalizeArgs(argv),
      { ok: false, error: FINALIZE_REASON.ARGUMENTS_INVALID }, naam,
    );
  }
  // De sleutelverzamelingen zijn gesloten en overlappen niet.
  assert.deepEqual([...FINALIZE_VALUE_OPTIONS].sort(), [
    '--policy', '--pull-request', '--raw', '--raw-recheck', '--repository',
  ]);
  assert.deepEqual([...FINALIZE_BOOLEAN_FLAGS], ['--dry-run']);
});

// --- De CLI-lus ---------------------------------------------------------------------------------

function schrijfMeting(m) {
  const dir = mkdtempSync(join(tmpdir(), 'finalize-meting-'));
  for (const [sleutel, bestand] of Object.entries(MEASUREMENT_FILES)) {
    writeFileSync(join(dir, bestand), JSON.stringify(m[sleutel]));
  }
  writeFileSync(join(dir, 'evidence-complete'), m.evidenceComplete === true ? 'true' : 'false');
  writeFileSync(join(dir, 'checks-complete'), m.checksComplete === true ? 'true' : 'false');
  writeFileSync(
    join(dir, 'merge-queue-rules-complete'),
    m.mergeQueueRulesComplete === true ? 'true' : 'false',
  );
  return dir;
}

function schrijfPolicy(p) {
  const dir = mkdtempSync(join(tmpdir(), 'finalize-policy-'));
  const pad = join(dir, 'policy.v1.json');
  writeFileSync(pad, JSON.stringify(p));
  return pad;
}

const lees = (pad) => readFileSync(pad, 'utf8');

/** Draait de CLI en vangt de ENE uitvoerregel op, zodat de logvorm zelf toetsbaar is. */
async function draai({
  a, b = a, p = POLICY_MANUAL, nummer = PR_A, dryRun = true, fetchImpl, nowImpl,
}) {
  const argv = [
    '--repository', 'rvanhooijdonk-png/stack-dashboard',
    '--pull-request', String(nummer),
    '--raw', schrijfMeting(a),
    '--raw-recheck', schrijfMeting(b),
    '--policy', schrijfPolicy(p),
    ...(dryRun ? ['--dry-run'] : []),
  ];
  const regels = [];
  const origineel = console.log;
  console.log = (regel) => regels.push(regel);
  let rc;
  try {
    rc = await runFinalize(argv, { readFile: lees, fetchImpl, nowImpl });
  } finally {
    console.log = origineel;
  }
  assert.equal(regels.length, 1, 'precies één uitvoerregel');
  return { rc, uitkomst: JSON.parse(regels[0]), regel: regels[0] };
}

test('M24. een bewezen GO in DRY RUN eindigt op rc 0 en nul verzoeken', async () => {
  const fetchImpl = verbodenFetch();
  const { rc, uitkomst } = await draai({ a: meting(), fetchImpl });
  assert.equal(rc, 0);
  assert.deepEqual(uitkomst, {
    decision: FINALIZE_DECISION.GO,
    reasons: [],
    finalization_class: 'A',
    effect: 'DRY_RUN',
    // V24 — elke GO-regel draagt dit veld, en alleen een WERKELIJK uitgevoerd effect zet het op
    // `true`. Een dry run niet, en een eigenaarspakket (O5) evenmin.
    merge_performed: false,
  });
  assert.equal(fetchImpl.aanroepen.length, 0);
});

test('M25. DRIFT tussen beslissing en effect levert nul verzoeken op', async () => {
  // Elke verschuiving die de vingerafdruk raakt terwijl BEIDE metingen op zichzelf GO zijn, moet
  // hier stranden: de tweede meting is niet meer dezelfde waarheid als de eerste.
  const gedreven = meting({ checkRuns: [[checkRun(), checkRun({ name: 'extra' })]] });
  const fetchImpl = verbodenFetch();
  const { rc, uitkomst } = await draai({ a: meting(), b: gedreven, dryRun: false, fetchImpl });
  assert.equal(rc, 1);
  assert.deepEqual(uitkomst, {
    decision: FINALIZE_DECISION.NO_GO, reasons: [FINALIZE_REASON.MEASUREMENT_DRIFT],
  });
  assert.equal(fetchImpl.aanroepen.length, 0);
});

test('M25a. een VERSCHOVEN head tussen de twee metingen mergt niets', async () => {
  const verschoven = meting({
    pr: { ...meting().pr, head: { sha: '4'.repeat(40) } },
    headCommit: { sha: '4'.repeat(40), tree: { sha: TREE } },
  });
  const fetchImpl = verbodenFetch();
  const { rc, uitkomst } = await draai({ a: meting(), b: verschoven, dryRun: false, fetchImpl });
  assert.equal(rc, 1);
  // De hermeting is op zichzelf al NO_GO — het bewijs hangt aan de oude head — dus komt het niet
  // eens tot de driftvergelijking. Beide poorten wijzen dezelfde kant op.
  assert.equal(uitkomst.decision, FINALIZE_DECISION.NO_GO);
  assert.equal(fetchImpl.aanroepen.length, 0);
});

test('M25b. een INGETROKKEN review tussen de twee metingen mergt niets', async () => {
  const ingetrokken = kloon(meting().reviews);
  ingetrokken[0][0].state = 'DISMISSED';
  const fetchImpl = verbodenFetch();
  const { rc, uitkomst } = await draai({
    a: meting(), b: meting({ reviews: ingetrokken }), dryRun: false, fetchImpl,
  });
  assert.equal(rc, 1);
  assert.equal(uitkomst.decision, FINALIZE_DECISION.NO_GO);
  assert.equal(fetchImpl.aanroepen.length, 0);
});

test('M26. een onleesbare of ontbrekende meting is nooit een lege meting', async () => {
  const fetchImpl = verbodenFetch();
  const goedeMeting = schrijfMeting(meting());
  const kapot = schrijfMeting(meting());
  writeFileSync(join(kapot, MEASUREMENT_FILES.reviews), '{niet eens json');

  const regels = [];
  const origineel = console.log;
  console.log = (r) => regels.push(r);
  let rc;
  try {
    rc = await runFinalize([
      '--repository', 'a/b', '--pull-request', String(PR_A),
      '--raw', goedeMeting, '--raw-recheck', kapot,
      '--policy', schrijfPolicy(POLICY_QUEUE), '--dry-run',
    ], { readFile: lees, fetchImpl });
  } finally {
    console.log = origineel;
  }
  assert.equal(rc, 1);
  assert.deepEqual(JSON.parse(regels[0]), {
    decision: FINALIZE_DECISION.NO_GO, reasons: [FINALIZE_REASON.MEASUREMENT_UNREADABLE],
  });
  assert.equal(fetchImpl.aanroepen.length, 0);

  // Ontbrekende volledigheidsvlaggen tellen als ONVOLLEDIG, niet als volledig.
  const zonderVlaggen = schrijfMeting(meting());
  writeFileSync(join(zonderVlaggen, 'evidence-complete'), 'waar');
  const gelezen = readMeasurement(zonderVlaggen, lees);
  assert.equal(gelezen.evidenceComplete, false);
});

test('M27. zonder geldige argumenten gebeurt er niets, ook geen bestandslezing', async () => {
  const fetchImpl = verbodenFetch();
  const regels = [];
  const origineel = console.log;
  console.log = (r) => regels.push(r);
  let rc;
  try {
    rc = await runFinalize(['--repository', 'a/b'], {
      readFile: () => { throw new Error('er mag hier niets gelezen worden'); },
      fetchImpl,
    });
  } finally {
    console.log = origineel;
  }
  assert.equal(rc, 1);
  assert.deepEqual(JSON.parse(regels[0]), {
    decision: FINALIZE_DECISION.NO_GO, reasons: [FINALIZE_REASON.ARGUMENTS_INVALID],
  });
  assert.equal(fetchImpl.aanroepen.length, 0);
});

test('M28. met de vlaggen UIT gaat ELKE echte effectpoging rood vóór het transport', async () => {
  // Dit is de stand van deze PR: het policybestand zoals het in de repository staat.
  const fetchImpl = verbodenFetch();
  const { rc, uitkomst } = await draai({
    a: meting(), p: POLICY_BESTAND, dryRun: false, fetchImpl,
  });
  assert.equal(rc, 1);
  assert.equal(uitkomst.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(uitkomst.reasons.includes(FINALIZE_REASON.FINALIZER_DISABLED));
  assert.equal(fetchImpl.aanroepen.length, 0);

  // Ook de dry run komt niet verder dan de beslissing, en meldt geen GO.
  const droog = await draai({ a: meting(), p: POLICY_BESTAND, dryRun: true, fetchImpl });
  assert.equal(droog.rc, 1);
  assert.equal(droog.uitkomst.decision, FINALIZE_DECISION.NO_GO);
  assert.equal(fetchImpl.aanroepen.length, 0);
});

test('M29. bij een GEACTIVEERDE finalizer draagt de merge de sha van de HERMETING', async () => {
  const fetchImpl = antwoordFetch(200);
  const { rc, uitkomst } = await draai({
    a: meting(), p: POLICY_QUEUE, dryRun: false, fetchImpl,
  });
  assert.equal(rc, 0);
  assert.deepEqual(uitkomst, {
    decision: FINALIZE_DECISION.GO,
    reasons: [],
    finalization_class: 'A',
    effect: 'MERGE_QUEUED',
    // De enige uitkomst in dit hele bestand waar dit veld `true` is: er is werkelijk een verzoek
    // gedaan en aanvaard.
    merge_performed: true,
  });
  assert.equal(fetchImpl.aanroepen.length, 1);
  const body = JSON.parse(fetchImpl.aanroepen[0].init.body);
  assert.equal(body.sha, HEAD);
  assert.equal(body.merge_action, 'merge_queue');
  assert.ok(fetchImpl.aanroepen[0].url.endsWith(`/pulls/${PR_A}/merge-async`));
});

test('M30. de uitvoerregel draagt uitsluitend gesloten codes — geen sha, pad of API-tekst', async () => {
  const gevallen = [
    await draai({ a: meting() }),
    await draai({ a: meting(), nummer: PR_B }),
    await draai({ a: meting(), p: POLICY_BESTAND }),
    await draai({ a: meting(), b: meting({ checksComplete: false }) }),
  ];
  const toegestaan = new Set([
    ...Object.values(FINALIZE_REASON), ...Object.values(FINALIZE_ERROR), ...Object.values(REASON),
  ]);
  for (const { regel, uitkomst } of gevallen) {
    assert.equal(/[0-9a-f]{40}/.test(regel), false, regel);
    assert.equal(regel.includes('/tmp'), false, regel);
    assert.equal(regel.includes(TASK), false, regel);
    assert.ok([FINALIZE_DECISION.GO, FINALIZE_DECISION.NO_GO].includes(uitkomst.decision));
    for (const reden of uitkomst.reasons) assert.ok(toegestaan.has(reden), reden);
  }
});

// --- Mutanten -----------------------------------------------------------------------------------

/**
 * Laadt de ECHTE finalizer met één gewijzigd fragment. Dezelfde vorm als `mutantVanDePublisher` in
 * de statustest: de mutant leeft buiten de repository, dus worden zijn relatieve imports absoluut.
 */
function mutantVanDeFinalizer(naam, oud, nieuw, opties = {}) {
  const bron = readFileSync(FINALIZER, 'utf8');
  // V24: een mutant mag uit MEER dan één vervanging bestaan. Dat is nodig om te toetsen wat er
  // gebeurt als iemand een verdediging niet half maar heel terugdraait (MUT7b: de weigering weg én
  // de verworpen stand terug). Elk anker blijft afzonderlijk uniek — een anker dat twee of nul keer
  // voorkomt zou een mutant opleveren die iets anders muteert dan de test beweert.
  const vervangingen = [[oud, nieuw], ...(opties.extra ?? [])];
  const dir = mkdtempSync(join(tmpdir(), `finalize-merge-${naam}-`));
  const pad = join(dir, `finalize-merge.${naam}.mjs`);
  let tekst = bron;
  for (const [van, naartoe] of vervangingen) {
    assert.equal(tekst.split(van).length - 1, 1, 'het mutatieanker moet precies één keer voorkomen');
    tekst = tekst.replace(van, naartoe);
  }
  for (const buur of [
    'verify-review-gate.mjs', 'collect-shield-input.mjs', 'select-live-gate-targets.mjs',
  ]) {
    tekst = tekst.replace(
      `from './${buur}'`,
      `from ${JSON.stringify(pathToFileURL(`scripts/autocoding/${buur}`).href)}`,
    );
  }
  writeFileSync(pad, tekst);
  return import(pathToFileURL(pad).href);
}

test('MUT1. een merge-aanroep ZONDER `sha` in het lichaam gaat rood', async () => {
  const gemuteerd = await mutantVanDeFinalizer(
    'zonder-sha',
    "body: JSON.stringify({ sha, merge_method: mergeMethod, merge_action: 'merge_queue' }),",
    "body: JSON.stringify({ merge_method: mergeMethod, merge_action: 'merge_queue' }),",
  );
  const fetchImpl = antwoordFetch(200);
  await gemuteerd.mergePullRequest({
    repository: 'a/b', pullRequest: PR_A, sha: HEAD,
    mergeMethod: POLICY_QUEUE.merge_finalizer.merge_method, policy: POLICY_QUEUE, token: 'x', fetchImpl,
  });
  // De mutant komt door al zijn eigen poorten heen en doet een merge zonder sha-conditie — precies
  // de aanroep die de HUIDIGE head zou mergen, wat die ook is. De toets uit M20 moet daarop breken.
  const body = JSON.parse(fetchImpl.aanroepen[0].init.body);
  assert.throws(() => assert.equal(body.sha, HEAD), /AssertionError/);
  assert.throws(
    () => assert.deepEqual(Object.keys(body).sort(), ['merge_action', 'merge_method', 'sha']),
    /AssertionError/,
  );
});

test('MUT2. een finalizer die de PR-BINDING laat vallen, gaat rood op PR B', async () => {
  const gemuteerd = await mutantVanDeFinalizer(
    'zonder-pr-binding',
    '  if (gevraagd === 0 || gemeten === 0 || gevraagd !== gemeten) {\n'
      + '    add(FINALIZE_REASON.PULL_REQUEST_MISMATCH);\n  }',
    '  if (false) {\n    add(FINALIZE_REASON.PULL_REQUEST_MISMATCH);\n  }',
  );
  // Met de binding weg draagt de meting van PR A de finalisatie van PR B: exact de overdraagbaarheid
  // die V18 moet uitsluiten. De toets uit M5 breekt daarop.
  const uitkomst = gemuteerd.resolveFinalization({
    pullRequest: PR_B, measurement: meting(), policy: POLICY_QUEUE,
  });
  assert.throws(
    () => assert.ok(uitkomst.reasons.includes(FINALIZE_REASON.PULL_REQUEST_MISMATCH)),
    /AssertionError/,
  );
  // En de mutant zou werkelijk een merge-aanroep op het VERKEERDE PR-nummer opleveren.
  assert.equal(uitkomst.decision, FINALIZE_DECISION.GO);
  assert.equal(uitkomst.merge.pull_request, PR_A);
});

test('MUT3. een finalizer die de OWNERBINDING niet eist, gaat rood op de mergeautorisatie', async () => {
  // De mutant vervangt de MERGEpoort door de gewone ownerpoort: zelfde wet, maar zonder de eis dat
  // het blok aan dit PR-nummer en deze base bindt.
  const gemuteerd = await mutantVanDeFinalizer(
    'losse-ownergate',
    "import { evaluateShield, evaluateMergeAuthorizations } from './verify-review-gate.mjs';",
    "import { evaluateShield, evaluateOwnerApprovals as evaluateMergeAuthorizations }"
      + " from './verify-review-gate.mjs';",
  );
  // PR B met een autorisatie die alleen aan task/head/tree bindt: precies het blok dat op ELKE pull
  // request met dezelfde boom zou passen. De echte finalizer weigert het (M6/M13), de mutant niet.
  const bMeting = meting({
    pr: { ...meting().pr, number: PR_B },
    issueComments: issueCommentsMet(ownerBlok({ pull_request: undefined, base_sha: undefined })),
  });
  const uitkomst = gemuteerd.resolveFinalization({
    pullRequest: PR_B, measurement: bMeting, policy: POLICY_QUEUE,
  });
  assert.equal(uitkomst.decision, FINALIZE_DECISION.GO);
  const echt = resolveFinalization({ pullRequest: PR_B, measurement: bMeting, policy: POLICY_QUEUE });
  assert.equal(echt.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(echt.reasons.includes(REASON.OWNER_APPROVAL_BINDING_INCOMPLETE));
});

test('MUT4. een finalizer zonder DRIFTVERGELIJKING gaat rood op de hermeting', async () => {
  const gemuteerd = await mutantVanDeFinalizer(
    'zonder-drift',
    'if (measurementFingerprint(metingA) !== measurementFingerprint(metingB)) {',
    'if (false) {',
  );
  const gedreven = meting({ checkRuns: [[checkRun(), checkRun({ name: 'extra' })]] });
  const fetchImpl = antwoordFetch(200);
  const origineel = console.log;
  console.log = () => {};
  let rc;
  try {
    rc = await gemuteerd.runFinalize([
      '--repository', 'a/b', '--pull-request', String(PR_A),
      '--raw', schrijfMeting(meting()), '--raw-recheck', schrijfMeting(gedreven),
      '--policy', schrijfPolicy(POLICY_QUEUE),
    ], { readFile: lees, fetchImpl });
  } finally {
    console.log = origineel;
  }
  // De mutant merget ondanks een verschoven meting. M25 eist nul verzoeken; die toets breekt hier.
  assert.equal(rc, 0);
  assert.equal(fetchImpl.aanroepen.length, 1);
  assert.throws(() => assert.equal(fetchImpl.aanroepen.length, 0), /AssertionError/);
});

test('MUT5. een finalizer die de VLAG negeert, gaat rood op nul verzoeken', async () => {
  const gemuteerd = await mutantVanDeFinalizer(
    'zonder-vlag',
    "  if (policy?.merge_finalizer_enabled !== true) {\n"
      + '    return { ok: false, blocked: FINALIZE_ERROR.FINALIZER_DISABLED, requests: 0 };\n  }',
    '  if (false) {\n'
      + '    return { ok: false, blocked: FINALIZE_ERROR.FINALIZER_DISABLED, requests: 0 };\n  }',
  );
  // Deze mutant meet de VLAG, niet de tak — en dus wordt hij op de enige tak gemeten die werkelijk
  // een verzoek doet: de wachtrij. Het bestandspolicy staat sinds V24 in `MANUAL_OWNER_GATE` en doet
  // ook zónder vlag nul verzoeken (O4), zodat die stand hier niets over de vlag zou bewijzen.
  const fetchImpl = antwoordFetch(202);
  const uitAan = { ...POLICY_QUEUE, merge_finalizer_enabled: false };
  const uitkomst = await gemuteerd.mergePullRequest({
    repository: 'a/b', pullRequest: PR_A, sha: HEAD,
    mergeMethod: uitAan.merge_finalizer.merge_method, policy: uitAan,
    token: 'x', fetchImpl,
  });
  assert.equal(uitkomst.ok, true);
  assert.equal(fetchImpl.aanroepen.length, 1);
  // M18 eist precies het omgekeerde op een policy met de vlag uit.
  assert.throws(() => assert.equal(fetchImpl.aanroepen.length, 0), /AssertionError/);
  const echt = await mergePullRequest({
    repository: 'a/b', pullRequest: PR_A, sha: HEAD,
    mergeMethod: uitAan.merge_finalizer.merge_method, policy: uitAan, token: 'x', fetchImpl,
  });
  assert.deepEqual(echt, { ok: false, blocked: FINALIZE_ERROR.FINALIZER_DISABLED, requests: 0 });
});

// --- De eigenaarsstand `MANUAL_OWNER_GATE` (V24) -------------------------------------------------

/**
 * De regelset zoals `rules/branches/main` hem op DIT repository vandaag werkelijk oplevert: LEEG.
 * Ruleset 21205251 staat `disabled`, en dat eindpunt geeft uitsluitend ACTIEVE regels terug — een
 * uitgezette ruleset staat er domweg niet in, en is hier dus geen lijst met een uit-vlag maar een
 * lege lijst.
 *
 * Elke test in deze reeks meet op die stand. Dat is het hele punt van V24: de eigenaarsstand moet
 * werken op het object zoals het IS, niet op een ruleset die er niet staat. Wat de vorige stand
 * (`STRICT_STATUS_CHECKS`) op precies deze meting deed — eeuwig NO_GO, of erger: mergen op bewijs dat
 * GitHub niet afdwingt — is nu onbereikbaar (O1, O2).
 */
function eigenaarsMeting(overrides = {}) {
  return meting({ mergeQueueRules: [], ...overrides });
}

test('O1. `STRICT_STATUS_CHECKS` is een GEWEIGERDE stand: geen oordeel, geen verzoek, nooit '
  + 'een merge', async () => {
  // De kern van de V24-reparatie. Codex1-P1 op V23: een strikte required-status-checks-regel dwingt
  // serverkant alleen een up-to-date branch en groene VEREISTE CONTEXTEN af — nooit ons eigen
  // reviewbewijs of het ownercomment. Dat bewijs kan tussen meting B en de merge-PUT verdwijnen
  // zonder dat de head-sha of de check verandert, en de PUT slaagt dan alsnog. De stand is daarom
  // niet verzwaard maar VERWORPEN.
  assert.deepEqual(Object.values(SERVER_GATE_MODE).sort(), ['MANUAL_OWNER_GATE', 'MERGE_QUEUE']);
  assert.deepEqual(Object.values(REJECTED_SERVER_GATE_MODE), ['STRICT_STATUS_CHECKS']);
  // De twee verzamelingen mogen elkaar nooit raken: een stand die tegelijk toegestaan en geweigerd
  // is, zou de volgorde van twee toetsen tot een veiligheidseigenschap maken.
  for (const geweigerd of Object.values(REJECTED_SERVER_GATE_MODE)) {
    assert.equal(Object.values(SERVER_GATE_MODE).includes(geweigerd), false, geweigerd);
  }

  // 1. de policy komt niet langs de validatie...
  assert.throws(() => assertMergeFinalizerPolicySafe(POLICY_GEWEIGERD), /FINALIZER_POLICY_UNSAFE/);
  // 2. ...dus komt er geen oordeel, ook niet op een meting die ALLES draagt wat V23 vroeg (een
  //    actieve pull-request-regel én een strikte, app-gebonden required-status-checks-regel).
  assert.deepEqual(
    resolveFinalization({ pullRequest: PR_A, measurement: meting(), policy: POLICY_GEWEIGERD }),
    { decision: FINALIZE_DECISION.NO_GO, reasons: [FINALIZE_REASON.FINALIZER_POLICY_UNSAFE] },
  );
  // 3. ...en geen effect: nul verzoeken, met de vlag AAN en elk argument exact.
  const fetchImpl = verbodenFetch();
  const effect = await mergePullRequest({
    repository: 'rvanhooijdonk-png/stack-dashboard', pullRequest: PR_A, sha: HEAD,
    mergeMethod: 'squash', policy: POLICY_GEWEIGERD, token: 'geheim', fetchImpl,
  });
  assert.deepEqual(effect, {
    ok: false, blocked: FINALIZE_REASON.FINALIZER_POLICY_UNSAFE, requests: 0,
  });
  assert.equal(fetchImpl.aanroepen.length, 0);
  // 4. ...en ook niet via de CLI, met een bewezen GO-meting en zonder dry run.
  const { rc, uitkomst } = await draai({
    a: meting(), p: POLICY_GEWEIGERD, dryRun: false, fetchImpl,
  });
  assert.equal(rc, 1);
  assert.deepEqual(uitkomst, {
    decision: FINALIZE_DECISION.NO_GO, reasons: [FINALIZE_REASON.FINALIZER_POLICY_UNSAFE],
  });
  assert.equal(fetchImpl.aanroepen.length, 0);

  // En de modus blijft een GESLOTEN keuze: onbekend, leeg, ontbrekend of net-anders-geschreven is
  // even onveilig als de verworpen stand zelf. Er is nergens een default.
  for (const stand of [
    undefined, '', 'STRICT', 'strict_status_checks', 'DIRECT_MERGE', 'MANUAL', 15368,
  ]) {
    const gebrekkig = policy({ merge_finalizer_enabled: true }, { server_gate_mode: stand });
    assert.throws(
      () => assertMergeFinalizerPolicySafe(gebrekkig),
      /FINALIZER_POLICY_UNSAFE/,
      JSON.stringify(stand),
    );
    assert.deepEqual(
      resolveFinalization({ pullRequest: PR_A, measurement: meting(), policy: gebrekkig }),
      { decision: FINALIZE_DECISION.NO_GO, reasons: [FINALIZE_REASON.FINALIZER_POLICY_UNSAFE] },
      JSON.stringify(stand),
    );
  }
});

test('O2. de KLASSIEKE merge-aanroep bestaat niet meer in de bron — er is geen pad meer heen', () => {
  const bron = readFileSync(FINALIZER, 'utf8');

  // ELKE letterlijke GitHub-URL in dit bestand, zonder uitzondering. `PUT .../pulls/{n}/merge` is de
  // aanroep die V19 sloot en die V23 terugbracht; hij hoort hier niet meer te staan, en deze toets
  // leest dat niet af aan een afwezig fragment maar aan de VOLLEDIGE verzameling.
  const urls = new Set([...bron.matchAll(/https:\/\/api\.github\.com\/[^`]*/g)].map((m) => m[0]));
  assert.deepEqual([...urls].sort(), [
    'https://api.github.com/repos/${repository}/pulls/${pullRequest}/merge-async',
    'https://api.github.com/repos/${repository}/pulls/${pullRequest}/merge-async/${uuid}',
  ]);

  // De foutcodes van die aanroep zijn met hem meegegaan. Een code die geen enkel pad meer kan zetten
  // is geen reserve maar een valse belofte in een log dat gesloten hoort te zijn.
  for (const dood of [
    'MERGE_HEAD_MISMATCH', 'MERGE_RESULT_NOT_MERGED',
    'SERVER_STRICT_RULESET_PROOF_MISSING', 'PULL_REQUEST_RULE_MISSING',
    'PULL_REQUEST_MERGE_METHOD_NOT_ALLOWED', 'STRICT_STATUS_CHECKS_POLICY_DISABLED',
  ]) {
    assert.equal(Object.hasOwn(FINALIZE_ERROR, dood), false, dood);
    assert.equal(Object.hasOwn(FINALIZE_REASON, dood), false, dood);
  }
  // En het effect dat erbij hoorde bestaat evenmin: `MERGED` was de naam van een merge die dit
  // bestand zelf uitvoerde.
  assert.equal(bron.includes("effect: 'MERGED'"), false);
});

test('O3. de eigenaarsstand draagt GO op de stand van VANDAAG — een LEGE regelset', () => {
  // Precies de meting waarop `STRICT_STATUS_CHECKS` eeuwig strandde: ruleset 21205251 staat uit, dus
  // `rules/branches` levert niets. De eigenaarsstand stelt daar geen rulesetEIS tegenover, want zij
  // doet geen enkel verzoek dat een serverpoort zou moeten bewaken — de laatste handeling is die van
  // de eigenaar, in GitHubs eigen interface.
  const uitkomst = resolveFinalization({
    pullRequest: PR_A, measurement: eigenaarsMeting(), policy: POLICY_MANUAL,
  });
  assert.deepEqual(uitkomst, {
    decision: FINALIZE_DECISION.GO,
    reasons: [],
    finalization_class: 'A',
    merge: {
      pull_request: PR_A,
      sha: HEAD,
      merge_method: 'squash',
      server_gate_mode: 'MANUAL_OWNER_GATE',
    },
  });

  // DEZELFDE meting in de dormante legacy-modus is NO_GO: daar is de wachtrijregel de dragende
  // voorwaarde, en die bestaat op een persoonlijk repository niet. De twee standen delen dus geen
  // enkele bewijsgrond — de nieuwe leunt nergens op het wachtrijspoor, en de oude wordt door de
  // nieuwe niet verzwakt.
  const inWachtrijmodus = resolveFinalization({
    pullRequest: PR_A, measurement: eigenaarsMeting(), policy: POLICY_QUEUE,
  });
  assert.equal(inWachtrijmodus.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(inWachtrijmodus.reasons.includes(FINALIZE_REASON.SERVER_MERGE_QUEUE_PROOF_MISSING));
  assert.ok(inWachtrijmodus.reasons.includes(FINALIZE_REASON.REQUIRED_STATUS_CHECKS_RULE_MISSING));
});

test('O4. het EFFECT van de eigenaarsstand is mechanisch NUL mergeverzoeken', async () => {
  const fetchImpl = verbodenFetch();
  const uitkomst = await mergePullRequest({
    repository: 'rvanhooijdonk-png/stack-dashboard', pullRequest: PR_A, sha: HEAD,
    mergeMethod: 'squash', policy: POLICY_MANUAL, token: 'geheim', fetchImpl,
  });
  // Geen `ok`, en toch geen mislukking: dit is de terminale uitkomst van deze stand.
  assert.deepEqual(uitkomst, {
    ok: false, blocked: FINALIZE_ERROR.OWNER_MERGE_REQUIRED, requests: 0,
  });
  assert.equal(fetchImpl.aanroepen.length, 0);

  // De uitkomst hangt van GEEN ENKELE omgevingsfactor af. Zonder `fetchImpl` valt deze functie
  // normaal terug op `globalThis.fetch`; in deze stand keert ze terug vóór ze daar überhaupt naar
  // kijkt. Een `fetch` die bij aanroep ontploft bewijst dat verschil.
  const echteFetch = globalThis.fetch;
  let aangeraakt = 0;
  globalThis.fetch = () => { aangeraakt += 1; throw new Error('verboden'); };
  try {
    assert.deepEqual(
      await mergePullRequest({
        repository: 'a/b', pullRequest: PR_A, sha: HEAD, mergeMethod: 'squash',
        policy: POLICY_MANUAL, token: 'geheim',
      }),
      { ok: false, blocked: FINALIZE_ERROR.OWNER_MERGE_REQUIRED, requests: 0 },
    );
  } finally {
    globalThis.fetch = echteFetch;
  }
  assert.equal(aangeraakt, 0);

  // Ook met de twee ANDERE vlaggen aan blijft het nul: geen enkele vlag opent in deze stand een
  // verzoek, want er is geen verzoek om te openen.
  const allesAan = policy(
    {
      merge_finalizer_enabled: true,
      class_b_auto_merge_enabled: true,
      live_receipt_gate_enabled: true,
    },
  );
  assert.deepEqual(
    await mergePullRequest({
      repository: 'a/b', pullRequest: PR_A, sha: HEAD, mergeMethod: 'squash',
      policy: allesAan, token: 'geheim', fetchImpl,
    }),
    { ok: false, blocked: FINALIZE_ERROR.OWNER_MERGE_REQUIRED, requests: 0 },
  );
  assert.equal(fetchImpl.aanroepen.length, 0);

  // En de VLAG blijft de eerste poort: met `merge_finalizer_enabled: false` — de stand van het
  // bestand — is de code `FINALIZER_DISABLED` en niet `OWNER_MERGE_REQUIRED`. De volgorde van die
  // twee is geen detail: zij zegt dat de finalizer uitstaat, niet dat hij een pakket klaarlegt.
  assert.deepEqual(
    await mergePullRequest({
      repository: 'a/b', pullRequest: PR_A, sha: HEAD, mergeMethod: 'squash',
      policy: POLICY_BESTAND, token: 'geheim', fetchImpl,
    }),
    { ok: false, blocked: FINALIZE_ERROR.FINALIZER_DISABLED, requests: 0 },
  );
  assert.equal(fetchImpl.aanroepen.length, 0);
});

test('O5. de CLI levert in de eigenaarsstand een GEBONDEN MERGEPAKKET op, en nooit een merge '
  + '(V25 — CODEX1/GEMINI1-P1 F330314)', async () => {
  const fetchImpl = verbodenFetch();
  const KLOK = 1_700_000_000_000;
  const { rc, uitkomst } = await draai({
    a: eigenaarsMeting(), p: POLICY_MANUAL, dryRun: false, fetchImpl, nowImpl: () => KLOK,
  });
  // rc is NIET 0: dat is voorbehouden aan een werkelijk uitgevoerd effect. Een rc-only aanroeper met
  // het normale contract `rc 0 => finalisatie geslaagd` leest deze uitkomst dus mechanisch NIET als
  // merge — precies de reparatie van F330314.
  assert.equal(rc, OWNER_ACTION_REQUIRED_EXIT_CODE);
  assert.notEqual(rc, 0);
  // En de decision is evenmin `GO`: een pakket is een aflevering, geen oordeel.
  assert.equal(uitkomst.decision, FINALIZE_DECISION.OWNER_ACTION_REQUIRED);
  assert.notEqual(uitkomst.decision, FINALIZE_DECISION.GO);
  assert.equal(uitkomst.reasons.length, 0);
  assert.equal(uitkomst.finalization_class, 'A');
  assert.equal(uitkomst.effect, 'OWNER_MERGE_PACKAGE');
  assert.equal(uitkomst.merge_performed, false);
  assert.equal(uitkomst.owner_action, 'OWNER_MERGE_REQUIRED');
  assert.equal(fetchImpl.aanroepen.length, 0);

  // Het pakket is EXACT de binding die `buildOwnerMergePackage` op dezelfde ruwe waarden zou leveren —
  // uitsluitend digests, het PR-nummer en de mergemethode, plus de meettijd van de geïnjecteerde klok.
  const verwacht = buildOwnerMergePackage({
    repository: 'rvanhooijdonk-png/stack-dashboard',
    pullRequest: PR_A,
    sha: HEAD,
    treeSha: TREE,
    baseRef: 'main',
    baseHeadSha: BASE_HEAD,
    mergeMethod: 'squash',
    measurementFingerprint: measurementFingerprint(eigenaarsMeting()),
    measuredAtMs: KLOK,
  });
  assert.deepEqual(uitkomst.owner_package, verwacht);
  assert.deepEqual(Object.keys(uitkomst.owner_package).sort(), [...OWNER_MERGE_PACKAGE_FIELDS].sort());
  assert.equal(uitkomst.owner_package.measured_at, KLOK);
  assert.equal(uitkomst.owner_package.pull_request, PR_A);
  assert.equal(uitkomst.owner_package.merge_method, 'squash');

  // Het pakket draagt geen sha, geen pad en geen API-tekst — dezelfde reductie als elke andere
  // uitvoerregel (M30): uitsluitend sha256-digests (64 hex-tekens), nooit een sha (40).
  const { regel } = await draai({
    a: eigenaarsMeting(), p: POLICY_MANUAL, dryRun: false, fetchImpl, nowImpl: () => KLOK,
  });
  assert.equal(/(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/.test(regel), false, regel);
  assert.equal(regel.includes('/tmp'), false, regel);

  // Een pakket bestaat ALLEEN na een bewezen GO op beide metingen. Drift, een ingetrokken review of
  // een uitgezette vlag leveren geen pakket maar een NO_GO — anders zou "pakket" niets betekenen.
  const gedreven = await draai({
    a: eigenaarsMeting(),
    b: eigenaarsMeting({ checkRuns: [[checkRun({ conclusion: 'failure' })]] }),
    p: POLICY_MANUAL,
    dryRun: false,
    fetchImpl,
  });
  assert.equal(gedreven.rc, 1);
  assert.equal(gedreven.uitkomst.decision, FINALIZE_DECISION.NO_GO);
  assert.equal(gedreven.uitkomst.effect, undefined);
  assert.equal(gedreven.uitkomst.owner_package, undefined);

  const uit = await draai({
    a: eigenaarsMeting(), p: POLICY_BESTAND, dryRun: false, fetchImpl,
  });
  assert.equal(uit.rc, 1);
  assert.ok(uit.uitkomst.reasons.includes(FINALIZE_REASON.FINALIZER_DISABLED));
  assert.equal(uit.uitkomst.effect, undefined);
  assert.equal(fetchImpl.aanroepen.length, 0);
});

test('O5a. RC-ONLY-AANROEPER-REGRESSIE: het normale contract `rc 0 => finalisatie geslaagd` leest '
  + 'het eigenaarspakket nooit meer als merge', async () => {
  // De letterlijke reproductie van de bevinding: een aanroeper die UITSLUITEND de exitcode leest en
  // geen `merge_performed` parseert. Vóór V25 zou dit `merge_performed=true` opleveren op rc 0, wat
  // hier de kern van de regressie is.
  const rcOnlyLeestAlsMerge = (rc) => rc === 0;

  const pakket = await draai({ a: eigenaarsMeting(), p: POLICY_MANUAL, dryRun: false });
  assert.equal(rcOnlyLeestAlsMerge(pakket.rc), false, 'een rc-only-aanroeper leest dit niet als merge');
  assert.equal(pakket.uitkomst.merge_performed, false);

  const echteQueueMerge = await draai({
    a: meting(), p: POLICY_QUEUE, dryRun: false, fetchImpl: antwoordFetch(202),
  });
  assert.equal(rcOnlyLeestAlsMerge(echteQueueMerge.rc), true, 'een werkelijk effect blijft rc 0');
  assert.equal(echteQueueMerge.uitkomst.merge_performed, true);

  // rc 3 valt bovendien buiten ELK generiek tweewaardig contract (`0` succes, niet-`0` fout): het is
  // geen `1` — de gewone weigering — en het is nooit `0`.
  assert.notEqual(pakket.rc, 0);
  assert.notEqual(pakket.rc, 1);
});

const GELDIGE_PAKKET_VELDEN = Object.freeze({
  repository: 'rvanhooijdonk-png/stack-dashboard',
  pullRequest: PR_A,
  sha: HEAD,
  treeSha: TREE,
  baseRef: 'main',
  baseHeadSha: BASE_HEAD,
  mergeMethod: 'squash',
  measurementFingerprint: measurementFingerprint(eigenaarsMeting()),
  measuredAtMs: 1_700_000_000_000,
});

function geldigPakket(overrides = {}) {
  return buildOwnerMergePackage({ ...GELDIGE_PAKKET_VELDEN, ...overrides });
}

function verifieer(overrides = {}) {
  const { ownerPackage, ...rest } = overrides;
  return verifyOwnerMergePackage({
    ownerPackage: 'ownerPackage' in overrides ? ownerPackage : geldigPakket(),
    repository: GELDIGE_PAKKET_VELDEN.repository,
    pullRequest: GELDIGE_PAKKET_VELDEN.pullRequest,
    sha: GELDIGE_PAKKET_VELDEN.sha,
    treeSha: GELDIGE_PAKKET_VELDEN.treeSha,
    baseRef: GELDIGE_PAKKET_VELDEN.baseRef,
    baseHeadSha: GELDIGE_PAKKET_VELDEN.baseHeadSha,
    mergeMethod: GELDIGE_PAKKET_VELDEN.mergeMethod,
    measurementFingerprint: GELDIGE_PAKKET_VELDEN.measurementFingerprint,
    nowMs: GELDIGE_PAKKET_VELDEN.measuredAtMs,
    maxAgeSeconds: 86400,
    ...rest,
  });
}

test('O8. `verifyOwnerMergePackage` accepteert een vers, zelfconsistent en ongewijzigd pakket', () => {
  assert.deepEqual(verifieer(), { ok: true });
  // Precies op de vervalgrens (nowMs - measured_at === maxAgeSeconds * 1000) is nog GELDIG: de
  // vergelijking is `>`, niet `>=`.
  assert.deepEqual(
    verifieer({ nowMs: GELDIGE_PAKKET_VELDEN.measuredAtMs + 86400 * 1000 }),
    { ok: true },
  );
});

test('O9. `verifyOwnerMergePackage` wijst een ONTBREKEND pakket fail-closed af', () => {
  for (const ontbrekend of [undefined, null, [], 'niet-een-object', 42]) {
    assert.deepEqual(
      verifieer({ ownerPackage: ontbrekend }),
      { ok: false, reason: OWNER_PACKAGE_REASON.OWNER_PACKAGE_MISSING },
      JSON.stringify(ontbrekend),
    );
  }
});

test('O10. `verifyOwnerMergePackage` wijst een MISVORMD pakket fail-closed af', () => {
  const varianten = [
    { ...geldigPakket(), extra_veld: 'x' },
    (() => { const { schema, ...rest } = geldigPakket(); return rest; })(),
    { ...geldigPakket(), schema: 'ANDERE_SCHEMA_V1' },
    { ...geldigPakket(), pull_request: 0 },
    { ...geldigPakket(), pull_request: 'zeventig' },
    { ...geldigPakket(), merge_method: 'fast-forward' },
    { ...geldigPakket(), head_digest: 'niet-hex' },
    { ...geldigPakket(), head_digest: 'a'.repeat(40) },
    { ...geldigPakket(), measured_at: GELDIGE_PAKKET_VELDEN.measuredAtMs + 1 },
  ];
  for (const pakket of varianten) {
    assert.deepEqual(
      verifieer({ ownerPackage: pakket }),
      { ok: false, reason: OWNER_PACKAGE_REASON.OWNER_PACKAGE_MALFORMED },
      JSON.stringify(pakket),
    );
  }
});

test('O11. `verifyOwnerMergePackage` herkent DIGEST-KNOEIEN: een bewerkt veld zonder herberekende '
  + '`package_digest`', () => {
  const beknoeid = { ...geldigPakket(), pull_request: PR_A + 1 };
  assert.deepEqual(
    verifieer({ ownerPackage: beknoeid }),
    { ok: false, reason: OWNER_PACKAGE_REASON.OWNER_PACKAGE_DIGEST_MISMATCH },
  );
});

test('O11a. CANONICALISERINGSREGRESSIE (V26): `verifyOwnerMergePackage` accepteert een SEMANTISCH '
  + 'IDENTIEK pakket met OMGEKEERDE veldvolgorde, en blijft fail-closed op een gewijzigde waarde, een '
  + 'extra veld, een ontbrekend veld en een onjuiste digest', () => {
  const pakket = geldigPakket();
  const omgekeerd = {};
  for (const veld of [...Object.keys(pakket)].reverse()) omgekeerd[veld] = pakket[veld];
  // De sleutelvolgorde is aantoonbaar anders dan die van `geldigPakket()` — anders bewijst deze test
  // niets over canonicalisering.
  assert.notDeepEqual(Object.keys(omgekeerd), Object.keys(pakket));
  assert.deepEqual(verifieer({ ownerPackage: omgekeerd }), { ok: true });

  // Gewijzigde waarde (zonder herberekende digest) blijft fail-closed, óók in omgekeerde volgorde.
  const gewijzigd = { ...omgekeerd, merge_method: 'merge' };
  assert.deepEqual(
    verifieer({ ownerPackage: gewijzigd }),
    { ok: false, reason: OWNER_PACKAGE_REASON.OWNER_PACKAGE_DIGEST_MISMATCH },
  );

  // Extra veld blijft MALFORMED, óók in omgekeerde volgorde.
  const extraVeld = { ...omgekeerd, ongeoorloofd_extra_veld: 'x' };
  assert.deepEqual(
    verifieer({ ownerPackage: extraVeld }),
    { ok: false, reason: OWNER_PACKAGE_REASON.OWNER_PACKAGE_MALFORMED },
  );

  // Ontbrekend veld blijft MALFORMED, óók in omgekeerde volgorde.
  const { base_ref_digest: _weggelaten, ...ontbrekendVeld } = omgekeerd;
  assert.deepEqual(
    verifieer({ ownerPackage: ontbrekendVeld }),
    { ok: false, reason: OWNER_PACKAGE_REASON.OWNER_PACKAGE_MALFORMED },
  );

  // Onjuiste digest (zelf ook omgekeerd, waardeloos gewijzigd) blijft DIGEST_MISMATCH.
  const foutieveDigest = { ...omgekeerd, package_digest: '0'.repeat(64) };
  assert.deepEqual(
    verifieer({ ownerPackage: foutieveDigest }),
    { ok: false, reason: OWNER_PACKAGE_REASON.OWNER_PACKAGE_DIGEST_MISMATCH },
  );
});

test('O12. `verifyOwnerMergePackage` wijst een VERLOPEN pakket fail-closed af', () => {
  assert.deepEqual(
    verifieer({ nowMs: GELDIGE_PAKKET_VELDEN.measuredAtMs + 86400 * 1000 + 1 }),
    { ok: false, reason: OWNER_PACKAGE_REASON.OWNER_PACKAGE_EXPIRED },
  );
});

test('O13. `verifyOwnerMergePackage` herkent een VERSCHOVEN BINDING: het pakket zelf is intact, maar '
  + 'de verse meting is een andere pull request, head, boom, basis of methode geworden', () => {
  const varianten = [
    { pullRequest: PR_A + 1 },
    { sha: 'c'.repeat(40) },
    { treeSha: 'd'.repeat(40) },
    { baseRef: 'release' },
    { baseHeadSha: 'a'.repeat(40) },
    { mergeMethod: 'merge' },
    {
      measurementFingerprint: measurementFingerprint(
        eigenaarsMeting({ checkRuns: [[checkRun({ head_sha: '3'.repeat(40) })]] }),
      ),
    },
  ];
  for (const afwijking of varianten) {
    assert.deepEqual(
      verifieer(afwijking),
      { ok: false, reason: OWNER_PACKAGE_REASON.OWNER_PACKAGE_BINDING_CHANGED },
      JSON.stringify(afwijking),
    );
  }
});

test('O14. `verifyOwnerMergePackage` wijst een ONGELDIGE `maxAgeSeconds`/`nowMs` fail-closed af, vóór '
  + 'enige andere toets', () => {
  for (const maxAgeSeconds of [0, -1, 3600.5, OWNER_PACKAGE_MAX_AGE_SECONDS_MAX + 1, undefined, null]) {
    assert.deepEqual(
      verifieer({ maxAgeSeconds }),
      { ok: false, reason: OWNER_PACKAGE_REASON.OWNER_PACKAGE_MAX_AGE_INVALID },
      JSON.stringify(maxAgeSeconds),
    );
  }
  for (const nowMs of [-1, 1.5, undefined, null, 'nu']) {
    assert.deepEqual(
      verifieer({ nowMs }),
      { ok: false, reason: OWNER_PACKAGE_REASON.OWNER_PACKAGE_MAX_AGE_INVALID },
      JSON.stringify(nowMs),
    );
  }
  // Een ongeldige klok/vervaltermijn wint zelfs van een pakket dat op geen enkele andere grond zou
  // falen: de volgorde is met opzet zo dat een verkeerd geconfigureerde aanroeper nooit per ongeluk
  // een andere, geruststellender redencode terugkrijgt.
  assert.deepEqual(
    verifieer({ maxAgeSeconds: 0, ownerPackage: { onzin: true } }),
    { ok: false, reason: OWNER_PACKAGE_REASON.OWNER_PACKAGE_MAX_AGE_INVALID },
  );
});

test('O6. de WACHTRIJTAK blijft naast de eigenaarsstand volledig intact', async () => {
  // Dezelfde meting, twee standen, twee verschillende werelden — en de legacy-tak doet nog exact wat
  // hij sinds V19 deed: precies één inschrijving op `merge-async`, nooit een directe merge.
  const queueFetch = antwoordFetch(202);
  const inQueue = await draai({ a: meting(), p: POLICY_QUEUE, dryRun: false, fetchImpl: queueFetch });
  assert.equal(inQueue.rc, 0);
  assert.deepEqual(inQueue.uitkomst, {
    decision: FINALIZE_DECISION.GO,
    reasons: [],
    finalization_class: 'A',
    effect: 'MERGE_QUEUED',
    merge_performed: true,
  });
  assert.equal(queueFetch.aanroepen.length, 1);
  assert.ok(queueFetch.aanroepen[0].url.endsWith(`/pulls/${PR_A}/merge-async`));
  assert.equal(JSON.parse(queueFetch.aanroepen[0].init.body).merge_action, 'merge_queue');

  const eigenaarFetch = verbodenFetch();
  const inEigenaar = await draai({
    a: meting(), p: POLICY_MANUAL, dryRun: false, fetchImpl: eigenaarFetch,
  });
  assert.equal(inEigenaar.rc, OWNER_ACTION_REQUIRED_EXIT_CODE);
  assert.notEqual(inEigenaar.rc, 0);
  assert.equal(inEigenaar.uitkomst.decision, FINALIZE_DECISION.OWNER_ACTION_REQUIRED);
  assert.equal(inEigenaar.uitkomst.effect, 'OWNER_MERGE_PACKAGE');
  assert.equal(eigenaarFetch.aanroepen.length, 0);

  // En de inschrijvingsvoorwaarde van die tak is niet meeversoepeld: haal één deel uit de regelset en
  // de wachtrijtak sluit, terwijl de eigenaarsstand op diezelfde meting GO blijft. De twee oordelen
  // zijn onafhankelijk.
  const zonderQueueRegel = meting({
    mergeQueueRules: [
      { type: 'pull_request', parameters: { allowed_merge_methods: ['squash'] } },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [
            { context: CHECK, integration_id: 15368 },
            { context: CHECK_MG, integration_id: 15368 },
          ],
        },
      },
    ],
  });
  assert.ok(
    resolveFinalization({ pullRequest: PR_A, measurement: zonderQueueRegel, policy: POLICY_QUEUE })
      .reasons.includes(FINALIZE_REASON.SERVER_MERGE_QUEUE_PROOF_MISSING),
  );
  assert.equal(
    resolveFinalization({ pullRequest: PR_A, measurement: zonderQueueRegel, policy: POLICY_MANUAL })
      .decision,
    FINALIZE_DECISION.GO,
  );
});

test('O7. een INCOMPLETE ruleset-, check- of reviewmeting is nooit een geslaagde meting', () => {
  // Drie afkappingen, drie eigen redencodes. Een lijst die op de paginagrens is afgebroken LIJKT
  // telkens op de gunstige uitkomst: geen tegenstem, geen ontbrekende check, geen extra regel. Dat de
  // eigenaarsstand geen rulesetEIS stelt, maakt de regelsetMETING niet vrijblijvend: zij zit in de
  // vingerafdruk, dus een afkapping erin is een onbetrouwbare driftvergelijking.
  const afgekapteRegels = beslis({ mergeQueueRulesComplete: false });
  assert.equal(afgekapteRegels.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(afgekapteRegels.reasons.includes(FINALIZE_REASON.MERGE_QUEUE_RULES_INCOMPLETE));

  const afgekapteChecks = beslis({ checksComplete: false });
  assert.equal(afgekapteChecks.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(afgekapteChecks.reasons.includes(FINALIZE_REASON.CHECK_RUNS_INCOMPLETE));

  const afgekaptBewijs = beslis({ evidenceComplete: false });
  assert.equal(afgekaptBewijs.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(afgekaptBewijs.reasons.includes(FINALIZE_REASON.EVIDENCE_INCOMPLETE));

  // Een ONLEESBARE regelsetmeting is iets anders dan een lege: leeg is de gemeten stand van vandaag
  // (O3), onleesbaar is een meting die niet is gelukt — en die sluit de poort in BEIDE standen.
  assert.ok(
    beslis({ mergeQueueRules: null }).reasons
      .includes(FINALIZE_REASON.MERGE_QUEUE_RULES_UNREADABLE),
  );
  assert.ok(
    resolveFinalization({
      pullRequest: PR_A, measurement: meting({ mergeQueueRules: null }), policy: POLICY_QUEUE,
    }).reasons.includes(FINALIZE_REASON.MERGE_QUEUE_RULES_UNREADABLE),
  );
});

test('O8. de LIVE BASE-HEAD moet gemeten zijn, en verschuift hij, dan gebeurt er niets', async () => {
  for (const kapot of [
    undefined, null, {}, { object: {} }, { object: { sha: '' } },
    { object: { sha: 'f414ba1' } }, { object: { sha: BASE_HEAD.toUpperCase() } },
  ]) {
    const uitkomst = beslis({ baseHead: kapot });
    assert.equal(uitkomst.decision, FINALIZE_DECISION.NO_GO, JSON.stringify(kapot));
    assert.ok(
      uitkomst.reasons.includes(FINALIZE_REASON.BASE_HEAD_UNMEASURED),
      JSON.stringify(kapot),
    );
  }

  // DE TWEEDE READBACK. Beide metingen zijn op zichzelf GO — de base is alleen ÉÉN COMMIT
  // opgeschoven tussen meting A en meting B. Er volgt dan geen pakket en geen verzoek: een pakket op
  // een verschoven base zou de eigenaar een oordeel voorleggen dat niet meer over deze base gaat.
  const fetchImpl = verbodenFetch();
  const verschovenBase = eigenaarsMeting({
    baseHead: { ref: 'refs/heads/main', object: { sha: 'a'.repeat(40), type: 'commit' } },
  });
  assert.equal(
    resolveFinalization({ pullRequest: PR_A, measurement: verschovenBase, policy: POLICY_MANUAL })
      .decision,
    FINALIZE_DECISION.GO,
  );
  const { rc, uitkomst } = await draai({
    a: eigenaarsMeting(), b: verschovenBase, dryRun: false, fetchImpl,
  });
  assert.equal(rc, 1);
  assert.deepEqual(uitkomst, {
    decision: FINALIZE_DECISION.NO_GO, reasons: [FINALIZE_REASON.MEASUREMENT_DRIFT],
  });
  assert.equal(fetchImpl.aanroepen.length, 0);
});

test('O9. alleen GitHubs eigen oordeel `mergeable: true` MET `clean` telt', () => {
  // `mergeable: null` betekent "nog niet berekend" — een ONTBREKENDE meting, geen negatieve, en dus
  // een eigen redencode. Wie die twee samenvouwt, leest een onbekende stand als een bekende.
  for (const stand of [null, undefined, 'true', 1]) {
    const uitkomst = beslis({ pr: { ...meting().pr, mergeable: stand } });
    assert.equal(uitkomst.decision, FINALIZE_DECISION.NO_GO, JSON.stringify(stand));
    assert.ok(
      uitkomst.reasons.includes(FINALIZE_REASON.MERGEABILITY_UNMEASURED),
      JSON.stringify(stand),
    );
  }
  const nietMergebaar = beslis({ pr: { ...meting().pr, mergeable: false } });
  assert.ok(nietMergebaar.reasons.includes(FINALIZE_REASON.PULL_REQUEST_NOT_MERGEABLE));

  // `behind` is de gevaarlijkste van deze reeks: de PR is mergebaar, maar loopt achter op de base en
  // de groene check hangt aan een boom die na de merge niet meer bestaat.
  for (const stand of ['behind', 'unstable', 'blocked', 'dirty', 'unknown', 'draft', '', undefined]) {
    const uitkomst = beslis({ pr: { ...meting().pr, mergeable_state: stand } });
    assert.equal(uitkomst.decision, FINALIZE_DECISION.NO_GO, JSON.stringify(stand));
    assert.ok(
      uitkomst.reasons.includes(FINALIZE_REASON.MERGEABLE_STATE_NOT_CLEAN),
      JSON.stringify(stand),
    );
  }
});

test('O10. een VERSCHOVEN PR-head tussen de twee metingen levert nul verzoeken en geen pakket op',
  async () => {
    const fetchImpl = verbodenFetch();
    const verschoven = eigenaarsMeting({
      pr: { ...meting().pr, head: { sha: '5'.repeat(40) } },
      headCommit: { sha: '5'.repeat(40), tree: { sha: TREE } },
    });
    const { rc, uitkomst } = await draai({
      a: eigenaarsMeting(), b: verschoven, dryRun: false, fetchImpl,
    });
    assert.equal(rc, 1);
    assert.equal(uitkomst.decision, FINALIZE_DECISION.NO_GO);
    assert.equal(uitkomst.effect, undefined);
    assert.equal(fetchImpl.aanroepen.length, 0);

    // Ook de omgekeerde volgorde — de OUDE head in de hermeting — is drift en geen herstel.
    const terug = await draai({
      a: verschoven, b: eigenaarsMeting(), dryRun: false, fetchImpl,
    });
    assert.equal(terug.rc, 1);
    assert.equal(terug.uitkomst.decision, FINALIZE_DECISION.NO_GO);
    assert.equal(fetchImpl.aanroepen.length, 0);
  });

test('O11. een RODE, STALE of ONTBREKENDE vereiste check sluit de poort in de eigenaarsstand', () => {
  const ontbreekt = beslis({ checkRuns: [[checkRun({ name: 'iets-anders' })]] });
  assert.ok(ontbreekt.reasons.includes(FINALIZE_REASON.REQUIRED_CHECK_MISSING));

  // STALE: de check bestaat, maar op een ANDERE commit. Zonder wachtrij is dit de enige plek waar
  // een check van een vorige head nog als vorige head herkend wordt.
  const stale = beslis({ checkRuns: [[checkRun({ head_sha: '3'.repeat(40) })]] });
  assert.ok(stale.reasons.includes(FINALIZE_REASON.REQUIRED_CHECK_HEAD_MISMATCH));

  for (const conclusion of ['failure', 'cancelled', 'neutral', 'timed_out', 'action_required']) {
    const rood = beslis({ checkRuns: [[checkRun({ conclusion })]] });
    assert.equal(rood.decision, FINALIZE_DECISION.NO_GO, conclusion);
    assert.ok(rood.reasons.includes(FINALIZE_REASON.REQUIRED_CHECK_NOT_GREEN), conclusion);
  }
  const loopt = beslis({ checkRuns: [[checkRun({ status: 'in_progress', conclusion: null })]] });
  assert.ok(loopt.reasons.includes(FINALIZE_REASON.REQUIRED_CHECK_NOT_GREEN));

  // De MERGE-GROUP-check is in deze stand GEEN vereiste check: zijn afwezigheid mag de poort niet
  // sluiten, en dat is precies wat een dormante legacy-eis onderscheidt van een levende.
  assert.equal(
    resolveFinalization({
      pullRequest: PR_A, measurement: eigenaarsMeting({ checkRuns: [[checkRun()]] }),
      policy: POLICY_MANUAL,
    }).decision,
    FINALIZE_DECISION.GO,
  );
});

test('O12. de reviewwet en de ownerautorisatie gelden in de eigenaarsstand ONVERKORT', () => {
  // Dit is de kern van wat de eigenaarsstand WEL bewaakt. Een pakket zegt: dit bewijs is compleet.
  // Zou de reviewwet hier zachter zijn dan in de wachtrijtak, dan zou dat pakket niets betekenen.
  const zonderVendors = beslis({ issueComments: [[]], reviews: [[]], reviewComments: [[]] });
  assert.equal(zonderVendors.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(zonderVendors.reasons.includes(FINALIZE_REASON.REVIEW_GATE_NO_GO));

  // Eén ontbrekende vendor is genoeg: `codex` en `gemini` zijn allebei verplicht.
  const alleenEen = kloon(meting().reviews);
  alleenEen[0] = alleenEen[0].filter((r) => !r.user.login.startsWith('gemini'));
  const zonderGemini = beslis({ reviews: alleenEen, reviewComments: [[]] });
  assert.equal(zonderGemini.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(zonderGemini.reasons.includes(FINALIZE_REASON.REVIEW_GATE_NO_GO));

  // KLASSE A — deze meting raakt `.github/workflows/` en `CONTROL/AUTOCODING/` — vraagt bovendien een
  // ACTUELE ownerautorisatie, gebonden aan dit PR-nummer, deze head en deze base.
  assert.equal(beslis().finalization_class, 'A');
  const zonderOwner = beslis({ issueComments: [[]] });
  assert.equal(zonderOwner.decision, FINALIZE_DECISION.NO_GO);
  assert.ok(zonderOwner.reasons.includes(FINALIZE_REASON.MERGE_AUTHORIZATION_MISSING));

  const opVorigeHead = beslis({
    issueComments: issueCommentsMet(ownerBlok({ head_sha: '6'.repeat(40) })),
  });
  assert.ok(opVorigeHead.reasons.includes(FINALIZE_REASON.MERGE_AUTHORIZATION_MISSING));
  const opAndereBase = beslis({
    issueComments: issueCommentsMet(ownerBlok({ base_sha: ANDERE_BASE })),
  });
  assert.ok(opAndereBase.reasons.includes(FINALIZE_REASON.MERGE_AUTHORIZATION_MISSING));
});

test('O13. met de LIVE VLAGGEN uit — de stand van dit repository — is het aantal '
  + 'mergeverzoeken EXACT NUL', async () => {
  // Het bestand zoals het in de repository staat: de modus is sinds V24 de eigenaarsstand, en de drie
  // vlaggen staan onveranderd uit.
  assert.equal(POLICY_BESTAND.merge_finalizer.server_gate_mode, 'MANUAL_OWNER_GATE');
  for (const vlag of [
    'live_receipt_gate_enabled', 'merge_finalizer_enabled', 'class_b_auto_merge_enabled',
  ]) {
    assert.equal(POLICY_BESTAND[vlag], false, vlag);
  }

  // De CLI met een BEWEZEN GO-meting, zonder dry run: rood vóór het transport, en géén pakket — een
  // uitgezette finalizer levert niets op, ook geen eigenaarsopdracht.
  const fetchImpl = verbodenFetch();
  const { rc, uitkomst } = await draai({
    a: eigenaarsMeting(), p: POLICY_BESTAND, dryRun: false, fetchImpl,
  });
  assert.equal(rc, 1);
  assert.ok(uitkomst.reasons.includes(FINALIZE_REASON.FINALIZER_DISABLED));
  assert.equal(uitkomst.effect, undefined);

  // En de transportfunctie zelf, rechtstreeks aangeroepen met alles wat klopt, doet er evenmin één.
  const direct = await mergePullRequest({
    repository: 'rvanhooijdonk-png/stack-dashboard', pullRequest: PR_A, sha: HEAD,
    mergeMethod: 'squash', policy: POLICY_BESTAND, token: 'geheim', fetchImpl,
  });
  assert.deepEqual(direct, {
    ok: false, blocked: FINALIZE_ERROR.FINALIZER_DISABLED, requests: 0,
  });
  assert.equal(fetchImpl.aanroepen.length, 0);
});

test('MUT7. een finalizer die de EIGENAARSSTAND als wachtrijstand behandelt, doet wél een '
  + 'verzoek', async () => {
  // De mutatie is precies de reparatie van V24 teruggedraaid: `MANUAL_OWNER_GATE` valt niet meer
  // terminaal uit, maar zakt door naar de transporttak.
  const gemuteerd = await mutantVanDeFinalizer(
    'eigenaarsstand-zakt-door-naar-transport',
    '  if (modus === SERVER_GATE_MODE.MANUAL_OWNER_GATE) {\n'
      + '    return { ok: false, blocked: FINALIZE_ERROR.OWNER_MERGE_REQUIRED, requests: 0 };\n'
      + '  }\n'
      + '  if (modus !== SERVER_GATE_MODE.MERGE_QUEUE) {',
    '  if (modus !== SERVER_GATE_MODE.MERGE_QUEUE\n'
      + '    && modus !== SERVER_GATE_MODE.MANUAL_OWNER_GATE) {',
  );
  const fetchImpl = antwoordFetch(202);
  const uitkomst = await gemuteerd.mergePullRequest({
    repository: 'a/b', pullRequest: PR_A, sha: HEAD, mergeMethod: 'squash',
    policy: POLICY_MANUAL, token: 'geheim', fetchImpl,
  });
  // De mutant vraagt in de eigenaarsstand een inschrijving aan. O4 eist nul verzoeken en de code
  // `OWNER_MERGE_REQUIRED`; beide toetsen breken hier.
  assert.equal(uitkomst.ok, true);
  assert.equal(fetchImpl.aanroepen.length, 1);
  assert.throws(() => assert.equal(fetchImpl.aanroepen.length, 0), /AssertionError/);

  // De echte code op exact dezelfde invoer.
  const schoon = antwoordFetch(202);
  assert.deepEqual(
    await mergePullRequest({
      repository: 'a/b', pullRequest: PR_A, sha: HEAD, mergeMethod: 'squash',
      policy: POLICY_MANUAL, token: 'geheim', fetchImpl: schoon,
    }),
    { ok: false, blocked: FINALIZE_ERROR.OWNER_MERGE_REQUIRED, requests: 0 },
  );
  assert.equal(schoon.aanroepen.length, 0);
});

test('MUT7b. zelfs met de WEIGERING WEGGEHAALD én `STRICT_STATUS_CHECKS` teruggezet als '
  + 'toegestane stand komt er geen merge', async () => {
  // Twee mutaties tegelijk — de zwaarste vorm van de vraag "kan die stand ooit nog mergen?". De
  // policyvalidatie laat hem door en de stand staat weer in de toegestane verzameling.
  const gemuteerd = await mutantVanDeFinalizer(
    'strict-stand-hersteld-en-weigering-weg',
    '  if (Object.values(REJECTED_SERVER_GATE_MODE).includes(cfg.server_gate_mode)) fail();',
    '',
    {
      extra: [[
        "  MANUAL_OWNER_GATE: 'MANUAL_OWNER_GATE',\n});",
        "  MANUAL_OWNER_GATE: 'MANUAL_OWNER_GATE',\n"
          + "  STRICT_STATUS_CHECKS: 'STRICT_STATUS_CHECKS',\n});",
      ]],
    },
  );
  // De validatie klaagt niet meer...
  assert.doesNotThrow(() => gemuteerd.assertMergeFinalizerPolicySafe(POLICY_GEWEIGERD));
  // ...en tóch blijft het oordeel NO_GO en het aantal verzoeken nul. Niet door een tweede vangnet,
  // maar omdat er GEEN KLASSIEKE MERGE-AANROEP MEER BESTAAT om naartoe te vallen (O2): de switch in
  // `evaluateServerGatePrecondition` kent de stand niet, en `mergePullRequest` heeft voor een stand
  // die geen wachtrij is geen enkele tak.
  const fetchImpl = verbodenFetch();
  assert.deepEqual(
    gemuteerd.resolveFinalization({
      pullRequest: PR_A, measurement: meting(), policy: POLICY_GEWEIGERD,
    }),
    { decision: FINALIZE_DECISION.NO_GO, reasons: [FINALIZE_REASON.FINALIZER_POLICY_UNSAFE] },
  );
  assert.deepEqual(
    await gemuteerd.mergePullRequest({
      repository: 'a/b', pullRequest: PR_A, sha: HEAD, mergeMethod: 'squash',
      policy: POLICY_GEWEIGERD, token: 'geheim', fetchImpl,
    }),
    { ok: false, blocked: FINALIZE_REASON.FINALIZER_POLICY_UNSAFE, requests: 0 },
  );
  assert.equal(fetchImpl.aanroepen.length, 0);
});

test('MUT8. een finalizer die de BASE-HEAD niet HERMEET, mergt op een verschoven base', async () => {
  // De mutant meet de base-head nog wel, maar laat hem uit de vingerafdruk vallen: de tweede
  // readback bestaat dan formeel nog en bewijst niets meer.
  const gemuteerd = await mutantVanDeFinalizer(
    'zonder-base-head-readback',
    '    base_head: { sha: tekst(measurement?.baseHead?.object?.sha) },',
    "    base_head: { sha: '' },",
  );
  const verschovenBase = meting({
    baseHead: { ref: 'refs/heads/main', object: { sha: 'a'.repeat(40), type: 'commit' } },
  });
  const fetchImpl = antwoordFetch(202);
  const origineel = console.log;
  console.log = () => {};
  let rc;
  try {
    rc = await gemuteerd.runFinalize([
      '--repository', 'a/b', '--pull-request', String(PR_A),
      '--raw', schrijfMeting(meting()), '--raw-recheck', schrijfMeting(verschovenBase),
      '--policy', schrijfPolicy(POLICY_QUEUE),
    ], { readFile: lees, fetchImpl });
  } finally {
    console.log = origineel;
  }
  // De mutant schrijft in terwijl de base onder de pull request is weggeschoven. O8 eist nul
  // verzoeken; die toets breekt hier.
  assert.equal(rc, 0);
  assert.equal(fetchImpl.aanroepen.length, 1);
  assert.throws(() => assert.equal(fetchImpl.aanroepen.length, 0), /AssertionError/);
});

// --- Het budget ---------------------------------------------------------------------------------

test('M31. het verzoekbudget van een ronde is een BOVENGRENS, geen schatting', () => {
  // 1 PR + 1 commit + 1 live base-head (V23) + 4 pagina's regelset (sinds V20 zelf ook begrensd,
  // scope-item 6) + 5 bewijslijsten van 4 pagina's + 4 pagina's check runs.
  assert.equal(FINALIZER_MEASUREMENT_REQUEST_BUDGET, 31);
  // Twee volledige metingen plus hoogstens één merge-PUT plus, sinds V20, hoogstens drie
  // pollpogingen op het lichaam van dat verzoek (CODEX/CLAUDE4: een 202 alleen is geen bewijs van
  // inschrijving — zie `MERGE_ASYNC_POLL_BUDGET`).
  assert.equal(FINALIZER_PER_CANDIDATE_REQUEST_BUDGET, 66);
  assert.equal(finalizerRequestBudget(0), SELECTION_PAGE_BUDGET);
  assert.equal(finalizerRequestBudget(1), SELECTION_PAGE_BUDGET + 66);
  assert.equal(finalizerRequestBudget(5), SELECTION_PAGE_BUDGET + 330);
  // De limiet uit de policy past binnen het gedeelde uurquotum minus reserve.
  assert.ok(
    finalizerRequestBudget(POLICY_BESTAND.merge_finalizer.candidate_limit)
      <= SHARED_HOURLY_REQUEST_QUOTA - QUOTA_RESERVE,
  );
  // De bovengrens van de policy past dat NIET — daarom meet de aanroeper af tegen het werkelijk
  // resterende quotum in plaats van op de limiet te vertrouwen.
  assert.ok(finalizerRequestBudget(CANDIDATE_LIMIT_MAX) > SHARED_HOURLY_REQUEST_QUOTA - QUOTA_RESERVE);
  // Onzinnige invoer telt als nul kandidaten, nooit als negatief budget.
  for (const raar of [-1, 1.5, '3', null, undefined, NaN]) {
    assert.equal(finalizerRequestBudget(raar), SELECTION_PAGE_BUDGET, String(raar));
  }
});

// --- De kandidatenkeuze -------------------------------------------------------------------------

function openPr(overrides = {}) {
  return {
    number: PR_A, state: 'open', draft: false, merged: false,
    base: { ref: 'main' }, user: { login: OWNER }, ...overrides,
  };
}

test('K1. de kandidatenlijst is SELECTIE en nooit autorisatie', () => {
  // Het antwoord op bevinding 3835364974. Deze lijst bepaalt alleen WIE er gemeten wordt; elke
  // kandidaat wordt daarna uitsluitend op zijn eigen hermeten bewijs beoordeeld. Een gemiste
  // kandidaat wordt dus niet gefinaliseerd — er ontstaat nooit een merge uit deze lijst.
  const gekozen = selectFinalizationCandidates({
    openPulls: [[openPr(), openPr({ number: PR_B })]],
    openPullsComplete: true,
    policy: POLICY_QUEUE,
    nowEpochSeconds: NU,
    remainingQuota: SHARED_HOURLY_REQUEST_QUOTA,
  });
  assert.deepEqual(gekozen, { ok: true, candidates: [PR_A, PR_B], reasons: [] });

  // Een kandidaat zijn is geen enkele grond: dezelfde PR zonder eigen bewijs blijft NO_GO.
  const zonderBewijs = resolveFinalization({
    pullRequest: PR_B,
    measurement: meting({ pr: { ...meting().pr, number: PR_B } }),
    policy: POLICY_QUEUE,
  });
  assert.equal(zonderBewijs.decision, FINALIZE_DECISION.NO_GO);
});

test('K2. een AFGEKAPTE open-PR-lijst levert nul kandidaten op', () => {
  // Niet omdat een gemiste kandidaat gevaarlijk is, maar omdat een halve lijst als volledige ronde
  // behandelen de rotatie stil onvolledig maakt terwijl de run groen oogt.
  assert.deepEqual(selectFinalizationCandidates({
    openPulls: [[openPr()]], openPullsComplete: false, policy: POLICY_QUEUE,
  }), { ok: false, candidates: [], reasons: [CANDIDATE_REASON.OPEN_PULL_REQUESTS_TRUNCATED] });

  for (const vlag of ['true', 1, null, undefined]) {
    assert.equal(selectFinalizationCandidates({
      openPulls: [[openPr()]], openPullsComplete: vlag, policy: POLICY_QUEUE,
    }).ok, false, String(vlag));
  }
});

test('K3. met de vlag uit of een kapotte policy bestaat er geen kandidaat', () => {
  assert.deepEqual(selectFinalizationCandidates({
    openPulls: [[openPr()]], openPullsComplete: true, policy: POLICY_BESTAND,
  }), { ok: false, candidates: [], reasons: [CANDIDATE_REASON.FINALIZER_DISABLED] });

  assert.deepEqual(selectFinalizationCandidates({
    openPulls: [[openPr()]],
    openPullsComplete: true,
    policy: policy({ merge_finalizer_enabled: true }, { candidate_limit: 0 }),
  }), { ok: false, candidates: [], reasons: [CANDIDATE_REASON.FINALIZER_POLICY_UNSAFE] });
});

test('K4. concepten, gesloten PR\'s, vreemde bases en vreemde bouwers vallen af', () => {
  const gekozen = selectFinalizationCandidates({
    openPulls: [[
      openPr({ number: 1, draft: true }),
      openPr({ number: 2, state: 'closed' }),
      openPr({ number: 3, merged: true }),
      openPr({ number: 4, base: { ref: 'productie' } }),
      openPr({ number: 5, user: { login: 'iemand-anders' } }),
      openPr({ number: 6 }),
      openPr({ number: 0 }),
      null,
    ]],
    openPullsComplete: true,
    policy: POLICY_QUEUE,
    nowEpochSeconds: NU,
    remainingQuota: SHARED_HOURLY_REQUEST_QUOTA,
  });
  assert.deepEqual(gekozen.candidates, [6]);

  assert.deepEqual(selectFinalizationCandidates({
    openPulls: [[]], openPullsComplete: true, policy: POLICY_QUEUE, nowEpochSeconds: NU,
  }), { ok: false, candidates: [], reasons: [CANDIDATE_REASON.NO_CANDIDATES] });

  // `candidate_limit` is de VENSTERCAPACITEIT binnen de gekozen emmer, geen afkapping in de volgorde
  // van GitHub zelf (P2, bevinding `3835523942`) — bij slot 0 begint dat venster bij index 0.
  const veel = Array.from({ length: 12 }, (_, i) => openPr({ number: i + 1 }));
  const begrensd = selectFinalizationCandidates({
    openPulls: [veel],
    openPullsComplete: true,
    policy: policy({ merge_finalizer_enabled: true }, { candidate_limit: 3 }),
    nowEpochSeconds: NU,
    remainingQuota: SHARED_HOURLY_REQUEST_QUOTA,
  });
  assert.deepEqual(begrensd.candidates, [1, 2, 3]);

  // Een ANDER tijdslot schuift het venster op binnen dezelfde vaste emmer — dit is precies de
  // rotatie die de vaste prefix uit V18 verving.
  const anderSlot = selectFinalizationCandidates({
    openPulls: [veel],
    openPullsComplete: true,
    policy: policy({ merge_finalizer_enabled: true }, { candidate_limit: 3 }),
    nowEpochSeconds: 3 * SCHEDULE_SLOT_SECONDS,
    remainingQuota: SHARED_HOURLY_REQUEST_QUOTA,
  });
  assert.deepEqual(anderSlot.candidates, [4, 5, 6]);
});

test(
  'K4a. NEGATIEVE CONTROLE: een vaste PREFIX verhongert bij meer dan `candidate_limit` kandidaten,'
    + ' tijdslotrotatie niet',
  () => {
    // Het antwoord op `3835523942` (P2). Vóór V19 was dit `.slice(0, candidate_limit)`: zolang er
    // meer dan `candidate_limit` in aanmerking komende PR's open blijven, wint dezelfde eerste
    // reeks nummers elke ronde opnieuw en komt de rest nooit aan de beurt.
    const nummers = Array.from({ length: 126 }, (_, i) => i + 1);
    const open = [nummers.map((n) => openPr({ number: n }))];
    const p = policy({ merge_finalizer_enabled: true }, { candidate_limit: 25 });

    // De oude vorm: een vaste prefix van de GitHub-volgorde, ELKE ronde hetzelfde.
    const viaPrefix = new Set();
    for (let ronde = 0; ronde < 6; ronde += 1) {
      for (const n of nummers.slice(0, 25)) viaPrefix.add(n);
    }
    assert.equal(viaPrefix.size, 25, 'de vaste prefix ziet nooit meer dan zijn eigen limiet');
    assert.ok(viaPrefix.size < nummers.length, 'de rest verhongert onder de oude vorm');

    // De huidige vorm: `count` opeenvolgende tijdslots dekken de hele verzameling, zolang het
    // quotum elke emmer in één keer volledig betaalt. `count` volgt uit dezelfde vaste
    // `SCHEDULE_BUCKET_LIMIT` als de doelenselector, niet uit `candidate_limit`.
    const count = Math.ceil(nummers.length / SCHEDULE_BUCKET_LIMIT);
    // Sinds V20 telt het quotum zelf mee in de venstergrootte (CODEX `3835810736`): bij het volledige
    // uurquotum past een emmer van `SCHEDULE_BUCKET_LIMIT` (25) niet in één beurt tegen de dure
    // finalizer-kosten per kandidaat — dat is geen testgebrek maar de reële, opzettelijk behoudende
    // grens (zie M31: `finalizerRequestBudget(CANDIDATE_LIMIT_MAX)` overschrijdt het bruikbare
    // uurquotum). De dekkingsproef loopt daarom door tot elke emmer genoeg beurten heeft gehad om
    // zichzelf volledig te dekken, in plaats van te doen alsof één beurt altijd volstaat.
    const affordableOpVolQuotum = Math.floor(
      (SHARED_HOURLY_REQUEST_QUOTA - QUOTA_RESERVE - SELECTION_PAGE_BUDGET)
        / FINALIZER_PER_CANDIDATE_REQUEST_BUDGET,
    );
    const grootsteEmmer = Math.max(
      ...Array.from({ length: count }, (_, slot) => selectScheduleBucket(nummers, slot).bucket.length),
    );
    // `selectBucketWindow` schuift het anker per bezoek met precies één op (geen sprong ter grootte
    // van de capaciteit) — de vereiste bezoeken voor volledige circulaire dekking zijn dus
    // `grootte - capaciteit + 1`, niet `grootte / capaciteit`.
    const beurtenPerEmmer = Math.max(1, grootsteEmmer - affordableOpVolQuotum + 1);
    const totaalSloten = count * beurtenPerEmmer;

    const viaSlot = new Set();
    for (let slot = 0; slot < totaalSloten; slot += 1) {
      const gekozen = selectFinalizationCandidates({
        openPulls: open,
        openPullsComplete: true,
        policy: p,
        nowEpochSeconds: slot * SCHEDULE_SLOT_SECONDS,
        remainingQuota: SHARED_HOURLY_REQUEST_QUOTA,
      });
      assert.equal(gekozen.ok, true, `slot ${slot}`);
      assert.ok(gekozen.candidates.length > 0, `slot ${slot}: nooit een lege ronde op een niet-lege lijst`);
      for (const n of gekozen.candidates) viaSlot.add(n);
    }
    assert.equal(viaSlot.size, 126, 'elke kandidaat komt binnen voldoende sloten aan de beurt');
    assert.deepEqual([...viaSlot].sort((a, b) => a - b), nummers);

    // Verandert `candidate_limit` tussentijds, dan verschuiven de emmergrenzen NIET mee — alleen het
    // venster erbinnen krimpt. Dezelfde scheiding als bevinding `3835186656` voor de doelenselector.
    const kleinerVenster = policy({ merge_finalizer_enabled: true }, { candidate_limit: 1 });
    const eersteEmmerGroot = selectScheduleBucket(nummers, 0);
    const gekozenKlein = selectFinalizationCandidates({
      openPulls: open, openPullsComplete: true, policy: kleinerVenster, nowEpochSeconds: 0,
      remainingQuota: SHARED_HOURLY_REQUEST_QUOTA,
    });
    assert.equal(gekozenKlein.candidates.length, 1);
    assert.ok(eersteEmmerGroot.bucket.includes(gekozenKlein.candidates[0]));
    assert.equal(eersteEmmerGroot.count, count, 'de indeling zelf blijft ongewijzigd bij een ander venster');
  },
);

test(
  'K4b. CODEX 3835810736 NEGATIEVE CONTROLE: een krap quotum (past=1) verhongert de hoge nummers'
    + ' niet, noch over 5 noch over 25 kandidaten',
  () => {
    // Het exacte scenario uit de bevinding: een emmer van 25 in aanmerking komende PR's,
    // `candidate_limit=5`, en een quotum dat maar precies ÉÉN kandidaat toelaat. Vóór V20 won bij elk
    // zo'n krap quotum de LAAGSTE PR in het (al gesorteerde) venster, ongeacht het ronde-anker: de
    // PR's 22-25 kwamen dan nooit aan de beurt. Na de reparatie bepaalt het anker zelf welke ene PR
    // deze ronde wordt gekozen, en schuift die met de rotatie mee.
    for (const candidateLimit of [5, 25]) {
      const nummers = Array.from({ length: 25 }, (_, i) => i + 1);
      const open = [nummers.map((n) => openPr({ number: n }))];
      const p = policy({ merge_finalizer_enabled: true }, { candidate_limit: candidateLimit });
      const quotumVoorEen = finalizerRequestBudget(1) + QUOTA_RESERVE;

      const gezien = new Set();
      for (let slot = 0; slot < nummers.length; slot += 1) {
        const gekozen = selectFinalizationCandidates({
          openPulls: open,
          openPullsComplete: true,
          policy: p,
          nowEpochSeconds: slot * SCHEDULE_SLOT_SECONDS,
          remainingQuota: quotumVoorEen,
        });
        assert.equal(gekozen.ok, true, `candidateLimit=${candidateLimit} slot ${slot}`);
        assert.equal(
          gekozen.candidates.length, 1,
          `candidateLimit=${candidateLimit} slot ${slot}: een krap quotum staat precies één kandidaat toe`,
        );
        gezien.add(gekozen.candidates[0]);
      }
      assert.equal(
        gezien.size, 25,
        `candidateLimit=${candidateLimit}: elke PR komt binnen 25 sloten aan de beurt, ook 22-25`,
      );
      for (const hoog of [22, 23, 24, 25]) {
        assert.ok(gezien.has(hoog), `candidateLimit=${candidateLimit}: PR ${hoog} mag niet verhongeren`);
      }
    }
  },
);

test(
  'K5. het quotum vouwt in DEZELFDE stap als `candidate_limit` in de capaciteit, en een onbekend'
    + ' quotum stopt de ronde',
  () => {
    // Sinds V20 (Codex `3835810736`) bestaat er geen aparte quotumslice meer: `selectFinalizationCandidates`
    // krijgt het quotum rechtstreeks en vouwt het samen met `candidate_limit` in de capaciteit vóór
    // `selectBucketWindow`. Bij slot `NU=0` staat het anker op index 0, dus komt bij een vaste emmer
    // `[1,2,3,4,5]` een venster vanaf index 0 op exact dezelfde nummers uit als de oude losse slice.
    const vijf = [1, 2, 3, 4, 5].map((n) => openPr({ number: n }));
    const p = policy({ merge_finalizer_enabled: true }, { candidate_limit: 5 });
    const kies = (remainingQuota) => selectFinalizationCandidates({
      openPulls: [vijf], openPullsComplete: true, policy: p, nowEpochSeconds: NU, remainingQuota,
    });

    assert.deepEqual(kies(SHARED_HOURLY_REQUEST_QUOTA), {
      ok: true, candidates: [1, 2, 3, 4, 5], reasons: [],
    });
    // Precies genoeg voor twee kandidaten: 4 + 2 x 53 = 110, plus de reserve.
    const voorTwee = finalizerRequestBudget(2) + QUOTA_RESERVE;
    assert.deepEqual(kies(voorTwee).candidates, [1, 2]);
    assert.deepEqual(kies(voorTwee - 1).candidates, [1]);

    // Eén verzoek te weinig voor de eerste kandidaat: de reserve wint.
    const voorNul = finalizerRequestBudget(1) + QUOTA_RESERVE - 1;
    assert.deepEqual(kies(voorNul), {
      ok: false, candidates: [], reasons: [CANDIDATE_REASON.API_BUDGET_RESERVED],
    });

    // Een niet-geheel, negatief of onaannemelijk groot quotum is ONBEKEND, geen ruim quotum — exact
    // dezelfde bovengrenstoets als vóór V20, nu vóór de capaciteitsberekening zelf.
    for (const onbekend of [null, undefined, -1, 1.5, NaN, SHARED_HOURLY_REQUEST_QUOTA + 1]) {
      assert.deepEqual(kies(onbekend), {
        ok: false, candidates: [], reasons: [CANDIDATE_REASON.API_QUOTA_UNKNOWN],
      }, String(onbekend));
    }
  },
);

test('K6. de kandidaten-CLI schrijft ALTIJD een geldige matrix, ook bij een weigering', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finalize-kandidaten-'));
  const openPad = join(dir, 'open.json');
  const uitPad = join(dir, 'matrix.json');
  writeFileSync(openPad, JSON.stringify([[openPr()]]));

  const geschreven = new Map();
  const schrijf = (pad, data) => geschreven.set(pad, data);
  const origineel = console.log;
  const regels = [];
  console.log = (r) => regels.push(r);
  try {
    const argv = (p, quota) => [
      '--open-pulls', openPad, '--open-pulls-complete', 'true',
      '--policy', schrijfPolicy(p), '--remaining-quota', quota, '--out', uitPad,
      '--now-epoch', String(NU),
    ];
    assert.equal(runSelectCandidates(argv(POLICY_QUEUE, '900'), { readFile: lees, writeFile: schrijf }), 0);
    assert.deepEqual(JSON.parse(geschreven.get(uitPad)), [PR_A]);

    // Met de vlag uit is de matrix leeg — en dus draait er geen enkele finaliserende job.
    assert.equal(runSelectCandidates(argv(POLICY_BESTAND, '900'), { readFile: lees, writeFile: schrijf }), 0);
    assert.deepEqual(JSON.parse(geschreven.get(uitPad)), []);

    // Onbekend quotum: ook leeg, en nooit een half gevulde ronde.
    assert.equal(runSelectCandidates(argv(POLICY_QUEUE, '-'), { readFile: lees, writeFile: schrijf }), 0);
    assert.deepEqual(JSON.parse(geschreven.get(uitPad)), []);

    // Een onleesbare lijst is rc 1, met een lege matrix.
    writeFileSync(openPad, 'geen json');
    assert.equal(runSelectCandidates(argv(POLICY_QUEUE, '900'), { readFile: lees, writeFile: schrijf }), 1);
    assert.deepEqual(JSON.parse(geschreven.get(uitPad)), []);
  } finally {
    console.log = origineel;
  }
  // Elke melding is een gesloten code.
  const toegestaan = new Set([...Object.values(CANDIDATE_REASON), 'CANDIDATES_SELECTED']);
  for (const regel of regels) {
    for (const code of regel.split(' ')) assert.ok(toegestaan.has(code), code);
  }
});

test('K7. de argumentvorm van de kandidatenkeuze is even gesloten als die van de finalizer', () => {
  const goed = [
    '--open-pulls', '/tmp/o', '--open-pulls-complete', 'true',
    '--policy', '/tmp/p', '--remaining-quota', '900', '--out', '/tmp/m',
    '--now-epoch', '0',
  ];
  assert.equal(parseCandidateArgs(goed).ok, true);
  assert.equal(parseCandidateArgs(goed).openPullsComplete, true);
  for (const argv of [
    [...goed, '--force', 'ja'],
    [...goed, '--out', '/tmp/n'],
    goed.slice(0, -1),
    goed.slice(0, -2),
    ['--open-pulls-complete', 'waar', ...goed.slice(0, 2), ...goed.slice(4)],
    ['--open-pulls-complete', '', ...goed.slice(0, 2), ...goed.slice(4)],
    [],
  ]) {
    assert.deepEqual(parseCandidateArgs(argv), {
      ok: false, error: CANDIDATE_REASON.ARGUMENTS_INVALID,
    }, JSON.stringify(argv));
  }
  assert.deepEqual([...CANDIDATE_VALUE_OPTIONS].sort(), [
    '--now-epoch', '--open-pulls', '--open-pulls-complete', '--out', '--policy', '--remaining-quota',
  ]);
});
