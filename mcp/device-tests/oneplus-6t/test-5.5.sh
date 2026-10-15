#!/data/data/com.termux/files/usr/bin/bash
set -u

SCRIPT_PATH="$0"
if [ "${SCRIPT_PATH#/}" = "$SCRIPT_PATH" ]; then
  SCRIPT_PATH="$PWD/$SCRIPT_PATH"
fi
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd)"
ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
VAULT="${1:-/data/data/com.termux/files/home/.picoclaw/workspace/Emma/System/vault}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${SEEK_PROBE_OUT:-$ROOT/test-5.5-$STAMP.log}"

mkdir -p "$(dirname -- "$OUT")"
exec > >(tee "$OUT") 2>&1

echo "=== test-5.5: Chromium Seek WASM sidecar ==="
echo "timestamp: $(date -Is 2>/dev/null || date)"
echo "repo: $ROOT"
echo "vault: $VAULT"
echo "output: $OUT"
echo

cd "$ROOT" || exit 1

CHROMIUM="${SEEK_CHROMIUM_PATH:-}"
if [ -z "$CHROMIUM" ]; then
  for candidate in chromium chromium-browser google-chrome google-chrome-stable; do
    if command -v "$candidate" >/dev/null 2>&1; then
      CHROMIUM="$(command -v "$candidate")"
      break
    fi
  done
fi
if [ -z "$CHROMIUM" ]; then
  echo "No Chromium executable found."
  echo "Set SEEK_CHROMIUM_PATH to the phone's Chromium binary."
  exit 2
fi

echo "chromium: $CHROMIUM"
"$CHROMIUM" --version

echo
echo "--- browser WASM embedding and vault ranking ---"
SEEK_CHROMIUM_PATH="$CHROMIUM" SEEK_MCP_DEVICE=wasm node --experimental-strip-types --input-type=module -e '
const { ChromiumSidecar } = await import("./src/chromium-sidecar.ts");
const { loadVaultIndex } = await import("./src/vault.ts");
const vault = process.argv[1];
const query = process.argv[2];
const sidecar = new ChromiumSidecar();
const started = Date.now();
try {
  const firstStarted = Date.now();
  const vector = await sidecar.embed(query);
  const values = Array.from(vector);
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  console.log(JSON.stringify({
    embedding: { ok: true, backend: "chromium-wasm", dimension: vector.length, finite: values.every(Number.isFinite), norm, firstValues: values.slice(0, 8), elapsedMs: Date.now() - firstStarted },
  }, null, 2));
  const repeat = await sidecar.embed(query);
  let maxDelta = 0;
  for (let index = 0; index < vector.length; index++) maxDelta = Math.max(maxDelta, Math.abs(vector[index] - repeat[index]));
  console.log(JSON.stringify({ repeat: { dimension: repeat.length, maxDelta } }, null, 2));
  const index = await loadVaultIndex(vault);
  const hits = index.search(values, 5);
  console.log(JSON.stringify({
    search: {
      ok: true,
      elapsedMs: Date.now() - started,
      index: index.status(),
      hits: hits.map((hit, rank) => ({ rank: rank + 1, score: hit.score, notePath: hit.notePath, chunkIndex: hit.chunkIndex, title: hit.title, preview: hit.content.slice(0, 240) })),
    },
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    backend: "chromium-wasm",
    elapsedMs: Date.now() - started,
    error: String(error),
    stack: error instanceof Error ? error.stack : null,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await sidecar.close();
}
' "$VAULT" "meeting notes about embeddings"

echo
echo "=== test-5.5 complete ==="
echo "Send this log file back: $OUT"
