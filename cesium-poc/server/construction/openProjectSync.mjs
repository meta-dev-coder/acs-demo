/**
 * The OpenProject background synchronisation worker (Phase 8B).
 *
 * One timer, one lock, one adapter. It wakes on an interval, asks the EXISTING adapter for the
 * project's work packages, hands the result to the EXISTING change detector and store, and tells
 * anyone listening that there is something new to read. It introduces no second source of truth:
 * `/openproject/work-packages` still reads the same snapshot tables, and a manual Sync Now goes
 * through this same function so there is exactly one code path that writes a run.
 *
 * The four things that are easy to get wrong here, and what is done about each:
 *
 *  1. OVERLAPPING RUNS. A 60-second timer and a 90-second cycle produce two concurrent walks of
 *     the same collection writing the same tables. `inFlight` is a single promise: while it is
 *     set, nothing starts a second run. A manual caller JOINS it and is told so; a scheduled tick
 *     records a SKIPPED row and goes back to sleep. The startup run holds the same lock as the
 *     timer, so the two cannot overlap either.
 *  2. DUPLICATE WORKERS. Vite restarts the dev server's module graph on a config change and a
 *     second `createConstructionApi()` would otherwise bring a second timer with it, polling a
 *     rate-limited cloud service twice a minute for no reason. The worker is a process-wide
 *     singleton keyed on `globalThis` with a `Symbol.for` key, so a reloaded module finds the
 *     existing one instead of making another.
 *  3. RETRYING WHAT CANNOT SUCCEED. A rejected API token will still be rejected in 60 seconds, and
 *     a client that keeps trying looks like a brute-force attempt. AUTH_FAILED parks the worker:
 *     it stops polling, says why, and waits for an operator. Transient failures back off on the
 *     schedule instead; a 429 is honoured for as long as OpenProject asked.
 *  4. HOLDING THE PROCESS OPEN. The timer is `unref`'d, so `npm test` and a dev server exit
 *     normally whether or not a worker is running.
 *
 * What it will NOT do: it will not write to OpenProject (the adapter it uses has no write path at
 * all), and it will not touch a table outside `live_schedule_*` — the store it calls is the same
 * one Phase 8A's reviewer checked by reading its SQL. Nothing here opens a `sync_run`, proposes a
 * write-back, approves a mapping or advances a synthetic P6 activity.
 */
import { randomUUID } from 'node:crypto';

import {
  BACKOFF_MULTIPLIER, RUN_STATUS, SOURCE, SYNC_INTERVAL, TRIGGER,
} from './openProjectConfig.mjs';
import { FAILURE, STATE } from './openProjectHttp.mjs';
import {
  applyFetch, lastSuccessfulFetch, recordFailedFetch, recordSkippedRun, storedActivities,
} from './openProjectStore.mjs';
import { proposeCandidates } from './openProjectMapping.mjs';

/** What the worker is doing, for the status row. Distinct from a RUN's outcome. */
export const WORKER_STATE = Object.freeze({
  /** `OPENPROJECT_AUTO_SYNC_ENABLED` is not true. No timer, and that is the configured choice. */
  DISABLED: 'DISABLED',
  /** Enabled, but there is no token or no valid project id, so there is nothing to poll. */
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  /** Timer armed, waiting for the next tick. */
  IDLE: 'IDLE',
  /** A cycle is in flight right now. */
  SYNCING: 'SYNCING',
  /**
   * Stopped on purpose after an authentication failure.
   *
   * Not an error state to be retried out of: a credential OpenProject rejected will be rejected
   * again, so the worker stands down and says so rather than hammering the instance.
   */
  AUTH_PARKED: 'AUTH_PARKED',
  /** `stop()` was called — a backend shutting down, or a test tearing down. */
  STOPPED: 'STOPPED',
});

/** The event name an SSE subscriber listens for. One string, shared with the frontend by name. */
export const SYNC_EVENT = 'openproject-sync-completed';

/**
 * The shortest gap between two MANUAL runs.
 *
 * The in-flight lock makes concurrent runs impossible but says nothing about consecutive ones, and
 * a button held down would walk the collection several times a second. Three seconds is long
 * enough to bound that and short enough that a deliberate second press still works.
 */
export const MANUAL_MIN_INTERVAL_MS = 3_000;

/** `true`/`1`/`yes`/`on`, case-insensitively. Anything else, including absent, is false. */
export const truthy = value => ['true', '1', 'yes', 'on']
  .includes(String(value ?? '').trim().toLowerCase());

/**
 * The worker's configuration, read from the server-side environment.
 *
 * `OPENPROJECT_*` and deliberately not `VITE_OPENPROJECT_*`: a `VITE_`-prefixed variable is
 * compiled into the public browser bundle, which is where the token must never go. These are read
 * through the same `server/loadEnv.mjs` precedence as every other server-side setting — shell,
 * then `.env.local`, then `.env` — so a value exported in the shell wins and a restart is what
 * picks up a new one.
 *
 * DEFAULT OFF. An integration that starts talking to somebody's cloud instance on `npm start`
 * because a file was present is not a default anybody chose; `OPENPROJECT_AUTO_SYNC_ENABLED=true`
 * is the operator saying so.
 */
export function readSyncConfig(env = process.env) {
  const raw = Number(env.OPENPROJECT_SYNC_INTERVAL_SECONDS);
  const requested = Number.isFinite(raw) && raw > 0 ? raw : SYNC_INTERVAL.default;
  const intervalSeconds = Math.min(Math.max(Math.round(requested), SYNC_INTERVAL.min),
    SYNC_INTERVAL.max);
  return {
    enabled: truthy(env.OPENPROJECT_AUTO_SYNC_ENABLED),
    intervalSeconds,
    /** Said out loud when a typo was clamped, rather than silently honouring something else. */
    intervalClamped: Number.isFinite(raw) && raw > 0 && Math.round(requested) !== intervalSeconds
      ? `OPENPROJECT_SYNC_INTERVAL_SECONDS=${raw} is outside ${SYNC_INTERVAL.min}–`
        + `${SYNC_INTERVAL.max} s and was clamped to ${intervalSeconds} s.`
      : null,
    /** Default true: an operator who turned the worker on wants to see data without waiting 60 s. */
    syncOnStartup: env.OPENPROJECT_SYNC_ON_STARTUP == null
      ? true : truthy(env.OPENPROJECT_SYNC_ON_STARTUP),
  };
}

/**
 * How long to wait after a failure, in multiples of the interval.
 *
 * @returns {number} seconds, or `null` when the worker should park instead of waiting.
 */
export function backoffFor({ failures, state, retryAfterSeconds, intervalSeconds }) {
  // A rejected credential is not transient. No amount of waiting fixes it and continuing to try
  // is indistinguishable from an attack, so the caller parks the worker.
  if (state === STATE.AUTH_FAILED) return null;
  if (retryAfterSeconds != null && retryAfterSeconds > 0) {
    // At least what the far end asked for. Never less, and never less than one interval either.
    return Math.max(retryAfterSeconds, intervalSeconds);
  }
  const step = BACKOFF_MULTIPLIER[Math.min(Math.max(failures, 1), BACKOFF_MULTIPLIER.length) - 1];
  return intervalSeconds * step;
}

/* ── the worker ────────────────────────────────────────────────────────────────────────────── */

/**
 * @param {object} options
 * @param {() => object} options.adapter the EXISTING OpenProject adapter, lazily (the api module
 *   builds it on first use and the worker must not force that at import time).
 * @param {() => object|null} options.db the construction database, lazily, for the same reason:
 *   it is opened on the first request and a missing `node:sqlite` must not take the server down.
 * @param {(event: string, data: object) => void} [options.publish] the SSE hub's publish.
 * @param {object} [options.env] for tests.
 * @param {Function} [options.setTimeoutImpl] injected so a test drives the clock instead of waiting.
 */
export function createOpenProjectSyncWorker({
  adapter, db: dbFor, publish = null, env = process.env, logger = console,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, now = () => Date.now(),
  actor = 'Automatic sync', manualMinIntervalMs = MANUAL_MIN_INTERVAL_MS,
} = {}) {
  const config = readSyncConfig(env);

  /**
   * THE LIVE SERVER'S adapter, database and event hub — mutable, and rebound on adoption.
   *
   * The worker is a per-process singleton; its dependencies are not. They belong to whichever
   * `createConstructionApi()` is currently serving, and on a Vite restart that is a different one.
   * Holding the closures of the API that happened to create it was a real bug: the restarted
   * server adopted the running worker, the old API's `close()` then closed ITS database handle,
   * and the next cycle logged `database is not open` for ever after. The worker kept polling and
   * could no longer store a thing.
   *
   * Found by restarting the real dev server and reading its log. `rebind` is how the surviving
   * worker follows the live server instead of a shut-down one.
   */
  let deps = { adapter, dbFor, publish, logger };

  function rebind(next = {}) {
    deps = {
      adapter: next.adapter ?? deps.adapter,
      dbFor: next.db ?? deps.dbFor,
      publish: next.publish ?? deps.publish,
      logger: next.logger ?? deps.logger,
    };
    return deps;
  }

  let timer = null;
  /** The single lock. While this is a promise, no second run may begin. */
  let inFlight = null;
  let state = config.enabled ? WORKER_STATE.IDLE : WORKER_STATE.DISABLED;
  let started = false;
  let stopped = false;
  let lastRun = null;
  let lastSuccessAt = null;
  let nextRunAt = null;
  let consecutiveFailures = 0;
  let parkedReason = null;
  let runsStarted = 0;
  let runsSkipped = 0;
  let lastManualAt = null;

  const log = (level, message) => deps.logger?.[level]?.(`[openproject-sync] ${message}`);

  /**
   * One cycle, from the HTTP walk to the notification.
   *
   * Everything that can throw is inside: a worker whose unhandled rejection kills the process is
   * worse than no worker. The outcome is always a value.
   */
  async function cycle({ trigger, by }) {
    const runId = randomUUID();
    const startedAt = new Date(now()).toISOString();
    runsStarted += 1;
    state = WORKER_STATE.SYNCING;

    const finish = extra => {
      const run = { runId, trigger, startedAt, finishedAt: new Date(now()).toISOString(),
        actor: by, ...extra };
      /*
       * `lastRun` keeps everything EXCEPT `detail`.
       *
       * `detail` holds the whole adapter result so `POST /refresh` can answer with it, and it is
       * the only part of a run that is not small. Keeping it here would have put every activity
       * into `GET /sync/status` — an endpoint a screen polls every ten seconds and that exists
       * precisely because it is cheap. Caught by reading the live response rather than the code.
       */
      const { detail: _detail, ...summary } = run;
      lastRun = summary;
      return run;
    };

    /*
     * Captured once, at the top. A rebind that lands mid-cycle must take effect on the NEXT
     * cycle, never halfway through this one — a run that read through one server's adapter and
     * wrote through another's database handle would be a genuinely confusing record.
     */
    const { adapter: adapterFor, dbFor: databaseFor, publish: publishTo } = deps;
    const db = databaseFor();
    if (!db) {
      // The database is opened on the first request and may be unavailable (an old Node without
      // `node:sqlite`). Nothing is recorded, because there is nowhere to record it.
      return finish({ runStatus: RUN_STATUS.FAILED, failure: FAILURE.CONFIG,
        reason: 'The construction database is unavailable, so there is nowhere to store a '
          + 'synchronisation. Nothing was read.' });
    }

    const projectId = adapterFor().projectId();
    if (!projectId) {
      return finish({ runStatus: RUN_STATUS.FAILED, failure: FAILURE.CONFIG,
        reason: 'OPENPROJECT_PROJECT_ID is not a whole number, so no request was made.' });
    }

    let result;
    try {
      result = await adapterFor().workPackages();
    } catch (error) {
      // The adapter reports its own failures as values, so reaching here is a defect in it. The
      // message is OURS: an upstream body must not become a worker log line unscrubbed.
      log('error', `the adapter threw: ${error?.message ?? error}`);
      return finish({ runStatus: RUN_STATUS.FAILED, failure: FAILURE.NETWORK,
        reason: 'The OpenProject adapter failed unexpectedly. Nothing was stored.' });
    }

    const readable = result.state === STATE.CONNECTED || result.state === STATE.PARTIAL;
    if (!readable) {
      /*
       * THE PREVIOUS SNAPSHOT IS KEPT. `recordFailedFetch` writes the run and touches no snapshot
       * row, so the screen still has the last thing OpenProject told us — dated, and marked stale
       * by the read endpoint because the newest run is not the newest successful one.
       */
      const failed = recordFailedFetch(db, { projectId, result, actor: by,
        run: { runId, trigger, startedAt, finishedAt: new Date(now()).toISOString(),
          runStatus: RUN_STATUS.FAILED } });
      const kept = storedActivities(db, projectId).length;
      log('warn', `${trigger} run ${runId} failed: ${result.state}`
        + `${result.failure ? ` (${result.failure})` : ''}; ${kept} stored activities kept`);
      return finish({ runStatus: RUN_STATUS.FAILED, state: result.state, failure: result.failure,
        httpStatus: result.httpStatus ?? null, reason: result.reason ?? null,
        retryAfterSeconds: result.retryAfterSeconds ?? null, fetchId: failed.fetchId,
        activitiesKept: kept, counts: null,
        /** See `detail` on the success path. */
        detail: { result, applied: null, proposed: [] } });
    }

    const runStatus = result.state === STATE.PARTIAL ? RUN_STATUS.PARTIAL : RUN_STATUS.SUCCESS;
    const applied = applyFetch(db, { projectId, result, actor: by,
      run: { runId, trigger, startedAt, finishedAt: new Date(now()).toISOString(), runStatus } });
    /*
     * Candidates are PROPOSED, never applied — the same call the manual refresh makes, and the
     * reason the worker may run unattended: an automatic cycle cannot approve a mapping, so it
     * cannot cause a comparison, let alone a write.
     */
    const proposed = proposeCandidates(db, { projectId, activities: result.activities, actor: by });

    lastSuccessAt = applied.at;
    const run = finish({ runStatus, state: result.state, httpStatus: result.httpStatus ?? null,
      reason: result.reason ?? null, fetchId: applied.fetchId, counts: applied.counts,
      changeRowsWritten: applied.changeRows, proposedLinks: proposed.length,
      collectionTotal: result.total ?? null, returned: result.returned,
      warnings: result.warnings?.length ?? 0,
      /**
       * The whole adapter result, IN MEMORY AND NEVER PERSISTED.
       *
       * It exists so `POST /openproject/refresh` can answer with exactly what it answered before
       * Phase 8B while still going through this one locked path. Without it there would be two
       * code paths writing `live_schedule_*` — the worker's and the route's — and a background
       * cycle could interleave with somebody pressing Refresh Schedule. This is also why the
       * notification published below carries counts instead of this: a browser gets ids, and the
       * data comes from the normalizing read endpoint.
       */
      detail: { result, applied, proposed } });

    log('log', `${trigger} run ${runId} ${runStatus}: ${result.returned} read, `
      + `${applied.counts.new} new, ${applied.counts.changed} changed, `
      + `${applied.counts.unchanged} unchanged`);

    /*
     * The NOTIFICATION. Ids and counts only — no work-package payload and, self-evidently, no
     * token. A client re-reads `/openproject/work-packages`, which is the one endpoint that
     * normalizes and dates this data, so a dropped event costs a reader one interval and nothing
     * else.
     */
    if (publishTo) {
      try {
        publishTo(SYNC_EVENT, {
          event: SYNC_EVENT,
          source: SOURCE.system,
          projectId: Number(projectId),
          syncRunId: runId,
          trigger,
          runStatus,
          changedActivities: applied.counts.changed,
          newActivities: applied.counts.new,
          unchangedActivities: applied.counts.unchanged,
          totalActivities: result.returned,
          completedAt: run.finishedAt,
        });
      } catch (error) {
        // A broken subscriber must not fail the run that has already been committed.
        log('warn', `could not publish the completion event: ${error?.message ?? error}`);
      }
    }
    return run;
  }

  /**
   * Run now, or join the run that is already going.
   *
   * THE ONE ENTRY POINT. The timer, the startup run and Sync Now all come through here, which is
   * what makes "the manual button shares the scheduled lock" true by construction rather than by
   * two implementations agreeing.
   */
  function run({ trigger = TRIGGER.MANUAL, by = actor } = {}) {
    if (stopped) {
      return Promise.resolve({ runStatus: RUN_STATUS.SKIPPED, trigger,
        reason: 'The synchronisation worker has been stopped.' });
    }
    /*
     * A FLOOR UNDER THE MANUAL RATE.
     *
     * The lock stops two runs at once; it does not stop a hundred runs in sequence. A cycle
     * against a small project finishes in a few hundred milliseconds, so a held-down Sync Now
     * would be several reads a second against a shared, rate-limited cloud service. Nothing is
     * persisted for a throttled click, because nothing happened — and a history full of them
     * would bury the runs that did.
     */
    if (trigger === TRIGGER.MANUAL && lastManualAt != null
      && now() - lastManualAt < manualMinIntervalMs) {
      const wait = Math.ceil((manualMinIntervalMs - (now() - lastManualAt)) / 1000);
      return Promise.resolve({ runStatus: RUN_STATUS.SKIPPED, trigger, throttled: true,
        reason: `A manual synchronisation ran moments ago. Automatic synchronisation is already `
          + `polling; wait ${wait} s to read OpenProject again.` });
    }
    if (trigger === TRIGGER.MANUAL) lastManualAt = now();

    if (inFlight) {
      runsSkipped += 1;
      if (trigger === TRIGGER.MANUAL) {
        /*
         * A manual caller JOINS rather than being refused.
         *
         * Pressing Sync Now twice should not produce an error — it should produce the answer the
         * first press is already fetching. `coalesced` says so, so the screen reports "a
         * synchronisation was already running" instead of claiming to have started one.
         */
        return inFlight.then(result => ({ ...result, coalesced: true, trigger,
          reason: 'A synchronisation was already running, so this request joined it rather than '
            + 'starting a second one.' }));
      }
      /*
       * A SCHEDULED tick that arrives mid-run is recorded as SKIPPED and dropped.
       *
       * Recorded rather than silent: when a 60-second poller has produced 40 runs in an hour, the
       * SKIPPED rows are the explanation, and without them the history just looks wrong.
       */
      const db = deps.dbFor();
      const projectId = deps.adapter().projectId();
      if (db && projectId) {
        try {
          recordSkippedRun(db, { projectId, actor: by,
            run: { runId: randomUUID(), trigger, startedAt: new Date(now()).toISOString() },
            reason: 'The previous synchronisation was still running when this tick arrived, so '
              + 'this one was skipped rather than run concurrently.' });
        } catch (error) {
          log('warn', `could not record a skipped run: ${error?.message ?? error}`);
        }
      }
      log('warn', `${trigger} tick skipped: a run is already in flight`);
      return Promise.resolve({ runStatus: RUN_STATUS.SKIPPED, trigger, skipped: true,
        reason: 'The previous synchronisation was still running.' });
    }

    inFlight = cycle({ trigger, by })
      .catch(error => {
        log('error', `run failed unexpectedly: ${error?.message ?? error}`);
        return { runStatus: RUN_STATUS.FAILED, trigger,
          reason: 'The synchronisation failed unexpectedly.' };
      })
      .finally(() => {
        inFlight = null;
        if (!stopped) state = parkedReason ? WORKER_STATE.AUTH_PARKED : WORKER_STATE.IDLE;
      });

    return inFlight.then(result => {
      settle(result);
      return result;
    });
  }

  /**
   * What the outcome means for the SCHEDULE.
   *
   * Kept apart from `cycle` so the decision to park, back off or carry on is one readable function
   * rather than a branch inside the HTTP path.
   */
  function settle(result) {
    if (result.runStatus === RUN_STATUS.SKIPPED) return;
    if (result.runStatus === RUN_STATUS.SUCCESS || result.runStatus === RUN_STATUS.PARTIAL) {
      consecutiveFailures = 0;
      parkedReason = null;
      arm(config.intervalSeconds);
      return;
    }
    consecutiveFailures += 1;
    const wait = backoffFor({ failures: consecutiveFailures, state: result.state,
      retryAfterSeconds: result.retryAfterSeconds, intervalSeconds: config.intervalSeconds });
    if (wait == null) {
      park(`OpenProject rejected the API token (${result.reason ?? 'authentication failed'}). `
        + 'Automatic synchronisation has stopped rather than retrying a credential that cannot '
        + 'succeed. Fix OPENPROJECT_API_TOKEN and restart the server, or press Sync Now to try '
        + 'once.');
      return;
    }
    if (wait !== config.intervalSeconds) {
      log('warn', `${consecutiveFailures} consecutive failure(s); next attempt in ${wait} s`);
    }
    arm(wait);
  }

  /** Stop polling but stay answerable. A manual Sync Now still works, which is how you recover. */
  function park(reason) {
    parkedReason = reason;
    state = WORKER_STATE.AUTH_PARKED;
    disarm();
    nextRunAt = null;
    log('error', reason);
  }

  /**
   * Arm the next tick.
   *
   * `setTimeout` rather than `setInterval`, and that is the whole of requirement 1: a one-shot
   * timer re-armed only when the previous cycle has SETTLED cannot queue a tick behind a running
   * cycle, so a slow run delays the next one instead of racing it. An interval would fire on the
   * clock regardless and the lock would then be doing all the work.
   */
  function arm(seconds) {
    if (stopped || !config.enabled) return;
    disarm();
    const ms = Math.max(1, Math.round(seconds * 1000));
    nextRunAt = new Date(now() + ms).toISOString();
    timer = setTimeoutImpl(() => {
      timer = null;
      void run({ trigger: TRIGGER.SCHEDULED });
    }, ms);
    // Never hold a dev server or a test run open on our behalf.
    timer?.unref?.();
  }

  function disarm() {
    if (timer) { clearTimeoutImpl(timer); timer = null; }
  }

  /**
   * Start the worker. IDEMPOTENT — a second call is a no-op, not a second timer.
   *
   * @returns {{started: boolean, reason: string|null, firstRun: Promise|null}}
   */
  function start() {
    if (stopped) return { started: false, reason: 'This worker has been stopped.', firstRun: null };
    if (started) return { started: true, reason: 'Already running.', firstRun: null };

    if (!config.enabled) {
      state = WORKER_STATE.DISABLED;
      log('log', 'automatic synchronisation is off (OPENPROJECT_AUTO_SYNC_ENABLED is not true)');
      return { started: false, reason: 'OPENPROJECT_AUTO_SYNC_ENABLED is not true.',
        firstRun: null };
    }
    /*
     * NO TOKEN MEANS NO TIMER.
     *
     * Not "a timer that discovers this every 60 seconds": a missing credential is a configuration
     * state, and polling on it would produce a minute-by-minute log of the same sentence. The
     * token is read per call, so a `.env.local` edit plus a restart is the whole fix.
     */
    if (!deps.adapter().configured()) {
      state = WORKER_STATE.NOT_CONFIGURED;
      log('warn', 'automatic synchronisation is enabled but OPENPROJECT_API_TOKEN is not set; '
        + 'no polling will happen');
      return { started: false,
        reason: 'OPENPROJECT_API_TOKEN is not set on the server, so there is nothing to poll.',
        firstRun: null };
    }
    if (!deps.adapter().projectId()) {
      state = WORKER_STATE.NOT_CONFIGURED;
      return { started: false, reason: 'OPENPROJECT_PROJECT_ID is not a whole number.',
        firstRun: null };
    }

    started = true;
    state = WORKER_STATE.IDLE;
    log('log', `automatic synchronisation on: every ${config.intervalSeconds} s`
      + `${config.syncOnStartup ? ', starting now' : ''}`);
    if (config.intervalClamped) log('warn', config.intervalClamped);

    /*
     * The startup run takes the same lock as the timer, so "startup and scheduled cannot overlap"
     * needs no separate guard: the first tick is armed by `settle` only once this run has
     * finished. When startup is off, the timer is armed immediately instead.
     */
    const firstRun = config.syncOnStartup ? run({ trigger: TRIGGER.STARTUP }) : null;
    if (!firstRun) arm(config.intervalSeconds);
    return { started: true, reason: null, firstRun };
  }

  /**
   * Stop. Graceful: the timer is cleared at once, and the caller may await the run in flight.
   *
   * Idempotent, because a host may call it from both a signal handler and a `close` event.
   */
  async function stop() {
    stopped = true;
    disarm();
    nextRunAt = null;
    state = WORKER_STATE.STOPPED;
    // Awaited, not abandoned: a cycle killed between its HTTP read and its commit would roll back
    // (the writes are one transaction) but would also leave the log without the run it made.
    if (inFlight) { try { await inFlight; } catch { /* already reported by `run` */ } }
    log('log', 'automatic synchronisation stopped');
  }

  /** Everything the status row shows. A value, so an endpoint is a one-liner. */
  function status() {
    const configured = deps.adapter().configured();
    return {
      /*
       * `sourceSystem`, not `source`.
       *
       * Every OpenProject response is framed with `source: SOURCE` — the whole descriptor object —
       * and spreading this into one would have replaced that object with the bare string, so
       * `payload.source.system` came back undefined and the screen lost the provenance note it
       * frames every figure with. Found by a test asserting on the framed shape.
       */
      sourceSystem: SOURCE.system,
      enabled: config.enabled,
      configured,
      intervalSeconds: config.intervalSeconds,
      intervalClamped: config.intervalClamped,
      syncOnStartup: config.syncOnStartup,
      /**
       * Why nothing is being polled, in the SERVER's words.
       *
       * The sentence lives here and not in the panel because it has to name a server-side
       * environment variable, and a frontend file that names the credential variable is a frontend
       * file one careless edit away from holding the credential — there is a test that fails if
       * one does. Same reason the approval refusals are composed server-side.
       */
      configuredReason: config.enabled && !configured
        ? 'Automatic synchronisation is enabled but OPENPROJECT_API_TOKEN is not set on the '
          + 'server, so nothing is being polled. Add it to cesium-poc/.env.local and restart — '
          + 'the browser never sees it.'
        : null,
      /** How to turn polling on, when it is off. Also the server's to name. */
      enableHint: config.enabled ? null
        : `Set OPENPROJECT_AUTO_SYNC_ENABLED=true in cesium-poc/.env.local and restart the server `
          + `to poll every ${config.intervalSeconds} s. Off is a configured choice, not a failure: `
          + 'Refresh Schedule and Sync Now still read OpenProject on request.',
      state,
      running: Boolean(inFlight),
      nextRunAt,
      lastRun,
      lastSuccessAt,
      consecutiveFailures,
      parkedReason,
      runsStarted,
      runsSkipped,
      /** Said on screen, because an unattended writer is exactly what a reader should ask about. */
      scope: 'Read-only. The worker issues GET requests only and writes nothing to OpenProject. '
        + 'It stores into the live_schedule_* tables and leaves P6, SYNCHRO, SAP, ACC and BIM '
        + 'records untouched.',
      /** The honest limit. One process, one timer; nothing coordinates two backends. */
      scheduling: 'Single-process. The worker is a per-process singleton with an in-memory lock, '
        + 'which is correct for one backend and is NOT distributed scheduling: two backend '
        + 'instances against this database would each poll and each write. See the documentation '
        + 'for the lease that would be needed first.',
    };
  }

  return { start, stop, run, status, config, rebind,
    /** For tests: the lock itself, so one can assert there is only ever one. */
    get inFlight() { return inFlight; },
    get state() { return state; },
    /** A stopped worker can never poll again, so the registry must not hand one out. */
    get stopped() { return stopped; } };
}

/* ── one per process ───────────────────────────────────────────────────────────────────────── */

/**
 * Re-exported from `workerRegistry.mjs`.
 *
 * The registry moved there in Phase 9B because the Speckle worker needs exactly the same
 * guarantee — one per process, reference-counted, never hand out a stopped one — and two copies
 * of that logic is two places for the restart bugs it was written for to come back. These
 * re-exports keep every existing import of this module working unchanged.
 */
export {
  acquireSyncWorker, releaseSyncWorker, resetSyncWorkerRegistry, syncWorkerRefs,
} from './workerRegistry.mjs';
