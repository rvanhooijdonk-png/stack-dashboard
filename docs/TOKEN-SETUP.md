# Setup-recept: read-only PR-token in CI

> **Dit is een machine-recht en valt onder de Richard-gate (categorie: geld/accounts/tokens).**
> Het recept staat hier klaar; **Richard voert het zelf uit.** Er wordt door de vloot geen token
> aangemaakt, gekopieerd, getoond of gerouteerd.

## Waarom

Twee dingen hangen aan hetzelfde token:

1. **Dit dashboard** kan zonder org-breed leesrecht geen PR-stand over alle repo's tonen. Die
   secties vallen dan terug op `SOURCE_UNAVAILABLE` — zichtbaar leeg, niet stilletjes groen.
2. **De drift-gate** (`stack-control` → `.github/workflows/control-plane-drift-alert.yml`) is nu
   blind om precies dezelfde reden. Hetzelfde token repareert dat zintuig meteen. Zie besluit
   **D-0011** in `stack-control` → `CONTROL/DECISIONS.md`.

De standaard `GITHUB_TOKEN` van Actions reikt niet verder dan de repo waarin de workflow draait.
Daarom is een apart, expliciet gescoopt token nodig.

## Aanbevolen: fine-grained personal access token

**GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**

| Veld | Waarde |
| --- | --- |
| Token name | `stack-dashboard-read` |
| Resource owner | `rvanhooijdonk-png` — het account waarover de plaat rapporteert (`stack-control` en de bewaakte repo's), níét noodzakelijk het account waar deze repository zelf staat |
| Expiration | 90 dagen (korter mag; zet een herinnering) |
| Repository access | **All repositories** — org-breed lezen is het hele doel |
| Repository permissions → **Pull requests** | **Read-only** |
| Repository permissions → **Contents** | **Read-only** |
| Repository permissions → **Actions** | **Read-only** (alleen voor de CI-ampels) |
| Alle overige permissies | **No access** — expliciet laten staan |
| Account permissions | **No access** |

Dat is de volledige scope. Geen `write`, geen `admin`, geen `workflow`, geen org-beheer. Een
token met dit profiel kan niets kapotmaken; het kan alleen lezen wat de pagina toch al toont.

## Waar hij heen gaat

**stack-dashboard** (voor deze pagina):
`Settings → Secrets and variables → Actions → New repository secret`
naam: `ORG_PR_READ_TOKEN`

**stack-control** (voor de drift-gate):
zelfde procedure, zelfde naam `ORG_PR_READ_TOKEN`.

> Eén token, twee bestemmingen. Rouleer je hem, dan op beide plekken tegelijk.

## Verificatie zonder de waarde te tonen

Na het plaatsen: draai in beide repo's de workflow handmatig (`Actions → Run workflow`) en kijk
naar de samenvatting.

- **stack-dashboard** — geslaagd als de pagina bij *Open pull requests* een repolijst toont in
  plaats van *bron onbereikbaar*, en `overallStatus` op `OK` staat.
- **stack-control** — geslaagd als de drift-alert een telling rapporteert in plaats van een
  overgeslagen stap.

De workflowlog toont de waarde nooit; GitHub maskeert secrets automatisch, en de generator print
sowieso geen tokenmateriaal.

## Rotatie

Bij verloop of vermoeden van lekkage: nieuw token aanmaken → beide secrets bijwerken → oud token
intrekken. In die volgorde (additief: het oude blijft geldig tot de vervanger bewezen werkt).

Merk op dat de **KEY-ROTATIE die uit besluit D-0004 volgt een los, nog openstaand Richard-alarm
is** — dit token staat daar volledig buiten en lost dat niet op.
