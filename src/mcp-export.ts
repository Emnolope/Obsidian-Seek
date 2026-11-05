import type { DataAdapter } from 'obsidian';
import { ACTIVE_MODEL_SPEC } from './model-registry';
import { CHUNKER_VERSION } from './chunker';
import type { ChunkMeta } from './types';
import type { FileRecord, IndexStore } from './index-store';
import { EXPORT_DIRNAME, EXPORT_DOCS_FILE, EXPORT_META_FILE, serializeDocuments, serializeMeta, type ExportDocument, type ExportMeta } from '../core/export';
import { EXPORT_SCHEMA_VERSION } from '../core/contract';

// The export rides inside the active sidecar dir because that is where the MCP loader looks (SeekIndex.load joins EXPORT_DIRNAME onto the index root).
// Fallback is the visible folder for installs with the sidecar off.
export const FALLBACK_INDEX_DIR = 'Seek Index';

export type McpExportDocument = ExportDocument;
export type McpExportMeta = ExportMeta;

export async function exportMcpIndex(adapter: DataAdapter, store: IndexStore, indexDir: string | null = null): Promise<McpExportMeta> {
    const exportDir = `${indexDir ?? FALLBACK_INDEX_DIR}/${EXPORT_DIRNAME}`;
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
    const temp = `${exportDir}.tmp-${generation}`;
    await adapter.mkdir(temp);
    await adapter.write(`${temp}/${EXPORT_DOCS_FILE}`, serializeDocuments(documents));
    await adapter.write(`${temp}/${EXPORT_META_FILE}`, serializeMeta(exportMeta));
    if (await adapter.exists(exportDir)) await adapter.remove(exportDir);
    await adapter.rename(temp, exportDir);
    return exportMeta;
}