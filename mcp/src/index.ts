import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { dequantizeInt8 } from '../../core/quant.ts';
import { EXPORT_DIRNAME, EXPORT_DOCS_FILE, EXPORT_META_FILE, parseDocuments, parseMeta, type ExportDocument, type ExportMeta } from '../../core/export.ts';
import { readRecordAt, scanJsonl, SIDECAR_FORMAT } from './sidecar.ts';

export type { ExportMeta };

export interface DocumentRecord extends ExportDocument {
  q: number[];
  s: number;
  vector: number[];
}

export interface SearchHit extends DocumentRecord { score: number }

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ MCP ADAPTER CODE: new Node-side diagnostics; no direct Seek counterpart. │
// │ Keep this block visible when porting changes from the plugin.              │
// └─────────────────────────────────────────────────────────────────────────┘
export interface LoadDiagnostics {
  exportedDocuments: number;
  loadedDocuments: number;
  skippedDocuments: number;
  orphanVectors: number;
}

function confined(root: string, notePath: string): string {
  const path = resolve(root, notePath);
  const rel = relative(resolve(root), path);
  if (!rel || rel.startsWith('..') || rel.includes(`..${'/'}`) || resolve(root, rel) !== path) {
    throw new Error(`path escapes vault root: ${notePath}`);
  }
  return path;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

export class SeekIndex {
  readonly root: string;
  readonly meta: ExportMeta;
  readonly documents: DocumentRecord[];
  readonly diagnostics: LoadDiagnostics;

  private constructor(
    root: string,
    meta: ExportMeta,
    documents: DocumentRecord[],
    diagnostics: LoadDiagnostics,
  ) {
    this.root = root;
    this.meta = meta;
    this.documents = documents;
    this.diagnostics = diagnostics;
  }

  static async load(root: string): Promise<SeekIndex> {
    const exportRoot = resolve(root);
    const documentRoot = join(exportRoot, EXPORT_DIRNAME);
    const meta = parseMeta(await readFile(join(documentRoot, EXPORT_META_FILE), 'utf8'));
    const metaName = (await readdir(exportRoot)).find(name => /^meta\.[A-Za-z0-9-]+\.json$/.test(name));
    if (!metaName) throw new Error('Seek sidecar metadata not found');
    const sidecarMeta = JSON.parse(await readFile(join(exportRoot, metaName), 'utf8')) as { dim: number; format: number };
    if (sidecarMeta.format !== SIDECAR_FORMAT || sidecarMeta.dim !== meta.dimension) {
      throw new Error('unsupported or invalid Seek export metadata');
    }
    const { map: entries } = await scanJsonl(exportRoot);
    const exported = parseDocuments(await readFile(join(documentRoot, EXPORT_DOCS_FILE), 'utf8'));
    const documents: DocumentRecord[] = [];
    const ids = new Set<string>();
    let skippedDocuments = 0;
    for (const exportedDoc of exported) {
      const document = exportedDoc as DocumentRecord;
      const entry = entries.get(document.chunkId);
      // ┌───────────────────────────────────────────────────────────────────┐
      // │ MCP ADAPTER CODE: fuzzy-search tolerance. A stale document mapping │
      // │ is skipped; usable vector/document pairs remain searchable.        │
      // │ Do not copy this behavior back into Seek's strict export writer.    │
      // └───────────────────────────────────────────────────────────────────┘
      if (!entry) {
        skippedDocuments++;
        continue;
      }
      const tier = await readRecordAt(exportRoot, entry);
      const vector = Array.from(dequantizeInt8(tier.q, tier.s));
      if (vector.length !== meta.dimension) throw new Error(`dimension mismatch for chunk: ${document.chunkId}`);
      document.vector = vector;
      ids.add(document.chunkId);
      documents.push(document);
    }
    // MCP ADAPTER CODE: do not reject a partial/stale generation on count
    // mismatch. Report the mismatch through index_status diagnostics instead.
    return new SeekIndex(exportRoot, meta, documents, {
      exportedDocuments: exported.length,
      loadedDocuments: documents.length,
      skippedDocuments,
      orphanVectors: Math.max(0, entries.size - documents.length),
    });
  }

  status() {
    return { ...this.meta, loadedChunks: this.documents.length, diagnostics: this.diagnostics };
  }

  search(queryVector: number[], topK = 10, pathPrefix?: string): SearchHit[] {
    if (queryVector.length !== this.meta.dimension) throw new Error(`query vector must have dimension ${this.meta.dimension}`);
    if (!Number.isInteger(topK) || topK < 1 || topK > 100) throw new Error('topK must be between 1 and 100');
    return this.documents
      .filter(document => !pathPrefix || document.notePath.startsWith(pathPrefix))
      .map(document => ({ ...document, score: cosine(queryVector, document.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  chunk(chunkId: string): DocumentRecord {
    const document = this.documents.find(candidate => candidate.chunkId === chunkId);
    if (!document) throw new Error(`chunk not found: ${chunkId}`);
    return document;
  }

  note(notePath: string): DocumentRecord[] {
    confined(this.root, notePath);
    return this.documents.filter(document => document.notePath === notePath);
  }
}