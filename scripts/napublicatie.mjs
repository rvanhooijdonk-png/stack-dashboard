#!/usr/bin/env node
/**
 * NA-PUBLICATIE-CONTROLE (uitvoerder) — vraagt de live plaat herhaald na tot de stempel vers is.
 *
 * Ritme uit het besluit van Fable: elke 30 seconden, maximaal 8 minuten. Vers → groen en meteen
 * stoppen. Deadline verstreken → rood. Nooit "onbekend": kan deze controle geen uitspraak doen — geen
 * referentiemoment, geen enkele meting gedaan, halverwege afgebroken — dan is dat rood.
 *
 * Deze laag doet alleen ophalen en wachten; het oordeel staat in `lib/napublicatie.mjs`, en deze
 * controle schrijft NIETS naar de publieke spiegel (zie `SPIEGELALARM_AAN` daar).
 *
 * Aanroep:
 *   REFERENTIE=<ISO> node scripts/napublicatie.mjs
 *   ZELFTEST=1 ...            → zelfde logica, 60× korter wachten (bewijs van de keten, niet van de tijd)
 *   SABOTAGE=napublicatie ... → zet het referentiemoment een uur vooruit, zodat geen stempel vers kan
 *                               zijn; bewijst dat de deadline echt rood oplevert
 */

import { appendFileSync } from 'node:fs';
import {
  versheidRonde, versheidEindstand, POLL_MS, DEADLINE_MS, MAX_RONDEN, SPIEGELALARM_AAN,
} from './lib/napublicatie.mjs';
import { zelfRouteUitUrl } from './lib/waarnemer.mjs';
import { detectIdentity, pagesUrl } from './lib/repo-identity.mjs';

// Zelfde afleiding als in `waarnemer.mjs` en `doorstroom.mjs`: het adres volgt de eigenaar van deze
// repository en overleeft daarmee een organisatieoverdracht.
const BASE_URL = process.env.BASE_URL || pagesUrl(detectIdentity());
const SABOTAGE = process.env.SABOTAGE || 'geen';
const PAGINA_ROUTE = zelfRouteUitUrl(BASE_URL);
// Alleen de WACHTTIJD wordt korter, niet de logica: zelfde rondes, zelfde beslissingen. Een groene
// zelftest bewijst dus de keten, niet dat 8 minuten genoeg is — dat staat er ook zo in het log.
const SNELHEID = process.env.ZELFTEST === '1' ? 60 : 1;
const pollMs = POLL_MS / SNELHEID;
const deadlineMs = DEADLINE_MS / SNELHEID;

const slaap = (ms) => new Promise((r) => { setTimeout(r, ms); });

const uitvoer = (sleutel, waarde) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${sleutel}=${waarde}\n`);
};

/** Eén ophaal. Een fout is een uitkomst, geen uitzondering; de URL komt nooit in een melding terug. */
async function haal(url) {
  const scheiding = url.includes('?') ? '&' : '?';
  try {
    const r = await fetch(`${url}${scheiding}cb=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
      signal: AbortSignal.timeout(20000),
    });
    return { status: r.status, tekst: await r.text() };
  } catch {
    return { status: 0, tekst: '' };
  }
}

const referentieRuw = process.env.REFERENTIE ?? '';
let referentieMs = Date.parse(referentieRuw);
if (!Number.isFinite(referentieMs)) {
  // Geen referentiemoment = niet te beoordelen. Dat is per besluit rood, niet "dan maar overslaan".
  const eind = versheidEindstand({ vers: false, verstrekenMs: 0, rondes: 0 });
  console.log(`na-publicatie: geen bruikbaar referentiemoment meegekregen (${referentieRuw === '' ? 'leeg' : 'onleesbaar'}).`);
  console.log(`::error::${eind.uitleg} — ${eind.code}`);
  uitvoer('kleur', eind.kleur);
  uitvoer('code', eind.code);
  process.exit(1);
}
if (SABOTAGE === 'napublicatie') {
  referentieMs += 3600 * 1000;
  console.log('SABOTAGE: referentiemoment een uur vooruit gezet — geen enkele stempel kan nu vers zijn.');
}

console.log(`na-publicatie-controle — referentie ${new Date(referentieMs).toISOString()}, elke ${
  Math.round(pollMs / 1000)}s, hoogstens ${Math.round(deadlineMs / 1000)}s${SNELHEID > 1 ? ' (ZELFTEST: 60× versneld)' : ''}`);

const start = Date.now();
let rondes = 0;
let vers = false;
let laatste = null;

// do/while: er wordt ALTIJD minstens één keer gemeten. Een lus die nul ronden doet zou een eindstand
// zonder meting opleveren, en dat is precies de "onbekend" die hier niet mag bestaan.
do {
  const pagina = await haal(BASE_URL);
  const r = versheidRonde({
    paginaStatus: pagina.status, paginaHtml: pagina.tekst, paginaRoute: PAGINA_ROUTE,
    referentieMs, nu: Date.now(),
  });
  rondes += 1;
  laatste = r;
  const verstreken = Math.round((Date.now() - start) / 1000);
  console.log(`ronde ${rondes}/${MAX_RONDEN} (${verstreken}s): ${r.code} — stempel ${r.stempelIso ?? 'onbekend'}`);
  if (r.vers) { vers = true; break; }
  const rest = deadlineMs - (Date.now() - start);
  if (rest <= 0) break;
  await slaap(Math.min(pollMs, rest));
} while (Date.now() - start < deadlineMs);

const eind = versheidEindstand({ vers, verstrekenMs: Date.now() - start, rondes, deadlineMs });
uitvoer('kleur', eind.kleur);
uitvoer('code', eind.code);
uitvoer('rondes', String(rondes));

if (eind.kleur === 'groen') {
  console.log(`✓ ${eind.uitleg} (na ${rondes} ronde(n), stempel ${laatste?.stempelIso ?? 'onbekend'}).`);
  process.exit(0);
}
console.log(`laatste meting: ${laatste?.code ?? 'geen'}`);
if (!SPIEGELALARM_AAN) {
  console.log('publiek alarm staat uit voor deze controle: rood in de bouw, nog geen regel in de spiegel.');
}
console.log(`::error::${eind.uitleg} (${eind.code}, ${rondes} ronde(n)).`);
process.exit(1);
