// Design B — manual pause / resume of a full reindex (Tier-2 scenarios).
//
// The contract, end to end against the REAL orchestrator + store:
//   1. Pause breaks the full pass at a file boundary, COMMITS what it started
//      (progress is durable), tags the entry `paused`, and leaves the un-started
//      files record-less so they read as dirty (resumable). It is NOT a completed
//      full index.
//   2. Resume drains that remainder through the ordinary catch-up path
//      (computeDelta → reindexDelta) and re-embeds ONLY the missing files — an
//      already-committed, unchanged file matches its stored content hash and is
//      never re-embedded.
//   3. The pause is a full reconcile point: notes created / edited / deleted while
//      paused are picked up by resume, because computeDelta diffs stored records
//      against the live vault, not a session changelog.
// See test-harness/scenario.ts and quota-preempt.test.ts (the 3A soft-preempt
// sibling this mirrors).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Scenario } from './test-harness/scenario';

describe('manual pause / resume (design B)', () => {
    let active: Scenario | null = null;
    const boot = async (): Promise<Scenario> => {
        const s = new Scenario();
        await s.boot();
        active = s;
        return s;
    };
    afterEach(async () => { await active?.teardown(); active = null; });

    // isPaused is polled ONCE per file at loop-top, before that file is started.
    // `false` for the first (n-1) checks, `true` from the n-th on ⇒ the pass commits
    // the first (n-1) recency-sorted files and breaks before the n-th.
    const pauseBeforeFile = (n: number): (() => boolean) => {
        let checks = 0;
        return () => ++checks >= n;
    };

    it('commits the started files, tags the entry paused, and leaves the rest dirty', async () => {
        const s = await boot();
        // Distinct mtimes pin the recency-first order the pass indexes in: a, b, c.
        s.vault.write('a.md', 'alpha note about the pixel phone camera sensor', 3000);
        s.vault.write('b.md', 'beta note about concert setlists and encores', 2000);
        s.vault.write('c.md', 'gamma note about sourdough starter hydration', 1000);

        const progress: string[] = [];
        const entry = await s.orch.reindexAll(m => progress.push(m), { isPaused: pauseBeforeFile(2) });

        // Paused after the first file: only a.md committed; b/c never started.
        expect(entry.paused).toBe(true);
        expect(entry.committedFilePaths).toEqual(['a.md']);
        expect(entry.checks.join('\n')).toContain('paused by user');

        // The un-started files have no record ⇒ dirty ⇒ the resume can find them.
        // a.md's progress is durable — it does NOT come back dirty.
        expect((await s.orch.computeDelta()).dirty.slice().sort()).toEqual(['b.md', 'c.md']);
        expect(await s.store.getFileRecord('a.md')).not.toBeNull();
    });

    it('an ordinary (un-paused) full reindex is NOT tagged paused', async () => {
        const s = await boot();
        s.vault.write('a.md', 'a plain note that indexes to completion', 1000);
        const entry = await s.orch.reindexAll(undefined, { isPaused: () => false });
        expect(entry.paused).toBe(false);
        expect(entry.committedFilePaths).toEqual(['a.md']);
        expect((await s.orch.computeDelta()).dirty).toEqual([]);
    });

    it('resume embeds ONLY the remaining files — an unchanged committed file is never re-embedded', async () => {
        const s = await boot();
        s.vault.write('a.md', 'alpha note about the pixel phone camera sensor', 3000);
        s.vault.write('b.md', 'beta note about concert setlists and encores', 2000);
        s.vault.write('c.md', 'gamma note about sourdough starter hydration', 1000);
        await s.orch.reindexAll(undefined, { isPaused: pauseBeforeFile(2) });   // pause after a.md

        // Instrument the embedder to record exactly what resume re-embeds.
        const embedded: string[] = [];
        const realEmbedBatch = s.embedder.embedBatch;
        s.embedder.embedBatch = async (texts: string[]) => { embedded.push(...texts); return realEmbedBatch(texts); };

        await s.reconcile();   // the resume path in miniature: computeDelta → reindexDelta(embed)

        expect((await s.orch.computeDelta()).dirty).toEqual([]);   // remainder finished
        const all = embedded.join(' | ');
        expect(all).toContain('setlists');    // b.md was embedded
        expect(all).toContain('sourdough');   // c.md was embedded
        expect(all).not.toContain('pixel');   // a.md (unchanged, already committed) was NOT re-embedded
    });

    it('is tolerant to notes created / edited / deleted during the pause', async () => {
        const s = await boot();
        s.vault.write('a.md', 'alpha note about the pixel phone camera sensor', 3000);
        s.vault.write('b.md', 'beta note about concert setlists and encores', 2000);
        s.vault.write('c.md', 'gamma note about sourdough starter hydration', 1000);
        await s.orch.reindexAll(undefined, { isPaused: pauseBeforeFile(3) });   // pause after a + b commit

        // Baseline: only c.md (never started) is dirty.
        expect((await s.orch.computeDelta()).dirty).toEqual(['c.md']);

        // The user does things while paused:
        s.vault.write('a.md', 'alpha note REWRITTEN to be about espresso extraction', 4000);  // edit a committed file
        s.vault.remove('b.md');                                                                // delete a committed file
        s.vault.write('d.md', 'delta note freshly created during the pause', 4000);            // create a new file

        // computeDelta reconciles the live vault against stored records — it needs no
        // session log to notice any of it:
        const delta = await s.orch.computeDelta();
        expect(delta.dirty.slice().sort()).toEqual(['a.md', 'c.md', 'd.md']);  // edited + pending + new
        expect(delta.deleted).toEqual(['b.md']);                               // committed-then-deleted

        // Resume drains all of it and converges; the deleted file's record is gone.
        await s.reconcile();
        expect((await s.orch.computeDelta()).dirty).toEqual([]);
        expect((await s.orch.computeDelta()).deleted).toEqual([]);
        expect(await s.store.getFileRecord('b.md')).toBeUndefined();
    });
});
