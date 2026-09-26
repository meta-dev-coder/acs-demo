#!/usr/bin/env node
/**
 * Polls FL511 and pushes the I-595 corridor events, plus the incident workflow derived from them,
 * into the "SDNA Florida I595 Live *" DataConnect classes.
 *
 *   node tools/live-dc-sync.mjs [--once] [--interval <s>] [--profile demo|realistic] [--feed <fixture.json>]
 *
 * Reads DataConnect at DC_WRITER_BASE_URL and writes through its load service at DC_WRITER_LOAD_BASE_URL
 * (both required) with DC_WRITER_ACCESS_TOKEN,
 * DC_WRITER_ACCESS_TOKEN_FILE (re-read per request) or a client. There is no local target.
 * --feed     replaces FL511 with a JSON fixture (re-read every poll):
 *            {incidents:[{itemId,latitude,longitude,title?}], closures:[], construction:[], congestion:[],
 *             disabledVehicles:[], details:{<itemId>:{title, description, fields:[]}}}
 *
 * Env: see the "Live DataConnect writer" block in .env.example.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServerEnv } from '../server/loadEnv.mjs';
import { loadConfig } from '../server/config.mjs';
import { loadI595Network } from '../server/i595Network.mjs';
import { createFl511Service } from '../server/fl511Service.mjs';
import { LINK_MODES } from '../server/liveDc/classes.mjs';
import { WRITER_ERRORS, createDcWriter, loadDcWriterConfig, missingWriterConfig } from '../server/liveDc/dcWriter.mjs';
import { loadWorkflowConfig } from '../server/liveDc/workflow.mjs';
import { createAssetCache, createCycleMemory, runLiveDcCycle } from '../server/liveDc/cycle.mjs';

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
  const args = { once: false, interval: null, profile: null, feed: null };
  const value = (i, flag) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--once': args.once = true; break;
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
  return `live-dc cycle ${report.at} source=${report.sourceStatus ?? '-'} | ${sync} | ${workflow} | loads: ${loads} `
    + `| errors=${report.errors.length} warnings=${report.warnings.length}`;
}

const MISSING_CLASSES_HINT = 'The Live classes must be created by a DataConnect admin first: see '
  + 'config/liveDc/live-classes.create-requests.json (POST /class, then POST /class/{id} with `add`, in order) '
  + 'and server/liveDc/README.md. Never use /admin/data/import.';

async function main(argv) {
  let args;
  try {
    args = parseSyncArgs(argv);
  } catch (error) {
    console.error(`live-dc-sync: ${error.message}`);
    return 2;
  }
  loadServerEnv();
  const env = process.env;

  let workflowConfig, profileName, linkMode, heartbeatSeconds, assetRefreshSeconds, intervalSeconds;
  try {
    const spawnTypes = (env.LIVE_DC_SPAWN_TYPES ?? '').split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
    workflowConfig = loadWorkflowConfig(spawnTypes.length ? { spawnTypes } : {});
    profileName = args.profile || env.LIVE_DC_PROFILE || workflowConfig.defaultProfile;
    if (!workflowConfig.profiles[profileName]) throw new UsageError(`unknown profile '${profileName}'`);
    linkMode = env.LIVE_DC_LINK_MODE || 'live';
    if (!LINK_MODES.includes(linkMode)) throw new UsageError(`LIVE_DC_LINK_MODE must be one of ${LINK_MODES.join(', ')}`);
    heartbeatSeconds = env.LIVE_DC_HEARTBEAT_SECONDS ? Number(env.LIVE_DC_HEARTBEAT_SECONDS) : 900;
    if (!Number.isFinite(heartbeatSeconds) || heartbeatSeconds < 0) throw new UsageError('LIVE_DC_HEARTBEAT_SECONDS must be >= 0');
    assetRefreshSeconds = env.LIVE_DC_ASSET_REFRESH_SECONDS ? positive(env.LIVE_DC_ASSET_REFRESH_SECONDS, 'LIVE_DC_ASSET_REFRESH_SECONDS') : 3600;
    intervalSeconds = args.interval ?? (env.LIVE_DC_INTERVAL_SECONDS ? positive(env.LIVE_DC_INTERVAL_SECONDS, 'LIVE_DC_INTERVAL_SECONDS') : 60);
  } catch (error) {
    console.error(`live-dc-sync: ${error.message}`);
    return error instanceof UsageError ? 2 : 1;
  }

  let setup;
  try {
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
  const service = createFl511Service({
    config: loadConfig(env),
    network: await loadI595Network(join(ROOT, 'public', 'data')),
    client: feedPath ? createFixtureClient(() => JSON.parse(readFileSync(feedPath, 'utf8'))) : undefined,
    logger: console,
  });
  const memory = createCycleMemory();
  const assetCache = createAssetCache({ writer, refreshSeconds: assetRefreshSeconds });

  let stopping = false;
  let wake = null;
  const shutdown = async () => { service.stop(); };
  process.once('SIGINT', () => {
    stopping = true;
    wake?.();
    shutdown().finally(() => process.exit(0));
  });

  let exitCode = 0;
  while (!stopping) {
    const started = Date.now();
    try {
      const report = await runLiveDcCycle({
        writer, service, workflowConfig, profileName, heartbeatSeconds, assetCache, memory, linkMode, logger: console,
      });
      console.log(formatCycleSummary(report));
      if (args.once && report.errors.length) exitCode = 1;
    } catch (error) {
      if (error?.code === WRITER_ERRORS.LIVE_CLASS_MISSING) {
        console.error(`live-dc-sync: ${error.message}\n${MISSING_CLASSES_HINT}`);
        exitCode = 1;
        break;
      }
      console.error(`live-dc-sync: cycle failed: ${error.message}`);
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, (error) => {
    console.error(`live-dc-sync: ${error.message}`);
    process.exitCode = 1;
  });
}
