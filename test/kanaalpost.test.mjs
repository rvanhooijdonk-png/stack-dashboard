import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { kanaalpostUitTekst } from '../scripts/lib/collect.mjs';
import { toPublicKanaalpost, publishVeilig } from '../scripts/build.mjs';
import { renderHtml } from '../scripts/lib/render.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(join(ROOT, 'data/fixture.json'), 'utf8'));

/**
 * VLOOT-KANAALPOST — de sectie leest het gedeelde `CONTROL/KANAALPOST.md` van de rapporten-branch,
 * niet meer de eigen bouwlijst van dit venster. Twee vragen worden hier per regel bewezen:
 * "herkent de parser precies de afgesproken vijf-veldenrij" en "kan er via die vrije tekst iets
 * naar buiten dat er niet hoort".
 */

const BRON = `# KANAALPOST

## Logboek

### 2026-07-25

| Tab | Wat klaar is | Sha | Richard / Fable | Datum-tijd (UTC) |
|-----|--------------|-----|-----------------|------------------|
| DASHBOARD | Eerste stuk klaar | \`repo@aaa1111\` | **Niets** — gemerged | 2026-07-25 10:05 |
| CONTROL | Tweede stuk klaar | \`repo@bbb2222\` | **Richard: merge #12** | 2026-07-25 20:12 |

| TRECHTER | Derde stuk klaar | \`repo@ccc3333\` | geen | 2026-07-26 04:52 |
`;

test('de parser leest de vijf-veldenrijen en negeert kop- en scheidingsregels', () => {
  const rijen = kanaalpostUitTekst(BRON);
  assert.equal(rijen.length, 3);
  assert.deepEqual(rijen[0], {
    tab: 'DASHBOARD',
    onderwerp: 'Eerste stuk klaar',
    status: 'Niets — gemerged',
    datum: '2026-07-25 10:05',
  });
  assert.equal(rijen[2].tab, 'TRECHTER');
});

test('een rij met een andere kolomtelling wordt overgeslagen, niet half geraden', () => {
  const rijen = kanaalpostUitTekst(`${BRON}\n| KAPOT | te weinig velden | 2026-07-26 |\n`);
  assert.equal(rijen.length, 3);
});

test('een rij zonder echte datum telt niet mee (fail-closed op de datumkolom)', () => {
  const rijen = kanaalpostUitTekst('| X | iets | `a@1` | geen | 2026-02-30 10:00 |\n');
  assert.deepEqual(rijen, []);
});

test('een tab-cel die geen naam is, gooit de rij eruit', () => {
  const rijen = kanaalpostUitTekst('| <script>alert(1)</script> | iets | `a@1` | geen | 2026-07-25 |\n');
  assert.deepEqual(rijen, []);
});

// --- publieke reductie: laatste vijftien, nieuwste boven ---

const rij = (n) => ({ tab: 'CONTROL', onderwerp: `regel ${n}`, status: 'geen', datum: '2026-07-25 10:00' });
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

test('een patroon voorbij de afkap-grens wordt óók gezien (afkappen is geen poort)', () => {
  // ROOD-bewijs voor de bypass: wie eerst afkapt en dán scant, publiceert de eerste 200 tekens van
  // een regel waarvan het geheim op teken 2500 staat — en ziet dat geheim nooit. De poort scant de
  // VOLLEDIGE cel in overlappende vensters; pas daarna wordt er gecapt.
  const lang = `${'nette tekst '.repeat(260)}AKIAIOSFODNN7EXAMPLE`;
  assert.ok(lang.length > 2500);
  assert.equal(publishVeilig(lang), false);
  const dto = toPublicKanaalpost(bron([rij(1), { ...rij(2), onderwerp: lang }]));
  assert.equal(dto.rows.length, 1);
  assert.equal(dto.ingehouden, 1);
});

test('een lange maar schone regel wordt gepubliceerd, gecapt op een leesbare lengte', () => {
  // Bewust gewone woorden: een blok van 4000 dezelfde letters is zelf een hoog-entropie-treffer,
  // en die zou de poort (terecht) laten dichtslaan — dat bewijst dan niets over lengte alleen.
  const lang = 'nette tekst over af werk '.repeat(160);
  assert.equal(publishVeilig(lang), true);
  const dto = toPublicKanaalpost(bron([{ ...rij(1), onderwerp: lang }]));
  assert.equal(dto.rows.length, 1);
  assert.ok(dto.rows[0].onderwerp.length <= 200);
});

test('alle rijen ingehouden is geen lege tabel maar een expliciete melding', () => {
  const dto = toPublicKanaalpost(bron([{ ...rij(1), onderwerp: 'pad /Users/x/y' }]));
  assert.equal(dto.available, false);
  assert.equal(dto.reason, 'INGEHOUDEN');
  assert.equal(dto.ingehouden, 1);
});

// --- render: eigen sectie, vaste kolomvolgorde, fail-closed melding ---

test('de sectie toont tab · onderwerp · status · datum, nieuwste boven', () => {
  const html = renderHtml(fixture);
  assert.match(html, /id="kanaalpost"/);
  const kop = /<th>tab<\/th><th>onderwerp<\/th><th>status<\/th><th>datum<\/th>/;
  assert.match(html, kop);
  const sectie = html.split('id="kanaalpost"')[1];
  const eerste = sectie.indexOf(fixture.kanaalpost.rows[0].onderwerp);
  const tweede = sectie.indexOf(fixture.kanaalpost.rows[1].onderwerp);
  assert.ok(eerste > 0 && eerste < tweede, 'de eerste DTO-rij hoort bovenaan te staan');
  assert.match(html, /laatste 3/);
  // Inhouden mag, stilzwijgend inhouden niet: het aantal staat er ook echt.
  assert.match(sectie.split('</section>')[0], /1<\/strong> rij\(en\) zijn niet getoond/);
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

test('markup uit een kanaalpost-rij wordt geëscaped, niet uitgevoerd', () => {
  const s = structuredClone(fixture);
  s.kanaalpost = {
    available: true,
    reason: null,
    ingehouden: 0,
    rows: [{ tab: 'CONTROL', onderwerp: '<img src=x onerror=alert(1)>', status: 'geen', datum: '2026-07-25' }],
  };
  const html = renderHtml(s);
  assert.equal(html.includes('<img src=x'), false);
  assert.match(html, /&lt;img src=x/);
});

// --- strengere poorten (her-review Codex + Gemini, 26-07-2026): eerst het ROOD-bewijs ---

test('een datumcel met rommel erachter is geen datum — de hele rij valt af', () => {
  // ROOD zonder eind-anker: `KANAAL_DATUM` matchte de dag, de parser gooide de rest van de cel weg
  // en liet de rij als geldig door. Een pad in de datumkolom bleef zo onopgemerkt.
  assert.deepEqual(kanaalpostUitTekst(`${BRON}| X | iets | \`a@1\` | geen | 2026-07-25 /Users/x/geheim.md |\n`).length, 3);
  assert.deepEqual(kanaalpostUitTekst(`${BRON}| X | iets | \`a@1\` | geen | 2026-07-25 99:99 |\n`).length, 3);
  // en de geldige vorm blijft gewoon staan
  assert.equal(kanaalpostUitTekst(`${BRON}| X | iets | \`a@1\` | geen | 2026-07-25 23:59 |\n`).length, 4);
});

test('een vijfkolomstabel zonder kanaalpost-kop levert geen rijen', () => {
  // ROOD zonder kop-poort: elke tabel die toevallig vijf kolommen heeft werd gelezen, waarbij een
  // andere kolomvolgorde interne velden naar `onderwerp`/`status` schoof.
  const vreemd = `| Environment | Owner | Endpoint | Interne notitie | Updated |
|---|---|---|---|---|
| CONTROL | Project Orion | intern-repo | interne notitie | 2026-07-25 |
`;
  assert.deepEqual(kanaalpostUitTekst(vreemd), []);
  assert.equal(kanaalpostUitTekst(`${BRON}${vreemd}`).length, 4, 'ná een echte kop leest hij weer door');
});

test('een volledig ingehouden post noemt het aantal, in plaats van stil te blijven', () => {
  const s = structuredClone(fixture);
  s.kanaalpost = { available: false, reason: 'INGEHOUDEN', rows: [], ingehouden: 15 };
  const sectie = renderHtml(s).split('id="kanaalpost"')[1].split('</section>')[0];
  assert.match(sectie, /publicatie-poort/i);
  assert.match(sectie, /\(15 rij\(en\)\)/);
});

test('een lege plek in de rijenlijst laat de build niet omvallen', () => {
  const dto = toPublicKanaalpost(bron([null, rij(1)]));
  assert.equal(dto.rows.length, 2);
  assert.deepEqual(dto.rows[1], { tab: null, onderwerp: null, status: null, datum: null });
});

test('een uur zonder voorloopnul telt mee en wordt uitgelijnd getoond', () => {
  const rijen = kanaalpostUitTekst(`${BRON}| X | iets | \`a@1\` | geen | 2026-07-25 9:05 |\n`);
  assert.equal(rijen.at(-1).datum, '2026-07-25 09:05');
});
