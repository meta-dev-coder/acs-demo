import { corridorVisualConfig as config } from './corridorVisualConfig.js';
import { BoundingSphere, Cartesian3, Cartographic, Math as CMath, Matrix4, Transforms } from 'cesium';

/** Frame the complete supplied extent in the map area left clear by the explorer/details. */
export function focusBridge(viewer, entity) {
  const points = entity.polyline.positions.getValue(viewer.clock.currentTime);
  focusMapPoints(viewer, points, '.bridge-details');
}

/**
 * @param {{pitchDeg?: number, minimumHeight?: number}} [framing]  an oblique feature view keeps the
 *   surroundings in shot; the default straight-down framing is what bridges and cameras still use.
 */
export function focusMapPoints(viewer, points, detailsSelector = '.signal-details', framing = {}) {
  const { pitchDeg = -90, minimumHeight = 350 } = framing;
  if (!points?.length) return;
  // On narrow screens the expanded explorer and details otherwise cover nearly all the map.
  if (innerWidth <= 700 && document.querySelector('#menu-toggle')?.getAttribute('aria-expanded') === 'true') {
    document.querySelector('#menu-toggle').click();
  }
  const width = viewer.canvas.clientWidth, height = viewer.canvas.clientHeight;
  const explorer = document.querySelector('.layers')?.getBoundingClientRect();
  const details = document.querySelector(`${detailsSelector}:not([hidden])`)?.getBoundingClientRect();
  const left = (explorer?.right ?? 0) + 20;
  const top = 24;
  const right = innerWidth > 700 && details ? details.left - 24 : width - 64;
  const bottom = innerWidth <= 700 && details ? details.top - 24 : height - 64;
  const usableWidth = Math.max(100, right - left), usableHeight = Math.max(100, bottom - top);
  const sphere = BoundingSphere.fromPoints(points);
  const center = Cartographic.fromCartesian(sphere.center);
  const ground = Cartesian3.fromRadians(center.longitude, center.latitude, Math.max(0, center.height));
  const tanHalfFov = Math.tan(viewer.camera.frustum.fovy / 2);
  const altitude = Math.max(minimumHeight, sphere.radius * 2.6 * height / (Math.min(usableWidth, usableHeight) * 2 * tanHalfFov));
  const metresPerPixel = altitude * 2 * tanHalfFov / height;
  const desiredX = left + usableWidth / 2, desiredY = top + usableHeight / 2;
  // Shift the camera, not the source geometry, to put the bridge in the unobstructed area.
  // Tilting the camera moves its look-at point forward, so stand back along the view direction by
  // the tilt's ground reach; the framed feature still lands in the unobstructed area.
  const standoff = pitchDeg > -90 ? altitude / Math.tan(-pitchDeg * Math.PI / 180) : 0;
  const offset = new Cartesian3((width / 2 - desiredX) * metresPerPixel, (desiredY - height / 2) * metresPerPixel - standoff, altitude);
  const destination = Matrix4.multiplyByPoint(Transforms.eastNorthUpToFixedFrame(ground), offset, new Cartesian3());
  viewer.camera.cancelFlight();
  viewer.camera.flyTo({
    destination, orientation: { heading: 0, pitch: CMath.toRadians(pitchDeg), roll: 0 },
    duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : config.animation.focusMs / 1000,
  });
}
