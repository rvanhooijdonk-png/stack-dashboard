# Na-publicatie-controle + spiegelwet — rapport 26-07-2026

Status: **VOORSTEL, WACHT OP AKKOORD** (PR #27, tak `feat/waarnemer`). Niet samengevoegd; samenvoegen
doet een ander dan de auteur (D-0021).

## 0. Identiteitscontrole (gevraagd vóór uitvoering)

| Vraag | Meting | Uitkomst |
|---|---|---|
| Werkmap | `pwd` → `/Users/richardvanhooijdonk/stack-dashboard` | ja |
| Herkomst | `git remote get-url origin` → `git@github.com:rvanhooijdonk-png/stack-dashboard.git` | ja |
| Tak | `git branch -vv` → `feat/waarnemer 7d2f9f5 [origin/feat/waarnemer]` | bestaat |
| Voorstel | `gh pr view 27` → head `feat/waarnemer`, base `feat/kanaalpost-spiegel` (#24) | gestapeld |
| Bestanden | `git diff --stat origin/feat/kanaalpost-spiegel...feat/waarnemer` → `waarnemer.yml`, `scripts/waarnemer.mjs`, `scripts/lib/waarnemer.mjs`, `test/waarnemer.test.mjs`, één spiegelregel | drie nieuwe bestanden + test |

De waarnemer is van deze sessie. Uitvoering voortgezet.

## 1. Vraag 1 — is de alarmregel verwijderd of staat er een herstelregel onder?

**Verwijderd. Dat was een overtreding van de append-only-regel, door mij.** Gemeten met
`git log --oneline ... -- data/kanaalpost-publiek.md` en per commit `git show`:

- `fb36828` (bot, tijdens de sabotagetest) — regel toegevoegd, letterlijk:

  `| 2026-07-26 10:21 | WAARNEMER | **De automatische controle ziet de openbare plaat afwijken van de bron.** de pagina is ouder dan de afgesproken drempel en zegt dat zelf niet (leeftijd ongeveer 1 minuten). Dit is een geplande sabotagetest van de waarnemer zelf, geen echte storing. (controlepunten: stempel-te-oud) | GEBLOKKEERD | Richard of Fable |`

- `211faaf` (ik, bij het opruimen) — exact diezelfde regel als `-`-regel verdwenen. Geen herstelregel,
  geen correctie: weg.

### Reparatie

1. De regel staat terug, letterlijk en met haar oorspronkelijke tijdstip, onderaan aangevuld (niet
   tussengevoegd — dat zou opnieuw een herschrijving zijn).
2. Daaronder staat de correctie, die zegt wat er gebeurde en waarom het niet mocht.
3. De regel hangt niet meer aan oplettendheid: `scripts/lib/spiegelwet.mjs` + een CI-job maken een
   verdwenen regel rood.

**Wat de reparatie kost, eerlijk:** de teruggezette regel valt binnen het herhaalvenster van 12 uur
dat dubbele alarmen onderdrukt. Tot ongeveer 22:21 zet de waarnemer geen tweede
`stempel-te-oud`-regel in de spiegel. De rode run blijft wél komen; alleen de dubbele publieke regel
blijft uit.

### De spiegelwet, en waarom versie 1 ervan niets waard was

Mijn eerste opzet vergeleek met het aftakpunt met `main`. Nagemeten: `git merge-base HEAD origin/main`
= `b5d980d`, en ten opzichte daarvan is er niets verdwenen — het toevoegen én weghalen zat binnen deze
tak. **Die controle had mijn eigen overtreding dus niet gevangen.** Nu twee vergelijkingen: met de
vorige stand van de tak (`github.event.before`, die dit geval ziet) en met het aftakpunt (dat een tak
ziet die regels van main weglaat). Op `main` is een ontbrekende vorige stand rood, want dat is een
force-push.

De wet heeft twee lagen: *niets mag verdwijnen* is hard, *nieuwe regels horen erachter* is een melding.
Reden: twee takken die elk aanvullen zijn anders niet te verenigen, en een bewaker die vals piept gaat
uit (bevinding Codex).

## 2. Vraag 2 — gestapeld voorstel en takverwijdering

**Ik doe optie 1: de basis omzetten naar `main` zodra #24 binnen is.** Reden om niet om "samenvoegen
zonder takverwijdering" te vragen: dat legt de afhankelijkheid bij de discipline van iemand anders op
één moment, en juist dát is drie keer misgegaan. Omzetten kan ik zelf uitvoeren en verifiëren.

Nu al omzetten kan niet: de waarnemer toetst de kanaalpost-sectie die pas met #24 op de plaat komt
(`KANAALPOST_VANAF = '2.4.0'`), dus op `main` zou hij direct terecht rood worden.

Vangnet als #24 mét takverwijdering wordt samengevoegd en GitHub #27 daardoor sluit: de tak
`origin/feat/waarnemer` blijft bestaan, de inhoud is dus niet weg, en dan open ik een nieuw voorstel
van `feat/waarnemer` naar `main`. Het tiknummer verandert in dat geval.

## 3. De na-publicatie-controle (besluit Fable: niet (a), niet (b))

`scripts/lib/napublicatie.mjs` (oordeel) · `scripts/napublicatie.mjs` (uitvoering) ·
`.github/workflows/napublicatie.yml` (ronde + poort) · `test/napublicatie.test.mjs` (13 tests).

- Elke 30 seconden navragen, hoogstens 8 minuten. Verse stempel → groen en meteen stoppen.
- Deadline verstreken zonder verse stempel → rood.
- **Nooit "onbekend".** `jobUitkomstKleur` is een allowlist van precies één waarde: alleen `success`
  is groen, dus `skipped`, `cancelled`, leeg en een toekomstige nieuwe GitHub-status zijn rood. De
  poort-job draait met `always()` in plaats van `!cancelled()`, juist zodat een geannuleerde run langs
  de poort komt. `versheidEindstand` kent twee kleuren en geen derde; nul ronden gemeten = rood.
- Falende test eerst, op precies dat punt: de eerste testgroep is `jobUitkomstKleur` over
  `skipped/cancelled/failure/''/null/undefined`, plus deadline en nul-ronden. Nulmeting:
  `npm test` → `pass 276 / fail 1` (het testbestand kon niet laden, want de module bestond nog niet).
  Na de bouw: `pass 299 / fail 0`.
- **Publiek alarm staat uit** (`SPIEGELALARM_AAN = false`), tot tien ronden zonder onterecht rood. Te
  tellen met `gh run list --workflow napublicatie.yml --event workflow_run --limit 20 --json conclusion,createdAt`.
  Het `--event`-filter hoort erbij, en de workflow weigert de test- en sabotageschakelaars bij dat
  event — anders zouden tien versnelde runs kunnen doorgaan voor bewijs.

### Acceptatiebewijs (lokaal, tegen de echte live plaat)

```
$ REFERENTIE=2026-07-26T12:21:15Z node scripts/napublicatie.mjs
ronde 1/16 (0s): VERSE_STEMPEL — stempel 2026-07-26T12:21:34.624Z
✓ de plaat toont een stempel van na de publicatie, dus de uitrol staat live (na 1 ronde(n)).
exit=0

$ SABOTAGE=napublicatie ZELFTEST=1 REFERENTIE=2026-07-26T12:21:15Z node scripts/napublicatie.mjs
ronde 16/16 (8s): STEMPEL_NOG_OUD — stempel 2026-07-26T12:21:34.624Z
publiek alarm staat uit voor deze controle: rood in de bouw, nog geen regel in de spiegel.
::error::... (DEADLINE_ZONDER_VERSE_STEMPEL, 16 ronde(n)).
rode run exitcode=1
```

De stempel van de laatst geslaagde publicatie ligt 19 seconden ná het startmoment van die run — dat is
ook precies waarom de versheidsmarge nul kan zijn (zie hieronder).

## 4. Dubbele review — wat is overgenomen en wat niet

Codex (`model_reasoning_effort=high`) en Gemini, beide op dezelfde diff.

Overgenomen:

| Bevinding | Bron | Verwerking |
|---|---|---|
| `gh run list --json runStartedAt` bestaat niet | Codex | Nagemeten: `Unknown JSON field`. Nu `startedAt`. Zonder deze fix was elke push-run rood zonder te meten. |
| Zelftest verkort het venster, maar de eindstand rekende met 8 minuten | Codex | `deadlineMs` gaat mee; de acceptatietest bewijst nu dezelfde code als productie. |
| Versheidsmarge legitimeert de vorige bouw | Codex + Gemini | 90 s → 15 s → **0**. |
| Klokspeling 5 minuten is niet fail-closed | Codex | 60 s. |
| Testschakelaars kunnen de "tien schone ronden" vervalsen | Codex | Schakelaars gelden nooit bij `workflow_run`; telcommando filtert op dat event. |
| Prefix-eis geeft vals alarm bij samenvoegen | Codex | Wet in twee lagen: verdwijnen = rood, volgorde = melding. |
| Leesfout van de oude spiegel gold als "leeg" | Codex | `git cat-file -e` scheidt "bestond niet" van "onleesbaar"; onleesbaar is rood. |
| Force-push naar main omzeilt de wet | Gemini | Ontbrekende vorige stand op `main` is nu rood. |
| `poort` had `spiegelwet` niet in `needs` | Codex | Toegevoegd; `skipped` mag, al het andere is rood. |

Niet overgenomen, met reden:

- **Gemini meldde een typo `einf` in `scripts/napublicatie.mjs`.** Bestaat niet: regel 59 leest `eind`,
  `node --check` is stil, en het pad zelf is gedraaid — een leeg referentiemoment geeft
  `GEEN_UITSPRAAK` en exit 1 zonder crash.
- **Branchbescherming op `main`** (Codex: `main` is onbeschermd, dus een rode job draait een geland
  commit niet terug). Terecht, maar dat is een repo-instelling en geen code; zie beslispunt 2.

## 5. Wat de push zelf blootlegde: de waarnemer piepte onterecht

De push van deze tak maakte de `waarnemer`-run **rood** (run 30202331603, jobs `melden` en `poort`).
Niet weggeschreven maar uitgezocht, want dit is precies het geval waar het besluit voor waarschuwt: een
bewaker die onterecht rood gaat, gaat uit. Drie afzonderlijke fouten, alle drie van mij, alle drie
gemeten en niet beredeneerd. De nieuwe `napublicatie`-controle stond in dezelfde push op **groen**.

**Aanleiding.** Een ander spoor zette rond 14:35 een rij op `main` met een onderwerp van 1432 tekens en
een actiehouder van 439 tekens. De publicatiepoort kapte netjes af, en toen liep de vergelijking uiteen.
Reproduceerbaar tegen de echte plaat:

```
bron bovenaan:  TRECHTER 2026-07-26 14:35
plaat bovenaan: TRECHTER 2026-07-26 14:35
AFWIJKING PAGINA_TOONT_OUDE_DATA
```

Dezelfde tab, dezelfde datum, en toch een afwijking.

**Fout 1 — de statuskolom draagt twee dingen.** `render.mjs` zet de actiehouder bewust in de statuscel,
achter een `<br>` in een grijze span. De waarnemer sloeg die cel plat en las:

```
pagina status: "AFGEROND Richard: één keuze. Ga ik door met de inhoudelijke verwerking van C en D — drie..."
bron   status: "AFGEROND"
```

Dat is nooit gelijk. Gevolg: **elke rij met een actiehouder gaf een onterecht rood.** De extractie
knipt die cel nu af op de eerste `<br>`.

**Fout 2 — de normalisatie sloopt het afkap-teken.** `ontdaan()` doet NFKC, en NFKC maakt van `…`
(U+2026) de drie tekens `...`. De bron krijgt haar `…` er ná de normalisatie op (`cap()` in
`kanaalpost.mjs`), de paginakant gaat er nog een keer door. Op codepoint-niveau gemeten:

```
pagina staart: "l uit..."   6c 20 75 69 74 2e 2e 2e
bron   staart: "bel uit…"   62 65 6c 20 75 69 74 2026
```

Gevolg: **elke rij langer dan 600 tekens gaf een onterecht rood**, op precies het laatste teken. De
vergelijking egaliseert nu dat ene teken: `…` tegen `...`, aan beide kanten, en verder niets. Mijn
eerste reparatie liet béide kanten nog een keer door `ontdaan()` gaan; beide reviewers wezen daar
onafhankelijk hetzelfde gat in aan (zie §5b), dus die is teruggedraaid naar de smalle vorm.

**Fout 3 — de alarmpoort kon niet slagen.** De `melden`-job zette het RUWE onderwerp (met `**vet**`)
naast de GEPUBLICEERDE tekst, waar de poort die sterretjes juist weghaalt. Reproductie:

```
bovenaan.onderwerp: "De automatische controle ziet de openbare plaat afwijken van de bron. de bovenst"
cel2              : "**De automatische controle ziet de openbare plaat afwijken van de bron.** de bov"
onderwerp gelijk: false
```

Deze controle kon dus **nooit** slagen: de bewaker kon zijn eigen alarmregel niet in de spiegel
schrijven. Dat is de ernstigste van de drie — precies de stille uitval die de spiegel moet uitsluiten.

Mijn eerste reparatie liet onderwerp en actiehouder dan maar buiten de vergelijking. Dat werkte, en het
maakte een nieuw gat dat Codex en Gemini beide aanwezen: een verminkt onderwerp (`controle mislukt` in
plaats van de hele alarmtekst) of een verminkte actiehouder (`niemand` in plaats van `Richard of Fable`)
kwam er ongezien door. De poort in deze ronde vergelijkt **alle vijf velden**, en berekent de verwachte
publieke vorm door dezelfde regel in zijn eentje door dezelfde publicatiepoort te halen — geen eigen
markdown-lezer, geen eigen sterretjes-stripper, dus geen tweede plek die kan gaan afwijken. Zes eisen:
poort open, ruwe regel staat onderaan, regel is publiceerbaar, het is een `WAARNEMER`/`GEBLOKKEERD`-rij,
alle vijf velden kloppen, en de bovenste publieke rij is echt veranderd.

Gedraaid tegen de exacte alarmregel die de vorige poort afwees, plus vijf saboteerde varianten:

```
1. eerlijke ronde                → alarmregel staat bovenaan de publieke stand.   exit=0
2. verminkt onderwerp            → rood (regel_staat_onderaan, rij_klopt_veld_voor_veld)   exit=1
3. actiehouder "niemand"         → rood (regel_staat_onderaan, rij_klopt_veld_voor_veld)   exit=1
4. regel niet geschreven         → rood (…, bovenste_rij_is_nieuw)                exit=1
5. gewone AFGEROND-rij i.p.v. alarm → rood (rij_is_waarnemer_alarm)               exit=1
6. misvormde regel (kolom te weinig) → rood (regel_is_publiceerbaar, …)           exit=1
```

**Waarom de bestaande tests dit niet vonden.** Ze voedden de waarnemer met een zelfgeschreven stukje
HTML. Daarmee bewees de test dat de waarnemer zijn eigen nepagina kan lezen. `test/waarnemer-rondgang.test.mjs`
gaat nu langs de echte keten — bron → publicatiepoort → `renderHtml` → uit de pagina teruglezen →
vergelijken. Nulmeting van die tests tegen de ongerepareerde waarnemer: **2 van 5 rood**, met precies
de productiesymptomen (`actual: 'WACHT OP AKKOORD Richard: één keuze, ga ik door'` en
`actual: [ 'PAGINA_TOONT_OUDE_DATA' ]`). Beide oorzaken zijn apart bewezen: er is een aparte test met
een afgekapte rij zónder actiehouder, die alleen op het ellips-teken kan vallen.

Na de reparatie, tegen de echte live plaat:

```
$ BASE_URL=… SPIEGEL_URL=… node scripts/waarnemer.mjs
bron bovenaan: TRECHTER 2026-07-26 14:35
plaat bovenaan: TRECHTER 2026-07-26 14:35
✓ geen afwijking: de plaat komt overeen met de bron.
```

## 5b. Dubbele review van de fixronde — de reparatie is zelf nagekeken

De drie fixes hierboven zijn opnieuw langs Codex en Gemini gegaan, met vijf gerichte vragen (A: wordt de
bewaker te mild? B: is de nieuwe vergelijking symmetrisch/idempotent en ontstaat er vals groen? C: is de
nieuwe alarmpoort fail-closed? D: risico's van `/tmp`? E: echte bugs). Beide vonden hetzelfde hoofdpunt,
onafhankelijk van elkaar.

| Bevinding | Bron | Verwerking |
|---|---|---|
| De alarmpoort is niet meer fail-closed op inhoud: verminkt onderwerp of verminkte actiehouder glipt erdoor | **Codex C + Gemini C** | Overgenomen. Alle vijf velden vergeleken tegen de verwachte publieke vorm, berekend door dezelfde poort. Zes saboteerde varianten gedraaid, alle rood. |
| `ontdaan()` aan beide kanten opent een nieuwe klasse vals groen: NFKC is niet injectief (`10²`≡`102`, `ﬀ`≡`ff`, `Ⅰ`≡`I`) | **Codex B + Gemini B** | Overgenomen. Alleen het afkap-teken wordt geëgaliseerd. Extra test: een plaat met `..` in plaats van `…` blijft rood, dus de tolerantie loopt niet uit. |
| `/<br\s*\/?>/i` splitst niet op `<br class="…">` → vals rood zodra de opmaak verandert | **Codex E + Gemini E2** | Overgenomen: `/<br\b[^>]*>/i`. Nulmeting: met de strakke vorm faalt de nieuwe test, met de losse slaagt hij. |
| `/tmp/spiegel-voor.md` is een voorspelbaar pad: symlink-risico, en op een self-hosted runner deelbaar tussen jobs | **Codex D + Gemini D** | Overgenomen: `${{ runner.temp }}`, per job en opgeruimd na de job. Ook in de `spiegelwet`-job. |
| Splitsen op `/(?<!\\)\|/` heeft een verkeerde escape-pariteit; `cellen` wordt niet op vijf velden gecheckt | Codex E | Overgenomen door het weg te halen: de poort splitst niet meer zelf op pipes maar laat de publicatiepoort de regel lezen. Een misvormde regel is daardoor rood (variant 6). |
| `ontdaan()` is niet universeel idempotent (NFKC vóór onzichtbaar-strippen) | Codex E/B | Erkend, niet gerepareerd in deze ronde: het staat buiten de diff en het effect valt naar **rood**, niet naar groen. Als los punt genoteerd. |

Niet overgenomen, met reden:

- **Gemini E1: `gelijk()` crasht op `undefined`.** Weerlegd door meting: `ontdaan()` begint met
  `String(waarde ?? '')`, en de nieuwe `ellips()` doet hetzelfde. Er is geen pad naar een `TypeError`.
- **Codex A: alles ná de eerste `<br>` wordt blind genegeerd, dus een tweede zichtbare status glipt door.**
  Deels waar en bewust: de status wordt vergeleken met de bron, dus een verkeerde stand vóór de `<br>` is
  rood en een lege status is rood. Een pagina die ná de actiehouder nóg een status bijzet is een fout in
  `render.mjs` en geen afwijking tussen plaat en bron; die hoort niet in deze bewaker thuis.
- **Codex C, restgat: als `RIJ_B64` zélf al fout is, noemt de poort die regel canoniek.** Klopt en is
  onvermijdelijk in deze vorm — de regel komt uit `alarmRij()` in de `toetsen`-job en gaat ongewijzigd
  (base64) door. De eis `rij_is_waarnemer_alarm` dekt nu wel af dat er geen ándere soort rij als alarm
  langs komt.

Geen onenigheid tussen Codex en Gemini in deze ronde, dus geen escalatie naar Fable.

## 6. De vier punten — besluit van Fable en wat ermee gedaan is

Fable heeft op 26-07-2026 op alle vier beslist. Hieronder per punt het besluit en de uitvoering.

**1. De 8 minuten blijven.** Grond van Fable: het publieke alarm staat toch uit tot tien schone ronden,
dus onterecht rood kost nu niets; kom na die proefperiode terug met meetdata als 8 te krap blijkt.
Uitvoering: niets gewijzigd, `DEADLINE_MS` staat op 8 minuten. Wat ik ga meten in de proefperiode: per
ronde het aantal navragen tot een verse stempel, zodat "8 is te krap" straks met getallen komt en niet
met een aanname.

**2. Geen bot-uitzondering op de spiegelwet.** Besluit: de poort wordt niet omzeild, ook niet door onze
eigen waarnemer. Uitvoering: de wet draait nu IN de `melden`-job, vóór de push en opnieuw na elke
herplaatsing — `alleenAangevuld(HEAD~1, HEAD)` plus de vormcontrole. Dat repareert het gat dat er zat
doordat een push met `GITHUB_TOKEN` geen workflow start, zonder tweede identiteit en zonder uitzondering.
Gedraaid in een schone testrepo met de letterlijke code uit `waarnemer.yml`:

```
1. nette aanvulling            → spiegelwet op de eigen commit: niets verdwenen, vorm canoniek.  exit=0
2. bot haalt zelf een regel weg → ::error::de waarnemer zou zelf 1 regel(s) laten verdwijnen.     exit=1
3. bot schrijft 10² in de spiegel → ::error::niet-canonieke regel(s): regel 5 (U+00B2).           exit=1
```

**3. NFKC: normaliseren mag op de leeskant, de spiegel eist op de schrijfkant één canonieke vorm.**
Uitvoering: `canoniek()` en `nietCanoniekeRegels()` in `scripts/lib/spiegelwet.mjs`, gehandhaafd in de
`spiegelwet`-job én in de `melden`-job. Een tabelregel moet gelijk zijn aan zijn eigen NFKC-vorm en mag
geen onzichtbare tekens bevatten. Daarmee kan de tolerantie op de leeskant geen twee schrijfwijzen meer
tegenkomen die zij gelijk noemt: die vormen komen er niet meer in.

- **Nulmeting:** alle 44 tabelregels in `data/kanaalpost-publiek.md` voldeden al. De eis legt niets recht
  met terugwerkende kracht; hij houdt vast wat er nu staat. Vastgezet in een test die op het echte
  bestand draait.
- **De waarnemer krijgt geen uitzondering:** `alarmRij` kapte af met `…`, en dat teken is zelf niet
  canoniek. Nu `...`. `alarmRijPubliceerbaar` weigert bovendien een niet-canonieke regel, zodat een
  alarm dat in CI zou blijven steken niet eens geschreven wordt.

**4. Takbescherming op `main`: hier niet beslissen.** Genoteerd als punt voor de GitHub-plan-beslissessie.
Ik laat het staan zoals het is en meld alleen wat het betekent: elke poort in dit voorstel is een
controle achteraf zolang `main` onbeschermd is.

## 6b. Dubbele review van de besluitenronde — en het gat dat daar nog in zat

De uitvoering van punt 2 en 3 hierboven is opnieuw langs Codex en Gemini gegaan, vóór de commit. Codex'
oordeel was **niet aannemen**, met één hoge bevinding die klopt, en die ik zelf niet had gezien.

**A (Codex, hoog) — na een herplaatsing bewaakte de wet de verkéérde basis.** De controle mat
`HEAD~1 → HEAD`. Botst de push, dan zet `git pull --rebase` de alarmcommit boven op de nieuwe stand van
de tak, en is `HEAD~1` díe nieuwe stand. Was daar intussen een regel uit verdwenen, dan is de botcommit
er keurig een aanvulling op — en publiceert de waarnemer de verminkte stand, waarna er géén
spiegelwet-run meer volgt, want een push met `GITHUB_TOKEN` start geen workflow. Gemeten met de oude
code op precies dat scenario:

```
OUDE controle: niets verdwenen, vorm canoniek.        exit=0
X staat nog in de spiegel: 0                          ← de regel was wél weg
```

Gerepareerd: de wet meet nu tegen **twee** standen — de stand waarvan de job vertrok (`SPIEGEL_VOOR`,
die al bestond maar na de eerste controle ongebruikt bleef) én de voorganger van de commit — en
controleert apart dat de alarmregel de herplaatsing heeft overleefd, want een rebase kan de eigen commit
laten vallen. Vijf scenario's, gedraaid met de letterlijke node-code uit `waarnemer.yml` in schone
scratch-repo's:

```
1. nette aanvulling                → niets verdwenen, alarm aanwezig, vorm canoniek        exit=0
2. rebase op een stand die X kwijt is → t.o.v. de stand waarvan deze job vertrok zouden 1
                                      regel(s) verdwijnen — de waarnemer publiceert dat niet exit=1
3. eigen alarmcommit weggevallen   → de alarmregel staat na het herplaatsen niet meer in de
                                      spiegel — geweigerd                                    exit=1
4. nieuwe regel met 10² erin       → niet-canonieke NIEUWE regel(s): regel 5 (U+00B2)         exit=1
5. OUDE vuile regel, nieuwe schoon → ::warning:: 1 bestaande regel(s) … blokkeren niet        exit=0
```

**B (beiden) — de onzichtbare-tekenlijst was te kort, en er waren er twee.** `kanaalpost.mjs` had al een
veel bredere verzameling (bidi-overrides, variation selectors, C1-stuurtekens); mijn spiegelwet had zijn
eigen korte lijstje. Twee definities van "onzichtbaar" betekent dat de schrijfkant doorlaat wat de
leeskant weghaalt. Nu één bron: `bevatOnzichtbaar()` uit `kanaalpost.mjs`, door beide kanten gebruikt.
Nulmeting met de bredere verzameling: 0 van de 44 regels wordt er alsnog door afgekeurd.

**C (Codex) — `trim()` was een omweg.** JavaScript's `trim()` haalt óók een BOM en een harde spatie weg,
dus een regel die met een BOM begint werd getrimd canoniek genoemd terwijl de parser hem daarna gewoon
publiceert. De controle beoordeelt nu de **ruwe** regel; alleen de selectie kijkt door witruimte en
onzichtbare tekens heen. Drie tests leggen dat vast (BOM ervoor, harde spatie erachter, zero-width
ervoor). Codex' andere C-punt — selecteer via de tabel-state-machine in plaats van op de pipe — heb ik
**niet** overgenomen: de huidige selectie is rúimer dan de parser (44 regels tegen 35 echte rijen), en
ruimer is aan de veilige kant. Gemini's spiegelbeeld-punt (een rij zónder beginpipe zou ontsnappen) is
weerlegd door meting: `cellenVan` in `kanaalpost.mjs:142` eist een begin- én een sluitpipe, dus zo'n
regel wordt nooit een publieke rij.

**D (beiden, onafhankelijk) — hard op het hele bestand kan de deur permanent op slot zetten.** Glipt er
ooit één vuile regel doorheen, dan mag append-only hem niet herstellen én houdt hij elke volgende commit
rood, ook van iemand die de spiegel niet aanraakt. Overgenomen in deze vorm: **hard op wat er nieuw bij
komt** (`nieuweNietCanoniekeRegels`, dat is precies de schrijfkant waar het besluit over gaat),
**waarschuwing op wat er al stond**. Scenario 5 hierboven is daar het bewijs van.

**E (Codex) — vier punten in plaats van drie.** De afkapping zette `...` en de zin zette er daarna nog
een punt achter: `....`. De test keek met `includes('...')` en zag dat niet. Gerepareerd (de punt hoort
binnen de keuze) en de test kijkt nu ook op `....`. Verder overgenomen: `maxBuffer` op `git show` (de
standaard van ~1 MiB wordt in een append-only bestand ooit een harde stop), geen zinloze herplaatsing
na de laatste mislukte push, en `fetch-depth: 0` op de checkout van de `melden`-job (Gemini: een rebase
in een ondiepe kloon kan het gemeenschappelijke punt missen).

**Niet gerepareerd, wel gemeld:** de `melden`-job draait `node` zonder `setup-node`, dus de versie is
daar niet gepind. Dat is bestaand gedrag van vóór deze ronde en raakt de wet niet; het hoort in een
eigen wijziging thuis.

## 6c. De rebase op main — en de tweede helft van de wet

Fable's ordening zei: #24 eerst, daarna #27 omhangen naar main. #24 blijkt al samengevoegd te zijn
(squash `1852c9c`, 12:20:40Z) en GitHub heeft de basis van #27 daarbij zelf al naar `main` gezet. Het
omhangen was dus alleen nog het herplaatsen zelf. Dat is twee keer gedaan, en de eerste poging was fout.

**Wat er in poging 1 misging, en hoe het gemeten is.** Bij het herplaatsen botste het spiegelbestand. Ik
loste dat op door de oorspronkelijke historie getrouw na te maken — inclusief de bekende foute tussenstap
die een gepubliceerde regel weghaalde. De eindtoestand was daardoor schoon, en precies dáárom zag ik het
niet: wie alleen de eindtoestand meet, ziet een verwijdering-en-terugzetting tegen elkaar wegvallen.
Codex mat per commit en vond het wél:

```
poging 1, per commit:   d7322bc  verdwenen 1     ← de foute tussenstap, letterlijk gereproduceerd
```

Sindsdien meet ik elke commit apart (`keur-tak.mjs`). Poging 2 is opnieuw vanaf de veiligtak gedaan, met
de botsing als vereniging opgelost — élke regel van beide kanten blijft staan. Uitkomst over alle tien
commits van de tak:

```
2ae1d45 … 18f8376   verdwenen 0  duplicaten 0   (10 commits)
eindtoestand t.o.v. origin/main — verdwenen 0, ok true, opOrde true
```

**En daar zat de tweede helft van de wet in.** Poging 2 leverde eerst een exact duplicaat op (de
10:21-regel kwam er een tweede keer bij). Verdwenen: 0 — de wet zei dus groen. Toch is een regel die er
stilletjes tweemaal staat net zo goed een andere werkelijkheid dan er gebeurd is. Daarom
`nieuweDuplicaten()`, hard in beide poorten, met vier tests. De echte spiegel heeft er nul.

**Wat een herschreven tak betekent voor de wet — en waarom dit geen uitzondering is.** De `before`-toets
is de scherpste van de twee, want de overtreding waar deze wet uit ontstond (toevoegen in push 1,
weghalen in push 2) is tegen het aftakpunt onzichtbaar. Maar na een rebase ligt `before` niet meer in de
historie van de tak. Gemeten aan deze tak:

```
huidige stand t.o.v. de oude taktip c47fecf : verdwenen 1   ← de herwoorde 14:15-correctieregel
huidige stand t.o.v. origin/main 905a300    : verdwenen 0
```

Die ene regel is de correctieregel die tijdens de rebase herwoord is, omdat haar oude tekst
("de regel staat nu terug") in de nieuwe historie niet meer waar was. Fail-closed op `before` zou deze
eigen reparatie dus rood maken. De oplossing is geen uitzondering maar een onderscheid dat ik hardop
maak: **main herschrijven is rood, altijd**; een **tak** herschrijven mag haar eigen voorsteltekst
herwoorden, en daar staat tegenover dat de tak dan **hard tegen main zelf** wordt gehouden — strenger
dan het aftakpunt, want main groeit door. Wat main publiceerde blijft dus onaantastbaar; wat alleen als
voorstel op een tak stond, is een voorstel. Vijf scenario's, gedraaid met het letterlijke `run`-blok uit
`waarnemer.yml`:

```
A voorouder (gewone push)        → vorige stand + aftakpunt: geen regel verdwenen, geen dubbel  exit=0
B herschreven tak (force-push)   → ::warning:: herschreven; 1 regel herwoord; main hard: schoon exit=0
C onleesbare before-SHA          → ::error:: niet op te halen … dus rood                        exit=1
D lege before op main            → ::error:: force-push of herschreven historie … dus rood      exit=1
E lege before bij schedule       → geen vorige stand in de gebeurtenis — alleen aftakpunt       exit=0
```

C is het gat dat Codex aanwees: dat liep vroeger stil door met alleen de aftakpunt-toets.

**De bot plakte zijn eigen alarm aan de vorige regel.** Eindigt het bestand niet op een regeleinde, dan
komt de alarmregel achter de laatste rij te staan. Nulmeting met de oude code, en met de reparatie:

```
zonder reparatie: rijen 1   | 2026-07-26 14:00 | … | geen || 2026-07-26 15:00 | WAARNEMER | …
met reparatie:    rijen 2   (beide rijen heel, bestand eindigt op een regeleinde)
```

Gevolg zonder de fix: de gepubliceerde regel is herschreven én het alarm is er als rij niet — waarna de
eigen poort de push weigert en het alarm dus nooit op de plaat komt. Stille uitval van de bewaker zelf.

**En toen bewoog main opnieuw.** Tijdens deze ronde kwam er op `main` een commit bij die zélf een regel
aan de spiegel toevoegde (`00e7a54`). Daarmee werd #27 vuil — precies de controle die je vroeg te doen
vóór aanmelding. Dus opnieuw herbaseerd, met de botsing weer als vereniging opgelost, en veiligtak
`reserve/waarnemer-voor-rebase2` (18f8376) ervoor. Uitkomst op de nieuwe basis: 10 commits,
`verdwenen 0 / duplicaten 0`, eindtoestand t.o.v. `origin/main` schoon, `npm test` 328/328.

Dit is vandaag de derde keer dat één bestand door meer dan één tak wordt beschreven, en dat is geen
toeval meer: `data/kanaalpost-publiek.md` is een gedeelde schrijfplek zonder afspraak over wie er wanneer
aan zit. Voorstel voor CONTROL, niet zelf doorgevoerd omdat het ieders samenvoegingen raakt: geef dit ene
bestand in `.gitattributes` de `merge=union`-driver. Een append-only bestand heeft precies die semantiek
— houd beide kanten — en het duplicaat dat een vereniging kan opleveren wordt sinds deze commit hard
afgevangen. Zonder zo'n afspraak blijft elke tak die dit bestand aanraakt het werk van de vorige ongeldig
maken.

**Beslispunt voor Fable — NFKC of NFC.** Punt 3 van je besluit noemt NFKC met zoveel woorden, en zo staat
het er nu in. Beide reviewers stellen onafhankelijk iets anders voor, en zij hebben inhoudelijk gelijk:
NFKC is een *huisstijl*regel, geen bescherming. Hij weigert `…`, `½`, `²` en `ﬁ`, maar laat Cyrillische
letters die er als Latijnse uitzien gewoon door — juist het geval waar je bang voor zou moeten zijn. Hun
voorstel: NFC (identiteit behouden) + een verbod op stuur- en opmaaktekens + vaste waardelijsten voor de
dichte velden + UTS#39 op namen. Praktisch gevolg van NFKC zoals het er nu staat: macOS maakt van `...`
automatisch `…`, en dat wordt bij een nieuwe rij nu hard geweigerd. Ik heb het **niet** gewijzigd, want
een besluit van jou wijzigen is geen reparatie. Zeg je "NFC", dan is het een kleine wijziging in
`canoniek()` plus de tests.

### Dubbele review van deze ronde

**Gemini: geen enkele echte bevinding.** Punt voor punt nagelopen: de poorten sluiten fail-closed (een
vervalste of onbereikbare `before` eindigt in het rode pad), het onderscheid herschreven-tak/main is
"geen gat maar een correct opgezette veiligheidsklep" omdat de harde main-toets er meteen achteraan komt,
en de rekenkunde van `nieuweDuplicaten` klopt inclusief de bestaande-duplicaten- en
regelnummer-rapportage. Eén punt van laag gewicht, door Gemini zelf als speculatie gemarkeerd: op een
**ondiepe** kloon zou `git merge-base --is-ancestor` een gewone push als "herschreven tak" kunnen
aanmerken. Weerlegd door meting — beide jobs checken uit met `fetch-depth: 0`:

```
spiegelwet → checkout with: {'fetch-depth': 0}
melden     → checkout with: {'ref': '…', 'fetch-depth': 0}
```

**Codex: *niet aannemen*, en met reden.** Twee hoge bevindingen, allebei dezelfde blinde vlek, en
allebei terecht. Zijn formulering: *"het gat zit in de zogenaamd harde main-toets: die bewijst behoud
van letterlijke regels, niet behoud van door de publieke parser herkende rijen."* De wet telde tot nu
toe brontekstregels; wat er op de plaat komt is iets anders.

Twee tegenvoorbeelden, allebei nagebouwd als test en allebei gemeten vóór de reparatie:

| # | aanval | oude poorten | wat er publiek gebeurt |
|---|---|---|---|
| 1 | één **lege regel** middenin de tabel | `alleenAangevuld.ok = true`, `nieuweDuplicaten = []` | de lege regel sluit de tabel; alles eronder wordt niet meer gepubliceerd |
| 2 | de nieuwste rij **gekopieerd met andere celopvulling** | `nieuweDuplicaten = []` (het is een andere brontekstregel) | na normalisatie exact dezelfde publieke rij, dus twee keer op de plaat |

### §6d. Wat er tegen die twee gebouwd is

Een **derde laag** in dezelfde wet: `publiekeAfwijkingen(oud, nieuw)` telt niet de brontekstregels maar
de rijen die de publieke kant er daadwerkelijk uit haalt — de vijf velden ná vorm- en publicatiepoort en
ná afkappen. Bewust **zonder** de limiet van vijftien zichtbare rijen: met die limiet zou elke rij die
door normale aangroei uit beeld schuift als "verdwenen" gelden en stond de poort permanent rood.
Daarvoor is `publiekeRijenUitTekst` uit `kanaalpost.mjs` losgetrokken; `toPublicKanaalpost` gebruikt nu
diezelfde functie, zodat er één definitie van "de publieke rij" is en niet twee.

De laag hangt hard in **beide** poorten — de `spiegelwet`-job én de schrijfactie van de bot zelf, want
de spiegelwet geldt ook voor de waarnemer (jouw punt 2). Een **nieuw** dubbel exemplaar van een publieke
rij is er hard, ook op een herschreven tak: er bestaat geen goede reden waarom dezelfde melding er nog
een keer bij komt. Dubbels die er al stonden blijven toegestaan — de toets vergelijkt per rij het aantal
in de nieuwe stand met het aantal in de oude, dus hij verbiedt alleen de toename.

Meting op het echte bestand, met de letterlijke code uit `waarnemer.yml`, aanval 1 ingevoegd:

```
::error::de plaat verliest rijen t.o.v. de vorige stand van deze tak: 45 rij(en) die de publieke kant
eerder toonde komen er niet meer uit, terwijl de brontekst compleet is.
→ exit=1
```

Die laatste halve zin is het hele punt: *de brontekst is compleet* en de plaat is toch leeg.

De twee lichte punten van Codex zijn ook verwerkt. `git merge-base --is-ancestor` kent drie uitkomsten
(0 = voorouder, 1 = niet, hoger = git kon de vraag niet beantwoorden); die laatste twee lagen op één
hoop, waardoor een **meetfout** stilzwijgend de zachte tak-route inging. Nu apart en rood — gemeten met
een `git`-stub die 128 teruggeeft:

```
::error::git kon niet vaststellen of 97fd038 in de historie van deze stand ligt (exitcode 128) —
een toets die niets zegt is rood.  → exit=1
```

En drie teksten die meer beweerden dan er gemeten was, zijn rechtgezet: "N regel(s) herschreven" is nu
"niet teruggevonden" (dat er een vervanger voor in de plaats kwam, is niet gemeten); het regelnummer van
het laatste exemplaar is een aanwijzing, geen bewijs van wélk exemplaar erbij kwam; en de toelichting bij
het regeleinde beweerde dat géén van beide poorten een vastgeplakte rij ziet — Codex heeft nagemeten dat
`alleenAangevuld` dat wél ziet (`ok=false, verdwenen=1`). Het gevolg is dus geen stille publicatie maar
een alarm dat niet geschreven kán worden, en dat is even stil; de reparatie blijft daarmee nodig, de
**onderbouwing** was fout. Er staat nu een test die dat vastlegt.

**Codex' derde hoge bevinding is geen code-fout maar een systeemgrens, en gaat naar jouw punt 4.** Een
push kan `[skip ci]` in het bericht zetten, en de workflow-code die de poort uitvoert komt van de tak
die zichzelf laat beoordelen. Zolang dat zo is zijn deze poorten **bewaking, geen grens**: ze meten
netjes en ze zijn te omzeilen door wie pushrecht heeft. Dat repareert alleen takbescherming op main met
verplichte controles — precies het punt dat jij naar de GitHub-plan-beslissessie hebt gestuurd. Ik meld
het hier als *bekend en aanvaard*, niet als opgelost.

### §6e. Vijfde ronde — en het derde gat, in de laag die net gebouwd was

De nieuwe laag is meteen opnieuw langs beide reviewers gegaan. **Gemini: één punt, en het was geen
regressie.** Twee volstrekt identieke meldingen achter elkaar worden hard geblokkeerd; nagemeten dat dat
gedrag van de bestaande bronlaag `nieuweDuplicaten` komt en al vóór deze ronde bestond
(`[{"regel":4,…}]` op de oude code), en dat een herhaling op een andere minuut gewoon doorgaat
(`dubbel []`, `verdwenen 0`). Geen wijziging aangebracht.

**Codex vond een derde hoog punt, en het zat in de laag van §6d zelf.** Zijn formulering:
*"`publiekeAfwijkingen` reduceert alles tot een `Map` met aantallen. Daarmee verdwijnt de bronvolgorde… Concreet met
16 rijen: herschik `1…16` naar `16,2…15,1`. Geen bronregel verdwijnt, er ontstaat geen duplicaat en
`publiekeAfwijkingen` geeft `ok: true`. De zichtbare plaat verandert echter van `16…2` naar `1,15…2`."*
Nagebouwd en bevestigd vóór de reparatie: `{"ok":true,"verdwenen":0,"dubbel":0}` terwijl de plaat
kantelt. Tellen is niet hetzelfde als ordenen.

Daar staat nu een **volgorde-eis** bij: de oude publieke rijen moeten in de nieuwe stand nog in dezelfde
onderlinge volgorde voorkomen. Bewust als *deelrij* en niet als *begin* — een prefix-eis zou twee takken
die elk onderaan iets toevoegen tegen elkaar in laten lopen bij de merge, en dat is legitiem verkeer. Er
staat een test die precies dat bewijst: een merge die rijen tussenvoegt blijft groen, een herschikking
niet. Gemeten met de letterlijke poortcode op het echte bestand, eerste en laatste van 47 rijen verwisseld:

```
::error::de vorige stand van deze tak: er is publiek niets verdwenen, maar de onderlinge VOLGORDE van
de bestaande rijen is veranderd (vanaf de 2e). De plaat toont de laatste vijftien omgedraaid, dus dit
verandert wat er in beeld staat.
::error::het aftakpunt met main: … (idem)
→ exit=1
```

Drie andere punten van Codex zijn nagelopen en **als grens gedocumenteerd, niet gerepareerd**:

- Een wijziging aan de **parser zelf** kan rijen laten verdwijnen zonder dat deze wet iets ziet, want
  beide kanten van de vergelijking worden met de nieuwe parser gelezen. Dat is dezelfde klasse als de
  systeemgrens hierboven: poortcode die van de beoordeelde tak komt. Hoort bij jouw punt 4.
- Het dubbel-tellen kijkt over het **hele** verslag, niet alleen over de vijftien zichtbare rijen. Dat is
  beleid, geen omissie: publieke identiteit hoort uniek te zijn over het hele bestand. Het risico op vals
  alarm is te verwaarlozen — twee rijen zijn pas identiek bij gelijke datum-tijd tot op de minuut, tab,
  onderwerp, status én actie.
- `ingehouden` (wat de publicatiepoort tegenhoudt) wordt niet vergeleken. Dat is niet gerepareerd maar
  wel niet langer weggemoffeld: de meldingen spreken nu over de **publieke lezing**, niet over "de
  publieke stand".

### §6f. Zesde ronde — twee reviewers, dezelfde drie punten

Deze keer wezen Codex en Gemini **onafhankelijk naar dezelfde drie dingen**, wat het makkelijk maakt: er
viel niets te wegen. Gemini's oordeel was *aannemen met verfijningen*, dat van Codex *niet aannemen*; op
de inhoud verschillen ze niet.

1. **De volgordetoets kon zichzelf stilzetten (het zwaarste punt).** Raakt de parser stuk zónder te
   crashen, dan leest hij *beide* kanten leeg en komt de toets uit op "niets verdwenen, niets dubbel,
   volgorde in orde" — groen, terwijl er niets gemeten is. Nulmeting met een opzettelijk gesloopte
   parser op de echte spiegel: `{"ok":true,"verdwenen":0,"dubbel":[],"volgordeOk":true,"aantal":0}`. Er
   staat nu een vangnet: bevat de tekst meer tabelregels dan kop en scheiding, terwijl de publieke
   lezing niets oplevert én niets tegenhoudt, dan heeft de toets niets gemeten en is dat rood. Dezelfde
   meting na de reparatie, met de letterlijke poortcode:

   ```
   ::error::t.o.v. de vorige stand van deze tak levert de publieke lezing geen enkele rij op terwijl de
   spiegel wel rijen bevat — een toets die niets meet is rood.  → exit=1
   ```

   Dit moest via een gesloopte parser gemeten worden en niet via het bestand: elke bewerking van de
   spiegel die de lezing breekt, laat óók een bronregel verdwijnen en wordt dan al door de eerste laag
   gepakt (gemeten: het slopen van de kolomkop geeft `append-only overtreden … 1 regel(s) verdwenen`).
2. **Het gemelde rijnummer beweerde iets anders dan het was.** `eerste` is de hoeveelste rij van de
   *vorige* stand niet meer op zijn plaats terugkomt — niet de eerste regel in het nieuwe bestand waar
   het misgaat. Codex' voorbeeld: `1,2,3 → 1,3,2` meldt `eerste: 3`, terwijl de eerste zichtbare
   afwijking rij 2 is. Het getal is niet veranderd, de zin eromheen wel: de melding zegt nu "de 3e rij
   van de vorige stand komt niet meer op zijn plaats in de reeks terug". Met een test die dat vastlegt.
3. **Bij een verdwenen rij werd er ten onrechte óók herordening gemeld.** Verdwijnt er een rij, dan kan
   de deelrij-toets per definitie niet meer slagen; de schrijfpoort van de bot plakte er dan een tweede
   bewering achteraan die niet apart gemeten was. Die zin verschijnt nu alleen nog als er niets
   verdwenen is. In de `spiegelwet`-job stond die volgorde al goed.

Codex noemde daarnaast één passerend geval dat **bewust** passeert: rijen die er tússen komen verschuiven
de zichtbare plaat wel degelijk (`1,2,3` + `9,8` toont `8,3,2,9,1`), en dat blijft groen. Dat is precies
de merge-bestendigheid waarvoor de deelrij-eis gekozen is; een strengere eis zou elke samenvoeging van
twee takken rood maken. Genoteerd als grens, niet als gat. De vier randen die hij als ongetest aanwees,
zijn nu getest.

### §6g. De basis omgehangen naar main (opdracht Fable)

#24 is gemerged (`1852c9c`, 12:20:39Z) en main is daarna doorgelopen naar `3a72950`. Volgens de bindende
ordening is de basis van #27 direct omgehangen. Daarbij botste de spiegel écht — main en deze tak hadden
allebei onderaan een rij geschreven. **Beide rijen zijn blijven staan**, die van main eerst, de eigen rij
van 10:21 erachter; de tabel is append-volgorde en geen sortering (er staat al langer een rij van 08:25
vóór een van 08:02), dus dat is de eerlijke oplossing en geen herschikking. Daarna hermeten:

```
basis: 3a72950 (= main)      merge-tree tegen main: schoon, geen conflict
alle twaalf commits: verdwenen 0, duplicaten 0, publiek -0/dubbel 0
eindtoestand t.o.v. origin/main — verdwenen 0, ok true, opOrde true
publieke rijen t.o.v. origin/main — verdwenen 0, dubbel 0, in beeld 48, ok true
```

### §6h. De push zelf legde het bloot: de zwaarste vondst van de dag

De push van bovenstaande reparatie liep **rood in CI** (run 30208787315) — en de manier waarop is
ernstiger dan de aanleiding. De job produceerde **exitcode 1 en nul regels uitvoer**. Geen melding, geen
oordeel, geen aanwijzing.

Oorzaak, lokaal gereproduceerd: GitHub start een `run`-stap als **`bash -e`**. Daarmee doodt elk *kaal*
commando met een exitcode ≠ 0 de stap ter plekke. En `git merge-base --is-ancestor` gebruikt exitcode 1
voor een volstrekt normale uitkomst: *"nee, geen voorouder"* — precies wat er na een force-push gebeurt.
De drieweg-logica die in §6d met zoveel zorg is gebouwd stond dus in CI **achter een muur**: de stap
stierf op de regel die het antwoord ophaalde, nog vóór er iets mee gedaan kon worden. De hele
herschreven-tak-route was in de praktijk dode code.

Nulmeting, met de letterlijke stap uit de workflow en de weggeduwde kop als `before`:

```
$ VOOR=c47fecf… bash -e spiegelwet-step.sh
(geen uitvoer)   → exit=1
```

Twee reparaties. Ten eerste vangt een `if` de exitcode op, zodat de drie uitkomsten weer alle drie
bereikbaar zijn. Dezelfde meting daarna:

```
::warning::deze tak is herschreven (rebase of force-push): c47fecf… ligt niet in haar historie.
          Regels die main al publiceerde worden hieronder hard getoetst.
::warning::append-only afwijking t.o.v. de herschreven vorige stand: 1 regel(s) verdwenen, vanaf regel 73.
de huidige stand van main (harde eis bij een herschreven tak): geen regel verdwenen, geen regel dubbel,
          48 rij(en) publiek herkend.
→ exit=0
```

Ten tweede — en dat is het punt dat verder reikt dan deze ene regel — staat er nu een **val op de uitgang**
van de stap. Eindigt hij onverwacht, dan zegt hij dat tenminste. Want een poort die zwijgend rood wordt
is voor wie ernaar kijkt niet te onderscheiden van een poort die zwijgend niets doet, en dat is precies
wat deze wet elders verbiedt. Gemeten met een kaal falend commando ingespoten in de stap:

```
vóór:  uitvoer: (niets)                                                              → exit=128
na  :  ::error::de spiegelwet-stap stopte onverwacht met exitcode 128 — er is dus
       niets afgetoetst, en dat is rood.                                             → exit=128
```

Dat de run rood werd is dus goed nieuws: falen deed hij aan de juiste kant. Dat hij er niets bij zei,
was de fout — en die was alleen te zien doordat de poort op zijn eigen werk gedraaid heeft.

## AFSLUITING

- Tests groen: `npm test` → `tests 340 / pass 340 / fail 0` (na §6f; na §6e 336, na §6d 333, na §6c 328,
  daarvóór 321). Nulmeting vóór de bouw: `pass 276 / fail 1`. De vijf tests van §6d zijn de twee
  tegenvoorbeelden van Codex, het bewijs dat de publieke telling níét op vijftien knipt, en de correctie
  op de regeleinde-bewering; de drie van §6e zijn de herschikking (rood), de merge die rijen tussenvoegt
  (groen) en het gewone aanvullen (groen); de vier van §6f zijn de onleesbare meting (rood), de
  kop-zonder-rijen als grens de andere kant op (groen), de burenverwisseling met het rijnummer, en het
  meegesleepte volgorde-oordeel bij een verdwenen rij.
  Nulmeting van de rondgang-tests tegen de ongerepareerde waarnemer: `pass 6 / fail 1` op de `<br>`-fix,
  en eerder `2 van 5 rood` op de twee productiefouten.
- Rollback/additief geborgd: alles nieuwe bestanden plus één job en één trigger-pad in `waarnemer.yml`;
  terugdraaien = de commit terugdraaien. De spiegel is alleen aangevuld.
- Live bewijs: groene ronde tegen de echte plaat (stempel `2026-07-26T12:21:34.624Z`) en rode ronde met
  sabotage, exitcode 1. Daarna: de `waarnemer`-run op de eerste push van deze tak liep écht rood
  (run 30202331603) — uitgezocht, drie fouten gemeten en gerepareerd (§5), en de gerepareerde waarnemer
  loopt groen tegen dezelfde live plaat. De alarmpoort is gedraaid op de exacte regel die hij eerder
  afwees: groen, plus vijf saboteerde varianten rood.
- In GitHub Actions, op de push van de reparatie (`f350fd3`, run 30203461722): **success** —
  `spiegelwet: success`, `toetsen: success`, `poort: success`, `melden: skipped`, `verversen: skipped`.
  `melden` slaat over omdat er geen afwijking is; dat is de bedoeling, maar het betekent ook dat de
  gerepareerde alarmpoort in CI zelf nog niet gedraaid heeft. Bewijs daarvoor is de lokale ronde met
  de zes varianten hierboven, gedraaid op de letterlijke code uit `waarnemer.yml`.
- stack-smoke: n.v.t. — niet geïnstalleerd in deze repo.
- Secrets-scan: `gitleaks protect --staged` → `no leaks found` (laatste ronde: 24,01 KB).
- Raakvlakken gecheckt: `publish.yml` (levert het referentiemoment; niet gewijzigd), `waarnemer.yml`
  (job + trigger-pad erbij), `data/kanaalpost-publiek.md` (drie regels aangevuld, door de
  publicatiepoort gehaald: 277/519/532 tekens, geen afkapping), `lib/kanaalpost.mjs` (ongewijzigd,
  alleen gelezen).
- Codex: ja — vijf ronden. Eerste ronde: afwijzen tot herstel, negen punten verwerkt, twee als beslispunt
  doorgezet. Fixronde (A–E): vijf punten overgenomen, één erkend-maar-niet-gerepareerd met reden, één
  weerlegd (§5b). Besluitenronde: oordeel *niet aannemen*; de hoge bevinding (rebase bewaakte de
  verkeerde basis) is gemeten, gerepareerd en met vijf scenario's bewezen, plus vier kleinere; één
  punt beargumenteerd niet overgenomen, één als bestaand gedrag gemeld (§6b). Vierde ronde (rebase-ronde):
  opnieuw *niet aannemen* — twee hoge bevindingen op dezelfde blinde vlek (de wet telde brontekstregels
  in plaats van publieke rijen), beide met een werkend tegenvoorbeeld. Alle vijf punten overgenomen en
  gerepareerd (§6d); de derde hoge bevinding is een systeemgrens die alleen takbescherming oplost en
  gaat naar het GitHub-plan-besluit. Vijfde ronde (op de nieuwe laag zelf): één hoge bevinding — de
  publieke telling zag geen volgorde — gerepareerd en gemeten; drie punten nagelopen en als grens
  gedocumenteerd (§6e). Zesde ronde: nogmaals *niet aannemen* — drie bevindingen, alle drie identiek
  aan die van Gemini en alle drie gerepareerd, plus vier ontbrekende tests toegevoegd (§6f).
- Gemini: ja — vijf ronden. Eerste ronde: vier punten, één overgenomen (force-push op main), één weerlegd
  (typo). Fixronde: vier punten, waarvan drie samenvallen met Codex en overgenomen zijn; E1 weerlegd door
  meting. Besluitenronde: vier punten, waarvan er drie samenvallen met Codex (tekenverzameling te
  kort, hele-bestandscontrole, `fetch-depth`) en zijn overgenomen; het punt over rijen zonder
  beginpipe is weerlegd door meting. Vierde ronde: geen echte bevinding; het ene punt (identieke
  meldingen worden geblokkeerd) is nagemeten als bestaand gedrag van de bronlaag, geen regressie.
  Vijfde ronde: *aannemen met verfijningen* — drie punten, alle drie overgenomen, en op de inhoud
  gelijk aan die van Codex. Geen onenigheid tussen de twee in enige ronde, dus geen escalatie.
- Fable: ja — het besluit over ritme, "nooit onbekend" en het uitgestelde publieke alarm komt van
  Fable; de twee beslispunten hierboven gaan terug naar Fable.

Beslissingen die niet letterlijk in de opdracht stonden:

- De spiegelwet is niet alleen herstel maar ook een CI-poort — anders hangt de regel opnieuw aan
  oplettendheid. Verworpen alternatief: alleen de regel terugzetten.
- De harde wet is "niets verdwijnt", niet "alles blijft op zijn plaats". Verworpen alternatief: strikte
  prefix-eis; die maakt aanvullende takken onverenigbaar.
- De teruggezette regel staat onderaan, niet op haar oude plaats. Verworpen alternatief: tussenvoegen —
  dat is zelf een herschrijving van het bestand.
- Referentiemoment bij handmatige of push-runs: de laatst geslaagde publicatie. Verworpen alternatief:
  de controle daar niet laten draaien, waardoor een wijziging aan de bewaker ongetest blijft.

Aanvullend na §6c:

- Elke commit van de tak is apart gemeten, niet alleen de eindtoestand: 10 commits, `verdwenen 0`,
  `duplicaten 0` (`keur-tak.mjs`). Dat is de les van poging 1, waar de eindtoestand schoon was terwijl
  één tussenstap een gepubliceerde regel weghaalde. Na §6d meet dat script óók de publieke rijen: alle
  commits `-0 verdwenen / 0 dubbel`, eindtoestand t.o.v. `origin/main` 47 rijen in beeld, `ok true`.
- Veiligtakken vóór het herplaatsen: `reserve/waarnemer-voor-rebase` (730cfab) en
  `reserve/waarnemer-rebase-poging1` (c47fecf). Terugdraaien = de tak op een van die twee terugzetten.
- Secrets-scan van deze ronde: `gitleaks protect --staged` → `no leaks found` (17,13 KB).
- #24 vraagt geen tikregel meer: al samengevoegd als squash `1852c9c` (12:20:40Z), en de basis van #27
  is daarbij door GitHub zelf naar `main` gezet.

Wacht op Richard: de vier beslispunten in §6, het NFKC/NFC-beslispunt in §6c, en een handtekening op
#27. Voor CONTROL zit er één gemeten volgorde-eis bij: **#27 en #30 botsen** — beide raken het
spiegelbestand en in beide richtingen ontstaat een conflict, dus wie als tweede gaat moet opnieuw
aanleveren met een verse kop-SHA.
