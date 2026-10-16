// Chunk-diff planner: given a dirty file's freshly produced chunks and what the store already holds, decide per chunk whether it is untouched, only its
// metadata moved, its BM25 fields moved (re-add with the STORED vector), or it truly needs embedding. Pure decision logic over a narrow store port, so any host
// that can read and write those six store operations (IndexedDB in the plugin; a file-backed store for an MCP writer) plans identically.
import type { Chunk, ChunkMeta } from './types.ts';
import type { QuantVec } from './quant.ts';
import { MultiFieldBM25 } from './bm25.ts';
import { embedInput } from './token-budget.ts';
import { stripContent, type FileRecord } from './index-types.ts';
import { chunkMetaEqual, type DeltaAdd } from './search-helpers.ts';

export interface DiffStore {
    getFileRecord(path: string): Promise<FileRecord | undefined>;
    getBodiesMap(ids: string[]): Promise<Map<string, string>>;
    deleteChunksByIds(ids: string[]): Promise<void>;
    getChunkMetasByIds(ids: string[]): Promise<Map<string, ChunkMeta>>;
    getTiersByIds(ids: string[]): Promise<Array<{ chunk: Chunk; q: QuantVec; sign: Uint8Array } | null>>;
    putChunkMetas(metas: ChunkMeta[]): Promise<void>;
}

// Chunk-diff plan for one dirty file (issue #5). Returns null when there is
// no stored record (new file) — the caller embeds everything. On a plan:
// stale rows are deleted (bodies captured first for the exact-removal
// patch), id-stable chunks are classified untouched / meta-patch /
// reindex-row, and only genuinely-new ids remain to embed:
//   - untouched: byte-identical ChunkMeta → nothing anywhere.
//   - meta-patch: metadata drifted but none of it is BM25-indexed (line
//     numbers after an edit above the chunk, created/modified dates) → IDB
//     meta row refreshed here, frame row swapped in place by applyDelta.
//   - reindex-row: BM25-indexed metadata drifted while the id held (an
//     inline #tag in another section, a wikilink-target swap, a shape-junk
//     property) → IDB meta refreshed here; the row rides the change-set as
//     remove + re-add with its STORED tiers — no model forward pass.
// Vector reuse is licensed by an EXPLICIT embed-text comparison, not by id
// equality: on the v10 chunker "same id ⟹ same embed text" is provable
// (embedInput consumes a strict subset of the id hash), but chunker lines
// where the two compositions diverge (v11's per-chunk keyed suffix reads
// metadata the note-level id hash summarizes lossily — e.g. a property KEY
// rename moves the embed text but not the id) would silently reuse a stale
// vector. Comparing the real embedInput old-vs-new makes the license hold
// under ANY composition; a divergent chunk simply re-embeds.
// Any read failure throws to the caller, whose fallback restores the
// pre-diff wholesale delete + full re-embed.
export async function planFileDiff(
    store: DiffStore,
    path: string,
    fileChunks: Chunk[],
    budget: { addsSink?: DeltaAdd[]; removedSink: string[]; removedBodiesSink: Map<string, string>; metaPatchSink: Array<{ id: string; meta: ChunkMeta }> },
): Promise<{ keepIds: Set<string>; embedIds: Set<string> } | null> {
    const rec = await store.getFileRecord(path);
    if (!rec || rec.chunk_ids.length === 0) return null;
    const newIds = new Set(fileChunks.map(c => c.chunk_id));
    const staleIds = rec.chunk_ids.filter(id => !newIds.has(id));
    const oldIdSet = new Set(rec.chunk_ids);
    // Stale rows: capture bodies for removeExact, then delete. The sink gets
    // the ids AFTER the IDB delete so the change-set only holds applied rows.
    if (staleIds.length > 0) {
        for (const [id, body] of await store.getBodiesMap(staleIds)) budget.removedBodiesSink.set(id, body);
        await store.deleteChunksByIds(staleIds);
        budget.removedSink.push(...staleIds);
    }
    const keepIds = new Set<string>();
    const embedIds = new Set<string>();
    const stable: Chunk[] = [];
    for (const c of fileChunks) {
        if (oldIdSet.has(c.chunk_id)) stable.push(c);
        else embedIds.add(c.chunk_id);
    }
    if (stable.length > 0) {
        const oldMetas = await store.getChunkMetasByIds(stable.map(c => c.chunk_id));
        const metaPuts: ChunkMeta[] = [];
        // Pass 1: classify. Reindex-row candidates are collected so their
        // tier read is ONE batched transaction, not one per chunk — the
        // whole-note tag edit puts ~every chunk in this lane, and N serial
        // 4-store transactions inside the write mutex is exactly the
        // per-commit IDB tax this fix exists to remove.
        const reindexRows: Chunk[] = [];
        for (const c of stable) {
            const old = oldMetas.get(c.chunk_id);
            if (!old) { embedIds.add(c.chunk_id); continue; }   // meta row missing (torn IDB) — re-embed heals
            // The vector-reuse license (see the method comment): identical
            // bodies are id-guaranteed, so old embed text reconstructs from
            // the stored meta + this body.
            if (embedInput({ ...old, content: c.content ?? '' }) !== embedInput(c)) {
                embedIds.add(c.chunk_id);
                continue;
            }
            const next = stripContent(c);
            if (chunkMetaEqual(old, next)) { keepIds.add(c.chunk_id); continue; }
            if (MultiFieldBM25.docFieldsEqual(old, next)) {
                metaPuts.push(next);
                budget.metaPatchSink.push({ id: c.chunk_id, meta: next });
                keepIds.add(c.chunk_id);
            } else {
                reindexRows.push(c);
            }
        }
        // Pass 2: the batched tier read + the change-set entries.
        if (reindexRows.length > 0) {
            const tiers = await store.getTiersByIds(reindexRows.map(c => c.chunk_id));
            for (let i = 0; i < reindexRows.length; i++) {
                const c = reindexRows[i];
                const tier = tiers[i];
                if (!tier) { embedIds.add(c.chunk_id); continue; }   // vector row missing — re-embed heals
                // Removal reconstruction uses the OLD meta (the frame row) +
                // this body — identical bytes by content-addressing.
                metaPuts.push(stripContent(c));
                budget.removedBodiesSink.set(c.chunk_id, c.content ?? '');
                budget.removedSink.push(c.chunk_id);
                budget.addsSink?.push({ chunk: c, q: tier.q, bin: tier.sign });
                keepIds.add(c.chunk_id);
            }
        }
        if (metaPuts.length > 0) await store.putChunkMetas(metaPuts);
    }
    return { keepIds, embedIds };
}
