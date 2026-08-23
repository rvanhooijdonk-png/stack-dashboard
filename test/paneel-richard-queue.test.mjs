/**
 * PANEEL RICHARD-QUEUE — de telling achter de sectie "Wacht op Richard".
 *
 * Twee eigenschappen dragen dit paneel, en die bindt deze suite:
 *  (1) het paneel telt HETZELFDE object dat de sectie rendert — niet dezelfde functie opnieuw
 *      aangeroepen, maar letterlijk dezelfde array uit één `ownerGates(snapshot)`. Op de plaat is
 *      dat te meten: de badge van de sectie en het getal in het paneel moeten gelijk zijn, wat er
 *      ook in de snapshot staat.
 *  (2) een telling uit bronnen die niets hebben gemeten is geen nul. Zwijgen alle drie de
 *      ownerbronnen, dan blijft de telling leeg (UNKNOWN); zwijgt er één, dan is het getal een
 *      ondergrens en heet de stand GEDEELTELIJK.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { richardQueuePaneel, renderRichardQueueBody, richardQueueBadge } from '../scripts/lib/paneel-richard-queue.mjs';
import { ownerGates, renderCockpit } from '../scripts/lib/render-cockpit.mjs';

const NU = new Date('2026-08-12T12:00:00Z');
const STEMPEL = '2026-08-12T11:59:00Z';

/** Een snapshot waarin alle drie de ownerbronnen wél iets meten. `open === draft + ready` en
 *  `ready === 0`, want een niet-draft PR levert per definitie een ongemeten-melding op. */
const gemeten = (extra = {}) => ({
  generatedAt: STEMPEL,
  pullRequests: { available: true, evidence: { trust: 'VERIFIED_CURRENT' }, totals: { open: 2, draft: 2, ready: 0 } },
  planning: { available: true, features: [] },
  kanaalpost: { available: true, rows: [], ingehouden: 0 },
  ...extra,
});

const kanaalpostRij = (onderwerp, actie = 'Richard of Fable', status = 'WACHT OP AKKOORD') => ({
  tab: 'INSTROOM', onderwerp, status, actie, datum: '2026-08-12 09:00',
});

const paneelVan = (snapshot) => richardQueuePaneel(snapshot, ownerGates(snapshot), { now: NU });

test('alle drie de bronnen gelezen, geen poort open: dat is een gemeten nulstand, geen UNKNOWN', () => {
  const p = paneelVan(gemeten());
  assert.equal(p.status, 'LEEG');
  assert.equal(p.poorten, 0);
  assert.equal(p.ongemeten, 0);
  assert.equal(richardQueueBadge(p), 'ok');
  // De nul mag hier juist WEL gedrukt worden: hij is gemeten. Dat is het verschil met UNKNOWN.
  assert.match(renderRichardQueueBody(p), /Bewezen open<\/span><span class="muted">0 queue-items/);
});

test('een openstaande ownerpoort levert WACHT met de poort meegeteld', () => {
  const p = paneelVan(gemeten({
    kanaalpost: { available: true, rows: [kanaalpostRij('Akkoord nodig op de mergepoort')], ingehouden: 0 },
  }));
  assert.equal(p.status, 'WACHT');
  assert.equal(p.poorten, 1);
  assert.equal(richardQueueBadge(p), 'warn');
  assert.match(renderRichardQueueBody(p), /1 queue-item</);
});

test('enkelvoud en meervoud kloppen bij één en bij meer poorten', () => {
  const een = paneelVan(gemeten({
    kanaalpost: { available: true, rows: [kanaalpostRij('Besluit A')], ingehouden: 0 },
  }));
  const twee = paneelVan(gemeten({
    kanaalpost: { available: true, rows: [kanaalpostRij('Besluit A'), kanaalpostRij('Besluit B')], ingehouden: 0 },
  }));
  assert.match(een.reden, /1 gevalideerde ownerpoort open/);
  assert.match(twee.reden, /2 gevalideerde ownerpoorten open/);
  assert.match(renderRichardQueueBody(een), /1 queue-item</);
  assert.match(renderRichardQueueBody(twee), /2 queue-items</);
});

test('geen enkele ownerbron leverde een meting: UNKNOWN, en de telling blijft LEEG', () => {
  const p = paneelVan({ generatedAt: STEMPEL });
  assert.equal(p.status, 'UNKNOWN');
  assert.equal(p.ongemeten, 3);
  const body = renderRichardQueueBody(p);
  // Precies het gevaar dat dit paneel moet vermijden: "0 queue-items" onder drie zwijgende bronnen.
  assert.equal(/0 queue-items/.test(body), false, body);
  assert.match(body, /Bewezen open<\/span><span class="unknown">UNKNOWN — geen meting/);
  // Het aantal ongemeten bronnen is juist WEL gemeten en hoort dus te blijven staan — dat is de melding.
  assert.match(body, /Ongemeten ownerbronnen<\/span><span class="muted">3 van 3/);
});

test('één zwijgende bron maakt het getal een ondergrens, geen totaal', () => {
  const p = paneelVan(gemeten({ planning: { available: false } }));
  assert.equal(p.status, 'GEDEELTELIJK');
  assert.equal(p.ongemeten, 1);
  assert.match(p.reden, /ondergrens, geen totaal/);
  // De telling blijft hier wél staan: er is gemeten, alleen niet overal.
  assert.match(renderRichardQueueBody(p), /Bewezen open<\/span><span class="muted">0 queue-items/);
});

test('een gelezen maar onvolledige bron is GEDEELTELIJK, niet LEEG', () => {
  // De spiegel hield rijen tegen bij de publicatiepoort. Die rijen bestaan; er kan een ownerpoort in
  // zitten die niemand hier ziet. Een gemeten nulstand melden zou dan te veel beweren.
  const p = paneelVan(gemeten({ kanaalpost: { available: true, rows: [], ingehouden: 2 } }));
  assert.equal(p.status, 'GEDEELTELIJK');
  assert.equal(p.ongemeten, 0);
  assert.equal(p.ingehouden, 2);
  assert.match(p.reden, /2 spiegelrijen haalde de publicatiepoort niet/);
});

test('een ongemeten bron weegt zwaarder dan een ingehouden rij in de reden', () => {
  // Beide leiden tot GEDEELTELIJK, maar de lezer hoort de ERNSTIGSTE reden te zien: een bron die
  // niets kon meten verbergt een onbekend aantal poorten, een ingehouden rij een bekend aantal.
  const p = paneelVan(gemeten({
    planning: { available: false },
    kanaalpost: { available: true, rows: [], ingehouden: 5 },
  }));
  assert.equal(p.status, 'GEDEELTELIJK');
  assert.match(p.reden, /ownerbronnen kon niets meten/);
  assert.equal(/publicatiepoort/.test(p.reden), false, p.reden);
  // Het ingehouden getal verdwijnt daarmee niet: het staat als eigen regel op de plaat.
  assert.match(renderRichardQueueBody(p), /Ingehouden spiegelrijen<\/span><span class="muted">5</);
});

test('de vier statussen dekken de badgelijst en niets anders', () => {
  const standen = new Map([
    ['LEEG', paneelVan(gemeten())],
    ['WACHT', paneelVan(gemeten({ kanaalpost: { available: true, rows: [kanaalpostRij('A')], ingehouden: 0 } }))],
    ['GEDEELTELIJK', paneelVan(gemeten({ planning: { available: false } }))],
    ['UNKNOWN', paneelVan({ generatedAt: STEMPEL })],
  ]);
  for (const [verwacht, p] of standen) {
    assert.equal(p.status, verwacht);
    assert.ok(['ok', 'warn'].includes(richardQueueBadge(p)), `${verwacht} heeft geen geldige badge`);
  }
  assert.equal(standen.size, 4);
});

test('een misvormd ownerresultaat klapt niet, maar valt naar de veilige kant', () => {
  // Een paneel dat klapt neemt de hele plaat mee. De veilige kant is UNKNOWN, niet nul.
  for (const kapot of [null, undefined, {}, { gates: 'geen array', unavailable: 7 }]) {
    const p = richardQueuePaneel({ generatedAt: STEMPEL }, kapot, { now: NU });
    assert.equal(p.status, 'UNKNOWN', JSON.stringify(kapot));
    assert.equal(p.poorten, 0);
  }
  const zonderSnapshot = richardQueuePaneel(null, { gates: [], unavailable: [] }, { now: NU });
  assert.equal(zonderSnapshot.measuredAt, null);
});

test('het bouwstempel wordt getoond met zijn leeftijd, en ontbreekt het, dan blijft de regel leeg', () => {
  const p = paneelVan(gemeten());
  assert.equal(p.measuredAt, STEMPEL);
  assert.match(renderRichardQueueBody(p), /Gebouwd<\/span><span class="muted">2026-08-12T11:59:00Z · 1m geleden/);
  const zonder = paneelVan(gemeten({ generatedAt: undefined }));
  assert.equal(zonder.measuredAt, null);
  assert.match(renderRichardQueueBody(zonder), /Gebouwd<\/span><span class="unknown">UNKNOWN/);
});

test('de blinde vlekken staan op de plaat, niet alleen in de broncode', () => {
  const body = renderRichardQueueBody(paneelVan(gemeten()));
  assert.match(body, /GEBLOKKEERD staat en Richard bij naam noemt, valt hier buiten/);
  assert.match(body, /vijftien rijen die de publieke spiegel nog toont/);
  assert.match(body, /pull-request wordt hier nooit een queue-item/);
  assert.match(body, /ververst niet in de browser/);
});

test('alle tekst gaat door esc(): een onderwerp met opmaak komt er niet rauw uit', () => {
  const p = paneelVan(gemeten({
    kanaalpost: { available: true, rows: [kanaalpostRij('<img src=x onerror=alert(1)>')], ingehouden: 0 },
  }));
  const body = renderRichardQueueBody(p);
  assert.equal(/<img/.test(body), false, body);
});

test('het paneel kan de sectie "Wacht op Richard" niet tegenspreken — gemeten op de plaat zelf', () => {
  // Dit is de kern. Beide getallen komen uit één `ownerGates()`-aanroep in `renderCockpit()`; deze
  // proef meet dat op de gerenderde pagina, niet in de modellaag. Een mutant die het paneel zijn
  // eigen `ownerGates(snapshot)` laat aanroepen overleeft dit nog — maar een mutant die het paneel
  // een eigen telling laat maken (of de sectie een andere snapshot geeft) valt hier om.
  for (const snapshot of [
    gemeten(),
    gemeten({ kanaalpost: { available: true, rows: [kanaalpostRij('A'), kanaalpostRij('B')], ingehouden: 0 } }),
    gemeten({ planning: { available: false } }),
    { generatedAt: STEMPEL },
  ]) {
    const html = renderCockpit(
      { contractVersion: '2.4.0', overallStatus: 'UNKNOWN', sources: [], ...snapshot },
      { products: { products: [] }, ticker: { events: [] }, now: NU },
    );
    const sectie = html.match(/<section id="wacht-op-richard"[\s\S]*?<\/section>/)[0];
    const paneel = html.match(/<section id="paneel-richard-queue"[\s\S]*?<\/section>/)[0];
    const badge = sectie.match(/<h2>Wacht op Richard <span class="badge warn">([^<]+)</)[1];
    const geteld = paneel.match(/(\d+) queue-item/);
    if (geteld === null) {
      // Zwijgt het paneel, dan hoort de sectie óók geen getal te tonen. Een badge `0` naast een
      // paneel dat weigert te tellen is precies de tegenspraak die deze proef moet vangen: beide
      // lezen dezelfde bronnen, dus beide moeten dezelfde onwetendheid melden.
      assert.match(paneel, /UNKNOWN — geen meting/);
      assert.equal(badge, 'UNKNOWN', `paneel telt niet, maar de sectie toont "${badge}"`);
    } else {
      assert.equal(geteld[1], badge, `sectie zegt ${badge}, paneel zegt ${geteld[1]}`);
    }
  }
});

test('de badgeklasse per stand ligt vast: alleen een gemeten nulstand is groen', () => {
  // Exacte klassen, geen `['ok','warn'].includes(...)`. Een mutant die UNKNOWN groen maakt zet een
  // stand waarin niets gemeten is naast een stand waarin niets openstaat — precies de verwarring
  // die dit paneel bestaat om te voorkomen (bevinding Codex, P2: overlevende mutant).
  const gevallen = [
    ['LEEG', 'ok', paneelVan(gemeten())],
    ['WACHT', 'warn', paneelVan(gemeten({ kanaalpost: { available: true, rows: [kanaalpostRij('A')], ingehouden: 0 } }))],
    ['GEDEELTELIJK', 'warn', paneelVan(gemeten({ planning: { available: false } }))],
    ['UNKNOWN', 'warn', paneelVan({ generatedAt: STEMPEL })],
  ];
  for (const [stand, klasse, p] of gevallen) {
    assert.equal(p.status, stand);
    assert.equal(richardQueueBadge(p), klasse, `${stand} hoort klasse ${klasse} te krijgen`);
  }
  // Een stand die niet in de lijst staat is geen groen licht: onbekend valt naar waarschuwing.
  assert.equal(richardQueueBadge({ status: 'VERZONNEN' }), 'warn');
  assert.equal(richardQueueBadge(null), 'warn');
  assert.equal(richardQueueBadge(undefined), 'warn');
});

test('renderRichardQueueBody ontsnapt élk veld, ook status, reden, label en leegtekst', () => {
  // Rechtstreeks op de renderer, niet via een snapshot: zo bindt de proef dat er geen enkel veld
  // buiten `esc()` om op de plaat komt. Een mutant die `esc()` van één regel afhaalt valt hier om,
  // ook als geen enkele echte bron dat veld ooit vult (bevinding Codex + Gemini).
  const body = renderRichardQueueBody({
    status: '<b>STAND</b>',
    reden: '<i>reden</i>',
    leegTekst: '<u>leeg</u>',
    regels: [
      { label: '<span>label</span>', waarde: '<em>waarde</em>' },
      { label: '<script>x</script>', waarde: null },
    ],
  });
  // De renderer maakt zelf `<span class="...">`-elementen; wat hier NIET mag voorkomen is de
  // aangeleverde markup zelf — een kaal `<span>` zonder attribuut, of een van de andere tags.
  assert.equal(/<(b|i|u|em|script)[>\s]/.test(body), false, body);
  assert.equal(body.includes('<span>'), false, body);
  assert.match(body, /&lt;b&gt;STAND&lt;\/b&gt;/);
  assert.match(body, /&lt;em&gt;waarde&lt;\/em&gt;/);
  assert.match(body, /&lt;u&gt;leeg&lt;\/u&gt;/);
});

test('een bouwstempel dat geen ISO-tijdstip is wordt niet afgedrukt, wat er ook in staat', () => {
  // `esc()` maakt van een pad geen markup, maar redigeert het ook niet. Alles wat niet exact een
  // ISO-8601-UTC-stempel is, hoort nergens op de plaat te belanden (bevinding Codex, P2).
  const vies = '/Users/iemand/geheim/pad.json';
  const p = paneelVan(gemeten({ generatedAt: vies }));
  assert.equal(p.measuredAt, null);
  const body = renderRichardQueueBody(p);
  assert.equal(body.includes('geheim'), false, body);
  assert.match(body, /Gebouwd<\/span><span class="unknown">UNKNOWN/);

  for (const rommel of [12345, { toString: () => STEMPEL }, ['2026-08-12T11:59:00Z'], true,
    '2026-08-12 11:59:00', '2026-13-45T99:99:99Z', `${STEMPEL} extra`]) {
    assert.equal(paneelVan(gemeten({ generatedAt: rommel })).measuredAt, null, JSON.stringify(rommel));
  }
});

test('een spiegeltelling die geen geheel getal is telt als onbekend, niet als nul', () => {
  // `ingehouden: null` betekent "de spiegel meldt het niet"; dat is GEDEELTELIJK en geen LEEG. Een
  // `?? 0` of een `Number()`-conversie zou hier een gemeten nulstand verzinnen (bevinding Codex, P1).
  for (const rommel of [undefined, null, '0', 1.5, -1, NaN, {}]) {
    const p = paneelVan(gemeten({ kanaalpost: { available: true, rows: [], ingehouden: rommel } }));
    assert.equal(p.ingehouden, null, JSON.stringify(rommel));
    assert.equal(p.status, 'GEDEELTELIJK', JSON.stringify(rommel));
    assert.match(p.reden, /meldt niet hoeveel rijen de publicatiepoort niet haalden/);
    assert.match(renderRichardQueueBody(p), /Ingehouden spiegelrijen<\/span><span class="unknown">UNKNOWN/);
  }
});

test('één ingehouden spiegelrij is enkelvoud, meer zijn meervoud', () => {
  const een = paneelVan(gemeten({ kanaalpost: { available: true, rows: [], ingehouden: 1 } }));
  const twee = paneelVan(gemeten({ kanaalpost: { available: true, rows: [], ingehouden: 2 } }));
  assert.match(een.reden, /1 spiegelrij haalde de publicatiepoort niet/);
  assert.match(twee.reden, /2 spiegelrijen haalde de publicatiepoort niet/);
});

test('een ownerresultaat dat het broncontract breekt is niet telbaar, ook niet gedeeltelijk', () => {
  // Half geldig bestaat hier niet: één poort zonder identiteit of één bronstatus zonder bronnaam
  // maakt élk getal uit dit object onbetrouwbaar, dus valt de hele telling weg (Codex, P2).
  const gebroken = [
    { gates: [{ label: 'geen identiteit' }], unavailable: [] },
    { gates: [{ identity: '  ', label: 'lege identiteit' }], unavailable: [] },
    { gates: [null], unavailable: [] },
    { gates: [], unavailable: ['kale tekst'] },
    { gates: [], unavailable: [{ source: 'verzonnen-bron', message: 'x' }] },
    { gates: [], unavailable: [{ source: 'planning', message: '' }] },
    // Dubbele bron: `ownerGates()` levert er per bron hoogstens één, en juist daarop rust de teller.
    { gates: [], unavailable: [{ source: 'planning', message: 'a' }, { source: 'planning', message: 'b' }] },
  ];
  for (const res of gebroken) {
    const p = richardQueuePaneel(gemeten(), res, { now: NU });
    assert.equal(p.status, 'UNKNOWN', JSON.stringify(res));
    assert.equal(p.poorten, 0, JSON.stringify(res));
    // Ook de noemerregel valt weg: er is geen bron waarop dat getal nog slaat.
    assert.match(renderRichardQueueBody(p), /Ongemeten ownerbronnen<\/span><span class="unknown">UNKNOWN/);
  }
});

test('een kapotte klok kost hoogstens de leeftijdsweergave, nooit de plaat', () => {
  // `Number(now)` werpt op een Symbol en op elk object met een werpende `valueOf()`; een paneel dat
  // werpt neemt de hele pagina mee (bevinding Codex, P3).
  const owner = ownerGates(gemeten());
  for (const klok of [Symbol('nu'), { valueOf() { throw new Error('kapot'); } }, new Date('onzin'),
    NaN, Infinity, 'gisteren', null]) {
    const p = richardQueuePaneel(gemeten(), owner, { now: klok });
    assert.equal(p.measuredAt, STEMPEL, String(typeof klok));
    assert.match(renderRichardQueueBody(p), /Gebouwd<\/span><span class="muted">2026-08-12T11:59:00Z</);
  }
  // Een getal als klok werkt wél, want dat is een geldige epoch-waarde.
  const metGetal = richardQueuePaneel(gemeten(), owner, { now: Date.parse(NU.toISOString()) });
  assert.match(renderRichardQueueBody(metGetal), /1m geleden/);
});
