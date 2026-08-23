# Organisatie-overdracht — wat omslaat, wat blijft, en wat er lokaal nog moet gebeuren

`stack-dashboard` gaat van het persoonlijke account naar de organisatie. De overdraagbaarheid zelf
is al gebouwd (PR #80): de publicatieketen leidt haar adressen af uit `GITHUB_REPOSITORY` en heeft
geen letterlijke eigenaar meer nodig. Dit document beschrijft de laatste stap — de configuratie die
bij de overdracht meeverandert — en het lokale werk dat daar niet in een pull request bij kan.

**Deze wijziging voert de overdracht niet uit.** Zij is de drager ervan: zij is pas waar op het
moment dat zij wordt gemerged, en dat hoort samen te vallen met de transfer op GitHub.

## 1. Wat als één geheel omslaat

Drie plaatsen, en ze horen bij elkaar. Slaat er één niet om, dan is de stand tegenstrijdig en wordt
`test/org-migration.test.mjs` rood in plaats van dat er stil naar een verhuisd object wordt gekeken.

| Plaats | Wat het is |
| --- | --- |
| `HOSTING_OWNER_OF_RECORD` in `scripts/lib/org-migration.mjs` | De declaratie waartegen alle vaste tekst wordt gehouden |
| `DASHBOARD_REPOSITORY` in `tools/dashboard-feed-generator/com.rvh.dashboard-feed-generator.plist` | De identiteit voor launchd, dat geen Actions-context kent |
| Het Pages-adres in `README.md` | De enige leesbare vermelding van het live adres |

De uitzonderingspost voor het plist in `CONTROL/AUTOCODING/org-migratie-uitzonderingen.json` draagt
de nieuwe waarde mee: die lijst noemt letterlijke tekst, dus zij verandert met de tekst mee. Dat is
geen extra configuratiepunt maar dezelfde regel, gezien vanaf de poort.

## 2. Wat met opzet NIET meeverhuist

Vier dingen die eruitzagen als dezelfde eigenaar zijn het niet. Ze blijven op het persoonlijke
account staan, elk met een gedekte post op de uitzonderingenlijst:

- `DASHBOARD_OWNER` in `scripts/lib/collect.mjs` — het account waaróver de plaat rapporteert. Zou
  dit meeverhuizen, dan rapporteert het dashboard na de overdracht over een lege organisatie:
  groen, en volstrekt betekenisloos.
- `CONTROL_OWNER` in `tools/dashboard-feed-generator/generator.mjs` — de eigenaar van
  `stack-control`, dat níét wordt overgedragen. Zolang die repository persoonlijk blijft, blijft
  deze waarde persoonlijk.
- `allowed_owner_actors` in `CONTROL/AUTOCODING/policy.v1.json` — een persoonslogin. Een
  repository-overdracht verplaatst geen mensen.
- `HISTORISCHE_BEWIJS_EIGENAAR` in `scripts/lib/runtime-feed-view.mjs` — al gepubliceerd
  bewijsmateriaal wijst naar commits onder het persoonlijke account. Die links blijven geldig en
  blijven klikbaar; de poort accepteert bewijs van beide eigenaars.

## 3. De lokale feedgenerator — exacte bestandsafbeelding

De feedgenerator draait onder launchd op deze Mac. Het exemplaar in deze repository is een
**reviewkopie**; het draaiende exemplaar staat buiten git (`~/Stack-Director` is de lokale
orkestratieroot). Een merge verandert daar dus niets aan. Dit is de afbeelding die een aparte
activatiegate later uitvoert:

| Bron (deze repository) | Doel (deze Mac) |
| --- | --- |
| `tools/dashboard-feed-generator/generator.mjs` | `~/Stack-Director/bin/dashboard-feed-generator.mjs` |
| `tools/dashboard-feed-generator/com.rvh.dashboard-feed-generator.plist` | `~/Stack-Director/launchd/com.rvh.dashboard-feed-generator.plist` |
| `~/Stack-Director/launchd/com.rvh.dashboard-feed-generator.plist` | `~/Library/LaunchAgents/com.rvh.dashboard-feed-generator.plist` |

### Gemeten stand van de geïnstalleerde kopie (2026-08-23, base `6e91124`)

De achterstand is groter dan alleen deze overdracht, en dat is de reden dat het hier staat:

| Bestand | sha256 | Stand |
| --- | --- | --- |
| `~/Stack-Director/bin/dashboard-feed-generator.mjs` | `4c2823c6eb3104ef37a6a266400923c241e359ee392b9a20d6fd2778d2f5d19c` | 16898 bytes; kent `repo-identity.mjs` nog niet en leest `DASHBOARD_REPOSITORY` niet — dus vóór PR #80 |
| `~/Stack-Director/launchd/com.rvh.dashboard-feed-generator.plist` | `365e6c148a2a2a5d051bad6df71f1f30cf045f6dcfb3470acaee067f3c318fa0` | draagt géén `DASHBOARD_REPOSITORY`-sleutel |
| `~/Library/LaunchAgents/com.rvh.dashboard-feed-generator.plist` | `365e6c148a2a2a5d051bad6df71f1f30cf045f6dcfb3470acaee067f3c318fa0` | gelijk aan de vorige regel |

Gevolg: de geïnstalleerde generator laat de git-events van het dashboard nú al weg uit elke
publicatie, zonder fout. De sync trekt PR #80 en deze overdracht in één keer bij.

### De handeling zelf — NIET UITGEVOERD

Onder de eigenaarsgate, na de merge en na de transfer op GitHub. Schrijf naar een tijdelijk bestand
in dezelfde map en hernoem: een `mv` binnen één bestandssysteem is atomisch, zodat een run die
toevallig tegelijk start nooit een half bestand leest.

```bash
# 0. controleer dat de bron werkelijk de bedoelde stand is
cd <klone-van-stack-dashboard-op-main-na-merge>
shasum -a 256 tools/dashboard-feed-generator/generator.mjs \
              tools/dashboard-feed-generator/com.rvh.dashboard-feed-generator.plist

# 1. generator, atomisch
cp tools/dashboard-feed-generator/generator.mjs \
   ~/Stack-Director/bin/.dashboard-feed-generator.mjs.nieuw
mv -f ~/Stack-Director/bin/.dashboard-feed-generator.mjs.nieuw \
      ~/Stack-Director/bin/dashboard-feed-generator.mjs

# 2. plist, atomisch, op beide plaatsen
cp tools/dashboard-feed-generator/com.rvh.dashboard-feed-generator.plist \
   ~/Stack-Director/launchd/.com.rvh.dashboard-feed-generator.plist.nieuw
mv -f ~/Stack-Director/launchd/.com.rvh.dashboard-feed-generator.plist.nieuw \
      ~/Stack-Director/launchd/com.rvh.dashboard-feed-generator.plist
cp ~/Stack-Director/launchd/com.rvh.dashboard-feed-generator.plist \
   ~/Library/LaunchAgents/.com.rvh.dashboard-feed-generator.plist.nieuw
mv -f ~/Library/LaunchAgents/.com.rvh.dashboard-feed-generator.plist.nieuw \
      ~/Library/LaunchAgents/com.rvh.dashboard-feed-generator.plist

# 3. pas hierna herladen — launchd leest een plist alleen bij het laden
launchctl unload ~/Library/LaunchAgents/com.rvh.dashboard-feed-generator.plist
launchctl load   ~/Library/LaunchAgents/com.rvh.dashboard-feed-generator.plist

# 4. controle: de drie kopieën zijn nu gelijk aan de bron
shasum -a 256 ~/Stack-Director/bin/dashboard-feed-generator.mjs \
              ~/Stack-Director/launchd/com.rvh.dashboard-feed-generator.plist \
              ~/Library/LaunchAgents/com.rvh.dashboard-feed-generator.plist
```

Stap 3 is de enige stap met een lopend proces erin en hoort daarom expliciet in de activatiegate;
zonder stap 3 blijft de oude omgeving actief tot de volgende herstart.

## 4. Volgorde op het moment van de overdracht

1. De repository overdragen op GitHub (buiten deze repository om).
2. Pages opnieuw controleren: het adres volgt de nieuwe eigenaar, in kleine letters.
3. Deze wijziging mergen — daarna klopt de vaste tekst weer bij het object.
4. De sync uit §3 uitvoeren onder de eigenaarsgate.

Loopt stap 3 vóór stap 1, dan wijst het README-adres naar een plaat die er nog niet is. Loopt hij
er ver achter, dan wijst hij naar een plaat die er niet meer is. Dat is de reden dat deze wijziging
één klein pakket is en niet een reeks losse verbeteringen.
