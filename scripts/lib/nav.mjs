/**
 * NAV — de tabbladbalk die de statische pagina's aan elkaar knoopt. Geen JavaScript: het zijn
 * gewone <a>-links naar andere statische bestanden in dezelfde publicatiemap. Elke tab die hier
 * staat MOET ook een bestand op de PUBLISH_ALLOWLIST hebben, anders wijst de link naar niets.
 *
 * Uitbreiden = één regel in TABS erbij. De volgorde hier is de volgorde op de pagina.
 */
const TABS = [
  { key: 'status', href: 'index.html', label: 'Status', hint: 'de live stand' },
  { key: 'overzicht', href: 'overzicht.html', label: 'Overzicht', hint: 'hoe de stack in elkaar zit' },
  { key: 'regels', href: 'regels.html', label: 'Regels', hint: 'de wetten van de stack' },
];

/** Stijl voor de tabbalk. Gedeeld door alle pagina's zodat de balk overal identiek is. */
export const NAV_STYLE = `
.tabs{display:flex;flex-wrap:wrap;gap:4px;margin:0 0 20px;border-bottom:1px solid var(--line)}
.tabs a{text-decoration:none;color:var(--mut);padding:8px 14px;border-radius:8px 8px 0 0;font-weight:600;font-size:14px;border:1px solid transparent;border-bottom:none;position:relative;top:1px}
.tabs a small{display:block;font-weight:400;font-size:11.5px;color:var(--mut);opacity:.8}
.tabs a[aria-current="page"]{color:var(--fg);background:var(--card);border-color:var(--line)}
.tabs a:not([aria-current]):hover{color:var(--fg)}
`;

/**
 * Bouw de tabbalk. `active` is de key van de huidige pagina; die tab krijgt aria-current maar
 * houdt bewust zijn eigen href (een klik op de actieve tab herlaadt de pagina). Labels zijn vaste,
 * hier vastgelegde teksten — geen brondata, dus geen escaping nodig (er komt niets van buiten binnen).
 */
export function tabNav(active) {
  const items = TABS.map((t) => {
    const current = t.key === active;
    const attrs = current ? ' aria-current="page"' : '';
    return `<a href="${t.href}"${attrs}>${t.label}<small>${t.hint}</small></a>`;
  }).join('');
  return `<nav class="tabs" aria-label="Pagina's">${items}</nav>`;
}
