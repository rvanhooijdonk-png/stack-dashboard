/**
 * AUTOCODING_SHIELD — V20 scope-item 1/2. De CLI-schakel tussen de `merge_group`-workflow (die
 * uitsluitend leest en één check-run publiceert) en de pure functies in `resolve-merge-group.mjs` en
 * `verify-review-gate.mjs`. Dit bestand doet zelf geen netwerkverkeer: het leest twee reeds gemeten
 * bewijsmappen van schijf en schrijft één gesloten JSON-uitspraak naar stdout.
 *
 * De rawmap voor de pull request zelf hergebruikt LETTERLIJK dezelfde bestandsnamen als de
 * mergefinalizer (`MEASUREMENT_FILES` in `finalize-merge.mjs`, hier niet geïmporteerd om deze module
 * onafhankelijk te houden van de finalizer se CLI-vorm, maar bewust identiek gehouden): `pr.json`,
 * `head-commit.json`, `pr-commits.json`, `issue-comments.json`, `reviews.json`,
 * `review-comments.json`, `files.json`. Die worden ONGEWIJZIGD door `buildShieldInput` verwerkt tot
 * de PR-eigen `context`/`shieldInput` — dezelfde adapter die de shield en de finalizer al gebruiken.
 *
 * De merge-groupmap draagt precies de drie GitHub-geleverde feiten die `resolveMergeGroupBinding`
 * nodig heeft, plus de tree van de merge-group-commit zelf:
 *   - `event.json`      → `{ head_ref, base_sha }` (uit de `merge_group`-eventpayload)
 *   - `commit.json`      → `GET /repos/{o}/{r}/git/commits/{merge_group.head_sha}`
 *     (levert `parents[].sha` en `tree.sha`)
 */

import { pathToFileURL } from 'node:url';

import { evaluateMergeGroupCheck } from './resolve-merge-group.mjs';
import { buildShieldInput, flattenPages } from './collect-shield-input.mjs';
import { evaluateShield, evaluateMergeAuthorizations } from './verify-review-gate.mjs';

export const MERGE_GROUP_GATE_DECISION = Object.freeze({ GO: 'GO', NO_GO: 'NO_GO' });

export const MERGE_GROUP_GATE_ERROR = Object.freeze({
  ARGUMENTS_INVALID: 'ARGUMENTS_INVALID',
  MEASUREMENT_UNREADABLE: 'MEASUREMENT_UNREADABLE',
});

export const PR_MEASUREMENT_FILES = Object.freeze({
  pr: 'pr.json',
  headCommit: 'head-commit.json',
  prCommits: 'pr-commits.json',
  issueComments: 'issue-comments.json',
  reviews: 'reviews.json',
  reviewComments: 'review-comments.json',
  changedFiles: 'files.json',
});

/** Leest de PR-eigen meting. Elk ontbrekend of onparseerbaar bestand maakt de hele meting onleesbaar. */
export function readPullRequestMeasurement(rawDir, readFile) {
  const measurement = {};
  for (const [key, file] of Object.entries(PR_MEASUREMENT_FILES)) {
    measurement[key] = JSON.parse(readFile(`${rawDir}/${file}`));
  }
  return measurement;
}

/** Leest de merge-group-eigen meting: de eventfeiten en de door GitHub gemeten commit. */
export function readMergeGroupMeasurement(mergeGroupDir, readFile) {
  const event = JSON.parse(readFile(`${mergeGroupDir}/event.json`));
  const commit = JSON.parse(readFile(`${mergeGroupDir}/commit.json`));
  const parents = Array.isArray(commit?.parents)
    ? commit.parents.map((p) => p?.sha).filter((s) => typeof s === 'string')
    : [];
  return {
    headRef: typeof event?.head_ref === 'string' ? event.head_ref : '',
    baseSha: typeof event?.base_sha === 'string' ? event.base_sha : '',
    parents,
    treeSha: typeof commit?.tree?.sha === 'string' ? commit.tree.sha : '',
  };
}

export const MERGE_GROUP_GATE_VALUE_OPTIONS = Object.freeze(['--raw', '--merge-group', '--policy']);

/**
 * Dezelfde fail-closed argumentlezing als de rest van de AUTOCODING_SHIELD-CLI's: token voor token,
 * nooit in vaste paren, elke sleutel verplicht en precies één keer.
 */
export function parseMergeGroupGateArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const options = new Set(MERGE_GROUP_GATE_VALUE_OPTIONS);
  const values = new Map();
  const reject = { ok: false };

  for (let i = 0; i < list.length; i += 1) {
    const token = list[i];
    if (typeof token !== 'string') return reject;
    if (!options.has(token)) return reject;
    if (values.has(token)) return reject;
    i += 1;
    const value = list[i];
    if (typeof value !== 'string' || value.length === 0) return reject;
    if (options.has(value)) return reject;
    values.set(token, value);
  }
  for (const option of MERGE_GROUP_GATE_VALUE_OPTIONS) {
    if (!values.has(option)) return reject;
  }
  return { ok: true, values };
}

/**
 * De volledige beoordeling: lees beide metingen, bouw de PR-eigen shieldcontext via de bestaande
 * adapter, en roep de tweetraps merge-group-controle aan. Geen argument hier is optioneel — een
 * onvolledige aanroep is `MEASUREMENT_UNREADABLE`, nooit een gok.
 */
export function runMergeGroupGate({
  rawDir, mergeGroupDir, policy, readFile,
}) {
  let prMeasurement;
  let mergeGroup;
  try {
    prMeasurement = readPullRequestMeasurement(rawDir, readFile);
    mergeGroup = readMergeGroupMeasurement(mergeGroupDir, readFile);
  } catch {
    return { decision: MERGE_GROUP_GATE_DECISION.NO_GO, reasons: [MERGE_GROUP_GATE_ERROR.MEASUREMENT_UNREADABLE] };
  }

  const { context, shieldInput } = buildShieldInput({
    pr: prMeasurement.pr,
    headCommit: prMeasurement.headCommit,
    prCommits: prMeasurement.prCommits,
    issueComments: prMeasurement.issueComments,
    reviews: prMeasurement.reviews,
    reviewComments: prMeasurement.reviewComments,
    changedFiles: flattenPages(prMeasurement.changedFiles),
    policy,
  });

  const result = evaluateMergeGroupCheck({
    headRef: mergeGroup.headRef,
    mergeGroupBaseSha: mergeGroup.baseSha,
    mergeGroupParents: mergeGroup.parents,
    freshPullRequest: prMeasurement.pr,
    mergeGroupTreeSha: mergeGroup.treeSha,
    evaluateShield,
    evaluateMergeAuthorizations,
    shieldContext: context,
    shieldInput,
    policy,
  });

  return {
    decision: result.decision,
    reasons: result.reasons,
    pull_request: result.pullRequest,
  };
}

/** De CLI-lus. Eén JSON-regel naar stdout, rc 0 bij GO, rc 1 bij elke andere uitkomst. */
export async function runVerifyMergeGroupGate(argv, { readFile } = {}) {
  const meld = (uitkomst) => console.log(JSON.stringify(uitkomst));
  const parsed = parseMergeGroupGateArgs(argv);
  if (!parsed.ok) {
    meld({ decision: MERGE_GROUP_GATE_DECISION.NO_GO, reasons: [MERGE_GROUP_GATE_ERROR.ARGUMENTS_INVALID] });
    return 1;
  }
  const args = parsed.values;

  let policy;
  try {
    if (typeof readFile !== 'function') throw new Error(MERGE_GROUP_GATE_ERROR.MEASUREMENT_UNREADABLE);
    policy = JSON.parse(readFile(args.get('--policy')));
  } catch {
    meld({ decision: MERGE_GROUP_GATE_DECISION.NO_GO, reasons: [MERGE_GROUP_GATE_ERROR.MEASUREMENT_UNREADABLE] });
    return 1;
  }

  const uitkomst = runMergeGroupGate({
    rawDir: args.get('--raw'), mergeGroupDir: args.get('--merge-group'), policy, readFile,
  });
  meld(uitkomst);
  return uitkomst.decision === MERGE_GROUP_GATE_DECISION.GO ? 0 : 1;
}

// Alleen bij directe aanroep. Bij `import` mag hier niets draaien: de tests importeren dit bestand.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFileSync } = await import('node:fs');
  runVerifyMergeGroupGate(process.argv.slice(2), { readFile: (p) => readFileSync(p, 'utf8') })
    .then((rc) => { process.exitCode = rc; })
    .catch(() => { process.exitCode = 1; });
}
