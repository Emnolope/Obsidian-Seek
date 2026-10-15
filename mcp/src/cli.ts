import { SeekQueryEmbedder } from './query-embedder.ts';
import { loadVaultIndex } from './vault.ts';

const queryEmbedder = new SeekQueryEmbedder();

const usage = `Usage:
  seek-mcp status <vaultDir> [--json]
  seek-mcp embed <query> [--json]
  seek-mcp search <vaultDir> <query> [--top-k N] [--path-prefix PREFIX] [--json]
  seek-mcp search <vaultDir> --vector <comma-separated values> [--top-k N] [--path-prefix PREFIX] [--json]
  seek-mcp chunk <vaultDir> <chunkId> [--json]
  seek-mcp note <vaultDir> <notePath> [--json]
`;

interface Arguments {
  command: string;
  positional: string[];
  options: Map<string, string>;
  json: boolean;
}

function parseArguments(argv: string[]): Arguments {
  const positional: string[] = [];
  const options = new Map<string, string>();
  let json = false;
  for (let index = 2; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      positional.push(argument);
    } else if (argument === '--json') {
      json = true;
    } else if (argument.startsWith('--')) {
      const name = argument.slice(2);
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`option requires a value: ${argument}`);
      options.set(name, value);
    } else {
      positional.push(argument);
    }
  }
  return { command: positional.shift() ?? 'help', positional, options, json };
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

function formatStatus(status: ReturnType<Awaited<ReturnType<typeof loadVaultIndex>>['status']>): string {
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
  const minimumPositionals = args.command === 'status' || (args.command === 'search' && args.options.has('vector')) ? 1 : 2;
  const [vaultDir, value] = requiredPositionals(args, minimumPositionals);
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
    const vector = queryVector ?? Array.from(await queryEmbedder.embed(queryText!));
    const hits = index.search(vector, topK, args.options.get('path-prefix'));
    print(args.json ? hits : hits.map((hit, hitIndex) => `#${hitIndex + 1} ${hit.score.toFixed(4)}\n${formatDocument(hit)}`).join('\n\n'), args.json);
    return;
  }
  if (args.command === 'chunk') {
    const chunk = index.chunk(value);
    print(args.json ? chunk : formatDocument(chunk), args.json);
    return;
  }
  if (args.command === 'note') {
    const chunks = index.note([value, ...args.positional.slice(1)].join(' '));
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