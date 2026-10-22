// fork 1.1.3 new; relates to src/main.ts:137 SeekPlugin (the Obsidian ports of the index lifecycle; this file is the Node answer to the same list)
// Runs core's IndexLifecycle for one vault: edit queues, flush, catch-up, identity heal and reconcile poll behave as in the plugin. Opt-in
// (SEEK_MCP_WATCH=1) because a watcher that embeds in the background is a battery decision, not a default.
import { statSync, watch, type FSWatcher } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { IndexLifecycle, type LifecyclePorts } from '../../core/index-lifecycle.ts';
import { pluginIdentity } from '../../core/identity.ts';
import type { SeekSettings } from '../../core/types.ts';
import type { BotHost } from './bot-host.ts';
import { DB_VERSION_BOT } from './bot-host.ts';
import type { NodeIndexStore } from './node-index-store.ts';
import type { SeekLogger } from '../../core/logger.ts';

export function botLifecycle(vaultDir: string, host: BotHost, store: NodeIndexStore, logger: SeekLogger, settings: SeekSettings): IndexLifecycle {
  const ports: LifecyclePorts = {
    host, store, logger, settings,
    mobile: false,
    hidden: () => false,
    embedderLoaded: () => true,
    notify: m => console.warn(`[seek] ${m}`),
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    clearTimer: h => clearTimeout(h as ReturnType<typeof setTimeout>),
    pushTaskContext: () => {}, popTaskContext: () => {},
    ensureModelLoaded: async () => {},
    overrideActive: () => false,
    identity: () => pluginIdentity(DB_VERSION_BOT),
    newPacer: () => ({ pace: () => new Promise<void>(r => setTimeout(r, 0)) }),
    mtimeOf: p => { try { return statSync(join(vaultDir, p)).mtimeMs; } catch { return -1; } },
    isIndexing: () => host.isWriting(),
    confirm: async () => true,
    afterFullReindex: async () => {},
  };
  return new IndexLifecycle(ports);
}

const indexable = (p: string, bases: boolean): boolean => p.endsWith('.md') || (bases && p.endsWith('.base'));
const hidden = (p: string): boolean => p.split('/').some(seg => seg.startsWith('.') || seg === 'node_modules');

// fork 1.1.3 new; relates to src/main.ts:1452 SeekPlugin.wireIncrementalIndexing (Obsidian's vault events; here fs.watch, recursive where the platform allows)
export function watchVault(vaultDir: string, life: IndexLifecycle, settings: SeekSettings): { stop(): void } {
  const w: FSWatcher = watch(vaultDir, { recursive: true }, (_ev, name) => {
    if (!name) return;
    const p = name.split(sep).join('/');
    if (hidden(p) || !indexable(p, settings.indexBases)) return;
    const mtime = (() => { try { return statSync(join(vaultDir, p)).mtimeMs; } catch { return -1; } })();
    if (mtime < 0) life.onDelete(p); else void life.enqueueIfDirty(p, mtime);
  });
  w.on('error', e => console.warn('[seek] vault watcher stopped:', e instanceof Error ? e.message : e));
  const poll = setInterval(() => void life.periodicReconcile(), 5 * 60 * 1000);
  poll.unref?.();
  return { stop: () => { w.close(); clearInterval(poll); } };
}
