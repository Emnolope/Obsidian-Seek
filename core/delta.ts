// Which files need (re)indexing, and how a file becomes chunks. This is the part of indexing that is decision, not I/O, so the plugin and any other host
// (MCP writer, CLI) agree on exactly which notes are indexable, dirty or gone. Hosts supply the vault view (list, read, hash) through ports.
import type { Chunk, SeekSettings, BaseView } from './types.ts';
import type { MarkdownChunker } from './chunker.ts';
import { cyrb53Hex } from './chunker.ts';
import { classifyFileDelta, type FileRecord } from './index-types.ts';

// fork 1.1.3 src/search.ts:142 EXCLUDED_PATHS
// Vault-root files that are machine-generated and would otherwise pollute the index with constant-touch recency. The mtime on these files moves every time
// the plugin writes, which means recency=~1.0 → +0.25 lift on every fused score, drowning out actual content matches.
// A hardcoded list rather than a setting: anything that becomes a recurring "where did my note go" complaint gets added here.
export const EXCLUDED_PATHS = new Set([
    'seek-report.md',
    'seek-report.json',
    'spike-report.md',
]);
// fork 1.1.3 src/search.ts:147 EXCLUDED_PREFIXES
export const EXCLUDED_PREFIXES = [
    // If someone runs multiple spike variants, the generated reports tend to share these stems.
    'spike-init',
    'seek-init',
];

// fork 1.1.3 src/search.ts:187 shouldIndexPath
// The single index-membership predicate. `isIgnored` is the host's view of the user's "Excluded files" list (Obsidian's matcher in the plugin; the MCP has
// none unless it reads .obsidian/app.json), so this stays pure and every caller agrees on membership.
export function shouldIndexPath(settings: Pick<SeekSettings, 'honorIgnoredFolders'>, path: string, isIgnored: (path: string) => boolean): boolean {
    if (EXCLUDED_PATHS.has(path)) return false;
    if (EXCLUDED_PREFIXES.some(p => path.startsWith(p))) return false;
    if (settings.honorIgnoredFolders && isIgnored(path)) return false;
    return true;
}

// fork 1.1.3 src/search.ts:103 isUserIgnored (the userIgnoreFilters fallback branch, lifted whole: a host with no metadataCache.isUserIgnored matches the raw list itself)
// `/pattern/` is a regex; anything else is a file or folder prefix.
export function matchUserIgnoreFilters(filters: readonly string[], path: string): boolean {
    return filters.some(filter => {
        if (filter.length > 1 && filter.startsWith('/') && filter.endsWith('/')) {
            try { return new RegExp(filter.slice(1, -1)).test(path); } catch { return false; }
        }
        return path === filter || path.startsWith(filter.endsWith('/') ? filter : filter + '/');
    });
}

// fork 1.1.3 src/search.ts:1573 SearchOrchestrator.chunksFor
// Content → chunks for one file, branching by extension. A .base file isn't markdown, it's a YAML view definition, so it goes through the host's base
// extractor (one synthetic doc per view, which needs a YAML parser the host owns) + chunkBase. Every chunk-PRODUCTION site routes through here so the
// .md/.base split lives in one place and a base chunk's id is identical wherever it is re-derived. `modifiedIso` matches the chunker's `modified` contract.
export function chunksFor(
    chunker: MarkdownChunker,
    extractBaseDocs: (content: string, path: string) => BaseView[],
    content: string,
    path: string,
    modifiedIso: string | null,
): Chunk[] {
    if (path.endsWith('.base')) {
        return chunker.chunkBase(extractBaseDocs(content, path), path, modifiedIso);
    }
    return chunker.chunkContent(content, path, undefined, modifiedIso);
}

// fork 1.1.3 new; relates to src/index-store.ts:255 classifyFileDelta (what the quarantine keeps from reporting 'dirty' forever)
// Files that persistently fail to read are skipped for a backoff window. Without it the dropped record makes classifyFileDelta report 'dirty' forever,
// wedging every computeDelta caller. A full reindex clears it so everything is retried then.
export class UnreadableQuarantine {
    static readonly MS = 30 * 60 * 1000; // 30 min
    private until = new Map<string, number>();

    has(path: string): boolean {
        const t = this.until.get(path);
        return t !== undefined && Date.now() < t;
    }

    // Returns true the first time a path enters quarantine, so callers log once per spell and a wedged file doesn't spam.
    add(path: string): boolean {
        const isNew = !this.until.has(path);
        this.until.set(path, Date.now() + UnreadableQuarantine.MS);
        return isNew;
    }

    clear(): void { this.until.clear(); }
}

// `handle` is whatever the host needs to read the file back (Obsidian's TFile, a path, ...); the planner never looks inside it.
export interface LiveFile<H = unknown> { path: string; mtime: number; handle: H }

export interface DeltaPorts<H = unknown> {
    records(): Promise<FileRecord[]>;
    // Already filtered to indexable files.
    liveFiles(): LiveFile<H>[];
    // Raw-bytes read for the content hash; throws if unreadable.
    read(file: LiveFile<H>): Promise<string>;
    quarantine: UnreadableQuarantine;
    // Called once when a file enters quarantine, for the host's own logging.
    onQuarantined?(path: string): void;
    pluginVersion: string;
}

// fork 1.1.3 src/search.ts:1586 SearchOrchestrator.computeDelta
// Diff the persisted index against the live vault, the authoritative idempotent catch-up computation. `dirty` = indexable files whose mtime advanced past
// the stored record (or were never indexed); `deleted` = previously-indexed paths now gone OR no longer indexable (moved into an ignored folder, or
// honor-ignored toggled on), since one "not in the live indexable set" test covers both.
export async function computeDelta<H>(p: DeltaPorts<H>): Promise<{ dirty: string[]; deleted: string[] }> {
    const stored = new Map<string, FileRecord>();
    for (const r of await p.records()) stored.set(r.note_path, r);

    const live = p.liveFiles();
    const livePaths = new Set(live.map(f => f.path));

    // mtime advanced ≠ edited. An iCloud / Drive sync re-stamps a synced file's mtime without changing a byte; on iOS that fires every couple of seconds and,
    // keyed on mtime alone, re-embeds identical content forever (each embed blocks the mobile main thread, and the churn drives the jetsam crash-loop).
    // classifyFileDelta confirms the bytes changed via the stored content hash, and we only pay the read+hash ('check-bytes') for files whose mtime moved.
    const dirty: string[] = [];
    for (const f of live) {
        // A quarantined file is excluded entirely while its backoff is live (see UnreadableQuarantine).
        if (p.quarantine.has(f.path)) continue;
        const prev = stored.get(f.path);
        let decision = classifyFileDelta(prev, f.mtime, undefined, p.pluginVersion);
        if (decision === 'check-bytes') {
            try {
                decision = classifyFileDelta(prev, f.mtime, cyrb53Hex(await p.read(f)), p.pluginVersion);
            } catch {
                decision = 'dirty';   // unreadable → let the embed path decide
                if (p.quarantine.add(f.path)) p.onQuarantined?.(f.path); // give it this one attempt, then back off
            }
        }
        if (decision === 'dirty') dirty.push(f.path);
    }
    const deleted: string[] = [];
    for (const path of stored.keys()) {
        if (!livePaths.has(path)) deleted.push(path);
    }
    return { dirty, deleted };
}
