/**
 * Cruise-driven parking on the map: garages coloured by simulated utilisation, active terminals
 * outlined, and one compact label each.
 *
 * VERIFIED GEOMETRY ONLY. A garage or terminal is drawn only where the planner's geometry resolver
 * returns an authoritative or confirmed footprint. Anything without one is listed in the panel as
 * "no confirmed footprint" and simply not drawn — no coordinate is invented to put it on the map.
 *
 * NO INVENTED ROUTES. Vehicle movements are shown as counts on each garage's label (↓ leaving,
 * ↑ entering), not as arrows along roads: the twin holds no configured access route from a
 * terminal to its garages, and an arrow drawn between two footprints would cross buildings and
 * water as if it were a road.
 *
 * Everything is draped on the photogrammetry and redrawn as one source, so a change of time,
 * date or alternative replaces what is drawn rather than adding to it.
 */
import {
  BoundingSphere, Cartesian3, ClassificationType, Color, CustomDataSource, HeadingPitchRange, Math as CesiumMath, PolygonHierarchy, SceneTransforms,
} from 'cesium';

const LABEL_HEIGHT_M = 20;
const GROUND_M = -24.8;

export const UTILISATION_COLOUR = Object.freeze({ GREEN: '#22A35A', AMBER: '#F0B429', RED: '#E53935', UNKNOWN: '#8A94A6' });

export function utilisationColour(pct, { amber = 70, red = 90 } = {}) {
  if (!Number.isFinite(pct)) return UTILISATION_COLOUR.UNKNOWN;
  return pct >= red ? UTILISATION_COLOUR.RED : pct >= amber ? UTILISATION_COLOUR.AMBER : UTILISATION_COLOUR.GREEN;
}

const centroid = rings => {
  const ring = rings[0] ?? [];
  const n = Math.max(1, ring.length - 1);
  let x = 0, y = 0;
  for (let i = 0; i < n; i += 1) { x += ring[i][0]; y += ring[i][1]; }
  return [x / n, y / n];
};

export function installCruiseParkingLayer(viewer) {
  const source = new CustomDataSource('portmiami-cruise-parking');
  viewer.dataSources.add(source);
  const host = document.createElement('div');
  host.className = 'cp-labels';
  viewer.container.appendChild(host);
  let labels = [];
  /** The footprints drawn, by facility id, for framing the camera on one. */
  let drawnFootprints = new Map();

  const drape = { classificationType: ClassificationType.BOTH };

  function polygon(id, footprint, fill, alpha, outline, width) {
    for (const [k, rings] of footprint.entries()) {
      source.entities.add({
        id: `${id}-fill-${k}`,
        polygon: {
          hierarchy: new PolygonHierarchy(Cartesian3.fromDegreesArray(rings[0].flat()),
            rings.slice(1).map(h => new PolygonHierarchy(Cartesian3.fromDegreesArray(h.flat())))),
          material: Color.fromCssColorString(fill).withAlpha(alpha), ...drape,
        },
      });
      source.entities.add({
        id: `${id}-edge-${k}`,
        polyline: {
          positions: Cartesian3.fromDegreesArray(rings[0].flat()), width, clampToGround: true, ...drape,
          material: Color.fromCssColorString(outline),
        },
      });
    }
  }

  function label(kind, rings, title, lines, colour, selected) {
    const [lon, lat] = centroid(rings[0]);
    const node = document.createElement('div');
    node.className = `cp-label is-${kind}${selected ? ' is-selected' : ''}`;
    const swatch = document.createElement('i');
    swatch.style.background = colour;
    const text = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = title;
    text.append(b, ...lines.map(line => { const e = document.createElement('em'); e.textContent = line; return e; }));
    node.append(swatch, text);
    host.appendChild(node);
    labels.push({ node, world: Cartesian3.fromDegrees(lon, lat, GROUND_M + LABEL_HEIGHT_M), selected });
  }

  /** Place labels; one that would cover another (or the panels) is hidden, selected first. */
  function place() {
    const box = viewer.container.getBoundingClientRect();
    // With the simulation workspace open, the planner's panels sit under its backdrop: only the
    // workspace's own overlays can cover a label.
    const scope = document.querySelector('.cw-shell') ?? document;
    const placed = [...scope.querySelectorAll('[data-label-obstacle]')].map(n => {
      const r = n.getBoundingClientRect();
      return { l: r.left - box.left, r: r.right - box.left, t: r.top - box.top, b: r.bottom - box.top };
    });
    for (const l of [...labels].sort((a, b) => Number(b.selected) - Number(a.selected))) {
      const at = SceneTransforms.worldToWindowCoordinates(viewer.scene, l.world);
      if (!at) { l.node.hidden = true; continue; }
      l.node.hidden = false;
      l.node.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
      const w = l.node.offsetWidth, h = l.node.offsetHeight;
      const me = { l: at.x - w / 2, r: at.x + w / 2, t: at.y - h - 8, b: at.y };
      const clear = placed.every(o => me.r < o.l || me.l > o.r || me.b < o.t || me.t > o.b);
      l.node.hidden = !clear;
      if (clear) placed.push(me);
    }
  }
  const onPostRender = () => place();
  viewer.scene.postRender.addEventListener(onPostRender);

  return {
    /**
     * Draw one state of the simulation.
     *
     * @param {{facilities: object[], terminals: object[]}} model  each item carries `footprints`
     *   (arrays of rings), a title, label lines, a colour and whether it is selected
     */
    show(model) {
      source.entities.removeAll();
      host.replaceChildren();
      labels = [];
      for (const t of model?.terminals ?? []) {
        polygon(`cp-terminal-${t.code}`, t.footprints, '#18E0FF', t.selected ? 0.4 : 0.22, t.selected ? '#1769E0' : '#18E0FF', t.selected ? 4 : 2.5);
        label('terminal', t.footprints, t.title, t.lines, '#18E0FF', t.selected);
      }
      drawnFootprints = new Map((model?.facilities ?? []).map(f => [f.id, f.footprints]));
      for (const f of model?.facilities ?? []) {
        // Selected garage: thick blue outline; eligible for the selected cruise: cyan; others white.
        polygon(`cp-facility-${f.id}`, f.footprints, f.colour, 0.55, f.selected ? '#1769E0' : f.eligible ? '#18E0FF' : '#ffffff', f.selected ? 5 : f.eligible ? 3.5 : 2);
        label(`facility${f.eligible ? ' is-eligible' : ''}`, f.footprints, f.title, f.lines, f.colour, f.selected);
      }
      viewer.scene.requestRender();
    },
    clear() {
      drawnFootprints = new Map();
      source.entities.removeAll();
      host.replaceChildren();
      labels = [];
      if (!viewer.isDestroyed()) viewer.scene.requestRender();
    },
    /** Fly to a drawn garage's footprint; false when it is not drawn (no confirmed footprint). */
    focusFacility(id) {
      const footprints = drawnFootprints.get(id);
      if (!footprints?.length || viewer.isDestroyed()) return false;
      // Frame the footprint itself at ground level. A draped polygon's own bounding volume spans
      // every possible terrain height, so flying to the entity aims at a point far above the
      // garage and leaves it at the bottom of the view.
      const points = footprints.flatMap(rings => rings[0].map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat, GROUND_M)));
      const sphere = BoundingSphere.fromPoints(points);
      // Close enough to read the garage and its label, looking down at 40°, keeping the heading.
      viewer.camera.flyToBoundingSphere(sphere, {
        duration: 1.2,
        offset: new HeadingPitchRange(viewer.camera.heading, CesiumMath.toRadians(-40), Math.max(420, sphere.radius * 6)),
      });
      return true;
    },
    /** Fly to a drawn terminal's footprint; false when it is not drawn (no confirmed footprint). */
    focusTerminal(code) {
      if (!code) return false;
      const targets = source.entities.values.filter(e => String(e.id).startsWith(`cp-terminal-${code}-fill`));
      if (!targets.length || viewer.isDestroyed()) return false;
      viewer.flyTo(targets, { duration: 1.2 });
      return true;
    },
    /**
     * A pickable layer for the app's shared map picker: a click on a drawn garage selects it.
     * `isPickable` lets the owner limit picking to when the simulation workspace is open.
     */
    pickable(isPickable) {
      return {
        kind: 'cruise-garage',
        idPrefix: 'cp-facility-',
        parseId: entityId => entityId.replace(/^cp-facility-/, '').replace(/-(fill|edge)-\d+$/, '') || null,
        setHovered: id => { viewer.scene.canvas.style.cursor = id ? 'pointer' : ''; },
        isPickable,
      };
    },
    entityCount: () => source.entities.values.length,
    destroy() {
      host.remove();
      if (!viewer.isDestroyed()) {
        viewer.scene.postRender.removeEventListener(onPostRender);
        viewer.dataSources.remove(source, true);
      }
    },
  };
}
