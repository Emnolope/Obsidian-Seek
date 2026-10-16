// The numbers both sides must agree on. Change one here and every consumer (plugin
// sidecar, MCP loader, query embedder) moves together; contract.test.ts pins the
// model registry and the MCP's model constants to these.

// fork 1.1.3 src/embedder.ts:153 EMBEDDING_DIM
export const EMBEDDING_DIM = 384;

// fork 1.1.3 src/sidecar.ts:65 SIDECAR_FORMAT
// Bumped when the on-disk record/meta layout changes (forces a version-gate refusal).
// 1→2: per-record CRC-32 widened the record 436→440 B. 2→3: dequant scale f32→f64
// (440→444 B) so a hydrated peer's scale is bit-identical to IndexedDB's. Older
// sidecars are refused by metaAccepts and re-hydrated on the next full reindex.
export const SIDECAR_FORMAT = 3;

// 1→2: documents carry the full ChunkMeta so the MCP side can run the same filters/ranking as the plugin.
export const EXPORT_SCHEMA_VERSION = 2;

// fork 1.1.3 src/embedder.ts:116 LEGACY_ENGLISH_MODEL_ID
// Indexes written before the modelId stamp existed were english-r2 by construction; drift checks use this to flag them as foreign.
export const LEGACY_ENGLISH_MODEL_ID = 'onnx-community/granite-embedding-small-english-r2-ONNX';
