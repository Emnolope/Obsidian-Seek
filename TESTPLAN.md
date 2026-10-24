# Seek test pathway: paired human and bot specifications

Status: specification only. No test code exists for anything below. Each entry says what to build, how to run it, and what a pass proves.

## Why this exists

The sandbox suites (`npm test`: 1266 plugin tests, `npm run test:mcp`: 25) prove the logic under Node with fakes. They have never run on a phone, in real Obsidian, through a real MCP client, or through the Chromium embed. This pathway closes that gap, one component at a time, with the human half and the bot half of every capability tested together.

Principle: if the human can do it, the bot can do it, and the reverse. A capability is only "at parity" when both halves pass the same spec against the same fixture vault and produce comparable output.

## How the tests run

| | Human (H) | Bot (B) |
| --- | --- | --- |
| Where | Obsidian developer console (Mobile: use the remote or in-app console) | Node on Termux, same language (TypeScript/JS), and one stdio client |
| Handle | `const S = app.plugins.plugins['seek']`, the orchestrator is `S.orchestrator` (private in TS, reachable at runtime) | `BotHost` / session objects from `mcp/src`, plus the built `mcp/dist/server.mjs` over stdio |
| Output | Each test returns `{id, pass, observed, expected}` as JSON | Same shape |
| Comparison | A test with a **Parity check** line writes its observed JSON to the vault under `Seek Test/<id>.<h|b>.json`; the other half's run diffs against it | same |

Every test is independent and idempotent except where it lists `Needs:`. Stop a tier at its first failure; later tiers assume earlier ones.

## Fixture vault (shared by every test)

One small vault, committed to the repo under `tests/fixture-vault/`, copied identically to the phone's Obsidian vault (human) and the bot's vault dir. Nothing else is indexed during testing.

| File | Purpose |
| --- | --- |
| `a/alpha.md` | Frontmatter (`tags`, a text key, a numeric key, a date), two headings, one `#tag` in body, one `[[beta]]` link |
| `b/béta note.md` | Spaces and unicode in the path; one paragraph; links back to `[[alpha]]` |
| `c/gamma.md` | A fenced code block containing `[[not-a-link]]`, a `[[alpha]]` link outside it, an embed `![[beta]]`, a table, a callout |
| `c/oversize.md` | A table and a fence each larger than one chunk, to force splitting |
| `d/empty.md` | Zero bytes |
| `d/notes.base` | A Base file with filters (needs `yaml`) |
| `ignored/secret.md` | Matched by `.obsidian/app.json` `userIgnoreFilters` (`ignored/`) |
| `.obsidian/app.json` | The ignore filter above |
| `.obsidian/types.json` | Declares the numeric key as a number |
| `.obsidian/plugins/seek/data.json` | Known non-default settings (e.g. `indexBases: true`, a title bonus) so config loading is observable |

`GOLDEN.json` is produced once by the human side's first clean index and committed. It records chunk counts per file, total chunk count, model id and revision, dimension, and the top-3 paths for a set of fixed queries. The bot is held to it.

Fixed queries (used in tier 6): `q1` a word only in alpha; `q2` a phrase only in gamma's code fence; `q3` a paraphrase of beta with no shared words; `q4` a tag filter; `q5` a `path:` filter; `q6` a property filter; `q7` a `before:`/`after:` filter.

---

## Tier 0: Environment

**T0.1 Runtime identity**
- H: report Obsidian version, platform (mobile/desktop), plugin `manifest.version`, `S` is truthy and `S.orchestrator` is truthy (not "still loading").
- B: report Node version, platform, the bundled server version, whether `mcp/dist/server.mjs` exists and loads without throwing.
- Proves: both halves are the build under test, not a stale copy.
- Parity check: both versions come from the same commit (record the commit hash in each).

**T0.2 Fixture integrity**
- H and B: list the fixture vault, hash every file, compare to `tests/fixture-vault/MANIFEST.sha256`.
- Proves: the two halves are looking at byte-identical input. Every later difference is then a code difference.

**T0.3 Capability matrix**
- H: enumerate commands, settings sections, and orchestrator methods that exist.
- B: enumerate MCP tools, CLI verbs, and `BotHost` methods that exist.
- Proves: the parity table in `PARITY.md` matches reality. Output is a diff of the two lists against the doc.

## Tier 1: Plumbing

**T1.1 Process lifecycle**
- H: plugin disable then enable leaves no leaked intervals or listeners (`onunload` ran: count timers before/after).
- B: server starts, idles on stdin, exits cleanly on stdin close, and a second start in the same state dir does not corrupt the first.
- Proves: both halves can be started and stopped repeatedly without residue.

**T1.2 Command and protocol surface**
- H: the registered command ids (`seek:search`, `seek-export-mcp-index`) resolve through `app.commands.commands`.
- B: `initialize` returns server info; `tools/list` returns exactly the expected 11 tools with valid input schemas.
- Proves: the entry point works at all. This is each side's front door.

**T1.3 Bad input**
- H: invoking search with an empty string, with 10 000 characters, and with only operators, does not throw.
- B: malformed JSON, unknown method, unknown tool, missing `vaultDir`, wrong argument types: each returns a JSON-RPC error and the server stays up.
- Proves: neither side crashes on garbage.

## Tier 2: Vault I/O (the basic read)

**T2.1 Enumerate files**
- H: files the plugin would index, via the plugin's own `shouldIndexPath` over `app.vault.getFiles()`.
- B: the same via `vaultFiles` and `shouldIndexPath`.
- Pass: identical path set; `ignored/secret.md` excluded; `empty.md` handled per the documented rule.
- Parity check: path lists equal.

**T2.2 Read a note**
- H: read each fixture via the vault adapter, compare bytes to the manifest.
- B: `readVaultFile` for each, the same comparison.
- Pass: unicode and spaces round-trip; the empty file reads as empty, not an error.

**T2.3 Path handling**
- H and B: a path with spaces, accents, nested folders, a leading dot folder, and a very long name resolve to the right file and back.
- Proves: no normalization drift between Obsidian's paths and Node's on Android.

**T2.4 Excluded files**
- H: `metadataCache.isUserIgnored` agrees with `matchUserIgnoreFilters` on every fixture path.
- B: `matchUserIgnoreFilters` against `app.json` excludes `ignored/`.
- Pass: all three (plugin API, core fallback, bot) agree on every path. Flag any disagreement as a parity bug.

**T2.5 Frontmatter and properties**
- H: Obsidian's parsed frontmatter and `types.json` types for `alpha.md`.
- B: the bot's property parse and numeric typing of the same file.
- Parity check: normalized property maps are equal.

**T2.6 Link extraction**
- H: `metadataCache` links for `gamma.md` (the real link only, no fenced link, embed per plugin rule).
- B: `scanWikiLinks` / `link-miner` on the same file.
- Pass: both return `[[alpha]]` only. Document any divergence; the doc already says edge cases can differ.

**T2.7 Base file**
- H: the `.base` extractor output with the plugin's YAML parser.
- B: the same through `botParseYaml`; also the name-only fallback when the YAML parser is absent.
- Parity check: extracted documents equal.

## Tier 3: Storage and state

**T3.1 Cold state**
- H: `getIndexStats` on a vault never indexed returns zeros without throwing.
- B: `index_stats` on a fresh state dir returns the same zeros, same shape.
- Parity check: stats shape and zero values equal.

**T3.2 Identity**
- H: the plugin's device id exists and is stable across a plugin reload.
- B: the `bot-xxxxxxxx` id exists, is stable across a server restart, and lives in the state dir, not the vault.
- Proves: each producer keeps a stable name, which the sidecar relies on.

**T3.3 Index store contract**
- H: write chunks to IndexedDB through the plugin's store, close, reopen, read back.
- B: the same through `NodeIndexStore` including a restart.
- Pass: both satisfy the same `IndexStore` contract: put, get, delete by path, count, iterate, tombstone.

**T3.4 Store failure modes**
- H: an IndexedDB open that fails and the open-recovery path runs, and a version upgrade path.
- B: a corrupt snapshot file, a truncated snapshot, and a missing state dir each recover to an empty store with a logged reason, never a crash loop.

**T3.5 Settings and config load**
- H: `data.json` migrates and merges; defaults fill missing keys; reset-to-defaults restores them.
- B: the same `data.json` and `types.json` load through the same migrate+merge, and the bot's effective settings equal the human's.
- Parity check: effective settings JSON equal.

## Tier 4: The embedder

**T4.1 Model presence**
- H: `getModelStatus` before and after download.
- B: `model_status` before and after, with the ≥50 MB heuristic recorded.
- Pass: both report "absent" before and "present" after. Record whether the human's Cache API probe and the bot's size heuristic ever disagree.

**T4.2 Model load**
- H: `ensureModelLoaded` completes; record time and memory.
- B: Chromium launches and the sidecar connects; record time and memory.
- Pass: both complete under a stated time budget.

**T4.3 One vector**
- H and B: embed the string "parity" with each embedder.
- Pass: 384 finite floats, L2 norm within 1e-3 of 1.
- Parity check: the two vectors have cosine ≥ 0.999. This is the single most important parity number: quantization, pooling and dtype must match.

**T4.4 Embedding determinism**
- H and B: embed the same string three times.
- Pass: identical vectors each time on each side.

**T4.5 Batch vs single**
- H and B: embed 20 strings in one batch and one at a time.
- Pass: batch results equal single results within tolerance, and the batch order is preserved.

**T4.6 Restart persistence (open question)**
- H: reload the plugin; the model does not re-download.
- B: restart the server twice; record whether the model re-downloads. This checks the known concern that the sidecar's HTTP server binds a random port, so the Chromium origin and Cache API change each run.
- Pass: no re-download on either side, or a documented fix.

**T4.7 Embedder failure and recovery**
- H: kill or block the iframe runner mid-embed; the lifecycle's stall-pattern and crash recovery fire.
- B: kill Chromium mid-embed; the next call restarts it and succeeds.

**T4.8 Query-prefix and instruction handling**
- H and B: embed a query and a passage with the model's query/passage conventions.
- Parity check: both sides apply the same prefix rules (cosine ≥ 0.999 against each other).

## Tier 5: Chunking and indexing writes

**T5.1 Chunker on fixtures**
- H and B: chunk every fixture file with the same chunker settings.
- Pass: chunk count and chunk text hashes equal on both sides and equal to `GOLDEN.json`.
- Edge cases covered by the fixtures: code fence, table, callout, oversize fence, oversize table, empty file.

**T5.2 Chunk ids**
- H and B: chunk ids for each file are stable across two runs and unique across the vault.
- Parity check: id sets equal.

**T5.3 Full index (small vault)**
- H: `runFullReindex({skipConfirm: true})`.
- B: `index_vault`.
- Pass: both complete; chunk totals equal `GOLDEN.json`; `index_stats` equals on both sides; the ignored file contributes zero chunks; progress callbacks fire.
- Parity check: stats equal (except device-specific fields).

**T5.4 Index status after index**
- H: orchestrator state after the pass.
- B: `index_status` (live-store shape, `source: 'bot-store'`).
- Pass: model, revision, chunker, dimension agree and match `ACTIVE_MODEL_SPEC`. Record the shape difference between live-store status and snapshot status; it is a known inconsistency to either fix or document.

**T5.5 Delta: edit**
- H: edit one fixture, run the delta (the plugin's debounce or a forced `reindexDelta`).
- B: edit the same file, run `index_delta`.
- Pass: exactly one file re-embedded; chunk diff reuses unchanged chunks; the other files' vectors are byte-unchanged.

**T5.6 Delta: add, delete, rename**
- H and B: add a note, delete a note, rename a note, in one pass each and all together.
- Pass: the index matches a from-scratch rebuild of the final vault, exactly. This is the sharpest incremental correctness test: incremental result must equal full result.

**T5.7 Delta: no-op**
- H and B: run delta with no changes.
- Pass: zero embeds, zero writes, and the run reports clean.

**T5.8 Interrupted index**
- H: pause mid-index, resume.
- B: kill the process mid-`index_vault`, restart, run again.
- Pass: no duplicate chunks, no lost files; the atomic per-file commit leaves the store coherent (`verifyCoherent` true).

**T5.9 Coherence and drift**
- H and B: `verifyCoherent` after each tier-5 test; deliberately corrupt a BM25 frame stamp and confirm drift recovery repairs it.

**T5.10 Orphan sweep**
- H and B: inject a chunk whose file no longer exists; the sweep removes exactly that chunk.

**T5.11 Token budget**
- H and B: index a note long enough to exceed the token budget; verify truncation or splitting behaves identically.

## Tier 6: Search

All search tests run after a clean T5.3 on both sides.

**T6.1 Lexical hit**
- H: `orchestrator.search('q1')`. B: `semantic_search` with `queryText`.
- Pass: top hit is alpha on both. Parity check: top-3 path lists equal `GOLDEN.json`.

**T6.2 Semantic hit with no shared words (q3)**
- Pass: the paraphrase finds beta on both sides. This proves the dense half works, not only BM25.

**T6.3 Code-fence content (q2)**
- Pass: text inside the fence is findable on both sides, and the passage/snippet is the fence region.

**T6.4 Score signals**
- H and B: each hit carries BM25, dense and recency/title signals.
- Pass: the same signal names and the same ordering of hits for the fixed queries.

**T6.5 Fusion and ranking parity**
- H and B: for all queries q1–q7, compare full ranked lists to each other.
- Pass: identical order. If not identical, the difference must be explained by a documented rule (e.g. `pathPrefix` filters after ranking in hybrid on the bot).

**T6.6 Filters**
- H and B: `q4` (`#tag`), `q5` (`path:`), `q6` (`[key:value]`, numeric comparison using `types.json`), `q7` (`before:` / `after:`).
- Pass: each returns exactly the expected files from `GOLDEN.json`.

**T6.7 Query grammar edge cases**
- H and B: quoted phrases, negation if supported, mixed operators, unknown operator text, a trailing operator.
- Pass: the same parse (compare the parsed-query object) and no throw.

**T6.8 topK and bounds**
- H and B: `topK` 1, 10, 100, 101 (clamp or error per the schema), 0 and negative.
- Pass: schema-conformant behavior on both.

**T6.9 Vector-only search**
- H: `searchDense` with a precomputed vector. B: `semantic_search` with `queryVector`.
- Pass: exact cosine ranking equal on both; the bot needs no Chromium for this.

**T6.10 Empty index and no results**
- H and B: search before any index; search for nonsense.
- Pass: empty result with a clean state flag, no throw.

**T6.11 Fetch**
- H: read chunks for a note via the store. B: `fetch_note` and `fetch_chunk`.
- Pass: same chunks by id; `includeVectors` returns 384 floats; a missing note or id gives a clean not-found.

**T6.12 Response size**
- B: a very large note through `fetch_note` and a broad search stay under the stated size bound.
- H: the modal result list stays responsive with topK 100.

**T6.13 Binary-candidate stage**
- H and B: with the binary pre-filter on, the final ranking equals the exact ranking on the fixture vault (recall 100%).

**T6.14 Search latency**
- H and B: p50 and p95 over 20 queries on the fixture vault, and once on the real vault.
- Pass: under a stated budget, recorded as a baseline.

## Tier 7: The sidecar (the human/bot contract)

All run with both devices pointed at one shared `.obsidian/plugins/seek/index` and the paired `MCP Export`.

**T7.1 Sidecar written (human)**
- H: after T5.3, the sidecar directory contains a device meta file and at least one shard; CRCs validate.
- B: the bot's reader opens the human's sidecar read-only and validates every record.

**T7.2 Sidecar written (bot)**
- B: `compact_sidecar` writes the bot's own device shards.
- H: the human reads and validates them.
- Together T7.1 and T7.2 prove both directions of the byte format.

**T7.3 Hydrate without re-embed (human → bot)**
- B: empty store, `hydrate_sidecar` against the human's sidecar.
- Pass: the bot's `index_stats` equals the human's; zero embeds ran; search results equal T6.5.

**T7.4 Hydrate without re-embed (bot → human)**
- H: empty store, hydrate from the bot's sidecar. Same pass criteria mirrored.

**T7.5 Version gate**
- H and B: present a sidecar with a different model revision, a different dimension, and an older format.
- Pass: both refuse with the same reason (`version-gate-refused`), and neither corrupts its store.

**T7.6 Winner rules and tombstones**
- H and B: two devices edit and delete the same file; one device's tombstone arrives after the other's write.
- Pass: both sides resolve to the same winner per the documented rule, using committed fixtures. Mixed-device ordering is the main untested logic.

**T7.7 Export (human) → snapshot (bot)**
- H: run "Export complete MCP index".
- B: read the export as a snapshot via the CLI (no live store).
- Pass: schema v2 loads; an old export is refused with the instruction to re-export; the export lands beside the native sidecar for **both** `sidecarIndexLocation` modes. The doc's known gap says it does not; this test is expected to fail until fixed.

**T7.8 Out-of-order and partial files (the Syncthing bug)**
- H and B: shards arriving in reverse order; a `.syncthing.*.tmp` file present; a half-written shard.
- Pass: no crash, no hydrate of partial data, and a later complete arrival is picked up (`reconcileSidecarIfChanged`).
- This is the open bug; collect the `seek-log-<deviceId>.ndjson` lines (`sidecar-hydrate`, `version-gate-refused`, `tokenBudget`) from the phone alongside.

**T7.9 Peer ahead detection**
- H and B: with a peer's shard newer than the local one, `peerSidecarPresent` and `probePeerAhead` agree.

**T7.10 Coalesce and compact**
- H and B: many small shards become fewer; record lists are identical before and after.

**T7.11 Dead-identity reaping**
- H and B: a sidecar from a device that no longer exists is reaped per the policy and only that one.

## Tier 8: Lifecycle (live behavior)

**T8.1 Live edit**
- H: edit a note in the editor; the debounced queue picks it up and the delta runs. B: with `SEEK_MCP_WATCH=1`, an on-disk edit triggers the same.
- Pass: index current within the debounce window on both.

**T8.2 Live delete and rename**
- H and B: same checks as T5.6, triggered through live events.

**T8.3 Pause and resume**
- H: the "Indexing paused" setting. B: the pause latch via `index_vault`'s `paused` result.
- Pass: no indexing while paused; backlog drains on resume.

**T8.4 Catch-up after offline edits**
- H and B: edit three notes while the watcher or plugin is off; start it; the catch-up drain indexes exactly those three.

**T8.5 Periodic reconcile**
- H: the 5-minute reconcile. B: its equivalent.
- Pass: a deliberately introduced mismatch is repaired without a full reindex.

**T8.6 Identity heal**
- H and B: stale identity stamp; `reconcileIdentityInPlace` stamps without re-embedding.

**T8.7 Full reindex confirmation**
- H: the confirm dialog is shown when expected and skipped with `skipConfirm`.
- B: the `confirm` port is non-interactive by design; verify it never blocks.

**T8.8 Health and diagnostics**
- H: the logging report content and redaction.
- B: log output through the same logger, same redaction rules.
- Pass: no vault text appears in a redacted report on either side.

**T8.9 Delete model**
- H: `deleteModel`. B: `delete_model`.
- Pass: model status flips to absent; the index remains but search degrades with a clear message; re-download restores it.

**T8.10 Resource ceilings**
- H and B: during a 200-file index, record peak memory and wall time; on the real vault, run once overnight and record the same.
- Pass: no out-of-memory on the phone; record the numbers as the baseline.

## Tier 9: Settings behavior

Each setting is tested as: change it, observe the observable effect, change it back. H changes it in the settings or `data.json`; B changes the same key in `data.json`.

**T9.1 Index Base files** (`indexBases`): base files appear or vanish from the index.
**T9.2 Honor excluded folders**: ignored files appear or vanish.
**T9.3 Index location**: the sidecar moves between the hidden and visible locations, and the other half finds it either way.
**T9.4 Search strategy**: lexical-only, dense-only, hybrid each change ranking as documented.
**T9.5 Fuzzy matching**: a typo query finds its target only when on.
**T9.6 Recency bonus**: a newer note outranks an older tie only when on.
**T9.7 Title bonus**: a title match outranks a body match by the configured weight.
**T9.8 Compute (WebGPU/WASM)**: the setting selects the backend; on the phone WASM only. The "disabled after crash" flag clears correctly.
**T9.9 Reset to defaults**: `data.json` returns to defaults and the bot reads the same defaults.

Parity check for all of tier 9: the same `data.json` produces the same ranking on both halves.

## Tier 10: Human-only UI and its bot counterparts

The principle says nothing human-only should exist without a bot equivalent. Each row tests the human feature and then asks what the bot's equivalent is. A missing equivalent is a finding, not a failure.

| Test | Human capability | Human spec | Bot counterpart | Bot spec |
| --- | --- | --- | --- | --- |
| T10.1 | Search modal | Open (`seek:search` command); typing returns ranked results with snippet and highlighted terms; Enter opens the note at the chunk | `semantic_search` | Hit carries snippet and a passage locator sufficient to find the same location in the note |
| T10.2 | Result highlighting | `highlight` marks query terms in the snippet | none | Decide: add highlight ranges to hits, or document as human-only |
| T10.3 | Query field and suggestions | Typing `#` and `path:` offers completions | none | Decide: expose a `suggest` tool (tags, paths, property keys), or document |
| T10.4 | Insert link | Search result inserts `[[link]]` at the cursor | none (bots write files differently) | Decide: a `resolve_link` tool that returns the exact link text for a hit |
| T10.5 | Recent searches | Persist per device, per vault in `localStorage` | none | Decide: a bot-side per-state-dir recents list or document as human-only |
| T10.6 | Ribbon and notices | Ribbon icon opens search; notices show index progress | progress notifications | `index_vault` returns pass numbers; MCP progress notifications if the client supports them |
| T10.7 | Keyboard hints, display scores, Cmd/Ctrl open | Settings toggle display only | n/a | Record as UI-only |
| T10.8 | Settings tab Index card | Shows chunk counts, disk footprint, last-index times | `index_stats` | Same fields (this one is already built; verify equality) |
| T10.9 | Settings tab Model section | Shows model status, delete button | `model_status`, `delete_model` | Already built; verify |
| T10.10 | Logging report | Opens and redacts | log file | A `get_log_report` equivalent, or document |
| T10.11 | Companion `seek:search` event relay | Off in public build | none | Document as human-only |

## Tier 11: End-to-end loops

**T11.1 Round trip A**: human indexes the fixture vault, exports; bot hydrates, searches; results equal the human's.
**T11.2 Round trip B**: bot indexes, compacts; human hydrates, searches; results equal the bot's.
**T11.3 Concurrent edit**: both sides index the same edit at once; after sync both converge to one state.
**T11.4 Real vault, read-only**: the full vault (~5,600 files) hydrated on the bot from the human's index; spot-check 20 queries with known answers. No bot writes.
**T11.5 Real vault, from scratch**: the bot indexes the real vault itself; record time, battery and memory; compare to the human's number.
**T11.6 MCP client**: a real MCP client (PicoClaw) lists tools and answers a natural-language question through `semantic_search`, with citations that point at real files.
**T11.7 Release install**: install the plugin from the GitHub release assets through BRAT and the bot from the tarball asset through `npx`; run T0–T6 against the installed versions, not the checkout.

---

## Order of execution

1. T0, T1, T2, T3 on both halves (no model, minutes).
2. T4 (the model: the first real-hardware unknown).
3. T5.1–T5.3, then T6 (index and search, fixture vault).
4. T5.4–T5.11, then T7 (incremental correctness and the sidecar contract).
5. T8, T9 (live behavior, settings).
6. T10 (decide each gap).
7. T11 (loops, real vault, installed release).

The bot is run first at each tier, as chosen. The human half runs immediately after and is diffed against it.

## Release note

Obsidian and BRAT install by the GitHub release whose tag **exactly equals** `manifest.json` `version`, without a leading `v` (see the comment in `.github/workflows/release.yml`). Cut it with `npm version <patch|prerelease>` then `git push --follow-tags`. Merging branches is not required; `main` and `monorepo-core` are already the same commit. T11.7 exercises this path.

## Open decisions needed before the matching tests can be written

- Tier 10: for each bot counterpart marked "Decide", add the capability or declare it human-only.
- T7.7: fix the exporter location bug first, or keep the test as an expected failure.
- T4.6: if the model re-downloads on each bot start, the sidecar port must be made stable.
- Vectors on by default (`includeVectors`) is still an unconfirmed decision.
