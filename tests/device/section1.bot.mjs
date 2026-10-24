// Section 1, bot half: environment + vault reads. Run: node --experimental-strip-types tests/device/section1.bot.mjs [--vault DIR] [--out FILE]
// Without --vault it seeds a throwaway dir, so nothing real is touched.
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { files, hidden, config, indexable, pathCases, hashes, sha } from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };

const seedDir = async d => {
  for (const [p, c] of Object.entries({ ...files, ...hidden, ...config })) { await mkdir(dirname(join(d, p)), { recursive: true }); await writeFile(join(d, p), c); }
};

// Embedding is out of scope here; the stub only has to satisfy the constructor.
const stub = { async embedBatch() { throw new Error('no embedder in section 1'); }, async tokenCounts() { return []; }, async loadTokenizer() {}, async close() {} };

const vault = arg('--vault') ? resolve(arg('--vault')) : await mkdtemp(join(tmpdir(), 'seek-s1-'));
if (!arg('--vault')) await seedDir(vault);
process.env.SEEK_MCP_STATE ??= await mkdtemp(join(tmpdir(), 'seek-s1-state-'));

const { openBotSession } = await import('../../mcp/src/bot-session.ts');
const { readVaultFile } = await import('../../mcp/src/base.ts');
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));

let s;
const sess = async () => (s ??= await openBotSession(vault, stub));
const live = async () => { const h = (await sess()).host; return (await h.indexableFiles()).filter(f => h.shouldIndex(f.path)).sort((a, b) => (a.path < b.path ? -1 : 1)); };

const T = {
  async 'T0.1'() {
    const bundle = await stat(join(root, 'mcp/dist/server.mjs')).then(x => x.size, () => 0);
    const { deviceId } = await sess();
    const node = process.versions.node;
    return { pass: +node.split('.')[0] >= 22 && bundle > 0 && /^bot-/.test(deviceId),
      observed: { version: manifest.version, node, platform: process.platform, bundle, deviceId }, expected: { node: '>=22', bundle: '>0', deviceId: 'bot-*' }, parity: manifest.version };
  },

  async 'T0.2'() {
    const got = {};
    for (const p of Object.keys(hashes)) got[p] = await readFile(join(vault, p)).then(b => sha(b.toString('utf8')), () => 'MISSING');
    const bad = Object.keys(hashes).filter(p => got[p] !== hashes[p]);
    return { pass: !bad.length, observed: { mismatched: bad }, expected: { mismatched: [] }, parity: got };
  },

  async 'T2.1'() {
    const got = (await live()).map(f => f.path).sort();
    return { pass: JSON.stringify(got) === JSON.stringify(indexable), observed: got, expected: indexable, parity: got };
  },

  async 'T2.2'() {
    const rd = readVaultFile(vault), got = {};
    for (const f of await live()) got[f.path] = sha(await rd(f));
    const want = Object.fromEntries(indexable.map(p => [p, hashes[p]]));
    return { pass: JSON.stringify(got, Object.keys(got).sort()) === JSON.stringify(want, Object.keys(want).sort()), observed: got, expected: want, parity: got };
  },

  async 'T2.3'() {
    const rd = readVaultFile(vault), listed = new Set((await live()).map(f => f.path)), got = {};
    for (const [label, key] of Object.entries(pathCases)) {
      // Reading by the literal key (not the listing) is the lookup the sidecar and fetch_note perform.
      const text = await rd({ path: key, handle: key, mtime: 0 }).catch(() => null);
      got[label] = { listed: listed.has(key), nfc: key === key.normalize('NFC'), read: text !== null && sha(text) === hashes[key] };
    }
    return { pass: Object.values(got).every(v => v.listed && v.nfc && v.read), observed: got, expected: 'all true', parity: got };
  },
};

const out = [];
for (const [id, fn] of Object.entries(T)) {
  try { out.push({ id, ...(await fn()) }); } catch (e) { out.push({ id, pass: false, observed: String(e?.stack ?? e), expected: 'no throw', parity: null }); }
}
console.table(out.map(r => ({ id: r.id, pass: r.pass ? 'PASS' : 'FAIL' })));
for (const r of out.filter(r => !r.pass)) console.log(r.id, 'observed', JSON.stringify(r.observed, null, 1), '\nexpected', JSON.stringify(r.expected, null, 1));
await writeFile(arg('--out') ?? 'section1.bot.json', JSON.stringify({ side: 'bot', results: out }, null, 1));
process.exit(out.every(r => r.pass) ? 0 : 1);
