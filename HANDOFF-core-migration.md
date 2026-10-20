# Handoff: Seek core migration (read this fully before touching anything)

## Working with Emmanuel
- Casual, profane, wants results, but explicitly wants you to SLOW DOWN and ASK when a decision is his. He is on a free plan with limited usage windows, so commit and push after every step.
- Terse code, short purpose-laden names. Comments say WHY, never what.
- Tone: recovery and optimism. No self-flagellation after a mistake; state it, fix it, move on.
- LESSON FROM THIS SESSION: items in a handoff (including the "known gaps" in the previous one) are suggestions, not orders. Anything that REMOVES behavior needs his confirmation first. I stripped vectors from MCP output because a gap said to; he wanted them. Prefer opt-in flags over deletion.
- Never claim "typechecks clean" without running `npm run typecheck` (root tsc + core tsc + the MCP's own tsc). I once ran only part of it and missed a real error.

## State (updated 2026-10-19, head 23d79f8, branch monorepo-core, pushed)
- Verified: `npm run typecheck`, 1266 plugin tests, 17 MCP tests, both builds. Never run: real Obsidian, phone, release.yml, Chromium/Termux embed (use `mcp/device-tests/embed-smoke.ts`).
- Whole writer half of SearchOrchestrator, sidecar cluster, identity, model-registry, IndexStore contract (`core/index-store.ts`), `core/child-script.ts` are in core. `mcp/vendor/seek/src` is gone.
- Bot host: `mcp/src/bot-host.ts` (BotHost = Node twin of SearchOrchestrator), `node-index-store.ts` (memory + snapshot in the MCP state dir, never the vault), `node-file-adapter.ts`, `bot-embedder.ts`, `base.ts` (state dir, `bot-xxxxxxxx` device id, vault lister, logger). Tests: `mcp/test/bot-host.test.ts` (index, delta, cross-bot hydrate with zero embeds).
- Parity gaps: `.base` files not indexed by the bot (needs a YAML parser); link dictionary is a no-op on the bot.

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

## Next work
1. DONE: MCP write tools `index_vault`, `index_delta`, `hydrate_sidecar`, `compact_sidecar` (mcp/src/bot-session.ts, server.ts). STILL TODO: search/fetch still read the export snapshot, not the bot's live store, so a bot write is not searchable until the read side is pointed at ResidentIndex over the NodeIndexStore; CLI has no write commands yet.
2. Syncthing hydration bug: needs the phone's `seek-log-<deviceId>.ndjson` lines (sidecar-hydrate, version-gate-refused, tokenBudget). Repro on Node with late/out-of-order shards and `.syncthing.*.tmp` files. Ask before any on-disk format change.
3. Run embed-smoke on the phone; fix PARITY.md (stale); MCP docs still describe the two-repo layout; plugin exporter path (item D).
4. Unit tests after placement is done (his methodology).

## Provenance (READ PROVENANCE.md)
Every lifted function needs a `// fork <tag> src/FILE.ts:LINE Class.method` pointer, pinned to tag line numbers (find them with `git show 1.1.3:src/search.ts | grep -n`). A new file without pointers is unmaintainable for the next upstream merge. Do this in the same commit as the move. Never rename a moved function or field (the grep-by-original-name mapping is the point); rename only with a real reason and say why in the pointer comment.

## How to work here
- Moves: `git mv src/x.ts core/x.ts`, then write the shim. Then run `npx tsc --noEmit -p tsconfig.core.json` and fix what it names.
- Scripted extractions (like search() into engine.ts): VERIFY with a normalized diff against the original (`git show 9bd8c25:src/search.ts`). That was how every substitution was confirmed mechanical.
- Checks: `npm run typecheck`, `npm test`, `npm run test:mcp`, `npm run build`, `npm run build:mcp`. `main.js` is tracked: `git checkout main.js` after building; never commit a rebuilt one.
- Commit trailers: Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com> and the Claude-Session line from the system reminder. Work on branches, not main.
- Seek-derived code keeps upstream attribution (NOTICE.md).
- A stop hook may report "unpushed commits, no remote branch"; check `git ls-remote --heads origin monorepo-core` before believing it.

## Decisions and how to work (added 2026-10-20)
- Goal: one codebase, two interfaces (human = Obsidian plugin, bot = MCP on Termux). "If the human has an ability, the bot must have it, and the reverse." Placement first (right function, file, name); unit tests come after, per his methodology. The current code is "the blueprint".
- Mirror means the same CONTRACT and method names (`core/index-store.ts`, BotHost mirrors SearchOrchestrator), not the same bytes or directories. He said exact parity of storage is "too far" and left the choice to me.
- The bot's IndexedDB-equivalent is `NodeIndexStore`: memory plus a snapshot in the MCP's own state dir (`$SEEK_MCP_STATE`, else `$XDG_STATE_HOME/seek-mcp/`, else `~/.local/state/seek-mcp/`, plus a vault-path hash). Never inside the vault. Device id `bot-xxxxxxxx` lives there too. The sidecar (`.obsidian/plugins/seek/index`) is the shared human-bot interface ("SaaI").
- Provenance: keep the `// fork 1.1.3 src/FILE.ts:LINE Name` pointers on moved/new functions (see PROVENANCE.md). He decided against pointer stubs in `src/` that point back to core; the PROVENANCE.md lookup is enough. Never rename or refactor a moved function or field; move verbatim with substitutions only, and verify with a normalized diff against `git show HEAD:src/search.ts`.
- Core constraints: no obsidian/DOM/Node imports, explicit `.ts` import suffixes, no constructor parameter properties (the MCP loads core under node strip-only TS).
- Ask him before: any on-disk format change, or anything that removes behavior (prefer opt-in flags).
- Working style: casual, profane, wants results, no self-flagellation after a mistake. Free plan, so commit and push after each step and keep reads small. Always `git checkout main.js` after building. Run `git fetch origin monorepo-core` before pushing; the "repository moved" warning is harmless. Don't claim "typechecks clean" without `npm run typecheck`.
- The Syncthing analysis (candidate causes for hydrate being ignored on the phone, ~7h re-embed) lives only in the earlier transcript: /root/.claude/projects/-home-claude/726eaa38-77bc-5b1f-8c85-1f80eb02b41b.jsonl (if the container still exists). Needs the phone's seek-log-<deviceId>.ndjson lines: sidecar-hydrate, version-gate-refused, tokenBudget.
- The sandbox cannot reach jsdelivr or Hugging Face (403), so the embed path can only be exercised on the user's phone: `SEEK_CHROMIUM_PATH=$(which chromium) node --experimental-strip-types mcp/device-tests/embed-smoke.ts`.
