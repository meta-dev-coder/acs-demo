/**
 * The Seagirt IFC Spatial Twin, served by the EC2 demo host beside the I-595 app and PortMiami.
 *
 * Its frontend is part of the main web bundle (/?demo=seagirt&screen=ifc-spatial; /seagirt/ goes there). Its
 * server APIs are bundled into seagirt/api.mjs with the packages they need in seagirt/node_modules
 * (tools/build-live-dc-bundle.mjs); this module loads them, when the release carries them, so /api/aps/*,
 * /api/ifc-spatial/* and /api/gmail/* are answered in the same process: no second service, port or
 * security-group rule. Unlike PortMiami these routes write (model conversions, placements, reports, email
 * drafts, sends), all behind the demo password; their stores live in the state directory
 * (HOME/seagirt, /var/lib/live-dc/seagirt on EC2), so a new release keeps them.
 *
 * The two OAuth callbacks (/api/aps/callback, /api/gmail/auth/callback) are answered without the demo session:
 * the browser does not send the SameSite=Strict session cookie on a redirect from Autodesk or Google. They are
 * protected by their own state, PKCE and cookie checks. The Autodesk callback's redirect back into the app is
 * answered as a page that navigates by script, so that navigation is same-site and keeps the demo session.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SEAGIRT_PATH = '/seagirt';
export const SEAGIRT_HOME = '/?demo=seagirt&screen=ifc-spatial';
export const SEAGIRT_API = /^\/api\/(aps|ifc-spatial|gmail)(\/|$)/;
export const SEAGIRT_CALLBACKS = Object.freeze(['/api/aps/callback', '/api/gmail/auth/callback']);

const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * A 302 from the Autodesk callback becomes a page that goes there by script (cookies set on the 302 are kept).
 */
export function sameSiteRedirect(res) {
  const writeHead = res.writeHead.bind(res);
  res.writeHead = (status, ...rest) => {
    const headers = rest.find(h => h && typeof h === 'object') ?? {};
    const location = headers.location ?? headers.Location;
    // Only a path on this site (the Autodesk API's returnTo is always one); anything else keeps its 302.
    const target = typeof location === 'string' && /^\/(?![/\\])[^\s\\]*$/.test(location) ? location : null;
    if (status !== 302 || !target) return writeHead(status, ...rest);
    const { location: _l, Location: _L, ...keep } = headers;
    void _l; void _L;
    const body = `<!doctype html><meta charset="utf-8"><title>Signing in…</title><meta http-equiv="refresh" content="0;url=${escAttr(target)}"><script>location.replace(${JSON.stringify(target)})</script>`;
    writeHead(200, { ...keep, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    const end = res.end.bind(res);
    res.end = () => end(body);
    return res;
  };
  return res;
}

/**
 * @returns {Promise<null | { handle(req, res): Promise<boolean>, stop(): Promise<void>, stateDir: string, configured: object }>}
 *          null when the release carries no Seagirt bundle (or LIVE_DC_SEAGIRT_DIR is unset).
 */
export async function loadSeagirt({ env = process.env, logger = console, importModule = url => import(url) } = {}) {
  const dir = String(env.LIVE_DC_SEAGIRT_DIR ?? '').trim();
  if (!dir || !existsSync(join(dir, 'api.mjs'))) return null;
  const stateDir = join(String(env.HOME ?? '').trim() || '/var/lib/live-dc', 'seagirt');
  mkdirSync(stateDir, { recursive: true });
  const mod = await importModule(pathToFileURL(join(dir, 'api.mjs')).href);
  const { handlers, configured } = mod.createSeagirtApis({ env, logger, stateDir });
  logger.log?.(`live-dc seagirt: on at ${SEAGIRT_PATH}/ (state in ${stateDir}; Autodesk sign-in ${configured.aps ? 'configured' : 'not configured: set APS_CLIENT_ID, APS_CLIENT_SECRET, APS_CALLBACK_URL'}; Gmail ${configured.gmail ? 'configured' : 'not configured'}; question reading by Claude ${configured.llm ? `on: ${configured.llm}` : 'off'})`);
  return {
    stateDir, configured,
    async handle(req, res) {
      const path = String(req.url ?? '').split('?')[0];
      if (path === '/api/aps/callback') sameSiteRedirect(res);
      for (const h of handlers) if (await h.handle(req, res)) return true;
      return false;
    },
    async stop() {},
  };
}
