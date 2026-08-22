/**
 * AUTOCODING_SHIELD — V20 scope-item 1/2: de MERGE-GROUP-POORT.
 *
 * WAAROM DIT BESTAAT. Claude4-architectuurreview `AUTOCODING_PR74_V19_MERGE_GROUP_EVIDENCE_
 * ARCHITECTURE_REVIEW_CLAUDE4_RETRY1` (F1/F2, NO_GO): `merge_group` bestond nergens in deze
 * repository. GitHub herevalueert bij een merge-queue-inschrijving uitsluitend de VEREISTE STATUS-
 * CHECKS, en herevalueert dat op de MERGE-GROUP-COMMIT — een boom die de basebranch, deze pull
 * request én elke pull request vóór haar in de wachtrij draagt. Elke autorisatie die alleen aan de
 * PR-eigen head/tree bindt (de bestaande shield en mergefinalizer) zegt dus niets over de boom die
 * werkelijk gemerged wordt.
 *
 * WAT DIT BESTAND WEL EN NIET DOET. Puur en synchroon: geen `fetch`, geen `fs`, geen `gh`. De
 * aanroepende workflow (`autocoding-merge-group-gate.yml`) haalt het bewijs op en roept deze functies
 * aan met wat GitHub daadwerkelijk heeft geleverd.
 *
 *   1. `parseMergeGroupHeadRef` leest de door GITHUB gegenereerde queue-ref
 *      (`gh-readonly-queue/<base>/pr-<nummer>-<sha>`) tot een PR-nummer en een head-sha-hint. Een
 *      onherkenbare vorm is `ok: false` — nooit een gok.
 *   2. `resolveMergeGroupBinding` bewijst dat de merge-group-commit EXACT twee ouders draagt: de
 *      basebranch en de HUIDIGE, VERS GEMETEN head van precies díé pull request. Dat is geen
 *      naamcontrole maar een cryptografische gelijkheid op de committer-parents, en dekt in één
 *      meting drie aparte defecten:
 *        - VERSTALED bewijs: is de PR na inschrijving verder gegaan, dan is haar huidige head geen
 *          ouder meer van deze merge-group-commit → `MERGE_GROUP_HEAD_STALE`.
 *        - CO-TENANT-vermenging: een merge-group met méér dan twee ouders (of twee ouders die geen
 *          van beide de basebranch zijn) draagt meer dan alleen basis + deze ene PR — mogelijk de
 *          wijzigingen van een andere, GEVOELIGE pull request vóór haar in de wachtrij →
 *          `MERGE_GROUP_PARENTS_NOT_TWO`.
 *        - BASE-drift: de basebranch is tussen meting en inschrijving verplaatst →
 *          `MERGE_GROUP_BASE_MISMATCH`.
 *   3. `evaluateMergeGroupGate` hergebruikt de bestaande, al bewezen Shield-wet (`evaluateShield`)
 *      ONGEWIJZIGD voor de PR-EIGEN head/tree — dezelfde poort die de bestaande finalizer al toepast
 *      — en EIST DAARBOVENOP een eigenaarsautorisatie die expliciet aan de MERGE-GROUP-TREE bindt
 *      (via `evaluateMergeAuthorizations` met een tree-vervangen context). Niet herleidbaar op die
 *      boom → rood, exact zoals de review eist: "Not re-derivable → red".
 */

const SHA_RE = /^[0-9a-f]{40}$/;

export const MERGE_GROUP_REASON = Object.freeze({
  MERGE_GROUP_REF_UNPARSEABLE: 'MERGE_GROUP_REF_UNPARSEABLE',
  MERGE_GROUP_PULL_REQUEST_MISMATCH: 'MERGE_GROUP_PULL_REQUEST_MISMATCH',
  MERGE_GROUP_PULL_REQUEST_NOT_OPEN: 'MERGE_GROUP_PULL_REQUEST_NOT_OPEN',
  MERGE_GROUP_HEAD_STALE: 'MERGE_GROUP_HEAD_STALE',
  MERGE_GROUP_PARENTS_NOT_TWO: 'MERGE_GROUP_PARENTS_NOT_TWO',
  MERGE_GROUP_BASE_MISMATCH: 'MERGE_GROUP_BASE_MISMATCH',
  MERGE_GROUP_TREE_AUTHORIZATION_MISSING: 'MERGE_GROUP_TREE_AUTHORIZATION_MISSING',
});

/**
 * Leest `gh-readonly-queue/<base>/pr-<nummer>-<sha>` (met of zonder `refs/heads/`-voorvoegsel).
 * De sha-hint mag korter zijn dan veertig tekens — GitHub's exacte lengte is hier niet de bron van
 * waarheid, `resolveMergeGroupBinding` bewijst de werkelijke binding via de ouderlijst, niet via deze
 * naamstring. Onherkenbaar is altijd `ok: false`, nooit een lege of gegokte waarde.
 */
export function parseMergeGroupHeadRef(headRef) {
  const text = typeof headRef === 'string' ? headRef : '';
  const match = /^(?:refs\/heads\/)?gh-readonly-queue\/([^/]+)\/pr-(\d+)-([0-9a-f]{4,40})$/.exec(text);
  if (!match) return { ok: false, baseRef: '', pullRequest: 0, headShaHint: '' };
  return { ok: true, baseRef: match[1], pullRequest: Number(match[2]), headShaHint: match[3] };
}

/**
 * De cryptografische binding tussen een merge-group-commit en EXACT ÉÉN pull request.
 *
 * `mergeGroupParents` zijn de `parents[].sha`-velden van `GET /repos/{o}/{r}/git/commits/{merge_
 * group.head_sha}` — GitHub-geleverd, niet afgeleid. `freshPullRequest` is de VERS (na de lock)
 * opgehaalde `GET /pulls/{n}`, nooit de eventpayload: die kan een moment vóór de meting representeren
 * en juist dát gat is waar verouderd bewijs zich verstopt.
 */
export function resolveMergeGroupBinding({
  headRef, mergeGroupBaseSha, mergeGroupParents, freshPullRequest,
} = {}) {
  const reasons = new Set();
  const parsed = parseMergeGroupHeadRef(headRef);
  if (!parsed.ok) {
    return {
      ok: false, pullRequest: 0,
      reasons: [MERGE_GROUP_REASON.MERGE_GROUP_REF_UNPARSEABLE],
    };
  }

  const pr = freshPullRequest ?? {};
  const prNumber = Number.isInteger(pr.number) && pr.number > 0 ? pr.number : 0;
  const prHeadSha = SHA_RE.test(pr?.head?.sha ?? '') ? pr.head.sha : '';
  const prBaseSha = SHA_RE.test(pr?.base?.sha ?? '') ? pr.base.sha : '';
  const isOpen = pr?.state === 'open' && pr?.merged !== true;

  if (parsed.pullRequest !== prNumber) reasons.add(MERGE_GROUP_REASON.MERGE_GROUP_PULL_REQUEST_MISMATCH);
  if (!isOpen) reasons.add(MERGE_GROUP_REASON.MERGE_GROUP_PULL_REQUEST_NOT_OPEN);

  const parents = (Array.isArray(mergeGroupParents) ? mergeGroupParents : [])
    .filter((p) => SHA_RE.test(p));
  const parentSet = new Set(parents);

  if (parents.length !== 2 || parentSet.size !== 2) {
    reasons.add(MERGE_GROUP_REASON.MERGE_GROUP_PARENTS_NOT_TWO);
  } else {
    if (!prHeadSha || !parentSet.has(prHeadSha)) {
      reasons.add(MERGE_GROUP_REASON.MERGE_GROUP_HEAD_STALE);
    }
    if (
      !SHA_RE.test(mergeGroupBaseSha ?? '')
      || !parentSet.has(mergeGroupBaseSha)
      || mergeGroupBaseSha !== prBaseSha
    ) {
      reasons.add(MERGE_GROUP_REASON.MERGE_GROUP_BASE_MISMATCH);
    }
  }

  return { ok: reasons.size === 0, pullRequest: prNumber, reasons: Array.from(reasons) };
}

/**
 * De volledige merge-group-uitspraak: de bestaande PR-eigen Shield-wet, ONGEWIJZIGD, plus een
 * TWEEDE, strengere eis — een eigenaarsautorisatie die expliciet aan de merge-group-TREE bindt.
 *
 * `evaluateShield` en `evaluateMergeAuthorizations` worden als parameter meegegeven in plaats van
 * geïmporteerd: dit bestand blijft daardoor een pure functie van zijn argumenten, en de aanroeper
 * (de workflow-runtime, of een test) bepaalt welke implementatie er werkelijk draait. Dat is dezelfde
 * vorm als de rest van deze module: geen verborgen afhankelijkheid, alleen expliciete invoer.
 */
export function evaluateMergeGroupGate({
  evaluateShield, evaluateMergeAuthorizations,
  shieldContext, shieldInput, mergeGroupTreeSha, policy,
} = {}) {
  const reasons = new Set();

  const shieldResult = evaluateShield({ ...shieldInput, context: shieldContext, policy });
  for (const r of shieldResult.reasons) reasons.add(r);

  const mergeGroupContext = { ...shieldContext, pr_tree_sha: SHA_RE.test(mergeGroupTreeSha ?? '') ? mergeGroupTreeSha : '' };
  const mergeGroupResult = evaluateMergeAuthorizations(
    shieldInput?.ownerApprovals, mergeGroupContext, policy?.owner_gate,
  );
  if (mergeGroupResult.decision !== 'GO') {
    reasons.add(MERGE_GROUP_REASON.MERGE_GROUP_TREE_AUTHORIZATION_MISSING);
    for (const r of mergeGroupResult.reasons) reasons.add(r);
  }

  return { decision: reasons.size === 0 ? 'GO' : 'NO_GO', reasons: Array.from(reasons) };
}

/**
 * De volledige, tweetraps merge-group-controle die de workflow werkelijk aanroept.
 *
 * Trap 1 (`resolveMergeGroupBinding`) beslist EERST, en op zichzelf, of deze merge-group-commit
 * ondubbelzinnig aan precies deze pull request toe te schrijven is. Faalt die trap, dan wordt
 * `evaluateMergeGroupGate` NOOIT aangeroepen — geen bewijs wordt herwogen, geen API-budget besteed.
 * Dat is met opzet: hoe groen het onderliggende bewijs er ook uitziet (volledig groen bewijs op de
 * eigen head van de PR, of zelfs op de eigen head én tree), een merge-group die niet herleidbaar is
 * tot exact één basis en exact één pull request mag nooit een GO opleveren. Dat is precies het
 * scenario uit Claude4's architectuurreview: een gevoelige mede-inzittende pull request in dezelfde
 * wachtrij verandert de werkelijk gemergede boom, ongeacht hoe de metingen op de eigen tak van déze
 * PR uitvallen.
 */
export function evaluateMergeGroupCheck({
  headRef, mergeGroupBaseSha, mergeGroupParents, freshPullRequest, mergeGroupTreeSha,
  evaluateShield, evaluateMergeAuthorizations, shieldContext, shieldInput, policy,
} = {}) {
  const binding = resolveMergeGroupBinding({
    headRef, mergeGroupBaseSha, mergeGroupParents, freshPullRequest,
  });
  if (!binding.ok) {
    return { decision: 'NO_GO', reasons: binding.reasons, pullRequest: binding.pullRequest };
  }

  const gate = evaluateMergeGroupGate({
    evaluateShield, evaluateMergeAuthorizations, shieldContext, shieldInput, mergeGroupTreeSha, policy,
  });
  return { decision: gate.decision, reasons: gate.reasons, pullRequest: binding.pullRequest };
}
