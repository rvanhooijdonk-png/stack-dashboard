/**
 * DE ACHT PROEVEN VAN KIJK-FIXEN-V2.
 *
 * Elk van deze acht gevallen is eerst tégen de bestaande waarnemer gelegd (`scripts/kijk-nulmeting.mjs`)
 * en geen enkel geval kreeg daar het juiste antwoord: drie keer VALS GROEN, vier keer GEEN MECHANISME,
 * één keer VERKEERD ROOD. Die uitvoer is de rode uitgangssituatie en staat in het rapport. Wat hier
 * staat is dezelfde acht gevallen tegen de nieuwe lezer.
 *
 * Twee dingen worden bewust NIET nagespeeld met een echte fetch: de tijdrace (proef 2) en de
 * storingsvormen (proef 8). Beide worden ingespoten, want een test die moet hopen dat main toevallig
 * beweegt of dat GitHub toevallig 403 geeft, is geen test maar een observatie.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  leesBronvast, kijkStateUitSpiegel, keurState, manifestVoor, manifestDekt, oordeel,
  momentUitNlTijd, verouderdeLanes, publiekeRegel, kanoniekeBytes, sha256, volledigeSha,
  TOESTANDEN, UITKOMSTEN, LANES, REDENEN, OVERGANG_MERK, KIJK_SCHEMA, KIJK_SLO_MINUTEN,
} from '../scripts/lib/kijk.mjs';
import { DREMPEL_UREN } from '../scripts/lib/waarnemer.mjs';

const KOP_A = 'a'.repeat(40);
const KOP_B = 'b'.repeat(40);
const KOPREGELS = ['| datum-tijd | tab-rol | onderwerp | status | actie voor |',
  '| --- | --- | --- | --- | --- |'].join('\n');
const spiegelMet = (...rijen) => [KOPREGELS, ...rijen].join('\n');
const rij = (datum, tab, onderwerp, status = 'AFGEROND', actie = 'niemand') =>
  `| ${datum} | ${tab} | ${onderwerp} | ${status} | ${actie} |`;

/** Een complete, kloppende lezing: bron op kop A, pagina op kop A, manifest dat de state dekt. */
function opstelling(spiegelTekst, { kop = KOP_A } = {}) {
  const { state, fouten } = kijkStateUitSpiegel(spiegelTekst, { commitSha: kop });
  const { manifest, bytes } = manifestVoor(state, { bronCommitSha: kop, generatedAt: '2026-07-26T18:45:00.000Z' });
  const lezing = { ok: true, sha: kop, tekst: spiegelTekst, blobSha: null, pogingen: 1, geprobeerd: [] };
  const paginaHerkomst = {
    commitSha: kop, stateSha256: manifest.stateSha256, eventHighWatermark: state.eventHighWatermark,
  };
  return {
    state, fouten, manifest, bytes, lezing, paginaHerkomst,
    kijk: (extra = {}) => oordeel({ lezing, paginaHerkomst, state, manifest, stateBytes: bytes, ...extra }),
  };
}

const DRIE_LANES = spiegelMet(
  rij('2026-07-26 17:20', 'CONTROL', 'Een melding van control.'),
  rij('2026-07-26 17:30', 'AUTOPILOT', 'Een melding van autopilot.'),
  rij('2026-07-26 17:45', 'MINI', 'Een melding van de mini.'),
);

// ─────────────────────────────────────────────────────────────────── voorwaarde
// De gelukkige weg moet groen zijn, anders bewijst geen enkele rode proef hieronder iets: een lezer
// die altijd rood is, is net zo nutteloos als een lezer die altijd groen is.

test('een kloppende lezing op één kop is GROEN', () => {
  const o = opstelling(DRIE_LANES).kijk();
  assert.deepEqual(o.redenen, []);
  assert.equal(o.uitkomst, 'GROEN');
});

// ───────────────────────────────────────────────────────────────────── proef 1
test('proef 1 — bron en pagina beide op dezelfde oude commit is ROOD, niet groen', () => {
  // NULMETING: `toets().ok = true`. De oude waarnemer vergeleek pagina met bron; als beide uit
  // dezelfde oude publicatie kwamen was dat onderling consistent en dus groen, terwijl main allang
  // verder stond. Hier is de bron per constructie de ACTUELE kop, dus een pagina op de oude kop valt op.
  const o = opstelling(DRIE_LANES, { kop: KOP_B });
  const oud = oordeel({
    lezing: o.lezing, state: o.state, manifest: o.manifest, stateBytes: o.bytes,
    // De pagina is intern volledig consistent — zij is gebouwd uit precies deze state — maar op de
    // OUDE kop. Alleen de vergelijking met de actuele kop kan dat zien.
    paginaHerkomst: { commitSha: KOP_A, stateSha256: o.manifest.stateSha256, eventHighWatermark: o.state.eventHighWatermark },
  });
  assert.equal(oud.uitkomst, 'ROOD');
  assert.ok(oud.redenen.includes('PAGINA_ANDERE_COMMIT'));
  assert.equal(oud.gemeten.kopSha, KOP_B);
  assert.equal(oud.gemeten.paginaCommitSha, KOP_A);
});

// ───────────────────────────────────────────────────────────────────── proef 2
test('proef 2 — beweegt de kop tijdens de lezing, dan volgt een volledige retry', async () => {
  // NULMETING: GEEN MECHANISME — de oude leesketen deed één fetch op de bewegende ref `…/main/…`,
  // dus er was geen kop om opnieuw te toetsen en de race was per constructie onzichtbaar.
  const koppen = [KOP_A, KOP_B, KOP_B, KOP_B];
  let i = 0;
  const gelezenOp = [];
  const r = await leesBronvast({
    kopVan: async () => ({ ok: true, sha: koppen[i++] }),
    inhoudVan: async (sha) => { gelezenOp.push(sha); return { ok: true, tekst: DRIE_LANES }; },
  });
  assert.equal(r.ok, true);
  assert.equal(r.sha, KOP_B, 'de geldige lezing hoort op de tweede, stabiele kop te staan');
  assert.equal(r.pogingen, 2, 'de eerste poging telt niet mee: de kop bewoog ertussen');
  // De HELE lezing wordt overgedaan, niet alleen de inhoudsfetch: de eerste inhoud is op kop A
  // gehaald en die mag nergens meer in de uitkomst doorwerken.
  assert.deepEqual(gelezenOp, [KOP_A, KOP_B]);
});

test('proef 2 — blijft de kop bewegen, dan is de uitkomst GEEN OORDEEL en nooit een gok', async () => {
  let n = 0;
  const r = await leesBronvast({
    kopVan: async () => ({ ok: true, sha: (n++ % 2 ? KOP_A : KOP_B) }),
    inhoudVan: async () => ({ ok: true, tekst: DRIE_LANES }),
    pogingen: 3,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reden, 'KOP_BEWOOG');
  const o = oordeel({ lezing: r });
  assert.equal(o.uitkomst, 'GEEN OORDEEL');
  assert.deepEqual(o.redenen, ['KOP_BEWOOG']);
});

// ───────────────────────────────────────────────────────────────────── proef 3
test('proef 3 — het productiegeval: 18:40 in de bron, 14:16 op de pagina, mag nooit passeren', () => {
  // NULMETING: `toets().ok = true` met paginaRij 14:16 en bronRij 18:40. Mechanisme: de NL-kolom werd
  // als UTC gelezen, 18:40 leek daardoor in de toekomst te liggen, het respijtvenster schoof één rij
  // op en dan mocht de pagina de rij daaronder tonen.
  const bron = spiegelMet(
    rij('2026-07-26 14:16', 'AUTOPILOT', 'De melding van vanmiddag.'),
    rij('2026-07-26 18:40', 'AUTOPILOT', 'De verse melding die de plaat hoort te tonen.'),
  );
  const paginaBron = spiegelMet(rij('2026-07-26 14:16', 'AUTOPILOT', 'De melding van vanmiddag.'));

  const echt = opstelling(bron);
  const opDePagina = kijkStateUitSpiegel(paginaBron, { commitSha: KOP_A }).state;
  const paginaManifest = manifestVoor(opDePagina, { bronCommitSha: KOP_A, generatedAt: '2026-07-26T16:50:00.000Z' }).manifest;

  const o = oordeel({
    lezing: echt.lezing, state: echt.state, manifest: echt.manifest, stateBytes: echt.bytes,
    paginaHerkomst: {
      commitSha: KOP_A, stateSha256: paginaManifest.stateSha256, eventHighWatermark: opDePagina.eventHighWatermark,
    },
  });
  assert.equal(o.uitkomst, 'ROOD');
  assert.ok(o.redenen.includes('PAGINA_ANDERE_TOESTAND'));
  assert.ok(o.redenen.includes('PAGINA_ANDER_WATERMERK'));

  // En de oorzaak zelf is weg: de NL-kolom wordt echt omgerekend, niet als UTC gelezen.
  // 18:40 NL in de zomer is 16:40 UTC; als UTC lezen zou 18:40Z opleveren, twee uur te laat.
  assert.equal(new Date(momentUitNlTijd('2026-07-26 18:40')).toISOString(), '2026-07-26T16:40:00.000Z');
  // En in de winter is het één uur, niet twee — dus er wordt echt een zone opgezocht.
  assert.equal(new Date(momentUitNlTijd('2026-01-15 18:40')).toISOString(), '2026-01-15T17:40:00.000Z');
});

// ────────────────────────────────────────────── proef 3b (de twee stukjes jaar zonder klok)
test('proef 3b — de zomertijdovergang levert geen sprong achteruit en geen uur uit het niets', () => {
  // Twee keer per jaar bestaat een uur niet en bestaat een uur twee keer. Een omrekening die daar
  // struikelt, geeft precies dezelfde soort fout als de oude rijMoment(): een moment dat verder in de
  // toekomst ligt dan het echt is. Daarom staat het gedrag hier vast in plaats van dat het per
  // toeval goed gaat.
  const ms = (s) => momentUitNlTijd(s);
  const iso = (s) => new Date(ms(s)).toISOString();

  // Sprong vooruit, nacht van 29 maart 2026: 02:00 wordt 03:00, dus 02:30 bestaat niet.
  assert.equal(iso('2026-03-29 01:59'), '2026-03-29T00:59:00.000Z');
  assert.equal(iso('2026-03-29 03:00'), '2026-03-29T01:00:00.000Z');
  // De niet-bestaande tijd verdwijnt niet stil in null en schuift ook niet vóórbij 03:00: het hele
  // ontbrekende uur wordt vastgezet op het moment waarop de klok verspringt.
  assert.equal(iso('2026-03-29 02:30'), '2026-03-29T01:00:00.000Z');
  assert.equal(iso('2026-03-29 02:00'), iso('2026-03-29 03:00'));

  // Sprong terug, nacht van 25 oktober 2026: 02:30 bestaat twee keer. Er wordt consequent de LATE
  // lezing gekozen (CET, +01:00). Dat is een keuze, geen toeval: de vroege lezing zou een rij een uur
  // ouder maken dan hij is, en "ouder" is de kant die stilte-alarm afgaat.
  assert.equal(iso('2026-10-25 02:30'), '2026-10-25T01:30:00.000Z');
  assert.equal(iso('2026-10-25 03:00'), '2026-10-25T02:00:00.000Z');

  // Het eigenlijke contract: over beide overgangen heen loopt de tijd vooruit. Zonder dit zou een
  // latere rij een eerder moment kunnen krijgen, en dan is elke uitspraak over volgorde waardeloos.
  const reeksen = [
    ['2026-03-29 01:00', '2026-03-29 01:59', '2026-03-29 02:30', '2026-03-29 03:00', '2026-03-29 04:00'],
    ['2026-10-25 01:00', '2026-10-25 02:00', '2026-10-25 02:30', '2026-10-25 03:00', '2026-10-25 04:00'],
  ];
  for (const reeks of reeksen) {
    for (let i = 1; i < reeks.length; i += 1) {
      assert.ok(ms(reeks[i]) >= ms(reeks[i - 1]), `${reeks[i]} mag niet vóór ${reeks[i - 1]} liggen`);
    }
  }

  // En een kolom die geen tijd is, levert null — niet een stilzwijgende nul die als 1970 leest.
  assert.equal(momentUitNlTijd('binnenkort'), null);
  assert.equal(momentUitNlTijd(''), null);
  assert.equal(momentUitNlTijd(null), null);
});

// ───────────────────────────────────────────────────────────────────── proef 4
test('proef 4 — een verse pagina met de verkeerde commit of statehash is ROOD', () => {
  // NULMETING: GEEN MECHANISME — `stempelUitHtml()` leverde alleen tijdvelden (iso/utcHhmm/nlHhmm),
  // dus "vers gebouwd uit de verkeerde bron" was niet te onderscheiden van "vers gebouwd uit de goede".
  const o = opstelling(DRIE_LANES);

  const andereHash = oordeel({
    lezing: o.lezing, state: o.state, manifest: o.manifest, stateBytes: o.bytes,
    paginaHerkomst: { commitSha: KOP_A, stateSha256: sha256(Buffer.from('iets anders')), eventHighWatermark: o.state.eventHighWatermark },
  });
  assert.equal(andereHash.uitkomst, 'ROOD');
  assert.ok(andereHash.redenen.includes('PAGINA_ANDERE_TOESTAND'));

  // Een pagina die helemaal geen herkomst draagt — de situatie van vandaag — is ook rood, en met een
  // eigen reden: er valt niets te toetsen, en dat is iets anders dan dat de toets mislukt.
  const zonder = oordeel({
    lezing: o.lezing, state: o.state, manifest: o.manifest, stateBytes: o.bytes,
    paginaHerkomst: { commitSha: null, stateSha256: null, eventHighWatermark: null },
  });
  assert.equal(zonder.uitkomst, 'ROOD');
  assert.deepEqual(zonder.redenen, ['PAGINA_ZONDER_HERKOMST']);

  // Een afgekorte commit telt niet als herkomst: een prefix van zeven tekens kan botsen.
  const kort = oordeel({
    lezing: o.lezing, state: o.state, manifest: o.manifest, stateBytes: o.bytes,
    paginaHerkomst: { commitSha: KOP_A.slice(0, 7), stateSha256: o.manifest.stateSha256, eventHighWatermark: o.state.eventHighWatermark },
  });
  assert.deepEqual(kort.redenen, ['PAGINA_ZONDER_HERKOMST']);
  assert.equal(volledigeSha(KOP_A.slice(0, 7)), false);
});

// ───────────────────────────────────────────────────────────────────── proef 5
test('proef 5 — één stil spoor terwijl de rest doormeldt is PARTIAL, met het spoor erbij', () => {
  // NULMETING: GEEN MECHANISME — het oordeel leverde één boolean `ok` en geen enkel veld per spoor,
  // dus een stille lane verdween in een groen totaaloordeel.
  const bron = spiegelMet(
    rij('2026-07-26 09:00', 'MINI', 'De laatste melding van dit spoor — daarna stilte.'),
    rij('2026-07-26 17:30', 'AUTOPILOT', 'Dit spoor meldt gewoon door.'),
    rij('2026-07-26 17:45', 'CONTROL', 'Dit spoor ook.'),
  );
  const o = opstelling(bron).kijk();
  assert.equal(o.uitkomst, 'PARTIAL');
  assert.deepEqual(o.redenen, ['LANE_VEROUDERD']);
  assert.deepEqual(o.gemeten.verouderdeLanes, ['MINI'], 'het verouderde spoor hoort erbij te staan');

  // PARTIAL is geen synoniem voor rood: de rest van de plaat klopt aantoonbaar wel.
  assert.notEqual(o.uitkomst, 'ROOD');

  // En stilte alleen is géén bevinding. Melden alle sporen even lang niets, dan is dat een rustige
  // nacht en geen afwijking — anders zou de kijk elke ochtend acht valse meldingen produceren.
  const rustig = spiegelMet(
    rij('2026-07-26 09:00', 'MINI', 'Stil sinds vanochtend.'),
    rij('2026-07-26 09:05', 'AUTOPILOT', 'Ook stil sinds vanochtend.'),
  );
  assert.equal(opstelling(rustig).kijk().uitkomst, 'GROEN');
});

// ───────────────────────────────────────────────────────────────────── proef 6
test('proef 6 — vrije klant-, incident- of padtekst haalt de publieke toestand niet', () => {
  // NULMETING: VALS GROEN — de publicatiepoort op deze kop is nog een patroonscanner en liet 2 van de
  // 2 aangeboden vrije-tekstvormen door (AUD-002 bood er negen aan; alle negen kwamen op de plaat).
  // Hier is de vraag anders gesteld: er is geen veld waarin vrije tekst pást.
  const vormen = ['een verkort thuispad ~/klanten/afspraken', 'incident bij Noordwijk BV rond 14:00'];
  const bron = spiegelMet(...vormen.map((v, i) => rij(`2026-07-26 1${i}:00`, 'CONTROL', v)));
  const { state } = kijkStateUitSpiegel(bron, { commitSha: KOP_A });

  const alsTekst = JSON.stringify(state);
  for (const vorm of vormen) {
    assert.ok(!alsTekst.includes(vorm), 'geen enkele vrije tekstvorm hoort in de publieke toestand te staan');
  }
  for (const woord of ['klanten', 'Noordwijk', 'incident', '~/']) {
    assert.ok(!alsTekst.includes(woord), `"${woord}" hoort niet in de publieke toestand te staan`);
  }

  // Elk veld dat er WEL in staat komt uit een vastgelegde lijst.
  for (const lane of Object.values(state.lanes)) {
    assert.ok(LANES.includes(lane.laneId));
    assert.ok(TOESTANDEN.includes(lane.toestand));
    assert.equal(lane.objectId, `${lane.laneId}#${lane.sequence}`);
  }

  // En het schema weigert een toestand die er alsnog langs een andere weg in wordt gezet.
  const besmet = structuredClone(state);
  besmet.lanes.CONTROL.toestand = 'incident bij Noordwijk BV';
  assert.deepEqual(keurState(besmet).fouten, ['TOESTAND_ONBEKEND']);
  const smokkel = structuredClone(state);
  smokkel.lanes.CONTROL.objectId = 'CONTROL#1 — pad ~/klanten';
  assert.deepEqual(keurState(smokkel).fouten, ['VELD_NIET_GESLOTEN']);

  // Ook de publieke regel is niet te vullen met eigen tekst: alles komt uit REDENEN.
  const regel = publiekeRegel({ uitkomst: 'ROOD', redenen: ['PAGINA_ANDERE_COMMIT', 'verzonnen reden'], lanes: ['MINI', 'GEHEIM'] });
  assert.equal(regel.uitleg, `${REDENEN.PAGINA_ANDERE_COMMIT} (MINI)`);
});

// ─────────────────────────────────────────────────── proef 6b (uit de live-lezing)
test('proef 6b — een rij die het gesloten schema niet haalt verdwijnt niet stil maar maakt het ROOD', () => {
  // BEVINDING UIT DE EERSTE LIVE-LEZING (kop 7f9c99c): 41 van de 54 bronrijen vielen buiten de state
  // omdat hun spoor niet in LANES stond — en de uitkomst zei daar niets over. Dat is dezelfde fout als
  // een stille lane: iets ontbreekt en niemand merkt het. Een gesloten lijst mag achterlopen, maar dan
  // hoort de plaat rood te staan tot iemand de lijst bijwerkt, niet groen met minder rijen.
  const bron = spiegelMet(
    rij('2026-07-26 10:00', 'CONTROL', 'Een spoor dat de lijst kent.'),
    rij('2026-07-26 11:00', 'SPOOR-DAT-NIET-BESTAAT', 'Een spoor dat de lijst niet kent.'),
  );
  const { state, fouten } = kijkStateUitSpiegel(bron, { commitSha: KOP_A });

  assert.equal(fouten.length, 1, 'de afgewezen rij wordt geteld');
  assert.equal(state.verworpenRijen, 1, 'en dat aantal staat in de toestand zelf, niet alleen in een lokale variabele');
  assert.equal(Object.keys(state.lanes).length, 1, 'de onbekende rij komt niet in de sporen terecht');

  // De teller telt de rij WEL mee: hij is de appendpositie van het bestand, niet het aantal geaccepteerde
  // rijen. Zou hij alleen geaccepteerde rijen tellen, dan zou een afgewezen rij de stand laten stilstaan
  // en precies het gat maken dat proef 7 moet vangen.
  assert.equal(state.eventHighWatermark, 2);

  assert.deepEqual(keurState(state).fouten, ['VELD_NIET_GESLOTEN'], 'het schema keurt de toestand af zolang er rijen buiten vallen');

  // En de uitkomst volgt: geen groen zolang de state de bron niet dekt.
  const o = opstelling(bron);
  assert.equal(o.kijk().uitkomst, 'ROOD');
  assert.ok(o.kijk().redenen.includes('VELD_NIET_GESLOTEN'));

  // Tegenproef: zonder de onbekende rij is dezelfde opstelling gewoon groen. Zonder deze regel zou de
  // proef ook slagen als de kijk om een heel andere reden nooit meer groen werd.
  const schoon = opstelling(spiegelMet(rij('2026-07-26 10:00', 'CONTROL', 'Een spoor dat de lijst kent.')));
  assert.equal(schoon.state.verworpenRijen, 0);
  assert.equal(schoon.kijk().uitkomst, 'GROEN');
});

// ───────────────────────────────────────────────────────────────────── proef 7
test('proef 7 — een dalende teller is ROOD, ook als bron en pagina overeenkomen', () => {
  // NULMETING: GEEN MECHANISME — er werd niets bewaard tussen twee waarnemingen, dus "de teller daalde"
  // was niet vast te stellen. Bron en pagina kwamen overeen en dus was het groen.
  const o = opstelling(DRIE_LANES);
  assert.equal(o.kijk().uitkomst, 'GROEN', 'zonder getuige is dit dezelfde situatie als in de nulmeting');

  const gedaald = o.kijk({ getuigenis: { sequence: o.state.eventHighWatermark + 5, commitSha: KOP_B, stateSha256: 'x' } });
  assert.equal(gedaald.uitkomst, 'ROOD');
  assert.deepEqual(gedaald.redenen, ['WATERMERK_DAALT']);
  assert.equal(gedaald.gemeten.getuigeAanwezig, true);

  // De tweede vorm van bederf: de toestand verandert terwijl de teller stilstaat. Zonder deze toets
  // kan iemand de geschiedenis herschrijven zonder dat de stand meebeweegt.
  const stilgezet = o.kijk({
    getuigenis: { sequence: o.state.eventHighWatermark, commitSha: KOP_B, stateSha256: sha256(Buffer.from('een andere toestand')) },
  });
  assert.equal(stilgezet.uitkomst, 'ROOD');
  assert.deepEqual(stilgezet.redenen, ['TOESTAND_WISSELT_BIJ_GELIJKE_STAND']);

  // Zonder getuige vervallen deze twee toetsen — maar dat is zichtbaar, niet stilzwijgend.
  assert.equal(o.kijk().gemeten.getuigeAanwezig, false);
});

// ───────────────────────────────────────────────────────────────────── proef 8
test('proef 8 — timeout, 403, 404 en een lege response geven GEEN OORDEEL, nooit gecacht groen', async () => {
  // NULMETING: VERKEERD ROOD — alle vier leverden een AFWIJKING mét een publieke alarmregel, dus een
  // storing in de leesketen werd gepubliceerd als een defect aan de plaat.
  const storingen = [
    ['timeout', { kopVan: async () => ({ ok: false, reden: 'TIMEOUT' }) }],
    ['403', { kopVan: async () => ({ ok: false, reden: 'HTTP_403' }) }],
    ['404 op de inhoud', { kopVan: async () => ({ ok: true, sha: KOP_A }), inhoudVan: async () => ({ ok: false, reden: 'HTTP_404' }) }],
    ['lege response', { kopVan: async () => ({ ok: true, sha: KOP_A }), inhoudVan: async () => ({ ok: false, reden: 'LEEG' }) }],
  ];
  for (const [naam, injectie] of storingen) {
    const r = await leesBronvast({ kopVan: async () => ({ ok: true, sha: KOP_A }), inhoudVan: async () => ({ ok: true, tekst: DRIE_LANES }), ...injectie });
    const o = oordeel({ lezing: r });
    assert.equal(o.uitkomst, 'GEEN OORDEEL', `${naam} hoort GEEN OORDEEL te geven`);
    assert.notEqual(o.uitkomst, 'GROEN');
    // De reden komt uit de gesloten lijst, dus er lekt geen URL of fouttekst naar buiten.
    for (const reden of o.redenen) assert.ok(REDENEN[reden], `${reden} hoort in de gesloten redenenlijst te staan`);
  }

  // Een kop die geen volledige SHA is telt ook niet als kennis.
  const kort = await leesBronvast({ kopVan: async () => ({ ok: true, sha: 'abc1234' }), inhoudVan: async () => ({ ok: true, tekst: DRIE_LANES }) });
  assert.equal(oordeel({ lezing: kort }).redenen[0], 'KOP_ONGELDIG');
});

// ───────────────────────────────────────────── manifest, hash en de OVERGANG-markering

test('het manifest dekt exact de bytes van de toestand, en een hashfout is GEEN OORDEEL', () => {
  const o = opstelling(DRIE_LANES);
  assert.equal(manifestDekt(o.manifest, o.bytes), true);
  assert.equal(o.manifest.stateSha256, sha256(kanoniekeBytes(o.state)));
  assert.equal(manifestDekt(o.manifest, Buffer.from('andere bytes')), false);

  const fout = oordeel({
    lezing: o.lezing, paginaHerkomst: o.paginaHerkomst, state: o.state,
    manifest: { ...o.manifest, stateSha256: sha256(Buffer.from('mis')) }, stateBytes: o.bytes,
  });
  assert.equal(fout.uitkomst, 'GEEN OORDEEL');
  assert.deepEqual(fout.redenen, ['HASHFOUT']);
});

test('de toestand draagt het OVERGANG-merk zolang de bron de spiegel is, niet task_events', () => {
  // Het addendum verbiedt een eigen event-systeem; de vertaling uit de spiegel is tijdelijk en moet
  // als zodanig herkenbaar zijn in het bestand ZELF én in het manifest, zodat geen enkele lezer denkt
  // dat hij de kanonieke bron al leest.
  const o = opstelling(DRIE_LANES);
  assert.equal(o.state.bronSoort, OVERGANG_MERK);
  assert.equal(o.manifest.bronSoort, OVERGANG_MERK);
  assert.match(OVERGANG_MERK, /OVERGANG/);
  assert.equal(o.state.schemaVersie, KIJK_SCHEMA);
  assert.equal(o.manifest.schemaVersie, KIJK_SCHEMA);
});

test('de zes canonieke toestanden zijn een gesloten lijst, een zevende waarde wordt geweigerd', () => {
  assert.deepEqual(TOESTANDEN, ['MERGEABLE', 'WACHT OP AKKOORD', 'GEBLOKKEERD', 'MERGED', 'EFFECT-BEWEZEN', 'LEEG']);
  const { state } = kijkStateUitSpiegel(DRIE_LANES, { commitSha: KOP_A });
  assert.equal(keurState(state).ok, true);
  const zevende = structuredClone(state);
  zevende.lanes.CONTROL.toestand = 'BIJNA KLAAR';
  assert.equal(keurState(zevende).ok, false);
});

test('de overgang verzint geen toestand die de spiegel niet kent', () => {
  // De spiegel onderscheidt MERGEABLE, MERGED en EFFECT-BEWEZEN niet; `AFGEROND` wordt daarom LEEG en
  // niet een van die drie. Dat verlies is het argument voor de koppeltaak naar task_events.
  const { state } = kijkStateUitSpiegel(spiegelMet(
    rij('2026-07-26 17:00', 'CONTROL', 'Een afgeronde melding.', 'AFGEROND'),
    rij('2026-07-26 17:05', 'MINI', 'Een geblokkeerde melding.', 'GEBLOKKEERD'),
    rij('2026-07-26 17:10', 'AUTOPILOT', 'Een melding die wacht.', 'WACHT OP AKKOORD'),
  ), { commitSha: KOP_A });
  assert.equal(state.lanes.CONTROL.toestand, 'LEEG');
  assert.equal(state.lanes.MINI.toestand, 'GEBLOKKEERD');
  assert.equal(state.lanes.AUTOPILOT.toestand, 'WACHT OP AKKOORD');
  // De event-uitkomst staat los van de toestand en is expliciet GEEN, niet stilzwijgend afwezig.
  assert.equal(state.lanes.CONTROL.eventUitkomst, 'GEEN');
});

test('de teller is de appendpositie, dus een regel met een oudere tijd verlaagt hem niet', () => {
  // Niet-chronologische appendvolgorde is een van de vier manieren waarop de oude waarnemer vals groen
  // gaf. Door op de POSITIE te tellen kan een ingevoegde oudere regel de stand niet terugzetten.
  const { state } = kijkStateUitSpiegel(spiegelMet(
    rij('2026-07-26 17:00', 'CONTROL', 'Eerst toegevoegd.'),
    rij('2026-07-26 08:00', 'MINI', 'Later toegevoegd, maar met een oudere tijd.'),
  ), { commitSha: KOP_A });
  assert.equal(state.eventHighWatermark, 2);
  assert.equal(state.lanes.MINI.sequence, 2, 'de laatst toegevoegde regel heeft de hoogste stand');
  assert.ok(Date.parse(state.lanes.MINI.momentUtc) < Date.parse(state.lanes.CONTROL.momentUtc));
});

test('het korte kijk-venster is streng gescheiden van het 15-uurs gezondheidscontract', () => {
  // Hergebruik van de vijftien uur zou betekenen dat een "kijk" een pagina van veertien uur oud groen
  // noemt. Het zijn twee verschillende vragen en ze hebben twee verschillende getallen.
  assert.equal(DREMPEL_UREN, 15);
  assert.ok(KIJK_SLO_MINUTEN * 60 * 1000 < DREMPEL_UREN * 3600 * 1000);
  assert.equal(KIJK_SLO_MINUTEN, 20);
});

test('elke uitkomst en elke reden komt uit een gesloten lijst', () => {
  assert.deepEqual(UITKOMSTEN, ['GROEN', 'PARTIAL', 'ROOD', 'GEEN OORDEEL']);
  for (const zin of Object.values(REDENEN)) {
    assert.equal(typeof zin, 'string');
    // Geen pad, geen adres, geen commit in een publieke zin.
    assert.ok(!/[/~@]|https?:|[0-9a-f]{7,}/.test(zin), `deze zin hoort geen herkenbaar detail te bevatten: ${zin}`);
  }
  assert.equal(publiekeRegel({ uitkomst: 'VERZONNEN', redenen: [] }), null);
  assert.equal(publiekeRegel({ uitkomst: 'GROEN', redenen: [] }).uitleg, 'de kijk kwam overeen met de bron');
});

test('verouderde sporen worden aan het jongste spoor gemeten, niet aan de klok', () => {
  const { state } = kijkStateUitSpiegel(spiegelMet(
    rij('2026-07-20 09:00', 'MINI', 'Lang geleden.'),
    rij('2026-07-20 17:00', 'CONTROL', 'Acht uur later.'),
  ), { commitSha: KOP_A });
  // Beide regels zijn dagen oud, maar onderling acht uur uit elkaar: dat is de bevinding, en de
  // absolute ouderdom hoort hier niet mee te tellen.
  assert.deepEqual(verouderdeLanes(state), ['MINI']);
  assert.deepEqual(verouderdeLanes(state, 12 * 3600 * 1000), []);
});

// ──────────────────────────────────────────────────────── de reviewronde op 579ad57
// Wat hieronder staat komt niet uit de opdracht maar uit de dubbele review op kop 579ad57. Codex gaf
// BLOKKEREND ("een onleesbare bron kan als geldige lege state eindigen en uiteindelijk GROEN worden"),
// Gemini wees op dezelfde familie langs een andere weg (een weggelaten manifest sloeg de hele
// hashcontrole stil over). Beide zijn eerst nagespeeld en klopten. Elke reparatie krijgt hier zijn
// eigen proef, want een mutatieproef bewijst dat de acht ankers dragen — niet dat het gat dicht is.

test('reviewgat 1 — een onleesbare of lege bron eindigt nooit als groene lege toestand', () => {
  // Codex' geval, letterlijk: een bron waar geen enkele regel uit te halen valt. Dat is geen systeem
  // waarin niets gebeurde; het is een lezing die mislukte, en die twee mogen niet op elkaar lijken.
  for (const tekst of ['dit is geen tabel en zal het ook nooit worden', '', '   \n\n  ']) {
    const { state } = kijkStateUitSpiegel(tekst, { commitSha: KOP_A });
    const { manifest, bytes } = manifestVoor(state, { bronCommitSha: KOP_A, generatedAt: '2026-07-26T18:45:00.000Z' });
    const o = oordeel({
      lezing: { ok: true, sha: KOP_A, tekst, blobSha: null, pogingen: 1, geprobeerd: [] },
      paginaHerkomst: { commitSha: KOP_A, stateSha256: manifest.stateSha256, eventHighWatermark: 0 },
      state, manifest, stateBytes: bytes,
    });
    assert.notEqual(o.uitkomst, 'GROEN', `deze bron mag geen groen opleveren: ${JSON.stringify(tekst)}`);
    assert.equal(o.uitkomst, 'ROOD');
    assert.ok(o.redenen.includes('GEEN_SPOREN'), `verwacht GEEN_SPOREN, kreeg ${o.redenen.join(', ')}`);
  }
});

test('reviewgat 2 — een weggelaten bewijsstuk slaat geen controle over maar stopt het oordeel', () => {
  // Gemini's geval. De hashcontroles stonden achter `if (manifest && stateBytes && …)`, dus wie het
  // manifest wegliet kreeg een pagina met een verzonnen toestandshash alsnog groen terug. Onwetendheid
  // die zich als kennis voordoet is precies wat deze hele lezer moest afschaffen.
  const g = opstelling(DRIE_LANES);
  const verzonnen = { commitSha: KOP_A, stateSha256: 'f'.repeat(64), eventHighWatermark: g.state.eventHighWatermark };
  for (const weggelaten of [{ manifest: null }, { stateBytes: null }, { state: null }]) {
    const o = oordeel({
      lezing: g.lezing, paginaHerkomst: verzonnen, state: g.state, manifest: g.manifest, stateBytes: g.bytes,
      ...weggelaten,
    });
    assert.equal(o.uitkomst, 'GEEN OORDEEL', `weglaten van ${Object.keys(weggelaten)[0]} gaf ${o.uitkomst}`);
    assert.ok(o.redenen.includes('BEWIJS_ONVOLLEDIG'));
  }
  // En mét alle stukken is diezelfde verzonnen hash gewoon rood — het gat zat in het weglaten, niet
  // in de vergelijking zelf.
  assert.equal(g.kijk({ paginaHerkomst: verzonnen }).uitkomst, 'ROOD');
});

test('reviewgat 3 — de bytes zijn aan DEZE toestand vastgemaakt, niet aan een toestand', () => {
  // De hashketen klopte van manifest tot bytes, maar nergens was vastgelegd dat het object dat
  // beoordeeld werd hetzelfde object was als de bytes die gehasht zijn. Aanleveren van de bytes van A
  // bij de toestand van B liet de hele ketting kloppen.
  const a = opstelling(DRIE_LANES);
  const b = opstelling(spiegelMet(rij('2026-07-26 17:20', 'CONTROL', 'Een andere bron.')));
  const o = oordeel({
    lezing: a.lezing, paginaHerkomst: a.paginaHerkomst, state: b.state, manifest: a.manifest, stateBytes: a.bytes,
  });
  assert.equal(o.uitkomst, 'GEEN OORDEEL');
  assert.ok(o.redenen.includes('TOESTAND_NIET_BIJ_BYTES'));
});

test('reviewgat 4 — een veld dat het schema niet kent is rood, ook als het onschuldig oogt', () => {
  // Zonder gesloten sleutellijst kon er een veld bijkomen dat de keuring niet toetst. Dat is de weg
  // waarlangs vrije tekst binnenkomt langs een veld dat "technisch" heet.
  const g = opstelling(DRIE_LANES);
  const extraBovenin = { ...g.state, notitie: 'klant Van der Berg belde' };
  assert.deepEqual(keurState(extraBovenin).fouten, ['VELD_NIET_GESLOTEN']);
  const extraInLane = {
    ...g.state,
    lanes: { ...g.state.lanes, CONTROL: { ...g.state.lanes.CONTROL, opmerking: '/Users/richard/geheim' } },
  };
  assert.deepEqual(keurState(extraInLane).fouten, ['VELD_NIET_GESLOTEN']);
});

test('reviewgat 5 — valt ALLES tegelijk stil, dan is de onderlinge afstand nul en toch niet groen', () => {
  // De onderlinge meting is bewust relatief, en juist daardoor blind voor de totale uitval: stoppen
  // alle sporen op hetzelfde moment, dan is er geen enkel verouderd spoor. Beide reviewers wezen hier
  // onafhankelijk op. De absolute vloer geldt alleen mét een meegegeven klok.
  const g = opstelling(DRIE_LANES);
  const jongste = Math.max(...Object.values(g.state.lanes).map((l) => Date.parse(l.momentUtc)));
  const veelLater = jongste + 30 * 3600 * 1000;
  const stil = g.kijk({ nu: veelLater });
  assert.equal(stil.uitkomst, 'PARTIAL');
  assert.ok(stil.redenen.includes('ALLES_STIL'));
  assert.deepEqual(stil.gemeten.verouderdeLanes, ['AUTOPILOT', 'CONTROL', 'MINI']);
  // Kort na de laatste melding is het gewoon groen, en zónder klok wordt er geen uitspraak over de
  // klok gedaan — dat blijft het gedrag van vandaag, niet stilzwijgend rood.
  assert.equal(g.kijk({ nu: jongste + 60 * 1000 }).uitkomst, 'GROEN');
  assert.equal(g.kijk().uitkomst, 'GROEN');
});

test('reviewgat 6 — een datum die niet bestaat levert geen tijdstip op', () => {
  // `new Date('2026-02-30T…')` rolt stilzwijgend door naar 2 maart. Een niet-bestaande datum werd zo
  // een geldig moment, en dat moment kon een teller of een stiltemeting sturen.
  assert.equal(momentUitNlTijd('2026-02-30 12:00'), null);
  assert.equal(momentUitNlTijd('2026-13-01 12:00'), null);
  assert.equal(momentUitNlTijd('2026-07-26 25:00'), null);
  assert.equal(momentUitNlTijd('2026-07-26 12:61'), null);
  assert.equal(momentUitNlTijd('2026-07-26 12:00'), Date.parse('2026-07-26T10:00:00.000Z'));
});
