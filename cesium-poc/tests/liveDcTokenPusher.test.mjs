import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HANDOFF_MAX_AGE_MS, createDcTokenPusher, loadTokenHandoffConfig } from '../server/dcTokenPusher.mjs';

const T0 = Date.parse('2026-09-26T12:00:00Z');
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const tokenFor = (n, expMs = T0 + 3600_000) => `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(expMs / 1000), n })}.sig${n}`;

function harness({ url = 'https://intake.example/', status = 200, file = tokenFor(1) } = {}) {
  let clock = T0;
  let content = file;
  const posts = [];
  const lines = [];
  const intervals = [];
  const pusher = createDcTokenPusher({
    config: loadTokenHandoffConfig({ DC_TOKEN_HANDOFF_URL: url, DC_TOKEN_HANDOFF_FILE: '/tmp/token-file' }),
    fetchImpl: async (target, init) => { posts.push({ target, init }); return new Response(JSON.stringify({ ok: status === 200 }), { status }); },
    readFile: () => { if (content == null) throw new Error('ENOENT'); return `${content}\n`; },
    now: () => clock,
    setIntervalImpl: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearIntervalImpl: () => {},
    logger: Object.fromEntries(['log', 'info', 'warn', 'error'].map(level => [level, (...args) => lines.push(args.map(String).join(' '))])),
  });
  return {
    pusher, posts, lines, intervals,
    advance: ms => { clock += ms; },
    write: value => { content = value; },
  };
}

test('handoff config: disabled without a URL; defaults to the dc:login access-token file', () => {
  assert.equal(loadTokenHandoffConfig({}).url, '');
  assert.equal(loadTokenHandoffConfig({}).file, '.dc-access-token');
  assert.equal(loadTokenHandoffConfig({ DC_ACCESS_STORE: 'x.tok' }).file, 'x.tok');
  assert.equal(loadTokenHandoffConfig({ DC_ACCESS_STORE: 'x.tok', DC_TOKEN_HANDOFF_FILE: 'y.tok' }).file, 'y.tok');
});

test('handoff: a no-op without DC_TOKEN_HANDOFF_URL: no timer, no read, no request', async () => {
  let reads = 0;
  const intervals = [];
  const pusher = createDcTokenPusher({
    config: loadTokenHandoffConfig({}),
    fetchImpl: async () => { throw new Error('must not post'); },
    readFile: () => { reads++; return 'x'; },
    setIntervalImpl: (...args) => { intervals.push(args); return 1; },
  });
  assert.equal(pusher.enabled, false);
  pusher.start();
  assert.equal(await pusher.tick(), 'disabled');
  assert.equal(reads, 0);
  assert.equal(intervals.length, 0);
});

test('handoff: posts the token as a Bearer header on first sight, then not again while unchanged', async () => {
  const h = harness();
  assert.equal(await h.pusher.tick(), 'pushed');
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].target, 'https://intake.example/');
  assert.equal(h.posts[0].init.method, 'POST');
  assert.equal(h.posts[0].init.headers.authorization, `Bearer ${tokenFor(1)}`);
  h.advance(60_000);
  assert.equal(await h.pusher.tick(), 'unchanged');
  assert.equal(h.posts.length, 1);
});

test('handoff: posts again as soon as the file changes', async () => {
  const h = harness();
  await h.pusher.tick();
  h.advance(60_000);
  h.write(tokenFor(2));
  assert.equal(await h.pusher.tick(), 'pushed');
  assert.equal(h.posts.length, 2);
  assert.equal(h.posts[1].init.headers.authorization, `Bearer ${tokenFor(2)}`);
});

test('handoff: re-posts an unchanged token at least every 50 minutes', async () => {
  assert.equal(HANDOFF_MAX_AGE_MS, 50 * 60_000);
  const h = harness({ file: tokenFor(1, T0 + 3 * 3600_000) });
  await h.pusher.tick();
  h.advance(49 * 60_000);
  assert.equal(await h.pusher.tick(), 'unchanged');
  h.advance(60_000);
  assert.equal(await h.pusher.tick(), 'pushed');
  assert.equal(h.posts.length, 2);
});

test('handoff: start() checks at once and on an interval shorter than the 50-minute re-post', async () => {
  const h = harness();
  h.pusher.start();
  await h.pusher.idle();
  assert.equal(h.posts.length, 1);
  assert.equal(h.intervals.length, 1);
  assert.ok(h.intervals[0].ms <= 60_000);
  h.write(tokenFor(3));
  h.intervals[0].fn();
  await h.pusher.idle();
  assert.equal(h.posts.length, 2);
});

test('handoff: a missing, empty or nearly expired token file is not posted', async () => {
  const missing = harness({ file: null });
  assert.equal(await missing.pusher.tick(), 'no_token');
  const empty = harness({ file: '' });
  assert.equal(await empty.pusher.tick(), 'no_token');
  const expiring = harness({ file: tokenFor(1, T0 + 2 * 60_000) });
  assert.equal(await expiring.pusher.tick(), 'expiring');
  assert.equal(missing.posts.length + empty.posts.length + expiring.posts.length, 0);
});

test('handoff: a rejected push is retried later, not on every tick', async () => {
  const h = harness({ status: 403 });
  assert.equal(await h.pusher.tick(), 'rejected');
  h.advance(60_000);
  assert.equal(await h.pusher.tick(), 'unchanged');
  h.advance(5 * 60_000);
  assert.equal(await h.pusher.tick(), 'rejected');
  assert.equal(h.posts.length, 2);
});

test('handoff: the token never reaches a log line', async () => {
  const token = tokenFor(7);
  for (const status of [200, 401, 403, 500]) {
    const h = harness({ status, file: token });
    await h.pusher.tick();
    assert.ok(h.lines.length > 0);
    for (const line of h.lines) assert.ok(!line.includes(token) && !line.includes('sig7'), line);
  }
  const lines = [];
  const failing = createDcTokenPusher({
    config: loadTokenHandoffConfig({ DC_TOKEN_HANDOFF_URL: 'https://intake.example/' }),
    fetchImpl: async () => { throw new Error(`network down ${token}`); },
    readFile: () => token,
    now: () => T0,
    logger: Object.fromEntries(['log', 'info', 'warn', 'error'].map(level => [level, (...args) => lines.push(args.map(String).join(' '))])),
  });
  assert.equal(await failing.tick(), 'failed');
  for (const line of lines) assert.ok(!line.includes(token), line);
});
