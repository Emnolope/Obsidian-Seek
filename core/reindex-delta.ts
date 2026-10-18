// Incremental index update, host-independent: the structural drops, the carry-over / sidecar-dedup / embed phases, cache patching and the meta stamp. The plugin
// supplies Obsidian file lookup, the embedder and the resident caches through ReindexDeltaCtx; an MCP writer can supply its own.
import type { ChunkMeta, IndexCompleteEntry, DeltaApplyEntry } from './types.ts';
import { snapshotMemory } from './types.ts';
import type { MetaConfig, IndexIdentity } from './index-types.ts';
import { META_SCHEMA_VERSION, shouldStampLiveIdentity } from './index-types.ts';
import { LEGACY_ENGLISH_MODEL_ID } from './contract.ts';
import type { QuantVec } from './quant.ts';
import type { LiveFile } from './delta.ts';
import type { DeltaAdd } from './search-helpers.ts';
import type { SidecarFlushJob } from './embed-commit.ts';
import { captureRemovalBodies, type DiffStore } from './file-diff.ts';

export interface ReindexDeltaCtx<H> {
    coord: { runExclusive<T>(fn: () => Promise<T>): Promise<T>; currentDelta: Promise<void> | null };
    store: DiffStore & {
        count(): Promise<{ chunks: number }>;
        getMeta(): Promise<MetaConfig>;
        setMeta(meta: MetaConfig): Promise<void>;
        deleteFile(path: string): Promise<string[]>;
    };
    embedder: { readonly loaded: boolean; readonly modelId: string };
    logger: { append(entry: DeltaApplyEntry): Promise<void> };
    // Live getters: the resident caches can be dropped or rebuilt while a delta waits on the mutex.
    readonly frameCache: object | null;
    readonly bm25Cache: object | null;
    lastDeltaFallbackReason: string | null;
    EMBEDDING_DIM: number;
    identity(): IndexIdentity;
    shouldIndex(path: string): boolean;
    // null when the path is not a live file (deleted, or a folder).
    getAbstractFileByPath(path: string): LiveFile<H> | null;
    harvestCarryOverInto(map: Map<string, { q: QuantVec; sign: Uint8Array }>, paths: string[]): Promise<void>;
    carryOverHydrate(files: LiveFile<H>[], carryOver: Map<string, { q: QuantVec; sign: Uint8Array }>): Promise<LiveFile<H>[]>;
    dedupViaSidecar(
        files: LiveFile<H>[], addsSink?: DeltaAdd[], removedSink?: string[], removedBodiesSink?: Map<string, string>,
        metaPatchSink?: Array<{ id: string; meta: ChunkMeta }>,
    ): Promise<LiveFile<H>[]>;
    embedAndCommitFiles(
        files: LiveFile<H>[], mode: 'full' | 'incremental', onProgress: ((msg: string) => void) | undefined, overallStart: number,
        memBefore: Awaited<ReturnType<typeof snapshotMemory>>,
        budget: {
            budgetMs?: number; shouldContinue?: () => boolean; addsSink?: DeltaAdd[]; storeWasEmpty?: boolean;
            removedSink?: string[]; removedBodiesSink?: Map<string, string>; metaPatchSink?: Array<{ id: string; meta: ChunkMeta }>;
        },
    ): Promise<{ entry: IndexCompleteEntry; sidecarJob: SidecarFlushJob | null; quarantineUnwound: number }>;
    applyDelta(
        adds: DeltaAdd[], removedIds: string[], removedBodies: ReadonlyMap<string, string>, metaPatches?: ReadonlyArray<{ id: string; meta: ChunkMeta }>,
    ): Promise<boolean>;
    invalidateBm25Cache(): void;
    flushSidecarAfterPass(job: SidecarFlushJob | null): Promise<void>;
    exportMcpAfterSuccessfulCommit(mode: 'full' | 'incremental'): Promise<void>;
    warmCaches(trigger: string): Promise<void>;
    reconcileGhostDirt(): boolean;
    maybePersistResidentBm25(): void;
}

// fork 1.1.3 src/search.ts:1740 SearchOrchestrator.reindexDelta
// Incremental index update. Two phases:
//   1. Structural (no embedder): drop deleted/moved-out paths. Always runs,
//      so deletes + move-into-ignored take effect even on a cold mobile model.
//   2. Embed (needs a loaded model): for dirty paths that should be indexed,
//      drop their stale chunks then re-chunk + re-embed via the shared engine.
//      Skipped when `opts.embed` is false (cold mobile) — the OLD version stays
//      searchable and, since the file's mtime is still ahead of its stored
//      record, the next computeDelta re-finds it once the model is warm.
// Returns null embedded-entry when the embed phase didn't run. Runs under the
// write mutex (so it can't overlap a full reindex or another delta) and sets
// `currentDelta` for its critical section so a concurrent search's frame
// rebuild waits for full application instead of reading a half-committed delta.
export async function reindexDelta<H>(
    ctx: ReindexDeltaCtx<H>,
    dirtyPaths: string[],
    deletedPaths: string[],
    // Per-burst budget for the catch-up drain: maxFiles caps how many dirty
    // files this call deletes+re-embeds (slice below — keeps deferred files
    // searchable); budgetMs/shouldContinue are the within-burst aborts passed to
    // the engine. Omitted = unbounded (desktop, flushDirty, reindexAll).
    // onProgress: optional live-progress stream (embedAndCommitFiles calls it
    // in 'incremental' mode). No caller wires it to a Notice — indexing toasts
    // are start + end-summary only; live progress belongs to the settings tab.
    opts: { embed: boolean; maxFiles?: number; budgetMs?: number; shouldContinue?: () => boolean; onProgress?: (msg: string) => void },
): Promise<{ deletedPaths: number; deletedChunks: number; embedded: IndexCompleteEntry | null; deferredEmbed: number; sidecarHydrated: number; carriedOver: number; committedPaths: string[] }> {
    // Set inside the mutex by applyDelta; read after to gate the re-warm. A
    // successful incremental patch IS the warm, so warmCaches is skipped (it
    // would re-pay the O(N) fit the patch just avoided).
    let appliedIncrementally = false;
    // 1C: the engine's packaged sidecar flush, captured by closure the moment
    // the engine returns (NOT threaded through the result) so the .finally
    // below still flushes it even when a post-engine step (applyDelta, the
    // meta stamp) throws — parity with the old inline flush, which had
    // already completed by then.
    let sidecarJob: SidecarFlushJob | null = null;
    // v16 (issue #5): the incremental-patch outcome, appended as a
    // 'delta-apply' entry after the mutex releases. Built inside the
    // critical section (it owns the counters), mutexHoldMs stamped in the
    // finally so it covers the WHOLE hold searches can wait on.
    let deltaTelemetry: Omit<DeltaApplyEntry, 'type' | 'timestamp'> | null = null;
    const result = await ctx.coord.runExclusive(async () => {
        const mutexStart = performance.now();
        let release!: () => void;
        ctx.coord.currentDelta = new Promise<void>(r => { release = r; });
        try {
            // Fix A: snapshot emptiness BEFORE phase-1 drops — mirrors
            // embedAndCommitFiles. The common cold build runs an embed pass, which
            // stamps the live identity itself (read back into prevMeta below). This
            // covers the residual path where a cold build commits NOTHING via the
            // engine (every file hydrated from a peer sidecar / carried over), so
            // the meta stamp below is the ONLY one — it must still claim the live
            // identity rather than copy the empty store's `undefined` fields.
            const storeWasEmpty = (await ctx.store.count()).chunks === 0;
            // F13 carry-over: harvest tiers of chunks about to be removed, keyed
            // by embed text, so a move / no-op re-flush reuses the identical vector
            // instead of re-embedding. Deleted paths lose their chunks in phase 1,
            // so harvest them FIRST; only worth it when this pass will embed.
            const carryOver = new Map<string, { q: QuantVec; sign: Uint8Array }>();
            const wantCarryOver = opts.embed && ctx.embedder.loaded;
            if (wantCarryOver) await ctx.harvestCarryOverInto(carryOver, deletedPaths);

            // The change-set the incremental cache path consumes: ids removed
            // and chunks committed (filled by commitFile via addsSink). Three
            // removal sources: Phase-1 deletes, the engine diff's stale-row
            // drops (both IDB-applied), and the diff's REINDEX-ROW lane —
            // ids whose IDB rows deliberately REMAIN (metadata refreshed in
            // place) and ride the change-set only as a cache-level remove +
            // re-add with the stored vector. So `removedIds` is "rows the
            // CACHES must drop", not "rows gone from IDB", and
            // DeltaApplyEntry.removed counts both kinds (reindex-rows appear
            // symmetrically in `added`, so removed≈added reads as churn).
            const removedIds: string[] = [];
            const adds: DeltaAdd[] = [];
            // Bodies of the chunks about to be deleted, captured BEFORE
            // deleteFile drops them from IDB: applyDelta's removeExact()
            // reconstructs each removed doc (frame meta + content-addressed
            // body) to clean its postings synchronously. Capture is skipped
            // when the resident caches are absent — that pass falls back to
            // a full rebuild which never consults removal docs.
            const removedBodies = new Map<string, string>();
            const wantRemovalBodies = !!(ctx.frameCache && ctx.bm25Cache);
            // In-place metadata patches from the engine's chunk-diff: id-stable
            // chunks whose BM25-irrelevant metadata drifted (line numbers,
            // dates). applyDelta swaps the frame rows; IDB was already updated.
            const metaPatches: Array<{ id: string; meta: ChunkMeta }> = [];
            // Phase 1: structural drops (no model).
            let deletedChunks = 0;
            for (const path of deletedPaths) {
                if (wantRemovalBodies) await captureRemovalBodies(ctx.store, path, removedBodies);
                const ids = await ctx.store.deleteFile(path);
                deletedChunks += ids.length;
                removedIds.push(...ids);
            }

            // Phase 2: embed dirty files (only when we can do it now).
            const indexable = dirtyPaths.filter(p => ctx.shouldIndex(p));
            let embedded: IndexCompleteEntry | null = null;
            let deferredEmbed = 0;
            let sidecarHydrated = 0;
            let carriedOver = 0;
            let engineUnwound = 0;
            // Paths this burst actually committed (now non-dirty). Drives the
            // catch-up drain's advance-by-real-progress (see the computation after
            // the embed block, and drainCatchUp).
            let committedPaths: string[] = [];
            // Model-drift guard: if the loaded model differs from the one
            // that built the stored index (a legacy english-r2 index not
            // yet full-reindexed onto ml97), embedding dirty files
            // NOW would mix incompatible vector spaces in one index. Defer
            // the embed phase instead — old versions stay searchable, and
            // mtime keeps them dirty until the full reindex re-stamps meta.
            // A pre-stamp index (modelId undefined) is english-r2 by
            // construction — same default as main.ts warnOnModelIndexDrift.
            const metaModel = (await ctx.store.getMeta()).modelId ?? LEGACY_ENGLISH_MODEL_ID;
            const modelDrift = opts.embed
                && ctx.embedder.loaded && metaModel !== ctx.embedder.modelId;
            if (opts.embed && !modelDrift && indexable.length > 0) {
                const allDirty = indexable
                    .map(p => ctx.getAbstractFileByPath(p))
                    .filter((f): f is LiveFile<H> => f !== null);
                // Per-BURST file cap (maxFiles), applied here rather than inside
                // the engine, and recency-first: only the files this burst will
                // actually re-embed get their stale chunks dropped — files
                // deferred to a later burst keep their OLD searchable chunks
                // until their turn (the drain loop's computeDelta re-finds them
                // dirty and slices them into a subsequent burst). Deleting all
                // dirty files up front would make every not-yet-embedded edit
                // vanish from search for the whole multi-burst drain. undefined
                // maxFiles (desktop / flushDirty / reindexAll) = the whole set.
                allDirty.sort((a, b) => b.mtime - a.mtime);
                const toEmbed = opts.maxFiles !== undefined ? allDirty.slice(0, opts.maxFiles) : allDirty;
                // The dirty-path F13 harvest is GONE (chunk-diff commit, issue
                // #5): a same-path edit's stable ids never re-embed now (the
                // engine diffs against the file record and reuses stored
                // vectors directly), so harvesting a recorded file's tiers on
                // every commit was pure IDB tax on exactly the hot-note path
                // this fix targets. Move sources were harvested above via
                // deletedPaths — carry-over keeps its headline win (folder
                // reorgs re-key for free). The one case that regresses is a
                // whitespace-only same-path edit (every raw id changes, every
                // embed text survives): it re-embeds once instead of carrying
                // over. NOTE: the wholesale pre-delete is gone too — stale-row
                // deletion now happens per-file at the point of truth (the
                // engine's diff, carryOverHydrate, dedupViaSidecar), so a
                // dirty file's old chunks stay searchable until replaced.
                const afterCarry = await ctx.carryOverHydrate(toEmbed, carryOver);
                carriedOver = toEmbed.length - afterCarry.length;
                // Dedup-before-embed: hydrate the files the sidecar already covers
                // (a peer device embedded this exact content) rather than
                // re-embedding. Passes the removal sinks so it can drop + surface
                // the stale rows the hydrated chunk set no longer references.
                const remaining = await ctx.dedupViaSidecar(afterCarry, adds, removedIds, removedBodies, metaPatches);
                sidecarHydrated = afterCarry.length - remaining.length;
                remaining.sort((a, b) => b.mtime - a.mtime);
                if (remaining.length > 0) {
                    const overallStart = performance.now();
                    const memBefore = await snapshotMemory();
                    // maxFiles is already enforced by the slice above; the engine
                    // only needs the wall-clock + hidden aborts (for one huge note
                    // or a mid-burst background).
                    const engineOut = await ctx.embedAndCommitFiles(remaining, 'incremental', opts.onProgress, overallStart, memBefore,
                        // Pass the PASS-START emptiness (captured above, before carry-over
                        // + sidecar hydration committed any chunk) so the engine's identity
                        // stamp + background recompute use the same cold-build signal as the
                        // meta stamp below — not a count() taken after hydration. The three
                        // diff sinks enable the per-file chunk-diff (issue #5) and surface
                        // its removals / meta patches into this delta's change-set.
                        {
                            budgetMs: opts.budgetMs, shouldContinue: opts.shouldContinue, addsSink: adds, storeWasEmpty,
                            removedSink: removedIds, removedBodiesSink: removedBodies, metaPatchSink: metaPatches,
                        });
                    embedded = engineOut.entry;
                    sidecarJob = engineOut.sidecarJob;
                    engineUnwound = engineOut.quarantineUnwound;
                }
                // Paths this burst actually committed (now non-dirty), so the catch-up
                // drain advances by REAL progress instead of by maxFiles: carry-over
                // reuse (toEmbed \ afterCarry) + sidecar hydration (afterCarry \
                // remaining) + the files embedAndCommitFiles ACTUALLY committed
                // (committedFilePaths — record written). NOT a count-based prefix of
                // `remaining`: an empty/below-min-chunk note or a mid-list skip-error
                // advances processedFiles without committing, so a prefix would punch a
                // hole and drop a still-dirty file from the work-list — re-finding it
                // dirty every sweep and spinning the outer loop. A budget-deferred file
                // is likewise absent (stale chunks dropped, not re-embedded), so the
                // drain retries it next burst (the searchable-during-drain invariant).
                const afterCarrySet = new Set(afterCarry.map(f => f.path));
                const remainingSet = new Set(remaining.map(f => f.path));
                committedPaths = [
                    ...toEmbed.filter(f => !afterCarrySet.has(f.path)).map(f => f.path),   // carried over
                    ...afterCarry.filter(f => !remainingSet.has(f.path)).map(f => f.path), // sidecar-hydrated
                    ...(embedded?.committedFilePaths ?? []),                              // actually embedded + committed
                ];
            } else {
                deferredEmbed = indexable.length;
            }

            // Any store mutation must reach the in-memory caches. Prefer the
            // incremental patch (applyDelta mutates BM25 + the frame in place
            // and re-stamps the generation under THIS mutex); fall back to a
            // full invalidate+rebuild when the patch can't safely apply
            // (cold caches, index-shape flip, dim change, drift, or a due
            // compaction). Sidecar-hydrated chunks are in `adds` too, so a dedup
            // delta is incremental. Either way the next search sees a correct cache.
            const mutated = deletedChunks > 0 || deletedPaths.length > 0 || embedded || sidecarHydrated > 0 || carriedOver > 0;
            if (mutated) {
                // F13 carry-over writes chunks the applyDelta change-set can't
                // track (they bypass the model + the `adds` sink), so a delta that
                // carried any vector over can't be patched incrementally — force
                // the full invalidate+rebuild. The expensive re-embed is still
                // avoided; only the cheaper in-memory cache fit is re-paid.
                // A mass-failure quarantine UNWIND likewise bypasses the change-set
                // (its deleteFile drops rows the addsSink already surfaced, and —
                // under the chunk-diff — stable rows applyDelta would keep), so an
                // unwound pass rebuilds from IDB truth too.
                const skippedBecause = carriedOver > 0 ? 'carry-over'
                    : engineUnwound > 0 ? 'quarantine-unwind' : undefined;
                let applyDeltaMs: number | undefined;
                ctx.lastDeltaFallbackReason = null;
                if (!skippedBecause) {
                    const applyStart = performance.now();
                    appliedIncrementally = await ctx.applyDelta(adds, removedIds, removedBodies, metaPatches);
                    applyDeltaMs = performance.now() - applyStart;
                }
                if (!appliedIncrementally) ctx.invalidateBm25Cache();
                deltaTelemetry = {
                    appliedIncrementally,
                    ...(skippedBecause ? { skippedBecause } : {}),
                    ...(!skippedBecause && !appliedIncrementally && ctx.lastDeltaFallbackReason
                        ? { fallbackReason: ctx.lastDeltaFallbackReason } : {}),
                    removed: removedIds.length,
                    added: adds.length,
                    metaPatches: metaPatches.length,
                    ...(applyDeltaMs !== undefined ? { applyDeltaMs: parseFloat(applyDeltaMs.toFixed(2)) } : {}),
                    mutexHoldMs: 0,   // stamped in the finally (whole hold)
                };
            }
            // Stamp meta ONLY when the corpus actually changed. A no-op delta (an
            // embed:false reconcile pass, or a computeDelta that found nothing)
            // rewriting lastIndexedAt + re-storing identical meta was pure write-
            // amplification — hundreds of redundant LevelDB writes across a churny
            // mobile session, feeding the bloat ratchet. And now that the BM25 stamp
            // gate tolerates a drifted lastIndexedAt (bm25StampMatches), there is
            // nothing to keep in sync on a no-op. Preserve the existing modelId: a
            // delta embeds with the loaded model, but the BULK of the index is
            // whatever the last full reindex wrote — only reindexAll claims a new id.
            if (mutated) {
                const prevMeta = await ctx.store.getMeta();
                // Fix A: a cold first-build (storeWasEmpty) claims the live identity
                // here. For the common embed path this is a no-op — embedAndCommitFiles
                // already stamped it, so prevMeta reads it back — but it is the ONLY
                // stamp for the residual hydrate/carry-only cold build, whose prevMeta
                // would otherwise be `undefined` and re-trip the gate. A NON-empty
                // store carries identity forward unchanged: an ordinary delta never
                // re-stamps, and a legacy index must stay stale for the gate to heal.
                // reindexDelta is always an incremental (delta) pass, so a cold
                // first-build (empty store) is its only stamp-live case.
                const live = shouldStampLiveIdentity('incremental', storeWasEmpty) ? ctx.identity() : null;
                await ctx.store.setMeta({
                    embeddingDim: ctx.EMBEDDING_DIM,
                    lastIndexedAt: new Date().toISOString(),
                    schemaVersion: META_SCHEMA_VERSION,
                    // Prefer the existing modelId (embed path set it); fall back to
                    // the live model only when the cold build wrote none (hydrate-only).
                    modelId: prevMeta.modelId ?? live?.modelId,
                    // Carry identity + corpus background forward unchanged on a delta;
                    // a cold build claims live identity (see comment above). Only a
                    // full/cold pass refits the background (see dense-stats.ts).
                    chunkerVersion: live ? live.chunkerVersion : prevMeta.chunkerVersion,
                    analyzerVersion: live ? live.analyzerVersion : prevMeta.analyzerVersion,
                    revision: live ? live.revision : prevMeta.revision,
                    bgMean: prevMeta.bgMean,
                    bgStd: prevMeta.bgStd,
                });
            }
            // deferredEmbed: the WHOLE embed phase was skipped (cold model / model
            //   drift) → indexable.length. The drain loop reads this as its
            //   no-forward-progress / drift signal. (Budget deferral is detected
            //   instead by the shrinking dirty set on the next computeDelta, so it
            //   needs no separate return field.)
            return { deletedPaths: deletedPaths.length, deletedChunks, embedded, deferredEmbed, sidecarHydrated, carriedOver, committedPaths };
        } finally {
            if (deltaTelemetry) deltaTelemetry.mutexHoldMs = parseFloat((performance.now() - mutexStart).toFixed(2));
            release();
            ctx.coord.currentDelta = null;
        }
    }).finally(() =>
        // 1C: run the pass's packaged sidecar flush AFTER the mutex releases,
        // awaited before reindexDelta resolves (or rethrows) so callers keep
        // "delta resolved ⇒ sidecar flushed". flushSidecarAfterPass never
        // rejects, so this can't mask the critical section's own error.
        ctx.flushSidecarAfterPass(sidecarJob));
    if (result.deletedChunks > 0 || result.deletedPaths > 0 || result.embedded || result.sidecarHydrated > 0 || result.carriedOver > 0) {
        await ctx.exportMcpAfterSuccessfulCommit('incremental');
    }
    // v16 (issue #5): persist the patch outcome. Off the mutex,
    // fire-and-forget — telemetry never delays the pass. (Local copy: the
    // closure assignment above defeats TS's narrowing on the outer let.)
    const patchOutcome: Omit<DeltaApplyEntry, 'type' | 'timestamp'> | null = deltaTelemetry;
    if (patchOutcome !== null) {
        const entry: DeltaApplyEntry = Object.assign(
            { type: 'delta-apply' as const, timestamp: new Date().toISOString() }, patchOutcome);
        void ctx.logger.append(entry).catch(() => {});
    }
    // Re-warm only when we did NOT patch incrementally (the patch is the warm).
    // Fire-and-forget, off the mutex — the moment the flush scheduler already
    // judged quiet enough for embed work, so the rebuild lands here rather than
    // on the next search. A carry-over delta always lands here (it forces the
    // non-incremental path above), so result.carriedOver gates a re-warm too.
    if (!appliedIncrementally
        && (result.deletedChunks > 0 || result.deletedPaths > 0 || result.embedded || result.sidecarHydrated > 0 || result.carriedOver > 0)) {
        void ctx.warmCaches('delta');
    } else if (appliedIncrementally) {
        // The incremental patch already kept the resident cache warm, so there is
        // no rebuild to do — but historically it also skipped persistBm25, leaving
        // the disk blob stale until a full rebuild. Re-persist (throttled, embed-
        // free) so the next cold start loads a near-fresh blob instead of refitting.
        // Ghost-discard dirt past the threshold instead takes the ordinary
        // rebuild (see reconcileGhostDirt) — the rebuild's own warm re-persists.
        if (!ctx.reconcileGhostDirt()) ctx.maybePersistResidentBm25();
    }
    return result;
}
