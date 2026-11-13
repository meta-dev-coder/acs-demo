/**
 * Demo authorization. Read this before relying on it for anything.
 *
 * WHAT THIS APPLICATION HAD: nothing. A caller put {"actorRole": "planner"} in the request body
 * and the server believed it, so the role check in Phase 3 stopped an honest UI from doing the
 * wrong thing and stopped nothing else. The screen's role dropdown was, in effect, the whole
 * access-control system.
 *
 * WHAT THIS IS: the role now comes from a server-issued token, so a request body can no longer
 * assert one. Every decision is recorded against the session that made it.
 *
 * WHAT THIS IS NOT: authentication. There is no identity provider in this deployment, so anyone
 * who can reach the API can mint a session for any role — `issueSession` asks for no credential
 * and refuses nobody. It is a demonstration control and every response says so.
 *
 * Wiring a real IdP later is a change to `issueSession` and `sessionFor`, and to nothing above
 * them: the rest of the server only ever asks "what role is this request acting as?"
 */
import { randomUUID } from 'node:crypto';

export const DEMO_AUTH = Object.freeze({
  production: false,
  mechanism: 'DEMO_SESSION_TOKEN',
  note: 'Demonstration authorization only. Sessions are issued on request with no credential '
    + 'check, because this deployment has no identity provider. The role is bound to a '
    + 'server-issued token rather than taken from the request body, and every decision is '
    + 'recorded against it — but this is not authentication and must not be described as such.',
});

/** The roles a session may hold. The same four the construction navigation offers. */
export const ROLES = Object.freeze({
  integrationLead: { label: 'Integration Lead',
    may: ['monitor', 'investigate', 'retry', 'prepare', 'submit', 'approve:SCHEDULE_LINK',
      'approve:BIM_MAPPING', 'create:WORK_PACKAGE'] },
  planner: { label: 'Project Planner (P6)',
    may: ['monitor', 'investigate', 'prepare', 'submit', 'approve:INT-02',
      'approve:SCHEDULE_LINK', 'approve:BIM_MAPPING', 'create:WORK_PACKAGE'] },
  /*
   * The BIM Coordinator may now PROPOSE and APPROVE a BIM-element-to-activity mapping.
   *
   * Phase 9C gave `approve:SCHEDULE_LINK` to the Integration Lead and the Planner and left this
   * role read-only, which made the person whose job it is the one person who could not do it.
   * Deciding whether an IFC element is the thing an activity builds is a BIM judgement, so it
   * belongs here. It still grants nothing over the SCHEDULE itself: no `approve:INT-02`, so a
   * progress write-back to OpenProject remains the Planner's alone.
   */
  /*
   * The BIM Coordinator may decide a BIM MAPPING, and only that.
   *
   * Phase 9C reused `approve:SCHEDULE_LINK` for two different judgements: whether a live
   * OpenProject activity corresponds to a synthetic P6 one (a SCHEDULE judgement) and whether an
   * IFC element is the thing an activity builds (a BIM judgement). One permission for both meant
   * the person whose job the second is could do neither. They are separate now, so this role can
   * approve element mappings without gaining any say over the schedule.
   */
  /*
   * `create:WORK_PACKAGE` is DELIBERATELY ABSENT HERE.
   *
   * Phase 10B lets a task be created from selected BIM geometry, and the mapping it proposes must
   * be approved by a BIM Coordinator. Giving this role the power to create the task as well would
   * make one person the proposer and the approver of the same link, which is the separation the
   * mapping workflow exists to enforce. They approve what a Planner or the Integration Lead
   * created; they do not create it.
   */
  bimCoordinator: { label: 'BIM Coordinator',
    may: ['monitor', 'investigate', 'prepare', 'submit', 'approve:BIM_MAPPING'] },
  financeController: { label: 'Finance Controller',
    may: ['monitor', 'investigate', 'prepare', 'submit', 'approve:INT-05'] },
});

/** Who may approve each outbound interface. One place, so the two can never drift together. */
export const APPROVER_ROLE = Object.freeze({ 'INT-02': 'planner', 'INT-05': 'financeController' });

const EIGHT_HOURS = 8 * 60 * 60 * 1000;

/**
 * Mint a demo session.
 *
 * Refuses nobody — that is the honest shape of a demo control with no IdP behind it — but the
 * role must be one that exists, so a typo cannot create an unknown authority.
 */
export function issueSession(db, { role, actor = null, now = () => Date.now() } = {}) {
  if (!Object.hasOwn(ROLES, role ?? '')) {
    return { ok: false,
      error: `"${role}" is not a construction role. The roles are: ${Object.keys(ROLES).join(', ')}.` };
  }
  const at = now();
  const token = randomUUID();
  db.prepare(`INSERT INTO demo_session (token, role, actor, created_at, expires_at, note)
     VALUES (?, ?, ?, ?, ?, ?)`)
    .run(token, role, actor || `${ROLES[role].label} (demo session)`,
      new Date(at).toISOString(), new Date(at + EIGHT_HOURS).toISOString(), DEMO_AUTH.note);
  return { ok: true, token, role, label: ROLES[role].label, demo: DEMO_AUTH };
}

/** The session behind a request, or null. Expired sessions are not sessions. */
export function sessionFor(db, token, { now = () => Date.now() } = {}) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM demo_session WHERE token = ?').get(String(token));
  if (!row) return null;
  if (Date.parse(row.expires_at) <= now()) return null;
  return row;
}

/**
 * Whether this session may do this, as a value rather than a thrown error.
 *
 * `approve:INT-02` and `approve:INT-05` are separate permissions and no role holds both, which is
 * the separation the proposal asks for: the planner owns the schedule and Finance owns the money.
 *
 * `approve:SCHEDULE_LINK` (Phase 8A) decides whether a live OpenProject activity may be compared
 * against a synthetic P6 one. It is the planner's and the Integration Lead's, for the same reason
 * INT-02 is the planner's: it is a statement about the schedule. It authorises a READ-ONLY
 * comparison — nothing is written to either system — but it is still a judgement about whether two
 * records describe the same work, so it is not something the BIM Coordinator's read-only session
 * may make.
 */
export function may(session, permission) {
  if (!session) return false;
  return (ROLES[session.role]?.may ?? []).includes(permission);
}

/** The refusal, in words a screen can print. Never "forbidden" with no explanation. */
export function refusal(session, permission) {
  if (!session) {
    return 'No demo session. Choose a role first — the server takes the role from the session, '
      + 'not from the request.';
  }
  const holders = Object.entries(ROLES)
    .filter(([, spec]) => spec.may.includes(permission)).map(([id]) => ROLES[id].label);
  return `${ROLES[session.role].label} may not ${permission.replace(':', ' ')}. `
    + (holders.length ? `That is the ${holders.join(' or ')}.` : 'No role holds that permission.');
}
