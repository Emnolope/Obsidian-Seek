# Obsidian Seek MCP TODO

This list reflects the current working baseline, including the validated
Chromium browser-WASM query sidecar. The strict WebGPU detour remains historical
and unsupported on the target phone.

## Current recovery state

The browser-WASM path is integrated in `bc0bcd3`; the vendored runtime shim is
in `a940b91`, and `test-5.5.sh` proves the complete phone search path in
`b62c070`. The build and two-test suite pass. The phone produced a finite,
normalized 384-dimensional vector and ranked five vault notes.

## Active work

- [ ] `[critical]` Fix the Seek exporter to write `MCP Export/` beside the
  native sidecar selected by `sidecarIndexLocation` (`.obsidian/plugins/seek/index`
  or `Seek Index`), rather than always using the hidden path.
- [ ] `[critical]` Generate fresh exports in both plugin location modes and
  validate that native sidecars and MCP manifests are found in the same vault
  location.
- [ ] `[critical]` Run the PicoClaw stdio smoke test against a fresh agent-vault
  copy using `vaultDir`, not `SEEK_EXPORT_DIR`.
- [ ] `[critical]` Add a server test for hidden lookup, visible fallback, and
  the error when neither location contains a valid export.
- [ ] `[critical]` Add protocol tests for `initialize`, `tools/list`, tool calls,
  malformed JSON, unknown tools, and invalid arguments.
- [ ] `[critical]` Bound search and fetch response sizes before relying on the
  server for large notes and PicoClaw context.
- [ ] `[important]` Group chunk hits by note and preserve the best-scoring
  chunks per note.
- [ ] `[important]` Report model, revision, dimensions, shard counts, and all
  mismatch/invalid-record diagnostics in the health response.
- [ ] `[important]` Detect Markdown changes since export generation.
- [ ] `[important]` Handle Seek tombstones and mixed-device winner rules with
  committed fixtures.
- [ ] `[optional]` Add sign-bit candidate generation and reranking.
- [ ] `[optional]` Reload a vault when its export generation changes.
- [ ] `[important]` Keep Chromium resident across CLI/MCP requests so model
  startup is paid once instead of once per one-shot command.
- [x] Add a CLI that calls the same `SeekIndex` library as MCP.

## Historical strict-WebGPU detour

These items describe the old strict-WebGPU branch and should remain warning
markers only. They are not the phone's supported backend.

- [x] Investigate Chromium launch and CDP handshake.
- [x] Debug the self-message bug in the sidecar transport.
- [x] Confirm strict WebGPU fails on the target phone.
- [x] Observe the real plugin runtime: q4 WASM with plain ORT glue and a proxy
  worker.
- [x] Record the split point and recovery map in the handoff docs.

## Browser-WASM path

- [x] Restore the Chromium/CDP bridge around Seek's browser child runtime.
- [x] Route Android query embedding through Chromium WASM with plain glue.
- [x] Prove a real 384-dimensional vector ranks the phone vault.

## Baseline implementation already complete

- [x] Read-only MCP stdio server.
- [x] One stable tool set across arbitrary vault directories.
- [x] Hidden-then-visible Seek location lookup.
- [x] Lazy per-vault index loading and caching.
- [x] Natural-language and precomputed-vector search inputs.
- [x] Read-only CLI using the shared vault loader and `SeekIndex` APIs.
- [x] Seek-compatible model, revision, pooling, normalization, and dimension.
- [x] Native sidecar CRC, dimension, offset, and path validation.
- [x] Stale document mappings are skipped and reported by `index_status`.
- [x] Published MCP release `Obsidian-Vault-MCP-v4`.

## Compatibility maintenance

- [x] `[critical]` Pin and record the Seek source commit used by compatibility
  code: `1f0a9b0ce3854f82cc746e02f9cd27bcdbc30acd`.
- [ ] `[critical]` Compare model, quantization, and IndexedDB changes before
  every Seek update.
- [ ] `[critical]` Update `UPSTREAM.md`, `NOTICE.md`, fixtures, and format gates
  whenever a compatibility-affecting Seek change is ported.
- [ ] `[critical]` Run MCP build/tests, Seek typecheck/tests, and fresh hidden
  and visible export validation after format or lifecycle changes.

## Compatibility contract

The English specification and executable compatibility boundary are deliberately
paired in the same directory:

- `src/SEEK-COMPATIBILITY.md` is the human/AI porting procedure and source of
  truth for the tensor pathway.
- `src/seek-compatibility.ts` is the compact implementation of the pinned model,
  backend policy, and vector post-processing contract.

Update both in the same change. Preserve the largest recognizable Seek block
first, adapt platform edges second, and trim only after numerical validation.
The Android default is browser-hosted WASM through the Chromium sidecar; strict
WebGPU remains an explicit unsupported experiment on the phone.

## Commands

```sh
npm ci
npm run build
npm test
git diff --check
```

The MCP server is started with `npm start`. PicoClaw calls tools with
`vaultDir`; do not configure `SEEK_EXPORT_DIR`.
