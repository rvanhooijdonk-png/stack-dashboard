/**
 * OVERZICHT — de plattegrond van de stack in vier lagen. Dit is een STATISCHE, met de hand
 * onderhouden plaat: er komt geen brondata in, geen collector, geen fetch. Wat hier staat gaat over
 * hoe de stack in elkaar zit, niet over wat er ín een document staat.
 *
 * Waarom dit veilig is (review Codex, 24-07-2026): NIET "omdat een mens het typte" — dat is geen
 * grens. De grens is drieledig: (1) er stroomt geen brondata in, dus er is niets om per ongeluk te
 * kopiëren; (2) de interne woordenschat die hier bewust wél naar buiten mag (kamernamen, topologie
 * als CHIEF, COA, Trading, Railway) is een expliciet goedgekeurde publieke set, geen toevallige
 * lekkage; (3) build.mjs scant deze pagina alsnog regel voor regel langs dezelfde patronen en
 * deny-terms als de rest — een handmatig ingetikte naam of pad breekt de build fail-closed.
 *
 * Doctrine: dit is de plattegrond, niet de meterstand. De kleuren zeggen "bestaat en werkt als
 * ontwerp" (groen), "wordt nog gebouwd" (grijs) of "wacht op een besluit van Richard" (amber) —
 * de LIVE stand staat op het Status-tabblad, dat wél uit de canon leest. Zo blijft de belofte
 * heel: een statische plaat claimt nooit een verse meterstand.
 *
 * Onderhoud: pas dit bestand aan wanneer de canon verandert (een kamer erbij, een plek verhuisd).
 * Het is bewust handwerk; er is geen bron om automatisch uit te lezen zonder de sanitize-wet te
 * doorbreken.
 */
import { NAV_STYLE, tabNav } from './nav.mjs';

// Kleurcodes — functioneel, niet decoratief. Eén betekenis per kleur, hier vastgelegd.
const GROEN = 'ok';   // in gebruik
const GRIJS = 'idle'; // in aanbouw
const AMBER = 'warn'; // wacht op Richard

/** Eén blokje in een laag: een kamer, een stap, een plek. `state` bepaalt de kleur. */
function tile(state, naam, uitleg) {
  return `<div class="tile ${state}"><span class="dot"></span><div><strong>${naam}</strong><span>${uitleg}</span></div></div>`;
}

/** Eén laag: een titel, een korte duiding, en een rij tegels die op mobiel verticaal stapelen. */
function layer(nummer, titel, duiding, tegels, extra = '') {
  return `<section class="layer">
  <div class="layer-head"><span class="layer-num">${nummer}</span><h2>${titel}</h2></div>
  <p class="layer-lead">${duiding}</p>
  <div class="tiles">${tegels.join('')}</div>
  ${extra}
</section>`;
}

const STYLE = `
:root{--bg:#0f1115;--card:#171a21;--line:#252a34;--fg:#e6e8ec;--mut:#9aa3b2;--ok:#3fb950;--warn:#d29922;--idle:#6b7280;--acc:#58a6ff}
@media (prefers-color-scheme:light){:root{--bg:#f6f7f9;--card:#fff;--line:#e3e6ea;--fg:#1c2027;--mut:#5c6470;--idle:#8b93a1;--acc:#0969da}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:28px 20px 64px}
header{display:flex;flex-wrap:wrap;gap:10px 20px;align-items:baseline;justify-content:space-between;margin-bottom:8px}
h1{font-size:22px;margin:0;letter-spacing:-.01em}
.stamp{color:var(--mut);font-size:13px}
.intro{color:var(--mut);margin:0 0 22px;max-width:70ch}
.intro strong{color:var(--fg)}
${NAV_STYLE}
.layer{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:0 0 16px}
.layer-head{display:flex;align-items:center;gap:10px;margin-bottom:4px}
.layer-num{flex:0 0 auto;width:26px;height:26px;border-radius:50%;background:var(--line);color:var(--fg);font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center}
.layer h2{font-size:15px;margin:0;text-transform:uppercase;letter-spacing:.06em}
.layer-lead{color:var(--mut);margin:0 0 14px;font-size:13.5px;max-width:75ch}
.tiles{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}
.tile{display:flex;gap:10px;align-items:flex-start;background:var(--bg);border:1px solid var(--line);border-left-width:3px;border-radius:8px;padding:10px 12px}
.tile .dot{flex:0 0 auto;width:9px;height:9px;border-radius:50%;margin-top:5px;background:var(--mut)}
.tile strong{display:block;font-size:14px}
.tile span{display:block;color:var(--mut);font-size:12.5px;line-height:1.4}
.tile.ok{border-left-color:var(--ok)}.tile.ok .dot{background:var(--ok)}
.tile.warn{border-left-color:var(--warn)}.tile.warn .dot{background:var(--warn)}
.tile.idle{border-left-color:var(--idle)}.tile.idle .dot{background:var(--idle)}
.flow{display:flex;flex-wrap:wrap;align-items:stretch;gap:8px;margin:2px 0 14px}
.flow .step{flex:1 1 120px;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:9px 11px;font-size:13px}
.flow .step strong{display:block;font-size:13.5px}
.flow .step span{color:var(--mut);font-size:12px}
.flow .arrow{align-self:center;color:var(--mut);font-size:16px;flex:0 0 auto}
.guards{margin-top:4px}
.guards h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:0 0 8px}
.legend{display:flex;flex-wrap:wrap;gap:14px;margin:0 0 22px;font-size:12.5px;color:var(--mut)}
.legend span{display:inline-flex;align-items:center;gap:6px}
.legend i{width:9px;height:9px;border-radius:50%;display:inline-block}
.legend i.ok{background:var(--ok)}.legend i.warn{background:var(--warn)}.legend i.idle{background:var(--idle)}
.wet{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:10px;padding:14px 16px;margin:18px 0 0}
.wet h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;margin:0 0 8px;color:var(--acc)}
.wet p{margin:0;font-size:13.5px;line-height:1.55}
footer{margin-top:28px;color:var(--mut);font-size:12.5px;border-top:1px solid var(--line);padding-top:14px}
a{color:var(--acc)}
@media (max-width:560px){.flow .arrow{display:none}.flow .step{flex-basis:100%}}
`;

/**
 * De sanitize-wet in gewone taal — dezelfde belofte die de Status-pagina in zijn voettekst draagt,
 * hier uitgeschreven zodat een bezoeker van de plattegrond precies weet wat er wél en niet naar
 * buiten gaat. Bewust mét de uitzondering erin (per-sectie handmatig vrijgeven), zodat deze tekst
 * niet strenger klinkt dan de Regels-pagina — één wet, één formulering (review Codex, 24-07-2026).
 */
const SANITIZE_WET = `De openbare pagina toont <strong>alleen bewust samengestelde structuur</strong>: aantallen,
ID's, datums, statussen en afgeleide labels — en dan uitsluitend in een gesloten, tegen een contract
gevalideerde vorm, want ook een ID of status kan ongemerkt een naam meedragen. Brontekst uit de canon
gaat er standaard <strong>niet</strong> in — geen documentinhoud, geen tokens, geen secretnamen, geen
lokale paden, geen bestandsnamen. De enige uitzondering is tekst die per sectie, met de hand en
expliciet is vrijgegeven; al het overige blijft binnen. Elke build passeert een <strong>sanitize-gate
die fail-closed is</strong> (bij twijfel: niets publiceren) plus een onafhankelijke secretsscan vóór
publicatie — ook deze plattegrond wordt regel voor regel gescand. Een afgeleid label lekt zijn bron
niet: het zegt wáár iets over gaat, niet wát er staat.`;

/** Bouw de volledige Overzicht-pagina. Geen argumenten: de plaat is statisch en draagt geen stempel. */
export function renderOverzicht() {
  const richard = layer('1', 'Richard', 'Waar de mens de stack in gaat. Drie ingangen, meer niet — de rest draait achter deze deuren.', [
    tile(GROEN, 'Telegram / CHIEF', 'Stuurt drops en krijgt zijn dagelijkse briefing via de COA-bot.'),
    tile(GROEN, 'Dit dashboard', 'Leest de gecureerde, toegestane bronnen. Beslist zelf niets, verandert niets.'),
    tile(AMBER, 'De poorten', 'Waar hij goedkeurt: geld, productie, onomkeerbaar, machtiging, strategie, zijn eigen materiaal.'),
  ]);

  const kamers = layer('2', 'Kamers', 'De werkkamers van de stack — elk met een begrijpelijke naam en één regel wat hij doet. Onderaan de buitenkamers: waar nog-niet-toegewezen werk binnenkomt.', [
    tile(GROEN, 'Regiekamer', 'Verdeelt het werk, bewaakt de poorten en houdt de waarheid bij.'),
    tile(GROEN, 'CHIEF', 'Taken en de dagelijkse briefing (COA).'),
    tile(GROEN, 'Autopilot', 'Zet werk in gang zonder dat er handmatig een trap wordt overgehaald.'),
    tile(GROEN, 'Deck', 'Bouwt keynote- en presentatiemateriaal.'),
    tile(GRIJS, 'Modellenvloot', 'Kiest per klus het juiste model.'),
    tile(GRIJS, 'Trading', 'Handelsintelligentie.'),
    tile(GRIJS, 'Archeologie', 'Wint oude data en context terug.'),
    tile(AMBER, 'Leeskamer', 'Leest wat binnenkomt en nog geen kamer heeft — een buitenkamer.'),
    tile(GRIJS, 'Nieuw', 'Ruimte voor een kamer die nog gevormd wordt — een buitenkamer.'),
  ]);

  const fabriek = `<section class="layer">
  <div class="layer-head"><span class="layer-num">3</span><h2>De fabriek</h2></div>
  <p class="layer-lead">Hoe een taak van links naar rechts door de stack loopt. Niets komt naar buiten zonder door de merge-poort te zijn gegaan; git is het geheugen dat elke stap onthoudt.</p>
  <div class="flow">
    <div class="step"><strong>Taakwachtrij</strong><span>wat er te doen is</span></div>
    <div class="arrow">→</div>
    <div class="step"><strong>Workers</strong><span>Claude en Codex bouwen</span></div>
    <div class="arrow">→</div>
    <div class="step"><strong>Dubbele review</strong><span>twee families kijken mee</span></div>
    <div class="arrow">→</div>
    <div class="step"><strong>Merge-poort</strong><span>Richard of de regel laat door</span></div>
    <div class="arrow">→</div>
    <div class="step"><strong>Git als geheugen</strong><span>af = vastgelegd op GitHub</span></div>
  </div>
  <div class="guards">
    <h3>De bewakers — altijd aan, langs de hele lijn</h3>
    <div class="tiles">
      ${tile(GROEN, 'gitleaks', 'Scant de output en blokkeert secrets vóór publicatie.')}
      ${tile(GROEN, 'sanitize', 'Houdt brontekst binnen; alleen structuur mag naar buiten.')}
      ${tile(GROEN, 'kostenplafonds', 'Bewaken dat een rekening niet ontspoort.')}
      ${tile(AMBER, 'PIEP', 'Slaat alarm bij twijfel — dan stopt de lijn en beslist Richard.')}
    </div>
  </div>
</section>`;

  const waar = layer('4', 'Waar het draait', 'De vier plekken waar de stack fysiek en online leeft.', [
    tile(GROEN, 'MacBook', 'Het raam: waar Richard meekijkt en meestuurt.'),
    tile(AMBER, 'Mac mini', 'Het huis: draait de klus door — nu in verhuizing.'),
    tile(GROEN, 'Railway', 'Productie: wat er naar buiten toe draait.'),
    tile(GROEN, 'GitHub', 'De waarheid: alles wat af is, staat hier.'),
  ]);

  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta http-equiv="content-security-policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
<title>Stack-dashboard — Overzicht</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>Stack-dashboard — Overzicht</h1>
  <p class="stamp">Statische plattegrond — geen live meterstand</p>
</header>
${tabNav('overzicht')}
<p class="intro">Dit is de <strong>plattegrond</strong> van de stack — hoe alles in elkaar zit, in vier lagen.
Het is een met de hand onderhouden plaat, geen meterstand: de <strong>live stand</strong> staat op het
<a href="index.html">Status-tabblad</a>, dat uit de canon leest. De kleuren hieronder zeggen dus "bestaat en
werkt zoals bedoeld", "wordt nog gebouwd" of "wacht op een besluit van Richard" — niet "is op dit moment aan".</p>
<div class="legend">
  <span><i class="ok"></i> in gebruik</span>
  <span><i class="idle"></i> in aanbouw</span>
  <span><i class="warn"></i> wacht op Richard</span>
</div>

${richard}
${kamers}
${fabriek}
${waar}

<section class="wet">
  <h2>Sanitize-wet — wat wél en niet naar buiten gaat</h2>
  <p>${SANITIZE_WET}</p>
</section>

<footer>
  Statische plattegrond, onderdeel van <code>stack-dashboard</code>. Bevat geen brondata en wordt met de hand
  bijgewerkt wanneer de canon verandert. Voor de actuele, uit de bronnen gelezen stand: het
  <a href="index.html">Status-tabblad</a>.
</footer>
</div>
</body>
</html>
`;
}
