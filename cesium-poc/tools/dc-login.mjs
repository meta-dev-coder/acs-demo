#!/usr/bin/env node
/**
 * Sign in once, so the server can renew its own access tokens from then on.
 *
 * Usage:  npm run dc:login
 *
 * Why this exists: a token pasted from Swagger expires in an hour and nothing can renew it, and the
 * password grant is refused for this SPA client (`unauthorized_client`). An authorization-code +
 * PKCE sign-in is what a public client IS allowed to do, and it returns a REFRESH token — which the
 * server then exchanges for fresh access tokens indefinitely, with no password and no client secret.
 *
 * This runs the standard browser flow against the redirect URI the client already registers for
 * development, then writes only the refresh token to DC_TOKEN_STORE (.dc-refresh-token, git-ignored,
 * mode 0600). No token is ever printed.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { loadDataConnectConfig } from '../server/dataConnect.mjs';
import { loadServerEnv } from '../server/loadEnv.mjs';

loadServerEnv();
const config = loadDataConnectConfig();

const REDIRECT_URI = process.env.DC_REDIRECT_URI || 'http://localhost:3000/signin-callback';
const AUTHORIZE_URL = process.env.DC_AUTHORIZE_URL || config.tokenUrl.replace(/\/token$/, '/authorize');
// `offline_access` is what makes the authority return a refresh token. Not every client is allowed
// to ask for it — this one is not — and asking anyway fails the whole sign-in with `invalid_scope`
// before a login page is ever shown. So the scope is negotiated below rather than assumed.
const WANTED_SCOPE = process.env.DC_LOGIN_SCOPE || `${config.scope} offline_access`;
let SCOPE = WANTED_SCOPE;

if (!config.clientId) {
  console.error('DC_CLIENT_ID is required in cesium-poc/.env.local.');
  process.exit(1);
}

const base64url = buffer => buffer.toString('base64url');
const verifier = base64url(randomBytes(32));
const challenge = base64url(createHash('sha256').update(verifier).digest());
const state = base64url(randomBytes(16));

const redirect = new URL(REDIRECT_URI);

const authorizeUrl = scope => {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return url;
};

/**
 * Ask the authority whether it will accept this scope, before sending anyone to a login page.
 * A refusal comes back as a redirect carrying `error=invalid_scope`, not as an HTTP error.
 */
async function scopeAccepted(scope) {
  try {
    const response = await fetch(authorizeUrl(scope), { redirect: 'manual' });
    const location = response.headers.get('location') ?? '';
    return !/[?&#]error=/.test(location);
  } catch {
    return true;   // Cannot pre-flight (offline, proxy): carry on and let the real flow report.
  }
}

if (SCOPE !== config.scope && !(await scopeAccepted(SCOPE))) {
  SCOPE = config.scope;
  console.log('This client may not request "offline_access", so no refresh token can be issued.');
  console.log(`Signing in with "${SCOPE}" instead — the access token will last about an hour,`);
  console.log('and `npm run dc:login` renews it in one step (no Swagger copy-paste).\n');
}

const authorize = authorizeUrl(SCOPE);

/** Wait for the authority to send the browser back with a code. */
function awaitCallback() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${redirect.port || 80}`);
      if (url.pathname !== redirect.pathname) { res.writeHead(404).end(); return; }
      const done = (status, message) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>DataConnect sign-in</title>
          <body style="font:16px system-ui;padding:3rem"><p>${message}</p>
          <p style="color:#666">You can close this tab and return to the terminal.</p>`);
        server.close();
      };
      if (url.searchParams.get('error')) {
        done(400, `Sign-in failed: ${url.searchParams.get('error')}`);
        reject(new Error(url.searchParams.get('error')));
        return;
      }
      if (url.searchParams.get('state') !== state) {
        done(400, 'Sign-in failed: the reply did not match this request.');
        reject(new Error('state mismatch — the reply did not belong to this sign-in'));
        return;
      }
      done(200, 'Signed in. The server can now renew its own tokens.');
      resolve(url.searchParams.get('code'));
    });
    server.on('error', error => reject(error.code === 'EADDRINUSE'
      ? new Error(`Port ${redirect.port} is already in use — stop whatever is on it (the root app's dev server uses it) and run this again.`)
      : error));
    server.listen(Number(redirect.port) || 80, () => {
      console.log(`Waiting for the sign-in to come back to ${REDIRECT_URI} …\n`);
    });
  });
}

// `--print-url` stops here: useful for checking the request, or for signing in on another machine.
if (process.argv.includes('--print-url')) {
  console.log(`${authorize}\n`);
  console.log(`Callback expected at ${REDIRECT_URI} (must be registered on this client).`);
  console.log(`Refresh token would be saved to ${config.tokenStore}.`);
  process.exit(0);
}

console.log('Opening your browser to sign in to Bentley IMS.');
console.log('If it does not open, paste this into a browser:\n');
console.log(`  ${authorize}\n`);
spawn(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open',
  [authorize.toString()], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();

let code;
try {
  code = await awaitCallback();
} catch (error) {
  console.error(`\n${error.message}`);
  process.exit(1);
}

const response = await fetch(config.tokenUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
  }),
});

if (!response.ok) {
  // Only the standard OAuth error code is surfaced; the body can echo the request back.
  const error = await response.json().then(p => p?.error, () => null);
  console.error(`\nToken exchange failed (${response.status}${error ? `: ${error}` : ''}).`);
  if (error === 'invalid_grant') console.error('The code was already used or expired — just run this again.');
  if (error === 'unauthorized_client') console.error('This client may not use the authorization-code grant.');
  process.exit(1);
}

const payload = await response.json();
const lifetime = Number(payload.expires_in) || 3600;

if (payload.refresh_token) {
  writeFileSync(config.tokenStore, `${payload.refresh_token}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(`\nSaved a refresh token to ${config.tokenStore} (not printed, mode 0600).`);
  console.log('The server renews its own access tokens from now on — this is the last sign-in.');
} else if (payload.access_token) {
  // No refresh token is possible for this client. The access token is still worth keeping: the
  // server reads this file, so the app works for its lifetime and one command renews it.
  writeFileSync(config.accessStore, `${payload.access_token}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(`\nSaved an access token to ${config.accessStore} (not printed, mode 0600).`);
  console.log(`It lasts about ${Math.round(lifetime / 60)} minutes. Run \`npm run dc:login\` again to renew.`);
  console.log('A refresh token would remove that chore, but needs "offline_access" on this client.');
} else {
  console.error('\nSigned in, but the authority returned no usable token.');
  process.exit(1);
}

console.log('\nRestart the dev server to pick it up. You can delete DC_ACCESS_TOKEN,');
console.log('DC_USERNAME and DC_PASSWORD from .env.local.');
