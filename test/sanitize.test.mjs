import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeString, sanitizeTree, assertPublishable } from '../scripts/lib/sanitize.mjs';

// De testwaarden hieronder zijn verzonnen en volgen alleen het vórmpatroon van een echte
// sleutel. Er staat bewust geen enkel echt credential in deze repo.

test('redigeert een github-token-vorm', () => {
  const { value, findings } = sanitizeString('token=ghp_' + 'A'.repeat(36));
  assert.equal(value.includes('ghp_'), false);
  assert.equal(findings[0].id, 'github-token');
});

test('redigeert secret-NAMEN, niet alleen waarden', () => {
  const { value, findings } = sanitizeString('vereist ORG_PR_READ_TOKEN in CI');
  assert.equal(value.includes('ORG_PR_READ_TOKEN'), false);
  assert.ok(findings.some((f) => f.id === 'secret-name'));
});

test('redigeert lokale paden en e-mailadressen', () => {
  const p = sanitizeString('/Users/iemand/geheim/map/bestand.md');
  assert.equal(p.value.includes('/Users/'), false);
  const e = sanitizeString('contact: naam@voorbeeld.nl');
  assert.equal(e.value.includes('@voorbeeld.nl'), false);
});

test('spaart een git-SHA — dat is juist bewijsmateriaal', () => {
  const sha = 'a'.repeat(40);
  const { value, findings } = sanitizeString(`commit ${sha}`);
  assert.ok(value.includes(sha));
  assert.equal(findings.length, 0);
});

test('vangt hoog-entropische niet-hex strings', () => {
  const { value } = sanitizeString('blob ' + 'Zk9_'.repeat(15));
  assert.ok(value.includes('[REDACTED]'));
});

test('vangt klassiek base64 mét slashes', () => {
  const { value, findings } = sanitizeString('payload ' + 'aB9/'.repeat(15));
  assert.ok(value.includes('[REDACTED]'));
  assert.ok(findings.some((f) => f.id === 'high-entropy'));
});

test('laat een lange bewijs-URL naar GitHub ongemoeid', () => {
  const url = 'https://github.com/voorbeeld/stack-control/blob/main/AUDIT-INPUT/stack-open-beslispunten.md';
  const { value, findings } = sanitizeString(url);
  assert.equal(value, url, 'een proofUrl is bewijs, geen blob');
  assert.equal(findings.length, 0);
});

test('laat gewone tekst met rust', () => {
  const text = 'Open pull requests per repo, stand van 23 juli.';
  const { value, findings } = sanitizeString(text);
  assert.equal(value, text);
  assert.equal(findings.length, 0);
});

test('loopt geneste structuren af en meldt het pad', () => {
  const { value, findings } = sanitizeTree({ a: [{ b: 'sk-' + 'x'.repeat(24) }] });
  assert.equal(value.a[0].b.includes('sk-'), false);
  assert.equal(findings[0].path, '$.a[0].b');
});

test('assertPublishable is fail-closed en lekt de waarde niet in de foutmelding', () => {
  const geheim = 'AKIA' + 'B'.repeat(16);
  assert.throws(
    () => assertPublishable({ note: geheim }),
    (err) => {
      assert.match(err.message, /SANITIZE-GATE geblokkeerd/);
      assert.match(err.message, /aws-access-key @ \$\.note/);
      assert.equal(err.message.includes(geheim), false, 'foutmelding mag de waarde nooit bevatten');
      return true;
    },
  );
});

test('niet-strikte modus redigeert en telt in plaats van te breken', () => {
  const { snapshot, findings } = assertPublishable({ note: 'ghp_' + 'C'.repeat(36) }, { strict: false });
  assert.equal(snapshot.note.includes('ghp_'), false);
  assert.equal(findings.length, 1);
});
