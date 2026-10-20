// fork 1.1.3 new; relates to src/embedder.ts:157 LocalEmbedder
// The bot's answer to core's `embedder` port (EmbedCommitCtx / ReindexDeltaCtx): LocalEmbedder's index-path
// surface, backed by the Chromium sidecar instead of an Obsidian iframe. The sidecar loads the model on first use.
import { SEEK_MODEL } from './seek-compatibility.ts';

export interface BatchSidecar {
  embedBatch(texts: string[], bucket?: number): Promise<{ vectors: Float32Array[]; latencyMs: number }>;
  tokenCounts(texts: string[]): Promise<number[]>;
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

  // fork 1.1.3 src/embedder.ts:516 LocalEmbedder.embedBatch
  async embedBatch(texts: string[], bucket?: number): Promise<{ vectors: Float32Array[]; iframeLatencyMs: number }> {
    const r = await this.sidecar.embedBatch(texts, bucket);
    return { vectors: r.vectors, iframeLatencyMs: r.latencyMs };
  }

  // fork 1.1.3 src/embedder.ts:526 LocalEmbedder.tokenCounts
  tokenCounts(texts: string[]): Promise<number[]> { return this.sidecar.tokenCounts(texts); }

  // Core calls this after a runtime overflow; the sidecar restarts itself on the next call.
  // fork 1.1.3 src/embedder.ts:459 LocalEmbedder.recycle
  recycle(): Promise<void> { return this.sidecar.close(); }
}
