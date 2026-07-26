# KANAALPOST — publieke spiegel

Dit is de **geschoonde, publieke spiegel** van een intern logboek. Elk werkvenster meldt hier
in gewone taal wat het heeft afgerond en wat er op een besluit wacht. Het bestaat zodat een
meelezend kanaal de stand zélf kan lezen, zonder dat er iemand tussen hoeft te zitten.

**Hoe je dit leest.** Eén regel = één afgerond stuk werk of één gemelde bevinding. De kolommen:

| kolom | betekenis |
|---|---|
| **datum-tijd** | wanneer de melding is geschreven (Europe/Amsterdam) |
| **tab-rol** | welk werkvenster het meldde — een neutraal rollabel, geen persoon en geen repo |
| **onderwerp** | wat er gebeurd is, in gewone taal |
| **status** | `AFGEROND` · `WACHT OP AKKOORD` · `GEBLOKKEERD` |
| **actie voor** | wie aan zet is: Richard, Fable, een merger, of niemand |

**Wat je hier bewust niet vindt.** Deze spiegel is een herformulering, geen kopie. Bestands- en
mappaden, sleutels, bedragen, klant- en persoonsnamen en als gevoelig gemarkeerd materiaal
worden niet meegenomen — niet gefilterd, maar weggelaten. Repo-namen en voorstelnummers staan
er alleen voor de vier repositories die al openbaar zijn; alle andere krijgen een functionele
aanduiding (`assistent-bot-repo`, `markt-radar-repo`, `content-pipelinerepo`,
`presentatie-archiefrepo`). Ook de rollabels in de tweede kolom zijn neutraal gekozen
(`INSTROOM`, `CONTENT`, `MARKT`, `PRESENTATIES`, …) en verwijzen niet naar een repository.
Wie een regel schrijft, schoont zelf.

**Append-only.** Regels worden onderaan toegevoegd en nooit herschreven of verwijderd. De
volgorde is die van het toevoegen, niet strikt die van de klok.

| datum-tijd | tab-rol | onderwerp | status | actie voor |
|---|---|---|---|---|
| 2026-07-25 22:15 | INSTROOM | Elf extra kennisankers uit een oudere bron zijn opgenomen als *verrijking*. Ze tellen bewust niet mee als bouwwerk, dus de bouwlijst blijft ongewijzigd. | AFGEROND | niemand |
| 2026-07-25 22:15 | INSTROOM | Onafhankelijke tweede review bevestigde dat die opname verliesvrij is en niet naar de bouwlijst kan lekken. Twee kleine kanttekeningen verwerkt. | AFGEROND | niemand |
| 2026-07-25 20:11 | COMMAND-CANON | Twee integratiegaten in het centrale modellenregister gedicht, met een falende test vooraf: het register vindt zichzelf nu ongeacht de werkmap, en de controlefunctie kreeg dezelfde vorm als de bestaande koppelstukken. | WACHT OP AKKOORD | Richard (command-canon #31) |
| 2026-07-25 20:18 | ARCHEOLOGIE | Zeven lagen historisch materiaal op elkaar gelegd. Kernbevinding: alle vastgelegde besluiten gaan over werkwijze, geen enkele over het product zelf — de grootste terugkerende thema's zijn nooit bestuurd. | AFGEROND | Richard |
| 2026-07-25 22:24 | COMMAND-CANON | Uitvoerbaar plan om handgekopieerde modeltabellen in twee andere repo's te vervangen door een dun koppelstuk op de centrale bron. Gedrag blijft identiek; het is uitdrukkelijk géén modelwissel. | WACHT OP AKKOORD | Richard |
| 2026-07-25 22:31 | COMMAND-CANON | In de assistent-bot-repo stond nog een afgekeurde model-aanduiding op drie plekken; een al gereviewde correctie lag ongebruikt klaar en is als voorstel ingediend. Nevenvondst: de testpoort van die repo was rood op de hoofdlijn zelf, waardoor geen enkel voorstel er schoon doorheen kon. | GEBLOKKEERD | CHIEF / CONTROL |
| 2026-07-25 22:33 | COMMAND-CANON | Voorstel voor een aanbevolen inspanningsstand per venster-rol, nadat bleek dat niemand die per sessie bewust koos. Zwaar werk mag hoger, bulkwerk lager — per saldo kostenverlagend. | WACHT OP AKKOORD | CONTROL |
| 2026-07-25 22:38 | DASHBOARD | De echte bouwlijst staat nu op de planningsplaat in plaats van vijf voorbeeldregels; dubbele review binnen, zes punten verwerkt. Aandachtspunt bij de beslissing: de plaat is openbaar, een deel van de labels bevat eigennaam-achtige woorden en de blokkeerlijst was nog leeg. | WACHT OP AKKOORD | Richard (stack-dashboard #18) |
| 2026-07-25 22:44 | COMMAND-CANON | Vijfde integriteitscontrole op de meetopstelling. Eén enkele afwijking kon eerder willekeurig veel ontbrekende metingen wegpoetsen terwijl de meting toch "deugdelijk" heette; dat excuus geldt nu alleen nog als de afwijking de run echt afbrak. | AFGEROND | niemand |
| 2026-07-25 22:52 | COMMAND-CANON | Voorraad bewezen leeg: geen nieuwe opdracht in de eigen wachtrij en geen enkele openstaande taak raakt deze repo's. Nachtteller zes van zes. | AFGEROND | Richard |
| 2026-07-26 04:50 | COMMAND-CANON | Na de herstart bleek dat twee gepubliceerde rapporten verwezen naar commits die alleen lokaal bestonden — het bewijs was voor een lezer dus niet na te rekenen. Beide takken alsnog gepubliceerd; de cijfers in de rapporten zijn onveranderd. | AFGEROND | niemand |
| 2026-07-26 04:52 | PRESENTATIES | Batch van negen punten rond het presentatie-archief afgerond: de schijfwachter meldt nu falen in plaats van stil door te gaan, een ontdubbelingsgeval is beslecht en het metadataschema bleek al bevroren. Losse vondst: een kopie van een script buiten de repo is nog de oude, ongepoorte versie. | WACHT OP AKKOORD | Richard + Fable |
| 2026-07-26 04:52 | PRESENTATIES | Voorraad bewezen leeg, met methode erbij. Twee hygiënepunten voor de centrale wachtrij gemeld: één taak is achterhaald omdat het werk al geleverd is, en twee taken wijzen naar een repository die niet bestaat. | AFGEROND | Richard |
| 2026-07-26 04:55 | CONTENT | Eerste fase van de artikel-pijplijn is klaar om samengevoegd te worden: van signaal naar conceptdossier met bronregister, volledig offline, met een harde eigenaarspoort zodat er niets automatisch gepubliceerd wordt. Onafhankelijke herreview akkoord. | WACHT OP AKKOORD | merger (niet de bouwer) |
| 2026-07-26 05:00 | MARKT | Publicatieroute en verversingsschema voor de statische voorpagina van de markt-radar; publiek-veilig en alleen-lezen. | WACHT OP AKKOORD | Richard |
| 2026-07-26 05:00 | MARKT | Tweede fase van de voorspellingen-administratie: uitkomstcontrole en geloofwaardigheid per bron, bovenop het bestaande grootboek. Dubbele review verwerkt. | WACHT OP AKKOORD | Richard |
| 2026-07-26 05:00 | MARKT | Na de herstart bleken twee voorstellen stil onbruikbaar geworden doordat de hoofdlijn was doorgelopen. Beide conflicten waren triviaal en zijn opgelost zonder een test aan te raken; alles weer groen. | AFGEROND | Richard |
| 2026-07-26 05:00 | MARKT | De testpoort zelf viel stil uit: door een filter draaide hij nul keer op een gestapeld voorstel, en dat leest als "niets mis" in plaats van als rood. Gerepareerd en met een wegwerp-voorstel gemeten in plaats van beredeneerd. Beide reviewers wezen daarnaast op een openstaand beslispunt: controles zijn nu aanwezig, maar nog niet verplicht vóór samenvoegen. | WACHT OP AKKOORD | Richard |
| 2026-07-26 05:15 | CHIEF | De rode testpoort van de assistent-bot-repo is gedicht; samenvoegen kan daar weer. Correctie op de eerdere diagnose: het leeuwendeel van de fouten kwam niet van de eerder aangewezen oorzaak, maar van een opdracht die alleen op macOS bestaat en op de bouwserver faalde. Lokaal exact nagespeeld met een wegwerp-emulator van die server. | WACHT OP AKKOORD | merger (niet de auteur) |
| 2026-07-26 07:15 | COMMAND-CANON | Tweede-familie-review op het modellenregister: vier bevindingen bevestigd, één direct gerepareerd. De zwaarste was dat de integratie-instructie een aanroep voorschreef die meteen crasht — juist wie de instructie netjes volgde, viel om. Drie punten die stil kunnen falen zijn bewust níét gerepareerd, omdat ze gedrag veranderen en de vervanging op gedragsbehoud rust. | WACHT OP AKKOORD | Richard (command-canon #31) |
