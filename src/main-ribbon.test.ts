import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// main.ts has no onload harness (it needs a live app), so this pins the two
// ribbon invariants at the source level. See the comment on the ribbon block
// in onload for why each one matters on phones (issue #9).
const src = readFileSync(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');

describe('ribbon action (issue #9)', () => {
    it('is registered before the first await in onload', () => {
        // Line comments stripped so prose mentioning "await" doesn't count.
        const body = src.slice(src.indexOf('async onload()')).replace(/\/\/[^\n]*/g, '');
        const ribbon = body.indexOf('this.addRibbonIcon(');
        const firstAwait = body.search(/\bawait\b/);
        expect(ribbon).toBeGreaterThan(-1);
        expect(firstAwait).toBeGreaterThan(-1);
        expect(ribbon).toBeLessThan(firstAwait);
    });

    it('keeps its persisted title', () => {
        // The ribbon item id is `<pluginId>:<title>`; users' quick-access pick
        // and hide/reorder state are stored against it.
        expect(src).toContain("export const RIBBON_TITLE = 'Seek search';");
        expect(src).toContain("this.addRibbonIcon('search', RIBBON_TITLE,");
    });
});
