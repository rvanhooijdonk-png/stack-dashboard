/**
 * FOUTPAGINA (noodpagina) — de enige bron van waarheid voor wat er live komt te staan als de build
 * afbreekt. Stond eerder als heredoc ín publish.yml en werd daardoor door niets getest: een bewerking
 * die de marker sloopte, brondata injecteerde of de pagina leegde zou stil publiceren. Nu één bestand,
 * met een inhoudstest (test/failure-page.test.mjs) én gebruikt door de workflow (`node scripts/failure-page.mjs`).
 *
 * Ontwerpeisen (bewust, komen terug als test-asserts):
 *  - GEEN enkele brondata: de foutpagina toont nooit een (oude, groene) stand — dat is het hele punt.
 *    Welke CI-stap faalde en met welke fout is GEEN brondata (geen dashboard-inhoud) — dat mag wél.
 *  - Een herkenbare, unieke marker in de titel + kop, zodat verify de pagina kan ONDERSCHEIDEN van de
 *    GitHub-Pages-404 ("There isn't a GitHub Pages site here") en van een oude datastand.
 *  - meta-refresh 900s (de browser herlaadt; dat start geen build) + robots noindex,nofollow.
 *
 * OPDRACHT/DE-PLAAT-MELDT-MAAR-ZEGT-NIET-WAT (2026-07-28): de oude tekst somde drie mogelijke
 * oorzaken op ("een test, de sanitize-gate of de secretsscan") terwijl de CI altijd al weet welke
 * stap het was. `failurePageHtml(info)` accepteert nu optioneel `{ step, detail }` — gemeten in
 * publish.yml zelf (`steps.<id>.outcome`), nooit geraden. Zonder `info` (of zonder bruikbare
 * `step`) blijft de oude, generieke tekst het fallback-gedrag — dat mag nooit stilzwijgend leeg
 * lijken.
 */

import { fileURLToPath } from 'node:url';

/** Unieke, machine-toetsbare marker. Verify grept hierop om noodpagina ≠ GitHub-404 ≠ oude stand te bewijzen. */
export const FAILURE_MARKER = 'stack-dashboard: geen actuele stand (build afgebroken)';

/** De GitHub-Pages-404-signatuur waar de noodpagina NOOIT op mag lijken (verify faalt hard hierop). */
export const GITHUB_404_SIGNATURE = "There isn't a GitHub Pages site here";

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * De gemeten oorzaak als mensentaal, of de oude generieke drie-mogelijkheden-tekst als er niets
 * bruikbaars gemeten is. `info.step` is verplicht om van de specifieke tekst gebruik te maken —
 * zonder stapnaam is er niets concreets te noemen, en blijft de eerlijke fallback staan.
 */
function oorzaakTekst(info) {
  if (!info || !info.step) {
    return 'De generator is afgebroken: een test, de sanitize-gate of de secretsscan gaf een fout.';
  }
  const detail = info.detail ? `: ${escapeHtml(info.detail)}` : '.';
  return `De stap <strong>${escapeHtml(info.step)}</strong> is afgebroken${detail}`;
}

/**
 * De volledige, datavrije foutpagina als string. Puur — geen I/O, geen dashboard-brondata.
 * `info` (optioneel): `{ step, detail }` — welke CI-stap faalde en de gemeten foutlocatie/-tekst.
 */
export function failurePageHtml(info = null) {
  return `<!doctype html>
<html lang="nl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="900">
<meta name="robots" content="noindex,nofollow">
<meta name="x-stack-dashboard" content="${FAILURE_MARKER}">
<title>Stack-dashboard — build gefaald</title>
<style>body{margin:0;background:#0f1115;color:#e6e8ec;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.w{max-width:640px;margin:0 auto;padding:64px 20px}h1{font-size:22px}p{color:#9aa3b2}</style>
</head><body><div class="w">
<h1>Geen actuele stand beschikbaar</h1>
<p>${oorzaakTekst(info)}
Er wordt met opzet géén oudere stand getoond — een verouderde groene pagina is misleidender
dan deze melding.</p>
<p>Een nieuwe build start bij een push naar main, bij een handmatige run, of bij een geplande
run (05:45/15:45 UTC) — op die laatste kun je hier niet vertrouwen. Deze melding verdwijnt pas nadat
build én publicatie slagen. De browser herlaadt deze pagina wel periodiek, maar dat start geen build.</p>
</div></body></html>
`;
}

/**
 * Classificeer wat een URL SERVEERT, zodat verify hard kan onderscheiden:
 *  - 'noodpagina'  → onze bedoelde foutpagina staat live (marker aanwezig).
 *  - 'github-404'  → GitHub-Pages serveert zijn eigen 404 (de route bestaat niet / nooit gepubliceerd)
 *                    — dít is de stille gat-toestand die verify hard moet afvangen.
 *  - 'anders'      → iets anders (bv. een oudere datastand die de CDN nog cachet) — geen fout, CDN-lag.
 * Eén bron van waarheid: zowel de CI-stap (`--classify`) als de test roepen deze functie aan.
 */
export function classifyServedPage(body) {
  const s = typeof body === 'string' ? body : '';
  if (s.includes(FAILURE_MARKER)) return 'noodpagina';
  if (s.includes(GITHUB_404_SIGNATURE)) return 'github-404';
  return 'anders';
}

// CLI. Zonder argument: schrijf de foutpagina naar stdout (de workflow pipet 'm naar
// public/index.html). Met `--classify`: lees een geserveerde body van stdin en schrijf de
// classificatie naar stdout (de verify-failure-stap gebruikt dit; exitcode blijft 0, de stap
// beslist zelf wat een harde fout is). Eén taak per modus.
// fileURLToPath i.p.v. handmatige `file://`-concatenatie: platformonafhankelijk (slash/drive-letter),
// en het idioom dat de rest van de repo ook gebruikt (Gemini-review).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--classify')) {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      process.stdout.write(classifyServedPage(Buffer.concat(chunks).toString('utf8')));
    });
  } else {
    const info = process.env.FAILURE_STEP
      ? { step: process.env.FAILURE_STEP, detail: process.env.FAILURE_DETAIL || '' }
      : null;
    process.stdout.write(failurePageHtml(info));
  }
}
