#!/usr/bin/env node
/**
 * Builds deploy/ec2/dist/: live-dc-sync.mjs (one self-contained ESM file, config JSON inlined), data/ with
 * only the corridor GeoJSON the process reads, web/ (the I-595 frontend built for same-origin APIs with live
 * DataConnect on) and the ops files (install.sh, livedc.sh, live-dc.service, env.example). The bundle
 * defaults LIVE_DC_DATA_DIR and LIVE_DC_WEB_DIR to its sibling data/ and web/.
 *
 *   node tools/build-live-dc-bundle.mjs [--out <dir>] [--skip-web | --web-from <dir>] [--no-env-files] [--skip-portmiami]
 *
 * The web build runs `vite build` in a child process with a larger heap (LIVE_DC_WEB_BUILD_HEAP_MB, default
 * 6144: the default ~2 GB heap runs out of memory) and a clean environment: only the fixed same-origin
 * VITE_ values below plus a short allowlist of public browser keys, taken from the shell or, unless
 * --no-env-files, from the project .env files.
 *
 * It also carries the PortMiami Digital Twin (../portmiami-digital-twin, a separate project), unless
 * --skip-portmiami: its frontend built with base /portmiami/ into web/portmiami/, and its API bundled into
 * portmiami/api.mjs with the roads it reads (portmiami/data/) and the first contents of its design and
 * geometry stores (portmiami/seed/). The demo host serves both (server/liveDc/portMiami.mjs). PortMiami's
 * web build gets only its own public browser keys, from the shell or its .env files.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { ASK_LAYER_FILES, DICTIONARY_FILE, buildDataDictionary } from '../server/liveDc/dataDictionary.mjs';
import { SNAPSHOT_CLASSES } from '../server/ask/twinStore.mjs';

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
/** Where the bundle carries the DataConnect snapshot, under data/. */
export const SNAPSHOT_SUBDIR = 'dataconnect-data';
export const OPS_FILES = Object.freeze(['install.sh', 'livedc.sh', 'live-dc.service', 'live-dc-ask.service', 'env.example']);
/** The Ask the Twin service, bundled beside the sync for live-dc-ask.service (phase 2). */
export const ASK_BUNDLE = 'live-dc-ask.mjs';

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
  "process.env.LIVE_DC_PORTMIAMI_DIR ||= __liveDcJoin(__liveDcHere, 'portmiami');",
].join('\n');

// ---- PortMiami Digital Twin ----------------------------------------------------------------------------------
export const PORTMIAMI_ROOT = join(ROOT, '..', 'portmiami-digital-twin');
export const PORTMIAMI_BASE = '/portmiami/';
/** The browser keys PortMiami's frontend may receive; everything else stays out of its bundle. */
export const PORTMIAMI_WEB_PASSTHROUGH = Object.freeze(['VITE_GOOGLE_MAPS_API_KEY', 'VITE_CESIUM_ION_TOKEN', 'VITE_ENABLE_STREET_VIEW']);
export const PORTMIAMI_DATA_FILES = Object.freeze({ 'portmiami_roads_merged.geojson': join('public', 'data', 'portmiami_roads_merged.geojson') });
export const PORTMIAMI_SEED_FILES = Object.freeze({
  'design-alternatives.json': join('server', 'data', 'design-alternatives.json'),
  'asset-geometry.json': join('server', 'data', 'asset-geometry.json'),
});
/** What portMiami.mjs imports from portmiami/api.mjs. */
const PORTMIAMI_API_ENTRY = [
  "export { createLiveTrafficApi } from './api.mjs';",
  "export { createDesignStore } from './designStore.mjs';",
  "export { createGeometryStore } from './geometryStore.mjs';",
  "export { loadFl511Config } from '../fl511/config.mjs';",
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

/** The child environment for PortMiami's web build: its base path and its own public browser keys only. */
export function portMiamiWebEnv({ shellEnv = process.env, fileEnv = {} } = {}) {
  const env = { NODE_ENV: 'production', PORTMIAMI_BASE };
  for (const key of PROCESS_KEYS) if (shellEnv[key]) env[key] = shellEnv[key];
  for (const key of PORTMIAMI_WEB_PASSTHROUGH) {
    const value = shellEnv[key] ?? fileEnv[key];
    if (value !== undefined && value !== '') env[key] = String(value);
  }
  return env;
}

/** PortMiami's own vite, its ES module entry, from its own node_modules (it pins its own Cesium). */
function portMiamiVite() {
  try {
    const pkgPath = createRequire(join(PORTMIAMI_ROOT, 'package.json')).resolve('vite/package.json');
    const entry = JSON.parse(readFileSync(pkgPath, 'utf8')).exports?.['.']?.import;
    const file = typeof entry === 'string' ? entry : entry?.default;
    return file ? join(dirname(pkgPath), file) : null;
  } catch {
    return null;
  }
}

async function runPortMiamiWebChild(outDirRel, envDir) {
  const { build: viteBuild } = await import(pathToFileURL(portMiamiVite()).href);
  await viteBuild({
    root: PORTMIAMI_ROOT, configFile: join(PORTMIAMI_ROOT, 'vite.config.js'), envDir, base: PORTMIAMI_BASE, logLevel: 'error',
    build: { outDir: outDirRel, emptyOutDir: true },
  });
}

/**
 * PortMiami into the bundle: portmiami/api.mjs (+ data/, seed/) and, when `web`, web/portmiami/.
 * vite-plugin-cesium writes Cesium under <outDir><base>cesium; the page asks for <base>cesium, which is
 * <outDir>/cesium when outDir is served at the base, so it is moved there.
 */
export async function buildPortMiami({ outDir, web = true, envFiles = true, logger = console, heapMb = Number(process.env.LIVE_DC_WEB_BUILD_HEAP_MB) || 6144 } = {}) {
  if (!existsSync(join(PORTMIAMI_ROOT, 'server', 'portmiami', 'api.mjs'))) throw new Error(`PortMiami not found at ${PORTMIAMI_ROOT} (use --skip-portmiami to leave it out)`);
  const apiDir = join(outDir, 'portmiami');
  rmSync(apiDir, { recursive: true, force: true });
  await build({
    stdin: { contents: PORTMIAMI_API_ENTRY, resolveDir: join(PORTMIAMI_ROOT, 'server', 'portmiami'), sourcefile: 'portmiami-entry.mjs', loader: 'js' },
    outfile: join(apiDir, 'api.mjs'), bundle: true, platform: 'node', target: 'node20', format: 'esm', legalComments: 'none', logLevel: 'warning',
  });
  for (const [sub, files] of [['data', PORTMIAMI_DATA_FILES], ['seed', PORTMIAMI_SEED_FILES]]) {
    mkdirSync(join(apiDir, sub), { recursive: true });
    for (const [name, from] of Object.entries(files)) copyFileSync(join(PORTMIAMI_ROOT, from), join(apiDir, sub, name));
  }
  if (!web) { logger.log?.('portmiami: API bundled; no web build (the bundle has no web/)'); return { web: false }; }
  if (!portMiamiVite()) throw new Error(`PortMiami's dependencies are not installed: run npm ci in ${PORTMIAMI_ROOT}`);
  const webOut = join(outDir, 'web', 'portmiami');
  const fileEnv = envFiles ? (await import('vite')).loadEnv('production', PORTMIAMI_ROOT, 'VITE_') : {};
  const env = portMiamiWebEnv({ shellEnv: process.env, fileEnv });
  const passed = Object.keys(env).filter(k => k.startsWith('VITE_'));
  logger.log?.(`portmiami web: vite build at ${PORTMIAMI_BASE}; public keys passed: ${passed.join(', ') || 'none'}`);
  const envDir = mkdtempSync(join(tmpdir(), 'portmiami-web-env-'));
  try {
    const code = await new Promise((done, fail) => {
      const child = spawn(process.execPath, [`--max-old-space-size=${heapMb}`, fileURLToPath(import.meta.url), '--portmiami-web-child', relative(PORTMIAMI_ROOT, webOut), envDir],
        { cwd: PORTMIAMI_ROOT, env, stdio: ['ignore', 'inherit', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20_000); });
      child.on('error', fail);
      child.on('exit', (exitCode, signal) => done({ exitCode, signal, stderr }));
    });
    if (code.exitCode !== 0) {
      const tail = code.stderr.split('\n').filter(l => l.trim()).slice(-15).join('\n');
      throw new Error(`portmiami vite build failed (exit ${code.exitCode ?? code.signal})${tail ? `:\n${tail}` : ''}`);
    }
  } finally {
    rmSync(envDir, { recursive: true, force: true });
  }
  const nested = join(webOut, PORTMIAMI_BASE.replace(/^\/|\/$/g, ''));
  if (existsSync(join(nested, 'cesium'))) {
    rmSync(join(webOut, 'cesium'), { recursive: true, force: true });
    renameSync(join(nested, 'cesium'), join(webOut, 'cesium'));
    if (!readdirSync(nested).length) rmSync(nested, { recursive: true, force: true });
  }
  for (const needed of ['index.html', join('cesium', 'Cesium.js'), join('data', 'cruise', 'portmiami_november_2026_enriched.json')]) {
    if (!existsSync(join(webOut, needed))) throw new Error(`portmiami web build is incomplete: ${needed} is missing in ${webOut}`);
  }
  return { web: true };
}

// `portmiami` is off unless asked for: the CLI (parseBundleArgs) and the release ask for it by default.
export async function buildLiveDcBundle({ outDir = DEFAULT_OUT_DIR, web = 'build', envFiles = true, portmiami = false, logger = console } = {}) {
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
  await build({
    entryPoints: [join(ROOT, 'tools', 'ask-serve.mjs')],
    outfile: join(outDir, ASK_BUNDLE), bundle: true, platform: 'node', target: 'node22', format: 'esm',
    banner: { js: BANNER }, legalComments: 'none', logLevel: 'warning',
  });
  for (const name of RUNTIME_DATA_FILES) copyFileSync(join(ROOT, 'public', 'data', name), join(outDir, 'data', name));
  // The snapshot Ask the Twin builds its store from at startup (server/ask/twinStore.mjs).
  mkdirSync(join(outDir, 'data', SNAPSHOT_SUBDIR), { recursive: true });
  for (const { file } of SNAPSHOT_CLASSES) copyFileSync(join(ROOT, 'public', SNAPSHOT_SUBDIR, file), join(outDir, 'data', SNAPSHOT_SUBDIR, file));
  // The data dictionary Ask the Twin reasons with, built from the code's own config and these layers.
  const dictionary = buildDataDictionary({ readLayer: name => JSON.parse(readFileSync(join(outDir, 'data', name), 'utf8')) });
  writeFileSync(join(outDir, 'data', DICTIONARY_FILE), `${JSON.stringify(dictionary, null, 2)}\n`);
  for (const name of OPS_FILES) cpSync(join(EC2_DIR, name), join(outDir, name));
  if (web === 'build') await buildLiveDcWeb({ outDir: join(outDir, 'web'), envFiles, logger });
  else if (web) cpSync(web.from, join(outDir, 'web'), { recursive: true });
  // After the I-595 web build, which empties web/.
  if (portmiami) await buildPortMiami({ outDir, web: Boolean(web), envFiles, logger });
  const bytes = statSync(outfile).size;
  logger.log?.(`live-dc bundle: ${outfile} (${Math.round(bytes / 1024)} KiB) + ${RUNTIME_DATA_FILES.length} data files + ${DICTIONARY_FILE} + ${SNAPSHOT_CLASSES.length} snapshot files`
    + `${web ? ' + web/' : ' (no web/)'}${portmiami ? ' + portmiami/' : ''} + ops files`);
  return { outfile, bytes, dataFiles: [...RUNTIME_DATA_FILES, DICTIONARY_FILE], web: Boolean(web), portmiami: Boolean(portmiami) };
}

export function parseBundleArgs(argv) {
  const value = flag => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? resolve(argv[i + 1]) : null; };
  const webFrom = value('--web-from');
  return {
    outDir: value('--out') ?? DEFAULT_OUT_DIR,
    web: argv.includes('--skip-web') ? false : webFrom ? { from: webFrom } : 'build',
    envFiles: !argv.includes('--no-env-files'),
    portmiami: !argv.includes('--skip-portmiami'),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const task = argv[0] === '--web-child' ? runWebChild(argv[1], argv[2])
    : argv[0] === '--portmiami-web-child' ? runPortMiamiWebChild(argv[1], argv[2])
      : buildLiveDcBundle(parseBundleArgs(argv));
  task.catch(error => {
    console.error(`build-live-dc-bundle: ${error.message}`);
    process.exitCode = 1;
  });
}
