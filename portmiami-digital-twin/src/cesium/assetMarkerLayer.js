/**
 * Marks the SELECTED infrastructure asset on the map.
 *
 * Why this exists: an asset's position in this build is almost always DERIVED — interpolated from
 * its street address against the county address ranges (see src/infrastructure/assetGeocode.js).
 * Until now "View on map" flew the camera to that point and drew nothing, so it landed on a
 * close-up with no indication of which spot it meant. The road segment the address was matched to
 * does get emphasised, but only when the Road Network layer happens to be switched on — with both
 * GIS layers off there was nothing on screen at all.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THE MARKER MUST NOT SAY
 *
 * A derived point is a point ON THE STREET CENTRELINE where the house number falls in a block's
 * address range. It is NOT a survey of the facility, and the facility itself is set back from the
 * road by an unknown distance. So the marker is drawn in the registry's "provisional" amber, is
 * labelled "Approximate · from street address", and is tied to its source road by a leader line —
 * all of which say "this is the address point" rather than "the garage is here".
 *
 * There is deliberately NO accuracy circle. A ring of some radius would be read as a measured
 * tolerance, and no such measurement exists: the geocoder knows which block the number falls in,
 * not how far the building stands from the kerb.
 *
 * An asset with a reviewer-CONFIRMED building footprint is a different claim, and is drawn in the
 * confirmed green at the footprint rather than in amber on the street.
 *
 * Between the two sits the FRONTAGE point: the footprint the address fronts onto, found by walking
 * off the side of the street the county's own address range names (src/infrastructure/assetFrontage.js).
 * That pin stands on the structure, which is what "show me Garage K" means — so it is drawn in a
 * cooler amber and says "On the building this address fronts" rather than "Confirmed". It is still
 * a reading of an address, and the label never lets it pass for a confirmed match.
 *
 * ONE asset at a time — the selected one. Drawing all eleven derived points at once would present
 * a row of confident pins for positions that are each a provisional inference.
 * ---------------------------------------------------------------------------------------------
 *
 * Not registered with the shared pick dispatcher: this marks what is already selected, so it has
 * nothing to select, and staying out of picking keeps it from stealing clicks from the footprints
 * underneath it.
 */
import {
  Cartesian2, Cartesian3, Cartographic, Color, CustomDataSource, HorizontalOrigin, LabelStyle,
  VerticalOrigin,
} from 'cesium';

/** Above the mesh, like the road lines and the traffic pins. */
const GROUND_M = 6;
const HEAD_M = 70;
/** Clear of whatever the pin stands on, once the mesh under it has been measured. */
const STANDOFF_M = 4;

const STYLE = Object.freeze({
  /** The registry's provisional amber — the colour a candidate link already wears in the panels. */
  DERIVED: Object.freeze({ color: '#e0952f', note: 'Approximate · from street address' }),
  /** Provisional too, but standing on a building: the accent blue, a step short of confirmed. */
  FRONTAGE: Object.freeze({ color: '#1862d0', note: 'On the building this address fronts' }),
  /** The confirmed green, matching the footprint emphasis on the building layer. */
  FOOTPRINT: Object.freeze({ color: '#15822d', note: 'Confirmed footprint' }),
});

export function installAssetMarkerLayer(viewer) {
  const source = new CustomDataSource('portmiami-asset-marker');
  viewer.dataSources.add(source);
  let token = 0;   // which show() a pending height measurement belongs to

  /**
   * Lift the marker onto whatever it is standing on.
   *
   * The county's building extract publishes no HEIGHT for any footprint here, and none is
   * invented. What CAN be measured is the rendered surface: with the globe off, the photorealistic
   * mesh is the only geometry, and Cesium will sample its height at a position. Without this a pin
   * at 6 m sits at the FOOT of a ten-storey garage, and under an oblique camera it appears to
   * float off the side of the building it is supposed to be standing on — which is the whole
   * complaint this marker exists to answer.
   *
   * Best-effort: if sampling is unsupported, the tiles under the point have not loaded, or the
   * selection has moved on, the marker stays where it was and is still correct in plan.
   */
  async function standOnSurface(longitude, latitude, mine) {
    if (!viewer.scene.clampToHeightSupported) return;
    try {
      const [clamped] = await viewer.scene.clampToHeightMostDetailed(
        [Cartesian3.fromDegrees(longitude, latitude, GROUND_M)]);
      if (!clamped || mine !== token || viewer.isDestroyed()) return;
      const surface = Cartographic.fromCartesian(clamped).height;
      if (!Number.isFinite(surface)) return;
      const foot = surface + STANDOFF_M;
      const head = foot + HEAD_M - GROUND_M;
      const stem = source.entities.getById('asset-marker-stem');
      const point = source.entities.getById('asset-marker-point');
      const label = source.entities.getById('asset-marker-label');
      if (stem) stem.polyline.positions = Cartesian3.fromDegreesArrayHeights([
        longitude, latitude, foot, longitude, latitude, head,
      ]);
      if (point) point.position = Cartesian3.fromDegrees(longitude, latitude, foot);
      if (label) label.position = Cartesian3.fromDegrees(longitude, latitude, head);
      viewer.scene.requestRender();
    } catch {
      // A sampling failure is not worth a broken marker; the ground-level one stands.
    }
  }

  /**
   * Mark one asset, replacing whatever was marked before.
   * @param {{name: string, point: [number, number]}} asset
   * @param {{status?: 'FOOTPRINT'|'FRONTAGE'|'DERIVED'}} [options]  which claim the point is
   */
  function show(asset, { status = 'DERIVED' } = {}) {
    clear();
    token += 1;
    if (!asset?.point) return;
    const [longitude, latitude] = asset.point;
    const style = STYLE[status] ?? STYLE.DERIVED;
    const colour = Color.fromCssColorString(style.color);

    // A leader from the ground point up to the label, so the label never covers the thing it names.
    source.entities.add({
      id: 'asset-marker-stem',
      polyline: {
        positions: Cartesian3.fromDegreesArrayHeights([
          longitude, latitude, GROUND_M, longitude, latitude, HEAD_M,
        ]),
        width: 2,
        material: colour.withAlpha(0.9),
      },
    });

    // The point itself, at the position the address resolved to.
    source.entities.add({
      id: 'asset-marker-point',
      position: Cartesian3.fromDegrees(longitude, latitude, GROUND_M),
      point: {
        pixelSize: 13,
        color: colour,
        outlineColor: Color.WHITE,
        outlineWidth: 3,
        // Visible and legible through the photorealistic mesh, like the traffic pins.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });

    source.entities.add({
      id: 'asset-marker-label',
      position: Cartesian3.fromDegrees(longitude, latitude, HEAD_M),
      label: {
        // The second line is the point of the whole marker: it says what kind of position this is.
        text: `${asset.name}\n${style.note}`,
        font: '600 13px system-ui, -apple-system, Segoe UI, sans-serif',
        fillColor: Color.WHITE,
        showBackground: true,
        backgroundColor: Color.fromCssColorString('#0f1727').withAlpha(0.88),
        backgroundPadding: new Cartesian2(9, 6),
        style: LabelStyle.FILL,
        horizontalOrigin: HorizontalOrigin.CENTER,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -6),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    viewer.scene.requestRender();
    void standOnSurface(longitude, latitude, token);
  }

  function clear() {
    token += 1;
    if (source.entities.values.length === 0) return;
    source.entities.removeAll();
    if (!viewer.isDestroyed()) viewer.scene.requestRender();
  }

  return {
    show,
    clear,
    isMarked: () => source.entities.values.length > 0,
    destroy() {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(source, true);
    },
  };
}

export { STYLE as ASSET_MARKER_STYLE };
