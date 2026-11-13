/** The construction API, in one place. Errors carry the server's own words. */
export const API = '/api/construction';

/**
 * The demo session token.
 *
 * The SERVER decides what a session may do; this only carries the token. A role put in a request
 * body is ignored, which is the point of the change — see server/construction/auth.mjs.
 */
let sessionToken = null;
export const setSessionToken = token => { sessionToken = token ?? null; };
export const getSessionToken = () => sessionToken;

export async function request(path, { method = 'GET', body } = {}) {
  const headers = {
    ...(body ? { 'content-type': 'application/json' } : {}),
    ...(sessionToken ? { 'x-demo-session': sessionToken } : {}),
  };
  const response = await fetch(`${API}${path}`, {
    method,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error ?? `HTTP ${response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

export const escape = value => String(value ?? '').replace(/[&<>"]/g,
  character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));

/** An absent figure is a dash. `Number(null)` is 0 and finite, so the null check comes first. */
export const num = value => (value == null || !Number.isFinite(Number(value))
  ? '—' : Number(value).toLocaleString('en-US'));

export function when(iso) {
  if (!iso) return 'Never';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'Unknown'
    : date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

/** The app's tone vocabulary: ok / warn / bad / info. Never colour alone — each carries a word. */
export const TONE = Object.freeze({
  COMPLETE: 'ok', PASS: 'ok', RESOLVED: 'ok',
  NEEDS_SELECTION: 'warn', WARN: 'warn', WARNING: 'warn', UNDER_REVIEW: 'warn',
  AWAITING_CORRECTION: 'warn', READY_FOR_REVALIDATION: 'warn',
  INCOMPLETE: 'bad', FAIL: 'bad', ERROR: 'bad', OPEN: 'bad',
  EXCLUDED: 'info',
});
export const toneOf = value => TONE[value] ?? 'info';

/** Who the operator is acting as, read from the nav's own role control. */
export const currentRole = () => document.body.dataset.role ?? 'integrationLead';

/**
 * A server session for the role the person has chosen in the navigation.
 *
 * Until Phase 10B only the Approval Center ever asked for one, because it was the only screen
 * whose actions the server gated. Creating a work package is also gated — and is the first action
 * that reaches a system outside this demo — so the role shown in the corner has to be the role
 * the server is enforcing, not a label beside an unauthenticated request.
 *
 * Idempotent and deduplicated: concurrent callers share one in-flight request, and a session
 * already held for this role is reused rather than re-minted. The role still comes from a
 * server-issued token; this only saves the person a second control to operate.
 */
let sessionRole = null;
let issuing = null;
export function ensureSession(role = currentRole()) {
  if (sessionToken && sessionRole === role) return Promise.resolve(sessionRole);
  if (issuing) return issuing;
  issuing = request('/session', { method: 'POST', body: { role } })
    .then(issued => { setSessionToken(issued.token); sessionRole = issued.role; return issued.role; })
    .catch(() => { setSessionToken(null); sessionRole = null; return null; })
    .finally(() => { issuing = null; });
  return issuing;
}

/** Forget the session, so the next gated action mints one for whatever role is current. */
export function clearSession() { setSessionToken(null); sessionRole = null; }
export const ROLE_NAMES = Object.freeze({
  integrationLead: 'Integration Lead', planner: 'Project Planner (P6)',
  bimCoordinator: 'BIM Coordinator', financeController: 'Finance Controller',
});
export const roleName = id => ROLE_NAMES[id] ?? id;
