/**
 * DE BEDRADING — draait `node scripts/waarnemer.mjs` als los proces tegen een echte HTTP-server.
 *
 * Waarom dit bestand bestaat. `test/waarnemer.test.mjs` dekt de oordeelslaag: `statusUitTekst()` en
 * `toets()` worden daar in hetzelfde proces aangeroepen. De helper daar heet "de executor-route",
 * maar hij ís de executor niet — en precies dat verschil bleek een gat. Codex verwijderde in ronde
 * 10 vier verbindingen uit `scripts/waarnemer.mjs` en de suite bleef alle vier de keren
 * 1124/1124 groen:
 *
 *   1. `bronContractVersie` niet meer doorgeven aan `toets()` — het contractgat van ronde 9 ging
 *      daarmee weer helemaal open.
 *   2. `nevenpunten` niet meer doorgeven aan `alarmRij()` — de categorie verdween weer uit de
 *      openbare melding (orderdiscipline R2).
 *   3. `nevenpunten` niet meer meegeven aan `magAppenden()` — dan staat er in de geschreven regel
 *      een controlepunt dat de herhaalcontrole niet kent, en is elke melding voor eeuwig "nieuw".
 *   4. De regel `uitvoer('ongeteld', ...)` weghalen — dan draagt het run-receipt de categorie niet
 *      meer op een groene ronde, en dat is juist de ronde zonder openbare regel.
 *
 * Een test die de bibliotheek aanroept kan dat per definitie niet zien. Daarom start dit bestand
 * een echte server, spawnt het echte script met de echte omgevingsvariabelen, en kijkt naar wat er
 * uit komt: de uitvoerregels, de weggeschreven alarmregel en het `GITHUB_OUTPUT`-receipt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderHtml } from '../scripts/lib/render.mjs';
import { kanaalpostUitTekst, toPublicKanaalpost } from '../scripts/lib/kanaalpost.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(join(ROOT, 'data/fixture.json'), 'utf8'));
const spiegelBasis = await readFile(join(ROOT, 'data/kanaalpost-publiek.md'), 'utf8');
const STATUS_SCHEMA = JSON.parse(await readFile(join(ROOT, 'contracts/status-json.schema.json'), 'utf8'));
/** De versie die ONS schema pint. Alles daarnaast is voor de waakvlam een vreemde versie. */
const CONTRACT_NU = STATUS_SCHEMA.properties.contractVersion.const;
/** Een versie die het schema niet kent: dan geldt per bron alleen de kern, precies zoals bij een
 *  gepubliceerde kopie van een andere contractversie. */
const CONTRACT_VREEMD = '9.9.9';

/**
 * Bouwt de plaat zoals `build.mjs` dat doet, met een bouwmoment dat de test bepaalt. Er wordt hier
 * bewust NIET met een zelfgeschreven stukje HTML gewerkt: de executor leest de contractvoettekst en
 * de secties uit de echte gerenderde pagina.
 */
function plaat({ contract, gebouwdOp, spiegelTekst }) {
  const snap = structuredClone(fixture);
  snap.contractVersion = contract;
  snap.generatedAt = gebouwdOp;
  snap.kanaalpost = toPublicKanaalpost(kanaalpostUitTekst(spiegelTekst));
  return renderHtml(snap, { pagePath: './contentstroom.html' });
}

/** Exact de vier velden waarmee `build.mjs` `status.json` samenstelt. */
const statusTekst = ({ contract, gebouwdOp, sources }) => JSON.stringify({
  contractVersion: contract,
  generatedAt: gebouwdOp,
  overallStatus: 'OK',
  sources,
}, null, 2);

/**
 * Start de server, draait het echte script ertegenaan en ruimt alles weer op. De spiegel wordt óók
 * lokaal geserveerd: een test hoort niet van het netwerk af te hangen, en de herhaalcontrole leest
 * juist die tekst terug.
 */
async function draaiWaarnemer({ html, status, spiegelTekst = spiegelBasis, env = {} }) {
  const server = createServer((req, res) => {
    if (req.url.startsWith('/status.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(status);
    }
    if (req.url.startsWith('/spiegel.md')) {
      res.writeHead(200, { 'content-type': 'text/markdown' });
      return res.end(spiegelTekst);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(html);
  });
  await new Promise((klaar) => server.listen(0, '127.0.0.1', klaar));
  const poort = server.address().port;
  const werkmap = await mkdtemp(join(tmpdir(), 'waarnemer-bedrading-'));
  const rijBestand = join(werkmap, 'rij.txt');
  const receiptBestand = join(werkmap, 'receipt.txt');

  try {
    const uit = await new Promise((klaar) => {
      execFile(process.execPath, [join(ROOT, 'scripts/waarnemer.mjs')], {
        cwd: ROOT,
        env: {
          ...process.env,
          BASE_URL: `http://127.0.0.1:${poort}/contentstroom.html`,
          SPIEGEL_URL: `http://127.0.0.1:${poort}/spiegel.md`,
          RIJ_BESTAND: rijBestand,
          GITHUB_OUTPUT: receiptBestand,
          ...env,
        },
      }, (fout, stdout, stderr) => klaar({ code: fout?.code ?? 0, stdout: `${stdout}${stderr}` }));
    });
    const receipt = Object.fromEntries(
      (existsSync(receiptBestand) ? readFileSync(receiptBestand, 'utf8') : '')
        .split('\n').filter(Boolean).map((r) => [r.slice(0, r.indexOf('=')), r.slice(r.indexOf('=') + 1)]),
    );
    return {
      ...uit,
      receipt,
      rij: existsSync(rijBestand) ? readFileSync(rijBestand, 'utf8') : '',
    };
  } finally {
    await new Promise((klaar) => server.close(klaar));
    await rm(werkmap, { recursive: true, force: true });
  }
}

/** Een bron die haar herkomst draagt: key, trust én een tijdstip dat een tijdstip is. */
const bewezenBron = (gebouwdOp) => ({ key: 'x', trust: 'VERIFIED_CURRENT', retrievedAt: gebouwdOp });
/** Een bron die zich bewezen noemt zonder één van de kernvelden — het nevenpunt. */
const BRON_ZONDER_HERKOMST = { trust: 'VERIFIED_CURRENT' };

/** Vers genoeg om alle tijdtoetsen te halen; de tests die alarm willen forceren doen dat expliciet. */
const nuIso = () => new Date(Date.now() - 5 * 60 * 1000).toISOString();

test('de executor geeft de contractversie van het statusbestand door aan het oordeel', async () => {
  // Mutant 1 van Codex ronde 10: `bronContractVersie` weglaten uit de aanroep in scripts/waarnemer.mjs.
  // Dan noemen de plaat en het statusbestand ongestraft twee versies uit dezelfde bouw, en dat is
  // precies het gat van ronde 9.
  const gebouwdOp = nuIso();
  const r = await draaiWaarnemer({
    html: plaat({ contract: CONTRACT_NU, gebouwdOp, spiegelTekst: spiegelBasis }),
    status: statusTekst({ contract: CONTRACT_VREEMD, gebouwdOp, sources: [bewezenBron(gebouwdOp)] }),
  });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /AFWIJKING CONTRACT_UITEEN/);
  assert.match(r.stdout, new RegExp(`plaat ${CONTRACT_NU.replace(/\./g, '\\.')}, statusbestand 9\\.9\\.9`));
});

test('de geschreven alarmregel draagt de categorie van een bron zonder herkomst', async () => {
  // Mutant 2: `nevenpunten` weglaten uit de `alarmRij`-aanroep. De ronde blijft dan even rood, maar
  // de openbare regel noemt de oorzaak niet meer (orderdiscipline R2).
  const gebouwdOp = nuIso();
  const r = await draaiWaarnemer({
    html: plaat({ contract: CONTRACT_VREEMD, gebouwdOp, spiegelTekst: spiegelBasis }),
    status: statusTekst({
      contract: CONTRACT_VREEMD,
      gebouwdOp,
      sources: [bewezenBron(gebouwdOp), BRON_ZONDER_HERKOMST],
    }),
    // De aanleiding van het alarm is de stempel, niet de bronstand: er is één bewezen bron, dus
    // GEEN_GEVERIFIEERDE_BRON valt niet. Zo bewijst de test dat het nevenpunt MEEreist met een
    // alarm dat het zelf niet heeft veroorzaakt.
    env: { DREMPEL_UREN: '0.0001' },
  });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /AFWIJKING STEMPEL_TE_OUD/);
  assert.doesNotMatch(r.stdout, /AFWIJKING BRON_ZONDER_HERKOMST/);
  assert.match(r.rij, /controlepunten: [^)]*bron-zonder-herkomst/);
  assert.match(r.rij, /controlepunten: [^)]*stempel-te-oud/);
  assert.equal(r.receipt.appenden, 'ja');
  assert.equal(r.receipt.ongeteld, '1');
});

test('dezelfde melding, mét nevenpunt, wordt niet twee keer in de spiegel gezet', async () => {
  // Mutant 3: `nevenpunten` weglaten uit de `magAppenden`-aanroep. De herhaalcontrole leest de
  // controlepunten TERUG uit de geschreven regel en vergelijkt de verzameling; kent de ene kant het
  // nevenpunt niet, dan is elke melding voor eeuwig "nieuw" en loopt de spiegel vol.
  const gebouwdOp = nuIso();
  const opzet = {
    html: plaat({ contract: CONTRACT_VREEMD, gebouwdOp, spiegelTekst: spiegelBasis }),
    status: statusTekst({
      contract: CONTRACT_VREEMD,
      gebouwdOp,
      sources: [bewezenBron(gebouwdOp), BRON_ZONDER_HERKOMST],
    }),
    env: { DREMPEL_UREN: '0.0001' },
  };
  const eerste = await draaiWaarnemer(opzet);
  assert.equal(eerste.receipt.appenden, 'ja');

  // Precies zoals de meld-job het doet: de regel gaat onderaan de spiegel.
  const tweede = await draaiWaarnemer({ ...opzet, spiegelTekst: `${spiegelBasis.trimEnd()}\n${eerste.rij}` });
  assert.equal(tweede.code, 1);
  assert.match(tweede.stdout, /spiegel niet aangevuld: dezelfde melding staat al in de spiegel/);
  assert.equal(tweede.receipt.appenden, 'nee');
});

test('op een GROENE ronde draagt het run-receipt de ongetelde bronnen', async () => {
  // Mutant 4: de `uitvoer('ongeteld', ...)`-regel weghalen. Op een groene ronde komt er per ontwerp
  // geen openbare regel, dus dán is het receipt de enige plek waar de categorie nog staat.
  const gebouwdOp = nuIso();
  const r = await draaiWaarnemer({
    html: plaat({ contract: CONTRACT_VREEMD, gebouwdOp, spiegelTekst: spiegelBasis }),
    status: statusTekst({
      contract: CONTRACT_VREEMD,
      gebouwdOp,
      sources: [bewezenBron(gebouwdOp), BRON_ZONDER_HERKOMST],
    }),
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /✓ geen afwijking/);
  assert.equal(r.receipt.afwijking, 'nee');
  assert.equal(r.receipt.ongeteld, '1');
  assert.equal(r.rij, '');
});

test('NEGATIEVE CONTROLE — dezelfde opzet zonder ongetelde bron levert geen categorie', async () => {
  // Zonder deze controle zou een `ongeteld=1` dat er altijd staat de tests hierboven ook groen
  // houden. Nu moet het receipt aantoonbaar meebewegen met de werkelijke stand.
  const gebouwdOp = nuIso();
  const r = await draaiWaarnemer({
    html: plaat({ contract: CONTRACT_VREEMD, gebouwdOp, spiegelTekst: spiegelBasis }),
    status: statusTekst({ contract: CONTRACT_VREEMD, gebouwdOp, sources: [bewezenBron(gebouwdOp)] }),
  });
  assert.equal(r.code, 0);
  assert.equal(r.receipt.ongeteld, '0');
});
