import assert from 'node:assert/strict';
import test from 'node:test';
import { chromiumProfile, stateDirFor } from '../src/base.ts';

// Why: the model cache lives in the Chromium profile; if it sits in /tmp it dies on reboot and the model re-downloads.
test('profile lives under the state base, shared across vaults', () => {
  const env = { SEEK_MCP_STATE: '/s' };
  assert.equal(chromiumProfile(env), '/s/chromium');
  assert.ok(stateDirFor('/v1', env).startsWith('/s/') && stateDirFor('/v1', env) !== chromiumProfile(env));
});

test('explicit profile override wins', () => {
  assert.equal(chromiumProfile({ SEEK_MCP_CHROMIUM_PROFILE: '/p', SEEK_MCP_STATE: '/s' }), '/p');
});
