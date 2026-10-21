// fork 1.1.3 new; relates to src/iframe-runner.ts:840 (pooling/normalize/max_length as the iframe passes them) and src/platform.ts:92 resolveDevice
// Compact compatibility contract extracted from Seek's model-registry.ts,
// embedder.ts, and iframe-runner.ts. Keep this file easy to compare against
// those upstream blocks; MCP transport belongs elsewhere.

import { ACTIVE_MODEL_SPEC } from '../../core/model-registry.ts';

export const SEEK_MODEL = {
  repo: ACTIVE_MODEL_SPEC.repo,
  revision: ACTIVE_MODEL_SPEC.revision,
  dimension: ACTIVE_MODEL_SPEC.dim,
  dtype: ACTIVE_MODEL_SPEC.dtype,
  pooling: 'cls' as const,
  normalize: true,
  maxLength: 128,
};

export type SeekDevice = 'auto' | 'wasm' | 'webgpu';

export function requestedDevice(): SeekDevice {
  const value = process.env.SEEK_MCP_DEVICE;
  if (value === 'auto' || value === 'wasm' || value === 'webgpu') return value;
  return 'wasm';
}

export function hasWebGpu(): boolean {
  const navigatorValue = (globalThis as { navigator?: { gpu?: unknown } }).navigator;
  return !!navigatorValue?.gpu;
}

export function selectDevice(): SeekDevice {
  return requestedDevice();
}

export function prepareVector(data: ArrayLike<number>, outputDim = SEEK_MODEL.dimension): Float32Array {
  if (data.length < outputDim) throw new Error(`embed: model output dim ${data.length} < ${outputDim}`);
  const vector = Float32Array.from(Array.from(data).slice(0, outputDim));
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (data.length > outputDim && norm > 0) {
    for (let index = 0; index < vector.length; index++) vector[index] /= norm;
  }
  if (!vector.every(Number.isFinite)) throw new Error('embed: model returned a non-finite vector');
  return vector;
}