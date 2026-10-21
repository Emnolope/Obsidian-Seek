// fork 1.1.3 new; relates to src/main.ts:305 SeekPlugin.onload (device id, logger), src/logger.ts:196 SeekLogger (botLogger) and src/search.ts:1557 SearchOrchestrator.indexableFiles (vaultFiles)
// BASE layer for the bot: the Node-side answers to what Obsidian gives the plugin for free
// (app state dir, device id, vault file listing, file reads, log stream). Core never sees any of this.
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FileAdapter } from '../../core/file-adapter.ts';
import type { LiveFile } from '../../core/delta.ts';

// The bot's IndexedDB-equivalent lives here, never in the vault. One dir per vault, like IDB's per-vault scope.
export function stateDirFor(vaultDir: string, env: Record<string, string | undefined> = process.env): string {
    const key = createHash('sha1').update(resolve(vaultDir)).digest('hex').slice(0, 12);
    const base = env.SEEK_MCP_STATE ?? join(env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'seek-mcp');
    return join(base, key);
}

// Per-install id in the same shape as the plugin's mobile-/desktop- ids; it names this device's sidecar shard.
export async function botDeviceId(state: FileAdapter): Promise<string> {
    const f = 'device-id';
    if (await state.exists(f)) { const v = (await state.read(f)).trim(); if (/^bot-[0-9a-f]{8}$/.test(v)) return v; }
    const id = `bot-${randomBytes(4).toString('hex')}`;
    await state.write(f, id);
    return id;
}

const SKIP = new Set(['node_modules']);

// .md plus .base when asked (mirrors SearchOrchestrator.indexableFiles); dot-dirs (.obsidian, .git, .trash) are never notes.
export async function vaultFiles(root: string, opts: { indexBases?: boolean } = {}): Promise<LiveFile<string>[]> {
    const out: LiveFile<string>[] = [];
    const walk = async (rel: string): Promise<void> => {
        for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
            if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
            const p = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) await walk(p);
            else if (e.name.endsWith('.md') || (opts.indexBases && e.name.endsWith('.base'))) {
                out.push({ path: p, mtime: (await stat(join(root, p))).mtimeMs, handle: p });
            }
        }
    };
    await walk('');
    return out;
}

export const readVaultFile = (root: string) => (f: LiveFile<string>): Promise<string> => readFile(join(root, f.handle), 'utf8');

// Same stream the plugin's Logger writes (seek-log-<deviceId>.ndjson), so the human's log report sees the bot's passes too.
export function botLogger(vault: FileAdapter, deviceId: string) {
    const dir = '.obsidian/plugins/seek/logs';
    const path = `${dir}/seek-log-${deviceId}.ndjson`;
    const sessionId = randomBytes(4).toString('hex');
    let q: Promise<void> = Promise.resolve();
    const write = (row: object): Promise<void> => {
        const line = JSON.stringify({ ...row, deviceId, sessionId }) + '\n';
        q = q.then(async () => { try { if (!(await vault.exists(dir))) await vault.mkdir(dir); await vault.append(path, line); } catch { /* logging never fails a pass */ } });
        return q;
    };
    return {
        deviceId,
        append: (entry: object) => write(entry),
        appendError: (context: string, e: unknown) => {
            console.error(`[seek] error in "${context}":`, e);
            return write({ type: 'error', timestamp: new Date().toISOString(), context, message: e instanceof Error ? e.message : String(e) });
        },
    };
}
