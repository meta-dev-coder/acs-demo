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
 * committed snapshot on first use when missing. Nothing here writes to DataConnect.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiKeyFromSecret, DEFAULT_ASK_MODEL } from '../liveDc/askTwin.mjs';
import { readSecretString } from '../liveDc/awsSecret.mjs';
import { fetchEventWeather } from '../liveDc/eventWeather.mjs';
import { createAskHttpHandler } from './httpAdapter.mjs';
import { createAnthropicProvider, createRecordingProvider, createReplayProvider } from './modelProvider.mjs';
import { createOrchestrator } from './orchestrator.mjs';
import { systemPrompt } from './prompt.mjs';
import { createTools } from './tools.mjs';
import { createInsights } from './insights.mjs';
import { planPrefetch } from './prefetch.mjs';
import CENTERLINE from '../../config/corridorCenterline.json' with { type: 'json' };
import { buildStoreFromSnapshot, openTwinStore } from './twinStore.mjs';

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
  const live = apiKey ? createAnthropicProvider({ apiKey, model, effort })
    : createAnthropicProvider({ model, effort, getApiKey: async () => apiKeyFromSecret(await readSecret(secretName, { region, policyHint: 'your AWS credentials need secretsmanager:GetSecretValue on it' }), secretName) });
  const record = String(env.ASK_TWIN_RECORD ?? '').trim();
  const via = `${effort ? `, effort ${effort}` : ''}${apiKey ? '' : ` (key from secret ${secretName})`}`;
  return record ? { provider: createRecordingProvider(live, { path: record }), label: `${model}${via}, recording to ${record}` } : { provider: live, label: `${model}${via}` };
}

/**
 * @param {{env?: object, getLiveEvents?: () => Promise<object|null>, logger?: Console}} [options]
 * @returns {{middleware: Function, handle: Function, label: string}}
 */
export function createLocalAsk({ env = process.env, getLiveEvents = null, logger = console } = {}) {
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
  if (!existsSync(storePath)) {
    const { classes } = buildStoreFromSnapshot({ snapshotDir: SNAPSHOT_DIR, outPath: storePath });
    logger.log?.(`ask-the-twin: built the twin store from the snapshot (${classes.reduce((n, c) => n + c.rowCount, 0)} records) at ${storePath}`);
  }
  const store = openTwinStore(storePath);
  const readLayer = file => { const path = join(LAYER_DIR, file); return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; };
  const tools = createTools({
    store,
    getLiveEvents,
    readLayer,
    fetchWeather: point => fetchEventWeather(point),
    insights: createInsights({ store, getLiveEvents, readLayer, centerline: CENTERLINE }),
  });
  // The store's classes go into the cached system prompt, so the model does not spend a round asking.
  const orchestrator = createOrchestrator({ provider, tools, logger, prefetch: planPrefetch, system: systemPrompt({ classes: store.classes() }) });
  logger.log?.(`ask-the-twin (local): ${label}, store ${storePath}`);
  return { label, ...createAskHttpHandler({ orchestrator }) };
}
