/**
 * Maintenance records on the map.
 *
 * One data source for the whole workspace: only the type being browsed is drawn, so switching Work
 * Orders → Tickets swaps what is shown without touching the viewer, the terrain or the Google
 * tiles. Markers are the corridor's own ID markers (assetIdMarker.js) — charcoal for the rest,
 * the shared yellow for the selection — so a work order reads like every other asset on this map.
 *
 * Built the way the Lighting layer is: a location dot for every record, the ID marker for the ones
 * nearest the camera and for the selection, because a type can hold several hundred records.
 */
import { CustomDataSource, Cartesian2, Cartesian3, HeightReference, NearFarScalar, ScreenSpaceEventType, VerticalOrigin } from 'cesium';
import { assetDotMarker, assetIdMarker, assetPillMarker, assetPinMarker, assetSquareMarker } from '../assetIdMarker.js';
import { incidentVisual } from '../assetExplorer/incidentTypes.js';

export const LABEL_BUDGET = 60;
export const LABEL_RANGE_M = 4000;

const BILLBOARD = Object.freeze({
  verticalOrigin: VerticalOrigin.BOTTOM, heightReference: HeightReference.CLAMP_TO_GROUND,
  disableDepthTestDistance: Number.POSITIVE_INFINITY, scaleByDistance: new NearFarScalar(400, 1, 12000, 0.7),
});

const entityId = (assetType, id) => `maintenance-${assetType}-${id}`;

/** An incident's marker tone: the family's own colour and glyph, keyed for the texture cache. */
const incidentToneOf = item => {
  const { key, color, glyph, rotate } = incidentVisual(item.title);
  return { key, color, glyph, rotate };
};

/**
 * @param {import('cesium').Viewer} viewer
 * @returns {{setRecords: (assetType: string, records: object[]) => void, show: (assetType: string|null) => void,
 *            recordsFor: (assetType: string) => object[], highlightById: (id: string|null) => void,
 *            onSelection: (fn: ((id: string|null) => void)|null) => void, destroy: () => void}}
 */
export function installMaintenanceLayer(viewer) {
  const source = new CustomDataSource('Maintenance Records');
  const added = viewer.dataSources.add(source);
  // Records often share an asset — two work orders on one drainage structure sit at exactly the same
  // point. These markers are drawn without a depth test, so the one drawn last wins and nothing about
  // the selection would put it there. The selected marker is therefore drawn from its own data
  // source, added after the first, which is always on top and always the one a click finds.
  const selectionSource = new CustomDataSource('Maintenance Selection');
  const selectionAdded = viewer.dataSources.add(selectionSource);
  /** assetType -> { records, entities: Map<id, Entity>, drawn: Map<id, state> } */
  const layers = new Map();
  /**
   * "<assetType>:<recordId>" -> Entity, kept flat and persistent so anything decorating the map
   * (the priority pulses) can look a marker up per frame without rebuilding an index.
   */
  const byKey = new Map();
  const listeners = new Set();
  /**
   * A second, independent channel for map clicks.
   *
   * `listeners` belongs to the Asset Explorer's source for the browsed class, and its `silence()`
   * clears the whole set — so the workspace cannot share it without being switched off every time
   * the explorer changes class. Clicking a marker has to work for EVERY class, browsed or not.
   */
  const pickListeners = new Set();
  let active = null, selected = null, selectedType = null, labelled = new Set(), disposed = false;
  /**
   * Draw every loaded class at once rather than only the browsed one.
   *
   * The workspace switches this on: an operator wants the corridor's whole maintenance picture on
   * the map, not just whichever card they last clicked. `active` still means the BROWSED class —
   * it is what carries ID labels, what the list's search and filter narrow, and what Previous/Next
   * steps through. Everything else is drawn as quiet dots beside it.
   */
  let showAll = false;
  /** Whether this class should be on the map at all. */
  const typeShown = assetType => (showAll ? layers.has(assetType) : assetType === active);

  const layerOf = assetType => layers.get(assetType) ?? null;

  /**
   * The image one record's marker carries.
   *
   * Every class but the incidents answers "which record is this", so the ID pill is right for them.
   * An incident answers "what happened" — a fire and a flood spinout call for different responses —
   * so it is drawn as its family's coloured pin instead. A `tone` carrying a glyph IS an incident;
   * the string tones are the shared charcoal/live/damaged ones.
   */
  function markerFor(id, tone, state, caption = null) {
    // A caption belongs INSIDE the marker: the word IS the marker, rather than a second thing
    // floating beside it that drifts over whatever tile is underneath.
    if (caption) {
      return state === 'dot' ? assetDotMarker(tone)
        : assetPillMarker({ text: caption, color: tone?.color ?? '#eab308', selected: state === 'selected' });
    }
    if (tone?.glyph || tone?.glyphSvg) {
      // A class icon is drawn at Live Ops' pin weight (1.6×) so the corridor reads the same in both
      // workspaces; an incident's crash pictogram keeps the size it was designed at.
      return state === 'dot' ? assetDotMarker(tone)
        : tone.glyphSvg
          ? assetSquareMarker({ ...tone, selected: state === 'selected' })
          : assetPinMarker({ ...tone, selected: state === 'selected' });
    }
    return state === 'dot' ? assetDotMarker(tone) : assetIdMarker({ id, selected: state === 'selected', tone });
  }

  function present(assetType, id) {
    const layer = layerOf(assetType);
    const entity = layer?.entities.get(id);
    if (!entity) return;
    const isSelected = id === selected && assetType === selectedType;
    const tone = layer.tones.get(id);
    // An incident is drawn as its family's pictogram at EVERY zoom, not promoted from a dot once the
    // camera is within a few kilometres. The picture is the record's meaning — a fire and a flood
    // spinout call for different people — and a corridor-wide frame is exactly where an operator
    // reads that. The other classes keep the dot-until-near rule: a thousand work-order pins over
    // fifteen miles is a texture, not a map.
    const caption = layer.captions?.get(id) ?? null;
    const state = isSelected ? 'selected'
      : caption || tone?.glyph || tone?.glyphSvg ? 'id'
        : labelled.has(id) && assetType === active ? 'id' : 'dot';
    if (layer.drawn.get(id) === state) return;
    layer.drawn.set(id, state);
    // The selected one is drawn by the selection source instead, so it cannot end up behind a marker
    // it shares a position with. The list's search and filter narrow only the class being browsed;
    // the other classes are context and stay whole.
    entity.show = !isSelected && typeShown(assetType) && !hiddenBySelection(layer, id)
      && (assetType !== active || !layer.visible || layer.visible.has(id));
    const marker = markerFor(id, tone, state, caption);
    entity.billboard.image = marker.image;
    entity.billboard.width = marker.width;
    entity.billboard.height = marker.height;
  }

  /**
   * True for a marker standing on exactly the same point as the selected one. Drawn without a depth
   * test, two markers at one point are decided by draw order, which nothing here controls — so the
   * coincident ones stand down while the selection is there. They stay in the list either way.
   */
  function hiddenBySelection(layer, id) {
    if (!selected || id === selected || !layer.entities.has(selected)) return false;
    const key = [...(layer.atPoint ?? new Map())].find(([, ids]) => ids.includes(selected))?.[0];
    return Boolean(key && layer.atPoint.get(key)?.includes(id));
  }

  /** The one marker that is always on top: the selection, redrawn wherever it moves to. */
  function drawSelection() {
    selectionSource.entities.removeAll();
    const layer = layerOf(selectedType);
    const position = selected ? layer?.positions.get(selected) : null;
    if (!position) return;
    const marker = markerFor(selected, layer?.tones.get(selected), 'selected', layer?.captions?.get(selected) ?? null);
    selectionSource.entities.add({
      id: `maintenance-${selectedType}-${selected}`, name: selected, show: true, position,
      // A coincident group is spread in screen space. Keep the selected copy at the original
      // marker's offset as it moves to the top data source, otherwise it jumps to the centre.
      billboard: { ...BILLBOARD, ...marker, scale: 1.08, pixelOffset: layer?.offsets.get(selected) ?? Cartesian2.ZERO },
    });
  }

  /** The nearest records carry their ID; the rest stay dots, so a dense corridor stays readable. */
  function updateLabels() {
    const layer = layerOf(active);
    if (!layer || disposed) return;
    const eye = viewer.camera.positionWC;
    const near = [];
    for (const record of layer.records) {
      const position = layer.positions.get(record.id);
      if (!position) continue;
      const distance = Cartesian3.distance(eye, position);
      if (!layer.entities.get(record.id)?.show && record.id !== selected) continue;
      if (distance <= LABEL_RANGE_M) near.push([distance, record.id]);
    }
    near.sort((a, b) => a[0] - b[0]);
    const next = new Set(near.slice(0, LABEL_BUDGET).map(([, id]) => id));
    const changed = [...labelled].filter(id => !next.has(id)).concat([...next].filter(id => !labelled.has(id)));
    if (!changed.length) return;
    labelled = next;
    for (const id of changed) present(active, id);
    viewer.scene.requestRender();
  }
  const removeMoveEnd = viewer.camera.moveEnd.addEventListener(updateLabels);
  const removeChanged = viewer.camera.changed.addEventListener(updateLabels);

  /** Replace one type's records. Entities are rebuilt only for the type that changed. */
  /** assetType -> {color, glyphSvg} from its KPI card, so a marker looks like the card it came from. */
  const typeTones = new Map();
  function setTypeTone(assetType, tone) { typeTones.set(assetType, tone ?? null); }

  /**
   * assetType -> (record) => text drawn beside its marker, or null for none.
   *
   * Only some classes have a word worth carrying on the map: an asset's category says what the pin
   * IS, which its id cannot. Kept as a per-type function rather than a field the layer knows about,
   * so this module still holds no knowledge of what any class contains.
   */
  const typeCaptions = new Map();
  function setTypeCaption(assetType, fn) { typeCaptions.set(assetType, typeof fn === 'function' ? fn : null); }
  const captionFor = (assetType, item) => {
    const of = typeCaptions.get(assetType);
    const text = of ? of(item) : null;
    return text ? String(text) : null;
  };


  /**
   * Records in different classes commonly refer to the same asset and therefore have exactly the
   * same coordinate. Spread those pins into a compact row so Tasks and Work Orders are not painted
   * underneath Tickets. The position remains the asset's real Cartesian coordinate; pixelOffset is
   * presentation only. Ordering is deterministic, so refreshes do not reshuffle the row.
   */
  function separateCoincidentMarkers() {
    const groups = new Map();
    // Start clean whenever the browsed class or its filters change. Hidden classes must not push a
    // visible marker away from the pulse circle at the real coordinate.
    for (const layer of layers.values()) {
      layer.offsets.clear();
      for (const entity of layer.entities.values()) entity.billboard.pixelOffset = Cartesian2.ZERO;
    }
    for (const [type, layer] of layers) for (const record of layer.records) {
      const entity = layer.entities.get(record.id);
      const visibleInView = typeShown(type)
        && (type !== active || !layer.visible || layer.visible.has(record.id));
      if (!entity || !visibleInView) continue;
      const key = `${record.longitude.toFixed(6)},${record.latitude.toFixed(6)}`;
      const group = groups.get(key) ?? [];
      group.push({ type, id: record.id, entity });
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      group.sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
      const gap = 16;
      group.forEach((item, index) => {
        const offset = new Cartesian2((index - (group.length - 1) / 2) * gap, 0);
        item.entity.billboard.pixelOffset = offset;
        layers.get(item.type)?.offsets.set(item.id, offset);
      });
    }
  }

  function setRecords(assetType, records) {
    // Whether this class is on the map, answered WITHOUT typeShown(): that asks `layers.has()`, and
    // this class is not registered until the end of this function. Asking it here made every marker
    // of a class's first load come out hidden whenever the records arrived before the workspace
    // opened — the preload path, which is exactly what Live Ops warms up.
    const visibleNow = showAll || assetType === active;
    const previous = layerOf(assetType);
    if (previous) {
      for (const [id, entity] of previous.entities) { source.entities.remove(entity); byKey.delete(`${assetType}:${id}`); }
    }
    const entities = new Map(), positions = new Map(), drawn = new Map(), atPoint = new Map(), tones = new Map(), captions = new Map();
    source.entities.suspendEvents();
    try {
      for (const item of records) {
        if (!Number.isFinite(item.longitude) || !Number.isFinite(item.latitude)) continue;   // stays in the list only
        if (entities.has(item.id)) continue;   // an id the source repeats: one marker, not a crash
        // An incident's tone is its crash family — colour and pictogram — rather than one of the
        // three shared tones; see markerFor.
        // A record is drawn as its own class's KPI icon in its own colour — a ticket on the map is
        // the ticket on the card. Incidents keep their crash-family pictogram, which says more than
        // the class ever could.
        const classTone = typeTones.get(assetType);
        const tone = item.type === 'INCIDENT' ? incidentToneOf(item)
          : classTone ? { ...classTone, key: `${assetType}:${classTone.color}` }
            : item.type === 'ASSET_STATUS' ? 'damaged' : item.live ? 'live' : 'normal';
        tones.set(item.id, tone);
        // A class drawn as pictograms is built that way from the start. present() is only called
        // for the markers near the camera, so a record beyond that range would otherwise keep the
        // dot it was created with however far the operator zoomed out to look at the corridor.
        const caption = captionFor(assetType, item);
        if (caption) captions.set(item.id, caption);
        const initial = caption || tone?.glyph || tone?.glyphSvg ? 'id' : 'dot';
        const position = Cartesian3.fromDegrees(item.longitude, item.latitude);
        const entity = source.entities.add({
          id: entityId(assetType, item.id), name: item.id, show: visibleNow,
          position, billboard: { ...BILLBOARD, ...markerFor(item.id, tone, initial, caption) },
        });
        entities.set(item.id, entity);
        byKey.set(`${assetType}:${item.id}`, entity);
        positions.set(item.id, position);
        drawn.set(item.id, initial);
        // Records commonly share an asset, so their markers land on exactly the same point.
        const key = `${item.longitude},${item.latitude}`;
        atPoint.set(key, [...(atPoint.get(key) ?? []), item.id]);
      }
    } finally { source.entities.resumeEvents(); }
    layers.set(assetType, { records, entities, positions, drawn, atPoint, tones, captions, offsets: new Map() });
    separateCoincidentMarkers();
    if (assetType === active || showAll) { labelled = new Set(); updateLabels(); drawSelection(); }
    viewer.scene.requestRender();
  }

  /**
   * Show only these ids of a type (null means all of them) — what the browser's search and filter
   * leave on screen. Visibility only: no entity is created or destroyed by filtering.
   */
  function setVisibleIds(assetType, ids) {
    const layer = layerOf(assetType);
    if (!layer) return;
    layer.visible = ids ? new Set(ids) : null;
    for (const [id, entity] of layer.entities) {
      entity.show = typeShown(assetType) && id !== selected
        && (assetType !== active || !layer.visible || layer.visible.has(id));
    }
    if (assetType === active) { labelled = new Set(); separateCoincidentMarkers(); updateLabels(); drawSelection(); }
    viewer.scene.requestRender();
  }

  /**
   * Choose the BROWSED class. With `setShowAllTypes(true)` every other loaded class stays on the
   * map as context; without it this is still "draw one type and nothing else".
   */
  function show(assetType) {
    if (active === assetType) return;
    active = assetType;
    selected = null;
    selectedType = null;
    labelled = new Set();
    for (const [type, layer] of layers) {
      layer.drawn.clear();
      for (const [id, entity] of layer.entities) {
        entity.show = typeShown(type) && (type !== active || !layer.visible || layer.visible.has(id));
      }
    }
    selectionSource.entities.removeAll();
    for (const [type, layer] of layers) if (typeShown(type)) for (const id of layer.entities.keys()) present(type, id);
    separateCoincidentMarkers();
    updateLabels();
    viewer.scene.requestRender();
  }

  /** Draw every loaded class at once (the Maintenance workspace), or only the browsed one. */
  function setShowAllTypes(on) {
    const next = Boolean(on);
    if (next === showAll) return;
    showAll = next;
    for (const [type, layer] of layers) {
      layer.drawn.clear();
      for (const [id, entity] of layer.entities) {
        entity.show = typeShown(type) && id !== selected
          && (type !== active || !layer.visible || layer.visible.has(id));
      }
      for (const id of layer.entities.keys()) present(type, id);
    }
    separateCoincidentMarkers();
    updateLabels();
    drawSelection();
    viewer.scene.requestRender();
  }

  /**
   * Select one record. With every class on the map the selection may belong to a class other than
   * the browsed one, so the type it came from is carried rather than assumed to be `active`.
   */
  function highlightById(id, assetType = null) {
    const next = id == null ? null : String(id);
    const nextType = next == null ? null
      : assetType ?? (layerOf(active)?.entities.has(next) ? active
        : [...layers.keys()].find(type => layerOf(type).entities.has(next)) ?? active);
    if (next === selected && nextType === selectedType) return;
    const previousType = selectedType, previous = selected;
    const siblingsIn = (type, target) => {
      const layer = layerOf(type);
      return layer && target ? [...layer.atPoint].find(([, ids]) => ids.includes(target))?.[1] ?? [] : [];
    };
    const touched = [
      ...[previous, ...siblingsIn(previousType, previous)].filter(Boolean).map(value => [previousType, value]),
      ...[next, ...siblingsIn(nextType, next)].filter(Boolean).map(value => [nextType, value]),
    ];
    selected = next;
    selectedType = nextType;
    for (const [type, value] of touched) { layerOf(type)?.drawn.delete(value); present(type, value); }
    drawSelection();
    viewer.scene.requestRender();
  }

  // Chained into the shared handler like the camera and lighting layers: a hit is not passed on,
  // because the layers further down report "nothing selected" for a click that is not theirs.
  const handler = viewer.screenSpaceEventHandler;
  const oldClick = handler.getInputAction(ScreenSpaceEventType.LEFT_CLICK);
  handler.setInputAction(event => {
    const entity = viewer.scene.pick(event.position)?.id;
    // With every class on the map a pick can belong to any of them, so the type is read off the
    // entity id rather than assumed to be the browsed one. Longest prefix first: an id is
    // `maintenance-<assetType>-<recordId>` and a record id may itself contain hyphens.
    const key = typeof entity?.id === 'string' ? entity.id : '';
    const type = [...layers.keys()].filter(name => key.startsWith(`maintenance-${name}-`))
      .sort((a, b) => b.length - a.length)[0] ?? null;
    const id = type ? key.slice(`maintenance-${type}-`.length) : null;
    // `show` is only meaningful on the records source; the selection source draws one entity that is
    // always visible.
    if (!id || entity.show === false) { oldClick?.(event); return; }
    highlightById(id, type);
    for (const fn of listeners) fn(type, id);
    for (const fn of pickListeners) fn(type, id);
  }, ScreenSpaceEventType.LEFT_CLICK);

  return {
    setRecords,
    setTypeTone,
    setTypeCaption,
    setVisibleIds,
    show,
    setShowAllTypes,
    /** "<assetType>:<recordId>" -> Entity, for decorations that follow marker visibility. */
    entityByKey: byKey,
    /**
     * Whether this record is on the map right now — INCLUDING while it is the selection, which is
     * drawn from a second source with the original entity hidden. A decoration that only read the
     * original entity's `show` made a selected record's ring disappear the moment it was picked.
     */
    isRecordVisible(assetType, id) {
      if (selected === id && selectedType === assetType) return true;
      return Boolean(byKey.get(`${assetType}:${id}`)?.show);
    },
    /** Every drawn class's placed records, for anything that decorates the whole picture. */
    placedAll: () => [...layers.entries()].flatMap(([type, layer]) =>
      typeShown(type) ? layer.records.filter(item => layer.entities.has(item.id)).map(item => ({ ...item, assetType: type })) : []),
    get activeType() { return active; },
    recordsFor: assetType => layerOf(assetType)?.records ?? [],
    /** Records the map can actually place — the list still shows the others. */
    placedFor: assetType => (layerOf(assetType)?.records ?? []).filter(item => layerOf(assetType).entities.has(item.id)),
    highlightById,
    onSelection(fn) { if (!fn) listeners.clear(); else listeners.add(fn); },
    /** Every marker click, whichever class it belongs to. Returns an unsubscribe. */
    onPick(fn) { pickListeners.add(fn); return () => pickListeners.delete(fn); },
    /**
     * Select a record exactly as a click on its marker would — highlight it and tell the Asset
     * Explorer's source, which selects it WITHOUT disturbing the filters. Used for a click that
     * landed on a pulse ring rather than the marker underneath it.
     */
    selectFromMap(assetType, id) {
      highlightById(id, assetType);
      for (const fn of listeners) fn(assetType, id);
    },
    destroy() {
      disposed = true;
      removeMoveEnd(); removeChanged(); listeners.clear();
      if (oldClick) handler.setInputAction(oldClick, ScreenSpaceEventType.LEFT_CLICK);
      else handler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK);
      void added.then(() => viewer.dataSources.remove(source, true));
      void selectionAdded.then(() => viewer.dataSources.remove(selectionSource, true));
    },
  };
}
