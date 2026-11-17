/**
 * The garage highlight: a whole building emphasised in blue, not a polygon lying on its roof.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT IS DRAWN, AND WHY EACH PIECE IS THERE
 *
 *   walls    a translucent extrusion from the ground to the structure's height. This is what
 *            makes the garage read as a BUILDING picked out in blue rather than a flat lid. It is
 *            the piece the earlier version was missing.
 *   roof     a brighter plane at the top, so the structure has a readable upper boundary.
 *   edges    cyan polylines around the base and the top, plus a vertical line at each corner.
 *            Drawn as polylines because `polygon.outline`/`outlineWidth` is not honoured at a
 *            usable width on most WebGL platforms.
 *   label    a floating plate on a leader line, anchored over the footprint's interior.
 *
 * THE ENVELOPE IS INFLATED SLIGHTLY OUTWARD. Google's photorealistic tiles already contain the
 * real garage, so an envelope on exactly the same footprint shares surfaces with the mesh and
 * z-fights along every wall. Pushing the outline out by a small, stated margin makes the envelope
 * ENCLOSE the building instead of coinciding with it: the mesh shows through the translucent blue
 * and nothing flickers. The margin is a visualisation device and is documented as one.
 *
 * HEIGHT IS AN INPUT, NOT A MEASUREMENT. No source publishes a height for these footprints, and
 * the extract's HEIGHT field states no unit. So the caller passes the height it is going to show,
 * and the panel labels it an assumption. `estimateHeight()` is offered separately so a reviewer
 * can SAMPLE the rendered mesh and then decide to use that number — the sample never becomes the
 * height on its own.
 * ---------------------------------------------------------------------------------------------
 */
import {
  BoundingSphere, Cartesian2, Cartesian3, Cartographic, Color, CustomDataSource,
  HeadingPitchRange, HorizontalOrigin, LabelStyle, NearFarScalar, PolygonHierarchy, VerticalOrigin,
} from 'cesium';
import { interiorAnchor } from '../infrastructure/assetFrontage.js';

export const HIGHLIGHT_STYLE = Object.freeze({
  fill: '#168BFF',
  wallOpacity: 0.3,
  roofOpacity: 0.42,
  outline: '#00E5FF',
  outlineWidth: 3.5,
  labelBackground: '#0b1729',
});

/**
 * A shape a reviewer TRACED: the blue fill of a real structure, because someone stood behind it
 * and it is the garage — but an amber outline, because it is a user-defined shape rather than a
 * confirmed GIS footprint. Provenance is carried by the outline, not by hiding the building.
 */
export const TRACED_STYLE = Object.freeze({
  fill: '#168BFF',
  wallOpacity: 0.28,
  roofOpacity: 0.4,
  outline: '#e0952f',
  outlineWidth: 3.5,
  labelBackground: '#0b1729',
});

/** A footprint nobody has endorsed: amber throughout, and no solid envelope. */
export const CANDIDATE_STYLE = Object.freeze({
  fill: '#e0952f',
  wallOpacity: 0.22,
  roofOpacity: 0.3,
  outline: '#e0952f',
  outlineWidth: 3,
  labelBackground: '#0b1729',
});

/** How far the envelope is pushed outside the real footprint, to stop it z-fighting the mesh. */
export const ENVELOPE_MARGIN_M = 1.2;
/** How far outside the walls the ground is sampled. Far enough to clear the building, close
 *  enough to still be its own apron. */
export const GROUND_OFFSET_M = 10;

/** How far the camera sits from a garage when it frames one. Same for every garage; see below. */
export const FRAME_RANGE_M = 1250;
/** Where the base sits when the ground cannot be sampled at all; reported, never silent. */
const BASE_FALLBACK_M = 0;
const LABEL_LIFT_M = 34;

const css = (hex, alpha) => Color.fromCssColorString(hex).withAlpha(alpha);

/**
 * Push a ring outward from its own centroid by roughly `metres`.
 *
 * A proper polygon buffer would need a geometry library this project does not carry. Scaling
 * about the centroid is the cheap approximation: exact for a convex shape about its centre, and
 * close enough on a garage at a 1 m margin. It is only ever used to separate the highlight from
 * the mesh, never to report an area — every area in the UI comes from the ORIGINAL ring.
 */
export function inflateRing(ring, metres) {
  if (!ring?.length) return ring;
  const lat0 = ring[0][1];
  const mPerLon = Math.cos((lat0 * Math.PI) / 180) * 111320;
  const mPerLat = 110540;
  let cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i += 1) { cx += ring[i][0]; cy += ring[i][1]; }
  const n = Math.max(1, ring.length - 1);
  cx /= n; cy /= n;
  // The scale that adds `metres` to the mean radius.
  let radius = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    radius += Math.hypot((ring[i][0] - cx) * mPerLon, (ring[i][1] - cy) * mPerLat);
  }
  radius /= n;
  if (!(radius > 0)) return ring;
  const scale = (radius + metres) / radius;
  return ring.map(([lon, lat]) => [cx + (lon - cx) * scale, cy + (lat - cy) * scale]);
}

const hierarchyAt = (rings, height) => {
  const [outer, ...holes] = rings;
  return new PolygonHierarchy(
    Cartesian3.fromDegreesArrayHeights(outer.flatMap(([lon, lat]) => [lon, lat, height])),
    holes.map(ring => new PolygonHierarchy(
      Cartesian3.fromDegreesArrayHeights(ring.flatMap(([lon, lat]) => [lon, lat, height])))),
  );
};

function boundsOf(footprints) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const f of footprints) {
    west = Math.min(west, f.bounds.west); east = Math.max(east, f.bounds.east);
    south = Math.min(south, f.bounds.south); north = Math.max(north, f.bounds.north);
  }
  return { west, south, east, north };
}

export function installGarageHighlight(viewer, { onDiagnostic = () => {} } = {}) {
  const source = new CustomDataSource('portmiami-garage-highlight');
  viewer.dataSources.add(source);
  let token = 0;
  let framed = null;

  function clearHighlight() {
    token += 1;
    if (source.entities.values.length === 0) return;
    source.entities.removeAll();
    if (!viewer.isDestroyed()) viewer.scene.requestRender();
  }

  /**
   * A ring pushed outward from the footprint, for sampling the GROUND.
   *
   * This is the correction behind this whole module. A footprint's perimeter lies ON the
   * building, so sampling it returns roof height — for Garage K the perimeter reads 16.9–20.2 m
   * while the surrounding apron is near −24 m, and an envelope based on the perimeter therefore
   * started at the roof and rose above it. Ground is sampled on a ring OUTSIDE the walls.
   */
  const outwardRing = (ring, metres) => {
    let cx = 0, cy = 0;
    for (let i = 0; i < ring.length - 1; i += 1) { cx += ring[i][0]; cy += ring[i][1]; }
    const n = Math.max(1, ring.length - 1);
    cx /= n; cy /= n;
    return ring.map(([lon, lat]) => {
      const mPerLon = Math.cos((lat * Math.PI) / 180) * 111320;
      const dx = (lon - cx) * mPerLon, dy = (lat - cy) * 110540;
      const length = Math.hypot(dx, dy) || 1;
      return [lon + ((dx / length) * metres) / mPerLon, lat + ((dy / length) * metres) / 110540];
    });
  };

  /** Sample the rendered mesh at several points. Used for the BASE, and offered for the height. */
  async function sample(points) {
    if (!viewer.scene.clampToHeightSupported || points.length === 0) return [];
    try {
      const clamped = await viewer.scene.clampToHeightMostDetailed(
        points.map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat, 0)));
      return clamped.filter(Boolean)
        .map(p => Cartographic.fromCartesian(p)?.height)
        .filter(Number.isFinite);
    } catch {
      return [];
    }
  }

  const percentile = (values, p) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))];
  };

  /**
   * Measure the ground around a footprint and the roof over it.
   *
   * GROUND comes from a ring `GROUND_OFFSET_M` outside the walls, at a LOW percentile — the low
   * percentile matters because an outward ring can still clip a neighbouring structure, a ramp or
   * an elevated road, and those samples sit high. ROOF comes from inside the footprint at a HIGH
   * percentile, for the same reason in reverse.
   *
   * Everything here is the RENDERED SURFACE, not terrain and not a survey. Heights are ellipsoidal,
   * the frame Cesium positions in, which is why the ground reads about −24 m at PortMiami.
   */
  async function measure(footprints) {
    const outside = [], inside = [];
    for (const f of footprints) {
      const ring = f.rings[0];
      const step = Math.max(1, Math.floor((ring.length - 1) / 14));
      const out = outwardRing(ring, GROUND_OFFSET_M);
      for (let i = 0; i < ring.length - 1; i += step) outside.push(out[i]);
      const anchor = interiorAnchor(f);
      if (anchor) {
        inside.push(anchor);
        for (let i = 0; i < ring.length - 1; i += step) {
          inside.push([(ring[i][0] + anchor[0] * 3) / 4, (ring[i][1] + anchor[1] * 3) / 4]);
        }
      }
    }
    const [groundSamples, roofSamples] = await Promise.all([sample(outside), sample(inside)]);
    return {
      groundSamples,
      roofSamples,
      groundPoints: outside,
      roofPoints: inside,
      groundM: percentile(groundSamples, 0.15),
      roofM: percentile(roofSamples, 0.85),
      groundSpreadM: groundSamples.length ? Math.max(...groundSamples) - Math.min(...groundSamples) : null,
      roofSpreadM: roofSamples.length ? Math.max(...roofSamples) - Math.min(...roofSamples) : null,
    };
  }

  /**
   * Offer a height estimate, WITHOUT applying it. The caller shows the numbers and decides.
   */
  async function estimateHeight(footprints) {
    const m = await measure(footprints);
    if (m.groundSamples.length === 0 && m.roofSamples.length === 0) {
      return { ok: false, reason: 'The 3D tiles could not be sampled here.' };
    }
    const ground = m.groundM ?? m.roofM;
    const roof = m.roofM ?? m.groundM;
    return {
      ok: true,
      groundM: ground,
      roofM: roof,
      heightM: Number.isFinite(roof) && Number.isFinite(ground) ? Math.max(0, roof - ground) : null,
      spreadM: m.roofSpreadM,
      groundSpreadM: m.groundSpreadM,
      samples: { ground: m.groundSamples.length, roof: m.roofSamples.length },
    };
  }

  function addEdges(ring, baseM, topM, { id, style, verticals = true }) {
    const at = height => Cartesian3.fromDegreesArrayHeights(ring.flatMap(([lon, lat]) => [lon, lat, height]));
    for (const [suffix, height] of [['base', baseM], ['top', topM]]) {
      source.entities.add({
        id: `${id}-edge-${suffix}`,
        polyline: {
          positions: at(height),
          width: style.outlineWidth,
          material: css(style.outline, suffix === 'top' ? 1 : 0.8),
          // Keeps the occluded part readable rather than letting it vanish behind the mesh.
          depthFailMaterial: css(style.outline, 0.4),
        },
      });
    }
    if (!verticals) return;
    const step = Math.max(1, Math.floor((ring.length - 1) / 8));
    for (let i = 0; i < ring.length - 1; i += step) {
      const [lon, lat] = ring[i];
      source.entities.add({
        id: `${id}-corner-${i}`,
        polyline: {
          positions: Cartesian3.fromDegreesArrayHeights([lon, lat, baseM, lon, lat, topM]),
          width: 2,
          material: css(style.outline, 0.7),
          depthFailMaterial: css(style.outline, 0.3),
        },
      });
    }
  }

  function addLabel({ anchor, height, lines, id, style }) {
    const [lon, lat] = anchor;
    source.entities.add({
      id: `${id}-leader`,
      polyline: {
        positions: Cartesian3.fromDegreesArrayHeights([lon, lat, height, lon, lat, height + LABEL_LIFT_M]),
        width: 2,
        material: css(style.outline, 0.9),
      },
    });
    source.entities.add({
      id: `${id}-label`,
      position: Cartesian3.fromDegrees(lon, lat, height + LABEL_LIFT_M),
      point: {
        pixelSize: 11,
        color: Color.fromCssColorString(style.outline),
        outlineColor: Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: lines.join('\n'),
        font: '600 14px system-ui, -apple-system, Segoe UI, sans-serif',
        fillColor: Color.WHITE,
        showBackground: true,
        backgroundColor: Color.fromCssColorString(style.labelBackground).withAlpha(0.93),
        backgroundPadding: new Cartesian2(13, 9),
        style: LabelStyle.FILL,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -12),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new NearFarScalar(400, 1, 7000, 0.6),
        translucencyByDistance: new NearFarScalar(7000, 1, 16000, 0),
      },
    });
  }

  /**
   * Draw the envelope.
   *
   * @param {object} options
   * @param {string} options.assetId
   * @param {Array} options.footprints   building records or traced shapes; both carry `rings`
   * @param {number} options.heightM     the height to draw, supplied by the caller
   * @param {number} [options.baseM]     the base, sampled when omitted
   * @param {string[]} options.labelLines
   * @param {object} [options.style]
   * @param {boolean} [options.walls]    false draws perimeter and roof only
   */
  async function highlightGarage({
    assetId, footprints = [], heightM, baseM = null, labelLines = [],
    style = HIGHLIGHT_STYLE, walls = true, flyTo = false, diagnostics = false, proposedTopM = null,
  }) {
    clearHighlight();
    const mine = token;
    const usable = footprints.filter(f => f?.rings?.length);
    if (usable.length === 0 || !(heightM > 0)) {
      onDiagnostic({ assetId, ok: false, reason: usable.length === 0 ? 'no geometry' : 'no height supplied' });
      return { ok: false, entities: 0 };
    }

    framed = boundsOf(usable);
    const notesOut = [];
    if (flyTo) flyToHighlight();

    // The base is the GROUND around the building, sampled outside its walls. Sampling the
    // perimeter — which lies on the structure — is what previously started the envelope at roof
    // level, leaving the lower floors unhighlighted.
    let base = baseM;
    let measured = null;
    if (base === null) {
      measured = await measure(usable);
      if (mine !== token || viewer.isDestroyed()) return { ok: false, entities: 0 };
      base = measured.groundM ?? BASE_FALLBACK_M;
      if (measured.groundM === null) {
        notesOut.push('The ground around this footprint could not be sampled, so the envelope '
          + `starts at an assumed ${BASE_FALLBACK_M} m. Set a base elevation to correct it.`);
      }
    }
    const top = base + heightM;

    for (const footprint of usable) {
      const id = `garage-${assetId}-${footprint.objectId ?? footprint.shapeId ?? 'shape'}`;
      // Inflated for drawing only; every reported area comes from the original ring.
      const rings = footprint.rings.map(ring => inflateRing(ring, ENVELOPE_MARGIN_M));

      if (walls) {
        source.entities.add({
          id: `${id}-walls`,
          polygon: {
            hierarchy: hierarchyAt(rings, base),
            height: base,
            extrudedHeight: top,
            material: css(style.fill, style.wallOpacity),
            outline: false,
          },
        });
      }
      source.entities.add({
        id: `${id}-roof`,
        polygon: {
          hierarchy: hierarchyAt(rings, top),
          height: top,
          material: css(style.fill, style.roofOpacity),
          outline: false,
        },
      });
      addEdges(rings[0], base, top, { id, style, verticals: walls });
    }

    // ---- height diagnostics, off unless asked for ------------------------------------------
    if (diagnostics && measured) {
      const marker = (height, colour, text) => {
        const [lon, lat] = interiorAnchor(usable[0]) ?? usable[0].centroid;
        source.entities.add({
          id: `garage-${assetId}-diag-${text.replace(/\W+/g, '-')}`,
          position: Cartesian3.fromDegrees(lon, lat, height),
          point: { pixelSize: 13, color: Color.fromCssColorString(colour), outlineColor: Color.WHITE,
            outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
          label: {
            text: `${text}  ${height.toFixed(1)} m`,
            font: '600 12px system-ui, sans-serif', fillColor: Color.fromCssColorString(colour),
            showBackground: true, backgroundColor: Color.BLACK.withAlpha(0.85),
            backgroundPadding: new Cartesian2(7, 4), horizontalOrigin: HorizontalOrigin.LEFT,
            pixelOffset: new Cartesian2(12, 0),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      };
      marker(base, '#4ade80', 'base (ground, sampled)');
      marker(top, '#00E5FF', 'existing roof (base + height)');
      if (Number.isFinite(proposedTopM)) marker(proposedTopM, '#f472b6', 'proposed roof');
      // Where the samples actually landed, so a wrong base is visible rather than inferred.
      const dot = (points, colour, height) => points.forEach(([lon, lat], i) => source.entities.add({
        id: `garage-${assetId}-diag-pt-${colour}-${i}`,
        position: Cartesian3.fromDegrees(lon, lat, height),
        point: { pixelSize: 6, color: css(colour, 0.95), disableDepthTestDistance: Number.POSITIVE_INFINITY },
      }));
      dot(measured.groundPoints ?? [], '#4ade80', base);
      dot(measured.roofPoints ?? [], '#00E5FF', top);
    }

    const primary = usable[0];
    const anchor = interiorAnchor(primary);
    if (anchor && labelLines.length) {
      addLabel({ anchor, height: top, lines: labelLines, id: `garage-${assetId}`, style });
    }

    viewer.scene.requestRender();
    const diagnostic = {
      assetId,
      ok: true,
      footprints: usable.map(f => ({
        objectId: f.objectId ?? null, shapeId: f.shapeId ?? null,
        areaM2: Math.round(f.groundAreaM2 ?? 0), rings: f.rings.length,
      })),
      combinedAreaM2: Math.round(usable.reduce((total, f) => total + (f.groundAreaM2 ?? 0), 0)),
      bounds: framed,
      baseM: Math.round(base * 10) / 10,
      heightM,
      topM: Math.round(top * 10) / 10,
      measured: measured ? {
        groundM: measured.groundM, roofM: measured.roofM,
        groundSamples: measured.groundSamples.length, roofSamples: measured.roofSamples.length,
        impliedHeightM: Number.isFinite(measured.roofM) && Number.isFinite(measured.groundM)
          ? Math.round((measured.roofM - measured.groundM) * 10) / 10 : null,
      } : null,
      notes: notesOut,
      entities: source.entities.values.length,
    };
    onDiagnostic(diagnostic);
    return {
      ok: true, entities: source.entities.values.length, baseM: base, topM: top,
      measured: diagnostic.measured, notes: notesOut,
    };
  }

  /**
   * An oblique frame of the whole structure, with the port around it.
   *
   * The range is deliberately generous. Framing a garage tightly fills the screen with one
   * building and loses the thing that makes a twin useful — the terminals, the quay and the roads
   * it sits among. It is also the SAME for every garage, rather than a multiple of the footprint's
   * own size: a garage the county file records as several footprints has a bounding sphere several
   * times a single footprint's, and scaling by it put the camera kilometres out, with the whole
   * island in frame and the garage a speck. A fixed range frames every garage alike and keeps the
   * camera outside the smallest of them.
   */
  function flyToHighlight({ duration = 1.8, rangeM = FRAME_RANGE_M } = {}) {
    if (!framed || viewer.isDestroyed()) return;
    const sphere = BoundingSphere.fromPoints([
      Cartesian3.fromDegrees(framed.west, framed.south, 0),
      Cartesian3.fromDegrees(framed.east, framed.north, 0),
      Cartesian3.fromDegrees(framed.west, framed.north, 0),
      Cartesian3.fromDegrees(framed.east, framed.south, 0),
    ]);
    viewer.camera.cancelFlight();
    viewer.camera.flyToBoundingSphere(sphere, {
      duration,
      offset: new HeadingPitchRange(
        -Math.PI / 5,          // a consistent oblique heading, so every garage is framed alike
        -Math.PI / 8,          // about 22 degrees down: a long oblique that keeps the horizon,
                               // the channel and the terminals behind the garage in shot
        rangeM),
    });
  }

  return {
    highlightGarage,
    estimateHeight,
    measure,
    clearHighlight,
    flyTo: flyToHighlight,
    entityCount: () => source.entities.values.length,
    destroy() {
      clearHighlight();
      if (!viewer.isDestroyed()) viewer.dataSources.remove(source, true);
    },
  };
}
