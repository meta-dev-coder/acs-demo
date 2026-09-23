/**
 * Adapters from the existing Cesium layers to normalized assets.
 *
 * Each source knows three things and nothing more: how to read its layer's records into the common
 * shape, how to highlight one of them in the scene, and how to report what the user picked on the
 * map. Everything else — what a card shows, how the camera moves, what the details panel says —
 * lives in assetTypes.js and cesiumAssetNavigation.js, so a new asset type does not come back here.
 */
import { focusHeadingFor, MODEL_LAYERS } from '../corridorModelLayers.js';
import { normalizeAsset } from './assetTypes.js';
import { liveEventLabel } from '../liveEventsData.js';
import { centerlineDistances } from './corridorPosition.js';
import { SELECTION_SOURCES } from './assetSelectionStore.js';

/** Long/lat out of whatever geometry a Cesium entity was built from. */
const layerLabel = layerId => MODEL_LAYERS.find(layer => layer.id === layerId)?.label ?? null;

/**
 * @param {object} deps  the installed layer handles — any may be absent, and that type is skipped
 * @returns {{assetType: string, read: () => object[], highlight: (id: string|null) => void,
 *            listen: (report: (asset: object|null) => void) => void, own: (owned: boolean) => void}[]}
 */
export function createAssetSources({ corridorModels, cameras, bridges, signals, messageSigns, lighting, liveEvents, signStructures, centerline, modelConfigs = [] }) {
  const distances = centerline?.length ? centerlineDistances(centerline) : null;
  const normalize = input => normalizeAsset(input, centerline, distances);
  const sources = [];

  // Each placed-model layer becomes its own asset type: a gantry and a barrier arm are different
  // assets, and the Map Explorer already treats them as different layers.
  const MODEL_LAYER_TYPES = Object.freeze({ gantries: 'gantry', 'lane-barriers': 'laneBarrier' });
  for (const [layerId, assetType] of corridorModels ? Object.entries(MODEL_LAYER_TYPES) : []) {
    sources.push({
      assetType,
      group: 'corridorModels',
      read: () => modelConfigs
        .filter(config => config.layer === layerId && config.enabled !== false)
        .map(config => normalize({
          id: config.id, assetType, name: config.name,
          longitude: config.longitude, latitude: config.latitude,
          // A placed model sits at the height the scene sampled for it, which is what a close view
          // should look at: the corridor's nominal ground is only the fallback for assets that are
          // clamped rather than placed.
          geometry: placedHeight(corridorModels, config.id),
          // The bearing to view this model from already has one definition in the app — the layer's
          // viewOffsetDeg, with a per-model viewHeading override. Reused rather than re-derived, so
          // the explorer frames a gantry exactly as the existing focus does.
          source: { ...config, layerLabel: layerLabel(config.layer), viewHeadingDeg: focusHeadingFor(config) },
        })),
      highlight: id => corridorModels.highlightById(id),
      // One module serves both model layers. A pick that belongs to the other layer is not this
      // source's to report AT ALL — reporting null for it would read as "the user deselected" and
      // wipe the selection the other source has just made. Only a genuine clear reports null.
      listen: report => corridorModels.onSelection(config => {
        if (config && config.layer !== layerId) return;
        report(config ? String(config.id) : null);
      }),
      own: owned => corridorModels.setExternallyOwned(owned),
      silence: () => corridorModels.onSelection(null),
    });
  }

  if (lighting) {
    // ~2,900 records, re-read on every category toggle. Each is projected onto the centerline once
    // and the same frozen object is reused, so a toggle is a filter and memoized cards stay memoized.
    const normalized = new WeakMap();
    const asAsset = record => {
      let asset = normalized.get(record);
      if (!asset) {
        asset = normalize({
          id: record.id, assetType: 'lighting', name: `Lighting ${record.id}`,
          longitude: record.longitude, latitude: record.latitude,
          source: { categoryId: record.categoryId, categoryLabel: record.categoryLabel, record: record.source },
        });
        normalized.set(record, asset);
      }
      return asset;
    };
    sources.push({
      assetType: 'lighting', group: 'lighting',
      read: () => {
        if (lighting.error) throw lighting.error;
        return lighting.visibleRecords().map(asAsset);
      },
      // Search looks through every category, not just the ones switched on…
      readAll: () => lighting.allRecords().map(asAsset),
      // …and switches on only the category the asset belongs to.
      layerFor: asset => asset.source?.categoryId ?? 'lighting',
      highlight: id => lighting.highlightById(id),
      listen: report => lighting.onSelection(report), own: () => {}, silence: () => lighting.onSelection(null),
    });
  }

  if (messageSigns) {
    sources.push({
      assetType: 'messageSign', group: 'messageSigns', usesLegacyPanel: true,
      read: () => {
        if (messageSigns.error) throw messageSigns.error;
        return [...messageSigns.records.values()].map(record => normalize({
          id: record.id, assetType: 'messageSign', name: record.title,
          longitude: record.longitude, latitude: record.latitude, source: record,
        }));
      },
      highlight: id => id == null ? messageSigns.clearSelection() : messageSigns.selectById(id),
      listen: report => messageSigns.onSelection(record => report(record?.id ?? null)),
      own: () => {},
      silence: () => messageSigns.onSelection(null),
    });
  }

  if (cameras) {
    sources.push({
      assetType: 'camera',
      group: 'cameras',
      read: () => [...cameras.cameraById.entries()].map(([id, entity]) => {
        const record = cameras.records.get(entity) ?? {};
        const position = entity.position?.getValue?.();
        const carto = position ? cartographicDegrees(position) : null;
        return normalize({
          id, assetType: 'camera',
          // The feed's own title when it has one; the stable FDOT id otherwise. Never a made-up name.
          name: String(record.title || '').trim() || `Camera ${id}`,
          longitude: carto?.longitude, latitude: carto?.latitude,
          source: record,
        });
      }),
      // A camera's own panel is the details surface, so both selecting and clearing go through the
      // layer rather than through a bare highlight. Clearing via highlightById() alone restyled the
      // billboard but left the panel open, which is how a camera's details survived a switch to
      // another asset type.
      usesLegacyPanel: true,
      highlight: id => (id == null ? cameras.clearSelection() : cameras.selectCamera(id)),
      listen: report => cameras.onSelection(record => report(record ? String(record.camera_id) : null)),
      own: owned => cameras.setExternallyOwned(owned),
      silence: () => cameras.onSelection(null),
    });
  }

  if (bridges) {
    sources.push({
      assetType: 'bridge',
      group: 'bridges',
      read: () => [...bridges.bridgeById.entries()].map(([id, entity]) => {
        const structure = bridges.records.get(entity) ?? {};
        const positions = entity.polyline?.positions?.getValue?.() ?? null;
        const midpoint = positions?.length ? positions[Math.floor(positions.length / 2)] : entity.position?.getValue?.();
        const carto = midpoint ? cartographicDegrees(midpoint) : null;
        return normalize({
          id, assetType: 'bridge', name: structure.displayName ?? structure.display_name ?? `Bridge ${id}`,
          longitude: carto?.longitude, latitude: carto?.latitude,
          milepost: bridgeMidPost(structure),
          // A bridge is a span, so its own geometry frames the close view rather than a point.
          geometry: positions?.length ? { positions } : null,
          source: structure,
        });
      }),
      highlight: id => bridges.highlightById(id),
      listen: report => bridges.onSelection(structure => report(structure ? String(structure.assetId ?? structure.asset_id) : null)),
      own: owned => bridges.setExternallyOwned(owned),
      silence: () => bridges.onSelection(null),
    });
  }

  if (signals) {
    sources.push({
      assetType: 'signal',
      group: 'signals',
      usesLegacyPanel: true,
      read: () => [...signals.trafficSignalById.entries()].map(([id, entity]) => {
        const record = signals.records.get(entity) ?? {};
        const carto = pointOf(entity);
        return normalize({
          id, assetType: 'signal',
          name: text(record.cross_street) ? `Signal at ${record.cross_street}` : `Signal ${id}`,
          longitude: carto?.longitude, latitude: carto?.latitude,
          milepost: Number(record.begin_post),
          source: record,
        });
      }),
      highlight: id => (id == null ? signals.clearSelection() : signals.selectById(id)),
      listen: report => signals.onSelection(record => report(record ? String(record.signal_id) : null)),
      own: () => {},
      silence: () => signals.onSelection(null),
    });
  }

  // Incidents and closures come from one feed but are separate layers and separate asset types.
  for (const [assetType, eventType] of liveEvents
    ? [['incident', 'INCIDENT'], ['closure', 'CLOSURE']] : []) {
    sources.push({
      assetType,
      usesLegacyPanel: true,
      group: 'liveEvents',
      read: () => [...liveEvents.entityById.entries()]
        .map(([id, entity]) => [id, entity, liveEvents.records.get(entity)])
        .filter(([, , event]) => event?.type === eventType)
        .map(([id, entity, event]) => {
          const carto = pointOf(entity);
          return normalize({
            id, assetType, name: liveEventLabel(event),
            longitude: carto?.longitude, latitude: carto?.latitude,
            source: event,
          });
        }),
      highlight: id => (id == null ? liveEvents.clearSelection() : liveEvents.selectById(id)),
      listen: report => liveEvents.onSelection(event => {
        if (event && event.type !== eventType) return;   // the other feed's pick, not ours
        report(event ? String(event.id) : null);
      }),
      own: () => {},
      silence: () => liveEvents.onSelection(null),
    });
  }

  // The three FDOT sign-structure types share one module, so each becomes its own source over the
  // same handle — a type is a data entry here, not another branch.
  for (const typeId of signStructures ? ['overlane', 'cantilever', 'unclassified'] : []) {
    sources.push({
      assetType: typeId,
      group: 'signStructures',
      usesLegacyPanel: true,
      read: () => signStructures.recordsFor(typeId).map(record => normalize({
        id: record.id, assetType: typeId, name: record.id,
        longitude: record.longitude, latitude: record.latitude,
        milepost: record.milepost,
        source: record,
      })),
      highlight: id => (id == null ? signStructures.clearSelection() : signStructures.selectById(typeId, id)),
      // One module serves all three types; a pick belonging to another type is not ours to report.
      listen: report => signStructures.onSelection(record => {
        if (record && record.typeId !== typeId) return;
        report(record ? String(record.id) : null);
      }),
      own: () => {},
      silence: () => signStructures.onSelection(null),
    });
  }

  return sources;
}

/** Where a placed model actually stands, as geometry the camera can frame. */
function placedHeight(corridorModels, id) {
  const position = corridorModels?.entityById?.get(String(id))?.position?.getValue?.();
  const height = position ? cartographicDegrees(position)?.height : null;
  return Number.isFinite(height) ? { height } : null;
}

/** An entity's position in degrees, whatever geometry it was built from. */
function pointOf(entity) {
  const position = entity?.position?.getValue?.();
  return position ? cartographicDegrees(position) : null;
}

const text = value => {
  const string = value == null ? '' : String(value).trim();
  return string && string.toUpperCase() !== 'N/A' ? string : null;
};

/**
 * West to east along the corridor, so Next means "the next one down the road" rather than whatever
 * order the dataset happened to load in. Assets with no usable position keep their original order
 * at the end rather than being dropped or given an invented one.
 */
export function inCorridorOrder(assets) {
  const positioned = assets.filter(asset => Number.isFinite(asset.corridorFraction));
  const rest = assets.filter(asset => !Number.isFinite(asset.corridorFraction));
  positioned.sort((a, b) => a.corridorFraction - b.corridorFraction || a.id.localeCompare(b.id));
  return [...positioned, ...rest];
}

function bridgeMidPost(structure) {
  const begin = Number(structure?.beginPost ?? structure?.begin_post);
  const end = Number(structure?.endPost ?? structure?.end_post);
  if (Number.isFinite(begin) && Number.isFinite(end)) return (begin + end) / 2;
  return Number.isFinite(begin) ? begin : (Number.isFinite(end) ? end : null);
}

/** Lazily bound so this module stays importable without a Cesium scene in unit tests. */
let cartographicDegrees = position => {
  throw new Error('bindCartographic() must be called before reading asset coordinates');
};

/** Cesium is injected rather than imported so the pure parts stay unit-testable. */
export function bindCartographic(fn) { cartographicDegrees = fn; }

/**
 * Wire sources to the store in both directions and keep them in step.
 * @returns {() => void} teardown
 */
export function connectAssetSources(store, sources, { logger = console } = {}) {
  const byType = new Map(sources.map(source => [source.assetType, source]));

  // Applying a selection to the layers makes them report back — a layer being cleared says "nothing
  // is selected here", which is indistinguishable from the user deselecting on the map. Selecting a
  // bridge clears the camera layer, whose report then wiped the bridge that had just been selected.
  // Reports are therefore ignored while we are the ones driving.
  let applying = false;

  for (const source of sources) {
    store.setAssets(source.assetType, []);
    // A map pick is a selection like any other; it arrives here rather than opening its own panel.
    source.listen(id => {
      if (applying) return;
      if (id == null) { store.selectAsset(null, SELECTION_SOURCES.CESIUM); return; }
      const asset = (store.getState().assetsByType[source.assetType] ?? []).find(candidate => candidate.id === id);
      if (asset) store.selectAsset(asset, SELECTION_SOURCES.CESIUM);
      else logger.warn?.(`[asset-explorer] picked ${source.assetType} ${id} is not in the normalized list`);
    });
  }

  let lastSelectedId = null;
  const unsubscribe = store.subscribe(state => {
    const selected = state.selectedAsset;
    const key = selected ? `${selected.assetType}:${selected.id}` : null;
    if (key === lastSelectedId) return;
    lastSelectedId = key;
    // Exactly one layer shows a highlight at a time, so switching types clears the old one.
    // Several asset types can be backed by ONE layer module — gantries and lane barriers, the three
    // sign-structure types, incidents and closures. Clearing a sibling would clear the module the
    // selected type has just set, which is how selecting an overlane structure closed the very
    // details panel it had opened. Only sources from other modules are cleared.
    const selectedGroup = selected ? byType.get(selected.assetType)?.group : null;
    applying = true;
    try {
      for (const [assetType, source] of byType) {
        if (selected?.assetType === assetType) { source.highlight(selected.id); continue; }
        if (selectedGroup && source.group === selectedGroup) continue;
        source.highlight(null);
      }
    } finally {
      applying = false;
    }
  });

  return () => {
    unsubscribe();
    for (const source of byType.values()) { source.own(false); source.silence(); }
  };
}

/** Re-read every source into the store — after a layer finishes loading, for instance. */
export function refreshAssets(store, sources, { logger = console } = {}) {
  for (const source of sources) {
    try {
      store.setAssets(source.assetType, inCorridorOrder(source.read()));
      store.setStatus(source.assetType, { loading: false, error: null });
    } catch (error) {
      logger.warn?.(`[asset-explorer] could not read ${source.assetType}`, error);
      store.setStatus(source.assetType, { loading: false, error: String(error?.message ?? error) });
    }
  }
}
