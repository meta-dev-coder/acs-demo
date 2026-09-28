#!/usr/bin/env node
/**
 * Ensures the existing "SDNA Florida I595 Live Events" class in DataConnect has every attribute
 * declared in config/liveDc/liveClasses.json: adds the declared attributes the class lacks, so it can
 * be re-run safely. Additive only, and a dry run unless --apply.
 *
 *   node tools/live-dc-apply-update.mjs [--apply]     (DC_WRITER_ACCESS_TOKEN_FILE from the env or .env.local)
 *
 * Refuses any other class, any modify/remove, and a missing or ambiguous class. The rest of the
 * ClassUpdate (description, owners, ...) is the class's own current value.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServerEnv } from '../server/loadEnv.mjs';
import { LIVE_CLASS, buildClassUpdateRequest } from '../server/liveDc/classes.mjs';
import { fetchWithTimeout } from '../server/liveDc/timeouts.mjs';

export const TARGET_CLASS = 'SDNA Florida I595 Live Events';
export const DC_DATA_MGMT_URL = 'https://dc-data-mgmt-demo-dqa3.cohesivecloud.app/api/v1';
const KEPT_CLASS_FIELDS = Object.freeze(['description', 'owners', 'displayInExplorer', 'includeSecuritySettings', 'geometryAttributeName']);
const TIMEOUT_MS = 20_000;

class Refusal extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function parseArgs(argv) {
  const args = { apply: false };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else throw new Refusal(`unknown argument '${arg}' (usage: live-dc-apply-update.mjs [--apply])`, 2);
  }
  return args;
}

function checkArtifact(artifact) {
  if (artifact?.className !== TARGET_CLASS) {
    throw new Refusal(`refusing: the update targets '${artifact?.className}', only '${TARGET_CLASS}' is allowed`, 2);
  }
  if ((artifact.modify ?? []).length || (artifact.remove ?? []).length) throw new Refusal('refusing: only additive updates (modify/remove must be empty)', 2);
  if (!Array.isArray(artifact.ensure) || artifact.ensure.length === 0) throw new Refusal('refusing: no attributes declared', 2);
  if (artifact.ensure.some(a => a.mandatory !== false || a.core)) throw new Refusal('refusing: added attributes must be optional and not core', 2);
}

function request(fetchImpl, url, token, init = {}) {
  return fetchWithTimeout(fetchImpl, url, {
    ...init, redirect: 'manual',
    headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
  }, TIMEOUT_MS, async response => {
    const text = await response.text();
    if (response.status < 200 || response.status >= 300) {
      throw new Refusal(`DataConnect ${init.method ?? 'GET'} ${new URL(url).pathname} returned ${response.status}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  });
}

/** @returns {Promise<number>} exit code */
export async function runApplyUpdate({
  argv = [], env = process.env, fetchImpl = fetch, log = console.log, error = console.error,
  readArtifact = () => buildClassUpdateRequest(LIVE_CLASS.EVENTS),
  readToken = file => readFileSync(file, 'utf8').trim(),
} = {}) {
  try {
    const args = parseArgs(argv);
    const artifact = readArtifact();
    checkArtifact(artifact);
    const tokenFile = env.DC_WRITER_ACCESS_TOKEN_FILE;
    if (!tokenFile) throw new Refusal('DC_WRITER_ACCESS_TOKEN_FILE is not set', 2);
    let token = '';
    try { token = readToken(tokenFile); } catch { /* reported below, without the file's contents */ }
    if (!token) throw new Refusal('the access token file is missing or empty (run npm run dc:login)', 2);

    const listed = await request(fetchImpl, `${DC_DATA_MGMT_URL}/class`, token);
    const classes = Array.isArray(listed) ? listed : listed?.data ?? listed?.classes ?? [];
    const matches = classes.filter(c => c?.className === TARGET_CLASS);
    if (matches.length !== 1) throw new Refusal(`refusing: expected exactly one class named '${TARGET_CLASS}', found ${matches.length}`);
    const dto = matches[0];
    if (!/^[A-Za-z0-9_-]+$/.test(String(dto.id ?? ''))) throw new Refusal('refusing: the class has no usable id');
    const existing = new Set((dto.attributes ?? []).map(a => a?.name));
    const add = artifact.ensure.filter(a => !existing.has(a.name));
    if (add.length === 0) {
      log(`class '${TARGET_CLASS}' id ${dto.id} is up to date: all ${artifact.ensure.length} declared attributes exist; nothing to add`);
      return 0;
    }

    const body = { className: TARGET_CLASS };
    for (const key of KEPT_CLASS_FIELDS) if (dto[key] !== undefined) body[key] = dto[key];
    Object.assign(body, { add, modify: [], remove: [] });
    const url = `${DC_DATA_MGMT_URL}/class/${encodeURIComponent(dto.id)}`;
    log(`class '${TARGET_CLASS}' id ${dto.id} (${existing.size} attributes); adding ${add.length}:`);
    for (const a of add) log(`  + ${a.name} (${a.type})`);
    if (!args.apply) {
      log(`dry run: nothing sent. Re-run with --apply to POST ${url}`);
      return 0;
    }
    await request(fetchImpl, url, token, { method: 'POST', body: JSON.stringify(body) });
    log(`applied: POST ${url}`);
    return 0;
  } catch (failure) {
    error(`live-dc-apply-update: ${failure.message}`);
    return failure instanceof Refusal ? failure.exitCode : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadServerEnv();
  runApplyUpdate({ argv: process.argv.slice(2) }).then(code => { process.exitCode = code; });
}
