/**
 * AUTOCODING_SHIELD — deterministische statuspublisher.
 *
 * Het probleem dat dit oplost is gemeten, niet bedacht. Een Actions-run die door `issue_comment` of
 * `pull_request_review` wordt getriggerd hangt aan de DEFAULT-BRANCH-SHA, niet aan de PR-head. De
 * checknaam van zo'n run verschijnt dus nooit op de PR-head, en de laatste check die daar wél op
 * staat blijft staan — óók als het bewijs waarop hij groen werd inmiddels verwijderd, bewerkt of
 * dismissed is. Een verwijderd Codex-comment liet zo een groene check achter op een head die niet
 * meer beoordeeld was.
 *
 * De oplossing is de uitspraak niet aan de Actions-checknaam te hangen maar aan een expliciete
 * COMMITSTATUS op de via de API gemeten volledige PR-head, onder een eigen vaste context. Elke
 * relevante eventsoort publiceert opnieuw op diezelfde head, dus de laatst gepubliceerde status is
 * altijd de uitspraak over het actuele bewijs.
 *
 * Twee eigenschappen maken die publicatie convergent:
 *
 *   1. De uitspraak is een pure functie van de API-momentopname, niet van het event. Codex-na-Gemini,
 *      Gemini-na-Codex, een edit, een delete, een dismiss en elke volgorde daarvan lezen dezelfde
 *      momentopname en produceren dus byte-identiek dezelfde status.
 *   2. Alles wat geen bewezen GO is — NO_GO, parsefout, API-truncatie, ontbrekend bewijs,
 *      uitvoeringsfout — publiceert `failure` op precies dezelfde head. Er is geen pad dat zwijgt.
 *
 * De omschrijving bevat uitsluitend redencodes uit een gesloten allowlist; nooit ruwe stderr, een
 * URL, een pad, een modelnaam of bewijsinhoud. De codes worden gesorteerd zodat twee runs met
 * dezelfde bevindingen ook dezelfde tekst schrijven.
 */

import { pathToFileURL } from 'node:url';

import { REASON } from './verify-review-gate.mjs';

const SHA_RE = /^[0-9a-f]{40}$/;
const REPOSITORY_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** GitHub accepteert een statuscontext van maximaal 255 tekens. */
export const STATUS_CONTEXT_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
/** GitHub kapt `description` af op 140 tekens; we kappen zelf, op codegrens. */
export const DESCRIPTION_LIMIT = 140;

/**
 * Fouten die buiten de beslisser zelf ontstaan. Ook dit is een gesloten allowlist van vaste
 * literalen: een uitvoeringsfout mag onherkenbaar worden gereduceerd tot zijn categorie, maar de
 * categorie moet het terminale bericht halen.
 */
export const PUBLISH_ERROR = Object.freeze({
  GATE_EXECUTION_ERROR: 'GATE_EXECUTION_ERROR',
  GATE_RESULT_UNREADABLE: 'GATE_RESULT_UNREADABLE',
  HEAD_UNMEASURED: 'HEAD_UNMEASURED',
  STATUS_CONTEXT_INVALID: 'STATUS_CONTEXT_INVALID',
  REPOSITORY_INVALID: 'REPOSITORY_INVALID',
  UNRECOGNISED_REASON: 'UNRECOGNISED_REASON',
  UNSPECIFIED: 'UNSPECIFIED',
});

const KNOWN_CODES = new Set([...Object.values(REASON), ...Object.values(PUBLISH_ERROR)]);

/**
 * Bouwt de omschrijving uit gesorteerde, allowlisted codes. Onbekende codes worden niet doorgegeven
 * maar evenmin verzwegen: ze worden vervangen door de vaste literal `UNRECOGNISED_REASON`, zodat er
 * nooit een leeg of misleidend "clean" bericht ontstaat.
 */
export function describeReasons(codes) {
  const list = Array.isArray(codes) ? codes : [];
  const known = new Set();
  let sawUnknown = false;
  for (const code of list) {
    if (typeof code === 'string' && KNOWN_CODES.has(code)) known.add(code);
    else sawUnknown = true;
  }
  if (sawUnknown) known.add(PUBLISH_ERROR.UNRECOGNISED_REASON);
  if (known.size === 0) known.add(PUBLISH_ERROR.UNSPECIFIED);

  const sorted = Array.from(known).sort();
  const prefix = 'NO_GO: ';
  const kept = [];
  let length = prefix.length;
  for (const code of sorted) {
    const cost = kept.length === 0 ? code.length : code.length + 1;
    if (length + cost > DESCRIPTION_LIMIT) break;
    kept.push(code);
    length += cost;
  }
  const dropped = sorted.length - kept.length;
  if (dropped === 0) return prefix + kept.join(',');
  // Ruimte vrijmaken voor de "+N"-teller zodat het aantal weggelaten codes altijd zichtbaar blijft.
  const counter = `+${dropped}`;
  while (kept.length > 0 && prefix.length + kept.join(',').length + 1 + counter.length > DESCRIPTION_LIMIT) {
    kept.pop();
  }
  return `${prefix}${[...kept, counter].join(',')}`;
}

/**
 * Zet de gemeten head, de poortuitspraak en een eventuele uitvoeringsfout om naar precies de
 * commitstatus die gepubliceerd moet worden. Pure functie: geen IO, geen event, geen tijd.
 *
 * `state` is `success` uitsluitend bij een bewezen GO zonder uitvoeringsfout. Elke andere uitkomst —
 * inclusief een ontbrekend of onleesbaar resultaat — is `failure` op dezelfde head.
 */
export function resolvePublication({ headSha, statusContext, gateResult, executionError }) {
  if (!SHA_RE.test(headSha ?? '')) {
    return { ok: false, blocked: PUBLISH_ERROR.HEAD_UNMEASURED };
  }
  if (!STATUS_CONTEXT_RE.test(statusContext ?? '')) {
    return { ok: false, blocked: PUBLISH_ERROR.STATUS_CONTEXT_INVALID };
  }

  const error = typeof executionError === 'string' && executionError.length > 0 ? executionError : null;
  const decision = gateResult?.decision;
  const reasons = Array.isArray(gateResult?.reasons) ? gateResult.reasons : [];

  if (!error && decision === 'GO' && reasons.length === 0) {
    return {
      ok: true,
      sha: headSha,
      context: statusContext,
      state: 'success',
      description: 'GO: native two-vendor review verified on this head',
    };
  }

  const codes = [...reasons];
  if (error) codes.push(error);
  if (!error && decision !== 'NO_GO' && decision !== 'GO') codes.push(PUBLISH_ERROR.GATE_RESULT_UNREADABLE);
  return {
    ok: true,
    sha: headSha,
    context: statusContext,
    state: 'failure',
    description: describeReasons(codes),
  };
}

/**
 * Publiceert de commitstatus. De enige schrijfactie in de hele shield, en de enige reden dat de
 * trusted job `statuses: write` heeft. Er wordt niets van het antwoord gelogd behalve de HTTP-code.
 */
export async function publishStatus({ repository, publication, token, fetchImpl }) {
  if (!REPOSITORY_RE.test(repository ?? '')) {
    return { ok: false, blocked: PUBLISH_ERROR.REPOSITORY_INVALID };
  }
  const doFetch = fetchImpl ?? globalThis.fetch;
  const response = await doFetch(
    `https://api.github.com/repos/${repository}/statuses/${publication.sha}`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'autocoding-shield',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({
        state: publication.state,
        context: publication.context,
        description: publication.description,
      }),
    },
  );
  return { ok: response?.status === 201, status: response?.status ?? 0 };
}

/**
 * De CLI-lus. Geeft rc 0 uitsluitend als er een `success`-status is gepubliceerd; elke andere
 * uitkomst geeft rc 1, zodat de job zelf ook rood wordt en er geen stille groene run bestaat.
 */
export async function runPublish(argv, { fetchImpl, readFile } = {}) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 2) args.set(argv[i], argv[i + 1]);

  const repository = args.get('--repository') ?? '';
  const headSha = args.get('--head-sha') ?? '';
  const statusContext = args.get('--status-context') ?? '';
  const resultPath = args.get('--gate-result') ?? '';
  const dryRun = argv.includes('--dry-run');
  let executionError = args.get('--execution-error') ?? '';

  let gateResult = null;
  if (resultPath) {
    try {
      if (typeof readFile !== 'function') throw new Error(PUBLISH_ERROR.GATE_RESULT_UNREADABLE);
      gateResult = JSON.parse(readFile(resultPath));
    } catch {
      gateResult = null;
      if (!executionError) executionError = PUBLISH_ERROR.GATE_RESULT_UNREADABLE;
    }
  } else if (!executionError) {
    executionError = PUBLISH_ERROR.GATE_RESULT_UNREADABLE;
  }

  const publication = resolvePublication({ headSha, statusContext, gateResult, executionError });
  if (!publication.ok) {
    console.log(`LIVE_STATUS_NOT_PUBLISHABLE_${publication.blocked}`);
    return 1;
  }

  if (dryRun) {
    console.log(JSON.stringify(publication));
    return publication.state === 'success' ? 0 : 1;
  }

  const posted = await publishStatus({
    repository, publication, token: process.env.GITHUB_TOKEN, fetchImpl,
  });
  if (!posted.ok) {
    console.log(`LIVE_STATUS_POST_REJECTED_${posted.blocked ?? posted.status}`);
    return 1;
  }
  console.log(`LIVE_STATUS_PUBLISHED_${publication.state.toUpperCase()}`);
  return publication.state === 'success' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFileSync } = await import('node:fs');
  process.exitCode = await runPublish(process.argv.slice(2), {
    readFile: (path) => readFileSync(path, 'utf8'),
  });
}
