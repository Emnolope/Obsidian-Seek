// core/ compiles without the DOM or Node libs so it can't reach for either by accident.
// These few exist in every runtime we ship to (Obsidian, Node, Chromium, WASM workers), so declaring them is cheaper than splitting each call site.
declare const console: { log(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void; debug(...a: unknown[]): void; info(...a: unknown[]): void };
declare const performance: { now(): number };
declare class TextEncoder { encode(s?: string): Uint8Array }
declare const navigator: { storage?: { estimate(): Promise<{ usage?: number }>; persisted?(): Promise<boolean> } } | undefined;
// Structural slice of the DOM Cache API; model-registry's eviction helpers only touch these.
declare interface CacheStorage { has(name: string): Promise<boolean>; open(name: string): Promise<{ keys(): Promise<{ url: string }[]>; delete(req: { url: string }): Promise<boolean> }> }
declare function setTimeout(fn: (value: unknown) => void, ms?: number): unknown;
// gzip.ts: web-standard streams, present in Electron, WKWebView and Node 18+.
declare class Blob { constructor(parts: unknown[]); stream(): { pipeThrough(t: unknown): unknown } }
declare type BlobPart = unknown;
declare class CompressionStream { constructor(format: string) }
declare class DecompressionStream { constructor(format: string) }
declare class Response { constructor(body: unknown); arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }
declare const crypto: { randomUUID?: () => string };
