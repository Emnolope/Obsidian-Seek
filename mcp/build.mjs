// Bundles the MCP server (and the shared core/) into dist/, so the published package
// is self-contained. transformers.web.js stays a real runtime import: query-embedder
// hides `process` while it evaluates, which only works if it loads lazily, not at startup.
import esbuild from 'esbuild';
import { rmSync } from 'node:fs';

rmSync(new URL('./dist', import.meta.url), { recursive: true, force: true });
await esbuild.build({
    entryPoints: { server: 'src/server.ts', cli: 'src/cli.ts' },
    outdir: 'dist',
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    external: ['*/transformers.web.js'],
    banner: { js: '#!/usr/bin/env node' },
    logLevel: 'info',
});
