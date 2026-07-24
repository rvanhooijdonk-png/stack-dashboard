/**
 * REGELS — de wetten van de stack in gewone taal. Statisch, net als de Overzicht-plaat: geen
 * brondata, geen collector, met de hand geschreven. Deze pagina wijzigt alleen mee met de canon —
 * als een wet verandert, verandert deze tekst mee, niet automatisch.
 *
 * Elke wet: een korte naam, één zin wat hij zegt, en waarom hij er is. Niet de juridische tekst,
 * wel de bedoeling — leesbaar voor wie de stack niet van binnen kent.
 */
import { NAV_STYLE, tabNav } from './nav.mjs';

const LAWS = [
  {
    naam: 'Reviewwet',
    kern: 'De bouwer keurt nooit zijn eigen werk.',
    uitleg: 'Elke wijziging wordt gelezen door twee onafhankelijke families — Claude én Codex/Gemini. Zo houdt één blinde vlek de hele stack niet voor de gek.',
  },
  {
    naam: 'Eén schrijver per repo',
    kern: 'Aan één repo werkt tegelijk maar één schrijver.',
    uitleg: 'Gasten krijgen een eigen worktree, een aparte werkkopie. Zo overschrijft niemand het werk van een ander.',
  },
  {
    naam: 'Fail-closed',
    kern: 'Bij twijfel stopt de lijn en meldt het.',
    uitleg: 'Nooit "ik gok het wel even". Een dichte poort is veiliger dan een verkeerd besluit dat je niet meer terugdraait.',
  },
  {
    naam: 'Afgeleid lekt niet',
    kern: 'De openbare kant toont structuur, nooit de brontekst.',
    uitleg: 'Aantallen, datums, ID\'s en statussen mogen naar buiten; documentinhoud niet. Een label zegt wáár iets over gaat, niet wát er staat.',
  },
  {
    naam: 'No-loss',
    kern: 'Er gaat niets weg zonder bewijs dat het behouden is.',
    uitleg: 'Eerst deactiveren, dan aantonen dat de vervanger echt werk verwerkt, dán pas verwijderen. Verwijderen is altijd tweetraps.',
  },
  {
    naam: 'Eigenaarspoort',
    kern: 'Byte-geverifieerde documenten mag Richard direct mergen.',
    uitleg: 'Ontwerp of code nooit — die gaan altijd langs review. De poort staat alleen open voor tekst die aantoonbaar niet gewijzigd is.',
  },
  {
    naam: 'Gates',
    kern: 'De grote knoppen zijn altijd van Richard.',
    uitleg: 'Geld, productie, iets onomkeerbaars, machine-rechten, strategie en Richards eigen materiaal: dat beslist een mens, nooit een agent.',
  },
  {
    naam: 'Rol = tab',
    kern: 'Elke rol heeft één plek.',
    uitleg: 'Wat een kamer doet, staat op zijn eigen tabblad. Geen tweede waarheid ernaast, geen rol die op twee plekken tegelijk leeft.',
  },
  {
    naam: 'Richard-vorm',
    kern: 'Elke vraag aan Richard past op een telefoon, in één minuut.',
    uitleg: 'Kan een vraag dat niet — te lang, te veel opties, te veel context nodig — dan is de vraag nog niet af, en gaat hij terug de werkbank op.',
  },
  {
    naam: 'Vertaalwet',
    kern: 'Een vertaalslag verruimt toestemming nooit.',
    uitleg: 'Wat via een omweg loopt — een script, een samenvatting, een tussenlaag — krijgt nooit meer rechten dan het origineel had. Een tolk mag geen nieuwe beloftes doen.',
  },
];

const STYLE = `
:root{--bg:#0f1115;--card:#171a21;--line:#252a34;--fg:#e6e8ec;--mut:#9aa3b2;--acc:#58a6ff}
@media (prefers-color-scheme:light){:root{--bg:#f6f7f9;--card:#fff;--line:#e3e6ea;--fg:#1c2027;--mut:#5c6470;--acc:#0969da}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:28px 20px 64px}
header{display:flex;flex-wrap:wrap;gap:10px 20px;align-items:baseline;justify-content:space-between;margin-bottom:8px}
h1{font-size:22px;margin:0;letter-spacing:-.01em}
.stamp{color:var(--mut);font-size:13px;margin:0}
.intro{color:var(--mut);margin:0 0 22px;max-width:72ch}
.intro strong{color:var(--fg)}
${NAV_STYLE}
.laws{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.law{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:10px;padding:14px 16px}
.law .n{display:flex;align-items:baseline;gap:8px;margin:0 0 6px}
.law .num{flex:0 0 auto;color:var(--mut);font-variant-numeric:tabular-nums;font-size:12px;font-weight:700}
.law h2{font-size:15px;margin:0}
.law .kern{margin:0 0 6px;font-weight:600}
.law .uitleg{margin:0;color:var(--mut);font-size:13.5px;line-height:1.5}
footer{margin-top:28px;color:var(--mut);font-size:12.5px;border-top:1px solid var(--line);padding-top:14px}
a{color:var(--acc)}
`;

/** Bouw de volledige Regels-pagina. Geen argumenten: de wetten zijn statisch. */
export function renderRegels({ generatedAt } = {}) {
  const stamp = typeof generatedAt === 'string' ? generatedAt.slice(0, 16).replace('T', ' ') : '';
  const cards = LAWS.map((l, i) => `<article class="law">
    <div class="n"><span class="num">${i + 1}</span><h2>${l.naam}</h2></div>
    <p class="kern">${l.kern}</p>
    <p class="uitleg">${l.uitleg}</p>
  </article>`).join('\n');

  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta http-equiv="content-security-policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
<title>Stack-dashboard — Regels</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>Stack-dashboard — Regels</h1>
  ${stamp ? `<p class="stamp">Vastgelegd: <strong>${stamp} UTC</strong></p>` : ''}
</header>
${tabNav('regels')}
<p class="intro">De wetten waar de hele stack zich aan houdt, in gewone taal. Ze staan hier niet om indruk te maken
maar omdat ze <strong>altijd gelden</strong> — voor elke agent, elke bouwstap, elke poort. Deze pagina is statisch
en verandert alleen mee als de canon verandert.</p>
<div class="laws">
${cards}
</div>
<footer>
  Statische pagina, onderdeel van <code>stack-dashboard</code>. Dit is de bedoeling van elke wet in gewone taal,
  niet de juridische tekst — de canon blijft leidend. Voor de live stand: het <a href="index.html">Status-tabblad</a>.
</footer>
</div>
</body>
</html>
`;
}
