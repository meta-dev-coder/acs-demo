/**
 * One pick dispatcher for the whole map.
 *
 * Every selectable layer registers here instead of attaching its own ScreenSpaceEventHandler.
 * With a handler each, Cesium delivers the click to all of them, so clicking a building would
 * also tell the road layer "nothing was picked" and clear the road selection — two layers quietly
 * fighting over one gesture. Here a click is picked ONCE and routed to whichever layer owns the
 * entity, so a building click cannot touch a road and vice versa.
 *
 * Hover is pushed straight into the owning layer rather than through React: the pointer moves on
 * every frame and that must not re-render a tree.
 */
import { ScreenSpaceEventHandler, ScreenSpaceEventType } from 'cesium';

/**
 * @typedef {object} PickableLayer
 * @property {string} kind       what this layer selects, e.g. 'road' or 'building'
 * @property {string} idPrefix   entity-id prefix, e.g. 'road-'
 * @property {(entityId: string) => number|null} parseId  entity id -> the layer's own identifier
 * @property {(id: number|null) => void} setHovered
 * @property {() => boolean} isPickable   false while the layer is hidden
 */

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{onSelect?: (hit: {kind: string, id: number}|null) => void}} [hooks]
 */
export function createMapPicker(viewer, { onSelect } = {}) {
  /** @type {PickableLayer[]} */
  const layers = [];
  let hovered = null;   // {kind, id}

  /** Which layer owns this pick, and what it calls the thing picked. */
  function resolve(picked) {
    const entityId = picked?.id?.id;
    if (typeof entityId !== 'string') return null;
    for (const layer of layers) {
      if (!layer.isPickable() || !entityId.startsWith(layer.idPrefix)) continue;
      const id = layer.parseId(entityId);
      if (id !== null) return { kind: layer.kind, id };
    }
    return null;
  }

  const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);

  handler.setInputAction(({ position }) => {
    onSelect?.(resolve(viewer.scene.pick(position)));
  }, ScreenSpaceEventType.LEFT_CLICK);

  handler.setInputAction(({ endPosition }) => {
    const hit = resolve(viewer.scene.pick(endPosition));
    if (hit?.kind === hovered?.kind && hit?.id === hovered?.id) return;
    // Clear the layer that was hovered, then set the one that now is. Clearing every layer on
    // every move would repaint layers that had nothing hovered in the first place.
    if (hovered) layers.find(l => l.kind === hovered.kind)?.setHovered(null);
    if (hit) layers.find(l => l.kind === hit.kind)?.setHovered(hit.id);
    hovered = hit;
    viewer.scene.canvas.style.cursor = hit ? 'pointer' : '';
    viewer.scene.requestRender();
  }, ScreenSpaceEventType.MOUSE_MOVE);

  return {
    /** Registered last is matched first, so a layer added later sits "on top" for picking. */
    register(layer) {
      layers.unshift(layer);
      return () => {
        const index = layers.indexOf(layer);
        if (index >= 0) layers.splice(index, 1);
        if (hovered?.kind === layer.kind) { hovered = null; viewer.scene.canvas.style.cursor = ''; }
      };
    },
    destroy() {
      handler.destroy();
      layers.length = 0;
      if (!viewer.isDestroyed()) viewer.scene.canvas.style.cursor = '';
    },
  };
}
