# Agent Handoff

This document is for the next human or AI agent maintaining the repository. It
is about intent, boundaries, unfinished work, and maintenance method. It is not
the user-facing setup guide and it is not a substitute for the technical
evidence in `INVESTIGATION.md`.

## Read first

Read these documents in order when taking over substantial work:

1. `CONTEXT.md` for why the project exists, its safety boundary, and its
   architecture.
2. `README.md` for how a human runs the MCP server, CLI, and device tests.
3. `TODO.md` for the ordered work list and acceptance criteria.
4. `MCP_BLUEPRINT.md` for the intended contracts and boundaries.
5. `INVESTIGATION.md` for measured evidence and known historical data.
6. `UPSTREAM.md`, `NOTICE.md`, and `src/SEEK-COMPATIBILITY.md` before changing
   compatibility code.

Read only the nearby source needed to establish a falsifiable local hypothesis
before editing. Prefer a cheap, behavior-scoped check over broad exploration.
After an edit, run the narrowest executable validation available before making
another change. Do not declare a hardware path working from container tests.

## Current state

The repository now uses the working browser-WASM sidecar for Android query
embedding. Node owns MCP transport, vault/index loading, and ranking; Chromium
owns the browser Transformers.js and ORT-WASM environment. The strict WebGPU
detour and debug-heavy probes remain historical, but the sidecar itself is
supported because the phone produced a valid vector and ranked vault results.

The first query is intentionally cold: Chromium startup, model loading,
tokenization setup, and WASM initialization took about 57 seconds on the phone.
Keep the sidecar resident in the MCP server so later queries reuse the loaded
pipeline, matching the plugin's preloaded behavior.

## Recovery record

On 2026-09-11, `main` was brought to the then-current `origin/main`, and only
the executable/dependency core files were restored to their exact
`e1e8732` contents:

- `package.json`
- `package-lock.json`
- `src/query-embedder.ts`
- `src/seek-compatibility.ts`

The browser-WASM integration is in `bc0bcd3`, vendor fixes are in `d775c30`,
the runtime registry shim is in `a940b91`, and the end-to-end phone probe is in
`b62c070`; all are pushed to `origin/main`. The phone produced a finite,
normalized 384-dimensional vector and five ranked vault hits.

## Postmortem correction

The original MCP core was working before the Chromium sidecar experiment. The
speed gap was observed against a different host and runtime setup, not an
apples-to-apples GPU-versus-CPU benchmark. The later device evidence shows the
actual phone path is q4 WASM with plain ORT glue and a proxy worker, and the
browser WebGPU adapter is unavailable.

The sidecar experiment was a valid compatibility boundary because Node could not
run the browser runtime's `blob:` module URL. The mistake was elevating it into
a strict WebGPU solution before validating the equivalent browser-WASM path.
The browser-WASM path is now validated and is the Android default; strict
WebGPU remains an explicit unsupported experiment on this phone.

## Recovery map

The branch history should be treated as warning markers, not working guidance:

- `74f2853` (`Port Seek query embedding to WASM runtime`) is the original
  working MCP query-WASM port.
- `2978012` (`Align Seek compatibility guide and vector contract`) is the
  earlier compatibility milestone.
- `e1e8732` (`Document phone runtime findings and add device tests`) is the
  last pre-sidecar mainline state.
- `3e093b3` (`feat: add Chromium WebGPU sidecar probe`) is the branch split
  that introduced the wrong detour.
- `24eee41` and the later debug commits are not a usable product baseline.
- `695d3d5` fixed transport in the historical WebGPU branch; its browser/CDP
  lesson is retained by the current WASM sidecar.

The old strict-WebGPU branch and debug-heavy mutation sequence remain historical
cautionary material. The current browser-WASM sidecar is active design.

## Active engineering rules

- Default Android runtime: Seek-compatible WASM hosted in Chromium, not WebGPU.
- Browser sidecar: supported Android query runtime; preserve its browser
  boundary, plain WASM glue, and model contract.
- Node owns MCP transport, vault access, index loading, and ranking.
- Chromium/browser runtime owns query embedding; keep it resident when serving
  multiple MCP requests so cold model startup is amortized.
- The server is read-only; it does not edit notes, run Git, reindex Seek, or
  create a competing vector pipeline.
- The separate plugin checkout owns exporter behavior; do not silently repair it
  here.

## Next-session checklist

Before editing, inspect the exact query/WASM compatibility path and the relevant
Seek compatibility files, especially `src/query-embedder.ts`,
`src/seek-compatibility.ts`, and the copied browser runtime under
`vendor/seek/src/`.

The active hypothesis is:

> The working browser-WASM path is correct; optimize residency and startup
> without moving execution back into Node or switching to strict WebGPU.

Revalidate the phone path after runtime or model changes. Do not replace the
browser-WASM sidecar with direct Node execution: Node cannot load the browser
runtime's `blob:` module.

## Compatibility maintenance

Keep copied Seek blocks visibly separate, preserve their upstream layout,
ordering, comments, and control flow, and mark any MCP-specific adaptation at
narrow boundaries. Do not refactor copied Seek code into local style or rebuild
its algorithm from memory. Update `src/SEEK-COMPATIBILITY.md`, `UPSTREAM.md`,
`NOTICE.md`, fixtures, and format gates when the compatibility contract changes.

## Handoff hygiene

Record observed facts separately from hypotheses. Mark hardware results with the
device and command that produced them. Treat old branch names as historical after
an intentional revert. Generated logs belong outside the commit. Keep durable
user-facing behavior in `README.md`, ordered work in `TODO.md`, measured
investigation in `INVESTIGATION.md`, and project purpose or safety rationale in
`CONTEXT.md`.
