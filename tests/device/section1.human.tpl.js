// Section 1, human half (GENERATED into section1.human.js by build.mjs; edit the .tpl.js).
// Paste into the Obsidian developer console of a vault named "SeekTest", then:
//   await SeekTest.seed()   // once; writes the fixture notes and the Excluded-files filter
//   await SeekTest.run()    // runs T0.1 T0.2 T2.1 T2.2 T2.3, saves Seek Test/section1.human.json
(() => {
const FX = __FIXTURES__;
const A = app.vault.adapter;
const seek = () => app.plugins.plugins.seek;
// The orchestrator is private in TS only; at runtime its indexing predicate is the thing under test.
const orch = () => seek()?.orchestrator;
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

const guard = () => {
  if (app.vault.getName() !== FX.vaultName) throw new Error(`refusing: vault is "${app.vault.getName()}", tests only run in "${FX.vaultName}"`);
};

// Stepwise because mobile adapters do not all create parents recursively.
const mkdirs = async p => {
  let d = '';
  for (const part of p.split('/').slice(0, -1)) { d = d ? `${d}/${part}` : part; if (!(await A.exists(d))) await A.mkdir(d); }
};

async function seed() {
  guard();
  for (const [p, c] of Object.entries(FX.files)) {
    await mkdirs(p);
    const f = app.vault.getAbstractFileByPath(p);
    if (f) await app.vault.modify(f, c); else await app.vault.create(p, c);
  }
  // Raw adapter writes: dot folders are outside Obsidian's file tree on purpose.
  for (const [p, c] of Object.entries(FX.hidden)) { await mkdirs(p); await A.write(p, c); }
  app.vault.setConfig('userIgnoreFilters', FX.ignoreFilters);
  return `seeded ${Object.keys(FX.files).length + Object.keys(FX.hidden).length} files`;
}

const live = () => { const o = orch(); return o.indexableFiles().filter(f => o.shouldIndex(f.path)).sort((a, b) => (a.path < b.path ? -1 : 1)); };

const T = {
  async 'T0.1'() {
    const s = seek(), o = orch();
    let api = null; try { api = require('obsidian').apiVersion; } catch { /* not exposed on mobile */ }
    const observed = { plugin: !!s, orchestrator: !!o, version: s?.manifest?.version, mobile: app.isMobile, api };
    return { pass: !!s && !!o && observed.version === FX.version, observed, expected: { plugin: true, orchestrator: true, version: FX.version }, parity: observed.version };
  },

  async 'T0.2'() {
    const got = {};
    for (const p of Object.keys(FX.sha)) got[p] = (await A.exists(p)) ? await sha(await A.read(p)) : 'MISSING';
    const bad = Object.keys(FX.sha).filter(p => got[p] !== FX.sha[p]);
    return { pass: !bad.length, observed: { mismatched: bad }, expected: { mismatched: [] }, parity: got };
  },

  async 'T2.1'() {
    const got = live().map(f => f.path).sort();
    return { pass: JSON.stringify(got) === JSON.stringify(FX.indexable), observed: { honorIgnored: seek().settings?.honorIgnoredFolders, files: got }, expected: FX.indexable, parity: got };
  },

  async 'T2.2'() {
    const got = {};
    // cachedRead is the call computeDelta itself uses, so this is the indexer's view of each file.
    for (const f of live()) got[f.path] = await sha(await app.vault.cachedRead(f));
    const want = Object.fromEntries(FX.indexable.map(p => [p, FX.sha[p]]));
    const k = Object.keys(want).sort();
    return { pass: JSON.stringify(got, k) === JSON.stringify(want, k) && Object.keys(got).length === k.length, observed: got, expected: want, parity: got };
  },

  async 'T2.3'() {
    const listed = new Set(live().map(f => f.path)), got = {};
    for (const [label, key] of Object.entries(FX.pathCases)) {
      const f = app.vault.getAbstractFileByPath(key);
      got[label] = { listed: listed.has(key), nfc: key === key.normalize('NFC'), read: !!f && (await sha(await app.vault.cachedRead(f))) === FX.sha[key] };
    }
    return { pass: Object.values(got).every(v => v.listed && v.nfc && v.read), observed: got, expected: 'all true', parity: got };
  },
};

async function run() {
  guard();
  const out = [];
  for (const [id, fn] of Object.entries(T)) {
    try { out.push({ id, ...(await fn()) }); } catch (e) { out.push({ id, pass: false, observed: String(e?.stack ?? e), expected: 'no throw', parity: null }); }
  }
  console.table(out.map(r => ({ id: r.id, pass: r.pass ? 'PASS' : 'FAIL' })));
  for (const r of out.filter(r => !r.pass)) console.log(r.id, 'observed', r.observed, 'expected', r.expected);
  const json = JSON.stringify({ side: 'human', results: out }, null, 1);
  await mkdirs('Seek Test/x'); await A.write('Seek Test/section1.human.json', json);
  return out.every(r => r.pass) ? 'ALL PASS' : 'FAILURES: ' + out.filter(r => !r.pass).map(r => r.id).join(' ');
}

window.SeekTest = { seed, run, T };
return 'SeekTest ready: await SeekTest.seed(); await SeekTest.run()';
})();
