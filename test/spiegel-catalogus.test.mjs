/**
 * SPIEGEL-CATALOGUS — de negen gemeten auditvormen, duurzaam.
 *
 * HERKOMST. De negen `M-NEG`-gevallen hieronder zijn niet bedacht: ze komen letterlijk uit
 * AUD-002, de publicatieketen-audit die een extern venster op `905a300` draaide (42 gevallen, 5
 * conform, 37 afwijkingen). Alle negen bereikten daar de publieke DTO, beide schema's, de HTML én
 * gitleaks. Zelf nagemeten op `3a72950`, de commit waar deze tak op staat: 14 gevallen, 2 door,
 * 12 rood — precies dezelfde uitslag, dus er was in de tussentijd niets gerepareerd.
 *
 * Dat de audit ze vond is niet genoeg. Een audit is een momentopname; wat niet in de eigen CI staat,
 * is de volgende week weer stuk. Daarom staan ze hier, in dit register, met hun eigen zaak-nummers.
 *
 * DE VORM VAN DE PROEF. Elk `M-NEG`-geval biedt een rij aan die niet in de catalogus staat. De
 * proef is niet "de scanner ziet iets verdachts" — dat kán hij niet, en dat is de hele bevinding.
 * De proef is: wat niet vooraf is beoordeeld, verschijnt niet. Daarom hoort er bij elk geval ook een
 * telling: ingehouden mag, stilzwijgend ingehouden niet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toPublicKanaalpost, viertalSleutel, publiekViertalGeldig } from '../scripts/lib/kanaalpost.mjs';
import { laadSpiegelCatalogus } from '../scripts/lib/spiegel-catalogus.mjs';
import { loadDenyTerms } from '../scripts/lib/sanitize.mjs';
import { toPublicSnapshot } from '../scripts/build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Dezelfde termenlijst als de bouw gebruikt. De catalogus keurt zichzelf met `publishVeilig`, en dat
// leunt op deze modulestaat; met een lege lijst zou deze proef milder zijn dan de werkelijkheid.
loadDenyTerms(join(ROOT, 'data/deny-terms.json'), { strict: true });

const GOEDGEKEURD = {
  tab: 'AUDIT', onderwerp: 'Routinecontrole afgerond', status: 'AFGEROND', actie: 'niemand',
};

/**
 * Schrijf een catalogus naar een tijdelijk bestand. De ondergrens van de lader (een instortdetector)
 * wordt gevuld met onschuldige regels, zodat elke proef alleen over zijn eigen geval gaat.
 */
function maakCatalogus(regels, { versie = 1, vulAan = true } = {}) {
  const vulling = vulAan
    ? Array.from({ length: 25 }, (_, i) => ({
      bron: { ...GOEDGEKEURD, onderwerp: `Onschuldige vulregel nummer ${i + 1}` },
    }))
    : [];
  const map = mkdtempSync(join(tmpdir(), 'spiegel-catalogus-'));
  const pad = join(map, 'catalogus.json');
  writeFileSync(pad, JSON.stringify({ versie, regels: [...regels, ...vulling] }));
  return pad;
}

const CATALOGUS = laadSpiegelCatalogus(maakCatalogus([{ bron: GOEDGEKEURD }]));

const rij = (onderwerp, extra = {}) => ({
  ...GOEDGEKEURD, onderwerp, datum: '2026-07-26 10:00', ...extra,
});
const spiegel = (rows) => ({ available: true, reason: null, rows });
const plaat = (rows, catalogus = CATALOGUS) => toPublicKanaalpost(spiegel(rows), catalogus);

test('de proefcatalogus laadt (anders bewijst geen enkel geval hieronder iets)', () => {
  assert.equal(CATALOGUS.geladen, true, CATALOGUS.reden ?? '');
});

test('M-VALID-001 — een vooraf beoordeelde rij verschijnt op de plaat', () => {
  const dto = plaat([rij(GOEDGEKEURD.onderwerp)]);
  assert.equal(dto.available, true);
  assert.equal(dto.rows.length, 1);
  assert.equal(dto.rows[0].onderwerp, GOEDGEKEURD.onderwerp);
  assert.equal(dto.ingehouden, 0);
});

/**
 * De negen vormen uit AUD-002, met hun zaak-nummers. Ze staan als `onderwerp` in de aangeboden rij:
 * dat is het veld met de meeste vrijheid en het veld waar de audit ze aanbood.
 */
const MOET_WEIGEREN = [
  ['M-NEG-001', '$HOME-pad', '$HOME/voorbeeld/poller.py'],
  ['M-NEG-002', 'underscore-sleutelvorm', 'sk_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['M-NEG-003', 'verkorte adresvorm', 'jan@abcdef1'],
  ['M-NEG-004', 'hex-verpakking', 'key@d3b07384d113edec49eaa6238ad5ff00'],
  ['M-NEG-005', 'camelcase-sleutelnaam', 'MySecretToken'],
  ['M-NEG-006', 'synthetische persoonsnaam', 'Jan Jansen'],
  ['M-NEG-007', 'tijdelijk absoluut pad', '/tmp/__B__/pad'],
  ['M-NEG-008', 'systeemroot', '/etc'],
  ['M-NEG-009', 'synthetische codenaamzin', 'Project Saffier gaat vrijdag live'],
];

test('de negen beproefde vormen zijn nog de gemeten vormen uit AUD-002', () => {
  // Zonder deze binding was het register te neutraliseren zonder één regel diff in register.json:
  // vervang de negen aanvalsteksten door negen onschuldige onbekende strings, laat de proefnamen en
  // de asserties staan, en alle achttien verklaarde namen blijven groen terwijl er niets meer wordt
  // beproefd (bevinding review Codex, 26-07-2026). Het register bewaakt AANWEZIGHEID van proeven;
  // deze hash bewaakt de INHOUD van de enige gegevens die niet uit de code zelf komen — de gemeten
  // vormen. Wie ze wil wijzigen moet de hash in test/register.json meeveranderen, en dat is een
  // zichtbare regel in de diff die om een reden vraagt.
  const register = JSON.parse(readFileSync(join(ROOT, 'test/register.json'), 'utf8'));
  const hash = createHash('sha256').update(JSON.stringify(MOET_WEIGEREN)).digest('hex');
  assert.equal(hash, register.auditvormen_sha256,
    'de negen gemeten vormen zijn gewijzigd — pas auditvormen_sha256 in test/register.json aan én zeg waarom');
  assert.equal(MOET_WEIGEREN.length, 9, 'AUD-002 leverde negen dashboard-vormen op');
});

for (const [zaak, naam, waarde] of MOET_WEIGEREN) {
  test(`${zaak} — ${naam} komt niet op de plaat en wordt geteld`, () => {
    const dto = plaat([rij(waarde)]);
    assert.equal(dto.available, false, `${zaak}: vorm werd publiek geprojecteerd`);
    assert.equal(dto.reason, 'INGEHOUDEN');
    assert.equal(dto.ingehouden, 1, `${zaak}: ingehouden, maar niet geteld`);
  });

  test(`${zaak} — ${naam} verdringt een goedgekeurde rij niet`, () => {
    const dto = plaat([rij(GOEDGEKEURD.onderwerp), rij(waarde)]);
    assert.equal(dto.rows.length, 1);
    assert.equal(dto.rows[0].onderwerp, GOEDGEKEURD.onderwerp);
    assert.equal(dto.ingehouden, 1);
  });
}

test('de negen vormen komen nog steeds ONGEMOEID door de patroonscanner — dat is de bevinding', async () => {
  // Zonder dit geval leest de reeks hierboven als "de scanner is aangescherpt". Dat is hij niet, en
  // dat kán hij niet: een codenaam of persoonsnaam raakt geen patroon. Wat de negen tegenhoudt is
  // uitsluitend dat ze niet in de catalogus staan. Slaat deze test ooit om, dan is de conclusie van
  // AUD-002 veranderd en hoort iemand daarnaar te kijken — niet dat er iets stiekem beter werd.
  const { publishVeilig } = await import('../scripts/lib/kanaalpost.mjs');
  for (const [zaak, , waarde] of MOET_WEIGEREN) {
    assert.equal(publishVeilig(waarde), true, `${zaak}: scanner gedraagt zich anders dan gemeten`);
  }
});

test('de plaat toont de tekst UIT de catalogus, niet die uit de bron', () => {
  // Dezelfde regel, maar in de bron met een zero-width space erin. Hij selecteert dezelfde
  // catalogusregel — en wat er uitkomt zijn de bytes van de catalogus, zonder dat teken.
  const zwsp = '​';
  const dto = plaat([rij(`Routinecontrole${zwsp} afgerond`)]);
  assert.equal(dto.rows.length, 1);
  assert.equal(dto.rows[0].onderwerp, GOEDGEKEURD.onderwerp);
  assert.equal(dto.rows[0].onderwerp.includes(zwsp), false);
});

test('een goedgekeurd onderwerp naast een andere status publiceert niet (geen recombinatie)', () => {
  // Het viertal is ondeelbaar. Zou de catalogus drie losse lijsten zijn geweest, dan was deze
  // bewering — goedgekeurd onderwerp, goedgekeurde status, nooit samen gelezen — gewoon verschenen.
  const dto = plaat([rij(GOEDGEKEURD.onderwerp, { status: 'GEBLOKKEERD' })]);
  assert.equal(dto.available, false);
  assert.equal(dto.ingehouden, 1);
});

test('een goedgekeurd onderwerp naast een andere rol publiceert niet', () => {
  const dto = plaat([rij(GOEDGEKEURD.onderwerp, { tab: 'CONTROL' })]);
  assert.equal(dto.available, false);
  assert.equal(dto.ingehouden, 1);
});

test('zonder catalogus verschijnt er niets, en de teller verzwijgt dat niet', () => {
  for (const geen of [undefined, null, { geladen: false, reden: 'CATALOGUS_ONLEESBAAR' }]) {
    const dto = toPublicKanaalpost(spiegel([rij(GOEDGEKEURD.onderwerp), rij('Nog een regel')]), geen);
    assert.equal(dto.available, false);
    assert.equal(dto.reason, 'CATALOGUS_ONBESCHIKBAAR');
    assert.equal(dto.ingehouden, 2);
  }
});

test('een onbereikbare bron blijft een ander geval dan een ontbrekende catalogus', () => {
  const dto = toPublicKanaalpost({ available: false, reason: 'BRON_ONBEREIKBAAR', rows: [] }, CATALOGUS);
  assert.equal(dto.reason, 'BRON_ONBEREIKBAAR');
});

test('de melder krijgt alleen de datum van een ingehouden rij, nooit de tekst', () => {
  const gemeld = [];
  toPublicKanaalpost(spiegel([rij('Project Saffier gaat vrijdag live')]), CATALOGUS, (d) => gemeld.push(d));
  assert.deepEqual(gemeld, ['2026-07-26 10:00']);
  assert.equal(gemeld.join(' ').includes('Saffier'), false);
});

/** Eén foute regel bederft de hele catalogus — er wordt niet stilletjes gefilterd. */
const ONGELDIG = [
  ['onbekende sleutel in een regel', [{ bron: GOEDGEKEURD, notitie: 'iets' }]],
  ['ontbrekend veld in bron', [{ bron: { tab: 'AUDIT', onderwerp: 'x', status: 'AFGEROND' } }]],
  ['leeg veld', [{ bron: { ...GOEDGEKEURD, actie: '' } }]],
  ['geen string', [{ bron: { ...GOEDGEKEURD, actie: 3 } }]],
  ['niet-canonieke bron (markdown)', [{ bron: { ...GOEDGEKEURD, onderwerp: '**vet**' } }]],
  ['niet-canonieke bron (dubbele spatie)', [{ bron: { ...GOEDGEKEURD, onderwerp: 'a  b' } }]],
  ['status buiten de gesloten lijst', [{ bron: { ...GOEDGEKEURD, status: 'BIJNA KLAAR' } }]],
  ['rol die geen rol is', [{ bron: GOEDGEKEURD, publiek: { ...GOEDGEKEURD, tab: 'stack-control' } }]],
  ['publieke waarde langer dan de plaat toelaat', [{ bron: GOEDGEKEURD, publiek: { ...GOEDGEKEURD, onderwerp: 'x'.repeat(601) } }]],
  ['publieke waarde met een onzichtbaar teken', [{ bron: GOEDGEKEURD, publiek: { ...GOEDGEKEURD, onderwerp: 'net​te tekst' } }]],
  ['publieke waarde die een patroon raakt', [{ bron: GOEDGEKEURD, publiek: { ...GOEDGEKEURD, onderwerp: 'zie /Users/iemand/notitie.md' } }]],
  ['twee regels met dezelfde bron', [{ bron: GOEDGEKEURD }, { bron: GOEDGEKEURD }]],
];

for (const [naam, regels] of ONGELDIG) {
  test(`catalogus wordt in zijn geheel geweigerd: ${naam}`, () => {
    const cat = laadSpiegelCatalogus(maakCatalogus(regels));
    assert.equal(cat.geladen, false, `${naam} werd geaccepteerd`);
    assert.equal(cat.reden, 'CATALOGUS_ONGELDIG');
    assert.equal(cat.regels.size, 0);
  });
}

test('een onbekend versienummer laadt niet', () => {
  const cat = laadSpiegelCatalogus(maakCatalogus([{ bron: GOEDGEKEURD }], { versie: 2 }));
  assert.equal(cat.reden, 'CATALOGUS_VERSIE_ONBEKEND');
});

test('een ingestorte catalogus laadt niet', () => {
  const cat = laadSpiegelCatalogus(maakCatalogus([{ bron: GOEDGEKEURD }], { vulAan: false }));
  assert.equal(cat.geladen, false);
});

test('een ontbrekend of onleesbaar bestand laadt niet', () => {
  assert.equal(laadSpiegelCatalogus('/bestaat/echt/niet.json').reden, 'CATALOGUS_ONLEESBAAR');
  const map = mkdtempSync(join(tmpdir(), 'spiegel-catalogus-'));
  const pad = join(map, 'stuk.json');
  writeFileSync(pad, '{ dit is geen json');
  assert.equal(laadSpiegelCatalogus(pad).reden, 'CATALOGUS_ONLEESBAAR');
});

test('de MEEGELEVERDE catalogus laadt en draagt geen van de negen vormen', () => {
  const cat = laadSpiegelCatalogus(join(ROOT, 'data/spiegel-catalogus.json'));
  assert.equal(cat.geladen, true, cat.reden ?? '');
  const alles = JSON.stringify([...cat.regels.values()]);
  for (const [zaak, , waarde] of MOET_WEIGEREN) {
    assert.equal(alles.includes(waarde), false, `${zaak} staat in de meegeleverde catalogus`);
  }
});

test('elke publieke waarde in de meegeleverde catalogus voldoet aan de eisen van de plaat', () => {
  const cat = laadSpiegelCatalogus(join(ROOT, 'data/spiegel-catalogus.json'));
  for (const publiek of cat.regels.values()) {
    assert.equal(publiekViertalGeldig(publiek), true, JSON.stringify(publiek).slice(0, 120));
  }
});

test('de sleutel van een viertal onderscheidt viertallen die alleen in de knip verschillen', () => {
  // Een zelfgekozen scheidingsteken zou `a|b` + `c` niet van `a` + `b|c` kunnen onderscheiden.
  const een = viertalSleutel({ tab: 'A', onderwerp: 'b', status: 'c', actie: 'd' });
  const twee = viertalSleutel({ tab: 'A', onderwerp: 'b|c', status: 'c', actie: 'd' });
  assert.notEqual(een, twee);
});

test('de bouw-reductie geeft de catalogus door, en publiceert zonder catalogus niets', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/raw-snapshot.json'), 'utf8'));
  raw.kanaalpost = spiegel([rij(GOEDGEKEURD.onderwerp)]);
  assert.equal(toPublicSnapshot(raw, {}, CATALOGUS).kanaalpost.rows.length, 1);
  assert.equal(toPublicSnapshot(raw, {}).kanaalpost.reason, 'CATALOGUS_ONBESCHIKBAAR');
});
