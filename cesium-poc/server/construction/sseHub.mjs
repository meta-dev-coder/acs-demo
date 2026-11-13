/**
 * A small Server-Sent Events hub: one place that knows how to hold open HTTP responses.
 *
 * SSE and not a WebSocket, because the traffic is one-directional and tiny — "something changed,
 * go and re-read it" — and a WebSocket would mean a second protocol, an upgrade handler and a
 * library in a dev server that is otherwise plain `connect` middleware. SSE is a normal HTTP
 * response that is never ended, so it works through Vite's middleware stack and through
 * `server/index.mjs` unchanged, reconnects by itself in every browser, and needs no client library.
 *
 * What it will not do:
 *
 *  - it will not carry the payload. Every event here is a NOTIFICATION — ids and counts — and the
 *    client re-reads the normalized endpoint it already has. That keeps one source of truth for
 *    the data, keeps a credential-bearing adapter's output on one code path, and means a dropped
 *    or coalesced event costs a reader nothing but a few seconds.
 *  - it will not grow without bound. Subscribers are capped, a heartbeat keeps proxies from
 *    silently dropping idle connections, and every socket is removed on `close` and on `error`.
 *  - it will not hold a process open. The heartbeat timer is `unref`'d, so a dev server or a test
 *    run exits whether or not somebody is listening.
 */

/** Plenty for a demo, and a bound rather than none at all. */
export const MAX_SUBSCRIBERS = 50;

/**
 * 25 s.
 *
 * Under the 30 s that proxies and load balancers commonly use to reap an idle connection, and the
 * comment payload (`:`) is ignored by every SSE client, so a heartbeat can never be mistaken for
 * an event.
 */
export const HEARTBEAT_MS = 25_000;

export function createSseHub({
  logger = console, heartbeatMs = HEARTBEAT_MS, maxSubscribers = MAX_SUBSCRIBERS,
  label = 'sse',
} = {}) {
  /** @type {Set<{res: object, id: number}>} */
  const clients = new Set();
  let nextId = 1;
  let heartbeat = null;
  let closed = false;
  /** Counted, not kept: a screen can say how many events it has missed nothing of. */
  let published = 0;

  function beat() {
    if (heartbeat || closed) return;
    heartbeat = setInterval(() => {
      for (const client of [...clients]) write(client, ': keep-alive\n\n');
    }, heartbeatMs);
    heartbeat.unref?.();
  }

  function write(client, chunk) {
    try {
      client.res.write(chunk);
    } catch (error) {
      // A client that has gone away is not an error worth logging loudly; it is the normal end of
      // a subscription that did not get to send us its `close`.
      logger.warn?.(`[${label}] dropping subscriber ${client.id}: ${error?.message ?? error}`);
      drop(client);
    }
  }

  function drop(client) {
    if (!clients.delete(client)) return;
    try { client.res.end(); } catch { /* already gone */ }
    if (clients.size === 0 && heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  }

  /**
   * Hold this response open as a subscriber.
   *
   * @returns {boolean} false when the hub is closed or full — the caller answers 503 itself rather
   *   than being handed a connection that silently never receives anything.
   */
  function subscribe(req, res, { hello = null } = {}) {
    if (closed) return false;
    if (clients.size >= maxSubscribers) {
      logger.warn?.(`[${label}] refusing a subscriber; ${clients.size} already connected`);
      return false;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      // Nginx buffers a proxied response by default, which holds every event until the buffer
      // fills — an SSE stream that works locally and appears dead behind a proxy.
      'x-accel-buffering': 'no',
    });
    res.flushHeaders?.();

    const client = { res, id: nextId++ };
    clients.add(client);
    // A first comment flushes headers through any intermediary, so `onopen` fires promptly.
    write(client, `: subscribed as ${client.id}\n\n`);
    if (hello) write(client, frame(hello.event, hello.data));
    beat();

    const finish = () => drop(client);
    req.on('close', finish);
    req.on('error', finish);
    res.on('close', finish);
    res.on('error', finish);
    return true;
  }

  /**
   * One SSE frame.
   *
   * Newlines inside the JSON would end the frame early, so the data is serialized and then split
   * per line. `JSON.stringify` cannot emit a raw newline, but a caller passing a pre-made string
   * could, and a protocol bug there is invisible until it corrupts an event.
   */
  function frame(event, data) {
    const body = typeof data === 'string' ? data : JSON.stringify(data ?? {});
    const lines = body.split('\n').map(line => `data: ${line}`).join('\n');
    return `event: ${event}\n${lines}\n\n`;
  }

  /** Send to everyone. @returns the number of subscribers written to. */
  function publish(event, data) {
    if (closed) return 0;
    published += 1;
    const chunk = frame(event, data);
    const targets = [...clients];
    for (const client of targets) write(client, chunk);
    return targets.length;
  }

  function close() {
    closed = true;
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    for (const client of [...clients]) drop(client);
  }

  return {
    subscribe,
    publish,
    close,
    frame,
    get size() { return clients.size; },
    get published() { return published; },
    get closed() { return closed; },
  };
}
