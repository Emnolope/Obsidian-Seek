// T2 piped-wikilink pair mining (synonyms v2 Stage 1, plan note "Seek Synonyms
// v2 Plan" 2026-07-23). A piped link `[[Query Understanding|QU]]` is the vault
// author DECLARING, in context, that "Query Understanding" is called "QU" —
// the census found these displays are the best synonym dictionary the vault
// carries (QU ×70, DC ×49), covering exactly the multi-word-alias gap the
// derived-join loosening could not close (3/135 rescued, no-ship verdict).
//
// Mined from `app.metadataCache` (option D of the mining survey): zero storage,
// zero reindex, no schema bump — the cache already parses every link, and the
// chunk pipeline destroys the (target, display) PAIRING (dense-clean keeps the
// display, link_terms keeps the target, never both together). Precedent for
// walking the cache: suggest.ts build().
//
// PIPEDNESS RULE (verified live 2026-08-08, supersedes any displayText
// inference): Obsidian's LinkCache populates `displayText` for EVERY link
// shape — a plain `[[Note]]` gets displayText === link, a non-piped anchor
// link gets "Note > Heading". A link is piped IFF `original.includes("|")`
// (LinkCache.original is the raw `[[...]]` text); only piped links carry a
// deliberate display and feed the dictionary.
//
// This module stays obsidian-TYPE-only (no value imports, no search.ts import)
// so synonyms.ts can consume LinkPairCount while remaining Tier-1 pure, and so
// there is no import cycle with search.ts (which imports this module and owns
// the shouldIndexPath predicate — injected here as `includePath`).

import type { App } from 'obsidian';
import { extractPipedPairs, type LinkPairCount, type RawLink } from '../core/link-dict.ts';

// Pure half moved to core/ (see core/link-dict.ts); re-exported so plugin imports are unchanged.
export * from '../core/link-dict.ts';

// Defensive metadataCache reach (same posture as bm25.ts termDocFraction's
// MiniSearch-internals reach): the Tier-2 fake app exposes only isUserIgnored,
// so a missing getFileCache must read as "no links", never a throw.
type MetadataCacheReach = {
    getFileCache?: (file: unknown) => { links?: RawLink[] } | null | undefined;
};

// Full-vault mine: every markdown file passing `includePath` (the caller binds
// shouldIndexPath — an index-excluded note must not feed the dictionary, same
// rule suggest.ts applies to filter pills) contributes its piped pairs, keyed
// by note path so applyDelta can later re-mine ONLY touched paths. Files with
// no piped links get no entry. Before Obsidian's metadataCache has resolved,
// getFileCache returns null/empty and the mine comes back small or empty —
// inert (no wrong mates), refreshed on the next BM25 cache stamp.
export function mineLinkPairsByPath(
    app: App,
    includePath: (path: string) => boolean,
): Map<string, LinkPairCount[]> {
    const out = new Map<string, LinkPairCount[]>();
    const mc = app.metadataCache as unknown as MetadataCacheReach;
    if (typeof mc.getFileCache !== 'function') return out;
    for (const f of app.vault.getMarkdownFiles()) {
        if (!includePath(f.path)) continue;
        const links = mc.getFileCache(f)?.links;
        if (!links || links.length === 0) continue;
        const pairs = extractPipedPairs(links);
        if (pairs.length > 0) out.set(f.path, pairs);
    }
    return out;
}

// Targeted re-mine for the incremental path (applyDelta): resolve each touched
// path and return its CURRENT pairs. A path that is deleted, index-excluded,
// non-markdown, or simply link-free yields NO entry — the caller must treat
// absence as "drop this path's cached pairs" (a stale pair is a WRONG mate,
// stricter than v1's stale-df tolerance).
export function mineLinkPairsForPaths(
    app: App,
    includePath: (path: string) => boolean,
    paths: Iterable<string>,
): Map<string, LinkPairCount[]> {
    const out = new Map<string, LinkPairCount[]>();
    const mc = app.metadataCache as unknown as MetadataCacheReach;
    if (typeof mc.getFileCache !== 'function') return out;
    for (const path of paths) {
        if (!path.endsWith('.md') || !includePath(path)) continue;
        // Duck-typed (no `instanceof TFile`): paths come from chunk metas, which
        // only ever name files, and the fakes return plain file objects.
        const f = app.vault.getAbstractFileByPath(path);
        if (!f) continue;
        const links = mc.getFileCache(f)?.links;
        if (!links || links.length === 0) continue;
        const pairs = extractPipedPairs(links);
        if (pairs.length > 0) out.set(path, pairs);
    }
    return out;
}
