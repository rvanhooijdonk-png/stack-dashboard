/**
 * ORGANISATIEMIGRATIE-POORT — bewaakt dat deze repository overdraagbaar BLIJFT.
 *
 * `stack-dashboard` wordt van een persoonlijk account naar een organisatie overgedragen. De
 * omzetting zelf is code (zie `lib/repo-identity.mjs`); dit bestand is de poort die voorkomt dat
 * er ná die omzetting stilletjes nieuwe hardcoderingen bij komen. Zonder poort is dit werk één
 * schoonmaakbeurt met een houdbaarheid van precies één pull request.
 *
 * DRIE REGELS, elk afgeleid uit een reëel faalgeval en niet uit een principe:
 *
 *  R1 `OPERATIONELE_EIGENAAR` — in uitvoerende paden (`scripts/`, `tools/`, `.github/workflows/`)
 *     mag de naam van de eigenaar niet als letterlijke tekst voorkomen, tenzij hij op de
 *     uitzonderingenlijst hieronder staat mét reden. Grond: dit was de vorm waarin het Pages-adres,
 *     het raw-adres en het API-pad de overdracht niet zouden hebben overleefd.
 *
 *     R1 kijkt naar de HUIDIGE eigenaar én naar elke eigenaar die deze repository eerder droeg
 *     (`VORIGE_HOSTING_EIGENAARS`), en zegt in `eigenaarsklasse` welke van de twee hij vond. Dat
 *     onderscheid is de hele winst van deze twee-eigenaarsstand, want de remedie verschilt: bij
 *     `HUIDIG` moet er een afleiding voor in de plaats komen, bij `ACHTERGEBLEVEN` is er bij de
 *     overdracht iets vergeten. Zou R1 alleen de huidige eigenaar kennen, dan zou de poort op het
 *     moment van de overdracht in één klap stil worden op precies de fout die dan het meest
 *     waarschijnlijk is: een operationele verwijzing die is blijven staan.
 *
 *  R2 `VEROUDERD_PAGES_ADRES` — buiten `test/` moet elk letterlijk
 *     `https://<host>.github.io/<repo>`-adres bij de HUIDIGE eigenaar horen. Grond: een Pages-adres
 *     van de vorige eigenaar levert na de overdracht een HTTP-fout op, en die fout wordt door de
 *     waarnemer gelezen als "de plaat is niet vers" — niet als "het adres is verhuisd". Dat is
 *     precies een storing die niemand ziet.
 *
 *  R3 `VERVALLEN_UITZONDERING` — elke uitzondering moet in de boom ook echt WERK DOEN. Niet: haar
 *     tekst komt ergens voor. Wél: zij heeft daadwerkelijk een voorkomen gedekt dat anders een
 *     R1-bevinding was geweest. Een lijst met vervallen posten wordt vanzelf een lijst waar alles
 *     op mag.
 *
 * WAT BEWUST BUITEN DE POORT VALT, en waarom — dit is geen vergetelheid maar een afbakening:
 *
 *  - `test/` en `test/fixtures/` — daar is `<eigenaar>/stack-dashboard` INVOER van een toets, geen
 *    binding van deze repository aan een plaats. Een toets die een repositorynaam noemt hoort dat
 *    gewoon te mogen, en een toets die bewijst dát de poort een verouderd adres weigert MOET dat
 *    verouderde adres letterlijk kunnen opschrijven. Zou R2 ook hier gelden, dan kon de poort haar
 *    eigen negatieve controle niet dragen.
 *  - `docs/` en `CONTROL/**.md` — verslag van wat op een moment gemeten is. Een meetrapport uit
 *    juli mag naar het object wijzen dat toen gemeten werd; het achteraf herschrijven zou het
 *    verslag onwaar maken.
 *  - `contracts/*.schema.json` (`$id`) — een schema-`$id` is een IDENTIFICATIE, geen ophaal-adres.
 *    Hem laten meeverhuizen breekt elke `$ref` en elke consument die op de oude id vergelijkt,
 *    zonder dat er iets mee wordt opgelost.
 *  - `CONTROL/AUTOCODING/policy.v1.json` (`allowed_owner_actors`, `allowed_builder_actors`) — dat
 *    is een PERSOONSLOGIN, geen repository-eigenaar. Die verhuist per definitie niet mee met een
 *    overdracht en moet juist ongewijzigd blijven.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * HET ENE CENTRALE CONFIGURATIEPUNT. Bij de overdracht verandert hier één regel, en de poort wijst
 * daarna zelf elke plaats aan die nog niet mee is.
 *
 * Let op wat dit NIET is: dit is geen bron voor het opbouwen van adressen tijdens het draaien. Daar
 * geldt uitsluitend de afleiding uit `GITHUB_REPOSITORY` in `lib/repo-identity.mjs`. Deze constante
 * dient alleen om VASTE TEKST (README, documentatie) tegen de werkelijkheid te kunnen houden.
 */
export const HOSTING_OWNER_OF_RECORD = 'RVH-Speaking';
export const REPOSITORY_NAME = 'stack-dashboard';

/**
 * De eigenaars die deze repository EERDER heeft gedragen, nieuwste eerst.
 *
 * Zij staan hier om twee redenen, en geen van beide is nostalgie. Ten eerste blijft R1 hierdoor
 * spreken over de vorige eigenaar: een operationele verwijzing die bij de overdracht is blijven
 * staan wijst naar een object dat GitHub alleen nog doorverwijst, en dat is een stille fout in
 * plaats van een luide. Ten tweede maakt deze lijst zichtbaar wat er van die eigenaar met opzet is
 * blijven staan — het bewaakte account, `stack-control`, de persoonslogin en het al gepubliceerde
 * bewijsmateriaal — want dat staat dan als gedekte post op de uitzonderingenlijst en niet als
 * onopgemerkte rest in de boom.
 *
 * Dit is GEEN terugvaloptie voor het opbouwen van adressen; daarvoor geldt uitsluitend de afleiding
 * in `lib/repo-identity.mjs`, die alleen bronnen leest die het heden kennen.
 */
export const VORIGE_HOSTING_EIGENAARS = Object.freeze(['rvanhooijdonk-png']);

/** Welke eigenaar een R1-bevinding noemt: de huidige, of eentje die had moeten meeverhuizen. */
export const EIGENAARSKLASSE = Object.freeze({ HUIDIG: 'HUIDIG', ACHTERGEBLEVEN: 'ACHTERGEBLEVEN' });

/** Paden waarin code draait. Alleen hier geldt R1. */
export const OPERATIONELE_PADEN = Object.freeze(['scripts/', 'tools/', '.github/workflows/']);

export const OVERTREDING = Object.freeze({
  OPERATIONELE_EIGENAAR: 'OPERATIONELE_EIGENAAR',
  VEROUDERD_PAGES_ADRES: 'VEROUDERD_PAGES_ADRES',
  VERVALLEN_UITZONDERING: 'VERVALLEN_UITZONDERING',
});

/**
 * GEDOCUMENTEERDE UITZONDERINGEN — de lijst zelf staat als DATA in
 * `CONTROL/AUTOCODING/org-migratie-uitzonderingen.json`, niet als code hier.
 *
 * Twee redenen, en de eerste is de zwaarste. Wie een post toevoegt, VERBREEDT een poort; die
 * handeling hoort onder dezelfde eigenaarsgate te vallen als de rest van `CONTROL/AUTOCODING/`, en
 * niet mee te liften op een gewone codewijziging. De tweede is praktisch: stond de lijst hier, dan
 * zou dit uitvoerende bestand vol namen van de oude eigenaar staan en zou R1 zichzelf moeten
 * uitzonderen — precies het soort uitzondering dat een poort uitholt.
 */
export const UITZONDERINGEN_PAD = 'CONTROL/AUTOCODING/org-migratie-uitzonderingen.json';

export function leesUitzonderingen(root = ROOT) {
  const ruw = JSON.parse(readFileSync(join(root, UITZONDERINGEN_PAD), 'utf8'));
  if (ruw?.schema !== 'ORG_MIGRATIE_UITZONDERINGEN_V1') throw new Error('onbekend uitzonderingenschema');
  const lijst = Array.isArray(ruw.uitzonderingen) ? ruw.uitzonderingen : null;
  if (!lijst) throw new Error('uitzonderingenlijst ontbreekt');
  for (const u of lijst) {
    // Een post zonder reden of zonder categorie is geen documentatie maar een gat.
    const compleet = typeof u?.pad === 'string' && u.pad
      && typeof u?.tekst === 'string' && u.tekst
      && typeof u?.reden === 'string' && u.reden.trim().length >= 20
      && ['ANDER_OBJECT', 'HISTORISCH', 'CONFIGURATIEPUNT'].includes(u?.blijft);
    if (!compleet) throw new Error(`onvolledige uitzondering: ${JSON.stringify(u?.pad ?? null)}`);
  }
  return Object.freeze(lijst.map((u) => Object.freeze({ ...u })));
}

export const UITZONDERINGEN = leesUitzonderingen();

const NAAM = /^[A-Za-z0-9._-]{1,100}$/;

/** Het Pages-adres dat bij vaste tekst in deze boom hoort te staan. */
export function verwachtPagesVoorvoegsel(eigenaar = HOSTING_OWNER_OF_RECORD, repo = REPOSITORY_NAME) {
  if (!NAAM.test(eigenaar) || !NAAM.test(repo)) throw new Error('ongeldige eigenaar of repositorynaam');
  return `https://${eigenaar.toLowerCase()}.github.io/${repo}`;
}

/**
 * Dit bestand valt buiten R1 en dat is een bewuste, enge uitzondering: het is de DECLARATIE van de
 * eigenaarsstand (`HOSTING_OWNER_OF_RECORD`) en draait nergens in de publicatieketen mee. De
 * uitzondering is precies één pad breed; alle andere paden onder `scripts/` blijven onder R1.
 */
export const POORT_MODULE = 'scripts/lib/org-migration.mjs';

/** Paden die INVOER dragen in plaats van een binding: daar geldt R2 niet. Zie de afbakening boven. */
export const NIET_BINDENDE_PADEN = Object.freeze(['test/']);

const isBindend = (pad) => !NIET_BINDENDE_PADEN.some((p) => pad.startsWith(p));

const isOperationeel = (pad) => pad !== POORT_MODULE && OPERATIONELE_PADEN.some((p) => pad.startsWith(p));

/**
 * Hoeveel voorkomens elke uitzonderingstekst voor dit pad mag dekken: precies één per POST op de
 * lijst. Wie twee identieke vermeldingen wil houden, schrijft er twee posten voor op — dan blijft
 * de lijst een eerlijke telling van wat er is toegestaan.
 *
 * De langste teksten eerst. Uitzonderingen kunnen elkaar bevatten (een toelichtingszin die het
 * codefragment citeert); zou de korte tekst eerst worden afgeschreven, dan verbruikte die haar
 * budget binnen de lange zin en bleef het echte codefragment verderop onverwacht onbedekt.
 */
function dekkingsbudget(pad, lijst) {
  const budget = new Map();
  for (const u of [...lijst].filter((x) => x.pad === pad).sort((a, b) => b.tekst.length - a.tekst.length)) {
    budget.set(u.tekst, (budget.get(u.tekst) ?? 0) + 1);
  }
  return budget;
}

/**
 * Verwijdert uit een regel wat het nog beschikbare budget dekt, en schrijft dat verbruik af. Wat
 * overblijft is wat NIET gedekt is.
 *
 * Het budget gaat over het hele BESTAND, niet over één regel: één post dekt één voorkomen. Anders
 * draagt één gedocumenteerde uitzondering een onbeperkt aantal ongedocumenteerde bindingen mee —
 * en dan is de post geen uitzondering meer maar een vrijbrief voor dat bestand.
 */
function zonderGedekt(regel, budget) {
  let rest = regel;
  for (const [tekst, over] of budget) {
    let resterend = over;
    while (resterend > 0 && rest.includes(tekst)) {
      rest = rest.replace(tekst, '');
      resterend -= 1;
    }
    budget.set(tekst, resterend);
  }
  return rest;
}

/** Regex-veilige vorm van een eigenaarsnaam. GitHub-namen dragen `.` en `-`, en die tellen mee. */
const alsPatroon = (tekst) => tekst.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Regels ontleden op één bestand, MÉT de stand van het budget na afloop.
 *
 * Die reststand is geen bijproduct maar het bewijsmateriaal voor R3: alleen hier is te zien welke
 * post werkelijk iets heeft gedekt en welke niets deed. `toetsBestand` geeft daarvan alleen de
 * bevindingen door; `toetsBoom` heeft ook de rest nodig.
 */
function ontleedBestand({ pad, tekst }, {
  eigenaar = HOSTING_OWNER_OF_RECORD, repo = REPOSITORY_NAME, uitzonderingen = UITZONDERINGEN,
  vorigeEigenaars = VORIGE_HOSTING_EIGENAARS,
} = {}) {
  const bevindingen = [];
  const budget = dekkingsbudget(pad, uitzonderingen);
  const pagesPatroon = new RegExp(`https?://([a-z0-9][a-z0-9.-]*)\\.github\\.io/${repo}`, 'gi');
  // HOOFDLETTERONGEVOELIG, en dat is geen netheid maar het gat zelf: GitHub aanvaardt `rvh-speaking`
  // in raw- en API-adressen even goed als `RVH-Speaking`, dus een nieuwe hardcodering wordt eerder
  // in kleine letters getypt dan in de officiële schrijfwijze. Zou R1 alleen de officiële vorm
  // kennen, dan is de poort na de overdracht stil op juist de waarschijnlijkste fout.
  //
  // De vorige eigenaars staan in HETZELFDE patroon en niet in een tweede ronde: één treffer per
  // regel blijft dan één bevinding, precies zoals vóór de overdracht. De langste naam eerst, zodat
  // een eigenaar die de tekst van een andere bevat niet als de kortere wordt gemeld — dan wijst de
  // bevinding naar de verkeerde remedie.
  const gezien = new Set();
  const kandidaten = [eigenaar, ...vorigeEigenaars]
    .filter((naam) => NAAM.test(naam ?? '') && !gezien.has(naam.toLowerCase()) && gezien.add(naam.toLowerCase()))
    .sort((a, b) => b.length - a.length);
  const eigenaarPatroon = new RegExp(`(?:${kandidaten.map(alsPatroon).join('|')})`, 'i');
  const verwachteHost = eigenaar.toLowerCase();

  tekst.split('\n').forEach((regel, i) => {
    const rest = zonderGedekt(regel, budget);
    const treffer = isOperationeel(pad) ? rest.match(eigenaarPatroon) : null;
    if (treffer) {
      // De GEVONDEN schrijfwijze, niet de officiële: wie de bevinding leest hoeft dan niet zelf te
      // gaan zoeken in welke vorm het er staat.
      bevindingen.push({
        code: OVERTREDING.OPERATIONELE_EIGENAAR,
        pad,
        regel: i + 1,
        gevonden: treffer[0],
        // De klasse maakt de bevinding zelf de instructie: bij een HUIDIGE eigenaar moet er een
        // afleiding voor in de plaats komen, bij een ACHTERGEBLEVEN eigenaar is er bij de overdracht
        // iets over het hoofd gezien en wijst deze regel naar een object dat GitHub nog slechts
        // doorverwijst.
        eigenaarsklasse: treffer[0].toLowerCase() === eigenaar.toLowerCase()
          ? EIGENAARSKLASSE.HUIDIG : EIGENAARSKLASSE.ACHTERGEBLEVEN,
      });
    }
    for (const m of (isBindend(pad) ? rest.matchAll(pagesPatroon) : [])) {
      // Hoofdlettergevoelig vergeleken, met opzet. Een host met hoofdletters WERKT (DNS trekt zich
      // van kapitalen niets aan), en juist daarom glipt hij erdoor: `${{ github.repository_owner }}`
      // in een workflow levert `RVH-Speaking.github.io`, wat GitHub zelf nooit uitgeeft. Die vorm
      // hier laten passeren zou precies de naïeve substitutie goedkeuren die deze poort moet
      // wegduwen richting de afleiding in `lib/repo-identity.mjs`.
      if (m[1] !== verwachteHost) {
        bevindingen.push({
          code: OVERTREDING.VEROUDERD_PAGES_ADRES, pad, regel: i + 1, gevonden: m[0], verwacht: verwachtPagesVoorvoegsel(eigenaar, repo),
        });
      }
    }
  });
  return { bevindingen, restbudget: budget };
}

/** Regels ontleden op één bestand. Puur: neemt tekst, geeft bevindingen. */
export function toetsBestand(bestand, opties = {}) {
  return ontleedBestand(bestand, opties).bevindingen;
}

/**
 * De hele boom in één keer, plus R3 over de uitzonderingenlijst zelf.
 *
 * R3 meet VERBRUIK, niet aanwezigheid. Het verschil is niet academisch; het is een gat dat zichzelf
 * dichttrekt zodra je ernaar kijkt. Uitzonderingen mogen elkaar bevatten — een toelichtingszin die
 * het codefragment citeert is een gewoon geval — en `zonderGedekt` schrijft dan eerst de lange post
 * af. Zou R3 daarna alleen tellen of de KORTE tekst ergens in het bestand voorkomt, dan vindt hij
 * hem terug binnen die al opgegeten lange zin en verklaart hij de korte post voor levend, terwijl
 * die in werkelijkheid niets heeft gedekt. Zo'n post is dan onzichtbaar ongebruikt budget: wie later
 * een losse eigenaarsnaam toevoegt, krijgt hem stilzwijgend gedekt en passeert R1 zonder dat er
 * ergens iets rood wordt — precies de sluipweg die deze poort moet uitsluiten.
 *
 * Door de reststand van het budget te lezen, verdwijnt dat: een post die niets heeft afgeschreven is
 * vervallen en wordt aangewezen, of de tekst nu nergens meer staat óf alleen nog binnen een andere
 * uitzondering. Beide gevallen zijn dezelfde ziekte — een lijst die groter is dan het werk dat zij
 * doet — en beide horen bij dezelfde bevindingscode.
 *
 * Dat de telling ook de andere kant op loopt, blijft: twee posten voor één voorkomen laten er één
 * zonder werk achter, en die wordt net zo hard aangewezen.
 */
export function toetsBoom(bestanden, opties = {}) {
  const uitzonderingen = opties.uitzonderingen ?? UITZONDERINGEN;
  const bevindingen = [];
  const rest = new Map();
  for (const b of bestanden) {
    const uitkomst = ontleedBestand(b, { ...opties, uitzonderingen });
    bevindingen.push(...uitkomst.bevindingen);
    // Eén pad kan maar één keer in de boom staan; wie hem tweemaal aanlevert, krijgt de laatste
    // stand. De echte boom komt uit `git ls-files` en levert elk pad precies één keer.
    rest.set(b.pad, uitkomst.restbudget);
  }
  // Een pad dat helemaal niet meer in de boom voorkomt, heeft niets kunnen dekken: dan is het volle
  // budget van die post over. Hetzelfde geval, dezelfde bevinding.
  for (const pad of new Set(uitzonderingen.map((u) => u.pad))) {
    if (!rest.has(pad)) rest.set(pad, dekkingsbudget(pad, uitzonderingen));
  }
  for (const [pad, budget] of rest) {
    for (const [tekst, over] of budget) {
      for (let i = 0; i < over; i += 1) {
        bevindingen.push({ code: OVERTREDING.VERVALLEN_UITZONDERING, pad, gevonden: tekst });
      }
    }
  }
  return bevindingen;
}

/** Enkel de door git bijgehouden bestanden: geen build-uitvoer, geen losse rommel in de werkboom. */
export function gevolgdeBestanden(root = process.cwd()) {
  const namen = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean);
  return namen.flatMap((pad) => {
    let tekst;
    try {
      tekst = readFileSync(`${root}/${pad}`, 'utf8');
    } catch {
      return [];
    }
    return tekst.includes('\0') ? [] : [{ pad, tekst }];
  });
}
