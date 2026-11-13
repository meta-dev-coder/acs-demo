/**
 * The Construction Integration Demo API, same-origin.
 *
 * Shaped like every other API in `server/` — a factory returning `{ handle, middleware }` — so it
 * mounts into the Vite dev server and into `server/index.mjs` through the same two lines the
 * others use.
 *
 * Deliberately NOT registered in `readApiHandlers.mjs`: that module is shared with the EC2
 * live-dc host, whose documented floor is Node 20.12, and `node:sqlite` needs 22.5. Nothing about
 * this project belongs on that host, and a handler there would fail at import.
 *
 * Everything under `/api/construction/`. Nothing it touches is shared with I-595.
 */
import { createMockAdapters, INTERFACES, WRITE_BACK_STATUS } from './adapters.mjs';
import { clearConstructionDb, countRows, openConstructionDb } from './db.mjs';
import { buildSeed, PROJECT, seedSourceSystems } from './seed.mjs';
import { overview, recordAudit, runInboundSync, INBOUND_INTERFACES } from './sync.mjs';
import { buildMappings, listMappings, mappingDetail, mappingFacets, mappingSummary } from './mapping.mjs';
import { RULES, storeValidation, validate } from './validation.mjs';
import {
  exceptionDetail, exceptionSummary, listExceptions, syncExceptions, transitionException,
} from './exceptions.mjs';
import { latestReconciliation, reconcile, storeReconciliation } from './reconciliation.mjs';
import {
  decideProposal, listProposals, markRevalidated, PROPOSABLE, proposeMapping, suggestActivities,
} from './proposals.mjs';
import { seedProgress } from './progressSeed.mjs';
import { activityDetail, activityList } from './progress.mjs';
import { buildModel, listDrafts, modelFacets, prepareP6Draft } from './model.mjs';
import { DEMO_AUTH, APPROVER_ROLE, ROLES, issueSession, may, refusal, sessionFor } from './auth.mjs';
import {
  auditTrail, reconciliationHistory, reconciliationRunDetail, syncHistory, syncRunDetail,
  writeBackDetail, writeBackHistory,
} from './history.mjs';
import { scenarios, walkthrough } from './walkthrough.mjs';
import {
  CONNECTION as SANDBOX_CONNECTION, LIMITS as SANDBOX_LIMITS, createSapSandboxAdapter, parseTop,
} from './sapSandbox.mjs';
import { S4HANA_PROJECT_DATA } from './sapSandboxConfig.mjs';
import { CONNECTION as SAP_STATE, createSapCostAdapter } from './sapCost.mjs';
import { reconcileSapCost } from './sapReconciliation.mjs';
import {
  STATUS, decide, proposeP6Update, proposeSapEarnedValue, submit,
} from './outbound.mjs';
import { createOpenProjectAdapter, STATE as OP_STATE } from './openProject.mjs';
import { parseId as parseOpId } from './openProjectHttp.mjs';
import {
  CREATE_PERMISSION, claim, creationById, creationByKey, creations, isSettled,
  reconcileUnknown, retryMapping, runCreation, unresolved, validateRequest,
} from './workPackageCreate.mjs';
import {
  LINK_PERMISSION, MAPPING as OP_MAPPING, NO_FILTER, RUN_STATUS, SOURCE as OP_SOURCE, TRIGGER,
} from './openProjectConfig.mjs';
import {
  changeLog, fetchLog, lastFetch, lastSuccessfulFetch, links as opLinks,
  decideLink, storedActivities,
  /*
   * ALIASED, because `history.mjs` already exports a `syncHistory` and the two are exactly the
   * pair this project keeps insisting are different things: that one lists `sync_run` rows, which
   * mean records were written into the normalized SYNCHRO tables, and this one lists
   * `live_schedule_fetch` rows, which mean an external system was read. Letting them share a name
   * in one file is how the overview ends up claiming a synchronisation that never happened.
   */
  syncHistory as liveScheduleRuns,
} from './openProjectStore.mjs';
import {
  SYNC_EVENT, acquireSyncWorker, createOpenProjectSyncWorker, releaseSyncWorker,
} from './openProjectSync.mjs';
import { createSseHub } from './sseHub.mjs';
import {
  OPENPROJECT_READ_ONLY, OPENPROJECT_WRITABLE, PROPOSABLE_FIELDS, STAGES, STAGE_STATUS,
  UNAVAILABLE as LIFECYCLE_UNAVAILABLE, issuesFor, lifecycleFor, overdue,
} from './lifecycle.mjs';
import {
  RUN_STATUS as SPECKLE_RUN_STATUS, SPECKLE, STATE as SPECKLE_STATE,
  TRIGGER as SPECKLE_TRIGGER, createSpeckleAdapter, parseVersionId, readPlacement,
} from './speckle.mjs';
import {
  MAPPING_PERMISSION, MAPPING_STATUS, activeVersion, comparison, decideMapping, elementDetail,
  elements as speckleElements, firstSeenByGuid, ifcTypes, lastSync,
  /*
   * ALIASED. `mapping.mjs` already exports `proposeMapping` for the BIM-element-to-P6-activity
   * mapping of the SYNTHETIC demo, and these are genuinely different things: that one links a
   * synthetic element to a synthetic activity, this one links a REAL IFC GlobalId from Speckle
   * to a schedule activity. Letting them share a name in one file is how the two would be
   * confused in exactly the way this phase must not confuse them.
   */
  mappings as speckleMappings, proposeMapping as proposeElementMapping,
  focusBounds, saveComparison, syncLog, timeline, versions as speckleVersions,
} from './speckleStore.mjs';
import { SYNC_EVENT as SPECKLE_EVENT, createSpeckleSyncWorker } from './speckleSync.mjs';
import { acquireSyncWorker as acquireWorker, releaseSyncWorker as releaseWorker }
  from './workerRegistry.mjs';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve as resolvePath, sep } from 'node:path';
import {
  candidatesFor, compare, syntheticP6Activities,
} from './openProjectMapping.mjs';
import {
  clearFailures, forceFailure, listProposals as listOutbound, post, proposalDetail,
  writeBackReconciliation,
} from './destinations.mjs';

/**
 * Build the mapping layer, validate it, reconcile the exception list and reconcile the totals.
 *
 * One function because they are one act: a mapping that changed has to be revalidated, and an
 * exception list that is not reconciled against the new findings is stale the moment it is read.
 * Every route that changes anything calls this.
 */
function revalidate(db, { actor = 'Integration service' } = {}) {
  const build = buildMappings(db, { actor });
  const findings = validate(db);
  const validation = storeValidation(db, findings, { actor });
  const exceptions = syncExceptions(db, findings, { actor });
  const reconciliation = storeReconciliation(db, reconcile(db), { actor });
  // Geometry and measurement rules follow the mapping layer: an element that has just arrived has
  // no box, and an activity whose links changed may need a different rule. Observations are left
  // alone — they are evidence, not something a rebuild may rewrite.
  seedProgress(db);
  recordAudit(db, { actor, event: 'REVALIDATION', subject: 'mapping-layer',
    result: `${validation.errors} error(s), ${validation.warnings} warning(s); `
      + `${exceptions.created} new, ${exceptions.resolved} resolved`,
    detail: { build, validation, exceptions, reconciliation: reconciliation.runId } });
  return { build, validation, exceptions, reconciliation };
}

export const BASE = '/api/construction';

const json = (res, status, payload) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
};

const readBody = req => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', chunk => {
    size += chunk.length;
    if (size > 64_000) { reject(new Error('Request body too large.')); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (!text) { resolve({}); return; }
    try { resolve(JSON.parse(text)); } catch { reject(new Error('Body is not valid JSON.')); }
  });
  req.on('error', reject);
});

/**
 * @param {{path?: string, db?: object, logger?: object, actor?: string,
 *   sandboxOptions?: object}} [options]
 *   `path: ':memory:'` for tests; `db` injects an already-open handle; `sandboxOptions` is passed
 *   to `createSapSandboxAdapter`, so a test can supply its own `fetchImpl` and `env` and never
 *   touch the network. `openProjectOptions` does the same for the live schedule adapter — kept
 *   separate because the two systems hold different credentials and a test for one must not be
 *   able to configure the other.
 */
export function createConstructionApi({ path, db: injected = null, logger = console,
  defaultActor = 'Demo operator', sandboxOptions = null, openProjectOptions = null,
  /**
   * Phase 8B's background worker (`syncOptions`), and whether to start it at all.
   *
   * `autoSync: false` is what the test suite passes: a unit test must never arm a timer against a
   * cloud service, and the worker's own behaviour is tested by building one directly with an
   * injected clock. `syncOptions.workerKey` separates two APIs in one process — which only
   * happens in tests, and which would otherwise share the process-wide singleton.
   */
  autoSync = true, syncOptions = null,
  /** Phase 9B. `speckleOptions` injects a fetch/env/spawn so a test never touches the network. */
  speckleOptions = null, speckleSyncOptions = null } = {}) {
  /**
   * Opened on the first request rather than at import.
   *
   * The Vite config imports every API factory at startup; throwing there over an experimental
   * built-in would take the whole dev server down with it. A failure here answers 503 with the
   * reason, and the rest of the application is unaffected.
   */
  let db = injected;
  let openError = null;
  let adapters = null;

  function ready() {
    if (db || openError) return db;
    try {
      db = openConstructionDb(path ? { path } : {});
      // The mock source systems are seeded on first open. The normalized side, the runs and the
      // audit trail are NOT: an install that has not synced must report "never run".
      if (countRows(db, ['src_p6_activity']).src_p6_activity === 0) seedSourceSystems(db);
    } catch (error) {
      openError = error;
      logger.error?.('[construction] database unavailable', error);
    }
    return db;
  }

  const adapterMap = () => {
    adapters ??= createMockAdapters(db);
    return adapters;
  };

  /**
   * The SAP sandbox client. Deliberately NOT in `adapterMap`.
   *
   * `adapterMap` is what `runInboundSync` iterates. Putting a real HTTP client in it would mean a
   * "Run Demo Sync" reaching the internet and writing live records into the normalized tables —
   * the one thing this phase must not do. It is built on first use and kept, because it holds no
   * state beyond the environment it reads on every call.
   */
  let sandbox = null;
  const sapSandbox = () => (sandbox ??= createSapSandboxAdapter(
    { logger, ...(sandboxOptions ?? {}) }));
  /** When the LAST successful call happened, for the panel. Per process; nothing is persisted. */
  let sandboxLastSuccessAt = null;

  /**
   * The live S/4HANA cost adapter. Also deliberately NOT in `adapterMap`.
   *
   * Same reasoning as the sandbox client above: `adapterMap` is what `runInboundSync` iterates,
   * and nothing read here may ever be written into the integration tables. This reads SAP project
   * RNG002 and hands it straight to the browser.
   */
  let sapCostAdapter = null;
  const sapCost = () => (sapCostAdapter ??= createSapCostAdapter(
    { logger, ...(sandboxOptions ?? {}) }));

  /**
   * The live OpenProject schedule adapter (Phase 8A). Also deliberately NOT in `adapterMap`.
   *
   * Third time this decision has been taken, and for the third identical reason: `adapterMap` is
   * what `runInboundSync` iterates, so a real HTTP client in it would make "Run Demo Sync" reach
   * the internet and write live records into the normalized SYNCHRO tables. OpenProject reads land
   * in `live_schedule_*` and nowhere else.
   */
  let openProjectAdapter = null;
  const openProject = () => (openProjectAdapter ??= createOpenProjectAdapter(
    { logger, ...(openProjectOptions ?? {}) }));

  /**
   * The SSE hub and the background worker (Phase 8B).
   *
   * Built here, with the API, because they share exactly the things the API already owns: the one
   * adapter and the one database handle. A worker that built its own adapter would be a second
   * place credentials are resolved, and a second place that could drift.
   *
   * The worker is a PROCESS-WIDE singleton (see `acquireSyncWorker`), so a reloaded Vite module
   * graph or a second `createConstructionApi()` in the same process finds the existing worker
   * instead of arming another timer against the same cloud instance.
   */
  const events = createSseHub({ logger, label: 'openproject-events' });
  const workerKey = syncOptions?.workerKey ?? 'default';
  let workerHandle = null;
  function syncWorker() {
    // A worker that has been stopped can never poll again, so re-acquire rather than return it.
    if (workerHandle && !workerHandle.stopped) return workerHandle;
    const acquired = acquireSyncWorker(workerKey, () => createOpenProjectSyncWorker({
      adapter: openProject,
      // Lazily, and may be null: the database opens on the first request, and a host without
      // `node:sqlite` must still serve the SAP routes rather than failing at construction.
      db: () => ready(),
      publish: (event, data) => events.publish(event, data),
      logger,
      /*
       * THE SAME ENVIRONMENT THE ADAPTER READS.
       *
       * One integration, one environment. Defaulting the worker to `process.env` while the
       * adapter was handed an injected one meant a test could configure the credential and the
       * project and still have the worker report `enabled: false` from the real process — two
       * sources of configuration for one connection, which is exactly the drift this file keeps
       * avoiding elsewhere. `syncOptions.env` still overrides.
       */
      env: openProjectOptions?.env ?? process.env,
      ...(syncOptions ?? {}),
    }));
    workerHandle = acquired.worker;
    /*
     * ADOPTION REBINDS IT.
     *
     * A worker we did not create belongs to a server that may be shutting down, and its database
     * handle is about to be closed. Pointing it at THIS api's adapter, database and event hub is
     * what makes the singleton survive a restart usefully rather than survive it broken — see the
     * comment on `rebind`.
     */
    if (!acquired.created) {
      workerHandle.rebind?.({
        adapter: openProject,
        db: () => ready(),
        publish: (event, data) => events.publish(event, data),
        logger,
      });
    }
    return workerHandle;
  }

  /**
   * Start the worker, once, when the host is ready.
   *
   * Called by the host (`vite.config.js`, `server/index.mjs`) rather than from the constructor:
   * importing this module must not reach the network, and a test that builds an API gets no timer
   * unless it asks for one.
   */
  /**
   * The Speckle BIM connector and its worker (Phase 9B).
   *
   * Built here with the API, sharing the one database handle and the one event hub, for the same
   * reason the OpenProject pair are: a connector that built its own would be a second place
   * credentials are resolved and a second place that could drift.
   */
  let speckleAdapter = null;
  const speckle = () => (speckleAdapter ??= createSpeckleAdapter(
    { logger, ...(speckleOptions ?? {}) }));

  const speckleKey = speckleSyncOptions?.workerKey ?? 'speckle';
  let speckleWorkerHandle = null;
  function speckleWorker() {
    if (speckleWorkerHandle && !speckleWorkerHandle.stopped) return speckleWorkerHandle;
    const acquired = acquireWorker(speckleKey, () => createSpeckleSyncWorker({
      adapter: speckle,
      db: () => ready(),
      publish: (event, data) => events.publish(event, data),
      logger,
      env: speckleOptions?.env ?? process.env,
      ...(speckleSyncOptions ?? {}),
    }));
    speckleWorkerHandle = acquired.worker;
    // Adoption rebinds it to THIS api's adapter, database and hub — see workerRegistry.mjs.
    if (!acquired.created) {
      speckleWorkerHandle.rebind?.({
        adapter: speckle, db: () => ready(),
        publish: (event, data) => events.publish(event, data), logger,
      });
    }
    return speckleWorkerHandle;
  }

  function startAutoSync() {
    if (!autoSync) return { started: false, reason: 'autoSync is off for this API instance.' };
    const openProject = syncWorker().start();
    const speckleStart = speckleWorker().start();
    return { ...openProject, speckle: speckleStart };
  }

  const unavailable = res => json(res, 503, {
    error: 'The Construction Integration Demo database is unavailable.',
    detail: String(openError?.message ?? openError),
    hint: 'This project stores its state in SQLite through node:sqlite, which needs Node 22.5 or newer.',
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return false;
    const route = url.pathname.slice(BASE.length) || '/';
    const method = req.method ?? 'GET';

    /*
     * ── SAP sandbox connectivity ───────────────────────────────────────────────────────────
     *
     * Answered BEFORE the database check on purpose. This is the one real HTTP integration in the
     * project and it shares no state with the rest of it, so a host where `node:sqlite` is
     * missing should still be able to prove the SAP connection works. Equally, nothing here
     * touches INT-04: no adapter is registered, no sync run is opened and nothing is written.
     */
    if (method === 'GET' && (route === '/sap-sandbox/health'
      || route === '/sap-sandbox/project-controlling-objects')) {
      const probe = route.endsWith('/health');
      const top = probe ? 1 : parseTop(url.searchParams.get('top'));
      if (top === null) {
        json(res, 400, { error: `"top" must be a whole number from 1 to ${SANDBOX_LIMITS.maxTop}.` });
        return true;
      }
      let result;
      try {
        result = probe ? await sapSandbox().testConnection()
          : await sapSandbox().fetchProjectControllingObjects({ top });
      } catch (error) {
        // The adapter reports its own failures; reaching here means a defect in it, and the
        // message is ours, not an upstream body.
        logger.error?.('[sap-sandbox] adapter threw', error);
        json(res, 502, { error: 'The SAP sandbox adapter failed unexpectedly.' });
        return true;
      }
      if (result.state === SANDBOX_CONNECTION.CONNECTED) sandboxLastSuccessAt = result.requestedAt;
      // 200 for every REPORTED state: "not configured" and "failed" are findings this endpoint
      // exists to deliver, not failures of the endpoint. The state field carries the verdict.
      json(res, 200, {
        ...result,
        /** Separate from this request's own result, so the panel can show both. */
        lastSuccessAt: sandboxLastSuccessAt,
        /** Stated on every response, next to a "Connected" that must not be over-read. */
        s4hanaProjectData: S4HANA_PROJECT_DATA,
      });
      return true;
    }

    /*
     * ── SAP live cost (Phase 7C) ───────────────────────────────────────────────────────────
     *
     * Also answered before the database check: these four routes read SAP and nothing else. They
     * open no sync run, write no row and touch no interface. Read-only, GET-only.
     */
    if (method === 'GET' && route.startsWith('/sap-cost')) {
      const leaf = route.slice('/sap-cost'.length) || '/';
      try {
        if (leaf === '/project') { json(res, 200, await sapCost().project()); return true; }

        if (leaf === '/hierarchy') {
          // The project header first, so the hierarchy can be filtered by ProjectUUID — the
          // authoritative link — rather than by a code prefix that can over-match.
          const header = await sapCost().project();
          const uuid = header.state === SAP_STATE.CONNECTED ? header.project?.uuid ?? null : null;
          const result = await sapCost().hierarchy({ projectUuid: uuid });
          json(res, 200, { ...result, project: header.project ?? null,
            warnings: [...header.warnings, ...result.warnings] });
          return true;
        }

        if (leaf === '/expenses') { json(res, 200, await sapCost().expenses()); return true; }

        if (leaf === '/' || leaf === '/reconciliation') {
          const header = await sapCost().project();
          const uuid = header.state === SAP_STATE.CONNECTED ? header.project?.uuid ?? null : null;
          // Sequential, not parallel: the hierarchy query needs the project UUID, and the sandbox
          // is a shared tenant that answers an analytical query slowly enough that three at once
          // is worse than three in a row.
          const tree = await sapCost().hierarchy({ projectUuid: uuid });
          const cost = await sapCost().expenses();

          // Any leg failing makes the whole answer a failure. A reconciliation computed over a
          // hierarchy that did not arrive would reconcile perfectly against nothing.
          const broken = [header, tree, cost].find(part => part.state !== SAP_STATE.CONNECTED);
          if (broken) {
            json(res, 200, { ...broken, project: header.project ?? null, reconciliation: null,
              elements: [], rows: [],
              warnings: [...header.warnings, ...tree.warnings, ...cost.warnings] });
            return true;
          }

          const reconciliation = reconcileSapCost({ elements: tree.elements, rows: cost.rows });
          json(res, 200, {
            source: cost.source,
            filters: cost.filters,
            state: SAP_STATE.CONNECTED,
            failure: null,
            httpStatus: cost.httpStatus,
            retrievedAt: cost.retrievedAt,
            elapsedMs: (header.elapsedMs ?? 0) + (tree.elapsedMs ?? 0) + (cost.elapsedMs ?? 0),
            project: header.project,
            elements: tree.elements,
            rootCodes: tree.rootCodes,
            rows: cost.rows,
            aggregatedRowCount: cost.aggregatedRowCount,
            sourceRowCount: cost.sourceRowCount,
            reconciliation,
            // Every warning from every leg, in one list. A warning raised by the hierarchy read
            // and dropped by the reconciliation would be a warning nobody ever sees.
            warnings: [...header.warnings, ...tree.warnings, ...cost.warnings,
              ...reconciliation.warnings],
          });
          return true;
        }
      } catch (error) {
        logger.error?.('[sap-cost] adapter threw', error);
        json(res, 502, { error: 'The SAP cost adapter failed unexpectedly.' });
        return true;
      }
      json(res, 404, { error: `Unknown SAP cost route "${leaf}".` });
      return true;
    }

    if (!ready()) { unavailable(res); return true; }

    try {
      if (method === 'GET' && route === '/health') {
        json(res, 200, { ok: true, project: PROJECT, schemaVersion: 1,
          rows: countRows(db), synthetic: true });
        return true;
      }

      if (method === 'GET' && (route === '/' || route === '/overview')) {
        json(res, 200, overview(db, { adapters: adapterMap() }));
        return true;
      }

      if (method === 'GET' && route === '/interfaces') {
        json(res, 200, { interfaces: INTERFACES, inbound: INBOUND_INTERFACES,
          writeBack: WRITE_BACK_STATUS,
          adapters: [...adapterMap()].map(([id, adapter]) => ({ interfaceId: id, ...adapter.describe() })) });
        return true;
      }

      if (method === 'POST' && route === '/sync') {
        const body = await readBody(req);
        const actor = String(body.actor ?? defaultActor).slice(0, 80);
        const only = body.interface && body.interface !== 'all' ? body.interface : null;
        let runs;
        try {
          runs = runInboundSync(db, adapterMap(), { actor, only });
        } catch (error) {
          json(res, 400, { error: String(error?.message ?? error) });
          return true;
        }
        // Records that have just arrived have not been mapped or validated. Doing it here is what
        // keeps the exception list from being one sync out of date.
        const revalidation = revalidate(db, { actor });
        json(res, 200, { runs, revalidation,
          overview: overview(db, { adapters: adapterMap() }),
          mapping: mappingSummary(db), exceptions: exceptionSummary(db) });
        return true;
      }

      /* ── mapping ────────────────────────────────────────────────────────────────────── */

      if (method === 'GET' && route === '/mappings') {
        const filters = Object.fromEntries(url.searchParams);
        json(res, 200, {
          ...listMappings(db, filters),
          summary: mappingSummary(db),
          facets: mappingFacets(db),
          synthetic: true,
        });
        return true;
      }

      if (method === 'GET' && route.startsWith('/mappings/')) {
        const elementId = decodeURIComponent(route.slice('/mappings/'.length));
        const detail = mappingDetail(db, elementId);
        if (!detail) { json(res, 404, { error: `There is no mapping for element ${elementId}.` }); return true; }
        json(res, 200, { ...detail, proposableFields: PROPOSABLE, synthetic: true });
        return true;
      }

      if (method === 'GET' && route === '/suggestions') {
        const elementId = url.searchParams.get('element');
        if (!elementId) { json(res, 400, { error: 'Name the element: ?element=COL-001' }); return true; }
        json(res, 200, { ...suggestActivities(db, elementId),
          note: 'A suggestion is evidence for a reviewer. Nothing here has been applied.' });
        return true;
      }

      /* ── validation and revalidation ────────────────────────────────────────────────── */

      if (method === 'POST' && route === '/revalidate') {
        const body = await readBody(req);
        const actor = String(body.actor ?? defaultActor).slice(0, 80);
        const result = revalidate(db, { actor });
        if (body.proposalId) markRevalidated(db, body.proposalId, result.validation);
        json(res, 200, { ...result, summary: mappingSummary(db), exceptions: exceptionSummary(db) });
        return true;
      }

      if (method === 'GET' && route === '/rules') {
        json(res, 200, { rules: RULES });
        return true;
      }

      /* ── proposals ──────────────────────────────────────────────────────────────────── */

      if (method === 'GET' && route === '/proposals') {
        json(res, 200, { proposals: listProposals(db, Object.fromEntries(url.searchParams)),
          fields: PROPOSABLE });
        return true;
      }

      if (method === 'POST' && route === '/proposals') {
        const body = await readBody(req);
        const result = proposeMapping(db, {
          elementId: body.elementId, field: body.field, proposedValue: body.proposedValue,
          reason: body.reason, evidence: body.evidence ?? null,
          exceptionId: body.exceptionId ?? null,
          requester: String(body.requester ?? defaultActor).slice(0, 80),
          requesterRole: String(body.requesterRole ?? 'integrationLead').slice(0, 40),
        });
        if (!result.ok) { json(res, 400, { error: result.error }); return true; }
        recordAudit(db, { actor: body.requester ?? defaultActor, event: 'MAPPING_PROPOSED',
          subject: body.elementId, previous: result.proposal.current_value,
          next: body.proposedValue, result: `Awaiting ${result.approverRole} approval`,
          detail: { proposalId: result.proposal.id, field: body.field } });
        json(res, 200, result);
        return true;
      }

      if (method === 'POST' && route.startsWith('/proposals/')) {
        const [rawId, action] = route.slice('/proposals/'.length).split('/');
        const body = await readBody(req);
        const actor = String(body.actor ?? defaultActor).slice(0, 80);
        const actorRole = String(body.actorRole ?? '').slice(0, 40);
        const decision = action === 'approve' ? 'APPROVE' : action === 'reject' ? 'REJECT' : null;
        if (!decision) { json(res, 404, { error: `Unknown proposal action "${action}".` }); return true; }
        const result = decideProposal(db, rawId, decision, { actor, actorRole, note: body.note });
        if (!result.ok) {
          recordAudit(db, { actor, event: result.held ? 'MAPPING_HELD' : 'MAPPING_DECISION_REFUSED',
            subject: result.proposal?.element_id ?? null, result: result.error,
            detail: { proposalId: Number(rawId) } });
          json(res, result.held ? 409 : 403, result);
          return true;
        }
        recordAudit(db, { actor, event: `MAPPING_${result.status}`,
          subject: result.proposal?.element_id ?? null,
          previous: result.proposal?.current_value ?? null,
          next: result.proposal?.proposed_value ?? null, result: result.status,
          detail: { proposalId: Number(rawId), approverRole: actorRole } });
        // An applied change is revalidated immediately: a corrected mapping that still shows its
        // old exception is worse than no correction.
        const after = result.status === 'APPLIED' ? revalidate(db, { actor }) : null;
        if (after) markRevalidated(db, rawId, after.validation);
        json(res, 200, { ...result, revalidation: after,
          proposal: db.prepare('SELECT * FROM mapping_proposal WHERE id = ?').get(Number(rawId)) });
        return true;
      }

      /* ── Phase 6: history, audit and the guided demonstration ───────────────────────── */

      if (method === 'GET' && route === '/history/sync') {
        json(res, 200, { ...syncHistory(db, Object.fromEntries(url.searchParams)), synthetic: true });
        return true;
      }

      if (method === 'GET' && route.startsWith('/history/sync/')) {
        const [kind, id] = route.slice('/history/sync/'.length).split('/');
        const detail = syncRunDetail(db, kind, id);
        if (!detail) { json(res, 404, { error: 'No such run or attempt.' }); return true; }
        json(res, 200, detail);
        return true;
      }

      if (method === 'GET' && route === '/history/audit') {
        json(res, 200, auditTrail(db, Object.fromEntries(url.searchParams)));
        return true;
      }

      if (method === 'GET' && route === '/history/writeback') {
        json(res, 200, { proposals: writeBackHistory(db, Object.fromEntries(url.searchParams)),
          approverRole: APPROVER_ROLE });
        return true;
      }

      if (method === 'GET' && route.startsWith('/history/writeback/')) {
        const detail = writeBackDetail(db, route.slice('/history/writeback/'.length));
        if (!detail) { json(res, 404, { error: 'No such proposal.' }); return true; }
        json(res, 200, detail);
        return true;
      }

      if (method === 'GET' && route === '/history/reconciliation') {
        json(res, 200, { runs: reconciliationHistory(db, Object.fromEntries(url.searchParams)) });
        return true;
      }

      if (method === 'GET' && route.startsWith('/history/reconciliation/')) {
        const detail = reconciliationRunDetail(db, route.slice('/history/reconciliation/'.length));
        if (!detail) { json(res, 404, { error: 'No such reconciliation run.' }); return true; }
        json(res, 200, detail);
        return true;
      }

      if (method === 'GET' && route === '/demo/walkthrough') {
        json(res, 200, { ...walkthrough(db), scenarios: scenarios(db) });
        return true;
      }

      /* ── Phase 5: demo authorization ────────────────────────────────────────────────── */

      if (method === 'POST' && route === '/session') {
        const body = await readBody(req);
        const result = issueSession(db, { role: body.role, actor: body.actor });
        if (!result.ok) { json(res, 400, result); return true; }
        // The actor is the person the session is for, never part of the token — a token fragment
        // in an audit log is a secret in a log, and it is not an actor either.
        recordAudit(db, { actor: body.actor || result.label, event: 'DEMO_SESSION_ISSUED',
          subject: result.role, result: 'Demo session issued (not authentication)',
          detail: { role: result.role, demo: true } });
        json(res, 200, result);
        return true;
      }

      if (method === 'GET' && route === '/session') {
        const session = sessionFor(db, req.headers['x-demo-session']);
        json(res, 200, { session: session
          ? { role: session.role, actor: session.actor, label: ROLES[session.role].label,
            may: ROLES[session.role].may, expiresAt: session.expires_at }
          : null, roles: ROLES, demo: DEMO_AUTH });
        return true;
      }

      /* ── Phase 5: outbound approvals and write-back ─────────────────────────────────── */

      if (method === 'GET' && route === '/outbound') {
        json(res, 200, {
          proposals: listOutbound(db, Object.fromEntries(url.searchParams)),
          approverRole: APPROVER_ROLE,
          reconciliation: writeBackReconciliation(db),
          demo: DEMO_AUTH,
        });
        return true;
      }

      if (method === 'GET' && route.startsWith('/outbound/')) {
        const detail = proposalDetail(db, route.slice('/outbound/'.length));
        if (!detail) { json(res, 404, { error: 'No such proposal.' }); return true; }
        json(res, 200, detail);
        return true;
      }

      if (method === 'POST' && route === '/outbound/p6') {
        const body = await readBody(req);
        const session = sessionFor(db, req.headers['x-demo-session']);
        if (!may(session, 'submit')) { json(res, 403, { error: refusal(session, 'submit') }); return true; }
        // Prepare the draft here when the caller did not, so one call covers the whole act.
        let draftId = body.draftId;
        if (!draftId) {
          const prepared = prepareP6Draft(db, body.activityId, { actor: session.actor });
          if (!prepared.ok) { json(res, 400, { error: prepared.error }); return true; }
          draftId = prepared.draft.id;
        }
        const result = proposeP6Update(db, draftId,
          { actor: session.actor, actorRole: session.role });
        if (!result.ok) { json(res, 400, result); return true; }
        recordAudit(db, { actor: session.actor, event: 'OUTBOUND_PROPOSED', interfaceId: 'INT-02',
          subject: result.proposal.subject_id,
          previous: `${result.proposal.payload.current?.pct_complete ?? '?'}%`,
          next: `${result.proposal.payload.proposed.pct_complete}%`,
          result: 'Raised as a draft proposal', correlationId: result.proposal.correlation_id,
          detail: { proposalId: result.proposal.id } });
        json(res, 200, result);
        return true;
      }

      if (method === 'POST' && route === '/outbound/sap') {
        const body = await readBody(req);
        const session = sessionFor(db, req.headers['x-demo-session']);
        if (!may(session, 'submit')) { json(res, 403, { error: refusal(session, 'submit') }); return true; }
        const result = proposeSapEarnedValue(db, body.wbsCode,
          { actor: session.actor, actorRole: session.role });
        if (!result.ok) { json(res, 400, result); return true; }
        recordAudit(db, { actor: session.actor, event: 'OUTBOUND_PROPOSED', interfaceId: 'INT-05',
          subject: result.proposal.subject_id,
          previous: result.proposal.payload.current?.earned_value ?? 'none',
          next: result.proposal.payload.proposed.earned_value,
          result: `Raised, ${result.proposal.coverage?.scope ?? 'unknown'} coverage`,
          correlationId: result.proposal.correlation_id,
          detail: { proposalId: result.proposal.id } });
        json(res, 200, result);
        return true;
      }

      if (method === 'POST' && route.startsWith('/outbound/')) {
        const [rawId, action] = route.slice('/outbound/'.length).split('/');
        const body = await readBody(req);
        const session = sessionFor(db, req.headers['x-demo-session']);
        const id = Number(rawId);

        if (action === 'submit') {
          if (!may(session, 'submit')) { json(res, 403, { error: refusal(session, 'submit') }); return true; }
          const result = submit(db, id, { actor: session.actor, actorRole: session.role });
          json(res, result.ok ? 200 : 400, result);
          return true;
        }

        if (action === 'approve' || action === 'reject' || action === 'hold') {
          const proposal = db.prepare('SELECT interface_id FROM outbound_proposal WHERE id = ?').get(id);
          if (!proposal) { json(res, 404, { error: `There is no proposal ${id}.` }); return true; }
          const permission = `approve:${proposal.interface_id}`;
          // The role comes from the SESSION. A request body cannot assert one.
          if (!may(session, permission)) {
            recordAudit(db, { actor: session?.actor ?? 'anonymous',
              event: 'OUTBOUND_DECISION_REFUSED', interfaceId: proposal.interface_id,
              subject: String(id), result: refusal(session, permission),
              detail: { proposalId: id, attemptedAs: session?.role ?? null, permission } });
            json(res, 403, { error: refusal(session, permission), demo: DEMO_AUTH });
            return true;
          }
          const decision = action === 'approve' ? 'APPROVE' : action === 'reject' ? 'REJECT' : 'HOLD';
          const result = decide(db, id, decision, { session, note: body.note });
          if (!result.ok) { json(res, result.forbidden ? 403 : 400, result); return true; }
          recordAudit(db, { actor: session.actor, event: `OUTBOUND_${result.status}`,
            interfaceId: proposal.interface_id, subject: result.proposal.subject_id,
            previous: 'PENDING_APPROVAL', next: result.status, result: result.status,
            correlationId: result.proposal.correlation_id,
            detail: { proposalId: id, approverRole: session.role, note: body.note ?? null } });
          json(res, 200, result);
          return true;
        }

        if (action === 'post') {
          // Posting is the approver's act, or the Integration Lead retrying a FAILED one — never
          // a way around the approval, because preflight still requires APPROVED.
          const proposal = db.prepare('SELECT interface_id, status FROM outbound_proposal WHERE id = ?').get(id);
          if (!proposal) { json(res, 404, { error: `There is no proposal ${id}.` }); return true; }
          const permission = proposal.status === STATUS.FAILED
            ? 'retry' : `approve:${proposal.interface_id}`;
          if (!may(session, permission) && !may(session, `approve:${proposal.interface_id}`)) {
            json(res, 403, { error: refusal(session, permission), demo: DEMO_AUTH });
            return true;
          }
          const result = post(db, id, { session });
          recordAudit(db, { actor: session.actor,
            event: result.ok ? 'WRITE_BACK_POSTED' : result.held ? 'WRITE_BACK_HELD' : 'WRITE_BACK_FAILED',
            interfaceId: proposal.interface_id,
            subject: result.proposal?.subject_id ?? String(id),
            previous: result.response?.before ?? null, next: result.response?.after ?? null,
            result: result.ok ? 'Acknowledged by the mock destination' : result.error,
            correlationId: result.proposal?.correlation_id ?? null,
            detail: { proposalId: id } });
          json(res, result.ok ? 200 : result.held ? 409 : 502, result);
          return true;
        }

        json(res, 404, { error: `Unknown outbound action "${action}".` });
        return true;
      }

      if (method === 'POST' && route === '/demo/force-failure') {
        // The demonstration's failure scenario, made explicit so it can be rehearsed.
        const body = await readBody(req);
        if (body.clear) { clearFailures(); json(res, 200, { cleared: true }); return true; }
        forceFailure(String(body.destination ?? 'P6'),
          String(body.reason ?? 'Destination unavailable (simulated).'));
        json(res, 200, { armed: body.destination ?? 'P6', reason: body.reason ?? null,
          note: 'The next post to that destination will fail once. Explicit rather than random, '
            + 'so the scenario can be rehearsed.' });
        return true;
      }

      /* ── Phase 4: construction progress ─────────────────────────────────────────────── */

      if (method === 'GET' && route === '/progress/activities') {
        json(res, 200, {
          onDate: url.searchParams.get('onDate') ?? null,
          activities: activityList(db, {
            onDate: url.searchParams.get('onDate'),
            level: url.searchParams.get('level'),
            zone: url.searchParams.get('zone'),
            discipline: url.searchParams.get('discipline'),
          }),
          synthetic: true,
        });
        return true;
      }

      if (method === 'GET' && route.startsWith('/progress/activity/')) {
        const id = decodeURIComponent(route.slice('/progress/activity/'.length));
        const detail = activityDetail(db, id, { onDate: url.searchParams.get('onDate') });
        if (!detail) { json(res, 404, { error: `There is no activity ${id}.` }); return true; }
        json(res, 200, { ...detail, synthetic: true });
        return true;
      }

      if (method === 'GET' && route === '/model') {
        json(res, 200, { ...buildModel(db, Object.fromEntries(url.searchParams)),
          facets: modelFacets(db), synthetic: true });
        return true;
      }

      if (method === 'GET' && route === '/p6-drafts') {
        json(res, 200, { drafts: listDrafts(db, Object.fromEntries(url.searchParams)),
          writeBack: WRITE_BACK_STATUS });
        return true;
      }

      if (method === 'POST' && route === '/p6-drafts') {
        const body = await readBody(req);
        const actor = String(body.actor ?? defaultActor).slice(0, 80);
        const result = prepareP6Draft(db, body.activityId, { actor });
        if (!result.ok) { json(res, 400, { error: result.error }); return true; }
        recordAudit(db, { actor, event: 'P6_UPDATE_DRAFTED', interfaceId: 'INT-02',
          subject: body.activityId, previous: `${result.draft.current_pct}%`,
          next: `${result.draft.proposed_pct}%`, result: 'Draft prepared, not submitted',
          detail: { draftId: result.draft.id,
            note: 'Draft only. No value has been posted; it must be raised as an INT-02 '
              + 'proposal and approved by the planner first.' } });
        json(res, 200, { ...result, writeBack: WRITE_BACK_STATUS });
        return true;
      }

      /* ── exceptions ─────────────────────────────────────────────────────────────────── */

      if (method === 'GET' && route === '/exceptions') {
        json(res, 200, {
          ...listExceptions(db, {
            ...Object.fromEntries(url.searchParams),
            includeResolved: url.searchParams.get('includeResolved') === 'true',
          }),
          summary: exceptionSummary(db),
          rules: RULES,
        });
        return true;
      }

      if (method === 'GET' && route.startsWith('/exceptions/')) {
        const detail = exceptionDetail(db, route.slice('/exceptions/'.length));
        if (!detail) { json(res, 404, { error: 'No such exception.' }); return true; }
        json(res, 200, detail);
        return true;
      }

      if (method === 'POST' && route.startsWith('/exceptions/')) {
        const [rawId, action] = route.slice('/exceptions/'.length).split('/');
        if (action !== 'transition') { json(res, 404, { error: `Unknown action "${action}".` }); return true; }
        const body = await readBody(req);
        const actor = String(body.actor ?? defaultActor).slice(0, 80);
        const result = transitionException(db, rawId, body.to, { actor, note: body.note });
        if (!result.ok) { json(res, 400, result); return true; }
        recordAudit(db, { actor, event: 'EXCEPTION_TRANSITION',
          subject: result.exception?.subject_id ?? null,
          previous: body.from ?? null, next: body.to, result: body.to,
          detail: { exceptionId: Number(rawId), rule: result.exception?.rule_id ?? null } });
        json(res, 200, result);
        return true;
      }

      /* ── reconciliation ─────────────────────────────────────────────────────────────── */

      if (method === 'GET' && route === '/reconciliation') {
        json(res, 200, { latest: latestReconciliation(db),
          writeBack: writeBackReconciliation(db), synthetic: true });
        return true;
      }

      if (method === 'POST' && route === '/reconciliation') {
        const body = await readBody(req);
        const actor = String(body.actor ?? defaultActor).slice(0, 80);
        json(res, 200, storeReconciliation(db, reconcile(db), { actor }));
        return true;
      }

      if (method === 'GET' && route === '/sync-runs') {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 25));
        json(res, 200, {
          runs: db.prepare('SELECT * FROM sync_run ORDER BY id DESC LIMIT ?').all(limit),
          errors: db.prepare('SELECT * FROM sync_error ORDER BY id DESC LIMIT ?').all(limit),
        });
        return true;
      }

      if (method === 'GET' && route === '/audit') {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
        json(res, 200, {
          events: db.prepare('SELECT * FROM audit_event ORDER BY id DESC LIMIT ?').all(limit)
            .map(row => ({ ...row, detail: row.detail ? JSON.parse(row.detail) : null })),
        });
        return true;
      }

      if (method === 'POST' && route === '/reset') {
        const body = await readBody(req);
        const actor = String(body.actor ?? defaultActor).slice(0, 80);
        // Scoped by name to this project's own tables (see ALL_TABLES). It cannot reach anything
        // else, because nothing else is in this database.
        clearConstructionDb(db);
        seedSourceSystems(db, buildSeed());
        // The reset itself is the only thing recorded. No run, no success — the normalized side is
        // empty again and the overview must say "never run".
        recordAudit(db, { actor, event: 'DEMO_RESET', subject: 'construction-integration',
          result: 'Deterministic synthetic baseline restored',
          detail: { note: 'Source systems reseeded; synced data, runs, approvals and errors cleared.' } });
        json(res, 200, { reset: true, project: PROJECT, rows: countRows(db),
          overview: overview(db, { adapters: adapterMap() }),
          mapping: mappingSummary(db), exceptions: exceptionSummary(db) });
        return true;
      }

      /* ── Phase 10A: the construction lifecycle ──────────────────────────────────────── */

      /*
       * ACTIVITY-CENTRIC, and assembled from persisted records only. Every figure below comes
       * from the OpenProject snapshot, the approved BIM mappings or the approval tables; nothing
       * is derived from `percentageDone` beyond what the source itself says.
       */
      if (route === '/lifecycle' || route.startsWith('/lifecycle/')) {
        const leaf = route.slice('/lifecycle'.length) || '/';
        const opProject = openProject().projectId();
        const speckleProject = speckle().projectId();
        const speckleModel = speckle().modelId();

        /** Everything persisted about one activity, in one place. */
        const recordsFor = activityId => ({
          mappings: speckleMappings(db, { projectId: speckleProject, modelId: speckleModel })
            .filter(entry => entry.activitySystem === 'OPENPROJECT'
              && String(entry.activityId) === String(activityId)),
          // Phase 10D fills these. Until then they are genuinely empty, and the lifecycle says
          // "not started" rather than inventing a stage.
          submissions: [],
          proposals: [],
          attempts: [],
        });

        /** The activity list, with each one's lifecycle summary. */
        if (method === 'GET' && (leaf === '/activities' || leaf === '/')) {
          const activities = opProject ? storedActivities(db, opProject) : [];
          const onDate = url.searchParams.get('onDate');
          const rows = activities.map(activity => {
            const records = recordsFor(activity.externalActivityId);
            const cycle = lifecycleFor(activity, records);
            return {
              workPackageId: activity.externalActivityId,
              subject: activity.activityName,
              type: activity.activityType,
              status: activity.status,
              reportedProgressPct: activity.reportedProgressPct,
              plannedStart: activity.plannedStart,
              plannedFinish: activity.plannedFinish,
              spentTimeRaw: activity.spentTimeRaw ?? null,
              sourceUpdatedAt: activity.sourceUpdatedAt,
              currentStageId: cycle.currentStageId,
              completedStages: cycle.completedStages,
              totalStages: cycle.totalStages,
              approvedMappings: records.mappings
                .filter(entry => entry.status === 'APPROVED').length,
              conflict: cycle.stages.find(entry => entry.id === 'execute')?.conflict ?? null,
              overdue: overdue(activity, onDate),
              issueCount: issuesFor(activity, records, cycle).length,
            };
          });
          json(res, 200, { projectId: opProject, activities: rows, stages: STAGES,
            stageStatuses: STAGE_STATUS,
            source: { system: 'OPENPROJECT', label: 'OpenProject Cloud' } });
          return true;
        }

        /** One activity's full lifecycle. The Construction Lifecycle workspace's source. */
        if (method === 'GET' && leaf.startsWith('/activity/')) {
          const id = parseOpId(leaf.slice('/activity/'.length));
          if (!id) { json(res, 400, { error: 'A work package id must be a whole number.' }); return true; }
          const activity = (opProject ? storedActivities(db, opProject) : [])
            .find(entry => String(entry.externalActivityId) === id) ?? null;
          if (!activity) { json(res, 404, { error: `No work package ${id} in the stored snapshot.` }); return true; }

          const records = recordsFor(id);
          const cycle = lifecycleFor(activity, records);
          const lastFetchRow = lastSuccessfulFetch(db, opProject);
          json(res, 200, {
            projectId: opProject,
            activity: {
              ...activity,
              /** Built here from the instance origin, never from a returned link. */
              sourceUrl: openProject().baseUrl().ok
                ? `${openProject().baseUrl().baseUrl}/work_packages/${id}` : null,
            },
            lifecycle: cycle,
            issues: issuesFor(activity, records, cycle),
            mappings: records.mappings,
            overdue: overdue(activity, url.searchParams.get('onDate')),
            lastSynchronisedAt: lastFetchRow?.at ?? null,
            /** What OpenProject will and will not accept, from its own schema. */
            writeBack: {
              supported: true,
              method: 'PATCH /api/v3/work_packages/{id}',
              writableFields: OPENPROJECT_WRITABLE,
              readOnlyFields: OPENPROJECT_READ_ONLY,
              proposableFields: PROPOSABLE_FIELDS,
              note: 'The connected token holds `updateImmediately` on this work package, so a '
                + 'write-back is possible. It is NOT wired up yet — Phase 10D builds the '
                + 'proposal, approval and reconciliation path. Nothing here writes to '
                + 'OpenProject.',
            },
            unavailable: LIFECYCLE_UNAVAILABLE,
          });
          return true;
        }

        /**
         * The Project Overview: what needs attention today.
         *
         * Every count is of persisted records. Where a figure cannot be calculated from the data
         * — a delay against a baseline, for instance — it is reported as unavailable with the
         * reason, rather than estimated.
         */
        if (method === 'GET' && leaf === '/overview') {
          const activities = opProject ? storedActivities(db, opProject) : [];
          const onDate = url.searchParams.get('onDate');
          const enriched = activities.map(activity => {
            const records = recordsFor(activity.externalActivityId);
            const cycle = lifecycleFor(activity, records);
            return { activity, records, cycle,
              issues: issuesFor(activity, records, cycle),
              late: overdue(activity, onDate) };
          });

          const pctOf = entry => Number(entry.activity.reportedProgressPct ?? 0);
          const needsAttention = enriched.flatMap(entry => entry.issues.map(issue => ({
            workPackageId: entry.activity.externalActivityId,
            subject: entry.activity.activityName,
            ...issue,
          }))).sort((a, b) => {
            const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
            return (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3);
          });

          const opStatus = speckleWorker && syncWorker().status();
          const speckleStatus = speckleWorker().status();
          const opLast = lastSuccessfulFetch(db, opProject);
          const activeModel = activeVersion(db,
            { projectId: speckleProject, modelId: speckleModel });

          json(res, 200, {
            projectId: opProject,
            schedule: {
              total: enriched.length,
              completed: enriched.filter(entry => pctOf(entry) >= 100).length,
              inProgress: enriched.filter(entry => pctOf(entry) > 0 && pctOf(entry) < 100).length,
              notStarted: enriched.filter(entry => pctOf(entry) <= 0).length,
              overdue: enriched.filter(entry => entry.late).length,
              overdueBasis: LIFECYCLE_UNAVAILABLE.baseline,
            },
            bim: {
              activitiesNeedingMapping: enriched
                .filter(entry => entry.cycle.stages[1].status === STAGE_STATUS.ACTION_REQUIRED)
                .length,
              activitiesWithApprovedMapping: enriched
                .filter(entry => entry.cycle.stages[1].status === STAGE_STATUS.COMPLETED).length,
              mappingsAwaitingDecision: enriched
                .filter(entry => entry.cycle.stages[1].status === STAGE_STATUS.IN_PROGRESS).length,
              acceptedVersion: activeModel
                ? { versionId: activeModel.versionId, label: activeModel.label,
                  elementCount: activeModel.elementCount } : null,
            },
            workflow: {
              progressAwaitingVerification: enriched
                .filter(entry => entry.cycle.stages[3].status === STAGE_STATUS.ACTION_REQUIRED)
                .length,
              approvalsPending: enriched
                .filter(entry => entry.cycle.stages[4].status === STAGE_STATUS.ACTION_REQUIRED)
                .length,
              statusProgressConflicts: enriched
                .filter(entry => entry.cycle.stages[2].conflict).length,
            },
            sources: {
              openProject: { label: 'OpenProject Cloud', state: opStatus?.state ?? 'UNKNOWN',
                enabled: Boolean(opStatus?.enabled), lastSuccessAt: opLast?.at ?? null,
                parked: opStatus?.parkedReason ?? null },
              speckle: { label: 'Speckle Cloud', state: speckleStatus.state,
                enabled: speckleStatus.enabled,
                lastSuccessAt: speckleStatus.lastRun?.finishedAt ?? null,
                parked: speckleStatus.parkedReason ?? null },
              /*
               * NOT CONNECTED, and never pretended otherwise. There is no ERP adapter in this
               * build; the SAP panels elsewhere read a public sandbox for API testing and carry
               * no project financials.
               */
              financial: { label: 'Financial ERP', state: 'NOT_CONNECTED', enabled: false,
                note: 'Financial system not connected — ERP/SAP integration pending. No budget, '
                  + 'actual cost, commitment or earned-value figure in this application is live '
                  + 'financial data.' },
            },
            needsAttention: needsAttention.slice(0, 40),
            needsAttentionTotal: needsAttention.length,
            recentDecisions: db.prepare(`SELECT * FROM audit_event
               WHERE event LIKE 'SPECKLE_%' OR event LIKE 'LIVE_SCHEDULE_LINK%'
                 OR event LIKE '%APPROV%' OR event LIKE '%DECIDED%'
               ORDER BY id DESC LIMIT 12`).all()
              .map(row => ({ id: row.id, at: row.at, actor: row.actor, event: row.event,
                subject: row.subject, result: row.result })),
          });
          return true;
        }

        json(res, 404, { error: `Unknown lifecycle route "${leaf}".` });
        return true;
      }

      /* ── Phase 9B: the real Speckle BIM model ───────────────────────────────────────── */

      /*
       * READ-ONLY against Speckle, and read-only against everything else in this database except
       * the `speckle_*` tables. These routes open no sync run, propose no write-back, map no BIM
       * element to a schedule activity and delete no synthetic element.
       */
      if (route === '/speckle' || route.startsWith('/speckle/')) {
        const leaf = route.slice('/speckle'.length) || '/';
        const projectId = speckle().projectId();
        const modelId = speckle().modelId();
        const frame = extra => ({ source: SPECKLE, ...extra });

        /** The worker's state plus the cached model. Makes NO request to Speckle. */
        if (method === 'GET' && leaf === '/status') {
          const active = activeVersion(db, { projectId, modelId });
          json(res, 200, frame({
            ...speckleWorker().status(),
            projectId, modelId,
            server: speckle().server().ok ? speckle().server().baseUrl : null,
            eventName: SPECKLE_EVENT,
            subscribers: events.size,
            activeVersion: active,
            lastSync: lastSync(db, { projectId, modelId }),
            history: syncLog(db, { projectId, modelId, limit: 10 }),
          }));
          return true;
        }

        /** Every version we have seen, and which one is being served. */
        if (method === 'GET' && leaf === '/models') {
          json(res, 200, frame({ projectId, modelId,
            active: activeVersion(db, { projectId, modelId }),
            versions: speckleVersions(db, { projectId, modelId, limit: 20 }) }));
          return true;
        }

        /**
         * The active model: its version, counts, bounds and the URL of its GLB.
         *
         * The GLB url is BUILT HERE from the stored version id, never taken from a request, so a
         * browser cannot ask for an arbitrary file by naming one.
         */
        if (method === 'GET' && leaf === '/model') {
          const active = activeVersion(db, { projectId, modelId });
          if (!active) {
            json(res, 200, frame({ projectId, modelId, active: null,
              configured: speckle().configured(),
              toolingInstalled: speckle().toolingInstalled(),
              state: speckle().configured() ? SPECKLE_STATE.NOT_READ : SPECKLE_STATE.NOT_CONFIGURED,
              reason: speckle().configured()
                ? 'No Speckle version has been converted yet. Press Sync Now to fetch and convert '
                  + 'the published model.'
                : 'SPECKLE_API_TOKEN is not set on the server. Add it to cesium-poc/.env.local '
                  + 'and restart — the browser never sees it.' }));
            return true;
          }
          json(res, 200, frame({
            projectId, modelId, state: SPECKLE_STATE.CONNECTED,
            configured: speckle().configured(),
            active,
            glbUrl: `${BASE}/speckle/model.glb?version=${encodeURIComponent(active.versionId)}`,
            ifcTypes: ifcTypes(db, active.id),
            elementCount: active.elementCount,
            geometryCount: active.geometryCount,
            lastSync: lastSync(db, { projectId, modelId }),
            /** Where to put the building. Not baked into the geometry — see the manifest. */
            placement: readPlacement(speckleOptions?.env ?? process.env),
          }));
          return true;
        }

        /**
         * The GLB.
         *
         * THE ONLY PATH THAT TOUCHES THE FILESYSTEM, and it accepts no path at all. The caller
         * supplies a version id, which is validated as `[A-Za-z0-9_-]{1,64}`, looked up in the
         * DATABASE, and the directory comes from the stored row. The resolved path is then
         * checked to be inside the artifact root — belt and braces, because a path traversal here
         * would serve any file on the host.
         */
        if (method === 'GET' && leaf === '/model.glb') {
          const asked = url.searchParams.get('version');
          const active = activeVersion(db, { projectId, modelId });
          const versionId = asked ? parseVersionId(asked) : active?.versionId ?? null;
          if (!versionId) {
            json(res, 400, { error: 'A version id must be 1-64 characters of [A-Za-z0-9_-].' });
            return true;
          }
          const row = speckleVersions(db, { projectId, modelId, limit: 200 })
            .find(entry => entry.versionId === versionId && entry.status === 'CONVERTED');
          if (!row) { json(res, 404, { error: `No converted model for version ${versionId}.` }); return true; }

          const root = resolvePath(speckle().artifactRoot());
          const file = resolvePath(join(root, versionId, 'model.glb'));
          if (file !== join(root, versionId, 'model.glb') || !file.startsWith(root + sep)) {
            logger.error?.('[speckle] refused a GLB path outside the artifact root');
            json(res, 400, { error: 'Refused.' });
            return true;
          }
          let info;
          try { info = await stat(file); } catch {
            json(res, 404, { error: `The converted model for ${versionId} is no longer on disk.` });
            return true;
          }
          res.writeHead(200, {
            'content-type': 'model/gltf-binary',
            'content-length': info.size,
            // Immutable by construction: a Speckle version id never names different bytes.
            'cache-control': 'public, max-age=31536000, immutable',
          });
          createReadStream(file).pipe(res);
          return true;
        }

        /** The element list for the active version, optionally filtered by IFC class. */
        if (method === 'GET' && leaf === '/elements') {
          const active = activeVersion(db, { projectId, modelId });
          if (!active) { json(res, 200, frame({ active: null, elements: [], ifcTypes: [] })); return true; }
          const filter = url.searchParams.get('ifcType');
          json(res, 200, frame({
            versionId: active.versionId,
            ifcTypes: ifcTypes(db, active.id),
            elements: speckleElements(db, active.id, { ifcType: filter || null }),
          }));
          return true;
        }

        /** One element by its IFC GlobalId, with every property the model carried. */
        if (method === 'GET' && leaf.startsWith('/elements/')) {
          const guid = decodeURIComponent(leaf.slice('/elements/'.length));
          const active = activeVersion(db, { projectId, modelId });
          if (!active) { json(res, 404, { error: 'No model is loaded.' }); return true; }
          const element = elementDetail(db, active.id, guid);
          if (!element) { json(res, 404, { error: `No element with IFC GlobalId ${guid}.` }); return true; }
          json(res, 200, frame({ versionId: active.versionId, element }));
          return true;
        }

        /**
         * Check Speckle now, and convert if the published version is new.
         *
         * The SAME worker and the same lock the timer uses. Gated on a demo session, like every
         * other route here that reaches outside the process.
         */
        if (method === 'POST' && leaf === '/sync') {
          const session = sessionFor(db, req.headers['x-demo-session']);
          if (!may(session, 'monitor')) {
            json(res, 403, { error: refusal(session, 'monitor'), permission: 'monitor' });
            return true;
          }
          const result = await speckleWorker().run(
            { trigger: SPECKLE_TRIGGER.MANUAL, by: session.actor });
          json(res, 200, frame({
            run: result,
            coalesced: Boolean(result.coalesced),
            throttled: Boolean(result.throttled),
            converted: Boolean(result.converted),
            unchanged: result.status === SPECKLE_RUN_STATUS.UNCHANGED,
            status: speckleWorker().status(),
            active: activeVersion(db, { projectId, modelId }),
            effect: 'A read of Speckle. No Speckle model was modified, no schedule activity was '
              + 'mapped, and no synthetic BIM, P6, SYNCHRO, SAP or ACC record was changed.',
          }));
          return true;
        }

        /**
         * The notification stream, on the SAME hub the OpenProject stream uses.
         *
         * Its own URL rather than a shared one so each panel subscribes to what it cares about
         * and neither has to know the other exists; the hub is shared, so a second subscriber
         * costs a socket and nothing else. Ids and counts only — no geometry, no credential.
         */
        if (method === 'GET' && leaf === '/events') {
          const accepted = events.subscribe(req, res, {
            hello: { event: 'speckle-sync-hello',
              data: { event: 'speckle-sync-hello', eventName: SPECKLE_EVENT,
                projectId, modelId, status: speckleWorker().status() } },
          });
          if (!accepted) {
            json(res, 503, { error: 'Too many event subscribers, or the server is shutting down. '
              + 'The model can still be read from /speckle/model.' });
          }
          return true;
        }

        /* ── Phase 9C: version history, comparison and the manual mapping ───────────── */

        /** The construction timeline: every version, oldest first, with its change counts. */
        if (method === 'GET' && leaf === '/timeline') {
          const entries = timeline(db, { projectId, modelId })
            // The camera frames THIS, not the raw bounding sphere — see `focusBounds`.
            .map(entry => ({ ...entry,
              focusBounds: entry.status === 'CONVERTED' ? focusBounds(db, entry.id) : null }));
          const converted = entries.filter(entry => entry.status === 'CONVERTED');
          json(res, 200, frame({
            projectId, modelId,
            versions: entries,
            converted: converted.length,
            discovered: entries.length,
            activeVersionId: activeVersion(db, { projectId, modelId })?.versionId ?? null,
            baselineVersionId: converted[0]?.versionId ?? null,
            latestVersionId: converted[converted.length - 1]?.versionId ?? null,
            placement: readPlacement(speckleOptions?.env ?? process.env),
            /** Said on the endpoint a timeline is built from, because it is the misreading. */
            caveat: 'These are published DESIGN versions. A version appearing here means the '
              + 'model was published, not that anything was built.',
          }));
          return true;
        }

        /**
         * Compare two versions.
         *
         * `from` and `to` are version ids, validated. The comparison is read from the cache and
         * computed on demand if it is missing — a reader asking for a pair the worker has not
         * got to should get an answer, not a blank screen.
         */
        if (method === 'GET' && leaf === '/compare') {
          const from = parseVersionId(url.searchParams.get('from'));
          const to = parseVersionId(url.searchParams.get('to'));
          if (!from || !to) {
            json(res, 400, { error: 'Both "from" and "to" must be Speckle version ids.' });
            return true;
          }
          const query = { projectId, modelId, fromVersionId: from, toVersionId: to,
            kind: url.searchParams.get('kind'), ifcType: url.searchParams.get('ifcType'),
            search: url.searchParams.get('q'),
            limit: Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 500)) };
          let result = comparison(db, query);
          if (!result) {
            saveComparison(db, { projectId, modelId, fromVersionId: from, toVersionId: to });
            result = comparison(db, query);
          }
          if (!result) {
            json(res, 404, { error: `No comparison is available between ${from} and ${to}. `
              + 'Both versions must be converted first.' });
            return true;
          }
          json(res, 200, frame({ projectId, modelId, ...result,
            caveat: 'A comparison of two published designs. Nothing here is a statement about '
              + 'what has been built.' }));
          return true;
        }

        /** The elements of ONE version — the timeline needs any version, not just the active one. */
        if (method === 'GET' && leaf === '/versions/elements') {
          const asked = parseVersionId(url.searchParams.get('version'));
          if (!asked) { json(res, 400, { error: 'A version id is required.' }); return true; }
          const row = speckleVersions(db, { projectId, modelId, limit: 500 })
            .find(entry => entry.versionId === asked && entry.status === 'CONVERTED');
          if (!row) { json(res, 404, { error: `Version ${asked} is not converted.` }); return true; }
          const seen = firstSeenByGuid(db, { projectId, modelId });
          json(res, 200, frame({
            versionId: asked,
            version: row,
            ifcTypes: ifcTypes(db, row.id),
            elements: speckleElements(db, row.id, { ifcType: url.searchParams.get('ifcType') })
              // "First appeared in V3" is the question the timeline makes askable, and it is a
              // fact about the model's history rather than about this version.
              .map(entry => ({ ...entry, firstSeenOrdinal: seen.get(entry.ifcGuid) ?? null })),
          }));
          return true;
        }

        /**
         * The element↔activity mappings, and the candidates for one.
         *
         * Candidates are OFFERED, never applied: the activity list comes from the live
         * OpenProject snapshot and the synthetic P6 table, and a person picks. Nothing here
         * guesses a link from a name — the model contains six elements called "girder".
         */
        if (method === 'GET' && leaf === '/mappings') {
          const openProjectRows = storedActivities(db, openProject().projectId() ?? '')
            .map(entry => ({ system: 'OPENPROJECT', activityId: String(entry.externalActivityId),
              name: entry.activityName, status: entry.status,
              plannedStart: entry.plannedStart, plannedFinish: entry.plannedFinish,
              progressPct: entry.reportedProgressPct }));
          const p6Rows = syntheticP6Activities(db).map(entry => ({ system: 'P6',
            activityId: entry.activityId, name: entry.name, status: null,
            plannedStart: entry.plannedStart ?? null, plannedFinish: entry.plannedFinish ?? null,
            progressPct: entry.pctComplete ?? null, synthetic: true }));
          json(res, 200, frame({
            projectId, modelId,
            mappings: speckleMappings(db, { projectId, modelId }),
            statuses: MAPPING_STATUS,
            permission: MAPPING_PERMISSION,
            candidates: { openProject: openProjectRows, p6: p6Rows },
            effect: 'A mapping links a real IFC element to a schedule activity for REPORTING. '
              + 'Construction completion still comes from the activity\'s verified status; '
              + 'publishing a model version is never a completion event.',
          }));
          return true;
        }

        /** Propose a mapping. A person decides; nothing automatic reaches this. */
        if (method === 'POST' && leaf === '/mappings') {
          const session = sessionFor(db, req.headers['x-demo-session']);
          if (!may(session, 'monitor')) {
            json(res, 403, { error: refusal(session, 'monitor'), permission: 'monitor' });
            return true;
          }
          const body = await readBody(req);
          const guid = String(body.ifcGuid ?? '').trim();
          const system = String(body.activitySystem ?? '').trim().toUpperCase();
          const activityId = String(body.activityId ?? '').trim();
          if (!guid || !activityId || !['OPENPROJECT', 'P6'].includes(system)) {
            json(res, 400, { error: 'ifcGuid, activitySystem (OPENPROJECT or P6) and activityId '
              + 'are all required.' });
            return true;
          }
          const result = proposeElementMapping(db, { projectId, modelId, ifcGuid: guid,
            activitySystem: system, activityId,
            activityName: body.activityName == null ? null : String(body.activityName).slice(0, 200),
            basis: String(body.basis ?? 'MANUAL').slice(0, 80),
            evidence: { chosenBy: session.actor, note: body.note ?? null },
            actor: session.actor });
          json(res, 200, frame(result));
          return true;
        }

        /** Approve or reject a proposed mapping. The planner owns the schedule. */
        if (method === 'POST' && leaf.startsWith('/mappings/')) {
          const match = /^(\d+)\/(approve|reject)$/.exec(leaf.slice('/mappings/'.length));
          if (!match) { json(res, 404, { error: 'Try POST /speckle/mappings/<id>/approve or /reject' }); return true; }
          const session = sessionFor(db, req.headers['x-demo-session']);
          if (!may(session, MAPPING_PERMISSION)) {
            json(res, 403, { error: refusal(session, MAPPING_PERMISSION),
              permission: MAPPING_PERMISSION });
            return true;
          }
          const body = await readBody(req);
          const outcome = decideMapping(db, { mappingId: match[1],
            decision: match[2] === 'approve' ? MAPPING_STATUS.APPROVED : MAPPING_STATUS.REJECTED,
            actor: session.actor,
            note: body.note == null ? null : String(body.note).slice(0, 500) });
          if (!outcome.ok) { json(res, 400, outcome); return true; }
          json(res, 200, frame({ ...outcome,
            effect: 'The link is recorded. No construction progress was created: completion '
              + 'still comes from the activity\'s own verified status.' }));
          return true;
        }

        json(res, 404, { error: `Unknown Speckle route "${leaf}".` });
        return true;
      }

      /* ── Phase 8A: the live OpenProject schedule ────────────────────────────────────── */

      /*
       * READ-ONLY, GET-ONLY against OpenProject, with one POST that decides a LOCAL mapping
       * proposal and still writes nothing upstream.
       *
       * These routes sit AFTER the database check, unlike the SAP ones: change detection needs
       * the snapshot store, so without the database there is nothing useful to answer. They open
       * no sync run, propose no write-back, and touch no table outside `live_schedule_*`.
       */
      if (route === '/openproject' || route.startsWith('/openproject/')) {
        const leaf = route.slice('/openproject'.length) || '/';
        const pid = openProject().projectId();

        /**
         * The BIM selection a task was created from, validated.
         *
         * The brief's rule, enforced here rather than trusted: "Do not send arbitrary Cesium
         * entity IDs as IFC identifiers." A Cesium feature id is a per-load array index and means
         * nothing in Speckle or OpenProject, so only a plausible IFC GlobalId is accepted. The
         * project and model ids are taken from the SERVER's configuration and never from the
         * body, so a crafted request cannot map elements into some other model.
         */
        const readBimContext = raw => {
          if (raw == null) return { context: null };
          const elements = Array.isArray(raw.elements) ? raw.elements : [];
          if (!elements.length) {
            return { error: 'A BIM context must name at least one element.' };
          }
          if (elements.length > 200) {
            return { error: 'At most 200 elements may be linked to one task at a time.' };
          }
          const clean = [];
          for (const entry of elements) {
            const guid = String(entry?.ifcGuid ?? '').trim();
            // An IFC GlobalId is 22 characters of IFC's own base64 alphabet. A Cesium feature id
            // ("0", "17") cannot pass this, which is the point.
            if (!/^[0-9A-Za-z_$]{20,24}$/.test(guid)) {
              return { error: `"${guid.slice(0, 40)}" is not an IFC GlobalId. The selection must `
                + 'carry stable IFC identifiers, not viewer feature ids.' };
            }
            clean.push({ ifcGuid: guid,
              ifcType: entry?.ifcType == null ? null : String(entry.ifcType).slice(0, 80),
              name: entry?.name == null ? null : String(entry.name).slice(0, 200),
              storey: entry?.storey == null ? null : String(entry.storey).slice(0, 120) });
          }
          const seen = new Set();
          const unique = clean.filter(e => !seen.has(e.ifcGuid) && seen.add(e.ifcGuid));
          return { context: {
            speckleProjectId: speckle().projectId(),
            speckleModelId: speckle().modelId(),
            versionId: raw.versionId == null ? null : String(raw.versionId).slice(0, 64),
            versionLabel: raw.versionLabel == null ? null : String(raw.versionLabel).slice(0, 32),
            elements: unique } };
        };

        /**
         * Propose — never approve — a mapping for each selected element.
         *
         * Creating a task from geometry is evidence that somebody BELIEVES these elements are what
         * it builds. It is not the BIM Coordinator's decision, and the brief is explicit that it
         * must not stand in for one. Every row goes in as PROPOSED, through the same
         * `proposeMapping` the manual workbench uses, so there is one definition of a mapping and
         * one approval path.
         */
        const mappingProposer = (context, session) => async ({ activity }) => {
          if (!context?.elements?.length) {
            return { ok: false, error: 'No BIM elements were selected.' };
          }
          const proposed = [];
          const failed = [];
          for (const element of context.elements) {
            try {
              const result = proposeElementMapping(db, {
                projectId: context.speckleProjectId, modelId: context.speckleModelId,
                ifcGuid: element.ifcGuid, activitySystem: 'OPENPROJECT',
                activityId: String(activity.externalActivityId),
                activityName: activity.activityName ?? null,
                basis: 'CREATED_FROM_SELECTION',
                evidence: { chosenBy: session.actor, versionId: context.versionId,
                  versionLabel: context.versionLabel, ifcType: element.ifcType,
                  elementName: element.name,
                  note: 'Selected in the 3D model when this task was created. A selection is a '
                    + 'proposal, not an approval.' },
                actor: session.actor });
              if (result.ok) proposed.push({ ifcGuid: element.ifcGuid, status: result.mapping?.status });
              else failed.push({ ifcGuid: element.ifcGuid, error: result.error });
            } catch (error) {
              failed.push({ ifcGuid: element.ifcGuid, error: String(error?.message ?? error) });
            }
          }
          return { ok: failed.length === 0 && proposed.length > 0,
            proposed: proposed.length, failed,
            status: MAPPING_STATUS.PROPOSED,
            note: `${proposed.length} element mapping(s) proposed. They are PROPOSED, not `
              + 'approved: a BIM Coordinator decides whether these elements are what this '
              + 'activity builds.' };
        };

        /** Every response says what this source is and what it is not. */
        const frame = extra => ({ source: OP_SOURCE, ...extra });

        /* ── Phase 10B: creating a work package in the real instance ────────────────────── */

        /**
         * What the instance will accept, read from the instance.
         *
         * The create form needs OpenProject's own types, statuses and priorities, and whether
         * this token may create at all. None of it is hardcoded: OpenProject omits the
         * `createWorkPackage` link for a user who may not create one, so the absence of that link
         * IS the permission answer and no speculative POST is needed to discover it.
         */
        if (method === 'GET' && leaf === '/create/options') {
          const session = sessionFor(db, req.headers['x-demo-session']);
          const permitted = may(session, CREATE_PERMISSION);
          const endpoints = await openProject().createEndpoints();
          json(res, 200, frame({
            projectId: pid,
            /** Two separate answers, and a screen must show the right one. */
            permittedHere: permitted,
            permissionNote: permitted ? null : refusal(session, CREATE_PERMISSION),
            sourcePermits: Boolean(endpoints.endpoints),
            sourceNote: endpoints.endpoints ? null : endpoints.reason,
            endpoints: endpoints.endpoints,
            state: endpoints.state,
            ...(await openProject().createMetadata()),
          }));
          return true;
        }

        /**
         * Create a work package. THE ONLY ROUTE IN THIS APPLICATION THAT WRITES TO A LIVE SOURCE.
         *
         * `idempotencyKey` is required and is the client's, not ours: a key the server minted per
         * request would be a new key on every retry, which is the opposite of what one is for.
         * The same key always answers with the same attempt — one work package per key, forever.
         */
        if (method === 'POST' && leaf === '/work-packages') {
          const session = sessionFor(db, req.headers['x-demo-session']);
          if (!may(session, CREATE_PERMISSION)) {
            json(res, 403, { error: refusal(session, CREATE_PERMISSION),
              permission: CREATE_PERMISSION });
            return true;
          }
          if (!pid) {
            json(res, 400, { error: 'OPENPROJECT_PROJECT_ID is not a whole number, so there is '
              + 'no project to create in.' });
            return true;
          }
          const body = await readBody(req);
          const key = String(body.idempotencyKey ?? '').trim();
          if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) {
            json(res, 400, { error: 'idempotencyKey is required: 8-128 characters of letters, '
              + 'digits, hyphen or underscore. It is what stops a repeated submission from '
              + 'creating a second work package.' });
            return true;
          }
          const check = validateRequest(body.fields ?? {});
          if (!check.ok) {
            json(res, 400, { error: 'Some fields need attention.', fieldErrors: check.errors });
            return true;
          }
          const bim = readBimContext(body.bim);
          if (bim.error) { json(res, 400, { error: bim.error }); return true; }

          const claimed = claim(db, { idempotencyKey: key, requested: body.fields,
            bimContext: bim.context, actor: session.actor, actorRole: session.role,
            projectId: pid });
          if (!claimed.ok) { json(res, 400, claimed); return true; }
          if (!claimed.created && isSettled(claimed.creation.status)) {
            // A repeat of a key that already has an answer. Returned, never re-sent.
            json(res, 200, frame({ creation: claimed.creation, repeat: true,
              note: 'This request has already been submitted; its outcome is shown as it '
                + 'stands.' }));
            return true;
          }
          /* Still in flight: fall through, so this caller JOINS the attempt already running and
             gets its real outcome rather than a row that is true but has no id in it yet. */

          const outcome = await runCreation(db, claimed.creation.id, {
            adapter: openProject(), actor: session.actor,
            onCreated: bim.context ? mappingProposer(bim.context, session) : null });
          json(res, outcome.ok ? 200 : (outcome.outcomeUnknown ? 202 : 400), frame({
            ...outcome, creation: outcome.creation ?? creationById(db, claimed.creation.id) }));
          return true;
        }

        /** Every creation attempt, newest first. The audit a person reads after the fact. */
        if (method === 'GET' && leaf === '/work-packages/creations') {
          json(res, 200, frame({ creations: creations(db, { limit: 50 }),
            unresolved: unresolved(db) }));
          return true;
        }

        /** One attempt, by the key the browser holds. How a refreshed page finds its own work. */
        if (method === 'GET' && leaf.startsWith('/work-packages/creations/')) {
          const key = decodeURIComponent(leaf.slice('/work-packages/creations/'.length));
          const found = creationByKey(db, key) ?? creationById(db, Number(key) || -1);
          if (!found) { json(res, 404, { error: 'No creation request by that key.' }); return true; }
          json(res, 200, frame({ creation: found }));
          return true;
        }

        /**
         * Resolve an attempt whose outcome is unknown, BY LOOKING.
         *
         * Not a retry and deliberately not named one. It searches the source for this request's
         * marker and adopts what it finds; it never sends another create.
         */
        if (method === 'POST' && /^\/work-packages\/creations\/\d+\/reconcile$/.test(leaf)) {
          const session = sessionFor(db, req.headers['x-demo-session']);
          if (!may(session, CREATE_PERMISSION)) {
            json(res, 403, { error: refusal(session, CREATE_PERMISSION),
              permission: CREATE_PERMISSION });
            return true;
          }
          const id = Number(/(\d+)/.exec(leaf)[1]);
          const row = creationById(db, id);
          if (!row) { json(res, 404, { error: `No creation request ${id}.` }); return true; }
          const outcome = await reconcileUnknown(db, id, { adapter: openProject(),
            actor: session.actor,
            onCreated: row.bimContext ? mappingProposer(row.bimContext, session) : null });
          json(res, 200, frame(outcome));
          return true;
        }

        /** Retry ONLY the BIM mapping. Touches no external system, so it cannot duplicate a task. */
        if (method === 'POST' && /^\/work-packages\/creations\/\d+\/retry-mapping$/.test(leaf)) {
          const session = sessionFor(db, req.headers['x-demo-session']);
          if (!may(session, CREATE_PERMISSION)) {
            json(res, 403, { error: refusal(session, CREATE_PERMISSION),
              permission: CREATE_PERMISSION });
            return true;
          }
          const id = Number(/(\d+)/.exec(leaf)[1]);
          const row = creationById(db, id);
          if (!row) { json(res, 404, { error: `No creation request ${id}.` }); return true; }
          const outcome = await retryMapping(db, id, { actor: session.actor,
            onCreated: mappingProposer(row.bimContext, session) });
          json(res, outcome.ok ? 200 : 400, frame(outcome));
          return true;
        }

        /* ── Phase 8B: the automatic synchronisation worker ──────────────────────────────── */

        /**
         * What the worker is doing. A pure read of in-process state plus the stored history.
         *
         * No OpenProject request is made here, which is why a screen may poll it: asking "are you
         * polling?" must not itself become a poll of somebody's cloud instance.
         */
        if (method === 'GET' && leaf === '/sync/status') {
          const worker = syncWorker();
          const projectId = pid;
          json(res, 200, frame({
            ...worker.status(),
            projectId,
            autoSyncMounted: autoSync,
            subscribers: events.size,
            eventName: SYNC_EVENT,
            /** The last run as the DATABASE has it, which outlives this process. */
            history: projectId ? liveScheduleRuns(db, projectId, { limit: 10 }) : [],
            lastSuccessfulFetchAt: projectId ? lastSuccessfulFetch(db, projectId)?.at ?? null : null,
          }));
          return true;
        }

        /**
         * Sync now.
         *
         * THE SAME FUNCTION the timer calls, so the lock is shared by construction rather than by
         * two implementations agreeing: a manual run that arrives mid-cycle joins the running one
         * and says so. Nothing is sent to OpenProject but GETs.
         *
         * Gated on the demo session, like every other state-changing route here: the role comes
         * from the server-issued token and never from the body. Worth being plain about what that
         * is and is not — `issueSession` authenticates nobody (see auth.mjs), so this stops an
         * honest screen from triggering outbound reads without a chosen role, and stops nothing
         * else. The control that actually bounds the outbound rate is the worker's own lock and
         * its floor on consecutive manual runs.
         */
        if (method === 'POST' && leaf === '/sync/run') {
          const session = sessionFor(db, req.headers['x-demo-session']);
          if (!may(session, 'monitor')) {
            json(res, 403, { error: refusal(session, 'monitor'), permission: 'monitor' });
            return true;
          }
          const result = await syncWorker().run({ trigger: TRIGGER.MANUAL, by: session.actor });
          const projectId = pid;
          // 200 for every REPORTED outcome, SKIPPED included: "a run was already going" is this
          // endpoint's answer, not a failure of it.
          json(res, 200, frame({
            run: result,
            /** True when this request joined a run rather than starting one. */
            coalesced: Boolean(result.coalesced),
            throttled: Boolean(result.throttled),
            skipped: result.runStatus === RUN_STATUS.SKIPPED,
            status: syncWorker().status(),
            lastSuccessfulFetchAt: projectId ? lastSuccessfulFetch(db, projectId)?.at ?? null : null,
            effect: 'A read. No synchronisation run was opened against SYNCHRO 4D, no write-back '
              + 'was proposed, and no P6, SAP, ACC or BIM record was created or updated.',
          }));
          return true;
        }

        /** Every run, newest first — SKIPPED ones included, because they explain the gaps. */
        if (method === 'GET' && leaf === '/sync/history') {
          const projectId = pid;
          if (!projectId) { json(res, 400, { error: 'OPENPROJECT_PROJECT_ID is not a whole number.' }); return true; }
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
          json(res, 200, frame({ projectId, runs: liveScheduleRuns(db, projectId, { limit }),
            statuses: RUN_STATUS, triggers: TRIGGER }));
          return true;
        }

        /**
         * The notification stream.
         *
         * Held open; never ended by us. It carries ids and counts and NOTHING ELSE — no work
         * package payload, and self-evidently no credential — so a client re-reads
         * `/work-packages` when it hears one. That keeps a single normalizing path for the data
         * and makes a dropped event cost a reader one interval rather than a wrong screen.
         */
        if (method === 'GET' && leaf === '/events') {
          const worker = syncWorker();
          const accepted = events.subscribe(req, res, {
            hello: { event: 'openproject-sync-hello',
              data: { event: 'openproject-sync-hello', eventName: SYNC_EVENT,
                projectId: pid, status: worker.status() } },
          });
          if (!accepted) {
            json(res, 503, { error: 'Too many event subscribers, or the server is shutting down. '
              + 'The schedule can still be read from /openproject/work-packages.' });
          }
          return true;
        }

        if (method === 'GET' && leaf === '/health') {
          const result = await openProject().health();
          const last = lastSuccessfulFetch(db, pid ?? '');
          json(res, 200, frame({ ...result,
            /** When data was last successfully READ, separate from this probe's own result. */
            lastSuccessfulFetchAt: last?.at ?? null,
            storedActivityCount: last ? last.records_received : 0 }));
          return true;
        }

        if (method === 'GET' && leaf === '/project') {
          json(res, 200, frame(await openProject().project()));
          return true;
        }

        /**
         * The stored schedule. Reads the snapshot store, NOT OpenProject.
         *
         * Separate from `/refresh` on purpose: opening the screen must not poll an external system,
         * and a reader must be able to tell "this is what we last saw" from "this is what it says
         * right now". Everything here is dated and marked stale when the last read failed.
         */
        if (method === 'GET' && leaf === '/work-packages') {
          const projectId = pid;
          if (!projectId) { json(res, 400, { error: 'OPENPROJECT_PROJECT_ID is not a whole number.' }); return true; }
          const latest = lastFetch(db, projectId);
          const success = lastSuccessfulFetch(db, projectId);
          const activities = storedActivities(db, projectId);
          const stale = Boolean(latest && success && latest.id !== success.id);
          /**
           * What this VIEW knows, which is not what a live probe would find.
           *
           * No request is made here, so the state is reported from the last read: the last
           * outcome if there was one, NOT_CONFIGURED if there is no token, and NOT_READ if we are
           * configured and simply have not asked yet. Never CONNECTED on the strength of an old
           * read — that would be claiming a connection this request did not test.
           */
          const state = !openProject().configured() ? OP_STATE.NOT_CONFIGURED
            : latest ? latest.state : OP_STATE.NOT_READ;
          /**
           * The project header, recovered from a stored activity rather than re-read.
           *
           * Every normalized activity carries the project name and identifier it was read under,
           * so the stored view can name the project without a request. Absent until something has
           * been read, which is correct: before the first read we genuinely only know its id.
           */
          const known = activities.find(entry => entry.sourceProjectName) ?? null;
          const project = known ? { id: known.sourceProjectId,
            identifier: known.sourceProjectIdentifier, name: known.sourceProjectName } : null;
          /**
           * The conversion basis the stored figures were produced under.
           *
           * Taken from the snapshot rather than re-derived, because that is the basis these
           * numbers actually carry: if the basis changed since they were written, the stored view
           * must still say what they mean, not what a fresh read would mean.
           */
          const dated = activities.find(entry => entry.hoursPerDay != null) ?? null;
          const duration = dated
            ? { hoursPerDay: dated.hoursPerDay, basis: dated.durationBasis,
              note: 'the basis these stored figures were converted under' }
            : null;
          json(res, 200, frame({
            configured: openProject().configured(),
            state,
            failure: latest?.failure ?? null,
            httpStatus: latest?.http_status ?? null,
            elapsedMs: latest?.elapsed_ms ?? null,
            project,
            duration,
            reason: openProject().configured() ? latest?.reason ?? null
              : 'OPENPROJECT_API_TOKEN is not set on the server. Add it to cesium-poc/.env.local '
                + 'and restart — the browser never sees it.',
            apiVersion: openProject().baseUrl().ok ? 'v3' : null,
            instance: openProject().baseUrl().ok ? openProject().baseUrl().baseUrl : null,
            projectId,
            activities,
            returned: activities.length,
            collectionTotal: success?.collection_total ?? null,
            /*
             * The filter POLICY, on the stored view as well as on a fresh read.
             *
             * It is a constant fact about how this adapter asks — OpenProject filters the
             * work-package collection to open statuses unless told otherwise — not a property of
             * one request. It used to appear only on the `/refresh` response, which meant the
             * query-parameters disclosure vanished the moment a background cycle replaced the
             * report with this view. Caught in the browser, not in a test.
             */
            filtersApplied: [{ name: 'filters', value: NO_FILTER,
              reason: 'OpenProject filters the work-package collection to open statuses when no '
                + 'filter is given, so a completed activity would be silently absent. An empty '
                + 'filter list asks for every status.' }],
            lastFetch: latest ? { at: latest.at, state: latest.state, failure: latest.failure,
              httpStatus: latest.http_status, reason: latest.reason } : null,
            lastSuccessfulFetchAt: success?.at ?? null,
            /** Never dressed up as fresh: a failed refresh leaves the rows AND says they are old. */
            stale,
            staleReason: stale
              ? `The last refresh at ${latest.at} ${latest.state === 'NOT_CONFIGURED'
                ? 'was not attempted because the token is missing'
                : `failed (${latest.reason ?? latest.state})`}. These activities are what `
                + `OpenProject returned at ${success?.at ?? 'an earlier read'} and may be out of date.`
              : null,
            links: opLinks(db, projectId),
            changes: changeLog(db, projectId, { limit: 50 }),
            fetches: fetchLog(db, projectId, { limit: 10 }),
          }));
          return true;
        }

        /** One stored activity, with its live detail, candidates, link and comparison. */
        if (method === 'GET' && leaf.startsWith('/work-packages/')) {
          const id = parseOpId(leaf.slice('/work-packages/'.length));
          if (!id) { json(res, 400, { error: 'A work-package id must be a whole number.' }); return true; }
          const projectId = pid;
          const detail = await openProject().workPackage(id);
          const stored = storedActivities(db, projectId ?? '')
            .find(entry => String(entry.externalActivityId) === id) ?? null;
          const activity = detail.state === OP_STATE.CONNECTED ? detail.activity : stored;
          const synthetic = syntheticP6Activities(db);
          const link = opLinks(db, projectId ?? '')
            .find(entry => String(entry.externalId) === id) ?? null;
          const target = link
            ? synthetic.find(entry => entry.activityId === link.targetActivityId) ?? null : null;
          json(res, 200, frame({
            ...detail,
            activity,
            /** True when OpenProject could not be read and this is the stored copy instead. */
            fromSnapshot: detail.state !== OP_STATE.CONNECTED && Boolean(stored),
            candidates: activity ? candidatesFor(activity, synthetic) : [],
            link,
            comparison: compare({ link, activity, target }),
            changes: changeLog(db, projectId ?? '', { externalId: id, limit: 50 }),
          }));
          return true;
        }

        /**
         * Read OpenProject now, diff it against the snapshots, store the findings.
         *
         * POST because it records something — a read event, snapshots, change rows. It issues no
         * write to OpenProject, opens no `sync_run` and creates no approval request: a refresh is
         * a read, and the audit event it writes says so in its own words.
         */
        if (method === 'POST' && leaf === '/refresh') {
          const body = await readBody(req);
          const actor = String(body.actor ?? defaultActor).slice(0, 80);
          const projectId = pid;
          if (!projectId) { json(res, 400, { error: 'OPENPROJECT_PROJECT_ID is not a whole number.' }); return true; }

          /*
           * THROUGH THE WORKER, not around it.
           *
           * Before Phase 8B this route did its own `workPackages()` → `applyFetch()`. With a
           * background worker doing the same thing on a timer, that would have been two code
           * paths writing the same tables with nothing between them: press Refresh Schedule 200 ms
           * into a scheduled cycle and both would walk the collection and both would write. Going
           * through `run()` means there is exactly ONE writer and one lock, and a refresh that
           * arrives mid-cycle joins the cycle instead of racing it.
           *
           * The response shape is unchanged — `run.detail` carries the adapter result the route
           * used to hold itself.
           */
          const run = await syncWorker().run({ trigger: TRIGGER.MANUAL, by: actor });
          const result = run.detail?.result ?? null;

          /*
           * A run that joined another, or was throttled, read nothing of its own. Answering with
           * the stored view and the run's own words is the honest outcome; inventing counts for a
           * read this request did not perform is not.
           */
          if (!result) {
            const success = lastSuccessfulFetch(db, projectId);
            const latest = lastFetch(db, projectId);
            const activities = storedActivities(db, projectId);
            json(res, 200, frame({
              state: latest?.state ?? OP_STATE.NOT_READ, run,
              skipped: true, throttled: Boolean(run.throttled),
              reason: run.reason ?? null,
              activities, returned: activities.length,
              collectionTotal: success?.collection_total ?? null,
              lastSuccessfulFetchAt: success?.at ?? null,
              counts: null, diffs: [],
              links: opLinks(db, projectId),
              changes: changeLog(db, projectId, { limit: 50 }),
              fetches: fetchLog(db, projectId, { limit: 10 }),
            }));
            return true;
          }

          if (result.state !== OP_STATE.CONNECTED && result.state !== OP_STATE.PARTIAL) {
            const success = lastSuccessfulFetch(db, projectId);
            const activities = storedActivities(db, projectId);
            // 200 for a REPORTED state: "not configured" and "auth failed" are findings this
            // endpoint exists to deliver, not failures of the endpoint itself.
            json(res, 200, frame({ ...result, fetchId: run.fetchId, run,
              activities,
              stale: activities.length > 0,
              staleReason: activities.length > 0
                ? `This read failed (${result.reason ?? result.state}). The ${activities.length} `
                  + `activities shown are from ${success?.at ?? 'an earlier read'} and the stored `
                  + 'snapshot was left untouched.'
                : null,
              lastSuccessfulFetchAt: success?.at ?? null,
              counts: { activities: activities.length, new: 0, changed: 0, unchanged: 0,
                findings: 0, byKind: {} },
              diffs: [], links: opLinks(db, projectId),
              changes: changeLog(db, projectId, { limit: 50 }),
              fetches: fetchLog(db, projectId, { limit: 10 }) }));
            return true;
          }

          // Applied and proposed BY THE WORKER, under its lock. Candidates are proposed, never
          // applied: nothing on this path writes to src_p6_activity.
          const applied = run.detail.applied;
          const proposed = run.detail.proposed;
          json(res, 200, frame({ ...result,
            run,
            fetchId: applied.fetchId,
            counts: applied.counts,
            diffs: applied.diffs,
            changeRowsWritten: applied.changeRows,
            stale: false,
            staleReason: null,
            lastSuccessfulFetchAt: applied.at,
            proposedLinks: proposed,
            links: opLinks(db, projectId),
            changes: changeLog(db, projectId, { limit: 50 }),
            fetches: fetchLog(db, projectId, { limit: 10 }),
            /** Stated on the response that could most easily be mistaken for a synchronisation. */
            effect: 'A read. No synchronisation run was opened, no write-back was proposed, and no '
              + 'SYNCHRO 4D, P6, SAP or ACC record was created or updated.' }));
          return true;
        }

        if (method === 'GET' && leaf === '/changes') {
          const projectId = pid;
          if (!projectId) { json(res, 400, { error: 'OPENPROJECT_PROJECT_ID is not a whole number.' }); return true; }
          json(res, 200, frame({
            projectId,
            changes: changeLog(db, projectId,
              { externalId: url.searchParams.get('activity'), limit: url.searchParams.get('limit') }),
            fetches: fetchLog(db, projectId, { limit: 25 }),
          }));
          return true;
        }

        /** The candidate links, with the synthetic P6 activities they point at. */
        if (method === 'GET' && leaf === '/links') {
          const projectId = pid;
          if (!projectId) { json(res, 400, { error: 'OPENPROJECT_PROJECT_ID is not a whole number.' }); return true; }
          const synthetic = syntheticP6Activities(db);
          const stored = storedActivities(db, projectId);
          const list = opLinks(db, projectId).map(link => {
            const activity = stored.find(entry =>
              String(entry.externalActivityId) === String(link.externalId)) ?? null;
            const target = synthetic.find(entry => entry.activityId === link.targetActivityId) ?? null;
            return { ...link, activity, target, comparison: compare({ link, activity, target }) };
          });
          json(res, 200, frame({ projectId, links: list, states: OP_MAPPING,
            permission: LINK_PERMISSION,
            effect: 'Approving a link enables a read-only comparison. No synthetic P6 progress is '
              + 'ever written from a live OpenProject value.' }));
          return true;
        }

        /**
         * Approve or reject a candidate link.
         *
         * The SERVER decides who may: the role comes from the session token, never from the body,
         * exactly as the outbound approvals do. A refusal arrives in the server's own words.
         */
        if (method === 'POST' && leaf.startsWith('/links/')) {
          const rest = leaf.slice('/links/'.length);
          const match = /^(\d+)\/(approve|reject)$/.exec(rest);
          if (!match) { json(res, 404, { error: 'Try POST /openproject/links/<id>/approve or /reject' }); return true; }
          const [, linkId, verb] = match;
          const session = sessionFor(db, req.headers['x-demo-session']);
          if (!may(session, LINK_PERMISSION)) {
            json(res, 403, { error: refusal(session, LINK_PERMISSION), permission: LINK_PERMISSION });
            return true;
          }
          const body = await readBody(req);
          const outcome = decideLink(db, { linkId,
            decision: verb === 'approve' ? OP_MAPPING.APPROVED : OP_MAPPING.REJECTED,
            actor: session.actor, note: body.note == null ? null : String(body.note).slice(0, 500) });
          if (!outcome.ok) { json(res, 400, outcome); return true; }

          const projectId = pid;
          const synthetic = syntheticP6Activities(db);
          const activity = storedActivities(db, projectId ?? '').find(entry =>
            String(entry.externalActivityId) === String(outcome.link.externalId)) ?? null;
          const target = synthetic.find(entry =>
            entry.activityId === outcome.link.targetActivityId) ?? null;
          json(res, 200, frame({ ...outcome,
            comparison: compare({ link: outcome.link, activity, target }),
            /** The sentence a reviewer should read as they approve. */
            effect: 'The link is recorded and a read-only comparison is now available. The '
              + 'synthetic P6 activity has not been modified and nothing was sent to OpenProject.' }));
          return true;
        }

        json(res, 404, { error: `Unknown OpenProject route "${leaf}".` });
        return true;
      }

      json(res, 404, { error: `Not found. Try GET ${BASE}/overview` });
      return true;
    } catch (error) {
      logger.error?.('[construction] request failed', error);
      json(res, 500, { error: String(error?.message ?? error) });
      return true;
    }
  }

  return {
    handle,
    middleware: (req, res, next) => { handle(req, res).then(handled => { if (!handled) next(); }, next); },
    /** Starts the background worker. The HOST calls it; importing this module must not. */
    startAutoSync,
    /** For a host that wants the worker's state without a request, and for tests. */
    syncStatus: () => syncWorker().status(),
    /**
     * Shut down, in order: stop waking up, hang up on the subscribers, then close the file.
     *
     * `await`ed on the worker so a cycle in flight finishes its transaction instead of being cut
     * off mid-commit. Only a worker this API actually CREATED is stopped — a second API in the
     * same process shares the singleton, and closing one must not silently stop the other's
     * polling.
     */
    async close() {
      try {
        /*
         * RELEASE FIRST, then stop only if we were the last holder.
         *
         * Not `workerOwned`: on a Vite restart the new API adopts this live worker before this
         * `close` fires, and stopping "the one we created" would kill the new server's polling
         * for good. The registry counts holders, so the last one to let go is the one that stops
         * it — see `acquireSyncWorker`.
         */
        if (workerHandle && releaseSyncWorker(workerKey, workerHandle)) await workerHandle.stop();
      } catch { /* already stopped */ }
      try {
        if (speckleWorkerHandle && releaseWorker(speckleKey, speckleWorkerHandle)) {
          await speckleWorkerHandle.stop();
        }
      } catch { /* already stopped */ }
      try { events.close(); } catch { /* already closed */ }
      try { db?.close?.(); } catch { /* already gone */ }
    },
  };
}
