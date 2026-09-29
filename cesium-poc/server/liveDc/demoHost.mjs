/**
 * One HTTP host for the EC2 demo: a password gate (/login, /api/login), the built frontend from webDir,
 * the read-only API handlers and /healthz. Everything except /login, /api/login, /api/logout and
 * /healthz needs a session. Only GET/HEAD reach the API handlers, plus POST on the two curated-data
 * read routes; the DataConnect interactive sign-in routes are not exposed.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLoginLimiter, createSessionSigner, parseCookies, verifyPassword } from './demoAuth.mjs';

export const SESSION_COOKIE = 'live_dc_session';
const MAX_LOGIN_BODY = 4096;
const CURATED_READ = /^\/api\/(live-dc|dataconnect)\/class\/[^/]+\/curated-data$/;
const SIGN_IN = /^\/api\/dataconnect\/signin(\/|$)/;
const ASK = '/api/i595/ask';
const STATUS_FILE = '/status/live-dc-status.json';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.geojson': 'application/geo+json',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.ktx2': 'image/ktx2', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.b3dm': 'application/octet-stream', '.i3dm': 'application/octet-stream', '.pnts': 'application/octet-stream',
  '.cmpt': 'application/octet-stream', '.subtree': 'application/octet-stream',
};

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin',
};

function loginPage(nonce) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>I-595 live demo</title><style nonce="${nonce}">
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1720;color:#e6edf3;font:15px system-ui,sans-serif}
form{background:#18222d;padding:28px;border-radius:10px;width:min(320px,90vw);box-shadow:0 8px 30px #0006}
h1{font-size:18px;margin:0 0 16px}input,button{width:100%;box-sizing:border-box;padding:10px;border-radius:6px;font:inherit}
input{border:1px solid #334;background:#0f1720;color:inherit;margin-bottom:12px}button{border:0;background:#2f81f7;color:#fff;cursor:pointer}
p{min-height:1.2em;color:#ff8a8a;margin:10px 0 0;font-size:13px}</style></head><body>
<form id="f"><h1>I-595 live demo</h1><input id="pw" type="password" autocomplete="current-password" placeholder="Password" required autofocus>
<button type="submit">Sign in</button><p id="m" role="alert"></p></form>
<script nonce="${nonce}">
document.getElementById('f').addEventListener('submit', async e => {
  e.preventDefault();
  const m = document.getElementById('m'); m.textContent = '';
  const next = new URLSearchParams(location.search).get('next') || undefined;
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('pw').value, next }) });
    const b = await r.json().catch(() => ({}));
    if (r.ok) { location.href = b.next || '/'; return; }
    m.textContent = b.error || 'Sign-in failed.';
  } catch { m.textContent = 'Could not reach the server.'; }
  document.getElementById('pw').value = '';
});
</script></body></html>`;
}

function readBody(req, limit) {
  return new Promise((done, fail) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) over = true; else chunks.push(chunk);
    });
    req.on('end', () => (over ? fail(Object.assign(new Error('too large'), { status: 413 })) : done(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', fail);
  });
}

export function createDemoHost({
  passwordHash, webDir, apiHandlers = [], status = {}, logger = console, now = Date.now, sessionKey,
  sessionTtlMs = 8 * 3600_000, maxFailures = 5, lockoutMs = 15 * 60_000, home = '/?demo=i595',
}) {
  if (!passwordHash) throw new Error('LIVE_DEMO_PASSWORD_HASH is required for the HTTP host');
  const signer = createSessionSigner({ passwordHash, key: sessionKey, ttlMs: sessionTtlMs, now });
  const limiter = createLoginLimiter({ maxFailures, lockoutMs, now });
  const webRoot = webDir && existsSync(webDir) ? realpathSync(webDir) : null;
  const safeNext = next => (typeof next === 'string' && next.length < 2048 && /^\/(?![/\\])[^\s\\]*$/.test(next) ? next : home);

  const send = (req, res, code, body, headers = {}) => {
    if (!req.readableEnded) req.resume();
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(code, {
      ...BASE_HEADERS, 'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
      'cache-control': 'no-store', ...headers,
    });
    res.end(req.method === 'HEAD' ? undefined : text);
  };
  const cookie = (value, maxAge) => `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

  async function login(req, res) {
    const ip = req.socket.remoteAddress ?? 'unknown';
    const gate = limiter.check(ip);
    if (gate.locked) {
      logger.warn?.(`live-dc login refused from ${ip}: locked for ${gate.retryAfterSeconds}s`);
      return send(req, res, 429, { error: 'Too many failed attempts. Try again later.' }, { 'retry-after': String(gate.retryAfterSeconds) });
    }
    let fields;
    try {
      const raw = await readBody(req, MAX_LOGIN_BODY);
      fields = /application\/x-www-form-urlencoded/i.test(req.headers['content-type'] ?? '')
        ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw || '{}');
    } catch (error) {
      return send(req, res, error?.status === 413 ? 413 : 400, { error: error?.status === 413 ? 'Request too large.' : 'Malformed request.' });
    }
    if (!verifyPassword(fields?.password, passwordHash)) {
      limiter.fail(ip);
      logger.warn?.(`live-dc login failed from ${ip}`);
      return send(req, res, 401, { error: 'Wrong password.' });
    }
    limiter.succeed(ip);
    logger.log?.(`live-dc login ok from ${ip}`);
    return send(req, res, 200, { ok: true, next: safeNext(fields.next) }, { 'set-cookie': cookie(signer.issue(), Math.floor(sessionTtlMs / 1000)) });
  }

  function serveStatic(req, res, pathname) {
    if (!webRoot) return send(req, res, 503, '<!doctype html><title>Not built</title><p>The frontend is not installed on this host.</p>');
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return send(req, res, 400, { error: 'Bad path.' }); }
    if (decoded.includes('\0') || decoded.includes('\\')) return send(req, res, 400, { error: 'Bad path.' });
    let file = resolve(webRoot, `.${decoded}`);
    if (file !== webRoot && !file.startsWith(webRoot + sep)) return send(req, res, 400, { error: 'Bad path.' });
    try {
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
      const real = realpathSync(file);
      if (!real.startsWith(webRoot + sep) || !statSync(real).isFile()) throw new Error('outside');
      const { size } = statSync(real);
      res.writeHead(200, {
        ...BASE_HEADERS, 'content-type': TYPES[extname(real).toLowerCase()] ?? 'application/octet-stream', 'content-length': size,
        'cache-control': decoded.startsWith('/assets/') ? 'private, max-age=31536000, immutable' : 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      createReadStream(real).on('error', () => res.destroy()).pipe(res);
    } catch {
      send(req, res, 404, { error: 'Not found.' });
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;
    const method = req.method ?? 'GET';
    const read = method === 'GET' || method === 'HEAD';

    if (pathname === '/healthz' && read) {
      const health = status.healthz?.() ?? {};
      return send(req, res, 200, { ok: Boolean(health.ok ?? true), lastCycleAt: health.lastCycleAt ?? null });
    }
    if (pathname === '/login' && read) {
      const nonce = randomBytes(16).toString('base64');
      return send(req, res, 200, loginPage(nonce), {
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'`,
      });
    }
    if (pathname === '/api/login') return method === 'POST' ? login(req, res) : send(req, res, 405, { error: 'Use POST.' });
    if (pathname === '/api/logout' && method === 'POST') return send(req, res, 200, { ok: true }, { 'set-cookie': cookie('', 0) });

    if (!signer.verify(parseCookies(req.headers.cookie)[SESSION_COOKIE])) {
      if (!pathname.startsWith('/api/') && read) {
        return send(req, res, 302, { error: 'Sign in first.' }, { location: `/login?next=${encodeURIComponent(pathname + url.search)}` });
      }
      return send(req, res, 401, { error: 'Sign in first.' });
    }

    if (pathname.startsWith('/api/')) {
      if (pathname === ASK) {
        return send(req, res, 503, { error: 'Free-form questions are not available in this demo deployment. Ask about assets, events or a drawn area.' });
      }
      if (SIGN_IN.test(pathname)) return send(req, res, 404, { error: 'Not found.' });
      if (!read && !(method === 'POST' && CURATED_READ.test(pathname))) return send(req, res, 405, { error: 'This deployment is read-only.' });
      for (const handler of apiHandlers) {
        if (await handler.handle(req, res)) return;
      }
      return send(req, res, 404, { error: 'Not found.' });
    }
    if (!read) return send(req, res, 405, { error: 'This deployment is read-only.' });
    if (pathname === STATUS_FILE) return send(req, res, 200, status.cloud?.() ?? {});
    return serveStatic(req, res, pathname);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(error => {
      logger.error?.(`live-dc http: ${req.method} ${req.url?.split('?')[0]} failed: ${error?.message ?? error}`);
      if (!res.headersSent) send(req, res, 500, { error: 'Internal error.' }); else res.destroy();
    });
  });
  return { server, handle };
}
