/**
 * OWNERBRONNEN — de gesloten lijst bronnen waaruit een ownerpoort kan komen, en niets anders.
 *
 * Waarom een eigen module: `ownerGates()` (render-cockpit.mjs) MELDT per bron of hij kon meten, en
 * het RICHARD-QUEUE-paneel TELT die meldingen. Zolang die melding een kale tekstregel was, droeg ze
 * geen bronidentiteit — en dan is "hoeveel bronnen konden niets meten" niet te tellen maar te
 * raden: twee diagnoses van één bron zien er in een `string[]` precies zo uit als twee zwijgende
 * bronnen (bevinding Codex, ronde 1 op dit paneel). Met deze enum is dat verschil hard: elke
 * melding draagt een `source` uit deze lijst, en de teller telt UNIEKE bronnen.
 *
 * De lijst staat hier en niet in een van beide modules omdat ze van beide kanten gelezen wordt en
 * de afhankelijkheid maar één kant op mag lopen (render-cockpit importeert het paneel, niet
 * andersom).
 */
export const OWNER_SOURCES = Object.freeze(['pull-requests', 'planning', 'kanaalpost']);

/** Hoeveel ownerbronnen er zijn — de noemer van elke "x van y kon niets meten"-melding. */
export const OWNER_SOURCE_COUNT = OWNER_SOURCES.length;

/**
 * Is dit een geldige bronstatus? Vorm: `{source, message}`, met een bron uit de gesloten lijst en
 * een tekstuele melding. Alles daarbuiten is contractbreuk en wordt door de lezer als zodanig
 * behandeld — nooit stilzwijgend afgekapt of meegeteld.
 */
export const isBronstatus = (status) => !!status
  && typeof status === 'object'
  && OWNER_SOURCES.includes(status.source)
  && typeof status.message === 'string'
  && status.message.trim() !== '';
