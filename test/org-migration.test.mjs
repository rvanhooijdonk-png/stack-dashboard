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
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseRepository, repositoryFromRemoteUrl, pagesOrigin, pagesUrl, rawUrl, repositorySlug,
  ownerUrlPrefix, resolveIdentity, detectIdentity, originRemoteUrl,
} from '../scripts/lib/repo-identity.mjs';
import {
  HOSTING_OWNER_OF_RECORD, REPOSITORY_NAME, OPERATIONELE_PADEN, OVERTREDING, UITZONDERINGEN,
  UITZONDERINGEN_PAD, POORT_MODULE, VORIGE_HOSTING_EIGENAARS, EIGENAARSKLASSE,
  verwachtPagesVoorvoegsel, toetsBestand, toetsBoom, gevolgdeBestanden, leesUitzonderingen,
  eigenaarsKandidaten,
} from '../scripts/lib/org-migration.mjs';
import { claimEvidence, evidenceUrlPrefixes } from '../scripts/lib/runtime-feed-view.mjs';

// Deze twee dragen de namen uit de tijd waarin sectie 1 is geschreven: `NU` is het persoonlijke
// account waar deze repository vandaan komt, `STRAKS` de organisatie waarnaar zij wordt
// overgedragen. Sectie 1 meet ZUIVERE ADRESOPBOUW voor twee genoemde eigenaars, en die metingen
// blijven waar aan beide kanten van de overdracht — daarom zijn ze hier niet hernoemd. Wat de
// DECLARATIE van vandaag is, staat in sectie 6, en dat bindt aan `HOSTING_OWNER_OF_RECORD` in
// plaats van aan een naam in een toets.
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

test('de identiteit komt uit de omgeving in een vaste volgorde: override vóór Actions-context', () => {
  assert.deepEqual(resolveIdentity({ GITHUB_REPOSITORY: 'RVH-Speaking/stack-dashboard' }), STRAKS);
  assert.deepEqual(
    resolveIdentity({ DASHBOARD_REPOSITORY: 'iemand/fork', GITHUB_REPOSITORY: 'RVH-Speaking/stack-dashboard' }),
    { owner: 'iemand', repo: 'fork' },
  );
  assert.equal(resolveIdentity({}), null);
  // LEEG telt als afwezig, en dat is geen slordigheid: een niet ingevulde `env:`-waarde komt in
  // Actions als lege tekst binnen. Zou dat een harde fout zijn, dan brak elke workflow die de
  // override netjes optioneel doorgeeft. Zie hieronder voor het verschil met MISVORMD.
  assert.equal(resolveIdentity({ DASHBOARD_REPOSITORY: '' }), null);
  assert.equal(resolveIdentity({ DASHBOARD_REPOSITORY: '   ' }), null);
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
  assert.throws(
    () => detectIdentity({}, { cwd: mkdtempSync(join(tmpdir(), 'orgmig-kaal-')) }),
    /kan de eigenaar van deze repository niet vaststellen/,
  );
});

// --- 1b. De vier reparaties, elk met de fout die zij afsluit ------------------------------------

/**
 * Een werkboom met precies één eigenschap: een `origin` die naar `slug` wijst. Geen netwerk, geen
 * commits — een overdracht raakt de opgeslagen remote van een bestaande kloon immers niet aan, en
 * juist die stand moet hier gemeten worden.
 */
function kloonMetOrigin(slug) {
  const map = mkdtempSync(join(tmpdir(), 'orgmig-kloon-'));
  execFileSync('git', ['-C', map, 'init', '-q'], { stdio: 'ignore' });
  execFileSync('git', ['-C', map, 'remote', 'add', 'origin', `git@github.com:${slug}.git`], { stdio: 'ignore' });
  return map;
}

test('P1 — een origin die de overdracht niet heeft meegemaakt, geldt niet als actuele identiteit', () => {
  // De stand van elke kloon die vóór de overdracht is gemaakt. GitHub verplaatst het object
  // server-side en blijft de oude naam doorverwijzen, dus git blijft werken en niets voelt kapot;
  // de opgeslagen remote noemt intussen nog letterlijk de vorige eigenaar. Syntactisch geldig, en
  // precies daarom gevaarlijk: hij zou hier het Pages- en raw-adres van een verdwenen host
  // opleveren zonder dat er ergens iets rood wordt.
  const verouderd = kloonMetOrigin('rvanhooijdonk-png/stack-dashboard');
  assert.equal(originRemoteUrl(verouderd), 'git@github.com:rvanhooijdonk-png/stack-dashboard.git');
  assert.throws(() => detectIdentity({}, { cwd: verouderd }), /origin/);
  assert.throws(() => detectIdentity({}, { cwd: verouderd }), /rvanhooijdonk-png\/stack-dashboard/);

  // De uitweg is uitdrukkelijk en nooit impliciet: een actuele runtimecontext of een override die
  // een mens nú heeft gezet.
  assert.deepEqual(detectIdentity({ GITHUB_REPOSITORY: 'RVH-Speaking/stack-dashboard' }, { cwd: verouderd }), STRAKS);
  assert.deepEqual(detectIdentity({ DASHBOARD_REPOSITORY: 'RVH-Speaking/stack-dashboard' }, { cwd: verouderd }), STRAKS);

  // Ook een origin die toevallig al goed staat, opent deze deur niet. Anders zou de toets
  // hierboven alleen maar meten dat de tekst verschilt, niet dat de bron niet telt.
  assert.throws(() => detectIdentity({}, { cwd: kloonMetOrigin('RVH-Speaking/stack-dashboard') }), /origin/);
});

test('P2 — een MISVORMDE expliciete override valt niet terug, maar faalt luid', () => {
  // Een tikfout in de override die voor een fork-proefdraai bedoeld was, mag niet stilzwijgend
  // tegen het gewone repository gaan draaien: dan lijkt de proef geslaagd terwijl er aan het
  // verkeerde object is gemeten — precies de stille misser die deze module opheft.
  for (const kapot of ['RVH-Speaking', 'RVH-Speaking/stack dashboard', 'a/b/c', '/stack-dashboard', 'RVH-Speaking/']) {
    assert.throws(
      () => resolveIdentity({ DASHBOARD_REPOSITORY: kapot, GITHUB_REPOSITORY: 'rvanhooijdonk-png/stack-dashboard' }),
      /DASHBOARD_REPOSITORY/,
      kapot,
    );
  }
  assert.throws(
    () => detectIdentity({ DASHBOARD_REPOSITORY: 'RVH-Speaking' }, { cwd: kloonMetOrigin('rvanhooijdonk-png/stack-dashboard') }),
    /DASHBOARD_REPOSITORY/,
  );
  // AFWEZIG is iets anders dan ONGELDIG: dat pad loopt gewoon door naar de Actions-context.
  assert.deepEqual(resolveIdentity({ GITHUB_REPOSITORY: 'RVH-Speaking/stack-dashboard' }), STRAKS);
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

test('P2 — één uitzondering dekt één voorkomen, ook als de hele toegestane tekst wordt herhaald', () => {
  const uitzonderingen = [{
    pad: 'scripts/lib/collect.mjs', tekst: "?? 'rvanhooijdonk-png'", blijft: 'ANDER_OBJECT',
    reden: 'het bewaakte account, dat niet meeverhuist met deze repository',
  }];
  const tweeKeer = {
    pad: 'scripts/lib/collect.mjs',
    tekst: "const A = env.DASHBOARD_OWNER ?? 'rvanhooijdonk-png'; const B = env.PLAAT ?? 'rvanhooijdonk-png';\n",
  };
  // Twee keer exact het toegestane fragment op één regel. De eerste is gedocumenteerd; de tweede is
  // een nieuwe binding waar niemand een reden bij heeft opgeschreven. Zou één post op de lijst álle
  // herhalingen dekken, dan is die post geen uitzondering meer maar een vrijbrief — en dan zegt de
  // toelichting bij de lijst iets anders dan de poort doet.
  const b = toetsBestand(tweeKeer, { uitzonderingen });
  assert.equal(b.length, 1);
  assert.equal(b[0].code, OVERTREDING.OPERATIONELE_EIGENAAR);

  // Wie twee voorkomens wil, documenteert er twee. Dan is de lijst weer een eerlijke telling.
  assert.deepEqual(toetsBestand(tweeKeer, { uitzonderingen: [...uitzonderingen, { ...uitzonderingen[0] }] }), []);

  // Hetzelfde budget geldt over regelgrenzen heen: één post dekt één voorkomen in het bestand, niet
  // één per regel. Anders verplaatst het gat zich gewoon naar de volgende regel.
  const tweeRegels = toetsBestand({
    pad: 'scripts/lib/collect.mjs',
    tekst: "const A = env.DASHBOARD_OWNER ?? 'rvanhooijdonk-png';\nconst B = env.PLAAT ?? 'rvanhooijdonk-png';\n",
  }, { uitzonderingen });
  assert.equal(tweeRegels.length, 1);
  assert.equal(tweeRegels[0].regel, 2);
});

test('P2 — een uitzondering die vaker is opgevoerd dan zij dekt, is een VERVALLEN post', () => {
  // De telling loopt beide kanten op: twee posten voor één voorkomen laat één post zonder werk
  // achter, en zo'n post is precies wat R3 hoort aan te wijzen.
  const post = {
    pad: 'scripts/lib/collect.mjs', tekst: "?? 'rvanhooijdonk-png'", blijft: 'ANDER_OBJECT',
    reden: 'het bewaakte account, dat niet meeverhuist met deze repository',
  };
  const b = toetsBoom(
    [{ pad: 'scripts/lib/collect.mjs', tekst: "const A = env.DASHBOARD_OWNER ?? 'rvanhooijdonk-png';\n" }],
    { uitzonderingen: [post, { ...post }] },
  );
  assert.equal(b.length, 1);
  assert.equal(b[0].code, OVERTREDING.VERVALLEN_UITZONDERING);
});

test('P2 — de operationele eigenaar wordt in ELKE schrijfwijze herkend', () => {
  // Na de overdracht is `RVH-Speaking` de eigenaar. GitHub aanvaardt `rvh-speaking` net zo goed in
  // raw- en API-adressen, dus een nieuwe hardcodering wordt eerder in kleine letters getypt dan in
  // de officiële schrijfwijze. Hoofdlettergevoelig toetsen laat juist die vorm door — en dan is de
  // poort na de migratie stil op de meest waarschijnlijke fout.
  for (const geschreven of ['RVH-Speaking', 'rvh-speaking', 'RVH-SPEAKING', 'Rvh-Speaking']) {
    const b = toetsBestand(
      {
        pad: 'scripts/nieuw.mjs',
        tekst: `const RAW = 'https://raw.githubusercontent.com/${geschreven}/stack-dashboard/main/x.json';\n`,
      },
      { ...geenUitzonderingen, eigenaar: 'RVH-Speaking' },
    );
    assert.equal(b.length, 1, geschreven);
    assert.equal(b[0].code, OVERTREDING.OPERATIONELE_EIGENAAR);
    // De bevinding noemt de gevonden schrijfwijze, niet de officiële: anders moet wie hem leest
    // zelf nog gaan zoeken waar het dan staat.
    assert.equal(b[0].gevonden, geschreven, geschreven);
  }

  // De scheiding tussen de drie eigenaars blijft overeind. Een persoonslogin en het bewaakte
  // account staan buiten de uitvoerende paden, en die grens verandert hier niet mee.
  for (const pad of ['CONTROL/AUTOCODING/policy.v1.json', 'docs/RAPPORT.md', 'test/x.test.mjs']) {
    assert.deepEqual(
      toetsBestand({ pad, tekst: '"allowed_owner_actors": ["rvh-speaking"]\n' },
        { ...geenUitzonderingen, eigenaar: 'RVH-Speaking' }),
      [], pad,
    );
  }
  // En een gedocumenteerde uitzondering blijft gedocumenteerd, ongeacht de schrijfwijze eromheen.
  assert.deepEqual(
    toetsBestand({ pad: 'scripts/lib/collect.mjs', tekst: "const OWNER = env.DASHBOARD_OWNER ?? 'rvh-speaking';\n" }, {
      eigenaar: 'RVH-Speaking',
      uitzonderingen: [{
        pad: 'scripts/lib/collect.mjs', tekst: "?? 'rvh-speaking'", blijft: 'ANDER_OBJECT',
        reden: 'het bewaakte account, dat niet meeverhuist met deze repository',
      }],
    }),
    [],
  );
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
    // `identiteit()` en niet `IDENTITEIT`: de afleiding is lui, zodat een run die BEIDE adressen zelf
    // meegeeft niets meer over deze repository hoeft vast te stellen. Zie
    // `test/waarnemer-adressen.test.mjs` voor wat er dan wél en niet wordt afgeleid.
    ['scripts/waarnemer.mjs', /pagesUrl\(identiteit\(\), 'contentstroom\.html'\)/],
    ['scripts/waarnemer.mjs', /rawUrl\(identiteit\(\), 'main', 'data\/kanaalpost-publiek\.md'\)/],
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

// --- 5. De tweede Codex-ronde: launchd, de generatorparser en overlappende uitzonderingen -------

/**
 * De EnvironmentVariables uit een launchd-plist, gelezen uit het bestand dat werkelijk wordt
 * verscheept. Bewust geen plist-bibliotheek en bewust geen `plutil`: die laatste bestaat alleen op
 * macOS en de toets moet ook op de ubuntu-runner meten. Dat maakt dit een kleine lezer, en een
 * kleine lezer kan zelf fout zijn — daarom controleert de toets hieronder hem tegen `plutil` zodra
 * die voorhanden is, en meet hij nooit iets anders dan de bytes die in de repository staan.
 */
function plistOmgeving(pad) {
  const xml = readFileSync(pad, 'utf8');
  const blok = xml.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  if (!blok) return null;
  // Commentaar eerst weg: een uitleg die een `<key>` noemt is geen sleutel.
  const zonderCommentaar = blok[1].replace(/<!--[\s\S]*?-->/g, '');
  const env = {};
  for (const m of zonderCommentaar.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) {
    env[m[1]] = m[2];
  }
  return env;
}

const PLIST = 'tools/dashboard-feed-generator/com.rvh.dashboard-feed-generator.plist';

test('C1 — het verscheepte launchd-plist draagt zelf een ACTUELE dashboardidentiteit', () => {
  // De bevinding die dit afsluit: het plist gaf noch DASHBOARD_REPOSITORY noch GITHUB_REPOSITORY
  // mee, en launchd zet die laatste niet uit zichzelf — dat is een Actions-variabele. Elke
  // geplande run nam daarmee het lege pad, liet alle PR-events van het dashboard weg, en
  // publiceerde die onvolledige feed alsof er niets aan de hand was. Stil, elk kwartier opnieuw.
  const env = plistOmgeving(PLIST);
  assert.ok(env, 'het plist draagt een EnvironmentVariables-blok');
  assert.ok(
    'DASHBOARD_REPOSITORY' in env || 'GITHUB_REPOSITORY' in env,
    'het plist levert zelf een identiteit; launchd geeft er geen',
  );
  // En de identiteit die eruit komt is de HUIDIGE, niet zomaar een geldige tekst. Dit is de draad
  // naar de ene declaratie: verzet iemand HOSTING_OWNER_OF_RECORD bij de overdracht en laat hij
  // dit plist staan, dan wordt deze toets rood in plaats van dat er een kwartaal lang naar een
  // verhuisd object wordt gekeken.
  assert.deepEqual(
    resolveIdentity(env),
    { owner: HOSTING_OWNER_OF_RECORD, repo: REPOSITORY_NAME },
  );
});

test('C1 — de plist-lezer van deze toets komt overeen met de echte plist-parser van het systeem', (t) => {
  // Zonder deze controle meet de toets hierboven misschien alleen haar eigen regex. `plutil` is de
  // parser die macOS zelf gebruikt; waar hij bestaat, moet hij hetzelfde zeggen.
  let uit;
  try {
    uit = execFileSync('plutil', ['-extract', 'EnvironmentVariables', 'json', '-o', '-', PLIST], { encoding: 'utf8' });
  } catch {
    t.skip('plutil niet beschikbaar (geen macOS) — de draagbare lezer blijft ongecontroleerd');
    return;
  }
  assert.deepEqual(JSON.parse(uit), plistOmgeving(PLIST));
});

test('C1 — negatieve controle: zonder die sleutel valt de dashboardbron stil weg', () => {
  // Precies de stand van vóór deze reparatie: HOME en PATH, verder niets. Geen fout, geen alarm —
  // alleen een feed zonder dashboardevents. Dat is waarom de sleutel in het plist hoort en niet in
  // een niet-genoemde handmatige omgevingsstap.
  const zonder = { HOME: '/Users/iemand', PATH: '/usr/bin:/bin' };
  assert.equal(resolveIdentity(zonder), null);
});

// De generator is een REVIEWKOPIE van het exemplaar dat onder launchd draait; hij haalt zijn
// validators en nu ook zijn identiteitsafleiding uit de dashboardboom. Voor deze toets wijst die
// wortel naar deze repository. Zetten vóór de import: de generator leest hem op moduleniveau.
process.env.DASHBOARD_FEED_GENERATOR_DASHBOARD_ROOT = process.cwd();
const generator = await import('../tools/dashboard-feed-generator/generator.mjs');

test('C2 — de generator kent AFWEZIG, LEEG en MISVORMD elk hun eigen afloop', async () => {
  const GELDIG = 'RVH-Speaking/stack-dashboard';

  // MISVORMD en niet-leeg: een tikfout in een uitdrukkelijke aanwijzing. Vóór deze reparatie gaf de
  // eigen parser van de generator hier `null` terug — niet te onderscheiden van "niets ingevuld" —
  // en publiceerde hij daarna doodleuk een feed zonder dashboardevents. Nu werpt het, en dat komt
  // als een luide FOUT uit main(): geen halve meting die achteraf als een geldige leest.
  for (const kapot of ['RVH-Speaking', 'RVH-Speaking/stack dashboard', 'a/b/c', '/stack-dashboard']) {
    await assert.rejects(
      () => generator.dashboardRepositorySlug({ DASHBOARD_REPOSITORY: kapot, GITHUB_REPOSITORY: GELDIG }),
      /DASHBOARD_REPOSITORY/,
      kapot,
    );
  }

  // LEEG en ALLEEN SPATIES: de vorm waarin Actions een niet-ingevulde `env:`-waarde doorgeeft. Dat
  // is geen fout maar "niet gezet", en dan telt de Actions-context. De oude `??`-keten liet die
  // terugval juist NIET toe, want leeg is niet `null`; de gedocumenteerde terugval bestond dus niet.
  assert.equal(await generator.dashboardRepositorySlug({ DASHBOARD_REPOSITORY: '', GITHUB_REPOSITORY: GELDIG }), GELDIG);
  assert.equal(await generator.dashboardRepositorySlug({ DASHBOARD_REPOSITORY: '   ', GITHUB_REPOSITORY: GELDIG }), GELDIG);

  // AFWEZIG: hetzelfde pad.
  assert.equal(await generator.dashboardRepositorySlug({ GITHUB_REPOSITORY: GELDIG }), GELDIG);

  // De override wint van de context, en helemaal niets levert eerlijk niets op — dan slaat de bron
  // over mét reden in het log, in plaats van tegen een geraden object te meten.
  assert.equal(await generator.dashboardRepositorySlug({ DASHBOARD_REPOSITORY: GELDIG, GITHUB_REPOSITORY: 'iemand/anders' }), GELDIG);
  assert.equal(await generator.dashboardRepositorySlug({}), null);
});

test('C2 — de generator draagt geen eigen tweede parser meer', () => {
  const bron = readFileSync('tools/dashboard-feed-generator/generator.mjs', 'utf8');
  assert.match(bron, /repo-identity\.mjs/);
  assert.match(bron, /resolveIdentity\(env\)/);
  // De vorige eigen ontleding — een losse regex op `owner/repo` — mag niet terugkomen. Twee
  // parsers voor één begrip is precies hoe AFWEZIG en MISVORMD weer uit elkaar gaan lopen.
  assert.doesNotMatch(bron, /A-Za-z0-9\._-\]\{1,100\}\\\//);
  assert.doesNotMatch(bron, /process\.env\.DASHBOARD_REPOSITORY \?\? process\.env\.GITHUB_REPOSITORY/);
});

test('C2 — het plist en de generator sluiten op elkaar aan: de sleutel dekt de bron', async () => {
  // De hele route in één keer, over de werkelijk verscheepte bestanden: wat het plist meegeeft,
  // moet de generator ook echt tot een repository maken. Vóór de reparatie liep deze keten dood op
  // een plist zonder identiteit; er wordt hier niets geladen, geïnstalleerd of gedraaid.
  const env = plistOmgeving(PLIST);
  assert.equal(
    await generator.dashboardRepositorySlug(env),
    `${HOSTING_OWNER_OF_RECORD}/${REPOSITORY_NAME}`,
  );
  assert.equal(await generator.dashboardRepositorySlug({ HOME: env.HOME, PATH: env.PATH }), null);
});

test('C2 — de generator draait nog steeds wél als launchd hem rechtstreeks aanroept', () => {
  // De uitvoerpoort die het meten hierboven mogelijk maakt, mag de productieroute niet uitzetten.
  // launchd roept `node <pad>` aan, dus `argv[1]` is het scriptpad zelf.
  const bewaard = process.argv[1];
  try {
    process.argv[1] = 'tools/dashboard-feed-generator/generator.mjs';
    assert.equal(generator.rechtstreeksAangeroepen(), true);
    process.argv[1] = 'test/org-migration.test.mjs';
    assert.equal(generator.rechtstreeksAangeroepen(), false);
  } finally {
    process.argv[1] = bewaard;
  }
});

test('C3 — een korte uitzondering die binnen een lange valt, vervalt en dekt niets nieuws', () => {
  // De exacte Codex-reproductie. Twee posten voor één pad, waarvan de korte tekst letterlijk in de
  // lange zit — de vorm die in deze lijst gewoon voorkomt: een toelichtingszin die het codefragment
  // citeert. `zonderGedekt` schrijft de lange post eerst af, dus de korte doet dan niets.
  const LANG = "allowed rvanhooijdonk-png text";
  const KORT = 'rvanhooijdonk-png';
  const post = (tekst) => ({
    pad: 'scripts/x.mjs', tekst, blijft: 'ANDER_OBJECT',
    reden: 'verzonnen post, uitsluitend om het gedrag van R3 te meten',
  });
  const beide = [post(LANG), post(KORT)];
  const alleenLang = [{ pad: 'scripts/x.mjs', tekst: `const A = '${LANG}';\n` }];

  // VÓÓR de reparatie was dit leeg: R3 vond `rvanhooijdonk-png` terug als substring binnen de al
  // opgegeten lange zin en verklaarde de korte post voor levend. Zij was dan onzichtbaar ongebruikt
  // budget — de kern van de bevinding.
  const vervallen = toetsBoom(alleenLang, { uitzonderingen: beide });
  assert.equal(vervallen.length, 1);
  assert.equal(vervallen[0].code, OVERTREDING.VERVALLEN_UITZONDERING);
  assert.equal(vervallen[0].gevonden, KORT);

  // En dat is precies wat een verborgen budget mogelijk maakte: wie er daarna een losse
  // eigenaarsnaam bij zette, kreeg die stilzwijgend gedekt. Nu kán die stand niet meer ongemerkt
  // bestaan — de poort staat al rood op de lijst zelf. Haalt iemand de vervallen post weg, zoals R3
  // eist, dan blijft de nieuwe binding over als een gewone R1-overtreding.
  const langPlusLos = [{ pad: 'scripts/x.mjs', tekst: `const A = '${LANG}';\nconst OWNER = '${KORT}';\n` }];
  const naOpruimen = toetsBoom(langPlusLos, { uitzonderingen: [post(LANG)] });
  assert.equal(naOpruimen.length, 1);
  assert.equal(naOpruimen[0].code, OVERTREDING.OPERATIONELE_EIGENAAR);
  assert.equal(naOpruimen[0].regel, 2);

  // Laat iemand de korte post juist staan en zet hij er een losse binding bij, dan is de lijst weer
  // een eerlijke telling: twee posten, twee voorkomens, allebei gedekt en allebei aan het werk. Dat
  // is de enige stand waarin die tweede naam mag blijven staan, en hij is nu zichtbaar geworden in
  // plaats van meegelift.
  assert.deepEqual(toetsBoom(langPlusLos, { uitzonderingen: beide }), []);
});

test('C3 — R3 meet verbruik, niet aanwezigheid: dekking op een niet-uitvoerend pad telt gewoon mee', () => {
  // Een post op een pad waar R1 niet geldt, doet nog steeds werk zodra haar tekst er staat; dat is
  // geen R1-bevinding, maar de post is ook niet vervallen. Zonder dit onderscheid zou de nieuwe
  // telling elke post buiten `scripts/`, `tools/` en de workflows ten onrechte doodverklaren.
  const post = {
    pad: 'docs/RAPPORT.md', tekst: 'rvanhooijdonk-png', blijft: 'HISTORISCH',
    reden: 'verzonnen post, uitsluitend om het gedrag van R3 te meten',
  };
  assert.deepEqual(toetsBoom([{ pad: 'docs/RAPPORT.md', tekst: 'gemeten op rvanhooijdonk-png\n' }], { uitzonderingen: [post] }), []);
  const weg = toetsBoom([{ pad: 'docs/RAPPORT.md', tekst: 'geen naam meer\n' }], { uitzonderingen: [post] });
  assert.equal(weg.length, 1);
  assert.equal(weg[0].code, OVERTREDING.VERVALLEN_UITZONDERING);
});

// --- 6. De overdracht zelf: de drie plaatsen die als één geheel omslaan -------------------------

/**
 * Sectie 1 tot en met 5 meten dat deze repository OVERDRAAGBAAR is. Deze sectie meet de
 * overdracht: de stand die zegt waar het dashboard staat, en de plaatsen die daar onlosmakelijk aan
 * vastzitten.
 *
 * Waarom dat een eigen sectie is en geen extra regel bij C1: de drie carriers falen elk op hun
 * eigen manier als er één achterblijft, en die manieren zijn niet inwisselbaar. Een achtergebleven
 * README-adres is zichtbaar verkeerd; een achtergebleven `HOSTING_OWNER_OF_RECORD` maakt de poort
 * blind voor precies de fout die dan telt; een achtergebleven plist laat de feedgenerator elk
 * kwartier stil een onvolledige feed publiceren. Alleen als alle drie tegen dezelfde declaratie
 * worden gehouden, is "vergeten" onmogelijk in plaats van onwaarschijnlijk.
 */

const VORIGE = VORIGE_HOSTING_EIGENAARS[0];

// Het mappad dat de negatieve controle van C4 aanmaakt, zodat de toets erna kan meten dat het
// werkelijk is opgeruimd. Een opgeruimde map bewijst zichzelf niet; hij moet bij naam worden gemist.
let C4_NEGATIEVE_CONTROLE_MAP = null;

test('C4 — de eigenaarsstand, het Pages-adres en het launchd-plist slaan als één geheel om', () => {
  // De declaratie zelf, één keer letterlijk. Dit is de enige plaats in deze toetsen waar de naam
  // van de doelorganisatie als verwachting wordt opgeschreven; al het andere hangt eraan.
  assert.equal(HOSTING_OWNER_OF_RECORD, STRAKS.owner);
  assert.equal(REPOSITORY_NAME, STRAKS.repo);
  assert.deepEqual([...VORIGE_HOSTING_EIGENAARS], [NU.owner]);

  // Carrier 1 — het Pages-adres dat bij vaste tekst hoort, met de host in kleine letters.
  assert.equal(verwachtPagesVoorvoegsel(), 'https://rvh-speaking.github.io/stack-dashboard');
  const readme = readFileSync('README.md', 'utf8');
  assert.ok(readme.includes(`${verwachtPagesVoorvoegsel()}/`), 'README noemt het actuele Pages-adres');
  // Carrier 2 — en niet meer dat van de vorige eigenaar. Zonder deze kant zou de toets hierboven ook
  // groen zijn met beide adressen in de README, en dan wijst de helft van de lezers nog verkeerd.
  assert.ok(
    !readme.includes(verwachtPagesVoorvoegsel(VORIGE)),
    'de README draagt het Pages-adres van de vorige eigenaar niet meer',
  );

  // Carrier 3 — het plist, gelezen uit de bytes die werkelijk worden verscheept.
  const env = plistOmgeving(PLIST);
  assert.deepEqual(resolveIdentity(env), { owner: HOSTING_OWNER_OF_RECORD, repo: REPOSITORY_NAME });

  // NEGATIEVE CONTROLE op dezelfde meting: hetzelfde plist met de oude waarde erin moet hier
  // omvallen. Anders meet C1 hierboven alleen dat er íéts geldigs staat.
  const map = mkdtempSync(join(tmpdir(), 'orgmig-plist-'));
  C4_NEGATIEVE_CONTROLE_MAP = map;
  try {
    const achtergebleven = join(map, 'oud.plist');
    writeFileSync(achtergebleven, readFileSync(PLIST, 'utf8')
      .replace(`<string>${HOSTING_OWNER_OF_RECORD}/${REPOSITORY_NAME}</string>`, `<string>${VORIGE}/${REPOSITORY_NAME}</string>`));
    assert.notDeepEqual(
      resolveIdentity(plistOmgeving(achtergebleven)),
      { owner: HOSTING_OWNER_OF_RECORD, repo: REPOSITORY_NAME },
    );
    assert.deepEqual(resolveIdentity(plistOmgeving(achtergebleven)), { owner: VORIGE, repo: REPOSITORY_NAME });
  } finally {
    // Opruimen hoort in `finally`, niet achter de laatste assertie: juist de run waarin een
    // assertie omvalt is de run die zich herhaalt, en dan groeit /tmp mee met het aantal pogingen.
    rmSync(map, { recursive: true, force: true });
  }
});

test('C4 — de negatieve controle hierboven laat geen tijdelijke map achter', () => {
  // Kant 1: de map die de toets werkelijk heeft gemaakt, is er niet meer. Deze toets draait ná
  // C4 in hetzelfde bestand, dus dit meet de echte uitvoering en niet een nagespeelde vorm.
  assert.ok(C4_NEGATIEVE_CONTROLE_MAP, 'de negatieve controle heeft een tijdelijke map gemaakt');
  assert.equal(existsSync(C4_NEGATIEVE_CONTROLE_MAP), false, C4_NEGATIEVE_CONTROLE_MAP);

  // Kant 2: en het opruimen hangt niet aan het slagen van de asserties. Zonder `finally` zou deze
  // binding groen blijven zolang alles toevallig goed gaat — precies dan valt het lek niet op.
  const SLEUTEL = "mkdtempSync(join(tmpdir(), 'orgmig-plist-'))";
  const bron = readFileSync('test/org-migration.test.mjs', 'utf8');
  // `[1]` is het stuk na het EERSTE voorkomen: de toets hierboven. Het tweede voorkomen is deze
  // regel zelf, en dat stuk wordt hier bewust niet gemeten.
  const toets = bron.split(SLEUTEL)[1].split('\n});')[0];
  const opruiming = toets.split('} finally {');
  assert.equal(opruiming.length, 2, 'de negatieve controle ruimt op in een finally-blok');
  assert.match(opruiming[1], /rmSync\(map, \{ recursive: true, force: true \}\)/);
  // En de asserties staan erbóven, in de try: alleen dan loopt het opruimen ook als er één omvalt.
  assert.match(opruiming[0], /assert\.deepEqual\(resolveIdentity\(plistOmgeving\(achtergebleven\)\)/);
});

test('C4 — één vergeten operationele binding aan de VORIGE eigenaar wordt fail-closed rood', () => {
  // Dit is het gat dat op het moment van de overdracht opengaat. R1 kende alleen de eigenaar van
  // vandaag; op de dag dat die eigenaar verandert, zou elke verwijzing die is blijven staan in één
  // klap buiten de poort vallen — precies wanneer die verwijzingen het gevaarlijkst zijn, want
  // GitHub blijft de oude naam doorverwijzen en niets voelt kapot.
  for (const pad of ['scripts/nieuw.mjs', 'scripts/lib/nieuw.mjs', 'tools/x/y.mjs', '.github/workflows/nieuw.yml']) {
    for (const geschreven of [VORIGE, VORIGE.toUpperCase(), 'Rvanhooijdonk-PNG']) {
      const b = toetsBestand({ pad, tekst: `const OWNER = '${geschreven}';\n` }, geenUitzonderingen);
      assert.equal(b.length, 1, `${pad} ${geschreven}`);
      assert.equal(b[0].code, OVERTREDING.OPERATIONELE_EIGENAAR);
      assert.equal(b[0].gevonden, geschreven);
      // De remedie verschilt per klasse, dus de bevinding zegt zelf welke het is.
      assert.equal(b[0].eigenaarsklasse, EIGENAARSKLASSE.ACHTERGEBLEVEN, `${pad} ${geschreven}`);
    }
  }

  // De huidige eigenaar blijft even hard geweigerd, en wordt anders geëtiketteerd: daar is niets
  // vergeten, daar hoort een afleiding te staan.
  const nu = toetsBestand({ pad: 'scripts/nieuw.mjs', tekst: `const OWNER = '${HOSTING_OWNER_OF_RECORD}';\n` }, geenUitzonderingen);
  assert.equal(nu.length, 1);
  assert.equal(nu[0].eigenaarsklasse, EIGENAARSKLASSE.HUIDIG);

  // En de grens verschuift niet mee: buiten de uitvoerende paden is de oude naam gewoon invoer,
  // verslag of persoonslogin. Zou dit meeverhuizen, dan haalt de poort de drie eigenaars door
  // elkaar die deze hele migratie juist uit elkaar houdt.
  for (const pad of ['test/x.test.mjs', 'docs/RAPPORT.md', 'CONTROL/AUTOCODING/policy.v1.json', 'contracts/z.schema.json']) {
    assert.deepEqual(toetsBestand({ pad, tekst: `"allowed_owner_actors": ["${VORIGE}"]\n` }, geenUitzonderingen), [], pad);
  }
});

test('C4 — het Pages-adres van de vorige eigenaar wordt geweigerd in code, README en documentatie', () => {
  // Hetzelfde gat als hierboven, maar dan voor R2 en met de werkelijke vorige eigenaar in plaats
  // van een verzonnen naam: na de overdracht levert dit adres een HTTP-fout op, en die fout leest
  // de waarnemer als "de plaat is niet vers" — niet als "het adres is verhuisd".
  for (const pad of ['README.md', 'docs/X.md', 'CONTROL/AUTOCODING/README.md', 'scripts/x.mjs']) {
    const b = toetsBestand({ pad, tekst: `zie ${verwachtPagesVoorvoegsel(VORIGE)}/status.json\n` }, geenUitzonderingen)
      .filter((x) => x.code === OVERTREDING.VEROUDERD_PAGES_ADRES);
    assert.equal(b.length, 1, pad);
    assert.equal(b[0].verwacht, verwachtPagesVoorvoegsel(), pad);
  }
});

test('C4 — simulatie: met GITHUB_REPOSITORY op de organisatie leidt de keten exact de verwachte adressen af', () => {
  // De twee lagen komen langs verschillende wegen tot een adres: de poort houdt VASTE TEKST tegen
  // `HOSTING_OWNER_OF_RECORD`, de publicatieketen LEIDT AF uit de runtime. Ze mogen nooit uit
  // elkaar lopen, en dat is hier meetbaar in plaats van aangenomen.
  const slug = `${HOSTING_OWNER_OF_RECORD}/${REPOSITORY_NAME}`;
  const uitActions = detectIdentity({ GITHUB_REPOSITORY: slug }, { cwd: '/' });
  assert.deepEqual(uitActions, { owner: HOSTING_OWNER_OF_RECORD, repo: REPOSITORY_NAME });
  assert.equal(pagesUrl(uitActions), `${verwachtPagesVoorvoegsel()}/`);
  assert.equal(pagesUrl(uitActions, 'contentstroom.html'), `${verwachtPagesVoorvoegsel()}/contentstroom.html`);
  // raw en de REST-API zijn geen hostnamen: daar blijft de schrijfwijze van de organisatie staan.
  assert.equal(
    rawUrl(uitActions, 'main', 'data/kanaalpost-publiek.md'),
    `https://raw.githubusercontent.com/${HOSTING_OWNER_OF_RECORD}/${REPOSITORY_NAME}/main/data/kanaalpost-publiek.md`,
  );
  assert.equal(repositorySlug(uitActions), slug);

  // En launchd komt langs de derde weg — de sleutel uit het verscheepte plist — op exact hetzelfde
  // object uit. Drie wegen, één plaats; dat is wat "als één geheel omslaan" hier betekent.
  assert.deepEqual(resolveIdentity(plistOmgeving(PLIST)), uitActions);
});

test('C4 — wat NIET meeverhuist blijft aantoonbaar staan', () => {
  // De keerzijde van de vorige toetsen. Een migratie die te ver doorslaat is net zo stuk als een
  // die blijft steken: het bewaakte account, `stack-control` en de persoonslogin horen bij ANDERE
  // objecten, en die zijn niet overgedragen.
  assert.match(readFileSync('scripts/lib/collect.mjs', 'utf8'), new RegExp(`DASHBOARD_OWNER \\?\\? '${VORIGE}'`));
  assert.match(readFileSync('tools/dashboard-feed-generator/generator.mjs', 'utf8'), new RegExp(`CONTROL_OWNER = '${VORIGE}'`));
  const policy = JSON.parse(readFileSync('CONTROL/AUTOCODING/policy.v1.json', 'utf8'));
  assert.ok(policy.owner_gate.allowed_owner_actors.includes(VORIGE), 'de persoonslogin verhuist niet mee');

  // Historisch bewijs blijft klikbaar. Dit is de reden dat de vorige eigenaar op de bewijslijst
  // staat: al gepubliceerde commit-URL's wijzen naar het persoonlijke account en die links zouden
  // anders bij de overdracht doodvallen.
  const prefixes = evidenceUrlPrefixes({ GITHUB_REPOSITORY_OWNER: HOSTING_OWNER_OF_RECORD });
  assert.deepEqual(prefixes, [`https://github.com/${VORIGE}/`, `https://github.com/${HOSTING_OWNER_OF_RECORD}/`]);
  assert.match(claimEvidence(BEWIJS_OUD, { prefixes }), /<a href="https:\/\/github\.com\/rvanhooijdonk-png\//);
  assert.match(claimEvidence(BEWIJS_NIEUW, { prefixes }), /<a href="https:\/\/github\.com\/RVH-Speaking\//);
});

test('C4 — de identiteit staat op precies één operationele plaats, en de lokale afbeelding wijst ernaar', () => {
  // Een tweede plaats met dezelfde waarde is geen extra zekerheid maar een tweede plaats om te
  // vergeten. Deze toets houdt dat aantal op één: het plist, dat launchd nodig heeft omdat daar
  // geen Actions-context is. Alles wat draait, leidt af.
  const dragers = gevolgdeBestanden()
    .filter((b) => OPERATIONELE_PADEN.some((p) => b.pad.startsWith(p)))
    .filter((b) => b.tekst.includes(`${HOSTING_OWNER_OF_RECORD}/${REPOSITORY_NAME}`))
    .map((b) => b.pad);
  assert.deepEqual(dragers, [PLIST]);

  // De kopie die onder launchd draait staat buiten git; een merge raakt haar niet aan. Dat is geen
  // detail maar het verschil tussen "de overdracht is doorgevoerd" en "de overdracht is doorgevoerd
  // behalve op de machine die elk kwartier publiceert". De afbeelding hoort dus vast te liggen
  // vóórdat iemand hem nodig heeft.
  const gids = readFileSync('docs/ORG-CUTOVER.md', 'utf8');
  for (const genoemd of [
    'tools/dashboard-feed-generator/generator.mjs',
    'tools/dashboard-feed-generator/com.rvh.dashboard-feed-generator.plist',
    '~/Stack-Director/bin/dashboard-feed-generator.mjs',
    '~/Stack-Director/launchd/com.rvh.dashboard-feed-generator.plist',
    '~/Library/LaunchAgents/com.rvh.dashboard-feed-generator.plist',
  ]) assert.ok(gids.includes(genoemd), genoemd);
});

test('C4 — de te plakken regels in de gids dragen geen hoekhakenplaceholder', () => {
  // De handeling wordt onder tijdsdruk uitgevoerd, uit dit blok, met kopiëren en plakken. `<` en
  // `>` zijn in bash omleidingstekens: `cd <map>` leest niet als "vul hier de map in" maar knipt
  // stil een bestand leeg of valt om. Een placeholder hoort dus een variabele te zijn, geen haken.
  const gids = readFileSync('docs/ORG-CUTOVER.md', 'utf8');
  const blokken = [...gids.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(blokken.length > 0, 'de gids draagt ten minste één bash-blok');
  for (const blok of blokken) {
    for (const regel of blok.split('\n')) {
      const code = regel.split('#')[0];
      assert.doesNotMatch(code, /<[^<>\s]+>/, regel);
    }
  }
  // En de omschrijving is er nog: zonder de uitleg zou de haakloze vorm hierboven ook te halen zijn
  // door de plaatsaanduiding helemaal weg te laten, en dan weet de lezer niet meer wát hij invult.
  assert.match(gids, /KLOON=/);
  assert.ok(gids.includes('de kloon van stack-dashboard'), 'de gids zegt wat KLOON is');
});

// --- 7. De kandidatenlijst: fail-closed op vervuilde invoer -------------------------------------
//
// Deze sectie meet één afweging en niet een typetoets om de typetoets. `eigenaarsKandidaten` bouwt
// de namen waarop R1 zoekt. Wie daar een ongeldige waarde stilzwijgend uitfiltert, haalt een
// eigenaar UIT de poort — en juist een achtergebleven vorige eigenaar is de bevinding die deze
// migratie moet vangen. Vervuilde invoer moet dus luid stuk, niet stil half.

test('R1-kandidaten — een niet-string eigenaar wordt geweigerd, niet naar tekst gedwongen', () => {
  // `RegExp.test` maakt van 123 gewoon '123' en laat hem door NAAM heen; pas `toLowerCase()` een
  // regel verderop knalde dan, met een kale TypeError die niets zegt over de invoer.
  for (const stuk of [123, null, true, {}, ['RVH-Speaking'], Symbol('x')]) {
    assert.throws(
      () => eigenaarsKandidaten(stuk, VORIGE_HOSTING_EIGENAARS),
      (e) => e instanceof Error && !(e instanceof TypeError) && /ongeldige eigenaarsnaam/.test(e.message),
      String(typeof stuk),
    );
  }
  // `undefined` is de ENIGE uitzondering, en met opzet: dat is de waarde waarmee JavaScript "niet
  // meegegeven" uitdrukt, dus daar hoort de gedeclareerde stand te gelden. Zou ook die weigeren,
  // dan kon de poort niet meer zonder argumenten worden aangeroepen — precies hoe zij draait.
  assert.deepEqual(eigenaarsKandidaten(undefined, undefined), eigenaarsKandidaten());
  assert.ok(eigenaarsKandidaten().includes(HOSTING_OWNER_OF_RECORD));
});

test('R1-kandidaten — een niet-string in vorigeEigenaars wordt geweigerd, niet overgeslagen', () => {
  for (const stuk of [42, null, {}, ['rvanhooijdonk-png']]) {
    assert.throws(
      () => eigenaarsKandidaten(HOSTING_OWNER_OF_RECORD, [VORIGE, stuk]),
      /ongeldige eigenaarsnaam/,
      String(typeof stuk),
    );
  }
  // En de lijst zelf moet een lijst zijn: een losse string zou anders per teken worden gespreid.
  assert.throws(() => eigenaarsKandidaten(HOSTING_OWNER_OF_RECORD, VORIGE), /ongeldige vorigeEigenaars/);
});

test('R1-kandidaten — een ongeldige NAAM wordt geweigerd op beide plaatsen', () => {
  for (const naam of ['kwaad/pad', 'met spatie', '', 'x'.repeat(101), '../ontsnapping']) {
    assert.throws(() => eigenaarsKandidaten(naam, []), /ongeldige eigenaarsnaam/, naam);
    assert.throws(() => eigenaarsKandidaten(HOSTING_OWNER_OF_RECORD, [naam]), /ongeldige eigenaarsnaam/, naam);
  }
  // Dezelfde volgorde geldt bij het Pages-voorvoegsel: eerst het type, dan de vorm. Ook daar mag
  // een niet-string nooit als tekst worden opgevat en pas op `toLowerCase()` stuklopen.
  assert.throws(() => verwachtPagesVoorvoegsel(123), /ongeldige eigenaar of repositorynaam/);
  assert.throws(() => verwachtPagesVoorvoegsel(HOSTING_OWNER_OF_RECORD, ['stack-dashboard']), /ongeldige eigenaar of repositorynaam/);
});

test('R1-kandidaten — een hoofdletterduplicaat blijft precies één kandidaat en één bevinding', () => {
  // Ontdubbelen gebeurt hoofdletterongevoelig, want het patroon zoekt dat ook. Zonder ontdubbeling
  // staat dezelfde naam twee keer in de alternatie: geen tweede bevinding, wel een patroon dat
  // groeit met elke schrijfwijze die iemand toevoegt.
  assert.deepEqual(eigenaarsKandidaten('RVH-Speaking', ['rvh-speaking', 'RVH-SPEAKING']), ['RVH-Speaking']);
  // Langste eerst blijft gelden, zodat een naam die een andere bevat niet als de kortere wordt gemeld.
  assert.deepEqual(eigenaarsKandidaten('rvh', ['rvh-speaking-langer', 'RVH']), ['rvh-speaking-langer', 'rvh']);

  const b = toetsBestand(
    { pad: 'scripts/nieuw.mjs', tekst: `const OWNER = '${HOSTING_OWNER_OF_RECORD}';\n` },
    { ...geenUitzonderingen, vorigeEigenaars: [HOSTING_OWNER_OF_RECORD.toLowerCase(), VORIGE] },
  );
  assert.equal(b.length, 1);
  assert.equal(b[0].code, OVERTREDING.OPERATIONELE_EIGENAAR);
  assert.equal(b[0].gevonden, HOSTING_OWNER_OF_RECORD);
  // De klasse blijft HUIDIG: het duplicaat mag de eigen eigenaar niet als achtergebleven etiketteren.
  assert.equal(b[0].eigenaarsklasse, EIGENAARSKLASSE.HUIDIG);
});

test('R1-kandidaten — de poort zelf weigert vervuilde invoer in plaats van stil minder te bewaken', () => {
  // Het gevaar dat stil overslaan zou opleveren, hier meetbaar: met een ongeldige waarde ERBIJ moet
  // de poort stuk, niet doorgaan met alleen de resterende namen. Zou zij doorgaan, dan verdwijnt de
  // vorige eigenaar geruisloos uit R1 en is een achtergebleven binding ineens groen.
  const bestand = { pad: 'scripts/nieuw.mjs', tekst: `const OWNER = '${VORIGE}';\n` };
  assert.throws(
    () => toetsBestand(bestand, { ...geenUitzonderingen, vorigeEigenaars: [VORIGE, 42] }),
    /ongeldige eigenaarsnaam/,
  );
  assert.throws(
    () => toetsBoom([bestand], { ...geenUitzonderingen, vorigeEigenaars: [VORIGE, 42] }),
    /ongeldige eigenaarsnaam/,
  );
  // Met schone invoer is diezelfde binding gewoon één ACHTERGEBLEVEN bevinding.
  const b = toetsBestand(bestand, { ...geenUitzonderingen, vorigeEigenaars: [VORIGE] });
  assert.equal(b.length, 1);
  assert.equal(b[0].eigenaarsklasse, EIGENAARSKLASSE.ACHTERGEBLEVEN);
});
