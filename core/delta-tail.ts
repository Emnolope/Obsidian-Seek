// Small helpers the delta pass leans on. The state each one touches (stores, caches, counters) belongs to the host and arrives through its ctx.
import type { QuantVec } from './quant.ts';
import type { DiffStore } from './file-diff.ts';
import { embedInput } from './token-budget.ts';

export interface CarryOverCtx {
    store: Pick<DiffStore, 'getFileRecord' | 'getTiersByIds'>;
    logger: { appendError(context: string, e: unknown): Promise<void> };
}
export interface GhostCtx {
    bm: { readonly dirtCount: number } | null;
    forensics: { beat(type: string, detail?: Record<string, unknown>): void } | null;
    invalidateBm25Cache(): void;
    warmCaches(reason: string): Promise<unknown>;
}
export interface FallbackCtx {
    counts: Map<string, number>;
    setLastReason(reason: string): void;
    forensics: { beat(type: string, detail?: Record<string, unknown>): void } | null;
}

// fork 1.1.3 src/search.ts:3146 SearchOrchestrator.harvestCarryOverInto
// F13 carry-over: harvest the rerank/sign tiers of every chunk about to be
// removed, keyed by EMBED TEXT (title\n\ncontent — path-independent). A move
// re-keys identical content under a new path-salted chunk_id, so its vector is
// unchanged; harvesting lets the embed phase reuse it verbatim. Reads the
// affected files' stored chunks by id BEFORE they're deleted; merges into `map`
// so the deleted-path and dirty-path harvests share one table.
export async function harvestCarryOverInto(
    ctx: CarryOverCtx,
    map: Map<string, { q: QuantVec; sign: Uint8Array }>,
    paths: string[],
): Promise<void> {
    const seen = new Set<string>();
    for (const path of paths) {
        if (seen.has(path)) continue;
        seen.add(path);
        try {
            const rec = await ctx.store.getFileRecord(path);
            if (!rec || rec.chunk_ids.length === 0) continue;
            const tiers = await ctx.store.getTiersByIds(rec.chunk_ids);
            for (const t of tiers) {
                if (t) map.set(embedInput(t.chunk), { q: t.q, sign: t.sign });
            }
        } catch (e) {
            // Carry-over is a pure optimization (reuse the identical vector on a
            // move / no-op re-flush). A harvest failure must NEVER abort the
            // delta — that would drop this edit from the index entirely. Record
            // it (forensics ring + per-device log) and fall through: this file
            // simply re-embeds normally.
            await ctx.logger.appendError(`carryOver-harvest:${path}`, e);
        }
    }
}

// fork 1.1.3 src/search.ts:2062 SearchOrchestrator.reconcileGhostDirt (threshold: SearchOrchestrator.GHOST_DIRT_REFIT_THRESHOLD)
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
export const GHOST_DIRT_REFIT_THRESHOLD = 64;
export function reconcileGhostDirt(ctx: GhostCtx): boolean {
    const bm = ctx.bm;
    if (!bm) return false;
    const dirt = bm.dirtCount;
    if (dirt === 0) return false;
    ctx.forensics?.beat('ghost-dirt', { dirt, refit: dirt >= GHOST_DIRT_REFIT_THRESHOLD });
    if (dirt < GHOST_DIRT_REFIT_THRESHOLD) return false;
    ctx.invalidateBm25Cache();
    void ctx.warmCaches('ghost-dirt');
    return true;
}

// fork 1.1.3 src/search.ts:2360 SearchOrchestrator.deltaFallback
// Log why the incremental path declined + signal the caller to full-rebuild.
// S4 tripwire instrumentation: each decline is a full O(corpus) cache rebuild
// (listAllMeta + listAllBinary + embeddings scan), so per-reason session counts
// ride every beat — a churny session repeatedly tripping the SAME reason is the
// signal that reducing fallback frequency is worth engineering against. Until
// that data says otherwise, the fallback itself stays the correct design
// ("slow, never wrong").
// `reason` must be a STABLE slug — it keys deltaFallbackCounts, so per-call
// values (counts, sizes) go in `detail`, which rides the beat payload only.
export function deltaFallback(ctx: FallbackCtx, reason: string, detail?: Record<string, unknown>): false {
    ctx.setLastReason(reason);
    const n = (ctx.counts.get(reason) ?? 0) + 1;
    ctx.counts.set(reason, n);
    // console.* is invisible on mobile; the beat is the field-observable channel.
    console.info(`[seek] applyDelta fallback: ${reason} — full cache rebuild (×${n} this session)`
        + (detail ? ` ${JSON.stringify(detail)}` : ''));
    ctx.forensics?.beat('delta-fallback', { reason, sessionCount: n, ...detail });
    return false;
}
