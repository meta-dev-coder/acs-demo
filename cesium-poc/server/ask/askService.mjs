/**
 * Ask the Twin as one service, the same on every host: the twin store (built from the snapshot when
 * missing), the read and insight tools, the orchestrator with its prefetch rules and cached system
 * prompt, and the HTTP adapter. Local dev (localAsk.mjs) and the EC2 demo host (demoServer.mjs) differ
 * only in where the key, the store file and the live events come from.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import CENTERLINE from '../../config/corridorCenterline.json' with { type: 'json' };
import { createAskHttpHandler } from './httpAdapter.mjs';
import { createFallbackProvider } from './modelProvider.mjs';
import { createSpendGuard } from './spendGuard.mjs';
import { createInsights } from './insights.mjs';
import { createOrchestrator } from './orchestrator.mjs';
import { planPrefetch } from './prefetch.mjs';
import { systemPrompt } from './prompt.mjs';
import { createTools } from './tools.mjs';
import { createReloadingStore, createStoreRefresher } from './storeRefresh.mjs';
import { buildStoreFromSnapshot } from './twinStore.mjs';

/**
 * @param {{provider: object, storePath: string, snapshotDir: string, readLayer: (file: string) => object|null,
 *   getLiveEvents?: () => Promise<object|null>, fetchWeather?: Function, fetchImpl?: typeof fetch,
 *   clientKey?: (req: object) => string, limiter?: object, logger?: Console,
 *   liveDc?: object|null, historical?: object|null, refresh?: {liveEveryMs?: number, historicalEveryMs?: number}|false}} options
 *   `spend`: a daily token budget (spendGuard.mjs).
 *   `liveDc`/`historical` are the DataConnect read clients; with either, the store is refreshed from
 *   DataConnect in the background (live every few minutes, historical daily). `refresh: false` turns that off.
 * @returns {{handle: Function, middleware: Function, store: object, refresher: object|null}}
 */
export function createAskService({ provider, storePath, snapshotDir, readLayer, getLiveEvents = null, fetchWeather = null,
  fetchImpl = globalThis.fetch, clientKey, limiter, logger = console, liveDc = null, historical = null, refresh = {}, spend = null }) {
  if (!existsSync(storePath)) {
    const { classes } = buildStoreFromSnapshot({ snapshotDir, outPath: storePath });
    logger.log?.(`ask-the-twin: built the twin store from the snapshot (${classes.reduce((n, c) => n + c.rowCount, 0)} records) at ${storePath}`);
  }
  // The snapshot gives a first answer at once; the refresher then replaces it with DataConnect rows.
  const store = createReloadingStore(storePath);
  const refresher = refresh !== false && (liveDc || historical)
    ? createStoreRefresher({ store, storePath, liveDc, historical, snapshotDir, logger, ...refresh }) : null;
  refresher?.start();
  const tools = createTools({
    store, getLiveEvents, readLayer, fetchWeather,
    insights: createInsights({ store, getLiveEvents, readLayer, centerline: CENTERLINE, fetchImpl }),
  });
  // The store's classes go into the cached system prompt, so the model does not spend a round asking.
  // One cached prompt per demo persona, rebuilt after a refresh reopens the store (row counts and
  // sources change; the prompt cache misses once per refresh, not per question).
  let prompts = new Map(), promptVersion = store.version;
  const system = envelope => {
    if (promptVersion !== store.version) { prompts = new Map(); promptVersion = store.version; }
    const persona = envelope.screen?.persona ?? null;
    if (!prompts.has(persona)) prompts.set(persona, systemPrompt({ classes: store.classes(), persona }));
    return prompts.get(persona);
  };
  const orchestrator = createOrchestrator({ provider, tools, logger, prefetch: planPrefetch, system, ...(spend ? { spend } : {}) });
  return { store, refresher, spend, orchestrator, ...createAskHttpHandler({ orchestrator, ...(clientKey ? { clientKey } : {}), ...(limiter ? { limiter } : {}) }) };
}

/**
 * ASK_TWIN_FALLBACK_MODEL: the provider with a second model for overloads (same key, same settings).
 * @param {object} env
 * @param {object} primary  the provider for ASK_TWIN_MODEL
 * @param {(model: string) => object} makeProvider  builds a provider for another model
 */
export function withFallbackFromEnv(env, primary, makeProvider, logger = console) {
  const model = String(env.ASK_TWIN_FALLBACK_MODEL ?? '').trim();
  return model && model !== primary.model ? createFallbackProvider(primary, makeProvider(model), { logger }) : primary;
}

/**
 * ASK_TWIN_DAILY_TOKENS: the daily budget, kept beside the store (ask-spend.json) so a restart does
 * not reset it. Always returns a guard, so usage is counted even with no limit set.
 */
export function spendFromEnv(env, storePath, logger = console) {
  const dailyTokens = Number(env.ASK_TWIN_DAILY_TOKENS) > 0 ? Number(env.ASK_TWIN_DAILY_TOKENS) : 0;
  return createSpendGuard({ dailyTokens, statePath: join(dirname(storePath), 'ask-spend.json'), logger });
}
