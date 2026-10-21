// fork 1.1.3 new; relates to src/main.ts:137 SeekPlugin (the index-lifecycle half: edit queues, flush, catch-up drain, drift recovery, identity heal, periodic reconcile, pause/resume, health)
// The controller that keeps an index fresh and healthy, lifted out of the plugin so a bot host can run the same one. Everything Obsidian-shaped
// (Notice, activeDocument, TFile, window timers, the task-context tracker, the model loader) is a port; bodies are unchanged apart from those substitutions.
// Per-method pointers below; fields keep their original names and comments.
import type { SeekSettings, IndexCompleteEntry } from './types.ts';
import type { MetaConfig, FileRecord } from './index-types.ts';
import type { TaskContext } from './task-context.ts';
import { identityMatches, identityFromMeta, type IndexIdentity } from './identity.ts';
import { drainCatchUp, CATCHUP_MAX_FILES_PER_BURST, CATCHUP_BURST_BUDGET_MS } from './catchup.ts';
import { nextFlushDelay } from './flush-schedule.ts';
import { driftRecoveryDecision } from './search-helpers.ts';
import { INDEX_STALE_MSG, INDEX_SYNCING_MSG, INDEX_PEER_AHEAD_MSG, type DegradedReason } from './index-notice.ts';

// Incremental-indexing debounces. Edits wait out a 5-min idle window after the
// user leaves a note (so flipping back to keep writing never triggers a flush
// mid-thought); deletes/moves apply on a short window (they're model-free and a
// dead search result is jarring). See wireIncrementalIndexing. The idle window
// and its max-wait cap live in flush-schedule.ts (pure, so they're testable —
// this file has no unit coverage).
export const STRUCT_FLUSH_MS = 1500;

// How often periodicReconcile may re-arm catch-up with a fresh delta (issue #8).
// Deliberately much coarser than the 5-min poll it rides: the check costs an
// O(vault) listFileRecords scan, and issue #5 was caused by exactly this method
// doing per-tick work on a large vault. It is a BACKSTOP — the modify/create/
// delete/rename listeners are the live path — so a coarse interval is enough.
export const CATCHUP_REARM_INTERVAL_MS = 20 * 60 * 1000;

// Sidecar compaction: how many 'incomplete-rechunk' verdicts (each = a full
// vault re-chunk that found an unreadable/untokenizable file) to tolerate per
// session before latching compaction off until the next session. 3 gives a
// genuinely transient failure (file mid-sync) two more polls to clear while
// capping the pathological case at ~15 minutes of exposure.
export const SIDECAR_COMPACT_MAX_INCOMPLETE_RETRIES = 3;

// Hard-error budget for the every-poll small-shard coalesce before it latches
// off for the session (transient iCloud/WKWebView IO deserves a few retries;
// a persistent disk-full must not re-run a rewrite every 5 minutes).
export const SIDECAR_COALESCE_MAX_FAILURES = 3;

// A delta larger than this isn't an edit — it's a bulk import (paste, vault sync,
// git checkout). flushDirty treats it as a mini-reindex: progress is surfaced, a
// live query preempts the embed, and a cold desktop model is deferred rather than
// force-loaded for a background paste. At or below it, the single-note force path
// is unchanged (a 1-2 file embed is too short to be worth the extra machinery).
export const BULK_DELTA_THRESHOLD = 50;
// A modal torn down without onClose would latch the search-active flag forever; past this age the flag reads inactive, and an active session re-stamps it on every keystroke.
export const SEARCH_ACTIVE_MAX_AGE_MS = 60_000;

export interface LifecycleHost {
    isWriting(): boolean;
    readonly peerAhead: boolean;
    currentGeneration(): number;
    computeDelta(): Promise<{ dirty: string[]; deleted: string[] }>;
    reindexDelta(
        dirty: string[], deleted: string[],
        opts: { embed: boolean; maxFiles?: number; budgetMs?: number; shouldContinue?: () => boolean; onProgress?: (msg: string) => void },
    ): Promise<{ embedded: IndexCompleteEntry | null; deferredEmbed: number; committedPaths: string[] }>;
    rebuildFromSidecar(): Promise<{ acceptedProducers: number } | null>;
    reconcileIdentityInPlace(): Promise<'stale' | 'stamped' | 'drained'>;
    peerSidecarPresent(): Promise<boolean>;
    reconcileSidecarIfChanged(): Promise<unknown>;
    hydrateSidecar(): Promise<unknown>;
    warmCaches(trigger: string): Promise<void>;
    verifyCoherent(): Promise<boolean>;
    sweepOrphanChunks(opts: { shouldContinue?: () => boolean }): Promise<{ removed: number; completed: boolean }>;
    compactOwnSidecar(): Promise<{ compacted: boolean; shed: number; reason?: string } | null>;
    coalesceOwnSidecar(): Promise<{ shed: number; skippedLines: number } | null>;
}

// What the lifecycle needs from its runtime. Plugin: Obsidian (Notice, activeDocument, window timers, TFile mtimes). Bot: process-level equivalents.
export interface LifecyclePorts {
    host: LifecycleHost;
    store: { getMeta(): Promise<MetaConfig>; count(): Promise<{ chunks: number }>; getFileRecord(path: string): Promise<FileRecord | undefined> };
    logger: { appendError(context: string, e: unknown): Promise<void> };
    readonly settings: SeekSettings;
    mobile: boolean;
    hidden(): boolean;
    embedderLoaded(): boolean;
    notify(msg: string, ms?: number): void;
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(h: unknown): void;
    pushTaskContext(c: TaskContext): void;
    popTaskContext(c: TaskContext): void;
    ensureModelLoaded(): Promise<void>;
    overrideActive(): boolean;
    identity(): IndexIdentity;
    newPacer(): { pace(): Promise<void> };
    // Epoch-ms mtime of a live vault file, or -1 when it no longer exists (deleted or moved).
    mtimeOf(path: string): number;
    isIndexing(): boolean;
}

export class IndexLifecycle {
    private p: LifecyclePorts;
    constructor(ports: LifecyclePorts) { this.p = ports; }

    // Incremental indexing state (see wireIncrementalIndexing). The queues hold
    // paths touched THIS session; the durable dirty signal is always on-disk
    // mtime vs. the stored FileRecord, so the startup sweep (reconcileOnLoad) is
    // the real catch-up and these are just a live-session optimization.
    dirtyQueue = new Set<string>();
    deletedQueue = new Set<string>();
    idleTimer: unknown = null;   // 5-min debounce for edits
    structTimer: unknown = null;  // short debounce for deletes/moves
    // Epoch ms of the enqueue that started the CURRENT dirty queue; 0 = queue empty.
    // Bounds the idle debounce's reset (see nextFlushDelay) so an external write
    // stream can't push the flush out forever.
    firstDirtyAt = 0;
    flushing = false;                    // flushDirty re-entrancy guard
    catchUpPending = false;              // cold-mobile deferred an embed
    catchUpRunning = false;              // runCatchUp re-entrancy guard
    // Manual pause of a full reindex (design B). pauseIndexing() sets the request;
    // the full pass polls it at loop-top (isPaused) and breaks, committing what it
    // started and leaving the rest dirty. `indexPaused` latches AFTER the pass
    // returns paused, so the settings tab can show a "Paused" affordance and drive
    // resume (which finishes the remainder via the ordinary catch-up drain).
    indexPauseRequested = false;         // set by pauseIndexing(), consumed by the pass / resume
    indexPaused = false;                 // a paused full reindex is outstanding (settings reads this)
    lastCatchUpRearmAt = 0;              // epoch ms of the last periodic delta re-check
    // Size of the incremental pass currently running (flushDirty's delta, or the
    // catch-up drain); 0 when idle. Exists so the settings status card can say WHAT
    // it is indexing — a bare "Indexing…" is indistinguishable from a full rebuild,
    // which is most of why issue #8 was filed as "reindexes the entire vault".
    incrementalFiles = 0;
    // Drift auto-recovery (sibling of catch-up). The orchestrator detects persistent
    // frame/BM25 row-space drift and fires onPersistentDrift; we run a bounded,
    // embed-free recovery ladder (warm → sidecar hydrate → verify). Re-escalation is
    // suppressed per index generation (see driftRecoveryDecision); indexHealth surfaces
    // a terminal 'degraded' on the settings page when the ladder can't re-couple.
    driftRecoveryPending = false;        // a persistent-drift escalation is queued for a safe window
    driftRecoveryRunning = false;        // runDriftRecovery re-entrancy guard
    lastDriftRecoveryGen = -1;           // coord generation we last escalated for; -1 = never
    indexHealth: 'healthy' | 'recovering' | 'degraded' = 'healthy';
    // WHY the index is in a non-healthy state, so the search-modal banner says the true
    // thing per cause (a 'drift' degradation must not claim "this update changed indexing").
    // Read alongside indexHealth, which splits the SAME 'version' reason into two banners:
    // 'recovering' = a peer's current index is syncing in (calm, no action); 'degraded' =
    // genuinely stale, reindex needed. Cleared on every return to 'healthy'. 'version' = a
    // CHUNKER_VERSION/model bump the user hasn't reindexed for; 'drift' = drift-recovery
    // exhausted; 'peer-ahead' = a PEER's index is newer than this build (update Seek), set
    // from orchestrator.peerAhead by applyPeerAheadBanner. See indexBannerSpec.
    degradedReason: DegradedReason = null;
    // True while the local index is version-stale AND a peer device's current-version
    // sidecar is present (so it WILL hydrate us embed-free on a later poll). Set from
    // peerSidecarPresent() at the version-stale branch and cleared on every heal. This —
    // NOT indexHealth==='recovering' — drives the calm "syncing from another device"
    // banner, because the local drift-recovery ladder also sets 'recovering' and must not
    // claim a (non-existent) peer is syncing on a single-device vault. See indexBannerSpec.
    peerSyncPending = false;
    // Fires the "update Seek" toast once per peer-ahead spell (cleared when the signal
    // clears, e.g. after the user updates and the newer sidecar becomes readable).
    peerAheadNotified = false;
    // Fires the version-identity mismatch log + the mobile "reindex on desktop" notice
    // once per stale spell (the gate re-checks every 5 min); cleared when identity heals
    // so a future version ship reports again. See enforceIndexIdentity.
    identityHealNotified = false;
    // True while a heal (peer rebuild / desktop reindex) is running, so the 5-min poll
    // firing mid-reindex doesn't stack a second one (reindexAllInner would queue it).
    identityHealInFlight = false;
    // The referential-integrity orphan sweep runs once per session (Phase 3), on the
    // first healthy 5-min poll — not at boot (it taxes app-open) and not repeatedly.
    // `Done` latches only on a COMPLETED pass; `Running` guards re-entrancy so an
    // overlapping poll tick can't double-run it.
    orphanSweepDone = false;
    orphanSweepRunning = false;
    // Sidecar self-compaction runs once per session on the same poll (after the sweep):
    // it reclaims this device's own superseded/orphaned sidecar records — the one GC an
    // off-grid device gets, since version-bump reindex + hydrate-from-peer need sync.
    // `Done` latches on any DEFINITIVE outcome (an incomplete re-chunk leaves it open to
    // retry); `Running` guards re-entrancy.
    sidecarCompactDone = false;
    // Bounded retries for the 'incomplete-rechunk' verdict (see periodicReconcile):
    // each retry costs a whole-vault re-chunk, so a persistent failure must not
    // grind every 5-minute poll for the session.
    sidecarCompactIncompleteRetries = 0;
    sidecarCompactRunning = false;
    // Small-shard coalesce (oracle-free, every poll tick — see periodicReconcile).
    // `Failed` latches OFF for the session after a few hard errors so a failing
    // rewrite (disk full, write error) doesn't re-run every 5 minutes — but a
    // single transient iCloud/WKWebView hiccup gets bounded retries first, since
    // a long mobile session that latched on one blip would quietly re-grow the
    // exact small-shard pile the pass exists to fold. `Running` guards
    // re-entrancy against a slow fold spanning a poll tick.
    sidecarCoalesceFailed = false;
    sidecarCoalesceFailures = 0;
    sidecarCoalesceRunning = false;
    searchActiveTimestamp: number | null = null;   // null = no live query session; else the ms timestamp of the last activity ping (modal open / keystroke) — pauses the catch-up drain so embedding never competes with the user's search
    // Count of query embeds/searches actually running right now (onQueryInFlight).
    // Distinct from the keystroke-timed searchActive — it falls only when the query
    // COMPLETES, so indexing waits for the query, not just for typing to pause.
    // A COUNT, not a boolean: the modal emits balanced 0↔1 edges for its own
    // queries, and each headless query (CLI handlers, deep-link open) contributes
    // one balanced true/false pair — so overlapping callers can't clear each
    // other's signal the way a shared boolean would.
    queryInFlightCount = 0;
    // Self-healing read of searchActive. A modal torn down without onClose (teardown
    // exception, dev hot-reload) would otherwise latch the flag true forever and
    // permanently starve catch-up (runCatchUp/drainCatchUp early-return on it, so
    // deferred cold-mobile embeds never reconcile until restart). Treat it inactive
    // past a max age; an active session re-stamps the timestamp on every keystroke.
    get searchActive(): boolean {
        if (this.searchActiveTimestamp === null) return false;
        if (Date.now() - this.searchActiveTimestamp > SEARCH_ACTIVE_MAX_AGE_MS) {
            this.searchActiveTimestamp = null;
            return false;
        }
        return true;
    }

    // The single gate every indexing path honours: hold embeds while the user's
    // query must win the shared (iOS) thread — an active typing session (keystroke-
    // timed) OR a query embed that is actually in flight (lifecycle-timed). The
    // second term is what makes indexing wait for the query to COMPLETE rather than
    // resuming 1.5 s after the last keystroke while a slow mobile embed still runs.
    get indexingBlocked(): boolean {
        return this.searchActive || this.queryInFlightCount > 0;
    }

    // fork 1.1.3 src/main.ts:1126 SeekPlugin.enforceIndexIdentity
    // ── Boot version-identity cascade ─────────────────────────────────────────────
    // The active replacement for warn-only drift: when the local index's stored
    // identity (chunker/model/revision/dim) differs from this build's, the index is
    // provably stale, so heal it WITHOUT user commands. Order: hydrate from a matching
    // peer (embed-free, both platforms) → else desktop auto full-reindex / mobile wait
    // (mobile never bulk-embeds = no jetsam; the 5-min poll retries until a desktop
    // publishes a current sidecar). Returns true when it took over the index (the
    // caller then skips the normal catch-up). Runs off this.p.identity() (compiled
    // constants), so it needs no model load and can gate a cold mobile boot.
    async enforceIndexIdentity(): Promise<boolean> {
        // The cascade self-heals via cross-device sidecar hydration (+ desktop reindex
        // fallback), so it only applies with the sidecar on. Sidecar-off keeps the
        // legacy warn-only check (warnOnModelIndexDrift, fired at model-load time).
        if (!this.p.settings.sidecarEnabled) return false;
        // A debug model override (testing arbitrary repos) keys the loaded model off
        // the override while the sidecar/identity machinery keys off the shipped
        // MODEL_ID — running the cascade would loop. Defer to the warn-only check.
        if (this.p.overrideActive()) return false;
        // A heal is already running — don't stack a second when the 5-min poll fires
        // mid-reindex. Report "handled" so the caller still skips the normal catch-up.
        if (this.identityHealInFlight) return true;
        // A reindex / cold-build / delta is mutating the index right now: its meta is
        // mid-stamp and its identity not yet written, so an identity check would race
        // it and could "heal" a build that is about to stamp itself current. Report
        // NOT handled — by the next poll the writer has finished and stamped (Fix A/C).
        // (Primary guard is periodicReconcile.isIndexBusy; this also covers the onload
        // call, where nothing is writing yet, as cheap belt-and-suspenders.)
        if (this.p.host.isWriting()) return false;

        const meta = await this.p.store.getMeta().catch(() => null);
        if (!meta) return false; // store unreadable mid-teardown — the 5-min poll rechecks
        // An empty index isn't "stale" — the normal first-build / cold-hydrate path
        // owns it. Count, NOT lastIndexedAt: a hydrate-only device holds chunks with a
        // null lastIndexedAt.
        if ((await this.p.store.count()).chunks === 0) return false;

        if (identityMatches(identityFromMeta(meta), this.p.identity())) {
            this.identityHealNotified = false; // healthy — re-arm reporting for a future ship
            // A peer sidecar (or a completed reindex) healed a version-stale index out
            // from under us: clear the banner/health. Scoped to 'version' so a concurrent
            // DRIFT degradation (separate axis) isn't stomped healthy here.
            if (this.degradedReason === 'version') { this.indexHealth = 'healthy'; this.degradedReason = null; this.peerSyncPending = false; }
            return false;
        }

        // ── MISMATCH: local index built under a different chunker/model/revision/dim.
        const cur = this.p.identity();
        const firstReport = !this.identityHealNotified;
        this.identityHealNotified = true;
        if (firstReport) {
            await this.p.logger.appendError('index-identity-mismatch', new Error(
                `stored chunker=${meta.chunkerVersion} model=${meta.modelId} rev=${meta.revision} dim=${meta.embeddingDim}` +
                ` → build chunker=${cur.chunkerVersion} model=${cur.modelId} rev=${cur.revision} dim=${cur.dim}`)).catch(() => {});
        }

        this.identityHealInFlight = true;
        try {
            // 1. Both platforms: hydrate from a matching-identity peer first (embed-free).
            //    rebuildFromSidecar nukes+stamps+hydrates ONLY if a compatible producer
            //    exists; otherwise it returns acceptedProducers:0 without touching the index.
            const rebuilt = await this.p.host.rebuildFromSidecar();
            if (rebuilt && rebuilt.acceptedProducers > 0) {
                this.identityHealNotified = false; // healed (silent — background sync)
                // A current-version peer existed: the fleet self-heals embed-free even
                // with desktop auto-reindex gone. Clear any version banner this device
                // was showing while it waited.
                if (this.degradedReason === 'version') { this.indexHealth = 'healthy'; this.degradedReason = null; this.peerSyncPending = false; }
                return true;
            }

            // 1b. No matching peer. Before the destructive fallback, try the embed-free
            //     in-place heal: an index that is merely UNSTAMPED but provably current
            //     (same model+dim, files unchanged — the cold-build identity bug, PR #43)
            //     is stamped in seconds instead of a ~7-min nuke+re-embed, and an
            //     interrupted attempt resumes (re-runs the seconds-long proof) instead of
            //     restarting from zero. Both platforms reach it; mobile stays embed-free.
            //     Only a GENUINELY old index ('stale') falls through to the rebuild/wait.
            const healed = await this.p.host.reconcileIdentityInPlace();
            if (healed === 'stamped') {
                this.identityHealNotified = false;
                this.indexHealth = 'healthy';
                this.degradedReason = null;
                this.peerSyncPending = false;
                return true;
            }
            if (healed === 'drained') {
                // Healed enough to stop the destructive loop, but a few edits are deferred
                // (mobile / model not yet loaded): the index isn't fully current, so leave
                // it degraded — the catch-up drain + a later poll finish and stamp it.
                this.indexHealth = 'degraded';
                // NOT a 'version' degradation: a drained index is an unstamped-but-
                // current-model index mid-catch-up (the cold-build path), not an
                // old-format one, so it must NOT raise the version-stale banner.
                // degradedReason is left untouched on purpose: a genuine concurrent 'drift'
                // reason (orthogonal axis) should persist. 'version' is effectively
                // unreachable here (a genuinely old index returns 'stale', not 'drained');
                // were a stale 'version' to somehow survive from a prior poll, the next
                // poll re-stamps and clears it, so the worst case is bounded, not stuck.
                return true;
            }

            // 2. No matching peer and a genuinely old index. CONSENT-GATED (2026-06-23):
            //    NEITHER platform auto-reindexes here anymore. We only mark the index
            //    version-stale, fire a one-time warning toast, and let the search-modal
            //    banner carry the action. Rationale:
            //      • Desktop auto-nuke silently degraded the user's search mid-rebuild
            //        (recency-first partial results with no explanation) — a surprise
            //        the user never opted into. The banner makes the state honest and
            //        hands them the trigger (decision: reverse the old auto-reindex).
            //      • Mobile already waited; now it gets the SAME banner, not just a toast.
            //    The embed-free heals above (peer sidecar / in-place stamp) still run
            //    automatically every poll, so a fleet where ANY device reindexes still
            //    converges for free — only the expensive re-embed needs consent.
            //    A still-valid older index stays fully queryable in the meantime; its
            //    stale chunks are invisible-not-wrong (content-addressed ids).
            //    KNOWN trade: a vault used ONLY from mobile (no desktop ever clicks
            //    Reindex, and a phone never bulk-embeds — the jetsam rule) stays degraded
            //    indefinitely. Intentional: an honest banner beats a surprise auto-nuke,
            //    and the embed-free heal still converges it the moment any desktop reindexes.
            //
            //    Split the message by whether a heal is actually coming. A peer device's
            //    sidecar is present (this vault is multi-device) but not yet at the current
            //    identity → its current index is mid-sync and WILL hydrate us embed-free on
            //    a later poll. That's a calm 'recovering' "syncing" state (answers the
            //    user's real questions: yes you can search, no you needn't do anything —
            //    and tapping Reindex on a phone is exactly the bulk re-embed we want them
            //    NOT to trigger). Only a genuinely-stuck index (no peer in sight) is
            //    'degraded' with the action-needed banner + sticky toast.
            const peerComing = await this.p.host.peerSidecarPresent();
            this.indexHealth = peerComing ? 'recovering' : 'degraded';
            this.degradedReason = 'version';
            // Drive the calm "syncing" banner off this explicit peer fact, not indexHealth:
            // local drift recovery also sets 'recovering' and must stay silent (see indexBannerSpec).
            this.peerSyncPending = peerComing;
            if (firstReport) {
                // Syncing: a brief, non-sticky heads-up (it self-heals, so don't nag).
                // Stale: sticky (duration 0) — rare enough that the intrusion is worth not
                // letting it auto-vanish unseen. Same copy as the modal banner, once per spell.
                if (peerComing) this.p.notify(INDEX_SYNCING_MSG, 8000);
                else this.p.notify(INDEX_STALE_MSG, 0);
            }
            return true;
        } finally {
            this.identityHealInFlight = false;
        }
    }

    // fork 1.1.3 src/main.ts:1270 SeekPlugin.isIndexBusy
    // True while the index is being built or mutated — a reindex/delta under the write
    // mutex (orchestrator.isWriting, which covers the cold first-build's reindexDelta),
    // a catch-up drain, a live flush, or a drift-recovery pass. The reconcile poll
    // consults this so a long build is never reconciled / healed out from under itself
    // on a large vault (Fix C: reindex_time > poll_interval). identityHealInFlight is
    // handled separately inside enforceIndexIdentity (it reports "handled", not "busy").
    isIndexBusy(): boolean {
        return this.catchUpRunning || this.flushing || this.driftRecoveryRunning
            || (this.p.host.isWriting() ?? false);
    }

    // fork 1.1.3 src/main.ts:1279 SeekPlugin.periodicReconcile
    // Periodic sidecar poll (remote sidecar arrivals fire no vault events). Re-runs the
    // identity gate FIRST so a device that was WAITING for a peer heals the moment a
    // desktop publishes a matching sidecar; otherwise the normal dir-signature-gated
    // catch-up. Wired to the 5-min interval.
    async periodicReconcile(): Promise<void> {
        // Span the whole poll: the sidecar reconcile, orphan sweep, and sidecar
        // compaction (a whole-vault re-chunk + tokenizer pass) all run here, and
        // none of their jank was attributed before (issue #5's 'idle' long-tasks).
        // Also load-bearing for the mobile unload gate: `busy` now covers the
        // compaction window, so the idle-unload can't tear the tokenizer down
        // mid-collectLiveIds (which read as a transient incomplete-rechunk).
        this.p.pushTaskContext('reconcile');
        try {
            // Never poll while a build/delta is in flight: assessing identity or
            // hydrating a sidecar would race a writer whose meta is mid-stamp. The
            // next tick (build done, identity stamped) handles it. This is the fix for
            // the large-vault loop where a 415s reindex outlived the 300s poll.
            if (this.isIndexBusy()) return;
            if (await this.enforceIndexIdentity()) return;
            await this.p.host.reconcileSidecarIfChanged();
            // The reconcile above scanned the sidecar dir, so peerAhead is fresh: raise (or
            // clear) the "update Seek" banner. Runs only on the local-healthy path, since
            // enforceIndexIdentity returns early when the local index is itself version-stale.
            this.applyPeerAheadBanner();
            // Once per session, after identity is confirmed healthy: GC orphan chunks
            // from same-version churn (a missed delete event, a file record overwritten
            // by hydrate). Embed-free set-arithmetic; if backgrounded mid-sweep it
            // aborts and the NEXT poll tick resumes it (latch only on completion).
            if (!this.orphanSweepDone && !this.orphanSweepRunning) {
                this.orphanSweepRunning = true;
                try {
                    const { completed } = await this.p.host.sweepOrphanChunks({ shouldContinue: () => !this.p.hidden() });
                    if (completed) this.orphanSweepDone = true;
                } finally {
                    this.orphanSweepRunning = false;
                }
            }
            // Once per session: compact this device's own sidecar if it has bloated with
            // dead records (superseded re-appends + un-tombstoned orphans). Model-free
            // byte-copy, so mobile-safe; reclaims the disk a full reindex would otherwise
            // be the only thing to free — and the only GC reaching an off-grid device.
            if (!this.sidecarCompactDone && !this.sidecarCompactRunning) {
                this.sidecarCompactRunning = true;
                try {
                    const r = await this.p.host.compactOwnSidecar();
                    if (r?.compacted) {
                        // A shed = this device's OWN shard was unreadable/corrupt for a
                        // still-live record → that note needs a model re-embed to be
                        // searchable again. Expected zero; surface any non-zero as a
                        // corruption breadcrumb (invisible on mobile without it).
                        if (r.shed > 0) await this.p.logger.appendError('sidecar-compaction-shed', new Error(`shed ${r.shed} corrupt/unreadable record(s)`)).catch(() => {});
                    } else if (r && r.reason === 'incomplete-rechunk') {
                        // Transient in principle (a file mid-sync failed to read, a
                        // tokenizer hiccup) — but each retry re-runs the WHOLE-VAULT
                        // re-chunk + tokenizer pass, and a persistently unreadable
                        // file (an un-downloaded iCloud original) turned that into a
                        // full-vault CPU burn every 5-minute poll for the entire
                        // session (issue #5's "unresponsive every couple of
                        // minutes"). Bound it: a few retries this session, then
                        // latch and say so — the next session starts fresh, and a
                        // full reindex still compacts unconditionally.
                        this.sidecarCompactIncompleteRetries++;
                        if (this.sidecarCompactIncompleteRetries >= SIDECAR_COMPACT_MAX_INCOMPLETE_RETRIES) {
                            this.sidecarCompactDone = true;
                            await this.p.logger.appendError('sidecar-compaction-retry-cap', new Error(
                                `live-id re-chunk incomplete ${this.sidecarCompactIncompleteRetries}× — a file is persistently unreadable or the tokenizer keeps failing (see collectLiveIds-* errors); deferring compaction to the next session`)).catch(() => {});
                        }
                    }
                    // Latch on any definitive verdict; an incomplete re-chunk retries
                    // (bounded above). null = sidecar off → don't latch (it may be
                    // enabled later this session).
                    if (r && r.reason !== 'incomplete-rechunk') this.sidecarCompactDone = true;
                } catch (e) {
                    // A hard failure (disk full, write error) would otherwise re-run the
                    // whole-vault re-chunk every poll forever — log it and latch off for
                    // the session rather than spin silently.
                    await this.p.logger.appendError('sidecar-compaction', e).catch(() => {});
                    this.sidecarCompactDone = true;
                } finally {
                    this.sidecarCompactRunning = false;
                }
            }
            // EVERY poll tick (unlike the once-per-session compaction): fold the
            // small per-flush shards the append-only writer (1A) accumulates into
            // dense ones once enough pile up. Oracle-free byte-copy — no re-chunk,
            // no model — and below its count gate it costs one directory listing,
            // so a heavy editing session gets folded down the same day instead of
            // waiting weeks for compaction's byte floor.
            if (!this.sidecarCoalesceFailed && !this.sidecarCoalesceRunning) {
                this.sidecarCoalesceRunning = true;
                try {
                    const c = await this.p.host.coalesceOwnSidecar();
                    // Same corruption breadcrumb as compaction: a shed record is a
                    // live id whose own-shard bytes were unreadable (expected zero).
                    if (c && c.shed > 0) await this.p.logger.appendError('sidecar-coalesce-shed', new Error(`shed ${c.shed} corrupt/unreadable record(s)`)).catch(() => {});
                    // Torn jsonl lines the fold's rewrite just removed for good —
                    // log the evidence before it is only visible here.
                    if (c && c.skippedLines > 0) await this.p.logger.appendError('sidecar-coalesce-skipped-lines', new Error(`rewrite dropped ${c.skippedLines} unparseable jsonl line(s)`)).catch(() => {});
                } catch (e) {
                    await this.p.logger.appendError('sidecar-coalesce', e).catch(() => {});
                    if (++this.sidecarCoalesceFailures >= SIDECAR_COALESCE_MAX_FAILURES) {
                        this.sidecarCoalesceFailed = true;
                        await this.p.logger.appendError('sidecar-coalesce-retry-cap', new Error(`coalesce failed ${this.sidecarCoalesceFailures}× — latching off for the session`)).catch(() => {});
                    }
                } finally {
                    this.sidecarCoalesceRunning = false;
                }
            }
            await this.rearmCatchUpIfStranded();
        } catch (e) {
            await this.p.logger.appendError('periodic-reconcile', e).catch(() => {});
        } finally {
            this.p.popTaskContext('reconcile');
        }
    }

    // fork 1.2.1 src/main.ts SeekPlugin.rearmCatchUpIfStranded (born after 1.1.3, no tag line)
    // Backstop for a stranded delta (issue #8). catchUpPending is set by
    // reconcileOnLoad (plugin load) and flushDirty (a vault event), and cleared by
    // drainCatchUp on an empty diff. Nothing re-armed it in between: once it went
    // false with work still outstanding — a debounce that never expired, an event
    // the watcher missed, a drain that gave up — the work sat until the NEXT plugin
    // load. Observed on a live vault: 195 externally-rewritten files still dirty 20
    // hours later, catchUpPending false, index health "healthy".
    //
    // The live listeners are the fix; this is the net under them, so it is
    // deliberately cheap to skip and coarse to run:
    //   - nothing to do when catch-up is already armed, or the model is cold (the
    //     drain needs it, and no timer should pull in ~250 MB the user never asked
    //     for — a cold session's work is caught by reconcileOnLoad next launch),
    //   - never while hidden (same window rule the drain itself uses),
    //   - at most once per CATCHUP_REARM_INTERVAL_MS, because computeDelta is
    //     O(vault) and per-tick work here is what made issue #5.
    // Runs inside periodicReconcile's 'reconcile' task-context span, so any jank it
    // causes is attributed rather than reading as idle.
    async rearmCatchUpIfStranded(): Promise<void> {
        if (this.catchUpPending || this.catchUpRunning) return;
        // A paused reindex (design B) leaves its remainder dirty ON PURPOSE. Re-arming
        // here would drain exactly what the user paused, 20 minutes after they paused
        // it. Resume owns that work — resumeIndexing() sets catchUpPending itself.
        if (this.indexPaused) return;
        if (!this.p.embedderLoaded() || !this.p.host) return;
        if (this.p.hidden()) return;
        const now = Date.now();
        if (now - this.lastCatchUpRearmAt < CATCHUP_REARM_INTERVAL_MS) return;
        this.lastCatchUpRearmAt = now;
        const { dirty, deleted } = await this.p.host.computeDelta();
        if (dirty.length === 0 && deleted.length === 0) return;
        // Re-arm only. drainCatchUp re-diffs on its own (it owns the outer sweep),
        // so handing it the flag rather than this delta keeps one source of truth;
        // the duplicate scan is paid only when there IS work, which is the rare case.
        this.catchUpPending = true;
        this.runCatchUp();
    }

    // fork 1.1.3 src/main.ts:1506 SeekPlugin.scheduleFlush
    // 5-min idle debounce for edits: resets on every enqueue, so flipping back to
    // keep writing pushes the flush out rather than firing mid-thought — but only
    // up to MAX_DIRTY_WAIT_MS from the oldest un-flushed enqueue. Uncapped, a sync
    // that dribbles files in slower than the window (the normal shape of Obsidian
    // Sync / iCloud catching up, now that 'modify' feeds this queue) would re-arm
    // the timer forever and never drain. See flush-schedule.ts.
    scheduleFlush(): void {
        const now = Date.now();
        if (this.firstDirtyAt === 0) this.firstDirtyAt = now;
        if (this.idleTimer != null) this.p.clearTimer(this.idleTimer);
        const delay = nextFlushDelay(now, this.firstDirtyAt);
        this.idleTimer = this.p.setTimer(() => { this.idleTimer = null; void this.flushDirty(); }, delay);
    }

    // fork 1.1.3 src/main.ts:1513 SeekPlugin.flushStructuralSoon
    // Short debounce for structural changes — model-free, so flush them soon
    // rather than waiting out the 5-min edit window (a dead result is jarring).
    flushStructuralSoon(): void {
        if (this.structTimer != null) this.p.clearTimer(this.structTimer);
        this.structTimer = this.p.setTimer(() => { this.structTimer = null; void this.flushDirty(); }, STRUCT_FLUSH_MS);
    }

    // fork 1.1.3 src/main.ts:1538 SeekPlugin.flushDirty
    // Drain the dirty/deleted queues through one reindexDelta. Deletes/moves
    // always apply (model-free structural phase); the embed half runs now on
    // desktop or a warm model, and defers on a cold mobile model (the edit's old
    // version stays searchable and the post-serve catch-up re-embeds it).
    async flushDirty(): Promise<void> {
        if (this.flushing || !this.p.host) {
            // A timer fired while a flush was already running (the in-progress flush
            // snapshotted BEFORE these items, so they need their own cycle). Re-arm
            // one so queued edits don't wait for the next unrelated enqueue or a
            // restart. Guard on no pending timer to avoid stacking; a stale re-arm
            // is harmless — flushDirty no-ops on an empty queue.
            if (this.flushing && (this.dirtyQueue.size > 0 || this.deletedQueue.size > 0)
                && this.idleTimer == null && this.structTimer == null) {
                this.scheduleFlush();
            }
            return;
        }
        if (this.dirtyQueue.size === 0 && this.deletedQueue.size === 0) return;
        this.flushing = true;
        // Span the whole drain: the incremental path was the biggest un-wrapped
        // jank source (issue #5 — all its long tasks logged as 'idle').
        this.p.pushTaskContext('indexing');
        const orchestrator = this.p.host;
        try {
            const dirty = [...this.dirtyQueue];
            const deleted = [...this.deletedQueue];
            this.incrementalFiles = dirty.length;
            // Snapshot each dirty file's mtime so the cleanup below can tell "this
            // exact version was flushed" from "re-edited during the await". A re-edit
            // bumps the mtime and enqueueIfDirty re-adds the path; a blind delete
            // would then clobber that second edit (lost until reconcileOnLoad).
            // -1 = the file vanished (deleted/moved) — handled via deletedQueue.
            const dirtyMtimes = new Map<string, number>();
            for (const p of dirty) {
                dirtyMtimes.set(p, this.p.mtimeOf(p));
            }
            const bulk = dirty.length > BULK_DELTA_THRESHOLD;
            // Cold-model embed deferral. Mobile: a cold model always defers (the
            // jetsam rule). Desktop: additionally defer a BULK cold flush — a
            // background paste/sync shouldn't force a ~250 MB model load; treat it
            // like reconcileOnLoad and let the first search drive the embed. A small
            // cold delta still loads, because the user is actively in that note.
            const coldMobile = this.p.mobile && !this.p.embedderLoaded();
            const coldDesktopBulk = !this.p.mobile && !this.p.embedderLoaded() && bulk;
            // Peer-ahead grind-stop (mobile): a newer-version peer index exists that this
            // build can't read, so any local embed now is throwaway work (discarded the
            // moment the user updates Seek and hydrates the peer's index). Defer instead —
            // the file keeps its old chunks (queryable, stale-not-wrong) and the banner
            // tells the user to update. Mobile-only: desktop embedding isn't jetsam-bound
            // and a desktop is the fleet's heal path.
            const peerAheadDefer = this.p.mobile && (this.p.host.peerAhead ?? false);
            const deferEmbed = coldMobile || coldDesktopBulk || peerAheadDefer;
            if (!deferEmbed) await this.p.ensureModelLoaded();

            if (bulk) {
                // Mini-reindex path. One toast at the start, one summary at the end
                // — no live-updating sticky Notice (progress is watchable from the
                // settings Index status card; deferred embeds have nothing to show).
                // A live query preempts the embed (shouldContinue → break within one
                // file, releasing the write mutex so the query runs); the interrupted
                // or deferred remainder keeps its old searchable chunks and stays
                // dirty (no file-record advance) for the drain to reconcile.
                if (!deferEmbed) this.p.notify(`Seek: indexing ${dirty.length} changed notes…`, 4000);
                const result = await orchestrator.reindexDelta(dirty, deleted, {
                    embed: !deferEmbed,
                    shouldContinue: () => !this.indexingBlocked,
                });
                // Summary counts what actually committed — an embed preempted by a
                // query reports the partial total honestly; the drain finishes the
                // rest silently. No toast on throw (flushDirty's catch logs it).
                if (!deferEmbed && result.embedded) {
                    this.p.notify(`Seek: indexed ${result.embedded.committedFilePaths.length} files · ${result.embedded.chunksIndexed} chunks`, 5000);
                }
                // Reconcile whatever the embed left undone (deferred cold, or
                // preempted by a query). runCatchUp is self-guarding (no-op while
                // searching / hidden / model cold) and computeDelta-idempotent — a
                // fully-completed pass just costs one empty diff.
                this.catchUpPending = true;
                this.runCatchUp();
            } else {
                // Single-note fast path. Still preempt on a live OR in-flight query
                // so a just-edited note can't force a main-thread embed mid-search —
                // the foreground query must win the shared iOS thread (the note's
                // "indexing must wait for the query"). A preempted (or cold-deferred)
                // note keeps its old chunks, doesn't advance its file record, and so
                // stays dirty + pending for runCatchUp, which fires the moment the
                // query completes (onQueryInFlight(false)) — computeDelta re-finds it.
                await orchestrator.reindexDelta(dirty, deleted, {
                    embed: !deferEmbed,
                    shouldContinue: () => !this.indexingBlocked,
                });
                if ((deferEmbed || this.indexingBlocked) && dirty.length > 0) this.catchUpPending = true;
                this.runCatchUp();
            }

            // Clear exactly what we snapshotted — but only dirty paths NOT re-edited
            // mid-flush (mtime unchanged since the snapshot). A re-enqueued path
            // stays for the next flush instead of being clobbered; new paths queued
            // during the await were never in `dirty`. Deletes are unconditional.
            for (const p of deleted) this.deletedQueue.delete(p);
            for (const p of dirty) {
                const current = this.p.mtimeOf(p);
                if (current === dirtyMtimes.get(p)) this.dirtyQueue.delete(p);
            }
            // Restart the max-wait clock only if the queue actually emptied. A
            // partial drain (mobile deferEmbed, a query preemption, or a path
            // re-edited mid-flush) keeps its ORIGINAL deadline — otherwise every
            // partial flush would hand the remainder a fresh 15 minutes.
            if (this.dirtyQueue.size === 0) this.firstDirtyAt = 0;
        } catch (e) {
            await this.p.logger.appendError('flushDirty', e).catch(() => {});
        } finally {
            this.incrementalFiles = 0;
            this.p.popTaskContext('indexing');
            this.flushing = false;
        }
    }

    // fork 1.1.3 src/main.ts:1655 SeekPlugin.reconcileOnLoad
    // Startup mtime-diff sweep. Authoritative diff of the persisted index vs. the
    // live vault — catches external sync, edits made while disabled, and deletes
    // missed by a crash. Deletes/moves apply immediately (model-free). Edits are
    // DEFERRED on every platform: forcing a cold model load at startup would break
    // the lazy-load contract (don't spend ~250 MB if the user never searches), so
    // we set catchUpPending and let the first search's model load drive the embed
    // via runCatchUp. The live-session flush (flushDirty) is where the desktop
    // force applies, since the model is typically already warm by then.
    async reconcileOnLoad(): Promise<void> {
        if (!this.p.host) return;
        this.p.pushTaskContext('reconcile');
        try {
            const { dirty, deleted } = await this.p.host.computeDelta();
            if (dirty.length === 0 && deleted.length === 0) return;
            await this.p.host.reindexDelta(dirty, deleted, { embed: false });
            if (dirty.length > 0) this.catchUpPending = true;
        } catch (e) {
            await this.p.logger.appendError('reconcileOnLoad', e).catch(() => {});
        } finally {
            this.p.popTaskContext('reconcile');
        }
    }

    // fork 1.1.3 src/main.ts:1674 SeekPlugin.onSearchActivity
    // The modal reports its session lifecycle here: opening + each keystroke =
    // active (pauses the drain so a foreground embed never competes with the live
    // query on the shared iOS WebContent process); query-settled + modal-closed =
    // inactive, which is the trigger to drain. Gated/no-op when nothing's pending.
    onSearchActivity(active: boolean): void {
        this.searchActiveTimestamp = active ? Date.now() : null;
        // Session settled = a safe window. Drive both deferred drains: catch-up (embeds)
        // and drift recovery (embed-free). Each is a cheap no-op unless it has pending work.
        if (!active) { this.runCatchUp(); this.runDriftRecovery(); }
    }

    // fork 1.1.3 src/main.ts:1689 SeekPlugin.onQueryInFlight
    // Hard query-lifecycle signal: true the moment a query embed starts, false
    // when its results settle. The modal emits balanced edges (ref-counted
    // modal-side across the cold path); headless queries emit balanced pairs via
    // withQueryInFlight. Held in indexingBlocked so a preempted/deferred reindex
    // resumes only AFTER the query completes — the note's "make indexing wait for
    // the query". The last-caller-out edge is a drain trigger, exactly like
    // onSearchActivity(false). Max(0,·) self-heals an unbalanced false (e.g. a
    // torn-down modal's reset firing when nothing was counted).
    onQueryInFlight(inFlight: boolean): void {
        this.queryInFlightCount = Math.max(0, this.queryInFlightCount + (inFlight ? 1 : -1));
        // All queries complete = a safe window — same dual drive as onSearchActivity(false).
        if (this.queryInFlightCount === 0) { this.runCatchUp(); this.runDriftRecovery(); }
    }

    // fork 1.2.1 src/main.ts SeekPlugin.withQueryInFlight (born after 1.1.3, no tag line)
    // Run a headless query (CLI handler, deep-link open) under the same
    // query-in-flight gate the modal honors. Raising the flag makes a running
    // catch-up drain or bulk flush yield at its next batch boundary
    // (indexingBlocked → shouldContinue/isSearchActive), so the query's embed
    // isn't queued behind minutes of indexing — previously a CLI search on a
    // cold install waited out the entire initial drain. The finally edge
    // restarts whatever was preempted.
    async withQueryInFlight<T>(fn: () => Promise<T>): Promise<T> {
        this.onQueryInFlight(true);
        try {
            return await fn();
        } finally {
            this.onQueryInFlight(false);
        }
    }

    // fork 1.1.3 src/main.ts:1740 SeekPlugin.applyPeerAheadBanner
    // Translate the orchestrator's peer-ahead signal (a sidecar refused for being at a
    // NEWER chunkerVersion than this build) into the banner state. This is the MIRROR of
    // enforceIndexIdentity: there the LOCAL index is stale vs the local build; here the
    // local index matches the build, but a peer holds an index this build can't read, so
    // the honest fix is "update Seek", not "reindex". Called after every reconcile/hydrate.
    //
    // A real local problem ('version'/'drift') always wins — it's worse and more specific,
    // and it's what an actual reindex/update would clear first. We only own the otherwise-
    // healthy case, so we never stomp those reasons, and we only clear back to healthy a
    // banner WE set (degradedReason === 'peer-ahead').
    applyPeerAheadBanner(): void {
        const ahead = this.p.host.peerAhead ?? false;
        if (ahead) {
            if (this.degradedReason === 'version' || this.degradedReason === 'drift') return;
            this.indexHealth = 'degraded';
            this.degradedReason = 'peer-ahead';
            if (!this.peerAheadNotified) {
                this.peerAheadNotified = true;
                this.p.notify(INDEX_PEER_AHEAD_MSG, 8000); // brief, non-sticky — informational, not urgent
            }
        } else {
            this.peerAheadNotified = false;
            if (this.degradedReason === 'peer-ahead') { this.indexHealth = 'healthy'; this.degradedReason = null; }
        }
    }

    // fork 1.1.3 src/main.ts:1827 SeekPlugin.runCatchUp
    // Drain cold-mobile deferred embeds once a search session ends and the model is
    // warm. Runs the work in safety-bounded, self-chaining bursts (drainCatchUp) so
    // the foreground iOS embed can't saturate the shared process into a jetsam kill;
    // desktop runs one unbounded burst (no caps). Fire-and-forget; cheap no-op
    // unless something was deferred (catchUpPending) and we're in a safe window.
    runCatchUp(): void {
        void this.drainCatchUpCore();
    }

    // fork 1.2.1 src/main.ts SeekPlugin.drainCatchUpCore (born after 1.1.3, no tag line)
    // The awaitable core behind runCatchUp() (fire-and-forget) and the manual resume
    // (design B, awaited). Returns once the delta drains, or a guard / stop condition
    // (backgrounded, searching, model cold, peer-ahead, no forward progress) defers the
    // rest — `pending:true` means "a later trigger re-fires me". onProgress, when
    // present (manual resume), is MERGED into each burst's opts so reindexDelta streams
    // the live "Indexed N files" line to the settings tab; catchup.ts is untouched (it
    // just forwards the opts it's handed). The guards + single-flight make a no-op call
    // cheap, so fire-and-forget callers can spam it.
    async drainCatchUpCore(onProgress?: (msg: string) => void): Promise<{ pending: boolean }> {
        if (!this.catchUpPending || this.catchUpRunning || !this.p.embedderLoaded() || !this.p.host) return { pending: this.catchUpPending };
        if (this.p.hidden() || this.indexingBlocked) return { pending: this.catchUpPending };  // never start in a bad window (typing OR a query in flight)
        // Peer-ahead grind-stop: while a newer-version peer index exists, draining the
        // deferred backlog would re-embed (on the iOS main thread) chunks this build will
        // discard the moment it updates. Leave catchUpPending set so the drain resumes
        // automatically once the user updates Seek and peerAhead clears. (This is the exact
        // loop behind the 2026-06-28 mobile bog-down: v7 phone grinding against a v8 sidecar.)
        if (this.p.mobile && this.p.host.peerAhead) return { pending: this.catchUpPending };
        this.catchUpRunning = true;
        const orchestrator = this.p.host;
        const mobile = this.p.mobile;
        const pacer = this.p.newPacer();
        this.p.pushTaskContext('catchup');
        try {
            const { pending } = await drainCatchUp({
                // Tee the drain's own diff into the status-card counter. The drain
                // re-diffs between sweeps, so this tracks the REMAINING backlog
                // rather than freezing at the first count.
                computeDelta: async () => {
                    const delta = await orchestrator.computeDelta();
                    this.incrementalFiles = delta.dirty.length;
                    return delta;
                },
                reindexDelta: (d, del, opts) => orchestrator.reindexDelta(d, del, onProgress ? { ...opts, onProgress } : opts),
                isHidden: () => this.p.hidden(),
                isSearchActive: () => this.indexingBlocked,
                pace: () => pacer.pace(),
                maxFiles: mobile ? CATCHUP_MAX_FILES_PER_BURST : undefined,
                budgetMs: mobile ? CATCHUP_BURST_BUDGET_MS : undefined,
            });
            this.catchUpPending = pending;
            return { pending };
        } catch (e) {
            await this.p.logger.appendError('runCatchUp', e).catch(() => {});
            this.catchUpPending = true;  // unknown state — let a later trigger retry
            return { pending: true };
        } finally {
            this.incrementalFiles = 0;
            this.p.popTaskContext('catchup');
            this.catchUpRunning = false;
        }
    }

    // fork 1.2.1 src/main.ts SeekPlugin.pauseIndexing (born after 1.1.3, no tag line)
    // ── Design B: manual pause / resume of a full reindex ───────────────────────────
    // Flag the in-flight full pass to stop at its NEXT file boundary. A file already
    // embedding finishes and commits (nothing is torn mid-commit); everything committed
    // so far is durable + searchable, the rest stays dirty. No-op unless a full reindex
    // is actually running — a catch-up drain / delta is not user-pausable (it's already
    // bounded + self-resuming). The pass returns paused, and runFullReindex latches
    // `indexPaused`, which the settings tab renders as the Resume affordance.
    pauseIndexing(): void {
        if (!this.p.isIndexing()) return;
        this.indexPauseRequested = true;
    }

    // fork 1.2.1 src/main.ts SeekPlugin.resumeIndexing (born after 1.1.3, no tag line)
    // Resume a paused reindex by draining the remainder through the ordinary catch-up
    // path. computeDelta finds the un-embedded (record-less) files — PLUS anything the
    // user created / edited / renamed / deleted during the pause (it diffs stored
    // records against the live vault, not a session log) — and reindexDelta embeds ONLY
    // those; an unchanged committed file matches its stored content hash and is skipped,
    // never re-embedded. onProgress streams the "Indexed N files" line so the settings
    // tab can flip "Resuming…" → "Indexing…". Resolves once the remainder drains (or a
    // stop condition defers it — a background trigger then finishes it). No-op if nothing
    // is paused.
    async resumeIndexing(onProgress?: (msg: string) => void): Promise<void> {
        if (!this.indexPaused || !this.p.host) return;
        this.indexPaused = false;
        this.indexPauseRequested = false;
        await this.p.ensureModelLoaded();
        this.catchUpPending = true;
        const { pending } = await this.drainCatchUpCore(onProgress);
        // A resume that fully drained restored full coverage — mirror the completed
        // full-reindex path and clear any lingering degraded health. If it deferred
        // (pending), a later catch-up trigger finishes the tail; leave health as-is.
        if (!pending) {
            this.indexHealth = 'healthy';
            this.degradedReason = null;
        }
    }

    // fork 1.1.3 src/main.ts:1869 SeekPlugin.onPersistentDrift
    // Persistent-drift escalation from the orchestrator (onCoherenceDrift's re-trip
    // branch). Gen-keyed suppression: only escalate once per index generation, so a
    // degraded index re-tripping drift on every keystroke doesn't re-arm recovery — a
    // later mutation (delta/reindex/invalidate/hydrate) bumps the generation and
    // re-arms it for the new state. Sets pending + drives; the actual ladder runs on
    // the next safe edge (mirrors catch-up's pending/drive split).
    onPersistentDrift(): void {
        if (!this.p.host) return;
        const currentGen = this.p.host.currentGeneration();
        const { schedule } = driftRecoveryDecision({
            running: this.driftRecoveryRunning,
            health: this.indexHealth,
            lastRecoveryGen: this.lastDriftRecoveryGen,
            currentGen,
        });
        if (!schedule) return;
        this.lastDriftRecoveryGen = currentGen;
        this.driftRecoveryPending = true;
        this.runDriftRecovery();
    }

    // fork 1.1.3 src/main.ts:1892 SeekPlugin.runDriftRecovery
    // The embed-free recovery ladder, run in a gated, single-flighted scheduler (the
    // sibling of runCatchUp). Execution order is sidecar hydrate (reconcile the IDB
    // against the vault; tokenizer-only re-chunk, NO embed; null no-op when sidecar is
    // off) → warm (rebuild frame + BM25 from the reconciled IDB) → verify. NEVER reaches
    // reindexAll/embedAndCommitFiles/embedder.embed* — re-embedding is never the fix for
    // a row-space coupling bug. Unlike runCatchUp it does NOT require embedder.loaded
    // (the ladder is tokenizer-only). On exhaustion: indexHealth='degraded' +
    // console.error (NO Notice on this path), surfaced on the settings page.
    runDriftRecovery(): void {
        if (!this.driftRecoveryPending || this.driftRecoveryRunning || !this.p.host) return;
        if (this.p.hidden() || this.indexingBlocked) return;  // never start in a bad window (typing OR a query in flight)
        this.driftRecoveryRunning = true;
        this.indexHealth = 'recovering';
        const orchestrator = this.p.host;
        void (async () => {
            // The generation verifyCoherent actually evaluated; -1 until we reach verify.
            // A user-initiated full reindex (and any delta) runs OFF this ladder's write
            // mutex — warmCaches/verifyCoherent read the store un-serialized — so it can
            // land mid-verify, advancing the generation and OWNING the index's outcome.
            // We therefore commit our verdict + suppression key only when that generation
            // is still live (optimistic concurrency, mirroring ensureFrame's F2
            // shouldDiscardPartialFrame discard). If a mutation raced us it is
            // authoritative — its reindex left a coherent 'healthy' index, or its delta
            // re-armed a fresh drift trip — so a stale 'degraded' here would wrongly stick.
            let verifiedGen = -1;
            try {
                // Step 1 — sidecar hydrate: reconcile IDB against the live vault
                // (embed-free; null no-op when sidecar off), which itself re-warms on a
                // >0 hydrate. On the write mutex, so it can't overlap a reindex's store.close().
                await orchestrator.hydrateSidecar();
                // Step 2 — warm: co-rebuild frame + BM25 from one (reconciled) IDB
                // snapshot, fixing the transient row-space desync (on cold mobile
                // warmCaches no-ops, but the verify below rebuilds via ensureFrame/ensureBm25).
                await orchestrator.warmCaches('drift-recovery');
                // Verify the rebuild actually re-coupled the row spaces.
                verifiedGen = orchestrator.currentGeneration();
                const ok = await orchestrator.verifyCoherent();
                if (orchestrator.currentGeneration() !== verifiedGen) {
                    // Raced: a reindex/delta landed off our mutex during verify and owns
                    // the outcome. Leave health 'recovering' (invisible in settings) and
                    // the escalation suppression key untouched, so the new generation
                    // re-arms recovery on the next drift trip.
                } else {
                    this.commitDriftHealth(ok ? 'healthy' : 'degraded', verifiedGen);
                    if (ok) {
                        /* intentionally empty: the re-couple succeeded and is already committed as 'healthy' above — nothing further to do */
                    } else {
                        console.error('[seek] drift auto-recovery exhausted (embed-free warm + sidecar reconcile did not re-couple the frame/BM25 row space) — indexHealth=degraded; a full reindex recovers it');
                    }
                }
            } catch (e) {
                // verifyCoherent's IDB read throws if a concurrent reindex closed the
                // store mid-read. Degrade only on a GENUINE failure; if a writer raced us
                // (the generation advanced), defer — it owns the outcome, and a reindex's
                // own completion re-clears health, so a stale 'degraded' can't stick.
                if (verifiedGen < 0) {
                    // Threw before verify (e.g. a hydrate failure) — a real recovery error.
                    this.commitDriftHealth('degraded', orchestrator.currentGeneration());
                    await this.p.logger.appendError('runDriftRecovery', e).catch(() => {});
                } else if (orchestrator.currentGeneration() === verifiedGen) {
                    // Verify threw with the generation unchanged — a real failure
                    // (corrupt store, not a concurrent writer).
                    this.commitDriftHealth('degraded', verifiedGen);
                    await this.p.logger.appendError('runDriftRecovery', e).catch(() => {});
                } else {
                    // The generation advanced: a concurrent reindex/delta closed the store
                    // mid-verify and owns the outcome. Expected under the race — defer, and
                    // don't log it as an error (it isn't one).
                }
            } finally {
                this.driftRecoveryPending = false;
                this.driftRecoveryRunning = false;
            }
        })();
    }

    // fork 1.1.3 src/main.ts:1965 SeekPlugin.commitDriftHealth
    // Commit a terminal drift-recovery verdict: set indexHealth AND re-baseline the
    // suppression key to the SAME generation the verdict describes. Coupling them keeps
    // the two from disagreeing — re-reading currentGeneration() in a finally (as an
    // earlier cut did) could pin suppression to a later, UN-verified generation (a delta
    // that raced verify), hiding the degraded affordance for a state we never checked.
    commitDriftHealth(health: 'healthy' | 'degraded', gen: number): void {
        this.indexHealth = health;
        // Tag the cause so the modal banner stays truthful: a drift degradation must not
        // wear the version-stale copy (INDEX_STALE_MSG). 'healthy' clears it. NOTE: if the
        // index was version-stale when drift recovery ran, this overwrites/clears the
        // 'version' reason — but that's self-correcting: the next periodicReconcile re-runs
        // enforceIndexIdentity, re-detects the still-mismatched identity, and re-sets
        // degradedReason='version' (no duplicate toast — identityHealNotified stays latched).
        this.degradedReason = health === 'degraded' ? 'drift' : null;
        this.lastDriftRecoveryGen = gen;
    }

    // fork 1.1.3 new; relates to src/main.ts:1490 SeekPlugin.enqueueIfDirty (takes path + mtime; the plugin's TFile and extension check stay in main.ts)
    async enqueueIfDirty(path: string, mtime: number): Promise<void> {
        try {
            const stored = await this.p.store.getFileRecord(path);
            if (!stored || mtime > stored.mtimeMs) {
                this.dirtyQueue.add(path);
                this.scheduleFlush();
            }
        } catch (e) {
            await this.p.logger.appendError('enqueueIfDirty', e).catch(() => {});
        }
    }
}
