/**
 * NA-PUBLICATIE-CONTROLE — staat wat er net gebouwd is ook écht live?
 *
 * De waarnemer (`lib/waarnemer.mjs`) toetst of de pagina die een bezoeker ophaalt klopt. Eén gat bleef
 * daarin open, en dat gat heb ik zelf als beslispunt voorgelegd: een publicatie die net klaar meldde,
 * kan nog minuten lang niet zichtbaar zijn. De waarnemer die direct na de bouw kijkt ziet dan de
 * VORIGE plaat en meldt onterecht rood; de waarnemer die pas een uur later kijkt merkt een mislukte
 * uitrol een uur niet op.
 *
 * Besluit Fable (26-07-2026): niet één keer wachten en niet op het uur vertrouwen, maar HERHAALD
 * NAVRAGEN — elke 30 seconden, maximaal 8 minuten. Wordt de stempel vers, dan groen en meteen stoppen.
 * Verstrijkt de deadline zonder verse stempel, dan ROOD.
 *
 * En de regel die deze module vooral moet waarmaken: **nooit "onbekend"**. Een controle die geen
 * uitspraak deed is rood, niet groen — ook als de job werd overgeslagen of de run geannuleerd. Dat is
 * geen detail: "onbekend, dus maar door" is precies hoe een bewaker stilletjes ophoudt te bewaken.
 * `jobUitkomstKleur` is daarom expliciet een allowlist van één waarde, en `versheidEindstand` kent
 * twee kleuren en geen derde.
 *
 * WAT DEZE CONTROLE (NOG) NIET DOET: er komt geen regel in de publieke spiegel. De waarnemer doet dat
 * wel, en heeft dat met een sabotagetest bewezen; deze controle heeft dat bewijs nog niet. Grond:
 * bewijs vóór claim (besluit Fable). Zie `SPIEGELALARM_AAN`.
 *
 * EERLIJKE KANTTEKENING BIJ DE 8 MINUTEN. In deze repo is gemeten (24-07-2026, vastgelegd in
 * `publish.yml` en in `waarnemer.mjs`) dat GitHub Pages/Fastly de query-string niet als cachesleutel
 * gebruikt: een ophaal kan een CDN-kopie van ongeveer tien minuten oud teruggeven. Een uitrol die
 * technisch klopt kan daardoor binnen 8 minuten onzichtbaar blijven, en dan is het rood onterecht.
 * Dat is de belangrijkste reden dat het publieke alarm hier uit staat tot tien schone ronden: eerst
 * meten hoe vaak dat in de praktijk gebeurt, dan pas alarmeren.
 */

import { stempelUitHtml } from './waarnemer.mjs';

const MIN = 60 * 1000;

/** Het ritme uit het besluit. Niet configureerbaar via de omgeving: het is een afspraak, geen knop. */
export const POLL_MS = 30 * 1000;
export const DEADLINE_MS = 8 * MIN;
/** Hoeveel ronden er hoogstens in het venster passen — voor de logregel en de lusgrens. */
export const MAX_RONDEN = Math.floor(DEADLINE_MS / POLL_MS);

/**
 * Speling op "vers". De stempel wordt TIJDENS de bouw gezet — na het uitchecken, de tests en het
 * verzamelen — dus hij hoort altijd ná het startmoment van de publicatie te liggen. Er is dus geen
 * inhoudelijke reden voor speling. Eerst stond hier 90 seconden. Codex én Gemini wezen onafhankelijk
 * op hetzelfde gat: die 90 seconden legitimeren juist de stempel van de VORIGE bouw. Een publicatie
 * die kort op de vorige volgt zou dan meteen groen melden zonder ooit live te zijn gegaan. Nu NUL: de
 * stempel moet op of na het startmoment liggen. De constante blijft bestaan zodat een toekomstige
 * reden om speling toe te staan expliciet moet worden opgeschreven in plaats van stil ingeslopen.
 */
export const VERSHEID_MARGE_MS = 0;
/**
 * Een stempel die verder dan dit in de toekomst ligt, is geen bewijs maar een klok- of paginafout.
 * Ook krap: 5 minuten (de eerste versie) accepteerde een pagina die beweert bijna vijf minuten in de
 * toekomst gebouwd te zijn, en dat is geen fail-closed (review Codex, 26-07-2026).
 */
export const KLOKSPELING_MS = 60 * 1000;

/**
 * Het publieke alarm van DEZE controle staat uit. Aanzetten mag pas als de controle tien
 * opeenvolgende ronden heeft gedraaid zonder onterecht rood. Te tellen zonder iemand op zijn woord
 * te geloven:
 *
 *   gh run list --workflow napublicatie.yml --event workflow_run --limit 20 \
 *     --json conclusion,createdAt,displayTitle
 *
 * Het filter `--event workflow_run` hoort erbij: alleen de ECHTE ronden na een publicatie tellen. De
 * workflow weigert de test- en sabotageschakelaars bij dat event, dus tien versnelde of gesaboteerde
 * runs kunnen deze telling niet vervuilen (bevinding Codex, 26-07-2026).
 *
 * Tien opeenvolgende `success` (of een rood dat aantoonbaar een echte storing was) = bewijs. Dan pas
 * deze vlag om, samen met de append-stap in de workflow. Rood in de bouw doet het nu al.
 */
export const SPIEGELALARM_AAN = false;

export const CODES = {
  VERSE_STEMPEL: 'de plaat toont een stempel van na de publicatie, dus de uitrol staat live',
  DEADLINE_ZONDER_VERSE_STEMPEL: 'de publicatie meldde klaar, maar de plaat toonde binnen het venster geen verse stempel',
  GEEN_UITSPRAAK: 'de controle na de publicatie heeft geen enkele meting gedaan',
  LUS_AFGEBROKEN: 'de controle na de publicatie is gestopt voordat de deadline verstreek',
  PAGINA_ONBEREIKBAAR: 'de pagina was niet op te halen',
  GEEN_STEMPEL: 'de pagina had geen leesbare bouwstempel',
  STEMPEL_IN_TOEKOMST: 'de bouwstempel ligt in de toekomst',
  STEMPEL_NOG_OUD: 'de pagina toont nog de stempel van vóór deze publicatie',
};

/**
 * Hoe een job-uitkomst gelezen wordt. Allowlist van precies één waarde; al het andere is rood.
 * `skipped`, `cancelled`, een leeg veld (job nooit gedraaid) en een onbekende nieuwe GitHub-status
 * vallen daar automatisch onder — de veilige kant is hier de enige kant.
 */
export function jobUitkomstKleur(resultaat) {
  return resultaat === 'success' ? 'groen' : 'rood';
}

/**
 * Eén ronde: wat zegt deze ophaal? Geen uitzonderingen, alleen uitkomsten — een netwerkfout is een
 * ronde die "nog niet vers" zegt, want de volgende ronde kan alsnog lukken.
 */
export function versheidRonde({ paginaStatus, paginaHtml, referentieMs, nu }) {
  const nietVers = (code) => ({ vers: false, code, stempelIso: null, uitleg: CODES[code] });
  if (paginaStatus !== 200) return nietVers('PAGINA_ONBEREIKBAAR');

  const stempel = stempelUitHtml(paginaHtml);
  if (!stempel.gevonden || stempel.iso === null) return nietVers('GEEN_STEMPEL');

  const stempelMs = Date.parse(stempel.iso);
  if (!Number.isFinite(stempelMs)) return nietVers('GEEN_STEMPEL');
  if (stempelMs > nu + KLOKSPELING_MS) {
    return { vers: false, code: 'STEMPEL_IN_TOEKOMST', stempelIso: stempel.iso, uitleg: CODES.STEMPEL_IN_TOEKOMST };
  }
  if (stempelMs < referentieMs - VERSHEID_MARGE_MS) {
    return { vers: false, code: 'STEMPEL_NOG_OUD', stempelIso: stempel.iso, uitleg: CODES.STEMPEL_NOG_OUD };
  }
  return { vers: true, code: 'VERSE_STEMPEL', stempelIso: stempel.iso, uitleg: CODES.VERSE_STEMPEL };
}

/**
 * De eindstand van de lus. Twee kleuren, geen derde. De volgorde is bewust:
 *  - nul ronden gedaan → rood, want er is niets gemeten;
 *  - vers → groen;
 *  - deadline verstreken → rood;
 *  - anders → rood, want de lus is dan om een andere reden gestopt (afgebroken proces, annulering)
 *    en dat is per besluit geen groen.
 */
export function versheidEindstand({ vers, verstrekenMs, rondes, deadlineMs = DEADLINE_MS }) {
  const rood = (code) => ({ kleur: 'rood', code, uitleg: CODES[code] });
  if (!Number.isFinite(rondes) || rondes < 1) return rood('GEEN_UITSPRAAK');
  if (vers === true) return { kleur: 'groen', code: 'VERSE_STEMPEL', uitleg: CODES.VERSE_STEMPEL };
  // `deadlineMs` moet meekomen: de zelftest verkort het venster, en met de vaste 8 minuten hier zou
  // die test `LUS_AFGEBROKEN` melden i.p.v. de deadline-uitkomst die hij hoort te bewijzen — dan
  // toont de acceptatietest niet het pad dat in productie loopt (review Codex, 26-07-2026).
  const venster = Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : DEADLINE_MS;
  if (Number.isFinite(verstrekenMs) && verstrekenMs >= venster) return rood('DEADLINE_ZONDER_VERSE_STEMPEL');
  return rood('LUS_AFGEBROKEN');
}
