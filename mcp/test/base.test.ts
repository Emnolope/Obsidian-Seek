import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { botDeviceId, botLogger, readVaultFile, stateDirFor, vaultFiles } from '../src/base.ts';
import { nodeFileAdapter } from '../src/node-file-adapter.ts';

test('stateDirFor honors the override, scopes per vault, and never lands inside the vault', () => {
  const a = stateDirFor('/v/one', { SEEK_MCP_STATE: '/s' }), b = stateDirFor('/v/two', { SEEK_MCP_STATE: '/s' });
  assert.ok(a.startsWith('/s/') && a !== b);
  assert.ok(stateDirFor('/v/one', { XDG_STATE_HOME: '/x' }).startsWith('/x/seek-mcp/'));
  assert.ok(!a.startsWith('/v/'));
});

test('device id is generated once, bot-shaped, then stable', async () => {
  const s = nodeFileAdapter(await mkdtemp(join(tmpdir(), 'seek-id-')));
  const id = await botDeviceId(s);
  assert.match(id, /^bot-[0-9a-f]{8}$/);
  assert.equal(await botDeviceId(s), id);
});

test('vaultFiles lists notes (and bases on request), skips dot-dirs, carries mtime; reads back content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seek-vault-'));
  await mkdir(join(root, 'sub'));
  await mkdir(join(root, '.obsidian'));
  await writeFile(join(root, 'a.md'), 'alpha');
  await writeFile(join(root, 'sub/b.md'), 'beta');
  await writeFile(join(root, 'v.base'), 'views: []');
  await writeFile(join(root, '.obsidian/c.md'), 'hidden');
  await writeFile(join(root, 'x.png'), 'no');
  assert.deepEqual((await vaultFiles(root)).map(f => f.path).sort(), ['a.md', 'sub/b.md']);
  const withBases = await vaultFiles(root, { indexBases: true });
  assert.deepEqual(withBases.map(f => f.path).sort(), ['a.md', 'sub/b.md', 'v.base']);
  assert.ok(withBases.every(f => f.mtime > 0));
  assert.equal(await readVaultFile(root)(withBases.find(f => f.path === 'sub/b.md')!), 'beta');
});

test('logger appends stamped ndjson rows under the plugin log dir', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seek-log-'));
  const log = botLogger(nodeFileAdapter(root), 'bot-deadbeef');
  await log.append({ type: 'error', timestamp: 't', context: 'x', message: 'x' } as never);
  const rows = (await readFile(join(root, '.obsidian/plugins/seek/logs/seek-log-bot-deadbeef.ndjson'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows[0].deviceId, 'bot-deadbeef');
  assert.equal(rows[0].type, 'x');
});
