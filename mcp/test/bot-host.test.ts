import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BotHost } from '../src/bot-host.ts';
import { BotEmbedder } from '../src/bot-embedder.ts';
import { NodeIndexStore } from '../src/node-index-store.ts';
import { botLogger } from '../src/base.ts';
import { nodeFileAdapter } from '../src/node-file-adapter.ts';
import { resolveSettings } from '../../core/memory-host.ts';

// Deterministic stand-in for the model: a unit vector keyed off the text, token count = word count.
let embedCalls = 0;
const fakeSidecar = {
  async embedBatch(texts: string[]) {
    embedCalls += texts.length;
    return { vectors: texts.map(t => { const v = new Float32Array(384); v[(t.length * 7) % 384] = 1; return v; }), latencyMs: 1 };
  },
  async tokenCounts(texts: string[]) { return texts.map(t => t.split(/\s+/).length + 2); },
  async loadTokenizer() {},
  async close() {},
};

async function bot(vaultDir: string, deviceId: string) {
  const state = await mkdtemp(join(tmpdir(), 'seek-botstate-'));
  const vault = nodeFileAdapter(vaultDir);
  const store = new NodeIndexStore('t:' + deviceId);
  const host = new BotHost({
    vaultDir, vault, stateDir: state, store, embedder: new BotEmbedder(fakeSidecar),
    logger: botLogger(vault, deviceId), settings: resolveSettings({ sidecarEnabled: true }),
  });
  return { host, store };
}

async function makeVault() {
  const root = await mkdtemp(join(tmpdir(), 'seek-botvault-'));
  await mkdir(join(root, '.obsidian/plugins/seek'), { recursive: true });
  const body = (w: string) => `# ${w}\n\n${(w + ' lorem ipsum dolor sit amet ').repeat(40)}\n`;
  await writeFile(join(root, 'alpha.md'), body('alpha'));
  await writeFile(join(root, 'beta.md'), body('beta'));
  return { root, body };
}

test('bot indexes a vault, writes its own sidecar shard, and a second bot hydrates it without embedding', async () => {
  const { root } = await makeVault();
  const a = await bot(root, 'bot-aaaaaaaa');
  await a.host.reindexAll();
  const counts = await a.store.count();
  assert.ok(counts.chunks >= 2 && counts.files === 2, JSON.stringify(counts));
  const idx = await readdir(join(root, '.obsidian/plugins/seek/index'));
  assert.ok(idx.some(f => f.startsWith('embeddings.bot-aaaaaaaa')) && idx.some(f => f === 'index.bot-aaaaaaaa.jsonl'), idx.join(','));

  embedCalls = 0;
  const b = await bot(root, 'bot-bbbbbbbb');
  const r = await b.host.hydrateSidecar();
  assert.equal(embedCalls, 0, 'hydrate must not run the model');
  assert.equal((await b.store.count()).chunks, counts.chunks, JSON.stringify(r));
});

test('an edit goes through computeDelta + reindexDelta and re-embeds only the changed note', async () => {
  const { root, body } = await makeVault();
  const a = await bot(root, 'bot-aaaaaaaa');
  await a.host.reindexAll();
  assert.deepEqual(await a.host.computeDelta(), { dirty: [], deleted: [] });
  await new Promise(r => setTimeout(r, 20));
  await writeFile(join(root, 'beta.md'), body('gamma'));
  const d = await a.host.computeDelta();
  assert.deepEqual(d, { dirty: ['beta.md'], deleted: [] });
  embedCalls = 0;
  await a.host.reindexDelta(d.dirty, d.deleted, { embed: true });
  assert.ok(embedCalls > 0);
  const rec = await a.store.getFileRecord('beta.md');
  assert.ok(rec && (await a.store.getBodiesByIds([rec.chunk_ids[0]]))[0]?.includes('gamma'));
});
