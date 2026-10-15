# Obsidian-Seek-MCP

Human-facing usage is documented below. Agent-to-agent maintenance guidance,
project context, and the current unfinished handoff live in
[`HANDOFF.md`](HANDOFF.md) and [`CONTEXT.md`](CONTEXT.md).

This repository contains the read-only MCP consumer for a complete export from
the Seek Obsidian plugin. The companion exporter is in the Seek source checkout
at `/workspaces/Obsidian-Seek`; Obsidian exposes it as **Seek: Export complete
MCP index**.

The current active state uses a Chromium browser-WASM sidecar for natural-
language query embedding, with Node retaining vault loading and ranking. The
sidecar is required on Android because Node cannot import the browser runtime's
`blob:` module URL. The working tree includes a read-only CLI for direct status,
search, chunk, and note checks.

The browser-WASM path was integrated in `bc0bcd3`, the vendored runtime shim was
added in `a940b91`, and the end-to-end phone probe is `b62c070`. The phone
validated a finite 384-dimensional query vector and ranked real vault notes.

## Run

The server is a single multi-vault MCP process. It does not bind to one vault
at startup. Each tool call supplies a `vaultDir` pointing to an Obsidian vault:

```sh
npm install
npm start
```

On Android/Termux, point the adapter at the installed Chromium binary before
starting the server or running a text search:

```sh
export SEEK_CHROMIUM_PATH=/data/data/com.termux/files/usr/bin/chromium-browser
```

It exposes `index_status`, `semantic_search`, `fetch_chunk`, and `fetch_note`
over MCP stdio. Every tool accepts `vaultDir`, which may be an absolute or
relative path anywhere the process has filesystem access. The server checks
Seek's hidden default index directory,
`<vaultDir>/.obsidian/plugins/seek/index`, first and then the supported visible
fallback, `<vaultDir>/Seek Index`; the caller never needs to know which plugin
setting is active.
`semantic_search` accepts either `queryText` or a precomputed `queryVector`; the
local adapter uses Seek's model, revision, CLS pooling, normalization, and
384-dimensional output. The document records retain Seek's quantized `q`/`s`
tier; the server dequantizes it using the vendored Seek-compatible
implementation.

The compatibility contract is documented in
[`src/SEEK-COMPATIBILITY.md`](src/SEEK-COMPATIBILITY.md) and implemented by
[`src/seek-compatibility.ts`](src/seek-compatibility.ts). The active backend is
browser-hosted WASM through Chromium on Android; direct Node execution remains
a diagnostic path and cannot load the browser runtime's `blob:` module.

The Node process remains responsible for MCP transport, vault loading, and
ranking. Backend choice changes execution environment and speed, not the
model/vector-space contract.

The current Seek exporter writes `MCP Export/` under the hidden path
unconditionally. The visible fallback is therefore a resolver capability, not
proof that visible-mode exports are currently produced coherently. Until the
plugin exporter derives its destination from the selected setting, use hidden
mode or validate the generated files manually.

Indexes are loaded lazily and cached by their resolved vault, so the same
four MCP tools work across any number of vaults without registering separate
tool names or separate MCP servers. `vaultDir` is the only path exposed to the
agent; the operating system still controls which directories the PicoClaw
process can read.

For example, a PicoClaw registration needs only the server command:

```sh
picoclaw mcp add --force --no-deferred obsidian-seek -- \
	node --experimental-strip-types \
	/path/to/Obsidian-Seek-MCP/src/server.ts
```

PicoClaw then supplies a different `vaultDir` when it calls the same
`semantic_search`, `fetch_note`, or `fetch_chunk` tool.

When `queryText` is supplied by the MCP caller, the server vectorizes that text
locally with the Seek-compatible adapter and compares the resulting vector to
the already-indexed paragraph vectors. Retrieved paragraphs are not embedded a
second time.

The server is intentionally read-only. It does not edit notes, run Git, or
modify Seek's index.

The MCP core and index/ranking path remain Node-owned, while Android query
embedding runs in the Chromium sidecar. Earlier speed comparisons showed MCP
query embedding at about one-half to one-quarter of the plugin's apparent
speed, but the plugin had a preloaded model and warm runtime. The phone's
validated plugin path is CPU q4 WASM with plain ORT glue and a proxy worker,
not GPU WebGPU. The first sidecar query took about 57 seconds because it was
cold; a resident MCP server can reuse the loaded model.

## Device tests

Phone-specific diagnostics live under `device-tests/<device>/`. The current
suite is `device-tests/oneplus-6t/`; run it from the repository root on the
matching Termux device. `test-5.5.sh` is the end-to-end Chromium WASM probe:
it generates a 384-value query vector and uses it to rank the real vault. The
scripts currently default generated logs to the
repository root unless `SEEK_PROBE_OUT` is set; keep new logs out of commits.
`test-6.sh` serializes a flat report in the browser before crossing CDP, while
`test-7.sh` captures raw browser console and exception events. The transport
probe is complete enough to diagnose the WebGPU failure; use the existing
scripts as evidence tools, not as proof that strict WebGPU is the phone's
working backend.

Short version: the AI can generate the probe, but the phone owns the execution
and permission boundary. A server-side VM is not a phone and cannot claim a
WebGPU or Chromium result on the user's device. The proof must come from the
actual device, then be reported back through the repo.

## CLI

The same loader and search implementation is available for direct human or
scripted checks:

```sh
npm run cli -- status /path/to/vault
npm run cli -- embed "meeting notes about embeddings" --json
npm run cli -- search /path/to/vault "meeting notes about embeddings" --top-k 5
npm run cli -- chunk /path/to/vault CHUNK_ID
npm run cli -- note /path/to/vault Projects/example.md
```

Add `--json` to any command for machine-readable output. Search also accepts a
precomputed vector with `--vector`; it must contain 384 comma-separated values
or a JSON array. The CLI uses the same hidden-then-visible vault resolution as
the MCP server and never writes to the vault. `embed` outputs the query vector
directly, as comma-separated values by default or a JSON array with `--json`.

## Current loader behavior

The loader preserves strict validation for malformed records, invalid paths,
dimension mismatches, and CRC failures. It tolerates a stale document mapping
that has no matching native vector: that mapping is skipped and reported by
`index_status` instead of preventing usable pairs from being searched. The
diagnostics include `exportedDocuments`, `loadedDocuments`,
`skippedDocuments`, and `orphanVectors`.

The key architectural rule is that the export is not a rival generation
pipeline. It is a read-only view of the same successful Seek indexing commit.
The vector payload, the file/chunk mapping, and the document metadata must be
published together. If they are split across generations, the loader treats the
result as stale or incomplete instead of pretending it is a valid atomic export.

The first natural-language query loads the pinned Granite model through the
vendored Seek-compatible Transformers.js web bundle in Chromium and may
download it from the model host. Later queries reuse the sidecar's in-process
pipeline. The adapter selects the same q4 WASM/plain-glue path that Seek uses
on Android; it does not install or import `onnxruntime-node`. Strict `webgpu`
remains an explicit experimental request and is not the phone's validated path.
Phone validation in Termux found no Node `navigator.gpu`, no published Android
ARM64 Dawn binary, and no Android-compatible `onnxruntime-node` package. After
installing the web runtime's declared common dependency, the browser-oriented
WASM loader still reached a Node-incompatible `blob:` module URL. The Chromium
sidecar supplies the browser-compatible runtime and does not change the
model/vector compatibility contract. Strict WebGPU remains an explicit,
experimental path rather than the phone default.

The real synchronized `system-vault` export is separate from this repository.
Its current export contains 6,735 document records and 6,736 native locator
records, so a full consistency check and exporter correction remain explicit
validation tasks.

The next exporter change belongs in the separate plugin checkout: make the MCP
export destination follow the selected hidden or visible sidecar location while
retaining the successful-commit boundary. Keep that integration explicit and
diff-friendly; do not alter Seek's embedding calculations. After that, add
resolver and MCP protocol tests, then bound search and fetch responses.
