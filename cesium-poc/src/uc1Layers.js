/*
 * uc1Layers.js — UC1 Lane Closure Revenue Optimizer map layers: the three toggleable point layers
 * (design spec §4 bullet 1) — open work orders (the trigger list, "glowing" read), accidents
 * (dated safety events), failed inspections (risk >= 4) — plus the closure-impact heat map (§4
 * Decision 5, P5-d, Mic-Drop Moment 3). Mirrors assetLayer.js's pattern exactly: one
 * PointPrimitiveCollection per layer, bulk-add BEFORE attaching to viewer.scene.primitives (never
 * one at a time across frames — same GPU-buffer-rewrite perf note as assetLayer.js), tagged so
 * e2e helpers.ts's counts() (which only walks viewer.entities.values for .model/.ellipse graphics)
 * structurally can never count these points. Each point's id is the source record itself, for
 * picking (contextPanel.js, P3-b/c).
 *
 * Pure filtering/normalizing/clustering (failed-inspection risk banding, heat-map grid-binning,
 * etc.) lives in uc1Data.js, NOT here — this module owns Cesium primitive construction only.
 */
import { PointPrimitiveCollection, Color, Cartesian3, NearFarScalar } from "cesium";
import { gridBinPoints, incidentCoords } from "./uc1Data.js";

const POINT_HEIGHT_M = 3; // matches assetLayer.js / plaza convention.
const SCALE_BY_DISTANCE = new NearFarScalar(300, 1.6, 20000, 0.3);

// ---- work orders: the UC1 trigger list — distinct color + larger pixel size for the "glowing" read
const WO_COLOR = Color.fromCssColorString("#00e5ff");
const WO_PIXEL_SIZE = 14;

// ---- accidents: dated safety events pulled out of the Asset Registry (uc1Data.js extractAccidents)
const ACCIDENT_COLOR = Color.fromCssColorString("#ff3b3b");
const ACCIDENT_PIXEL_SIZE = 8;

// ---- failed inspections: risk >= 4 (uc1Data.js failedInspections)
const INSPECTION_COLOR = Color.fromCssColorString("#ffb100");
const INSPECTION_PIXEL_SIZE = 10;

/**
 * buildWorkOrderLayer(viewer, openWOs) -> PointPrimitiveCollection
 * One point per open work order with numeric lon/lat (uc1Data.js's openWorkOrders() already
 * enriches these; rows with no linked asset carry null coords and are skipped — nothing to map).
 */
export function buildWorkOrderLayer(viewer, openWOs) {
  const collection = new PointPrimitiveCollection();
  collection.isUc1WorkOrderLayer = true;

  for (const wo of openWOs || []) {
    if (typeof wo.lon !== "number" || typeof wo.lat !== "number") continue;
    collection.add({
      position: Cartesian3.fromDegrees(wo.lon, wo.lat, POINT_HEIGHT_M),
      pixelSize: WO_PIXEL_SIZE,
      color: WO_COLOR,
      outlineColor: Color.WHITE.withAlpha(0.85),
      outlineWidth: 2,
      scaleByDistance: SCALE_BY_DISTANCE,
      id: wo, // picked back out by pickUc1Point() below
    });
  }

  viewer.scene.primitives.add(collection);
  return collection;
}

/**
 * buildAccidentLayer(viewer, accidents) -> PointPrimitiveCollection
 * One point per dated accident event (uc1Data.js's extractAccidents() output) with numeric lon/lat.
 */
export function buildAccidentLayer(viewer, accidents) {
  const collection = new PointPrimitiveCollection();
  collection.isUc1AccidentLayer = true;

  for (const accident of accidents || []) {
    if (typeof accident.lon !== "number" || typeof accident.lat !== "number") continue;
    collection.add({
      position: Cartesian3.fromDegrees(accident.lon, accident.lat, POINT_HEIGHT_M),
      pixelSize: ACCIDENT_PIXEL_SIZE,
      color: ACCIDENT_COLOR,
      outlineColor: Color.BLACK.withAlpha(0.55),
      outlineWidth: 1,
      scaleByDistance: SCALE_BY_DISTANCE,
      id: accident,
    });
  }

  viewer.scene.primitives.add(collection);
  return collection;
}

/**
 * buildInspectionLayer(viewer, failedInspections) -> PointPrimitiveCollection
 * One point per high-risk failed inspection (uc1Data.js's failedInspections(), risk >= 4) with
 * numeric lon/lat.
 */
export function buildInspectionLayer(viewer, failedInspections) {
  const collection = new PointPrimitiveCollection();
  collection.isUc1InspectionLayer = true;

  for (const inspection of failedInspections || []) {
    if (typeof inspection.lon !== "number" || typeof inspection.lat !== "number") continue;
    collection.add({
      position: Cartesian3.fromDegrees(inspection.lon, inspection.lat, POINT_HEIGHT_M),
      pixelSize: INSPECTION_PIXEL_SIZE,
      color: INSPECTION_COLOR,
      outlineColor: Color.BLACK.withAlpha(0.55),
      outlineWidth: 1,
      scaleByDistance: SCALE_BY_DISTANCE,
      id: inspection,
    });
  }

  viewer.scene.primitives.add(collection);
  return collection;
}

// ---- closure-impact heat map (design spec §4 Decision 5, Mic-Drop Moment 3) ---------------------
// Corridor-zoom density overlay surfacing repeat crash/closure clusters: grid-bins the accident +
// located-incident points (gridBinPoints(), uc1Data.js — pure, tested) and renders one translucent
// disc per surviving cell, sized+colored by how many points landed in it. Rendered as big soft
// PointPrimitiveCollection points (same lightweight bulk-add pattern as the three layers above)
// rather than EllipseGeometry/GroundPrimitive — cheaper to build/rebuild on every reDecorate() and
// still reads as a soft disc at the corridor zoom this overlay is meant for; translucency does the
// "heat" work instead of a hard-edged ellipse outline.

const HEATMAP_CELL_SIZE_M = 400; // matches gridBinPoints()'s own default; explicit here for clarity.
const HEATMAP_MIN_PIXEL_SIZE = 26;
const HEATMAP_MAX_PIXEL_SIZE = 90;
const HEATMAP_LOW_COLOR = Color.fromCssColorString("#ffd166").withAlpha(0.22); // sparse: soft amber
const HEATMAP_HIGH_COLOR = Color.fromCssColorString("#ff2d2d").withAlpha(0.6); // dense: hot red
const HEATMAP_HEIGHT_M = 2; // sits just under the point layers (POINT_HEIGHT_M) so discs read as a base layer

/**
 * buildImpactHeatmap(viewer, {accidents, incidents, segments}) -> PointPrimitiveCollection
 *
 * `accidents` is extractAccidents() output (already {lon,lat,...}); `incidents` is raw Incidents_V3
 * rows (normalized here via uc1Data.js's incidentCoords() — only ~88/178 carry coordinates, the
 * rest are dropped, same rule as everywhere else incidentCoords() is used). `segments` is accepted
 * for API symmetry with the other P5 consumers of config/segments.json and reserved for a future
 * per-segment legend/filter; it does not affect clustering (grid-binning is purely spatial).
 *
 * One disc per grid-binned cell (gridBinPoints(), uc1Data.js), sized and colored by that cell's
 * point count relative to the densest cell in this dataset — legible without needing a legend:
 * bigger + redder = more repeat crashes/incidents at that spot. Cells are built from BOTH inputs
 * pooled together (a spot with accidents AND incidents is one hotspot, not two).
 */
export function buildImpactHeatmap(viewer, { accidents = [], incidents = [], segments = [] } = {}) {
  void segments; // reserved — see docstring; grid-binning itself is segment-agnostic.

  const points = [
    ...(accidents || []),
    ...(incidents || []).map((rec) => incidentCoords(rec)).filter(Boolean),
  ];
  const cells = gridBinPoints(points, HEATMAP_CELL_SIZE_M);

  const collection = new PointPrimitiveCollection();
  collection.isUc1HeatmapLayer = true;

  const maxCount = cells.reduce((max, c) => Math.max(max, c.count), 0) || 1;
  for (const cell of cells) {
    const t = maxCount > 1 ? (cell.count - 1) / (maxCount - 1) : 1; // 0..1 density, single-cell case reads as hottest
    collection.add({
      position: Cartesian3.fromDegrees(cell.lon, cell.lat, HEATMAP_HEIGHT_M),
      pixelSize: HEATMAP_MIN_PIXEL_SIZE + t * (HEATMAP_MAX_PIXEL_SIZE - HEATMAP_MIN_PIXEL_SIZE),
      color: Color.lerp(HEATMAP_LOW_COLOR, HEATMAP_HIGH_COLOR, t, new Color()),
      outlineWidth: 0,
      scaleByDistance: SCALE_BY_DISTANCE,
      id: cell,
    });
  }

  viewer.scene.primitives.add(collection);
  return collection;
}

/** scene.pick() wrapper shared by all three UC1 layers — returns `{kind, record}` under a click
 * (kind is "workOrder" | "accident" | "inspection", record is the source object passed into the
 * matching build*Layer() call), or null if nothing (or something else, e.g. the DataConnect asset
 * layer) was hit. Distinguishes the three layers via the `isUc1*Layer` flags stamped on each
 * collection above (all three point shapes share `lon`/`lat`/`id`-ish fields, so the record alone
 * can't tell them apart). Left-click wiring itself is the caller's responsibility (main.js), same
 * split as assetLayer.js's installAssetPicking()/pickAsset(). */
export function pickUc1Point(viewer, windowPosition) {
  const picked = viewer.scene.pick(windowPosition);
  if (!picked || !picked.id) return null;
  const collection = picked.primitive && picked.primitive.collection;
  const kind = collection?.isUc1WorkOrderLayer
    ? "workOrder"
    : collection?.isUc1AccidentLayer
    ? "accident"
    : collection?.isUc1InspectionLayer
    ? "inspection"
    : null;
  return kind ? { kind, record: picked.id } : null;
}

/** Fly the camera to a lon/lat (UC1 demo hero shortcut, main.js) — a plain point-and-drop, not
 * frameCamera()'s SUMO-frame lookAt (this module has no CoordinateTransform). No-ops on a missing
 * viewer/camera (e.g. the ArcGIS renderer) or non-numeric coords. */
export function flyToLonLat(viewer, lon, lat, heightM = 350) {
  if (!viewer?.camera || typeof lon !== "number" || typeof lat !== "number") return;
  viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(lon, lat, heightM), duration: 2 });
}

/** Remove a previously-built layer. Only ever called once a REPLACEMENT layer is ready — a failed
 * fetch must never call this (keep-previous-on-failure), same contract as assetLayer.js's
 * disposeAssetLayer(). */
export function disposeUc1Layer(viewer, collection) {
  if (!viewer || !collection) return;
  try { viewer.scene.primitives.remove(collection); } catch { /* already gone */ }
}
