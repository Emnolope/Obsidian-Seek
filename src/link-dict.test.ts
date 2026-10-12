import { describe, it, expect } from 'vitest';
import { extractPipedPairs, aggregateLinkPairs, mineLinkPairsByPath, mineLinkPairsForPaths, normalizeLinkTarget, type RawLink } from './link-dict';
import type { App } from 'obsidian';

// Convenience RawLink builders. `piped` mirrors the VERIFIED LinkCache shape:
// displayText is populated for EVERY link (plain links get displayText ===
// link), and pipedness lives only in `original` containing '|'.
const piped = (link: string, display: string): RawLink =>
    ({ link, displayText: display, original: `[[${link}|${display}]]` });
const plain = (link: string): RawLink =>
    ({ link, displayText: link, original: `[[${link}]]` });

// Minimal fake of the App surface the miner touches (suggest.test.ts style):
// vault.getMarkdownFiles / getAbstractFileByPath + metadataCache.getFileCache.
function fakeApp(files: Record<string, RawLink[]>): App {
    const paths = Object.keys(files);
    return {
        vault: {
            getMarkdownFiles: () => paths.map(p => ({ path: p })),
            getAbstractFileByPath: (p: string) => (p in files ? { path: p } : null),
        },
        metadataCache: {
            getFileCache: (f: { path: string }) => ({ links: files[f.path] }),
        },
    } as unknown as App;
}

describe('normalizeLinkTarget', () => {
    it('strips #heading and ^block anchors', () => {
        expect(normalizeLinkTarget('Query Understanding#Signals')).toBe('Query Understanding');
        expect(normalizeLinkTarget('Query Understanding^abc123')).toBe('Query Understanding');
    });

    it('drops the folder path (basename only)', () => {
        expect(normalizeLinkTarget('Notes/Work/Query Understanding')).toBe('Query Understanding');
    });

    it('anchor-only links normalize to empty (same-file section link)', () => {
        expect(normalizeLinkTarget('#Some Heading')).toBe('');
    });
});

describe('extractPipedPairs', () => {
    it('counts repeated (target, display) pairs within one file', () => {
        const pairs = extractPipedPairs([
            piped('Query Understanding', 'QU'),
            piped('Query Understanding', 'QU'),
            piped('Firefly', 'FF'),
        ]);
        expect(pairs).toContainEqual({ target: 'Query Understanding', display: 'QU', count: 2 });
        expect(pairs).toContainEqual({ target: 'Firefly', display: 'FF', count: 1 });
    });

    it('normalizes anchors + folders into the target, merging with the bare form', () => {
        const pairs = extractPipedPairs([
            piped('Work/Query Understanding#Signals', 'QU'),
            piped('Query Understanding', 'QU'),
        ]);
        expect(pairs).toEqual([{ target: 'Query Understanding', display: 'QU', count: 2 }]);
    });

    it('ignores plain links even though their LinkCache carries displayText', () => {
        // THE piped rule (verified 2026-08-08): displayText EXISTS on a plain
        // link (=== link) and on a non-piped anchor link ("Note > Heading") —
        // only `original.includes("|")` may decide pipedness, or every anchor
        // link in the vault becomes a bogus dictionary pair.
        const anchorNoPipe: RawLink = {
            link: 'Query Understanding#Signals',
            displayText: 'Query Understanding > Signals',
            original: '[[Query Understanding#Signals]]',
        };
        expect(extractPipedPairs([plain('Query Understanding'), anchorNoPipe])).toEqual([]);
    });

    it('drops a display that just restates the target basename (case-insensitively)', () => {
        expect(extractPipedPairs([
            piped('Query Understanding', 'query understanding'),
            piped('Notes/Query Understanding', 'Query Understanding'),
        ])).toEqual([]);
    });

    it('keeps display case distinct (name-shape filtering reads case downstream)', () => {
        const pairs = extractPipedPairs([
            piped('Query Understanding', 'QU'),
            piped('Query Understanding', 'Qu'),
        ]);
        expect(pairs).toHaveLength(2);
    });

    it('skips empty displays and anchor-only targets', () => {
        expect(extractPipedPairs([
            { link: 'Note', displayText: '', original: '[[Note|]]' },
            { link: '#Heading', displayText: 'see here', original: '[[#Heading|see here]]' },
        ])).toEqual([]);
    });
});

describe('aggregateLinkPairs', () => {
    it('merges per-file counts vault-wide, case-insensitive on target', () => {
        const agg = aggregateLinkPairs([
            [{ target: 'Query Understanding', display: 'QU', count: 2 }],
            [{ target: 'query understanding', display: 'QU', count: 3 }],
            [{ target: 'Firefly', display: 'FF', count: 1 }],
        ]);
        expect(agg).toContainEqual(expect.objectContaining({ display: 'QU', count: 5 }));
        expect(agg).toContainEqual({ target: 'Firefly', display: 'FF', count: 1 });
    });

    it('does not mutate its inputs (the per-path cache is re-aggregated repeatedly)', () => {
        const file = [{ target: 'Query Understanding', display: 'QU', count: 2 }];
        aggregateLinkPairs([file, file]);
        expect(file[0].count).toBe(2);
    });
});

describe('mineLinkPairsByPath', () => {
    it('mines piped pairs per note path, skipping link-free files', () => {
        const app = fakeApp({
            'a.md': [piped('Query Understanding', 'QU'), plain('Other Note')],
            'b.md': [plain('Query Understanding')],
        });
        const byPath = mineLinkPairsByPath(app, () => true);
        expect(byPath.get('a.md')).toEqual([{ target: 'Query Understanding', display: 'QU', count: 1 }]);
        expect(byPath.has('b.md')).toBe(false);
    });

    it('honors the injected index-membership predicate (shouldIndexPath)', () => {
        const app = fakeApp({
            'Archive/a.md': [piped('Query Understanding', 'QU')],
            'b.md': [piped('Firefly', 'FF')],
        });
        const byPath = mineLinkPairsByPath(app, p => !p.startsWith('Archive/'));
        expect(byPath.has('Archive/a.md')).toBe(false);
        expect(byPath.has('b.md')).toBe(true);
    });

    it('is inert when the (fake) metadataCache lacks getFileCache', () => {
        // The Tier-2 fake app historically exposed only isUserIgnored; a
        // missing getFileCache must read "no links", never throw.
        const app = { vault: { getMarkdownFiles: () => [{ path: 'a.md' }] }, metadataCache: {} } as unknown as App;
        expect(mineLinkPairsByPath(app, () => true).size).toBe(0);
    });
});

describe('mineLinkPairsForPaths (incremental re-mine)', () => {
    it('returns entries only for resolvable, included, pair-bearing paths', () => {
        const app = fakeApp({
            'a.md': [piped('Query Understanding', 'QU')],
            'empty.md': [plain('Query Understanding')],
        });
        const mined = mineLinkPairsForPaths(app, () => true, ['a.md', 'empty.md', 'deleted.md', 'x.base']);
        expect(mined.get('a.md')).toEqual([{ target: 'Query Understanding', display: 'QU', count: 1 }]);
        expect(mined.has('empty.md')).toBe(false);   // link-free → caller drops stale pairs
        expect(mined.has('deleted.md')).toBe(false); // unresolvable → same
        expect(mined.has('x.base')).toBe(false);     // non-markdown → never mined
    });

    it('applies the index-membership predicate to touched paths too', () => {
        const app = fakeApp({ 'Archive/a.md': [piped('Query Understanding', 'QU')] });
        expect(mineLinkPairsForPaths(app, p => !p.startsWith('Archive/'), ['Archive/a.md']).size).toBe(0);
    });
});
