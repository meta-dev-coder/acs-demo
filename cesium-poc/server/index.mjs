/**
 * Standalone host for the live-event API (`npm run api`). In development the same handlers are
 * mounted straight into Vite (vite.config.js), so this entry point exists for deployments where
 * the map is served as static files and the FL511 poller runs as its own process.
 */
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServerEnv } from './loadEnv.mjs';
import { loadConfig } from './config.mjs';
import { API_BASE } from './api.mjs';
import { createReadApiHandlers } from './readApiHandlers.mjs';
import { createConstructionApi } from './construction/api.mjs';

export function createApiServer({ config = loadConfig(), env = process.env, logger = console,
  /**
   * The Construction Integration Demo's API.
   *
   * Mounted here rather than in `readApiHandlers.mjs` because that module is also the EC2
   * live-dc host's handler list, and this project has no place on that host — it would open a
   * SQLite file there and needs a newer Node than that host is documented to carry.
   */
  construction = true } = {}) {
  const { handlers: readHandlers, stop: stopRead } = createReadApiHandlers({ config, env, logger });
  const constructionApi = construction ? createConstructionApi({ logger }) : null;
  const handlers = constructionApi ? [...readHandlers, constructionApi] : readHandlers;
  /*
   * Phase 8B: the OpenProject background poller.
   *
   * Started here rather than inside the factory, so importing the module reaches no network and a
   * test that builds an API gets no timer. It is a no-op unless OPENPROJECT_AUTO_SYNC_ENABLED is
   * true and a token is configured, and `close()` awaits the cycle in flight so a shutdown cannot
   * cut one off mid-transaction.
   */
  constructionApi?.startAutoSync();
  const stop = async () => { await constructionApi?.close(); await stopRead(); };

  const server = createServer((request, response) => {
    (async () => {
      for (const handler of handlers) {
        if (await handler.handle(request, response)) return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: `Not found. Try GET ${API_BASE}` }));
    })().catch(error => {
      logger.error?.('Unhandled request failure', error);
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Internal error' }));
    });
  });
  return { server, stop };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadServerEnv();
  const config = loadConfig();
  const { server, stop } = createApiServer({ config });
  server.listen(config.port, () => console.log(`Live events API listening on http://127.0.0.1:${config.port}${API_BASE}`));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { server.close(); stop().finally(() => process.exit(0)); });
  }
}
