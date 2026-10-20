import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openBotSession, runWrite } from '../src/bot-session.ts';

const sidecar = {
  async embedBatch(texts: string[]) { return { vectors: texts.map(t => { const v = new Float32Array(384); v[t.length % 384] = 1; return v; }), latencyMs: 1 }; },
  async tokenCounts(texts: string[]) { return texts.map(t => t.split(/\s+/).length + 2); },
  async loadTokenizer() {}, async close() {},
};

test('write verbs run through a session; the store survives reopening from the state dir', async () => {
  process.env.SEEK_MCP_STATE = await mkdtemp(join(tmpdir(), 'seek-st-'));
  const root = await mkdtemp(join(tmpdir(), 'seek-sv-'));
  await mkdir(join(root, '.obsidian/plugins/seek'), { recursive: true });
  await writeFile(join(root, 'a.md'), `# a\n\n${'alpha text here '.repeat(40)}\n`);
  const s = await openBotSession(root, sidecar);
  await runWrite(s, 'index_vault');
  const n = (await s.store.count()).chunks;
  assert.ok(n >= 1);
  assert.deepEqual((await runWrite(s, 'index_delta') as any).delta, { dirty: 0, deleted: 0 });
  assert.ok(await runWrite(s, 'compact_sidecar'));
  await assert.rejects(runWrite(s, 'nope'), /unknown write tool/);
  const again = await openBotSession(root, sidecar);
  assert.equal((await again.store.count()).chunks, n);
  assert.equal(again.deviceId, s.deviceId);
});
