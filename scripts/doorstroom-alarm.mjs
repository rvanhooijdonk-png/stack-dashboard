#!/usr/bin/env node
/**
 * CLI om de doorstroom-alarm-beslissing (`scripts/lib/doorstroom-alarm.mjs`) vanuit bash aan te
 * roepen, zonder ESM-`require`-gedoe in een `node -e`-eenregelig. Beslist alleen — handelt niet: de
 * workflow doet zelf de `gh issue`-aanroepen op basis van wat hier uitkomt.
 *
 * Subcommando's:
 *   beslis --oordeel <pad> --tap <pad> --issue-body <pad> --issue-open <true|false>
 *          --periode-uur <getal> [--nu <ISO-tijdstip>] [--oorzaak-override <code>]
 *     → JSON op stdout: { uitkomst, causeSig, testNamen, melden, reden, nieuweState }
 *
 *     `--oorzaak-override` is voor een storing BUITEN de doorstroom-uitvoerder zelf (bv. de push in
 *     "Aanvulling vastleggen" faalde) — er is dan geen betrouwbaar `--oordeel` om op te vertrouwen
 *     (kan zelfs een stale GROEN zijn, van vóór de storing). Is deze optie gezet, dan is `<code>` zelf
 *     de oorzaak-handtekening en wordt `uitkomst` altijd ROOD, ongeacht wat `--oordeel` zegt.
 *
 *   merk-schrijven --basis <pad> --beslissing <pad>
 *     → nieuwe issuebody-tekst op stdout (basisbody met de marker uit `--beslissing`'s
 *       `nieuweState`-veld erin geschreven of, bij `null`, verwijderd)
 */
import { readFile } from 'node:fs/promises';

import {
  bepaalOorzaak, leesMarker, schrijfMarker, beslisMelding,
} from './lib/doorstroom-alarm.mjs';

function opt(args, naam, standaard = null) {
  const i = args.indexOf(`--${naam}`);
  return i === -1 || i === args.length - 1 ? standaard : args[i + 1];
}

async function leesOfNull(pad) {
  if (!pad) return null;
  try {
    return await readFile(pad, 'utf8');
  } catch {
    return null;
  }
}

async function commandoBeslis(args) {
  const oorzaakOverride = opt(args, 'oorzaak-override');
  const issueBody = await leesOfNull(opt(args, 'issue-body'));
  const issueOpen = opt(args, 'issue-open', 'false') === 'true';
  const periodeUur = Number(opt(args, 'periode-uur', '24'));
  const nuArg = opt(args, 'nu');
  const nu = nuArg ? new Date(nuArg) : new Date();

  // Bij een override negeert `bepaalOorzaak` het oordeel toch — en dat is precies waarom we het hier
  // NIET proberen te lezen/parsen: een storing in "Overzetten" kan `/tmp/oordeel.json` halverwege
  // geschreven en dus ONGELDIG JSON achterlaten. Wél parsen zou de CLI op die ongeldige JSON laten
  // crashen vóórdat de override ooit toeslaat — precies het scenario waarin de override moest redden
  // (bevinding Codex-review, derde ronde, gereproduceerd).
  let oordeel = null;
  let tap = null;
  if (!oorzaakOverride) {
    const oordeelTekst = await leesOfNull(opt(args, 'oordeel'));
    oordeel = oordeelTekst ? JSON.parse(oordeelTekst) : null;
    tap = await leesOfNull(opt(args, 'tap'));
  }

  const { uitkomst, causeSig, testNamen } = bepaalOorzaak({ oordeel, tap, oorzaakOverride });
  const opgeslagen = leesMarker(issueBody);
  const beslissing = beslisMelding({
    uitkomst, causeSig, opgeslagen, issueOpen, nu, periodeUur,
  });

  process.stdout.write(JSON.stringify({
    uitkomst, causeSig, testNamen, ...beslissing,
  }));
}

async function commandoMerkSchrijven(args) {
  const basis = (await leesOfNull(opt(args, 'basis'))) ?? '';
  const beslissingTekst = await leesOfNull(opt(args, 'beslissing'));
  const beslissing = beslissingTekst ? JSON.parse(beslissingTekst) : {};
  process.stdout.write(schrijfMarker(basis, beslissing.nieuweState ?? null));
}

async function main() {
  const [commando, ...rest] = process.argv.slice(2);
  if (commando === 'beslis') return commandoBeslis(rest);
  if (commando === 'merk-schrijven') return commandoMerkSchrijven(rest);
  process.stderr.write(`onbekend commando: ${commando ?? '(geen)'} — verwacht 'beslis' of 'merk-schrijven'\n`);
  process.exit(2);
  return undefined;
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exit(1);
});
