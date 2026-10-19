// fork 1.1.3 new; relates to src/index-store.ts:552 IndexStore
// Node twin of the plugin's IndexedDB store: same contract (core/index-store.ts), same method names, held in
// memory. Durability is the sidecar's job, exactly as on the human side where IDB is only the local working copy.
import { packSignBits } from '../../core/binary.ts';
import { quantizeInt8, dequantizeInt8, type QuantVec } from '../../core/quant.ts';
import { META_SCHEMA_VERSION, stripContent } from '../../core/index-types.ts';
import type { FileRecord, MetaConfig } from '../../core/index-types.ts';
import type { IndexStore } from '../../core/index-store.ts';
import type { Chunk, ChunkMeta } from '../../core/types.ts';
import { ACTIVE_MODEL_SPEC } from '../../core/model-registry.ts';

export class NodeIndexStore implements IndexStore {
    private cfg: MetaConfig | null = null;
    private metas = new Map<string, ChunkMeta>();
    private bodies = new Map<string, string>();
    private embs = new Map<string, QuantVec>();
    private bins = new Map<string, Uint8Array>();
    private files = new Map<string, FileRecord>();
    private _dbName: string;

    constructor(dbName: string) { this._dbName = dbName; }

    get dbName(): string { return this._dbName; }

    async open(): Promise<void> {}
    close(): void {}

    async getMeta(): Promise<MetaConfig> {
        return this.cfg ?? { embeddingDim: ACTIVE_MODEL_SPEC.dim, lastIndexedAt: null, schemaVersion: META_SCHEMA_VERSION };
    }
    async setMeta(meta: MetaConfig): Promise<void> { this.cfg = meta; }

    async putBatch(chunks: Chunk[], vectors: Float32Array[]): Promise<void> {
        if (chunks.length === 0) return;
        if (chunks.length !== vectors.length) throw new Error(`chunks/vectors length mismatch: ${chunks.length} vs ${vectors.length}`);
        await this.putBatchQuantized(chunks, vectors.map(v => ({ q: quantizeInt8(v), bin: packSignBits(v) })));
    }

    async putBatchQuantized(chunks: Chunk[], tiers: { q: QuantVec; bin: Uint8Array }[], fileRecord?: FileRecord): Promise<void> {
        if (chunks.length === 0 && fileRecord === undefined) return;
        if (chunks.length !== tiers.length) throw new Error(`chunks/tiers length mismatch: ${chunks.length} vs ${tiers.length}`);
        chunks.forEach((c, i) => {
            this.metas.set(c.chunk_id, stripContent(c));
            this.bodies.set(c.chunk_id, c.content ?? '');
            this.bins.set(c.chunk_id, tiers[i].bin);
            this.embs.set(c.chunk_id, tiers[i].q);
        });
        if (fileRecord) this.files.set(fileRecord.note_path, fileRecord);
    }

    async putFileRecord(rec: FileRecord): Promise<void> { this.files.set(rec.note_path, rec); }
    async getFileRecord(notePath: string): Promise<FileRecord | undefined> { return this.files.get(notePath); }
    async listFileRecords(): Promise<FileRecord[]> { return [...this.files.values()]; }
    async getAllChunkIds(): Promise<string[]> { return [...this.metas.keys()]; }

    async deleteChunksByIds(ids: string[]): Promise<void> {
        for (const id of ids) { this.metas.delete(id); this.bodies.delete(id); this.embs.delete(id); this.bins.delete(id); }
    }

    async deleteFile(notePath: string): Promise<string[]> {
        const rec = this.files.get(notePath);
        if (!rec) return [];
        await this.deleteChunksByIds(rec.chunk_ids);
        this.files.delete(notePath);
        return rec.chunk_ids;
    }

    async getChunkMetasByIds(ids: string[]): Promise<Map<string, ChunkMeta>> {
        const out = new Map<string, ChunkMeta>();
        for (const id of ids) { const m = this.metas.get(id); if (m) out.set(id, m); }
        return out;
    }
    async putChunkMetas(metas: ChunkMeta[]): Promise<void> { for (const m of metas) this.metas.set(m.chunk_id, m); }
    async listAllMeta(): Promise<ChunkMeta[]> { return [...this.metas.values()]; }

    async listAllBinary(): Promise<{ ids: string[]; packed: Uint8Array[] }> {
        return { ids: [...this.bins.keys()], packed: [...this.bins.values()] };
    }
    async listAllEmbeddings(): Promise<{ ids: string[]; vecs: QuantVec[] }> {
        return { ids: [...this.embs.keys()], vecs: [...this.embs.values()] };
    }

    async getEmbeddingsByIds(ids: string[]): Promise<Array<Float32Array | null>> {
        return ids.map(id => { const r = this.embs.get(id); return r ? dequantizeInt8(r.q, r.s) : null; });
    }
    async getBodiesByIds(ids: string[]): Promise<Array<string | null>> { return ids.map(id => this.bodies.get(id) ?? null); }
    async getBodiesMap(ids: string[]): Promise<Map<string, string>> {
        const out = new Map<string, string>();
        for (const id of ids) { const b = this.bodies.get(id); if (b !== undefined) out.set(id, b); }
        return out;
    }

    async getTiersByIds(ids: string[]): Promise<Array<{ chunk: Chunk; q: QuantVec; sign: Uint8Array } | null>> {
        return ids.map(id => {
            const meta = this.metas.get(id), body = this.bodies.get(id), q = this.embs.get(id), sign = this.bins.get(id);
            if (!meta || body === undefined || !q || !sign) return null;
            return { chunk: { ...meta, content: body }, q, sign };
        });
    }

    async count(): Promise<{ chunks: number; embeddings: number; binary: number; files: number }> {
        return { chunks: this.metas.size, embeddings: this.embs.size, binary: this.bins.size, files: this.files.size };
    }

    // Full-reindex reset (the IDB side drops the database); no counterpart method upstream.
    async clear(): Promise<{ chunks: number; embeddings: number; binary: number; files: number }> {
        const n = await this.count();
        this.cfg = null; this.metas.clear(); this.bodies.clear(); this.embs.clear(); this.bins.clear(); this.files.clear();
        return n;
    }
}
