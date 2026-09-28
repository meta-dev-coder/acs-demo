import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DC_TOKEN_OBJECT_KEY, bearerToken, hasPermission, jwtClaims, tokenExpiresAtMs,
} from '../server/liveDc/tokenHandoff.mjs';
import { createIntakeHandler, loadIntakeConfig } from '../infra/lambdas/dc-token-intake/intake.mjs';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = claims => `${b64({ alg: 'RS256' })}.${b64(claims)}.c2lnbmF0dXJl`;
const expIn = (ms, extra = {}) => jwt({ exp: Math.floor((NOW + ms) / 1000), sub: 'user-1', email: 'ops@example.com', ...extra });

const config = loadIntakeConfig({
  DC_TOKEN_BUCKET: 'data-bucket',
  DC_TOKEN_KMS_KEY_ARN: 'arn:aws:kms:us-east-1:111122223333:key/abc',
  DC_TOKEN_ALLOWED_ORIGINS: 'http://localhost:5188,https://meta-dev-coder.github.io',
});

function harness({ permissions = ['dcm-admin', 'dce-read'], status = 200, cfg = config } = {}) {
  const puts = [];
  const calls = [];
  const lines = [];
  const logger = Object.fromEntries(['log', 'info', 'warn', 'error'].map(level => [level, (...args) => lines.push(args.map(String).join(' '))]));
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(permissions), { status, headers: { 'content-type': 'application/json' } });
  };
  const handler = createIntakeHandler({ config: cfg, putObject: async params => { puts.push(params); }, fetchImpl, now: () => NOW, logger });
  const post = (token, headers = {}) => handler({
    requestContext: { http: { method: 'POST' } },
    headers: { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...headers },
    body: '',
  });
  return { handler, post, puts, calls, lines };
}

const bodyOf = res => JSON.parse(res.body);

test('tokenHandoff: decodes JWT claims and expiry, never throws on garbage', () => {
  const token = expIn(3600_000);
  assert.equal(jwtClaims(token).sub, 'user-1');
  assert.equal(tokenExpiresAtMs(token), Math.floor((NOW + 3600_000) / 1000) * 1000);
  for (const bad of ['', 'abc', 'a.b.c', null, undefined, `x.${b64({ sub: 'no-exp' })}.y`]) assert.equal(tokenExpiresAtMs(bad), null);
});

test('tokenHandoff: bearerToken and hasPermission', () => {
  assert.equal(bearerToken({ authorization: 'Bearer abc' }), 'abc');
  assert.equal(bearerToken({ Authorization: 'bearer  abc ' }), 'abc');
  assert.equal(bearerToken({ authorization: 'Basic abc' }), '');
  assert.equal(bearerToken({}), '');
  assert.ok(hasPermission(['dcm-admin'], 'dcm-admin'));
  assert.ok(hasPermission({ permissions: [{ name: 'DCM-Admin' }] }, 'dcm-admin'));
  assert.ok(hasPermission({ roles: { data: ['dce-read', 'dcm-admin'] } }, 'dcm-admin'));
  assert.ok(!hasPermission({ permissions: ['dce-read', 'dcm-read'] }, 'dcm-admin'));
  assert.ok(!hasPermission(null, 'dcm-admin'));
});

test('intake: a valid admin token is stored with SSE-KMS under the secrets key', async () => {
  const token = expIn(3600_000);
  const h = harness();
  const res = await h.post(token);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(bodyOf(res), { ok: true, expiresAt: new Date(tokenExpiresAtMs(token)).toISOString() });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, 'https://dataconnect-demo-dqa3.cohesivecloud.app/api/user-mgmt/permission');
  assert.equal(h.calls[0].init.method, 'GET');
  assert.equal(h.calls[0].init.headers.authorization, `Bearer ${token}`);
  assert.equal(h.puts.length, 1);
  const put = h.puts[0];
  assert.equal(put.Bucket, 'data-bucket');
  assert.equal(put.Key, DC_TOKEN_OBJECT_KEY);
  assert.equal(put.Key, 'secrets/dc-token.txt');
  assert.equal(put.Body, token);
  assert.equal(put.ServerSideEncryption, 'aws:kms');
  assert.equal(put.SSEKMSKeyId, 'arn:aws:kms:us-east-1:111122223333:key/abc');
  assert.equal(put.CacheControl, 'no-store');
});

test('intake: missing, malformed and nearly expired tokens are 401 without calling DataConnect', async () => {
  for (const token of [undefined, '', 'not-a-jwt', jwt({ sub: 'x' }), expIn(-60_000), expIn(4 * 60_000)]) {
    const h = harness();
    const res = await h.post(token);
    assert.equal(res.statusCode, 401, String(token));
    assert.equal(bodyOf(res).ok, false);
    assert.equal(h.calls.length, 0);
    assert.equal(h.puts.length, 0);
  }
});

test('intake: a token DataConnect rejects is 401; one without dcm-admin is 403', async () => {
  const rejected = harness({ status: 401 });
  assert.equal((await rejected.post(expIn(3600_000))).statusCode, 401);
  assert.equal(rejected.puts.length, 0);

  const reader = harness({ permissions: { permissions: ['dce-read', 'dcm-read'] } });
  const res = await reader.post(expIn(3600_000));
  assert.equal(res.statusCode, 403);
  assert.equal(bodyOf(res).error, 'not_admin');
  assert.equal(reader.puts.length, 0);

  const down = harness({ status: 503 });
  assert.equal((await down.post(expIn(3600_000))).statusCode, 502);
  assert.equal(down.puts.length, 0);
});

test('intake: the optional subject allow-list matches sub or email', async () => {
  const cfg = loadIntakeConfig({ DC_TOKEN_BUCKET: 'b', DC_TOKEN_KMS_KEY_ARN: 'k', DC_TOKEN_ALLOWED_SUBJECTS: 'ops@example.com, other-sub' });
  const ok = harness({ cfg });
  assert.equal((await ok.post(expIn(3600_000))).statusCode, 200);
  const bySub = harness({ cfg });
  assert.equal((await bySub.post(expIn(3600_000, { sub: 'other-sub', email: 'x@example.com' }))).statusCode, 200);
  const denied = harness({ cfg });
  const res = await denied.post(expIn(3600_000, { sub: 'stranger', email: 'stranger@example.com' }));
  assert.equal(res.statusCode, 403);
  assert.equal(bodyOf(res).error, 'subject_not_allowed');
  assert.equal(denied.calls.length, 0);
  assert.equal(denied.puts.length, 0);
});

test('intake: only POST; CORS only for the allowed origins', async () => {
  const h = harness();
  const get = await h.handler({ requestContext: { http: { method: 'GET' } }, headers: {} });
  assert.equal(get.statusCode, 405);
  const pre = await h.handler({ requestContext: { http: { method: 'OPTIONS' } }, headers: { origin: 'http://localhost:5188' } });
  assert.equal(pre.statusCode, 204);
  assert.equal(pre.headers['access-control-allow-origin'], 'http://localhost:5188');
  assert.match(pre.headers['access-control-allow-headers'], /authorization/);
  const evil = await h.handler({ requestContext: { http: { method: 'OPTIONS' } }, headers: { origin: 'https://evil.example' } });
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
});

test('intake: unconfigured bucket or key refuses with 503 and stores nothing', async () => {
  const h = harness({ cfg: loadIntakeConfig({}) });
  const res = await h.post(expIn(3600_000));
  assert.equal(res.statusCode, 503);
  assert.equal(h.puts.length, 0);
});

test('intake: the token never appears in a response or a log line, whatever the outcome', async () => {
  const token = expIn(3600_000, { sub: 'stranger' });
  const cases = [
    harness(), harness({ status: 401 }), harness({ permissions: [] }), harness({ status: 500 }),
    harness({ cfg: loadIntakeConfig({ DC_TOKEN_BUCKET: 'b', DC_TOKEN_KMS_KEY_ARN: 'k', DC_TOKEN_ALLOWED_SUBJECTS: 'someone' }) }),
  ];
  const failingStore = createIntakeHandler({
    config, fetchImpl: async () => new Response('["dcm-admin"]'), now: () => NOW,
    putObject: async () => { throw new Error(`boom ${token}`); },
    logger: { log() {}, info() {}, warn() {}, error: (...args) => cases[0].lines.push(args.map(String).join(' ')) },
  });
  const extra = await failingStore({ requestContext: { http: { method: 'POST' } }, headers: { authorization: `Bearer ${token}` } });
  assert.equal(extra.statusCode, 500);
  assert.ok(!extra.body.includes(token));
  for (const h of cases) {
    const res = await h.post(token);
    assert.ok(!JSON.stringify(res).includes(token));
    for (const line of h.lines) assert.ok(!line.includes(token), line);
  }
  const signature = token.split('.')[2];
  for (const h of cases) for (const line of h.lines) assert.ok(!line.includes(signature));
});
