/**
 * /api/aps/*: the Autodesk Platform Services sign-in and the Forma (ACC) project lookup for the
 * Seagirt Electrical Digital Twin.
 *
 * Same factory shape as the other same-origin APIs: `createApsApi()` returns `{handle, middleware}`.
 * vite.config.js mounts it in the dev server, so http://localhost:5188/api/aps/* is answered by this
 * process directly (no proxy hop), and `npm run api` (server/index.mjs) mounts the same handler.
 *
 *   GET /api/aps/login      302 to Autodesk with PKCE (S256) and a single-use state
 *   GET /api/aps/callback   validates the state, exchanges the code, stores the tokens server-side
 *   GET /api/aps/status     configuration and sign-in state; ?test=1 also checks the credentials
 *   GET /api/aps/hubs       accessible hubs, the one holding the target project marked
 *   GET /api/aps/projects   projects of ?hubId= (all hubs when omitted), ?name= filters
 *   GET /api/aps/files      the target project's folders and the IFC items, versions and derivatives
 *                           (cached 5 min per session; ?refresh=1 re-reads)
 *   GET /api/aps/viewer-token  a short-lived viewables:read token for the Autodesk Viewer
 *   GET /api/aps/logout     forgets this browser's session and tokens
 *
 * The browser gets an opaque session id in an HttpOnly cookie and sanitized JSON. Tokens, the
 * client secret and PKCE verifiers never leave this side, and nothing here logs them. No CORS
 * header is sent: another origin must not be able to read a signed-in user's project data.
 */
import { fileURLToPath } from 'node:url';
import {
  ApsError, authorizeUrl, checkCredentials, createPkce, exchangeCode, loadApsConfig, newState,
  refreshTokens, sameSecret, tokenRecord,
} from './oauth.mjs';
import { createDataClient, derivativeManifest, discoverHubs, findFiles, itemVersions, listHubs, listProjects, topFolders } from './dataManagement.mjs';
import { SESSION_COOKIE, SESSION_TTL_MS, cookieValues, createSessionStore, legacySessionCookieClear, newSessionId, sessionCookie } from './sessions.mjs';

export const APS_BASE = '/api/aps';
/** How long a sign-in may take between /login and /callback. */
export const STATE_TTL_MS = 10 * 60 * 1000;
/** Refresh this long before the access token expires, so a request never carries a dying token. */
export const REFRESH_MARGIN_MS = 60 * 1000;
const MAX_PENDING = 5;
export const VIEWER_SCOPE = 'viewables:read';
/** /files walks the project's folders; a result this fresh is reused unless ?refresh=1. */
export const FILES_TTL_MS = 5 * 60 * 1000;
/** A forced refresh (the IFC screen's version check) reuses a list fetched less than this long ago. */
export const FILES_REFRESH_MIN_MS = 30 * 1000;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const hasScope = (granted, needed) => !granted || needed.split(/\s+/).every(scope => granted.split(/\s+/).includes(scope));
/** A same-origin path only: no scheme, no `//host`, no backslash tricks. */
const safeReturnTo = value => (typeof value === 'string' && /^\/(?![/\\])[^\s\\]*$/.test(value) ? value : null);

export function createApsApi({ env = process.env, fetchImpl = fetch, now = Date.now, logger = console, store,
  storePath = fileURLToPath(new URL('../../.aps/sessions.enc', import.meta.url)) } = {}) {
  const config = loadApsConfig(env);
  const sessions = store ?? createSessionStore(env, { logger, defaultPath: storePath });
  const secure = config.callback?.protocol === 'https:';
  const filesCache = new Map();

  if (!config.configured) {
    const why = [...config.missing.map(name => `${name} not set`), ...config.problems].join('; ');
    logger.info?.(`aps: not configured (${why}). /api/aps/status explains; the rest of the app is unaffected.`);
  }

  /** The live session this request carries. A browser with both an old and a new cookie sends both; the first live one wins. */
  function sessionOf(req) {
    for (const id of cookieValues(req.headers?.cookie, SESSION_COOKIE)) {
      const session = id ? sessions.get(id) : null;
      if (!session) continue;
      if (now() - (session.updatedAt ?? 0) > SESSION_TTL_MS) { sessions.delete(id); continue; }
      return { id, session };
    }
    return null;
  }
  /** The session cookie, plus the expiry of the older /api/aps-scoped one. */
  const cookies = id => [sessionCookie(id, { secure }), legacySessionCookieClear({ secure })];
  const save = (id, session) => sessions.set(id, { ...session, updatedAt: now() });

  /**
   * Token work for one session runs one task at a time. Autodesk rotates the refresh token on every
   * refresh, so two refreshes in flight together would leave the loser holding a revoked one; that
   * holds for the data token and the viewer token alike, since both are refreshed from the same chain.
   */
  const chains = new Map();
  function serialized(id, task) {
    const run = (chains.get(id) ?? Promise.resolve()).then(task);
    const tail = run.catch(() => {});
    chains.set(id, tail);
    void tail.then(() => { if (chains.get(id) === tail) chains.delete(id); });
    return run;
  }

  /** A refresh grant on the session's refresh token, keeping the rotated one. */
  async function refreshGrant(id, scope) {
    const session = sessions.get(id);
    if (!session?.tokens?.refreshToken) throw new ApsError('TOKEN_EXPIRED', 401, 'The Autodesk session has expired.', 'Sign in again at /api/aps/login.');
    try {
      const body = await refreshTokens(config, session.tokens.refreshToken, { fetchImpl, scope });
      return { session, body };
    } catch (error) {
      if (error.code === 'TOKEN_EXPIRED') save(id, { ...session, tokens: null, viewer: null });
      throw error;
    }
  }

  /**
   * A fresh data access token. Skipped when another request already refreshed while this one
   * waited: unless `rejected` names the token that was just refused, a still-valid token is reused.
   */
  function refresh(id, rejected = null) {
    return serialized(id, async () => {
      const current = sessions.get(id)?.tokens;
      if (current && current.accessToken !== rejected && current.expiresAt - REFRESH_MARGIN_MS > now()) return current.accessToken;
      const { session, body } = await refreshGrant(id, config.scope);
      const tokens = tokenRecord(body, { now: now(), requestedScope: session.tokens.scope || config.scope, previousRefreshToken: session.tokens.refreshToken });
      save(id, { ...session, tokens });
      return tokens.accessToken;
    });
  }

  async function accessToken(id) {
    const tokens = sessions.get(id)?.tokens;
    if (!tokens) throw new ApsError('NOT_AUTHENTICATED', 401, 'Not signed in to Autodesk.', 'Open /api/aps/login to sign in.');
    if (tokens.expiresAt - REFRESH_MARGIN_MS > now()) return tokens.accessToken;
    return refresh(id);
  }

  /**
   * The token handed to the browser for the Autodesk Viewer: the same sign-in, refreshed down to
   * viewables:read (Autodesk's documented pattern), so page script can display derivatives but
   * cannot read or list project data. The data token and the refresh token never leave the server.
   */
  function viewerToken(id) {
    return serialized(id, async () => {
      const cached = sessions.get(id)?.viewer;
      if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now()) return cached;
      const { session, body } = await refreshGrant(id, VIEWER_SCOPE).catch(error => {
        if (error.code === 'MISSING_SCOPE') {
          throw new ApsError('MISSING_SCOPE', 403, 'This sign-in does not allow viewing models (viewables:read).',
            'Sign in again at /api/aps/login: the app now asks for data:read and viewables:read.');
        }
        throw error;
      });
      const record = tokenRecord(body, { now: now(), requestedScope: VIEWER_SCOPE, previousRefreshToken: session.tokens.refreshToken });
      const viewer = { accessToken: record.accessToken, expiresAt: record.expiresAt };
      save(id, { ...session, tokens: { ...session.tokens, refreshToken: record.refreshToken }, viewer });
      return viewer;
    });
  }

  function clientFor(req) {
    if (!config.configured) throw notConfigured();
    const current = sessionOf(req);
    if (!current?.session.tokens) throw new ApsError('NOT_AUTHENTICATED', 401, 'Not signed in to Autodesk.', 'Open /api/aps/login to sign in.');
    if (!hasScope(current.session.tokens.scope, 'data:read')) {
      throw new ApsError('MISSING_SCOPE', 403, `The token was granted "${current.session.tokens.scope}", without data:read.`, 'Sign in again at /api/aps/login and allow the requested access.');
    }
    return createDataClient({ fetchImpl, getToken: () => accessToken(current.id), refresh: rejected => refresh(current.id, rejected) });
  }

  function notConfigured() {
    const detail = [...config.missing.map(name => `${name} is not set.`), ...config.problems].join(' ');
    return new ApsError('APS_NOT_CONFIGURED', 503, `Autodesk sign-in is not configured. ${detail}`,
      'Add APS_CLIENT_ID, APS_CLIENT_SECRET and APS_CALLBACK_URL to cesium-poc/.env.local and restart the dev server.');
  }

  const noHubs = () => new ApsError('HUB_INACCESSIBLE', 403, 'This Autodesk account can see no hubs through this app.',
    'In the Forma hub\'s Account Admin, add the client id as a Custom Integration, and sign in with an account that is a member of that hub.');

  /** The target project, found by name across every accessible hub (or the one given). */
  async function targetProject(client, hubId) {
    const hubs = await listHubs(client);
    if (!hubs.length) throw noHubs();
    const candidates = hubId ? hubs.filter(hub => hub.id === hubId) : hubs;
    if (hubId && !candidates.length) throw new ApsError('HUB_INACCESSIBLE', 403, `Hub ${hubId} is not accessible to this account.`);
    const wanted = config.projectName.toLowerCase();
    const refused = [];
    for (const hub of candidates) {
      let projects;
      try { projects = await listProjects(client, hub.id); } catch (error) {
        if (error.code === 'TOKEN_EXPIRED' || error.code === 'MISSING_SCOPE') throw error;
        refused.push(hub.name); continue;
      }
      const project = projects.find(entry => String(entry.name ?? '').trim().toLowerCase() === wanted);
      if (project) return { hub, project };
    }
    if (refused.length) {
      throw new ApsError('HUB_INACCESSIBLE', 403, `"${config.projectName}" was not found, and the projects of ${refused.join(', ')} could not be read.`,
        'Check the Custom Integration in that hub\'s Account Admin and that the account is a project member.');
    }
    throw new ApsError('PROJECT_NOT_FOUND', 404, `No accessible project is named "${config.projectName}".`,
      'Check the name (APS_TARGET_PROJECT_NAME) and that the signed-in account is a member of the project.');
  }

  async function files(client, hubId) {
    const { hub, project } = await targetProject(client, hubId);
    const folders = await topFolders(client, hub.id, project.id);
    const search = await findFiles(client, { projectId: project.id, folders, fileNames: config.fileNames });
    const result = [];
    for (const item of search.found) {
      const versions = await itemVersions(client, project.id, item.id);
      const tip = versions.find(version => version.id === item.tipVersionId) ?? item.tip ?? versions[0] ?? null;
      const urn = tip?.derivativeUrn ?? null;
      result.push({
        fileName: item.name, itemId: item.id, folderId: item.folderId, folderPath: item.folderPath,
        tipVersionId: item.tipVersionId,
        versions: versions.map(({ derivativeUrn, ...version }) => ({ ...version, derivativeUrn })),
        derivative: urn ? { urn, manifest: await derivativeManifest(client, urn) } : null,
      });
    }
    const foundNames = new Set(result.map(file => file.fileName.toLowerCase()));
    const missing = config.fileNames.filter(name => !foundNames.has(name.toLowerCase()));
    return {
      hub: { id: hub.id, name: hub.name, region: hub.region },
      project: { id: project.id, name: project.name, rootFolderId: project.rootFolderId },
      topFolders: folders,
      files: result,
      missing,
      searchedFolders: search.searchedFolders,
      searchTruncated: search.truncated,
      generatedAt: new Date(now()).toISOString(),
    };
  }

  /** The target project's IFC files for this request's session, cached per session (FILES_TTL_MS). */
  async function projectFiles(req, { hubId = null, refresh = false } = {}) {
    const client = clientFor(req);
    const key = `${sessionOf(req).id}|${hubId ?? ''}`;
    const hit = filesCache.get(key);
    if (hit && now() - hit.at < (refresh ? FILES_REFRESH_MIN_MS : FILES_TTL_MS)) return hit.payload;
    const payload = await files(client, hubId);
    filesCache.set(key, { at: now(), payload });
    return payload;
  }

  // ---- responses ----

  const headers = (extra = {}) => ({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...extra });
  function sendJson(res, status, payload, extra) {
    res.writeHead(status, headers({ 'content-type': 'application/json; charset=utf-8', ...extra }));
    res.end(JSON.stringify(payload, null, 2));
  }
  function sendError(res, error) {
    if (!(error instanceof ApsError)) {
      logger.error?.(`aps: unexpected failure: ${error?.message ?? error}`);
      error = new ApsError('INTERNAL', 500, 'Unexpected server error.');
    }
    sendJson(res, error.status, { error: { code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) } });
  }
  function sendPage(res, status, title, body, extra) {
    res.writeHead(status, headers({ 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", ...extra }));
    res.end(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;color:#1b1f24}code{background:#eef1f4;padding:1px 4px;border-radius:3px}.err{color:#a4161a}</style>
<h1>${escapeHtml(title)}</h1>${body}`);
  }
  const errorPage = (res, error) => sendPage(res, error.status ?? 400, 'Autodesk sign-in failed',
    `<p class="err"><b>${escapeHtml(error.code)}</b>: ${escapeHtml(error.message)}</p>${error.hint ? `<p>${escapeHtml(error.hint)}</p>` : ''}<p><a href="${APS_BASE}/login">Try again</a> · <a href="${APS_BASE}/status">Status</a></p>`);

  // ---- routes ----

  function login(req, res, url) {
    if (!config.configured) return errorPage(res, notConfigured());
    // The cookie set here must come back on the callback, which only happens on the callback's host.
    // Opened as 127.0.0.1 with a localhost callback, it would be lost, so start over on that host.
    if (req.headers?.host && req.headers.host !== config.callback.host) {
      res.writeHead(302, headers({ location: `${config.callback.origin}${APS_BASE}/login${url.search}` }));
      return res.end();
    }
    const current = sessionOf(req);
    const id = current?.id ?? newSessionId();
    const session = current?.session ?? { createdAt: now(), tokens: null };
    const { verifier, challenge } = createPkce();
    const state = newState();
    const pending = [...(session.pending ?? []).filter(entry => now() - entry.at < STATE_TTL_MS),
      { state, verifier, at: now(), returnTo: safeReturnTo(url.searchParams.get('returnTo')) }].slice(-MAX_PENDING);
    save(id, { ...session, pending });
    res.writeHead(302, headers({ location: authorizeUrl(config, { state, challenge }), 'set-cookie': cookies(id) }));
    res.end();
  }

  async function callback(req, res, url) {
    if (!config.configured) return errorPage(res, notConfigured());
    const params = url.searchParams;
    const current = sessionOf(req);
    const state = params.get('state');
    const pendingList = current?.session.pending ?? [];
    const match = state ? pendingList.find(entry => sameSecret(entry.state, state)) : null;
    // The state is single-use: removed before anything else happens, whatever the outcome.
    if (match) save(current.id, { ...current.session, pending: pendingList.filter(entry => entry !== match) });

    if (params.get('error')) {
      const code = params.get('error');
      return errorPage(res, code === 'access_denied'
        ? new ApsError('ACCESS_DENIED', 403, 'Authorization was declined on the Autodesk consent screen.', 'Sign in again and choose Allow.')
        : new ApsError('AUTHORIZE_FAILED', 400, `Autodesk returned "${String(code).slice(0, 60)}".`,
          'If it mentions the redirect or callback, APS_CALLBACK_URL must equal the Callback URL registered for the app.'));
    }
    if (!current) {
      return errorPage(res, new ApsError('STATE_INVALID', 400, 'No sign-in is in progress for this browser.',
        `Start at ${APS_BASE}/login on ${config.callback.origin}, in the same browser, with cookies allowed. A restarted dev server also forgets in-memory sign-ins.`));
    }
    if (!match) return errorPage(res, new ApsError('STATE_INVALID', 400, 'The sign-in state did not match.', `Start again at ${APS_BASE}/login.`));
    if (now() - match.at > STATE_TTL_MS) return errorPage(res, new ApsError('STATE_EXPIRED', 400, 'The sign-in took longer than 10 minutes.', `Start again at ${APS_BASE}/login.`));
    const code = params.get('code');
    if (!code) return errorPage(res, new ApsError('AUTH_CODE_INVALID', 400, 'The callback carried no authorization code.'));

    let tokens;
    try {
      tokens = tokenRecord(await exchangeCode(config, { code, verifier: match.verifier }, { fetchImpl }), { now: now(), requestedScope: config.scope });
    } catch (error) {
      return error instanceof ApsError ? errorPage(res, error) : sendError(res, error);
    }
    // A fresh session id after sign-in, so an id planted before it can never carry the tokens.
    const fresh = newSessionId();
    sessions.delete(current.id);
    save(fresh, { createdAt: current.session.createdAt, pending: [], tokens });
    logger.info?.(`aps: signed in (scope "${tokens.scope}", tokens held in ${sessions.kind} session storage).`);
    const cookie = cookies(fresh);
    if (match.returnTo) {
      res.writeHead(302, headers({ location: match.returnTo, 'set-cookie': cookie }));
      return res.end();
    }
    const missingScope = !hasScope(tokens.scope, 'data:read');
    sendPage(res, 200, 'Signed in to Autodesk', `<p>The access token is held on the server and expires at ${escapeHtml(new Date(tokens.expiresAt).toISOString())}; it is refreshed automatically.</p>
${missingScope ? `<p class="err">The granted scope "${escapeHtml(tokens.scope)}" does not include data:read.</p>` : ''}
<ul><li><a href="${APS_BASE}/status">${APS_BASE}/status</a></li><li><a href="${APS_BASE}/hubs">${APS_BASE}/hubs</a></li><li><a href="${APS_BASE}/projects">${APS_BASE}/projects</a></li><li><a href="${APS_BASE}/files">${APS_BASE}/files</a></li></ul>`, { 'set-cookie': cookie });
  }

  async function status(req, res, url) {
    const tokens = sessionOf(req)?.session.tokens ?? null;
    const payload = {
      configured: config.configured,
      missingEnv: config.missing,
      configProblems: config.problems,
      // The client id is public (it is in every authorize URL); the tail is enough to tell which app
      // a long-running dev server loaded, since an edited .env.local only applies after a full restart.
      clientIdSuffix: config.clientId ? config.clientId.slice(-4) : null,
      callbackUrl: config.callbackUrl || null,
      requestedScope: config.scope,
      targetProjectName: config.projectName,
      targetFiles: config.fileNames,
      sessionStorage: sessions.kind,
      authenticated: Boolean(tokens),
      ...(tokens ? {
        grantedScope: tokens.scope || null,
        hasDataRead: hasScope(tokens.scope, 'data:read'),
        accessTokenExpiresAt: new Date(tokens.expiresAt).toISOString(),
        accessTokenExpiresInSeconds: Math.max(0, Math.round((tokens.expiresAt - now()) / 1000)),
        refreshable: Boolean(tokens.refreshToken),
      } : {}),
      loginUrl: `${APS_BASE}/login`,
    };
    if (url.searchParams.get('test') === '1') {
      payload.test = await checkCredentials(config, { fetchImpl });
      if (tokens && config.configured) {
        try {
          const hubs = await listHubs(clientFor(req));
          payload.test.dataApi = { ok: true, hubCount: hubs.length };
        } catch (error) {
          payload.test.dataApi = { ok: false, code: error.code, message: error.message };
        }
      }
    }
    sendJson(res, 200, payload);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== APS_BASE && !url.pathname.startsWith(`${APS_BASE}/`)) return false;
    if (!['GET', 'HEAD'].includes(req.method)) { sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is supported.' } }); return true; }
    try {
      switch (url.pathname) {
        case `${APS_BASE}/login`: login(req, res, url); break;
        case `${APS_BASE}/callback`: await callback(req, res, url); break;
        case APS_BASE:
        case `${APS_BASE}/status`: await status(req, res, url); break;
        case `${APS_BASE}/logout`: {
          const current = sessionOf(req);
          if (current) {
            sessions.delete(current.id);
            for (const key of filesCache.keys()) if (key.startsWith(`${current.id}|`)) filesCache.delete(key);
          }
          sendJson(res, 200, { signedOut: true }, { 'set-cookie': [sessionCookie('', { secure, maxAgeMs: 0 }), legacySessionCookieClear({ secure })] });
          break;
        }
        case `${APS_BASE}/hubs`: {
          const hubs = await discoverHubs(clientFor(req), config.projectName);
          if (!hubs.length) throw noHubs();
          const target = hubs.find(hub => hub.containsTargetProject) ?? null;
          sendJson(res, 200, { targetProjectName: config.projectName, targetHubId: target?.id ?? null, targetProject: target?.targetProject ?? null,
            ...(target ? {} : { note: `No accessible hub has a project named "${config.projectName}".` }), hubs });
          break;
        }
        case `${APS_BASE}/projects`: {
          const client = clientFor(req);
          const hubId = url.searchParams.get('hubId');
          const name = url.searchParams.get('name')?.trim().toLowerCase();
          const hubs = hubId ? [{ id: hubId }] : await listHubs(client);
          const projects = [];
          for (const hub of hubs) projects.push(...await listProjects(client, hub.id));
          sendJson(res, 200, { hubId: hubId ?? null, projects: name ? projects.filter(project => String(project.name ?? '').toLowerCase().includes(name)) : projects });
          break;
        }
        case `${APS_BASE}/viewer-token`: {
          if (!config.configured) throw notConfigured();
          const current = sessionOf(req);
          if (!current?.session.tokens) throw new ApsError('NOT_AUTHENTICATED', 401, 'Not signed in to Autodesk.', 'Open /api/aps/login to sign in.');
          const token = await viewerToken(current.id);
          // The shape the Autodesk Viewer's getAccessToken callback expects. Short-lived and view-only.
          sendJson(res, 200, { access_token: token.accessToken, expires_in: Math.max(0, Math.round((token.expiresAt - now()) / 1000)), scope: VIEWER_SCOPE });
          break;
        }
        case `${APS_BASE}/files`: {
          const payload = await projectFiles(req, { hubId: url.searchParams.get('hubId'), refresh: url.searchParams.get('refresh') === '1' });
          if (payload.missing.length) {
            sendJson(res, 404, { error: { code: 'FILES_MISSING', message: `Not found in "${payload.project.name}": ${payload.missing.join(', ')}.`,
              hint: payload.searchTruncated ? 'The folder search stopped at its budget; the file may be deeper.' : 'Check the file names (APS_TARGET_FILES) and that the account can see the folder.' }, ...payload });
          } else sendJson(res, 200, payload);
          break;
        }
        default: sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `Unknown APS route. Try ${APS_BASE}/status.` } });
      }
    } catch (error) {
      sendError(res, error);
    }
    return true;
  }

  return {
    handle,
    middleware: (req, res, next) => { handle(req, res).then(handled => { if (!handled) next(); }, next); },
    /**
     * For other server modules (the IFC Spatial Twin): the signed-in session's Data Management
     * client and project files. They throw the same ApsError codes the routes answer with.
     */
    dataClient: req => clientFor(req),
    projectFiles,
    sessionId: req => sessionOf(req)?.id ?? null,
  };
}
