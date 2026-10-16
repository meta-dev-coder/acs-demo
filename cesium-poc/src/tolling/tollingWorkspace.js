/**
 * Tolling: the corridor's gantries.
 *
 * Two published datasets, browsed the way every other workspace browses its own: a KPI card puts a
 * class on the map and into the Asset Explorer's slider, where its records can be stepped through,
 * selected and inspected.
 *
 *   • Toll gantries — OpenStreetMap `highway=toll_gantry`. The screen opens on node 3398439538,
 *     which was measured before it was used: 27 m from the I-595 eastbound centreline, and 9 m
 *     from `i595-gantry-1-toll-plaza` in the models config, so it IS that structure rather than a
 *     new one. ODbL, so the attribution is on screen.
 *   • Express gantries — the 595 Express access nodes and ORT mainline readers the app already
 *     ships, from FDOT / 595 Express Operations.
 *
 * The screen draws its own markers (`tollingMapLayer`) rather than relying on the corridor's
 * `gantries` layer for them: that layer's pin only appears beyond 900 m, so framing a gantry
 * closely — which is exactly what this screen does — left the map empty.
 *
 * The 3D models are that layer's, though. A toll gantry that stands where a model is placed is
 * matched to it by distance (never by a hard-coded id), and opening the class switches the model
 * layer on and takes the app's own close view of the mesh.
 *
 * Nothing here is simulated or inferred. Every attribute shown is a field one of those two sources
 * publishes, and an attribute a record does not carry is left out rather than filled in.
 */
import { Cartesian3, Math as CesiumMath } from 'cesium';
import { installWorkspaceStrip } from '../workspaceStrip.js';
import { framedDestination } from '../cameraFraming.js';
import { focusMapPoints } from '../bridgeCamera.js';
import { installTollingMapLayer } from './tollingMapLayer.js';
import { installGantryEquipmentLayer } from './gantryEquipmentLayer.js';
import { initialSimulationState, isEquipment } from './gantryEquipment.js';
import { syntheticFor } from './gantryEquipmentSynthetic.js';
import { assetTypeConfig } from '../assetExplorer/assetTypes.js';
import { installScenarioPanel } from './scenarioPanel.js';
import { buildSyntheticZones } from '../simulation/gantry/tollingZones.js';
import { installScenarioSceneLayer } from './scenarioSceneLayer.js';
import { SELECTION_SOURCES } from '../assetExplorer/assetSelectionStore.js';
// Generated from the GLB by tools/inspect-gantry-glb.mjs — the browser never parses the mesh.
import gantryEquipmentManifest from '../../config/gantryEquipment/i595-gantry-1-toll-plaza.json' with { type: 'json' };
import { expressGantryRecords, GANTRY_KINDS, OSM_ATTRIBUTION, paymentMethods,
  tollGantryRecords } from './tollingGantries.js';

export { OSM_ATTRIBUTION, paymentMethods };

const FILES = Object.freeze({
  toll: 'i595_toll_gantries_osm.geojson',
  express: 'i595_express_gantries.geojson',
});

/**
 * How close "a bit close" is: near enough to read the structure, wide enough to keep its setting.
 * The eye goes behind the target (see `framedDestination`), so this is the height, not the range.
 */
const FOCUS_HEIGHT_M = 380;
const FOCUS_PITCH_DEG = -25;
/** Beyond this, a set is the corridor rather than a group of assets, and gets the corridor view. */
const CORRIDOR_SPREAD_M = 4_000;

const CARDS = Object.freeze([
  { key: 'tollGantries', label: 'Toll gantries', icon: 'gantry', color: '#eab308', assetType: 'tollGantry' },
  // The equipment the gantry's own 3D model names, each piece selectable in the scene.
  { key: 'equipment', label: 'Gantry equipment', icon: 'workOrder', color: '#a78bfa', assetType: 'gantryEquipment' },
  // The same class, opened on what is out of service. Its own card because "what is broken" is the
  // question an operator arrives with, not one they should have to filter their way to.
  { key: 'failed', label: 'Failed equipment', icon: 'damagedAsset', color: '#ef4444',
    assetType: 'gantryEquipment', status: 'FAILED' },
  // What-if: the same class again, with the scenario panel open over it.
  { key: 'whatIf', label: 'What-if simulation', icon: 'inspection', color: '#38bdf8',
    assetType: 'gantryEquipment', opensPanel: true },
]);

const TYPE_KIND = Object.freeze({ tollGantry: GANTRY_KINDS.TOLL, expressGantry: GANTRY_KINDS.EXPRESS });

/** A toll gantry this close to a placed model IS that model: measured, not assumed. */
const MODEL_MATCH_M = 40;
/** The model layer takes about 15 s to place its meshes; until then its control is disabled. */

/** Metres between two lon/lat points, near enough at corridor scale. */
const metresBetween = (a, b) => Math.hypot(
  (a.longitude - b.longitude) * 111_320 * Math.cos((a.latitude * Math.PI) / 180),
  (a.latitude - b.latitude) * 110_540);

/**
 * Which placed model a record stands at, or null.
 *
 * By distance, so moving a model in the config moves the match with it and a gantry that has no
 * mesh simply has none — rather than a hard-coded id that would quietly point at the wrong
 * structure the day the config changes.
 */
export function modelForGantry(record, modelConfigs, { withinM = MODEL_MATCH_M } = {}) {
  let best = null;
  for (const config of modelConfigs ?? []) {
    if (config?.layer !== 'gantries' || config.enabled === false) continue;
    if (!Number.isFinite(config.longitude) || !Number.isFinite(config.latitude)) continue;
    const distance = metresBetween(record, config);
    if (distance <= withinM && (!best || distance < best.distanceM)) best = { config, distanceM: distance };
  }
  return best;
}

/**
 * @param {{viewer, host, assetExplorer, layerStore, modelConfigs, corridorStatus, resetView}} deps
 */
export function installTollingWorkspace({
  viewer = null, host = document.body, assetExplorer = null, layerStore = null, modelConfigs = [],
  corridorModels = null, corridorStatus = null, resetView = null,
} = {}) {
  const store = assetExplorer?.store ?? null;
  const root = document.createElement('div');
  root.className = 'tolling-workspace';
  root.hidden = true;
  host.append(root);

  const strip = installWorkspaceStrip(root, {
    cards: CARDS, label: 'Tolling', onSelect: key => void choose(key),
  });
  const map = installTollingMapLayer(viewer);

  /** Weather and incidents in the scene: a chip and one marker, nothing animated. */
  const conditionsLayer = installScenarioSceneLayer(viewer, {
    anchor: () => (toll[0] ? { longitude: toll[0].longitude, latitude: toll[0].latitude } : null),
  });
  const conditionsChip = document.createElement('aside');
  conditionsChip.className = 'sim-conditions';
  conditionsChip.hidden = true;
  root.append(conditionsChip);

  /** The scene's key. Shown while equipment can be picked, so a triangle is never guessed at. */
  const legend = document.createElement('aside');
  legend.className = 'sim-legend';
  legend.hidden = true;
  legend.innerHTML = '<span><i data-mark="failed"></i>Failed</span>'
    + '<span><i data-mark="impaired"></i>Impaired</span>'
    + '<span><i data-mark="selected"></i>Selected</span>';
  root.append(legend);
  // The equipment layer is the gantry's own model: it picks glTF nodes and outlines one of them.
  const equipment = installGantryEquipmentLayer(viewer, {
    modelId: gantryEquipmentManifest.modelId,
    getModelEntity: () => corridorModels?.modelById?.get(gantryEquipmentManifest.modelId) ?? null,
  });
  equipment.setAssets(gantryEquipmentManifest.assets);

  /**
   * The what-if panel. It is handed the inventory and the current selection and gives back a
   * result; what the scene does about that result is decided here, in one place.
   */
  const scenarioPanel = installScenarioPanel(root, {
    gantryId: gantryEquipmentManifest.gantryId,
    inventory: () => equipmentRecords(),
    // The synthetic tolling zones the financial estimate is built on: assumed demand shares over
    // the model's own equipment grouping, kept apart from Phase 1's provisional dependency model.
    tollingZones: () => buildSyntheticZones(equipmentRecords()).tollingZones,
    selected: () => {
      const asset = store?.getState?.().selectedAsset;
      return asset?.assetType === 'gantryEquipment' ? asset.source : null;
    },
    // Selecting from the panel does the whole thing: the record is selected, its details open,
    // its marker is highlighted and the camera takes its usual close look at it.
    onFocusAsset: (assetId, { close = true } = {}) => {
      const asset = assetFor('gantryEquipment', assetId);
      if (!asset) return;
      store.selectAsset(asset);
      equipment.highlight(assetId);
      // Selecting already takes the moderate look at it; `close` is the explicit close-up.
      if (close && assetExplorer?.inspect && asset.coordinates) assetExplorer.inspect(asset);
    },
    // One panel at a time. While the what-if is open the inventory tray collapses to its header
    // and the equipment details panel steps aside — the selection itself is kept, so closing the
    // what-if puts the operator back where they were.
    onOpenChange: open => {
      store?.setExplorerExpanded?.(!open);
      store?.setDetailsOpen?.(!open && Boolean(store.getState().selectedAsset));
      render();
    },
    // A scenario marks the equipment it affects and nothing else; `null` puts the scene back to
    // the baseline, which is the same thing Reset does.
    onScenario: (result, current) => {
      equipment.simulate(result?.equipment ?? []);
      // The conditions are drawn from the SCENARIO, not from the result: they are in force while
      // it is being set up as well as after it has been run.
      const weather = current?.weather ?? null;
      const incident = current?.trafficIncident ?? null;
      conditionsLayer.setIncident(incident);
      conditionsChip.hidden = !weather && !incident;
      conditionsChip.innerHTML = [
        weather ? `<span>${weather.label ?? weather.type}</span>` : '',
        incident ? `<span>${incident.label ?? incident.type}</span>` : '',
        '<em>Synthetic scenario conditions</em>',
      ].join('');
      // The scenario's states are held BESIDE the records, keyed by asset id, and merged in as
      // `simulationState` when the explorer next reads them. The synthetic baseline on the record
      // is never touched, so the details panel can show both and Reset needs only to empty this.
      simulationStates.clear();
      for (const state of result?.equipment ?? []) {
        simulationStates.set(state.assetId, Object.freeze({
          status: state.simulatedStatus,
          failureType: state.failureMode,
          scenarioId: result.scenarioId,
        }));
      }
      assetExplorer?.refresh?.();
      // The camera goes to the first affected asset once, when a scenario produces one — not on
      // every edit, and never while the operator is in the middle of moving the camera themselves.
      if (result?.equipment?.length) scenarioPanel.focusAffected(1, { close: false });
      // Re-reading the sources replaces the record objects; the selection still points at the old
      // one, so the details panel would show the state from before the scenario ran. Re-selected as
      // a map pick, which is the app's own way of saying "same asset, do not move the camera".
      const selected = store?.getState?.().selectedAsset;
      if (selected?.assetType === 'gantryEquipment') {
        const fresh = assetFor('gantryEquipment', selected.id);
        if (fresh) store.selectAsset(fresh, SELECTION_SOURCES.CESIUM);
      }
      render();
    },
  });

  /** The records, once read. Empty until then — never a placeholder. */
  let toll = [];
  let express = [];
  let loaded = false;
  let loading = null;
  /** The class currently drawn and browsed, or null when the screen is showing its overview. */
  let shownType = null;
  /** Which CARD opened it. Two cards share the equipment class, and they are not the same view. */
  let activeCard = null;
  let active = false;
  const listeners = new Set();

  const read = async file => {
    const base = import.meta.env?.BASE_URL ?? '/';
    const response = await fetch(`${base}data/${file}`);
    if (!response.ok) throw new Error(`${file}: ${response.status}`);
    return response.json();
  };

  function load() {
    loading ??= Promise.all([read(FILES.toll), read(FILES.express)])
      .then(([osm, fdot]) => {
        // A toll gantry that stands where a model is placed carries that model with it, so the
        // close view can frame the mesh and the details panel can name it.
        toll = tollGantryRecords(osm).map(record => {
          const match = modelForGantry(record, modelConfigs);
          return match ? Object.freeze({
            ...record,
            modelId: match.config.id,
            modelName: match.config.name ?? null,
            modelDistanceM: Math.round(match.distanceM),
            // The app's own "which side to view this from" figure for that model.
            viewHeadingDeg: Number(match.config.viewHeading ?? match.config.heading ?? NaN),
          }) : record;
        });
        express = expressGantryRecords(fdot);
        loaded = true;
      })
      .catch(error => {
        // A failed read is reported as a failure, not as an empty corridor.
        loading = null;
        console.warn('[tolling] could not read the gantry datasets', error);
        throw error;
      });
    return loading;
  }

  /**
   * The gantry's equipment, as records the explorer can list.
   *
   * The manifest is the source of every field. The coordinates are added here, from the model's own
   * placement in the scene, and an asset keeps none when the model has not been placed yet — a
   * card without a position simply cannot be flown to, which is the honest state while it loads.
   *
   * `simulationState` rides alongside, never over, what the manifest says: the what-if work writes
   * there and the asset's real record stays exactly as the model and the (absent) feeds describe it.
   */
  const equipmentRecords = () => gantryEquipmentManifest.assets.filter(isEquipment).map(asset => {
    const position = equipment.worldPositionOf(asset.assetId);
    const located = position ? equipment.locate(asset.assetId) : null;
    // The overlay is matched by asset id, never by position in the list, and may only add the
    // fields it owns — identity, class and geometry stay the manifest's.
    const demo = syntheticFor(asset.assetId) ?? {};
    return {
      ...asset,
      ...demo,
      id: asset.assetId,
      position,
      longitude: located?.longitude ?? null,
      latitude: located?.latitude ?? null,
      // A scenario's state, if one has been applied in this session, else the file's own baseline.
      // The baseline `operationalStatus` above is untouched either way.
      simulationState: simulationStates.get(asset.assetId) ?? demo.simulationState ?? initialSimulationState(),
    };
  });

  /** Scenario state, keyed by asset id and kept out of the asset records themselves. */
  const simulationStates = new Map();

  const recordsOf = assetType => (assetType === 'tollGantry' ? toll
    : assetType === 'expressGantry' ? express
      : assetType === 'gantryEquipment' ? equipmentRecords() : []);

  /** The equipment whose synthetic baseline says it is out of service. */
  const failedEquipment = () => equipmentRecords()
    .filter(record => record.operationalStatus === 'FAILED');

  /** Everything the screen knows about, drawn together: the overview. */
  const everything = () => [...toll, ...express];

  function render() {
    const state = loaded ? 'ready' : loading ? 'loading' : 'loading';
    const gantry = toll[0] ?? null;
    strip.set('tollGantries', { state, count: toll.length,
      note: gantry?.operator ?? (loaded ? 'OpenStreetMap' : null) });
    // The equipment comes from the manifest, which is bundled: its count is known before any
    // network read, so this card never sits on "Loading…" waiting for the GeoJSON.
    const equipmentCount = gantryEquipmentManifest.assets.filter(isEquipment).length;
    const named = gantryEquipmentManifest.assets.filter(asset => asset.identification === 'NAMED').length;
    strip.set('equipment', { state: 'ready', count: equipmentCount,
      note: `${named} named in the 3D model`,
      title: gantryEquipmentManifest.inventory.map(row => `${row.count} ${row.label.toLowerCase()}`).join(' · ') });
    const failed = failedEquipment();
    strip.set('failed', { state: 'ready', count: failed.length,
      // Said on the card itself: this is the demonstration baseline, never a scenario's doing.
      note: failed.length ? 'In the synthetic baseline' : 'None failed in the baseline',
      warning: failed.length > 0,
      title: failed.map(record => record.name).join(', ') || null });
    // The card says what the feature is FOR when nothing is running, and what the running scenario
    // did when something is. Scenario effects are never mixed with the synthetic baseline failures
    // the card beside it counts.
    const impact = scenarioPanel.result?.equipmentImpact ?? null;
    const affected = (scenarioPanel.result?.equipment ?? []).length;
    const summary = impact
      ? [impact.directFailureCount && `${impact.directFailureCount} out of service`,
        impact.directImpairedCount && `${impact.directImpairedCount} impaired`,
        impact.indirectFailureCount && `${impact.indirectFailureCount} indirect`]
        .filter(Boolean).join(' · ')
      : null;
    strip.set('whatIf', { state: 'ready', count: affected,
      countLabel: affected ? 'in scenario' : null,
      note: summary ?? (scenarioPanel.isOpen ? 'Setting up a scenario' : 'Explore equipment failure scenarios'),
      title: impact
        ? `${scenarioPanel.result.scenarioId} · ${scenarioPanel.result.durationMinutes} min · `
          + `${impact.incrementalFailureCount} newly failed by this scenario · simulated, not baseline`
        : null });
    // The overview is the Toll gantry model itself, so its KPI stays highlighted without implying
    // that a record has been selected. `activeCard` remains null until an actual KPI click, which
    // lets that first click open the slider rather than toggle the overview off.
    strip.setActive(shownType ? activeCard : active ? 'tollGantries' : null);
    strip.setSource('');
  }

  /**
   * Switch the corridor's model layer on, once it is able to be switched on.
   *
   * The control is disabled for the ~15 s the layer spends sampling ground heights and placing its
   * meshes, and `setVisible` on a disabled control returns silently. Calling it on arrival
   * therefore did nothing at all, which is what left the 3D gantry invisible however close the
   * camera went.
   */
  const MODEL_LAYER = 'gantries';
  /** What the operator had the model layer set to before this screen touched it. */
  let modelLayerWas = null;

  function layerReady() {
    if (!layerStore?.isReady) return Promise.resolve(false);
    if (layerStore.isReady(MODEL_LAYER)) return Promise.resolve(true);
    // The Tolling screen can be the initial route. In that case model placement is still waiting
    // for the base 3D world, and a fixed timeout can expire while the GLB is downloading. Use the
    // owning layer's real completion signal so the gantry appears as soon as it is actually ready.
    if (corridorModels?.whenPlaced) {
      return corridorModels.whenPlaced()
        .then(placed => Boolean(placed && layerStore.isReady(MODEL_LAYER)), () => false);
    }
    return new Promise(resolve => {
      const timer = setInterval(() => {
        if (layerStore.isReady(MODEL_LAYER)) { clearInterval(timer); resolve(true); return; }
        // This fallback serves integrations without a placement promise. Do not leave a timer or
        // switch a model on after the operator has already left Tolling.
        if (!active) { clearInterval(timer); resolve(false); }
      }, 300);
    });
  }

  async function showModels(on) {
    if (!layerStore?.setVisible) return false;
    if (on && modelLayerWas === null) modelLayerWas = ['on', 'partial'].includes(layerStore.stateOf?.(MODEL_LAYER));
    // If placement has not finished there is nothing to hide. The pending startup call checks
    // `active` before enabling the layer, so leaving Tolling never needs to wait for a GLB download.
    if (!on && !layerStore.isReady?.(MODEL_LAYER)) { modelLayerWas = null; return true; }
    if (!await layerReady()) return false;
    if (on && !active) return false;
    // Only ever restore what was found: an operator who had the models on keeps them on.
    await layerStore.setVisible(MODEL_LAYER, on || modelLayerWas === true);
    if (!on) modelLayerWas = null;
    return true;
  }

  /** Draw one class and hand it to the explorer, exactly as a maintenance card does. */
  /** The classes drawn by the gantry's own mesh rather than by a marker. */
  const NEEDS_MODEL = new Set(['tollGantry', 'gantryEquipment']);

  function openType(assetType, { card = null } = {}) {
    shownType = assetType;
    activeCard = card;
    // A view's own narrowing belongs to that view: opening one clears what the last one applied.
    equipment.flag([]);
    store?.setFilter?.({ id: null });
    // The meshes belong to the gantry classes. Browsing the express gantries puts them away again,
    // so a gantry model is never left standing over a list it is not part of.
    if (!NEEDS_MODEL.has(assetType)) void showModels(false);
    // Equipment is picked out of the mesh, so nothing is marked: 61 billboards over one structure
    // would hide the very parts they claim to point at.
    map.setRecords(assetType === 'gantryEquipment' ? [] : recordsOf(assetType));
    // Node picking follows the MESH, not the list. Tying it to the equipment class meant that on
    // the view this screen opens in — the gantry, filling the screen — hovering an antenna did
    // nothing and clicking one selected the whole gantry. If the equipment is on screen it can be
    // picked; a click simply moves the list to it.
    const onScreen = NEEDS_MODEL.has(assetType);
    equipment.setEnabled(onScreen);
    legend.hidden = !onScreen;
    // With the mesh pickable here, the model layer's own panel and camera stand down — the same
    // "the explorer owns this layer" switch every other browsed layer uses.
    corridorModels?.setExternallyOwned?.(onScreen);
    assetExplorer?.refresh?.();
    store?.setActiveExplorerType?.(assetType);
    render();
  }

  function closeType() {
    shownType = null;
    activeCard = null;
    scenarioPanel.close();
    legend.hidden = false;
    conditionsChip.hidden = true;
    conditionsLayer.clear();
    equipment.flag([]);
    equipment.simulate([]);
    store?.setFilter?.({ id: null });
    // Closing a tray returns to the Tolling screen's initial model view. The screen owns the gantry
    // mesh for its whole lifetime; only leaving Tolling restores the previous layer visibility.
    void showModels(true);
    equipment.setEnabled(false);
    corridorModels?.setExternallyOwned?.(false);
    map.setRecords(everything());
    if (store?.getState?.().activeExplorerType) store.setActiveExplorerType(null);
    assetExplorer?.refresh?.();
    render();
  }

  /**
   * Open the equipment class on one condition: every part in that state marked in the scene, and
   * the list narrowed to the same set.
   *
   * The marks are the point. A list of eight failed parts does not say WHERE on the gantry they
   * are, and that is the thing an operator is looking at the model for.
   */
  function showStatus(status) {
    const matching = equipmentRecords().filter(record => record.operationalStatus === status);
    equipment.flag(matching.map(record => record.assetId));
    // The same filter the dropdown applies, found by what it matches rather than by a built id.
    const filters = assetTypeConfig('gantryEquipment')?.getFilters?.(
      store?.getState?.().assetsByType?.gantryEquipment ?? []) ?? [];
    const chip = filters.find(filter => filter.group === 'Status'
      && matching.length > 0 && filter.match({ source: matching[0] }));
    if (chip) store?.setFilter?.({ id: chip.id });
    return matching.length;
  }

  /** The normalized asset the explorer holds for one record, once the class is on screen. */
  const assetFor = (assetType, id) => (store?.getState?.().assetsByType?.[assetType] ?? [])
    .find(candidate => candidate.id === id) ?? null;

  /**
   * Open one gantry: select it, switch its mesh on, and take the app's own close view.
   *
   * The close view is the explorer's `inspect`, the same one "View on map" uses, so the camera,
   * the Back button and the details panel behave exactly as they do everywhere else — and a gantry
   * with a placed model is framed from the side the model records rather than from due north.
   */
  async function openGantry(record, assetType) {
    // The mesh goes on FIRST, and not only so it downloads while the camera moves: a model layer
    // switching on reports an empty selection to the explorer, which cleared a selection made
    // before it. Selecting afterwards is also the order every other reveal in the app uses.
    if (record.modelId) await showModels(true);
    if (!active) return false;
    const asset = assetFor(assetType, record.id);
    if (!asset) return false;
    store.selectAsset(asset);
    if (assetExplorer?.inspect) { assetExplorer.inspect(asset); return true; }
    return focusRecords([record]);
  }

  async function choose(key) {
    const card = CARDS.find(item => item.key === key);
    if (!card) return;
    try { await load(); } catch { render(); return; }
    if (!active) return;
    // The same card again puts the class away — the toggle every other strip has. Two cards open
    // the equipment class, so it is the CARD that toggles, not the class: moving between them
    // changes the view rather than closing it.
    if (activeCard === key) {
      closeType();
      return;
    }
    // The type is set BEFORE the model layer is switched on. A layer appearing takes the explorer
    // to its own type unless the browsed one has no layer of its own, which `tollGantry` does not
    // — so in this order the gantry models light up without replacing the list being browsed.
    openType(card.assetType, { card: key });
    // Equipment can only be clicked once its mesh is on screen, so the card brings the model up
    // and takes the same close view of the gantry that the toll card does.
    if (card.assetType === 'gantryEquipment') {
      await showModels(true);
      if (!active) return;
      // Re-read once the model is placed: the records only carry coordinates after that.
      assetExplorer?.refresh?.();
      if (card.status) showStatus(card.status);
      if (card.opensPanel) scenarioPanel.open(); else scenarioPanel.close();
      focusGantryModel();
      render();
      return;
    }
    // One toll gantry is a thing to look at, not a list to step through: both cards that open the
    // toll class open the gantry itself. Several would be a list, and get the list's framing.
    const records = recordsOf(card.assetType);
    if (card.assetType === 'tollGantry' && records.length === 1) {
      if (await openGantry(records[0], card.assetType)) return;
    }
    focusRecords(records);
  }

  /**
   * Frame what was just put on screen.
   *
   * One gantry gets the close look: the eye is placed behind it (see `framedDestination`) so the
   * structure lands in the middle of the view rather than under the camera.
   *
   * A set that spans the corridor gets the corridor view every other screen uses. Neither oblique
   * framing works at that extent: the standoff a tilted camera needs grows with its altitude, so
   * widening the close-up to a 15-mile spread put the eye 22 km south at 19,700 m, and handing the
   * same pitch to the extent helper put it 56 km up over the Keys. A set small enough to hold in
   * one frame is framed by the helper, as any other group of assets is.
   */
  function focusRecords(records) {
    if (!viewer || !records?.length) return false;
    if (records.length === 1) {
      const [record] = records;
      const eye = framedDestination(record.longitude, record.latitude, FOCUS_HEIGHT_M, FOCUS_PITCH_DEG);
      viewer.camera.flyTo({
        destination: Cartesian3.fromDegrees(eye.longitude, eye.latitude, eye.height),
        orientation: { heading: 0, pitch: CesiumMath.toRadians(FOCUS_PITCH_DEG), roll: 0 },
        duration: 2,
      });
      return true;
    }
    const lons = records.map(record => record.longitude);
    const lats = records.map(record => record.latitude);
    const spreadM = Math.max((Math.max(...lons) - Math.min(...lons)) * 100_000,
      (Math.max(...lats) - Math.min(...lats)) * 110_540);
    if (spreadM > CORRIDOR_SPREAD_M && resetView) { resetView(); return true; }
    focusMapPoints(viewer, records.map(record => Cartesian3.fromDegrees(record.longitude, record.latitude)),
      '.asset-details', { pitchDeg: FOCUS_PITCH_DEG, minimumHeight: 900 });
    return true;
  }

  /**
   * The close view of the gantry MESH — the distance at which its equipment can be told apart.
   *
   * The app's own framing for a gantry (78 m, from the side the model records) applied without
   * selecting anything: the operator asked for the equipment list, so the toll gantry must not take
   * the selection off it. Measured first: at the overview framing the whole span is about 22 px
   * wide, and nothing on it can be clicked at all.
   */
  function focusGantryModel({ saveReturn = true } = {}) {
    const gantry = toll[0];
    if (!gantry || !assetExplorer?.navigation) return focusRecords(toll.slice(0, 1));
    const moved = assetExplorer.navigation.inspect({
      assetType: 'tollGantry',
      id: gantry.id,
      coordinates: { longitude: gantry.longitude, latitude: gantry.latitude },
      source: { viewHeadingDeg: gantry.viewHeadingDeg ?? null },
    });
    // Startup has no inspection panel and therefore no Back action. Do not leave a hidden saved
    // camera state behind; a later explicit inspection should save the view the operator came from.
    if (!saveReturn) assetExplorer.navigation.clearSaved?.();
    return moved;
  }

  /** The OSM toll gantry the screen opens on. */
  const openingGantry = () => toll[0] ?? null;

  function focusGantry() {
    const gantry = openingGantry();
    return gantry ? focusRecords([gantry]) : false;
  }

  // A click on a marker is reported as a selection of its own class, and the explorer decides.
  map.onSelection(id => {
    const record = everything().find(item => item.id === id);
    if (!record) return;
    const assetType = record.kind === GANTRY_KINDS.TOLL ? 'tollGantry' : 'expressGantry';
    if (shownType !== assetType) openType(assetType);
    for (const listener of listeners) listener(assetType, id);
  });

  // The panel shows what is selected, so it follows the explorer's selection rather than being
  // told by each caller. Only a change of asset redraws it.
  let lastPanelSelection = null;
  const unsubscribeSelection = store?.subscribe?.(state => {
    // Any selection re-opens the details panel — that is what selecting an asset means everywhere
    // else in the app. While the what-if is open it is the one panel that should have the screen,
    // so the details panel is kept shut for as long as it is. The SELECTION is untouched, so the
    // asset stays chosen, stays highlighted, and its details come straight back on close.
    if (scenarioPanel.isOpen && state.detailsOpen) store.setDetailsOpen(false);
    const id = state.selectedAsset?.assetType === 'gantryEquipment' ? state.selectedAsset.id : null;
    if (id === lastPanelSelection) return;
    lastPanelSelection = id;
    scenarioPanel.refresh();
  }) ?? (() => {});

  // A click on a piece of equipment in the 3D model is a selection like any other: it is reported,
  // and the explorer decides. The gantry structure itself is not equipment and selects nothing —
  // clicking the span must not read as "the whole gantry is the asset you asked about".
  equipment.onSelection(assetId => {
    if (shownType !== 'gantryEquipment') openType('gantryEquipment');
    // Null means the gantry's own span rather than a part of it. While the gantry itself is the
    // thing being browsed, that IS the record to select; while equipment is, there is nothing to
    // select and the selection clears, as clicking past the gantry does.
    if (!assetId) {
      equipment.highlight(null);
      const gantry = shownType === 'tollGantry' ? toll[0] : null;
      const asset = gantry ? assetFor('tollGantry', gantry.id) : null;
      if (asset) store?.selectAsset?.(asset); else store?.selectAsset?.(null);
      return;
    }
    for (const listener of listeners) listener('gantryEquipment', assetId);
  });

  return {
    root,
    /** Diagnostics and Ask the Twin: the gantry this screen opens on. */
    get gantry() { return openingGantry(); },
    focusGantry,

    // ── what the Asset Explorer's sources read ────────────────────────────────────────────────
    recordsForType: recordsOf,
    /** Which class is drawn, so a source reports an empty list rather than records off screen. */
    shownType: () => shownType,
    highlightById: (id, assetType = null) => {
      // Both layers are told, and each ignores an id that is not its own: the explorer clears the
      // types it is not showing, and a marker id is not a node id.
      if (assetType !== 'gantryEquipment') map.highlightById(id);
      if (assetType !== 'tollGantry' && assetType !== 'expressGantry') equipment.highlight(id);
    },
    onSelection(fn) { if (!fn) listeners.clear(); else listeners.add(fn); },
    /** Put one class on screen — what a search hit or a related record asks for. */
    async reveal(assetType) {
      if (!TYPE_KIND[assetType]) return false;
      try { await load(); } catch { return false; }
      openType(assetType);
      return true;
    },
    hide() { if (shownType) closeType(); },
    /** Load both datasets without drawing them, so a search can find a gantry first. */
    preload: () => load().catch(() => {}),

    /** The inventory the gantry's model holds, by equipment type. Counted, never typed in. */
    equipmentInventory: () => gantryEquipmentManifest.inventory,
    equipmentManifest: () => gantryEquipmentManifest,
    /** Diagnostics: the node-picking layer, so a browser check can pick without clicking. */
    equipmentLayer: equipment,
    /** Diagnostics: the what-if panel, for a browser check of a scenario end to end. */
    scenario: scenarioPanel,
    /**
     * "Simulate failure", from the selected equipment's own details panel.
     *
     * The asset is already selected, so the panel opens on it: no second selection, and no card to
     * find first. The class is put on screen if it is not already, which is what makes this work
     * from a Cesium pick as well as from the inventory.
     */
    async simulateFailure(asset) {
      if (!asset) return false;
      if (shownType !== 'gantryEquipment') {
        activeCard = 'whatIf';
        openType('gantryEquipment');
        await showModels(true);
        if (!active) return false;
        assetExplorer?.refresh?.();
        const fresh = assetFor('gantryEquipment', asset.id ?? asset.assetId);
        if (fresh) store.selectAsset(fresh, SELECTION_SOURCES.CESIUM);
      }
      scenarioPanel.open();
      render();
      return true;
    },
    activate() {
      if (active) return;
      active = true;
      root.hidden = false;
      legend.hidden = false;
      // The visible 3D gantry is the Tolling workspace's subject, not a Map Explorer layer choice.
      // Without this, enabling its shared `gantries` layer makes the Explorer automatically open
      // the generic Gantries tray before the operator has clicked a KPI.
      assetExplorer?.setExclusiveLayers?.(false);
      store?.setActiveExplorerType?.(null);
      corridorStatus?.setSuppressed?.(true, 'tolling');
      render();
      // Load and show the screen's subject immediately, but keep the workspace in overview mode.
      // Selection belongs to the KPI click: opening the Toll Gantries slider and details panel on
      // arrival makes the screen look as though the operator already chose an asset.
      void load().then(async () => {
        if (!active) return;
        map.setRecords(everything());
        render();
        const [gantry] = toll;
        if (!gantry) { focusGantry(); return; }
        await showModels(true);
        if (active) {
          // A delayed layer notification must not revive a tray or details panel during startup.
          store?.setActiveExplorerType?.(null);
          store?.setDetailsOpen?.(false);
          // Use Gantry 1's model heading and close-view preset. This moves only the camera; it does
          // not select the asset, open its slider, or open the details panel.
          focusGantryModel({ saveReturn: false });
        }
      }).catch(() => render());
      strip.measure();
    },
    async deactivate() {
      if (!active) return;
      active = false;
      root.hidden = true;
      shownType = null;
      scenarioPanel.close();
      legend.hidden = true;
      conditionsChip.hidden = true;
      conditionsLayer.clear();
      await showModels(false);
      equipment.setEnabled(false);
      corridorModels?.setExternallyOwned?.(false);
      map.clear();
      if (store?.getState?.().activeExplorerType) store.setActiveExplorerType(null);
      assetExplorer?.setExclusiveLayers?.(true);
      corridorStatus?.setSuppressed?.(false, 'tolling');
      resetView?.();
    },
    destroy() {
      corridorStatus?.setSuppressed?.(false, 'tolling');
      listeners.clear();
      unsubscribeSelection();
      conditionsLayer.destroy();
      scenarioPanel.destroy();
      equipment.destroy();
      map.destroy();
      strip.destroy();
      root.remove();
    },
  };
}
