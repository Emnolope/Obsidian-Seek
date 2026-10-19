import assert from 'node:assert/strict';
import test from 'node:test';
import { NodeIndexStore } from '../src/node-index-store.ts';
import { quantizeInt8 } from '../../core/quant.ts';
import { packSignBits } from '../../core/binary.ts';

const vec = (i: number) => Float32Array.from({ length: 384 }, (_, k) => (k === i ? 1 : 0));
const chunk = (id: string, path: string) => ({ chunk_id: id, note_path: path, content: `body ${id}`, title: id, chunk_index: 0 }) as any;
const tier = (i: number) => ({ q: quantizeInt8(vec(i)), bin: packSignBits(vec(i)) });

async function seeded() {
  const s = new NodeIndexStore('t');
  await s.putBatchQuantized([chunk('a', 'n.md'), chunk('b', 'n.md')], [tier(0), tier(1)],
    { note_path: 'n.md', mtimeMs: 1, chunk_ids: ['a', 'b'] } as any);
  return s;
}

test('put then read every tier, aligned to input order with nulls for misses', async () => {
  const s = await seeded();
  assert.deepEqual(await s.count(), { chunks: 2, embeddings: 2, binary: 2, files: 1 });
  assert.deepEqual(await s.getBodiesByIds(['b', 'zz', 'a']), ['body b', null, 'body a']);
  const e = await s.getEmbeddingsByIds(['b', 'zz']);
  assert.ok(e[0] && e[0][1] > 0.99 && e[1] === null);
  const t = await s.getTiersByIds(['a', 'zz']);
  assert.equal(t[0]?.chunk.content, 'body a');
  assert.equal(t[1], null);
});

test('deleteFile returns the removed ids and empties every tier; unknown path is a no-op', async () => {
  const s = await seeded();
  assert.deepEqual(await s.deleteFile('n.md'), ['a', 'b']);
  assert.deepEqual(await s.count(), { chunks: 0, embeddings: 0, binary: 0, files: 0 });
  assert.deepEqual(await s.deleteFile('n.md'), []);
});

test('getMeta fabricates a default on an empty store; setMeta sticks; putBatch derives tiers from fp32', async () => {
  const s = new NodeIndexStore('t');
  assert.equal((await s.getMeta()).lastIndexedAt, null);
  await s.setMeta({ embeddingDim: 384, lastIndexedAt: 'x', schemaVersion: 2 } as any);
  assert.equal((await s.getMeta()).lastIndexedAt, 'x');
  await s.putBatch([chunk('c', 'm.md')], [vec(2)]);
  const { ids, vecs } = await s.listAllEmbeddings();
  assert.deepEqual(ids, ['c']);
  assert.equal(vecs[0].q[2], 127);
  await assert.rejects(s.putBatch([chunk('d', 'm.md')], []), /length mismatch/);
});

test('a snapshot in the state dir survives a restart (and is not the vault)', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { nodeFileAdapter } = await import('../src/node-file-adapter.ts');
  const dir = await mkdtemp(join(tmpdir(), 'seek-state-'));
  const a = new NodeIndexStore('seek-index:vault1', nodeFileAdapter(dir));
  await a.open();
  await a.putBatchQuantized([chunk('a', 'n.md')], [tier(3)], { note_path: 'n.md', mtimeMs: 7, chunk_ids: ['a'] } as any);
  await a.setMeta({ embeddingDim: 384, lastIndexedAt: 'kept', schemaVersion: 2 } as any);
  a.close();
  await new Promise(r => setTimeout(r, 50));
  const b = new NodeIndexStore('seek-index:vault1', nodeFileAdapter(dir));
  await b.open();
  assert.deepEqual(await b.count(), { chunks: 1, embeddings: 1, binary: 1, files: 1 });
  assert.equal((await b.getMeta()).lastIndexedAt, 'kept');
  const t = (await b.getTiersByIds(['a']))[0]!;
  assert.equal(t.q.q[3], 127);
  assert.equal(t.chunk.content, 'body a');
});
