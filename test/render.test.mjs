import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderHtml, esc } from '../scripts/lib/render.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(join(ROOT, 'data/fixture.json'), 'utf8'));

test('zonder nav-argument is de uitvoer byte-identiek aan de vaste plaat vóór de multi-pagina-bouwstap', () => {
  // renderHtml() kreeg een optionele `nav`-opt zodat build.mjs een terug-naar-cockpit-link kan
  // injecteren op de Contentstroom-pagina. Bestaande call-sites geven dat argument niet mee, en
  // voor hen mag er niets veranderen — geen leeg blok, geen extra witregel.
  const html = renderHtml(fixture);
  assert.equal(html.includes('<div class="wrap">\n<header>'), true);
  assert.equal(html.includes('<nav'), false);
});

test('rendert een volledige pagina met verversing en tijdstempel', () => {
  const html = renderHtml(fixture, { refreshSeconds: 900 });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<meta http-equiv="refresh" content="900; url=\.\/\?v=\d+">/);
  assert.match(html, /Laatst bijgewerkt/);
  // Hoofdweergave in NL-tijd (fixture is 12:00Z in juli = 14:00 CEST), met UTC tussen haakjes.
  // Vorm: alleen het tijdstip, geen datum (mandaat 25-07, HH:MM (NL-tijd) met UTC tussen haakjes).
  assert.match(html, /Laatst bijgewerkt: <strong>gebouwd om 14:00 NL-tijd \(12:00 UTC\)<\/strong>/);
});

// --- Tijdstempel in Richards tijd (Europe/Amsterdam, DST-correct) ---

test('de stempel toont NL-tijd als hoofdweergave met UTC tussen haakjes', () => {
  const zomer = structuredClone(fixture);
  zomer.generatedAt = '2026-07-25T12:30:00.000Z'; // CEST = UTC+2
  assert.match(renderHtml(zomer), /gebouwd om 14:30 NL-tijd \(12:30 UTC\)/);
});

test('de NL-omzetting klopt in de winter (CET = UTC+1)', () => {
  const winter = structuredClone(fixture);
  winter.generatedAt = '2026-01-15T12:00:00.000Z';
  assert.match(renderHtml(winter), /gebouwd om 13:00 NL-tijd \(12:00 UTC\)/);
});

test('de DST-overgang wordt correct verwerkt, niet met een vaste offset', () => {
  // De klok springt in NL van winter- naar zomertijd op de laatste zondag van maart om 02:00 lokaal.
  // Een vaste +1 zou hierna een uur mis zitten; de expliciete Europe/Amsterdam-zone vangt het.
  // De sprong is zichtbaar in het tijdstip zelf: 00:30Z → 01:30 (CET), 01:30Z → 03:30 (CEST).
  const voorSprong = structuredClone(fixture);
  voorSprong.generatedAt = '2026-03-29T00:30:00.000Z'; // nog CET → 01:30
  assert.match(renderHtml(voorSprong), /gebouwd om 01:30 NL-tijd \(00:30 UTC\)/);
  const naSprong = structuredClone(fixture);
  naSprong.generatedAt = '2026-03-29T01:30:00.000Z'; // klok is 02→03 gesprongen → 03:30 CEST
  assert.match(renderHtml(naSprong), /gebouwd om 03:30 NL-tijd \(01:30 UTC\)/);
});

test('de DST-overgang in de herfst (terugval) wordt correct verwerkt', () => {
  // Laatste zondag oktober: de klok valt om 03:00 lokaal terug naar 02:00. Het uur 02:00–03:00 komt
  // dus twee keer voor. Omdat de input een eenduidige UTC-instant is, blijft elk moment ondubbelzinnig:
  // 00:30Z is nog CEST (02:30), 01:30Z is al CET (óók 02:30) — beide NL 02:30, verschillende UTC.
  const voorTerugval = structuredClone(fixture);
  voorTerugval.generatedAt = '2026-10-25T00:30:00.000Z';
  assert.match(renderHtml(voorTerugval), /gebouwd om 02:30 NL-tijd \(00:30 UTC\)/);
  const naTerugval = structuredClone(fixture);
  naTerugval.generatedAt = '2026-10-25T01:30:00.000Z';
  assert.match(renderHtml(naTerugval), /gebouwd om 02:30 NL-tijd \(01:30 UTC\)/);
});

test('de stempel hangt niet van de runner-locale of -timezone af', () => {
  // Zelfde moment, of de runner nu in UTC of elders staat: de expliciete timeZone dwingt NL af.
  // 22:45Z valt in NL al ná middernacht (00:45), terwijl UTC nog 22:45 toont — de omzetting is echt,
  // geen kale string-knip van de ISO-tijd.
  const s = structuredClone(fixture);
  s.generatedAt = '2026-07-25T22:45:00.000Z';
  assert.match(renderHtml(s), /gebouwd om 00:45 NL-tijd \(22:45 UTC\)/);
});

test('de tabtitel toont dezelfde NL-tijd, niet kale UTC', () => {
  // De titel is de tweede plek waar de versheid gelezen wordt (tabbalk, bladwijzer, zoekgeschiedenis).
  // Stond die op kale UTC, dan las een verse plaat daar alsnog als twee uur oud.
  const s = structuredClone(fixture);
  s.generatedAt = '2026-07-25T19:53:00.000Z';
  const html = renderHtml(s);
  assert.match(html, /<title>Stack-dashboard — 21:53 NL-tijd \(19:53 UTC\)<\/title>/);
  assert.doesNotMatch(html, /<title>[^<]*2026-07-25 19:53 UTC<\/title>/);
});

test('een ontbrekend bouwmoment breekt de titel niet', () => {
  // Eerder deed de titel `s.generatedAt.slice(...)` rechtstreeks: zonder bouwmoment was dat een throw
  // midden in de render. Nu valt hij, net als de kop, terug op een streepje.
  const s = structuredClone(fixture);
  s.generatedAt = null;
  assert.match(renderHtml(s), /<title>Stack-dashboard — —<\/title>/);
});

test('toont een onbereikbare bron als zodanig, niet als groen', () => {
  const html = renderHtml(fixture);
  assert.match(html, /bron onbereikbaar/);
  assert.match(html, /Een onbereikbare bron toont hier nooit een oude groene stand/);
});

test('haalt geen externe bronnen op en draait geen script', () => {
  const html = renderHtml(fixture);
  assert.equal(/<script/i.test(html), false, 'geen script-tags');
  assert.equal(/https?:\/\/(?!github\.com)/i.test(html.replace(/<style>[\s\S]*?<\/style>/, '')), false,
    'geen externe hosts buiten github.com-bronverwijzingen');
  assert.equal(/(src|href)=["']https?:/i.test(html), false, 'geen externe assets');
});

test('escapet HTML uit bronnen', () => {
  const evil = structuredClone(fixture);
  evil.tracker.updates[0].title = '<img src=x onerror=alert(1)>';
  const html = renderHtml(evil);
  assert.equal(html.includes('<img src=x'), false);
  assert.match(html, /&lt;img src=x/);
});

test('esc dekt alle vijf de tekens', () => {
  assert.equal(esc(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
});

test('rendert de roadmapsectie met de workstreams', () => {
  const html = renderHtml(fixture);
  assert.match(html, /Roadmap — 19 workstreams/);
  assert.match(html, /Voorbeeldworkstream/);
});

test('rendert alle CI-ampeltoestanden zonder te breken', () => {
  const html = renderHtml(fixture);
  assert.match(html, /dot ok/);
  assert.match(html, /geen CI/);
});

// --- Bevindingen uit de dubbele review van 23-07-2026 (Codex + Gemini) ---

test('een "getal" dat stiekem HTML is, komt er niet in — bewezen probe van Codex', () => {
  const evil = structuredClone(fixture);
  evil.pullRequests.repositories[0].open = '</td><script>alert(1)</script><td>';
  evil.pullRequests.totals.open = '</p><script>alert(2)</script><p>';
  const html = renderHtml(evil);
  assert.equal(/<script/i.test(html), false, 'numerieke velden moeten door num() gaan');
});

test('refreshSeconds kan geen meta-tag-injectie worden', () => {
  const html = renderHtml(fixture, { refreshSeconds: '0; url=javascript:alert(1)' });
  assert.equal(html.includes('javascript:'), false);
  // De refresh wordt teruggeklampt op de veilige integer + onze eigen same-origin cache-buster;
  // de meegegeven `url=javascript:` haalt het nooit tot in de tag.
  assert.match(html, /<meta http-equiv="refresh" content="900; url=\.\/\?v=\d+">/);
});

test('de zelf-refresh draagt een per-build cache-buster zodat de browser vers trekt', () => {
  // GitHub Pages serveert met max-age=600 en die header kunnen wij niet zetten; zonder buster kan
  // de browser bij de meta-refresh zijn eigen `./`-kopie blijven serveren. Door de refresh naar
  // ./?v=<stempel> te sturen krijgt elke publicatie een eigen URL — same-origin, alleen cijfers.
  const html = renderHtml(fixture, { refreshSeconds: 900 });
  const verwacht = String(fixture.generatedAt).replace(/[^0-9]/g, '');
  assert.match(html, new RegExp(`<meta http-equiv="refresh" content="900; url=\\./\\?v=${verwacht}">`));
  // Een andere publicatie ⇒ een andere URL ⇒ geen oude cache-kopie kan blijven hangen.
  const later = structuredClone(fixture);
  later.generatedAt = '2099-01-02T03:04:05.678Z';
  const htmlLater = renderHtml(later);
  assert.match(htmlLater, /url=\.\/\?v=20990102030405678"/);
  assert.equal(htmlLater.includes(`v=${verwacht}"`), false, 'de buster verandert mee met de stempel');
});

test('draagt een restrictieve CSP', () => {
  const html = renderHtml(fixture);
  assert.match(html, /content-security-policy/i);
  assert.match(html, /default-src 'none'/);
});

test('een oude stempel wordt eerlijk geduid: déze kopie is oud, niet per se "niets gepubliceerd"', () => {
  // Stond hier eerst als "ouder dan een uur = build stuk", daarna als "er is sindsdien niets
  // gepubliceerd". Beide zijn gemeten onwaar: de query-cachebuster busts de Fastly-CDN niet
  // (zelfde x-github-request-id over verschillende ?v=-waarden, gemeten 24-07-2026), dus een verse
  // publicatie kan tot ~10 min door browser/CDN-cache verborgen blijven. De pagina claimt daarom
  // niet langer dat een oude stempel betekent dat er niets is gepubliceerd.
  const html = renderHtml(fixture);
  assert.match(html, /déze pagina-kopie oud is/i);
  assert.match(html, /niet per se dat er niets is gepubliceerd/i);
  assert.equal(/er is sindsdien niets gepubliceerd/i.test(html), false);
});

test('de pagina belooft geen verversingsinterval dat we niet waarmaken', () => {
  // De stempelregel mag zeggen dat de bróuwser opnieuw ophaalt — dat doet de meta-refresh echt.
  // Ze mag niet suggereren dat de dáta elk kwartier ververst, want dat hangt aan een scheduler
  // die hier niet betrouwbaar draait. De lijst met verboden formuleringen staat in
  // data/verboden-beloftes.json en wordt in publiekepaginas.test.mjs op béide publieke pagina's
  // toegepast; hier staat alleen wat deze pagina in de plaats zegt.
  const html = renderHtml(fixture);
  assert.match(html, /niet op een gegarandeerd interval/i);
  assert.match(html, /bij elke push naar main en bij een handmatige run/i);
});

test('meldt verborgen repo\'s in plaats van ze bij naam te noemen', () => {
  const html = renderHtml(fixture);
  assert.match(html, /2 PR's staan in repo's die niet bij naam getoond worden/);
});

// --- Bevindingen uit de tweede dubbele review van 23-07-2026 (Codex + Gemini) ---

test('zegt zichtbaar dát de titels ingehouden zijn — geen stille leegte', () => {
  const html = renderHtml(fixture);
  assert.match(html, /Titels worden hier niet getoond/);
  assert.match(html, /de structuur — nummers, ID's, datums en aantallen/);
});

test('een ingehouden titel wordt een streepje, geen "null"', () => {
  const html = renderHtml(fixture);
  assert.equal(/>\s*null\s*</.test(html), false, 'null mag nooit als tekst op de pagina staan');
});

// --- v2.1 (24-07-2026): tracks-blok (klaar-rapport-leeftijd) + categoriechips ---

test('het tracks-blok toont leeftijd en telling, en "geen rapport" als eerlijke leegte', () => {
  const html = renderHtml(fixture);
  assert.match(html, /Tracks — leeftijd laatste klaar-rapport/);
  assert.match(html, /VOORBEELD/);
  assert.match(html, /ZONDER-RAPPORT/);
  // De track zonder rapport toont geen groen en geen datum, maar een expliciete leegte.
  assert.match(html, /geen rapport/);
});

test('rendert het afgeleide categorielabel als chip, ook bij ingehouden tekst', () => {
  const html = renderHtml(fixture);
  // fixture: beslispunt-categorie 'merge-beleid', besluit-categorie 'security'.
  assert.match(html, /tag cat">merge-beleid</);
  assert.match(html, /tag cat">security</);
});

test('een categorielabel wordt geëscaped als tekst, nooit als markup uitgevoerd', () => {
  const evil = structuredClone(fixture);
  evil.decisions.entries[0].category = '<b>x</b>';
  const html = renderHtml(evil);
  assert.equal(html.includes('<b>x</b>'), false);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
});

// --- Vlootstand: leegstand wordt zichtbaar --------------------------------------------------
//
// De blinde vlek die dit blok dicht: de kanaalpost toont AFRONDINGEN, dus een venster dat niets
// meldt kwam er per definitie niet in voor. "Welke tab staat stil?" was daardoor alleen te
// beantwoorden door zelf alle tabs af te lopen. Deze proeven bewaken dat de plaat die vraag
// beantwoordt zonder ooit stilte als groen te tonen.

test('de plaat toont een regel per venster, met de drie standen en de gebruikte grens', () => {
  const html = renderHtml(fixture);
  assert.match(html, /id="vlootstand"/);
  assert.match(html, /Vlootstand — wie werkt, wie staat leeg/);
  assert.match(html, /1 werkt · 1 leeg · 1 onbekend/, 'de kop is de ene regel die Richard leest');
  assert.match(html, /240<\/strong> minuten/, 'een stand zonder zijn drempel is een mening');
  for (const venster of ['DASHBOARD', 'CONTROL', 'MARKT']) assert.match(html, new RegExp(`>${venster}<`));
});

test('een venster dat nooit meldde staat ONBEKEND op de plaat, niet stil groen', () => {
  const s = structuredClone(fixture);
  s.vlootstand.vensters = [{ venster: 'MARKT', rol: null, toestand: 'ONBEKEND', laatste: null, stilMinuten: null }];
  s.vlootstand.telling = { werkt: 0, leeg: 0, onbekend: 1 };
  const html = renderHtml(s);
  assert.match(html, /nooit gemeld/);
  assert.match(html, /dot bad"><\/span>ONBEKEND/, 'ONBEKEND krijgt de rode stip, niet de groene');
  assert.doesNotMatch(html, /dot ok"><\/span>WERKT/);
});

test('zonder leesbare stand toont de sectie waaróm ze leeg is, in plaats van een lege tabel', () => {
  const s = structuredClone(fixture);
  s.vlootstand = { available: false, reason: 'BRON_ONBEREIKBAAR', grensMinuten: 240, vensters: [], telling: { werkt: 0, leeg: 0, onbekend: 0 } };
  const html = renderHtml(s);
  assert.match(html, /geen bron is geen stand/);
  assert.doesNotMatch(html, /<th>venster<\/th>/, 'geen tabelkop zonder tabel');
});

test('de rol wordt ge-escaped als hij er staat — de plaat is publiek', () => {
  const s = structuredClone(fixture);
  s.vlootstand.vensters[0].rol = 'a<b>c';
  assert.match(renderHtml(s), /a&lt;b&gt;c/);
});

// --- Gedeelde weergave (O1, BOUWLIJST bouwvolgorde stap 4) ----------------------------------
//
// De kop moet zichtbaar zeggen dat dit de gedeelde/online tegenhanger is van het lokale
// STACK-COCKPIT-bestand, en de pagina moet uitleggen wat DEMO-maskering hier concreet betekent
// (uitsluiting bij de bron, geen patroonherkenning) en wat er bewust NIET in staat (bewijslinks,
// modelbord) — anders belooft de pagina meer dan de sanitize-gate waarmaakt.

test('de kop noemt zichtbaar "gedeelde weergave"', () => {
  const html = renderHtml(fixture);
  assert.match(html, /<h1>Stack-dashboard <small class="gedeeld">— gedeelde weergave<\/small><\/h1>/);
});

test('de pagina legt DEMO-maskering eerlijk uit: uitsluiting bij de bron, geen patroonraad', () => {
  const html = renderHtml(fixture);
  assert.match(html, /In deze gedeelde weergave betekent <strong>DEMO-maskering<\/strong>/);
  assert.match(html, /nooit in de publieke data worden opgenomen/);
  assert.match(html, /geen patroon dat ze moet raden/);
});

test('DEMO-maskering wordt niet als instelbare modus/schakelaar gepresenteerd', () => {
  // Codex-bevinding op de diff: "staat hier standaard AAN" suggereert een modus die uit kán staan.
  // Het is geen schakelaar — namen worden nooit verzameld, dus er is niets om aan of uit te zetten.
  const html = renderHtml(fixture);
  assert.doesNotMatch(html, /DEMO-maskering staat hier standaard AAN/);
});

test('de pagina benoemt expliciet wat hier NIET in staat t.o.v. het lokale cockpit-bestand', () => {
  const html = renderHtml(fixture);
  assert.match(html, /bewijslinks per regel/);
  assert.match(html, /model-\/kanalenbord/);
  assert.match(html, /tik-logs op een lokale machine/);
});

test('de publieke disclosure bindt zich niet aan een persoonsnaam', () => {
  // Codex-bevinding: "op Richards machine" bindt een publieke tekst onnodig aan een persoon.
  const html = renderHtml(fixture);
  assert.doesNotMatch(html, /Richards machine/);
});
