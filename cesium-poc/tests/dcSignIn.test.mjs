import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSignInFlow } from '../server/dcSignIn.mjs';
test('API callback completes sign-in when root app owns callback port; wrong state is rejected', async () => {
  const root = createServer();
  await new Promise(resolve => root.listen(0, resolve));
  const dir = mkdtempSync(join(tmpdir(), 'dc-signin-test-'));
  let exchanges = 0;
  const flow = createSignInFlow({ config: {
    redirectUri: `http://localhost:${root.address().port}/signin-callback`, clientId: 'test',
    scope: 'test', tokenUrl: 'https://example.test/token', accessStore: join(dir, 'access'), tokenStore: join(dir, 'refresh'),
  }, logger: {}, fetchImpl: async (_url, options) => {
    if (options?.method === 'POST') {
      exchanges++;
      assert.equal(options.body.get('code'), 'test-code');
      assert.ok(options.body.get('code_verifier'));
      return { ok: true, json: async () => ({ access_token: 'test-only-token', expires_in: 3600 }) };
    }
    return { headers: new Headers() };
  } });
  const response = () => ({ writeHead(status) { this.status = status; }, end(body) { this.body = body; } });
  try {
    const { url } = await flow.start();
    const state = new URL(url).searchParams.get('state');
    assert.ok(state.startsWith('dc-maintenance-'));
    const wrong = response();
    await flow.callback({ url: '/signin/callback?state=wrong&code=test-code' }, wrong);
    assert.equal(wrong.status, 400); assert.equal(flow.pending, true); assert.equal(exchanges, 0);
    const valid = response();
    await flow.callback({ url: `/signin/callback?state=${state}&code=test-code` }, valid);
    assert.equal(valid.status, 200); assert.match(valid.body, /window.close/);
    assert.equal(flow.pending, false); assert.equal(flow.lastResult.ok, true);
    assert.equal(readFileSync(join(dir, 'access'), 'utf8').trim(), 'test-only-token');
  } finally { flow.cancel(); await new Promise(resolve => root.close(resolve)); rmSync(dir, { recursive: true, force: true }); }
});
