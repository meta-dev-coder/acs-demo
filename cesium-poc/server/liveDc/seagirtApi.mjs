/**
 * The Seagirt IFC Spatial Twin's server APIs for the EC2 demo host, bundled by the release into seagirt/api.mjs
 * (tools/build-live-dc-bundle.mjs) and loaded by server/liveDc/seagirt.mjs. The same three modules
 * `npm run dev` mounts (server/index.mjs): the Autodesk sign-in (/api/aps/*), the IFC Spatial Twin
 * (/api/ifc-spatial/*) and Gmail sending (/api/gmail/*) — with every store in the state directory instead of
 * the repository's .data/ and .aps/ folders, which the service user cannot write.
 */
import { join } from 'node:path';
import { createApsApi } from '../aps/api.mjs';
import { createIfcSpatialApi } from '../ifcSpatial/api.mjs';
import { createGmailApi } from '../gmail/api.mjs';
import { createInterpretApi } from '../ifcSpatial/interpret.mjs';

/**
 * @param {object} o
 * @param {string} o.stateDir writable directory for caches, reports, sessions and the send audit
 * @returns {{ handlers: { handle(req, res): Promise<boolean> }[], configured: { aps: boolean, gmail: boolean, llm: string|null } }}
 */
export function createSeagirtApis({ env = process.env, logger = console, stateDir }) {
  const aps = createApsApi({ env, logger, storePath: join(stateDir, 'aps', 'sessions.enc') });
  const ifcSpatial = createIfcSpatialApi({ aps, logger, cacheDir: join(stateDir, 'ifc-spatial') });
  const gmail = createGmailApi({ env, logger, reports: ifcSpatial.reportAccess, dataDir: join(stateDir, 'gmail') });
  // Questions the rules did not understand, read by Claude with I-595's key (off unless SEAGIRT_ASK_LLM=on). Before
  // ifcSpatial, which answers every other /api/ifc-spatial/* path; its daily usage is kept in the state directory.
  const interpret = createInterpretApi({ env, logger, stateDir: join(stateDir, 'ifc-spatial') });
  const has = (...keys) => keys.every(k => String(env[k] ?? '').trim());
  return { handlers: [aps, interpret, ifcSpatial, gmail], configured: { aps: has('APS_CLIENT_ID', 'APS_CLIENT_SECRET', 'APS_CALLBACK_URL'),
    gmail: has('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'), llm: interpret.enabled ? interpret.label : null } };
}
