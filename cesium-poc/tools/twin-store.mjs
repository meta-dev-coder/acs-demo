/**
 * Build the Ask the Twin store (SQLite) that local development and the EC2 ask service read.
 *
 *   node tools/twin-store.mjs --from-snapshot     [--out <path>]
 *   node tools/twin-store.mjs --from-dataconnect  [--out <path>] [--no-snapshot-fallback]
 *
 * --from-snapshot     builds from the JSON committed under public/dataconnect-data — no credentials,
 *                     no network.
 * --from-dataconnect  reads every SDNA live class and every historical class through the same read
 *                     clients as `npm run dev` (cesium-poc/.env.local, `npm run dc:login`), compacts the
 *                     records and writes the store. A class DataConnect does not return is filled from
 *                     the snapshot unless --no-snapshot-fallback is given. Read-only: never writes to
 *                     DataConnect.
 * --out               defaults to ASK_TWIN_STORE or .twin-store/twin.sqlite (git-ignored).
 */
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { buildStoreFromSnapshot } from '../server/ask/twinStore.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_STORE_PATH = join(ROOT, '.twin-store', 'twin.sqlite');
export const SNAPSHOT_DIR = join(ROOT, 'public', 'dataconnect-data');

export function parseArgs(argv, env = process.env) {
  const args = { source: null, out: env.ASK_TWIN_STORE || DEFAULT_STORE_PATH, snapshotFallback: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from-snapshot') args.source = 'snapshot';
    else if (argv[i] === '--from-dataconnect') args.source = 'dataconnect';
    else if (argv[i] === '--no-snapshot-fallback') args.snapshotFallback = false;
    else if (argv[i] === '--out' && argv[i + 1]) args.out = resolve(argv[++i]);
    else throw new Error(`unknown argument '${argv[i]}'`);
  }
  if (!args.source) throw new Error('choose a source: --from-snapshot or --from-dataconnect');
  return args;
}

const kb = n => `${Math.round(n / 1024).toLocaleString('en-US')} KB`;

/** The DataConnect read clients `npm run dev` uses, or the reason each is unavailable. */
export async function readClients() {
  const { loadServerEnv } = await import('../server/loadEnv.mjs');
  loadServerEnv();
  const { createLiveDcReadApi, loadLiveDcReadConfig } = await import('../server/liveDc/liveReadApi.mjs');
  const { createDataConnectApi } = await import('../server/dataConnect.mjs');
  const quiet = { log() {}, warn() {}, error() {} };
  const historical = createDataConnectApi({ logger: quiet });
  const missing = historical.missing();
  const liveConfig = loadLiveDcReadConfig();
  return {
    liveDc: liveConfig.baseUrl ? createLiveDcReadApi({ config: liveConfig, logger: quiet }) : null,
    historical: missing.length ? null : historical,
    notes: [
      ...(liveConfig.baseUrl ? [] : ['live classes: LIVE_DC_READ_BASE_URL is not set']),
      ...(missing.length ? [`historical classes: missing ${missing.join(', ')}`] : []),
    ],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.source === 'snapshot') {
    const { outPath, classes } = buildStoreFromSnapshot({ snapshotDir: SNAPSHOT_DIR, outPath: args.out });
    for (const c of classes) console.log(`${c.className.padEnd(36)} ${String(c.rowCount).padStart(6)} rows${c.skipped ? `, ${c.skipped} without an id left out` : ''}${c.duplicates ? `, ${c.duplicates} repeated ids kept as <id>#n` : ''}`);
    console.log(`twin store written: ${outPath}`);
    return;
  }
  const { buildStoreFromDataConnect } = await import('../server/ask/dataConnectPull.mjs');
  const { liveDc, historical, notes } = await readClients();
  for (const note of notes) console.log(`note: ${note}`);
  if (!liveDc && !historical) throw new Error('DataConnect is not configured: see cesium-poc/server/liveDc/README.md (.env.local, npm run dc:login)');
  const result = await buildStoreFromDataConnect({ liveDc, historical, outPath: args.out, snapshotDir: args.snapshotFallback ? SNAPSHOT_DIR : null });
  for (const r of result.report) {
    const line = r.error ? `ERROR ${r.error}`
      : r.kind === 'snapshot' ? `${String(r.rows).padStart(6)} rows (snapshot fallback)`
        : `${String(r.rows).padStart(6)} rows, ${r.pages} page(s)${r.truncated ? ', TRUNCATED' : ''}, ${kb(r.rawBytes)} → ${kb(r.compactBytes)} after compaction`;
    console.log(`${`[${r.kind}]`.padEnd(13)} ${r.className.padEnd(38)} ${line}`);
  }
  if (!result.written) throw new Error('DataConnect returned no class; the existing store was left as it was');
  console.log(`twin store written: ${result.outPath} (${kb(result.bytes)})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`twin-store: ${error.message}`);
    process.exitCode = 1;
  });
}
