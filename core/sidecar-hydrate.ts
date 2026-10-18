// The hydrate path, host-independent: rebuild the local index from the synced sidecar without re-embedding, the gated whole-vault reconcile, and the warnings for a stranded
// or version-refused sidecar. The plugin supplies the file adapter, the sidecar IO and the index store through SidecarSyncCtx.
import type { DeltaAdd } from './search-helpers.ts';
import { pushDeltaAdds } from './search-helpers.ts';
import type { MetaConfig, IndexIdentity } from './index-types.ts';
import { META_SCHEMA_VERSION } from './index-types.ts';
import type { QuantVec } from './quant.ts';
import type { Chunk, ChunkMeta, SidecarHydrateEntry } from './types.ts';
import type { FileRecord } from './index-types.ts';
import type { ReChunkedNote, HydrateResult, HydrateDeps, SidecarMeta, MetaExpectation } from './sidecar-types.ts';
import type { SidecarOpsCtx } from './sidecar-ops.ts';
import { loadPersistedReconcileSig, persistReconcileSig, indexIsEmpty } from './sidecar-ops.ts';

export interface SidecarSyncCtx<A> extends SidecarOpsCtx<A> {
    coord: SidecarOpsCtx<A>['coord'] & { runExclusive<T>(fn: () => Promise<T>): Promise<T> };
    logger: SidecarOpsCtx<A>['logger'] & { append(entry: SidecarHydrateEntry): Promise<unknown> };
    store: SidecarOpsCtx<A>['store'] & {
        close(): void;
        open(): Promise<unknown>;
        getMeta(): Promise<MetaConfig>;
        setMeta(meta: MetaConfig): Promise<void>;
        listAllMeta(): Promise<ChunkMeta[]>;
        putBatchQuantized(chunks: Chunk[], tiers: { q: QuantVec; bin: Uint8Array }[]): Promise<void>;
        putFileRecord(rec: { note_path: string; mtimeMs: number; chunk_ids: string[]; contentHash?: string }): Promise<void>;
    };
    // The host's per-session state; core reads and writes it through the ctx.
    _peerAhead: boolean;
    warnedRefusals: Set<string>;
    warnedStranded: boolean;
    bgStatsGen: number;
    MODEL_ID: string;
    EMBEDDING_DIM: number;
    SIDECAR_FORMAT: number;
    pluginIdentity(): IndexIdentity;
    reChunkLive(): Promise<ReChunkedNote[]>;
    hydrateFromSidecar(deps: HydrateDeps<A>): Promise<HydrateResult>;
    rankAcceptedProducers(adapter: A, indexDir: string, expect: MetaExpectation): Promise<unknown[]>;
    probePeerAhead(adapter: A, indexDir: string, expect: MetaExpectation): Promise<boolean>;
    shouldReconcileSidecar(sig: string, prev: string | null, indexEmpty: boolean): boolean;
    nukeDatabase(dbName: string): Promise<unknown>;
    invalidateBm25Cache(): void;
    warmCaches(trigger: string): Promise<void>;
}

// fork 1.1.3 src/search.ts:2415 SearchOrchestrator.hydrateSidecar
// Rebuild the IDB index from the vault-file sidecar without re-embedding —
// the iOS-eviction / fresh-device recovery path. Runs under the write mutex
// (can't overlap a reindex/delta), reproduces ids by re-chunking the live
// vault, and writes only the intersection that isn't already in IDB. Returns
// null when the sidecar is off. Idempotent: a warm index hydrates nothing.
export async function hydrateSidecar<A>(ctx: SidecarSyncCtx<A>): Promise<HydrateResult | null> {
    if (!ctx.coord.sidecarOn()) return null;
    // Was the index empty BEFORE this hydrate? Captured outside the mutex; a race
    // that populates it concurrently only costs the identity stamp below (degrades
    // to the un-stamped path), never correctness.
    const wasEmpty = (await ctx.store.count()).chunks === 0;
    const result = await ctx.coord.runExclusive(() =>
        ctx.hydrateFromSidecar(hydrateDeps(ctx, () => ctx.reChunkLive())),
    );
    ctx._peerAhead = result.peerAhead; // refresh the "newer index exists" signal per scan
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
        const id = ctx.pluginIdentity();
        const m = await ctx.store.getMeta();
        await ctx.store.setMeta({ ...m, modelId: m.modelId ?? ctx.MODEL_ID, chunkerVersion: id.chunkerVersion, analyzerVersion: id.analyzerVersion, revision: id.revision });
    }
    // Inherit display calibration from the producer when this device has none
    // of its own (a hydrate-only iOS device that never full-reindexed). Only
    // fill when absent — a local full reindex's stats describe THIS index more
    // faithfully and must win. Invalidate the cached accessor so the next
    // search re-reads.
    if (result && result.bgMean != null && result.bgStd != null) {
        const m = await ctx.store.getMeta();
        if (m.bgMean == null) {
            await ctx.store.setMeta({ ...m, bgMean: result.bgMean, bgStd: result.bgStd });
            ctx.bgStatsGen = -1;
        }
    }
    // A hydrate is a store mutation: drop caches so the next search rebuilds
    // against the restored index (mirrors reindex/delta completion).
    if (result && result.hydrated > 0) {
        ctx.invalidateBm25Cache();
        void ctx.warmCaches('hydrate');
        ctx.warnedStranded = false; // index is populated again — re-arm the empty-net warning
    } else if (result) {
        // Restored nothing — if the index is also empty, search will silently
        // return no results. Surface that (the net-is-gone case).
        await warnIfIndexStranded(ctx, result);
    }
    return result;
}

// fork 1.1.3 src/search.ts:2479 SearchOrchestrator.rebuildFromSidecar
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
export async function rebuildFromSidecar<A>(ctx: SidecarSyncCtx<A>): Promise<HydrateResult | null> {
    if (!ctx.coord.sidecarOn()) return null;
    const expect = ctx.expectationFor();
    const producers = await ctx.rankAcceptedProducers(ctx.adapter, ctx.coord.dir!, expect);
    if (producers.length === 0) {
        // Nothing compatible to rebuild FROM — do NOT nuke. acceptedProducers:0
        // signals the caller to tell the user the sidecar hasn't synced yet.
        return { scanned: 0, needed: 0, hydrated: 0, skippedPartialNotes: 0, refusedProducers: 0, acceptedProducers: 0, peerAhead: false, hydratedNotePaths: [] };
    }
    // 1. Nuke + reopen under the write mutex (mirrors reindexAllInner's reset) so a
    //    delta/search can't race the close→delete→open window. modelId = the
    //    canonical sidecar model (NOT embedder.modelId, which is '' on a cold
    //    mobile embedder) so the rebuilt index's stamp matches the producer's.
    await ctx.coord.runExclusive(async () => {
        ctx.store.close();
        await ctx.nukeDatabase(ctx.store.dbName);
        await ctx.store.open();
        const id = ctx.pluginIdentity();
        await ctx.store.setMeta({ embeddingDim: ctx.EMBEDDING_DIM, lastIndexedAt: null, schemaVersion: META_SCHEMA_VERSION, modelId: ctx.MODEL_ID, chunkerVersion: id.chunkerVersion, analyzerVersion: id.analyzerVersion, revision: id.revision });
    });
    // 2. Drop every resident cache that referenced the nuked index, then hydrate
    //    (its own write mutex; the now-empty store forces a full reconcile).
    ctx.invalidateBm25Cache();
    return hydrateSidecar(ctx);
}

// fork 1.1.3 src/search.ts:2667 SearchOrchestrator.reconcileSidecarIfChanged
// Gated whole-vault reconcile, shared by BOTH the onload sweep and the 5-min
// interval. Skips the expensive reChunkLive sweep when the sidecar dir is
// byte-identical to the last successful reconcile AND the local index is
// populated; always sweeps when the store is empty (iOS eviction / fresh
// device — see shouldReconcileSidecar). The signature is persisted, so a
// crash-relaunch with an unchanged vault no longer re-chunks for nothing.
// The manual `seek-sidecar-reconcile` command and the drift-recovery ladder
// deliberately bypass this and call hydrateSidecar() directly (explicit
// user / recovery intent must never be gated).
export async function reconcileSidecarIfChanged<A>(ctx: SidecarSyncCtx<A>): Promise<HydrateResult | null> {
    if (!ctx.coord.sidecarOn()) return null;
    const sig = await ctx.sidecarDirSignature(ctx.adapter, ctx.coord.dir!, ctx.logger.deviceId);
    const prev = ctx.lastReconcileSig ?? loadPersistedReconcileSig(ctx);
    if (!ctx.shouldReconcileSidecar(sig, prev, await indexIsEmpty(ctx))) {
        // Signature unchanged → the (expensive) hydrate is skipped, but _peerAhead resets
        // to false on every new orchestrator and ONLY hydrateSidecar refreshes it. Recover
        // the bit with a cheap meta-only probe so the peer-ahead banner + mobile grind-stop
        // survive an app relaunch on an unchanged vault (the common iOS case) instead of
        // silently disengaging while falsely reading "healthy". No reChunk, no mutation —
        // just a producer-meta read; mirrors hydrateFromSidecar's own peerAhead predicate.
        ctx._peerAhead = await ctx.probePeerAhead(ctx.adapter, ctx.coord.dir!, ctx.expectationFor());
        return null;
    }
    const result = await hydrateSidecar(ctx);
    persistReconcileSig(ctx, sig);
    return result;
}

// fork 1.1.3 src/search.ts:2921 SearchOrchestrator.warnRefusedProducer
// A version-gate refusal is EXPECTED and self-healing — e.g. right after a
// CHUNKER_VERSION bump the other device's sidecar is one version behind until
// it re-embeds. So it's a one-time warn (no stack trace, not an `error` entry):
// the old appendError fired two red console lines + an error log on every
// reconcile, flooding the console for a benign, transient state. Refusing the
// producer is correct (a stale chunk_id space can't be reproduced locally) —
// only the loudness was the bug.
export function warnRefusedProducer<A>(ctx: SidecarSyncCtx<A>, dev: string, meta: SidecarMeta | null, expect: MetaExpectation): void {
    const reason = !meta
        ? 'missing/unreadable meta'
        : [
              meta.format !== ctx.SIDECAR_FORMAT ? `format ${meta.format}≠${ctx.SIDECAR_FORMAT}` : '',
              meta.modelId !== expect.modelId ? `model ${meta.modelId}≠${expect.modelId}` : '',
              meta.chunkerVersion !== expect.chunkerVersion ? `chunker v${meta.chunkerVersion}≠v${expect.chunkerVersion}` : '',
              meta.dim !== expect.dim ? `dim ${meta.dim}≠${expect.dim}` : '',
          ]
              .filter(Boolean)
              .join(', ');
    const key = `${dev}:${reason}`;
    if (ctx.warnedRefusals.has(key)) return;
    ctx.warnedRefusals.add(key);
    console.warn(`[seek] skipping sidecar producer ${dev} (${reason}) — its index predates this device; will hydrate once that device re-embeds`);
    // One NDJSON breadcrumb (not an error entry) so device reports still show a
    // producer was paused. Reuses SidecarHydrateEntry's open index signature.
    void ctx.logger.append({ type: 'sidecar-hydrate', timestamp: new Date().toISOString(), phase: 'version-gate-refused', device: dev, reason }).catch(() => {});
}

// fork 1.1.3 src/search.ts:2955 SearchOrchestrator.warnIfIndexStranded
// The failure the sidecar exists to PREVENT: sidecar is on, yet after a
// hydrate the IDB index is still empty → the next search returns ZERO results
// with no error. Causes: iOS evicted the IDB and no producer has synced in, or
// the index dir was deleted / never reached this device (the config-folder
// split). This used to be silent — only a `producerFilesFound:0` debug line.
// Surface it as a real console error ONCE, gated on a true-empty index (cheap
// IDB count) so a healthy warm index never trips it. Cause is read off the
// hydrate result so the message is actionable.
export async function warnIfIndexStranded<A>(ctx: SidecarSyncCtx<A>, result: HydrateResult): Promise<void> {
    if (ctx.warnedStranded) return;
    const { chunks } = await ctx.store.count();
    if (chunks > 0) return; // index is populated — search works, nothing stranded
    ctx.warnedStranded = true;
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
    void ctx.logger
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

// fork 1.1.3 src/search.ts:2994 SearchOrchestrator.hydrateDeps
// Shared HydrateDeps; only the re-chunk source varies (whole vault vs the
// dirty subset for delta dedup).
// addsSink (Seek scaling A1): when present, putQuantized ALSO surfaces each
// hydrated chunk into the delta change-set, so a sidecar-dedup delta can be
// applied incrementally (applyDelta) instead of forcing a full rebuild. Only
// the delta path (dedupViaSidecar) passes it; the standalone hydrateSidecar
// does its own invalidate+warm, so it leaves it undefined.
export function hydrateDeps<A>(ctx: SidecarSyncCtx<A>, reChunk: () => Promise<ReChunkedNote[]>, addsSink?: DeltaAdd[]): HydrateDeps<A> {
    return {
        adapter: ctx.adapter,
        indexDir: ctx.coord.dir!,
        expect: ctx.expectationFor(),
        reChunk,
        existingIds: async () => new Set((await ctx.store.listAllMeta()).map(c => c.chunk_id)),
        putQuantized: async (chunks, tiers) => {
            await ctx.store.putBatchQuantized(chunks, tiers);
            // After the IDB write, so the sink holds only rows that landed.
            if (addsSink) pushDeltaAdds(addsSink, chunks, tiers);
        },
        putFileRecord: rec => ctx.store.putFileRecord(rec),
        onRefusedProducer: (dev, meta, expect) => warnRefusedProducer(ctx, dev, meta, expect),
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
            void ctx.logger.append({ type: 'sidecar-hydrate', timestamp: new Date().toISOString(), phase: msg, ...flat }).catch(() => {});
        },
    };
}
