/**
 * The PortMiami Digital Twin, served by the EC2 demo host beside the I-595 app.
 *
 * PortMiami is a separate project (../portmiami-digital-twin). The release builds its frontend into
 * web/portmiami/ (served at /portmiami/ behind the same password) and bundles its API into
 * portmiami/api.mjs, with the roads it reads in portmiami/data/ and the first contents of its design
 * and geometry stores in portmiami/seed/ (tools/build-live-dc-bundle.mjs). This module loads that
 * bundle, when present, so /api/portmiami/... is answered in the same process: no second service,
 * port or security-group rule.
 *
 * The stores live in the state directory (HOME, /var/lib/live-dc on EC2), seeded once from the
 * release, so a new release never overwrites them. Geometry and design editing stay off here
 * (PORTMIAMI_GEOMETRY_EDIT is never set): the host is shared and has no user accounts, and the
 * demo host answers every PortMiami write with 405 before it reaches this API anyway.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PORTMIAMI_API_PREFIX = '/api/portmiami/';
/** The one PortMiami route that takes a POST without writing anything: question → intent. */
export const PORTMIAMI_ASK = '/api/portmiami/ask';
export const PORTMIAMI_PATH = '/portmiami';
const STORES = Object.freeze({ design: 'design-alternatives.json', geometry: 'asset-geometry.json' });

/**
 * @returns {Promise<null | { handle(req, res): Promise<boolean>, stop(): Promise<void>, stores: object }>}
 *          null when the release carries no PortMiami bundle (or LIVE_DC_PORTMIAMI_DIR is unset).
 */
export async function loadPortMiami({ env = process.env, logger = console, importModule = url => import(url) } = {}) {
  const dir = String(env.LIVE_DC_PORTMIAMI_DIR ?? '').trim();
  if (!dir || !existsSync(join(dir, 'api.mjs'))) return null;
  const stateDir = join(String(env.HOME ?? '').trim() || '/var/lib/live-dc', 'portmiami');
  mkdirSync(stateDir, { recursive: true });
  const stores = {};
  for (const [key, file] of Object.entries(STORES)) {
    stores[key] = join(stateDir, file);
    const seed = join(dir, 'seed', file);
    if (!existsSync(stores[key]) && existsSync(seed)) copyFileSync(seed, stores[key]);
  }
  const mod = await importModule(pathToFileURL(join(dir, 'api.mjs')).href);
  const api = mod.createLiveTrafficApi({
    config: mod.loadFl511Config(env),
    roadsPath: join(dir, 'data', 'portmiami_roads_merged.geojson'),
    designStore: mod.createDesignStore({ path: stores.design }),
    geometryStore: mod.createGeometryStore({ path: stores.geometry }),
    env: { ...env, PORTMIAMI_GEOMETRY_EDIT: '' },
    logger,
  });
  logger.log?.(`live-dc portmiami: on at ${PORTMIAMI_PATH}/ (stores in ${stateDir}, read-only)`);
  return { handle: (req, res) => api.handle(req, res), stop: () => api.stop(), stores };
}
