/*
 * assetLayer.js — renders scored DataConnect assets (scoringA.js output) as ONE
 * PointPrimitiveCollection, colored by risk band. Mirrors workzone.js's split: this module owns
 * pure geometry/primitive building only; main.js owns DOM (KPI row, status badge, info panel).
 *
 * Perf note (design spec, Component 5): PointPrimitiveCollection rewrites its GPU buffer on every
 * add() once it has rendered at least once, so all ~5k points are added in one pass BEFORE the
 * collection is attached to viewer.scene.primitives / before the next render tick — never added
 * one at a time across frames.
 */
import { PointPrimitiveCollection, Color, Cartesian3, NearFarScalar } from "cesium";
import { bandMeta } from "./scoringA.js";

const POINT_HEIGHT_M = 3; // small absolute height offset above the ellipsoid — matches the
                           // existing plaza convention (T.p.anchorHeight default of 3 m).
const PIXEL_SIZE = 9;
const SCALE_BY_DISTANCE = new NearFarScalar(300, 1.6, 20000, 0.3);
// translucencyByDistance intentionally NOT set — points stay fully opaque at any distance.

const BAND_COLOR = {
  red: Color.fromCssColorString(bandMeta("red").color),
  amber: Color.fromCssColorString(bandMeta("amber").color),
  green: Color.fromCssColorString(bandMeta("green").color),
};

export function bandColor(band) {
  return BAND_COLOR[band] || Color.WHITE;
}

/**
 * buildAssetLayer(viewer, scoredAssets) -> PointPrimitiveCollection
 * Bulk-adds one point per scored asset (skipping any without numeric lon/lat), colored by risk
 * band, then attaches the collection to viewer.scene.primitives.
 */
export function buildAssetLayer(viewer, scoredAssets) {
  const collection = new PointPrimitiveCollection();
  // Tag the collection itself: it lives on viewer.scene.primitives, NOT viewer.entities, so
  // e2e helpers.ts's counts() (which only walks viewer.entities.values for .model/.ellipse
  // graphics) structurally can never count these points — same outcome as workzone.js's
  // cone/sign entities being excluded by graphics-type, just via a different mechanism. The flag
  // is kept anyway so any future counts()-style helper can explicitly skip tagged collections.
  collection.isDataConnectAssetLayer = true;

  for (const asset of scoredAssets) {
    if (typeof asset.lon !== "number" || typeof asset.lat !== "number") continue;
    collection.add({
      position: Cartesian3.fromDegrees(asset.lon, asset.lat, POINT_HEIGHT_M),
      pixelSize: PIXEL_SIZE,
      color: bandColor(asset.band),
      outlineColor: Color.BLACK.withAlpha(0.55),
      outlineWidth: 1,
      scaleByDistance: SCALE_BY_DISTANCE,
      id: asset, // picked back out by pickAsset() below
    });
  }

  viewer.scene.primitives.add(collection);
  return collection;
}

/** scene.pick() wrapper — returns the ScoredAsset under a click, or null if nothing (or
 * something else) was hit. */
export function pickAsset(viewer, windowPosition) {
  const picked = viewer.scene.pick(windowPosition);
  if (!picked) return null;
  const asset = picked.id;
  return asset && asset.asset_tag ? asset : null;
}

/** Remove a previously-built layer. Only ever called once a REPLACEMENT layer is ready — a
 * failed fetch must never call this (keep-previous-on-failure). */
export function disposeAssetLayer(viewer, collection) {
  if (!viewer || !collection) return;
  try { viewer.scene.primitives.remove(collection); } catch { /* already gone */ }
}
