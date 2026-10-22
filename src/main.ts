// Seek plugin entry. Three commands per v0 scope:
//   1. seek-search        — open the search modal
//   2. seek-reindex       — full reindex (nuke + rebuild)
//   3. seek-generate-log  — write seek-report.md from seek-log.ndjson
//
// Plus a headless CLI query handler (registerCliHandler), exposed only when the
// obsidian-cli bridge is present: `obsidian seek:search query="..."`. Unlike the
// palette command (which opens a modal and returns void), the CLI handler returns
// a string the bridge writes to stdout — readable text by default, JSON with
// `format=json`. See the registration in onload.
//
// Intentional non-features for v0:
//   - No settings tab (zero admin console, per task brief)
//   - No incremental reindex
//   - No sync sidecar protocol
//   - No model-cache management
//   - No MCP wrapper

import { Modal, Notice, Plugin, TFile } from 'obsidian';
import type { App } from 'obsidian';
import { LocalEmbedder, LOCAL_MODEL, LEGACY_ENGLISH_MODEL_ID, EMBEDDING_DIM } from './embedder';
import { activeModelSpec, resolveOverrideSpec, evictStaleModelCaches, deleteModelCaches, probeModelDownloaded } from './model-registry';
import { pluginIdentity } from './identity';
import { sweepOrphanTmpFiles } from './sidecar';
import type { SeekSettings, IndexCompleteEntry, ModelDeliveryEntry, SearchEntry, ScoredChunk, Device } from './types';
import { DEFAULT_SETTINGS, migrateSettings } from './types';
import { IndexStore, indexDbPrefix } from './index-store';
import { SeekLogger } from './logger';
import { Forensics } from './forensics';
import { RecentSearches } from './recents';
import { SearchOrchestrator, type SearchOverride, type ExperimentOverride } from './search';
import { SeekSearchModal, TITLE_NAV_COVERAGE_MIN, titleNavCoverage, type IndexBanner, type ResultOpenInfo } from './search-modal';
import {
    buildNoteLink,
    insertLinkInEditor,
    isInsertableMarkdownFile,
    resolveInsertLinkAlias,
    resolveInsertLinkSubpath,
} from './insert-link';
import { indexBannerSpec } from './index-notice';
import { SeekSettingTab } from './settings-tab';
import { collectPlatformInfo, isMobilePlatform, resolveDevice, recordActiveBackend, maybeDemoteOnCrash } from './platform';
import { CompositorPacer } from './pacer';
import { shouldUnloadEmbedder, type UnloadGateState } from './embedder-lifecycle';
import { TaskContextTracker, type TaskContext } from './task-context';
import type { LongTaskEntry, MemoryPressureEntry, StorageSnapshotEntry, EvictionSuspectedEntry, AppLocalFetchEntry } from './types';
import { exportMcpIndex } from './mcp-export';
import { IndexLifecycle, type LifecyclePorts } from '../core/index-lifecycle';

// Ribbon action tooltip. Part of the ribbon item's persisted id
// (`<pluginId>:<title>`) — renaming it silently resets every user's
// quick-access pick and hide/reorder state for the icon. Never change it.
export const RIBBON_TITLE = 'Seek search';

// Long-task threshold. PerformanceObserver fires for any task ≥50 ms by spec,
// but at that floor we'd flood the log. 250 ms is the rough threshold above
// which the user perceives a stutter and is also the design-doc latency
// budget for search.
const LONG_TASK_THRESHOLD_MS = 250;

// Extensions Seek indexes: markdown notes always, plus .base files (Obsidian
// Bases — YAML view definitions, indexed via a synthetic doc; see
// base-extractor.ts) when `indexBases` is on. The orchestrator's collection set
// (indexableFiles) must agree with this, so both gate on the same setting.
function isIndexableFile(f: TFile, indexBases: boolean): boolean {
    if (f.extension === 'md') return true;
    return indexBases && f.extension === 'base';
}




// Mobile-only embedder unload (see maybeUnloadEmbedder). After this long with no
// model use in a quiescent state, tear down the iframe to release its ~240 MB
// model + ratcheted WASM heap; the next search pays one cold reload. The race
// with a pending edit flush is settled by the unload PREDICATE (an armed flush
// timer counts as `pending`), not by the relative size of these constants.
// Checked on a coarse interval — a minute of slack on a 3-minute idle is fine.
const IDLE_UNLOAD_MS = 3 * 60 * 1000;

const UNLOAD_CHECK_MS = 60 * 1000;



// DTOs returned to the settings tab by getIndexStats() / getModelStatus(). Defined
// here (not types.ts) because they describe this plugin's read API; settings-tab.ts
// imports them as types.
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

export default class SeekPlugin extends Plugin {
    private embedder = new LocalEmbedder();
    private store = new IndexStore();
    private logger!: SeekLogger;
    private orchestrator!: SearchOrchestrator;
    // Mutated in place on settings change so the orchestrator (which holds the
    // same reference) always reads current values. See types.ts SeekSettings.
    settings: SeekSettings = { ...DEFAULT_SETTINGS };

    // Promise that resolves once the model is loaded. Lazy-init: we don't
    // want to spend 250 MB of RAM on plugin startup if the user never opens
    // the search modal. The first search/reindex invocation triggers it.
    private modelLoadPromise: Promise<void> | null = null;

    // Async observer handles + global handlers we register on load and
    // explicitly tear down on unload. Without cleanup these leak into the
    // next plugin reload and we end up with duplicate logging on every hot
    // reload during development.
    private longTaskObserver: PerformanceObserver | null = null;
    // Task contexts as SPANS, not a scalar (audit R2 #9 kept the overlap
    // tolerance; issue #5 forced the span upgrade): contexts overlap — opening
    // the search modal during a running reindex used to stomp the scalar back
    // to 'idle' — and, worse, the longtask observer delivers entries only
    // AFTER a task ends, so a read-at-delivery stack labeled the final task of
    // every phase (and every un-wrapped path) 'idle'. The tracker records
    // push/pop as timestamped spans and attributes each longtask by interval
    // overlap; current() preserves the old top-of-stack read for the
    // behavioral consumers (isIndexing, the mobile unload gate).
    private readonly taskCtx = new TaskContextTracker();
    private get currentTaskContext(): TaskContext | 'idle' {
        return this.taskCtx.current();
    }
    private pushTaskContext(c: TaskContext): void {
        this.taskCtx.push(c);
    }
    private popTaskContext(c: TaskContext): void {
        this.taskCtx.pop(c);
    }
    private onError: ((e: ErrorEvent) => void) | null = null;
    private onUnhandledRejection: ((e: PromiseRejectionEvent) => void) | null = null;
    private onVisibilityChange: (() => void) | null = null;
    private onPageHide: (() => void) | null = null;
    // The document the visibilitychange listener is bound to, captured at add-time.
    // activeDocument tracks the focused window, which can change to a popout between
    // load and unload — so removing against a fresh activeDocument would target the
    // wrong document and leak the main-window listener. Bind + unbind via this ref.
    private visibilityDoc: Document | null = null;
    // Crash forensics (see forensics.ts). Created in onload once the vault
    // scope (appId) is known; null only during the first lines of onload.
    private forensics: Forensics | null = null;
    // Recent searches (see recents.ts) — per-device localStorage, same
    // manifest-id + vault scoping as forensics. Null only during early onload.
    private recents: RecentSearches | null = null;


    // True while a reindex / incremental embed is running. currentTaskContext is
    // private; this is the read-only surface the settings Index status card reads
    // (on open and while polling a live reindex) to show its "Indexing…" state.
    get isIndexing(): boolean { return this.currentTaskContext === 'indexing'; }

    // The backend the embedder ACTUALLY loaded on, or null before the first
    // successful load. Not the same question as resolveDevice(): that returns the
    // REQUEST ('auto' = try WebGPU, fall back to WASM), so only the loaded device
    // answers "what is this run embedding on?" — an auto request that lost the
    // WebGPU init reads 'wasm' here. Surfaced by the settings reindex row so a
    // slow rebuild is attributable to the CPU path instead of looking like a hang.
    get activeBackend(): Device | null {
        return this.embedder.loaded ? this.embedder.device : null;
    }

    // Non-null while an incremental pass is in flight, carrying its file count.
    // Read by the settings status card. Covers the catch-up drain too, which runs
    // under the 'catchup' task context and so is invisible to isIndexing — that
    // drain IS the startup backlog issue #8's reporter watches, so a card reading
    // "Up to date" through it would be the same lie in a quieter voice.
    get incrementalWork(): { files: number } | null {
        return this.life.incrementalFiles > 0 ? { files: this.life.incrementalFiles } : null;
    }
    // The index lifecycle (queues, flush, catch-up, drift recovery, identity heal, health) lives in core/index-lifecycle.ts; this class supplies the Obsidian ports and keeps the names the rest of the plugin calls.
    private life: IndexLifecycle = new IndexLifecycle(this.lifePorts());
    private lastActiveFile: TFile | null = null;
    private lastModelUseAt = 0;                  // epoch ms of the last ensureModelLoaded; drives the idle-unload timer (mobile)
    get isIndexPaused(): boolean { return this.life.indexPaused; }
    get indexHealthState(): 'healthy' | 'recovering' | 'degraded' { return this.life.indexHealth; }

    private lifePorts(): LifecyclePorts {
        const o = this;
        return {
            get host() { return o.orchestrator; },
            get store() { return o.store; },
            get logger() { return o.logger; },
            get settings() { return o.settings; },
            get mobile() { return isMobilePlatform(); },
            hidden: () => activeDocument.hidden,
            embedderLoaded: () => o.embedder.loaded,
            notify: (m, ms) => { new Notice(m, ms); },
            setTimer: (fn, ms) => window.setTimeout(fn, ms),
            clearTimer: h => window.clearTimeout(h as number),
            pushTaskContext: c => o.pushTaskContext(c),
            popTaskContext: c => o.popTaskContext(c),
            ensureModelLoaded: () => o.ensureModelLoaded(),
            overrideActive: () => !!resolveOverrideSpec(o.settings),
            identity: () => pluginIdentity(),
            newPacer: () => new CompositorPacer(),
            mtimeOf: p => { const f = o.app.vault.getAbstractFileByPath(p); return f instanceof TFile ? f.stat.mtime : -1; },
            isIndexing: () => o.isIndexing,
            confirm: message => new ConfirmModal(o.app, message).openAndConfirm(),
            afterFullReindex: () => o.emitStorageSnapshot('post-reindex'),
        };
    }

    private enforceIndexIdentity(): Promise<boolean> { return this.life.enforceIndexIdentity(); }
    private periodicReconcile(): Promise<void> { return this.life.periodicReconcile(); }
    private flushDirty(): Promise<void> { return this.life.flushDirty(); }
    private reconcileOnLoad(): Promise<void> { return this.life.reconcileOnLoad(); }
    private onSearchActivity(active: boolean): void { this.life.onSearchActivity(active); }
    private onQueryInFlight(inFlight: boolean): void { this.life.onQueryInFlight(inFlight); }
    private withQueryInFlight<T>(fn: () => Promise<T>): Promise<T> { return this.life.withQueryInFlight(fn); }
    private applyPeerAheadBanner(): void { this.life.applyPeerAheadBanner(); }
    private onPersistentDrift(): void { this.life.onPersistentDrift(); }
    pauseIndexing(): void { this.life.pauseIndexing(); }
    resumeIndexing(onProgress?: (msg: string) => void): Promise<void> { return this.life.resumeIndexing(onProgress); }

    // fork 1.1.3 src/main.ts:1490 SeekPlugin.enqueueIfDirty (the TFile and extension check stay here; the queue is the lifecycle's)
    private async enqueueIfDirty(file: TFile | null): Promise<void> {
        if (!file || !isIndexableFile(file, this.settings.indexBases)) return;
        await this.life.enqueueIfDirty(file.path, file.stat.mtime);
    }


    async onload() {
        // Ribbon action (issue #9). Registered FIRST, before any await: on phones
        // the navbar's "Quick access ribbon item" (vault config
        // mobileQuickRibbonItem) is resolved against the ribbon list once, at
        // layout-ready, so an icon added after onload's awaits can come up missing
        // on a slow start. The item id is `<pluginId>:<title>`, and Obsidian keys
        // the quick-access pick and the hide/reorder state on it, so the title
        // must never change. Guarded by main-ribbon.test.ts.
        this.addRibbonIcon('search', RIBBON_TITLE, () => {
            if (!this.orchestrator) { new Notice('Seek: still loading — try again in a moment'); return; }
            this.openSearchModal();
        });
        this.logger = new SeekLogger(this.app, this.manifest.id);
        // Sweep any pre-existing root-level seek-log/init/captures files into the
        // hidden LOG_DIR next to the index, THEN tail-truncate this device's log if it
        // has outgrown MAX_LOG_BYTES (append-only logs have no natural ceiling), THEN
        // prune any abandoned other-device / legacy logs (pruneOrphanLogs). All three are
        // fire-and-forget: new writes already target LOG_DIR, the report reads both
        // locations during the migration window, and rotation/pruning only shrink the tail
        // or drop dead files — so this blocks nothing on the load path. The steps chain in
        // order so each operates on the files at their final LOG_DIR location.
        void this.logger.migrateRootFiles()
            .then(() => this.logger.rotateIfOversize())
            .then(() => this.logger.pruneOrphanLogs())
            .catch(e => this.logger.appendError('logger-onload-maintenance', e).catch(() => {}));
        // Load persisted settings (merge over defaults so new keys appear).
        // Mutate the existing object in place — the orchestrator holds this
        // same reference.
        const raw = ((await this.loadData()) ?? {}) as Partial<SeekSettings>;
        // Rev 4 = sidecar path pinned to the literal '.obsidian'. Capture the
        // pre-migration rev HERE — the actual sidecar FILE move runs further below
        // (it needs the old active-override + new literal paths), and migrateSettings
        // is about to overwrite raw.settingsRev, so the flag must be read first.
        const migrateSidecarPath = (raw.settingsRev ?? 1) < 4;
        // Key-level schema migrations (rev 2 denseWeight rescale, rev 5 defaults
        // ratification — see migrateSettings in types.ts, where they're unit-tested).
        // Mutates `raw` and stamps settingsRev; runs BEFORE the Object.assign so the
        // migrated values win over the persisted ones rather than being overridden.
        migrateSettings(raw);
        Object.assign(this.settings, DEFAULT_SETTINGS, raw);
        await this.saveData(this.settings);
        // Scope the index DB per vault. IndexedDB is shared across every vault
        // window (one Electron origin), so an unscoped name means vault A's
        // reindex destroys vault B's index (see index-store.ts LEGACY_DB_NAME).
        // appId is Obsidian's stable per-vault id — the same key it uses for
        // its own vault-scoped localStorage; not in the public typings, hence
        // the cast. Vault name fallback keeps a (rename-fragile) scope if a
        // future Obsidian drops appId.
        const appId = (this.app as unknown as { appId?: string }).appId;
        const vaultScope = appId ?? this.app.vault.getName();
        // Scope the DB by PLUGIN id too (indexDbPrefix), not just the vault, so a
        // second Seek build in this vault (e.g. an id 'seek-prototype' dev build)
        // owns a separate database. id 'seek' → 'seek-index:<appId>', unchanged.
        await this.store.open(vaultScope, indexDbPrefix(this.manifest.id));

        // Crash forensics: synchronous localStorage breadcrumbs (vault-scoped
        // like the IDB name — localStorage is origin-shared across vaults on
        // mobile). bootInspect classifies an unclean previous session and we
        // promote it into the log; this is the ONLY way a jetsam kill becomes
        // visible, since async NDJSON appends die with the process. Scoped by
        // plugin id as well, so a co-installed build's breadcrumbs can't be
        // misread as this build's crash.
        this.forensics = new Forensics(`${this.manifest.id}:${vaultScope}`, this.logger.deviceId, this.logger.sessionId);
        // Recent searches share the forensics scope: plugin id keeps a
        // co-installed build's history separate, vault scope keeps two vaults
        // on one iOS origin from bleeding queries into each other.
        this.recents = new RecentSearches(`${this.manifest.id}:${vaultScope}`);
        const crash = this.forensics.bootInspect();
        if (crash) {
            // Forensics: always persist the classified crash to the per-device
            // log. This is the diagnostic surface (read via the log report) — it
            // is silent by design, not a toast.
            await this.logger.append(crash);
            // Tripwire WITH a side effect: maybeDemoteOnCrash performs the sticky,
            // per-device WebGPU→WASM demotion (a localStorage write) when a mobile
            // device was killed mid-reindex in the foreground while WebGPU was the
            // active backend, so the next reindex doesn't walk into the same OS
            // kill. It MUST run on every boot — only its actionable "you're now on
            // WASM" result is surfaced. The generic "previous session ended
            // uncleanly" notice was removed: on iOS onunload never fires on an OS
            // suspend-kill, so any routine 12h+-backgrounded reopen classifies as a
            // benign `evicted-while-hidden` exit — that fired the toast on
            // essentially every mobile open for normal app lifecycle.
            if (maybeDemoteOnCrash(crash.verdict)) {
                new Notice('Seek: last session was killed mid-reindex on WebGPU — this device is now on WASM. Re-enable WebGPU in settings to retry.', 8000);
            }
        }

        // WebGPU loss diagnostics: the iframe pushes device-created / device-
        // lost / uncaptured-error events from its requestDevice hook. device-
        // lost is the only JS-visible discriminator between a GPU-process
        // death (page survives, this fires) and a WebContent kill (silence) —
        // see [[Seek Mobile WebGPU Investigation]]. Forensics beat FIRST and
        // synchronously: if the page is about to die too, the localStorage
        // write must win the race; the NDJSON append is the best-effort twin.
        this.embedder.onIframeEvent = (event) => {
            const kind = typeof event.kind === 'string' ? event.kind : 'webgpu-event';
            const detail: Record<string, number | string | boolean | null> = {};
            for (const [k, v] of Object.entries(event)) {
                if (k !== 'kind') detail[k] = v;
            }
            this.forensics?.beat(kind, detail);
            void this.logger.append({
                type: 'webgpu-event',
                timestamp: new Date().toISOString(),
                kind,
                ...detail,
            });
            // WebGPU device death (GPU process died, page survived). The in-flight
            // embedBatch would otherwise hang on the dead device until the per-RPC
            // timeout; reject it now (recoverable, NOT 'DISPOSED') so the embed
            // catch's recycle+retry rebuilds a fresh device promptly. Skipped while
            // unloading — the iframe is being torn down; don't poke it.
            if (kind === 'webgpu-device-lost' && !this.unloading) {
                this.embedder.failInflight('webgpu device lost');
            }
        };

        // One-time DB v3→v4 transition: if the user already has fp32 vectors
        // from a prior install, pack their sign-bit binary siblings in the
        // background. Steady-state this is a no-op (the count guard inside
        // returns 0 immediately). Awaited because the orchestrator's first
        // search assumes the binary index is loadable — but the actual work
        // is ~5 ms for an empty store and ~100 ms for a 5k-chunk vault.
        try {
            await this.store.backfillBinaryIfMissing();
        } catch (e) {
            // Backfill failure isn't fatal: the user can rebuild via "Full
            // reindex". Log it and continue plugin init.
            await this.logger.appendError('binary-backfill', e);
        }

        // Sidecar index dir. CRITICAL: resolved from a LITERAL config-folder
        // name, not this.manifest.dir — manifest.dir resolves against the
        // device's active Override Config Folder (vault.configDir), which is
        // per-device and never synced, so a split-config setup made producer
        // and consumer read different paths → silent zero results. See the
        // Sidecar Integration Plan §config-folder CRITICAL.
        const sidecarIndexDir = this.resolveSidecarIndexDir();
        // The pre-rev-4 path (active-override-relative). Used only to migrate an
        // existing index off it into the literal path on upgrade.
        const legacySidecarDir = this.manifest.dir ? `${this.manifest.dir}/index` : null;
        this.orchestrator = new SearchOrchestrator(this.app, this.store, this.embedder, this.logger, this.settings, this.forensics, sidecarIndexDir, this.taskCtx);
        this.addCommand({
            id: 'seek-export-mcp-index',
            name: 'Export complete MCP index',
            callback: () => {
                void exportMcpIndex(this.app.vault.adapter, this.store)
                    .then(meta => new Notice(`Seek: exported ${meta.chunkCount} chunks for MCP`))
                    .catch(error => new Notice(`Seek MCP export failed: ${error instanceof Error ? error.message : String(error)}`));
            },
        });
        // The orchestrator is pull-based; this is its one injected outbound edge — it
        // fires when persistent frame/BM25 drift survives the cooldown, and we drive the
        // embed-free recovery ladder from the plugin (which owns scheduling + gating).
        this.orchestrator.setPersistentDriftHandler(() => this.onPersistentDrift());
        this.addSettingTab(new SeekSettingTab(this.app, this));

        // Incremental indexing: live vault-event triggers + the startup catch-up
        // sweep. Wired here, after the orchestrator exists.
        this.wireIncrementalIndexing();
        // Sidecar restore THEN the mtime-diff sweep, sequenced (not raced): on a
        // cold/evicted device hydrate must finish populating the store before
        // reconcileOnLoad computes its delta, or computeDelta would read the empty
        // store, mark the whole vault dirty, and re-embed everything the sidecar
        // already holds. All off the load path (fire-and-forget IIFE) so plugin
        // load never blocks. sweepOrphanTmpFiles first cleans any crashed atomic
        // write. Each step is gated/no-op when the sidecar is disabled.
        void (async () => {
            let identityHandled = false;
            try {
                // One-time rev-3→4 migration: move an index written under the
                // old active-override path into the literal '.obsidian' path,
                // BEFORE hydrate reads the new location (else hydrate finds it
                // empty and re-embeds what we already have). Only in 'config'
                // mode (the literal path is the target) and only when the
                // active override actually diverges from it.
                if (this.settings.sidecarEnabled && migrateSidecarPath
                    && this.settings.sidecarIndexLocation === 'config'
                    && legacySidecarDir && legacySidecarDir !== sidecarIndexDir) {
                    await this.migrateSidecarFiles(legacySidecarDir, sidecarIndexDir);
                }
                if (this.settings.sidecarEnabled && sidecarIndexDir) await sweepOrphanTmpFiles(this.app.vault.adapter, sidecarIndexDir, this.logger.deviceId);
                // Version-identity gate BEFORE any catch-up: if the local index was
                // built under a different chunker/model/revision/dim than this build,
                // it is stale — hydrate from a matching peer (embed-free) / desktop-
                // reindex / mobile-wait, and skip the normal catch-up this boot (never
                // re-chunk or re-embed onto a stale-id index — the mobile jetsam path).
                identityHandled = await this.enforceIndexIdentity();
                if (!identityHandled) {
                    // Gated, not unconditional: the persisted dir-signature lets a
                    // crash-relaunch with an unchanged vault skip the whole-vault
                    // re-chunk (the iOS 1fps loop), while an empty/evicted store
                    // still forces the recovery sweep.
                    await this.orchestrator.reconcileSidecarIfChanged();
                    // Sidecar just scanned → raise the "update Seek" banner if a peer's index
                    // is newer than this build (and gate the mobile catch-up below off it).
                    this.applyPeerAheadBanner();
                }
            } catch (e) {
                await this.logger.appendError('sidecar-hydrate-onload', e).catch(() => {});
            }
            // Steer split-config Obsidian Sync users to the visible folder: the
            // one case the hidden literal path can't reach (a renamed config
            // folder never receives '.obsidian/' over Sync). Fire-and-forget,
            // after hydrate so a working setup is never interrupted.
            await this.maybeSteerSidecarLocation().catch(() => {});
            // Startup mtime-diff sweep — the backstop for everything changed while
            // Seek wasn't watching (external sync, edits with the plugin disabled,
            // in-session deletes lost on a crash). On desktop it loads the model +
            // re-embeds; on cold mobile it applies deletes/moves now and defers
            // edits to the first search. Skipped when the identity gate took over
            // (identityHandled), which now means one of:
            //   • a peer-sidecar rebuild or in-place stamp already healed the index, or
            //   • the index is version-stale and BOTH platforms are WAITING for an
            //     explicit reindex (consent-gated, 2026-06-23 — no more desktop
            //     auto-reindex). We must not re-chunk onto a stale-id index here, so
            //     while-off external edits to notes the user never opens stay deferred
            //     until they hit “Reindex now” (a full rebuild catches everything up).
            //     In-session edits still index live via the flushDirty event path, so
            //     the gap is only un-touched, externally-changed notes — an accepted
            //     freshness trade for not auto-nuking, and the banner says so.
            if (!identityHandled) await this.reconcileOnLoad();
            // The clean-launch BM25/frame warm that used to fire here ('startup') has
            // moved into ensureModelLoaded ('model-load') so it overlaps the model
            // load instead of taxing app-open. reconcileOnLoad still warms ('delta')
            // when its diff finds changes; warmCaches's `warming` guard dedups the two.
        })();

        // Periodic sidecar reconcile: remote arrivals don't fire vault events for
        // .obsidian/ dotfiles, so poll for another device's freshly-synced index
        // every 5 min. reconcileSidecarIfChanged gates on a cheap (persisted) dir
        // signature, so a warm index with no new sidecar files skips the
        // whole-vault re-chunk entirely. Cleared automatically on unload.
        this.registerInterval(window.setInterval(() => void this.periodicReconcile(), 5 * 60 * 1000));

        // Mobile: reset the WASM heap during genuine idle. Once a minute, if the
        // model hasn't been used for IDLE_UNLOAD_MS, tear it down (when quiescent);
        // the next search reloads. Desktop is excluded — the heap ratchet is a
        // mobile/iOS problem, and a cold reload on every post-idle desktop search
        // would be a latency regression for no benefit. Cleared on unload.
        if (isMobilePlatform()) {
            this.registerInterval(window.setInterval(() => {
                if (Date.now() - this.lastModelUseAt >= IDLE_UNLOAD_MS) this.maybeUnloadEmbedder('idle');
            }, UNLOAD_CHECK_MS));
        }

        // Wire global observers + handlers BEFORE we do anything else, so
        // any error in the init path itself gets logged.
        this.wireGlobalErrorHandlers();
        this.wireLongTaskObserver();
        this.wireMemoryPressureHandlers();

        // Init the iframe runtime OFF the blocking onload path. The search command
        // (registered below) no longer waits on it: an early search coalesces onto
        // this same memoized init inside embedder.load() (embedder.ts init()/load()),
        // so there is no init race. The init log entry, the diagnostics that want a
        // live iframe (platform GPU probe, app-local probe), and the failure Notice
        // all ride this continuation instead of blocking app-open. The diagnostics
        // are DEFERRED, not removed — still dogfooding.
        void this.embedder.init()
            .then(async (initEntry) => {
                await this.logger.writeInit(initEntry);
                await this.logger.append(initEntry);

                const platformInfo = await collectPlatformInfo();
                await this.logger.append(platformInfo);

                // Boot-time storage snapshot. Week-over-week drops in storageUsedMB
                // are the canary for Cache API / IDB eviction even when no cold-start
                // outlier fires. Cheap — one navigator.storage.estimate().
                await this.emitStorageSnapshot('boot');

                // `app://local/...` capability probe. Runs once per session after
                // iframe init (before any model load) so the result is available
                // regardless of whether the user ever searches.
                if (initEntry.iframeReady) {
                    this.runAppLocalProbe().catch(e => this.logger.appendError('app-local-probe', e));
                }

                // No success toast — readiness is signalled by the modal glyph
                // brightening. Only a genuine failure interrupts: a dead iframe means
                // no search will work, which is worth one toast.
                if (!initEntry.iframeReady || initEntry.error) {
                    new Notice(
                        `Seek: search engine failed to start${initEntry.error ? ` — ${initEntry.error.slice(0, 80)}` : ''}. See Settings → Seek → Generate logging report.`,
                        8000,
                    );
                }
            })
            .catch(e => this.logger.appendError('embedder-init-onload', e).catch(() => {}));

        // Auto-request persistent storage so iOS / Safari won't evict our
        // ~250 MB model cache + index under memory pressure. Best-effort.
        if (navigator.storage?.persist) {
            navigator.storage.persist().catch(e => {
                console.warn('[seek] navigator.storage.persist() failed:', e);
            });
        }

        // ---- Commands ----

        this.addCommand({
            // Obsidian auto-namespaces command ids with the plugin id, so the
            // public id is already `<plugin-id>:search` — don't repeat the prefix.
            id: 'search',
            name: 'Search',
            callback: () => this.openSearchModal(),
        });

        // ---- obsidian://seek deep-link --------------------------------
        // `obsidian://seek?query=<urlencoded>[&mode=open][&vault=<name>]`.
        // registerObsidianProtocolHandler is a core Plugin API (present on
        // EVERY platform, incl. mobile — unlike the CLI bridge below), so this
        // is the mobile-safe deep-link surface. Two modes:
        //   search (default) — open the modal pre-filled + running the query
        //                      (human-in-the-loop; the modal owns cold-start).
        //   open            — headless: load the model, run the query, open the
        //                      top hit's note ("jump to my note about X").
        // `mode` (not `action`) is the discriminator because ObsidianProtocolData
        // RESERVES `action` for the protocol host ('seek') — a `&action=` param
        // would collide with it. The scheme is deliberately READ-ONLY: any web
        // page can fire an obsidian:// URL, so no write/reindex/config action is
        // ever exposed here — those stay command/CLI-only where intent is explicit.
        this.registerObsidianProtocolHandler('seek', (params) => {
            // Obsidian percent-DECODES params, so `%23`→`#` etc. arrive clean.
            // The producer must encode `#` (URL fragment delimiter AND Seek's
            // own `#tag` sigil) — the modal's "copy link" action does this.
            const query = typeof params.query === 'string' ? params.query : '';
            if (params.mode === 'open') void this.openTopResult(query);
            else this.openSearchModal(query);
        });

        // Reindex and diagnostics are intentionally NOT palette commands: a full
        // reindex nukes and re-embeds the whole vault (too destructive for a fuzzy
        // palette match), so it lives in Settings → Seek → Index behind a confirm;
        // the logging report is a Settings button (openLoggingReport). Sidecar
        // reconcile/rebuild are automatic. Search is the only command Seek adds.

        // ---- Headless CLI query handler --------------------------------
        // `obsidian seek:search query="..." [limit=N] [verbose]`.
        //
        // registerCliHandler is provided by the obsidian-cli companion, not the
        // core Obsidian API typings — hence the cast and the runtime guard. On
        // mobile (no CLI bridge) the method is absent and we simply skip it.
        //
        // The contract that makes results "read out" at all: the handler RETURNS
        // a string, which the bridge pipes to stdout. addCommand callbacks return
        // void (their job is to open the modal), so they can never feed the CLI —
        // that is why `seek:seek-search` was unreachable. Output defaults to a
        // readable text list (rank/score/path/excerpt); `format=json` emits the
        // machine shape (path/title/score/excerpt), matching the predecessor
        // plugin so the same parsing works.
        const registerCliHandler = (this as unknown as {
            registerCliHandler?: (
                id: string,
                description: string,
                params: Record<string, { value?: string; description: string; required: boolean }>,
                handler: (args: Record<string, string | boolean | undefined>) => Promise<string>,
            ) => void;
        }).registerCliHandler;

        if (typeof registerCliHandler === 'function') {
            registerCliHandler.call(
                this,
                'seek:search',
                'Seek on-device semantic search (hybrid BM25 + dense embeddings + recency)',
                {
                    query: { value: '<text>', description: 'Search query (supports inline filters: #tag, tag:, path:, [k:v], dates)', required: true },
                    limit: { value: '<n>', description: 'Max results (default: 10)', required: false },
                    format: { value: 'text|json', description: 'Output format (default: text — readable list; json for programmatic use)', required: false },
                    recencyWeight: { value: '<ε>', description: 'Override recency weight ε for THIS query only (additive; default = setting). Not persisted — for scrobbling recency configs.', required: false },
                    recencyHalflife: { value: '<days>', description: 'Override recency half-life in days for THIS query only (default = setting). Not persisted.', required: false },
                    synv2: { value: 'true|false', description: 'Override synonyms v2 (phrase-trigger expansion) for THIS query only. Not persisted — for A/B probes; the first synv2=true call builds the dictionary.', required: false },
                },
                // Flag params arrive as the string "true"/"false", not booleans
                // (the obsidian-cli/Templater convention), so widen the type and
                // compare against both.
                async (args: Record<string, string | boolean | undefined>): Promise<string> => {
                    const query = typeof args.query === 'string' ? args.query : '';
                    const asJson = args.format === 'json';
                    // Error sink that honors the active format: JSON callers get a
                    // parseable {error}, humans get a one-liner.
                    const fail = (msg: string): string =>
                        asJson ? JSON.stringify({ error: msg, results: [] }) : `Seek error: ${msg}`;

                    if (!query) return fail('query is required');
                    // Captured for the withQueryInFlight closure below (a `this.`
                    // null-check doesn't narrow across the closure boundary).
                    const orchestrator = this.orchestrator;
                    if (!orchestrator) return fail('Seek not initialized — plugin still loading');

                    const parsedLimit = typeof args.limit === 'string' ? parseInt(args.limit, 10) : NaN;
                    const topK = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 10;

                    // Query-time overrides (scrobbling). Resolved into a
                    // SearchOverride and passed straight through to
                    // orchestrator.search() as a call-local argument — NEVER written
                    // into this.settings. search() reads this.settings fresh per
                    // query, and that settings object is shared by reference with
                    // every concurrent caller (another seek:search CLI call, the
                    // search modal, openTopResult); mutating it for the override's
                    // duration used to let a concurrent plain search silently rank
                    // against this call's override. Passing it as an argument
                    // instead means overlapping calls simply can't observe each
                    // other's overrides — nothing shared, nothing to leak. Not
                    // persisted (no saveSettings) either way. Same validation as
                    // the UI.
                    const ovEps = typeof args.recencyWeight === 'string' ? parseFloat(args.recencyWeight) : NaN;
                    const ovHl = typeof args.recencyHalflife === 'string' ? parseFloat(args.recencyHalflife) : NaN;
                    const epsOk = Number.isFinite(ovEps) && ovEps >= 0;
                    const hlOk = Number.isFinite(ovHl) && ovHl > 0;
                    const override: SearchOverride | undefined =
                        epsOk || hlOk
                            ? {
                                  ...(epsOk ? { epsilon: ovEps } : {}),
                                  ...(hlOk ? { halfLifeDays: ovHl } : {}),
                              }
                            : undefined;
                    // Synonyms-v2 valve override (A/B probes). Flag params arrive
                    // as the string "true"/"false" (see the handler comment above);
                    // same call-local discipline as the recency overrides — NEVER
                    // written into this.settings. Absent/garbage ⇒ settings rule.
                    const expOverride: ExperimentOverride | undefined =
                        args.synv2 === 'true' || args.synv2 === true ? { synonymsV2: true }
                        : args.synv2 === 'false' || args.synv2 === false ? { synonymsV2: false }
                        : undefined;

                    try {
                        // Under the query-in-flight gate: a running catch-up drain
                        // or bulk flush yields at its next batch boundary instead of
                        // making this call wait out the whole indexing pass (the
                        // modal gets the same preemption via its own edges).
                        const { results } = await this.withQueryInFlight(async () => {
                            // No modal here to overlap the cold-start, so block on the
                            // model load (3–10 s first call) before querying — otherwise
                            // the orchestrator embeds against an unloaded model.
                            await this.ensureModelLoaded();
                            return orchestrator.search(query, topK, override, expOverride);
                        });

                        // ---- format=json: programmatic / piped callers ---------
                        if (asJson) {
                            const mapped = results.map(r => {
                                const base: Record<string, unknown> = {
                                    path: r.note_path,
                                    // displayTitle carries the "(part N)" marker for
                                    // split chunks (absent otherwise); title itself is
                                    // now the clean, embedded/indexed form.
                                    title: r.displayTitle ?? r.title,
                                    score: r.score,
                                    excerpt: r.snippet ?? '',
                                };
                                return base;
                            });
                            return JSON.stringify({ results: mapped, query, count: mapped.length });
                        }

                        // ---- default: human-readable text ----------------------
                        // Minified single-line JSON wraps into an unreadable wall
                        // in a terminal. The readable form emits real newlines —
                        // one record per block: "rank  score  path", with the
                        // excerpt indented to align beneath the path.
                        if (results.length === 0) return `Seek · "${query}" · no results`;

                        const INDENT = ' '.repeat(11); // width of "NN  0.000  "
                        const lines: string[] = [
                            `Seek · "${query}" · ${results.length} result${results.length === 1 ? '' : 's'}`,
                            '',
                        ];
                        results.forEach((r, i) => {
                            lines.push(`${String(i + 1).padStart(2, ' ')}  ${r.score.toFixed(3)}  ${r.note_path}`);
                            const excerpt = (r.snippet ?? '').replace(/\s+/g, ' ').trim();
                            if (excerpt) lines.push(`${INDENT}${excerpt.length > 160 ? excerpt.slice(0, 159) + '…' : excerpt}`);
                            lines.push('');
                        });
                        return lines.join('\n').replace(/\n+$/, '');
                    } catch (err) {
                        return fail(err instanceof Error ? err.message : String(err));
                    }
                },
            );

            registerCliHandler.call(
                this,
                'seek:insert-link',
                'Seek search and insert a link to a result at the active editor cursor',
                {
                    query: { value: '<text>', description: 'Search query (supports inline filters: #tag, tag:, path:, [k:v], dates)', required: true },
                    rank: { value: '<n>', description: '1-based result rank to link (default: 1)', required: false },
                    alias: { value: '<text>', description: 'Optional link display text ([[note|alias]])', required: false },
                },
                async (args: Record<string, string | boolean | undefined>): Promise<string> => {
                    const query = typeof args.query === 'string' ? args.query : '';
                    if (!query) return 'Seek error: query is required';
                    // Captured for the withQueryInFlight closure (null-check narrowing).
                    const orchestrator = this.orchestrator;
                    if (!orchestrator) return 'Seek error: Seek not initialized — plugin still loading';

                    const parsedRank = typeof args.rank === 'string' ? parseInt(args.rank, 10) : NaN;
                    const rank = Number.isFinite(parsedRank) && parsedRank > 0 ? parsedRank : 1;
                    const explicitAlias = typeof args.alias === 'string' && args.alias.trim()
                        ? args.alias.trim()
                        : undefined;
                    const alias = resolveInsertLinkAlias(explicitAlias);

                    try {
                        // Under the query-in-flight gate, same as seek:search: a
                        // running drain/flush yields at its next batch boundary.
                        const { results } = await this.withQueryInFlight(async () => {
                            await this.ensureModelLoaded();
                            return orchestrator.search(query, rank);
                        });
                        const hit = results[rank - 1];
                        if (!hit) return `Seek error: no result at rank ${rank} for "${query}"`;
                        const file = this.app.vault.getAbstractFileByPath(hit.note_path);
                        if (!(file instanceof TFile) || !isInsertableMarkdownFile(file)) {
                            return `Seek error: result is not a markdown note (${hit.note_path})`;
                        }
                        // Same gate a click on this row would take (search-modal
                        // openResult): title-nav hit → [[Note]], section hit →
                        // [[Note#Section]].
                        const titleNav = titleNavCoverage(hit, this.settings.navTitleBoost) >= TITLE_NAV_COVERAGE_MIN;
                        const link = buildNoteLink(this.app, file, {
                            subpath: resolveInsertLinkSubpath(hit.heading_path, titleNav, file.basename),
                            alias,
                        });
                        const inserted = insertLinkInEditor(this.app, link);
                        if (!inserted.ok) return `Seek error: ${inserted.reason}`;
                        return link;
                    } catch (err) {
                        return `Seek error: ${err instanceof Error ? err.message : String(err)}`;
                    }
                },
            );
        }
    }

    // Set true the instant onunload starts so async callbacks (the WebGPU
    // device-lost handler) can't resurrect a teardown-in-progress iframe.
    private unloading = false;

    onunload() {
        this.unloading = true;
        // First thing, synchronously: a session whose record isn't closed at
        // next boot reads as a crash. Reload/disable/quit all pass through here.
        this.forensics?.markCleanEnd();
        this.embedder.teardown();
        this.orchestrator?.dispose();
        this.store.close();
        if (this.longTaskObserver) {
            try { this.longTaskObserver.disconnect(); } catch { /* swallow */ }
            this.longTaskObserver = null;
        }
        if (this.onError) window.removeEventListener('error', this.onError);
        if (this.onUnhandledRejection) window.removeEventListener('unhandledrejection', this.onUnhandledRejection);
        if (this.onVisibilityChange && this.visibilityDoc) this.visibilityDoc.removeEventListener('visibilitychange', this.onVisibilityChange);
        if (this.onPageHide) window.removeEventListener('pagehide', this.onPageHide);
        if (this.life.idleTimer != null) window.clearTimeout(this.life.idleTimer as number);
        if (this.life.structTimer != null) window.clearTimeout(this.life.structTimer as number);
        // vault/workspace events and the window 'blur' DOM event are registered
        // via registerEvent/registerDomEvent, so Obsidian tears them down for us.
    }

    // ── Sidecar index location ──────────────────────────────────────────────
    // The DEFAULT config-folder name. We pin to this literal default `.obsidian`
    // rather than vault.configDir (the per-device active override) so every device
    // resolves the SAME synced sidecar path. This is also the baseline
    // maybeSteerSidecarLocation compares vault.configDir AGAINST to detect a
    // renamed config folder.
    private static readonly DEFAULT_CONFIG_DIR = `.obsidian`;
    // Per-INSTANCE so a co-installed build (different manifest.id) gets its own
    // sidecar location and can't write into the public build's plugin folder. The
    // hidden default is `.obsidian/plugins/<id>/index` (id 'seek' → the historical
    // path, no migration); the visible opt-in folder is `<name> Index` (name
    // 'Seek' → 'Seek Index', unchanged). Still a LITERAL `.obsidian` (not
    // vault.configDir) so every device resolves the same synced path — the
    // config-folder CRITICAL fix.
    private get sidecarConfigDir(): string { return `.obsidian/plugins/${this.manifest.id}/index`; }
    private get sidecarVisibleDir(): string { return `${this.manifest.name} Index`; }

    // Hidden literal path by default; the vault-root visible folder only when a
    // split-config Obsidian Sync user opts in (see maybeSteerSidecarLocation).
    private resolveSidecarIndexDir(): string {
        return this.settings.sidecarIndexLocation === 'visible'
            ? this.sidecarVisibleDir
            : this.sidecarConfigDir;
    }

    // One-time rev-3→4 move of an index written under the old active-override
    // path into the literal path. Uses rename (a move) per file; idempotent and
    // non-fatal — a failed move leaves the source for the next reindex to
    // repopulate, never aborts hydrate.
    private async migrateSidecarFiles(from: string, to: string): Promise<void> {
        const adapter = this.app.vault.adapter;
        const ls = await adapter.list(from).catch(() => null);
        if (!ls || ls.files.length === 0) return; // nothing written under the old path
        if (!(await adapter.exists(to).catch(() => false))) await adapter.mkdir(to).catch(() => {});
        for (const path of ls.files) {
            const dest = `${to}/${path.slice(path.lastIndexOf('/') + 1)}`;
            // Never clobber the new location (a prior partial migration, or this
            // device already wrote there) — the literal path is authoritative.
            if (await adapter.exists(dest).catch(() => false)) continue;
            try {
                await adapter.rename(path, dest);
            } catch (e) {
                await this.logger.appendError('sidecar-migrate-file', e).catch(() => {});
            }
        }
    }

    // Steer the lone unreachable case to the visible folder: Obsidian Sync + a
    // RENAMED config folder. The hidden literal '.obsidian/' is never delivered
    // to a device booting a renamed config over Sync, so embeddings can't cross.
    // iCloud/Syncthing/Dropbox carry the literal path regardless, so they never
    // trip this. One-time per device (the condition is per-device) via
    // localStorage — a uniform-config device never sees it.
    private async maybeSteerSidecarLocation(): Promise<void> {
        if (!this.settings.sidecarEnabled) return;
        if (this.settings.sidecarIndexLocation !== 'config') return; // already opted in / steered
        const configDir = this.app.vault.configDir;
        if (configDir === SeekPlugin.DEFAULT_CONFIG_DIR) return;     // uniform config — literal path syncs fine
        // Obsidian Sync writes sync.json into the active config folder; its
        // presence is the in-use signal. iCloud/Syncthing have no such file.
        const onObsidianSync = await this.app.vault.adapter.exists(`${configDir}/sync.json`).catch(() => false);
        if (!onObsidianSync) return;
        const flagKey = `${this.manifest.id}-sidecar-steer-shown`;
        if (window.localStorage.getItem(flagKey)) return;
        window.localStorage.setItem(flagKey, '1');
        new Notice(
            `Seek: Obsidian Sync won't deliver the hidden index to a renamed config folder ("${configDir}"). ` +
            "Set Seek's index location to “Visible folder” (Settings → Seek → Sync) to sync embeddings across your devices.",
            12000,
        );
    }

    // Public pre-warm entry for the settings "Download now" button: fetches +
    // caches the ~100 MB model bytes (and loads it) so a user can pre-warm over
    // Wi-Fi before going offline, instead of search stalling on the first fetch.
    // Idempotent — delegates to the memoized loader below; a no-op if already loaded.
    async prewarmModel(): Promise<void> { await this.ensureModelLoaded(); }

    // Proactively release the embedder when it's provably safe — the only way to
    // shrink the iframe's WASM heap (WebAssembly.Memory never contracts within a
    // page, so a long mobile session ratchets toward the OOM that kills the next
    // model load). The next search/embed reloads transparently: ensureModelLoaded
    // sees `loaded` false and `modelLoadPromise` null and rebuilds (loadImpl calls
    // init() first). Nulling modelLoadPromise is load-bearing — without it,
    // ensureModelLoaded would hand back a resolved promise for a model that's gone
    // (it checks modelLoadPromise before loaded). Mirrors the manual
    // seek-unload-model command, gated by the pure shouldUnloadEmbedder predicate.
    private maybeUnloadEmbedder(reason: 'idle' | 'background'): void {
        const gate: UnloadGateState = {
            loaded: this.embedder.loaded,
            busy: this.currentTaskContext !== 'idle',
            queryActive: this.life.indexingBlocked,
            running: this.life.flushing || this.life.catchUpRunning || this.life.driftRecoveryRunning,
            pending: this.life.catchUpPending || this.life.driftRecoveryPending
                || this.life.dirtyQueue.size > 0 || this.life.deletedQueue.size > 0
                || this.life.idleTimer != null || this.life.structTimer != null,
        };
        if (!shouldUnloadEmbedder(reason, gate)) return;
        this.embedder.teardown();
        this.modelLoadPromise = null;
        const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        void this.logger.append({
            type: 'model-lifecycle',
            timestamp: new Date().toISOString(),
            event: 'unload',
            reason,
            heapMB: heap ? heap.usedJSHeapSize / 1e6 : null,
        }).catch(() => {});
        // Synchronous breadcrumb too — the background unload races a possible
        // jetsam kill, and the async log line above can be lost to it.
        this.forensics?.beat(reason === 'idle' ? 'model-unload-idle' : 'model-unload-bg');
    }

    private ensureModelLoaded(): Promise<void> {
        // Every search/embed path funnels through here, so this is the single
        // chokepoint that marks the model "in use" — the idle-unload timer counts
        // from it. Stamped even on the already-loaded fast path so a burst of
        // searches keeps the model resident.
        this.lastModelUseAt = Date.now();
        if (this.embedder.loaded) return Promise.resolve();
        if (this.modelLoadPromise) return this.modelLoadPromise;

        // Device selection. Desktop: WebGPU first with WASM fallback (design
        // doc: WebGPU ~4× faster on iPhone single-query historically, and
        // competitive on desktop). iOS: skip WebGPU entirely — see the iOS
        // skip rationale at the load() call below.
        this.modelLoadPromise = (async () => {
            // Span the load: wasm compile + session init + shader warmup are
            // main-thread-heavy and used to log as 'idle' long tasks.
            this.pushTaskContext('model-load');
            try {
                // Warm the frame + BM25 caches in the model-load shadow. warmCaches
                // reads the store (not the model), so it overlaps the cold model load
                // and the index is hot by the time the first query runs — recovering
                // the clean-launch COLD_START miss the old onload 'startup' warm
                // covered. Self-guarded: `warming` dedups the reconcile 'delta' warm,
                // and the mobile `!loaded` guard keeps cold mobile a no-op here (the
                // model isn't loaded yet at this point).
                void this.orchestrator.warmCaches('model-load');
                // q4: equal quality (bake-off NDCG@10 Δ=0.0005) and, on the
                // pinned v4 runtime, also the fastest + lightest config (20.6
                // ch/s, ~103 MB heap vs q8 13.2 ch/s, ~380 MB). q4's viability
                // depends on the v4 ORT-Web floor — see iframe-runner.ts
                // TRANSFORMERS_VERSION / dtype-ladder comments for the full
                // history (the q4-vs-q8 gap on old ORT-Web was real, not a
                // fusion confound). 'auto' = WebGPU (q4-only ladder) with WASM
                // q4 fallback. q4f16 excluded — Gemma's LayerNorm shader fails
                // to compile on Dawn with half-precision activations (ORT #26732).
                // Phase-5: when LOCAL_MODEL.enabled, load the trimmed
                // model from the vault via an app://local resource URL
                // instead of the HF CDN. getResourcePath appends a
                // `?<ts>` cache-buster (seen in the app-local probe) —
                // strip it so transformers.js path-joins
                // `<base>/onnx/model_*.onnx` cleanly.
                const ra = this.app.vault.adapter as unknown as { getResourcePath?: (p: string) => string };
                const localBase = LOCAL_MODEL.enabled && ra.getResourcePath
                    ? ra.getResourcePath(LOCAL_MODEL.vaultRelPath).split('?')[0].replace(/\/+$/, '')
                    : undefined;
                if (LOCAL_MODEL.enabled && !localBase) {
                    await this.logger.appendError('local-model', new Error('getResourcePath unavailable; using remote MODEL_ID'));
                }
                // Active model from the registry (debug override wins, else the
                // shipped default). spec.repo is the CDN-streamed load base on the
                // remote path; spec.key is the index drift-identity. EMBEDDING_DIM
                // now DERIVES from ACTIVE_MODEL_SPEC.dim (the single source), so a
                // shipped-model swap can't trip this. It only fires for a debug
                // model OVERRIDE whose real width differs from the build dim —
                // loud-log it (mis-indexing into the wrong-dim store is worse).
                const spec = activeModelSpec(this.settings);
                if (spec.dim !== EMBEDDING_DIM) {
                    await this.logger.appendError('model-registry', new Error(
                        `override model ${spec.key} dim ${spec.dim} != build dim ${EMBEDDING_DIM}; a model override needs a matching-dim build (registry dim is the single source — bump DB_VERSION when changing the shipped model)`));
                }
                // Device selection is per-DEVICE (platform.ts resolveDevice),
                // not a synced setting — see the NOTE in types.ts for why a
                // data.json toggle would leak across iCloud-synced devices.
                // 'auto' = WebGPU-then-WASM ladder; 'wasm' = skip WebGPU. The
                // allowlist: desktop + iPad get 'auto', iPhone + all Android get
                // 'wasm' (jetsam / immature WebView WebGPU), a per-device manual
                // override wins, and a sticky tripwire demotes any mobile device
                // that was OS-killed mid-WebGPU-reindex.
                //
                // On the 'auto' path the iframe's WebGPU attempt rewrites
                // wasmPaths to a webgpuInit-capable glue (jspi/asyncify — see
                // overrideWebkitGlueForWebgpu in iframe-runner.ts), the fix that
                // let the iPad run granite on WKWebView WebGPU (2026-06-10).
                // tx.js 4.2.0 otherwise pins anything Safari-detected (WKWebView
                // included) to the plain wasm glue compiled WITHOUT webgpuInit,
                // so without that override the webgpu EP init throws by
                // construction. On failure the load falls back to WASM on a
                // fresh module instance (tx.js's webInitChain has no rejection
                // handler — one failed load poisons the instance) and logs
                // webgpuError. ⚠️ ORT #26827 hang risk still applies on iPhone,
                // which is why iPhone stays off the 'auto' path by default.
                const requestedDevice = resolveDevice();
                // Model selection: the LOCAL_MODEL dev override wins (it's a
                // base URL, not a hub id); otherwise MODEL_ID. Both ride dtype
                // 'q4' — tx.js resolves it to onnx/model_q4.onnx (the ml97
                // repo's model_q4.onnx IS the GBQ-int4 export).
                // Bracket the load with beats: a death inside (the iPhone
                // wasm-OOM class, or a WebGPU device-init kill) gets attributed
                // to 'model-load' instead of reading as idle.
                this.forensics?.beat('model-load-start', { device: requestedDevice, model: spec.repo });
                const entry = await this.embedder.load(requestedDevice, LOCAL_MODEL.enabled ? LOCAL_MODEL.dtype : spec.dtype, localBase ?? spec.repo, LOCAL_MODEL.enabled ? null : spec.revision);
                this.forensics?.beat('model-load-done', { device: entry.actualDevice, dtype: entry.dtype, coldStartMs: Math.round(entry.coldStartMs) });
                // Stamp the backend this load actually resolved to (WebGPU can
                // fall back to WASM). Read at next boot by maybeDemoteOnCrash to
                // decide whether an indexing-crash implicates WebGPU.
                recordActiveBackend(entry.actualDevice);
                await this.logger.append(entry);
                await this.warnOnModelIndexDrift();
                // Production model delivery (remote/Cache-API path only — the
                // LOCAL_MODEL dev path loads from the vault, nothing CDN-cached):
                // (1) request Cache-API persistence (best-effort; Safari grants on
                // engagement heuristics) and (2) evict a PREVIOUS model's cached
                // bytes after a switch. Eviction is parent-side because our iframe
                // is non-sandboxed (shares the cache partition); benign if the cache
                // is absent. `cacheSeen===0` in the log is the canary that the
                // parent can't see the iframe cache (→ move eviction to an RPC).
                if (!LOCAL_MODEL.enabled) {
                    let persisted: boolean | null = null;
                    try { persisted = await navigator.storage.persist(); }
                    catch { /* private mode / unsupported */ }
                    let evicted = { seen: 0, deleted: 0 };
                    try {
                        if (typeof caches !== 'undefined') evicted = await evictStaleModelCaches(caches, spec.repo);
                    } catch (e) {
                        await this.logger.appendError('model-evict', e);
                    }
                    await this.logger.append({
                        type: 'model-delivery',
                        timestamp: new Date().toISOString(),
                        key: spec.key,
                        repo: spec.repo,
                        revision: spec.revision,
                        persisted,
                        cacheSeen: evicted.seen,
                        cacheEvicted: evicted.deleted,
                    });
                }
                // Eviction canary. The same 5 s threshold the LoadEntry's
                // checks array uses, but emitted as its own structured event
                // so the report (and future alerting) can count suspected
                // evictions without parsing free-text checklists.
                if (entry.coldStartMs >= 5000) {
                    await this.emitEvictionSuspected(entry);
                }
                // Success is signalled ambiently by the search modal's glyph
                // brightening from faint → full (PillQueryField.setModelReady),
                // not a toast — the bare device/dtype/timing line was noise on
                // every cold open. Warnings still get a toast: a degraded load
                // is worth interrupting for, and the glyph can't convey "why".
                if (!entry.pass) {
                    console.warn(`[seek] model loaded with warnings on ${entry.actualDevice} — see the logging report (Settings → Seek).`);
                }
            } catch (e) {
                this.modelLoadPromise = null; // allow retry
                await this.logger.appendError('ensureModelLoaded', e);
                throw e;
            } finally {
                this.popTaskContext('model-load');
            }
        })();
        return this.modelLoadPromise;
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    // Model ↔ index drift check, run after every successful model load. The
    // index meta carries the modelId that built it (stamped by reindexAll);
    // if the loaded model differs, dense scores would be cross-model garbage —
    // tell the user to full-reindex. Pre-2026-06-10 indexes have no stamp
    // (all english-r2 by construction), so an unstamped index always reads as
    // drift against ml97 and routes to a reindex. Once per session — the
    // condition can't self-heal without a reindex, so repeating the notice is
    // pure noise.
    private modelDriftWarned = false;




    // Generate the diagnostic report (full seek-report.json + a short seek-report.md
    // summary) and open the .md. The user-facing debug affordance, surfaced as a
    // Settings button now that the command-palette entry is gone. Errors tee to
    // console + NDJSON as usual.
    async openLoggingReport(): Promise<void> {
        try {
            const path = await this.logger.writeReport(this.settings.redactReport);
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
            new Notice(`Seek: report written — ${path} (summary) + seek-report.json (full data)`, 6000);
        } catch (e) {
            await this.logger.appendError('generate-log', e);
            new Notice('Seek: could not write the logging report — see the developer console.', 6000);
        }
    }

    private async warnOnModelIndexDrift(): Promise<void> {
        if (this.modelDriftWarned) return;
        try {
            const meta = await this.store.getMeta();
            if (meta.lastIndexedAt === null) return;   // empty index — first reindex will stamp it
            const indexModel = meta.modelId ?? LEGACY_ENGLISH_MODEL_ID;
            if (indexModel !== this.embedder.modelId) {
                this.modelDriftWarned = true;
                new Notice(
                    'Seek: the index was built with a different embedding model. ' +
                    'Open Settings → Seek → Index and choose Reindex — until then, incremental ' +
                    'indexing is paused and semantic ranking is unreliable.',
                    15000,
                );
                await this.logger.appendError('model-index-drift', new Error(
                    `index=${indexModel} loaded=${this.embedder.modelId}`));
            }
        } catch { /* meta unavailable (store closed mid-teardown) — next load rechecks */ }
    }

    // ---- Incremental indexing ----
    //
    // Keeps the index fresh without re-embedding the vault, on cheap triggers
    // that never fire mid-edit:
    //   - Leaving a note (active-leaf-change) enqueues it IF its mtime advanced
    //     (the mtime guard skips read-only visits); a 5-min idle timer then
    //     flushes. Edits are NOT watched per-keystroke — leaving the note is the
    //     debounce.
    //   - Backgrounding (visibilitychange:hidden / pagehide / window blur) flushes
    //     immediately — the last safe write window on iOS.
    //   - Deletes/renames/creates are discrete structural events with no blur
    //     equivalent, so we watch them directly; a rename is drop-old + index-new,
    //     which makes a move into an ignored folder a soft-delete.
    //   - EXTERNAL modifications (vault.on('modify'), issue #8) — Sync, iCloud, git,
    //     scripts, other plugins — enqueue on the same mtime guard and the same
    //     idle debounce. The note currently open is excluded: it fires modify on
    //     every autosave and is already owned by active-leaf-change + blur.
    //   - A BULK flush (> BULK_DELTA_THRESHOLD dirty files = a paste / vault sync /
    //     git checkout, not an edit) is a mini-reindex: progress shows on a Notice,
    //     a live query preempts the embed (shouldContinue), a cold DESKTOP model is
    //     deferred not force-loaded (like reconcileOnLoad), and the deferred/
    //     preempted remainder is reconciled by the drain. Small deltas stay a plain
    //     force-embed.
    // The catch-up drain (runCatchUp/drainCatchUp) reconciles deferred embeds —
    // cold-mobile, cold-desktop-bulk, or query-preempted — via a computeDelta diff.
    // It runs once a search SESSION ENDS (onSearchActivity, query settled / modal
    // closed, NOT per keystroke, so the foreground embed never competes with the
    // live query on the shared iOS process) AND is kicked immediately after a bulk
    // flush (a no-op when nothing's left). Startup reconciliation (reconcileOnLoad)
    // backstops anything missed while Seek wasn't running, and rearmCatchUpIfStranded
    // backstops a delta stranded mid-session (the flag cleared with work outstanding).
    //
    // Two properties make this safe to feed from an external event stream: the idle
    // debounce is CAPPED (nextFlushDelay — an uncapped reset never drains a trickling
    // sync), and every enqueue is mtime-guarded against the stored FileRecord, so an
    // iCloud mtime re-stamp with identical bytes costs one IDB read and stops there.
    private wireIncrementalIndexing(): void {
        this.lastActiveFile = this.app.workspace.getActiveFile();

        // Edits: index the note you LEAVE, not the one you arrive at.
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
            const left = this.lastActiveFile;
            this.lastActiveFile = this.app.workspace.getActiveFile();
            if (left) void this.enqueueIfDirty(left);
        }));

        // EXTERNAL edits (issue #8). active-leaf-change + blur cover the note the
        // user is editing, and nothing else: a change to a file they never open —
        // Obsidian Sync, iCloud, git pull, a script, the CLI, another plugin — was
        // invisible to the live index, and only reconcileOnLoad at the NEXT plugin
        // load ever picked it up. That is the "reindexes every launch" report: the
        // whole between-session change set arriving as one startup backlog.
        //
        // The watcher was reporting these all along (probed: fires ~15 ms after an
        // external write, for every file of a 25-file burst, while unfocused AND
        // while hidden; f.stat.mtime is already fresh in the handler). Seek simply
        // never subscribed. Routed to the SAME 5-min idle debounce as 'create' —
        // both need an embed, which is what separates them from the model-free
        // delete/rename fast path.
        this.registerEvent(this.app.vault.on('modify', (f) => {
            if (!(f instanceof TFile) || !isIndexableFile(f, this.settings.indexBases)) return;
            // Skip the note being edited right now: every editor autosave fires
            // modify, so enqueueing here would cost an IDB read per save and re-arm
            // the idle debounce mid-thought — exactly what "index the note you
            // LEAVE" exists to avoid. The active file is owned by
            // active-leaf-change and the blur handler, including when the change
            // came from outside; this only defers it to one of those, never drops it.
            if (f.path === this.app.workspace.getActiveFile()?.path) return;
            void this.enqueueIfDirty(f);
        }));

        // Structural events — discrete, rare, no blur equivalent.
        this.registerEvent(this.app.vault.on('create', (f) => {
            if (f instanceof TFile && isIndexableFile(f, this.settings.indexBases)) this.life.onCreate(f.path);
        }));
        this.registerEvent(this.app.vault.on('delete', (f) => {
            if (!(f instanceof TFile) || !isIndexableFile(f, this.settings.indexBases)) return;
            this.life.onDelete(f.path);
        }));
        this.registerEvent(this.app.vault.on('rename', (f, oldPath) => {
            // Drop the old path (covers plain rename, move, and move-into-ignored
            // = soft-delete) and index the new one. shouldIndex/reindexDelta decide
            // the archive/un-archive outcome by destination.
            this.life.onRename(oldPath, f instanceof TFile && isIndexableFile(f, this.settings.indexBases) ? f.path : null);
        }));

        // Window blur (desktop alt-tab) — same intent as visibilitychange:hidden.
        // registerDomEvent auto-tears-down on unload.
        this.registerDomEvent(window, 'blur', () => this.flushOnBackground());
    }




    // Backgrounding flush: capture the note currently being edited (it may never
    // have fired active-leaf-change) and drain immediately, before the OS can
    // reclaim the WebView.
    private flushOnBackground(): void {
        const active = this.app.workspace.getActiveFile();
        const flushed = active
            ? this.enqueueIfDirty(active).then(() => this.flushDirty())
            : this.flushDirty();
        // Mobile: once the last-safe-window flush settles, free the model before
        // iOS can jetsam-kill the backgrounded WebView. Chained AFTER the flush so
        // the unload predicate sees its settled state (not a half-armed queue);
        // any embeds the mobile flush deferred are re-found by computeDelta and
        // reloaded on the next foreground, so this never drops work.
        if (isMobilePlatform()) void flushed.then(() => this.maybeUnloadEmbedder('background')).catch(() => {});
    }






    // Open the Seek search modal, optionally seeded with a query (the `seek-search`
    // command passes none; the obsidian://seek deep-link passes the URL's query).
    // Decouples modal-open from model-load: the model can take 3–10 s cold-start
    // (7.6 s on iOS first-run, per the [[Seek Model Performance]] revision trail)
    // and the input field has no reason to wait — the orchestrator only needs the
    // model at query-execution time. We start the load eagerly (overlapping the
    // user's typing latency) and hand the in-flight promise to the modal, which
    // awaits it inside `runSearch`, not `onOpen`. The .catch is the unhandled-
    // rejection guard for when nothing in the modal ever awaits it (e.g. the user
    // closes the modal before typing); errors are already logged in ensureModelLoaded.
    // The version-stale banner spec for the search modal, or null when the index
    // identity matches this build (the common case). Platform-independent: the banner is
    // a signpost whose button opens Settings (the modal owns that), so the only policy
    // here is "is the index version-stale?". Re-evaluated by the modal on each open, so a
    // reindex done from Settings clears it the next time the modal opens.
    private indexNotice(): IndexBanner | null {
        return indexBannerSpec(this.life.indexHealth, this.life.degradedReason, this.life.peerSyncPending);
    }


    // ── Companion Seek Logger event relay ────────────────────────────────────
    // Re-broadcast settled searches and result-opens on Obsidian's workspace event
    // bus so a SEPARATELY-installed private "seek-logger" plugin can capture real
    // usage for offline eval harvesting. Generic + innocuous: with no companion
    // installed these are zero-listener no-ops, and Seek persists nothing new here
    // (it already logs the same query/click to its own NDJSON via `this.logger`).
    // Engine identity is attached here (not in the modal) so pluginIdentity() stays
    // in the plugin; the companion snapshots content-stable anchors itself at
    // receive time. A listener throw must never reach the search/open path.
    // Gated by the hidden searchEventRelay setting (OFF in the public build).
    private emitSeekSearch(entry: SearchEntry, shown: ScoredChunk[]): void {
        if (!this.settings.searchEventRelay) return;
        try {
            (this.app.workspace as unknown as { trigger(name: string, ...data: unknown[]): void }).trigger('seek:search', {
                v: 1,
                searchId: entry.searchId,
                timestamp: entry.timestamp,
                query: entry.query,
                cleanedQuery: entry.cleanedQuery,
                filters: entry.filters,
                topK: entry.topK,
                identity: {
                    ...pluginIdentity(),
                    pluginVersion: this.manifest.version,
                    alpha: entry.alpha,
                    recencyWeight: entry.recencyWeight,
                    recencyKey: entry.recencyKey,
                    bm25Coverage: entry.bm25Coverage,
                    prefixLastToken: entry.prefixLastToken,
                    synonymExpansion: entry.synonymExpansion,
                    searchableProperties: entry.searchableProperties,
                    headingsField: entry.headingsField,
                    bm25Bound: entry.bm25Bound,
                },
                // 50-deep shown list: rich rows the companion keeps for the top 10,
                // ids-only beyond. `rank` is the display rank (result index), not the
                // candidate-union rank fusedTop50 carries.
                shown: shown.map((r, i) => ({
                    rank: i + 1,
                    chunk_id: r.chunk_id,
                    note_path: r.note_path,
                    title: r.title,
                    score: r.score,
                    dense: r.ranking_signals.dense,
                    denseRaw: r.ranking_signals.denseRaw,
                    bm25: r.ranking_signals.bm25,
                    recency: r.ranking_signals.recency,
                    title_boost: r.ranking_signals.title_boost,
                    start_line: r.start_line,
                    heading_path: r.heading_path,
                    snippet: r.snippet,
                })),
            });
        } catch (e) {
            console.error('[seek] seek:search relay failed:', e);
        }
    }

    private emitSeekOpen(info: ResultOpenInfo): void {
        if (!this.settings.searchEventRelay) return;
        const { r, rank, titleNavOpen, newTab, openTarget, searchId, dwellMs } = info;
        try {
            (this.app.workspace as unknown as { trigger(name: string, ...data: unknown[]): void }).trigger('seek:result-open', {
                v: 1,
                searchId,
                timestamp: new Date().toISOString(),
                chunk_id: r.chunk_id,
                note_path: r.note_path,
                rank,
                score: r.score,
                dense: r.ranking_signals.dense,
                bm25: r.ranking_signals.bm25,
                recency: r.ranking_signals.recency,
                title_boost: r.ranking_signals.title_boost,
                titleNavOpen,
                dwellMs,
                newTab,
                openTarget,
                start_line: r.start_line,
                heading_path: r.heading_path,
            });
        } catch (e) {
            console.error('[seek] seek:result-open relay failed:', e);
        }
    }

    private openSearchModal(initialQuery = ''): void {
        this.pushTaskContext('search');
        try {
            const wasLoaded = this.embedder.loaded;
            const loadPromise = this.ensureModelLoaded();
            loadPromise.catch(() => { /* logged in ensureModelLoaded */ });
            new SeekSearchModal(
                this.app,
                this.orchestrator,
                this.logger,
                { ready: wasLoaded, promise: loadPromise },
                this.settings,
                (active) => this.onSearchActivity(active),
                (inFlight) => this.onQueryInFlight(inFlight),
                () => this.indexNotice(),
                initialQuery,
                this.recents,
                (entry, shown) => this.emitSeekSearch(entry, shown),
                (info) => this.emitSeekOpen(info),
            ).open();
        } catch (e) {
            // Synchronous failure path (rare — only if the Modal ctor or
            // ensureModelLoaded throws before returning a promise).
            this.logger.appendError('seek-search:open', e).catch(() => {});
            new Notice('Seek: search failed to open — see the developer console.');
        } finally {
            // Modal lifecycle isn't observable from here; pop after open().
            this.popTaskContext('search');
        }
    }

    // Headless deep-link target (obsidian://seek?query=…&mode=open): load the
    // model, run the query, and open the top hit's note directly — no modal.
    // Mirrors the seek:search CLI handler's model-gating (cold start blocks, so a
    // Notice stands in for the modal's progress UI). An empty query falls back to
    // the normal modal so a malformed link still does something useful.
    private async openTopResult(query: string): Promise<void> {
        if (!query.trim()) { this.openSearchModal(); return; }
        // Captured for the withQueryInFlight closure (null-check narrowing).
        const orchestrator = this.orchestrator;
        if (!orchestrator) { new Notice('Seek: still loading — try again in a moment'); return; }
        const notice = new Notice(`Seek: searching “${query}”…`, 0);
        this.pushTaskContext('search');
        try {
            // Under the query-in-flight gate, same as the seek:search CLI handler:
            // a running drain/flush yields at its next batch boundary.
            const { results } = await this.withQueryInFlight(async () => {
                // No modal to overlap the cold-start, so block on the model load
                // (3–10 s first call) before querying — same as the CLI handler.
                await this.ensureModelLoaded();
                // topK=1 — we only open the single best hit.
                return orchestrator.search(query, 1);
            });
            notice.hide();
            const top = results[0];
            if (!top) { new Notice(`Seek: no results for “${query}”`); return; }
            const file = this.app.vault.getAbstractFileByPath(top.note_path);
            if (!(file instanceof TFile)) { new Notice(`Seek: top result not on disk (${top.note_path})`); return; }
            await this.app.workspace.getLeaf(false).openFile(file);
        } catch (e) {
            notice.hide();
            this.logger.appendError('seek:protocol-open', e).catch(() => {});
            new Notice('Seek: could not open the result — see the developer console.');
        } finally {
            this.popTaskContext('search');
        }
    }








    // Full reindex: nuke the index and re-embed every markdown file. Shared by the
    // command palette and the settings "Full reindex" button (the degraded-health
    // recovery affordance). USER-INITIATED, so unlike the automatic drift-recovery
    // ladder it is allowed to embed — the embed-free guarantee covers only the auto path.
    // opts.skipConfirm: the caller already confirmed (the settings Index section has its
    // own inline two-button confirm, so it suppresses the blocking confirm dialog).
    // opts.onProgress: a second progress sink (besides the Notice) — the settings status
    // card subscribes to drive its live "N / TOTAL notes" bar. Arg-less callers (command
    // palette main.ts:496, degraded-health button) keep the confirm + Notice unchanged.
    // Returns whether a reindex actually RAN — false when refused (a build is already
    // running) or declined at the confirm, or if it threw. The identity heal uses this
    // to avoid falsely clearing its "needs heal" latch when its reindex didn't happen.
    async runFullReindex(opts?: { skipConfirm?: boolean; onProgress?: (msg: string) => void }): Promise<boolean> {
        return this.life.runFullReindex(opts);
    }

    // Index health snapshot for the settings Index status card. Read-only; gathers the
    // private store + logger so the settings tab needs no plugin internals. Counts come
    // from the index store, on-disk bytes from the Storage API (iOS-safe), the last-index
    // timestamp from index meta (persisted), and its duration from the newest index-complete
    // log entry (logged only). Each source is independently guarded so a single failure
    // degrades one field rather than blanking the whole card.
    async getIndexStats(): Promise<IndexStats> {
        let files = 0, chunks = 0;
        try { const c = await this.store.count(); files = c.files; chunks = c.chunks; } catch { /* index not open yet */ }
        let storageMB: number | null = null, indexMB: number | null = null, modelMB: number | null = null;
        if (navigator.storage?.estimate) {
            try {
                const est = await navigator.storage.estimate();
                storageMB = est.usage != null ? est.usage / 1e6 : null;
                // usageDetails is non-standard but present in Electron/Chromium: per-bucket
                // bytes ({ indexedDB, caches, ... }). Split the origin total into the index
                // (IndexedDB) vs the model cache (Cache API) so the card stops implying the
                // whole origin is the index.
                const details = (est as { usageDetails?: Record<string, number> }).usageDetails;
                if (details) {
                    if (typeof details.indexedDB === 'number') indexMB = details.indexedDB / 1e6;
                    if (typeof details.caches === 'number') modelMB = details.caches / 1e6;
                }
            } catch { /* unsupported */ }
        }
        // Last FULL reindex: newest index-complete entry with mode==='full'. Taking the
        // stamp AND the duration from that one entry keeps them coherent — a later
        // incremental catch-up (mode==='incremental') is skipped, so its tiny duration
        // never gets shown as if it were a full rebuild.
        let lastFullAt: string | null = null;
        let lastFullDurationMs: number | null = null;
        try {
            const entries = await this.logger.readAll();
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
            const meta = await this.store.getMeta();
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
    async getModelStatus(): Promise<ModelStatus> {
        const spec = activeModelSpec(this.settings);
        const name = spec.repo.includes('/') ? spec.repo.split('/')[1] : spec.repo;
        let downloaded = false, persisted: boolean | null = null;
        if (typeof caches !== 'undefined') {
            const st = await probeModelDownloaded(caches, spec);
            downloaded = st.downloaded; persisted = st.persisted;
        }
        if (!downloaded) {
            if (this.embedder.loaded) {
                downloaded = true;
            } else {
                try {
                    const entries = await this.logger.readAll();
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
    async deleteModel(): Promise<{ deleted: number }> {
        const spec = activeModelSpec(this.settings);
        let deleted = 0;
        try {
            if (typeof caches !== 'undefined') {
                deleted = (await deleteModelCaches(caches, spec.repo)).deleted;
            }
        } catch (e) {
            await this.logger.appendError('model-delete', e);
            throw e instanceof Error ? e : new Error(String(e));
        } finally {
            // Drop the runtime copy on ANY delete attempt — even a partial one. The iframe
            // holds the model in memory and getModelStatus() counts a loaded embedder as
            // "downloaded"; keeping it resident over a (possibly half-) deleted on-disk cache
            // would misreport state. teardown() also forces the next search to rebuild the
            // iframe and re-fetch cleanly — the intended consequence of a delete.
            this.embedder.teardown();
        }
        // Keep the log fallback honest: after a delete our cache holds 0 entries, so record
        // that — else the previous load's cacheSeen>0 would still read back as "downloaded".
        await this.logger.append({
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

    // ---- Global observers ----

    // Catch errors that escape the explicit try/catch sites. Without these,
    // async errors in event handlers / iframe message processing vanish.
    private wireGlobalErrorHandlers(): void {
        this.onError = (e: ErrorEvent) => {
            // Only log if the error originates from our code. The renderer
            // process gets a lot of unrelated cross-plugin noise, and we
            // don't want to claim other plugins' errors as ours.
            const src = (e.filename ?? '') + ' ' + (e.message ?? '');
            if (!/seek|transformers|webgpu/i.test(src)) return;
            this.logger.appendError('window.onerror', e.error ?? new Error(e.message)).catch(() => {});
        };
        this.onUnhandledRejection = (e: PromiseRejectionEvent) => {
            const reason = e.reason instanceof Error ? e.reason : new Error(String(e.reason));
            const stackStr = reason.stack ?? '';
            // Same filter as above. False negatives are fine; false positives
            // (logging other plugins' errors as Seek's) are worse.
            if (!/seek|transformers|webgpu/i.test(stackStr) && !/seek|transformers|webgpu/i.test(reason.message)) return;
            this.logger.appendError('unhandledrejection', reason).catch(() => {});
        };
        window.addEventListener('error', this.onError);
        window.addEventListener('unhandledrejection', this.onUnhandledRejection);
    }

    // PerformanceObserver for longtask entries. On iOS WKWebView this API
    // is supported as of iOS 16 — if absent, we silently skip (no harm).
    // Each longtask >= LONG_TASK_THRESHOLD_MS becomes a log entry tagged
    // with currentTaskContext so the report can group jank by what we
    // were doing at the time.
    private wireLongTaskObserver(): void {
        interface PolyfillObserver {
            new(cb: (list: { getEntries(): PerformanceEntry[] }) => void): PerformanceObserver;
        }
        const Ctor = (window as unknown as { PerformanceObserver?: PolyfillObserver }).PerformanceObserver;
        if (!Ctor) return;
        try {
            this.longTaskObserver = new Ctor(list => {
                for (const entry of list.getEntries()) {
                    if (entry.duration < LONG_TASK_THRESHOLD_MS) continue;
                    // `attribution[0].name` is spec'd to the constant 'unknown' —
                    // it was the only frame field we recorded, and it answered
                    // nothing (issue #5: a whole report of hourly 14 s stalls, every
                    // one reading 'unknown'). The useful pair is one level up:
                    // `entry.name` says WHICH FRAME ('self' vs a descendant iframe),
                    // and TaskAttributionTiming's container* fields name that frame.
                    const attrSrc = entry as unknown as {
                        attribution?: Array<{
                            name?: string; containerType?: string;
                            containerId?: string; containerName?: string; containerSrc?: string;
                        }>;
                    };
                    const attr = attrSrc.attribution?.[0];
                    const logEntry: LongTaskEntry = {
                        type: 'long-task',
                        timestamp: new Date().toISOString(),
                        durationMs: parseFloat(entry.duration.toFixed(2)),
                        startTimeMs: parseFloat(entry.startTime.toFixed(2)),
                        attribution: attr?.name ?? null,
                        culprit: entry.name || null,
                        containerType: attr?.containerType || null,
                        containerId: attr?.containerId || null,
                        containerName: attr?.containerName || null,
                        // Cap: an iframe src can be a multi-KB data: URL, and this
                        // row is written on every stall. The prefix is enough to
                        // identify the frame. Redacted like any other string when
                        // the report's privacy toggle is on — a vault-local
                        // app://local/… src carries the vault path.
                        containerSrc: attr?.containerSrc?.slice(0, 120) || null,
                        // Attribute by span overlap at TASK time, not delivery
                        // time — the observer fires only after the task ends,
                        // so a top-of-stack read here mislabels every task
                        // whose phase popped before delivery (issue #5).
                        context: this.taskCtx.attribute(entry.startTime, entry.duration),
                    };
                    this.logger.append(logEntry).catch(() => {});
                }
            });
            this.longTaskObserver.observe({ entryTypes: ['longtask'] });
        } catch (e) {
            // entryType 'longtask' isn't supported everywhere — Safari pre-16.
            // Silently skip; the report will just have an empty long-task section.
            console.warn('[seek] longtask observer unavailable:', e);
        }
    }

    // visibilitychange + pagehide. On iOS, the WebView can be jetsam-killed
    // while backgrounded — recording state at the moment we lose foreground
    // lets us correlate "session ended abruptly" with "heap was at 240 MB".
    private wireMemoryPressureHandlers(): void {
        const emit = async (event: MemoryPressureEntry['event']) => {
            const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
            const heapMB = heap ? heap.usedJSHeapSize / 1e6 : null;
            let storageMB: number | null = null;
            let persisted = false;
            if (navigator.storage?.estimate) {
                try {
                    const est = await navigator.storage.estimate();
                    storageMB = est.usage != null ? est.usage / 1e6 : null;
                } catch { /* swallow */ }
            }
            if (navigator.storage?.persisted) {
                try { persisted = await navigator.storage.persisted(); } catch { /* swallow */ }
            }
            const entry: MemoryPressureEntry = {
                type: 'memory-pressure',
                timestamp: new Date().toISOString(),
                event,
                heapMB,
                storageMB,
                persisted,
            };
            await this.logger.append(entry);
        };
        this.onVisibilityChange = () => {
            if (this.visibilityDoc?.visibilityState === 'hidden') {
                // Forensics beat FIRST and synchronously — the async emit below
                // can be lost to a background kill; the breadcrumb can't.
                this.forensics?.beat('visibility-hidden');
                emit('visibility-hidden').catch(() => {});
                // Backgrounding is the last safe write window on iOS (the WebView
                // can be jetsam-killed). Capture the note being edited and flush
                // now, bypassing the 5-min idle debounce.
                this.flushOnBackground();
            }
            else if (this.visibilityDoc?.visibilityState === 'visible') {
                this.forensics?.beat('visibility-visible');
                emit('visibility-visible').catch(() => {});
            }
        };
        this.onPageHide = () => {
            this.forensics?.beat('pagehide');
            emit('pagehide').catch(() => {});
            this.flushOnBackground();
        };
        // Bind to the active document and remember it, so unload removes against the
        // SAME document (see visibilityDoc field).
        this.visibilityDoc = activeDocument;
        this.visibilityDoc.addEventListener('visibilitychange', this.onVisibilityChange);
        window.addEventListener('pagehide', this.onPageHide);
    }

    // Emits an eviction-suspected event when cold-start exceeded the
    // 5 s mobile budget. Captures the storage state at the same instant
    // so a low storageUsedMB confirms the cache was actually emptied
    // (vs. a thermal-throttle false positive). Best-effort; never throws.
    private async emitEvictionSuspected(load: import('./types').LoadEntry): Promise<void> {
        let storageUsedMB: number | null = null;
        let storageQuotaMB: number | null = null;
        let persisted: boolean | null = null;
        if (navigator.storage?.estimate) {
            try {
                const est = await navigator.storage.estimate();
                storageUsedMB = est.usage != null ? est.usage / 1e6 : null;
                storageQuotaMB = est.quota != null ? est.quota / 1e6 : null;
            } catch { /* swallow */ }
        }
        if (navigator.storage?.persisted) {
            try { persisted = await navigator.storage.persisted(); } catch { /* swallow */ }
        }
        const entry: EvictionSuspectedEntry = {
            type: 'eviction-suspected',
            timestamp: new Date().toISOString(),
            coldStartMs: load.coldStartMs,
            actualDevice: load.actualDevice,
            dtype: load.dtype,
            storageUsedMB,
            storageQuotaMB,
            persisted,
        };
        await this.logger.append(entry);
    }

    // One-shot `app://local/...` capability probe. Writes a tiny file to the
    // vault, asks the iframe to fetch it via adapter.getResourcePath(), and
    // logs the result. Gates the Phase 3 model-shard streaming pattern: a
    // green probe means we can stream shards through the iframe via a
    // resource URL; a red probe means Phase 3 has to transfer bytes via
    // postMessage. See seek-dataadapter-rearchitecture-plan §Phase 1.
    private async runAppLocalProbe(): Promise<void> {
        const adapter = this.app.vault.adapter;
        // Site the probe inside the plugin's OWN folder (always present, hidden
        // under the config dir) — NOT a visible vault folder. The earlier
        // 'Documents/seek/' literal did adapter.mkdir() and left a stray, visible
        // Documents/ folder in the vault root on every load; manifest.dir is where
        // the running plugin already lives, so there's no mkdir and nothing
        // user-visible. getResourcePath resolves it identically — the capability
        // under test (iframe fetch of an app://local / capacitor:// resource URL)
        // is unchanged.
        const dir = this.manifest.dir;
        if (!dir) return; // no plugin dir → can't site the probe; skip the diagnostic
        const PROBE_PATH = `${dir}/.seek-applocal-probe`;
        const PROBE_BODY = 'seek-probe-v1';

        let url = '';
        try {
            await adapter.write(PROBE_PATH, PROBE_BODY);
            // Obsidian's adapter exposes getResourcePath on both desktop
            // (returns `app://local/...`) and Capacitor mobile (returns
            // `capacitor://localhost/...`). Either is the platform-correct
            // URL the iframe would need to use in Phase 3.
            const ra = adapter as unknown as { getResourcePath?: (p: string) => string };
            url = ra.getResourcePath ? ra.getResourcePath(PROBE_PATH) : '';
        } catch (e) {
            const entry: AppLocalFetchEntry = {
                type: 'app-local-fetch',
                timestamp: new Date().toISOString(),
                result: 'unknown',
                url,
                httpStatus: null,
                bodyMatched: null,
                error: `probe setup failed: ${e}`,
            };
            await this.logger.append(entry);
            return;
        }

        if (!url) {
            const entry: AppLocalFetchEntry = {
                type: 'app-local-fetch',
                timestamp: new Date().toISOString(),
                result: 'unknown',
                url: '',
                httpStatus: null,
                bodyMatched: null,
                error: 'adapter.getResourcePath unavailable',
            };
            await this.logger.append(entry);
            return;
        }

        const fr = await this.embedder.appLocalFetch(url);
        const bodyMatched = fr.body == null ? null : fr.body === PROBE_BODY;
        const entry: AppLocalFetchEntry = {
            type: 'app-local-fetch',
            timestamp: new Date().toISOString(),
            result: fr.ok && bodyMatched === true ? 'ok' : 'blocked',
            url,
            httpStatus: fr.status,
            bodyMatched,
            error: fr.error,
        };
        await this.logger.append(entry);
    }

    // Lightweight storage snapshot. Used after reindex; could be invoked
    // periodically in v1. Keeps the cost low compared to the full platform probe.
    private async emitStorageSnapshot(context: string): Promise<void> {
        let storageUsedMB: number | null = null;
        let storageQuotaMB: number | null = null;
        if (navigator.storage?.estimate) {
            try {
                const est = await navigator.storage.estimate();
                storageUsedMB = est.usage != null ? est.usage / 1e6 : null;
                storageQuotaMB = est.quota != null ? est.quota / 1e6 : null;
            } catch { /* swallow */ }
        }
        const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        const heapMB = heap ? heap.usedJSHeapSize / 1e6 : null;
        const entry: StorageSnapshotEntry = {
            type: 'storage-snapshot',
            timestamp: new Date().toISOString(),
            context,
            storageUsedMB,
            storageQuotaMB,
            heapMB,
        };
        await this.logger.append(entry);
    }
}

// Minimal confirm dialog. Replaces the native window.confirm(), which is
// unreliable on mobile (the WebView can suppress it). Resolves true when the
// user confirms, false on Cancel or any dismissal (Esc / click-outside).
class ConfirmModal extends Modal {
    private settled = false;
    private resolve: ((value: boolean) => void) | null = null;

    constructor(app: App, private readonly message: string) {
        super(app);
    }

    openAndConfirm(): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }

    onOpen(): void {
        for (const line of this.message.split('\n')) {
            this.contentEl.createEl('p', { text: line });
        }
        const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
        const proceed = buttons.createEl('button', { text: 'Proceed', cls: 'mod-cta' });
        proceed.addEventListener('click', () => this.settle(true));
        const cancel = buttons.createEl('button', { text: 'Cancel' });
        cancel.addEventListener('click', () => this.settle(false));
    }

    onClose(): void {
        // Dismissed without a button (Esc / click-outside) → treat as Cancel.
        this.settle(false);
    }

    private settle(value: boolean): void {
        if (this.settled) return;
        this.settled = true;
        this.resolve?.(value);
        this.close();
    }
}

