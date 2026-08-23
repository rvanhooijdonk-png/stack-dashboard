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
 *     mag de naam van de huidige eigenaar niet als letterlijke tekst voorkomen, tenzij hij op de
 *     uitzonderingenlijst hieronder staat mét reden. Grond: dit was de vorm waarin het Pages-adres,
 *     het raw-adres en het API-pad de overdracht niet zouden hebben overleefd.
 *
 *  R2 `VEROUDERD_PAGES_ADRES` — buiten `test/` moet elk letterlijk
 *     `https://<host>.github.io/<repo>`-adres bij de HUIDIGE eigenaar horen. Grond: een Pages-adres
 *     van de vorige eigenaar levert na de overdracht een HTTP-fout op, en die fout wordt door de
 *     waarnemer gelezen als "de plaat is niet vers" — niet als "het adres is verhuisd". Dat is
 *     precies een storing die niemand ziet.
 *
 *  R3 `VERVALLEN_UITZONDERING` — elke uitzondering moet in de boom ook echt gevonden worden. Een
 *     lijst met vervallen posten wordt vanzelf een lijst waar alles op mag.
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
export const HOSTING_OWNER_OF_RECORD = 'rvanhooijdonk-png';
export const REPOSITORY_NAME = 'stack-dashboard';

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

/** Alle uitzonderingsteksten voor één pad. */
const uitzonderingenVoor = (pad, lijst) => lijst.filter((u) => u.pad === pad).map((u) => u.tekst);

/**
 * Verwijdert alle gedekte teksten uit een regel. Wat overblijft is wat NIET gedekt is — zo telt één
 * uitzondering nooit als vrijbrief voor een tweede vermelding in dezelfde regel.
 */
function zonderGedekt(regel, teksten) {
  let rest = regel;
  for (const t of teksten) {
    while (rest.includes(t)) rest = rest.replace(t, '');
  }
  return rest;
}

/** Regels ontleden op één bestand. Puur: neemt tekst, geeft bevindingen. */
export function toetsBestand({ pad, tekst }, {
  eigenaar = HOSTING_OWNER_OF_RECORD, repo = REPOSITORY_NAME, uitzonderingen = UITZONDERINGEN,
} = {}) {
  const bevindingen = [];
  const gedekt = uitzonderingenVoor(pad, uitzonderingen);
  const pagesPatroon = new RegExp(`https?://([a-z0-9][a-z0-9.-]*)\\.github\\.io/${repo}`, 'gi');
  const verwachteHost = eigenaar.toLowerCase();

  tekst.split('\n').forEach((regel, i) => {
    const rest = zonderGedekt(regel, gedekt);
    if (isOperationeel(pad) && rest.includes(eigenaar)) {
      bevindingen.push({
        code: OVERTREDING.OPERATIONELE_EIGENAAR, pad, regel: i + 1, gevonden: eigenaar,
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
  return bevindingen;
}

/** De hele boom in één keer, plus R3 over de uitzonderingenlijst zelf. */
export function toetsBoom(bestanden, opties = {}) {
  const uitzonderingen = opties.uitzonderingen ?? UITZONDERINGEN;
  const bevindingen = bestanden.flatMap((b) => toetsBestand(b, { ...opties, uitzonderingen }));
  const perPad = new Map(bestanden.map((b) => [b.pad, b.tekst]));
  for (const u of uitzonderingen) {
    if (!(perPad.get(u.pad) ?? '').includes(u.tekst)) {
      bevindingen.push({ code: OVERTREDING.VERVALLEN_UITZONDERING, pad: u.pad, gevonden: u.tekst });
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
