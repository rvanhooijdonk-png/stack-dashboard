import { readdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export const PUBLISH_ALLOWLIST = Object.freeze([
  '.nojekyll',
  'contentstroom.html',
  'index.html',
  'producten.html',
  'stack-ticker.html',
  'status.json',
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

/** Exact zes gewone bestanden, geen submappen, symlinks of extra artefacten. */
export async function assertPublishFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) throw new Error('publicatiemap bevat geen gewoon bestand');
  const actual = entries.map((entry) => entry.name).sort();
  if (actual.join('\n') !== PUBLISH_ALLOWLIST.join('\n')) {
    throw new Error(`publicatiemap wijkt af van allowlist: ${actual.join(', ')}`);
  }
  return actual;
}
