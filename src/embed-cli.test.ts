import { describe, expect, it } from 'vitest';
import { embedCliReply } from './embed-cli';

describe('embedCliReply', () => {
    it('json carries dim, norm and the full vector', () => {
        const r = JSON.parse(embedCliReply('hi', new Float32Array([0.6, 0.8]), true));
        expect(r).toMatchObject({ text: 'hi', dim: 2, vector: expect.any(Array) });
        expect(r.norm).toBeCloseTo(1, 5);
    });
    it('text form puts a header line over the vector', () => {
        const [head, body] = embedCliReply('hi', [1, 0], false).split('\n');
        expect(head).toContain('dim 2');
        expect(JSON.parse(body)).toEqual([1, 0]);
    });
    it('refuses a poisoned vector rather than printing NaN', () => {
        expect(() => embedCliReply('hi', [NaN, 1], true)).toThrow(/non-finite/);
    });
});
