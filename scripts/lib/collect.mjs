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

/** Bestandsinhoud uit een repo halen via de contents-API. */
async function fileFromRepo(repo, path, ref = 'main') {
  const encoded = path.split('/').map(seg).join('/');
  const res = await gh(
    ['api', `repos/${OWNER}/${repo}/contents/${encoded}?ref=${seg(ref)}`, '-q', '.content'],
    { json: false },
  );
  if (!res.ok || !res.data?.trim()) return null;
  try {
    return Buffer.from(res.data.replace(/\s/g, ''), 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/** Een bron die leesbaar was maar niets herkenbaars opleverde, is niet geverifieerd. */
const trustFor = (count) => (count > 0 ? 'VERIFIED_CURRENT' : 'UNVERIFIED');
const parserNote = (count) => (count > 0 ? null : 'Bron gelezen, maar geen enkele regel herkend — parser mogelijk verouderd.');

/** Laatste commitdatum van één bestand. Leeg = onbekend, en onbekend is niet "vers". */
async function lastCommitDate(repo, path) {
  const res = await gh([
    'api', `repos/${OWNER}/${seg(repo)}/commits?path=${path.split('/').map(seg).join('/')}&per_page=1`,
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
export async function collectTracker() {
  const text = await fileFromRepo(CONTROL_REPO, TRACKER_PATH);
  const proof = `${repoUrl(CONTROL_REPO)}/blob/main/${TRACKER_PATH}`;
  const src = `${CONTROL_REPO} / tracker`;

  if (!text) {
    return {
      available: false, updates: [], decisionPoints: [],
      evidence: evidence(src, 'main', 'SOURCE_UNAVAILABLE', proof, 'Tracker niet leesbaar met het huidige token.'),
    };
  }

  // Kopregels: "**Update 23/7 (24) — TITEL.**"
  const updates = [...text.matchAll(/^\*\*Update\s+([0-9]{1,2}\/[0-9]{1,2})\s*\((\d+)\)\s*[—-]\s*([^*\n]{1,200})/gm)]
    .map((m) => ({ number: Number(m[2]), date: m[1], title: m[3].trim().replace(/\.$/, '').slice(0, 120) }))
    .sort((a, b) => b.number - a.number)
    .slice(0, 8);

  // Beslispunten, twee schrijfwijzen: "BESLISPUNT 23a — titel" en "BESLISPUNT (9a) — titel".
  const seen = new Set();
  const decisionPoints = [...text.matchAll(/BESLISPUNT\s*\(?([0-9]{1,3}[a-z]?)\)?\s*[—-]\s*([^.*\n]{3,110})/g)]
    .map((m) => ({ id: m[1], title: m[2].trim(), category: categoriseer(m[2]) }))
    .filter((d) => (seen.has(d.id) ? false : seen.add(d.id)))
    .slice(0, 12);

  const n = updates.length + decisionPoints.length;
  const { trust, note } = trustWithAge(n, await lastCommitDate(CONTROL_REPO, TRACKER_PATH));
  return {
    available: true, updates, decisionPoints,
    evidence: evidence(src, 'main', trust, proof, note),
  };
}

/** Besluitenregister — welke beslispunten zijn inmiddels beantwoord. */
export async function collectDecisions() {
  const text = await fileFromRepo(CONTROL_REPO, 'CONTROL/DECISIONS.md');
  const proof = `${repoUrl(CONTROL_REPO)}/blob/main/CONTROL/DECISIONS.md`;
  const src = `${CONTROL_REPO} / besluitenregister`;
  if (!text) {
    return {
      available: false, entries: [],
      evidence: evidence(src, 'main', 'SOURCE_UNAVAILABLE', proof, 'Niet leesbaar.'),
    };
  }
  const entries = [...text.matchAll(/^\|\s*(D-\d{4})\s*\|\s*([\d-]{4,12})\s*\|\s*([^|]{3,160}?)\s*\|/gm)]
    .map((m) => ({ id: m[1], date: m[2], decision: m[3].trim(), category: categoriseer(m[3]) }))
    .sort((a, b) => b.id.localeCompare(a.id))
    .slice(0, 10);
  const { trust, note } = trustWithAge(entries.length, await lastCommitDate(CONTROL_REPO, 'CONTROL/DECISIONS.md'));
  return {
    available: true, entries,
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

/**
 * VLOOT-KANAALPOST — het gedeelde doorgeefluik van álle vensters, op dezelfde rapporten-branch.
 * Elke afronding is daar één tabelrij met vijf velden (D-0026): tab · wat klaar is · sha ·
 * wat Richard of Fable moet doen · datum-tijd (UTC).
 *
 * Deze parser is bewust streng en puur. Streng, want een rij die niet exact vijf velden heeft is
 * geen kanaalpost-rij maar een tabel die er toevallig op lijkt — of een cel met een losse `|` erin;
 * dan half raden welke cel welk veld is, is erger dan de rij overslaan. Puur, zodat de vorm-eisen
 * getest kunnen worden zonder netwerk (zelfde patroon als `tracksFromListing`).
 *
 * De sha-kolom wordt niet overgenomen: hij draagt repo-namen en voegt op de plaat niets toe aan
 * de vraag "wat is klaar en wat moet er nog gebeuren".
 */
const KANAALPOST_PATH = 'CONTROL/KANAALPOST.md';
/**
 * Datum-tijd-cel: kale dagdatum, eventueel gevolgd door HH:MM (UTC) — en verder niets. Het
 * eind-anker en de uur-/minuutgrenzen zijn geen muggenzifterij: zonder anker matchte
 * `2026-07-25 /Users/iemand/geheim.md` gewoon, waarna de parser de rest van de cel weggooide en de
 * rij als geldig doorliet (review Codex + Gemini). Een cel met rommel erachter is geen datum, dus
 * valt de hele rij af.
 */
const KANAAL_DATUM = /^(\d{4}-\d{2}-\d{2})(?:\s+([01]?\d|2[0-3]):([0-5]\d))?$/;
/** Een tabnaam is een naam, geen zin en geen markup. */
const KANAAL_TAB = /^[A-Za-z0-9 ()._/-]{1,40}$/;
/**
 * Markdown-nadruk weghalen zodat de plaat gewone tekst toont. Bewust NIET `_`: dat zou
 * `SERVICE_TOKEN` tot `SERVICETOKEN` maken en daarmee juist het secret-naam-patroon blind maken.
 */
const kaal = (s) => String(s).replace(/[`*]+/g, '').replace(/\s+/g, ' ').trim();

/** Een kanaalpost-kop: eerste kolom `tab`, laatste kolom `datum…`. Alleen dán volgen er rijen. */
const KANAAL_KOP = (cellen) =>
  cellen[0].toLowerCase() === 'tab' && cellen[4].toLowerCase().startsWith('datum');

export function kanaalpostUitTekst(tekst) {
  const rijen = [];
  let kopGezien = false;
  for (const regel of String(tekst ?? '').split('\n')) {
    const r = regel.trim();
    if (!r.startsWith('|') || !r.endsWith('|')) continue;
    const cellen = r.slice(1, -1).split('|').map((c) => c.trim());
    if (cellen.length !== 5) continue;
    if (cellen.every((c) => /^:?-{3,}:?$/.test(c))) continue;      // scheidingsregel
    if (KANAAL_KOP(cellen)) { kopGezien = true; continue; }         // kopregel
    // Pas rijen aannemen ná een herkende kanaalpost-kop. Zonder die poort werd élke vijfkolomstabel
    // in het bestand als kanaalpost gelezen — een tabel met een andere kolomvolgorde schoof dan
    // interne velden naar `onderwerp`/`status` (review Codex, bewezen probe).
    if (!kopGezien) continue;
    const d = KANAAL_DATUM.exec(cellen[4]);
    if (!d || !isEchteDatum(d[1])) continue;
    const tab = kaal(cellen[0]);
    const onderwerp = kaal(cellen[1]);
    if (!KANAAL_TAB.test(tab) || !onderwerp) continue;
    rijen.push({
      tab,
      onderwerp,
      status: kaal(cellen[3]),
      // Een handgeschreven `9:05` telt mee maar wordt als `09:05` getoond: de kolom moet
      // uitlijnen, en een rij stil laten wegvallen op een ontbrekende nul is te streng (review Gemini).
      datum: d[2] ? `${d[1]} ${d[2].padStart(2, '0')}:${d[3]}` : d[1],
    });
  }
  return rijen;
}

/**
 * De kanaalpost staat op de rapporten-branch en is append-only: nieuwste onderaan. Fail-closed in
 * twee smaken, want ze vragen om een andere melding: de bron is niet te lezen (BRON_ONBEREIKBAAR)
 * of hij is leesbaar maar levert geen enkele herkende rij (LEEG — dan is de parser verdacht, niet
 * de vloot). De sectie staat hierom bewust niet in `sources`: een onbereikbaar doorgeefluik zet de
 * hele pagina niet op DEGRADED, hij toont zijn eigen melding.
 */
export async function collectKanaalpost() {
  const proof = `${repoUrl(CONTROL_REPO)}/blob/${RAPPORTEN_REF}/${KANAALPOST_PATH}`;
  const src = `${CONTROL_REPO} / kanaalpost`;
  const tekst = await fileFromRepo(CONTROL_REPO, KANAALPOST_PATH, RAPPORTEN_REF);
  if (tekst === null) {
    return {
      available: false, reason: 'BRON_ONBEREIKBAAR', rows: [],
      evidence: evidence(src, RAPPORTEN_REF, 'SOURCE_UNAVAILABLE', proof, 'Kanaalpost niet leesbaar.'),
    };
  }
  const rows = kanaalpostUitTekst(tekst);
  if (!rows.length) {
    return {
      available: false, reason: 'LEEG', rows: [],
      evidence: evidence(src, RAPPORTEN_REF, 'UNVERIFIED', proof, parserNote(0)),
    };
  }
  return {
    available: true, reason: null, rows,
    evidence: evidence(src, RAPPORTEN_REF, 'VERIFIED_CURRENT', proof, null),
  };
}

/** Journaal — alleen de kopregels van de laatste entries. */
export async function collectLogbook() {
  const proof = `${repoUrl(CONTROL_REPO)}/blob/main/CONTROL/FABLE-JOURNAAL.md`;
  const src = `${CONTROL_REPO} / journaal`;
  const text = await fileFromRepo(CONTROL_REPO, 'CONTROL/FABLE-JOURNAAL.md');
  if (!text) {
    return {
      available: false, entries: [],
      evidence: evidence(src, 'main', 'SOURCE_UNAVAILABLE', proof,
        'Journaal staat nog niet op main — het zit in een openstaande PR.'),
    };
  }
  const entries = [...text.matchAll(/^#{2,3}\s+(.{3,110})$/gm)].map((m) => ({ title: m[1].trim() })).slice(0, 6);
  const { trust, note } = trustWithAge(entries.length, await lastCommitDate(CONTROL_REPO, 'CONTROL/FABLE-JOURNAAL.md'));
  return {
    available: true, entries,
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
