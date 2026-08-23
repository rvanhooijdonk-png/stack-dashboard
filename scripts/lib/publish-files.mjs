import { readdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export const PUBLISH_ALLOWLIST = Object.freeze([
  '.nojekyll',
  'code-ticker.html',
  'contentstroom.html',
  'index.html',
  'producten.html',
  'stack-ticker.html',
  'status.json',
  'transacties.html',
]);

/**
 * Vlak gekopieerd naar de publicatiemap wanneer build.mjs met --client-poll-origin draait —
 * relatieve imports (`./format.mjs` e.d.) blijven zo kloppen zonder herschrijven. Zelfde
 * brontekst als de Node-build gebruikt, geen tweede parser. Eén bron hier zodat build.mjs en
 * check-public.mjs dezelfde lijst hanteren — anders keurt de publicatiepoort een geldige
 * opt-in build af.
 *
 * DEZE LIJST MOET DE HELE IMPORTBOOM DEKKEN. De browser laadt `runtime-poll.mjs` als module en
 * volgt zijn `import`-regels zelf; ontbreekt één bestand, dan is dat geen degradatie maar een 404
 * midden in de modulegraaf en laadt de polling helemaal niet — zichtbaar als een pagina die stil
 * blijft staan, niet als een foutmelding. `test/publish-files.test.mjs` loopt de graaf daarom
 * statisch na en faalt zodra een nieuwe import buiten deze lijst valt.
 */
export const CLIENT_POLL_FILES = Object.freeze([
  'format.mjs', 'validate.mjs', 'sanitize.mjs', 'runtime-feed.mjs',
  'runtime-feed-input.mjs', 'runtime-feed-view.mjs',
  'panel-contracts.mjs', 'paneel-nu-bezig.mjs', 'runtime-poll.mjs',
]);

/** Een buildoutput blijft altijd onder de repositoryroot; de build verwijdert deze map eerst. */
export function outputDirectory(root, requested = 'public') {
  if (typeof requested !== 'string' || requested.length === 0) throw new Error('ongeldige publicatiemap');
  const directory = resolve(root, requested);
  const prefix = `${resolve(root)}${sep}`;
  if (!directory.startsWith(prefix) || directory === resolve(root)) {
    throw new Error('publicatiemap moet een submap van de repository zijn');
  }
  return directory;
}

/**
 * Exact de allowlist, geen submappen, symlinks of extra artefacten. `extra` is uitsluitend bedoeld
 * voor de opt-in --client-poll-origin buildvlag (build.mjs): de standaard-/productie-/CI-aanroep
 * (geen tweede argument) blijft strikt op de zes vaste bestanden — deze optie verruimt niets
 * stilzwijgend, hij moet expliciet worden meegegeven.
 */
export async function assertPublishFiles(directory, { extra = [] } = {}) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) throw new Error('publicatiemap bevat geen gewoon bestand');
  const actual = entries.map((entry) => entry.name).sort();
  const expected = [...PUBLISH_ALLOWLIST, ...extra].sort();
  if (actual.join('\n') !== expected.join('\n')) {
    throw new Error(`publicatiemap wijkt af van allowlist: ${actual.join(', ')}`);
  }
  return actual;
}
