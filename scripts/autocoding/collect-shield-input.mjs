/**
 * AUTOCODING_SHIELD — GitHub-adapter.
 *
 * Zet ruwe, read-only opgehaalde GitHub-API-antwoorden om naar precies de twee bestanden die
 * `verify-review-gate.mjs --shield-input` verwacht: de gemeten `context` en de genormaliseerde
 * `shieldInput`. Alle functies hier zijn puur — ze doen zelf geen netwerkverkeer. De workflow haalt
 * de JSON op met `gh api` (uitsluitend `GET`, `contents/pull-requests/issues: read`) en geeft de
 * bestanden door; daardoor is deze hele laag deterministisch testbaar met vaste fixtures.
 *
 * Drie dingen worden hier mechanisch GEMETEN in plaats van geloofd:
 *
 *   1. Head en tree. Een Codex-comment noemt een AFGEKORTE commit ("`b9df1f8398`"). Die tekst is een
 *      claim. Hij wordt geresolveerd tegen de commit-lijst van de PR zelf (`/pulls/{n}/commits`,
 *      aangevuld met het opgehaalde head-commit-object) — de enige commits die bij deze PR horen.
 *      Precies één prefixtreffer telt; nul of meerdere treffers leveren géén resolutie op, en
 *      onopgelost bewijs faalt verderop gesloten op STALE_HEAD.
 *   2. Gevoelige paden. Uit `/pulls/{n}/files`, niet uit de PR-tekst. Een leeg of ontbrekend
 *      bestandsantwoord geldt als gevoelig: onbekend zicht is nooit een vrijstelling.
 *   3. Transportidentiteit. `user.login`, `user.type` en `performed_via_github_app.id` komen van
 *      GitHub, niet uit een comment-lichaam, en zijn dus niet door een auteur te zetten.
 *
 * Er wordt niets uit deze bestanden gelogd: de beslisser hierna schrijft uitsluitend redencodes.
 */

import { pathToFileURL } from 'node:url';

import {
  extractCodexNativeEvidence, extractGeminiNativeEvidence, extractReceiptFromCommentBody,
  codexReviewedCommitRef,
} from './verify-review-gate.mjs';

const SHA_RE = /^[0-9a-f]{40}$/;
const REF_RE = /^[0-9a-f]{7,40}$/;

/**
 * `gh api --paginate --slurp` levert een array van pagina's; een enkele call levert één array.
 * Beide vormen worden hier tot één vlakke lijst genormaliseerd, onbekende vormen tot een lege lijst.
 */
export function flattenPages(payload) {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((entry) => Array.isArray(entry) ? entry : [entry]);
}

/**
 * Bouwt de commit→tree-index van deze PR: elke commit uit `/pulls/{n}/commits` plus het expliciet
 * opgehaalde head-commit-object. Alleen paren waarvan zowel commit- als tree-SHA volledig zijn
 * komen erin; een half antwoord levert dus geen resolutiegrond op.
 */
export function buildCommitIndex({ prCommits, headSha, headCommit }) {
  const index = new Map();
  for (const entry of flattenPages(prCommits)) {
    const sha = entry?.sha;
    const tree = entry?.commit?.tree?.sha;
    if (SHA_RE.test(sha) && SHA_RE.test(tree)) index.set(sha, tree);
  }
  const headTree = headCommit?.tree?.sha;
  if (SHA_RE.test(headSha) && SHA_RE.test(headTree)) index.set(headSha, headTree);
  return index;
}

/**
 * Resolveert een (mogelijk afgekorte) commit-referentie tegen de commit-index van deze PR.
 * Geeft `null` bij een ongeldige referentie, bij nul treffers, én bij meerdere treffers — een
 * dubbelzinnige prefix is geen meting.
 */
export function resolveCommitRef(ref, commitIndex) {
  if (typeof ref !== 'string') return null;
  const needle = ref.toLowerCase();
  if (!REF_RE.test(needle)) return null;
  let found = null;
  for (const [sha, tree] of commitIndex) {
    if (!sha.startsWith(needle)) continue;
    if (found) return null;
    found = { head_sha: sha, tree_sha: tree };
  }
  return found;
}

/** Leest de gedeclareerde task-id uit het PR-lichaam. Ontbreekt hij, dan blijft hij leeg. */
export function extractTaskId(prBody) {
  if (typeof prBody !== 'string') return '';
  return prBody.match(/^task_id=(\S+)$/m)?.[1] ?? '';
}

/**
 * Bepaalt of de PR een gevoelig pad raakt. Fail-closed: zonder bruikbare bestandslijst — leeg,
 * ontbrekend of zonder policy-globs — geldt de PR als gevoelig, zodat de ownergate juist dán geldt.
 */
export function touchesSensitivePaths(changedFiles, globs) {
  const prefixes = (Array.isArray(globs) ? globs : []).filter((g) => typeof g === 'string' && g.length > 0);
  if (prefixes.length === 0) return true;
  const names = flattenPages(changedFiles)
    .map((f) => f?.filename)
    .filter((n) => typeof n === 'string' && n.length > 0);
  if (names.length === 0) return true;
  return names.some((name) => prefixes.some((prefix) => name.startsWith(prefix)));
}

/**
 * Groepeert reviewcomments op de review waar ze bij horen. GitHub hangt elke inline comment aan
 * `pull_request_review_id`; die koppeling komt van GitHub, niet uit de tekst.
 */
export function groupReviewComments(reviewComments) {
  const byReview = new Map();
  for (const comment of flattenPages(reviewComments)) {
    const id = comment?.pull_request_review_id;
    if (id === undefined || id === null) continue;
    const bodies = byReview.get(id) ?? [];
    bodies.push(typeof comment?.body === 'string' ? comment.body : '');
    byReview.set(id, bodies);
  }
  return byReview;
}

/**
 * De volledige adapter: ruwe GitHub-antwoorden in, `{ context, shieldInput }` uit.
 *
 * Native bewijs komt uitsluitend van de twee gepinde vendorbots (de extractors geven `null` voor
 * elke andere auteur, dus publieke ruis en proza produceren geen bewijsstuk). Ownerreceipts komen
 * uit het letterlijke machineblok in een comment- of reviewlichaam; hun `transport_actor` is de
 * door GitHub geleverde auteur, nooit een zelfgerapporteerd veld.
 */
export function buildShieldInput({
  pr, headCommit, prCommits, issueComments, reviews, reviewComments, changedFiles, policy,
}) {
  const headSha = pr?.head?.sha;
  const commitIndex = buildCommitIndex({ prCommits, headSha, headCommit });

  const context = {
    pr_head_sha: SHA_RE.test(headSha) ? headSha : '',
    pr_tree_sha: SHA_RE.test(headCommit?.tree?.sha) ? headCommit.tree.sha : '',
    builder_actor: typeof pr?.user?.login === 'string' ? pr.user.login : '',
    task_id: extractTaskId(pr?.body),
  };

  const comments = flattenPages(issueComments);
  const reviewList = flattenPages(reviews);
  const commentsByReview = groupReviewComments(reviewComments);

  const nativeEvidence = [];
  for (const comment of comments) {
    const resolved = resolveCommitRef(codexReviewedCommitRef(comment?.body), commitIndex);
    const evidence = extractCodexNativeEvidence(comment, resolved, policy);
    if (evidence) nativeEvidence.push(evidence);
  }
  for (const review of reviewList) {
    const resolved = resolveCommitRef(review?.commit_id, commitIndex);
    const evidence = extractGeminiNativeEvidence(
      review, commentsByReview.get(review?.id) ?? [], resolved, policy,
    );
    if (evidence) nativeEvidence.push(evidence);
  }

  const ownerReceipts = [...comments, ...reviewList].flatMap((item) => {
    const receipt = extractReceiptFromCommentBody(item?.body);
    if (!receipt) return [];
    return [{ receipt, transport_actor: typeof item?.user?.login === 'string' ? item.user.login : '' }];
  });

  return {
    context,
    shieldInput: {
      nativeEvidence,
      ownerReceipts,
      sensitivePathsTouched: touchesSensitivePaths(changedFiles, policy?.owner_gate?.sensitive_path_globs),
    },
  };
}

async function runCli() {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const args = new Map();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) args.set(argv[i], argv[i + 1]);

  const rawDir = args.get('--raw');
  const policyPath = args.get('--policy');
  const outContext = args.get('--out-context');
  const outShieldInput = args.get('--out-shield-input');
  if (!rawDir || !policyPath || !outContext || !outShieldInput) {
    console.log('COLLECT_ARGS_MISSING');
    process.exitCode = 1;
    return;
  }

  // Een ontbrekend of kapot ruw antwoord mag nooit stilzwijgend "niets gevonden" betekenen: dat zou
  // exact op een schone PR lijken. De adapter stopt hier hard, vóór er een beslissing wordt genomen.
  try {
    const read = (name) => JSON.parse(readFileSync(join(rawDir, `${name}.json`), 'utf8'));
    const { context, shieldInput } = buildShieldInput({
      pr: read('pr'),
      headCommit: read('head-commit'),
      prCommits: read('pr-commits'),
      issueComments: read('issue-comments'),
      reviews: read('reviews'),
      reviewComments: read('review-comments'),
      changedFiles: read('files'),
      policy: JSON.parse(readFileSync(policyPath, 'utf8')),
    });
    writeFileSync(outContext, JSON.stringify(context));
    writeFileSync(outShieldInput, JSON.stringify(shieldInput));
  } catch {
    console.log('COLLECT_RAW_INPUT_UNREADABLE');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
