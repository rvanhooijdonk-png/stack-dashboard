# Autocoding Shield

De Shield levert één stabiele GitHub-check, `autocoding-shield`, voor pull requests naar `main`.
Hij toetst de validator en scant de branchdiff op secretachtige waarden. De live receiptpoort staat in
`policy.v1.json` bewust uit tijdens bootstrap. Dat is geen PR-specifieke bypass: inschakelen vereist
een afzonderlijke wijziging van het beleid nadat een fixture-PR de negatieve en positieve route heeft
bewezen.

## Twee gescheiden workflowjobs

`.github/workflows/autocoding-shield.yml` bevat twee jobs met bewust verschillende checknamen:

| job | events | checkout | doet |
| --- | --- | --- | --- |
| `autocoding-shield` | uitsluitend `pull_request` | PR-head | validator- en adaptertests, secretscan op de branchdiff |
| `autocoding-shield-live-gate` | alle drie de events | default branch | leest de PR read-only via de GitHub-API en evalueert de poort |

Die scheiding is de kern van de bootstrapgarantie. Comment- en review-events draaien nooit onder de
stabiele checknaam, dus een comment kan een kandidaat niet vals groen maken. En de live poort voert
nooit PR-headcode uit en leest nooit PR-headpolicy: hij checkt altijd de default branch uit. PR-head
kan de poort dus noch uitschakelen noch onder zijn checknaam een successtatus produceren. Die grens
wordt niet met `pull_request_target` overbrugd; geen enkele job heeft schrijfrechten of secrets.

## Native reviewbewijs

Codex en Gemini kennen het receiptschema hieronder niet en kunnen het dus niet schrijven. Bewijs is
daarom hun eigen, ongewijzigde GitHub-uitvoer, gemeten door
`scripts/autocoding/collect-shield-input.mjs` en beoordeeld door
`scripts/autocoding/verify-review-gate.mjs`:

- **Codex** — een issue-comment van `chatgpt-codex-connector[bot]` via GitHub-App `1144995`, die
  begint met het exacte succesbericht en een `**Reviewed commit:**`-regel draagt.
- **Gemini** — een pull-request-review van `gemini-code-assist[bot]` in een toegestane state, met de
  terminale `## Code Review`-marker en **nul** inline reviewcomments op diezelfde review.

Drie dingen worden mechanisch gemeten in plaats van geloofd. De transportidentiteit komt van
GitHub (`user.login`, `user.type`, `performed_via_github_app.id`) en is niet door een auteur te
zetten; een gespoofd comment met identieke tekst levert dus geen bewijsstuk op, alleen ruis. De
afgekorte commit uit een Codex-comment wordt tegen de commitlijst van de PR zelf geresolveerd —
precies één prefixtreffer telt, nul of meerdere treffers leveren geen meting op en falen gesloten op
`STALE_HEAD`. En de gevoelige paden komen uit `/pulls/{n}/files`, niet uit PR-proza.

Bewijs dat naar een andere bekende head resolveert is een afgeronde ronde van een vorige push:
auditdata, nooit opnieuw geldig, en evenmin een blokkade voor de actuele head. Bewijs dat helemaal
niet resolveert blijft wél staan en faalt gesloten — een gepinde bot die naar een onbekende commit
wijst is een anomalie, geen ruis. Met uitsluitend stale bewijs blijft de uitslag `NO_GO`.

## Ownergate op gevoelige paden

Raakt de diff `.github/workflows/**` of `CONTROL/AUTOCODING/**`, dan komt daar één apart
ownerreceipt bij, in het generieke receiptschema hieronder met `policy.owner_gate` als eigen kleine
policy. De owner telt **nooit** als reviewvendor: zijn receipt draagt vendor `owner`, nooit `codex`
of `gemini`, dus de twee poorten kunnen elkaar niet vervangen. `assertNativeVendorsSafe` weigert
bovendien elke policy waarin een owner-vendornaam of owner-actor ook als vereiste reviewvendor of
vendoractor voorkomt. Zonder bruikbare bestandslijst geldt een PR als gevoelig: onbekend zicht is
nooit een vrijstelling.

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

## Activering en compatibiliteit

Deze wijziging zet `live_receipt_gate_enabled` **niet** aan. De poort is compleet en getest, maar de
`Live receiptpoort`-stap eindigt op `BOOTSTRAP_RECEIPT_GATE_DISABLED` zolang de vlag uit staat.

Activering is een **afzonderlijke latere PR** die precies drie dingen doet, in deze volgorde:

1. `live_receipt_gate_enabled` op `true` zetten in `CONTROL/AUTOCODING/policy.v1.json`, nadat de
   gate-bestanden via merge op de default branch staan en een fixture-PR de negatieve én de positieve
   route heeft aangetoond.
2. De gemeten vendoridentiteiten herbevestigen tegen de dan actuele GitHub-App-id's.
3. `autocoding-shield-live-gate` als required status check instellen — niet `autocoding-shield`, want
   die job draait PR-headcode.

Een generieke regel "alle wijzigingen moeten via een PR" mag niet stilzwijgend worden geactiveerd.
`.github/workflows/doorstroom.yml` en `.github/workflows/waarnemer.yml` bevatten jobs met
`contents: write` die rechtstreeks naar `main` pushen. Een ruleset/branch-protection met
`required_pull_request_reviews` (of "Require a pull request before merging") zonder expliciete bypass
voor die GitHub Actions-identiteiten blokkeert die schrijvers. Vereiste status checks kunnen hun
pushes eveneens blokkeren wanneer voor de nieuwe commit geen passende check bestaat. De toekomstige
protection moet dus óf die twee gemeten schrijvers gericht laten bypassen, óf hun schrijfroute eerst
naar PR's ombouwen. Deze repositorywijziging past geen protection of ruleset toe.

De workflow gebruikt minimale read-permissions, geen secrets/environment/artifacts en nooit
`pull_request_target`. Zolang de trusted gatebestanden nog niet op de default branch bestaan, meldt
de live-gate-job expliciet een bootstrap-no-op; validator-, adapter- en branchtests draaien op het
`pull_request`-pad.
