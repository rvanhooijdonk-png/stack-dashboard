#!/usr/bin/env node
// Orchestreert het herhaal-besluit voor de doorstroom-alarmstap (order ALARM-DAT-ELKE-RUN-MAILT).
// Leest het oordeel (evt. ontbrekend = uitvoerder gefaald) en de body+comments van een eventueel
// al open alarm-issue, en schrijft één JSON-besluit naar stdout: { code, mag, reden }.
//
// Argumenten (de eerste drie verplicht, lege string toegestaan voor issue-pad/infra-oorzaak):
//   1. pad naar /tmp/oordeel.json (mag ontbreken)
//   2. pad naar een JSON-dump in de vorm { body, authorLogin, authorType, createdAt, comments:
//      [{ body, authorLogin, authorType, createdAt }] } — via `gh api`, NIET `gh issue view`
//      (leeg = geen open issue)
//   3. het huidige moment als ISO-8601
//   4. optioneel: een infra-oorzaak (`tests-gefaald`/`uitvoerder-gefaald`/`vastleggen-gefaald`) uit
//      de step-outcomes in de workflow — overschrijft de uit `oordeel` afgeleide code, want een
//      infrastructurele storing is fundamenteler dan wat `oordeel.json` zelf rapporteerde (en dat
//      bestand kan zelfs ontbreken of een stale GROEN dragen als een latere stap alsnog faalde).
//
// Codex-bevinding 3 (28-07-2026, review vóór commit): dit alarm-issue staat in een PUBLIEKE repo en
// is nooit vergrendeld — elke lezer kan erop reageren. De oude versie las `Moment:`/`oorzaakcode:`
// uit ELKE comment-tekst, ongeacht auteur: een gespoofte comment met een recent `Moment:` en een
// matchende `oorzaakcode:` had het alarm voor altijd kunnen onderdrukken. Nu telt alleen tekst mee
// van `authorType === 'Bot' && authorLogin === 'github-actions[bot]'`, en het moment komt van
// GitHub's eigen `createdAt` — nooit uit de tekst zelf, die iedereen kan verzinnen.

import { readFileSync, existsSync } from 'node:fs';
import { oorzaakCode, oorzaakCodeUitTekst, magMelden } from './lib/alarm-drempel.mjs';

const [oordeelPad, issueJsonPad, nuIso, infraOorzaak] = process.argv.slice(2);

if (!nuIso) {
  console.error('gebruik: node alarm-besluit.mjs <oordeel.json> <issue.json|""> <nu-iso> [infra-oorzaak]');
  process.exit(1);
}

const oordeel = oordeelPad && existsSync(oordeelPad)
  ? JSON.parse(readFileSync(oordeelPad, 'utf8'))
  : null;

const code = infraOorzaak ? infraOorzaak : oorzaakCode(oordeel);

const nu = Date.parse(nuIso);
if (!Number.isFinite(nu)) {
  console.error(`ongeldig moment: ${nuIso}`);
  process.exit(1);
}

const isVertrouwd = (bron) => bron
  && bron.authorType === 'Bot'
  && bron.authorLogin === 'github-actions[bot]';

let eerdereMeldingen = [];
if (issueJsonPad && existsSync(issueJsonPad)) {
  const issue = JSON.parse(readFileSync(issueJsonPad, 'utf8'));
  const bronnen = [issue, ...(issue.comments ?? [])].filter(isVertrouwd);
  eerdereMeldingen = bronnen
    .map((bron) => ({ code: oorzaakCodeUitTekst(bron.body), momentMs: Date.parse(bron.createdAt) }))
    .filter((m) => m.code && Number.isFinite(m.momentMs));
}

const besluit = magMelden(eerdereMeldingen, code, nu);
process.stdout.write(JSON.stringify({ code, mag: besluit.mag, reden: besluit.reden }));
