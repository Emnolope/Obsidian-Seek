// The on-disk index format, shared by the Obsidian plugin (reads + writes) and
// the MCP server (reads). Pure: no Obsidian, no node:fs, no DOM. Both sides hand
// it text/bytes and keep their own I/O. The compiler enforces this via tsconfig.core.json.
//
// Moved verbatim from src/sidecar.ts; that file re-exports everything here.

import { EMBEDDING_DIM, SIDECAR_FORMAT } from './contract.ts';
export { SIDECAR_FORMAT };

// ---- record layout (matches IndexStore DB v6 persisted tiers) ----

// Q_BYTES / SIGN_BYTES derive from EMBEDDING_DIM (contract.ts). model-registry.test
// pins ACTIVE_MODEL_SPEC.dim to it, so the stride can't silently disagree with the model. SIGN_BYTES === ceil(dim/8) matches binary.ts packSignBits() exactly.
export const Q_BYTES = EMBEDDING_DIM; // int8 rerank tier, one byte per dim
// f64 dequant scale (little-endian). Was f32 (4 B) — truncating to float32 here
// while IndexedDB's `embeddings` store kept the untruncated float64 `s` meant a
// hydrated peer dequantized with a slightly different scale than the originating
// device, producing ~1e-7 score divergence on near-ties. f64 matches IDB exactly
// (verbatim byte-copy hydration, as the module header promises) at a cost of 4
// extra bytes/record (~1% of the 440 B stride).
export const S_BYTES = 8;
export const SIGN_BYTES = (Q_BYTES + 7) >> 3; // packed sign bits for the candidate tier (ceil(dim/8))
export const CRC_BYTES = 4; // CRC-32 over [q|s|sign] — detects in-range sync bit-rot (GAP-1)
export const RECORD_PAYLOAD_BYTES = Q_BYTES + S_BYTES + SIGN_BYTES; // 440 — the CRC covers exactly this prefix
export const VEC_BYTES = RECORD_PAYLOAD_BYTES + CRC_BYTES; // 444 — fixed per-record stride
export const DIM = Q_BYTES; // logical embedding dimension

// Per-shard cap. Obsidian Sync's default per-file limit is 5 MB; staying at 4 MB
// keeps headroom and bounds iCloud whole-file re-upload cost on each append.
export const SHARD_CAP_BYTES = 4 * 1024 * 1024;
export const MAX_VECTORS_PER_SHARD = Math.floor(SHARD_CAP_BYTES / VEC_BYTES);


// One chunk's persisted tiers — the unit the sidecar stores and hydration writes back.
export interface TierBytes {
    q: Int8Array; // length Q_BYTES — int8 quantized vector
    s: number; // dequant scale (vᵢ ≈ qᵢ·s)
    sign: Uint8Array; // length SIGN_BYTES — packed sign bits from the TRUE fp32 vector
}

export interface VectorRecord {
    id: string; // chunk_id (path-salted content hash)
    dim: number;
    shard: string; // owning deviceId
    seq: number; // rotation sequence within this device's shards (0, 1, 2, ...)
    off: number; // byte offset of this record within the shard
    mtime: number;
    tombstone?: false;
}

export interface TombstoneRecord {
    id: string;
    shard: string; // owning deviceId — tombstones suppress only same-device records
    tombstone: true;
    mtime: number;
}

export type IndexRecord = VectorRecord | TombstoneRecord;

export interface ResolvedEntry {
    id: string;
    shard: string;
    seq: number;
    off: number;
    mtime: number;
    dim: number; // stored embedding dim — asserted at decode so a stride mismatch fails loud (F9)
}


export function isTombstone(r: IndexRecord): r is TombstoneRecord {
    return (r as TombstoneRecord).tombstone === true;
}

// Record-level shape guard for a parsed jsonl line. A torn mid-write can leave a
// line that is valid JSON but the wrong shape (missing off, non-numeric seq);
// without this, such a record reaches the perId map and the seq/off arithmetic in
// scanJsonl. Tombstone-discriminated: a tombstone needs only id/shard/mtime, a
// vector record additionally needs numeric seq/off. This is the record-level
// complement to the byte-level isOffsetInRange guard at the shard layer.
export function isValidRecord(r: unknown): r is IndexRecord {
    if (typeof r !== 'object' || r === null) return false;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.shard !== 'string' || typeof o.mtime !== 'number') return false;
    if (o.tombstone === true) return true;
    return typeof o.seq === 'number' && typeof o.off === 'number';
}

// ---- 444 B record codec ----

// CRC-32 (IEEE 802.3) over a byte range. Detects an in-range bit-flip in a synced
// shard that would otherwise make the sign tier (stage-1) and the int8 tier
// (stage-2) silently disagree with no detector (GAP-1). Lazy 256-entry table;
// ~µs per 440 B payload.
let CRC32_TABLE: Uint32Array | null = null;
export function crc32(bytes: Uint8Array, start: number, end: number): number {
    let table = CRC32_TABLE;
    if (!table) {
        table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            table[n] = c >>> 0;
        }
        CRC32_TABLE = table;
    }
    let crc = 0xFFFFFFFF;
    for (let i = start; i < end; i++) crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Pack one chunk's tiers into a 444 B record: [q:384 | s:f64LE:8 | sign:48 | crc:u32LE:4].
export function encodeRecord(t: TierBytes): Uint8Array {
    if (t.q.length !== Q_BYTES) throw new Error(`encodeRecord: q length ${t.q.length} != ${Q_BYTES}`);
    if (t.sign.length !== SIGN_BYTES) throw new Error(`encodeRecord: sign length ${t.sign.length} != ${SIGN_BYTES}`);
    const out = new Uint8Array(VEC_BYTES);
    out.set(new Uint8Array(t.q.buffer, t.q.byteOffset, Q_BYTES), 0); // int8 bytes reinterpreted as u8 — same bytes
    new DataView(out.buffer).setFloat64(Q_BYTES, t.s, true); // little-endian scale, full IDB precision
    out.set(t.sign, Q_BYTES + S_BYTES);
    // Trailing CRC-32 over [q|s|sign], little-endian (GAP-1).
    new DataView(out.buffer).setUint32(RECORD_PAYLOAD_BYTES, crc32(out, 0, RECORD_PAYLOAD_BYTES), true);
    return out;
}

// Slice a 444 B record out of a shard buffer at byte offset `off`. Caller must
// have validated isOffsetInRange first (or accept a throw on a short buffer).
// Throws on a CRC mismatch (corrupt record) or a dim≠DIM stride mismatch — both
// are "skip this record" conditions the hydrate callers catch and treat as null.
export function decodeRecord(buf: ArrayBuffer, off: number, expectedDim: number = DIM): TierBytes {
    if (expectedDim !== DIM) {
        throw new Error(`decodeRecord: record dim ${expectedDim} != ${DIM} — stride mismatch, refusing to mis-slice`);
    }
    if (!isOffsetInRange(buf.byteLength, off)) {
        throw new Error(`decodeRecord: off ${off} + ${VEC_BYTES} exceeds buffer ${buf.byteLength}`);
    }
    const bytes = new Uint8Array(buf);
    const stored = new DataView(buf).getUint32(off + RECORD_PAYLOAD_BYTES, true);
    const computed = crc32(bytes, off, off + RECORD_PAYLOAD_BYTES);
    if (stored !== computed) {
        throw new Error(`decodeRecord: CRC mismatch at off ${off} (stored ${stored}, computed ${computed}) — corrupt record`);
    }
    const q = new Int8Array(buf.slice(off, off + Q_BYTES));
    const s = new DataView(buf).getFloat64(off + Q_BYTES, true);
    const sign = new Uint8Array(buf.slice(off + Q_BYTES + S_BYTES, off + RECORD_PAYLOAD_BYTES));
    return { q, s, sign };
}

// Partial-arrival guard: a jsonl record can sync before its shard's bytes, or
// point past the synced length. Out-of-range → "not yet available", skip this
// pass, picked up on the next reconcile. Never an error.
export function isOffsetInRange(binSize: number, off: number): boolean {
    return off >= 0 && off + VEC_BYTES <= binSize;
}

// ---- path helpers ----

export function shardPathFor(indexDir: string, deviceId: string, seq: number): string {
    return `${indexDir}/embeddings.${deviceId}.${seq}.bin`;
}

export function jsonlPathFor(indexDir: string, deviceId: string): string {
    return `${indexDir}/index.${deviceId}.jsonl`;
}

export function metaPathFor(indexDir: string, deviceId: string): string {
    return `${indexDir}/meta.${deviceId}.json`;
}

// Cross-device BM25 sync artifact (Phase 3) — a gzipped, corpus-global MiniSearch
// blob a fresh/evicted device loads instead of refitting over all bodies. Per-device-
// written + freshest-picked (like the vector sidecar) so it inherits the structural
// conflict-immunity even though BM25 postings are corpus-global, not per-device. The
// `.json.gz` suffix matches NEITHER SHARD_RE nor JSONL_RE below, so the vector
// scanners AND sidecarDirSignature ignore it — a device that predates Phase 3 never
// reads it and just refits, exactly as before (graceful degrade, no format bump).
export function bm25PathFor(indexDir: string, deviceId: string): string {
    return `${indexDir}/bm25.${deviceId}.json.gz`;
}

// deviceIds are `mobile-9f3a1c08` / `desktop-2b7e54aa` — alnum + dash, never a
// dot or space. The strict patterns below therefore exclude sync conflict copies
// ("index.dev 2.jsonl", "embeddings.dev.0 2.bin"), which always carry a space.
export const SHARD_RE = /^embeddings\.([A-Za-z0-9-]+)\.(\d+)\.bin$/;
export const JSONL_RE = /^index\.([A-Za-z0-9-]+)\.jsonl$/;
export const META_RE = /^meta\.([A-Za-z0-9-]+)\.json$/;       // matches NEITHER bm25.*.json.gz nor *.json.tmp
export const BM25_RE = /^bm25\.([A-Za-z0-9-]+)\.json\.gz$/;   // matches NEITHER meta.*.json nor *.json.gz.tmp

// ---- jsonl parse + resolve (pure halves of scanJsonl; I/O stays with the caller) ----

// Strips a trailing partial line (no newline) — protects against truncated writes.
export function parseJsonl(raw: string): { records: IndexRecord[]; skipped: number } {
    if (raw.length === 0) return { records: [], skipped: 0 };
    const endsWithNewline = raw.endsWith('\n');
    const lines = raw.split('\n');
    const stop = endsWithNewline ? lines.length : lines.length - 1;
    const records: IndexRecord[] = [];
    let skipped = 0;
    for (let i = 0; i < stop; i++) {
        const line = lines[i];
        if (!line || line.trim().length === 0) continue;
        try {
            const rec: unknown = JSON.parse(line);
            if (!isValidRecord(rec)) { skipped++; continue; }
            records.push(rec);
        } catch {
            skipped++;
        }
    }
    if (!endsWithNewline && lines[lines.length - 1].trim().length > 0) skipped++;
    return { records, skipped };
}

// Within one device, which record is the latest? Higher mtime wins; at equal mtime
// a tombstone beats a live record (sticky delete), two live records break by
// seq then off, two tombstones keep the incumbent.
export function winsWithinDevice(challenger: IndexRecord, incumbent: IndexRecord): boolean {
    if (challenger.mtime !== incumbent.mtime) return challenger.mtime > incumbent.mtime;
    const cT = isTombstone(challenger);
    const iT = isTombstone(incumbent);
    if (cT && !iT) return true;
    if (!cT && iT) return false;
    if (cT && iT) return false;
    const cV = challenger as VectorRecord;
    const iV = incumbent as VectorRecord;
    if ((cV.seq ?? 0) !== (iV.seq ?? 0)) return (cV.seq ?? 0) > (iV.seq ?? 0);
    return cV.off > iV.off;
}

// Across devices (both records live): higher mtime wins; at equal mtime the
// lex-larger deviceId wins — deterministic everywhere regardless of jsonl order.
export function crossDeviceWins(challenger: VectorRecord, incumbent: VectorRecord): boolean {
    if (challenger.mtime !== incumbent.mtime) return challenger.mtime > incumbent.mtime;
    if (challenger.shard !== incumbent.shard) return challenger.shard > incumbent.shard;
    if ((challenger.seq ?? 0) !== (incumbent.seq ?? 0)) return (challenger.seq ?? 0) > (incumbent.seq ?? 0);
    return challenger.off > incumbent.off;
}

export interface ResolveResult {
    map: Map<string, ResolvedEntry>; // id → winning live record location
    tombstoneIds: Set<string>; // ids whose every device's latest record is a tombstone
    recordCount: number;
    skippedLines: number;
}

// Fold all devices' jsonl texts into one resolved id→location map. Two-level resolution:
// first the latest record per (id, device), then the cross-device winner among the
// devices whose latest is live. A tombstone removes only its own device's
// contribution; an id maps to a live record as long as ANY device still has one.
export function resolveJsonls(raws: Iterable<string>): ResolveResult {
    const perId = new Map<string, Map<string, IndexRecord>>(); // id → (deviceId → latest record)
    let total = 0;
    let skipped = 0;
    for (const raw of raws) {
        const { records, skipped: s } = parseJsonl(raw);
        skipped += s;
        total += records.length;
        for (const r of records) {
            let byDev = perId.get(r.id);
            if (!byDev) {
                byDev = new Map();
                perId.set(r.id, byDev);
            }
            const prev = byDev.get(r.shard);
            if (!prev || winsWithinDevice(r, prev)) byDev.set(r.shard, r);
        }
    }
    const map = new Map<string, ResolvedEntry>();
    const tombstoneIds = new Set<string>();
    for (const [id, byDev] of perId) {
        let winner: VectorRecord | null = null;
        for (const rec of byDev.values()) {
            if (isTombstone(rec)) continue; // this device's latest is a delete → no contribution
            if (!winner || crossDeviceWins(rec, winner)) winner = rec;
        }
        if (winner) {
            map.set(id, { id, shard: winner.shard, seq: winner.seq ?? 0, off: winner.off, mtime: winner.mtime, dim: winner.dim });
        } else {
            tombstoneIds.add(id); // no device has a live copy
        }
    }
    return { map, tombstoneIds, recordCount: total, skippedLines: skipped };
}

export function isJsonlName(name: string): boolean { return JSONL_RE.test(name); }
