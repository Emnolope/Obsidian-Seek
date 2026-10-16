# Provenance: where our code came from upstream

Upstream is ryan-manor/Obsidian-Seek. We forked at tag `1.1.3` (1f0a9b0). Every pointer below is pinned to that tag, so line numbers never drift.

- `// fork 1.1.3: whole file moved from src/X.ts` at the top of a file: the file moved as-is. `src/X.ts` is now a re-export shim.
- `// fork 1.1.3 src/X.ts:LINE Name` above a function: lifted from there. `Class.method` means it was a method.
- No `fork` comment: ours, no upstream counterpart.

Porting an upstream change: `git diff 1.1.3 ryan/main`, then for each touched function run `grep -rn "src/FILE.ts:.* NAME" core/` to find where it lives here.

Add the comment whenever code is moved. Keep original names; if a name must change, the pointer is what keeps the mapping.
