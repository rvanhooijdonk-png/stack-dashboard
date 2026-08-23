# dashboard-feed-generator — reviewkopie

Dit is een **reviewkopie** voor Codex/Gemini/PR-doeleinden. Het draaiende exemplaar staat op
`~/Stack-Director/bin/dashboard-feed-generator.mjs` (Stack-Director staat bewust niet onder git —
zelfde reden als `bin/dispatch-actor`, `bin/director-watchdog`, `governance/*.md`: het is de
lokale orkestratieroot, geen gepubliceerde codebase). De twee bestanden hier moeten bij elke
wijziging aan het draaiende exemplaar 1:1 gesynchroniseerd blijven — dit is de auditeerbare kopie,
niet een fork.

## Wat het doet (Richard-akkoord 18-08-2026, FABLE-AKKOORD)
Leest read-only uit Stack-Director (dispatcher-functielog, watchdog-heartbeat, `outbox/*_RECEIPT.md`
— alleen het vaste key=value-kopblok, nooit de vrije '## Actoruitvoer'-body) en via `gh pr list`
(repo#nummer, geen titels). Bouwt de twee feeds, laat ze VERPLICHT door de echte
`parseTransactieFeed()`/`parseCodeTickerFeed()` uit deze repo lopen (poort 2 — faalt één van de
twee, dan publiceert geen van beide), en publiceert dan pas naar `CONTROL/FEEDS/*.json` op de
`dashboard-feeds`-branch van `stack-control` (nooit main, nooit `rapporten`) via de contents-API.
Commit alleen bij echte inhoudswijziging.

Raakt nooit de queue (`queue-packages/`, `execution-queue/`), nooit het lockbestand
(`state/director-dispatcher.lock`), en nooit de lopende Proef B.

## Launchd (klasse a — PR + dubbelreview vóór laden, condition 4)
`com.rvh.dashboard-feed-generator.plist` is het kant-en-klare template, StartInterval=900s
(zelfde cadans als `com.rvh.dashboard-heartbeat.plist` — publiceren vaker heeft geen zin, de site
herbouwt toch nooit vaker). **Niet zelf geladen.** Richard laadt na akkoord:

```bash
cp ~/Stack-Director/launchd/com.rvh.dashboard-feed-generator.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.rvh.dashboard-feed-generator.plist
```

Uitzetten:
```bash
launchctl unload ~/Library/LaunchAgents/com.rvh.dashboard-feed-generator.plist
```

### `DASHBOARD_REPOSITORY` — waarom die sleutel in het plist staat
Onder launchd is er geen Actions-context: `GITHUB_REPOSITORY` bestaat daar niet. De generator leidt
de plaats van het dashboard af met `resolveIdentity()` uit `scripts/lib/repo-identity.mjs`, en zonder
bron levert die eerlijk niets op — dan slaat de git-eventbron voor het dashboard over en publiceert
elke run een feed waarin die bron stilzwijgend ontbreekt. Daarom draagt het plist de identiteit zelf,
in `EnvironmentVariables`; het is geen handmatige stap die je apart moet onthouden.

Wat er gebeurt bij de drie vormen, en dat is met opzet niet één ding:

| `DASHBOARD_REPOSITORY` | Gevolg |
| --- | --- |
| geldig `owner/repo` | die repository wordt gelezen |
| niet-leeg maar misvormd | `resolveIdentity()` werpt: **luide fout, geen publicatie** — een uitdrukkelijke aanwijzing die niet klopt mag geen halve meting opleveren |
| leeg, alleen spaties, of afwezig | telt als niet gezet; dan pas telt `GITHUB_REPOSITORY`, en levert ook die niets op, dan slaat de bron over mét reden in het log |

De `origin` van de werkboom telt bewust niet mee, hoe voor de hand liggend ook: GitHub verwijst na een
overdracht de oude naam door, dus die remote blijft de vorige eigenaar noemen terwijl alles werkt.

**Bij een overdracht naar een organisatie verandert deze waarde mee.** Dat hoef je niet te onthouden:
de poort in `test/org-migration.test.mjs` houdt de waarde uit dit plist tegen de eigenaarsstand in de
poortmodule onder `scripts/lib/`, dus een vergeten regel is een rode toets en geen stille verkeerde
meting.
