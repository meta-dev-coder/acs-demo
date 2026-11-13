/**
 * The Speckle BIM synchronisation worker (Phase 9B).
 *
 * Shaped like the OpenProject worker and sharing its registry, but NOT a copy of it: the job is
 * different in the one way that matters. An OpenProject cycle always reads the whole collection;
 * a Speckle cycle asks one cheap question — "what is the latest version id?" — and does the
 * expensive thing only when the answer has changed. Versions are immutable, so a cached
 * conversion is valid for ever and the common cycle costs one small GraphQL query.
 *
 * That is the whole reason this is safe to run every 60 seconds. Converting a model every minute
 * would be absurd; checking a version id every minute is not.
 *
 * What it will not do: it will not write to Speckle, will not touch a table outside `speckle_*`,
 * will not map a BIM element to a schedule activity (that is Phase 9C and needs an approval), and
 * will not take the current model away because a new version failed to convert.
 */
import { randomUUID } from 'node:crypto';

import { RUN_STATUS, SPECKLE, STATE, TRIGGER } from './speckle.mjs';
import {
  activeVersion, markPublished, noteVersion, publishVersion, recordFailedConversion, recordSync,
  saveComparison, versionRow,
} from './speckleStore.mjs';

export const WORKER_STATE = Object.freeze({
  DISABLED: 'DISABLED',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  IDLE: 'IDLE',
  CHECKING: 'CHECKING',
  CONVERTING: 'CONVERTING',
  /** Stopped on purpose after a rejected token — retrying cannot fix a bad credential. */
  AUTH_PARKED: 'AUTH_PARKED',
  STOPPED: 'STOPPED',
});

export const SYNC_EVENT = 'speckle-sync-completed';

export const SYNC_INTERVAL = Object.freeze({ default: 60, min: 30, max: 86_400 });

/**
 * The shortest gap between two MANUAL runs.
 *
 * Longer than OpenProject's three seconds because a manual run here can start a conversion, and a
 * held-down Sync Now that queues model downloads is a different order of waste.
 */
export const MANUAL_MIN_INTERVAL_MS = 5_000;

export const truthy = value => ['true', '1', 'yes', 'on']
  .includes(String(value ?? '').trim().toLowerCase());

/**
 * Read the worker's configuration.
 *
 * DEFAULT OFF, for the same reason the OpenProject worker is: an integration that starts
 * downloading somebody's model on `npm start` because a file was present is not a default anybody
 * chose.
 */
export function readSyncConfig(env = process.env) {
  const raw = Number(env.SPECKLE_SYNC_INTERVAL_SECONDS);
  const requested = Number.isFinite(raw) && raw > 0 ? raw : SYNC_INTERVAL.default;
  const intervalSeconds = Math.min(Math.max(Math.round(requested), SYNC_INTERVAL.min),
    SYNC_INTERVAL.max);
  return {
    enabled: truthy(env.SPECKLE_AUTO_SYNC_ENABLED),
    intervalSeconds,
    intervalClamped: Number.isFinite(raw) && raw > 0 && Math.round(requested) !== intervalSeconds
      ? `SPECKLE_SYNC_INTERVAL_SECONDS=${raw} is outside ${SYNC_INTERVAL.min}–`
        + `${SYNC_INTERVAL.max} s and was clamped to ${intervalSeconds} s.`
      : null,
    syncOnStartup: env.SPECKLE_SYNC_ON_STARTUP == null
      ? true : truthy(env.SPECKLE_SYNC_ON_STARTUP),
  };
}

export function createSpeckleSyncWorker({
  adapter, db: dbFor, publish = null, env = process.env, logger = console,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, now = () => Date.now(),
  actor = 'Speckle sync', manualMinIntervalMs = MANUAL_MIN_INTERVAL_MS,
} = {}) {
  const config = readSyncConfig(env);

  /** Rebound on adoption, so a worker that survives a Vite restart follows the live server. */
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
  let inFlight = null;
  let state = config.enabled ? WORKER_STATE.IDLE : WORKER_STATE.DISABLED;
  let started = false;
  let stopped = false;
  let lastRun = null;
  let nextRunAt = null;
  let consecutiveFailures = 0;
  let parkedReason = null;
  let runsStarted = 0;
  let conversions = 0;
  let lastManualAt = null;

  const log = (level, message) => deps.logger?.[level]?.(`[speckle-sync] ${message}`);

  /**
   * One cycle: ask what the latest version is, convert only if it is new.
   */
  async function cycle({ trigger, by }) {
    const runId = randomUUID();
    const startedAt = new Date(now()).toISOString();
    runsStarted += 1;
    state = WORKER_STATE.CHECKING;

    const { adapter: adapterFor, dbFor: databaseFor, publish: publishTo } = deps;
    const finish = extra => {
      const run = { runId, trigger, startedAt, finishedAt: new Date(now()).toISOString(),
        actor: by, ...extra };
      lastRun = run;
      return run;
    };

    const db = databaseFor();
    if (!db) {
      return finish({ status: RUN_STATUS.FAILED, errorClass: 'CONFIGURATION',
        reason: 'The construction database is unavailable, so there is nowhere to record a '
          + 'conversion. Nothing was downloaded.' });
    }
    const speckle = adapterFor();
    const projectId = speckle.projectId();
    const modelId = speckle.modelId();
    const record = extra => recordSync(db, { runId, trigger, projectId, modelId, startedAt,
      actor: by, ...extra });

    /*
     * ONE QUERY PER CYCLE, not two.
     *
     * The history already contains the latest version, so asking for both was two round trips to
     * a rate-limited cloud service every sixty seconds to learn the same thing twice. Caught by a
     * Phase 9B test that counted the calls.
     *
     * Phase 9C's timeline needs the whole published history anyway: a cycle discovers all of
     * them, converts the ones that are missing, and leaves the ones already cached alone. A
     * version id is immutable, so "already converted" is permanent — which is what keeps a
     * 60-second poll cheap even with five versions on disk.
     */
    let history;
    try {
      history = await speckle.versionHistory();
    } catch (error) {
      log('error', `the adapter threw: ${error?.message ?? error}`);
      record({ status: RUN_STATUS.FAILED, errorClass: 'OTHER',
        reason: 'The Speckle adapter failed unexpectedly.' });
      return finish({ status: RUN_STATUS.FAILED, errorClass: 'OTHER',
        reason: 'The Speckle adapter failed unexpectedly. Nothing was stored.' });
    }

    if (history.state !== STATE.CONNECTED) {
      const errorClass = history.state === STATE.AUTH_FAILED ? 'AUTHENTICATION_OR_AUTHORIZATION'
        : history.state === STATE.NOT_CONFIGURED ? 'CONFIGURATION' : 'NETWORK';
      record({ status: RUN_STATUS.FAILED, errorClass, reason: history.reason ?? history.state });
      log('warn', `${trigger} run ${runId}: ${history.state}`);
      // The active model is untouched: `recordFailedConversion` is not even called, because
      // nothing was attempted against a version.
      return finish({ status: RUN_STATUS.FAILED, state: history.state, errorClass,
        reason: history.reason ?? null });
    }

    const discovered = history.versions;
    /**
     * Which version the demo should be SHOWING.
     *
     * `SPECKLE_VERSION_ID` pins it so a publish upstream cannot change what a presentation shows;
     * unpinned, it is the newest published version.
     */
    const latest = { targetVersionId: history.pinnedVersionId ?? history.latestVersionId,
      version: { versionId: history.latestVersionId } };
    for (const entry of discovered) {
      noteVersion(db, { projectId, modelId, versionId: entry.versionId,
        projectName: history.projectName, modelName: history.modelName,
        createdAt: entry.createdAt, sourceApplication: entry.sourceApplication,
        referencedObject: entry.referencedObject, ordinal: entry.ordinal, label: entry.label,
        message: entry.message });
    }
    if (discovered.length) {
      const dropped = markPublished(db, { projectId, modelId,
        versionIds: discovered.map(entry => entry.versionId) });
      if (dropped) {
        log('warn', `${dropped} cached version(s) are no longer published upstream; their `
          + 'artifacts are kept but they leave the timeline');
      }
    }
    if (history && history.truncated) {
      log('warn', 'the version history is incomplete; the timeline may begin partway through');
    }

    /*
     * Which versions still need converting, OLDEST FIRST.
     *
     * Oldest first so a partial run still produces a contiguous timeline from the beginning
     * rather than a newest-only model with gaps behind it.
     */
    const pending = discovered.filter(entry => {
      const row = versionRow(db, { projectId, modelId, versionId: entry.versionId });
      return !row || row.status !== 'CONVERTED';
    });

    const targetVersionId = latest.targetVersionId;
    const active = activeVersion(db, { projectId, modelId });

    if (!pending.length) {
      // THE COMMON CASE: everything published is already converted. Nothing is downloaded.
      const comparisons = refreshComparisons(db, projectId, modelId, discovered);
      record({ status: RUN_STATUS.UNCHANGED, versionId: targetVersionId,
        reason: `All ${discovered.length} published version(s) are already converted.` });
      state = WORKER_STATE.IDLE;
      return finish({ status: RUN_STATUS.UNCHANGED, versionId: targetVersionId,
        activeVersionId: active?.versionId ?? null, converted: false,
        versionsDiscovered: discovered.length, versionsConverted: 0,
        comparisonsComputed: comparisons,
        latestVersionId: history?.latestVersionId ?? latest.version?.versionId ?? null,
        reason: 'Every published version is already converted. No model was downloaded.' });
    }

    state = WORKER_STATE.CONVERTING;
    log('log', `${trigger} run ${runId}: ${pending.length} version(s) to convert`);

    /*
     * Each version is converted independently, and ONE FAILURE DOES NOT LOSE THE OTHERS. A
     * version that cannot be decoded is recorded as failed and the walk continues; everything
     * already cached stays exactly where it is.
     */
    const converted = [];
    const failures = [];
    for (const entry of pending) {
      const result = await speckle.convert(entry.versionId);
      if (!result.ok) {
        recordFailedConversion(db, { projectId, modelId, versionId: entry.versionId,
          error: result.error, errorClass: result.errorClass, actor: by });
        failures.push({ versionId: entry.versionId, label: entry.label,
          errorClass: result.errorClass, error: result.error });
        log('error', `${entry.label} (${entry.versionId}) failed: ${result.error}`);
        continue;
      }
      const elements = await readElements(result.artifactDir);
      const row = publishVersion(db, { projectId, modelId, versionId: entry.versionId,
        manifest: result.manifest, artifactDir: result.artifactDir, elements, actor: by,
        // Only the NEWEST published version becomes the active one; converting history must not
        // drag the viewer back to V1.
        activate: entry.versionId === (history?.latestVersionId ?? targetVersionId) });
      converted.push({ versionId: entry.versionId, label: entry.label,
        elementCount: row.elementCount, triangleCount: row.triangleCount });
      conversions += 1;
      log('log', `${entry.label} (${entry.versionId}) published — ${row.elementCount} elements`);
    }

    const comparisonsComputed = refreshComparisons(db, projectId, modelId, discovered);
    const nowActive = activeVersion(db, { projectId, modelId });

    if (!converted.length) {
      record({ status: RUN_STATUS.FAILED, versionId: targetVersionId,
        errorClass: failures[0]?.errorClass ?? 'OTHER',
        reason: `${failures.length} version(s) failed to convert.` });
      return finish({ status: RUN_STATUS.FAILED, versionId: targetVersionId,
        errorClass: failures[0]?.errorClass ?? 'OTHER', failures,
        reason: failures[0]?.error ?? 'Conversion failed.',
        activeVersionId: nowActive?.versionId ?? null,
        keptPreviousModel: Boolean(nowActive) });
    }

    record({ status: RUN_STATUS.CONVERTED, versionId: nowActive?.versionId ?? targetVersionId,
      converted: true,
      reason: `${converted.length} version(s) converted${failures.length
        ? `, ${failures.length} failed` : ''}; ${comparisonsComputed} comparison(s) computed.` });

    const run = finish({ status: RUN_STATUS.CONVERTED,
      versionId: nowActive?.versionId ?? targetVersionId, converted: true,
      previousVersionId: active?.versionId ?? null,
      versionsDiscovered: discovered.length,
      versionsConverted: converted.length,
      convertedVersions: converted,
      failures,
      comparisonsComputed,
      elementCount: nowActive?.elementCount ?? null,
      geometryCount: nowActive?.geometryCount ?? null,
      triangleCount: nowActive?.triangleCount ?? null,
      glbBytes: nowActive?.glbBytes ?? null });

    if (publishTo) {
      try {
        publishTo(SYNC_EVENT, {
          event: SYNC_EVENT, source: SPECKLE.system, projectId, modelId,
          versionId: nowActive?.versionId ?? null,
          previousVersionId: active?.versionId ?? null,
          syncRunId: runId, trigger,
          versionsConverted: converted.length,
          versionsDiscovered: discovered.length,
          elementCount: nowActive?.elementCount ?? null,
          completedAt: run.finishedAt,
        });
      } catch (error) {
        log('warn', `could not publish the completion event: ${error?.message ?? error}`);
      }
    }
    state = WORKER_STATE.IDLE;
    return run;
  }

  /**
   * Compute every ADJACENT comparison, plus each version against the baseline.
   *
   * Idempotent: `saveComparison` replaces its own rows, so a cycle that finds nothing new
   * recomputes the same answers rather than doubling them. Cheap enough to run every cycle and
   * worth it — a comparison missing because a version arrived out of order is a blank timeline.
   */
  function refreshComparisons(db, projectId, modelId, discovered) {
    const converted = discovered.filter(entry => {
      const row = versionRow(db, { projectId, modelId, versionId: entry.versionId });
      return row?.status === 'CONVERTED';
    });
    let count = 0;
    for (let index = 1; index < converted.length; index += 1) {
      const saved = saveComparison(db, { projectId, modelId,
        fromVersionId: converted[index - 1].versionId, toVersionId: converted[index].versionId });
      if (saved) count += 1;
    }
    // ...and against the baseline, which is the other comparison the UI offers.
    for (let index = 1; index < converted.length; index += 1) {
      const saved = saveComparison(db, { projectId, modelId,
        fromVersionId: converted[0].versionId, toVersionId: converted[index].versionId });
      if (saved) count += 1;
    }
    return count;
  }

  /** The converter writes `elements.json` beside the GLB. Absent or broken is not fatal. */
  async function readElements(artifactDir) {
    try {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const text = await readFile(join(artifactDir, 'elements.json'), 'utf8');
      const parsed = JSON.parse(text);
      return Array.isArray(parsed?.elements) ? parsed.elements : [];
    } catch (error) {
      log('warn', `could not read elements.json: ${error?.message ?? error}`);
      return [];
    }
  }

  /** THE ONE ENTRY POINT. The timer, the startup run and Sync Now all come through here. */
  function run({ trigger = TRIGGER.MANUAL, by = actor } = {}) {
    if (stopped) {
      return Promise.resolve({ status: RUN_STATUS.SKIPPED, trigger,
        reason: 'The Speckle synchronisation worker has been stopped.' });
    }
    if (trigger === TRIGGER.MANUAL && lastManualAt != null
      && now() - lastManualAt < manualMinIntervalMs) {
      const wait = Math.ceil((manualMinIntervalMs - (now() - lastManualAt)) / 1000);
      return Promise.resolve({ status: RUN_STATUS.SKIPPED, trigger, throttled: true,
        reason: `A manual synchronisation ran moments ago. Wait ${wait} s before checking again.` });
    }
    if (trigger === TRIGGER.MANUAL) lastManualAt = now();

    if (inFlight) {
      if (trigger === TRIGGER.MANUAL) {
        // Joins rather than refusing: a second press gets the answer the first is already
        // fetching, which matters more here because a conversion can take seconds.
        return inFlight.then(result => ({ ...result, coalesced: true, trigger,
          reason: 'A synchronisation was already running, so this request joined it rather than '
            + 'starting a second one.' }));
      }
      const db = deps.dbFor();
      if (db) {
        try {
          recordSync(db, { runId: randomUUID(), trigger, status: RUN_STATUS.SKIPPED,
            projectId: deps.adapter().projectId(), modelId: deps.adapter().modelId(),
            startedAt: new Date(now()).toISOString(), actor: by,
            reason: 'The previous synchronisation was still running when this tick arrived.' });
        } catch (error) {
          log('warn', `could not record a skipped run: ${error?.message ?? error}`);
        }
      }
      return Promise.resolve({ status: RUN_STATUS.SKIPPED, trigger, skipped: true,
        reason: 'The previous synchronisation was still running.' });
    }

    inFlight = cycle({ trigger, by })
      .catch(error => {
        log('error', `run failed unexpectedly: ${error?.message ?? error}`);
        return { status: RUN_STATUS.FAILED, trigger,
          reason: 'The synchronisation failed unexpectedly.' };
      })
      .finally(() => {
        inFlight = null;
        if (!stopped) state = parkedReason ? WORKER_STATE.AUTH_PARKED : WORKER_STATE.IDLE;
      });

    return inFlight.then(result => { settle(result); return result; });
  }

  /** What the outcome means for the schedule. */
  function settle(result) {
    if (result.status === RUN_STATUS.SKIPPED) return;
    if (result.status !== RUN_STATUS.FAILED) {
      consecutiveFailures = 0;
      parkedReason = null;
      arm(config.intervalSeconds);
      return;
    }
    consecutiveFailures += 1;
    if (result.state === STATE.AUTH_FAILED) {
      park(`Speckle rejected the API token (${result.reason ?? 'authentication failed'}). `
        + 'Automatic synchronisation has stopped rather than retrying a credential that cannot '
        + 'succeed. Fix SPECKLE_API_TOKEN and restart the server, or press Sync Now to try once.');
      return;
    }
    // Backoff on the schedule: a failed cycle makes the NEXT one wait longer, bounded at 8x.
    const step = Math.min(2 ** (consecutiveFailures - 1), 8);
    arm(config.intervalSeconds * step);
    if (step > 1) {
      log('warn', `${consecutiveFailures} consecutive failure(s); next check in `
        + `${config.intervalSeconds * step} s`);
    }
  }

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
   * `setTimeout` re-armed only once the previous cycle has SETTLED, so a slow conversion delays
   * the next check instead of racing it — and the startup run and the first scheduled tick cannot
   * overlap without a separate guard.
   */
  function arm(seconds) {
    if (stopped || !config.enabled) return;
    disarm();
    const ms = Math.max(1, Math.round(seconds * 1000));
    nextRunAt = new Date(now() + ms).toISOString();
    timer = setTimeoutImpl(() => { timer = null; void run({ trigger: TRIGGER.SCHEDULED }); }, ms);
    timer?.unref?.();
  }

  function disarm() {
    if (timer) { clearTimeoutImpl(timer); timer = null; }
  }

  /** Start. IDEMPOTENT — a second call is a no-op, not a second timer. */
  function start() {
    if (stopped) return { started: false, reason: 'This worker has been stopped.', firstRun: null };
    if (started) return { started: true, reason: 'Already running.', firstRun: null };

    if (!config.enabled) {
      state = WORKER_STATE.DISABLED;
      log('log', 'automatic synchronisation is off (SPECKLE_AUTO_SYNC_ENABLED is not true)');
      return { started: false, reason: 'SPECKLE_AUTO_SYNC_ENABLED is not true.', firstRun: null };
    }
    if (!deps.adapter().configured()) {
      state = WORKER_STATE.NOT_CONFIGURED;
      log('warn', 'automatic synchronisation is enabled but SPECKLE_API_TOKEN is not set; '
        + 'no polling will happen');
      return { started: false,
        reason: 'SPECKLE_API_TOKEN is not set on the server, so there is nothing to poll.',
        firstRun: null };
    }

    started = true;
    state = WORKER_STATE.IDLE;
    log('log', `automatic synchronisation on: every ${config.intervalSeconds} s`
      + `${config.syncOnStartup ? ', checking now' : ''}`);
    if (config.intervalClamped) log('warn', config.intervalClamped);

    const firstRun = config.syncOnStartup ? run({ trigger: TRIGGER.STARTUP }) : null;
    if (!firstRun) arm(config.intervalSeconds);
    return { started: true, reason: null, firstRun };
  }

  async function stop() {
    stopped = true;
    disarm();
    nextRunAt = null;
    state = WORKER_STATE.STOPPED;
    if (inFlight) { try { await inFlight; } catch { /* already reported by `run` */ } }
    log('log', 'automatic synchronisation stopped');
  }

  function status() {
    const speckle = deps.adapter();
    const configured = speckle.configured();
    return {
      sourceSystem: SPECKLE.system,
      enabled: config.enabled,
      configured,
      toolingInstalled: speckle.toolingInstalled(),
      configuredReason: config.enabled && !configured
        ? 'Automatic synchronisation is enabled but SPECKLE_API_TOKEN is not set on the server, '
          + 'so nothing is being checked. Add it to cesium-poc/.env.local and restart — the '
          + 'browser never sees it.'
        : null,
      enableHint: config.enabled ? null
        : `Set SPECKLE_AUTO_SYNC_ENABLED=true in cesium-poc/.env.local and restart the server to `
          + `check for a new model version every ${config.intervalSeconds} s. Off is a configured `
          + 'choice, not a failure: Sync Now still checks on request.',
      intervalSeconds: config.intervalSeconds,
      intervalClamped: config.intervalClamped,
      syncOnStartup: config.syncOnStartup,
      state,
      running: Boolean(inFlight),
      nextRunAt,
      lastRun,
      consecutiveFailures,
      parkedReason,
      runsStarted,
      conversions,
      pinnedVersionId: speckle.pinnedVersion(),
      scope: 'Read-only. The worker issues a GraphQL read and a bundle download only; it writes '
        + 'nothing to Speckle and stores into the speckle_* tables, leaving the synthetic BIM, '
        + 'P6, SYNCHRO, SAP and ACC records untouched.',
      cache: 'A Speckle version id is immutable, so a version already converted is never '
        + 'converted again. The usual cycle is one small GraphQL query and nothing else.',
      scheduling: 'Single-process. The worker is a per-process singleton with an in-memory lock, '
        + 'which is correct for one backend and is NOT distributed scheduling.',
    };
  }

  return { start, stop, run, status, config, rebind,
    get inFlight() { return inFlight; },
    get state() { return state; },
    get stopped() { return stopped; } };
}
