// node tests/device/compare.mjs section1.human.json section1.bot.json
// Parity = same observation from both halves, not just both passing.
import { readFile } from 'node:fs/promises';
const [h, b] = await Promise.all(process.argv.slice(2, 4).map(async p => JSON.parse(await readFile(p, 'utf8')).results));
let bad = 0;
for (const r of h) {
  const o = b.find(x => x.id === r.id);
  const same = o && JSON.stringify(r.parity) === JSON.stringify(o.parity);
  if (!same) { bad++; console.log(`${r.id} DIVERGES\n human:`, JSON.stringify(r.parity), '\n bot:  ', JSON.stringify(o?.parity)); }
  else console.log(`${r.id} parity ok (human ${r.pass ? 'pass' : 'FAIL'}, bot ${o.pass ? 'pass' : 'FAIL'})`);
}
process.exit(bad ? 1 : 0);
