// nextFlushDelay — the cap on the resetting edit debounce (issue #8).
//
// scheduleFlush clears and re-arms its timer on EVERY enqueue. For editor edits
// that is the whole point. For external writes (Obsidian Sync, iCloud, git pull)
// it is a stall: a sync that dribbles a file in every couple of minutes resets
// the 5-min window before it ever expires, and the queue is never drained. These
// tests pin the ceiling that makes the reset safe.

import { describe, it, expect } from 'vitest';
import { nextFlushDelay, IDLE_FLUSH_MS, MAX_DIRTY_WAIT_MS } from './flush-schedule';

const MIN = 60 * 1000;

describe('nextFlushDelay', () => {
    it('empty queue: the full idle window', () => {
        // firstDirtyAt === 0 is main.ts's "queue is empty" sentinel.
        expect(nextFlushDelay(Date.now(), 0)).toBe(IDLE_FLUSH_MS);
    });

    it('fresh queue: the full idle window (the cap is not yet binding)', () => {
        const now = 1_000_000;
        expect(nextFlushDelay(now, now)).toBe(IDLE_FLUSH_MS);
    });

    it('burst inside the window still coalesces to one flush', () => {
        // 1 min in, the ceiling is 14 min away, so the idle window still governs:
        // a burst of writes keeps pushing the flush out, as designed.
        const now = 1_000_000;
        expect(nextFlushDelay(now + 1 * MIN, now)).toBe(IDLE_FLUSH_MS);
    });

    it('near the ceiling: returns only the time left, not a fresh idle window', () => {
        // This is the case the cap exists for. At 14 min the debounce would
        // otherwise re-arm for another 5, taking the queue to 19 min.
        const now = 1_000_000;
        expect(nextFlushDelay(now + 14 * MIN, now)).toBe(1 * MIN);
    });

    it('past the ceiling: flushes on the next tick, never a negative delay', () => {
        const now = 1_000_000;
        expect(nextFlushDelay(now + 20 * MIN, now)).toBe(0);
    });

    it('exactly at the ceiling: 0', () => {
        const now = 1_000_000;
        expect(nextFlushDelay(now + MAX_DIRTY_WAIT_MS, now)).toBe(0);
    });

    it('honours injected windows (the tests main.ts cannot run)', () => {
        const now = 1_000_000;
        expect(nextFlushDelay(now + 500, now, 1000, 2000)).toBe(1000);
        expect(nextFlushDelay(now + 1500, now, 1000, 2000)).toBe(500);
        expect(nextFlushDelay(now + 5000, now, 1000, 2000)).toBe(0);
    });

    it('a clock that jumped backwards cannot exceed the idle window', () => {
        // Wall-clock adjustments (NTP, sleep/wake) can make firstDirtyAt look
        // like the future. Clamping to idleMs keeps the delay bounded either way.
        const now = 1_000_000;
        expect(nextFlushDelay(now, now + 60 * MIN)).toBe(IDLE_FLUSH_MS);
    });
});
