// The liveness oracles: re-chunk the live vault with the same pipeline indexing used (chunksFor, then the token-budget split) so chunk_ids reproduce exactly.
// reChunkLive feeds a hydrate; collectLiveIds feeds sidecar compaction, which deletes on this answer and so also reports whether it was complete.
import type { Chunk } from './types.ts';
import type { LiveFile } from './delta.ts';
import { cyrb53Hex } from './chunker.ts';
import { enforceTokenBudget } from './token-budget.ts';
import type { ReChunkedNote } from './sidecar-types.ts';

export interface LiveOracleCtx<H> {
    embedder: { ensureTokenizer(): Promise<void>; tokenCounts(texts: string[]): Promise<number[]> };
    logger: { appendError(context: string, e: unknown): Promise<void> };
    // Already the indexable set; shouldIndex narrows it exactly as the delta and full passes do.
    indexableFiles(): LiveFile<H>[];
    shouldIndex(path: string): boolean;
    read(file: LiveFile<H>): Promise<string>;
    cheapYield(): Promise<void>;
    chunksFor(content: string, path: string, modifiedIso: string | null): Chunk[];
}

// fork 1.1.3 src/search.ts:2699 SearchOrchestrator.reChunkLive
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
export async function reChunkLive<H>(ctx: LiveOracleCtx<H>): Promise<ReChunkedNote[]> {
    await ctx.embedder.ensureTokenizer();
    const out: ReChunkedNote[] = [];
    for (const f of ctx.indexableFiles().filter(f => ctx.shouldIndex(f.path))) {
        let content: string;
        try {
            content = await ctx.read(f);
        } catch {
            continue;
        }
        let chunks = ctx.chunksFor(content, f.path, new Date(f.mtime).toISOString());
        if (chunks.length === 0) continue;
        try {
            chunks = (await enforceTokenBudget(chunks, ts => ctx.embedder.tokenCounts(ts))).chunks;
        } catch (e) {
            // Tokenizer hiccup on one note — skip its hydrate (it just embeds
            // later via the catch-up); never abort the whole hydrate.
            await ctx.logger.appendError(`reChunkLive-tokenBudget:${f.path}`, e);
            continue;
        }
        if (chunks.length > 0) out.push({ notePath: f.path, mtimeMs: f.mtime, chunks, contentHash: cyrb53Hex(content) });
    }
    return out;
}

// fork 1.1.3 src/search.ts:2736 SearchOrchestrator.collectLiveIds
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
export async function collectLiveIds<H>(ctx: LiveOracleCtx<H>): Promise<{ ids: Set<string>; complete: boolean }> {
    const ids = new Set<string>();
    try {
        await ctx.embedder.ensureTokenizer();
    } catch (e) {
        // A tokenizer-load failure (model files mid-sync on a cold mobile launch) makes
        // the whole snapshot untrustworthy — report incomplete (transient → caller
        // retries) rather than throwing into an anonymous swallowed catch upstream.
        await ctx.logger.appendError('collectLiveIds-ensureTokenizer', e);
        return { ids, complete: false };
    }
    let complete = true;
    let sinceYield = 0;
    for (const f of ctx.indexableFiles().filter(f => ctx.shouldIndex(f.path))) {
        // Yield the main thread every few files: this whole-vault re-chunk +
        // tokenizer pass runs at least once per session (any sidecar past the
        // byte floor reaches the oracle even when nothing is dead) and was a
        // solid CPU burn with no yields — issue #5-class background jank.
        // cheapYield (scheduler.yield / setTimeout(0)), NOT the rIC pacer:
        // this runs inside compactDevice's dir lock, and an rIC wait can
        // stall up to its 1 s timeout per yield under interaction — starving
        // a concurrent flush's sidecar append. ~ms-bounded cost instead.
        if (++sinceYield >= 8) { sinceYield = 0; await ctx.cheapYield(); }
        let content: string;
        try {
            content = await ctx.read(f);
        } catch (e) {
            // read error (e.g. an iCloud file not yet downloaded) → snapshot incomplete →
            // unsafe to delete. Logged with the path: this is the likeliest cause of a
            // persistent 'incomplete-rechunk' skip, so it must not be silent.
            complete = false;
            await ctx.logger.appendError(`collectLiveIds-read:${f.path}`, e);
            continue;
        }
        let chunks = ctx.chunksFor(content, f.path, new Date(f.mtime).toISOString());
        if (chunks.length === 0) continue; // genuinely empty note — no ids, not a skip
        try {
            chunks = (await enforceTokenBudget(chunks, ts => ctx.embedder.tokenCounts(ts))).chunks;
        } catch (e) {
            complete = false; // tokenizer hiccup → incomplete
            await ctx.logger.appendError(`collectLiveIds-tokenBudget:${f.path}`, e);
            continue;
        }
        for (const c of chunks) ids.add(c.chunk_id);
    }
    return { ids, complete };
}
