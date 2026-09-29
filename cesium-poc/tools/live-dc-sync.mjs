#!/usr/bin/env node
/**
 * Polls FL511 and pushes the I-595 corridor events, plus the incident workflow derived from them,
 * into the "SDNA Florida I595 Live *" DataConnect classes.
 *
 *   node tools/live-dc-sync.mjs [--once] [--interval <s>] [--profile demo|realistic] [--feed <fixture.json>]
 *   node tools/live-dc-sync.mjs --hash-password      (reads a password on stdin, prints LIVE_DEMO_PASSWORD_HASH)
 *
 * Reads DataConnect at DC_WRITER_BASE_URL and writes through its load service at DC_WRITER_LOAD_BASE_URL
 * (both required) with DC_WRITER_ACCESS_TOKEN,
 * DC_WRITER_ACCESS_TOKEN_FILE (re-read per request) or a client. There is no local target.
 * --feed     replaces FL511 with a JSON fixture (re-read every poll); no snapshot/weather capture:
 *            {incidents:[{itemId,latitude,longitude,title?}], closures:[], construction:[], congestion:[],
 *             disabledVehicles:[], details:{<itemId>:{title, description, fields:[]}}}
 *
 * LIVE_DC_HTTP_PORT (EC2 demo, deploy/ec2/) also serves the built frontend (LIVE_DC_WEB_DIR) and the read-only API
 * behind a password gate (LIVE_DEMO_PASSWORD_HASH) from this process; unset = sync only.
 * LIVE_DC_SERVICE_CLIENT_SECRET_NAME reads the client from Secrets Manager via the AWS CLI (EC2: deploy/ec2/).
 * Env: see the "Live DataConnect writer" block in .env.example. LIVE_DC_SNAPSHOT_BUCKET + LIVE_DC_SNAPSHOT_PUBLIC_BASE
 * store event camera snapshots with the AWS CLI; LIVE_DC_PUBLIC_API_BASE makes camera_snapshot_url absolute.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServerEnv } from '../server/loadEnv.mjs';
import { loadConfig } from '../server/config.mjs';
import { loadI595Network } from '../server/i595Network.mjs';
import { createFl511Service } from '../server/fl511Service.mjs';
import { LINK_MODES } from '../server/liveDc/classes.mjs';
import { WRITER_ERRORS, createDcWriter, loadDcWriterConfig, missingWriterConfig } from '../server/liveDc/dcWriter.mjs';
import { loadWorkflowConfig } from '../server/liveDc/workflow.mjs';
import { createAssetCache, createCycleMemory, parseHoldOpen, runLiveDcCycle } from '../server/liveDc/cycle.mjs';
import { createEventCapture } from '../server/liveDc/eventCapture.mjs';
import { snapshotStoreFromEnv } from '../server/liveDc/eventSnapshots.mjs';
import { publicBaseUrl } from '../server/liveDc/eventEnrichment.mjs';
import { applyServiceClientSecret } from '../server/liveDc/awsSecret.mjs';
import { hashPassword } from '../server/liveDc/demoAuth.mjs';
import { createSyncStatus, loadDemoHttpConfig, startDemoHttp } from '../server/liveDc/demoServer.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REMOVED_FLAGS = Object.freeze(['--standin', '--remote']);

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = 2;
  }
}

const positive = (value, name) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError(`${name} must be a positive number`);
  return parsed;
};

export function parseSyncArgs(argv) {
  const args = { once: false, interval: null, profile: null, feed: null, hashPassword: false };
  const value = (i, flag) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--once': args.once = true; break;
      case '--hash-password': args.hashPassword = true; break;
      case '--interval': args.interval = positive(value(i, flag), flag); i++; break;
      case '--profile': args.profile = value(i, flag); i++; break;
      case '--feed': args.feed = value(i, flag); i++; break;
      default:
        if (REMOVED_FLAGS.includes(flag)) throw new UsageError(`${flag} was removed: the only target is DataConnect at DC_WRITER_BASE_URL`);
        throw new UsageError(`unknown argument ${flag}`);
    }
  }
  return args;
}

/** Writer config for DataConnect. Refuses before any request when the target or a credential is missing. */
export function writerSetup({ env }) {
  const config = loadDcWriterConfig(env);
  const missing = missingWriterConfig(config);
  if (missing.length) throw new UsageError(`DataConnect writer not configured: set ${missing.join(' and ')}`);
  return { config, tokenProvider: undefined, mode: 'DataConnect' };
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return '<invalid URL>'; }
}

/** An FL511 client that serves a JSON fixture instead of the network. */
export function createFixtureClient(readFixture) {
  const list = key => async () => readFixture()?.[key] ?? [];
  return {
    fetchIncidents: list('incidents'),
    fetchClosures: list('closures'),
    fetchConstruction: list('construction'),
    fetchCongestion: list('congestion'),
    fetchDisabledVehicles: list('disabledVehicles'),
    fetchEventDetails: async (_layerId, itemId) => readFixture()?.details?.[itemId] ?? null,
  };
}

const shortName = name => name.replace(/^SDNA Florida I595 Live /, '').replace(/\s+/g, '');

export function formatCycleSummary(report) {
  const s = report.sync?.stats;
  const sync = !report.sync ? 'events: -'
    : report.sync.skipped ? `events: skipped(${report.sync.reason})`
      : `events: seen=${s.seen} new=${s.new} updated=${s.updated} heartbeat=${s.heartbeat} reactivated=${s.reactivated} `
        + `cleared=${s.cleared} unchanged=${s.unchanged}`;
  const w = report.workflow;
  const workflow = w
    ? `workflow: chains=${w.chains} tickets=${w.tickets} tasks=${w.tasks} wo=${w.workOrders} insp=${w.inspections} `
      + `damaged=${w.damaged} passed=${w.passed}`
    : 'workflow: -';
  const loads = Object.entries(report.loads).map(([name, l]) => `${shortName(name)}=${l.sent}`).join(' ') || '-';
  const c = report.capture;
  const capture = c ? `capture: first=${c.snapshots.first} cleared=${c.snapshots.cleared} failed=${c.snapshots.failed} `
    + `weather=${c.weather.captured}/${c.weather.failed} | ` : '';
  return `live-dc cycle ${report.at} source=${report.sourceStatus ?? '-'} | ${sync} | ${workflow} | loads: ${loads} `
    + `| ${capture}errors=${report.errors.length} warnings=${report.warnings.length}`;
}

const MISSING_CLASSES_HINT = 'The Live classes must be created by a DataConnect admin first: see '
  + 'config/liveDc/live-classes.create-requests.json (POST /class, then POST /class/{id} with `add`, in order) '
  + 'and server/liveDc/README.md. Never use /admin/data/import.';

/** One line from stdin; on a terminal the input is not echoed. */
function readSecretLine(prompt) {
  const input = process.stdin;
  return new Promise((resolve, reject) => {
    let buffer = '';
    const tty = input.isTTY && typeof input.setRawMode === 'function';
    if (tty) { process.stderr.write(prompt); input.setRawMode(true); }
    input.setEncoding('utf8');
    const finish = value => {
      input.off('data', onData);
      input.off('end', onEnd);
      if (tty) { input.setRawMode(false); process.stderr.write('\n'); }
      input.pause();
      resolve(value);
    };
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\u0003') { if (tty) input.setRawMode(false); reject(new UsageError('cancelled')); return; }
        if (ch === '\r' || ch === '\n') { finish(buffer); return; }
        if (ch === '\u007f' || ch === '\b') buffer = buffer.slice(0, -1); else buffer += ch;
      }
    };
    const onEnd = () => finish(buffer);
    input.on('data', onData);
    input.on('end', onEnd);
    input.resume();
  });
}

async function printPasswordHash() {
  const password = await readSecretLine('Demo password: ');
  if (!password) throw new UsageError('empty password');
  if (process.stdin.isTTY && password !== await readSecretLine('Repeat: ')) throw new UsageError('passwords do not match');
  console.log(hashPassword(password));
  return 0;
}

async function main(argv) {
  let args;
  try {
    args = parseSyncArgs(argv);
  } catch (error) {
    console.error(`live-dc-sync: ${error.message}`);
    return 2;
  }
  if (args.hashPassword) {
    try {
      return await printPasswordHash();
    } catch (error) {
      console.error(`live-dc-sync: ${error.message}`);
      return error instanceof UsageError ? 2 : 1;
    }
  }
  loadServerEnv();
  const env = process.env;

  let workflowConfig, profileName, linkMode, holdOpen, heartbeatSeconds, assetRefreshSeconds, intervalSeconds, httpConfig;
  try {
    const spawnTypes = (env.LIVE_DC_SPAWN_TYPES ?? '').split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
    workflowConfig = loadWorkflowConfig(spawnTypes.length ? { spawnTypes } : {});
    profileName = args.profile || env.LIVE_DC_PROFILE || workflowConfig.defaultProfile;
    if (!workflowConfig.profiles[profileName]) throw new UsageError(`unknown profile '${profileName}'`);
    linkMode = env.LIVE_DC_LINK_MODE || 'live';
    if (!LINK_MODES.includes(linkMode)) throw new UsageError(`LIVE_DC_LINK_MODE must be one of ${LINK_MODES.join(', ')}`);
    holdOpen = parseHoldOpen(env.LIVE_DC_HOLD_OPEN);
    heartbeatSeconds = env.LIVE_DC_HEARTBEAT_SECONDS ? Number(env.LIVE_DC_HEARTBEAT_SECONDS) : 900;
    if (!Number.isFinite(heartbeatSeconds) || heartbeatSeconds < 0) throw new UsageError('LIVE_DC_HEARTBEAT_SECONDS must be >= 0');
    assetRefreshSeconds = env.LIVE_DC_ASSET_REFRESH_SECONDS ? positive(env.LIVE_DC_ASSET_REFRESH_SECONDS, 'LIVE_DC_ASSET_REFRESH_SECONDS') : 3600;
    intervalSeconds = args.interval ?? (env.LIVE_DC_INTERVAL_SECONDS ? positive(env.LIVE_DC_INTERVAL_SECONDS, 'LIVE_DC_INTERVAL_SECONDS') : 60);
    try {
      httpConfig = args.once ? null : loadDemoHttpConfig(env);
    } catch (error) {
      throw new UsageError(error.message);
    }
  } catch (error) {
    console.error(`live-dc-sync: ${error.message}`);
    return error instanceof UsageError ? 2 : 1;
  }

  let setup;
  try {
    await applyServiceClientSecret({ env });
    setup = writerSetup({ env });
  } catch (error) {
    console.error(`live-dc-sync: ${error.message}`);
    return error instanceof UsageError ? 2 : 1;
  }

  console.log(`live-dc target: ${originOf(setup.config.baseUrl)} (${setup.mode}) loads: ${originOf(setup.config.loadBaseUrl)}`);
  console.log(`live-dc profile=${profileName} linkMode=${linkMode} spawnTypes=${workflowConfig.spawnTypes.join(',')} `
    + `source=${args.feed ? `fixture ${args.feed}` : 'FL511'}${args.once ? ' once' : ` every ${intervalSeconds}s`}`);

  let writer;
  try {
    writer = createDcWriter({ config: setup.config, tokenProvider: setup.tokenProvider });
  } catch (error) {
    console.error(`live-dc-sync: ${error.message}`);
    return 2;
  }
  const feedPath = args.feed ? resolve(process.cwd(), args.feed) : null;
  const dataDir = env.LIVE_DC_DATA_DIR || join(ROOT, 'public', 'data');
  const network = await loadI595Network(dataDir);
  const service = createFl511Service({
    config: loadConfig(env),
    network,
    client: feedPath ? createFixtureClient(() => JSON.parse(readFileSync(feedPath, 'utf8'))) : undefined,
    logger: console,
  });
  const memory = createCycleMemory();
  const assetCache = createAssetCache({ writer, refreshSeconds: assetRefreshSeconds });
  // A fixture feed runs offline: no DIVAS, Open-Meteo or S3 requests.
  const snapshotStore = feedPath ? null : snapshotStoreFromEnv(env);
  const capture = feedPath ? null : createEventCapture({ snapshotStore, logger: console });
  const publicApiBase = publicBaseUrl(env.LIVE_DC_PUBLIC_API_BASE);
  console.log(`live-dc capture=${capture ? 'on' : 'off (--feed)'} snapshots=${snapshotStore
    ? `s3://${env.LIVE_DC_SNAPSHOT_BUCKET}/snapshots/ (aws cli)` : 'off'} camera links=${publicApiBase || 'relative'}`);

  const status = createSyncStatus({ intervalSeconds });
  let http = null;
  if (httpConfig) {
    try {
      http = await startDemoHttp({
        env, httpConfig: { ...httpConfig, webDir: httpConfig.webDir || join(ROOT, 'dist') }, service, network, dataDir, status, logger: console,
      });
    } catch (error) {
      console.error(`live-dc-sync: HTTP host failed to start on ${httpConfig.host}:${httpConfig.port}: ${error.message}`);
      service.stop();
      return 1;
    }
    console.log(`live-dc http listening on ${http.url} (password required; /healthz open)`);
  }

  let stopping = false;
  let wake = null;
  const shutdown = async () => {
    service.stop();
    await http?.close().catch(() => {});
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      stopping = true;
      wake?.();
      shutdown().finally(() => process.exit(0));
    });
  }

  let exitCode = 0;
  while (!stopping) {
    const started = Date.now();
    try {
      const report = await runLiveDcCycle({
        writer, service, workflowConfig, profileName, heartbeatSeconds, assetCache, memory, linkMode, logger: console, capture, publicApiBase, holdOpen,
      });
      console.log(formatCycleSummary(report));
      status.recordCycle(report);
      if (args.once && report.errors.length) exitCode = 1;
    } catch (error) {
      if (error?.code === WRITER_ERRORS.LIVE_CLASS_MISSING) {
        console.error(`live-dc-sync: ${error.message}\n${MISSING_CLASSES_HINT}`);
        exitCode = 1;
        break;
      }
      console.error(`live-dc-sync: cycle failed: ${error.message}`);
      status.recordFailure(error);
      if (args.once) exitCode = 1;
    }
    if (args.once || stopping) break;
    // Scheduled after the previous cycle finishes, so cycles never overlap.
    const delay = Math.max(0, intervalSeconds * 1000 - (Date.now() - started));
    await new Promise(done => {
      const timer = setTimeout(done, delay);
      wake = () => { clearTimeout(timer); done(); };
    });
    wake = null;
  }
  if (!stopping) await shutdown();
  return exitCode;
}

const isMain = () => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};

if (process.argv[1] && isMain()) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, (error) => {
    console.error(`live-dc-sync: ${error.message}`);
    process.exitCode = 1;
  });
}
