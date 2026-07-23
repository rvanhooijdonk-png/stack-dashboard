/**
 * Een kleine JSON-Schema-validator — precies de constructies die onze eigen contracten gebruiken,
 * en niets meer. Reden voor eigen code in plaats van een bibliotheek: deze repo heeft nul
 * afhankelijkheden, en een validator die alleen in CI draait mag geen supply-chain-oppervlak
 * toevoegen aan een pagina die openbaar staat.
 *
 * Ondersteund: $ref naar `#/$defs/*`, type (incl. lijstvorm en `null`), required,
 * additionalProperties: false, properties, items, enum, minimum, const, pattern.
 * `format` wordt gelezen maar niet afgedwongen — het is in JSON Schema zelf een annotatie.
 * Niet ondersteund: alles daarbuiten — een onbekend trefwoord is een fout, geen stilte.
 *
 *   validate(schema, value) -> string[]   (leeg = geldig)
 */

const KNOWN = new Set([
  '$schema', '$id', '$defs', '$ref', 'title', 'description', 'examples', 'format',
  'type', 'required', 'properties', 'additionalProperties', 'items', 'enum', 'minimum', 'const', 'pattern',
]);

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function resolve(schema, root) {
  if (!schema.$ref) return schema;
  const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
  if (!m || !root.$defs?.[m[1]]) throw new Error(`onbekende $ref: ${schema.$ref}`);
  return { ...root.$defs[m[1]], ...Object.fromEntries(Object.entries(schema).filter(([k]) => k !== '$ref')) };
}

export function validate(schema, value, { root = schema, path = '' } = {}) {
  const errors = [];
  const s = resolve(schema, root);

  for (const key of Object.keys(s)) {
    if (!KNOWN.has(key)) errors.push(`${path || '/'}: schema gebruikt niet-ondersteund trefwoord "${key}"`);
  }

  if (s.type) {
    const allowed = Array.isArray(s.type) ? s.type : [s.type];
    const actual = typeOf(value);
    const ok = allowed.includes(actual) || (allowed.includes('integer') && Number.isInteger(value));
    if (!ok) return [...errors, `${path || '/'}: verwacht ${allowed.join('|')}, kreeg ${actual}`];
  }

  if (s.enum && !s.enum.includes(value)) errors.push(`${path || '/'}: "${value}" staat niet in de enum`);
  if ('const' in s && value !== s.const) errors.push(`${path || '/'}: verwacht ${s.const}`);
  if (typeof s.minimum === 'number' && typeof value === 'number' && value < s.minimum) {
    errors.push(`${path || '/'}: ${value} < minimum ${s.minimum}`);
  }
  if (s.pattern && typeof value === 'string' && !new RegExp(s.pattern).test(value)) {
    errors.push(`${path || '/'}: voldoet niet aan patroon ${s.pattern}`);
  }

  if (typeOf(value) === 'object') {
    for (const key of s.required ?? []) {
      if (!(key in value)) errors.push(`${path}/${key}: verplicht veld ontbreekt`);
    }
    if (s.additionalProperties === false && s.properties) {
      for (const key of Object.keys(value)) {
        if (!(key in s.properties)) errors.push(`${path}/${key}: onbekend veld (additionalProperties: false)`);
      }
    }
    for (const [key, sub] of Object.entries(s.properties ?? {})) {
      if (key in value) errors.push(...validate(sub, value[key], { root, path: `${path}/${key}` }));
    }
  }

  if (typeOf(value) === 'array' && s.items) {
    value.forEach((item, i) => errors.push(...validate(s.items, item, { root, path: `${path}/${i}` })));
  }

  return errors;
}
