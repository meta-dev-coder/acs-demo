/**
 * Password gate for the EC2 demo host: scrypt password hash (LIVE_DEMO_PASSWORD_HASH), HMAC-signed
 * session tokens and a per-address login limiter. Nothing here logs or returns a password.
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const HASH_RE = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]{16,})\$([A-Za-z0-9_-]{43})$/;
const KEY_LENGTH = 32;
const MAX_MEM = 256 * 1024 * 1024;

export function parsePasswordHash(stored) {
  const match = HASH_RE.exec(String(stored ?? '').trim());
  const invalid = () => new Error('LIVE_DEMO_PASSWORD_HASH is not a valid scrypt hash (generate one with --hash-password)');
  if (!match) throw invalid();
  const [N, r, p] = match.slice(1, 4).map(Number);
  if (N < 2 || (N & (N - 1)) !== 0 || N > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) throw invalid();
  return { N, r, p, salt: Buffer.from(match[4], 'base64url'), hash: Buffer.from(match[5], 'base64url') };
}

export function hashPassword(password, { N = 16384, r = 8, p = 1, salt = randomBytes(16) } = {}) {
  if (typeof password !== 'string' || !password) throw new Error('password must not be empty');
  const hash = scryptSync(password, salt, KEY_LENGTH, { N, r, p, maxmem: MAX_MEM });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  let parsed;
  try { parsed = parsePasswordHash(stored); } catch { return false; }
  if (typeof password !== 'string' || !password || password.length > 1024) return false;
  const { N, r, p, salt, hash } = parsed;
  const candidate = scryptSync(password, salt, hash.length, { N, r, p, maxmem: MAX_MEM });
  return timingSafeEqual(candidate, hash);
}

/** Sessions are signed with a per-process random key bound to the password hash. */
export function createSessionSigner({ passwordHash, key = randomBytes(32), ttlMs = 8 * 3600_000, now = Date.now }) {
  const secret = createHmac('sha256', key).update(String(passwordHash)).digest();
  const sign = payload => createHmac('sha256', secret).update(payload).digest('base64url');
  return {
    ttlMs,
    issue() {
      const payload = `v1.${now() + ttlMs}.${randomBytes(16).toString('base64url')}`;
      return `${payload}.${sign(payload)}`;
    },
    verify(token) {
      const parts = typeof token === 'string' ? token.split('.') : [];
      if (parts.length !== 4 || parts[0] !== 'v1' || !/^\d{1,16}$/.test(parts[1])) return false;
      const expected = Buffer.from(sign(parts.slice(0, 3).join('.')));
      const given = Buffer.from(parts[3]);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
      return Number(parts[1]) > now();
    },
  };
}

export function createLoginLimiter({ maxFailures = 5, lockoutMs = 15 * 60_000, now = Date.now, maxEntries = 10_000 } = {}) {
  const entries = new Map();
  const current = ip => {
    const entry = entries.get(ip);
    if (entry && now() - entry.since >= lockoutMs && !(entry.lockedUntil > now())) { entries.delete(ip); return null; }
    return entry ?? null;
  };
  return {
    check(ip) {
      const entry = current(ip);
      if (entry?.lockedUntil > now()) return { locked: true, retryAfterSeconds: Math.ceil((entry.lockedUntil - now()) / 1000) };
      if (entry?.lockedUntil) entries.delete(ip);
      return { locked: false, retryAfterSeconds: 0 };
    },
    fail(ip) {
      if (entries.size >= maxEntries && !entries.has(ip)) entries.delete(entries.keys().next().value);
      const entry = current(ip) ?? { failures: 0, since: now(), lockedUntil: 0 };
      entry.failures += 1;
      if (entry.failures >= maxFailures) entry.lockedUntil = now() + lockoutMs;
      entries.set(ip, entry);
    },
    succeed(ip) { entries.delete(ip); },
  };
}

export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    if (!name) continue;
    try { cookies[name] = decodeURIComponent(raw); } catch { cookies[name] = raw; }
  }
  return cookies;
}
