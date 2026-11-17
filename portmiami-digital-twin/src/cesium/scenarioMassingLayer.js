/**
 * The scenario planner's own Cesium layer: the existing garage, and the proposed massing.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THE PROPOSED VOLUME SITS ABOVE THE BUILDING, NOT THROUGH IT
 *
 * Google Photorealistic 3D Tiles already contain the real garage, as photogrammetry. Extruding
 * its footprint from the ground produces a box occupying the same space as the mesh: the two
 * surfaces z-fight, the box swallows the building, and the result looks like a rendering bug
 * rather than a proposal. `buildingFootprintLayer.js` reached the same conclusion for fills and
 * documents it.
 *
 * Per-feature styling is not an option either: Google's tileset exposes no per-building features
 * to style, and 3D Tiles clipping against one footprint is fragile across tile loads.
 *
 * So the proposal is drawn as ADDITIONAL FLOORS ABOVE THE EXISTING ROOF:
 *
 *   - the roof elevation is MEASURED by sampling the rendered mesh (`clampToHeightMostDetailed`),
 *     the same technique the asset marker uses, because the county footprint extract publishes no
 *     HEIGHT for these buildings and none is invented;
 *   - the proposed volume is a translucent extrusion from that measured roof up by
 *     floors x floor-to-floor, so it never intersects the photogrammetry;
 *   - a brighter roof plane caps it, and a cyan perimeter traces the footprint at ground level.
 *
 * If the mesh cannot be sampled — tiles not loaded, sampling unsupported — the layer falls back to
 * an EXPLICITLY ASSUMED elevation and reports it through `onWarning`, which the panel shows. It
 * never silently invents a height, and it never reads an unlabelled HEIGHT field as metres.
 *
 * A surface-lot scenario gets no massing at all: a reconfigured car park is not a building, and
 * drawing a tower on one would be fabricating the proposal.
 * ---------------------------------------------------------------------------------------------
 */
import {
  BoundingSphere, Cartesian2, Cartesian3, Cartographic, Color, CustomDataSource,
  HeadingPitchRange, HeightReference, LabelStyle, PolygonHierarchy, VerticalOrigin,
} from 'cesium';

/** Ground offset, matching the road and footprint layers so the three agree. */
const GROUND_M = 6;
/** Used only when the mesh cannot be sampled. Reported as an assumption whenever it is used. */
export const ASSUMED_ROOF_M = 18;
/** Clear of the mesh, so the proposed slab never grazes the photogrammetric roof. */
const ROOF_CLEARANCE_M = 1.5;

const STYLE = Object.freeze({
  /** Verified footprint: the cyan perimeter from the client's concept image. */
  existingOutline: '#22d3ee',
  existingFill: '#22d3ee',
  /** Proposed volume: the planner's blue, distinct from the verified cyan. */
  proposedWall: '#2f7ff0',
  proposedRoof: '#7cc0ff',
  /** A candidate site is neither verified nor built: amber, like every other provisional thing. */
  candidate: '#e0952f',
});

const css = (hex, alpha) => Color.fromCssColorString(hex).withAlpha(alpha);

/** Rings as [lon, lat] pairs -> a Cesium hierarchy at one height. */
const hierarchyAt = (rings, height) => {
  const [outer, ...holes] = rings;
  return new PolygonHierarchy(
    Cartesian3.fromDegreesArrayHeights(outer.flatMap(([lon, lat]) => [lon, lat, height])),
    holes.map(ring => new PolygonHierarchy(
      Cartesian3.fromDegreesArrayHeights(ring.flatMap(([lon, lat]) => [lon, lat, height])))),
  );
};

/** The centre of a ring set, for labels and sampling. */
function centreOf(rings) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const [lon, lat] of rings[0]) {
    west = Math.min(west, lon); east = Math.max(east, lon);
    south = Math.min(south, lat); north = Math.max(north, lat);
  }
  return { centre: [(west + east) / 2, (south + north) / 2], bounds: { west, south, east, north } };
}

/**
 * A square pad of a stated area about a point, for a candidate site that has no footprint yet.
 *
 * The size is DERIVED from the user's own assumptions — spaces x gross area per space / floors —
 * not picked to look right. The panel states the area and the fact that it is indicative massing
 * rather than a design.
 */
export function padFootprint([lon, lat], areaM2) {
  const side = Math.sqrt(Math.max(areaM2, 100));
  const metresPerDegLat = 111320;
  const metresPerDegLon = Math.cos((lat * Math.PI) / 180) * 111320;
  const dLat = side / 2 / metresPerDegLat;
  const dLon = side / 2 / metresPerDegLon;
  return [[
    [lon - dLon, lat - dLat], [lon + dLon, lat - dLat],
    [lon + dLon, lat + dLat], [lon - dLon, lat + dLat], [lon - dLon, lat - dLat],
  ]];
}

export function installScenarioMassingLayer(viewer, { onWarning = () => {} } = {}) {
  const source = new CustomDataSource('portmiami-scenario-massing');
  viewer.dataSources.add(source);
  let token = 0;
  let lastFrame = null;   // what to fly to

  const clear = () => {
    token += 1;
    if (source.entities.values.length === 0) return;
    source.entities.removeAll();
    if (!viewer.isDestroyed()) viewer.scene.requestRender();
  };

  /**
   * Measure the rendered surface at a point. Returns null when it cannot be measured — the caller
   * then uses the stated assumption and says so.
   */
  async function sampleSurface(lon, lat) {
    if (!viewer.scene.clampToHeightSupported) return null;
    try {
      const [clamped] = await viewer.scene.clampToHeightMostDetailed(
        [Cartesian3.fromDegrees(lon, lat, GROUND_M)]);
      if (!clamped) return null;
      const height = Cartographic.fromCartesian(clamped).height;
      return Number.isFinite(height) ? height : null;
    } catch {
      return null;
    }
  }

  function drawExisting(rings, label) {
    for (const ring of rings) {
      source.entities.add({
        id: `scenario-existing-${source.entities.values.length}`,
        polyline: {
          positions: Cartesian3.fromDegreesArrayHeights(ring.flatMap(([lon, lat]) => [lon, lat, GROUND_M])),
          width: 4,
          material: css(STYLE.existingOutline, 0.95),
          // The part behind the building still reads, dimmed, rather than disappearing.
          depthFailMaterial: css(STYLE.existingOutline, 0.45),
        },
      });
    }
    source.entities.add({
      id: 'scenario-existing-fill',
      polygon: {
        hierarchy: hierarchyAt(rings, GROUND_M),
        material: css(STYLE.existingFill, 0.14),
        outline: false,
        // Subtle: this marks the verified footprint, it does not hide the scene above it.
        heightReference: HeightReference.NONE,
      },
    });
    if (label) addLabel(rings, GROUND_M + 40, label, STYLE.existingOutline);
  }

  function addLabel(rings, height, text, colour) {
    const { centre } = centreOf(rings);
    source.entities.add({
      id: `scenario-label-${source.entities.values.length}`,
      position: Cartesian3.fromDegrees(centre[0], centre[1], height),
      label: {
        text,
        font: '600 13px system-ui, -apple-system, Segoe UI, sans-serif',
        fillColor: Color.WHITE,
        showBackground: true,
        backgroundColor: Color.fromCssColorString('#0f1727').withAlpha(0.9),
        backgroundPadding: new Cartesian2(10, 6),
        style: LabelStyle.FILL,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -8),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      point: {
        pixelSize: 9,
        color: Color.fromCssColorString(colour),
        outlineColor: Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  /**
   * Draw a scenario.
   *
   * @param {object} view
   * @param {Array|null} view.footprint   rings of the verified footprint, or a derived pad
   * @param {boolean} view.verified       whether those rings are a confirmed GIS footprint
   * @param {number} view.floors
   * @param {number} view.floorToFloorM
   * @param {string} view.label
   * @param {'EXISTING'|'PROPOSED'|'BOTH'} view.mode
   * @param {boolean} view.massing        false for a surface lot: no structure is proposed
   */
  /**
   * Draw the PROPOSED floors.
   *
   * The base is supplied by the caller — the top of the existing envelope the highlight layer
   * drew — so the two agree by construction instead of each sampling the mesh and landing a
   * metre apart. A candidate site has no existing structure, so its base is sampled here.
   *
   * @param {object} view
   * @param {Array} view.footprint   rings
   * @param {Array[]} [view.parts]   every linked footprint's rings, where a garage is recorded as
   *                                 several footprints. Added floors go on all of them, because
   *                                 drawing them on the first one alone showed a storey over part
   *                                 of the structure and nothing over the rest.
   * @param {boolean} view.verified  false for a candidate site's derived pad
   * @param {number} view.floors
   * @param {number} view.floorToFloorM
   * @param {number|null} view.baseM the existing envelope's top, when there is one
   * @param {string} view.label
   * @param {boolean} view.massing   false for a surface lot: no structure is proposed
   */
  async function show(view) {
    clear();
    const mine = token;
    const {
      footprint, parts, verified = true, floors = 0, floorToFloorM = 0, baseM = null, label,
      massing = true,
    } = view ?? {};
    const ringSets = (parts?.length ? parts : [footprint]).filter(set => set?.length);
    if (!ringSets.length) return;

    const { centre, bounds } = centreOf(ringSets.flat());
    lastFrame = { bounds, centre };

    if (!verified) {
      // A candidate site has no verified footprint of its own, so its pad outline is drawn here.
      for (const set of ringSets) drawExisting(set, null);
      addLabel(ringSets[0], GROUND_M + 40,
        `${label} · candidate site, not a verified footprint`, STYLE.existingOutline);
    }

    if (!massing || floors <= 0 || floorToFloorM <= 0) {
      viewer.scene.requestRender();
      return;
    }

    let from = baseM;
    if (from === null) {
      const ground = await sampleSurface(centre[0], centre[1]);
      if (mine !== token || viewer.isDestroyed()) return;
      from = ground ?? GROUND_M;
    }
    const to = from + floors * floorToFloorM;

    ringSets.forEach((rings, part) => {
      source.entities.add({
        id: `scenario-proposed-volume-${part}`,
        polygon: {
          hierarchy: hierarchyAt(rings, from),
          height: from,
          extrudedHeight: to,
          // Brighter than the existing envelope, so the proposal reads as the thing that is new.
          material: css(verified ? STYLE.proposedWall : STYLE.candidate, 0.42),
          outline: false,
        },
      });
      source.entities.add({
        id: `scenario-proposed-roof-${part}`,
        polygon: {
          hierarchy: hierarchyAt(rings, to),
          height: to,
          material: css(verified ? STYLE.proposedRoof : STYLE.candidate, 0.62),
          outline: false,
        },
      });
      // One line per ADDED floor, so the count on screen matches the configured number. The
      // existing roof is already drawn by the highlight layer's top edge, so it is not repeated.
      for (let floor = 1; floor <= floors; floor += 1) {
        const height = from + floor * floorToFloorM;
        source.entities.add({
          id: `scenario-proposed-level-${part}-${floor}`,
          polyline: {
            positions: Cartesian3.fromDegreesArrayHeights(
              rings[0].flatMap(([lon, lat]) => [lon, lat, height])),
            width: floor === floors ? 3.5 : 1.5,
            material: css(STYLE.existingOutline, floor === floors ? 1 : 0.55),
            depthFailMaterial: css(STYLE.existingOutline, 0.3),
          },
        });
      }
    });
    if (!verified) addLabel(ringSets[0], to + 12, label, STYLE.candidate);
    viewer.scene.requestRender();
  }

  /** Frame whatever is drawn, from an oblique angle that keeps the surroundings in shot. */
  function flyTo({ duration = 1.8 } = {}) {
    if (!lastFrame || viewer.isDestroyed()) return;
    const { bounds } = lastFrame;
    const corners = [
      Cartesian3.fromDegrees(bounds.west, bounds.south, 0),
      Cartesian3.fromDegrees(bounds.east, bounds.north, 0),
      Cartesian3.fromDegrees(bounds.west, bounds.north, 0),
      Cartesian3.fromDegrees(bounds.east, bounds.south, 0),
    ];
    const sphere = BoundingSphere.fromPoints(corners);
    viewer.camera.cancelFlight();
    viewer.camera.flyToBoundingSphere(sphere, {
      duration,
      offset: new HeadingPitchRange(
        Cesium_heading(), -Math.PI / 4.2, Math.max(420, sphere.radius * 5.5)),
    });
  }

  /** A consistent oblique heading, so every scenario is framed the same way. */
  function Cesium_heading() { return -Math.PI / 5; }

  return {
    show,
    clear,
    flyTo,
    isShowing: () => source.entities.values.length > 0,
    destroy() {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(source, true);
    },
  };
}

export { STYLE as SCENARIO_MASSING_STYLE };
