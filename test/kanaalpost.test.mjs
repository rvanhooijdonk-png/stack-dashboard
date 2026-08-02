/**
 * VLOOT-KANAALPOST — de sectie leest de publieke spiegel `data/kanaalpost-publiek.md`, waar élk
 * venster van de vloot in meldt. Twee vragen worden hier per regel bewezen: "herkent de parser
 * precies de afgesproken vijf-veldenrij" en "kan er via die vrije tekst iets naar buiten dat er
 * niet hoort".
 *
 * De strengheids-tests zijn geen theorie: ze zijn één op één de bypasses die Codex en Gemini vonden
 * op de eerdere opzet van deze sectie (die het interne logboek las). Ze staan er zodat die gaten
 * niet terugkomen nu de bron gewisseld is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  spiegelUitTekst, kanaalpostUitTekst, toPublicKanaalpost, toPublicGates, publishVeilig, GATE_RIJEN,
} from '../scripts/lib/kanaalpost.mjs';
import { renderHtml } from '../scripts/lib/render.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(join(ROOT, 'data/fixture.json'), 'utf8'));

const BRON = `# KANAALPOST — publieke spiegel

| kolom | betekenis |
|---|---|
| **datum-tijd** | wanneer de melding is geschreven |

| datum-tijd | tab-rol | onderwerp | status | actie voor |
|---|---|---|---|---|
| 2026-07-25 10:05 | DASHBOARD | Eerste stuk klaar | AFGEROND | niemand |
| 2026-07-25 20:12 | CONTROL | **Tweede stuk** klaar | WACHT OP AKKOORD | Richard |
| 2026-07-26 04:52 | INSTROOM | Derde stuk klaar | AFGEROND | niemand |
`;

test('de parser leest de vijf-veldenrijen en negeert kop-, uitleg- en scheidingsregels', () => {
  const rijen = spiegelUitTekst(BRON);
  assert.equal(rijen.length, 3);
  assert.deepEqual(rijen[0], {
    tab: 'DASHBOARD',
    onderwerp: 'Eerste stuk klaar',
    status: 'AFGEROND',
    actie: 'niemand',
    datum: '2026-07-25 10:05',
  });
  // De markdown-nadruk wordt weggehaald; de plaat toont gewone tekst.
  assert.equal(rijen[1].onderwerp, 'Tweede stuk klaar');
  assert.equal(rijen[2].tab, 'INSTROOM');
});

test('een rij met een andere kolomtelling wordt overgeslagen, niet half geraden', () => {
  assert.equal(spiegelUitTekst(`${BRON}| 2026-07-26 | KAPOT | te weinig velden |\n`).length, 3);
});

test('een rij zonder echte datum telt niet mee (fail-closed op de datumkolom)', () => {
  assert.equal(spiegelUitTekst(`${BRON}| 2026-02-30 10:00 | X | iets | AFGEROND | niemand |\n`).length, 3);
  // en zonder kop levert dezelfde rij sowieso niets op
  assert.deepEqual(spiegelUitTekst('| 2026-02-30 10:00 | X | iets | AFGEROND | niemand |\n'), []);
});

test('een tab-cel die geen rollabel is, gooit de rij eruit', () => {
  assert.equal(spiegelUitTekst(`${BRON}| 2026-07-26 | <script>alert(1)</script> | iets | AFGEROND | niemand |\n`).length, 3);
});

test('een datumcel met rommel erachter is geen datum — de hele rij valt af', () => {
  // ROOD zonder eind-anker: de regex matchte de dag, de parser gooide de rest van de cel weg en
  // liet de rij als geldig door. Een pad in de datumkolom bleef zo onopgemerkt.
  assert.equal(spiegelUitTekst(`${BRON}| 2026-07-25 /Users/x/geheim.md | X | iets | AFGEROND | niemand |\n`).length, 3);
  assert.equal(spiegelUitTekst(`${BRON}| 2026-07-25 99:99 | X | iets | AFGEROND | niemand |\n`).length, 3);
  // en de geldige vorm blijft gewoon staan
  assert.equal(spiegelUitTekst(`${BRON}| 2026-07-25 23:59 | X | iets | AFGEROND | niemand |\n`).length, 4);
});

test('een vijfkolomstabel zonder spiegelkop levert geen rijen', () => {
  // ROOD zonder kop-poort: elke tabel die toevallig vijf kolommen heeft werd gelezen, waarbij een
  // andere kolomvolgorde vreemde velden naar `onderwerp`/`status` schoof.
  const vreemd = `| Environment | Owner | Endpoint | Interne notitie | Updated |
|---|---|---|---|---|
| 2026-07-25 | CONTROL | intern-adres | interne notitie | 2026-07-25 |
`;
  assert.deepEqual(spiegelUitTekst(vreemd), []);
  // ROOD in de vorige ronde (Codex + Gemini, 26-07-2026): `kopGezien` bleef na één echte kop voor de
  // rest van het bestand aan staan, waardoor ELKE latere vijfkolomstabel als kanaalpost werd gelezen.
  // Dat leverde `intern-adres` als onderwerp op een openbare pagina op.
  assert.equal(spiegelUitTekst(`${BRON}${vreemd}`).length, 3, 'een tweede tabel is geen kanaalpost');
  assert.equal(spiegelUitTekst(`${BRON}\n## Interne tabel\n\n${vreemd}`).length, 3);
  assert.equal(JSON.stringify(spiegelUitTekst(`${BRON}${vreemd}`)).includes('intern-adres'), false);
});

test('een rij in een HTML-commentaar of codeblok telt niet mee', () => {
  // De parser kent geen markdown-structuur; de kop-poort doet het werk. Een commentaarregel is geen
  // tabelregel, dus hij sluit de lopende tabel — en wat daarna komt heeft geen kop meer boven zich.
  const verstopt = `${BRON}
<!--
| 2026-07-26 06:00 | GEHEIM | Niet voor publicatie bedoelde notitie | AFGEROND | niemand |
-->
`;
  assert.equal(spiegelUitTekst(verstopt).length, 3);
  assert.equal(JSON.stringify(spiegelUitTekst(verstopt)).includes('Niet voor publicatie'), false);
});

test('een ge-escapete pipe blijft in zijn eigen cel staan', () => {
  // ROOD: hard splitsen op elke `|` gaf deze rij vijf cellen en schoof `AFGEROND` naar de
  // actiekolom — kolom-specifieke controles zijn dan waardeloos (review Gemini, 26-07-2026).
  const rijen = spiegelUitTekst(`${BRON}| 2026-07-26 06:00 | MARKT | keuze A \\| B gemaakt | AFGEROND | niemand |\n`);
  assert.equal(rijen.length, 4);
  assert.deepEqual(rijen[3], {
    tab: 'MARKT',
    onderwerp: 'keuze A | B gemaakt',
    status: 'AFGEROND',
    actie: 'niemand',
    datum: '2026-07-26 06:00',
  });
});

test('een uur zonder voorloopnul telt mee en wordt uitgelijnd getoond', () => {
  assert.equal(spiegelUitTekst(`${BRON}| 2026-07-25 9:05 | X | iets | AFGEROND | niemand |\n`).at(-1).datum, '2026-07-25 09:05');
});

test('ontbrekende of lege spiegel is BRON_ONBEREIKBAAR, een spiegel zonder rijen is LEEG', () => {
  assert.equal(kanaalpostUitTekst('').reason, 'BRON_ONBEREIKBAAR');
  assert.equal(kanaalpostUitTekst(null).reason, 'BRON_ONBEREIKBAAR');
  assert.equal(kanaalpostUitTekst('# kop\n\ngeen tabel\n').reason, 'LEEG');
  assert.equal(kanaalpostUitTekst(BRON).available, true);
});

// --- publieke reductie: laatste vijftien, nieuwste boven ---

const rij = (n) => ({ tab: 'CONTROL', onderwerp: `regel ${n}`, status: 'AFGEROND', actie: 'niemand', datum: '2026-07-25 10:00' });
const bron = (rows) => ({ available: true, reason: null, rows });

test('de plaat toont de laatste vijftien rijen met de nieuwste bovenaan', () => {
  const dto = toPublicKanaalpost(bron(Array.from({ length: 20 }, (_, i) => rij(i + 1))));
  assert.equal(dto.rows.length, 15);
  assert.equal(dto.rows[0].onderwerp, 'regel 20');
  assert.equal(dto.rows[14].onderwerp, 'regel 6');
});

test('een onbereikbare of lege bron geeft een nette melding, nooit een kapotte plaat', () => {
  const onbereikbaar = toPublicKanaalpost({ available: false, reason: 'BRON_ONBEREIKBAAR', rows: [] });
  assert.equal(onbereikbaar.available, false);
  assert.equal(onbereikbaar.reason, 'BRON_ONBEREIKBAAR');
  assert.deepEqual(onbereikbaar.rows, []);
  assert.equal(toPublicKanaalpost(null).available, false);
  assert.equal(toPublicKanaalpost(bron([])).reason, 'LEEG');
});

// --- gates: dezelfde bron, ander venster (v2.7) ---

const gateRij = (n, extra = {}) => ({
  tab: 'CONTROL', onderwerp: `gate ${n}`, status: 'WACHT OP AKKOORD', actie: 'Richard', datum: '2026-07-25 10:00', ...extra,
});

test('een gate uit het begin van de spiegel blijft staan, ook als hij uit de laatste vijftien is geschoven', () => {
  // Dit is de fout van 01-08-2026 in één regel: 1 gate, daarna 20 gewone rijen. De plaat toonde hem
  // niet meer omdat `toPublicKanaalpost` op vijftien knipt; `toPublicGates` leest de hele spiegel.
  const rows = [gateRij(1), ...Array.from({ length: 20 }, (_, i) => rij(i + 1))];
  assert.equal(toPublicKanaalpost(bron(rows)).rows.some((r) => r.onderwerp === 'gate 1'), false);
  const g = toPublicGates(bron(rows));
  assert.equal(g.rows.length, 1);
  assert.equal(g.rows[0].onderwerp, 'gate 1');
  assert.equal(g.totaal, 1);
});

test('alleen rijen die Richard als actiehouder noemen tellen als gate', () => {
  const g = toPublicGates(bron([gateRij(1), rij(2), gateRij(3, { actie: 'CONTROL en richard samen' })]));
  assert.deepEqual(g.rows.map((r) => r.onderwerp), ['gate 3', 'gate 1']);
});

test('zelfalarm van de automatische controle staat niet in de lijst maar wordt wel geteld', () => {
  const g = toPublicGates(bron([
    gateRij(1),
    gateRij(2, { tab: 'WAARNEMER', status: 'GEBLOKKEERD', actie: 'Richard of Fable' }),
    gateRij(3, { tab: 'WAARNEMER', status: 'GEBLOKKEERD', actie: 'Richard of Fable' }),
  ]));
  assert.deepEqual(g.rows.map((r) => r.onderwerp), ['gate 1']);
  assert.equal(g.zelfalarm, 2);
  assert.equal(g.totaal, 1);
});

test('de gates-lijst knipt op GATE_RIJEN, nieuwste boven, en meldt het totaal apart', () => {
  const g = toPublicGates(bron(Array.from({ length: GATE_RIJEN + 4 }, (_, i) => gateRij(i + 1))));
  assert.equal(g.rows.length, GATE_RIJEN);
  assert.equal(g.rows[0].onderwerp, `gate ${GATE_RIJEN + 4}`);
  assert.equal(g.totaal, GATE_RIJEN + 4, 'het totaal telt vóór het knippen — anders is "meer dan dit" niet te tonen');
});

test('een leesbare spiegel zonder gates is GEEN_GATE, een onleesbare blijft onbeschikbaar', () => {
  const geen = toPublicGates(bron([rij(1)]));
  assert.equal(geen.available, true);
  assert.equal(geen.reason, 'GEEN_GATE');
  assert.deepEqual(geen.rows, []);
  assert.equal(toPublicGates({ available: false, reason: 'BRON_ONBEREIKBAAR', rows: [] }).available, false);
  assert.equal(toPublicGates(null).reason, 'BRON_ONBEREIKBAAR');
  assert.equal(toPublicGates(bron([])).reason, 'LEEG');
});

test('alle rijen ingehouden is geen "geen gate" — dat verschil moet zichtbaar blijven', () => {
  const g = toPublicGates(bron([gateRij(1, { onderwerp: 'fix in /Users/iemand/geheim/pad.md' })]));
  assert.equal(g.available, false);
  assert.equal(g.reason, 'INGEHOUDEN');
  assert.deepEqual(g.rows, []);
});

test('een gate die de publicatiepoort niet haalt komt ook hier niet door', () => {
  const g = toPublicGates(bron([gateRij(1, { onderwerp: 'fix in /Users/iemand/geheim/pad.md' }), gateRij(2)]));
  assert.deepEqual(g.rows.map((r) => r.onderwerp), ['gate 2']);
});

// --- publish-poort: de rijen dragen vrije tekst van álle vensters ---

test('een rij met een herkend patroon wordt ingehouden, de rest blijft staan', () => {
  const dto = toPublicKanaalpost(bron([
    rij(1),
    { ...rij(2), onderwerp: 'fix in /Users/iemand/geheim/pad.md' },
    { ...rij(3), actie: 'zet AWS_SECRET_KEY opnieuw' },
  ]));
  assert.equal(dto.rows.length, 1);
  assert.equal(dto.ingehouden, 2);
  assert.equal(JSON.stringify(dto).includes('/Users/'), false);
});

test('ook de actie-cel gaat door de poort, niet alleen het onderwerp', () => {
  const dto = toPublicKanaalpost(bron([rij(1), { ...rij(2), actie: 'Richard — zie /Users/iemand/notitie.md' }]));
  assert.equal(dto.rows.length, 1);
  assert.equal(dto.ingehouden, 1);
});

test('een patroon voorbij de afkap-grens wordt óók gezien (afkappen is geen poort)', () => {
  // ROOD-bewijs voor de bypass: wie eerst afkapt en dán scant, publiceert de eerste zeshonderd
  // tekens van een regel waarvan het geheim op teken 2500 staat — en ziet dat geheim nooit. De
  // poort scant de VOLLEDIGE cel in overlappende vensters; pas daarna wordt er gecapt.
  const lang = `${'nette tekst '.repeat(260)}AKIAIOSFODNN7EXAMPLE`;
  assert.ok(lang.length > 2500);
  assert.equal(publishVeilig(lang), false);
  const dto = toPublicKanaalpost(bron([rij(1), { ...rij(2), onderwerp: lang }]));
  assert.equal(dto.rows.length, 1);
  assert.equal(dto.ingehouden, 1);
});

test('een lange maar schone regel wordt gepubliceerd, gecapt en zichtbaar afgekapt', () => {
  // Bewust gewone woorden: een blok van 4000 dezelfde letters is zelf een hoog-entropie-treffer,
  // en die zou de poort (terecht) laten dichtslaan — dat bewijst dan niets over lengte alleen.
  const lang = 'nette tekst over af werk '.repeat(160);
  assert.equal(publishVeilig(lang), true);
  const dto = toPublicKanaalpost(bron([{ ...rij(1), onderwerp: lang }]));
  assert.equal(dto.rows.length, 1);
  assert.ok(dto.rows[0].onderwerp.length <= 600);
  assert.ok(dto.rows[0].onderwerp.endsWith('…'), 'afkappen hoort zichtbaar te zijn');
});

test('alle rijen ingehouden is geen lege tabel maar een expliciete melding', () => {
  const dto = toPublicKanaalpost(bron([{ ...rij(1), onderwerp: 'pad /Users/x/y' }]));
  assert.equal(dto.available, false);
  assert.equal(dto.reason, 'INGEHOUDEN');
  assert.equal(dto.ingehouden, 1);
});

test('een lege plek in de rijenlijst laat de build niet omvallen, maar wordt ook niet gepubliceerd', () => {
  // ROOD: een `null`-rij werd een geldige publieke rij vol `—`. Corrupte invoer die geldige publieke
  // data wordt, is fail-open op integriteit (review Codex, 26-07-2026). Nu: ingehouden en geteld.
  const dto = toPublicKanaalpost(bron([null, rij(1), { tab: 'CONTROL' }]));
  assert.equal(dto.rows.length, 1);
  assert.equal(dto.ingehouden, 2);
  assert.ok(dto.rows.every((r) => Object.values(r).every((v) => typeof v === 'string' && v !== '')));
});

test('een status buiten de gesloten lijst wordt ingehouden, niet stil gepubliceerd', () => {
  const dto = toPublicKanaalpost(bron([rij(1), { ...rij(2), status: 'BIJNA KLAAR' }]));
  assert.equal(dto.rows.length, 1);
  assert.equal(dto.ingehouden, 1);
  assert.equal(JSON.stringify(dto).includes('BIJNA KLAAR'), false);
});

test('een repo-achtig rollabel komt niet op de plaat', () => {
  // Het rollabel hoort een ROL te zijn. `stack-control` is een repository — precies de waarde
  // waarmee de review een lekrij opbouwde (Codex, 26-07-2026).
  const dto = toPublicKanaalpost(bron([rij(1), { ...rij(2), tab: 'stack-control' }]));
  assert.equal(dto.rows.length, 1);
  assert.equal(dto.ingehouden, 1);
  assert.equal(publishVeilig('COMMAND-CANON'), true);
});

test('onzichtbare tekens maken de poort niet blind', () => {
  // ROOD: één U+200B midden in een sleutelnaam of een pad en geen enkel deny-patroon matcht nog,
  // terwijl de browser vrijwel dezelfde tekst toont (review Codex + Gemini, 26-07-2026).
  const zwsp = '\u200B';
  assert.equal(publishVeilig(`sleutel AWS_SECRET_${zwsp}KEY roteren`), false);
  assert.equal(publishVeilig(`pad /Users${zwsp}/iemand/geheim.md`), false);
  assert.equal(publishVeilig(`mail iemand@voor${zwsp}beeld.nl`), false);
  assert.equal(publishVeilig(`host 10.20.${zwsp}30.40`), false);
  // en de gepubliceerde tekst is de tekst die gescand is — geen onzichtbare resten
  const dto = toPublicKanaalpost(bron([{ ...rij(1), onderwerp: `net${zwsp}te tekst` }]));
  assert.equal(dto.rows[0].onderwerp, 'nette tekst');
});

test('een patroon dat door witruimte uit elkaar is getrokken, wordt alsnog gezien', () => {
  // ROOD: `password` + 1600 spaties + `: geheim` past nooit als hele match in één scanvenster.
  // De normalisatie brengt witruimte terug tot één spatie, dus het patroon past weer (Codex).
  assert.equal(publishVeilig(`password${' '.repeat(1600)}: geheimpje`), false);
});

test('een intern pad of telefoonnummer zonder home-prefix komt er ook niet door', () => {
  // Geen `sanitize`-patroon raakt deze twee, terwijl de spiegel ze volgens zijn eigen kop niet mag
  // dragen (review Codex + Gemini, 26-07-2026).
  assert.equal(publishVeilig('bewijs in CONTROL/RAPPORTEN/verslag.md'), false);
  assert.equal(publishVeilig('zie map/onder/diep'), false);
  assert.equal(publishVeilig('bel 06 12345678 voor overleg'), false);
  // en gewone tekst met een schuine streep tussen spaties blijft gewoon staan
  assert.equal(publishVeilig('CHIEF / CONTROL pakt dit samen op'), true);
  assert.equal(publishVeilig('voorstel #338 staat klaar voor de tikronde'), true);
});

test('de teller kijkt naar álle spiegelrijen, niet alleen naar de vijftien in beeld', () => {
  // ROOD: eerst de laatste vijftien nemen en dán scannen, meldde `ingehouden: 0` terwijl een oudere
  // rij nooit langs de poort was geweest — een geruststelling die niets bewees (Codex, 26-07-2026).
  const rows = [{ ...rij(0), onderwerp: 'oud pad /Users/x/geheim.md' }, ...Array.from({ length: 16 }, (_, i) => rij(i + 1))];
  const dto = toPublicKanaalpost(bron(rows));
  assert.equal(dto.rows.length, 15);
  assert.equal(dto.ingehouden, 1);
});

// --- render: eigen sectie, vaste kolomvolgorde, fail-closed melding ---

test('de sectie toont tab · onderwerp · status · datum, nieuwste boven', () => {
  const html = renderHtml(fixture);
  assert.match(html, /id="kanaalpost"/);
  assert.match(html, /<th>tab<\/th><th>onderwerp<\/th><th>status<\/th><th>datum<\/th>/);
  const sectie = html.split('id="kanaalpost"')[1].split('</section>')[0];
  const eerste = sectie.indexOf(fixture.kanaalpost.rows[0].onderwerp);
  const tweede = sectie.indexOf(fixture.kanaalpost.rows[1].onderwerp);
  assert.ok(eerste > 0 && eerste < tweede, 'de eerste DTO-rij hoort bovenaan te staan');
  assert.match(sectie, /laatste 3/);
  // Inhouden mag, stilzwijgend inhouden niet: het aantal staat er ook echt.
  assert.match(sectie, /1<\/strong> rij\(en\) zijn niet getoond/);
  // `actie voor` deelt de statuskolom — de kolomtelling blijft vier.
  assert.match(sectie, /WACHT OP AKKOORD<br><span class="muted">Richard<\/span>/);
  assert.equal(sectie.includes('>niemand<'), false, '"niemand" is geen actie om te tonen');
});

test('een onbereikbare kanaalpost geeft een melding en laat de rest van de pagina staan', () => {
  const s = structuredClone(fixture);
  s.kanaalpost = { available: false, reason: 'BRON_ONBEREIKBAAR', rows: [], ingehouden: 0 };
  const html = renderHtml(s);
  assert.match(html, /id="kanaalpost"/);
  assert.match(html, /geen bron is geen stand/i);
  assert.equal(/<th>tab<\/th>/.test(html), false);
  assert.match(html, /id="planning"/);          // de plaat zelf blijft staan
  assert.match(html, /Stack-dashboard/);
});

test('een volledig ingehouden post noemt het aantal, in plaats van stil te blijven', () => {
  const s = structuredClone(fixture);
  s.kanaalpost = { available: false, reason: 'INGEHOUDEN', rows: [], ingehouden: 15 };
  const sectie = renderHtml(s).split('id="kanaalpost"')[1].split('</section>')[0];
  assert.match(sectie, /publicatie-poort/i);
  assert.match(sectie, /\(15 rij\(en\)\)/);
});

test('markup uit een kanaalpost-rij wordt geëscaped, niet uitgevoerd', () => {
  const s = structuredClone(fixture);
  s.kanaalpost = {
    available: true,
    reason: null,
    ingehouden: 0,
    rows: [{ tab: 'CONTROL', onderwerp: '<img src=x onerror=alert(1)>', status: 'AFGEROND', actie: 'niemand', datum: '2026-07-25' }],
  };
  const html = renderHtml(s);
  assert.equal(html.includes('<img src=x'), false);
  assert.match(html, /&lt;img src=x/);
});

// --- de echte spiegel in deze repo is leesbaar met deze parser ---

test('de meegeleverde spiegel levert rijen op — de plaat leest een bestaand bestand', async () => {
  const tekst = await readFile(join(ROOT, 'data/kanaalpost-publiek.md'), 'utf8');
  const bronDto = kanaalpostUitTekst(tekst);
  assert.equal(bronDto.available, true, 'de spiegel in deze repo hoort herkende rijen te bevatten');
  const dto = toPublicKanaalpost(bronDto);
  assert.equal(dto.available, true);
  assert.ok(dto.rows.length > 0 && dto.rows.length <= 15);
  // Geen enkele rij hoort een pad, sleutel of adres te dragen: de spiegel is al voor publiek geschreven.
  assert.equal(dto.ingehouden, 0, 'een ingehouden rij betekent dat een venster iets schreef dat er niet hoort');
});

// --- SHA-verkorting: botsing spiegelwet (volle SHA verplicht in de bron) vs sanitize-poort
// (40 hextekens = mogelijk geheim) opgelost met een handmatig nagekeken allowlist, geen
// generieke "elke hex-40 is een SHA"-regex (Codex-review, 29-07-2026: die zou een echt
// hex-vormig geheim ongemerkt doorlaten — precies de uitzondering die op 26-07-2026 bewust
// uit sanitize.mjs is gehaald). ---

const GEAUTORISEERDE_SHA = 'b694235cae13d681d485040b9c3309a239b225ec';

test('een geautoriseerde SHA in het onderwerp wordt getoond in de gangbare korte vorm', () => {
  const dto = toPublicKanaalpost(bron([{ ...rij(1), onderwerp: `zie sha ${GEAUTORISEERDE_SHA} voor details` }]));
  assert.equal(dto.available, true);
  assert.equal(dto.ingehouden, 0);
  assert.equal(dto.rows.length, 1);
  assert.equal(dto.rows[0].onderwerp, 'zie sha b694235… voor details');
});

test('een niet-geautoriseerde hex-40 blijft ingehouden — de allowlist verzwakt de poort niet', () => {
  const vreemdeHex = 'a'.repeat(40);
  const dto = toPublicKanaalpost(bron([{ ...rij(1), onderwerp: `zie sha ${vreemdeHex} voor details` }]));
  assert.equal(dto.available, false);
  assert.equal(dto.reason, 'INGEHOUDEN');
  assert.equal(dto.ingehouden, 1);
});

test('twee geautoriseerde SHAs in dezelfde rij worden allebei verkort', () => {
  const dto = toPublicKanaalpost(
    bron([{ ...rij(1), onderwerp: `van ${GEAUTORISEERDE_SHA} naar ${GEAUTORISEERDE_SHA}` }]),
  );
  assert.equal(dto.ingehouden, 0);
  assert.equal(dto.rows.length, 1);
  assert.equal(dto.rows[0].onderwerp, 'van b694235… naar b694235…');
});

test('41 hextekens is geen SHA-1 meer en blijft ingehouden (geen randgeval-lek op de \\b-grens)', () => {
  const eenTeLang = `${GEAUTORISEERDE_SHA}a`;
  const dto = toPublicKanaalpost(bron([{ ...rij(1), onderwerp: `zie sha ${eenTeLang} voor details` }]));
  assert.equal(dto.available, false);
  assert.equal(dto.reason, 'INGEHOUDEN');
  assert.equal(dto.ingehouden, 1);
});
