/**
 * Camera moves for asset selection and inspection.
 *
 * Three operations the spec keeps apart, and so does this module:
 *   focusSelection() — a moderate look, used when a selection changes. Never a close-up, because a
 *                      user pressing Next five times should not be flown into five buildings.
 *   inspect()        — the explicit close view behind "View on map". Saves the camera first.
 *   returnToSaved()  — puts the camera back where inspection found it.
 *
 * The camera is never attached to an entity. `trackedEntity` would take the user's controls away,
 * and selection is not tracking: after any move here the user can still pan, zoom, orbit and tilt.
 *
 * Camera state is saved as position + direction + up rather than heading/pitch/roll. Near nadir —
 * where this app's Reset View and top-down alignment work both sit — heading and pitch are
 * ill-conditioned, and a saved 89.9° pitch comes back as something visibly different.
 */
import { BoundingSphere, Cartesian3, Cartographic, HeadingPitchRange, Math as CMath } from 'cesium';
import { ASSET_CAMERA_PRESETS, SELECTION_FOCUS } from './assetTypes.js';

/** Fallback framing for a type with no preset — deliberately not a close-up. */
export const DEFAULT_PRESET = Object.freeze({ rangeM: 220, pitchDeg: -30 });

export const FLIGHT_SECONDS = Object.freeze({ focus: 1.2, inspect: 1.6, back: 1.4 });

/** What a preset means for one asset, given whatever the record actually carries. */
export function framingFor(asset, presets = ASSET_CAMERA_PRESETS) {
  const preset = presets[asset?.assetType] ?? DEFAULT_PRESET;
  // viewHeadingDeg is the app's own "which side to view this from" figure, not the model's facing.
  const heading = preset.useModelHeading
    ? Number(asset?.source?.viewHeadingDeg ?? asset?.source?.viewHeading ?? asset?.source?.heading)
    : NaN;
  return {
    rangeM: preset.rangeM,
    pitchDeg: preset.pitchDeg,
    extentMultiplier: preset.extentMultiplier ?? 2.4,
    // A gantry records the bearing it faces, so the close view can look at its front rather than
    // arriving at whatever heading the camera happened to hold.
    headingDeg: Number.isFinite(heading) ? heading : null,
  };
}

/** Snapshot of a camera, in the form that survives a round trip near nadir. */
export function cameraState(camera) {
  return {
    // positionWC is a live internal vector — Cesium mutates it in place, so it must be cloned.
    position: Cartesian3.clone(camera.positionWC, new Cartesian3()),
    direction: Cartesian3.clone(camera.directionWC, new Cartesian3()),
    up: Cartesian3.clone(camera.upWC, new Cartesian3()),
  };
}

export function createAssetNavigation(viewer, { presets = ASSET_CAMERA_PRESETS, logger = console } = {}) {
  let saved = null;

  /** Ground-level sphere for a point asset; the asset's own extent when it has geometry. */
  function sphereFor(asset) {
    if (!asset?.coordinates) return null;
    const { longitude, latitude } = asset.coordinates;
    const points = Array.isArray(asset.geometry?.positions) && asset.geometry.positions.length
      ? asset.geometry.positions
      : [Cartesian3.fromDegrees(longitude, latitude, asset.geometry?.height ?? 0)];
    return BoundingSphere.fromPoints(points);
  }

  function flyTo(asset, { rangeM, pitchDeg, headingDeg, extentMultiplier = 2.4 }, duration) {
    const sphere = sphereFor(asset);
    if (!sphere) return false;
    // A bridge's span should set the distance; a point asset has no extent to widen for.
    const range = Math.max(rangeM, sphere.radius * extentMultiplier);
    viewer.camera.flyToBoundingSphere(sphere, {
      duration,
      offset: new HeadingPitchRange(
        CMath.toRadians(headingDeg ?? CMath.toDegrees(viewer.camera.heading)),
        CMath.toRadians(pitchDeg),
        range),
    });
    return true;
  }

  return {
    /** A moderate look at a newly selected asset. */
    focusSelection(asset) {
      if (!asset?.coordinates) return false;
      const { headingDeg, extentMultiplier } = framingFor(asset, presets);
      return flyTo(asset, { ...SELECTION_FOCUS, headingDeg, extentMultiplier }, FLIGHT_SECONDS.focus);
    },

    /**
     * The explicit close view. Saves the camera first so Back is always available afterwards, and
     * only overwrites an existing save when the user is coming from the corridor rather than
     * hopping between assets — otherwise Back would walk backwards through inspections.
     */
    inspect(asset, { alreadyInspecting = false } = {}) {
      if (!asset?.coordinates) {
        logger.warn?.('[asset-explorer] no coordinates to inspect for', asset?.id);
        return false;
      }
      if (!alreadyInspecting || !saved) saved = cameraState(viewer.camera);
      return flyTo(asset, framingFor(asset, presets), FLIGHT_SECONDS.inspect);
    },

    /** Put the camera back where inspection found it. */
    returnToSaved() {
      if (!saved) return false;
      const { position, direction, up } = saved;
      viewer.camera.flyTo({
        destination: position,
        orientation: { direction, up },
        duration: FLIGHT_SECONDS.back,
      });
      saved = null;
      return true;
    },

    hasSaved: () => saved !== null,
    /** Dropped when the user takes the camera somewhere else themselves. */
    clearSaved() { saved = null; },
    /** Diagnostics: where the saved camera is, in degrees. */
    savedPosition() {
      if (!saved) return null;
      const carto = Cartographic.fromCartesian(saved.position);
      return carto ? {
        longitude: CMath.toDegrees(carto.longitude),
        latitude: CMath.toDegrees(carto.latitude),
        height: carto.height,
      } : null;
    },
  };
}
