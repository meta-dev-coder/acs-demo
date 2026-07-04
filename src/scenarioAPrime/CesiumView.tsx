/*---------------------------------------------------------------------------------------------
 * Scenario A′ — native CesiumJS panel (approach A). When the A′ tab is active, Shell renders
 * this component OVER the iTwin <Viewer> (which stays mounted underneath, so switching back to
 * A–D is instant and never re-authenticates). The DataConnect assets' native WGS84 lon/lat go
 * straight onto the globe — no GCS conversion at all in this path.
 *
 * IMPORTANT: this module imports "cesium" (~9 MB). It must ONLY be loaded via React.lazy(() =>
 * import(...)) from Shell.tsx so Vite code-splits it into its own chunk, fetched the first time
 * the A′ tab is opened — tabs A–D keep their current bundle size and load time.
 *
 * Imagery is the key-free Esri World Imagery MapServer — the same provider the iTwin viewport's
 * base map uses (scenarioA/viewportUtils.ts), so the two views read as one product. No Cesium
 * ion token, no terrain (flat ellipsoid) — nothing here needs credentials.
 *
 * Store contract (same as the iTwin decorator it visually replaces):
 *   - reads storeAPrime assets; entity id = asset_tag; band color via scenarioA's bandMeta.
 *   - click a pin  -> storeAPrime.inspect(tag)  (inspector + left list highlight update).
 *   - list click   -> storeAPrime.inspect(tag)  -> this component flies to the asset.
 *--------------------------------------------------------------------------------------------*/
import React, { useEffect, useRef } from "react";
import {
  ArcGisMapServerImageryProvider,
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Color,
  CustomDataSource,
  DistanceDisplayCondition,
  Ellipsoid,
  HeightReference,
  HorizontalOrigin,
  ImageryLayer,
  LabelStyle,
  NearFarScalar,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  VerticalOrigin,
  Viewer,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { bandMeta } from "../scenarioA/scoring";
import { storeAPrime } from "./storeAPrime";
import type { ScoredAssetPrime } from "./types";

const ESRI_WORLD_IMAGERY =
  "https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer";

/** Pin size per band — mirrors the iTwin decorator's DIAMETER ranking (red biggest). */
const PIXEL_SIZE: Record<string, number> = { red: 14, amber: 11, green: 8 };

function bandColor(band: string): Color {
  return Color.fromCssColorString(bandMeta(band as "red" | "amber" | "green").color);
}

/** Cluster disc: band-colored circle with a white rim (drawn once per color, cached) — the
 *  billboard behind the cluster's count label, matching the iTwin cluster pins' look. */
const discCache = new Map<string, string>();
function clusterDisc(cssColor: string): string {
  const cached = discCache.get(cssColor);
  if (cached) return cached;
  const size = 36;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 3, 0, Math.PI * 2);
  ctx.fillStyle = cssColor;
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  const url = canvas.toDataURL();
  discCache.set(cssColor, url);
  return url;
}

/** Rebuild the data source's entities from the store's current assets. */
function populate(ds: CustomDataSource, assets: ScoredAssetPrime[]): void {
  ds.entities.removeAll();
  for (const a of assets) {
    ds.entities.add({
      id: a.asset_tag,
      position: Cartesian3.fromDegrees(a.lon, a.lat, 0),
      point: {
        pixelSize: PIXEL_SIZE[a.band] ?? 9,
        color: bandColor(a.band),
        outlineColor: Color.WHITE,
        outlineWidth: 2,
        heightReference: HeightReference.CLAMP_TO_GROUND,
        scaleByDistance: new NearFarScalar(2_000, 1.4, 60_000, 0.6),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: a.label.length > 28 ? `${a.label.slice(0, 27)}…` : a.label,
        font: "600 12px 'Segoe UI', sans-serif",
        style: LabelStyle.FILL_AND_OUTLINE,
        fillColor: Color.WHITE,
        outlineColor: Color.fromCssColorString("#10151c"),
        outlineWidth: 4,
        pixelOffset: new Cartesian2(10, -4),
        horizontalOrigin: HorizontalOrigin.LEFT,
        verticalOrigin: VerticalOrigin.BOTTOM,
        heightReference: HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        // Labels only when zoomed in enough to read them; red (act-now) labels reach farther.
        distanceDisplayCondition: new DistanceDisplayCondition(0, a.band === "red" ? 25_000 : 8_000),
      },
    });
  }
}

/** Fly the camera to frame every asset (used on first load / dataset swap). */
function flyToAll(viewer: Viewer, assets: ScoredAssetPrime[]): void {
  if (assets.length === 0) return;
  const positions = assets.map((a) => Cartesian3.fromDegrees(a.lon, a.lat, 0));
  const sphere = BoundingSphere.fromPoints(positions);
  sphere.radius = Math.max(sphere.radius * 1.25, 1_500); // margin; floor for single-pin datasets
  viewer.camera.flyToBoundingSphere(sphere, { duration: 1.6 });
}

export default function CesiumView(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const viewer = new Viewer(el, {
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      selectionIndicator: false,
      infoBox: false, // the app's own inspector panel is the info surface
      baseLayer: ImageryLayer.fromProviderAsync(
        ArcGisMapServerImageryProvider.fromUrl(ESRI_WORLD_IMAGERY),
        {}
      ),
    });
    viewer.scene.globe.baseColor = Color.fromCssColorString("#0b1622"); // matches the iTwin view

    const ds = new CustomDataSource("scenarioAPrime");
    // Cluster crowded pins, same intent as the iTwin MarkerSet (minimumClusterSize 3).
    ds.clustering.enabled = true;
    ds.clustering.pixelRange = 34;
    ds.clustering.minimumClusterSize = 3;
    // Style clusters like the iTwin cluster pins: a disc colored by the WORST band inside,
    // with the asset count on it (Cesium's default is a bare white number, which reads as
    // unexplained digits floating on the map).
    const BAND_RANK: Record<string, number> = { red: 3, amber: 2, green: 1 };
    ds.clustering.clusterEvent.addEventListener((clustered, cluster) => {
      let worst = "green";
      for (const e of clustered) {
        const a = storeAPrime.getSnapshot().assets.find((x) => x.asset_tag === e.id);
        if (a && (BAND_RANK[a.band] ?? 0) > (BAND_RANK[worst] ?? 0)) worst = a.band;
      }
      cluster.billboard.show = true;
      cluster.billboard.image = clusterDisc(bandMeta(worst as "red" | "amber" | "green").color);
      cluster.billboard.verticalOrigin = VerticalOrigin.CENTER;
      cluster.billboard.disableDepthTestDistance = Number.POSITIVE_INFINITY;
      cluster.label.show = true;
      cluster.label.text = String(clustered.length);
      cluster.label.font = "700 13px 'Segoe UI', sans-serif";
      cluster.label.fillColor = Color.WHITE;
      cluster.label.outlineColor = Color.fromCssColorString("#10151c");
      cluster.label.outlineWidth = 2;
      cluster.label.style = LabelStyle.FILL_AND_OUTLINE;
      cluster.label.horizontalOrigin = HorizontalOrigin.CENTER;
      cluster.label.verticalOrigin = VerticalOrigin.CENTER;
      cluster.label.pixelOffset = new Cartesian2(0, 0);
      cluster.label.disableDepthTestDistance = Number.POSITIVE_INFINITY;
    });
    void viewer.dataSources.add(ds);

    let lastAssets = storeAPrime.getSnapshot().assets;
    populate(ds, lastAssets);
    flyToAll(viewer, lastAssets);

    // Pin click -> inspect (inspector + list highlight react through the store, as with iTwin).
    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((movement: ScreenSpaceEventHandler.PositionedEvent) => {
      const picked: unknown = viewer.scene.pick(movement.position);
      const id = (picked as { id?: { id?: unknown } } | undefined)?.id?.id;
      if (typeof id === "string" && ds.entities.getById(id)) storeAPrime.inspect(id);
    }, ScreenSpaceEventType.LEFT_CLICK);

    // Store -> scene: rebuild on dataset swap; fly + highlight on inspect (e.g. list click).
    let lastInspected = storeAPrime.getSnapshot().inspectedTag;
    const unsubscribe = storeAPrime.subscribe(() => {
      const snap = storeAPrime.getSnapshot();
      if (snap.assets !== lastAssets) {
        lastAssets = snap.assets;
        populate(ds, lastAssets);
        flyToAll(viewer, lastAssets);
      }
      if (snap.inspectedTag !== lastInspected) {
        // De-emphasize the previous selection, emphasize the new one.
        if (lastInspected) {
          const prev = ds.entities.getById(lastInspected);
          if (prev?.point) prev.point.outlineWidth = 2 as never;
        }
        lastInspected = snap.inspectedTag;
        if (lastInspected) {
          const cur = ds.entities.getById(lastInspected);
          if (cur?.point) cur.point.outlineWidth = 5 as never;
          const a = snap.assets.find((x) => x.asset_tag === lastInspected);
          if (a)
            viewer.camera.flyToBoundingSphere(
              new BoundingSphere(Cartesian3.fromDegrees(a.lon, a.lat, 0, Ellipsoid.WGS84), 400),
              { duration: 1.1 }
            );
        }
      }
    });

    return () => {
      unsubscribe();
      handler.destroy();
      viewer.destroy();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      data-testid="aprime-cesium-view"
      style={{ background: "#0b1622" }}
    />
  );
}
