// Deferred sidecar flush: the pass packages a SidecarFlushJob and runs it after the write mutex releases. The sidecar IO functions are the host's (they take its
// file adapter), passed in under their own names so the body reads as it did.
import type { IndexIdentity } from './index-types.ts';
import type { SidecarFlushJob } from './embed-commit.ts';

export interface FlushChainCtx {
    sidecarFlushChain: Promise<void>;
    sidecarFlushesInFlight: number;
    runSidecarFlush(job: SidecarFlushJob): Promise<void>;
}

type PriorMeta = { format: number; lastFullReindex?: string | null } | null;

export interface FlushCtx<A> {
    // A live flag: the plugin may unload while a job is queued.
    readonly disposed: boolean;
    adapter: A;
    coord: { sidecarOn(): boolean; dir: string | null };
    logger: { deviceId: string; appendError(context: string, e: unknown): Promise<void> };
    ensureDir(adapter: A, dir: string): Promise<unknown>;
    readDeviceMeta(adapter: A, dir: string, deviceId: string): Promise<PriorMeta>;
    staleSidecarFormat(prior: PriorMeta, format: number): boolean;
    clearDevice(adapter: A, dir: string, deviceId: string, opts: { preserveSeqFloor: boolean }): Promise<unknown>;
    writeDeviceMeta(adapter: A, dir: string, meta: object): Promise<unknown>;
    bulkAppend(adapter: A, dir: string, deviceId: string, pending: SidecarFlushJob['pending']): Promise<unknown>;
    expectationFor(identity: IndexIdentity): object;
}

// fork 1.1.3 src/search.ts:412 SearchOrchestrator.flushSidecarAfterPass
export function flushSidecarAfterPass(ctx: FlushChainCtx, job: SidecarFlushJob | null): Promise<void> {
    if (!job) return Promise.resolve();
    ctx.sidecarFlushesInFlight++;
    // The .catch is load-bearing twice over, NOT belt-and-braces: runSidecarFlush
    // is written to never reject, but that rests on a non-local invariant (its
    // own catch handler's logging), and a single rejected link would (a) wedge
    // the chain so no future flush ever runs and (b) leak the stale error into
    // every later pass — reindexDelta's .finally would replace a SUCCESSFUL
    // critical section's result with it. Swallow here so both the chain and the
    // promise callers await are structurally rejection-free.
    const run = ctx.sidecarFlushChain
        .then(() => ctx.runSidecarFlush(job))
        .catch(() => {})
        .finally(() => { ctx.sidecarFlushesInFlight--; });
    ctx.sidecarFlushChain = run;
    return run;
}

// fork 1.1.3 src/search.ts:433 SearchOrchestrator.runSidecarFlush
// The flush body, moved verbatim from embedAndCommitFiles (1C). Best-effort:
// a sidecar failure must never fail the (already-committed) IDB index — it
// just means cross-device/eviction durability lags a pass.
export async function runSidecarFlush<A>(ctx: FlushCtx<A>, job: SidecarFlushJob): Promise<void> {
    // A disposed orchestrator must not write: a queued job outliving onunload
    // would keep appending after a plugin disable, and across a disable→
    // re-enable the NEW instance serializes on a fresh module-scoped dir-lock
    // map — the detached writer and the new pass's clearDevice/bulkAppend
    // would no longer mutually exclude, and a last-rename-wins collision could
    // republish a shard seq with different bytes (the #91 invariant). Skipping
    // is the documented-safe direction: a durability lag hydrate self-heals.
    if (ctx.disposed) return;
    // Re-read the live setting: it can toggle off between the pass and this flush.
    if (!ctx.coord.sidecarOn()) return;
    try {
        const adapter = ctx.adapter;
        // Create the sidecar dir up front. The F8 ordering writes meta FIRST,
        // and writeDeviceMeta (→ writeTextAtomic) does not create parents — so
        // on a fresh install the meta write would ENOENT and the catch below
        // would abort the WHOLE flush before bulkAppend (which ensures the dir
        // itself) ever runs, leaving no sidecar at all. ensureDir here makes the
        // dir exist before any write, independent of which write lands first.
        await ctx.ensureDir(adapter, ctx.coord.dir!);
        // F8: write/refresh meta BEFORE appending shard+jsonl. These three
        // writes aren't one transaction; ordering meta first means a crash
        // between them leaves meta-without-data (metaAccepts refuses cleanly;
        // the records re-embed next pass) instead of data-without-meta — a
        // fully-written sidecar the null-meta gate refuses, un-hydratable
        // until a full reindex, defeating the eviction-recovery the sidecar
        // exists for.
        const prior = await ctx.readDeviceMeta(adapter, ctx.coord.dir!, ctx.logger.deviceId);
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
        if (ctx.staleSidecarFormat(prior, job.identity.sidecarFormat)) {
            await ctx.clearDevice(adapter, ctx.coord.dir!, ctx.logger.deviceId, { preserveSeqFloor: true });
        }
        await ctx.writeDeviceMeta(adapter, ctx.coord.dir!, {
            // Canonical version slice (modelId/revision/chunkerVersion/dim)
            // from the single identity source — NOT embedder.modelId, which
            // is '' until a model load. format gates the cross-device protocol.
            ...ctx.expectationFor(job.identity),
            format: job.identity.sidecarFormat,
            deviceId: ctx.logger.deviceId,
            lastFullReindex: job.mode === 'full' ? new Date().toISOString() : (prior?.lastFullReindex ?? null),
            bgMean: job.bgMean,
            bgStd: job.bgStd,
        });
        await ctx.bulkAppend(adapter, ctx.coord.dir!, ctx.logger.deviceId, job.pending);
    } catch (e) {
        // Guarded so a logging failure can't turn into a rejection of this
        // method — the chain in flushSidecarAfterPass swallows anyway, but the
        // "never rejects" contract should hold locally, not by rescue.
        await ctx.logger.appendError('sidecar-commit', e).catch(() => {});
    }
}
