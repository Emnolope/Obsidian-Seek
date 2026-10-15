// The "MCP Export" manifest: which chunk (id) lives in which note, with its text.
// The plugin writes it, the MCP server reads it; the vectors themselves come from
// the sidecar (format.ts), joined by chunkId. Pure — callers do the file I/O.

import { EXPORT_SCHEMA_VERSION } from './contract.ts';

export const EXPORT_DIRNAME = 'MCP Export';
export const EXPORT_DOCS_FILE = 'documents.jsonl';
export const EXPORT_META_FILE = 'export.meta.json';

export interface ExportDocument {
    chunkId: string;
    notePath: string;
    title: string;
    content: string;
    chunkIndex: number;
    mtime: number;
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

export function serializeDocuments(docs: readonly ExportDocument[]): string {
    return docs.map(d => `${JSON.stringify(d)}\n`).join('');
}

export function serializeMeta(meta: ExportMeta): string {
    return JSON.stringify(meta, null, 2);
}

export function parseMeta(text: string): ExportMeta {
    const meta = JSON.parse(text) as ExportMeta;
    if (meta.schemaVersion !== EXPORT_SCHEMA_VERSION) {
        throw new Error(`unsupported export schema ${meta.schemaVersion} (expected ${EXPORT_SCHEMA_VERSION})`);
    }
    return meta;
}

// A note path is vault-relative: no leading slash, no `..` segment.
export function isSafeNotePath(p: string): boolean {
    return !!p && !p.startsWith('/') && !p.split('/').includes('..');
}

export function parseDocuments(text: string): ExportDocument[] {
    const seen = new Set<string>();
    const docs: ExportDocument[] = [];
    for (const line of text.split('\n')) {
        if (!line) continue;
        const d = JSON.parse(line) as ExportDocument;
        if (!d.chunkId || seen.has(d.chunkId)) throw new Error(`duplicate chunk id: ${d.chunkId}`);
        if (!isSafeNotePath(d.notePath)) throw new Error(`invalid note path: ${d.notePath}`);
        seen.add(d.chunkId);
        docs.push(d);
    }
    return docs;
}
