// Unit tests for titleNavCoverage (search-modal.ts) — the accessor that recovers
// [0,1] title COVERAGE from the WEIGHTED title_boost signal the ranker stores
// (title_boost = navTitleBoost · coverage, fusion.ts titleMatchBoost).
//
// It backs two surfaces: the debug score row's `title 0.00` figure, and the
// TITLE_NAV_COVERAGE_MIN gate that decides whether a click opens the note at its
// top (and, via seek:insert-link, whether a link targets [[Note]] or [[Note#Section]]).

import { describe, it, expect } from 'vitest';
import { titleNavCoverage, TITLE_NAV_COVERAGE_MIN } from './search-modal';
import type { ScoredChunk } from './types';

// Only ranking_signals.title_boost is read; the rest is scaffolding.
function chunk(titleBoost: number): ScoredChunk {
    return {
        chunk_id: 'c1',
        note_path: 'Note.md',
        content: '',
        score: 0,
        ranking_signals: {
            dense: 0, bm25: 0, hybrid: 0, recency: 0,
            title_boost: titleBoost,
            denseRaw: 0,
        },
    } as unknown as ScoredChunk;
}

describe('titleNavCoverage', () => {
    it('divides the weight back out to recover coverage', () => {
        // navTitleBoost 0.5 · coverage 0.4 = 0.2 stored → 0.4 recovered.
        expect(titleNavCoverage(chunk(0.2), 0.5)).toBeCloseTo(0.4, 10);
        // A full known-item title match round-trips to exactly 1.
        expect(titleNavCoverage(chunk(0.5), 0.5)).toBeCloseTo(1, 10);
        expect(titleNavCoverage(chunk(0.8), 0.8)).toBeCloseTo(1, 10);
    });

    it('returns 0 — never NaN — when the title bonus is Off', () => {
        // THE GUARD THIS FILE EXISTS FOR. With navTitleBoost 0, titleMatchBoost stores
        // `0 * coverage` = 0, so an unguarded divide is 0/0 = NaN and the score row
        // renders the literal string "title NaN" on every result. The `> 0` guard in
        // titleNavCoverage is load-bearing; do not "simplify" it to a bare division.
        const off = titleNavCoverage(chunk(0), 0);
        expect(Number.isNaN(off)).toBe(false);
        expect(off).toBe(0);
        expect(off.toFixed(2)).toBe('0.00');
    });

    it('reports no coverage for a chunk whose title did not match', () => {
        // titleMatchBoost gates on FULL query coverage, so a partial match stores 0.
        expect(titleNavCoverage(chunk(0), 0.5)).toBe(0);
    });
});

// The TITLE_NAV_COVERAGE_MIN boundary itself (openResult / insertResultLink use
// `titleNavCoverage(r) >= TITLE_NAV_COVERAGE_MIN`). Pins the 2026-07-19 relax
// from 0.5 → 0.25 so the "chunking" → "Seek Chunking Improvement Plan" case
// navigates to the doc top instead of scrolling to the reference-dense section.
describe('TITLE_NAV_COVERAGE_MIN gate', () => {
    // Reproduce a click decision: the ranker stores title_boost = navTitleBoost
    // · coverage, so feed that weighted value in and apply the real gate.
    const NAV_BOOST = 0.5; // "Default" stage
    const fires = (coverage: number) =>
        titleNavCoverage(chunk(NAV_BOOST * coverage), NAV_BOOST) >= TITLE_NAV_COVERAGE_MIN;

    it('navigates a single strong token that is the note subject (1/4-token title)', () => {
        // "chunking" → "Seek Chunking Improvement Plan": the reported case.
        expect(fires(1 / 4)).toBe(true);
    });

    it('still excludes an incidental multi-word match in a long title (2/10)', () => {
        // The documented false positive the threshold must keep out.
        expect(fires(2 / 10)).toBe(false);
    });

    it('preserves the cases that navigated under the old 0.5 bar', () => {
        expect(fires(2 / 4)).toBe(true); // "seek chunk" → "Seek Chunk-Size Sweep"
        expect(fires(1)).toBe(true);     // exact known-item title
    });

    it('leaves a single token in a 5+ word title as a passage jump (known fragility)', () => {
        // Title-length ratio, so 1/5 = 0.2 stays below the bar — passage intent.
        expect(fires(1 / 5)).toBe(false);
    });
});
