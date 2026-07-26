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
  spiegelUitTekst, kanaalpostUitTekst, toPublicKanaalpost, publishVeilig,
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
  assert.equal(spiegelUitTekst(`${BRON}${vreemd}`).length, 4, 'ná een echte kop leest hij weer door');
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

// --- publish-poort: de rijen dragen vrije tekst van álle vensters ---

test('een rij met een herkend patroon wordt ingehouden, de rest blijft staan', () => {
  const dto = toPublicKanaalpost(bron([
    rij(1),
    { ...rij(2), onderwerp: 'fix in /Users/iemand/geheim/pad.md' },
    { ...rij(3), status: 'zet AWS_SECRET_KEY opnieuw' },
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

test('een lege plek in de rijenlijst laat de build niet omvallen', () => {
  const dto = toPublicKanaalpost(bron([null, rij(1)]));
  assert.equal(dto.rows.length, 2);
  assert.deepEqual(dto.rows[1], { tab: null, onderwerp: null, status: null, actie: null, datum: null });
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
