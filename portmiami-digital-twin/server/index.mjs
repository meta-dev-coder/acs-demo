/**
 * Standalone host for the PortMiami live-traffic API.
 *
 * Only needed in production, where there is no Vite dev server to mount the middleware in: serve
 * the built `dist/` from any static host and point it at this process, or run this behind the same
 * origin. In development `npm run dev` mounts the very same handlers (see vite.config.js), so the
 * browser always talks to its own origin and never to FL511.
 */
import { createServer } from 'node:http';
import { loadFl511Config } from './fl511/config.mjs';
import { createLiveTrafficApi } from './portmiami/api.mjs';

const config = loadFl511Config();
const api = createLiveTrafficApi({ config });

const server = createServer((request, response) => {
  api.handle(request, response).then(handled => {
    if (handled) return;
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'Not found.' }));
  }, error => {
    console.error('[PortMiami] request failed', error);
    response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'Internal error.' }));
  });
});

server.listen(config.port, () => {
  console.log(`[PortMiami] live-traffic API on http://localhost:${config.port}/api/portmiami/live-events`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    api.stop().finally(() => process.exit(0));
  });
}
