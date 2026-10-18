// Full reindex, host-independent: drop the database, scan the vault recency-first, embed and commit everything, then release the sidecar flush and export. The plugin
// supplies the vault listing, the IndexedDB nuke and the embed engine through ReindexAllCtx.
import type { IndexCompleteEntry, IndexProgressEntry, ResetEntry } from './types.ts';
import { snapshotMemory } from './types.ts';
import type { MetaConfig } from './index-types.ts';
import { META_SCHEMA_VERSION, isQuotaError } from './index-types.ts';
import type { LiveFile } from './delta.ts';
import type { SidecarFlushJob } from './embed-commit.ts';

export interface ReindexAllCtx<H> {
    coord: { runExclusive<T>(fn: () => Promise<T>): Promise<T> };
    store: {
        readonly dbName: string;
        close(): void;
        open(): Promise<unknown>;
        setMeta(meta: MetaConfig): Promise<void>;
    };
    embedder: { readonly modelId: string };
    logger: { append(entry: ResetEntry): Promise<void> };
    forensics: { beat(type: string, detail?: Record<string, unknown>): void } | null;
    unreadable: { clear(): void };
    EMBEDDING_DIM: number;
    // Drops the whole per-vault database; the counts feed the reset log entry.
    nukeDatabase(dbName: string): Promise<{ chunks: number; embeddings: number; files: number }>;
    indexableFiles(): LiveFile<H>[];
    shouldIndex(path: string): boolean;
    emitProgress(phase: IndexProgressEntry['phase'], filesSeen: number, filesTotal: number, chunksEmitted: number, elapsedMs: number): Promise<void>;
    embedAndCommitFiles(
        files: LiveFile<H>[], mode: 'full' | 'incremental', onProgress: ((msg: string) => void) | undefined, overallStart: number,
        memBefore: Awaited<ReturnType<typeof snapshotMemory>>,
        budget: { shouldContinue?: () => boolean; isPaused?: () => boolean },
    ): Promise<{ entry: IndexCompleteEntry; sidecarJob: SidecarFlushJob | null }>;
    invalidateBm25Cache(): void;
    flushSidecarAfterPass(job: SidecarFlushJob | null): Promise<void>;
    exportMcpAfterSuccessfulCommit(mode: 'full' | 'incremental'): Promise<void>;
    quotaToast(): void;
    warmCaches(trigger: string): Promise<void>;
}

// fork 1.1.3 src/search.ts:344 SearchOrchestrator.reindexAll
// Full reindex. Drops the database, walks all markdown, re-embeds everything.
// Serialized against deltas via the write mutex (a delta mid-nuke would throw).
export async function reindexAll<H>(ctx: ReindexAllCtx<H>, onProgress?: (msg: string) => void, opts: { shouldContinue?: () => boolean; isPaused?: () => boolean } = {}): Promise<IndexCompleteEntry> {
    let result: IndexCompleteEntry;
    try {
        const inner = await ctx.coord.runExclusive(() => reindexAllInner(ctx, onProgress, opts.shouldContinue, opts.isPaused));
        result = inner.entry;
        // 1C: the pass only PACKAGED its sidecar flush; run it now that the
        // mutex has released, still awaited so "reindexAll resolved ⇒ sidecar
        // flushed" holds for every caller.
        await ctx.flushSidecarAfterPass(inner.sidecarJob);
        await ctx.exportMcpAfterSuccessfulCommit('full');
    } catch (e) {
        // Pass-level quota (S2): the per-file classifier only sees commitFile's
        // catch; on a truly full disk the pass's OWN writes (the post-nuke
        // setMeta, the end-of-pass meta stamp) can quota-throw too — the
        // highest-stakes case, since the nuke already dropped the previous
        // index. Surface the same actionable signal, then rethrow: the pass
        // still failed and the caller's generic handler still reports it.
        if (isQuotaError(e)) {
            ctx.forensics?.beat('index-quota-exhausted', { files: 0, mode: 'full-pass-write' });
            ctx.quotaToast();
        }
        throw e;
    }
    // Off the mutex: re-warm reads the committed index; a search arriving
    // first just does the same build itself (see warmCaches).
    void ctx.warmCaches('full-reindex');
    return result;
}

// fork 1.1.3 src/search.ts:494 SearchOrchestrator.reindexAllInner
export async function reindexAllInner<H>(ctx: ReindexAllCtx<H>, onProgress?: (msg: string) => void, shouldContinue?: () => boolean, isPaused?: () => boolean): Promise<{ entry: IndexCompleteEntry; sidecarJob: SidecarFlushJob | null }> {
    const overallStart = performance.now();
    const memBefore = await snapshotMemory();

    // A full reindex re-attempts every file regardless of quarantine — clear
    // the backoff map so a file that has since become readable (e.g. an
    // iCloud placeholder that finished downloading) isn't skipped here too.
    ctx.unreadable.clear();

    // Reset. Close our long-lived connection first so deleteDatabase
    // isn't blocked by us, then re-open the (fresh, empty) DB.
    const resetStart = performance.now();
    ctx.store.close();
    const pre = await ctx.nukeDatabase(ctx.store.dbName);   // per-vault DB — never another vault's
    await ctx.store.open();   // scope-less: reuses the name from onload's open(appId)
    await ctx.store.setMeta({
        embeddingDim: ctx.EMBEDDING_DIM,
        lastIndexedAt: null,
        schemaVersion: META_SCHEMA_VERSION,
        modelId: ctx.embedder.modelId,
    });
    const resetEntry: ResetEntry = {
        type: 'reset',
        timestamp: new Date().toISOString(),
        droppedDatabase: ctx.store.dbName,
        chunksDeleted: pre.chunks,
        vectorsDeleted: pre.embeddings,
        durationMs: parseFloat((performance.now() - resetStart).toFixed(2)),
        pass: true,
        checks: [
            `✅ dropped database "${ctx.store.dbName}"`,
            `ℹ️ removed ${pre.chunks} chunks, ${pre.embeddings} vectors, ${pre.files} file records`,
        ],
    };
    await ctx.logger.append(resetEntry);

    // Scan. Filter out (a) Seek's own diagnostic outputs / machine-generated
    // chatter (see EXCLUDED_PATHS) and (b) anything the user has hidden via
    // Obsidian's "Excluded files" setting (see isUserIgnored).
    const allFiles = ctx.indexableFiles();
    const skipped: string[] = [];
    const files = allFiles.filter(f => {
        const include = ctx.shouldIndex(f.path);
        if (!include) skipped.push(f.path);
        return include;
    });
    if (skipped.length > 0) {
        /* intentionally empty: skipped paths are collected above for the
           filter's side effect; no per-run action is taken on them here */
    }
    // Progressive ordering: index most-recently-modified files first. Since
    // search rebuilds BM25 in-memory and dense reads commit per file, the
    // index is queryable as it fills — recency-first means the notes a user
    // is most likely to search are searchable soonest, and on a phone that
    // may never finish a full pass, recency decides COVERAGE, not just order.
    files.sort((a, b) => b.mtime - a.mtime);
    await ctx.emitProgress('scan', 0, files.length, 0, performance.now() - overallStart);

    // shouldContinue in full mode = the soft preempt (pause/resume between
    // files while the user searches — see embedAndCommitFiles' budget comment).
    // The engine's sidecar flush comes back PACKAGED (1C) and rides through to
    // reindexAll, which runs it after the mutex releases.
    const result = await ctx.embedAndCommitFiles(files, 'full', onProgress, overallStart, memBefore, { shouldContinue, isPaused });

    // Bump dataGeneration on COMPLETION. main.ts invalidates once BEFORE the
    // reindex, but a search firing during the rebuild then caches the frame /
    // binary index at that generation off the PARTIALLY-filled store; nothing
    // bumped again at the end, so a post-reindex search kept serving that
    // frozen partial frame (the frame + binary caches are generation-keyed
    // only — no chunk-count belt-and-braces like BM25 has). Invalidating here
    // forces the next search to rebuild against the complete index.
    ctx.invalidateBm25Cache();
    return result;
}
