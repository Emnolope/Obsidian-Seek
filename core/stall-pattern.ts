// fork 1.1.3: whole file moved from src/stall-pattern.ts (src/stall-pattern.ts is now a re-export shim)
// Periodicity detection over recorded main-thread stalls.
//
// Issue #5 was diagnosed by hand: 55 long tasks logged as 'idle' (no Seek phase
// overlapping them) looked like undifferentiated noise in the report, and only
// became legible after dumping startTimeMs and differencing it by hand — at
// which point they resolved into one event repeating on a 3,600,000 ms period
// with ±2 ms of jitter, for twelve hours straight. That is not a workload; a
// clock that stable is a `setInterval`, which immediately rules OUT everything
// event-driven and turns "Seek makes Obsidian lag" into "something in this
// window runs an hourly job".
//
// Nobody should have to do that by hand twice, so the report does it. The
// startTime axis is the one to difference: it comes from performance.now(),
// which is monotonic and immune to wall-clock adjustment, unlike `timestamp`
// (which is also written at observer DELIVERY time — after the task ends — so
// differencing it smears by each task's duration).

export interface PeriodicStall {
    /** The repeating interval, in ms. */
    periodMs: number;
    /** How many stalls fall on it. */
    count: number;
    /** Worst deviation from the period across the run — the "is this a clock?" number. */
    jitterMs: number;
    /** Typical stall length, for the cost side of the sentence. */
    medianDurationMs: number;
}

interface StallLike { startTimeMs: number; durationMs: number }

// A run of at least this many stalls before we'll call it periodic. Three
// intervals (four stalls) is the point where coincidence stops being a
// plausible explanation for equal spacing.
const MIN_RUN = 4;

// How far a gap may drift from the run's period and still count. Generous in
// relative terms because a busy main thread delays a timer callback; the
// reported jitter is what tells the reader how clock-like it really was.
function toleranceFor(periodMs: number): number {
    return Math.max(250, periodMs * 0.02);
}

// Find the longest run of near-equally-spaced stalls. Restricted to the
// SUBSTANTIAL stalls in the set (≥ half the worst one, floored at 1 s): a
// periodic heavyweight is what we're hunting, and the sub-second tail is
// ordinary UI work that would otherwise break up the run.
export function detectPeriodicStalls(tasks: StallLike[]): PeriodicStall | null {
    if (tasks.length < MIN_RUN) return null;
    const worst = Math.max(...tasks.map(t => t.durationMs));
    const floor = Math.max(1000, worst / 2);
    const heavy = tasks.filter(t => t.durationMs >= floor).sort((a, b) => a.startTimeMs - b.startTimeMs);
    if (heavy.length < MIN_RUN) return null;

    const gaps = heavy.slice(1).map((t, i) => t.startTimeMs - heavy[i].startTimeMs);

    // Longest window of gaps that all sit within tolerance of the window's mean.
    // Grown greedily from each start: the runs we care about are contiguous by
    // construction (a timer fires until it's cleared).
    let best: { start: number; len: number; period: number; jitter: number } | null = null;
    for (let i = 0; i < gaps.length; i++) {
        let sum = 0;
        for (let j = i; j < gaps.length; j++) {
            const nextSum = sum + gaps[j];
            const mean = nextSum / (j - i + 1);
            let jitter = 0;
            for (let k = i; k <= j; k++) jitter = Math.max(jitter, Math.abs(gaps[k] - mean));
            if (jitter > toleranceFor(mean)) break;
            sum = nextSum;
            const len = j - i + 1;
            if (!best || len > best.len) best = { start: i, len, period: mean, jitter };
        }
    }
    if (!best || best.len + 1 < MIN_RUN) return null;

    const run = heavy.slice(best.start, best.start + best.len + 1);
    const durations = run.map(t => t.durationMs).sort((a, b) => a - b);
    return {
        periodMs: best.period,
        count: run.length,
        jitterMs: best.jitter,
        medianDurationMs: durations[Math.floor(durations.length / 2)],
    };
}

// One-line human rendering. Deliberately states the INFERENCE, not just the
// numbers — "an interval timer" is the actionable half, and a reader who
// isn't steeped in this codebase won't draw it from a period in milliseconds.
export function describePeriodicStalls(p: PeriodicStall): string {
    const period = p.periodMs >= 60_000
        ? `${(p.periodMs / 60_000).toFixed(1)} min`
        : `${(p.periodMs / 1000).toFixed(1)} s`;
    const jitter = p.jitterMs < 1000 ? `±${p.jitterMs.toFixed(0)} ms` : `±${(p.jitterMs / 1000).toFixed(1)} s`;
    return `⏱ **Periodic stall detected** — ${p.count} stalls of ~${(p.medianDurationMs / 1000).toFixed(1)} s `
        + `on a fixed ${period} period (${jitter} jitter). A clock that regular is an interval timer, `
        + `not a reaction to your editing; check the \`culprit\` field on those rows for the frame that owns it.`;
}
