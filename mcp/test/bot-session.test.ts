import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openBotSession, runWrite } from '../src/bot-session.ts';

const sidecar = {
  async embedBatch(texts: string[]) { return { vectors: texts.map(t => { const v = new Float32Array(384); v[t.length % 384] = 1; return v; }), latencyMs: 1 }; },
  async tokenCounts(texts: string[]) { return texts.map(t => t.split(/\s+/).length + 2); },
  async loadTokenizer() {}, async close() {},
};

test('write verbs run through a session; the store survives reopening from the state dir', async () => {
  process.env.SEEK_MCP_STATE = await mkdtemp(join(tmpdir(), 'seek-st-'));
  const root = await mkdtemp(join(tmpdir(), 'seek-sv-'));
  await mkdir(join(root, '.obsidian/plugins/seek'), { recursive: true });
  await writeFile(join(root, 'a.md'), `# a\n\n${'alpha text here '.repeat(40)}\n`);
  const s = await openBotSession(root, sidecar);
  const full = await runWrite(s, 'index_vault') as any;
  assert.equal(full.ran, true);
  assert.equal(full.health, 'healthy');
  assert.equal(full.paused, false);
  assert.ok(full.filesIndexed >= 1, 'pass numbers still reported: ' + JSON.stringify(full));
  const n = (await s.store.count()).chunks;
  assert.ok(n >= 1);
  assert.deepEqual((await runWrite(s, 'index_delta') as any).delta, { dirty: 0, deleted: 0 });
  assert.ok(await runWrite(s, 'compact_sidecar'));
  await assert.rejects(runWrite(s, 'nope'), /unknown write tool/);
  const again = await openBotSession(root, sidecar);
  assert.equal((await again.store.count()).chunks, n);
  assert.equal(again.deviceId, s.deviceId);
});

test('what the bot indexes is searchable and fetchable from its own store', async () => {
  process.env.SEEK_MCP_STATE = await mkdtemp(join(tmpdir(), 'seek-st-'));
  const root = await mkdtemp(join(tmpdir(), 'seek-sv-'));
  await mkdir(join(root, '.obsidian/plugins/seek'), { recursive: true });
  await writeFile(join(root, 'a.md'), `# a\n\n${'alpha text here '.repeat(40)}\n`);
  const s = await openBotSession(root, sidecar);
  await runWrite(s, 'index_vault');
  const hits = await s.reader.search({ text: 'alpha text', topK: 3 });
  assert.equal(hits[0]?.notePath, 'a.md');
  assert.ok(hits[0].content.includes('alpha'));
  assert.equal(hits[0].vector, undefined);
  assert.equal((await s.reader.search({ text: 'alpha', includeVectors: true }))[0].vector?.length, 384);
  assert.equal((await s.reader.chunk(hits[0].chunkId)).notePath, 'a.md');
  assert.ok((await s.reader.note('a.md')).length >= 1);
  assert.deepEqual(await s.reader.note('nope.md'), []);
  const st = await s.reader.status() as Record<string, any>;
  for (const k of ['schemaVersion', 'generation', 'modelId', 'revision', 'chunkerVersion', 'dimension', 'chunkCount', 'loadedChunks', 'diagnostics']) assert.ok(k in st, `status lacks ${k}`);
  assert.equal(st.source, 'bot-store');
  assert.equal(st.diagnostics.loadedDocuments, st.loadedChunks);
  assert.equal((await s.reader.search({ vector: new Array(384).fill(0).map((_, i) => (i === 0 ? 1 : 0)), topK: 1 })).length, 1);
  await writeFile(join(root, 'b.md'), `# b\n\n${'zebra stripes here '.repeat(40)}\n`);
  await runWrite(s, 'index_delta');
  assert.equal((await s.reader.search({ text: 'zebra stripes' }))[0].notePath, 'b.md');
});

test('the core lifecycle drives the bot: a created note is flushed into the index and found', async () => {
  process.env.SEEK_MCP_STATE = await mkdtemp(join(tmpdir(), 'seek-st-'));
  const root = await mkdtemp(join(tmpdir(), 'seek-sv-'));
  await mkdir(join(root, '.obsidian/plugins/seek'), { recursive: true });
  await writeFile(join(root, 'a.md'), `# a\n\n${'alpha text here '.repeat(40)}\n`);
  const s = await openBotSession(root, sidecar);
  await runWrite(s, 'index_vault');
  await writeFile(join(root, 'c.md'), `# c\n\n${'quokka marsupial '.repeat(40)}\n`);
  s.life.onCreate('c.md');
  await s.life.flushDirty();
  assert.equal((await s.reader.search({ text: 'quokka marsupial' }))[0].notePath, 'c.md');
  assert.equal(await s.host.verifyCoherent(), true);
  assert.ok((await s.host.indexedChunkCount())! >= 2);
});
