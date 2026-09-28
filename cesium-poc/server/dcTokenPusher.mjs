/**
 * TEMPORARY DataConnect token hand-off (until Bentley provides refresh tokens or a service client).
 * Pushes the access token `npm run dc:login` keeps in .dc-access-token to the AWS intake lambda at
 * DC_TOKEN_HANDOFF_URL whenever the file changes and at least every 50 minutes, so the cloud poller
 * can write FL511 -> DataConnect. Server-side only; a no-op when DC_TOKEN_HANDOFF_URL is unset.
 * The token never reaches a log line.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tokenExpiresAtMs } from './liveDc/tokenHandoff.mjs';

export const HANDOFF_MAX_AGE_MS = 50 * 60_000;
const CHECK_MS = 60_000;
const RETRY_MS = 5 * 60_000;
const MIN_LIFETIME_MS = 5 * 60_000;

export function loadTokenHandoffConfig(env = process.env) {
  return {
    url: env.DC_TOKEN_HANDOFF_URL || '',
    file: env.DC_TOKEN_HANDOFF_FILE || env.DC_ACCESS_STORE || '.dc-access-token',
  };
}

const fingerprint = token => createHash('sha256').update(token).digest('hex');

export function createDcTokenPusher({
  config = loadTokenHandoffConfig(), fetchImpl = fetch, readFile = path => readFileSync(path, 'utf8'), now = Date.now,
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, logger = console,
} = {}) {
  const enabled = Boolean(config.url);
  let timer = null;
  let inFlight = null;
  let pushed = null; // { print, at } of the last accepted token
  let failed = null; // { print, at } of the last refused or failed push

  async function check() {
    if (!enabled) return 'disabled';
    let token = '';
    try { token = String(readFile(config.file) ?? '').trim(); } catch { /* reported as no_token */ }
    if (!token) return 'no_token';
    const expiresAt = tokenExpiresAtMs(token);
    if (expiresAt != null && expiresAt - now() < MIN_LIFETIME_MS) return 'expiring';

    const print = fingerprint(token);
    if (pushed?.print === print && now() - pushed.at < HANDOFF_MAX_AGE_MS) return 'unchanged';
    if (failed?.print === print && now() - failed.at < RETRY_MS) return 'unchanged';

    try {
      const response = await fetchImpl(config.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(20_000),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        failed = { print, at: now() };
        logger.warn?.(`dc-token handoff: refused (HTTP ${response.status}${body?.error ? ` ${body.error}` : ''})`);
        return 'rejected';
      }
      pushed = { print, at: now() };
      failed = null;
      logger.log?.(`dc-token handoff: pushed${body?.expiresAt ? ` (expires ${body.expiresAt})` : ''}`);
      return 'pushed';
    } catch (error) {
      failed = { print, at: now() };
      logger.warn?.(`dc-token handoff: failed (${error?.name ?? 'Error'})`);
      return 'failed';
    }
  }

  const tick = () => {
    inFlight ??= check().finally(() => { inFlight = null; });
    return inFlight;
  };

  return {
    enabled,
    tick,
    /** Resolves once any in-flight check has finished (for tests and shutdown). */
    idle: () => inFlight ?? Promise.resolve(),
    start() {
      if (!enabled || timer) return;
      void tick();
      timer = setIntervalImpl(() => { void tick(); }, CHECK_MS);
      timer?.unref?.();
    },
    stop() {
      if (timer) clearIntervalImpl(timer);
      timer = null;
    },
  };
}
