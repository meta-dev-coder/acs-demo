/**
 * FL511 poller logic, without AWS SDK imports so it is unit-testable (index.mjs wires the clients).
 *
 * Each run polls FL511 once, then:
 *   1. diffs the events against DynamoDB, writes changes and emits EventsChanged (the deployed site);
 *   2. runs one Live DataConnect cycle with the same payload, signed in with the DataConnect service
 *      client (client_credentials) read from Secrets Manager, and writes the non-secret
 *      status/live-dc-status.json either way. The two steps fail independently.
 */
import { DcWriterError, WRITER_ERRORS, createClientCredentialsTokenProvider, createDcWriter, loadDcWriterConfig } from '../../../server/liveDc/dcWriter.mjs';
import { createAssetCache, createCycleMemory, parseHoldOpen, runLiveDcCycle } from '../../../server/liveDc/cycle.mjs';
import { createEventCapture } from '../../../server/liveDc/eventCapture.mjs';
import { loadWorkflowConfig } from '../../../server/liveDc/workflow.mjs';
import { withDeadline } from '../../../server/liveDc/timeouts.mjs';

export const DEFAULT_SERVICE_CLIENT_SECRET_NAME = 'i595/dataconnect/service-client';
export const LIVE_DC_STATUS_KEY = 'status/live-dc-status.json';
export const CREDENTIALS_UNAVAILABLE = 'credentials_unavailable';
const DEADLINE_MARGIN_MS = 5_000;
const REASON_MAX = 300;

const iso = ms => new Date(ms).toISOString();
const shortName = name => name.replace(/^SDNA Florida I595 Live /, '').replace(/\s+/g, '');

// ── 1. DynamoDB (unchanged behaviour) ─────────────────────────────────────────────────────────────

export async function syncDynamo({ payload, tableName, busName, ddb, emit, now = Date.now, logger = console }) {
  const newState = new Map();
  for (const event of payload.events ?? []) newState.set(event.id, event);

  const oldState = new Map();
  for (const item of await ddb.scanAll(tableName)) if (item.eventId) oldState.set(item.eventId, item);

  const added = [], updated = [], removed = [];
  for (const [id, event] of newState) {
    if (!oldState.has(id)) {
      added.push(event);
    } else {
      // Compare only the event payload, not the DynamoDB housekeeping fields
      const { eventId: _eid, lastUpdated: _lu, ttl: _ttl, ...oldCore } = oldState.get(id);
      if (JSON.stringify(event) !== JSON.stringify(oldCore)) updated.push(event);
    }
  }
  for (const id of oldState.keys()) if (!newState.has(id)) removed.push(id);

  if (added.length + removed.length + updated.length === 0) {
    logger.log?.('no change');
    return { added: 0, updated: 0, removed: 0 };
  }

  const nowIso = iso(now());
  const ttl = Math.floor(now() / 1000) + 86400; // 24 h from now
  await Promise.all([
    ...[...added, ...updated].map(event => ddb.put(tableName, { eventId: event.id, ...event, lastUpdated: nowIso, ttl })),
    ...removed.map(id => ddb.remove(tableName, { eventId: id })),
  ]);

  await emit({
    Source: 'i595.poller',
    DetailType: 'EventsChanged',
    EventBusName: busName,
    Detail: JSON.stringify({ added, removed, updated, timestamp: nowIso }),
  });

  logger.log?.(
    `FL511 poller: +${added.length} added, ~${updated.length} updated, -${removed.length} removed`
    + ` (sourceStatus=${payload.sourceStatus}, total=${newState.size})`,
  );
  return { added: added.length, updated: updated.length, removed: removed.length };
}

// ── 2. Live DataConnect (service client) ──────────────────────────────────────────────────────────

const unavailable = () => Object.assign(new Error('DataConnect service-client secret is unavailable'), { code: CREDENTIALS_UNAVAILABLE });

/**
 * Service-client credentials from a Secrets Manager JSON secret {"client_id", "client_secret"}, cached
 * for the warm container. Failures are not cached and never carry the secret's content.
 */
export function createSecretCredentials({ secretName = DEFAULT_SERVICE_CLIENT_SECRET_NAME, readSecret, logger = console }) {
  let cached = null;
  let pending = null;
  async function load() {
    let parsed;
    try {
      parsed = JSON.parse(String((await readSecret(secretName)) ?? ''));
    } catch (error) {
      logger.error?.(`live-dc: service-client secret not readable (${error?.name ?? 'Error'})`);
      throw unavailable();
    }
    const clientId = typeof parsed?.client_id === 'string' ? parsed.client_id.trim() : '';
    const clientSecret = typeof parsed?.client_secret === 'string' ? parsed.client_secret.trim() : '';
    if (!clientId || !clientSecret) {
      logger.error?.('live-dc: service-client secret lacks client_id or client_secret');
      throw unavailable();
    }
    cached = Object.freeze({ clientId, clientSecret });
    return cached;
  }
  return {
    async get() {
      if (cached) return cached;
      pending ??= load().finally(() => { pending = null; });
      return pending;
    },
    invalidate() { cached = null; },
  };
}

export function liveDcCycleOptions(env = {}) {
  const spawnTypes = (env.LIVE_DC_SPAWN_TYPES ?? '').split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  const workflowConfig = loadWorkflowConfig(spawnTypes.length ? { spawnTypes } : {});
  const profileName = env.LIVE_DC_PROFILE || workflowConfig.defaultProfile;
  if (!workflowConfig.profiles[profileName]) throw new Error(`unknown LIVE_DC_PROFILE '${profileName}'`);
  const heartbeat = Number(env.LIVE_DC_HEARTBEAT_SECONDS);
  return {
    workflowConfig,
    profileName,
    linkMode: env.LIVE_DC_LINK_MODE || 'live',
    heartbeatSeconds: env.LIVE_DC_HEARTBEAT_SECONDS && heartbeat >= 0 ? heartbeat : 900,
    publicApiBase: env.LIVE_DC_PUBLIC_API_BASE || '',
    holdOpen: parseHoldOpen(env.LIVE_DC_HOLD_OPEN),
  };
}

function summarize(report) {
  return {
    sourceStatus: report.sourceStatus ?? null,
    sync: report.sync ? { skipped: report.sync.skipped, reason: report.sync.reason, stats: report.sync.stats ?? null } : null,
    workflow: report.workflow ?? null,
    loads: Object.fromEntries(Object.entries(report.loads ?? {}).map(([name, load]) => [shortName(name), load.sent ?? 0])),
    capture: report.capture ?? null,
    errors: report.errors?.length ?? 0,
    warnings: report.warnings?.length ?? 0,
  };
}

const isRejected = error => error?.status === 400 || error?.status === 401 || error?.status === 403;

/** Messages from the writer never carry credentials or tokens; the cap keeps the public status small. */
const reasonOf = error => {
  if (error?.code === 'timeout') return 'timeout';
  if (error?.code === CREDENTIALS_UNAVAILABLE) return CREDENTIALS_UNAVAILABLE;
  if (error?.authRejected || error?.status === 401 || error?.status === 403) return 'auth_rejected';
  return String(error?.message ?? error).slice(0, REASON_MAX);
};

/**
 * The warm container keeps one client_credentials provider (so its token is reused for the hour);
 * a rejected token request re-reads the secret once per run and retries, for a rotated secret.
 */
function serviceClientTokens({ state, credentials, config, fetchImpl, now }) {
  const build = creds => {
    if (state.tokenCreds !== creds) {
      state.tokenCreds = creds;
      state.tokens = createClientCredentialsTokenProvider({
        tokenUrl: config.tokenUrl, clientId: creds.clientId, clientSecret: creds.clientSecret, scope: config.scope, fetchImpl, now,
      });
    }
    return state.tokens;
  };
  let refetched = false;
  return {
    renewable: true,
    invalidate: () => state.tokens?.invalidate(),
    async getToken() {
      try {
        return await build(await credentials.get()).getToken();
      } catch (error) {
        if (refetched || !isRejected(error)) throw error;
        refetched = true;
        credentials.invalidate();
        try {
          return await build(await credentials.get()).getToken();
        } catch (retryError) {
          if (isRejected(retryError)) retryError.authRejected = true;
          throw retryError;
        }
      }
    },
  };
}

/**
 * One cycle with the service client, or a skip. Always resolves to the status it wrote.
 * `state` keeps the cycle memory, asset cache and token across warm invocations.
 */
export async function runLiveDcStep({
  payload, credentials, writeStatus, env = {}, now = Date.now, logger = console, fetchImpl = fetch,
  createWriter = createDcWriter, runCycle = runLiveDcCycle, state = {}, deadlineMs,
  snapshotStore = null, createCapture = createEventCapture,
}) {
  const at = now();
  const status = { lastRunAt: iso(at), dcWrite: 'skipped', reason: null, fl511: payload?.sourceStatus ?? null, summary: null };

  try {
    const config = loadDcWriterConfig(env);
    if (!config.baseUrl || !config.loadBaseUrl) throw new DcWriterError(WRITER_ERRORS.NOT_CONFIGURED, 'writer URLs not set');
    await credentials.get();
    const tokenProvider = serviceClientTokens({ state, credentials, config, fetchImpl, now });
    const writer = createWriter({ config, tokenProvider, fetchImpl, logger });
    state.memory ??= createCycleMemory();
    state.writer = writer;
    state.assetCache ??= createAssetCache({
      // The cache outlives one run's writer; it always reads through the current one.
      writer: { findClassByName: (...args) => state.writer.findClassByName(...args), readAll: (...args) => state.writer.readAll(...args) },
      refreshSeconds: Number(env.LIVE_DC_ASSET_REFRESH_SECONDS) > 0 ? Number(env.LIVE_DC_ASSET_REFRESH_SECONDS) : 3600,
    });
    // Snapshots (S3 when a store is wired) and weather at first sight; direct upstream fetches, not the DataConnect fetch.
    state.capture ??= createCapture({ snapshotStore, logger });
    const service = { refresh: async () => {}, snapshot: async () => payload };
    const report = await withDeadline(runCycle({
      writer, service, now, assetCache: state.assetCache, memory: state.memory, logger, capture: state.capture, ...liveDcCycleOptions(env),
    }), deadlineMs);
    status.summary = summarize(report);
    status.dcWrite = report.errors?.length ? 'error' : 'ok';
    status.reason = report.errors?.length ? String(report.errors[0]).slice(0, REASON_MAX) : null;
  } catch (error) {
    if (error instanceof DcWriterError && error.code === WRITER_ERRORS.NOT_CONFIGURED) {
      status.dcWrite = 'skipped';
      status.reason = 'not_configured';
    } else {
      status.dcWrite = 'error';
      status.reason = reasonOf(error);
    }
  }

  logger.log?.(`live-dc: ${status.dcWrite}${status.reason ? ` (${status.reason})` : ''}`);
  try {
    await writeStatus(status);
  } catch (error) {
    logger.error?.(`live-dc: status write failed (${error?.name ?? 'Error'})`);
  }
  return status;
}

// ── Handler ───────────────────────────────────────────────────────────────────────────────────────

export function createPollerHandler({
  getService, ddb, emit, credentials = null, writeStatus = async () => {}, snapshotStore = null,
  env = process.env, now = Date.now, logger = console, liveDc = {},
}) {
  const state = {};
  return async function handler(_event, context) {
    const tableName = env.LIVE_EVENTS_TABLE;
    const busName = env.EVENTS_BUS_ARN;
    let payload;
    try {
      if (!tableName) throw new Error('LIVE_EVENTS_TABLE environment variable is not set');
      if (!busName) throw new Error('EVENTS_BUS_ARN environment variable is not set');
      // Lambda timers do not run while an execution environment is frozen, so each scheduled
      // invocation fetches fresh upstream data explicitly. This is the run's only FL511 poll.
      const svc = await getService();
      await svc.refresh();
      payload = await svc.getI595LiveEvents();
    } catch (error) {
      // Log but do not rethrow — a transient FL511 outage is already handled inside fl511Service.
      logger.error?.('FL511 poller error:', error);
      return;
    }

    try {
      await syncDynamo({ payload, tableName, busName, ddb, emit, now, logger });
    } catch (error) {
      logger.error?.('FL511 poller error:', error);
    }

    if (!credentials) return;
    const remaining = context?.getRemainingTimeInMillis?.();
    await runLiveDcStep({
      payload, env, now, logger, state, snapshotStore, credentials, writeStatus,
      deadlineMs: Number.isFinite(remaining) ? remaining - DEADLINE_MARGIN_MS : undefined,
      ...liveDc,
    });
  };
}
