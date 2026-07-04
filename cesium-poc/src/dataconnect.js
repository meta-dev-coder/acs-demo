/*
 * dataconnect.js — thin client for the DataConnect (Cohesive/Bentley) API protocol.
 *
 * Speaks the SAME three endpoints the live demo instance
 * (dataconnect-demo-dqa3.cohesivecloud.app) exposes, so this client can be pointed at either
 * tools/dataconnect_shim.py (local stand-in, default) or the real instance with only a
 * base-URL + credentials change — see docs/superpowers/specs/2026-07-04-dataconnect-scenario-a-
 * demo-design.md ("swap-ready" approach). No code here should assume it's talking to the shim.
 *
 *   POST /api/authenticate                       -> {token, refreshToken}
 *   GET  /api/data-mgmt/v1/class                  -> {classes:[{name, recordCount}, ...]}
 *   POST /api/data-mgmt/v1/curated-data/search    -> {items, page, pageSize, total}
 *
 * Base URL: ?dc=<url> query param, else http://localhost:8787 (the shim's default port).
 * Credentials: ?dcuser=/?dcpass= query params, else demo defaults (the shim accepts anything;
 * the real instance will need real values passed the same way).
 *
 * Failure semantics are "keep-previous-on-failure" (the repo's data/loader.ts pattern): this
 * module never touches any UI state itself — it only reports connectivity via onStatus()
 * callbacks ("online" | "offline" | "auth-failed") and throws on failure. Callers (main.js) are
 * responsible for keeping the last-good scored/rendered data untouched when a fetch throws.
 */

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PAGES = 100; // hard guard: pagination must never loop forever, even on a buggy server.
const DEFAULT_PAGE_SIZE = 200;

const params = new URLSearchParams(location.search);
const BASE_URL = (params.get("dc") || "http://localhost:8787").replace(/\/$/, "");
const USERNAME = params.get("dcuser") || "demo";
const PASSWORD = params.get("dcpass") || "demo";
// ?dctoken= — pre-acquired IMS OIDC bearer token. The production DataConnect deployment
// authenticates via Bentley IMS (its /api/authenticate returns 404), so with a token supplied
// login() short-circuits and a later 401 is terminal auth-failed (no refresh possible).
const FIXED_BEARER = params.get("dctoken") || null;

export function getBaseUrl() {
  return BASE_URL;
}

// ---- connectivity status (online / offline / auth-failed) --------------------------------------
const statusListeners = new Set();
let currentStatus = "offline";

function setStatus(next) {
  if (next === currentStatus) return;
  currentStatus = next;
  for (const fn of statusListeners) {
    try { fn(next); } catch { /* listener errors must not break the client */ }
  }
}

/** Subscribe to status transitions. Returns an unsubscribe function. */
export function onStatus(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

export function getStatus() {
  return currentStatus;
}

// ---- auth state ----------------------------------------------------------------------------
let token = null;
let refreshToken = null;

/** POST /api/authenticate — any credentials are accepted by the shim; a real instance would
 * reject bad ones with a non-2xx, which this surfaces as "auth-failed". */
export async function login() {
  if (FIXED_BEARER) {
    token = FIXED_BEARER;
    refreshToken = "";
    setStatus("online");
    return { token, refreshToken };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/api/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      token = null;
      refreshToken = null;
      setStatus("auth-failed");
      throw new Error(`DataConnect auth rejected (${res.status})`);
    }
    if (!res.ok) {
      setStatus("offline");
      throw new Error(`DataConnect authenticate failed: HTTP ${res.status}`);
    }
    const body = await res.json();
    token = body.token;
    refreshToken = body.refreshToken;
    setStatus("online");
    return { token, refreshToken };
  } catch (err) {
    if (err.name === "AbortError") {
      setStatus("offline");
      throw new Error("DataConnect authenticate timed out");
    }
    if (currentStatus !== "auth-failed") setStatus("offline");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** One HTTP round-trip with a 15 s timeout, retrying exactly once (via a fresh login()) on 401. */
async function requestJson(path, { method = "GET", body } = {}, isRetry = false) {
  if (!token) await login();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      setStatus("offline");
      throw new Error(`DataConnect request timed out: ${path}`);
    }
    setStatus("offline");
    throw err;
  }
  clearTimeout(timer);

  if (res.status === 401) {
    if (isRetry) {
      setStatus("auth-failed");
      throw new Error(`DataConnect unauthorized after refresh: ${path}`);
    }
    // refresh-once-on-401: re-authenticate and retry exactly one time.
    token = null;
    await login();
    return requestJson(path, { method, body }, true);
  }
  if (!res.ok) {
    setStatus("offline");
    throw new Error(`DataConnect request failed: HTTP ${res.status} ${path}`);
  }
  setStatus("online");
  return res.json();
}

/**
 * fetchClass(name, {pageSize}) — pages through
 * POST /api/data-mgmt/v1/curated-data/search until `total` items have been collected, or the
 * 100-page guard trips (whichever first). Returns the full flat array of items.
 */
export async function fetchClass(name, { pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const items = [];
  let page = 1;
  let total = Infinity;

  while (items.length < total && page <= MAX_PAGES) {
    const body = await requestJson("/api/data-mgmt/v1/curated-data/search", {
      method: "POST",
      body: { className: name, page, pageSize },
    });
    const pageItems = Array.isArray(body.items) ? body.items : [];
    items.push(...pageItems);
    total = typeof body.total === "number" ? body.total : items.length;
    if (pageItems.length === 0) break; // defensive: an empty page means "no more data"
    page += 1;
  }
  return items;
}
