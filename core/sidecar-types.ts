// The two result/input shapes of the sidecar hydrate, split out so core can name them without reaching the plugin's sidecar IO.
import type { Chunk } from './types.ts';
import type { QuantVec } from './quant.ts';

// fork 1.1.3 src/sidecar-sync.ts:44 ReChunkedNote
// One live note re-chunked locally: the liveness oracle's unit.
export interface ReChunkedNote {
    notePath: string;
    mtimeMs: number;
    chunks: Chunk[]; // each carries chunk_id
    contentHash?: string; // cyrb53 of the raw bytes — persisted so computeDelta can skip mtime-only re-stamps
}

// fork 1.1.3 src/sidecar-sync.ts:68 HydrateResult
export interface HydrateResult {
    scanned: number; // sidecar live records across accepted producers
    needed: number; // live ∩ sidecar, minus already-in-IDB (chunks)
    hydrated: number; // chunks actually written
    skippedPartialNotes: number; // notes skipped because a chunk's bytes weren't synced yet
    refusedProducers: number; // producers excluded by the version gate
    acceptedProducers: number;
    // A refused producer is at a HIGHER chunkerVersion than this build can read — i.e.
    // another device holds a newer index this plugin is too old to use. Distinct from
    // refusedProducers (which also counts merely-different/older/torn producers): this is
    // specifically "I'm behind, the user should update Seek". Drives the peer-ahead banner
    // and the mobile grind-stop (skip the futile local re-embed).
    peerAhead: boolean;
    hydratedNotePaths: string[]; // notes fully hydrated (a file record was written) — drives delta dedup
    // Corpus dense-cosine background inherited from the freshest accepted producer
    // (newest lastFullReindex) — the orchestrator writes it into local meta so a
    // hydrate-only device gets display calibration. Undefined if no producer
    // carried stats.
    bgMean?: number;
    bgStd?: number;
}

// fork 1.1.3 src/sidecar.ts:227 DeviceShard
export interface DeviceShard {
    seq: number;
    path: string;
    size: number;
}

// fork 1.1.3 src/sidecar.ts:809 CompactResult
export interface CompactResult {
    compacted: boolean;
    // why nothing happened (compacted:false), or 'done'. 'incomplete-rechunk' means the
    // live-id oracle reported a skipped note → unsafe to delete → retry next session.
    // 'format-mismatch' means the caller detected this device's own on-disk sidecar
    // predates the current SIDECAR_FORMAT and refused to decode it (see compactOwnSidecar).
    reason?: 'below-floor' | 'below-ratio' | 'nothing-dead' | 'incomplete-rechunk' | 'format-mismatch' | 'done';
    recordsBefore: number; // total jsonl record lines before
    recordsAfter: number;  // live records kept after
    bytesBefore: number;   // total shard bytes before
    bytesAfter: number;    // total shard bytes after
    shed: number;          // own-shard records dropped as unreadable/corrupt (expected 0)
    // Shard-file counts (post orphan-reclaim / post rewrite). The watch signal for
    // append-only flush proliferation (1A): if shardsBefore trends high while the
    // gates keep declining, the compaction trigger needs tightening.
    shardsBefore: number;
    shardsAfter: number;
}

// fork 1.1.3 src/sidecar.ts:998 CoalesceResult
export interface CoalesceResult {
    coalesced: boolean;
    reason?: 'below-count' | 'done';
    smallShards: number;  // small shards found (and, on 'done', deleted)
    shardsBefore: number;
    shardsAfter: number;
    bytesMoved: number;   // live bytes copied into dense shards
    shed: number;         // corrupt/unreadable source records dropped (expected 0)
    // Torn/unparseable jsonl lines the rewrite dropped (expected 0). Surfaced
    // because the swap permanently removes them: the caller should log the
    // breadcrumb before the on-disk evidence is gone.
    skippedLines: number;
}

// fork 1.1.3 src/sidecar-meta.ts:12 SidecarMeta
export interface SidecarMeta {
    format: number; // SIDECAR_FORMAT at write time
    modelId: string; // embedding model id (ml97)
    revision: string | null; // pinned model commit sha (or null = track main) — F10 gate
    chunkerVersion: number; // CHUNKER_VERSION at write time
    dim: number; // embedding dimension (384)
    deviceId: string;
    lastFullReindex: string | null; // ISO timestamp, informational
    // Corpus dense-cosine background (dense-stats.ts), so a hydrate-only device
    // (iOS that never runs a full reindex) inherits the producer's display
    // calibration instead of showing none. Optional + ignored by the version gate
    // (metaAccepts) — a producer that predates these fields just yields no
    // confidence on the consumer until someone full-reindexes.
    bgMean?: number;
    bgStd?: number;
    // Monotone shard-seq allocation floor, owned by sidecar.ts (raiseSeqFloorRaw):
    // raised whenever a max-seq shard is deleted with no higher seq left on disk
    // (crash-orphan reclaim, compact-to-empty, pre-rebuild clearDevice), so a
    // retired embeddings.<dev>.<seq>.bin filename is never republished with
    // different bytes — a peer may still hold the old file, and iCloud offers no
    // cross-file ordering, so a reused name would let fresh jsonl refs resolve
    // against stale bytes (records carry no id binding; the CRC passes). Optional
    // + ignored by metaAccepts. Most meta writers don't know it, so writeDeviceMeta
    // preserves the on-disk value unless the caller sets it explicitly.
    seqFloor?: number;
}

// fork 1.1.3 src/sidecar-meta.ts:39 MetaExpectation
export interface MetaExpectation {
    modelId: string;
    revision: string | null;
    chunkerVersion: number;
    dim: number;
}

// fork 1.1.3 src/sidecar-sync.ts:51 HydrateDeps (now generic over the file adapter)
export interface HydrateDeps<A = unknown> {
    adapter: A;
    indexDir: string;
    expect: MetaExpectation; // {modelId, chunkerVersion, dim} this consumer can reproduce
    reChunk: () => Promise<ReChunkedNote[]>; // live vault → re-chunked notes
    existingIds: () => Promise<Set<string>>; // chunk_ids already in IDB (skip — idempotent)
    putQuantized: (chunks: Chunk[], tiers: { q: QuantVec; bin: Uint8Array }[]) => Promise<void>;
    putFileRecord: (rec: { note_path: string; mtimeMs: number; chunk_ids: string[]; contentHash?: string }) => Promise<void>;
    // Version-gate refusal. Carries the producer meta (null = missing/unreadable)
    // and this consumer's expectation so the consumer can log WHAT is stale
    // (e.g. "chunker v3≠v4") and throttle to once per device+reason — a chunker
    // bump otherwise refuses the same producer on every reconcile / delta flush.
    onRefusedProducer?: (deviceId: string, meta: SidecarMeta | null, expect: MetaExpectation) => void;
    log?: (msg: string, detail: unknown) => void;
    batchSize?: number; // putQuantized batch size (default 500)
}
