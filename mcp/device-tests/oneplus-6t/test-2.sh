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
OUT="${SEEK_PROBE_OUT:-$ROOT/test-2-$STAMP.log}"

mkdir -p "$(dirname -- "$OUT")"
exec > >(tee "$OUT") 2>&1

echo "=== test-2: Node + Dawn WebGPU probe ==="
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
  echo "This script must be run inside the Obsidian-Seek-MCP repo root."
  echo "Expected: $ROOT/package.json and $ROOT/src"
  exit 1
fi

cd "$ROOT" || exit 1

echo "--- repo and runtime ---"
run ls -la
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
  navigator: typeof navigator,
  navigatorGpu: typeof navigator?.gpu,
  gpuGlobal: typeof GPU,
  sharedArrayBuffer: typeof SharedArrayBuffer,
  atomics: typeof Atomics,
}, null, 2));
'

echo

echo "--- install project deps ---"
run npm install --no-fund --no-audit

echo

echo "--- install Dawn Node WebGPU ---"
run npm install --no-save --no-fund --no-audit webgpu@0.6.0

echo

echo "--- check Dawn WebGPU package directly ---"
run node --input-type=module -e '
try {
  const { create, globals } = await import("webgpu");
  Object.assign(globalThis, globals);
  const gpu = create(["backend=vulkan"]);
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  console.log(JSON.stringify({
    package: "webgpu",
    adapter: !!adapter,
    info: adapter?.info ?? null,
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({
    package: "webgpu",
    ok: false,
    error: String(error),
  }, null, 2));
  process.exitCode = 1;
}
'

echo

echo "--- inject Dawn into Node and run model embedding ---"
run node --experimental-strip-types --input-type=module -e '
try {
  const { create, globals } = await import("webgpu");
  Object.assign(globalThis, globals);
  const gpu = create(["backend=vulkan"]);
  globalThis.navigator = { gpu };
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("requestAdapter returned no adapter");
  const { SeekQueryEmbedder } = await import("./src/query-embedder.ts");
  const started = Date.now();
  const vector = await new SeekQueryEmbedder().embed("phone test 2: Dawn injected");
  console.log(JSON.stringify({
    ok: true,
    dimension: vector.length,
    elapsedMs: Date.now() - started,
    adapter: adapter.info ?? null,
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    error: String(error),
    stack: error instanceof Error ? error.stack : null,
  }, null, 2));
  process.exitCode = 1;
}
'

echo

echo "--- run strict WASM baseline ---"
SEEK_MCP_DEVICE=wasm run node --experimental-strip-types --input-type=module -e '
const { SeekQueryEmbedder } = await import("./src/query-embedder.ts");
const embedder = new SeekQueryEmbedder();
const texts = [
  "short warmup query",
  "longer query about notes, retrieval, and embeddings on a phone",
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

echo "=== end test-2 ==="
echo "log file: $OUT"
