/**
 * Ask the Twin for local development: the same orchestrator and tools the EC2 service will run,
 * configured from `.env.local` and mounted by Vite at /api/i595/ask.
 *
 * Model, first match wins:
 *   ASK_TWIN_REPLAY=<file>      replay recorded responses — offline, free, deterministic
 *   ANTHROPIC_API_KEY=<key>     the real model (ASK_TWIN_MODEL, default as on EC2)
 *   ASK_TWIN_ANTHROPIC_SECRET_NAME=<name>  the same, with the key read from AWS Secrets Manager
 *                               (aws CLI + your AWS credentials), as the EC2 host does
 *   with either, ASK_TWIN_RECORD=<file> saves every response for later replay
 * Neither set → /api/i595/ask answers 503 saying what to set; the built-in answers still work.
 *
 * Data: the SQLite twin store at ASK_TWIN_STORE (default .twin-store/twin.sqlite), built from the
 * committed snapshot on first use when missing, then refreshed from DataConnect (SDNA live classes and
 * historical classes) when the dev server has DataConnect credentials; ASK_TWIN_REFRESH=off keeps
 * the snapshot. Nothing here writes to DataConnect.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiKeyFromSecret, DEFAULT_ASK_MODEL } from '../liveDc/askTwin.mjs';
import { readSecretString } from '../liveDc/awsSecret.mjs';
import { fetchEventWeather } from '../liveDc/eventWeather.mjs';
import { createAnthropicProvider, createRecordingProvider, createReplayProvider } from './modelProvider.mjs';
import { createAskService, spendFromEnv, withFallbackFromEnv } from './askService.mjs';
import { configuredClients, refreshFromEnv } from './storeRefresh.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_STORE_PATH = join(ROOT, '.twin-store', 'twin.sqlite');
const SNAPSHOT_DIR = join(ROOT, 'public', 'dataconnect-data');
const LAYER_DIR = join(ROOT, 'public', 'data');

/**
 * The model provider the environment asks for, or null with the reason.
 * @param {object} env
 * @param {{readSecret?: (name: string, options: object) => Promise<string>}} [deps]  injected in tests
 */
export function providerFromEnv(env, { readSecret = readSecretString } = {}) {
  const replay = String(env.ASK_TWIN_REPLAY ?? '').trim();
  if (replay) return { provider: createReplayProvider({ path: replay }), label: `replay (${replay})` };
  const apiKey = String(env.ANTHROPIC_API_KEY ?? '').trim();
  const secretName = String(env.ASK_TWIN_ANTHROPIC_SECRET_NAME ?? '').trim();
  if (!apiKey && !secretName) return { provider: null, label: 'off: set ANTHROPIC_API_KEY, ASK_TWIN_ANTHROPIC_SECRET_NAME or ASK_TWIN_REPLAY in .env.local' };
  const model = String(env.ASK_TWIN_MODEL ?? '').trim() || DEFAULT_ASK_MODEL;
  // low | medium | high | xhigh | max; empty uses the model's own default.
  const effort = String(env.ASK_TWIN_EFFORT ?? 'low').trim() || null;
  // The same secret the EC2 host reads (JSON {"api_key"}), through the AWS CLI and your own AWS
  // credentials, on the first question — never at startup, never logged.
  const region = String(env.LIVE_DC_AWS_REGION ?? '').trim() || undefined;
  const getApiKey = async () => apiKeyFromSecret(await readSecret(secretName, { region, policyHint: 'your AWS credentials need secretsmanager:GetSecretValue on it' }), secretName);
  const make = m => (apiKey ? createAnthropicProvider({ apiKey, model: m, effort }) : createAnthropicProvider({ model: m, effort, getApiKey }));
  const live = withFallbackFromEnv(env, make(model), make);
  const record = String(env.ASK_TWIN_RECORD ?? '').trim();
  const fallback = String(env.ASK_TWIN_FALLBACK_MODEL ?? '').trim();
  const via = `${effort ? `, effort ${effort}` : ''}${fallback && fallback !== model ? `, fallback ${fallback}` : ''}${apiKey ? '' : ` (key from secret ${secretName})`}`;
  return record ? { provider: createRecordingProvider(live, { path: record }), label: `${model}${via}, recording to ${record}` } : { provider: live, label: `${model}${via}` };
}

/**
 * @param {{env?: object, getLiveEvents?: () => Promise<object|null>, logger?: Console, liveDc?: object|null,
 *   historical?: object|null, clientKey?: Function, limiter?: object}} [options]  liveDc/historical: the
 *   DataConnect read clients. LIVE_DC_DATA_DIR points the layers and the snapshot at a release bundle's
 *   data/ (EC2) instead of the repository's public/.
 * @returns {{middleware: Function, handle: Function, label: string}}
 */
export function createLocalAsk({ env = process.env, getLiveEvents = null, logger = console, liveDc = null, historical = null, clientKey = null, limiter = null } = {}) {
  const { provider, label } = providerFromEnv(env);
  if (!provider) {
    const handle = (req, res) => {
      req.resume();
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'Ask the Twin is not configured locally: set ANTHROPIC_API_KEY, ASK_TWIN_ANTHROPIC_SECRET_NAME or ASK_TWIN_REPLAY in cesium-poc/.env.local.' }));
    };
    return { label, handle, middleware: (req, res, next) => (new URL(req.originalUrl ?? req.url, 'http://localhost').pathname === '/api/i595/ask' ? handle(req, res) : next()) };
  }

  const storePath = String(env.ASK_TWIN_STORE ?? '').trim() || DEFAULT_STORE_PATH;
  const dataDir = String(env.LIVE_DC_DATA_DIR ?? '').trim();
  const layerDir = dataDir || LAYER_DIR;
  const clients = configuredClients({ liveDc, historical });
  const service = createAskService({
    provider, storePath, snapshotDir: dataDir ? join(dataDir, 'dataconnect-data') : SNAPSHOT_DIR, getLiveEvents, logger,
    ...(clientKey ? { clientKey } : {}), ...(limiter ? { limiter } : {}),
    readLayer: file => { const path = join(layerDir, file); return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; },
    fetchWeather: point => fetchEventWeather(point),
    ...clients, refresh: refreshFromEnv(env), spend: spendFromEnv(env, storePath, logger),
  });
  const refreshing = service.refresher ? `, refreshing from DataConnect (${[clients.liveDc && 'live', clients.historical && 'historical'].filter(Boolean).join(' + ')})` : ', snapshot only';
  logger.log?.(`ask-the-twin (local): ${label}, store ${storePath}${refreshing}`);
  return { label, ...service };
}
