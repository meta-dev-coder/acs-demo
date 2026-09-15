/**
 * Cutting Google's photogrammetry away where a GLB replaces it.
 *
 * The tileset carries one ClippingPolygonCollection, so the collection is rebuilt from scratch
 * every time it changes, out of two separate lists: the polygons saved in cesiumModels.json, and
 * at most one polygon being previewed in the editor. Keeping them apart is the whole point — a
 * preview must never take the saved polygons down with it, and switching the preview off must
 * leave every saved polygon exactly where it was.
 *
 * ClippingPolygon removes tiles inside a geographic region; it has no idea what a gantry is. That
 * is why the polygons are drawn by hand against the real scene rather than derived from a model's
 * coordinates, which say where the replacement stands, not how far Google's version sprawls.
 */
import { Cartesian3, ClippingPolygon, ClippingPolygonCollection } from 'cesium';
import { REPLACEMENT_STRATEGIES, flattenPolygon, replacementRecords } from './photorealisticReplacementData.js';

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{tileset: () => object|null, logger?: Console}} options
 *   `tileset` is read each time rather than captured: the photorealistic tileset is created lazily
 *   and swapped between base environments, so holding a reference would go stale.
 */
export function createPhotorealisticClipping(viewer, { tileset, logger = console } = {}) {
  /** Every declared record, whatever its strategy — coordinates are kept even when unused. */
  let declared = [];
  /** @type {{id: string, name: string, polygon: [number, number][]}[]} */
  let saved = [];
  /** @type {{id: string, polygon: [number, number][]}|null} */
  let preview = null;
  /**
   * Saved polygons held back while a replacement is being aligned against the original it hides.
   * A temporary editor state only — the configuration is never touched.
   * @type {Set<string>}
   */
  const suppressed = new Set();
  /** Whether the configuration's own polygons have been applied yet — the startup pass. */
  let appliedOnce = false;

  const toClippingPolygon = polygon =>
    new ClippingPolygon({ positions: Cartesian3.fromDegreesArray(flattenPolygon(polygon)) });

  /** One collection, built from saved + preview. Never mutated in place. */
  function rebuild() {
    const target = tileset?.();
    if (!target) return false;
    const polygons = [
      ...saved.filter(record => !suppressed.has(record.id)).map(record => record.polygon),
      ...(preview ? [preview.polygon] : []),
    ];
    if (!polygons.length) {
      // An empty collection still costs a render pass, so the tileset goes back to unclipped.
      target.clippingPolygons = undefined;
      viewer.scene.requestRender();
      return true;
    }
    target.clippingPolygons = new ClippingPolygonCollection({
      polygons: polygons.map(toClippingPolygon),
      enabled: true,
      // false: clip away what is inside the polygon, keeping everything else.
      inverse: false,
    });
    viewer.scene.requestRender();
    return true;
  }

  return {
    /**
     * Apply the polygons saved in the model configuration. Called at startup once the tileset
     * exists; the editor never needs to be open for this to happen.
     * @returns {{applied: number, skipped: {id: string, reason: string}[]}}
     */
    applySaved(configs) {
      appliedOnce = true;
      const { records, clipping, skipped } = replacementRecords(configs);
      declared = records;
      // Only CLIPPING_POLYGON records cut into the tileset. An OCCLUSION record keeps its polygon
      // here, unused, so switching back later needs no re-drawing.
      saved = clipping;
      for (const item of skipped) {
        logger.warn?.(`[Photorealistic Clipping] ${item.id}: ${item.reason}`);
      }
      const ok = rebuild();
      if (records.length) {
        logger.debug?.('[Photorealistic Clipping]', {
          applied: ok ? saved.length : 0,
          clipping: saved.map(record => record.id),
          occlusion: records.filter(record => record.strategy === REPLACEMENT_STRATEGIES.OCCLUSION).map(record => record.id),
          skipped: skipped.length, tileset: ok ? 'clipped' : 'not loaded yet',
        });
      }
      return { applied: ok ? saved.length : 0, skipped, declared: records };
    },

    /** A record's declared strategy, for surfaces that offer to compare approaches. */
    strategyOf: id => declared.find(record => record.id === id)?.strategy ?? REPLACEMENT_STRATEGIES.NONE,
    /** The polygon a record carries, applied or not — an OCCLUSION record still has its coordinates. */
    polygonOf: id => declared.find(record => record.id === id)?.polygon ?? null,

    /** Show one polygon on top of everything saved. Replaces any previous preview, never the saved set. */
    setPreview(id, polygon) {
      preview = polygon?.length >= 3 ? { id, polygon } : null;
      return rebuild();
    },

    /** Drop only the preview. Every saved polygon stays applied. */
    clearPreview() {
      preview = null;
      return rebuild();
    },

    /**
     * Hold one model's saved polygon back so Google's own structure reappears, for as long as it
     * takes to align the replacement over it. Every other polygon keeps clipping.
     */
    suppress(id) { suppressed.add(id); return rebuild(); },
    /** Put a held-back polygon straight back to work. */
    unsuppress(id) { suppressed.delete(id); return rebuild(); },
    unsuppressAll() { suppressed.clear(); return rebuild(); },
    isSuppressed: id => suppressed.has(id),
    /** True when this model has a saved polygon at all — nothing to show or hide otherwise. */
    hasSaved: id => saved.some(record => record.id === id),

    /** Diagnostics and tests: what is currently cutting into the tileset. */
    state: () => ({
      appliedOnce,
      saved: saved.map(record => ({ id: record.id, points: record.polygon.length, suppressed: suppressed.has(record.id) })),
      preview: preview ? { id: preview.id, points: preview.polygon.length } : null,
      suppressed: [...suppressed],
      total: saved.filter(record => !suppressed.has(record.id)).length + (preview ? 1 : 0),
    }),
    /** Re-apply after the tileset appears or is swapped. */
    refresh: rebuild,

    destroy() {
      saved = []; declared = []; preview = null; suppressed.clear(); appliedOnce = false;
      const target = tileset?.();
      if (target && !target.isDestroyed?.()) target.clippingPolygons = undefined;
    },
  };
}
