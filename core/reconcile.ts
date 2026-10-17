// Heal an unstamped-but-current index in place (no re-embed). The embed-free proof of "files unchanged" and the stamp are host-independent; the host supplies
// storage, the delta catch-up, and the runtime constants through ReconcileCtx.
import type { MetaConfig, IndexIdentity } from './index-types.ts';
import type { QuantVec } from './quant.ts';
import { dequantizeInt8 } from './quant.ts';
import { VecReservoir, denseBgStats, BG_RESERVOIR } from './dense-stats.ts';

export interface ReconcileCtx {
    store: {
        getMeta(): Promise<MetaConfig>;
        setMeta(meta: MetaConfig): Promise<void>;
        listAllEmbeddings(): Promise<{ ids: string[]; vecs: QuantVec[] }>;
    };
    coord: { runExclusive<T>(fn: () => Promise<T>): Promise<T> };
    computeDelta(): Promise<{ dirty: string[]; deleted: string[] }>;
    reindexDelta(dirty: string[], deleted: string[], opts: { embed: boolean }): Promise<unknown>;
    mobile: boolean;
    embedderLoaded(): boolean;
    healEligibility(meta: MetaConfig): 'stale' | 'eligible';
    identity(): IndexIdentity;
    EMBEDDING_DIM: number;
    MODEL_ID: string;
    resetBgStats(): void;
    invalidateBm25Cache(): void;
}

// fork 1.1.3 src/search.ts:1661 SearchOrchestrator.reconcileIdentityInPlace
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
export async function reconcileIdentityInPlace(ctx: ReconcileCtx): Promise<'stale' | 'stamped' | 'drained'> {
    // Almost always succeeds — enforceIndexIdentity read the meta moments ago to
    // detect the mismatch. A failure here is a transient mid-teardown read; return
    // 'stale' so the caller's fallback retries. Breadcrumb it: a PERSISTENT fault
    // would otherwise silently cost a reindex on every poll with no trace.
    const meta = await ctx.store.getMeta().catch(e => {
        console.warn('[seek] reconcileIdentityInPlace: meta unreadable, treating as stale', e);
        return null;
    });
    if (!meta) return 'stale';

    // Gate (identity.ts): only an UNSTAMPED, current-model+dim index is safe to stamp
    // in place. A present chunkerVersion (genuinely old / stamped-but-bumped) or a
    // cross-model/dim index falls through to the existing full-reindex / wait.
    if (ctx.healEligibility(meta) === 'stale') return 'stale';

    // Prove the files are byte-unchanged (embed-free AND tokenizer-free; on a stable-
    // mtime vault classifyFileDelta never even reads a file).
    let delta = await ctx.computeDelta();
    if (delta.dirty.length || delta.deleted.length) {
        // A few files drifted since the index was built. Catch just those up through
        // the normal resumable delta — desktop embeds (only if the model is already
        // loaded; we never force a load here, that is the caller's job), mobile stays
        // embed-free and defers. reindexDelta takes its OWN write mutex, so it is NOT
        // nested under one here.
        const embed = !ctx.mobile && ctx.embedderLoaded();
        await ctx.reindexDelta(delta.dirty, delta.deleted, { embed });
        delta = await ctx.computeDelta();
        if (delta.dirty.length || delta.deleted.length) return 'drained'; // deferred / still behind — don't stamp
    }

    // STAMP — one atomic write transaction under the write mutex (serializes against
    // a concurrent flush). Recompute the display-only dense background from the
    // stored int8 vectors (embed-free): the same accumulation a full pass does, just
    // dequantized first; the ~0.1% int8 drift is below the display tolerance and the
    // background is NOT a ranking input (dense-stats.ts). Mirrors the proven in-place
    // stamp at hydrateSidecar.
    await ctx.coord.runExclusive(async () => {
        const { vecs } = await ctx.store.listAllEmbeddings();
        const bgSum = new Float64Array(ctx.EMBEDDING_DIM);
        let bgN = 0;
        const reservoir = new VecReservoir(BG_RESERVOIR);
        for (const qv of vecs) {
            const v = dequantizeInt8(qv.q, qv.s);
            bgN++;
            for (let d = 0; d < v.length; d++) bgSum[d] += v[d];
            reservoir.add(v);
        }
        const bg = denseBgStats(bgSum, bgN, reservoir.sample);
        const id = ctx.identity();
        const m = await ctx.store.getMeta();
        await ctx.store.setMeta({
            ...m,
            embeddingDim: ctx.EMBEDDING_DIM,
            modelId: m.modelId ?? ctx.MODEL_ID,
            chunkerVersion: id.chunkerVersion,
            analyzerVersion: id.analyzerVersion,
            revision: id.revision,
            bgMean: bg?.mean ?? m.bgMean,
            bgStd: bg?.std ?? m.bgStd,
        });
    });
    ctx.resetBgStats();        // invalidate the cached bg accessor (mirrors hydrateSidecar)
    ctx.invalidateBm25Cache();  // bump dataGeneration so the next search rebuilds against the stamped meta
    return 'stamped';
}
