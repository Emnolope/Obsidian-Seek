import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { numericKeysFromTypesJson } from '../../core/memory-host.ts';
import { SeekIndex } from './index.ts';

export async function loadVaultIndex(vaultDir: string): Promise<SeekIndex> {
  const vaultRoot = resolve(vaultDir);
  const candidates = [
    join(vaultRoot, '.obsidian/plugins/seek/index'),
    join(vaultRoot, 'Seek Index'),
  ];
  const json = async (p: string): Promise<unknown> => { try { return JSON.parse(await readFile(join(vaultRoot, p), 'utf8')); } catch { return undefined; } };
  // Both are optional: without them we rank with defaults and treat no property as numeric.
  const opts = {
    pluginSettings: await json('.obsidian/plugins/seek/data.json'),
    numericKeys: numericKeysFromTypesJson(await json('.obsidian/types.json')),
  };
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      return await SeekIndex.load(candidate, opts);
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`no valid Seek index found in vault; checked ${errors.join('; ')}`);
}