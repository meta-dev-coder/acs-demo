/**
 * The EC2 demo host inside the live-dc sync process: config from env (LIVE_DC_HTTP_PORT unset = no host),
 * the sync status shared with /healthz and /status/live-dc-status.json, and the listener.
 */
import { loadConfig } from '../config.mjs';
import { createReadApiHandlers } from '../readApiHandlers.mjs';
import { parsePasswordHash } from './demoAuth.mjs';
import { createDemoHost } from './demoHost.mjs';

export function loadDemoHttpConfig(env = process.env) {
  const rawPort = String(env.LIVE_DC_HTTP_PORT ?? '').trim();
  if (!rawPort) return null;
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port > 65535) throw new Error('LIVE_DC_HTTP_PORT must be a port number (0-65535)');
  const passwordHash = String(env.LIVE_DEMO_PASSWORD_HASH ?? '').trim();
  if (!passwordHash) throw new Error('LIVE_DC_HTTP_PORT is set but LIVE_DEMO_PASSWORD_HASH is not: generate one with --hash-password');
  parsePasswordHash(passwordHash);
  return { host: String(env.LIVE_DC_HTTP_HOST ?? '').trim() || '0.0.0.0', port, passwordHash, webDir: env.LIVE_DC_WEB_DIR || null };
}

export function createSyncStatus({ intervalSeconds, now = Date.now }) {
  let state = { lastRunAt: null, dcWrite: 'skipped', reason: null, fl511: null };
  return {
    recordCycle(report) {
      const errors = report?.errors ?? [];
      state = {
        lastRunAt: report?.at ?? new Date(now()).toISOString(), dcWrite: errors.length ? 'error' : 'ok',
        reason: errors.length ? String(errors[0]?.message ?? errors[0]).slice(0, 200) : null, fl511: report?.sourceStatus ?? null,
      };
    },
    recordFailure(error) {
      state = { ...state, lastRunAt: new Date(now()).toISOString(), dcWrite: 'error', reason: String(error?.message ?? error).slice(0, 200) };
    },
    healthz() {
      const last = Date.parse(state.lastRunAt ?? '');
      const ok = !Number.isFinite(last) || now() - last <= (3 * intervalSeconds + 120) * 1000;
      return { ok, lastCycleAt: state.lastRunAt };
    },
    cloud: () => ({ ...state, intervalSeconds, host: 'ec2' }),
  };
}

export async function startDemoHttp({ env = process.env, httpConfig, service, network, dataDir, status, logger = console }) {
  const { handlers, stop } = createReadApiHandlers({ config: loadConfig(env), env, logger, dataDir, service, network, dataConnect: true });
  const { server } = createDemoHost({ passwordHash: httpConfig.passwordHash, webDir: httpConfig.webDir, apiHandlers: handlers, status, logger });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(httpConfig.port, httpConfig.host, () => { server.off('error', reject); resolve(); });
  });
  const { port } = server.address();
  return {
    server,
    url: `http://${httpConfig.host}:${port}`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(() => resolve()));
      await stop();
    },
  };
}
