// Meet append-only van de vorige commit naar de werkmap, met de wet uit de eindtoestand van de tak.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { alleenAangevuld } from './spiegelwet.mjs';

const pad = 'data/kanaalpost-publiek.md';
const oud = execFileSync('git', ['show', `HEAD:${pad}`], { encoding: 'utf8' });
const r = alleenAangevuld(oud, readFileSync(pad, 'utf8'));
console.log(`t.o.v. de vorige commit — verdwenen: ${r.verdwenen} | ok: ${r.ok}`);
process.exit(r.ok ? 0 : 1);
