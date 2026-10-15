#!/data/data/com.termux/files/usr/bin/bash
set -u

SCRIPT_PATH="$0"
if [ "${SCRIPT_PATH#/}" = "$SCRIPT_PATH" ]; then
  SCRIPT_PATH="$PWD/$SCRIPT_PATH"
fi
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd)"
if [ -f "$SCRIPT_DIR/package.json" ] && [ -d "$SCRIPT_DIR/src" ]; then
  ROOT="$SCRIPT_DIR"
elif [ -f "$SCRIPT_DIR/../package.json" ] && [ -d "$SCRIPT_DIR/../src" ]; then
  ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
elif [ -f "$SCRIPT_DIR/../../package.json" ] && [ -d "$SCRIPT_DIR/../../src" ]; then
  ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
else
  ROOT="$(CDPATH= cd -- "$PWD" && pwd)"
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${SEEK_PROBE_OUT:-$ROOT/test-4-$STAMP.log}"
mkdir -p "$(dirname -- "$OUT")"
exec > >(tee "$OUT") 2>&1

echo "=== test-4: corrected ONNX Web/WASM salvage ==="
echo "timestamp: $(date -Is 2>/dev/null || date)"
echo "repo: $ROOT"
echo "output: $OUT"
echo

run() {
  echo
  echo "+ $*"
  "$@"
  echo "exit: $?"
}

if [ ! -f "$ROOT/package.json" ] || [ ! -d "$ROOT/src" ]; then
  echo "Run this from the Obsidian-Seek-MCP repo or place it in its scripts directory."
  echo "Expected repo root: $ROOT"
  exit 1
fi
cd "$ROOT" || exit 1

WEB_VERSION="1.26.0-dev.20260416-b7804b056c"
COMMON_VERSION="1.24.0-dev.20251116-b39e144322"

echo "--- phone and runtime ---"
run uname -a
run getprop ro.product.cpu.abi 2>/dev/null || true
run node --version
run npm --version
run nproc
run node --experimental-strip-types --input-type=module -e '
console.log(JSON.stringify({
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  navigatorGpu: typeof navigator?.gpu,
  sharedArrayBuffer: typeof SharedArrayBuffer,
  atomics: typeof Atomics,
}, null, 2));
'

echo

echo "--- install exact declared ONNX Runtime Web dependency pair ---"
run npm install --no-save --no-fund --no-audit "onnxruntime-web@$WEB_VERSION" "onnxruntime-common@$COMMON_VERSION"

echo

echo "--- verify exact installed versions ---"
run node --input-type=module -e '
for (const name of ["onnxruntime-web", "onnxruntime-common"]) {
  try {
    const packageJson = await import(`${name}/package.json`, { with: { type: "json" } });
    console.log(JSON.stringify({ package: name, ok: true, version: packageJson.default.version }));
  } catch (error) {
    console.log(JSON.stringify({ package: name, ok: false, error: String(error) }));
  }
}
'

echo

echo "--- inspect WASM capabilities ---"
run node --input-type=module -e '
try {
  const ort = await import("onnxruntime-web");
  const wasm = ort.env?.wasm;
  console.log(JSON.stringify({
    ok: true,
    webgpuBackendPresent: !!ort.env?.webgpu,
    webnnBackendPresent: !!ort.env?.webnn,
    wasm: {
      numThreads: wasm?.numThreads,
      simd: wasm?.simd,
      proxy: wasm?.proxy,
      wasmPaths: wasm?.wasmPaths,
    },
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error) }, null, 2));
  process.exitCode = 1;
}
'

echo

echo "--- run actual Seek-compatible WASM embedding ---"
SEEK_MCP_DEVICE=wasm run node --experimental-strip-types --input-type=module -e '
const { SeekQueryEmbedder } = await import("./src/query-embedder.ts");
const embedder = new SeekQueryEmbedder();
const texts = [
  "test four cold embedding",
  "a longer semantic search query about local notes, retrieval, and embeddings on an Android phone",
  "test four warm embedding one",
  "test four warm embedding two",
  "test four warm embedding three",
  "test four warm embedding four",
];
const samples = [];
for (const text of texts) {
  const started = Date.now();
  try {
    const vector = await embedder.embed(text);
    samples.push({ ok: true, chars: text.length, dimension: vector.length, elapsedMs: Date.now() - started });
  } catch (error) {
    samples.push({ ok: false, chars: text.length, elapsedMs: Date.now() - started, error: String(error) });
  }
}
console.log(JSON.stringify({ samples }, null, 2));
'

echo

echo "--- direct ONNX WASM session smoke check ---"
run node --input-type=module -e '
try {
  const ort = await import("onnxruntime-web");
  ort.env.wasm.numThreads = Math.max(1, Number(process.env.SEEK_WASM_THREADS || 1));
  console.log(JSON.stringify({
    ok: true,
    configuredThreads: ort.env.wasm.numThreads,
    simd: ort.env.wasm.simd,
    proxy: ort.env.wasm.proxy,
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error) }, null, 2));
  process.exitCode = 1;
}
'

echo

echo "=== end test-4 ==="
echo "Send this log file: $OUT"
