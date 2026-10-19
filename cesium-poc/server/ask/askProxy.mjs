/**
 * Forwards Ask the Twin to a separately running ask service (tools/ask-serve.mjs, the
 * live-dc-ask.service unit on EC2). The demo host keeps the password gate; this only streams the
 * request and the Server-Sent Events back, so a slow model turn or a refresh problem lives in its own
 * process and can never stall the DataConnect writer.
 */
import { request as httpRequest } from 'node:http';

const FORWARD = ['content-type', 'accept', 'content-length'];

/**
 * @param {{target: string, clientKey?: (req: object) => string, timeoutMs?: number, logger?: Console}} options
 *   `target` e.g. http://127.0.0.1:8787; `clientKey` names the caller for the service's per-session limit
 * @returns {{handle: (req: object, res: object) => void, target: string}}
 */
export function createAskProxy({ target, clientKey = req => req.socket?.remoteAddress ?? 'unknown', timeoutMs = 60_000, logger = console }) {
  const base = new URL(target);
  if (base.protocol !== 'http:') throw new Error(`ASK_TWIN_SERVICE_URL must be http:// on the same host, got ${base.protocol}`);
  return {
    target: base.origin,
    handle(req, res) {
      const headers = Object.fromEntries(FORWARD.filter(h => req.headers[h] !== undefined).map(h => [h, req.headers[h]]));
      // The service trusts this header only because it listens on 127.0.0.1 (see ask-serve.mjs).
      headers['x-ask-client'] = String(clientKey(req)).slice(0, 200);
      const upstream = httpRequest({ hostname: base.hostname, port: base.port, path: new URL(req.url, 'http://x').pathname, method: req.method, headers, timeout: timeoutMs }, up => {
        res.writeHead(up.statusCode ?? 502, Object.fromEntries(['content-type', 'cache-control', 'x-accel-buffering'].filter(h => up.headers[h]).map(h => [h, up.headers[h]])));
        up.pipe(res);
      });
      const fail = message => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ error: message }));
        } else res.destroy();
      };
      upstream.on('timeout', () => { upstream.destroy(); fail('The Ask the Twin service took too long to answer.'); });
      upstream.on('error', error => {
        logger.warn?.(`live-dc ask proxy: ${error.code ?? error.message}`);
        fail('The Ask the Twin service is not running. Check `livedc.sh status`.');
      });
      // A browser that closes the panel mid-answer stops the run upstream too.
      res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
      req.pipe(upstream);
    },
  };
}
