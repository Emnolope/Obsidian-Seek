// Section 1, human half (GENERATED into section1.human.js by build.mjs; edit the .tpl.js).
// Paste into the Obsidian developer console of a vault named "SeekTest", then:
//   await SeekTest.seed()   // once; writes the fixture notes and the Excluded-files filter
//   await SeekTest.run()    // runs T0.1 T0.2 T2.1 T2.2 T2.3, saves Seek Test/section1.human.json
(() => {
const FX = {"vaultName":"SeekTest","version":"1.2.1.99.5","files":{"a/alpha.md":"---\ntags: [alpha, fixture]\nstatus: draft\nscore: 7\nwhen: 2026-01-15\n---\n# Alpha\n\nZebrafish orchids grow here. See [[béta note]].\n\n## Second heading\n\nA body #bodytag line.\n","b/béta note.md":"# Béta\n\nA completely different passage about soil fungi and decomposition.\n\nBack to [[alpha]].\n","c/gamma.md":"# Gamma\n\n```js\nconst x = \"[[not-a-link]]\"; // quartz_marker_77\n```\n\nReal link: [[alpha]]. Embed: ![[béta note]]\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n> [!note] A callout\n> with two lines\n","c/oversize.md":"# Oversize\n\n| r0 | cell cell cell cell cell cell | 0 |\n| r1 | cell cell cell cell cell cell | 7 |\n| r2 | cell cell cell cell cell cell | 14 |\n| r3 | cell cell cell cell cell cell | 21 |\n| r4 | cell cell cell cell cell cell | 28 |\n| r5 | cell cell cell cell cell cell | 35 |\n| r6 | cell cell cell cell cell cell | 42 |\n| r7 | cell cell cell cell cell cell | 49 |\n| r8 | cell cell cell cell cell cell | 56 |\n| r9 | cell cell cell cell cell cell | 63 |\n| r10 | cell cell cell cell cell cell | 70 |\n| r11 | cell cell cell cell cell cell | 77 |\n| r12 | cell cell cell cell cell cell | 84 |\n| r13 | cell cell cell cell cell cell | 91 |\n| r14 | cell cell cell cell cell cell | 98 |\n| r15 | cell cell cell cell cell cell | 105 |\n| r16 | cell cell cell cell cell cell | 112 |\n| r17 | cell cell cell cell cell cell | 119 |\n| r18 | cell cell cell cell cell cell | 126 |\n| r19 | cell cell cell cell cell cell | 133 |\n| r20 | cell cell cell cell cell cell | 140 |\n| r21 | cell cell cell cell cell cell | 147 |\n| r22 | cell cell cell cell cell cell | 154 |\n| r23 | cell cell cell cell cell cell | 161 |\n| r24 | cell cell cell cell cell cell | 168 |\n| r25 | cell cell cell cell cell cell | 175 |\n| r26 | cell cell cell cell cell cell | 182 |\n| r27 | cell cell cell cell cell cell | 189 |\n| r28 | cell cell cell cell cell cell | 196 |\n| r29 | cell cell cell cell cell cell | 203 |\n| r30 | cell cell cell cell cell cell | 210 |\n| r31 | cell cell cell cell cell cell | 217 |\n| r32 | cell cell cell cell cell cell | 224 |\n| r33 | cell cell cell cell cell cell | 231 |\n| r34 | cell cell cell cell cell cell | 238 |\n| r35 | cell cell cell cell cell cell | 245 |\n| r36 | cell cell cell cell cell cell | 252 |\n| r37 | cell cell cell cell cell cell | 259 |\n| r38 | cell cell cell cell cell cell | 266 |\n| r39 | cell cell cell cell cell cell | 273 |\n| r40 | cell cell cell cell cell cell | 280 |\n| r41 | cell cell cell cell cell cell | 287 |\n| r42 | cell cell cell cell cell cell | 294 |\n| r43 | cell cell cell cell cell cell | 301 |\n| r44 | cell cell cell cell cell cell | 308 |\n| r45 | cell cell cell cell cell cell | 315 |\n| r46 | cell cell cell cell cell cell | 322 |\n| r47 | cell cell cell cell cell cell | 329 |\n| r48 | cell cell cell cell cell cell | 336 |\n| r49 | cell cell cell cell cell cell | 343 |\n| r50 | cell cell cell cell cell cell | 350 |\n| r51 | cell cell cell cell cell cell | 357 |\n| r52 | cell cell cell cell cell cell | 364 |\n| r53 | cell cell cell cell cell cell | 371 |\n| r54 | cell cell cell cell cell cell | 378 |\n| r55 | cell cell cell cell cell cell | 385 |\n| r56 | cell cell cell cell cell cell | 392 |\n| r57 | cell cell cell cell cell cell | 399 |\n| r58 | cell cell cell cell cell cell | 406 |\n| r59 | cell cell cell cell cell cell | 413 |\n| r60 | cell cell cell cell cell cell | 420 |\n| r61 | cell cell cell cell cell cell | 427 |\n| r62 | cell cell cell cell cell cell | 434 |\n| r63 | cell cell cell cell cell cell | 441 |\n| r64 | cell cell cell cell cell cell | 448 |\n| r65 | cell cell cell cell cell cell | 455 |\n| r66 | cell cell cell cell cell cell | 462 |\n| r67 | cell cell cell cell cell cell | 469 |\n| r68 | cell cell cell cell cell cell | 476 |\n| r69 | cell cell cell cell cell cell | 483 |\n| r70 | cell cell cell cell cell cell | 490 |\n| r71 | cell cell cell cell cell cell | 497 |\n| r72 | cell cell cell cell cell cell | 504 |\n| r73 | cell cell cell cell cell cell | 511 |\n| r74 | cell cell cell cell cell cell | 518 |\n| r75 | cell cell cell cell cell cell | 525 |\n| r76 | cell cell cell cell cell cell | 532 |\n| r77 | cell cell cell cell cell cell | 539 |\n| r78 | cell cell cell cell cell cell | 546 |\n| r79 | cell cell cell cell cell cell | 553 |\n| r80 | cell cell cell cell cell cell | 560 |\n| r81 | cell cell cell cell cell cell | 567 |\n| r82 | cell cell cell cell cell cell | 574 |\n| r83 | cell cell cell cell cell cell | 581 |\n| r84 | cell cell cell cell cell cell | 588 |\n| r85 | cell cell cell cell cell cell | 595 |\n| r86 | cell cell cell cell cell cell | 602 |\n| r87 | cell cell cell cell cell cell | 609 |\n| r88 | cell cell cell cell cell cell | 616 |\n| r89 | cell cell cell cell cell cell | 623 |\n| r90 | cell cell cell cell cell cell | 630 |\n| r91 | cell cell cell cell cell cell | 637 |\n| r92 | cell cell cell cell cell cell | 644 |\n| r93 | cell cell cell cell cell cell | 651 |\n| r94 | cell cell cell cell cell cell | 658 |\n| r95 | cell cell cell cell cell cell | 665 |\n| r96 | cell cell cell cell cell cell | 672 |\n| r97 | cell cell cell cell cell cell | 679 |\n| r98 | cell cell cell cell cell cell | 686 |\n| r99 | cell cell cell cell cell cell | 693 |\n| r100 | cell cell cell cell cell cell | 700 |\n| r101 | cell cell cell cell cell cell | 707 |\n| r102 | cell cell cell cell cell cell | 714 |\n| r103 | cell cell cell cell cell cell | 721 |\n| r104 | cell cell cell cell cell cell | 728 |\n| r105 | cell cell cell cell cell cell | 735 |\n| r106 | cell cell cell cell cell cell | 742 |\n| r107 | cell cell cell cell cell cell | 749 |\n| r108 | cell cell cell cell cell cell | 756 |\n| r109 | cell cell cell cell cell cell | 763 |\n| r110 | cell cell cell cell cell cell | 770 |\n| r111 | cell cell cell cell cell cell | 777 |\n| r112 | cell cell cell cell cell cell | 784 |\n| r113 | cell cell cell cell cell cell | 791 |\n| r114 | cell cell cell cell cell cell | 798 |\n| r115 | cell cell cell cell cell cell | 805 |\n| r116 | cell cell cell cell cell cell | 812 |\n| r117 | cell cell cell cell cell cell | 819 |\n| r118 | cell cell cell cell cell cell | 826 |\n| r119 | cell cell cell cell cell cell | 833 |\n| r120 | cell cell cell cell cell cell | 840 |\n| r121 | cell cell cell cell cell cell | 847 |\n| r122 | cell cell cell cell cell cell | 854 |\n| r123 | cell cell cell cell cell cell | 861 |\n| r124 | cell cell cell cell cell cell | 868 |\n| r125 | cell cell cell cell cell cell | 875 |\n| r126 | cell cell cell cell cell cell | 882 |\n| r127 | cell cell cell cell cell cell | 889 |\n| r128 | cell cell cell cell cell cell | 896 |\n| r129 | cell cell cell cell cell cell | 903 |\n| r130 | cell cell cell cell cell cell | 910 |\n| r131 | cell cell cell cell cell cell | 917 |\n| r132 | cell cell cell cell cell cell | 924 |\n| r133 | cell cell cell cell cell cell | 931 |\n| r134 | cell cell cell cell cell cell | 938 |\n| r135 | cell cell cell cell cell cell | 945 |\n| r136 | cell cell cell cell cell cell | 952 |\n| r137 | cell cell cell cell cell cell | 959 |\n| r138 | cell cell cell cell cell cell | 966 |\n| r139 | cell cell cell cell cell cell | 973 |\n| r140 | cell cell cell cell cell cell | 980 |\n| r141 | cell cell cell cell cell cell | 987 |\n| r142 | cell cell cell cell cell cell | 994 |\n| r143 | cell cell cell cell cell cell | 1001 |\n| r144 | cell cell cell cell cell cell | 1008 |\n| r145 | cell cell cell cell cell cell | 1015 |\n| r146 | cell cell cell cell cell cell | 1022 |\n| r147 | cell cell cell cell cell cell | 1029 |\n| r148 | cell cell cell cell cell cell | 1036 |\n| r149 | cell cell cell cell cell cell | 1043 |\n| r150 | cell cell cell cell cell cell | 1050 |\n| r151 | cell cell cell cell cell cell | 1057 |\n| r152 | cell cell cell cell cell cell | 1064 |\n| r153 | cell cell cell cell cell cell | 1071 |\n| r154 | cell cell cell cell cell cell | 1078 |\n| r155 | cell cell cell cell cell cell | 1085 |\n| r156 | cell cell cell cell cell cell | 1092 |\n| r157 | cell cell cell cell cell cell | 1099 |\n| r158 | cell cell cell cell cell cell | 1106 |\n| r159 | cell cell cell cell cell cell | 1113 |\n","d/empty.md":"","d/notes.base":"filters:\n  and:\n    - file.hasTag(\"alpha\")\nviews:\n  - type: table\n    name: Alpha notes\n","d/readme.txt":"not markdown; never indexed\n","e/deep/er/nest ed/ünï.md":"# Deep\n\nNested folder with a space and a diaeresis.\n","f/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx very long name.md":"# Long\n\nA very long file name.\n","ignored/secret.md":"# Secret\n\nExcluded by userIgnoreFilters.\n"},"hidden":{".dot/hid.md":"# Hidden\n\nIn a dot folder.\n"},"ignoreFilters":["ignored/"],"indexable":["a/alpha.md","b/béta note.md","c/gamma.md","c/oversize.md","d/empty.md","d/notes.base","e/deep/er/nest ed/ünï.md","f/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx very long name.md"],"pathCases":{"unicode":"b/béta note.md","deep":"e/deep/er/nest ed/ünï.md","long":"f/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx very long name.md","spaces":"b/béta note.md","empty":"d/empty.md"},"sha":{"a/alpha.md":"03d767937db5826fa4fb0e084e3a0840b2bde29c2ee3a5e3695b3ff0c9c07017","b/béta note.md":"db2c7fcd2335564847e358e513c59c5ae135c750278cf68ed525f13631537357","c/gamma.md":"6014f7eb72ebd061472d67f368d9d203f97f332af76befee2b38ae705602012a","c/oversize.md":"b1a60ece5c6a69748bac5a161a4031868bb24ac2b5de1ef7115c0587d5dfbe91","d/empty.md":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","d/notes.base":"a1a6b80eca49a5da1f51578e67e403b3a44d05fafbdf8523c746305c4f2a622a","d/readme.txt":"0de44cc3c6f3c8531f3072ee28e5e8b27bbe60886471f6e6688a56b2440f3309","e/deep/er/nest ed/ünï.md":"928d44a50ce441afeb1aafe7d8bb0cdda0c693fdbbfeff04650e1ed9958b191e","f/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx very long name.md":"33702c39586b587ee0be4e95f1b0f2a879f0a4a85e9b72271209780e083150f6","ignored/secret.md":"96d17decea138b69e810172204544b024506eb93b35fd6290f4bd290ad238740",".dot/hid.md":"a836065b4adce0588611357dea1e8fa6e945fda4667e49c059ab896e27ea7f5c"}};
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
