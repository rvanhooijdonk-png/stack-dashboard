# Autocoding Shield

De Shield levert één stabiele GitHub-check, `autocoding-shield`, voor pull requests naar `main`.
Hij toetst de validator en scant de branchdiff op secretachtige waarden. De statuswriter staat in een
fysiek apart workflowbestand dat uitsluitend via `workflow_run` en `schedule` start — en dus alleen in
de versie die op de default branch staat. De live receiptpoort staat in
`policy.v1.json` bewust uit tijdens bootstrap. Dat is geen PR-specifieke bypass: inschakelen vereist
een afzonderlijke wijziging van het beleid nadat een fixture-PR de negatieve en positieve route heeft
bewezen.

## Twee BESTANDEN, twee jobs en één statuscontext

| naam | soort | bestand | events | checkout | doet |
| --- | --- | --- | --- | --- | --- |
| `autocoding-shield` | job | `.github/workflows/autocoding-shield.yml` | uitsluitend `pull_request` | PR-head | validator-, adapter-, publisher-, doelselectie- en vertrouwensgrenstests, secretscan op de branchdiff |
| `autocoding-shield-signal` | job | `.github/workflows/autocoding-shield.yml` | `issue_comment`, `pull_request_review` | geen | niets — een `echo` met `permissions: {}`, zodat de voltooiing van deze run de trusted writer aanstoot |
| `autocoding-shield-live-gate` | job | `.github/workflows/autocoding-shield-live-gate.yml` | `workflow_run` (na `autocoding-shield`), `schedule` | default branch | bepaalt de doel-PR's opnieuw via read-only API, meet elke PR en publiceert de uitspraak |
| `autocoding-shield-live-receipts` | commitstatus-context | — | — | — | draagt de uitspraak op de gemeten PR-head; dit is de naam die later required wordt |

### Waarom dit twee bestanden zijn en geen twee jobs in één bestand

Dit is de vertrouwensgrens zelf, en hij is met opzet fysiek.

Op een `pull_request`-run gebruikt GitHub de workflowdefinitie **zoals die in de pull request staat**,
niet de versie op de default branch. Zolang de statuswriter in hetzelfde bestand woonde als de
`pull_request`-shield, kon een same-repo branch de stappen van de `statuses: write`-job vervangen en
de receiptstatus zelf groen schrijven. Het uitchecken van de default branch beschermt de **scripts**;
het beschermt niet de **YAML** die de job en zijn tokenpermissies definieert. Dat was Codex-bevinding
P1 (review `4998406843`, inline `3834611207`), en hij was terecht.

De enige sluiting is daarom: het bestand met de schrijfscope mag door geen enkele PR-gecontroleerde
event startbaar zijn.

### De eerste poging klopte niet, en dat is gemeten

De vorige versie liet de writer op `issue_comment` en `pull_request_review` draaien, in de aanname dat
die twee events altijd de default-branch-definitie uitvoeren. **Die aanname is onjuist gebleken, live
op deze PR.** Actions-run `32542688290` draaide op event `pull_request_review`, op head `a2e7a64…`,
het bestand `.github/workflows/autocoding-shield-live-gate.yml` — terwijl de Contents API voor dat pad
op `?ref=main` een 404 gaf. Het bestand bestond dus helemaal niet op de default branch en werd tóch
uitgevoerd, inclusief de job met `statuses: write`. Dat de statusstappen daar oversloegen (poort uit)
was toeval, geen grens. `pull_request_review` is een `pull_request*`-event en draait de door de PR
voorgestelde definitie.

De grens die **wel** bestaat is `workflow_run`: zo'n workflow triggert uitsluitend als zijn bestand op
de default branch staat, en het event is er door GitHub expliciet voor bedoeld om ná een onprivileged
workflow een privileged workflow te starten. `schedule` heeft dezelfde eigenschap.

- `autocoding-shield.yml` draagt **nul** schrijfscopes — noch op bestandsniveau, noch op een job. Het
  kent drie events, maar voert alleen op `pull_request` repositorycode uit; `issue_comment` en
  `pull_request_review` bereiken uitsluitend `autocoding-shield-signal`, een job zonder checkout,
  zonder code en met `permissions: {}`. Er is dus geen event waarop PR-voorgestelde YAML een
  schrijfscope krijgt, en geen event waarop PR-code buiten `pull_request` draait.
- `autocoding-shield-live-gate.yml` kent uitsluitend `workflow_run` (gepind op de workflownaam
  `autocoding-shield`) en `schedule`, en bevat precies één job met precies één schrijfscope:
  `statuses: write`. Nooit `pull_request`, nooit `pull_request_review`, nooit `issue_comment`, nooit
  `pull_request_target`.

De writer voert dus nooit untrusted PR-code uit — niet omdat hij die zorgvuldig vermijdt, maar omdat
er geen event bestaat waarop hij hem zou krijgen. Wijzigen kan alleen via een merge naar de default
branch, en die merge valt onder de ownergate.

### Van de bronrun wordt niets geloofd

De aanleiding is onprivileged, dus is de payload ervan hooguit een **hint**. De writer leest géén
artifacts, géén cache, géén job-outputs en géén `head_sha` van de bronrun als feit. Hij checkt alleen
de default branch uit (`persist-credentials: false`) en bepaalt de doel-PR's opnieuw via read-only
API-lezingen. Zie "Welke PR's een ronde meet" hieronder.

De grens wordt niet in proza bewaakt maar statisch gemeten door
`scripts/autocoding/workflow-trust.mjs` en `test/autocoding-workflow-trust.test.mjs`. Die tests falen
zodra een workflow met een `pull_request`- of `pull_request_target`-trigger ergens een schrijfscope
krijgt, zodra het writerbestand zelf zo'n trigger krijgt, zodra de PR-shield een schrijfscope krijgt,
en zodra de writer een tweede job, een andere schrijfscope dan `statuses`, secrets, een
PR-headcheckout of PR-cache/artifacts zou aannemen. De meter is bewust over-benaderend: een vals
alarm kost een commit, een gemiste schrijfscope kost de poort.

### Welke PR's een ronde meet

`scripts/autocoding/select-live-gate-targets.mjs` bepaalt de doellijst, en doet dat zonder de
aanleiding te geloven:

1. Bij `workflow_run` moet de bron de **verwachte** workflow zijn: naam `autocoding-shield`, pad
   `.github/workflows/autocoding-shield.yml`, en een bronevent uit `pull_request`, `issue_comment` of
   `pull_request_review`. Alles daarbuiten — een andere workflow, een gelijknamige workflow op een
   ander pad, een `workflow_dispatch`, een `push` — schrijft **geen enkele status** en is geen rode
   run: het is simpelweg geen aanleiding.
2. De lijst zelf komt uit `GET /repos/{repo}/pulls?state=open`. De hint mag die lijst alleen
   **versmallen**, nooit uitbreiden, en alleen bij een eenduidige treffer: precies één open PR met die
   `head_sha`, anders precies één met die `head_ref`. Twee PR's met dezelfde branchnaam (bij forks
   gewoon) leveren dus geen keuze op.
3. Lukt dat niet — en bij `schedule` en `issue_comment` bestaat er sowieso geen bruikbare hint, want
   dan draait de shield op de default branch — dan worden **alle open PR's** gemeten. Extra meten is
   onschadelijk (de uitspraak is een pure functie van de momentopname), een verkeerde PR meten laat een
   stale status staan. De asymmetrie bepaalt de keuze.
4. Die volledige ronde is expliciet begrensd: meer dan `OPEN_PULL_REQUEST_LIMIT` (25) open PR's is een
   **weigering** — niets publiceren en rood worden — in plaats van een stilzwijgend halve ronde. Ook
   een onleesbare of onbruikbare PR-lijst faalt zo gesloten.

Elke doel-PR is een eigen record. De lus draait zonder `set -e`: een PR waarvan de head niet te meten
is, of waarvan de publicatie faalt, zet `overall=1` en gaat door naar de volgende. De job wordt aan
het eind rood (`exit "$overall"`), maar één kapotte PR laat nooit de statussen van de andere PR's
stale staan. `test/autocoding-live-gate-targets.test.mjs` voert dat `run:`-blok werkelijk uit onder
`bash` met gestubde `gh`/`node` en toetst dat gedrag, in plaats van het te beweren.

Serialisatie loopt per bronbranch (`concurrency`-groep op `workflow_run.head_branch`), niet globaal:
een lange ronde over één PR verdringt de volgende niet, en een geplande ronde krijgt zijn eigen groep.
Per PR staan er zes read-only GET's; het uurlijkse `schedule` is de convergentiefallback voor edits,
deletes, dismissals en gemiste of geannuleerde signaalruns.

### Bootstrap: wat dit PR zelf niet kan bewijzen

Een `workflow_run`-workflow bestaat pas **na** merge op de default branch. PR #74 kan de nieuwe
trusted writer dus niet zelf live bewijzen — dat is geen tekortkoming van het ontwerp maar de grens
zelf. Wat PR #74 wél levert is het negatieve bewijs: run `32542688290` toont dat de vorige, direct
getriggerde vorm PR-YAML uitvoerde, en na deze reparatie kan een nieuwe review of comment op PR #74
**geen** run van `autocoding-shield-live-gate.yml` meer starten — die workflow kent die events niet
meer. De read-only signaalworkflow mag wel draaien.

Het eerste positieve writerbewijs komt daarom uit een aparte post-merge-pilot, met de poort nog steeds
uit (`live_receipt_gate_enabled: false`) en zonder branch protection. PR #74 wordt handmatig via de
bestaande ownermergegate afgehandeld en zet geen ruleset of required check aan.

## Waarom de uitspraak een commitstatus is, geen checknaam

Gemeten, niet bedacht: een Actions-run die door `workflow_run`, `issue_comment` of
`pull_request_review` wordt getriggerd hangt aan de **default-branch-SHA**, niet aan de PR-head. De
checknaam van zo'n run verschijnt daarom nooit op de PR-head. Een eerder groene check op die head blijft dus staan, ook
nadat het bewijs waarop hij groen werd is verwijderd, bewerkt of dismissed — precies de stale-green
die Codex-reviewcomment `3834428052` reproduceerde.

`scripts/autocoding/publish-live-status.mjs` hangt de uitspraak daarom niet aan de checknaam maar
schrijft een expliciete commitstatus op de via de API **gemeten** volledige PR-head, onder de vaste
context `autocoding-shield-live-receipts` uit `policy.live_status_context`. Twee eigenschappen maken
dat convergent:

1. De uitspraak is een pure functie van de API-momentopname. Het event zelf gaat de berekening niet
   in, dus Codex-na-Gemini, Gemini-na-Codex, een edit, een delete, een dismiss en elke volgorde
   daarvan publiceren byte-identiek dezelfde status op dezelfde commit.
2. Er is geen zwijgend pad. `success` bestaat uitsluitend bij een bewezen `GO`; elke `NO_GO`,
   parsefout, API-truncatie, ontbrekend bewijs of uitvoeringsfout schrijft `failure` op diezelfde
   head. Een crash van de poortstap wordt binnen de lus opgevangen (`|| true`) en als
   `--execution-error` doorgegeven, zodat de publicatie hoe dan ook draait — rood worden gebeurt ná de
   publicatie, niet ervoor. Alleen een PR waarvan de head zelf na drie pogingen niet meetbaar is
   blijft zonder status: zonder commit is er geen drager. Dat wordt expliciet gelogd
   (`PR_<n>_HEAD_UNMEASURED`) en maakt de run rood.

De omschrijving van de status bevat uitsluitend gesorteerde redencodes uit een gesloten allowlist,
met een `+N`-teller als er niet meer in de 140 tekens van GitHub passen. Nooit ruwe stderr, een URL,
een pad, een modelnaam of bewijsinhoud; een onbekende code wordt de vaste literal
`UNRECOGNISED_REASON` in plaats van te verdwijnen.

## Native reviewbewijs

Codex en Gemini kennen het receiptschema hieronder niet en kunnen het dus niet schrijven. Bewijs is
daarom hun eigen, ongewijzigde GitHub-uitvoer, gemeten door
`scripts/autocoding/collect-shield-input.mjs` en beoordeeld door
`scripts/autocoding/verify-review-gate.mjs`. Die uitvoer komt in de praktijk in **drie** vormen, en
alle drie worden ondersteund:

- **Codex als issue-comment** — van `chatgpt-codex-connector[bot]` via GitHub-App `1144995`, die
  begint met het exacte succesbericht en een `**Reviewed commit:**`-regel draagt.
- **Codex als pull-request-review** — dezelfde bot levert op deze PR een `pull_request_review` mét
  inline comments. Een reviewobject draagt géén `performed_via_github_app`-veld, dus daar is de
  App-id niet af te dwingen; de identiteit hangt op deze route aan `user.login`, `user.type` en het
  gemeten numerieke `user.id` `199175422`. De head komt uit `review.commit_id` en pas bij ontbreken
  daarvan uit de `**Reviewed commit:**`-regel.
- **Gemini als pull-request-review** — van `gemini-code-assist[bot]` (`user.id` `176961590`) in een
  toegestane state, met de terminale `## Code Review`-marker.

Voor beide reviewroutes geldt dezelfde regel: inline reviewcomments horen via
`pull_request_review_id` bij precies één review, en **elke** inline bevinding op die review maakt die
vendorronde `NO_GO`. Omgekeerd is "geen inline bevinding gezien" nooit vanzelf een `GO`: er moet
altijd een gepinde identiteit én een canonieke terminale succesvorm uit
`terminal_success_markers` zijn. Proza is nooit `GO`.

### Ingetrokken reviewbewijs verdwijnt uit de selectie

Een review draagt een `state` die ná het schrijven nog verandert. Wie een review dismisst, laat het
lichaam én de inline bevindingen letterlijk staan; GitHub zet alleen `state` op `DISMISSED`. Zolang
zo'n ingetrokken ronde als huidig `NO_GO`-bewijs bleef meetellen, bleef haar reden
(`NATIVE_FINDINGS_PRESENT`) voor altijd in de actuele bewijsset hangen — en kon **geen enkele** latere
schone ronde de PR nog groen krijgen. Dat was Codex-bevinding P2 (inline `3834611209`).

Een pull-request-review telt daarom uitsluitend in een expliciet allowlisted **actieve** state
(`native_review.<vendor>.allowed_states`); voor Codex is dat op deze repository `COMMENTED`, de state
die de bot werkelijk gebruikt. `DISMISSED`, `PENDING`, `CHANGES_REQUESTED`, een onbekende en een
ontbrekende state leveren **geen bewijsstuk** op — ook geen negatief. Dat kan nooit een `GO`
opleveren: een vendor zonder actieve ronde mist gewoon zijn vereiste `GO` en levert
`INSUFFICIENT_GO`. Na een dismissal telt een nieuwe, actuele ronde dus weer normaal mee, en een
ACTIEVE review met bevindingen blijft gewoon blokkeren. De allowlist is zelf begrensd: een policy die
iets buiten `COMMENTED`/`APPROVED` probeert toe te laten is `UNSAFE_POLICY`.

De Codex-**issuecomment**route draagt geen reviewstate en staat hier volledig los van; die blijft
onveranderd werken.

Drie dingen worden mechanisch gemeten in plaats van geloofd. De transportidentiteit komt van
GitHub (`user.login`, `user.type`, het numerieke `user.id` en waar het veld bestaat
`performed_via_github_app.id`) en is niet door een auteur te zetten; een gespoofd comment met
identieke tekst levert dus geen bewijsstuk op, alleen ruis. `app_id` en `user_id` moeten in het
beleid positieve gehele getallen zijn, anders is de policy onveilig en valt alles gesloten. De
afgekorte commit uit een Codex-comment wordt tegen de commitlijst van de PR zelf geresolveerd —
precies één prefixtreffer telt, nul of meerdere treffers leveren geen meting op en falen gesloten op
`STALE_HEAD`. En de gevoelige paden komen uit `/pulls/{n}/files`, niet uit PR-proza.

Bewijs dat naar een andere bekende head resolveert is een afgeronde ronde van een vorige push:
auditdata, nooit opnieuw geldig, en evenmin een blokkade voor de actuele head. Bewijs dat helemaal
niet resolveert blijft wél staan en faalt gesloten — een gepinde bot die naar een onbekende commit
wijst is een anomalie, geen ruis. Met uitsluitend stale bewijs blijft de uitslag `NO_GO`.

## Ownergate op gevoelige paden

Raakt de diff `.github/workflows/` of `CONTROL/AUTOCODING/`, dan komt daar één aparte
**ownerautorisatie** bij. Dat is een eigen schema in een eigen fenced blok met infostring
`autocoding-owner-approval-v1`:

```autocoding-owner-approval-v1
{
  "schema": "AUTOCODING_OWNER_APPROVAL_V1",
  "task_id": "…",
  "head_sha": "…40 hex…",
  "tree_sha": "…40 hex…",
  "decision": "APPROVE"
}
```

Vijf velden, niet meer: een onbekend veld maakt het blok ongeldig in plaats van het te promoveren.
Alle vier de waarden worden tegen de via de API gemeten waarheid gelegd; een autorisatie voor een
vorige head of tree geldt nooit opnieuw.

Waarom dit een eigen schema is en geen reviewreceipt: eigenaarschap is **geen reviewleverancier**.
Toen de ownerpoort het reviewreceipt hergebruikte, gold daarop ook de zelfreviewregel — en omdat de
PR-auteur en de toegestane owner op deze repository dezelfde GitHub-gebruiker zijn
(`rvanhooijdonk-png`), maakte `SELF_REVIEW` een ownerakkoord structureel onmogelijk. Op de
ownerautorisatie geldt daarom **geen** bouwer-zelfreviewregel; dat is precies de scheiding tussen de
twee poorten. De auteur van het blok komt uitsluitend uit het API-veld `user.login` en moet in
`owner_gate.allowed_owner_actors` staan.

De owner kan nooit een ontbrekende vendor vervangen: het native pad wordt volledig los geëvalueerd en
blijft zonder twee geldige vendor-`GO`'s rood, hoe geldig de ownerautorisatie ook is.
`assertNativeVendorsSafe` weigert bovendien elke policy waarin een owner-actor ook als vendoractor
voorkomt.

### De drager telt mee, niet alleen het blok

Een autorisatieblok kan op twee manieren binnenkomen, en die twee zijn niet gelijkwaardig.

Een **issuecomment** heeft geen toestand: hij bestaat of hij is verwijderd, en beide zijn direct
zichtbaar in de momentopname. Een **pull-request-review** draagt daarentegen een `state` die ná het
schrijven nog verandert. Wie een review intrekt, laat het lichaam — en dus het autorisatieblok —
letterlijk ongewijzigd staan; GitHub zet alleen `state` op `DISMISSED`. Zonder statefilter bleef zo'n
ingetrokken autorisatie de gevoelige-padpoort dus groen houden.

De adapter geeft daarom de drager mee (`source` en, voor een review, `review_state`), en de validator
accepteert reviewbewijs uitsluitend in een expliciet allowlisted **actieve** state:
`owner_gate.allowed_review_states`. Op deze repository staat daar alleen `COMMENTED` in — de
toegestane owner is ook de PR-auteur, en GitHub laat een auteur zijn eigen PR niet goedkeuren, dus
`APPROVED` is hier geen state die de eigenaar werkelijk kan produceren. `DISMISSED`,
`CHANGES_REQUESTED`, `PENDING`, een ontbrekende state en een drager zonder herkenbare herkomst tellen
nooit; ze leveren `OWNER_APPROVAL_CARRIER_NOT_ACTIVE` op en daarmee `OWNER_GATE_REQUIRED` zolang er
geen ander actueel geldig ownerbewijs is. De allowlist zelf is bovendien begrensd: een policy die
`DISMISSED` (of wat dan ook buiten `COMMENTED`/`APPROVED`) probeert toe te laten is `UNSAFE_POLICY`.

### Prefixen, geen globs

`owner_gate.sensitive_path_prefixes` is precies wat de naam zegt: een lijst **letterlijke
padprefixen**, vergeleken met `String.startsWith`. Er is geen glob-expansie, en die is er ook nooit
geweest — de vorige sleutelnaam (`sensitive_path_globs`) beloofde semantiek die de implementatie niet
had, waardoor een toekomstige echte glob geruisloos nergens op zou matchen en de ownergate stil zou
uitschakelen.

**Een rename raakt twee paden.** GitHub zet het nieuwe pad in `filename` en het oude in
`previous_filename`. Alleen `filename` lezen betekende dat een rename van
`.github/workflows/gate.yml` naar een onbeschermd pad de gevoelige **bron** kwijtraakte en de
ownergate oversloeg — precies bij de zwaarste wijziging die er is, het weghalen van een workflow. Elke
bestandsvermelding wordt daarom op al zijn paden getoetst, en beide richtingen tellen: gevoelig →
onbeschermd én onbeschermd → gevoelig. Een vermelding met onbruikbare padvelden (ontbrekend of leeg
`filename`, of een aanwezig maar ongeldig `previous_filename`) is fail-closed gevoelig, niet "niets
gevonden".

De prefixen worden daarom fail-closed gevalideerd. Een prefix moet een niet-leeg, relatief repo-pad
zijn; glob-meta (`*`, `?`, `[`, `]`, `{`, `}`, `!`), backslashes, controltekens, een leidende `/`,
`.`- of `..`-segmenten en dubbele slashes zijn verboden. Eén onveilige prefix, één onbekende sleutel
in `owner_gate` (waaronder de oude `sensitive_path_globs`) of een lege lijst maakt de hele policy
`UNSAFE_POLICY` — nooit "dan maar geen gevoelige paden". De gevoelige bereiken zelf blijven exact
`.github/workflows/` en `CONTROL/AUTOCODING/`.

## Volledigheid van de bestandslijst

`/pulls/{n}/files` levert maximaal 3000 bestanden. De adapter legt het aantal verzamelde bestanden
daarom naast `pr.changed_files` uit het PR-object zelf. Een lege lijst, een leesfout, een ongelijk
aantal of een lijst op de 3000-grens telt als **onvolledig**: dat levert `FILES_INCOMPLETE` op én
activeert de ownerpoort. Onbekend zicht is nooit een vrijstelling — een truncatie mag de ownerpoort
juist niet overslaan, want daar zou een gevoelig pad zich achter kunnen verbergen.

## Receiptcontract

Een receipt staat als JSON in een fenced blok met infostring
`autocoding-review-receipt-v1` en schema `AUTOCODING_REVIEW_RECEIPT_V1`. Vereist zijn `task_id`,
`reviewer_actor`, `reviewer_vendor`, een unieke `receipt_uuid`, volledige actuele `head_sha` en
`tree_sha`, `verdict` (`GO` of `NO_GO`), niet-lege `checks_executed` en `builder_actor`.

De poort meet head, tree en bouwer via GitHub. Hij bindt `reviewer_actor` bovendien aan de door
GitHub geleverde auteur van het comment of de review. De selectie vertrouwt eerst uitsluitend de
exact toegestane GitHub-transportactor, negeert daarna receipts voor een oudere head en valideert pas
dan de actuele set. Daardoor kan publieke ruis geen fouten of duplicaten injecteren, tellen oude
reviews nooit voor een nieuwe head en blijft een malformed of NO_GO-receipt van een toegestane actor
rood. Met uitsluitend stale receipts ontbreken dus actuele vereiste receipts en blijft de uitslag
NO_GO. Afgekorte objecten, zelfreview, dubbele actor/vendor/UUID, lege of overgeslagen checks, lege
rc0-output, NO_GO, onbekende velden, parserfouten, narratief zonder machineblok en
wildcard/onbekende transportidentiteiten blijven rood. De uitvoer bevat uitsluitend redencodes;
receiptinhoud wordt niet gelogd.

Een toegestane identiteit die zichzelf goedkeurt is het scherpe geval: die passeert de ruisfilter en
faalt daarna mechanisch op `SELF_REVIEW`. Een niet-toegestane identiteit die zich als owner voordoet
wordt daarvóór al als ruis verworpen en levert `NO_RECEIPTS` op.

## Wat er gebeurt als de statuspublicatie zelf faalt

De POST naar `/statuses/{sha}` kan mislukken: DNS, TLS, timeout, rate limit, een reset. Zo'n fout
wordt volledig ingesloten en teruggebracht tot één vaste categorie, `STATUS_TRANSPORT_ERROR`. De
exceptietekst wordt niet gelezen, niet doorgegeven en niet gelogd; de stap logt uitsluitend
`LIVE_STATUS_POST_REJECTED_STATUS_TRANSPORT_ERROR` en eindigt rc 1, zodat de run rood is. Eerder
verliet zo'n fout `publishStatus()` als onafgevangen promise-rejection, met stacktrace op stderr.

Het restrisico wordt hier eerlijk benoemd in plaats van weggeschreven: een mislukte POST kan een
**eerdere** status op dezelfde head niet overschrijven. Stond daar al een `success` van een vorige,
toen nog geldige momentopname, dan blijft die staan tijdens de storing. De poort beschikt met
`statuses: write` alleen over schrijven; wat niet geschreven kan worden, kan ook niet ingetrokken
worden. De run is wél rood, en de eerstvolgende geslaagde publicatie op dezelfde head herstelt de
uitspraak — die is immers een pure functie van de momentopname, niet van het event.

## Activering en compatibiliteit

Deze wijziging zet `live_receipt_gate_enabled` **niet** aan. De poort is compleet en getest, maar de
stap `Bepaal poortstand en statuscontext` eindigt op `BOOTSTRAP_RECEIPT_GATE_DISABLED` zolang de vlag
uit staat, en er wordt dan ook geen enkele status gepubliceerd.

Activering is een **afzonderlijke latere PR** die precies drie dingen doet, in deze volgorde:

1. `live_receipt_gate_enabled` op `true` zetten in `CONTROL/AUTOCODING/policy.v1.json`, nadat de
   gate-bestanden via merge op de default branch staan en een fixture-PR de negatieve én de positieve
   route heeft aangetoond.
2. De gemeten vendoridentiteiten herbevestigen tegen de dan actuele GitHub-App-id's.
3. `autocoding-shield-live-receipts` als required status check instellen. Niet `autocoding-shield`,
   want die job draait PR-headcode; en niet `autocoding-shield-live-gate`, want die Actions-checknaam
   hangt bij `workflow_run` en `schedule` aan de default-branch-SHA en verschijnt helemaal niet op de
   PR-head. Alleen de commitstatus staat gegarandeerd op de gemeten head.

Een generieke regel "alle wijzigingen moeten via een PR" mag niet stilzwijgend worden geactiveerd.
`.github/workflows/doorstroom.yml` en `.github/workflows/waarnemer.yml` bevatten jobs met
`contents: write` die rechtstreeks naar `main` pushen. Een ruleset/branch-protection met
`required_pull_request_reviews` (of "Require a pull request before merging") zonder expliciete bypass
voor die GitHub Actions-identiteiten blokkeert die schrijvers. Vereiste status checks kunnen hun
pushes eveneens blokkeren wanneer voor de nieuwe commit geen passende check bestaat. De toekomstige
protection moet dus óf die twee gemeten schrijvers gericht laten bypassen, óf hun schrijfroute eerst
naar PR's ombouwen. Deze repositorywijziging past geen protection of ruleset toe.

## Argumenten van de statuspublisher

`publish-live-status.mjs` las argv eerst in **vaste paren** (`i += 2`). Eén losse booleaanse vlag
middenin de lijst verschoof daardoor elk volgend key/valuepaar met een plek: `--head-sha` verdween als
sleutel en de gemeten head werd zelf een sleutel. Dat gebeurde stil — de vlaggen bleven herkenbaar,
alleen de bindingen klopten niet meer. Dat was de Gemini-bevinding (review `4998403781`, inline
`3834607793`).

`parsePublishArgs()` leest daarom token voor token. `--dry-run` is een positie-onafhankelijke
booleaanse vlag; elke sleutel bindt aan zijn eigen waarde ongeacht waar de vlag staat. En de parser is
fail-closed: een onbekend argument, een dubbel opgegeven sleutel of vlag, een sleutel zonder waarde,
een positionele losse waarde en een waarde die zelf een bekende sleutel of vlag is, leveren allemaal
`LIVE_STATUS_NOT_PUBLISHABLE_ARGUMENTS_INVALID` en rc 1 op in plaats van een stilzwijgende
herinterpretatie. De lege string blijft een legitieme waarde: de workflow geeft `--execution-error ""`
door zodra er geen uitvoeringsfout is, en ontbreken is iets anders dan leeg zijn.

## Permissions

Beide workflowbestanden gebruiken minimale permissions. `autocoding-shield.yml` heeft **geen enkele**
schrijfscope — bestandsniveau `permissions: {}`, de PR-job `contents: read`, de signaaljob
`permissions: {}`. `autocoding-shield-live-gate.yml` heeft er precies één, `statuses: write`, naast
`contents: read`, `pull-requests: read` en `issues: read`, op zijn enige job. Geen `contents: write`,
geen `actions: write`, geen `pull-requests: write`, geen `id-token: write`, geen secrets, geen
environment, geen artifacts of cache, geen PR-headcheckout, en nooit `pull_request_target`. Dat wordt
statisch afgedwongen: `findTrustBoundaryViolations` weigert elke andere trigger op het writerbestand,
een ongepinde of verkeerd gepinde `workflow_run`-bron, en een uitcheckende shieldjob die niet tot
`pull_request` beperkt is.

Zolang de trusted gatebestanden nog niet op de default branch bestaan, meldt de live-gate-job
expliciet een bootstrap-no-op; validator-, adapter-, doelselectie-, vertrouwensgrens- en branchtests
draaien op het `pull_request`-pad.
