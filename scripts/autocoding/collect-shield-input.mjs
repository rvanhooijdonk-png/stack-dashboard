/**
 * AUTOCODING_SHIELD — GitHub-adapter.
 *
 * Zet ruwe, read-only opgehaalde GitHub-API-antwoorden om naar precies de twee bestanden die
 * `verify-review-gate.mjs --shield-input` verwacht: de gemeten `context` en de genormaliseerde
 * `shieldInput`. Alle functies hier zijn puur — ze doen zelf geen netwerkverkeer. De workflow haalt
 * de JSON op met `gh api` (uitsluitend `GET`, `contents/pull-requests/issues: read`) en geeft de
 * bestanden door; daardoor is deze hele laag deterministisch testbaar met vaste fixtures.
 *
 * Vier dingen worden hier mechanisch GEMETEN in plaats van geloofd:
 *
 *   1. Head en tree. Een Codex-comment noemt een AFGEKORTE commit ("`b9df1f8398`"). Die tekst is een
 *      claim. Hij wordt geresolveerd tegen de commit-lijst van de PR zelf (`/pulls/{n}/commits`,
 *      aangevuld met het opgehaalde head-commit-object) — de enige commits die bij deze PR horen.
 *      Precies één prefixtreffer telt; nul of meerdere treffers leveren géén resolutie op, en
 *      onopgelost bewijs faalt verderop gesloten op STALE_HEAD. Voor een REVIEW is er geen tekst
 *      nodig: `review.commit_id` is een API-veld en gaat voor.
 *   2. Volledigheid van het diff-zicht. `/pulls/{n}/files` levert maximaal 3000 bestanden. Het
 *      werkelijk verzamelde aantal wordt tegen `pr.changed_files` gelegd; elke ongelijkheid,
 *      overschrijding of ontbrekende telling is een blinde vlek — geen schone PR.
 *   3. Gevoelige paden. Uit `/pulls/{n}/files`, niet uit de PR-tekst, en per bestandsvermelding op
 *      ALLE paden die eraan hangen: bij een rename dus ook `previous_filename`. Alleen `filename`
 *      lezen liet een rename van `.github/workflows/gate.yml` naar een onbeschermd pad de gevoelige
 *      BRON verliezen. Een leeg, ontbrekend of onbruikbaar bestandsantwoord geldt als gevoelig:
 *      onbekend zicht is nooit een vrijstelling.
 *   4. Transportidentiteit. `user.login`, `user.id`, `user.type` en `performed_via_github_app.id`
 *      komen van GitHub, niet uit een comment-lichaam, en zijn dus niet door een auteur te zetten.
 *
 * Er wordt niets uit deze bestanden gelogd: de beslisser hierna schrijft uitsluitend redencodes.
 */

import { pathToFileURL } from 'node:url';

import {
  extractCodexNativeEvidence, extractCodexReviewEvidence, extractGeminiNativeEvidence,
  extractOwnerApprovalFromBody, codexReviewedCommitRef, isSafeSensitivePrefix,
} from './verify-review-gate.mjs';

const SHA_RE = /^[0-9a-f]{40}$/;
const REF_RE = /^[0-9a-f]{7,40}$/;

/**
 * Harde bovengrens van `GET /repos/{o}/{r}/pulls/{n}/files`: GitHub levert nooit meer dan 3000
 * bestanden, hoeveel pagina's er ook worden opgehaald. Een PR die eroverheen gaat is per definitie
 * niet volledig gemeten en kan dus nooit "raakt geen gevoelig pad" opleveren.
 *
 * De writer haalt overigens veel eerder zijn eigen grens: `gh-bounded-pages.sh` staat hoogstens
 * `LIST_PAGE_BUDGET` pagina's toe en meldt een mogelijk afgekapte oogst fail-closed, zodat een halve
 * bestandslijst niet als schone PR kan eindigen.
 */
export const FILES_API_LIMIT = 3000;

/**
 * De bewijslijsten komen binnen als een array VAN PAGINA's (`[[...],[...]]`) — de vorm die
 * `scripts/autocoding/gh-bounded-pages.sh` schrijft, en daarvóór `gh api --paginate --slurp`. Een
 * enkele call levert één vlakke array. Beide vormen worden hier tot één vlakke lijst genormaliseerd,
 * onbekende vormen tot een lege lijst.
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

/**
 * Bindt een REVIEW aan een commit, en doet dat in drie onderscheiden toestanden.
 *
 * `review.commit_id` is het gezaghebbende API-veld: GitHub zet er de commit in waarop de review
 * werkelijk is geschreven. Het reviewLICHAAM is daarentegen tekst van de vendor zelf, en dus een
 * claim. De eerdere vorm (`api ?? body`) hield die twee niet uit elkaar: viel de resolutie van een
 * AANWEZIG `commit_id` weg — bijvoorbeeld na een force-push, waardoor de gereviewde commit niet
 * meer in de PR-commitindex zit — dan schoof de binding stilzwijgend door naar de tekstclaim. Een
 * review die aantoonbaar op een verdwenen commit is geschreven, kon zo alsnog aan de ACTUELE head
 * gebonden worden zodra zijn lichaam die head noemde. Precies andersom dus: hoe minder betrouwbaar
 * de API-binding, hoe zwaarder de zelfgerapporteerde regel ging wegen.
 *
 * De drie toestanden:
 *
 *   1. `commit_id` ONTBREEKT werkelijk (`null`/`undefined`) — GitHub levert dan geen binding, en de
 *      "Reviewed commit"-regel uit het lichaam is het enige wat er is. Die wordt niet geloofd maar
 *      mechanisch tegen de PR-commitindex geresolveerd, dus een verzonnen SHA levert nog steeds
 *      niets op.
 *   2. `commit_id` is AANWEZIG en resolveert — de API wint, altijd, ook als het lichaam iets anders
 *      beweert.
 *   3. `commit_id` is AANWEZIG maar resolveert NIET (leeg, ongeldig van vorm of type, onbekend in
 *      deze PR, of dubbelzinnig) — dan is de binding onopgelost en blijft zij dat. Geen terugval op
 *      het lichaam. Het bewijsstuk houdt een lege `resolved_head_sha` en kan de headvergelijking
 *      dus nooit halen: onopgelost bewijs is geen bewijs.
 */
export function resolveReviewCommit(review, commitIndex) {
  const apiRef = review?.commit_id;
  // BEWUST `== null` en niet falsy: de lege string is AANWEZIG. Een `commit_id: ""` is een kapotte
  // of leeggemaakte API-binding, geen ontbrekende — die valt onder toestand 3.
  if (apiRef === undefined || apiRef === null) {
    return resolveCommitRef(codexReviewedCommitRef(review?.body), commitIndex);
  }
  return resolveCommitRef(apiRef, commitIndex);
}

/**
 * Leest de gedeclareerde task-id uit het PR-lichaam. Ontbreekt hij, dan blijft hij leeg.
 * GitHub levert PR-lichamen met CRLF-regeleindes; `$` in JS-multiline matcht alleen vóór `\n`, dus
 * de trailing `\r` wordt hier expliciet toegestaan. Zonder dat faalde elke CRLF-PR stil op
 * TASK_MISMATCH.
 */
export function extractTaskId(prBody) {
  if (typeof prBody !== 'string') return '';
  return prBody.match(/^task_id=(\S+)[ \t\r]*$/m)?.[1] ?? '';
}

/**
 * Meet of de bestandsoogst volledig is. `pr.changed_files` is de door GitHub zelf gerapporteerde
 * telling; wijkt het verzamelde aantal daarvan af, ontbreekt de telling, of raakt een van beide de
 * 3000-grens, dan is het diff-zicht onbetrouwbaar. Dit is bewust géén boolean-only functie: de
 * gemeten aantallen blijven beschikbaar voor tests.
 */
export function measureFilesCompleteness(changedFiles, prChangedFiles) {
  const collected = flattenPages(changedFiles)
    .map((f) => f?.filename)
    .filter((n) => typeof n === 'string' && n.length > 0)
    .length;
  const expected = Number.isInteger(prChangedFiles) && prChangedFiles >= 0 ? prChangedFiles : null;
  const complete = expected !== null
    && expected > 0
    && collected === expected
    && collected <= FILES_API_LIMIT;
  return { complete, collected, expected };
}

/**
 * Alle paden waaronder één bestandsvermelding in de diff kan vallen.
 *
 * Een RENAME raakt TWEE paden. GitHub zet het nieuwe pad in `filename` en het oude in
 * `previous_filename`; alleen `filename` lezen betekende dat een rename van
 * `.github/workflows/gate.yml` naar een onbeschermd pad de gevoelige BRON kwijtraakte en de
 * ownergate oversloeg — terwijl juist het weghalen van een workflow de zwaarste wijziging is. Beide
 * richtingen tellen daarom: gevoelig → onbeschermd én onbeschermd → gevoelig.
 *
 * Geeft `null` bij bestandsdata die niet bruikbaar is (ontbrekend of leeg `filename`, of een
 * aanwezig maar ongeldig `previous_filename`). De caller leest dat als fail-closed, niet als "niets
 * gevonden".
 */
export function pathsOfChangedFile(file) {
  if (!file || typeof file !== 'object' || Array.isArray(file)) return null;
  const filename = file.filename;
  if (typeof filename !== 'string' || filename.length === 0) return null;
  const previous = file.previous_filename;
  if (previous === undefined || previous === null) return [filename];
  if (typeof previous !== 'string' || previous.length === 0) return null;
  return [filename, previous];
}

/**
 * Bepaalt of de PR een gevoelig pad raakt. De vergelijking is LETTERLIJKE prefixmatching, geen
 * glob-expansie: `CONTROL/AUTOCODING/` dekt alles onder die map, `*` of `**` dekt niets. Daarom
 * wordt elke prefix eerst door `isSafeSensitivePrefix` gehaald — een patroonachtige waarde zou
 * anders geruisloos nergens op matchen en de ownergate stil uitschakelen.
 *
 * Elke bestandsvermelding wordt op AL zijn paden getoetst, dus ook op `previous_filename` bij een
 * rename.
 *
 * Fail-closed op drie manieren: zonder ENKELE veilige prefix, zonder bestandslijst, en bij een
 * bestandsvermelding waarvan de padvelden onbruikbaar zijn, geldt de PR als gevoelig — dan geldt de
 * ownergate juist wél.
 */
export function touchesSensitivePaths(changedFiles, sensitivePathPrefixes) {
  const raw = Array.isArray(sensitivePathPrefixes) ? sensitivePathPrefixes : [];
  const prefixes = raw.filter((prefix) => isSafeSensitivePrefix(prefix));
  if (prefixes.length === 0) return true;
  const files = flattenPages(changedFiles);
  if (files.length === 0) return true;
  for (const file of files) {
    const paths = pathsOfChangedFile(file);
    if (paths === null) return true;
    if (paths.some((path) => prefixes.some((prefix) => path.startsWith(prefix)))) return true;
  }
  return false;
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
 * elke andere auteur, dus publieke ruis en proza produceren geen bewijsstuk). Beide vendors worden
 * op BEIDE werkelijke GitHub-vormen uitgelezen: Codex levert een schone ronde als issuecomment en
 * bevindingen als review-met-inline-comments; Gemini levert altijd een review. Owner-autorisaties
 * komen uit het letterlijke `autocoding-owner-approval-v1`-blok in een comment- of reviewlichaam;
 * hun `transport_actor` is de door GitHub geleverde auteur, nooit een zelfgerapporteerd veld.
 */
export function buildShieldInput({
  pr, headCommit, prCommits, issueComments, reviews, reviewComments, changedFiles, policy,
}) {
  const headSha = pr?.head?.sha;
  const commitIndex = buildCommitIndex({ prCommits, headSha, headCommit });

  // `pr_number` en `pr_base_sha` horen bij dezelfde gemeten waarheid als head en tree, en worden om
  // dezelfde reden hier afgeleid: uit het door GitHub geleverde PR-object, nooit uit tekst. Ze
  // dragen de binding die een SHA alleen niet kan dragen — twee pull requests kunnen dezelfde head
  // hebben tegen verschillende bases, en dan is de boom identiek terwijl de merge iets heel anders
  // doet. Onmeetbaar betekent hier `0` respectievelijk de lege string, zodat een validator er nooit
  // toevallig gelijkheid mee vindt.
  const baseSha = pr?.base?.sha;
  const context = {
    pr_number: Number.isInteger(pr?.number) && pr.number > 0 ? pr.number : 0,
    pr_head_sha: SHA_RE.test(headSha) ? headSha : '',
    pr_tree_sha: SHA_RE.test(headCommit?.tree?.sha) ? headCommit.tree.sha : '',
    pr_base_sha: SHA_RE.test(baseSha) ? baseSha : '',
    pr_base_ref: typeof pr?.base?.ref === 'string' ? pr.base.ref : '',
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
    const inline = commentsByReview.get(review?.id) ?? [];
    // Drie toestanden, geen `??`-terugval: zie `resolveReviewCommit`. Een aanwezig maar onoplosbaar
    // `commit_id` blijft onopgelost en mag NOOIT door een tekstclaim uit het lichaam worden
    // vervangen.
    const resolved = resolveReviewCommit(review, commitIndex);
    for (const evidence of [
      extractCodexReviewEvidence(review, inline, resolved, policy),
      extractGeminiNativeEvidence(review, inline, resolved, policy),
    ]) {
      if (evidence) nativeEvidence.push(evidence);
    }
  }

  // De DRAGER wordt meegegeven, niet alleen het blok. Een review draagt een `state` die na het
  // schrijven nog verandert: wie zijn review intrekt, laat het lichaam (en dus het autorisatieblok)
  // ongewijzigd staan terwijl GitHub de state op `DISMISSED` zet. Zonder die state kon de validator
  // een ingetrokken autorisatie niet van een actuele onderscheiden. Een issuecomment heeft geen
  // state; dat wordt expliciet als `null` doorgegeven in plaats van weggelaten.
  const ownerCarriers = [
    ...comments.map((item) => ({ item, source: 'issue_comment', review_state: null })),
    ...reviewList.map((item) => ({
      item, source: 'review', review_state: typeof item?.state === 'string' ? item.state : '',
    })),
  ];
  const ownerApprovals = ownerCarriers.flatMap(({ item, source, review_state }) => {
    const approval = extractOwnerApprovalFromBody(item?.body);
    if (!approval) return [];
    return [{
      approval,
      transport_actor: typeof item?.user?.login === 'string' ? item.user.login : '',
      source,
      review_state,
    }];
  });

  const files = measureFilesCompleteness(changedFiles, pr?.changed_files);

  return {
    context,
    shieldInput: {
      nativeEvidence,
      ownerApprovals,
      sensitivePathsTouched: touchesSensitivePaths(
        changedFiles, policy?.owner_gate?.sensitive_path_prefixes,
      ),
      filesComplete: files.complete,
    },
  };
}

/** Sleutels die precies één niet-lege waarde nemen. Alle vier zijn paden. */
export const COLLECT_VALUE_OPTIONS = Object.freeze([
  '--raw', '--policy', '--out-context', '--out-shield-input',
]);

/**
 * Zelfde fail-closed argumentlezing als de publisher, de targetselector en de beslisser: token voor
 * token in plaats van in VASTE PAREN.
 *
 * De paarlezing (`for (i = 0; i < argv.length; i += 2)`) las elke oneven positie als sleutel. Eén
 * extra of ontbrekend token verschoof daardoor STIL alle volgende bindingen — en hier zijn twee van
 * de vier sleutels SCHRIJFpaden. Een verschoven `--out-shield-input` schrijft het bewijsbestand naar
 * een ander pad dan de beslisser hierna leest; die leest dan een oude of afwezige oogst zonder dat
 * er iets aan de uitvoer te zien is.
 *
 * Twee onderscheiden weigeringen, in lijn met de scheiding tussen lees- en schrijffouten hieronder:
 * `COLLECT_ARGS_INVALID` voor argv die niet te lezen valt (onbekend argument, dubbele sleutel,
 * sleutel zonder waarde, lege waarde, sleutel als waarde), `COLLECT_ARGS_MISSING` voor argv die wel
 * klopt maar een vereiste sleutel mist. Beide onder één code samenvatten stuurde de diagnose weg van
 * de oorzaak.
 */
export function parseCollectArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const options = new Set(COLLECT_VALUE_OPTIONS);
  const values = new Map();
  const reject = { ok: false, error: 'COLLECT_ARGS_INVALID' };

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
  for (const option of options) {
    if (!values.has(option)) return { ok: false, error: 'COLLECT_ARGS_MISSING' };
  }
  return { ok: true, values };
}

async function runCli() {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const parsed = parseCollectArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.log(parsed.error);
    process.exitCode = 1;
    return;
  }
  const args = parsed.values;

  const rawDir = args.get('--raw');
  const policyPath = args.get('--policy');
  const outContext = args.get('--out-context');
  const outShieldInput = args.get('--out-shield-input');

  // Lees- en schrijffouten zijn verschillende defecten en krijgen daarom verschillende redencodes.
  // Een ontbrekend of kapot RUW antwoord mag nooit stilzwijgend "niets gevonden" betekenen: dat zou
  // exact op een schone PR lijken. Een mislukte SCHRIJFACTIE zegt daarentegen niets over het bewijs
  // en moet niet als onleesbare invoer worden gerapporteerd — dat stuurde de diagnose de verkeerde
  // kant op.
  let built;
  try {
    const read = (name) => JSON.parse(readFileSync(join(rawDir, `${name}.json`), 'utf8'));
    built = buildShieldInput({
      pr: read('pr'),
      headCommit: read('head-commit'),
      prCommits: read('pr-commits'),
      issueComments: read('issue-comments'),
      reviews: read('reviews'),
      reviewComments: read('review-comments'),
      changedFiles: read('files'),
      policy: JSON.parse(readFileSync(policyPath, 'utf8')),
    });
  } catch {
    console.log('COLLECT_RAW_INPUT_UNREADABLE');
    process.exitCode = 1;
    return;
  }

  try {
    writeFileSync(outContext, JSON.stringify(built.context));
    writeFileSync(outShieldInput, JSON.stringify(built.shieldInput));
  } catch {
    console.log('COLLECT_OUTPUT_UNWRITABLE');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
