/**
 * COLLECT — read-only aggregatie. Voert nooit een mutatie uit: geen merge, geen deploy,
 * geen retry, geen provider-activatie.
 *
 * Twee regels die uit de review van 23-07-2026 komen en die hier leidend zijn:
 *
 * 1. **Een fout is geen leegte.** `gh()` geeft `{ok:false}` bij een mislukte aanroep en
 *    `{ok:true, data:null}` bij een geslaagde aanroep zonder resultaat. Wie dat door elkaar
 *    haalt, publiceert "geen CI" waar "we konden het niet vaststellen" hoort te staan.
 * 2. **Een leesbare bron met nul herkende regels is niet geverifieerd.** Dan is de parser stuk,
 *    en dat is een `UNVERIFIED`-toestand, geen groene.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const OWNER = validName(process.env.DASHBOARD_OWNER ?? 'rvanhooijdonk-png', 'DASHBOARD_OWNER');
const CONTROL_REPO = validName(process.env.DASHBOARD_CONTROL_REPO ?? 'stack-control', 'DASHBOARD_CONTROL_REPO');
const TRACKER_PATH = 'AUDIT-INPUT/stack-open-beslispunten.md';
const GH_TIMEOUT_MS = 60_000;

/**
 * Een bron die leesbaar is maar al weken niet is aangeraakt, is niet "actueel" — hij is oud.
 * Zonder deze grens toont een stilstaande stack een groene pagina (review Gemini, 23-07-2026).
 */
const STALE_DAYS = 14;
/** Toegestane klokafwijking tussen CI-runner en commitdatum. Daarbuiten klopt er iets niet. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** GitHub-namen zijn alfanumeriek met `-._`. Alles daarbuiten is geen naam maar een poging. */
function validName(value, label) {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(value)) throw new Error(`ongeldige ${label}`);
  return value;
}

/**
 * Repo's die bij naam getoond mogen worden. De rest wordt geaggregeerd als "overige repo's",
 * want een openbare pagina hoort geen inventaris van privérepo-namen te zijn.
 * Uitbreiden = één regel in `data/public-repos.json`.
 */
let publicRepos = new Set();
export function setPublicRepos(names) {
  publicRepos = new Set((names ?? []).filter((n) => /^[A-Za-z0-9._-]{1,100}$/.test(n)));
}
const shown = (name) => (publicRepos.has(name) ? name : null);

/**
 * Hetzelfde principe voor tracks. Een track wordt bij naam getoond (uit de allowlist), maar wat
 * de pagina toont is alleen de leeftijd van zijn klaar-rapport — nooit de rapport-bestandsnaam,
 * want de onderwerptekst daarin kan een project- of klantnaam dragen. Een track koppelt aan zijn
 * rapporten via één of meer `slugs`: het onderwerp-deel van `YYYY-MM-DD-<onderwerp>.md` moet zo'n
 * slug bevatten. Stringvorm blijft toegestaan (slug = kleine-letter-naam) voor achterwaartse
 * compatibiliteit met de oude allowlist.
 *
 * De slug-lengtegrens (>= 2) geldt op ÉLKE route — string, object-fallback én expliciete slugs.
 * Beide reviewers (Codex + Gemini, 24-07-2026) wezen op hetzelfde gat: een track `"C"` of
 * `{name:"C"}` leverde de slug `"c"`, en `onderwerp.includes("c")` matcht dan bijna elk rapport.
 * Een slug van één teken is geen koppeling maar een zeef die alles doorlaat, dus die telt niet mee.
 */
let publicTrackDefs = [];
export function parseTrackDefs(entries) {
  const cleanSlugs = (raw) => raw.map((s) => String(s).toLowerCase()).filter((s) => s.length >= 2);
  return (entries ?? [])
    .map((e) => {
      if (typeof e === 'string') return { name: e, slugs: cleanSlugs([e]) };
      if (e && typeof e === 'object' && typeof e.name === 'string') {
        const slugs = Array.isArray(e.slugs) && e.slugs.length ? cleanSlugs(e.slugs) : cleanSlugs([e.name]);
        return { name: e.name, slugs };
      }
      return null;
    })
    .filter((d) => d && /^[A-Za-z0-9._ -]{1,100}$/.test(d.name) && d.slugs.length > 0);
}
export function setPublicTracks(entries) {
  publicTrackDefs = parseTrackDefs(entries);
}

/**
 * Afgeleid categorielabel uit de interne titel-/besluittekst. Alleen dit label — één waarde uit
 * een gesloten lijst — verlaat de machine; de brontekst zelf blijft binnen. Dat is precies de
 * sanitize-wet: nooit brontekst, wél afgeleide labels. Trefwoord-classificatie, geen begrip: bij
 * geen enkele match "overig". De volgorde is bewust — `security` wint, want een merge- of
 * planningsbesluit dát over een secret/auth gaat hoort thuis bij security.
 */
export const CATEGORIEEN = ['security', 'accounts', 'kosten', 'merge-beleid', 'planning', 'overig'];
const CATEGORIE_REGELS = [
  ['security', /(secret|token|security|\brls\b|\bauth|pentest|leak|gitleaks|kwetsbaar|\bcve\b|ssrf|hmac|containment|sanitize)/i],
  ['accounts', /(account|oauth|inlog|\blogin\b|\bseat\b|workspace|credential|abonnement|\bmax-abo\b)/i],
  ['kosten', /(kost|prijs|budget|credit|betaal|euro|\bmeter|quota|usage|tarief)/i],
  ['merge-beleid', /(merge|mergen|pull request|\bpr\b|\bbranch|rebase|squash|review-?regime|goedkeur)/i],
  ['planning', /(planning|deadline|roadmap|mijlpaal|sprint|volgorde|prioriteit|\bplan\b|fasering|tranche|pilot)/i],
];
export function categoriseer(text) {
  const s = String(text ?? '');
  for (const [cat, re] of CATEGORIE_REGELS) { re.lastIndex = 0; if (re.test(s)) return cat; }
  return 'overig';
}

/** `gh` aanroepen. Onderscheidt expliciet "mislukt" van "geslaagd maar leeg". */
async function gh(args, { json = true } = {}) {
  try {
    const { stdout } = await run('gh', args, { maxBuffer: 32 * 1024 * 1024, timeout: GH_TIMEOUT_MS });
    if (!json) return { ok: true, data: stdout };
    const text = stdout.trim();
    return { ok: true, data: text === '' ? null : JSON.parse(text) };
  } catch {
    return { ok: false, data: null };
  }
}

const evidence = (source, sourceRef, trust, proofUrl, error = null) => ({
  source, retrievedAt: new Date().toISOString(), sourceRef, trust, proofUrl, error,
});

const repoUrl = (repo) => `https://github.com/${OWNER}/${repo}`;
const seg = (s) => encodeURIComponent(s);

/**
 * Zuivere beslislogica voor één contents-API-respons — los van de `gh`-aanroep, zelfde patroon
 * als `tracksFromListing`, zodat dit zonder netwerk te toetsen is.
 *
 * Boven ±1MB antwoordt de contents-API met HTTP 200, `encoding: "none"`, `content: ""` — geen
 * foutcode. Toetsen op lege inhoud is dan fout: een 0-byte-bestand geeft óók lege `content`, maar
 * met `encoding: "base64"`. Alleen `encoding` onderscheidt de twee gevallen exact (gemeten, niet
 * aangenomen — PR-OPSCHONING, W-41, `2026-07-28-w41-blinde-leesroutes-gemeten.md` §2/§11). Zonder
 * dit onderscheid valt "te groot om te lezen" stil samen met "leeg" — dezelfde blinde plek als
 * `bezorging.py` (W-40), en precies de fout die de eigen regel bovenaan dit bestand verbiedt:
 * een fout is geen leegte.
 */
export function decodeContentsResponse(data) {
  if (!data || typeof data !== 'object') return { text: null, tooLarge: false, size: null };
  const size = typeof data.size === 'number' ? data.size : null;
  if (data.encoding === 'none') return { text: null, tooLarge: true, size };
  const raw = typeof data.content === 'string' ? data.content : '';
  if (!raw.trim()) return { text: null, tooLarge: false, size };
  try {
    return { text: Buffer.from(raw.replace(/\s/g, ''), 'base64').toString('utf8'), tooLarge: false, size };
  } catch {
    return { text: null, tooLarge: false, size };
  }
}

/** Bestandsinhoud uit een repo halen via de contents-API. `{text, tooLarge, size}` — nooit een kale null. */
async function fileFromRepo(repo, path, ref = 'main') {
  const encoded = path.split('/').map(seg).join('/');
  const res = await gh(['api', `repos/${OWNER}/${repo}/contents/${encoded}?ref=${seg(ref)}`]);
  if (!res.ok || !res.data) return { text: null, tooLarge: false, size: null };
  return decodeContentsResponse(res.data);
}

/** De standaardreden voor `evidence()` als een bron niets opleverde: too_large krijgt zijn eigen tekst. */
const onbereikbaarReden = (tooLarge, size, fallback) => (tooLarge
  ? `Bron is groter dan de leesgrens van de contents-API (±1MB; grootte ${size ?? 'onbekend'} bytes) — niet uitgelezen, geen lege bron.`
  : fallback);

/** Een bron die leesbaar was maar niets herkenbaars opleverde, is niet geverifieerd. */
const trustFor = (count) => (count > 0 ? 'VERIFIED_CURRENT' : 'UNVERIFIED');
const parserNote = (count) => (count > 0 ? null : 'Bron gelezen, maar geen enkele regel herkend — parser mogelijk verouderd.');

/**
 * Laatste commitdatum van één bestand. Leeg = onbekend, en onbekend is niet "vers". `ref` kiest de
 * branch; zonder ref kijkt de API naar de default branch (bestaand gedrag, ongewijzigd).
 */
async function lastCommitDate(repo, path, ref = null) {
  const res = await gh([
    'api', `repos/${OWNER}/${seg(repo)}/commits?path=${path.split('/').map(seg).join('/')}&per_page=1${
      ref ? `&sha=${seg(ref)}` : ''}`,
    '-q', '.[0].commit.committer.date',
  ], { json: false });
  const date = res.ok ? (res.data ?? '').trim() : '';
  return date && date !== 'null' ? date : null;
}

/**
 * Combineer "is er iets herkend" met "hoe oud is de bron". Een leesbaar maar bejaard bestand
 * levert STALE op, geen groen vinkje — het verschil tussen "dit klopt nog" en "dit staat stil".
 */
function trustWithAge(count, lastChangeAt) {
  if (count === 0) return { trust: 'UNVERIFIED', note: parserNote(count) };
  const aged = ageTrust(lastChangeAt);
  if (aged.trust !== 'VERIFIED_CURRENT') return aged;
  return { trust: 'VERIFIED_CURRENT', note: null };
}

/**
 * Alleen de leeftijdsregel, zonder inhoudstelling — bruikbaar voor bronnen die per stuk een
 * datum dragen (vloottracks). Exact in milliseconden: `Math.floor` naar dagen liet een bron tot
 * bijna vijftien dagen groen staan, wat precies het misverstand is dat STALE moest wegnemen.
 */
export function ageTrust(lastChangeAt, now = Date.now()) {
  if (!lastChangeAt) return { trust: 'UNVERIFIED', note: 'Laatste wijzigingsdatum van de bron onbekend.' };
  const ms = now - new Date(lastChangeAt).getTime();
  if (!Number.isFinite(ms)) return { trust: 'UNVERIFIED', note: 'Datum van de bron onleesbaar.' };
  // Een datum in de toekomst is geen verse bron maar een kapotte klok — en die gaf groen.
  // Een paar minuten speling blijft toegestaan: CI-runner en committer lopen zelden gelijk.
  if (ms < -CLOCK_SKEW_MS) {
    return { trust: 'UNVERIFIED', note: 'De bron draagt een datum in de toekomst — klok of bron klopt niet.' };
  }
  if (ms >= STALE_DAYS * 86400000) {
    return { trust: 'STALE', note: `Bron ${Math.floor(ms / 86400000)} dagen niet gewijzigd — de pagina is vers, de inhoud niet.` };
  }
  return { trust: 'VERIFIED_CURRENT', note: null };
}

/** Org-brede open PR's, gegroepeerd per repo. Vereist een read-token met org-bereik. */
export async function collectPullRequests() {
  const res = await gh([
    'search', 'prs', '--owner', OWNER, '--state', 'open', '--limit', '1000',
    '--json', 'repository,isDraft',
  ]);

  if (!res.ok) {
    return {
      available: false, repositories: [], hiddenRepositories: 0, totals: { open: 0, draft: 0, ready: 0 },
      evidence: evidence('GitHub search API', `owner:${OWNER} state:open`, 'SOURCE_UNAVAILABLE',
        `https://github.com/${OWNER}`,
        'PR-zoekopdracht mislukt — ontbrekend of te smal gescoopt read-token in CI.'),
    };
  }

  const open = res.data ?? [];
  const byRepo = new Map();
  const totals = { open: 0, draft: 0, ready: 0 };
  let hidden = 0;

  for (const pr of open) {
    const name = shown(pr.repository?.name ?? '');
    const key = name ?? '__overig__';
    if (!name) hidden += 1;
    if (!byRepo.has(key)) byRepo.set(key, { repository: name ?? 'overige repo\'s', open: 0, draft: 0, ready: 0 });
    const row = byRepo.get(key);
    row.open += 1; totals.open += 1;
    if (pr.isDraft) { row.draft += 1; totals.draft += 1; } else { row.ready += 1; totals.ready += 1; }
  }

  return {
    available: true,
    repositories: [...byRepo.values()].sort((a, b) => b.open - a.open),
    hiddenRepositories: hidden,
    totals,
    evidence: evidence('GitHub search API', `owner:${OWNER} state:open`, trustFor(open.length),
      `https://github.com/${OWNER}`, open.length ? null : 'Nul open PR\'s gerapporteerd — controleer het tokenbereik.'),
  };
}

/** Recent gemergede PR's — het tempo waarmee werk landt, niet alleen wat openstaat. */
export async function collectMergedRecent(days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const res = await gh([
    'search', 'prs', '--owner', OWNER, '--merged-at', `>=${since}`, '--limit', '1000',
    '--json', 'repository',
  ]);
  if (!res.ok) {
    return {
      available: false, windowDays: days, count: 0, byRepository: [],
      evidence: evidence('GitHub search API', `merged>=${since}`, 'SOURCE_UNAVAILABLE',
        `https://github.com/${OWNER}`, 'Zoekopdracht mislukt.'),
    };
  }
  const merged = res.data ?? [];
  const byRepo = new Map();
  for (const pr of merged) {
    const name = shown(pr.repository?.name ?? '') ?? 'overige repo\'s';
    byRepo.set(name, (byRepo.get(name) ?? 0) + 1);
  }
  return {
    available: true,
    windowDays: days,
    count: merged.length,
    byRepository: [...byRepo.entries()].map(([repository, count]) => ({ repository, merged: count }))
      .sort((a, b) => b.merged - a.merged),
    evidence: evidence('GitHub search API', `merged>=${since}`, 'VERIFIED_CURRENT', `https://github.com/${OWNER}`),
  };
}

/** Tracker: alleen kopregels en beslispunttitels — nooit de body van een update. */
/**
 * Rijen lezen zonder ze stil te laten vallen (27-07-2026).
 *
 * De oude lezers herkenden een rij aan een patroon MET bovengrens: `{3,160}` voor een besluit,
 * `{1,200}` voor een trackerupdate, `{3,110}` voor een kop. Een rij die niet in die maat paste
 * viel weg — geen fout, geen telling, geen spoor. Op de plaat is "de jongste die ik begreep" dan
 * niet te onderscheiden van "de jongste die er is": het besluitenregister stond op D-0094 terwijl
 * D-0095 t/m D-0099 gewoon op main stonden (68 van de 98 rijen onzichtbaar).
 *
 * Vandaar deze vorm: herkennen aan het ANKER (het ID, het kopteken), pas daarna inkorten — en van
 * elke lezer een telling `{ inBron, herkend, getoond }` teruggeven. Inkorten is een weergavekeuze,
 * weglaten is een meting; die twee mogen nooit meer op elkaar lijken.
 */
/**
 * De verwachting komt van de BRONKANT, vóór het filter (Richard, 27-07-2026): een lezer die telt
 * wat hij overhoudt, telt wat hij al heeft weggegooid en meldt dat alles klopt. `inBron` telt dus
 * elke KANDIDAAT-rij — alles wat er in de bron uitziet als een rij van deze soort, ook als de lezer
 * hem niet begrijpt. `herkend` is wat de lezer erna overhield; het verschil is de uitkomst.
 *
 * `afgekapt` telt de rijen waarvan de tekst is ingekort. Afkappen mag, stil afkappen niet: een
 * grens die zwijgend inkort of weggooit is een defect, geen instelling.
 */
function tel(inBron, herkend, getoond, afgekapt) {
  return { inBron, herkend, getoond, afgekapt };
}

/** Kort in en houdt bij dát er ingekort is — de teller hangt eraan, niet aan de lengte alleen. */
function kort(tekst, max, teller) {
  if (tekst.length <= max) return tekst;
  teller.n += 1;
  return tekst.slice(0, max);
}

/** Alles na het eerste liggend/kort streepje op de regel, ontdaan van opmaak en afsluitende punt. */
function staart(regel, max, teller) {
  return kort(regel.replace(/\*+\s*$/, '').trim().replace(/\.$/, ''), max, teller);
}

export function leesBesluiten(text) {
  const regels = String(text ?? '').split('\n');
  // Bronkant: élke tabelrij waarvan de eerste cel met `D-` begint is een kandidaat — ook een rij
  // met een scheve ID-vorm. Pas daarna filtert de lezer; dat verschil hoort zichtbaar te zijn.
  const kandidaat = /^\s*\|\s*[Dd]-/;
  const anker = /^\s*\|\s*(D-\d{4})\s*\|(.*)$/;
  const afgekapt = { n: 0 };
  let inBron = 0;
  const herkend = [];
  for (const regel of regels) {
    if (!kandidaat.test(regel)) continue;
    inBron += 1;
    const m = anker.exec(regel);
    if (!m) continue;
    // De rest van de rij: | datum | besluit | ... — het besluit mag elke lengte hebben.
    const cellen = m[2].split('|');
    const datum = (cellen[0] ?? '').trim();
    const besluit = (cellen[1] ?? '').trim();
    if (!/^[\d-]{4,12}$/.test(datum) || besluit.length < 3) continue;
    herkend.push({
      id: m[1], date: datum, decision: kort(besluit, 160, afgekapt), category: categoriseer(besluit),
    });
  }
  herkend.sort((a, b) => b.id.localeCompare(a.id));
  const entries = herkend.slice(0, 10);
  return { entries, telling: tel(inBron, herkend.length, entries.length, afgekapt.n) };
}

export function leesTracker(text) {
  const regels = String(text ?? '').split('\n');
  const updateKandidaat = /^ {0,3}\*\*Update\b/i;
  // Het anker eist alleen wat een update IDENTIFICEERT: het woord en een datum. Alles daarna is
  // vorm, en vorm varieert. GEMETEN 27-07-2026 op de echte tracker: 17 van de 32 updates vielen
  // weg omdat het oude anker het volgnummer PAL achter de datum eiste — `Update 22/7 nacht (8)`,
  // `Update 22/7 middag/namiddag`, `Update 21/7 en eerder` haalden het geen van drieën. Dat is
  // dezelfde vorm als de 160-tekengrens: een lezer die de vorm van gisteren eist en vandaag stil
  // minder leest.
  // De `i`-vlag is niet cosmetisch: `updateKandidaat` (de BRONtelling) is hoofdletterongevoelig, dus
  // `**UPDATE 22/7 ...` telde wél mee in `inBron` en niet in `herkend` — een zelfgemaakte ROOD op een
  // regel die er gewoon staat. Gemeten op de echte tracker komt die schrijfwijze niet voor, dus dit is
  // dichtzetten vóór het gebeurt (bevinding Codex 27-07), geen reparatie van iets zichtbaars.
  const updateAnker = /^ {0,3}\*\*Update\s+([0-9]{1,2}\/[0-9]{1,2})\s*(.*)$/i;
  // Het volgnummer staat tussen haakjes ergens vóór het gedachtestreepje — met of zonder dagdeel
  // ertussen. Staat er een streepje vóór de haakjes, dan hoort het getal bij de TITEL en niet bij
  // de update (`Update 23/7 — iets (2026) meer`), en blijft het nummer leeg.
  // Hoogstens DRIE cijfers, en tussen datum en nummer geen cijfer. Anders leest
  // `Update 22/7 nacht (2026) — titel` het jaartal als volgnummer 2026 en duwt dat élke echte update
  // uit de top-8 (bevinding Codex 27-07). Het dagdeel ertussen — "nacht", "avond", "vroeg", "laat" —
  // is echt en staat op 12 van de 32 gemeten regels, dus de prefix mag blijven; cijfers erin niet.
  const nummerVoorop = /^([^(]{0,24})\(([0-9]{1,3})\)\s*/;
  // Kandidaat is élke vermelding van BESLISPUNT met een nummer erachter; het anker eist het
  // liggend streepje. `BESLISPUNT 12a: titel` haalde het anker niet en telde ook niet mee — dan
  // meldt de lezer nul en dat ziet er hetzelfde uit als geen beslispunten (Codex, 27-07).
  const puntKandidaat = /BESLISPUNT\s*\(?[0-9]{1,3}[a-z]?\)?/g;
  const puntAnker = /BESLISPUNT\s*\(?([0-9]{1,3}[a-z]?)\)?\s*[—-]\s*([^*\n]*)/g;
  const afgekapt = { n: 0 };
  let inBron = 0;
  let dubbel = 0;
  const gelezen = [];
  const punten = [];
  const gezien = new Set();
  for (const regel of regels) {
    if (updateKandidaat.test(regel)) {
      inBron += 1;
      const m = updateAnker.exec(regel);
      if (m) {
        let rest = m[2];
        let number = null;
        const nm = nummerVoorop.exec(rest);
        // Ook het en-streepje `–`, niet alleen het em-streepje: anders hoort het getal bij de titel
        // en telt het toch als volgnummer.
        if (nm && !/[—–-]/.test(nm[1]) && !/[0-9]/.test(nm[1])) { number = Number(nm[2]); rest = rest.slice(nm[0].length); }
        // Een update zonder titel is nog steeds een update. Zijn eigen datum is dan zijn naam —
        // dat is geen verzinsel maar wat er staat, en het scheelt een rij die stil verdwijnt.
        const title = staart(rest.replace(/^[—-]\s*/, ''), 120, afgekapt) || m[1];
        gelezen.push({ number, date: m[1], title, volgorde: gelezen.length });
      }
    }
    puntKandidaat.lastIndex = 0;
    inBron += [...regel.matchAll(puntKandidaat)].length;
    puntAnker.lastIndex = 0;
    for (const p of regel.matchAll(puntAnker)) {
      const title = kort(p[2].split('.')[0].trim(), 110, afgekapt);
      // Een beslispunt dat twee keer in de tracker staat is één beslispunt. Zou het tweede exemplaar
      // als "weggevallen" tellen, dan meldde de rijentoets rood op gewone herhaling (Gemini, 27-07).
      if (gezien.has(p[1])) { dubbel += 1; continue; }
      if (title.length < 3) continue;
      gezien.add(p[1]);
      punten.push({ id: p[1], title, category: categoriseer(title) });
    }
  }
  // Genummerd eerst, hoogste boven; wat geen nummer draagt houdt zijn plek in het bestand. Zonder
  // die tweedeling maakt één update zonder nummer (`b.number - a.number` met null) de hele volgorde
  // stuk, en dan verandert een leesfout stilletjes wát er bovenaan staat.
  gelezen.sort((a, b) => {
    if (a.number === null && b.number === null) return a.volgorde - b.volgorde;
    if (a.number === null) return 1;
    if (b.number === null) return -1;
    return b.number - a.number;
  });
  // Het publieke contract eist een geheel getal als volgnummer, dus een update zonder nummer kan
  // niet in de VENSTERLIJST. Hij is wel HERKEND en wordt als zodanig geteld: het verschil tussen
  // `herkend` en `getoond` is een venster, geen verlies — precies het onderscheid waarvoor de
  // telling gemaakt is.
  const updates = gelezen.filter((u) => Number.isInteger(u.number))
    .slice(0, 8).map(({ number, date, title }) => ({ number, date, title }));
  const decisionPoints = punten.slice(0, 12);
  return {
    updates,
    decisionPoints,
    telling: tel(
      inBron, gelezen.length + punten.length + dubbel, updates.length + decisionPoints.length,
      afgekapt.n,
    ),
  };
}

export function leesJournaal(text) {
  const regels = String(text ?? '').split('\n');
  const afgekapt = { n: 0 };
  let inBron = 0;
  const gelezen = [];
  for (const regel of regels) {
    if (!/^ {0,3}#{2,3}(\s|$)/.test(regel)) continue;
    inBron += 1;
    const m = /^ {0,3}#{2,3}\s+(.+)$/.exec(regel);
    if (!m) continue;
    const title = kort(m[1].trim(), 110, afgekapt);
    if (title) gelezen.push({ title });
  }
  const entries = gelezen.slice(0, 6);
  return { entries, telling: tel(inBron, gelezen.length, entries.length, afgekapt.n) };
}

export async function collectTracker() {
  const { text, tooLarge, size } = await fileFromRepo(CONTROL_REPO, TRACKER_PATH);
  const proof = `${repoUrl(CONTROL_REPO)}/blob/main/${TRACKER_PATH}`;
  const src = `${CONTROL_REPO} / tracker`;

  if (!text) {
    return {
      available: false, updates: [], decisionPoints: [],
      evidence: evidence(src, 'main', 'SOURCE_UNAVAILABLE', proof,
        onbereikbaarReden(tooLarge, size, 'Tracker niet leesbaar met het huidige token.')),
    };
  }

  const { updates, decisionPoints, telling } = leesTracker(text);

  const n = updates.length + decisionPoints.length;
  const { trust, note } = trustWithAge(n, await lastCommitDate(CONTROL_REPO, TRACKER_PATH));
  return {
    available: true, updates, decisionPoints, rijen: telling,
    evidence: evidence(src, 'main', trust, proof, note),
  };
}

/** Besluitenregister — welke beslispunten zijn inmiddels beantwoord. */
export async function collectDecisions() {
  const { text, tooLarge, size } = await fileFromRepo(CONTROL_REPO, 'CONTROL/DECISIONS.md');
  const proof = `${repoUrl(CONTROL_REPO)}/blob/main/CONTROL/DECISIONS.md`;
  const src = `${CONTROL_REPO} / besluitenregister`;
  if (!text) {
    return {
      available: false, entries: [],
      evidence: evidence(src, 'main', 'SOURCE_UNAVAILABLE', proof, onbereikbaarReden(tooLarge, size, 'Niet leesbaar.')),
    };
  }
  const { entries, telling } = leesBesluiten(text);
  const { trust, note } = trustWithAge(entries.length, await lastCommitDate(CONTROL_REPO, 'CONTROL/DECISIONS.md'));
  return {
    available: true, entries, rijen: telling,
    evidence: evidence(src, 'main', trust, proof, note),
  };
}

/** Klaar-rapporten staan als `YYYY-MM-DD-<onderwerp>.md` op deze branch van de control-repo. */
const RAPPORTEN_PATH = 'CONTROL/RAPPORTEN';
const RAPPORTEN_REF = 'rapporten';

/**
 * `YYYY-MM-DD` is pas een echte datum als hij een UTC-round-trip overleeft. `2026-02-30` past op de
 * regex maar rolt via `Date` door naar 2 maart; die stille verschuiving mag geen leeftijd voeden.
 */
export function isEchteDatum(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/**
 * Pure koppeling track ↔ rapporten, los van de `gh`-call zodat de segment-match, de datumkeuring
 * en de type-filter getest kunnen worden zonder netwerk. `listing` is de contents-API-uitvoer
 * (`[{name, type}]`). Geeft per track `{track, lastReportAt, reportCount, trust}` — nooit een naam.
 */
export function tracksFromListing(defs, listing) {
  const rapporten = (Array.isArray(listing) ? listing : [])
    .filter((f) => (f?.type === undefined || f.type === 'file')
      && typeof f.name === 'string' && /^\d{4}-\d{2}-\d{2}-.+\.md$/.test(f.name)
      && isEchteDatum(f.name.slice(0, 10)))
    .map((f) => ({
      datum: f.name.slice(0, 10),
      segmenten: new Set(f.name.slice(11, -3).toLowerCase().split('-').filter(Boolean)),
    }));
  return defs.map((def) => {
    const matches = rapporten.filter((r) => def.slugs.some((s) => r.segmenten.has(s)));
    matches.sort((a, b) => b.datum.localeCompare(a.datum));
    // Rapporten dragen een dagdatum, geen tijd; middernacht-UTC is de eerlijke ondergrens.
    const lastReportAt = matches.length ? `${matches[0].datum}T00:00:00Z` : null;
    return {
      track: def.name,
      lastReportAt,
      reportCount: matches.length,
      // Geen rapport = geen bewijs, geen groen. Wél of niet vers volgt daarna uit de leeftijd.
      trust: matches.length ? ageTrust(lastReportAt).trust : 'UNVERIFIED',
    };
  });
}

/**
 * TRACKS-blok (v2): per track de leeftijd van zijn meest recente klaar-rapport. Vervangt de oude
 * vloot (commitdatum van het queue-bestand) door de vraag die er echt toe doet — wanneer leverde
 * deze track voor het laatst bewijsbaar werk op. We tonen per allowlist-track alleen de afgeleide
 * datum en een telling; nooit de rapport-bestandsnaam, want de onderwerptekst kan een project- of
 * klantnaam dragen (dezelfde regel als bij de oude vloot). Een track zonder rapport is geen fout
 * maar een eerlijke leegte: `lastReportAt=null`, trust `UNVERIFIED` ("geen bewijs van werk"),
 * geen gecachte groene stand.
 */
export async function collectTracks() {
  const listing = await gh([
    'api', `repos/${OWNER}/${CONTROL_REPO}/contents/${RAPPORTEN_PATH}?ref=${seg(RAPPORTEN_REF)}`,
  ]);
  const proof = `${repoUrl(CONTROL_REPO)}/tree/${RAPPORTEN_REF}/${RAPPORTEN_PATH}`;
  const src = `${CONTROL_REPO} / klaar-rapporten`;

  if (!listing.ok || !Array.isArray(listing.data)) {
    return {
      available: false, tracks: [],
      evidence: evidence(src, RAPPORTEN_REF, 'SOURCE_UNAVAILABLE', proof, 'Rapportenmap niet leesbaar.'),
    };
  }

  // De koppeling (segment-match, datumkeuring, type-filter) zit in `tracksFromListing` — puur en
  // los van de `gh`-call, zodat de reviewbevindingen (segment i.p.v. substring, kalenderdatum,
  // alleen echte bestanden; Codex + Gemini 24-07-2026) een eigen regressietest hebben.
  const tracks = tracksFromListing(publicTrackDefs, listing.data);

  // Eén track zonder recent bewijs maakt de sectie niet groen — zelfde eerlijkheidsregel als de
  // documentbronnen. "geen rapport" en "verouderd rapport" zijn allebei geen VERIFIED_CURRENT.
  const unverified = tracks.filter((t) => t.trust === 'UNVERIFIED' || t.trust === 'SOURCE_UNAVAILABLE').length;
  const stale = tracks.filter((t) => t.trust === 'STALE').length;
  const trust = unverified ? 'UNVERIFIED' : stale ? 'STALE' : trustFor(tracks.length);
  const note = unverified ? `${unverified} van ${tracks.length} tracks heeft (nog) geen recent klaar-rapport.`
    : stale ? `${stale} van ${tracks.length} tracks leverde langer dan ${STALE_DAYS} dagen geen klaar-rapport op.`
      : parserNote(tracks.length);
  return {
    available: true,
    tracks: tracks.sort((a, b) => (b.lastReportAt ?? '').localeCompare(a.lastReportAt ?? '')),
    evidence: evidence(src, RAPPORTEN_REF, trust, proof, note),
  };
}

/** De gespiegelde bouwlijst van TRECHTER staat op de rapporten-branch van de control-repo. */
export const BOUWLIJST_PATH = 'CONTROL/PLANNING/planning-bouwlijst.json';

/**
 * BOUWLIJST — de rauwe tekst van de gespiegelde TRECHTER-bouwlijst plus het spiegelmoment.
 *
 * Waarom niet rechtstreeks uit de bron-repo: het workflow-token leest bewijsbaar deze control-repo
 * (privé) maar zijn toegang tot de trechter-repo is ONBEWEZEN. Een gespiegelde kopie die zichtbaar
 * een paar uur oud kan zijn is beter dan een plaat die leeg blijft op een tokenrecht (review Codex,
 * 25-07-2026, optie B). Vandaar dat het spiegelmoment meekomt: de pagina moet kunnen zeggen hoe oud
 * de spiegel is, anders leest een verouderde kopie als de actuele stand.
 *
 * Deze functie leest alleen; het vertalen naar het plaat-schema doet `planning-bron.mjs`.
 */
export async function collectBouwlijst() {
  const { text, tooLarge, size } = await fileFromRepo(CONTROL_REPO, BOUWLIJST_PATH, RAPPORTEN_REF);
  return {
    text,
    // tooLarge/size gaan mee zodat een toekomstige aanroeper "te groot" kan onderscheiden van
    // "leeg" — vertaalBouwlijst() zelf krijgt vandaag alleen text (LEEG-pad), dat is bestaand gedrag.
    tooLarge,
    size,
    // Onbekend spiegelmoment blijft null: de plaat zegt dan "spiegelmoment onbekend" i.p.v. vers.
    spiegelAt: text ? await lastCommitDate(CONTROL_REPO, BOUWLIJST_PATH, RAPPORTEN_REF) : null,
    proofUrl: `${repoUrl(CONTROL_REPO)}/blob/${RAPPORTEN_REF}/${BOUWLIJST_PATH}`,
  };
}

/** Journaal — alleen de kopregels van de laatste entries. */
export async function collectLogbook() {
  const proof = `${repoUrl(CONTROL_REPO)}/blob/main/CONTROL/FABLE-JOURNAAL.md`;
  const src = `${CONTROL_REPO} / journaal`;
  const { text, tooLarge, size } = await fileFromRepo(CONTROL_REPO, 'CONTROL/FABLE-JOURNAAL.md');
  if (!text) {
    return {
      available: false, entries: [],
      evidence: evidence(src, 'main', 'SOURCE_UNAVAILABLE', proof,
        onbereikbaarReden(tooLarge, size, 'Journaal staat nog niet op main — het zit in een openstaande PR.')),
    };
  }
  const { entries, telling } = leesJournaal(text);
  const { trust, note } = trustWithAge(entries.length, await lastCommitDate(CONTROL_REPO, 'CONTROL/FABLE-JOURNAAL.md'));
  return {
    available: true, entries, rijen: telling,
    evidence: evidence(src, 'main', trust, proof, note),
  };
}

/** CI-ampels: de laatste voltooide run op de default branch, per repo. */
export async function collectCi(repositories) {
  // Dezelfde allowlist als bij de PR's: een ampel met een privérepo-naam eronder is nog steeds
  // een gepubliceerde repo-naam (review Gemini, 23-07-2026). Niet-genoemde repo's tellen mee
  // in het aantal, maar krijgen geen regel op de pagina.
  const named = (repositories ?? []).filter((r) => shown(r));
  const hiddenCiRepositories = (repositories ?? []).length - named.length;

  const lights = await Promise.all(named.map(async (repo) => {
    validName(repo, 'DASHBOARD_CI_REPOS');

    const meta = await gh(['api', `repos/${OWNER}/${seg(repo)}`, '-q', '.default_branch'], { json: false });
    if (!meta.ok) return { repository: repo, state: 'ONBEKEND', conclusion: null, at: null, workflow: null };
    const branch = (meta.data ?? '').trim() || 'main';

    const res = await gh([
      'api', `repos/${OWNER}/${seg(repo)}/actions/runs?per_page=1&status=completed&branch=${seg(branch)}`,
      '-q', '.workflow_runs[0] | if . == null then "" else "\\(.conclusion)|\\(.updated_at)|\\(.name)" end',
    ], { json: false });

    if (!res.ok) return { repository: repo, state: 'ONBEKEND', conclusion: null, at: null, workflow: null };

    const line = (res.data ?? '').trim();
    if (!line || line.startsWith('null|')) {
      return { repository: repo, state: 'GEEN_CI', conclusion: null, at: null, workflow: null };
    }
    const [conclusion, at] = line.split('|');
    return {
      repository: repo,
      state: conclusion === 'success' ? 'GROEN' : conclusion === 'failure' ? 'ROOD' : 'GRIJS',
      conclusion, at, workflow: null,
    };
  }));

  const unknown = lights.filter((l) => l.state === 'ONBEKEND').length;
  return {
    available: lights.length > 0,
    lights,
    hiddenCiRepositories,
    evidence: evidence('GitHub Actions API', 'laatste voltooide run op de default branch',
      unknown ? 'UNVERIFIED' : trustFor(lights.length), `https://github.com/${OWNER}`,
      unknown ? `${unknown} van ${lights.length} repo's kon niet worden opgehaald.` : null),
  };
}
