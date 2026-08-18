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
