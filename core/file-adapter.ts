// fork 1.1.3 new; relates to Obsidian's DataAdapter (obsidian.d.ts), the slice sidecar code uses, so Node can implement it too.
// The slice of a file adapter the sidecar code uses. Obsidian's DataAdapter satisfies it as-is; a Node host implements it over node:fs. Paths are the adapter's own
// (vault-relative for Obsidian, whatever the host chooses for Node), always '/'-separated.
export interface FileAdapter {
    exists(path: string): Promise<boolean>;
    mkdir(path: string): Promise<void>;
    list(path: string): Promise<{ files: string[]; folders: string[] }>;
    stat(path: string): Promise<{ type: 'file' | 'folder'; ctime: number; mtime: number; size: number } | null>;
    read(path: string): Promise<string>;
    readBinary(path: string): Promise<ArrayBuffer>;
    write(path: string, data: string): Promise<void>;
    writeBinary(path: string, data: ArrayBuffer): Promise<void>;
    append(path: string, data: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    remove(path: string): Promise<void>;
}
