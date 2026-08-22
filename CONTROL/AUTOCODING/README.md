# Autocoding Shield

De Shield levert één stabiele GitHub-check, `autocoding-shield`, voor pull requests naar `main`.
Hij toetst de validator en scant de branchdiff op secretachtige waarden. De statuswriter staat in een
fysiek apart workflowbestand dat uitsluitend via `issue_comment`, `workflow_run` en `schedule` start —
drie events die GitHub alleen vanaf de default-branch-definitie draait. Binnen dat bestand zit elke
statusmutatie in één matrixjob **per pull request**, met een `concurrency`-groep op exact dat
PR-nummer. De live receiptpoort staat in
`policy.v1.json` bewust uit tijdens bootstrap. Dat is geen PR-specifieke bypass: inschakelen vereist
een afzonderlijke wijziging van het beleid nadat een fixture-PR de negatieve en positieve route heeft
bewezen.

## Drie BESTANDEN, en waar de bevoegdheid zit

De **diagnose** en de **autorisatie** staan sinds V18 op verschillende plaatsen, en dat is geen
opdeling maar de reparatie van Codex-bevindingen `3835364972` en `3835364974`. Een commitstatus is
SHA-scoped: hij hoort bij de commit, niet bij de pull request. Een pull request die later op dezelfde
head wordt geopend erft een eerder geschreven `success` dus onmiddellijk, en geen enkele meting op
het publicatiemoment kan een latere gebeurtenis uitsluiten. Uniciteit bewijzen uit de open-PR-lijst
sloot dat gat niet: die lijst is offsetgepagineerd en dus geen atomische momentopname.

De statuscontext draagt daarom **geen** bevoegdheid meer en publiceert structureel geen `success`;
zij is er om op de pull request zelf te kunnen zien wat de poort meet. De bevoegdheid ligt bij de
PR-gebonden **mergefinalizer**, die zijn eigen pull request hermeet en uitsluitend via
`PUT /repos/{owner}/{repo}/pulls/{number}/merge` met de hermeten volledige `sha` zou kunnen werken —
met alle activatievlaggen op `false`. Zie "De mergefinalizer" verderop.


| naam | soort | bestand | events | checkout | doet |
| --- | --- | --- | --- | --- | --- |
| `autocoding-shield` | job | `.github/workflows/autocoding-shield.yml` | uitsluitend `pull_request` | PR-head | validator-, adapter-, publisher-, doelselectie- en vertrouwensgrenstests, secretscan op de branchdiff |
| `autocoding-shield-signal` | job | `.github/workflows/autocoding-shield.yml` | `pull_request_review`, `pull_request_review_comment` | geen | niets — een `echo` met `permissions: {}`, zodat de voltooiing van deze run de trusted writer aanstoot |
| `selecteer` | job | `.github/workflows/autocoding-shield-live-gate.yml` | `issue_comment`, `workflow_run` (na `autocoding-shield`), `schedule` | default branch | bepaalt read-only en zonder enige schrijfscope wélke PR's deze aanleiding meet, en schrijft die als JSON-matrix |
| `schrijf` | matrixjob | `.github/workflows/autocoding-shield-live-gate.yml` | idem, één job per doel-PR | default branch | de enige job met `statuses: write`; meet ná zijn per-PR-lock opnieuw, invalideert die head en publiceert de uitspraak erop |
| `autocoding-shield-diagnostic` | commitstatus-context | — | — | — | toont de diagnose op de gemeten PR-head; publiceert nooit `success` en wordt nooit required |
| `finaliseer` | job | `.github/workflows/autocoding-merge-finalizer.yml` | uitsluitend `schedule` | default branch, nooit PR-code | de enige job met `pull-requests: write`; hermeet één pull request en zou die — met de vlaggen aan — via de merge-endpoint van dát nummer kunnen afronden |

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
  kent drie events, maar voert alleen op `pull_request` repositorycode uit; `pull_request_review` en
  `pull_request_review_comment` bereiken uitsluitend `autocoding-shield-signal`, een job zonder
  checkout, zonder code en met `permissions: {}`. Er is dus geen event waarop PR-voorgestelde YAML een
  schrijfscope krijgt, en geen event waarop PR-code buiten `pull_request` draait.
- `autocoding-shield-live-gate.yml` kent `issue_comment`, `workflow_run` (gepind op de workflownaam
  `autocoding-shield`) en `schedule`. Nooit `pull_request`, nooit `pull_request_review`, nooit
  `pull_request_review_comment`, nooit `pull_request_target`. Het bevat precies één job met precies
  één schrijfscope: `statuses: write` op de matrixjob `schrijf`.

`issue_comment` staat sinds V11 in de writer en niet meer in de shield, en dat is geen versoepeling.
GitHub draait dat event uitsluitend tegen de definitie op de default branch, net als `workflow_run` en
`schedule`; wat een commentator kan richten is het moment, niet de code. Het draagt bovendien zijn
PR-associatie zélf mee (`github.event.issue.number` plus `github.event.issue.pull_request`), allebei
velden die GitHub vult. Stond het event in **beide** bestanden, dan leverde één comment twee
aanleidingen op — de directe en de `workflow_run` die op de signaalrun volgt — en kostte dat dubbel
API-budget zonder één extra feit. `pull_request_review_comment` is er in de shield juist bíj gekomen:
een losse reviewcomment levert geen `pull_request_review`-event op, en zonder dat signaal moest de
uurlijkse schedule die wijziging opvangen.

Dat `issue_comment` alleen dáár mag staan is zelf een gemeten regel: elk ander workflowbestand met
`issue_comment` én een schrijfscope levert `ISSUE_COMMENT_WRITE_OUTSIDE_TRUSTED_WRITER` op.

De writer voert dus nooit untrusted PR-code uit — niet omdat hij die zorgvuldig vermijdt, maar omdat
er geen event bestaat waarop hij hem zou krijgen. Wijzigen kan alleen via een merge naar de default
branch, en die merge valt onder de ownergate.

### Van de bronrun wordt niets geloofd

De aanleiding is onprivileged, dus wordt de payload ervan **nergens** voor gebruikt. De writer leest
géén artifacts, géén cache, géén job-outputs en géén `head_sha` van de bronrun — ook niet als hint om
de ronde te versmallen. Hij checkt alleen de default branch uit (`persist-credentials: false`) en
bepaalt de doel-PR's opnieuw via read-only API-lezingen. Zie "Welke PR's een ronde meet" hieronder.

De grens wordt niet in proza bewaakt maar statisch gemeten door
`scripts/autocoding/workflow-trust.mjs` en `test/autocoding-workflow-trust.test.mjs`. Die tests falen
zodra een workflow met een `pull_request`- of `pull_request_target`-trigger ergens een schrijfscope
krijgt, zodra het writerbestand zelf zo'n trigger krijgt, zodra de PR-shield een schrijfscope krijgt,
en zodra de writer een tweede job, een andere schrijfscope dan `statuses`, secrets, een
PR-headcheckout of PR-cache/artifacts zou aannemen. De meter is bewust over-benaderend: een vals
alarm kost een commit, een gemiste schrijfscope kost de poort.

De meter leest de `on:`-sleutel in **alle vier** de YAML-vormen, inclusief de flow-stijl mapping
`on: { pull_request: {} }`. Dat was Codex-bevinding P1 (review `4998729801`, inline `3834885357`): de
oude lezer kende alleen de blokvorm en las een flow-mapping als **leeg**, waardoor een bestand met
flow-triggers en `statuses: write` geen enkele untrusted trigger meer leek te hebben terwijl GitHub het
gewoon op `pull_request` draait. Wat de lezer niet betrouwbaar kan ontleden — een onafgesloten haak,
een dubbele sleutel, tekst na de sluithaak, een onbekende kindregel — levert nu geen lege lijst op maar
`TRIGGER_MAPPING_UNPARSEABLE`. Fail-closed betekent hier: geen uitspraak is een bevinding, geen
vrijbrief.

Statisch afgedwongen is verder de vorm van de writer zelf: precies één job met een schrijfscope, en
juist die job moet een `concurrency`-groep dragen die op een **matrixwaarde** van dezelfde job
sleutelt, met `cancel-in-progress: false` en `queue: max`. Een groep die op `github.run_id`,
`github.run_number`, een eventveld of een constante sleutelt telt niet. Dáárnaast is sinds V13 een
`concurrency` op **workflowniveau** juist VERPLICHT, en wel in precies één vorm: de vaste groep
`autocoding-shield-live-gate-repository`, zonder enige `${{ ... }}`-expressie, met
`cancel-in-progress: false` en `queue: max`. Die tweede rij serialiseert het gedeelde uurquotum
(zie hieronder); de per-PR-rij serialiseert het schrijven per pull request. Ze staan naast elkaar,
niet in plaats van elkaar.

Twee dingen zijn daarbij ruimer dan ze op het eerste gezicht hoeven te zijn. De PR-code-referentie
matcht niet alleen de puntvormen uit een `pull_request`-payload maar ook de **onderstreepvarianten**
`head_sha`, `head_ref`, `head_branch` en `head_commit`: precies die velden draagt een
`workflow_run`-payload, dus een uitcheck op `github.event.workflow_run.head_sha` is dezelfde
PR-gestuurde checkout in een andere spelling. En artifact/cache-acties worden herkend op de **naam
van de actie, ongeacht de eigenaar**: elke `uses:` waarvan het actiepad `cache`, `download-artifact`
of `upload-artifact` bevat telt mee, dus ook `dawidd6/action-download-artifact`, `buildjet/cache` en
`Swatinem/rust-cache`. De vertrouwensgrens zit in wat er binnenkomt, niet in wie het publiceert. Beide
regels lezen alleen structurele regels uit `structureLines()`, dus een `#`-commentaar of een
`run: |`-blok met dezelfde tekst is geen treffer.

### Welke PR's een ronde meet

`scripts/autocoding/select-live-gate-targets.mjs` bepaalt de doellijst, en doet dat zonder de
aanleiding te geloven:

De selectie draait in de job `selecteer`, die **geen enkele schrijfscope** heeft: `contents: read` en
`pull-requests: read`, meer niet. Ze schrijft één ding weg — een JSON-array van PR-nummers die de
matrix van de schrijfjob wordt. Wie de selectie zou compromitteren, kan daarmee hooguit bepalen wélke
PR opnieuw gemeten wordt, nooit wát erover gepubliceerd wordt; die uitspraak volgt uit een verse
meting ná de lock.

1. Bij `issue_comment` is het doel **uitsluitend** `github.event.issue.number`, en alleen als
   `github.event.issue.pull_request` bestaat. Een comment op een gewone issue is geen aanleiding, en
   de tekst van de comment wordt nergens voor gebruikt.
2. Bij `workflow_run` moet de bron de **verwachte** workflow zijn: naam `autocoding-shield`, pad
   `.github/workflows/autocoding-shield.yml`, en een bronevent uit `pull_request`,
   `pull_request_review` of `pull_request_review_comment`. Alles daarbuiten — een andere workflow, een
   gelijknamige workflow op een ander pad, een `workflow_dispatch`, een `push` — schrijft **geen
   enkele status** en is geen rode run: het is simpelweg geen aanleiding. Het doel komt uit
   `workflow_run.pull_requests`, een veld dat GitHub vult; die lijst moet precies één geldig positief
   PR-nummer bevatten. Leeg of dubbelzinnig is fail-closed: geen status, geen gok.
3. Een event meet dus **hooguit één PR** (`EVENT_TARGET_LIMIT = 1`) en wordt nooit een volledige
   ronde. Dat is de kern van Codex-bevinding `3834885350`: de vorige vorm liet elke reviewcomment,
   elke comment en elke schedule dezelfde 126 open heads aanraken, wat op een gedeeld quotum van
   duizend verzoeken per uur onhoudbaar is. `TARGET_SELECTION` kent daarom geen waarde
   `ALL_OPEN_PULL_REQUESTS` meer; alleen `EVENT_PULL_REQUEST` en `SCHEDULE_SLOT_BUCKET`.
4. `schedule` is de convergentiefallback en is de énige aanleiding die de open-PR-lijst leest. Ze
   selecteert een deterministische emmer van hooguit `SCHEDULE_BUCKET_LIMIT = 25` open PR's, gekozen
   op een **tijdslot**: `slot = floor(epochSeconds / 3600)`, `index = slot % ceil(n / 25)`. Bij 126
   open PR's dekken zes opeenvolgende uren de hele lijst, en die dekking is per constructie
   onafhankelijk van `github.run_number`. Dat was Codex-bevinding `3834885354`: runnummers lopen door
   bij **elke** run, ook bij geannuleerde en overgeslagen runs en bij runs van andere aanleidingen,
   dus een rotatie op runnummer kan een emmer stelselmatig overslaan. De test reproduceert dat: zes
   schedule-runs met de nummers 1, 7, 13, 19, 25 en 31 landen zes keer in dezelfde emmer en zien 25
   van de 126 PR's; zes opeenvolgende tijdsloten zien alle 126. Is de klok onbruikbaar, dan faalt de
   selectie gesloten in plaats van stilzwijgend op emmer 0 te blijven staan.
5. Het gedeelde API-budget wordt mechanisch bewaakt, niet beloofd. `selecteer` leest eerst het
   (gratis) `GET /rate_limit` en rekent met vaste bovengrenzen: `PER_PULL_REQUEST_REQUEST_BUDGET = 26`
   verzoeken per gemeten PR, `SELECTION_REQUEST_BUDGET = 4` voor de selectie zelf. Een eventronde kost
   dus hooguit `EVENT_REQUEST_BUDGET = 30`, een volle schedule-ronde hooguit
   `SCHEDULE_REQUEST_BUDGET = 654`, tegen `SHARED_HOURLY_REQUEST_QUOTA = 1000`. Boven op dat quotum
   ligt een vaste reserve van `QUOTA_RESERVE = 100`: is het resterende core-budget te krap, dan
   **krimpt** het venster binnen de emmer tot wat er nog past en wijkt een eventronde helemaal terug
   in plaats van de reserve op te eten. De oude volledige ronde kostte bij 126 open PR's
   `4 + 126 × 26 = 3280` verzoeken; de test toetst dat getal expliciet tegen het quotum.

   **De indeling zelf blijft quotumvrij (Codex-bevinding `3835186656`).** De partities worden
   uitsluitend met de vaste `SCHEDULE_BUCKET_LIMIT = 25` gemaakt; het budget bepaalt alleen hoeveel
   leden van de gekozen emmer deze beurt gemeten worden. Ging het betaalbare aantal wél de
   partitionering in, dan veranderde bij 126 open PR's het aantal emmers mee met het quotum — zes
   bij capaciteit 25, honderdzesentwintig bij capaciteit 1 — en bezocht een budget dat heen en weer
   sprong steeds dezelfde lage nummers. Krimpt het venster, dan wordt er binnen de VASTE emmer een
   circulair deelvenster gekozen dat begint op `bezoek mod emmergrootte`, met
   `bezoek = floor(slot / emmeraantal)`. Dat startanker schuift bij iedere terugkeer van dezelfde
   emmer precies één positie op, ongeacht de capaciteit, dus is ieder lid binnen hoogstens
   `emmergrootte` bezoeken aan de beurt geweest. De test toont dat afwisselend 25/1, 1/25 en een
   willekeurige positieve reeks alle 126 nummers dekken, en dat de oude vorm dat aantoonbaar niet
   doet. In de runlog staan de vaste emmer én het venster: `LIVE_GATE_SLOT_<slot>_BUCKET_<i>_OF_<n>`
   en `LIVE_GATE_BUCKET_SIZE_<m>_VISIT_<b>_WINDOW_<start>_COUNT_<k>`.

   **Een ONBEKEND restant is geen toestemming (Codex-bevinding `3835186662`).** Levert
   `GET /rate_limit` niets bruikbaars op, dan geeft de workflow `-` door en eindigt de selectie op
   de eigen redencode `API_QUOTA_UNKNOWN`: rc 1, lege matrix, rode run, geen enkele schrijver — voor
   event én schedule. Eerder gold onbekend als "dan de vaste bovengrens", waarmee juist een mislukte
   budgetmeting de grootste batch opende. Een BEKEND maar te krap budget blijft daarentegen de
   stille `API_BUDGET_RESERVED` met rc 2: dat is een gemeten uitkomst en geen meetfout.
6. Wat **wel** gesloten faalt is een onleesbare, onbruikbare of niet volledig opgehaalde PR-lijst.
   Dan is niet bekend wélke PR's bestaan, dus is elke ronde per definitie onvolledig: niets
   publiceren en rood worden. Een antwoord dat geen lijst ís, telt daarbij als **onleesbaar** en niet
   als leeg — anders zou één vreemd API-antwoord een stille lege ronde opleveren terwijl een eerder
   groene head groen blijft. Raakt het budget van een lopende meting alsnog op, dan faalt dat per
   record en levert het `failure` op de gemeten head — zichtbaar, niet stil groen.

### Eerst invalideren, dan pas meten — nu per pull request

Een uitspraak die vóór de lock gemeten is, mag niet gepubliceerd worden. Een run die een uur in de rij
stond zou anders een oude momentopname over een nieuwere heen schrijven, en dat is precies de
stale-green die deze poort moet uitsluiten. De volgorde binnen de schrijfjob ligt daarom vast, en pas
ná het verkrijgen van de per-PR-lock begint er iets:

1. Meet het PR-object en de volledige head opnieuw via `GET /repos/{repo}/pulls/{number}` — drie
   pogingen, want een head die niet te meten is mag geen uitspraak opleveren. Een gesloten of gemergde
   PR krijgt geen gegokte status maar een no-op (`PR_… _NOT_OPEN_NO_STATUS`).
2. Publiceer meteen één `pending` op precies die hermeten head, via dezelfde centrale publisher en in
   dezelfde context als de uitspraak (`publish-live-status.mjs --pending`). Vanaf dat moment is die
   head aantoonbaar niet-groen; wat daarna misgaat kan een uitspraak nog uitstellen, maar geen
   `success` meer laten staan. Mislukt de `pending`-POST, dan gaat de job door en wordt hij aan het
   eind alsnog rood.
3. Haal pas dán al het overige bewijs op: de head-commit en de gepagineerde lijsten van commits,
   comments, reviews, reviewcomments en files.
4. Publiceer de uitspraak uitsluitend op diezelfde hermeten head.

Elke wachtende job doorloopt die volgorde zelf opnieuw. Twee aanleidingen voor dezelfde PR meten dus
twee keer vers, en de laatste in de rij publiceert per definitie de nieuwste momentopname. Er wordt
niets meegenomen wat vóór de lock is gemeten — geen artifact, geen cache, geen job-output en geen veld
uit de bronrun; de schrijfstap kent zelfs geen `GITHUB_EVENT_PATH`.

`test/autocoding-live-gate-targets.test.mjs` voert dat `run:`-blok werkelijk uit onder `bash` met
gestubde `gh`/`node` en toetst dat gedrag, in plaats van het te beweren: dat een event voor PR 74
alleen PR 74 aanraakt, dat de `pending` en de uitspraak op dezelfde hermeten head staan, en dat een
wachtende oudere aanleiding de nieuwste head publiceert. Vijf mutaties op de workflowtekst — de
hermeting weghalen, de publicatie ervóór zetten, de rij van de schrijfjob verwijderen, de
repositorybrede rij weghalen of dynamisch maken, of de momentopname via een job-output doorgeven —
maken die toets rood.

### Eén schrijfrij per pull request

Alle aanleidingen schrijven dezelfde statuscontext, maar niet op dezelfde head. Serialiseren hoeft
daarom alleen per pull request, en precies dat doet de schrijfjob:

```yaml
concurrency:
  group: autocoding-shield-live-gate-pr-${{ matrix.pr }}
  cancel-in-progress: false
  queue: max
```

Daarnaast draagt het bestand sinds V13 een tweede, repositorybrede rij op workflowniveau — zie
"De repositorybrede quotumrij" hieronder. In V11 en V12 was die er bewust NIET: een globale rij zou
hele runs samenvoegen en de per-PR-rijen weer op één hoop gooien, zodat een schedule-ronde voor 25
PR's een eventronde voor PR 74 kon verdringen. Wat dat bezwaar wegneemt is niet de rij maar
`queue: max`: wachtende runs blijven staan in plaats van geannuleerd te worden, dus wordt er
uitgesteld en niets weggegooid.

Drie eigenschappen doen hier het werk. `cancel-in-progress: false` zorgt dat een lopende meting niet
halverwege wordt afgebroken — een afgebroken job laat een `pending` staan, geen uitspraak.
`queue: max` is het antwoord op de eerlijke grens van de vorige vorm: onder de standaard
`queue: single` houdt GitHub per groep hooguit één wachtende run aan en **annuleert** de eerdere, dus
kon een aanleiding voor PR 74 verdwijnen zonder ooit gemeten te zijn. Met `queue: max` schuiven
opeenvolgende aanleidingen voor dezelfde PR achter elkaar aan. En omdat de groep op `matrix.pr`
sleutelt, blokkeren aanleidingen voor **verschillende** PR's elkaar niet: PR 74 en PR 75 draaien
gelijktijdig in verschillende groepen, twee aanleidingen voor PR 74 draaien na elkaar in dezelfde.

Coalescing kan hier hooguit een **uitspraak** uitstellen tot de volgende aanleiding of de uurlijkse
schedule; een PR kan er niet permanent door worden overgeslagen, want de schedule-emmer roteert op de
klok en niet op runnummers.

`test/autocoding-live-gate-targets.test.mjs` en `test/autocoding-workflow-trust.test.mjs` meten deze
eigenschappen mét negatieve mutatie: `queue: single`, `cancel-in-progress: true`, een groep op
`github.run_id` of op een constante, een groep zonder matrixsleutel, een ontbrekende of dynamisch
gesleutelde repositorybrede rij en een selectie die terugvalt op een volledige ronde maken de
toetsen aantoonbaar rood.
De groepen worden niet beweerd maar berekend: `groep(74) != groep(75)`, `groep(74) == groep(74)`, en
drie PR's leveren drie verschillende groepen op.

### De repositorybrede quotumrij

De per-PR-rij begrenst het schrijven, maar niet het METEN. Twee eventruns voor verschillende pull
requests vallen in verschillende per-PR-groepen, draaien dus gelijktijdig, lezen allebei hetzelfde
`GET /rate_limit`-restant en reserveren allebei datzelfde restant. Elke run blijft dan binnen zijn
eigen begroting terwijl ze samen over het **gedeelde** uurquotum van duizend verzoeken per
repository heen gaan — veertig geburste events (40 × 30 = 1200) volstaat al, en een schedule plus
twaalf events (654 + 12 × 30 = 1014) evengoed.

Daarom draagt het bestand sinds V13 één rij om de héle run:

```yaml
concurrency:
  group: autocoding-shield-live-gate-repository
  cancel-in-progress: false
  queue: max
```

De groep is een **constante**: geen `run_id`, geen `run_number`, geen eventveld, geen PR-nummer, geen
enkele expressie. Omdat hij op workflowniveau staat, is hij verworven vóór de eerste job — dus vóór
de selectie en vóór de `rate_limit`-meting — en komt hij pas vrij als alle matrixwriters klaar zijn.
Run N+1 meet daardoor pas nadat run N zijn verzoeken werkelijk heeft uitgegeven, en is de
reservering een opeenvolging in plaats van een gok.

`queue: max` is wat deze vorm bruikbaar maakt en is een ondersteunde sleutel, op workflow- én
jobniveau, tot honderd wachtende runs per groep; alleen de combinatie met `cancel-in-progress: true`
is verboden. De canonieke bron bij twijfel is
[workflow-syntax#concurrency](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency).
Onder de standaard `queue: single` zou een derde aanleiding de tweede opeten, en juist dát was in
V11 de reden om een globale rij te weigeren.

`test/autocoding-workflow-trust.test.mjs` dwingt beide rijen statisch af: geen rij, een dynamische of
afwijkende groep, `queue: single`, een ontbrekende `queue` en `cancel-in-progress: true` worden elk
fail-closed afgekeurd.

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

De `issue_comment`-route is wél direct beproefbaar zodra dit bestand op de default branch staat, want
dat event draait per definitie de default-branch-definitie en heeft geen voorafgaande run nodig.

## Waarom de diagnose een commitstatus is, geen checknaam — en geen autorisatie

Gemeten, niet bedacht: een Actions-run die door `workflow_run`, `issue_comment` of `schedule` wordt
getriggerd hangt aan de **default-branch-SHA**, niet aan de PR-head. De
checknaam van zo'n run verschijnt daarom nooit op de PR-head. Een eerder groene check op die head blijft dus staan, ook
nadat het bewijs waarop hij groen werd is verwijderd, bewerkt of dismissed — precies de stale-green
die Codex-reviewcomment `3834428052` reproduceerde.

`scripts/autocoding/publish-live-status.mjs` hangt de diagnose daarom niet aan de checknaam maar
schrijft een expliciete commitstatus op de via de API **gemeten** volledige PR-head, onder de vaste
context `autocoding-shield-diagnostic` uit `policy.diagnostic_status_context`. Die context is
uitdrukkelijk **geen** required check en wordt er ook nooit een: `assertMergeFinalizerPolicySafe`
weigert een `required_checks`-lijst waarin zij voorkomt, dus kan het beleid zichzelf er niet opnieuw
van afhankelijk maken. Twee eigenschappen maken de diagnose convergent:

1. De uitspraak is een pure functie van de API-momentopname. Het event zelf gaat de berekening niet
   in, dus Codex-na-Gemini, Gemini-na-Codex, een edit, een delete, een dismiss en elke volgorde
   daarvan publiceren byte-identiek dezelfde status op dezelfde commit.
2. Er is geen zwijgend pad, en geen groen pad. Een bewezen `GO` wordt `pending` met een vaste
   omschrijving die zichzelf als diagnostiek benoemt; elke `NO_GO`, parsefout, API-truncatie,
   ontbrekend bewijs of uitvoeringsfout schrijft `failure` op diezelfde head. `success` bestaat in
   deze route niet: `PUBLISHABLE_STATES` is een gesloten allowlist van `pending` en `failure`, en
   `publishStatus` weigert vóór élk netwerkverkeer een publicatie met een state daarbuiten
   (`STATUS_STATE_NOT_ALLOWED`). Dat is twee onafhankelijke lagen, zodat een mutant die ergens weer
   `success` laat ontstaan mechanisch stukloopt in plaats van een herbruikbaar groen artefact op een
   gedeelde commit achter te laten. Een crash van de poortstap wordt binnen de lus opgevangen (`|| true`) en als
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
  begint met de exacte succeszin en een `**Reviewed commit:**`-regel draagt.
- **Codex als pull-request-review** — dezelfde bot levert op deze PR een `pull_request_review` mét
  inline comments. Een reviewobject draagt géén `performed_via_github_app`-veld, dus daar is de
  App-id niet af te dwingen; de identiteit hangt op deze route aan `user.login`, `user.type` en het
  gemeten numerieke `user.id` `199175422`. De head komt uit `review.commit_id`. Dat veld wordt in
  drie toestanden gelezen (`resolveReviewCommit`): ONTBREEKT het werkelijk (`null`/`undefined`), dan
  — en alleen dan — telt de `**Reviewed commit:**`-regel, die alsnog mechanisch tegen de
  PR-commitindex wordt geresolveerd; is het aanwezig en oplosbaar, dan wint de API altijd; is het
  aanwezig maar onbruikbaar (leeg, verkeerd van type of vorm, onbekend in deze PR na een
  force-push, of een dubbelzinnige prefix), dan blijft de binding ONOPGELOST. Er is in dat laatste
  geval géén terugval op het lichaam: onopgelost bewijs houdt een lege `resolved_head_sha`, haalt de
  headvergelijking dus nooit, en telt daarmee niet als bewijs op de actuele head.
- **Gemini als pull-request-review** — van `gemini-code-assist[bot]` (`user.id` `176961590`) in een
  toegestane state, met de terminale `## Code Review`-marker.

#### De Codex-succesvorm is de eerste zin, niet het feestwoord

Codex hangt achter zijn schone eerste zin een wisselend feestwoord. Gemeten: `:tada:` op PR #72
(comment 5376132338) en `Swish!` op PR #74 (comment 5378185484), beide van dezelfde bot, dezelfde
App en met dezelfde inhoudelijke uitkomst. Zolang de policy de VOLLEDIGE zin inclusief `:tada:`
pinde, ketste een werkelijk ontvangen schone review af op `NATIVE_TERMINAL_MARKER_MISSING` — een
gemeten integratiefout, geen theoretisch geval.

De gepinde vorm is daarom uitsluitend de betekenisdragende eerste zin:

```
Codex Review: Didn't find any major issues.
```

Wat daarachter staat, telt niet mee. Dat is geen verruiming van de poort: interpunctie,
hoofdletters en de ASCII-apostrof zijn deel van de gepinde vorm, de zin moet vooraan staan (alleen
leidende witruimte wordt genegeerd), en hij moet op een woordgrens eindigen — einde lichaam of
witruimte, zodat een vastgeplakte voortzetting (`... major issues.NOT`) of een langere kop
(`## Code Reviewers ...` op Gemini's marker) gesloten blijft vallen. Near-misssemantiek
(`... major issues, but ...`, `Codex Review: 2 comment(s) generated.`) blijft `NO_GO`. Identiteit,
App-id, headbinding en het bevindingenverbod zijn ongewijzigd: het feestwoord droeg nooit bewijs, de
gepinde bot en de mechanisch geresolveerde commit doen dat wel.

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
**eerdere** status op dezelfde head niet overschrijven. Een verouderde diagnose blijft dan zichtbaar
tijdens de storing. Er kan niets **groens** blijven staan — deze route schrijft geen `success` en
deze context is nergens vereist — dus is het restrisico beperkt tot wat een lezer ziet. De poort
beschikt met `statuses: write` alleen over schrijven; wat niet geschreven kan worden, kan ook niet
ingetrokken worden. De run is wél rood, en de eerstvolgende geslaagde publicatie op dezelfde head
herstelt de diagnose — die is immers een pure functie van de momentopname, niet van het event.

## De mergefinalizer

De enige plaats in deze repository waar een merge kan ontstaan. Hij staat in deze pull request
volledig uit; wat hier beschreven wordt is de vorm, niet een draaiende voorziening.

**Bestanden.** `.github/workflows/autocoding-merge-finalizer.yml` (de trusted workflow),
`scripts/autocoding/finalize-merge.mjs` (de zuivere beslisser en de enige transportfunctie) en
`scripts/autocoding/select-finalize-candidates.mjs` (kandidaatselectie). De bewijswet zelf wordt
**niet** herschreven: het native tweevendorbewijs, de bewijsbinding en de ownergate komen ongewijzigd
uit `collect-shield-input.mjs` en `verify-review-gate.mjs`. Een tweede losse parser van dezelfde wet
zou van de eerste weg kunnen lopen, en dan is niet meer te zeggen welke van de twee de poort is.

**Alleen `schedule`.** `workflow_run` zou de finalizer laten starten door de voltooiing van een run
waarvan de pull request de definitie levert; `issue_comment` zou iedere commentator een trekker naar
een token met mergerechten geven; `workflow_dispatch` draait de definitie van de gekozen ref, dus zou
een pull request zijn eigen finalizer kunnen voorstellen. Een klok kan niemand richten. De prijs is
latentie — hoogstens één ronde.

**Selectie is geen autorisatie.** De kandidatenlijst komt uit de open-PR-lijst, en die is
offsetgepagineerd. Dat mag hier, omdat de lijst niets draagt: zij levert alleen een nummer. Valt een
pull request door de paginering tussenuit, dan wordt hij deze ronde niet bekeken — er gebeurt niets,
en dat is de fail-closed richting. Elke kandidaat die doorkomt wordt daarna volledig en uitsluitend
op zijn EIGEN hermeten bewijs beoordeeld.

**Beslissing en effect zijn gescheiden.** `resolveFinalization` is puur — geen netwerk, geen
bestanden, geen klok — en levert `FINALIZE_GO` of `FINALIZE_NO_GO` met redencodes uit een gesloten
verzameling. De redenen worden cumulatief verzameld en niet bij de eerste tegenstem afgebroken, zodat
het log alle gronden draagt. Gemeten worden: PR-nummer, `state`/`draft`, de volledige head, de boom,
de base-SHA en de base-ref, de bouwer, de task-id, de volledigheid van de bestandslijst, de actuele
Codex- en Gemini-reviews inclusief inline bevindingen, de ownerautorisatie voor gevoelige paden, en de
vereiste check-runs op precies deze head.

**Het effect is één verzoek.** `mergePullRequest` doet uitsluitend
`PUT /repos/{owner}/{repo}/pulls/{number}/merge` met de hermeten volledige `sha` en een `merge_method`
uit een vaste allowlist. Geen branchnaam, geen afgekorte SHA, geen event-SHA. Vlak vóór het verzoek
wordt opnieuw gemeten en tegen de vingerafdruk van de beslissing gelegd (`measurementFingerprint`,
een sha256 over een genormaliseerde projectie met alleen digests van teksten, nooit tekst zelf). Bij
drift, een ingetrokken review, een nieuwe bevinding, gewijzigde checks, ontbrekend bewijs of
onleesbaarheid: nul mergeverzoeken. Een 409, 405 of 422 is terminaal — er wordt nooit opnieuw
geprobeerd met een nieuwere, ongetoetste head.

**Klasse A en B.** Klasse A is de gewone weg en vereist een ownerautorisatie die exact aan dit
PR-nummer, deze head, deze boom, deze base en deze task bindt. Klasse B is de latere autofinalisatie
voor werk dat geen gevoelig pad raakt; die staat uit (`class_b_auto_merge_enabled: false`), dus is
vandaag ELKE kandidaat klasse A.

**Waarom een echte merge nu mechanisch onmogelijk is**, op drie onafhankelijke plaatsen: de
poortstap in de workflow stopt op de uitgeschakelde vlag vóór het eerste API-verzoek; de
kandidatenlijst blijft daardoor leeg en de matrix draait nul jobs; en `mergePullRequest` weigert
bovendien in de code zelf vóór elk netwerkverkeer. `test/autocoding-merge-finalizer.test.mjs` meet
dat af, inclusief mutanten die respectievelijk de `sha` uit het lichaam halen, de PR-binding
weglaten, de ownerbinding versoepelen, de driftvergelijking overslaan of de vlag negeren — alle vijf
gaan aantoonbaar rood.

## Activering en compatibiliteit

Deze wijziging zet `live_receipt_gate_enabled` **niet** aan, en `merge_finalizer_enabled` en
`class_b_auto_merge_enabled` evenmin. De poort is compleet en getest, maar de stap
`Bepaal poortstand en statuscontext` eindigt op `BOOTSTRAP_RECEIPT_GATE_DISABLED` zolang de vlag uit
staat, en er wordt dan ook geen enkele status gepubliceerd.

Activering is een **afzonderlijke latere PR** die precies drie dingen doet, in deze volgorde:

1. `live_receipt_gate_enabled` op `true` zetten in `CONTROL/AUTOCODING/policy.v1.json`, nadat de
   gate-bestanden via merge op de default branch staan en een fixture-PR de negatieve én de positieve
   route heeft aangetoond.
2. De gemeten vendoridentiteiten herbevestigen tegen de dan actuele GitHub-App-id's.
3. **Geen** statuscontext als required check instellen — en `autocoding-shield-diagnostic` al
   helemaal niet. Dat was tot V17 wél het plan, en Codex-bevinding `3835364972` sloot die route af:
   een commitstatus hoort bij de commit, dus zou een tweede pull request op dezelfde head de
   vereiste check als vervuld zien. Een required check hoort te gaan over de CODE (`autocoding-shield`
   is zo'n check, al draait die PR-headcode en autoriseert hij dus niets), niet over een
   reviewuitspraak. De mergeautorisatie loopt sinds V18 uitsluitend via de mergefinalizer hieronder,
   die per pull request beslist en zijn uitkomst nergens als herbruikbaar artefact achterlaat.

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

Alle drie de workflowbestanden gebruiken minimale permissions. `autocoding-shield.yml` heeft **geen enkele**
schrijfscope — bestandsniveau `permissions: {}`, de PR-job `contents: read`, de signaaljob
`permissions: {}`. `autocoding-shield-live-gate.yml` heeft er precies één, `statuses: write`, en die zit uitsluitend op de
matrixjob `schrijf`, naast `contents: read`, `pull-requests: read` en `issues: read`. De selectiejob
`selecteer` draagt géén schrijfscope: die leest alleen. Geen `contents: write`,
geen `actions: write`, geen `pull-requests: write`, geen `id-token: write`, geen secrets, geen
environment, geen artifacts of cache, geen PR-headcheckout, en nooit `pull_request_target`. Dat wordt
statisch afgedwongen: `findTrustBoundaryViolations` weigert elke andere trigger op het writerbestand,
een ongepinde of verkeerd gepinde `workflow_run`-bron, een tweede job met een schrijfscope, een
schrijfjob zonder eigen per-PR-rij, een ontbrekende of afwijkende repositorybrede rij, `issue_comment` met een
schrijfscope buiten dit ene bestand, een niet te ontleden `on:`-mapping, en een uitcheckende shieldjob
die niet tot `pull_request` beperkt is.

`autocoding-merge-finalizer.yml` heeft er eveneens precies één: `pull-requests: write`, uitsluitend op
de finalisatiejob, naast `contents: read` en `issues: read`. Die scope bestaat in deze repository op
**precies één job**, en `findTrustBoundaryViolations` meet dat af over álle workflowbestanden
(`PULL_REQUESTS_WRITE_OUTSIDE_FINALIZER`). Omgekeerd draagt de finalizer geen `statuses: write`
(`STATUSES_WRITE_OUTSIDE_TRUSTED_WRITER`): de twee bevoegdheden liggen fysiek uit elkaar, zodat geen
van beide de ander kan naspelen. Verder geldt voor dit bestand hetzelfde als voor de writer — geen
secrets, geen artifacts of cache, geen PR-checkout, uitsluitend `schedule`, en een verplichte
repositorybrede `queue: max`-rij vóór hermeting en merge.

Zolang de trusted gatebestanden nog niet op de default branch bestaan, meldt de schrijfjob
expliciet een bootstrap-no-op; validator-, adapter-, doelselectie-, vertrouwensgrens- en branchtests
draaien op het `pull_request`-pad.
