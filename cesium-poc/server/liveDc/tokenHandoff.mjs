/**
 * TEMPORARY DataConnect token hand-off, until Bentley provides refresh tokens or a service client: the
 * machine running `npm run dc:login` pushes its access token to the AWS intake lambda, which stores it
 * (SSE-KMS) for the poller lambda. Pure helpers shared by the pusher, the intake and the poller. Only
 * claims are decoded (never verified here: DataConnect itself decides whether a token is valid).
 */
export const DC_TOKEN_OBJECT_KEY = 'secrets/dc-token.txt';
export const LIVE_DC_STATUS_KEY = 'status/live-dc-status.json';
export const DC_ADMIN_PERMISSION = 'dcm-admin';

export function jwtClaims(token) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : null;
  } catch { return null; }
}

export function tokenExpiresAtMs(token) {
  const exp = jwtClaims(token)?.exp;
  return Number.isFinite(exp) ? exp * 1000 : null;
}

export function bearerToken(headers = {}) {
  const value = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'authorization')?.[1];
  const match = /^Bearer\s+(\S+)\s*$/i.exec(String(value ?? '').trim());
  return match ? match[1] : '';
}

/** The permission response's shape is not documented, so any string value anywhere in it may name the permission. */
export function hasPermission(body, name, depth = 0) {
  if (depth > 6 || body == null) return false;
  if (typeof body === 'string') return body.toLowerCase() === name.toLowerCase();
  if (typeof body !== 'object') return false;
  return Object.values(body).some(value => hasPermission(value, name, depth + 1));
}
