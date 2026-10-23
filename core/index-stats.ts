// fork 1.1.3 src/main.ts:1447 SeekPlugin.getIndexStats, :1507 getModelStatus, :1539 deleteModel (lifted whole; the Obsidian-only reaches are ports below)
// What the settings tab shows about the index and the model. The plugin answers the storage/cache ports from navigator.storage and the Cache API;
// the bot answers them from the files it owns. DTOs moved with them; src/main.ts re-exports the types.
import type { IndexCompleteEntry, ModelDeliveryEntry } from './types.ts';
import type { MetaConfig } from './index-types.ts';
import type { ModelSpec } from './model-registry.ts';

// DTOs returned by getIndexStats() / getModelStatus().
export interface IndexStats {
    files: number;
    chunks: number;
    // storageMB = navigator.storage.estimate().usage — the WHOLE origin (index + model
    // + every other plugin's storage); kept as a fallback. indexMB / modelMB split it via
    // the non-standard usageDetails ({ indexedDB, caches }) that Electron/Chromium exposes:
    // indexedDB ≈ the vector index, caches ≈ the transformers-cache model bytes. Both are
    // origin-shared (other plugins' IDB/Cache count too), but Seek dominates each, so the
    // split is a far more honest read than the conflated total. null when unavailable.
    storageMB: number | null;
    indexMB: number | null;
    modelMB: number | null;
    // "Last full index" is sourced from the most recent index-complete log entry whose
    // mode is 'full' — timestamp + duration come from the SAME run, so they always agree
    // (the prior code mixed meta's any-mode timestamp with the log's any-mode duration,
    // which let a 2-file catch-up's 2.0s masquerade as a full reindex). Null if no full
    // run survives in the (rotatable) log.
    lastFullAt: string | null;
    lastFullDurationMs: number | null;
    // Last index of ANY mode (incremental catch-ups included), from store meta. Shown as
    // a secondary "updated …" line when it post-dates the full reindex.
    lastUpdatedAt: string | null;
    // True once the index has a calibrated dense background (bgMean/bgStd present,
    // σ>0) — the precondition for a non-null match strength. Gates the "Display
    // scores" toggle: scores can't be shown on an uncalibrated corpus.
    calibrated: boolean;
}
export interface ModelStatus {
    downloaded: boolean;
    persisted: boolean | null;
    name: string;
    dim: number;
}

export interface IndexStatsPorts {
    store: { count(): Promise<{ files: number; chunks: number }>; getMeta(): Promise<MetaConfig> };
    logger: { readAll(): Promise<{ type: string }[]> };
    // MB, or null when the host has no way to tell. `total` is the whole origin (or the bot's whole footprint).
    storage(): Promise<{ total: number | null; index: number | null; model: number | null } | null>;
}

export interface ModelPorts {
    spec: ModelSpec;
    // Is the model on disk? null = the host can't look (falls through to loaded / the delivery log).
    probe(): Promise<{ downloaded: boolean; persisted: boolean | null } | null>;
    embedderLoaded(): boolean;
    logger: { readAll(): Promise<{ type: string }[]>; append(e: ModelDeliveryEntry): Promise<void>; appendError(tag: string, e: unknown): Promise<void> };
    deleteCaches(): Promise<number>;
    teardown(): void | Promise<void>;
}

// Index health snapshot for the settings Index status card. Read-only; gathers the
// private store + logger so the settings tab needs no plugin internals. Counts come
// from the index store, on-disk bytes from the Storage API (iOS-safe), the last-index
// timestamp from index meta (persisted), and its duration from the newest index-complete
// log entry (logged only). Each source is independently guarded so a single failure
// degrades one field rather than blanking the whole card.
export async function getIndexStats(p: IndexStatsPorts): Promise<IndexStats> {
    let files = 0, chunks = 0;
    try { const c = await p.store.count(); files = c.files; chunks = c.chunks; } catch { /* index not open yet */ }
    let storageMB: number | null = null, indexMB: number | null = null, modelMB: number | null = null;
    // The host reports bytes per bucket: Obsidian from navigator.storage.estimate (usageDetails split the origin into the
    // index and the model cache), the bot from the files it owns. null = the host can't say.
    try {
        const est = await p.storage();
        if (est) { storageMB = est.total; indexMB = est.index; modelMB = est.model; }
    } catch { /* unsupported */ }
    // Last FULL reindex: newest index-complete entry with mode==='full'. Taking the
    // stamp AND the duration from that one entry keeps them coherent — a later
    // incremental catch-up (mode==='incremental') is skipped, so its tiny duration
    // never gets shown as if it were a full rebuild.
    let lastFullAt: string | null = null;
    let lastFullDurationMs: number | null = null;
    try {
        const entries = await p.logger.readAll();
        for (let i = entries.length - 1; i >= 0; i--) {
            if (entries[i].type !== 'index-complete') continue;
            const ic = entries[i] as IndexCompleteEntry;
            if (ic.mode !== 'full') continue;
            // A user-paused pass (design B) committed only part of the corpus — it
            // is not a completed full index, so it must not stamp "last full index".
            // Its remainder finishes via an incremental resume, which never claims a
            // full stamp either; the next uninterrupted full reindex sets it cleanly.
            if (ic.paused) continue;
            lastFullAt = ic.timestamp;
            lastFullDurationMs = ic.totalDurationMs;
            break;
        }
    } catch { /* log unreadable */ }
    // Last index of ANY mode (meta is rewritten on every reindex + delta) → "updated".
    // The same meta carries the dense background stats: a calibrated corpus has
    // bgMean/bgStd with σ>0 (mirrors SearchOrchestrator.getDenseBgStats).
    let lastUpdatedAt: string | null = null;
    let calibrated = false;
    try {
        const meta = await p.store.getMeta();
        lastUpdatedAt = meta.lastIndexedAt;
        calibrated = meta.bgMean != null && meta.bgStd != null && meta.bgStd > 0;
    } catch { /* meta unreadable */ }
    return { files, chunks, storageMB, indexMB, modelMB, lastFullAt, lastFullDurationMs, lastUpdatedAt, calibrated };
}

// Embedding-model DOWNLOAD status for the settings Model section — distinct from
// "loaded into memory" (which the search modal signals ambiently, so settings does
// not repeat it). Tries the parent-side Cache-API probe first; because parent
// visibility into the iframe's cache is unproven on iPhone (the cacheSeen canary),
// it falls back to a definitely-loaded embedder, then to the last model-delivery log
// entry that recorded cacheSeen>0 — either implies the bytes are on disk. Never throws.
export async function getModelStatus(p: ModelPorts): Promise<ModelStatus> {
    const spec = p.spec;
    const name = spec.repo.includes('/') ? spec.repo.split('/')[1] : spec.repo;
    let downloaded = false, persisted: boolean | null = null;
    const st = await p.probe();
    if (st) { downloaded = st.downloaded; persisted = st.persisted; }
    if (!downloaded) {
        if (p.embedderLoaded()) {
            downloaded = true;
        } else {
            try {
                const entries = await p.logger.readAll();
                for (let i = entries.length - 1; i >= 0; i--) {
                    if (entries[i].type === 'model-delivery') {
                        if ((entries[i] as ModelDeliveryEntry).cacheSeen > 0) downloaded = true;
                        break;
                    }
                }
            } catch { /* log unreadable */ }
        }
    }
    return { downloaded, persisted, name, dim: spec.dim };
}

// User-invoked "Delete model" (settings). Removes the active model's ~100 MB of
// Cache-API bytes (the inverse of the switch-time evictStaleModelCaches), drops the
// in-memory copy, and records a model-delivery entry with cacheSeen:0 so the three
// sources getModelStatus() reads — Cache probe, loaded embedder, last delivery log —
// all agree the model is gone. The next search re-downloads it. Best-effort +
// parent-side: on iPhone, where the parent may not see the iframe's cache (the
// cacheSeen canary), the bytes can survive until reload, same caveat as eviction.
export async function deleteModel(p: ModelPorts): Promise<{ deleted: number }> {
    const spec = p.spec;
    let deleted = 0;
    try {
        deleted = await p.deleteCaches();
    } catch (e) {
        await p.logger.appendError('model-delete', e);
        throw e instanceof Error ? e : new Error(String(e));
    } finally {
        // Drop the runtime copy on ANY delete attempt — even a partial one. The iframe
        // holds the model in memory and getModelStatus() counts a loaded embedder as
        // "downloaded"; keeping it resident over a (possibly half-) deleted on-disk cache
        // would misreport state. teardown() also forces the next search to rebuild the
        // iframe and re-fetch cleanly — the intended consequence of a delete.
        await p.teardown();
    }
    // Keep the log fallback honest: after a delete our cache holds 0 entries, so record
    // that — else the previous load's cacheSeen>0 would still read back as "downloaded".
    await p.logger.append({
        type: 'model-delivery',
        timestamp: new Date().toISOString(),
        key: spec.key,
        repo: spec.repo,
        revision: spec.revision,
        persisted: null,
        cacheSeen: 0,
        cacheEvicted: deleted,
    });
    return { deleted };
}
