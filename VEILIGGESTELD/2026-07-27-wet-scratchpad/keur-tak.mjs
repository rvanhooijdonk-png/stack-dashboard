// Keurt élke commit van de tak los: verdwijnt er een regel, en komen er exacte duplicaten bij?
import { execFileSync } from 'node:child_process';
import { alleenAangevuld, nieuweDuplicaten, publiekeAfwijkingen } from './spiegelwet.mjs';

const pad = 'data/kanaalpost-publiek.md';
const lees = (rev) => execFileSync('git', ['show', `${rev}:${pad}`], { encoding: 'utf8' });
const commits = execFileSync('git', ['rev-list', '--reverse', 'origin/main..HEAD'], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);

let fout = 0;
for (const c of commits) {
  const kort = c.slice(0, 7);
  const kop = execFileSync('git', ['log', '--format=%s', '-n', '1', c], { encoding: 'utf8' }).trim().slice(0, 58);
  const r = alleenAangevuld(lees(`${c}^`), lees(c));
  const rijen = lees(c).split('\n').filter((l) => l.startsWith('|'));
  const dubbel = rijen.filter((l, i) => rijen.indexOf(l) !== i).length;
  const p = publiekeAfwijkingen(lees(`${c}^`), lees(c));
  if (r.verdwenen || dubbel || !p.ok) fout += 1;
  console.log(`${kort}  verdwenen ${r.verdwenen}  duplicaten ${dubbel}  rijen ${rijen.length}  publiek: -${p.verdwenen}/dubbel ${p.dubbel.length}/in beeld ${p.aantal}  ${kop}`);
}
const eind = alleenAangevuld(lees('origin/main'), lees('HEAD'));
const eindP = publiekeAfwijkingen(lees('origin/main'), lees('HEAD'));
console.log(`\neindtoestand t.o.v. origin/main — verdwenen ${eind.verdwenen}, ok ${eind.ok}, opOrde ${eind.opOrde}`);
console.log(`publieke rijen t.o.v. origin/main — verdwenen ${eindP.verdwenen}, dubbel ${eindP.dubbel.length}, in beeld ${eindP.aantal}, ok ${eindP.ok}`);
console.log(fout === 0 ? 'ALLE COMMITS SCHOON' : `${fout} commit(s) NIET schoon`);
process.exit(fout === 0 && eind.ok && eindP.ok ? 0 : 1);
