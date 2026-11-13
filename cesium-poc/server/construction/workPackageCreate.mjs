/**
 * Creating a work package in a system that has no idempotency key.
 *
 * Everything hard about this feature is that last clause. The happy path — validate, POST, read
 * the id back — is a dozen lines. What the rest of this file exists for is the question the happy
 * path cannot answer: WE SENT A POST AND HEARD NOTHING BACK. DID IT CREATE ONE?
 *
 * OpenProject offers no header, no client-supplied id and no "create if absent" semantics, so
 * there is no way to ask it that question directly. The answer here has three parts:
 *
 *   1. A LEDGER ROW WRITTEN BEFORE THE REQUEST LEAVES. `work_package_creation` holds the attempt,
 *      keyed by an idempotency key the client supplies. The key is UNIQUE, so the second of two
 *      concurrent submissions loses a database constraint rather than winning a second task.
 *
 *   2. A MARKER INSIDE THE DESCRIPTION. Each attempt carries a short unguessable id that is
 *      written into the work package's own description. It is the only property of the created
 *      record that we choose and the source preserves verbatim, which makes it the one thing we
 *      can search for afterwards. `description ~ <marker>` is a filter this instance supports.
 *
 *   3. A REFUSAL TO GUESS. If the POST times out, the state becomes OUTCOME_UNKNOWN and the only
 *      move offered is RECONCILE — go and look for the marker. Never an automatic retry. A retry
 *      is how one timeout becomes two work packages, and a duplicate in somebody's real schedule
 *      is far worse than a row that needs a human glance.
 *
 * The other rule worth stating: THIS IS NOT A TASK TABLE. The created work package is cached in
 * `live_schedule_snapshot` through the same upsert the background sync uses, keyed on the same
 * primary key, so the next sync cycle updates that row rather than adding a second one. The
 * ledger holds our attempts; OpenProject holds the work packages.
 */
import { randomUUID } from 'node:crypto';
import { FAILURE, STATE } from './openProjectHttp.mjs';
import { cacheActivity, transact } from './openProjectStore.mjs';
import { parseIsoDuration } from './openProjectDuration.mjs';
import { recordAudit } from './sync.mjs';

/** The permission a session needs. New: nothing existing covered creating a source record. */
export const CREATE_PERMISSION = 'create:WORK_PACKAGE';

/**
 * Where an attempt can be.
 *
 * OUTCOME_UNKNOWN is the one that matters. It is not a failure — a failure means nothing was
 * created — and it is not a success. It means the question is open, and the UI must say so in
 * those words rather than picking the cheerier or the safer of the two.
 */
export const CREATION_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  PENDING: 'PENDING',
  CREATING: 'CREATING',
  CREATED: 'CREATED',
  RECONCILING: 'RECONCILING',
  RECONCILED: 'RECONCILED',
  FAILED: 'FAILED',
  OUTCOME_UNKNOWN: 'OUTCOME_UNKNOWN',
});

/** Did the source store what we asked for? Checked by reading it back, never assumed. */
export const RECONCILIATION = Object.freeze({
  PENDING: 'PENDING',
  MATCHED: 'MATCHED',
  DIFFERS: 'DIFFERS',
  UNCHECKED: 'UNCHECKED',
});

/** The BIM half of a Workflow-B creation, which can fail on its own. */
export const MAPPING_STATE = Object.freeze({
  NOT_REQUESTED: 'NOT_REQUESTED',
  PENDING: 'PENDING',
  PROPOSED: 'PROPOSED',
  FAILED: 'FAILED',
});

/** A terminal attempt answers for itself; a repeat of its key returns it rather than re-sending. */
const SETTLED = new Set([CREATION_STATUS.CREATED, CREATION_STATUS.RECONCILED,
  CREATION_STATUS.FAILED, CREATION_STATUS.OUTCOME_UNKNOWN]);

/**
 * Has this attempt finished, one way or another?
 *
 * CREATING is deliberately NOT settled. A caller that finds a request mid-flight should join it
 * and report the real outcome — answering "already submitted" with a row that has no work-package
 * id yet is true but useless, and it is what the second of two near-simultaneous clicks saw.
 */
export const isSettled = status => SETTLED.has(status);

const nowIso = () => new Date().toISOString();
const text = value => (value == null ? null : String(value));
const json = value => (value == null ? null : JSON.stringify(value));
const parse = value => { try { return value == null ? null : JSON.parse(value); } catch { return null; } };

/**
 * The marker written into the description.
 *
 * Prefixed so a person reading the work package in OpenProject can tell what it is, and random
 * enough that it cannot collide with prose. It is not a secret: it identifies a request, grants
 * nothing, and is visible to anyone who can already see the work package.
 */
export const markerFor = (key = randomUUID()) => `acs-create-${String(key).replace(/[^a-zA-Z0-9-]/g, '')}`;

/** How the marker appears in the description. One line, at the end, clearly machine-written. */
export const markerLine = marker =>
  `\n\n---\nCreated from the Construction Digital Twin · reference ${marker}`;

/**
 * Validate what the browser sent, before OpenProject ever sees it.
 *
 * NOT a replacement for the source's validation — OpenProject's rules are OpenProject's to state,
 * and the form endpoint is asked for them on every submission. This catches the things that are
 * wrong regardless of any instance's configuration, so an obviously empty form does not cost a
 * round trip, and refuses anything outside the field allowlist so a crafted body cannot reach the
 * source with a property this feature never meant to set.
 */
export const ALLOWED_FIELDS = Object.freeze(['subject', 'description', 'startDate', 'dueDate',
  'estimatedHours', 'typeId', 'statusId', 'priorityId', 'assigneeId', 'parentId',
  'percentageDone']);

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateRequest(input = {}) {
  const errors = {};
  const unknown = Object.keys(input).filter(key => !ALLOWED_FIELDS.includes(key));
  if (unknown.length) {
    errors.$form = `These fields cannot be set from here: ${unknown.join(', ')}.`;
  }
  const subject = String(input.subject ?? '').trim();
  if (!subject) errors.subject = 'A task name is required.';
  else if (subject.length > 255) errors.subject = 'A task name may be at most 255 characters.';

  for (const [field, label] of [['startDate', 'Start date'], ['dueDate', 'Finish date']]) {
    const value = input[field];
    if (value == null || value === '') continue;
    if (!DATE.test(String(value))) errors[field] = `${label} must be a date (YYYY-MM-DD).`;
  }
  // Checked here as well as at the source: the source's message is the one shown, but a form that
  // only learns this from a round trip feels broken.
  if (!errors.startDate && !errors.dueDate && input.startDate && input.dueDate
    && String(input.dueDate) < String(input.startDate)) {
    errors.dueDate = 'Finish date must be on or after the start date.';
  }

  const hours = input.estimatedHours;
  if (hours != null && hours !== '') {
    // `Number('')` is 0 and finite, so the blank check has to come first — it is not an estimate
    // of zero hours, it is no estimate.
    const value = Number(hours);
    if (!Number.isFinite(value) || value <= 0) {
      errors.estimatedHours = 'Estimated effort must be a number of hours greater than zero.';
    } else if (value > 100_000) {
      errors.estimatedHours = 'Estimated effort must be under 100,000 hours.';
    }
  }
  for (const field of ['typeId', 'statusId', 'priorityId', 'assigneeId', 'parentId']) {
    const value = input[field];
    if (value == null || value === '') continue;
    if (!/^\d{1,9}$/.test(String(value))) errors[field] = 'Must be a whole number.';
  }
  const pct = input.percentageDone;
  if (pct != null && pct !== '') {
    const value = Number(pct);
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      errors.percentageDone = 'Progress must be a whole number between 0 and 100.';
    }
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * The HAL payload OpenProject wants, built from a validated request.
 *
 * `estimatedTime` goes out as an ISO 8601 duration in HOURS (`PT80H`). OpenProject normalizes it
 * to its own form on the way back — 80 hours returns as `P3DT8H` — which is why reconciliation
 * below compares PARSED HOURS and never the two strings.
 */
export function buildPayload(input, { marker, projectId }) {
  const payload = {
    subject: String(input.subject).trim(),
    _links: {
      project: { href: `/api/v3/projects/${projectId}` },
      type: { href: `/api/v3/types/${input.typeId ?? 1}` },
    },
  };
  const body = String(input.description ?? '').trim();
  payload.description = { format: 'markdown', raw: `${body}${markerLine(marker)}` };
  if (input.startDate) payload.startDate = String(input.startDate);
  if (input.dueDate) payload.dueDate = String(input.dueDate);
  if (input.estimatedHours != null && input.estimatedHours !== '') {
    payload.estimatedTime = `PT${Number(input.estimatedHours)}H`;
  }
  if (input.percentageDone != null && input.percentageDone !== '') {
    payload.percentageDone = Number(input.percentageDone);
  }
  for (const [field, resource] of [['statusId', 'statuses'], ['priorityId', 'priorities'],
    ['assigneeId', 'users'], ['parentId', 'work_packages']]) {
    const value = input[field];
    if (value == null || value === '') continue;
    const name = { statusId: 'status', priorityId: 'priority', assigneeId: 'assignee',
      parentId: 'parent' }[field];
    payload._links[name] = { href: `/api/v3/${resource}/${value}` };
  }
  return payload;
}

/**
 * Did OpenProject store what we asked for?
 *
 * Compares the CONFIRMED record against the REQUEST. Durations are compared as hours, because the
 * source rewrites the string: we send `PT80H` and it returns `P3DT8H`, which is the same eighty
 * hours on the ISO nominal basis and a different string on any basis. Comparing text here would
 * report every single task as differing.
 *
 * A difference is reported, never corrected. OpenProject is authoritative: if it decided a
 * different start date because of its own scheduling rules, that is the truth and our request was
 * the approximation.
 */
export function reconcile(requested, confirmed) {
  const differences = [];
  const compare = (field, want, got, format = String) => {
    if (want == null || want === '') return;
    if (String(got ?? '') !== String(want)) {
      differences.push({ field, requested: format(want), stored: got == null ? null : format(got) });
    }
  };
  compare('subject', String(requested.subject ?? '').trim(), confirmed?.activityName);
  compare('startDate', requested.startDate, confirmed?.plannedStart);
  compare('dueDate', requested.dueDate, confirmed?.plannedFinish);

  if (requested.estimatedHours != null && requested.estimatedHours !== '') {
    const want = Number(requested.estimatedHours);
    // The stored hours, parsed on the same basis the rest of the app reports — not the raw string.
    const stored = confirmed?.estimatedHours != null ? Number(confirmed.estimatedHours)
      : parseIsoDuration(confirmed?.estimatedTimeRaw)?.hours ?? null;
    if (stored == null || Math.abs(stored - want) > 0.01) {
      differences.push({ field: 'estimatedTime', requested: `${want} h`,
        stored: stored == null ? null : `${stored} h`,
        note: stored == null ? null
          : 'OpenProject normalises a duration to its own ISO 8601 form; this compares hours.' });
    }
  }
  if (requested.percentageDone != null && requested.percentageDone !== '') {
    compare('percentageDone', Number(requested.percentageDone), confirmed?.reportedProgressPct);
  }
  return { status: differences.length ? RECONCILIATION.DIFFERS : RECONCILIATION.MATCHED,
    differences };
}

/* ── the ledger ───────────────────────────────────────────────────────────────────────────── */

const SHAPE = row => (row == null ? null : {
  id: row.id,
  idempotencyKey: row.idempotency_key,
  marker: row.marker,
  status: row.status,
  projectId: row.project_id,
  workPackageId: row.work_package_id,
  sourceUrl: row.source_url,
  lockVersion: row.lock_version,
  requested: parse(row.requested),
  expected: parse(row.expected),
  confirmed: parse(row.confirmed),
  reconciliation: row.reconciliation,
  reconciliationDetail: parse(row.reconciliation_detail),
  endpoint: row.endpoint,
  httpStatus: row.http_status,
  failure: row.failure,
  fieldErrors: parse(row.field_errors) ?? {},
  error: row.error,
  bimContext: parse(row.bim_context),
  mappingStatus: row.mapping_status,
  mappingDetail: parse(row.mapping_detail),
  actor: row.actor,
  actorRole: row.actor_role,
  correlationId: row.correlation_id,
  createdAt: row.created_at,
  sentAt: row.sent_at,
  confirmedAt: row.confirmed_at,
  updatedAt: row.updated_at,
  attempts: row.attempts,
});

export function creationByKey(db, key) {
  return SHAPE(db.prepare('SELECT * FROM work_package_creation WHERE idempotency_key = ?')
    .get(String(key)));
}

export function creationById(db, id) {
  return SHAPE(db.prepare('SELECT * FROM work_package_creation WHERE id = ?').get(Number(id)));
}

export function creations(db, { limit = 50, status = null } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM work_package_creation WHERE status = ? ORDER BY id DESC LIMIT ?')
      .all(String(status), Number(limit))
    : db.prepare('SELECT * FROM work_package_creation ORDER BY id DESC LIMIT ?').all(Number(limit));
  return rows.map(SHAPE);
}

/** Attempts a person still has to resolve. The only list the UI must never let fall silent. */
export function unresolved(db) {
  return db.prepare(`SELECT * FROM work_package_creation
     WHERE status IN (?, ?) OR (status = ? AND mapping_status = ?) ORDER BY id DESC`)
    .all(CREATION_STATUS.OUTCOME_UNKNOWN, CREATION_STATUS.CREATING,
      CREATION_STATUS.RECONCILED, MAPPING_STATE.FAILED)
    .map(SHAPE);
}

const update = (db, id, fields) => {
  const entries = Object.entries({ ...fields, updated_at: nowIso() });
  db.prepare(`UPDATE work_package_creation SET ${entries.map(([k]) => `${k} = ?`).join(', ')}
     WHERE id = ?`).run(...entries.map(([, v]) => v), Number(id));
};

/**
 * Claim an idempotency key, or report who already holds it.
 *
 * The claim is a transaction containing the uniqueness check AND the insert, so two requests that
 * arrive together cannot both pass the check. The UNIQUE constraint is the real guarantee; the
 * SELECT exists to turn a second click into a civil answer rather than a constraint error.
 */
export function claim(db, { idempotencyKey, requested, bimContext = null, actor, actorRole = null,
  projectId, correlationId = randomUUID(), sourceSystem = 'OPENPROJECT' }) {
  const key = String(idempotencyKey ?? '').trim();
  if (!key) return { ok: false, error: 'An idempotency key is required.' };
  return transact(db, () => {
    const existing = db.prepare('SELECT * FROM work_package_creation WHERE idempotency_key = ?')
      .get(key);
    if (existing) return { ok: true, created: false, creation: SHAPE(existing) };
    const at = nowIso();
    const marker = markerFor(key);
    const info = db.prepare(`INSERT INTO work_package_creation (idempotency_key, marker, status,
        source_system, project_id, requested, bim_context, mapping_status, actor, actor_role,
        correlation_id, created_at, updated_at, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
      .run(key, marker, CREATION_STATUS.PENDING, sourceSystem, String(projectId),
        json(requested), json(bimContext),
        bimContext ? MAPPING_STATE.PENDING : MAPPING_STATE.NOT_REQUESTED,
        actor, actorRole, correlationId, at, at);
    return { ok: true, created: true,
      creation: SHAPE(db.prepare('SELECT * FROM work_package_creation WHERE id = ?')
        .get(Number(info.lastInsertRowid))) };
  });
}

/**
 * Run one creation attempt to its conclusion.
 *
 * @param {object} deps `adapter` is the OpenProject adapter; `onCreated` is called with the
 *   confirmed activity so the caller can propose BIM mappings WITHOUT this function knowing
 *   anything about Speckle. The mapping half is allowed to fail on its own, and does not undo a
 *   created work package — there is no way to un-create one, and pretending otherwise by deleting
 *   it would be a far more destructive answer than a flag asking somebody to look.
 */
/**
 * Attempts in flight in THIS process, so a second click awaits the first answer.
 *
 * The conditional UPDATE below is what prevents a duplicate; this is what makes the second click
 * useful. Without it the loser returns the row as it looked mid-flight — status CREATING, no id —
 * and a browser that fired twice would show "created" with nothing to open. Here it waits for the
 * same promise and gets the same work package.
 *
 * In-process only, and that is the honest limit: across two backend processes the UPDATE still
 * guarantees one POST, and the loser is told to look again rather than being made to wait.
 */
const IN_FLIGHT = new Map();

export function runCreation(db, creationId, options) {
  const id = Number(creationId);
  const running = IN_FLIGHT.get(id);
  if (running) return running;
  const promise = attemptCreation(db, id, options).finally(() => IN_FLIGHT.delete(id));
  IN_FLIGHT.set(id, promise);
  return promise;
}

async function attemptCreation(db, creationId, { adapter, actor, onCreated = null }) {
  const row = creationById(db, creationId);
  if (!row) return { ok: false, error: `No creation request ${creationId}.` };
  if (SETTLED.has(row.status)) {
    // Already answered. A refresh, a double submit or a retry of a settled attempt returns what
    // happened; it never sends a second POST.
    return { ok: true, repeat: true, creation: row };
  }

  /*
   * TAKE THE ATTEMPT, ATOMICALLY, BEFORE DOING ANYTHING ELSE.
   *
   * The status check above is necessary and not sufficient: two requests that arrive together
   * both read PENDING, both pass it, and both POST. One work package per click is not a property
   * of the read - it is a property of this conditional UPDATE, which only one of them can win,
   * because SQLite serialises it. The loser gets the winner's row back.
   *
   * Found by a test that ran two submissions concurrently and counted the POSTs. The ledger row
   * alone did not prevent the duplicate; this does.
   */
  const taken = db.prepare(`UPDATE work_package_creation SET status = ?, sent_at = ?,
       attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = ?`)
    .run(CREATION_STATUS.CREATING, nowIso(), nowIso(), Number(creationId), CREATION_STATUS.PENDING);
  if (taken.changes !== 1) {
    return { ok: true, repeat: true, creation: creationById(db, creationId),
      note: 'Another submission of this request is already in flight or has finished.' };
  }

  const requested = row.requested ?? {};
  const payload = buildPayload(requested, { marker: row.marker, projectId: row.projectId });

  /* Validate at the source first. The form endpoint creates nothing, so a rejected form costs a
     round trip and no record — which is the whole reason to ask before posting. */
  const form = await adapter.workPackageForm(payload);
  if (form.state !== STATE.CONNECTED) {
    update(db, row.id, { status: CREATION_STATUS.FAILED, failure: form.failure,
      http_status: form.httpStatus ?? null, error: form.reason,
      field_errors: json(form.fieldErrors ?? {}) });
    audit(db, { actor, row, event: 'WORK_PACKAGE_CREATE_FAILED', result: form.reason });
    return { ok: false, creation: creationById(db, row.id), reason: form.reason };
  }
  if (!form.valid) {
    update(db, row.id, { status: CREATION_STATUS.FAILED, failure: FAILURE.VALIDATION,
      http_status: form.httpStatus ?? null, field_errors: json(form.fieldErrors),
      error: 'OpenProject rejected the values.' });
    audit(db, { actor, row, event: 'WORK_PACKAGE_CREATE_REJECTED',
      result: Object.entries(form.fieldErrors).map(([f, m]) => `${f}: ${m}`).join('; ') });
    return { ok: false, creation: creationById(db, row.id), fieldErrors: form.fieldErrors };
  }

  /* The row has said CREATING since before the form call. What the form adds is the EXPECTATION
     — what OpenProject said it would store — and the commit path it told us to use. */
  update(db, row.id, { expected: json(form.payload), endpoint: form.commit });

  const result = await adapter.createWorkPackage(payload, { path: form.commit });

  if (result.outcomeUnknown) {
    /* The request left and no answer came back. NOT a failure and NOT a success. No retry is
       offered from here: the only safe next move is to look for the marker. */
    update(db, row.id, { status: CREATION_STATUS.OUTCOME_UNKNOWN, failure: result.failure,
      error: result.reason, endpoint: result.endpoint ?? form.commit });
    audit(db, { actor, row, event: 'WORK_PACKAGE_CREATE_OUTCOME_UNKNOWN', result: result.reason });
    return { ok: false, outcomeUnknown: true, creation: creationById(db, row.id) };
  }
  if (result.state !== STATE.CONNECTED || !result.created) {
    update(db, row.id, { status: CREATION_STATUS.FAILED, failure: result.failure,
      http_status: result.httpStatus ?? null, error: result.reason,
      field_errors: json(result.fieldErrors ?? {}) });
    audit(db, { actor, row, event: 'WORK_PACKAGE_CREATE_FAILED', result: result.reason });
    return { ok: false, creation: creationById(db, row.id), reason: result.reason,
      fieldErrors: result.fieldErrors ?? {} };
  }

  return settle(db, row.id, { activity: result.created, adapter, actor, onCreated,
    httpStatus: result.httpStatus, endpoint: result.endpoint });
}

/**
 * Record a confirmed creation: cache it, reconcile it, propose its mappings, audit it.
 *
 * Shared by the normal path and by reconciliation of an unknown outcome, because what has to
 * happen once a work package is known to exist is the same either way.
 */
async function settle(db, creationId, { activity, adapter, actor, onCreated, httpStatus = null,
  endpoint = null }) {
  const row = creationById(db, creationId);
  const requested = row.requested ?? {};

  /* Re-read from the source rather than trusting the create response. They agree in practice;
     the point is that the record we reconcile and cache is one the source served as its own
     current state, not one we were handed as a side effect of writing. */
  const reread = await adapter.workPackage(activity.externalActivityId, { withRelations: false });
  const confirmed = reread.state === STATE.CONNECTED && reread.activity
    ? reread.activity : activity;

  const check = reconcile(requested, confirmed);
  cacheActivity(db, { projectId: row.projectId, activity: confirmed, actor });

  update(db, creationId, {
    status: CREATION_STATUS.RECONCILED,
    work_package_id: String(confirmed.externalActivityId),
    source_url: confirmed.sourceUrl ?? null,
    lock_version: Number.isFinite(Number(confirmed.sourceRevision))
      ? Number(confirmed.sourceRevision) : null,
    confirmed: json(confirmed),
    reconciliation: check.status,
    reconciliation_detail: json(check.differences),
    http_status: httpStatus,
    endpoint,
    confirmed_at: nowIso(),
    failure: null,
    error: null,
  });
  audit(db, { actor, row, event: 'WORK_PACKAGE_CREATED',
    subject: `OPENPROJECT:${confirmed.externalActivityId}`,
    result: `Work package #${confirmed.externalActivityId} created and read back; `
      + `reconciliation ${check.status}`,
    detail: { workPackageId: String(confirmed.externalActivityId), endpoint,
      differences: check.differences, marker: row.marker } });

  /* The BIM half. Separate on purpose: a mapping that cannot be saved must not cast doubt on a
     work package that exists, and must never be retried by creating another one. */
  if (onCreated && row.bimContext) {
    try {
      const mapping = await onCreated({ creation: creationById(db, creationId), activity: confirmed });
      update(db, creationId, {
        mapping_status: mapping?.ok ? MAPPING_STATE.PROPOSED : MAPPING_STATE.FAILED,
        mapping_detail: json(mapping ?? { ok: false, error: 'The mapping step returned nothing.' }),
      });
    } catch (error) {
      update(db, creationId, { mapping_status: MAPPING_STATE.FAILED,
        mapping_detail: json({ ok: false, error: String(error?.message ?? error) }) });
    }
  }
  return { ok: true, creation: creationById(db, creationId), reconciliation: check };
}

/**
 * Resolve an attempt whose outcome is unknown, by LOOKING rather than by sending.
 *
 * Three answers, and the third is allowed to be "still unknown". Reporting that honestly is the
 * point of the whole mechanism: an attempt that cannot be resolved stays visible and waits for a
 * person, because the alternative — guessing "not created" and offering a retry — is precisely
 * how a duplicate ends up in somebody's real schedule.
 */
export async function reconcileUnknown(db, creationId, { adapter, actor, onCreated = null }) {
  const row = creationById(db, creationId);
  if (!row) return { ok: false, error: `No creation request ${creationId}.` };
  if (row.workPackageId) {
    return { ok: true, resolved: true, creation: row, note: 'Already resolved.' };
  }
  if (row.status !== CREATION_STATUS.OUTCOME_UNKNOWN
    && row.status !== CREATION_STATUS.CREATING) {
    return { ok: true, resolved: false, creation: row,
      note: `Nothing to reconcile: this attempt is ${row.status}.` };
  }
  update(db, creationId, { status: CREATION_STATUS.RECONCILING });

  const found = await adapter.findByMarker(row.marker);
  if (found.state !== STATE.CONNECTED) {
    update(db, creationId, { status: CREATION_STATUS.OUTCOME_UNKNOWN, error: found.reason });
    return { ok: false, resolved: false, creation: creationById(db, creationId),
      reason: `The source could not be searched for the marker, so the outcome is still `
        + `unknown: ${found.reason}` };
  }
  if (found.matches.length === 1) {
    const settled = await settle(db, creationId,
      { activity: found.matches[0], adapter, actor, onCreated });
    audit(db, { actor, row, event: 'WORK_PACKAGE_CREATE_RECONCILED',
      result: `The marker was found on work package #${found.matches[0].externalActivityId}; `
        + 'the request had in fact succeeded.' });
    return { ...settled, resolved: true, outcome: 'CREATED' };
  }
  if (found.matches.length === 0) {
    /* Nothing carries this marker, so nothing was created. The attempt may now be retried —
       the KEY is spent, so a retry is a new request, which is the only kind that is safe. */
    update(db, creationId, { status: CREATION_STATUS.FAILED,
      error: 'The request was sent but no work package carries its reference, so nothing was '
        + 'created. It is safe to submit a new one.' });
    audit(db, { actor, row, event: 'WORK_PACKAGE_CREATE_RECONCILED',
      result: 'No work package carries the marker; nothing was created.' });
    return { ok: true, resolved: true, outcome: 'NOT_CREATED',
      creation: creationById(db, creationId) };
  }
  /* More than one. Two work packages share a marker that was generated for one request, which
     should be impossible — so this is reported, not resolved. Choosing one would be a guess. */
  update(db, creationId, { status: CREATION_STATUS.OUTCOME_UNKNOWN,
    error: `${found.matches.length} work packages carry this request's reference `
      + `(${found.matches.map(m => `#${m.externalActivityId}`).join(', ')}). `
      + 'That should not be possible, so this needs a person to look.' });
  return { ok: false, resolved: false, outcome: 'AMBIGUOUS',
    creation: creationById(db, creationId),
    matches: found.matches.map(m => String(m.externalActivityId)) };
}

/** Retry only the BIM mapping. Never touches OpenProject, so it cannot create a second task. */
export async function retryMapping(db, creationId, { actor, onCreated }) {
  const row = creationById(db, creationId);
  if (!row) return { ok: false, error: `No creation request ${creationId}.` };
  if (!row.workPackageId) {
    return { ok: false, error: 'This request has no confirmed work package, so there is nothing '
      + 'to map. Reconcile it first.' };
  }
  if (!row.bimContext) return { ok: false, error: 'This task was not created from BIM elements.' };
  update(db, creationId, { mapping_status: MAPPING_STATE.PENDING });
  try {
    const mapping = await onCreated({ creation: row, activity: row.confirmed });
    update(db, creationId, {
      mapping_status: mapping?.ok ? MAPPING_STATE.PROPOSED : MAPPING_STATE.FAILED,
      mapping_detail: json(mapping ?? { ok: false, error: 'The mapping step returned nothing.' }),
    });
    audit(db, { actor, row, event: 'WORK_PACKAGE_MAPPING_RETRIED',
      result: mapping?.ok ? 'Mapping proposals saved.' : 'Mapping failed again.' });
    return { ok: Boolean(mapping?.ok), creation: creationById(db, creationId), mapping };
  } catch (error) {
    update(db, creationId, { mapping_status: MAPPING_STATE.FAILED,
      mapping_detail: json({ ok: false, error: String(error?.message ?? error) }) });
    return { ok: false, creation: creationById(db, creationId),
      error: String(error?.message ?? error) };
  }
}

function audit(db, { actor, row, event, subject = null, result = null, detail = null }) {
  recordAudit(db, { actor, event,
    subject: subject ?? `CREATE_REQUEST:${row.idempotencyKey}`,
    correlationId: row.correlationId,
    result,
    detail: { ...(detail ?? {}), creationId: row.id, marker: row.marker,
      projectId: row.projectId,
      note: 'A creation request against the live OpenProject instance. The request body is '
        + 'recorded; no credential is.' } });
}
