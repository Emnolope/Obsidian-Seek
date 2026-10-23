// fork 1.1.3 new; no counterpart: the plugin has one index, the bot has two sources (its own live store, else the human's export snapshot) and both front ends (server.ts, cli.ts) must pick the same one.
import type { BotReader } from './bot-reader.ts';
import type { BotSession } from './bot-session.ts';

// The bot's own index wins once it has chunks (so what it just indexed is searchable); until then the human's export snapshot answers.
export async function liveReader(s: BotSession, args: { queryVector?: unknown; queryText?: unknown }): Promise<BotReader | null> {
  if ((await s.store.count()).chunks === 0) return null;
  // A query vector alongside text overrides the embedder, which only the snapshot path supports.
  if (args.queryVector !== undefined && typeof args.queryText === 'string' && args.queryText.trim()) return null;
  return s.reader;
}

export async function readFrom(r: BotReader, name: string, args: any): Promise<unknown> {
  const withVec = args.includeVectors === true;
  if (name === 'index_status') return r.status();
  if (name === 'semantic_search') {
    if (args.queryVector === undefined && typeof args.queryText !== 'string') throw new Error('semantic_search requires queryText or queryVector');
    return r.search({ text: args.queryText, vector: args.queryVector, topK: args.topK, pathPrefix: args.pathPrefix, includeVectors: withVec });
  }
  if (name === 'fetch_chunk') return r.chunk(args.chunkId, withVec);
  if (name === 'fetch_note') return r.note(args.notePath, withVec);
  throw new Error(`unknown tool: ${name}`);
}
