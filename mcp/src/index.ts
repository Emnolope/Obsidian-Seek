import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { runSearch } from '../../core/engine.ts';
import { MemoryHost, resolveSettings } from '../../core/memory-host.ts';
import type { SeekSettings } from '../../core/types.ts';
import { EXPORT_DIRNAME, EXPORT_DOCS_FILE, EXPORT_META_FILE, parseDocuments, parseMeta, type ExportDocument, type ExportMeta } from '../../core/export.ts';
import { readRecordAt, scanJsonl, SIDECAR_FORMAT } from './sidecar.ts';

export type { ExportMeta };

export interface DocumentRecord extends ExportDocument {
  q: Int8Array;
  s: number;
}

// What callers see: no vectors (384 floats per hit is pure token waste for an agent), but the ranking signals that explain the order.
export interface SearchHit {
  chunkId: string;
  notePath: string;
  title: string;
  chunkIndex: number;
  snippet: string;
  content: string;
  score: number;
  signals: Record<string, number>;
}

export interface SearchQuery {
  text?: string;
  // Overrides the embedder (the text still drives lexical ranking). With no text it degrades to dense-only cosine.
  vector?: number[];
  embed?: (text: string) => Promise<Float32Array>;
  topK?: number;
  pathPrefix?: string;
}

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

// Strips the int8 vector so fetch results stay readable and small.
function plain({ q: _q, s: _s, ...rest }: DocumentRecord): ExportDocument { return rest; }

export class SeekIndex {
  readonly root: string;
  readonly meta: ExportMeta;
  readonly documents: DocumentRecord[];
  readonly diagnostics: LoadDiagnostics;

  private host: MemoryHost;
  // Per-call embedder; safe because the server handles one request at a time. Lives here because MemoryHost is built once so BM25 is fit once.
  private embedNow: (text: string) => Promise<Float32Array> = async () => { throw new Error('no embedder supplied'); };

  private constructor(
    root: string,
    meta: ExportMeta,
    documents: DocumentRecord[],
    diagnostics: LoadDiagnostics,
    settings: SeekSettings,
    numericKeys: Set<string>,
  ) {
    this.root = root;
    this.meta = meta;
    this.documents = documents;
    this.diagnostics = diagnostics;
    this.host = new MemoryHost(
      documents.map(d => ({ meta: d.meta, content: d.content, vec: { q: d.q, s: d.s } })),
      settings,
      t => this.embedNow(t),
      numericKeys,
    );
  }

  // pluginSettings = the plugin's data.json, so the bot ranks with the human's knobs; numericKeys = Obsidian's declared Number properties.
  static async load(root: string, opts: { pluginSettings?: unknown; numericKeys?: Set<string> } = {}): Promise<SeekIndex> {
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
      if (tier.q.length !== meta.dimension) throw new Error(`dimension mismatch for chunk: ${document.chunkId}`);
      document.q = tier.q;
      document.s = tier.s;
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
    }, resolveSettings(opts.pluginSettings), opts.numericKeys ?? new Set());
  }

  status() {
    return { ...this.meta, loadedChunks: this.documents.length, diagnostics: this.diagnostics };
  }

  async search(query: SearchQuery): Promise<SearchHit[]> {
    const topK = query.topK ?? 10;
    if (!Number.isInteger(topK) || topK < 1 || topK > 100) throw new Error('topK must be between 1 and 100');
    const { vector, text, embed } = query;
    if (vector && vector.length !== this.meta.dimension) throw new Error(`query vector must have dimension ${this.meta.dimension}`);
    if (!vector && !text?.trim()) throw new Error('search needs query text or a query vector');
    this.embedNow = vector ? async () => Float32Array.from(vector) : embed ?? this.embedNow;
    // Vector-only has no lexical text; the filter-only (browse) branch would swallow it, so give the engine a placeholder term. BM25 on it is noise next to a dense score at alpha, and no real term should ever equal it.
    const run = text?.trim() ? text : '\u2063';
    // pathPrefix is applied after ranking, so over-fetch to still return topK.
    const want = query.pathPrefix ? 100 : topK;
    const { results } = await runSearch(this.host, run, want);
    const at = new Map(this.documents.map(d => [d.chunkId, d.chunkIndex]));
    return results
      .filter(r => !query.pathPrefix || r.note_path.startsWith(query.pathPrefix))
      .slice(0, topK)
      .map(r => ({
        chunkId: r.chunk_id, notePath: r.note_path, title: r.title,
        chunkIndex: at.get(r.chunk_id) ?? 0,
        snippet: r.snippet ?? '', content: r.content, score: r.score,
        signals: r.ranking_signals as unknown as Record<string, number>,
      }));
  }

  chunk(chunkId: string): ExportDocument {
    const document = this.documents.find(candidate => candidate.chunkId === chunkId);
    if (!document) throw new Error(`chunk not found: ${chunkId}`);
    return plain(document);
  }

  note(notePath: string): ExportDocument[] {
    confined(this.root, notePath);
    return this.documents.filter(document => document.notePath === notePath).map(plain);
  }
}