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
OUT="${SEEK_PROBE_OUT:-$ROOT/test-3-$STAMP.log}"
mkdir -p "$(dirname -- "$OUT")"
exec > >(tee "$OUT") 2>&1

echo "=== test-3: ONNX runtime salvage matrix ==="
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
COMMON_VERSION="$WEB_VERSION"

echo "--- phone and Node ---"
run uname -a
run getprop ro.product.cpu.abi 2>/dev/null || true
run getprop ro.hardware 2>/dev/null || true
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

echo "--- install the pinned web runtime and its missing common package ---"
run npm install --no-save --no-fund --no-audit "onnxruntime-web@$WEB_VERSION" "onnxruntime-common@$COMMON_VERSION"
run node --input-type=module -e '
for (const name of ["onnxruntime-web", "onnxruntime-common"]) {
  try {
    const module = await import(name);
    console.log(JSON.stringify({ package: name, ok: true, keys: Object.keys(module).slice(0, 20) }));
  } catch (error) {
    console.log(JSON.stringify({ package: name, ok: false, error: String(error) }));
  }
}
'

echo

echo "--- run the actual Seek-compatible WASM embedder ---"
SEEK_MCP_DEVICE=wasm run node --experimental-strip-types --input-type=module -e '
const { SeekQueryEmbedder } = await import("./src/query-embedder.ts");
const embedder = new SeekQueryEmbedder();
const texts = [
  "test three first embedding",
  "a longer semantic search query about local notes and retrieval on an Android phone",
  "test three warm embedding",
  "test three second warm embedding",
  "test three third warm embedding",
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

echo "--- inspect ONNX Runtime Web providers ---"
run node --input-type=module -e '
try {
  const ort = await import("onnxruntime-web");
  console.log(JSON.stringify({
    ok: true,
    keys: Object.keys(ort),
    env: ort.env ? {
      wasm: ort.env.wasm ? {
        numThreads: ort.env.wasm.numThreads,
        simd: ort.env.wasm.simd,
        proxy: ort.env.wasm.proxy,
      } : null,
      webgpu: !!ort.env.webgpu,
      webnn: !!ort.env.webnn,
    } : null,
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error) }, null, 2));
  process.exitCode = 1;
}
'

echo

echo "--- try official native ONNX Runtime Node ---"
run npm install --no-save --no-fund --no-audit onnxruntime-node@latest
run node --input-type=module -e '
try {
  const ort = await import("onnxruntime-node");
  console.log(JSON.stringify({ ok: true, keys: Object.keys(ort) }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error) }, null, 2));
  process.exitCode = 1;
}
'

echo

echo "--- try ONNX Runtime Node session providers ---"
run node --input-type=module -e '
try {
  const ort = await import("onnxruntime-node");
  const providers = ort.InferenceSession?.availableProviders ?? ort.env?.availableProviders ?? null;
  console.log(JSON.stringify({ ok: true, availableProviders: providers }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error) }, null, 2));
  process.exitCode = 1;
}
'

echo

echo "--- try native Node WebGPU package separately ---"
run npm install --no-save --no-fund --no-audit webgpu@0.6.0
run node --input-type=module -e '
try {
  const { create, globals } = await import("webgpu");
  Object.assign(globalThis, globals);
  const gpu = create(["backend=vulkan"]);
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  console.log(JSON.stringify({ ok: true, adapter: !!adapter, info: adapter?.info ?? null }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error) }, null, 2));
  process.exitCode = 1;
}
'

echo

echo "=== end test-3 ==="
echo "Send this log file: $OUT"
