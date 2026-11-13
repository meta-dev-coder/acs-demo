/**
 * One hardened path to SAP, shared by every adapter that talks to it.
 *
 * Extracted in Phase 7C. Phase 7A proved the call; Phase 7C adds a second service, and two copies
 * of credential handling is how the second copy ends up missing the check the first one has. The
 * guarantees live here, once:
 *
 *  - the key is read from the environment at call time and never leaves this module. It is not
 *    returned, not logged, not formatted into a message, and `redacted()` is asserted over every
 *    payload before it is handed back.
 *  - the HOST is allowlisted and the SERVICE PATH is supplied by the caller as a module constant,
 *    never from a request. Callers pass OData query options as values, which are encoded here.
 *  - a bounded timeout, a bounded response body, and `redirect: 'error'` so the credential cannot
 *    be forwarded to a host that is not on the list.
 *  - every outcome has the same shape, so no caller has to tell a thrown error from a reported
 *    one.
 *
 * It knows nothing about projects, WBS elements or cost. That is the adapters' business.
 */
import { ALLOWED_HOSTS, DEFAULT_BASE_URL } from './sapSandboxConfig.mjs';
import {
  readCapped as readCappedBody, redacted, resolveOrigin, scrub, upstreamReason,
} from './httpCore.mjs';

/*
 * The system-agnostic parts now live in `httpCore.mjs`, shared with the OpenProject client added
 * in Phase 8A. They are re-exported here unchanged so this module's public surface — and every
 * message it produces — is exactly what it was.
 */
export { redacted, upstreamReason };

/** The three states a UI must distinguish. Nothing else is reported. */
export const CONNECTION = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  CONNECTED: 'CONNECTED',
  FAILED: 'FAILED',
});

/** Why a FAILED state failed. Separate from the state so a screen can explain it. */
export const FAILURE = Object.freeze({
  AUTH: 'AUTH',
  TIMEOUT: 'TIMEOUT',
  NETWORK: 'NETWORK',
  HTTP: 'HTTP',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  CONFIG: 'CONFIG',
});

export const LIMITS = Object.freeze({
  /** The sandbox answers in about a second; 8 s is a stall, not slowness. */
  timeoutMs: 8_000,
  /** The journal service is analytical and slower than the project one. */
  costTimeoutMs: 25_000,
  /** A sandbox page of 25 is ~40 kB. 2 MB is a runaway response, and we stop reading it. */
  maxBytes: 2_000_000,
  /** OData `$top`. A demo reads one project; this is a ceiling, not a target. */
  maxTop: 5_000,
});

/**
 * The base URL, checked.
 *
 * An env var is not frontend input, but it is the one place a hostname could change, so it is
 * validated against the allowlist too: a typo that pointed the key at another host would send the
 * credential there.
 */
export function resolveBaseUrl(raw = process.env.SAP_SANDBOX_BASE_URL) {
  const outcome = resolveOrigin(raw, { allowedHosts: ALLOWED_HOSTS, fallback: DEFAULT_BASE_URL,
    name: 'SAP_SANDBOX_BASE_URL' });
  return outcome.ok ? { ok: true, baseUrl: outcome.baseUrl } : outcome;
}

/**
 * An OData v2 `/Date(ms+0000)/` value as ISO 8601.
 *
 * Returned as `null` when it cannot be read, never as the raw string: a screen that prints
 * `/Date(1492041600000)/` in a date column has told the operator nothing, and a guess would be
 * worse.
 */
export function odataDate(value) {
  if (typeof value !== 'string') return null;
  const match = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(value.trim());
  if (!match) return null;
  const ms = Number(match[1]);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * An OData v2 decimal as a number.
 *
 * SAP sends `Edm.Decimal` as a STRING ("5997.00"), deliberately, so that a currency amount never
 * passes through a float on the wire. `Number(null)` is 0 and finite, so the null check comes
 * first — a missing amount must read as absent, never as zero.
 */
export function odataDecimal(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The shared capped read, labelled so the message reads "The SAP response exceeded ...". */
export const readCapped = (response, options = {}) =>
  readCappedBody(response, { label: 'SAP', ...options });

/**
 * A client for one allowlisted SAP host.
 *
 * The key is resolved on EVERY call rather than captured at construction, so adding it to
 * `.env.local` and restarting is the whole of the configuration story and a long-lived instance
 * can never report "not configured" after the key has arrived.
 */
export function createSapClient({
  env = process.env, fetchImpl = globalThis.fetch, logger = console,
  timeoutMs = LIMITS.timeoutMs, label = 'sap',
} = {}) {
  const keyOf = () => String(env.SAP_SANDBOX_API_KEY ?? '').trim();

  /**
   * One GET.
   *
   * @param {string} servicePath a MODULE CONSTANT, never request data. Leading slash.
   * @param {object} [query] OData options as values; encoded here. `$format=json` is always set.
   * @returns {Promise<{state, failure, httpStatus, reason, body, elapsedMs, url}>}
   *   `url` is the request URL WITHOUT the credential — it is a header, so this is safe to show.
   */
  async function get(servicePath, query = {}, { raw = false } = {}) {
    const blank = { state: CONNECTION.FAILED, failure: null, httpStatus: null, reason: null,
      body: null, text: null, elapsedMs: null, url: null };

    const key = keyOf();
    if (!key) {
      return { ...blank, state: CONNECTION.NOT_CONFIGURED,
        reason: 'SAP_SANDBOX_API_KEY is not set on the server. Add it to cesium-poc/.env.local '
          + 'and restart — the browser never sees it.' };
    }

    const base = resolveBaseUrl(env.SAP_SANDBOX_BASE_URL);
    if (!base.ok) return { ...blank, failure: FAILURE.CONFIG, reason: base.error };

    const url = new URL(`${base.baseUrl}${servicePath}`);
    // `$count` returns a bare number as text/plain and REJECTS `$format=json` with HTTP 400, so
    // a raw request must not carry it. Found live, against the real service.
    if (!raw) url.searchParams.set('$format', 'json');
    for (const [name, value] of Object.entries(query)) {
      if (value != null && value !== '') url.searchParams.set(name, String(value));
    }
    const shown = url.toString();

    const started = Date.now();
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { APIKey: key, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const elapsedMs = Date.now() - started;
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      logger.warn?.(`[${label}] request failed after ${elapsedMs} ms: `
        + `${timedOut ? 'timeout' : String(error?.message ?? error)}`);
      return { ...blank, elapsedMs, url: shown,
        failure: timedOut ? FAILURE.TIMEOUT : FAILURE.NETWORK,
        reason: timedOut ? `No response within ${timeoutMs} ms.`
          : `SAP could not be reached: ${String(error?.message ?? error).slice(0, 200)}` };
    }

    const httpStatus = response.status;
    let text;
    try {
      text = await readCapped(response);
    } catch (error) {
      logger.warn?.(`[${label}] HTTP ${httpStatus}, body unreadable`);
      return { ...blank, httpStatus, url: shown, elapsedMs: Date.now() - started,
        failure: FAILURE.INVALID_RESPONSE, reason: String(error?.message ?? error).slice(0, 200) };
    }
    const elapsedMs = Date.now() - started;

    if (!response.ok) {
      // Scrubbed: SAP's own 401 names the header ("Invalid ApiKey") rather than the value, but an
      // upstream that echoed the key would otherwise put it in a log and in a browser response.
      const reason = scrub(upstreamReason(text), key);
      logger.warn?.(`[${label}] HTTP ${httpStatus}: ${reason ?? 'no reason given'}`);
      const auth = httpStatus === 401 || httpStatus === 403;
      return { ...blank, httpStatus, url: shown, elapsedMs,
        failure: auth ? FAILURE.AUTH : FAILURE.HTTP,
        reason: auth
          ? `SAP rejected the API key (HTTP ${httpStatus}: ${reason ?? 'no reason given'}). `
            + 'Check SAP_SANDBOX_API_KEY on the server.'
          : `SAP answered HTTP ${httpStatus}: ${reason ?? 'no reason given'}.` };
    }

    if (raw) {
      if (!redacted(text, key)) {
        logger.error?.(`[${label}] response contained the API key; withheld`);
        return { ...blank, httpStatus, url: shown, elapsedMs, failure: FAILURE.INVALID_RESPONSE,
          reason: 'The response echoed the API key, so it was discarded rather than returned.' };
      }
      return { state: CONNECTION.CONNECTED, failure: null, httpStatus, reason: null, body: null,
        text, elapsedMs, url: shown };
    }

    let body;
    try { body = JSON.parse(text); } catch {
      logger.warn?.(`[${label}] HTTP ${httpStatus} but the body is not JSON`);
      return { ...blank, httpStatus, url: shown, elapsedMs, failure: FAILURE.INVALID_RESPONSE,
        reason: 'SAP answered 200 with a body that is not JSON.' };
    }

    if (!redacted(body, key)) {
      logger.error?.(`[${label}] response contained the API key; withheld`);
      return { ...blank, httpStatus, url: shown, elapsedMs, failure: FAILURE.INVALID_RESPONSE,
        reason: 'The response echoed the API key, so it was discarded rather than returned.' };
    }

    return { state: CONNECTION.CONNECTED, failure: null, httpStatus, reason: null, body,
      text, elapsedMs, url: shown };
  }

  /**
   * A GET that must come back as an OData v2 collection.
   *
   * `d.results` or it is not the collection we asked for — and saying so is better than handing a
   * caller an empty array that looks like "no records".
   */
  async function collection(servicePath, query = {}) {
    const outcome = await get(servicePath, query);
    if (outcome.state !== CONNECTION.CONNECTED) return { ...outcome, rows: [] };
    const rows = outcome.body?.d?.results;
    if (!Array.isArray(rows)) {
      return { ...outcome, state: CONNECTION.FAILED, failure: FAILURE.INVALID_RESPONSE, rows: [],
        reason: 'The response has no d.results array, so it is not the OData v2 collection this '
          + 'adapter expects.' };
    }
    return { ...outcome, rows };
  }

  /**
   * An OData `$count`, which is a bare number in text/plain.
   *
   * Returns `null` rather than 0 when it cannot be read. `Number(null)` is 0 AND finite, so a
   * failed count that went through a naive `Number()` would display as "0 source rows" — a
   * confident, wrong figure rather than an absent one.
   */
  async function count(servicePath, query = {}) {
    const outcome = await get(servicePath, query, { raw: true });
    if (outcome.state !== CONNECTION.CONNECTED) return { ...outcome, count: null };
    const text = String(outcome.text ?? '').trim();
    const value = /^\d+$/.test(text) ? Number(text) : null;
    return { ...outcome, count: value };
  }

  return { get, collection, count, configured: () => Boolean(keyOf()), baseUrl: () => resolveBaseUrl(env.SAP_SANDBOX_BASE_URL) };
}
