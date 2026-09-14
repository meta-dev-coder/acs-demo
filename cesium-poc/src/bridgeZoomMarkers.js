import { Cartesian3, HeightReference, VerticalOrigin } from 'cesium';

// Vector recreation of the reference: a white-edged red map pin with a bridge glyph.
const ICON = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="58" viewBox="0 0 48 58">
<path d="M24 56C18 56 2 37 2 24a22 22 0 1 1 44 0c0 13-16 32-22 32Z" fill="white"/>
<circle cx="24" cy="24" r="18.5" fill="#ed4437"/>
<g fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
<path d="M14 29h20M17 15v20M31 15v20M14 35h6m8 0h6M14 21c2 0 3-3 3-6 2 9 12 9 14 0 0 3 1 6 3 6M21 23v6m6-6v6M14 24v5m20-5v5"/>
</g></svg>`)}`;

const iconsByCount = new Map([[1, ICON]]);
function iconForCount(count) {
  if (!iconsByCount.has(count)) {
    const svg = decodeURIComponent(ICON.slice(ICON.indexOf(',') + 1));
    const badge = `<circle cx="38" cy="10" r="9" fill="#17263b" stroke="white" stroke-width="2"/><text x="38" y="14" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" font-weight="bold" fill="white">${count}</text>`;
    iconsByCount.set(count, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace('</svg>', `${badge}</svg>`))}`);
  }
  return iconsByCount.get(count);
}

function midpoint(positions) {
  const lengths = positions.slice(1).map((p, i) => Cartesian3.distance(positions[i], p));
  let remaining = lengths.reduce((sum, value) => sum + value, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i] && lengths[i] > 0) return Cartesian3.lerp(positions[i], positions[i + 1], remaining / lengths[i], new Cartesian3());
    remaining -= lengths[i];
  }
  return Cartesian3.clone(positions[0]);
}

/** Use viewing distance rather than extent length so long and short bridges follow
 * the same rule. Distant bridges in tilted views retain their pins. Hysteresis avoids flickering.
 * Billboard and polyline share the original bridge entity, identity and visibility.
 */
export function installBridgeZoomMarkers(viewer, entities) {
  const groups = new Map(), groupByEntity = new Map();
  const bridges = entities.map(entity => {
    const positions = entity.polyline.positions.getValue(viewer.clock.currentTime);
    const anchor = midpoint(positions);
    entity.position = anchor;
    entity.billboard = {
      image: ICON, width: 38, height: 46, verticalOrigin: VerticalOrigin.BOTTOM,
      heightReference: HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY, show: false,
    };
    // Only share a marker for exactly matching supplied geometry (including reversed order).
    // Individual entities, properties, polylines, and visibility remain independent.
    const forward = JSON.stringify(positions.map(p => [p.x, p.y, p.z]));
    const reverse = JSON.stringify([...positions].reverse().map(p => [p.x, p.y, p.z]));
    const key = forward < reverse ? forward : reverse;
    if (!groups.has(key)) groups.set(key, []);
    const bridge = { entity, anchor, iconVisible: false };
    groups.get(key).push(bridge); groupByEntity.set(entity, groups.get(key));
    return bridge;
  });
  const update = () => {
    for (const bridge of bridges) {
      if (!bridge.entity.show) continue;
      const distance = Cartesian3.distance(viewer.camera.positionWC, bridge.anchor);
      const visible = distance > (bridge.iconVisible ? 3000 : 3500);
      if (visible !== bridge.iconVisible) {
        bridge.iconVisible = visible;
        viewer.scene.requestRender();
      }
    }
    for (const group of groups.values()) {
      const visible = group.filter(bridge => bridge.entity.show);
      const representative = visible.find(bridge => bridge.entity.polyline.width.getValue() === 7) || visible[0];
      for (const bridge of group) {
        const show = bridge === representative && bridge.iconVisible;
        if (bridge.entity.billboard.show.getValue() !== show) bridge.entity.billboard.show = show;
      }
      if (representative) representative.entity.billboard.image = iconForCount(visible.length);
    }
  };
  const remove = viewer.scene.preRender.addEventListener(update);
  update();
  return {
    membersFor: entity => (groupByEntity.get(entity) || []).map(bridge => bridge.entity).filter(item => item.show),
    destroy: remove,
  };
}
