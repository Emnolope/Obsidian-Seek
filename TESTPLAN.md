# Seek test pathway: paired human and bot specifications

Status: specification only. The two scripts in `tests/device/` (section 1) predate the rules below and must be rewritten to follow them (see "Known violations").

## Read this first: the three rules

### 1. We test against a REAL vault

Not a fixture, not a copy, not a temp directory. The vault under test is the user's actual vault (the music vault, the main vault, whichever is passed). A fixture vault proves the code works on notes written to make it work. A real vault has the notes that break things: odd filenames, giant files, empty files, nested folders, broken frontmatter, thousand-link hubs.

- **Bot:** the vault path is a required argument (`--vault <dir>`). No default. No "seeding". If it is missing, the script prints a usage line and exits non-zero. It never silently falls back to a temp dir.
- **Human:** the test runs in whatever vault is open. The first line printed is the vault name, the file count, and the plugin version, so the person can see it is the vault they meant.
- **Expected values come from the vault, not from a file written beforehand.** Because nobody can hand-write the expected answer for 5,600 notes, each test gets its oracle one of four ways, and says which:
  1. **Dumb recomputation:** the test recomputes the answer with the simplest possible independent code (walk the folder, hash the bytes, count the lines) and compares it to the code under test.
  2. **Cross-side parity:** the human and bot results for the same vault must be equal. Neither is trusted alone; disagreement is the signal.
  3. **Round trip / invariant:** what goes in comes out (index a note, fetch it, get the same text back; embed twice, get the same vector).
  4. **Deterministic picks:** the test chooses real notes by a fixed rule (see "Sample set") and prints which ones it chose, so both sides and every rerun use the same notes and a human can open them.
- **Writes are declared.** Every tier is marked `READ-ONLY` or `WRITES`. A `WRITES` tier prints, before it does anything, the exact locations it will write: the plugin's IndexedDB, the bot's state directory (outside the vault), the sidecar under `.obsidian/plugins/seek/index` (inside the vault, and synced if the vault syncs), and `Seek Test/` for result files. Nothing else in the vault is created, edited or deleted by a test. Tests never modify user notes; the edit/rename/delete tests operate on a throwaway note the test itself creates under `Seek Test/` and removes afterwards.

### 2. Tests are LOUD

The point of these tests is diagnosis: we do not know which parts of the code work. A test that prints "ok" or returns `undefined` tells us nothing. Every test, on both sides, must:

- **Announce itself** before running: id, title, the one-sentence capability it proves, what it needs, and (in one line) what it does **not** prove.
- **Print every step** as it happens, with the real values: the path being read, the number of bytes returned, the first 5 items of any list (plus the total), the vector's first 4 floats and its norm, the score of each hit. Counts alone are not evidence.
- **Print every assertion** as its own line: `assert <what>  expected=<x>  actual=<y>  PASS|FAIL`. A failing assertion does not stop the test; all assertions in the test run, so one failure shows every consequence.
- **Never swallow an error.** A thrown error prints the message, the stack, and the inputs that caused it, and marks the test FAIL. Nothing is `catch {}` without printing.
- **Report one of four outcomes**, never silence:
  - `PASS`
  - `FAIL` (with the failing assertions repeated in the summary)
  - `BLOCKED` (a precondition is unmet; the line names which one, e.g. `BLOCKED: index has 0 chunks, run L7.2 first`)
  - `SKIP` (not applicable on this platform, with the reason)
  A gate that is not met is `BLOCKED`, never a pass and never a fail. This is what keeps "search a vault with zero embeddings" from producing a meaningless result.
- **Time itself** (milliseconds per test, and per step for anything over 100 ms).
- **Print a header** at the start (versions, platform, vault name and path, file count, bytes, device id, index chunk count, model status, state dir) and a **summary** at the end (counts per outcome, a list of every FAIL and BLOCKED with the first failing assertion, total time).
- **Never return `undefined`.** The runner returns the full results object and, as its last printed line, a one-line verdict: `RESULT: 14 pass, 2 fail, 5 blocked, 0 skip (see failures above)`. The bot exits non-zero on any FAIL. BLOCKED also exits non-zero unless `--allow-blocked` is passed, because a blocked run proves nothing about what it blocked.
- **Be verbose by default.** Quiet is the opt-in (`--quiet`), never the default.
- **Write the whole log** to a file (`Seek Test/<run>.log` and `.json`; for the bot, the same names in the current directory) in addition to the console, so a result can be pasted back whole.
- **Prove the harness can fail.** Every run starts with `L0.0 canary`: one assertion that is deliberately false, expected to be reported as FAIL. If the canary is reported as PASS, or the run does not show a FAIL line for it, the harness itself is broken and the rest of the run is not to be trusted.

### 3. Order: low level to high level, each tier only uses tiers below it

Running a search is not one operation. It sits on top of: reading files, parsing them, cutting them into chunks, loading a model, turning chunks into vectors, storing the vectors, building a lexical index, and only then ranking. Each of those can be broken independently. So the tiers go from the bottom up, and a test in tier N may only depend on things proven in tiers below N. If a lower tier fails, the tests above it that depend on it are reported `BLOCKED`, not run.

The consequence for a vault with **no embeddings** (the music vault today): tiers L0 to L6 can all be run and passed. L3 will print that the index is empty. L7 (the first indexing) creates the embeddings. Only after L7 do the dense-search tiers have anything to search; before that they report `BLOCKED: index has 0 chunks`. Lexical (BM25) search is different: it needs chunks but no embeddings, so it is proven in L5, before the model is even loaded.

---

## Shared definitions

**Human harness:** in the Obsidian developer console, `const S = app.plugins.plugins['seek']`; the orchestrator is `S.orchestrator` (private in TypeScript, reachable at runtime). Tests are one pasted script exposing `SeekTest.run(levels)`.
**Bot harness:** Node on Termux (`--experimental-strip-types`), importing `BotHost` / sessions from `mcp/src`, plus one stdio client for protocol tests. `--levels L2,L3` selects tiers.
**Same-language rule:** both halves are written in the same language so a spec translates line for line.
**Parity check** (marked `Parity:`): the test writes its observed JSON; `compare` diffs the human and bot files and reports every difference.

### Sample set (deterministic picks from the real vault)

Many tests need "a note". Both sides choose by the same rule and print the choices:

| Name | Rule (sorted by path, code-unit order) |
| --- | --- |
| `small` | the first note of at least 200 and at most 2,000 bytes |
| `large` | the largest note, by bytes |
| `linky` | the note with the most `[[links]]` |
| `unicode` | the first note whose path contains a non-ASCII character (or SKIP) |
| `spaces` | the first note whose path contains a space |
| `deep` | the note with the deepest folder nesting |
| `empty` | the first zero-byte `.md` file (or SKIP) |
| `fenced` | the first note containing a code fence (or SKIP) |
| `base` | the first `.base` file (or SKIP) |
| `props` | the first note with frontmatter containing a list and a number (or SKIP) |
| `sample20` | 20 notes: `small`, `large`, `linky`, and the rest taken evenly across the sorted list |

A `SKIP` names the rule that found nothing. Real vaults may not contain every case; that is information, not an error.

---

## L0: Identity and harness (READ-ONLY, no vault access)

**L0.0 Canary.** One deliberately false assertion; must be reported FAIL, and the run's verdict must say so. *Proves:* the harness reports failures loudly.

**L0.1 Runtime identity.**
- H: Obsidian version, platform (mobile/desktop), plugin `manifest.version`, `S` truthy, `S.orchestrator` truthy (not "still loading"), commit/build marker if embedded.
- B: Node version, platform, the shipped bundle exists and its size, the checkout's `manifest.json` version, whether `mcp/dist/server.mjs` loads.
- *Pass:* both name the same version string. *Parity:* version.

**L0.2 Target vault banner.**
- H and B: print the vault name, absolute path (B) or adapter base path (H), count of files by extension, total bytes, and the five largest files.
- *Pass:* the bot's `--vault` and the human's open vault are the same vault: equal file counts and total bytes (if they are deliberately different copies, the banner says so and the parity checks that follow compare like with like). *Parity:* the counts.

## L1: Process and protocol plumbing (READ-ONLY)

**L1.1 Start and stop.**
- H: disable then enable the plugin; count intervals/listeners before and after (no leak).
- B: start `server.mjs`, confirm it idles on stdin, exits cleanly when stdin closes; start it twice against one state dir without corruption.

**L1.2 Front door.**
- H: command ids (`seek:search`, `seek-export-mcp-index`) resolve in `app.commands.commands`.
- B: `initialize` returns server info; `tools/list` returns exactly the 11 expected tools with valid schemas.

**L1.3 Bad input.**
- H: search with empty string, 10,000 characters, operators only: no throw.
- B: malformed JSON, unknown method, unknown tool, missing `vaultDir`, wrong argument types: each gives a JSON-RPC error and the server stays up.

**L1.4 PicoClaw registration.**
- B: `picoclaw mcp add ... ` works and the agent lists the tools. (Human equivalent: the plugin appears in Community plugins and its settings tab opens.)

## L2: Vault read primitives (READ-ONLY, the "just read files" tier)

**L2.1 Enumerate.**
- H: every file the plugin lists. B: every file the bot lists.
- *Oracle:* dumb recomputation (walk the folder with plain code, skip dot-folders) plus parity.
- *Pass:* identical path sets; counts match L0.2.

**L2.2 Read bytes.**
- H and B: read every `sample20` note, print byte length and SHA-256 of each.
- *Oracle:* a hash computed by an independent tool (`sha256sum` on B; the same hash on H via `crypto.subtle`). *Parity:* hashes.

**L2.3 Path handling.**
- H and B: for `unicode`, `spaces`, `deep`: path from the listing equals the path used to read it, is NFC-normalized, and reads back non-empty. Android returning NFD names is the specific risk.

**L2.4 Empty and large.**
- H and B: `empty` reads as `''` (not an error); `large` reads in full and its length equals its byte count.

**L2.5 Frontmatter and properties.**
- H: Obsidian's parsed properties for `props`. B: the bot's parse. *Parity:* normalized property maps.
- Numeric properties typed per `.obsidian/types.json`.

**L2.6 Links.**
- H: `metadataCache` links for `linky` and `fenced`. B: `scanWikiLinks`. *Pass:* same targets; none from inside code fences or frontmatter.

**L2.7 Base files.**
- H and B: `base` extracted with each side's YAML parser; also the name-only fallback when YAML is unavailable. *Parity:* extracted documents.

**L2.8 Excluded files.**
- H: `metadataCache.isUserIgnored` over every path. B: `matchUserIgnoreFilters` over `.obsidian/app.json` `userIgnoreFilters`.
- *Pass:* the plugin API, the core fallback matcher, and the bot agree on every path. Print every disagreement.

**L2.9 What the indexer would take.**
- H: `indexableFiles` filtered by `shouldIndex`. B: the same two functions on `BotHost`.
- *Pass:* the sets are equal. Print the count and the first and last five. This is the list every later tier is built from.

## L3: Configuration and state (READ-ONLY)

**L3.1 Settings load.**
- H: `data.json` migrates, merges with defaults; print the effective settings. B: the same file through the same migrate+merge.
- *Parity:* effective settings JSON.

**L3.2 Identity.**
- H: plugin device id stable across a reload. B: `bot-xxxxxxxx` stable across a restart and stored in the state dir, **not** in the vault.

**L3.3 Cold index report (the empty-vault test).**
- H: `getIndexStats`. B: `index_stats`. Print every field.
- *Pass:* no throw, same shape. If counts are zero this test **passes** and prints `INDEX EMPTY: dense search, hydrate and fetch tiers will be BLOCKED until L7 runs`. This is how a vault with no embeddings (the music vault) is recognized up front, instead of failing mysteriously in search.

**L3.4 Model status report.**
- H: `getModelStatus`. B: `model_status`. Print every field and the heuristic inputs (bytes found).

**L3.5 State directory.**
- B: the state dir exists, is writable, is outside the vault, and survives a restart. H: IndexedDB opens, a probe write/read/delete round-trips.

## L4: Pure transforms on real notes (READ-ONLY, no model, no store)

**L4.1 Tokenizer.** H and B: tokenize `sample20`; print token counts. *Parity:* counts per note.

**L4.2 Chunker.** H and B: chunk `sample20`, including `fenced`, `large`, `empty`.
- Print chunks per note, first 80 characters of the first and last chunk.
- *Oracle:* invariants: concatenated chunk text covers the note's non-whitespace content; no chunk exceeds the token budget except documented atomic blocks (oversize fence/table); `empty` yields zero chunks.
- *Parity:* chunk count and chunk text hashes per note.

**L4.3 Chunk ids.** Stable across two runs, unique across the sample. *Parity:* ids.

**L4.4 Token budget.** `large` is split, not truncated silently. Print how.

**L4.5 Query parser.** Plain text, quoted phrase, `#tag`, `path:`, `[key:value]`, `before:`/`after:`, unknown operator, trailing operator. Print the parsed object for each. *Parity:* parsed objects.

**L4.6 Property typing and tag grammar.** Tags with nesting and unicode, numeric and date properties normalize the same way on both sides.

**L4.7 Link dictionary build.** Over `sample20`, build the link/synonym dictionary. *Parity:* entries.

## L5: Lexical retrieval (READ-ONLY, needs L4, needs no embeddings)

All of this runs on in-memory chunks of `sample20`, with no store and no model. It proves the half of search that does not depend on vectors.

**L5.1 Build BM25.** Build the lexical index from the L4.2 chunks. Print document count, term count.

**L5.2 Known-answer lexical hit.** For three notes of `sample20`, take a rare word from the note (chosen by the test: the term with the lowest document frequency that appears in only that note) and query it. *Pass:* that note is the top hit. Print the top 5 with scores. *Parity:* ranked lists.

**L5.3 Phrase and operator filters.** `#tag`, `path:`, `[key:value]`, `before:`/`after:` over the in-memory chunks return exactly the notes the dumb recomputation says they should.

**L5.4 Fuzzy, title bonus, recency bonus.** Each toggle changes ranking as documented, on a constructed query from the vault's own words.

**L5.5 Empty and nonsense queries.** Return an empty result with a state flag, not an error.

## L6: The embedder (READ-ONLY on the vault; downloads and caches the model)

**L6.1 Model presence (before).** H: `getModelStatus`. B: `model_status`. Record absent or present.

**L6.2 Model load.** H: `ensureModelLoaded`. B: Chromium launch + sidecar connect. Print time and memory. A timeout prints which stage it stopped at.

**L6.3 One vector.** Embed the fixed string `"parity"` on both sides. *Pass:* 384 finite floats, L2 norm within 1e-3 of 1. Print the first 8 floats and the norm. *Parity:* cosine between the two sides' vectors ≥ 0.999. This is the single most important number in the project: if it is low, nothing downstream can agree.

**L6.4 Determinism.** Embed the same string three times; identical vectors.

**L6.5 Batch vs single.** 20 chunks from `sample20` embedded as one batch and one by one: equal within tolerance, order preserved.

**L6.6 Query vs passage conventions.** Embed one query and one passage with the model's rules; both sides apply the same prefix (cosine ≥ 0.999).

**L6.7 Semantic sanity.** Embed three real chunks: two from one note, one from an unrelated note. The two same-note chunks are more similar to each other than to the third. Print the similarity matrix.

**L6.8 Restart persistence.** Reload the plugin / restart the server twice. *Pass:* the model is not downloaded again. Print bytes downloaded each time. (Known open question: the bot's sidecar binds a random port, so the Chromium origin and Cache API may change each run.)

**L6.9 Failure and recovery.** Kill the embedder mid-embed; the next call recovers. Print the recovery path taken.

**L6.10 Model status (after).** `model_status` flips to present on both sides.

## L7: The index store and the first indexing (WRITES: plugin IndexedDB, bot state dir)

Everything above this line had no side effects on any index. L7 is where embeddings first come into existence. This tier is the gate for everything that searches vectors. Print the write locations before starting.

**L7.1 Store contract with synthetic vectors.** H: plugin store. B: `NodeIndexStore`. Put, get, delete by path, count, iterate, tombstone, close, reopen, read back. Uses made-up 384-d vectors so the store is tested without the model. *Pass:* both satisfy the same `IndexStore` contract.

**L7.2 Store failure modes.** H: failed IndexedDB open triggers open-recovery; version upgrade. B: corrupt snapshot, truncated snapshot, missing state dir each recover to empty with a logged reason.

**L7.3 Atomic per-file commit.** Interrupt a commit (throw between chunk write and meta write); the file is either entirely old or entirely new. `verifyCoherent` true.

**L7.4 Index `sample20` only.** H: index just those 20 notes. B: the same 20 via the bot's pass. Print per-file chunk count, embed time, total time. *Pass:* chunk counts equal L4.2; vectors equal across sides (cosine ≥ 0.999 per chunk). *Parity:* per-note chunk counts and ids.

**L7.5 Stats after sample.** `index_stats` / `getIndexStats` report exactly the 20 notes and the chunk total from L7.4; the empty-vault warning from L3.3 no longer fires.

**L7.6 Full index (explicit, long, optional per run).** The whole vault. Print progress every 100 files, ETA, memory. Not run by default; selected with `--full-index`. *Pass:* chunk total equals the sum of L4.2-style chunking over every indexable note (dumb recomputation), `verifyCoherent` true, ignored files contribute zero.

## L8: Index maintenance (WRITES: index, plus a throwaway note under `Seek Test/`)

**L8.1 Coherence check.** `verifyCoherent` after every L7/L8 test; corrupt a BM25 frame stamp deliberately and confirm drift recovery repairs it.

**L8.2 No-op delta.** With no changes, zero embeds, zero writes, report says clean.

**L8.3 Edit.** Edit the throwaway note; the delta re-embeds only it; every other file's vectors are byte-unchanged.

**L8.4 Add.** Create a second throwaway note; indexed; count rises by its chunk count.

**L8.5 Rename.** Rename a throwaway note; old path gone, new path present, chunk ids per the documented rule.

**L8.6 Delete.** Delete both throwaway notes; their chunks disappear; counts return to the L7.5 numbers.

**L8.7 Incremental equals full.** After L8.3 to L8.6, the index equals a from-scratch rebuild of the same set, exactly (the sharpest incremental-correctness test).

**L8.8 Interrupted indexing.** H: pause mid-run, resume. B: kill the process mid-`index_vault`, restart. No duplicates, no lost files, coherent.

**L8.9 Orphan sweep.** Inject a chunk whose file does not exist; the sweep removes exactly it.

**L8.10 Identity heal.** A stale identity stamp is re-stamped without re-embedding.

## L9: Dense and hybrid search (READ-ONLY; GATED on the index having chunks)

**Gate:** every test here begins `needs: index.chunks > 0` (printed and checked). With an empty index every test in L9 reports `BLOCKED: index has 0 chunks, run L7.4 first`. None of them may pass or fail in that state. Queries are built from the notes L7 actually indexed.

**L9.1 Dense primitives.** Cosine of a stored vector with itself is 1; with another note's vector is lower; binary-candidate stage returns a superset of the exact top-k (recall 100% on the indexed set).

**L9.2 Vector-only search.** H: `searchDense` with a stored vector as the query. B: `semantic_search` with `queryVector` (needs no Chromium). *Pass:* the source chunk is the top hit with score ≈ 1. *Parity:* ranked ids.

**L9.3 Known-answer dense hit.** Use a chunk's own first sentence, reworded by simple deterministic transformation (reverse word order of the middle clause), as the query. *Pass:* the source note ranks in the top 3. Print top 10 with signals.

**L9.4 Known-answer hybrid hit.** The rare-word query from L5.2 now through the full pipeline. *Pass:* same note on top, and the result carries BM25, dense and recency/title signals.

**L9.5 Fusion and ranking parity.** For 10 deterministic queries, full ranked lists on the human and bot sides are compared. *Pass:* identical order, or every difference explained by a documented rule (e.g. hybrid `pathPrefix` filters after ranking on the bot).

**L9.6 Filters through the full pipeline.** `#tag`, `path:`, `[key:value]`, `before:`/`after:` return exactly the dumb-recomputed set restricted to indexed notes.

**L9.7 topK and bounds.** 1, 10, 100, 101, 0, negative: schema-conformant on both.

**L9.8 No results.** Nonsense query returns empty with a clean flag.

**L9.9 Fetch.** H: chunks for a note from the store. B: `fetch_note` and `fetch_chunk`. *Pass:* round trip: the fetched text equals the L4.2 chunk text; `includeVectors` returns 384 floats; missing note/id gives a clean not-found. *Parity:* ids and text hashes.

**L9.10 Response size.** `fetch_note` of `large` and a broad search stay under the stated bound (still an open TODO).

**L9.11 Latency baseline.** p50 and p95 over 20 queries. Recorded, not asserted, until a budget is set.

## L10: The sidecar: the human/bot contract (WRITES: `.obsidian/plugins/seek/index` inside the vault; syncs if the vault syncs)

Needs a populated index on at least one side (L7.4). Print the sidecar path and whether the vault is synced before writing.

**L10.1 Human writes, bot reads.** After L7.4 the human's sidecar has a device meta and shards; the bot's reader validates every record's CRC and dimension.

**L10.2 Bot writes, human reads.** `compact_sidecar` on the bot; the human reads and validates.

**L10.3 Hydrate without re-embedding (human → bot).** Empty bot store, `hydrate_sidecar`. *Pass:* stats equal the human's; zero embeds run; L9 results equal.

**L10.4 Hydrate without re-embedding (bot → human).** Mirrored.

**L10.5 Version gate.** A sidecar with a different model revision, dimension, or older format is refused by both with the same reason and no store corruption.

**L10.6 Winner rules and tombstones.** Two devices edit/delete the same file; a tombstone arrives after the other's write; both sides resolve the same winner.

**L10.7 Export.** Human "Export complete MCP index"; the bot reads it as a snapshot; schema v2 loads, older refused with the re-export instruction; the export lands beside the native sidecar in **both** `sidecarIndexLocation` modes (known bug: expected FAIL until fixed).

**L10.8 Out-of-order and partial files (the open Syncthing bug).** Shards in reverse order, a `.syncthing.*.tmp` file, a half-written shard: no crash, no partial hydrate, a later complete arrival is picked up. Collect the `seek-log-<deviceId>.ndjson` lines (`sidecar-hydrate`, `version-gate-refused`, `tokenBudget`) alongside.

**L10.9 Peer ahead, coalesce, compact, reap.** `probePeerAhead` agrees on both sides; coalescing small shards keeps the record set identical; a dead device's sidecar is reaped and only that one.

## L11: Live behavior (WRITES: index, plus throwaway notes)

**L11.1 Live edit.** H: edit in the editor; debounce fires. B: with `SEEK_MCP_WATCH=1`, an on-disk edit triggers a delta. *Pass:* index current within the window; timing printed.

**L11.2 Live rename and delete.** As L8.5 and L8.6 but triggered by events.

**L11.3 Pause and resume.** No indexing while paused; backlog drains on resume.

**L11.4 Catch-up after offline edits.** Edit three throwaway notes with the watcher off; start it; exactly those three are indexed.

**L11.5 Periodic reconcile.** A deliberate mismatch is repaired without a full reindex.

**L11.6 Full reindex confirmation.** H: confirm dialog appears when expected, skipped with `skipConfirm`. B: the confirm port never blocks.

**L11.7 Diagnostics.** The logging report on both sides; a redacted report contains no note text.

**L11.8 Delete model.** `deleteModel` / `delete_model`; status flips; search degrades with a clear message; re-download restores.

**L11.9 Resource ceilings.** Peak memory and wall time during L7.4 and (if run) L7.6, recorded as the phone baseline.

## L12: Settings behavior (WRITES: settings file; restored at the end)

Each setting: print current value, change it, print the observable effect, restore it, assert restored. Same `data.json` change on both sides.

`indexBases`, `honorIgnoredFolders`, index location, search strategy, fuzzy matching, recency bonus, title bonus, compute backend (WASM only on the phone; "disabled after crash" flag clears), reset to defaults. *Parity:* the same settings produce the same ranking on both sides.

## L13: Human-only UI and its bot counterparts

The rule is that nothing human-only should exist without a bot equivalent. Each row tests the human feature and states the bot's counterpart; a missing counterpart is a **finding**, printed as such, not a silent skip.

| Test | Human capability | Bot counterpart |
| --- | --- | --- |
| L13.1 | Search modal: results, snippets, Enter opens the note at the chunk | `semantic_search` hit carries a snippet and a locator for the same place |
| L13.2 | Result highlighting | none: decide, add highlight ranges or declare human-only |
| L13.3 | Query field completions (`#`, `path:`) | none: decide, a `suggest` tool or declare human-only |
| L13.4 | Insert link | none: decide, a `resolve_link` tool or declare human-only |
| L13.5 | Recent searches (per device, per vault) | none: decide |
| L13.6 | Ribbon and progress notices | `index_vault` pass numbers; MCP progress notifications |
| L13.7 | Display toggles (scores, hints, Cmd/Ctrl) | UI only |
| L13.8 | Settings tab Index card | `index_stats` (verify fields equal) |
| L13.9 | Settings tab Model section | `model_status`, `delete_model` (verify) |
| L13.10 | Logging report | log stream / report tool: decide |
| L13.11 | `seek:search` companion relay | human-only (document) |

## L14: End-to-end loops (WRITES)

**L14.1 Human indexes, bot hydrates, bot searches.** Results equal the human's for the same queries.
**L14.2 Bot indexes, human hydrates, human searches.** Mirrored.
**L14.3 Concurrent edit.** Both sides index the same edit; after sync, one converged state.
**L14.4 Real MCP client.** PicoClaw asks a natural-language question about the vault through `semantic_search`; the answer cites real files that exist and contain the claimed text.
**L14.5 Installed release.** Install the plugin through BRAT and the bot from the tarball; run L0 to L9 against the installed versions, not the checkout.

---

## Order of execution

1. L0 to L3: no model, no index, minutes. Safe to run on any vault, including one with zero embeddings (L3.3 will say so).
2. L4, L5: transforms and lexical search. Still no model.
3. L6: the model (the first real-hardware unknown).
4. L7.1 to L7.5: the store and the 20-note sample index. This is the first moment embeddings exist.
5. L8, then L9: maintenance, then dense and hybrid search against the sample.
6. L10, L11, L12: sidecar, live behavior, settings.
7. L7.6 (full index), then repeat L9 on the full index, then L13, L14.

At each tier the bot runs first, then the human, then the two result files are diffed.

## Known violations in what is already written (`tests/device/`, section 1)

- It uses a fixture vault written by the script (`seed`, `--vault` defaulting to a seeded temp dir). Under rule 1 it must take a real vault, derive expectations from it (L2.1, L2.2, L2.9), and stop seeding.
- It is quiet: it prints a table of PASS/FAIL and returns no value from the console path. Under rule 2 it must print every step and assertion, return a verdict, include the canary, and write a log file.
- Its test ids (`T0.1`, `T0.2`, `T2.1`, `T2.2`, `T2.3`) map to `L0.1`, `L2.2`, `L2.9`, `L2.2`/`L2.4`, `L2.3`.

## Release note

Obsidian and BRAT install by the GitHub release whose tag **exactly equals** `manifest.json` `version`, without a leading `v`. Our versions are `<upstream>.99.<n>`, which is not valid semver; see `PROVENANCE.md` "Versioning" for how to set one and for the unverified BRAT risk. Merging branches is not required: `main` and `monorepo-core` are the same commit.

## Open decisions

- L13: for each counterpart marked "decide", add the capability or declare it human-only.
- L10.7: fix the exporter location bug, or keep the test as an expected failure.
- L6.8: if the model re-downloads on every bot start, the sidecar port must be made stable.
- `includeVectors` default on or off is still unconfirmed.
- Whether L7.6 (full index of a 5,600-note vault on the phone) is run on-device or hydrated from the human's index (L14.1). The earlier estimate for a full re-embed on the phone was about seven hours.
