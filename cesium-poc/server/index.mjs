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

export function createApiServer({ config = loadConfig(), env = process.env, logger = console } = {}) {
  const { handlers, stop } = createReadApiHandlers({ config, env, logger });

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
