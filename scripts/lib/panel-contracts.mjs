/**
 * PANEELCONTRACT — vaste, benoemde paneelslots in de cockpit-shell
 * (DASHBOARD_SKELET_PANEELCONTRACT_20260819). Elke slot is hier statisch vastgelegd: welke
 * bron hem ooit voedt, wat de noemer is, en dat hij UNKNOWN toont zolang die bron ontbreekt.
 * Vandaag is geen van deze slots aan een echte bron gekoppeld (provider-/queue-actie is voor
 * deze opdracht verboden) — het contract staat vast, de koppeling volgt later. Dit is skelet,
 * geen tweede dashboard: de renderer, teststack en tickerdrager blijven ongewijzigd.
 */
import { esc } from './format.mjs';

export const PANEL_CONTRACTS = Object.freeze([
  Object.freeze({
    slot: 'b',
    id: 'paneel-richard-queue',
    title: 'RICHARD-QUEUE',
    inputSource: 'de drie ownerbronnen achter de sectie "Wacht op Richard" (pull-requests, planning, kanaalpost-spiegel) — hoeveel ownerpoorten bij deze bouw bewezen open stonden en hoeveel bronnen daarbij niets konden meten',
    denominatorLabel: 'aantal openstaande queue-items',
  }),
  Object.freeze({
    slot: 'k',
    id: 'paneel-nu-bezig',
    title: 'NU-BEZIG',
    inputSource: 'runtimefeed van actief werkende actoren — de telling achter de sectie "Nu actief": hoeveel taakregels de meting noemde en hoeveel daarvan volledig bewijs droegen',
    denominatorLabel: 'aantal actief-bezig-regels',
  }),
  Object.freeze({
    slot: 'statusgen',
    id: 'paneel-statusgen',
    title: 'STATUSGEN',
    inputSource: 'generatie-/buildmetadata van de statuslaag zelf — contractversie, bouwstempel, overall-status en het aantal niet-geverifieerde bronnen',
    denominatorLabel: 'aantal bronnen dat de statuslaag bij deze bouw heeft gelezen',
  }),
]);

/**
 * Eén paneelslot. `measuredAt` is vandaag altijd null (geen bron gekoppeld) — het argument
 * bestaat zodat een latere koppeling deze functie kan hergebruiken zonder de contractvorm te
 * wijzigen. Fragment is zelfstandig gesaneerd: alleen `esc()`-output, geen rauwe brontekst.
 */
export function renderPanelSlot(contract, options) {
  // `null` of een niet-object mag hier nooit klappen: een latere vuller die per ongeluk
  // `renderPanelSlot(contract, null)` aanroept hoort UNKNOWN te krijgen, geen TypeError.
  const opts = (options && typeof options === 'object') ? options : {};
  const { measuredAt = null, body = null, badge = 'warn', statusLabel = 'UNKNOWN' } = opts;
  const stamp = measuredAt ? esc(measuredAt) : '<span class="unknown">UNKNOWN</span>';
  // Een vuller levert een `body`; zolang die ontbreekt blijft het slot exact het lege skelet.
  // `body` is al door de vuller gesaneerd (alleen `esc()`-output) — het is bewust het enige
  // fragment dat hier niet nog eens door `esc()` gaat, anders zou de opmaak zichtbaar worden.
  const inhoud = typeof body === 'string' && body !== ''
    ? body
    : '<p class="unknown">UNKNOWN — bron nog niet gekoppeld.</p>';
  return `<section id="${esc(contract.id)}" class="card" data-panel-slot="${esc(contract.slot)}">
  <h2>${esc(contract.title)} <span class="badge ${esc(badge)}">${esc(statusLabel)}</span></h2>
  ${inhoud}
  <p class="muted">Contract: ${esc(contract.inputSource)}.</p>
  <p class="muted">Noemer: ${esc(contract.denominatorLabel)}.</p>
  <p class="muted">Gemeten om: ${stamp}.</p>
</section>`;
}

/**
 * Rendert alle slots op volgorde van het contract. `vullingen` is een map van slot-key naar de
 * opties van die slot; een slot zonder vulling blijft het lege UNKNOWN-skelet. Onbekende sleutels
 * in `vullingen` worden genegeerd: het contract bepaalt welke slots bestaan, niet de vuller.
 */
export function renderPanelSlots(vullingen) {
  const map = (vullingen && typeof vullingen === 'object') ? vullingen : {};
  return PANEL_CONTRACTS.map((contract) => renderPanelSlot(contract, map[contract.slot])).join('\n');
}
