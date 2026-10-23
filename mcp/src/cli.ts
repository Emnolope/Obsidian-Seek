import { SeekQueryEmbedder } from './query-embedder.ts';
import { loadVaultIndex } from './vault.ts';
import { openBotSession, runWrite, type BotSession } from './bot-session.ts';
import { liveReader, readFrom } from './bot-route.ts';

const queryEmbedder = new SeekQueryEmbedder();

const usage = `Usage:
  seek-mcp status <vaultDir> [--json]
  seek-mcp embed <query> [--json]
  seek-mcp search <vaultDir> <query> [--top-k N] [--path-prefix PREFIX] [--vectors] [--json]
  seek-mcp search <vaultDir> --vector <comma-separated values> [--top-k N] [--path-prefix PREFIX] [--vectors] [--json]
  seek-mcp chunk <vaultDir> <chunkId> [--vectors] [--json]
  seek-mcp note <vaultDir> <notePath> [--vectors] [--json]
  seek-mcp index <vaultDir> [--json]      full reindex into the bot's own store (runs the model on every note)
  seek-mcp delta <vaultDir> [--json]      embed only changed notes
  seek-mcp hydrate <vaultDir> [--json]    adopt vectors other devices synced, no model
  seek-mcp compact <vaultDir> [--json]    compact and coalesce the bot's sidecar shards
  seek-mcp stats <vaultDir> [--json]      counts, disk footprint, last-index times for the bot's own index
  seek-mcp model <vaultDir> [--json]      is the embedding model on disk
  seek-mcp delete-model <vaultDir>        delete the model the bot's browser cached

Reads (status, search, chunk, note) use the bot's own index once it has chunks, else the human's export snapshot.
`;

interface Arguments {
  command: string;
  positional: string[];
  options: Map<string, string>;
  json: boolean;
  vectors: boolean;
}

function parseArguments(argv: string[]): Arguments {
  const positional: string[] = [];
  const options = new Map<string, string>();
  let json = false;
  let vectors = false;
  for (let index = 2; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      positional.push(argument);
    } else if (argument === '--json') {
      json = true;
    } else if (argument === '--vectors') {
      vectors = true;
    } else if (argument.startsWith('--')) {
      const name = argument.slice(2);
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`option requires a value: ${argument}`);
      options.set(name, value);
    } else {
      positional.push(argument);
    }
  }
  return { command: positional.shift() ?? 'help', positional, options, json, vectors };
}

function requiredPositionals(args: Arguments, count: number): string[] {
  if (args.positional.length < count) throw new Error(`missing argument for ${args.command}\n\n${usage}`);
  return args.positional;
}

function parseTopK(args: Arguments): number | undefined {
  const value = args.options.get('top-k');
  if (value === undefined) return undefined;
  const topK = Number(value);
  if (!Number.isInteger(topK) || topK < 1 || topK > 100) throw new Error('--top-k must be an integer between 1 and 100');
  return topK;
}

function parseVector(value: string): number[] {
  let parsed: unknown;
  try {
    parsed = value.startsWith('[') ? JSON.parse(value) : value.split(',').map(Number);
  } catch {
    throw new Error('--vector must be a comma-separated list or JSON array of numbers');
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(item => typeof item === 'number' && Number.isFinite(item))) {
    throw new Error('--vector must contain only finite numbers');
  }
  return parsed;
}

function print(value: unknown, json: boolean): void {
  process.stdout.write(`${json ? JSON.stringify(value, null, 2) : String(value)}\n`);
}

function formatStatus(status: { modelId: string; revision: string; generation: string; loadedChunks: number; chunkCount: number; dimension: number; diagnostics: unknown }): string {
  return [
    `model: ${status.modelId}`,
    `revision: ${status.revision}`,
    `generation: ${status.generation}`,
    `chunks: ${status.loadedChunks}/${status.chunkCount}`,
    `dimension: ${status.dimension}`,
    `diagnostics: ${JSON.stringify(status.diagnostics)}`,
  ].join('\n');
}

function formatDocument(document: { title: string; notePath: string; content: string; chunkId: string; chunkIndex: number; mtime: number }): string {
  return `${document.title} (${document.notePath}, chunk ${document.chunkIndex}, id ${document.chunkId}, mtime ${document.mtime})\n${document.content}`;
}

const TOOL_FOR: Record<string, string> = { status: 'index_status', search: 'semantic_search', chunk: 'fetch_chunk', note: 'fetch_note' };

// Same routing as the MCP server: the bot's own store answers once it has chunks. Returns false to fall through to the export snapshot.
async function readLive(args: Arguments, vaultDir: string, value: string | undefined): Promise<boolean> {
  const tool = TOOL_FOR[args.command];
  if (!tool) return false;
  const queryVector = args.options.get('vector') ? parseVector(args.options.get('vector')!) : undefined;
  const text = [value, ...args.positional.slice(1)].join(' ');
  const callArgs = {
    includeVectors: args.vectors, queryVector, topK: parseTopK(args), pathPrefix: args.options.get('path-prefix'),
    queryText: args.command === 'search' && !queryVector ? text : undefined, chunkId: value, notePath: text,
  };
  const session: BotSession = await openBotSession(vaultDir, queryEmbedder.chromium);
  const reader = await liveReader(session, callArgs);
  if (!reader) return false;
  const out = await readFrom(reader, tool, callArgs) as any;
  if (args.json) print(out, true);
  else if (args.command === 'status') print(formatStatus(out), false);
  else if (args.command === 'search') print((out as any[]).map((hit, i) => `#${i + 1} ${hit.score.toFixed(4)}\n${formatDocument(hit)}`).join('\n\n'), false);
  else if (args.command === 'chunk') print(formatDocument(out), false);
  else print((out as any[]).map(formatDocument).join('\n\n'), false);
  return true;
}

async function run(args: Arguments): Promise<void> {
  if (args.command === 'help' || args.command === '--help' || args.command === '-h') {
    print(usage.trimEnd(), false);
    return;
  }
  if (args.command === 'embed') {
    const query = args.positional.join(' ');
    if (!query.trim()) throw new Error(`missing argument for embed\n\n${usage}`);
    const vector = Array.from(await queryEmbedder.embed(query));
    print(args.json ? vector : vector.join(','), args.json);
    return;
  }
  const WRITE_OPS: Record<string, string> = { index: 'index_vault', delta: 'index_delta', hydrate: 'hydrate_sidecar', compact: 'compact_sidecar', 'delete-model': 'delete_model' };
  const STAT_OPS: Record<string, 'getIndexStats' | 'getModelStatus'> = { stats: 'getIndexStats', model: 'getModelStatus' };
  if (STAT_OPS[args.command]) {
    const [dir] = requiredPositionals(args, 1);
    print(JSON.stringify(await (await openBotSession(dir, queryEmbedder.chromium)).host[STAT_OPS[args.command]](), null, 2), args.json);
    return;
  }
  if (WRITE_OPS[args.command]) {
    const [dir] = requiredPositionals(args, 1);
    const out = await runWrite(await openBotSession(dir, queryEmbedder.chromium), WRITE_OPS[args.command]);
    print(args.json ? out : JSON.stringify(out, null, 2), args.json);
    return;
  }
  const minimumPositionals = args.command === 'status' || (args.command === 'search' && args.options.has('vector')) ? 1 : 2;
  const [vaultDir, value] = requiredPositionals(args, minimumPositionals);
  if (await readLive(args, vaultDir, value)) return;
  const index = await loadVaultIndex(vaultDir);
  if (args.command === 'status') {
    if (args.positional.length > 1) throw new Error('status accepts only <vaultDir>');
    print(args.json ? index.status() : formatStatus(index.status()), args.json);
    return;
  }
  if (args.command === 'search') {
    const topK = parseTopK(args);
    const queryVector = args.options.get('vector') ? parseVector(args.options.get('vector')!) : undefined;
    const queryText = queryVector ? undefined : [value, ...args.positional.slice(1)].join(' ');
    if (!queryVector && !queryText) throw new Error('search requires a query or --vector');
    const hits = await index.search({ text: queryText, vector: queryVector, embed: t => queryEmbedder.embed(t), topK, pathPrefix: args.options.get('path-prefix'), includeVectors: args.vectors });
    print(args.json ? hits : hits.map((hit, hitIndex) => `#${hitIndex + 1} ${hit.score.toFixed(4)}\n${formatDocument(hit)}`).join('\n\n'), args.json);
    return;
  }
  if (args.command === 'chunk') {
    const chunk = index.chunk(value, args.vectors);
    print(args.json ? chunk : formatDocument(chunk), args.json);
    return;
  }
  if (args.command === 'note') {
    const chunks = index.note([value, ...args.positional.slice(1)].join(' '), args.vectors);
    print(args.json ? chunks : chunks.map(formatDocument).join('\n\n'), args.json);
    return;
  }
  throw new Error(`unknown command: ${args.command}\n\n${usage}`);
}

const args = parseArguments(process.argv);
  run(args).catch(error => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await queryEmbedder.close();
});