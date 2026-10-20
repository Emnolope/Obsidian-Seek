import assert from 'node:assert/strict';
import test from 'node:test';
import { BotEmbedder } from '../src/bot-embedder.ts';

test('BotEmbedder presents the port core expects over a batch sidecar', async () => {
  const calls: string[] = [];
  const e = new BotEmbedder({
    async embedBatch(texts, bucket) { calls.push(`embed:${texts.length}:${bucket}`); return { vectors: texts.map(() => new Float32Array(384)), latencyMs: 9 }; },
    async tokenCounts(texts) { return texts.map(t => t.length); },
    async loadTokenizer() { calls.push('tok'); },
    async close() { calls.push('close'); },
  });
  assert.equal(e.loaded, true);
  assert.equal(e.modelId, 'tooape/granite-embedding-97m-multilingual-r2-GBQ4-ONNX');
  const r = await e.embedBatch(['a', 'b'], 64);
  assert.equal(r.vectors.length, 2);
  assert.equal(r.iframeLatencyMs, 9);
  assert.deepEqual(await e.tokenCounts(['abc']), [3]);
  await e.ensureTokenizer();
  await e.recycle();
  assert.deepEqual(calls, ['embed:2:64', 'tok', 'close']);
});
