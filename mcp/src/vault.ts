import { join, resolve } from 'node:path';
import { SeekIndex } from './index.ts';

export async function loadVaultIndex(vaultDir: string): Promise<SeekIndex> {
  const vaultRoot = resolve(vaultDir);
  const candidates = [
    join(vaultRoot, '.obsidian/plugins/seek/index'),
    join(vaultRoot, 'Seek Index'),
  ];
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      return await SeekIndex.load(candidate);
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`no valid Seek index found in vault; checked ${errors.join('; ')}`);
}