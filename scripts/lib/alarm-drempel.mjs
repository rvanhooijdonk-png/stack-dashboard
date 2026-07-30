/**
 * ALARM-DREMPEL — hoeveel keer mag hetzelfde rode oordeel mailen.
 *
 * Bevinding 28-07-2026 (Richard, order ALARM-DAT-ELKE-RUN-MAILT): de doorstroom-workflow gaf bij
 * elk ROOD-oordeel `exit 1`, en GitHub mailt bij élke gefaalde run. Eén aanhoudende oorzaak
 * genereerde zo tientallen identieke mails, en dat traint de ontvanger om ze weg te klikken — de
 * eenentwintigste mail over iets ANDERS gaat dan verloren in dezelfde reflex. Dezelfde klasse fout
 * als `scripts/lib/waarnemer.mjs`'s `magAppenden`, hier toegepast op GitHub issue-commentaren in
 * plaats van spiegelrijen: functioneel identiek patroon, ander opslagmedium.
 *
 * Vergelijkt tegen ALLE meldingen binnen het venster, niet alleen de laatste — anders maken twee
 * afwisselende storingen elkaar om beurten "nieuw" en schrijft het alarm zich alsnog vol.
 *
 * Codex-bevinding 2 (28-07-2026, review vóór commit): de echte `reden`-waarden uit
 * `scripts/doorstroom.mjs`/`scripts/lib/doorstroom.mjs` zijn niet allemaal vaste woorden — sommige
 * dragen vrije tekst of een dynamische teller na een `": "` (`RIJEN_WEGGEVALLEN: tracker 3/10`,
 * `BRON_ZONDER_RIJENTELLING: X, Y`) of een dynamisch regelnummer achteraan (`SPIEGEL_ONLEESBAAR/
 * GEEN_TABEL@42`). De oude `codeWoord` liet die vluchtige delen intact, dus twee runs met DEZELFDE
 * structurele fout maar een andere teller/regelnummer/lijst kregen nooit dezelfde code — de
 * ontdubbeling matchte dan gewoonweg nooit. En het hele oorzaakcode werd als één string vergeleken:
 * gedeeltelijk herstel (`a,b` → alleen nog `a`) telde daardoor als een geheel NIEUWE oorzaak i.p.v.
 * "voor de helft nog bekend". Twee fixes: `stabielDeel` saneert vluchtige delen vóór opname in de
 * code, en `magMelden` vergelijkt nu per losse deel-oorzaak i.p.v. de hele kommagescheiden string.
 */

const UUR = 3600 * 1000;

/** Zolang dit venster loopt, meldt hetzelfde oorzaakcode-alarm zich niet opnieuw. */
export const HERHAAL_UREN = 12;

/** Eén los deel (een woord, geen hele code) — agressief genormaliseerd, geen `_`/`-`-onderscheid meer. */
const codeDeel = (deel) => String(deel).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Strip vluchtige inhoud uit een `reden` vóór opname in het oorzaakcode: alles na een `": "`
 * (vrije tekst/dynamische teller/lijst) en een trailing `@<cijfers>` (dynamisch regelnummer).
 * Samengestelde, met `/` gescheiden codes (`SPIEGEL_ONLEESBAAR/GEEN_TABEL@42`) blijven intact op
 * de structurele delen — alleen het regelnummer erachter is vluchtig.
 */
export const stabielDeel = (reden) => String(reden).replace(/:\s+.*$/, '').replace(/@\d+$/, '');

/**
 * Deel een oorzaakcode-string op in zijn losse, genormaliseerde deel-oorzaken. Zowel het
 * kommagescheiden `oorzaakCode`-formaat als een los woord komen hier binnen.
 */
const naarDelenSet = (code) => new Set(
  String(code ?? '').split(',').map(codeDeel).filter(Boolean),
);

/**
 * Stabiel oorzaakcode uit het oordeel van de uitvoerder. Alleen niet-groene deeloordelen tellen
 * mee, gesorteerd en ontdubbeld zodat volgorde in het object er niet toe doet.
 */
export function oorzaakCode(oordeel) {
  if (!oordeel || typeof oordeel !== 'object') return 'uitvoerder-gefaald';
  const delen = [];
  const voeg = (naam, blok) => {
    if (!blok) return;
    const uitkomst = blok.uitkomst ?? (blok.ok === false ? 'ROOD' : null);
    if (uitkomst && uitkomst !== 'GROEN') {
      const reden = blok.reden ? stabielDeel(blok.reden) : uitkomst;
      delen.push(codeDeel(`${naam}-${reden}`));
    }
  };
  voeg('bron', oordeel.bron?.ok === false ? { uitkomst: 'ROOD', reden: oordeel.bron.reden } : null);
  voeg('kanaalpost', oordeel.kanaalpost);
  voeg('achterstand', oordeel.achterstand);
  voeg('stempel', oordeel.stempel);
  voeg('bronrijen', oordeel.bronRijen);
  return delen.length ? [...new Set(delen)].sort().join(',') : 'onbekend';
}

/** Leest het oorzaakcode-merkteken terug uit een eerder geplaatste alarmtekst. */
export function oorzaakCodeUitTekst(tekst) {
  const m = String(tekst ?? '').match(/oorzaakcode:\s*([a-z0-9,-]+)/);
  return m ? m[1] : null;
}

/**
 * Mag dit oorzaakcode gemeld worden? `eerdereMeldingen` is een lijst van { code, momentMs } —
 * al geparste voorgaande alarmteksten, oud naar nieuw of ongesorteerd, maakt niet uit.
 *
 * Vergelijkt per LOSSE deel-oorzaak, niet de hele string: "mag" is alleen true als de huidige
 * code minstens één deel-oorzaak draagt die in GEEN van de meldingen binnen het venster voorkwam.
 * Zo blijft `a,b` → `a` (gedeeltelijk herstel) herkend als "nog steeds (deels) bekend", en blijft
 * `a` → `a,c` (een NIEUWE tweede oorzaak naast de oude) wél een reden om te melden.
 */
export function magMelden(eerdereMeldingen, code, nu, vensterMs = HERHAAL_UREN * UUR) {
  const doelDelen = naarDelenSet(code);
  const lijst = Array.isArray(eerdereMeldingen) ? eerdereMeldingen : [];
  const binnenVenster = lijst.filter((m) => {
    if (!m || typeof m.momentMs !== 'number' || !Number.isFinite(m.momentMs)) return false;
    const ouderdom = Number(nu) - m.momentMs;
    return ouderdom >= 0 && ouderdom <= vensterMs;
  });
  if (!binnenVenster.length) {
    return { mag: true, reden: 'geen eerdere melding binnen het herhaalvenster' };
  }
  const bekendeDelen = new Set();
  for (const m of binnenVenster) {
    for (const deel of naarDelenSet(m.code)) bekendeDelen.add(deel);
  }
  const nieuweDelen = [...doelDelen].filter((deel) => !bekendeDelen.has(deel));
  if (!nieuweDelen.length) {
    return { mag: false, reden: 'dezelfde oorzaak is al gemeld binnen het herhaalvenster' };
  }
  return { mag: true, reden: `nieuwe deel-oorzaak binnen het venster: ${nieuweDelen.join(', ')}` };
}
