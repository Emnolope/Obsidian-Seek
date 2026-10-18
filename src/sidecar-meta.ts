// Per-device sidecar metadata + the version gate. A producer device writes its
// meta.<deviceId>.json on every full reindex / compaction; a consumer refuses to
// hydrate from any producer whose format, model, chunker version, or dimension
// differs — because a chunker mismatch means the consumer's local re-chunk won't
// reproduce the producer's ids, so it would silently load nothing and present as
// a relevance regression. Refuse loudly instead.

import type { DataAdapter } from 'obsidian';
import { metaPathFor, SIDECAR_FORMAT, withDirLock, writeTextAtomic } from './sidecar';
import { pluginIdentity, type IndexIdentity } from './identity';
import type { SidecarMeta, MetaExpectation } from '../core/sidecar-types';
export type { SidecarMeta, MetaExpectation } from '../core/sidecar-types';



export async function readDeviceMeta(adapter: DataAdapter, indexDir: string, deviceId: string): Promise<SidecarMeta | null> {
    const path = metaPathFor(indexDir, deviceId);
    try {
        if (!(await adapter.exists(path).catch(() => false))) return null;
        const m = JSON.parse(await adapter.read(path)) as SidecarMeta;
        // Validate the fields hydrate actually depends on: a torn write that drops
        // modelId (the field metaAccepts gates on) or deviceId (which routes the
        // shard/jsonl reads) must refuse the whole device, not reach metaAccepts
        // with a malformed object.
        if (
            typeof m.format !== 'number' ||
            typeof m.chunkerVersion !== 'number' ||
            typeof m.dim !== 'number' ||
            typeof m.modelId !== 'string' ||
            typeof m.deviceId !== 'string'
        )
            return null;
        // revision is the F10 gate field; normalize a missing/legacy value to null
        // (= "track main") so metaAccepts compares cleanly. A format-2 producer
        // always writes it; this only smooths a hand-rolled or future-tolerant meta.
        m.revision = typeof m.revision === 'string' ? m.revision : null;
        // seqFloor is only trusted as a non-negative finite number; a torn or
        // hand-edited value degrades to "no floor recorded", never to NaN math.
        m.seqFloor = typeof m.seqFloor === 'number' && Number.isFinite(m.seqFloor) && m.seqFloor > 0 ? Math.floor(m.seqFloor) : undefined;
        return m;
    } catch {
        return null;
    }
}

// Runs under the sidecar dir lock: the preserve-read below is a read-modify-write
// against the same meta file the in-lock floor raisers (orphan reclaim, coalesce,
// compact, clearDevice) update, and an unlocked interleaving — read (no floor) →
// fold raises floor and deletes shards → write (no floor) — would erase the floor
// at the exact moment it is the ONLY thing keeping the next flush off a retired
// seq. Callers must NOT already hold the dir lock (withDirLock is not re-entrant);
// the F8 flush path calls this before bulkAppend takes it, which is fine.
export async function writeDeviceMeta(adapter: DataAdapter, indexDir: string, meta: SidecarMeta): Promise<void> {
    return withDirLock(indexDir, async () => {
        let out = meta;
        if (out.seqFloor === undefined) {
            // Preserve a floor this caller doesn't know about — the per-flush F8 meta
            // rewrite (search.ts) constructs a fresh object every pass and would
            // otherwise erase the floor the first flush after a reclaim. RAW read, not
            // readDeviceMeta: the floor must survive even in a meta the version gate
            // rejects (e.g. the stale-format leftover clearDevice keeps).
            try {
                const prior = JSON.parse(await adapter.read(metaPathFor(indexDir, meta.deviceId))) as { seqFloor?: unknown };
                if (typeof prior.seqFloor === 'number' && Number.isFinite(prior.seqFloor) && prior.seqFloor > 0) {
                    out = { ...meta, seqFloor: Math.floor(prior.seqFloor) };
                }
            } catch { /* no prior meta — nothing to preserve */ }
        }
        await writeTextAtomic(adapter, metaPathFor(indexDir, out.deviceId), JSON.stringify(out, null, 2));
    });
}

// A null/missing meta is a refusal — compatibility can't be proven without it.
export function metaAccepts(meta: SidecarMeta | null, expect: MetaExpectation): boolean {
    if (!meta) return false;
    return (
        meta.format === SIDECAR_FORMAT &&
        meta.modelId === expect.modelId &&
        meta.revision === expect.revision &&
        meta.chunkerVersion === expect.chunkerVersion &&
        meta.dim === expect.dim
    );
}

// The cross-device slice of the build identity, in the exact shape metaAccepts
// compares. Centralizes the field list so the producer write + every hydrate gate
// stop hand-repeating { modelId, revision, chunkerVersion, dim } — one identity
// source (identity.ts), no drift between call sites. The slice deliberately omits
// analyzerVersion + dbVersion: two devices can differ on those and still exchange
// reproducible chunk_ids + comparable vectors, so the sidecar hydrates across them
// (see identity.ts for the full rationale).
export function expectationFor(id: IndexIdentity = pluginIdentity()): MetaExpectation {
    return { modelId: id.modelId, revision: id.revision, chunkerVersion: id.chunkerVersion, dim: id.dim };
}
