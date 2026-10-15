#!/data/data/com.termux/files/usr/bin/bash
set -u

SCRIPT_PATH="$0"
if [ "${SCRIPT_PATH#/}" = "$SCRIPT_PATH" ]; then
  SCRIPT_PATH="$PWD/$SCRIPT_PATH"
fi
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd)"
ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${SEEK_PROBE_OUT:-$ROOT/test-5-$STAMP.log}"

mkdir -p "$(dirname -- "$OUT")"
exec > >(tee "$OUT") 2>&1

echo "=== test-5: Node process visibility and WASM URL probe ==="
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

cd "$ROOT" || exit 1

echo "--- environment and declared state ---"
run node --version
run node --input-type=module -e '
console.log(JSON.stringify({
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  seekDevice: process.env.SEEK_MCP_DEVICE ?? null,
  seekWasmThreads: process.env.SEEK_WASM_THREADS ?? null,
}, null, 2));
'
run node --input-type=module -e '
for (const name of ["onnxruntime-web", "onnxruntime-common"]) {
  try {
    const resolved = await import.meta.resolve(name);
    console.log(JSON.stringify({ package: name, resolved }));
  } catch (error) {
    console.log(JSON.stringify({ package: name, error: String(error) }));
  }
}
'

echo
echo "--- runtime with Node process preserved ---"
run node --experimental-strip-types --input-type=module -e '
try {
  const runtime = await import("./vendor/seek/runtime/transformers.web.js");
  const env = runtime.env;
  console.log(JSON.stringify({
    processVisible: typeof process !== "undefined",
    allowLocalModels: env.allowLocalModels,
    allowRemoteModels: env.allowRemoteModels,
    useFS: env.useFS,
    localModelPath: env.localModelPath,
    useFSCache: env.useFSCache,
    cacheDir: env.cacheDir,
    wasmPaths: env.backends?.onnx?.wasm?.wasmPaths ?? null,
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error) }, null, 2));
  process.exitCode = 1;
}
'

echo
echo "--- runtime with the adapter's process hiding ---"
run node --experimental-strip-types --input-type=module -e '
try {
  const nodeProcess = globalThis.process;
  globalThis.process = undefined;
  const runtime = await import("./vendor/seek/runtime/transformers.web.js");
  globalThis.process = nodeProcess;
  const env = runtime.env;
  console.log(JSON.stringify({
    processVisibleDuringImport: false,
    allowLocalModels: env.allowLocalModels,
    allowRemoteModels: env.allowRemoteModels,
    useFS: env.useFS,
    localModelPath: env.localModelPath,
    useFSCache: env.useFSCache,
    cacheDir: env.cacheDir,
    wasmPaths: env.backends?.onnx?.wasm?.wasmPaths ?? null,
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error) }, null, 2));
  process.exitCode = 1;
}
'

echo
echo "--- Node blob URL capability ---"
run node --input-type=module -e '
try {
  const source = "export const value = 42;";
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    const module = await import(url);
    console.log(JSON.stringify({ blobImport: true, value: module.value }));
  } finally {
    URL.revokeObjectURL(url);
  }
} catch (error) {
  console.log(JSON.stringify({ blobImport: false, error: String(error) }));
}
'

echo
echo "--- candidate model locations ---"
run env ROOT="$ROOT" sh -c 'for path in \
  "$ROOT/models/tooape/granite-embedding-97m-multilingual-r2-GBQ4-ONNX" \
  "$ROOT/vendor/seek/models/tooape/granite-embedding-97m-multilingual-r2-GBQ4-ONNX" \
  "/models/tooape/granite-embedding-97m-multilingual-r2-GBQ4-ONNX" \
  "$HOME/.cache/huggingface/hub" \
  "$ROOT/.cache"; do
  if [ -e "$path" ]; then
    printf "%s\texists\n" "$path"
    find "$path" -maxdepth 3 -type f 2>/dev/null | head -20
  else
    printf "%s\tmissing\n" "$path"
  fi
done'

echo
echo "--- adapter device selection ---"
run node --experimental-strip-types --input-type=module -e '
const { requestedDevice } = await import("./src/seek-compatibility.ts");
console.log(JSON.stringify({ requestedDevice: requestedDevice(), env: process.env.SEEK_MCP_DEVICE ?? null }, null, 2));
'

echo
echo "=== end test-5 ==="
echo "Send this log file: $OUT"
