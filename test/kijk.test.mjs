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
import { readFileSync } from 'node:fs';

import {
  leesBronvast, kijkStateUitSpiegel, keurState, keurManifest, manifestVoor, manifestDekt, oordeel,
  momentUitNlTijd, verouderdeLanes, publiekeRegel, kanoniekeBytes, sha256, volledigeSha,
  TOESTANDEN, UITKOMSTEN, LANES, REDENEN, OVERGANG_MERK, KIJK_SCHEMA, KIJK_SLO_MINUTEN,
} from '../scripts/lib/kijk.mjs';
import { DREMPEL_UREN } from '../scripts/lib/waarnemer.mjs';
import { spiegelScan } from '../scripts/lib/kanaalpost.mjs';

const KOP_A = 'a'.repeat(40);
const KOP_B = 'b'.repeat(40);
const KOPREGELS = ['| datum-tijd | tab-rol | onderwerp | status | actie voor |',
  '| --- | --- | --- | --- | --- |'].join('\n');
const spiegelMet = (...rijen) => [KOPREGELS, ...rijen].join('\n');
const rij = (datum, tab, onderwerp, status = 'AFGEROND', actie = 'niemand') =>
  `| ${datum} | ${tab} | ${onderwerp} | ${status} | ${actie} |`;

/** Een vast "nu", net ná de jongste rij van DRIE_LANES: geen stilte, geen tijd uit de toekomst. */
const NU = Date.parse('2026-07-26T16:00:00.000Z');

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
    // De klok hoort er standaard bij: sinds de derde review is een ontbrekende klok zelf een uitkomst
    // (GEEN OORDEEL / KLOK_ONBEKEND), dus zonder deze regel zou elke proef hieronder daarop stranden in
    // plaats van op wat hij wil meten. Proef 19 zet hem juist expliciet weer uit.
    kijk: (extra = {}) => oordeel({ lezing, paginaHerkomst, state, manifest, stateBytes: bytes, nu: NU, ...extra }),
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
    lezing: o.lezing, state: o.state, manifest: o.manifest, stateBytes: o.bytes, nu: NU,
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
    lezing: echt.lezing, state: echt.state, manifest: echt.manifest, stateBytes: echt.bytes, nu: NU,
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
test('proef 3b — de zomertijdovergang levert geen verzonnen moment op', () => {
  // Twee keer per jaar bestaat een uur niet en bestaat een uur twee keer. Een omrekening die daar
  // struikelt, geeft precies dezelfde soort fout als de oude rijMoment(): een moment dat verder in de
  // toekomst ligt dan het echt is. Daarom staat het gedrag hier vast in plaats van dat het per
  // toeval goed gaat.
  const ms = (s) => momentUitNlTijd(s);
  const iso = (s) => new Date(ms(s)).toISOString();

  // Gewone uren aan beide kanten van beide overgangen: gewoon omgerekend, zomertijd én wintertijd.
  assert.equal(iso('2026-03-29 01:59'), '2026-03-29T00:59:00.000Z');
  assert.equal(iso('2026-03-29 03:00'), '2026-03-29T01:00:00.000Z');
  assert.equal(iso('2026-10-25 01:00'), '2026-10-24T23:00:00.000Z', 'nog zomertijd: de klok gaat pas om 03:00 terug');
  assert.equal(iso('2026-10-25 03:00'), '2026-10-25T02:00:00.000Z');

  // DIT IS DE KERN, en het is een herziening van wat hier eerst stond. De vorige opzet gaf de twee
  // stukjes jaar zonder klok tóch een antwoord: het niet-bestaande 02:30 werd op de sprong vastgezet
  // (01:00 UTC) en het dubbele 02:30 kreeg stilzwijgend de late lezing (01:30 UTC), met als
  // verantwoording dat de reeks dan niet achteruit loopt. Dat verruilde één fout voor een ergere: de
  // bron zegt niet WELKE van de twee, en bij een gat zegt de bron iets dat niet bestaat, dus beide
  // antwoorden waren verzonnen — en een uur ernaast is precies genoeg om een spoor "vers" te noemen
  // dat het niet is. Gemeten uitwerking van het oude gedrag: beide rijen werden zonder één opmerking
  // geaccepteerd, verworpen 0. Onwetendheid hoort hier hetzelfde te doen als overal elders in deze
  // module: zich melden.
  assert.equal(ms('2026-03-29 02:30'), null, 'die tijd heeft nooit bestaan');
  assert.equal(ms('2026-10-25 02:30'), null, 'die tijd bestond twee keer');

  // En dat blijft niet binnen de omrekening hangen: de rij wordt VERWORPEN, telt zichtbaar mee als
  // afkeuring, en daarmee wordt de uitkomst rood in plaats van dat er een uur wordt gegokt.
  for (const wandklok of ['2026-03-29 02:30', '2026-10-25 02:30']) {
    const { state } = kijkStateUitSpiegel(spiegelMet(rij(wandklok, 'CONTROL', 'Een rij zonder klok.')), { commitSha: KOP_A });
    assert.equal(state.verworpenRijen, 1, `${wandklok} hoort verworpen te zijn`);
    assert.equal(state.lanes.CONTROL, undefined);
  }

  // Het contract dat overblijft: over beide overgangen heen loopt de tijd vooruit voor élk moment dat
  // wél bestaat. Zonder dit zou een latere rij een eerder moment kunnen krijgen, en dan is elke
  // uitspraak over volgorde waardeloos.
  const reeksen = [
    ['2026-03-29 01:00', '2026-03-29 01:59', '2026-03-29 03:00', '2026-03-29 04:00'],
    ['2026-10-25 01:00', '2026-10-25 01:30', '2026-10-25 03:00', '2026-10-25 04:00'],
  ];
  for (const reeks of reeksen) {
    for (let i = 1; i < reeks.length; i += 1) {
      assert.ok(ms(reeks[i]) !== null, `${reeks[i]} bestaat en hoort een moment te hebben`);
      assert.ok(ms(reeks[i]) > ms(reeks[i - 1]), `${reeks[i]} mag niet vóór ${reeks[i - 1]} liggen`);
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
    lezing: o.lezing, state: o.state, manifest: o.manifest, stateBytes: o.bytes, nu: NU,
    paginaHerkomst: { commitSha: KOP_A, stateSha256: sha256(Buffer.from('iets anders')), eventHighWatermark: o.state.eventHighWatermark },
  });
  assert.equal(andereHash.uitkomst, 'ROOD');
  assert.ok(andereHash.redenen.includes('PAGINA_ANDERE_TOESTAND'));

  // Een pagina die helemaal geen herkomst draagt — de situatie van vandaag — is ook rood, en met een
  // eigen reden: er valt niets te toetsen, en dat is iets anders dan dat de toets mislukt.
  const zonder = oordeel({
    lezing: o.lezing, state: o.state, manifest: o.manifest, stateBytes: o.bytes, nu: NU,
    paginaHerkomst: { commitSha: null, stateSha256: null, eventHighWatermark: null },
  });
  assert.equal(zonder.uitkomst, 'ROOD');
  assert.deepEqual(zonder.redenen, ['PAGINA_ZONDER_HERKOMST']);

  // Een afgekorte commit telt niet als herkomst: een prefix van zeven tekens kan botsen.
  const kort = oordeel({
    lezing: o.lezing, state: o.state, manifest: o.manifest, stateBytes: o.bytes, nu: NU,
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
  // Gemeten binnen de absolute vloer: een half uur na de laatste melding is gelijkmatige stilte geen
  // bevinding. Dit stond hier eerst zónder klok, en dat maakte de proef ongevoelig voor de vloer.
  assert.equal(opstelling(rustig).kijk({ nu: Date.parse('2026-07-26T07:35:00.000Z') }).uitkomst, 'GROEN');
  // En vér voorbij die vloer is diezelfde gelijkmatige stilte wél een bevinding — dat is precies wat
  // reviewgat 5 toevoegde. De twee horen bij elkaar: gelijkmatig zwijgen is pas een afwijking als het
  // lang genoeg duurt, en dan is het geen relatieve maar een absolute.
  const laat = opstelling(rustig).kijk({ nu: Date.parse('2026-07-27T07:35:00.000Z') });
  assert.equal(laat.uitkomst, 'PARTIAL');
  assert.deepEqual(laat.redenen, ['ALLES_STIL']);
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

  // En de uitkomst volgt: geen groen zolang de state de bron niet dekt. Beide metingen hieronder staan
  // op dezelfde klok, binnen de absolute stiltevloer — anders zou het verschil tussen ROOD en GROEN
  // net zo goed uit de verstreken tijd kunnen komen als uit de verworpen rij.
  const nuKort = Date.parse('2026-07-26T12:00:00.000Z');
  const o = opstelling(bron);
  assert.equal(o.kijk({ nu: nuKort }).uitkomst, 'ROOD');
  assert.ok(o.kijk({ nu: nuKort }).redenen.includes('VELD_NIET_GESLOTEN'));

  // Tegenproef: zonder de onbekende rij is dezelfde opstelling gewoon groen. Zonder deze regel zou de
  // proef ook slagen als de kijk om een heel andere reden nooit meer groen werd.
  const schoon = opstelling(spiegelMet(rij('2026-07-26 10:00', 'CONTROL', 'Een spoor dat de lijst kent.')));
  assert.equal(schoon.state.verworpenRijen, 0);
  assert.equal(schoon.kijk({ nu: nuKort }).uitkomst, 'GROEN');
});

// ───────────────────────────────────────────────────────────────────── proef 7
test('proef 7 — een dalende teller is ROOD, ook als bron en pagina overeenkomen', () => {
  // NULMETING: GEEN MECHANISME — er werd niets bewaard tussen twee waarnemingen, dus "de teller daalde"
  // was niet vast te stellen. Bron en pagina kwamen overeen en dus was het groen.
  const o = opstelling(DRIE_LANES);
  assert.equal(o.kijk().uitkomst, 'GROEN', 'zonder getuige is dit dezelfde situatie als in de nulmeting');

  // De hash hieronder is een echte hash en niet meer de plaatshouder `'x'` die hier eerst stond: een
  // getuigenis is bewijs, en onleesbaar bewijs wordt sinds deze ronde geweigerd (zie reviewgat 21).
  const gedaald = o.kijk({
    getuigenis: { sequence: o.state.eventHighWatermark + 5, commitSha: KOP_B, stateSha256: sha256(Buffer.from('vorige keer')) },
  });
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
    lezing: o.lezing, paginaHerkomst: o.paginaHerkomst, state: o.state, nu: NU,
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
      state, manifest, stateBytes: bytes, nu: NU,
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
      lezing: g.lezing, paginaHerkomst: verzonnen, state: g.state, manifest: g.manifest, stateBytes: g.bytes, nu: NU,
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
    lezing: a.lezing, paginaHerkomst: a.paginaHerkomst, state: b.state, manifest: a.manifest, stateBytes: a.bytes, nu: NU,
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

test('reviewgat 7 — een rij die de vormtoets niet haalt verdwijnt niet vóór de teller hem ziet', () => {
  // De tweede reviewronde (kop 31984b5) legde een gat bloot dat een laag hoger zat dan alle vorige:
  // de vormtoets van de spiegel gooide een rij met een niet-bestaande datum weg vóórdat de kijk hem
  // ooit zag. Gemeten gevolg: twee bronrijen leverden één spoor met teller 1, en de toestand verried
  // niets. Dat is dezelfde stille verdwijning als de 41 van de 54, maar dan buiten bereik van de
  // controle die daarvoor gebouwd was.
  const tekst = spiegelMet(
    rij('2026-02-30 12:00', 'CONTROL', 'Deze datum bestaat niet.'),
    rij('2026-07-26 17:00', 'MINI', 'Deze wel.'),
  );
  const { state, fouten } = kijkStateUitSpiegel(tekst, { commitSha: KOP_A });
  assert.equal(state.eventHighWatermark, 2, 'de afgekeurde rij houdt zijn positie bezet');
  assert.equal(state.lanes.MINI.sequence, 2, 'de rij erna schuift niet op naar positie 1');
  assert.equal(state.verworpenRijen, 1);
  assert.ok(fouten.includes('VELD_NIET_GESLOTEN'));
  assert.equal(Object.keys(state.lanes).length, 1);

  const { manifest, bytes } = manifestVoor(state, { bronCommitSha: KOP_A, generatedAt: '2026-07-26T18:45:00.000Z' });
  const o = oordeel({
    lezing: { ok: true, sha: KOP_A, tekst, blobSha: null, pogingen: 1, geprobeerd: [] },
    paginaHerkomst: { commitSha: KOP_A, stateSha256: manifest.stateSha256, eventHighWatermark: 2 },
    state, manifest, stateBytes: bytes, nu: NU,
  });
  assert.equal(o.uitkomst, 'ROOD');
});

test('reviewgat 8 — een spoor zonder tijd bestaat niet, dus geen toestand zonder één enkele tijd', () => {
  // Gemini's tweede pad: een toestand waarin élk spoor een lege tijd draagt glipt langs iedere
  // stiltemeting, want die meet niets als er niets te meten valt. De reparatie zit bij de bron: een
  // rij waarover de twee lezers het oneens zijn wordt verworpen in plaats van als spoor-zonder-tijd
  // bewaard. Elk spoor in de toestand draagt dus een tijd, en de meting heeft altijd houvast.
  const { state } = kijkStateUitSpiegel(DRIE_LANES, { commitSha: KOP_A });
  for (const lane of Object.values(state.lanes)) {
    assert.match(lane.momentUtc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
  // En een bron waarin geen enkele rij een leesbare tijd heeft, levert geen toestand met sporen op.
  const geen = kijkStateUitSpiegel(spiegelMet(
    rij('2026-02-30 12:00', 'CONTROL', 'Bestaat niet.'),
    rij('2026-02-30 13:00', 'MINI', 'Bestaat ook niet.'),
  ), { commitSha: KOP_A });
  assert.deepEqual(Object.keys(geen.state.lanes), []);
  assert.ok(geen.state.verworpenRijen > 0);

  // Het bovenstaande dekt de weg via de spiegel. `oordeel()` krijgt de toestand echter AANGELEVERD, en
  // langs die ingang stond de vormtoets een lege tijd nog toe. Gemeten vóór de reparatie: twee sporen
  // van een halfjaar oud met `momentUtc: null` gaven `keurState ok:true` en daarna GROEN met een lege
  // redenenlijst. De stiltemeting rekent immers over de tijden die er zijn.
  const oudeTekst = spiegelMet(
    rij('2026-01-02 09:00', 'CONTROL', 'Oud.'),
    rij('2026-01-02 09:10', 'MINI', 'Ook oud.'),
  );
  const { state: zonderTijd } = kijkStateUitSpiegel(oudeTekst, { commitSha: KOP_A });
  for (const lane of Object.values(zonderTijd.lanes)) lane.momentUtc = null;
  assert.deepEqual(keurState(zonderTijd).fouten, ['VELD_NIET_GESLOTEN']);

  // De hele bewijsketen wordt om de aangeleverde toestand heen opnieuw gesloten, zodat er niets anders
  // dan de ontbrekende tijd overblijft om het oordeel te kunnen tegenhouden. Deze meting kwam vóór de
  // bronbinding uit reviewgat 14 op VELD_NIET_GESLOTEN; sindsdien valt hij een poort eerder om, want
  // een met de hand aangepaste toestand volgt niet meer uit de gelezen tekst. Dat is strenger, niet
  // zwakker, en het staat hier zo opgeschreven omdat de vormtoets daarmee NIET overbodig wordt: zodra
  // de exporter uit task_events publiceert vervalt het OVERGANG-merk en daarmee de herleiding, en dan
  // is `keurState` hierboven het enige dat een spoor zonder tijd nog tegenhoudt.
  const m = manifestVoor(zonderTijd, { bronCommitSha: KOP_A, generatedAt: '2026-07-26T18:45:00.000Z' });
  const halfjaarLater = oordeel({
    lezing: { ok: true, sha: KOP_A, tekst: oudeTekst, blobSha: null, pogingen: 1, geprobeerd: [] },
    paginaHerkomst: { commitSha: KOP_A, stateSha256: m.manifest.stateSha256, eventHighWatermark: zonderTijd.eventHighWatermark },
    state: zonderTijd, manifest: m.manifest, stateBytes: m.bytes, nu: Date.parse('2026-07-26T15:30:00.000Z'),
  });
  assert.equal(halfjaarLater.uitkomst, 'GEEN OORDEEL');
  assert.ok(halfjaarLater.redenen.includes('TOESTAND_NIET_BIJ_BRON'));
});

test('reviewgat 9 — de bewijsketen zit vast aan de bron die gelezen is, niet alleen aan zichzelf', () => {
  // Codex' zwaarste overgebleven route. Manifest ↔ bytes ↔ toestand sloten perfect op elkaar aan,
  // maar nergens lag vast dat die keten iets zei over de lezing ernaast. Lezing op kop A, alle
  // bewijsstukken van kop B, en een pagina die netjes A als commit en B als hash noemde: groen.
  const a = opstelling(DRIE_LANES, { kop: KOP_A });
  const b = opstelling(DRIE_LANES, { kop: KOP_B });
  const o = oordeel({
    lezing: a.lezing,
    paginaHerkomst: { commitSha: KOP_A, stateSha256: b.manifest.stateSha256, eventHighWatermark: b.state.eventHighWatermark },
    state: b.state, manifest: b.manifest, stateBytes: b.bytes, nu: NU,
  });
  assert.equal(o.uitkomst, 'GEEN OORDEEL');
  assert.ok(o.redenen.includes('TOESTAND_NIET_BIJ_BRON'));

  // Tweede route langs dezelfde poort, en deze is ná de bronbinding van reviewgat 14 de enige die er
  // nog doorheen kan: de TOESTAND komt netjes uit de gelezen tekst, maar het MANIFEST noemt een andere
  // commit. De controlesom van het manifest dekt de state-bytes, niet zijn eigen herkomstveld — dat
  // veld kan dus ongestraft liegen, en het gaat wél publiek mee. Gemeten met deze poort eruit: GROEN,
  // met een manifest dat naar een commit wijst die nooit gelezen is.
  const scheefManifest = manifestVoor(a.state, { bronCommitSha: KOP_B, generatedAt: '2026-07-26T18:45:00.000Z' });
  const m2 = oordeel({
    lezing: a.lezing,
    paginaHerkomst: { commitSha: KOP_A, stateSha256: scheefManifest.manifest.stateSha256, eventHighWatermark: a.state.eventHighWatermark },
    state: a.state, manifest: scheefManifest.manifest, stateBytes: scheefManifest.bytes, nu: NU,
  });
  assert.equal(m2.uitkomst, 'GEEN OORDEEL');
  assert.ok(m2.redenen.includes('TOESTAND_NIET_BIJ_BRON'));
});

test('reviewgat 10 — de sleutels zijn gesloten én de waarden erachter ook', () => {
  // Een gesloten sleutellijst zonder waardedomein liet dit door: de zeven afgesproken sleutels, met
  // een klantnaam en een pad als waarde. Precies de tekst die nooit publiek mag worden, langs de
  // controle die daarvoor gebouwd was.
  const { state } = opstelling(DRIE_LANES);
  for (const [veld, waarde] of [
    ['bronSoort', 'klant Van der Berg'],
    ['bronCommitSha', '/Users/richard/geheim'],
    ['eventCount', 'incident bij een klant'],
  ]) {
    const vies = { ...state, [veld]: waarde };
    assert.deepEqual(keurState(vies).fouten, ['VELD_NIET_GESLOTEN'], `${veld} hoort een domein te hebben`);
    // En de tekst mag ook nergens langs de publieke regel naar buiten komen.
    const regel = publiekeRegel({ uitkomst: 'ROOD', redenen: keurState(vies).fouten });
    assert.ok(!regel.uitleg.includes(waarde));
  }
  assert.ok(keurState(state).ok, 'de echte toestand haalt datzelfde domein wél');
});

test('reviewgat 11 — twee stiltebevindingen strijden niet om voorrang maar staan er allebei', () => {
  // De absolute vloer stond vóór de relatieve meting met een eigen return, en maskeerde die daardoor:
  // bij totale uitval verdween de bevinding dat één spoor daarbovenop nóg langer zweeg. Twee
  // verschillende waarnemingen horen in dezelfde uitkomst te staan.
  const g = opstelling(spiegelMet(
    rij('2026-07-26 09:00', 'MINI', 'Acht uur eerder dan de rest.'),
    rij('2026-07-26 17:00', 'CONTROL', 'De jongste melding.'),
    rij('2026-07-26 17:05', 'AUTOPILOT', 'Vrijwel gelijk.'),
  ));
  const o = g.kijk({ nu: Date.parse('2026-07-28T12:00:00.000Z') });
  assert.equal(o.uitkomst, 'PARTIAL');
  assert.ok(o.redenen.includes('ALLES_STIL'), 'de hele plaat staat stil');
  assert.ok(o.redenen.includes('LANE_VEROUDERD'), 'en MINI zweeg daarbovenop nog langer');
  assert.deepEqual(o.gemeten.verouderdeLanes, ['AUTOPILOT', 'CONTROL', 'MINI']);
});

test('reviewgat 12 — een tijd die nog niet geweest is zet de stiltemeting niet uit', () => {
  // Eén rij met een tijd van volgende week maakt elk werkelijk stilstaand spoor "recent": de meting
  // rekent immers vanaf het jongste moment. Dat is de goedkoopste manier om het stilte-alarm uit te
  // zetten, en hij kostte niets meer dan een verkeerd getypte datum.
  const g = opstelling(spiegelMet(
    rij('2026-07-26 17:00', 'CONTROL', 'Nu.'),
    rij('2026-08-30 12:00', 'MINI', 'Volgende maand.'),
  ));
  const o = g.kijk({ nu: Date.parse('2026-07-26T15:30:00.000Z') });
  assert.equal(o.uitkomst, 'ROOD');
  assert.ok(o.redenen.includes('TIJD_UIT_DE_TOEKOMST'));
  // Een paar minuten speling tussen twee machines is geen bevinding.
  const speling = opstelling(spiegelMet(rij('2026-07-26 17:00', 'CONTROL', 'Nu.')));
  assert.equal(speling.kijk({ nu: Date.parse('2026-07-26T14:58:00.000Z') }).uitkomst, 'GROEN');
});

test('reviewgat 13 — een kapotte rij midden in de tabel neemt niet alles eronder mee', () => {
  // De ergste van de derde ronde, en dezelfde vorm als de 41 van de 54: een rij met een verkeerd
  // kolomaantal sloot de tabel, dus die rij én alles erachter verdween. Gemeten met geldig-kapot-
  // geldig: één kandidaat, nul afkeuringen, eventCount 1, uitkomst GROEN. Een regel die nog steeds
  // een tabelregel is hoort een AFGEKEURDE rij te zijn die zijn plaats houdt.
  const kapot = [KOPREGELS,
    rij('2026-07-26 17:00', 'CONTROL', 'Eerste.'),
    '| te weinig | kolommen |',
    rij('2026-07-26 17:10', 'MINI', 'Derde.')].join('\n');
  assert.deepEqual(spiegelScan(kapot).kandidaten.map((k) => k && k.tab), ['CONTROL', null, 'MINI']);
  const { state } = kijkStateUitSpiegel(kapot, { commitSha: KOP_A });
  assert.deepEqual(Object.keys(state.lanes).sort(), ['CONTROL', 'MINI'], 'de rij eronder blijft staan');
  assert.equal(state.eventCount, 3, 'en de kapotte rij is geteld, niet weggelaten');
  assert.equal(state.verworpenRijen, 1);
  assert.equal(state.lanes.MINI.sequence, 3, 'MINI houdt zijn eigen plaats, hij schuift niet op');
  // Een lege regel sluit de tabel nog steeds — maar wat DAARNA komt verdwijnt niet meer. Hier stond
  // eerst `['CONTROL']`, en dat was precies de fout die de vierde ronde blootlegde: een rij die
  // buiten de tabel viel werd nul, niet afkeuring, en de plaat kwam er GROEN uit terwijl er een
  // volwaardige spiegelrij ongelezen bleef. Zie reviewgat 20 voor de meting.
  const erna = [KOPREGELS, rij('2026-07-26 17:00', 'CONTROL', 'Eerste.'), '', rij('2026-07-26 17:10', 'MINI', 'Andere tabel.')].join('\n');
  assert.deepEqual(spiegelScan(erna).kandidaten.map((k) => k && k.tab), ['CONTROL', null]);
});

test('reviewgat 14 — de toestand moet uit de GELEZEN tekst volgen, niet slechts hetzelfde etiket dragen', () => {
  // Stap 2d vergeleek commit-LABELS. Twee claims die hetzelfde label dragen bewijzen alleen dat iemand
  // tweemaal hetzelfde opschreef: een toestand afgeleid uit een andere bron, gestempeld met de SHA van
  // de gelezen bron, kwam er met een sluitend manifest als GROEN uit. Zolang de spiegel de bron IS,
  // moet de toestand exact uit de gelezen tekst te herleiden zijn.
  const bron = spiegelMet(rij('2026-07-26 17:00', 'CONTROL', 'De gelezen bron.'));
  const beoordeel = (state) => {
    const m = manifestVoor(state, { bronCommitSha: KOP_A, generatedAt: '2026-07-26T18:45:00.000Z' });
    return oordeel({
      lezing: { ok: true, sha: KOP_A, tekst: bron, blobSha: null, pogingen: 1, geprobeerd: [] },
      paginaHerkomst: { commitSha: KOP_A, stateSha256: m.manifest.stateSha256, eventHighWatermark: state.eventHighWatermark },
      state, manifest: m.manifest, stateBytes: m.bytes, nu: Date.parse('2026-07-26T15:30:00.000Z'),
    });
  };
  assert.equal(beoordeel(kijkStateUitSpiegel(bron, { commitSha: KOP_A }).state).uitkomst, 'GROEN');
  for (const vreemd of [
    spiegelMet(rij('2026-07-26 09:00', 'CONTROL', 'De gelezen bron.')),
    spiegelMet(rij('2026-07-26 17:00', 'MINI', 'De gelezen bron.')),
    spiegelMet(rij('2026-07-26 17:00', 'CONTROL', 'De gelezen bron.'), rij('2026-07-26 17:30', 'MINI', 'Erbij.')),
  ]) {
    const o = beoordeel(kijkStateUitSpiegel(vreemd, { commitSha: KOP_A }).state);
    assert.equal(o.uitkomst, 'GEEN OORDEEL');
    assert.ok(o.redenen.includes('TOESTAND_NIET_BIJ_BRON'));
  }
  // Wat NIET verschilt is het onderwerp: dat komt per contract niet in de toestand, dus twee bronnen
  // die alleen in proza verschillen leveren dezelfde toestand en dat is terecht groen. De review las
  // dit als een gat; het is de belofte "geen vrije publieke tekst" die zichtbaar wordt.
  const andereProza = spiegelMet(rij('2026-07-26 17:00', 'CONTROL', 'Volstrekt andere tekst.'));
  assert.equal(beoordeel(kijkStateUitSpiegel(andereProza, { commitSha: KOP_A }).state).uitkomst, 'GROEN');
});

test('reviewgat 15 — het manifest gaat óók publiek en heeft dus hetzelfde gesloten schema', () => {
  // `manifestDekt` keek naar één veld, de rest van het manifest werd nooit gekeurd. Een manifest met
  // een klantnaam in `generatedAt` en een lokaal pad in `bronBlobSha` kwam er als GROEN uit.
  const g = opstelling(DRIE_LANES);
  assert.ok(keurManifest(g.manifest, g.state).ok, 'het echte manifest haalt zijn eigen schema');
  for (const [veld, waarde] of [
    ['generatedAt', 'incident bij klant Van der Berg'],
    ['bronBlobSha', '/Users/richard/geheim'],
    ['bronSoort', 'een vrije omschrijving'],
    ['eventCount', 'twee-en-een-half'],
  ]) {
    const vies = { ...g.manifest, [veld]: waarde };
    assert.ok(!keurManifest(vies, g.state).ok, `${veld} hoort een domein te hebben`);
    const o = oordeel({ ...g, manifest: vies, stateBytes: g.bytes, nu: Date.now() });
    assert.equal(o.uitkomst, 'GEEN OORDEEL');
    assert.ok(!publiekeRegel(o).uitleg.includes(waarde), 'en de waarde komt niet publiek naar buiten');
  }
  // Waar manifest en toestand hetzelfde beweren moeten ze het eens zijn.
  assert.ok(!keurManifest({ ...g.manifest, eventHighWatermark: g.state.eventHighWatermark + 1 }, g.state).ok);
});

test('reviewgat 16 — een lezer die fail-closed heet gooit geen uitzondering', () => {
  // Met `lanes: null` en met één spoor op `null` gooide `oordeel()` een TypeError: de tijdextractie
  // greep in een toestand die de keuring al had afgekeurd, maar die keuring keerde niet terug. Een
  // uitzondering is geen gesloten uitkomst — wat de aanroeper ermee doet valt buiten dit contract.
  // Wat deze proef vastlegt is de UITKOMST, niet welk mechanisme hem oplevert: sinds de bronbinding
  // vallen deze vier vormen al bij stap 2e om, en het vangnet in de tijdextractie is een tweede riem
  // zonder bereikbaar pad. De mutatieproef meldt dat ook zo — zie mutatie 16, expliciet als
  // onbereikbaar verklaard in plaats van als geslaagd geteld.
  for (const stuk of [
    (s) => { s.lanes = null; },
    (s) => { s.lanes = { CONTROL: null }; },
    (s) => { s.lanes = []; },
    (s) => { s.lanes = { CONTROL: 'vrije tekst' }; },
  ]) {
    const { state } = kijkStateUitSpiegel(DRIE_LANES, { commitSha: KOP_A });
    stuk(state);
    const m = manifestVoor(state, { bronCommitSha: KOP_A, generatedAt: '2026-07-26T18:45:00.000Z' });
    const o = oordeel({
      lezing: { ok: true, sha: KOP_A, tekst: DRIE_LANES, blobSha: null, pogingen: 1, geprobeerd: [] },
      paginaHerkomst: { commitSha: KOP_A, stateSha256: m.manifest.stateSha256, eventHighWatermark: state.eventHighWatermark },
      state, manifest: m.manifest, stateBytes: m.bytes, nu: Date.now(),
    });
    assert.ok(UITKOMSTEN.includes(o.uitkomst), 'elke vorm van kapot krijgt een gesloten uitkomst');
    assert.notEqual(o.uitkomst, 'GROEN');
  }
});

test('reviewgat 17 — verworpenRijen is verplicht aanwezig, niet stilzwijgend nul', () => {
  // `?? 0` maakte precies het veld optioneel dat moet melden DAT er iets is afgekeurd.
  const { state } = kijkStateUitSpiegel(DRIE_LANES, { commitSha: KOP_A });
  assert.ok(keurState(state).ok);
  const zonder = { ...state };
  delete zonder.verworpenRijen;
  assert.deepEqual(keurState(zonder).fouten, ['VELD_NIET_GESLOTEN']);
});

test('reviewgat 18 — een onmogelijke kalenderdatum haalt de tijdtoets niet, ook niet in de toestand', () => {
  // `Date.parse` rekent 30 februari stilzwijgend om naar 2 maart, dus de vormtoets alleen liet een
  // onmogelijke datum in de publieke toestand toe.
  const { state } = kijkStateUitSpiegel(DRIE_LANES, { commitSha: KOP_A });
  state.lanes.CONTROL.momentUtc = '2026-02-30T12:00:00.000Z';
  assert.deepEqual(keurState(state).fouten, ['VELD_NIET_GESLOTEN']);
});

test('reviewgat 19 — de klok is een bewijsstuk: ontbreekt hij, dan is er GEEN OORDEEL', () => {
  // Hier waren de twee families het eerst oneens over; na de derde ronde wijzen ze het allebei af, en
  // met dezelfde meting. Een halfjaar oude toestand gaf zónder klok GROEN en mét klok PARTIAL, dus de
  // uitkomst hing af van een weglating. `NaN` was erger: `klokAanwezig: true` én GROEN, want elke
  // vergelijking met NaN is onwaar. Het geschil is daarmee beslecht door overeenstemming, niet door
  // mij: een ontbrekend bewijsstuk landt in GEEN OORDEEL, en de klok is geen uitzondering.
  const oud = spiegelMet(
    rij('2026-01-02 09:00', 'CONTROL', 'Oud.'),
    rij('2026-01-02 09:10', 'MINI', 'Ook oud.'),
  );
  const { state } = kijkStateUitSpiegel(oud, { commitSha: KOP_A });
  const m = manifestVoor(state, { bronCommitSha: KOP_A, generatedAt: '2026-07-26T18:45:00.000Z' });
  const beoordeel = (extra) => oordeel({
    lezing: { ok: true, sha: KOP_A, tekst: oud, blobSha: null, pogingen: 1, geprobeerd: [] },
    paginaHerkomst: { commitSha: KOP_A, stateSha256: m.manifest.stateSha256, eventHighWatermark: state.eventHighWatermark },
    state, manifest: m.manifest, stateBytes: m.bytes, ...extra,
  });
  for (const [naam, extra] of [
    ['weggelaten', {}], ['null', { nu: null }], ['NaN', { nu: NaN }], ['Infinity', { nu: Infinity }],
    ['een tekst', { nu: '2026-07-26' }],
  ]) {
    const o = beoordeel(extra);
    assert.equal(o.uitkomst, 'GEEN OORDEEL', `klok ${naam}`);
    assert.ok(o.redenen.includes('KLOK_ONBEKEND'), `klok ${naam}`);
  }
  // En mét klok komt de stilte er wél uit, dus de toets vervangt de meting niet, hij maakt haar mogelijk.
  const met = beoordeel({ nu: Date.parse('2026-07-26T15:30:00.000Z') });
  assert.equal(met.uitkomst, 'PARTIAL');
  assert.ok(met.redenen.includes('ALLES_STIL'));
});

test('de aanwezigheid van de klok blijft zichtbaar in de meting, en de uitvoerder geeft er altijd een mee', () => {
  // Deze proef stond hier eerst als een vastgelegd MENINGSVERSCHIL: Codex vond dat een ontbrekende klok
  // GEEN OORDEEL hoort te geven, Gemini vond dat een bibliotheekfunctie niet zelf naar de klok hoort te
  // grijpen. Het geschil is niet door Fable beslecht maar door de meting: Gemini kwam er in de derde
  // ronde op terug ("dit is een verkapte fail-open") en beide families staan nu op hetzelfde punt.
  // Reviewgat 19 legt die uitkomst vast. Wat hier overblijft is het deel dat er los van staat en dat
  // beide families wél altijd wilden: de klok is geen verborgen aanname, hij staat in de meting, en de
  // uitvoerder levert hem aan in plaats van dat de bibliotheek hem zelf pakt.
  const g = opstelling(DRIE_LANES);
  assert.equal(g.kijk({ nu: null }).gemeten.klokAanwezig, false);
  assert.equal(g.kijk().gemeten.klokAanwezig, true);
  const uitvoerder = readFileSync(new URL('../scripts/kijk.mjs', import.meta.url), 'utf8');
  assert.match(uitvoerder, /oordeel\(\{[^}]*nu: Date\.now\(\)/, 'de uitvoerder geeft altijd een klok mee');
});

// ── VIERDE REVIEWRONDE (kop 4deb499). Codex meldde acht routes buiten de dekking; alle acht zijn hier
// eerst nagemeten voordat er iets veranderde. Zeven bleken echt en staan hieronder als proef. De
// achtste is weerlegd, en die weerlegging staat er óók — met de reden, want een afgewezen bevinding
// die niet is vastgelegd komt volgende ronde ongewijzigd terug.

test('reviewgat 20 — een spiegelrij buiten de tabel of in commentaar telt, of wordt afgekeurd, maar verdwijnt nooit', () => {
  // GEMETEN VÓÓR DE FIX, drie vormen, alle drie GROEN met één spoor en nul afkeuringen:
  //   a) kop, rij, LEGE REGEL, rij            → sporen ["CONTROL"], eventCount 1, verworpen 0
  //   b) kop, rij, gewone zin, rij            → idem
  //   c) een complete tabel binnen <!-- -->    → sporen ["CONTROL","MINI"], want commentaar werd gelezen
  // a en b zijn de gevaarlijkste: er stáát een volwaardige spiegelrij en die werd nul. c is de
  // spiegelbeeldige fout: er staat GEEN geldende rij en die werd wél toestand. Beide keren beslist de
  // opmaak eromheen wat de bron zegt, en dat is precies wat een bronvaste lezer niet mag toestaan.
  const na = (tekst) => {
    const { state } = kijkStateUitSpiegel(tekst, { commitSha: KOP_A });
    return { sporen: Object.keys(state.lanes).sort(), telling: state.eventCount, verworpen: state.verworpenRijen };
  };

  const legeRegel = [KOPREGELS, rij('2026-07-26 17:00', 'CONTROL', 'Eerste.'), '',
    rij('2026-07-26 17:10', 'MINI', 'Wees niet weg.')].join('\n');
  assert.deepEqual(na(legeRegel), { sporen: ['CONTROL'], telling: 2, verworpen: 1 });

  const proza = [KOPREGELS, rij('2026-07-26 17:00', 'CONTROL', 'Eerste.'), 'Een gewone zin ertussen.',
    rij('2026-07-26 17:10', 'MINI', 'Wees niet weg.')].join('\n');
  assert.deepEqual(na(proza), { sporen: ['CONTROL'], telling: 2, verworpen: 1 });

  // Een verweesde rij wordt dus een AFKEURING, geen toestand: hij houdt zijn plaats in de telling en
  // maakt de uitkomst rood, in plaats van dat hij stil wegvalt.
  const o = opstelling(legeRegel);
  assert.equal(o.kijk().uitkomst, 'ROOD');
  assert.ok(o.kijk().redenen.includes('VELD_NIET_GESLOTEN'));

  // En commentaar is géén gegeven. Een verborgen tabel levert geen enkel spoor op.
  const verborgen = [KOPREGELS, rij('2026-07-26 17:00', 'CONTROL', 'De echte rij.'), '',
    '<!--', KOPREGELS, rij('2026-07-26 17:10', 'MINI', 'Ik sta in commentaar.'), '-->'].join('\n');
  assert.deepEqual(na(verborgen), { sporen: ['CONTROL'], telling: 1, verworpen: 0 });

  // De toets staat op EXACT vijf kolommen, en dat is waarom de kolom-uitleg bovenaan de echte spiegel
  // (twee kolommen) hier niets raakt — anders zou elke andere tabel in het bestand afkeuringen worden.
  const andereTabel = [KOPREGELS, rij('2026-07-26 17:00', 'CONTROL', 'De echte rij.'), '',
    '| kolom | betekenis |', '| --- | --- |', '| datum-tijd | wanneer |'].join('\n');
  assert.deepEqual(na(andereTabel), { sporen: ['CONTROL'], telling: 1, verworpen: 0 });
});

test('reviewgat 21 — een onleesbare getuigenis is geen getuige maar een gat in de bewaking', () => {
  // GEMETEN VÓÓR DE FIX: `{ sequence: 'geen getal', stateSha256: null }` gaf `getuigeAanwezig: true`,
  // uitkomst GROEN, redenen []. De twee toetsen die geheugen nodig hebben stonden achter
  // `Number.isInteger(...)` en sloegen zichzelf stilzwijgend over. Dat is de ergste soort: de meting
  // meldt dat er een getuige is, terwijl er niets is getoetst.
  const o = opstelling(DRIE_LANES);
  const goed = { sequence: o.state.eventHighWatermark, commitSha: KOP_B, stateSha256: o.manifest.stateSha256 };
  assert.equal(o.kijk({ getuigenis: goed }).uitkomst, 'GROEN', 'een volledige, kloppende getuigenis laat door');

  for (const [wat, kapot] of [
    ['sequence is geen getal', { ...goed, sequence: 'geen getal' }],
    ['sequence ontbreekt', { commitSha: KOP_B, stateSha256: goed.stateSha256 }],
    ['sequence is negatief', { ...goed, sequence: -1 }],
    ['commit is een prefix', { ...goed, commitSha: '4deb499' }],
    ['hash ontbreekt', { sequence: goed.sequence, commitSha: KOP_B, stateSha256: null }],
    ['hash is een plaatshouder', { ...goed, stateSha256: 'x' }],
    ['het is een lijst', [goed]],
    ['het is een tekst', 'ik heb het gezien'],
    ['het is een getal', 42],
  ]) {
    const r = o.kijk({ getuigenis: kapot });
    assert.equal(r.uitkomst, 'GEEN OORDEEL', `${wat} hoort geen oordeel op te leveren`);
    assert.deepEqual(r.redenen, ['GETUIGE_ONBRUIKBAAR'], wat);
  }

  // Géén getuigenis blijft toegestaan — de getuige draait buiten deze repo en is nog niet geactiveerd
  // (taak EQ-e2bc34e069cd). Dat verschil is zichtbaar in de meting, en dat is het punt: niets weten
  // mag, doen alsof je iets weet niet.
  assert.equal(o.kijk({ getuigenis: null }).gemeten.getuigeAanwezig, false);
  assert.equal(o.kijk({ getuigenis: null }).uitkomst, 'GROEN');
});

test('reviewgat 22 — de stiltedrempel kan de versheidsmeting niet stilletjes uitzetten', () => {
  // GEMETEN VÓÓR DE FIX, op exact dezelfde bytes: normaal PARTIAL met ALLES_STIL, met `stilMs: NaN`
  // GROEN met lege redenen, met `Infinity` GROEN met lege redenen. NaN maakt elke vergelijking onwaar
  // en Infinity maakt geen stilte ooit lang genoeg — twee manieren om de meting van buitenaf uit te
  // zetten zonder één zichtbaar spoor. Dezelfde fout als bij de klok, en dus dezelfde uitkomst.
  const oud = spiegelMet(rij('2026-01-02 09:00', 'CONTROL', 'Oud.'), rij('2026-01-02 09:10', 'MINI', 'Ook oud.'));
  const o = opstelling(oud);
  assert.equal(o.kijk().uitkomst, 'PARTIAL');
  assert.ok(o.kijk().redenen.includes('ALLES_STIL'));

  for (const drempel of [NaN, Infinity, -Infinity, -1, 'zes uur', null]) {
    const r = o.kijk({ stilMs: drempel });
    assert.equal(r.uitkomst, 'GEEN OORDEEL', `drempel ${String(drempel)}`);
    assert.deepEqual(r.redenen, ['DREMPEL_ONBRUIKBAAR'], String(drempel));
  }

  // Nul is wél een drempel: "geen respijt". Een geldige waarde blijft dus gewoon meten.
  assert.equal(o.kijk({ stilMs: 0 }).uitkomst, 'PARTIAL');
  assert.ok(o.kijk({ stilMs: 0 }).redenen.includes('ALLES_STIL'));
});

test('reviewgat 23 — de bronblob van het manifest wordt tegen de lezing gehouden', () => {
  // GEMETEN VÓÓR DE FIX: lezing met blob cccc…, manifest met blob bbbb… → GROEN, redenen []. Het veld
  // werd geschreven en nooit gelezen. De commit zegt uit welke wereld de bron komt; de blob zegt welk
  // BESTAND daarin gelezen is, en zonder die tweede binding kan een cache of proxy andere bytes
  // doorgeven dan de boom van die commit declareert.
  const tekst = spiegelMet(rij('2026-07-26 17:00', 'CONTROL', 'De gelezen bron.'));
  const { state } = kijkStateUitSpiegel(tekst, { commitSha: KOP_A });
  const beoordeel = (lezingBlob, manifestBlob) => {
    const m = manifestVoor(state, { bronCommitSha: KOP_A, bronBlobSha: manifestBlob, generatedAt: '2026-07-26T18:45:00.000Z' });
    return oordeel({
      lezing: { ok: true, sha: KOP_A, tekst, blobSha: lezingBlob, pogingen: 1, geprobeerd: [] },
      paginaHerkomst: { commitSha: KOP_A, stateSha256: m.manifest.stateSha256, eventHighWatermark: state.eventHighWatermark },
      state, manifest: m.manifest, stateBytes: m.bytes, nu: NU,
    });
  };
  const BLOB = 'b'.repeat(40);
  const ANDER = 'c'.repeat(40);

  assert.equal(beoordeel(BLOB, BLOB).uitkomst, 'GROEN', 'dezelfde blob aan beide kanten laat door');
  const scheef = beoordeel(ANDER, BLOB);
  assert.equal(scheef.uitkomst, 'GEEN OORDEEL');
  assert.deepEqual(scheef.redenen, ['TOESTAND_NIET_BIJ_BRON']);

  // Ontbreekt één van de twee, dan is er niets vergeleken en wordt er ook niets beweerd. Dat is geen
  // gat maar het eerlijke antwoord: de OVERGANG-herleiding (stap 2e) draagt zolang de spiegel de bron
  // is, en zodra dat merk vervalt is deze vergelijking de binding die ervoor in de plaats komt.
  assert.equal(beoordeel(null, BLOB).uitkomst, 'GROEN');
  assert.equal(beoordeel(BLOB, null).uitkomst, 'GROEN');

  // De uitvoerder rekent zijn kant ZELF uit — `blob <lengte>\0` plus de bytes, zoals git het doet — en
  // haalt de andere kant uit de boom van diezelfde commit. Twee onafhankelijke bronnen, anders zou de
  // vergelijking een getal met zichzelf vergelijken.
  const uitvoerder = readFileSync(new URL('../scripts/kijk.mjs', import.meta.url), 'utf8');
  assert.match(uitvoerder, /blob \$\{inhoud\.length\}\\0/, 'de uitvoerder rekent de blob zelf uit');
  assert.match(uitvoerder, /bronBlobSha: await declaredBlobVan\(lezing\.sha\)/, 'en haalt de declaratie uit de boom');
});

test('reviewgat 24 — de gesloten lijsten zijn ook echt gesloten, niet alleen zo genoemd', () => {
  // GEMETEN VÓÓR DE FIX: `REDENEN.ALLES_STIL = 'incident bij klant Voorbeeld op /vrij/pad'` en die zin
  // rolde letterlijk uit `publiekeRegel` de publieke plaat op; `LANES.push('VRIJE TEKST ALS SPOOR')`
  // werkte net zo goed. `const` bindt de naam, niet de inhoud. Dat was de laatste route waarlangs
  // vrije publieke tekst nog bestond, en de hele opdracht draait om het sluiten daarvan.
  for (const lijst of [REDENEN, LANES, TOESTANDEN, UITKOMSTEN]) {
    assert.ok(Object.isFrozen(lijst), 'een gesloten lijst hoort bevroren te zijn');
  }
  const oudeRegel = publiekeRegel({ uitkomst: 'PARTIAL', redenen: ['ALLES_STIL'] }).uitleg;
  assert.throws(() => { 'use strict'; REDENEN.ALLES_STIL = 'incident bij klant Voorbeeld op /vrij/pad'; });
  assert.throws(() => { 'use strict'; LANES.push('VRIJE TEKST ALS SPOOR'); });
  assert.equal(publiekeRegel({ uitkomst: 'PARTIAL', redenen: ['ALLES_STIL'] }).uitleg, oudeRegel);
});

test('reviewgat 25 — een gooiende ophaler levert een uitkomst op, geen uitzondering', () => {
  // GEMETEN VÓÓR DE FIX: een `kopVan` die gooit gaf `Error kapot` in plaats van een reden — de belofte
  // werd verworpen en er bestond helemaal geen uitkomst meer om over te oordelen. Proef 8 dekte de
  // vier storingsvormen die netjes een status teruggeven; dit is de vorm waarin `fetch` zelf omvalt
  // (DNS, afgebroken verbinding, tijdslimiet), en juist die is in productie de gewoonste.
  const goed = { ok: true, sha: KOP_A };
  const gooi = () => { throw new Error('kapot'); };
  const gevallen = [
    ['de kop gooit meteen', { kopVan: gooi, inhoudVan: async () => ({ ok: true, tekst: 'x' }) }, 'KOP_ONBEPAALBAAR'],
    ['de inhoud gooit', { kopVan: async () => goed, inhoudVan: gooi }, 'BRON_ONBEREIKBAAR'],
    ['de tweede kopmeting gooit', {
      kopVan: (() => { let n = 0; return async () => { n += 1; if (n > 1) gooi(); return goed; }; })(),
      inhoudVan: async () => ({ ok: true, tekst: 'x' }),
    }, 'KOP_ONBEPAALBAAR'],
  ];
  return Promise.all(gevallen.map(async ([wat, haken, reden]) => {
    const lezing = await leesBronvast(haken);
    assert.equal(lezing.ok, false, wat);
    assert.equal(lezing.reden, reden, wat);
    // En de uitkomst is GEEN OORDEEL, nooit gecacht groen — dezelfde eis als rode proef 8.
    assert.equal(oordeel({ lezing, nu: NU }).uitkomst, 'GEEN OORDEEL', wat);
    // De fout zelf gaat niet mee naar buiten: hij kan een adres of een responsdeel bevatten.
    assert.equal(JSON.stringify(lezing).includes('kapot'), false, `${wat}: geen fouttekst naar buiten`);
  }));
});

test('reviewgat 26 — een voorbeeldtabel in een codeblok is uitleg, geen toestand', () => {
  // GEMETEN VÓÓR DE FIX, op kop 9f413d8, met een spiegeltabel binnen ```markdown … ```:
  //   {"sporen":["CONTROL","MINI"],"telling":2,"verworpen":0}
  // Een rij die in de uitleg stond als vóórbeeld werd dus echt gemeten toestand, met nul afkeuringen.
  // Dat is niet theoretisch: het bestand is een handgeschreven auditlogboek en een uitleg-met-voorbeeld
  // is er de gewoonste toevoeging van.
  //
  // Waarom de pagina dit niet vangt, en dat is het hele punt: de pagina wordt door DEZELFDE lezer
  // gebouwd. Beide kanten lezen de voorbeeldrij mee, hun toestandshash is identiek, en de uitkomst is
  // GROEN. Een parserverschil is onzichtbaar voor een vergelijking die beide kanten uit één parser
  // haalt — precies de reden dat deze route niet is weggeredeneerd maar nagemeten.
  const na = (tekst) => {
    const { state } = kijkStateUitSpiegel(tekst, { commitSha: KOP_A });
    return { sporen: Object.keys(state.lanes).sort(), telling: state.eventCount, verworpen: state.verworpenRijen };
  };

  const voorbeeld = [KOPREGELS, rij('2026-07-26 17:00', 'CONTROL', 'De echte rij.'), '',
    '```markdown', KOPREGELS, rij('2026-07-26 17:50', 'MINI', 'Alleen een voorbeeld in de uitleg.'), '```'].join('\n');
  assert.deepEqual(na(voorbeeld), { sporen: ['CONTROL'], telling: 2, verworpen: 1 },
    'MINI mag geen spoor worden; de voorbeeldrij telt als afkeuring');

  // Andersom net zo belangrijk: het hek mag geen verstopplaats worden. Drie backticks om bestaande
  // rijen zetten laat ze NIET stil verdwijnen — ze worden afkeuringen, en afkeuringen maken rood.
  const verstopt = [KOPREGELS, rij('2026-07-26 17:00', 'CONTROL', 'Echt.'),
    '```', rij('2026-07-26 17:10', 'MINI', 'Weggemoffeld.'), '```',
    rij('2026-07-26 17:20', 'CHIEF', 'Erna.')].join('\n');
  assert.deepEqual(na(verstopt), { sporen: ['CONTROL'], telling: 3, verworpen: 2 });
  const o = opstelling(verstopt);
  assert.equal(o.kijk().uitkomst, 'ROOD');
  assert.ok(o.kijk().redenen.includes('VELD_NIET_GESLOTEN'));

  // Een niet-gesloten hek aan het eind van het bestand slikt de rest niet stil op: alles erna is
  // afkeuring. Kost zichtbaarheid, levert geen valse toestand.
  const open = [KOPREGELS, rij('2026-07-26 17:00', 'CONTROL', 'Echt.'),
    '```', rij('2026-07-26 17:10', 'MINI', 'Rest van het bestand.')].join('\n');
  assert.deepEqual(na(open), { sporen: ['CONTROL'], telling: 2, verworpen: 1 });

  // Tildes zijn in markdown een even geldig hek als backticks; wie alleen op ``` toetst laat de helft open.
  const tilde = [KOPREGELS, rij('2026-07-26 17:00', 'CONTROL', 'Echt.'),
    '~~~', KOPREGELS, rij('2026-07-26 17:10', 'MINI', 'Voorbeeld.'), '~~~'].join('\n');
  assert.deepEqual(na(tilde), { sporen: ['CONTROL'], telling: 2, verworpen: 1 });

  // En de twee scopes bijten elkaar niet: een hek binnen commentaar wisselt de hekstand niet, anders
  // zou één backtickregel in een commentaarblok de rest van het bestand van soort laten veranderen.
  const gemengd = [KOPREGELS, rij('2026-07-26 17:00', 'CONTROL', 'Echt.'),
    '<!--', '```', '-->', rij('2026-07-26 17:20', 'CHIEF', 'Erna.')].join('\n');
  assert.deepEqual(na(gemengd), { sporen: ['CONTROL'], telling: 2, verworpen: 1 });
});

test('weerlegging — AFGEROND wordt LEEG, en dat is de bedoeling, geen fout', () => {
  // Dit is de ACHTSTE bevinding van de vierde ronde, en de enige die is afgewezen. Codex las het zo:
  // een spiegelrij met status AFGEROND komt als toestand LEEG in de kijk-state, LEEG is de toestand
  // "niet klaar", en toch is de uitkomst GROEN — dus zou de plaat afgerond werk als leeg tonen.
  //
  // Twee redenen waarom dat niet klopt, en ze staan hier vast zodat de bevinding niet elke ronde
  // terugkomt. EEN: LEEG is precies de juiste vertaling. De werkwijze-regels noemen zes toegestane
  // standen en zeggen erbij dat iets anders invullen — "klaar", "afgerond", "voltooid" — een LEGE
  // stand ís. De spiegel onderscheidt MERGEABLE, MERGED en EFFECT-BEWEZEN niet, dus élke keuze uit die
  // drie zou een bewering verzinnen die in de bron niet staat. TWEE: deze module meet niet of het WERK
  // af is, maar of de WAARNEMING klopt. GROEN betekent hier "wat ik lees is aantoonbaar de actuele
  // bron", niet "alles is af". Een kijk die rood werd van onafgerond werk zou permanent rood staan.
  const o = opstelling(spiegelMet(rij('2026-07-26 17:30', 'CONTROL', 'Een afgeronde regel.', 'AFGEROND')));
  assert.equal(o.state.lanes.CONTROL.toestand, 'LEEG');
  // En het tweede veld laat zien waarom LEEG hier geen bewering over het werk is: de spiegel kan de
  // uitkomst van de GEBEURTENIS niet zeggen, dus daar staat GEEN — expliciet onbekend, niet verzonnen.
  assert.equal(o.state.lanes.CONTROL.eventUitkomst, 'GEEN');
  assert.equal(o.kijk().uitkomst, 'GROEN');
  // Dat onderscheid is de kern: de uitkomst van de gebeurtenis staat los van de toestand van het werk.
  // Zodra de exporter uit task_events publiceert komt de echte toestand mee en vervalt de vertaling.
  assert.equal(o.state.bronSoort, OVERGANG_MERK);
});
