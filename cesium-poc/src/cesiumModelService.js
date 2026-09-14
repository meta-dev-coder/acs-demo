/**
 * Data-driven GLB placement for the corridor.
 *
 * Models are described entirely in `config/cesiumModels.json` — position, orientation, scale and
 * height offset — and rendered here through the Entity API, the same way every other corridor asset
 * is drawn. Adding a record to the JSON renders another model; no code changes, no per-model
 * branches, and no coordinates anywhere in the UI.
 *
 * Height is the one thing the JSON cannot state: the corridor sits on Google Photorealistic 3D
 * Tiles, where the road deck is tens of metres above the ellipsoid and varies along the alignment.
 * Each model's ground height is therefore sampled from the scene that is actually drawn, and the
 * JSON supplies only an offset from it.
 */
import {
  Cartesian3, Cartographic, HeadingPitchRoll, Math as CMath, Transforms, CustomDataSource,
} from 'cesium';

export const GLB_MODEL_ASSET_TYPE = 'GLB_MODEL';

/** Never let a model shrink to nothing at corridor distances, and never let it balloon up close. */
const DEFAULT_MINIMUM_PIXEL_SIZE = 32;
const DEFAULT_MAXIMUM_SCALE = 20000;

/**
 * Config URLs are written from the site root (`/models/i595/x.glb`) so the JSON stays free of build
 * concerns; under GitHub Pages the app is served from a sub-path, so they resolve against BASE_URL
 * exactly like `data/` and the existing `models/car.glb`.
 */
export function resolveModelUrl(modelUrl) {
  if (typeof modelUrl !== 'string' || modelUrl.trim() === '') return null;
  const url = modelUrl.trim();
  if (/^(https?:)?\/\//.test(url) || url.startsWith('data:') || url.startsWith('blob:')) return url;
  return import.meta.env.BASE_URL + url.replace(/^\/+/, '');
}

/**
 * A record is only placeable if it names a file and a real point on the globe.
 *
 * The range checks catch a grossly wrong coordinate, but they cannot catch a swapped pair on their
 * own — reversing this corridor's own 26.1 / -80.3 gives two in-range numbers. What actually keeps
 * lat and lon apart is that the JSON names them and `addModel` is the single place they are read.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function validateModelConfig(config) {
  if (!config || typeof config !== 'object') return { ok: false, reason: 'not an object' };
  if (typeof config.id !== 'string' || config.id.trim() === '') return { ok: false, reason: 'missing id' };
  if (!resolveModelUrl(config.modelUrl)) return { ok: false, reason: 'missing modelUrl' };
  const { latitude, longitude } = config;
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) return { ok: false, reason: `latitude ${latitude} is out of range` };
  if (!Number.isFinite(longitude) || Math.abs(longitude) > 180) return { ok: false, reason: `longitude ${longitude} is out of range` };
  return { ok: true };
}

/**
 * Orientation is the model's own business: never compensate for a mesh axis by moving the model.
 *
 * How `heading` lands on the ground, measured in this scene rather than inferred from the glTF spec
 * (the first version of this got it 90° wrong by reasoning it out instead):
 *
 *   glTF +X  points along bearing = heading
 *   glTF +Z  points along bearing = heading + 90
 *
 * So a structure whose long axis is its mesh's +X — an overhead gantry beam — spans a road of
 * bearing B at `heading = B + 90`, and one whose long axis is +Z — a barrier arm — reaches across
 * that road at `heading = B - 90` (or B + 90 to reach the other way).
 */
export function modelOrientation(position, { heading = 0, pitch = 0, roll = 0 } = {}) {
  return Transforms.headingPitchRollQuaternion(position, new HeadingPitchRoll(
    CMath.toRadians(heading), CMath.toRadians(pitch), CMath.toRadians(roll)));
}

/** Rings sampled around a model's point, in metres, with this many points on each ring. */
export const GROUND_SAMPLE_RADII_M = Object.freeze([5, 11]);
const GROUND_SAMPLE_SPOKES = 8;
const METRES_PER_DEGREE_LAT = 110540;
const METRES_PER_DEGREE_LON = 111320;

/** The point itself plus a ring pattern around it, as cartographics ready to sample. */
export function groundSamplePoints(longitude, latitude, radii = GROUND_SAMPLE_RADII_M) {
  const points = [Cartographic.fromDegrees(longitude, latitude)];
  const lonScale = METRES_PER_DEGREE_LON * Math.cos(latitude * Math.PI / 180);
  for (const radius of radii) {
    for (let spoke = 0; spoke < GROUND_SAMPLE_SPOKES; spoke++) {
      const angle = (spoke * 2 * Math.PI) / GROUND_SAMPLE_SPOKES;
      points.push(Cartographic.fromDegrees(
        longitude + (Math.cos(angle) * radius) / lonScale,
        latitude + (Math.sin(angle) * radius) / METRES_PER_DEGREE_LAT));
    }
  }
  return points;
}

/** Middle value of the samples — the surface most of them landed on. */
export function medianHeight(heights) {
  const sorted = heights.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Ground height under a point, measured against whatever is currently drawn.
 *
 * A single downward ray is not enough. Photogrammetry contains the real world's overhead
 * furniture — sign gantries, mast arms, canopies — and a ray through one reports the structure as
 * "ground", which left two gantries hanging about 10 m in the air. So a ring of points around the
 * model is sampled in one pass and the median taken: a minority of rays that hit something overhead
 * cannot move it, and neither can a minority that stray off the edge of a deck.
 *
 * `sampleHeightMostDetailed` needs a depth texture, so where that is unsupported this falls back to
 * the terrain globe and finally to the ellipsoid. A model placed on a fallback is still
 * georeferenced — only its height is coarser.
 * @returns {Promise<{height: number, source: 'SCENE'|'GLOBE'|'ELLIPSOID', spread?: number}>}
 */
export async function sampleGroundHeight(scene, longitude, latitude, { objectsToExclude = [] } = {}) {
  if (scene?.sampleHeightSupported && typeof scene.sampleHeightMostDetailed === 'function') {
    try {
      const points = groundSamplePoints(longitude, latitude);
      await scene.sampleHeightMostDetailed(points, objectsToExclude);
      const heights = points.map(point => point.height).filter(Number.isFinite);
      const height = medianHeight(heights);
      if (Number.isFinite(height)) {
        // How much the samples disagreed: large means the model stands near something tall, which
        // is exactly the case a single ray used to get wrong.
        const spread = Math.max(...heights) - Math.min(...heights);
        return { height, source: 'SCENE', spread };
      }
    } catch {
      // A sampling failure must never stop the model — or the map — from coming up.
    }
  }
  const cartographic = Cartographic.fromDegrees(longitude, latitude);
  const globeHeight = scene?.globe?.getHeight?.(cartographic);
  if (Number.isFinite(globeHeight)) return { height: globeHeight, source: 'GLOBE' };
  return { height: 0, source: 'ELLIPSOID' };
}

/**
 * @param {import('cesium').Viewer} viewer  the existing viewer — never created here
 * @param {{logger?: Console}} [options]
 */
export function createCesiumModelService(viewer, { logger = console } = {}) {
  const source = new CustomDataSource('Corridor Models');
  /** @type {Map<string, import('cesium').Entity>} */
  const modelById = new Map();
  const added = viewer.dataSources.add(source);
  let destroyed = false;

  /** Placed models must not be sampled against themselves when a later model lands beside them. */
  const placed = () => [...modelById.values()];

  /**
   * Place one model. Resolves once the entity exists; the GLB itself streams in afterwards.
   * @returns {Promise<import('cesium').Entity|null>} null when the record was skipped or invalid
   */
  async function addModel(config) {
    const valid = validateModelConfig(config);
    if (!valid.ok) {
      logger.error?.('[Cesium Models] skipped an invalid model record', { id: config?.id, modelUrl: config?.modelUrl, reason: valid.reason });
      return null;
    }
    if (config.enabled === false) return null;

    const { id, longitude, latitude, heightOffset = 0 } = config;
    const uri = resolveModelUrl(config.modelUrl);
    const ground = await sampleGroundHeight(viewer.scene, longitude, latitude, { objectsToExclude: placed() });
    if (destroyed) return null;
    const finalHeight = ground.height + heightOffset;
    // fromDegrees takes longitude first — the corridor's own coordinates are stored lon/lat for the
    // same reason, so the JSON's named fields are the only place lat and lon can be confused.
    const position = Cartesian3.fromDegrees(longitude, latitude, finalHeight);

    removeModel(id);
    const entity = source.entities.add({
      id,
      name: config.name ?? id,
      position,
      orientation: modelOrientation(position, config),
      model: {
        uri,
        scale: config.scale ?? 1,
        minimumPixelSize: config.minimumPixelSize ?? DEFAULT_MINIMUM_PIXEL_SIZE,
        maximumScale: config.maximumScale ?? DEFAULT_MAXIMUM_SCALE,
      },
      properties: {
        assetType: config.type ?? GLB_MODEL_ASSET_TYPE,
        latitude, longitude, heightOffset,
        groundHeight: ground.height, groundHeightSource: ground.source, modelUrl: uri,
      },
    });
    modelById.set(id, entity);
    logger.debug?.('[Cesium Models]', {
      id, longitude, latitude,
      sampledHeight: ground.height, heightSource: ground.source, sampleSpread: ground.spread, heightOffset, finalHeight,
      heading: config.heading ?? 0, scale: config.scale ?? 1,
    });
    // A missing or misnamed file is otherwise a silent nothing on the map.
    void fetch(uri, { method: 'HEAD' })
      .then(response => { if (!response.ok) logger.error?.('[Cesium Models] model file did not resolve', { id, uri, status: response.status }); })
      .catch(error => logger.error?.('[Cesium Models] model file could not be fetched', { id, uri, error }));
    viewer.scene.requestRender();
    return entity;
  }

  /** Place every enabled record. One bad record never stops the rest. */
  async function loadModels(configs) {
    const records = Array.isArray(configs) ? configs : [];
    const entities = await Promise.all(records.map(config => addModel(config).catch(error => {
      logger.error?.('[Cesium Models] model could not be placed', { id: config?.id, modelUrl: config?.modelUrl, error });
      return null;
    })));
    return entities.filter(Boolean);
  }

  function removeModel(id) {
    const entity = modelById.get(id);
    if (!entity) return false;
    source.entities.remove(entity);
    modelById.delete(id);
    viewer.scene.requestRender();
    return true;
  }

  return {
    modelById,
    ready: added,
    addModel,
    loadModels,
    removeModel,
    /**
     * Development helper only — loading never moves the camera. Call it by hand from the console
     * (`window.__cesiumModels.flyToModel('i595-gantry-1-toll-plaza')`) to go and look at a model.
     */
    flyToModel(id, options = {}) {
      const entity = modelById.get(id);
      if (!entity) return false;
      void viewer.flyTo(entity, { duration: 1.5, ...options });
      return true;
    },
    destroy() {
      destroyed = true;
      viewer.dataSources.remove(source, true);
      modelById.clear();
    },
  };
}
