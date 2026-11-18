/**
 * The ACTIVE design alternative, drawn over the live baseline.
 *
 * ONE LAYER, REDRAWN. The baseline roads and buildings stay exactly where they are, in the layers
 * that already own them; this adds a single `CustomDataSource` holding only the active design's
 * elements. Switching alternative clears that source and draws the new one, so there is nothing
 * to accumulate and no way for two designs to be on screen at once by accident. Keeping a layer
 * per design would mean 2,362 baseline segments duplicated three times over, and three chances
 * for the copies to drift.
 *
 * ROADS ARE SURFACES. A proposed road is drawn from its corridor polygon (see `roadCorridor.js`)
 * — a translucent deck, bright edges and a dashed centreline — not as a thin line. A removed road
 * is drawn as the baseline alignment struck through in red: it is a proposal, so the baseline
 * segment stays visible underneath.
 *
 * ELEVATION IS MEASURED, THEN STATED. Each element's base comes from the photorealistic mesh,
 * sampled on a ring OUTSIDE its footprint — never on the perimeter, which lies on whatever is
 * already there. A single fixed elevation for the whole overlay was the first attempt and it was
 * wrong in both directions: proposals floated where the apron is lower than the constant, and sank
 * where it is higher.
 *
 * AN EXPANSION STARTS AT THE EXISTING ROOF. Added floors on a registered garage are stacked on the
 * structure's measured top, not on the ground — drawing them from the ground put a three-storey
 * box INSIDE a seven-storey building, which from an oblique camera reads as a footprint that does
 * not line up with its building. The roof is measured from interior samples; the ground from the
 * outward ring. The two are different measurements and are taken separately.
 *
 * Sampling is asynchronous, so a redraw paints immediately at the last known elevation and
 * repaints when the samples land. An element may still carry an explicit `designElevationM`, which
 * is used as given — a stated design level beats a measured surface.
 *
 * LABELS ARE FEW, SHARP AND NEVER STACKED. Every element used to get a permanent navy Cesium plate
 * with depth testing disabled, so eight proposals at one junction drew eight overlapping boxes.
 * Labels are now DOM nodes in the studio's style — only for the selected change and, with labels
 * on, one per affected road and per distinct new road — placed over their anchors after each
 * render and hidden when they would cover one already placed. Hovering anything else gives a
 * compact tooltip.
 *
 * EVERY ENTITY CARRIES ITS OWNERSHIP. Domain, design id, element id, geometry role and entity
 * kind, so what is on the map can always be traced to the record that put it there.
 */
import {
  Cartesian3, Cartographic, ClassificationType, Color, CustomDataSource,
  HeadingPitchRange, PolygonHierarchy,
  PolylineDashMaterialProperty, SceneTransforms, ScreenSpaceEventHandler, ScreenSpaceEventType,
} from 'cesium';
import { enuToLonLat, lonLatToEnu } from '../scenarios/garagePlacement.js';
import { CHANGE_TYPE, ELEMENT_TYPE } from '../designs/designModel.js';
import { roadCorridorRing } from '../designs/roadCorridor.js';
import { offsetCentreline, sectionBetweenMeasures } from '../designs/roadWidening.js';
import {
  ROAD_OPERATION_LABEL, elementRing, roadOperationOf,
} from '../designs/designQuantities.js';

/** The outline of a change that is in a potential conflict. */
export const CONFLICT_LINE = '#E53935';

/**
 * How each change type reads.
 *
 * New is the accent cyan, modified amber, removed red — the same vocabulary the rest of the
 * application uses for "proposed", "caution" and "going away", so nothing has to be learned twice.
 */
export const DESIGN_STYLE = Object.freeze({
  NEW: { line: '#00BFEA', fill: '#00BFEA', fillOpacity: 0.3 },
  MODIFIED: { line: '#B76A12', fill: '#B76A12', fillOpacity: 0.26 },
  REMOVED: { line: '#C73E3E', fill: '#C73E3E', fillOpacity: 0.18 },
  UNCHANGED: { line: '#657184', fill: '#657184', fillOpacity: 0.12 },
  selected: '#1769E0',
  label: '#071B35',
});

/**
 * One colour per ROAD OPERATION, not per change type.
 *
 * A widening and a realignment are both MODIFIED, so colouring by change type drew them in the
 * same amber and left no way to tell on the map which tool had produced which proposal. The four
 * operations now read apart at a glance, and the panel's legend uses these same values so the
 * map and the list cannot drift.
 *
 * Violet for realignment is the one colour not already in the application's vocabulary; it was
 * chosen because it is distinguishable from the amber beside it under the common forms of colour
 * blindness, where a second warm hue would not have been.
 */
export const ROAD_OPERATION_STYLE = Object.freeze({
  // Bright, near-opaque surfaces with a glow at the edge: the approved Road Design Studio look.
  // `text` is the same hue darkened enough to read on white, for chips and legends.
  CREATE: { line: '#18E0FF', fill: '#18E0FF', fillOpacity: 0.72, dash: 18, text: '#0B7C93' },
  WIDEN: { line: '#FFB300', fill: '#FFC21A', fillOpacity: 0.74, dash: 18, text: '#9A6400' },
  REALIGN: { line: '#B15CFF', fill: '#A855F7', fillOpacity: 0.7, dash: 26, text: '#7330C0' },
  CLOSE: { line: '#FF3B3B', fill: '#FF3B3B', fillOpacity: 0.22, dash: 10, text: '#C02626' },
  MODIFY: { line: '#FFB300', fill: '#FFC21A', fillOpacity: 0.6, dash: 18, text: '#9A6400' },
});

/** What a piece of drawn geometry IS, so an entity can be traced to its purpose. */
export const GEOMETRY_ROLE = Object.freeze({
  ROAD_SURFACE: 'ROAD_SURFACE',
  ROAD_CENTERLINE: 'ROAD_CENTERLINE',
  ROAD_BOUNDARY: 'ROAD_BOUNDARY',
  BUILDING_MASS: 'BUILDING_MASS',
  SELECTION: 'SELECTION',
  CONFLICT: 'CONFLICT',
  ANNOTATION: 'ANNOTATION',
  /** The existing alignment a change acts on, drawn for context in Overlay mode. */
  BASELINE_CONTEXT: 'BASELINE_CONTEXT',
});

/** How the active alternative is drawn against the existing network. */
export const VIEW_MODE = Object.freeze({ EXISTING: 'EXISTING', PROPOSED: 'PROPOSED', OVERLAY: 'OVERLAY' });

/** The original alignment, muted, so the proposal reads as a change to something. */
export const BASELINE_CONTEXT_STYLE = Object.freeze({ line: '#8A94A6', alpha: 0.85, width: 7 });

/** Only used until the mesh answers, and where it cannot. See the file header. */
export const REFERENCE_ELEVATION_M = -24.8;

/** Lifted off the ground just enough not to z-fight the photogrammetry. */
export const SURFACE_LIFT_M = 0.6;

/** How far outside a footprint the ground is sampled. On it would sample the structure. */
export const GROUND_SAMPLE_OFFSET_M = 16;

const css = (hex, alpha = 1) => Color.fromCssColorString(hex).withAlpha(alpha);
const hierarchyAt = (ring, height) => new PolygonHierarchy(
  Cartesian3.fromDegreesArrayHeights(ring.flatMap(([lon, lat]) => [lon, lat, height])));

/** A road is styled by what it DOES; anything else by how it changes. */
const styleFor = element => (element?.type === ELEMENT_TYPE.ROAD
  ? ROAD_OPERATION_STYLE[roadOperationOf(element)] ?? DESIGN_STYLE.UNCHANGED
  : DESIGN_STYLE[element.changeType] ?? DESIGN_STYLE.UNCHANGED);

export function installDesignOverlay(viewer, { onSelect, domain = 'ROAD_INFRASTRUCTURE' } = {}) {
  const source = new CustomDataSource('portmiami-design-overlay');
  viewer.dataSources.add(source);
  let design = null;
  let selectedId = null;
  let bounds = null;
  let sampleToken = 0;
  /** Persistent map labels are off by default; see the file header. */
  let labelsVisible = false;
  let hoveredId = null;
  /**
   * What surrounds the design on the map: the view mode, the county alignments its changes
   * reference (objectId -> coordinates), and, in a comparison, which elements both sides share.
   */
  let context = {
    mode: VIEW_MODE.PROPOSED, baseline: new Map(), diff: null, conflicts: new Set(),
    contextRoads: [], network: null,
  };
  /** Where each element's map label is anchored, filled during a draw. */
  const anchors = new Map();
  /** The elements that get a map label in the current draw; see `chooseLabelled`. */
  let labelledIds = new Set();

  /**
   * Stable ownership for one entity.
   *
   * Written onto every entity this layer adds so a stray primitive can be traced to the design
   * and the element that produced it, and so cleanup can be verified by querying rather than by
   * trusting that `removeAll` was called.
   */
  const own = (element, role) => ({
    designDomain: domain,
    designId: design?.id ?? null,
    designElementId: element.id,
    geometryRole: role,
    entityType: element.type,
  });

  /**
   * Measured elevations, by element id: `{ groundM, roofM }`.
   *
   * Filled asynchronously by `measure()` below and read by the draw functions, so a redraw never
   * waits on the mesh and a late sample simply triggers another paint.
   */
  const measured = new Map();

  const baseOf = element => {
    if (Number.isFinite(element?.properties?.designElevationM)) {
      return element.properties.designElevationM;
    }
    const ground = measured.get(element.id)?.groundM;
    return Number.isFinite(ground) ? ground : REFERENCE_ELEVATION_M;
  };

  /**
   * Where a MODIFIED structure's added floors begin: the existing roof.
   *
   * Falls back to the ground only when the roof could not be measured, and the element's own
   * label says the height is an estimate either way.
   */
  const startOf = element => {
    if (element.changeType !== CHANGE_TYPE.MODIFIED) return baseOf(element);
    const roof = measured.get(element.id)?.roofM;
    return Number.isFinite(roof) ? roof : baseOf(element);
  };

  /** A ring pushed out from its own centroid by `metres`, for sampling beside a structure. */
  function outwardRing(ring, metres) {
    const n = Math.max(1, ring.length - 1);
    const centre = ring.slice(0, n).reduce(
      (total, [lon, lat]) => [total[0] + lon / n, total[1] + lat / n], [0, 0]);
    return ring.slice(0, n).map(point => {
      const [east, north] = lonLatToEnu(centre, point);
      const length = Math.hypot(east, north) || 1;
      return enuToLonLat(centre,
        east + (east / length) * metres, north + (north / length) * metres);
    });
  }

  const percentile = (values, p) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor((sorted.length - 1) * p)] : null;
  };

  /**
   * Sample the mesh for every element that needs an elevation.
   *
   * Ground from a ring OUTSIDE the footprint at the low quartile, so a kerb or a neighbouring
   * roof caught by one sample cannot lift the whole proposal. Roof from interior points at the
   * 85th percentile, so plant and lift overruns do not set the deck height.
   */
  async function measure(forDesign) {
    if (!viewer.scene.clampToHeightMostDetailed) return;
    const token = ++sampleToken;
    for (const element of forDesign?.elements ?? []) {
      const ring = element.type === ELEMENT_TYPE.ROAD
        ? (element.geometry?.type === 'LineString'
          ? roadCorridorRing(element.geometry.coordinates, element.properties?.widthM) : null)
        : elementRing(element);
      if (!ring) continue;
      const outside = outwardRing(ring, GROUND_SAMPLE_OFFSET_M)
        .map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat, 0));
      const inside = element.changeType === CHANGE_TYPE.MODIFIED
        ? outwardRing(ring, -4).map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat, 0)) : [];
      let groundHits = [], roofHits = [];
      try {
        const clamped = await viewer.scene.clampToHeightMostDetailed(
          [...outside, ...inside], [], 1);
        if (token !== sampleToken || viewer.isDestroyed()) return;
        const heights = clamped.map(position =>
          (position ? Cartographic.fromCartesian(position)?.height : null));
        groundHits = heights.slice(0, outside.length);
        roofHits = heights.slice(outside.length);
      } catch {
        continue;
      }
      measured.set(element.id, {
        groundM: percentile(groundHits, 0.25),
        roofM: roofHits.length ? percentile(roofHits, 0.85) : null,
      });
    }
    if (token === sampleToken && !viewer.isDestroyed()) redraw();
  }

  function track(ring) {
    for (const [lon, lat] of ring) {
      if (!bounds) bounds = { west: lon, east: lon, south: lat, north: lat };
      else {
        bounds.west = Math.min(bounds.west, lon); bounds.east = Math.max(bounds.east, lon);
        bounds.south = Math.min(bounds.south, lat); bounds.north = Math.max(bounds.north, lat);
      }
    }
  }

  /**
   * A proposed road, drawn as a road: a bright painted deck in its operation's colour, a soft glow
   * along its edges, white edge lines, and white dashed lane dividers — one per lane boundary,
   * from the lane count the proposal states. Every line is the corridor of the stored centreline;
   * nothing here is decoration that the geometry does not support.
   *
   * A closure stays what it was: the stretch struck through in a dashed red line, no surface.
   */
  function drawRoad(element) {
    const centreline = element.geometry?.type === 'LineString' ? element.geometry.coordinates : null;
    if (!centreline?.length) return;
    // In a comparison, a change both alternatives share is drawn muted so the differences stand out.
    const shared = context.diff?.get(element.id) === 'SAME';
    const style = shared ? DESIGN_STYLE.UNCHANGED : styleFor(element);
    const base = baseOf(element) + SURFACE_LIFT_M;
    const selected = element.id === selectedId;
    // With a change selected, the others step back so the one being reviewed is unmistakable.
    const fade = selectedId && !selected ? 0.35 : 1;
    // A change in a potential conflict is outlined red, so it can be found without the panel.
    const glow = selected ? DESIGN_STYLE.selected
      : context.conflicts.has(element.id) ? CONFLICT_LINE : style.line;
    const width = element.proposal?.totalWidthM ?? element.properties?.widthM;
    const ring = roadCorridorRing(centreline, width);
    const at = (line, lift) => Cartesian3.fromDegreesArrayHeights(line.flatMap(([lon, lat]) => [lon, lat, base + lift]));

    if (ring && element.changeType !== CHANGE_TYPE.REMOVED) {
      track(ring);
      /*
       * DRAPED, NOT FLOATED. Every part of a proposed road is painted onto the photogrammetry
       * (`classificationType`), not placed at a sampled height. A flat deck at one height went
       * under the mesh wherever the tiles sit higher — on a stretch of several county segments
       * that left grey gaps in the colour. Draped, the colour follows the ground everywhere.
       *
       * The edges are the two SIDES of the corridor, not its closed outline, so the joints of a
       * stretch drawn segment by segment are seamless instead of crossed by white bars.
       */
      const drape = { classificationType: ClassificationType.BOTH };
      source.entities.add({
        id: `design-${element.id}-surface`,
        properties: own(element, GEOMETRY_ROLE.ROAD_SURFACE),
        polygon: {
          hierarchy: new PolygonHierarchy(Cartesian3.fromDegreesArray(ring.flat())),
          material: css(style.fill, style.fillOpacity * fade), outline: false, ...drape,
        },
      });
      const sides = Number.isFinite(width)
        ? [offsetCentreline(centreline, width / 2), offsetCentreline(centreline, -width / 2)].filter(l => l?.length >= 2)
        : [];
      const ground = line => Cartesian3.fromDegreesArray(line.flat());
      sides.forEach((side, i) => {
        // A soft band in the operation's colour under a crisp white edge line: the glow.
        source.entities.add({
          id: `design-${element.id}-glow-${i}`,
          properties: own(element, selected ? GEOMETRY_ROLE.SELECTION : GEOMETRY_ROLE.ROAD_BOUNDARY),
          polyline: {
            positions: ground(side), width: selected ? 12 : 9, clampToGround: true, ...drape,
            material: css(glow, (selected ? 0.75 : 0.55) * fade),
          },
        });
        source.entities.add({
          id: `design-${element.id}-edge-${i}`,
          properties: own(element, GEOMETRY_ROLE.ROAD_BOUNDARY),
          polyline: {
            positions: ground(side), width: 2.5, clampToGround: true, ...drape,
            material: css('#ffffff', 0.95 * fade),
          },
        });
      });
      // Lane dividers: n lanes over the stated width put n − 1 dashed lines across it.
      const lanes = Math.round(element.proposal?.laneCount ?? element.properties?.lanes ?? 0);
      if (Number.isFinite(width) && lanes >= 2 && lanes <= 8) {
        for (let i = 1; i < lanes; i += 1) {
          const offset = -width / 2 + (width * i) / lanes;
          const divider = Math.abs(offset) < 1e-6 ? centreline : offsetCentreline(centreline, offset);
          if (!(divider?.length >= 2)) continue;
          source.entities.add({
            id: `design-${element.id}-lane-${i}`,
            properties: own(element, GEOMETRY_ROLE.ROAD_CENTERLINE),
            polyline: {
              positions: ground(divider), width: 2.5, clampToGround: true, ...drape,
              material: new PolylineDashMaterialProperty({ color: css('#ffffff', 0.95 * fade), dashLength: 16 }),
            },
          });
        }
      }
    } else {
      // A closure, or a road with no stated width: the alignment itself, dashed in its colour.
      source.entities.add({
        id: `design-${element.id}-centreline`,
        properties: own(element, GEOMETRY_ROLE.ROAD_CENTERLINE),
        polyline: {
          positions: at(centreline, 0.2),
          width: element.changeType === CHANGE_TYPE.REMOVED ? 6 : 3,
          material: new PolylineDashMaterialProperty({ color: css(glow, fade), dashLength: style.dash ?? 18 }),
          depthFailMaterial: css(glow, 0.35),
        },
      });
      track(centreline);
    }
    annotate(element, centreline[Math.floor(centreline.length / 2)], base + 14);
  }

  /** A building, garage, terminal or surface area: a plate, or a volume where floors are stated. */
  function drawFootprint(element) {
    const ring = elementRing(element);
    if (!ring) return;
    track(ring);
    const style = styleFor(element);
    const selected = element.id === selectedId;
    const edge = selected ? DESIGN_STYLE.selected : style.line;
    // An expansion begins at the EXISTING ROOF; anything new begins at the ground.
    const base = startOf(element);
    const floors = Number(element.properties?.floors);
    const floorHeight = Number(element.properties?.floorHeightM) || 3.2;
    // A surface area is an AREA: no floors means no volume, never a one-storey box.
    const surface = element.type === ELEMENT_TYPE.SURFACE_PARKING || !(floors > 0);
    const top = surface ? base + SURFACE_LIFT_M : base + floors * floorHeight;

    source.entities.add({
      id: `design-${element.id}-mass`,
      properties: own(element, GEOMETRY_ROLE.BUILDING_MASS),
      polygon: {
        hierarchy: hierarchyAt(ring, surface ? top : base),
        height: surface ? top : base,
        extrudedHeight: surface ? undefined : top,
        material: css(style.fill, style.fillOpacity), outline: false,
      },
    });
    // The existing structure's own outline, so an expansion reads as sitting ON something.
    if (element.changeType === CHANGE_TYPE.MODIFIED && !surface) {
      const ground = baseOf(element);
      if (ground < base - 1) {
        source.entities.add({
          polyline: {
            positions: Cartesian3.fromDegreesArrayHeights(
              ring.flatMap(([lon, lat]) => [lon, lat, ground])),
            width: 2, material: css(DESIGN_STYLE.UNCHANGED.line, 0.85),
            depthFailMaterial: css(DESIGN_STYLE.UNCHANGED.line, 0.3),
          },
        });
      }
    }
    for (const [height, width] of surface ? [[top, 3]] : [[base, 2.5], [top, 3.5]]) {
      source.entities.add({
        polyline: {
          positions: Cartesian3.fromDegreesArrayHeights(ring.flatMap(([lon, lat]) => [lon, lat, height])),
          width, material: css(edge), depthFailMaterial: css(edge, 0.35),
        },
      });
    }
    annotate(element, ring[0], top + 12);
  }

  /**
   * What an element says about itself, as one short line.
   *
   * Shared by the hover tooltip and the optional map label so the two can never disagree, and
   * road width is only stated where the record actually carries one.
   */
  function detailOf(element) {
    if (element.type === ELEMENT_TYPE.ROAD) {
      const operation = ROAD_OPERATION_LABEL[roadOperationOf(element)] ?? 'Road change';
      const width = Number.isFinite(element.properties?.widthM)
        ? ` · ${element.properties.widthM} m wide` : '';
      const lanes = Number.isFinite(element.properties?.lanes)
        ? ` · ${element.properties.lanes} lanes` : '';
      return `${operation}${width}${lanes}`;
    }
    const change = element.changeType === CHANGE_TYPE.MODIFIED ? 'Proposed modification' : 'Proposed';
    const floors = Number.isFinite(element.properties?.floors)
      ? ` · ${element.properties.floors} floors` : '';
    return `${change}${floors}`;
  }

  const nameOf = element => element.properties?.name ?? element.id;

  /**
   * The element's anchor: a small pickable marker, and the point its map label hangs from.
   */
  function annotate(element, [lon, lat], height) {
    const style = styleFor(element);
    const selected = element.id === selectedId;
    const position = Cartesian3.fromDegrees(lon, lat, height);
    anchors.set(element.id, position);
    source.entities.add({
      id: `design-${element.id}-label`,
      position,
      properties: own(element, GEOMETRY_ROLE.ANNOTATION),
      point: {
        // Only the labelled or selected change shows its anchor: a stretch drawn segment by
        // segment would otherwise carry a dot at every segment. The surface stays clickable.
        show: selected || labelledIds.has(element.id),
        pixelSize: selected ? 11 : 8,
        color: css(selected ? DESIGN_STYLE.selected : style.line),
        outlineColor: Color.WHITE,
        outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  // ---- map labels --------------------------------------------------------------------------------

  /**
   * Compact map labels: an icon tile in the operation's colour, the road's name, and one line of
   * what is proposed. DOM nodes over the canvas rather than Cesium labels, so the text is sharp at
   * any screen density, and decluttered in screen space after every render.
   *
   * WHICH ELEMENTS ARE LABELLED. The selected change always. With labels on, also one change per
   * existing road and each distinct new road — the "important features" — up to `MAX_LABELS`.
   * Records that repeat another's alignment are not labelled twice. Everything else is reached by
   * hovering, which gives the tooltip below.
   */
  const MAX_LABELS = 5;
  const labelHost = document.createElement('div');
  labelHost.className = 'rd-maplabels';
  viewer.container.appendChild(labelHost);
  let labelNodes = [];

  const GLYPH = {
    WIDEN: '<path d="M7 20 10 4M17 20 14 4M12 6v2M12 11v2M12 16v2"/>',
    CREATE: '<path d="M12 5v14M5 12h14"/>',
    REALIGN: '<path d="M5 19c8 0 6-14 14-14"/><circle cx="5" cy="19" r="1.6"/><circle cx="19" cy="5" r="1.6"/>',
    CLOSE: '<circle cx="12" cy="12" r="7"/><path d="M7 17 17 7"/>',
    MODIFY: '<path d="M5 12h14"/>',
  };

  function labelText(element) {
    const op = roadOperationOf(element) ?? 'MODIFY';
    const name = element.baselineRef?.name ?? element.properties?.name ?? element.id;
    const length = (() => {
      const line = element.geometry?.type === 'LineString' ? element.geometry.coordinates : null;
      if (!line || line.length < 2) return null;
      let total = 0;
      for (let i = 1; i < line.length; i += 1) {
        const [e, n] = lonLatToEnu(line[i - 1], line[i]);
        total += Math.hypot(e, n);
      }
      return Math.round(total);
    })();
    const width = Number.isFinite(element.properties?.widthM) ? element.properties.widthM : null;
    const lanes = Number.isFinite(element.properties?.lanes) ? element.properties.lanes : null;
    const proposed = `Proposed: ${element.proposal?.totalWidthM ?? width ?? '—'} m · ${element.proposal?.laneCount ?? lanes ?? '—'} lanes`;
    const title = {
      WIDEN: `Road Widening — ${element.baselineRef?.name ?? name}`,
      CREATE: element.properties?.name ?? 'New Access Road',
      REALIGN: 'Road Realignment',
      CLOSE: `Road Closure — ${element.baselineRef?.name ?? name}`,
    }[op] ?? name;
    const detail = {
      WIDEN: proposed,
      CREATE: proposed,
      REALIGN: 'Original vs Proposed Alignment',
      CLOSE: `Proposed closure · ${element.section?.lengthM ? Math.round(element.section.lengthM) : length ?? '—'} m`,
      MODIFY: 'Proposed modification',
    }[op];
    return { op, name: title, detail };
  }

  function chooseLabelled() {
    const elements = design?.elements ?? [];
    const chosen = [];
    const seenRoads = new Set(), seenLines = new Set();
    const selected = elements.find(element => element.id === selectedId);
    if (selected) chosen.push(selected);
    if (!labelsVisible) return chosen;
    for (const element of elements) {
      if (chosen.length >= MAX_LABELS) break;
      if (element === selected || context.diff?.get(element.id) === 'SAME') continue;
      const objectId = element.baselineRef?.objectId;
      if (Number.isFinite(objectId)) {
        // One label per named road and operation: a stretch widened segment by segment is one
        // proposal on the map, not four identical plates.
        const key = `${roadOperationOf(element)}|${element.baselineRef?.name ?? objectId}`;
        if (seenRoads.has(key)) continue;
        seenRoads.add(key);
      } else {
        const line = element.geometry?.coordinates ?? [];
        const key = line.length ? `${line[0].map(v => v.toFixed(4))}|${line[line.length - 1].map(v => v.toFixed(4))}` : element.id;
        if (seenLines.has(key)) continue;
        seenLines.add(key);
      }
      chosen.push(element);
    }
    return chosen;
  }

  function buildLabels() {
    labelHost.replaceChildren();
    labelNodes = chooseLabelled().filter(element => anchors.has(element.id)).map(element => {
      const { op, name, detail } = labelText(element);
      const colour = (ROAD_OPERATION_STYLE[op] ?? ROAD_OPERATION_STYLE.MODIFY).line;
      const node = document.createElement('div');
      node.className = `rd-maplabel${element.id === selectedId ? ' is-selected' : ''}`;
      node.innerHTML = `<span class="rd-maplabel-icon" style="background:${colour}"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="${op === 'WIDEN' || op === 'CREATE' || op === 'MODIFY' ? '#0B1B33' : '#fff'}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${GLYPH[op] ?? GLYPH.MODIFY}</svg></span><span class="rd-maplabel-text"><b></b><em></em></span>`;
      node.querySelector('b').textContent = name;
      node.querySelector('em').textContent = detail;
      labelHost.appendChild(node);
      return { node, elementId: element.id, selected: element.id === selectedId };
    });
    placeLabels();
  }

  /** Place each label over its anchor; hide one that would cover a label already placed. */
  function placeLabels() {
    if (!labelNodes.length) return;
    // Screen furniture a label must not sit under: anything marked as an obstacle (the panel, the
    // legend, the dashboard, the map bar), in the same frame as the label coordinates.
    const host = viewer.container.getBoundingClientRect();
    const placed = [...document.querySelectorAll('[data-label-obstacle]')].map(node => {
      const r = node.getBoundingClientRect();
      return { left: r.left - host.left, right: r.right - host.left, top: r.top - host.top, bottom: r.bottom - host.top };
    }).filter(r => r.right > r.left && r.bottom > r.top);
    const ordered = [...labelNodes].sort((a, b) => Number(b.selected) - Number(a.selected));
    for (const label of ordered) {
      const world = anchors.get(label.elementId);
      const at = world ? SceneTransforms.worldToWindowCoordinates(viewer.scene, world) : undefined;
      if (!at) { label.node.hidden = true; continue; }
      label.node.hidden = false;
      label.node.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
      const width = label.node.offsetWidth || 200, height = label.node.offsetHeight || 46;
      const box = { left: at.x - width / 2, right: at.x + width / 2, top: at.y - height - 16, bottom: at.y - 10 };
      const clear = placed.every(other => box.right < other.left || box.left > other.right
        || box.bottom < other.top || box.top > other.bottom);
      label.node.hidden = !clear;
      if (clear) placed.push(box);
    }
  }

  const onPostRender = () => placeLabels();
  viewer.scene.postRender.addEventListener(onPostRender);

  // ---- hover and selection ---------------------------------------------------------------------

  /**
   * The hover tooltip.
   *
   * A plain DOM node over the canvas, not a Cesium label: it never competes for space with the
   * geometry, never needs decluttering and is always legible at any camera distance.
   */
  const tip = document.createElement('div');
  tip.className = 'design-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  viewer.container.appendChild(tip);

  const elementAt = position => {
    const picked = viewer.scene.pick(position);
    const id = picked?.id?.properties?.designElementId?.getValue?.();
    if (!id) return null;
    return (design?.elements ?? []).find(element => element.id === id) ?? null;
  };

  const handler = new ScreenSpaceEventHandler(viewer.canvas);
  handler.setInputAction(({ endPosition }) => {
    const element = elementAt(endPosition);
    if (!element) {
      if (hoveredId !== null) { hoveredId = null; tip.hidden = true; }
      return;
    }
    hoveredId = element.id;
    tip.innerHTML = '';
    const name = document.createElement('b');
    name.textContent = nameOf(element);
    const detail = document.createElement('span');
    detail.textContent = detailOf(element);
    tip.append(name, detail);
    tip.hidden = false;
    // Offset off the cursor so the tooltip never sits under the pointer and flicker-picks itself.
    tip.style.left = `${endPosition.x + 14}px`;
    tip.style.top = `${endPosition.y + 14}px`;
  }, ScreenSpaceEventType.MOUSE_MOVE);

  /*
   * Clicking one of OUR entities selects it; a click on anything else is left entirely alone, so
   * the road-widening layer's own picking still gets every click meant for a baseline road.
   */
  handler.setInputAction(({ position }) => {
    const element = elementAt(position);
    if (!element) return;
    selectedId = element.id === selectedId ? null : element.id;
    redraw();
    onSelect?.(selectedId);
  }, ScreenSpaceEventType.LEFT_CLICK);

  /**
   * The existing alignment behind a change, drawn muted.
   *
   * Overlay mode draws it for every road the design touches. Proposed mode draws it only for a
   * selected realignment, because a replacement line means nothing without the line it replaces.
   */
  const greyLine = (id, element, coordinates, height, { width = BASELINE_CONTEXT_STYLE.width, alpha = BASELINE_CONTEXT_STYLE.alpha, dashed = false, colour = BASELINE_CONTEXT_STYLE.line } = {}) => {
    source.entities.add({
      id,
      properties: element ? own(element, GEOMETRY_ROLE.BASELINE_CONTEXT) : { geometryRole: GEOMETRY_ROLE.BASELINE_CONTEXT },
      polyline: {
        positions: Cartesian3.fromDegreesArrayHeights(coordinates.flatMap(([lon, lat]) => [lon, lat, height])),
        width,
        material: dashed ? new PolylineDashMaterialProperty({ color: css(colour, alpha), dashLength: 14 }) : css(colour, alpha),
        // Shown through the photogrammetry as well: the existing road is the reference for the
        // proposal, and a mesh drawn over it should not hide which road is being changed.
        depthFailMaterial: css(colour, 0.6),
      },
    });
  };

  /** A small ringed marker: a connection point, a tie-in or a section end. */
  const marker = (id, element, [lon, lat], height, colour) => {
    source.entities.add({
      id,
      position: Cartesian3.fromDegrees(lon, lat, height + 0.6),
      properties: own(element, GEOMETRY_ROLE.ANNOTATION),
      point: {
        pixelSize: 13, color: Color.WHITE, outlineColor: css(colour), outlineWidth: 4,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  };

  /**
   * The existing alignment behind a change, drawn muted.
   *
   * Always for a widening and a realignment — the proposal means nothing without the road it
   * changes — and in Overlay for anything else that references a county road. A realignment also
   * gets the stretch it replaces picked out in a lighter dashed line, so original and proposed
   * read side by side. A new road gets the roads at its ends (`context.contextRoads`).
   */
  function drawBaselineContext() {
    const wanted = new Map();
    for (const element of design?.elements ?? []) {
      const objectId = element.baselineRef?.kind === 'ROAD' ? element.baselineRef.objectId : null;
      if (!Number.isFinite(objectId) || wanted.has(objectId)) continue;
      const op = roadOperationOf(element);
      // A widening's own centreline runs down the middle of the widened road, where it only paints
      // a grey band; it is drawn in Overlay. A realignment's original is a different line, so it
      // is always drawn beside the proposal.
      if (context.mode === VIEW_MODE.OVERLAY || op === 'REALIGN') wanted.set(objectId, element);
    }
    for (const [objectId, element] of wanted) {
      const coordinates = context.baseline.get(objectId);
      if (!coordinates?.length) continue;
      const base = baseOf(element) + SURFACE_LIFT_M + 0.1;
      greyLine(`design-baseline-${objectId}`, element, coordinates, base);
    }
    for (const element of design?.elements ?? []) {
      if (roadOperationOf(element) !== 'REALIGN') continue;
      const coordinates = context.baseline.get(element.baselineRef?.objectId);
      const s = element.section;
      const replaced = coordinates && s ? sectionBetweenMeasures(coordinates, s.startMeasureM, s.endMeasureM)?.coordinates : coordinates;
      if (replaced?.length >= 2) {
        greyLine(`design-replaced-${element.id}`, element, replaced, baseOf(element) + SURFACE_LIFT_M + 0.35,
          { width: 9, alpha: 0.95, dashed: true, colour: '#E6EBF2' });
      }
    }
    context.contextRoads.forEach((coordinates, i) => {
      if (coordinates?.length >= 2) greyLine(`design-context-${i}`, null, coordinates, REFERENCE_ELEVATION_M + SURFACE_LIFT_M + 0.1, { width: 5, alpha: 0.75 });
    });
  }

  /** The port's existing network, for the baseline and the Existing view. */
  function drawNetwork() {
    (context.network ?? []).forEach((coordinates, i) => {
      if (coordinates?.length >= 2) greyLine(`design-network-${i}`, null, coordinates, REFERENCE_ELEVATION_M + SURFACE_LIFT_M, { width: 3, alpha: 0.7 });
    });
  }

  /** Connection points, tie-ins and section ends, in the operation's own colour. */
  function drawMarkers() {
    const elements = design?.elements ?? [];
    for (const element of elements) {
      const line = element.geometry?.type === 'LineString' ? element.geometry.coordinates : null;
      if (!line?.length || context.diff?.get(element.id) === 'SAME') continue;
      const op = roadOperationOf(element);
      const colour = (ROAD_OPERATION_STYLE[op] ?? ROAD_OPERATION_STYLE.MODIFY).line;
      const height = baseOf(element) + SURFACE_LIFT_M;
      // New-road ends and realignment tie-ins always. For widenings, the ends of the widened
      // STRETCH: an end that meets another widening's end is a joint inside it and is not marked,
      // unless that segment is the one selected.
      const ends = [line[0], line[line.length - 1]];
      const joint = point => op === 'WIDEN' && element.id !== selectedId && elements.some(other => other !== element
        && roadOperationOf(other) === 'WIDEN' && other.geometry?.coordinates?.length
        && [other.geometry.coordinates[0], other.geometry.coordinates[other.geometry.coordinates.length - 1]]
          .some(p => Math.hypot(...lonLatToEnu(p, point)) < 3));
      if (!['CREATE', 'REALIGN', 'WIDEN'].includes(op)) continue;
      ends.forEach((point, i) => {
        if (!joint(point)) marker(`design-${element.id}-${i ? 'end' : 'start'}`, element, point, height, colour);
      });
    }
  }

  function redraw() {
    // Deterministic cleanup: everything this layer drew goes, then the active design is drawn
    // again from its records. Nothing is diffed, so nothing can be left behind.
    source.entities.removeAll();
    anchors.clear();
    bounds = null;
    labelledIds = new Set(chooseLabelled().map(element => element.id));
    drawNetwork();
    if (context.mode !== VIEW_MODE.EXISTING) {
      drawBaselineContext();
      for (const element of design?.elements ?? []) {
        if (element.type === ELEMENT_TYPE.ROAD) drawRoad(element);
        else drawFootprint(element);
      }
      drawMarkers();
    }
    buildLabels();
    viewer.scene.requestRender();
  }

  /** Everything one element covers, plus the alignment it replaces, as lon/lat points. */
  function extentOf(element) {
    const line = element.geometry?.type === 'LineString' ? element.geometry.coordinates : null;
    const points = [];
    if (line) {
      points.push(...(roadCorridorRing(line, element.properties?.widthM) ?? line));
    } else {
      points.push(...(elementRing(element) ?? []));
    }
    const objectId = element.baselineRef?.kind === 'ROAD' ? element.baselineRef.objectId : null;
    // A realignment is framed with the road it replaces, so both paths are in view together; a
    // widening with the road it widens, so a short section is seen in its setting.
    if (['REALIGN', 'WIDEN'].includes(roadOperationOf(element)) && context.baseline.has(objectId)) {
      points.push(...context.baseline.get(objectId));
    }
    return points;
  }

  /**
   * How much of the canvas the studio's furniture covers on the right and at the bottom, in
   * pixels, read from the elements marked as label obstacles. A framed road is placed in the
   * part of the map that is left, not behind the panel.
   */
  function coveredEdges() {
    const host = viewer.container.getBoundingClientRect();
    let right = 0, bottom = 0;
    for (const node of document.querySelectorAll('[data-label-obstacle]')) {
      const r = node.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right >= host.right - 40 && r.height > host.height * 0.35) right = Math.max(right, host.right - r.left);
      if (r.bottom >= host.bottom - 40 && r.width > host.width * 0.4) bottom = Math.max(bottom, host.bottom - r.top);
    }
    return { right, bottom, width: host.width, height: host.height };
  }

  /**
   * Frame a set of points in the uncovered part of the map.
   *
   * The camera flies to the points' bounding sphere at a range scaled up for the share of the
   * canvas that is covered, then shifts sideways and down by half the covered margins, so the
   * geometry lands in the middle of what can actually be seen.
   */
  function flyToPoints(points, { duration = 1.4, minRangeM = 220, pitch = -Math.PI / 4.5 } = {}) {
    if (!points.length || viewer.isDestroyed()) return false;
    const lons = points.map(p => p[0]), lats = points.map(p => p[1]);
    const west = Math.min(...lons), east = Math.max(...lons);
    const south = Math.min(...lats), north = Math.max(...lats);
    const center = Cartesian3.fromDegrees((west + east) / 2, (south + north) / 2, REFERENCE_ELEVATION_M);
    const radius = Math.max(40, Cartesian3.distance(
      Cartesian3.fromDegrees(west, south, REFERENCE_ELEVATION_M),
      Cartesian3.fromDegrees(east, north, REFERENCE_ELEVATION_M)) / 2);
    const { right, bottom, width, height } = coveredEdges();
    const squeeze = Math.max(width / Math.max(200, width - right), height / Math.max(200, height - bottom));
    const range = Math.max(minRangeM, radius * 3.2 * squeeze);
    viewer.camera.cancelFlight();
    viewer.camera.flyToBoundingSphere({ center, radius }, {
      duration,
      offset: new HeadingPitchRange(-Math.PI / 5, pitch, range),
      complete: () => {
        if (viewer.isDestroyed()) return;
        const fovy = viewer.camera.frustum.fovy ?? Math.PI / 3;
        const metresPerPixel = (2 * range * Math.tan(fovy / 2)) / Math.max(1, height);
        if (right) viewer.camera.moveRight((right / 2) * metresPerPixel);
        if (bottom) viewer.camera.moveDown((bottom / 2) * metresPerPixel);
        viewer.scene.requestRender();
      },
    });
    return true;
  }

  return {
    get designId() { return design?.id ?? null; },
    entityCount: () => source.entities.values.length,

    /**
     * Draw one alternative. Passing null or the baseline clears the overlay.
     *
     * `options.mode` is a VIEW_MODE; `options.baseline` maps county OBJECTIDs to their alignments
     * for the context drawing; `options.diff` maps element ids to 'SAME' in a comparison.
     */
    show(next, options = {}) {
      context = {
        mode: VIEW_MODE[options.mode] ?? VIEW_MODE.PROPOSED,
        baseline: options.baseline ?? context.baseline,
        diff: options.diff ?? null,
        conflicts: options.conflicts ?? new Set(),
        contextRoads: options.contextRoads ?? [],
        network: options.network ?? null,
      };
      const changed = (next?.id ?? null) !== (design?.id ?? null);
      design = next?.elements?.length ? next : null;
      if (!design) anchors.clear();
      // A different alternative means different ground; drop the old measurements rather than
      // paint the new proposal at the previous one's elevations.
      if (changed) { measured.clear(); sampleToken += 1; }
      redraw();
      if (design) void measure(design);
    },

    select(elementId) {
      if ((elementId ?? null) === selectedId) return;
      selectedId = elementId ?? null;
      redraw();
      onSelect?.(selectedId);
    },

    /** Frame ONE change: its corridor, and for a realignment the road it replaces as well. */
    flyToElement(elementId, options) {
      const element = (design?.elements ?? []).find(row => row.id === elementId);
      return element ? flyToPoints(extentOf(element), options) : false;
    },

    clear() {
      design = null;
      selectedId = null;
      hoveredId = null;
      tip.hidden = true;
      measured.clear();
      sampleToken += 1;
      redraw();
    },

    /** Whether proposals are named on the map. Off by default; see the file header. */
    setLabelsVisible(visible) {
      if (labelsVisible === Boolean(visible)) return;
      labelsVisible = Boolean(visible);
      redraw();
    },
    get labelsVisible() { return labelsVisible; },

    /** What the layer currently owns, for a cleanup check that queries rather than assumes. */
    ownership: () => source.entities.values.map(entity => ({
      id: entity.id,
      designId: entity.properties?.designId?.getValue?.() ?? null,
      elementId: entity.properties?.designElementId?.getValue?.() ?? null,
      role: entity.properties?.geometryRole?.getValue?.() ?? null,
    })),

    /** What the mesh said, for the panel to report as an estimate. */
    elevations: () => new Map(measured),

    /** Frame everything the active design proposes. Only on request — never on a switch. */
    flyTo({ duration = 1.6 } = {}) {
      if (!design?.elements?.length || viewer.isDestroyed()) return false;
      return flyToPoints(design.elements.flatMap(extentOf), { duration, minRangeM: 260 });
    },

    destroy() {
      // Handlers and the tooltip node go with the layer. A ScreenSpaceEventHandler left behind
      // keeps picking on a canvas whose layer no longer exists, which is how duplicate selection
      // handlers accumulate across workspace switches.
      handler.destroy();
      tip.remove();
      labelHost.remove();
      source.entities.removeAll();
      if (!viewer.isDestroyed()) {
        viewer.scene.postRender.removeEventListener(onPostRender);
        viewer.dataSources.remove(source, true);
      }
    },
  };
}
