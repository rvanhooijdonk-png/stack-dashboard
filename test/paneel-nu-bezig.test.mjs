/**
 * PANEEL NU-BEZIG — de telling achter de "Nu actief"-sectie.
 *
 * Wat deze suite bindt is niet "staan de goede woorden op de plaat" maar de twee eigenschappen waar
 * dit paneel op rust: (1) de telling komt letterlijk uit `activeWork()`, dezelfde functie die de
 * sectie en de browserpolling gebruiken, zodat paneel en sectie elkaar niet kunnen tegenspreken; en
 * (2) een meting die geen telling kan dragen levert UNKNOWN op en géén nul — verouderd, teruggevallen
 * of tegenstrijdig materiaal mag nooit als "niemand bezig" op de plaat komen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRuntimeFeed } from '../scripts/lib/runtime-feed.mjs';
import { activeWork } from '../scripts/lib/runtime-feed-view.mjs';
import { nuBezigPaneel, renderNuBezigBody, nuBezigBadge } from '../scripts/lib/paneel-nu-bezig.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NU = new Date('2026-08-12T12:00:00Z');
const NU_MS = NU.getTime();

const fixture = async (naam) => JSON.parse(await readFile(join(ROOT, `test/fixtures/runtime-feed/${naam}.json`), 'utf8'));
const feedVan = async (naam) => parseRuntimeFeed(await fixture(naam), { now: NU });

const gezond = await feedVan('volledig-gezond');

test('een verse feed met uitsluitend bewezen werk telt BEZIG, met teller én noemer', () => {
  const paneel = nuBezigPaneel(gezond, NU_MS);
  assert.equal(paneel.status, 'BEZIG');
  assert.equal(paneel.bezig, 1);
  assert.equal(paneel.gelezen, 1);
  assert.equal(nuBezigBadge(paneel), 'ok');
  const body = renderNuBezigBody(paneel);
  assert.match(body, /Bewezen bezig<\/span><span class="muted">1 van 1 taakregels/);
  assert.match(body, /Zonder volledig bewijs<\/span><span class="muted">0 taakregels/);
  assert.match(body, /Meting<\/span><span class="muted">CURRENT · 1m geleden/);
});

test('teller en noemer komen letterlijk uit activeWork() — het paneel leest de feed niet zelf', async () => {
  // De anti-tegenspraakbinding. Zou dit paneel zijn eigen bewijstoets schrijven, dan kon het "3
  // bezig" melden boven een sectie die er twee toont. Deze proef vergelijkt over de volle
  // fixtureset met de functie die de sectie en de browserpolling óók gebruiken.
  for (const naam of [
    'volledig-gezond', 'stale-feed', 'dubbele-actors', 'conflicterende-status',
    'planner-leeft-worker-ontbreekt', 'mini-rood-macbook-groen', 'future-timestamp', 'alles-onbekend',
  ]) {
    const feed = await feedVan(naam);
    const werk = activeWork(feed);
    const paneel = nuBezigPaneel(feed, NU_MS);
    assert.equal(paneel.bezig, werk.active.length, `${naam}: teller wijkt af van activeWork()`);
    assert.equal(paneel.gelezen, werk.active.length + werk.incomplete, `${naam}: noemer wijkt af van activeWork()`);
  }
});

test('een taakregel zonder volledig bewijs maakt het paneel GEDEELTELIJK, niet stilzwijgend leeg', async () => {
  const raw = await fixture('volledig-gezond');
  // Tweede actor met een taak die alleen een start claimt: geen pickup, geen heartbeat. Precies het
  // materiaal dat `activeWork()` weigert als bewijs van actief werk.
  raw.actors.push({
    actor_id: 'actor-charlie',
    current_task: { task_id: 'task-200', worker_started: '2026-08-12T11:50:00Z', last_heartbeat: null, pickup: null },
    closed: [],
    incidents: [],
  });
  const paneel = nuBezigPaneel(parseRuntimeFeed(raw, { now: NU }), NU_MS);
  assert.equal(paneel.status, 'GEDEELTELIJK');
  assert.equal(paneel.bezig, 1);
  assert.equal(paneel.gelezen, 2);
  assert.equal(nuBezigBadge(paneel), 'warn');
  assert.match(renderNuBezigBody(paneel), /1 van de 2 taakregels draagt geen volledig bewijs/);
  assert.match(renderNuBezigBody(paneel), /Zonder volledig bewijs<\/span><span class="muted">1 taakregel</);
});

test('NC — een taak die zichzelf actief noemt maar zijn identiteit heeft geredigeerd, telt niet mee', async () => {
  // Dit is de proef die een SOEPELER paneelregel doodt. Een vuller die zelf zou tellen op
  // `task.active === true` — de vlag die de feed zelf zet — vindt hier twee bezige regels, terwijl
  // `activeWork()` er één telt: zonder zichtbaar actor- en task-id is er geen identiteitsbewijs en
  // dus geen aantoonbaar actief werk. Geen enkele bestaande fixture scheidt die twee regels; deze
  // rij doet dat wel.
  const raw = await fixture('volledig-gezond');
  raw.actors.push({
    actor_id: `ghp_${'A'.repeat(36)}`,
    current_task: {
      task_id: 'task-300',
      worker_started: '2026-08-12T11:50:00Z',
      last_heartbeat: '2026-08-12T11:58:00Z',
      pickup: { proven: true, at: '2026-08-12T11:50:30Z', evidence_ref: { kind: 'RECEIPT_ID', ref: 'receipt-task-300', url: null } },
    },
    closed: [],
    incidents: [],
  });
  const feed = parseRuntimeFeed(raw, { now: NU });
  // De feed zelf zegt van beide taken dat ze actief zijn — daar zit de val.
  assert.equal(feed.actors.filter((a) => a.current_task?.active === true).length, 2);
  const paneel = nuBezigPaneel(feed, NU_MS);
  assert.equal(paneel.bezig, 1);
  assert.equal(paneel.gelezen, 2);
  assert.equal(paneel.status, 'GEDEELTELIJK');
});

// --- Negatieve controles: wat NIET als stand op de plaat mag komen --------------------------------

test('NC — een verouderde meting levert UNKNOWN op en géén telling: stilte is geen nulstand', async () => {
  const paneel = nuBezigPaneel(await feedVan('stale-feed'), NU_MS);
  assert.equal(paneel.status, 'UNKNOWN');
  assert.match(paneel.reden, /STALE — een telling uit een niet-verse meting is geen nulstand/);
  const body = renderNuBezigBody(paneel);
  // Precies dít is de mutant die deze proef moet doden: een paneel dat óók bij STALE gewoon "0 van
  // 0" neerzet. `activeWork()` geeft daar per definitie nul bewezen regels (dat vereist CURRENT),
  // dus die nul zou een nulstand tonen die niemand heeft gemeten.
  assert.equal(/van \d+ taakregels/.test(body), false, body);
  assert.match(body, /Bewezen bezig<\/span><span class="unknown">UNKNOWN — geen meting/);
  // Het MEETMOMENT blijft wél staan — er is gemeten, alleen niet vers genoeg om op te tellen.
  assert.match(body, /Meting<\/span><span class="muted">STALE/);
  assert.equal(nuBezigBadge(paneel), 'warn');
});

test('NC — een teruggevallen lezing meldt de terugval, niet alleen dat de meting oud is', () => {
  // Synthetisch: `loadRuntimeFeed()` zet een terugval nooit op CURRENT, dus de versheidsregel zou
  // hem ook vangen — maar dan met de verkeerde reden. Deze proef pint de volgorde vast: de lezer
  // hoort te zien dát het live lezen mislukte.
  const feed = { ...gezond, fallback: { used: true, reason: 'ophalen mislukte' } };
  const paneel = nuBezigPaneel(feed, NU_MS);
  assert.equal(paneel.status, 'UNKNOWN');
  assert.match(paneel.reden, /laatst bekende geldige meting, geen live lezing \(ophalen mislukte\)/);
  assert.equal(/van \d+ taakregels/.test(renderNuBezigBody(paneel)), false);
});

test('NC — een vijandige terugvalreden komt geëscaped op de plaat, nooit als opmaak', () => {
  const feed = { ...gezond, fallback: { used: true, reason: '<img src=x onerror=alert(1)>' } };
  const body = renderNuBezigBody(nuBezigPaneel(feed, NU_MS));
  assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(/<img src=x/.test(body), false);
});

test('NC — een tegenstrijdige identiteit wordt AFWIJKING, nooit een schone nulstand', async () => {
  for (const naam of ['dubbele-actors', 'conflicterende-status']) {
    const paneel = nuBezigPaneel(await feedVan(naam), NU_MS);
    assert.equal(paneel.status, 'AFWIJKING', naam);
    assert.equal(nuBezigBadge(paneel), 'bad', naam);
    assert.match(paneel.reden, /dezelfde actor- of task-identiteit/, naam);
  }
  // De volgorde is het punt: `dubbele-actors` heeft nul taakregels en zou zonder deze voorrang als
  // LEEG ("er is niemand aantoonbaar bezig") op de plaat komen — een schone melding uit een feed
  // die zichzelf tegenspreekt.
  const dubbel = nuBezigPaneel(await feedVan('dubbele-actors'), NU_MS);
  assert.equal(dubbel.gelezen, 0);
  assert.notEqual(dubbel.status, 'LEEG');

  // En de telling zelf blijft leeg. De eerste versie meldde AFWIJKING én drukte er "0 van 0
  // taakregels" onder: het paneel sprak zichzelf in twee opeenvolgende regels tegen, en die nul was
  // precies de nulstand die dit paneel nergens mag tonen (review Gemini, ronde 1). Een telling over
  // regels die dezelfde identiteit claimen betekent niets — er staat dus geen getal, met de reden
  // erbij waarom niet.
  const body = renderNuBezigBody(dubbel);
  assert.equal(/van \d+ taakregels/.test(body), false, body);
  assert.match(body, /NIET TELBAAR — dubbele identiteit/);
  // Het meetmoment blijft wél staan: er ís gemeten, de meting is alleen niet optelbaar.
  assert.match(body, /Meting<\/span><span class="muted">CURRENT/);
});

test('een verse meting zonder taakregels is wél een echte nulstand en heet LEEG', async () => {
  const paneel = nuBezigPaneel(await feedVan('planner-leeft-worker-ontbreekt'), NU_MS);
  assert.equal(paneel.status, 'LEEG');
  assert.equal(paneel.gelezen, 0);
  assert.equal(nuBezigBadge(paneel), 'ok');
  assert.match(paneel.reden, /vers en noemt geen enkele taakregel/);
  // Het onderscheid met UNKNOWN is de hele kern: hier is er wél gemeten.
  assert.match(renderNuBezigBody(paneel), /Bewezen bezig<\/span><span class="muted">0 van 0 taakregels/);
});

test('NC — een onbeschikbare of misvormde feed klapt niet en toont geen enkele telling', () => {
  for (const kapot of [null, undefined, 'geen feed', 0, {}, { available: false }, { available: 'ja' }]) {
    const paneel = nuBezigPaneel(kapot, NU_MS);
    assert.equal(paneel.status, 'UNKNOWN', JSON.stringify(kapot));
    assert.match(paneel.reden, /niet beschikbaar of niet contractgeldig/);
    assert.equal(paneel.measuredAt, null);
    const body = renderNuBezigBody(paneel);
    assert.equal(/van \d+ taakregels/.test(body), false, body);
    assert.match(body, /Meting<\/span><span class="unknown">UNKNOWN — geen meting/);
  }
});

test('NC — een onleesbaar meetmoment wordt niet als tijdstip getoond', () => {
  const feed = { ...gezond, measured_at: { value: 'geen tijdstip', freshness: 'UNKNOWN' }, freshness: 'UNKNOWN' };
  const paneel = nuBezigPaneel(feed, NU_MS);
  assert.equal(paneel.measuredAt, null);
  assert.equal(paneel.status, 'UNKNOWN');
});

test('NC — een onbekende paneelstatus valt terug op de voorzichtige badge, niet op groen', () => {
  assert.equal(nuBezigBadge({ status: 'VERZONNEN' }), 'warn');
  assert.equal(nuBezigBadge({}), 'warn');
});
