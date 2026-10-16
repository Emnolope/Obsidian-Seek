# Plugin ↔ MCP parity

Seek has two front ends over one index: the **Obsidian plugin** (for the human) and an
**MCP server** (for agents). Each can do what the other can, in its own medium. The only
thing they share is the on-disk index format, so that format lives in one place.

```
core/    the contract: record layout, codec, resolve rules, export manifest, model dim.
         Pure TypeScript — no Obsidian, no node:fs, no DOM (tsconfig.core.json enforces it).
src/     the plugin. Imports core; src/quant.ts re-exports it, src/sidecar.ts re-exports format.ts.
mcp/     the MCP server. Node adapter over core (mcp/src/sidecar.ts) + query embedder + stdio server.
```

## The rule

A change to anything both sides must agree on goes in `core/`. Then:

```
npm run typecheck   # plugin + core (strict, no DOM/node) + mcp
npm test            # includes core/parity.test.ts: real plugin exporter -> real MCP loader
npm run test:mcp
```

`core/parity.test.ts` fails if the two sides drift (record bytes, tombstones, export
files, model dimension/repo/revision). That test is the convention.

## Install it either way

One tag, one release, two assets:

| As | Asset | How |
| --- | --- | --- |
| Obsidian plugin | `main.js`, `manifest.json`, `styles.css` | BRAT, or drop into `.obsidian/plugins/seek/` |
| MCP server | `obsidian-seek-mcp-<version>.tgz` | `npx -y <release-asset-url>` or `npm i -g <release-asset-url>` |

MCP client config (any MCP host):

```json
{ "command": "npx", "args": ["-y", "https://github.com/Emnolope/Obsidian-Seek/releases/download/<tag>/obsidian-seek-mcp-<version>.tgz"] }
```

PicoClaw: `picoclaw mcp add --force --no-deferred obsidian-seek -- npx -y <release-asset-url>`.
From a checkout: `npm ci && npm run build:mcp && node mcp/dist/server.mjs`.

The tarball bundles `core/` into `dist/`; only `onnxruntime-*` come from npm, and
`transformers.web.js` ships as a real file because it must load lazily.

## Known gaps

- `mcp/vendor/seek/src/*` are still pinned copies of plugin files (2–6 lines drift each).
  Next step: import `src/embedder.ts`, `iframe-runner.ts`, `model-registry.ts`, `types.ts`
  directly (none import `obsidian`). Not done here because the Chromium query path can't
  be exercised without the phone.
- The plugin exporter always writes `Seek Index/MCP Export`, even when the index lives under
  `.obsidian/plugins/seek/index`.
- `EMBEDDING_DIM` in `core/contract.ts` is now the source of the record stride; the plugin
  used to derive it from `ACTIVE_MODEL_SPEC.dim`. `parity.test.ts` pins the two together.

## What lives in core/ (rule: everything except low-level I/O and UI)

core/ holds all logic that doesn't touch a runtime: chunking, tokenizing, BM25, fusion, ranking, query parsing, passages/snippets, the search pipeline (`engine.ts` → `runSearch`), frame/drift helpers, the sidecar and export formats.
Runtime-specific work goes behind `SearchHost` (engine.ts): IndexedDB or files, the embedder, workers, logging, Obsidian's property registry.
`memory-host.ts` is the reference host (whole corpus in RAM); the MCP server uses it as-is.

Constraints, enforced by `tsconfig.core.json` and the MCP tests:
- no `obsidian`, DOM or Node imports (`globals.d.ts` declares the few universal globals);
- explicit `.ts` import extensions and no constructor parameter properties, because the MCP tests load core/ under node's strip-only TypeScript mode.

Also in core/ now: `index-types.ts` (FileRecord, MetaConfig, classifyFileDelta), `delta.ts` (indexing rules, chunksFor, computeDelta behind `DeltaPorts`), `file-diff.ts` (chunk-diff planner behind `DiffStore`), `apply-delta.ts` (in-place BM25 + frame patcher behind `ApplyCtx`), `embed-commit.ts` (the whole write pass: chunk, bucketed embed, atomic per-file commit, meta/identity stamp, sidecar-flush packaging, behind `EmbedCommitCtx`).

Still in src/ (to port or split next): `SearchOrchestrator` plumbing (indexing, delta, sidecar sync), embedder runtime, index-store, logger, UI.
