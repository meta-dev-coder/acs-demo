#!/usr/bin/env node
/**
 * Builds deploy/ec2/dist/: live-dc-sync.mjs (one self-contained ESM file, config JSON inlined), data/ with
 * only the corridor GeoJSON the process reads, web/ (the I-595 frontend built for same-origin APIs with live
 * DataConnect on) and the ops files (install.sh, livedc.sh, live-dc.service, env.example). The bundle
 * defaults LIVE_DC_DATA_DIR and LIVE_DC_WEB_DIR to its sibling data/ and web/.
 *
 *   node tools/build-live-dc-bundle.mjs [--out <dir>] [--skip-web | --web-from <dir>] [--no-env-files]
 *
 * The web build runs `vite build` in a child process with a larger heap (LIVE_DC_WEB_BUILD_HEAP_MB, default
 * 6144: the default ~2 GB heap runs out of memory) and a clean environment: only the fixed same-origin
 * VITE_ values below plus a short allowlist of public browser keys, taken from the shell or, unless
 * --no-env-files, from the project .env files.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { ASK_LAYER_FILES, DICTIONARY_FILE, buildDataDictionary } from '../server/liveDc/dataDictionary.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EC2_DIR = join(ROOT, 'deploy', 'ec2');
export const DEFAULT_OUT_DIR = join(EC2_DIR, 'dist');

// server/i595Network.mjs SOURCES + FDOT segments; server/liveDc/eventEnrichment.mjs + api.mjs cameras; the
// corridor layers Ask the Twin searches (server/liveDc/askTools.mjs).
export const RUNTIME_DATA_FILES = Object.freeze([...new Set([
  'i595_mainline_eb.geojson', 'i595_mainline_wb.geojson', 'express-way.geojson', 'sr84_frontage_roads.geojson',
  'i595_ramps_connectors_classified.geojson', 'i595_fdot_traffic_segments.geojson', 'i595_corridor_cameras.geojson',
  ...ASK_LAYER_FILES,
])]);
export const OPS_FILES = Object.freeze(['install.sh', 'livedc.sh', 'live-dc.service', 'env.example']);

export const WEB_BUILD_ENV = Object.freeze({
  VITE_DATA_SOURCE: 'dataconnect',
  VITE_LIVE_DC: 'true',
  VITE_LIVE_EVENTS_API: '/api/i595/live-events',
  VITE_SNAPSHOT_BASE: '/api/i595/camera',
  VITE_MESSAGE_SIGNS_API: '/api/i595/message-signs',
  VITE_LIVE_DC_STATUS_URL: '/status/live-dc-status.json',
  VITE_ASK_THE_TWIN_API: '/api/i595/ask',
  VITE_ENABLE_CESIUM_CLIP_EDITOR: 'false',
});
export const WEB_PASSTHROUGH = Object.freeze([
  'VITE_CESIUM_ION_TOKEN', 'VITE_GOOGLE_MAPS_API_KEY', 'VITE_ENABLE_STREET_VIEW', 'VITE_I595_MODEL_BASE_URL',
]);
const PASSTHROUGH_PREFIX = 'VITE_DC_CLASS_';
const PROCESS_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'SYSTEMROOT'];

/** The child environment for the web build: nothing server-side, nothing pointing at the cloud APIs. */
export function webBuildEnv({ shellEnv = process.env, fileEnv = {} } = {}) {
  const env = { NODE_ENV: 'production', LIVE_DC_WEB_BUILD: '1' };
  for (const key of PROCESS_KEYS) if (shellEnv[key]) env[key] = shellEnv[key];
  const keys = new Set([...WEB_PASSTHROUGH, ...[...Object.keys(fileEnv), ...Object.keys(shellEnv)].filter(k => k.startsWith(PASSTHROUGH_PREFIX))]);
  for (const key of keys) {
    const value = shellEnv[key] ?? fileEnv[key];
    if (value !== undefined && value !== '') env[key] = String(value);
  }
  return Object.assign(env, WEB_BUILD_ENV);
}

const BANNER = [
  "import { dirname as __liveDcDirname, join as __liveDcJoin } from 'node:path';",
  "import { fileURLToPath as __liveDcFileURLToPath } from 'node:url';",
  "const __liveDcHere = __liveDcDirname(__liveDcFileURLToPath(import.meta.url));",
  "process.env.LIVE_DC_DATA_DIR ||= __liveDcJoin(__liveDcHere, 'data');",
  "process.env.LIVE_DC_WEB_DIR ||= __liveDcJoin(__liveDcHere, 'web');",
].join('\n');

function nodeAtLeast(major, minor) {
  const [a, b] = process.versions.node.split('.').map(Number);
  return a > major || (a === major && b >= minor);
}

async function readEnvFiles() {
  const { loadEnv } = await import('vite');
  return loadEnv('production', ROOT, 'VITE_');
}

/** `vite build` into outDir in a child process; fails with a clear message instead of a native crash dump. */
export async function buildLiveDcWeb({ outDir, envFiles = true, logger = console, heapMb = Number(process.env.LIVE_DC_WEB_BUILD_HEAP_MB) || 6144 } = {}) {
  if (!nodeAtLeast(20, 12)) throw new Error(`web build needs Node >= 20.12 (this is ${process.versions.node})`);
  const env = webBuildEnv({ shellEnv: process.env, fileEnv: envFiles ? await readEnvFiles() : {} });
  const passed = Object.keys(env).filter(k => k.startsWith('VITE_') && !(k in WEB_BUILD_ENV));
  logger.log?.(`live-dc web: vite build (heap ${heapMb} MB); public keys passed: ${passed.join(', ') || 'none'}`);
  const envDir = mkdtempSync(join(tmpdir(), 'live-dc-web-env-'));
  try {
    const code = await new Promise((done, fail) => {
      const child = spawn(process.execPath, [`--max-old-space-size=${heapMb}`, fileURLToPath(import.meta.url), '--web-child', relative(ROOT, outDir), envDir],
        { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20_000); });
      child.on('error', fail);
      child.on('exit', (exitCode, signal) => done({ exitCode, signal, stderr }));
    });
    if (code.exitCode !== 0) {
      const oom = /heap out of memory|Allocation failed/i.test(code.stderr) || code.signal === 'SIGABRT' || code.exitCode === 134;
      if (oom) throw new Error(`vite build ran out of memory with a ${heapMb} MB heap: raise LIVE_DC_WEB_BUILD_HEAP_MB (needs ~3 GB free RAM)`);
      const tail = code.stderr.split('\n').filter(l => l.trim() && !/Module level directives/.test(l)).slice(-15).join('\n');
      throw new Error(`vite build failed (exit ${code.exitCode ?? code.signal})${tail ? `:\n${tail}` : ''}`);
    }
  } finally {
    rmSync(envDir, { recursive: true, force: true });
  }
  for (const needed of ['index.html', join('cesium', 'Cesium.js')]) {
    if (!existsSync(join(outDir, needed))) throw new Error(`web build is incomplete: ${needed} is missing in ${outDir}`);
  }
}

async function runWebChild(outDirRel, envDir) {
  const { build: viteBuild } = await import('vite');
  // outDir stays relative to the project root: vite-plugin-cesium joins it onto the root.
  await viteBuild({ root: ROOT, configFile: join(ROOT, 'vite.config.js'), envDir, logLevel: 'error', build: { outDir: outDirRel, emptyOutDir: true } });
}

export async function buildLiveDcBundle({ outDir = DEFAULT_OUT_DIR, web = 'build', envFiles = true, logger = console } = {}) {
  if (web && typeof web === 'object' && !existsSync(join(web.from ?? '', 'index.html'))) {
    throw new Error(`web: ${web.from} has no index.html`);
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'data'), { recursive: true });
  const outfile = join(outDir, 'live-dc-sync.mjs');
  await build({
    entryPoints: [join(ROOT, 'tools', 'live-dc-sync.mjs')],
    outfile, bundle: true, platform: 'node', target: 'node20', format: 'esm',
    banner: { js: BANNER }, legalComments: 'none', logLevel: 'warning',
  });
  for (const name of RUNTIME_DATA_FILES) copyFileSync(join(ROOT, 'public', 'data', name), join(outDir, 'data', name));
  // The data dictionary Ask the Twin reasons with, built from the code's own config and these layers.
  const dictionary = buildDataDictionary({ readLayer: name => JSON.parse(readFileSync(join(outDir, 'data', name), 'utf8')) });
  writeFileSync(join(outDir, 'data', DICTIONARY_FILE), `${JSON.stringify(dictionary, null, 2)}\n`);
  for (const name of OPS_FILES) cpSync(join(EC2_DIR, name), join(outDir, name));
  if (web === 'build') await buildLiveDcWeb({ outDir: join(outDir, 'web'), envFiles, logger });
  else if (web) cpSync(web.from, join(outDir, 'web'), { recursive: true });
  const bytes = statSync(outfile).size;
  logger.log?.(`live-dc bundle: ${outfile} (${Math.round(bytes / 1024)} KiB) + ${RUNTIME_DATA_FILES.length} data files + ${DICTIONARY_FILE}`
    + `${web ? ' + web/' : ' (no web/)'} + ops files`);
  return { outfile, bytes, dataFiles: [...RUNTIME_DATA_FILES, DICTIONARY_FILE], web: Boolean(web) };
}

export function parseBundleArgs(argv) {
  const value = flag => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? resolve(argv[i + 1]) : null; };
  const webFrom = value('--web-from');
  return {
    outDir: value('--out') ?? DEFAULT_OUT_DIR,
    web: argv.includes('--skip-web') ? false : webFrom ? { from: webFrom } : 'build',
    envFiles: !argv.includes('--no-env-files'),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const task = argv[0] === '--web-child' ? runWebChild(argv[1], argv[2]) : buildLiveDcBundle(parseBundleArgs(argv));
  task.catch(error => {
    console.error(`build-live-dc-bundle: ${error.message}`);
    process.exitCode = 1;
  });
}
