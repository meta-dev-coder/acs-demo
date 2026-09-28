/**
 * The cameras an incident's Cameras tab is offering, marked on the map while that tab is open.
 *
 * A list of four camera names does not tell an operator where those cameras are — whether one is on
 * the far carriageway, or past the crash rather than upstream of it. Opening the tab therefore puts
 * each of them on the corridor, named, so the list and the scene answer the same question together.
 *
 * Deliberately NOT the Traffic Cameras layer: that draws all 74, which buries the four that matter
 * under the rest of the inventory. This is its own data source, holding only what the tab is showing
 * and nothing once it closes.
 *
 * The camera is never moved. The operator is already looking at the incident; flying them somewhere
 * else to show them a camera would take away the thing they opened.
 */
import { Cartesian3, CustomDataSource, DistanceDisplayCondition, HeightReference, LabelStyle, NearFarScalar, VerticalOrigin, Color, Cartesian2 } from 'cesium';
import { assetIconMarker } from '../assetIdMarker.js';

const BILLBOARD = Object.freeze({
  verticalOrigin: VerticalOrigin.BOTTOM,
  heightReference: HeightReference.CLAMP_TO_GROUND,
  disableDepthTestDistance: Number.POSITIVE_INFINITY,
  scaleByDistance: new NearFarScalar(400, 1, 12000, 0.7),
});

/**
 * @param {import('cesium').Viewer} viewer
 * @returns {{show: (cameras: object[]) => void, hide: () => void, destroy: () => void}}
 */
export function createCameraSpotlight(viewer) {
  const source = new CustomDataSource('Incident Cameras');
  const added = viewer.dataSources.add(source);
  let shownKey = '';
  let disposed = false;

  function show(cameras) {
    if (disposed) return;
    const list = (cameras ?? []).filter(camera => Number.isFinite(camera?.longitude) && Number.isFinite(camera?.latitude));
    // Redrawing the same four markers on every render would churn the scene for no visible change.
    const key = list.map(camera => camera.id).join(',');
    if (key === shownKey) return;
    shownKey = key;
    source.entities.removeAll();
    for (const camera of list) {
      const marker = assetIconMarker('camera');
      source.entities.add({
        id: `incident-camera-${camera.id}`,
        name: `Cam ${camera.id}`,
        position: Cartesian3.fromDegrees(camera.longitude, camera.latitude),
        billboard: { ...BILLBOARD, ...marker },
        // The name the tab uses for it, so an operator can match a row to a place without counting.
        label: {
          text: `Cam ${camera.id}`,
          font: '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          fillColor: Color.WHITE,
          outlineColor: Color.fromCssColorString('#0b1729'),
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.BOTTOM,
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          pixelOffset: new Cartesian2(0, -46),
          // Past this the corridor is too far away for four labels to be readable rather than noise.
          distanceDisplayCondition: new DistanceDisplayCondition(0, 14000),
        },
      });
    }
    viewer.scene.requestRender();
  }

  function hide() {
    if (disposed || !shownKey) return;
    shownKey = '';
    source.entities.removeAll();
    viewer.scene.requestRender();
  }

  return {
    show,
    hide,
    destroy() {
      disposed = true;
      void added.then(() => viewer.dataSources.remove(source, true)).catch(() => {});
    },
  };
}
