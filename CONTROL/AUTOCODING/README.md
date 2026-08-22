# Autocoding Shield

De Shield levert één stabiele GitHub-check, `autocoding-shield`, voor pull requests naar `main`.
Hij toetst de validator en scant de branchdiff op secretachtige waarden. De live receiptpoort staat in
`policy.v1.json` bewust uit tijdens bootstrap. Dat is geen PR-specifieke bypass: inschakelen vereist
een afzonderlijke wijziging van het beleid nadat een fixture-PR de negatieve en positieve route heeft
bewezen.

## Twee jobs en één statuscontext

`.github/workflows/autocoding-shield.yml` bevat twee jobs met bewust verschillende checknamen, plus
een derde naam die géén job is:

| naam | soort | events | checkout | doet |
| --- | --- | --- | --- | --- |
| `autocoding-shield` | job | uitsluitend `pull_request` | PR-head | validator-, adapter- en publishertests, secretscan op de branchdiff |
| `autocoding-shield-live-gate` | job | alle drie de events | default branch | leest de PR read-only via de GitHub-API en evalueert de poort |
| `autocoding-shield-live-receipts` | commitstatus-context | — | — | draagt de uitspraak op de gemeten PR-head; dit is de naam die later required wordt |

Die scheiding is de kern van de bootstrapgarantie. Comment- en review-events draaien nooit onder de
stabiele checknaam, dus een comment kan een kandidaat niet vals groen maken. En de live poort voert
nooit PR-headcode uit en leest nooit PR-headpolicy: hij checkt altijd de default branch uit. PR-head
kan de poort dus noch uitschakelen noch onder zijn checknaam een successtatus produceren. Die grens
wordt niet met `pull_request_target` overbrugd en er zijn geen secrets. De enige schrijfscope in het
hele bestand is `statuses: write`, uitsluitend op de trusted default-branch-job — zie hieronder
waarom die scope er moest komen.

## Waarom de uitspraak een commitstatus is, geen checknaam

Gemeten, niet bedacht: een Actions-run die door `issue_comment` of `pull_request_review` wordt
getriggerd hangt aan de **default-branch-SHA**, niet aan de PR-head. De checknaam van zo'n run
verschijnt daarom nooit op de PR-head. Een eerder groene check op die head blijft dus staan, ook
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
   head. De publicatiestap draait daarom onder `always()` en de poortstap onder
   `continue-on-error: true` — rood worden gebeurt ná de publicatie, niet ervoor.

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

Raakt de diff `.github/workflows/**` of `CONTROL/AUTOCODING/**`, dan komt daar één aparte
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
   verschijnt bij comment- en review-events helemaal niet op de PR-head. Alleen de commitstatus staat
   gegarandeerd op de gemeten head.

Een generieke regel "alle wijzigingen moeten via een PR" mag niet stilzwijgend worden geactiveerd.
`.github/workflows/doorstroom.yml` en `.github/workflows/waarnemer.yml` bevatten jobs met
`contents: write` die rechtstreeks naar `main` pushen. Een ruleset/branch-protection met
`required_pull_request_reviews` (of "Require a pull request before merging") zonder expliciete bypass
voor die GitHub Actions-identiteiten blokkeert die schrijvers. Vereiste status checks kunnen hun
pushes eveneens blokkeren wanneer voor de nieuwe commit geen passende check bestaat. De toekomstige
protection moet dus óf die twee gemeten schrijvers gericht laten bypassen, óf hun schrijfroute eerst
naar PR's ombouwen. Deze repositorywijziging past geen protection of ruleset toe.

De workflow gebruikt minimale permissions — read-only overal, met als enige uitzondering
`statuses: write` op de trusted default-branch-job — en geen secrets/environment/artifacts en nooit
`pull_request_target`. Geen `contents: write`, geen `actions: write`, geen `pull-requests: write`. Zolang de trusted gatebestanden nog niet op de default branch bestaan, meldt
de live-gate-job expliciet een bootstrap-no-op; validator-, adapter- en branchtests draaien op het
`pull_request`-pad.
