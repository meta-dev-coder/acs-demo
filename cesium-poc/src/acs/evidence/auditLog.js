/**
 * The audit trail for evidence recovery.
 *
 * Every retrieval attempt, every source response, every match the engine proposed, every decision
 * a reviewer took and every validation status change lands here. Append-only: an entry is never
 * edited or removed, because the point of the log is that it records what happened rather than
 * what the case looks like now.
 *
 * In-memory and per session. These are demonstration records and are deliberately not written
 * anywhere a production system could read them.
 */

export const AUDIT_EVENTS = Object.freeze({
  SEARCH_STARTED: 'SEARCH_STARTED',
  SOURCE_RESPONSE: 'SOURCE_RESPONSE',
  MATCH_PROPOSED: 'MATCH_PROPOSED',
  REVIEWER_DECISION: 'REVIEWER_DECISION',
  EVIDENCE_ATTACHED: 'EVIDENCE_ATTACHED',
  VALIDATION_CHANGED: 'VALIDATION_CHANGED',
  BLOCKED_BY_POLICY: 'BLOCKED_BY_POLICY',
});

/**
 * @param {{now?: () => number, actor?: string}} [options]
 *   `actor` is who the log attributes a reviewer decision to. There is no identity service in this
 *   deployment, so it is a stated placeholder rather than a name the log pretends to know.
 */
export function createAuditLog({ now = () => Date.now(), actor = 'Demo reviewer (this session)' } = {}) {
  const entries = [];
  let sequence = 0;

  function record(event, caseId, detail, fields = {}) {
    sequence += 1;
    const entry = Object.freeze({
      sequence,
      at: new Date(now()).toISOString(),
      caseId: caseId ?? null,
      event,
      detail,
      actor: event === AUDIT_EVENTS.REVIEWER_DECISION ? actor : 'Evidence recovery engine',
      ...fields,
    });
    entries.push(entry);
    return entry;
  }

  return {
    record,
    /** Everything logged, oldest first. A copy, so a caller cannot edit the history. */
    all: () => Object.freeze([...entries]),
    forCase: caseId => Object.freeze(entries.filter(entry => entry.caseId === caseId)),
    get size() { return entries.length; },
  };
}
