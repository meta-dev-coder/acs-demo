/**
 * The nearby incidents, drawn on the map while the case's accident history is open.
 *
 * A list of ten other crashes "at this spot" is a claim about PLACE, and a list cannot make that
 * claim — only the map can. Opening the history therefore pins each one where it happened, so an
 * operator sees at a glance whether they are strung along the carriageway, clustered at one ramp
 * gore, or in fact at the same nominal coordinate as each other.
 *
 * Its own data source, added AFTER the maintenance layers, for the same reason the maintenance
 * layer keeps a separate selection source: these markers are drawn without a depth test and the
 * last source added wins, so a history pin is never hidden behind the register marker it sits on.
 *
 * It owns nothing else. It does not touch the maintenance layer's entities, it does not change
 * the camera, and closing the history removes every pin it added.
 */
import { CustomDataSource, Cartesian2, Cartesian3, HeightReference, NearFarScalar, VerticalOrigin }
  from 'cesium';
import { assetPinMarker } from '../assetIdMarker.js';
import { incidentVisual } from '../assetExplorer/incidentTypes.js';

/** Smaller than a register marker: these are context for the case, not the subject of the map. */
const SIZE = 0.78;

const BILLBOARD = Object.freeze({
  verticalOrigin: VerticalOrigin.BOTTOM,
  heightReference: HeightReference.CLAMP_TO_GROUND,
  disableDepthTestDistance: Number.POSITIVE_INFINITY,
  scaleByDistance: new NearFarScalar(400, 1, 12000, 0.7),
});

/**
 * Several incidents share one nominal coordinate in the register — "0 m away" is common — so
 * identical pins would stack into one and the map would under-report what the list counts.
 * Fanned by index, in pixels, which keeps them readable at every zoom.
 */
const FAN_RADIUS_PX = 22;
export function offsetFor(index, total) {
  if (total <= 1) return Cartesian2.ZERO;
  // Grows with the crowd: six incidents on one coordinate need a wider arc than two, or the pins
  // merge back into a single blob and the map under-reports what the list counts.
  const radius = FAN_RADIUS_PX * (1 + Math.min(total, 12) / 6);
  /*
   * A DOME, not a folded circle.
   *
   * The first version swept a full circle and then took `-Math.abs(sin)` to keep every pin above
   * the point — which mirrored the lower half onto the upper one, so index 1 and index 3 of eight
   * landed on exactly the same pixel. Spreading across a half-turn instead keeps them above the
   * coordinate (these markers hang from their bottom edge) and gives each one its own place.
   */
  const angle = Math.PI * ((index + 0.5) / total);
  return new Cartesian2(-Math.cos(angle) * radius, -Math.sin(angle) * radius - 6);
}

/** Two coordinates are "the same place" when they round to the same five decimals (~1 m). */
const keyOf = (longitude, latitude) => `${longitude.toFixed(5)},${latitude.toFixed(5)}`;

export function installCrashHistoryLayer(viewer) {
  const source = new CustomDataSource('ACS Accident History');
  const added = viewer.dataSources.add(source);
  let disposed = false;

  /**
   * Draw this set, replacing whatever was drawn before.
   *
   * @param {object[]} records shaped by `nearbyCrashes.crashesNear`
   */
  function show(records = [], { anchor = null } = {}) {
    if (disposed) return 0;
    source.entities.removeAll();
    /*
     * THE CASE'S OWN MARKER OCCUPIES A SLOT.
     *
     * A history pin at the same nominal coordinate as the case is the common situation, not the
     * rare one — the register reuses coordinates, which is why so many read "0 m away". With one
     * such incident the fan had nothing to fan (total of 1), so the pin was drawn dead centre and
     * disappeared behind the case's own marker: the panel said "1 other recorded incident" and
     * the map showed nothing new.
     *
     * The case marker is therefore counted as taking the first slot of its own cluster, and the
     * history pins fan around it. A pin that is NOT on the case's coordinate and has no
     * neighbours still sits exactly where it happened.
     */
    const anchorKey = Number.isFinite(anchor?.longitude) && Number.isFinite(anchor?.latitude)
      ? keyOf(anchor.longitude, anchor.latitude) : null;
    const atPoint = new Map();
    for (const record of records) {
      if (!Number.isFinite(record?.longitude) || !Number.isFinite(record?.latitude)) continue;
      const key = keyOf(record.longitude, record.latitude);
      atPoint.set(key, (atPoint.get(key) ?? 0) + 1);
    }
    const seen = new Map();
    let drawn = 0;
    for (const record of records) {
      if (!Number.isFinite(record?.longitude) || !Number.isFinite(record?.latitude)) continue;
      const key = keyOf(record.longitude, record.latitude);
      const taken = key === anchorKey ? 1 : 0;
      const slots = (atPoint.get(key) ?? 1) + taken;
      const index = (seen.get(key) ?? 0) + taken;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      const visual = incidentVisual(record.type);
      source.entities.add({
        id: `acs-history-${record.id ?? `${key}-${index}`}`,
        position: Cartesian3.fromDegrees(record.longitude, record.latitude),
        billboard: {
          ...BILLBOARD,
          ...assetPinMarker({ color: visual.color, glyph: visual.glyph,
            glyphSvg: visual.glyphSvg ?? null, rotate: visual.rotate ?? 0,
            key: `history:${visual.key}`, size: SIZE }),
          pixelOffset: offsetFor(index, slots),
        },
      });
      drawn += 1;
    }
    viewer.scene?.requestRender?.();
    return drawn;
  }

  function clear() {
    if (disposed) return;
    source.entities.removeAll();
    viewer.scene?.requestRender?.();
  }

  return {
    show,
    clear,
    get count() { return source.entities.values.length; },
    async destroy() {
      if (disposed) return;
      disposed = true;
      source.entities.removeAll();
      try { viewer.dataSources.remove(await added, true); } catch { /* viewer already gone */ }
    },
  };
}
