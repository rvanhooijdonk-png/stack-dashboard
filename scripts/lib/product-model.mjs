/** Publiek productmodel: gesloten canon, zonder afgeleide of verzonnen productstatus. */
export const PRODUCT_PHASES = ['UNKNOWN', 'GEPLAND', 'IN_UITVOERING', 'IN_REVIEW', 'WACHT_OP_RICHARD', 'GELEVERD'];
export const FRESHNESS = ['UNKNOWN', 'CURRENT', 'STALE'];
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_LABEL_RE = /^[A-Za-zÀ-ÿ0-9 &/().,+:'-]+$/;
const CANON_KEYS = ['products', 'version'];
const PRODUCT_KEYS = ['features', 'id', 'name'];

const exactKeys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === expected.join(',');

const assertLabel = (value, where) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 80 || !SAFE_LABEL_RE.test(value)) {
    throw new Error(`productcanon: ongeldig label bij ${where}`);
  }
};

/** Stabiele identiteit binnen een product; leestekens en accenten mogen geen dubbel feit maken. */
export function featureId(label) {
  return String(label).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function validateProductCanon(canon) {
  if (!exactKeys(canon, CANON_KEYS) || canon.version !== '1.0.0' || !Array.isArray(canon.products)) {
    throw new Error('productcanon: ongeldige root');
  }
  const ids = new Set();
  const names = new Set();
  for (const [pi, p] of canon.products.entries()) {
    if (!exactKeys(p, PRODUCT_KEYS)) throw new Error(`productcanon: onbekende velden bij product ${pi + 1}`);
    if (!ID_RE.test(p.id) || ids.has(p.id)) throw new Error(`productcanon: ongeldig of dubbel product-id bij regel ${pi + 1}`);
    assertLabel(p.name, `product ${pi + 1}`);
    if (names.has(p.name.toLowerCase())) throw new Error(`productcanon: dubbele productnaam bij regel ${pi + 1}`);
    if (!Array.isArray(p.features) || p.features.length === 0) throw new Error(`productcanon: features ontbreken bij product ${pi + 1}`);
    const featureIds = new Set();
    for (const [fi, name] of p.features.entries()) {
      assertLabel(name, `product ${pi + 1}, feature ${fi + 1}`);
      const id = featureId(name);
      if (!id || featureIds.has(id)) throw new Error(`productcanon: dubbele feature-identiteit bij product ${pi + 1}`);
      featureIds.add(id);
    }
    ids.add(p.id);
    names.add(p.name.toLowerCase());
  }
  return canon;
}

/**
 * Er bestaat nog geen gevalideerde koppeling van operationele planningregels naar canonieke
 * productfeatures. Daarom blijven alle featurefeiten expliciet UNKNOWN. Losse planninglabels aan
 * de canon plakken vergrootte eerder de noemer en maakte van één feature twee feiten.
 */
export function buildProductModel(canonInput, snapshot) {
  const canon = validateProductCanon(canonInput);
  return {
    version: canon.version,
    generatedAt: snapshot?.generatedAt ?? null,
    products: canon.products.map((p) => ({
      id: p.id,
      name: p.name,
      denominator: p.features.length,
      known: 0,
      delivered: 0,
      freshness: 'UNKNOWN',
      features: p.features.map((name) => ({
        id: featureId(name),
        name,
        phase: 'UNKNOWN',
        done: null,
        now: null,
        next: null,
        blocker: null,
        freshness: 'UNKNOWN',
        evidence: 'Geen gevalideerde koppeling met een featurebron beschikbaar',
      })),
    })),
  };
}

const EVENT_STATUS = {
  AFGEROND: 'GELEVERD',
  'IN BOUW': 'GESTART',
  'WACHT OP AKKOORD': 'WACHT_OP_BESLUIT',
  GEBLOKKEERD: 'GEBLOKKEERD',
};

function eventTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?: ([01]\d|2[0-3]):([0-5]\d))?$/.exec(String(value ?? ''));
  if (!match) return null;
  const [, y, m, d, h = '00', min = '00'] = match;
  const timestamp = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(h), Number(min));
  const check = new Date(timestamp);
  if (check.getUTCFullYear() !== Number(y) || check.getUTCMonth() !== Number(m) - 1
      || check.getUTCDate() !== Number(d)) return null;
  return timestamp;
}

export function lifecycleEvents(snapshot) {
  if (!snapshot?.kanaalpost?.available || !Array.isArray(snapshot.kanaalpost.rows)) {
    return { freshness: 'UNKNOWN', events: [] };
  }
  const seen = new Set();
  const events = snapshot.kanaalpost.rows.flatMap((row) => {
    const timestamp = eventTime(row?.datum);
    const lifecycle = EVENT_STATUS[row?.status];
    if (timestamp === null || !lifecycle || typeof row?.tab !== 'string' || typeof row?.onderwerp !== 'string') return [];
    const identity = [row.datum, row.tab.trim().toLowerCase(), lifecycle, row.onderwerp.trim().toLowerCase()].join('|');
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{ id: `event-${eventsId(identity)}`, at: row.datum, product: row.tab, lifecycle, summary: row.onderwerp, _timestamp: timestamp }];
  }).sort((a, b) => b._timestamp - a._timestamp);
  const newest = events[0]?._timestamp;
  const age = Number.isFinite(newest) ? Date.parse(snapshot.generatedAt) - newest : NaN;
  const freshness = !Number.isFinite(age) || age < 0 ? 'UNKNOWN'
    : age <= 24 * 60 * 60 * 1000 ? 'CURRENT' : 'STALE';
  return { freshness, events: events.map(({ _timestamp, ...event }) => event) };
}

/** Niet-cryptografische, deterministische DOM-identiteit; de inhoud is al publieke DTO-tekst. */
function eventsId(value) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
