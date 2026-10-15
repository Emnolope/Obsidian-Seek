// The point of the monorepo: what the plugin writes, the MCP server must read back
// identically. This test drives the REAL plugin exporter and the REAL MCP loader
// over one directory, so a format/convention change that breaks either side fails here.

import { mkdtemp, mkdir, readFile, writeFile, rm, rename, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportMcpIndex, MCP_EXPORT_DIR } from '../src/mcp-export';
import { ACTIVE_MODEL_SPEC } from '../src/model-registry';
import { SeekIndex } from '../mcp/src/index.ts';
import { SEEK_MODEL } from '../mcp/src/seek-compatibility.ts';
import { EMBEDDING_DIM, SIDECAR_FORMAT } from './contract.ts';
import { decodeRecord, encodeRecord, resolveJsonls, SIGN_BYTES, VEC_BYTES, type TierBytes } from './format.ts';

const DEV = 'desktop-2b7e54aa';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

// Just enough of Obsidian's DataAdapter, backed by a real directory.
function adapterAt(root: string) {
    const abs = (p: string) => join(root, p);
    return {
        mkdir: async (p: string) => { await mkdir(abs(p), { recursive: true }); },
        write: async (p: string, d: string) => { await writeFile(abs(p), d); },
        exists: async (p: string) => stat(abs(p)).then(() => true, () => false),
        remove: async (p: string) => { await rm(abs(p), { recursive: true, force: true }); },
        rename: async (a: string, b: string) => { await rename(abs(a), abs(b)); },
    } as never;
}

function tier(axis: number): TierBytes {
    const q = new Int8Array(EMBEDDING_DIM); q[axis] = 127;
    return { q, s: 1 / 127, sign: new Uint8Array(SIGN_BYTES) };
}

async function seed(chunks: Array<{ id: string; note: string; axis: number }>, tombstones: string[] = []) {
    const root = await mkdtemp(join(tmpdir(), 'seek-parity-'));
    dirs.push(root);
    const indexDir = join(root, 'Seek Index');
    await mkdir(indexDir, { recursive: true });
    const bin = new Uint8Array(VEC_BYTES * chunks.length);
    chunks.forEach((c, i) => bin.set(encodeRecord(tier(c.axis)), i * VEC_BYTES));
    await writeFile(join(indexDir, `embeddings.${DEV}.0.bin`), bin);
    const lines = chunks.map((c, i) => ({ id: c.id, dim: EMBEDDING_DIM, shard: DEV, seq: 0, off: i * VEC_BYTES, mtime: 1 }));
    const dead = tombstones.map(id => ({ id, shard: DEV, tombstone: true, mtime: 2 }));
    await writeFile(join(indexDir, `index.${DEV}.jsonl`), [...lines, ...dead].map(r => JSON.stringify(r)).join('\n') + '\n');
    await writeFile(join(indexDir, `meta.${DEV}.json`), JSON.stringify({ dim: EMBEDDING_DIM, format: SIDECAR_FORMAT }));
    const store = {
        listAllMeta: async () => chunks.map(c => ({ chunk_id: c.id, title: `T ${c.id}`, note_path: c.note, heading_path: [], tags: [], aliases: [], created: null, modified: null, properties: {} })),
        getBodiesMap: async () => new Map(chunks.map(c => [c.id, `body ${c.id}`])),
        listFileRecords: async () => chunks.map(c => ({ note_path: c.note, mtimeMs: 1, chunk_ids: [c.id] })),
        listAllEmbeddings: async () => ({ ids: chunks.map(c => c.id), vecs: chunks.map(() => ({})) }),
    } as never;
    await exportMcpIndex(adapterAt(root), store);
    return indexDir;
}

describe('plugin writer ↔ MCP reader', () => {
    it('round-trips an export and ranks by the stored vectors', async () => {
        const indexDir = await seed([{ id: 'a', note: 'one.md', axis: 0 }, { id: 'b', note: 'dir/two.md', axis: 1 }]);
        expect((await readdir(join(indexDir, '..', MCP_EXPORT_DIR.split('/')[0]))).includes('MCP Export')).toBe(true);
        const idx = await SeekIndex.load(indexDir);
        const q = new Array(EMBEDDING_DIM).fill(0); q[1] = 1;
        expect((await idx.search({ vector: q, topK: 1 }))[0].chunkId).toBe('b');
        expect(idx.note('dir/two.md')[0].content).toBe('body b');
        expect(idx.status().diagnostics).toMatchObject({ exportedDocuments: 2, loadedDocuments: 2, skippedDocuments: 0 });
    });

    it('honors tombstones the same way the plugin does (MCP skips the deleted chunk)', async () => {
        const indexDir = await seed([{ id: 'a', note: 'one.md', axis: 0 }, { id: 'b', note: 'two.md', axis: 1 }], ['b']);
        const idx = await SeekIndex.load(indexDir);
        expect(idx.documents.map(d => d.chunkId)).toEqual(['a']);
        expect(idx.status().diagnostics.skippedDocuments).toBe(1);
    });
});

describe('format contract', () => {
    it('record codec round-trips and rejects bit-rot', () => {
        const enc = encodeRecord(tier(3));
        expect(enc.length).toBe(VEC_BYTES);
        const buf = enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength) as ArrayBuffer;
        expect(decodeRecord(buf, 0).q[3]).toBe(127);
        new Uint8Array(buf)[5] ^= 1;
        expect(() => decodeRecord(buf, 0)).toThrow(/CRC/);
    });

    it('a malformed jsonl line is skipped, not fatal', () => {
        const ok = JSON.stringify({ id: 'a', dim: EMBEDDING_DIM, shard: DEV, seq: 0, off: 0, mtime: 1 });
        const r = resolveJsonls([`${ok}\n{not json}\n`]);
        expect([...r.map.keys()]).toEqual(['a']);
        expect(r.skippedLines).toBe(1);
    });

    it('model registry and MCP model constants agree with the contract', () => {
        expect(ACTIVE_MODEL_SPEC.dim).toBe(EMBEDDING_DIM);
        expect(SEEK_MODEL.dimension).toBe(EMBEDDING_DIM);
        expect(SEEK_MODEL.repo).toBe(ACTIVE_MODEL_SPEC.repo);
        expect(SEEK_MODEL.revision).toBe(ACTIVE_MODEL_SPEC.revision);
    });
});
