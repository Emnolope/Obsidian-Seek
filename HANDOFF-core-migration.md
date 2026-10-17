# Handoff: Seek core migration (read this fully before touching anything)

## Working with Emmanuel
- Casual, profane, wants results, but explicitly wants you to SLOW DOWN and ASK when a decision is his. He is on a free plan with limited usage windows, so commit and push after every step.
- Terse code, short purpose-laden names. Comments say WHY, never what.
- Tone: recovery and optimism. No self-flagellation after a mistake; state it, fix it, move on.
- LESSON FROM THIS SESSION: items in a handoff (including the "known gaps" in the previous one) are suggestions, not orders. Anything that REMOVES behavior needs his confirmation first. I stripped vectors from MCP output because a gap said to; he wanted them. Prefer opt-in flags over deletion.
- Never claim "typechecks clean" without running `npm run typecheck` (root tsc + core tsc + the MCP's own tsc). I once ran only part of it and missed a real error.

## State
- Repo: /home/claude/obsidian-seek (github.com/Emnolope/Obsidian-Seek), branch `monorepo-core`, head 5ed96fc, pushed. Do not re-clone. If missing: add_repo, owner Emnolope, access "push". Run `git fetch origin monorepo-core` before pushing (shallow single-branch clone). The "repository moved" push warning is harmless.
- Emnolope/Obsidian-Seek-MCP: README now points to the consolidated repo (main 50eb5e8). Otherwise untouched.
- Verified at 5ed96fc: `npm run typecheck`, 1173 plugin tests, 5 MCP tests, plugin + MCP builds.
- NOT verified: Chromium/Termux text-to-vector path; loading the built plugin in Obsidian; release.yml/ci.yml (never run); a real plugin export at schema v2 read by the MCP against a real vault.

## Architecture (his metaphor: one program, three layers)
- BASE differs per environment (Obsidian vs terminal/Node/Termux). MIDDLE (core/) is identical and written once. TOP differs (Obsidian UI vs MCP tools).
- Rule: core/ is everything except low-level I/O and UI. Port big blocks, leave comments where unsure how.
- core/ now holds: format/sidecar codec, export manifest, quant, atoms, tokenize, chunker, token-budget, bm25, synonyms, fusion, ranker, query-parser, passage, snippet, highlight, select, binary, pool, dense-stats, dense-clean, types, search-helpers (frame rows, drift, bm25 stamp, snippet), engine.ts, memory-host.ts.
- engine.ts: `runSearch(host, query, topK, override)` is the one query pipeline (hybrid BM25 + dense + recency, filters). `runDenseSearch` is exact cosine for vector-only callers. Everything runtime-specific sits behind the `SearchHost` interface.
- Plugin: SearchOrchestrator implements the host via `searchHost()` in src/search.ts. MCP: `MemoryHost` (core/memory-host.ts, whole corpus in RAM) is used as-is by mcp/src/index.ts.
- src/<name>.ts for moved modules are one-line `export *` shims over core/, so plugin imports and tests are unchanged.
- core/ constraints (tsconfig.core.json + MCP tests): no obsidian/DOM/Node imports (core/globals.d.ts declares console, performance, TextEncoder, navigator); explicit `.ts` import suffixes; NO constructor parameter properties (the MCP tests load core/ under node's strip-only TS mode).
- Export schema is v2: documents.jsonl rows carry `meta: ChunkMeta` so the MCP ranks and filters like the plugin. Old exports are refused; re-run "Seek: Export complete MCP index".
- MCP loads `<vault>/.obsidian/plugins/seek/data.json` (same migrate+merge as the plugin) and `.obsidian/types.json` (numeric props) so the bot ranks with the human's settings.

## Decisions I made that he has not confirmed
- Vectors are OPT-IN (`includeVectors` / CLI `--vectors`), default off, on search, fetch_chunk and fetch_note. He wants vectors available as machine-native data (diagnostics; a future architecture feeding latent vectors straight into a model). He may want the default on. One-line flip in mcp/src/server.ts and cli.ts.
- fetch_chunk/fetch_note do not return the `meta` blob. Hits carry `snippet`, `signals`, `mtime`.
- Hybrid `pathPrefix` filters after ranking (over-fetch 100). Vector-only applies it before ranking.
- In runSearch, the BM25 index handle is captured once after prepareBm25 (the original re-read the live field at the end). Differs only if the cache is invalidated mid-search.

## Next work (ask him which first)
A. (PARTLY DONE) SearchOrchestrator indexing/delta/reindex logic behind ports. Done and in core/: delta.ts (computeDelta, rules, chunksFor), file-diff.ts, apply-delta.ts, embed-commit.ts (whole write pass), index-types.ts. Remaining in src/search.ts: reindexAll/reindexAllInner, reindexDelta, reconcileIdentityInPlace, sweepOrphanChunks, compaction, sidecar hydrate/dedup/carry-over, emitProgress. (ensureFrame/ensureBinaryIndex and all other cache methods are now DONE: `core/resident-index.ts` `ResidentIndex`, ports in `residentPorts()` in src/search.ts; src/search.ts keeps one-line proxies.) The plugin side supplies each port via `embedCommitCtx()`, `searchHost()`, and inline ctx objects. This is what gives the MCP WRITE access to the index; he wants human and bot both able to read and write. The on-disk format is the shared contract, so ASK before changing it.
B. Sidecar hydration, BM25 persistence (tryLoadPersistedBm25, cross-device), reconcile logic.
C. Embedder runtime: src/embedder.ts and iframe-runner.ts versus mcp/vendor/seek/src/* (pinned copies with 2-6 lines of drift each). None of the plugin originals import `obsidian`, so the MCP could import them directly. Needs his phone to test.
D. Plugin exporter always writes `Seek Index/MCP Export` even when the index lives under `.obsidian/plugins/seek/index` (the MCP resolver checks hidden first, then visible).
E. His original Seek complaints: could not delete vectors held in IndexedDB; desktop-to-mobile sync never worked (built for iCloud/Obsidian Sync; he wants Syncthing).
F. Housekeeping: mcp/ docs still describe the old two-repo layout and /workspaces/Obsidian-Seek; HANDOFF.md in mcp/ is stale; Obsidian-Seek-MCP repo's fate undecided (now just a pointer).

## Provenance (READ PROVENANCE.md)
Every lifted function needs a `// fork <tag> src/FILE.ts:LINE Class.method` pointer, pinned to tag line numbers (find them with `git show 1.1.3:src/search.ts | grep -n`). A new file without pointers is unmaintainable for the next upstream merge. Do this in the same commit as the move. Never rename a moved function or field (the grep-by-original-name mapping is the point); rename only with a real reason and say why in the pointer comment.

## How to work here
- Moves: `git mv src/x.ts core/x.ts`, then write the shim. Then run `npx tsc --noEmit -p tsconfig.core.json` and fix what it names.
- Scripted extractions (like search() into engine.ts): VERIFY with a normalized diff against the original (`git show 9bd8c25:src/search.ts`). That was how every substitution was confirmed mechanical.
- Checks: `npm run typecheck`, `npm test`, `npm run test:mcp`, `npm run build`, `npm run build:mcp`. `main.js` is tracked: `git checkout main.js` after building; never commit a rebuilt one.
- Commit trailers: Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com> and the Claude-Session line from the system reminder. Work on branches, not main.
- Seek-derived code keeps upstream attribution (NOTICE.md).
- A stop hook may report "unpushed commits, no remote branch"; check `git ls-remote --heads origin monorepo-core` before believing it.
