/**
 * The browser's half of DataConnect.
 *
 * It never holds a token: every call goes to this app's own origin, where the server attaches the
 * credentials (server/dataConnect.mjs). That keeps the token out of the bundle, out of the browser
 * and out of any log, and avoids a CORS round trip to the DataConnect host.
 *
 * Failures are told apart rather than lumped together, because they need different answers: an
 * expired sign-in is not a missing class, and neither is a service that is down.
 */

export const DC_ERRORS = Object.freeze({
  UNCONFIGURED: 'unconfigured', AUTH: 'auth', FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not-found', SERVICE: 'service', TIMEOUT: 'timeout', NETWORK: 'network',
  EXPIRED: 'expired',
});

export class DataConnectError extends Error {
  constructor(kind, message, { status = null, missing = [] } = {}) {
    super(message);
    this.name = 'DataConnectError';
    this.kind = kind;
    this.status = status;
    this.missing = missing;
  }
  /** What a person should be told, in a KPI card or a panel. */
  get note() {
    return {
      [DC_ERRORS.UNCONFIGURED]: 'Not configured',
      [DC_ERRORS.AUTH]: 'Sign-in required',
      [DC_ERRORS.EXPIRED]: 'Session expired',
      [DC_ERRORS.FORBIDDEN]: 'Access denied',
      [DC_ERRORS.NOT_FOUND]: 'Class not found',
      [DC_ERRORS.SERVICE]: 'DataConnect error',
      [DC_ERRORS.TIMEOUT]: 'Timed out — still loading upstream',
      [DC_ERRORS.NETWORK]: 'Service unreachable',
    }[this.kind] ?? 'Failed to load';
  }
}

const BASE = '/api/dataconnect';

const errorFor = (status, body) => {
  if (status === 503 && body?.missing) return new DataConnectError(DC_ERRORS.UNCONFIGURED, 'DataConnect is not configured.', { status, missing: body.missing });
  // An expired token is a different situation from a missing one, and the fix is different too.
  if (status === 401 && body?.code === 'token_expired') return new DataConnectError(DC_ERRORS.EXPIRED, body?.error ?? 'The access token has expired.', { status });
  if (status === 401) return new DataConnectError(DC_ERRORS.AUTH, 'DataConnect sign-in failed or expired.', { status });
  if (status === 403) return new DataConnectError(DC_ERRORS.FORBIDDEN, 'This account cannot read that DataConnect class.', { status });
  if (status === 404) return new DataConnectError(DC_ERRORS.NOT_FOUND, 'DataConnect class or endpoint not found.', { status });
  // 504 is this app's own timeout upstream, not a broken class: the largest classes are simply slow.
  if (status === 504) return new DataConnectError(DC_ERRORS.TIMEOUT, 'DataConnect did not answer in time.', { status });
  return new DataConnectError(DC_ERRORS.SERVICE, body?.error ?? `DataConnect returned ${status}.`, { status });
};

async function request(path, options) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, options);
  } catch (cause) {
    throw new DataConnectError(DC_ERRORS.NETWORK, 'Could not reach DataConnect.', {});
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw errorFor(response.status, body);
  return body;
}

/** Whether the server has what it needs, and what is missing when it does not. */
/**
 * Start an interactive sign-in and wait for it to finish.
 *
 * The popup is opened by the CALLER, synchronously inside the click, because a window opened after
 * an await is a pop-up blocker's definition of unsolicited. This only points it at the authority
 * and then polls the server, which is where the code exchange and the token actually live.
 *
 * @param {Window|null} popup  the already-open window to send to the authority
 */
export async function signIn(popup) {
  const { url } = await request('/signin/start', { method: 'POST' });
  if (popup) popup.location.href = url;
  else window.open(url, '_blank', 'noopener');

  // Poll until the server says it has a credential, the popup is closed, or we give up.
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1200));
    const state = await status().catch(() => null);
    if (state?.authenticated) return state;
    if (state && !state.signInPending) {
      // The flow finished without producing a credential — report what the server saw.
      throw new DataConnectError(DC_ERRORS.AUTH, state.lastSignIn?.message ?? 'Sign-in did not complete.', {});
    }
    if (popup?.closed && !state?.signInPending) break;
  }
  await request('/signin/cancel', { method: 'POST' }).catch(() => {});
  throw new DataConnectError(DC_ERRORS.AUTH, 'Sign-in did not complete.', {});
}

export const status = () => request('/status', { method: 'GET' });

/** Every class the account can see — the list class ids are discovered from. */
export const listClasses = async () => (await request('/classes', { method: 'GET' })).classes ?? [];

/**
 * Every record of one class, following `totalCount` across pages.
 *
 * @param {string} classId
 * @param {{pageSize?: number, filters?: unknown[], maxPages?: number,
 *          onPage?: (info: {page: number, received: number, totalCount: number}) => void}} [options]
 * @returns {Promise<{records: object[], totalCount: number}>}
 */
export async function getCuratedData(classId, { pageSize = 500, filters = [], maxPages = 100, onPage } = {}) {
  const records = [];
  let page = 0, totalCount = 0;
  for (; page < maxPages; page++) {
    const payload = await request(`/class/${encodeURIComponent(classId)}/curated-data`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page, pageSize, filters }),
    });
    const batch = payload?.data ?? [];
    totalCount = Number(payload?.totalCount ?? batch.length);
    records.push(...batch);
    onPage?.({ page, received: batch.length, totalCount });
    // A short page or a satisfied total means there is nothing more to ask for.
    if (!batch.length || records.length >= totalCount || batch.length < pageSize) break;
  }
  return { records, totalCount: totalCount || records.length };
}
