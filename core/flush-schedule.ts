// fork 1.1.3: whole file moved from src/flush-schedule.ts (src/flush-schedule.ts is now a re-export shim)
// Flush-delay policy for the incremental dirty queue — extracted from main.ts so
// the timing rule is a pure, testable unit (same reason catchup.ts is one).
//
// The edit debounce RESETS on every enqueue: that's deliberate for the case it was
// written for (a user flipping back into a note to keep writing shouldn't trigger
// a flush mid-thought). It becomes a stall the moment enqueues stop coming from
// the editor: an Obsidian Sync / iCloud / git pull that dribbles files in slower
// than the idle window pushes the deadline out forever and the queue is never
// drained. Before the `modify` listener landed that was unreachable (nothing
// external could enqueue at all); with it, it's the default shape of a sync.
//
// So the reset is capped. The queue's FIRST un-flushed enqueue starts a clock, and
// the delay shrinks as that clock approaches the ceiling — the debounce still
// absorbs a burst, but it can't outrun MAX_DIRTY_WAIT_MS.

// Idle debounce for edits: how long after the last enqueue to wait before
// flushing, absent the cap below.
export const IDLE_FLUSH_MS = 5 * 60 * 1000;

// Ceiling on how long the oldest un-flushed enqueue may sit. Picked as 3x the
// idle window: long enough that a normal writing session still coalesces into
// one flush, short enough that a synced vault is never more than ~15 min stale.
export const MAX_DIRTY_WAIT_MS = 15 * 60 * 1000;

// Delay (ms) before the next flushDirty, given when the oldest un-flushed enqueue
// landed. `firstDirtyAtMs === 0` means the queue was empty until now, so the full
// idle window applies. Never negative — a queue already past the ceiling flushes
// on the next tick rather than synchronously, which keeps the caller's setTimeout
// contract (and its re-entrancy guard) intact.
export function nextFlushDelay(
    nowMs: number,
    firstDirtyAtMs: number,
    idleMs: number = IDLE_FLUSH_MS,
    maxWaitMs: number = MAX_DIRTY_WAIT_MS,
): number {
    if (firstDirtyAtMs <= 0) return idleMs;
    const remaining = maxWaitMs - (nowMs - firstDirtyAtMs);
    return Math.max(0, Math.min(idleMs, remaining));
}
