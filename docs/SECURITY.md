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
- de body van tracker-updates, journaal-entries of PR-beschrijvingen — alleen kopregels

## 3. Twee onafhankelijke poorten

**Poort 1 — veldenallowlist (`scripts/lib/collect.mjs`).** Elke collector kiest expliciet welke
velden hij overneemt. Er is geen `...spread` van een API-respons naar de snapshot. Dit is de
primaire verdediging: wat nooit wordt opgehaald, kan niet lekken.

**Poort 2 — sanitize-gate (`scripts/lib/sanitize.mjs`).** Het laatste vangnet, tussen verzamelen
en renderen. Loopt de volledige snapshot af, redigeert bekende patronen, en breekt in strikte
modus de build af bij één treffer. Fail-closed: **liever geen dashboard dan een dashboard dat
iets prijsgeeft.**

De gate rapporteert alleen `patroon-id @ JSON-pad` — nooit de aangetroffen waarde. Een
foutmelding mag zelf geen lek zijn.

**Poort 3 in CI — `gitleaks` draait op de gegenereerde output vóór elke publicatie.** Faalt hij,
dan wordt er niet gepubliceerd. Dit is onafhankelijk van poort 1 en 2 en is de reden dat een fout
in onze eigen regexen niet meteen een incident is.

## 4. Geen credentials in de browser

De pagina is statische HTML zonder fetch, zonder externe assets, zonder analytics. Verversen
gebeurt met `<meta http-equiv="refresh">` — de browser haalt dezelfde statische pagina opnieuw
op. Er is dus geen client-side code die een token nodig heeft, en dus ook geen token dat kan
uitlekken via de bundle of het netwerkpaneel.

Alle GitHub-toegang gebeurt **server-side in CI**, met een read-only token van minimale scope.
Zie `docs/TOKEN-SETUP.md`.

## 5. Vertrouwensmodel: een onbereikbare bron is geen groene bron

Elke sectie draagt een `trust`-oordeel uit de enum `VERIFIED_CURRENT · STALE · UNVERIFIED ·
SOURCE_UNAVAILABLE · CONFLICTING_EVIDENCE`. Een mislukte ophaal- of parse-actie mapt naar
`SOURCE_UNAVAILABLE` en toont dat zichtbaar op de pagina — **nooit een gecachte groene stand.**
Dit is de kern van het Codex-artefact die het waard was om te behouden: een dashboard dat bij
uitval stilletjes de laatste goede meting blijft tonen, is gevaarlijker dan geen dashboard.

`overallStatus` wordt `DEGRADED` zodra één bron onbereikbaar is.

## 6. Read-only, altijd

De generator voert geen mutatie uit. Geen merge, geen close, geen comment, geen deploy, geen
retry, geen provider-activatie. Het token dat hij gebruikt heeft ook geen schrijfrechten — de
dubbele borging is opzettelijk.

## 7. Het dashboard is weergave, geen waarheid

De canon staat in `stack-control` en in de projectrepo's. Deze pagina toont die canon met
bronverwijzing en tijdstempel. Bij twijfel wint de bron, niet de pagina. Daarom draagt elke
sectie een `proofUrl` naar het bronbestand op GitHub.

## 8. Melden

Zie je iets op de gepubliceerde pagina dat er niet hoort te staan: meld het direct bij Richard
en verwijder de Pages-publicatie vóór de analyse. Een openbare pagina corrigeer je niet met een
commit — de oude versie is dan al opgehaald.
