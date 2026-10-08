/**
 * The simulated patrols on the map.
 *
 * Owns its OWN Cesium data source, separate from the TMC's. That is deliberate: the TMC's source is
 * cleared and rebuilt on every draw, and patrols must be able to appear and disappear on their own
 * toggle without forcing the investigation to redraw — and, more importantly, must be removable in
 * one call so no simulated vehicle can survive a date change, an incident change or leaving the
 * screen.
 *
 * Everything drawn here is prefixed `patrol:` so an orphan is findable. The simulated-data
 * disclosure is NOT repeated here: it sits in the Response tab beside the control that enables
 * these markers, and in the workspace's single map chip. Two floating disclaimers over one
 * incident is noise, and the one over the incident covered its own callout.
 *
 * Entities are updated in place where they already exist, so panning around a scenario does not
 * rebuild five billboards every frame.
 */
import {
  Cartesian2, Cartesian3, Color, ColorMaterialProperty, CustomDataSource, DistanceDisplayCondition,
  PolylineArrowMaterialProperty, VerticalOrigin,
} from 'cesium';
import { patrolMarker, mapChip } from '../tmcMapMarkers.js';
import { PATROL_STATUS_COLORS, PATROL_STATUS_LABELS } from './patrolConfig.js';

const ID = Object.freeze({
  prefix: 'patrol:',
  marker: id => `patrol:unit:${id}`,
  label: id => `patrol:label:${id}`,
  route: 'patrol:route',
});

/** Labels only once the camera is close enough that five of them do not become a wall of text. */
const LABEL_RANGE = new DistanceDisplayCondition(0, 14_000);

/**
 * Install the layer.
 *
 * @param {object} viewer                      the Cesium viewer, or null in a test
 * @returns {{render, clear, destroy, patrolAt, dataSource}}
 */
export function createPatrolMapLayer(viewer) {
  const source = new CustomDataSource('TMC simulated patrols');
  viewer?.dataSources?.add(source);
  /** Entity id → patrol id, so a click can be resolved without searching the fleet. */
  const byEntity = new Map();
  let shown = false;

  /** Everything this layer has drawn, gone. Called on every state change that invalidates it. */
  function clear() {
    source.entities.removeAll();
    byEntity.clear();
    shown = false;
    viewer?.scene?.requestRender?.();
  }

  /**
   * Draw a fleet.
   *
   * @param {{patrols: object[], selectedPatrolId: string|null, route: object|null,
   *          incident: object|null}} state
   */
  function render({ patrols = [], selectedPatrolId = null, route = null, incident = null } = {}) {
    if (!viewer) return;
    // A fleet with nothing in it is not a fleet: take the banner down with the vehicles.
    if (!patrols.length) { clear(); return; }

    const wanted = new Set();

    for (const patrol of patrols) {
      if (!Number.isFinite(patrol.longitude) || !Number.isFinite(patrol.latitude)) continue;
      const selected = patrol.id === selectedPatrolId;
      const marker = patrolMarker({
        status: patrol.status,
        color: PATROL_STATUS_COLORS[patrol.status] ?? PATROL_STATUS_COLORS.OUT_OF_SERVICE,
        selected,
        simulated: true,
      });
      const position = Cartesian3.fromDegrees(patrol.longitude, patrol.latitude);
      const markerId = ID.marker(patrol.id);
      wanted.add(markerId);
      // Updated in place when it already exists: a pan must not rebuild the fleet.
      const existing = source.entities.getById(markerId);
      if (existing) {
        existing.position = position;
        existing.billboard.image = marker.image;
        existing.billboard.width = marker.width;
        existing.billboard.height = marker.height;
      } else {
        source.entities.add({
          id: markerId,
          name: `${patrol.id} · SIMULATED · ${PATROL_STATUS_LABELS[patrol.status] ?? patrol.status}`,
          position,
          billboard: {
            image: marker.image, width: marker.width, height: marker.height,
            verticalOrigin: VerticalOrigin.BOTTOM,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      }
      byEntity.set(markerId, patrol.id);

      // The unit's own id, small, close in only.
      const labelId = ID.label(patrol.id);
      wanted.add(labelId);
      const chip = mapChip(patrol.id);
      const label = source.entities.getById(labelId);
      if (label) {
        label.position = position;
        label.billboard.image = chip.image;
      } else {
        source.entities.add({
          id: labelId,
          name: `${patrol.id} · SIMULATED`,
          position,
          billboard: {
            image: chip.image, width: chip.width, height: chip.height,
            verticalOrigin: VerticalOrigin.BOTTOM,
            pixelOffset: new Cartesian2(0, -30),
            distanceDisplayCondition: LABEL_RANGE,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      }
      byEntity.set(labelId, patrol.id);
    }

    // The route, only when one was actually resolved. A straight line is never drawn: the path
    // comes from the corridor centerline, so it follows the road or it does not appear.
    if (route?.resolved && route.path?.length > 1) {
      wanted.add(ID.route);
      const positions = route.path.map(point => Cartesian3.fromDegrees(point.lon, point.lat, 4));
      const existing = source.entities.getById(ID.route);
      if (existing) existing.polyline.positions = positions;
      else {
        source.entities.add({
          id: ID.route,
          name: 'Simulated patrol route — along corridor centerline, approximate',
          polyline: {
            positions,
            // Lifted, not clamped: a ground-clamped line is a classification primitive and the
            // road layer paints over it.
            clampToGround: false,
            width: 9,
            material: new PolylineArrowMaterialProperty(Color.fromCssColorString('#3b82f6').withAlpha(0.85)),
          },
        });
      }
    }

    // No banner here. The Response tab states that the patrols are simulated, directly above the
    // control that put them on the map, and a second floating label over the incident only
    // competed with the incident's own callout. The disclosure lives in the panel and in the one
    // consolidated map chip the workspace owns — not on a billboard of its own.

    // Anything from a previous fleet that this one does not want.
    for (const entity of [...source.entities.values]) {
      if (!wanted.has(String(entity.id))) {
        byEntity.delete(String(entity.id));
        source.entities.remove(entity);
      }
    }
    shown = true;
    viewer.scene?.requestRender?.();
  }

  return Object.freeze({
    dataSource: source,
    render,
    clear,
    get visible() { return shown; },
    /** Which patrol a picked entity belongs to, or null. */
    patrolAt: entityId => byEntity.get(String(entityId)) ?? null,
    destroy() {
      clear();
      viewer?.dataSources?.remove(source, true);
    },
  });
}

export const PATROL_ENTITY_IDS = ID;
