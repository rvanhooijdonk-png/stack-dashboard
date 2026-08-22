// AUTOCODING_SHIELD — DE PR-GEBONDEN MERGEFINALIZER.
//
// WAAROM DIT BESTAAT. Tot V17 lag de mergeautorisatie bij een COMMITSTATUS: de trusted writer
// publiceerde `success` op de gemeten head, en een required check op die context zou de merge
// vrijgeven. Codex-bevindingen `3835364972` en `3835364974` toonden dat die constructie principieel
// niet te repareren is:
//
//   - een commitstatus hangt aan de SHA en blijft staan. Wie een uur later een nieuwe pull request
//     opent op diezelfde commit, erft het groen zonder dat er iets over die pull request is gemeten.
//     De autorisatie is dus overdraagbaar, en geen enkele meting op PUBLICATIEmoment kan een
//     toekomstige lezer tegenhouden;
//   - de open-PR-lijst waarmee V17 dat probeerde af te vangen is offsetgepagineerd en dus geen
//     atomaire momentopname: een invoeging tijdens het pagineren verschuift de rest.
//
// De conclusie is niet nog een isolatiepatch maar een andere plaats voor de bevoegdheid. Dit
// bestand is die plaats: één beslisser die de PULL REQUEST ZELF hermeet en, indien geactiveerd,
// uitsluitend díé pull request kan mergen. Er is geen artefact meer dat een tweede pull request kan
// oppakken: het PR-nummer staat in het pad, de sha staat in het lichaam.
//
// V19 — CODEX `3835523940` (P1). De klassieke `PUT .../pulls/{n}/merge` is alleen op de head-sha
// geconditioneerd: GitHub vergelijkt daarbij uitsluitend of de meegegeven `sha` nog de actuele head
// is. Een BASE-retarget of het intrekken van een eigenaarsreview tussen meting B en het werkelijke
// verzoek wordt door die vergelijking niet gezien — noch de base, noch ons eigen reviewbewijs wordt
// door GitHub op het moment van de aanroep herbeoordeeld. Een directe merge-aanroep is daarom nooit
// meer bereikbaar. In plaats daarvan is het EFFECT nu uitsluitend een aanvraag tot INSCHRIJVING in
// GitHubs eigen merge queue — `PUT /repos/{owner}/{repo}/pulls/{number}/merge-async` met
// `merge_action: "merge_queue"` — en die aanvraag wordt zelf pas toegelaten wanneer de meting bewijst
// dat de base van deze pull request een ACTIEVE `merge_queue`-regel draagt
// (`GET /repos/{owner}/{repo}/rules/branches/{base_ref}`, gemeten als `mergeQueueRules`). Ontbreekt
// of is dat bewijs onleesbaar, dan is de uitkomst `NO_GO` en gebeurt er nul verzoeken — er bestaat in
// deze code geen pad meer dat een directe merge doet.
//
// WAAROM DIT DE RACE STRUCTUREEL SLUIT EN NIET ALLEEN VERPLAATST. Het werkelijke mergen gebeurt bij
// een inschrijving niet op het moment van ons verzoek, maar LATER, binnen GitHubs eigen wachtrij —
// en die wachtrij herbeoordeelt de doelbranch vlak vóór het echte mergen opnieuw, als serverkant
// autoriteit. De TOCTOU-opening zat in het feit dat WIJ de laatste beoordelaar waren op een moment
// dat allang voorbij kon zijn; met `merge_queue` is GitHub zelf de laatste beoordelaar, op het
// moment dat het er echt toe doet.
//
// V23 — DE PERSOONLIJKE-REPOSITORYMETING. De V19-constructie hierboven rust op één aanname die op
// DIT object niet houdbaar bleek: dat de base-branch een `merge_queue`-regel KAN dragen. Gemeten
// stand van `rvanhooijdonk-png/stack-dashboard`: publiek, `owner_type=User`, en GitHub weigert er een
// ruleset met `merge_queue` met HTTP 422 — merge queues bestaan uitsluitend op repositories van
// organisaties. De `merge_queue`-tak is daarmee niet fout, maar op dit object ONBEREIKBAAR: hij levert
// er eeuwig `SERVER_MERGE_QUEUE_PROOF_MISSING`, en dus nooit een finalisatie.
//
// V24 — CODEX1-P1 OP V23: EEN STRIKTE RULESET IS GEEN VEILIGE AUTOMATISCHE MERGE. V23 antwoordde op
// die onbereikbaarheid met een tweede EFFECTMODUS, `STRICT_STATUS_CHECKS`: een actieve, strikte
// ruleset lezen en daarna GitHubs standaard `PUT .../pulls/{n}/merge` doen. De review op die stand
// wees uit dat die belofte niet waargemaakt kan worden. Wat een strikte `required_status_checks`-regel
// serverkant afdwingt is precies één ding: dat de branch up-to-date is en dat de VEREISTE CONTEXTEN
// groen zijn. Wat zij NIET afdwingt is ons EIGEN bewijs: het native tweevendorreviewbewijs en het
// ownercomment zijn voor GitHub geen mergevoorwaarde maar gewone reviewdraden en gewone comments. Een
// INGETROKKEN review of een BEWERKT ownerblok tussen meting B en de merge-PUT laat de head-sha
// ongemoeid en laat de vereiste check groen — en die PUT slaagt dan alsnog. De TOCTOU-opening die V19
// sloot stond in V23 dus weer open; smaller, maar open. Een derde clientmeting verkleint dat venster
// alleen en sluit het niet, en is daarom geen reparatie.
//
// De reparatie is niet nog een meting maar het WEGHALEN VAN HET AUTOMATISCHE EFFECT. Sinds V24 kent
// `server_gate_mode` twee standen, en `STRICT_STATUS_CHECKS` is er geen van meer:
//
//   - `MERGE_QUEUE`       — de V19..V22-tak hierboven, ONGEWIJZIGD. Dormante legacy voor een
//                           organisatie-object; op dit persoonlijke repository onbereikbaar.
//   - `MANUAL_OWNER_GATE` — de persoonlijke-repositorystand. Alles wat geautomatiseerd KAN worden
//                           blijft geautomatiseerd: bouwen, reviewen, testen, hermeten, driftdetectie
//                           en het volledige oordeel. Alleen de laatste handeling niet. Het effect van
//                           deze stand is mechanisch NUL mergeverzoeken — `mergePullRequest` eindigt
//                           er fail-closed op `OWNER_MERGE_REQUIRED` — en wat de finalizer oplevert is
//                           een MERGEPAKKET: een bewezen GO die de eigenaar zelf uitvoert.
//
// `STRICT_STATUS_CHECKS` is niet stilzwijgend verdwenen maar EXPLICIET GEWEIGERD
// (`REJECTED_SERVER_GATE_MODE`): een policy die die stand nog draagt is `FINALIZER_POLICY_UNSAFE` en
// komt niet tot een oordeel, laat staan tot een verzoek. De klassieke `PUT .../pulls/{n}/merge` komt
// in dit bestand niet meer voor: er is geen aanroeppad meer dat hem kan bereiken.
//
// EERLIJK OVER WAT DIT NIET IS. Dit is GEEN volledige klasse-B-automerge. Een persoonlijk repository
// kent geen merge queue en geen native goedkeuring door een bot-reviewer; de enige serverkant
// autoriteit die er te krijgen is, is de required-status-check, en die draagt ons reviewbewijs niet.
// Volledig automatisch mergen vereist server-native autorisatie, en die vereist naar alle
// waarschijnlijkheid een ORGANISATIE-object met merge queue en native required reviews. Zolang dat er
// niet is, is de eigenaar de laatste handeling — en zegt deze code dat ook zo.
//
// De merge-groupcode (`autocoding-merge-group-gate`, `required_merge_queue_checks`) blijft in
// `MERGE_QUEUE`-modus staan, maar is in `MANUAL_OWNER_GATE` GEEN vereiste check, geen event en
// geen bewijsbron: die poort draait per ontwerp uitsluitend op een `merge_group`-commit, en die
// bestaat op dit object niet.
//
// SCHEIDING VAN BESLISSING EN EFFECT. `resolveFinalization` is puur: geen netwerk, geen bestanden,
// geen klok. Zij levert een gesloten uitkomst — `FINALIZE_GO` of `FINALIZE_NO_GO` met redencodes
// uit een vaste verzameling. `mergePullRequest` is de enige plaats met transport, doet precies één
// verzoek, en weigert vóór dat verzoek alles wat niet exact klopt.
//
// WAT HIER OPZETTELIJK NIET GEBEURT. Er wordt niets gepubliceerd, geen status geschreven, geen
// review gestart, geen branch aangeraakt en geen tweede reviewwet geparseerd: het native
// tweevendorbewijs, de ownergate en de bewijsbinding komen ongewijzigd uit
// `collect-shield-input.mjs` en `verify-review-gate.mjs`. Dit bestand voegt daar de MERGEspecifieke
// eisen aan toe — PR-binding, base, required checks, driftdetectie, merge-queue-bewijs — en niets
// anders. Er wordt in DEZE PR geen GitHub-ruleset of branch-protection gebouwd, geactiveerd of
// gewijzigd: het bewijs wordt gelezen, niet aangemaakt. Of een repository daadwerkelijk een
// merge-queue-regel draagt is een AFZONDERLIJKE, toekomstige activatiestap.
//
// STAND IN DEZE PR: `merge_finalizer_enabled` en `class_b_auto_merge_enabled` staan allebei op
// `false`. Elke poging tot een echt effect eindigt daardoor op `FINALIZER_DISABLED` vóór er ook maar
// één byte over het netwerk gaat.

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { evaluateShield, evaluateMergeAuthorizations } from './verify-review-gate.mjs';
import { buildShieldInput, flattenPages } from './collect-shield-input.mjs';
import {
  LIST_PAGE_BUDGET,
  CHECKS_PAGE_BUDGET,
  SELECTION_PAGE_BUDGET,
} from './select-live-gate-targets.mjs';

const SHA_RE = /^[0-9a-f]{40}$/;
const REPOSITORY_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const CHECK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,127}$/;
const REF_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const MERGE_ASYNC_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pagina's van `rules/branches/{base_ref}` per meting (V20, scope-item 6). Spiegelbeeld van
 * `GH_BOUNDED_RULES_PAGES` in `gh-bounded-pages.sh`, zoals `LIST_PAGE_BUDGET` en `CHECKS_PAGE_BUDGET`
 * dat al waren voor hun eigen begrensde lijsten. Dit eindpunt is uniek voor de finalizer — geen
 * andere script gebruikt het — dus staat de constante hier en niet in `select-live-gate-targets.mjs`.
 */
const MERGE_QUEUE_RULES_PAGE_BUDGET = 4;

export const MERGE_FINALIZER_SCHEMA = 'AUTOCODING_MERGE_FINALIZER_V1';

/**
 * DE SERVERPOORTMODUS (V23, herzien in V24). Gesloten en verplicht: de policy MOET er precies één
 * noemen, want de modus bepaalt zowel welk bewijs de base-branch moet dragen als welk effect er
 * hoogstens kan volgen. Een ontbrekende, onbekende of GEWEIGERDE waarde is `FINALIZER_POLICY_UNSAFE`
 * — nooit een stilzwijgende terugval op de een of de ander.
 *
 *   MERGE_QUEUE       — actieve `merge_queue`-regel op de base; effect is uitsluitend een
 *                       INSCHRIJVING (`merge-async`, `merge_action: "merge_queue"`). Vereist een
 *                       repository van een ORGANISATIE; op een persoonlijk object weigert GitHub zo'n
 *                       ruleset met HTTP 422, en blijft deze modus dus eeuwig NO_GO.
 *   MANUAL_OWNER_GATE — de persoonlijke-repositorystand (V24). Het oordeel is volledig automatisch en
 *                       even streng als in de andere tak; het EFFECT is mechanisch nul mergeverzoeken
 *                       en hoogstens een MERGEPAKKET dat de eigenaar zelf uitvoert.
 */
export const SERVER_GATE_MODE = Object.freeze({
  MERGE_QUEUE: 'MERGE_QUEUE',
  MANUAL_OWNER_GATE: 'MANUAL_OWNER_GATE',
});

/**
 * DE GEWEIGERDE STANDEN (V24). `STRICT_STATUS_CHECKS` staat hier met naam en toenaam in plaats van
 * simpelweg te ontbreken, en dat is opzet: een verwijderde naam is niet te onderscheiden van een
 * typefout, en zou bij de eerstvolgende poging hem terug te zetten geen enkel spoor van de reden
 * dragen. Een policy die deze stand noemt is UNSAFE — zie `assertMergeFinalizerPolicySafe` — en komt
 * dus nooit tot een oordeel of een verzoek.
 *
 * De grond staat voluit in de kopnotitie: een strikte `required_status_checks`-regel dwingt serverkant
 * uitsluitend een up-to-date branch en groene VEREISTE CONTEXTEN af, nooit ons eigen review- en
 * ownerbewijs. Dat bewijs kan tussen de laatste meting en de merge-PUT verdwijnen zonder dat de
 * head-sha of de check verandert, en de merge slaagt dan alsnog.
 */
export const REJECTED_SERVER_GATE_MODE = Object.freeze({
  STRICT_STATUS_CHECKS: 'STRICT_STATUS_CHECKS',
});

/**
 * De gesloten uitkomstvorm. Twee waarden, meer bestaan er niet. Een aanroeper die iets anders ziet
 * heeft geen derde uitkomst maar een kapotte beslisser, en hoort dat als NO_GO te behandelen.
 */
export const FINALIZE_DECISION = Object.freeze({
  GO: 'FINALIZE_GO',
  NO_GO: 'FINALIZE_NO_GO',
});

/**
 * De toegestane mergevormen. Gesloten, want `merge_method` gaat rechtstreeks het API-lichaam in.
 * Zonder allowlist zou een policywaarde een willekeurig veld kunnen dragen.
 */
export const ALLOWED_MERGE_METHODS = Object.freeze(['merge', 'squash', 'rebase']);

/** De sleutels die het finalizerblok in de policy mag dragen. Alles daarbuiten is UNSAFE. */
const MERGE_FINALIZER_FIELDS = new Set([
  'schema', 'server_gate_mode', 'merge_method', 'allowed_base_refs', 'allowed_builder_actors',
  'required_checks', 'required_merge_queue_checks', 'required_check_app_id', 'candidate_limit',
]);

/** De bovengrens op `candidate_limit`. Zie `finalizerRequestBudget` voor de rekensom erachter. */
export const CANDIDATE_LIMIT_MAX = 25;

/**
 * De redencodes van de BESLISSING. Gesloten en literal: ze worden gelogd, dus mag er nooit een
 * gemeten waarde — een SHA, een pad, een actor, een API-tekst — in terechtkomen.
 *
 * De redenen van de reviewpoort zelf (`REASON`) worden ONGEWIJZIGD overgenomen wanneer die poort
 * NO_GO zegt. Ze worden hier niet hernoemd en niet samengevat: dezelfde bevinding hoort overal
 * dezelfde naam te hebben, anders ontstaat er een tweede vocabulaire naast de reviewwet.
 */
export const FINALIZE_REASON = Object.freeze({
  FINALIZER_DISABLED: 'FINALIZER_DISABLED',
  FINALIZER_POLICY_UNSAFE: 'FINALIZER_POLICY_UNSAFE',
  MEASUREMENT_UNREADABLE: 'MEASUREMENT_UNREADABLE',
  PULL_REQUEST_MISMATCH: 'PULL_REQUEST_MISMATCH',
  PULL_REQUEST_NOT_OPEN: 'PULL_REQUEST_NOT_OPEN',
  PULL_REQUEST_DRAFT: 'PULL_REQUEST_DRAFT',
  HEAD_UNMEASURED: 'HEAD_UNMEASURED',
  TREE_UNMEASURED: 'TREE_UNMEASURED',
  BASE_UNMEASURED: 'BASE_UNMEASURED',
  BASE_REF_NOT_ALLOWED: 'BASE_REF_NOT_ALLOWED',
  MERGE_QUEUE_RULES_UNREADABLE: 'MERGE_QUEUE_RULES_UNREADABLE',
  // V20 — scope-item 6 (CLAUDE4-review): `rules/branches/{base_ref}` is nu net als de vijf
  // bewijslijsten en de check-runs begrensd gepagineerd. Een volle laatste pagina levert géén tweede
  // verzoek op maar zet deze reden: een afgekapte regelset ziet er zonder dit veld uit als een branch
  // zonder regels, en dat is precies het `merge_queue`-bewijs dat scope-item 6 moet dekken.
  MERGE_QUEUE_RULES_INCOMPLETE: 'MERGE_QUEUE_RULES_INCOMPLETE',
  SERVER_MERGE_QUEUE_PROOF_MISSING: 'SERVER_MERGE_QUEUE_PROOF_MISSING',
  // V20 — scope-item 3 (CLAUDE4-review): de inschrijvingsvoorwaarde is nu ÉÉN atomair gemeten
  // conjunctie op DEZELFDE `rules/branches`-meting: een actieve `merge_queue`-regel MET de
  // mergemethode van de policy, PLUS een actieve `required_status_checks`-regel die ELKE vereiste
  // check dekt, PLUS — scope-item 5 — een `integration_id` per context die aan de gepinde
  // producent-app bindt. Ontbreekt of wijkt één van de vier, dan is de conjunctie zelf onwaar en
  // volgt er geen inschrijving; deze drie redenen dragen WELK deel er ontbrak, niet alleen dát.
  MERGE_QUEUE_METHOD_MISMATCH: 'MERGE_QUEUE_METHOD_MISMATCH',
  REQUIRED_STATUS_CHECKS_RULE_MISSING: 'REQUIRED_STATUS_CHECKS_RULE_MISSING',
  REQUIRED_STATUS_CHECKS_CONTEXT_MISSING: 'REQUIRED_STATUS_CHECKS_CONTEXT_MISSING',
  REQUIRED_CHECK_APP_ID_MISMATCH: 'REQUIRED_CHECK_APP_ID_MISMATCH',
  // V24 — HIER STONDEN DE VIER DEELGRONDEN VAN `STRICT_STATUS_CHECKS`
  // (`SERVER_STRICT_RULESET_PROOF_MISSING`, `PULL_REQUEST_RULE_MISSING`,
  // `PULL_REQUEST_MERGE_METHOD_NOT_ALLOWED`, `STRICT_STATUS_CHECKS_POLICY_DISABLED`). Ze zijn met de
  // modus zelf verdwenen en niet zomaar ongebruikt blijven staan: een redencode die geen enkel pad
  // meer kan zetten is geen reserve maar een valse belofte in een log dat juist gesloten hoort te
  // zijn. De grond van hun verdwijnen staat in de kopnotitie (V24) en de naam van de geweigerde
  // modus staat in `REJECTED_SERVER_GATE_MODE`, zodat de reden vindbaar blijft zonder dat er dode
  // literalen achterblijven.
  // V23 — de LIVE base-branch en de door GitHub berekende mergebaarheid. Beide zijn nieuw gemeten
  // velden en horen bij BEIDE modi: ze binden de beslissing aan de stand van de doelbranch zelf, niet
  // alleen aan het basispunt dat in de pull request staat opgeslagen.
  BASE_HEAD_UNMEASURED: 'BASE_HEAD_UNMEASURED',
  MERGEABILITY_UNMEASURED: 'MERGEABILITY_UNMEASURED',
  PULL_REQUEST_NOT_MERGEABLE: 'PULL_REQUEST_NOT_MERGEABLE',
  MERGEABLE_STATE_NOT_CLEAN: 'MERGEABLE_STATE_NOT_CLEAN',
  BUILDER_ACTOR_NOT_ALLOWED: 'BUILDER_ACTOR_NOT_ALLOWED',
  TASK_ID_UNMEASURED: 'TASK_ID_UNMEASURED',
  EVIDENCE_INCOMPLETE: 'EVIDENCE_INCOMPLETE',
  REVIEW_GATE_NO_GO: 'REVIEW_GATE_NO_GO',
  MERGE_AUTHORIZATION_MISSING: 'MERGE_AUTHORIZATION_MISSING',
  CHECK_RUNS_UNREADABLE: 'CHECK_RUNS_UNREADABLE',
  CHECK_RUNS_INCOMPLETE: 'CHECK_RUNS_INCOMPLETE',
  REQUIRED_CHECK_MISSING: 'REQUIRED_CHECK_MISSING',
  REQUIRED_CHECK_NOT_GREEN: 'REQUIRED_CHECK_NOT_GREEN',
  REQUIRED_CHECK_HEAD_MISMATCH: 'REQUIRED_CHECK_HEAD_MISMATCH',
  MEASUREMENT_DRIFT: 'MEASUREMENT_DRIFT',
  ARGUMENTS_INVALID: 'ARGUMENTS_INVALID',
});

/**
 * De foutcodes van het EFFECT. Ook gesloten, en bewust apart van de beslisredenen: een
 * transportuitkomst is iets anders dan een oordeel, en de twee mogen in een log niet op elkaar
 * lijken.
 *
 * Dit zijn de statuscodes van `PUT .../pulls/{n}/merge-async` (niet meer van de klassieke
 * `.../merge`): 400 (nog niet mergebaar, bv. gesloten), 403 (verboden), 404 (repository of pull
 * request onvindbaar), 409 (voor deze pull request staat al een inschrijving in de wachtrij) en 422
 * (validatie geweigerd, of het eindpunt is gespamd). ALLEMAAL TERMINAAL: er is geen retrylus in dit
 * bestand, op geen enkele statuscode. Een 409 hier betekent niet meer "de head is verschoven" —
 * die controle ligt nu bij de inschrijving zelf, verderop in GitHubs wachtrij — maar "er lag al een
 * aanvraag"; ook dat is een reden om te stoppen en niet om opnieuw te proberen.
 */
export const FINALIZE_ERROR = Object.freeze({
  FINALIZER_DISABLED: FINALIZE_REASON.FINALIZER_DISABLED,
  REPOSITORY_INVALID: 'REPOSITORY_INVALID',
  PULL_REQUEST_INVALID: 'PULL_REQUEST_INVALID',
  SHA_INVALID: 'SHA_INVALID',
  MERGE_METHOD_NOT_ALLOWED: 'MERGE_METHOD_NOT_ALLOWED',
  MERGE_NOT_READY: 'MERGE_NOT_READY',
  MERGE_FORBIDDEN: 'MERGE_FORBIDDEN',
  MERGE_RESOURCE_NOT_FOUND: 'MERGE_RESOURCE_NOT_FOUND',
  MERGE_ALREADY_QUEUED: 'MERGE_ALREADY_QUEUED',
  MERGE_REJECTED: 'MERGE_REJECTED',
  MERGE_TRANSPORT_ERROR: 'MERGE_TRANSPORT_ERROR',
  MERGE_STATUS_UNEXPECTED: 'MERGE_STATUS_UNEXPECTED',
  // V20 — CODEX/CLAUDE4-bevinding: een 200/202 op `merge-async` is op zichzelf GEEN bewijs van
  // inschrijving. Het HTTP-statusnummer zegt alleen dat GitHub het VERZOEK heeft aanvaard; wat er
  // werkelijk is gebeurd staat uitsluitend in het LICHAAM (`status`/`details`), en dat lichaam wordt
  // vanaf hier gelezen en getoetst in plaats van genegeerd.
  MERGE_RESPONSE_INVALID: 'MERGE_RESPONSE_INVALID',
  MERGE_RESULT_NOT_ENQUEUED: 'MERGE_RESULT_NOT_ENQUEUED',
  MERGE_RESULT_MISMATCH: 'MERGE_RESULT_MISMATCH',
  MERGE_POLL_EXHAUSTED: 'MERGE_POLL_EXHAUSTED',
  MERGE_POLL_TRANSPORT_ERROR: 'MERGE_POLL_TRANSPORT_ERROR',
  // V24 — DE ENIGE UITKOMST VAN `MANUAL_OWNER_GATE`, en met opzet een BLOKKADE en geen `ok`. Dit is
  // geen fout en geen weigering van GitHub: er is geen verzoek geweest. Het oordeel was GO, het
  // effect is een mergepakket, en de laatste handeling ligt bij de eigenaar. `requests: 0` hoort bij
  // deze code als een eigenschap en niet als toeval — zie `mergePullRequest`, dat in deze stand
  // terugkeert vóór er ook maar een transportfunctie wordt uitgezocht.
  //
  // Hier stonden tot V23 `MERGE_HEAD_MISMATCH` en `MERGE_RESULT_NOT_MERGED`, de codes van de
  // klassieke `PUT .../pulls/{n}/merge`. Die aanroep bestaat in dit bestand niet meer; hun codes
  // dus ook niet.
  OWNER_MERGE_REQUIRED: 'OWNER_MERGE_REQUIRED',
});

/**
 * De gesloten uitkomstwaarden van `status` in het lichaam van `merge-async` en
 * `merge-async/{uuid}` — precies de vier die de API-documentatie noemt. Een vijfde waarde is geen
 * nieuwe status maar een onleesbaar lichaam.
 */
const MERGE_ASYNC_STATUS = Object.freeze({
  PENDING: 'pending',
  ENQUEUED: 'enqueued',
  MERGED: 'merged',
  FAILED: 'failed',
});

/**
 * Hoogstens dit aantal `GET .../merge-async/{uuid}`-pogingen NA het eerste verzoek, wanneer het
 * lichaam van dat eerste verzoek nog `pending` meldt. Begrensd: dit bestand kent geen wachtlus
 * zonder bovengrens, op geen enkel pad. Wordt de grens bereikt zonder terminale status, dan is de
 * uitkomst `MERGE_POLL_EXHAUSTED` — geen aanname over wat er daarna gebeurt.
 */
const MERGE_ASYNC_POLL_BUDGET = 3;

/**
 * De wachttijd, in milliseconden, tussen twee opeenvolgende `GET .../merge-async/{uuid}`-pogingen
 * wanneer het lichaam nog `pending` meldt (V22, Gemini1-bevinding `5000494458`). Zonder deze
 * wachttijd zou dit bestand GitHub in een strakke lus bevragen, meteen na elkaar — geen enkele
 * echte asynchrone bewerking is binnen milliseconden klaar, dus dat is geen polling maar spammen.
 * De wachttijd geldt uitsluitend TUSSEN lezende pollpogingen op een reeds aanvaard verzoek, nooit
 * als een retry op een geweigerd verzoek: die blijven, zoals hierboven, TERMINAAL en zonder wachttijd.
 */
const MERGE_ASYNC_POLL_DELAY_MS = 2000;

/**
 * De echte wachtfunctie voor het pollinterval: een tijdklok, nooit een lus. `mergePullRequest`
 * accepteert een eigen `sleepImpl` zodat een test de wachttijd kan METEN — hoeveel keer, met welke
 * duur, in welke volgorde ten opzichte van de pollverzoeken — zonder hem daadwerkelijk uit te
 * zitten. Zonder een geïnjecteerde `sleepImpl` gebruikt dit bestand deze functie, en dus een echte
 * `setTimeout`.
 */
function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Het aantal API-verzoeken van ÉÉN volledige meting van één kandidaat:
 *
 *   1  `pulls/{n}`
 *   1  `git/commits/{sha}`
 *   1  `git/ref/heads/{base_ref}` — de LIVE base-head (V23)
 *   4  `rules/branches/{base_ref}` maal `MERGE_QUEUE_RULES_PAGE_BUDGET` pagina's — het
 *      serverpoortbewijs (V19, Codex `3835523940`; sinds V20 zelf ook begrensd gepagineerd,
 *      scope-item 6; de meting blijft in BEIDE standen staan, want de regelset zit in de
 *      vingerafdruk en een ruleset die tussen A en B verandert is drift)
 *  20  vijf bewijslijsten maal `LIST_PAGE_BUDGET` pagina's
 *   4  `commits/{sha}/check-runs` maal `CHECKS_PAGE_BUDGET` pagina's
 *  --
 *  31
 */
export const FINALIZER_MEASUREMENT_REQUEST_BUDGET = 1 + 1 + 1 + MERGE_QUEUE_RULES_PAGE_BUDGET
  + (5 * LIST_PAGE_BUDGET) + CHECKS_PAGE_BUDGET;

/**
 * Wat één kandidaat hoogstens kost: TWEE volledige metingen — de beslissing en de hermeting vlak
 * vóór het effect — plus hoogstens één merge-PUT plus, sinds V20, hoogstens `MERGE_ASYNC_POLL_BUDGET`
 * pollpogingen op het lichaam van dat verzoek (CODEX/CLAUDE4: een 202 alleen is geen bewijs van
 * inschrijving, het lichaam moet terminaal `enqueued` worden gelezen). De tweede meting staat voluit
 * in de som en niet als "alleen bij GO": het budget moet het duurste pad dragen, en dat is het pad
 * dat werkelijk tot een merge komt.
 */
export const FINALIZER_PER_CANDIDATE_REQUEST_BUDGET = (2 * FINALIZER_MEASUREMENT_REQUEST_BUDGET) + 1
  + MERGE_ASYNC_POLL_BUDGET;
// De pollpost blijft in deze som staan ook al polt `MANUAL_OWNER_GATE` niet — die stand doet zelfs
// helemaal geen verzoek: het budget moet het DUURSTE pad dragen, en dat is de `MERGE_QUEUE`-tak. Een
// modus die minder kost mag nooit het plafond verlagen waartegen de aanroeper zijn resterende quotum
// afmeet.

/**
 * De begroting van een hele finalizerronde, inclusief de kandidatenlijst die eraan voorafgaat. Bij
 * `CANDIDATE_LIMIT_MAX` kandidaten is dat 4 + 25 × 64 = 1604, en dat past NIET binnen het gedeelde
 * uurquotum minus reserve. Dat is geen ontwerpfout maar precies waarom de aanroeper deze functie
 * afmeet tegen het werkelijk resterende quotum vóór hij begint: `candidate_limit` in de policy staat
 * op 5 (4 + 5 × 64 = 324) en een hogere waarde moet zichzelf kunnen betalen op het moment zelf.
 */
export function finalizerRequestBudget(candidateCount) {
  const count = Number.isInteger(candidateCount) && candidateCount > 0 ? candidateCount : 0;
  return SELECTION_PAGE_BUDGET + (count * FINALIZER_PER_CANDIDATE_REQUEST_BUDGET);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Weigert een finalizerpolicy die niet exact is. Wordt ALTIJD gedraaid, ook wanneer de finalizer
 * uitstaat: een kapotte policy mag niet pas zichtbaar worden op het moment dat iemand de vlag
 * omzet.
 *
 * De scherpste eis staat onderaan: `required_checks` mag de DIAGNOSTISCHE STATUSCONTEXT niet
 * bevatten. Die context is per V18 nooit meer `success` en is bovendien SHA-scoped — hem hier
 * opvoeren zou de hele overdraagbaarheid die deze finalizer moet oplossen langs de achterdeur
 * terugzetten. De naam wordt uit de policy zelf gelezen, dus een hernoeming sleept de weigering mee.
 *
 * WAAROM CHECK RUNS WÉL MOGEN, terwijl commitstatussen dat niet meer doen. Een check run is ook
 * SHA-scoped, maar hij draagt geen AUTORISATIE — hij draagt een uitspraak over de CODE, en die is
 * legitiem een eigenschap van de commit: dezelfde boom levert dezelfde testuitslag, op welke pull
 * request hij ook staat. De PR-binding komt hier van drie andere kanten: het reviewbewijs hangt aan
 * de reviewdraden van deze pull request, de mergeautorisatie noemt exact dit PR-nummer en deze
 * base, en de merge-aanroep zelf draagt het PR-nummer in het pad.
 *
 * `required_checks` EN `required_merge_queue_checks` zijn TWEE verschillende eisen op TWEE
 * verschillende bewijzen (V21, Gemini1 V20-bevinding HIGH #2): `required_checks` toetst of de
 * genoemde check-run daadwerkelijk op de EIGEN head-SHA van déze pull request staat
 * (`resolveRequiredChecks`, hieronder) — en dat kan `autocoding-merge-group-gate` per ontwerp NOOIT
 * zijn, want die run bestaat uitsluitend op een `merge_group`-commit. `required_merge_queue_checks`
 * toetst iets anders: of de BASE-BRANCH-ruleset die check-naam draagt als vereiste,
 * producent-app-gebonden `required_status_checks`-context (`evaluateEnqueuePrecondition`, hieronder)
 * — bewijs- en policyvalidatie op het bestaande `rules/branches`-eindpunt, geen ruleset-wijziging.
 * Eén lijst mag hier nooit de andere vervangen: dat zou óf de op-de-PR-head-groene-check-eis
 * vervalsen, óf de toekomstige merge-queue-eis nooit kunnen dekken.
 */
export function assertMergeFinalizerPolicySafe(policy) {
  const cfg = policy?.merge_finalizer;
  const fail = () => { throw new Error(FINALIZE_REASON.FINALIZER_POLICY_UNSAFE); };
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) fail();
  for (const key of Object.keys(cfg)) {
    if (!MERGE_FINALIZER_FIELDS.has(key)) fail();
  }
  if (cfg.schema !== MERGE_FINALIZER_SCHEMA) fail();
  // V23 — de serverpoortmodus is VERPLICHT en gesloten. Zonder deze waarde zou de beslisser moeten
  // raden welk bewijs de base-branch hoort te dragen en welk effect er hoogstens mag volgen, en dat
  // zijn precies de twee dingen die niemand mag afleiden uit een ontbrekend veld.
  //
  // V24 — de GEWEIGERDE standen worden EERST getoetst, vóór de allowlist. Het resultaat is hetzelfde
  // — `FINALIZER_POLICY_UNSAFE` — maar de volgorde legt vast dat `STRICT_STATUS_CHECKS` een
  // uitdrukkelijk verworpen stand is en niet een naam die toevallig ontbreekt. Wie hem terugzet, moet
  // deze regel weghalen en komt daarmee langs de grond die eronder staat.
  if (Object.values(REJECTED_SERVER_GATE_MODE).includes(cfg.server_gate_mode)) fail();
  if (!Object.values(SERVER_GATE_MODE).includes(cfg.server_gate_mode)) fail();
  if (!ALLOWED_MERGE_METHODS.includes(cfg.merge_method)) fail();

  const bases = cfg.allowed_base_refs;
  if (!Array.isArray(bases) || bases.length === 0) fail();
  for (const ref of bases) {
    if (!isNonEmptyString(ref) || ref === '*' || !REF_NAME_RE.test(ref)) fail();
  }

  const builders = cfg.allowed_builder_actors;
  if (!Array.isArray(builders) || builders.length === 0) fail();
  for (const actor of builders) {
    if (!isNonEmptyString(actor) || actor === '*') fail();
  }

  if (!Number.isInteger(cfg.candidate_limit) || cfg.candidate_limit <= 0
    || cfg.candidate_limit > CANDIDATE_LIMIT_MAX) fail();

  const diagnostic = policy?.diagnostic_status_context;
  const assertCheckNameList = (names) => {
    if (!Array.isArray(names) || names.length === 0) fail();
    const seen = new Set();
    for (const name of names) {
      if (!isNonEmptyString(name) || name === '*' || !CHECK_NAME_RE.test(name)) fail();
      if (seen.has(name)) fail();
      seen.add(name);
      if (isNonEmptyString(diagnostic) && name === diagnostic) fail();
    }
  };
  assertCheckNameList(cfg.required_checks);
  assertCheckNameList(cfg.required_merge_queue_checks);

  // V20 — scope-item 5 (CLAUDE4-review): een contextnaam ALLEEN is geen bewijs. Elke publiceerder die
  // een check run met deze naam kan aanmaken zou hem anders kunnen laten voldoen — een contextnaam is
  // geen namespace. `required_check_app_id` bindt elke vereiste check aan de PRODUCENT-app die de
  // ruleset zelf ook noemt (`integration_id`), niet alleen aan de tekst van zijn naam. Dezelfde
  // gepinde app geldt voor BEIDE lijsten: zowel `autocoding-shield` als `autocoding-merge-group-gate`
  // worden door dezelfde GitHub Actions-app gepubliceerd.
  if (!Number.isInteger(cfg.required_check_app_id) || cfg.required_check_app_id <= 0) fail();
}

/**
 * Normaliseert de check runs van één commit tot precies de vier velden die de beslissing gebruikt.
 *
 * `/commits/{sha}/check-runs` levert geen kale array maar een object met de lijst onder `check_runs`;
 * `gh_bounded_pages` haalt dat veld er met zijn vijfde parameter al uit, zodat hier dezelfde
 * paginavorm binnenkomt als bij elke andere bewijslijst en `flattenPages` ongewijzigd werkt.
 *
 * Een item dat geen object is telt als aanwezig-maar-onbruikbaar en krijgt lege velden. Het wordt
 * NIET weggefilterd: een onleesbare check mag niet als afwezige check verdwijnen, want afwezig en
 * kapot leiden hieronder tot verschillende redencodes.
 */
export function normaliseCheckRuns(payload) {
  return flattenPages(payload).map((run) => ({
    name: typeof run?.name === 'string' ? run.name : '',
    head_sha: typeof run?.head_sha === 'string' ? run.head_sha : '',
    status: typeof run?.status === 'string' ? run.status : '',
    conclusion: typeof run?.conclusion === 'string' ? run.conclusion : '',
  }));
}

/**
 * Toetst de vereiste checks tegen de EXACT gemeten head.
 *
 * Drie onderscheiden uitkomsten, want ze betekenen verschillende dingen:
 *
 *   - de check bestaat niet op deze commit          → `REQUIRED_CHECK_MISSING`
 *   - de check bestaat maar op een ANDERE commit    → `REQUIRED_CHECK_HEAD_MISMATCH`
 *   - de check bestaat op deze commit maar is niet
 *     `completed`/`success` — dus ook `skipped`,
 *     `neutral`, `cancelled` of nog lopend         → `REQUIRED_CHECK_NOT_GREEN`
 *
 * `skipped` telt nadrukkelijk NIET als geslaagd. Een overgeslagen check heeft niets gemeten, en een
 * poort die "niet gedraaid" met "goedgekeurd" verwart is geen poort.
 *
 * Meerdere runs met dezelfde naam (een herstart) tellen alleen als ALLE runs op deze head groen
 * zijn. Een geslaagde herhaling naast een mislukte eerste poging is geen bewijs dat het groen is;
 * het is bewijs dat het één keer niet groen was.
 */
export function resolveRequiredChecks(checkRuns, requiredNames, headSha) {
  const reasons = new Set();
  if (!SHA_RE.test(headSha ?? '')) {
    reasons.add(FINALIZE_REASON.HEAD_UNMEASURED);
    return { ok: false, reasons: Array.from(reasons) };
  }
  const runs = Array.isArray(checkRuns) ? checkRuns : [];
  for (const name of Array.isArray(requiredNames) ? requiredNames : []) {
    const byName = runs.filter((run) => run?.name === name);
    if (byName.length === 0) {
      reasons.add(FINALIZE_REASON.REQUIRED_CHECK_MISSING);
      continue;
    }
    const onHead = byName.filter((run) => run?.head_sha === headSha);
    if (onHead.length === 0) {
      reasons.add(FINALIZE_REASON.REQUIRED_CHECK_HEAD_MISMATCH);
      continue;
    }
    if (onHead.length !== byName.length) reasons.add(FINALIZE_REASON.REQUIRED_CHECK_HEAD_MISMATCH);
    const groen = onHead.every((run) => run?.status === 'completed' && run?.conclusion === 'success');
    if (!groen) reasons.add(FINALIZE_REASON.REQUIRED_CHECK_NOT_GREEN);
  }
  return { ok: reasons.size === 0, reasons: Array.from(reasons) };
}

/**
 * Toetst of de gemeten regelset een ACTIEVE `merge_queue`-regel bevat voor de base van deze pull
 * request. Dit is het bewijs dat GitHub zelf, en niet deze finalizer, de laatste beoordelaar is op
 * het moment dat de merge echt gebeurt (zie de kopnotitie bij V19 / Codex `3835523940`).
 *
 * `rules/branches/{branch}` levert ALLE actieve regels op die uit rulesets op die branch van
 * toepassing zijn, ongeacht de bron. Er wordt hier niets over de rest van die regels beoordeeld —
 * dat is de taak van GitHub zelf op inschrijfmoment — alleen of het TYPE `merge_queue` erbij zit.
 * Geen array, of een leeg antwoord, betekent: geen bewijs, en dus geen inschrijving.
 *
 * `rules` is hier al de PLATTE lijst van regels — de aanroeper heeft `flattenPages` al toegepast op
 * de ruwe array-van-pagina's die `gh_bounded_pages` teruglevert (V20, scope-item 6). Deze functie
 * kent de paginavorm zelf niet.
 */
export function hasActiveMergeQueueRule(rules) {
  if (!Array.isArray(rules)) return false;
  return rules.some((rule) => rule?.type === 'merge_queue');
}

/**
 * Levert de `merge_method` van de eerste ACTIEVE `merge_queue`-regel, of `''` als die er niet is of
 * geen leesbare methode draagt. GitHub levert deze in hoofdletters (`MERGE`/`SQUASH`/`REBASE`); de
 * vergelijking met de policy (kleine letters) gebeurt hoofdletterongevoelig door de aanroeper.
 */
function activeMergeQueueMethod(rules) {
  const regel = rules.find((rule) => rule?.type === 'merge_queue');
  return typeof regel?.parameters?.merge_method === 'string' ? regel.parameters.merge_method : '';
}

/**
 * Bouwt de context→regel-afbeelding van ALLE ACTIEVE `required_status_checks`-regels in de gemeten
 * regelset. Meerdere regels van dit type worden samengevoegd — GitHub staat dat toe, en elke regel
 * draagt zijn eigen contexten — dus een context die op een ANDERE regel dan de eerste staat telt hier
 * evengoed mee. Een niet-tekstuele of lege contextnaam wordt genegeerd: dat is geen bruikbare regel,
 * geen valse dekking.
 */
function requiredStatusCheckContexts(rules) {
  const contexten = new Map();
  for (const rule of rules) {
    if (rule?.type !== 'required_status_checks') continue;
    const lijst = rule?.parameters?.required_status_checks;
    if (!Array.isArray(lijst)) continue;
    for (const item of lijst) {
      if (typeof item?.context !== 'string' || item.context.length === 0) continue;
      contexten.set(item.context, item);
    }
  }
  return contexten;
}

/**
 * DE ATOMAIRE INSCHRIJVINGSVOORWAARDE (V20, scope-item 3 + scope-item 5; V21, Gemini1 V20-bevinding
 * HIGH #2). Eén conjunctie, gemeten op DEZELFDE regelset als `hasActiveMergeQueueRule`, nooit op een
 * tweede of latere meting:
 *
 *   1. een actieve `merge_queue`-regel met de mergemethode van de policy (hoofdletterongevoelig);
 *   2. een actieve `required_status_checks`-regel die ELKE naam uit `cfg.required_merge_queue_checks`
 *      dekt;
 *   3. per gedekte context een `integration_id` die exact `cfg.required_check_app_id` is.
 *
 * Zonder deze drie extra eisen zou een repository die alleen de KALE `merge_queue`-regel draagt —
 * zonder required-status-checks-regel, of met een gedekte context van een WILLEKEURIGE andere
 * publiceerder — door de oude, smallere toets heen komen. Een contextnaam is geen namespace: elke
 * app die een check run met die naam kan aanmaken zou anders aan de vereiste kunnen voldoen zonder
 * ooit de echte `autocoding-shield`- of `autocoding-merge-group-gate`-workflow te hebben gedraaid.
 *
 * `cfg.required_merge_queue_checks` (NIET `cfg.required_checks`, die blijft uitsluitend de op-de-
 * PR-head-check-run-eis dienen — zie de kopnotitie bij `assertMergeFinalizerPolicySafe`) draagt sinds
 * V21 ook `autocoding-merge-group-gate`: de finalizer maakt hiermee VÓÓR elke inschrijving expliciet
 * bewijs- en policymatig vereist dat die poort ooit als vereiste, producent-app-gebonden check in de
 * merge-queue-ruleset van de base-branch bestaat. Dat is bewijs- en policyvalidatie op een bestaand,
 * uitsluitend lezend eindpunt (`rules/branches`) — geen GitHub-rulesetwijziging: zolang die regel
 * elders nog niet is aangemaakt (de huidige, echte stand van deze repository) blijft deze conjunctie
 * dus terecht NO_GO.
 *
 * Cumulatief zoals de rest van dit bestand: elke ontbrekende of foute deeleis krijgt zijn eigen
 * redencode, in plaats van te stoppen bij de eerste.
 */
function evaluateEnqueuePrecondition(rules, cfg) {
  const reasons = new Set();
  if (!hasActiveMergeQueueRule(rules)) {
    reasons.add(FINALIZE_REASON.SERVER_MERGE_QUEUE_PROOF_MISSING);
  } else {
    const methode = activeMergeQueueMethod(rules);
    if (methode.toUpperCase() !== cfg.merge_method.toUpperCase()) {
      reasons.add(FINALIZE_REASON.MERGE_QUEUE_METHOD_MISMATCH);
    }
  }

  const contexten = requiredStatusCheckContexts(rules);
  if (contexten.size === 0) {
    reasons.add(FINALIZE_REASON.REQUIRED_STATUS_CHECKS_RULE_MISSING);
  } else {
    for (const naam of cfg.required_merge_queue_checks) {
      const item = contexten.get(naam);
      if (!item) {
        reasons.add(FINALIZE_REASON.REQUIRED_STATUS_CHECKS_CONTEXT_MISSING);
        continue;
      }
      if (!Number.isInteger(item.integration_id) || item.integration_id !== cfg.required_check_app_id) {
        reasons.add(FINALIZE_REASON.REQUIRED_CHECK_APP_ID_MISMATCH);
      }
    }
  }
  return reasons;
}

/**
 * DE STAND `MANUAL_OWNER_GATE` (V24) — GEEN serverpoorteis, en dat is een uitspraak en geen gat.
 *
 * De serverpoort bestaat in dit bestand om precies één reden: een AUTOMATISCHE merge moet, op het
 * moment dat hij werkelijk gebeurt, nog worden herbeoordeeld door een autoriteit die niet wij zijn.
 * In deze stand gebeurt die merge niet automatisch. Het effect is mechanisch nul verzoeken
 * (`mergePullRequest` eindigt hier op `OWNER_MERGE_REQUIRED` vóór er een transportfunctie wordt
 * uitgezocht), en de laatste handeling is die van de eigenaar, in GitHubs eigen interface, met alle
 * bescherming die daar op dat moment geldt. Er valt hier dus geen venster te bewaken: er is geen
 * verzoek dat een venster opent.
 *
 * Een rulesetEIS zou hier bovendien de fout van V23 in spiegelbeeld herhalen. Ze zou deze stand op
 * dit object even onbereikbaar maken als de wachtrijtak — ruleset 21205251 staat `disabled`, en
 * `rules/branches` levert daardoor een LEGE regelset — zonder ook maar iets veiliger te maken, want
 * wat zij zou afdwingen (up-to-date branch, groene vereiste context) dekt ons review- en ownerbewijs
 * nu juist niet.
 *
 * Wat deze stand WEL bewaakt staat onverkort overeind en staat buiten deze functie: de reviewwet, de
 * ownerautorisatie, de PR-binding, de vereiste checks op de EIGEN head, GitHubs eigen
 * mergebaarheid, de live base-head en de driftvergelijking tussen de twee metingen. Een GO betekent
 * hier dus exact wat hij zegt — het bewijs is compleet — en niets meer dan dat.
 */
function evaluateManualOwnerGatePrecondition() {
  return new Set();
}

/**
 * De serverpoortvoorwaarde van de GEKOZEN modus, op de al platgemaakte regelset. Eén plaats waar de
 * modus wordt vertakt, zodat geen van beide takken per ongeluk de andere kan aanvullen of vervangen.
 *
 * V24 — een expliciete `switch` met een FAIL-CLOSED default in plaats van de ternair van V23. Een
 * ternair heeft geen derde uitkomst: hij geeft elke onbekende stand stilzwijgend aan de tak die
 * toevallig in de `else` staat. Dat is precies het soort stille terugval dat deze poort nergens mag
 * hebben, ook niet op een pad dat `assertMergeFinalizerPolicySafe` vandaag onbereikbaar maakt.
 */
function evaluateServerGatePrecondition(rules, cfg) {
  switch (cfg.server_gate_mode) {
    case SERVER_GATE_MODE.MERGE_QUEUE:
      return evaluateEnqueuePrecondition(rules, cfg);
    case SERVER_GATE_MODE.MANUAL_OWNER_GATE:
      return evaluateManualOwnerGatePrecondition();
    default:
      // Onbereikbaar zolang de policyvalidatie vóór dit punt draait — en juist daarom fail-closed en
      // niet weggelaten: een derde stand die er ooit doorheen glipt mag nooit de tak van een van
      // deze twee erven.
      return new Set([FINALIZE_REASON.FINALIZER_POLICY_UNSAFE]);
  }
}

function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : '').digest('hex');
}

function tekst(value) {
  return typeof value === 'string' ? value : '';
}

function getal(value) {
  return Number.isInteger(value) ? value : 0;
}

function opId(items) {
  return [...items].sort((a, b) => (a.id - b.id) || (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
}

/**
 * De canonieke projectie van een meting: precies die eigenschappen waarvan een verandering de
 * uitspraak kan omdraaien, in een VASTE sleutelvolgorde en op een vaste sortering.
 *
 * Van elk lichaam wordt alleen de digest bewaard, nooit de tekst. Dat is geen zuinigheid maar
 * discipline: deze structuur kan in een log of een artefact belanden, en reviewteksten,
 * autorisatieblokken en PR-omschrijvingen horen daar niet in. Een digest verandert wél zodra er
 * één teken verandert, en dat is alles wat driftdetectie nodig heeft.
 */
function canonicalMeasurement(measurement) {
  const pr = measurement?.pr;
  const reviews = flattenPages(measurement?.reviews).map((r) => ({
    id: getal(r?.id),
    d: `${tekst(r?.state)}|${tekst(r?.commit_id)}|${tekst(r?.user?.login)}|${tekst(r?.submitted_at)}|${digest(r?.body)}`,
  }));
  const reviewComments = flattenPages(measurement?.reviewComments).map((c) => ({
    id: getal(c?.id),
    d: `${getal(c?.pull_request_review_id)}|${tekst(c?.user?.login)}|${tekst(c?.path)}|${tekst(c?.updated_at)}|${digest(c?.body)}`,
  }));
  const issueComments = flattenPages(measurement?.issueComments).map((c) => ({
    id: getal(c?.id),
    d: `${tekst(c?.user?.login)}|${tekst(c?.updated_at)}|${digest(c?.body)}`,
  }));
  const commits = flattenPages(measurement?.prCommits)
    .map((c) => tekst(c?.sha)).sort();
  const files = flattenPages(measurement?.changedFiles)
    .map((f) => `${tekst(f?.filename)}|${tekst(f?.previous_filename)}|${tekst(f?.status)}|${tekst(f?.sha)}`)
    .sort();
  const checks = normaliseCheckRuns(measurement?.checkRuns)
    .map((r) => `${r.name}|${r.head_sha}|${r.status}|${r.conclusion}`)
    .sort();
  // V20 — scope-item 3/5: de vingerafdruk draagt niet langer alleen het TYPE van elke regel, maar ook
  // exact de velden waarop de atomaire inschrijvingsvoorwaarde rust — de mergemethode van de
  // `merge_queue`-regel, en per context van elke `required_status_checks`-regel zijn
  // `integration_id`. Zou dat wegvallen, dan zou een regelset die alleen van METHODE of PRODUCENT-app
  // verandert — zonder het TYPE te veranderen — buiten de driftvergelijking blijven, terwijl precies
  // dat de atomaire voorwaarde omdraait.
  const mergeQueueRules = Array.isArray(measurement?.mergeQueueRules)
    ? flattenPages(measurement.mergeQueueRules).map((rule) => {
      if (rule?.type === 'merge_queue') {
        return `merge_queue|${tekst(rule?.parameters?.merge_method)}`;
      }
      if (rule?.type === 'required_status_checks') {
        const lijst = Array.isArray(rule?.parameters?.required_status_checks)
          ? rule.parameters.required_status_checks : [];
        const contexten = lijst
          .map((item) => `${tekst(item?.context)}:${getal(item?.integration_id)}`)
          .sort().join(',');
        return `required_status_checks|${
          rule?.parameters?.strict_required_status_checks_policy === true}|${contexten}`;
      }
      // De `pull_request`-regel draagt de toegestane mergemethoden. Sinds V24 hangt er geen
      // beslissing meer aan — de eigenaarsstand stelt geen rulesetEIS — maar hij blijft in de
      // vingerafdruk: een regelset die tussen de twee metingen van toegestane METHODE verandert, is
      // een base-branch die onder de pull request is veranderd, en dat hoort drift te zijn ook als
      // deze poort er zelf niets van vindt.
      if (rule?.type === 'pull_request') {
        const methoden = Array.isArray(rule?.parameters?.allowed_merge_methods)
          ? rule.parameters.allowed_merge_methods.map((m) => tekst(m)).sort().join(',')
          : '';
        return `pull_request|${methoden}`;
      }
      return `${tekst(rule?.type)}|`;
    }).sort()
    : null;

  return {
    pull_request: {
      number: getal(pr?.number),
      state: tekst(pr?.state),
      draft: pr?.draft === true,
      merged: pr?.merged === true,
      head_sha: tekst(pr?.head?.sha),
      base_sha: tekst(pr?.base?.sha),
      base_ref: tekst(pr?.base?.ref),
      user_login: tekst(pr?.user?.login),
      changed_files: getal(pr?.changed_files),
      // V23 — de door GITHUB berekende mergebaarheid. Drie onderscheiden waarden en geen twee:
      // `null` is "nog niet berekend" en mag nooit met `false` samenvallen, anders zou een meting die
      // van onbekend naar niet-mergebaar kantelt buiten de driftvergelijking blijven.
      mergeable: typeof pr?.mergeable === 'boolean' ? pr.mergeable : null,
      mergeable_state: tekst(pr?.mergeable_state),
      body: digest(pr?.body),
    },
    head_commit: {
      sha: tekst(measurement?.headCommit?.sha),
      tree_sha: tekst(measurement?.headCommit?.tree?.sha),
    },
    // V23 — waar de BASE-BRANCH op dit moment werkelijk staat. Beweegt die tussen de twee metingen,
    // dan verschilt de vingerafdruk en volgt er geen effect.
    base_head: { sha: tekst(measurement?.baseHead?.object?.sha) },
    evidence_complete: measurement?.evidenceComplete === true,
    checks_complete: measurement?.checksComplete === true,
    merge_queue_rules_complete: measurement?.mergeQueueRulesComplete === true,
    reviews: opId(reviews),
    review_comments: opId(reviewComments),
    issue_comments: opId(issueComments),
    commits,
    files,
    checks,
    merge_queue_rules: mergeQueueRules,
  };
}

/**
 * De vingerafdruk van een meting. Twee metingen met dezelfde vingerafdruk zijn voor deze poort
 * dezelfde waarheid; verschillen ze, dan is er tussen beslissing en effect iets bewogen en volgt er
 * geen merge.
 *
 * De twee VOLLEDIGHEIDSVLAGGEN horen er even hard bij als de inhoud. Een lijst die in meting A
 * volledig was en in meting B op de paginagrens afkapt, ziet er na afkapping uit als een pull request
 * met minder bewijs — en zonder deze velden zou juist die verandering onzichtbaar blijven wanneer de
 * afgekapte staart toevallig niets bevatte.
 *
 * Dit vangt méér dan een headvergelijking: een ingetrokken review, een bewerkt reviewlichaam, een
 * nieuwe inline bevinding, een omgeslagen check en een verwijderd autorisatieblok laten de head
 * ongemoeid maar veranderen de uitspraak. Een sha-vergelijking alleen zou die allemaal missen.
 */
export function measurementFingerprint(measurement) {
  return digest(JSON.stringify(canonicalMeasurement(measurement)));
}

/**
 * DE BESLISSING. Puur: geen netwerk, geen bestanden, geen klok, geen `process`.
 *
 * De volgorde is fail-closed en cumulatief — er wordt niet bij de eerste tegenstem gestopt, zodat
 * het log alle gronden draagt en niet alleen de eerste. Alleen een LEGE redenverzameling levert
 * `FINALIZE_GO`.
 *
 * KLASSE A EN B. Klasse A is de gewone weg: de merge vereist een ownerautorisatie die exact aan dit
 * PR-nummer, deze head, deze boom, deze base en deze task bindt (`evaluateMergeAuthorizations`).
 * Klasse B is de latere autofinalisatie voor werk dat geen gevoelig pad raakt; die staat uit
 * (`class_b_auto_merge_enabled: false`) en kan dus vandaag nooit een ownerautorisatie vervangen.
 * Zolang de vlag uit staat is ELKE kandidaat klasse A.
 */
export function resolveFinalization({ pullRequest, measurement, policy }) {
  const reasons = new Set();
  const add = (code) => reasons.add(code);

  try {
    assertMergeFinalizerPolicySafe(policy);
  } catch {
    // Zonder geldige finalizerpolicy is er geen mergemethode, geen basereeks en geen checkeis. Er
    // valt dan niets te beslissen; verder meten zou een oordeel suggereren dat op niets rust.
    return { decision: FINALIZE_DECISION.NO_GO, reasons: [FINALIZE_REASON.FINALIZER_POLICY_UNSAFE] };
  }
  const cfg = policy.merge_finalizer;

  if (policy?.merge_finalizer_enabled !== true) add(FINALIZE_REASON.FINALIZER_DISABLED);

  const pr = measurement?.pr;
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) {
    add(FINALIZE_REASON.MEASUREMENT_UNREADABLE);
    return { decision: FINALIZE_DECISION.NO_GO, reasons: Array.from(reasons) };
  }

  // Het gevraagde nummer en het gemeten nummer moeten hetzelfde zijn. Dit is de eerste helft van de
  // PR-binding: een meting van PR B kan nooit de finalisatie van PR A dragen, ook niet wanneer alle
  // SHA's toevallig gelijk zijn.
  const gevraagd = Number.isInteger(pullRequest) && pullRequest > 0 ? pullRequest : 0;
  const gemeten = Number.isInteger(pr.number) && pr.number > 0 ? pr.number : 0;
  if (gevraagd === 0 || gemeten === 0 || gevraagd !== gemeten) {
    add(FINALIZE_REASON.PULL_REQUEST_MISMATCH);
  }

  if (pr.state !== 'open' || pr.merged === true) add(FINALIZE_REASON.PULL_REQUEST_NOT_OPEN);
  if (pr.draft === true) add(FINALIZE_REASON.PULL_REQUEST_DRAFT);

  const { context, shieldInput } = buildShieldInput({
    pr,
    headCommit: measurement?.headCommit,
    prCommits: measurement?.prCommits,
    issueComments: measurement?.issueComments,
    reviews: measurement?.reviews,
    reviewComments: measurement?.reviewComments,
    changedFiles: measurement?.changedFiles,
    policy,
  });

  if (!SHA_RE.test(context.pr_head_sha)) add(FINALIZE_REASON.HEAD_UNMEASURED);
  if (!SHA_RE.test(context.pr_tree_sha)) add(FINALIZE_REASON.TREE_UNMEASURED);
  if (!SHA_RE.test(context.pr_base_sha)) add(FINALIZE_REASON.BASE_UNMEASURED);
  if (!cfg.allowed_base_refs.includes(context.pr_base_ref)) {
    add(FINALIZE_REASON.BASE_REF_NOT_ALLOWED);
  }

  // V23 — DE LIVE BASE-HEAD. `pr.base.sha` is het basispunt dat in de pull request staat opgeslagen
  // en zegt niets over waar de base-branch NU staat; die wordt sinds V23 apart gemeten
  // (`GET /repos/{o}/{r}/git/ref/heads/{base_ref}`, gelezen als `measurement.baseHead`). Er wordt
  // hier bewust GEEN gelijkheid met `pr.base.sha` geëist: die twee mogen legitiem verschillen zodra
  // de base één commit verder is, en een gelijkheidseis op een veld met onzekere semantiek zou een
  // poort zijn die soms per ongeluk sluit in plaats van altijd om de juiste reden. Wat deze meting
  // WEL doet: zij zit in de vingerafdruk, dus een base die tussen meting A en B beweegt is
  // `MEASUREMENT_DRIFT` en nul verzoeken — precies de base-verschuiving die de klassieke
  // `PUT .../merge` zelf niet ziet.
  if (!SHA_RE.test(tekst(measurement?.baseHead?.object?.sha))) {
    add(FINALIZE_REASON.BASE_HEAD_UNMEASURED);
  }

  // V23 — DE MERGEBAARHEID, zoals GITHUB die berekent. `mergeable` is asynchroon: `null` betekent
  // "nog niet berekend", en dat is een ONTBREKENDE meting, geen negatieve. Alleen `mergeable === true`
  // MET `mergeable_state === 'clean'` telt: `clean` is de enige stand waarin GitHub zelf zegt dat er
  // niets meer tegenhoudt — geen conflict, geen achterstand op de base onder een strikte regel, geen
  // openstaande vereiste. `unstable`, `behind`, `blocked`, `dirty` en `unknown` zijn stuk voor stuk
  // NO_GO.
  if (typeof pr.mergeable !== 'boolean') {
    add(FINALIZE_REASON.MERGEABILITY_UNMEASURED);
  } else if (pr.mergeable !== true) {
    add(FINALIZE_REASON.PULL_REQUEST_NOT_MERGEABLE);
  }
  if (tekst(pr.mergeable_state) !== 'clean') add(FINALIZE_REASON.MERGEABLE_STATE_NOT_CLEAN);

  // HET SERVERPOORTBEWIJS EN DE REGELSETMETING. In `MERGE_QUEUE` is dit de dragende voorwaarde:
  // zonder een ACTIEVE `merge_queue`-regel op deze base is er niets dat de merge herbeoordeelt op het
  // moment dat het er echt toe doet, en blijft elk effect een ongedekte belofte. In
  // `MANUAL_OWNER_GATE` stelt de poort geen rulesetEIS — zie `evaluateManualOwnerGatePrecondition`
  // voor waarom die eis daar niets zou toevoegen — maar wordt de regelset nog steeds VOLLEDIG
  // gemeten. Dat is geen restant: de regelset zit in de vingerafdruk, dus een ruleset die tussen de
  // twee metingen verandert is `MEASUREMENT_DRIFT`, in beide standen.
  //
  // Dit is geen ruleset die hier wordt aangemaakt — alleen gelezen bewijs dat er elders al één
  // bestaat. `measurement.mergeQueueRules` draagt de naam van zijn eerste gebruik, maar is de
  // generieke `rules/branches/{base_ref}`-uitkomst.
  //
  // Sinds V20 (scope-item 6) is deze lijst zelf ook begrensd gepagineerd, net als de vijf
  // bewijslijsten en de check-runs: `measurement.mergeQueueRules` is een array-van-pagina's, en moet
  // eerst via `flattenPages` plat worden gemaakt. Een afkapping op de laatst toegestane pagina is
  // GEEN "geen regels" — dat zou een branch met genoeg actieve rulesets kunnen laten voorkomen als
  // een branch zonder merge-queue-bewijs, en dus fail-open zijn. `mergeQueueRulesComplete` vangt dat.
  if (!Array.isArray(measurement?.mergeQueueRules)) {
    add(FINALIZE_REASON.MERGE_QUEUE_RULES_UNREADABLE);
  } else {
    if (measurement?.mergeQueueRulesComplete !== true) {
      add(FINALIZE_REASON.MERGE_QUEUE_RULES_INCOMPLETE);
    }
    for (const r of evaluateServerGatePrecondition(flattenPages(measurement.mergeQueueRules), cfg)) {
      add(r);
    }
  }

  if (!cfg.allowed_builder_actors.includes(context.builder_actor)) {
    add(FINALIZE_REASON.BUILDER_ACTOR_NOT_ALLOWED);
  }
  if (!isNonEmptyString(context.task_id)) add(FINALIZE_REASON.TASK_ID_UNMEASURED);

  // Onvolledig bewijs is geen schoon bewijs. Een op de paginagrens afgekapte lijst LIJKT op een pull
  // request zonder tegenstem, en dat verschil is precies wat hier telt.
  if (measurement?.evidenceComplete !== true) add(FINALIZE_REASON.EVIDENCE_INCOMPLETE);

  // De reviewwet, ongewijzigd en via dezelfde evaluator als de diagnostische route. Er staat hier
  // met opzet geen tweede parser van hetzelfde bewijs.
  const shield = evaluateShield({
    nativeEvidence: shieldInput.nativeEvidence,
    ownerApprovals: shieldInput.ownerApprovals,
    sensitivePathsTouched: shieldInput.sensitivePathsTouched,
    filesComplete: shieldInput.filesComplete,
    context,
    policy,
  });
  if (shield.decision !== 'GO') {
    add(FINALIZE_REASON.REVIEW_GATE_NO_GO);
    for (const r of shield.reasons) add(r);
  }

  const klasseB = policy?.class_b_auto_merge_enabled === true
    && shieldInput.sensitivePathsTouched === false
    && shieldInput.filesComplete === true;
  if (!klasseB) {
    const autorisatie = evaluateMergeAuthorizations(
      shieldInput.ownerApprovals, context, policy?.owner_gate,
    );
    if (autorisatie.decision !== 'GO') {
      add(FINALIZE_REASON.MERGE_AUTHORIZATION_MISSING);
      for (const r of autorisatie.reasons) add(r);
    }
  }

  if (measurement?.checksComplete !== true) add(FINALIZE_REASON.CHECK_RUNS_INCOMPLETE);
  const runs = normaliseCheckRuns(measurement?.checkRuns);
  if (runs.length === 0) add(FINALIZE_REASON.CHECK_RUNS_UNREADABLE);
  for (const r of resolveRequiredChecks(runs, cfg.required_checks, context.pr_head_sha).reasons) {
    add(r);
  }

  if (reasons.size > 0) {
    return { decision: FINALIZE_DECISION.NO_GO, reasons: Array.from(reasons) };
  }
  return {
    decision: FINALIZE_DECISION.GO,
    reasons: [],
    finalization_class: klasseB ? 'B' : 'A',
    merge: {
      pull_request: gemeten,
      sha: context.pr_head_sha,
      merge_method: cfg.merge_method,
      server_gate_mode: cfg.server_gate_mode,
    },
  };
}

/**
 * DE `MERGE_QUEUE`-TAK VAN HET EFFECT. Precies één verzoek, en alleen dit verzoek:
 * `PUT /repos/{o}/{r}/pulls/{n}/merge-async` met `merge_action: "merge_queue"`. Geen ander
 * `merge_action` is ooit toegestaan — niet `direct_merge`, niet `default` — want beide zouden GitHub
 * kunnen laten kiezen voor een directe merge buiten de wachtrij om, en dat is precies de aanroep die
 * V19 sluit (zie de kopnotitie, Codex `3835523940`). `resolveFinalization` heeft vóór dit punt al
 * bewezen dat de base van deze pull request een actieve `merge_queue`-regel draagt; zonder dat bewijs
 * is de uitkomst allang `NO_GO` en wordt deze functie niet met een GO-resultaat aangeroepen.
 *
 * Wat er NIET in het lichaam mag, en waarom:
 *
 *   - een BRANCHNAAM. Een branch beweegt; tussen beslissing en aanroep kan er een commit bij zijn
 *     gekomen en dan schrijft GitHub iets in de wachtrij wat niemand heeft gezien;
 *   - een AFGEKORTE SHA. Zeven tekens zijn geen identiteit maar een prefix, en GitHub zou hem
 *     weigeren of — erger — oplossen;
 *   - een SHA UIT EEN EVENTPAYLOAD. Die is bezorgd, niet gemeten.
 *
 * De `sha` uit `resolveFinalization` is de VOLLEDIGE, zelf gemeten head, en bindt de inschrijving
 * aan exact die commit. Wat deze aanroep NIET meer zelf doet, is het echte mergen: dat verschuift
 * naar GitHubs eigen wachtrij, die de doelbranch op het moment van het werkelijke mergen opnieuw
 * beoordeelt. Elke statuscode hieronder is TERMINAAL — er is geen retrylus, op geen enkele code.
 *
 * De policyweigering staat vóór ELK netwerkverkeer en vóór elke andere validatie. Met de vlaggen op
 * `false` doet een aanroep dus nul verzoeken, ook wanneer alle argumenten kloppen.
 */
/**
 * Leest en toetst het lichaam van `merge-async`/`merge-async/{uuid}` tegen het EXACTE schema uit de
 * primaire documentatie. `null` betekent: geen bruikbaar lichaam — nooit een gok naar de dichtstbije
 * bekende vorm.
 */
function parseMergeAsyncBody(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Object.values(MERGE_ASYNC_STATUS).includes(raw.status)) return null;
  const details = raw.details;
  if (details !== undefined && details !== null
    && (typeof details !== 'object' || Array.isArray(details))) return null;
  return {
    status: raw.status,
    uuid: typeof details?.uuid === 'string' ? details.uuid : '',
    mergeAction: typeof details?.merge_action === 'string' ? details.merge_action : '',
    expectedHeadSha: typeof details?.expected_head_sha === 'string' ? details.expected_head_sha : '',
  };
}

/**
 * Of een TERMINAAL lichaam echt een inschrijving in de wachtrij bewijst. Drie eisen tegelijk, geen
 * enkele optioneel: de status is letterlijk `enqueued`, de actie is letterlijk `merge_queue` — nooit
 * `direct_merge` of `default`, die zouden een directe merge kunnen betekenen — en de verwachte head
 * in het lichaam is EXACT de sha die is aangevraagd. `merged` en `failed` zijn met opzet UITGESLOTEN
 * van dit predicaat: al gemerged is geen bewezen wachtrij-inschrijving, ook al is het geen fout.
 */
function isProvenQueueEnrollment(body, sha) {
  return body?.status === MERGE_ASYNC_STATUS.ENQUEUED
    && body.mergeAction === 'merge_queue'
    && SHA_RE.test(body.expectedHeadSha)
    && body.expectedHeadSha === sha;
}

/**
 * Eén poging om het resultaat van een lopende asynchrone merge op te halen. Retourneert een gesloten
 * vorm — nooit de ruwe fetch-uitzondering of -tekst — zodat de aanroeper daar niet opnieuw op hoeft
 * te controleren.
 */
async function fetchMergeAsyncResult({
  repository, pullRequest, uuid, token, doFetch,
}) {
  let response;
  try {
    response = await doFetch(
      `https://api.github.com/repos/${repository}/pulls/${pullRequest}/merge-async/${uuid}`,
      {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'user-agent': 'autocoding-shield',
          'x-github-api-version': '2022-11-28',
        },
      },
    );
  } catch {
    return { kind: 'transport' };
  }
  if (response?.status !== 200) return { kind: 'transport' };
  let raw;
  try {
    raw = await response.json();
  } catch {
    return { kind: 'invalid' };
  }
  const body = parseMergeAsyncBody(raw);
  if (!body) return { kind: 'invalid' };
  return { kind: 'body', body };
}

/**
 * HET EFFECT — DE GEDEELDE POORT EN DE ENIGE VERTAKKING (V24). Deze functie doet zelf geen enkel
 * verzoek. Zij weigert eerst, in vaste volgorde en vóór ELK netwerkverkeer, alles wat niet exact
 * klopt — de uitgeschakelde vlag, een onexacte policy, een onbruikbaar repository, PR-nummer of sha,
 * een mergemethode die niet die van de policy is — en kiest daarna op grond van `server_gate_mode`
 * precies één tak:
 *
 *   `MANUAL_OWNER_GATE` → NIETS. Terminaal `OWNER_MERGE_REQUIRED` met `requests: 0`, vóór er een
 *                         transportfunctie wordt uitgezocht, laat staan gebruikt. Dit is de stand van
 *                         dit persoonlijke repository, en de reden dat hij bestaat staat in de
 *                         kopnotitie (V24): een strikte ruleset kan ons review- en ownerbewijs
 *                         serverkant niet afdwingen, dus mag er hier geen automatische merge zijn;
 *   `MERGE_QUEUE`       → `enqueueInMergeQueue`, de V19..V22-inschrijving via `merge-async`.
 *
 * Er is geen derde tak, geen pad dat beide raakt, geen pad dat de modus ergens anders dan uit de
 * policy haalt, en — sinds V24 — geen pad in dit hele bestand dat de klassieke
 * `PUT .../pulls/{n}/merge` nog aanroept. Met `merge_finalizer_enabled: false` eindigt elke aanroep
 * bovendien al bij de eerste regel op `FINALIZER_DISABLED` met `requests: 0`, hoe exact de rest van
 * de argumenten ook is.
 *
 * `resolveFinalization` heeft vóór dit punt bewezen dat de base van deze pull request het bewijs van
 * DEZELFDE modus draagt; zonder dat bewijs is de uitkomst allang `NO_GO` en wordt deze functie niet
 * met een GO-resultaat aangeroepen.
 *
 * V22 — Gemini1-bevinding `5000494458`: `sleepImpl` wordt hier alleen doorgegeven, niet gebruikt. De
 * wachttijd hoort bij het pollen van de queue-tak; de eigenaarsstand doet geen enkel verzoek en kent
 * dus ook geen wachttijd.
 */
export async function mergePullRequest({
  repository, pullRequest, sha, mergeMethod, policy, token, fetchImpl, sleepImpl,
}) {
  if (policy?.merge_finalizer_enabled !== true) {
    return { ok: false, blocked: FINALIZE_ERROR.FINALIZER_DISABLED, requests: 0 };
  }
  try {
    assertMergeFinalizerPolicySafe(policy);
  } catch {
    return { ok: false, blocked: FINALIZE_REASON.FINALIZER_POLICY_UNSAFE, requests: 0 };
  }
  if (!REPOSITORY_RE.test(repository ?? '')) {
    return { ok: false, blocked: FINALIZE_ERROR.REPOSITORY_INVALID, requests: 0 };
  }
  if (!Number.isInteger(pullRequest) || pullRequest <= 0) {
    return { ok: false, blocked: FINALIZE_ERROR.PULL_REQUEST_INVALID, requests: 0 };
  }
  if (!SHA_RE.test(sha ?? '')) {
    return { ok: false, blocked: FINALIZE_ERROR.SHA_INVALID, requests: 0 };
  }
  if (!ALLOWED_MERGE_METHODS.includes(mergeMethod)
    || mergeMethod !== policy.merge_finalizer.merge_method) {
    return { ok: false, blocked: FINALIZE_ERROR.MERGE_METHOD_NOT_ALLOWED, requests: 0 };
  }

  // DE ENIGE VERTAKKING VAN HET EFFECT (V24), en zij staat VÓÓR de keuze van de transportfunctie.
  // Dat is opzet: in `MANUAL_OWNER_GATE` mag de uitkomst niet afhangen van de vraag of er toevallig
  // een `fetch` beschikbaar is. Er is geen verzoek — niet één, en niet onder welke omstandigheid dan
  // ook — en de code hoort dat te zeggen op een plaats waar geen enkele omgevingsfactor er nog
  // tussen kan komen.
  const modus = policy.merge_finalizer.server_gate_mode;
  if (modus === SERVER_GATE_MODE.MANUAL_OWNER_GATE) {
    return { ok: false, blocked: FINALIZE_ERROR.OWNER_MERGE_REQUIRED, requests: 0 };
  }
  if (modus !== SERVER_GATE_MODE.MERGE_QUEUE) {
    // Onbereikbaar zolang de policyvalidatie hierboven draait, en om dezelfde reden als in
    // `evaluateServerGatePrecondition` tóch geschreven: een onbekende stand krijgt nooit de tak van
    // een bekende.
    return { ok: false, blocked: FINALIZE_REASON.FINALIZER_POLICY_UNSAFE, requests: 0 };
  }

  const doFetch = fetchImpl ?? globalThis.fetch;
  const wacht = typeof sleepImpl === 'function' ? sleepImpl : defaultSleep;
  if (typeof doFetch !== 'function') {
    return { ok: false, blocked: FINALIZE_ERROR.MERGE_TRANSPORT_ERROR, requests: 0 };
  }
  return enqueueInMergeQueue({ repository, pullRequest, sha, mergeMethod, token, doFetch, wacht });
}

/**
 * DE `MERGE_QUEUE`-TAK — ongewijzigd sinds V22, en op een persoonlijk repository onbereikbaar. Precies
 * één schrijvend verzoek (de `PUT` op `merge-async`) gevolgd door hoogstens `MERGE_ASYNC_POLL_BUDGET`
 * LEZENDE pollpogingen op datzelfde asynchrone verzoek.
 */
async function enqueueInMergeQueue({
  repository, pullRequest, sha, mergeMethod, token, doFetch, wacht,
}) {
  let response;
  try {
    response = await doFetch(
      `https://api.github.com/repos/${repository}/pulls/${pullRequest}/merge-async`,
      {
        method: 'PUT',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'autocoding-shield',
          'x-github-api-version': '2022-11-28',
        },
        body: JSON.stringify({ sha, merge_method: mergeMethod, merge_action: 'merge_queue' }),
      },
    );
  } catch {
    // Elke transportfout wordt tot één categorie gereduceerd. De exceptietekst wordt niet gelezen en
    // niet gelogd: daar staan URL's, headers en soms tokens in.
    return { ok: false, blocked: FINALIZE_ERROR.MERGE_TRANSPORT_ERROR, requests: 1 };
  }
  const status = response?.status ?? 0;
  if (status === 400) return { ok: false, blocked: FINALIZE_ERROR.MERGE_NOT_READY, status, requests: 1 };
  if (status === 403) return { ok: false, blocked: FINALIZE_ERROR.MERGE_FORBIDDEN, status, requests: 1 };
  if (status === 404) {
    return { ok: false, blocked: FINALIZE_ERROR.MERGE_RESOURCE_NOT_FOUND, status, requests: 1 };
  }
  if (status === 409) {
    return { ok: false, blocked: FINALIZE_ERROR.MERGE_ALREADY_QUEUED, status, requests: 1 };
  }
  if (status === 422) return { ok: false, blocked: FINALIZE_ERROR.MERGE_REJECTED, status, requests: 1 };
  if (status !== 200 && status !== 202) {
    return { ok: false, blocked: FINALIZE_ERROR.MERGE_STATUS_UNEXPECTED, status, requests: 1 };
  }

  let raw;
  try {
    raw = await response.json();
  } catch {
    return { ok: false, blocked: FINALIZE_ERROR.MERGE_RESPONSE_INVALID, status, requests: 1 };
  }
  let body = parseMergeAsyncBody(raw);
  if (!body) {
    return { ok: false, blocked: FINALIZE_ERROR.MERGE_RESPONSE_INVALID, status, requests: 1 };
  }

  let requests = 1;
  if (body.status === MERGE_ASYNC_STATUS.PENDING) {
    if (!MERGE_ASYNC_UUID_RE.test(body.uuid)) {
      return { ok: false, blocked: FINALIZE_ERROR.MERGE_RESPONSE_INVALID, status, requests };
    }
    let terminal = false;
    for (let poging = 0; poging < MERGE_ASYNC_POLL_BUDGET && !terminal; poging += 1) {
      // Wacht VOOR elke pollpoging, ook de eerste: het aanvaarde verzoek is net ingediend en geen
      // enkele echte asynchrone bewerking is binnen milliseconden klaar. `wacht` is de geïnjecteerde
      // of, bij ontbreken daarvan, de echte tijdklok (`defaultSleep`) — nooit een lus.
      await wacht(MERGE_ASYNC_POLL_DELAY_MS);
      const uitkomst = await fetchMergeAsyncResult({
        repository, pullRequest, uuid: body.uuid, token, doFetch,
      });
      requests += 1;
      if (uitkomst.kind === 'transport') {
        return { ok: false, blocked: FINALIZE_ERROR.MERGE_POLL_TRANSPORT_ERROR, status, requests };
      }
      if (uitkomst.kind === 'invalid') {
        return { ok: false, blocked: FINALIZE_ERROR.MERGE_RESPONSE_INVALID, status, requests };
      }
      body = uitkomst.body;
      terminal = body.status !== MERGE_ASYNC_STATUS.PENDING;
    }
    if (!terminal) {
      return { ok: false, blocked: FINALIZE_ERROR.MERGE_POLL_EXHAUSTED, status, requests };
    }
  }

  if (isProvenQueueEnrollment(body, sha)) {
    return { ok: true, status, requests, effect: 'MERGE_QUEUED' };
  }
  if (body.status === MERGE_ASYNC_STATUS.ENQUEUED) {
    // Terminaal `enqueued`, maar de actie of de head wijkt af van wat is aangevraagd — een divergent
    // antwoord telt niet als bewezen inschrijving van DEZE aanvraag.
    return { ok: false, blocked: FINALIZE_ERROR.MERGE_RESULT_MISMATCH, status, requests };
  }
  return { ok: false, blocked: FINALIZE_ERROR.MERGE_RESULT_NOT_ENQUEUED, status, requests };
}

/** Vlaggen zonder waarde. Hun POSITIE in argv mag niets aan de betekenis van de rest veranderen. */
export const FINALIZE_BOOLEAN_FLAGS = Object.freeze(['--dry-run']);

/** Sleutels die precies één niet-lege waarde nemen. */
export const FINALIZE_VALUE_OPTIONS = Object.freeze([
  '--repository', '--pull-request', '--raw', '--raw-recheck', '--policy',
]);

/**
 * Dezelfde fail-closed argumentlezing als de publisher, de targetselector en de beslisser: token
 * voor token, nooit in vaste paren. Een onbekend argument, een dubbele sleutel of vlag, een sleutel
 * zonder waarde, een lege waarde en een waarde die zelf een sleutel is, worden allemaal geweigerd in
 * plaats van stil herbetekend.
 *
 * Alle vijf de sleutels zijn VERPLICHT, ook `--raw-recheck`. Een finalizer zonder tweede meting kan
 * geen drift zien, en een aanroepvorm waarin die meting optioneel is zou precies de kortste weg naar
 * een onbewaakte merge zijn.
 */
export function parseFinalizeArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const flags = new Set(FINALIZE_BOOLEAN_FLAGS);
  const options = new Set(FINALIZE_VALUE_OPTIONS);
  const values = new Map();
  const seenFlags = new Set();
  const reject = { ok: false, error: FINALIZE_REASON.ARGUMENTS_INVALID };

  for (let i = 0; i < list.length; i += 1) {
    const token = list[i];
    if (typeof token !== 'string') return reject;
    if (flags.has(token)) {
      if (seenFlags.has(token)) return reject;
      seenFlags.add(token);
      continue;
    }
    if (!options.has(token)) return reject;
    if (values.has(token)) return reject;
    i += 1;
    const value = list[i];
    if (typeof value !== 'string' || value.length === 0) return reject;
    if (flags.has(value) || options.has(value)) return reject;
    values.set(token, value);
  }
  for (const option of FINALIZE_VALUE_OPTIONS) {
    if (!values.has(option)) return reject;
  }
  const number = Number(values.get('--pull-request'));
  if (!Number.isInteger(number) || number <= 0) return reject;
  if (values.get('--raw') === values.get('--raw-recheck')) return reject;
  return { ok: true, values, pullRequest: number, dryRun: seenFlags.has('--dry-run') };
}

/** De bestandsnamen van één meting in een rawmap. Gesloten: er wordt niets anders ingelezen. */
export const MEASUREMENT_FILES = Object.freeze({
  pr: 'pr.json',
  headCommit: 'head-commit.json',
  prCommits: 'pr-commits.json',
  issueComments: 'issue-comments.json',
  reviews: 'reviews.json',
  reviewComments: 'review-comments.json',
  changedFiles: 'files.json',
  checkRuns: 'check-runs.json',
  mergeQueueRules: 'merge-queue-rules.json',
  // V23 — `GET /repos/{o}/{r}/git/ref/heads/{base_ref}`: waar de BASE-BRANCH op meetmoment staat.
  // Bewust het smalste eindpunt dat die vraag beantwoordt — één object met `object.sha`, geen
  // commitlichaam, geen bestandslijst.
  baseHead: 'base-head.json',
});

/**
 * Leest één meting uit een rawmap. `evidenceComplete`, `checksComplete` en `mergeQueueRulesComplete`
 * komen uit vlagbestanden die de workflow schrijft op grond van de exitcode van `gh_bounded_pages`:
 * alleen de letterlijke tekst `true` telt als volledig. Ontbreekt het bestand, of staat er iets
 * anders in, dan is de meting onvolledig — nooit stilzwijgend volledig.
 */
export function readMeasurement(rawDir, readFile) {
  const measurement = {};
  for (const [key, file] of Object.entries(MEASUREMENT_FILES)) {
    measurement[key] = JSON.parse(readFile(`${rawDir}/${file}`));
  }
  const vlag = (naam) => {
    try {
      return readFile(`${rawDir}/${naam}`).trim() === 'true';
    } catch {
      return false;
    }
  };
  measurement.evidenceComplete = vlag('evidence-complete');
  measurement.checksComplete = vlag('checks-complete');
  measurement.mergeQueueRulesComplete = vlag('merge-queue-rules-complete');
  return measurement;
}

/**
 * De CLI-lus, in vier stappen die niet van volgorde mogen wisselen:
 *
 *   1. beslis op meting A. NO_GO eindigt hier, met nul verzoeken;
 *   2. beslis OPNIEUW op meting B, de hermeting van vlak vóór het effect. Ook die moet GO zijn;
 *   3. vergelijk de vingerafdrukken van A en B. Verschillen ze, dan is er iets bewogen — een
 *      verschoven head, een ingetrokken review, een bewerkt lichaam, een nieuwe bevinding, een
 *      omgeslagen check — en volgt er `MEASUREMENT_DRIFT` en geen merge;
 *   4. pas dán het effect, met de sha uit meting B: de nieuwste die daadwerkelijk is beoordeeld.
 *
 * WAT "EFFECT" IN `MANUAL_OWNER_GATE` BETEKENT (V24). In die stand doet stap 4 geen enkel verzoek:
 * `mergePullRequest` keert er terminaal terug met `OWNER_MERGE_REQUIRED`. Dat is geen mislukking maar
 * de OPLEVERING van deze stand — het MERGEPAKKET: een volledig bewezen GO op een hermeten pull
 * request, met de laatste handeling bij de eigenaar. De uitvoerregel meldt dat als
 * `effect: "OWNER_MERGE_PACKAGE"`.
 *
 * rc 0 bij precies drie uitkomsten, en bij geen enkele andere: een WERKELIJK uitgevoerde merge, een
 * `--dry-run` op een bewezen GO, en een opgeleverd eigenaarspakket. Omdat die drie niet dezelfde
 * betekenis hebben, draagt ELKE GO-regel sinds V24 het veld `merge_performed`: alleen een echt
 * uitgevoerd effect zet dat op `true`. Een aanroeper die uitsluitend de exitcode leest, kan een
 * pakket dus nooit voor een merge aanzien zonder dat veld te negeren. Elke andere uitkomst geeft
 * rc 1. De uitvoer blijft één JSON-regel met uitsluitend de gesloten uitkomstvorm en redencodes —
 * geen SHA's, geen paden, geen API-teksten.
 */
export async function runFinalize(argv, { readFile, fetchImpl, sleepImpl } = {}) {
  const meld = (uitkomst) => console.log(JSON.stringify(uitkomst));
  const parsed = parseFinalizeArgs(argv);
  if (!parsed.ok) {
    meld({ decision: FINALIZE_DECISION.NO_GO, reasons: [FINALIZE_REASON.ARGUMENTS_INVALID] });
    return 1;
  }
  const { values: args, pullRequest, dryRun } = parsed;

  let policy;
  let metingA;
  let metingB;
  try {
    if (typeof readFile !== 'function') throw new Error(FINALIZE_REASON.MEASUREMENT_UNREADABLE);
    policy = JSON.parse(readFile(args.get('--policy')));
    metingA = readMeasurement(args.get('--raw'), readFile);
    metingB = readMeasurement(args.get('--raw-recheck'), readFile);
  } catch {
    meld({ decision: FINALIZE_DECISION.NO_GO, reasons: [FINALIZE_REASON.MEASUREMENT_UNREADABLE] });
    return 1;
  }

  const beslissingA = resolveFinalization({ pullRequest, measurement: metingA, policy });
  if (beslissingA.decision !== FINALIZE_DECISION.GO) {
    meld({ decision: beslissingA.decision, reasons: beslissingA.reasons });
    return 1;
  }
  const beslissingB = resolveFinalization({ pullRequest, measurement: metingB, policy });
  if (beslissingB.decision !== FINALIZE_DECISION.GO) {
    meld({ decision: beslissingB.decision, reasons: beslissingB.reasons });
    return 1;
  }
  if (measurementFingerprint(metingA) !== measurementFingerprint(metingB)) {
    meld({
      decision: FINALIZE_DECISION.NO_GO,
      reasons: [FINALIZE_REASON.MEASUREMENT_DRIFT],
    });
    return 1;
  }

  if (dryRun) {
    meld({
      decision: FINALIZE_DECISION.GO,
      reasons: [],
      finalization_class: beslissingB.finalization_class,
      effect: 'DRY_RUN',
      // Een dry run mergt per definitie niets. Het veld staat er niet als versiering maar omdat het
      // op ELKE GO-regel hoort te staan: een veld dat soms ontbreekt, wordt door een lezer stilletjes
      // als `false` óf als `true` gelezen, en welke van de twee is dan een gok.
      merge_performed: false,
    });
    return 0;
  }

  const effect = await mergePullRequest({
    repository: args.get('--repository'),
    pullRequest: beslissingB.merge.pull_request,
    sha: beslissingB.merge.sha,
    mergeMethod: beslissingB.merge.merge_method,
    policy,
    token: process.env.GITHUB_TOKEN,
    fetchImpl,
    sleepImpl,
  });
  // V24 — HET EIGENAARSPAKKET. `OWNER_MERGE_REQUIRED` is de enige `blocked`-code die geen weigering
  // meldt maar een OPLEVERING: het oordeel was GO, de hermeting hield stand, en de stand
  // `MANUAL_OWNER_GATE` heeft daarna bewust nul verzoeken gedaan. Dat als NO_GO melden zou de
  // uitkomst van deze modus permanent op rood zetten en daarmee precies het signaal onbruikbaar
  // maken dat een echte weigering zou moeten dragen.
  if (!effect.ok && effect.blocked === FINALIZE_ERROR.OWNER_MERGE_REQUIRED) {
    meld({
      decision: FINALIZE_DECISION.GO,
      reasons: [],
      finalization_class: beslissingB.finalization_class,
      effect: 'OWNER_MERGE_PACKAGE',
      merge_performed: false,
      // Wat de eigenaar hierna zelf doet, in zijn eigen naam en in GitHubs eigen interface. De regel
      // draagt geen sha en geen pad: het PR-nummer stond al in de aanroep, en de rest is te lezen op
      // de pull request zelf.
      owner_action: FINALIZE_ERROR.OWNER_MERGE_REQUIRED,
    });
    return 0;
  }
  if (!effect.ok) {
    meld({
      decision: FINALIZE_DECISION.NO_GO,
      reasons: [effect.blocked ?? FINALIZE_ERROR.MERGE_STATUS_UNEXPECTED],
    });
    return 1;
  }
  meld({
    decision: FINALIZE_DECISION.GO,
    reasons: [],
    finalization_class: beslissingB.finalization_class,
    // De naam van het effect komt uit het effect zelf, nooit uit een aanname hier. `MERGE_QUEUED`
    // betekent: de inschrijving in GitHubs wachtrij is BEWEZEN aanvaard, niet dat het mergen al is
    // gebeurd — dat gebeurt later, binnen die wachtrij.
    effect: effect.effect,
    // Er is werkelijk een effect uitgevoerd. Dit is de enige plaats in dit bestand waar dit veld
    // `true` wordt.
    merge_performed: true,
  });
  return 0;
}

// Alleen bij directe aanroep. Bij `import` mag hier niets draaien: de tests importeren dit bestand.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFileSync } = await import('node:fs');
  process.exitCode = await runFinalize(
    process.argv.slice(2),
    { readFile: (p) => readFileSync(p, 'utf8') },
  );
}
