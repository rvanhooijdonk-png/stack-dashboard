/**
 * RUNTIME-POLL — vervangt de polling BEIDE plekken die dezelfde feed tonen?
 *
 * De sectie "Nu actief" en het NU-BEZIG-paneel lezen één feed. Ververst de browser alleen de
 * sectie, dan blijft het paneel op de telling van het bouwmoment staan en spreekt de plaat zichzelf
 * tegen: "0 van 0 taakregels" boven een sectie die twee actieve actoren toont. Dat is geen
 * cosmetisch verschil — het paneel draagt juist de noemer waarmee een lezer de sectie beoordeelt.
 *
 * DIT IS EEN UNITPROEF MET EEN STUB-DOM, EN DAT IS HIER EXPRES. De repository heeft bewust nul
 * afhankelijkheden (`package.json`), dus er is geen jsdom en die komt er ook niet voor deze proef
 * bij. De eigenschap die hier gemeten wordt is dan ook puur mechanisch: raakt `renderFeed()` beide
 * elementen. Het echte browserbewijs — modules die werkelijk laden, CSP die het toelaat, de plaat
 * die live meebeweegt — hoort in de acceptatieproef tegen een draaiende pagina, niet hier.
 *
 * De ingang wordt langs de FAIL-CLOSED route geraakt: zonder `<meta name="runtime-feed-origin">`
 * roept de module bij het laden meteen `renderUnknown()` aan. Dat is precies het pad dat nooit een
 * stand mag laten staan, en het draait zonder netwerk, timers of feed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/** Minimale DOM: alleen wat runtime-poll.mjs aanraakt, met een logboek van wat is vervangen. */
function stubDom({ metaContent = null } = {}) {
  const vervangen = new Map();
  const element = (id) => ({ id, set outerHTML(waarde) { vervangen.set(id, waarde); } });
  const elementen = new Map([
    ['nu-actief', element('nu-actief')],
    ['paneel-nu-bezig', element('paneel-nu-bezig')],
  ]);
  return {
    vervangen,
    document: {
      querySelector: () => (metaContent === null ? null : { getAttribute: () => metaContent }),
      getElementById: (id) => elementen.get(id) ?? null,
    },
  };
}

test('zonder origin vervangt de polling BEIDE plekken door de fail-closed weergave', async () => {
  const dom = stubDom();
  globalThis.document = dom.document;
  // Cache-buster: elke proef laadt de module vers, want de vervanging gebeurt bij het laden.
  await import('../scripts/lib/runtime-poll.mjs?proef=geen-origin');

  assert.deepEqual([...dom.vervangen.keys()].sort(), ['nu-actief', 'paneel-nu-bezig']);
  assert.match(dom.vervangen.get('nu-actief'), /UNKNOWN — runtimefeed niet beschikbaar of niet contractgeldig\./);
  const paneel = dom.vervangen.get('paneel-nu-bezig');
  assert.match(paneel, /<section id="paneel-nu-bezig" class="card" data-panel-slot="k">/);
  assert.match(paneel, /<h2>NU-BEZIG <span class="badge warn">UNKNOWN<\/span>/);
  assert.match(paneel, /UNKNOWN — de runtimefeed is niet beschikbaar of niet contractgeldig\./);
  // Geen telling in het fail-closed pad: een nul die niemand heeft gemeten is geen nulstand.
  assert.equal(/van \d+ taakregels/.test(paneel), false, paneel);
  delete globalThis.document;
});

test('een pagina zonder het paneel blijft werken — de sectie wordt gewoon ververst', async () => {
  // Oudere plaat, nieuwe polling: het slot bestaat daar nog niet. Dat mag geen TypeError geven,
  // anders neemt één ontbrekend element de hele verversing mee.
  const vervangen = new Map();
  globalThis.document = {
    querySelector: () => null,
    getElementById: (id) => (id === 'nu-actief'
      ? { id, set outerHTML(waarde) { vervangen.set(id, waarde); } } : null),
  };
  await import('../scripts/lib/runtime-poll.mjs?proef=zonder-paneel');
  assert.deepEqual([...vervangen.keys()], ['nu-actief']);
  delete globalThis.document;
});
