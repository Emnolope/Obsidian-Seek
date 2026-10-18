// SearchOrchestrator — owns the chunk-vault → embed → store → search loop.
//
// reindexAll() is intentionally the simple "nuke and rebuild" path: drop the
// IndexedDB database, walk all markdown files, chunk → embed → write. Larger
// vaults will want incremental, but the design doc explicitly defers that;
// the user asked for a "total nuke and reset" full reindex as one of the
// three v0 commands.

import type { App, DataAdapter } from 'obsidian';
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
import { reconcileIdentityInPlace } from '../core/reconcile';
import { dedupViaSidecar as dedupViaSidecarCore, carryOverHydrate as carryOverHydrateCore } from '../core/hydrate-before-embed';
import { harvestCarryOverInto as harvestCarryOverIntoCore, reconcileGhostDirt as reconcileGhostDirtCore, deltaFallback as deltaFallbackCore, exportMcpAfterSuccessfulCommit as exportMcpAfterSuccessfulCommitCore, emitProgress as emitProgressCore } from '../core/delta-tail';
import { sweepOrphanChunks as sweepOrphanChunksCore } from '../core/orphan-sweep';
import { reChunkLive as reChunkLiveCore, collectLiveIds as collectLiveIdsCore, type LiveOracleCtx } from '../core/live-oracle';
import { reindexAll as reindexAllCore } from '../core/reindex-all';
import { reindexDelta as reindexDeltaCore } from '../core/reindex-delta';
import {
    peerSidecarPresent as peerSidecarPresentCore, reapDeadIdentitySidecars as reapDeadIdentitySidecarsCore, reconcileSigKey as reconcileSigKeyCore,
    loadPersistedReconcileSig as loadPersistedReconcileSigCore, persistReconcileSig as persistReconcileSigCore, indexIsEmpty as indexIsEmptyCore,
    compactOwnSidecar as compactOwnSidecarCore, coalesceOwnSidecar as coalesceOwnSidecarCore, type SidecarOpsCtx,
} from '../core/sidecar-ops';
import {
    hydrateSidecar as hydrateSidecarCore, rebuildFromSidecar as rebuildFromSidecarCore, reconcileSidecarIfChanged as reconcileSidecarIfChangedCore,
    warnRefusedProducer as warnRefusedProducerCore, warnIfIndexStranded as warnIfIndexStrandedCore, hydrateDeps as hydrateDepsCore, type SidecarSyncCtx,
} from '../core/sidecar-hydrate';
import { flushSidecarAfterPass as flushSidecarAfterPassCore, runSidecarFlush as runSidecarFlushCore } from '../core/sidecar-flush';
import { shouldIndexPath as shouldIndexPathCore, chunksFor as chunksForCore, computeDelta, UnreadableQuarantine } from '../core/delta';
import { ResidentIndex, type ResidentPorts } from '../core/resident-index';
import { runSearch, type SearchHost, type SearchOverride, type ExperimentOverride } from '../core/engine';
import { alignCandidate, buildResidentRerankBlock, chunkMetaEqual, pushDeltaAdds, freshDeltaAdds, appendFrameRows, tombstoneFrameRows, buildSelectionMask, COMPACTION_TOMBSTONE_FRACTION, COHERENCE_SAMPLES, COHERENCE_DRIFT_COOLDOWN_MS, coherenceDriftDecision, shouldDiscardPartialFrame, driftRecoveryDecision, frameBm25Coherent, buildBm25Stamp, bm25StampMatches, dedupByPath, topKByScore, snippetPlainText, makeSnippet, type ResidentFrame, type DeltaAdd, type DriftRecoveryState, type RowSpaceProbe, type Bm25PersistStamp } from '../core/search-helpers';

// mtime is a live getter: a pass records the mtime as of the moment it READS the file.
const liveOf = (files: TFile[]) => files.map(f => ({ path: f.path, get mtime() { return f.stat.mtime; }, handle: f }));
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

    private async exportMcpAfterSuccessfulCommit(mode: 'full' | 'incremental'): Promise<void> {
        return exportMcpAfterSuccessfulCommitCore({ exportMcpIndex: () => exportMcpIndex(this.app.vault.adapter, this.store), forensics: this.forensics, logger: this.logger }, mode);
    }

    async reindexAll(onProgress?: (msg: string) => void, opts: { shouldContinue?: () => boolean; isPaused?: () => boolean } = {}): Promise<IndexCompleteEntry> {
        const o = this;
        return reindexAllCore<TFile>({
            coord: o.coord, store: o.store, embedder: o.embedder, logger: o.logger, forensics: o.forensics, unreadable: o.unreadable,
            EMBEDDING_DIM, nukeDatabase, indexableFiles: () => liveOf(o.indexableFiles()), shouldIndex: p => o.shouldIndex(p),
            emitProgress: (...a) => o.emitProgress(...a),
            embedAndCommitFiles: (fs, ...rest) => o.embedAndCommitFiles(fs.map(f => f.handle), ...rest),
            invalidateBm25Cache: () => o.invalidateBm25Cache(), flushSidecarAfterPass: j => o.flushSidecarAfterPass(j),
            exportMcpAfterSuccessfulCommit: mode => o.exportMcpAfterSuccessfulCommit(mode), quotaToast: () => o.quotaToast(), warmCaches: t => o.warmCaches(t),
        }, onProgress, opts);
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
        const o = this;
        return flushSidecarAfterPassCore({
            get sidecarFlushChain() { return o.sidecarFlushChain; }, set sidecarFlushChain(v) { o.sidecarFlushChain = v; },
            get sidecarFlushesInFlight() { return o.sidecarFlushesInFlight; }, set sidecarFlushesInFlight(v) { o.sidecarFlushesInFlight = v; },
            runSidecarFlush: j => o.runSidecarFlush(j),
        }, job);
    }

    private async runSidecarFlush(job: SidecarFlushJob): Promise<void> {
        const o = this;
        return runSidecarFlushCore({
            get disposed() { return o.disposed; },
            adapter: o.app.vault.adapter, coord: o.coord, logger: o.logger,
            ensureDir, readDeviceMeta, staleSidecarFormat, clearDevice, writeDeviceMeta, bulkAppend, expectationFor,
        }, job);
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

    async reconcileIdentityInPlace(): Promise<'stale' | 'stamped' | 'drained'> {
        const o = this;
        return reconcileIdentityInPlace({
            store: o.store,
            coord: o.coord,
            computeDelta: () => o.computeDelta(),
            reindexDelta: (d, x, opts) => o.reindexDelta(d, x, opts),
            mobile: isMobilePlatform(),
            embedderLoaded: () => o.embedder.loaded,
            healEligibility: m => identityHealEligibility(m),
            identity: () => pluginIdentity(),
            EMBEDDING_DIM,
            MODEL_ID,
            resetBgStats: () => { o.bgStatsGen = -1; },
            invalidateBm25Cache: () => o.invalidateBm25Cache(),
        });
    }

    async reindexDelta(
        dirtyPaths: string[],
        deletedPaths: string[],
        opts: { embed: boolean; maxFiles?: number; budgetMs?: number; shouldContinue?: () => boolean; onProgress?: (msg: string) => void },
    ): Promise<{ deletedPaths: number; deletedChunks: number; embedded: IndexCompleteEntry | null; deferredEmbed: number; sidecarHydrated: number; carriedOver: number; committedPaths: string[] }> {
        const o = this;
        return reindexDeltaCore<TFile>({
            coord: o.coord, store: o.store, embedder: o.embedder, logger: o.logger,
            get frameCache() { return o.frameCache; }, get bm25Cache() { return o.bm25Cache; },
            get lastDeltaFallbackReason() { return o.lastDeltaFallbackReason; }, set lastDeltaFallbackReason(v) { o.lastDeltaFallbackReason = v; },
            EMBEDDING_DIM, identity: () => pluginIdentity(), shouldIndex: p => o.shouldIndex(p),
            getAbstractFileByPath: p => { const f = o.app.vault.getAbstractFileByPath(p); return f instanceof TFile ? liveOf([f])[0] : null; },
            harvestCarryOverInto: (map, paths) => o.harvestCarryOverInto(map, paths),
            carryOverHydrate: async (fs, c) => liveOf(await o.carryOverHydrate(fs.map(f => f.handle), c)),
            dedupViaSidecar: async (fs, ...rest) => liveOf(await o.dedupViaSidecar(fs.map(f => f.handle), ...rest)),
            embedAndCommitFiles: (fs, ...rest) => o.embedAndCommitFiles(fs.map(f => f.handle), ...rest),
            applyDelta: (...a) => o.applyDelta(...a), invalidateBm25Cache: () => o.invalidateBm25Cache(),
            flushSidecarAfterPass: j => o.flushSidecarAfterPass(j), exportMcpAfterSuccessfulCommit: mode => o.exportMcpAfterSuccessfulCommit(mode),
            warmCaches: t => o.warmCaches(t), reconcileGhostDirt: () => o.reconcileGhostDirt(), maybePersistResidentBm25: () => o.maybePersistResidentBm25(),
        }, dirtyPaths, deletedPaths, opts);
    }

    private reconcileGhostDirt(): boolean {
        return reconcileGhostDirtCore({ bm25Cache: this.bm25Cache, forensics: this.forensics, invalidateBm25Cache: () => this.invalidateBm25Cache(), warmCaches: r => this.warmCaches(r) });
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
            stamp: n => this.res.stampBm25Cache(n),
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

    // The most recent decline's slug, for the delta-apply entry (v16) — the
    // per-reason counts above ride heartbeats, but wlo2's reports showed those
    // don't surface the REASON of a specific pass's fallback.
    private lastDeltaFallbackReason: string | null = null;
    private deltaFallback(reason: string, detail?: Record<string, unknown>): false {
        return deltaFallbackCore({ deltaFallbackCounts: this.deltaFallbackCounts, setLastReason: r => { this.lastDeltaFallbackReason = r; }, forensics: this.forensics }, reason, detail);
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

    async hydrateSidecar(): Promise<HydrateResult | null> {
        return hydrateSidecarCore(this.sidecarSyncCtx());
    }

    async rebuildFromSidecar(): Promise<HydrateResult | null> {
        return rebuildFromSidecarCore(this.sidecarSyncCtx());
    }

    async peerSidecarPresent(): Promise<boolean> {
        return peerSidecarPresentCore(this.sidecarOpsCtx());
    }

    async sweepOrphanChunks(opts: { shouldContinue?: () => boolean } = {}): Promise<{ removed: number; completed: boolean }> {
        const o = this;
        return sweepOrphanChunksCore({ coord: o.coord, store: o.store, invalidateBm25Cache: () => o.invalidateBm25Cache(), warmCaches: t => o.warmCaches(t) }, opts);
    }

    private async reapDeadIdentitySidecars(): Promise<number> {
        return reapDeadIdentitySidecarsCore(this.sidecarOpsCtx());
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

    private sidecarSyncCtx(): SidecarSyncCtx<DataAdapter> {
        const o = this;
        return {
            ...o.sidecarOpsCtx(),
            coord: o.coord, logger: o.logger, store: o.store,
            get lastReconcileSig() { return o.lastReconcileSig; }, set lastReconcileSig(v) { o.lastReconcileSig = v; },
            get _peerAhead() { return o._peerAhead; }, set _peerAhead(v) { o._peerAhead = v; },
            warnedRefusals: o.warnedRefusals,
            get warnedStranded() { return o.warnedStranded; }, set warnedStranded(v) { o.warnedStranded = v; },
            get bgStatsGen() { return o.bgStatsGen; }, set bgStatsGen(v) { o.bgStatsGen = v; },
            MODEL_ID, EMBEDDING_DIM, SIDECAR_FORMAT, pluginIdentity: () => pluginIdentity(), reChunkLive: () => o.reChunkLive(),
            hydrateFromSidecar, rankAcceptedProducers, probePeerAhead, shouldReconcileSidecar, nukeDatabase,
            invalidateBm25Cache: () => o.invalidateBm25Cache(), warmCaches: t => o.warmCaches(t),
        };
    }

    private sidecarOpsCtx(): SidecarOpsCtx<DataAdapter> {
        const o = this;
        return {
            adapter: o.app.vault.adapter, coord: o.coord, logger: o.logger, forensics: o.forensics, store: o.store,
            get lastReconcileSig() { return o.lastReconcileSig; }, set lastReconcileSig(v) { o.lastReconcileSig = v; },
            loadLocalStorage: k => o.app.loadLocalStorage(k), saveLocalStorage: (k, v) => o.app.saveLocalStorage(k, v),
            isMobilePlatform, collectLiveIds: () => o.collectLiveIds(),
            listSidecarDeviceIds, readDeviceMeta, clearDevice, metaAccepts, expectationFor: () => expectationFor(), staleSidecarFormat: m => staleSidecarFormat(m),
            listDeviceShards, compactDevice, coalesceSmallShards, sidecarDirSignature,
        };
    }

    private reconcileSigKey(): string {
        return reconcileSigKeyCore(this.sidecarOpsCtx());
    }

    private loadPersistedReconcileSig(): string | null {
        return loadPersistedReconcileSigCore(this.sidecarOpsCtx());
    }

    private persistReconcileSig(sig: string): void {
        persistReconcileSigCore(this.sidecarOpsCtx(), sig);
    }

    private async indexIsEmpty(): Promise<boolean> {
        return indexIsEmptyCore(this.sidecarOpsCtx());
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

    async reconcileSidecarIfChanged(): Promise<HydrateResult | null> {
        return reconcileSidecarIfChangedCore(this.sidecarSyncCtx());
    }

    private async reChunkLive(): Promise<ReChunkedNote[]> {
        return reChunkLiveCore(this.liveOracleCtx());
    }

    private async collectLiveIds(): Promise<{ ids: Set<string>; complete: boolean }> {
        return collectLiveIdsCore(this.liveOracleCtx());
    }

    private liveOracleCtx(): LiveOracleCtx<TFile> {
        const o = this;
        return {
            embedder: o.embedder, logger: o.logger,
            indexableFiles: () => liveOf(o.indexableFiles()), shouldIndex: p => o.shouldIndex(p), cheapYield,
            read: f => o.app.vault.cachedRead(f.handle),
            chunksFor: (content, path, modifiedIso) => o.chunksFor(content, path, modifiedIso),
        };
    }

    async compactOwnSidecar(): Promise<CompactResult | null> {
        return compactOwnSidecarCore(this.sidecarOpsCtx());
    }

    async coalesceOwnSidecar(): Promise<CoalesceResult | null> {
        return coalesceOwnSidecarCore(this.sidecarOpsCtx());
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

    private warnRefusedProducer(dev: string, meta: SidecarMeta | null, expect: MetaExpectation): void {
        warnRefusedProducerCore(this.sidecarSyncCtx(), dev, meta, expect);
    }

    // Set once we've warned this session that the index is empty AND the sidecar
    // restored nothing — cleared again the moment a hydrate repopulates the index,
    // so a later strand still warns. Keeps onload + first periodic + manual
    // reconcile from each re-logging the same dead-net state.
    private warnedStranded = false;

    private async warnIfIndexStranded(result: HydrateResult): Promise<void> {
        return warnIfIndexStrandedCore(this.sidecarSyncCtx(), result);
    }

    private hydrateDeps(reChunk: () => Promise<ReChunkedNote[]>, addsSink?: DeltaAdd[]): HydrateDeps {
        return hydrateDepsCore(this.sidecarSyncCtx(), reChunk, addsSink);
    }

    private async dedupViaSidecar(
        files: TFile[],
        addsSink?: DeltaAdd[],
        removedSink?: string[],
        removedBodiesSink?: Map<string, string>,
        metaPatchSink?: Array<{ id: string; meta: ChunkMeta }>,
    ): Promise<TFile[]> {
        const o = this;
        const left = await dedupViaSidecarCore<TFile>({
            embedder: o.embedder, logger: o.logger, store: o.store, coord: o.coord,
            read: f => o.app.vault.cachedRead(f.handle),
            chunksFor: (content, path, modifiedIso) => o.chunksFor(content, path, modifiedIso),
            hydrate: (notes, adds) => hydrateFromSidecar(o.hydrateDeps(async () => notes, adds)),
            get _peerAhead() { return o._peerAhead; }, set _peerAhead(v) { o._peerAhead = v; },
        }, liveOf(files), addsSink, removedSink, removedBodiesSink, metaPatchSink);
        return left.map(f => f.handle);
    }

    private async harvestCarryOverInto(
        map: Map<string, { q: QuantVec; sign: Uint8Array }>,
        paths: string[],
    ): Promise<void> {
        return harvestCarryOverIntoCore({ store: this.store, logger: this.logger }, map, paths);
    }

    private async carryOverHydrate(
        files: TFile[],
        carryOver: Map<string, { q: QuantVec; sign: Uint8Array }>,
    ): Promise<TFile[]> {
        const o = this;
        const left = await carryOverHydrateCore<TFile>({
            embedder: o.embedder, logger: o.logger, store: o.store,
            read: f => o.app.vault.cachedRead(f.handle),
            chunksFor: (content, path, modifiedIso) => o.chunksFor(content, path, modifiedIso),
        }, liveOf(files), carryOver);
        return left.map(f => f.handle);
    }

    private async emitProgress(
        phase: IndexProgressEntry['phase'],
        filesSeen: number,
        filesTotal: number,
        chunksEmitted: number,
        elapsedMs: number,
    ): Promise<void> {
        return emitProgressCore({ settings: this.settings, logger: this.logger }, phase, filesSeen, filesTotal, chunksEmitted, elapsedMs);
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

    private get frameCache() { return this.res.frameCache; }
    private set frameCache(v) { this.res.frameCache = v; }
    private get bm25Cache() { return this.res.bm25Cache; }
    private set bm25Cache(v) { this.res.bm25Cache = v; }
    private get bm25CacheGeneration() { return this.res.bm25CacheGeneration; }
    private get bm25CacheProps() { return this.res.bm25CacheProps; }
    private get bm25CacheHeadings() { return this.res.bm25CacheHeadings; }
    private get synonymCache() { return this.res.synonymCache; }
    private set synonymCache(v) { this.res.synonymCache = v; }
    private get linkPairCache() { return this.res.linkPairCache; }
    private set bgStatsGen(v: number) { this.res.bgStatsGen = v; }

    private ensureFrame() { return this.res.ensureFrame(); }
    private ensureBm25(c: ChunkMeta[]) { return this.res.ensureBm25(c); }
    private bm25CacheValid(c: ChunkMeta[]) { return this.res.bm25CacheValid(c); }
    private ensurePhraseCache() { return this.res.ensurePhraseCache(); }
    private bm25FieldBoosts() { return this.res.bm25FieldBoosts(); }
    private getDenseBgStats() { return this.res.getDenseBgStats(); }
    private tryLoadPersistedBm25(c: ChunkMeta[]) { return this.res.tryLoadPersistedBm25(c); }
    private tryLoadCrossDeviceBm25(c: ChunkMeta[]) { return this.res.tryLoadCrossDeviceBm25(c); }
    private maybePersistResidentBm25() { this.res.maybePersistResidentBm25(); }
    warmCaches(trigger: string): Promise<void> { return this.res.warmCaches(trigger); }
    // Name kept for main.ts: it drops every generation-keyed cache, not just BM25.
    invalidateBm25Cache(): void { this.res.invalidateBm25Cache(); }
}
