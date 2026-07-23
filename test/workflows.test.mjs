import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// pr-check.yml en publish.yml delen bewust een aantal waarden. Een comment die vraagt of je
// eraan wilt denken is geen poort; deze test is dat wel.

const publish = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
const prCheck = readFileSync(new URL('../.github/workflows/pr-check.yml', import.meta.url), 'utf8');

const waarde = (tekst, sleutel) => {
  const treffer = tekst.match(new RegExp(`^\\s*${sleutel}:\\s*(\\S+)\\s*$`, 'm'));
  assert.ok(treffer, `${sleutel} niet gevonden`);
  return treffer[1];
};

test('beide workflows pinnen dezelfde gitleaks-versie', () => {
  assert.equal(waarde(prCheck, 'GITLEAKS_VERSION'), waarde(publish, 'GITLEAKS_VERSION'));
});

test('beide workflows pinnen dezelfde gitleaks-checksum', () => {
  assert.equal(waarde(prCheck, 'GITLEAKS_SHA256'), waarde(publish, 'GITLEAKS_SHA256'));
});

test('de PR-controle publiceert niets — geen upload, geen deploy', () => {
  assert.ok(!prCheck.includes('upload-pages-artifact'), 'pr-check mag geen artefact uploaden');
  assert.ok(!prCheck.includes('deploy-pages'), 'pr-check mag niet deployen');
  assert.ok(!prCheck.includes('pages: write'), 'pr-check hoort geen pages-schrijfrecht te vragen');
});

test('publiceren blijft main-only — publish.yml draait niet op pull requests', () => {
  assert.ok(!/^\s*pull_request:/m.test(publish));
});

test('de teststap draait zonder pad-argument in beide workflows', () => {
  // Een glob werkt niet op node 20 en een map-argument crasht node 24; zie de comment in
  // publish.yml. Deze test houdt die regressie tegen. Álle voorkomens, niet alleen de eerste:
  // een correcte regel bovenaan mag geen verkeerde eronder maskeren.
  for (const [naam, tekst] of [['publish', publish], ['pr-check', prCheck]]) {
    const treffers = [...tekst.matchAll(/^\s*run: (node --test.*)$/gm)].map((m) => m[1]);
    assert.ok(treffers.length > 0, `geen teststap gevonden in ${naam}.yml`);
    for (const treffer of treffers) {
      assert.equal(treffer, 'node --test', `${naam}.yml geeft --test een pad-argument`);
    }
  }
});

test('de PR-controle krijgt geen org-secret te zien', () => {
  // Bij een PR vanuit een branch in deze repository zijn org-secrets beschikbaar terwijl
  // checkout de PR-code uitvoert; die combinatie laat een PR het token wegsturen. De
  // publish-workflow op main mag het token wél gebruiken.
  assert.ok(!/secrets\./.test(prCheck), 'pr-check mag geen enkel secret aanspreken');
  assert.ok(publish.includes('secrets.ORG_PR_READ_TOKEN'), 'publish hoort het token wél te gebruiken');
});

// Haalt het scriptlichaam van een `run: |`-stap op, op naam van de stap.
const stapScript = (tekst, naam) => {
  const regels = tekst.split('\n');
  const start = regels.findIndex((r) => r.trim().startsWith(`- name: ${naam}`));
  assert.ok(start !== -1, `stap "${naam}" niet gevonden`);
  const runOp = regels.findIndex((r, i) => i > start && r.trim() === 'run: |');
  assert.ok(runOp !== -1 && runOp <= start + 3, `stap "${naam}" heeft geen run-blok`);
  const inspringing = regels[runOp].search(/\S/) + 2;
  const lichaam = [];
  for (const regel of regels.slice(runOp + 1)) {
    if (regel.trim() !== '' && regel.search(/\S/) < inspringing) break;
    lichaam.push(regel.slice(inspringing));
  }
  return lichaam.join('\n').trimEnd();
};

test('beide workflows draaien exact dezelfde zelftest op de secretsscan', () => {
  // De zelftest is de enige stap die bewijst dat de scan geen placebo is. Loopt hij tussen de
  // twee bestanden uiteen, dan controleert de PR iets anders dan wat main straks doet.
  const naam = 'Zelftest — een nepsecret MOET de scan laten falen';
  const script = stapScript(publish, naam);
  assert.equal(stapScript(prCheck, naam), script);
  // En de twee eigenschappen die deze stap fail-closed maken, expliciet vastgelegd:
  // gitleaks gebruikt exit 1 voor zowel "gevonden" als "scannerfout".
  assert.ok(script.includes('--exit-code 42'), 'de zelftest moet een eigen exitcode afdwingen');
  assert.ok(/-ne 42/.test(script), 'alleen exitcode 42 mag als vangst tellen');
});
