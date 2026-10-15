export interface SeekTransformersEnvironment {
  backends: {
    onnx?: {
      wasm?: {
        wasmPaths?: { mjs?: string; wasm?: string };
      };
    };
  };
}

export interface SeekTransformersOutput {
  data: ArrayLike<number>;
  dims: number[];
  dispose?: () => void;
}

export type SeekFeatureExtractor = (
  text: string,
  options: Record<string, unknown>,
) => Promise<SeekTransformersOutput>;

export function pipeline(
  task: string,
  model: string,
  options: Record<string, unknown>,
): Promise<SeekFeatureExtractor>;

export const env: SeekTransformersEnvironment;