/**
 * Standalone host for the live-event API (`npm run api`). In development the same handler is
 * mounted straight into Vite (vite.config.js), so this entry point exists for deployments where
 * the map is served as static files and the FL511 poller runs as its own process.
 */
import { createServer } from 'node:http';
import { loadConfig } from './config.mjs';
import { API_BASE, createLiveEventsApi } from './api.mjs';

const config = loadConfig();
const api = createLiveEventsApi({ config });

const server = createServer((request, response) => {
  api.handle(request, response).then(handled => {
    if (handled) return;
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: `Not found. Try GET ${API_BASE}` }));
  }, error => {
    console.error('Unhandled request failure', error);
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Internal error' }));
  });
});

server.listen(config.port, () => console.log(`Live events API listening on http://127.0.0.1:${config.port}${API_BASE}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { server.close(); api.stop().finally(() => process.exit(0)); });
}
