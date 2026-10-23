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

Things the bot does differently on purpose, or cannot check from a sandbox:

- **Human-only UI** stays in `src/`: search modal, query field, suggestions, insert-link, recents, settings tab, commands, ribbon, notices, the binary-scorer worker, and the `seek:search` companion event relay (an Obsidian cross-plugin bus, off in the public build).
- **Embedder runtime:** the plugin runs `embedder`/`iframe-runner` in Obsidian; the bot runs the same `core/child-script.ts` in Chromium (`mcp/src/chromium-sidecar.ts`). Same model, revision, dtype, pooling.
- **Storage:** the plugin's IndexedDB is the bot's `NodeIndexStore` (memory + a snapshot in the MCP state dir). Same `IndexStore` contract, different bytes. The sidecar under `.obsidian/plugins/seek/index` is the shared interface.
- **Link dictionary:** Obsidian hands the plugin parsed links; the bot parses wikilinks itself (`core/link-dict.ts` `scanWikiLinks`, `mcp/src/link-miner.ts`). It mirrors `LinkCache.links` (skips frontmatter, code, embeds) but is not Obsidian's parser, so edge cases (e.g. links inside HTML) can differ.
- **Excluded files:** the plugin asks `metadataCache.isUserIgnored`; the bot reads `.obsidian/app.json` `userIgnoreFilters` through the plugin's own fallback matcher (`core/delta.ts` `matchUserIgnoreFilters`).
- **Model on disk:** the plugin probes the Cache API; the bot treats its Chromium profile as the cache and calls the model present above `MODEL_PRESENT_MB` (a heuristic).
- **Never run here:** real Obsidian, the phone, `release.yml`, the Chromium embed path (`mcp/device-tests/embed-smoke.ts`).
- The plugin exporter always writes `Seek Index/MCP Export`, even when the index lives under `.obsidian/plugins/seek/index`.

## What lives in core/ (rule: everything except low-level I/O and UI)

core/ holds all logic that doesn't touch a runtime: chunking, tokenizing, BM25, fusion, ranking, query parsing, passages/snippets, the search pipeline (`engine.ts` → `runSearch`), frame/drift helpers, the sidecar and export formats.
Runtime-specific work goes behind `SearchHost` (engine.ts): IndexedDB or files, the embedder, workers, logging, Obsidian's property registry.
`memory-host.ts` is the reference host (whole corpus in RAM); the MCP server uses it as-is.

Constraints, enforced by `tsconfig.core.json` and the MCP tests:
- no `obsidian`, DOM or Node imports (`globals.d.ts` declares the few universal globals);
- explicit `.ts` import extensions and no constructor parameter properties, because the MCP tests load core/ under node's strip-only TypeScript mode.

Also in core/ now: `index-types.ts` (FileRecord, MetaConfig, classifyFileDelta), `delta.ts` (indexing rules, chunksFor, computeDelta behind `DeltaPorts`), `file-diff.ts` (chunk-diff planner behind `DiffStore`), `apply-delta.ts` (in-place BM25 + frame patcher behind `ApplyCtx`), `embed-commit.ts` (the whole write pass: chunk, bucketed embed, atomic per-file commit, meta/identity stamp, sidecar-flush packaging, behind `EmbedCommitCtx`).

Also in core/: `index-lifecycle.ts` (edit queues, flush, catch-up, drift recovery, identity heal, reconcile, pause/resume, `runFullReindex`), `index-stats.ts` (`getIndexStats`, `getModelStatus`, `deleteModel` behind ports), `base-extractor.ts`, `logger.ts`, `link-dict.ts`.

Bot surface (`mcp/src/`): `BotHost` mirrors `SearchOrchestrator`; MCP tools `index_status`, `semantic_search`, `fetch_chunk`, `fetch_note`, `index_stats`, `model_status` (reads) and `index_vault`, `index_delta`, `hydrate_sidecar`, `compact_sidecar`, `delete_model` (writes). The CLI has the same verbs; reads use the bot's own store once it has chunks, else the human's export snapshot (`bot-route.ts`).
