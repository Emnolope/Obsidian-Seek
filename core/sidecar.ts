// fork 1.1.3: whole file moved from src/sidecar.ts
// Sidecar: a vault-file representation of the vector index that sync providers
// (iCloud / Obsidian Sync) carry between devices and that survives WebKit's
// eviction of IndexedDB on iOS. Lifted from the validated spike at
// github.com/tooape/embeddinggemmaiostest (baseline commit c7198ce) and adapted
// for production Seek:
//   - fixed record stride [q:int8×dim | s:f64 | signbits:ceil(dim/8) | crc] — the
//     persisted DB v6 tiers verbatim, NOT fp32 (hydration is a byte copy). The
//     scale is stored at the SAME float64 width IndexedDB's `embeddings` store
//     keeps it at (quantizeInt8's raw `maxAbs / 127`, never truncated) — a
//     hydrated peer must dequantize with the bit-identical scale the producer
//     used, or the two devices' cosine scores diverge on a near-tie. The stride
//     is derived from the active model's dim (see Q_BYTES below), so a model
//     swap re-sizes it automatically; metaAccepts gates cross-dim hydration.
//   - per-device `index.<deviceId>.jsonl` — every file has exactly one writer,
//     readers union all devices' jsonls. Sync providers never merge, so a shared
//     jsonl would lose writes / spawn conflict copies (the shared-NDJSON-log
//     lesson). Per-device files make sync conflicts structurally impossible.
//   - no `.compacting` cross-device sentinel — compaction touches only the
//     owning device's own files, so the in-process dir mutex is sufficient.
//   - tombstones suppress only SAME-device records — liveness is ultimately
//     decided by the consumer's local re-chunk intersection, so device A's
//     delete must never erase device B's live copy of the same content-hash id.
//   - 4 MB shard cap (Obsidian Sync's default per-file limit is 5 MB).
//
// This module is a file-format library: it knows nothing about IndexStore or
// chunking. Its ONE model dependency is the embedding dimension
// (ACTIVE_MODEL_SPEC.dim), which sets the record stride. SidecarSync
// (sidecar-sync.ts) is the orchestration.

// The sidecar code was written against Obsidian's DataAdapter; core names the slice it uses, aliased so the bodies read as they did.
import type { FileAdapter as DataAdapter } from './file-adapter.ts';
// The pure format (record layout, codec, resolution rules) lives in core/ so the
// MCP server reads the same bytes with the same rules. Re-exported: callers unchanged.
import {
    parseJsonl, resolveJsonls, shardPathFor, jsonlPathFor, metaPathFor, bm25PathFor, isOffsetInRange,
    decodeRecord, encodeRecord, isTombstone, JSONL_RE, SHARD_RE, META_RE, BM25_RE, SIDECAR_FORMAT,
    VEC_BYTES, Q_BYTES, SIGN_BYTES, DIM, SHARD_CAP_BYTES, MAX_VECTORS_PER_SHARD,
    type IndexRecord, type ResolvedEntry, type ResolveResult, type TierBytes, type VectorRecord, type TombstoneRecord,
} from './format.ts';
import type { DeviceShard, CompactResult, CoalesceResult } from './sidecar-types.ts';
export type { DeviceShard, CompactResult, CoalesceResult } from './sidecar-types.ts';
export * from './format.ts';

export interface ScanResult extends ResolveResult {
    parseMs: number;
}



function baseName(path: string): string {
    return path.split('/').pop() ?? '';
}

async function exists(adapter: DataAdapter, path: string): Promise<boolean> {
    return adapter.exists(path).catch(() => false);
}

// Obsidian's adapter.write/writeBinary do NOT create parent directories — ensure
// the index dir exists before the first write. Idempotent; tolerates "already exists".
export async function ensureDir(adapter: DataAdapter, dir: string): Promise<void> {
    try {
        if (!(await exists(adapter, dir))) await adapter.mkdir(dir);
    } catch {
        /* already exists or unsupported — writes below will surface a real failure */
    }
}

// List every device's index jsonl under `indexDir`, sorted, conflict copies excluded.
export async function listDeviceJsonls(adapter: DataAdapter, indexDir: string): Promise<string[]> {
    if (!(await exists(adapter, indexDir))) return [];
    const ls = await adapter.list(indexDir).catch(() => ({ folders: [] as string[], files: [] as string[] }));
    const out: string[] = [];
    for (const f of ls.files) {
        if (JSONL_RE.test(baseName(f))) out.push(f);
    }
    return out.sort();
}

// List every device's meta.<deviceId>.json under `indexDir`, sorted, conflict
// copies excluded. Mirrors listDeviceJsonls; sidecarDirSignature watches these
// too so a producer's version-gate meta update is never missed.
export async function listDeviceMetas(adapter: DataAdapter, indexDir: string): Promise<string[]> {
    if (!(await exists(adapter, indexDir))) return [];
    const ls = await adapter.list(indexDir).catch(() => ({ folders: [] as string[], files: [] as string[] }));
    const out: string[] = [];
    for (const f of ls.files) {
        if (META_RE.test(baseName(f))) out.push(f);
    }
    return out.sort();
}

// Cheap change-signature for the index dir: each device jsonl's AND meta's (path,
// size, mtime). Lets the periodic reconcile skip the expensive whole-vault
// re-chunk when no device file has changed since the last run — a handful of
// stat calls vs. re-reading and re-chunking every note. Any append (size/mtime)
// or new device file (path/count) changes the signature; a missing stat sorts to
// -1. meta.<deviceId>.json is watched alongside the jsonls (not just jsonls
// alone) because a version-refused producer's meta rewrite — e.g. a
// chunkerVersion bump after a full reindex — doesn't necessarily land in the
// same instant as its next jsonl append; omitting it left that meta update
// unnoticed until the jsonl eventually changed too.
//
// `selfDeviceId` (when supplied) excludes the LOCAL device's own jsonl/meta from
// the signature, so a device's own writes cannot wake its own reconcile — only a
// PEER change should. Without this, a mobile catch-up burst writing to
// index.<self>.jsonl flips the signature and self-triggers a whole-vault
// reChunkLive, the device's own writes endlessly waking its own sweep. Own
// writes never carry new peer data (the local index already has them), so the
// exclusion loses nothing; the empty-store branch in shouldReconcileSidecar
// still forces recovery for an evicted/fresh device regardless. The persisted
// and live signatures must both be computed with the SAME selfDeviceId for the
// comparison to hold.
export async function sidecarDirSignature(adapter: DataAdapter, indexDir: string, selfDeviceId?: string): Promise<string> {
    const jsonls = await listDeviceJsonls(adapter, indexDir);
    const metas = await listDeviceMetas(adapter, indexDir);
    const parts: string[] = [];
    for (const p of jsonls) {
        if (selfDeviceId && deviceIdFromJsonlPath(p) === selfDeviceId) continue;
        const st = await adapter.stat(p).catch(() => null);
        parts.push(`${p}:${st?.size ?? -1}:${st?.mtime ?? -1}`);
    }
    for (const p of metas) {
        if (selfDeviceId && deviceIdFromArtifactPath(p) === selfDeviceId) continue;
        const st = await adapter.stat(p).catch(() => null);
        parts.push(`${p}:${st?.size ?? -1}:${st?.mtime ?? -1}`);
    }
    return parts.join('|');
}

// Decide whether the whole-vault hydrate sweep must run, given the live sidecar
// signature, the signature persisted at the last successful reconcile, and
// whether the local index is empty. The sweep is expensive (reChunkLive reads +
// re-chunks every note on the main thread on mobile), so we skip it whenever the
// sidecar dir is byte-identical to last time. The empty-store branch is
// MANDATORY and dominates: an evicted or fresh device trivially "matches" a null
// persisted sig, but it has lost its index and MUST sweep to recover — skipping
// there is the silent-no-results failure. Pure so the gate is unit-testable.
export function shouldReconcileSidecar(
    liveSig: string,
    persistedSig: string | null,
    indexEmpty: boolean,
): boolean {
    if (indexEmpty) return true;        // eviction / fresh device — recover regardless of sig
    return liveSig !== persistedSig;    // otherwise skip only when nothing changed
}

// True when `meta` — this DEVICE'S OWN last-written sidecar meta — predates
// `currentFormat` (defaults to the live SIDECAR_FORMAT). A mismatch means the
// on-disk shard bytes for this device may still use an OLDER record stride than
// decodeRecord (fixed to the current S_BYTES/VEC_BYTES constants) expects — a
// SIDECAR_FORMAT bump is deliberately excluded from identityMatches (it governs
// only the cross-device file protocol, not local IDB validity — identity.ts), so
// nothing else forces a full reindex (the only path that clears it via
// clearDevice) just because the format constant moved. A null meta (fresh
// install, nothing written yet) is NOT stale — there is nothing on disk to
// misread. Shared by compactOwnSidecar (refuse to decode + wipe instead of
// misreading stale-stride bytes as corrupt) and the sidecar-commit write path
// (wipe before the meta write claims a format the actual bytes don't have yet)
// so the two call sites can't drift out of sync. Pure so the gate is
// unit-testable without a SearchOrchestrator harness.
export function staleSidecarFormat(meta: { format: number } | null, currentFormat: number = SIDECAR_FORMAT): boolean {
    return meta !== null && meta.format !== currentFormat;
}

// Extract the owning deviceId from an `index.<deviceId>.jsonl` path, or null if
// the basename isn't a strict device jsonl (e.g. a conflict copy).
export function deviceIdFromJsonlPath(path: string): string | null {
    const m = JSONL_RE.exec(baseName(path));
    return m ? m[1] : null;
}

// Extract the owning deviceId from ANY per-device sidecar artifact path — shard,
// jsonl, meta, or the cross-device BM25 blob — or null if the basename doesn't
// match one of the strict per-device patterns (conflict copy, unrelated file).
// Shared by every caller that needs "whose file is this", notably
// sweepOrphanTmpFiles' peer-file guard: a .tmp's REAL name (after stripping
// '.tmp') matches one of these same four patterns, so this also resolves the
// owner of an in-flight atomic write.
function deviceIdFromArtifactPath(path: string): string | null {
    const b = baseName(path);
    const m = SHARD_RE.exec(b) ?? JSONL_RE.exec(b) ?? META_RE.exec(b) ?? BM25_RE.exec(b);
    return m ? m[1] : null;
}

// Every deviceId that owns ANY sidecar artifact under `indexDir` — vector shard,
// jsonl log, version meta, OR cross-device BM25 blob — deduped to one id apiece.
// The reap/clear path enumerates by THIS union, never by jsonl alone: clearDevice
// removes a device's four file types best-effort and non-atomically, and a sync
// provider propagates each file independently, so a dead device's jsonl can vanish
// while its meta/bm25/shards linger. A jsonl-keyed reap would never revisit those
// leftovers → a permanent disk leak (they're gated out of results by metaAccepts,
// so never WRONG — but the bytes accumulate, and on iOS that pressure feeds the
// very eviction the sidecar exists to survive). Folding every artifact's deviceId
// into one set lets the next reap re-find a half-cleared device and let
// clearDevice (idempotent, exists-guarded) finish it → eventually-consistent
// cleanup, no atomic multi-file delete required. Conflict copies ("…dev 2.json")
// and .tmp leftovers are excluded by the same strict patterns the scanners use
// (sweepOrphanTmpFiles owns the .tmp class).
export async function listSidecarDeviceIds(adapter: DataAdapter, indexDir: string): Promise<string[]> {
    if (!(await exists(adapter, indexDir))) return [];
    const ls = await adapter.list(indexDir).catch(() => ({ folders: [] as string[], files: [] as string[] }));
    const ids = new Set<string>();
    for (const f of ls.files) {
        const dev = deviceIdFromArtifactPath(f);
        if (dev) ids.add(dev);
    }
    return [...ids].sort();
}

// List all shards belonging to `deviceId`, sorted by seq ascending.
export async function listDeviceShards(adapter: DataAdapter, indexDir: string, deviceId: string): Promise<DeviceShard[]> {
    if (!(await exists(adapter, indexDir))) return [];
    const ls = await adapter.list(indexDir).catch(() => ({ folders: [] as string[], files: [] as string[] }));
    const out: DeviceShard[] = [];
    for (const f of ls.files) {
        const m = SHARD_RE.exec(baseName(f));
        if (!m || m[1] !== deviceId) continue;
        const seq = parseInt(m[2], 10);
        if (!Number.isFinite(seq)) continue;
        const stat = await adapter.stat(f).catch(() => null);
        out.push({ seq, path: f, size: stat?.size ?? 0 });
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
}

// ---- JSONL reader + resolver ----

async function readJsonlRaw(adapter: DataAdapter, path: string): Promise<string> {
    if (!(await exists(adapter, path))) return '';
    return adapter.read(path);
}

async function readJsonl(adapter: DataAdapter, path: string): Promise<{ records: IndexRecord[]; skipped: number }> {
    return parseJsonl(await readJsonlRaw(adapter, path));
}

// Folds all devices' jsonls into one resolved id→location map (rules in core/format.ts).
export async function scanJsonl(adapter: DataAdapter, paths: string[]): Promise<ScanResult> {
    const t0 = performance.now();
    const raws: string[] = [];
    for (const path of paths) raws.push(await readJsonlRaw(adapter, path));
    return { ...resolveJsonls(raws), parseMs: performance.now() - t0 };
}

// ---- read paths ----

// Read one resolved record's tiers. Returns null when the shard is missing or the
// offset is past the synced length (partial arrival) — caller skips, self-heals next pass.
export async function readRecordAt(adapter: DataAdapter, indexDir: string, entry: ResolvedEntry): Promise<TierBytes | null> {
    const path = shardPathFor(indexDir, entry.shard, entry.seq);
    const buf = await adapter.readBinary(path).catch(() => null);
    if (!buf) return null;
    if (!isOffsetInRange(buf.byteLength, entry.off)) return null;
    // dim mismatch or CRC failure (corrupt record) → skip, re-embed next pass.
    try { return decodeRecord(buf, entry.off, entry.dim); }
    catch { return null; }
}

// ---- atomic write: temp + rename ----

// Write to `${path}.tmp` then atomically swap in. A crash mid-write leaves the
// existing file intact; sweepOrphanTmpFiles recovers the .tmp on next load.
async function writeBinaryAtomic(adapter: DataAdapter, path: string, buffer: ArrayBuffer): Promise<void> {
    const tmp = path + '.tmp';
    await adapter.writeBinary(tmp, buffer);
    try {
        await adapter.rename(tmp, path);
    } catch {
        // Fallback for platforms where rename-over-existing fails (iOS Capacitor).
        if (await exists(adapter, path)) await adapter.remove(path);
        await adapter.rename(tmp, path);
    }
}

// Write text via the same temp + atomic-rename dance as writeBinaryAtomic. Used
// for the jsonl read+rewrite fallback and the device-meta write so a crash
// mid-write can't truncate the file — a reader sees the prior file or the new
// one, never a partial. Exported for sidecar-meta's writeDeviceMeta.
export async function writeTextAtomic(adapter: DataAdapter, path: string, text: string): Promise<void> {
    const tmp = path + '.tmp';
    await adapter.write(tmp, text);
    try {
        await adapter.rename(tmp, path);
    } catch {
        // Fallback for platforms where rename-over-existing fails (iOS Capacitor).
        if (await exists(adapter, path)) await adapter.remove(path);
        await adapter.rename(tmp, path);
    }
}

// Binary twin of writeTextAtomic — same write-tmp-then-rename durability, for the
// gzipped cross-device BM25 artifact (writeBinary wants an ArrayBuffer).
export async function writeBytesAtomic(adapter: DataAdapter, path: string, bytes: Uint8Array): Promise<void> {
    const tmp = path + '.tmp';
    // Hand writeBinary an exact ArrayBuffer (a Uint8Array can be a view into a larger
    // buffer; slice when it isn't a tight, zero-offset view).
    const ab = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer
        : bytes.slice().buffer;
    await adapter.writeBinary(tmp, ab as ArrayBuffer);
    try {
        await adapter.rename(tmp, path);
    } catch {
        if (await exists(adapter, path)) await adapter.remove(path);
        await adapter.rename(tmp, path);
    }
}

// Sweep orphan .tmp files (.bin.tmp shards, .jsonl.tmp logs, .json.tmp meta,
// .gz.tmp BM25 artifacts) left by a crashed atomic write.
//   - real file present alongside .tmp → swap completed/never-started → delete .tmp
//   - real file missing, .tmp present → crash between remove and rename → restore .tmp
// Scoped to `deviceId`'s OWN artifacts only: every atomic write in this module is
// single-writer (one device writes only its own shard/jsonl/meta/bm25 files), so
// a .tmp owned by a PEER deviceId is that peer's own in-flight write, still being
// written or mid-sync — deleting it can erase live in-progress data, and
// rename-restoring it can promote bytes that aren't fully synced yet. A .tmp
// whose real name doesn't resolve to any known deviceId (malformed/unexpected) is
// also left alone — only a name we can positively attribute to the local device
// is acted on. Returns the number of files acted on.
export async function sweepOrphanTmpFiles(adapter: DataAdapter, root: string, deviceId: string): Promise<number> {
    if (!(await exists(adapter, root))) return 0;
    let count = 0;
    const queue: string[] = [root];
    while (queue.length > 0) {
        const dir = queue.pop()!;
        const ls = await adapter.list(dir).catch(() => null);
        if (!ls) continue;
        for (const sub of ls.folders) queue.push(sub);
        for (const f of ls.files) {
            if (!f.endsWith('.bin.tmp') && !f.endsWith('.jsonl.tmp') && !f.endsWith('.json.tmp') && !f.endsWith('.gz.tmp')) continue;
            const realPath = f.slice(0, -'.tmp'.length);
            if (deviceIdFromArtifactPath(realPath) !== deviceId) continue; // not ours — never touch a peer's in-flight write
            try {
                if (await exists(adapter, realPath)) await adapter.remove(f);
                else await adapter.rename(f, realPath);
                count++;
            } catch {
                /* best-effort cleanup */
            }
        }
    }
    return count;
}

// ---- locking (in-process only) ----

// Per-index-directory async serializer: within one plugin instance no two writers
// run at once for the same dir. With per-device single-writer files there is no
// cross-device write contention, so no file sentinel is needed.
//
// NON-GOAL: cross-process writers on the SAME physical device. deviceId is stable
// per install, so two Obsidian processes opening the same vault on one machine map
// to the same index.<deviceId> files with independent in-process locks. Concurrent
// flushes can both pick the same fresh seq (each lists shards, sees the same max)
// and last-rename-wins on that shard file — the loser's jsonl lines then resolve
// against the winner's bytes (lost or misread records; tmp+rename still prevents a
// *torn* file). This is accepted: Obsidian is single-instance per vault, and two
// distinct machines get distinct deviceIds (no collision). The cost of a collision
// is re-embed on the next reconcile, never a corrupt live index.
const dirLocks = new Map<string, Promise<unknown>>();

// Exported for sidecar-meta's writeDeviceMeta (whose seqFloor preserve-read must
// not interleave with an in-lock floor raise) and for tests. NOT re-entrant —
// never call it while already inside a locked section for the same dir.
export async function withDirLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const prior = dirLocks.get(dir) ?? Promise.resolve();
    let release!: () => void;
    const myCompletion = new Promise<void>(resolve => {
        release = resolve;
    });
    dirLocks.set(dir, prior.then(() => myCompletion));
    try {
        await prior;
        return await fn();
    } finally {
        release();
    }
}

async function appendJsonlLine(adapter: DataAdapter, path: string, line: string): Promise<void> {
    if (!(await exists(adapter, path))) {
        await adapter.write(path, line);
        return;
    }
    try {
        await adapter.append(path, line);
    } catch {
        // .append can fail on iOS WKWebView under iCloud contention. Read+rewrite
        // preserves prior data — via tmp+rename so a crash mid-rewrite leaves the
        // prior log intact instead of truncating it to a partial prefix.
        const existing = await adapter.read(path);
        await writeTextAtomic(adapter, path, existing + line);
    }
}

// ---- write paths (each device writes ONLY its own files) ----

// Append a tombstone (compaction hint — own device only).
export async function appendTombstone(adapter: DataAdapter, indexDir: string, deviceId: string, id: string, mtime: number): Promise<void> {
    return withDirLock(indexDir, async () => {
        await ensureDir(adapter, indexDir);
        const rec: TombstoneRecord = { id, shard: deviceId, tombstone: true, mtime };
        await appendJsonlLine(adapter, jsonlPathFor(indexDir, deviceId), JSON.stringify(rec) + '\n');
    });
}

// ---- persisted seq floor (never-reuse, across deletion) ----
// The one real invariant (see compactDevice's header) is that a (deviceId, seq)
// shard FILENAME, once used, is never republished with different bytes: a peer
// may hold any historical shard file, and iCloud offers no cross-file ordering,
// so a reused name lets fresh jsonl refs resolve against stale bytes — and
// records carry no id binding, so the CRC passes and the wrong vector hydrates
// silently. Deriving the next seq from the on-disk max alone holds this only
// while every historical shard is still on disk; any path that deletes a
// max-seq shard with no higher seq left (crash-orphan reclaim, compact-to-empty,
// pre-rebuild clearDevice) must therefore persist a floor FIRST, so allocation
// can never dip back into retired seqs. The floor lives as `seqFloor` in
// meta.<deviceId>.json, read/written RAW here (sidecar-meta imports from this
// module, and the floor must survive in metas readDeviceMeta rejects, e.g. the
// stale-format leftover clearDevice keeps). Monotone by construction; every
// caller already holds the dir lock.
async function readSeqFloorRaw(adapter: DataAdapter, indexDir: string, deviceId: string): Promise<number> {
    try {
        const v = (JSON.parse(await adapter.read(metaPathFor(indexDir, deviceId))) as { seqFloor?: unknown }).seqFloor;
        return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
    } catch {
        return 0; // no meta yet / torn json → no floor recorded
    }
}

// Raise (never lower) the persisted floor. Deliberately NOT error-swallowed:
// deleters call this BEFORE removing shards, and if the floor can't be persisted
// the deletion must not happen either (fail-closed) — a lost floor plus a
// completed deletion is exactly the reuse window this exists to close.
async function raiseSeqFloorRaw(adapter: DataAdapter, indexDir: string, deviceId: string, floor: number): Promise<void> {
    let obj: Record<string, unknown> = {};
    try {
        const parsed: unknown = JSON.parse(await adapter.read(metaPathFor(indexDir, deviceId)));
        if (parsed && typeof parsed === 'object') obj = parsed as Record<string, unknown>;
    } catch { /* absent/torn meta → write a floor-only stub; readDeviceMeta rejects it as a version gate, which is correct — only the floor needs to survive */ }
    const prev = typeof obj.seqFloor === 'number' && Number.isFinite(obj.seqFloor) ? (obj.seqFloor as number) : 0;
    if (floor <= prev) return;
    obj.seqFloor = floor;
    if (typeof obj.deviceId !== 'string') obj.deviceId = deviceId;
    await writeTextAtomic(adapter, metaPathFor(indexDir, deviceId), JSON.stringify(obj, null, 2));
}

// Bulk append — APPEND-ONLY (1A): every flush lands in FRESH shard file(s), at
// seqs above every existing seq. An existing shard is never read or rewritten,
// so a K-record flush costs O(K·VEC_BYTES) of IO instead of a read-merge-rewrite
// of up to a full SHARD_CAP_BYTES shard (a one-chunk edit near a full 4 MB shard
// re-uploaded ~9,000× its payload through iCloud). This is safe because nothing
// in the format assumes shard fullness: readers resolve per-record (seq, off)
// through the jsonl and union shards by seq (scanJsonl), and compactDevice's
// generational rewrite later coalesces the accumulated small shards into dense
// ones AND reclaims superseded bytes — the same editing churn that proliferates
// shards also raises the dead-record ratio that triggers it. Never reusing a
// (seq, off) is the one real invariant (see compactDevice's header), and fresh
// seqs preserve it by construction. Crash-safety: each shard is written
// tmp+rename BEFORE the jsonl lines referencing it are appended, so a crash
// between the two leaves an unreferenced shard — exactly the orphan class
// compactDevice's crash-leak reclaim deletes. Batches larger than
// SHARD_CAP_BYTES split across consecutive fresh shards.
export async function bulkAppend(
    adapter: DataAdapter,
    indexDir: string,
    deviceId: string,
    records: Array<{ id: string; tiers: TierBytes; mtime: number }>,
): Promise<Array<{ seq: number; off: number }>> {
    if (records.length === 0) return [];
    return withDirLock(indexDir, async () => {
        await ensureDir(adapter, indexDir);
        // One listing (for the max seq) — includes crash-orphaned shards, which is
        // exactly right: their seqs must not be reused while they are on disk. The
        // persisted floor covers the other half — seqs whose shards were DELETED
        // (reclaim / compaction / clearDevice) but may still exist on a peer.
        const shards = await listDeviceShards(adapter, indexDir, deviceId);
        const floor = await readSeqFloorRaw(adapter, indexDir, deviceId);
        let nextSeq = Math.max(shards.length > 0 ? shards[shards.length - 1].seq + 1 : 0, floor);
        const refs: Array<{ seq: number; off: number }> = [];
        const lines: string[] = [];
        let cursor = 0;
        while (cursor < records.length) {
            const take = Math.min(MAX_VECTORS_PER_SHARD, records.length - cursor);
            const buf = new Uint8Array(take * VEC_BYTES);
            let off = 0;
            for (let i = 0; i < take; i++) {
                const { id, tiers, mtime } = records[cursor + i];
                buf.set(encodeRecord(tiers), off);
                refs.push({ seq: nextSeq, off });
                lines.push(JSON.stringify({ id, dim: DIM, shard: deviceId, seq: nextSeq, off, mtime }));
                off += VEC_BYTES;
            }
            await writeBinaryAtomic(adapter, shardPathFor(indexDir, deviceId, nextSeq), buf.buffer);
            nextSeq++;
            cursor += take;
        }
        if (lines.length > 0) await appendJsonlLine(adapter, jsonlPathFor(indexDir, deviceId), lines.join('\n') + '\n');
        return refs;
    });
}

// Drop `deviceId`'s sidecar artifacts. Two caller classes with different needs:
// - A device that will WRITE AGAIN under this id (the start of a FULL reindex, or
//   an own-device stale-format wipe) passes preserveSeqFloor: true — the meta file
//   is KEPT and its seqFloor raised past every deleted shard, so the rebuild's
//   flushes can never republish a filename a peer may still hold (see
//   raiseSeqFloorRaw). Keeping the full meta (not a bare floor stub) also shields
//   the floor from a peer's dead-identity reap: a current-identity meta passes
//   metaAccepts, a stub would not and would be reaped with the floor inside it.
// - The dead-identity reap omits the flag: it must FULLY reclaim a stale device
//   (leaving meta/bm25 behind would let it re-surface every reap forever, the leak
//   listSidecarDeviceIds exists to end), and a retired device id never writes
//   again, so there is no floor worth preserving.
// Other devices' files are untouched.
export async function clearDevice(adapter: DataAdapter, indexDir: string, deviceId: string, opts: { preserveSeqFloor?: boolean } = {}): Promise<void> {
    return withDirLock(indexDir, async () => {
        if (!(await exists(adapter, indexDir))) return;
        const shards = await listDeviceShards(adapter, indexDir, deviceId);
        if (opts.preserveSeqFloor && shards.length > 0) {
            // BEFORE any deletion, fail-closed: if the floor can't be persisted,
            // the clear throws and nothing is removed this attempt.
            await raiseSeqFloorRaw(adapter, indexDir, deviceId, shards[shards.length - 1].seq + 1);
        }
        for (const s of shards) {
            await adapter.remove(s.path).catch(() => {});
        }
        // Remove the per-device artifacts: jsonl log and the cross-device BM25
        // blob always; the version meta only on the full-reclaim (reap) path —
        // the preserve path keeps it as the floor's carrier. Previously only the
        // shards + jsonl were cleared, so meta.<id>.json + bm25.<id>.json.gz
        // lingered (gated out as stale, but accumulating across reindexes).
        const doomed = [jsonlPathFor(indexDir, deviceId), bm25PathFor(indexDir, deviceId)];
        if (!opts.preserveSeqFloor) doomed.push(metaPathFor(indexDir, deviceId));
        for (const p of doomed) {
            if (await exists(adapter, p)) await adapter.remove(p).catch(() => {});
        }
    });
}

// Total bytes of `deviceId`'s shards — the cheap (stat-only) pre-gate compactDevice's
// caller uses to skip the whole-vault re-chunk for a sidecar too small to be worth a
// rewrite + re-upload.
export async function deviceShardBytes(adapter: DataAdapter, indexDir: string, deviceId: string): Promise<number> {
    let bytes = 0;
    for (const s of await listDeviceShards(adapter, indexDir, deviceId)) bytes += s.size;
    return bytes;
}


// Compact `deviceId`'s OWN sidecar in place: rewrite its jsonl + shards to hold only
// its live records, reclaiming the disk that superseded re-appends (same id, newer
// mtime) and orphaned records (deleted / edited-away ids — never tombstoned in prod,
// so they resolve "live" in scanJsonl forever and only the vault re-chunk knows they
// are dead) would otherwise hold until the next FULL reindex. Single-writer + the dir
// mutex make this safe without a cross-device sentinel (see the module header).
//
// liveIds is a THUNK, invoked INSIDE the dir lock, returning the live-vault id set (the
// eviction-robust oracle hydrate uses) and whether that set is COMPLETE. Taking the
// snapshot under the same lock that serializes appends is what makes the drop decision
// exact: no record can be appended between "what is live" (the thunk) and "what is on
// disk" (the scan), so a record is dropped iff its id is genuinely absent from a current,
// complete live set — no wall-clock/mtime reasoning, no concurrent-append race. If the
// thunk reports complete:false (a note failed to read / tokenize), the oracle is
// untrustworthy and we MUST NOT delete → return 'incomplete-rechunk' and retry later.
//
// Gated: no-op under the byte floor or the dead-ratio threshold, so a lean sidecar is
// never rewritten (and re-uploaded to iCloud) for a trivial gain.
//
// Sync- AND crash-safety rests on a GENERATIONAL rewrite: survivors are written to
// FRESH shard seqs (maxSeq+1…), the new jsonl is swapped in atomically (the single
// commit point), and only THEN are the old shards deleted. A peer mid-sync that holds
// the new jsonl but not the new shard resolves a fresh seq that isn't on disk yet →
// readBinary fails → skip → self-heal; it can NEVER resolve a new offset against an
// old shard's bytes (which would decode a different chunk as this id — the one real
// correctness hole, closed by never reusing a seq/offset). A crash before the swap
// leaves the old jsonl + old shards authoritative; orphaned fresh shards are reclaimed
// by the next pass. Peak memory ≈ one source + one dest shard (~8 MB), matching bulkAppend.
export async function compactDevice(
    adapter: DataAdapter,
    indexDir: string,
    deviceId: string,
    liveIds: () => Promise<{ ids: Set<string>; complete: boolean }>,
    opts: { minDeadRatio?: number; minShardBytes?: number } = {},
): Promise<CompactResult> {
    const minDeadRatio = opts.minDeadRatio ?? 0.5;
    const minShardBytes = opts.minShardBytes ?? 2 * 1024 * 1024;
    return withDirLock(indexDir, async () => {
        const nil: CompactResult = { compacted: false, recordsBefore: 0, recordsAfter: 0, bytesBefore: 0, bytesAfter: 0, shed: 0, shardsBefore: 0, shardsAfter: 0 };
        if (!(await exists(adapter, indexDir))) return nil;

        let shardsBefore = await listDeviceShards(adapter, indexDir, deviceId);

        // Zero-reference reclaim: a shard whose seq is referenced by ZERO jsonl
        // lines (not even a dead/superseded one) is provably unreachable — the
        // jsonl is the only pointer store, so nothing on disk can resolve into it
        // again. Three origins: a compaction/coalesce that crashed between the
        // atomic jsonl swap (the single commit point) and the old-shard delete
        // that follows it; a bulkAppend flush that crashed between the shard
        // rename and its jsonl append (1A — always the highest seq on disk); and
        // a dense shard whose every record was superseded and whose stale refs a
        // coalesce rewrite then collapsed away — so an orphan is NOT necessarily
        // crash debris, nor necessarily the disk max. Deleting at any seq is safe
        // because the floor raise below runs BEFORE the removes. This must run
        // BEFORE the below-floor / below-ratio / nothing-dead gates below: those
        // compare record counts within the CURRENT (already-compacted) jsonl, see
        // nothing dead, and return early — if the leak check were gated behind
        // them too, a crash right after the swap would leak the old shards
        // permanently (the fast path can never "see" bytes the jsonl no longer
        // mentions at all).
        const { records: rawRecords } = await readJsonl(adapter, jsonlPathFor(indexDir, deviceId));
        const referencedSeqs = new Set<number>();
        for (const r of rawRecords) if (!isTombstone(r)) referencedSeqs.add(r.seq);
        const orphanShards = shardsBefore.filter(s => !referencedSeqs.has(s.seq));
        if (orphanShards.length > 0) {
            // Persist the floor BEFORE deleting: a crash orphan is by construction
            // the HIGHEST seq on disk (bulkAppend writes fresh max-seq shards, so a
            // crashed flush's leftovers sit above everything referenced). Deleting
            // it without a floor would drop the on-disk max back, and the next
            // flush would republish the same filename with different bytes — the
            // stale-resolve hole described at raiseSeqFloorRaw. Fail-closed: if
            // the floor write throws, nothing is deleted this pass.
            await raiseSeqFloorRaw(adapter, indexDir, deviceId, orphanShards[orphanShards.length - 1].seq + 1);
            for (const s of orphanShards) await adapter.remove(s.path).catch(() => {});
            shardsBefore = shardsBefore.filter(s => referencedSeqs.has(s.seq));
        }

        const bytesBefore = shardsBefore.reduce((sum, s) => sum + s.size, 0);
        const shardCount = shardsBefore.length;
        // Early returns report bytesAfter = bytesBefore (nothing changed) — the
        // sidecar-compact census beat logs both, and `...nil`'s bytesAfter: 0
        // would read as a wipe on exactly the below-floor sessions it watches.
        if (bytesBefore < minShardBytes) return { ...nil, reason: 'below-floor', bytesBefore, bytesAfter: bytesBefore, shardsBefore: shardCount, shardsAfter: shardCount };

        // Snapshot the live-id oracle UNDER the lock (excludes concurrent appends), only
        // once past the floor (so a small sidecar never pays the re-chunk).
        const { ids: keepIds, complete } = await liveIds();
        if (!complete) return { ...nil, reason: 'incomplete-rechunk', bytesBefore, bytesAfter: bytesBefore, shardsBefore: shardCount, shardsAfter: shardCount };

        // This device alone → scanJsonl's cross-device step is trivial and supersedes
        // collapse to the latest record per id.
        const scan = await scanJsonl(adapter, [jsonlPathFor(indexDir, deviceId)]);
        const recordsBefore = scan.recordCount;
        const keep: ResolvedEntry[] = [];
        for (const e of scan.map.values()) if (keepIds.has(e.id)) keep.push(e);
        const base = { ...nil, recordsBefore, recordsAfter: keep.length, bytesBefore, bytesAfter: bytesBefore, shardsBefore: shardCount, shardsAfter: shardCount };
        if (recordsBefore === 0 || keep.length >= recordsBefore) return { ...base, reason: 'nothing-dead' };
        if ((recordsBefore - keep.length) / recordsBefore < minDeadRatio) return { ...base, reason: 'below-ratio' };

        // ---- generational rewrite (fresh seqs > every existing seq) ----
        const maxSeq = shardsBefore.length ? shardsBefore[shardsBefore.length - 1].seq : -1;
        keep.sort((a, b) => (a.seq - b.seq) || (a.off - b.off)); // each source shard read once
        const newLines: string[] = [];
        const newShardPaths: string[] = [];
        let shed = 0;
        // Honor the persisted floor: after an orphan reclaim (above), the floor can
        // sit ABOVE the surviving on-disk max, and fresh shards must not collide
        // with the reclaimed seqs a peer may still hold.
        let destSeq = Math.max(maxSeq + 1, await readSeqFloorRaw(adapter, indexDir, deviceId));
        let destBuf = new Uint8Array(SHARD_CAP_BYTES);
        let destLen = 0;
        let srcSeq = -1;
        let srcBuf: ArrayBuffer | null = null;
        const flushDest = async (): Promise<void> => {
            if (destLen === 0) return;
            const path = shardPathFor(indexDir, deviceId, destSeq);
            await writeBinaryAtomic(adapter, path, destBuf.slice(0, destLen).buffer);
            newShardPaths.push(path);
            destSeq++;
            destBuf = new Uint8Array(SHARD_CAP_BYTES);
            destLen = 0;
        };
        try {
            for (const e of keep) {
                if (e.seq !== srcSeq) {
                    srcSeq = e.seq;
                    srcBuf = await adapter.readBinary(shardPathFor(indexDir, deviceId, e.seq)).catch(() => null);
                }
                // Shed a record whose source bytes are missing / out-of-range / corrupt:
                // it is already dead-on-read at hydrate (decodeRecord throws → null), so
                // dropping it costs nothing (the note re-embeds either way) and reclaims
                // its bytes. `shed` is surfaced because it should be ZERO in normal
                // operation — any non-zero is an own-shard corruption breadcrumb.
                if (!srcBuf || !isOffsetInRange(srcBuf.byteLength, e.off)) { shed++; continue; }
                try { decodeRecord(srcBuf, e.off, e.dim); } catch { shed++; continue; }
                if (destLen + VEC_BYTES > SHARD_CAP_BYTES) await flushDest();
                destBuf.set(new Uint8Array(srcBuf, e.off, VEC_BYTES), destLen);
                newLines.push(JSON.stringify({ id: e.id, dim: e.dim, shard: deviceId, seq: destSeq, off: destLen, mtime: e.mtime }));
                destLen += VEC_BYTES;
            }
            await flushDest();
        } catch (err) {
            // Roll back the fresh shards — FLOOR-FIRST (see coalesceSmallShards's
            // identical rollback): a landed shard may have synced out before this
            // remove, so its seq is burned; if the floor write fails, leave the
            // shards as orphans for the floor-first reclaim instead of deleting.
            if (newShardPaths.length > 0) {
                try {
                    await raiseSeqFloorRaw(adapter, indexDir, deviceId, destSeq);
                    for (const p of newShardPaths) await adapter.remove(p).catch(() => {});
                } catch { /* left as orphans; reclaimed floor-first later */ }
            }
            throw err;
        }

        // Commit: atomic swap to the new jsonl (now pointing only at fresh shards).
        await writeTextAtomic(adapter, jsonlPathFor(indexDir, deviceId), newLines.length ? newLines.join('\n') + '\n' : '');
        // Raise the floor past every seq this rewrite retires, BEFORE deleting
        // them. Redundant when fresh shards were written (the on-disk max already
        // exceeds the retired seqs) but load-bearing for compact-to-empty: keep=[]
        // writes no fresh shard, so the delete below would otherwise drop the
        // on-disk max to nothing and the next flush would resurrect seq 0.
        await raiseSeqFloorRaw(adapter, indexDir, deviceId, destSeq);
        // Reclaim: delete the OLD shards (seq ≤ maxSeq); fresh shards (> maxSeq) stay.
        for (const s of shardsBefore) await adapter.remove(s.path).catch(() => {});

        return { compacted: true, reason: 'done', recordsBefore, recordsAfter: newLines.length, bytesBefore, bytesAfter: newLines.length * VEC_BYTES, shed, shardsBefore: shardCount, shardsAfter: newShardPaths.length };
    });
}


// Shard-count hygiene for the append-only writer (1A): fold accumulated SMALL
// shards — bulkAppend leaves one per flush — into dense fresh shard(s). This is
// the ORACLE-FREE half of reclamation: compactDevice needs the whole-vault
// re-chunk because only the vault can prove an id is dead (orphaned), but two
// kinds of waste are provable from the jsonl alone — superseded duplicates (a
// newer record for the same id exists in this same single-writer file) and
// fragmentation (live records scattered across per-flush files). So this pass
// byte-copies the latest record per id out of every small shard into dense
// shard(s), swaps the jsonl atomically, and deletes the merged smalls; records
// already in dense (≥ smallShardBytes) shards keep their (seq, off) untouched,
// so cost is proportional to the small tail, not the corpus. No liveness
// decision is made: every resolved id survives. Cheap enough to gate on shard
// COUNT and run every reconcile poll, closing the gap where compactDevice's
// byte floor is weeks away while the directory gains a file per flush.
//
// A coalesced output below smallShardBytes counts as small next round and gets
// re-copied into the next fold — deliberate (an LSM-lite level-0 merge): each
// byte is re-copied at most ~smallShardBytes/(minSmallShards·avg-flush) times
// before its snowball graduates past the threshold, trivial at these sizes.
//
// Side effect on compactDevice's trigger: collapsing superseded lines lowers
// the raw-line dead ratio it gates on, so after a coalesce only orphaned-id
// waste counts toward minDeadRatio — correct (the superseded waste is already
// reclaimed), but it means the oracle pass is reached mostly via the byte
// floor once this runs regularly.
//
// Safety is compactDevice's generational pattern exactly: dense shards land at
// fresh seqs (above the on-disk max AND the persisted floor) via tmp+rename
// BEFORE the jsonl swap (the single commit point); the floor is raised past
// every retired seq BEFORE the smalls are deleted (fail-closed). A crash
// before the swap leaves the old jsonl authoritative and the dense shard as a
// reclaimable orphan; a crash after it leaves the smalls unreferenced — the
// same orphan class, reclaimed by the next pass. Tombstone lines are dropped
// with the superseded lines they mask (a tombstone only ever masks THIS
// device's records, and the rewrite drops every masked line — peers resolve
// identically with or without it).
export async function coalesceSmallShards(
    adapter: DataAdapter,
    indexDir: string,
    deviceId: string,
    opts: { smallShardBytes?: number; minSmallShards?: number } = {},
): Promise<CoalesceResult> {
    const smallShardBytes = opts.smallShardBytes ?? 256 * 1024;
    const minSmallShards = opts.minSmallShards ?? 16;
    return withDirLock(indexDir, async () => {
        const nil: CoalesceResult = { coalesced: false, smallShards: 0, shardsBefore: 0, shardsAfter: 0, bytesMoved: 0, shed: 0, skippedLines: 0 };
        if (!(await exists(adapter, indexDir))) return nil;
        const shards = await listDeviceShards(adapter, indexDir, deviceId);
        const small = shards.filter(s => s.size < smallShardBytes);
        if (small.length === 0 || small.length < minSmallShards) {
            return { ...nil, reason: 'below-count', smallShards: small.length, shardsBefore: shards.length, shardsAfter: shards.length };
        }

        const smallSeqs = new Set(small.map(s => s.seq));
        const scan = await scanJsonl(adapter, [jsonlPathFor(indexDir, deviceId)]);
        const move: ResolvedEntry[] = [];
        const newLines: string[] = [];
        for (const e of scan.map.values()) {
            if (smallSeqs.has(e.seq)) move.push(e);
            else newLines.push(JSON.stringify({ id: e.id, dim: e.dim, shard: deviceId, seq: e.seq, off: e.off, mtime: e.mtime }));
        }

        const maxSeq = shards[shards.length - 1].seq;
        move.sort((a, b) => (a.seq - b.seq) || (a.off - b.off)); // each source shard read once
        const newShardPaths: string[] = [];
        let shed = 0;
        let bytesMoved = 0;
        let destSeq = Math.max(maxSeq + 1, await readSeqFloorRaw(adapter, indexDir, deviceId));
        // Dest buffers are sized to the REMAINING move set (capped at a shard), not
        // a flat SHARD_CAP_BYTES: the typical fold moves a few hundred KB, and a
        // 4 MB allocation every 5-minute trigger is real pressure inside an iOS
        // WKWebView — the environment whose eviction the sidecar exists to survive.
        let copied = 0; // move entries consumed (moved or shed) — sizes the next buffer
        const nextBuf = () => new Uint8Array(Math.min((move.length - copied) * VEC_BYTES, SHARD_CAP_BYTES));
        let destBuf = nextBuf();
        let destLen = 0;
        let srcSeq = -1;
        let srcBuf: ArrayBuffer | null = null;
        const flushDest = async (): Promise<void> => {
            if (destLen === 0) return;
            const path = shardPathFor(indexDir, deviceId, destSeq);
            await writeBinaryAtomic(adapter, path, destBuf.slice(0, destLen).buffer);
            newShardPaths.push(path);
            destSeq++;
            destBuf = nextBuf();
            destLen = 0;
        };
        try {
            for (const e of move) {
                if (e.seq !== srcSeq) {
                    srcSeq = e.seq;
                    srcBuf = await adapter.readBinary(shardPathFor(indexDir, deviceId, e.seq)).catch(() => null);
                }
                // Same shed semantics as compactDevice: a record whose source bytes
                // are missing/corrupt is already dead-on-read at hydrate, so dropping
                // its line costs nothing; non-zero shed is a corruption breadcrumb.
                if (!srcBuf || !isOffsetInRange(srcBuf.byteLength, e.off)) { shed++; copied++; continue; }
                try { decodeRecord(srcBuf, e.off, e.dim); } catch { shed++; copied++; continue; }
                if (destLen + VEC_BYTES > destBuf.length) await flushDest();
                destBuf.set(new Uint8Array(srcBuf, e.off, VEC_BYTES), destLen);
                newLines.push(JSON.stringify({ id: e.id, dim: e.dim, shard: deviceId, seq: destSeq, off: destLen, mtime: e.mtime }));
                destLen += VEC_BYTES;
                bytesMoved += VEC_BYTES;
                copied++;
            }
            await flushDest();
        } catch (err) {
            // Roll back the fresh shards — FLOOR-FIRST: a landed shard may already
            // have synced out in its rename→remove window, burning its seq exactly
            // as if it were referenced; deleting it without a floor would let the
            // next flush republish the filename with different bytes. If the floor
            // write itself fails, delete nothing — the shards stay as unreferenced
            // orphans for the floor-first crash-leak reclaim.
            if (newShardPaths.length > 0) {
                try {
                    await raiseSeqFloorRaw(adapter, indexDir, deviceId, destSeq);
                    for (const p of newShardPaths) await adapter.remove(p).catch(() => {});
                } catch { /* left as orphans; reclaimed floor-first later */ }
            }
            throw err;
        }

        // Commit: atomic swap. Dense-shard refs are unchanged; small-shard refs now
        // point at the fresh dense shard(s); superseded/tombstone lines are gone.
        await writeTextAtomic(adapter, jsonlPathFor(indexDir, deviceId), newLines.length ? newLines.join('\n') + '\n' : '');
        // Floor past every retired seq BEFORE deleting (see raiseSeqFloorRaw) —
        // load-bearing when the smalls held zero live records (no dense shard was
        // written, so deletion would otherwise lower the on-disk max).
        await raiseSeqFloorRaw(adapter, indexDir, deviceId, destSeq);
        for (const s of small) await adapter.remove(s.path).catch(() => {});

        return {
            coalesced: true, reason: 'done', smallShards: small.length,
            shardsBefore: shards.length, shardsAfter: shards.length - small.length + newShardPaths.length,
            bytesMoved, shed, skippedLines: scan.skippedLines,
        };
    });
}
