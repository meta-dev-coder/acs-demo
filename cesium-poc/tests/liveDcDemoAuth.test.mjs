import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLoginLimiter, createSessionSigner, hashPassword, parseCookies, parsePasswordHash, verifyPassword,
} from '../server/liveDc/demoAuth.mjs';

const FAST = { N: 1024 };

test('demoAuth: scrypt hash is salted, self-describing and verifies only the right password', () => {
  const a = hashPassword('correct horse', FAST);
  const b = hashPassword('correct horse', FAST);
  assert.match(a, /^scrypt\$1024\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.ok(!a.includes('correct'));
  assert.equal(verifyPassword('correct horse', a), true);
  assert.equal(verifyPassword('correct horsE', a), false);
  assert.equal(verifyPassword('', a), false);
  assert.equal(verifyPassword(undefined, a), false);
});

test('demoAuth: default cost is scrypt N=16384', () => {
  assert.match(hashPassword('x'), /^scrypt\$16384\$8\$1\$/);
});

test('demoAuth: malformed stored hashes are rejected, never matched', () => {
  for (const bad of ['', 'plain', 'scrypt$1024$8$1$abc', 'bcrypt$1$2$3$4$5', 'scrypt$0$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA']) {
    assert.throws(() => parsePasswordHash(bad), /LIVE_DEMO_PASSWORD_HASH/);
    assert.equal(verifyPassword('anything', bad), false);
  }
  assert.throws(() => hashPassword(''), /empty/);
});

test('demoAuth: session tokens verify, expire after the TTL and reject tampering', () => {
  let now = 1_000_000;
  const hash = hashPassword('pw', FAST);
  const signer = createSessionSigner({ passwordHash: hash, now: () => now, ttlMs: 8 * 3600_000 });
  const token = signer.issue();
  assert.equal(signer.verify(token), true);
  const [v, exp, nonce, sig] = token.split('.');
  assert.equal(v, 'v1');
  assert.equal(Number(exp), now + 8 * 3600_000);
  assert.equal(signer.verify(`${v}.${Number(exp) + 1000}.${nonce}.${sig}`), false, 'extended expiry');
  assert.equal(signer.verify(`${v}.${exp}.${nonce}x.${sig}`), false, 'changed nonce');
  assert.equal(signer.verify(`${v}.${exp}.${nonce}.${sig.slice(0, -2)}AA`), false, 'changed signature');
  for (const junk of [undefined, '', 'v1', 'a.b.c.d', `v2.${exp}.${nonce}.${sig}`]) assert.equal(signer.verify(junk), false);
  now += 8 * 3600_000 - 1;
  assert.equal(signer.verify(token), true);
  now += 2;
  assert.equal(signer.verify(token), false, 'expired');
});

test('demoAuth: a different process key or a changed password invalidates sessions', () => {
  const hash = hashPassword('pw', FAST);
  const key = Buffer.alloc(32, 7);
  const token = createSessionSigner({ passwordHash: hash, key }).issue();
  assert.equal(createSessionSigner({ passwordHash: hash, key }).verify(token), true);
  assert.equal(createSessionSigner({ passwordHash: hash }).verify(token), false, 'new random key per process');
  assert.equal(createSessionSigner({ passwordHash: hashPassword('pw2', FAST), key }).verify(token), false, 'password changed');
});

test('demoAuth: limiter locks an address after 5 failures for 15 minutes; success resets', () => {
  let now = 0;
  const limiter = createLoginLimiter({ now: () => now });
  for (let i = 0; i < 4; i++) { assert.equal(limiter.check('1.1.1.1').locked, false); limiter.fail('1.1.1.1'); }
  assert.equal(limiter.check('1.1.1.1').locked, false);
  limiter.fail('1.1.1.1');
  const locked = limiter.check('1.1.1.1');
  assert.equal(locked.locked, true);
  assert.equal(locked.retryAfterSeconds, 900);
  assert.equal(limiter.check('2.2.2.2').locked, false, 'per address');
  now += 15 * 60_000 - 1000;
  assert.equal(limiter.check('1.1.1.1').locked, true);
  now += 1000;
  assert.equal(limiter.check('1.1.1.1').locked, false);
  limiter.fail('2.2.2.2');
  limiter.succeed('2.2.2.2');
  for (let i = 0; i < 4; i++) limiter.fail('2.2.2.2');
  assert.equal(limiter.check('2.2.2.2').locked, false);
});

test('demoAuth: cookie header parsing', () => {
  assert.deepEqual(parseCookies('a=1; live_dc_session=v1.2.3.4;b=x%20y'), { a: '1', live_dc_session: 'v1.2.3.4', b: 'x y' });
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('bad; =x; c=%E0'), { c: '%E0' });
});
