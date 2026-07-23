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
 *
 * Vierde review (Codex + Gemini, 23-07-2026): drie reproduceerbare false negatives. Ze hadden één
 * gemeenschappelijke oorzaak — de validator keek naar de *data* om te bepalen wat hij van het
 * *schema* moest controleren, en gebruikte `in` waar hij own-properties bedoelde. Een leeg array
 * betekende dus "schema in orde", en een veld met de naam `toString` gold als bekend. Sindsdien
 * wordt het schema één keer in zijn geheel gekeurd, los van de instance.
 */

const KNOWN = new Set([
  '$schema', '$id', '$defs', '$ref', 'title', 'description', 'examples', 'format',
  'type', 'required', 'properties', 'additionalProperties', 'items', 'enum', 'minimum', 'const', 'pattern',
]);

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const isPlainObject = (v) => typeOf(v) === 'object';
const has = (o, k) => isPlainObject(o) && Object.hasOwn(o, k);

/**
 * Lost `$ref` op. Ketens worden helemaal doorgelopen — een `$def` die zelf naar een `$def`
 * verwijst hield de vorige versie na één stap voor gezien, waarna de rest van dat schema
 * stilzwijgend verviel. Broertjes van de `$ref` overrulen het doelschema, maar `properties`
 * worden samengevoegd in plaats van overschreven: anders verdwijnen de geërfde velden en worden
 * ze even later als "onbekend veld" afgekeurd.
 */
function resolve(schema, root, seen = new Set()) {
  if (!has(schema, '$ref')) return schema;
  if (seen.has(schema.$ref)) throw new Error(`kringverwijzing in $ref: ${schema.$ref}`);
  const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
  if (!m || !has(root.$defs, m[1])) throw new Error(`onbekende $ref: ${schema.$ref}`);

  const target = resolve(root.$defs[m[1]], root, new Set([...seen, schema.$ref]));
  const local = Object.fromEntries(Object.entries(schema).filter(([k]) => k !== '$ref'));
  const merged = { ...target, ...local };
  if (has(target, 'properties') || has(local, 'properties')) {
    merged.properties = { ...target.properties, ...local.properties };
  }
  return merged;
}

/**
 * Loopt het schema zélf één keer volledig door: elk trefwoord, elke `properties`-tak, elke
 * `items`-tak en elke `$defs`-definitie — ook die waar de instance toevallig geen data voor
 * heeft. Een gate die pas afgaat als er data langskomt, is geen gate.
 */
export function auditSchema(schema, { root = schema, path = '', seen = new Set() } = {}) {
  if (!isPlainObject(schema) || seen.has(schema)) return [];
  seen.add(schema);
  const errors = [];
  const here = path || '/';

  for (const key of Object.keys(schema)) {
    if (!KNOWN.has(key)) errors.push(`${here}: schema gebruikt niet-ondersteund trefwoord "${key}"`);
  }
  if (has(schema, '$ref')) {
    try {
      resolve(schema, root);
    } catch (err) {
      errors.push(`${here}: ${err.message}`);
    }
  }
  for (const [key, sub] of Object.entries(schema.$defs ?? {})) {
    errors.push(...auditSchema(sub, { root, path: `${path}/$defs/${key}`, seen }));
  }
  for (const [key, sub] of Object.entries(schema.properties ?? {})) {
    errors.push(...auditSchema(sub, { root, path: `${path}/${key}`, seen }));
  }
  if (has(schema, 'items')) errors.push(...auditSchema(schema.items, { root, path: `${path}/*`, seen }));
  return errors;
}

export function validate(schema, value, { root = schema, path = '' } = {}) {
  // Bij de buitenste aanroep wordt eerst het hele schema gekeurd, niet gaandeweg per datatak.
  const errors = path === '' ? auditSchema(schema, { root }) : [];
  // Een kapotte $ref is door de audit al gemeld; hier stoppen we met die tak in plaats van de
  // hele aanroep te laten klappen — de aanroeper krijgt een foutenlijst, geen exception.
  let s;
  try {
    s = resolve(schema, root);
  } catch (err) {
    return path === '' ? errors : [`${path}: ${err.message}`];
  }

  if (has(s, 'type')) {
    const allowed = Array.isArray(s.type) ? s.type : [s.type];
    const actual = typeOf(value);
    const ok = allowed.includes(actual) || (allowed.includes('integer') && Number.isInteger(value));
    if (!ok) return [...errors, `${path || '/'}: verwacht ${allowed.join('|')}, kreeg ${actual}`];
  }

  if (has(s, 'enum') && !s.enum.includes(value)) errors.push(`${path || '/'}: "${value}" staat niet in de enum`);
  if (has(s, 'const') && value !== s.const) errors.push(`${path || '/'}: verwacht ${s.const}`);
  if (typeof s.minimum === 'number' && typeof value === 'number' && value < s.minimum) {
    errors.push(`${path || '/'}: ${value} < minimum ${s.minimum}`);
  }
  if (has(s, 'pattern') && typeof value === 'string' && !new RegExp(s.pattern).test(value)) {
    errors.push(`${path || '/'}: voldoet niet aan patroon ${s.pattern}`);
  }

  if (isPlainObject(value)) {
    for (const key of s.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}/${key}: verplicht veld ontbreekt`);
    }
    if (s.additionalProperties === false) {
      const props = s.properties ?? {};
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(props, key)) errors.push(`${path}/${key}: onbekend veld (additionalProperties: false)`);
      }
    }
    for (const [key, sub] of Object.entries(s.properties ?? {})) {
      if (Object.hasOwn(value, key)) errors.push(...validate(sub, value[key], { root, path: `${path}/${key}` }));
    }
  }

  if (typeOf(value) === 'array' && has(s, 'items')) {
    value.forEach((item, i) => errors.push(...validate(s.items, item, { root, path: `${path}/${i}` })));
  }

  return errors;
}
