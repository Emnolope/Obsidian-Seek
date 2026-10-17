# Provenance: where our code came from upstream

Upstream is ryan-manor/Obsidian-Seek. We forked at tag `1.1.3` (1f0a9b0). Every pointer below is pinned to that tag, so line numbers never drift.

- `// fork 1.1.3: whole file moved from src/X.ts` at the top of a file: the file moved as-is. `src/X.ts` is now a re-export shim.
- `// fork 1.1.3 src/X.ts:LINE Name` above a function: lifted from there. `Class.method` means it was a method.
- `// fork 1.1.3 new; relates to src/X.ts:LINE Name` above a function: ours, but it does the job an upstream piece did (or wraps it). Look there first when upstream changes that piece.
- No `fork` comment: ours, no upstream counterpart.

Porting an upstream change: `git diff 1.1.3 ryan/main`, then for each touched function run `grep -rn "src/FILE.ts:.* NAME" core/` to find where it lives here.

Add the comment whenever code is moved. Keep original names; if a name must change, the pointer is what keeps the mapping.

## Upstream merges

Each upstream sync is a real merge commit with `ryan/main` as second parent, so `git log --graph` shows it and `git rev-list --count HEAD..ryan/main` returns 0 afterwards. Because our tree is restructured, the merge uses `-s ours` and the upstream changes are ported by hand into that same commit (git cannot carry a diff across a moved function). Do the port first, commit last: the merge commit asserts that every upstream change is accounted for.

Procedure: `git merge -s ours --no-commit ryan/main`, then port `git diff <last-merged-tag> ryan/main` using the pointers above, then `npm run typecheck && npm test && npm run test:mcp`, then commit. Next sync diffs from the new baseline, not 1.1.3. Pointers stay pinned to 1.1.3 line numbers and are found by function name, so they remain valid.

| Date | Upstream | Notes |
|------|----------|-------|
| 2026-10-17 | 1.2.0, 1.2.1 (`b2cb183`) | Pause/resume indexing (`embed-commit`), link-dictionary synonyms v2 (`apply-delta`, `engine`, `core/link-dict.ts`), `RecencyOverride` renamed `SearchOverride`, `ExperimentOverride` added. |

Files born after the fork point carry `// fork 1.2.1 ...`. `src/link-dict.ts` is split: the pure half is `core/link-dict.ts`, the Obsidian-reaching miners stay in `src/link-dict.ts`.

## Resident caches (2026-10-17)

`core/resident-index.ts` (`ResidentIndex`) holds what were SearchOrchestrator's cache fields and methods: frame, binary index, BM25 + persist/cross-device, synonyms/phrases, warm, invalidate. Its header lists the field renames. Orchestrator members of the same names are now one-line proxies (`src/search.ts`, "Cache layer lives in core/resident-index.ts"). To port an upstream change to any of those methods, grep `core/resident-index.ts` for its `fork` pointer.
