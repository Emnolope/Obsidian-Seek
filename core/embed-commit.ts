// The write path of indexing: chunk each dirty file, embed in per-bucket rolling batches, commit atomically per file, then stamp meta/identity and package the
// sidecar flush. It is the same algorithm wherever it runs; everything that touches a runtime (IndexedDB, the embedder device, forensics, Obsidian's vault,
// the sidecar files, UI notices) arrives through EmbedCommitCtx, so a different host can drive the identical pass.
import type { Chunk, ChunkMeta, IndexCompleteEntry, MemorySnapshot } from './types.ts';
import { snapshotMemory, memoryDelta, distributionStats } from './types.ts';
import { EMBEDDING_DIM } from './contract.ts';
import { cyrb53Hex } from './chunker.ts';
import { enforceTokenBudget, embedInput, type TokenBudgetResult } from './token-budget.ts';
import { quantizeInt8, type QuantVec } from './quant.ts';
import { packSignBits } from './binary.ts';
import { VecReservoir, denseBgStats, BG_RESERVOIR, MIN_BG_SAMPLE } from './dense-stats.ts';
import type { TierBytes } from './format.ts';
import type { LiveFile } from './delta.ts';
import { isStoreClosedError, isQuotaError, META_SCHEMA_VERSION, shouldStampLiveIdentity, type FileRecord, type MetaConfig, type IndexIdentity } from './index-types.ts';
import { pushDeltaAdds, type DeltaAdd } from './search-helpers.ts';
import { planFileDiff, captureRemovalBodies, type DiffStore } from './file-diff.ts';

// fork 1.1.3 src/search.ts:80 ROLLING_BUDGET
// Indexing batches via PER-BUCKET ROLLING BUFFERS (2026-06-03 redesign).
//
// The problem: naive within-file batching ran an effective batch of ~2.2
// (chunks-per-file p50=1 / p95=6) AND padded every batch to its longest
// member's seq bucket. The offline padding sim measured this at 45% efficient
// — over half of all forward compute was padding.
//
// The fix: route each chunk into a buffer keyed by ITS OWN seq bucket
// (selectIndexBucket on the chunk's EXACT token count — WS2.3 replaced the
// chars/4.5 estimate, which under-bucketed dense text and silently truncated
// below the cap), and flush a buffer the instant it reaches its per-bucket
// size (rollingBatchFor), carrying the remainder across files. Because a buffer's chunks share
// a bucket, the dispatch pads to exactly that bucket (zero cross-length waste),
// and because the flush size is FIXED and warmed, the (batch×seq) shape set
// stays inside WARMUP_BATCH_SIZES — the precondition the reverted arbitrary-
// coalescer violated (it packed groups to 7/17/22… → SafeInt overflow). Sim:
// 45%→85% efficiency, −47% forward work, dispatches 1865→~520.
//
// Smoothness: the flush size is the stutter knob, not the pacer. A dispatch is
// non-preemptible once on Metal's queue, so the worst-case stall = the largest
// dispatch's forward time. ModernBERT's global-attention layers are ~O(seq²),
// so a full batch in the 512 bucket is the longest stall by far (measured p95
// 587 ms at a flat batch of 8, 2026-06-04). So we DON'T use a flat size — we
// hold batch×seq roughly constant at a token BUDGET: big buckets flush at a
// small batch (512→3), small buckets at the cap (8). This caps the worst stall
// while leaving the cheap short-bucket dispatches full. Per-chunk compute is
// unchanged (each chunk is one independent sequence); we trade a few extra
// dispatches in the rare long buckets for shorter individual stalls. pace()
// still runs between every flush, so duty cycle stays idle-gated.
//
// ROLLING_BUDGET ≈ target batch×seq per dispatch. 1536 → {512:3, 384:4, 256:6,
// ≤192:8}. Every resulting size is in WARMUP_BATCH_SIZES [1..8]. ROLLING_MAX is
// the warmed ceiling (also mobile's thermal-friendly flush size). Lower the
// budget to cut the p95 further (more dispatches); raise it for throughput.
export const ROLLING_BUDGET = 512;
// fork 1.1.3 src/search.ts:81 ROLLING_MAX
export const ROLLING_MAX = 8;
// fork 1.1.3 src/search.ts:90 rollingBatchFor
// WASM batch experiment CLOSED (2026-06-11): a flat batch of 4 on the CPU EP
// measured a WASH against this token-budget sizing (3.60 vs 3.83 files/s on
// the same 365-file steady segment, iPhone 15 Pro) — per-call overhead is not
// the bottleneck, and neither is padding (exact-length cut padded tokens 13%
// at identical wall time; see iframe embedBatch). Single-thread CPU forward
// is at a floor only threads (COOP/COEP, Obsidian-core) would move. Reverted
// to one shared sizing: on wasm the budget also caps the synchronous
// main-thread stall per dispatch, which batch=4 made ~4× worse for nothing.
export function rollingBatchFor(bucket: number): number {
    return Math.max(1, Math.min(ROLLING_MAX, Math.round(ROLLING_BUDGET / bucket)));
}

// fork 1.1.3 src/search.ts:95 PROGRESS_EVERY
// How often to emit a progress entry during indexing (every N committed files).
export const PROGRESS_EVERY = 25;
// fork 1.1.3 src/search.ts:99 PROGRESS_MAX_SILENCE_MS
// Time floor for the progress cadence: never let the counter sit silent
// longer than this while files are committing (see the cadence comment at
// the emit site — two healthy iPhone WASM runs were force-quit as "stalled").
export const PROGRESS_MAX_SILENCE_MS = 2500;

// fork 1.1.3 src/search.ts:109 FULL_PREEMPT_POLL_MS
// Full-reindex soft preempt: while the user is typing in the search modal or a
// query embed is in flight (budget.shouldContinue → false), a FULL pass pauses
// between files instead of competing for the iframe/GPU — then resumes; it never
// aborts (a full reindex must finish; the incremental path is the one that breaks
// and defers to catch-up). Poll cadence is coarse on purpose — the wait itself
// holds no resources, and 250 ms is well under a typing session's decay window.
// The per-episode cap is a wedge guard only: searchActive self-heals after 60 s
// (SEARCH_ACTIVE_MAX_AGE_MS), so the cap should never bind in a healthy session.
export const FULL_PREEMPT_POLL_MS = 250;
// fork 1.1.3 src/search.ts:110 FULL_PREEMPT_MAX_WAIT_MS
export const FULL_PREEMPT_MAX_WAIT_MS = 2 * 60_000;
// fork 1.1.3 src/search.ts:118 FULL_PREEMPT_WEDGE_EPISODES
// Consecutive episode-cap expiries (with the signal never once observed true)
// before the pass treats the preempt signal as wedged and stops pausing. One
// expiry can be a genuinely busy user refreshing searchActive; three in a row
// (6 min, zero true observations) cannot — searchActive self-heals at 60 s, so
// only a leaked query-in-flight count holds the signal false that long. Without
// this, "give up after 2 min" is per FILE, not per pass: a wedged signal turns
// a large full reindex into hours while holding the write mutex.
export const FULL_PREEMPT_WEDGE_EPISODES = 3;

// fork 1.1.3 src/search.ts:213 SidecarFlushJob
// 1C: an index pass's deferred sidecar flush. embedAndCommitFiles always runs
// inside the write mutex; instead of flushing the sidecar there (pure file IO the
// IDB index never depends on), it packages everything the flush needs and the
// pass runs it via flushSidecarAfterPass once the mutex has released. All fields
// are captured in the critical section, so the flush writes exactly what the
// pass indexed regardless of when the job actually runs.
export interface SidecarFlushJob {
    pending: Array<{ id: string; tiers: TierBytes; mtime: number }>;
    mode: 'full' | 'incremental';
    bgMean: number | undefined;
    bgStd: number | undefined;
    identity: IndexIdentity;
}

// What a host must provide to run the pass. Sub-ports list only what the pass actually calls.
export interface EmbedCommitCtx<H> {
    store: DiffStore & {
        deleteFile(path: string): Promise<string[]>;
        putBatchQuantized(chunks: Chunk[], tiers: { q: QuantVec; bin: Uint8Array }[], fileRecord?: FileRecord): Promise<void>;
        getMeta(): Promise<MetaConfig>;
        setMeta(meta: MetaConfig): Promise<void>;
    };
    embedder: {
        readonly device: string;
        readonly glue: string | null;
        readonly dtype: IndexCompleteEntry['dtype'];
        readonly modelId: string;
        embedBatch(texts: string[], bucket?: number): Promise<{ vectors: Float32Array[]; iframeLatencyMs: number }>;
        recycle(): Promise<void>;
        tokenCounts(texts: string[]): Promise<number[]>;
    };
    logger: { appendError(context: string, e: unknown): Promise<void>; append(entry: IndexCompleteEntry): Promise<void> };
    forensics: { beat(type: string, detail?: Record<string, unknown>): void } | null;
    coord: { sidecarOn(): boolean };
    // A live flag, read repeatedly inside loops (the plugin may unload mid-pass), so hosts must supply a getter.
    readonly disposed: boolean;
    pluginVersion: string;
    read(file: LiveFile<H>): Promise<string>;
    chunksFor(content: string, path: string, modifiedIso: string | null): Chunk[];
    // Compositor-pressure pacing between embed dispatches; a host with no UI can return a no-op.
    newPacer(): { pace(): Promise<void> };
    selectBucket(tokenCount: number): number;
    identity(): IndexIdentity;
    // Wipes this device's sidecar files so a full run REPLACES them (preserving the seq floor).
    clearSidecarDevice(): Promise<void>;
    reapDeadIdentitySidecars(): Promise<number>;
    quarantineUnreadable(path: string): void;
    quotaToast(): void;
    invalidateBm25Cache(): void;
    emitProgress(phase: 'embed' | 'commit' | string, filesSeen: number, filesTotal: number, chunksEmitted: number, elapsedMs: number): Promise<void>;
}

// fork 1.1.3 src/search.ts:578 SearchOrchestrator.embedAndCommitFiles
// The shared embed + commit engine behind both reindexAll (whole vault, after
// nuke) and reindexDelta (just the changed files, after their stale chunks are
// dropped). Per-bucket rolling-buffer batching, atomic per-file commit, the
// ORT-Web WebGPU overflow recycle+retry, and the throughput rollups all live
// here. Mode-dependent behavior is minimal: the post-index WebGPU pool reclaim
// runs for 'full' only (a small delta never grows the pool to the high-water
// mark, and a 2–4 s teardown per blur-flush would be absurd), and `mode` tags
// the log entry. `files` is expected pre-sorted recency-first by the caller so
// the index stays queryable as it fills.
export async function embedAndCommit<H>(
    ctx: EmbedCommitCtx<H>,
    files: LiveFile<H>[],
    mode: 'full' | 'incremental',
    onProgress: ((msg: string) => void) | undefined,
    overallStart: number,
    memBefore: MemorySnapshot,
    // Per-burst budget. budgetMs applies ONLY in 'incremental' mode (a full
    // reindex is never time-bounded). The per-burst FILE cap is enforced by the
    // caller (reindexDelta slices its dirty list), so the engine only needs the
    // within-burst aborts: budgetMs = wall-clock ceiling for one pathological
    // huge note; shouldContinue = the live user-activity signal (false while the
    // app is hidden / a search is live). Mode decides what shouldContinue MEANS:
    // 'incremental' ABORTS the burst (files stay dirty; catch-up re-fires later),
    // 'full' PAUSES between files and resumes when the activity clears — a full
    // pass must finish, so it yields the iframe/GPU without giving up (3A).
    // All optional; an empty object = unbounded (the existing behavior).
    // addsSink (Seek scaling A1): when present, commitFile pushes each
    // ACTUALLY-committed chunk's {chunk, q, bin} into it — the add half of the
    // change-set reindexDelta's incremental cache path consumes. Driven off
    // real commits (not the pre-embed file list), so a mid-burst abort yields
    // exactly the rows that landed in IDB. Absent for a full reindex (it
    // rebuilds caches from scratch).
    // storeWasEmpty: the caller's PASS-START emptiness snapshot (reindexDelta
    // captures it before phase-1 + hydration). The engine must NOT re-derive it
    // here: by the time it runs, carry-over + sidecar dedup may have already
    // committed chunks, so a fresh count() would read non-empty on a cold build
    // that hydrated some files and mis-decide sawWholeCorpus. One snapshot, one
    // source. Omitted (reindexAll) = false, harmless since mode==='full' dominates.
    // isPaused (design B, full mode only): the user hit Pause. Polled at
    // loop-top; when true the pass breaks out — committing everything already
    // started, leaving the un-started files record-less (dirty) for the resume
    // catch-up — and returns with the store OPEN (unlike the disposed break) so
    // the tail runs and the write mutex releases. Ignored in incremental mode.
    // removedSink / removedBodiesSink / metaPatchSink (chunk-diff commit,
    // issue #5): present only on the incremental delta path. Their presence
    // ENABLES the per-file diff-against-record (the delta's pre-delete is
    // gone — the engine now owns stale-row deletion), and they surface the
    // applied removals (ids + reconstruction bodies) and in-place metadata
    // patches for applyDelta, exactly like addsSink surfaces the commits.
    budget: {
        budgetMs?: number; shouldContinue?: () => boolean; addsSink?: DeltaAdd[]; storeWasEmpty?: boolean;
        isPaused?: () => boolean;
        removedSink?: string[]; removedBodiesSink?: Map<string, string>;
        metaPatchSink?: Array<{ id: string; meta: ChunkMeta }>;
    } = {},
): Promise<{ entry: IndexCompleteEntry; sidecarJob: SidecarFlushJob | null; quarantineUnwound: number }> {
    // Per-bucket rolling-buffer embed. Each chunk lands in the buffer for
    // its own seq bucket; a buffer flushes as one warmed per-bucket-sized
    // dispatch the instant it fills, carrying the remainder across files.
    // Files commit atomically once their last chunk's vector lands. See the
    // ROLLING_BUDGET comment above for the why (45%→85% padding efficiency,
    // overflow-safe warmed shapes, budgeted per-bucket flush to cap stalls).
    let totalChunks = 0;
    // Chunks reconciled WITHOUT embedding (chunk-diff, issue #5): id-stable
    // rows a diff kept (untouched / meta-patch / reindex-row). A pure
    // metadata pass commits files with totalChunks 0 — a legitimate success
    // the pass gate below must not read as "no chunks produced".
    let chunksReconciled = 0;
    let totalVectors = 0;
    let chunkMs = 0;
    let embedMs = 0;
    let paceWaitMs = 0;   // cumulative pacer waits between dispatches (v16, issue #5)
    let commitMs = 0;
    let filesSkippedError = 0;
    let filesSkippedQuota = 0;   // subset of filesSkippedError: commit hit QuotaExceededError (disk full)
    let preemptWaitMs = 0;       // full-mode only: total time paused for live search activity (3A)
    let preemptExpiries = 0;     // consecutive episode-cap expiries with the signal never true
    let preemptWedged = false;   // signal judged stuck-false — no more pauses this pass
    let embedRecycles = 0;
    let filesCommitted = 0;
    let pausedOut = false;   // full-mode only: the user paused and we broke the loop early (design B)
    // The paths whose file-record was ACTUALLY written (commitFile succeeded) — NOT
    // the same as the prefix of started files: an empty/below-min-chunk note or a
    // mid-list skip-error commits nothing yet still advances processedFiles, so a
    // count-based prefix over-reports. The catch-up drain shrinks its remainder by
    // exactly this set, so an un-committed file stays dirty and is retried (never
    // dropped from the work-list to spin the outer sweep). See reindexDelta.
    const committedFilePaths: string[] = [];
    let processedFiles = 0;   // files we STARTED (for the incremental burst budget + filesDeferred)
    let lastProgress = 0;
    let lastProgressAt = performance.now();
    let tokenBudgetSplits = 0;
    let tokenBudgetOverBudget = 0;
    // Embed-failure quarantine accounting (issue #4): files committed WITH a
    // failure marker (some chunks missing) and the total chunks they lost.
    // `quarantined` remembers each marker written this pass so the pass-end
    // mass-failure gate can UNWIND them: solo-retry evidence can't tell a
    // poisoned chunk from a wedged environment (device-lost storm, app
    // backgrounded mid-pass) — both retries share the same environment. The
    // discriminator is volume: deterministic content failures are rare by
    // nature (issue #4 = one file), an environmental storm hits every
    // in-flight file at once.
    let filesQuarantined = 0;
    let chunksFailedEmbed = 0;
    const quarantined: Array<{ path: string; kept: number }> = [];
    // Check lines minted before the `checks` array exists (the mass-unwind
    // runs right after the bucket drain); spliced into `checks` at build.
    const checksExtra: string[] = [];
    // Fix A (cold first-build identity + background): whether the store was EMPTY
    // before this pass committed anything, from the caller's pass-start snapshot
    // (see the `budget.storeWasEmpty` comment). A truly-empty store means every
    // chunk this pass writes is built by the CURRENT identity AND this single
    // incremental pass sees the WHOLE corpus — so it is functionally a full build.
    // `sawWholeCorpus` below lets it stamp the live identity and compute the
    // dense-cosine background, instead of copying prevMeta's absent fields as
    // `undefined` (the identity gate reads that as stale and "heals" with a spurious
    // full reindex). A NON-empty store with no identity is a LEGACY index (older
    // chunker/model): it must stay stale so the gate rebuilds it, so we gate
    // strictly on emptiness, never on "prevMeta lacks identity".
    const storeWasEmpty = budget.storeWasEmpty ?? false;
    // Corpus dense-cosine background accumulators (dense-stats.ts). Only a
    // FULL pass sees every vector, so only it produces stats; an incremental
    // pass leaves these at zero and carries the prior values forward at
    // setMeta below. bgSum is the running Σ vᵢ (→ exact closed-form μ);
    // reservoir is a uniform sample of vectors for the σ estimate.
    const bgSum = new Float64Array(EMBEDDING_DIM);
    let bgN = 0;
    const reservoir = new VecReservoir(BG_RESERVOIR);
    // Sidecar accumulator: derived (int8 + sign-bit) tiers for every committed
    // chunk, packaged after the embed loop into ONE SidecarFlushJob the caller
    // bulkAppends off the mutex (1C). bulkAppend is
    // append-only (1A: each flush = fresh shard file(s), no rewrite), so the
    // batching here is about shard-count hygiene — one shard per pass instead
    // of one tiny shard per file. A FULL reindex first drops this device's own
    // sidecar files (clearDevice) so the run REPLACES them rather than
    // doubling; an INCREMENTAL delta legitimately appends without clearing, so
    // superseded/deleted records accumulate in this device's jsonl/shards
    // until compactOwnSidecar (once per session) or the next full reindex
    // reclaims them. The growth is bounded and read-safe: hydrate re-chunks
    // the live vault and intersects ids (sidecar-sync), so stale records
    // never resolve — they only cost disk until reclaimed.
    const sidecarPending: Array<{ id: string; tiers: TierBytes; mtime: number }> = [];
    if (ctx.coord.sidecarOn() && mode === 'full') {
        try {
            // preserveSeqFloor: the rebuild's flushes must allocate ABOVE every
            // shard deleted here — a peer may still hold the old files, and a
            // republished embeddings.<dev>.N.bin with different bytes lets it
            // resolve fresh jsonl refs against stale bytes (sidecar.ts).
            await ctx.clearSidecarDevice();
        } catch (e) {
            await ctx.logger.appendError('sidecar-clear', e);
        }
        // Reap OTHER devices' dead-identity sidecar files (identity ≠ this build).
        // Provably useless — the same metaAccepts gate that refuses them for
        // hydration means no current-version device can use them — so this is
        // sync-safe; an un-updated device simply re-creates its own files until it
        // updates (self-resolving). Stops fleet-wide version drift from piling up.
        // Best-effort: never fail the reindex on a reap error.
        try {
            await ctx.reapDeadIdentitySidecars();
        } catch (e) {
            await ctx.logger.appendError('sidecar-reap', e);
        }
    }
    // Forensic dispatch accounting. iOS exposes no heap numbers, so the
    // memory-ceiling hypothesis is tested by CORRELATION instead: every
    // breadcrumb carries cumulative dispatches + padded tokens (batch ×
    // seq-bucket — the real GPU working-set driver, padding included). If
    // repeated deaths cluster at similar cumulative volume, that's the
    // ceiling; deaths at random volume but always hidden are background
    // kills.
    let fDispatches = 0;
    let fPaddedTokens = 0;
    ctx.forensics?.beat('index-start', { mode, filesTotal: files.length });

    const perFileWallMs: number[] = [];
    const chunksPerFile: number[] = [];
    const embedBatchLatencyMs: number[] = [];

    // A file in flight: its chunks scatter across bucket buffers and resolve
    // as those buffers flush. `remaining` counts unresolved chunks; the file
    // commits (or is skipped, if any chunk errored) the moment it hits 0.
    interface FileState {
        file: (typeof files)[number];
        chunks: Chunk[];
        vectors: (Float32Array | null)[];
        remaining: number;
        hadError: boolean;
        fileStart: number;
        // mtime snapshotted at READ time (not commit time). The file commits
        // many ms later, after its chunks round-trip the embedder; reading
        // file.mtime at commit would record whatever the file's mtime is
        // THEN, which — if the user edited the file mid-index — is newer than
        // the content we actually embedded. computeDelta compares stored mtime
        // to live mtime, so an over-stamped record makes the next delta think
        // the edit is already indexed and silently skips it. Pin the value
        // observed when we read the bytes. (TOCTOU, search.ts read↔commit.)
        mtimeMs: number;
        // cyrb53 of the bytes we read — stored in the file-record so the next
        // computeDelta can tell a real edit from a mtime-only re-stamp.
        contentHash: string;
        // Chunk-diff commit (issue #5): when a diff plan ran, `chunks` holds
        // only the ids that need EMBEDDING, while the file-record must list
        // every live chunk. allChunkIds = the full post-budget id list in
        // document order; keepIds = the id-stable subset whose rows stayed in
        // IDB. commitFile writes record ids = allChunkIds ∩ (keepIds ∪
        // committed) so a failed embed still drops out of the record exactly
        // as it does on the no-diff path.
        allChunkIds?: string[];
        keepIds?: Set<string>;
    }
    // A chunk waiting in a bucket buffer: where to write its vector back.
    // tokens = the chunk's exact token count (from enforceTokenBudget) —
    // on wasm the dispatch pads to the batch max, so the honest
    // paddedTokens forensics counter needs the real lengths.
    interface Pending { fs: FileState; slot: number; input: string; tokens: number; }

    // bucket → chunks awaiting a flush. Created lazily on first use.
    const buffers = new Map<number, Pending[]>();

    // One pacer for the whole run so its idle-slice budget carries across
    // dispatches: consecutive fast flushes can share a single idle window
    // instead of each paying a full yield (pacer.ts / PR #1).
    const pacer = ctx.newPacer();

    // Forensics suffix for embed-failure log contexts: enough to separate a
    // content-shaped failure (which token counts?) from an environment one
    // (which device/glue?) straight from a report — issue #4's log had
    // neither and the triage stalled on it. Counts only, never chunk text
    // (reports are shared). Goes in the CONTEXT, not the message: appendError
    // dedups on message, so a varying suffix here can't fragment the dedup key.
    const dispatchInfo = (inputs: string[], bucket: number, tokens?: number[]): string => {
        const glue = ctx.embedder.glue;
        return ` n=${inputs.length} bucket=${bucket} dev=${ctx.embedder.device}${glue ? `/${glue}` : ''}`
            + (tokens && tokens.length === inputs.length ? ` tok=[${tokens.join(',')}]` : '')
            + ` chars=[${inputs.map(t => t.length).join(',')}]`;
    };

    // Embed one warmed batch (≤ ROLLING_MAX inputs that all share a seq
    // bucket), pace after the dispatch, and recover from the ORT-Web WebGPU
    // SafeInt overflow via recycle+retry. The session poisons itself once
    // its int32 buffer accounting overflows (~2200 granite chunks, 2026-06-03
    // diagnosis); a failed dispatch is the signal to recycle (fresh device
    // resets the counter) and retry once. A second failure throws to the
    // caller. Mutates embedRecycles + embedBatchLatencyMs.
    const embedOneBatch = async (inputs: string[], bucket: number, label: string, tokens?: number[]): Promise<Float32Array[]> => {
        // Breadcrumb BEFORE the dispatch (synchronous): if this dispatch
        // kills the process, the ring's last entry says exactly which
        // batch shape died and at what cumulative volume.
        fDispatches++;
        // wasm pads to the batch max (exact-length mode, iframe embedBatch),
        // not the bucket — count what the forward pass actually sees.
        fPaddedTokens += (ctx.embedder.device === 'wasm' && tokens?.length === inputs.length)
            ? Math.max(...tokens) * inputs.length
            : bucket * inputs.length;
        ctx.forensics?.beat('index-flush', {
            bucket, n: inputs.length, dispatches: fDispatches,
            paddedTokens: fPaddedTokens, filesCommitted, chunks: totalChunks,
        });
        let result;
        try {
            result = await ctx.embedder.embedBatch(inputs, bucket);
        } catch (e) {
            // Intentional teardown (onunload → embedder.teardown → dispose)
            // rejects the in-flight RPC tagged 'DISPOSED'. Recycling on that
            // would rebuild a fresh iframe + reload ~250 MB into an already-
            // unloaded plugin (zombie iframe; on dev hot-reload it stacks every
            // cycle). Unwind instead. Recoverable errors (SafeInt overflow,
            // 'TIMEOUT', device-lost) fall through to recycle+retry below.
            if ((e as { code?: string } | null)?.code === 'DISPOSED') throw e;
            await ctx.logger.appendError(`embedBatch-recycle:${label}${dispatchInfo(inputs, bucket, tokens)}`, e);
            await ctx.embedder.recycle();
            embedRecycles++;
            result = await ctx.embedder.embedBatch(inputs, bucket);
        }
        embedBatchLatencyMs.push(result.iframeLatencyMs);
        // Pace against compositor pressure between dispatches — the rIC yield
        // keeps duty cycle capped (see "Seek System Bog-Down Diagnosis.md"
        // §PR #1). Degrades to setTimeout(0) on iOS (no rIC); takes the cheap
        // yield when hidden (no compositor — pacer.ts, issue #5). The wait is
        // timed into paceWaitMs so a pacing inversion (compute dwarfed by
        // pace waits) is visible in the field instead of hiding in embed time.
        const paceStart = performance.now();
        await pacer.pace();
        paceWaitMs += performance.now() - paceStart;
        return result.vectors;
    };

    // Atomic per-file commit: chunks + vectors + file-record in ONE IndexedDB
    // transaction (S1) — a mid-commit kill lands either the whole file or
    // nothing, so commits can no longer strand record-less chunks (the orphan
    // class sweepOrphanChunks repairs; hydrate remains its only live producer).
    // putBatchQuantized asserts chunks.length === tiers.length, so a
    // mis-counted distribution throws here rather than corrupting the index.
    //
    // Embed-failure quarantine (issue #4): a file with hadError commits the
    // chunks that DID embed, and its file-record carries the failure marker
    // (embedFailedChunks + the plugin version — see FileRecord). The old
    // behavior (skip the whole file, no record) left the file dirty for every
    // computeDelta, so a DETERMINISTICALLY-failing chunk re-ran the full
    // recycle cascade (two iframe teardowns + model reloads) on every
    // reconcile poll and catch-up drain, and wedged reconcileIdentityInPlace
    // in 'drained' so the identity never stamped. The marker pins the file
    // 'clean' until an edit / release bump / full reindex / peer hydrate;
    // the missing chunk is invisible-not-wrong (content-addressed ids), and
    // the healthy chunks stay searchable instead of vanishing with it.
    const commitFile = async (fs: FileState): Promise<void> => {
        const commitStart = performance.now();
        const failed = fs.hadError ? fs.vectors.reduce((n, v) => n + (v === null ? 1 : 0), 0) : 0;
        const chunks = failed === 0 ? fs.chunks : fs.chunks.filter((_, i) => fs.vectors[i] !== null);
        // Derive both tiers ONCE from the fp32 vectors: int8 rerank (QuantVec)
        // + sign-bit candidate (packed from TRUE fp32 — the fidelity invariant
        // putBatch documents). Feed IDB via putBatchQuantized so the bytes IDB
        // holds and the bytes the sidecar persists are bit-identical (no double
        // quantization, no fp32→int8 drift between the two stores).
        const fp32 = failed === 0 ? fs.vectors as Float32Array[]
            : fs.vectors.filter((v): v is Float32Array => v !== null);
        // Feed the corpus background accumulators from the committed (known-
        // good) fp32 — the index holds exactly these vectors. Cost: 384 adds
        // + a bounded reservoir insert per vector. Only consumed on a FULL
        // pass (see setMeta below); harmless to accumulate on a delta.
        for (const v of fp32) {
            bgN++;
            for (let d = 0; d < v.length; d++) bgSum[d] += v[d];
            reservoir.add(v);
        }
        const derived = fp32.map(v => ({ q: quantizeInt8(v), bin: packSignBits(v) }));
        // Chunk-diff commit (issue #5): a diffed file's record lists every
        // live id (stable rows kept in IDB + the embeds that landed), in the
        // document order allChunkIds preserved; without a plan this reduces
        // to the historic chunks.map. Either way a failed embed's id is
        // absent, so the quarantine-marker semantics are unchanged.
        const committedIds = new Set(chunks.map(c => c.chunk_id));
        const recordIds = fs.allChunkIds && fs.keepIds
            ? fs.allChunkIds.filter(id => fs.keepIds!.has(id) || committedIds.has(id))
            : chunks.map(c => c.chunk_id);
        await ctx.store.putBatchQuantized(chunks, derived, {
            note_path: fs.file.path,
            // Read-time snapshot, NOT fs.file.mtime (which may have
            // advanced if the file was edited during this index pass — see
            // FileState.mtimeMs). Recording the content's true mtime keeps
            // computeDelta able to detect a mid-index edit on the next pass.
            mtimeMs: fs.mtimeMs,
            chunk_ids: recordIds,
            contentHash: fs.contentHash,
            ...(failed > 0 ? { embedFailedChunks: failed, embedFailPluginVersion: ctx.pluginVersion } : {}),
        });
        // Surface the committed rows for the incremental cache path (A1). Done
        // AFTER the IDB write so the sink only ever holds rows that truly landed.
        if (budget.addsSink) pushDeltaAdds(budget.addsSink, chunks, derived);
        if (ctx.coord.sidecarOn()) {
            for (let i = 0; i < chunks.length; i++) {
                sidecarPending.push({
                    id: chunks[i].chunk_id,
                    tiers: { q: derived[i].q.q, s: derived[i].q.s, sign: derived[i].bin },
                    mtime: fs.mtimeMs,
                });
            }
        }
        commitMs += performance.now() - commitStart;
        totalChunks += chunks.length;
        totalVectors += chunks.length;
        perFileWallMs.push(performance.now() - fs.fileStart);
    };

    // Write one chunk's embedding back into its file; commit/skip the file
    // when its last chunk lands. A null vector marks an embed failure → the
    // whole file is skipped (matches the old per-file skip precision).
    const resolveChunk = async (p: Pending, vec: Float32Array | null): Promise<void> => {
        p.fs.vectors[p.slot] = vec;
        if (vec === null) p.fs.hadError = true;
        if (--p.fs.remaining > 0) return;
        const failed = p.fs.hadError ? p.fs.vectors.reduce((n, v) => n + (v === null ? 1 : 0), 0) : 0;
        if (p.fs.hadError) {
            // Quarantine, don't skip (issue #4) — commitFile writes the
            // partial chunks + the failure-marker record; see its comment.
            // Counts ride in the CONTEXT so the constant message keeps
            // deduping across files during a mass-failure storm.
            await ctx.logger.appendError(`indexFile-incomplete:${p.fs.file.path} failed=${failed}/${p.fs.chunks.length}`,
                new Error('one or more chunks failed to embed — quarantined (retries on edit / new release / full reindex)'));
        }
        try {
            await commitFile(p.fs);
            // Accounting only AFTER the commit landed: a failed commit takes
            // the catch's single filesSkippedError++, so no file ever counts
            // twice, and filesQuarantined counts only records actually written
            // (its documented meaning, and the mass-unwind below relies on it).
            if (p.fs.hadError) {
                // filesSkippedError still counts a quarantined file so the
                // index-complete pass gate (>2% skip = fail) keeps its
                // meaning: content IS missing.
                filesSkippedError++;
                filesQuarantined++;
                chunksFailedEmbed += failed;
                quarantined.push({ path: p.fs.file.path, kept: p.fs.chunks.length - failed });
            } else {
                filesCommitted++;
            }
            // Real progress for the catch-up drain — quarantined files too:
            // their record is written, so they are non-dirty by the drain's
            // own criterion and must not be re-fed to the embed loop.
            committedFilePaths.push(p.fs.file.path);
        } catch (ce) {
            // A closed store (onunload, or an onversionchange from another
            // instance deleting the DB mid-reindex) makes EVERY subsequent commit
            // throw this same error. Catching it per-file logged it ~once per
            // remaining file — the ~980-error storm. Rethrow so the whole pass
            // aborts after a single error; the caller logs it once and the next
            // reindex repairs the partial. An ordinary single-file commit failure
            // still skips just that file, as before.
            if (isStoreClosedError(ce)) throw ce;
            filesSkippedError++;
            // Disk full is environmental, not content: count it separately so the
            // pass-end gate can say "free up space" instead of "see error log"
            // (S2). Still per-file skip, not a pass abort — quota can clear
            // mid-pass (another app releases space), and the un-committed files
            // stay dirty for catch-up either way.
            if (isQuotaError(ce)) filesSkippedQuota++;
            await ctx.logger.appendError(`commitFile:${p.fs.file.path}`, ce);
        }
    };

    // Flush up to rollingBatchFor(bucket) chunks from a bucket as one dispatch.
    // On dispatch failure (after embedOneBatch's recycle+retry rethrows),
    // isolate each chunk with a solo embed so one genuinely-bad chunk skips
    // only its own file instead of poisoning the whole batch's files.
    const flushBucket = async (bucket: number): Promise<void> => {
        const buf = buffers.get(bucket);
        if (!buf || buf.length === 0) return;
        const batch = buf.splice(0, rollingBatchFor(bucket));
        const embedStart = performance.now();
        let vectors: Float32Array[] | null = null;
        try {
            vectors = await embedOneBatch(batch.map(p => p.input), bucket, `b${bucket}`, batch.map(p => p.tokens));
        } catch (e) {
            // Intentional teardown must unwind the whole pass, never reach the
            // solo/quarantine path — a DISPOSED batch's chunks would otherwise
            // all solo-fail DISPOSED too and quarantine healthy files against
            // a store that is about to close. Mirrors embedOneBatch's own
            // DISPOSED contract.
            if ((e as { code?: string } | null)?.code === 'DISPOSED') throw e;
            await ctx.logger.appendError(`flushBucket:${bucket}${dispatchInfo(batch.map(p => p.input), bucket, batch.map(p => p.tokens))}`, e);
        }
        if (vectors) {
            for (let i = 0; i < batch.length; i++) await resolveChunk(batch[i], vectors[i]);
        } else {
            for (const p of batch) {
                try {
                    const v = await embedOneBatch([p.input], bucket, `b${bucket}-solo`, [p.tokens]);
                    await resolveChunk(p, v[0]);
                } catch (se) {
                    if ((se as { code?: string } | null)?.code === 'DISPOSED') throw se;
                    await ctx.logger.appendError(`soloChunk:${p.fs.file.path}${dispatchInfo([p.input], bucket, [p.tokens])}`, se);
                    await resolveChunk(p, null);
                }
            }
        }
        embedMs += performance.now() - embedStart;
    };

    for (const file of files) {
        // Plugin unloaded mid-pass (disable / reload): stop now rather than keep
        // embedding + committing against the store onunload is about to close.
        // Applies to BOTH modes — a full reindex and the incremental cold build.
        // Any meta stamped for the partial index is still CORRECT (Fix A: current
        // identity, merely incomplete), and the next load's catch-up finishes it.
        if (ctx.disposed) break;
        // Manual pause (design B, full mode only): the user hit Pause. Break at
        // loop-top — BEFORE this file's chunks enter the rolling buffers — so the
        // unconditional bucket drain below commits exactly the files already
        // started and the un-started files stay record-less (dirty) for the resume
        // catch-up to finish. Unlike the disposed break the store stays OPEN, so
        // the tail (bucket drain + meta stamp) runs and the mutex releases cleanly
        // on return. A file already in flight is never interrupted mid-commit.
        if (mode === 'full' && budget.isPaused?.()) { pausedOut = true; break; }
        // Per-burst budget (incremental catch-up only): stop STARTING new files
        // once the wall-clock ceiling is spent or the app went hidden / search
        // resumed (shouldContinue→false). (The file-count cap is upstream — the
        // caller slices the dirty list.) Break at loop-top, BEFORE this file's
        // chunks enter the rolling buffers — so the unconditional bucket-drain
        // below commits exactly the files already started, and un-started files
        // stay dirty (their watermark never advanced) for the drain loop to
        // re-fire. A file already in flight is never interrupted mid-commit.
        if (mode === 'incremental'
            && ((budget.budgetMs !== undefined && performance.now() - overallStart > budget.budgetMs)
                || (budget.shouldContinue !== undefined && !budget.shouldContinue()))) {
            break;
        }
        // Full-mode soft preempt (3A): pause between files while the user is
        // typing / a query embed is in flight, then RESUME — never abort. The
        // wait sits at loop-top, before this file's chunks enter the buffers, so
        // nothing is held mid-flight; buffered chunks from prior files just wait.
        // Searches are not blocked by this pass (full mode never sets
        // currentDelta), so pausing here is what actually frees the iframe/GPU
        // for the live query. The episode cap only guards a wedged signal —
        // searchActive self-heals, so it should never bind (see the constants).
        if (mode === 'full' && budget.shouldContinue !== undefined && !preemptWedged
            && !budget.shouldContinue()) {
            const waitStart = performance.now();
            ctx.forensics?.beat('index-preempt-wait', { filesCommitted, chunks: totalChunks });
            // Say WHY the counter froze — a silent 2-min stall is exactly the
            // shape that made users force-quit healthy runs (see
            // PROGRESS_MAX_SILENCE_MS); a labelled pause is self-explaining.
            onProgress?.(`Indexed ${filesCommitted} files · ${totalChunks} chunks — paused while you search…`);
            while (!budget.shouldContinue() && !ctx.disposed
                && performance.now() - waitStart < FULL_PREEMPT_MAX_WAIT_MS) {
                await new Promise(resolve => setTimeout(resolve, FULL_PREEMPT_POLL_MS));
            }
            preemptWaitMs += performance.now() - waitStart;
            if (ctx.disposed) break;
            if (!budget.shouldContinue()) {
                // Episode cap expired with the signal STILL false (see
                // FULL_PREEMPT_WEDGE_EPISODES for why consecutive expiries
                // mean wedged, not busy).
                if (++preemptExpiries >= FULL_PREEMPT_WEDGE_EPISODES) {
                    preemptWedged = true;
                    console.warn('[seek] full-reindex preempt signal never released across '
                        + `${preemptExpiries} episodes — treating it as wedged; no more pauses this pass`);
                    ctx.forensics?.beat('index-preempt-wedged', { filesCommitted, episodes: preemptExpiries });
                }
            } else {
                preemptExpiries = 0;
            }
        }
        processedFiles++;
        const fileStart = performance.now();
        // Snapshot mtime BEFORE the read so the committed file-record reflects
        // the version we actually index, even if the file is edited mid-pass
        // (TOCTOU between this read and the much-later commit).
        const mtimeMs = file.mtime;
        let fileChunks: Chunk[];
        let contentHash = '';
        let content: string;
        try {
            content = await ctx.read(file);
        } catch (e) {
            // Read error (e.g. an undownloaded iCloud placeholder that throws
            // on every attempt) — skip this file (it never entered a buffer).
            // Its previous record and rows SURVIVE (the delta's wholesale
            // pre-delete is gone — chunk-diff, issue #5), so the last-indexed
            // version stays searchable; the stale-mtime record would still
            // re-report it dirty on every computeDelta, so quarantine it —
            // see the quarantine field comment for why that loop would
            // otherwise wedge reconcileIdentityInPlace.
            filesSkippedError++;
            await ctx.logger.appendError(`indexFile:${file.path}`, e);
            ctx.quarantineUnreadable(file.path);
            continue;
        }
        try {
            contentHash = cyrb53Hex(content);
            const modifiedIso = new Date(mtimeMs).toISOString();
            const chunkStart = performance.now();
            fileChunks = ctx.chunksFor(content, file.path, modifiedIso);
            chunkMs += performance.now() - chunkStart;
        } catch (e) {
            // Chunk error — skip this file (it never entered a buffer). Not
            // quarantined: this is a content/chunker problem, not a read
            // failure, so there is no reason to suppress future re-attempts.
            filesSkippedError++;
            await ctx.logger.appendError(`indexFile:${file.path}`, e);
            continue;
        }

        if (fileChunks.length === 0) {
            chunksPerFile.push(0); // empty / all below min_chunk_chars
            // Chunk-diff commit (issue #5): the delta's wholesale pre-delete is
            // gone, so an edit that EMPTIED the note must drop its stale rows +
            // record here or the pre-edit content ghosts in the index and the
            // stale-mtime record re-flags the file dirty forever. Bodies are
            // captured first so applyDelta can remove the rows exactly.
            if (mode === 'incremental' && budget.removedSink) {
                if (budget.removedBodiesSink) await captureRemovalBodies(ctx.store, file.path, budget.removedBodiesSink);
                budget.removedSink.push(...await ctx.store.deleteFile(file.path));
            }
            continue;
        }

        // WS2.3 token-budget enforcement: re-pack any chunk whose embed
        // input exceeds the 512-token window (counted by the model's own
        // tokenizer — token-counts RPC) and capture the EXACT count of
        // every final input for bucket routing below. The count RPC is
        // tokenizer-only (~ms per file) — folded into chunk time.
        let budgeted: TokenBudgetResult;
        try {
            const tbStart = performance.now();
            budgeted = await enforceTokenBudget(fileChunks, ts => ctx.embedder.tokenCounts(ts));
            chunkMs += performance.now() - tbStart;
        } catch (e) {
            filesSkippedError++;
            await ctx.logger.appendError(`tokenBudget:${file.path}`, e);
            continue;
        }
        fileChunks = budgeted.chunks;
        tokenBudgetSplits += budgeted.splits;
        tokenBudgetOverBudget += budgeted.overBudget;
        chunksPerFile.push(fileChunks.length);

        // Chunk-diff commit (issue #5): content-hash ids make "what actually
        // changed" computable — diff the post-budget ids against the stored
        // file record instead of the old delete-all + re-embed-all. Unchanged
        // chunks keep their IDB rows AND their vectors (a stable id pins the
        // embed text by construction); a one-paragraph edit of a 91-chunk
        // note embeds ~3 chunks, and the untouched chunks stay searchable
        // through the whole pass (the pre-delete made the file vanish until
        // its re-commit). Incremental-only: a full reindex nuked the DB, so
        // there is no record to diff against.
        let embedChunks = fileChunks;
        let embedCounts = budgeted.counts;
        let keepIds: Set<string> | undefined;
        const allChunkIds = fileChunks.map(c => c.chunk_id);
        // All THREE sinks gate the diff — a partially-wired caller would
        // refresh IDB meta while silently dropping the frame-row patches,
        // the exact frame↔IDB divergence the lanes exist to prevent.
        if (mode === 'incremental' && budget.removedSink && budget.removedBodiesSink && budget.metaPatchSink) {
            try {
                const plan = await planFileDiff(ctx.store, file.path, fileChunks, {
                    addsSink: budget.addsSink,
                    removedSink: budget.removedSink,
                    removedBodiesSink: budget.removedBodiesSink,
                    metaPatchSink: budget.metaPatchSink,
                });
                if (plan) {
                    keepIds = plan.keepIds;
                    chunksReconciled += plan.keepIds.size;
                    const nextChunks: Chunk[] = [];
                    const nextCounts: number[] = [];
                    for (let i = 0; i < fileChunks.length; i++) {
                        if (plan.embedIds.has(fileChunks[i].chunk_id)) {
                            nextChunks.push(fileChunks[i]);
                            nextCounts.push(budgeted.counts[i]);
                        }
                    }
                    embedChunks = nextChunks;
                    embedCounts = nextCounts;
                }
            } catch (e) {
                // The diff is an optimization; on failure restore the pre-diff
                // contract exactly: drop the file's old rows wholesale (or its
                // un-diffed stale ids would orphan into ghost results) and
                // re-embed everything. Bodies were possibly not captured →
                // applyDelta declines into the full rebuild. Slow, never wrong.
                // Dedup against what the diff applied before it threw: its
                // deleteChunksByIds ids are already in the sink, and the
                // still-unrewritten record deleteFile reads lists them too —
                // double entries would inflate DeltaApplyEntry.removed.
                await ctx.logger.appendError(`chunkDiff:${file.path}`, e);
                const alreadyRemoved = new Set(budget.removedSink);
                const dropped = await ctx.store.deleteFile(file.path).catch(() => [] as string[]);
                budget.removedSink.push(...dropped.filter(id => !alreadyRemoved.has(id)));
                embedChunks = fileChunks;
                embedCounts = budgeted.counts;
                keepIds = undefined;
            }
        }

        // Everything id-stable: the whole edit was metadata/line drift (or a
        // no-op). commitFile only runs when a buffered chunk resolves, so the
        // record must be written here or the file re-flags dirty forever.
        if (keepIds && embedChunks.length === 0) {
            try {
                await ctx.store.putBatchQuantized([], [], {
                    note_path: file.path, mtimeMs,
                    chunk_ids: allChunkIds.filter(id => keepIds.has(id)),
                    contentHash,
                });
                filesCommitted++;
                committedFilePaths.push(file.path);
                perFileWallMs.push(performance.now() - fileStart);
            } catch (e) {
                // No record advance → the file stays dirty and retries next
                // pass (same self-healing contract as a failed commitFile).
                await ctx.logger.appendError(`recordOnlyCommit:${file.path}`, e);
            }
            continue;
        }

        const fs: FileState = {
            file, chunks: embedChunks,
            vectors: new Array<Float32Array | null>(embedChunks.length).fill(null),
            remaining: embedChunks.length, hadError: false, fileStart,
            mtimeMs, contentHash,
            ...(keepIds ? { allChunkIds, keepIds } : {}),
        };
        for (let slot = 0; slot < embedChunks.length; slot++) {
            const c = embedChunks[slot];
            const input = embedInput(c);
            // Token-exact routing: the bucket is the smallest warmed rung
            // ≥ the input's REAL token count, so truncation cannot fire
            // (enforceTokenBudget guarantees count ≤ 512 except for the
            // counted-and-logged oversize-title pathology).
            const bucket = ctx.selectBucket(embedCounts[slot]);
            let buf = buffers.get(bucket);
            if (!buf) { buf = []; buffers.set(bucket, buf); }
            buf.push({ fs, slot, input, tokens: embedCounts[slot] });
            if (buf.length >= rollingBatchFor(bucket)) await flushBucket(bucket);
        }

        // Progress is keyed to COMMITTED files (not enqueued): with rolling
        // buffers a file commits only once its rarest-bucket chunk flushes,
        // so committed count is the honest "searchable so far" signal.
        // Cadence is files-OR-time: every PROGRESS_EVERY files, or every
        // PROGRESS_MAX_SILENCE_MS as long as ANY new file committed. The
        // pure file cadence proved a UX trap twice on iPhone WASM
        // (2026-06-11): JSC tier-up makes early files ~8× slow, the
        // counter froze for 30-60 s, and the user force-quit a healthy
        // run both times. Time floor keeps the UI provably alive through
        // slow stretches at negligible cost (the mid-reindex BM25 cache
        // drop below already ran every ~1-7 s on the file cadence).
        const progressOverdue = performance.now() - lastProgressAt >= PROGRESS_MAX_SILENCE_MS;
        if (filesCommitted > lastProgress && (filesCommitted - lastProgress >= PROGRESS_EVERY || progressOverdue)) {
            lastProgress = filesCommitted;
            lastProgressAt = performance.now();
            // Make progressive fill visible: drop the caches so a search
            // mid-reindex rebuilds against the files committed so far. Full
            // reindex reads are intentionally progressive (no currentDelta
            // gate); a delta instead commits atomically and invalidates once
            // at the end, so we don't churn its caches per batch here.
            if (mode === 'full') ctx.invalidateBm25Cache();
            onProgress?.(`Indexed ${filesCommitted} files · ${totalChunks} chunks`);
            ctx.forensics?.beat('index-progress', { filesCommitted, filesTotal: files.length, chunks: totalChunks });
            await ctx.emitProgress('embed', filesCommitted, files.length, totalChunks, performance.now() - overallStart);
        }
    }

    // Drain every partial bucket (each remainder is 1..ROLLING_MAX-1, all
    // warmed). This is where the last chunk of most files lands and commits.
    // Skipped when disposed: the store is closing, so flushing buffered chunks
    // would just throw STORE_NOT_OPENED per bucket; the next reindex repairs.
    if (!ctx.disposed) for (const bucket of buffers.keys()) {
        while ((buffers.get(bucket)?.length ?? 0) > 0) await flushBucket(bucket);
    }

    // Mass-failure gate: solo-retry evidence can't distinguish a poisoned
    // chunk from a wedged ENVIRONMENT (device-lost storm, app backgrounded
    // mid-pass, model unload race) — both retries share the environment. A
    // per-release quarantine written during such a storm would silently hide
    // every affected file from search until the next release. Volume is the
    // discriminator: genuine content failures are rare (issue #4 = one
    // file), a storm hits every in-flight file. Over the cap, UNWIND the
    // markers — deleteFile drops each quarantined record + its partial
    // chunks, restoring the pre-quarantine behavior for exactly this case:
    // the files stay dirty and self-heal on the next poll once the
    // environment recovers. The cap mirrors the pass gate's skip-rate
    // threshold with an absolute floor so a single bad file in a small
    // vault still quarantines.
    const quarantineCap = Math.max(3, Math.ceil(files.length * 0.02));
    let quarantineUnwound = 0;
    if (filesQuarantined > quarantineCap) {
        const unwoundPaths = new Set(quarantined.map(q => q.path));
        for (const q of quarantined) {
            try {
                await ctx.store.deleteFile(q.path);
                totalChunks -= q.kept;
                totalVectors -= q.kept;
            } catch (e) {
                if (isStoreClosedError(e)) throw e;
                unwoundPaths.delete(q.path);   // record survived — still honestly quarantined
                await ctx.logger.appendError(`quarantine-unwind:${q.path}`, e);
            }
        }
        // Unwound files have no record again → dirty by the drain's own
        // criterion → must not be reported as committed progress.
        for (let i = committedFilePaths.length - 1; i >= 0; i--) {
            if (unwoundPaths.has(committedFilePaths[i])) committedFilePaths.splice(i, 1);
        }
        filesQuarantined -= unwoundPaths.size;
        quarantineUnwound = unwoundPaths.size;
        checksExtra.push(`⚠️ mass embed failure (${quarantined.length} files > cap ${quarantineCap}) — environmental, not content: unwound ${unwoundPaths.size} quarantine record(s); files stay dirty and retry on the next pass`);
    }
    // Quota gate (S2): commits failed because device storage is FULL — an
    // environmental condition no retry fixes while it persists. The affected
    // files are already safe (no record advance → they stay dirty and catch-up
    // heals them once space frees); what was missing was any actionable signal
    // — the pass just logged generic per-file skips and the drain re-fired
    // forever. Check line + forensics beat on every affected pass; the toast is
    // rate-limited because catch-up bursts re-trip this for as long as the disk
    // stays full.
    if (filesSkippedQuota > 0) {
        checksExtra.push(`⚠️ storage full: ${filesSkippedQuota} file(s) failed to commit with QuotaExceededError — free up disk space; the files stay dirty and catch up automatically`);
        ctx.forensics?.beat('index-quota-exhausted', { files: filesSkippedQuota, mode });
        ctx.quotaToast();
    }
    // 3A observability: how long this full pass paused for live search activity.
    if (preemptWaitMs > 500) {
        checksExtra.push(`ℹ️ paused ${(preemptWaitMs / 1000).toFixed(1)} s for live search activity (full-reindex soft preempt)`);
    }
    // Design B: the user paused this full pass. It is a partial index, not a
    // completed full reindex — the remaining files stay dirty and resume embeds
    // exactly them via the catch-up drain (unchanged files are never re-embedded).
    if (pausedOut) {
        checksExtra.push(`⏸️ paused by user after ${filesCommitted} file(s) · ${totalChunks} chunk(s) — remaining files stay dirty and finish on resume`);
    }
    onProgress?.(`Indexed ${filesCommitted} files · ${totalChunks} chunks`);
    await ctx.emitProgress('embed', files.length, files.length, totalChunks, performance.now() - overallStart);

    // Corpus dense-cosine background (dense-stats.ts). A FULL pass saw every
    // vector, so it recomputes from scratch (or clears the stats when the
    // corpus is below MIN_BG_SAMPLE — too small to calibrate). An INCREMENTAL
    // pass saw only the changed files, far too few to estimate a corpus
    // global, so it carries the prior full-reindex values forward unchanged.
    // Computed HERE (before the sidecar job is packaged) so the device meta
    // the flush writes can carry it to hydrate-only peers.
    const prevMeta = await ctx.store.getMeta();
    // A FULL pass, or a cold first-build (storeWasEmpty), saw the whole corpus, so
    // it recomputes the background from scratch AND claims the live identity. An
    // ordinary delta saw only its changed files — far too few to move a corpus
    // global — so it carries the prior values forward. (On a mobile cold build
    // each 3-file burst is empty-then-not: the first burst stamps identity but
    // yields a sub-MIN_BG_SAMPLE → null background, which peers hydrate from a
    // desktop sidecar; later bursts carry that forward. See dense-stats.ts.)
    const sawWholeCorpus = shouldStampLiveIdentity(mode, storeWasEmpty);
    const bgStats = sawWholeCorpus ? denseBgStats(bgSum, bgN, reservoir.sample) : null;
    const bgMean = sawWholeCorpus ? bgStats?.mean : prevMeta.bgMean;
    const bgStd = sawWholeCorpus ? bgStats?.std : prevMeta.bgStd;
    // One identity read, shared by the sidecar meta (producer, below) and the
    // local meta commit. A full reindex stamps the live identity; an
    // incremental preserves prevMeta's — only a full rebuild claims a new one.
    const identity = ctx.identity();

    // 1C: package the sidecar flush instead of performing it here. This engine
    // always runs inside the write mutex, and the flush is pure file IO the
    // IDB index never depends on — the meta read/write plus bulkAppend's
    // per-shard stat sweep and shard/jsonl writes were extending the critical
    // section that searches (ensureFrame waiting on currentDelta) and queued
    // deltas sit behind. The caller runs the job via flushSidecarAfterPass
    // once the mutex releases, still awaited before its own promise resolves.
    // Narrow window accepted: a pass that throws between here and returning
    // (the final setMeta below can quota-throw) drops the job where the old
    // inline flush had already run — a durability lag, not a correctness
    // loss (hydrate re-chunks and intersects ids, so peers and post-eviction
    // recovery just re-embed the missing records; nothing dangles).
    const sidecarJob: SidecarFlushJob | null =
        ctx.coord.sidecarOn() && sidecarPending.length > 0
            ? { pending: sidecarPending, mode, bgMean, bgStd, identity }
            : null;

    // BM25 doesn't need its own persisted index for v0 — it's rebuilt
    // in-memory at search time from the chunk store. Track the timing
    // as zero here; we'll measure it on the first search.
    const bm25Ms = 0;

    // Final commit: meta marker (bgMean/bgStd computed above and shared with
    // the packaged sidecar flush, so both stores agree)
    const commitFinalStart = performance.now();
    await ctx.store.setMeta({
        embeddingDim: EMBEDDING_DIM,
        lastIndexedAt: new Date().toISOString(),
        schemaVersion: META_SCHEMA_VERSION,
        modelId: ctx.embedder.modelId,
        // Identity: a full reindex — or a cold first-build (sawWholeCorpus) —
        // stamps the live build; an ordinary incremental preserves prevMeta so a
        // delta can't falsely re-stamp a stale index as current (mirrors bgMean /
        // lastFullReindex above). Fix A: the cold build must stamp, else its
        // `undefined` identity loops the gate into a spurious heal.
        chunkerVersion: sawWholeCorpus ? identity.chunkerVersion : prevMeta.chunkerVersion,
        analyzerVersion: sawWholeCorpus ? identity.analyzerVersion : prevMeta.analyzerVersion,
        revision: sawWholeCorpus ? identity.revision : prevMeta.revision,
        bgMean,
        bgStd,
    });
    commitMs += performance.now() - commitFinalStart;

    const memAfter = await snapshotMemory();
    const totalMs = performance.now() - overallStart;
    const memD = memoryDelta(memBefore, memAfter);

    // Throughput rollups. Guard against div-by-zero in the (degenerate)
    // case where reindex completed in <1 ms — happens when the vault is
    // completely empty after the EXCLUDED_PATHS filter.
    const seconds = totalMs / 1000;
    const chunksPerSec = seconds > 0 ? totalChunks / seconds : 0;
    const filesPerSec = seconds > 0 ? files.length / seconds : 0;

    const checks: string[] = [
        `✅ indexed ${files.length} files → ${totalChunks} chunks → ${totalVectors} vectors`,
        `ℹ️ embed: ${embedMs.toFixed(0)} ms, chunk: ${chunkMs.toFixed(0)} ms, commit: ${commitMs.toFixed(0)} ms`,
        `ℹ️ total wall time: ${totalMs.toFixed(0)} ms`,
        `ℹ️ throughput: ${chunksPerSec.toFixed(1)} chunks/s, ${filesPerSec.toFixed(1)} files/s`,
    ];
    // Rolling-buffer effectiveness: dispatches = number of embedBatch
    // forward passes; effective batch = vectors / dispatches. Within-file it
    // sat at ~2.2 (p50=1 chunk/file); per-bucket rolling should approach the
    // budget-weighted mean flush size. The measurement that says it worked.
    const embedDispatches = embedBatchLatencyMs.length;
    const effectiveBatch = embedDispatches > 0 ? totalVectors / embedDispatches : 0;
    checks.push(`ℹ️ embed: ${embedDispatches} dispatches, effective batch ≈ ${effectiveBatch.toFixed(1)} (budget ${ROLLING_BUDGET}, max ${ROLLING_MAX})`);
    if (mode === 'full') {
        checks.push(bgStats
            ? `ℹ️ dense background: μ=${bgStats.mean.toFixed(4)} σ=${bgStats.std.toFixed(4)} (${bgN} vecs, calibration on)`
            : `ℹ️ dense background: ${bgN} vecs < ${MIN_BG_SAMPLE} — calibration off`);
    }
    // A handful of genuinely-malformed files skipping is tolerable; a large
    // fraction skipping is the ORT-overflow cascade (or a new systemic fault)
    // and must NOT report success — pass gates on the skip rate so it fails
    // loudly (2026-06-03: 668/2190 skipped had reported pass:true).
    const skipRate = files.length > 0 ? filesSkippedError / files.length : 0;
    const SKIP_RATE_FAIL = 0.02; // >2% of files skipped ⇒ fail the run
    if (embedRecycles > 0) checks.push(`♻️ recycled embed session ${embedRecycles}× — ORT WebGPU overflow recovery (see embedder.recycle)`);
    if (filesSkippedError > 0) {
        const tag = skipRate > SKIP_RATE_FAIL ? '❌' : '⚠️';
        checks.push(`${tag} ${filesSkippedError}/${files.length} file(s) skipped due to error (${(skipRate * 100).toFixed(1)}%) — see error log`);
    }
    if (filesQuarantined > 0) {
        checks.push(`⚠️ ${filesQuarantined} file(s) quarantined (${chunksFailedEmbed} chunk(s) failed to embed after solo retry) — healthy chunks committed + searchable; retried on edit / new release / full reindex`);
    }
    checks.push(...checksExtra);
    // 1C: the flush itself runs off the mutex after this entry is logged, so
    // its duration is no longer inside commitDurationMs — the queued count is
    // the entry's honest record of what this pass handed the flush chain.
    if (sidecarJob) checks.push(`ℹ️ sidecar: ${sidecarJob.pending.length} tier record(s) queued for off-mutex flush`);
    if (totalChunks === 0 && chunksReconciled === 0) checks.push('⚠️ no chunks produced — vault may be empty or all files below min_chunk_chars');
    // WS2.3 invariant surface: splits are normal (every >512-token chunk
    // re-packs); a nonzero overBudget means some input still truncates
    // (unsplittable window-filling title) — warn, don't fail.
    checks.push(`ℹ️ token budget: ${tokenBudgetSplits} chunk(s) re-packed to ≤512 tokens`);
    if (tokenBudgetOverBudget > 0) {
        checks.push(`⚠️ ${tokenBudgetOverBudget} embed input(s) still over the 512-token window (title alone ~fills it) — dense tail truncated for those`);
    }
    if (memD.storageDeltaMB != null) checks.push(`ℹ️ storage delta: +${memD.storageDeltaMB.toFixed(1)} MB on disk (IDB)`);

    // Reclaim the WebGPU buffer-pool high-water-mark. Indexing (plus the
    // batch-8×512 warmup grid) grows ORT-Web's off-heap GPU pool to ~1.4 GB;
    // it never shrinks on its own and would otherwise sit resident for the
    // plugin's whole query-serving life, even though queries only need the
    // batch-1 pool. A full device teardown via recycle() drops it back to the
    // ~193 MB floor (verified by toggle-and-diff, 2026-06-03); the next query
    // lazily rebuilds just the small pool it needs. Reindex is infrequent and
    // already ~3 min, so the ~2–4 s teardown is in the noise. WebGPU-only
    // (WASM has no GPU pool to reclaim); best-effort — a cleanup failure must
    // not fail an otherwise-good index, and recycle() leaves the embedder
    // loaded and usable on success regardless.
    // Skipped on a manual pause: resume re-embeds the remainder within seconds
    // (rebuilding the very pool we'd tear down here), so the teardown is pure
    // churn — resume's own completion pays it instead.
    if (mode === 'full' && !pausedOut && ctx.embedder.device === 'webgpu') {
        const recycleStart = performance.now();
        try {
            await ctx.embedder.recycle();
            checks.push(`🧹 released WebGPU buffer pool post-index (${(performance.now() - recycleStart).toFixed(0)} ms) — reclaims the indexing high-water-mark to the query floor`);
        } catch (e) {
            await ctx.logger.appendError('post-index-recycle', e);
            checks.push(`⚠️ post-index GPU pool release failed (non-fatal): ${e}`);
        }
    }

    const entry: IndexCompleteEntry = {
        type: 'index-complete',
        timestamp: new Date().toISOString(),
        mode,
        dtype: ctx.embedder.dtype,
        embeddingDim: EMBEDDING_DIM,
        // processedFiles, not files.length: a budgeted incremental burst may
        // have started fewer than it was handed (the rest are filesDeferred).
        // Identical to files.length on a full reindex (never budget-broken).
        filesIndexed: processedFiles,
        // The files actually committed this pass (record written), so the catch-up
        // drain advances by real progress, not by count-of-started. Distinct from
        // filesIndexed (started) whenever a file is empty/skipped/budget-deferred.
        committedFilePaths,
        chunksIndexed: totalChunks,
        vectorsWritten: totalVectors,
        filesSkippedError,
        filesSkippedQuota,
        filesQuarantined,
        chunksFailedEmbed,
        filesDeferred: files.length - processedFiles,
        embedRecycles,
        tokenBudgetSplits,
        tokenBudgetOverBudget,
        chunkDurationMs: parseFloat(chunkMs.toFixed(2)),
        embedDurationMs: parseFloat(embedMs.toFixed(2)),
        bm25DurationMs: parseFloat(bm25Ms.toFixed(2)),
        commitDurationMs: parseFloat(commitMs.toFixed(2)),
        totalDurationMs: parseFloat(totalMs.toFixed(2)),
        heapDeltaMB: memD.heapDeltaMB,
        storageDeltaMB: memD.storageDeltaMB,
        chunksPerSec: parseFloat(chunksPerSec.toFixed(2)),
        filesPerSec: parseFloat(filesPerSec.toFixed(2)),
        perFileWallMs: distributionStats(perFileWallMs),
        chunksPerFile: distributionStats(chunksPerFile),
        embedBatchLatencyMs: distributionStats(embedBatchLatencyMs),
        paceWaitMs: parseFloat(paceWaitMs.toFixed(2)),
        pass: (totalChunks > 0 || chunksReconciled > 0) && skipRate <= SKIP_RATE_FAIL,
        paused: pausedOut,
        checks,
    };
    // Completion beat closes the indexing window: a death AFTER this reads
    // as idle/background eviction, not crash-while-indexing.
    ctx.forensics?.beat('index-complete', {
        mode, filesCommitted, chunks: totalChunks,
        dispatches: fDispatches, paddedTokens: fPaddedTokens,
    });
    await ctx.logger.append(entry);
    return { entry, sidecarJob, quarantineUnwound };
}
