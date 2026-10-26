# Provenance: where our code came from upstream

## Philosophy
Upstream is immutable and we’ve diverged, so an upstream update has to be ported through the diff of their changes combined with the diff of ours, which is approximate. To make that mapping cheap, keep the fork recognizable. Don’t rename or refactor. Move only when needed, and tag every moved or new function with its origin or “new”.

Upstream is ryan-manor/Obsidian-Seek. We forked at tag `1.1.3` (1f0a9b0). Every pointer below is pinned to that tag, so line numbers never drift.

- `// fork 1.1.3: whole file moved from src/X.ts` at the top of a file: the file moved as-is. `src/X.ts` is now a re-export shim.
- `// fork 1.1.3 src/X.ts:LINE Name` above a function: lifted from there. `Class.method` means it was a method.
- `// fork 1.1.3 new; relates to src/X.ts:LINE Name` above a function: ours, but it does the job an upstream piece did (or wraps it). Look there first when upstream changes that piece.
- No `fork` comment: ours, no upstream counterpart.

Porting an upstream change: `git diff 1.1.3 ryan/main`, then for each touched function run `grep -rn "src/FILE.ts:.* NAME" core/` to find where it lives here.

Add the comment whenever code is moved. Keep original names; if a name must change, the pointer is what keeps the mapping.

## Versioning

Our releases are `<upstream version>.99.<n>`: Ryan's current version, then `99`, then our own counter. Example: `1.2.1.99.5` is our fifth release, built on upstream 1.2.1. (`1.2.1.99.4` was never published; `n` only counts versions that shipped.)

- The first three segments say which upstream state the code was last merged with (see the merge table below). When an upstream sync lands, the prefix moves (`1.2.2.99.6`) and `n` keeps counting; it never resets, so our releases stay in order across syncs.
- `99` marks it as ours. A five-part version can never equal one of Ryan's three-part tags, so releases cannot collide.
- `manifest.json` `version` is the single source of truth, and the git tag and GitHub release must equal it exactly (Obsidian and BRAT match on that, no leading `v`).
- It is not valid semver, so `npm version` cannot set it. Run `node version-bump.mjs <version>` (updates `manifest.json` and `versions.json`), tag by hand, and leave `package.json` at the upstream base. The plugin only compares the string for equality (index records, `classifyFileDelta`), so nothing parses it.
- Unverified: whether BRAT accepts a five-part version. If it refuses to install or update, fall back to a semver-legal form that still carries the same information (`1.2.1-99.4` sorts below 1.2.1, `1.2.1+99.4` ignores the suffix when comparing) and record the change here.

## Upstream merges

Each upstream sync is a real merge commit with `ryan/main` as second parent, so `git log --graph` shows it and `git rev-list --count HEAD..ryan/main` returns 0 afterwards. Because our tree is restructured, the merge uses `-s ours` and the upstream changes are ported by hand into that same commit (git cannot carry a diff across a moved function). Do the port first, commit last: the merge commit asserts that every upstream change is accounted for.

Procedure: `git merge -s ours --no-commit ryan/main`, then port `git diff <last-merged-tag> ryan/main` using the pointers above, then `npm run typecheck && npm test && npm run test:mcp`, then commit. Next sync diffs from the new baseline, not 1.1.3. Pointers stay pinned to 1.1.3 line numbers and are found by function name, so they remain valid.

| Date | Upstream | Notes |
|------|----------|-------|
| 2026-10-17 | 1.2.0, 1.2.1 (`b2cb183`) | Pause/resume indexing (`embed-commit`), link-dictionary synonyms v2 (`apply-delta`, `engine`, `core/link-dict.ts`), `RecencyOverride` renamed `SearchOverride`, `ExperimentOverride` added. |

Files born after the fork point carry `// fork 1.2.1 ...`. `src/link-dict.ts` is split: the pure half is `core/link-dict.ts`, the Obsidian-reaching miners stay in `src/link-dict.ts`.
