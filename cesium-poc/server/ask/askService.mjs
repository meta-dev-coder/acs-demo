/**
 * Ask the Twin as one service, the same on every host: the twin store (built from the snapshot when
 * missing), the read and insight tools, the orchestrator with its prefetch rules and cached system
 * prompt, and the HTTP adapter. Local dev (localAsk.mjs) and the EC2 demo host (demoServer.mjs) differ
 * only in where the key, the store file and the live events come from.
 */
import { existsSync } from 'node:fs';
import CENTERLINE from '../../config/corridorCenterline.json' with { type: 'json' };
import { createAskHttpHandler } from './httpAdapter.mjs';
import { createInsights } from './insights.mjs';
import { createOrchestrator } from './orchestrator.mjs';
import { planPrefetch } from './prefetch.mjs';
import { systemPrompt } from './prompt.mjs';
import { createTools } from './tools.mjs';
import { buildStoreFromSnapshot, openTwinStore } from './twinStore.mjs';

/**
 * @param {{provider: object, storePath: string, snapshotDir: string, readLayer: (file: string) => object|null,
 *   getLiveEvents?: () => Promise<object|null>, fetchWeather?: Function, fetchImpl?: typeof fetch,
 *   clientKey?: (req: object) => string, limiter?: object, logger?: Console}} options
 * @returns {{handle: Function, middleware: Function, store: object}}
 */
export function createAskService({ provider, storePath, snapshotDir, readLayer, getLiveEvents = null, fetchWeather = null,
  fetchImpl = globalThis.fetch, clientKey, limiter, logger = console }) {
  if (!existsSync(storePath)) {
    const { classes } = buildStoreFromSnapshot({ snapshotDir, outPath: storePath });
    logger.log?.(`ask-the-twin: built the twin store from the snapshot (${classes.reduce((n, c) => n + c.rowCount, 0)} records) at ${storePath}`);
  }
  const store = openTwinStore(storePath);
  const tools = createTools({
    store, getLiveEvents, readLayer, fetchWeather,
    insights: createInsights({ store, getLiveEvents, readLayer, centerline: CENTERLINE, fetchImpl }),
  });
  // The store's classes go into the cached system prompt, so the model does not spend a round asking.
  // One cached prompt per demo persona.
  const classes = store.classes();
  const prompts = new Map();
  const system = envelope => {
    const persona = envelope.screen?.persona ?? null;
    if (!prompts.has(persona)) prompts.set(persona, systemPrompt({ classes, persona }));
    return prompts.get(persona);
  };
  const orchestrator = createOrchestrator({ provider, tools, logger, prefetch: planPrefetch, system });
  return { store, ...createAskHttpHandler({ orchestrator, ...(clientKey ? { clientKey } : {}), ...(limiter ? { limiter } : {}) }) };
}
