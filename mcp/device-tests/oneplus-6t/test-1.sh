#!/data/data/com.termux/files/usr/bin/bash
set -u

SCRIPT_PATH="$0"
if [ "${SCRIPT_PATH#/}" = "$SCRIPT_PATH" ]; then
  SCRIPT_PATH="$PWD/$SCRIPT_PATH"
fi
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd)"
ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${SEEK_PROBE_OUT:-$ROOT/termux-seek-probe-$STAMP.log}"

mkdir -p "$(dirname -- "$OUT")"
exec > >(tee "$OUT") 2>&1

echo "=== Obsidian Seek Termux backend probe ==="
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

echo "--- host and runtime ---"
run uname -a
run getprop ro.product.cpu.abi
run getprop ro.hardware
run getprop ro.soc.model
run node --version
run npm --version
run nproc
run sh -c 'grep -E "MemTotal|MemAvailable" /proc/meminfo 2>/dev/null || true'
run sh -c 'cat /proc/cpuinfo 2>/dev/null | grep -m 1 -E "model name|Hardware|Features|CPU architecture" || true'

echo
echo "--- installed project/runtime packages ---"
cd "$ROOT" || exit 1
run npm ls --depth=0
run node --experimental-strip-types --input-type=module -e '
console.log(JSON.stringify({
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  navigator: typeof navigator,
  navigatorGpu: typeof navigator?.gpu,
  gpuGlobal: typeof GPU,
  sharedArrayBuffer: typeof SharedArrayBuffer,
  atomics: typeof Atomics,
}, null, 2));
'

echo
echo "--- optional native Node WebGPU binding ---"
run node --input-type=module -e '
try {
  const { create, globals } = await import("webgpu");
  Object.assign(globalThis, globals);
  const gpu = create(["backend=vulkan"]);
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  console.log(JSON.stringify({
    package: "webgpu",
    available: true,
    adapter: !!adapter,
    info: adapter?.info ?? null,
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({
    package: "webgpu",
    available: false,
    error: String(error),
  }, null, 2));
}
'

echo
echo "--- vendored Transformers device surface ---"
run node --experimental-strip-types --input-type=module -e '
const runtime = await import("./vendor/seek/runtime/transformers.web.js");
const env = runtime.env;
console.log(JSON.stringify({
  transformersVersion: env.versions,
  navigatorGpu: typeof navigator?.gpu,
  wasm: {
    proxy: env.backends?.onnx?.wasm?.proxy,
    wasmPaths: env.backends?.onnx?.wasm?.wasmPaths,
  },
  webgpuBackendPresent: !!env.backends?.onnx?.webgpu,
}, null, 2));
'

echo
echo "--- strict WebGPU embedding probe ---"
echo "This must fail rather than fall back if no usable GPU backend exists."
SEEK_MCP_DEVICE=webgpu run node --experimental-strip-types --input-type=module -e '
const { SeekQueryEmbedder } = await import("./src/query-embedder.ts");
const started = Date.now();
try {
  const vector = await new SeekQueryEmbedder().embed("phone GPU capability probe");
  console.log(JSON.stringify({ ok: true, dimension: vector.length, elapsedMs: Date.now() - started }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, elapsedMs: Date.now() - started, error: String(error) }, null, 2));
  process.exitCode = 1;
}
'

echo
echo "--- strict WebGPU embedding with optional Dawn injection ---"
echo "This tests the real adapter after supplying Node with the webgpu package."
SEEK_MCP_DEVICE=webgpu run node --experimental-strip-types --input-type=module -e '
try {
  const { create, globals } = await import("webgpu");
  Object.assign(globalThis, globals);
  const gpu = create(["backend=vulkan"]);
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu } });
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("Dawn requestAdapter returned null");
  const { SeekQueryEmbedder } = await import("./src/query-embedder.ts");
  const started = Date.now();
  const vector = await new SeekQueryEmbedder().embed("Dawn injected GPU capability probe");
  console.log(JSON.stringify({ ok: true, dimension: vector.length, elapsedMs: Date.now() - started, adapter: adapter.info ?? null }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error) }, null, 2));
  process.exitCode = 1;
}
'

echo
echo "--- WASM embedding throughput probe ---"
echo "The first sample includes model/tokenizer startup; later samples show warm throughput."
SEEK_MCP_DEVICE=wasm run node --experimental-strip-types --input-type=module -e '
const { SeekQueryEmbedder } = await import("./src/query-embedder.ts");
const embedder = new SeekQueryEmbedder();
const texts = [
  "short warmup query",
  "a longer semantic search query about notes, embeddings, and local retrieval on a phone",
  "another repeated query to measure warm execution",
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
echo "=== probe complete ==="
echo "Send this file back: $OUT"