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
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  spiegelUitTekst, kanaalpostUitTekst, toPublicKanaalpost, publishVeilig,
} from '../scripts/lib/kanaalpost.mjs';
import { laadSpiegelCatalogus } from '../scripts/lib/spiegel-catalogus.mjs';
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

/**
 * Sinds contract 2.5 is deze sectie een PROJECTIE: de bronrij selecteert, de catalogus levert de
 * bytes. Deze proeven gaan over de reductie eromheen — venstergrootte, volgorde, vorm-poort,
 * telling — dus krijgen ze een catalogus die precies de nette regels hieronder kent. Wat de
 * catalogus zélf moet weigeren staat in `test/spiegel-catalogus.test.mjs`, met de negen gemeten
 * auditvormen. De regels die deze proeven aanbieden en die er NIET in staan, horen dus ingehouden
 * te worden — dat is nu de reden dat ze niet verschijnen, en niet meer dat een patroon aansloeg.
 */
const LANG_GOEDGEKEURD = 'nette tekst over af werk '.repeat(160).trim();
const proefCatalogus = () => {
  const regels = [
    ...Array.from({ length: 21 }, (_, i) => ({ bron: { tab: 'CONTROL', onderwerp: `regel ${i}`, status: 'AFGEROND', actie: 'niemand' } })),
    { bron: { tab: 'CONTROL', onderwerp: 'nette tekst', status: 'AFGEROND', actie: 'niemand' } },
    {
      bron: { tab: 'CONTROL', onderwerp: LANG_GOEDGEKEURD, status: 'AFGEROND', actie: 'niemand' },
      publiek: { tab: 'CONTROL', onderwerp: 'Een lange regel, in de vorm die is goedgekeurd.', status: 'AFGEROND', actie: 'niemand' },
    },
  ];
  const pad = join(mkdtempSync(join(tmpdir(), 'kanaalpost-catalogus-')), 'catalogus.json');
  writeFileSync(pad, JSON.stringify({ versie: 1, regels }));
  return laadSpiegelCatalogus(pad);
};
const CATALOGUS = proefCatalogus();
const plaat = (rows) => toPublicKanaalpost(bron(rows), CATALOGUS);

test('de proefcatalogus laadt — anders bewijst geen enkele reductie-proef hieronder iets', () => {
  assert.equal(CATALOGUS.geladen, true, CATALOGUS.reden ?? '');
});

test('de plaat toont de laatste vijftien rijen met de nieuwste bovenaan', () => {
  const dto = plaat(Array.from({ length: 20 }, (_, i) => rij(i + 1)));
  assert.equal(dto.rows.length, 15);
  assert.equal(dto.rows[0].onderwerp, 'regel 20');
  assert.equal(dto.rows[14].onderwerp, 'regel 6');
});

test('een onbereikbare of lege bron geeft een nette melding, nooit een kapotte plaat', () => {
  const onbereikbaar = toPublicKanaalpost({ available: false, reason: 'BRON_ONBEREIKBAAR', rows: [] }, CATALOGUS);
  assert.equal(onbereikbaar.available, false);
  assert.equal(onbereikbaar.reason, 'BRON_ONBEREIKBAAR');
  assert.deepEqual(onbereikbaar.rows, []);
  assert.equal(toPublicKanaalpost(null, CATALOGUS).available, false);
  assert.equal(plaat([]).reason, 'LEEG');
});

// --- publish-poort: de rijen dragen vrije tekst van álle vensters ---

test('een rij met een herkend patroon wordt ingehouden, de rest blijft staan', () => {
  const dto = plaat([
    rij(1),
    { ...rij(2), onderwerp: 'fix in /Users/iemand/geheim/pad.md' },
    { ...rij(3), actie: 'zet AWS_SECRET_KEY opnieuw' },
  ]);
  assert.equal(dto.rows.length, 1);
  assert.equal(dto.ingehouden, 2);
  assert.equal(JSON.stringify(dto).includes('/Users/'), false);
});

test('ook de actie-cel telt mee in de selectie, niet alleen het onderwerp', () => {
  const dto = plaat([rij(1), { ...rij(2), actie: 'Richard — zie /Users/iemand/notitie.md' }]);
  assert.equal(dto.rows.length, 1);
  assert.equal(dto.ingehouden, 1);
});

test('een patroon voorbij de afkap-grens wordt óók gezien (afkappen is geen poort)', () => {
  // ROOD-bewijs voor de bypass: wie eerst afkapt en dán scant, publiceert de eerste zeshonderd
  // tekens van een regel waarvan het geheim op teken 2500 staat — en ziet dat geheim nooit. De
  // poort scant de VOLLEDIGE cel in overlappende vensters. Sinds 2.5 is dit vooral de keuring van
  // de CATALOGUS: dit is de reden dat zo'n regel er niet in kan komen te staan.
  const lang = `${'nette tekst '.repeat(260)}AKIAIOSFODNN7EXAMPLE`;
  assert.ok(lang.length > 2500);
  assert.equal(publishVeilig(lang), false);
  const dto = plaat([rij(1), { ...rij(2), onderwerp: lang }]);
  assert.equal(dto.rows.length, 1);
  assert.equal(dto.ingehouden, 1);
});

test('een lange bronregel verschijnt in de vorm die is goedgekeurd, niet in een afgekapte', () => {
  // Vóór 2.5 kapte de plaat zelf af op 600 tekens met een `…` — een halve zin die niemand in die
  // vorm had gelezen, en soms midden in een woord. Nu staat de korte vorm in de catalogus en is dát
  // wat er verschijnt. Afkappen is een redactionele keuze geworden in plaats van een `slice()`.
  assert.equal(publishVeilig(LANG_GOEDGEKEURD), true);
  const dto = plaat([{ ...rij(1), onderwerp: LANG_GOEDGEKEURD }]);
  assert.equal(dto.rows.length, 1);
  assert.equal(dto.rows[0].onderwerp, 'Een lange regel, in de vorm die is goedgekeurd.');
  assert.equal(dto.rows[0].onderwerp.endsWith('…'), false);
});

test('alle rijen ingehouden is geen lege tabel maar een expliciete melding', () => {
  const dto = plaat([{ ...rij(1), onderwerp: 'pad /Users/x/y' }]);
  assert.equal(dto.available, false);
  assert.equal(dto.reason, 'INGEHOUDEN');
  assert.equal(dto.ingehouden, 1);
});

test('een lege plek in de rijenlijst laat de build niet omvallen, maar wordt ook niet gepubliceerd', () => {
  // ROOD: een `null`-rij werd een geldige publieke rij vol `—`. Corrupte invoer die geldige publieke
  // data wordt, is fail-open op integriteit (review Codex, 26-07-2026). Nu: ingehouden en geteld.
  const dto = plaat([null, rij(1), { tab: 'CONTROL' }]);
  assert.equal(dto.rows.length, 1);
  assert.equal(dto.ingehouden, 2);
  assert.ok(dto.rows.every((r) => Object.values(r).every((v) => typeof v === 'string' && v !== '')));
});

test('een status buiten de gesloten lijst wordt ingehouden, niet stil gepubliceerd', () => {
  const dto = plaat([rij(1), { ...rij(2), status: 'BIJNA KLAAR' }]);
  assert.equal(dto.rows.length, 1);
  assert.equal(dto.ingehouden, 1);
  assert.equal(JSON.stringify(dto).includes('BIJNA KLAAR'), false);
});

test('een repo-achtig rollabel komt niet op de plaat', () => {
  // Het rollabel hoort een ROL te zijn. `stack-control` is een repository — precies de waarde
  // waarmee de review een lekrij opbouwde (Codex, 26-07-2026).
  const dto = plaat([rij(1), { ...rij(2), tab: 'stack-control' }]);
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
  // en de sleutel waarmee de catalogus wordt opgezocht is de kále tekst: een onzichtbaar teken in de
  // bronrij verandert niets aan wát er verschijnt, dus je kunt er geen tweede vorm mee binnensmokkelen.
  const dto = plaat([{ ...rij(1), onderwerp: `net${zwsp}te tekst` }]);
  assert.equal(dto.rows.length, 1);
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
  const dto = plaat(rows);
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
  const catalogus = laadSpiegelCatalogus(join(ROOT, 'data/spiegel-catalogus.json'));
  assert.equal(catalogus.geladen, true, catalogus.reden ?? '');
  const dto = toPublicKanaalpost(bronDto, catalogus);
  assert.equal(dto.available, true);
  assert.ok(dto.rows.length > 0 && dto.rows.length <= 15);
  // Sinds 2.5 is `ingehouden: 0` een sterkere uitspraak dan vroeger: niet alleen "geen patroon sloeg
  // aan", maar "elke rij in de meegeleverde spiegel is vooraf beoordeeld en staat in de catalogus".
  // Loopt dit rood na een nieuwe spiegelrij, dan is dat de bedoeling: de rij moet eerst beoordeeld.
  assert.equal(dto.ingehouden, 0, 'elke bronrij hoort een vooraf beoordeelde tegenhanger te hebben');
});

test('hetzelfde viertal vijftien keer verdringt de rest niet — het telt één keer', () => {
  // ROOD: de catalogus houdt onbeoordeelde tekst tegen, maar niet HERHALING van goedgekeurde tekst.
  // Wie het venster van vijftien volzet met één goedgekeurde rij, drukt alle andere meldingen van de
  // plaat af zonder één onbeoordeelde byte te publiceren (bevinding review Gemini, 26-07-2026).
  const dto = plaat([rij(1), rij(2), rij(3), ...Array.from({ length: 15 }, () => rij(4))]);
  assert.equal(dto.rows.length, 4, 'vier verschillende meldingen horen alle vier zichtbaar te blijven');
  assert.equal(new Set(dto.rows.map((r) => r.onderwerp)).size, 4);
  assert.equal(dto.ingehouden, 14, 'de veertien herhalingen worden geteld, niet stil weggelaten');
});

test('ontdubbelen kijkt naar het viertal, niet naar de datum', () => {
  // Twee meldingen die alleen in datum verschillen zijn dezelfde melding, twee keer geplakt. Andersom
  // blijft een écht andere melding op dezelfde datum gewoon staan — anders zou één druk moment de
  // rest van dat uur wegdrukken.
  const zelfde = plaat([rij(1), { ...rij(1), datum: '2026-07-25 11:00' }]);
  assert.equal(zelfde.rows.length, 1);
  assert.equal(zelfde.ingehouden, 1);
  const anders = plaat([rij(1), { ...rij(2), datum: rij(1).datum }]);
  assert.equal(anders.rows.length, 2);
  assert.equal(anders.ingehouden, 0);
});

test('zonder catalogus publiceert de plaat niets — fail-closed, niet fail-open', () => {
  // De kern van de omslag: valt de catalogus weg, dan is élke rij onbeoordeeld. Er verschijnt dan
  // niets, mét reden — in plaats van terugvallen op vrije brontekst die niemand heeft gelezen.
  for (const zonder of [null, undefined, { geladen: false, reden: 'CATALOGUS_ONLEESBAAR', regels: new Map() }]) {
    const dto = toPublicKanaalpost(bron([rij(1), rij(2)]), zonder);
    assert.equal(dto.available, false);
    assert.equal(dto.reason, 'CATALOGUS_ONBESCHIKBAAR');
    assert.deepEqual(dto.rows, []);
    assert.equal(dto.ingehouden, 2, 'wat niet verschijnt hoort geteld te worden, ook hier');
  }
});
