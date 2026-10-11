/**
 * HTTP host adapter for the Ask the Twin orchestrator: POST /api/i595/ask.
 *
 * Two response shapes from one handler:
 * - `Accept: text/event-stream` → Server-Sent Events, one event per orchestrator event, with a
 *   heartbeat comment so a proxy in front (CloudFront's origin idle timeout) never sees a silent gap
 *   while a tool runs;
 * - anything else → one JSON answer in the original reply contract, so a client that does not
 *   stream (the GitHub Pages build talking to the Lambda era contract) keeps working.
 *
 * A client that goes away aborts the run: the model call and tools stop instead of spending tokens
 * on an answer nobody will read.
 */
import { createAskLimiter } from '../liveDc/askTwin.mjs';
import { EnvelopeError, sanitizeEnvelope } from './envelope.mjs';

export const ASK_PATH = '/api/i595/ask';
const MAX_BODY = 32 * 1024;

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size <= limit) chunks.push(chunk); });
    req.on('end', () => {
      if (size > limit) { reject(new EnvelopeError('Request too large.', 413)); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new EnvelopeError('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

/** One SSE frame; the event name doubles as the `type` field inside the data. */
export const sseFrame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

/**
 * @param {{orchestrator: {run: Function}, limiter?: {take: (key: string) => boolean},
 *   clientKey?: (req: object) => string, heartbeatMs?: number}} options
 *   `clientKey` identifies a caller for rate limiting: a session id on a host with sessions,
 *   the socket address locally.
 */
export function createAskHttpHandler({ orchestrator, limiter = createAskLimiter({ limit: 120 }),
  clientKey = req => req.socket?.remoteAddress ?? 'unknown', heartbeatMs = 10_000 }) {
  const sendJson = (req, res, status, body) => {
    if (!req.readableEnded) req.resume();
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  async function handle(req, res) {
    if (req.method !== 'POST') return sendJson(req, res, 405, { error: 'Use POST.' });
    let envelope;
    try {
      envelope = sanitizeEnvelope(await readJson(req, MAX_BODY));
    } catch (error) {
      return sendJson(req, res, error instanceof EnvelopeError ? error.status : 400, { error: error.message });
    }
    if (!limiter.take(clientKey(req))) {
      return sendJson(req, res, 429, { error: 'Too many questions in a short time. Please wait a few minutes.' });
    }

    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    if (!/text\/event-stream/.test(String(req.headers.accept ?? ''))) {
      let failure = null;
      const answer = await orchestrator.run(envelope, event => { if (event.type === 'RunError') failure = event; }, { signal: controller.signal });
      if (controller.signal.aborted) return undefined;
      return answer ? sendJson(req, res, 200, answer) : sendJson(req, res, 502, { error: failure?.message ?? 'The assistant could not answer just now.' });
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      // nginx-style proxies buffer event streams unless told not to.
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    });
    res.flushHeaders?.();
    const write = chunk => { if (!res.writableEnded && !controller.signal.aborted) res.write(chunk); };
    const heartbeat = setInterval(() => write(': heartbeat\n\n'), heartbeatMs);
    try {
      await orchestrator.run(envelope, event => write(sseFrame(event)), { signal: controller.signal });
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
    return undefined;
  }

  return {
    handle,
    /** Connect/Vite middleware: answers ASK_PATH, passes everything else on. */
    middleware: (req, res, next) => {
      const path = new URL(req.originalUrl ?? req.url, 'http://localhost').pathname;
      if (path !== ASK_PATH) { next(); return; }
      handle(req, res).catch(next);
    },
  };
}
