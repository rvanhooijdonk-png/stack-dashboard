import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderHtml } from '../scripts/lib/render.mjs';
import { renderCockpit, renderProducts, renderTicker } from '../scripts/lib/render-cockpit.mjs';
import { renderTransactieTicker, renderCodeTicker } from '../scripts/lib/render-tickers.mjs';
import { PUBLISH_ALLOWLIST } from '../scripts/lib/publish-files.mjs';
import { failurePageHtml } from '../scripts/failure-page.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(join(ROOT, 'data/fixture.json'), 'utf8'));
const verboden = JSON.parse(await readFile(join(ROOT, 'data/verboden-beloftes.json'), 'utf8'));
const publish = await readFile(join(ROOT, '.github/workflows/publish.yml'), 'utf8');

// Er gaan twee verschillende HTML-pagina's naar buiten: de gewone, en de foutpagina die de
// workflow schrijft als de build afbreekt. De tweede werd hier eerst niet getest, en juist dáár
// stond de belofte nog dat de pagina "het elk kwartier opnieuw probeert en vanzelf herstelt" — op
// precies het moment dat een lezer op betrouwbaarheid moet kunnen rekenen (Codex-review). De
// foutpagina staat nu in één getest bestand (scripts/failure-page.mjs) i.p.v. een heredoc; beide
// paden lopen nog steeds langs dezelfde verboden-belofte-lijst.
const foutpagina = () => failurePageHtml();

const paginas = [
  ['de cockpit (index.html)', () => renderCockpit(fixture)],
  ['de contentstroom-pagina (voorheen de gewone pagina)', () => renderHtml(fixture)],
  ['de foutpagina (scripts/failure-page.mjs)', foutpagina],
];

test('publish.yml genereert de foutpagina uit het geteste bestand (geen losse heredoc-kopie)', () => {
  // Bewaakt de koppeling CI ↔ bron: zou iemand teruggaan naar een inline heredoc, dan test deze
  // suite de ene pagina terwijl de workflow een andere publiceert. Dat mag niet stil kunnen.
  assert.match(publish, /node scripts\/failure-page\.mjs > public\/index\.html/,
    'de failure-page-job hoort de noodpagina uit scripts/failure-page.mjs te genereren');
});

test('beide publicatiepaden gebruiken de immutable Node 24 Pages-artifactactie', () => {
  // v4.0.0 trok intern upload-artifact v4.6.2 binnen en gaf daardoor op iedere
  // Pages-run een Node 20-deprecation. De officiële v5.0.0-release gebruikt
  // upload-artifact v7. Bewaak zowel de immutable release-SHA als beide paden:
  // de gewone build en de datavrije failure-page mogen niet uiteenlopen.
  const pin = 'actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0';
  assert.equal(publish.split(pin).length - 1, 2,
    'build en failure-page horen exact dezelfde officiële v5.0.0-pin te gebruiken');
  assert.doesNotMatch(publish,
    /actions\/upload-pages-artifact@7b1f4a764d45c48632c6b24a0339c27f5614fb0b/,
    'de Node 20-v4-pin mag niet terugkomen');
});

test('de Pages-deploy gebruikt de immutable officiële Node 24-actie', () => {
  // deploy-pages v4.0.5 richt zich op Node 20 en gaf na de artifactupgrade nog
  // de laatste deprecation-annotatie. v5.0.0 verklaart zelf `using: node24`.
  assert.match(publish,
    /actions\/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128 # v5\.0\.0/,
    'de deployjob hoort de officiële immutable v5.0.0-pin te gebruiken');
  assert.doesNotMatch(publish,
    /actions\/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e/,
    'de Node 20-v4.0.5-pin mag niet terugkomen');
});

// De patronen zijn letterlijke formuleringen, geen regexen. Zonder escapen zou een punt of
// haakje in een later toegevoegde zin stilletjes iets anders gaan betekenen dan bedoeld.
const letterlijk = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

for (const [naam, maak] of paginas) {
  test(`${naam} belooft geen verversing die we niet waarmaken`, () => {
    const html = maak();
    for (const patroon of verboden.patronen) {
      assert.equal(letterlijk(patroon).test(html), false,
        `${naam} bevat de verboden belofte "${patroon}" — zie data/verboden-beloftes.json`);
    }
  });
}

test('de lijst met verboden beloftes is niet stilletjes uitgekleed', () => {
  // Zonder dit is de bewaking hierboven uit te zetten met een lege array — of, subtieler, door
  // een patroon door onzin te vervangen — zonder dat een test rood wordt. Alle vier de gemeten
  // formuleringen staan hier daarom met naam en toenaam.
  const verplicht = [
    'ververst automatisch',
    'elk kwartier opnieuw',
    'probeert het elk kwartier',
    'herstelt vanzelf',
  ];
  for (const patroon of verplicht) {
    assert.ok(verboden.patronen.includes(patroon), `"${patroon}" hoort in data/verboden-beloftes.json te staan`);
  }
});

test('beide pagina\'s zeggen wél wat er dan wel gebeurt', () => {
  assert.match(renderHtml(fixture), /bij elke push naar main en bij een handmatige run/i);
  const fout = foutpagina();
  assert.match(fout, /push\s+naar\s+main,\s+bij\s+een\s+handmatige\s+run,\s+of\s+bij\s+een\s+geplande/i);
  // De foutpagina mag de geplande run noemen — hij bestáát — maar moet er in dezelfde adem bij
  // zeggen dat je er niet op kunt rekenen. Codex' punt: onbetrouwbaar is niet hetzelfde als
  // afwezig, en "geen geplande run" zou net zo onwaar zijn als de belofte die we net weghaalden.
  assert.match(fout, /kun je hier niet vertrouwen/i);
  // Whitespace-tolerant per woordgrens: dit toetst de inhoud, niet waar de regelafbreking van de
  // heredoc toevallig valt — een herformattering van de <p> mag deze bewaking niet stil breken.
  assert.match(fout, /pas nadat\s+build\s+én\s+publicatie\s+slagen/i);
});

// ── het bronstand-merk in de kop ────────────────────────────────────────────────
// Elke snapshot-pagina zegt in haar kop waar ze op rust: hoeveel van de bronnen achter de plaat
// geverifieerd zijn. Dat merk wordt op één plek gezet (render.mjs) en op twee plekken in een kop
// gemonteerd: renderHtml heeft zijn eigen kop, de drie cockpit-routes delen `page()`. Zonder deze
// test kan het uit die gedeelde kop verdwijnen zonder dat iets rood wordt.
//
// Het merk wordt NIET meer beoordeeld door de waakvlam — die leest `status.json`, het
// machineleesbare bestand naast de pagina (zie de statusbestand-toets onderaan). Vier reviewrondes
// lang zat de meting in dit merk en vier keer vond de review daar hetzelfde soort gat: een
// zelfgeschreven scanner is geen HTML5-parser. Het merk blijft staan als eerlijke mededeling aan
// wie de pagina zélf bekijkt, en wordt hier gelezen als kale tekst — geen tweede parser erbij.
// De vier SNAPSHOT-routes: de pagina's die op de dashboard-snapshot rusten en dus een bronstand
// hébben. De twee ticker-pagina's staan óók in de publicatielijst maar renderen een eigen feed
// zonder `sources`; zij krijgen bewust geen merk (bevinding Codex P4: "elke gepubliceerde pagina"
// was een te brede claim). De test hieronder maakt die beperktere invariant hard, zodat een
// zevende route niet ongeclassificeerd langs de bewaking kan glippen.

/** Het merk zoals render.mjs het letterlijk schrijft — producent en test zitten aan elkaar vast. */
const merkVan = (snapshot) => `<meta name="bronstand" content="bewezen=${
  snapshot.sources.filter((s) => s.trust === 'VERIFIED_CURRENT').length} totaal=${snapshot.sources.length}">`;

const alleRoutes = [
  ['index.html (cockpit)', () => renderCockpit(fixture)],
  ['contentstroom.html', () => renderHtml(fixture)],
  ['producten.html', () => renderProducts(fixture, { products: [] })],
  ['stack-ticker.html', () => renderTicker(fixture, { freshness: 'UNKNOWN', events: [] })],
];

for (const [naam, maak] of alleRoutes) {
  test(`${naam} draagt het bronstand-merk leesbaar in de kop`, () => {
    const html = maak();
    const kop = html.slice(0, html.indexOf('</head>'));
    assert.equal(kop.includes(merkVan(fixture)), true,
      `${naam} draagt geen ${merkVan(fixture)} vóór </head> — de pagina zegt dan niet waar ze op rust`);
    // Precies één, en niet in de body: twee merken met verschillende getallen is geen mededeling
    // maar een raadsel, en een merk in de body suggereert een tweede meting die er niet is.
    assert.equal(kop.split('name="bronstand"').length - 1, 1, `${naam} hoort precies één merk in de kop te hebben`);
    assert.equal(html.slice(html.indexOf('</head>')).includes('name="bronstand"'), false,
      `${naam} hoort geen bronstand-merk in de body te hebben`);
  });
}

test('de publicatielijst valt uiteen in "draagt een bronstand" en "hoort er geen te hebben"', () => {
  // Zonder deze test is de dekking hierboven een handmatige lijst van vier: wie een zevende pagina
  // publiceert, krijgt nergens een rode test als die pagina geen merk draagt — en de waarnemer zou
  // haar, zodra hij ooit ook daarheen kijkt, als BRONSTAND_ONLEESBAAR melden. De partitie is
  // daarom expliciet en uitputtend.
  const metBronstand = ['index.html', 'contentstroom.html', 'producten.html', 'stack-ticker.html'];
  // Deze twee tonen een eigen ticker-feed; de snapshot met haar `sources` komt er niet aan te pas.
  // Een bronstand op zo'n pagina zou een meting suggereren die er niet is.
  const zonderBronstand = ['transacties.html', 'code-ticker.html'];

  const gepubliceerd = PUBLISH_ALLOWLIST.filter((f) => f.endsWith('.html')).sort();
  assert.deepEqual(gepubliceerd, [...metBronstand, ...zonderBronstand].sort(),
    'nieuwe of verdwenen HTML-route: deel haar hierboven in vóór ze publiceert');

  for (const maak of [() => renderTransactieTicker({ available: false }), () => renderCodeTicker({ available: false })]) {
    assert.equal(maak().includes('name="bronstand"'), false,
      'een ticker-pagina hoort geen bronstand te dragen — zij meet geen bronnen');
  }
});

test('het statusbestand dat de waakvlam leest, wordt ook echt gepubliceerd', () => {
  // De waakvlam haalt `status.json` naast de pagina op. Valt dat bestand uit de publicatielijst,
  // dan meet hij niets meer en meldt hij BRONSTAND_ONLEESBAAR op een verder gezonde plaat. Deze
  // regel bindt de leesroute van de waakvlam aan wat de publicatie daadwerkelijk meeneemt.
  assert.equal(PUBLISH_ALLOWLIST.includes('status.json'), true);
});
