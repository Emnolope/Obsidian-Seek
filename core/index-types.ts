// The pure half of index-store.ts: record shapes and the rules that decide what is dirty, orphaned or failed.
// IndexedDB itself stays in src/index-store.ts; this file must run anywhere (plugin, MCP, tests).
import type { Chunk, ChunkMeta } from './types.ts';

// Version of the META RECORD SHAPE (the MetaConfig field set), NOT the IDB store
// layout above. Written by every setMeta site in search.ts; carried into the
// identity tuple (identity.ts identityFromMeta → dbVersion) but deliberately not
// compared by identityMatches. Bump only when MetaConfig's field semantics change.
export const META_SCHEMA_VERSION = 2;

// Thrown by requireDb when the connection is null (closed by onunload, or by an
// onversionchange from another window/instance deleting the DB). Exported so the
// indexer's per-file commit catch can recognize it and abort the WHOLE pass fast,
// instead of logging one identical error per remaining file (the reindex storm).
export const STORE_NOT_OPENED = 'IndexStore not opened';
// Recognize the closed-store error. IndexedDB hands back a plain Error, so this is a
// message match — kept in ONE place (next to the thrower) so the indexer's "abort the
// whole pass on a closed store" check can't drift from requireDb's wording.
export function isStoreClosedError(e: unknown): boolean {
    return e instanceof Error && e.message === STORE_NOT_OPENED;
}
// Recognize the browser's storage-quota error (disk/IDB quota exhausted). IndexedDB
// surfaces it as a DOMException named 'QuotaExceededError' on the failed write.
// Matched by name, not instanceof: the error may originate in another realm
// (iframe/worker), where instanceof DOMException is false for the same error.
export function isQuotaError(e: unknown): boolean {
    return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'QuotaExceededError';
}

export interface FileRecord {
    note_path: string;
    mtimeMs: number;
    chunk_ids: string[];
    // cyrb53 of the file's raw bytes, written by every embed/hydrate commit.
    // computeDelta uses it to tell a real edit from a mtime-only re-stamp (iCloud
    // re-writes a synced file's mtime without touching its bytes — on iOS that
    // otherwise re-embeds identical content every couple seconds). Optional:
    // records written before this field shipped lack it and fall back to the
    // mtime-only path, which backfills the hash on their next re-embed.
    contentHash?: string;
    // ── Embed-failure quarantine (issue #4) ─────────────────────────────────
    // Set when ≥1 of this file's chunks DETERMINISTICALLY failed to embed: the
    // failure survived the batch retry AND a solo retry, each behind a fresh-
    // device recycle. The record commits the chunks that DID embed and pins the
    // file 'clean' for classifyFileDelta — without it the file has no record,
    // every computeDelta reports it dirty, and each retry costs two iframe
    // teardowns + ~250 MB model reloads on every reconcile poll while wedging
    // reconcileIdentityInPlace in 'drained' (the identity never stamps).
    // The quarantine lifts when: the content changes (contentHash mismatch), a
    // full reindex runs (records nuked), a peer's sidecar fully covers the file
    // (hydrate overwrites this record — hydrate keys candidacy on missing
    // chunk_ids, so a partial file stays eligible), or the plugin version
    // advances (rule in classifyFileDelta: one retry per release, so a shipped
    // embed-path fix un-quarantines the fleet automatically).
    embedFailedChunks?: number;      // how many chunks are missing from chunk_ids
    embedFailPluginVersion?: string; // build that recorded the failure
}

// Referential-integrity orphan finder: chunk_ids present in the index but
// referenced by NO FILES record. Orphans are a file's chunks left behind when its
// record was overwritten (hydrate / applyDelta replacing a changed note's ids) or
// its delete event was missed; they sit in chunk_meta, so they can surface stale
// content until removed. Pure set difference, input-order-stable for deterministic
// batching; the sweep (search.ts sweepOrphanChunks) deletes the result.
export function findOrphanChunkIds(allChunkIds: string[], referenced: ReadonlySet<string>): string[] {
    return allChunkIds.filter(id => !referenced.has(id));
}

// Pure per-file delta classification — the single source of truth for the
// "is this file dirty?" rule, exported so it can be unit-tested without an
// IndexStore or Vault. computeDelta consults it twice: once on cheap metadata
// (mtime), and again with the freshly-hashed bytes only when the first call
// asks for them ('check-bytes'). This two-phase shape keeps the (potentially
// vault-wide) content read OFF every clean file while still distinguishing a
// real edit from an iCloud mtime-only re-stamp.
//   'dirty'       — (re)embed: never indexed, no stored hash (legacy → backfill),
//                   or the bytes changed.
//   'clean'       — up to date; skip.
//   'check-bytes' — mtime moved on a hash-bearing record; the caller must read
//                   the bytes, hash them, and re-call with `liveHash`.
export type DeltaDecision = 'dirty' | 'clean' | 'check-bytes';
export function classifyFileDelta(
    prev: Pick<FileRecord, 'mtimeMs' | 'contentHash' | 'embedFailPluginVersion'> | undefined,
    liveMtime: number,
    liveHash?: string,
    livePluginVersion?: string,
): DeltaDecision {
    if (prev === undefined) return 'dirty';            // never indexed
    // Embed-failure quarantine, retry-per-release: a record quarantined by a
    // DIFFERENT build is dirty regardless of mtime/hash — the new build may have
    // fixed the embed path, and one attempt per release is bounded. Same-build
    // quarantine falls through to the normal rules, where the unchanged
    // mtime/hash reads 'clean' (that IS the quarantine: no retry churn).
    if (prev.embedFailPluginVersion !== undefined && livePluginVersion !== undefined
        && prev.embedFailPluginVersion !== livePluginVersion) return 'dirty';
    // Strict equality, not <=: an mtime REGRESSION (file restored from backup /
    // iCloud conflict resolved to the older copy) carries different bytes behind
    // an older stamp — '<=' classified it clean and the index served the phantom
    // newer content forever. Regression now takes the same hash check as an
    // advance; genuine clock skew with identical bytes still resolves clean.
    if (liveMtime === prev.mtimeMs) return 'clean';    // mtime unchanged
    if (prev.contentHash === undefined) return 'dirty'; // legacy record → re-embed backfills the hash
    if (liveHash === undefined) return 'check-bytes';  // need the bytes to decide
    return liveHash === prev.contentHash ? 'clean' : 'dirty';
}

export interface MetaConfig {
    embeddingDim: number;
    lastIndexedAt: string | null;
    schemaVersion: number;
    // Embedding model that produced the stored vectors. Optional — indexes
    // written before 2026-06-10 lack it (they are all english-r2). Used by
    // main.ts to surface "settings model ≠ index model → reindex needed";
    // never read in ranking.
    modelId?: string;
    // ── Index version identity (2026-06-20) ───────────────────────────────────
    // The build fingerprint the stored vectors + chunk_ids were produced under.
    // Optional — indexes written before this date lack them, so identityMatches
    // (identity.ts) reads them as a version mismatch and routes the index through
    // a one-time rebuild. Stamped ONLY by a full reindex / rebuild-from-sidecar;
    // a delta carries the prior values forward, because only a full rebuild may
    // honestly claim a new identity (mirrors how modelId/bgMean are preserved on
    // an incremental). See identity.ts for which fields gate a rebuild and why
    // analyzerVersion + dbVersion are deliberately excluded from that gate.
    chunkerVersion?: number;
    analyzerVersion?: string;
    revision?: string | null;
    // Corpus dense-cosine background (see dense-stats.ts). Drive the
    // corpus-AGNOSTIC display calibration + answerability gate: z = (cos − bgMean)
    // / bgStd is unitless and transfers across vaults/encoders. Computed at FULL
    // reindex only; a delta carries them forward (coarse corpus globals a few
    // changed files barely move). Absent ⇒ calibration off (corpus below
    // MIN_BG_SAMPLE, or an index built before these fields existed). NOT a
    // ranking input — folding them into fusion measured −0.0135 nDCG@10.
    bgMean?: number;
    bgStd?: number;
}

// Project a Chunk to its metadata (everything except the body) for the
// chunk_meta store; the body is stored separately in chunk_body. The rest-
// capture tracks Chunk automatically as fields are added.
export function stripContent(c: Chunk): ChunkMeta {
    const { content, ...meta } = c;
    void content;
    return meta;
}

export interface IndexIdentity {
    dbVersion: number; // IndexedDB schema (index-store.ts) — enforced natively by IDB's onupgradeneeded
    chunkerVersion: number; // chunk content+suffix derivation (chunker.ts) — feeds both embed bytes AND chunk_id
    analyzerVersion: string; // BM25 token space / scoring (bm25.ts) — lexical-only, esbuild-injected ('dev' under vitest)
    sidecarFormat: number; // cross-device file protocol (sidecar.ts)
    modelId: string; // embedding model repo (embedder.ts)
    revision: string | null; // pinned model commit sha, or null = track main (embedder.ts)
    dim: number; // embedding dimension (embedder.ts)
}

// Should an index-write pass STAMP the live build identity into its meta (and refit
// the dense-cosine background), versus carry the prior meta's fields forward unchanged?
//
//   • A FULL reindex always stamps — it rebuilt the whole index from the live build.
//   • An INCREMENTAL pass normally preserves prevMeta, so a few changed files can't
//     re-stamp a stale index as current — EXCEPT the cold first-build, where the store
//     was empty when the pass began. That pass IS the current build (every chunk it
//     writes is freshly embedded by this build) AND, as one whole-vault incremental,
//     it saw the entire corpus — so it claims the live identity + computes the
//     background, exactly like a full reindex.
//
// The emptiness gate is load-bearing and deliberately strict: a NON-empty store that
// happens to carry no identity is a LEGACY index (older chunker/model, written before
// the identity fields existed). It must stay "stale" so the version gate rebuilds it —
// stamping the live identity onto it would falsely mark old-chunker/old-model vectors
// as current. So the trigger is "store was empty", never "prevMeta lacks identity".
//
// This is the fix for the spurious-heal loop: a cold build that copied the empty meta's
// absent identity wrote `undefined`, which identityFromMeta maps to a guaranteed
// mismatch (-1 / null), so the gate re-launched a full reindex forever.
export function shouldStampLiveIdentity(mode: 'full' | 'incremental', storeWasEmpty: boolean): boolean {
    return mode === 'full' || storeWasEmpty;
}
