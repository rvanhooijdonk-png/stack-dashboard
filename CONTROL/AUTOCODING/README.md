# Autocoding Shield

De Shield levert één stabiele GitHub-check, `autocoding-shield`, voor pull requests naar `main`.
Hij toetst de validator en scant de branchdiff op secretachtige waarden. De live receiptpoort staat in
`policy.v1.json` bewust uit tijdens bootstrap. Dat is geen PR-specifieke bypass: inschakelen vereist
een afzonderlijke wijziging van het beleid nadat een fixture-PR de negatieve en positieve route heeft
bewezen.

## Receiptcontract

Een receipt staat als JSON in een fenced blok met infostring
`autocoding-review-receipt-v1` en schema `AUTOCODING_REVIEW_RECEIPT_V1`. Vereist zijn `task_id`,
`reviewer_actor`, `reviewer_vendor`, een unieke `receipt_uuid`, volledige actuele `head_sha` en
`tree_sha`, `verdict` (`GO` of `NO_GO`), niet-lege `checks_executed` en `builder_actor`.

De poort meet head, tree en bouwer via GitHub. Hij bindt `reviewer_actor` bovendien aan de door
GitHub geleverde auteur van het comment of de review. Twee actuele GO-receipts van verschillende,
vooraf gepinde leveranciers en actors zijn nodig. De selectie vertrouwt eerst uitsluitend de exact
toegestane GitHub-transportactor, negeert daarna receipts voor een oudere head en valideert pas dan
de actuele set. Daardoor kan publieke ruis geen fouten of duplicaten injecteren, tellen oude reviews
nooit voor een nieuwe head en blijft een malformed of NO_GO-receipt van een toegestane actor rood.
Met uitsluitend stale receipts ontbreken dus actuele vereiste receipts en blijft de uitslag NO_GO.
Afgekorte objecten, zelfreview, dubbele
actor/vendor/UUID, lege of overgeslagen checks, lege rc0-output, NO_GO, onbekende velden, parserfouten,
narratief zonder machineblok en wildcard/onbekende transportidentiteiten blijven rood. De uitvoer
bevat uitsluitend redencodes; receiptinhoud wordt niet gelogd.

Alle huidige lanes gebruiken dezelfde GitHub-eigenaar. `reviewer_actor` alleen is daarom geen
identiteitsbewijs. De live poort mag pas required worden nadat de pilot de werkelijke GitHub-App- of
botidentiteiten van Gemini en Codex heeft gemeten en exact in de lege allowlists heeft gepind.

## Activering en compatibiliteit

Na merge volgt eerst een nieuwe fixture-PR. Pas na een afzonderlijk besluit mogen de gemeten actors
worden gepind, `live_receipt_gate_enabled` op `true` worden gezet en de stabiele check als required
status check worden ingesteld.

Een generieke regel “alle wijzigingen moeten via een PR” mag niet stilzwijgend worden geactiveerd.
`.github/workflows/doorstroom.yml` en `.github/workflows/waarnemer.yml` bevatten jobs met
`contents: write` die rechtstreeks naar `main` pushen. Een ruleset/branch-protection met
`required_pull_request_reviews` (of “Require a pull request before merging”) zonder expliciete bypass
voor die GitHub Actions-identiteiten blokkeert die schrijvers. Vereiste status checks kunnen hun
pushes eveneens blokkeren wanneer voor de nieuwe commit geen passende check bestaat. De toekomstige
protection moet dus óf die twee gemeten schrijvers gericht laten bypassen, óf hun schrijfroute eerst
naar PR's ombouwen. Deze repositorywijziging past geen protection of ruleset toe.

De workflow gebruikt minimale read-permissions, geen secrets/environment/artifacts en nooit
`pull_request_target`. Comment/review-events lezen alleen GitHub-data; code uit een PR-head wordt
alleen in de read-only `pull_request`-context uitgevoerd. Zolang de trusted gatebestanden nog niet op
de default branch bestaan, melden comment/review-events expliciet een bootstrap-no-op; validator- en
branchtests draaien op het `pull_request`-pad.

Een toekomstige required live gate moet vanuit een afzonderlijk trusted workflowpad op de default
branch worden geactiveerd en geëvalueerd. PR-headcode, PR-headpolicy en deze bootstrapworkflow mogen
die gate niet kunnen uitschakelen en mogen niet onder dezelfde required checknaam een successtatus
kunnen produceren. Die activeringsgrens wordt niet met `pull_request_target` overbrugd.
