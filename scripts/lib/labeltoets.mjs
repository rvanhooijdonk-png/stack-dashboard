/**
 * LABELTOETS — de krant-toets op vrije tekst uit de bouwlijst-feed.
 *
 * Waarom deze poort bestaat. `sanitize.mjs` is *fail-on-known-pattern*: het herkent sleutels,
 * mailadressen, paden en IP's. Het herkent GEEN betekenis. Een klantnaam, een persoonsnaam, een
 * verhuisdatum of een medisch onderwerp matcht geen enkel patroon en zou dus ongehinderd op een
 * OPENBARE pagina belanden. De bouwlijst-feed is precies zo'n bron: honderden vrij ingetypte regels
 * uit privé-materiaal. Publiceren is onomkeerbaar, dus er hoort een tweede poort onder — deze.
 *
 * De toets is een VOLLEDIGE ALLOWLIST, geen zwarte lijst. Elk woord van een label moet in
 * `woorden_toegestaan` staan; één onbekend woord houdt het hele label tegen. Dát is de kern: de
 * poort hoeft de nieuwe klant-, merk- of persoonsnaam niet te KENNEN om hem tegen te houden.
 *
 * De eerste versie (26-07-2026) toetste alleen woorden mét een hoofdletter tegen de allowlist.
 * Codex en Gemini vonden onafhankelijk van elkaar hetzelfde gat: élke kleingeschreven onbekende
 * naam liep zo vrij door, en met `'Naam`, `3Naam` of een Cyrillische letter was ook de
 * hoofdletterregel triviaal te omzeilen. Beide adviseerden hetzelfde: allowlist alle woorden.
 * Deze versie doet dat, plus de bijbehorende voorpoorten:
 *
 *  1. NORMALISATIE (NFKC) en het weghalen van onzichtbare tekens. Zonder dat is een `verhuizing`
 *     met een zero-width space er middenin een ander woord dan `verhuizing`.
 *  2. TEKENSET. Alleen Latijnse letters, cijfers en een vaste set leestekens. Alles daarbuiten —
 *     Cyrillisch, Grieks, CJK, emoji, valutatekens — laat het label zakken. Dat sluit de hele
 *     homogliefen-familie in één keer, en een label dat in een ander schrift is geschreven kan
 *     hier per definitie niet beoordeeld worden.
 *  3. VERWIJZING. Links, @-handles en `iets.iets`-vormen: verwijzingen naar derden horen niet op
 *     de plaat. Breed getoetst, niet op een lijstje TLD's.
 *  4. GETALLEN. Vier cijfers in één label — geteld over het hele label, niet per reeks — is een
 *     jaartal, bedrag, telefoonnummer of rekeningnummer. Geen bouwlabel heeft die nodig.
 *  5. ONDERWERPEN. Prefix-match op `woorden_geblokkeerd` — privé, gezondheid, wonen, geld,
 *     klanten, handelsposities, beveiligingshouding.
 *  6. ALLOWLIST. Elk woord, ongeacht hoofdletters. Eén-letterwoorden staan er niet in: met losse
 *     letters is elke naam te spellen (`T-I-M`), dus een los teken is per definitie onbeoordeeld.
 *
 * **In het databestand staat geen namenlijst, ook niet gehasht.** `data/label-poort.json` ligt in
 * een OPENBARE repo. Ongezouten hashes van korte namen zijn te raden en bevestigen dan precies wat
 * je wilde verbergen (review Codex). Onder een volledige allowlist is zo'n lijst ook overbodig:
 * onbekend is onbekend.
 *
 * **De reden bevat nooit de aanleiding.** `toetsLabel` geeft alleen een categorie terug, nooit het
 * woord dat de toets liet zakken — anders lekt de afgekeurde naam alsnog via een logregel.
 *
 * Ontbreekt, hapert of spreekt het poortbestand zichzelf tegen, dan zakt ALLES. Een lege plaat met
 * een melding is de goede uitkomst; een plaat die publiceert omdat de poort niet kon laden, is de
 * verkeerde.
 *
 * Wat deze poort NIET kan: betekenis wegen. Een label waarvan elk woord gewoon is, maar dat als
 * geheel iets zegt wat niet naar buiten hoort, komt er door. De enige echte grens is een vooraf
 * beoordeelde catalogus van publieke labels (advies Codex, 26-07-2026); deze poort is de
 * verdediging zolang die er niet is.
 */

import { readFileSync } from 'node:fs';

const POORT_PAD = new URL('../../data/label-poort.json', import.meta.url);

/** Onzichtbaar spul: stuurtekens, soft hyphen, zero-width, bidi-marks, BOM. Weg vóór elke toets. */
const ONZICHTBAAR = /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]/g;
/**
 * Alleen dit mag in een publiceerbaar label staan: Latijnse letters, cijfers en een vaste set
 * leestekens/symbolen die in bouwlabels voorkomen (`code`, A → B, ×2). Geen enkel ander schrift —
 * dat sluit de homogliefen-familie in één keer. Bewust NIET toegestaan:
 *  - valutatekens (bedragen),
 *  - de PUNT en de APESTAART: zonder punt bestaat er geen domeinvorm meer, ook niet met spaties
 *    eromheen (`voorbeeld .nl`, `info @ voorbeeld .com`) — de regex hieronder ving die niet
 *    (bevinding Gemini, her-review 26-07-2026). Kosten: 2 van 693 labels,
 *  - `<`, `>`, `\` en `|`: die horen niet in een naam en schelen een laag boven `esc()` in de render.
 */
const TOEGESTANE_TEKENS = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9 ,:;!?'"()[\]{}/&+*%_=~^#§`→←↔⇒≠≤≥×±°•-]*$/;
/** Woorden zijn letterreeksen. Cijfers scheiden dus óók: `3Naam` levert het woord `Naam` op. */
const WOORD = /[A-Za-zÀ-ÖØ-öø-ÿ]+/g;
/**
 * Links, handles en domeinvormen — breed, niet op een lijstje TLD's. Eén teken vóór de punt is
 * genoeg (`d.nl` is net zo goed een domein) en accenten tellen mee (review Codex, 26-07-2026).
 */
const VERWIJZING = /:\/\/|www\.|@[A-Za-z0-9À-ÖØ-öø-ÿ]|[A-Za-z0-9À-ÖØ-öø-ÿ-]\.[A-Za-zÀ-ÖØ-öø-ÿ]{2,}/;
/** Elk cijfer telt mee, niet alleen aaneengesloten reeksen. */
const CIJFER = /\d/g;
/**
 * Vier cijfers in een label is een jaartal, bedrag, telefoon- of rekeningnummer. Op de TOTAAL-telling,
 * niet op een aaneengesloten reeks: `06-123-456-78` en `250 000` zijn anders zo weer heel
 * (review Codex, 26-07-2026). Geen enkel bouwlabel heeft vier cijfers nodig (gemeten: 0 van 693).
 */
const MAX_CIJFERS = 3;

/** Minimale omvang van een geloofwaardig poortbestand; daaronder is het geen poort. */
const MIN_TOEGESTAAN = 50;
const MIN_GEBLOKKEERD = 20;

let poort = null;

/** NFKC + onzichtbare tekens eruit. Zonder dit zijn `slaap` en `sl<zero-width>aap` twee woorden. */
export function normaliseer(label) {
  return String(label ?? '')
    .normalize('NFKC')
    .replace(ONZICHTBAAR, '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, '-');
}

/**
 * Laad de poortgegevens. Zonder argument: het meegeleverde bestand. Faalt het laden, is het bestand
 * te mager, óf spreekt het zichzelf tegen (een toegestaan woord dat op een geblokkeerd onderwerp
 * begint), dan blijft `geladen` false — en dan zakt élk label (zie `toetsLabel`).
 */
export function laadLabelPoort(pad = POORT_PAD) {
  const leeg = { geladen: false, toegestaan: new Set(), geblokkeerd: [] };
  try {
    const raw = JSON.parse(readFileSync(pad, 'utf8'));
    const lijst = (v) =>
      (Array.isArray(v) ? v : [])
        .filter((t) => typeof t === 'string' && t.trim() !== '')
        .map((t) => normaliseer(t).trim().toLowerCase());
    const toegestaan = lijst(raw.woorden_toegestaan);
    const geblokkeerd = lijst(raw.woorden_geblokkeerd);
    // Te mager = geen poort: een lege of bijna lege allowlist zou stap 6 zinloos maken.
    if (toegestaan.length < MIN_TOEGESTAAN || geblokkeerd.length < MIN_GEBLOKKEERD) {
      poort = leeg;
      return poort;
    }
    // Tegenstrijdig bestand: liever een lege plaat met een melding dan een poort waarvan de twee
    // lijsten elkaar tegenspreken en niemand weet welke wint.
    if (toegestaan.some((w) => geblokkeerd.some((b) => w.startsWith(b)))) {
      poort = leeg;
      return poort;
    }
    poort = { geladen: true, toegestaan: new Set(toegestaan), geblokkeerd };
  } catch {
    poort = leeg;
  }
  return poort;
}

const huidige = () => poort ?? laadLabelPoort();

/** Alleen voor tests: vergeet de geladen poort, zodat de volgende toets opnieuw laadt. */
export function resetLabelPoort() {
  poort = null;
}

/** Splits een genormaliseerd label in woorden. Cijfers en leestekens zijn scheiders. */
export function woordenVan(label) {
  return normaliseer(label).match(WOORD) ?? [];
}

/**
 * Toets één label. Geeft `{ ok, reden }`; `reden` is een categorie, nooit de aanleiding zelf.
 */
export function toetsLabel(label) {
  const p = huidige();
  if (!p.geladen) return { ok: false, reden: 'poort-onbeschikbaar' };

  const tekst = normaliseer(label);
  if (tekst.trim() === '') return { ok: false, reden: 'leeg' };
  if (!TOEGESTANE_TEKENS.test(tekst)) return { ok: false, reden: 'teken' };
  if (VERWIJZING.test(tekst)) return { ok: false, reden: 'verwijzing' };
  if ((tekst.match(CIJFER) ?? []).length > MAX_CIJFERS) return { ok: false, reden: 'getal' };

  const woorden = tekst.match(WOORD) ?? [];
  // Een "label" zonder één woord is geen leesbare naam; wat er dan wél staat, is niet beoordeeld.
  if (woorden.length === 0) return { ok: false, reden: 'leeg' };

  for (const woord of woorden) {
    const laag = woord.toLowerCase();
    for (const blok of p.geblokkeerd) {
      if (laag.startsWith(blok)) return { ok: false, reden: 'onderwerp' };
    }
    if (!p.toegestaan.has(laag)) return { ok: false, reden: 'onbekend' };
  }
  return { ok: true, reden: null };
}
