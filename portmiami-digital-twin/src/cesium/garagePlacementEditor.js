/**
 * Dragging a proposed garage around on the map: move, rotate, resize.
 *
 * WHERE THE CURSOR IS. Every drag is resolved by intersecting the camera ray with ONE horizontal
 * plane — the plane the building's base sits in — rather than by picking the scene. Two reasons.
 * `scene.pickPosition` over a building returns its roof, so dragging across one would make the
 * garage jump up onto it and then shrink as the "ground" rose. And a screen-space angle is not a
 * ground angle under an oblique camera: the same mouse movement reads as a different rotation
 * depending on how far the view is tilted. A plane intersection has neither problem, and it keeps
 * working when the cursor leaves the terrain entirely.
 *
 * WHAT IT OWNS. Its own `ScreenSpaceEventHandler` on the canvas, so the shared pick dispatcher
 * that owns road, building and traffic clicks is never touched, and its own `CustomDataSource`,
 * so clearing the preview cannot remove anything else. Camera control is disabled only between
 * pointer-down and pointer-up on a handle, and restored in a `finally`-shaped path so a drag that
 * ends off-canvas cannot leave the camera frozen.
 *
 * WHAT IT DOES NOT DO. It does not save. Dragging emits `onChange` with a new placement record
 * and nothing else; persistence happens when the user asks for it. It does not sample the mesh
 * during a drag either — height sampling is asynchronous and doing it per mouse-move would make
 * the building shiver. The base elevation is re-sampled once, when the drag ends.
 */
import {
  Cartesian2, Cartesian3, Cartographic, Color, CustomDataSource, HeadingPitchRange,
  HorizontalOrigin, IntersectionTests, LabelStyle, Math as CMath, Plane, PolygonHierarchy,
  ScreenSpaceEventHandler, ScreenSpaceEventType, VerticalOrigin,
} from 'cesium';
import {
  enuToLonLat, isSurfaceLot, lonLatToEnu, movePlacement, placementHandles, placementRing,
  resizePlacementTo, rotatePlacementToward,
} from '../scenarios/garagePlacement.js';

export const EDITOR_STYLE = Object.freeze({
  wall: '#168BFF',
  wallOpacity: 0.34,
  roof: '#168BFF',
  roofOpacity: 0.5,
  edge: '#00E5FF',
  floorLine: '#9fd8ff',
  handle: '#ffffff',
  handleActive: '#ffd400',
  rotate: '#e0952f',
  label: '#071B35',
});

/** Where the envelope sits when no ground sample has been taken. See `BASE_HEIGHT_SOURCE`. */
export const BASE_FALLBACK_M = -24.8;

/** How far outside the footprint the ground is sampled. On it would sample the structure. */
export const GROUND_SAMPLE_OFFSET_M = 18;

const css = (hex, alpha = 1) => Color.fromCssColorString(hex).withAlpha(alpha);

const hierarchyAt = (ring, height) => new PolygonHierarchy(
  Cartesian3.fromDegreesArrayHeights(ring.flatMap(([lon, lat]) => [lon, lat, height])));

export function installGaragePlacementEditor(viewer, { onChange, onCommit, onExit } = {}) {
  const source = new CustomDataSource('portmiami-garage-placement');
  viewer.dataSources.add(source);

  let placement = null;
  let editing = false;
  let drag = null;              // { handle, startPlacement }
  let handler = null;
  let keyListener = null;
  let lastFrame = null;
  let token = 0;

  // ---- the plane a drag is resolved in --------------------------------------------------------

  /**
   * The cursor, as [lon, lat], on the horizontal plane through the building's base.
   *
   * `Plane.fromPointNormal` needs the normal at THIS point on the ellipsoid, not a global up, or
   * the plane tilts by the geocentric-to-geodetic difference and a drag slides as it goes.
   */
  function cursorOnBasePlane(screenPosition) {
    if (!placement) return null;
    const base = Number.isFinite(placement.baseHeightM) ? placement.baseHeightM : BASE_FALLBACK_M;
    const origin = Cartesian3.fromDegrees(
      placement.centerLongitude, placement.centerLatitude, base);
    const normal = viewer.scene.globe.ellipsoid.geodeticSurfaceNormal(origin, new Cartesian3());
    const plane = Plane.fromPointNormal(origin, normal);
    const ray = viewer.camera.getPickRay(screenPosition);
    if (!ray) return null;
    const hit = IntersectionTests.rayPlane(ray, plane);
    if (!hit) return null;
    const carto = Cartographic.fromCartesian(hit);
    if (!carto || !Number.isFinite(carto.longitude)) return null;
    return [CMath.toDegrees(carto.longitude), CMath.toDegrees(carto.latitude)];
  }

  /** The handle under the cursor, by screen distance — the handles are small and overlap little. */
  function handleAt(screenPosition) {
    if (!placement || !editing) return null;
    const base = Number.isFinite(placement.baseHeightM) ? placement.baseHeightM : BASE_FALLBACK_M;
    let best = null, bestDistance = 26;       // px; a forgiving target, still smaller than the gaps
    for (const handle of placementHandles(placement)) {
      const world = Cartesian3.fromDegrees(handle.point[0], handle.point[1], base + handleHeight(handle));
      const screen = viewer.scene.cartesianToCanvasCoordinates(world, new Cartesian2());
      if (!screen || !Number.isFinite(screen.x)) continue;
      const distance = Math.hypot(screen.x - screenPosition.x, screen.y - screenPosition.y);
      if (distance < bestDistance) { best = handle; bestDistance = distance; }
    }
    return best;
  }

  /**
   * Handles sit on the base plane; the move handle rides on the roof so it is never buried.
   *
   * A surface lot has no roof to ride on, so its move handle stands a few metres above the
   * ground instead — high enough to grab, low enough to still read as lying on the lot.
   */
  const handleHeight = handle => {
    if (handle.kind !== 'MOVE') return 1.5;
    return isSurfaceLot(placement)
      ? 4 : (placement.floors ?? 1) * (placement.floorHeightM ?? 3.2) + 4;
  };

  // ---- drawing ---------------------------------------------------------------------------------

  function redraw() {
    source.entities.removeAll();
    if (!placement) { viewer.scene.requestRender(); return; }
    const ring = placementRing(placement);
    if (!ring) { viewer.scene.requestRender(); return; }

    const base = Number.isFinite(placement.baseHeightM) ? placement.baseHeightM : BASE_FALLBACK_M;
    const surface = isSurfaceLot(placement);
    const floors = surface ? 0 : Math.max(1, Math.round(placement.floors ?? 1));
    const floorHeight = surface ? 0 : (placement.floorHeightM ?? 3.2);
    const top = base + floors * floorHeight;
    lastFrame = ring;

    // A SURFACE LOT is an area, not a volume. Drawing it as a box — even a one-storey one —
    // would show a structure where the scenario's whole point is that none is proposed.
    if (!surface) {
      source.entities.add({
        id: 'placement-walls',
        polygon: {
          hierarchy: hierarchyAt(ring, base), height: base, extrudedHeight: top,
          material: css(EDITOR_STYLE.wall, EDITOR_STYLE.wallOpacity), outline: false,
        },
      });
    }
    source.entities.add({
      id: surface ? 'placement-area' : 'placement-roof',
      polygon: {
        hierarchy: hierarchyAt(ring, top), height: top,
        material: css(EDITOR_STYLE.roof, surface ? 0.26 : EDITOR_STYLE.roofOpacity),
        outline: false,
      },
    });
    // The perimeter at both ends and one line per FLOOR SLAB above the base — floors - 1 of them,
    // because the base is the ground floor's own slab and the top one is the roof already drawn.
    // Drawing a line at every multiple would show one storey more than the building has.
    const outline = (height, width, alpha) => source.entities.add({
      id: `placement-outline-${height.toFixed(2)}`,
      polyline: {
        positions: Cartesian3.fromDegreesArrayHeights(ring.flatMap(([lon, lat]) => [lon, lat, height])),
        width, material: css(EDITOR_STYLE.edge, alpha),
        depthFailMaterial: css(EDITOR_STYLE.edge, 0.35),
      },
    });
    outline(base, 3, 1);
    if (!surface) {
      outline(top, 3.5, 1);
      for (let floor = 1; floor < floors; floor += 1) {
        outline(base + floor * floorHeight, 1.4, 0.55);
      }
      for (const [lon, lat] of ring.slice(0, 4)) {
        source.entities.add({
          polyline: {
            positions: Cartesian3.fromDegreesArrayHeights([lon, lat, base, lon, lat, top]),
            width: 2, material: css(EDITOR_STYLE.edge, 0.9),
            depthFailMaterial: css(EDITOR_STYLE.edge, 0.3),
          },
        });
      }
    }

    if (editing) drawHandles(base);
    drawReadout(ring, top);
    viewer.scene.requestRender();
  }

  function drawHandles(base) {
    for (const handle of placementHandles(placement)) {
      const active = drag?.handle?.id === handle.id;
      const colour = handle.kind === 'ROTATE' ? EDITOR_STYLE.rotate : EDITOR_STYLE.handle;
      source.entities.add({
        id: `placement-handle-${handle.id}`,
        position: Cartesian3.fromDegrees(handle.point[0], handle.point[1], base + handleHeight(handle)),
        point: {
          pixelSize: handle.kind === 'MOVE' || handle.kind === 'ROTATE' ? 15 : 12,
          color: css(active ? EDITOR_STYLE.handleActive : colour),
          outlineColor: css('#0b1729'), outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    // A leader from the centre to the rotation handle, so it reads as a lever rather than a dot.
    const rotate = placementHandles(placement).find(handle => handle.kind === 'ROTATE');
    if (rotate) {
      source.entities.add({
        id: 'placement-rotate-arm',
        polyline: {
          positions: Cartesian3.fromDegreesArrayHeights([
            placement.centerLongitude, placement.centerLatitude, base + 1.5,
            rotate.point[0], rotate.point[1], base + 1.5]),
          width: 2, material: css(EDITOR_STYLE.rotate, 0.85),
          depthFailMaterial: css(EDITOR_STYLE.rotate, 0.35),
        },
      });
    }
  }

  /** The dimensions and the angle, on the model rather than only in the panel. */
  function drawReadout(ring, top) {
    const area = Math.round(placement.lengthM * placement.widthM).toLocaleString();
    const text = `${Math.round(placement.lengthM)} × ${Math.round(placement.widthM)} m`
      + `  ·  ${Math.round(placement.headingDegrees)}°`
      + (isSurfaceLot(placement)
        ? `  ·  ${area} m² surface — no structure proposed`
        : `  ·  ${Math.max(1, Math.round(placement.floors ?? 1))} floors`);
    source.entities.add({
      id: 'placement-readout',
      position: Cartesian3.fromDegrees(placement.centerLongitude, placement.centerLatitude, top + 10),
      label: {
        text, font: '600 13px system-ui, -apple-system, Segoe UI, sans-serif',
        fillColor: Color.WHITE, showBackground: true,
        backgroundColor: css(EDITOR_STYLE.label, 0.9), backgroundPadding: new Cartesian2(10, 6),
        style: LabelStyle.FILL, verticalOrigin: VerticalOrigin.BOTTOM,
        horizontalOrigin: HorizontalOrigin.CENTER, pixelOffset: new Cartesian2(0, -8),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  // ---- the drag --------------------------------------------------------------------------------

  const setCameraEnabled = enabled => {
    const controller = viewer.scene.screenSpaceCameraController;
    controller.enableRotate = enabled;
    controller.enableTranslate = enabled;
    controller.enableZoom = enabled;
    controller.enableTilt = enabled;
    controller.enableLook = enabled;
  };

  function beginDrag(movement) {
    const handle = handleAt(movement.position);
    if (!handle) return;
    drag = { handle, startPlacement: placement };
    setCameraEnabled(false);
    viewer.canvas.style.cursor = handle.kind === 'ROTATE' ? 'grabbing' : 'move';
    redraw();
  }

  function moveDrag(movement) {
    if (!drag) {
      // Not dragging: just show that a handle is grabbable.
      if (editing) viewer.canvas.style.cursor = handleAt(movement.endPosition) ? 'pointer' : '';
      return;
    }
    const point = cursorOnBasePlane(movement.endPosition);
    if (!point) return;
    const next = applyDrag(drag.handle, point);
    if (next && next !== placement) {
      placement = next;
      redraw();
      onChange?.(next);
    }
  }

  function applyDrag(handle, point) {
    if (handle.kind === 'MOVE') return movePlacement(placement, point);
    if (handle.kind === 'ROTATE') return rotatePlacementToward(placement, point, { snap: snapping });
    return resizePlacementTo(placement, handle, point);
  }

  function endDrag() {
    if (!drag) return;
    const finished = placement;
    drag = null;
    setCameraEnabled(true);
    viewer.canvas.style.cursor = editing ? '' : '';
    redraw();
    onCommit?.(finished);
  }

  function cancelDrag() {
    if (!drag) return;
    placement = drag.startPlacement;
    drag = null;
    setCameraEnabled(true);
    redraw();
    onChange?.(placement);
  }

  let snapping = true;

  // ---- lifecycle --------------------------------------------------------------------------------

  function startEditing() {
    if (editing || viewer.isDestroyed()) return;
    editing = true;
    handler = new ScreenSpaceEventHandler(viewer.canvas);
    handler.setInputAction(beginDrag, ScreenSpaceEventType.LEFT_DOWN);
    handler.setInputAction(moveDrag, ScreenSpaceEventType.MOUSE_MOVE);
    handler.setInputAction(endDrag, ScreenSpaceEventType.LEFT_UP);
    keyListener = event => {
      if (event.key !== 'Escape') return;
      // Escape cancels the OPERATION, in the order a user means it: first the drag in progress,
      // and only then editing itself. It never discards the proposal — throwing away a building
      // someone has been positioning, on a keystroke, with no confirmation, is not a cancel.
      if (drag) cancelDrag(); else onExit?.();
    };
    window.addEventListener('keydown', keyListener);
    redraw();
  }

  function stopEditing() {
    if (!editing) return;
    // A drag in flight must not take the camera down with it.
    if (drag) { drag = null; setCameraEnabled(true); }
    editing = false;
    handler?.destroy();
    handler = null;
    if (keyListener) window.removeEventListener('keydown', keyListener);
    keyListener = null;
    if (!viewer.isDestroyed()) viewer.canvas.style.cursor = '';
    redraw();
  }

  return {
    get editing() { return editing; },
    get dragging() { return Boolean(drag); },
    get placement() { return placement; },
    entityCount: () => source.entities.values.length,

    /**
     * Replace the preview. Called on every numeric edit as well as on every drag.
     *
     * It deliberately does NOT bump the sampling token. The React effect calls this whenever the
     * draft changes — which includes the instant a placement is created — so bumping here made
     * every ground sample abandon itself before it could land, and the base elevation stayed
     * "Not established" however long you waited.
     */
    show(next) {
      placement = next ?? null;
      redraw();
    },

    setSnapping(value) { snapping = Boolean(value); },
    startEditing,
    stopEditing,

    clear() {
      stopEditing();
      token += 1;          // abandon any ground sample still in flight for the old placement
      placement = null;
      lastFrame = null;
      source.entities.removeAll();
      if (!viewer.isDestroyed()) viewer.scene.requestRender();
    },

    /**
     * The ground around the footprint, as a height.
     *
     * Sampled on a ring OUTSIDE the building, never on its perimeter: a perimeter point lies on
     * the structure, and taking it as ground is exactly what once started a garage envelope at
     * roof level. The low quartile rather than the mean, so a ramp or a neighbouring roof caught
     * by one sample does not lift the whole building.
     */
    async sampleBase(forPlacement = placement) {
      const ring = placementRing(forPlacement);
      if (!ring || !viewer.scene.clampToHeightMostDetailed) return null;
      token += 1;
      const mine = token;
      const centre = [forPlacement.centerLongitude, forPlacement.centerLatitude];
      // Pushed outward in METRES through the same ENU pair the footprint is built with, rather
      // than by scaling a degree offset — a degree of longitude is a tenth shorter than one of
      // latitude here, so scaling degrees walks further east than north.
      const outward = ring.slice(0, 4).flatMap(corner => {
        const [east, north] = lonLatToEnu(centre, corner);
        const distance = Math.hypot(east, north) || 1;
        // Three points per corner, stepping further out, so a narrow kerb cannot dominate.
        return [1, 1.5, 2].map(step => {
          const metres = GROUND_SAMPLE_OFFSET_M * step;
          const [lon, lat] = enuToLonLat(centre,
            east + (east / distance) * metres, north + (north / distance) * metres);
          return Cartesian3.fromDegrees(lon, lat, 0);
        });
      });
      let clamped;
      try {
        clamped = await viewer.scene.clampToHeightMostDetailed(outward, [], 1);
      } catch {
        return null;
      }
      if (mine !== token || viewer.isDestroyed()) return null;
      const heights = clamped
        .filter(Boolean)
        .map(position => Cartographic.fromCartesian(position)?.height)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      if (heights.length < 3) return null;
      return Math.round(heights[Math.floor(heights.length * 0.25)] * 10) / 10;
    },

    /** Frame the proposal the way the planner frames a garage: one range, one oblique heading. */
    flyTo({ duration = 1.6, rangeM = 520 } = {}) {
      if (!lastFrame || viewer.isDestroyed()) return;
      const base = Number.isFinite(placement?.baseHeightM) ? placement.baseHeightM : BASE_FALLBACK_M;
      viewer.camera.cancelFlight();
      viewer.camera.flyToBoundingSphere(
        { center: Cartesian3.fromDegrees(placement.centerLongitude, placement.centerLatitude, base), radius: 1 },
        { duration, offset: new HeadingPitchRange(-Math.PI / 5, -Math.PI / 5, rangeM) });
    },

    destroy() {
      stopEditing();
      source.entities.removeAll();
      if (!viewer.isDestroyed()) viewer.dataSources.remove(source, true);
    },
  };
}
