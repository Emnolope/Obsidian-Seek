// Incremental cache maintenance: mutate a live BM25 index + resident frame in place from a delta's change-set. The state it touches (frame, index, generation,
// synonym map) belongs to the host and arrives through ApplyCtx, so the same patcher can keep a plugin's caches, or an MCP writer's RAM index, coherent.
import type { ChunkMeta, SeekSettings } from './types.ts';
import type { MultiFieldBM25 } from './bm25.ts';
import { buildSynonymMap, chunkDeclaresAlias, type SynonymMap } from './synonyms.ts';
import {
    COMPACTION_TOMBSTONE_FRACTION, appendFrameRows, freshDeltaAdds, frameBm25Coherent, tombstoneFrameRows,
    type DeltaAdd, type ResidentFrame,
} from './search-helpers.ts';

export interface ApplyCtx {
    frame: ResidentFrame | null;
    bm: MultiFieldBM25 | null;
    settings: SeekSettings;
    // What the BM25 cache was fit under; a mismatch with settings means the field set changed and only a refit is correct.
    bm25Generation: number;
    bm25Props: boolean;
    bm25Headings: boolean;
    generation(): number;
    bumpGeneration(): void;
    // Re-stamps the patched BM25 cache to the new generation so the next search hits it.
    stamp(chunkCount: number): void;
    setSynonyms(map: SynonymMap): void;
    // Records why the incremental path declined; returns false so callers can `return ctx.fallback(...)`.
    fallback(reason: string, detail?: Record<string, unknown>): false;
    logError(tag: string, e: unknown): Promise<void>;
}

// Incremental cache maintenance (Seek scaling A1). Mutate the live BM25 index +
// resident frame in place from a delta's change-set instead of nuking and
// full-rebuilding — per-edit work drops from O(N) to O(edit size + affected
// terms). Returns true on a clean patch; false means the caller must fall back
// to invalidateBm25Cache() + warmCaches (a full rebuild). Correctness NEVER
// depends on the incremental path: every "can't safely apply" condition (cold
// caches, index-shape flip, sidecar hydrate, dim change, missing/mismatched
// removal doc, post-patch drift, due compaction) returns false and degrades
// to "slow", never "wrong".
//
// MUST run inside reindexDelta's runExclusive critical section: it mutates
// both caches and re-stamps the generation atomically, so a concurrent search
// (which waits on coord.currentDelta in ensureFrame) sees either the old cache
// or the fully-patched one, never a half-mutated frame. Since removals became
// exact (removeExact) there is no in-mutex vacuum — the whole patch is
// O(delta), never O(index), so the mutex hold no longer scales with the vault.
export async function applyDelta(
    ctx: ApplyCtx,
    adds: DeltaAdd[],
    removedIds: string[],
    removedBodies: ReadonlyMap<string, string>,
    metaPatches: ReadonlyArray<{ id: string; meta: ChunkMeta }> = [],
): Promise<boolean> {
    const frame = ctx.frame;
    const bm = ctx.bm;
    if (!frame || !bm) return ctx.fallback('cold caches');
    if (frame.generation !== ctx.generation()
        || ctx.bm25Generation !== ctx.generation()) return ctx.fallback('stale cache generation');
    // An index-shape flip changes the BM25 field set → must refit from scratch.
    if (ctx.bm25Props !== ctx.settings.searchableProperties
        || ctx.bm25Headings !== (ctx.settings.headingsField || ctx.settings.boostedBm25)) {
        return ctx.fallback('index-shape settings changed');
    }
    // Sidecar-hydrated rows ARE surfaced in `adds` now (dedupViaSidecar →
    // hydrateDeps.putQuantized → pushDeltaAdds), so a dedup delta applies
    // incrementally like any other — no sidecar-specific fallback.
    // Dim guard: a committed vector whose int8 dim differs from the resident
    // block's is a model/dim change mid-stream → rebuild. (Model drift normally
    // defers embeds so `adds` is empty; this guards a partial-stamp index.)
    if (frame.residentInt8 && adds.some(a => a.q.q.length !== frame.embDim)) {
        return ctx.fallback('embedding dim mismatch');
    }

    // Resolve each removal to its reconstruction doc BEFORE mutating anything:
    // a missing body (capture skipped or failed in captureRemovalBodies)
    // declines the patch with the caches completely untouched — the cheapest
    // possible fallback. Ids with no live row are already gone (the historic
    // remove(id) tolerance for IDB↔cache divergence) and are skipped.
    const removals: Array<{ row: number; meta: ChunkMeta; body: string }> = [];
    for (const id of removedIds) {
        const row = bm.rowOf(id);
        if (row === undefined) continue;
        const body = removedBodies.get(id);
        if (body === undefined) return ctx.fallback('removal-body-missing');
        removals.push({ row, meta: frame.orderedChunks[row], body });
    }

    // Removes first, then adds: an edit re-commits the SAME content-hash id only
    // after its stale chunk was dropped, so remove-before-add means mini.add()
    // never collides with a live duplicate. Rows were captured above BEFORE
    // removeExact() drops them from idToIdx, so the frame tombstones the right
    // holes. Wrapped in try/catch for exception safety: a throw mid-patch leaves
    // the in-place mutation half-applied, so degrade to a full rebuild (the caller
    // invalidates the suspect caches on a false return and re-warms from IDB,
    // the source of truth) rather than letting it escape — "slow, never wrong",
    // and never the crash-loop a thrown bm.add() caused on 2026-06-18.
    // The adds that actually land after the duplicate filter (declared out here
    // so the success log reports the true row count, not the pre-filter total).
    let fresh: DeltaAdd[] = [];
    // Did this delta touch an alias-bearing note? If not, the synonym
    // dictionary is provably unchanged and its O(notes) rebuild is skipped at
    // the commit below (chunkDeclaresAlias). Tracked across BOTH removes (an
    // alias deletion/edit drops the old alias-bearing row) and adds, so an
    // alias EDIT — remove-old + add-new — trips it from either side.
    let aliasDictDirty = false;
    try {
        const removeRows: number[] = [];
        for (const r of removals) {
            removeRows.push(r.row);
            if (chunkDeclaresAlias(r.meta)) aliasDictDirty = true;
            // Exact synchronous removal: postings cleaned NOW from the doc as
            // indexed (content-addressed body + as-committed frame meta) — no
            // discard tombstones, no vacuum debt, no first-search df drift. A
            // 'mismatch' means that reconstruction contract broke; the half-
            // removed doc makes the whole patch suspect, so decline and let
            // the caller rebuild from IDB truth.
            if (bm.removeExact(r.meta, r.body) === 'mismatch') return ctx.fallback('removal-mismatch');
        }
        tombstoneFrameRows(frame, removeRows);
        // Drop adds whose id is already live in the row space (a hydrate-sourced
        // duplicate from an IDB↔cache divergence) or repeated within the batch;
        // see freshDeltaAdds. Runs AFTER the removes so edit re-commits survive.
        // The SAME list feeds bm.add and appendFrameRows → row spaces stay aligned.
        fresh = freshDeltaAdds(adds, id => bm.rowOf(id) !== undefined);
        if (!aliasDictDirty) aliasDictDirty = fresh.some(a => chunkDeclaresAlias(a.chunk));
        for (const a of fresh) bm.add(a.chunk, a.chunk.content ?? '');
        appendFrameRows(frame, fresh);
        // Meta-patches (chunk-diff, issue #5): id-stable chunks whose
        // BM25-irrelevant metadata drifted (line numbers after an edit above
        // them, dates). In-place frame row swap — same id, same row, same
        // vector; BM25 untouched (docFieldsEqual gated upstream). A missing
        // row means the frame diverged from the engine's view — decline.
        for (const p of metaPatches) {
            const row = bm.rowOf(p.id);
            if (row === undefined) return ctx.fallback('meta-patch-row-missing');
            frame.orderedChunks[row] = p.meta;
        }
    } catch (e) {
        // console.* is invisible on mobile (no devtools) — write the NDJSON device
        // log too, so a recurring patch-throw stays field-observable. That exact
        // telemetry channel root-caused the 2026-06-18 meltdown; a silent
        // console.error would now hide any future throw past the L1 filter.
        console.error('[seek] applyDelta threw mid-patch — dropping to full rebuild', e);
        void ctx.logError('applyDelta-patch', e).catch(() => {});
        return ctx.fallback('exception during patch');
    }

    // Drift detector: verify the row-space coupling survived the patch. On ANY
    // mismatch, abandon the (suspect) patch — the caller's invalidate+rebuild
    // makes it "slow, never wrong".
    if (!frameBm25Coherent(frame, bm)) {
        console.error('[seek] applyDelta produced an incoherent frame/BM25 row space');
        return ctx.fallback('row-space drift');
    }

    // Compaction: too many tombstone holes → rebuild densely (the amortized O(N)
    // renumber). Returning false routes that through invalidate+warmCaches.
    const n = frame.orderedChunks.length;
    if (n > 0 && frame.tombstoneCount / n >= COMPACTION_TOMBSTONE_FRACTION) {
        return ctx.fallback('compaction due', { tombstones: frame.tombstoneCount, rows: n });
    }

    // Commit: bump the generation so other readers re-validate, then re-stamp
    // the patched caches to it so the next search hits them (no rebuild).
    ctx.bumpGeneration();
    frame.generation = ctx.generation();
    ctx.stamp(bm.size);
    // Synonym dict derives ONLY from alias-bearing notes (see chunkDeclaresAlias
    // / buildClasses), so refresh it — over LIVE rows only — when the expansion
    // toggle is on AND this delta actually touched an alias. A body-only edit
    // can't change the dictionary, so it skips the O(notes) rebuild. (The
    // df-ceiling guard then rides slightly stale between alias deltas; it's a
    // coarse 5% junk filter, refreshed on the next alias-touching delta, full
    // reindex, or cold lazy build in ensureBm25.)
    if (ctx.settings.synonymExpansion && aliasDictDirty) {
        const liveChunks = frame.tombstoneCount === 0
            ? frame.orderedChunks
            : frame.orderedChunks.filter((_, i) => frame.validRows[i]);
        ctx.setSynonyms(buildSynonymMap(liveChunks, t => bm.termDocFraction(t)));
    }
    // persistBm25 is no longer skipped here (2026-06-20): the caller re-persists
    // this patched index after the mutex via maybePersistResidentBm25 (throttled,
    // embed-free). The old skip assumed a cold stamp would reject the drifted
    // chunkCount anyway — but the tolerant gate now LOADS it, so keeping the disk
    // blob fresh is what lets a cold relaunch skip the all-bodies refit.
    // Report fresh.length (rows that landed), not adds.length — the difference is
    // duplicates the L1 filter absorbed; surface it so the hydrate-divergence
    // signal stays visible in the very telemetry used to diagnose this bug class.
    const filtered = adds.length - fresh.length;
    if (filtered > 0) console.warn(`[seek] applyDelta absorbed ${filtered} already-live/in-batch duplicate add(s) — hydrate/cache divergence`);
    return true;
}
