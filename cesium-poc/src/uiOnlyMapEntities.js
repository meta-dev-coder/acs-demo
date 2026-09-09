/**
 * Display-only map furniture — route shields and geographic context labels.
 *
 * These are not corridor assets: they must never be selected, and — because they are drawn without
 * a depth test so photogrammetry cannot bury them — they must never swallow a click meant for what
 * lies underneath. Rather than teach six picking layers about them, this filters them out of
 * `scene.pick` and `scene.drillPick` once per viewer, so every existing hit test sees straight
 * through them and behaves exactly as it did before.
 */

/** @type {WeakMap<object, {entities: Set<object>, restore: () => void}>} */
const registries = new WeakMap();

function install(viewer) {
  const scene = viewer.scene;
  const entities = new Set();
  const owned = ['pick', 'drillPick'].map(name => [name, Object.getOwnPropertyDescriptor(scene, name)]);
  const basePick = scene.pick.bind(scene), baseDrillPick = scene.drillPick.bind(scene);
  const isUiOnly = hit => entities.has(hit?.id);

  scene.pick = (position, width, height) => {
    const picked = basePick(position, width, height);
    if (!isUiOnly(picked)) return picked;
    // Only ever reached when map furniture is topmost: fall through to whatever it covers.
    return baseDrillPick(position, entities.size + 1, width, height).find(hit => !isUiOnly(hit));
  };
  scene.drillPick = (position, limit, width, height) => {
    // Ask for the furniture's worth of extra hits so filtering can never eat the caller's limit.
    const hits = baseDrillPick(position, limit == null ? undefined : limit + entities.size, width, height).filter(hit => !isUiOnly(hit));
    return limit == null ? hits : hits.slice(0, limit);
  };

  const registry = {
    entities,
    restore() {
      for (const [name, descriptor] of owned) {
        if (descriptor) Object.defineProperty(scene, name, descriptor); else delete scene[name];
      }
      registries.delete(viewer);
    },
  };
  registries.set(viewer, registry);
  return registry;
}

/**
 * Exclude `entities` from every hit test on this viewer.
 * @returns {() => void} removes just these entities, restoring `scene.pick` once none are left.
 */
export function registerUiOnlyEntities(viewer, entities) {
  const registry = registries.get(viewer) ?? install(viewer);
  const registered = [...entities];
  for (const entity of registered) registry.entities.add(entity);
  return () => {
    for (const entity of registered) registry.entities.delete(entity);
    if (registry.entities.size === 0) registry.restore();
  };
}

/** Test/diagnostic hook: how many entities are currently hidden from picking. */
export const uiOnlyEntityCount = viewer => registries.get(viewer)?.entities.size ?? 0;
