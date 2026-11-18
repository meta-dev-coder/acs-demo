/**
 * Picking a road on the map, marking a section of it, and previewing the proposed widening.
 *
 * HOW A ROAD IS PICKED. Not by entity picking. The baseline road layer may be switched off, and
 * several centrelines overlap at junctions, so clicking an entity would select whichever happened
 * to be drawn on top. Instead the click is resolved to a ground position and every centreline
 * within a radius is ranked by its true perpendicular distance — the same measure maths the
 * section editor uses. The nearest is selected and the rest are returned as candidates, so an
 * ambiguous junction offers a list rather than guessing.
 *
 * THE BASELINE IS NEVER TOUCHED. This layer draws its own entities in its own source: the
 * selected centreline, the marked section, and the proposed corridor. The county road layer is
 * read for geometry and never modified, hidden or re-drawn by anything here.
 *
 * ELEVATION. The preview sits at one stated reference elevation lifted clear of the mesh. The
 * road file publishes none, so nothing here claims vertical accuracy — the panel says the surface
 * is an indicative visualisation.
 */
import {
  Cartesian2, Cartesian3, Cartographic, Color, CustomDataSource, HeadingPitchRange,
  HorizontalOrigin, LabelStyle, Math as CMath, PolygonHierarchy, ScreenSpaceEventHandler,
  ScreenSpaceEventType, VerticalOrigin,
} from 'cesium';
import { lonLatToEnu } from '../scenarios/garagePlacement.js';
import { nearestMeasureTo, sectionBetweenMeasures, wideningCorridor } from '../designs/roadWidening.js';
import { roadCorridorRing } from '../designs/roadCorridor.js';

export const WIDENING_STYLE = Object.freeze({
  existing: '#657184',      // the published centreline: muted, always visible
  selected: '#1769E0',      // the road under edit
  proposed: '#FFB300',      // the proposed surface and its boundary: the studio's widening amber
  section: '#00BFEA',       // the marked portion
  conflict: '#C73E3E',
  label: '#071B35',
});

/** Where the preview sits. The road file publishes no elevation; see the file header. */
export const PREVIEW_ELEVATION_M = -24.2;

/** The furthest a dragged vertex may move from where it was; see `onMove`. */
export const MAX_DRAG_STEP_M = 300;

/** How far from a click a centreline can be and still be a candidate. */
export const PICK_RADIUS_M = 60;

const css = (hex, alpha = 1) => Color.fromCssColorString(hex).withAlpha(alpha);
const hierarchyAt = (ring, height) => new PolygonHierarchy(
  Cartesian3.fromDegreesArrayHeights(ring.flatMap(([lon, lat]) => [lon, lat, height])));

export function installRoadWideningLayer(viewer, { roadsById, onPick, onState } = {}) {
  const source = new CustomDataSource('portmiami-road-widening');
  viewer.dataSources.add(source);
  let handler = null;
  let mode = null;              // 'ROAD' | 'START' | 'END' | 'DRAW'
  let preview = null;           // { road, startM, endM, totalWidthM, side, baselineWidthM }
  let drawing = null;           // { points, widthM } while a new alignment is being drawn
  let bounds = null;

  function track(points) {
    for (const [lon, lat] of points) {
      if (!bounds) bounds = { west: lon, east: lon, south: lat, north: lat };
      else {
        bounds.west = Math.min(bounds.west, lon); bounds.east = Math.max(bounds.east, lon);
        bounds.south = Math.min(bounds.south, lat); bounds.north = Math.max(bounds.north, lat);
      }
    }
  }

  /** The ground position under a click, as [lon, lat]. */
  function groundAt(screenPosition) {
    const scene = viewer.scene;
    let cartesian = scene.pickPositionSupported ? scene.pickPosition(screenPosition) : undefined;
    if (!cartesian || !Number.isFinite(cartesian.x)) {
      cartesian = viewer.camera.pickEllipsoid(screenPosition, scene.globe?.ellipsoid);
    }
    if (!cartesian || !Number.isFinite(cartesian.x)) return null;
    const carto = Cartographic.fromCartesian(cartesian);
    if (!carto || !Number.isFinite(carto.longitude)) return null;
    return [CMath.toDegrees(carto.longitude), CMath.toDegrees(carto.latitude)];
  }

  /**
   * Every centreline near a point, nearest first.
   *
   * Ranked by true perpendicular distance rather than by distance to a vertex: a long straight
   * segment's nearest vertex can be hundreds of metres from the click.
   */
  function candidatesAt(point) {
    const found = [];
    for (const road of roadsById?.values() ?? []) {
      const coordinates = road.coordinates ?? [];
      if (coordinates.length < 2) continue;
      // Cheap reject on the bounding box before the exact test.
      const { west, east, south, north } = road.bounds ?? {};
      if (Number.isFinite(west)) {
        const pad = 0.001;
        if (point[0] < west - pad || point[0] > east + pad
          || point[1] < south - pad || point[1] > north + pad) continue;
      }
      const { measureM, distanceM } = nearestMeasureTo(coordinates, point);
      if (distanceM === null || distanceM > PICK_RADIUS_M) continue;
      found.push({ road, measureM, distanceM });
    }
    return found.sort((a, b) => a.distanceM - b.distanceM).slice(0, 6);
  }

  function onClick(movement) {
    const point = groundAt(movement.position);
    if (!point) { onState?.('Nothing to pick there — try a point on the ground.'); return; }
    if (mode === 'ROAD') {
      const candidates = candidatesAt(point);
      if (candidates.length === 0) {
        onState?.(`No road centreline within ${PICK_RADIUS_M} m of that point.`);
        return;
      }
      onPick?.({ kind: 'ROAD', candidates, point });
      return;
    }
    if (mode === 'DRAW') {
      // Each click adds a vertex. The alignment is previewed as it grows, so the corridor the
      // user will get is the thing they are looking at while they draw it.
      drawing = { ...drawing, points: [...(drawing?.points ?? []), point] };
      redraw();
      onPick?.({ kind: 'DRAW', points: drawing.points, point });
      return;
    }
    // Marking a section: the click is snapped onto the SELECTED road, not re-picked.
    if ((mode === 'START' || mode === 'END') && preview?.road) {
      const { measureM, distanceM } = nearestMeasureTo(preview.road.coordinates, point);
      onPick?.({ kind: mode, measureM, distanceM, point });
    }
  }

  // ---- vertex editing ------------------------------------------------------------------------
  /**
   * EDIT mode: drag a vertex to move it, drag a midpoint handle to insert one, click a vertex to
   * select it for removal. The camera is frozen only while a drag is in progress and restored on
   * release, however the drag ends. Locked ends (a realignment's tie-ins) can be selected but
   * not moved, so the proposal stays tied into the road it replaces.
   */
  let dragging = null;          // index of the vertex being dragged
  const cameraInputs = enabled => {
    if (!viewer.isDestroyed()) viewer.scene.screenSpaceCameraController.enableInputs = enabled;
  };
  const isLocked = index => Boolean(drawing?.lockedEnds)
    && (index === 0 || index === (drawing?.points?.length ?? 0) - 1);
  const pickedHandle = position => {
    const id = viewer.scene.pick(position)?.id?.id;
    const match = typeof id === 'string' ? /^draw-(vertex|mid)-(\d+)$/.exec(id) : null;
    return match ? { kind: match[1], index: Number(match[2]) } : null;
  };
  function onDown({ position }) {
    const handle = pickedHandle(position);
    if (!handle || !drawing) return;
    if (handle.kind === 'mid') {
      const points = [...drawing.points];
      const [a, b] = [points[handle.index], points[handle.index + 1]];
      points.splice(handle.index + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      drawing = { ...drawing, points, selected: handle.index + 1 };
      dragging = handle.index + 1;
    } else {
      drawing = { ...drawing, selected: handle.index };
      dragging = isLocked(handle.index) ? null : handle.index;
    }
    if (dragging !== null) cameraInputs(false);
    redraw();
    onPick?.({ kind: 'EDIT', points: drawing.points, selected: drawing.selected });
  }
  function onMove({ endPosition }) {
    if (dragging === null || !drawing) return;
    const point = groundAt(endPosition);
    if (!point) return;
    // A pointer that slides onto the sky or a distant tile reads as a point kilometres away. A
    // vertex never jumps that far in one drag, so such a reading is ignored rather than applied.
    const [de, dn] = lonLatToEnu(drawing.points[dragging], point);
    if (Math.hypot(de, dn) > MAX_DRAG_STEP_M) return;
    const points = drawing.points.map((p, i) => (i === dragging ? point : p));
    drawing = { ...drawing, points };
    redraw();
  }
  function onUp() {
    if (dragging === null) return;
    dragging = null;
    cameraInputs(true);
    onPick?.({ kind: 'EDIT', points: drawing?.points ?? [], selected: drawing?.selected ?? null });
  }

  function arm(next) {
    mode = next;
    if (handler) { handler.destroy(); handler = null; }
    if (dragging !== null) { dragging = null; cameraInputs(true); }
    if (mode === 'EDIT') {
      handler = new ScreenSpaceEventHandler(viewer.canvas);
      handler.setInputAction(onDown, ScreenSpaceEventType.LEFT_DOWN);
      handler.setInputAction(onMove, ScreenSpaceEventType.MOUSE_MOVE);
      handler.setInputAction(onUp, ScreenSpaceEventType.LEFT_UP);
    } else if (mode) {
      handler = new ScreenSpaceEventHandler(viewer.canvas);
      handler.setInputAction(onClick, ScreenSpaceEventType.LEFT_CLICK);
    }
    if (drawing) { drawing = { ...drawing, editing: mode === 'EDIT' }; redraw(); }
    if (!viewer.isDestroyed()) viewer.canvas.style.cursor = mode === 'EDIT' ? 'grab' : mode ? 'crosshair' : '';
    onState?.(mode === 'ROAD' ? 'Click a road on the map.'
      : mode === 'START' ? 'Click where the section starts.'
        : mode === 'END' ? 'Click where the section ends.'
          : mode === 'DRAW' ? 'Click to add points along the new alignment. Finish when done.'
            : mode === 'EDIT' ? 'Drag a vertex to move it, drag a small handle to add one, click a vertex to select it.'
              : null);
  }

  /**
   * The alignment being drawn or edited: its corridor in the operation's colour, the centreline,
   * a handle per vertex and, while editing, a smaller handle at each segment's midpoint.
   */
  function drawNewAlignment() {
    const points = drawing?.points ?? [];
    if (points.length === 0) return;
    const height = PREVIEW_ELEVATION_M;
    const colour = drawing.colour ?? WIDENING_STYLE.section;
    track(points);
    if (points.length >= 2) {
      const ring = roadCorridorRing(points, drawing.widthM);
      if (ring) {
        track(ring);
        source.entities.add({
          id: 'draw-surface',
          polygon: {
            hierarchy: hierarchyAt(ring, height), height,
            material: css(colour, 0.6), outline: false,
          },
        });
        source.entities.add({
          id: 'draw-edge',
          polyline: {
            positions: Cartesian3.fromDegreesArrayHeights(ring.flatMap(([lon, lat]) => [lon, lat, height + 0.2])),
            width: 3, material: css(colour), depthFailMaterial: css(colour, 0.4),
          },
        });
      }
      source.entities.add({
        id: 'draw-alignment',
        polyline: {
          positions: Cartesian3.fromDegreesArrayHeights(
            points.flatMap(([lon, lat]) => [lon, lat, height + 0.8])),
          width: 2.5, material: css('#ffffff', 0.9), depthFailMaterial: css('#ffffff', 0.35),
        },
      });
    }
    points.forEach(([lon, lat], index) => {
      const locked = isLocked(index);
      const selected = drawing.selected === index;
      source.entities.add({
        id: `draw-vertex-${index}`,
        position: Cartesian3.fromDegrees(lon, lat, height + 1),
        point: {
          pixelSize: selected ? 16 : locked ? 14 : 12,
          color: css(locked ? colour : '#ffffff'),
          outlineColor: css(selected ? '#1769E0' : WIDENING_STYLE.label), outlineWidth: selected ? 4 : 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    });
    if (drawing.editing) {
      for (let i = 0; i < points.length - 1; i += 1) {
        const [a, b] = [points[i], points[i + 1]];
        source.entities.add({
          id: `draw-mid-${i}`,
          position: Cartesian3.fromDegrees((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, height + 1),
          point: {
            pixelSize: 8, color: css('#ffffff', 0.75), outlineColor: css(colour), outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      }
    }
  }

  function redraw() {
    source.entities.removeAll();
    bounds = null;
    if (drawing) { drawNewAlignment(); viewer.scene.requestRender(); return; }
    if (!preview?.road) { viewer.scene.requestRender(); return; }
    const { road, startM, endM, totalWidthM, side, baselineWidthM } = preview;
    const height = PREVIEW_ELEVATION_M;

    // The selected road's published centreline, always drawn: the original is never hidden.
    track(road.coordinates);
    source.entities.add({
      id: 'widening-baseline',
      polyline: {
        positions: Cartesian3.fromDegreesArrayHeights(
          road.coordinates.flatMap(([lon, lat]) => [lon, lat, height + 0.4])),
        width: 3, material: css(WIDENING_STYLE.selected),
        depthFailMaterial: css(WIDENING_STYLE.selected, 0.4),
      },
    });

    const section = startM === null || endM === null
      ? null : sectionBetweenMeasures(road.coordinates, startM, endM);
    if (section) {
      source.entities.add({
        id: 'widening-section',
        polyline: {
          positions: Cartesian3.fromDegreesArrayHeights(
            section.coordinates.flatMap(([lon, lat]) => [lon, lat, height + 0.9])),
          width: 7, material: css(WIDENING_STYLE.section, 0.9),
          depthFailMaterial: css(WIDENING_STYLE.section, 0.35),
        },
      });
    }

    const corridor = wideningCorridor({
      coordinates: road.coordinates,
      startM: section ? startM : null,
      endM: section ? endM : null,
      totalWidthM, side, baselineWidthM,
    });
    if (corridor) {
      track(corridor.ring);
      source.entities.add({
        id: 'widening-surface',
        polygon: {
          hierarchy: hierarchyAt(corridor.ring, height), height,
          material: css(WIDENING_STYLE.proposed, 0.62), outline: false,
        },
      });
      source.entities.add({
        id: 'widening-edge',
        polyline: {
          positions: Cartesian3.fromDegreesArrayHeights(
            corridor.ring.flatMap(([lon, lat]) => [lon, lat, height + 0.2])),
          width: 3, material: css(WIDENING_STYLE.proposed),
          depthFailMaterial: css(WIDENING_STYLE.proposed, 0.4),
        },
      });
      const mid = corridor.centreline[Math.floor(corridor.centreline.length / 2)];
      source.entities.add({
        id: 'widening-label',
        position: Cartesian3.fromDegrees(mid[0], mid[1], height + 18),
        label: {
          text: `${road.name || `Road ${road.objectId}`}\nProposed ${totalWidthM} m · `
            + `${section ? `${Math.round(section.lengthM)} m section` : 'entire road'}`,
          font: '600 12px system-ui, -apple-system, Segoe UI, sans-serif',
          fillColor: Color.WHITE, showBackground: true,
          backgroundColor: css(WIDENING_STYLE.label, 0.92), backgroundPadding: new Cartesian2(10, 6),
          style: LabelStyle.FILL, verticalOrigin: VerticalOrigin.BOTTOM,
          horizontalOrigin: HorizontalOrigin.CENTER, pixelOffset: new Cartesian2(0, -10),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        point: {
          pixelSize: 8, color: css(WIDENING_STYLE.proposed), outlineColor: css(WIDENING_STYLE.label),
          outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    viewer.scene.requestRender();
  }

  return {
    get mode() { return mode; },
    entityCount: () => source.entities.values.length,
    arm,
    disarm: () => arm(null),

    /** Draw a preview. Called on every parameter change; cheap because it redraws one source. */
    show(next) { preview = next ?? null; redraw(); },

    /** Show the alignment being drawn. Passing null ends drawing and restores the widening view. */
    showDrawing(next) {
      // Editing state belongs to the layer: a redraw from React keeps the handles and selection.
      drawing = next ? {
        ...next, editing: mode === 'EDIT', selected: next.selected ?? drawing?.selected ?? null,
      } : null;
      redraw();
    },

    /** Remove one vertex by index; a locked tie-in end is never removed. */
    removeVertex(index) {
      if (!drawing?.points || index === null || index === undefined || isLocked(index)) return null;
      if (drawing.points.length <= 2) return null;
      drawing = { ...drawing, points: drawing.points.filter((_, i) => i !== index), selected: null };
      redraw();
      return drawing.points;
    },

    /** Remove the last vertex. The commonest correction while drawing. */
    undoVertex() {
      if (!drawing?.points?.length) return null;
      drawing = { ...drawing, points: drawing.points.slice(0, -1) };
      redraw();
      return drawing.points;
    },

    clear() { preview = null; drawing = null; arm(null); redraw(); },

    /** Highlight a conflict location, so a finding can be clicked to find it. */
    markConflict(ring) {
      if (!ring?.length) return;
      source.entities.add({
        id: `widening-conflict-${source.entities.values.length}`,
        polyline: {
          positions: Cartesian3.fromDegreesArrayHeights(
            ring.flatMap(([lon, lat]) => [lon, lat, PREVIEW_ELEVATION_M + 1.4])),
          width: 4, material: css(WIDENING_STYLE.conflict),
          depthFailMaterial: css(WIDENING_STYLE.conflict, 0.45),
        },
      });
      viewer.scene.requestRender();
    },

    /** Frame what is drawn. Only on request: switching modes must not move the camera. */
    flyTo({ duration = 1.5 } = {}) {
      if (!bounds || viewer.isDestroyed()) return false;
      const centre = [(bounds.west + bounds.east) / 2, (bounds.south + bounds.north) / 2];
      const [east, north] = lonLatToEnu(centre, [bounds.east, bounds.north]);
      const radius = Math.max(60, Math.hypot(east, north));
      viewer.camera.cancelFlight();
      viewer.camera.flyToBoundingSphere(
        { center: Cartesian3.fromDegrees(centre[0], centre[1], PREVIEW_ELEVATION_M), radius },
        { duration, offset: new HeadingPitchRange(-Math.PI / 5, -Math.PI / 4, Math.max(300, radius * 3)) });
      return true;
    },

    destroy() {
      arm(null);
      cameraInputs(true);
      source.entities.removeAll();
      if (!viewer.isDestroyed()) viewer.dataSources.remove(source, true);
    },
  };
}
