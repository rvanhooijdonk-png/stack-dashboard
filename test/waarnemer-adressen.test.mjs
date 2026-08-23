/**
 * WAARNEMER-ADRESSEN — welke van de twee adressen wordt afgeleid, en wanneer.
 *
 * `scripts/waarnemer.mjs` haalt twee dingen op: de openbare plaat (`BASE_URL`) en de publieke
 * spiegel (`SPIEGEL_URL`). Beide worden afgeleid uit de identiteit van DEZE repository, tenzij ze
 * meegegeven zijn. Tot deze reparatie werd die identiteit onvoorwaardelijk opgelost, ook wanneer er
 * niets meer af te leiden viel — waardoor de gedocumenteerde handmatige route
 * (`BASE_URL=… SPIEGEL_URL=… node scripts/waarnemer.mjs`, zie
 * `docs/RAPPORT-2026-07-26-napublicatie-en-spiegelwet.md`) buiten Actions strandde op een
 * identiteitsfout over een repository waarover die run niets vroeg.
 *
 * DE PROEF IS INDIRECT, EN DAT IS EXPRES. Een afleiding meten door de afgeleide URL op te halen zou
 * netwerk vragen naar github.io — dat hoort niet in deze testsuite. In plaats daarvan staat er in de
 * ongeldige-override-gevallen een MISVORMDE `DASHBOARD_REPOSITORY`: die is stil zolang niemand de
 * identiteit nodig heeft, en werpt luid zodra iemand dat wél doet. De aanwezigheid of afwezigheid
 * van die fout is dus een zuivere meter voor "is er afgeleid?", zonder één byte netwerkverkeer.
 *
 * De twee halve gevallen zijn daarmee sluitend bewezen: het volledig expliciete geval toont dat een
 * meegegeven adres nooit afleidt, dus de fout in het halve geval kan alleen van het ONTBREKENDE
 * adres komen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';

const SCRIPT = 'scripts/waarnemer.mjs';

/** De identiteitsfouten die deze reparatie uit de volledig expliciete route moet houden. */
const IDENTITEITSFOUT = /DASHBOARD_REPOSITORY|origin van deze werkboom|kan de eigenaar van deze repository niet vaststellen/;

/**
 * Een omgeving zonder één van de variabelen die de uitkomst kunnen kleuren. Nodig omdat deze suite
 * óók in Actions draait, waar `GITHUB_REPOSITORY` en `GITHUB_OUTPUT` altijd gezet zijn: zonder deze
 * schoonmaak zou de proef daar per ongeluk groen zijn om de verkeerde reden.
 */
function draai(extra) {
  const env = { ...process.env };
  for (const sleutel of [
    'BASE_URL', 'SPIEGEL_URL', 'DASHBOARD_REPOSITORY', 'GITHUB_REPOSITORY', 'GITHUB_OUTPUT',
    'RIJ_BESTAND', 'SABOTAGE', 'DREMPEL_UREN', 'GRACE_MINUTEN',
  ]) delete env[sleutel];
  // Asynchroon, niet `spawnSync`: de plaatselijke bron hieronder draait in DIT proces, en een
  // synchrone start zou de eventloop blokkeren waarop die server moet antwoorden. Het kind zou dan
  // in zijn eigen ophaal-timeout lopen tegen een server die stilstaat — een testfout die zich
  // voordoet als een productiefout.
  return new Promise((klaar, mis) => {
    const kind = spawn(process.execPath, [SCRIPT], { env: { ...env, ...extra }, timeout: 60_000 });
    let stdout = ''; let stderr = '';
    kind.stdout.setEncoding('utf8'); kind.stdout.on('data', (d) => { stdout += d; });
    kind.stderr.setEncoding('utf8'); kind.stderr.on('data', (d) => { stderr += d; });
    kind.on('error', mis);
    kind.on('close', (status) => klaar({ status, stdout, stderr }));
  });
}

/** Een plaatselijke plaat + spiegel, zodat een volledig expliciete run echt iets ophaalt. */
async function plaatselijkeBron(t) {
  const gezien = [];
  const server = createServer((req, res) => {
    const route = req.url.split('?')[0];
    gezien.push(route);
    if (route === '/contentstroom.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><footer>Gegenereerd door <code>stack-dashboard</code> '
        + '(contract 2.4.0)</footer></body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('# publieke spiegel\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((klaar) => server.close(klaar)));
  const { port } = server.address();
  return {
    gezien,
    base: `http://127.0.0.1:${port}/contentstroom.html`,
    spiegel: `http://127.0.0.1:${port}/kanaalpost-publiek.md`,
  };
}

// --- 1. Het gerepareerde geval ------------------------------------------------------------------

test('met BEIDE adressen expliciet draait de waarnemer buiten Actions, zonder identiteit', async (t) => {
  const bron = await plaatselijkeBron(t);
  const cli = await draai({ BASE_URL: bron.base, SPIEGEL_URL: bron.spiegel });

  assert.doesNotMatch(cli.stderr, IDENTITEITSFOUT, cli.stderr);
  // Niet alleen "geen fout": beide MEEGEGEVEN adressen zijn ook werkelijk opgehaald, en de run is
  // doorgelopen tot het oordeel. Anders zou een script dat stilletjes niets doet hier slagen.
  assert.deepEqual([...bron.gezien].sort(), ['/contentstroom.html', '/kanaalpost-publiek.md']);
  assert.match(cli.stdout, /waarnemer — pagina http 200, logboek http 200/);
  assert.match(cli.stdout, /AFWIJKING/);
  assert.equal(cli.status, 1);
});

test('een misvormde override blokkeert een volledig expliciete run niet', async (t) => {
  // De keerzijde van criterium 5. `DASHBOARD_REPOSITORY` is hier onzin, maar deze run vraagt niets
  // over deze repository — dan hoort die onzin ook niets tegen te houden.
  const bron = await plaatselijkeBron(t);
  const cli = await draai({ BASE_URL: bron.base, SPIEGEL_URL: bron.spiegel, DASHBOARD_REPOSITORY: 'kapot' });

  assert.doesNotMatch(cli.stderr, IDENTITEITSFOUT, cli.stderr);
  assert.deepEqual([...bron.gezien].sort(), ['/contentstroom.html', '/kanaalpost-publiek.md']);
  assert.equal(cli.status, 1);
});

// --- 2. De halve gevallen: precies het ontbrekende adres wordt afgeleid --------------------------

test('alleen BASE_URL expliciet: de spiegel wordt wél afgeleid, en faalt luid op een kapotte override', async () => {
  const cli = await draai({ BASE_URL: 'http://127.0.0.1:1/contentstroom.html', DASHBOARD_REPOSITORY: 'kapot' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /DASHBOARD_REPOSITORY is gezet op "kapot"/);
});

test('alleen SPIEGEL_URL expliciet: de plaat wordt wél afgeleid, en faalt luid op een kapotte override', async () => {
  const cli = await draai({ SPIEGEL_URL: 'http://127.0.0.1:1/kanaalpost-publiek.md', DASHBOARD_REPOSITORY: 'kapot' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /DASHBOARD_REPOSITORY is gezet op "kapot"/);
});

// --- 3. Geen adressen: de fail-closed afleiding blijft ongewijzigd -------------------------------

test('zonder adressen blijft een kapotte override luid falen', async () => {
  const cli = await draai({ DASHBOARD_REPOSITORY: 'kapot' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /DASHBOARD_REPOSITORY is gezet op "kapot"/);
});

test('zonder adressen en zonder repository-identiteit blijft de waarnemer fail-closed', async () => {
  // Geen stille terugval op de `origin` van deze werkboom: die kent alleen het moment van klonen.
  const cli = await draai({});
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /origin van deze werkboom|kan de eigenaar van deze repository niet vaststellen/);
  assert.doesNotMatch(cli.stdout, /waarnemer — pagina http/);
});
