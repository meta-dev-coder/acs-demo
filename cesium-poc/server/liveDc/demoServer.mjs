/**
 * The EC2 demo host inside the live-dc sync process: config from env (LIVE_DC_HTTP_PORT unset = no host),
 * the sync status shared with /healthz and /status/live-dc-status.json, and the listener.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';
import { createReadApiHandlers } from '../readApiHandlers.mjs';
import { parseCookies, parsePasswordHash } from './demoAuth.mjs';
import { createDemoHost, SESSION_COOKIE } from './demoHost.mjs';
import { apiKeyFromSecret, createAskHandler, createAskLimiter, DEFAULT_ASK_MODEL } from './askTwin.mjs';
import { createAskProxy } from '../ask/askProxy.mjs';
import { createAskService } from '../ask/askService.mjs';
import { configuredClients, refreshFromEnv } from '../ask/storeRefresh.mjs';
import { createAnthropicProvider } from '../ask/modelProvider.mjs';
import { sqliteAvailable } from '../ask/twinStore.mjs';
import { readSecretString } from './awsSecret.mjs';
import { createAskTools } from './askTools.mjs';
import { dictionarySummary, loadDataDictionary } from './dataDictionary.mjs';
import { enrichmentDataPath } from './eventEnrichment.mjs';
import { fetchEventWeather } from './eventWeather.mjs';

/** The committed snapshot, for runs outside the bundle (the bundle ships it under data/dataconnect-data). */
const DEFAULT_SNAPSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'dataconnect-data');

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

/**
 * Free-form Ask the Twin when ASK_TWIN_ANTHROPIC_SECRET_NAME is set (instance role: GetSecretValue on it);
 * unset keeps /api/i595/ask answering 503. The key is read on the first question, not at startup.
 *
 * On a Node with node:sqlite (22.5+) this is the orchestrator in server/ask/ — the same service
 * `npm run dev` runs: the twin store (built at startup from the bundled snapshot into the state
 * directory, then refreshed from DataConnect), insight tools, cited answers and the event stream. On an older Node the earlier
 * handler (askTwin.mjs) answers instead, and the log says which one is running.
 */
export function createDemoAsk({
  env = process.env, liveEvents, liveDc, historical, logger = console, spawnImpl, fetchImpl, dictionary, readLayer = defaultReadLayer(env),
  fetchWeather = point => fetchEventWeather(point),
} = {}) {
  // Phase 2: the ask service runs as its own unit (live-dc-ask.service); this process only forwards,
  // after its own session check, so the writer never shares memory or CPU with a model turn.
  const serviceUrl = String(env.ASK_TWIN_SERVICE_URL ?? '').trim();
  if (serviceUrl) {
    const proxy = createAskProxy({ target: serviceUrl, logger, clientKey: req => parseCookies(req.headers?.cookie)[SESSION_COOKIE] || req.socket?.remoteAddress || 'unknown' });
    logger.log?.(`live-dc ask-the-twin: forwarded to ${proxy.target} (live-dc-ask.service)`);
    return proxy;
  }
  const name = String(env.ASK_TWIN_ANTHROPIC_SECRET_NAME ?? '').trim();
  if (!name) return null;
  const region = String(env.LIVE_DC_AWS_REGION ?? '').trim() || undefined;
  const model = String(env.ASK_TWIN_MODEL ?? '').trim() || DEFAULT_ASK_MODEL;
  const getApiKey = async () => apiKeyFromSecret(await readSecretString(name, {
    region, ...(spawnImpl ? { spawnImpl } : {}), policyHint: 'allow secretsmanager:GetSecretValue on it (deploy/ec2/iam-policy.json)',
  }), name);
  const getLiveEvents = () => liveEvents?.dataConnectEvents?.() ?? Promise.resolve(null);

  if (sqliteAvailable() && String(env.ASK_TWIN_ENGINE ?? '').trim() !== 'legacy') {
    const effort = String(env.ASK_TWIN_EFFORT ?? 'low').trim() || null;
    const dataDir = String(env.LIVE_DC_DATA_DIR ?? '').trim();
    const service = createAskService({
      provider: createAnthropicProvider({ model, effort, getApiKey, ...(fetchImpl ? { fetchImpl } : {}) }),
      // The state directory is the only place the service may write (deploy/ec2/live-dc.service).
      storePath: String(env.ASK_TWIN_STORE ?? '').trim() || join(String(env.HOME ?? '').trim() || '/var/lib/live-dc', 'twin.sqlite'),
      snapshotDir: dataDir ? join(dataDir, 'dataconnect-data') : DEFAULT_SNAPSHOT_DIR,
      readLayer, getLiveEvents, fetchWeather, logger, ...(fetchImpl ? { fetchImpl } : {}),
      // The store is refreshed from DataConnect (SDNA live classes every few minutes, historical
      // daily) through the same read clients the map uses; read-only, never a second writer.
      ...configuredClients({ liveDc, historical }), refresh: refreshFromEnv(env),
      // Behind the password gate every caller has a session; limit per session, not per proxy address.
      clientKey: req => parseCookies(req.headers?.cookie)[SESSION_COOKIE] || req.socket?.remoteAddress || 'unknown',
      limiter: createAskLimiter({ limit: 120 }),
    });
    logger.log?.(`live-dc ask-the-twin: orchestrator (${model}${effort ? `, effort ${effort}` : ''})`);
    return service;
  }

  logger.log?.(`live-dc ask-the-twin: legacy handler (${sqliteAvailable() ? 'ASK_TWIN_ENGINE=legacy' : `Node ${process.versions.node} has no node:sqlite; 22.5+ runs the orchestrator`})`);
  const dict = dictionary ?? loadDataDictionary({ dataDir: env.LIVE_DC_DATA_DIR });
  return createAskHandler({
    tools: createAskTools({ dictionary: dict, liveEvents, liveDc, historical, readLayer, fetchWeather }),
    dataSummary: dictionarySummary(dict),
    getApiKey,
    getLiveEvents,
    model,
    logger, ...(fetchImpl ? { fetchImpl } : {}),
  });
}

function defaultReadLayer(env) {
  return file => {
    const path = enrichmentDataPath(file, env);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  };
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
  const { handlers, liveEvents, liveDc, historical, stop } = createReadApiHandlers({ config: loadConfig(env), env, logger, dataDir, service, network, dataConnect: true });
  const ask = createDemoAsk({ env, liveEvents, liveDc, historical, logger });
  logger.log?.(`live-dc ask-the-twin: ${ask ? (ask.target ? `on, forwarded to ${ask.target}` : `on (${String(env.ASK_TWIN_ANTHROPIC_SECRET_NAME).trim()})`) : 'off (ASK_TWIN_ANTHROPIC_SECRET_NAME and ASK_TWIN_SERVICE_URL unset)'}`);
  const { server } = createDemoHost({ passwordHash: httpConfig.passwordHash, webDir: httpConfig.webDir, apiHandlers: handlers, ask, status, logger });
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
