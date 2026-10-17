// Hydrate-before-embed: two ways a dirty file skips the model. dedupViaSidecar reuses another device's vectors from the sidecar; carryOverHydrate reuses this
// device's own vectors for content that merely moved. The host supplies stores, the chunker and the sidecar hydrate through the ctx.
import type { Chunk, ChunkMeta } from './types.ts';
import type { FileRecord, MetaConfig } from './index-types.ts';
import { stripContent } from './index-types.ts';
import type { QuantVec } from './quant.ts';
import type { LiveFile } from './delta.ts';
import type { DeltaAdd } from './search-helpers.ts';
import { chunkMetaEqual } from './search-helpers.ts';
import { MultiFieldBM25 } from './bm25.ts';
import { cyrb53Hex } from './chunker.ts';
import { enforceTokenBudget, embedInput } from './token-budget.ts';
import type { ReChunkedNote, HydrateResult } from './sidecar-types.ts';

interface ChunkingCtx<H> {
    embedder: { ensureTokenizer(): Promise<void>; tokenCounts(texts: string[]): Promise<number[]> };
    logger: { appendError(context: string, e: unknown): Promise<void> };
    read(file: LiveFile<H>): Promise<string>;
    chunksFor(content: string, path: string, modifiedIso: string | null): Chunk[];
}

export interface DedupCtx<H> extends ChunkingCtx<H> {
    coord: { sidecarOn(): boolean };
    store: {
        getFileRecord(path: string): Promise<FileRecord | undefined>;
        getChunkMetasByIds(ids: string[]): Promise<Map<string, ChunkMeta>>;
        getBodiesMap(ids: string[]): Promise<Map<string, string>>;
        deleteChunksByIds(ids: string[]): Promise<unknown>;
    };
    // Runs the sidecar hydrate engine over exactly these notes, inside the caller's write mutex (never re-enters it).
    hydrate(notes: ReChunkedNote[], addsSink?: DeltaAdd[]): Promise<HydrateResult>;
    _peerAhead: boolean;
}

export interface CarryOverHydrateCtx<H> extends ChunkingCtx<H> {
    store: {
        getFileRecord(path: string): Promise<FileRecord | undefined>;
        putBatchQuantized(chunks: Chunk[], tiers: { q: QuantVec; bin: Uint8Array }[], fileRecord?: FileRecord): Promise<void>;
        deleteChunksByIds(ids: string[]): Promise<unknown>;
    };
}

// fork 1.1.3 src/search.ts:3037 SearchOrchestrator.dedupViaSidecar
// Dedup-before-embed: hydrate the dirty files the sidecar already covers
// (another device embedded the same content) instead of re-embedding them,
// and return the files that still need the model. Pure optimization — a
// miss just embeds. Stale rows are handled HERE now (chunk-diff, issue #5:
// the delta's wholesale pre-delete is gone): after a note hydrates, any
// old-record id its new chunk set no longer references is deleted + surfaced
// through the removal sinks, exactly like the engine's diff. Pre-edit ids
// lingering in existingIds are harmless — coverage is judged against the
// NEW chunk ids, and a still-present id just means "nothing to hydrate"
// (which now correctly skips re-writing rows a revert already has).
export async function dedupViaSidecar<H>(
    ctx: DedupCtx<H>,
    files: LiveFile<H>[],
    addsSink?: DeltaAdd[],
    removedSink?: string[],
    removedBodiesSink?: Map<string, string>,
    metaPatchSink?: Array<{ id: string; meta: ChunkMeta }>,
): Promise<LiveFile<H>[]> {
    if (!ctx.coord.sidecarOn() || files.length === 0) return files;
    // Same chunk_id-reproduction requirement as reChunkLive: apply the
    // token-budget split so split notes match the sidecar (without it this
    // dedup silently missed every long note and re-embedded it). The model
    // is loaded on this path (reindexDelta's embed half), so ensureTokenizer
    // is a no-op; the guard just makes the dependency explicit.
    await ctx.embedder.ensureTokenizer();
    const notes: ReChunkedNote[] = [];
    for (const f of files) {
        let content: string;
        try {
            content = await ctx.read(f);
        } catch {
            continue;
        }
        let chunks = ctx.chunksFor(content, f.path, new Date(f.mtime).toISOString());
        if (chunks.length === 0) continue;
        try {
            chunks = (await enforceTokenBudget(chunks, ts => ctx.embedder.tokenCounts(ts))).chunks;
        } catch (e) {
            await ctx.logger.appendError(`dedupViaSidecar-tokenBudget:${f.path}`, e);
            continue;
        }
        if (chunks.length > 0) notes.push({ notePath: f.path, mtimeMs: f.mtime, chunks, contentHash: cyrb53Hex(content) });
    }
    if (notes.length === 0) return files;
    // Called from inside reindexDelta's runExclusive — invoke the engine
    // directly (NOT hydrateSidecar, which would re-enter the mutex). addsSink
    // (when the delta path supplies it) surfaces the hydrated chunks into the
    // change-set so applyDelta can apply them incrementally.
    // Old records AND old metas of id-stable chunks read BEFORE the hydrate
    // overwrites them — the stale-row cleanup and the id-stable metadata
    // reconciliation below both diff against pre-hydrate state.
    const oldRecs = new Map<string, FileRecord>();
    const oldStableMetas = new Map<string, ChunkMeta>();
    for (const n of notes) {
        const rec = await ctx.store.getFileRecord(n.notePath).catch(() => null);
        if (!rec) continue;
        oldRecs.set(n.notePath, rec);
        const newIdSet = new Set(n.chunks.map(c => c.chunk_id));
        const stableIds = rec.chunk_ids.filter(id => newIdSet.has(id));
        if (stableIds.length > 0) {
            try {
                for (const [id, m] of await ctx.store.getChunkMetasByIds(stableIds)) oldStableMetas.set(id, m);
            } catch { /* classification degrades to nothing; the engine path heals on the next edit */ }
        }
    }
    const res = await ctx.hydrate(notes, addsSink);
    ctx._peerAhead = res.peerAhead; // refresh the "newer index exists" signal per scan
    const done = new Set(res.hydratedNotePaths);
    // Reconciliation for hydrated notes (chunk-diff, issue #5). The hydrate
    // rewrote EVERY chunk's IDB rows and pushed them all into addsSink, but
    // applyDelta's freshDeltaAdds drops the ones whose id is still LIVE in
    // the row space — so without the lanes below, an id-stable chunk whose
    // note-level metadata drifted (inline #tag in another section) would
    // have fresh IDB meta and a stale frame/BM25 doc FOREVER (the next
    // diff compares IDB-old vs new, sees them equal, and never patches).
    //   - stale ids (dropped from the note): delete + exact-removal entries.
    //   - id-stable, meta drifted, BM25-irrelevant: metaPatchSink (frame swap).
    //   - id-stable, BM25-relevant drift: removal entry; the hydrate's OWN
    //     addsSink entry then survives freshDeltaAdds (row freed) and
    //     re-adds the doc with fresh meta — no extra add needed here.
    const newChunksByPath = new Map(notes.map(n => [n.notePath, n.chunks]));
    for (const p of res.hydratedNotePaths) {
        const rec = oldRecs.get(p);
        const newChunks = newChunksByPath.get(p);
        if (!rec || !newChunks) continue;
        const newIdSet = new Set(newChunks.map(c => c.chunk_id));
        const stale = rec.chunk_ids.filter(id => !newIdSet.has(id));
        try {
            if (stale.length > 0) {
                if (removedBodiesSink) {
                    for (const [id, body] of await ctx.store.getBodiesMap(stale)) removedBodiesSink.set(id, body);
                }
                await ctx.store.deleteChunksByIds(stale);
                removedSink?.push(...stale);
            }
            for (const c of newChunks) {
                const old = oldStableMetas.get(c.chunk_id);
                if (!old) continue;                       // genuinely new — hydrate's add covers it
                const next = stripContent(c);
                if (chunkMetaEqual(old, next)) continue;  // untouched
                if (MultiFieldBM25.docFieldsEqual(old, next)) {
                    metaPatchSink?.push({ id: c.chunk_id, meta: next });
                } else if (removedSink && removedBodiesSink) {
                    removedBodiesSink.set(c.chunk_id, c.content ?? '');
                    removedSink.push(c.chunk_id);
                }
            }
        } catch (e) {
            await ctx.logger.appendError(`sidecarDedup-stale-cleanup:${p}`, e);
        }
    }
    return files.filter(f => !done.has(f.path));
}

// fork 1.1.3 src/search.ts:3177 SearchOrchestrator.carryOverHydrate
// F13: re-chunk each candidate and, if EVERY chunk's embed text is in the
// carry-over map, write the chunks with their REUSED tiers (verbatim, no model
// forward pass) and drop the file from the embed set. All-or-nothing per note,
// mirroring dedupViaSidecar: a partially-changed file falls through to a normal
// embed. The headline win is a folder reorg (pure moves) re-keying for free.
export async function carryOverHydrate<H>(
    ctx: CarryOverHydrateCtx<H>,
    files: LiveFile<H>[],
    carryOver: Map<string, { q: QuantVec; sign: Uint8Array }>,
): Promise<LiveFile<H>[]> {
    if (carryOver.size === 0 || files.length === 0) return files;
    // The model-loaded embed path already has the tokenizer; the guard just
    // makes the chunk_id-reproduction dependency explicit (as in dedupViaSidecar).
    await ctx.embedder.ensureTokenizer();
    const done = new Set<string>();
    for (const f of files) {
        let content: string;
        try { content = await ctx.read(f); } catch { continue; }
        let chunks = ctx.chunksFor(content, f.path, new Date(f.mtime).toISOString());
        if (chunks.length === 0) continue;
        try {
            chunks = (await enforceTokenBudget(chunks, ts => ctx.embedder.tokenCounts(ts))).chunks;
        } catch (e) {
            await ctx.logger.appendError(`carryOver-tokenBudget:${f.path}`, e);
            continue;
        }
        if (chunks.length === 0) continue;
        const tiers = chunks.map(c => carryOver.get(embedInput(c)));
        if (tiers.some(t => t === undefined)) continue;   // not fully covered → embed normally
        // The delta no longer pre-deletes a dirty file's rows (chunk-diff,
        // issue #5), so the old record — read BEFORE the overwrite below —
        // tells us which rows the hydrated chunk set no longer references.
        // They must be dropped or they orphan into ghost results on the next
        // cold frame rebuild. No change-set entries needed: a carry-over
        // delta always takes the full-rebuild path (carriedOver > 0).
        const oldRec = await ctx.store.getFileRecord(f.path).catch(() => null);
        // One atomic tx for chunks + record (S1), same as commitFile.
        try {
            await ctx.store.putBatchQuantized(chunks, tiers.map(t => ({ q: t!.q, bin: t!.sign })),
                { note_path: f.path, mtimeMs: f.mtime, chunk_ids: chunks.map(c => c.chunk_id), contentHash: cyrb53Hex(content) });
        } catch (e) {
            // A commit failure (quota, closing store) must not abort the whole
            // delta burst. Leave the file OUT of `done`: it falls through to
            // the normal embed path, whose per-file catch classifies quota
            // (S2) and keeps the file dirty for catch-up.
            await ctx.logger.appendError(`carryOver-commit:${f.path}`, e);
            continue;
        }
        if (oldRec) {
            const newIdSet = new Set(chunks.map(c => c.chunk_id));
            const stale = oldRec.chunk_ids.filter(id => !newIdSet.has(id));
            if (stale.length > 0) {
                await ctx.store.deleteChunksByIds(stale)
                    .catch(e => ctx.logger.appendError(`carryOver-stale-cleanup:${f.path}`, e));
            }
        }
        done.add(f.path);
    }
    return files.filter(f => !done.has(f.path));
}
