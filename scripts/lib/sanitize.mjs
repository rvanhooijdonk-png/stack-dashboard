/**
 * SANITIZE-GATE — de enige plek waar tekst uit privé-canon naar publieke output mag.
 *
 * Ontwerpregel: fail-closed. Een patroon dat we herkennen wordt geredigeerd én geteld;
 * bij een strikte build (STRICT=1) breekt een enkele treffer de publicatie af. Beter
 * geen dashboard dan een dashboard dat iets prijsgeeft.
 *
 * Wat hier NIET thuishoort: het besluit wát er getoond wordt. Dat is de veldenallowlist
 * in collect.mjs. Deze module is het laatste vangnet, niet het eerste.
 */

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
  { id: 'url-credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/gi },
  // Secret-NAMEN: zelfs de naam publiceren we niet op een openbare pagina
  { id: 'secret-name', re: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PAT)\b/g },
  // Gevoelige paden en persoonsgegevens
  { id: 'home-path', re: /(?:\/Users\/|\/home\/|C:\\Users\\)[^\s"'`,;)\]]+/g },
  { id: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { id: 'ipv4', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
];

/**
 * Waarden die na redactie nog steeds verdacht lang/hoog-entropisch zijn.
 *
 * Twee patronen in plaats van één, omdat een URL-pad anders als blob telt: bewijs-URL's naar
 * GitHub zijn lang en bestaan uit dezelfde tekens. Daarom wordt `/` hier als scheidingsteken
 * behandeld — elk padsegment wordt apart gewogen — en vangt een tweede patroon klassiek base64
 * (waarin `/` wél voorkomt maar `.` en `-` niet, zodat echte URL's er niet in vallen).
 */
const HIGH_ENTROPY = /\b[A-Za-z0-9+_-]{40,}={0,2}\b/g;
const BASE64_BLOB = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g;

const PLACEHOLDER = '[REDACTED]';

/**
 * Redigeer één string. Geeft de gesaneerde tekst plus de gevonden patroon-id's terug.
 * De gevonden wáárden worden bewust niet teruggegeven — die willen we nergens loggen.
 */
export function sanitizeString(value, { path = '' } = {}) {
  if (typeof value !== 'string') return { value, findings: [] };
  let out = value;
  const findings = [];

  for (const { id, re } of DENY_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(out)) {
      re.lastIndex = 0;
      out = out.replace(re, PLACEHOLDER);
      findings.push({ id, path });
    }
  }

  // Git-SHA's zijn hex en juist bewijsmateriaal — die sparen we.
  const keepSha = (m) => (/^[0-9a-f]{40}$/i.test(m) ? m : PLACEHOLDER);
  for (const re of [HIGH_ENTROPY, BASE64_BLOB]) {
    re.lastIndex = 0;
    if (!re.test(out)) continue;
    re.lastIndex = 0;
    const before = out;
    out = out.replace(re, keepSha);
    if (out !== before) findings.push({ id: 'high-entropy', path });
  }

  return { value: out, findings };
}

/** Loop een willekeurige JSON-structuur af en saneer elke string erin. */
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
      return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, walk(v, `${p}.${k}`)]));
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
