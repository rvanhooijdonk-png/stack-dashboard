# stack-dashboard

Externe, zelfverversende statuspagina over de stack. **Weergave van bestaande canon — nooit een
tweede waarheid.** De generator leest, aggregeert, saneert en rendert; hij schrijft nergens iets
terug.

Live: **https://rvanhooijdonk-png.github.io/stack-dashboard/**

## Wat er op staat

| Sectie | Bron |
| --- | --- |
| Open pull requests per repo | GitHub search API, org-breed |
| Gemerged (7 dagen) | GitHub search API |
| Tracker — laatste updates + beslispunten | `stack-control` → `AUDIT-INPUT/stack-open-beslispunten.md` |
| Besluitenregister | `stack-control` → `CONTROL/DECISIONS.md` |
| Vloot — laatste wijziging per track | `stack-control` → `CONTROL/TASK-QUEUE/` (commitdatum) |
| Journaal — laatste entries | `stack-control` → `CONTROL/FABLE-JOURNAAL.md` |
| CI-ampels | GitHub Actions API |
| Roadmap — 19 workstreams | `data/workstreams.json` (handmatig vastgelegd) |

De roadmapsectie vervangt de losse handmatige roadmap-refreshes.

**Wat je er níét op ziet: de tekst zelf.** De pagina toont de structuur van de canon — nummers,
ID's, datums, statussen, aantallen — en houdt kopregels, besluitregels en journaalkoppen in. Dat is
geen omissie maar het ontwerp: dit is een openbare pagina en de canon is intern. Per sectie
vrijgeven kan, met de hand, in `data/publish-text.json`; de reden en de voorwaarde staan in
`docs/SECURITY.md` §3. Repo- en tracknamen werken net zo: allowlist in `data/public-repos.json` en
`data/public-tracks.json`, de rest wordt geteld en niet benoemd.

## Draaien

```sh
node --test 'test/*.test.mjs'   # tests
node scripts/build.mjs          # bouwt public/index.html + public/status.json
open public/index.html
```

Vereist Node ≥ 20 en een ingelogde `gh`. Zonder org-breed leesrecht vallen de PR-secties terug op
`SOURCE_UNAVAILABLE` — zichtbaar leeg, nooit stilletjes groen.

Er is bewust **één** weg naar `public/`. De vroegere `--fixture`-modus sloeg de publieke reducer
over en schreef een bestand rechtstreeks naar de publicatiemap — een tweede, ongecontroleerde
build. Die is weg; `data/fixture.json` dient nu alleen de tests.

## Publicatie

GitHub Pages, gebouwd door `.github/workflows/publish.yml`: bij elke push naar `main` en
handmatig via *Run workflow*. De pagina haalt zichzelf opnieuw op met
`<meta http-equiv="refresh">`; er draait geen client-side JavaScript.

**De kwartiercron staat ingesteld maar vuurt hier niet.** Gemeten op 2026-07-23: na de merge van
#3 zijn de slots van 15:45, 16:00 en 16:15 alle drie leeg voorbijgegaan — nul runs met
`event=schedule`. Geen quotakwestie (publieke repo, onbeperkte minuten) en geen uitgeschakelde
workflow (`state=active`). Wat de meting bewijst: déze workflow werd in dat tijdvak niet gestart.
De oorzaak is niet los aangetoond; GitHub documenteert zelf dat geplande runs vertraagd en bij
drukte gedropt worden, en `*/15` valt precies op de drukke hele en halve uren. De cron blijft
staan — hij kost hier geen Actions-minuten en levert winst zodra hij wél aanslaat — maar hij telt
niet als garantie. De trigger die je zelf in de hand hebt:

```
gh workflow run publish.yml --repo rvanhooijdonk-png/stack-dashboard
```

Dat commando garandeert een *aanvraag*, niet dat build en deploy slagen — controleer de run.

Beide publieke pagina's zeggen dit ook zelf: geen interval beloven, en melden dat een oude stempel
betekent dat er sindsdien niets is gepubliceerd. `data/verboden-beloftes.json` houdt de
formuleringen bij die dat zouden ondermijnen; `test/publiekepaginas.test.mjs` toetst ze op de
gewone pagina én op de foutpagina in de workflow.

Zodra de autopilot-runner op de mini draait — die heeft al een waakvlam — kan die dit commando elk
kwartier aanroepen en de uitkomst nakijken. Dat is de echte fallback: een externe scheduler die
`workflow_dispatch` aanroept en zo nodig opnieuw probeert. Een tweede *schedule*-workflow zou niets
oplossen, want die hangt aan dezelfde GitHub-scheduler.

`public/` staat in `.gitignore` — de gegenereerde output wordt nooit gecommit, alleen als
Pages-artefact gedeployed.

## Veiligheid

De repo is **openbaar** op expliciet besluit van Richard (afwijking van de standaardregel
"nieuwe repo's privé", hardop benoemd). De verdediging is daarom in de eerste plaats *niet
meenemen* — vrije tekst en niet-vrijgegeven namen komen de publieke DTO niet in. Daaronder zit een
fail-closed **sanitize-gate** als vangnet, plus `gitleaks` op de output vóór elke publicatie.

De volgorde is opzettelijk: de gate herkent patronen, geen bedrijfsinhoud. Een dubbele review
bewees dat met een besluitregel over een klantovername die elke patroongate passeerde
(`docs/SECURITY.md` §3). Latere rondes vonden dezelfde probe terug via de roadmap, via een
foutmelding en via een workstreamnummer — vier keer hetzelfde patroon, elke keer een ander veld
dat tekst dóórgaf in plaats van afleidde.

Lees `docs/SECURITY.md` vóór je een collector toevoegt. Token-setup: `docs/TOKEN-SETUP.md`
(machine-recht — Richard voert dat zelf uit).

## Herkomst

Basis overgenomen uit het lokale Codex-artefact `stack-dashboard`
(`~/Documents/Stack-radar/stack-dashboard`, juli 2026), na inventarisatie:

- **Hergebruikt:** het snapshot-contract (`contracts/dashboard-snapshot.schema.json`) en de
  security-doctrine — met name het vertrouwensmodel waarin een mislukte ophaal `SOURCE_UNAVAILABLE`
  wordt in plaats van een gecachte groene stand. Dat idee is de kern die het waard was te bewaren.
- **Niet hergebruikt:** de code ernaast. Die was fixture-only (geen enkele `gh`-aanroep), zonder
  CI, zonder publicatiepad en zonder sanitize-gate. Als basis voor een openbare pagina was er meer
  te repareren dan te bewaren.

Het lokale artefact blijft staan als archief; er is geen parallel systeem — dit is de opvolger.

## Achtergrond

WS13 stond op 21-07-2026 op "geen dashboard". Richard heeft dat op 23-07-2026 herroepen; dit is de
uitvoering daarvan. Vastgelegd als DEC in `stack-control`.
