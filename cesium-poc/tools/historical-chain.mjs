#!/usr/bin/env node
/**
 * Builds the Incident -> Ticket -> Task -> Work Order -> Inspection chain of every Bentley historical
 * incident (server/liveDc/historicalChain.mjs) and optionally loads it into
 * "SDNA Florida I595 Historical Chain".
 *
 *   node tools/historical-chain.mjs [--from-local] [--dry-run] [--out rows.json]
 *   node tools/historical-chain.mjs [--from-local] --apply
 *
 * Input: the seven Bentley historical classes, read (curated-data only) from DataConnect through the
 * writer config (DC_WRITER_*), or with --from-local the export in public/dataconnect-data/.
 * --dry-run (the default) prints stats and three sample chains. --apply sends only changed rows, as
 * Incremental loads through the guarded writer, into the chain class and nothing else.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServerEnv } from '../server/loadEnv.mjs';
import { HISTORICAL_CHAIN_CLASS, diffRecords, fromCurated } from '../server/liveDc/classes.mjs';
import { createDcWriter, loadDcWriterConfig, missingWriterConfig, DcWriterError, WRITER_ERRORS } from '../server/liveDc/dcWriter.mjs';
import { CHAIN_STEPS, SOURCE_CLASSES, buildHistoricalChains, chainStats } from '../server/liveDc/historicalChain.mjs';

const LOCAL_FILES = Object.freeze({
  incidents: 'incidents_v3', tickets: 'tickets', tasks: 'tasks', workOrders: 'work_orders',
  itsInspections: 'its_inspections_v3', roadwayInspections: 'roadway_inspections_v3', safetyInspections: 'safety_inspections_v3',
});
const LOAD_CHUNK = 500;
const USAGE = 'usage: historical-chain.mjs [--from-local] [--dry-run | --apply] [--out <file>]';

class Refusal extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function parseArgs(argv) {
  const args = { fromLocal: false, dryRun: false, apply: false, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from-local') args.fromLocal = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--out') {
      args.out = argv[++i];
      if (!args.out || args.out.startsWith('--')) throw new Refusal(`--out needs a file (${USAGE})`, 2);
    } else throw new Refusal(`unknown argument '${arg}' (${USAGE})`, 2);
  }
  if (args.apply && args.dryRun) throw new Refusal('--apply and --dry-run cannot be combined', 2);
  return args;
}

export function readLocalSources() {
  return Object.fromEntries(Object.entries(LOCAL_FILES).map(([key, name]) => [key, JSON.parse(readFileSync(
    fileURLToPath(new URL(`../public/dataconnect-data/${name}.json`, import.meta.url)), 'utf8'))]));
}

function makeWriter(env, fetchImpl, log, error) {
  const config = loadDcWriterConfig(env);
  const missing = missingWriterConfig(config);
  if (missing.length) throw new Refusal(`DataConnect needs ${missing.join(', ')} (or use --from-local for the input)`, 2);
  return createDcWriter({ config, fetchImpl, logger: { info: log, warn: error } });
}

async function readDataConnectSources(writer) {
  const sources = {};
  for (const [key, className] of Object.entries(SOURCE_CLASSES)) {
    sources[key] = await writer.readAll(await writer.findClassByName(className));
  }
  return sources;
}

const pad = (text, width) => String(text).padEnd(width);

function printStats(stats, source, log) {
  log(`historical chain from ${source}: chains: ${stats.chains} · rows: ${stats.rows}`);
  for (const step of CHAIN_STEPS) {
    const s = stats.byStep[step];
    log(`  ${pad(step, 11)} real ${s.bentley_link + s.root} · inferred ${s.inferred_same_asset} · synthetic ${s.synthetic}`);
  }
}

function sampleChains(rows) {
  const chains = new Map();
  for (const row of rows) {
    if (!chains.has(row.chain_id)) chains.set(row.chain_id, []);
    chains.get(row.chain_id).push(row);
  }
  const all = [...chains.values()];
  const find = (predicate) => all.find(predicate);
  const picks = [
    find((c) => c.some((r) => r.step === 'ticket' && !r.is_synthetic) && c.some((r) => r.step === 'work_order' && !r.is_synthetic)),
    find((c) => c.some((r) => r.step === 'inspection' && !r.is_synthetic)),
    find((c) => c.every((r) => r.step === 'incident' || r.is_synthetic)),
    ...all,
  ].filter(Boolean);
  return [...new Set(picks)].slice(0, 3);
}

function printSamples(rows, log) {
  for (const chain of sampleChains(rows)) {
    log(`sample ${chain[0].chain_id}:`);
    for (const r of chain) {
      log(`  ${r.step_order} ${pad(r.step, 10)} ${pad(r.record_id, 24)} [${r.link_method} · ${r.confidence}] ${r.link_detail}${r.step_date ? ` · ${r.step_date}` : ''}`);
    }
  }
}

async function applyRows(writer, rows, log) {
  const dto = await writer.resolveWritableClass(HISTORICAL_CHAIN_CLASS);
  if (dto.className !== HISTORICAL_CHAIN_CLASS) throw new Refusal(`refusing: resolved '${dto.className}', not '${HISTORICAL_CHAIN_CLASS}'`);
  const existing = (await writer.readAll(dto)).map(fromCurated);
  const { upserts, unchanged } = diffRecords(rows, existing);
  log(`${HISTORICAL_CHAIN_CLASS}: ${upserts.length} to send, ${unchanged} unchanged`);
  for (let i = 0; i < upserts.length; i += LOAD_CHUNK) {
    await writer.loadRecords(dto, upserts.slice(i, i + LOAD_CHUNK), { loadType: 'Incremental' });
  }
  log(`applied: ${upserts.length} rows loaded Incremental into ${HISTORICAL_CHAIN_CLASS}`);
}

/** @returns {Promise<number>} exit code */
export async function runHistoricalChain({
  argv = [], env = process.env, fetchImpl = fetch, log = console.log, error = console.error,
  readLocal = readLocalSources, writeFile = (file, text) => writeFileSync(file, text),
} = {}) {
  try {
    const args = parseArgs(argv);
    const writer = !args.fromLocal || args.apply ? makeWriter(env, fetchImpl, log, error) : null;
    const sources = args.fromLocal ? readLocal() : await readDataConnectSources(writer);
    const { rows } = buildHistoricalChains(sources);
    printStats(chainStats(rows), args.fromLocal ? 'local export' : 'DataConnect', log);
    printSamples(rows, log);
    if (args.out) {
      const out = resolve(process.cwd(), args.out);
      writeFile(out, `${JSON.stringify(rows, null, 2)}\n`);
      log(`wrote ${rows.length} rows to ${out}`);
    }
    if (!args.apply) {
      log('dry run: nothing written to DataConnect. Re-run with --apply to load the rows.');
      return 0;
    }
    await applyRows(writer, rows, log);
    return 0;
  } catch (failure) {
    error(`historical-chain: ${failure.message}`);
    if (failure instanceof Refusal) return failure.exitCode;
    return failure instanceof DcWriterError && failure.code === WRITER_ERRORS.NOT_CONFIGURED ? 2 : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadServerEnv();
  runHistoricalChain({ argv: process.argv.slice(2) }).then((code) => { process.exitCode = code; });
}
