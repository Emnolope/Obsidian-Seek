// A SearchHost that holds the whole corpus in RAM. It's what lets any non-Obsidian side (the MCP server, tests, a future CLI) run the exact same runSearch as the plugin:
// the only things it can't know on its own are how to embed text and which frontmatter props are numeric, so the caller injects those.
import type { ChunkMeta, FilterContext, SearchEntry, SeekSettings } from './types.ts';
import { DEFAULT_SETTINGS, migrateSettings } from './types.ts';
import { MultiFieldBM25, DEFAULT_FIELD_BOOSTS } from './bm25.ts';
import { buildSynonymMap, type SynonymMap } from './synonyms.ts';
import { binaryCandidates, packSignBits } from './binary.ts';
import { dequantizeInt8, type QuantVec } from './quant.ts';
import type { RecencyOverride, SearchHost } from './engine.ts';
import type { ResidentFrame } from './search-helpers.ts';

export interface MemoryDoc { meta: ChunkMeta; content: string; vec: QuantVec }

// data.json is the plugin's saveData blob; same migrate+merge as main.ts onload so both sides rank with identical knobs.
export function resolveSettings(raw: unknown): SeekSettings {
    const r = (raw && typeof raw === 'object' ? { ...(raw as Partial<SeekSettings>) } : {}) as Partial<SeekSettings>;
    migrateSettings(r);
    return { ...DEFAULT_SETTINGS, ...r };
}

// Obsidian persists declared property types in .obsidian/types.json as { types: { key: "number" | "date" | ... } }. Type-registry only, never value-sniffing (same rule as the plugin's prop-types.ts).
export function numericKeysFromTypesJson(raw: unknown): Set<string> {
    const types = (raw as { types?: Record<string, string> } | null)?.types ?? {};
    return new Set(Object.entries(types).filter(([, t]) => String(t).toLowerCase() === 'number').map(([k]) => k));
}

// fork 1.1.3 new; relates to src/search.ts:4526 buildResidentRerankBlock + src/search.ts:4556 ResidentFrame (MCP builds the frame from sidecar docs, the plugin from IDB)
export function assembleFrame(docs: MemoryDoc[]): ResidentFrame | null {
    if (docs.length === 0) return null;
    const dim = docs[0].vec.q.length;
    const bytesPerVec = (dim + 7) >> 3;
    const packed = new Uint8Array(docs.length * bytesPerVec);
    const int8 = new Int8Array(docs.length * dim);
    const scales = new Float64Array(docs.length);
    docs.forEach((d, i) => {
        if (d.vec.q.length !== dim) throw new Error(`mixed vector dims in index (${d.vec.q.length} vs ${dim}) for ${d.meta.chunk_id}`);
        // The plugin packs from the original fp32; sign bits of the dequantized int8 only differ for components within quantization noise of 0, and the binary arm is just candidate selection.
        packed.set(packSignBits(dequantizeInt8(d.vec.q, d.vec.s)), i * bytesPerVec);
        int8.set(d.vec.q, i * dim);
        scales[i] = d.vec.s;
    });
    return {
        orderedChunks: docs.map(d => d.meta),
        orderedIds: docs.map(d => d.meta.chunk_id),
        activePacked: packed, bytesPerVec,
        residentInt8: int8, residentScales: scales, embDim: dim,
        validRows: new Array<boolean>(docs.length).fill(true),
        tombstoneCount: 0,
        generation: 0,
    };
}

export class MemoryHost implements SearchHost {
    private frameCache: ResidentFrame | null = null;
    private built = false;
    private index: MultiFieldBM25 | null = null;
    private syn: SynonymMap | null = null;
    private bodyById: Map<string, string>;
    private vecById: Map<string, QuantVec>;

    private docs: MemoryDoc[];
    readonly settings: SeekSettings;
    private embedFn: (text: string) => Promise<Float32Array>;
    private numericKeys: Set<string>;

    // No parameter properties: the MCP tests run this file under node's strip-only TypeScript mode.
    constructor(docs: MemoryDoc[], settings: SeekSettings, embedFn: (text: string) => Promise<Float32Array>, numericKeys: Set<string> = new Set()) {
        this.docs = docs; this.settings = settings; this.embedFn = embedFn; this.numericKeys = numericKeys;
        this.bodyById = new Map(docs.map(d => [d.meta.chunk_id, d.content]));
        this.vecById = new Map(docs.map(d => [d.meta.chunk_id, d.vec]));
    }

    filterCtx(override?: RecencyOverride): FilterContext {
        const epsilon = override?.epsilon ?? this.settings.recencyEpsilon;
        return {
            dateField: epsilon > 0 ? { key: this.settings.recencyKey, createdProp: this.settings.createdProp } : null,
            numericKeys: this.numericKeys,
        };
    }

    async frame() {
        const wasCached = this.built;
        if (!this.built) { this.frameCache = assembleFrame(this.docs); this.built = true; }
        return { frame: this.frameCache, wasCached };
    }

    async bodies(ids: string[]) { return ids.map(id => this.bodyById.get(id)); }
    async bodiesMap(ids: string[]) { return new Map(ids.flatMap(id => this.bodyById.has(id) ? [[id, this.bodyById.get(id)!] as [string, string]] : [])); }
    async embeddings(ids: string[]) { return ids.map(id => { const v = this.vecById.get(id); return v ? dequantizeInt8(v.q, v.s) : null; }); }
    async embed(text: string) {
        const t = performance.now();
        return { vector: await this.embedFn(text), iframeLatencyMs: performance.now() - t };
    }
    async binaryCandidates(_gen: number, q: Float32Array, packed: Uint8Array, n: number, bpv: number, cap: number, mask: boolean[] | null) {
        return binaryCandidates(q, packed, n, bpv, cap, mask);
    }

    async prepareBm25(chunks: ChunkMeta[]): Promise<boolean> {
        const hit = !!this.index;
        if (!this.index) {
            this.index = new MultiFieldBM25().fit(chunks, this.bodyById, {
                searchableProperties: this.settings.searchableProperties,
                // boostedBm25 boosts headings 4x, which is inert unless the field is indexed.
                headingsField: this.settings.headingsField || this.settings.boostedBm25,
            });
        }
        if (this.settings.synonymExpansion && !this.syn) this.syn = buildSynonymMap(chunks, t => this.index!.termDocFraction(t));
        return hit;
    }
    bm25() { return this.index; }
    bm25Boosts() {
        return this.settings.boostedBm25 ? { ...DEFAULT_FIELD_BOOSTS, aliases: 9.0, tags: 2.0, headings: 4.0 } : DEFAULT_FIELD_BOOSTS;
    }
    synonyms() { return this.syn; }
    // The corpus is immutable here, so the frame/BM25 coupling can't drift.
    onCoherenceDrift() { /* unreachable by construction */ }
    async bgStats() { return null; }
    // MCP stdout is the JSON-RPC channel, so there is nowhere to log search telemetry to.
    async log(_e: SearchEntry) { /* intentionally dropped */ }
    async logError(tag: string, err: Error) { console.error(`[seek] ${tag}: ${err.message}`); }
}
