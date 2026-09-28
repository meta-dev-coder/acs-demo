#!/usr/bin/env node
/**
 * Creates one SDNA class in DataConnect from its committed create request: POST /class with the
 * `create` body, then POST /class/{newId} with the ClassUpdate that adds the attributes. A dry run
 * unless --apply.
 *
 *   node tools/live-dc-create-class.mjs "SDNA Florida I595 Historical Chain" [--apply]
 *
 * Refuses a name that does not start with "SDNA ", a class with no committed create request, a
 * request that still holds an "<id of …>" placeholder, and a class that already exists.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServerEnv } from '../server/loadEnv.mjs';

export const DC_DATA_MGMT_URL = 'https://dc-data-mgmt-demo-dqa3.cohesivecloud.app/api/v1';
const ARTIFACTS = ['historical-chain.create-request.json', 'live-classes.create-requests.json']
  .map((name) => fileURLToPath(new URL(`../config/liveDc/${name}`, import.meta.url)));
const TIMEOUT_MS = 20_000;
const USAGE = 'usage: live-dc-create-class.mjs "<SDNA class name>" [--apply]';

class Refusal extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function parseArgs(argv) {
  const args = { apply: false, className: null };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg.startsWith('--')) throw new Refusal(`unknown argument '${arg}' (${USAGE})`, 2);
    else if (args.className === null) args.className = arg;
    else throw new Refusal(`only one class name is allowed (${USAGE})`, 2);
  }
  if (!args.className) throw new Refusal(USAGE, 2);
  return args;
}

const defaultReadRequests = () => ARTIFACTS.flatMap((file) => JSON.parse(readFileSync(file, 'utf8')));

function requestFor(className, requests) {
  if (!className.startsWith('SDNA ')) throw new Refusal(`refusing: '${className}' is not an SDNA class`, 2);
  const matches = requests.filter((r) => r?.className === className);
  if (matches.length !== 1) throw new Refusal(`refusing: no committed create request for '${className}'`, 2);
  const [request] = matches;
  if (request.create?.className !== className || request.update?.className !== className) {
    throw new Refusal(`refusing: the create request for '${className}' names another class`, 2);
  }
  if ((request.update.modify ?? []).length || (request.update.remove ?? []).length) {
    throw new Refusal('refusing: only additive updates (modify/remove must be empty)', 2);
  }
  if (JSON.stringify(request).includes('<id of ')) {
    throw new Refusal(`refusing: the create request for '${className}' still holds an '<id of …>' placeholder; create it by hand`, 2);
  }
  return request;
}

async function request(fetchImpl, url, token, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      ...init, redirect: 'manual', signal: controller.signal,
      headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    });
    const text = await response.text();
    if (response.status < 200 || response.status >= 300) {
      throw new Refusal(`DataConnect ${init.method ?? 'GET'} ${new URL(url).pathname} returned ${response.status}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

/** @returns {Promise<number>} exit code */
export async function runCreateClass({
  argv = [], env = process.env, fetchImpl = fetch, log = console.log, error = console.error,
  readRequests = defaultReadRequests,
  readToken = (file) => readFileSync(file, 'utf8').trim(),
} = {}) {
  try {
    const args = parseArgs(argv);
    const req = requestFor(args.className, readRequests());
    let token = '';
    if (env.DC_WRITER_ACCESS_TOKEN_FILE) {
      try { token = readToken(env.DC_WRITER_ACCESS_TOKEN_FILE); } catch { /* reported below, without the file's contents */ }
    }
    if (!token && args.apply) throw new Refusal('DC_WRITER_ACCESS_TOKEN_FILE is unset, missing or empty (run npm run dc:login)', 2);

    if (token) {
      const listed = await request(fetchImpl, `${DC_DATA_MGMT_URL}/class`, token);
      const classes = Array.isArray(listed) ? listed : listed?.data ?? listed?.classes ?? [];
      if (classes.some((c) => c?.className === args.className)) throw new Refusal(`refusing: class '${args.className}' already exists`);
      log(`class '${args.className}' does not exist yet`);
    } else {
      log(`class '${args.className}': existence not checked (no token)`);
    }
    log(`1. POST ${DC_DATA_MGMT_URL}/class  (create '${args.className}')`);
    log(`2. POST ${DC_DATA_MGMT_URL}/class/<new id>  (add ${req.update.add.length} attributes):`);
    for (const a of req.update.add) log(`  + ${a.name} (${a.type})`);
    if (!args.apply) {
      log('dry run: nothing sent. Re-run with --apply to create the class.');
      return 0;
    }
    const created = await request(fetchImpl, `${DC_DATA_MGMT_URL}/class`, token, { method: 'POST', body: JSON.stringify(req.create) });
    const id = String(created?.id ?? created?.data?.id ?? '');
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Refusal('the create call returned no usable class id; add the attributes by hand');
    log(`created '${args.className}' id ${id}`);
    const url = `${DC_DATA_MGMT_URL}/class/${encodeURIComponent(id)}`;
    await request(fetchImpl, url, token, { method: 'POST', body: JSON.stringify(req.update) });
    log(`applied: POST ${url} (${req.update.add.length} attributes)`);
    return 0;
  } catch (failure) {
    error(`live-dc-create-class: ${failure.message}`);
    return failure instanceof Refusal ? failure.exitCode : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadServerEnv();
  runCreateClass({ argv: process.argv.slice(2) }).then((code) => { process.exitCode = code; });
}
