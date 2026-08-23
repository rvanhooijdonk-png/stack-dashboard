/**
 * ORGANISATIEMIGRATIE — de repository moet overdraagbaar BLIJVEN.
 *
 * Dit bestand meet twee dingen die makkelijk door elkaar lopen:
 *
 *  1. dat de AFLEIDING klopt voor beide eigenaars — de huidige persoonlijke en de organisatie
 *     waarnaar wordt overgedragen. Voor de huidige eigenaar geldt de zwaarste eis: er mag geen byte
 *     veranderen aan de adressen die vandaag in productie worden opgehaald;
 *  2. dat de POORT werkt — eerst op verzonnen bestanden, zodat de meter zelf gemeten is inclusief
 *     de defecten die hij hoort te vangen, en daarna op de werkelijke boom.
 *
 * De volgorde is niet toevallig: een poort die alleen op de echte boom groen is, bewijst hooguit
 * dat de boom vandaag schoon is, niet dat de poort morgen iets tegenhoudt.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseRepository, repositoryFromRemoteUrl, pagesOrigin, pagesUrl, rawUrl, repositorySlug,
  ownerUrlPrefix, resolveIdentity, detectIdentity,
} from '../scripts/lib/repo-identity.mjs';
import {
  HOSTING_OWNER_OF_RECORD, REPOSITORY_NAME, OPERATIONELE_PADEN, OVERTREDING, UITZONDERINGEN,
  UITZONDERINGEN_PAD, POORT_MODULE, verwachtPagesVoorvoegsel, toetsBestand, toetsBoom,
  gevolgdeBestanden, leesUitzonderingen,
} from '../scripts/lib/org-migration.mjs';
import { claimEvidence, evidenceUrlPrefixes } from '../scripts/lib/runtime-feed-view.mjs';

const NU = { owner: 'rvanhooijdonk-png', repo: 'stack-dashboard' };
const STRAKS = { owner: 'RVH-Speaking', repo: 'stack-dashboard' };

// --- 1. De afleiding, voor beide eigenaars ---------------------------------------------------

test('het Pages-adres van de HUIDIGE eigenaar blijft byte voor byte hetzelfde', () => {
  // Dit zijn letterlijk de adressen die vóór deze wijziging in waarnemer.yml, napublicatie.yml en
  // doorstroom.yml stonden. Wijkt hier iets af, dan is dit geen migratievoorbereiding meer maar een
  // productiewijziging.
  assert.equal(pagesUrl(NU), 'https://rvanhooijdonk-png.github.io/stack-dashboard/');
  assert.equal(pagesUrl(NU, 'contentstroom.html'), 'https://rvanhooijdonk-png.github.io/stack-dashboard/contentstroom.html');
  assert.equal(
    rawUrl(NU, 'main', 'data/kanaalpost-publiek.md'),
    'https://raw.githubusercontent.com/rvanhooijdonk-png/stack-dashboard/main/data/kanaalpost-publiek.md',
  );
  assert.equal(repositorySlug(NU), 'rvanhooijdonk-png/stack-dashboard');
});

test('de Pages-HOST wordt kleingeschreven, het pad en de API-adressen niet', () => {
  // De val bij deze migratie. `github.repository_owner` levert `RVH-Speaking`; een Pages-host met
  // hoofdletters is geen adres dat GitHub uitgeeft. Voor het huidige, al kleine account is dit een
  // no-op — precies daarom zou een naïeve substitutie hier groen blijven en pas ná de overdracht
  // stuklopen.
  assert.equal(pagesOrigin('RVH-Speaking'), 'https://rvh-speaking.github.io');
  assert.equal(pagesUrl(STRAKS), 'https://rvh-speaking.github.io/stack-dashboard/');
  assert.equal(pagesUrl(STRAKS, 'contentstroom.html'), 'https://rvh-speaking.github.io/stack-dashboard/contentstroom.html');
  // raw.githubusercontent en de REST-API zijn geen hostnamen met de eigenaar erin; daar blijft de
  // schrijfwijze staan zoals GitHub hem teruggeeft.
  assert.equal(
    rawUrl(STRAKS, 'main', 'data/kanaalpost-publiek.md'),
    'https://raw.githubusercontent.com/RVH-Speaking/stack-dashboard/main/data/kanaalpost-publiek.md',
  );
  assert.equal(repositorySlug(STRAKS), 'RVH-Speaking/stack-dashboard');
  assert.equal(ownerUrlPrefix('RVH-Speaking'), 'https://github.com/RVH-Speaking/');
});

test('een afsluitende slash bij de wortel en geen dubbele slash bij een pad', () => {
  assert.equal(pagesUrl(NU, ''), 'https://rvanhooijdonk-png.github.io/stack-dashboard/');
  assert.equal(pagesUrl(NU, '/status.json'), 'https://rvanhooijdonk-png.github.io/stack-dashboard/status.json');
  assert.equal(pagesUrl(NU, 'status.json'), 'https://rvanhooijdonk-png.github.io/stack-dashboard/status.json');
});

test('de identiteit komt uit de omgeving in een vaste volgorde: override, Actions, werkboom', () => {
  assert.deepEqual(resolveIdentity({ GITHUB_REPOSITORY: 'RVH-Speaking/stack-dashboard' }), STRAKS);
  assert.deepEqual(
    resolveIdentity({ DASHBOARD_REPOSITORY: 'iemand/fork', GITHUB_REPOSITORY: 'RVH-Speaking/stack-dashboard' }),
    { owner: 'iemand', repo: 'fork' },
  );
  assert.deepEqual(resolveIdentity({}, { remoteUrl: 'git@github.com:RVH-Speaking/stack-dashboard.git' }), STRAKS);
  assert.equal(resolveIdentity({}), null);
});

test('een remote wordt in alle vormen gelezen die deze werkboom draagt, en rommel wordt geweigerd', () => {
  for (const url of [
    'git@github.com:RVH-Speaking/stack-dashboard.git',
    'git@github.com:RVH-Speaking/stack-dashboard',
    'https://github.com/RVH-Speaking/stack-dashboard.git',
    'https://github.com/RVH-Speaking/stack-dashboard/',
    'ssh://git@github.com/RVH-Speaking/stack-dashboard.git',
  ]) assert.deepEqual(repositoryFromRemoteUrl(url), STRAKS, url);

  for (const rommel of [
    '', 'geen-url', 'git@gitlab.com:RVH-Speaking/stack-dashboard.git',
    'https://github.com/RVH-Speaking', 'https://github.com/a/b/c', null, 42,
    'https://github.com/RVH Speaking/stack-dashboard',
  ]) assert.equal(repositoryFromRemoteUrl(rommel), null, String(rommel));
});

test('een onvaststelbare identiteit werpt, en valt niet stilzwijgend terug op de oude eigenaar', () => {
  // De terugval is de hele reden dat dit werk bestaat: hij zou de overdracht groen laten doorlopen
  // terwijl er naar een verdwenen object wordt gekeken.
  assert.throws(
    () => detectIdentity({}, { cwd: '/' }),
    /kan de eigenaar van deze repository niet vaststellen/,
  );
});

test('een onzinnige eigenaar of repositorynaam levert een fout, geen adres', () => {
  assert.equal(parseRepository('a/b/c'), null);
  assert.equal(parseRepository('eigenaar met spatie/repo'), null);
  assert.throws(() => pagesOrigin('slecht/naam'), /ongeldige eigenaar/);
  assert.throws(() => pagesUrl({ owner: 'ok', repo: '../ontsnapping' }), /ongeldige repositorynaam/);
  assert.throws(() => rawUrl({ owner: 'ok', repo: 'x y' }, 'main', 'p'), /ongeldige repository/);
});

// --- 2. De renderprobe: hetzelfde bewijs onder beide eigenaars --------------------------------

const BEWIJS_OUD = { kind: 'COMMIT_SHA', ref: 'a1b2c3d', url: 'https://github.com/rvanhooijdonk-png/stack-dashboard/commit/a1b2c3d' };
const BEWIJS_NIEUW = { kind: 'COMMIT_SHA', ref: 'e5f6a7b', url: 'https://github.com/RVH-Speaking/stack-dashboard/commit/e5f6a7b' };

test('renderprobe HUIDIGE eigenaar: bestaand bewijs blijft klikbaar, nieuw bewijs nog niet', () => {
  const prefixes = evidenceUrlPrefixes({ GITHUB_REPOSITORY_OWNER: 'rvanhooijdonk-png' });
  assert.match(claimEvidence(BEWIJS_OUD, { prefixes }), /<a href="https:\/\/github\.com\/rvanhooijdonk-png\/stack-dashboard\/commit\/a1b2c3d"/);
  // Zolang de repository nog persoonlijk is, is een organisatie-URL geen bewezen bron: label, geen link.
  const straks = claimEvidence(BEWIJS_NIEUW, { prefixes });
  assert.match(straks, /claimbewijs: COMMIT_SHA:e5f6a7b/);
  assert.doesNotMatch(straks, /<a /);
});

test('renderprobe DOELEIGENAAR: nieuw bewijs wordt klikbaar en historisch bewijs blijft het', () => {
  const prefixes = evidenceUrlPrefixes({ GITHUB_REPOSITORY_OWNER: 'RVH-Speaking' });
  assert.match(claimEvidence(BEWIJS_NIEUW, { prefixes }), /<a href="https:\/\/github\.com\/RVH-Speaking\/stack-dashboard\/commit\/e5f6a7b"/);
  // Dit is de reden dat de historische eigenaar op de lijst blijft: het al gepubliceerde bewijs uit
  // de tijd vóór de overdracht mag zijn link niet verliezen.
  assert.match(claimEvidence(BEWIJS_OUD, { prefixes }), /<a href="https:\/\/github\.com\/rvanhooijdonk-png\/stack-dashboard\/commit\/a1b2c3d"/);
});

test('zonder Actions-context wordt de eigenaar niet geraden — alleen de historische bron linkt', () => {
  const prefixes = evidenceUrlPrefixes({});
  assert.deepEqual(prefixes, ['https://github.com/rvanhooijdonk-png/']);
  assert.doesNotMatch(claimEvidence(BEWIJS_NIEUW, { prefixes }), /<a /);
});

test('een vreemde eigenaar in de omgeving opent de bewijspoort niet voor een vreemde URL', () => {
  const prefixes = evidenceUrlPrefixes({ GITHUB_REPOSITORY_OWNER: 'RVH-Speaking' });
  for (const url of [
    'https://github.com/aanvaller/stack-dashboard/commit/a1b2c3d',
    'https://github.com.aanvaller.example/RVH-Speaking/x',
    'https://evil.example/github.com/RVH-Speaking/x',
    'javascript:alert(1)',
  ]) {
    const uit = claimEvidence({ kind: 'COMMIT_SHA', ref: 'a1b2c3d', url }, { prefixes });
    assert.doesNotMatch(uit, /<a /, url);
  }
  // Ook een ongeldige naam in de omgeving mag de lijst niet vervuilen.
  assert.deepEqual(evidenceUrlPrefixes({ GITHUB_REPOSITORY_OWNER: 'kwaad/pad' }), ['https://github.com/rvanhooijdonk-png/']);
});

// --- 3. De poort, eerst op verzonnen bestanden --------------------------------------------------

const schoon = [
  { pad: 'scripts/waarnemer.mjs', tekst: 'const BASE_URL = pagesUrl(detectIdentity());\n' },
  { pad: 'test/iets.test.mjs', tekst: "repository: 'rvanhooijdonk-png/stack-dashboard'\n" },
  { pad: 'docs/RAPPORT.md', tekst: 'gemeten op rvanhooijdonk-png/stack-dashboard\n' },
];
const geenUitzonderingen = { uitzonderingen: [] };

test('een schone boom levert geen enkele bevinding op', () => {
  assert.deepEqual(toetsBoom(schoon, geenUitzonderingen), []);
});

test('R1 — een NIEUWE operationele hardcodering van de oude eigenaar wordt geweigerd', () => {
  for (const pad of ['scripts/nieuw.mjs', 'scripts/lib/nieuw.mjs', 'tools/x/y.mjs', '.github/workflows/nieuw.yml']) {
    const b = toetsBestand({ pad, tekst: "const OWNER = 'rvanhooijdonk-png';\n" }, geenUitzonderingen);
    assert.equal(b.length, 1, pad);
    assert.equal(b[0].code, OVERTREDING.OPERATIONELE_EIGENAAR);
    assert.equal(b[0].regel, 1);
  }
});

test('R1 geldt NIET buiten de uitvoerende paden — daar is een repositorynaam gewoon invoer', () => {
  for (const pad of ['test/x.test.mjs', 'test/fixtures/y.json', 'docs/RAPPORT.md', 'CONTROL/AUTOCODING/README.md', 'contracts/z.schema.json']) {
    assert.deepEqual(toetsBestand({ pad, tekst: "'rvanhooijdonk-png/stack-dashboard'\n" }, geenUitzonderingen), [], pad);
  }
});

test('R1 — een gedekte uitzondering mag blijven, maar dekt geen tweede vermelding op dezelfde regel', () => {
  const uitzonderingen = [{
    pad: 'scripts/lib/collect.mjs', tekst: "?? 'rvanhooijdonk-png'", blijft: 'ANDER_OBJECT',
    reden: 'het bewaakte account, dat niet meeverhuist met deze repository',
  }];
  assert.deepEqual(
    toetsBestand({ pad: 'scripts/lib/collect.mjs', tekst: "const OWNER = env.DASHBOARD_OWNER ?? 'rvanhooijdonk-png';\n" }, { uitzonderingen }),
    [],
  );
  // Dezelfde regel, met er stiekem een tweede binding bij: dat is precies het gat dat een naïeve
  // "staat er een uitzondering voor dit bestand?"-toets zou laten liggen.
  const b = toetsBestand({
    pad: 'scripts/lib/collect.mjs',
    tekst: "const OWNER = env.DASHBOARD_OWNER ?? 'rvanhooijdonk-png'; const PLAAT = 'rvanhooijdonk-png';\n",
  }, { uitzonderingen });
  assert.equal(b.length, 1);
  assert.equal(b[0].code, OVERTREDING.OPERATIONELE_EIGENAAR);
});

test('R2 — een VEROUDERD Pages-adres wordt geweigerd in code, README en documentatie', () => {
  for (const pad of ['README.md', 'docs/X.md', 'CONTROL/AUTOCODING/README.md', 'scripts/x.mjs']) {
    const b = toetsBestand(
      { pad, tekst: 'zie https://oude-eigenaar.github.io/stack-dashboard/status.json\n' },
      { ...geenUitzonderingen, eigenaar: 'RVH-Speaking' },
    );
    assert.equal(b.length, 1, pad);
    assert.equal(b[0].code, OVERTREDING.VEROUDERD_PAGES_ADRES);
    assert.equal(b[0].verwacht, 'https://rvh-speaking.github.io/stack-dashboard');
  }
});

test('R2 geldt NIET in test/ — anders kan de poort haar eigen negatieve controle niet dragen', () => {
  // Dit bestand schrijft verouderde adressen letterlijk op om te bewijzen dat ze geweigerd worden.
  // Zonder deze afbakening zou de poort op haar eigen bewijsmateriaal afgaan.
  for (const pad of ['test/x.test.mjs', 'test/fixtures/y.json']) {
    assert.deepEqual(
      toetsBestand({ pad, tekst: 'https://oude-eigenaar.github.io/stack-dashboard/\n' },
        { ...geenUitzonderingen, eigenaar: 'RVH-Speaking' }),
      [], pad,
    );
  }
});

test('R2 — het adres van de HUIDIGE eigenaar is goed, ook met hoofdletters in de eigenaarsnaam', () => {
  assert.deepEqual(
    toetsBestand({ pad: 'README.md', tekst: 'https://rvh-speaking.github.io/stack-dashboard/\n' },
      { ...geenUitzonderingen, eigenaar: 'RVH-Speaking' }),
    [],
  );
  // En de spiegelbeeldige fout: de host met hoofdletters is de vorm die een naïeve
  // `${{ github.repository_owner }}`-substitutie oplevert. Hij werkt toevallig, en wordt juist
  // daarom geweigerd — anders zou die substitutie hier groen worden.
  const b = toetsBestand({ pad: 'README.md', tekst: 'https://RVH-Speaking.github.io/stack-dashboard/\n' },
    { ...geenUitzonderingen, eigenaar: 'RVH-Speaking' });
  assert.equal(b.length, 1);
  assert.equal(b[0].code, OVERTREDING.VEROUDERD_PAGES_ADRES);
});

test('R3 — een uitzondering die niets meer dekt, is zelf een bevinding', () => {
  const b = toetsBoom(schoon, {
    uitzonderingen: [{
      pad: 'scripts/verdwenen.mjs', tekst: "'rvanhooijdonk-png'", blijft: 'ANDER_OBJECT',
      reden: 'ooit geldig, maar het bestand bestaat niet meer in deze boom',
    }],
  });
  assert.equal(b.length, 1);
  assert.equal(b[0].code, OVERTREDING.VERVALLEN_UITZONDERING);
});

// --- 4. De poort op de werkelijke boom ---------------------------------------------------------

test('de werkelijke boom draagt geen ongedekte binding aan de huidige eigenaar', () => {
  const bevindingen = toetsBoom(gevolgdeBestanden());
  assert.deepEqual(
    bevindingen, [],
    bevindingen.map((b) => `${b.code} ${b.pad}:${b.regel ?? '-'} ${b.gevonden}`).join('\n'),
  );
});

test('de uitvoerende bestanden die het adres opbouwen, doen dat uitsluitend via de afleiding', () => {
  // De poort weigert de oude eigenaar; deze toets eist daarbovenop dat er ook echt een afleiding
  // voor in de plaats is gekomen. Zonder dit zou "de constante is weg" een geslaagde uitkomst zijn.
  for (const [pad, patroon] of [
    ['scripts/waarnemer.mjs', /pagesUrl\(IDENTITEIT, 'contentstroom\.html'\)/],
    ['scripts/waarnemer.mjs', /rawUrl\(IDENTITEIT, 'main', 'data\/kanaalpost-publiek\.md'\)/],
    ['scripts/napublicatie.mjs', /pagesUrl\(detectIdentity\(\)\)/],
    ['scripts/doorstroom.mjs', /pagesUrl\(detectIdentity\(\)\)/],
    ['scripts/kijk.mjs', /repositorySlug\(detectIdentity\(\)\)/],
  ]) assert.match(readFileSync(pad, 'utf8'), patroon, pad);
});

test('de workflows dragen geen eigen Pages- of raw-adres meer', () => {
  for (const pad of ['.github/workflows/waarnemer.yml', '.github/workflows/napublicatie.yml', '.github/workflows/doorstroom.yml']) {
    const tekst = readFileSync(pad, 'utf8');
    assert.doesNotMatch(tekst, /^\s+(BASE_URL|SPIEGEL_URL|DOORSTROOM_PLAAT_URL):\s*https?:\/\//m, pad);
  }
});

test('de uitzonderingenlijst staat onder de eigenaarsgate en is per post volledig', () => {
  assert.equal(UITZONDERINGEN_PAD, 'CONTROL/AUTOCODING/org-migratie-uitzonderingen.json');
  // `CONTROL/AUTOCODING/` is een `sensitive_path_prefix` in policy.v1.json: het verbreden van deze
  // poort valt daarmee onder dezelfde eigenaarsgate als de policy zelf.
  const policy = JSON.parse(readFileSync('CONTROL/AUTOCODING/policy.v1.json', 'utf8'));
  assert.ok(policy.owner_gate.sensitive_path_prefixes.includes('CONTROL/AUTOCODING/'));
  assert.ok(UITZONDERINGEN.length > 0);
  for (const u of UITZONDERINGEN) {
    assert.ok(['ANDER_OBJECT', 'HISTORISCH', 'CONFIGURATIEPUNT'].includes(u.blijft), u.pad);
    assert.ok(u.reden.trim().length >= 20, u.pad);
  }
});

test('een uitzondering zonder reden of met een onbekende categorie wordt niet geladen', () => {
  const goed = JSON.parse(readFileSync(UITZONDERINGEN_PAD, 'utf8'));
  for (const kapot of [
    { ...goed, schema: 'IETS_ANDERS' },
    { ...goed, uitzonderingen: [{ pad: 'scripts/x.mjs', tekst: 'x', blijft: 'ANDER_OBJECT' }] },
    { ...goed, uitzonderingen: [{ pad: 'scripts/x.mjs', tekst: 'x', blijft: 'OMDAT_HET_KAN', reden: 'een voldoende lange reden' }] },
    { ...goed, uitzonderingen: [{ pad: 'scripts/x.mjs', tekst: 'x', blijft: 'ANDER_OBJECT', reden: 'te kort' }] },
  ]) {
    const map = mkdtempSync(join(tmpdir(), 'orgmig-'));
    mkdirSync(join(map, 'CONTROL', 'AUTOCODING'), { recursive: true });
    writeFileSync(join(map, UITZONDERINGEN_PAD), JSON.stringify(kapot));
    assert.throws(() => leesUitzonderingen(map), /schema|uitzondering/);
  }
});

test('de poort zondert precies één pad van zichzelf uit, en dat pad draait nergens mee', () => {
  assert.equal(POORT_MODULE, 'scripts/lib/org-migration.mjs');
  assert.ok(OPERATIONELE_PADEN.some((p) => POORT_MODULE.startsWith(p)));
  // De declaratie mag niet in de publicatieketen terechtkomen: alleen de toets importeert haar.
  const importeurs = gevolgdeBestanden()
    .filter((b) => b.pad !== POORT_MODULE && b.tekst.includes('org-migration.mjs'))
    .map((b) => b.pad);
  assert.deepEqual(importeurs.filter((p) => p.startsWith('scripts/') || p.startsWith('tools/')), []);
});

test('de eigenaarsstand en het verwachte Pages-voorvoegsel horen bij elkaar', () => {
  assert.equal(REPOSITORY_NAME, 'stack-dashboard');
  assert.equal(verwachtPagesVoorvoegsel(), `https://${HOSTING_OWNER_OF_RECORD.toLowerCase()}.github.io/${REPOSITORY_NAME}`);
  assert.ok(readFileSync('README.md', 'utf8').includes(`${verwachtPagesVoorvoegsel()}/`));
});
