/**
 * SPIEGELWET — de publieke spiegel is APPEND-ONLY, en dat wordt niet meer op discipline vertrouwd.
 *
 * Waarom dit bestaat. Op 26-07-2026 heeft de waarnemer tijdens zijn eigen acceptatietest een
 * GEBLOKKEERD-regel in `data/kanaalpost-publiek.md` gezet, en heb IK die regel daarna weggehaald bij
 * het opruimen (commit 211faaf, één regel `-`). Dat is precies de fout die de append-only-regel moet
 * voorkomen: het logboek is geen werkbestand maar een verslag, en een verslag waaruit de vervelende
 * regel verdwijnt is geen verslag meer. De regel is inmiddels teruggezet met een correctie eronder;
 * deze module zorgt dat de volgende keer niet van oplettendheid afhangt.
 *
 * DE WET, in twee lagen — en de eerste versie hiervan had er maar één, ten onrechte.
 *
 * Laag 1, HARD: geen enkele regel die er stond mag verdwijnen. Dat is de belofte die het logboek een
 * verslag maakt, en precies de belofte die ik brak.
 *
 * Laag 2, ZACHT: nieuwe regels horen erachter, niet ertussen. Dit is geen rode kaart, want er is een
 * legitiem geval waarin de volgorde wél schuift: twee takken die elk een regel aanvullen. Wordt main
 * in zo'n tak samengevoegd, dan staat de eigen regel ná die van main terwijl hij er eerst vóór stond.
 * Een harde prefix-eis maakt zulke takken onverenigbaar en zou de bewaker vooral vals laten piepen —
 * en een bewaker die vals piept wordt uitgezet (bevinding Codex, 26-07-2026). Ordeverstoring wordt
 * dus gemeld, niet bestraft.
 */

const regels = (tekst) => String(tekst ?? '').replace(/\n+$/, '').split('\n');
const isLeeg = (r) => r.length === 0 || (r.length === 1 && r[0] === '');

/**
 * Vergelijk twee versies van de spiegel.
 *
 * `{ ok, verdwenen, opOrde, eerste }` — `ok` is de harde wet (niets verdwenen), `verdwenen` is het
 * aantal regels dat niet meer voorkomt, `opOrde` zegt of de oude tekst nog letterlijk vooraan staat,
 * `eerste` is het 1-gebaseerde regelnummer waar de volgorde voor het eerst afwijkt (of null).
 *
 * Regels worden vergeleken op INHOUD, met hun aantal: twee identieke regels mogen niet stilletjes één
 * worden. Bewust GEEN inhoud in de uitkomst: dit oordeel belandt in een logregel.
 */
export function alleenAangevuld(oud, nieuw) {
  const a = regels(oud);
  const b = regels(nieuw);
  const oudeRegels = isLeeg(a) ? [] : a;
  const nieuweRegels = isLeeg(b) ? [] : b;

  // Tellen, niet alleen bestaan: verdwijnt één van twee gelijke regels, dan is er toch een regel weg.
  const telling = new Map();
  for (const r of nieuweRegels) telling.set(r, (telling.get(r) ?? 0) + 1);
  let verdwenen = 0;
  for (const r of oudeRegels) {
    const n = telling.get(r) ?? 0;
    if (n === 0) verdwenen += 1;
    else telling.set(r, n - 1);
  }

  let eerste = null;
  for (let i = 0; i < oudeRegels.length; i += 1) {
    if (nieuweRegels[i] !== oudeRegels[i]) { eerste = i + 1; break; }
  }
  return { ok: verdwenen === 0, verdwenen, opOrde: eerste === null, eerste };
}
