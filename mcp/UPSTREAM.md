# Upstream Compatibility Map

The compatibility layer follows Obsidian Seek commit
`1f0a9b0ce3854f82cc746e02f9cd27bcdbc30acd`. The currently inspected plugin
checkout is newer (`06b837126f66d54db97ef8785a7c95750e48c311`), so a future
compatibility review must compare those revisions before changing format code.

| Seek source | MCP counterpart | Relationship |
| --- | --- | --- |
| `src/quant.ts` | `src/quant.ts` | Same quantized vector representation and dequantization rules, adapted for Node. |
| `src/sidecar.ts` constants and codec | `src/sidecar.ts` | Same format-3 dimensions, record layout, CRC, and offset rules. |
| `src/sidecar.ts` locator scanning | `src/sidecar.ts` | Same winner ordering, adapted from Obsidian/DataAdapter reads to Node filesystem reads. |
| `src/sidecar.ts` record reads | `src/sidecar.ts` | Same shard naming and range validation, adapted to Node buffers. |
| `src/model-registry.ts` | `vendor/seek/src/model-registry.ts` | Vendored snapshot at the pinned compatibility commit. |
| `src/embedder.ts` | `vendor/seek/src/embedder.ts` | Vendored snapshot at the pinned compatibility commit. |
| `src/iframe-runner.ts` | `vendor/seek/src/iframe-runner.ts` | Vendored snapshot containing Seek's browser embedding path. |
| `src/types.ts` | `vendor/seek/src/types.ts` | Vendored dependency snapshot for embedding compatibility. |
| `src/index-store.ts` read APIs | `/workspaces/Obsidian-Seek/src/mcp-export.ts` | Plugin-side exporter that joins document data to chunk IDs. |

The MCP transport, vault-location resolver, document manifest contract, loader
diagnostics, and query runtime adapter are new boundary code. They are not
upstream Seek files.

The paired compatibility boundary is:

| MCP file | Role |
| --- | --- |
| `src/SEEK-COMPATIBILITY.md` | Human/AI reverse-engineering and porting specification for the tensor and vector-space contract. |
| `src/seek-compatibility.ts` | Compact executable realization of the pinned model, backend policy, and vector post-processing rules. |

These files are MCP-owned orchestration and adaptation code, not wholesale
upstream snapshots. Update them together with any copied upstream block.

## Copy-and-port policy

Compatibility code copied from Seek must remain mechanically recognizable and
replaceable. Treat each copied block or file as an upstream island: preserve
its structure, naming, ordering, and comments. The primary optimization is the
smallest edit distance from Seek, not the smallest number of copied lines.
Copying extra upstream functions is preferable to rewriting or compressing
their control flow when that makes future comparison and replacement easier.
Only make a runtime adaptation where it is strictly necessary, and mark it at
the boundary instead of quietly blending MCP behavior into copied code.

The copied code is separate from the MCP codebase in ownership, but integrated
through explicit interfaces. This separation minimizes the diff footprint and
makes updates procedural rather than interpretive. A maintainer should be able
to identify a copied block, return to its original Seek source, compare the
corresponding updated block, and mechanically copy the update into this
repository without needing to rediscover the algorithm.

When a port requires a change, keep the adapter visibly separate from the
upstream block and document the source path, source commit, and reason for the
adaptation. Do not refactor copied code for local style, do not mix unrelated
MCP changes into it, and do not make a copied snapshot look locally authored.
New MCP behavior belongs in adjacent adapter modules or clearly marked
boundary sections. The goal is maximum source fidelity and code that is easy
for both humans and automated tools to update by comparison and replacement.

### Copy first, adapt second

For a compatibility feature, start by copying the largest relevant Seek file,
module, or function block that can run in this repository. Do not begin by
designing a smaller replacement. Whole-file copies and large copied blocks are
preferred when they keep the plugin's control flow obvious, even if only part
of the copied surface is used immediately.

After the copy is present, make the runtime adaptation in a separate wrapper,
or in a small, explicitly marked section at the edge of the copied code. The
copied code should remain the dominant implementation and the MCP code should
remain the integration layer. When a plugin file has only a few incompatible
imports or platform calls, copy the file and change those edges rather than
reimplementing its internal functions elsewhere.

This is deliberately a broad-transplant policy rather than a minimal-rewrite
policy: prefer a recognizable wholesale copy over a clever small rewrite. The
test for success is whether a maintainer can diff this file against Seek, find
the changed edges immediately, and paste a newer Seek version over it without
reconstructing the design.

`src/query-embedder.ts` follows Seek's query preprocessing, pooling,
normalization, model, revision, token limit, output dimension, and default WASM
glue selection. The compatibility module also exposes explicit `wasm`, `auto`,
and strict `webgpu` requests. The copied web runtime is hosted in the active
Chromium sidecar, which preserves the plugin's iframe/browser boundary and CDP
transport while Node owns the MCP/index adapter. Device evidence shows that the
phone's working plugin path is browser-hosted WASM with plain glue and a proxy
worker; the Chromium sidecar now reproduces that path. WebGPU remains optional
because Node/Termux does not expose the browser APIs used by Seek and the
phone's plugin host reports no usable adapter.

## Current runtime note

The browser-WASM adapter is in pushed commit `bc0bcd3`, with the runtime registry
shim in `a940b91`. Phone probe `test-5.5.sh` generated a finite normalized
384-dimensional vector and ranked vault results. The strict WebGPU detour remains
historical; the supported Android sidecar uses WASM and plain glue.

## Maintenance procedure

Before every Seek update, compare the pinned compatibility source with the new
Seek source, especially `quant.ts`, `sidecar.ts`, `binary.ts`, model metadata,
types, and IndexedDB read/schema APIs. Port format-sensitive changes without
guessing unknown formats, update fixtures and version gates, and rerun MCP
build/tests plus hidden and visible export validation.
