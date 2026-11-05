// "Export complete index": every chunk (text + metadata) as JSONL, so external tools can read what Seek indexed without opening IndexedDB.
// Vectors are not duplicated here; they already live in the sidecar, joined by chunkId.

import type { DataAdapter } from 'obsidian';
import { ACTIVE_MODEL_SPEC } from './model-registry';
import { CHUNKER_VERSION } from './chunker';
import type { ChunkMeta } from './types';
import type { FileRecord, IndexStore } from './index-store';

export const EXPORT_SCHEMA_VERSION = 1;
export const EXPORT_DIRNAME = 'Index Export';
export const EXPORT_DOCS_FILE = 'documents.jsonl';
export const EXPORT_META_FILE = 'export.meta.json';
// Used only when the sidecar is off, so there is no index dir to ride along with.
export const FALLBACK_INDEX_DIR = 'Seek Index';

export interface ExportDocument {
    chunkId: string;
    notePath: string;
    title: string;
    content: string;
    chunkIndex: number;
    mtime: number;
    // Everything the ranker and filters read (tags, aliases, props, dates, headings); the flat fields above are for readers that only display.
    meta: ChunkMeta;
}

export interface ExportMeta {
    schemaVersion: number;
    generation: string;
    modelId: string;
    revision: string;
    chunkerVersion: number;
    dimension: number;
    chunkCount: number;
}

export const serializeDocuments = (docs: readonly ExportDocument[]): string => docs.map(d => `${JSON.stringify(d)}\n`).join('');
export const serializeMeta = (meta: ExportMeta): string => JSON.stringify(meta, null, 2);

export async function exportIndex(adapter: DataAdapter, store: IndexStore, indexDir: string | null = null): Promise<ExportMeta> {
    const dir = `${indexDir ?? FALLBACK_INDEX_DIR}/${EXPORT_DIRNAME}`;
    const metas = await store.listAllMeta();
    const [bodies, files] = await Promise.all([store.getBodiesMap(metas.map(m => m.chunk_id)), store.listFileRecords()]);
    const fileByChunk = new Map<string, { file: FileRecord; index: number }>();
    for (const file of files) file.chunk_ids.forEach((id, index) => fileByChunk.set(id, { file, index }));

    const documents: ExportDocument[] = metas.map(meta => {
        const at = fileByChunk.get(meta.chunk_id);
        const content = bodies.get(meta.chunk_id);
        // A half-joined export would silently drop notes; fail loudly instead.
        if (!at || content === undefined) throw new Error(`incomplete export join for ${meta.chunk_id}`);
        return { chunkId: meta.chunk_id, notePath: at.file.note_path, title: meta.title, content, chunkIndex: at.index, mtime: at.file.mtimeMs, meta };
    });
    const generation = `${Date.now()}-${documents.length}`;
    const exportMeta: ExportMeta = {
        schemaVersion: EXPORT_SCHEMA_VERSION,
        generation,
        modelId: ACTIVE_MODEL_SPEC.repo,
        revision: ACTIVE_MODEL_SPEC.revision ?? 'main',
        chunkerVersion: CHUNKER_VERSION,
        dimension: ACTIVE_MODEL_SPEC.dim,
        chunkCount: documents.length,
    };
    // Write beside, then swap, so a reader never sees a half-written export.
    const temp = `${dir}.tmp-${generation}`;
    await adapter.mkdir(temp);
    await adapter.write(`${temp}/${EXPORT_DOCS_FILE}`, serializeDocuments(documents));
    await adapter.write(`${temp}/${EXPORT_META_FILE}`, serializeMeta(exportMeta));
    if (await adapter.exists(dir)) await adapter.remove(dir);
    await adapter.rename(temp, dir);
    return exportMeta;
}
