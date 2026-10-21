// fork 1.1.3 new; relates to src/embedder.ts:155 LocalEmbedder
// The bot's answer to core's `embedder` port (EmbedCommitCtx / ReindexDeltaCtx): LocalEmbedder's index-path
// surface, backed by the Chromium sidecar instead of an Obsidian iframe. The sidecar loads the model on first use.
import { SEEK_MODEL } from './seek-compatibility.ts';

export interface BatchSidecar {
  // Query path; the sidecar's single-text embed. Absent in fakes, so BotEmbedder falls back to a batch of one.
  embed?(text: string): Promise<Float32Array>;
  embedBatch(texts: string[], bucket?: number): Promise<{ vectors: Float32Array[]; latencyMs: number }>;
  tokenCounts(texts: string[]): Promise<number[]>;
  loadTokenizer(): Promise<void>;
  close(): Promise<void>;
}

export class BotEmbedder {
  readonly device = 'wasm';
  readonly glue: string | null = null;
  readonly dtype = SEEK_MODEL.dtype;
  readonly modelId = SEEK_MODEL.repo;
  private sidecar: BatchSidecar;

  constructor(sidecar: BatchSidecar) { this.sidecar = sidecar; }

  // Lazy-loading, so "loaded" never gates the bot the way a cold phone model gates the plugin.
  get loaded(): boolean { return true; }

  // fork 1.1.3 src/embedder.ts:515 LocalEmbedder.embedBatch
  async embedBatch(texts: string[], bucket?: number): Promise<{ vectors: Float32Array[]; iframeLatencyMs: number }> {
    const r = await this.sidecar.embedBatch(texts, bucket);
    return { vectors: r.vectors, iframeLatencyMs: r.latencyMs };
  }

  // fork 1.1.3 src/embedder.ts:410 LocalEmbedder.embed
  async embed(text: string): Promise<{ vector: Float32Array; iframeLatencyMs: number }> {
    const t = performance.now();
    const vector = this.sidecar.embed ? await this.sidecar.embed(text) : (await this.sidecar.embedBatch([text])).vectors[0];
    return { vector, iframeLatencyMs: performance.now() - t };
  }

  // fork 1.1.3 src/embedder.ts:525 LocalEmbedder.tokenCounts
  tokenCounts(texts: string[]): Promise<number[]> { return this.sidecar.tokenCounts(texts); }

  // fork 1.1.3 src/embedder.ts:536 LocalEmbedder.ensureTokenizer
  ensureTokenizer(): Promise<void> { return this.sidecar.loadTokenizer(); }

  // Core calls this after a runtime overflow; the sidecar restarts itself on the next call.
  // fork 1.1.3 src/embedder.ts:458 LocalEmbedder.recycle
  recycle(): Promise<void> { return this.sidecar.close(); }
}
