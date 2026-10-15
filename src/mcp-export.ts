import type { DataAdapter } from 'obsidian';
import { ACTIVE_MODEL_SPEC } from './model-registry';
import { CHUNKER_VERSION } from './chunker';
import type { ChunkMeta } from './types';
import type { FileRecord, IndexStore } from './index-store';
import { EXPORT_DIRNAME, EXPORT_DOCS_FILE, EXPORT_META_FILE, serializeDocuments, serializeMeta, type ExportDocument, type ExportMeta } from '../core/export';
import { EXPORT_SCHEMA_VERSION } from '../core/contract';

export const MCP_EXPORT_DIR = `Seek Index/${EXPORT_DIRNAME}`;

export type McpExportDocument = ExportDocument;
export type McpExportMeta = ExportMeta;

export async function exportMcpIndex(adapter: DataAdapter, store: IndexStore): Promise<McpExportMeta> {
    const metas = await store.listAllMeta();
    const [bodies, files, embeddings] = await Promise.all([
        store.getBodiesMap(metas.map(meta => meta.chunk_id)),
        store.listFileRecords(),
        store.listAllEmbeddings(),
    ]);
    const metaById = new Map(metas.map(meta => [meta.chunk_id, meta]));
    const vectorById = new Map(embeddings.ids.map((id, i) => [id, embeddings.vecs[i]]));
    const fileByChunk = new Map<string, { file: FileRecord; index: number }>();
    for (const file of files) file.chunk_ids.forEach((id, index) => fileByChunk.set(id, { file, index }));

    const documents: McpExportDocument[] = [];
    for (const [chunkId, chunkMeta] of metaById) {
        const location = fileByChunk.get(chunkId);
        const quantized = vectorById.get(chunkId);
        const content = bodies.get(chunkId);
        if (!location || !quantized || content === undefined) throw new Error(`incomplete MCP export join for ${chunkId}`);
        documents.push({
            chunkId,
            notePath: location.file.note_path,
            title: chunkMeta.title,
            content,
            chunkIndex: location.index,
            mtime: location.file.mtimeMs,
            meta: chunkMeta,
        });
    }
    const generation = `${Date.now()}-${documents.length}`;
    const exportMeta: McpExportMeta = {
        schemaVersion: EXPORT_SCHEMA_VERSION,
        generation,
        modelId: ACTIVE_MODEL_SPEC.repo,
        revision: ACTIVE_MODEL_SPEC.revision ?? 'main',
        chunkerVersion: CHUNKER_VERSION,
        dimension: ACTIVE_MODEL_SPEC.dim,
        chunkCount: documents.length,
    };
    const temp = `${MCP_EXPORT_DIR}.tmp-${generation}`;
    await adapter.mkdir(temp);
    await adapter.write(`${temp}/${EXPORT_DOCS_FILE}`, serializeDocuments(documents));
    await adapter.write(`${temp}/${EXPORT_META_FILE}`, serializeMeta(exportMeta));
    if (await adapter.exists(MCP_EXPORT_DIR)) await adapter.remove(MCP_EXPORT_DIR);
    await adapter.rename(temp, MCP_EXPORT_DIR);
    return exportMeta;
}