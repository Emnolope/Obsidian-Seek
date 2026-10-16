// Search helpers lifted out of search.ts: stage-2 alignment, resident-frame row bookkeeping,
// drift/coherence decisions, BM25 persistence stamp, snippet shaping. All pure, so the MCP side ranks and renders exactly like the plugin.
import type { ChunkMeta, Chunk, ScoredChunk, SeekSettings } from './types.ts';
import { ANALYZER_VERSION } from './bm25.ts';
import { LEGACY_ENGLISH_MODEL_ID } from './contract.ts';
import type { QuantVec } from './quant.ts';
import { passageWindow, type PassageTerm } from './passage.ts';

// fork 1.1.3 src/search.ts:4516 alignCandidate
// Assemble the resident int8 rerank block for a frame. For each chunk_id in
// `orderedIds` (frame row order, already orphan-filtered by ensureFrame), copy
// its stored int8 components into a contiguous Int8Array and its scale into a
// parallel Float64Array, so block row j ↔ orderedIds[j] ↔ activePacked row j.
//
// All-or-nothing: returns null (caller falls back to the per-id IDB read) when
// the embeddings store is empty OR any frame row lacks a same-dim embedding
// sibling. That keeps stage-2 behaviour identical to the IDB path in every
// inconsistent state (putBatch writes chunk+emb+bin atomically, so a surviving
// frame row should always have an embedding — the guard is defensive against a
// half-migrated/corrupted store) and merely faster in the consistent case.
//
// Scales are Float64 (NOT Float32): s = max|vᵢ|/127 is a float64, and stage-2
// dequantizes with dequantizeInt8(int8.subarray(...), scales[j]) — the SAME
// function getEmbeddingsByIds calls on the on-disk {q,s}. Holding s at full
// float64 precision makes that dequant bit-identical to the IDB path; a Float32
// scale would round s and could shift a dequantized component, breaking the
// relevance-identical guarantee.
// Stage-2 candidate alignment decision: whether `v` (this candidate's fp32
// row) is usable, and — if not — the degraded ChunkMeta to rank it with
// instead of dropping it. A missing/mismatched row (no chunk sibling in the
// embeddings store: a half-migrated upgrade, storage corruption, or, on
// mobile — which ALWAYS takes the per-id getEmbeddingsByIds path, never the
// resident RAM block — a chunk whose vector hasn't hydrated/embedded on this
// device yet) degrades to the SAME lexical-only floor ranker.ts already
// applies to body-less title-only chunks, rather than silently dropping a
// candidate BM25 may have ranked first. Returns null only when there is no
// chunk metadata at all (nothing to rank or render). The returned chunk is a
// COPY when degraded — the caller's orderedChunks entry is shared across
// queries and must never be mutated in place.
export function alignCandidate(
    ch: ChunkMeta | undefined | null,
    v: Float32Array | null | undefined,
    queryDim: number,
): { chunk: ChunkMeta; missingFp32: boolean } | null {
    if (!ch) return null;
    const missingFp32 = !v || v.length !== queryDim;
    return { chunk: missingFp32 ? { ...ch, lexicalOnly: true } : ch, missingFp32 };
}

// fork 1.1.3 src/search.ts:4526 buildResidentRerankBlock
export function buildResidentRerankBlock(
    orderedIds: string[],
    embById: Map<string, QuantVec>,
): { int8: Int8Array; scales: Float64Array; embDim: number } | null {
    const n = orderedIds.length;
    if (n === 0) return null;
    const first = embById.get(orderedIds[0]);
    const embDim = first ? first.q.length : 0;
    if (embDim === 0) return null;
    const int8 = new Int8Array(n * embDim);
    const scales = new Float64Array(n);
    for (let j = 0; j < n; j++) {
        const qv = embById.get(orderedIds[j]);
        if (!qv || qv.q.length !== embDim) return null;   // all-or-nothing
        int8.set(qv.q, j * embDim);
        scales[j] = qv.s;
    }
    return { int8, scales, embDim };
}

// fork 1.1.3 src/search.ts:4556 ResidentFrame
// ── Resident frame (Seek scaling A1) ─────────────────────────────────────────
// The query-time row space. All tiers are aligned row-for-row: row i is
// orderedChunks[i] / orderedIds[i] / activePacked[i*bytesPerVec…] /
// residentInt8[i*embDim…] (scale residentScales[i]) / validRows[i], and the BM25
// idToIdx maps that same id→i. A single `idx` joins all of them at search time,
// so the numbering MUST stay coherent — appendFrameRows/tombstoneFrameRows below
// mutate it in lockstep with MultiFieldBM25.add/remove, and a runtime drift
// detector (applyDelta) re-checks the coupling and falls back to a full rebuild
// if it ever diverges. tombstoneCount tracks rows whose validRows flag is false
// (deleted/edited-away, awaiting compaction).
export interface ResidentFrame {
    orderedChunks: ChunkMeta[];
    orderedIds: string[];
    activePacked: Uint8Array;
    bytesPerVec: number;
    residentInt8: Int8Array | null;
    residentScales: Float64Array | null;
    embDim: number;
    validRows: boolean[];
    tombstoneCount: number;
    generation: number;
}

// fork 1.1.3 src/search.ts:4573 DeltaAdd
// One committed chunk's data needed to append it to the live frame + BM25 index.
// reindexDelta already holds exactly this at commit time (commitFile derives
// {q, bin} from the fp32 vector; fs.chunks still carry content): the change-set
// it currently discards at invalidateBm25Cache().
export interface DeltaAdd {
    chunk: Chunk;       // full chunk: content feeds BM25's body, the rest is frame meta
    q: QuantVec;        // int8 rerank tier (resident block row)
    bin: Uint8Array;    // sign-bit binary tier (activePacked row)
}

// fork 1.1.3 src/search.ts:4589 chunkMetaEqual
// Append committed chunks + their derived tiers to a change-set sink. Shared by
// BOTH commit paths so they surface identically into applyDelta: commitFile
// (model-embedded, derived = quantizeInt8/packSignBits) and the sidecar hydrate
// (bytes copied from a peer's shard, tiers = {q, bin}). chunks[i] aligns with
// tiers[i].
// Chunk-diff commit (issue #5): full ChunkMeta equality — the "untouched" gate.
// JSON compare is sound here because both sides come off the same construction
// pipeline (the chunker for the new side; the chunker → structured-clone round
// trip through IDB for the old side), which preserves property insertion order.
// A false "changed" only costs a cheap meta-patch, never a wrong index.
export function chunkMetaEqual(a: ChunkMeta, b: ChunkMeta): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

// fork 1.1.3 src/search.ts:4593 pushDeltaAdds
export function pushDeltaAdds(sink: DeltaAdd[], chunks: Chunk[], tiers: { q: QuantVec; bin: Uint8Array }[]): void {
    for (let i = 0; i < chunks.length; i++) {
        sink.push({ chunk: chunks[i], q: tiers[i].q, bin: tiers[i].bin });
    }
}

// fork 1.1.3 src/search.ts:4619 freshDeltaAdds
// Narrow a delta's adds to those NOT already live in the BM25 row space, and drop
// any within-batch duplicate ids. THE guard for the 2026-06-18 mobile meltdown:
// hydrate-sourced adds (scaling A1) can carry a chunk_id that is already live in
// the in-memory `bm`. hydrateFromSidecar's candidate selector skips a note only
// when EVERY chunk is in IDB (existingIds reads IDB, NOT the in-memory cache), so
// after an IDB↔cache divergence (a crash / partial commit) a note re-surfaces ids
// `bm` already holds as PURE adds — with no matching remove, because the
// IDB-driven deleteFile produced none for an id IDB never had. The unguarded
// loop then called bm.add() on a live id, which MiniSearch THROWS on ("duplicate
// ID"); the throw aborted applyDelta mid-patch, left frame/BM25 mis-coupled, and
// every reconcile re-tripped it → toast + rebuild loop → thermal crash.
//
// Safe to skip because chunk_id is content-addressed (cyrb53 of path+title+body):
// a live id ⟹ a byte-identical chunk ⟹ the re-add is a pure no-op (the IDB write
// already landed in putQuantized). Caller MUST run this AFTER dropping removedIds
// from `bm`, so an edit that re-commits the same content-hash id is NOT filtered
// (its id is no longer live by then) — only genuine already-live duplicates are.
// Apply the SAME filtered list to bm.add AND appendFrameRows so the two row
// spaces stay aligned (a guard on bm.add alone would desync the frame and re-trip
// the very drift detector this prevents).
export function freshDeltaAdds(adds: DeltaAdd[], isLive: (id: string) => boolean): DeltaAdd[] {
    const out: DeltaAdd[] = [];
    const seen = new Set<string>();
    for (const a of adds) {
        const id = a.chunk.chunk_id;
        if (seen.has(id) || isLive(id)) continue;
        seen.add(id);
        out.push(a);
    }
    return out;
}

// fork 1.1.3 src/search.ts:4632 frameMetaOf
// Strip body text for the metadata-only frame (mirrors index-store.stripContent).
function frameMetaOf(c: Chunk): ChunkMeta {
    const { content, ...meta } = c;
    void content;
    return meta;
}

// fork 1.1.3 src/search.ts:4648 appendFrameRows
// Append committed chunks to a live frame IN PLACE. One realloc of the contiguous
// tiers per BURST (not per chunk): a ~R-byte copy, negligible beside the O(N)
// BM25 fit() the incremental path eliminates. The binary + metadata tiers grow
// UNCONDITIONALLY — skipping them on the resident-disabled (mobile) path would
// skew the binary scan's row space from the frame's. The int8 rerank tier grows
// only when it's live (desktop/in-budget); on mobile it stays null and stage-2
// falls back to the per-id IDB read. The block may drift slightly over the byte
// budget here — the next cold rebuild / compaction re-gates it via
// residentInt8Enabled. New rows are assigned ids in array order, matching
// MultiFieldBM25.add (row = chunkCount), so frame row === bm25 idToIdx row.
export function appendFrameRows(frame: ResidentFrame, adds: DeltaAdd[]): void {
    if (adds.length === 0) return;
    const oldRows = frame.orderedIds.length;
    const k = adds.length;
    const bpv = frame.bytesPerVec;

    const newPacked = new Uint8Array((oldRows + k) * bpv);
    newPacked.set(frame.activePacked.subarray(0, oldRows * bpv), 0);
    for (let j = 0; j < k; j++) newPacked.set(adds[j].bin, (oldRows + j) * bpv);
    frame.activePacked = newPacked;

    if (frame.residentInt8 && frame.residentScales) {
        const d = frame.embDim;
        const newInt8 = new Int8Array((oldRows + k) * d);
        newInt8.set(frame.residentInt8.subarray(0, oldRows * d), 0);
        const newScales = new Float64Array(oldRows + k);
        newScales.set(frame.residentScales.subarray(0, oldRows), 0);
        for (let j = 0; j < k; j++) {
            newInt8.set(adds[j].q.q, (oldRows + j) * d);
            newScales[oldRows + j] = adds[j].q.s;
        }
        frame.residentInt8 = newInt8;
        frame.residentScales = newScales;
    }

    for (let j = 0; j < k; j++) {
        frame.orderedChunks.push(frameMetaOf(adds[j].chunk));
        frame.orderedIds.push(adds[j].chunk.chunk_id);
        frame.validRows.push(true);
    }
}

// fork 1.1.3 src/search.ts:4683 tombstoneFrameRows
// Tombstone rows (mark not-live). The contiguous tiers keep their bytes (holes);
// validRows masks them out at selection, browse, and recency. Idempotent and
// bounds-guarded so a stale/duplicate row can't drive tombstoneCount negative.
export function tombstoneFrameRows(frame: ResidentFrame, rows: number[]): void {
    for (const row of rows) {
        if (row >= 0 && row < frame.validRows.length && frame.validRows[row]) {
            frame.validRows[row] = false;
            frame.tombstoneCount++;
        }
    }
}

// fork 1.1.3 src/search.ts:4698 buildSelectionMask
// Per-row selection mask = live rows (validRows) AND the optional inline-filter
// matcher. Returns undefined ONLY when the frame is fully live AND there's no
// matcher — the byte-identical no-filter fast path. Otherwise a defined mask,
// even with no filter, so tombstones are excluded from the filter-only browse
// path (its `!mask ||` short-circuit would otherwise admit every row, including
// holes). && short-circuits so a tombstoned row's stale ChunkMeta is never read.
export function buildSelectionMask(
    orderedChunks: ChunkMeta[],
    validRows: boolean[],
    tombstoneCount: number,
    matcher: ((c: ChunkMeta) => boolean) | null,
): boolean[] | undefined {
    if (!matcher && tombstoneCount === 0) return undefined;
    const n = orderedChunks.length;
    const mask = new Array<boolean>(n);
    for (let i = 0; i < n; i++) {
        mask[i] = validRows[i] && (matcher ? matcher(orderedChunks[i]) : true);
    }
    return mask;
}

// fork 1.1.3 src/search.ts:4716 COMPACTION_TOMBSTONE_FRACTION
// Compaction fires when this fraction of rows are tombstones — the amortized O(N)
// renumber that keeps the frame from growing unbounded with holes (a full rebuild
// produces a dense, fully-live frame).
export const COMPACTION_TOMBSTONE_FRACTION = 0.25;
// fork 1.1.3 src/search.ts:4718 COHERENCE_SAMPLES
// Rows sampled by the drift detector's id↔row spot-check (the warm-build verify path checks all).
export const COHERENCE_SAMPLES = 8;
// fork 1.1.3 src/search.ts:4724 COHERENCE_DRIFT_COOLDOWN_MS
// Circuit breaker for onCoherenceDrift: a drift that re-trips within this window of
// the last rebuild is treated as PERSISTENT (not a one-off), so the expensive
// re-warm + the user Notice are suppressed to break the thrash. The cache is still
// invalidated every trip (correctness), so the next search rebuilds it lazily once.
// Without this, one bad delta drove an unbounded toast+rebuild loop (2026-06-18).
export const COHERENCE_DRIFT_COOLDOWN_MS = 30_000;

// fork 1.1.3 src/search.ts:4732 coherenceDriftDecision
// Pure decision for that circuit breaker, extracted so it's unit-testable without a
// live SearchOrchestrator (onCoherenceDrift is a private method with heavy deps).
// invalidate is ALWAYS true — a mis-coupled frame/BM25 must never serve, and the
// drop is cheap. warm (the O(N) rebuild + the user Notice) is allowed only once the
// cooldown since the last warm has elapsed, so a re-trip inside the window degrades
// to a lazy cold rebuild instead of a toast+rebuild storm.
export function coherenceDriftDecision(
    now: number, lastWarmAt: number, cooldownMs: number,
): { invalidate: boolean; warm: boolean } {
    return { invalidate: true, warm: now - lastWarmAt >= cooldownMs };
}

// fork 1.1.3 src/search.ts:4744 shouldDiscardPartialFrame
// F2 guard, extracted so ensureFrame's "don't cache a partial frame as fresh"
// invariant has a named, directly-tested home. A frame assembled at buildGen must
// be discarded (rebuilt) when the index generation advanced while we were reading:
// a full reindex completing mid-assembly would otherwise let the stale-partial
// frame be cached under the NEW generation and served as fresh. True ⇒ discard
// (the call sites re-enter ensureFrame, which converges in one extra pass).
export function shouldDiscardPartialFrame(buildGen: number, currentGen: number): boolean {
    return currentGen !== buildGen;
}

// fork 1.1.3 src/search.ts:4756 DriftRecoveryState
// Pure decision for the plugin's drift-recovery scheduler: escalate an embed-free
// recovery for THIS index state, or not. The suppression is generation-keyed — a
// degraded index re-trips drift on every keystroke, but currentGen only advances on
// a real index mutation, so once we've escalated for a generation we don't escalate
// again until something actually changes (a later delta/reindex/invalidate/hydrate
// bumps the generation, re-arming recovery for the new state). running short-circuits
// so a recovery already in flight is never double-scheduled. health is carried for the
// caller's UI/state but is deliberately NOT consulted here — the gen key alone decides.
export interface DriftRecoveryState {
    running: boolean;
    health: 'healthy' | 'recovering' | 'degraded';
    lastRecoveryGen: number;   // generation we last escalated for; -1 = never
    currentGen: number;
}
// fork 1.1.3 src/search.ts:4762 driftRecoveryDecision
export function driftRecoveryDecision(s: DriftRecoveryState): { schedule: boolean } {
    if (s.running) return { schedule: false };
    if (s.currentGen === s.lastRecoveryGen) return { schedule: false };
    return { schedule: true };
}

// fork 1.1.3 src/search.ts:4771 RowSpaceProbe
// The BM25 surface the drift detector reads — MultiFieldBM25 satisfies it
// structurally (get size / get liveCount / rowOf). Decoupled as an interface so
// the detector is a pure, engine-free unit test target.
export interface RowSpaceProbe {
    readonly size: number;       // R: rows incl tombstones (== frame.orderedChunks.length)
    readonly liveCount: number;  // live (non-tombstoned) rows
    rowOf(id: string): number | undefined;
}

// fork 1.1.3 src/search.ts:4785 frameBm25Coherent
// Row-space coherence between the frame and the BM25 index — THE fragile invariant
// of the incremental path. At query time a single `idx` indexes orderedChunks[idx]
// / activePacked[idx] / residentInt8[idx] / bm25Scores[idx] together, so if their
// numbering ever drifts, search returns plausible-but-wrong scores: silent,
// in-bounds, relevance-degrading. This makes drift LOUD. O(1) structural checks
// always; a sampled (full only on the warm-build verify path) idToIdx[orderedIds[i]]===i spot-check on
// top. A false return is the trip — the caller logs + drops to a full rebuild,
// converting silent drift into a visible "rebuilt from scratch" event.
export function frameBm25Coherent(frame: ResidentFrame, probe: RowSpaceProbe, full = false): boolean {
    const n = frame.orderedChunks.length;
    // O(1): row counts + live counts must agree across both structures.
    if (probe.size !== n) return false;
    if (frame.orderedIds.length !== n || frame.validRows.length !== n) return false;
    if (probe.liveCount !== n - frame.tombstoneCount) return false;
    if (n === 0) return true;
    // id↔row spot-check over LIVE rows (tombstone holes carry no BM25 entry).
    const samples = full ? n : Math.min(COHERENCE_SAMPLES, n);
    for (let s = 0; s < samples; s++) {
        const i = full ? s : Math.floor((s * (n - 1)) / Math.max(1, samples - 1));
        if (!frame.validRows[i]) continue;
        if (probe.rowOf(frame.orderedIds[i]) !== i) return false;
    }
    return true;
}

// fork 1.1.3 src/search.ts:4819 Bm25PersistStamp
// Identity of a persisted MiniSearch index — what must match for a stored blob
// to be loadable instead of refit. Two classes of input:
//   - analyzerVersion: a build-time content hash of the analyzer sources
//     (bm25.ts + tokenize.ts + prop-normalize.ts + MiniSearch version). Collapses
//     EVERY code/constant input that decides the token space — tokenizer,
//     processTerm, depluralize tables, field list, boosts, bm25 params,
//     combineWith — into one string. A loaded index uses its OWN postings but the
//     CURRENT analyzer (loadJSON re-supplies it and does NOT check it matches), so
//     a changed analyzer must invalidate the blob; the hash does that automatically.
//   - the runtime values a static hash can't see: model/dim (a model swap drops
//     chunks) and the two index-shape toggles props/headings — all GATED.
//   - lastIndexedAt + chunkCount: WRITTEN for diagnostics (and a possible future
//     tighter gate) but NOT gated as of 2026-06-20 — see bm25StampMatches for why
//     a stale-but-compatible blob is safe to load (content-derived ids → drift is
//     invisibility, not error). They were the churn fields that forced the freeze.
// A GATED field differing ⇒ refit (relevance-identical). generation is NOT here: it
// resets to 0 every process, so a disk blob would never match a fresh session.
export interface Bm25PersistStamp {
    analyzerVersion: string;
    modelId: string;
    embeddingDim: number;
    lastIndexedAt: string;
    chunkCount: number;
    props: boolean;
    headings: boolean;
}

// fork 1.1.3 src/search.ts:4829 buildBm25Stamp
export function buildBm25Stamp(meta: { modelId?: string; embeddingDim: number; lastIndexedAt: string | null }, chunkCount: number, settings: SeekSettings): Bm25PersistStamp {
    return {
        analyzerVersion: ANALYZER_VERSION,
        modelId: meta.modelId ?? LEGACY_ENGLISH_MODEL_ID,
        embeddingDim: meta.embeddingDim,
        lastIndexedAt: meta.lastIndexedAt ?? '',
        chunkCount,
        props: settings.searchableProperties,
        headings: settings.headingsField || settings.boostedBm25,
    };
}

// fork 1.1.3 src/search.ts:4841 bm25StampMatches
export function bm25StampMatches(stored: unknown, live: Bm25PersistStamp): boolean {
    if (!stored || typeof stored !== 'object') return false;
    const s = stored as Partial<Bm25PersistStamp>;
    // TOLERANT GATE (2026-06-20): compare only the five CORRECTNESS-critical fields.
    // lastIndexedAt + chunkCount are deliberately NOT compared — they change on every
    // delta/hydrate, so gating on them rejected the blob on every churn event and
    // forced a cold all-bodies refit (the 18.6 s mobile freeze). Dropping them admits
    // a stale-but-compatible blob, which is SAFE by construction: chunk_id is content-
    // derived (chunkIdFor), so an edited chunk gets a NEW id, and getScoresWithCoverage
    // skips any posting whose id isn't in the live frame (bm25.ts `if (idx===undefined)
    // continue`) while a live chunk absent from the postings keeps its 0 default. So
    // staleness = edited/new chunks briefly lexical-invisible (reconciled by the next
    // delta / catch-up), NEVER wrong text or a crash. The five retained fields are
    // orthogonal to corpus size/timestamp, so a genuinely incompatible blob (changed
    // analyzer/model/dim/index-shape) still rejects in its own field. buildBm25Stamp
    // still WRITES both churn fields (diagnostics + a future tighter gate); we just
    // stop gating on them. tryLoadPersistedBm25 keeps its `meta.lastIndexedAt` presence
    // check, so a never-completed index is still never loaded.
    return s.analyzerVersion === live.analyzerVersion
        && s.modelId === live.modelId
        && s.embeddingDim === live.embeddingDim
        && s.props === live.props
        && s.headings === live.headings;
}

// fork 1.1.3 src/search.ts:4869 dedupByPath
// File-level dedup: walk the ranked pool, keep the first (highest-scoring)
// chunk per note_path, stop at topK unique notes. Shared by the main search
// path and the filter-only fast path.
export function dedupByPath(rankedPool: ScoredChunk[], topK: number): ScoredChunk[] {
    const seenPaths = new Set<string>();
    const out: ScoredChunk[] = [];
    for (const r of rankedPool) {
        if (seenPaths.has(r.note_path)) continue;
        seenPaths.add(r.note_path);
        out.push(r);
        if (out.length >= topK) break;
    }
    return out;
}

// fork 1.1.3 src/search.ts:4881 topKByScore
export function topKByScore(scores: Float64Array, chunks: ChunkMeta[], k: number): Array<{ chunk_id: string; score: number }> {
    const indices = Array.from({ length: scores.length }, (_, i) => i);
    indices.sort((a, b) => scores[b] - scores[a]);
    return indices.slice(0, k).map(i => ({ chunk_id: chunks[i].chunk_id, score: scores[i] }));
}

// fork 1.1.3 src/search.ts:4901 snippetPlainText
// Project a chunk to the plain text a reader would see, collapsing markdown
// link/embed syntax to its display text. Run BEFORE the snippet window is
// chosen so a query term that exists only inside a URL (e.g. the `style` in
// `…/design_asset_style_ab?…`) can't drag the window into the URL and slice the
// link into unreadable fragments — we fall back to the note's opening prose
// instead. Snippet-only: the raw content is still what BM25/dense indexed, so a
// URL-only term keeps the note findable; this just governs what's shown.
//   ![[img]] / ![alt](url) → ''        (embeds carry no readable text)
//   --- / *** / ___        → ''        (thematic breaks — this vault puts one
//                                        under every H1, so top-of-note chunks
//                                        would otherwise lead with `--- …`)
//   [[target|alias]]       → alias     (Obsidian's own display rule)
//   [[target#section]]     → target
//   [text](url)            → text
export function snippetPlainText(md: string): string {
    return md
        .replace(/!\[\[[^\]]*?\]\]/g, '')                       // ![[image]] embed
        .replace(/!\[[^\]]*?\]\([^)]*?\)/g, '')                 // ![alt](url) image
        .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '') // --- / *** / ___ rule
        .replace(/\[\[([^\]]+?)\]\]/g, (_m, inner: string) =>
            inner.includes('|') ? inner.slice(inner.lastIndexOf('|') + 1) : (inner.split('#')[0] || inner))
        .replace(/\[([^\]]*?)\]\([^)]*?\)/g, '$1');  // [text](url) → text
}

// fork 1.1.3 src/search.ts:4917 makeSnippet
// Window selection is passage scoring (passage.ts): BM25 over sentences with
// the live index's IDF, so the snippet shows the sentence that best explains
// the LEXICAL half of why this chunk ranked — not the earliest raw substring
// hit, which anchored on stopwords and mid-word fragments ("not" inside
// "cannot"). `terms` is built ONCE per query via buildPassageTerms; an empty
// array (browse / filter-only / dense-only fallback) yields the chunk head.
export function makeSnippet(content: string, terms: PassageTerm[], maxLen: number): string {
    const text = snippetPlainText(content);
    const { start, end } = passageWindow(text, terms, maxLen);
    let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
    if (start > 0) snippet = '…' + snippet;
    if (end < text.length) snippet = snippet + '…';
    return snippet;
}
