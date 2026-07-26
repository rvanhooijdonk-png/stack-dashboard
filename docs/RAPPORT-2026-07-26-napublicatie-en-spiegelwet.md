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

## 5. Open beslispunten voor Fable

1. **De 8 minuten zijn te kort volgens beide reviewers.** GitHub zegt zelf dat een Pages-wijziging tot
   tien minuten kan duren, en in deze repo is gemeten dat de query-string geen cachesleutel is. Een
   uitrol die technisch klopt kan dus binnen 8 minuten onzichtbaar blijven — dat wordt dan onterecht
   rood. Advies van beide: 12 tot 15 minuten, gerekend vanaf de geslaagde uitrol. **Ik heb 8 minuten
   laten staan omdat dat het besluit was**, en meld dit in plaats van het stil te veranderen. Het
   publieke alarm staat uit, dus een onterecht rood blijft voorlopig binnen de bouw.
2. **`main` is niet beschermd** (geen branch protection, geen rulesets, force-push mogelijk). Elke
   poort in dit voorstel is daarmee een controle achteraf. Dit is een repo-instelling; wil je die aan,
   dan is het één handeling van Richard of de aangewezen merger.

## AFSLUITING

- Tests groen: `npm test` → `tests 299 / pass 299 / fail 0`. Nulmeting vóór de bouw: `pass 276 / fail 1`.
- Rollback/additief geborgd: alles nieuwe bestanden plus één job en één trigger-pad in `waarnemer.yml`;
  terugdraaien = de commit terugdraaien. De spiegel is alleen aangevuld.
- Live bewijs: groene ronde tegen de echte plaat (stempel `2026-07-26T12:21:34.624Z`) en rode ronde met
  sabotage, exitcode 1. De workflow-kant is nog niet in GitHub Actions gedraaid → dat gebeurt bij de
  push van deze tak.
- stack-smoke: n.v.t. — niet geïnstalleerd in deze repo.
- Secrets-scan: `gitleaks protect --staged` → `no leaks found` (39,17 KB).
- Raakvlakken gecheckt: `publish.yml` (levert het referentiemoment; niet gewijzigd), `waarnemer.yml`
  (job + trigger-pad erbij), `data/kanaalpost-publiek.md` (drie regels aangevuld, door de
  publicatiepoort gehaald: 277/519/532 tekens, geen afkapping), `lib/kanaalpost.mjs` (ongewijzigd,
  alleen gelezen).
- Codex: ja — afwijzen tot herstel; negen punten verwerkt, twee als beslispunt doorgezet.
- Gemini: ja — vier punten, waarvan één (force-push op main) overgenomen en één (typo) weerlegd.
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

Wacht op Richard: de twee beslispunten in §5, en een handtekening op #27 (en op #24 als basis).
