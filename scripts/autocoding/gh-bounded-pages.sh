# AUTOCODING_SHIELD — BEGRENSDE PAGINERING VOOR `gh api`.
#
# WAAROM DIT BESTAAT. V11 rekende met `PER_PULL_REQUEST_REQUEST_BUDGET=26`, maar haalde vijf
# bewijslijsten op met `gh api --paginate --slurp`. `--paginate` volgt de `Link`-header tot de laatste
# pagina en kent GEEN bovengrens: een PR met veel commits, comments, reviews of bestanden kostte dus
# willekeurig veel verzoeken. Daarmee was 26 geen bovengrens maar een schatting, en kon één grote PR
# het GEDEELDE uurquotum van duizend verzoeken per repository alsnog leegtrekken — nadat `pending` al
# gepubliceerd was, dus met een head die op `pending` bleef staan.
#
# Deze functie vervangt `--paginate` overal in de trusted writer en in zijn selectiejob. Zij haalt
# hoogstens `max_pages` pagina's van `GH_BOUNDED_PAGE_SIZE` items op en stopt daarna ALTIJD. Het
# aantal verzoeken van een lijst is daarmee hard begrensd op `max_pages`, en dat getal is de enige
# grond onder de budgetconstanten in `scripts/autocoding/select-live-gate-targets.mjs`.
#
# TRUNCATIE IS EEN MEETRESULTAAT, GEEN KOSTENPOST. Is de laatst toegestane pagina VOL, dan bestaat er
# mogelijk nog een volgende pagina en is de oogst dus onvolledig. Dat wordt vastgesteld uit de pagina
# die al is opgehaald — er gaat geen extra verzoek naartoe, en er wordt nooit een pagina voorbij
# `max_pages` opgevraagd. De uitkomst wordt aan de aanroeper gemeld met exitcode 2, zodat die
# fail-closed kan eindigen in plaats van een halve oogst als volledig bewijs te behandelen.
#
# De UITVOER is dezelfde vorm die `--paginate --slurp` opleverde: een JSON-array VAN PAGINA's
# (`[[...],[...]]`). `flattenPages` in `collect-shield-input.mjs` leest die vorm ongewijzigd, dus de
# hele adapterlaag erachter verandert niet.

# GitHub's maximale paginaomvang voor lijsteindpunten. Een kleinere waarde zou meer verzoeken kosten
# voor hetzelfde zicht; een grotere wordt door GitHub genegeerd en zou de vol-detectie hieronder stuk
# maken, want dan komt een volle pagina nooit op dit getal uit.
GH_BOUNDED_PAGE_SIZE=100

# Het aantal pagina's per BEWIJSLIJST van één pull request. Vier pagina's is 400 items: ruim boven
# elke PR die deze repository kent, en hard genoeg om het budget te kunnen uitrekenen.
# Spiegelbeeld van `LIST_PAGE_BUDGET`.
GH_BOUNDED_EVIDENCE_PAGES=4

# Het aantal pagina's van de open-PR-lijst in de selectiejob. Vier pagina's is 400 open PR's; de
# gemeten stand was er 126. Spiegelbeeld van `SELECTION_PAGE_BUDGET`.
GH_BOUNDED_SELECTION_PAGES=4

# Het aantal pagina's van de CHECK-RUNS van één commit, in de finalizer. Dit eindpunt geeft geen
# kale array terug maar een object met de lijst onder `check_runs`, en wordt daarom met de vijfde
# parameter hieronder opgehaald. Vier pagina's is 400 checks op één commit — ruimschoots boven wat
# deze repository draait, en hard genoeg om in de budgetsom mee te tellen. Spiegelbeeld van
# `CHECKS_PAGE_BUDGET`.
GH_BOUNDED_CHECKS_PAGES=4

# `gh_bounded_pages <api-pad> <uitvoerbestand> <max-pagina's> <werkmap> [<veld>]`
#
#   rc 0 — de lijst is VOLLEDIG opgehaald en staat in het uitvoerbestand.
#   rc 1 — een parameter was onbruikbaar (geen geldig paginamaximum, lege werkmap, onbruikbare
#          veldnaam), of een verzoek, een antwoord of een schrijfactie mislukte; het uitvoerbestand
#          is onbruikbaar.
#   rc 2 — de laatst toegestane pagina was vol: de oogst is MOGELIJK ONVOLLEDIG. Het uitvoerbestand
#          bevat wat er wél is opgehaald, maar mag niet als volledig bewijs gelden.
#
# `<veld>` is optioneel en dient uitsluitend voor eindpunten die hun pagina NIET als kale array
# leveren maar als object met de lijst eronder — `/commits/{sha}/check-runs` geeft `check_runs`.
# Zonder deze parameter zou de finalizer voor zo'n eindpunt een tweede, ongebonden ophaalpad nodig
# hebben, en precies dat willen we niet: één begrensde lees-lus, één vol-detectie, één truncatiecode.
# De veldnaam moet een kale sleutelnaam zijn; alles daarbuiten is een aanroepfout en wordt geweigerd
# vóór het eerste verzoek. De uitvoervorm blijft in beide gevallen een array VAN PAGINA's, zodat
# `flattenPages` er niets van hoeft te weten.
gh_bounded_pages() {
  local api_path="$1" out="$2" max_pages="$3" scratch="$4" veld="${5-}"
  local separator page count truncated last body

  case "$max_pages" in ''|*[!0-9]*) return 1 ;; esac
  [ "$max_pages" -ge 1 ] || return 1
  case "$veld" in '') ;; *[!A-Za-z0-9_]*|[0-9]*) return 1 ;; esac
  # Het pad draagt soms al een query (`pulls?state=open`). Het verkeerde scheidingsteken zou de
  # paginaparameters aan de vorige waarde plakken en de begrenzing stil laten vervallen.
  case "$api_path" in *'?'*) separator='&' ;; *) separator='?' ;; esac

  # DE WERKMAP WORDT GEWIST, DUS MOET ZIJ BESTAAN. Een lege vierde parameter — een niet-gezette
  # variabele bij een aanroeper zonder `set -u`, of een tikfout in de env-naam — zou `rm -rf ""`
  # opleveren. Dat is geen theoretische smet: het pad wordt hier ONVOORWAARDELIJK verwijderd, dus
  # elke betekenis die de shell aan de lege string geeft is er één te veel. De weigering staat vóór
  # `rm`, vóór `mkdir` en vóór het eerste `gh`-verzoek, zodat een aanroep met lege werkmap niets
  # muteert, niets van het quotum kost en geen uitvoerbestand achterlaat om per ongeluk te lezen.
  [ -n "$scratch" ] || return 1
  rm -rf "$scratch" || return 1
  mkdir -p "$scratch" || return 1

  truncated=0
  last=0
  page=1
  while [ "$page" -le "$max_pages" ]; do
    body="$scratch/page-$page.json"
    gh api "${api_path}${separator}per_page=${GH_BOUNDED_PAGE_SIZE}&page=${page}" > "$body" || return 1
    # De telling komt uit het AL OPGEHAALDE antwoord, niet uit een extra verzoek. Een antwoord dat
    # geen lijst is, is geen lege lijst maar een onbruikbaar antwoord. Is er een veld gevraagd, dan
    # wordt de pagina ter plekke tot die lijst herschreven — de vol-detectie hieronder telt dan de
    # items die het eindpunt werkelijk pagineert, niet de sleutels van de omhullende envelop.
    count="$(node -e 'const fs=require("fs");const f=process.argv[1],veld=process.argv[2];let d=JSON.parse(fs.readFileSync(f,"utf8"));if(veld){if(typeof d!=="object"||d===null||Array.isArray(d))process.exit(1);d=d[veld];if(!Array.isArray(d))process.exit(1);fs.writeFileSync(f,JSON.stringify(d));}if(!Array.isArray(d))process.exit(1);process.stdout.write(String(d.length))' "$body" "$veld")" || return 1
    case "$count" in ''|*[!0-9]*) return 1 ;; esac
    last="$page"
    # Een niet-volle pagina is het einde van de lijst: er valt niets meer te halen. Bewust een `if`
    # en geen `[ ... ] && break`: die vorm levert een non-zero status op zodra hij niet breekt, en
    # zou onder een aanroeper met `set -e` de hele stap laten stoppen.
    if [ "$count" -lt "$GH_BOUNDED_PAGE_SIZE" ]; then break; fi
    # Een volle LAATST TOEGESTANE pagina betekent dat er mogelijk meer is. Er wordt geen vijfde
    # pagina opgevraagd; de aanroeper hoort dat de oogst onvolledig kan zijn.
    if [ "$page" -eq "$max_pages" ]; then truncated=1; break; fi
    page=$((page + 1))
  done

  # Een SUBSHELL en geen `{ ... }`-groep: in een brace-groep zou `exit 1` de hele aanroepende stap
  # beëindigen in plaats van deze functie te laten falen, en zou `|| return 1` alleen de status van
  # de laatste `printf` zien. Nu vangt `|| return 1` een mislukte samenvoeging werkelijk af.
  (
    printf '['
    page=1
    while [ "$page" -le "$last" ]; do
      [ "$page" -eq 1 ] || printf ','
      cat "$scratch/page-$page.json" || exit 1
      page=$((page + 1))
    done
    printf ']\n'
  ) > "$out" || return 1

  [ "$truncated" -eq 0 ] || return 2
  return 0
}
