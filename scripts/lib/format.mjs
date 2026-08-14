/**
 * FORMAT — pure, dependency-free string/number helpers. Geen fs, geen network, geen DOM.
 * Bewust gescheiden van render.mjs zodat browsercode (runtime-poll.mjs) deze kan hergebruiken
 * zonder de volledige STYLE-string en overige renderlogica mee te laden.
 */

/** HTML-escape. Alles wat uit een bron komt gaat hier doorheen, zonder uitzondering. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Getallen worden als getal geïnterpoleerd, niet als string. Een "aantal" dat stiekem een
 * string met HTML erin is, werd anders rauw in de pagina gezet — review Codex, bewezen probe.
 */
export function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.trunc(n)) : '—';
}

/** Vaste lijst-omhulling: leeg = de gegeven boodschap, anders een `.lights`-lijst. */
export function list(items, empty) {
  return items.length ? `<ul class="lights">${items.join('')}</ul>` : `<p class="empty">${esc(empty)}</p>`;
}
