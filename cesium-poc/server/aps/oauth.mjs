/**
 * Autodesk Platform Services OAuth v2: three-legged Authorization Code with PKCE (S256).
 *
 * The client secret is used only server-side, in the Basic auth header of the token request. The
 * page never sees the secret, the access token or the refresh token. Upstream error text is
 * scrubbed of every credential and capped before it is shown anywhere.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const APS_HOST = 'developer.api.autodesk.com';
export const AUTHORIZE_URL = `https://${APS_HOST}/authentication/v2/authorize`;
export const TOKEN_URL = `https://${APS_HOST}/authentication/v2/token`;
export const CALLBACK_PATH = '/api/aps/callback';
/** data:read for the project lookup, viewables:read for the browser's viewer token (refreshed down to it). */
export const DEFAULT_SCOPE = 'data:read viewables:read';
export const DEFAULT_PROJECT_NAME = 'Seagirt Electrical Digital Twin POC';
export const DEFAULT_FILE_NAMES = ['seagirt_power_network.ifc', 'seagirt_power_network_display.ifc'];

/** One error type for every APS failure, carrying the code and status the API answers with. */
export class ApsError extends Error {
  constructor(code, status, message, hint) {
    super(message);
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

const trimmed = value => String(value ?? '').trim();

export function loadApsConfig(env = process.env) {
  const clientId = trimmed(env.APS_CLIENT_ID);
  const clientSecret = trimmed(env.APS_CLIENT_SECRET);
  const callbackUrl = trimmed(env.APS_CALLBACK_URL);
  const missing = [['APS_CLIENT_ID', clientId], ['APS_CLIENT_SECRET', clientSecret], ['APS_CALLBACK_URL', callbackUrl]]
    .filter(([, value]) => !value).map(([name]) => name);
  const problems = [];
  let callback = null;
  if (callbackUrl) {
    try { callback = new URL(callbackUrl); } catch { problems.push('APS_CALLBACK_URL is not a valid URL.'); }
    if (callback && callback.pathname !== CALLBACK_PATH) {
      problems.push(`APS_CALLBACK_URL must end in ${CALLBACK_PATH}, the route this server handles.`);
    }
  }
  const fileNames = trimmed(env.APS_TARGET_FILES).split(',').map(trimmed).filter(Boolean);
  return {
    clientId, clientSecret, callbackUrl, callback,
    scope: trimmed(env.APS_SCOPE) || DEFAULT_SCOPE,
    projectName: trimmed(env.APS_TARGET_PROJECT_NAME) || DEFAULT_PROJECT_NAME,
    fileNames: fileNames.length ? fileNames : DEFAULT_FILE_NAMES,
    missing, problems,
    configured: missing.length === 0 && problems.length === 0,
  };
}

export function createPkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export const newState = () => randomBytes(32).toString('base64url');

/** Constant-time string equality, so a state comparison does not leak how much of it matched. */
export function sameSecret(a, b) {
  const left = Buffer.from(String(a ?? '')), right = Buffer.from(String(b ?? ''));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export function authorizeUrl(config, { state, challenge }) {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: config.clientId, redirect_uri: config.callbackUrl,
    scope: config.scope, state, code_challenge: challenge, code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

/** Upstream text reduced to something safe to show: no credential, no markup, at most 200 characters. */
export function scrub(text, secrets = []) {
  let value = String(text ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  for (const secret of secrets) if (secret && secret.length >= 6) value = value.split(secret).join('[redacted]');
  return value.slice(0, 200);
}

async function readJson(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
}

/**
 * The token endpoint's error, as one of the API's codes. `grant` says which request it was:
 * an expired refresh token and a reused authorization code both arrive as `invalid_grant`.
 */
export function classifyTokenError(status, body, { grant, secrets = [] } = {}) {
  const code = String(body?.error ?? body?.errorCode ?? '').toLowerCase();
  const detail = scrub(body?.error_description ?? body?.developerMessage ?? body?.raw ?? '', secrets);
  if (code === 'invalid_client' || (status === 401 && grant !== 'refresh_token')) {
    return new ApsError('INVALID_CREDENTIALS', 502, `Autodesk rejected the client credentials${detail ? `: ${detail}` : '.'}`,
      'Check APS_CLIENT_ID and APS_CLIENT_SECRET against the app in the APS developer portal, then restart the server.');
  }
  if (/redirect/i.test(detail) || code === 'redirect_uri_mismatch') {
    return new ApsError('CALLBACK_MISMATCH', 400, `The callback URL does not match the app registration${detail ? `: ${detail}` : '.'}`,
      'APS_CALLBACK_URL must equal the Callback URL registered for the app exactly (scheme, host, port and path).');
  }
  if (code === 'invalid_scope') {
    return new ApsError('MISSING_SCOPE', 403, `The requested scope was refused${detail ? `: ${detail}` : '.'}`,
      'Request data:read (APS_SCOPE) and make sure the app has the Data Management API enabled.');
  }
  if (code === 'unauthorized_client') {
    return new ApsError('APP_NOT_AUTHORIZED', 502, `The app is not allowed this grant type${detail ? `: ${detail}` : '.'}`,
      'The APS app must be a Traditional Web App to use the authorization code grant with a client secret.');
  }
  if (status === 403 || /api product/i.test(detail)) {
    return new ApsError('APP_NO_API_ACCESS', 502, `Autodesk refused this app${detail ? `: ${detail}` : '.'}`,
      'In the APS developer portal, check that APS_CLIENT_ID is this app\'s id and that the Data Management and Model Derivative APIs are enabled for it. A running dev server keeps the values it started with: restart it after editing .env.local.');
  }
  if (code === 'invalid_grant' && grant === 'refresh_token') {
    return new ApsError('TOKEN_EXPIRED', 401, 'The Autodesk session has expired or was revoked.', 'Sign in again at /api/aps/login.');
  }
  if (code === 'invalid_grant') {
    return new ApsError('AUTH_CODE_INVALID', 400, `The authorization code was refused${detail ? `: ${detail}` : '.'}`,
      'Codes are single-use and short-lived. Start again at /api/aps/login.');
  }
  return new ApsError('TOKEN_REQUEST_FAILED', 502, `The Autodesk token endpoint answered ${status}${detail ? `: ${detail}` : '.'}`);
}

export async function tokenRequest(config, params, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  let response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ApsError('APS_UNREACHABLE', 502, `Could not reach Autodesk: ${scrub(error?.message)}`);
  }
  const body = await readJson(response);
  if (!response.ok) {
    throw classifyTokenError(response.status, body,
      { grant: params.grant_type, secrets: [config.clientSecret, params.refresh_token, params.code] });
  }
  return body;
}

/** The token response, kept in the session. The scope is the granted one when Autodesk reports it. */
export function tokenRecord(body, { now = Date.now(), requestedScope, previousRefreshToken } = {}) {
  if (!body?.access_token) throw new ApsError('TOKEN_REQUEST_FAILED', 502, 'Autodesk returned no access token.');
  return {
    accessToken: body.access_token,
    // Autodesk rotates the refresh token on every refresh. Keep the old one only if no new one came.
    refreshToken: body.refresh_token ?? previousRefreshToken ?? null,
    expiresAt: now + Number(body.expires_in ?? 3600) * 1000,
    scope: String(body.scope ?? requestedScope ?? '').trim(),
    obtainedAt: now,
  };
}

export function exchangeCode(config, { code, verifier }, options) {
  return tokenRequest(config, {
    grant_type: 'authorization_code', code, redirect_uri: config.callbackUrl, code_verifier: verifier,
  }, options);
}

/** `options.scope` narrows the new access token (it must be within the original grant). */
export function refreshTokens(config, refreshToken, { scope = config.scope, ...options } = {}) {
  return tokenRequest(config, { grant_type: 'refresh_token', refresh_token: refreshToken, scope }, options);
}

/**
 * The connection test: a two-legged token request proves the id and secret are accepted without
 * needing a signed-in user. The token itself is discarded. `unauthorized_client` still means the
 * credentials were accepted: the app is just not enabled for that grant.
 */
export async function checkCredentials(config, options) {
  if (!config.configured) {
    return { credentials: 'not_configured', detail: [...config.missing.map(name => `${name} is not set.`), ...config.problems].join(' ') };
  }
  try {
    await tokenRequest(config, { grant_type: 'client_credentials', scope: 'data:read' }, options);
    return { credentials: 'valid', detail: 'Autodesk accepted the client id and secret.' };
  } catch (error) {
    if (error.code === 'APP_NOT_AUTHORIZED') return { credentials: 'valid', detail: 'Autodesk accepted the client id and secret (two-legged access is not enabled, which is fine).' };
    return { credentials: error.code === 'INVALID_CREDENTIALS' ? 'invalid' : 'error', code: error.code, detail: error.message, hint: error.hint };
  }
}
