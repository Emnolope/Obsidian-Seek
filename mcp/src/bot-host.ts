// fork 1.1.3 new; relates to src/search.ts:121 SearchOrchestrator
// The bot's host: Node twin of SearchOrchestrator. Same method names, same ctx shapes; core does the work behind ports.
// Differences are the BASE layer only (node:fs vault, NodeIndexStore, BotEmbedder, no Obsidian UI/metadataCache).
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileAdapter } from '../../core/file-adapter.ts';
import { IndexCoordinator } from '../../core/index-coordinator.ts';
import { ResidentIndex, type ResidentPorts } from '../../core/resident-index.ts';
import { MarkdownChunker } from '../../core/chunker.ts';
import { chunksFor as chunksForCore, computeDelta, shouldIndexPath as shouldIndexPathCore, UnreadableQuarantine, type LiveFile } from '../../core/delta.ts';
import { planFileDiff } from '../../core/file-diff.ts';
import { embedAndCommit, type EmbedCommitCtx, type SidecarFlushJob } from '../../core/embed-commit.ts';
import { applyDelta as applyDeltaCore } from '../../core/apply-delta.ts';
import { reconcileIdentityInPlace } from '../../core/reconcile.ts';
import { dedupViaSidecar as dedupViaSidecarCore, carryOverHydrate as carryOverHydrateCore } from '../../core/hydrate-before-embed.ts';
import {
  harvestCarryOverInto as harvestCarryOverIntoCore, reconcileGhostDirt as reconcileGhostDirtCore, deltaFallback as deltaFallbackCore,
  emitProgress as emitProgressCore,
} from '../../core/delta-tail.ts';
import { sweepOrphanChunks as sweepOrphanChunksCore } from '../../core/orphan-sweep.ts';
import { reChunkLive as reChunkLiveCore, collectLiveIds as collectLiveIdsCore, type LiveOracleCtx } from '../../core/live-oracle.ts';
import { reindexAll as reindexAllCore } from '../../core/reindex-all.ts';
import { reindexDelta as reindexDeltaCore } from '../../core/reindex-delta.ts';
import {
  peerSidecarPresent as peerSidecarPresentCore, reapDeadIdentitySidecars as reapDeadIdentitySidecarsCore, reconcileSigKey as reconcileSigKeyCore,
  loadPersistedReconcileSig as loadPersistedReconcileSigCore, persistReconcileSig as persistReconcileSigCore, indexIsEmpty as indexIsEmptyCore,
  compactOwnSidecar as compactOwnSidecarCore, coalesceOwnSidecar as coalesceOwnSidecarCore, type SidecarOpsCtx,
} from '../../core/sidecar-ops.ts';
import {
  hydrateSidecar as hydrateSidecarCore, rebuildFromSidecar as rebuildFromSidecarCore, reconcileSidecarIfChanged as reconcileSidecarIfChangedCore,
  hydrateDeps as hydrateDepsCore, type SidecarSyncCtx,
} from '../../core/sidecar-hydrate.ts';
import { flushSidecarAfterPass as flushSidecarAfterPassCore, runSidecarFlush as runSidecarFlushCore } from '../../core/sidecar-flush.ts';
import {
  ensureDir, listSidecarDeviceIds, clearDevice, listDeviceShards, compactDevice, coalesceSmallShards, sidecarDirSignature,
  staleSidecarFormat, shouldReconcileSidecar, bulkAppend,
} from '../../core/sidecar.ts';
import { readDeviceMeta, writeDeviceMeta, metaAccepts, expectationFor } from '../../core/sidecar-meta.ts';
import { hydrateFromSidecar, rankAcceptedProducers, probePeerAhead } from '../../core/sidecar-sync.ts';
import type { ReChunkedNote, HydrateResult, HydrateDeps } from '../../core/sidecar-types.ts';
import { pluginIdentity, identityHealEligibility } from '../../core/identity.ts';
import { selectIndexBucket } from '../../core/child-script.ts';
import { SIDECAR_FORMAT } from '../../core/contract.ts';
import { ACTIVE_MODEL_SPEC } from '../../core/model-registry.ts';
import type { Chunk, ChunkMeta, SeekSettings } from '../../core/types.ts';
import type { QuantVec } from '../../core/quant.ts';
import type { IndexCompleteEntry, IndexProgressEntry, MemorySnapshot } from '../../core/types.ts';
import type { BotEmbedder } from './bot-embedder.ts';
import type { NodeIndexStore } from './node-index-store.ts';
import { botLogger, vaultFiles, readVaultFile } from './base.ts';

const MODEL_ID = ACTIVE_MODEL_SPEC.repo;
const EMBEDDING_DIM = ACTIVE_MODEL_SPEC.dim;
const DB_VERSION_BOT = 0; // no IndexedDB schema here; the sidecar gate ignores dbVersion by design
const PLUGIN_VERSION = 'mcp';
const INT8_RESIDENT_MAX_BYTES = 16 * 1024 * 1024;
const cheapYield = (): Promise<void> => new Promise(r => setTimeout(r, 0));

type Logger = ReturnType<typeof botLogger>;
type DeltaAdd = import('../../core/search-helpers.ts').DeltaAdd;

export interface BotHostInit {
  vaultDir: string;
  vault: FileAdapter;       // the vault, for the sidecar dir and logs
  stateDir: string;         // the MCP's own app-state dir (localStorage stand-in lives here)
  store: NodeIndexStore;
  embedder: BotEmbedder;
  logger: Logger;
  settings: SeekSettings;
}

// mtime is a live getter: a pass records the mtime as of the moment it READS the file.
const withLiveMtime = (files: LiveFile<string>[]): LiveFile<string>[] => files;

export class BotHost {
  private vaultDir: string;
  private vault: FileAdapter;
  private stateDir: string;
  private store: NodeIndexStore;
  private embedder: BotEmbedder;
  private logger: Logger;
  private settings: SeekSettings;
  private forensics = null;
  private chunker = new MarkdownChunker();
  private coord: IndexCoordinator;
  private disposed = false;
  private unreadable = new UnreadableQuarantine();
  private res: ResidentIndex;
  private readonly deltaFallbackCounts = new Map<string, number>();
  private lastDeltaFallbackReason: string | null = null;
  private sidecarFlushChain: Promise<void> = Promise.resolve();
  private sidecarFlushesInFlight = 0;
  private lastReconcileSig: string | null = null;
  private warnedRefusals = new Set<string>();
  private _peerAhead = false;
  private warnedStranded = false;
  private local = new Map<string, string>();

  constructor(init: BotHostInit) {
    this.vaultDir = init.vaultDir; this.vault = init.vault; this.stateDir = init.stateDir; this.store = init.store;
    this.embedder = init.embedder; this.logger = init.logger; this.settings = init.settings;
    this.coord = new IndexCoordinator('.obsidian/plugins/seek/index', init.settings);
    this.res = new ResidentIndex(this.residentPorts());
  }

  dispose(): void { this.disposed = true; this.res.dispose(); }
  currentGeneration(): number { return this.coord.generation; }
  get peerAhead(): boolean { return this._peerAhead; }
  isWriting(): boolean { return this.coord.isWriting() || this.sidecarFlushesInFlight > 0; }

  // ── BASE: what Obsidian's vault/app object gives the plugin ──
  private indexableFiles(): Promise<LiveFile<string>[]> { return vaultFiles(this.vaultDir, { indexBases: false }); }
  private readFile(f: LiveFile<string>): Promise<string> { return readVaultFile(this.vaultDir)(f); }
  private shouldIndex(path: string): boolean { return shouldIndexPathCore(this.settings, path, () => false); }
  private chunksFor(content: string, path: string, modifiedIso: string | null): Chunk[] {
    return chunksForCore(this.chunker, () => { throw new Error('.base files are not indexed by the bot yet'); }, content, path, modifiedIso);
  }
  // The bot's per-vault key/value store: a JSON file in its own state dir (sync API, like localStorage).
  private localFile(): string { return join(this.stateDir, 'local-storage.json'); }
  private loadLocalStorage(k: string): unknown {
    if (this.local.size === 0) { try { for (const [a, b] of Object.entries(JSON.parse(readFileSync(this.localFile(), 'utf8')))) this.local.set(a, String(b)); } catch { /* none yet */ } }
    const v = this.local.get(k);
    return v === undefined ? null : v;
  }
  private saveLocalStorage(k: string, v: string): void {
    this.loadLocalStorage(k);
    this.local.set(k, v);
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(this.localFile(), JSON.stringify(Object.fromEntries(this.local)));
  }
  private quotaToast(): void { console.warn('[seek] device storage is full — some notes could not be indexed'); }
  private quarantineUnreadable(path: string): void {
    if (this.unreadable.add(path)) console.warn(`[seek] quarantining persistently unreadable file (will retry on backoff / next full reindex): ${path}`);
  }

  // fork 1.1.3 src/search.ts:344 SearchOrchestrator.reindexAll
  async reindexAll(onProgress?: (msg: string) => void, opts: { shouldContinue?: () => boolean; isPaused?: () => boolean } = {}): Promise<IndexCompleteEntry> {
    const o = this;
    const files = await this.indexableFiles();
    return reindexAllCore<string>({
      coord: o.coord, store: o.storeForReset(), embedder: o.embedder, logger: o.logger, forensics: o.forensics, unreadable: o.unreadable,
      EMBEDDING_DIM, nukeDatabase: async () => { const n = await o.store.clear(); return { chunks: n.chunks, embeddings: n.embeddings, files: n.files }; },
      indexableFiles: () => withLiveMtime(files), shouldIndex: p => o.shouldIndex(p),
      emitProgress: (...a) => o.emitProgress(...a),
      embedAndCommitFiles: (fs, ...rest) => o.embedAndCommitFiles(fs, ...rest),
      invalidateBm25Cache: () => o.invalidateBm25Cache(), flushSidecarAfterPass: j => o.flushSidecarAfterPass(j),
      exportMcpAfterSuccessfulCommit: async () => {}, quotaToast: () => o.quotaToast(), warmCaches: t => o.warmCaches(t),
    }, onProgress, opts);
  }

  // The reset path closes and reopens the store; the in-memory twin has nothing to release, so open/close are cheap no-ops.
  private storeForReset() { return this.store; }

  // fork 1.1.3 src/search.ts:578 SearchOrchestrator.embedAndCommitFiles
  private async embedAndCommitFiles(
    files: LiveFile<string>[], mode: 'full' | 'incremental', onProgress: ((msg: string) => void) | undefined, overallStart: number,
    memBefore: MemorySnapshot,
    budget: Parameters<typeof embedAndCommit<string>>[6] = {},
  ) {
    return embedAndCommit<string>(this.embedCommitCtx(), files, mode, onProgress, overallStart, memBefore, budget);
  }

  private embedCommitCtx(): EmbedCommitCtx<string> {
    const o = this;
    return {
      store: o.store, embedder: o.embedder, logger: o.logger, forensics: o.forensics, coord: o.coord,
      get disposed() { return o.disposed; },
      pluginVersion: PLUGIN_VERSION,
      read: f => o.readFile(f),
      chunksFor: (content, path, modifiedIso) => o.chunksFor(content, path, modifiedIso),
      newPacer: () => ({ pace: cheapYield }),
      selectBucket: n => selectIndexBucket(n),
      identity: () => pluginIdentity(DB_VERSION_BOT),
      clearSidecarDevice: () => clearDevice(o.vault, o.coord.dir!, o.logger.deviceId, { preserveSeqFloor: true }),
      reapDeadIdentitySidecars: () => o.reapDeadIdentitySidecars(),
      quarantineUnreadable: p => o.quarantineUnreadable(p),
      quotaToast: () => o.quotaToast(),
      invalidateBm25Cache: () => o.invalidateBm25Cache(),
      emitProgress: (phase, a, b, c, d) => o.emitProgress(phase as IndexProgressEntry['phase'], a, b, c, d),
    };
  }

  // fork 1.1.3 src/search.ts:1520 SearchOrchestrator.computeDelta
  async computeDelta(): Promise<{ dirty: string[]; deleted: string[] }> {
    await this.refreshFiles();
    return computeDelta<string>({
      records: () => this.store.listFileRecords(),
      liveFiles: () => this.cachedFiles.filter(f => this.shouldIndex(f.path)),
      read: f => this.readFile(f),
      quarantine: this.unreadable,
      onQuarantined: path => console.warn(`[seek] quarantining persistently unreadable file (will retry on backoff / next full reindex): ${path}`),
      pluginVersion: PLUGIN_VERSION,
    });
  }

  // fork 1.1.3 src/search.ts:1661 SearchOrchestrator.reconcileIdentityInPlace
  async reconcileIdentityInPlace(): Promise<'stale' | 'stamped' | 'drained'> {
    const o = this;
    return reconcileIdentityInPlace({
      store: o.store, coord: o.coord, computeDelta: () => o.computeDelta(), reindexDelta: (d, x, opts) => o.reindexDelta(d, x, opts),
      mobile: false, embedderLoaded: () => o.embedder.loaded, healEligibility: m => identityHealEligibility(m),
      identity: () => pluginIdentity(DB_VERSION_BOT), EMBEDDING_DIM, MODEL_ID,
      resetBgStats: () => { o.res.bgStatsGen = -1; }, invalidateBm25Cache: () => o.invalidateBm25Cache(),
    });
  }

  // fork 1.1.3 src/search.ts:1740 SearchOrchestrator.reindexDelta
  async reindexDelta(
    dirtyPaths: string[], deletedPaths: string[],
    opts: { embed: boolean; maxFiles?: number; budgetMs?: number; shouldContinue?: () => boolean; onProgress?: (msg: string) => void },
  ) {
    const o = this;
    return reindexDeltaCore<string>({
      coord: o.coord, store: o.store, embedder: o.embedder, logger: o.logger,
      get frameCache() { return o.res.frameCache; }, get bm25Cache() { return o.res.bm25Cache; },
      get lastDeltaFallbackReason() { return o.lastDeltaFallbackReason; }, set lastDeltaFallbackReason(v) { o.lastDeltaFallbackReason = v; },
      EMBEDDING_DIM, identity: () => pluginIdentity(DB_VERSION_BOT), shouldIndex: p => o.shouldIndex(p),
      getAbstractFileByPath: p => o.liveFile(p),
      harvestCarryOverInto: (map, paths) => o.harvestCarryOverInto(map, paths),
      carryOverHydrate: (fs, c) => o.carryOverHydrate(fs, c),
      dedupViaSidecar: (fs, ...rest) => o.dedupViaSidecar(fs, ...rest),
      embedAndCommitFiles: (fs, ...rest) => o.embedAndCommitFiles(fs, ...rest),
      applyDelta: (...a) => o.applyDelta(...a), invalidateBm25Cache: () => o.invalidateBm25Cache(),
      flushSidecarAfterPass: j => o.flushSidecarAfterPass(j), exportMcpAfterSuccessfulCommit: async () => {},
      warmCaches: t => o.warmCaches(t), reconcileGhostDirt: () => o.reconcileGhostDirt(), maybePersistResidentBm25: () => {},
    }, dirtyPaths, deletedPaths, opts);
  }

  // Synchronous lookup the delta needs per path; the lister already carries mtime, so stat directly.
  private liveFile(path: string): LiveFile<string> | null {
    try {
      const mtime = statSync(join(this.vaultDir, path)).mtimeMs;
      return { path, mtime, handle: path };
    } catch { return null; }
  }

  private reconcileGhostDirt(): boolean {
    return reconcileGhostDirtCore({ bm25Cache: this.res.bm25Cache, forensics: this.forensics, invalidateBm25Cache: () => this.invalidateBm25Cache(), warmCaches: r => this.warmCaches(r) });
  }

  // fork 1.1.3 src/search.ts:2111 SearchOrchestrator.diffFileAgainstStore
  private async diffFileAgainstStore(path: string, fileChunks: Chunk[], budget: Parameters<typeof planFileDiff>[3]) {
    return planFileDiff(this.store, path, fileChunks, budget);
  }

  // fork 1.1.3 src/search.ts:2201 SearchOrchestrator.applyDelta
  private async applyDelta(adds: DeltaAdd[], removedIds: string[], removedBodies: ReadonlyMap<string, string>, metaPatches: ReadonlyArray<{ id: string; meta: ChunkMeta }> = []): Promise<boolean> {
    return applyDeltaCore({
      frame: this.res.frameCache, bm: this.res.bm25Cache, settings: this.settings,
      bm25Generation: this.res.bm25CacheGeneration, bm25Props: this.res.bm25CacheProps, bm25Headings: this.res.bm25CacheHeadings,
      generation: () => this.coord.generation, bumpGeneration: () => this.coord.bumpGeneration(),
      stamp: n => this.res.stampBm25Cache(n),
      setSynonyms: m => { this.res.synonymCache = m; },
      // No link dictionary on the bot: it mines Obsidian's metadataCache, which has no Node twin.
      patchLinkPairs: () => {},
      fallback: (reason, detail) => this.deltaFallback(reason, detail),
      logError: (tag, e) => this.logger.appendError(tag, e),
    }, adds, removedIds, removedBodies, metaPatches);
  }

  // fork 1.1.3 src/search.ts:2360 SearchOrchestrator.deltaFallback
  private deltaFallback(reason: string, detail?: Record<string, unknown>): false {
    return deltaFallbackCore({ deltaFallbackCounts: this.deltaFallbackCounts, setLastReason: r => { this.lastDeltaFallbackReason = r; }, forensics: this.forensics }, reason, detail);
  }

  async hydrateSidecar(): Promise<HydrateResult | null> { await this.refreshFiles(); return hydrateSidecarCore(this.sidecarSyncCtx()); }
  async rebuildFromSidecar(): Promise<HydrateResult | null> { await this.refreshFiles(); return rebuildFromSidecarCore(this.sidecarSyncCtx()); }
  async reconcileSidecarIfChanged(): Promise<HydrateResult | null> { await this.refreshFiles(); return reconcileSidecarIfChangedCore(this.sidecarSyncCtx()); }
  async peerSidecarPresent(): Promise<boolean> { return peerSidecarPresentCore(this.sidecarOpsCtx()); }
  async compactOwnSidecar() { await this.refreshFiles(); return compactOwnSidecarCore(this.sidecarOpsCtx()); }
  async coalesceOwnSidecar() { return coalesceOwnSidecarCore(this.sidecarOpsCtx()); }
  private async reapDeadIdentitySidecars(): Promise<number> { return reapDeadIdentitySidecarsCore(this.sidecarOpsCtx()); }
  private reconcileSigKey(): string { return reconcileSigKeyCore(this.sidecarOpsCtx()); }
  private loadPersistedReconcileSig(): string | null { return loadPersistedReconcileSigCore(this.sidecarOpsCtx()); }
  private persistReconcileSig(sig: string): void { persistReconcileSigCore(this.sidecarOpsCtx(), sig); }
  private async indexIsEmpty(): Promise<boolean> { return indexIsEmptyCore(this.sidecarOpsCtx()); }

  async sweepOrphanChunks(opts: { shouldContinue?: () => boolean } = {}) {
    const o = this;
    return sweepOrphanChunksCore({ coord: o.coord, store: o.store, invalidateBm25Cache: () => o.invalidateBm25Cache(), warmCaches: t => o.warmCaches(t) }, opts);
  }

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
      adapter: o.vault, coord: o.coord, logger: o.logger,
      ensureDir, readDeviceMeta, staleSidecarFormat, clearDevice, writeDeviceMeta, bulkAppend, expectationFor,
    }, job);
  }

  private sidecarSyncCtx(): SidecarSyncCtx<FileAdapter> {
    const o = this;
    return {
      ...o.sidecarOpsCtx(),
      coord: o.coord, logger: o.logger, store: o.store,
      get lastReconcileSig() { return o.lastReconcileSig; }, set lastReconcileSig(v) { o.lastReconcileSig = v; },
      get _peerAhead() { return o._peerAhead; }, set _peerAhead(v) { o._peerAhead = v; },
      warnedRefusals: o.warnedRefusals,
      get warnedStranded() { return o.warnedStranded; }, set warnedStranded(v) { o.warnedStranded = v; },
      get bgStatsGen() { return o.res.bgStatsGen; }, set bgStatsGen(v) { o.res.bgStatsGen = v; },
      MODEL_ID, EMBEDDING_DIM, SIDECAR_FORMAT, pluginIdentity: () => pluginIdentity(DB_VERSION_BOT), reChunkLive: () => o.reChunkLive(),
      hydrateFromSidecar, rankAcceptedProducers, probePeerAhead, shouldReconcileSidecar, nukeDatabase: () => o.store.clear(),
      invalidateBm25Cache: () => o.invalidateBm25Cache(), warmCaches: t => o.warmCaches(t),
    };
  }

  private sidecarOpsCtx(): SidecarOpsCtx<FileAdapter> {
    const o = this;
    return {
      adapter: o.vault, coord: o.coord, logger: o.logger, forensics: o.forensics, store: o.store,
      get lastReconcileSig() { return o.lastReconcileSig; }, set lastReconcileSig(v) { o.lastReconcileSig = v; },
      loadLocalStorage: k => o.loadLocalStorage(k), saveLocalStorage: (k, v) => o.saveLocalStorage(k, v),
      isMobilePlatform: () => false, collectLiveIds: () => o.collectLiveIds(),
      listSidecarDeviceIds, readDeviceMeta, clearDevice, metaAccepts, expectationFor: () => expectationFor(pluginIdentity(DB_VERSION_BOT)), staleSidecarFormat: m => staleSidecarFormat(m),
      listDeviceShards, compactDevice, coalesceSmallShards, sidecarDirSignature,
    };
  }

  private async reChunkLive(): Promise<ReChunkedNote[]> { return reChunkLiveCore(this.liveOracleCtx()); }
  private async collectLiveIds(): Promise<{ ids: Set<string>; complete: boolean }> { return collectLiveIdsCore(this.liveOracleCtx()); }

  private liveOracleCtx(): LiveOracleCtx<string> {
    const o = this;
    return {
      embedder: o.embedder, logger: o.logger,
      indexableFiles: () => withLiveMtime(o.cachedFiles), shouldIndex: p => o.shouldIndex(p), cheapYield,
      read: f => o.readFile(f),
      chunksFor: (content, path, modifiedIso) => o.chunksFor(content, path, modifiedIso),
    };
  }
  // The oracles take a synchronous lister; refresh it before any oracle-driven pass.
  private cachedFiles: LiveFile<string>[] = [];
  async refreshFiles(): Promise<void> { this.cachedFiles = await this.indexableFiles(); }

  private hydrateDeps(reChunk: () => Promise<ReChunkedNote[]>, addsSink?: DeltaAdd[]): HydrateDeps<FileAdapter> {
    return hydrateDepsCore(this.sidecarSyncCtx(), reChunk, addsSink);
  }

  private async dedupViaSidecar(
    files: LiveFile<string>[], addsSink?: DeltaAdd[], removedSink?: string[], removedBodiesSink?: Map<string, string>, metaPatchSink?: Array<{ id: string; meta: ChunkMeta }>,
  ): Promise<LiveFile<string>[]> {
    const o = this;
    return dedupViaSidecarCore<string>({
      embedder: o.embedder, logger: o.logger, store: o.store, coord: o.coord,
      read: f => o.readFile(f),
      chunksFor: (content, path, modifiedIso) => o.chunksFor(content, path, modifiedIso),
      hydrate: (notes, adds) => hydrateFromSidecar(o.hydrateDeps(async () => notes, adds)),
      get _peerAhead() { return o._peerAhead; }, set _peerAhead(v) { o._peerAhead = v; },
    }, files, addsSink, removedSink, removedBodiesSink, metaPatchSink);
  }

  private async harvestCarryOverInto(map: Map<string, { q: QuantVec; sign: Uint8Array }>, paths: string[]): Promise<void> {
    return harvestCarryOverIntoCore({ store: this.store, logger: this.logger }, map, paths);
  }

  private async carryOverHydrate(files: LiveFile<string>[], carryOver: Map<string, { q: QuantVec; sign: Uint8Array }>): Promise<LiveFile<string>[]> {
    const o = this;
    return carryOverHydrateCore<string>({
      embedder: o.embedder, logger: o.logger, store: o.store,
      read: f => o.readFile(f),
      chunksFor: (content, path, modifiedIso) => o.chunksFor(content, path, modifiedIso),
    }, files, carryOver);
  }

  private async emitProgress(phase: IndexProgressEntry['phase'], filesSeen: number, filesTotal: number, chunksEmitted: number, elapsedMs: number): Promise<void> {
    return emitProgressCore({ settings: this.settings, logger: this.logger }, phase, filesSeen, filesTotal, chunksEmitted, elapsedMs);
  }

  // fork 1.1.3 new; relates to src/search.ts:4472 SearchOrchestrator.invalidateBm25Cache
  private residentPorts(): ResidentPorts {
    const o = this;
    return {
      store: o.store, coord: o.coord,
      get settings() { return o.settings; },
      mobile: false,
      int8Resident: (n, bits) => n * (bits + 8) <= INT8_RESIDENT_MAX_BYTES,
      yield: cheapYield,
      embedderLoaded: () => o.embedder.loaded,
      disposed: () => o.disposed,
      peerOn: () => false,
      peerBm25: async () => null,
      publishBm25: null,
      mineLinkPairs: () => new Map(),
      logError: (c, e) => o.logger.appendError(c, e),
      now: () => performance.now(),
    };
  }
  warmCaches(trigger: string): Promise<void> { return this.res.warmCaches(trigger); }
  invalidateBm25Cache(): void { this.res.invalidateBm25Cache(); }
}
