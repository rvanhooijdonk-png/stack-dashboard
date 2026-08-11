/** Publiek productmodel: gesloten canon + uitsluitend afgeleide operationele feiten. */
export const PRODUCT_PHASES = ['UNKNOWN', 'GEPLAND', 'IN_UITVOERING', 'IN_REVIEW', 'WACHT_OP_RICHARD', 'GELEVERD'];
export const FRESHNESS = ['UNKNOWN', 'CURRENT', 'STALE'];
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_LABEL_RE = /^[A-Za-zÀ-ÿ0-9 &/().,+:'-]+$/;

const assertLabel = (value, where) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 80 || !SAFE_LABEL_RE.test(value)) {
    throw new Error(`productcanon: ongeldig label bij ${where}`);
  }
};

export function validateProductCanon(canon) {
  if (!canon || canon.version !== '1.0.0' || !Array.isArray(canon.products)) throw new Error('productcanon: ongeldige root');
  const ids = new Set();
  const names = new Set();
  for (const [pi, p] of canon.products.entries()) {
    if (!p || Object.keys(p).sort().join(',') !== 'features,id,name') throw new Error(`productcanon: onbekende velden bij product ${pi + 1}`);
    if (!ID_RE.test(p.id) || ids.has(p.id)) throw new Error(`productcanon: ongeldig of dubbel product-id bij regel ${pi + 1}`);
    assertLabel(p.name, `product ${pi + 1}`);
    if (names.has(p.name.toLowerCase())) throw new Error(`productcanon: dubbele productnaam bij regel ${pi + 1}`);
    if (!Array.isArray(p.features) || p.features.length === 0) throw new Error(`productcanon: features ontbreken bij product ${pi + 1}`);
    const features = new Set();
    for (const [fi, f] of p.features.entries()) {
      assertLabel(f, `product ${pi + 1}, feature ${fi + 1}`);
      if (features.has(f.toLowerCase())) throw new Error(`productcanon: dubbele feature bij product ${pi + 1}`);
      features.add(f.toLowerCase());
    }
    ids.add(p.id); names.add(p.name.toLowerCase());
  }
  return canon;
}

const STATUS = {
  gepland: 'GEPLAND', 'in-bouw': 'IN_UITVOERING', 'in-review': 'IN_REVIEW',
  'wacht-op-Richard': 'WACHT_OP_RICHARD', live: 'GELEVERD',
};

function freshness(snapshot) {
  if (!snapshot?.planning?.available || !snapshot.planning.bron?.spiegelAt) return 'UNKNOWN';
  const age = Date.parse(snapshot.generatedAt) - Date.parse(snapshot.planning.bron.spiegelAt);
  return Number.isFinite(age) && age >= 0 && age <= 24 * 60 * 60 * 1000 ? 'CURRENT' : 'STALE';
}

export function buildProductModel(canonInput, snapshot) {
  const canon = validateProductCanon(canonInput);
  const planningFreshness = freshness(snapshot);
  const planning = snapshot?.planning?.available ? snapshot.planning.features : [];
  return {
    version: canon.version,
    generatedAt: snapshot.generatedAt,
    products: canon.products.map((p) => {
      const dynamic = p.id === 'cockpit' ? planning : [];
      const canonical = p.features.map((name) => ({
        name, phase: 'UNKNOWN', done: null, now: null, next: null, blocker: null,
        freshness: 'UNKNOWN', evidence: 'Geen gevalideerd featurebewijs beschikbaar',
      }));
      const observed = dynamic.map((f) => ({
        name: f.label, phase: STATUS[f.status] ?? 'UNKNOWN',
        done: f.status === 'live' ? 'Oplevering staat als geleverd geregistreerd' : null,
        now: ['in-bouw', 'in-review'].includes(f.status) ? 'Werk is volgens de planning actief' : null,
        next: f.oplevering?.date ? `Volgende plandatum: ${f.oplevering.date}` : null,
        blocker: f.afhankelijkheid ?? null, freshness: planningFreshness,
        evidence: planningFreshness === 'CURRENT' ? 'Gevalideerde publieke planningsspiegel' : 'Planningsspiegel is onbekend of verouderd',
      }));
      const seen = new Set();
      const features = [...observed, ...canonical].filter((f) => !seen.has(f.name.toLowerCase()) && seen.add(f.name.toLowerCase()));
      const known = features.filter((f) => f.phase !== 'UNKNOWN').length;
      const delivered = features.filter((f) => f.phase === 'GELEVERD').length;
      return { id: p.id, name: p.name, denominator: features.length, known, delivered, features };
    }),
  };
}

export function lifecycleEvents(snapshot) {
  if (!snapshot?.kanaalpost?.available) return { freshness: 'UNKNOWN', events: [] };
  const mapping = { AFGEROND: 'GELEVERD', 'IN BOUW': 'GESTART', 'WACHT OP AKKOORD': 'GEBLOKKEERD' };
  const events = snapshot.kanaalpost.rows.map((r, i) => ({
    id: `event-${i + 1}`, at: r.datum, product: r.tab, lifecycle: mapping[r.status] ?? 'UNKNOWN', summary: r.onderwerp,
  }));
  const newest = events[0]?.at ? Date.parse(events[0].at.replace(' ', 'T') + ':00Z') : NaN;
  const age = Date.parse(snapshot.generatedAt) - newest;
  return { freshness: Number.isFinite(age) && age >= 0 && age <= 24 * 60 * 60 * 1000 ? 'CURRENT' : 'STALE', events };
}
