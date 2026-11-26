/**
 * Server-side session storage for the Autodesk Platform Services sign-in.
 *
 * The browser holds only an opaque, random session id in an HttpOnly cookie scoped to /api/aps.
 * Access tokens, refresh tokens and the PKCE verifiers stay here and are never sent to the page.
 *
 * Two stores, one interface (`get`, `set`, `delete`, `entries`):
 *  - memory (default): local development. Everything is lost on restart, so restarting the dev
 *    server means signing in again. Nothing is written to disk.
 *  - encrypted file: set APS_SESSION_ENCRYPTION_KEY (32 bytes, hex or base64). The whole session
 *    map is sealed with AES-256-GCM and written atomically with mode 0600, so a session survives a
 *    restart and the file on disk is useless without the key. Keep the key in the environment or
 *    a secret manager, never next to the file.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const SESSION_COOKIE = 'aps_sid';
/** Autodesk refresh tokens last 15 days; a session idle longer than 14 is dropped. */
export const SESSION_TTL_MS = 14 * 24 * 3600 * 1000;

export const newSessionId = () => randomBytes(32).toString('base64url');

export function createMemoryStore() {
  const map = new Map();
  return {
    kind: 'memory',
    get: id => map.get(id) ?? null,
    set: (id, value) => { map.set(id, value); },
    delete: id => { map.delete(id); },
    entries: () => [...map.entries()],
  };
}

/** A 32-byte key from 64 hex characters or base64. Anything else is refused, never padded. */
export function parseEncryptionKey(text) {
  const raw = String(text ?? '').trim();
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('APS_SESSION_ENCRYPTION_KEY must be 32 bytes (64 hex characters or base64).');
  return key;
}

export function seal(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function unseal(buffer, key) {
  const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
  decipher.setAuthTag(buffer.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8'));
}

export function createEncryptedFileStore({ path, key, logger = console }) {
  const secret = parseEncryptionKey(key);
  let map = new Map();
  if (existsSync(path)) {
    try { map = new Map(Object.entries(unseal(readFileSync(path), secret))); }
    // A wrong key or a damaged file starts empty rather than stopping the dev server. Say which
    // file, never what was in it.
    catch { logger.warn?.(`aps: session store ${path} could not be decrypted; starting with no sessions.`); }
  }
  const persist = () => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, seal(Object.fromEntries(map), secret), { mode: 0o600 });
    renameSync(temp, path);
  };
  return {
    kind: 'encrypted-file',
    get: id => map.get(id) ?? null,
    set: (id, value) => { map.set(id, value); persist(); },
    delete: id => { if (map.delete(id)) persist(); },
    entries: () => [...map.entries()],
  };
}

export function createSessionStore(env = process.env, { logger = console, defaultPath } = {}) {
  const key = String(env.APS_SESSION_ENCRYPTION_KEY ?? '').trim();
  if (!key) return createMemoryStore();
  return createEncryptedFileStore({ path: String(env.APS_SESSION_STORE_PATH ?? '').trim() || defaultPath, key, logger });
}

export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return cookies;
}

/**
 * SameSite=Lax, not Strict: Autodesk sends the browser back to the callback with a cross-site
 * top-level redirect, and a Strict cookie would be withheld on exactly that request.
 */
/** Every value a cookie name carries: the browser sends one per matching Path, most specific first. */
export function cookieValues(header, name) {
  const values = [];
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) values.push(part.slice(eq + 1).trim());
  }
  return values;
}

/**
 * Path=/api: the session is read by /api/aps/* and by the routes that use the sign-in
 * (/api/ifc-spatial/*). It was /api/aps at first, which kept the cookie from reaching those routes;
 * `legacySessionCookieClear` expires that older cookie.
 */
export const SESSION_COOKIE_PATH = '/api';
export function sessionCookie(id, { secure = false, maxAgeMs = SESSION_TTL_MS, path = SESSION_COOKIE_PATH } = {}) {
  return [`${SESSION_COOKIE}=${id}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`, ...(secure ? ['Secure'] : [])].join('; ');
}
export const legacySessionCookieClear = ({ secure = false } = {}) => sessionCookie('', { secure, maxAgeMs: 0, path: '/api/aps' });
