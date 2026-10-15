# Obsidian Seek MCP Context

## Why this exists

This project gives an agent useful access to a human-maintained Obsidian vault
without turning the agent into another author of that vault. Seek remains the
human-side indexing and embedding authority; this repository is the read-side
bridge that makes the already-created knowledge searchable by PicoClaw.

The separation is intentional. A human's notes and the agent's retrieval
process have different responsibilities and different failure modes. The agent
copy should be safe to inspect, synchronize, rebuild, and debug without
silently editing the human source of truth or inventing a second embedding
space. Compatibility, read-only behavior, and explicit unfinished work matter
more here than making the repository look complete.

Short version: the AI may prepare a Chromium/browser-runtime probe, but the phone owns
the actual execution and permission boundary. A remote VM or data-center process
is not a phone and cannot claim device validation. The user runs the probe on
the target device, records the result, and sends that evidence back through the
repository so identity, security, and trust remain coherent. The validated phone
query path is a Node controller with a Chromium browser-WASM sidecar; Node still
owns the read-only vault and ranking boundary.

## Goal

Give PicoClaw read-only semantic retrieval over one or more Obsidian vaults by
reusing embeddings produced by the Seek plugin. The agent supplies a vault
directory; it does not need to know Seek's index directory or storage format.

The intended topology is:

```text
human vault -> Seek indexes notes -> Git sync -> agent vault copy
                                              -> MCP server -> PicoClaw
```

The agent copy is the read-side safety boundary. This MCP server does not edit
notes, run Git, reindex Seek, or mutate the human source-of-truth vault.

## Performance postmortem

The original MCP core was functional, although its query embedding was measured
at roughly one-half to one-quarter of the plugin's apparent speed. That gap was
initially interpreted as evidence that Seek was using GPU execution while MCP
was using CPU execution. The later Seek diagnostic report disproved that
interpretation for the OnePlus 6T: the plugin had no usable WebGPU adapter and
was working through q4 WASM, plain ORT glue, and a proxy worker.

The old comparison therefore mixed hosts, worker placement, runtime loading,
cold versus warm state, and likely batching. It was not an apples-to-apples GPU
versus CPU benchmark. The MCP core was not invalidated by being slower. The
plugin had a resident, preloaded model, while a one-shot MCP command paid
Chromium startup, model loading, tokenizer initialization, and WASM setup on its
first query. The Chromium sidecar is now the supported Android execution path.

The current repository state uses the validated browser-WASM bridge. Dependency
integration is in `9d71002`, the Chromium query path is in `bc0bcd3`, the
NodeNext vendor fixes are in `d775c30`, the runtime registry shim is in
`a940b91`, and the end-to-end phone probe is in `b62c070`. The phone's
`test-5.5.sh` run generated a finite, normalized 384-dimensional vector and
ranked real vault notes.

The recovery anchors are recorded in `HANDOFF.md` and `INVESTIGATION.md`:
`e1e8732` is the last pre-sidecar mainline state, `3e093b3` introduced the
strict-WebGPU-only sidecar detour, and `695d3d5` fixed a transport issue in that
historical branch. The current sidecar is a deliberate browser-WASM recovery,
not the old WebGPU detour.

## Current architecture

The MCP server is a Node/TypeScript stdio process. It exposes one stable tool
set for every vault:

- `index_status`
- `semantic_search`
- `fetch_chunk`
- `fetch_note`

Every tool receives `vaultDir`. The server resolves and tries these Seek
locations in order:

1. `<vaultDir>/.obsidian/plugins/seek/index`
2. `<vaultDir>/Seek Index`

The first location is Seek's hidden/default sidecar location. The second is
Seek's visible vault-root option. Indexes are loaded lazily and cached by the
resolved vault directory, so different vaults use the same tools and process.
The compatibility contract is specified by `src/SEEK-COMPATIBILITY.md` and
realized by `src/seek-compatibility.ts`; both should be updated together when
Seek changes.

## Export boundary

Seek keeps its working index in IndexedDB and writes a portable sidecar. The
MCP server cannot depend on private IndexedDB access, so it reads the native
sidecar plus the MCP document manifest. The native binary sidecar supplies
quantized vectors; the manifest supplies chunk IDs, note paths, titles, text,
and chunk metadata.

The plugin now has a successful-commit hook that calls its named MCP exporter.
The exporter joins Seek metadata, bodies, file mappings, and quantized vectors,
then writes the document manifest through a temporary directory and renames it
into place. This is a read-side export, not a second embedding or indexing
algorithm.

## Important current limitation

Seek's sidecar location is configurable, but the current plugin exporter writes
`MCP Export/` to the hidden path
`.obsidian/plugins/seek/index/MCP Export`. Therefore visible-mode support is not
fully coherent yet: a visible native sidecar can be paired with a hidden MCP
manifest, or the MCP resolver can find a native sidecar without its manifest.
The next plugin change must derive the MCP export directory from the same
configured sidecar location used for native files.

## Verified baseline

The current MCP repository is published as `Obsidian-Vault-MCP-v4`. The plugin
checkout is commit `06b837126f66d54db97ef8785a7c95750e48c311`.

The available real system-vault data currently shows:

- visible native locator records: 6,736
- visible MCP document records: 6,735
- hidden native locator records: 6
- model ID: `tooape/granite-embedding-97m-multilingual-r2-GBQ4-ONNX`
- revision: `54db88c5667bd79b4aea24ea6027a7ef45a7bbb5`
- dimension: `384`
- sidecar format: `3`

The 6,735/6,736 mismatch is real and remains a diagnostic/recovery case, not
evidence of a complete export. A fresh export after fixing the location
coupling must be validated end to end.

The current loader run against the phone's synchronized agent vault loaded
6,729 of 6,735 document records, skipped 6 stale mappings, and found 7 orphan
native vectors. Search remains usable, but this is not a complete consistency
result.

## Scope boundaries

The current server supports natural-language query embedding with the pinned
Seek-compatible model, or a caller-supplied 384-value query vector. Search is a
full scan and returns chunk-level hits. A read-only CLI now uses the same vault
loader and index APIs for status, search, chunk, and note checks. Note-level
grouping, response bounds, automatic reload, and tombstone handling are not
implemented yet. The query backend defaults to WASM; `SEEK_MCP_DEVICE=auto` may
attempt WebGPU and fall back to WASM, while `SEEK_MCP_DEVICE=webgpu` is strict
and fails when WebGPU cannot initialize. On Android, the supported WASM path
uses Chromium through `SEEK_CHROMIUM_PATH`, because Node cannot import the
browser runtime's `blob:` module URL. The phone's actual WebGPU capability
has now been tested from Termux. The phone is Android arm64 with Node 26,
seven reported CPUs, SharedArrayBuffer, and Atomics, but Node exposes neither
`navigator.gpu` nor a global `GPU`. The published `webgpu` package installs but
fails because it has no `android-arm64/dawn.node` binary. The official
`onnxruntime-node` package rejects Android at install time.

The phone-side tests also corrected the declared `onnxruntime-common` version
and installed it successfully. The real Seek-compatible web/WASM embedder still
failed in Node because the browser-oriented runtime produced a `blob:` module
URL that Node's ESM loader does not support. The restored Chromium sidecar
supplies the browser environment expected by the copied web stack.
`test-5.5.sh` proved the complete path: Chromium WASM generated a finite
384-dimensional vector, repeated embedding was deterministic, and the vector
ranked five notes from the 6,729-loaded-chunk vault. The first embedding took
about 57 seconds because the model was cold; a resident server can amortize
that cost. Strict WebGPU remains unsupported on this phone, and a custom
Android native build is not justified.
