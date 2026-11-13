/**
 * One hardened path to OpenProject, built on the shared `httpCore.mjs`.
 *
 * Shaped deliberately like `sapHttp.mjs`, because the guarantees are the same guarantees and a
 * reviewer should not have to check two different designs:
 *
 *  - the token is read from the environment at CALL TIME and never leaves this module. It is not
 *    returned, not logged, not formatted into a message, and `redacted()` is asserted over every
 *    payload before it is handed back. A missing token makes NO request.
 *  - the HOST is allowlisted and the API path is supplied by the caller as a module constant.
 *    The one thing a browser may influence is a numeric id, validated before it arrives here.
 *  - a bounded timeout, a bounded body, and `redirect: 'error'` so Basic credentials cannot be
 *    forwarded to a host that is not on the list.
 *  - every outcome has the same shape, so no caller has to tell a thrown error from a reported one.
 *
 * It knows nothing about work packages, progress or schedules. That is `openProject.mjs`'s business.
 */
import { ALLOWED_HOSTS, DEFAULT_BASE_URL, MAX_RETRY_AFTER_SECONDS } from './openProjectConfig.mjs';
import { readCapped, redacted, resolveOrigin, scrub, upstreamReason } from './httpCore.mjs';

/**
 * The states a screen must distinguish.
 *
 * Six, not three: the brief asks for them, and they are genuinely different findings. AUTH_FAILED
 * is the operator's to fix; CONNECTION_FAILED is the network's; DATA_INVALID is OpenProject
 * answering 200 with something we cannot read; PARTIAL is a real, usable answer that is known to
 * be incomplete, which must never be presented as a whole collection.
 */
export const STATE = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  CONNECTED: 'CONNECTED',
  AUTH_FAILED: 'AUTH_FAILED',
  CONNECTION_FAILED: 'CONNECTION_FAILED',
  DATA_INVALID: 'DATA_INVALID',
  PARTIAL: 'PARTIAL',
  /**
   * Configured, but nothing has been read yet.
   *
   * Only the stored view reports this. It is NOT a connection result — no request has been made —
   * and it exists because the alternative was a screen whose status chip said "Unknown": a view
   * that has not asked must say that, rather than claim a connection it has not tested or a
   * failure that has not happened.
   */
  NOT_READ: 'NOT_READ',
});

/** A finer reason behind CONNECTION_FAILED, for a screen that wants to explain it. */
export const FAILURE = Object.freeze({
  TIMEOUT: 'TIMEOUT',
  NETWORK: 'NETWORK',
  HTTP: 'HTTP',
  NOT_FOUND: 'NOT_FOUND',
  CONFIG: 'CONFIG',
  TRUNCATED: 'TRUNCATED',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  /** HTTP 429. Separate from HTTP because it is the one failure that tells us when to come back. */
  RATE_LIMITED: 'RATE_LIMITED',
  /**
   * HTTP 422 — OpenProject understood the request and refused the CONTENT.
   *
   * Separate from HTTP because it is the only failure the person at the keyboard can fix, and the
   * only one that names a field. Collapsing it into a single `reason`, as every other failure is,
   * would throw away the per-attribute messages a create form exists to display.
   */
  VALIDATION: 'VALIDATION',
});

/**
 * OpenProject's error body, as a map of attribute to message.
 *
 * Two shapes, both of which this instance emits. One violation comes back as a bare
 * `PropertyConstraintViolation` carrying `_embedded.details.attribute`; several come back as that
 * same object repeated inside `_embedded.errors`. An error with no attribute is not a field error
 * — it is about the request as a whole — so it is deliberately left out of the map rather than
 * filed under some invented key, and the caller still has `reason` for it.
 */
export function parseValidationErrors(body) {
  const seen = {};
  const take = entry => {
    const attribute = entry?._embedded?.details?.attribute;
    const message = entry?.message;
    if (typeof attribute !== 'string' || !attribute || typeof message !== 'string') return;
    // First message wins: OpenProject lists the primary violation before its consequences, and
    // "Duration must be greater than 0" is noise beside "Finish date must be >= start date".
    seen[attribute] ??= message;
  };
  const errors = body?._embedded?.errors;
  if (Array.isArray(errors)) for (const entry of errors) take(entry);
  take(body);
  return seen;
}

/**
 * `Retry-After`, in seconds.
 *
 * The header is specified two ways and OpenProject may send either: a delta in seconds, or an
 * HTTP date. Both are handled, a date in the past becomes 0 rather than a negative wait, and
 * anything unparseable returns null so the caller falls back to its own backoff instead of
 * treating a malformed header as "retry immediately".
 */
export function parseRetryAfter(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS) : null;
  }
  const when = Date.parse(text);
  if (Number.isNaN(when)) return null;
  return Math.min(Math.max(0, Math.ceil((when - Date.now()) / 1000)), MAX_RETRY_AFTER_SECONDS);
}

export const LIMITS = Object.freeze({
  /** The cloud instance answers a project read in well under a second. 10 s is a stall. */
  timeoutMs: 10_000,
  /** A full collection walk is several requests; each one still gets its own timeout. */
  collectionTimeoutMs: 15_000,
  maxBytes: 2_000_000,
});

/** The username is literally `apikey`; the token is the password. OpenProject's documented form. */
export const BASIC_USER = 'apikey';

/** The base URL, checked against the allowlist. */
export function resolveBaseUrl(raw = process.env.OPENPROJECT_BASE_URL) {
  return resolveOrigin(raw, { allowedHosts: ALLOWED_HOSTS, fallback: DEFAULT_BASE_URL,
    name: 'OPENPROJECT_BASE_URL' });
}

/**
 * A project id, validated.
 *
 * Digits only, and short. It is interpolated into an upstream path, so anything else is refused
 * here rather than encoded and sent: `..%2f` in a path segment is how an allowlisted host turns
 * into an arbitrary endpoint.
 */
export function parseId(value) {
  const text = String(value ?? '').trim();
  return /^\d{1,9}$/.test(text) ? text : null;
}

/**
 * A client for one allowlisted OpenProject instance.
 *
 * The token is resolved on EVERY call rather than captured at construction, so adding it to
 * `.env.local` and restarting is the whole configuration story, and a long-lived instance can
 * never report "not configured" after the token has arrived.
 */
export function createOpenProjectClient({
  env = process.env, fetchImpl = globalThis.fetch, logger = console,
  timeoutMs = LIMITS.timeoutMs, label = 'openproject',
} = {}) {
  const tokenOf = () => String(env.OPENPROJECT_API_TOKEN ?? '').trim();

  /**
   * One GET.
   *
   * @param {string} path a MODULE CONSTANT, or one built from a validated numeric id.
   * @param {object} [query] query parameters as values; encoded here.
   * @returns {Promise<{state, failure, httpStatus, reason, body, elapsedMs, url}>}
   *   `url` carries no credential — Basic auth is a header — so it is safe to show.
   */
  async function send(path, { query = {}, method = 'GET', body: payload = null,
    timeout = timeoutMs } = {}) {
    const blank = { state: STATE.CONNECTION_FAILED, failure: null, httpStatus: null, reason: null,
      body: null, elapsedMs: null, url: null, retryAfterSeconds: null, fieldErrors: null };

    const token = tokenOf();
    if (!token) {
      // No request at all. A missing credential is a configuration state, and probing the
      // instance anonymously would turn it into a 401 we would then have to explain away.
      return { ...blank, state: STATE.NOT_CONFIGURED,
        reason: 'OPENPROJECT_API_TOKEN is not set on the server. Add it to cesium-poc/.env.local '
          + 'and restart — the browser never sees it.' };
    }

    const base = resolveBaseUrl(env.OPENPROJECT_BASE_URL);
    if (!base.ok) return { ...blank, failure: FAILURE.CONFIG, reason: base.error };

    const url = new URL(`${base.baseUrl}${path}`);
    for (const [name, value] of Object.entries(query)) {
      if (value != null && value !== '') url.searchParams.set(name, String(value));
    }
    const shown = url.toString();

    const started = Date.now();
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          // Built here and nowhere else. Never logged, never returned, never put in a message.
          Authorization: `Basic ${Buffer.from(`${BASIC_USER}:${token}`).toString('base64')}`,
          Accept: 'application/hal+json',
          ...(payload == null ? {} : { 'Content-Type': 'application/json' }),
        },
        body: payload == null ? undefined : JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      const elapsedMs = Date.now() - started;
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      logger.warn?.(`[${label}] request failed after ${elapsedMs} ms: `
        + `${timedOut ? 'timeout' : String(error?.message ?? error)}`);
      return { ...blank, elapsedMs, url: shown,
        failure: timedOut ? FAILURE.TIMEOUT : FAILURE.NETWORK,
        /*
         * `sent` is the difference between "nothing happened" and "we do not know what happened".
         * A GET that times out can be repeated freely. A POST that times out may already have
         * created the record, so the caller must NOT retry it — it has to go and look instead.
         */
        sent: method !== 'GET',
        reason: timedOut ? `No response within ${timeout} ms.`
          : `OpenProject could not be reached: ${String(error?.message ?? error).slice(0, 200)}` };
    }

    const httpStatus = response.status;
    let text;
    try {
      text = await readCapped(response, { maxBytes: LIMITS.maxBytes, label: 'OpenProject' });
    } catch (error) {
      logger.warn?.(`[${label}] HTTP ${httpStatus}, body unreadable`);
      return { ...blank, httpStatus, url: shown, elapsedMs: Date.now() - started,
        state: STATE.DATA_INVALID, failure: FAILURE.TRUNCATED,
        reason: String(error?.message ?? error).slice(0, 200) };
    }
    const elapsedMs = Date.now() - started;

    if (!response.ok) {
      // Scrubbed before it is logged OR returned: an upstream that echoes the credential in its
      // error body must not get it into our logs or into the browser.
      const reason = scrub(upstreamReason(text), token);
      logger.warn?.(`[${label}] HTTP ${httpStatus}: ${reason ?? 'no reason given'}`);
      if (httpStatus === 401 || httpStatus === 403) {
        return { ...blank, httpStatus, url: shown, elapsedMs, state: STATE.AUTH_FAILED,
          failure: null,
          reason: httpStatus === 401
            ? `OpenProject rejected the API token (HTTP 401: ${reason ?? 'no reason given'}). `
              + 'Check OPENPROJECT_API_TOKEN on the server.'
            : `OpenProject accepted the token but refused the request (HTTP 403: `
              + `${reason ?? 'no reason given'}). The token\'s user may not see this project.` };
      }
      if (httpStatus === 429) {
        // The far end is asking us to slow down and may say for how long. Honoured as given
        // (capped), because guessing shorter than a published figure is how a client earns a ban.
        const retryAfterSeconds = parseRetryAfter(response.headers?.get?.('retry-after'));
        return { ...blank, httpStatus, url: shown, elapsedMs, failure: FAILURE.RATE_LIMITED,
          retryAfterSeconds,
          reason: `OpenProject is rate-limiting this client (HTTP 429: `
            + `${reason ?? 'no reason given'}).`
            + (retryAfterSeconds == null ? ' It did not say for how long.'
              : ` It asked us to wait ${retryAfterSeconds} s.`) };
      }
      if (httpStatus === 422 || httpStatus === 400) {
        // The one refusal a person can act on, so the attribute-level messages survive here
        // instead of being flattened into the single `reason` every other branch returns.
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* not JSON: `reason` still carries it */ }
        const fieldErrors = parsed ? parseValidationErrors(parsed) : {};
        const scrubbed = Object.fromEntries(Object.entries(fieldErrors)
          .map(([field, message]) => [field, scrub(message, token)]));
        return { ...blank, httpStatus, url: shown, elapsedMs, failure: FAILURE.VALIDATION,
          fieldErrors: scrubbed,
          reason: `OpenProject rejected the values (HTTP ${httpStatus}: `
            + `${reason ?? 'no reason given'}).` };
      }
      return { ...blank, httpStatus, url: shown, elapsedMs,
        failure: httpStatus === 404 ? FAILURE.NOT_FOUND : FAILURE.HTTP,
        reason: httpStatus === 404
          ? `OpenProject has no such resource (HTTP 404: ${reason ?? 'no reason given'}).`
          : `OpenProject answered HTTP ${httpStatus}: ${reason ?? 'no reason given'}.` };
    }

    let body;
    try { body = JSON.parse(text); } catch {
      logger.warn?.(`[${label}] HTTP ${httpStatus} but the body is not JSON`);
      return { ...blank, httpStatus, url: shown, elapsedMs, state: STATE.DATA_INVALID,
        failure: FAILURE.INVALID_RESPONSE,
        reason: 'OpenProject answered 200 with a body that is not JSON.' };
    }

    if (!redacted(body, token)) {
      logger.error?.(`[${label}] response contained the API token; withheld`);
      return { ...blank, httpStatus, url: shown, elapsedMs, state: STATE.DATA_INVALID,
        failure: FAILURE.INVALID_RESPONSE,
        reason: 'The response echoed the API token, so it was discarded rather than returned.' };
    }

    return { state: STATE.CONNECTED, failure: null, httpStatus, reason: null, body, elapsedMs,
      url: shown, retryAfterSeconds: null, fieldErrors: null };
  }

  /**
   * One GET. The read path every caller before Phase 10B used, unchanged in behaviour.
   *
   * @param {string} path a MODULE CONSTANT, or one built from a validated numeric id.
   * @param {object} [query] query parameters as values; encoded here.
   */
  const get = (path, query = {}, options = {}) => send(path, { ...options, query, method: 'GET' });

  /**
   * One POST with a JSON body.
   *
   * Deliberately NOT named `write`: OpenProject's form endpoint is a POST that creates nothing,
   * and the create endpoint is a POST that creates exactly one thing. Which it is depends on the
   * path, so this function takes no position on it and the adapter above says which it meant.
   */
  const post = (path, body, options = {}) => send(path, { ...options, method: 'POST', body });

  /**
   * A GET that must come back as a HAL collection.
   *
   * `_type: 'Collection'` with `_embedded.elements` an array, or it is not what we asked for —
   * and saying so beats handing a caller an empty array that reads as "no activities".
   */
  async function collection(path, query = {}, options = {}) {
    const outcome = await get(path, query, options);
    if (outcome.state !== STATE.CONNECTED) return { ...outcome, elements: [], total: null };
    const body = outcome.body;
    const elements = body?._embedded?.elements;
    if (!Array.isArray(elements)) {
      return { ...outcome, state: STATE.DATA_INVALID, failure: FAILURE.INVALID_RESPONSE,
        elements: [], total: null,
        reason: 'The response has no _embedded.elements array, so it is not the HAL collection '
          + 'this adapter expects.' };
    }
    return {
      ...outcome,
      elements,
      /** What OpenProject says the collection HOLDS, separate from what this page RETURNED. */
      total: Number.isFinite(Number(body?.total)) ? Number(body.total) : null,
      count: Number.isFinite(Number(body?.count)) ? Number(body.count) : elements.length,
      pageSize: Number.isFinite(Number(body?.pageSize)) ? Number(body.pageSize) : null,
      offset: Number.isFinite(Number(body?.offset)) ? Number(body.offset) : null,
      /** The server's own next-page link, used only after it is checked against the allowlist. */
      nextHref: typeof body?._links?.nextByOffset?.href === 'string'
        ? body._links.nextByOffset.href : null,
    };
  }

  /**
   * A `_links` href from OpenProject, accepted only if it stays on our own instance and inside the
   * API. OpenProject's hrefs are same-origin relative paths today; following one blindly would
   * hand the credential wherever a compromised or misconfigured instance pointed it.
   */
  function safeApiPath(href) {
    const text = String(href ?? '').trim();
    if (!text) return null;
    if (text.startsWith('/api/v3/')) return text;
    let url;
    try { url = new URL(text); } catch { return null; }
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.includes(url.hostname)) return null;
    if (!url.pathname.startsWith('/api/v3/')) return null;
    return `${url.pathname}${url.search}`;
  }

  return {
    get,
    post,
    send,
    collection,
    safeApiPath,
    configured: () => Boolean(tokenOf()),
    baseUrl: () => resolveBaseUrl(env.OPENPROJECT_BASE_URL),
    /** For the token-leak assertions in the tests, without exposing the token itself. */
    redactedFor: payload => redacted(payload, tokenOf()),
  };
}
