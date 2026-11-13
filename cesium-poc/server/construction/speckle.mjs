/**
 * The Speckle BIM connector: find the latest version, and convert it when it is new.
 *
 * READ-ONLY against Speckle. It issues one GraphQL POST to ask what the latest version is, and
 * otherwise delegates every byte of retrieval and decoding to the Phase 9A Python tooling, which
 * is the only code that understands parquet bundles. Nothing here writes to Speckle, and the
 * token never leaves this process.
 *
 * Why the conversion is a child process and not JavaScript: the bundle is parquet, and
 * `operations.receive3` is the supported reader. There is no Node equivalent. So the division is
 * deliberate — Node owns scheduling, caching, HTTP and the database; Python owns geometry.
 *
 * The two things this file is careful about:
 *
 *  - THE CHILD IS SPAWNED WITHOUT A SHELL, with an argument array, an interpreter path resolved
 *    from module constants, and a version id validated against `/^[A-Za-z0-9_-]{1,64}$/`. No
 *    request value reaches a command line, a path join or an environment variable.
 *  - CONVERSION IS EXPENSIVE AND VERSIONS ARE IMMUTABLE. An unchanged version is never converted
 *    twice; the common cycle is one small GraphQL query and nothing else.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { redacted, scrub, upstreamReason } from './httpCore.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '../..');

/** Everything about WHICH Speckle, as module constants. Not reachable from a request. */
export const SPECKLE = Object.freeze({
  system: 'SPECKLE',
  label: 'Speckle Cloud',
  kind: 'LIVE',
  protocol: 'Speckle API v3 (GraphQL) + specklepy bundle receive over HTTPS, Bearer token',
  scope: 'Read-only. No mutation is issued against Speckle in this phase.',
  /** Said next to every figure, because a real model beside synthetic ones invites a merge. */
  notSynthetic: 'This is the real Speckle BIM model. The demo\'s synthetic BIM elements, P6 '
    + 'activities and SYNCHRO records are unchanged and are shown separately.',
  noAutoMap: 'Nothing here maps a BIM element to a schedule activity. That is Phase 9C and it '
    + 'requires an explicit approval.',
});

export const ALLOWED_HOSTS = Object.freeze(['app.speckle.systems', 'speckle.xyz']);
export const DEFAULT_SERVER_URL = 'https://app.speckle.systems';
export const DEFAULT_PROJECT_ID = '13347d8410';
export const DEFAULT_MODEL_ID = 'd1fdafff76';

/** The interpreter and the script, both module constants. Never built from a request. */
export const PYTHON = resolve(REPO_ROOT, 'tools/speckle/.venv/bin/python');
export const CONVERTER = resolve(REPO_ROOT, 'tools/speckle/convert_speckle.py');
export const ARTIFACT_ROOT = resolve(REPO_ROOT, '.data/speckle');

/**
 * Where the building stands, and which way it faces.
 *
 * THE GEOGRAPHY IS NOT IN THE GEOMETRY. The GLB holds the model's own metres, exactly as IFC
 * produced them; this anchor is applied once, at render time, as a Cesium model matrix. Baking a
 * longitude into the vertices would make the artifact wrong for every other site and would have
 * to be undone before it could be moved.
 *
 * The default sits on the same synthetic site as the existing Tower A viewer, so the real model
 * and the demo's synthetic one are in the same place rather than two unrelated points on a globe.
 * Every field is overridable from the server environment.
 */
export const DEFAULT_PLACEMENT = Object.freeze({
  longitude: 72.8777, latitude: 19.076, height: 0,
  heading: 0, pitch: 0, roll: 0,
});

export function readPlacement(env = process.env) {
  const number = (key, fallback) => {
    const value = Number(env[key]);
    // `Number('')` is 0 and finite, so an unset variable must not silently become zero.
    return env[key] != null && String(env[key]).trim() !== '' && Number.isFinite(value)
      ? value : fallback;
  };
  return {
    longitude: number('SPECKLE_ANCHOR_LONGITUDE', DEFAULT_PLACEMENT.longitude),
    latitude: number('SPECKLE_ANCHOR_LATITUDE', DEFAULT_PLACEMENT.latitude),
    height: number('SPECKLE_ANCHOR_HEIGHT', DEFAULT_PLACEMENT.height),
    heading: number('SPECKLE_ANCHOR_HEADING', DEFAULT_PLACEMENT.heading),
    pitch: number('SPECKLE_ANCHOR_PITCH', DEFAULT_PLACEMENT.pitch),
    roll: number('SPECKLE_ANCHOR_ROLL', DEFAULT_PLACEMENT.roll),
    note: 'Applied once, as a Cesium model matrix at render time. The GLB itself is in the '
      + "model's own metres and carries no geographic coordinate.",
  };
}

export const STATE = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  CONNECTED: 'CONNECTED',
  AUTH_FAILED: 'AUTH_FAILED',
  CONNECTION_FAILED: 'CONNECTION_FAILED',
  DATA_INVALID: 'DATA_INVALID',
  TOOLING_MISSING: 'TOOLING_MISSING',
  NOT_READ: 'NOT_READ',
});

export const RUN_STATUS = Object.freeze({
  CONVERTED: 'CONVERTED',
  /** The common case: the published version is the one already cached. No conversion runs. */
  UNCHANGED: 'UNCHANGED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
});

export const TRIGGER = Object.freeze({
  STARTUP: 'STARTUP', SCHEDULED: 'SCHEDULED', MANUAL: 'MANUAL',
});

export const LIMITS = Object.freeze({
  graphqlTimeoutMs: 20_000,
  /** A bundle download plus a full decode. Generous, and bounded. */
  convertTimeoutMs: 180_000,
  /** The converter prints one JSON object; anything larger is a runaway. */
  maxStdoutBytes: 8_000_000,
});

/**
 * A version id, validated.
 *
 * It is interpolated into a filesystem path and passed as a child-process argument, so anything
 * that is not a plain id is refused here rather than sanitised and used. `..` and `/` are exactly
 * how an id becomes a path traversal.
 */
export const parseVersionId = value => {
  const text = String(value ?? '').trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(text) ? text : null;
};

/** Page size for the version history walk, and a bound on the walk itself. */
export const HISTORY_PAGE = 100;
export const HISTORY_MAX_PAGES = 20;

/** The version-history query. A module constant; no request data is interpolated into it. */
const VERSION_HISTORY_QUERY = `query($projectId: String!, $modelId: String!, $limit: Int!, $cursor: String) {
  project(id: $projectId) {
    id name
    model(id: $modelId) {
      id name
      versions(limit: $limit, cursor: $cursor) {
        totalCount
        cursor
        items { id createdAt message sourceApplication referencedObject }
      }
    }
  }
}`;

/** The GraphQL query. A module constant; no request data is ever interpolated into it. */
const LATEST_VERSION_QUERY = `query($projectId: String!, $modelId: String!) {
  project(id: $projectId) {
    id name
    model(id: $modelId) {
      id name
      versions(limit: 1) {
        totalCount
        items { id createdAt referencedObject sourceApplication message }
      }
    }
  }
}`;

export function createSpeckleAdapter({
  env = process.env, fetchImpl = globalThis.fetch, logger = console,
  spawnImpl = spawn, artifactRoot = ARTIFACT_ROOT, python = PYTHON, converter = CONVERTER,
} = {}) {
  const tokenOf = () => String(env.SPECKLE_API_TOKEN ?? '').trim();
  const serverUrl = () => String(env.SPECKLE_SERVER_URL ?? DEFAULT_SERVER_URL).replace(/\/+$/, '');
  const projectId = () => String(env.SPECKLE_PROJECT_ID ?? DEFAULT_PROJECT_ID).trim();
  const modelId = () => String(env.SPECKLE_MODEL_ID ?? DEFAULT_MODEL_ID).trim();
  const pinnedVersion = () => parseVersionId(env.SPECKLE_VERSION_ID ?? '');

  /** The host is allowlisted: a credential must not be sent wherever an env var points. */
  function checkedServer() {
    let url;
    try { url = new URL(serverUrl()); } catch { return { ok: false, error: `SPECKLE_SERVER_URL is not a URL.` }; }
    if (url.protocol !== 'https:') return { ok: false, error: 'SPECKLE_SERVER_URL must be https.' };
    if (!ALLOWED_HOSTS.includes(url.hostname)) {
      return { ok: false,
        error: `${url.hostname} is not an allowed Speckle host (${ALLOWED_HOSTS.join(', ')}).` };
    }
    return { ok: true, baseUrl: `${url.protocol}//${url.host}` };
  }

  const envelope = () => ({
    source: SPECKLE,
    server: checkedServer().ok ? checkedServer().baseUrl : null,
    projectId: projectId(),
    modelId: modelId(),
    requestedAt: new Date().toISOString(),
    /** Not one of the five pilot interfaces, and must never be filed as one. */
    interfaceId: null,
  });

  /**
   * EVERY published version, oldest first, paginated.
   *
   * A timeline built from the first page alone would silently begin partway through the build, so
   * the cursor is followed to the end. The V1..Vn labels are DERIVED here from chronological
   * order — Speckle has no such concept, and an invented label that disagreed with `createdAt`
   * would be worse than none.
   */
  async function versionHistory({ pageSize = HISTORY_PAGE, maxPages = HISTORY_MAX_PAGES } = {}) {
    const token = tokenOf();
    if (!token) {
      return { ...envelope(), state: STATE.NOT_CONFIGURED, versions: [],
        reason: 'SPECKLE_API_TOKEN is not set on the server.' };
    }
    const items = [];
    let cursor = null;
    let total = null;
    let projectName = null;
    let modelName = null;
    let pages = 0;
    let truncated = false;

    for (;;) {
      const page = await post(VERSION_HISTORY_QUERY, { projectId: projectId(), modelId: modelId(),
        limit: pageSize, cursor });
      if (page.state !== STATE.CONNECTED) {
        // A FIRST page that fails is a failure; a later one leaves us holding real versions that
        // are genuinely incomplete, which must not be presented as the whole history.
        if (pages === 0) return { ...page, versions: [] };
        truncated = true;
        break;
      }
      const project = page.body?.data?.project;
      const model = project?.model;
      if (!project || !model) {
        return { ...envelope(), state: STATE.DATA_INVALID, versions: [],
          reason: !project ? `No project ${projectId()} is visible to this token.`
            : `Project ${projectId()} has no model ${modelId()}.` };
      }
      projectName = project.name;
      modelName = model.name;
      const block = model.versions ?? {};
      total = block.totalCount ?? total;
      const batch = block.items ?? [];
      items.push(...batch);
      pages += 1;
      cursor = block.cursor ?? null;
      if (!cursor || !batch.length) break;
      if (pages >= maxPages) { truncated = true; break; }
    }

    const ordered = [...items].sort((a, b) => {
      const left = String(a?.createdAt ?? '');
      const right = String(b?.createdAt ?? '');
      // `createdAt` is the authority; the id breaks a tie so the order is stable for two versions
      // published in the same millisecond.
      return left === right ? String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
        : left.localeCompare(right);
    }).map((entry, index) => ({
      versionId: entry.id,
      createdAt: entry.createdAt,
      // Versions with no message are the normal case for this model; absent is reported as absent.
      message: entry.message ?? null,
      sourceApplication: entry.sourceApplication ?? null,
      referencedObject: entry.referencedObject ?? null,
      ordinal: index + 1,
      label: `V${index + 1}`,
    }));

    return {
      ...envelope(), state: STATE.CONNECTED, reason: null,
      projectName, modelName,
      versionCount: total,
      returned: ordered.length,
      pages,
      truncated: truncated || (total != null && ordered.length < total),
      versions: ordered,
      latestVersionId: ordered.length ? ordered[ordered.length - 1].versionId : null,
      pinnedVersionId: pinnedVersion(),
    };
  }

  /**
   * One hardened POST to /graphql, shared by both queries.
   *
   * Extracted so the history walk cannot drift from the latest-version call on any of the things
   * that matter: the allowlisted host, the Bearer header, the timeout, `redirect: 'error'`, the
   * token scrub over every upstream message, and the GraphQL `errors` array that arrives with
   * HTTP 200.
   */
  async function post(query, variables) {
    const token = tokenOf();
    if (!token) {
      return { ...envelope(), state: STATE.NOT_CONFIGURED, body: null,
        reason: 'SPECKLE_API_TOKEN is not set on the server. Add it to cesium-poc/.env.local and '
          + 'restart — the browser never sees it.' };
    }
    const server = checkedServer();
    if (!server.ok) {
      return { ...envelope(), state: STATE.CONNECTION_FAILED, body: null, reason: server.error };
    }

    const started = Date.now();
    let response;
    try {
      response = await fetchImpl(`${server.baseUrl}/graphql`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          // The CDN in front of app.speckle.systems answers a default agent with HTTP 403
          // "error code: 1010" — a browser-integrity rejection that reads exactly like an auth
          // failure and is not one.
          'user-agent': 'acs-demo-speckle/1.0',
        },
        body: JSON.stringify({ query, variables }),
        redirect: 'error',
        signal: AbortSignal.timeout(LIMITS.graphqlTimeoutMs),
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      return { ...envelope(), state: STATE.CONNECTION_FAILED, body: null,
        elapsedMs: Date.now() - started,
        reason: timedOut ? `Speckle did not answer within ${LIMITS.graphqlTimeoutMs} ms.`
          : `Speckle could not be reached: `
            + `${scrub(String(error?.message ?? error), token).slice(0, 200)}` };
    }

    const text = await response.text().catch(() => '');
    const elapsedMs = Date.now() - started;
    if (!response.ok) {
      const reason = scrub(upstreamReason(text) ?? text.slice(0, 200), token);
      const auth = response.status === 401 || response.status === 403;
      logger.warn?.(`[speckle] HTTP ${response.status}: ${reason ?? 'no reason given'}`);
      return { ...envelope(), state: auth ? STATE.AUTH_FAILED : STATE.CONNECTION_FAILED,
        httpStatus: response.status, elapsedMs, body: null,
        reason: auth
          ? `Speckle rejected the API token (HTTP ${response.status}: ${reason}). Check `
            + 'SPECKLE_API_TOKEN on the server.'
          : `Speckle answered HTTP ${response.status}: ${reason}.` };
    }

    let payload;
    try { payload = JSON.parse(text); } catch {
      return { ...envelope(), state: STATE.DATA_INVALID, elapsedMs, body: null,
        reason: 'Speckle answered 200 with a body that is not JSON.' };
    }
    if (!redacted(payload, token)) {
      logger.error?.('[speckle] response contained the API token; withheld');
      return { ...envelope(), state: STATE.DATA_INVALID, elapsedMs, body: null,
        reason: 'The response echoed the API token, so it was discarded rather than returned.' };
    }
    if (payload.errors?.length) {
      const first = payload.errors[0];
      const code = first?.extensions?.code ?? 'GRAPHQL_ERROR';
      const auth = code === 'UNAUTHORIZED' || code === 'FORBIDDEN';
      return { ...envelope(), state: auth ? STATE.AUTH_FAILED : STATE.DATA_INVALID, elapsedMs,
        body: null, reason: `${code}: ${scrub(first?.message ?? 'no message', token)}` };
    }
    return { ...envelope(), state: STATE.CONNECTED, httpStatus: response.status, elapsedMs,
      reason: null, body: payload };
  }

  /**
   * Ask Speckle what the latest published version is.
   *
   * One small query, which is what makes a 60-second poll cheap: the expensive work only happens
   * when this comes back with an id we have not converted.
   */
  async function latestVersion() {
    const token = tokenOf();
    if (!token) {
      return { ...envelope(), state: STATE.NOT_CONFIGURED, version: null,
        reason: 'SPECKLE_API_TOKEN is not set on the server. Add it to cesium-poc/.env.local and '
          + 'restart — the browser never sees it.' };
    }
    const server = checkedServer();
    if (!server.ok) {
      return { ...envelope(), state: STATE.CONNECTION_FAILED, version: null, reason: server.error };
    }

    const started = Date.now();
    let response;
    try {
      response = await fetchImpl(`${server.baseUrl}/graphql`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          // The CDN in front of app.speckle.systems answers a default agent with HTTP 403
          // "error code: 1010" — a browser-integrity rejection that reads exactly like an auth
          // failure and is not one.
          'user-agent': 'acs-demo-speckle/1.0',
        },
        body: JSON.stringify({ query: LATEST_VERSION_QUERY,
          variables: { projectId: projectId(), modelId: modelId() } }),
        redirect: 'error',
        signal: AbortSignal.timeout(LIMITS.graphqlTimeoutMs),
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      return { ...envelope(), state: STATE.CONNECTION_FAILED, version: null,
        elapsedMs: Date.now() - started,
        reason: timedOut ? `Speckle did not answer within ${LIMITS.graphqlTimeoutMs} ms.`
          : `Speckle could not be reached: ${scrub(String(error?.message ?? error), token).slice(0, 200)}` };
    }

    const text = await response.text().catch(() => '');
    const elapsedMs = Date.now() - started;
    if (!response.ok) {
      // Scrubbed before it is logged OR returned: an upstream that echoes the credential in its
      // error body must not get it into our logs or into the browser.
      const reason = scrub(upstreamReason(text) ?? text.slice(0, 200), token);
      const auth = response.status === 401 || response.status === 403;
      logger.warn?.(`[speckle] HTTP ${response.status}: ${reason ?? 'no reason given'}`);
      return { ...envelope(), state: auth ? STATE.AUTH_FAILED : STATE.CONNECTION_FAILED,
        httpStatus: response.status, elapsedMs, version: null,
        reason: auth
          ? `Speckle rejected the API token (HTTP ${response.status}: ${reason}). Check `
            + 'SPECKLE_API_TOKEN on the server.'
          : `Speckle answered HTTP ${response.status}: ${reason}.` };
    }

    let payload;
    try { payload = JSON.parse(text); } catch {
      return { ...envelope(), state: STATE.DATA_INVALID, elapsedMs, version: null,
        reason: 'Speckle answered 200 with a body that is not JSON.' };
    }
    if (!redacted(payload, token)) {
      logger.error?.('[speckle] response contained the API token; withheld');
      return { ...envelope(), state: STATE.DATA_INVALID, elapsedMs, version: null,
        reason: 'The response echoed the API token, so it was discarded rather than returned.' };
    }
    if (payload.errors?.length) {
      // GraphQL answers HTTP 200 with an `errors` array, so a status check alone would read a
      // permission refusal as a success with empty data.
      const first = payload.errors[0];
      const code = first?.extensions?.code ?? 'GRAPHQL_ERROR';
      const auth = code === 'UNAUTHORIZED' || code === 'FORBIDDEN';
      return { ...envelope(), state: auth ? STATE.AUTH_FAILED : STATE.DATA_INVALID, elapsedMs,
        version: null, reason: `${code}: ${scrub(first?.message ?? 'no message', token)}` };
    }

    const project = payload.data?.project;
    const model = project?.model;
    const item = model?.versions?.items?.[0];
    if (!project || !model || !item) {
      return { ...envelope(), state: STATE.DATA_INVALID, elapsedMs, version: null,
        reason: !project ? `No project ${projectId()} is visible to this token.`
          : !model ? `Project ${projectId()} has no model ${modelId()}.`
            : `Model ${modelId()} has no published versions.` };
    }

    return {
      ...envelope(), state: STATE.CONNECTED, elapsedMs, httpStatus: response.status, reason: null,
      projectName: project.name,
      modelName: model.name,
      versionCount: model.versions?.totalCount ?? null,
      version: {
        versionId: item.id,
        createdAt: item.createdAt,
        referencedObject: item.referencedObject,
        sourceApplication: item.sourceApplication,
        message: item.message,
      },
      /**
       * A PIN, when one is configured.
       *
       * `SPECKLE_VERSION_ID` pins the demo to a known version so a publish upstream cannot change
       * what a presentation shows. When it is set, that is the version converted and the latest
       * is still reported, so the screen can say the two differ.
       */
      pinnedVersionId: pinnedVersion(),
      targetVersionId: pinnedVersion() ?? item.id,
    };
  }

  /**
   * Run the Python converter for one version.
   *
   * The artifacts land in a TEMPORARY directory and are renamed into place only after the child
   * exits 0 with a manifest. A half-written model directory that a server then serves is the
   * failure mode this avoids — and the rename is what makes publication atomic enough that a
   * reader either sees the old version or the new one.
   */
  async function convert(rawVersionId, { timeoutMs = LIMITS.convertTimeoutMs } = {}) {
    const versionId = parseVersionId(rawVersionId);
    if (!versionId) {
      return { ok: false, errorClass: 'CONFIGURATION',
        error: 'A Speckle version id must be 1-64 characters of [A-Za-z0-9_-].' };
    }
    if (!tokenOf()) {
      return { ok: false, errorClass: 'CONFIGURATION',
        error: 'SPECKLE_API_TOKEN is not set on the server, so nothing was downloaded.' };
    }
    if (!existsSync(python) || !existsSync(converter)) {
      return { ok: false, errorClass: 'TOOLING_MISSING',
        error: `The Speckle converter is not installed. Expected ${python} and ${converter}. `
          + 'Create the venv: python3 -m venv tools/speckle/.venv && '
          + 'tools/speckle/.venv/bin/python -m pip install -r tools/speckle/requirements.txt' };
    }

    mkdirSync(artifactRoot, { recursive: true });
    const finalDir = join(artifactRoot, versionId);
    const stagingDir = join(artifactRoot, `.tmp-${versionId}-${process.pid}-${Date.now()}`);

    const started = Date.now();
    const result = await runChild(stagingDir, versionId, timeoutMs);
    const elapsedMs = Date.now() - started;

    if (!result.ok) {
      try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* nothing to clean */ }
      return { ...result, elapsedMs, versionId };
    }

    try {
      // Replace atomically enough: remove the old directory, then rename the staging one in. A
      // rename on the same filesystem is atomic; the window is the rm, and the database row is
      // what decides which version is ACTIVE, so a reader never follows a half-built directory.
      if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true });
      renameSync(stagingDir, finalDir);
    } catch (error) {
      try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
      return { ok: false, errorClass: 'OTHER', elapsedMs, versionId,
        error: `The converted model could not be published: ${error?.message ?? error}` };
    }

    return { ok: true, versionId, elapsedMs, artifactDir: finalDir, manifest: result.manifest };
  }

  /** Spawn the child, with no shell and an argument array. */
  function runChild(outDir, versionId, timeoutMs) {
    return new Promise(resolvePromise => {
      let child;
      try {
        child = spawnImpl(python, [converter, '--out', outDir, '--version', versionId, '--quiet'], {
          cwd: REPO_ROOT,
          // NO SHELL. The arguments are an array, so nothing is word-split or interpreted, and a
          // version id that somehow got past validation still could not become a command.
          shell: false,
          env: {
            ...process.env,
            // Passed through the ENVIRONMENT, never on the command line, where it would be
            // visible to any process that can read /proc or run `ps`.
            SPECKLE_API_TOKEN: tokenOf(),
            SPECKLE_SERVER_URL: serverUrl(),
            SPECKLE_PROJECT_ID: projectId(),
            SPECKLE_MODEL_ID: modelId(),
            SPECKLE_VERSION_ID: versionId,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolvePromise({ ok: false, errorClass: 'TOOLING_MISSING',
          error: `Could not start the converter: ${error?.message ?? error}` });
        return;
      }

      let out = '';
      let err = '';
      let settled = false;
      const finish = value => { if (!settled) { settled = true; resolvePromise(value); } };

      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        finish({ ok: false, errorClass: 'TIMEOUT',
          error: `The conversion did not finish within ${timeoutMs} ms and was stopped.` });
      }, timeoutMs);
      timer.unref?.();

      child.stdout.on('data', chunk => {
        out += chunk;
        if (out.length > LIMITS.maxStdoutBytes) {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          finish({ ok: false, errorClass: 'OTHER',
            error: 'The converter produced more output than expected and was stopped.' });
        }
      });
      child.stderr.on('data', chunk => { err = (err + chunk).slice(-4000); });

      child.on('error', error => {
        clearTimeout(timer);
        finish({ ok: false, errorClass: 'TOOLING_MISSING',
          error: `The converter could not be run: ${error?.message ?? error}` });
      });

      child.on('close', code => {
        clearTimeout(timer);
        const token = tokenOf();
        let payload = null;
        // The converter prints ONE JSON object. Taking the last `{`-led line rather than parsing
        // everything means a stray warning on stdout cannot break the contract.
        const line = out.trim().split('\n').reverse().find(entry => entry.trim().startsWith('{'));
        if (line) { try { payload = JSON.parse(line); } catch { payload = null; } }

        if (code === 0 && payload?.ok && payload.manifest) {
          finish({ ok: true, manifest: payload.manifest });
          return;
        }
        if (payload && payload.ok === false) {
          finish({ ok: false, errorClass: payload.errorClass ?? 'OTHER',
            error: scrub(String(payload.error ?? 'The converter reported a failure.'), token) });
          return;
        }
        finish({ ok: false, errorClass: 'OTHER',
          error: scrub(`The converter exited ${code} without a usable result. `
            + `${err.trim().slice(-400) || 'No error output.'}`, token) });
      });
    });
  }

  return {
    latestVersion,
    versionHistory,
    convert,
    configured: () => Boolean(tokenOf()),
    toolingInstalled: () => existsSync(python) && existsSync(converter),
    server: () => checkedServer(),
    projectId,
    modelId,
    pinnedVersion,
    artifactRoot: () => artifactRoot,
    /** For the token-leak assertions in the tests, without exposing the token itself. */
    redactedFor: payload => redacted(payload, tokenOf()),
  };
}
