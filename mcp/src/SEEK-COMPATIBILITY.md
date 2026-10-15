# Seek Compatibility Guide

This document explains how to port Seek's embedding pathway without silently
creating a different vector space. The goal is reproducible compatibility,
not a local rewrite of the plugin.

## The contract

This document is the orchestration layer for the compatibility code. The
TypeScript implementation is correct only when it agrees with this document;
when Seek changes, update the evidence and this procedure before changing the
adapter.

The query vector must be produced with the same effective:

- model repository and immutable revision
- tokenizer and special-token behavior
- input cleanup, truncation, and maximum length
- dtype and ONNX graph
- execution-provider-compatible model output
- pooling rule (`CLS` for the current model)
- normalization rule
- output dimension and any slicing/renormalization

GPU versus CPU is a replaceable execution backend. It can change floating-point
rounding and speed, but it must not change the contract above. The indexed
document vectors and query vectors must remain in the same model space.

## Copy first, trim later

When Seek changes, begin with the largest relevant upstream block. Preserve its
names, ordering, comments, and control flow. Adapt only platform boundaries:

1. Copy the model specification and embedding code from the pinned Seek commit.
2. Copy the runtime boundary that invokes Transformers.js and ORT.
3. Mark Node, browser, iframe, filesystem, and transport substitutions locally.
4. Compare the copied block against the new Seek source before trimming helpers.
5. Remove unused code only after tests prove that the contract is unchanged.

Do not optimize for fewer copied lines. Optimize for a future maintainer being
able to replace the copied block mechanically.

## Reverse-engineering procedure

For each Seek update, trace the path in this order:

1. Find the active model registry entry and record repository, revision, dtype,
   and dimension.
2. Find the tokenizer call and record text preprocessing, special tokens,
   truncation, padding, and maximum length.
3. Find the `pipeline()` or model invocation and record device, execution
   provider, graph options, and quantized model file.
4. Find post-processing and record pooling, normalization, slicing, and tensor
   disposal.
5. Find the index writer and record quantization, scale, sign bits, record
   layout, CRC, shard names, and generation metadata.
6. Compare one fixed set of texts through Seek and MCP. Check dimensions,
   finite values, vector norms, cosine rankings, and representative values.
7. Update fixtures, compatibility metadata, and this guide's source commit.

The important evidence is the matrix flow, not a description such as “uses
embeddings.” A port is compatible only when the numerical operations and their
inputs are accounted for.

## Backend policy

The MCP implementation defaults to WASM, hosted in Chromium on Android because
the browser runtime requires browser `blob:` module loading. The backend policy is implemented in
`src/seek-compatibility.ts` and consumed by `src/query-embedder.ts`:

- `SEEK_MCP_DEVICE=wasm` selects the portable CPU/WASM path.
- `SEEK_MCP_DEVICE=auto` attempts WebGPU and falls back to WASM if pipeline
   creation fails.
- `SEEK_MCP_DEVICE=webgpu` attempts WebGPU and fails if pipeline creation
   fails; it never silently changes the requested backend.

The default for an unset or invalid value is `wasm`. On Android, set
`SEEK_CHROMIUM_PATH` to the Termux Chromium binary; the sidecar keeps the model
and browser runtime resident while the Node process owns ranking. Merely exposing
`navigator.gpu` is not proof of a usable backend; pipeline creation is the
discriminating capability check.

The plugin's browser path adds iframe isolation, WebGPU adapter probing, shader
warmup, device-loss recovery, and mobile memory policy. Those are runtime
adaptations, not part of the vector contract. The MCP sidecar reuses the copied
Seek child runtime in Chromium and requests q4 WASM with plain glue. Phone-side
Termux tests found no Node `navigator.gpu`, no published Android Dawn binary,
and a Node-incompatible `blob:` module URL in the browser-oriented WASM path.
The browser sidecar resolves those host limitations without altering the model,
tokenizer, pooling, normalization, dtype, or output-dimension contract.

## Validation commands

```sh
npm run build
npm test
SEEK_CHROMIUM_PATH=/data/data/com.termux/files/usr/bin/chromium-browser \
SEEK_MCP_DEVICE=wasm npm run cli -- search "$VAULT" "test query" --top-k 5
SEEK_MCP_DEVICE=auto npm run cli -- search "$VAULT" "test query" --top-k 5
SEEK_MCP_DEVICE=webgpu npm run cli -- search "$VAULT" "test query" --top-k 5
```

The final command is expected to fail on a normal Node/Termux WASM-only host.
That failure is useful: it proves that a claimed GPU path is not silently
falling back when strict GPU mode was requested.

## Ownership map

`src/seek-compatibility.ts` is the compact, reviewable compatibility contract.
Its `SEEK_MODEL`, device policy, and `prepareVector` function are the code
counterpart of this document's contract. `src/query-embedder.ts` is the MCP runtime adapter. The sidecar, MCP protocol,
vault resolver, and search ranking are project code and must not be blended into
the copied embedding pathway.