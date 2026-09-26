/**
 * Pulsing circles at live event locations.
 *
 * Two rings expand outward and fade, in the colour of the severity FL511 reported. The radius grows
 * to take in a camera or a message sign standing within `NEARBY_ASSET_METERS`, so an event the
 * operator can already see through existing infrastructure reads differently from one they cannot.
 *
 * What the circle is NOT: a measured impact area. Nothing in this feed says how far a crash backs
 * traffic up, so the radius is a location cue and the panel says so.
 *
 * Two things this has to get right, both learned the hard way:
 *
 *   The two ellipse axes must agree exactly. Cesium reads `semiMajorAxis` and `semiMinorAxis` in
 *   separate calls, so a radius driven by `performance.now()` can report a smaller major than minor
 *   as the phase wraps — Cesium then throws `semiMajorAxis must be greater than or equal to the
 *   semiMinorAxis` and stops rendering for good. The phase therefore comes from the `time` Cesium
 *   passes in, which is one value per frame, and one shared property feeds both axes.
 *
 *   The scene renders on demand. An animation only advances if something asks for a frame, so this
 *   drives its own loop while it is on screen, and stops the moment it is not.
 */
import {
  CallbackProperty, Cartesian3, Cartographic, ClassificationType, Color, ColorMaterialProperty,
  CustomDataSource, DistanceDisplayCondition, HeightReference, JulianDate,
  ScreenSpaceEventHandler, ScreenSpaceEventType,
} from 'cesium';
import { eventPulseStyle } from './eventPulseModel.js';

/** How long one ring takes to travel from the centre to the full radius. */
const PERIOD_SECONDS = 2.6;
const RINGS = 2;

/**
 * The circle is sized by whichever of two rules is larger at the moment it is drawn.
 *
 *   On screen — so it is big at the corridor overview, where an operator watches from, and does not
 *   swell to fill the view as they close in. A few hundred metres of ground is only a pixel or two
 *   from 13 km up, which is why a purely ground-anchored circle was useless there.
 *
 *   On the ground — never smaller than a real `MIN_GROUND_RADIUS_M` on the map. Once the operator
 *   has flown to an event, the screen rule alone shrank the circle to a dot, which is exactly when
 *   they want to see how close the cameras and signs around it are. The ground rule takes over at
 *   that point and the circle becomes a distance reference they can judge against.
 *
 * At corridor scale the screen rule wins; zoomed in, the ground rule does. Neither is ever below
 * the other, so the circle never disappears.
 */
const MIN_GROUND_RADIUS_M = 100;
/** How the screen rule grows with distance: half size up close, double at corridor scale. */
const SCREEN_NEAR = { distance: 1_500, scale: 0.5 };
const SCREEN_FAR = { distance: 30_000, scale: 2.0 };
/** Pixels at the widest point of the pulse, before that distance scaling. */
const BASE_PIXELS = 34;
/** An event with a camera or a sign beside it gets a wider circle. */
const NEARBY_PIXELS = 22;
/** However close the camera gets, one circle never takes the whole viewport. */
const MAX_PIXELS = 460;
/**
 * Beyond this the ground ring is not drawn: from corridor height a hundred metres is a couple of
 * pixels, and it would only muddy the pulse.
 */
const GROUND_RING_VISIBLE_TO_M = 4_000;

export function installEventPulses(viewer, { liveEvents, cameras, messageSigns }) {
  const source = new CustomDataSource('Live Ops event pulses');
  source.show = false;
  let active = false, disposed = false, frame = 0;
  const added = viewer.dataSources.add(source);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  /** event id -> { style, entities } */
  const records = new Map();

  /** Where the cameras and message signs are, in degrees, for the proximity test. */
  function assets() {
    return [[cameras?.cameraById, 'camera'], [messageSigns?.signById, 'messageSign']]
      .flatMap(([map, type]) => [...(map?.entries() ?? [])].flatMap(([id, entity]) => {
        const position = entity?.position?.getValue(viewer.clock.currentTime);
        if (!position) return [];
        const point = Cartographic.fromCartesian(position);
        return [{ id, type, latitude: point.latitude * 180 / Math.PI, longitude: point.longitude * 180 / Math.PI }];
      }));
  }

  /**
   * How far through its travel a ring is, 0 → 1, from Cesium's own clock.
   *
   * Both axes and the material read this with the same `time`, so they cannot disagree.
   */
  const phaseAt = (time, ring) => {
    if (reducedMotion.matches) return 0.7;   // A steady ring rather than motion.
    const seconds = JulianDate.toDate(time ?? viewer.clock.currentTime).getTime() / 1000;
    return ((seconds / PERIOD_SECONDS) + ring / RINGS) % 1;
  };

  /** How wide this event's pulse gets, in pixels, before the distance scaling. */
  const widthOf = record => BASE_PIXELS + (record.style.nearby.length ? NEARBY_PIXELS : 0);

  /** Metres covered by one pixel at `position`, from the camera's own frustum. */
  function metresPerPixel(position) {
    const distance = Cartesian3.distance(viewer.camera.positionWC, position);
    const height = viewer.scene.drawingBufferHeight || viewer.canvas.height || 1;
    const fovy = viewer.camera.frustum?.fovy ?? (Math.PI / 3);
    return (2 * distance * Math.tan(fovy / 2)) / height;
  }

  /** The screen rule's multiplier, interpolated between the near and far anchors. */
  function screenScale(position) {
    const distance = Cartesian3.distance(viewer.camera.positionWC, position);
    const t = (distance - SCREEN_NEAR.distance) / (SCREEN_FAR.distance - SCREEN_NEAR.distance);
    const clamped = Math.min(1, Math.max(0, t));
    return SCREEN_NEAR.scale + clamped * (SCREEN_FAR.scale - SCREEN_NEAR.scale);
  }

  /**
   * The ring's width in pixels: the larger of the two rules, both carrying the pulse.
   * `pixelSize` is a diameter, so the ground floor is twice the radius.
   */
  function pixelsFor(record, position, travel) {
    const onScreen = widthOf(record) * screenScale(position) * travel;
    const onGround = ((2 * MIN_GROUND_RADIUS_M) / metresPerPixel(position)) * travel;
    return Math.min(MAX_PIXELS, Math.max(2, onScreen, onGround));
  }

  function addRings(record, event) {
    const position = Cartesian3.fromDegrees(event.longitude, event.latitude);

    /**
     * A true 100 m radius on the ground, drawn once and never animated.
     *
     * This is the measuring stick. Once an operator has flown to an event, the pulse is a screen
     * shape and tells them nothing about distance; this ring does — a camera or a sign inside it is
     * within 100 m of the event. It is deliberately static: a constant radius means both ellipse
     * axes are the same number rather than two reads of a moving clock, which is what used to stop
     * Cesium rendering, and the geometry is built once instead of every frame.
     */
    record.entities.push(source.entities.add({
      id: `event-pulse:${event.id}:ground`,
      name: `${MIN_GROUND_RADIUS_M} m from the event`,
      position,
      ellipse: {
        semiMajorAxis: MIN_GROUND_RADIUS_M,
        semiMinorAxis: MIN_GROUND_RADIUS_M,
        classificationType: ClassificationType.BOTH,
        material: new ColorMaterialProperty(
          Color.fromCssColorString(record.style.color).withAlpha(0.13)),
        // Only worth drawing once the operator is close enough for 100 m to mean something.
        distanceDisplayCondition: new DistanceDisplayCondition(0, GROUND_RING_VISIBLE_TO_M),
      },
    }));
    for (let ring = 0; ring < RINGS; ring++) {
      record.entities.push(source.entities.add({
        id: `event-pulse:${event.id}:${ring}`,
        name: 'Event location pulse',
        position,
        point: {
          pixelSize: new CallbackProperty(
            time => pixelsFor(record, position, 0.3 + 0.7 * phaseAt(time, ring)), false),
          color: new CallbackProperty(time => {
            // Brightest as it leaves the centre, then away quickly — that is what reads as motion.
            const remaining = 1 - phaseAt(time, ring);
            const fade = reducedMotion.matches ? 0.28 : 0.55 * remaining * remaining;
            return Color.fromCssColorString(record.style.color).withAlpha(fade);
          }, false),
          outlineColor: new CallbackProperty(time => {
            const remaining = 1 - phaseAt(time, ring);
            return Color.fromCssColorString(record.style.color).withAlpha(reducedMotion.matches ? 0.5 : 0.85 * remaining);
          }, false),
          // The outline is what makes it read as a circle rather than a smudge.
          outlineWidth: 2,
          heightReference: HeightReference.CLAMP_TO_GROUND,
          // Sits on top of the imagery rather than being swallowed by a bridge deck.
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }));
    }
  }

  /** Rebuild from the current feed: add what is new, restyle what changed, drop what has gone. */
  function sync() {
    if (!active || disposed) return;
    const infrastructure = assets();
    const live = new Set();
    for (const event of liveEvents.events ?? []) {
      if (!Number.isFinite(event.latitude) || !Number.isFinite(event.longitude)) continue;
      live.add(event.id);
      let record = records.get(event.id);
      if (!record) {
        record = { style: eventPulseStyle(event, infrastructure), entities: [] };
        records.set(event.id, record);
        addRings(record, event);
      }
      record.style = eventPulseStyle(event, infrastructure);
      const position = Cartesian3.fromDegrees(event.longitude, event.latitude);
      for (const entity of record.entities) entity.position = position;
    }
    for (const [id, record] of records) {
      if (live.has(id)) continue;
      for (const entity of record.entities) source.entities.remove(entity);
      records.delete(id);
    }
    applyVisibility();
    viewer.scene.requestRender();
  }

  /**
   * A pulse is shown only while its own event's marker is. Switching the Closures layer off takes
   * its circles with it, and selecting one event never hides another's.
   */
  function applyVisibility() {
    for (const [id, record] of records) {
      const marker = liveEvents.entityById?.get(id);
      const show = Boolean(marker?.show);
      for (const entity of record.entities) entity.show = show;
    }
  }

  /**
   * The scene only draws when asked. While pulses are on screen this asks once per frame, and stops
   * as soon as the workspace closes, the tab is hidden or there is nothing pulsing.
   */
  function tick() {
    frame = 0;
    if (!active || disposed) return;
    if (!document.hidden && records.size) {
      applyVisibility();
      viewer.scene.requestRender();
    }
    frame = requestAnimationFrame(tick);
  }

  const refresh = setInterval(sync, 5000);
  const unsubscribe = liveEvents.onUpdate?.(sync) ?? (() => {});

  // Clicking a ring selects the event it belongs to, as clicking its marker would.
  const handler = new ScreenSpaceEventHandler(viewer.canvas);
  handler.setInputAction(click => {
    if (!active) return;
    const picked = viewer.scene.pick(click.position)?.id;
    if (!picked) return;
    for (const [id, record] of records) {
      if (record.entities.includes(picked)) { liveEvents.selectById?.(id); return; }
    }
  }, ScreenSpaceEventType.LEFT_CLICK);

  return {
    /** Diagnostics/tests: how many events are pulsing. */
    get count() { return records.size; },
    setActive(on) {
      if (active === on || disposed) return;
      active = on;
      source.show = on;
      if (on) {
        // Message signs load lazily; the proximity test needs their positions.
        void Promise.resolve(messageSigns?.load?.()).catch(() => {}).then(() => { if (active) sync(); });
        sync();
        if (!frame) frame = requestAnimationFrame(tick);
      } else {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
      }
      viewer.scene.requestRender();
    },
    destroy() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      clearInterval(refresh);
      unsubscribe();
      handler.destroy();
      void Promise.resolve(added).then(() => viewer.dataSources.remove(source, true)).catch(() => {});
    },
  };
}
