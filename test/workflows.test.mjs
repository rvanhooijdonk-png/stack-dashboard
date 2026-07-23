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
  // publish.yml. Deze test houdt die regressie tegen.
  for (const [naam, tekst] of [['publish', publish], ['pr-check', prCheck]]) {
    const treffer = tekst.match(/^\s*run: (node --test.*)$/m);
    assert.ok(treffer, `geen teststap gevonden in ${naam}.yml`);
    assert.equal(treffer[1], 'node --test', `${naam}.yml geeft --test een pad-argument`);
  }
});
