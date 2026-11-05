import { describe, expect, it } from 'vitest';
import { exportIndex, EXPORT_DIRNAME, EXPORT_DOCS_FILE, EXPORT_META_FILE } from './index-export';

function memAdapter() {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    const a = {
        mkdir: async (p: string) => { dirs.add(p); },
        write: async (p: string, d: string) => { files.set(p, d); },
        exists: async (p: string) => dirs.has(p),
        remove: async (p: string) => { dirs.delete(p); for (const k of [...files.keys()]) if (k.startsWith(`${p}/`)) files.delete(k); },
        rename: async (from: string, to: string) => {
            dirs.delete(from); dirs.add(to);
            for (const k of [...files.keys()]) if (k.startsWith(`${from}/`)) { files.set(`${to}${k.slice(from.length)}`, files.get(k)!); files.delete(k); }
        },
    };
    return { a: a as never, files };
}

const meta = (id: string) => ({ chunk_id: id, title: `T ${id}`, note_path: 'n.md', heading_path: [], tags: [], aliases: [], created: null, modified: null, properties: {} });
const store = (ids: string[], bodies = ids) => ({
    listAllMeta: async () => ids.map(meta),
    getBodiesMap: async () => new Map(bodies.map(id => [id, `body ${id}`])),
    listFileRecords: async () => [{ note_path: 'n.md', mtimeMs: 7, chunk_ids: ids }],
}) as never;

describe('exportIndex', () => {
    it('writes documents + meta into the active index dir', async () => {
        const { a, files } = memAdapter();
        const m = await exportIndex(a, store(['a', 'b']), '.obsidian/plugins/seek/index');
        const base = `.obsidian/plugins/seek/index/${EXPORT_DIRNAME}`;
        const docs = files.get(`${base}/${EXPORT_DOCS_FILE}`)!.trim().split('\n').map(l => JSON.parse(l));
        expect(docs.map(d => [d.chunkId, d.chunkIndex, d.content])).toEqual([['a', 0, 'body a'], ['b', 1, 'body b']]);
        expect(JSON.parse(files.get(`${base}/${EXPORT_META_FILE}`)!)).toMatchObject({ chunkCount: 2, generation: m.generation });
    });
    it('falls back to Seek Index when the sidecar is off', async () => {
        const { a, files } = memAdapter();
        await exportIndex(a, store(['a']));
        expect([...files.keys()].every(k => k.startsWith(`Seek Index/${EXPORT_DIRNAME}/`))).toBe(true);
    });
    it('fails loudly on a chunk with no body instead of dropping it', async () => {
        const { a } = memAdapter();
        await expect(exportIndex(a, store(['a', 'b'], ['a']))).rejects.toThrow(/incomplete export join for b/);
    });
});
