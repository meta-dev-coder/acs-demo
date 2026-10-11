/**
 * Build the Ask the Twin store (SQLite) that local development and the EC2 ask service read.
 *
 *   node tools/twin-store.mjs --from-snapshot [--out <path>]
 *
 * --from-snapshot  builds from the JSON committed under public/dataconnect-data — no credentials,
 *                  no network. The only source today; a read-only DataConnect pull comes next.
 * --out            defaults to ASK_TWIN_STORE or .twin-store/twin.sqlite (git-ignored).
 *
 * Never writes to DataConnect.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { buildStoreFromSnapshot } from '../server/ask/twinStore.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_STORE_PATH = join(ROOT, '.twin-store', 'twin.sqlite');
export const SNAPSHOT_DIR = join(ROOT, 'public', 'dataconnect-data');

export function parseArgs(argv, env = process.env) {
  const args = { fromSnapshot: false, out: env.ASK_TWIN_STORE || DEFAULT_STORE_PATH };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from-snapshot') args.fromSnapshot = true;
    else if (argv[i] === '--out' && argv[i + 1]) args.out = resolve(argv[++i]);
    else throw new Error(`unknown argument '${argv[i]}'`);
  }
  if (!args.fromSnapshot) throw new Error('choose a source: --from-snapshot');
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { outPath, classes } = buildStoreFromSnapshot({ snapshotDir: SNAPSHOT_DIR, outPath: args.out });
    for (const c of classes) console.log(`${c.className.padEnd(36)} ${String(c.rowCount).padStart(6)} rows${c.skipped ? `, ${c.skipped} without an id left out` : ''}${c.duplicates ? `, ${c.duplicates} repeated ids kept as <id>#n` : ''}`);
    console.log(`twin store written: ${outPath}`);
  } catch (error) {
    console.error(`twin-store: ${error.message}`);
    process.exitCode = 1;
  }
}
