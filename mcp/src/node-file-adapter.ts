// fork 1.1.3 new; relates to Obsidian's DataAdapter (obsidian.d.ts). Node side of core's FileAdapter:
// paths are vault-relative like Obsidian's, so core's sidecar code runs unchanged against a folder.
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { FileAdapter } from '../../core/file-adapter.ts';

export function nodeFileAdapter(root: string): FileAdapter {
    const abs = (p: string) => join(root, p);
    const st = async (p: string) => { try { return await stat(abs(p)); } catch { return null; } };
    return {
        async exists(p) { return (await st(p)) !== null; },
        async mkdir(p) { await mkdir(abs(p), { recursive: true }); },
        async list(p) {
            const files: string[] = [], folders: string[] = [];
            for (const e of await readdir(abs(p), { withFileTypes: true })) (e.isDirectory() ? folders : files).push(posix.join(p, e.name));
            return { files, folders };
        },
        async stat(p) {
            const s = await st(p);
            return s && { type: s.isDirectory() ? 'folder' : 'file', ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
        },
        read: p => readFile(abs(p), 'utf8'),
        async readBinary(p) { const b = await readFile(abs(p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; },
        write: (p, d) => writeFile(abs(p), d),
        writeBinary: (p, d) => writeFile(abs(p), new Uint8Array(d)),
        append: (p, d) => appendFile(abs(p), d),
        rename: (a, b) => rename(abs(a), abs(b)),
        remove: p => rm(abs(p), { force: true }),
    };
}
