/**
 * SANITIZE-GATE — de laatste grens tussen privé-canon en publieke output.
 *
 * Ontwerpregel: fail-closed. Een herkend patroon wordt geredigeerd én geteld; in strikte modus
 * breekt één treffer de publicatie af. Beter geen dashboard dan een dashboard dat iets prijsgeeft.
 *
 * EERLIJKE GRENS VAN DEZE MODULE (review Codex + Gemini, 23-07-2026): dit is
 * *fail-on-known-pattern*, geen semantisch begrip. Een klantnaam, contracttekst of intern
 * projectcodenaam matcht geen enkel patroon en zou hier gewoon doorheen gaan. Daarom is de
 * échte verdediging de veldenallowlist in collect.mjs plus de publieke DTO in build.mjs: wat
 * nooit wordt opgehaald of gekopieerd, kan niet lekken. Deze module is het vangnet eronder,
 * niet de muur zelf. Voor eigennamen die weg moeten: `data/deny-terms.json`.
 */

import { readFileSync } from 'node:fs';

/** Langere strings worden vóór regexverwerking afgekapt — ReDoS-plafond én lekplafond. */
const MAX_STRING = 2000;
const PLACEHOLDER = '[REDACTED]';
const TRUNCATED = '[REDACTED — te lang]';

/** Patronen die nooit in publieke output mogen belanden. Volgorde = toepassingsvolgorde. */
export const DENY_PATTERNS = [
  // Sleutel-/tokenwaarden van bekende providers en generieke vormen
  { id: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { id: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'google-key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'private-key-block', re: /-----BEGIN[A-Z ]*PRIVATE KEY-----/g },
  { id: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]{16,}/gi },
  // Credentials in een URL. Geen nesting: elk deel heeft zijn eigen, disjuncte tekenklasse.
  { id: 'url-credentials', re: /\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s/:@]{1,64}:[^\s/@]{1,64}@/gi },

  // Secret-NAMEN. Op een openbare pagina is de naam zelf al een aanwijzing.
  // Bewust identifier-vormig, zodat gewone prozawoorden ("wachtwoordrotatie", "credentials")
  // de build niet breken — die zeggen niets, een veldnaam wel.
  // Meerdere segmenten toegestaan: in ORG_PR_READ_TOKEN bestaat er geen \b vóór "READ".
  { id: 'secret-name', re: /\b[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*?[_-](?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PAT)\b/gi },
  { id: 'secret-name-camel', re: /\b[a-z][a-z0-9]*(?:Token|Secret|Password|Passwd|Credentials?|ApiKey|AccessKey|PrivateKey)\b/g },
  { id: 'secret-assignment', re: /\b(?:password|passwd|secret|token|apikey|api_key)\s*[:=]\s*\S{4,}/gi },

  // Gevoelige paden: home-, runner- en containerpaden, Windows-drives en UNC-shares.
  { id: 'home-path', re: /(?:\/Users\/|\/home\/|\/root\/|\/workspace\/|\/github\/workspace\/)[^\s"'`,;)\]]*/g },
  { id: 'windows-path', re: /(?:[A-Za-z]:\\|\\\\)[^\s"'`,;)\]]+/g },

  // Persoonsgegevens en netwerkadressen
  { id: 'email', re: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g },
  { id: 'ipv4', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  // Minimaal vier dubbele punten: een ISO-tijdstempel (`12:00:00`) haalt dat niet en blijft heel.
  { id: 'ipv6', re: /\b(?:[0-9A-Fa-f]{1,4}:){4,7}[0-9A-Fa-f]{1,4}\b/g },
];

/**
 * Hoog-entropische resten. Twee patronen: `/` scheidt padsegmenten (anders telt een lange
 * bewijs-URL als blob), en een tweede patroon vangt klassiek base64 mét `/` maar zonder `.`/`-`.
 */
const HIGH_ENTROPY = /\b[A-Za-z0-9+_-]{40,}={0,2}\b/g;
const BASE64_BLOB = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g;

/** Eigennamen die weg moeten en die geen patroon kan raden. Beheerd door mensen. */
let denyTerms = null;
export function loadDenyTerms(path) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    denyTerms = (Array.isArray(raw) ? raw : raw.terms ?? [])
      .filter((t) => typeof t === 'string' && t.trim().length >= 3)
      .map((t) => t.trim().toLowerCase());
  } catch {
    denyTerms = [];
  }
  return denyTerms.length;
}

/**
 * Lengte van de langste geladen deny-term. Nodig voor wie deze gate in stukken over een lange tekst
 * draait: elk ander patroon hier is begrensd, maar een deny-term is vrije mensentekst en kan dus
 * breder zijn dan de overlap tussen twee vensters.
 */
export function denyTermsMaxLen() {
  // Reduce in plaats van spread: een lijst van duizenden termen zou als argumentenlijst de stack
  // overlopen.
  return denyTerms?.length ? denyTerms.reduce((max, t) => (t.length > max ? t.length : max), 0) : 0;
}

/**
 * Redigeer één string. Geeft de gesaneerde tekst plus de gevonden patroon-id's terug.
 * De gevonden wáárden worden bewust niet teruggegeven — die willen we nergens loggen.
 */
export function sanitizeString(value, { path = '' } = {}) {
  if (typeof value !== 'string') return { value, findings: [] };

  const findings = [];
  let out = value;

  // ReDoS-plafond: begrens vóór er ook maar één regex over de string loopt. Bewust géén
  // prefix bewaren — een credential dat toevallig op de knip begint, zou anders half
  // overleven (review Gemini, 23-07-2026). Te lang = helemaal weg.
  if (out.length > MAX_STRING) {
    findings.push({ id: 'oversized', path });
    return { value: TRUNCATED, findings };
  }

  for (const { id, re } of DENY_PATTERNS) {
    re.lastIndex = 0;
    if (!re.test(out)) continue;
    re.lastIndex = 0;
    out = out.replace(re, PLACEHOLDER);
    findings.push({ id, path });
  }

  // Géén uitzondering meer voor een losstaande 40-hexwaarde. Die zag er als git-SHA
  // onschuldig uit, maar een legacy-token of session-ID heeft exact dezelfde vorm
  // (review Gemini, 23-07-2026). De publieke DTO draagt sinds de vorige ronde toch geen
  // SHA's meer, dus de uitzondering kostte alleen maar dekking.
  for (const re of [HIGH_ENTROPY, BASE64_BLOB]) {
    re.lastIndex = 0;
    if (!re.test(out)) continue;
    re.lastIndex = 0;
    const before = out;
    out = out.replace(re, PLACEHOLDER);
    if (out !== before) findings.push({ id: 'high-entropy', path });
  }

  if (denyTerms?.length) {
    const lower = out.toLowerCase();
    for (const term of denyTerms) {
      if (!lower.includes(term)) continue;
      out = out.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), PLACEHOLDER);
      findings.push({ id: 'deny-term', path });
    }
  }

  return { value: out, findings };
}

/**
 * Loop een JSON-structuur af en saneer elke string — waarden én sleutels. Een veldnaam als
 * `client_secret` is zelf al informatie, en het pad in een bevinding mag geen lek zijn.
 */
export function sanitizeTree(node, { path = '$' } = {}) {
  const findings = [];

  const walk = (n, p) => {
    if (typeof n === 'string') {
      const r = sanitizeString(n, { path: p });
      findings.push(...r.findings);
      return r.value;
    }
    if (Array.isArray(n)) return n.map((v, i) => walk(v, `${p}[${i}]`));
    if (n && typeof n === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(n)) {
        const sk = sanitizeString(k, { path: `${p}.<key>` });
        findings.push(...sk.findings);
        out[sk.value] = walk(v, `${p}.${sk.value}`);
      }
      return out;
    }
    return n;
  };

  return { value: walk(node, path), findings };
}

/**
 * Poort voor de publicatiepijplijn. Gooit in strikte modus bij elke bevinding.
 * De foutmelding noemt patroon-id en pad, nooit de aangetroffen waarde.
 */
export function assertPublishable(snapshot, { strict = true } = {}) {
  const { value, findings } = sanitizeTree(snapshot);
  if (strict && findings.length > 0) {
    const summary = findings.map((f) => `${f.id} @ ${f.path}`).join(', ');
    throw new Error(`SANITIZE-GATE geblokkeerd: ${findings.length} bevinding(en) — ${summary}`);
  }
  return { snapshot: value, findings };
}
