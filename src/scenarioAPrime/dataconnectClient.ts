/*---------------------------------------------------------------------------------------------
 * DataConnect (Cohesive/Bentley) API client — TS port of cesium-poc/src/dataconnect.js, adapted
 * to a factory (createDataConnectClient) rather than a module-level singleton so this can be
 * constructed per resolved base URL and safely exercised in a node-env vitest run (no reliance
 * on a global `location` at import time, unlike the standalone cesium-poc script it's ported
 * from — this module runs inside a React SPA where the base URL is resolved by dataSource.ts).
 *
 * Speaks the SAME three endpoints the live demo instance (dataconnect-demo-dqa3.cohesivecloud.app)
 * exposes, so a client built here can point at tools/dataconnect_shim.py (local stand-in) or the
 * real instance with only a base-URL + credentials change:
 *
 *   POST /api/authenticate                       -> {token, refreshToken}
 *   GET  /api/data-mgmt/v1/class                  -> {classes:[{name, recordCount}, ...]}
 *   POST /api/data-mgmt/v1/curated-data/search    -> {items, page, pageSize, total}
 *
 * Failure semantics are "keep-previous-on-failure" (src/data/loader.ts's pattern): this client
 * never touches any UI/store state itself — it only reports connectivity via onStatus()
 * callbacks ("online" | "offline" | "auth-failed") and throws on failure. Callers (dataSource.ts)
 * are responsible for keeping the last-good scored data untouched when a fetch throws.
 *--------------------------------------------------------------------------------------------*/

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PAGES = 100; // hard guard: pagination must never loop forever, even on a buggy server.
const DEFAULT_PAGE_SIZE = 200;

export type DcStatus = "online" | "offline" | "auth-failed";

export interface DataConnectClient {
  getBaseUrl(): string;
  getStatus(): DcStatus;
  onStatus(fn: (status: DcStatus) => void): () => void;
  login(): Promise<{ token: string; refreshToken: string }>;
  fetchClass(name: string, opts?: { pageSize?: number }): Promise<unknown[]>;
}

interface DcAuthResponse {
  token: string;
  refreshToken: string;
}
interface DcSearchResponse {
  items?: unknown[];
  total?: number;
}

/** Build one client bound to a base URL + credentials. Each client owns its own token/status —
 *  no module-level singleton state, so multiple instances (or repeated test runs) never leak
 *  auth state into each other. */
export function createDataConnectClient(
  baseUrl: string,
  credentials: { username?: string; password?: string; bearerToken?: string } = {}
): DataConnectClient {
  const BASE_URL = baseUrl.replace(/\/$/, "");
  const USERNAME = credentials.username || "demo";
  const PASSWORD = credentials.password || "demo";
  // Pre-acquired bearer token (e.g. a Bentley IMS OIDC access token): the production
  // DataConnect deployment authenticates via IMS — its /api/authenticate returns 404 — so when a
  // token is supplied we skip login() entirely and cannot refresh (a 401 is terminal auth-failed).
  const FIXED_BEARER = credentials.bearerToken || null;

  const statusListeners = new Set<(status: DcStatus) => void>();
  let currentStatus: DcStatus = "offline";
  let token: string | null = null;
  let refreshToken: string | null = null;

  function setStatus(next: DcStatus): void {
    if (next === currentStatus) return;
    currentStatus = next;
    for (const fn of statusListeners) {
      try {
        fn(next);
      } catch {
        /* listener errors must not break the client */
      }
    }
  }

  /** POST /api/authenticate — any credentials are accepted by the shim; a real instance would
   * reject bad ones with a non-2xx, which this surfaces as "auth-failed". */
  async function login(): Promise<{ token: string; refreshToken: string }> {
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
      const body = (await res.json()) as DcAuthResponse;
      token = body.token;
      refreshToken = body.refreshToken;
      setStatus("online");
      return { token, refreshToken };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
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
  async function requestJson<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
    isRetry = false
  ): Promise<T> {
    if (!token) await login();

    const { method = "GET", body } = init;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
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
      if (err instanceof Error && err.name === "AbortError") {
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
      return requestJson<T>(path, init, true);
    }
    if (!res.ok) {
      setStatus("offline");
      throw new Error(`DataConnect request failed: HTTP ${res.status} ${path}`);
    }
    setStatus("online");
    return res.json() as Promise<T>;
  }

  /**
   * fetchClass(name, {pageSize}) — pages through
   * POST /api/data-mgmt/v1/curated-data/search until `total` items have been collected, or the
   * 100-page guard trips (whichever first). Returns the full flat array of items.
   */
  async function fetchClass(name: string, opts: { pageSize?: number } = {}): Promise<unknown[]> {
    const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    const items: unknown[] = [];
    let page = 1;
    let total = Infinity;

    while (items.length < total && page <= MAX_PAGES) {
      const body = await requestJson<DcSearchResponse>("/api/data-mgmt/v1/curated-data/search", {
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

  return {
    getBaseUrl: () => BASE_URL,
    getStatus: () => currentStatus,
    onStatus(fn: (status: DcStatus) => void) {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    login,
    fetchClass,
  };
}
