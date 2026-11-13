/**
 * The OpenProject read adapter: HAL+JSON in, one normalized schedule out.
 *
 * Read-only, and not in `adapterMap`. That is deliberate and it is the same decision taken for the
 * two SAP clients: `adapterMap` is what `runInboundSync` iterates, so a real HTTP client in it
 * would mean "Run Demo Sync" reaching the internet and writing live records into the normalized
 * SYNCHRO tables. Nothing read here is ever written into an integration table.
 *
 * What it will not do:
 *
 *  - it will not infer a parent or a dependency from a name, a date or an id. Hierarchy comes from
 *    `_links.parent` and dependencies from the relations API, or they are reported as absent.
 *  - it will not equate a work estimate with calendar duration. `estimatedTime` is an amount of
 *    work; the dates are the schedule; they are separate fields and stay separate.
 *  - it will not present a short collection as a whole one. A walk that stops early is PARTIAL.
 *  - it will not read the default collection and call it the project's work packages: OpenProject
 *    filters to open statuses unless told otherwise, so `filters=[]` is always sent.
 */
import {
  API, API_VERSION, DEFAULT_PROJECT_ID, MAX_PAGES, NO_FILTER, PAGE_SIZE, SOURCE,
} from './openProjectConfig.mjs';
import {
  FAILURE, LIMITS, STATE, createOpenProjectClient, parseId,
} from './openProjectHttp.mjs';
import { BASIS, basisFor, corroborate, parseIsoDuration } from './openProjectDuration.mjs';

export { FAILURE, STATE };

/** A HAL `_links` title, which is where OpenProject puts the human-readable name of a relation. */
const linkTitle = link => (typeof link?.title === 'string' ? link.title : null);

/**
 * The numeric id at the end of a HAL self/parent href.
 *
 * `/api/v3/work_packages/38` → `'38'`. Returns null rather than a guess: an id we cannot read must
 * not become a link to the wrong record.
 */
export function idFromHref(href) {
  const match = /\/api\/v3\/[a-z_]+\/(\d+)(?:$|[/?])/.exec(String(href ?? ''));
  return match ? match[1] : null;
}

/** An ISO date, with the time dropped. OpenProject's `startDate`/`dueDate` are date-only already. */
const dateOnly = value => {
  const text = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
};

/** A percentage, or null. `Number(null)` is 0 and finite, so the null check comes first. */
const percent = value => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * One HAL work package, normalized.
 *
 * Source values are PRESERVED alongside the normalized ones (`estimatedTimeRaw`, `source`), because
 * reconciliation against OpenProject has to be able to quote what OpenProject actually said.
 */
export function normalizeWorkPackage(row, {
  projectId, projectIdentifier = null, projectName = null, duration = null,
} = {}) {
  const links = row?._links ?? {};
  const selfHref = typeof links.self?.href === 'string' ? links.self.href : null;
  const id = String(row?.id ?? idFromHref(selfHref) ?? '').trim() || null;
  const basis = duration ?? { hoursPerDay: 24, basis: BASIS.ISO_8601_NOMINAL };

  const estimated = parseIsoDuration(row?.estimatedTime, basis);
  const remaining = parseIsoDuration(row?.remainingTime, basis);
  const reportedProgressPct = percent(row?.percentageDone);

  const parentHref = typeof links.parent?.href === 'string' ? links.parent.href : null;

  return {
    sourceSystem: SOURCE.system,
    sourceProjectId: projectId == null ? null : Number(projectId),
    sourceProjectIdentifier: projectIdentifier,
    sourceProjectName: projectName,
    externalActivityId: id,
    activityName: typeof row?.subject === 'string' ? row.subject : null,
    activityType: linkTitle(links.type),
    status: linkTitle(links.status),
    /** The schedule. Separate from the work estimate, and never derived from it. */
    plannedStart: dateOnly(row?.startDate),
    plannedFinish: dateOnly(row?.dueDate),
    /** OpenProject's own scheduling `duration` field, in days, when it is present. */
    scheduledDurationDays: Number.isFinite(Number(row?.duration)) ? Number(row.duration)
      : (parseIsoDuration(row?.duration, basis)?.components?.days ?? null),
    reportedProgressPct,
    /**
     * Time actually logged against the work package.
     *
     * READ-ONLY in OpenProject — it is derived from time entries, not a field anybody may set,
     * which the schema confirms (`spentTime.writable === false`). Captured because the lifecycle
     * header reports it, and flagged here so no write-back path ever tries to send it.
     */
    spentTimeRaw: typeof row?.spentTime === 'string' ? row.spentTime : null,
    spentHours: parseIsoDuration(row?.spentTime, basis)?.hours ?? null,
    /** The amount of WORK. Raw string first, converted second, basis always attached. */
    estimatedTimeRaw: estimated?.raw ?? null,
    estimatedHours: estimated?.hours ?? null,
    remainingTimeRaw: remaining?.raw ?? null,
    remainingHours: remaining?.hours ?? null,
    durationBasis: basis.basis,
    hoursPerDay: basis.hoursPerDay,
    /** OpenProject's own arithmetic, used as a check on the basis and nothing else. */
    durationCheck: corroborate({ estimated, remaining, percentDone: reportedProgressPct }),
    /** `lockVersion` is OpenProject's optimistic-locking counter: our source revision. */
    sourceRevision: Number.isFinite(Number(row?.lockVersion)) ? Number(row.lockVersion) : null,
    sourceUpdatedAt: typeof row?.updatedAt === 'string' ? row.updatedAt : null,
    sourceCreatedAt: typeof row?.createdAt === 'string' ? row.createdAt : null,
    /** From `_links.parent` only. Never inferred from a dotted code, a date or id ordering. */
    parentExternalId: idFromHref(parentHref),
    parentName: linkTitle(links.parent),
    assignee: linkTitle(links.assignee),
    description: typeof row?.description?.raw === 'string' ? row.description.raw.slice(0, 2_000)
      : null,
    /** Filled from the relations API when asked for; `null` means "not fetched", `[]` means none. */
    dependencies: null,
    sourceUrl: selfHref ?? (id ? API.workPackage(id) : null),
    /** Where a person opens it. Built from the instance origin, not from a returned link. */
    sourcePath: id ? `/work_packages/${id}` : null,
    warnings: [estimated?.warning, remaining?.warning].filter(Boolean),
  };
}

/** One HAL project, normalized. */
export function normalizeProject(row) {
  return {
    id: row?.id == null ? null : Number(row.id),
    identifier: typeof row?.identifier === 'string' ? row.identifier : null,
    name: typeof row?.name === 'string' ? row.name : null,
    active: typeof row?.active === 'boolean' ? row.active : null,
    public: typeof row?.public === 'boolean' ? row.public : null,
    createdAt: typeof row?.createdAt === 'string' ? row.createdAt : null,
    updatedAt: typeof row?.updatedAt === 'string' ? row.updatedAt : null,
  };
}

/**
 * The adapter.
 *
 * @param {{env?, fetchImpl?, logger?}} [options] a test supplies its own `fetchImpl` and `env` and
 *   never touches the network.
 */
export function createOpenProjectAdapter({
  env = process.env, fetchImpl = globalThis.fetch, logger = console,
} = {}) {
  const client = createOpenProjectClient({ env, fetchImpl, logger });

  /** The configured project, validated. An unreadable value is a configuration failure, not a 404. */
  const projectId = () => parseId(env.OPENPROJECT_PROJECT_ID ?? DEFAULT_PROJECT_ID);

  /** Shared by every result, so no screen has to guess what it is looking at. */
  const envelope = () => ({
    source: SOURCE,
    apiVersion: API_VERSION,
    instance: client.baseUrl().ok ? client.baseUrl().baseUrl : null,
    configuredProjectId: projectId(),
    requestedAt: new Date().toISOString(),
    /** No interface id. This is not one of the five pilot interfaces and must not be filed as one. */
    interfaceId: null,
  });

  const configFailure = () => ({
    ...envelope(), state: STATE.CONNECTION_FAILED, failure: FAILURE.CONFIG, httpStatus: null,
    reason: `OPENPROJECT_PROJECT_ID must be a whole number; got `
      + `"${String(env.OPENPROJECT_PROJECT_ID ?? '')}".`,
    elapsedMs: null, warnings: [],
  });

  /**
   * The instance's working-day length, if it will tell us.
   *
   * Cached per process after the first successful read. A failure here is NOT a failure of
   * anything else: the basis falls back to the ISO 8601 nominal day and says so, which is the
   * honest outcome, so this never turns a readable schedule into an error.
   */
  let durationBasis = null;
  async function basis() {
    if (durationBasis) return durationBasis;
    const outcome = await client.get(`${API.root}/configuration`);
    if (outcome.state !== STATE.CONNECTED) {
      // Not cached: the next call may succeed, and reporting "assumed" forever after one blip
      // would understate what we know.
      return basisFor(null);
    }
    durationBasis = basisFor(outcome.body);
    return durationBasis;
  }

  /** Authentication and reachability, at the cost of one small request. */
  async function health() {
    const id = projectId();
    if (!id) return configFailure();
    const outcome = await client.get(API.project(id));
    return {
      ...envelope(),
      state: outcome.state,
      failure: outcome.failure,
      httpStatus: outcome.httpStatus,
      reason: outcome.reason,
      elapsedMs: outcome.elapsedMs,
      retryAfterSeconds: outcome.retryAfterSeconds ?? null,
      project: outcome.state === STATE.CONNECTED ? normalizeProject(outcome.body) : null,
      warnings: [],
    };
  }

  /** The project header. */
  async function project() {
    const result = await health();
    if (result.state !== STATE.CONNECTED) return result;
    const warnings = [];
    if (result.project?.id != null && String(result.project.id) !== String(projectId())) {
      warnings.push({ kind: 'PROJECT_MISMATCH', subject: String(result.project.id),
        detail: `Asked for project ${projectId()} and OpenProject answered with `
          + `${result.project.id}.` });
    }
    return { ...result, warnings };
  }

  /**
   * Every work package in the project, following OpenProject's own next-page links.
   *
   * `total` (what the collection holds) and `returned` (what we have) are reported SEPARATELY and
   * never reconciled by truncation. If the walk stops early, the state is PARTIAL.
   */
  async function workPackages({ pageSize = PAGE_SIZE, maxPages = MAX_PAGES } = {}) {
    const id = projectId();
    if (!id) return { ...configFailure(), activities: [], total: null, returned: 0, pages: 0 };

    const basisUsed = await basis();
    const warnings = [];
    const rows = [];
    let path = API.projectWorkPackages(id);
    let query = { pageSize, offset: 1, filters: NO_FILTER };
    let total = null;
    let pageSizeSeen = null;
    let pages = 0;
    let httpStatus = null;
    let elapsedMs = 0;
    let truncated = false;

    for (;;) {
      const page = await client.collection(path, query, { timeout: LIMITS.collectionTimeoutMs });
      httpStatus = page.httpStatus;
      elapsedMs += page.elapsedMs ?? 0;
      if (page.state !== STATE.CONNECTED) {
        // A first page that fails is a failure. A LATER page that fails leaves us holding real
        // rows that are genuinely incomplete — which is PARTIAL, not success and not failure.
        if (pages === 0) {
          return { ...envelope(), state: page.state, failure: page.failure,
            httpStatus: page.httpStatus, reason: page.reason, elapsedMs,
            /** Carried through so the WORKER can honour it; nothing here waits. */
            retryAfterSeconds: page.retryAfterSeconds ?? null,
            activities: [], total: null, returned: 0, pages: 0, warnings, duration: basisUsed };
        }
        warnings.push({ kind: 'PAGE_FAILED', subject: `page ${pages + 1}`,
          detail: `Page ${pages + 1} could not be read (${page.reason ?? page.state}). The `
            + `${rows.length} activities already read are shown and the collection is incomplete.` });
        truncated = true;
        break;
      }
      pages += 1;
      rows.push(...page.elements);
      total = page.total ?? total;
      pageSizeSeen = page.pageSize ?? pageSizeSeen;

      const next = client.safeApiPath(page.nextHref);
      if (page.nextHref && !next) {
        warnings.push({ kind: 'UNSAFE_NEXT_LINK', subject: String(page.nextHref).slice(0, 120),
          detail: 'OpenProject returned a next-page link outside the allowlisted instance API. It '
            + 'was not followed, so the collection is incomplete.' });
        truncated = true;
        break;
      }
      if (!next) break;
      if (pages >= maxPages) {
        warnings.push({ kind: 'PAGE_LIMIT', subject: String(maxPages),
          detail: `Stopped after ${maxPages} pages. OpenProject reports ${total ?? 'an unknown '
            + 'number of'} work packages and ${rows.length} were read.` });
        truncated = true;
        break;
      }
      path = next;
      query = {};
    }

    const header = await project();
    const activities = rows.map(row => normalizeWorkPackage(row, {
      projectId: id,
      projectIdentifier: header.project?.identifier ?? null,
      projectName: header.project?.name ?? null,
      duration: basisUsed,
    }));

    const missingId = activities.filter(entry => !entry.externalActivityId).length;
    if (missingId) {
      warnings.push({ kind: 'MISSING_ID', subject: String(missingId),
        detail: `${missingId} work package(s) arrived without a readable id and cannot be tracked `
          + 'for changes.' });
    }
    if (total != null && !truncated && rows.length !== total) {
      warnings.push({ kind: 'COUNT_MISMATCH', subject: `${rows.length} of ${total}`,
        detail: `OpenProject reports ${total} work packages in the collection but ${rows.length} `
          + 'were returned across the pages walked.' });
      truncated = true;
    }
    for (const entry of activities) {
      for (const warning of entry.warnings) {
        warnings.push({ kind: 'DURATION_UNREADABLE', subject: entry.externalActivityId,
          detail: warning });
      }
    }

    return {
      ...envelope(),
      state: truncated ? STATE.PARTIAL : STATE.CONNECTED,
      failure: null,
      httpStatus,
      reason: truncated ? 'The collection is incomplete; see the warnings.' : null,
      elapsedMs,
      project: header.project ?? null,
      activities,
      /** What OpenProject says the collection holds. */
      total,
      /** What we actually have. Never the same field as `total`. */
      returned: activities.length,
      pages,
      pageSize: pageSizeSeen,
      filtersApplied: [{ name: 'filters', value: NO_FILTER,
        reason: 'OpenProject filters the work-package collection to open statuses when no filter '
          + 'is given, so a completed activity would be silently absent. An empty filter list asks '
          + 'for every status.' }],
      duration: basisUsed,
      warnings,
    };
  }

  /** One work package, with its relations. */
  async function workPackage(rawId, { withRelations = true } = {}) {
    const id = parseId(rawId);
    if (!id) {
      return { ...envelope(), state: STATE.CONNECTION_FAILED, failure: FAILURE.CONFIG,
        httpStatus: null, reason: 'A work-package id must be a whole number.', elapsedMs: null,
        activity: null, warnings: [] };
    }
    const basisUsed = await basis();
    const outcome = await client.get(API.workPackage(id));
    if (outcome.state !== STATE.CONNECTED) {
      return { ...envelope(), state: outcome.state, failure: outcome.failure,
        httpStatus: outcome.httpStatus, reason: outcome.reason, elapsedMs: outcome.elapsedMs,
        activity: null, warnings: [] };
    }

    const header = await project();
    const activity = normalizeWorkPackage(outcome.body, {
      projectId: projectId(),
      projectIdentifier: header.project?.identifier ?? null,
      projectName: header.project?.name ?? null,
      duration: basisUsed,
    });
    const warnings = activity.warnings.map(detail => ({ kind: 'DURATION_UNREADABLE',
      subject: activity.externalActivityId, detail }));

    if (withRelations) {
      const relations = await client.collection(API.workPackageRelations(id));
      if (relations.state === STATE.CONNECTED) {
        activity.dependencies = relations.elements.map(relation => ({
          type: typeof relation?.type === 'string' ? relation.type : null,
          reverseType: typeof relation?.reverseType === 'string' ? relation.reverseType : null,
          lag: relation?.lag ?? null,
          description: typeof relation?.description === 'string' ? relation.description : null,
          fromExternalId: idFromHref(relation?._links?.from?.href),
          toExternalId: idFromHref(relation?._links?.to?.href),
        })).filter(entry => entry.fromExternalId || entry.toExternalId);
      } else {
        // Left as null — "not known" — rather than [] which would read as "no dependencies".
        warnings.push({ kind: 'RELATIONS_UNAVAILABLE', subject: id,
          detail: `The relations for work package ${id} could not be read `
            + `(${relations.reason ?? relations.state}), so its dependencies are shown as unknown `
            + 'rather than as none.' });
      }
    }

    return { ...envelope(), state: STATE.CONNECTED, failure: null, httpStatus: outcome.httpStatus,
      reason: null, elapsedMs: outcome.elapsedMs, project: header.project ?? null, activity,
      duration: basisUsed, warnings };
  }

  /**
   * The create endpoints, as THIS instance reports them.
   *
   * Not a constant, because the published examples are wrong for this server. OpenProject 17.9
   * answers `GET /api/v3/projects/3` with
   *
   *     createWorkPackage:            POST /api/v3/workspaces/3/work_packages/form
   *     createWorkPackageImmediately: POST /api/v3/workspaces/3/work_packages
   *
   * — `workspaces`, not `projects` — and the form's own `_links.commit` points somewhere else
   * again. Hardcoding any one of the three would work until the instance was upgraded. So the
   * paths are read from the project resource, and every href goes through `safeApiPath`, which
   * keeps a redirected or misconfigured instance from being handed the credential.
   *
   * The ABSENCE of these links is the permission answer: OpenProject omits `createWorkPackage`
   * for a user who may not create one, so this doubles as the capability check and needs no
   * speculative POST to discover it.
   */
  async function createEndpoints() {
    const id = projectId();
    if (!id) return { ...configFailure(), endpoints: null };
    const outcome = await client.get(API.project(id));
    if (outcome.state !== STATE.CONNECTED) {
      return { ...envelope(), state: outcome.state, failure: outcome.failure,
        httpStatus: outcome.httpStatus, reason: outcome.reason, elapsedMs: outcome.elapsedMs,
        endpoints: null, warnings: [] };
    }
    const links = outcome.body?._links ?? {};
    const form = client.safeApiPath(links.createWorkPackage?.href);
    const create = client.safeApiPath(links.createWorkPackageImmediately?.href);
    if (!form || !create) {
      return { ...envelope(), state: STATE.CONNECTED, failure: FAILURE.CONFIG,
        httpStatus: outcome.httpStatus, elapsedMs: outcome.elapsedMs, endpoints: null,
        reason: 'This OpenProject project does not offer a work-package creation link to the '
          + 'configured token, which is how OpenProject reports that the user may not create one. '
          + 'Grant the token\'s user the "Add work packages" permission on the project.',
        warnings: [] };
    }
    return { ...envelope(), state: STATE.CONNECTED, failure: null,
      httpStatus: outcome.httpStatus, elapsedMs: outcome.elapsedMs, reason: null,
      endpoints: { form, create }, warnings: [] };
  }

  /**
   * Validate a payload WITHOUT creating anything.
   *
   * OpenProject's form endpoint is defined as non-mutating: it answers 200 with the payload it
   * would have used, the schema that applies, and `_embedded.validationErrors` keyed by
   * attribute. That is the whole reason a create form can show the source's own messages instead
   * of a guess at its rules — and it means every field decision in this feature was settled
   * without writing a record.
   */
  async function workPackageForm(payload) {
    const found = await createEndpoints();
    if (!found.endpoints) return { ...found, valid: false, fieldErrors: {}, payload: null,
      schema: null, commit: null };
    const outcome = await client.post(found.endpoints.form, payload);
    if (outcome.state !== STATE.CONNECTED) {
      return { ...envelope(), state: outcome.state, failure: outcome.failure,
        httpStatus: outcome.httpStatus, reason: outcome.reason, elapsedMs: outcome.elapsedMs,
        valid: false, fieldErrors: outcome.fieldErrors ?? {}, payload: null, schema: null,
        commit: null, warnings: [] };
    }
    const body = outcome.body;
    const raw = body?._embedded?.validationErrors ?? {};
    // The form answers 200 whether or not the values are acceptable, so "valid" is the emptiness
    // of this map and never the status code.
    const fieldErrors = Object.fromEntries(Object.entries(raw)
      .filter(([, value]) => typeof value?.message === 'string')
      .map(([field, value]) => [field, value.message]));
    return { ...envelope(), state: STATE.CONNECTED, failure: null,
      httpStatus: outcome.httpStatus, reason: null, elapsedMs: outcome.elapsedMs,
      valid: Object.keys(fieldErrors).length === 0,
      fieldErrors,
      /** What OpenProject says it WOULD store — already normalized, so this is the expectation
       *  reconciliation compares against rather than what we sent. */
      payload: body?._embedded?.payload ?? null,
      schema: body?._embedded?.schema ?? null,
      /** The server's own instruction for where to commit it. Followed, not assumed. */
      commit: client.safeApiPath(body?._links?.commit?.href) ?? found.endpoints.create,
      warnings: [] };
  }

  /**
   * Create one work package. THIS WRITES TO THE LIVE INSTANCE.
   *
   * `path` is the commit link a prior `workPackageForm()` returned, so the caller has already
   * seen the validation answer for this exact payload and the creation is not a guess.
   *
   * The outcome distinguishes three things a caller must never confuse: created (an id came
   * back), refused (OpenProject said no, nothing exists), and UNKNOWN (the request was sent and
   * no answer arrived). `sent` carries the last of those up from the HTTP layer, because a
   * timed-out POST may have created the record and retrying it is how duplicates are made.
   */
  async function createWorkPackage(payload, { path = null } = {}) {
    let commit = path ? client.safeApiPath(path) : null;
    if (!commit) {
      const found = await createEndpoints();
      if (!found.endpoints) return { ...found, created: null, outcomeUnknown: false,
        fieldErrors: {} };
      commit = found.endpoints.create;
    }
    const basisUsed = await basis();
    const outcome = await client.post(commit, payload);
    if (outcome.state !== STATE.CONNECTED) {
      return { ...envelope(), state: outcome.state, failure: outcome.failure,
        httpStatus: outcome.httpStatus, reason: outcome.reason, elapsedMs: outcome.elapsedMs,
        fieldErrors: outcome.fieldErrors ?? {}, created: null,
        /* The only case where the caller must go and look instead of trying again. */
        outcomeUnknown: Boolean(outcome.sent), endpoint: commit, warnings: [] };
    }
    const header = await project();
    const activity = normalizeWorkPackage(outcome.body, {
      projectId: projectId(),
      projectIdentifier: header.project?.identifier ?? null,
      projectName: header.project?.name ?? null,
      duration: basisUsed,
    });
    return { ...envelope(), state: STATE.CONNECTED, failure: null,
      httpStatus: outcome.httpStatus, reason: null, elapsedMs: outcome.elapsedMs,
      fieldErrors: {}, created: activity, outcomeUnknown: false, endpoint: commit,
      duration: basisUsed, warnings: [] };
  }

  /**
   * The values a create form may offer: types, statuses and priorities, from the instance.
   *
   * Asked for rather than assumed, because the brief's warning is exactly right — a status list
   * copied from documentation is a list of options that may not exist here. Each read is allowed
   * to fail on its own: a form that cannot offer a priority is still a usable form, and saying
   * "this list could not be read" beats offering a hardcoded one that the source will reject.
   */
  async function createMetadata() {
    const id = projectId();
    const read = async (path, map) => {
      const out = await client.collection(path);
      if (out.state !== STATE.CONNECTED) return { ok: false, reason: out.reason, values: [] };
      return { ok: true, reason: null, values: out.elements.map(map) };
    };
    const [types, statuses, priorities] = await Promise.all([
      id ? read(`${API.project(id)}/types`, row => ({ id: String(row.id), name: row.name,
        isMilestone: Boolean(row.isMilestone), isDefault: Boolean(row.isDefault) }))
        : Promise.resolve({ ok: false, reason: 'No project id.', values: [] }),
      read(`${API.root}/statuses`, row => ({ id: String(row.id), name: row.name,
        isClosed: Boolean(row.isClosed), isDefault: Boolean(row.isDefault) })),
      read(`${API.root}/priorities`, row => ({ id: String(row.id), name: row.name,
        isDefault: Boolean(row.isDefault) })),
    ]);
    return { types, statuses, priorities };
  }

  /**
   * Find a work package by a marker in its description.
   *
   * The ONLY safe way to resolve a creation whose outcome is unknown. OpenProject has no
   * idempotency key, so a POST that timed out can be reconciled in exactly one way: look for the
   * record it may have made. The marker is this application's creation-request id, written into
   * the description at submit time, and `description ~ <marker>` is a verified filter on this
   * instance.
   */
  async function findByMarker(marker) {
    const id = projectId();
    if (!id) return { ...configFailure(), matches: [] };
    const text = String(marker ?? '').trim();
    if (!text) {
      return { ...envelope(), state: STATE.CONNECTION_FAILED, failure: FAILURE.CONFIG,
        httpStatus: null, reason: 'A correlation marker is required.', elapsedMs: null,
        matches: [], warnings: [] };
    }
    const outcome = await client.collection(API.projectWorkPackages(id), {
      pageSize: 20, offset: 1,
      filters: JSON.stringify([{ description: { operator: '~', values: [text] } }]),
    });
    if (outcome.state !== STATE.CONNECTED) {
      return { ...envelope(), state: outcome.state, failure: outcome.failure,
        httpStatus: outcome.httpStatus, reason: outcome.reason, elapsedMs: outcome.elapsedMs,
        matches: [], warnings: [] };
    }
    const basisUsed = await basis();
    return { ...envelope(), state: STATE.CONNECTED, failure: null,
      httpStatus: outcome.httpStatus, reason: null, elapsedMs: outcome.elapsedMs,
      matches: outcome.elements.map(row => normalizeWorkPackage(row, {
        projectId: id, duration: basisUsed })),
      warnings: [] };
  }

  return { health, project, workPackages, workPackage,
    createEndpoints, createMetadata, workPackageForm, createWorkPackage, findByMarker,
    configured: client.configured,
    baseUrl: client.baseUrl, redactedFor: client.redactedFor,
    /** The validated project id, or null when the environment value is not a whole number. */
    projectId };
}
