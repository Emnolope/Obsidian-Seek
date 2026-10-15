// The numbers both sides must agree on. Change one here and every consumer (plugin
// sidecar, MCP loader, query embedder) moves together; contract.test.ts pins the
// model registry and the MCP's model constants to these.

export const EMBEDDING_DIM = 384;

// Bumped when the on-disk record/meta layout changes (forces a version-gate refusal).
// 1→2: per-record CRC-32 widened the record 436→440 B. 2→3: dequant scale f32→f64
// (440→444 B) so a hydrated peer's scale is bit-identical to IndexedDB's. Older
// sidecars are refused by metaAccepts and re-hydrated on the next full reindex.
export const SIDECAR_FORMAT = 3;

export const EXPORT_SCHEMA_VERSION = 1;

// Indexes written before the modelId stamp existed were english-r2 by construction; drift checks use this to flag them as foreign.
export const LEGACY_ENGLISH_MODEL_ID = 'onnx-community/granite-embedding-small-english-r2-ONNX';
