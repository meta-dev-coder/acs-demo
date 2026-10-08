/**
 * The upstream approach on the map: the resolved road, its warning resources, and — only when an
 * operator explicitly asks for it — a hypothetical queue.
 *
 * Its own data source, so the whole thing is removable in one call and cannot survive an incident
 * change, a date change or leaving the screen.
 *
 * The visual grammar is the point. An observed thing and a hypothetical thing must not look alike:
 *
 *   resolved upstream road   solid blue       drawn from the corridor's own section geometry
 *   simulated queue          dashed amber     drawn ONLY when the operator enables the scenario
 *   warning resources        existing markers position only, never an activation claim
 *
 * Nothing is drawn when the approach is unresolved. A queue with no known direction has nowhere
 * honest to go, and drawing one "approximately" is the failure this layer exists to avoid.
 */
import {
  Cartesian2, Cartesian3, Color, ColorMaterialProperty, CustomDataSource, DistanceDisplayCondition,
  PolylineDashMaterialProperty, VerticalOrigin,
} from 'cesium';
import { approachArrow, mapChip, queueTailMarker } from '../tmcMapMarkers.js';

const ID = Object.freeze({
  upstream: index => `upstream:section:${index}`,
  arrow: key => `upstream:arrow:${key}`,
  queue: 'upstream:queue',
  tail: 'upstream:queue-tail',
  tailLabel: 'upstream:queue-tail-label',
});

/** The tail's own label, close in only — at corridor zoom the marker alone carries it. */
const TAIL_LABEL_RANGE = new DistanceDisplayCondition(0, 20_000);

/** Every nth vertex gets an arrow, so direction reads without becoming a dotted line. */
const ARROW_EVERY = 6;

/** The local bearing at a vertex, in radians, for pointing an arrow along the road. */
function bearingAt(path, index) {
  const a = path[Math.max(0, index - 1)];
  const b = path[Math.min(path.length - 1, index + 1)];
  const lonA = a.lon ?? a.longitude, latA = a.lat ?? a.latitude;
  const lonB = b.lon ?? b.longitude, latB = b.lat ?? b.latitude;
  // Screen rotation is counter-clockwise from east, which is what atan2(dLat, dLon) gives.
  return Math.atan2(latB - latA, (lonB - lonA) * Math.cos((latA + latB) / 2 * Math.PI / 180));
}

/** Lifted off the ground: a clamped polyline is a classification primitive the road layer overpaints. */
const lift = (positions, metres) => positions.map(point =>
  Cartesian3.fromDegrees(point.lon ?? point.longitude, point.lat ?? point.latitude, metres));

export function createUpstreamProtectionMapLayer(viewer) {
  const source = new CustomDataSource('TMC upstream protection');
  viewer?.dataSources?.add(source);

  function clear() {
    source.entities.removeAll();
    viewer?.scene?.requestRender?.();
  }

  /**
   * Draw the approach.
   *
   * @param {{sectionPaths: object[][], queuePath: object[]|null, queueSimulated: boolean}} state
   *   `sectionPaths` are the resolved upstream sections' real geometry; `queuePath` is a slice of
   *   the corridor centerline and is only ever passed when the operator enabled the scenario.
   */
  function render({
    sectionPaths = [], queuePath = null, queueSimulated = false, tail = null, emphasis = null,
  } = {}) {
    if (!viewer) return;
    if (!sectionPaths.length && !queuePath && !tail) { clear(); return; }
    /**
     * Incremental, not clear-and-rebuild.
     *
     * This used to wipe the whole data source and re-add everything on every call. During queue
     * playback that destroyed and recreated the upstream road lines and their direction arrows
     * once a second — the operator saw the road colouring flicker, even though only the queue was
     * meant to be moving. Now each entity is updated in place and only genuinely stale ones are
     * removed at the end.
     */
    const wanted = new Set();
    /** Add, or update what is already there. Cesium keeps the entity; only its geometry moves. */
    const put = (id, build, update) => {
      wanted.add(id);
      const existing = source.entities.getById(id);
      if (existing) { update?.(existing); return existing; }
      return source.entities.add({ id, ...build() });
    };

    sectionPaths.forEach((path, index) => {
      if (!path || path.length < 2) return;
      /**
       * A dark casing under the blue, so the approach reads over photoreal imagery.
       *
       * Google's tiles range from near-white concrete to dark water, and a single translucent blue
       * line disappeared against the pale ones. A casing gives the line its own edge whatever is
       * underneath, which is how road cartography has always handled this — no glow required.
       */
      const lead = emphasis === 'upstream';
      const casingWidth = lead ? 18 : 13;
      const lineWidth = lead ? 12 : 8;
      const lineColor = Color.fromCssColorString('#4c9bff').withAlpha(lead ? 0.95 : 0.6);
      put(`${ID.upstream(index)}:casing`, () => ({
        name: 'Resolved upstream approach',
        polyline: {
          positions: lift(path, 2.6),
          clampToGround: false,
          width: casingWidth,
          material: new ColorMaterialProperty(Color.fromCssColorString('#0b1220').withAlpha(0.72)),
        },
      }), entity => { entity.polyline.width = casingWidth; });
      put(ID.upstream(index), () => ({
        name: 'Resolved upstream approach',
        polyline: {
          positions: lift(path, 3),
          clampToGround: false,
          // Dimmed when something else is the subject, so one thing leads at a time.
          width: lineWidth,
          material: new ColorMaterialProperty(lineColor),
        },
      }), entity => {
        entity.polyline.width = lineWidth;
        entity.polyline.material = new ColorMaterialProperty(lineColor);
      });
      // Which way the traffic is coming, said repeatedly along the line rather than once.
      const arrow = approachArrow({ size: emphasis === 'upstream' ? 18 : 14 });
      for (let i = ARROW_EVERY; i < path.length - 1; i += ARROW_EVERY) {
        const point = path[i];
        put(ID.arrow(`${index}:${i}`), () => ({
          name: 'Direction of approaching traffic',
          position: Cartesian3.fromDegrees(point.lon ?? point.longitude, point.lat ?? point.latitude, 4),
          billboard: {
            image: arrow.image, width: arrow.width, height: arrow.height,
            // Rotated to the local bearing by the caller's own geometry order.
            rotation: bearingAt(path, i),
            alignedAxis: Cartesian3.ZERO,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            distanceDisplayCondition: new DistanceDisplayCondition(0, 30_000),
          },
        }), entity => {
          entity.billboard.image = arrow.image;
          entity.billboard.width = arrow.width;
          entity.billboard.height = arrow.height;
        });
      }
    });

    // Dashed and amber, and only ever labelled as a scenario. It is drawn along the same corridor
    // geometry as the road above it, so it cannot wander onto an unrelated road.
    if (queuePath && queuePath.length > 1 && queueSimulated) {
      const positions = lift(queuePath, 6);
      const queueWidth = emphasis === 'queue' ? 16 : 12;
      put(ID.queue, () => ({
        name: 'SIMULATED queue scenario — hypothetical, no queue observations are published',
        polyline: {
          positions,
          clampToGround: false,
          width: queueWidth,
          material: new PolylineDashMaterialProperty({
            color: Color.fromCssColorString('#F5B51B').withAlpha(emphasis === 'queue' ? 0.85 : 0.6),
            dashLength: 18,
          }),
        },
      }), entity => { entity.polyline.positions = positions; entity.polyline.width = queueWidth; });
    }

    /**
     * The tail: the single most operationally useful point on this map after the incident itself.
     *
     * Drawn as its own marker with its own distance and elapsed time, because "how far back is the
     * traffic stopped" is the question the queue band only implies.
     */
    if (tail && queueSimulated) {
      const marker = queueTailMarker({ selected: emphasis === 'queue' });
      const position = Cartesian3.fromDegrees(tail.longitude, tail.latitude);
      const tailName = `SIMULATED queue tail · ${tail.upstreamKm} km upstream`
        + (Number.isFinite(tail.elapsedMinutes) ? ` · +${tail.elapsedMinutes} min after the incident` : '');
      put(ID.tail, () => ({
        name: tailName,
        position,
        billboard: {
          image: marker.image, width: marker.width, height: marker.height,
          verticalOrigin: VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }), entity => { entity.position = position; entity.name = tailName; entity.billboard.image = marker.image; });
      // "SIMULATED" in the title, not only in a legend: this marker is the one most likely to be
      // screenshotted on its own and mistaken for an observation.
      const chip = mapChip('QUEUE TAIL · SIMULATED', {
        tone: '#F5B51B',
        sub: `${tail.upstreamKm} km upstream`
          + (Number.isFinite(tail.elapsedMinutes) ? ` · +${tail.elapsedMinutes} min` : ''),
      });
      put(ID.tailLabel, () => ({
        name: 'SIMULATED queue tail',
        position,
        billboard: {
          image: chip.image, width: chip.width, height: chip.height,
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: new Cartesian2(0, -56),
          distanceDisplayCondition: TAIL_LABEL_RANGE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }), entity => {
        entity.position = position;
        entity.billboard.image = chip.image;
        entity.billboard.width = chip.width;
        entity.billboard.height = chip.height;
      });
    }

    // Only what this draw no longer wants.
    for (const entity of [...source.entities.values]) {
      if (!wanted.has(String(entity.id))) source.entities.remove(entity);
    }
    viewer.scene?.requestRender?.();
  }

  return Object.freeze({
    dataSource: source,
    render,
    clear,
    destroy() { clear(); viewer?.dataSources?.remove(source, true); },
  });
}

export const UPSTREAM_ENTITY_IDS = ID;
