/**
 * DataConnect, reached same-origin.
 *
 * The browser never sees a DataConnect token. Credentials are read here, on the server, from
 * environment variables that are NOT prefixed `VITE_` — a `VITE_` variable is compiled into the
 * public bundle, so a password in one would ship to every visitor. This module exchanges those
 * credentials for an access token, caches it until it expires, attaches it to each DataConnect
 * call and returns only the data.
 *
 * Nothing here ever logs a token, a refresh token, a password or an Authorization header: the
 * diagnostics print class, page, counts and status codes only.
 *
 * Endpoints served (same shape the app's client expects):
 *   GET  /api/dataconnect/status                      -> {configured, baseUrl, authenticated}
 *   GET  /api/dataconnect/classes                     -> {classes:[{id, name, ...}]}
 *   POST /api/dataconnect/class/:classId/curated-data -> DataConnect's own response, verbatim
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createSignInFlow } from './dcSignIn.mjs';

const BASE = '/api/dataconnect';
/** Bentley IMS by default; overridable for a different authority. */
const DEFAULT_TOKEN_URL = 'https://ims.bentley.com/connect/token';

/**
 * Which OAuth grant to use.
 *
 * `client_credentials` is the right shape for a server: an application identity, no user password
 * anywhere. `password` (ROPC) is the fallback for instances that still allow it — note that Bentley
 * IMS refuses it for SPA/native clients with `unauthorized_client`, whatever the credentials are.
 * Chosen automatically from what is configured, and overridable with DC_GRANT.
 */
export function grantType(env, { clientSecret, username }) {
  const asked = (env.DC_GRANT || '').trim();
  if (asked === 'client_credentials' || asked === 'password') return asked;
  return clientSecret && !username ? 'client_credentials' : 'password';
}

export function loadDataConnectConfig(env = process.env) {
  const baseUrl = (env.DC_BASE_URL || '').replace(/\/+$/, '');
  const clientSecret = env.DC_CLIENT_SECRET || '';
  const username = env.DC_USERNAME || '';
  return {
    baseUrl,
    grant: grantType(env, { clientSecret, username }),
    // Where the class list lives, and how curated data is requested. Both overridable so a moved
    // path never needs a code change.
    classesPath: env.DC_CLASSES_PATH || '/api/v1/class',
    curatedDataPath: env.DC_CURATED_DATA_PATH || '/api/v1/class/{classId}/curated-data',
    tokenUrl: env.DC_TOKEN_URL || DEFAULT_TOKEN_URL,
    clientId: env.DC_CLIENT_ID || '',
    clientSecret,
    scope: env.DC_SCOPE || 'itwin-platform',
    username,
    password: env.DC_PASSWORD || '',
    /**
     * A pre-acquired access token, which cannot be renewed. Either pasted into DC_ACCESS_TOKEN or
     * left by `npm run dc:login` when the authority refuses to issue a refresh token — this client
     * is not permitted `offline_access`, so that is the usual case here.
     */
    staticToken: env.DC_ACCESS_TOKEN || readStoredToken(env.DC_ACCESS_STORE || '.dc-access-token'),
    accessStore: env.DC_ACCESS_STORE || '.dc-access-token',
    /** Where the authority sends the browser back. Must be registered against the client. */
    redirectUri: env.DC_REDIRECT_URI || 'http://localhost:3000/signin-callback',
    authorizeUrl: env.DC_AUTHORIZE_URL || (env.DC_TOKEN_URL || DEFAULT_TOKEN_URL).replace(/\/token$/, '/authorize'),
    /**
     * A refresh token renews the access token indefinitely with no password and no client secret,
     * which is what a public SPA client can actually do. Obtained once from an interactive sign-in
     * (see `npm run dc:login`), then rotated and re-saved here on every use.
     */
    refreshToken: env.DC_REFRESH_TOKEN || '',
    /** Where the rotated refresh token is written. Git-ignored; holds one line. */
    tokenStore: env.DC_TOKEN_STORE || '.dc-refresh-token',
    // The largest classes (ITS inspections: ~1,000 records of 55+ attributes) regularly need more
    // than 20s to answer, which surfaced as a 504 rather than as data.
    timeoutMs: Number(env.DC_TIMEOUT_MS) || 60_000,
    pageSize: Number(env.DC_PAGE_SIZE) || 500,
  };
}

/**
 * When a pasted token expires, read from the JWT's own `exp` claim.
 *
 * Only `exp` is decoded — a timestamp, not a secret — so an expired paste is reported as expiry
 * rather than as a mysterious 401. A token that is not a readable JWT simply has no known expiry.
 *
 * @returns {{expiresAt: Date, expired: boolean, minutesLeft: number} | null}
 */
export function tokenExpiry(token, now = Date.now()) {
  const payload = String(token ?? '').split('.')[1];
  if (!payload) return null;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Number.isFinite(exp)) return null;
    const remaining = exp * 1000 - now;
    return { expiresAt: new Date(exp * 1000), expired: remaining <= 0, minutesLeft: Math.round(remaining / 60_000) };
  } catch { return null; }
}

/** A token a previous run saved to disk, if any. Used for both stores below. */
export function readStoredToken(path) {
  if (!path || !existsSync(path)) return '';
  try { return readFileSync(path, 'utf8').trim(); } catch { return ''; }
}

/** @deprecated kept for callers that name the refresh store specifically. */
export const readStoredRefreshToken = readStoredToken;

/** What is missing before this can talk to DataConnect at all. */
export function missingConfig(config) {
  const missing = [];
  if (!config.baseUrl) missing.push('DC_BASE_URL');
  const hasRenewableCredential = config.refreshToken || readStoredToken(config.tokenStore);
  // A refresh token still needs the client it was issued to.
  if (hasRenewableCredential && !config.clientId) missing.push('DC_CLIENT_ID');
  if (!config.staticToken && !hasRenewableCredential) {
    if (!config.clientId) missing.push('DC_CLIENT_ID');
    if (config.grant === 'client_credentials') {
      if (!config.clientSecret) missing.push('DC_CLIENT_SECRET');
    } else {
      if (!config.username) missing.push('DC_USERNAME');
      if (!config.password) missing.push('DC_PASSWORD');
    }
  }
  return missing;
}

export function createDataConnectApi({ config = loadDataConnectConfig(), fetchImpl = fetch, now = Date.now, logger = console } = {}) {
  /** @type {{token: string, expiresAt: number} | null} */
  let cached = null;
  let pending = null;

  const log = detail => logger.info?.('[DataConnect]', detail);

  const signIn = createSignInFlow({ config, fetchImpl, logger });
  const refreshTokenPresent = () => Boolean(refreshToken);

  /**
   * The current refresh token: whatever was configured, or the rotated one saved by a previous run.
   * The saved file wins, because the configured value is retired the first time it is used.
   */
  let refreshToken = readStoredToken(config.tokenStore) || config.refreshToken;

  /** Persist the rotated token so a restart does not need another interactive sign-in. */
  function persistRefreshToken(value) {
    if (!config.tokenStore) return;
    try {
      writeFileSync(config.tokenStore, `${value}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      // Not fatal: this run keeps working from memory, the next one needs a fresh sign-in.
      logger.warn?.('[DataConnect] could not save the rotated refresh token', { message: error?.message });
    }
  }

  /**
   * The non-renewable access token, if there is one.
   *
   * Read from disk on EVERY use, not once at startup: `npm run dc:login` rewrites that file roughly
   * hourly, and re-reading means a renewal takes effect immediately instead of needing the dev
   * server restarted. The file wins over DC_ACCESS_TOKEN because it is always the newer of the two.
   */
  const pastedToken = () => readStoredToken(config.accessStore) || config.staticToken;

  /**
   * A token for DataConnect. Obtained once and reused until it expires; a 401 from DataConnect
   * clears it so the next call fetches a fresh one. The token is never returned to the browser.
   *
   * A refresh token, when configured, is preferred over everything else: it renews itself without a
   * password or a client secret, which a pasted DC_ACCESS_TOKEN cannot do.
   */
  async function token() {
    if (cached && cached.expiresAt - 30_000 > now()) return cached.token;
    // A pasted token is the last resort: nothing can renew it, so it is used only when there is no
    // credential to mint one from.
    if (!refreshToken) {
      const pasted = pastedToken();
      if (pasted) {
        // Its own `exp` says it is finished — report that plainly instead of sending it and
        // relaying a bare 401 that looks like a configuration problem.
        const expiry = tokenExpiry(pasted, now());
        if (expiry?.expired) {
          throw Object.assign(new Error('The access token has expired. Run `npm run dc:login` to renew it.'),
            { status: 401, code: 'token_expired' });
        }
        return pasted;
      }
    }
    pending ??= (async () => {
      const usingRefresh = Boolean(refreshToken);
      const body = new URLSearchParams({
        grant_type: usingRefresh ? 'refresh_token' : config.grant,
        client_id: config.clientId,
        scope: config.scope,
      });
      if (usingRefresh) body.set('refresh_token', refreshToken);
      else if (config.grant === 'password') {
        body.set('username', config.username);
        body.set('password', config.password);
      }
      if (config.clientSecret) body.set('client_secret', config.clientSecret);
      const response = await fetchImpl(config.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (!response.ok) {
        // The body can echo the credentials back, so only the standard OAuth error CODE is read out
        // of it — never the body itself, and never the request that produced it.
        const code = await response.json().then(payload => payload?.error, () => null);
        const safeCode = typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : null;
        throw Object.assign(
          new Error(`Sign-in failed (${response.status}${safeCode ? `: ${safeCode}` : ''})`),
          { status: response.status === 400 ? 401 : response.status, oauthError: safeCode },
        );
      }
      const payload = await response.json();
      const accessToken = payload?.access_token;
      if (!accessToken) throw Object.assign(new Error('Sign-in returned no access token'), { status: 502 });
      cached = { token: accessToken, expiresAt: now() + (Number(payload.expires_in) || 3600) * 1000 };
      // IMS rotates: each refresh returns a NEW refresh token and retires the one just used. Losing
      // it means going back to a manual paste, so it is kept and persisted before anything else can
      // fail. Only the refresh token is written — never the access token, never the password.
      if (payload.refresh_token && payload.refresh_token !== refreshToken) {
        refreshToken = payload.refresh_token;
        persistRefreshToken(refreshToken);
      }
      log({ signedIn: true, via: usingRefresh ? 'refresh_token' : config.grant,
        expiresInSeconds: Number(payload.expires_in) || 3600, rotated: Boolean(payload.refresh_token) });
      return accessToken;
    })().finally(() => { pending = null; });
    return pending;
  }

  /** One authenticated call, retried once with a fresh token if DataConnect rejects this one. */
  async function call(path, { method = 'GET', body } = {}, retry = true) {
    const url = `${config.baseUrl}${path}`;
    const response = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${await token()}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    // With a renewable credential a 401 means "this access token is stale": drop it and mint another.
    if (response.status === 401 && retry && (refreshToken || !pastedToken())) {
      cached = null;
      return call(path, { method, body }, false);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw Object.assign(new Error(`DataConnect returned ${response.status}`), {
        status: response.status,
        // The first line only, and never the request that produced it.
        detail: text.slice(0, 300),
      });
    }
    return response.json();
  }

  /** Every class the signed-in user can see — how class ids are discovered rather than guessed. */
  async function classes() {
    const payload = await call(config.classesPath);
    const list = Array.isArray(payload) ? payload : payload?.data ?? payload?.classes ?? [];
    log({ classes: list.length });
    return list;
  }

  /**
   * One page of a class's curated data, exactly as DataConnect returns it.
   * @param {string} classId
   * @param {{page?: number, pageSize?: number, filters?: unknown[]}} [options]
   */
  async function curatedData(classId, { page = 0, pageSize = config.pageSize, filters = [] } = {}) {
    const path = `${config.curatedDataPath.replace('{classId}', encodeURIComponent(classId))}?includeDescendants=false`;
    const payload = await call(path, { method: 'POST', body: { page, pageSize, filters } });
    log({ classId, page, pageSize, received: (payload?.data ?? []).length, totalCount: payload?.totalCount });
    return payload;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith(BASE)) return false;
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(payload));
    };
    const missing = missingConfig(config);
    const route = url.pathname.slice(BASE.length);

    if (route === '/status') {
      // `authenticated` is what the app needs to decide whether to offer a sign-in button. It is a
      // boolean about this server's own credential — never the credential itself.
      const pasted = readStoredToken(config.accessStore) || config.staticToken;
      const expiry = pasted ? tokenExpiry(pasted) : null;
      send(200, {
        configured: missing.length === 0,
        missing,
        baseUrl: config.baseUrl || null,
        authenticated: Boolean(refreshTokenPresent() || (pasted && !expiry?.expired)),
        expiresInMinutes: expiry && !expiry.expired ? expiry.minutesLeft : null,
        signInPending: signIn.pending,
        lastSignIn: signIn.lastResult,
      });
      return true;
    }
    if (route === '/signin/cancel' && req.method === 'POST') {
      // Give the callback port back immediately rather than holding it until the timeout.
      signIn.cancel();
      send(200, { cancelled: true });
      return true;
    }
    if (route === '/signin/start' && req.method === 'POST') {
      try {
        send(200, await signIn.start());
      } catch (error) {
        send(409, { error: error.message });
      }
      return true;
    }
    if (missing.length) {
      send(503, { error: 'DataConnect is not configured on the server.', missing });
      return true;
    }
    try {
      if (route === '/classes' && req.method === 'GET') { send(200, { classes: await classes() }); return true; }
      const match = /^\/class\/([^/]+)\/curated-data$/.exec(route);
      if (match && req.method === 'POST') {
        const body = await readJson(req);
        send(200, await curatedData(decodeURIComponent(match[1]), body ?? {}));
        return true;
      }
      send(404, { error: 'Unknown DataConnect route.' });
    } catch (error) {
      const status = Number(error?.status) || (error?.name === 'TimeoutError' ? 504 : 502);
      // Status and message only — never the token, the credentials or the request headers.
      logger.warn?.('[DataConnect] request failed', { route, status, message: error?.message });
      send(status, { error: error?.message ?? 'DataConnect request failed', status, code: error?.code });
    }
    return true;
  }

  return {
    config, missing: () => missingConfig(config), classes, curatedData, handle, signIn,
    // Connect-style: anything this API does not own is passed straight on, or the dev server stalls.
    middleware: (req, res, next) => { handle(req, res).then(handled => { if (!handled) next(); }, next); },
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 1e6) reject(new Error('Body too large')); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : null); } catch { resolve(null); } });
    req.on('error', reject);
  });
}
