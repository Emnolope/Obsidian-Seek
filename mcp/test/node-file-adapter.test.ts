import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { nodeFileAdapter } from '../src/node-file-adapter.ts';
import { bulkAppend, scanJsonl as scanViaAdapter, readRecordAt as readViaAdapter, listDeviceJsonls } from '../../core/sidecar.ts';
import { scanJsonl, readRecordAt } from '../src/sidecar.ts';
import { SIGN_BYTES } from '../../core/format.ts';

const tiers = (n: number) => ({ q: Int8Array.from({ length: 384 }, (_, i) => (i === n ? 127 : 0)), s: 1 / 127, sign: new Uint8Array(SIGN_BYTES).fill(n + 1) });

test('core writer through the Node adapter is readable by both readers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seek-fa-'));
  const a = nodeFileAdapter(root);
  const dir = 'index';
  await bulkAppend(a, dir, 'bot-0001', [{ id: 'x', tiers: tiers(0), mtime: 5 }, { id: 'y', tiers: tiers(1), mtime: 6 }]);
  assert.ok((await listDeviceJsonls(a, dir)).length === 1);

  const viaCore = await scanViaAdapter(a, await listDeviceJsonls(a, dir));
  const viaMcp = await scanJsonl(join(root, dir));
  assert.deepEqual([...viaCore.map.keys()].sort(), ['x', 'y']);
  assert.deepEqual([...viaMcp.map.keys()].sort(), ['x', 'y']);

  const e = viaMcp.map.get('y')!;
  const t1 = await readRecordAt(join(root, dir), e);
  const t2 = await readViaAdapter(a, dir, e);
  assert.equal(t1.q[1], 127);
  assert.deepEqual(t2?.q, t1.q);
  assert.deepEqual((await readdir(join(root, dir))).filter(f => f.endsWith('.tmp')), []);
});
