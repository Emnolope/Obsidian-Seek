import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SeekIndex } from '../src/index.ts';
import { encodeRecord, SIGN_BYTES, VEC_BYTES } from '../src/sidecar.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'seek-mcp-'));
  await mkdir(root, { recursive: true });
  await mkdir(join(root, 'MCP Export'));
  await writeFile(join(root, 'meta.mobile-a72520e0.json'), JSON.stringify({ dim: 384, format: 3 }));
  await writeFile(join(root, 'MCP Export/export.meta.json'), JSON.stringify({ schemaVersion: 1, generation: 'test', modelId: 'model', revision: 'rev', chunkerVersion: 10, dimension: 384, chunkCount: 2 }));
  const records = [
    encodeRecord({ q: Int8Array.from([127, 0, ...new Array(382).fill(0)]), s: 1 / 127, sign: Uint8Array.from([1, ...new Array(SIGN_BYTES - 1).fill(0)]) }),
    encodeRecord({ q: Int8Array.from([0, 127, ...new Array(382).fill(0)]), s: 1 / 127, sign: Uint8Array.from([2, ...new Array(SIGN_BYTES - 1).fill(0)]) }),
  ];
  const binary = new Uint8Array(VEC_BYTES * records.length);
  records.forEach((record, index) => binary.set(record, index * VEC_BYTES));
  await writeFile(join(root, 'embeddings.mobile-a72520e0.0.bin'), binary);
  await writeFile(join(root, 'index.mobile-a72520e0.jsonl'), [
    { id: 'a', dim: 384, shard: 'mobile-a72520e0', seq: 0, off: 0, mtime: 1 },
    { id: 'b', dim: 384, shard: 'mobile-a72520e0', seq: 0, off: VEC_BYTES, mtime: 1 },
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
  await writeFile(join(root, 'MCP Export/documents.jsonl'), [
    { chunkId: 'a', notePath: 'one.md', title: 'One', content: 'alpha', chunkIndex: 0, mtime: 1 },
    { chunkId: 'b', notePath: 'two.md', title: 'Two', content: 'beta', chunkIndex: 0, mtime: 1 },
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
  return root;
}

test('loads and ranks vectors by cosine similarity', async () => {
  const index = await SeekIndex.load(await fixture());
  const queryVector = [0.9, 0.1, ...new Array(382).fill(0)];
  assert.equal(index.search(queryVector, 1)[0].chunkId, 'a');
  assert.equal(index.status().loadedChunks, 2);
});

test('rejects path traversal in note fetches', async () => {
  const index = await SeekIndex.load(await fixture());
  assert.throws(() => index.note('../private.md'), /invalid|escapes/);
});
