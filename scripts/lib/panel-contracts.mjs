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
    inputSource: 'openstaande Richard-acties (queue-achtige samenvatting van ownergates/kanaalpost — bron nog niet gekoppeld aan deze slot)',
    denominatorLabel: 'aantal openstaande queue-items',
  }),
  Object.freeze({
    slot: 'k',
    id: 'paneel-nu-bezig',
    title: 'NU-BEZIG',
    inputSource: 'runtimefeed van actief werkende actoren (bron nog niet gekoppeld aan deze slot)',
    denominatorLabel: 'aantal actief-bezig-regels',
  }),
  Object.freeze({
    slot: 'statusgen',
    id: 'paneel-statusgen',
    title: 'STATUSGEN',
    inputSource: 'generatie-/buildmetadata van de statuslaag (bron nog niet gekoppeld aan deze slot)',
    denominatorLabel: 'n.v.t. — dit paneel toont alleen een generatiestempel',
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
  const { measuredAt = null } = (options && typeof options === 'object') ? options : {};
  const stamp = measuredAt ? esc(measuredAt) : '<span class="unknown">UNKNOWN</span>';
  return `<section id="${esc(contract.id)}" class="card" data-panel-slot="${esc(contract.slot)}">
  <h2>${esc(contract.title)} <span class="badge warn">UNKNOWN</span></h2>
  <p class="unknown">UNKNOWN — bron nog niet gekoppeld.</p>
  <p class="muted">Contract: ${esc(contract.inputSource)}.</p>
  <p class="muted">Noemer: ${esc(contract.denominatorLabel)}.</p>
  <p class="muted">Gemeten om: ${stamp}.</p>
</section>`;
}

export function renderPanelSlots() {
  return PANEL_CONTRACTS.map((contract) => renderPanelSlot(contract)).join('\n');
}
