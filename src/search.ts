// SearchOrchestrator — owns the chunk-vault → embed → store → search loop.
//
// reindexAll() is intentionally the simple "nuke and rebuild" path: drop the
// IndexedDB database, walk all markdown files, chunk → embed → write. Larger
// vaults will want incremental, but the design doc explicitly defers that;
// the user asked for a "total nuke and reset" full reindex as one of the
// three v0 commands.

import type { App } from 'obsidian';
import { Notice, TFile } from 'obsidian'; // value imports: reindexDelta uses `instanceof TFile`; the quota gate toasts
import type { Chunk, ChunkMeta, ScoredChunk, SearchEntry, IndexCompleteEntry, IndexProgressEntry, ResetEntry, DeltaApplyEntry, QueryFilters, FilterContext, SeekSettings, MemorySnapshot } from './types';
import { snapshotMemory, memoryDelta, distributionStats } from './types';
import { MarkdownChunker, cyrb53Hex } from './chunker';
import { cleanDenseText } from './dense-clean';
import { extractBaseDocs } from './base-extractor';
import { MultiFieldBM25, DEFAULT_FIELD_BOOSTS, PREFIX_LAST_TOKEN, FUZZY_BY_LENGTH, ANALYZER_VERSION, BM25_COVERAGE_POW, processQueryTerm } from './bm25';
import { buildSynonymMap, chunkDeclaresAlias, buildPhraseMap, matchPhrases, SYNONYM_WEIGHT, type SynonymMap, type PhraseSynonymMap } from './synonyms';
import { aggregateLinkPairs, mineLinkPairsByPath, mineLinkPairsForPaths, type LinkPairCount } from './link-dict';
import { TaskContextTracker } from './task-context';
import { rank, cosineScores, DEFAULT_RANKING_CONFIG } from './ranker';
import { browseOrder, recencyDate } from './fusion';
import { IndexStore, nukeDatabase, classifyFileDelta, findOrphanChunkIds, isStoreClosedError, isQuotaError, stripContent, META_SCHEMA_VERSION, type MetaConfig, type FileRecord } from './index-store';
import { INDEX_QUOTA_MSG } from './index-notice';
import { LocalEmbedder, EMBEDDING_DIM, LEGACY_ENGLISH_MODEL_ID, MODEL_ID, PLUGIN_VERSION } from './embedder';
import { SeekLogger } from './logger';
import { Forensics } from './forensics';
import { selectIndexBucket } from './iframe-runner';
import { enforceTokenBudget, embedInput, type TokenBudgetResult } from './token-budget';
import { concatPacked, topNIndices, packSignBits } from './binary';
import { selectTopNIndices } from './select';
import { poolCaps, POOL_FLOORS } from './pool';
import { BinaryScorerWorker, binaryCandidatesAsync } from './binary-scorer';
import { quantizeInt8, dequantizeInt8, type QuantVec } from './quant';
import { VecReservoir, denseBgStats, calibratedConfidence, BG_RESERVOIR, MIN_BG_SAMPLE } from './dense-stats';
import { bulkAppend, clearDevice, sidecarDirSignature, shouldReconcileSidecar, staleSidecarFormat, SIDECAR_FORMAT, bm25PathFor, writeBytesAtomic, ensureDir, listSidecarDeviceIds, listDeviceShards, compactDevice, coalesceSmallShards, type CompactResult, type CoalesceResult, type TierBytes } from './sidecar';
import { writeDeviceMeta, readDeviceMeta, metaAccepts, expectationFor, type SidecarMeta, type MetaExpectation } from './sidecar-meta';
import { hydrateFromSidecar, rankAcceptedProducers, probePeerAhead, type ReChunkedNote, type HydrateResult, type HydrateDeps } from './sidecar-sync';
import { pluginIdentity, shouldStampLiveIdentity, identityHealEligibility, type IndexIdentity } from './identity';
import { gzipString, gunzipToString, gzipAvailable } from './gzip';
import { IndexCoordinator } from './index-coordinator';
import { CompositorPacer, cheapYield } from './pacer';
import { isMobilePlatform, residentInt8Enabled } from './platform';
import { parseQuery, compileMatcher, excludedNotePaths } from './query-parser';
import { buildPassageTerms, passageWindow, type PassageTerm } from './passage';
import { enumerateNumberPropertyNames } from './prop-types';
import { exportMcpIndex } from './mcp-export';
import { planFileDiff, captureRemovalBodies } from '../core/file-diff';
import { embedAndCommit, type EmbedCommitCtx, type SidecarFlushJob } from '../core/embed-commit';
import { applyDelta as applyDeltaCore } from '../core/apply-delta';
import { shouldIndexPath as shouldIndexPathCore, chunksFor as chunksForCore, computeDelta, UnreadableQuarantine } from '../core/delta';
import { ResidentIndex, type ResidentPorts } from '../core/resident-index';
import { runSearch, type SearchHost, type SearchOverride, type ExperimentOverride } from '../core/engine';
import { alignCandidate, buildResidentRerankBlock, chunkMetaEqual, pushDeltaAdds, freshDeltaAdds, appendFrameRows, tombstoneFrameRows, buildSelectionMask, COMPACTION_TOMBSTONE_FRACTION, COHERENCE_SAMPLES, COHERENCE_DRIFT_COOLDOWN_MS, coherenceDriftDecision, shouldDiscardPartialFrame, driftRecoveryDecision, frameBm25Coherent, buildBm25Stamp, bm25StampMatches, dedupByPath, topKByScore, snippetPlainText, makeSnippet, type ResidentFrame, type DeltaAdd, type DriftRecoveryState, type RowSpaceProbe, type Bm25PersistStamp } from '../core/search-helpers';
export { alignCandidate, buildResidentRerankBlock, chunkMetaEqual, pushDeltaAdds, freshDeltaAdds, appendFrameRows, tombstoneFrameRows, buildSelectionMask, COMPACTION_TOMBSTONE_FRACTION, COHERENCE_SAMPLES, COHERENCE_DRIFT_COOLDOWN_MS, coherenceDriftDecision, shouldDiscardPartialFrame, driftRecoveryDecision, frameBm25Coherent, buildBm25Stamp, bm25StampMatches } from '../core/search-helpers';
export type { ResidentFrame, DeltaAdd, DriftRecoveryState, RowSpaceProbe, Bm25PersistStamp } from '../core/search-helpers';



// Minimum spacing between "storage full" toasts. Quota exhaustion re-surfaces on
// every retried pass (catch-up bursts re-fire), and the condition can persist for
// hours — one Notice per pass would be a toast storm saying the same thing.
const QUOTA_NOTICE_MIN_INTERVAL_MS = 5 * 60_000;

// ---- Stage-1 candidate-gen caps (Seek Retrieval Relevance & Query §Two-Stage
// ANN → Rerank, the [!done] callout). The union of the three arms feeds the fp32
// exact rerank in stage 2. The caps now SCALE with live corpus size (√N, clamped
// to per-arm floor/ceiling) so a fixed top-200 doesn't cover a shrinking fraction
// of a growing vault — see pool.ts for the full rationale, the cost model, and
// why recency is held flat. `poolCaps(liveN)` is computed per query off the live
// chunk count; at our current ~5k scale it returns exactly the old constants, so
// behaviour is identical until the vault grows past POOL_ANCHOR_N.

// EXCLUDED_PATHS / EXCLUDED_PREFIXES and the membership rules live in core/delta.ts.

// Honor Obsidian's user-configured "Excluded files" (Settings → Files & Links).
// A user who hid a folder from Obsidian's own search/link suggestions expects
// Seek to hide it too — but vault.getMarkdownFiles() ignores that list, so we
// must filter it ourselves. The API isn't in the public typings, so reach the
// runtime defensively: prefer metadataCache.isUserIgnored() (Obsidian's own
// matcher — it handles both the folder-prefix and /regex/ filter forms and
// stays drift-free across versions), falling back to matching the raw
// userIgnoreFilters list on builds that predate that method.
function isUserIgnored(app: App, path: string): boolean {
    const mc = app.metadataCache as unknown as { isUserIgnored?: (p: string) => boolean };
    if (typeof mc.isUserIgnored === 'function') return mc.isUserIgnored(path);
    const getConfig = (app.vault as unknown as { getConfig?: (k: string) => unknown }).getConfig;
    const filters = (typeof getConfig === 'function'
        ? getConfig.call(app.vault, 'userIgnoreFilters')
        : null) as string[] | null;
    if (!Array.isArray(filters)) return false;
    return filters.some(filter => {
        // /pattern/ → regex (Obsidian's own delimiter convention).
        if (filter.length > 1 && filter.startsWith('/') && filter.endsWith('/')) {
            try { return new RegExp(filter.slice(1, -1)).test(path); } catch { return false; }
        }
        // Otherwise a folder/path prefix: match the file itself or anything under it.
        return path === filter || path.startsWith(filter.endsWith('/') ? filter : filter + '/');
    });
}

// The single index-membership predicate, exported so any code that offers a
// value SOURCED from the note (a filter pill, an autocomplete suggestion, …)
// can check whether the note it came from actually reaches the index — a
// pill built from Obsidian's raw metadataCache (which doesn't honor "Excluded
// files") can otherwise promise a result that the matcher will never return.
// SearchOrchestrator.shouldIndex delegates here so there is exactly one
// implementation to keep in sync (see the audit note in suggest.ts).
export function shouldIndexPath(app: App, settings: SeekSettings, path: string): boolean {
    return shouldIndexPathCore(settings, path, p => isUserIgnored(app, p));
}

// Per-call recency override for search() — the seek:search CLI's
// recencyWeight/recencyHalflife params (main.ts). Either field may be absent
// (only one of the two CLI params given); absent means "use this.settings
// for that field". Deliberately a plain call argument, never written into
// SeekSettings: the settings object is shared by reference with the plugin
// and read by every concurrent search caller, so mutating it for an
// override's duration let a concurrent plain search transparently rank
// against someone else's in-flight override (2026-07-02 review).
export type { SearchOverride, ExperimentOverride } from '../core/engine';


export class SearchOrchestrator {
    private app: App;
    private store: IndexStore;
    private embedder: LocalEmbedder;
    private logger: SeekLogger;
    // Crash forensics (synchronous breadcrumbs). Null in tests / when the
    // plugin couldn't create it — every use is optional-chained.
    private forensics: Forensics | null;
    // Long-task attribution spans (owned by the plugin; null in tests). The
    // orchestrator marks its own main-thread-heavy phases — currently the BM25
    // cold build — so the longtask observer can attribute their jank.
    private taskCtx: TaskContextTracker | null;
    private chunker = new MarkdownChunker();
    // Live settings reference (the plugin mutates the same object on settings
    // change, so the orchestrator always reads current values). See types.ts.
    private settings: SeekSettings;
    // Shared index-mutation coordination — the write mutex, the in-flight delta
    // gate, the cache-generation counter, and the sidecar location/enablement.
    // Factored out so the indexing and searching halves share exactly this state.
    // See IndexCoordinator.
    private coord: IndexCoordinator;

    // Off-thread stage-1 binary scorer (desktop only; synchronous fallback
    // everywhere). Owns its Worker; disposed on plugin unload. See binary-scorer.ts.
    private binaryWorker: BinaryScorerWorker;

    // Set once, in dispose() (plugin unload / disable). A reindex that is still
    // embedding when the plugin unloads keeps running on the microtask queue AFTER
    // onunload has already closed the store — every subsequent commit would then throw
    // "IndexStore not opened", one error per remaining file (the ~980-error storm).
    // The embed loop checks this at its top + final drain to STOP promptly instead of
    // grinding through the rest of the vault against a dead connection. Sticky: the
    // orchestrator is being torn down, so a re-enable builds a fresh instance.
    private disposed = false;

    // Paths that failed to read during an embed attempt (e.g. an undownloaded
    // iCloud placeholder that throws on every read), mapped to the epoch ms their
    // backoff expires. Without this, a persistently-unreadable file's stale
    // record gets dropped as part of the failed re-embed, so every LATER
    // computeDelta sees prev===undefined and reports it dirty again forever —
    // which wedges reconcileIdentityInPlace in 'drained' permanently (see there).
    // Quarantining it lets computeDelta skip it until the backoff elapses, and a
    // full reindex (reindexAllInner) clears the map so it is always retried then.
    private unreadable = new UnreadableQuarantine();

    // Last time the "storage full" Notice was shown (epoch ms). Rate-limits the
    // toast across passes (see QUOTA_NOTICE_MIN_INTERVAL_MS); the check line +
    // forensics beat still record every affected pass.
    private lastQuotaNoticeAt = 0;

    // S4 tripwire instrumentation: how often (and why) applyDelta declined the
    // incremental patch and forced a full O(corpus) cache rebuild this session.
    // Read nowhere yet — the counts ride each 'delta-fallback' forensics beat so
    // live sessions reveal whether fallback churn is worth engineering against.
    private readonly deltaFallbackCounts = new Map<string, number>();

    private isQuarantined(path: string): boolean {
        return this.unreadable.has(path);
    }

    // Called wherever an indexable file's content could not be read. Logs once
    // per quarantine spell (not on every retry) so a wedged file doesn't spam.
    private quarantineUnreadable(path: string): void {
        if (this.unreadable.add(path)) console.warn(`[seek] quarantining persistently unreadable file (will retry on backoff / next full reindex): ${path}`);
    }

    constructor(app: App, store: IndexStore, embedder: LocalEmbedder, logger: SeekLogger, settings: SeekSettings, forensics: Forensics | null = null, indexDir: string | null = null, taskCtx: TaskContextTracker | null = null) {
        this.app = app;
        this.store = store;
        this.embedder = embedder;
        this.logger = logger;
        this.settings = settings;
        this.forensics = forensics;
        this.taskCtx = taskCtx;
        this.coord = new IndexCoordinator(indexDir, settings);
        this.binaryWorker = new BinaryScorerWorker();
        this.res = new ResidentIndex(this.residentPorts());
    }

    // Release the off-thread scorer's Worker. Called from the plugin's onunload
    // so a reload/disable doesn't leak the worker context. Also signals any in-flight
    // reindex to stop (the embed loop polls `disposed`) so it doesn't keep committing
    // against the store onunload is about to close.
    dispose(): void {
        this.disposed = true;
        this.binaryWorker.dispose();
        this.res.dispose();
    }

    // The cache-generation counter (bumped on every index mutation; see
    // IndexCoordinator). Public so the plugin's drift-recovery scheduler can key
    // re-escalation suppression to it: a degraded index re-trips drift on every
    // keystroke, but the generation only advances on a real mutation (delta /
    // reindex / invalidate / hydrate), so equal generation ⇒ "nothing changed since
    // we last escalated, don't re-escalate".
    currentGeneration(): number {
        return this.coord.generation;
    }

    // True while a reindex/delta/cold-build critical section is running under the
    // write mutex, OR while a pass's off-mutex sidecar flush (1C) is still in
    // flight. Every consumer (the reconcile poll's busy gate, the identity-heal
    // guard, runFullReindex's stacking guard — see main.ts) wants the conservative
    // reading: without the flush half, a second full reindex could pass the
    // stacking guard in the seconds-long window between the mutex releasing and
    // the whole-corpus flush landing, and the first pass's chained flush would
    // then append the entire prior corpus as litter behind the second's
    // clearDevice. Searches and deltas never consult this, so folding the flush
    // in does not re-serialize what 1C unlocked.
    isWriting(): boolean {
        return this.coord.isWriting() || this.sidecarFlushesInFlight > 0;
    }

    // Purple-shirt hook: this is the visible MCP export integration point, tied to
    // the same successful pass completion that committed the index. We do NOT add a
    // second generation protocol or separate bookkeeping layer — the export is just
    // derived from the already-committed IDB state immediately after a successful
    // reindex/delta completes.
    private async exportMcpAfterSuccessfulCommit(mode: 'full' | 'incremental'): Promise<void> {
        try {
            const meta = await exportMcpIndex(this.app.vault.adapter, this.store);
            this.forensics?.beat('mcp-export', { mode, generation: meta.generation, chunkCount: meta.chunkCount });
        } catch (e) {
            await this.logger.appendError(`mcp-export:${mode}`, e).catch(() => {});
        }
    }

    // Full reindex. Drops the database, walks all markdown, re-embeds everything.
    // Serialized against deltas via the write mutex (a delta mid-nuke would throw).
    async reindexAll(onProgress?: (msg: string) => void, opts: { shouldContinue?: () => boolean; isPaused?: () => boolean } = {}): Promise<IndexCompleteEntry> {
        let result: IndexCompleteEntry;
        try {
            const inner = await this.coord.runExclusive(() => this.reindexAllInner(onProgress, opts.shouldContinue, opts.isPaused));
            result = inner.entry;
            // 1C: the pass only PACKAGED its sidecar flush; run it now that the
            // mutex has released, still awaited so "reindexAll resolved ⇒ sidecar
            // flushed" holds for every caller.
            await this.flushSidecarAfterPass(inner.sidecarJob);
            await this.exportMcpAfterSuccessfulCommit('full');
        } catch (e) {
            // Pass-level quota (S2): the per-file classifier only sees commitFile's
            // catch; on a truly full disk the pass's OWN writes (the post-nuke
            // setMeta, the end-of-pass meta stamp) can quota-throw too — the
            // highest-stakes case, since the nuke already dropped the previous
            // index. Surface the same actionable signal, then rethrow: the pass
            // still failed and the caller's generic handler still reports it.
            if (isQuotaError(e)) {
                this.forensics?.beat('index-quota-exhausted', { files: 0, mode: 'full-pass-write' });
                this.quotaToast();
            }
            throw e;
        }
        // Off the mutex: re-warm reads the committed index; a search arriving
        // first just does the same build itself (see warmCaches).
        void this.warmCaches('full-reindex');
        return result;
    }

    // Rate-limited (5 min) storage-full toast — catch-up bursts re-trip the quota
    // gate for as long as the disk stays full, and one actionable message is
    // signal where a toast-per-burst is noise.
    private quotaToast(): void {
        if (Date.now() - this.lastQuotaNoticeAt < QUOTA_NOTICE_MIN_INTERVAL_MS) return;
        this.lastQuotaNoticeAt = Date.now();
        new Notice(INDEX_QUOTA_MSG, 10000);
    }

    // ── 1C: off-mutex sidecar flush ─────────────────────────────────────────
    // An index pass no longer flushes the sidecar inside its write-mutex critical
    // section: embedAndCommitFiles packages a SidecarFlushJob and the pass runs it
    // here AFTER runExclusive releases, so searches (ensureFrame waiting on
    // currentDelta) and queued deltas stop paying for sidecar file IO. Callers
    // still await the flush before resolving — the public contract ("pass
    // resolved ⇒ sidecar flushed") is unchanged; only the lock hold shrinks.
    //
    // Jobs are chained strictly FIFO. File-level safety already comes from the
    // sidecar dir lock (bulkAppend / writeDeviceMeta / clearDevice / compact /
    // coalesce all serialize on it, and bulkAppend holds it across its whole
    // shard+jsonl span, so a reconcile compaction overlapping an in-flight flush
    // can never mistake a half-flushed shard for a crash orphan). What the dir
    // lock does NOT order is two whole read-meta → write-meta → append sequences:
    // with the mutex released before flushing, pass B's critical section can
    // complete while pass A's flush is still in flight, and unchained jobs could
    // interleave so A's meta write (older lastFullReindex / bg calibration) lands
    // after B's. The chain removes that class within this process; cross-process
    // ordering was never the mutex's to give (iCloud offers none) and stays with
    // the sidecar protocol's mtime-keyed resolution. The one remaining
    // same-process interleave is a FULL pass's in-mutex pass-START clearDevice
    // racing a prior delta's in-flight flush: clear-then-flush leaves pre-nuke
    // records as reclaimable litter (ids that survive the re-chunk resolve
    // identically; changed ids are compactDevice-oracle orphans; the seq floor is
    // preserved by both paths), flush-then-clear just wipes records the rebuild
    // is about to replace. Benign either way.
    private sidecarFlushChain: Promise<void> = Promise.resolve();
    // Jobs enqueued or running. Folded into isWriting() so the busy/stacking
    // guards treat an in-flight flush as "still indexing" (see isWriting).
    private sidecarFlushesInFlight = 0;

    private flushSidecarAfterPass(job: SidecarFlushJob | null): Promise<void> {
        if (!job) return Promise.resolve();
        this.sidecarFlushesInFlight++;
        // The .catch is load-bearing twice over, NOT belt-and-braces: runSidecarFlush
        // is written to never reject, but that rests on a non-local invariant (its
        // own catch handler's logging), and a single rejected link would (a) wedge
        // the chain so no future flush ever runs and (b) leak the stale error into
        // every later pass — reindexDelta's .finally would replace a SUCCESSFUL
        // critical section's result with it. Swallow here so both the chain and the
        // promise callers await are structurally rejection-free.
        const run = this.sidecarFlushChain
            .then(() => this.runSidecarFlush(job))
            .catch(() => {})
            .finally(() => { this.sidecarFlushesInFlight--; });
        this.sidecarFlushChain = run;
        return run;
    }

    // The flush body, moved verbatim from embedAndCommitFiles (1C). Best-effort:
    // a sidecar failure must never fail the (already-committed) IDB index — it
    // just means cross-device/eviction durability lags a pass.
    private async runSidecarFlush(job: SidecarFlushJob): Promise<void> {
        // A disposed orchestrator must not write: a queued job outliving onunload
        // would keep appending after a plugin disable, and across a disable→
        // re-enable the NEW instance serializes on a fresh module-scoped dir-lock
        // map — the detached writer and the new pass's clearDevice/bulkAppend
        // would no longer mutually exclude, and a last-rename-wins collision could
        // republish a shard seq with different bytes (the #91 invariant). Skipping
        // is the documented-safe direction: a durability lag hydrate self-heals.
        if (this.disposed) return;
        // Re-read the live setting: it can toggle off between the pass and this flush.
        if (!this.coord.sidecarOn()) return;
        try {
            const adapter = this.app.vault.adapter;
            // Create the sidecar dir up front. The F8 ordering writes meta FIRST,
            // and writeDeviceMeta (→ writeTextAtomic) does not create parents — so
            // on a fresh install the meta write would ENOENT and the catch below
            // would abort the WHOLE flush before bulkAppend (which ensures the dir
            // itself) ever runs, leaving no sidecar at all. ensureDir here makes the
            // dir exist before any write, independent of which write lands first.
            await ensureDir(adapter, this.coord.dir!);
            // F8: write/refresh meta BEFORE appending shard+jsonl. These three
            // writes aren't one transaction; ordering meta first means a crash
            // between them leaves meta-without-data (metaAccepts refuses cleanly;
            // the records re-embed next pass) instead of data-without-meta — a
            // fully-written sidecar the null-meta gate refuses, un-hydratable
            // until a full reindex, defeating the eviction-recovery the sidecar
            // exists for.
            const prior = await readDeviceMeta(adapter, this.coord.dir!, this.logger.deviceId);
            // A SIDECAR_FORMAT bump alone (no chunker/model/dim change) never forces
            // a full reindex — identityMatches deliberately excludes it (identity.ts).
            // An ordinary INCREMENTAL flush landing here after such a bump would
            // otherwise write the CURRENT format into meta below while every untouched
            // note's shard bytes are still in the PRIOR record stride — a lie that
            // later misleads this device's own compactOwnSidecar (and any peer
            // hydrating from it) into decoding stale-stride bytes as corrupt. A full
            // pass already clearDevice()'d at its start (prior reads null here), so
            // this only fires for the incremental case: wipe first so the meta write
            // below is never untrue relative to what's actually on disk.
            if (staleSidecarFormat(prior, job.identity.sidecarFormat)) {
                await clearDevice(adapter, this.coord.dir!, this.logger.deviceId, { preserveSeqFloor: true });
            }
            await writeDeviceMeta(adapter, this.coord.dir!, {
                // Canonical version slice (modelId/revision/chunkerVersion/dim)
                // from the single identity source — NOT embedder.modelId, which
                // is '' until a model load. format gates the cross-device protocol.
                ...expectationFor(job.identity),
                format: job.identity.sidecarFormat,
                deviceId: this.logger.deviceId,
                lastFullReindex: job.mode === 'full' ? new Date().toISOString() : (prior?.lastFullReindex ?? null),
                bgMean: job.bgMean,
                bgStd: job.bgStd,
            });
            await bulkAppend(adapter, this.coord.dir!, this.logger.deviceId, job.pending);
        } catch (e) {
            // Guarded so a logging failure can't turn into a rejection of this
            // method — the chain in flushSidecarAfterPass swallows anyway, but the
            // "never rejects" contract should hold locally, not by rescue.
            await this.logger.appendError('sidecar-commit', e).catch(() => {});
        }
    }

    private async reindexAllInner(onProgress?: (msg: string) => void, shouldContinue?: () => boolean, isPaused?: () => boolean): Promise<{ entry: IndexCompleteEntry; sidecarJob: SidecarFlushJob | null }> {
        const overallStart = performance.now();
        const memBefore = await snapshotMemory();

        // A full reindex re-attempts every file regardless of quarantine — clear
        // the backoff map so a file that has since become readable (e.g. an
        // iCloud placeholder that finished downloading) isn't skipped here too.
        this.unreadable.clear();

        // Reset. Close our long-lived connection first so deleteDatabase
        // isn't blocked by us, then re-open the (fresh, empty) DB.
        const resetStart = performance.now();
        this.store.close();
        const pre = await nukeDatabase(this.store.dbName);   // per-vault DB — never another vault's
        await this.store.open();   // scope-less: reuses the name from onload's open(appId)
        await this.store.setMeta({
            embeddingDim: EMBEDDING_DIM,
            lastIndexedAt: null,
            schemaVersion: META_SCHEMA_VERSION,
            modelId: this.embedder.modelId,
        });
        const resetEntry: ResetEntry = {
            type: 'reset',
            timestamp: new Date().toISOString(),
            droppedDatabase: this.store.dbName,
            chunksDeleted: pre.chunks,
            vectorsDeleted: pre.embeddings,
            durationMs: parseFloat((performance.now() - resetStart).toFixed(2)),
            pass: true,
            checks: [
                `✅ dropped database "${this.store.dbName}"`,
                `ℹ️ removed ${pre.chunks} chunks, ${pre.embeddings} vectors, ${pre.files} file records`,
            ],
        };
        await this.logger.append(resetEntry);

        // Scan. Filter out (a) Seek's own diagnostic outputs / machine-generated
        // chatter (see EXCLUDED_PATHS) and (b) anything the user has hidden via
        // Obsidian's "Excluded files" setting (see isUserIgnored).
        const allFiles = this.indexableFiles();
        const skipped: string[] = [];
        const files = allFiles.filter(f => {
            const include = this.shouldIndex(f.path);
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
        files.sort((a, b) => b.stat.mtime - a.stat.mtime);
        await this.emitProgress('scan', 0, files.length, 0, performance.now() - overallStart);

        // shouldContinue in full mode = the soft preempt (pause/resume between
        // files while the user searches — see embedAndCommitFiles' budget comment).
        // The engine's sidecar flush comes back PACKAGED (1C) and rides through to
        // reindexAll, which runs it after the mutex releases.
        const result = await this.embedAndCommitFiles(files, 'full', onProgress, overallStart, memBefore, { shouldContinue, isPaused });

        // Bump dataGeneration on COMPLETION. main.ts invalidates once BEFORE the
        // reindex, but a search firing during the rebuild then caches the frame /
        // binary index at that generation off the PARTIALLY-filled store; nothing
        // bumped again at the end, so a post-reindex search kept serving that
        // frozen partial frame (the frame + binary caches are generation-keyed
        // only — no chunk-count belt-and-braces like BM25 has). Invalidating here
        // forces the next search to rebuild against the complete index.
        this.invalidateBm25Cache();
        return result;
    }

    private async embedAndCommitFiles(
        files: TFile[],
        mode: 'full' | 'incremental',
        onProgress: ((msg: string) => void) | undefined,
        overallStart: number,
        memBefore: MemorySnapshot,
        // See EmbedCommitBudget in core/embed-commit.ts for what each field does.
        budget: {
            budgetMs?: number; shouldContinue?: () => boolean; addsSink?: DeltaAdd[]; storeWasEmpty?: boolean;
            isPaused?: () => boolean;
            removedSink?: string[]; removedBodiesSink?: Map<string, string>;
            metaPatchSink?: Array<{ id: string; meta: ChunkMeta }>;
        } = {},
    ): Promise<{ entry: IndexCompleteEntry; sidecarJob: SidecarFlushJob | null; quarantineUnwound: number }> {
        // mtime is a live getter: the pass records the mtime as of the moment it READS the file, not as of pass start.
        const live = files.map(f => ({ path: f.path, get mtime() { return f.stat.mtime; }, handle: f }));
        return embedAndCommit<TFile>(this.embedCommitCtx(), live, mode, onProgress, overallStart, memBefore, budget);
    }

    private embedCommitCtx(): EmbedCommitCtx<TFile> {
        const o = this;
        return {
            store: o.store,
            embedder: o.embedder,
            logger: o.logger,
            forensics: o.forensics,
            coord: o.coord,
            get disposed() { return o.disposed; },
            pluginVersion: PLUGIN_VERSION,
            read: f => o.app.vault.cachedRead(f.handle),
            chunksFor: (content, path, modifiedIso) => o.chunksFor(content, path, modifiedIso),
            newPacer: () => new CompositorPacer(),
            selectBucket: n => selectIndexBucket(n),
            identity: () => pluginIdentity(),
            clearSidecarDevice: () => clearDevice(o.app.vault.adapter, o.coord.dir!, o.logger.deviceId, { preserveSeqFloor: true }),
            reapDeadIdentitySidecars: () => o.reapDeadIdentitySidecars(),
            quarantineUnreadable: p => o.quarantineUnreadable(p),
            quotaToast: () => o.quotaToast(),
            invalidateBm25Cache: () => o.invalidateBm25Cache(),
            emitProgress: (phase, a, b, c, d) => o.emitProgress(phase as IndexProgressEntry['phase'], a, b, c, d),
        };
    }

    // The single index-membership predicate, shared by full reindex (the scan
    // filter) and every incremental path (computeDelta, reindexDelta). Live
    // events and full reindex MUST agree on what's in the index, or a
    // rename-into-Archive and a full reindex would disagree. Two unconditional
    // exclusions (Seek's own machine output) plus the user-toggleable "honor
    // ignored folders" — when on, Obsidian's "Excluded files" (e.g. Archive) are
    // out-of-index, so moving a note in is a soft-delete.
    private shouldIndex(path: string): boolean {
        return shouldIndexPath(this.app, this.settings, path);
    }

    // The candidate set for every collection site (reindexAll, computeDelta, and
    // the sidecar liveness oracles reChunkLive / collectLiveIds — all of which must
    // agree on the file set or base chunk_ids drift between writer and re-deriver).
    // getMarkdownFiles() is .md-only; we additionally index .base files (Obsidian
    // Bases — saved query/view definitions) via per-view synthetic documents. The
    // watcher in main.ts gates create/rename/delete on the same two extensions.
    private indexableFiles(): TFile[] {
        const md = this.app.vault.getMarkdownFiles();
        if (!this.settings.indexBases) return md;
        const bases = this.app.vault.getFiles().filter(f => f.extension === 'base');
        return bases.length === 0 ? md : [...md, ...bases];
    }

    // Content → chunks for one file, branching by extension. A .base file isn't
    // markdown — it's a YAML view definition — so it goes through extractBaseDocs
    // (one synthetic doc per view) + chunkBase, which builds a base-level chunk
    // plus one per non-generic view (each title-boosted, dense + BM25, the view
    // name in the 3.0x headings field). Every chunk-PRODUCTION site routes through
    // here so the .md/.base split lives in one place — reChunkLive, collectLiveIds,
    // dedupViaSidecar and carryOverHydrate all call this, not chunkContent, so a
    // base chunk's id is identical wherever it is re-derived. `modifiedIso` matches
    // the chunker's `modified` param contract.
    private chunksFor(content: string, path: string, modifiedIso: string | null): Chunk[] {
        return chunksForCore(this.chunker, extractBaseDocs, content, path, modifiedIso);
    }

    // Diff the persisted index against the live vault — the authoritative,
    // idempotent catch-up computation used by the startup sweep and the post-serve
    // hook. `dirty` = indexable files whose mtime advanced past the stored record
    // (or were never indexed); `deleted` = previously-indexed paths now gone OR no
    // longer indexable (moved into an ignored folder, or honor-ignored toggled on)
    // — a single "not in the live indexable set" test covers both.
    async computeDelta(): Promise<{ dirty: string[]; deleted: string[] }> {
        return computeDelta<TFile>({
            records: () => this.store.listFileRecords(),
            liveFiles: () => this.indexableFiles().filter(f => this.shouldIndex(f.path)).map(f => ({ path: f.path, mtime: f.stat.mtime, handle: f })),
            read: f => this.app.vault.cachedRead(f.handle),
            quarantine: this.unreadable,
            onQuarantined: path => console.warn(`[seek] quarantining persistently unreadable file (will retry on backoff / next full reindex): ${path}`),
            pluginVersion: PLUGIN_VERSION,
        });
    }

    // ── Heal a version-mismatched index WITHOUT a full re-embed, when it is provably
    // safe. enforceIndexIdentity (main.ts) calls this AFTER the embed-free sidecar
    // peer-hydrate attempt and BEFORE the desktop full-reindex / mobile-wait fallback,
    // so both platforms reach it. It is the fix for the cold-build identity bug
    // (PR #43): a huge vault's FIRST index is built by the incremental path, which
    // never stamped chunkerVersion/revision, so the gate reads a perfectly-current
    // index as stale and the only recovery used to be a ~7-min nuke+re-embed of chunks
    // already byte-identical to what a reindex would produce — visually identical to the
    // bug, and (stamping only at the end) re-run from zero on every interruption.
    //
    //   'stale'   — a GENUINELY old index: meta carries a PRESENT, differing
    //               chunker/model/dim. The caller runs the existing full-reindex / wait.
    //   'stamped' — the index was merely UNSTAMPED but is provably current (same model +
    //               dim, every file content-unchanged): stamp the live identity in place
    //               + recompute the display background, zero re-embed, never "0 files".
    //   'drained' — unstamped + a few files drifted: caught up via the normal resumable
    //               delta. Desktop (model loaded) then falls through to the stamp; mobile
    //               / model-not-loaded defers those embeds, so we report 'drained' —
    //               healed enough to stop the destructive loop, the deferred files stay
    //               invisible (content-addressed ids), never wrong.
    //
    // SAFETY: computeDelta proves the FILES are byte-unchanged, NOT that the stored
    // chunks were produced by the current chunker/model. So the stamp arm is gated on a
    // model+dim match — that rules out a cross-model index (old english-r2 vectors
    // stamped current = wrong dense scores, the one unacceptable outcome). The mismatch
    // that triggered the heal here is, by construction, only the absent chunker/revision
    // (modelId+dim already match, or identityMatches would not have failed on them alone
    // for an otherwise-current index). chunkerVersion/revision can't be verified without
    // re-chunking (the async enforceTokenBudget step we avoid to stay embed-free on
    // mobile), so they are ASSUMED current for a model-matching unstamped index: the
    // bounded worst case is stale chunk BOUNDARIES (same real text, same current model →
    // stale, never wrong), and any later edit re-chunks that file at the live version.
    async reconcileIdentityInPlace(): Promise<'stale' | 'stamped' | 'drained'> {
        // Almost always succeeds — enforceIndexIdentity read the meta moments ago to
        // detect the mismatch. A failure here is a transient mid-teardown read; return
        // 'stale' so the caller's fallback retries. Breadcrumb it: a PERSISTENT fault
        // would otherwise silently cost a reindex on every poll with no trace.
        const meta = await this.store.getMeta().catch(e => {
            console.warn('[seek] reconcileIdentityInPlace: meta unreadable, treating as stale', e);
            return null;
        });
        if (!meta) return 'stale';

        // Gate (identity.ts): only an UNSTAMPED, current-model+dim index is safe to stamp
        // in place. A present chunkerVersion (genuinely old / stamped-but-bumped) or a
        // cross-model/dim index falls through to the existing full-reindex / wait.
        if (identityHealEligibility(meta) === 'stale') return 'stale';

        // Prove the files are byte-unchanged (embed-free AND tokenizer-free; on a stable-
        // mtime vault classifyFileDelta never even reads a file).
        let delta = await this.computeDelta();
        if (delta.dirty.length || delta.deleted.length) {
            // A few files drifted since the index was built. Catch just those up through
            // the normal resumable delta — desktop embeds (only if the model is already
            // loaded; we never force a load here, that is the caller's job), mobile stays
            // embed-free and defers. reindexDelta takes its OWN write mutex, so it is NOT
            // nested under one here.
            const embed = !isMobilePlatform() && this.embedder.loaded;
            await this.reindexDelta(delta.dirty, delta.deleted, { embed });
            delta = await this.computeDelta();
            if (delta.dirty.length || delta.deleted.length) return 'drained'; // deferred / still behind — don't stamp
        }

        // STAMP — one atomic write transaction under the write mutex (serializes against
        // a concurrent flush). Recompute the display-only dense background from the
        // stored int8 vectors (embed-free): the same accumulation a full pass does, just
        // dequantized first; the ~0.1% int8 drift is below the display tolerance and the
        // background is NOT a ranking input (dense-stats.ts). Mirrors the proven in-place
        // stamp at hydrateSidecar.
        await this.coord.runExclusive(async () => {
            const { vecs } = await this.store.listAllEmbeddings();
            const bgSum = new Float64Array(EMBEDDING_DIM);
            let bgN = 0;
            const reservoir = new VecReservoir(BG_RESERVOIR);
            for (const qv of vecs) {
                const v = dequantizeInt8(qv.q, qv.s);
                bgN++;
                for (let d = 0; d < v.length; d++) bgSum[d] += v[d];
                reservoir.add(v);
            }
            const bg = denseBgStats(bgSum, bgN, reservoir.sample);
            const id = pluginIdentity();
            const m = await this.store.getMeta();
            await this.store.setMeta({
                ...m,
                embeddingDim: EMBEDDING_DIM,
                modelId: m.modelId ?? MODEL_ID,
                chunkerVersion: id.chunkerVersion,
                analyzerVersion: id.analyzerVersion,
                revision: id.revision,
                bgMean: bg?.mean ?? m.bgMean,
                bgStd: bg?.std ?? m.bgStd,
            });
        });
        this.bgStatsGen = -1;        // invalidate the cached bg accessor (mirrors hydrateSidecar)
        this.invalidateBm25Cache();  // bump dataGeneration so the next search rebuilds against the stamped meta
        return 'stamped';
    }

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
    async reindexDelta(
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
        const result = await this.coord.runExclusive(async () => {
            const mutexStart = performance.now();
            let release!: () => void;
            this.coord.currentDelta = new Promise<void>(r => { release = r; });
            try {
                // Fix A: snapshot emptiness BEFORE phase-1 drops — mirrors
                // embedAndCommitFiles. The common cold build runs an embed pass, which
                // stamps the live identity itself (read back into prevMeta below). This
                // covers the residual path where a cold build commits NOTHING via the
                // engine (every file hydrated from a peer sidecar / carried over), so
                // the meta stamp below is the ONLY one — it must still claim the live
                // identity rather than copy the empty store's `undefined` fields.
                const storeWasEmpty = (await this.store.count()).chunks === 0;
                // F13 carry-over: harvest tiers of chunks about to be removed, keyed
                // by embed text, so a move / no-op re-flush reuses the identical vector
                // instead of re-embedding. Deleted paths lose their chunks in phase 1,
                // so harvest them FIRST; only worth it when this pass will embed.
                const carryOver = new Map<string, { q: QuantVec; sign: Uint8Array }>();
                const wantCarryOver = opts.embed && this.embedder.loaded;
                if (wantCarryOver) await this.harvestCarryOverInto(carryOver, deletedPaths);

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
                const wantRemovalBodies = !!(this.frameCache && this.bm25Cache);
                // In-place metadata patches from the engine's chunk-diff: id-stable
                // chunks whose BM25-irrelevant metadata drifted (line numbers,
                // dates). applyDelta swaps the frame rows; IDB was already updated.
                const metaPatches: Array<{ id: string; meta: ChunkMeta }> = [];
                // Phase 1: structural drops (no model).
                let deletedChunks = 0;
                for (const path of deletedPaths) {
                    if (wantRemovalBodies) await captureRemovalBodies(this.store, path, removedBodies);
                    const ids = await this.store.deleteFile(path);
                    deletedChunks += ids.length;
                    removedIds.push(...ids);
                }

                // Phase 2: embed dirty files (only when we can do it now).
                const indexable = dirtyPaths.filter(p => this.shouldIndex(p));
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
                const metaModel = (await this.store.getMeta()).modelId ?? LEGACY_ENGLISH_MODEL_ID;
                const modelDrift = opts.embed
                    && this.embedder.loaded && metaModel !== this.embedder.modelId;
                if (opts.embed && !modelDrift && indexable.length > 0) {
                    const allDirty = indexable
                        .map(p => this.app.vault.getAbstractFileByPath(p))
                        .filter((f): f is TFile => f instanceof TFile);
                    // Per-BURST file cap (maxFiles), applied here rather than inside
                    // the engine, and recency-first: only the files this burst will
                    // actually re-embed get their stale chunks dropped — files
                    // deferred to a later burst keep their OLD searchable chunks
                    // until their turn (the drain loop's computeDelta re-finds them
                    // dirty and slices them into a subsequent burst). Deleting all
                    // dirty files up front would make every not-yet-embedded edit
                    // vanish from search for the whole multi-burst drain. undefined
                    // maxFiles (desktop / flushDirty / reindexAll) = the whole set.
                    allDirty.sort((a, b) => b.stat.mtime - a.stat.mtime);
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
                    const afterCarry = await this.carryOverHydrate(toEmbed, carryOver);
                    carriedOver = toEmbed.length - afterCarry.length;
                    // Dedup-before-embed: hydrate the files the sidecar already covers
                    // (a peer device embedded this exact content) rather than
                    // re-embedding. Passes the removal sinks so it can drop + surface
                    // the stale rows the hydrated chunk set no longer references.
                    const remaining = await this.dedupViaSidecar(afterCarry, adds, removedIds, removedBodies, metaPatches);
                    sidecarHydrated = afterCarry.length - remaining.length;
                    remaining.sort((a, b) => b.stat.mtime - a.stat.mtime);
                    if (remaining.length > 0) {
                        const overallStart = performance.now();
                        const memBefore = await snapshotMemory();
                        // maxFiles is already enforced by the slice above; the engine
                        // only needs the wall-clock + hidden aborts (for one huge note
                        // or a mid-burst background).
                        const engineOut = await this.embedAndCommitFiles(remaining, 'incremental', opts.onProgress, overallStart, memBefore,
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
                    this.lastDeltaFallbackReason = null;
                    if (!skippedBecause) {
                        const applyStart = performance.now();
                        appliedIncrementally = await this.applyDelta(adds, removedIds, removedBodies, metaPatches);
                        applyDeltaMs = performance.now() - applyStart;
                    }
                    if (!appliedIncrementally) this.invalidateBm25Cache();
                    deltaTelemetry = {
                        appliedIncrementally,
                        ...(skippedBecause ? { skippedBecause } : {}),
                        ...(!skippedBecause && !appliedIncrementally && this.lastDeltaFallbackReason
                            ? { fallbackReason: this.lastDeltaFallbackReason } : {}),
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
                    const prevMeta = await this.store.getMeta();
                    // Fix A: a cold first-build (storeWasEmpty) claims the live identity
                    // here. For the common embed path this is a no-op — embedAndCommitFiles
                    // already stamped it, so prevMeta reads it back — but it is the ONLY
                    // stamp for the residual hydrate/carry-only cold build, whose prevMeta
                    // would otherwise be `undefined` and re-trip the gate. A NON-empty
                    // store carries identity forward unchanged: an ordinary delta never
                    // re-stamps, and a legacy index must stay stale for the gate to heal.
                    // reindexDelta is always an incremental (delta) pass, so a cold
                    // first-build (empty store) is its only stamp-live case.
                    const live = shouldStampLiveIdentity('incremental', storeWasEmpty) ? pluginIdentity() : null;
                    await this.store.setMeta({
                        embeddingDim: EMBEDDING_DIM,
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
                this.coord.currentDelta = null;
            }
        }).finally(() =>
            // 1C: run the pass's packaged sidecar flush AFTER the mutex releases,
            // awaited before reindexDelta resolves (or rethrows) so callers keep
            // "delta resolved ⇒ sidecar flushed". flushSidecarAfterPass never
            // rejects, so this can't mask the critical section's own error.
            this.flushSidecarAfterPass(sidecarJob));
        if (result.deletedChunks > 0 || result.deletedPaths > 0 || result.embedded || result.sidecarHydrated > 0 || result.carriedOver > 0) {
            await this.exportMcpAfterSuccessfulCommit('incremental');
        }
        // v16 (issue #5): persist the patch outcome. Off the mutex,
        // fire-and-forget — telemetry never delays the pass. (Local copy: the
        // closure assignment above defeats TS's narrowing on the outer let.)
        const patchOutcome: Omit<DeltaApplyEntry, 'type' | 'timestamp'> | null = deltaTelemetry;
        if (patchOutcome !== null) {
            const entry: DeltaApplyEntry = Object.assign(
                { type: 'delta-apply' as const, timestamp: new Date().toISOString() }, patchOutcome);
            void this.logger.append(entry).catch(() => {});
        }
        // Re-warm only when we did NOT patch incrementally (the patch is the warm).
        // Fire-and-forget, off the mutex — the moment the flush scheduler already
        // judged quiet enough for embed work, so the rebuild lands here rather than
        // on the next search. A carry-over delta always lands here (it forces the
        // non-incremental path above), so result.carriedOver gates a re-warm too.
        if (!appliedIncrementally
            && (result.deletedChunks > 0 || result.deletedPaths > 0 || result.embedded || result.sidecarHydrated > 0 || result.carriedOver > 0)) {
            void this.warmCaches('delta');
        } else if (appliedIncrementally) {
            // The incremental patch already kept the resident cache warm, so there is
            // no rebuild to do — but historically it also skipped persistBm25, leaving
            // the disk blob stale until a full rebuild. Re-persist (throttled, embed-
            // free) so the next cold start loads a near-fresh blob instead of refitting.
            // Ghost-discard dirt past the threshold instead takes the ordinary
            // rebuild (see reconcileGhostDirt) — the rebuild's own warm re-persists.
            if (!this.reconcileGhostDirt()) this.maybePersistResidentBm25();
        }
        return result;
    }

    // Ghost-dirt safety valve (issue #5). The only discard-path tombstones left
    // are the ghost guards (tolerant-load divergence) — a handful of postings
    // whose df effect self-heals per queried term (searches clean dirty
    // postings as they walk them). Small dirt is deliberately LEFT ALONE:
    // MiniSearch's vacuum() holds a live radix-tree iterator across its timer
    // yields, so a vacuum overlapping commits or search-time cleanup can have
    // its iterator invalidated mid-walk — and a REJECTED vacuum never resets
    // MiniSearch's _currentVacuum, permanently wedging every later vacuum on
    // that instance (2026-07-30 review; the off-mutex vacuum valve that
    // briefly lived here was retired for exactly this). Past the threshold —
    // pathological ghost accumulation — the safe reclaim is the ordinary
    // invalidate + rebuild: a fresh fit, no vacuum involved, built by the same
    // machinery every other fallback uses. Returns true when a rebuild was
    // kicked (the caller skips its own persist — the warm re-persists).
    private static readonly GHOST_DIRT_REFIT_THRESHOLD = 64;
    private reconcileGhostDirt(): boolean {
        const bm = this.bm25Cache;
        if (!bm) return false;
        const dirt = bm.dirtCount;
        if (dirt === 0) return false;
        this.forensics?.beat('ghost-dirt', { dirt, refit: dirt >= SearchOrchestrator.GHOST_DIRT_REFIT_THRESHOLD });
        if (dirt < SearchOrchestrator.GHOST_DIRT_REFIT_THRESHOLD) return false;
        this.invalidateBm25Cache();
        void this.warmCaches('ghost-dirt');
        return true;
    }


    private async diffFileAgainstStore(
        path: string,
        fileChunks: Chunk[],
        budget: { addsSink?: DeltaAdd[]; removedSink: string[]; removedBodiesSink: Map<string, string>; metaPatchSink: Array<{ id: string; meta: ChunkMeta }> },
    ): Promise<{ keepIds: Set<string>; embedIds: Set<string> } | null> {
        return planFileDiff(this.store, path, fileChunks, budget);
    }

    private async applyDelta(
        adds: DeltaAdd[],
        removedIds: string[],
        removedBodies: ReadonlyMap<string, string>,
        metaPatches: ReadonlyArray<{ id: string; meta: ChunkMeta }> = [],
    ): Promise<boolean> {
        return applyDeltaCore({
            frame: this.frameCache,
            bm: this.bm25Cache,
            settings: this.settings,
            bm25Generation: this.bm25CacheGeneration,
            bm25Props: this.bm25CacheProps,
            bm25Headings: this.bm25CacheHeadings,
            generation: () => this.coord.generation,
            bumpGeneration: () => this.coord.bumpGeneration(),
            stamp: n => this.res.stampBm25(n),
            setSynonyms: m => { this.synonymCache = m; },
            // fork 1.2.1 src/search.ts:2379 SearchOrchestrator.applyDelta (link-pair patch; the mining is host-side, so it lives here not in core)
            patchLinkPairs: touchedPaths => {
                if (!this.linkPairCache) return;
                const mined = mineLinkPairsForPaths(this.app, p => shouldIndexPath(this.app, this.settings, p), touchedPaths);
                for (const p of touchedPaths) {
                    const pairs = mined.get(p);
                    if (pairs) this.linkPairCache.set(p, pairs);
                    else this.linkPairCache.delete(p);
                }
            },
            fallback: (reason, detail) => this.deltaFallback(reason, detail),
            logError: (tag, e) => this.logger.appendError(tag, e),
        }, adds, removedIds, removedBodies, metaPatches);
    }

    // Log why the incremental path declined + signal the caller to full-rebuild.
    // S4 tripwire instrumentation: each decline is a full O(corpus) cache rebuild
    // (listAllMeta + listAllBinary + embeddings scan), so per-reason session counts
    // ride every beat — a churny session repeatedly tripping the SAME reason is the
    // signal that reducing fallback frequency is worth engineering against. Until
    // that data says otherwise, the fallback itself stays the correct design
    // ("slow, never wrong").
    // `reason` must be a STABLE slug — it keys deltaFallbackCounts, so per-call
    // values (counts, sizes) go in `detail`, which rides the beat payload only.
    // The most recent decline's slug, for the delta-apply entry (v16) — the
    // per-reason counts above ride heartbeats, but wlo2's reports showed those
    // don't surface the REASON of a specific pass's fallback.
    private lastDeltaFallbackReason: string | null = null;
    private deltaFallback(reason: string, detail?: Record<string, unknown>): false {
        this.lastDeltaFallbackReason = reason;
        const n = (this.deltaFallbackCounts.get(reason) ?? 0) + 1;
        this.deltaFallbackCounts.set(reason, n);
        // console.* is invisible on mobile; the beat is the field-observable channel.
        console.info(`[seek] applyDelta fallback: ${reason} — full cache rebuild (×${n} this session)`
            + (detail ? ` ${JSON.stringify(detail)}` : ''));
        this.forensics?.beat('delta-fallback', { reason, sessionCount: n, ...detail });
        return false;
    }

    // Drift-detector trip handler for the QUERY path (the applyDelta path returns
    // false to fall back instead). Logs loudly + a user Notice, drops the caches
    // for a full rebuild, and kicks a warm — turning a silent, in-bounds row-space
    // mis-join into a visible "rebuilt from scratch" event.
    private coherenceDriftCount = 0;          // log-only diagnostic counter (trip #N)
    private lastCoherenceWarmAt = -Infinity;  // performance.now() of the last drift re-warm
    // Injected by the plugin (setPersistentDriftHandler). Fired from onCoherenceDrift's
    // re-trip branch — the orchestrator is pull-based (it owns no outbound scheduling),
    // so this mirrors the modal's onSearchActivity/onQueryInFlight injection: the plugin
    // owns the embed-free recovery scheduler (runDriftRecovery) and the indexHealth flag.
    private onPersistentDrift?: () => void;
    setPersistentDriftHandler(fn: () => void): void {
        this.onPersistentDrift = fn;
    }
    private onCoherenceDrift(where: string): void {
        this.coherenceDriftCount++;
        const now = performance.now();
        const { warm } = coherenceDriftDecision(now, this.lastCoherenceWarmAt, COHERENCE_DRIFT_COOLDOWN_MS);
        // Always drop the suspect caches — a mis-coupled frame/BM25 must never serve
        // (the cost is trivial and correctness-critical). Only the heavy re-warm and
        // the user-facing Notice are rate-limited (decision.warm).
        this.invalidateBm25Cache();
        if (!warm) {
            // Re-tripped inside the cooldown ⇒ a PERSISTENT mis-join, not a one-off.
            // Rebuilding again inline would just thrash (this turned one bad delta into
            // the 2026-06-18 mobile meltdown). The cache is invalidated; the next search
            // rebuilds it lazily via the cold path. Throttled log, no toast storm.
            console.error(`[seek] frame/BM25 drift at ${where} re-tripped within ${COHERENCE_DRIFT_COOLDOWN_MS / 1000}s (trip #${this.coherenceDriftCount}) — escalating to embed-free recovery`);
            // Hand off to the plugin's bounded, embed-free recovery ladder (sidecar
            // hydrate → warm → verify → degraded). It self-suppresses re-fires per
            // generation, so firing on every re-trip is cheap. No inline rebuild here.
            this.onPersistentDrift?.();
            return;
        }
        this.lastCoherenceWarmAt = now;
        console.error(`[seek] frame/BM25 row-space drift detected at ${where} — dropping caches for a full rebuild (trip #${this.coherenceDriftCount})`);
        void this.warmCaches('coherence-drift');
    }

    // Rebuild the IDB index from the vault-file sidecar without re-embedding —
    // the iOS-eviction / fresh-device recovery path. Runs under the write mutex
    // (can't overlap a reindex/delta), reproduces ids by re-chunking the live
    // vault, and writes only the intersection that isn't already in IDB. Returns
    // null when the sidecar is off. Idempotent: a warm index hydrates nothing.
    async hydrateSidecar(): Promise<HydrateResult | null> {
        if (!this.coord.sidecarOn()) return null;
        // Was the index empty BEFORE this hydrate? Captured outside the mutex; a race
        // that populates it concurrently only costs the identity stamp below (degrades
        // to the un-stamped path), never correctness.
        const wasEmpty = (await this.store.count()).chunks === 0;
        const result = await this.coord.runExclusive(() =>
            hydrateFromSidecar(this.hydrateDeps(() => this.reChunkLive())),
        );
        this._peerAhead = result.peerAhead; // refresh the "newer index exists" signal per scan
        // Stamp the build identity when hydrating onto a PREVIOUSLY-EMPTY index: every
        // chunk came from a metaAccepts-filtered (current-identity) producer, so the
        // index is provably at the current identity. This lets a hydrate-only device
        // (cold iOS, lastIndexedAt=null) report a current identity on its next boot —
        // without it the boot gate would needlessly nuke+rehydrate, or (no peer that
        // boot) falsely drop into the "wait for desktop" empty state. NOT stamped on a
        // non-empty hydrate: that index may still hold stale orphans, and only a nuke
        // (or the Phase-3 subtractive hydrate) clears them — claiming current identity
        // there would mask them from the gate.
        if (wasEmpty && result && result.hydrated > 0) {
            const id = pluginIdentity();
            const m = await this.store.getMeta();
            await this.store.setMeta({ ...m, modelId: m.modelId ?? MODEL_ID, chunkerVersion: id.chunkerVersion, analyzerVersion: id.analyzerVersion, revision: id.revision });
        }
        // Inherit display calibration from the producer when this device has none
        // of its own (a hydrate-only iOS device that never full-reindexed). Only
        // fill when absent — a local full reindex's stats describe THIS index more
        // faithfully and must win. Invalidate the cached accessor so the next
        // search re-reads.
        if (result && result.bgMean != null && result.bgStd != null) {
            const m = await this.store.getMeta();
            if (m.bgMean == null) {
                await this.store.setMeta({ ...m, bgMean: result.bgMean, bgStd: result.bgStd });
                this.bgStatsGen = -1;
            }
        }
        // A hydrate is a store mutation: drop caches so the next search rebuilds
        // against the restored index (mirrors reindex/delta completion).
        if (result && result.hydrated > 0) {
            this.invalidateBm25Cache();
            void this.warmCaches('hydrate');
            this.warnedStranded = false; // index is populated again — re-arm the empty-net warning
        } else if (result) {
            // Restored nothing — if the index is also empty, search will silently
            // return no results. Surface that (the net-is-gone case).
            await this.warnIfIndexStranded(result);
        }
        return result;
    }

    // Embed-free convergence: nuke this device's IDB, then hydrate it from the synced
    // sidecar. The mobile-safe counterpart to "Full reindex" — it loads the TOKENIZER
    // only (no 250 MB model, no WASM embed, no jetsam), so it rebuilds a clean index
    // in seconds instead of a hot multi-minute on-device embed. Use it when a device
    // has accumulated STALE/orphan chunks it never cleaned up (e.g. it never cleanly
    // re-chunked after a chunker change, so computeDelta — which only re-examines
    // file-watcher-flagged files — never deleted the old chunks). reChunkLive
    // reproduces only the CURRENT chunker's ids, so the orphans are simply not
    // recreated; ~all current chunks come back from the sidecar (vectors + the Phase-3
    // BM25 blob), and the few genuinely-local chunks fall to the normal gentle catch-up.
    //
    // SAFETY: refuses to nuke unless a compatible sidecar producer is actually present
    // — otherwise a not-yet-synced sidecar would leave the index empty. The device's
    // OWN shard is kept (it's a producer too), so its local-only chunks re-hydrate.
    async rebuildFromSidecar(): Promise<HydrateResult | null> {
        if (!this.coord.sidecarOn()) return null;
        const expect = expectationFor();
        const producers = await rankAcceptedProducers(this.app.vault.adapter, this.coord.dir!, expect);
        if (producers.length === 0) {
            // Nothing compatible to rebuild FROM — do NOT nuke. acceptedProducers:0
            // signals the caller to tell the user the sidecar hasn't synced yet.
            return { scanned: 0, needed: 0, hydrated: 0, skippedPartialNotes: 0, refusedProducers: 0, acceptedProducers: 0, peerAhead: false, hydratedNotePaths: [] };
        }
        // 1. Nuke + reopen under the write mutex (mirrors reindexAllInner's reset) so a
        //    delta/search can't race the close→delete→open window. modelId = the
        //    canonical sidecar model (NOT embedder.modelId, which is '' on a cold
        //    mobile embedder) so the rebuilt index's stamp matches the producer's.
        await this.coord.runExclusive(async () => {
            this.store.close();
            await nukeDatabase(this.store.dbName);
            await this.store.open();
            const id = pluginIdentity();
            await this.store.setMeta({ embeddingDim: EMBEDDING_DIM, lastIndexedAt: null, schemaVersion: META_SCHEMA_VERSION, modelId: MODEL_ID, chunkerVersion: id.chunkerVersion, analyzerVersion: id.analyzerVersion, revision: id.revision });
        });
        // 2. Drop every resident cache that referenced the nuked index, then hydrate
        //    (its own write mutex; the now-empty store forces a full reconcile).
        this.invalidateBm25Cache();
        return this.hydrateSidecar();
    }

    // Does ANY other device have a sidecar in the index dir, regardless of its identity?
    // A cheap, embed-free signal (a directory listing — no meta read, no model) that this
    // vault is multi-device. When the local index is version-stale and rebuildFromSidecar
    // found no CURRENT-identity producer, a present peer means a current index is (or will
    // be) on its way — so the UI says "syncing", not "reindex". Self is excluded: our own
    // stale sidecar is not an incoming heal. A long-dead peer's leftover sidecar is a rare,
    // benign false-positive (it only keeps the calm banner up a little longer; reapDead-
    // IdentitySidecars clears it at the next full reindex on some device).
    async peerSidecarPresent(): Promise<boolean> {
        if (!this.coord.sidecarOn()) return false;
        const ids = await listSidecarDeviceIds(this.app.vault.adapter, this.coord.dir!);
        return ids.some(id => id !== this.logger.deviceId);
    }

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
    async sweepOrphanChunks(opts: { shouldContinue?: () => boolean } = {}): Promise<{ removed: number; completed: boolean }> {
        // Snapshot all chunk ids + the referenced set TOGETHER under the write mutex.
        // The embed commit is one atomic tx now (S1: chunks + file record together),
        // but the HYDRATE path still flushes chunk batches before its file records
        // land (batches span file boundaries), so an UNLOCKED snapshot could catch a
        // just-hydrated chunk before its record and delete it as a false orphan —
        // and pre-S1 indexes can still hold genuinely record-less chunks. (Content-
        // addressing makes that self-healing, but it is still a real freshness hit,
        // so keep the snapshot locked.) The only residual — a rare re-add of the SAME
        // content between batches — reuses the same id and is itself self-healing.
        const orphans = await this.coord.runExclusive(async () => {
            const allIds = await this.store.getAllChunkIds();
            const referenced = new Set<string>();
            for (const rec of await this.store.listFileRecords()) {
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
            await this.coord.runExclusive(() => this.store.deleteChunksByIds(batch));
            deleted += batch.length;
        }
        if (deleted > 0) {
            this.invalidateBm25Cache();
            void this.warmCaches('orphan-sweep');
        }
        return { removed: deleted, completed };
    }

    // Dead-identity sidecar reap (Phase 3 §4): at a full reindex — which republishes
    // THIS device at the current identity — remove every OTHER device's sidecar files
    // whose meta identity no longer matches this build. Provably useless (metaAccepts
    // refuses them, so no current-version device can hydrate from them), so which
    // device wrote them is irrelevant; sync-safe because an un-updated device just
    // re-creates its own until it updates. Never reaps self (just rewritten) or a
    // current-identity peer (a valid producer). A null/torn meta fails the gate and is
    // reaped too — it was unusable anyway. Returns the device count reaped.
    //
    // Enumerates by listSidecarDeviceIds (the UNION of all artifact types), NOT by
    // jsonl alone: clearDevice deletes a device's four files non-atomically and sync
    // propagates each independently, so a dead device's jsonl can already be gone
    // while its meta/bm25/shards linger. A jsonl-keyed reap would never revisit those
    // leftovers (permanent disk leak); the union re-finds a half-cleared device and
    // clearDevice — idempotent + exists-guarded — finishes it on this or a later
    // pass. The metaAccepts gate is unchanged, so a current peer mid-sync (meta
    // present, current identity) is still kept; only provably-stale or unprovable
    // (no/torn meta) devices are reaped, exactly as before.
    private async reapDeadIdentitySidecars(): Promise<number> {
        if (!this.coord.sidecarOn()) return 0;
        const dir = this.coord.dir!;
        const adapter = this.app.vault.adapter;
        const expect = expectationFor();
        let reaped = 0;
        for (const dev of await listSidecarDeviceIds(adapter, dir)) {
            if (dev === this.logger.deviceId) continue;     // never reap self
            if (metaAccepts(await readDeviceMeta(adapter, dir, dev), expect)) continue; // current peer — keep
            await clearDevice(adapter, dir, dev);
            reaped++;
        }
        return reaped;
    }

    // Post-recovery health check: rebuild the frame + BM25 from the (reconciled)
    // IDB and assert their row spaces agree. Embed-free — ensureFrame/ensureBm25
    // only read the store + fit BM25, no model touch. full=true runs the exhaustive
    // id↔row check (rare, off the hot path). True when coherent (or empty — an empty
    // index can't be incoherent); false when drift survived the rebuild (a genuinely
    // corrupt IDB → the plugin flips indexHealth to 'degraded').
    async verifyCoherent(): Promise<boolean> {
        const frame = await this.ensureFrame();
        if (!frame) return true;
        await this.ensureBm25(frame.orderedChunks);
        if (!this.bm25Cache) return true;
        return frameBm25Coherent(frame, this.bm25Cache, true);
    }

    // In-session cache of the sidecar-dir signature at the last successful
    // reconcile. Seeded from localStorage on first use (see reconcileSigKey) so
    // the gate SURVIVES reloads — without that, an iOS crash-relaunch loop reset
    // this to null every rebirth and re-chunked the entire vault on each onload.
    private lastReconcileSig: string | null = null;

    // Reconcile-signature storage key. App#saveLocalStorage vault-scopes by the
    // vault's appId, so cross-VAULT clobber is handled automatically; we KEEP
    // dbName in the key so two co-installed Seek builds (id 'seek' + 'seek-prototype')
    // in the SAME vault still don't clobber each other's gate (same appId namespace).
    private reconcileSigKey(): string {
        return `seek:reconcile-sig:${this.store.dbName}`;
    }

    private loadPersistedReconcileSig(): string | null {
        try {
            const v: unknown = this.app.loadLocalStorage(this.reconcileSigKey());
            return typeof v === 'string' ? v : null;
        }
        catch { return null; }   // unavailable (private mode/quota) → fall back to in-memory gating
    }

    private persistReconcileSig(sig: string): void {
        this.lastReconcileSig = sig;
        try { this.app.saveLocalStorage(this.reconcileSigKey(), sig); }
        catch { /* best-effort; in-memory cache still gates this session */ }
    }

    // Empty-store probe for the reconcile gate's mandatory eviction guard. A
    // count() failure is treated as empty (sweep) — the safe side: a needless
    // sweep costs time, a skipped recovery costs all search results.
    private async indexIsEmpty(): Promise<boolean> {
        try { return (await this.store.count()).files === 0; }
        catch { return true; }
    }

    // Public cold-start probe for the search modal. Returns the indexed chunk count,
    // or null when the store can't be read yet (mid-init / not open). The modal flips
    // to its "not indexed" onboarding copy only on a confirmed 0 and leaves its resting
    // copy untouched on null — so a still-warming index is never mislabeled "not
    // indexed". chunks (not files) is the true "is anything searchable" signal.
    async indexedChunkCount(): Promise<number | null> {
        try { return (await this.store.count()).chunks; }
        catch { return null; }
    }

    // Gated whole-vault reconcile, shared by BOTH the onload sweep and the 5-min
    // interval. Skips the expensive reChunkLive sweep when the sidecar dir is
    // byte-identical to the last successful reconcile AND the local index is
    // populated; always sweeps when the store is empty (iOS eviction / fresh
    // device — see shouldReconcileSidecar). The signature is persisted, so a
    // crash-relaunch with an unchanged vault no longer re-chunks for nothing.
    // The manual `seek-sidecar-reconcile` command and the drift-recovery ladder
    // deliberately bypass this and call hydrateSidecar() directly (explicit
    // user / recovery intent must never be gated).
    async reconcileSidecarIfChanged(): Promise<HydrateResult | null> {
        if (!this.coord.sidecarOn()) return null;
        const sig = await sidecarDirSignature(this.app.vault.adapter, this.coord.dir!, this.logger.deviceId);
        const prev = this.lastReconcileSig ?? this.loadPersistedReconcileSig();
        if (!shouldReconcileSidecar(sig, prev, await this.indexIsEmpty())) {
            // Signature unchanged → the (expensive) hydrate is skipped, but _peerAhead resets
            // to false on every new orchestrator and ONLY hydrateSidecar refreshes it. Recover
            // the bit with a cheap meta-only probe so the peer-ahead banner + mobile grind-stop
            // survive an app relaunch on an unchanged vault (the common iOS case) instead of
            // silently disengaging while falsely reading "healthy". No reChunk, no mutation —
            // just a producer-meta read; mirrors hydrateFromSidecar's own peerAhead predicate.
            this._peerAhead = await probePeerAhead(this.app.vault.adapter, this.coord.dir!, expectationFor());
            return null;
        }
        const result = await this.hydrateSidecar();
        this.persistReconcileSig(sig);
        return result;
    }

    // Re-chunk every live, indexable note AND .base — the liveness oracle for a
    // full hydrate. Mirrors computeDelta's file filter (indexableFiles, so bases
    // are included) AND embedAndCommitFiles' full chunk pipeline: chunksFor THEN
    // enforceTokenBudget, so chunk_ids match exactly what indexing produced —
    // including base chunks (chunksFor → chunkBase), which is what lets the phone
    // rehydrate base vectors embed-free instead of dropping them. The token-budget
    // re-split is load-bearing,
    // NOT optional: chunk_id = chunkIdFor(path, title, content), and on long
    // notes indexing splits oversize chunks into new contents → new ids. Without
    // reproducing that split here, the sidecar lookup missed every split note
    // (hydrated:0 → fell back to a full on-device re-embed → iPhone jetsam; see
    // the 2026-06-14 forensics). Loads the tokenizer ONLY (a few MB, no ~250 MB
    // model) so the hydrate stays mobile-safe.
    private async reChunkLive(): Promise<ReChunkedNote[]> {
        await this.embedder.ensureTokenizer();
        const out: ReChunkedNote[] = [];
        for (const f of this.indexableFiles().filter(f => this.shouldIndex(f.path))) {
            let content: string;
            try {
                content = await this.app.vault.cachedRead(f);
            } catch {
                continue;
            }
            let chunks = this.chunksFor(content, f.path, new Date(f.stat.mtime).toISOString());
            if (chunks.length === 0) continue;
            try {
                chunks = (await enforceTokenBudget(chunks, ts => this.embedder.tokenCounts(ts))).chunks;
            } catch (e) {
                // Tokenizer hiccup on one note — skip its hydrate (it just embeds
                // later via the catch-up); never abort the whole hydrate.
                await this.logger.appendError(`reChunkLive-tokenBudget:${f.path}`, e);
                continue;
            }
            if (chunks.length > 0) out.push({ notePath: f.path, mtimeMs: f.stat.mtime, chunks, contentHash: cyrb53Hex(content) });
        }
        return out;
    }

    // The live-vault chunk_id set + whether it is COMPLETE — the liveness oracle for
    // sidecar compaction. Mirrors reChunkLive's id pipeline (chunksFor THEN
    // enforceTokenBudget over indexableFiles, so ids match what indexing wrote for
    // both notes and bases — without the base coverage compaction would count every
    // base chunk dead and GC it). Returns only ids and,
    // critically, a completeness flag: reChunkLive SWALLOWS per-note read/tokenizer
    // errors (hydrate only skips, which is non-destructive), but compaction DELETES on
    // this oracle, so a single skipped note would wrongly drop that note's live records.
    // `complete:false` on ANY skip tells the caller to abort the compaction and retry
    // when the transient error clears. Empty notes (no chunks) are not skips — they have
    // no ids to drop. Kept separate from reChunkLive on purpose: the load-bearing hydrate
    // path stays untouched, at the cost of one extra (tokenizer-only) re-chunk per session.
    private async collectLiveIds(): Promise<{ ids: Set<string>; complete: boolean }> {
        const ids = new Set<string>();
        try {
            await this.embedder.ensureTokenizer();
        } catch (e) {
            // A tokenizer-load failure (model files mid-sync on a cold mobile launch) makes
            // the whole snapshot untrustworthy — report incomplete (transient → caller
            // retries) rather than throwing into an anonymous swallowed catch upstream.
            await this.logger.appendError('collectLiveIds-ensureTokenizer', e);
            return { ids, complete: false };
        }
        let complete = true;
        let sinceYield = 0;
        for (const f of this.indexableFiles().filter(f => this.shouldIndex(f.path))) {
            // Yield the main thread every few files: this whole-vault re-chunk +
            // tokenizer pass runs at least once per session (any sidecar past the
            // byte floor reaches the oracle even when nothing is dead) and was a
            // solid CPU burn with no yields — issue #5-class background jank.
            // cheapYield (scheduler.yield / setTimeout(0)), NOT the rIC pacer:
            // this runs inside compactDevice's dir lock, and an rIC wait can
            // stall up to its 1 s timeout per yield under interaction — starving
            // a concurrent flush's sidecar append. ~ms-bounded cost instead.
            if (++sinceYield >= 8) { sinceYield = 0; await cheapYield(); }
            let content: string;
            try {
                content = await this.app.vault.cachedRead(f);
            } catch (e) {
                // read error (e.g. an iCloud file not yet downloaded) → snapshot incomplete →
                // unsafe to delete. Logged with the path: this is the likeliest cause of a
                // persistent 'incomplete-rechunk' skip, so it must not be silent.
                complete = false;
                await this.logger.appendError(`collectLiveIds-read:${f.path}`, e);
                continue;
            }
            let chunks = this.chunksFor(content, f.path, new Date(f.stat.mtime).toISOString());
            if (chunks.length === 0) continue; // genuinely empty note — no ids, not a skip
            try {
                chunks = (await enforceTokenBudget(chunks, ts => this.embedder.tokenCounts(ts))).chunks;
            } catch (e) {
                complete = false; // tokenizer hiccup → incomplete
                await this.logger.appendError(`collectLiveIds-tokenBudget:${f.path}`, e);
                continue;
            }
            for (const c of chunks) ids.add(c.chunk_id);
        }
        return { ids, complete };
    }

    // Compact THIS device's own sidecar (jsonl + shards) if it has accumulated enough
    // dead bytes. Model-FREE — a pure byte-copy of existing vectors, peak ~8 MB (one
    // source + one dest shard) — so, unlike a full reindex, it is safe on mobile (no
    // GPU/model heap → no jetsam). It is also the ONLY reclaim path for a
    // device that never reaches a desktop: a version-bump reindex and hydrate-from-a-
    // compacted-peer both need connectivity an off-grid phone/iPad may lack for months,
    // and its own edit churn would otherwise pile up unbounded. Called at most once per
    // session from periodicReconcile. Returns null when the sidecar is off.
    async compactOwnSidecar(): Promise<CompactResult | null> {
        if (!this.coord.sidecarOn()) return null;
        const adapter = this.app.vault.adapter;
        const dir = this.coord.dir!;
        const dev = this.logger.deviceId;

        // A SIDECAR_FORMAT bump is deliberately excluded from identityMatches (it
        // governs only the cross-device file protocol, not local IDB validity — see
        // identity.ts), so this device can carry a stale-format sidecar on disk
        // indefinitely: nothing forces a full reindex (the only path that clears it
        // via clearDevice) just because the format constant moved. compactDevice()
        // decodes every record with the CURRENT fixed stride unconditionally — run
        // against a genuinely stale-format shard, every record misaligns, fails its
        // CRC, and gets shed as "corrupt", permanently destroying this device's
        // pre-upgrade vector history (and leaving a peer's later hydration attempt
        // to hit the same misread). Detect the mismatch from this device's own last-
        // written meta BEFORE compacting and, instead of misreading, explicitly wipe
        // via the same primitive a full reindex uses — the sidecar self-heals from
        // normal incremental commits afterward, same as any other reap.
        const ownMeta = await readDeviceMeta(adapter, dir, dev);
        if (staleSidecarFormat(ownMeta)) {
            // Census the shards BEFORE wiping, and leave the same once-per-session
            // sidecar-compact breadcrumb as a normal compaction: this path makes
            // the largest disk-state change compaction can make (every shard on
            // the device deleted), and a forensics trace showing shard counts drop
            // to zero between sessions must record which path did it.
            const preWipe = await listDeviceShards(adapter, dir, dev);
            const bytesBefore = preWipe.reduce((sum, s) => sum + s.size, 0);
            await clearDevice(adapter, dir, dev, { preserveSeqFloor: true });
            this.forensics?.beat('sidecar-compact', {
                reason: 'format-mismatch', shardsBefore: preWipe.length, shardsAfter: 0,
                bytesBefore, bytesAfter: 0,
            });
            return { compacted: false, reason: 'format-mismatch', recordsBefore: 0, recordsAfter: 0, bytesBefore, bytesAfter: 0, shed: 0, shardsBefore: preWipe.length, shardsAfter: 0 };
        }

        // Off-grid means no iCloud re-upload now (it lands as a SMALLER upload on
        // reconnect), but the rewrite still costs IO — so a higher floor on mobile.
        const floor = isMobilePlatform() ? 4 * 1024 * 1024 : 2 * 1024 * 1024;
        // NOTE: no stat-only pre-gate here on purpose. deviceShardBytes(...) < floor would
        // sum ALL on-disk shard bytes, including crash-leaked orphans (shards referenced by
        // zero jsonl lines — see compactDevice's header comment), and skip calling
        // compactDevice entirely for any device whose live+orphan total stays under the
        // floor. compactDevice's own orphan reclaim runs BEFORE its internal below-floor
        // check (on live bytes only), so it must always be reachable — a caller-side
        // pre-gate on the unfiltered total would make a small, quiet device's leaked
        // shards unreclaimable forever. compactDevice is cheap to call here regardless:
        // this path runs at most once per session (see main.ts), and its own below-floor
        // check bails before the expensive live-id re-chunk.
        // The live-id oracle runs INSIDE compactDevice's dir lock so the snapshot and the
        // on-disk scan exclude concurrent appends — the drop decision needs no clock.
        const result = await compactDevice(adapter, dir, dev, () => this.collectLiveIds(), { minDeadRatio: 0.5, minShardBytes: floor });
        // Once-per-session shard-census beat: the field channel for watching
        // append-only flush proliferation (1A). shardsBefore trending high while
        // reason stays below-floor/below-ratio = tighten the compaction trigger.
        this.forensics?.beat('sidecar-compact', {
            reason: result.reason ?? 'none', shardsBefore: result.shardsBefore, shardsAfter: result.shardsAfter,
            bytesBefore: result.bytesBefore, bytesAfter: result.bytesAfter,
        });
        // Refresh the persisted reconcile sig after a self jsonl rewrite. With self now
        // excluded from sidecarDirSignature (a device's own writes don't move its own
        // signature), this compaction touches only our own jsonl so the signature is
        // already unchanged — this re-persist is belt-and-suspenders, kept so the
        // persisted sig is recomputed with the SAME selfDeviceId convention as the live
        // gate, and to stay correct if compaction ever touches a non-self artifact.
        if (result.compacted) {
            try {
                this.persistReconcileSig(await sidecarDirSignature(adapter, dir, dev));
            } catch (e) {
                await this.logger.appendError('compact-sig-refresh', e);
            }
        }
        return result;
    }

    // Oracle-free shard-count hygiene for the append-only sidecar (1A): fold
    // accumulated per-flush small shards into dense ones once enough pile up.
    // Byte-copy only — no vault re-chunk, no model — so unlike compactOwnSidecar
    // it is safe to call every reconcile poll; below the count gate it costs one
    // directory listing. SKIPS (never wipes) a stale-format sidecar: records must
    // be decoded with the stride they were written under, and the format-mismatch
    // wipe is compactOwnSidecar's job — running once per session, it always gets
    // its chance before shard count matters.
    async coalesceOwnSidecar(): Promise<CoalesceResult | null> {
        if (!this.coord.sidecarOn()) return null;
        const adapter = this.app.vault.adapter;
        const dir = this.coord.dir!;
        const dev = this.logger.deviceId;
        if (staleSidecarFormat(await readDeviceMeta(adapter, dir, dev))) return null;
        const result = await coalesceSmallShards(adapter, dir, dev);
        if (result.coalesced) {
            // Census beat only when a fold actually ran — the every-poll below-count
            // no-op would otherwise flood the forensics ring.
            this.forensics?.beat('sidecar-coalesce', {
                smallShards: result.smallShards, shardsBefore: result.shardsBefore, shardsAfter: result.shardsAfter,
                bytesMoved: result.bytesMoved, shed: result.shed, skippedLines: result.skippedLines,
            });
            // Same belt-and-suspenders sig refresh as compactOwnSidecar: self is
            // excluded from sidecarDirSignature, so this should be a no-op — kept so
            // the persisted sig always reflects the same convention as the live gate.
            try {
                this.persistReconcileSig(await sidecarDirSignature(adapter, dir, dev));
            } catch (e) {
                await this.logger.appendError('coalesce-sig-refresh', e);
            }
        }
        return result;
    }

    // Devices already warned about a version-gate refusal this session, keyed by
    // `${device}:${reason}` so each distinct staleness is reported once — not on
    // every reconcile / delta flush.
    private warnedRefusals = new Set<string>();

    // True when the last sidecar scan refused a producer at a HIGHER chunkerVersion than
    // this build — another device holds a newer index this plugin is too old to read.
    // Set/cleared per scan (so updating Seek clears it on the next reconcile). The plugin
    // reads it to raise the "update Seek" banner AND, on mobile, to skip the futile local
    // re-embed (a v7 device grinding out chunks it discards the moment it updates to v8).
    private _peerAhead = false;
    get peerAhead(): boolean { return this._peerAhead; }

    // A version-gate refusal is EXPECTED and self-healing — e.g. right after a
    // CHUNKER_VERSION bump the other device's sidecar is one version behind until
    // it re-embeds. So it's a one-time warn (no stack trace, not an `error` entry):
    // the old appendError fired two red console lines + an error log on every
    // reconcile, flooding the console for a benign, transient state. Refusing the
    // producer is correct (a stale chunk_id space can't be reproduced locally) —
    // only the loudness was the bug.
    private warnRefusedProducer(dev: string, meta: SidecarMeta | null, expect: MetaExpectation): void {
        const reason = !meta
            ? 'missing/unreadable meta'
            : [
                  meta.format !== SIDECAR_FORMAT ? `format ${meta.format}≠${SIDECAR_FORMAT}` : '',
                  meta.modelId !== expect.modelId ? `model ${meta.modelId}≠${expect.modelId}` : '',
                  meta.chunkerVersion !== expect.chunkerVersion ? `chunker v${meta.chunkerVersion}≠v${expect.chunkerVersion}` : '',
                  meta.dim !== expect.dim ? `dim ${meta.dim}≠${expect.dim}` : '',
              ]
                  .filter(Boolean)
                  .join(', ');
        const key = `${dev}:${reason}`;
        if (this.warnedRefusals.has(key)) return;
        this.warnedRefusals.add(key);
        console.warn(`[seek] skipping sidecar producer ${dev} (${reason}) — its index predates this device; will hydrate once that device re-embeds`);
        // One NDJSON breadcrumb (not an error entry) so device reports still show a
        // producer was paused. Reuses SidecarHydrateEntry's open index signature.
        void this.logger.append({ type: 'sidecar-hydrate', timestamp: new Date().toISOString(), phase: 'version-gate-refused', device: dev, reason }).catch(() => {});
    }

    // Set once we've warned this session that the index is empty AND the sidecar
    // restored nothing — cleared again the moment a hydrate repopulates the index,
    // so a later strand still warns. Keeps onload + first periodic + manual
    // reconcile from each re-logging the same dead-net state.
    private warnedStranded = false;

    // The failure the sidecar exists to PREVENT: sidecar is on, yet after a
    // hydrate the IDB index is still empty → the next search returns ZERO results
    // with no error. Causes: iOS evicted the IDB and no producer has synced in, or
    // the index dir was deleted / never reached this device (the config-folder
    // split). This used to be silent — only a `producerFilesFound:0` debug line.
    // Surface it as a real console error ONCE, gated on a true-empty index (cheap
    // IDB count) so a healthy warm index never trips it. Cause is read off the
    // hydrate result so the message is actionable.
    private async warnIfIndexStranded(result: HydrateResult): Promise<void> {
        if (this.warnedStranded) return;
        const { chunks } = await this.store.count();
        if (chunks > 0) return; // index is populated — search works, nothing stranded
        this.warnedStranded = true;
        const cause =
            result.refusedProducers > 0
                ? `all ${result.refusedProducers} sidecar producer(s) were version-refused — the other device's plugin/model is out of date`
                : result.skippedPartialNotes > 0
                  ? `sidecar files are still arriving (${result.skippedPartialNotes} note(s) only partially synced)`
                  : result.acceptedProducers === 0
                    ? 'no sidecar index files were found here — deleted, or no other device has synced its index to this folder yet'
                    : 'the sidecar held nothing this device could reproduce';
        console.error(
            `[seek] index is EMPTY and the sidecar restored nothing — search will return no results. ` +
                `Cause: ${cause}. Fix: run a full reindex on this device, or let another device's sidecar sync in.`,
        );
        // Persist to NDJSON too — console.error is invisible on mobile (no
        // devtools), and mobile is exactly where eviction strands the index.
        void this.logger
            .append({
                type: 'sidecar-hydrate',
                timestamp: new Date().toISOString(),
                phase: 'index-stranded',
                cause,
                refusedProducers: result.refusedProducers,
                acceptedProducers: result.acceptedProducers,
                skippedPartialNotes: result.skippedPartialNotes,
            })
            .catch(() => {});
    }

    // Shared HydrateDeps; only the re-chunk source varies (whole vault vs the
    // dirty subset for delta dedup).
    // addsSink (Seek scaling A1): when present, putQuantized ALSO surfaces each
    // hydrated chunk into the delta change-set, so a sidecar-dedup delta can be
    // applied incrementally (applyDelta) instead of forcing a full rebuild. Only
    // the delta path (dedupViaSidecar) passes it; the standalone hydrateSidecar
    // does its own invalidate+warm, so it leaves it undefined.
    private hydrateDeps(reChunk: () => Promise<ReChunkedNote[]>, addsSink?: DeltaAdd[]): HydrateDeps {
        return {
            adapter: this.app.vault.adapter,
            indexDir: this.coord.dir!,
            expect: expectationFor(),
            reChunk,
            existingIds: async () => new Set((await this.store.listAllMeta()).map(c => c.chunk_id)),
            putQuantized: async (chunks, tiers) => {
                await this.store.putBatchQuantized(chunks, tiers);
                // After the IDB write, so the sink holds only rows that landed.
                if (addsSink) pushDeltaAdds(addsSink, chunks, tiers);
            },
            putFileRecord: rec => this.store.putFileRecord(rec),
            onRefusedProducer: (dev, meta, expect) => this.warnRefusedProducer(dev, meta, expect),
            log: (msg, detail) => {
                // Persist to the NDJSON log too — console.log is invisible on
                // mobile (no devtools), which is why hydrate outcomes never
                // surfaced in iPhone reports. Flatten arrays → counts to fit the
                // SidecarHydrateEntry scalar index signature (hydratedNotePaths
                // can be large).
                const flat: Record<string, string | number | boolean | null> = {};
                if (detail && typeof detail === 'object') {
                    for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
                        if (Array.isArray(v)) flat[`${k}Count`] = v.length;
                        else if (v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') flat[k] = v ?? null;
                        else flat[k] = String(v);
                    }
                }
                void this.logger.append({ type: 'sidecar-hydrate', timestamp: new Date().toISOString(), phase: msg, ...flat }).catch(() => {});
            },
        };
    }

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
    private async dedupViaSidecar(
        files: TFile[],
        addsSink?: DeltaAdd[],
        removedSink?: string[],
        removedBodiesSink?: Map<string, string>,
        metaPatchSink?: Array<{ id: string; meta: ChunkMeta }>,
    ): Promise<TFile[]> {
        if (!this.coord.sidecarOn() || files.length === 0) return files;
        // Same chunk_id-reproduction requirement as reChunkLive: apply the
        // token-budget split so split notes match the sidecar (without it this
        // dedup silently missed every long note and re-embedded it). The model
        // is loaded on this path (reindexDelta's embed half), so ensureTokenizer
        // is a no-op; the guard just makes the dependency explicit.
        await this.embedder.ensureTokenizer();
        const notes: ReChunkedNote[] = [];
        for (const f of files) {
            let content: string;
            try {
                content = await this.app.vault.cachedRead(f);
            } catch {
                continue;
            }
            let chunks = this.chunksFor(content, f.path, new Date(f.stat.mtime).toISOString());
            if (chunks.length === 0) continue;
            try {
                chunks = (await enforceTokenBudget(chunks, ts => this.embedder.tokenCounts(ts))).chunks;
            } catch (e) {
                await this.logger.appendError(`dedupViaSidecar-tokenBudget:${f.path}`, e);
                continue;
            }
            if (chunks.length > 0) notes.push({ notePath: f.path, mtimeMs: f.stat.mtime, chunks, contentHash: cyrb53Hex(content) });
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
            const rec = await this.store.getFileRecord(n.notePath).catch(() => null);
            if (!rec) continue;
            oldRecs.set(n.notePath, rec);
            const newIdSet = new Set(n.chunks.map(c => c.chunk_id));
            const stableIds = rec.chunk_ids.filter(id => newIdSet.has(id));
            if (stableIds.length > 0) {
                try {
                    for (const [id, m] of await this.store.getChunkMetasByIds(stableIds)) oldStableMetas.set(id, m);
                } catch { /* classification degrades to nothing; the engine path heals on the next edit */ }
            }
        }
        const res = await hydrateFromSidecar(this.hydrateDeps(async () => notes, addsSink));
        this._peerAhead = res.peerAhead; // refresh the "newer index exists" signal per scan
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
                        for (const [id, body] of await this.store.getBodiesMap(stale)) removedBodiesSink.set(id, body);
                    }
                    await this.store.deleteChunksByIds(stale);
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
                await this.logger.appendError(`sidecarDedup-stale-cleanup:${p}`, e);
            }
        }
        return files.filter(f => !done.has(f.path));
    }

    // F13 carry-over: harvest the rerank/sign tiers of every chunk about to be
    // removed, keyed by EMBED TEXT (title\n\ncontent — path-independent). A move
    // re-keys identical content under a new path-salted chunk_id, so its vector is
    // unchanged; harvesting lets the embed phase reuse it verbatim. Reads the
    // affected files' stored chunks by id BEFORE they're deleted; merges into `map`
    // so the deleted-path and dirty-path harvests share one table.
    private async harvestCarryOverInto(
        map: Map<string, { q: QuantVec; sign: Uint8Array }>,
        paths: string[],
    ): Promise<void> {
        const seen = new Set<string>();
        for (const path of paths) {
            if (seen.has(path)) continue;
            seen.add(path);
            try {
                const rec = await this.store.getFileRecord(path);
                if (!rec || rec.chunk_ids.length === 0) continue;
                const tiers = await this.store.getTiersByIds(rec.chunk_ids);
                for (const t of tiers) {
                    if (t) map.set(embedInput(t.chunk), { q: t.q, sign: t.sign });
                }
            } catch (e) {
                // Carry-over is a pure optimization (reuse the identical vector on a
                // move / no-op re-flush). A harvest failure must NEVER abort the
                // delta — that would drop this edit from the index entirely. Record
                // it (forensics ring + per-device log) and fall through: this file
                // simply re-embeds normally.
                await this.logger.appendError(`carryOver-harvest:${path}`, e);
            }
        }
    }

    // F13: re-chunk each candidate and, if EVERY chunk's embed text is in the
    // carry-over map, write the chunks with their REUSED tiers (verbatim, no model
    // forward pass) and drop the file from the embed set. All-or-nothing per note,
    // mirroring dedupViaSidecar: a partially-changed file falls through to a normal
    // embed. The headline win is a folder reorg (pure moves) re-keying for free.
    private async carryOverHydrate(
        files: TFile[],
        carryOver: Map<string, { q: QuantVec; sign: Uint8Array }>,
    ): Promise<TFile[]> {
        if (carryOver.size === 0 || files.length === 0) return files;
        // The model-loaded embed path already has the tokenizer; the guard just
        // makes the chunk_id-reproduction dependency explicit (as in dedupViaSidecar).
        await this.embedder.ensureTokenizer();
        const done = new Set<string>();
        for (const f of files) {
            let content: string;
            try { content = await this.app.vault.cachedRead(f); } catch { continue; }
            let chunks = this.chunksFor(content, f.path, new Date(f.stat.mtime).toISOString());
            if (chunks.length === 0) continue;
            try {
                chunks = (await enforceTokenBudget(chunks, ts => this.embedder.tokenCounts(ts))).chunks;
            } catch (e) {
                await this.logger.appendError(`carryOver-tokenBudget:${f.path}`, e);
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
            const oldRec = await this.store.getFileRecord(f.path).catch(() => null);
            // One atomic tx for chunks + record (S1), same as commitFile.
            try {
                await this.store.putBatchQuantized(chunks, tiers.map(t => ({ q: t!.q, bin: t!.sign })),
                    { note_path: f.path, mtimeMs: f.stat.mtime, chunk_ids: chunks.map(c => c.chunk_id), contentHash: cyrb53Hex(content) });
            } catch (e) {
                // A commit failure (quota, closing store) must not abort the whole
                // delta burst. Leave the file OUT of `done`: it falls through to
                // the normal embed path, whose per-file catch classifies quota
                // (S2) and keeps the file dirty for catch-up.
                await this.logger.appendError(`carryOver-commit:${f.path}`, e);
                continue;
            }
            if (oldRec) {
                const newIdSet = new Set(chunks.map(c => c.chunk_id));
                const stale = oldRec.chunk_ids.filter(id => !newIdSet.has(id));
                if (stale.length > 0) {
                    await this.store.deleteChunksByIds(stale)
                        .catch(e => this.logger.appendError(`carryOver-stale-cleanup:${f.path}`, e));
                }
            }
            done.add(f.path);
        }
        return files.filter(f => !done.has(f.path));
    }

    private async emitProgress(
        phase: IndexProgressEntry['phase'],
        filesSeen: number,
        filesTotal: number,
        chunksEmitted: number,
        elapsedMs: number,
    ): Promise<void> {
        // index-progress is a high-volume per-batch firehose that's ALSO mirrored into
        // the crash-forensics breadcrumb ring (the copy that survives a jetsam kill — the
        // one that matters for crash classification). Persist it to the NDJSON only under
        // verboseTrace; index-complete still records the per-run summary unconditionally.
        if (!this.settings.verboseTrace) return;
        // Storage probe runs alongside heap so iOS gets a non-null signal too.
        const mem = await snapshotMemory();
        const entry: IndexProgressEntry = {
            type: 'index-progress',
            timestamp: new Date().toISOString(),
            phase,
            filesSeen,
            filesTotal,
            chunksEmitted,
            elapsedMs: parseFloat(elapsedMs.toFixed(2)),
            heapMB: mem.heapMB,
            storageMB: mem.storageMB,
        };
        await this.logger.append(entry);
    }

    // Resolve the per-search FilterContext from live app + settings: the set of
    // Number-typed properties (read from Obsidian's registry each search — a cheap
    // dictionary lookup) and the date field the recency-gated `before:`/`after:`
    // filters key off. dateField is null when Recency is OFF (recencyEpsilon ≤ 0),
    // which is how the parser knows to leave a typed before:/after: as plain text.
    // override (see search()) resolves the effective epsilon locally so a
    // query-time override never has to touch this.settings to take effect here.
    // See [[Seek Typed-Value Filters Design]].
    private buildFilterContext(override?: SearchOverride): FilterContext {
        const epsilon = override?.epsilon ?? this.settings.recencyEpsilon;
        const recencyOn = epsilon > 0;
        return {
            dateField: recencyOn
                ? { key: this.settings.recencyKey, createdProp: this.settings.createdProp }
                : null,
            numericKeys: enumerateNumberPropertyNames(this.app),
        };
    }

    // Query pipeline lives in core/engine.ts (shared with the MCP server); this class only supplies the plugin-side ports.
    async search(query: string, topK = 10, override?: SearchOverride, expOverride?: ExperimentOverride): Promise<{ results: ScoredChunk[]; entry: SearchEntry }> {
        return runSearch(this.searchHost(), query, topK, override, expOverride);
    }

    private searchHost(): SearchHost {
        const o = this;
        return {
            get settings() { return o.settings; },
            filterCtx: ov => o.buildFilterContext(ov),
            frame: async () => {
                // Sampled BEFORE ensureFrame: a miss rebuilds it, and the telemetry wants the pre-call state.
                const wasCached = !!(o.frameCache && o.frameCache.generation === o.coord.generation);
                return { frame: await o.ensureFrame(), wasCached };
            },
            bodies: ids => o.store.getBodiesByIds(ids),
            bodiesMap: ids => o.store.getBodiesMap(ids),
            embeddings: ids => o.store.getEmbeddingsByIds(ids),
            embed: t => o.embedder.embed(t),
            binaryCandidates: (gen, q, packed, n, bpv, cap, mask) =>
                binaryCandidatesAsync(o.binaryWorker, gen, q, packed, n, bpv, cap, mask),
            prepareBm25: async chunks => {
                // Guarded so a WARM keystroke skips the await/IDB entirely; the cross-device fallback only runs when the local blob is absent.
                if (!o.bm25CacheValid(chunks)) {
                    await o.tryLoadPersistedBm25(chunks);
                    if (!o.bm25CacheValid(chunks)) await o.tryLoadCrossDeviceBm25(chunks);
                }
                return o.ensureBm25(chunks);
            },
            bm25: () => o.bm25Cache,
            bm25Boosts: () => o.bm25FieldBoosts(),
            synonyms: () => o.synonymCache,
            phraseCache: () => o.ensurePhraseCache(),
            onCoherenceDrift: w => o.onCoherenceDrift(w),
            bgStats: () => o.getDenseBgStats(),
            log: e => o.logger.append(e),
            logError: (t, err) => o.logger.appendError(t, err),
        };
    }

    // fork 1.1.3 new; relates to src/search.ts:3827-4472 (ensureBinaryIndex..invalidateBm25Cache). Cache layer lives in core/resident-index.ts; these proxies keep orchestrator callers and tests unchanged.
    private res!: ResidentIndex;
    private residentPorts(): ResidentPorts {
        const o = this;
        return {
            store: o.store,
            coord: o.coord,
            get settings() { return o.settings; },
            get mobile() { return isMobilePlatform(); },
            int8Resident: residentInt8Enabled,
            yield: cheapYield,
            embedderLoaded: () => o.embedder.loaded,
            disposed: () => o.disposed,
            // fork 1.1.3 new; relates to src/search.ts:4143 SearchOrchestrator.tryLoadCrossDeviceBm25 (the producer-walk half; the stamp/load half is ResidentIndex.tryLoadCrossDevice)
            peerOn: () => o.coord.sidecarOn() && gzipAvailable() && !!o.coord.dir,
            peerBm25: async accept => {
                if (!o.coord.sidecarOn() || !gzipAvailable()) return null;
                const dir = o.coord.dir;
                if (!dir) return null;
                const adapter = o.app.vault.adapter;
                const devs = await rankAcceptedProducers(adapter, dir, expectationFor());
                // Freshest first; a producer without a loadable .gz (mobile writes none) just falls through to the next.
                for (const dev of devs) {
                    try {
                        const bytes = await adapter.readBinary(bm25PathFor(dir, dev)).catch(() => null);
                        if (!bytes) continue;
                        const rec = JSON.parse(await gunzipToString(bytes)) as { json?: unknown; stamp?: unknown };
                        if (typeof rec.json !== 'string' || !accept(rec)) continue;
                        return { json: rec.json };
                    } catch (e) {
                        console.warn(`[seek] cross-device BM25 load from ${dev} failed, trying next`, e);
                    }
                }
                return null;
            },
            // fork 1.1.3 new; relates to src/search.ts:4202 SearchOrchestrator.emitCrossDeviceBm25 (gzip + atomic write half)
            get publishBm25() {
                const dir = o.coord.dir;
                if (!o.coord.sidecarOn() || isMobilePlatform() || !gzipAvailable() || !dir) return null;
                return async (payload: string) => {
                    const gz = await gzipString(payload);
                    // writeBinary doesn't create parents; the first emit can precede any shard write.
                    await ensureDir(o.app.vault.adapter, dir);
                    await writeBytesAtomic(o.app.vault.adapter, bm25PathFor(dir, o.logger.deviceId), gz);
                };
            },
            mineLinkPairs: () => mineLinkPairsByPath(o.app, p => shouldIndexPath(o.app, o.settings, p)),
            get span() { return o.taskCtx ?? undefined; },
            beat: (t, d) => o.forensics?.beat(t, d as Parameters<NonNullable<typeof o.forensics>["beat"]>[1]),
            get idle() {
                // Hidden windows have no frames to jank, and rIC would only fire there via its timeout.
                if (typeof activeDocument === 'undefined' || activeDocument.hidden || typeof requestIdleCallback !== 'function') return null;
                return (fn: () => void) => { const id = requestIdleCallback(() => fn(), { timeout: 5000 }); return () => cancelIdleCallback(id); };
            },
            logError: (c, e) => o.logger.appendError(c, e),
            now: () => performance.now(),
        };
    }

    private get frameCache() { return this.res.frame; }
    private set frameCache(v) { this.res.frame = v; }
    private get bm25Cache() { return this.res.bm25; }
    private set bm25Cache(v) { this.res.bm25 = v; }
    private get bm25CacheGeneration() { return this.res.bm25Gen; }
    private get bm25CacheProps() { return this.res.bm25Props; }
    private get bm25CacheHeadings() { return this.res.bm25Headings; }
    private get synonymCache() { return this.res.synonyms; }
    private set synonymCache(v) { this.res.synonyms = v; }
    private get linkPairCache() { return this.res.linkPairs; }
    private set bgStatsGen(v: number) { this.res.bgGen = v; }

    private ensureFrame() { return this.res.ensureFrame(); }
    private ensureBm25(c: ChunkMeta[]) { return this.res.ensureBm25(c); }
    private bm25CacheValid(c: ChunkMeta[]) { return this.res.bm25Valid(c); }
    private ensurePhraseCache() { return this.res.ensurePhrases(); }
    private bm25FieldBoosts() { return this.res.boosts(); }
    private getDenseBgStats() { return this.res.denseBg(); }
    private tryLoadPersistedBm25(c: ChunkMeta[]) { return this.res.tryLoadPersisted(c); }
    private tryLoadCrossDeviceBm25(c: ChunkMeta[]) { return this.res.tryLoadCrossDevice(c); }
    private maybePersistResidentBm25() { this.res.maybePersistResident(); }
    warmCaches(trigger: string): Promise<void> { return this.res.warm(trigger); }
    // Name kept for main.ts: it drops every generation-keyed cache, not just BM25.
    invalidateBm25Cache(): void { this.res.invalidate(); }
}
