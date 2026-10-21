// fork 1.1.3 new; relates to src/main.ts:305 SeekPlugin.onload (assembles settings, store, logger and orchestrator for one vault)
// Opens one vault for writing: state dir + persisted store + BotHost. Mirrors what the plugin's onload assembles.
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { numericKeysFromTypesJson, resolveSettings } from '../../core/memory-host.ts';
import { BotHost } from './bot-host.ts';
import { BotReader } from './bot-reader.ts';
import { botLifecycle, watchVault } from './bot-lifecycle.ts';
import type { IndexLifecycle } from '../../core/index-lifecycle.ts';
import { BotEmbedder, type BatchSidecar } from './bot-embedder.ts';
import { NodeIndexStore } from './node-index-store.ts';
import { nodeFileAdapter } from './node-file-adapter.ts';
import { botDeviceId, botLogger, stateDirFor } from './base.ts';

export interface BotSession { host: BotHost; store: NodeIndexStore; reader: BotReader; life: IndexLifecycle; deviceId: string }

export async function openBotSession(vaultDir: string, sidecar: BatchSidecar): Promise<BotSession> {
  const root = resolve(vaultDir);
  const stateDir = stateDirFor(root);
  await mkdir(stateDir, { recursive: true });
  const state = nodeFileAdapter(stateDir);
  const vault = nodeFileAdapter(root);
  const deviceId = await botDeviceId(state);
  let raw: unknown;
  try { raw = JSON.parse(await readFile(join(root, '.obsidian/plugins/seek/data.json'), 'utf8')); } catch { /* defaults */ }
  let types: unknown;
  try { types = JSON.parse(await readFile(join(root, '.obsidian/types.json'), 'utf8')); } catch { /* none: no numeric props */ }
  const store = new NodeIndexStore(`seek-index:${deviceId}`, state);
  await store.open();
  const settings = resolveSettings(raw);
  const logger = botLogger(vault, deviceId);
  const host = new BotHost({ vaultDir: root, vault, stateDir, store, embedder: new BotEmbedder(sidecar), logger, settings, numericKeys: numericKeysFromTypesJson(types) });
  const life = botLifecycle(root, host, store, logger, settings);
  // Opt-in: a watcher that embeds in the background is the user's call (battery), not a default.
  if (process.env.SEEK_MCP_WATCH === '1') { await life.reconcileOnLoad(); watchVault(root, life, settings); }
  return { host, store, reader: new BotReader(host, store), life, deviceId };
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
