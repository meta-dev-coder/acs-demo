/**
 * The interactive DataConnect sign-in, shared by `npm run dc:login` and the in-app button.
 *
 * Authorization code + PKCE is what this public SPA client is actually permitted to do (the
 * password grant is refused, and `offline_access` — and therefore a refresh token — is refused too).
 * The browser only ever visits the authority: the code is exchanged HERE, and the resulting token
 * is written to disk and used by the proxy, so no DataConnect token reaches the app's own page.
 *
 * The authority redirects to a URI registered against the client, which is on a different port from
 * the dev server, so this opens a short-lived listener on that port for the duration of one sign-in.
 *
 * Nothing here logs a token, a code or a verifier.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const base64url = buffer => buffer.toString('base64url');

/** How long a started sign-in waits for the person to finish before giving the port back. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

const page = message => `<!doctype html><meta charset="utf-8"><title>DataConnect sign-in</title>
<body style="font:16px/1.5 system-ui;padding:3rem;max-width:34rem">
<p>${message}</p><p style="color:#666">You can close this tab.</p>
<script>setTimeout(() => window.close(), 1500)</script>`;

/** Defaults, so a config assembled without the interactive fields still constructs. */
const DEFAULT_REDIRECT_URI = 'http://localhost:3000/signin-callback';
const DEFAULT_AUTHORIZE_URL = 'https://ims.bentley.com/connect/authorize';

export function createSignInFlow({ config, fetchImpl = fetch, logger = console }) {
  const redirect = new URL(config.redirectUri || DEFAULT_REDIRECT_URI);
  const authorizeUrl = new URL(config.authorizeUrl || DEFAULT_AUTHORIZE_URL);

  /** @type {{verifier: string, state: string, server: import('node:http').Server, timer: NodeJS.Timeout} | null} */
  let active = null;
  let lastResult = null;   // {ok: boolean, at: number, message: string}

  function finish(result) {
    lastResult = { ...result, at: Date.now() };
    if (!active) return;
    clearTimeout(active.timer);
    active.server.close();
    active = null;
  }

  function buildUrl(scope, { state, challenge }) {
    const url = new URL(authorizeUrl);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: String(redirect),
      scope,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return url;
  }

  /**
   * Ask the authority whether it will accept a scope before sending anyone to a login page.
   * A refusal arrives as a redirect carrying `error=`, not as an HTTP error status.
   */
  async function scopeAccepted(scope, pkce) {
    try {
      const response = await fetchImpl(buildUrl(scope, pkce), { redirect: 'manual' });
      return !/[?&#]error=/.test(response.headers.get('location') ?? '');
    } catch {
      return true;   // Cannot pre-flight: let the real flow report whatever happens.
    }
  }

  /** Exchange the code for tokens and persist whatever the authority was willing to issue. */
  async function exchange(code, verifier) {
    const response = await fetchImpl(config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        code,
        redirect_uri: String(redirect),
        code_verifier: verifier,
        ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
      }),
    });
    if (!response.ok) {
      // Only the standard OAuth error code; the body can echo the request back.
      const error = await response.json().then(p => p?.error, () => null);
      throw new Error(`Token exchange failed (${response.status}${error ? `: ${error}` : ''})`);
    }
    const payload = await response.json();
    const lifetime = Number(payload.expires_in) || 3600;
    if (payload.refresh_token) {
      writeFileSync(config.tokenStore, `${payload.refresh_token}\n`, { encoding: 'utf8', mode: 0o600 });
      logger.info?.('[DataConnect] signed in', { saved: 'refresh token', renewable: true });
      return { renewable: true, lifetime };
    }
    if (payload.access_token) {
      writeFileSync(config.accessStore, `${payload.access_token}\n`, { encoding: 'utf8', mode: 0o600 });
      logger.info?.('[DataConnect] signed in', { saved: 'access token', expiresInSeconds: lifetime });
      return { renewable: false, lifetime };
    }
    throw new Error('The authority returned no usable token.');
  }

  return {
    /** Whether a sign-in is waiting for the person right now. */
    get pending() { return Boolean(active); },
    get lastResult() { return lastResult; },

    /**
     * Begin a sign-in: open the callback listener and return the URL the person must visit.
     * @returns {Promise<{url: string, scope: string, renewable: boolean}>}
     */
    async start() {
      if (active) return { url: active.url, scope: active.scope, renewable: active.renewable };

      const verifier = base64url(randomBytes(32));
      const pkce = { state: base64url(randomBytes(16)), challenge: base64url(createHash('sha256').update(verifier).digest()) };

      // Prefer a refresh token; fall back when the client may not ask for offline access.
      const withRefresh = `${config.scope} offline_access`;
      const renewable = await scopeAccepted(withRefresh, pkce);
      const scope = renewable ? withRefresh : config.scope;
      const url = String(buildUrl(scope, pkce));

      const server = createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost:${redirect.port || 80}`);
        if (url.pathname !== redirect.pathname) { res.writeHead(404).end(); return; }
        const reply = (status, message) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(page(message)); };
        try {
          if (url.searchParams.get('error')) throw new Error(`Sign-in failed: ${url.searchParams.get('error')}`);
          if (url.searchParams.get('state') !== pkce.state) throw new Error('The reply did not belong to this sign-in.');
          const result = await exchange(url.searchParams.get('code'), verifier);
          reply(200, result.renewable
            ? 'Signed in. The app can renew its own access from now on.'
            : `Signed in for about ${Math.round(result.lifetime / 60)} minutes.`);
          finish({ ok: true, message: 'Signed in.', renewable: result.renewable });
        } catch (error) {
          reply(400, error.message);
          logger.warn?.('[DataConnect] sign-in failed', { message: error.message });
          finish({ ok: false, message: error.message });
        }
      });

      await new Promise((resolve, reject) => {
        server.once('error', error => reject(error.code === 'EADDRINUSE'
          ? new Error(`Port ${redirect.port} is in use, and the sign-in must come back to it. Stop whatever is on that port (the root app's dev server uses it) and try again.`)
          : error));
        server.listen(Number(redirect.port) || 80, resolve);
      });

      const timer = setTimeout(() => finish({ ok: false, message: 'The sign-in was not completed in time.' }), SIGN_IN_TIMEOUT_MS);
      timer.unref?.();
      active = { verifier, state: pkce.state, server, timer, url, scope, renewable };
      return { url, scope, renewable };
    },

    /** Give the port back without waiting for the timeout. */
    cancel() { finish({ ok: false, message: 'Sign-in cancelled.' }); },
  };
}
