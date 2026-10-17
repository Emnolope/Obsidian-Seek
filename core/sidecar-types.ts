// The two result/input shapes of the sidecar hydrate, split out so core can name them without reaching the plugin's sidecar IO.
import type { Chunk } from './types.ts';

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
