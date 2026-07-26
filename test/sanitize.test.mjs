import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeString, sanitizeTree, assertPublishable, loadDenyTerms } from '../scripts/lib/sanitize.mjs';

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

test('redigeert ook een losstaande 40-hexwaarde — die vorm is niet alleen van git', () => {
  // Review Gemini: een legacy-token of session-ID heeft exact de vorm van een SHA. De
  // publieke DTO draagt geen SHA's meer, dus de oude uitzondering kostte alleen dekking.
  const { value } = sanitizeString('a'.repeat(40));
  assert.equal(value, '[REDACTED]');
});

test('spaart 40-hex NIET wanneer het middenin andere tekst staat', () => {
  const { value } = sanitizeString('commit ' + 'a'.repeat(40));
  assert.ok(value.includes('[REDACTED]'));
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

// --- Bevindingen uit de dubbele review van 23-07-2026 (Codex + Gemini) ---

test('saneert ook OBJECTSLEUTELS, niet alleen waarden', () => {
  const { value, findings } = sanitizeTree({ client_secret: 'ok' });
  assert.equal(Object.keys(value)[0], '[REDACTED]');
  assert.ok(findings.some((f) => f.id === 'secret-name'));
});

test('vangt niet-hoofdletterige secretnamen', () => {
  for (const naam of ['client_secret', 'api-key', 'githubToken', 'access_token']) {
    const { value } = sanitizeString(`veld ${naam} ontbreekt`);
    assert.equal(value.includes(naam), false, naam);
  }
});

test('vangt runner- en Windows-paden, niet alleen home', () => {
  for (const pad of ['/github/workspace/geheim', '/root/.ssh/config', 'C:\\Users\\iemand\\map']) {
    const { value } = sanitizeString(`pad ${pad}`);
    assert.equal(value.includes(pad), false, pad);
  }
});

test('breekt niet op gewoon proza over wachtwoorden', () => {
  const text = 'Rotatie van credentials staat nog open; password rotation volgt.';
  const { findings } = sanitizeString(text);
  assert.equal(findings.length, 0, 'proza mag de publicatie niet blokkeren');
});

test('laat een ISO-tijdstempel heel (IPv6-patroon mag die niet raken)', () => {
  const iso = '2026-07-23T12:00:00.000Z';
  const { value, findings } = sanitizeString(iso);
  assert.equal(value, iso);
  assert.equal(findings.length, 0);
});

test('kapt te lange strings af vóór regexverwerking (ReDoS-plafond)', () => {
  const evil = 'x@' + 'a.'.repeat(20000) + '1';
  const start = process.hrtime.bigint();
  const { value, findings } = sanitizeString(evil);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  // Volledig weg, geen prefix: een credential dat op de knip begint mag niet half overleven.
  assert.equal(value, '[REDACTED — te lang]');
  assert.ok(findings.some((f) => f.id === 'oversized'));
  assert.ok(ms < 250, `sanitize duurde ${ms.toFixed(0)} ms — ReDoS-plafond werkt niet`);
});

test('deny-terms redigeren eigennamen die geen patroon kan raden', async () => {
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'dash-'));
  const file = join(dir, 'deny.json');
  await writeFile(file, JSON.stringify({ terms: ['Acme Holding'] }));
  assert.equal(loadDenyTerms(file), 1);
  const { value, findings } = sanitizeString('migratie voor Acme Holding gepland');
  assert.equal(value.includes('Acme'), false);
  assert.ok(findings.some((f) => f.id === 'deny-term'));
  loadDenyTerms(join(dir, 'bestaat-niet.json'));
});

test('een ontbrekende of kapotte deny-lijst stopt de publieke bouw', async () => {
  // ROOD: `loadDenyTerms` slikte elke lees- of parsefout en zette de lijst op leeg. Eén ontbrekende
  // komma in de JSON en elke naam die geweerd moest worden stond weer op de openbare pagina
  // (review Codex, 26-07-2026). Een bewust lege lijst mag, maar alleen als geldige JSON.
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'dash-'));
  const kapot = join(dir, 'kapot.json');
  await writeFile(kapot, '{"terms":["Acme",]}');
  assert.throws(() => loadDenyTerms(kapot, { strict: true }), /DENY-LIJST onleesbaar/);
  assert.throws(() => loadDenyTerms(join(dir, 'weg.json'), { strict: true }), /DENY-LIJST onleesbaar/);

  const geenArray = join(dir, 'vorm.json');
  await writeFile(geenArray, '{"terms":"Acme"}');
  assert.throws(() => loadDenyTerms(geenArray, { strict: true }), /geen terms-array/);

  // Een term die niet in één scanvenster past, kan nooit gevonden worden en zet de vensterscan op
  // stap 1 — een bouw die praktisch stilstaat (review Gemini, 26-07-2026).
  const teLang = join(dir, 'lang.json');
  await writeFile(teLang, JSON.stringify({ terms: ['x'.repeat(400)] }));
  assert.throws(() => loadDenyTerms(teLang, { strict: true }), /langer dan 150 tekens/);

  const leeg = join(dir, 'leeg.json');
  await writeFile(leeg, '{"terms":[]}');
  assert.equal(loadDenyTerms(leeg, { strict: true }), 0, 'een bewust lege lijst blijft toegestaan');
});
