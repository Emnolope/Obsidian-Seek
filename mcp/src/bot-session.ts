// Opens one vault for writing: state dir + persisted store + BotHost. Mirrors what the plugin's onload assembles.
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resolveSettings } from '../../core/memory-host.ts';
import { BotHost } from './bot-host.ts';
import { BotEmbedder, type BatchSidecar } from './bot-embedder.ts';
import { NodeIndexStore } from './node-index-store.ts';
import { nodeFileAdapter } from './node-file-adapter.ts';
import { botDeviceId, botLogger, stateDirFor } from './base.ts';

export interface BotSession { host: BotHost; store: NodeIndexStore; deviceId: string }

export async function openBotSession(vaultDir: string, sidecar: BatchSidecar): Promise<BotSession> {
  const root = resolve(vaultDir);
  const stateDir = stateDirFor(root);
  await mkdir(stateDir, { recursive: true });
  const state = nodeFileAdapter(stateDir);
  const vault = nodeFileAdapter(root);
  const deviceId = await botDeviceId(state);
  let raw: unknown;
  try { raw = JSON.parse(await readFile(join(root, '.obsidian/plugins/seek/data.json'), 'utf8')); } catch { /* defaults */ }
  const store = new NodeIndexStore(`seek-index:${deviceId}`, state);
  await store.open();
  const host = new BotHost({ vaultDir: root, vault, stateDir, store, embedder: new BotEmbedder(sidecar), logger: botLogger(vault, deviceId), settings: resolveSettings(raw) });
  return { host, store, deviceId };
}

// The write verbs the MCP exposes; each is the human command's twin and ends by flushing the local store to disk.
export async function runWrite(s: BotSession, op: string): Promise<unknown> {
  try {
    if (op === 'index_vault') return await s.host.reindexAll();
    if (op === 'index_delta') {
      const d = await s.host.computeDelta();
      return { delta: { dirty: d.dirty.length, deleted: d.deleted.length }, ...(await s.host.reindexDelta(d.dirty, d.deleted, { embed: true })) };
    }
    if (op === 'hydrate_sidecar') return await s.host.reconcileSidecarIfChanged() ?? { skipped: 'sidecar unchanged or disabled' };
    if (op === 'compact_sidecar') return { compact: await s.host.compactOwnSidecar(), coalesce: await s.host.coalesceOwnSidecar() };
    throw new Error(`unknown write tool: ${op}`);
  } finally { await s.store.flush(); }
}
