// Sandboxed iframe that owns the transformers.js pipeline.
//
// Why an iframe at all? Obsidian's renderer applies a strict CSP that blocks
// `import()` of remote ES modules — but iframes with srcdoc inherit a more
// permissive CSP and can dynamically import from jsdelivr. The iframe also
// quarantines the ~250 MB model heap; on plugin teardown we just unmount
// the DOM node and the runtime reclaims everything.
//
// Lifted from the embeddinggemmaiostest spike with one adjustment for v0:
//   - Model id is the onnx-community fused PTQ export, run at q4 (see
//     embedder.ts header — the QAT workstream is killed).


import type { Device, RequestedDevice, Dtype } from './types';
import { ACTIVE_MODEL_SPEC } from './model-registry';
import type { IframeInit, LoadResult, IframeEvent, EmbedResult, RawProfile, AppLocalFetchResult } from '../core/child-script';
import { CDN_URL, IFRAME_ID, READY_TIMEOUT_MS, RPC_TIMEOUT_MS, LOAD_RPC_TIMEOUT_MS, TRANSFORMERS_VERSION, WARMUP_BATCH_SIZES, SEQ_BUCKETS, QUERY_SEQ_BUCKETS, selectBucket, selectIndexBucket, selectQueryBucket, buildChildScript } from '../core/child-script';
export * from '../core/child-script';

declare const __BUILD_TS__: string;


interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    // Per-RPC timeout handle, cleared when the reply lands (or on dispose).
    // number is window.setTimeout's DOM return (clearTimeout takes it).
    timer?: number;
}

// Shape of an iframe→parent postMessage payload: RPC replies plus the bootstrap
// control messages (__ready / __error / __event). event.data is structurally
// untyped (any), so we narrow it to this before reading fields.
interface IframeMsg {
    id: string;
    ok?: boolean;
    result?: unknown;
    error?: string;
    event?: IframeEvent;
}

export class IframeRunner {
    private iframe: HTMLIFrameElement | null = null;
    private pending = new Map<string, Pending>();
    private listener: ((e: MessageEvent) => void) | null = null;
    // Receiver for unsolicited '__event' pushes (WebGPU device lifecycle).
    // Survives recycle (same runner instance rebuilds the iframe); the
    // embedder re-wires it across teardown() which swaps the runner.
    onEvent: ((event: IframeEvent) => void) | null = null;

    async init(): Promise<IframeInit> {
        const result: IframeInit = {
            buildTimestamp: __BUILD_TS__,
            cdnUrl: CDN_URL,
            transformersVersion: TRANSFORMERS_VERSION,
            ready: false,
            error: null,
            initMs: 0,
        };
        // Idempotency guard for SEQUENTIAL re-entry (recycle/teardown-then-init,
        // the Unload command). buildIframe() does an unconditional
        // document.createElement(iframe) — calling init() twice on a live runner
        // would append a second #seek-runtime-iframe and leak the first listener.
        // contentWindow is non-null only after the srcdoc document attaches, so an
        // in-progress build still reads as "not live" here; CONCURRENT callers are
        // serialized one layer up by LocalEmbedder's memoized _initPromise.
        if (this.iframe?.contentWindow) {
            result.ready = true;
            return result;
        }
        const t0 = performance.now();
        try {
            await this.buildIframe();
            result.ready = true;
        } catch (e) {
            result.error = String(e);
            // A failed bootstrap (__error or the ready-timeout) still leaves the
            // iframe ELEMENT attached with a live contentWindow — buildIframe()
            // doesn't unwind. Left as-is, the idempotency guard above (and send()'s
            // 'iframe not initialized' check) would read that dead iframe as usable,
            // so a retry would short-circuit to a false-ready and load() would hang
            // posting to an iframe that never answers. dispose() unwinds to a clean
            // no-iframe state (also removing the leaked message listener) so the next
            // init() genuinely rebuilds.
            this.dispose();
        }
        result.initMs = parseFloat((performance.now() - t0).toFixed(2));
        return result;
    }

    private buildIframe(): Promise<void> {
        return new Promise((resolve, reject) => {
            const timeout = window.setTimeout(
                () => reject(new Error(`iframe ready timeout after ${READY_TIMEOUT_MS}ms`)),
                READY_TIMEOUT_MS,
            );

            this.listener = (event: MessageEvent) => {
                if (!this.iframe || event.source !== this.iframe.contentWindow) return;
                const data = event.data as IframeMsg | undefined;
                if (!data || typeof data !== 'object') return;

                if (data.id === '__ready') { window.clearTimeout(timeout); resolve(); return; }
                if (data.id === '__error') {
                    window.clearTimeout(timeout);
                    reject(new Error(`iframe bootstrap failed: ${data.error}`));
                    return;
                }
                if (data.id === '__event') {
                    // Unsolicited push, not an RPC reply. Handler errors must
                    // never poison the RPC dispatch below it.
                    try { this.onEvent?.(data.event as IframeEvent); } catch { /* swallow */ }
                    return;
                }
                const p = this.pending.get(data.id);
                if (!p) return;
                this.pending.delete(data.id);
                if (p.timer) window.clearTimeout(p.timer);
                if (data.ok) p.resolve(data.result);
                else p.reject(new Error(data.error ?? 'iframe error'));
            };
            window.addEventListener('message', this.listener);

            // Anchor the hidden compute iframe to `window.document` (the main
            // window's document), NOT activeDocument: it is display:none (no
            // popout-render benefit), must outlive any popout (anchoring it to the
            // window focused at first embed would orphan it when that popout
            // closes), and its contentWindow postMessage must reach the `window`
            // message listener bound above.
            this.iframe = window.document.createElement('iframe');
            this.iframe.id = IFRAME_ID;
            this.iframe.addClass('seek-hidden');
            // LOAD-BEARING: no `sandbox` attribute. A srcdoc iframe with no sandbox
            // inherits Obsidian's real origin (`capacitor://localhost` on iOS,
            // `app://obsidian.md` on desktop). That real origin is what lets the
            // child's transformers.js fetch() pull the model from the HF CDN —
            // HF returns `access-control-allow-origin: *`, so the cross-origin
            // request passes — and share the parent's Cache-API partition (so the
            // parent-side eviction in model-registry.ts can see the cache). Adding
            // a `sandbox` attribute would give the iframe an opaque `null` origin
            // and break BOTH on iOS. Do not add one without first moving the model
            // fetch out of the iframe (e.g. parent requestUrl → resource URL).
            window.document.body.appendChild(this.iframe);

            const childScript = buildChildScript(CDN_URL, ACTIVE_MODEL_SPEC.dim);
            this.iframe.srcdoc =
                `<!DOCTYPE html><html><body><script type="module">${childScript}</script></body></html>`;
        });
    }

    private send<T>(type: string, payload: unknown, timeoutMs: number = RPC_TIMEOUT_MS): Promise<T> {
        if (!this.iframe?.contentWindow) {
            return Promise.reject(new Error('iframe not initialized'));
        }
        const id = (crypto as { randomUUID?: () => string }).randomUUID
            ? (crypto as { randomUUID: () => string }).randomUUID()
            : `id-${Date.now()}-${Math.random()}`;
        return new Promise<T>((resolve, reject) => {
            // Backstop a dead/silent child (jetsam kill, WebGPU device loss): if
            // no reply lands in time, reject with a RECOVERABLE 'TIMEOUT' so the
            // embed catch recycles+retries instead of hanging. Cleared in the
            // message listener the instant the real reply arrives.
            const timer = window.setTimeout(() => {
                if (!this.pending.delete(id)) return;
                reject(Object.assign(
                    new Error(`iframe RPC '${type}' timed out after ${timeoutMs}ms`),
                    { code: 'TIMEOUT' },
                ));
            }, timeoutMs);
            this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
            this.iframe!.contentWindow!.postMessage({ id, type, payload }, '*');
        });
    }

    // skipWarmup: parent decision based on the localStorage fingerprint cache
    // (see embedder.ts). If true AND the WebGPU path succeeds, the iframe
    // bypasses the 40-dispatch shader-compile loop entirely. Always pay the
    // warmup on the WASM path or on a fingerprint miss.
    load(modelId: string, device: RequestedDevice, dtype: Dtype, skipWarmup: boolean, revision?: string | null): Promise<LoadResult> {
        return this.send<LoadResult>('load', { modelId, device, dtype, skipWarmup, revision: revision ?? null }, LOAD_RPC_TIMEOUT_MS);
    }

    embed(text: string): Promise<EmbedResult> {
        return this.send<EmbedResult>('embed', { text });
    }

    // bucket: the seq-ladder rung this batch was routed into by the parent's
    // token-exact selectIndexBucket. The iframe uses it verbatim as max_length,
    // so parent routing and iframe padding agree by construction (no second
    // char-estimate derivation). Omitting it falls back to the legacy char
    // estimate inside the iframe — kept only for back-compat callers.
    embedBatch(texts: string[], bucket?: number): Promise<{ vectors: Float32Array[]; latencyMs: number }> {
        return this.send<{ vectors: Float32Array[]; latencyMs: number }>('embed-batch', { texts, bucket });
    }

    // Exact token counts (specials included — the same count the forward pass
    // sees) for each text, from the iframe pipeline's own tokenizer. Tokenizer
    // only, no model forward: cheap (~µs-ms per text) and device-independent.
    // The single source of tokenizer truth stays inside the iframe; the parent
    // never re-implements or approximates it.
    tokenCounts(texts: string[]): Promise<number[]> {
        return this.send<number[]>('token-counts', { texts });
    }

    // Load ONLY the tokenizer (vocab/merges JSON, a few MB) — no ONNX model
    // weights. Lets the sidecar hydrate reproduce the token-budget chunk splits
    // (and therefore exact chunk_ids) without the ~250 MB model load it exists
    // to avoid on mobile. Idempotent in the child; tokenCounts() then works
    // against either the full pipeline or this standalone tokenizer.
    loadTokenizer(modelId: string, revision?: string | null): Promise<{ ok: boolean; cached: boolean }> {
        return this.send<{ ok: boolean; cached: boolean }>('load-tokenizer', { modelId, revision: revision ?? null }, LOAD_RPC_TIMEOUT_MS);
    }

    // Diagnostic only. Runs the UNROLLED tokenizer→model→readback path with
    // timing boundaries across a (batchSize × seqBucket) matrix so we can see
    // where wall time actually goes on the v4 runtime. Never used in the
    // production embed path — that stays the opaque pipeline() call for
    // correctness; this is the measurement twin.
    profile(batchSizes: number[], seqBuckets: number[], reps: number): Promise<RawProfile> {
        // Diagnostic only; a full (batch × seq) matrix can run minutes — give it
        // a generous ceiling so the per-RPC timeout never trips a real profile.
        return this.send<RawProfile>('embed-profile', { batchSizes, seqBuckets, reps }, 600_000);
    }

    // Probe whether the iframe (srcdoc + sandboxed) can fetch a vault
    // resource via Obsidian's runtime URL scheme. Gates the Phase 3 shard
    // streaming pattern; see seek-dataadapter-rearchitecture-plan §Phase 1.
    appLocalFetch(url: string): Promise<AppLocalFetchResult> {
        return this.send<AppLocalFetchResult>('app-local-fetch', { url });
    }

    dispose(): void {
        if (this.listener) {
            window.removeEventListener('message', this.listener);
            this.listener = null;
        }
        if (this.iframe?.parentNode) this.iframe.parentNode.removeChild(this.iframe);
        this.iframe = null;
        // Tag the rejection 'DISPOSED' so the embed catch can distinguish an
        // intentional teardown (plugin unloading → must NOT recycle, or it
        // resurrects a zombie iframe + reloads ~250 MB into a dead plugin) from
        // a recoverable error (SafeInt overflow / TIMEOUT → recycle+retry).
        // Clear each pending timer first so a timeout can't fire post-rejection.
        for (const [, p] of this.pending) {
            if (p.timer) window.clearTimeout(p.timer);
            p.reject(Object.assign(new Error('iframe disposed'), { code: 'DISPOSED' }));
        }
        this.pending.clear();
    }

    // Reject every in-flight RPC with a RECOVERABLE error (NOT 'DISPOSED'),
    // leaving the iframe attached. Used on WebGPU device-lost: the device is
    // dead, so a hung embedBatch must reject to let the caller's recycle+retry
    // fire — but this is recovery, not teardown, so the embed catch must not see
    // 'DISPOSED' (which would unwind the reindex). The caller's recycle() then
    // replaces the now-dead-device iframe.
    failInflight(message: string): void {
        for (const [, p] of this.pending) {
            if (p.timer) window.clearTimeout(p.timer);
            p.reject(new Error(message));
        }
        this.pending.clear();
    }
}
