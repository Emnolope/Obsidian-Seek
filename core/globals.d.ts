// core/ compiles without the DOM or Node libs so it can't reach for either by accident.
// These few exist in every runtime we ship to (Obsidian, Node, Chromium, WASM workers), so declaring them is cheaper than splitting each call site.
declare const console: { log(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void; debug(...a: unknown[]): void; info(...a: unknown[]): void };
declare const performance: { now(): number };
declare class TextEncoder { encode(s?: string): Uint8Array }
declare const navigator: { storage?: { estimate(): Promise<{ usage?: number }> } } | undefined;
declare function setTimeout(fn: (value: unknown) => void, ms?: number): unknown;
