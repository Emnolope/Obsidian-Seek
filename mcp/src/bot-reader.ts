// new (our tree, not upstream); relates to src/mcp-export.ts:14 exportMcpIndex (same join of metas, bodies and file records, read live from the bot's store instead of a snapshot)
// The read side over the bot's own store. Same method names and output shapes as SeekIndex, so the server swaps one for the other.
import type { ChunkMeta, ScoredChunk } from '../../core/types.ts';
import type { BotHost } from './bot-host.ts';
import type { NodeIndexStore } from './node-index-store.ts';
import type { FetchedChunk, SearchHit, SearchQuery } from './index.ts';

interface Loc { notePath: string; index: number; mtime: number }

export class BotReader {
  private host: BotHost;
  private store: NodeIndexStore;

  constructor(host: BotHost, store: NodeIndexStore) { this.host = host; this.store = store; }

  // File records carry chunk order and mtime; the chunk rows don't.
  private async where(): Promise<Map<string, Loc>> {
    const m = new Map<string, Loc>();
    for (const f of await this.store.listFileRecords()) f.chunk_ids.forEach((id, index) => m.set(id, { notePath: f.note_path, index, mtime: f.mtimeMs }));
    return m;
  }

  private async vec(id: string): Promise<number[]> {
    return Array.from((await this.store.getEmbeddingsByIds([id]))[0] ?? []);
  }

  async status() {
    const c = await this.store.count();
    const meta = await this.store.getMeta();
    return { source: 'bot-store', loadedChunks: c.chunks, files: c.files, lastIndexedAt: meta.lastIndexedAt, dimension: meta.embeddingDim };
  }

  async search(query: SearchQuery): Promise<SearchHit[]> {
    const topK = query.topK ?? 10;
    if (!Number.isInteger(topK) || topK < 1 || topK > 100) throw new Error('topK must be between 1 and 100');
    const text = query.text?.trim();
    if (!text && !query.vector) throw new Error('search needs query text or a query vector');
    if (query.vector && query.vector.length !== (await this.store.getMeta()).embeddingDim) throw new Error('query vector has the wrong dimension for this index');
    const loc = await this.where();
    // Vector with no text: nothing lexical to fuse, so exact cosine, same as SeekIndex.
    if (!text) return this.shape(await this.host.searchDense(Float32Array.from(query.vector!), topK, query.pathPrefix), loc, query.includeVectors);
    // pathPrefix is applied after ranking, so over-fetch to still return topK.
    const { results } = await this.host.search(text, query.pathPrefix ? 100 : topK);
    return this.shape(results.filter(r => !query.pathPrefix || r.note_path.startsWith(query.pathPrefix)).slice(0, topK), loc, query.includeVectors);
  }

  private shape(hits: ScoredChunk[], loc: Map<string, Loc>, withVectors = false): Promise<SearchHit[]> {
    return Promise.all(hits.map(async r => ({
      chunkId: r.chunk_id, notePath: r.note_path, title: r.title,
      chunkIndex: loc.get(r.chunk_id)?.index ?? 0, mtime: loc.get(r.chunk_id)?.mtime ?? 0,
      snippet: r.snippet ?? '', content: r.content, score: r.score,
      signals: r.ranking_signals as unknown as Record<string, number>,
      ...(withVectors ? { vector: await this.vec(r.chunk_id) } : {}),
    })));
  }

  private async out(meta: ChunkMeta, loc: Loc | undefined, withVector: boolean): Promise<FetchedChunk> {
    const body = (await this.store.getBodiesByIds([meta.chunk_id]))[0] ?? '';
    return {
      chunkId: meta.chunk_id, notePath: meta.note_path, title: meta.title, content: body,
      chunkIndex: loc?.index ?? 0, mtime: loc?.mtime ?? 0,
      ...(withVector ? { vector: await this.vec(meta.chunk_id) } : {}),
    };
  }

  async chunk(chunkId: string, includeVectors = false): Promise<FetchedChunk> {
    const meta = (await this.store.getChunkMetasByIds([chunkId])).get(chunkId);
    if (!meta) throw new Error(`chunk not found: ${chunkId}`);
    return this.out(meta, (await this.where()).get(chunkId), includeVectors);
  }

  async note(notePath: string, includeVectors = false): Promise<FetchedChunk[]> {
    const rec = await this.store.getFileRecord(notePath);
    if (!rec) return [];
    const metas = await this.store.getChunkMetasByIds(rec.chunk_ids);
    const loc = await this.where();
    const out: FetchedChunk[] = [];
    for (const id of rec.chunk_ids) { const m = metas.get(id); if (m) out.push(await this.out(m, loc.get(id), includeVectors)); }
    return out;
  }
}
