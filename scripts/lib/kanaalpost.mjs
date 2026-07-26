/**
 * VLOOT-KANAALPOST — het gedeelde doorgeefluik van álle vensters op de plaat.
 *
 * De bron is `data/kanaalpost-publiek.md`: de GESCHOONDE, publieke spiegel die elk venster zelf
 * bijhoudt. Bewust niet het interne `CONTROL/KANAALPOST.md` op de rapporten-branch, waar een eerdere
 * opzet van deze sectie naar keek. Dat interne logboek draagt repo-namen, paden, PR-nummers en
 * bewijsregels; de plaat is OPENBAAR. Eén bron, en het is de bron die al voor publiek geschreven is —
 * schonen bij het lezen is altijd zwakker dan schonen bij het schrijven (batch-opdracht 26-07-2026:
 * "stap over op de spiegel zodra die bestaat, één waarheid").
 *
 * Het bestand staat in deze repo, dus wat de plaat toont hoort per definitie bij de commit die hem
 * publiceerde. Er is geen netwerkronde en geen tweede stand die achter kan lopen.
 *
 * De parser is streng en puur. Streng, want een rij die niet exact vijf velden heeft is geen
 * spiegelrij maar een tabel die er toevallig op lijkt (het spiegelbestand opent zelf met een
 * kolom-uitleg in tabelvorm) — half raden welke cel welk veld is, is erger dan de rij overslaan.
 * Puur, zodat de vorm-eisen zonder bestand of netwerk getest kunnen worden.
 *
 * Fail-closed in drie te onderscheiden eindstanden, want de plaat moet kunnen zeggen wát er mis is:
 * bron onbereikbaar · bron leesbaar maar geen herkende rij (dan is de parser verdacht, niet de
 * vloot) · er wás post maar geen enkele rij kwam door de publicatie-poort.
 */

import { denyTermsMaxLen, sanitizeString } from './sanitize.mjs';

/** De plaat toont het staartstuk van het doorgeefluik: de laatste vijftien rijen, nieuwste boven. */
export const KANAAL_RIJEN = 15;

const MAX_TAB = 40;
/**
 * De spiegelrijen zijn hele alinea's in gewone taal — dat is hun waarde. Afkappen mag daarom pas
 * ruim, en zichtbaar: een afgekapte regel eindigt op `…` zodat niemand een half verhaal voor het
 * hele verhaal houdt.
 */
const MAX_ONDERWERP = 600;
const MAX_STATUS = 60;
const MAX_ACTIE = 80;
const MAX_DATUM = 16;

/**
 * Vensterbreedte voor de publish-poort. `sanitizeString` kapt zelf af boven 2000 tekens en scant
 * dan NIET meer — dus wie een lange regel in één keer aanbiedt, krijgt "oversized" terug en heeft
 * de patronen nooit gezien. Daarom wordt de volledige cel in overlappende vensters gescand: de
 * overlap is ruimer dan het langste deny-patroon, zodat een sleutel op een vensterrand niet tussen
 * twee vensters door glipt.
 */
const VENSTER = 1500;
const OVERLAP = 300;

/**
 * Datum-tijd-cel: kale dagdatum, eventueel gevolgd door HH:MM — en verder niets. Het eind-anker en
 * de uur-/minuutgrenzen zijn geen muggenzifterij: zonder anker matcht `2026-07-25 /pad/naar/iets`
 * gewoon, waarna de parser de rest van de cel weggooit en de rij als geldig doorlaat.
 */
const DATUM = /^(\d{4}-\d{2}-\d{2})(?:\s+([01]?\d|2[0-3]):([0-5]\d))?$/;
/** Een tab-rol is een rollabel, geen zin en geen markup. */
const TAB = /^[A-Za-z0-9 ()._/-]{1,40}$/;
/**
 * Markdown-nadruk weghalen zodat de plaat gewone tekst toont. Bewust NIET `_`: dat zou
 * `SERVICE_TOKEN` tot `SERVICETOKEN` maken en daarmee juist het secret-naam-patroon blind maken.
 */
const kaal = (s) => String(s).replace(/[`*]+/g, '').replace(/\s+/g, ' ').trim();

/** Strikte YYYY-MM-DD-toets: vorm én een echt bestaande datum (geen 2026-13-40). */
function isEchteDatum(v) {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * De kop van de spiegeltabel: eerste kolom `datum-tijd`, tweede `tab-rol`. Pas ná die kop worden er
 * rijen aangenomen. Zonder die poort wordt élke vijfkolomstabel in het bestand als spiegel gelezen,
 * en schuift een andere kolomvolgorde vreemde velden naar `onderwerp`/`status`.
 */
const IS_KOP = (c) => c[0].toLowerCase().startsWith('datum') && c[1].toLowerCase().startsWith('tab');

/**
 * Lees de spiegel: één rij per melding, vijf velden.
 * `| datum-tijd | tab-rol | onderwerp | status | actie voor |`
 */
export function spiegelUitTekst(tekst) {
  const rijen = [];
  let kopGezien = false;
  for (const regel of String(tekst ?? '').split('\n')) {
    const r = regel.trim();
    if (!r.startsWith('|') || !r.endsWith('|')) continue;
    const cellen = r.slice(1, -1).split('|').map((c) => c.trim());
    if (cellen.length !== 5) continue;
    if (cellen.every((c) => /^:?-{3,}:?$/.test(c))) continue; // scheidingsregel
    if (IS_KOP(cellen)) { kopGezien = true; continue; }
    if (!kopGezien) continue;
    const d = DATUM.exec(cellen[0]);
    if (!d || !isEchteDatum(d[1])) continue;
    const tab = kaal(cellen[1]);
    const onderwerp = kaal(cellen[2]);
    if (!TAB.test(tab) || !onderwerp) continue;
    rijen.push({
      tab,
      onderwerp,
      status: kaal(cellen[3]),
      actie: kaal(cellen[4]),
      // Een handgeschreven `9:05` telt mee maar wordt als `09:05` getoond: de kolom moet uitlijnen,
      // en een rij stil laten wegvallen op een ontbrekende nul is te streng.
      datum: d[2] ? `${d[1]} ${d[2].padStart(2, '0')}:${d[3]}` : d[1],
    });
  }
  return rijen;
}

/**
 * Is deze vrije tekst publiceerbaar? Geen bevinding = ja. Bewust een JA/NEE-poort en geen redactie:
 * een spiegelrij met `[REDACTED]` erin is onleesbaar én verhult dat er iets misging bij het venster
 * dat hem schreef. Een verdachte rij wordt ingehouden en geteld.
 *
 * Volgorde is de hele truc: eerst scannen op de VOLLEDIGE tekst, pas daarna cappen. Andersom
 * publiceert de gate de eerste zeshonderd tekens van een regel waarvan het geheim op teken 2500
 * staat — en ziet dat geheim nooit.
 */
export function publishVeilig(tekst) {
  const s = String(tekst ?? '');
  // De overlap moet minstens zo breed zijn als het langste patroon dat over een naad kan vallen.
  // Alle regex-patronen zijn begrensd en ruim onder 300; alleen een deny-term is vrije mensentekst
  // en kan langer zijn — die meet de gate daarom zelf op.
  const overlap = Math.min(Math.max(OVERLAP, denyTermsMaxLen()), VENSTER - 1);
  const stap = VENSTER - overlap;
  for (let i = 0; i === 0 || i < s.length; i += stap) {
    if (sanitizeString(s.slice(i, i + VENSTER)).findings.length > 0) return false;
  }
  return true;
}

/**
 * Reduceer de spiegel tot de publieke plaat-DTO: laatste vijftien rijen, nieuwste boven, elke rij
 * door de publish-poort en daarna gecapt.
 *
 * De volgorde is de BRONVOLGORDE omgedraaid, niet een sortering op de datumkolom. Het bestand is
 * append-only ("nieuwste onderaan", en de kop zegt er expliciet bij dat de volgorde die van het
 * toevoegen is), dus de laatste vijftien regels zijn per afspraak de laatste vijftien meldingen;
 * een venster dat een rij met een oudere tijd aanvult, hoort niet ineens bovenaan te springen.
 */
export function toPublicKanaalpost(raw) {
  const leeg = (reason, ingehouden = 0) => ({ available: false, reason, rows: [], ingehouden });
  if (!raw || raw.available !== true || !Array.isArray(raw.rows)) {
    return leeg(raw?.reason === 'LEEG' ? 'LEEG' : 'BRON_ONBEREIKBAAR');
  }
  const cap = (v, max) => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s) return null;
    return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
  };
  const rows = [];
  let ingehouden = 0;
  for (const r of raw.rows.slice(-KANAAL_RIJEN).reverse()) {
    if (![r?.tab, r?.onderwerp, r?.status, r?.actie].every(publishVeilig)) {
      ingehouden += 1;
      continue;
    }
    rows.push({
      tab: cap(r?.tab, MAX_TAB),
      onderwerp: cap(r?.onderwerp, MAX_ONDERWERP),
      status: cap(r?.status, MAX_STATUS),
      actie: cap(r?.actie, MAX_ACTIE),
      datum: cap(r?.datum, MAX_DATUM),
    });
  }
  if (!rows.length) return leeg(ingehouden ? 'INGEHOUDEN' : 'LEEG', ingehouden);
  return { available: true, reason: null, rows, ingehouden };
}

/**
 * Lees de spiegel uit tekst naar de collector-vorm. Gescheiden van het lezen van het BESTAND, zodat
 * de vorm-eisen zonder schijf getest kunnen worden.
 */
export function kanaalpostUitTekst(tekst) {
  if (typeof tekst !== 'string' || tekst.trim() === '') {
    return { available: false, reason: 'BRON_ONBEREIKBAAR', rows: [] };
  }
  const rows = spiegelUitTekst(tekst);
  if (!rows.length) return { available: false, reason: 'LEEG', rows: [] };
  return { available: true, reason: null, rows };
}
