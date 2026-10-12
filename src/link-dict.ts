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

// One (target note, display) pair with its vault-wide (or per-file — see each
// producer) usage count. `target` is the link's normalized note BASENAME
// (anchor stripped, folders dropped — the same normalization dense-clean's
// wikiDisplay applies to un-piped links); `display` is the piped display text,
// case preserved (the name-shape filter in synonyms.ts reads case).
export interface LinkPairCount {
    target: string;
    display: string;
    count: number;
}

// The LinkCache subset the miner reads — structural, so tests and the Tier-2
// fake app can supply plain objects.
export interface RawLink {
    link: string;
    displayText?: string;
    original: string;
}

// Defensive metadataCache reach (same posture as bm25.ts termDocFraction's
// MiniSearch-internals reach): the Tier-2 fake app exposes only isUserIgnored,
// so a missing getFileCache must read as "no links", never a throw.
type MetadataCacheReach = {
    getFileCache?: (file: unknown) => { links?: RawLink[] } | null | undefined;
};

// Link target -> note basename: drop the #heading/^block anchor, then the
// folder path. Mirrors dense-clean.ts wikiDisplay's target branch so the
// dictionary and the indexed display text agree on what a link "names".
export function normalizeLinkTarget(link: string): string {
    const noAnchor = link.split(/[#^]/, 1)[0];
    const segs = noAnchor.split('/');
    return (segs[segs.length - 1] ?? '').trim();
}

// Per-file pass: keep only piped links (original contains '|'), normalize the
// target, and count (target, display) pairs. A display that merely restates
// the target basename (case-insensitively — `[[query understanding|Query
// Understanding]]` is a case tweak, not a naming) is dropped here, once, so no
// downstream consumer re-derives that rule. Pair identity is case-insensitive
// on the TARGET (Obsidian link resolution is) but case-SENSITIVE on the
// display — "QU" and "qu" are different name-shape candidates.
export function extractPipedPairs(links: RawLink[]): LinkPairCount[] {
    const acc = new Map<string, LinkPairCount>();
    for (const l of links) {
        if (!l.original.includes('|')) continue;          // THE piped rule (see header)
        const display = (l.displayText ?? '').trim();
        const target = normalizeLinkTarget(l.link);
        if (!display || !target) continue;                // anchor-only link / empty display
        if (display.toLowerCase() === target.toLowerCase()) continue;
        const key = `${target.toLowerCase()}\u0000${display}`;
        const hit = acc.get(key);
        if (hit) hit.count++;
        else acc.set(key, { target, display, count: 1 });
    }
    return [...acc.values()];
}

// Merge per-file pair lists into vault-wide counts. Takes the VALUES of the
// orchestrator's per-path cache (Map<notePath, LinkPairCount[]>) directly, so
// the incremental path — re-mine touched paths, re-aggregate — needs no
// intermediate shape. Inputs are never mutated (counts accumulate on copies).
export function aggregateLinkPairs(perFile: Iterable<LinkPairCount[]>): LinkPairCount[] {
    const acc = new Map<string, LinkPairCount>();
    for (const pairs of perFile) {
        for (const p of pairs) {
            const key = `${p.target.toLowerCase()}\u0000${p.display}`;
            const hit = acc.get(key);
            if (hit) hit.count += p.count;
            else acc.set(key, { ...p });
        }
    }
    return [...acc.values()];
}

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
