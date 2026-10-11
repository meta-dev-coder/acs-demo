/**
 * Ask the Twin for local development: the same orchestrator and tools the EC2 service will run,
 * configured from `.env.local` and mounted by Vite at /api/i595/ask.
 *
 * Model, first match wins:
 *   ASK_TWIN_REPLAY=<file>      replay recorded responses — offline, free, deterministic
 *   ANTHROPIC_API_KEY=<key>     the real model (ASK_TWIN_MODEL, default as on EC2); add
 *                               ASK_TWIN_RECORD=<file> to save every response for later replay
 * Neither set → /api/i595/ask answers 503 saying what to set; the built-in answers still work.
 *
 * Data: the SQLite twin store at ASK_TWIN_STORE (default .twin-store/twin.sqlite), built from the
 * committed snapshot on first use when missing. Nothing here writes to DataConnect.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ASK_MODEL } from '../liveDc/askTwin.mjs';
import { fetchEventWeather } from '../liveDc/eventWeather.mjs';
import { createAskHttpHandler } from './httpAdapter.mjs';
import { createAnthropicProvider, createRecordingProvider, createReplayProvider } from './modelProvider.mjs';
import { createOrchestrator } from './orchestrator.mjs';
import { createTools } from './tools.mjs';
import { buildStoreFromSnapshot, openTwinStore } from './twinStore.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_STORE_PATH = join(ROOT, '.twin-store', 'twin.sqlite');
const SNAPSHOT_DIR = join(ROOT, 'public', 'dataconnect-data');
const LAYER_DIR = join(ROOT, 'public', 'data');

/** The model provider the environment asks for, or null with the reason. */
export function providerFromEnv(env) {
  const replay = String(env.ASK_TWIN_REPLAY ?? '').trim();
  if (replay) return { provider: createReplayProvider({ path: replay }), label: `replay (${replay})` };
  const apiKey = String(env.ANTHROPIC_API_KEY ?? '').trim();
  if (!apiKey) return { provider: null, label: 'off: set ANTHROPIC_API_KEY or ASK_TWIN_REPLAY in .env.local' };
  const model = String(env.ASK_TWIN_MODEL ?? '').trim() || DEFAULT_ASK_MODEL;
  const live = createAnthropicProvider({ apiKey, model });
  const record = String(env.ASK_TWIN_RECORD ?? '').trim();
  return record ? { provider: createRecordingProvider(live, { path: record }), label: `${model}, recording to ${record}` } : { provider: live, label: model };
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
      res.end(JSON.stringify({ error: 'Ask the Twin is not configured locally: set ANTHROPIC_API_KEY (or ASK_TWIN_REPLAY) in cesium-poc/.env.local.' }));
    };
    return { label, handle, middleware: (req, res, next) => (new URL(req.originalUrl ?? req.url, 'http://localhost').pathname === '/api/i595/ask' ? handle(req, res) : next()) };
  }

  const storePath = String(env.ASK_TWIN_STORE ?? '').trim() || DEFAULT_STORE_PATH;
  if (!existsSync(storePath)) {
    const { classes } = buildStoreFromSnapshot({ snapshotDir: SNAPSHOT_DIR, outPath: storePath });
    logger.log?.(`ask-the-twin: built the twin store from the snapshot (${classes.reduce((n, c) => n + c.rowCount, 0)} records) at ${storePath}`);
  }
  const tools = createTools({
    store: openTwinStore(storePath),
    getLiveEvents,
    readLayer: file => { const path = join(LAYER_DIR, file); return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; },
    fetchWeather: point => fetchEventWeather(point),
  });
  const orchestrator = createOrchestrator({ provider, tools, logger });
  logger.log?.(`ask-the-twin (local): ${label}, store ${storePath}`);
  return { label, ...createAskHttpHandler({ orchestrator }) };
}
