/**
 * TEMPORARY DataConnect token intake (see server/liveDc/README.md, "Cloud writer token hand-off").
 * Accepts POST with `Authorization: Bearer <access token>`, checks it has at least 5 minutes left, that
 * DataConnect grants it dcm-admin and (optionally) that its sub/email is allow-listed, then stores it
 * SSE-KMS under secrets/dc-token.txt for the poller. No AWS SDK import here, so it is unit-testable.
 * The token never reaches a response or a log line.
 */
import { DC_ADMIN_PERMISSION, DC_TOKEN_OBJECT_KEY, bearerToken, hasPermission, jwtClaims, tokenExpiresAtMs } from '../../../server/liveDc/tokenHandoff.mjs';

export const MIN_TOKEN_LIFETIME_MS = 5 * 60_000;
const MAX_TOKEN_LENGTH = 16_384;
const DEFAULT_PERMISSION_URL = 'https://dataconnect-demo-dqa3.cohesivecloud.app/api/user-mgmt/permission';

const list = value => String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);

export function loadIntakeConfig(env = process.env) {
  return {
    bucket: env.DC_TOKEN_BUCKET || '',
    kmsKeyId: env.DC_TOKEN_KMS_KEY_ARN || '',
    permissionUrl: env.DC_PERMISSION_URL || DEFAULT_PERMISSION_URL,
    allowedSubjects: list(env.DC_TOKEN_ALLOWED_SUBJECTS).map(s => s.toLowerCase()),
    allowedOrigins: list(env.DC_TOKEN_ALLOWED_ORIGINS),
    timeoutMs: Number(env.DC_PERMISSION_TIMEOUT_MS) > 0 ? Number(env.DC_PERMISSION_TIMEOUT_MS) : 10_000,
  };
}

export function createIntakeHandler({ config = loadIntakeConfig(), putObject, fetchImpl = fetch, now = Date.now, logger = console }) {
  const cors = origin => (origin && config.allowedOrigins.includes(origin)
    ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type', vary: 'origin' }
    : {});
  const respond = (statusCode, body, origin) => ({
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(origin) },
    body: JSON.stringify(body),
  });

  return async function handler(event = {}) {
    const headers = event.headers ?? {};
    const origin = headers.origin ?? headers.Origin;
    const method = event.requestContext?.http?.method ?? event.httpMethod ?? 'GET';
    const reject = (statusCode, error) => {
      logger.warn?.(`dc-token-intake: rejected (${error})`);
      return respond(statusCode, { ok: false, error }, origin);
    };

    if (method === 'OPTIONS') return { statusCode: 204, headers: cors(origin), body: '' };
    if (method !== 'POST') return respond(405, { ok: false, error: 'method_not_allowed' }, origin);
    if (!config.bucket || !config.kmsKeyId) return reject(503, 'not_configured');

    const token = bearerToken(headers);
    if (!token || token.length > MAX_TOKEN_LENGTH) return reject(401, 'missing_token');
    const claims = jwtClaims(token);
    const expiresAt = tokenExpiresAtMs(token);
    if (!claims || expiresAt == null) return reject(401, 'invalid_token');
    if (expiresAt - now() < MIN_TOKEN_LIFETIME_MS) return reject(401, 'token_expiring');
    if (config.allowedSubjects.length) {
      const subjects = [claims.sub, claims.email].filter(Boolean).map(s => String(s).toLowerCase());
      if (!subjects.some(s => config.allowedSubjects.includes(s))) return reject(403, 'subject_not_allowed');
    }

    let permissions;
    try {
      const response = await fetchImpl(config.permissionUrl, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (response.status === 401 || response.status === 403) return reject(401, 'token_rejected');
      if (!response.ok) return reject(502, `permission_check_http_${response.status}`);
      permissions = await response.json().catch(() => null);
    } catch (error) {
      logger.error?.(`dc-token-intake: permission check failed (${error?.name ?? 'Error'})`);
      return respond(502, { ok: false, error: 'permission_check_failed' }, origin);
    }
    if (!hasPermission(permissions, DC_ADMIN_PERMISSION)) return reject(403, 'not_admin');

    const expiresIso = new Date(expiresAt).toISOString();
    try {
      await putObject({
        Bucket: config.bucket,
        Key: DC_TOKEN_OBJECT_KEY,
        Body: token,
        ContentType: 'text/plain',
        CacheControl: 'no-store',
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: config.kmsKeyId,
        Metadata: { 'expires-at': expiresIso },
      });
    } catch (error) {
      logger.error?.(`dc-token-intake: store failed (${error?.name ?? 'Error'})`);
      return respond(500, { ok: false, error: 'store_failed' }, origin);
    }
    logger.log?.(`dc-token-intake: stored token expiring ${expiresIso}`);
    return respond(200, { ok: true, expiresAt: expiresIso }, origin);
  };
}
