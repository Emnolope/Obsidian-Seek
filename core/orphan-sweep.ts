// Referential-integrity sweep: delete chunks no file record references. Pure store set-arithmetic, so any host that owns an index can run it.
import { findOrphanChunkIds, type FileRecord } from './index-types.ts';

export interface SweepCtx {
    coord: { runExclusive<T>(fn: () => Promise<T>): Promise<T> };
    store: {
        getAllChunkIds(): Promise<string[]>;
        listFileRecords(): Promise<FileRecord[]>;
        deleteChunksByIds(ids: string[]): Promise<unknown>;
    };
    invalidateBm25Cache(): void;
    warmCaches(trigger: string): Promise<void>;
}

// fork 1.1.3 src/search.ts:2530 SearchOrchestrator.sweepOrphanChunks
// Referential-integrity sweep (Phase 3 steady-state GC): delete every chunk no
// FILES record references — orphans from an overwritten file record (hydrate /
// applyDelta swapping a changed note's ids) or a missed delete event. They sit
// in chunk_meta, so they can surface stale content; this is freshness + space,
// not just disk. Pure IDB set-arithmetic — NO re-chunk / embed / GPU — so it is
// mobile-safe; batched under the write mutex with an optional abort so it never
// blocks an active search for long. Re-syncs caches after any delete (orphans
// sit in the resident frame until invalidate + warm rebuilds it). Returns the
// count removed + whether the pass completed (a backgrounding abort resumes on
// the next poll). Complements the identity cascade: that clears VERSION-bump
// orphans (nuke + rehydrate), this clears SAME-version churn.
export async function sweepOrphanChunks(ctx: SweepCtx, opts: { shouldContinue?: () => boolean } = {}): Promise<{ removed: number; completed: boolean }> {
    // Snapshot all chunk ids + the referenced set TOGETHER under the write mutex.
    // The embed commit is one atomic tx now (S1: chunks + file record together),
    // but the HYDRATE path still flushes chunk batches before its file records
    // land (batches span file boundaries), so an UNLOCKED snapshot could catch a
    // just-hydrated chunk before its record and delete it as a false orphan —
    // and pre-S1 indexes can still hold genuinely record-less chunks. (Content-
    // addressing makes that self-healing, but it is still a real freshness hit,
    // so keep the snapshot locked.) The only residual — a rare re-add of the SAME
    // content between batches — reuses the same id and is itself self-healing.
    const orphans = await ctx.coord.runExclusive(async () => {
        const allIds = await ctx.store.getAllChunkIds();
        const referenced = new Set<string>();
        for (const rec of await ctx.store.listFileRecords()) {
            for (const id of rec.chunk_ids) referenced.add(id);
        }
        return findOrphanChunkIds(allIds, referenced);
    });
    if (orphans.length === 0) return { removed: 0, completed: true };
    const BATCH = 500;
    let deleted = 0;
    let completed = true;
    for (let i = 0; i < orphans.length; i += BATCH) {
        if (opts.shouldContinue && !opts.shouldContinue()) { completed = false; break; }
        const batch = orphans.slice(i, i + BATCH);
        await ctx.coord.runExclusive(() => ctx.store.deleteChunksByIds(batch));
        deleted += batch.length;
    }
    if (deleted > 0) {
        ctx.invalidateBm25Cache();
        void ctx.warmCaches('orphan-sweep');
    }
    return { removed: deleted, completed };
}
