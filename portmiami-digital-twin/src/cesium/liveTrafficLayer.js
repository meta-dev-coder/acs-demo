/**
 * The Live Traffic layer: FL511 events, cameras and message signs as Cesium billboards.
 *
 * Data arrives already normalised, study-area-filtered and road-associated from this app's own
 * server (/api/portmiami/*); this module never contacts FL511. Imperative and outside React for
 * the same reason the road and building layers are: a refresh diffs by FL511 id and touches the
 * entities that changed, rather than re-rendering a tree of several hundred markers.
 *
 * It registers with the ONE shared pick dispatcher (src/cesium/mapPicking.js) under three kinds,
 * so a camera click cannot clear a road selection and a road click cannot clear a camera. There is
 * no second selection engine and no second details popup — App owns the selection, as it already
 * did for roads and buildings.
 *
 * Height: the same fixed offset story as the road layer. The globe is hidden, so `clampToGround`
 * has nothing to clamp to; pins are placed at a fixed height above the ellipsoid and given
 * `disableDepthTestDistance` so a marker behind a cruise terminal is still visible and still
 * clickable — which, unlike the road outlines, billboards CAN be made to be.
 *
 * Visualisation only. A live event has no effect on anything else in this twin.
 */
import {
  BoundingSphere, Cartesian3, Color, CustomDataSource, HeadingPitchRange, NearFarScalar,
  PolylineDashMaterialProperty, VerticalOrigin,
} from 'cesium';
import { TRAFFIC_ICONS, TRAFFIC_RENDER } from '../config/liveTraffic.js';

const { pinHeightM, heightOffsetM, pin, scale, scaleByDistance, connector } = TRAFFIC_RENDER;

/**
 * The icon as a Cesium billboard: a rounded badge in the icon's own colour with the glyph in
 * white, on the pin shape ACS uses, so the two twins' markers are the same family.
 * Rasterised at 4x so it stays sharp when the camera is close.
 */
function pinDataUrl(icon) {
  // White glyph parts have to become the badge colour to stay visible on a coloured badge —
  // the bar of an exclamation mark, a cone's stripe. ACS learned this the same way.
  const glyph = icon.glyph.replaceAll('fill="#fff"', `fill="${icon.color}"`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="176" height="208" viewBox="0 0 44 52">
<path d="M17 40 22 49 27 40" fill="${icon.color}" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/>
<rect x="2" y="2" width="40" height="40" rx="12" fill="#fff"/>
<rect x="4" y="4" width="36" height="36" rx="10" fill="${icon.color}"/>
<g transform="translate(10 10)" fill="#fff">${glyph}</g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** One data URL per icon, built once. */
const PINS = Object.fromEntries(Object.entries(TRAFFIC_ICONS).map(([key, icon]) => [key, pinDataUrl(icon)]));

const DISTANCE = new NearFarScalar(
  scaleByDistance.near, scaleByDistance.nearValue, scaleByDistance.far, scaleByDistance.farValue);

/** Entity id prefixes, one per pickable kind. */
const PREFIX = Object.freeze({ event: 'traffic-event-', camera: 'traffic-camera-', sign: 'traffic-sign-' });

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{picker?: ReturnType<import('./mapPicking.js').createMapPicker>}} [hooks]
 */
export function installLiveTrafficLayer(viewer, { picker } = {}) {
  const source = new CustomDataSource('portmiami-live-traffic');
  viewer.dataSources.add(source);

  /** kind -> Map<id, {entity, connector?, record}> */
  const byKind = { event: new Map(), camera: new Map(), sign: new Map() };
  /** Which layer keys are switched on. Everything starts off. */
  const visible = Object.fromEntries(Object.keys(TRAFFIC_ICONS).map(key => [key, false]));
  let selected = null;   // {kind, id}
  let hovered = null;    // {kind, id}

  /** The icon key a record is drawn with: its event type, or its kind. */
  const iconKeyOf = (kind, record) => (kind === 'event' ? record.type
    : kind === 'camera' ? 'CAMERA' : 'MESSAGE_SIGN');

  const isShown = (kind, record) => visible[iconKeyOf(kind, record)] === true;

  function paint(kind, id) {
    const held = byKind[kind].get(id);
    if (!held) return;
    const isSelected = selected?.kind === kind && selected.id === id;
    const isHovered = !isSelected && hovered?.kind === kind && hovered.id === id;
    held.entity.billboard.scale = isSelected ? scale.selected : isHovered ? scale.hovered : scale.resting;
    // Every entity this record owns, not just its pin: the connector and its far-end marker are
    // created while the layer is still off, so paint is the only thing that can ever reveal them.
    const shown = isShown(kind, held.record);
    held.entity.show = shown;
    if (held.connector) held.connector.show = shown;
    if (held.end) held.end.show = shown;
  }

  /** Add or replace one record's entities. */
  function put(kind, record) {
    remove(kind, record.id);
    const iconKey = iconKeyOf(kind, record);
    const icon = TRAFFIC_ICONS[iconKey];
    if (!icon) return;
    const entity = source.entities.add({
      id: `${PREFIX[kind]}${record.id}`,
      position: Cartesian3.fromDegrees(record.longitude, record.latitude, pinHeightM),
      billboard: {
        image: PINS[iconKey],
        // Explicit, because the image is authored at 4x: without these the billboard would take
        // the source's natural 176x208. See TRAFFIC_RENDER.pin.
        width: pin.width,
        height: pin.height,
        scale: scale.resting,
        verticalOrigin: VerticalOrigin.BOTTOM,
        scaleByDistance: DISTANCE,
        // Visible AND pickable through the photorealistic mesh. Unlike a polyline's
        // depthFailMaterial, this keeps the marker clickable where the mesh is in front of it.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      show: isShown(kind, record),
    });

    /**
     * A two-point event gets a DASHED connector between its published anchors.
     *
     * Dashed, and in its own pale colour, because a solid line would read as "this stretch of road
     * is closed". It is not: FL511 published two points and no path between them, so the line is a
     * straight line between two anchors and nothing more. The details panel says so in words.
     */
    let span = null, end = null;
    if (record.secondaryLongitude != null) {
      span = source.entities.add({
        id: `${PREFIX[kind]}${record.id}-span`,
        polyline: {
          positions: Cartesian3.fromDegreesArrayHeights([
            record.longitude, record.latitude, heightOffsetM,
            record.secondaryLongitude, record.secondaryLatitude, heightOffsetM,
          ]),
          width: connector.width,
          material: new PolylineDashMaterialProperty({
            color: Color.fromCssColorString(connector.color), dashLength: connector.dashLength,
          }),
          depthFailMaterial: new PolylineDashMaterialProperty({
            color: Color.fromCssColorString(connector.color).withAlpha(0.3), dashLength: connector.dashLength,
          }),
        },
        show: isShown(kind, record),
      });
      end = source.entities.add({
        id: `${PREFIX[kind]}${record.id}-end`,
        position: Cartesian3.fromDegrees(record.secondaryLongitude, record.secondaryLatitude, pinHeightM),
        point: {
          pixelSize: 9,
          color: Color.fromCssColorString(connector.color),
          outlineColor: Color.WHITE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        show: isShown(kind, record),
      });
    }
    byKind[kind].set(record.id, { entity, connector: span, end, record });
  }

  function remove(kind, id) {
    if (!byKind[kind].has(id)) return;
    for (const suffix of ['', '-span', '-end']) {
      const entity = source.entities.getById(`${PREFIX[kind]}${id}${suffix}`);
      if (entity) source.entities.remove(entity);
    }
    byKind[kind].delete(id);
  }

  /** Replace a kind's whole set, keeping unchanged entities in place. */
  function setRecords(kind, records) {
    const next = new Map((records ?? []).map(record => [record.id, record]));
    for (const id of [...byKind[kind].keys()]) if (!next.has(id)) remove(kind, id);
    for (const record of next.values()) {
      const held = byKind[kind].get(record.id);
      // Position and icon are all the entity itself carries; anything else lives in React's copy.
      const moved = !held || held.record.latitude !== record.latitude
        || held.record.longitude !== record.longitude
        || held.record.secondaryLongitude !== record.secondaryLongitude
        || iconKeyOf(kind, held.record) !== iconKeyOf(kind, record);
      if (moved) put(kind, record);
      else held.record = record;
    }
    for (const id of byKind[kind].keys()) paint(kind, id);
    viewer.scene.requestRender();
  }

  /** One registration per kind, so the dispatcher routes each click to the right owner. */
  const unregister = Object.entries(PREFIX).map(([kind, prefix]) => picker?.register({
    kind: `traffic-${kind}`,
    idPrefix: prefix,
    parseId: entityId => {
      // The -span and -end helpers are decoration; a click on one selects nothing.
      if (entityId.endsWith('-span') || entityId.endsWith('-end')) return null;
      const id = entityId.slice(prefix.length);
      return byKind[kind].has(id) ? id : null;
    },
    isPickable: () => source.show && [...byKind[kind].values()].some(held => held.entity.show),
    setHovered(id) {
      const was = hovered;
      hovered = id == null ? null : { kind, id };
      if (was) paint(was.kind, was.id);
      if (hovered) paint(hovered.kind, hovered.id);
    },
  })).filter(Boolean);

  return {
    setEvents: records => setRecords('event', records),
    setCameras: records => setRecords('camera', records),
    setMessageSigns: records => setRecords('sign', records),

    /** Switch one icon key's markers on or off. Independent of every other key. */
    setLayerVisible(key, isVisible) {
      if (!(key in visible) || visible[key] === isVisible) return;
      visible[key] = isVisible;
      for (const kind of Object.keys(byKind)) for (const id of byKind[kind].keys()) paint(kind, id);
      if (!isVisible) viewer.scene.canvas.style.cursor = '';
      viewer.scene.requestRender();
    },
    isLayerVisible: key => visible[key] === true,

    /** Highlight one marker. Never moves the camera; flying is `flyTo`, a separate action. */
    select(hit) {
      const was = selected;
      selected = hit && byKind[hit.kind]?.has(hit.id) ? { ...hit } : null;
      if (was) paint(was.kind, was.id);
      if (selected) paint(selected.kind, selected.id);
      viewer.scene.requestRender();
    },

    /** Frame one marker, looking down so the camera never ends up inside the mesh. */
    flyTo(kind, id, { duration = 1.4 } = {}) {
      const held = byKind[kind]?.get(id);
      if (!held || viewer.isDestroyed()) return;
      const { latitude, longitude } = held.record;
      viewer.camera.cancelFlight();
      viewer.camera.flyToBoundingSphere(
        new BoundingSphere(Cartesian3.fromDegrees(longitude, latitude, 0), 150),
        { duration, offset: new HeadingPitchRange(0, -Math.PI / 3.4, 420) });
    },

    destroy() {
      for (const off of unregister) off();
      if (!viewer.isDestroyed()) viewer.dataSources.remove(source, true);
      for (const map of Object.values(byKind)) map.clear();
    },
  };
}
