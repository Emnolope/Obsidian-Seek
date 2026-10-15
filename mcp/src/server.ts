import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { SeekQueryEmbedder } from './query-embedder.ts';
import { loadVaultIndex } from './vault.ts';
import { SeekIndex } from './index.ts';

const queryEmbedder = new SeekQueryEmbedder();
const indexes = new Map<string, Promise<SeekIndex>>();

function result(value: unknown) { return { content: [{ type: 'text', text: JSON.stringify(value) }] }; }
function error(message: string) { return { isError: true, content: [{ type: 'text', text: message }] }; }
function success(id: unknown, value: unknown) { return { jsonrpc: '2.0', id, result: value }; }
function failure(id: unknown, code: number, message: string) { return { jsonrpc: '2.0', id, error: { code, message } }; }

function getIndex(vaultDir: unknown): Promise<SeekIndex> {
  if (typeof vaultDir !== 'string' || !vaultDir.trim()) {
    throw new Error('vaultDir is required and must point to an Obsidian vault directory');
  }
  const root = resolve(vaultDir);
  let index = indexes.get(root);
  if (!index) {
    index = loadVaultIndex(root);
    indexes.set(root, index);
  }
  return index;
}

async function handle(message: any): Promise<any> {
  if (message.method === 'initialize') return success(message.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'obsidian-seek-mcp', version: '1.0.0' } });
  if (message.method === 'notifications/initialized') return undefined;
  if (message.method === 'tools/list') return success(message.id, { tools: [
    { name: 'index_status', description: 'Return Seek export metadata and load status for an Obsidian vault.', inputSchema: { type: 'object', required: ['vaultDir'], properties: { vaultDir: { type: 'string', description: 'Absolute or relative path to an Obsidian vault directory.' } } } },
    { name: 'semantic_search', description: 'Rank Seek chunks from an Obsidian vault by cosine similarity to query text or a precomputed query vector.', inputSchema: { type: 'object', required: ['vaultDir'], properties: { vaultDir: { type: 'string', description: 'Absolute or relative path to an Obsidian vault directory.' }, queryText: { type: 'string' }, queryVector: { type: 'array', items: { type: 'number' } }, topK: { type: 'integer', minimum: 1, maximum: 100 }, pathPrefix: { type: 'string' } } } },
    { name: 'fetch_chunk', description: 'Fetch one indexed chunk from an Obsidian vault by ID.', inputSchema: { type: 'object', required: ['vaultDir', 'chunkId'], properties: { vaultDir: { type: 'string', description: 'Absolute or relative path to an Obsidian vault directory.' }, chunkId: { type: 'string' } } } },
    { name: 'fetch_note', description: 'Fetch all indexed chunks for a vault-relative note path from an Obsidian vault.', inputSchema: { type: 'object', required: ['vaultDir', 'notePath'], properties: { vaultDir: { type: 'string', description: 'Absolute or relative path to an Obsidian vault directory.' }, notePath: { type: 'string' } } } },
  ] });
  if (message.method !== 'tools/call') return message.id === undefined ? undefined : failure(message.id, -32601, 'method not found');
  try {
    const args = message.params?.arguments ?? {};
    const index = await getIndex(args.vaultDir);
    if (message.params.name === 'semantic_search' && args.queryVector === undefined && typeof args.queryText !== 'string') {
      throw new Error('semantic_search requires queryText or queryVector');
    }
    const value = message.params.name === 'index_status' ? index.status()
      : message.params.name === 'semantic_search' ? index.search(
        args.queryVector ?? Array.from(await queryEmbedder.embed(args.queryText)),
        args.topK,
        args.pathPrefix,
      )
      : message.params.name === 'fetch_chunk' ? index.chunk(args.chunkId)
      : message.params.name === 'fetch_note' ? index.note(args.notePath)
      : (() => { throw new Error(`unknown tool: ${message.params.name}`); })();
    return success(message.id, result(value));
  } catch (e) { return success(message.id, error(e instanceof Error ? e.message : String(e))); }
}

const input = createInterface({ input: process.stdin });
for await (const line of input) {
  if (!line.trim()) continue;
  const response = await handle(JSON.parse(line));
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
}