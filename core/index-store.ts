// fork 1.1.3 new; relates to src/index-store.ts:552 IndexStore
// The store contract core's writers and readers lean on, so the plugin (IndexedDB) and the bot (Node,
// memory + sidecar) are two implementations of one surface. Names and signatures are IndexStore's own.
// Left on the IndexedDB class: measureSizes, compact, backfillBinaryIfMissing (IDB-specific upkeep).
import type { Chunk, ChunkMeta } from './types.ts';
import type { QuantVec } from './quant.ts';
import type { FileRecord, MetaConfig } from './index-types.ts';

export interface IndexStore {
    readonly dbName: string;
    // fork 1.1.3 src/index-store.ts:562 IndexStore.open
    open(scope?: string, dbPrefix?: string): Promise<void>;
    // fork 1.1.3 src/index-store.ts:589 IndexStore.close
    close(): void;
    // fork 1.1.3 src/index-store.ts:599 IndexStore.getMeta
    getMeta(): Promise<MetaConfig>;
    // fork 1.1.3 src/index-store.ts:611 IndexStore.setMeta
    setMeta(meta: MetaConfig): Promise<void>;
    // fork 1.1.3 src/index-store.ts:650 IndexStore.putBatch
    putBatch(chunks: Chunk[], vectors: Float32Array[]): Promise<void>;
    // fork 1.1.3 src/index-store.ts:684 IndexStore.putBatchQuantized
    putBatchQuantized(chunks: Chunk[], tiers: { q: QuantVec; bin: Uint8Array }[], fileRecord?: FileRecord): Promise<void>;
    // fork 1.1.3 src/index-store.ts:710 IndexStore.putFileRecord
    putFileRecord(rec: FileRecord): Promise<void>;
    // fork 1.1.3 src/index-store.ts:717 IndexStore.getFileRecord
    getFileRecord(notePath: string): Promise<FileRecord | undefined>;
    // fork 1.1.3 src/index-store.ts:726 IndexStore.listFileRecords
    listFileRecords(): Promise<FileRecord[]>;
    // fork 1.1.3 src/index-store.ts:735 IndexStore.getAllChunkIds
    getAllChunkIds(): Promise<string[]>;
    // fork 1.1.3 src/index-store.ts:745 IndexStore.deleteChunksByIds
    deleteChunksByIds(ids: string[]): Promise<void>;
    // fork 1.1.3 src/index-store.ts:780 IndexStore.deleteFile
    deleteFile(notePath: string): Promise<string[]>;
    // fork 1.1.3 src/index-store.ts:815 IndexStore.getChunkMetasByIds
    getChunkMetasByIds(ids: string[]): Promise<Map<string, ChunkMeta>>;
    // fork 1.1.3 src/index-store.ts:833 IndexStore.putChunkMetas
    putChunkMetas(metas: ChunkMeta[]): Promise<void>;
    // fork 1.1.3 src/index-store.ts:847 IndexStore.listAllMeta
    listAllMeta(): Promise<ChunkMeta[]>;
    // fork 1.1.3 src/index-store.ts:858 IndexStore.listAllBinary
    listAllBinary(): Promise<{ ids: string[]; packed: Uint8Array[] }>;
    // fork 1.1.3 src/index-store.ts:885 IndexStore.listAllEmbeddings
    listAllEmbeddings(): Promise<{ ids: string[]; vecs: QuantVec[] }>;
    // fork 1.1.3 src/index-store.ts:1050 IndexStore.getEmbeddingsByIds
    getEmbeddingsByIds(ids: string[]): Promise<Array<Float32Array | null>>;
    // fork 1.1.3 src/index-store.ts:1066 IndexStore.getBodiesByIds
    getBodiesByIds(ids: string[]): Promise<Array<string | null>>;
    // fork 1.1.3 src/index-store.ts:1079 IndexStore.getBodiesMap
    getBodiesMap(ids: string[]): Promise<Map<string, string>>;
    // fork 1.1.3 src/index-store.ts:1101 IndexStore.getTiersByIds
    getTiersByIds(ids: string[]): Promise<Array<{ chunk: Chunk; q: QuantVec; sign: Uint8Array } | null>>;
    // fork 1.1.3 src/index-store.ts:1191 IndexStore.count
    count(): Promise<{ chunks: number; embeddings: number; binary: number; files: number }>;
}
