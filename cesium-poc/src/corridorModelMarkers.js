/**
 * Map pins for the GLB models, so a gantry or a barrier can be found from a corridor-wide view.
 *
 * The same idea as the bridge pins in bridgeZoomMarkers.js, but for point assets rather than
 * extents: a model 20 m across is a couple of pixels from 10 km up, so beyond a threshold the mesh
 * is replaced by a pin and the pin is what the user clicks. The pin lives on the model's own entity,
 * so it shares that entity's identity, picking and visibility — there is nothing extra to keep in
 * step, and a click on the pin picks the model.
 */
import { Cartesian3, HeightReference, VerticalOrigin } from 'cesium';

/** Distances at which the pin replaces the mesh. Hysteresis, so a slow zoom cannot flicker. */
export const PIN_SHOW_FROM_M = 900;
export const PIN_HIDE_BELOW_M = 700;

const pin = (fill, glyph) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="58" viewBox="0 0 48 58">
<path d="M24 56C18 56 2 37 2 24a22 22 0 1 1 44 0c0 13-16 32-22 32Z" fill="white"/>
<circle cx="24" cy="24" r="18.5" fill="${fill}"/>
<g fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${glyph}</g></svg>`)}`;

/**
 * One pin per model layer, drawn to read at pin size: an overhead gantry is a portal over the road,
 * a barrier is a post with a boom across it.
 */
export const MODEL_LAYER_PINS = Object.freeze({
  gantries: pin('#2f8f7d', '<path d="M13 33V17h22v16"/><path d="M13 20h22"/><path d="M18 20v5M24 20v5M30 20v5"/><path d="M11 33h4M33 33h4"/>'),
  'lane-barriers': pin('#d9822b', '<path d="M16 34V16"/><path d="M12 34h8"/><path d="M16 21h20"/><path d="M22 21v3M28 21v3M34 21v3"/>'),
});

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{entity: import('cesium').Entity, layer: string}[]} models
 * @param {{onSelect?: (entity: import('cesium').Entity) => void}} [options]
 */
export function installCorridorModelMarkers(viewer, models) {
  const pinned = models.map(({ entity, layer }) => {
    entity.billboard = {
      image: MODEL_LAYER_PINS[layer] ?? MODEL_LAYER_PINS.gantries,
      width: 34, height: 41, verticalOrigin: VerticalOrigin.BOTTOM,
      heightReference: HeightReference.CLAMP_TO_GROUND,
      // Photogrammetry would otherwise bury a pin standing on the road deck.
      disableDepthTestDistance: Number.POSITIVE_INFINITY, show: false,
    };
    return { entity, anchor: entity.position.getValue(viewer.clock.currentTime), visible: false };
  });

  const update = () => {
    let changed = false;
    for (const model of pinned) {
      const distance = Cartesian3.distance(viewer.camera.positionWC, model.anchor);
      const visible = model.entity.show && distance > (model.visible ? PIN_HIDE_BELOW_M : PIN_SHOW_FROM_M);
      if (visible === model.visible) continue;
      model.visible = visible;
      model.entity.billboard.show = visible;
      changed = true;
    }
    if (changed) viewer.scene.requestRender();
  };
  const remove = viewer.scene.preRender.addEventListener(update);
  update();

  return {
    /** Highlight state is the pin's scale, exactly as the bridge pins do it. */
    setSelected(entity) {
      for (const model of pinned) model.entity.billboard.scale = model.entity === entity ? 1.18 : 1;
      viewer.scene.requestRender();
    },
    isPinVisible: entity => pinned.find(model => model.entity === entity)?.visible ?? false,
    destroy: remove,
  };
}
