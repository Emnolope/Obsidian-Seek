// fork 1.1.3 new; relates to src/main.ts:305 SeekPlugin.onload (device id, logger), src/logger.ts:196 SeekLogger (botLogger) and src/search.ts:1557 SearchOrchestrator.indexableFiles (vaultFiles)
// BASE layer for the bot: the Node-side answers to what Obsidian gives the plugin for free
// (app state dir, device id, vault file listing, file reads, log stream). Core never sees any of this.
import { createHash, randomBytes } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FileAdapter } from '../../core/file-adapter.ts';
import type { LiveFile } from '../../core/delta.ts';
import { SeekLogger, DEVICE_ID_KEY } from '../../core/logger.ts';

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

// The plugin's own logger over the bot's ports, so both write one stream (seek-log-<deviceId>.ndjson) and the human's report reads the bot's passes too.
// The bot's device id is the one botDeviceId minted, served through the logger's per-origin store.
export function botLogger(vault: FileAdapter, deviceId: string): SeekLogger {
    const kv = new Map<string, string>([[DEVICE_ID_KEY, deviceId]]);
    return new SeekLogger({ adapter: vault, device: { get: k => kv.get(k) ?? null, set: (k, v) => { kv.set(k, v); }, remove: k => { kv.delete(k); } }, platform: 'bot' }, 'seek');
}

// Obsidian hands the plugin parseYaml; Node has no equivalent, so the bot ships the `yaml` package for .base files.
export function botParseYaml(raw: string): unknown { return parseYaml(raw); }

// Where the sidecar's Chromium keeps its profile, and with it whatever model bytes the browser cached. The bot's stand-in for the plugin's Cache API.
// Overridable so tests never touch a real profile.
export const chromiumProfile = (): string => process.env.SEEK_MCP_CHROMIUM_PROFILE ?? '/tmp/obsidian-seek-mcp-chromium';
// A fresh headless profile is a few MB; the quantized Granite model is ~100 MB. This tells "the model is in there" from "Chromium ran once".
export const MODEL_PRESENT_MB = 50;

export async function footprint(dir: string): Promise<{ bytes: number; files: number }> {
    let bytes = 0, files = 0;
    const walk = async (d: string): Promise<void> => {
        for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
            const p = join(d, e.name);
            if (e.isDirectory()) await walk(p);
            else { files++; bytes += (await stat(p).catch(() => null))?.size ?? 0; }
        }
    };
    await walk(dir);
    return { bytes, files };
}

export async function removeDir(dir: string): Promise<number> {
    const { files } = await footprint(dir);
    await rm(dir, { recursive: true, force: true });
    return files;
}
