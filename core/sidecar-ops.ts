// Sidecar upkeep for this device's own files, host-independent: compaction, shard coalescing, dead-peer reaping, and the reconcile-signature gate. The file
// adapter and the sidecar IO functions are the host's; they arrive under their own names, adapter first, as they were called before.
import type { SidecarMeta, MetaExpectation, DeviceShard, CompactResult, CoalesceResult } from './sidecar-types.ts';

export interface SidecarOpsCtx<A> {
    adapter: A;
    coord: { sidecarOn(): boolean; dir: string | null };
    logger: { deviceId: string; appendError(context: string, e: unknown): Promise<void> };
    forensics: { beat(type: string, detail?: Record<string, unknown>): void } | null;
    store: { readonly dbName: string; count(): Promise<{ chunks: number; files: number }> };
    // In-session cache of the sidecar-dir signature at the last successful reconcile.
    lastReconcileSig: string | null;
    // The host's per-vault key/value storage; may throw (private mode, quota).
    loadLocalStorage(key: string): unknown;
    saveLocalStorage(key: string, data: string): void;
    isMobilePlatform(): boolean;
    collectLiveIds(): Promise<{ ids: Set<string>; complete: boolean }>;
    listSidecarDeviceIds(adapter: A, indexDir: string): Promise<string[]>;
    readDeviceMeta(adapter: A, indexDir: string, deviceId: string): Promise<SidecarMeta | null>;
    clearDevice(adapter: A, indexDir: string, deviceId: string, opts?: { preserveSeqFloor?: boolean }): Promise<void>;
    metaAccepts(meta: SidecarMeta | null, expect: MetaExpectation): boolean;
    expectationFor(): MetaExpectation;
    staleSidecarFormat(meta: { format: number } | null): boolean;
    listDeviceShards(adapter: A, indexDir: string, deviceId: string): Promise<DeviceShard[]>;
    compactDevice(
        adapter: A, indexDir: string, deviceId: string, liveIds: () => Promise<{ ids: Set<string>; complete: boolean }>,
        opts: { minDeadRatio: number; minShardBytes: number },
    ): Promise<CompactResult>;
    coalesceSmallShards(adapter: A, indexDir: string, deviceId: string): Promise<CoalesceResult>;
    sidecarDirSignature(adapter: A, indexDir: string, selfDeviceId?: string): Promise<string>;
}

// fork 1.1.3 src/search.ts:2513 SearchOrchestrator.peerSidecarPresent
// Does ANY other device have a sidecar in the index dir, regardless of its identity?
// A cheap, embed-free signal (a directory listing — no meta read, no model) that this
// vault is multi-device. When the local index is version-stale and rebuildFromSidecar
// found no CURRENT-identity producer, a present peer means a current index is (or will
// be) on its way — so the UI says "syncing", not "reindex". Self is excluded: our own
// stale sidecar is not an incoming heal. A long-dead peer's leftover sidecar is a rare,
// benign false-positive (it only keeps the calm banner up a little longer; reapDead-
// IdentitySidecars clears it at the next full reindex on some device).
export async function peerSidecarPresent<A>(ctx: SidecarOpsCtx<A>): Promise<boolean> {
    if (!ctx.coord.sidecarOn()) return false;
    const ids = await ctx.listSidecarDeviceIds(ctx.adapter, ctx.coord.dir!);
    return ids.some(id => id !== ctx.logger.deviceId);
}

// fork 1.1.3 src/search.ts:2583 SearchOrchestrator.reapDeadIdentitySidecars
// Dead-identity sidecar reap (Phase 3 §4): at a full reindex — which republishes
// THIS device at the current identity — remove every OTHER device's sidecar files
// whose meta identity no longer matches this build. Provably useless (metaAccepts
// refuses them, so no current-version device can hydrate from them), so which
// device wrote them is irrelevant; sync-safe because an un-updated device just
// re-creates its own until it updates. Never reaps self (just rewritten) or a
// current-identity peer (a valid producer). A null/torn meta fails the gate and is
// reaped too — it was unusable anyway. Returns the device count reaped.
//
// Enumerates by listSidecarDeviceIds (the UNION of all artifact types), NOT by
// jsonl alone: clearDevice deletes a device's four files non-atomically and sync
// propagates each independently, so a dead device's jsonl can already be gone
// while its meta/bm25/shards linger. A jsonl-keyed reap would never revisit those
// leftovers (permanent disk leak); the union re-finds a half-cleared device and
// clearDevice — idempotent + exists-guarded — finishes it on this or a later
// pass. The metaAccepts gate is unchanged, so a current peer mid-sync (meta
// present, current identity) is still kept; only provably-stale or unprovable
// (no/torn meta) devices are reaped, exactly as before.
export async function reapDeadIdentitySidecars<A>(ctx: SidecarOpsCtx<A>): Promise<number> {
    if (!ctx.coord.sidecarOn()) return 0;
    const dir = ctx.coord.dir!;
    const adapter = ctx.adapter;
    const expect = ctx.expectationFor();
    let reaped = 0;
    for (const dev of await ctx.listSidecarDeviceIds(adapter, dir)) {
        if (dev === ctx.logger.deviceId) continue;     // never reap self
        if (ctx.metaAccepts(await ctx.readDeviceMeta(adapter, dir, dev), expect)) continue; // current peer — keep
        await ctx.clearDevice(adapter, dir, dev);
        reaped++;
    }
    return reaped;
}

// fork 1.1.3 src/search.ts:2622 SearchOrchestrator.reconcileSigKey
// Reconcile-signature storage key. App#saveLocalStorage vault-scopes by the
// vault's appId, so cross-VAULT clobber is handled automatically; we KEEP
// dbName in the key so two co-installed Seek builds (id 'seek' + 'seek-prototype')
// in the SAME vault still don't clobber each other's gate (same appId namespace).
export function reconcileSigKey<A>(ctx: SidecarOpsCtx<A>): string {
    return `seek:reconcile-sig:${ctx.store.dbName}`;
}

// fork 1.1.3 src/search.ts:2626 SearchOrchestrator.loadPersistedReconcileSig
export function loadPersistedReconcileSig<A>(ctx: SidecarOpsCtx<A>): string | null {
    try {
        const v: unknown = ctx.loadLocalStorage(reconcileSigKey(ctx));
        return typeof v === 'string' ? v : null;
    }
    catch { return null; }   // unavailable (private mode/quota) → fall back to in-memory gating
}

// fork 1.1.3 src/search.ts:2634 SearchOrchestrator.persistReconcileSig
export function persistReconcileSig<A>(ctx: SidecarOpsCtx<A>, sig: string): void {
    ctx.lastReconcileSig = sig;
    try { ctx.saveLocalStorage(reconcileSigKey(ctx), sig); }
    catch { /* best-effort; in-memory cache still gates this session */ }
}

// fork 1.1.3 src/search.ts:2643 SearchOrchestrator.indexIsEmpty
// Empty-store probe for the reconcile gate's mandatory eviction guard. A
// count() failure is treated as empty (sweep) — the safe side: a needless
// sweep costs time, a skipped recovery costs all search results.
export async function indexIsEmpty<A>(ctx: SidecarOpsCtx<A>): Promise<boolean> {
    try { return (await ctx.store.count()).files === 0; }
    catch { return true; }
}

// fork 1.1.3 src/search.ts:2792 SearchOrchestrator.compactOwnSidecar
// Compact THIS device's own sidecar (jsonl + shards) if it has accumulated enough
// dead bytes. Model-FREE — a pure byte-copy of existing vectors, peak ~8 MB (one
// source + one dest shard) — so, unlike a full reindex, it is safe on mobile (no
// GPU/model heap → no jetsam). It is also the ONLY reclaim path for a
// device that never reaches a desktop: a version-bump reindex and hydrate-from-a-
// compacted-peer both need connectivity an off-grid phone/iPad may lack for months,
// and its own edit churn would otherwise pile up unbounded. Called at most once per
// session from periodicReconcile. Returns null when the sidecar is off.
export async function compactOwnSidecar<A>(ctx: SidecarOpsCtx<A>): Promise<CompactResult | null> {
    if (!ctx.coord.sidecarOn()) return null;
    const adapter = ctx.adapter;
    const dir = ctx.coord.dir!;
    const dev = ctx.logger.deviceId;

    // A SIDECAR_FORMAT bump is deliberately excluded from identityMatches (it
    // governs only the cross-device file protocol, not local IDB validity — see
    // identity.ts), so this device can carry a stale-format sidecar on disk
    // indefinitely: nothing forces a full reindex (the only path that clears it
    // via clearDevice) just because the format constant moved. compactDevice()
    // decodes every record with the CURRENT fixed stride unconditionally — run
    // against a genuinely stale-format shard, every record misaligns, fails its
    // CRC, and gets shed as "corrupt", permanently destroying this device's
    // pre-upgrade vector history (and leaving a peer's later hydration attempt
    // to hit the same misread). Detect the mismatch from this device's own last-
    // written meta BEFORE compacting and, instead of misreading, explicitly wipe
    // via the same primitive a full reindex uses — the sidecar self-heals from
    // normal incremental commits afterward, same as any other reap.
    const ownMeta = await ctx.readDeviceMeta(adapter, dir, dev);
    if (ctx.staleSidecarFormat(ownMeta)) {
        // Census the shards BEFORE wiping, and leave the same once-per-session
        // sidecar-compact breadcrumb as a normal compaction: this path makes
        // the largest disk-state change compaction can make (every shard on
        // the device deleted), and a forensics trace showing shard counts drop
        // to zero between sessions must record which path did it.
        const preWipe = await ctx.listDeviceShards(adapter, dir, dev);
        const bytesBefore = preWipe.reduce((sum, s) => sum + s.size, 0);
        await ctx.clearDevice(adapter, dir, dev, { preserveSeqFloor: true });
        ctx.forensics?.beat('sidecar-compact', {
            reason: 'format-mismatch', shardsBefore: preWipe.length, shardsAfter: 0,
            bytesBefore, bytesAfter: 0,
        });
        return { compacted: false, reason: 'format-mismatch', recordsBefore: 0, recordsAfter: 0, bytesBefore, bytesAfter: 0, shed: 0, shardsBefore: preWipe.length, shardsAfter: 0 };
    }

    // Off-grid means no iCloud re-upload now (it lands as a SMALLER upload on
    // reconnect), but the rewrite still costs IO — so a higher floor on mobile.
    const floor = ctx.isMobilePlatform() ? 4 * 1024 * 1024 : 2 * 1024 * 1024;
    // NOTE: no stat-only pre-gate here on purpose. deviceShardBytes(...) < floor would
    // sum ALL on-disk shard bytes, including crash-leaked orphans (shards referenced by
    // zero jsonl lines — see compactDevice's header comment), and skip calling
    // compactDevice entirely for any device whose live+orphan total stays under the
    // floor. compactDevice's own orphan reclaim runs BEFORE its internal below-floor
    // check (on live bytes only), so it must always be reachable — a caller-side
    // pre-gate on the unfiltered total would make a small, quiet device's leaked
    // shards unreclaimable forever. compactDevice is cheap to call here regardless:
    // this path runs at most once per session (see main.ts), and its own below-floor
    // check bails before the expensive live-id re-chunk.
    // The live-id oracle runs INSIDE compactDevice's dir lock so the snapshot and the
    // on-disk scan exclude concurrent appends — the drop decision needs no clock.
    const result = await ctx.compactDevice(adapter, dir, dev, () => ctx.collectLiveIds(), { minDeadRatio: 0.5, minShardBytes: floor });
    // Once-per-session shard-census beat: the field channel for watching
    // append-only flush proliferation (1A). shardsBefore trending high while
    // reason stays below-floor/below-ratio = tighten the compaction trigger.
    ctx.forensics?.beat('sidecar-compact', {
        reason: result.reason ?? 'none', shardsBefore: result.shardsBefore, shardsAfter: result.shardsAfter,
        bytesBefore: result.bytesBefore, bytesAfter: result.bytesAfter,
    });
    // Refresh the persisted reconcile sig after a self jsonl rewrite. With self now
    // excluded from sidecarDirSignature (a device's own writes don't move its own
    // signature), this compaction touches only our own jsonl so the signature is
    // already unchanged — this re-persist is belt-and-suspenders, kept so the
    // persisted sig is recomputed with the SAME selfDeviceId convention as the live
    // gate, and to stay correct if compaction ever touches a non-self artifact.
    if (result.compacted) {
        try {
            persistReconcileSig(ctx, await ctx.sidecarDirSignature(adapter, dir, dev));
        } catch (e) {
            await ctx.logger.appendError('compact-sig-refresh', e);
        }
    }
    return result;
}

// fork 1.1.3 src/search.ts:2875 SearchOrchestrator.coalesceOwnSidecar
// Oracle-free shard-count hygiene for the append-only sidecar (1A): fold
// accumulated per-flush small shards into dense ones once enough pile up.
// Byte-copy only — no vault re-chunk, no model — so unlike compactOwnSidecar
// it is safe to call every reconcile poll; below the count gate it costs one
// directory listing. SKIPS (never wipes) a stale-format sidecar: records must
// be decoded with the stride they were written under, and the format-mismatch
// wipe is compactOwnSidecar's job — running once per session, it always gets
// its chance before shard count matters.
export async function coalesceOwnSidecar<A>(ctx: SidecarOpsCtx<A>): Promise<CoalesceResult | null> {
    if (!ctx.coord.sidecarOn()) return null;
    const adapter = ctx.adapter;
    const dir = ctx.coord.dir!;
    const dev = ctx.logger.deviceId;
    if (ctx.staleSidecarFormat(await ctx.readDeviceMeta(adapter, dir, dev))) return null;
    const result = await ctx.coalesceSmallShards(adapter, dir, dev);
    if (result.coalesced) {
        // Census beat only when a fold actually ran — the every-poll below-count
        // no-op would otherwise flood the forensics ring.
        ctx.forensics?.beat('sidecar-coalesce', {
            smallShards: result.smallShards, shardsBefore: result.shardsBefore, shardsAfter: result.shardsAfter,
            bytesMoved: result.bytesMoved, shed: result.shed, skippedLines: result.skippedLines,
        });
        // Same belt-and-suspenders sig refresh as compactOwnSidecar: self is
        // excluded from sidecarDirSignature, so this should be a no-op — kept so
        // the persisted sig always reflects the same convention as the live gate.
        try {
            persistReconcileSig(ctx, await ctx.sidecarDirSignature(adapter, dir, dev));
        } catch (e) {
            await ctx.logger.appendError('coalesce-sig-refresh', e);
        }
    }
    return result;
}
