/*
 * transform.js — the SINGLE source of truth for model <-> physics coordinate conversion
 * (CesiumJS world  <->  SUMO network metres).
 *
 * Everything that used to be hardcoded and scattered (BOOTH_X, CENTER_X/Y, the per-carriageway remap,
 * anchor, bearing, latScale across main.js / fcd2json.py / live_server.py) collapses into ONE small,
 * reusable, serializable object: a 2-D similarity transform (translate + rotate + uniform scale).
 *
 * It is deliberately framework-light and portable: construct it from saved params, from a manual
 * calibration (4 clicks), or — later — from an auto road-detection, then call sumoToWorld / worldToSumo.
 * Use it in any Cesium + SUMO project, not just this one.
 *
 *   const t = CoordinateTransform.fromManualCalibration(clicks, sumoMeta);
 *   viewer.entities.add({ position: t.sumoToWorld(x, y) });      // physics -> globe
 *   const { x, y } = t.worldToSumo(lon, lat);                    // globe click -> physics
 *   localStorage.setItem('plazaTransform', JSON.stringify(t));   // persist / reuse
 */
import { Cartesian3, Cartographic, Transforms, Matrix4, Math as CMath } from "cesium";

const M_PER_DEG_LAT = 110540;
const mPerDegLon = (lat) => 111320 * Math.cos(CMath.toRadians(lat));

export class CoordinateTransform {
  /**
   * @param {object} p
   *   anchorLon/anchorLat/anchorHeight — the WGS84 point the SUMO reference point maps to
   *   bearingDeg — compass heading (deg, CW from north) that SUMO +x (along-corridor) points to
   *   scale — uniform metres scale (model m per SUMO m); ~1 for a true-to-scale overlay
   *   sumoRefX/sumoRefY — the SUMO point that lands on the anchor (the booth stop line, on centre-line)
   */
  constructor(p) {
    this.p = {
      anchorHeight: 3,
      scale: 1,
      sumoRefY: 0,
      ...p,
    };
    this._build();
  }

  _build() {
    const { anchorLon, anchorLat, anchorHeight } = this.p;
    this.enu = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(anchorLon, anchorLat, anchorHeight));
    this.enuInv = Matrix4.inverse(this.enu, new Matrix4());
    const b = CMath.toRadians(this.p.bearingDeg);
    this._s = Math.sin(b);
    this._c = Math.cos(b);
  }

  /** Mutate a parameter (used by interactive nudge) and rebuild. */
  set(partial) { this.p = { ...this.p, ...partial }; this._build(); return this; }

  /** SUMO (x,y) metres -> Cesium ECEF Cartesian3. */
  sumoToWorld(x, y, out) {
    const { scale, sumoRefX, sumoRefY } = this.p;
    const dx = (x - sumoRefX) * scale, dy = (y - sumoRefY) * scale;
    const east = dx * this._s - dy * this._c;
    const north = dx * this._c + dy * this._s;
    return Matrix4.multiplyByPoint(this.enu, new Cartesian3(east, north, 0), out || new Cartesian3());
  }

  /** Cesium lon/lat (deg) -> SUMO (x,y) metres. Inverse of sumoToWorld. */
  worldToSumo(lon, lat) {
    const { scale, sumoRefX, sumoRefY, anchorHeight } = this.p;
    const local = Matrix4.multiplyByPoint(
      this.enuInv, Cartesian3.fromDegrees(lon, lat, anchorHeight), new Cartesian3());
    const east = local.x / scale, north = local.y / scale;
    const dx = east * this._s + north * this._c;
    const dy = -east * this._c + north * this._s;
    return { x: dx + sumoRefX, y: dy + sumoRefY };
  }

  /** World orientation heading (rad) for a SUMO compass angle (deg, CW from north). The box/model
   *  +x (length) axis points at compass (90 + heading), so heading = bearing + sumoAngle - 180. */
  headingRad(sumoAngleDeg) {
    return CMath.toRadians((sumoAngleDeg || 0) + this.p.bearingDeg - 180);
  }

  toJSON() { return { ...this.p }; }
  static fromJSON(o) { return o && typeof o.bearingDeg === "number" ? new CoordinateTransform(o) : null; }

  /** Pick a real-world lon/lat from a screen click on the globe (flat-ellipsoid friendly). */
  static pickLonLat(viewer, windowPos) {
    const ell = viewer.scene.globe.ellipsoid;
    const c = viewer.camera.pickEllipsoid(windowPos, ell);
    if (!c) return null;
    const g = Cartographic.fromCartesian(c, ell);
    return { lon: CMath.toDegrees(g.longitude), lat: CMath.toDegrees(g.latitude) };
  }

  /**
   * MANUAL calibration → a similarity transform.
   * @param clicks   {upRoad, downRoad, boothLeft, boothRight} as {lon,lat} (from pickLonLat)
   * @param sumoMeta {boothX, bounds:{minY,maxY}} from the data file's meta
   *
   * upRoad→downRoad sets the bearing; the booth-line edge clicks set the anchor (their midpoint),
   * the road width (their separation → uniform scale), and the SUMO reference point (booth stop line
   * on the centre-line). This is the research-recommended Helmert/similarity fit for a synthetic net.
   */
  static fromManualCalibration(clicks, sumoMeta) {
    const { upRoad, downRoad, boothLeft, boothRight } = clicks;
    const bearingDeg = ((Math.atan2(
      (downRoad.lon - upRoad.lon) * mPerDegLon(upRoad.lat),
      (downRoad.lat - upRoad.lat) * M_PER_DEG_LAT) * 180) / Math.PI + 360) % 360;
    const anchorLon = (boothLeft.lon + boothRight.lon) / 2;
    const anchorLat = (boothLeft.lat + boothRight.lat) / 2;
    const mLon = mPerDegLon(anchorLat);
    const clickedWidth = Math.hypot(
      (boothRight.lon - boothLeft.lon) * mLon,
      (boothRight.lat - boothLeft.lat) * M_PER_DEG_LAT);
    const sumoWidth = (sumoMeta.bounds.maxY - sumoMeta.bounds.minY) || 1;
    return new CoordinateTransform({
      anchorLon, anchorLat, bearingDeg,
      scale: clickedWidth / sumoWidth,
      sumoRefX: sumoMeta.boothX, sumoRefY: 0,
    });
  }
}
