/**
 * Everything about WHICH OpenProject we read, and what we are allowed to say about it.
 *
 * Constants, in one file, for the same reason the SAP cost configuration is: the decisions that
 * shape what appears on screen — which host, which project, which API paths, what this source is
 * and is not — must be reviewable without reading the adapter, and must not be reachable from a
 * request.
 */

/** The only hosts a credential may be sent to. An env var selects among these and nothing else. */
export const ALLOWED_HOSTS = Object.freeze(['superdnatechnolab.openproject.com']);

export const DEFAULT_BASE_URL = 'https://superdnatechnolab.openproject.com';

/**
 * The API paths, as module constants.
 *
 * NOT built from request data. `workPackage` takes an id, which is validated as digits before it
 * reaches here — an id is the only thing a browser may influence about an upstream URL.
 *
 * `/api/v3/projects/{id}/work_packages` is the project-scoped collection. The Phase 8A brief gave
 * it as `/api/v3/workspaces/3/work_packages`; `workspaces` is not an OpenProject API v3 route and
 * answers 404. The correct segment is `projects`, which is also what `/api/v3/projects/3` uses.
 */
export const API = Object.freeze({
  root: '/api/v3',
  project: id => `/api/v3/projects/${id}`,
  projectWorkPackages: id => `/api/v3/projects/${id}/work_packages`,
  workPackage: id => `/api/v3/work_packages/${id}`,
  workPackageRelations: id => `/api/v3/work_packages/${id}/relations`,
});

/** The API version we speak. Printed on screen, because "v3" is a fact a viewer should see. */
export const API_VERSION = 'v3';

/** The default project. An env var may override the id; it is validated as digits. */
export const DEFAULT_PROJECT_ID = '3';

/**
 * Page size for the work-package collection.
 *
 * OpenProject's default is 20 and its maximum is set per instance. We ask explicitly and then
 * follow `_links.nextByOffset` until the collection is exhausted or `maxPages` is reached — at
 * which point the result is PARTIAL and says so, rather than a short list that looks complete.
 */
export const PAGE_SIZE = 100;
export const MAX_PAGES = 20;

/**
 * The default work-package collection is FILTERED.
 *
 * OpenProject applies a default filter of `status: open` when no `filters` parameter is supplied,
 * so a closed task is simply absent — and absent is indistinguishable from deleted on a screen
 * that does not know this. We always send `filters=[]`, which is OpenProject's documented way of
 * asking for no filter at all, so a completed activity appears with its status.
 */
export const NO_FILTER = '[]';

/** What this source is, stated on every response. */
export const SOURCE = Object.freeze({
  system: 'OPENPROJECT',
  label: 'OpenProject Cloud',
  kind: 'LIVE',
  protocol: 'OpenProject API v3 (HAL+JSON) over HTTPS, Basic auth',
  scope: 'Read-only. No POST, PATCH or DELETE is issued against OpenProject in this phase.',
  /** Said next to every figure, because a live schedule beside synthetic ones invites a merge. */
  notP6: 'This is OpenProject Cloud, not Primavera P6. The P6 records in this demo remain '
    + 'synthetic and are not updated by anything on this screen.',
  notSynchro: 'Reading OpenProject does not update SYNCHRO 4D, P6, SAP or ACC. Nothing here opens '
    + 'a synchronisation run or a write-back proposal.',
});

/**
 * The verified baseline, from the brief.
 *
 * A REGRESSION EXPECTATION, never a displayed value: the screen always shows what the API
 * returned just now, and a difference from this is reported as a difference, not corrected.
 */
export const EXPECTED = Object.freeze({
  projectId: 3,
  projectIdentifier: 'construction',
  projectName: 'Construction',
  workPackageId: '38',
  subject: 'Cast Level 2 Columns',
  type: 'Task',
  status: 'New',
  startDate: '2026-11-12',
  dueDate: '2026-11-18',
  estimatedTime: 'P1DT16H',
  remainingTime: 'P1DT6H',
  percentageDone: 25,
  lockVersion: 1,
});

/** The kinds of change the detector reports. One revision can carry several. */
export const CHANGE = Object.freeze({
  NEW_ACTIVITY: 'NEW_ACTIVITY',
  PROGRESS_CHANGED: 'PROGRESS_CHANGED',
  SCHEDULE_CHANGED: 'SCHEDULE_CHANGED',
  STATUS_CHANGED: 'STATUS_CHANGED',
  WORK_ESTIMATE_CHANGED: 'WORK_ESTIMATE_CHANGED',
  /** The revision moved but no tracked business field did. Recorded as what it is. */
  METADATA_ONLY: 'METADATA_ONLY',
  UNCHANGED: 'UNCHANGED',
  /** A business field moved while the revision did not — the source contradicts itself. */
  SOURCE_CONFLICT: 'SOURCE_CONFLICT',
  REMOVED: 'REMOVED',
});

/** Which changes are worth persisting as events. UNCHANGED is a fact, not an event. */
export const EVENTFUL = Object.freeze([
  CHANGE.NEW_ACTIVITY, CHANGE.PROGRESS_CHANGED, CHANGE.SCHEDULE_CHANGED, CHANGE.STATUS_CHANGED,
  CHANGE.WORK_ESTIMATE_CHANGED, CHANGE.METADATA_ONLY, CHANGE.SOURCE_CONFLICT, CHANGE.REMOVED,
]);

/** The mapping lifecycle. Nothing may be compared until it is APPROVED. */
export const MAPPING = Object.freeze({
  UNMAPPED: 'UNMAPPED',
  PROPOSED: 'PROPOSED',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CONFLICT: 'CONFLICT',
});

/** The permission a session needs to decide a schedule-source link. The planner owns the schedule. */
export const LINK_PERMISSION = 'approve:SCHEDULE_LINK';

/**
 * Why a comparison is not a verdict.
 *
 * Shown with every OpenProject-versus-P6 percentage difference. The two numbers are produced by
 * different systems against different baselines with different progress semantics, and a reader
 * who takes the difference as a construction finding has been misled by arithmetic that is
 * correct.
 */
export const COMPARISON_CAVEAT =
  'OpenProject reports the percentage a planner typed against its own baseline; the synthetic P6 '
  + 'figure is this demo\'s seeded planned progress against a different baseline. The difference '
  + 'is a difference between two sources, not a measurement of the work, and it is not evidence '
  + 'of a schedule slip or a defect.';

/* ── Phase 8B: automatic synchronisation ───────────────────────────────────────────────────── */

/**
 * What opened a synchronisation run.
 *
 * Stored on every row, because "the schedule changed overnight" and "somebody pressed Sync Now"
 * are different stories about the same numbers, and a reader who cannot tell them apart cannot
 * say whether the poller is working.
 */
export const TRIGGER = Object.freeze({
  /** The one run the worker makes as the backend comes up, when enabled. */
  STARTUP: 'STARTUP',
  /** The interval timer. */
  SCHEDULED: 'SCHEDULED',
  /** Sync Now, or POST /openproject/sync/run. */
  MANUAL: 'MANUAL',
});

/**
 * What became of a run.
 *
 * A separate vocabulary from the adapter's connection `STATE`, with one value no connection can
 * produce: SKIPPED is a cycle that never asked because another was still in flight.
 */
export const RUN_STATUS = Object.freeze({
  SUCCESS: 'SUCCESS',
  /** A real, usable read that is known to be incomplete. Never flattened to success or failure. */
  PARTIAL: 'PARTIAL',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
});

/**
 * The polling interval, in seconds.
 *
 * 60 is the brief's figure. The floor is 15 s: OpenProject Cloud is a shared, rate-limited service
 * and a 1-second interval configured by a typo would be indistinguishable from an attack on it.
 * The ceiling is a day, which is a bound rather than a judgement.
 */
export const SYNC_INTERVAL = Object.freeze({ default: 60, min: 15, max: 86_400 });

/**
 * How long after a failed cycle the next one may start, by consecutive-failure count.
 *
 * BACKOFF ON THE SCHEDULE, not retries inside a cycle. A cycle already walks the collection once
 * with its own bounded timeouts; retrying inside it would stack several minutes of HTTP inside a
 * 60-second slot. Instead a failed cycle makes the NEXT one wait longer, which is the same bounded
 * backoff spread over the schedule the operator configured.
 *
 * AUTH_FAILED is not in here at all — see `backoffFor`. Retrying a rejected credential every
 * minute cannot fix it and does look like a brute-force attempt from the far end.
 */
export const BACKOFF_MULTIPLIER = Object.freeze([1, 2, 4, 8, 15]);

/** The ceiling on a `Retry-After` the far end asks for, so one header cannot park the worker. */
export const MAX_RETRY_AFTER_SECONDS = 900;
