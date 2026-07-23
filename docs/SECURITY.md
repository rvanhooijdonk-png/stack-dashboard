# Security- en publicatiedoctrine

> Deze doctrine is overgenomen en aangepast uit het lokale Codex-artefact `stack-dashboard`
> (`docs/SECURITY.md`, juli 2026). De inhoudelijke uitgangspunten daar waren goed; de code
> ernaast was fixture-only en is niet hergebruikt. Zie `README.md` § Herkomst.

## 1. De pagina is openbaar — dat is een besluit, geen vergissing

De staande regel in de werkwijze is: *nieuwe repo's worden privé aangemaakt*. Richard heeft voor
dit dashboard expliciet **OPENBAAR (GitHub Pages, gesaneerd)** gekozen. Die afwijking is bewust
en is hardop benoemd vóór het aanmaken van de repo.

Consequentie: **alles in deze repo en in elke build-output is publiek leesbaar door iedereen.**
De hele rest van dit document volgt daaruit.

## 2. Wat hier nooit terecht mag komen

Niet in de repo, niet in de output, niet in een logregel, niet in een foutmelding:

- tokens, sleutels, wachtwoorden, cookies, private keys, signed URL's
- **namen** van secrets en env-vars (op een openbare pagina is de naam al een aanwijzing)
- klantdata en persoonsgegevens, inclusief e-mailadressen
- lokale/persoonlijke paden (`/Users/…`, `/home/…`)
- interne hostnames en IP-adressen
- **vrije tekst uit de canon** — kopregels van tracker-updates, besluitregels, journaalkoppen.
  Zie §3; dit is sinds de tweede review de hoofdregel, niet een detail.

## 3. Vrije tekst gaat er standaard niet in

De tweede dubbele review (Codex + Gemini, 23-07-2026) haalde de vorige opzet onderuit met een
levende probe. Een besluitregel met de tekst *"Project Saffier: overname van klant Zephyr gaat
vrijdag live"* passeerde elke patroongate en stond gewoon op de openbare pagina — nul bevindingen.

Dat is geen bug in een regex. **Geen enkel patroon herkent bedrijfsinhoud.** Een tracker-kop is
gewone Nederlandse proza uit een privé-control-plane; er is niets aan de vorm waaraan een gate ziet
dat het een klantnaam, een overnamedatum of een omzetcijfer bevat.

Daarom is de verdediging niet langer "filteren", maar **niet meenemen**:

- `data/publish-text.json` is een schakelaar per sectie: `trackerUpdates`, `trackerDecisionPoints`,
  `decisions`, `logbook`. Alle vier staan op `false`.
- Op `false` publiceert de pagina de **structuur** — nummers, ID's, datums, statussen, aantallen —
  en zet de titel op `null`. De renderer toont een streepje plus de zichtbare melding dat de titels
  ingehouden zijn. Geen stille leegte die als "niets te melden" leest.
- Een schakelaar op `true` zetten is een menselijke handeling met een menselijke voorwaarde:
  iemand heeft de brontekst van die sectie regel voor regel nagelopen én accepteert dat elke
  toekomstige regel er ook op komt. Vooraf, niet achteraf.
- De build logt bij elke run welke secties vrijgegeven zijn (`vrije tekst gepubliceerd: …`).

De structuur draagt de status; de tekst draagt het bedrijfsgeheim.

## 4. Namen zijn ook inhoud — twee allowlists

Een bestandsnaam of reponaam is vaak al de informatie. Beide paden zijn daarom allowlist-only,
niet denylist:

- `data/public-repos.json` — repo's die bij naam mogen verschijnen in de PR-, merge- en
  CI-secties. De rest wordt geteld (`hiddenRepositories`, `hiddenCiRepositories`), niet benoemd.
- `data/public-tracks.json` — vloottracks die bij naam mogen. Een bestand in `CONTROL/TASK-QUEUE/`
  kan een project-, klant- of branchnaam zijn. Wat er niet in staat telt mee als `hiddenTracks`.

Gevolg, en zo bedoeld: **een nieuwe repo of een nieuw queue-bestand verschijnt niet vanzelf op de
pagina.** Groeien kost een bewuste regel in een allowlist.

## 5. Twee onafhankelijke poorten daaronder

**Poort 1 — veldenallowlist (`scripts/lib/collect.mjs` + `toPublicSnapshot`).** Elke collector
kiest expliciet welke velden hij overneemt, en `toPublicSnapshot` bouwt de publieke DTO veld voor
veld op — geen `...spread`, nergens. Een nieuw veld in een collector verschijnt dus niet vanzelf in
de publicatie. Dit is de primaire verdediging: wat nooit wordt gekopieerd, kan niet lekken.

**Poort 2 — sanitize-gate (`scripts/lib/sanitize.mjs`).** Het laatste vangnet, tussen verzamelen
en renderen. Loopt de volledige snapshot af, redigeert bekende patronen, en breekt in strikte
modus de build af bij één treffer. Fail-closed: **liever geen dashboard dan een dashboard dat
iets prijsgeeft.** Een string die de lengtegrens overschrijdt wordt volledig vervangen, niet
afgekapt — een afgekapt prefix is nog steeds een lek.

De gate rapporteert alleen `patroon-id @ JSON-pad` — nooit de aangetroffen waarde. Een
foutmelding mag zelf geen lek zijn.

Deze gate is nadrukkelijk **het net, niet de muur.** Zie §3: hij kan onmogelijk beoordelen wat
proza betekent, en er mag geen enkel ontwerp op leunen alsof hij dat wel kan.

**Poort 3 in CI — `gitleaks` draait op de gegenereerde output vóór elke publicatie.** Faalt hij,
dan wordt er niet gepubliceerd. Dit is onafhankelijk van poort 1 en 2 en is de reden dat een fout
in onze eigen regexen niet meteen een incident is.

## 6. Geen credentials in de browser

De pagina is statische HTML zonder fetch, zonder externe assets, zonder analytics. Verversen
gebeurt met `<meta http-equiv="refresh">` — de browser haalt dezelfde statische pagina opnieuw
op. Er is dus geen client-side code die een token nodig heeft, en dus ook geen token dat kan
uitlekken via de bundle of het netwerkpaneel.

Alle GitHub-toegang gebeurt **server-side in CI**, met een read-only token van minimale scope.
Zie `docs/TOKEN-SETUP.md`.

## 7. Vertrouwensmodel: een onbereikbare bron is geen groene bron

Elke sectie draagt een `trust`-oordeel uit de enum `VERIFIED_CURRENT · STALE · UNVERIFIED ·
SOURCE_UNAVAILABLE · CONFLICTING_EVIDENCE`. Een mislukte ophaal- of parse-actie mapt naar
`SOURCE_UNAVAILABLE` en toont dat zichtbaar op de pagina — **nooit een gecachte groene stand.**
Dit is de kern van het Codex-artefact die het waard was om te behouden: een dashboard dat bij
uitval stilletjes de laatste goede meting blijft tonen, is gevaarlijker dan geen dashboard.

**Leesbaar is niet hetzelfde als actueel.** Een bronbestand dat prima parst maar al maanden niet
gewijzigd is, kreeg voorheen `VERIFIED_CURRENT` — groen, terwijl de inhoud oud was. Sinds de tweede
review geldt: een bron die langer dan **14 dagen** (`STALE_DAYS` in `collect.mjs`) niet is gewijzigd
krijgt `STALE`, met de notitie *"de pagina is vers, de inhoud niet"*. Is de laatste wijzigingsdatum
niet vast te stellen, dan `UNVERIFIED` — niet groen bij gebrek aan bewijs.

`overallStatus` wordt `DEGRADED` zodra één bron niet `VERIFIED_CURRENT` is.

## 8. Read-only, altijd

De generator voert geen mutatie uit. Geen merge, geen close, geen comment, geen deploy, geen
retry, geen provider-activatie. Het token dat hij gebruikt heeft ook geen schrijfrechten — de
dubbele borging is opzettelijk.

## 9. Het dashboard is weergave, geen waarheid

De canon staat in `stack-control` en in de projectrepo's. Deze pagina toont de stand daarvan met
tijdstempel en trust-oordeel. Bij twijfel wint de bron, niet de pagina.

Bronpaden en bewijs-URL's staan **niet** in de publieke DTO: een pad naar een privé-bestand is op
een openbare pagina zelf een aanwijzing. Wie de bron mag zien, weet waar de canon staat; wie hem
niet mag zien, hoeft het pad niet te leren. De interne snapshot in `.local/snapshot.json` houdt de
volledige herkomst wél bij, buiten de publicatie en buiten git.

## 10. Melden

Zie je iets op de gepubliceerde pagina dat er niet hoort te staan: meld het direct bij Richard
en verwijder de Pages-publicatie vóór de analyse. Een openbare pagina corrigeer je niet met een
commit — de oude versie is dan al opgehaald.
