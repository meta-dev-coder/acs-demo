/**
 * Ask the Twin as its own local process: the orchestrator, the twin store and its DataConnect refresh,
 * without the map. This is the service the EC2 host will run as live-dc-ask.service, so it can be run
 * and verified on a laptop first (docs: deploy/ec2/ASK_THE_TWIN.md, "Run it locally").
 *
 *   npm run ask:serve                   # http://127.0.0.1:8787
 *   ASK_TWIN_SERVICE_URL=http://127.0.0.1:8787 npm run dev   # the map asks this process
 *
 * Routes:
 *   POST /api/i595/ask           the same contract as the dev route (SSE or JSON)
 *   GET  /api/i595/ask/status    model, store classes with origin (live / historical / snapshot) and
 *                                load time, and the last refresh — what to check before trusting an answer
 *   GET  /healthz                200 when the process is up
 *
 * Configuration is the dev server's: cesium-poc/.env.local (ASK_TWIN_*, LIVE_DC_READ_*, DC_*). It
 * listens on 127.0.0.1 only and has no sign-in: it is a local verification tool, not a public server.
 * Read-only against DataConnect.
 */
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { originOf } from '../server/ask/twinStore.mjs';

export const DEFAULT_PORT = 8787;

/** The status document: enough to tell which model, which data, and how fresh. */
export function statusOf({ label, store = null, refresher = null, spend = null, now = Date.now }) {
  const classes = store ? store.classes().map(c => ({ className: c.className, origin: originOfSource(c.source), rowCount: c.rowCount, asOf: c.asOf })) : [];
  return {
    ok: Boolean(store),
    model: label,
    checkedAt: new Date(now()).toISOString(),
    store: { classes, live: classes.filter(c => c.origin === 'live').length, historical: classes.filter(c => c.origin === 'historical').length,
      snapshot: classes.filter(c => c.origin === 'snapshot').length, synthetic: classes.filter(c => c.origin === 'synthetic').length,
      imported: classes.filter(c => c.origin === 'imported').length },
    refresh: refresher ? { ...refresher.status } : { off: true },
    usage: spend?.status?.() ?? null,
  };
}

const originOfSource = source => originOf(source);

/**
 * The request handler around an ask service (createLocalAsk's result). Exported for tests.
 * @param {{ask: {handle: Function, label: string, store?: object, refresher?: object}}} options
 */
export function createAskServer({ ask }) {
  return createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }
    if (req.method === 'GET' && path === '/api/i595/ask/status') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(statusOf(ask), null, 2));
    }
    if (path === '/api/i595/ask') return ask.handle(req, res);
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
}

async function main() {
  const { loadServerEnv } = await import('../server/loadEnv.mjs');
  loadServerEnv();
  const { createLiveDcReadApi } = await import('../server/liveDc/liveReadApi.mjs');
  const { createDataConnectApi } = await import('../server/dataConnect.mjs');
  const { createLiveEventsApi } = await import('../server/api.mjs');
  const { createLocalAsk } = await import('../server/ask/localAsk.mjs');
  const { applyServiceClientSecret } = await import('../server/liveDc/awsSecret.mjs');
  const { createAskLimiter } = await import('../server/liveDc/askTwin.mjs');

  // On EC2 the DataConnect read clients come from the service-client secret (as for live-dc);
  // a no-op on a laptop, where .env.local has them.
  await applyServiceClientSecret({ env: process.env });
  const liveDc = createLiveDcReadApi();
  const historical = createDataConnectApi();
  const liveEvents = createLiveEventsApi({ liveDc });
  const ask = createLocalAsk({
    // As in `npm run dev`: the DataConnect Live Events class when configured, else FL511 direct.
    getLiveEvents: async () => (await liveEvents.dataConnectEvents().catch(() => null)) ?? liveEvents.fl511Events().catch(() => null),
    liveDc, historical,
    // Behind live-dc's gate the proxy names the session in x-ask-client; this process only listens on
    // 127.0.0.1, so nothing else can set it.
    clientKey: req => String(req.headers['x-ask-client'] ?? '').trim() || req.socket?.remoteAddress || 'unknown',
    limiter: createAskLimiter({ limit: 120 }),
  });
  const port = Number(process.env.ASK_TWIN_PORT) || DEFAULT_PORT;
  const server = createAskServer({ ask });
  server.listen(port, '127.0.0.1', () => {
    console.log(`ask-the-twin service: http://127.0.0.1:${port}/api/i595/ask  (status: /api/i595/ask/status)`);
    console.log(`  use it from the map: ASK_TWIN_SERVICE_URL=http://127.0.0.1:${port} npm run dev`);
  });
  const stop = () => {
    ask.refresher?.stop();
    liveEvents.stop?.();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// Compared after resolving symlinks: on EC2 the unit starts /opt/live-dc/current/live-dc-ask.mjs, and
// `current` is a symlink to the release, so a plain path compare would exit 0 without starting.
const isMain = () => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};

if (process.argv[1] && isMain()) {
  main().catch(error => {
    console.error(`ask-the-twin service: ${error.message}`);
    process.exitCode = 1;
  });
}
