// Resident caches (frame, binary index, BM25, synonyms, warm/persist), lifted out of SearchOrchestrator so any host can own them.
// Provenance: each member carries a `fork` pointer to its upstream method (see PROVENANCE.md). Names are unchanged except cancelIdle (was pendingPersistIdle, an rIC id; now a cancel fn so the host owns idle scheduling).
// Bodies are unchanged except port substitution. Deviations: cross-device BM25 producer loop moved to the host (ResidentPorts.peerBm25);
// gzip+write moved to ResidentPorts.publishBm25. WHY one class: all of it keys on one generation counter.

import type { ChunkMeta, SeekSettings } from './types.ts';
import { MultiFieldBM25, DEFAULT_FIELD_BOOSTS } from './bm25.ts';
import { buildSynonymMap, buildPhraseMap, type SynonymMap, type PhraseSynonymMap } from './synonyms.ts';
import { aggregateLinkPairs, type LinkPairCount } from './link-dict.ts';
import { concatPacked } from './binary.ts';
import type { QuantVec } from './quant.ts';
import {
    buildResidentRerankBlock, shouldDiscardPartialFrame, buildBm25Stamp, bm25StampMatches,
    type ResidentFrame,
} from './search-helpers.ts';

export interface ResidentStore {
    listAllMeta(): Promise<ChunkMeta[]>;
    listAllBinary(): Promise<{ ids: string[]; packed: Uint8Array[] }>;
    listAllEmbeddings(): Promise<{ ids: string[]; vecs: QuantVec[] }>;
    getBodiesMap(ids: string[]): Promise<Map<string, string>>;
    getBm25(): Promise<{ json: string; stamp: unknown } | null>;
    putBm25(json: string, stamp: Bm25Stamp): Promise<void>;
    getMeta(): Promise<{ lastIndexedAt?: string | null; bgMean?: number | null; bgStd?: number | null } & Parameters<typeof buildBm25Stamp>[0]>;
}
type Bm25Stamp = ReturnType<typeof buildBm25Stamp>;

export interface ResidentPorts {
    store: ResidentStore;
    coord: { readonly generation: number; readonly currentDelta: Promise<unknown> | null; bumpGeneration(): void };
    settings: SeekSettings;
    // Runtime differences live here, not in the class: mobile gating, idle scheduling, yielding.
    mobile: boolean;
    int8Resident(n: number, bits: number): boolean;
    yield(): Promise<void>;
    embedderLoaded(): boolean;
    disposed(): boolean;
    // False when there is no sidecar to read; checked first so such devices skip the meta read.
    peerOn(): boolean;
    // Cross-device BM25: the adapter walks producers freshest-first and returns the first blob `accept` takes.
    peerBm25(accept: (rec: { json?: unknown; stamp?: unknown }) => boolean): Promise<{ json: string } | null>;
    // null when this runtime must not publish (mobile, no sidecar, no gzip).
    publishBm25: ((payload: string) => Promise<void>) | null;
    mineLinkPairs(): Map<string, LinkPairCount[]>;
    span?: { push(k: string): void; pop(k: string): void };
    beat?(type: string, detail?: Record<string, unknown>): void;
    idle?: ((fn: () => void) => () => void) | null;
    logError?(ctx: string, e: unknown): Promise<void>;
    now(): number;
}

export const BM25_PERSIST_THROTTLE_MS = 30_000;

export class ResidentIndex {
    frameCache: ResidentFrame | null = null;
    bm25Cache: MultiFieldBM25 | null = null;
    bm25CacheGeneration = -1;
    bm25CacheChunkCount = -1;
    bm25CacheProps = false;
    bm25CacheHeadings = false;
    synonymCache: SynonymMap | null = null;
    phraseCache: PhraseSynonymMap | null = null;
    linkPairCache: Map<string, LinkPairCount[]> | null = null;
    binaryIndex: { ids: string[]; packed: Uint8Array; bytesPerVec: number; generation: number } | null = null;
    bgStatsCache: { mean: number; std: number } | null = null;
    bgStatsGen = -1;
    warming = false;
    lastBm25PersistMs = Number.NEGATIVE_INFINITY;
    cancelIdle: (() => void) | null = null;
    private p: ResidentPorts;

    constructor(ports: ResidentPorts) { this.p = ports; }

    dispose(): void {
        if (this.cancelIdle) { this.cancelIdle(); this.cancelIdle = null; }
    }

    // fork 1.1.3 src/search.ts:3886 SearchOrchestrator.getDenseBgStats
    async getDenseBgStats(): Promise<{ mean: number; std: number } | null> {
        const p = this.p;
        if (this.bgStatsGen === p.coord.generation) return this.bgStatsCache;
        const m = await p.store.getMeta();
        this.bgStatsCache = (m.bgMean != null && m.bgStd != null && m.bgStd > 0) ? { mean: m.bgMean, std: m.bgStd } : null;
        this.bgStatsGen = p.coord.generation;
        return this.bgStatsCache;
    }

    // fork 1.1.3 src/search.ts:3827 SearchOrchestrator.ensureBinaryIndex
    async ensureBinaryIndex(expectedChunkCount: number): Promise<boolean> {
        const p = this.p;
        if (this.binaryIndex && this.binaryIndex.generation === p.coord.generation) return true;
        const { ids, packed } = await p.store.listAllBinary();
        if (ids.length === 0) { this.binaryIndex = null; return false; }
        const bytesPerVec = packed[0].length;
        this.binaryIndex = { ids, packed: concatPacked(packed, bytesPerVec), bytesPerVec, generation: p.coord.generation };
        // >5% divergence from the chunk store means a half-backfilled or corrupt index.
        if (Math.abs(ids.length - expectedChunkCount) > expectedChunkCount * 0.05) {
            console.warn(`[seek] binary index has ${ids.length} rows vs ${expectedChunkCount} chunks (>5% divergence) — consider Full reindex`);
        }
        return false;
    }

    // fork 1.1.3 src/search.ts:3901 SearchOrchestrator.ensureFrame
    async ensureFrame(): Promise<ResidentFrame | null> {
        const p = this.p;
        // Loop, not check-once: a new delta can start before we wake. No-op during a full reindex (intended: queryable as it fills).
        while (p.coord.currentDelta) { try { await p.coord.currentDelta; } catch { /* delta logged it */ } }
        if (this.frameCache && this.frameCache.generation === p.coord.generation) return this.frameCache;
        // A full reindex has no currentDelta gate, so it can bump the generation mid-build; stamp what we BUILT against (F2).
        const buildGeneration = p.coord.generation;
        const chunks = await p.store.listAllMeta();
        await this.ensureBinaryIndex(chunks.length);
        if (chunks.length === 0 || !this.binaryIndex) {
            if (shouldDiscardPartialFrame(buildGeneration, p.coord.generation)) return this.ensureFrame();
            this.frameCache = null;
            return null;
        }
        const chunkByIdMap = new Map<string, ChunkMeta>();
        for (const c of chunks) chunkByIdMap.set(c.chunk_id, c);

        const rawIds = this.binaryIndex.ids;
        const rawPacked = this.binaryIndex.packed;
        const bytesPerVec = this.binaryIndex.bytesPerVec;

        const orderedChunks: ChunkMeta[] = [];
        const orderedIds: string[] = [];
        const filteredPacked = new Uint8Array(rawIds.length * bytesPerVec);
        let filteredCount = 0;
        for (let i = 0; i < rawIds.length; i++) {
            const c = chunkByIdMap.get(rawIds[i]);
            if (!c) continue;
            orderedChunks.push(c);
            orderedIds.push(rawIds[i]);
            filteredPacked.set(rawPacked.subarray(i * bytesPerVec, (i + 1) * bytesPerVec), filteredCount * bytesPerVec);
            filteredCount++;
        }
        if (filteredCount < rawIds.length) {
            console.warn(`[seek] dropped ${rawIds.length - filteredCount} orphan binary rows (no chunk sibling) — index may be partially backfilled`);
        }
        const activePacked = filteredCount === rawIds.length
            ? rawPacked
            : filteredPacked.subarray(0, filteredCount * bytesPerVec);

        // Resident int8 tier skipped on mobile / over budget: stage-2 then reads per-id from storage, same relevance, slower.
        let resident: ReturnType<typeof buildResidentRerankBlock> = null;
        if (p.int8Resident(orderedIds.length, bytesPerVec * 8)) {
            const { ids: embIds, vecs: embVecs } = await p.store.listAllEmbeddings();
            const embById = new Map<string, QuantVec>();
            for (let i = 0; i < embIds.length; i++) embById.set(embIds[i], embVecs[i]);
            resident = buildResidentRerankBlock(orderedIds, embById);
        }

        if (shouldDiscardPartialFrame(buildGeneration, p.coord.generation)) return this.ensureFrame();
        this.frameCache = {
            orderedChunks, orderedIds, activePacked, bytesPerVec,
            residentInt8: resident ? resident.int8 : null,
            residentScales: resident ? resident.scales : null,
            embDim: resident ? resident.embDim : 0,
            validRows: new Array<boolean>(orderedChunks.length).fill(true),
            tombstoneCount: 0,
            generation: buildGeneration,
        };
        return this.frameCache;
    }

    // fork 1.1.3 src/search.ts:4020 SearchOrchestrator.bm25CacheValid
    // searchableProperties/headingsField change the INDEX shape, so flipping either must force a refit.
    bm25CacheValid(orderedChunks: ChunkMeta[]): boolean {
        const s = this.p.settings;
        return !!(
            this.bm25Cache &&
            this.bm25CacheGeneration === this.p.coord.generation &&
            this.bm25CacheChunkCount === orderedChunks.length &&
            this.bm25CacheProps === s.searchableProperties &&
            this.bm25CacheHeadings === (s.headingsField || s.boostedBm25)
        );
    }

    // fork 1.1.3 src/search.ts:4032 SearchOrchestrator.stampBm25Cache
    // linkPairs is deliberately KEPT on restamp: it derives from link metadata, not this index.
    stampBm25Cache(chunkCount: number): void {
        const s = this.p.settings;
        this.bm25CacheGeneration = this.p.coord.generation;
        this.bm25CacheChunkCount = chunkCount;
        this.bm25CacheProps = s.searchableProperties;
        this.bm25CacheHeadings = s.headingsField || s.boostedBm25;
        this.synonymCache = null;
        this.phraseCache = null;
    }

    // fork 1.1.3 src/search.ts:4040 SearchOrchestrator.ensureBm25
    async ensureBm25(orderedChunks: ChunkMeta[]): Promise<boolean> {
        const p = this.p;
        const hit = this.bm25CacheValid(orderedChunks);
        if (!hit) {
            // boostedBm25 boosts headings to 4x, inert unless the field is indexed, so it implies heading indexing.
            const propsEnabled = p.settings.searchableProperties;
            const headingsEnabled = p.settings.headingsField || p.settings.boostedBm25;
            p.span?.push('bm25-warm');
            try {
                const bodies = await p.store.getBodiesMap(orderedChunks.map(c => c.chunk_id));
                // Assign only after the build completes: a partial index must never be visible to a concurrent search.
                const built = await new MultiFieldBM25().fitAsync(orderedChunks, bodies,
                    { searchableProperties: propsEnabled, headingsField: headingsEnabled }, p.yield);
                this.bm25Cache = built;
                this.stampBm25Cache(orderedChunks.length);
            } finally {
                p.span?.pop('bm25-warm');
            }
        }
        if (p.settings.synonymExpansion && !this.synonymCache) {
            this.synonymCache = buildSynonymMap(orderedChunks, t => this.bm25Cache!.termDocFraction(t));
        }
        return hit;
    }

    // fork 1.2.1 src/search.ts:4181 SearchOrchestrator.ensurePhraseCache
    ensurePhraseCache(): PhraseSynonymMap | null {
        if (!this.bm25Cache) return null;
        if (!this.linkPairCache) this.linkPairCache = this.p.mineLinkPairs();
        if (!this.phraseCache) {
            this.phraseCache = buildPhraseMap(
                aggregateLinkPairs(this.linkPairCache.values()),
                t => this.bm25Cache!.termDocFraction(t),
                this.synonymCache ?? undefined,
            );
        }
        return this.phraseCache;
    }

    // fork 1.1.3 src/search.ts:4457 SearchOrchestrator.bm25FieldBoosts
    bm25FieldBoosts(): Record<string, number> {
        if (!this.p.settings.boostedBm25) return DEFAULT_FIELD_BOOSTS;
        return { ...DEFAULT_FIELD_BOOSTS, aliases: 9.0, tags: 2.0, headings: 4.0 };
    }

    // fork 1.1.3 src/search.ts:4097 SearchOrchestrator.tryLoadPersistedBm25
    // Cold-start fast path: loading a persisted index beats the all-bodies refit (the 18.6 s mobile freeze).
    // The stamp gate tolerates corpus size/timestamp drift (bounded recall staleness, never wrong text).
    async tryLoadPersistedBm25(orderedChunks: ChunkMeta[]): Promise<void> {
        const p = this.p;
        try {
            const blob = await p.store.getBm25();
            if (!blob) return;
            const meta = await p.store.getMeta();
            if (!meta.lastIndexedAt) return;
            const live = buildBm25Stamp(meta, orderedChunks.length, p.settings);
            if (!bm25StampMatches(blob.stamp, live)) return;
            this.bm25Cache = new MultiFieldBM25().fromJSON(blob.json, orderedChunks, {
                searchableProperties: p.settings.searchableProperties,
                headingsField: p.settings.headingsField || p.settings.boostedBm25,
            });
            this.stampBm25Cache(orderedChunks.length);
        } catch (e) {
            console.warn('[seek] persisted BM25 load failed (refitting)', e);
        }
    }

    // fork 1.1.3 src/search.ts:4143 SearchOrchestrator.tryLoadCrossDeviceBm25
    // Target: a fresh/evicted device whose frame came from a sidecar hydrate. The populated frame, not a local
    // full reindex, is the precondition, since hydrate leaves lastIndexedAt null.
    async tryLoadCrossDeviceBm25(orderedChunks: ChunkMeta[]): Promise<void> {
        const p = this.p;
        if (!p.peerOn() || orderedChunks.length === 0) return;
        const meta = await p.store.getMeta();
        const live = buildBm25Stamp(meta, orderedChunks.length, p.settings);
        const got = await p.peerBm25(rec => bm25StampMatches(rec.stamp, live));
        if (!got) return;
        try {
            this.bm25Cache = new MultiFieldBM25().fromJSON(got.json, orderedChunks, {
                searchableProperties: p.settings.searchableProperties,
                headingsField: p.settings.headingsField || p.settings.boostedBm25,
            });
            this.stampBm25Cache(orderedChunks.length);
            void this.persistBm25(orderedChunks);
        } catch (e) {
            console.warn('[seek] cross-device BM25 load failed, refitting', e);
        }
    }

    // fork 1.1.3 src/search.ts:4181 SearchOrchestrator.persistBm25
    // Fire-and-forget from warm; gated on a COMPLETED index so a partial reindex is never persisted.
    async persistBm25(orderedChunks: ChunkMeta[]): Promise<void> {
        const p = this.p;
        try {
            if (!this.bm25Cache) return;
            const meta = await p.store.getMeta();
            if (!meta.lastIndexedAt) return;
            const stamp = buildBm25Stamp(meta, orderedChunks.length, p.settings);
            await p.store.putBm25(this.bm25Cache.toJSON(), stamp);
        } catch (e) {
            console.warn('[seek] BM25 persist failed (cold start will refit)', e);
        }
    }

    // fork 1.1.3 src/search.ts:4202 SearchOrchestrator.emitCrossDeviceBm25
    async emitCrossDeviceBm25(orderedChunks: ChunkMeta[]): Promise<void> {
        const p = this.p;
        if (!p.publishBm25 || !this.bm25Cache) return;
        try {
            const meta = await p.store.getMeta();
            if (!meta.lastIndexedAt) return;
            const stamp = buildBm25Stamp(meta, orderedChunks.length, p.settings);
            await p.publishBm25(JSON.stringify({ json: this.bm25Cache.toJSON(), stamp }));
        } catch (e) {
            await p.logError?.('emitCrossDeviceBm25', e).catch(() => {});
        }
    }

    // fork 1.1.3 src/search.ts:4239 SearchOrchestrator.maybePersistResidentBm25
    // Leading-edge throttle: a 4 MB write per delta on a churny phone is pure write amplification, and the
    // tolerant cold-load makes dropped writes harmless.
    maybePersistResidentBm25(): void {
        const p = this.p;
        const rf = this.frameCache;
        if (!rf || rf.generation !== p.coord.generation) return;
        if (!this.bm25CacheValid(rf.orderedChunks)) return;
        const now = p.now();
        if (now - this.lastBm25PersistMs < BM25_PERSIST_THROTTLE_MS) return;
        this.lastBm25PersistMs = now;
        // toJSON is a 200-630 ms sync block; guards ran up to 5 s ago by idle time, so re-check on run.
        const run = (): void => {
            this.cancelIdle = null;
            if (p.disposed()) return;
            const live = this.frameCache;
            if (!live || live.generation !== p.coord.generation) return;
            void this.persistBm25(live.orderedChunks);
        };
        if (!p.idle) { run(); return; }
        this.cancelIdle = p.idle(run);
    }

    // fork 1.1.3 src/search.ts:4299 SearchOrchestrator.warmCaches
    // Cold mobile must not build (the all-bodies read IS the freeze); it only re-persists what is already resident.
    async warmCaches(trigger: string): Promise<void> {
        const p = this.p;
        // Returning here is safe: invalidate bumps the generation BEFORE its warm call, so the running warm loops again.
        if (this.warming) return;
        if (p.mobile && !p.embedderLoaded()) { this.maybePersistResidentBm25(); return; }
        this.warming = true;
        p.beat?.('bm25-warm-start', { trigger });
        try {
            let warmed: ChunkMeta[] | null = null;
            do {
                const frame = await this.ensureFrame();
                if (!frame) break;
                await this.ensureBm25(frame.orderedChunks);
                warmed = frame.orderedChunks;
            } while (this.bm25CacheGeneration !== p.coord.generation);
            if (warmed && this.bm25CacheGeneration === p.coord.generation) {
                void this.persistBm25(warmed);
                // Only a full reindex publishes: deltas drift is absorbed by the consumer's tolerant load.
                if (trigger === 'full-reindex') void this.emitCrossDeviceBm25(warmed);
            }
        } catch (e) {
            console.warn('[seek] cache re-warm failed (next search rebuilds lazily)', e);
        } finally {
            this.warming = false;
        }
    }

    // fork 1.1.3 src/search.ts:4472 SearchOrchestrator.invalidateBm25Cache
    // Name kept from the original: it drops every generation-keyed cache, not just BM25.
    invalidateBm25Cache(): void {
        this.bm25Cache = null;
        this.bm25CacheGeneration = -1;
        this.bm25CacheChunkCount = -1;
        this.synonymCache = null;
        this.phraseCache = null;
        this.linkPairCache = null;
        this.binaryIndex = null;
        this.frameCache = null;
        this.p.coord.bumpGeneration();
    }
}
