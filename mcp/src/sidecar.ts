// Node adapter over the shared format in ../../core/format.ts. All record layout,
// codec and resolution rules live there (the plugin uses the same code); this file
// only does the filesystem reads.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeRecord, isJsonlName, resolveJsonls, shardPathFor, type ResolveResult, type ResolvedEntry, type TierBytes } from '../../core/format.ts';

export * from '../../core/format.ts';

export async function scanJsonl(indexDir: string): Promise<ResolveResult> {
    const names = (await readdir(indexDir)).filter(isJsonlName).sort();
    return resolveJsonls(await Promise.all(names.map(n => readFile(join(indexDir, n), 'utf8'))));
}

// Strict: a missing shard or bad CRC throws (the loader decides what to skip).
export async function readRecordAt(indexDir: string, entry: ResolvedEntry): Promise<TierBytes> {
    const buf = await readFile(shardPathFor(indexDir, entry.shard, entry.seq));
    return decodeRecord(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, entry.off, entry.dim);
}
