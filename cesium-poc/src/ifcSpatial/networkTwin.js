/**
 * The IFC network as a working twin on the IFC Spatial Twin screen: the electrical twin's own
 * engine, outage simulation and Ask the Twin (seagirt/electricalGraph.js, outageScenario.js,
 * askSeagirt.js) running on the network the IFC model contains (ifcNetwork.js), drawn the way the
 * what-if mock draws it (networkOverlay.js), with the mock's status tiles, scenarios and restore-by-
 * switching on top.
 *
 * Power status on top of it (operations.js, opsMarkers.js): every asset's status, NO POWER and
 * DEGRADED markers on the map, the Power Status and Active Alerts panels, and outage investigation.
 *
 * One investigation at a time, as on the electrical twin: a question, a panel action or a scenario
 * produces one validated result; the panel shows it and the map draws it (focus, paths, states).
 */
import { BoundingSphere, Cartesian3, EasingFunction, HeadingPitchRange, Math as CMath } from 'cesium';
import { baselineScenario, compareScenario, energize, STATE, SWITCH, SWITCHING_TYPES, traceSupplyPath, CONSUMER_TYPES } from '../seagirt/electricalGraph.js';
import { createScenarioSession } from '../seagirt/outageScenario.js';
import { ask, investigate, validateResult, TYPE_LABEL } from '../seagirt/askSeagirt.js';
import { buildIfcNetwork, symbolOf, voltageClass } from './ifcNetwork.js';
import { mockPxToModel, symbolImage, ZONES } from './mockStyle.js';
import { createNetworkOverlay } from './networkOverlay.js';
import { createOpsMarkers } from './opsMarkers.js';
import { documentListHtml, documentsForAsset } from './documentsPanel.js';
import { splitLead } from './answerView.js';
import { compareAnswer, namedIds, parseCompareQuestion, resolveVersions } from './askCompare.js';
import { ASK_COLOR, createAskHighlights } from './askHighlights.js';
import { checkSupplyRelationship, EVIDENCE, RELATIONSHIP, resolveSupplyPath, ROLE, topologyReport } from './topology.js';
import { classifyDocumentQuestion, DOC_INTENT } from './docQuestions.js';
import { docAnalysisHtml, docCompareAssetsHtml, docSay, fleetHtml, primaryCitation } from './docAnswer.js';
import { citePopoverHtml, switchReviewTab } from './docReview.js';
import { parseReportFollowUp, parseReportRequest, recipientOf, typeLabels } from './reportRequest.js';
import { chipsHtml, registerPreviewHtml, reportHtml, reportSay, sendReadiness, splitAddresses } from './reportAnswer.js';
import { classifyQuestion } from './intentRouter.js';
import { approxMetres, bufferOutline, buildSpatialIndex, categoriesIn, parseSpatialQuestion, querySpatial } from './spatialIndex.js';
import { answerFacilityQuestion, buildFacilities } from './facilities.js';
import { ASK_ICONS, askPanelHtml } from './askPanel.js';
import { renderChatAnswer } from './chatAnswer.js';
import { createFocusEffects, createLocatorSound } from './focusEffects.js';
import { activeAlerts, assetStatuses, investigateOutage, STATUS, STATUS_LABEL, statusSummary } from './operations.js';
import { IFC_QUESTION_BANK } from './ifcQuestionBank.js';
import { AREA_MODE, createAreaDraw } from './areaDraw.js';
import { INTENT, isMaintenancePlan, planQuestion } from './askIntent.js';
import { resolveTargets, runInvestigation } from './askOrchestrator.js';
import { buildMaintenanceAssessment } from './maintenance.js';
import { maintenanceHtml, maintenanceSayFor, maintenanceSuggestions } from './maintenanceAnswer.js';
import { areaIntentOf, areaScopeOf, distanceIn, isInArea, mentionsArea, polygonOf, validateAreaGeometry } from './areaQuery.js';
import { alternateCoverage, changesInArea, constructionScreen, dependentsOutside, inventoryOf, outageByArea, statusOfArea, supplyOfArea } from './areaIntel.js';
import { acceptedRewrite, interpretRequest, isWeakAreaInventory, understoodNote } from './askInterpret.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const typeLabel = type => (TYPE_LABEL[type]?.[0] ?? String(type ?? '').toLowerCase().replaceAll('_', ' '));
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const kw = value => (value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)} MW` : `${Math.round(value)} kW`);

/** The what-if mock's scenarios, by the IFC's own ids. */
export const SCENARIOS = Object.freeze([
  { id: 'normal', label: 'Normal running', outages: [] },
  { id: 'utilA', label: 'Utility feed A lost', outages: ['C-UA'] },
  { id: 'txm2', label: 'TX-M2 trips', outages: ['TX-M2'] },
  { id: 'apron', label: 'Apron cable fault, west berth', outages: ['AP-03'] },
  { id: 'ring', label: 'Yard ring cable cut', outages: ['RY-2'] },
  { id: 'reefer', label: 'Reefer East transformer fails', outages: ['TX-3'] },
  { id: 'black', label: 'Both utility feeds lost', outages: ['C-UA', 'C-UB'] },
]);

/**
 * Network state for drawing and tiles: each asset live / backup (only the standby generator still
 * reaches it) / dead / off, open switches, and which island (source with a stated capacity) carries
 * each energized load.
 */
/** Assets the IFC model reports as having no power (SuperDNA_AssetStatus.PowerStatus). */
export const reportedNoPower = network => [...network.assets.values()].filter(a => a.reportedPower === 'NO_POWER').map(a => a.id);
/**
 * A scenario in which reported-no-power equipment (a cable, switchgear, a transformer) passes nothing
 * on, so what only it feeds is dark too. A reported consumer (a crane, a light) is dark on its own: a
 * light without power does not take the next light on its circuit with it.
 */
function withReported(network, sc) {
  const equipment = reportedNoPower(network).filter(id => !CONSUMER_TYPES.has(network.assets.get(id)?.assetType));
  return equipment.length ? { ...sc, offline: [...new Set([...(sc.offline ?? []), ...equipment])] } : sc;
}

export function networkState(network, scenario) {
  const sc = scenario ?? baselineScenario();
  const now = energize(network, withReported(network, sc));
  const standby = [...network.assets.values()].filter(a => a.standby).map(a => a.id);
  const utilityOnly = energize(network, withReported(network, { ...sc, offline: [...(sc.offline ?? []), ...standby] }));
  const offline = new Set(sc.offline ?? []);
  const nodeState = new Map();
  for (const [id, s] of now.nodes) {
    nodeState.set(id, offline.has(id) ? 'off' : s === STATE.ENERGIZED ? (utilityOnly.nodes.get(id) === STATE.ENERGIZED ? 'live' : 'backup') : 'dead');
  }
  // "On generator" only where the generator is carrying a load: on the live path of a load that only
  // it reaches. Equipment the generator merely could feed (its own cable, in normal running) is standby.
  const carrying = new Set();
  for (const [id, state] of nodeState) {
    if (state !== 'backup' || !CONSUMER_TYPES.has(network.assets.get(id)?.assetType)) continue;
    for (const on of traceSupplyPath(network, id, { scenario: sc }).path) carrying.add(on);
  }
  for (const [id, state] of nodeState) if (state === 'backup' && !carrying.has(id)) nodeState.set(id, 'standby');
  for (const id of reportedNoPower(network)) if (!offline.has(id)) nodeState.set(id, 'dead');
  const openSwitches = new Set([...network.assets.values()].filter(a => SWITCHING_TYPES.has(a.assetType) && (sc.switches?.[a.id] ?? a.normalState ?? SWITCH.CLOSED) === SWITCH.OPEN).map(a => a.id));
  return { nodeState, openSwitches, energized: now };
}

/**
 * Which way power flows along each live cable: one breadth-first pass from the sources (utility
 * first, then standby), with the engine's rules (offline nodes and open switches pass nothing on).
 * A cable's parent in that pass is the side power arrives from; its route is drawn from that end.
 */
export function flowDirections(network, scenario) {
  const sc = withReported(network, scenario ?? baselineScenario());
  const offline = new Set(sc.offline ?? []);
  const closed = a => !SWITCHING_TYPES.has(a.assetType) || (sc.switches?.[a.id] ?? a.normalState ?? SWITCH.CLOSED) === SWITCH.CLOSED;
  const parent = new Map();
  const walk = sources => {
    const queue = sources.filter(a => !offline.has(a.id) && !parent.has(a.id)).map(a => { parent.set(a.id, null); return a.id; });
    while (queue.length) {
      const id = queue.shift();
      const a = network.assets.get(id);
      if (offline.has(id) || !closed(a)) continue;
      for (const e of network.out.get(id) ?? []) {
        if ((e.operationalState ?? 'CLOSED') === 'OPEN' || offline.has(e.toAssetId) || parent.has(e.toAssetId)) continue;
        parent.set(e.toAssetId, id);
        queue.push(e.toAssetId);
      }
    }
  };
  const sources = [...network.assets.values()].filter(a => a.assetType === 'UTILITY_SUPPLY');
  walk(sources.filter(a => !a.standby));
  walk(sources.filter(a => a.standby));
  const near = (p, q) => (p.lon - q.lon) ** 2 + (p.lat - q.lat) ** 2;
  const ends = a => (a?.route?.length ? [a.route[0], a.route.at(-1)] : a && Number.isFinite(a.location?.longitude) ? [{ lon: a.location.longitude, lat: a.location.latitude }] : []);
  const dir = new Map();
  for (const a of network.assets.values()) {
    if (!a.route?.length || !parent.get(a.id)) continue;
    const up = ends(network.assets.get(parent.get(a.id)));
    if (!up.length) continue;
    const [first, last] = [a.route[0], a.route.at(-1)];
    const d = end => Math.min(...up.map(p => near(p, end)));
    dir.set(a.id, d(first) <= d(last) ? 'forward' : 'reverse');
  }
  return dir;
}

/** Load carried by each island (the first asset with a stated capacity on each load's live path). */
/**
 * What the IFC model itself leaves without power, outside any simulation: assets it reports as having
 * no power (SuperDNA_AssetStatus.PowerStatus), what only they feed, and what its connectivity and
 * normal switch states cannot reach. Standby (only the generator could feed it) is not counted.
 */
export function unpoweredAssets(network) {
  const { nodeState } = networkState(network, null);
  return [...nodeState].filter(([, state]) => state === 'dead').map(([id]) => id);
}

export function islandLoads(network, scenario) {
  const { nodeState } = networkState(network, scenario);
  const islands = new Map();
  for (const a of network.assets.values()) {
    if (!CONSUMER_TYPES.has(a.assetType) || !Number.isFinite(a.demandKw) || !['live', 'backup'].includes(nodeState.get(a.id))) continue;
    const { path } = traceSupplyPath(network, a.id, { scenario: scenario ?? baselineScenario() });
    const source = path.find(id => Number.isFinite(network.assets.get(id)?.capacityKw));
    if (!source) continue;
    const island = islands.get(source) ?? { id: source, capacityKw: network.assets.get(source).capacityKw, loadKw: 0 };
    island.loadKw += a.demandKw;
    islands.set(source, island);
  }
  return [...islands.values()];
}

/**
 * If `failedId` goes offline (on top of any running scenario): which consumers lose supply, which stay
 * supplied over another route by themselves, and which normally-open device would bring which back
 * (and whether that overloads anything). Nothing is changed: a what-if on a copy of the scenario.
 */
export function alternateSupplyOf(network, failedId, { base = null, targetId = null, candidateId = null } = {}) {
  const scenario = { ...(base ?? baselineScenario()), offline: [...new Set([...(base?.offline ?? []), failedId])], switches: { ...(base?.switches ?? {}) } };
  const cmp = compareScenario(network, scenario);
  const lost = cmp.consumersLost.filter(id => id !== failedId);
  const options = restoreOptions(network, scenario);
  const state = networkState(network, scenario).nodeState;
  // The asset asked about (equipment as well as consumers): each normally-open device that would bring it back.
  const restoresTarget = sw => ['live', 'backup'].includes(networkState(network, { ...scenario, switches: { ...scenario.switches, [sw]: SWITCH.CLOSED } }).nodeState.get(targetId));
  const openDevices = [...network.assets.values()].filter(a => SWITCHING_TYPES.has(a.assetType) && !scenario.offline.includes(a.id)
    && (scenario.switches[a.id] ?? a.normalState ?? SWITCH.CLOSED) === SWITCH.OPEN).map(a => a.id);
  const target = targetId ? { id: targetId, state: state.get(targetId), path: traceSupplyPath(network, targetId, { scenario }).path,
    restoredBy: ['live', 'backup'].includes(state.get(targetId)) ? [] : openDevices.filter(restoresTarget) } : null;
  // A candidate source: the options whose restored loads are then supplied through it.
  const viaCandidate = candidateId ? options.filter(o => o.restored.some(id => traceSupplyPath(network, id, { scenario: { ...scenario, switches: { ...scenario.switches, [o.switchId]: SWITCH.CLOSED } } }).path.includes(candidateId))) : [];
  return { scenario, lost, rerouted: cmp.rerouted, options, target, viaCandidate };
}

/** The mock's "restore by switching": each open device that would bring loads back, and whether it overloads. */
export function restoreOptions(network, scenario) {
  if (!scenario) return [];
  const { nodeState } = networkState(network, scenario);
  const dark = [...network.assets.values()].filter(a => CONSUMER_TYPES.has(a.assetType) && nodeState.get(a.id) === 'dead');
  if (!dark.length) return [];
  const options = [];
  for (const a of network.assets.values()) {
    if (!SWITCHING_TYPES.has(a.assetType) || (scenario.offline ?? []).includes(a.id)) continue;
    if ((scenario.switches?.[a.id] ?? a.normalState ?? SWITCH.CLOSED) !== SWITCH.OPEN) continue;
    const next = { ...scenario, switches: { ...(scenario.switches ?? {}), [a.id]: SWITCH.CLOSED } };
    const after = networkState(network, next).nodeState;
    const restored = dark.filter(d => ['live', 'backup'].includes(after.get(d.id)));
    if (!restored.length) continue;
    const over = islandLoads(network, next).filter(i => i.loadKw > i.capacityKw);
    // Restored loads whose new supply has no source with a modelled capacity (or no modelled demand): not checked.
    const unmodelled = restored.filter(d => !Number.isFinite(d.demandKw) || !traceSupplyPath(network, d.id, { scenario: next }).path.some(id => Number.isFinite(network.assets.get(id)?.capacityKw))).map(d => d.id);
    options.push({ switchId: a.id, restored: restored.map(d => d.id), restoredKw: restored.reduce((s, d) => s + (d.demandKw ?? 0), 0), overloads: over, unmodelled });
  }
  return options.sort((x, y) => y.restoredKw - x.restoredKw);
}

// What the user opened stays open when a new model version rebuilds the twin; the first load starts collapsed.
const remembered = { opsCollapsed: true, askOpen: false, area: null };

export function createNetworkTwin({ viewer, elements, connections, modelToLonLat, panel, left, askHost, header, alertHost = null, assetsHost, chainHost, sourceLabel = '',
  opsHost = null, powerHost = null, onDocument = () => {}, onArtifact = () => false, compareTools = null, docTools = null, areaTools = null, interpretTools = null, heading = 0, baseHeight = 0, onSelectElement = () => {}, onFocusElement = () => {}, onWorkspace = () => {} }) {
  const scadaRoutes = elements.filter(e => /scada|fibre/i.test(e.networkRole ?? '') && e.route?.length >= 2)
    .map(e => ({ id: e.networkId ?? e.globalId, points: e.route.map(p => modelToLonLat(...p)) }));
  const built = buildIfcNetwork({ elements, connections, toLonLat: modelToLonLat });
  const session = createScenarioSession({ assets: built.assets, edges: built.edges, notes: built.network.notes }, { onChange: () => draw() });
  const network = session.network;
  const overlay = createNetworkOverlay(viewer, { built: { assets: [...network.assets.values()] }, modelToLonLat, scadaRoutes, baseHeight });
  const ui = { selectedId: null, result: null, question: null, context: {}, preset: 'normal', bankOpen: false, search: '', type: '', workspace: 'network', only: null };
  // Fixed for this model version: what the model, as drawn in ACC, leaves without power.
  const unpowered = new Set(unpoweredAssets(network));

  // ---- Operations View state: statuses come from this model version, so they are computed once ----
  ui.investigation = null;
  ui.statusFilter = null;
  // The asset panel's tab (kept while moving between assets) and the asset documentation index.
  ui.assetTab = 'overview';
  ui.docs = null;
  // Ask the Twin: an answer from outside the engine (comparison, documents, loading, error), the
  // conversation's comparison context ({base, target, lastIds}) and the reading width.
  ui.view = null;
  ui.cmp = null;
  ui.answerWide = false;
  let askToken = 0;
  // The answer being worked on (a request to the server, a report job): Stop ends it. Late results of a stopped
  // answer are dropped by the token; `cancel` also ends work that runs on the server (a report job).
  let working = null;
  // Question reading by Claude (server/ifcSpatial/interpret.mjs): known to be on only once the server said so. Until
  // then, and whenever it is off, every question is answered by the rules alone, as before.
  let llmOn = false;
  if (interpretTools) void interpretTools.status().then(st => { llmOn = Boolean(st?.enabled); }, () => { llmOn = false; });
  // True while a question rewritten by Claude is being routed: it is never sent to Claude again.
  let viaLlm = false;
  // The rewrite the next turn answers, shown above its answer.
  let nextInterpretedAs = null;
  /** Track an answer started just now (its function has already taken a new askToken). */
  function tracked(promise, { cancel = null } = {}) {
    const token = askToken;
    working = { token, cancel };
    renderAskBusy();
    void Promise.resolve(promise).finally(() => { if (working?.token === token) { working = null; renderAskBusy(); } });
  }
  /** Stop the answer in progress: the conversation keeps what was asked, and says it was stopped. */
  function stopAsk() {
    const w = working;
    if (!w && ui.view?.status !== 'loading') return false;
    working = null;
    askToken += 1;
    if (w?.cancel?.() !== true) {
      ui.view = { question: ui.question, kind: 'Stopped', status: 'answered', say: 'Stopped.', say2: 'You stopped this answer. Ask again to continue.' };
      render();
    }
    renderAskBusy();
    askHost.querySelector('.isp-askbar input')?.focus();
    return true;
  }
  // Ask the Twin results on the map (askHighlights.js): {ids, question, snapshot, selectedId}. A new
  // answer replaces it; selecting a result keeps it (Back to results); Clear removes it.
  ui.ask = null;
  // The conversation in the Ask the Twin panel: [{question, html}]. `ui.turn` is the turn the current
  // answer (ui.view / ui.result) belongs to; earlier turns keep the answer they were given.
  ui.turns = [];
  ui.turn = null;
  // The assets the conversation is about, most recent first (what "it" can refer to).
  ui.lastAssets = [];
  // The question just sent: it goes back into the input if its answer fails.
  let retryText = null;
  // Collapsed: the two cards are hidden and the header's Power Status chip stays (remembered per browser).
  // Power Status starts collapsed in the header: the map shows only what has no power. Opening it adds
  // the degraded equipment (amber pills and tint); collapsing it takes them away again.
  ui.opsCollapsed = remembered.opsCollapsed;
  const markers = createOpsMarkers(viewer, { baseHeight });
  // After the markers: its layout (on camera moveEnd) then keeps clear of where they were just placed.
  const askHl = createAskHighlights(viewer, { baseHeight, avoid: () => markers.boxes() });
  const statuses = assetStatuses(network);
  const summary = statusSummary(statuses);
  // The operational area an asset is in: the nearest of the terminal's zone labels.
  const zonePoints = ZONES.filter(z => /ZONE|YARD|GATE|SUBSTATION/.test(z.text)).map(z => ({ text: z.text, at: modelToLonLat(...mockPxToModel(z.px), 0) }));
  const titleCase = t => t.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  // Facilities (facilities.js): the IFC's substation assemblies and their equipment; the map's labels apart.
  const facilityRegistry = buildFacilities({ elements, idOf: g => built.assetByGlobalId.get(g)?.id ?? null, toLonLat: modelToLonLat,
    mapLabels: ZONES.map(z => ({ text: z.text, at: modelToLonLat(...mockPxToModel(z.px), 0) })), version: sourceLabel });
  // Spatial search (spatialIndex.js): every tagged IFC element and facility, in the model's own metres.
  const OTHER_CLASS = { IfcCableSegment: 'Fibre cable (SCADA)', IfcController: 'Controller', IfcCommunicationsAppliance: 'Communications', IfcTransportElement: 'Crane structure', IfcBuildingElementProxy: 'Structure' };
  let spatialIndex = null;
  const spatial = () => (spatialIndex ??= buildSpatialIndex({ elements, facilities: facilityRegistry.facilities, version: sourceLabel,
    areas: ZONES.map(z => { const [x, y] = mockPxToModel(z.px); return { name: titleCase(z.text), xy: [x, y] }; }),
    describe: e => {
      const a = built.assetByGlobalId.get(e.globalId);
      if (a) return { id: a.id, category: cap(TYPE_NAME[a.assetType] ?? typeLabel(a.assetType)) };
      if ((!e.networkId && !e.tag) || ['IfcDistributionPort', 'IfcSite', 'IfcElementAssembly'].includes(e.ifcClass)) return null;
      return { id: e.networkId ?? e.tag, category: OTHER_CLASS[e.ifcClass] ?? e.ifcClass.replace(/^Ifc/, '') };
    } }));
  const zoneOf = asset => {
    if (!Number.isFinite(asset?.location?.longitude)) return null;
    const d = z => Math.hypot((z.at.lon - asset.location.longitude) * Math.cos(asset.location.latitude * Math.PI / 180), z.at.lat - asset.location.latitude);
    const best = [...zonePoints].sort((a, b) => d(a) - d(b))[0];
    return best ? titleCase(best.text) : null;
  };
  const alerts = activeAlerts(network, statuses, { zoneOf });
  const degradedIds = new Set(summary.ids.DEGRADED);
  // Status on the map is the asset's own tile: no power pulses always; while Power Status is open, degraded
  // (and offline) assets pulse too and every alert asset is named by its id (no text pills).
  const shownAlerts = () => [];
  const alertTone = new Map(alerts.map(a => [a.id, a.status === STATUS.DEGRADED ? 'warn' : 'bad']));
  let markerIds = new Set();
  /** The status pills on the map: no power always; degraded only while Power Status is open. */
  function applyAlertMarkers() {
    const list = shownAlerts();
    markerIds = new Set(list.map(a => a.id));
    markers.set(list.map(a => ({ ...a, lon: network.assets.get(a.id)?.location?.longitude, lat: network.assets.get(a.id)?.location?.latitude })));
  }
  applyAlertMarkers();

  // ---- drawing ----

  function focusOf(r) {
    if (!r) return null;
    const ids = new Set([r.primaryAssetId, ...r.targetAssetIds, ...r.relatedAssetIds, ...r.conditionalAssetIds, ...(r.contextAssetIds ?? []),
      ...r.paths.flatMap(p => p.assetIds), ...(r.downstream?.normal ?? []), ...(r.downstream?.conditional ?? [])].filter(Boolean));
    return ids.size ? ids : null;
  }
  /** Neighbours by connection, either direction. */
  const neighbours = id => [...new Set([...(network.in.get(id) ?? []).map(e => e.fromAssetId), ...(network.out.get(id) ?? []).map(e => e.toAssetId)])];
  /** In the Assets workspace a selected asset is shown in its context: its supply path and its connections. */
  function selectionFocus(st) {
    if (ui.workspace !== 'assets' || !ui.selectedId) return null;
    const { path } = traceSupplyPath(network, ui.selectedId, { scenario: st.active ? st.scenario : baselineScenario() });
    return new Set([ui.selectedId, ...path, ...neighbours(ui.selectedId)]);
  }
  /** The investigation as the overlay draws it: the supply path, confirmed and potentially affected. */
  const investigationView = inv => inv && {
    path: new Set([...inv.upstream, inv.id]), confirmed: new Set([inv.id, ...inv.confirmed]), potential: new Set(inv.potential),
    all: new Set([inv.id, ...inv.upstream, ...inv.fedThrough]),
  };
  function draw() {
    const st = session.state();
    // Before / After in the simulation panel: the baseline drawn, the scenario kept.
    const scenarioShown = st.active && !(ui.sim && ui.sim.view === 'before');
    const view = networkState(network, scenarioShown ? st.scenario : null);
    const filterIds = ui.statusFilter ? new Set(summary.ids[ui.statusFilter]) : null;
    overlay.update({ ...view, flowDir: flowDirections(network, st.active ? st.scenario : null), selectedId: ui.selectedId,
      focus: (ui.sim && scenarioShown ? simulationFocus() : null) ?? (ui.focus && ui.focus.state !== 'nogeo' && (!ui.result || ui.result.intent === 'LOCATE') ? focusContext(ui.focus.id) : null)
        // What is highlighted on the map is what stays bright (not the answer's wider context).
        ?? (ui.ask ? new Set([...ui.ask.ids, ui.selectedId].filter(Boolean)) : null) ?? focusOf(ui.result) ?? filterIds ?? selectionFocus(st),
      // With something highlighted or focused, the rest of the network fades well back.
      dimAlpha: ui.ask || ui.focus || ui.sim ? 0.12 : undefined,
      emphasise: Boolean(ui.result?.paths?.length) || ui.workspace === 'assets', stateLabels: st.active,
      // Cables in an Ask the Twin result glow in its colour (equipment keeps its status tile; its halo is the highlight).
      highlight: ui.ask ? new Map(ui.ask.ids.filter(id => network.assets.get(id)?.route?.length >= 2 && view.nodeState.get(id) !== 'dead').map(id => [id, ui.ask.colors?.get(id) ?? ASK_COLOR])) : null,
      // Outside a simulation, what the model leaves without power is flagged and pulses on the map.
      alert: st.active ? null : ui.opsCollapsed ? unpowered : new Set([...unpowered, ...alertTone.keys()]),
      alertNames: st.active || ui.opsCollapsed ? null : alertTone,
      investigation: investigationView(ui.investigation), markerIds: st.active ? null : markerIds, degraded: ui.opsCollapsed ? null : degradedIds });
    markers.setVisible(!st.active);
    markers.setSelected(ui.selectedId);
    renderAskChip();
    renderOps();
    renderTiles(view);
    renderAssets(view);
    renderChain(view);
    renderHeader(st);
    renderRestore(st);
  }

  // ---- Operations View: Power Status, Active Alerts, legend ----

  const STATUS_COLOR = { POWERED: '#3ddc84', NO_POWER: '#ff3b4f', DEGRADED: '#ffb020', OFFLINE: '#8e9aa8', UNKNOWN: '#5d6b7a' };
  const bolt = (color, size = 20) => `<svg viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true"><path d="M11.6 1.5 4.2 11.4h5.1l-1.4 7.1 7.9-10.2h-5.2z" fill="${color}"/></svg>`;
  const warn = (size = 20) => `<svg viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true"><path d="M10 2 19 18H1z" fill="${STATUS_COLOR.DEGRADED}"/><path d="M10 7.5v5" stroke="#2a1a00" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="15.2" r="1.1" fill="#2a1a00"/></svg>`;
  const statusIcon = key => (key === 'DEGRADED' ? warn() : key === 'UNKNOWN' ? '<i class="isp-ops-q">?</i>' : bolt(STATUS_COLOR[key]));
  const fmtDay = d => { const t = new Date(`${d}T00:00:00`); return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }); };
  /** Powered share as a ring: powered (green) and degraded (amber, still energised) — one asset counted once. */
  function donut(pct, counts) {
    const r = 46, c = 2 * Math.PI * r;
    const known = Object.entries(counts).filter(([k]) => k !== 'UNKNOWN').reduce((n, [, v]) => n + v, 0);
    const pw = known ? counts.POWERED / known : 0, dg = known ? counts.DEGRADED / known : 0;
    return `<svg class="isp-ops-donut" viewBox="0 0 112 112" width="112" height="112" role="img" aria-label="${pct === null ? 'Powered share unknown' : `${pct}% powered${counts.DEGRADED ? `, including ${counts.DEGRADED} degraded` : ''}`}">
      <circle cx="56" cy="56" r="${r}" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="10"/>
      <circle cx="56" cy="56" r="${r}" fill="none" stroke="${STATUS_COLOR.POWERED}" stroke-width="10" stroke-dasharray="${(c * pw).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 56 56)"/>
      ${dg ? `<circle cx="56" cy="56" r="${r}" fill="none" stroke="${STATUS_COLOR.DEGRADED}" stroke-width="10" stroke-dasharray="${(c * dg).toFixed(1)} ${c.toFixed(1)}" stroke-dashoffset="${(-c * pw).toFixed(1)}" transform="rotate(-90 56 56)"/>` : ''}
      <text x="56" y="58" text-anchor="middle" font-size="23" font-weight="800" fill="#ffffff">${pct === null ? '—' : `${Math.round(pct)}%`}</text>
      <text x="56" y="76" text-anchor="middle" font-size="11.5" fill="#c9d4e2">Powered</text></svg>`;
  }
  /** The header's Power Status chip: powered share, no power and degraded counts; it shows and hides the cards. */
  function renderPowerChip() {
    if (!powerHost) return;
    const r = 8, c = 2 * Math.PI * r, f = summary.poweredPct === null ? 0 : summary.poweredPct / 100;
    powerHost.hidden = false;
    powerHost.setAttribute('aria-expanded', String(!ui.opsCollapsed));
    powerHost.title = `Power Status: ${summary.poweredPct ?? '—'}% of ${summary.total} monitored assets powered. Click to ${ui.opsCollapsed ? 'show' : 'hide'} Power Status and Active Alerts.`;
    powerHost.innerHTML = `<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><circle cx="10" cy="10" r="${r}" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="3"/>
        <circle cx="10" cy="10" r="${r}" fill="none" stroke="${STATUS_COLOR.POWERED}" stroke-width="3" stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 10 10)"/></svg>
      <b>${summary.poweredPct === null ? '—' : `${Math.round(summary.poweredPct)}%`}</b><span class="isp-power-l">Powered</span>
      ${summary.counts.NO_POWER ? `<span class="isp-power-n is-bad">${bolt(STATUS_COLOR.NO_POWER, 15)}${summary.counts.NO_POWER}</span>` : ''}
      ${summary.counts.DEGRADED ? `<span class="isp-power-n is-warn">${warn(14)}${summary.counts.DEGRADED}</span>` : ''}
      <span class="isp-power-chev" aria-hidden="true">${ui.opsCollapsed ? '▾' : '▴'}</span>`;
  }

  // Active Alerts: grouped by status (most severe first), compact rows, paged to fit the window (never a scrollbar).
  ui.alertPage = 0;
  ui.alertPageSize = 8;
  ui.alertGroups = { NO_POWER: true, DEGRADED: true, OFFLINE: true };
  const ALERT_GROUPS = ['NO_POWER', 'DEGRADED', 'OFFLINE'];
  const GROUP_LABEL = { NO_POWER: 'No Power', DEGRADED: 'Degraded', OFFLINE: 'Offline' };
  const shortDay = d => { const t = new Date(`${d}T00:00:00`); return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString([], { day: 'numeric', month: 'short' }); };
  function renderOps({ fit = true } = {}) {
    if (!opsHost) return;
    opsHost.hidden = ui.opsCollapsed;
    renderPowerChip();
    const rows = ['POWERED', 'NO_POWER', 'DEGRADED', 'OFFLINE', ...(summary.counts.UNKNOWN ? ['UNKNOWN'] : [])];
    const row = key => `<button type="button" class="isp-ops-row${ui.statusFilter === key ? ' is-on' : ''}" data-ops-status="${key}" aria-pressed="${ui.statusFilter === key}"${summary.counts[key] ? '' : ' disabled'}
      title="${summary.counts[key] ? `Show only ${STATUS_LABEL[key].toLowerCase()} assets on the map${ALERT_GROUPS.includes(key) ? ' and in Active Alerts' : ''}` : ''}">${statusIcon(key)}<span>${STATUS_LABEL[key]}</span><b>${summary.counts[key]}</b></button>`;
    // A status filter on an alert status narrows the alerts too.
    const filter = ALERT_GROUPS.includes(ui.statusFilter) ? ui.statusFilter : null;
    const groups = ALERT_GROUPS.filter(g => !filter || g === filter).map(g => ({ key: g, list: alerts.filter(a => a.status === g) })).filter(g => g.list.length);
    const visible = groups.flatMap(g => (ui.alertGroups[g.key] ? g.list : []));
    const size = Math.max(1, ui.alertPageSize);
    const pages = Math.max(1, Math.ceil(visible.length / size));
    ui.alertPage = Math.min(ui.alertPage, pages - 1);
    const page = visible.slice(ui.alertPage * size, ui.alertPage * size + size);
    const alertRow = a => `<li><button type="button" class="isp-ops-alert is-${a.status.toLowerCase()}${ui.selectedId === a.id ? ' is-selected' : ''}" data-ops-alert="${esc(a.id)}" title="${esc(`${a.name ?? a.id} — ${a.text}`)}">
      <span class="isp-ops-alert-icon">${a.status === STATUS.DEGRADED ? warn(13) : a.status === STATUS.OFFLINE ? bolt(STATUS_COLOR.OFFLINE, 13) : bolt(STATUS_COLOR.NO_POWER, 13)}</span>
      <span class="isp-ops-alert-text"><b>${esc(a.id)}</b><small>${esc(a.zone ?? a.name ?? '')}</small></span>
      ${a.date ? `<time datetime="${esc(a.date)}">${esc(shortDay(a.date))}</time>` : ''}<span class="isp-ops-chev" aria-hidden="true">›</span></button></li>`;
    const group = g => {
      const open = ui.alertGroups[g.key];
      const shown = page.filter(a => a.status === g.key);
      return `<section class="isp-ops-group is-${g.key.toLowerCase()}" aria-label="${GROUP_LABEL[g.key]} alerts">
        <button type="button" class="isp-ops-ghead" data-ops-group="${g.key}" aria-expanded="${open}">${statusIcon(g.key)}<span>${GROUP_LABEL[g.key]}</span><b>${g.list.length}</b><i aria-hidden="true">${open ? '▾' : '▸'}</i></button>
        ${open && shown.length ? `<ul>${shown.map(alertRow).join('')}</ul>` : ''}</section>`;
    };
    // Group headers stay for every non-empty group; rows of a group not on this page are on another page.
    const pager = visible.length > size ? `<div class="isp-ops-pager"><span>Showing ${ui.alertPage * size + 1}–${Math.min(visible.length, (ui.alertPage + 1) * size)} of ${visible.length} alerts</span>
      <button type="button" data-ops-page="-1" aria-label="Previous alerts"${ui.alertPage ? '' : ' disabled'}>‹</button><button type="button" data-ops-page="1" aria-label="Next alerts"${ui.alertPage < pages - 1 ? '' : ' disabled'}>›</button></div>` : '';
    opsHost.innerHTML = `<div class="isp-opsp">
      <section class="isp-ops-sec" aria-label="Power status">
        <h3 title="${esc(`${summary.total} monitored assets (equipment and loads; cables not counted), each counted once${summary.asOf ? `; status date ${summary.asOf}` : ''}. Powered includes degraded assets (still energised). From the IFC model in ACC and its connectivity; no live SCADA feed.`)}">Power Status
          <button type="button" class="isp-ops-toggle" data-act="opsCollapse" aria-expanded="true" aria-label="Hide to the header" title="Hide to the header">▴</button></h3>
        <div class="isp-ops-status">${donut(summary.poweredPct, summary.counts)}<div class="isp-ops-rows">${rows.map(row).join('')}</div></div>
        ${ui.statusFilter ? `<button type="button" class="isp-ops-clear" data-act="opsClear">Clear filter · ${esc(STATUS_LABEL[ui.statusFilter])}</button>` : ''}</section>
      <section class="isp-ops-sec isp-ops-alerts" aria-label="Active alerts"><h3>Active Alerts <small>${filter ? `${visible.length} of ${alerts.length}` : alerts.length}</small></h3>
        ${groups.length ? groups.map(group).join('') : `<p class="isp-ops-none">${filter ? `No ${GROUP_LABEL[filter].toLowerCase()} alerts.` : 'No alerts: every monitored asset is powered.'}</p>`}
        ${pager}</section></div>`;
    // The one details panel (asset, answer or investigation) opens as its own card beside this one.
    const slot = opsHost.parentElement?.querySelector(':scope > .isp-ops-detail') ?? Object.assign(document.createElement('div'), { className: 'isp-ops-detail' });
    if (slot.previousElementSibling !== opsHost) opsHost.after(slot);
    if (fit && !opsHost.hidden) fitAlerts(visible.length);
  }
  /**
   * As many alert rows as fit between the panel's top and the bottom of the window (up to 8): the panel never
   * runs past the screen, so it never needs a scrollbar; the rest is a page away.
   */
  function fitAlerts(total) {
    // The room: to the bottom of the window, and never more than the panel's own maximum height.
    const maxH = parseFloat(getComputedStyle(opsHost).maxHeight);
    const room = Math.min(window.innerHeight - opsHost.getBoundingClientRect().top - 16, Number.isFinite(maxH) ? maxH : Infinity) - 2;
    const want = Math.min(8, Math.max(1, total));
    // A few passes: a page with fewer rows can drop or add a group's rows, which changes the height again.
    for (let pass = 0; pass < 4; pass += 1) {
      const panel = opsHost.querySelector('.isp-opsp');
      if (!panel) return;
      const h = panel.getBoundingClientRect().height;
      const rowH = opsHost.querySelector('.isp-ops-alert')?.getBoundingClientRect().height || 46;
      let size = ui.alertPageSize;
      if (h > room) size = Math.max(1, size - Math.max(1, Math.ceil((h - room) / rowH)));
      else if (size < want && room - h > rowH + 4) size = Math.min(want, size + Math.floor((room - h - 4) / rowH));
      if (size === ui.alertPageSize) return;
      ui.alertPageSize = size;
      renderOps({ fit: false });
    }
  }
  // On a resize: start from the full page again, then fit once the new layout has settled.
  let resizeFrame = 0;
  const onOpsResize = () => {
    if (ui.opsCollapsed) return;
    ui.alertPageSize = 8; ui.alertPage = 0;
    renderOps();
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => renderOps());
  };
  window.addEventListener('resize', onOpsResize);


  function investigationHtml(inv) {
    const a = network.assets.get(inv.id);
    const { nodeState } = networkState(network, null);
    const s = inv.status;
    return `<div class="isp-head"><span class="isp-kicker is-bad">Outage investigation</span><button type="button" class="isp-x" data-act="resetInvestigation" aria-label="Close">×</button></div>
      <div class="isp-asset-title">${icon(a, 'dead', 34)}<div><h2 class="isp-title">${esc(a.id)} — No power</h2><div class="isp-sub-id">${esc(a.name)}</div></div></div>
      <dl class="isp-dl"><dt>Status</dt><dd>${s?.source === 'REPORTED' ? 'No power, reported in the IFC model' : 'No supply path in the model'}${s?.date ? ` (${esc(s.date)})` : ''}</dd>
        <dt>Zone</dt><dd>${esc(zoneOf(a) ?? '—')}</dd></dl>
      <div class="isp-sec">Upstream supply path${inv.upstreamDead.length ? ' · has no power' : ' · energized in the model'}</div>
      ${inv.upstream.length ? chips(inv.upstream, nodeState) : '<p class="isp-muted">No supply path in the model.</p>'}
      <div class="isp-sec">Confirmed affected · ${inv.confirmed.length}</div>
      ${inv.confirmed.length ? chips(inv.confirmed, nodeState) : '<p class="isp-muted">None: nothing fed through it is shown without power.</p>'}
      ${inv.potential.length ? `<div class="isp-sec isp-sec-warn">Potentially affected — requires verification · ${inv.potential.length}</div>${chips(inv.potential, nodeState)}` : ''}
      ${inv.notes.map(n => `<p class="isp-muted">${esc(n)}</p>`).join('')}
      <div class="isp-actions"><button type="button" class="isp-btn is-primary" data-act="resetInvestigation">Reset investigation</button>
        <button type="button" class="isp-btn" data-asset="${esc(a.id)}">Asset details</button></div>`;
  }

  // ---- left card: status, scenarios, restore ----

  left.innerHTML = `<details class="isp-more" open><summary>Network status</summary><div class="isp-tiles"></div></details>
    <details class="isp-more" open><summary>What-if scenarios</summary><div class="isp-chips isp-scen">${SCENARIOS.map(s => `<button type="button" class="isp-chipbtn" data-scenario="${s.id}">${esc(s.label)}</button>`).join('')}</div>
      <div class="isp-restore"></div></details>`;
  function renderTiles({ nodeState }) {
    const loads = [...network.assets.values()].filter(a => CONSUMER_TYPES.has(a.assetType));
    const on = a => ['live', 'backup'].includes(nodeState.get(a.id));
    const cranes = loads.filter(a => a.assetType === 'CRANE'), masts = loads.filter(a => a.assetType === 'LIGHTING_CIRCUIT');
    const reefers = loads.filter(a => Number.isFinite(a.reeferPlugs));
    const plugs = reefers.reduce((s, a) => s + a.reeferPlugs, 0), plugsOn = reefers.filter(on).reduce((s, a) => s + a.reeferPlugs, 0);
    const gate = network.assets.get('GATE'), ops = network.assets.get('OPS');
    const lost = loads.filter(a => !on(a)).reduce((s, a) => s + (a.demandKw ?? 0), 0);
    const tile = (value, label, tone) => `<div class="isp-tile ${tone}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
    const tone = (n, max) => (n === max ? '' : n === 0 ? 'is-crit' : 'is-warn');
    left.querySelector('.isp-tiles').innerHTML = [
      tile(`${cranes.filter(on).length}/${cranes.length}`, 'STS cranes powered', tone(cranes.filter(on).length, cranes.length)),
      tile(`${plugsOn}/${plugs}`, 'Reefer plugs powered', tone(plugsOn, plugs)),
      tile(`${masts.filter(on).length}/${masts.length}`, 'Lighting masts lit', tone(masts.filter(on).length, masts.length)),
      gate ? tile(on(gate) ? 'Open' : 'Closed', 'Truck gate', on(gate) ? '' : 'is-crit') : '',
      ops ? tile(nodeState.get(ops.id) === 'live' ? 'Utility' : nodeState.get(ops.id) === 'backup' ? 'Generator' : 'Offline', 'Ops building / SCADA', nodeState.get(ops.id) === 'live' ? '' : nodeState.get(ops.id) === 'backup' ? 'is-warn' : 'is-crit') : '',
      tile(kw(lost), 'Load without power', lost ? 'is-crit' : ''),
    ].join('');
    for (const b of left.querySelectorAll('[data-scenario]')) b.setAttribute('aria-pressed', String(b.dataset.scenario === ui.preset));
  }
  function renderRestore(st) {
    const box = left.querySelector('.isp-restore');
    if (!st.active) { box.innerHTML = '<p class="isp-muted">No changes. Pick a scenario, ask a question, or use an asset\'s actions.</p>'; return; }
    const options = restoreOptions(network, st.scenario);
    const islands = islandLoads(network, st.scenario);
    box.innerHTML = `<div class="isp-scenario-line"><b>${esc(st.label)}</b> <button type="button" class="isp-link" data-act="netReset">Reset</button></div>
      ${options.length ? `<div class="isp-sub">Restore by switching</div>${options.slice(0, 5).map(o => `<div class="isp-opt"><span><b>Close ${esc(o.switchId)}</b> · restores ${o.restored.length} load${o.restored.length === 1 ? '' : 's'} (${kw(o.restoredKw)})${o.overloads.length ? ` · <span class="isp-bad">overloads ${o.overloads.map(i => esc(i.id)).join(', ')}</span>` : ''}</span>
        <button type="button" class="isp-btn" data-close="${esc(o.switchId)}"${o.overloads.length ? ' title="This would overload a transformer in the model"' : ''}>Close</button></div>`).join('')}`
        : '<p class="isp-muted">No single switching action brings any lost load back.</p>'}
      ${islands.length ? `<div class="isp-sub">Supply capacity (modelled demand)</div>${islands.map(i => `<div class="isp-bar-row"><span>${esc(i.id)}</span><span>${kw(i.loadKw)} / ${kw(i.capacityKw)}</span></div>
        <div class="isp-bar"><i class="${i.loadKw > i.capacityKw ? 'is-crit' : i.loadKw > 0.85 * i.capacityKw ? 'is-warn' : ''}" style="width:${Math.min(100, Math.round(i.loadKw / i.capacityKw * 100))}%"></i></div>`).join('')}` : ''}`;
  }

  /** The simulation pill: only while a simulation runs; clicking it resets. */
  function renderHeader(st) {
    // The simulation panel says it all; no banner beside it.
    header.hidden = !st.active || Boolean(ui.sim);
    header.className = 'isp-chip isp-scenario-pill is-warn';
    header.textContent = st.active ? `${st.label} · Reset` : '';
    if (!alertHost) return;
    alertHost.hidden = !unpowered.size;
    const consumers = [...unpowered].filter(id => CONSUMER_TYPES.has(network.assets.get(id)?.assetType)).length;
    alertHost.textContent = unpowered.size ? `${unpowered.size} without power` : '';
    const reported = reportedNoPower(network);
    alertHost.title = unpowered.size ? `In the IFC model from ACC (${sourceLabel}), ${unpowered.size} asset${unpowered.size === 1 ? '' : 's'}${consumers ? `, ${consumers} of them consumer${consumers === 1 ? '' : 's'},` : ''} receive no power: ${[...unpowered].join(', ')}.`
      + `${reported.length ? ` Reported "No power" in the model: ${reported.join(', ')}.` : ''} Click to list them.` : '';
  }

  // ---- the Assets panel (left), as on the electrical twin ----

  const TYPE_ORDER = ['UTILITY_SUPPLY', 'TRANSFORMER', 'SUBSTATION', 'SWITCHGEAR', 'CIRCUIT_BREAKER', 'SWITCH', 'FEEDER', 'JUNCTION_BOX', 'CRANE', 'LIGHTING_CIRCUIT', 'OTHER_LOAD', 'BUILDING'];
  const TYPE_NAME = { UTILITY_SUPPLY: 'Supply', TRANSFORMER: 'Transformer', SUBSTATION: 'Ring main unit', SWITCHGEAR: 'Switchgear', CIRCUIT_BREAKER: 'Breaker', SWITCH: 'Switch',
    FEEDER: 'Cable', JUNCTION_BOX: 'Crane power vault', CRANE: 'Crane', LIGHTING_CIRCUIT: 'High-mast light', OTHER_LOAD: 'Reefer racks', BUILDING: 'Building' };
  const STATE_WORD = { live: 'Energized', backup: 'On generator', standby: 'Standby', dead: 'No power', off: 'Out of service' };
  const icon = (a, state, size = 26) => {
    const kind = symbolOf(a) ?? (a.assetType === 'FEEDER' ? null : 'vault');
    if (!kind) return `<span class="isp-cable-glyph is-${voltageClass(a) ?? 'mv'}" style="width:${size}px;height:${size}px"></span>`;
    return `<img class="isp-aicon" alt="" width="${size}" height="${size}" src="${symbolImage(kind === 'tx' ? 'mtx' : kind, { state: state === 'standby' ? 'dead' : state ?? 'live', kv: voltageClass(a) ?? 'mv' })}">`;
  };
  if (assetsHost) {
    const present = TYPE_ORDER.filter(t => [...network.assets.values()].some(a => a.assetType === t));
    assetsHost.innerHTML = `<div class="isp-head"><span class="isp-kicker">Assets</span><button type="button" class="isp-x" data-act="assetsClose" aria-label="Close assets">×</button></div>
      <input class="isp-asearch" type="search" placeholder="Search by name or ID" aria-label="Search assets">
      <select class="isp-atype" aria-label="Asset type"><option value="">All types</option>${present.map(t => `<option value="${t}">${esc(TYPE_NAME[t])}</option>`).join('')}</select>
      <div class="isp-alist" role="list"></div>
      <small class="isp-muted isp-afoot">${network.assets.size} assets from the IFC model${sourceLabel ? ` · ${esc(sourceLabel)}` : ''}</small>`;
    assetsHost.querySelector('.isp-asearch').addEventListener('input', event => { ui.search = event.target.value.trim().toLowerCase(); draw(); });
    assetsHost.querySelector('.isp-atype').addEventListener('change', event => { ui.type = event.target.value; draw(); });
  }
  function renderAssets({ nodeState, openSwitches }) {
    const list = assetsHost?.querySelector('.isp-alist');
    if (!list) return;
    const rows = [...network.assets.values()]
      .filter(a => (!ui.only || ui.only.has(a.id)) && (!ui.type || a.assetType === ui.type) && (!ui.search || `${a.id} ${a.name}`.toLowerCase().includes(ui.search)))
      .sort((a, b) => TYPE_ORDER.indexOf(a.assetType) - TYPE_ORDER.indexOf(b.assetType) || Number(Boolean(a.standby)) - Number(Boolean(b.standby))
        || a.id.localeCompare(b.id, undefined, { numeric: true }));
    const onlyBar = ui.only ? `<div class="isp-only">Showing ${ui.only.size} affected assets <button type="button" class="isp-link" data-act="onlyClear">Show all</button></div>` : '';
    list.innerHTML = onlyBar + rows.map(a => {
      const state = nodeState.get(a.id);
      const word = SWITCHING_TYPES.has(a.assetType) ? (openSwitches.has(a.id) ? 'Open' : 'Closed') : STATE_WORD[state] ?? '—';
      const tone = SWITCHING_TYPES.has(a.assetType) ? (openSwitches.has(a.id) ? 'is-open' : 'is-live') : `is-${state}`;
      return `<button type="button" role="listitem" class="isp-arow${a.id === ui.selectedId ? ' is-selected' : ''}" data-asset="${esc(a.id)}">${icon(a, state)}
        <span class="isp-atext"><b>${esc(a.name)}</b><small>${esc(a.id)} · ${esc(TYPE_NAME[a.assetType] ?? a.assetType)}${a.voltageLevel ? ` · ${esc(a.voltageLevel)}` : ''}</small></span>
        <span class="isp-badge2 ${tone}">${esc(word)}</span></button>`;
    }).join('') || '<p class="isp-muted">No asset matches.</p>';
  }

  // ---- the supply chain strip (top): the selected asset's live path, or the answer's path ----

  // ---- electrical supply (topology.js): the logical chain, the physical route, the evidence ----

  const topo = built.topology;
  const EVIDENCE_TEXT = { [EVIDENCE.EXPLICIT_IFC]: 'IFC ports SOURCE → SINK', [EVIDENCE.INFERRED]: 'no direction in the IFC; taken from the source side (normal switch states)',
    [EVIDENCE.FEED_THROUGH]: 'through the load’s loop-in / loop-out ports (it does not supply what follows)', [EVIDENCE.UNRESOLVED]: 'unresolved in the model' };
  /** The resolved supply of an asset, in the current scenario. */
  function supplyOf(id) {
    const st = session.state();
    const { nodeState } = networkState(network, st.active ? st.scenario : null);
    const on = x => nodeState.get(x) === 'live' || nodeState.get(x) === 'backup' || network.assets.get(x)?.feedThrough;
    return resolveSupplyPath(topo, network, id, { scenario: st.active ? st.scenario : null, isLive: p => p.slice(0, -1).every(on), circuitOf: x => network.assets.get(x)?.circuit ?? null });
  }
  /** The short chain: source, transformers, switchgear, the last protective device, the circuit, the asset. */
  function compactChain(logical) {
    const lastProtection = [...logical].reverse().find(x => x.role === ROLE.PROTECTION || x.role === ROLE.SWITCH);
    return logical.filter(x => x.kind !== 'equipment' || [ROLE.SOURCE, ROLE.TRANSFORMER, ROLE.DISTRIBUTION, ROLE.JUNCTION].includes(x.role) || x === lastProtection);
  }
  const verificationText = sup => (sup.verification === 'VERIFIED' ? 'Supply path verified in the IFC'
    : sup.verification === 'NONE' ? 'No supply path in the model' : `Supply path not fully verified · ${sup.primary.inferred} of ${sup.primary.hops.length} connections have no direction in the IFC`);
  ui.chainOpen = false;
  function renderChain({ nodeState }) {
    if (!chainHost) return;
    const id = ui.result?.paths?.[0]?.assetIds?.at(-1) ?? ui.inspector ?? ui.selectedId;
    if (!id || !network.assets.has(id) || network.assets.get(id).electricalRole === ROLE.SOURCE) { chainHost.hidden = true; return; }
    const sup = supplyOf(id);
    if (!sup.primary) { chainHost.hidden = true; return; }
    chainHost.hidden = false;
    const step = x => {
      if (x.kind === 'circuit') return `<span class="isp-chain-step is-circuit" title="Circuit ${esc(x.id)} (${esc(x.via.join(', '))})">${esc(x.id)}</span>`;
      const state = nodeState.get(x.id);
      return `<button type="button" class="isp-chain-step is-${state}${x.id === ui.selectedId ? ' is-selected' : ''}" data-asset="${esc(x.id)}" title="${esc(network.assets.get(x.id)?.name ?? x.id)}">${esc(x.id)}</button>`;
    };
    const chain = compactChain(sup.logical).map(step).join('<span class="isp-chain-sep" aria-hidden="true">→</span>');
    const full = sup.primary.hops.map((h, i) => `<li><button type="button" class="isp-route-id" data-asset="${esc(h.to)}">${esc(h.to)}</button>
        <span class="isp-route-ev is-${h.evidence.toLowerCase()}">${esc(EVIDENCE_TEXT[h.evidence])}</span>${i === 0 ? `<span class="isp-muted"> from ${esc(h.from)}</span>` : ''}</li>`).join('');
    chainHost.innerHTML = `<div class="isp-supply-h"><b>${esc(id)}</b><span>Electrical supply</span>
        <span class="isp-supply-badge is-${sup.verification === 'VERIFIED' ? 'ok' : 'warn'}" title="${esc(verificationText(sup))}">${sup.verification === 'VERIFIED' ? 'Verified in IFC' : 'Not fully verified'}</span>
        <span class="isp-supply-acts"><button type="button" class="isp-linkbtn" data-act="supplyRoute" aria-expanded="${ui.chainOpen}">${ui.chainOpen ? 'Hide full route' : `Full route (${sup.primary.path.length})`}</button>
        <button type="button" class="isp-linkbtn" data-act="supplyHighlight" data-asset-id="${esc(id)}">Highlight</button>
        <button type="button" class="isp-linkbtn" data-act="supplyConnections" data-asset-id="${esc(id)}">Connections</button></span></div>
      <div class="isp-supply-chain">${chain}</div>
      ${ui.chainOpen ? `<div class="isp-supply-full"><p class="isp-muted">${esc(verificationText(sup))}. Physical route, source first: <b>${esc(sup.primary.path[0])}</b></p><ol class="isp-route">${full}</ol>
        ${sup.alternatives.length ? `<p class="isp-muted">${sup.alternatives.length} alternative ${sup.alternatives.length === 1 ? 'route needs' : 'routes need'} a normally-open device closed (${esc([...new Set(sup.alternatives.flatMap(r => r.needsClosing))].join(', '))}).</p>` : ''}
        ${sup.unresolved.length ? `<p class="isp-muted">${sup.unresolved.length} more ${sup.unresolved.length === 1 ? 'route passes' : 'routes pass'} a load the model gives no feed-through (${esc([...new Set(sup.unresolved.flatMap(u => u.at))].join(', '))}): not offered as supply.</p>` : ''}</div>` : ''}`;
  }

  // ---- the panel: an asset, or a result ----

  const chip = (id, nodeState, { dot = true } = {}) => {
    const a = network.assets.get(id);
    const state = nodeState.get(id);
    const tone = state === 'live' ? 'ok' : state === 'backup' ? 'warn' : state === 'dead' || state === 'off' ? 'bad' : 'neutral';
    return `<button type="button" class="isp-ichip" data-asset="${esc(id)}" title="${esc(a?.name ?? id)}">${dot ? `<i class="isp-dot is-${tone}"></i>` : ''}${a ? icon(a, state, 20) : ''}<span>${esc(a ? `${TYPE_NAME[a.assetType] ?? ''} ${id}`.trim() : id)}</span></button>`;
  };
  const chips = (ids, nodeState, limit = 40) => `<div class="isp-ichips">${ids.slice(0, limit).map(id => chip(id, nodeState)).join('')}${ids.length > limit ? `<span class="isp-muted">+${ids.length - limit}</span>` : ''}</div>`;
  const tableOf = values => `<table class="isp-props"><tbody>${Object.entries(values).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v === null || v === '' ? '<span class="isp-muted">(empty)</span>' : esc(v)}</td></tr>`).join('')}</tbody></table>`;

  /** An asset, as the electrical twin's Assets screen shows it, with its properties from the IFC in ACC. */
  function assetHtml(a) {
    const st = session.state();
    const { nodeState, openSwitches } = networkState(network, st.active ? st.scenario : null);
    const state = nodeState.get(a.id);
    const isSwitch = SWITCHING_TYPES.has(a.assetType);
    const stateText = isSwitch ? `${openSwitches.has(a.id) ? 'Open' : 'Closed'}${a.normalState === 'OPEN' ? ' · normally open' : ''}`
      : { live: 'Energized', backup: 'On generator', standby: a.standby ? 'Standby, ready' : 'Standby path', dead: 'No power', off: a.assetType === 'FEEDER' ? 'Cut (fault)' : 'Offline' }[state];
    const { path, live } = traceSupplyPath(network, a.id, { scenario: st.active ? st.scenario : baselineScenario() });
    const element = built.byGlobalId.get(a.globalId);
    const sets = Object.entries(element?.properties ?? {});
    const row = (k, v) => (v === null || v === undefined || v === '' ? '' : `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`);
    const near = neighbours(a.id);
    const docs = documentsForAsset(ui.docs, a.id);
    const tabs = [['overview', 'Overview'], ['connections', 'Connections'], ['properties', 'Properties'], ['documents', `Documents${docs.length ? ` (${docs.length})` : ''}`]];
    // Immediate context: what supplies it, and what it supplies next.
    // From the resolved supply (topology.js): what it is fed from, and what follows it.
    const route = supplyOf(a.id).primary?.path ?? path;
    const upstream = route.length > 1 ? route[route.length - 2] : null;
    const downstream = near.filter(id => id !== upstream && !route.includes(id));
    const isLoad = a.electricalRole === ROLE.LOAD;
    const idChips = ids => ids.map(id => `<button type="button" class="isp-insp-chip" data-asset="${esc(id)}">${esc(id)}</button>`).join('');
    const pill = statusPill(a.id);
    const opStatus = statuses.get(a.id)?.monitored ? statuses.get(a.id) : null;
    const tab = ui.assetTab;
    const body = {
      overview: `${notLocatable([a.id]).length ? '<p class="isp-note">This asset has no position in the model, so it cannot be shown on the map.</p>' : ''}
      <section class="isp-insp-card"><h3>${ASK_ICONS.bolt}Electrical Details</h3>
      <dl class="isp-dl">${row('Voltage', a.voltageLevel)}${row('Rating', a.ratingText)}${row('Capacity', Number.isFinite(a.capacityKw) ? kw(a.capacityKw) : null)}
        ${row('Demand (modelled)', Number.isFinite(a.demandKw) ? kw(a.demandKw) : null)}${row('Reefer plugs', a.reeferPlugs)}${row('Circuit', a.circuit)}
        ${row('Route length', Number.isFinite(a.routeLengthM) ? `${Math.round(a.routeLengthM)} m` : null)}${isSwitch ? row('Normal state', (a.normalState ?? 'CLOSED').toLowerCase()) : ''}
        ${a.reportedPower ? row('Reported in ACC', `${a.reportedPower === 'NO_POWER' ? 'No power' : 'Powered'}${a.statusDate ? ` · ${a.statusDate}` : ''}`) : ''}
        ${a.statusFlag && !/^ok$/i.test(a.statusFlag) ? row('Status flag', a.statusFlag) : ''}
        ${row('Position', a.illustrative ? 'Modelled in the IFC (illustrative, not surveyed)' : 'From the IFC model')}
        ${opStatus ? row('Operational status', `${STATUS_LABEL[statuses.get(a.id).status]}${statuses.get(a.id).source === 'TOPOLOGY' ? ' (from connectivity)' : statuses.get(a.id).source === 'REPORTED' ? ' (reported in the model)' : ''}`) : ''}</dl></section>
      ${opStatus?.status === STATUS.NO_POWER ? `<div class="isp-actions"><button type="button" class="isp-btn is-danger" data-ops-investigate="${esc(a.id)}">Investigate outage</button></div>` : ''}
      <div class="isp-actions isp-insp-more">
        ${isSwitch ? `<button type="button" class="isp-btn is-primary" data-switch="${openSwitches.has(a.id) ? 'CLOSED' : 'OPEN'}">${openSwitches.has(a.id) ? 'Close' : 'Open'} ${esc(a.id)}</button>`
          : `<button type="button" class="isp-btn is-danger" data-inv="OUTAGE">${a.assetType === 'FEEDER' ? 'Simulate cable cut' : 'Simulate outage'}</button>`}
        <button type="button" class="isp-btn" data-inv="UPSTREAM">View network path</button><button type="button" class="isp-btn" data-inv="DOWNSTREAM">Downstream</button>
        <button type="button" class="isp-btn" data-act="focusAsset" data-asset-id="${esc(a.id)}">Focus on map</button></div>`,
      properties: `<div class="isp-sec">From ACC · IFC model</div>
      <dl class="isp-dl">${row('Source', sourceLabel)}${row('IFC GlobalId', a.globalId)}${row('IFC class', [a.ifcClass, element?.predefinedType].filter(Boolean).join(' · '))}${row('Tag', element?.tag)}${row('Role', a.networkRole)}</dl>
      ${sets.map(([name, values], i) => `<details class="isp-group"${i === 0 ? ' open' : ''}><summary>${esc(name)} <span class="isp-badge">${Object.keys(values).length}</span></summary>${tableOf(values)}</details>`).join('')}`,
      connections: `<section class="isp-insp-card"><h3>${ASK_ICONS.network}Upstream</h3>
        ${upstream ? `<div class="isp-insp-conn">${idChips([upstream])}</div>${live ? '' : '<p class="isp-muted">Normal supply · no power now</p>'}` : '<p class="isp-muted">A source: nothing supplies it.</p>'}</section>
      <section class="isp-insp-card"><h3>${ASK_ICONS.network}${isLoad ? 'Circuit continues to' : 'Downstream'}${downstream.length ? ` · ${downstream.length}` : ''}</h3>
        ${downstream.length ? `<div class="isp-insp-conn">${idChips(downstream)}</div>${isLoad ? `<p class="isp-muted">Through ${esc(a.id)}’s ${a.feedThrough ? 'loop-in / loop-out terminals' : 'connections'}: supplied by the circuit, not by ${esc(a.id)}.</p>` : ''}`
          : `<p class="isp-muted">${isLoad ? 'The end of its circuit in the model.' : 'Supplies nothing further in the model.'}</p>`}</section>`,
      documents: ui.docs ? documentListHtml(docs) : '<p class="isp-muted isp-doc-none">Reading the asset documentation from ACC…</p>',
    }[tab];
    const back = ui.ask?.snapshot ? `<button type="button" class="isp-insp-foot-btn" data-act="askBack">${ASK_ICONS.back}<span>Back to Results (${ui.ask.ids.length})</span></button>` : '';
    return `<div class="isp-insp">
      <div class="isp-insp-top"><h2 class="isp-insp-id">${esc(a.id)}</h2><button type="button" class="isp-x" data-act="netClear" aria-label="Close the inspector">${ASK_ICONS.close}</button></div>
      <div class="isp-insp-sum"><span class="isp-insp-ic">${ASK_ICONS[ICON_OF[a.assetType] ?? 'bolt']}</span>
        <div><div class="isp-insp-type">${esc(typeName(a))}</div><div class="isp-insp-name" title="${esc(a.name)}">${esc(a.name)}</div>
        <span class="isp-insp-pill is-${esc(pill?.tone ?? 'neutral')}">${esc(isSwitch ? stateText : pill?.label ?? stateText ?? '')}</span></div></div>
      <div class="isp-tabs" role="tablist" aria-label="Asset details">${tabs.map(([key, label]) => `<button type="button" role="tab" class="isp-tab" data-asset-tab="${key}" aria-selected="${key === tab}">${esc(label)}</button>`).join('')}</div>
      <div class="isp-tabpanel" role="tabpanel">${body}</div>
      ${back ? `<div class="isp-insp-foot">${back}</div>` : ''}</div>`;
  }

  /** A simulated outage, as the electrical twin shows it: who lost power, what went dark, what stayed on, and why. */
  function outageHtml(r, st) {
    const { nodeState } = networkState(network, st.scenario);
    const res = st.result;
    // The scenario result holds plain lists (or sets); read them as sets.
    const lostConsumers = new Set(res.consumersLost ?? []);
    const lost = [...lostConsumers];
    const equipment = [...new Set(res.lost ?? [])].filter(id => !lostConsumers.has(id) && !(st.scenario.offline ?? []).includes(id));
    const consumers = [...network.assets.values()].filter(a => CONSUMER_TYPES.has(a.assetType)).map(a => a.id);
    const still = consumers.filter(id => !lostConsumers.has(id));
    const rerouted = [...(res.rerouted ?? [])];
    const failed = st.scenario.offline ?? [];
    // A failed load with a loop-in / loop-out: what follows it stays supplied through its terminals, but would
    // be affected if the fault is in the terminals themselves.
    const throughTerminals = failed.filter(id => network.assets.get(id)?.feedThrough);
    const ifTerminals = throughTerminals.length ? compareScenario(network, st.scenario, { blockFeedThrough: throughTerminals }).consumersLost.filter(id => !lostConsumers.has(id) && !failed.includes(id)) : [];
    return `<div class="isp-head"><span class="isp-q">${esc(ui.question ?? st.label)}</span><button type="button" class="isp-x" data-act="netClear" aria-label="Close">×</button></div>
      <div class="isp-kicker is-bad">Simulated outage · not the live state</div>
      <h2 class="isp-title">${esc(st.label)}</h2>
      <div class="isp-big"><b class="${lost.length ? 'is-bad' : 'is-ok'}">${lost.length}</b><span>consumer${lost.length === 1 ? '' : 's'} without power</span></div>
      ${lost.length ? chips(lost, nodeState) : '<p class="isp-muted">Every consumer is still supplied.</p>'}
      ${equipment.length ? `<details class="isp-fold" open><summary>De-energized equipment · ${equipment.length}</summary>${chips(equipment, nodeState)}</details>` : ''}
      ${ifTerminals.length ? `<details class="isp-fold" open><summary>Potentially affected · ${ifTerminals.length}</summary><p class="isp-muted">Fed through ${esc(throughTerminals.join(', '))}’s loop-in / loop-out terminals: still supplied when only the load is out, lost if the fault is in the terminals.</p>${chips(ifTerminals, nodeState)}</details>` : ''}
      ${rerouted.length ? `<details class="isp-fold" open><summary>On an alternate supply · ${rerouted.length}</summary>${chips(rerouted, nodeState)}</details>` : ''}
      <details class="isp-fold"><summary>Still powered · ${still.length} consumers</summary>${chips(still, nodeState)}</details>
      <details class="isp-fold"><summary>Why?</summary><p class="isp-summary">${esc(r?.answer?.summary ?? '')}</p>${(r?.answer?.limitations ?? []).map(l => `<p class="isp-muted">${esc(l)}</p>`).join('')}</details>
      <div class="isp-actions"><button type="button" class="isp-btn is-primary" data-act="netReset">Reset simulation</button>
        ${failed[0] ? `<button type="button" class="isp-btn" data-path="${esc(failed[0])}">View network path</button>` : ''}
        <button type="button" class="isp-btn" data-act="affected">View affected assets</button></div>`;
  }

  const INTENT_KIND = { UPSTREAM: 'Supply path', UPSTREAM_TYPE: 'Supply path', DOWNSTREAM: 'Connectivity', OUTAGE: 'Outage impact', TRANSFER: 'Load transfer', SHORT_CIRCUIT: 'Short circuit',
    ENGINEERING: 'Engineering', LOAD: 'Load', CONDITION: 'Asset condition', OVERDUE: 'Maintenance', COUNT: 'Inventory', LIST: 'Inventory', ASSET: 'Asset', UNKNOWN: 'Ask the Twin' };
  const STATUS_OF = { ANSWERED: 'answered', LIMITED: 'limited', UNSUPPORTED: 'unsupported', NOT_FOUND: 'unsupported' };

  /** An engine answer as the structured answer view: direct answer, findings, details, sources, actions. */
  function resultView(r) {
    const st = session.state();
    if (st.active && (r.intent === 'OUTAGE' || r.intent === 'TRANSFER')) {
      return { question: ui.question ?? st.label, kind: 'Simulated outage', status: 'answered', say: `Simulated: ${st.label}.`, html: outageHtml(r, st) };
    }
    if (r.intent === 'LOCATE' && r.status === 'ANSWERED' && network.assets.has(r.primaryAssetId)) return locateView(r.primaryAssetId);
    if ((r.intent === 'PATH' || r.intent === 'UPSTREAM') && r.status === 'ANSWERED' && network.assets.has(r.primaryAssetId)) return supplyView(r.primaryAssetId);
    const { nodeState } = networkState(network, st.active ? st.scenario : null);
    const A = r.answer;
    const ids = new Set(network.assets.keys());
    const { lead, rest } = splitLead(A.summary, ids);
    const item = id => ({ id, label: chipLabel(id), dot: { live: 'ok', backup: 'warn', standby: 'off', dead: 'bad', off: 'bad' }[nodeState.get(id)] ?? 'off', attrs: { 'data-asset': id } });
    const groups = [];
    if (r.paths?.[0]?.assetIds?.length > 1) groups.push({ label: 'Supply path, direction of supply ↓', tone: 'info', items: r.paths[0].assetIds.map(item) });
    for (const g of r.resultGroups ?? []) if (g.assetIds?.length) groups.push({ label: g.label, tone: { bad: 'bad', warn: 'warn', ok: 'ok', good: 'ok' }[g.tone] ?? 'neutral', items: g.assetIds.map(item) });
    const intent = String(r.intent ?? 'UNKNOWN');
    const sources = [`IFC model ${sourceLabel}`, 'electrical connectivity from its port relations'];
    if (/short-circuit screening/i.test(JSON.stringify(A.limitations ?? []))) sources.push('the model’s short-circuit screening (SuperDNA_ShortCircuit)');
    if (st.active) sources.push(`simulation: ${st.label}`);
    const targets = [...new Set([...(r.targetAssetIds ?? []), ...(r.cameraTargetAssetIds ?? [])])];
    const actions = [];
    if (targets.length) actions.push({ label: 'Show on map', primary: true, attrs: { 'data-act': 'answerFrame' } });
    if (r.primaryAssetId && network.assets.has(r.primaryAssetId)) actions.push({ label: `Open ${r.primaryAssetId}`, attrs: { 'data-asset': r.primaryAssetId } });
    if (st.active) actions.push({ label: 'Reset simulation', attrs: { 'data-act': 'netReset' } });
    const list = intent === 'LIST' || intent === 'COUNT';
    if (intent === 'UNKNOWN') {
      return { question: ui.question ?? 'Ask the Twin', kind: 'Ask the Twin', status: STATUS_OF[r.status] ?? 'unsupported', say: A.title.endsWith('.') ? A.title : `${A.title}.`,
        say2: 'Questions this model can answer:', followUps: groundedSuggestions(), sources };
    }
    for (const g of groups) { g.note = provenanceNote(g.items.map(it => it.id)); g.noun = g.label.toLowerCase(); }
    // Beyond a load on its circuit: fed by the circuit, not by the load.
    if (intent === 'DOWNSTREAM' && network.assets.get(r.primaryAssetId)?.electricalRole === ROLE.LOAD) {
      for (const g of groups) g.label = g.label.replace(/^Normally supplied from /, 'Beyond on the same circuit, past ');
    }
    if (list && groups.length === 1 && groups[0].items.length > 1) {
      const noun = groups[0].label.toLowerCase();
      const c = collectionOf(groups[0].items.map(it => it.id), { noun, nounOne: noun.replace(/s$/, '') });
      return { question: ui.question ?? 'Ask the Twin', kind: INTENT_KIND[intent], status: STATUS_OF[r.status] ?? 'answered', say: collectionSay(c, noun), collection: c };
    }
    return {
      question: ui.question ?? 'Ask the Twin', kind: INTENT_KIND[intent] ?? intent.replaceAll('_', ' ').toLowerCase(), status: STATUS_OF[r.status] ?? 'answered',
      say: sayOf(r, groups), say2: list ? highlightNote(groups[0]?.items.length ?? 0) : null,
      title: A.title, lead: list ? null : lead, groups,
      // A list's rows say it all; elsewhere the engine's lines, without the per-line position note (the card has it once).
      bullets: list ? [] : (A.lines ?? []).map(l => l.replace(/\s*·\s*illustrative position, not a surveyed location/gi, '')),
      details: [
        { title: 'Full explanation', items: [...rest, ...(A.explanation ? [A.explanation] : [])] },
        { title: 'Determined from the model', items: A.determinable ?? [] },
        { title: 'Inputs needed for a full answer', items: A.missingInputs ?? [] },
        { title: 'Limitations and assumptions', items: A.limitations ?? [] },
      ],
      sources, actions, followUps: (A.followUps ?? []).map(f => ({ label: f.label, question: f.question })),
    };
  }
  /** Suggestions about what this model actually contains (never the demo inventory's T1 or C1). */
  function groundedSuggestions() {
    const has = id => network.assets.has(id);
    const tx = [...network.assets.values()].find(a => a.assetType === 'TRANSFORMER')?.id;
    const crane = [...network.assets.values()].find(a => a.assetType === 'CRANE')?.id;
    return [
      ...(facilityRegistry.substations.length ? [{ label: 'How many substations are there?', question: 'How many substations are there?', icon: 'layers' }] : []),
      ...(tx && has(tx) ? [{ label: `What does ${tx} supply?`, question: `What does ${tx} supply?`, icon: 'bolt' }] : []),
      ...(crane ? [{ label: `What supplies ${crane}?`, question: `What supplies ${crane}?`, icon: 'network' }] : []),
      ...(has('USS-1') && has('USS-2') ? [{ label: 'Does USS-1 supply USS-2?', question: 'Does USS-1 supply USS-2?', icon: 'network' }] : []),
      { label: 'Which assets have no power?', question: 'Which assets have no power?', icon: 'bolt' },
    ].slice(0, 3);
  }
  /** The first sentence of an engine answer, in plain words. */
  function sayOf(r, groups) {
    const A = r.answer, id = r.primaryAssetId;
    const end = t => (/[.!?…]$/.test(t) ? t : `${t}.`);
    if ((r.intent === 'LIST' || r.intent === 'COUNT') && /^\d+ /.test(A.title)) return `I found ${A.title} across Seagirt.`;
    if (r.intent === 'DOWNSTREAM' && id && network.assets.get(id)?.electricalRole === ROLE.LOAD) {
      return `${id} is a load: it supplies nothing. Its circuit continues through its ${network.assets.get(id).feedThrough ? 'loop-in / loop-out terminals' : 'connections'} to what follows, which is supplied by the circuit, not by ${id}.`;
    }
    // A filtered question ("lights supplied by TX-2"): its own noun, as the engine counted it.
    const typed = r.intent === 'DOWNSTREAM' && id ? /^(\d+) (.+?) connected to /.exec(A.title ?? '') : null;
    if (typed) return `${id} supplies ${typed[1]} ${typed[2]} in the model.`;
    if (r.intent === 'DOWNSTREAM' && id) {
      // The engine's own count (its title), so the sentence and the list agree.
      const n = Number(/^(\d+) /.exec(A.title ?? '')?.[1] ?? groups[0]?.items.length ?? 0);
      return n ? `${id} supplies ${n} ${n === 1 ? 'asset' : 'assets'} downstream in the model.` : `The model shows nothing supplied from ${id}.`;
    }
    if ((r.intent === 'PATH' || r.intent === 'UPSTREAM') && id) return `Here is the supply path to ${id}.`;
    return end(String(A.title ?? ''));
  }
  /** One position note for a whole list, only when it applies. */
  function provenanceNote(ids) {
    const as = ids.map(id => network.assets.get(id)).filter(Boolean);
    const n = as.filter(a => a.illustrative).length;
    return !n ? null : n === as.length ? 'Locations are illustrative, not surveyed.' : 'Some locations are illustrative, not surveyed.';
  }
  /** What the map shows of a list, once it is on the map. */
  function highlightNote(n) {
    const placed = ui.ask?.placed ?? 0;
    if (!n || !placed) return null;
    return placed >= n ? `All ${n === 9 ? 'nine' : n} are included in the map highlights.` : `${placed} of them are highlighted on the map; the others have no position in the model.`;
  }
  const STATUS_PILL = { POWERED: ['Energized', 'ok'], NO_POWER: ['No power', 'bad'], DEGRADED: ['Degraded', 'warn'], OFFLINE: ['Offline', 'neutral'] };
  const STATE_PILL = { live: ['Energized', 'ok'], backup: ['On generator', 'warn'], standby: ['Standby', 'neutral'], dead: ['No power', 'bad'], off: ['Offline', 'neutral'] };
  /** An asset's status as a pill: the operational status where monitored, else its electrical state. */
  function statusPill(id) {
    const s = statuses.get(id);
    const st = session.state();
    const [label, tone] = (s?.monitored && STATUS_PILL[s.status]) || STATE_PILL[networkState(network, st.active ? st.scenario : null).nodeState.get(id)] || [];
    return label ? { label, tone } : null;
  }
  const ICON_OF = { TRANSFORMER: 'transformer', SWITCHGEAR: 'switchgear', SUBSTATION: 'switchgear', CIRCUIT_BREAKER: 'switchgear', SWITCH: 'switchgear', JUNCTION_BOX: 'switchgear',
    FEEDER: 'cable', LIGHTING_CIRCUIT: 'light', UTILITY_SUPPLY: 'source', GENERATOR: 'source', CRANE: 'crane' };
  const typeName = a => cap(TYPE_NAME[a.assetType] ?? typeLabel(a.assetType));
  /** A result row's details, from the network: where it is and its status. */
  function describeRow(item) {
    const a = network.assets.get(item.id);
    if (!a) return null;
    const zone = zoneOf(a);
    return { title: a.id, sub: zone ? `${typeName(a)} · ${zone}` : typeName(a), status: statusPill(a.id), icon: ICON_OF[a.assetType] ?? 'bolt' };
  }
  /** Follow-up questions that fit the asset: what it supplies for equipment, what supplies it for loads. */
  function suggestionsFor(a) {
    const supplies = !CONSUMER_TYPES.has(a.assetType);
    return [
      ...(supplies ? [{ label: `What does ${a.id} supply?`, question: `What does ${a.id} supply?`, icon: 'bolt' }, { label: 'Show downstream assets', question: `Show downstream assets of ${a.id}`, icon: 'network' }]
        : [{ label: `What supplies ${a.id}?`, question: `What supplies ${a.id}?`, icon: 'bolt' }, { label: 'Which transformer supplies it?', question: `Which transformer supplies ${a.id}?`, icon: 'network' }]),
      { label: `Any recent changes to ${a.id}?`, question: `Any recent changes to ${a.id}?`, icon: 'clock' },
    ];
  }
  /**
   * "What supplies HM-3?" / "Show the physical cable route to HM-3": the resolved supply, in words, the
   * logical chain, the physical route with each hop's evidence, alternatives and what is unresolved.
   */
  function supplyView(id) {
    const sup = supplyOf(id);
    const a = network.assets.get(id);
    const physical = /\b(physical|cable route|cables?|route)\b/i.test(ui.question ?? '');
    if (!sup.primary) {
      return { question: ui.question, kind: 'Electrical supply', status: 'limited', say: `The model has no supply route to ${id}.`,
        say2: sup.unresolved.length ? `Its connections pass ${[...new Set(sup.unresolved.flatMap(u => u.at))].join(', ')}, which the model gives no feed-through, so no route through them is offered as supply.` : null,
        sources: [`IFC model ${sourceLabel} · port connections`] };
    }
    const chain = compactChain(sup.logical);
    const names = chain.filter(x => x.kind !== 'target').map(x => x.id);
    const item = x => ({ id: x, label: x, attrs: { 'data-asset': x } });
    const hopRow = h => ({ id: h.to, label: h.to, attrs: { 'data-asset': h.to }, sub: `${typeName(network.assets.get(h.to))} · ${EVIDENCE_TEXT[h.evidence]}` });
    const groups = [
      { label: 'Electrical supply, source first', noun: 'steps', tone: 'info', items: sup.logical.filter(x => x.kind !== 'circuit').map(x => item(x.id)) },
      { label: 'Physical route, with evidence', noun: 'steps', tone: 'neutral', items: sup.primary.hops.map(hopRow), raw: true },
    ];
    if (physical) groups.reverse();
    return { question: ui.question, kind: 'Electrical supply', status: 'answered',
      say: `${id} is supplied from ${names[0]} through ${names.slice(1).join(', ')}.`,
      say2: sup.verification === 'VERIFIED' ? 'Every connection on this route has its direction stated in the IFC.'
        : `Supply path not fully verified: ${sup.primary.inferred} of ${sup.primary.hops.length} connections have no direction in the IFC (SOURCEANDSINK ports); their direction is taken from the source side under normal switch states.${sup.primary.feedThrough.length ? ` It passes the loop-in / loop-out terminals of ${sup.primary.feedThrough.join(', ')}, which do not supply ${id}.` : ''}`,
      groups,
      bullets: [
        ...(sup.alternatives.length ? [`${sup.alternatives.length} alternative ${sup.alternatives.length === 1 ? 'route' : 'routes'} if ${[...new Set(sup.alternatives.flatMap(r => r.needsClosing))].join(' / ')} ${[...new Set(sup.alternatives.flatMap(r => r.needsClosing))].length === 1 ? 'is' : 'are'} closed (normally open).`] : []),
        ...(sup.unresolved.length ? [`${sup.unresolved.length} more ${sup.unresolved.length === 1 ? 'route passes' : 'routes pass'} a load with no modelled feed-through (${[...new Set(sup.unresolved.flatMap(u => u.at))].join(', ')}): not offered as supply.`] : []),
        ...(statuses.get(id)?.status === STATUS.NO_POWER ? [`${id} reports no power in the model: this is its modelled supply, not the cause.`] : []),
      ],
      actions: [{ label: 'Highlight route', primary: true, attrs: { 'data-act': 'supplyHighlight', 'data-asset-id': id } }],
      followUps: statuses.get(id)?.status === STATUS.NO_POWER ? [{ label: `Why does ${id} have no power?`, question: `Why does ${id} have no power?`, icon: 'bolt' }] : suggestionsFor(a).slice(0, 2),
      sources: [`IFC model ${sourceLabel} · IfcRelConnectsPorts with port FlowDirection`, 'switch states: the model’s normal states'],
      details: [{ title: 'Evidence', items: [`Connections with a stated direction (SOURCE → SINK): ${sup.primary.explicit}`, `Without a direction (SOURCEANDSINK): ${sup.primary.inferred}`,
        ...(sup.primary.feedThrough.length ? [`Through loop-in / loop-out terminals: ${sup.primary.feedThrough.join(', ')}`] : [])] }] };
  }

  /** "Why does HM-3 have no power?": the reported status, its modelled supply, and what to check — never a cause the data does not give. */
  function askWhy(question, id) {
    const a = network.assets.get(id);
    const s = statuses.get(id);
    const sup = supplyOf(id);
    const st = session.state();
    const { nodeState } = networkState(network, st.active ? st.scenario : null);
    ui.result = null; ui.question = question;
    const upstreamDead = (sup.primary?.path ?? []).slice(0, -1).filter(x => nodeState.get(x) === 'dead' || nodeState.get(x) === 'off');
    const lastProtection = [...(sup.logical ?? [])].reverse().find(x => x.role === ROLE.PROTECTION || x.role === ROLE.SWITCH)?.id;
    const tail = sup.primary ? sup.primary.path.slice(sup.primary.path.indexOf(lastProtection) + 1, -1).filter(x => network.assets.get(x)?.assetType === 'FEEDER') : [];
    const points = [
      ...(lastProtection ? [`${lastProtection} (the last protective device before ${id}): its state`] : []),
      ...(tail.length ? [`Continuity of ${tail.join(', ')}${network.assets.get(tail[0])?.circuit ? ` (circuit ${network.assets.get(tail[0]).circuit})` : ''}`] : []),
      `${id} itself: its local supply, intake or equipment`,
    ];
    const reported = s?.status === STATUS.NO_POWER;
    ui.view = { question, kind: 'Fault investigation', status: reported ? 'answered' : 'limited',
      say: reported ? `${id} reports no power${s.source === 'REPORTED' ? ' in the model' : ''}; the model does not say why.` : `${id} does not report a loss of power (${STATUS_LABEL[s?.status] ?? 'no status'}).`,
      say2: reported ? (upstreamDead.length ? `Upstream on its modelled supply, ${upstreamDead.join(', ')} ${upstreamDead.length === 1 ? 'is' : 'are'} without power too.` : 'Everything upstream on its modelled supply is energized in the model, so the loss is between the last energized equipment and the asset.') : null,
      groups: sup.primary ? [{ label: 'Modelled supply', noun: 'steps', tone: 'info', items: compactChain(sup.logical).filter(x => x.kind !== 'circuit').map(x => ({ id: x.id, label: x.id, attrs: { 'data-asset': x.id } })) }] : [],
      bullets: [...points.map(p => `Check: ${p}`), ...(a.description ? [`Status note in the model: “${a.description}”`] : [])],
      actions: [{ label: `Investigate ${id}`, primary: true, attrs: { 'data-ops-investigate': id } }],
      details: [{ title: 'Limitations and assumptions', items: ['Possible investigation points, not confirmed causes.', sup.verification === 'VERIFIED' ? 'The supply path is verified in the IFC.' : 'The supply path is not fully verified in the IFC (some connections have no direction).', 'No live SCADA feed: statuses are those recorded in the model.'] }],
      sources: [`Asset status in the IFC model (SuperDNA_AssetStatus${a.statusDate ? `, ${a.statusDate}` : ''})`, `IFC model ${sourceLabel} · port connections`] };
    setAskResults(sup.primary?.path ?? [id], question, { keep: id });
    render();
    if (ui.ask) frame(ui.ask.ids, { pitch: -55, minRange: 300 });
  }

  // ---- many assets found: the collection card (rows, key details, back / clear) ----

  /** The model's reported status of an asset — the baseline, never a simulated one. */
  function reportedPill(id) {
    const s = statuses.get(id);
    const [label, tone] = (s?.monitored && STATUS_PILL[s.status]) || STATE_PILL[networkState(network, null).nodeState.get(id)] || ['Unknown', 'neutral'];
    return { label, tone };
  }
  const versionTag = () => { const m = /\bv(\d+)\b/i.exec(sourceLabel); return m ? `IFC V${m[1]}` : 'IFC model'; };
  /**
   * A collection of assets from an answer's own ids: rows with the reported status, counts by status, one
   * position note, and whether the map shows them (only once it does).
   */
  function collectionOf(ids, { noun, nounOne }) {
    const assets = ids.map(id => network.assets.get(id)).filter(Boolean);
    const n = assets.length;
    const located = ids.filter(id => network.assets.get(id)?.route?.length >= 2 || Number.isFinite(network.assets.get(id)?.location?.longitude));
    const rows = assets.map(a => ({ id: a.id, name: a.name, icon: ICON_OF[a.assetType] ?? 'bolt', status: reportedPill(a.id) }));
    const byStatus = new Map();
    for (const r of rows) byStatus.set(r.status.label, [...(byStatus.get(r.status.label) ?? []), r.id]);
    const counts = [...byStatus.entries()].sort((x, y) => y[1].length - x[1].length)
      .map(([label, list]) => `${list.length} ${label.toLowerCase()}${list.length <= 3 && list.length < n ? ` (${list.join(', ')})` : ''}`).join(', ');
    const illustrative = assets.filter(a => a.illustrative).length;
    const highlighted = Boolean(ui.ask) && ui.ask.ids.length === new Set(ids.filter(id => network.assets.has(id))).size && ids.every(id => ui.ask.ids.includes(id)) && (ui.ask.placed ?? 0) > 0;
    const title = `${n} ${cap(n === 1 ? nounOne : noun)}`;
    return { icon: rows[0]?.icon ?? 'bolt', title, sub: `Across the terminal (${versionTag()})`, highlighted, rows, selectedId: ui.ask?.selectedId ?? null,
      keyDetails: [`${title.toLowerCase()} in total.`.replace(/^./, c => c.toUpperCase()), `${cap(counts)} (reported in the model).`,
        located.length < n ? `${n - located.length} ${n - located.length === 1 ? 'has' : 'have'} no position in the model: listed, not on the map.` : `Locations are from the IFC model (${versionTag().replace('IFC ', '')}).`],
      note: illustrative ? 'Locations are modeled and may not represent surveyed positions.' : null, located: located.length, n };
  }
  /** "I found 9 transformers across Seagirt and highlighted them on the map." — the map part only when it is so. */
  function collectionSay(c, noun) {
    const found = `I found ${c.n} ${c.n === 1 ? noun.replace(/s$/, '') : noun} across Seagirt`;
    if (!c.highlighted) return c.located ? `${found}.` : `${found}; none has a position in the model to show on the map.`;
    return c.located === c.n ? `${found} and highlighted them on the map.` : `${found} and highlighted the ${c.located} with a position in the model on the map.`;
  }

  /** One asset found: the summary card, its map focus and follow-ups. The focus state is read live. */
  function locateView(id) {
    const a = network.assets.get(id);
    const f = ui.focus?.id === id ? ui.focus : null;
    const type = typeName(a);
    const rows = [['Location', zoneOf(a), 'target'], ['Rating', a.ratingText, 'bolt'], ['Voltage', a.ratingText ? null : a.voltageLevel, 'bolt'],
      ['Capacity', Number.isFinite(a.capacityKw) ? kw(a.capacityKw) : null, 'network'], ['Route length', Number.isFinite(a.routeLengthM) ? `${Math.round(a.routeLengthM)} m` : null, 'cable'],
      ['Reported in ACC', a.statusDate ?? null, 'clock']].filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v, icon]) => ({ k, v, icon }));
    const say = f?.state === 'ok' ? `Here is ${id}.` : f?.state === 'nogeo' ? `I found ${id}, but the model has no position for it.` : `Locating ${id}…`;
    const say2 = f?.state === 'ok' ? `I've located the ${type.toLowerCase()} in the Seagirt IFC model, focused the map on it, and highlighted it.`
      : f?.state === 'nogeo' ? 'So I can’t focus the map on it; its details are in the inspector.' : null;
    return { question: ui.question, kind: 'Asset', status: 'answered', say, say2, title: a.name,
      asset: { id, type, icon: ICON_OF[a.assetType] ?? 'bolt', status: statusPill(id), rows, focus: f ?? { state: 'idle' },
        docs: ui.docs ? documentsForAsset(ui.docs, id).length : undefined, note: a.illustrative ? 'Position modelled in the IFC (illustrative, not surveyed).' : null },
      followUps: suggestionsFor(a), sources: [`IFC model ${sourceLabel}`, a.illustrative ? 'position modelled in the IFC (illustrative, not surveyed)' : 'position from the IFC model'] };
  }
  /** A chip's text: the asset's id with its kind, short. */
  function chipLabel(id) {
    const a = network.assets.get(id);
    return a ? `${typeLabel(a.assetType) === 'feeder' ? 'Cable' : cap(TYPE_NAME[a.assetType] ?? typeLabel(a.assetType))} ${id}` : id;
  }

  // ---- Ask the Twin: power status and paths between assets, from the screen's own data ----

  // ---- spatial search: near, within, nearest, inside, between ----

  /** "Show all assets within 100 m of the main substation": the results, their boundary, on the map and in the conversation. */
  function askSpatial(question, p) {
    ui.result = null; ui.question = question;
    // An analytical answer: no single asset's focus or inspector from an earlier question stays open.
    clearFocus(); ui.inspector = null;
    const idx = spatial();
    const sources = [`IFC model ${sourceLabel} · positions in the model’s own metres (horizontal); approximate, model-based distances`];
    const done = view => { ui.view = { question, status: 'answered', sources, ...view }; render(); };
    if (!p.targets) {
      return done({ kind: 'Spatial search', say: `I can’t find “${p.unknownCategory ?? 'that'}” among the asset types of this model.`, say2: 'These are the types it has:',
        followUps: idx.categories.slice(0, 3).map(c => ({ label: c, question: question.replace(new RegExp(`\\b${p.unknownCategory}s?\\b`, 'i'), `${c.toLowerCase()}s`), icon: 'layers' })),
        bullets: [idx.categories.join(', ')] });
    }
    if (!p.references.length) return done({ kind: 'Spatial search', say: 'Near what? Name an asset, a substation or an area (or select an asset on the map).', followUps: groundedSuggestions() });
    // Filters on reported status, documents, recent changes, electrical supply — or say why one cannot be applied.
    const limits = [];
    let unknownStatus = 0;
    const tests = [];
    if (p.filters.status) {
      const want = p.filters.status;
      // The reported status where the model has one; otherwise the modelled electrical state (connectivity).
      const { nodeState } = networkState(network, null);
      const FROM_STATE = { live: STATUS.POWERED, backup: STATUS.POWERED, dead: STATUS.NO_POWER, off: STATUS.NO_POWER };
      tests.push(x => {
        const s = statuses.get(x.id);
        const status = s?.monitored && s.status !== STATUS.UNKNOWN ? s.status : FROM_STATE[nodeState.get(x.id)] ?? null;
        if (!status) { unknownStatus += 1; return false; }
        return want === 'POWERED' ? status === STATUS.POWERED : status === want;
      });
    }
    if (p.filters.documents) { if (ui.docs) tests.push(x => documentsForAsset(ui.docs, x.id).length > 0); else limits.push('Linked documents are not loaded from ACC yet: that filter was not applied.'); }
    if (p.filters.recentChanges) { if (ui.cmp?.changeIds?.length) { const ch = new Set(ui.cmp.changeIds); tests.push(x => ch.has(x.id)); } else limits.push('No version comparison has been run: “recent changes” could not be applied (ask “What changed between the latest two IFC versions?” first).'); }
    if (p.filters.suppliedBy && network.assets.has(p.filters.suppliedBy)) {
      const by = p.filters.suppliedBy;
      tests.push(x => network.assets.has(x.id) && x.id !== by && (supplyOf(x.id).primary?.path ?? []).includes(by));
      limits.push(`“Supplied by ${by}”: on its normal supply route in the model; where connections have no direction in the IFC, that direction is inferred.`);
    }
    const res = querySpatial(idx, p, { matches: x => tests.every(t => t(x)) });
    if (!res.refs.length) return done({ kind: 'Spatial search', say: `The model has no position for ${p.references.map(r => r.id).join(', ')}, so I can’t search around it.` });
    if (p.op === 'DISTANCE') {
      if (res.refs.length < 2) return done({ kind: 'Distance', say: `The model has no position for ${p.references.slice(1).map(r => r.id).join(', ')}.` });
      setAskResults(res.refs.map(r => r.id).filter(id => network.assets.has(id)), question);
      render();
      if (ui.ask) frame(ui.ask.ids, { pitch: -70, minRange: 260 });
      return done({ kind: 'Distance', say: `${res.refs[0].id} and ${res.refs[1].id} are ${approxMetres(res.distance)} apart (horizontal, between the nearest parts of their geometry).`,
        say2: 'An approximate, model-based distance: positions in this IFC are illustrative, not surveyed.' });
    }
    if (p.filters.status) limits.push(`Status: as reported in the model where recorded, otherwise the modelled electrical state.${unknownStatus ? ` ${unknownStatus} with neither ${unknownStatus === 1 ? 'was' : 'were'} left out (never assumed energized).` : ''}`);
    if (session.state().active && p.filters.status) limits.push('Status filter: the reported status, not the running simulation.');
    const refName = r => { const f = idx.facilities.find(x => x.id === r.id); return f ? `${f.id} (${f.kind?.toLowerCase() ?? 'facility'})` : r.type === 'AREA' ? `the ${r.id.toLowerCase()}` : r.id; };
    const refText = p.everyFacility ? 'every substation' : res.refs.map(refName).join(' and ');
    const n = res.results.length;
    const noun = p.targets === 'ALL' ? (n === 1 ? 'asset' : 'assets') : p.targets.length === 1 ? (n === 1 ? p.targets[0].toLowerCase() : `${p.targets[0].toLowerCase()}s`.replace(/ss$/, 'sses').replace(/(\(scada\))s$/i, '$1')) : 'assets';
    const say = p.op === 'NEAREST' ? (n ? `The nearest ${n === 1 ? noun : `${n} ${noun}`} to ${refText}: ${res.results.map(x => `${x.entry.id} (${approxMetres(x.distance)})`).join(', ')}.` : `No ${noun} found near ${refText}.`)
      : p.op === 'INSIDE' ? `${refText} contains ${n} ${noun} in the IFC (IfcRelAggregates).`
        : p.op === 'BETWEEN' ? `${n} ${noun} lie in a ${res.corridor.width} m corridor either side of the straight line from ${res.refs[0].id} to ${res.refs[1].id}.`
          : `${p.countOnly ? '' : 'Showing '}${n} ${noun} ${p.countOnly ? (n === 1 ? 'is ' : 'are ') : ''}within ${p.radius} m of ${refText}${p.defaultRadius ? ' (default radius)' : ''}.`;
    const byCat = Object.entries(res.results.reduce((m, x) => ({ ...m, [x.entry.category]: (m[x.entry.category] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1]);
    const toneOf = id => ({ ok: 'ok', warn: 'warn', bad: 'bad' })[reportedPill(id)?.tone] ?? 'neutral';
    const rows = res.results.slice(0, 100).map(x => (x.entry.facility
      ? { id: x.entry.id, name: x.entry.name, icon: 'switchgear', status: { label: `${x.entry.kind ?? x.entry.category} · ${approxMetres(x.distance)}`, tone: 'info' }, attrs: { 'data-ask': `What equipment belongs to ${x.entry.id}?` } }
      : { id: x.entry.id, name: x.entry.name, icon: ICON_OF[network.assets.get(x.entry.id)?.assetType] ?? 'bolt', status: { label: `${x.entry.category} · ${approxMetres(x.distance)}`, tone: network.assets.has(x.entry.id) ? toneOf(x.entry.id) : 'neutral' },
          attrs: network.assets.has(x.entry.id) ? undefined : null }));
    const radiusChips = p.op === 'WITHIN' ? [50, 200, 500].filter(r => r !== p.radius).map(r => ({ label: `Within ${r} m`, question: `Show ${p.targets === 'ALL' ? 'all assets' : `${noun}`} within ${r} m of ${p.everyFacility ? 'every substation' : res.refs.map(x => x.id).join(' and ')}`, icon: 'target' })) : [];
    done({ kind: p.op === 'NEAREST' ? 'Nearest assets' : p.op === 'INSIDE' ? 'Inside a facility' : p.op === 'BETWEEN' ? 'Between two places' : 'Nearby assets',
      say, say2: [byCat.length > 1 ? byCat.map(([c, k]) => `${k} ${c.toLowerCase()}`).join(' · ') : null, n > 100 ? `The first 100 of ${n} are listed; all are on the map.` : null, ...limits].filter(Boolean).join(' '),
      collection: rows.length ? { title: say, rows } : null,
      followUps: [...radiusChips, ...byCat.slice(0, byCat.length > 1 ? 2 : 0).map(([c]) => ({ label: `Only ${c.toLowerCase()}s`, question: `Show ${c.toLowerCase()}s ${p.op === 'NEAREST' ? 'nearest to' : `within ${p.radius ?? 100} m of`} ${res.refs.map(x => x.id).join(' and ')}`, icon: 'layers' }))].slice(0, 3),
      actions: n ? [{ label: 'Show all on map', primary: true, attrs: { 'data-act': 'askBack' } }, { label: 'Clear highlights', attrs: { 'data-act': 'askClear' } }] : [] });
    ui.lastAssets = res.refs.filter(r => network.assets.has(r.id)).map(r => r.id);
    // On the map: the results (equipment and facilities), the references, the search boundary.
    const toLL = ([x, y]) => modelToLonLat(x, y, 0);
    const locOf = x => (x.facility ? (() => { const c = x.geometry.ring.reduce((a, q) => [a[0] + q[0], a[1] + q[1]], [0, 0]).map(v => v / x.geometry.ring.length); return toLL(c); })() : null);
    const assetIds = res.results.map(x => x.entry.id).filter(id => network.assets.has(id));
    const refAssets = res.refs.filter(r => network.assets.has(r.id)).map(r => r.id);
    setAskResults([...assetIds, ...refAssets], question, { noun: p.targets === 'ALL' ? 'results' : noun });
    if (ui.ask) {
      const extra = [...res.results.filter(x => x.entry.facility).map(x => ({ id: `fac:${x.entry.id}`, label: x.entry.id, ll: locOf(x.entry) })),
        ...res.refs.filter(r => r.type !== 'ASSET').map(r => { const g = r.geometry; const c = g.type === 'Point' ? g.xy : g.ring.reduce((a, q) => [a[0] + q[0], a[1] + q[1]], [0, 0]).map(v => v / g.ring.length); return { id: r.type === 'FACILITY' ? `fac:${r.id}` : `area:${r.id}`, label: r.id, ll: toLL(c) }; })];
      if (extra.length) {
        const items = [...ui.ask.ids.map(id => network.assets.get(id)).filter(a => a && !(a.route?.length >= 2) && Number.isFinite(a.location?.longitude)).map(a => ({ id: a.id, label: a.id, kind: HL_KIND[a.assetType] ?? 'load', lon: a.location.longitude, lat: a.location.latitude, alert: markerIds.has(a.id) })),
          ...extra.map(e => ({ id: e.id, label: e.label, kind: 'switchgear', lon: e.ll.lon, lat: e.ll.lat }))];
        askHl.set(items, { size: items.length, noun: 'results' });
      }
      ui.ask.count = n; ui.ask.noun = n === 1 ? 'result' : 'results';
      const rings = p.op === 'INSIDE' ? res.refs.map(r => r.geometry.ring) : p.op === 'BETWEEN' ? [bufferOutline(res.corridor.line, res.corridor.width)] : p.op === 'WITHIN' ? res.refs.map(r => bufferOutline(r.geometry, p.radius)) : [];
      askHl.setBoundary(rings.map(ring => ring.map(toLL)));
    }
    render();
    const pts = [...assetIds, ...refAssets];
    if (pts.length) frame(pts, { pitch: -70, minRange: Math.max(260, (p.radius ?? 100) * 2.2) });
  }

  // ---- relationships between assets, alternate supply, what an asset is ----

  const REL_TEXT = { [RELATIONSHIP.VERIFIED_SUPPLY]: ['Verified supply', 'ok'], [RELATIONSHIP.MODELED_DIRECTIONAL_PATH]: ['Modeled directional path', 'info'],
    [RELATIONSHIP.PHYSICALLY_CONNECTED]: ['Physically connected', 'warn'], [RELATIONSHIP.NO_MODELED_SUPPLY_PATH]: ['No modeled supply path', 'neutral'],
    [RELATIONSHIP.UNKNOWN]: ['Unknown', 'neutral'], [RELATIONSHIP.INVALID_ASSET]: ['Asset not found', 'bad'] };
  /** "Is USS-1 supplying USS-2?" / "Are USS-1 and USS-2 connected?": the relationship card, the path on the map. */
  function askRelationship(question, sourceId, targetId, { physicalOnly = false } = {}) {
    const st = session.state();
    const { nodeState } = networkState(network, st.active ? st.scenario : null);
    const rel = checkSupplyRelationship(topo, network, sourceId, targetId, { scenario: st.active ? st.scenario : null, version: sourceLabel,
      isLive: p => p.every(x => ['live', 'backup'].includes(nodeState.get(x)) || network.assets.get(x)?.feedThrough) });
    ui.result = null; ui.question = question;
    clearFocus(); ui.inspector = null;
    ui.lastAssets = [sourceId, targetId];
    const [label, tone] = REL_TEXT[rel.classification];
    const d = rel.directionalSupply ?? {};
    const phys = rel.physicalConnectivity ?? { connected: false, path: [] };
    const via = p => (p.length > 2 ? ` through ${p.slice(1, -1).join(' → ')}` : ' directly');
    let say, say2;
    if (rel.classification === RELATIONSHIP.INVALID_ASSET) { say = `I can’t find ${rel.missingAssets.join(' and ')} in the model.`; }
    else if (physicalOnly) {
      say = phys.connected ? `Yes. ${sourceId} and ${targetId} are physically connected${via(phys.path)}.` : `No. ${sourceId} and ${targetId} are not connected in the model.`;
      say2 = phys.connected ? 'A connection in the IFC (port to port); it does not by itself say which way power flows.' : 'No chain of IFC port connections joins them.';
    } else if (rel.classification === RELATIONSHIP.MODELED_DIRECTIONAL_PATH) {
      say = `The model contains a directional supply path from ${sourceId} to ${targetId}${via(rel.modeledPath)}, but current power flow cannot be verified.`;
      say2 = 'Every connection on it is stated SOURCE → SINK in the IFC; there is no live data to confirm it is flowing now.';
    } else if (rel.classification === RELATIONSHIP.PHYSICALLY_CONNECTED) {
      say = d.onNormalRoute ? `${sourceId} and ${targetId} are physically connected, and in normal service ${targetId}’s supply route passes through ${sourceId} — but the supply direction is not established.`
        : d.onlyWhenClosing?.length ? `${sourceId} and ${targetId} are physically connected, but ${sourceId} would supply ${targetId} only with ${d.onlyWhenClosing.join(' and ')} closed (normally open).`
          : `${sourceId} and ${targetId} are physically connected, but no supply route runs from ${sourceId} to ${targetId} in the model.`;
      say2 = d.inferredConnections ? `${d.inferredConnections} of the connections between them have no direction in the IFC (SOURCEANDSINK); the direction shown is taken from the source side under normal switch states.` : null;
    } else {
      say = `No directed supply path from ${sourceId} to ${targetId} was found in the current model.`;
      say2 = d.reverse ? `It runs the other way: ${targetId} is upstream of ${sourceId}.` : phys.connected ? null : 'They are not connected in the model either.';
    }
    const path = physicalOnly || !rel.modeledPath?.length ? phys.path : rel.modeledPath;
    ui.view = { question, kind: physicalOnly ? 'Connection' : 'Supply relationship', status: 'answered', say, say2,
      relation: rel.classification === RELATIONSHIP.INVALID_ASSET ? null : {
        title: physicalOnly ? 'Physical Connection' : 'Supply Relationship', version: versionTag(), source: sourceId, target: targetId, label: physicalOnly ? (phys.connected ? 'Physically connected' : 'Not connected') : label,
        tone: physicalOnly ? (phys.connected ? 'info' : 'neutral') : tone, path,
        facts: [
          ['Physical connection', phys.connected ? `Yes${via(phys.path)}` : 'No'],
          ...(physicalOnly ? [] : [['Supply direction', !rel.modeledPath?.length ? 'No route from the source side' : d.directionStated ? 'Stated in the IFC (SOURCE → SINK)' : `Inferred (${d.inferredConnections} undirected connection${d.inferredConnections === 1 ? '' : 's'})`],
            ['Normal service', d.onNormalRoute ? `${targetId}’s route passes ${sourceId}` : d.onlyWhenClosing?.length ? `Only with ${d.onlyWhenClosing.join(', ')} closed` : 'No']]),
          ['Operational supply', 'Not verified — no live SCADA feed'],
        ],
        evidence: (rel.evidence ?? []).map(e => `${e.from} → ${e.to}: ${EVIDENCE_TEXT[e.evidence]}${e.ports?.[0] ? ` · ports ${e.ports.filter(Boolean).join(' / ')}` : ''}`),
        missing: rel.missingEvidence ?? [],
        actions: [...(path.length > 1 ? [{ label: 'Show path on map', primary: true, attrs: { 'data-act': 'relPath', 'data-ids': path.join(',') } }] : []),
          { label: `Inspect ${sourceId}`, attrs: { 'data-act': 'inspect', 'data-asset-id': sourceId } }, { label: `Inspect ${targetId}`, attrs: { 'data-act': 'inspect', 'data-asset-id': targetId } },
          { label: 'View connections', attrs: { 'data-act': 'supplyConnections', 'data-asset-id': targetId } }] },
      sources: [`IFC model ${sourceLabel} · IfcRelConnectsPorts with port FlowDirection`, 'switch states: the model’s normal states'] };
    setAskResults(path.length > 1 ? path : [sourceId, targetId].filter(id => network.assets.has(id)), question);
    render();
    if (ui.ask) frame(ui.ask.ids, { pitch: -62, minRange: 260 });
  }

  /** "Does TX-M1 have an alternate supply if it shuts down?", "If USS-1 fails, can USS-2 still get power?" */
  function askAlternate(question, { failedAssetId: failed, targetAssetId: target, candidateSourceId: candidate }) {
    const st = session.state();
    const alt = alternateSupplyOf(network, failed, { base: st.active ? st.scenario : null, targetId: target, candidateId: candidate });
    ui.result = null; ui.question = question;
    clearFocus(); ui.inspector = null;
    ui.lastAssets = [failed, target, candidate].filter(Boolean);
    const optionLine = o => `Close ${o.switchId}: restores ${o.restored.length} ${o.restored.length === 1 ? 'load' : 'loads'} (${kw(o.restoredKw)})${o.overloads.length ? ` — overloads ${o.overloads.map(i => i.id).join(', ')}` : ''}.`;
    let say, say2;
    if (target) {
      const on = ['live', 'backup'].includes(alt.target.state);
      say = on ? `Yes. If ${failed} fails, ${target} still has power over another route in the model.`
        : alt.target.restoredBy.length ? `Not by itself. If ${failed} fails, ${target} loses power; closing ${alt.target.restoredBy.join(' or ')} (normally open) would restore it.`
          : `No. If ${failed} fails, ${target} loses power and no normally-open device in the model brings it back.`;
      say2 = on && alt.target.path.length ? `Its route then: ${alt.target.path.join(' → ')}.` : null;
    } else if (candidate) {
      const n = new Set(alt.viaCandidate.flatMap(o => o.restored)).size;
      say = n ? `Partly or fully: with ${failed} out, ${candidate} can pick up ${n} of ${alt.lost.length} affected ${alt.lost.length === 1 ? 'load' : 'loads'} by closing ${alt.viaCandidate.map(o => o.switchId).join(' or ')}.`
        : `No. With ${failed} out, the model has no normally-open device that lets ${candidate} supply the affected loads.`;
      say2 = alt.viaCandidate.some(o => o.overloads.length) ? `Check capacity: ${alt.viaCandidate.filter(o => o.overloads.length).map(optionLine).join(' ')}` : null;
    } else {
      const restorable = new Set(alt.options.flatMap(o => o.restored));
      say = !alt.lost.length ? `If ${failed} shuts down, every consumer keeps a supply${alt.rerouted.length ? ` (${alt.rerouted.length} over another route)` : ''}.`
        : restorable.size ? `If ${failed} shuts down, ${alt.lost.length} ${alt.lost.length === 1 ? 'consumer loses' : 'consumers lose'} supply; ${restorable.size === alt.lost.length ? 'all' : restorable.size} can be restored by closing a normally-open device.`
          : `If ${failed} shuts down, ${alt.lost.length} ${alt.lost.length === 1 ? 'consumer loses' : 'consumers lose'} supply and the model has no alternate supply for them.`;
      say2 = null;
    }
    const item = x => ({ id: x, label: x, attrs: { 'data-asset': x } });
    ui.view = { question, kind: 'Alternate supply', status: 'answered', say, say2,
      metrics: [{ label: 'Lose supply', value: alt.lost.length, tone: alt.lost.length ? 'bad' : 'ok' }, { label: 'Restorable', value: new Set(alt.options.flatMap(o => o.restored)).size, tone: 'info' },
        { label: 'Still supplied (rerouted)', value: alt.rerouted.length, tone: 'ok' }],
      bullets: (candidate ? alt.viaCandidate : alt.options).slice(0, 6).map(optionLine),
      groups: alt.lost.length ? [{ label: `Lose supply if ${failed} fails`, noun: 'consumers', tone: 'bad', items: alt.lost.map(item) }] : [],
      actions: [{ label: `Simulate ${failed} outage`, attrs: { 'data-act': 'simulateAsset', 'data-asset-id': failed } }],
      sources: ['IFC connectivity, normal switch states; a what-if: the reported status and any running simulation are unchanged'] };
    setAskResults([failed, ...alt.lost, ...(target ? [target] : [])], question, { keep: failed });
    render();
    if (ui.ask) frame(ui.ask.ids, { pitch: -62, minRange: 300 });
  }

  /** "What is USS-1?", "Is USS-1 a substation or a ring main unit?": its IFC class, role, and the facility it belongs to. */
  function askDetails(question, id) {
    const a = network.assets.get(id);
    const fac = facilityRegistry.facilities.find(f => f.equipment.some(e => e.networkId === id));
    const sameName = facilityRegistry.facilities.find(f => f.id === id && f !== fac) ?? (fac?.id === id ? fac : null);
    ui.result = null; ui.question = question;
    ui.lastAssets = [id];
    setAskResults([id], question);
    const say = `${id} is a ${typeName(a).toLowerCase()} — ${a.ifcClass}${a.networkRole ? `, NetworkRole “${a.networkRole}”` : ''} in the IFC.`;
    const say2 = fac ? `It is part of ${fac.id}, a ${fac.kind.toLowerCase()} (IfcElementAssembly ${fac.type}), with ${fac.equipment.filter(e => (e.networkId ?? e.tag) !== id).map(e => e.networkId ?? e.tag).join(', ')}.${sameName ? ` “${id}” names both: the ${fac.kind.toLowerCase()} assembly and this ${typeName(a).toLowerCase()} inside it.` : ''}`
      : 'It is not part of a substation or other assembly in the model.';
    ui.view = { question, kind: 'Asset', status: 'answered', say, say2,
      actions: [{ label: `Show ${id} on the map`, primary: true, attrs: { 'data-asset': id } }, ...(fac ? [{ label: `What else is in ${fac.id}?`, attrs: { 'data-ask': `What equipment belongs to ${fac.id}?` } }] : [])],
      sources: [`IFC model ${sourceLabel} · IFC class, SuperDNA_PowerNetwork.NetworkRole${fac ? ', IfcRelAggregates' : ''}`] };
    render();
  }

  /** "What happens if it fails?" with more than one asset in the conversation: which one. */
  function askClarify(question, options) {
    ui.result = null; ui.question = question;
    ui.view = { question, kind: 'Ask the Twin', status: 'answered', say: `Which asset do you mean: ${options.slice(0, -1).join(', ')}${options.length > 1 ? ' or ' : ''}${options.at(-1)}?`,
      followUps: options.slice(0, 3).map(id => ({ label: id, question: question.replace(/\b(it|its|this asset|that asset|this|that)\b/i, id), icon: 'target' })) };
    render();
  }

  // ---- facilities: substations from the IFC's assemblies ----

  /** Facilities on the map: one locator each (at its equipment's centre); their equipment stays bright. */
  function setFacilityResults(list, question) {
    const memberIds = list.flatMap(f => f.equipment.map(e => e.networkId)).filter(id => network.assets.has(id));
    if (ui.focus) { clearFocus(); ui.inspector = null; }
    const located = list.filter(f => f.location);
    if (!located.length) { ui.ask = null; askHl.clear(); return; }
    ui.ask = { ids: memberIds, question, snapshot: null, selectedId: null, placed: located.length, count: list.length, noun: list.length === 1 ? 'facility' : 'facilities' };
    askHl.set(located.map(f => ({ id: `fac:${f.id}`, label: f.id, kind: 'switchgear', lon: f.location.lon, lat: f.location.lat })), { size: list.length, noun: 'substations' });
  }
  /** A facility question answered: counts and rows in the conversation, the facilities or their equipment on the map. */
  function askFacility(question, f) {
    ui.result = null; ui.question = question;
    const facilityRow = x => ({ id: x.id, name: x.name, icon: 'switchgear', status: { label: x.kind, tone: 'info' }, attrs: { 'data-ask': `What equipment belongs to ${x.id}?` } });
    const sources = [...f.notes, `IFC model ${sourceLabel}`];
    if (f.kind === 'members') {
      const fac = f.facilities[0];
      const rows = f.members.map(e => (network.assets.has(e.networkId)
        ? { id: e.networkId, name: e.name, icon: ICON_OF[network.assets.get(e.networkId).assetType] ?? 'bolt', status: reportedPill(e.networkId) }
        : { id: e.tag ?? e.name, name: e.name, icon: 'switchgear', status: { label: e.ifcClass.replace(/^Ifc/, ''), tone: 'neutral' }, attrs: null }));
      ui.view = { question, kind: fac.kind, status: 'answered', say: f.say, say2: f.say2, collection: rows.length > 0 ? { title: fac.id, rows } : null, sources };
      setAskResults(f.members.map(e => e.networkId).filter(Boolean), question, { noun: 'items' });
      render();
      if (ui.ask) frame(ui.ask.ids, { pitch: -60, minRange: 260 });
      return;
    }
    const rows = f.kind === 'supply' ? f.groups.map(g => ({ ...facilityRow(g.facility), status: { label: `${g.facility.kind} · ${g.assets.length} supplied`, tone: 'info' } })) : f.facilities.map(facilityRow);
    ui.view = { question, kind: f.kind === 'compare' ? 'Facilities' : 'Substations', status: 'answered', say: f.say, say2: f.say2,
      collection: rows.length ? { title: `${rows.length} substations`, rows } : null, bullets: f.bullets ?? [], sources };
    setFacilityResults(f.facilities, question);
    render();
    const pts = f.facilities.flatMap(x => x.equipment.map(e => e.networkId)).filter(id => network.assets.has(id));
    if (pts.length) frame(pts, { pitch: -70, minRange: 300 });
  }

  /** Which assets have no power (or are degraded): from the statuses this screen already computes. */
  function askStatus(question) {
    const wantsDegraded = /\bdegraded\b/i.test(question);
    const noPower = alerts.filter(a => a.status === STATUS.NO_POWER);
    const degraded = alerts.filter(a => a.status === STATUS.DEGRADED);
    const shown = wantsDegraded && !/\b(no power|without power|unpowered)\b/i.test(question) ? degraded : wantsDegraded ? [...noPower, ...degraded] : noPower;
    const item = a => ({ id: a.id, label: a.id, dot: a.status === STATUS.NO_POWER ? 'bad' : 'warn', attrs: { 'data-asset': a.id } });
    const reported = noPower.filter(a => a.source === 'REPORTED').length;
    ui.result = null; ui.question = question;
    ui.view = { question, kind: 'Power status', status: 'answered',
      title: wantsDegraded && shown === degraded ? `${degraded.length} degraded ${degraded.length === 1 ? 'asset' : 'assets'}` : `${noPower.length} ${noPower.length === 1 ? 'asset has' : 'assets have'} no power`,
      lead: noPower.length || degraded.length ? `${noPower.length ? `No power: ${noPower.map(a => a.id).join(', ')}${reported ? ` (${reported === noPower.length ? 'reported in the model' : `${reported} reported in the model, the rest without a supply path`})` : ' (no supply path in the model)'}.` : 'Every monitored asset has power.'}${degraded.length && !wantsDegraded ? ` ${degraded.length} more ${degraded.length === 1 ? 'is' : 'are'} degraded.` : ''}` : 'Every monitored asset has power.',
      metrics: [{ label: 'No power', value: summary.counts.NO_POWER, tone: 'bad' }, { label: 'Degraded', value: summary.counts.DEGRADED, tone: 'warn' }, { label: 'Powered', value: summary.counts.POWERED, tone: 'ok' }, { label: 'Unknown', value: summary.counts.UNKNOWN, tone: 'neutral' }],
      groups: [{ label: 'No power', tone: 'bad', items: noPower.map(item) }, ...(wantsDegraded || degraded.length <= 8 ? [{ label: 'Degraded', tone: 'warn', items: degraded.map(item) }] : [])],
      sources: [`Asset status in the IFC model (SuperDNA_AssetStatus${summary.asOf ? `, ${summary.asOf}` : ''}) and its connectivity; no live SCADA feed`],
      actions: noPower[0] ? [{ label: `Investigate ${noPower[0].id}`, primary: true, attrs: { 'data-ops-investigate': noPower[0].id } }] : [] };
    const noun = wantsDegraded && shown === degraded ? 'degraded assets' : wantsDegraded ? 'assets without power or degraded' : 'assets without power';
    setAskResults(shown.map(a => a.id), question, { noun });
    if (shown.length > 1) {
      const c = collectionOf(shown.map(a => a.id), { noun, nounOne: noun.replace(/^assets/, 'asset').replace(/^degraded assets$/, 'degraded asset') });
      Object.assign(ui.view, { collection: c, groups: [], say: collectionSay(c, noun), lead: null, metrics: [], sources: [], details: [], actions: [] });
    }
    render();
    if (ui.ask) frame(ui.ask.ids, { pitch: -55, minRange: 300 });
  }

  /**
   * The cables between two assets, along the model's supply path: "between USS-1 and the main
   * substation", "from TX-M1 to USS-2". Returns false when the question names no asset to start from.
   */
  function askPath(question) {
    const ids = namedIds(question, new Set(network.assets.keys()));
    if (!ids.length) return false;
    const mainSub = /\bmain substation\b|\bmss\b/i.test(question);
    if (ids.length < 2 && !mainSub) return false;
    const [a, b] = ids;
    const pathTo = id => traceSupplyPath(network, id, { scenario: baselineScenario() }).path;
    let segment = null, other = b;
    const pa = pathTo(a);
    if (mainSub && !b) {
      const k = pa.map((id, i) => [id, i]).filter(([id]) => zoneOf(network.assets.get(id)) === 'Main Substation').map(([, i]) => i).at(-1);
      if (k !== undefined) segment = pa.slice(k);
      other = 'the main substation';
    } else if (pa.includes(b)) segment = pa.slice(pa.indexOf(b));
    else { const pb = pathTo(b); if (pb.includes(a)) segment = pb.slice(pb.indexOf(a)); }
    ui.result = null; ui.question = question;
    const sources = [`IFC model ${sourceLabel} · electrical connectivity (normal switch states)`];
    if (!segment || segment.length < 2) {
      ui.view = { question, kind: 'Network path', status: 'answered', title: `No modelled supply path between ${a} and ${other}`, lead: 'Neither is on the other\u2019s normal supply path in the model.', sources };
      setAskResults([a, b].filter(Boolean), question);
    } else {
      const cables = segment.filter(id => network.assets.get(id)?.assetType === 'FEEDER');
      const metres = cables.reduce((n, id) => n + (network.assets.get(id).routeLengthM ?? 0), 0);
      ui.view = { question, kind: 'Network path', status: 'answered',
        title: cables.length ? `${cables.length} ${cables.length === 1 ? 'cable connects' : 'cables connect'} ${a} and ${other}` : `${a} and ${other} connect without a cable`,
        lead: `${cables.join(', ')}${metres ? ` (${(metres / 1000).toFixed(2)} km of route)` : ''}, along the supply path ${segment.join(' → ')}.`,
        groups: [{ label: 'Path, direction of supply ↓', tone: 'info', items: segment.map(id => ({ id, label: chipLabel(id), dot: 'ok', attrs: { 'data-asset': id } })) }],
        sources, actions: [{ label: 'Show on map', primary: true, attrs: { 'data-act': 'askBack' } }] };
      setAskResults(segment, question);
    }
    render();
    if (ui.ask) frame(ui.ask.ids, { pitch: -55, minRange: 300 });
    return true;
  }

  // ---- Ask the Twin beyond the engine: IFC versions, documents ----

  /** A version question: resolved against ACC's versions, answered from the server's comparison. */
  async function askVersions(question, parsed) {
    const mine = ++askToken;
    // Asked about the selected area: kept as it was when asked (a later area never changes this answer).
    const area = ui.area && /^Selected area/.test(ui.turns[ui.turn]?.scope ?? '') ? ui.area : null;
    const fileName = compareTools.fileName();
    ui.result = null; ui.question = question;
    ui.view = { question, status: 'loading', title: 'Reading the versions of the model in ACC and comparing…' };
    render();
    try {
      const list = await compareTools.versions();
      const v = resolveVersions(parsed, list, { cmp: ui.cmp, active: compareTools.active() });
      if (v.error) throw Object.assign(new Error(v.error), { code: 'VERSIONS' });
      if (mine !== askToken) return;
      ui.view = { question, status: 'loading', title: `Comparing V${v.base} and V${v.target} of ${fileName}…` };
      render();
      const result = await compareTools.compare(v.base, v.target);
      if (mine !== askToken) return;
      if (area) { areaVersionsAnswer(question, area, result, v); return; }
      const sameCmp = ui.cmp && ui.cmp.base === v.base && ui.cmp.target === v.target;
      const { view, ids } = compareAnswer(parsed, result, { question, fileName, base: v.base, target: v.target, how: v.how, lastIds: sameCmp ? ui.cmp.lastIds : null });
      ui.cmp = { base: v.base, target: v.target, lastIds: ids?.length ? ids : sameCmp ? ui.cmp.lastIds : null, changeIds: new Set((result.changes ?? []).map(c => c.networkId).filter(Boolean)) };
      ui.view = view;
      // The changes that are assets of this model version (an added or kept one) go on the map here too.
      setAskResults((result.changes ?? []).filter(c => ids?.includes(c.globalId)).map(c => c.networkId ?? built.assetByGlobalId.get(c.globalId)?.id).filter(Boolean), question);
      render();
      // On the current map (the comparison screen opens only from "Open version comparison").
      if (ui.ask && ui.ask.ids.length <= 400) frame(ui.ask.ids, { pitch: -55, minRange: 300 });
      else if (parsed.wantsMap && ids?.length && !ui.ask) { ui.view = { ...ui.view, say2: 'None of them is in the loaded model version; open the version comparison to see them.' }; render(); }
    } catch (error) {
      if (mine !== askToken) return;
      ui.view = { question, kind: 'Version comparison', status: 'error', title: error.code === 'VERSIONS' ? error.message : 'The comparison could not be run',
        lead: error.code === 'VERSIONS' ? '' : `${error.message}${error.code ? ` (${error.code})` : ''}`, actions: [{ label: 'Retry', primary: true, attrs: { 'data-ask': question } }] };
      render();
    }
  }

  /** What changed between two versions inside the selected area (each version placed by its own positions). */
  function areaVersionsAnswer(question, a, result, v) {
    const cats = categoriesIn(question, spatial());
    const words = Array.isArray(cats) ? cats.map(c => c.toLowerCase()) : null;
    const matches = c => !words || words.some(w => `${c.kind ?? ''} ${c.ifcClass ?? ''} ${categoryOfId(c.networkId ?? '') ?? ''} ${c.name ?? ''}`.toLowerCase().includes(w.replace(/s$/, '')));
    const r = changesInArea(result.changes ?? [], { ring: a.ring, toLonLat: modelToLonLat, matches });
    const idOf = c => c.networkId ?? c.name ?? c.globalId;
    const what = words?.length === 1 ? pluralOf(cats[0]) : 'assets';
    const onlyAdded = /\badded\b/i.test(question) && !/\b(removed|moved|changed|modified)\b/i.test(question);
    const onlyRemoved = /\b(removed|deleted)\b/i.test(question) && !/\b(added|moved|changed|modified)\b/i.test(question);
    const onlyMoved = /\bmoved\b/i.test(question) && !/\b(added|removed|changed|modified)\b/i.test(question);
    const onlyConn = /\bconnection|connectivity\b/i.test(question);
    const counts = [['Added', r.added, 'ok'], ['Removed', r.removed, 'bad'], ['Moved into the area', r.movedIn, 'info'], ['Moved out of the area', r.movedOut, 'warn'], ['Moved within', r.movedWithin, 'neutral'], ['Modified', r.modified, 'neutral']];
    const shown = onlyAdded ? counts.slice(0, 1) : onlyRemoved ? counts.slice(1, 2) : onlyMoved ? counts.slice(2, 5) : onlyConn ? [['Connections changed', r.connectivity, 'info']] : counts;
    const n = new Set(shown.flatMap(([, list]) => list.map(c => c.globalId))).size;
    const say = n ? `Between V${v.base} and V${v.target}, ${shown.filter(([, l]) => l.length).map(([label, l]) => `${l.length} ${label.toLowerCase()}`).join(', ')} in the selected area${words ? ` (${what})` : ''}.`
      : `No ${onlyAdded ? 'added ' : onlyRemoved ? 'removed ' : onlyMoved ? 'moved ' : onlyConn ? 'connection ' : ''}${what === 'assets' ? 'changes' : what} in the selected area between V${v.base} and V${v.target}.`;
    const inModel = list => list.map(c => c.networkId ?? built.assetByGlobalId.get(c.globalId)?.id).filter(id => id && network.assets.has(id));
    const changed = shown.flatMap(([, list]) => list);
    const item = c => ({ id: idOf(c), label: idOf(c), attrs: network.assets.has(c.networkId ?? '') ? { 'data-asset': c.networkId } : null });
    areaView(question, a, { kind: 'Area version changes', say,
      say2: [r.unplaced.length ? `${r.unplaced.length} changed ${r.unplaced.length === 1 ? 'element has' : 'elements have'} no position in either version and could not be placed.` : '',
        result.frame?.frame === 'INCOMPATIBLE' ? 'The two versions use different coordinate frames: positions may not be comparable.' : '',
        'Each version is tested against the same boundary at its own positions; a removed asset is found where it was in the older version.'].filter(Boolean).join(' '),
      metrics: shown.map(([label, list, tone]) => ({ label, value: list.length, tone })),
      groups: shown.filter(([, l]) => l.length).map(([label, list, tone]) => ({ label, tone, noun: 'assets', items: list.map(item) })),
      sources: [...areaSources(a), `IFC comparison V${v.base} → V${v.target} (${compareTools.fileName()}); positions: a cable’s route midpoint, else the placement origin, else the box centre`],
      actions: [...(inModel(changed).length ? [{ label: 'View changed assets', primary: true, attrs: { 'data-cmp-show': inModel(changed).join(',') } }] : []),
        ...(changed.length ? [{ label: 'Open version comparison', attrs: { 'data-cmp-open': `${v.base}:${v.target}`, 'data-cmp-ids': changed.map(c => c.globalId).join(',') } }] : [])] });
    ui.cmp = { base: v.base, target: v.target, lastIds: changed.map(c => c.globalId), changeIds: new Set((result.changes ?? []).map(c => c.networkId).filter(Boolean)) };
    if (inModel(changed).length) areaHighlight(inModel(changed), question, 'assets');
  }

  // ---- answers from the asset's documents (server/ifcSpatial/docIntel.mjs) ----
  ui.lastDoc = null;
  // Analyses read in this session, by asset: follow-ups and tab changes reuse them (re-read after 10 minutes).
  const docCache = new Map();
  const DOC_CACHE_MS = 10 * 60 * 1000;
  /**
   * What taking an asset out of service means in the electrical model (never read from a PDF): consumers that
   * lose supply, normally-open devices that reach them (candidates, with modelled capacity), and the protective
   * devices either side for engineering review.
   */
  function replacementImpact(id) {
    if (!network.assets.has(id)) return null;
    const st = session.state();
    const alt = alternateSupplyOf(network, id, { base: st.active ? st.scenario : null });
    const candidates = alt.options.map(o => ({ switchId: o.switchId, restored: o.restored.length, restoredIds: o.restored,
      overloads: o.overloads.map(i => i.id), capacity: o.overloads.length ? 'OVERLOAD' : o.unmodelled?.length ? 'UNKNOWN' : 'OK' }));
    const sup = supplyOf(id);
    const path = sup.primary?.path ?? [];
    const upstream = [...path.slice(0, -1)].reverse().find(x => [ROLE.PROTECTION, ROLE.SWITCH].includes(network.assets.get(x)?.electricalRole)) ?? null;
    // Downstream: the first protective device or switch on each branch leaving the asset.
    const upstreamSet = new Set(path);
    const down = new Set();
    let frontier = [id];
    const seen = new Set([id]);
    for (let depth = 0; depth < 5 && frontier.length; depth += 1) {
      const next = [];
      for (const x of frontier) for (const e of built.edges) {
        if (e.fromAssetId !== x || seen.has(e.toAssetId) || upstreamSet.has(e.toAssetId)) continue;
        seen.add(e.toAssetId);
        if ([ROLE.PROTECTION, ROLE.SWITCH].includes(network.assets.get(e.toAssetId)?.electricalRole)) down.add(e.toAssetId); else next.push(e.toAssetId);
      }
      frontier = next;
    }
    return { assetId: id, lost: alt.lost, rerouted: alt.rerouted.length, candidates, upstream, downstream: [...down], pathVerified: sup.verification === 'VERIFIED' };
  }
  /** Follow-up questions that fit an analysis. */
  function docSuggestions(a, intent) {
    const id = a.asset.id;
    const other = [...new Set((ui.docs?.documents ?? []).map(d => d.mapping?.assetId).filter(x => x && x !== id && x.replace(/\d+$/, '') === id.replace(/\d+$/, '')))][0];
    const list = [];
    if (a.inspections.comparison.reports >= 2) list.push('Was the same defect reported in earlier inspections?', 'Has that issue been resolved?');
    if (intent !== 'ASSET_TECHNICAL_SPECIFICATIONS') list.push(a.asset.category === 'transformer' ? 'What is the rated capacity?' : `What are ${id}'s technical specifications?`);
    if (intent !== 'ASSET_REPLACEMENT_READINESS') list.push(`What should we verify before replacing ${id}?`);
    if (network.assets.has(id)) list.push('Which downstream assets would be affected during replacement?');
    if (other) list.push(`Compare ${id} and ${other} specifications`);
    list.push('Show the document where this was mentioned');
    return list.slice(0, 4);
  }

  async function askDocIntel(question, q) {
    const mine = ++askToken;
    ui.result = null; ui.question = question;
    clearFocus(); ui.inspector = null;
    if (q.intent === DOC_INTENT.SHOW_SOURCE) {
      const c = primaryCitation(ui.lastDoc.analyses[0], ui.lastDoc.intent);
      if (c) onDocument(c.documentId, { page: c.page });
      ui.view = c ? { question, kind: 'Documents', status: 'answered', say: `Opened ${c.fileName}${c.page ? ` at page ${c.page}` : ''}.`, lead: c.evidenceText ? `“${c.evidenceText}”` : null,
        extraHtml: `<div class="tw-doc"><button type="button" class="tw-cite" data-doc-cite="${esc(c.documentId)}"${c.page ? ` data-doc-page="${esc(c.page)}"` : ''}>Open it again${c.page ? ` · p.${esc(c.page)}` : ''}</button></div>` }
        : { question, kind: 'Documents', status: 'limited', say: 'The last answer has no document reference to open.' };
      render();
      return;
    }
    if (q.intent === DOC_INTENT.REPLACEMENT_IMPACT) { askAlternate(question, { failedAssetId: q.assetId, targetAssetId: null, candidateSourceId: null }); return; }
    if (q.needsAsset) {
      ui.view = { question, kind: 'Documents', status: 'answered', say: 'Which asset?', lead: 'Name one (for example TX-M2 or STS-02), or select it on the map and ask again.' };
      render();
      return;
    }
    if (q.intent === DOC_INTENT.FLEET) {
      ui.view = { question, status: 'loading', title: 'Reading inspection reports in ACC across assets…' };
      render();
      try {
        const f = await docTools.fleet();
        if (mine !== askToken) return;
        const recurring = f.assets.filter(x => x.recurring.length);
        ui.view = { question, kind: 'Documents', status: 'answered',
          say: recurring.length ? `${recurring.length} asset${recurring.length === 1 ? ' has' : 's have'} a finding recorded in more than one inspection report: ${recurring.map(x => x.assetId).join(', ')}.` : 'No asset has the same finding recorded in more than one inspection report.',
          extraHtml: fleetHtml(f), suggestions: recurring[0] ? [`Summarize ${recurring[0].assetId}'s inspection history`, `What should we verify before replacing ${recurring[0].assetId}?`] : [] };
        setAskResults(recurring.map(x => x.assetId).filter(id => network.assets.has(id)), question, { noun: 'assets' });
        render();
      } catch (error) { if (mine === askToken) docError(question, error); }
      return;
    }
    const ids = q.intent === DOC_INTENT.DOCUMENT_COMPARISON && q.compare === 'ASSETS' ? q.assetIds.slice(0, 3) : [q.assetId];
    // An analysis already read in this conversation answers its follow-ups: no new download or extraction.
    const known = ids.map(id => docCache.get(id)).filter(x => x && Date.now() - x.at < DOC_CACHE_MS);
    const cached = known.length === ids.length;
    ui.lastAssets = ids;
    if (network.assets.has(ids[0])) { setAskResults(ids.filter(id => network.assets.has(id)), question, { keep: ids[0] }); ui.selectedId = ids[0]; }
    if (!cached) { ui.view = { question, status: 'loading', title: `Reading ${ids.join(' and ')}${ids.length === 1 ? "'s" : "'"} documents in ACC…` }; render(); }
    try {
      const analyses = cached ? known.map(x => x.analysis) : await Promise.all(ids.map(id => docTools.analyze(id, q.analysisType ?? 'REPLACEMENT_READINESS')));
      if (mine !== askToken) return;
      if (!cached) for (const x of analyses) docCache.set(x.asset.id, { analysis: x, at: Date.now() });
      const a = analyses[0];
      ui.lastDoc = { assetId: a.asset.id, intent: q.intent, analyses };
      ui.lastInvestigation = null;
      if (ids.length > 1) {
        ui.view = { question, kind: 'Documents', status: 'answered', say: `${ids.join(' and ')} side by side, from their linked ACC documents.`, extraHtml: docCompareAssetsHtml(analyses, { aspect: q.aspect }),
          suggestions: ids.map(id => `Summarize ${id}'s inspection history`).slice(0, 2) };
      } else {
        const st = statuses.get(a.asset.id);
        const status = st && st.status !== STATUS.UNKNOWN ? { label: STATUS_LABEL[st.status], tone: { POWERED: 'ok', NO_POWER: 'bad', DEGRADED: 'warn', OFFLINE: 'bad' }[st.status] ?? 'neutral' } : null;
        const impact = a.review ? replacementImpact(a.asset.id) : null;
        // The workspace says it all; a sentence first only when it answers the question directly.
        const direct = q.field || ['CLOSURE', 'DEFECTS'].includes(q.focus) || q.intent === DOC_INTENT.CONDITION_TREND || q.intent === DOC_INTENT.EVIDENCE
          || (!a.inspections.count && [DOC_INTENT.INSPECTION_HISTORY, DOC_INTENT.MAINTENANCE_HISTORY].includes(q.intent));
        ui.view = { question, kind: 'ACC documents', status: 'answered', plain: Boolean(a.review), say: a.review && !direct ? '' : q.intent === DOC_INTENT.EVIDENCE ? q.evidenceSay ?? '' : docSay(a, q),
          extraHtml: docAnalysisHtml(a, { intent: q.intent === DOC_INTENT.EVIDENCE ? 'EVIDENCE' : q.intent, focus: q.focus, field: q.field, openItem: q.openItem ?? null, impact, status }),
          suggestions: docSuggestions(a, q.intent),
          actions: !a.review && network.assets.has(a.asset.id) ? [{ label: `Open ${a.asset.id}`, attrs: { 'data-asset': a.asset.id } }] : [] };
      }
      render();
      if (ui.ask) frame(ui.ask.ids, { pitch: -55, minRange: 350 });
    } catch (error) {
      if (mine === askToken) docError(question, error);
    }
  }
  function docError(question, error) {
    const signIn = error?.status === 401 || /NOT_AUTHENTICATED/.test(error?.code ?? '');
    ui.view = { question, kind: 'Documents', status: 'error', title: signIn ? 'Sign in to Autodesk to read the documents' : error?.code === 'UNKNOWN_ASSET' ? error.message : 'The documents could not be read',
      lead: signIn ? 'The documents are read from ACC with your own Autodesk account.' : error?.code === 'UNKNOWN_ASSET' ? '' : `${error?.message ?? error}${error?.code ? ` (${error.code})` : ''}`,
      actions: [{ label: 'Retry', primary: true, attrs: { 'data-ask': question } }] };
    render();
  }

  /** A documentation question: the asset's PDFs from the synced ACC index. */
  function askDocuments(question) {
    const id = namedIds(question, new Set([...network.assets.keys(), ...(ui.docs?.documents ?? []).map(d => d.mapping?.assetId).filter(Boolean)]))[0] ?? ui.selectedId;
    ui.result = null; ui.question = question;
    const sources = [`ACC Docs · Asset Documentation${ui.docs?.lastSyncedAt ? ` (synced ${new Date(ui.docs.lastSyncedAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })})` : ''}`];
    if (!ui.docs) ui.view = { question, kind: 'Documentation', status: 'limited', title: 'The documentation index is still loading', lead: 'Ask again in a moment.', actions: [{ label: 'Retry', primary: true, attrs: { 'data-ask': question } }] };
    else if (!id) ui.view = { question, kind: 'Documentation', status: 'answered', title: 'Which asset?', lead: `${ui.docs.summary.matched} documents are linked to assets. Name one (for example USS-7) or select it on the map.`, sources };
    else {
      const docs = documentsForAsset(ui.docs, id);
      ui.view = { question, kind: 'Documentation', status: 'answered', title: docs.length ? `${docs.length} ${docs.length === 1 ? 'document' : 'documents'} for ${id}` : `No document linked to ${id}`,
        lead: docs.length ? docs.map(d => `**${d.fileName}** (${d.categoryLabel}${d.versionNumber ? `, V${d.versionNumber}` : ''})`).join(', ') + '.' : 'The Asset Documentation folder in ACC has no PDF matched to this asset.',
        extraHtml: docs.length ? documentListHtml(docs) : '', sources, actions: network.assets.has(id) ? [{ label: `Open ${id}`, attrs: { 'data-asset': id } }] : [] };
      setAskResults([id], question);
    }
    render();
    if (ui.ask) frame(ui.ask.ids, { pitch: -50, minRange: 400 });
  }

  // ---- generated reports: a job on the server, its progress here, then files, a draft and the matching assets ----
  ui.reports = new Map();
  ui.lastReport = null;
  const REPORT_RUNNING = new Set(['PENDING', 'ANALYZING', 'GENERATING']);
  const reportTypes = () => new Set([...network.assets.values()].map(a => a.assetType));
  /** The assets a request covers, from the twin: identity, position, zone and the reported operational status. */
  function reportPopulation(types) {
    const evaluatedAt = new Date().toISOString();
    return [...network.assets.values()].filter(a => types.includes(a.assetType)).map(a => {
      const st = statuses.get(a.id);
      return { id: a.id, type: a.assetType, typeLabel: TYPE_NAME[a.assetType] ?? typeName(a), name: a.name ?? null, globalId: a.globalId ?? null, ifcClass: a.ifcClass ?? null, zone: zoneOf(a) ?? null,
        location: { lon: a.location?.longitude ?? null, lat: a.location?.latitude ?? null }, positionIllustrative: Boolean(a.illustrative),
        status: st ? { code: st.status, label: STATUS_LABEL[st.status], source: st.source, asOf: st.date ?? null, evaluatedAt } : null };
    });
  }
  const reportContext = () => [...network.assets.values()].filter(a => Number.isFinite(a.location?.longitude) && !(a.route?.length >= 2)).slice(0, 2000)
    .map(a => ({ id: a.id, lon: a.location.longitude, lat: a.location.latitude }));

  /** The answer for a report, in the turn that shows it. */
  function reportView(rec) {
    const r = rec.data;
    const { say, say2 } = rec.say ? { say: rec.say, say2: rec.say2 ?? null } : reportSay(r);
    return { question: rec.question, kind: r.request.outputs.pdf || r.request.outputs.xlsx || r.request.outputs.email ? 'Generated report' : 'Inspection evaluation', status: 'answered', say, say2,
      extraHtml: reportHtml(r, rec.ui, { gmail: ui.gmail }) };
  }
  function renderReport(id) {
    const rec = ui.reports.get(id);
    if (!rec) return;
    if (rec.data.emailDraft && ui.gmail === null && !gmailLoading) void refreshGmail();
    const view = reportView(rec);
    if (rec.turn === ui.turn) { ui.view = view; render(); return; }
    // An earlier turn: redrawn in place; the current answer is left alone.
    const el = chat.querySelector(`[data-turn="${rec.turn}"] .isp-msg-ans`);
    const html = renderChatAnswer(view, { describe: describeRow });
    if (el && ui.turns[rec.turn]) { ui.turns[rec.turn].html = html; el.innerHTML = html; }
  }
  /** Poll the job until it ends (its steps are the server's own progress), then show the assets on the map. */
  async function followReport(id) {
    const rec = ui.reports.get(id);
    while (rec && REPORT_RUNNING.has(rec.data.status) && !rec.stopped) {
      await new Promise(resolve => setTimeout(resolve, 600));
      if (rec.stopped) return;
      try { rec.data = await docTools.report.get(id); } catch (error) { rec.data = { ...rec.data, status: 'FAILED', error: error?.message ?? String(error) }; }
      if (rec.stopped) return;
      renderReport(id);
    }
    if (!rec || rec.stopped || !rec.data.summary) return;
    const ids = rec.data.assets.map(a => a.id).filter(x => network.assets.has(x));
    if (rec.turn === ui.turn && ids.length) { setAskResults(ids, rec.question, { noun: 'assets' }); render(); frame(ids, { pitch: -55, minRange: 350 }); }
  }
  async function startReport(question, request, { revisionOf = null, regenerate = false, area = null, ids = null, investigationAt = null } = {}) {
    const mine = ++askToken;
    // A report about the selected area: its assets only (the server checks the area again and keeps a snapshot of it).
    // A maintenance report: the investigation's assets.
    const population = reportPopulation(request.types).filter(x => (!area || area.inside.has(x.id)) && (!ids || ids.includes(x.id)));
    const phrase = request.typeLabels.map(l => l.plural).join(' and ');
    if (!population.length) {
      ui.view = { question, kind: 'Report', status: 'limited', say: `${area ? 'The selected area holds' : 'The model has'} no ${phrase || 'assets of that type'}, so there is nothing to report.`, ...(area ? { scope: areaScopeLabel(area) } : {}) };
      render();
      return;
    }
    ui.view = { question, kind: 'Report', status: 'answered', say: `Identifying matching assets: ${population.length} ${phrase} ${area ? 'in the selected area' : 'in the model'}…`, extraHtml: '', ...(area ? { scope: areaScopeLabel(area) } : {}) };
    render();
    const turn = ui.turn;
    try {
      const data = await docTools.report.create({ request: { question, ...request }, assets: population, context: reportContext(), revisionOf, regenerate,
        ...(area ? { area: { key: area.versionKey, geometry: area.geometry, placement: areaTools.placement(), label: areaLabel(area), selectionId: area.selectionId, zones: areaZones() } } : {}) });
      // Stopped while the job was being created: it is cancelled on the server too.
      if (mine !== askToken) { if (REPORT_RUNNING.has(data.status) && !data.reused) docTools.report.cancel(data.reportId).catch(() => {}); return; }
      const rec = { data, question, turn, investigationAt, ui: { assetsOpen: !(request.outputs.pdf || request.outputs.xlsx || request.outputs.email) } };
      ui.reports.set(data.reportId, rec);
      ui.lastReport = data.reportId;
      if (working?.token === mine) working.cancel = () => stopReport(data.reportId);
      renderReport(data.reportId);
      await followReport(data.reportId);
    } catch (error) {
      if (turn !== ui.turn || mine !== askToken) return;
      ui.view = { question, kind: 'Report', status: 'error', title: error?.status === 401 ? 'Sign in to Autodesk to read the documents' : 'The report could not be started', lead: `${error?.message ?? error}${error?.code ? ` (${error.code})` : ''}`,
        actions: [{ label: 'Retry', primary: true, attrs: { 'data-ask': question } }] };
      render();
    }
  }
  /** Stop a running report: the job is cancelled on the server, and its turn says so (its progress kept). */
  function stopReport(id) {
    const rec = ui.reports.get(id);
    if (!rec || !REPORT_RUNNING.has(rec.data.status)) return false;
    rec.stopped = true;
    rec.data = { ...rec.data, status: 'CANCELLED', steps: rec.data.steps.map(x => (['running', 'pending'].includes(x.state) ? { ...x, state: 'skipped', detail: x.state === 'running' ? 'Stopped.' : null } : x)) };
    docTools.report.cancel(id).catch(() => {});
    renderReport(id);
    return true;
  }
  function askReport(question, req, { area = null } = {}) {
    ui.result = null; ui.question = question;
    if (req.unsupported) {
      ui.view = { question, kind: 'Report', status: 'unsupported', say: 'I cannot generate that kind of report yet.',
        say2: 'Reports are available for inspection requirements and for asset registers by type and status (for example: "Prepare a report of all cranes requiring inspection" or "Generate a register of degraded lighting assets"). Outage and IFC-change reports are not available.' };
      render();
      return;
    }
    if (req.needsTypes) { ui.view = { question, kind: 'Report', status: 'answered', say: 'Which assets?', lead: 'Name an asset type, for example transformers, circuit breakers, cranes or lighting.' }; render(); return; }
    tracked(startReport(question, { kind: req.kind, types: req.types, typeLabels: req.typeLabels, outputs: req.outputs, recipientGroup: req.recipientGroup, filters: req.filters, options: req.options }, { area }));
  }
  /** A follow-up on the last report: the draft edited, the assets shown again, or a new revision. */
  async function askReportFollowUp(question, f) {
    const rec = ui.reports.get(ui.lastReport);
    if (!rec) return;
    ui.result = null; ui.question = question;
    const r = rec.data;
    if (f.show) {
      const next = { ...rec, turn: ui.turn, ui: { assetsOpen: true }, say: `${r.assets.length} asset${r.assets.length === 1 ? ' is' : 's are'} in the report${r.revision > 1 ? ` (revision ${r.revision})` : ''}.`, say2: 'They are highlighted on the map.' };
      ui.reports.set(r.reportId, next);
      renderReport(r.reportId);
      const ids = r.assets.map(a => a.id).filter(x => network.assets.has(x));
      if (ids.length) { setAskResults(ids, question, { noun: 'assets' }); render(); frame(ids, { pitch: -55, minRange: 350 }); }
      return;
    }
    if (f.email) {
      const body = { ...f.email };
      if (body.removeType) { body.attachmentIds = (r.emailDraft?.attachmentIds ?? r.artifacts.filter(a => a.status === 'COMPLETED').map(a => a.artifactId)).filter(x => r.artifacts.find(a => a.artifactId === x)?.type !== body.removeType); delete body.removeType; }
      // An edited draft keeps its text when only the recipient changes.
      if (r.emailDraft?.edited && body.recipientGroup && !body.style) delete body.regenerate;
      ui.view = { question, kind: 'Report', status: 'loading', title: 'Updating the email draft…' };
      render();
      const turn = ui.turn;
      const mine = ++askToken;
      try {
        const data = await docTools.report.email(r.reportId, body);
        if (mine !== askToken) return;
        // The first draft for this report is said as such (with its attachments); later ones as changes to it.
        const first = !r.emailDraft;
        const files = data.artifacts.filter(a => a.status === 'COMPLETED').map(a => (a.type === 'PDF' ? 'the report' : 'the register'));
        const what = first ? `I've drafted an email${f.email.recipientGroup ? ` to the ${f.email.recipientGroup}` : ''}${files.length ? ` with ${files.join(' and ')} attached` : ''}.`
          : f.email.style === 'short' ? 'I\'ve shortened the email draft.' : f.email.recipientGroup ? `The draft is now addressed to ${f.email.recipientGroup}.` : f.email.removeType ? `The ${f.email.removeType === 'PDF' ? 'PDF report' : 'Excel register'} is no longer attached.` : 'I\'ve rewritten the email draft.';
        const next = { data, question, turn, investigationAt: rec.investigationAt ?? null, ui: { emailOpen: true }, say: what,
          say2: first ? 'Review it and add the recipients; nothing is sent until you confirm.' : `The report and register were not regenerated (report ${data.reportId}${data.revision > 1 ? ` rev ${data.revision}` : ''}).` };
        ui.reports.set(r.reportId, next);
        renderReport(r.reportId);
      } catch (error) { if (turn === ui.turn) { ui.view = { question, kind: 'Report', status: 'error', title: 'The draft could not be updated', lead: error?.message ?? String(error) }; render(); } }
      return;
    }
    if (f.revise) {
      const { regenerate = false, ...change } = f.revise;
      const req = { ...r.request, ...change };
      if (change.types) req.typeLabels = typeLabels(change.types);
      await startReport(question, req, { revisionOf: r.reportId, regenerate });
    }
  }
  // ---- the email draft: Gmail connection, edits saved as they are made, an explicit confirmed send ----
  ui.gmail = null;
  let gmailLoading = false;
  async function refreshGmail() {
    if (!docTools?.gmail) return;
    gmailLoading = true;
    try { ui.gmail = await docTools.gmail.status(); } catch { ui.gmail = { configured: false, missing: ['server unreachable'], connected: false, canSend: false, testRecipients: [] }; }
    gmailLoading = false;
    for (const [id, rec] of ui.reports) if (rec.data.emailDraft) renderReport(id);
  }
  // The Google sign-in popup tells the conversation how it went; the conversation itself was never reloaded.
  const onGmailMessage = event => {
    if (event.origin !== window.location.origin || event.data?.type !== 'gmail-auth') return;
    for (const rec of ui.reports.values()) rec.ui.gmailNote = event.data.ok ? null : event.data.message ?? 'Gmail was not connected.';
    void refreshGmail();
  };
  window.addEventListener('message', onGmailMessage);
  const draftOf = id => ui.reports.get(id)?.data.emailDraft ?? null;
  /** Save the draft's fields (no re-render, so the caret stays where it is). */
  function saveDraft(id) {
    const rec = ui.reports.get(id);
    const d = rec?.data.emailDraft;
    if (!d || ['SENT', 'SENDING', 'SEND_STATUS_UNKNOWN'].includes(d.sendState)) return Promise.resolve();
    const body = { to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, ...(d.bodyHtml != null ? { bodyHtml: d.bodyHtml } : { body: d.body }), attachmentIds: d.attachmentIds, recipientGroup: d.recipientGroup };
    rec.saving = (rec.saving ?? Promise.resolve()).then(() => docTools.report.email(id, body)).then(data => {
      // Keep what the user typed since; take the server's record for everything else.
      rec.data = { ...data, emailDraft: { ...data.emailDraft, to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, body: d.body, bodyHtml: d.bodyHtml ?? data.emailDraft.bodyHtml } };
      rec.ui.saveError = null;
    }).catch(error => { rec.ui.saveError = `The draft could not be saved (${error?.message ?? error}).`; renderReport(id); });
    return rec.saving;
  }
  /** The Send button and its reason, updated in place while typing. */
  function updateSendState(card, id) {
    const rec = ui.reports.get(id);
    if (!card || !rec) return;
    const ready = sendReadiness(rec.data, ui.gmail);
    const btn = card.querySelector('[data-send-btn]');
    if (btn) btn.disabled = !ready.ready;
    const why = card.querySelector('[data-mail-why]');
    if (why && !['SENDING', 'SEND_STATUS_UNKNOWN', 'FAILED'].includes(rec.data.emailDraft?.sendState)) why.textContent = ready.ready ? 'Ready to send · not sent yet' : `Not sent · ${ready.why[0] ?? ''}`;
  }
  // Recipients as chips: typed, pasted or left in the field, each address becomes a chip (an address that is
  // not one is kept and shown as such, so nothing typed disappears).
  function commitChips(input) {
    const id = input.dataset.reportId, field = input.dataset.chipInput;
    const d = draftOf(id);
    const text = input.value.trim();
    if (!d || !text) return false;
    const add = text.split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
    d[field] = [...new Set([...(d[field] ?? []), ...add])];
    input.value = '';
    redrawChips(input.closest('.tw-chips'), id, field, { focus: true });
    return true;
  }
  /** Redraw one chip box (the card being edited: the same report can be shown in an earlier turn too). */
  function redrawChips(box, id, field, { focus = false } = {}) {
    const d = draftOf(id);
    if (!box || !d) return;
    const ph = box.querySelector('[data-chip-input]')?.getAttribute('placeholder') || (field === 'to' && d.recipientGroup ? `${d.recipientGroup} — enter email address` : 'Optional');
    box.innerHTML = chipsHtml(field, d[field] ?? [], { id, placeholder: ph });
    if (focus) box.querySelector('[data-chip-input]')?.focus();
    updateSendState(box.closest('.tw-mail'), id);
    void saveDraft(id);
  }
  askHost.addEventListener('keydown', event => {
    const el = event.target;
    if (el.dataset?.chipInput) {
      if (['Enter', ',', ';'].includes(event.key) || (event.key === ' ' && el.value.trim()) || (event.key === 'Tab' && el.value.trim())) {
        if (commitChips(el)) event.preventDefault();
        else if (event.key === 'Enter') event.preventDefault();
      } else if (event.key === 'Backspace' && !el.value) {
        const d = draftOf(el.dataset.reportId);
        if (d?.[el.dataset.chipInput]?.length) { d[el.dataset.chipInput] = d[el.dataset.chipInput].slice(0, -1); redrawChips(el.closest('.tw-chips'), el.dataset.reportId, el.dataset.chipInput, { focus: true }); }
      }
    }
  });
  askHost.addEventListener('paste', event => {
    const el = event.target;
    if (!el.dataset?.chipInput) return;
    const text = event.clipboardData?.getData('text') ?? '';
    if (!/[,;\s]/.test(text.trim())) return;
    event.preventDefault();
    el.value = `${el.value} ${text}`;
    commitChips(el);
  });
  askHost.addEventListener('focusout', event => { if (event.target.dataset?.chipInput) commitChips(event.target); });
  // The message: rich text in a contenteditable editor; the toolbar uses the browser's editing commands.
  let editorSave = 0;
  function onEditorInput(el) {
    const d = draftOf(el.dataset.reportId);
    if (!d) return;
    d.bodyHtml = el.innerHTML;
    d.body = el.innerText;
    d.edited = true;
    updateSendState(el.closest('.tw-mail'), el.dataset.reportId);
    clearTimeout(editorSave);
    editorSave = setTimeout(() => void saveDraft(el.dataset.reportId), 600);
  }
  function format(btn) {
    const card = btn.closest('.tw-mail');
    const editor = card?.querySelector('[data-mail-editor]');
    if (!editor || editor.getAttribute('contenteditable') !== 'true') return;
    editor.focus();
    if (btn.dataset.fmt === 'link') {
      const url = window.prompt('Link address (https:// or mailto:)', 'https://');
      if (!url || !/^(https?:\/\/|mailto:)\S+$/i.test(url.trim())) return;
      document.execCommand('createLink', false, url.trim());
    } else document.execCommand(btn.dataset.fmt, false, null);
    onEditorInput(editor);
  }
  askHost.addEventListener('input', event => {
    const el = event.target;
    if ('mailEditor' in (el.dataset ?? {})) { onEditorInput(el); return; }
    if (el.dataset?.mail && el.dataset.reportId) {
      const d = draftOf(el.dataset.reportId);
      if (!d) return;
      d[el.dataset.mail] = el.value;
      if (el.dataset.mail === 'subject') d.edited = true;
      updateSendState(el.closest('.tw-mail'), el.dataset.reportId);
    } else if ('mailAck' in (el.dataset ?? {})) {
      const btn = el.closest('.tw-mconf')?.querySelector('[data-report-act="sendConfirm"]');
      if (btn) btn.disabled = !el.checked;
    }
  });
  askHost.addEventListener('change', event => {
    const el = event.target;
    if (el.dataset?.mail && el.dataset.reportId) void saveDraft(el.dataset.reportId);
    if ('fmtBlock' in (el.dataset ?? {})) {
      const editor = el.closest('.tw-mail')?.querySelector('[data-mail-editor]');
      if (editor) { editor.focus(); document.execCommand('formatBlock', false, el.value); onEditorInput(editor); el.value = 'p'; }
    }
    if (el.dataset?.mailAtt && el.dataset.reportId) {
      const id = el.dataset.reportId;
      const d = draftOf(id);
      if (!d) return;
      d.attachmentIds = [...el.closest('.tw-matt').querySelectorAll('[data-mail-att]')].filter(x => x.checked).map(x => x.dataset.mailAtt);
      void saveDraft(id).then(() => renderReport(id));
    }
  });
  const newKey = () => (crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 40).padEnd(20, '0');
  async function sendAction(t, rec, id) {
    const u = rec.ui;
    const act = t.dataset.reportAct;
    if (act === 'gmailConnect') {
      // A popup: the conversation, the report, the draft and the map stay exactly as they are.
      const w = window.open(docTools.gmail.loginUrl, 'gmail-auth', 'popup,width=520,height=680');
      u.gmailNote = w ? 'Finish connecting in the Google window.' : 'The browser blocked the Google window: allow pop-ups for this site and try again.';
      renderReport(id);
      return;
    }
    if (act === 'gmailDisconnect') { try { ui.gmail = await docTools.gmail.disconnect(); } catch (error) { u.gmailNote = error?.message ?? String(error); } for (const k of ui.reports.keys()) renderReport(k); return; }
    if (act === 'mailCc') { u.ccOpen = true; renderReport(id); [...askHost.querySelectorAll(`.tw-chips[data-chips="cc"][data-report-id="${CSS.escape(id)}"] [data-chip-input]`)].at(-1)?.focus(); return; }
    if (act === 'mailMenu') { u.menuOpen = !u.menuOpen; renderReport(id); return; }
    if (act === 'emailRegenAsk') {
      u.menuOpen = false;
      // Edited text is replaced only after the user says so; the files are never regenerated.
      if (rec.data.emailDraft?.edited) { u.regenConfirm = true; renderReport(id); return; }
      await saveDraft(id);
      try { rec.data = await docTools.report.email(id, { regenerate: true }); } catch (error) { u.saveError = error?.message ?? String(error); }
      renderReport(id);
      return;
    }
    if (act === 'emailRegenCancel') { u.regenConfirm = false; renderReport(id); return; }
    if (act === 'mailAtt') { u.attOpen = !u.attOpen; renderReport(id); return; }
    if (act === 'sendHistory') {
      u.menuOpen = false;
      u.historyOpen = !u.historyOpen;
      renderReport(id);
      if (u.historyOpen) { try { u.history = (await docTools.gmail.history(id)).attempts; } catch (error) { u.history = []; u.saveError = error?.message ?? String(error); } renderReport(id); }
      return;
    }
    if (act === 'emailNew') { u.history = null; u.historyOpen = false; try { rec.data = await docTools.report.email(id, { newDraft: true }); } catch (error) { u.saveError = error?.message ?? String(error); } renderReport(id); return; }
    if (act === 'sendStart') {
      await saveDraft(id);
      if (!sendReadiness(rec.data, ui.gmail).ready) { renderReport(id); return; }
      // One key per confirmed send: a double click or a retried request cannot send twice.
      u.sendKey = newKey();
      u.confirming = true; u.sendError = null;
      renderReport(id);
      // Into view and focused, wherever the user had scrolled the conversation.
      const dlg = [...askHost.querySelectorAll(`[data-mail-card="${CSS.escape(id)}"] .tw-mconf`)].at(-1);
      dlg?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      (dlg?.querySelector('[data-mail-ack]') ?? dlg?.querySelector('[data-report-act="sendConfirm"]'))?.focus({ preventScroll: true });
      return;
    }
    if (act === 'sendCancel') { u.confirming = false; u.sendError = null; renderReport(id); return; }
    if (act === 'sendConfirm') {
      if (u.sending) return;
      const ack = Boolean(t.closest('.tw-mconf')?.querySelector('[data-mail-ack]')?.checked);
      u.sending = true; u.sendError = null;
      renderReport(id);
      let result = null;
      try { result = await docTools.gmail.send({ reportId: id, idempotencyKey: u.sendKey, acknowledgeIllustrative: ack }); }
      catch (error) {
        // Refused before sending (it says why), or our own request failed (which may have reached Gmail).
        u.sendError = error?.code === 'NETWORK' ? 'Send status could not be confirmed. Check Gmail before retrying.' : error?.message ?? String(error);
        if (['ALREADY_SENT', 'SEND_STATUS_UNKNOWN'].includes(error?.code)) u.confirming = false;
      }
      u.sending = false;
      try { rec.data = await docTools.report.get(id); } catch { /* the card keeps what it had */ }
      if (result) { u.confirming = false; u.history = null; if (result.status === 'FAILED') u.sendKey = null; }
      renderReport(id);
    }
  }

  /** The report card's buttons. */
  async function reportAction(t) {
    const id = t.dataset.reportId;
    const rec = ui.reports.get(id);
    if (!rec) return;
    const u = rec.ui;
    const act = t.dataset.reportAct;
    const save = async fn => { try { rec.data = await fn(); } catch (error) { rec.ui.error = error?.message ?? String(error); } renderReport(id); };
    if (act === 'assets') { u.assetsOpen = !u.assetsOpen; renderReport(id); return; }
    if (act === 'criteria') { u.criteriaOpen = !u.criteriaOpen; renderReport(id); return; }
    if (act === 'email') { u.emailOpen = !u.emailOpen; renderReport(id); return; }
    if (act === 'emailEdit') { u.editing = true; u.emailOpen = true; renderReport(id); return; }
    if (act === 'emailCancel') { u.editing = false; renderReport(id); return; }
    if (act === 'map') {
      const ids = rec.data.assets.map(a => a.id).filter(x => network.assets.has(x));
      if (ids.length) { setAskResults(ids, rec.question, { noun: 'assets' }); draw(); renderAskChip(); frame(ids, { pitch: -55, minRange: 350 }); }
      return;
    }
    if (act === 'cancel') { await save(() => docTools.report.cancel(id)); return; }
    if (act === 'retry') { await save(() => docTools.report.retry(id, t.dataset.reportType)); return; }
    // Regenerate the text only (confirmed first when edited): the report and the register are not regenerated.
    if (act === 'emailRegen') { u.regenConfirm = false; u.menuOpen = false; await save(() => docTools.report.email(id, { regenerate: true })); return; }
    if (['gmailConnect', 'gmailDisconnect', 'mailCc', 'mailAtt', 'mailMenu', 'emailRegenAsk', 'emailRegenCancel', 'sendHistory', 'emailNew', 'sendStart', 'sendCancel', 'sendConfirm'].includes(act)) { await sendAction(t, rec, id); return; }
    if (act === 'emailCopy') {
      const d = rec.data.emailDraft;
      const to = splitAddresses(d.to).valid.join(', ') || d.recipientGroup || '';
      const text = `To: ${to}${d.cc?.length ? `\nCc: ${d.cc.join(', ')}` : ''}\nSubject: ${d.subject}\n\n${d.body}`;
      // Formatted where the clipboard takes HTML, plain text otherwise.
      try {
        if (d.bodyHtml && window.ClipboardItem) {
          const html = `<p><b>To:</b> ${esc(to)}<br><b>Subject:</b> ${esc(d.subject)}</p>${d.bodyHtml}`;
          await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
        } else await navigator.clipboard.writeText(text);
        u.copied = true;
      } catch { u.copied = false; }
      renderReport(id);
      return;
    }
    if (act === 'preview') {
      const a = rec.data.artifacts.find(x => x.artifactId === t.dataset.reportArtifact);
      if (!a) return;
      const spec = { title: a.title, subtitle: `${a.filename} · generated ${a.createdAt?.replace('T', ' ').slice(0, 16) ?? ''} UTC · report ${id}`, url: a.url, downloadUrl: `${a.url}&download=1`, filename: a.filename, kind: a.type };
      if (a.type === 'XLSX') {
        try { rec.snapshot = rec.snapshot ?? await docTools.report.snapshot(id); spec.html = registerPreviewHtml(rec.snapshot); } catch (error) { spec.html = `<p class="isp-muted">The preview could not be loaded (${esc(error?.message ?? error)}). The download still works.</p>`; }
      }
      onArtifact(spec);
    }
  }

  function render() {
    if (ui.sim && !session.state().active) ui.sim = null;   // the scenario was reset elsewhere
    // The current answer is shown in its conversation turn in the Ask the Twin panel, never in the card.
    const base = ui.view ?? (ui.result ? resultView(ui.result) : null);
    // Every answer while an area exists says which scope it used (kept with its turn: a later area never relabels it).
    const view = base && !base.scope && ui.turns[ui.turn]?.scope ? { ...base, scope: ui.turns[ui.turn].scope } : base;
    const answer = view ? renderChatAnswer(view, { describe: describeRow }) : null;
    if (answer) renderTurn(answer);
    renderAskBusy();
    // The inspector: the focused (or selected) asset, beside the conversation.
    const inspect = ui.inspector && network.assets.has(ui.inspector) ? ui.inspector : !answer ? ui.selectedId : null;
    if (ui.sim && !ui.sim.inChat && session.state().active) { panel.innerHTML = simulationHtml(); panel.hidden = false; }
    else if (ui.investigation && !ui.result) { panel.innerHTML = investigationHtml(ui.investigation); panel.hidden = false; }
    else if (inspect) { panel.innerHTML = assetHtml(network.assets.get(inspect)); panel.hidden = false; }
    else panel.hidden = true;
    renderFocusBar();
    draw();
  }

  // ---- results and camera ----

  /**
   * Fly to assets, then slide the view so they sit in the map area the side panels leave free (not
   * behind the answer or details card).
   */
  function frame(ids, { pitch = -58, minRange = 260 } = {}) {
    const points = ids.map(id => network.assets.get(id)).filter(a => Number.isFinite(a?.location?.longitude))
      .flatMap(a => (a.route ?? [{ lon: a.location.longitude, lat: a.location.latitude }]).map(p => Cartesian3.fromDegrees(p.lon, p.lat)));
    if (!points.length) return;
    const sphere = BoundingSphere.fromPoints(points);
    // A set wider than the free map area is framed from further out, in proportion.
    const { free, width } = freeArea();
    const fit = free && sphere.radius > 30 ? Math.min(width / free, 2.2) : 1;
    viewer.camera.flyToBoundingSphere(sphere, { duration: 0.9, offset: new HeadingPitchRange(CMath.toRadians(heading), CMath.toRadians(pitch), Math.max(sphere.radius * (ids.length > 20 ? 2.1 : 3) * fit, minRange)),
      complete: () => clearOfPanels(sphere) });
  }
  /** The map between the Ask the Twin panel (left) and the open cards (right); null when nothing covers it. */
  function freeArea() {
    const canvas = viewer.canvas.getBoundingClientRect();
    const cards = [panel.closest('.isp-ops-detail') ?? panel, opsHost].filter(el => el && !el.hidden && el.getClientRects().length);
    const right = Math.min(canvas.right, ...cards.map(el => el.getBoundingClientRect().left));
    const askPanel = askHost.classList.contains('is-collapsed') ? null : askHost.querySelector('.isp-askp');
    const left = Math.max(canvas.left, askPanel?.getClientRects().length ? askPanel.getBoundingClientRect().right : canvas.left);
    const free = right - left;
    return { free: free >= canvas.width - 40 || free < 200 ? null : free, width: canvas.width, middle: (left + right) / 2 - canvas.left };
  }
  function clearOfPanels(sphere) {
    const canvas = viewer.canvas.getBoundingClientRect();
    const { free, middle } = freeArea();
    if (!free) return;
    const shift = canvas.width / 2 - middle;
    const metres = viewer.camera.getPixelSize(sphere, viewer.scene.drawingBufferWidth, viewer.scene.drawingBufferHeight) * shift * (viewer.scene.drawingBufferWidth / canvas.width);
    viewer.camera.moveRight(metres);
  }

  // ---- Ask the Twin results on the map ----

  const HL_KIND = { TRANSFORMER: 'transformer', SWITCHGEAR: 'switchgear', SUBSTATION: 'switchgear', CIRCUIT_BREAKER: 'switchgear', SWITCH: 'switchgear', JUNCTION_BOX: 'switchgear',
    FEEDER: 'cable', LIGHTING_CIRCUIT: 'light', UTILITY_SUPPLY: 'source', GENERATOR: 'source' };
  /** Show a result set on the map: halos and labels for equipment, glowing routes for cables. */
  function setAskResults(ids, question, { keep = null, noun = 'results' } = {}) {
    const known = [...new Set(ids)].filter(id => network.assets.has(id));
    // A focused asset stays focused while the conversation is still about it.
    if (ui.focus && !known.includes(ui.focus.id) && ui.focus.id !== keep) { clearFocus(); ui.inspector = null; }
    if (!known.length) { ui.ask = null; askHl.clear(); return; }
    ui.ask = { ids: known, question, snapshot: null, selectedId: null };
    const located = known.map(id => network.assets.get(id));
    askHl.set(located.filter(a => !(a.route?.length >= 2)).map(a => ({
      id: a.id, label: a.id, kind: HL_KIND[a.assetType] ?? 'load', lon: a.location?.longitude, lat: a.location?.latitude, alert: markerIds.has(a.id) })), { size: known.length, noun });
    ui.lastCollection = { ids: known, question, noun };
    delete ui.ask.count; delete ui.ask.noun;
    // What is on the map: equipment with a position, cables with a route.
    ui.ask.placed = located.filter(a => a.route?.length >= 2 || Number.isFinite(a.location?.longitude)).length;
  }
  function clearAsk() { ui.ask = null; askHl.clear(); }
  /** Back to the answer the selected result came from, with the whole set highlighted again. */
  function backToResults() {
    // Cleared earlier: the same results again, from what was answered (no new query).
    if (!ui.ask && ui.lastCollection) setAskResults(ui.lastCollection.ids, ui.lastCollection.question, { noun: ui.lastCollection.noun });
    if (!ui.ask) return;
    const snap = ui.ask.snapshot;
    if (snap?.result !== undefined && !ui.result && !ui.view) { ui.result = snap.result; ui.view = snap.view; ui.question = snap.question; ui.turn = snap.turn; }
    ui.selectedId = null; ui.ask.selectedId = null; ui.ask.snapshot = null; ui.inspector = null;
    clearFocus();
    askHl.setSelected(null);
    render();
    frame(ui.ask.ids, { pitch: -55, minRange: 300 });
  }
  /** The bar above Ask the Twin while results are on the map. */
  function renderAskChip() {
    const chip = askHost.querySelector('.isp-ask-hl');
    if (!chip) return;
    chip.hidden = !ui.ask;
    if (!ui.ask) return;
    const answerShown = Boolean(ui.view || ui.result);
    const n = ui.ask.count ?? ui.ask.ids.length;
    // One asset: "TX-M2 selected · Focus · Clear"; several keep the count and "Results".
    const one = n === 1 && ui.ask.ids.length === 1 ? ui.ask.ids[0] : null;
    chip.innerHTML = one
      ? `${ASK_ICONS.target}<span><b>${esc(one)}</b> selected</span><button type="button" class="isp-linkbtn" data-act="focusAsset" data-asset-id="${esc(one)}">Focus</button><button type="button" class="isp-linkbtn" data-act="askClear">Clear</button>`
      : `${ASK_ICONS.target}<span><b>${n}</b> ${ui.ask.noun ?? (n === 1 ? 'asset' : 'assets')} highlighted</span>
      ${ui.ask.snapshot || !answerShown ? `<button type="button" class="isp-linkbtn" data-act="askBack">Results</button>` : ''}<button type="button" class="isp-linkbtn" data-act="askClear">Clear</button>`;
    chip.title = ui.ask.question ?? '';
  }
  /** A citation number: its document, version, page and line, with Preview and Open in ACC, under the claim. */
  function showCitation(btn) {
    const root = btn.closest('.tw-rev');
    const open = root?.querySelector('.tw-cpop');
    const key = `${btn.dataset.refDoc}:${btn.dataset.refPage ?? ''}`;
    const same = open && open.dataset.for === key;
    open?.remove();
    if (!root || same) return;
    const block = btn.closest('summary, li, p, table, .tw-rspec-hl, .tw-concl');
    const holder = document.createElement('div');
    holder.innerHTML = citePopoverHtml(btn.dataset, [...root.querySelectorAll('[data-src-doc]')].find(el => el.dataset.srcDoc === btn.dataset.refDoc)?.dataset);
    const pop = holder.firstElementChild;
    pop.dataset.for = key;
    if (block?.tagName === 'SUMMARY') { block.parentElement.open = true; block.after(pop); } else (block ?? btn).after(pop);
    pop.querySelector('[data-doc-cite]')?.focus({ preventScroll: true });
  }
  /**
   * "Open outage simulation" from a document review: the existing simulation and its panel on the right; the
   * review stays in its turn, on its tab, and is there as it was when the simulation is reset.
   */
  function simulateFromReview(id) {
    if (!network.assets.has(id)) return;
    const r = validateResult(investigate('OUTAGE', id, { network, session }), network).result;
    if (!session.state().active) { show(r, null, { newTurn: false }); return; }
    startSimulation(r, { keepAnswer: true });
  }
  const notLocatable = ids => ids.filter(id => network.assets.has(id) && !Number.isFinite(network.assets.get(id).location?.longitude));
  function show(result, question, { newTurn = true } = {}) {
    const { result: r } = validateResult(result, network);
    if (r.primaryAssetId && network.assets.has(r.primaryAssetId)) ui.lastAssets = [r.primaryAssetId];
    // A simulated outage: its own panel on the right. From the map (the inspector, a scenario) Ask the Twin
    // stays collapsed; asked in the conversation, the conversation gets one line pointing to the panel.
    if ((r.intent === 'OUTAGE' || r.intent === 'TRANSFER') && session.state().active) { startSimulation(r, { fromAsk: !newTurn, question }); return; }
    // Answers from the map and the asset card ("Downstream", "View network path") join the conversation too.
    if (newTurn) beginTurn(question, { fromMap: true });
    ui.view = null;
    ui.result = r;
    ui.question = question;
    ui.selectedId = r.primaryAssetId ?? null;
    // One asset asked for ("Show me TX-M1"): the focus controller flies to it, highlights it, opens it.
    if (r.intent === 'LOCATE' && r.status === 'ANSWERED' && network.assets.has(r.primaryAssetId)) {
      clearAsk();
      focusAsset(r.primaryAssetId);
      return;
    }
    // The answer's own structured ids (never parsed from its text): its targets, or else its groups and paths.
    const ids = r.targetAssetIds?.length ? r.targetAssetIds : [...(r.resultGroups ?? []).flatMap(g => g.assetIds ?? []), ...(r.paths ?? []).flatMap(p => p.assetIds ?? [])];
    const listNoun = (r.intent === 'LIST' || r.intent === 'COUNT') ? (r.resultGroups?.[0]?.label ?? 'results').toLowerCase() : 'results';
    setAskResults(ids, question, { keep: r.primaryAssetId, noun: listNoun });
    if (!ui.focus) ui.inspector = null;
    // One short tone for a whole collection (when the sound is on), never one per asset.
    if (listNoun !== 'results' && ui.ask?.placed && soundOn) locator.play();
    render();
    // Every highlighted result in view (beside the panels); the engine's camera anchors otherwise.
    if (ui.ask && !r.primaryAssetId) frame(ui.ask.ids, { pitch: -55, minRange: 300 });
    else if (r.cameraTargetAssetIds?.length) frame(r.cameraTargetAssetIds);
  }
  function askQuestion(asked, { fromLlm = false } = {}) {
    viaLlm = fromLlm;
    // A new question while an answer is still running: that answer is stopped first (and says so).
    if (working || ui.view?.status === 'loading') stopAsk();
    beginTurn(asked);
    // The question as typed stays in the conversation; routing reads it with "sub station(s)" as one word.
    const question = String(asked).replace(/\bsub[\s-]+(stations?)\b/gi, 'sub$1');
    // Versions and documents first: the engine knows neither, and must not take "V3" for an asset.
    // Questions answered from an asset's documents (inspections, specifications, replacement): before the
    // version comparison and the document list, which would take them as "which files" (docQuestions.js).
    // Reports and registers ("prepare a report of … and draft an email"): before the document questions,
    // which would take "report" for an inspection report. A follow-up on the last report edits it.
    // Select Area: the scope of this question (the area by default; "across Seagirt" for the whole terminal).
    const areaScope = ui.area ? areaScopeOf(question) : null;
    ui.turns[ui.turn].scope = ui.area ? (areaScope.scope === 'TERMINAL' ? 'Entire terminal' : areaScope.scope === 'OUTSIDE' ? `Outside the selected area` : areaScope.scope === 'NEAR' ? 'Near the selected area' : areaScopeLabel(ui.area)) : null;
    // The question's objective, target, scope and time (askIntent.js): read before any keyword handler, so a
    // status word, a category or the selected area never decides what is asked.
    const plan = planFor(question);
    ui.lastPlan = plan;
    if (plan.clarify) { askWhichAsset(question, plan); return; }
    if (docTools && isMaintenancePlan(plan) && !existingDocAnswer(question, plan)) { tracked(askMaintenance(question, plan)); return; }
    // A follow-up that refers to an asset ("What happens if we shut it down?"): the asset from the conversation,
    // asked of the engine that answers it.
    // A report or an email from the maintenance investigation in progress (§20–§21), not a generic inventory.
    if (docTools?.report && [INTENT.REPORT_GENERATION, INTENT.EMAIL_DRAFT].includes(plan.primaryIntent) && askInvestigationReport(question, plan)) return;
    const followUp = resolvedFollowUp(question, plan);
    if (followUp) { askQuestionAs(followUp, question); return; }
    if (docTools?.report) {
      const follow = ui.lastReport ? parseReportFollowUp(question, ui.reports.get(ui.lastReport)?.data, { knownTypes: reportTypes() }) : null;
      if (follow) { tracked(askReportFollowUp(question, follow)); return; }
      const rq = parseReportRequest(question, { knownTypes: reportTypes() });
      if (rq) { askReport(question, rq, { area: areaScope?.scope === 'AREA' ? ui.area : null }); return; }
    }
    if (ui.area && areaScope.scope !== 'TERMINAL' && askArea(question, areaScope)) return;
    if (!ui.area && mentionsArea(question) && !/\b(zone|yard|berth|substation)\s+\w/i.test(question)) {
      ui.result = null; ui.question = question;
      ui.view = { question, kind: 'Select Area', status: 'answered', say: 'No area is selected.', say2: 'Select an area on the map first (the Select Area button in this panel’s header), then ask again. Or ask about the whole terminal.',
        actions: [{ label: 'Select an area', primary: true, attrs: { 'data-act': 'areaMenu' } }] };
      render();
      return;
    }
    if (docTools) {
      const docIds = new Set([...network.assets.keys(), ...(ui.docs?.documents ?? []).map(d => d.mapping?.assetId).filter(Boolean)]);
      const docQ = classifyDocumentQuestion(question, { assetIds: docIds, contextAssetId: ui.lastDoc?.assetId ?? ui.lastAssets[0] ?? ui.inspector ?? ui.focus?.id ?? ui.selectedId ?? null, lastAnalysis: ui.lastDoc?.analyses?.[0] ?? null });
      if (docQ) { tracked(askDocIntel(question, docQ)); return; }
    }
    const knownIds = new Set([...network.assets.keys(), ...(ui.cmp?.changeIds ?? [])]);
    // "Were any transformers added in this area?": the area is the turn's scope; the comparison reads the rest.
    const cmpText = (ui.area ? question.replace(/\s*\b(?:in|within|inside|for|across)\s+(?:the\s+)?(?:this|that|selected|the selected|my)\s+(?:area|zone|selection|boundary)\b/gi, '') : question)
      // "Were any transformers added?" read as "Which transformers were added?".
      .replace(/^\s*(?:were|was|have|has)\s+any\s+(.+?)\s+(?:been\s+)?(added|removed|deleted|moved|changed|modified)\b/i, 'Which $1 were $2');
    const parsed = compareTools ? parseCompareQuestion(cmpText, { cmp: ui.cmp, knownIds, selectedId: ui.selectedId }) : null;
    if (parsed) { tracked(askVersions(question, parsed)); return; }
    if (/\b(document(ation)?s?|datasheets?|data sheets?|asset sheets?|pdfs?|manuals?)\b/i.test(question)) { askDocuments(question); return; }
    // Spatial questions (near, within, nearest, inside, between): before anything takes a named asset as "locate it".
    const spatialQ = parseSpatialQuestion(question, { index: spatial(), assetIds: new Set(network.assets.keys()), selectedId: ui.inspector ?? ui.focus?.id ?? ui.selectedId ?? null });
    if (spatialQ) { askSpatial(question, spatialQ); return; }
    // Relationships between assets, alternate supply, what an asset is, "which one?": before anything
    // takes a named asset as "locate it" (intentRouter.js).
    const routed = classifyQuestion(question, { assetIds: new Set(network.assets.keys()), lastAssets: ui.lastAssets.length ? ui.lastAssets : [ui.focus?.id, ui.selectedId].filter(Boolean) });
    if (routed?.intent === 'SUPPLY_RELATIONSHIP') { askRelationship(question, routed.entities.sourceAssetId, routed.entities.targetAssetId); return; }
    if (routed?.intent === 'PHYSICAL_CONNECTIVITY') { askRelationship(question, routed.entities.aAssetId, routed.entities.bAssetId, { physicalOnly: true }); return; }
    if (routed?.intent === 'ALTERNATE_SUPPLY') { askAlternate(question, routed.entities); return; }
    if (routed?.intent === 'ASSET_DETAILS') { askDetails(question, routed.entities.assetId); return; }
    if (routed?.intent === 'CLARIFY') { askClarify(question, routed.clarify.options); return; }
    // Substations and other modelled facilities (only when the model states them: IFC assemblies).
    const facility = facilityRegistry.facilities.length ? answerFacilityQuestion(question, { registry: facilityRegistry, assets: network.assets,
      zones: ZONES.map(z => z.text), zoneOf: a => zoneOf(a), supplyPath: id => supplyOf(id).primary?.path ?? [] }) : null;
    if (facility) { askFacility(question, facility); return; }
    // A question about the simulation that is running: answered in a sentence; its lists stay in the panel.
    if (ui.sim && session.state().active && /\b(affected|impact\w*|simulat\w*|outage|these|those|them|lose|lost|why)\b/i.test(question) && !namedIds(question, new Set(network.assets.keys())).length) { askSimulation(question); return; }
    const whyId = /\bwhy\b/i.test(question) && /\b(no power|without power|unpowered|de-?energi[sz]ed|lost power|dark|off|out)\b/i.test(question) ? namedIds(question, new Set(network.assets.keys()))[0] : null;
    if (whyId) { askWhy(question, whyId); return; }
    if (/\b(no power|without power|unpowered|de-?energi[sz]ed|lost power|degraded|power status|offline)\b/i.test(question) && !/\b(if|would|simulate|what happens|fails?)\b/i.test(question)) { askStatus(question); return; }
    if (/\b(cables?|path|route|feeders?|connections?)\b/i.test(question) && /\b(connect|connects|between|link|links|from|to)\b/i.test(question) && askPath(question)) return;
    ui.view = null;
    // The selected asset (or the one under investigation) is what "it" / "this" refers to.
    const out = ask(question, { network, session, context: { ...ui.context, selectedAssetId: ui.investigation?.id ?? ui.selectedId ?? null }, today: new Date().toISOString().slice(0, 10) });
    const showEngine = () => {
      ui.context = out.context;
      ui.preset = session.state().active ? null : 'normal';
      show(out.answer, question, { newTurn: false });
    };
    // Not understood by any rule: Claude reads it (when on); its rewrite is asked of the same rules, else this answer.
    if (llmOn && !viaLlm && out.parsed?.intent === 'UNKNOWN') { tracked(interpretAndAsk(question, showEngine)); return; }
    showEngine();
  }
  /**
   * A question the rules did not understand, read by Claude on the server. A rewrite that passes the checks is
   * asked again (the conversation keeps what was typed, with "Understood as" above the answer); otherwise, or
   * when the model is unreachable, over budget or unsure, `fallback` shows the rules' own answer.
   */
  async function interpretAndAsk(question, fallback) {
    const mine = ++askToken;
    const turnIndex = ui.turn;
    ui.result = null; ui.question = question;
    ui.view = { question, kind: 'Ask the Twin', status: 'loading', say: 'Reading the question…' };
    render();
    let reply = null;
    try {
      reply = await interpretTools.interpret(interpretRequest({ question, assets: network.assets.values(), previousQuestion: ui.turns[turnIndex - 1]?.question ?? null,
        lastAssets: ui.lastAssets, selectedAssetId: ui.investigation?.id ?? ui.selectedId ?? ui.focus?.id ?? null, area: ui.area ? { label: areaScopeLabel(ui.area) } : null,
        typeLabel: t => TYPE_LABEL[t]?.[0] ?? String(t).toLowerCase().replace(/_/g, ' ') }));
    } catch { reply = null; }
    // A newer question, or Stop: this reading is dropped.
    if (mine !== askToken || ui.turn !== turnIndex) return;
    const rewritten = acceptedRewrite(reply, { question, knownIds: new Set(network.assets.keys()) });
    ui.lastInterpret = { question, rewritten, reason: reply?.reason ?? null, model: reply?.model ?? null };
    // The rewritten question (or the fallback) is the answer now; this reading is no longer "in progress".
    if (working?.token === mine) { working = null; renderAskBusy(); }
    ui.view = null;
    if (!rewritten) { fallback(); return; }
    nextInterpretedAs = rewritten;
    askQuestionAs(rewritten, question, { fromLlm: true });
  }
  function runScenario(id) {
    const s = SCENARIOS.find(x => x.id === id);
    session.reset();
    ui.preset = id;
    if (!s.outages.length) { ui.result = null; ui.selectedId = null; render(); return; }
    for (const out of s.outages.slice(0, -1)) session.outage(out);
    show(investigate('OUTAGE', s.outages.at(-1), { network, session }), s.label);
  }
  /** Investigate an asset without power: its supply path, what is fed through it, confirmed and potential impact. */
  function investigateAsset(id) {
    const inv = investigateOutage(network, id, statuses);
    if (!inv) return false;
    ui.result = null; ui.question = null;
    ui.selectedId = id;
    ui.investigation = inv;
    render();
    frame([id, ...inv.upstream.slice(-3), ...inv.fedThrough], { pitch: -52, minRange: 320 });
    return true;
  }

  /**
   * The asset that is offline in the running simulation opens the Outage Simulation panel (the same one the
   * asset card's "Simulate outage" opens), also when the simulation was started from Ask the Twin.
   */
  function openSimulationFor(id) {
    if (!ui.sim || !session.state().active || !simulationOf()?.failed.includes(id)) return false;
    ui.sim.inChat = false;
    ui.inspector = null;
    return true;
  }
  function selectAsset(id, { zoom = false } = {}) {
    if (!network.assets.has(id)) return false;
    if (openSimulationFor(id)) { ui.selectedId = id; render(); frameSimulation(); return true; }
    // A result of the current answer: keep the answer to come back to, emphasise this one.
    if (ui.ask && ui.ask.ids.includes(id)) {
      // A result of the current answer: the answer stays (its row shows the selection), the asset is focused.
      ui.ask.snapshot = ui.ask.snapshot ?? { turn: ui.turn };
      ui.ask.selectedId = id;
      askHl.setSelected(id);
      ui.investigation = null;
      ui.selectedId = id;
      ui.inspector = id;
      return focusAsset(id) || true;
    }
    if (ui.ask) { ui.ask.selectedId = null; askHl.setSelected(null); }
    ui.result = null;
    ui.view = null;
    ui.question = null;
    ui.investigation = null;
    ui.selectedId = id;
    ui.inspector = id;
    if (zoom) return focusAsset(id) || true;
    if (ui.focus && ui.focus.id !== id) clearFocus();
    render();
    onSelectElement(network.assets.get(id).globalId);
    return true;
  }

  // ---- the outage simulation panel: the existing scenario and its result, shown on their own ----

  ui.sim = null;
  /** What the simulation reaches: the failed equipment and everything it leaves without power. */
  function simulationOf() {
    const st = session.state();
    if (!st.active) return null;
    const res = st.result ?? {};
    const failed = [...(st.scenario.offline ?? [])];
    const lostAll = [...new Set(res.lost ?? [])];
    const consumers = [...new Set(res.consumersLost ?? [])];
    const equipment = lostAll.filter(id => !consumers.includes(id) && !failed.includes(id));
    const throughTerminals = failed.filter(id => network.assets.get(id)?.feedThrough);
    const potential = throughTerminals.length ? compareScenario(network, st.scenario, { blockFeedThrough: throughTerminals }).consumersLost.filter(id => !consumers.includes(id) && !failed.includes(id)) : [];
    return { st, failed, consumers, equipment, lostAll, rerouted: [...(res.rerouted ?? [])], potential, throughTerminals,
      feeders: lostAll.filter(id => network.assets.get(id)?.assetType === 'FEEDER').length,
      // Feeders: the circuits (the cables' Circuit property) that lose supply.
      circuitCables: lostAll.map(id => network.assets.get(id)).filter(x => x?.assetType === 'FEEDER' && x.circuit).reduce((m, x) => m.set(x.circuit, [...(m.get(x.circuit) ?? []), x.id]), new Map()),
      substationIds: lostAll.filter(id => ['SUBSTATION', 'SWITCHGEAR'].includes(network.assets.get(id)?.assetType)),
      cableIds: lostAll.filter(id => network.assets.get(id)?.assetType === 'FEEDER'),
      get circuits() { return this.circuitCables.size; },
      get substations() { return this.substationIds.length; } };
  }
  const simulationFocus = () => { const s = simulationOf(); return s ? new Set([...s.failed, ...s.lostAll]) : null; };
  function startSimulation(r, { fromAsk = false, question = null, keepAnswer = false } = {}) {
    const s0 = session.state();
    const id = s0.scenario.offline?.at(-1) ?? r.primaryAssetId;
    ui.sim = { id, label: s0.label, tab: 'impact', view: 'after', all: false };
    ui.result = null;
    ui.investigation = null;
    ui.inspector = null;
    clearAsk();
    clearFocus();
    const sim = simulationOf();
    if (keepAnswer) {
      // From a document review: the panel opens beside the conversation, which keeps the review as it is.
      ui.selectedId = id;
    } else if (fromAsk) {
      // Asked in the conversation: answered there, with the whole impact; no panel opens.
      ui.sim.inChat = true;
      ui.question = question;
      ui.view = simulationAnswer(question);
    } else {
      ui.view = null;
      expandAsk(false);
    }
    render();
    frameSimulation();
  }
  /** The failed equipment, in red on the map, and the whole impact in view beside the panel. */
  function frameSimulation() {
    const sim = simulationOf();
    if (!sim) return;
    const a = network.assets.get(ui.sim.id);
    const g = a && geometryOf(a);
    const ids = [...sim.failed, ...sim.lostAll].filter(x => network.assets.get(x)?.route?.length >= 2 || Number.isFinite(network.assets.get(x)?.location?.longitude));
    frame(ids.length ? ids : [ui.sim.id], { pitch: -52, minRange: 450 });
    if (g) focusFx.show({ at: g.at, radius: g.radius, alarm: true, label: { id: ui.sim.id, type: 'Offline – simulated', iconSvg: ASK_ICONS.bolt } });
  }
  function askSimulation(question) {
    const sim = simulationOf();
    const id = ui.sim.id;
    const n = sim.consumers.length;
    ui.result = null; ui.question = question;
    ui.view = { question, kind: 'Outage simulation', status: 'answered',
      say: n ? `In the simulation ${id} is offline, and every normally closed supply route to these ${n} ${n === 1 ? 'consumer' : 'consumers'} runs through it, so they lose power.` : `In the simulation ${id} is offline, but every consumer still has a supply route that avoids it.`,
      say2: [sim.rerouted.length ? `${sim.rerouted.join(', ')} ${sim.rerouted.length === 1 ? 'stays' : 'stay'} on an alternate supply.` : '', sim.potential.length ? `${sim.potential.length} more could be affected if the fault is in ${sim.throughTerminals.join(', ')}’s terminals.` : '',
        ui.sim.inChat ? 'The affected assets are listed above; the reported status is unchanged.' : 'The list and the supply path are in the Outage Simulation panel; the reported status is unchanged.'].filter(Boolean).join(' '),
      actions: ui.sim.inChat ? [{ label: 'Reset simulation', attrs: { 'data-act': 'simReset' } }] : [{ label: 'Open the simulation panel', primary: true, attrs: { 'data-act': 'simOpen' } }],
      sources: ['Outage simulation on the IFC connectivity (normal switch states)'] };
    render();
  }
  /** A simulation asked about in Ask the Twin, answered in the conversation: counts, every affected asset, reset. */
  function simulationAnswer(question) {
    const sim = simulationOf();
    const id = ui.sim.id;
    const a = network.assets.get(id);
    const n = sim.consumers.length;
    const lost = { label: 'No power (simulated)', tone: 'bad' };
    const c = n ? { ...collectionOf(sim.consumers, { noun: 'consumers', nounOne: 'consumer' }), rows: sim.consumers.map(x => ({ id: x, name: network.assets.get(x)?.name, icon: ICON_OF[network.assets.get(x)?.assetType] ?? 'bolt', status: lost })) } : null;
    const item = x => ({ id: x, label: x, attrs: { 'data-asset': x } });
    return { question, kind: 'Outage simulation', status: 'answered',
      say: n ? `If ${id}${a ? ` (${a.name})` : ''} goes offline, ${n} ${n === 1 ? 'consumer loses' : 'consumers lose'} power.` : `If ${id} goes offline, every consumer keeps a supply.`,
      say2: [sim.rerouted.length ? `${sim.rerouted.join(', ')} ${sim.rerouted.length === 1 ? 'stays' : 'stay'} on an alternate supply.` : '', 'A simulation on the IFC connectivity; the reported status is unchanged.'].filter(Boolean).join(' '),
      metrics: [{ label: n === 1 ? 'Consumer offline' : 'Consumers offline', value: n, tone: n ? 'bad' : 'ok' },
        { label: sim.circuits ? (sim.circuits === 1 ? 'Feeder impacted' : 'Feeders impacted') : 'Cables de-energized', value: sim.circuits || sim.feeders, tone: 'info' },
        { label: sim.substations === 1 ? 'Substation affected' : 'Substations affected', value: sim.substations, tone: 'neutral' }],
      collection: c,
      groups: [
        ...(sim.potential.length ? [{ label: `Potentially affected (if the fault is in ${sim.throughTerminals.join(', ')}’s terminals)`, noun: 'assets', tone: 'warn', items: sim.potential.map(item) }] : []),
        ...(sim.equipment.length ? [{ label: 'De-energized equipment', noun: 'assets', tone: 'neutral', items: sim.equipment.map(item) }] : []),
      ],
      actions: [{ label: 'Reset simulation', primary: true, attrs: { 'data-act': 'simReset' } }], ...areaOutage(sim) };
  }
  /**
   * With an area selected, a simulated outage (run on the whole network) is split by where its affected
   * consumers are: inside the area, outside it, or with no position. The panel opens from here.
   */
  function areaOutage(sim) {
    const a = ui.area;
    if (!a) return {};
    const p = outageByArea(sim.consumers, a.m.relations);
    const fail = sim.failed.map(id => `${id} (${relationText[a.m.relations[id]?.relation ?? 'UNKNOWN_LOCATION']} the area)`).join(', ');
    const list = (label, ids, tone) => `<div class="tw-out-col is-${tone}"><b>${ids.length}</b><span>${esc(label)}</span>${ids.length ? `<div class="tw-out-ids">${ids.slice(0, 12).map(id => `<button type="button" data-asset="${esc(id)}">${esc(id)}</button>`).join('')}${ids.length > 12 ? `<small>+${ids.length - 12}</small>` : ''}</div>` : ''}</div>`;
    return { scope: areaScopeLabel(a),
      extraHtml: `<section class="tw-card tw-out" aria-label="Impact by area"><header class="tw-card-h"><h4>Affected consumers by area</h4><span class="tw-count">${p.total}</span></header>
        <div class="tw-out-cols">${list('Inside the selected area', p.inside, 'in')}${list('Outside the area', p.outside, 'out')}${p.unknown.length ? list('No position in the model', p.unknown, 'unk') : ''}</div>
        <p class="tw-note">${ASK_ICONS.info}Simulated on the whole network (failed: ${esc(fail)}). Modelled alternate routes are not an approved switching plan; the reported status is unchanged.</p></section>`,
      actions: [{ label: 'Open outage simulation', primary: true, attrs: { 'data-act': 'simPanel' } }, { label: 'Reset simulation', attrs: { 'data-act': 'simReset' } }] };
  }
  function endSimulation() {
    const id = ui.sim?.id ?? null;
    const wasInChat = Boolean(ui.sim?.inChat);
    session.reset();
    ui.preset = 'normal';
    ui.sim = null;
    ui.result = null;
    if (ui.view?.kind === 'Outage simulation') ui.view = null;
    focusFx.clear();
    clearFocus();
    // Back to the asset the simulation was started from (when it was started from its inspector).
    if (id && network.assets.has(id) && !wasInChat) { ui.inspector = id; ui.selectedId = id; }
    render();
  }
  function simulationHtml() {
    const sim = simulationOf();
    const id = ui.sim.id;
    const a = network.assets.get(id);
    // Reported: the model's own status, or the baseline network state — never the simulated one.
    const base = networkState(network, null).nodeState.get(id);
    const [baseLabel, baseTone] = (statuses.get(id)?.monitored && STATUS_PILL[statuses.get(id).status]) || STATE_PILL[base] || ['Unknown', 'neutral'];
    const rep = { label: baseLabel, tone: baseTone };
    const reportedText = baseLabel;
    const row = x => { const b = network.assets.get(x); return `<button type="button" class="isp-sim-row${x === ui.selectedId ? ' is-selected' : ''}" data-sim-asset="${esc(x)}"><i class="isp-sim-ring" aria-hidden="true"></i>
      <span class="isp-sim-ic">${ASK_ICONS[ICON_OF[b?.assetType] ?? 'bolt']}</span><b>${esc(x)}</b><span class="isp-sim-type">${esc(b ? typeName(b) : '')}</span><span class="isp-sim-chev">${ASK_ICONS.chevron}</span></button>`; };
    const list = ids => (ui.sim.all ? ids : ids.slice(0, 5)).map(row).join('');
    const tab = ui.sim.tab;
    const n = sim.consumers.length;
    // The three counts; each opens its own list below (the affected assets by default).
    const which = ui.sim.list ?? 'consumers';
    const feeders = sim.circuits ? [...sim.circuitCables.entries()] : null;
    const feederMetric = feeders ? [sim.circuits, sim.circuits === 1 ? 'Feeder<br>impacted' : 'Feeders<br>impacted'] : [sim.feeders, sim.feeders === 1 ? 'Cable<br>de-energized' : 'Cables<br>de-energized'];
    const metric = (key, tone, icon, value, label) => `<button type="button" class="isp-sim-m ${tone}${which === key ? ' is-current' : ''}" data-sim-list="${key}" aria-pressed="${which === key}"><span>${icon}<b>${value}</b></span><small>${label}</small></button>`;
    const circuitRow = ([circuit, cables]) => `<button type="button" class="isp-sim-row" data-sim-circuit="${esc(circuit)}"><i class="isp-sim-ring" aria-hidden="true"></i>
      <span class="isp-sim-ic">${ASK_ICONS.cable}</span><b>${esc(circuit)}</b><span class="isp-sim-type">${cables.length} ${cables.length === 1 ? 'cable' : 'cables'} de-energized</span><span class="isp-sim-chev">${ASK_ICONS.chevron}</span></button>`;
    const listOf = { consumers: { title: 'Affected Assets', items: sim.consumers, html: ids => list(ids) },
      feeders: feeders ? { title: 'Feeders Impacted', items: feeders, html: xs => (ui.sim.all ? xs : xs.slice(0, 5)).map(circuitRow).join('') } : { title: 'Cables De-energized', items: sim.cableIds, html: ids => list(ids) },
      substations: { title: 'Substations Affected', items: sim.substationIds, html: ids => list(ids) } }[which];
    const impact = `<section class="isp-sim-sum"><h3>${ASK_ICONS.chart}Impact Summary</h3><div class="isp-sim-metrics">
        ${metric('consumers', n ? 'is-bad' : 'is-ok', ASK_ICONS.power, n, n === 1 ? 'Consumer<br>offline' : 'Consumers<br>offline')}
        ${metric('feeders', 'is-info', ASK_ICONS.network, feederMetric[0], feederMetric[1])}
        ${metric('substations', '', ASK_ICONS.layers, sim.substations, sim.substations === 1 ? 'Substation<br>affected' : 'Substations<br>affected')}</div></section>
      ${listOf.items.length ? `<section class="isp-sim-card is-list"><header><h3>${listOf.title} (${listOf.items.length})</h3>${listOf.items.length > 5 ? `<button type="button" class="isp-sim-all" data-act="simAll">${ui.sim.all ? 'Show fewer' : 'View all →'}</button>` : ''}</header>${listOf.html(listOf.items)}</section>`
        : `<p class="isp-sim-none">${which === 'consumers' ? 'Every consumer is still supplied in the simulation.' : `No ${which === 'feeders' ? 'feeder' : 'substation'} loses supply in the simulation.`}</p>`}
      ${sim.potential.length ? `<section class="isp-sim-card is-warn"><header><h3>Potentially affected (${sim.potential.length})</h3></header><p class="isp-sim-note">Fed through ${esc(sim.throughTerminals.join(', '))}’s loop-in / loop-out terminals: supplied while only the load is out, lost if the fault is in the terminals.</p>${sim.potential.map(row).join('')}</section>` : ''}
      ${sim.equipment.length ? `<details class="isp-sim-more"><summary>De-energized equipment · ${sim.equipment.length}</summary><div>${sim.equipment.map(row).join('')}</div></details>` : ''}`;
    const sup = a?.electricalRole === ROLE.SOURCE ? null : supplyOf(id);
    const edgesIn = network.edges.filter(e => (sim.lostAll.includes(e.fromAssetId) || sim.failed.includes(e.fromAssetId)) && sim.lostAll.includes(e.toAssetId));
    const pairs = new Map(edgesIn.map(e => [[e.fromAssetId, e.toAssetId].sort().join('|'), e]));
    const stated = [...pairs.values()].filter(e => e.evidence === EVIDENCE.EXPLICIT_IFC).length;
    const supply = `<section class="isp-sim-card"><header><h3>Supply of ${esc(id)}</h3></header>
        ${sup?.primary ? `<div class="isp-sim-chain">${compactChain(sup.logical).map(x => x.kind === 'circuit' ? `<span class="isp-chain-step is-circuit">${esc(x.id)}</span>` : `<button type="button" class="isp-chain-step" data-sim-asset="${esc(x.id)}">${esc(x.id)}</button>`).join('<span class="isp-chain-sep">→</span>')}</div>
          <p class="isp-sim-note">${esc(verificationText(sup))}.</p>` : `<p class="isp-sim-note">${a?.electricalRole === ROLE.SOURCE ? `${esc(id)} is a supply point: nothing upstream in the model.` : 'No supply route in the model.'}</p>`}</section>
      <section class="isp-sim-card"><header><h3>Downstream of the outage</h3></header>
        <p class="isp-sim-note">${sim.lostAll.length} ${sim.lostAll.length === 1 ? 'asset loses' : 'assets lose'} supply through ${pairs.size} ${pairs.size === 1 ? 'connection' : 'connections'}: ${stated} with a direction stated in the IFC (SOURCE → SINK), ${pairs.size - stated} without (SOURCEANDSINK; the direction is taken from the source side).</p>
        ${sim.throughTerminals.length ? `<p class="isp-sim-note">Loop-in / loop-out terminals of ${esc(sim.throughTerminals.join(', '))} keep the circuit going past the failed load.</p>` : ''}</section>`;
    const docsOf = documentsForAsset(ui.docs, id);
    const documents = ui.docs ? `<section class="isp-sim-card">${docsOf.length ? documentListHtml(docsOf) : '<p class="isp-sim-none isp-doc-none">No document linked to this asset.</p>'}</section>` : '<p class="isp-sim-none">Reading the asset documentation from ACC…</p>';
    const lim = ['Connectivity, not power flow: an energized path does not mean adequate voltage, capacity or protection coordination.', 'Switches in their normal states, as the model records them.', 'The simulation never changes the reported status.'];
    const details = `<section class="isp-sim-card"><dl class="isp-dl">
        <dt>Failed asset</dt><dd>${esc(id)} · ${esc(a?.name ?? '')}</dd><dt>IFC model</dt><dd>${esc(sourceLabel)}</dd>
        <dt>Reported (model)</dt><dd>${esc(reportedText)}${a?.statusDate ? ` · ${esc(a.statusDate)}` : ''}</dd><dt>Simulated</dt><dd>Offline</dd>
        <dt>Scenario</dt><dd>${esc(ui.sim.label ?? '')}</dd><dt>Connectivity</dt><dd>IFC port connections (IfcRelConnectsPorts) and their FlowDirection</dd></dl></section>
      <section class="isp-sim-card"><header><h3>Assumptions and limitations</h3></header><ul class="isp-sim-list">${lim.map(x => `<li>${esc(x)}</li>`).join('')}</ul></section>`;
    return `<div class="isp-sim">
      <div class="isp-sim-top"><span class="isp-sim-bolt" aria-hidden="true">${ASK_ICONS.bolt}</span><h2>Outage Simulation</h2><button type="button" class="isp-x" data-act="simReset" aria-label="Close and reset the simulation">${ASK_ICONS.close}</button></div>
      <div class="isp-sim-asset"><span class="isp-sim-aic">${ASK_ICONS[ICON_OF[a?.assetType] ?? 'bolt']}</span><div><b>${esc(id)}</b><small>${esc(a?.name ?? '')}</small></div></div>
      <div class="isp-sim-pills"><span class="isp-sim-pill is-sim">Simulated: Offline</span><span class="isp-sim-pill is-${esc(rep.tone)}">Reported: ${esc(reportedText)}</span>
</div>
      <div class="isp-tabs isp-sim-tabs" role="tablist" aria-label="Simulation">${[['impact', 'Overview'], ['supply', 'Connections'], ['details', 'Properties'], ['documents', `Documents${ui.docs ? ` (${docsOf.length})` : ''}`]].map(([k, l]) => `<button type="button" role="tab" class="isp-tab" data-sim-tab="${k}" aria-selected="${tab === k}">${l}</button>`).join('')}</div>
      <div class="isp-sim-body" role="tabpanel">${{ impact, supply, details, documents }[tab]}</div>
      <div class="isp-sim-foot"><button type="button" class="isp-sim-reset is-outline" data-act="simReset">${ASK_ICONS.reset}<span>Reset Simulation</span></button>
        <button type="button" class="isp-sim-toggle" data-act="simView" role="switch" aria-checked="${ui.sim.view === 'after'}"><span>Before (Baseline)</span><i aria-hidden="true"></i><span>After (Outage)</span></button></div></div>`;
  }

  // ---- the single-asset focus: camera, highlight, beacon, rings, label, inspector, sound ----

  ui.focus = null;
  ui.inspector = null;
  let focusToken = 0;
  const focusFx = createFocusEffects(viewer, { freeSpan: () => { const f = freeArea(); return f.free ? { left: f.middle - f.free / 2, right: f.middle + f.free / 2 } : null; } });
  const locator = createLocatorSound();
  let soundOn = (() => { try { return localStorage.getItem('ifcSpatial.locatorSound') === 'on'; } catch { return false; } })();
  const reduceMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  /** Where an asset is and how big, from the model: a cable's route, or the element's bounding box. */
  function geometryOf(a) {
    const h = baseHeight + 0.6;
    if (a.route?.length >= 2) {
      const pts = a.route.map(p => Cartesian3.fromDegrees(p.lon, p.lat, h));
      const sphere = BoundingSphere.fromPoints(pts);
      const mid = a.route[Math.floor(a.route.length / 2)];
      return { at: { lon: mid.lon, lat: mid.lat, height: h }, radius: Math.max(sphere.radius, 8), sphere };
    }
    if (!Number.isFinite(a.location?.longitude)) return null;
    const bbox = built.byGlobalId.get(a.globalId)?.bbox;
    const size = bbox ? Math.hypot(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1]) / 2 : 0;
    const radius = Math.min(Math.max(size, 5), 60);
    const at = { lon: a.location.longitude, lat: a.location.latitude, height: h };
    return { at, radius, sphere: new BoundingSphere(Cartesian3.fromDegrees(at.lon, at.lat, h), radius) };
  }
  /** What stays bright around a focused asset: its supply path and its neighbours. */
  function focusContext(id) {
    const st = session.state();
    const { path } = traceSupplyPath(network, id, { scenario: st.active ? st.scenario : baselineScenario() });
    return new Set([id, ...path, ...neighbours(id)]);
  }
  /**
   * Focus one asset: open its inspector, fly to it (between the panels), then highlight it with the
   * beacon, rings and label, and play the locator tone when it is on. Asking about the same asset again
   * does not fly again; `recenter` does. A newer focus cancels an older one in flight.
   */
  function focusAsset(id, { recenter = false, sound = true } = {}) {
    const a = network.assets.get(id);
    if (!a) return false;
    if (openSimulationFor(id)) { ui.selectedId = id; render(); frameSimulation(); return true; }
    ui.lastAssets = [id];
    const g = geometryOf(a);
    const same = ui.focus?.id === id && ui.focus.state === 'ok' && focusFx.active();
    const token = ++focusToken;
    ui.selectedId = id;
    ui.inspector = id;
    onSelectElement(a.globalId);
    onFocusElement(a.globalId);
    askHl.setLabelsVisible(Boolean(ui.ask?.ids.includes(id)));
    if (!g) { ui.focus = { id, state: 'nogeo' }; focusFx.clear(); render(); return false; }
    if (same && !recenter) { render(); return true; }
    ui.focus = { id, state: same ? 'ok' : 'flying' };
    if (!same) { focusFx.clear(); locator.stop(); }
    render();
    const done = () => {
      if (token !== focusToken || ui.focus?.id !== id) return;
      clearOfPanels(g.sphere);
      if (!same) {
        focusFx.show({ at: g.at, radius: g.radius, label: { id, type: typeName(a), iconSvg: ASK_ICONS[ICON_OF[a.assetType] ?? 'bolt'] } });
        if (sound && soundOn) locator.play();
      }
      focusFx.layout();
      ui.focus.state = 'ok';
      render();
    };
    const { free, width } = freeArea();
    const fit = free ? Math.min(width / free, 2) : 1;
    // One zoom-in step (the header's +, 35 %) closer than a plain fit.
    const range = Math.min(Math.max(g.radius * 8, 150), 900) * fit * 0.65;
    viewer.camera.flyToBoundingSphere(g.sphere, { duration: reduceMotion() ? 0 : 2, easingFunction: EasingFunction.QUADRATIC_IN_OUT,
      offset: new HeadingPitchRange(CMath.toRadians(heading), CMath.toRadians(-38), range), complete: done, cancel: done });
    return true;
  }
  /** Remove the focus graphics (beacon, rings, label, cyan model highlight); alarms and the network stay. */
  function clearFocus() {
    ui.focus = null;
    focusToken += 1;
    focusFx.clear();
    locator.stop();
    askHl.setLabelsVisible(true);
    onFocusElement(null);
  }

  // The toolbar under the map while an asset is focused.
  const focusBar = document.createElement('div');
  focusBar.className = 'isp-focusbar';
  focusBar.hidden = true;
  askHost.parentElement?.append(focusBar);
  function renderFocusBar() {
    const sim = Boolean(ui.sim) && !ui.sim.inChat;
    const on = sim || (Boolean(ui.focus) && ui.focus.state !== 'nogeo');
    focusBar.hidden = !on;
    askHost.parentElement?.classList.toggle('is-focus-mode', sim || (Boolean(ui.focus) && ui.inspector === ui.focus.id));
    if (!on) return;
    focusBar.innerHTML = `<div class="isp-fb-legend" aria-hidden="true">${sim
      ? '<span><i class="is-bad"></i>No power (affected)</span><span><i class="is-ask"></i>Selected</span><span><i class="is-dash"></i>Affected feeder</span><span><i class="is-line"></i>Electrical network</span>'
      : '<span><i class="is-ask"></i>Ask the Twin (selected)</span><span><i class="is-bad"></i>No power</span><span><i class="is-warn"></i>Degraded</span><span><i class="is-line"></i>Electrical network</span>'}</div>
      <div class="isp-fb" role="toolbar" aria-label="Asset focus">
        <button type="button" class="isp-fb-btn${soundOn ? ' is-on' : ''}" data-act="soundOn" aria-pressed="${soundOn}">${ASK_ICONS.sound}<span>Locator sound${soundOn ? ' on' : ''}</span></button>
        <button type="button" class="isp-fb-btn${soundOn ? '' : ' is-on'}" data-act="soundOff" aria-pressed="${!soundOn}">${ASK_ICONS.mute}<span>Mute</span></button>
        <span class="isp-fb-sep" aria-hidden="true"></span>
        <button type="button" class="isp-fb-btn" data-act="focusRecenter">${ASK_ICONS.target}<span>Re-center</span></button>
        <button type="button" class="isp-fb-btn" data-act="focusClear">${ASK_ICONS.clear}<span>Clear highlight</span></button>
        <span class="isp-fb-sep" aria-hidden="true"></span>
        <button type="button" class="isp-fb-btn is-icon" data-act="fullscreen" aria-label="Fullscreen" title="Fullscreen">${ASK_ICONS.expand}</button></div>`;
    // Centred in the map between the panels.
    const f = freeArea();
    const root = askHost.parentElement.getBoundingClientRect();
    const canvas = viewer.canvas.getBoundingClientRect();
    if (f.free) focusBar.style.left = `${canvas.left - root.left + f.middle}px`;
    else focusBar.style.left = '';
  }

  // ---- Ask the Twin bar ----

  askHost.innerHTML = askPanelHtml({ bankHtml: IFC_QUESTION_BANK.map(c => `<details><summary>${esc(c.name)}</summary>${c.questions.map(q => `<button type="button" class="isp-bankq" data-ask="${esc(q)}">${esc(q)}</button>`).join('')}</details>`).join('') });
  const chatBody = askHost.querySelector('.isp-askp-body');
  // Collapsed to its launcher until opened (asking from anywhere opens it).
  askHost.classList.toggle('is-collapsed', !remembered.askOpen);
  askHost.querySelector('.isp-askp-collapse').setAttribute('aria-expanded', String(remembered.askOpen));
  askHost.querySelector('.isp-askp-launcher').hidden = remembered.askOpen;
  const chat = askHost.querySelector('.isp-askp-chat');
  // Panel width: the default, or expanded for long answers (documents, reports, the email draft). Kept per browser
  // and apart from collapsing; only the width changes (the conversation, the map and its camera stay as they are).
  const WIDTH_KEY = 'ifcSpatial.askWidth';
  let askWide = false;
  try { askWide = localStorage.getItem(WIDTH_KEY) === 'expanded'; } catch { /* first visit, or storage off */ }
  function setAskWidth(wide, { persist = true } = {}) {
    askWide = wide;
    const root = askHost.parentElement;
    // Keep the conversation where the reader was: the turn at the top of the view stays at the top once text reflows.
    const top = chatBody.getBoundingClientRect().top;
    const anchor = [...chat.querySelectorAll('.isp-turn')].find(t => t.getBoundingClientRect().bottom > top + 4) ?? null;
    const offset = anchor ? anchor.getBoundingClientRect().top - top : 0;
    root?.classList.toggle('is-ask-wide', wide);
    const btn = askHost.querySelector('.isp-askp-width');
    const label = wide ? 'Restore original width' : 'Expand panel width';
    btn.setAttribute('aria-pressed', String(wide));
    btn.setAttribute('aria-label', label);
    btn.title = label;
    btn.innerHTML = wide ? ASK_ICONS.minimize : ASK_ICONS.maximize;
    if (persist) { try { localStorage.setItem(WIDTH_KEY, wide ? 'expanded' : 'default'); } catch { /* not kept */ } }
    const settle = () => {
      if (anchor && !followChat) chatBody.scrollTop += (anchor.getBoundingClientRect().top - chatBody.getBoundingClientRect().top) - offset;
      renderFocusBar();
    };
    let done = false;
    const end = () => { if (!done) { done = true; settle(); } };
    // The toolbar under the map is centred in the free map area: again when the width has really finished changing.
    askHost.addEventListener('transitionend', function onEnd(e) { if (e.propertyName === 'width') { askHost.removeEventListener('transitionend', onEnd); end(); renderFocusBar(); } });
    setTimeout(end, 400);
  }
  setAskWidth(askWide, { persist: false });
  // Follow the newest answer unless the reader has scrolled up to an earlier one.
  let followChat = true;
  chatBody.addEventListener('scroll', () => { followChat = chatBody.scrollHeight - chatBody.scrollTop - chatBody.clientHeight < 48; }, { passive: true });

  /** A new turn in the conversation; the welcome state gives way to it. */
  function beginTurn(question, { fromMap = false } = {}) {
    ui.turns.push({ question: question ?? null, html: '', interpretedAs: nextInterpretedAs });
    nextInterpretedAs = null;
    ui.turn = ui.turns.length - 1;
    askHost.querySelector('.isp-askp-welcome').hidden = true;
    chat.hidden = false;
    const el = document.createElement('div');
    el.className = `isp-turn${fromMap ? ' is-from-map' : ''}`;
    el.dataset.turn = String(ui.turn);
    el.innerHTML = `${question ? `<div class="isp-msg-user">${fromMap ? '' : `<span class="isp-msg-av" aria-hidden="true">${ASK_ICONS.user}</span>`}<p>${esc(question)}</p></div>` : ''}<div class="isp-msg-ans"></div>`;
    chat.append(el);
    askHost.querySelector('.isp-askbar input').placeholder = 'Ask a follow-up question...';
    followChat = true;
    expandAsk(true);
  }
  /** The current answer into its turn (only when it changed, so open sections and scroll stay). */
  function renderTurn(answerHtml) {
    const turn = ui.turns[ui.turn];
    const el = chat.querySelector(`[data-turn="${ui.turn}"] .isp-msg-ans`);
    // A question Claude rewrote: what the twin understood, above the answer.
    const html = turn?.interpretedAs ? `<p class="isp-understood">${esc(understoodNote(turn.interpretedAs))}</p>${answerHtml}` : answerHtml;
    if (!turn || !el || turn.html === html) return;
    turn.html = html;
    el.innerHTML = html;
    if (followChat) el.parentElement.scrollIntoView({ block: 'start', behavior: 'auto' });
  }
  /** The send button while an answer is on its way; a failed question comes back to the input. */
  function renderAskBusy() {
    const send = askHost.querySelector('.isp-send');
    const input = askHost.querySelector('.isp-askbar input');
    if (!send) return;
    const busy = Boolean(working) || ui.view?.status === 'loading';
    send.classList.toggle('is-busy', busy);
    send.setAttribute('aria-busy', String(busy));
    // While an answer runs the send button is its Stop button.
    send.setAttribute('aria-label', busy ? 'Stop the answer' : 'Send question');
    send.title = busy ? 'Stop (Esc)' : '';
    if (busy) return;
    if (ui.view?.status === 'error' && retryText && !input.value) input.value = retryText;
    retryText = null;
  }
  /** Collapse to the launcher and back; the conversation stays as it is. */
  function expandAsk(open) {
    remembered.askOpen = open;
    askHost.classList.toggle('is-collapsed', !open);
    askHost.querySelector('.isp-askp-collapse').setAttribute('aria-expanded', String(open));
    const launcher = askHost.querySelector('.isp-askp-launcher');
    launcher.hidden = open;
    launcher.setAttribute('aria-expanded', String(open));
  }
  const form = askHost.querySelector('form');
  form.addEventListener('submit', event => {
    event.preventDefault();
    // Busy: the button stops the answer; Enter in the input waits (the text stays for when it is done).
    if (askHost.querySelector('.isp-send').classList.contains('is-busy')) { if (event.submitter?.classList.contains('isp-send')) stopAsk(); return; }
    const q = form.q.value.trim();
    if (!q) return;
    retryText = q;
    form.q.value = '';
    askHost.querySelector('.isp-bank').hidden = true;
    askQuestion(q);
  });


  // ---- context-aware investigations (askIntent.js → askOrchestrator.js → maintenance.js) ----

  ui.lastInvestigation = null;
  /** The structured conversation context a question is read against (§9). */
  function conversationContext() {
    return { selectedAssetId: ui.inspector ?? ui.focus?.id ?? null,
      collection: ui.lastCollection?.ids?.length ? { ids: ui.lastCollection.ids } : ui.lastAssets?.length ? { ids: ui.lastAssets } : null,
      investigation: ui.lastInvestigation ? { ids: ui.lastInvestigation.ids } : null };
  }
  function planFor(question) {
    const known = new Set(network.assets.keys());
    return planQuestion(question, { knownIds: known, namedIds: q => namedIds(q, known), categoriesIn: q => categoriesIn(q, spatial()), conversation: conversationContext(),
      area: ui.area ? { selectionId: ui.area.selectionId, versionKey: ui.area.versionKey } : null });
  }
  /**
   * One named asset's inspection history or condition trend: the existing document review answers it (its tabs,
   * citations and preview); the orchestrator takes every other maintenance question.
   */
  function existingDocAnswer(question, plan) {
    if (!plan.target.ids || plan.target.ids.length !== 1) return false;
    const id = plan.target.ids[0];
    const docIds = new Set([...network.assets.keys(), ...(ui.docs?.documents ?? []).map(d => d.mapping?.assetId).filter(Boolean)]);
    const understood = () => Boolean(classifyDocumentQuestion(question, { assetIds: docIds, contextAssetId: id, lastAnalysis: ui.lastDoc?.assetId === id ? ui.lastDoc.analyses?.[0] ?? null : null }));
    // A follow-up inside that asset's open document review stays in the review (its tabs and citations).
    if (ui.lastDoc?.assetId === id && !ui.lastInvestigation && understood()) return true;
    if (plan.target.kind !== 'NAMED') return false;
    if (![INTENT.INSPECTION_HISTORY, INTENT.CONDITION_TREND, INTENT.RECURRING_DEFECTS].includes(plan.primaryIntent)) return false;
    return understood();
  }
  /** "Which one?" when one asset is needed and the conversation offers several (never chosen arbitrarily). */
  function askWhichAsset(question, plan) {
    ui.result = null; ui.question = question;
    const verb = { OUTAGE_IMPACT: 'What happens if {id} goes offline?', REPLACEMENT_ASSESSMENT: 'What needs to be done before replacing {id}?' }[plan.primaryIntent] ?? `${question} ({id})`;
    ui.view = { question, kind: 'Clarification', status: 'answered', say: `Which asset do you mean? The last answer had ${plan.clarify.options.length}.`,
      followUps: plan.clarify.options.slice(0, 4).map(id => ({ label: id, question: verb.replace('{id}', id), icon: ICON_OF[network.assets.get(id)?.assetType] ?? 'bolt' })), suggestLimit: 4 };
    render();
  }
  /** A follow-up on one asset from the conversation, rewritten for the engine that answers it (its target is validated). */
  function resolvedFollowUp(question, plan) {
    if (!['PREVIOUS', 'SELECTED'].includes(plan.target.kind) || plan.target.ids.length !== 1) return null;
    const id = plan.target.ids[0];
    // Questions the document review already answers in context ("What specifications are missing?") keep their own wording.
    if (docTools && existingDocAnswer(question, plan)) return null;
    const map = { [INTENT.OUTAGE_IMPACT]: `What happens if ${id} goes offline?`, [INTENT.ALTERNATE_SUPPLY]: `Is there an alternate supply if ${id} fails?`,
      [INTENT.REPLACEMENT_ASSESSMENT]: `What should we verify before replacing ${id}?`, [INTENT.SUPPLY_DEPENDENCY]: `What supplies ${id}?`, [INTENT.DOWNSTREAM_IMPACT]: `What does ${id} supply?`,
      [INTENT.TECHNICAL_SPECIFICATIONS]: `What are ${id}'s technical specifications?`, [INTENT.ASSET_LOCATION]: `Show me ${id}` };
    return map[plan.primaryIntent] ?? null;
  }
  /** Ask a rewritten question in the current turn (the turn keeps what the user typed). */
  function askQuestionAs(rewritten, typed, opts = {}) {
    const turn = ui.turns[ui.turn];
    ui.turns.pop(); ui.turn = ui.turns.length - 1;
    chat.querySelector('.isp-turn:last-child')?.remove();
    askQuestion(rewritten, { fromLlm: viaLlm || opts.fromLlm });
    const el = chat.querySelector('.isp-turn:last-child .isp-msg-user p');
    if (el) el.textContent = typed;
    if (ui.turns[ui.turn]) ui.turns[ui.turn].question = typed;
    void turn;
  }

  /** A maintenance investigation: the plan run by the orchestrator over the twin's services, then the assessment. */
  async function askMaintenance(question, plan) {
    const mine = ++askToken;
    // The scope as it is now: a later area, or a cleared one, never changes this answer.
    const area = plan.scope.type === 'SELECTED_AREA' ? ui.area : null;
    const scopeLabel = area ? areaScopeLabel(area) : plan.scope.explicit && ui.area ? 'Entire terminal' : null;
    ui.result = null; ui.question = question;
    clearFocus(); ui.inspector = null;
    if (plan.target.kind === 'SCOPE' && !area) {
      ui.view = { question, kind: 'Maintenance assessment', status: 'answered', say: 'Which assets should I investigate?', say2: 'Name an asset, a status or a type, or select an area on the map.',
        followUps: [{ label: 'Degraded assets', question: `For degraded assets, ${question.replace(/^\s*(for [^,]+,\s*)?/i, '').replace(/^./, c => c.toLowerCase())}`, icon: 'bolt' }, { label: 'Assets without power', question: `For assets without power, ${question.replace(/^./, c => c.toLowerCase())}`, icon: 'bolt' }] };
      render();
      return;
    }
    const progress = p => {
      if (mine !== askToken) return;
      ui.view = { question, kind: 'Maintenance assessment', status: 'loading', title: p.total ? `${p.label} (${p.done ?? 0} of ${p.total})…` : `${p.label}…`, ...(scopeLabel ? { scope: scopeLabel } : {}) };
      render();
    };
    const tools = {
      scopeAssets: scope => (scope.type === 'SELECTED_AREA' && area ? [...area.inside] : [...network.assets.keys()]),
      statusOf: id => statuses.get(id) ?? null,
      categoryOf: id => categoryOfId(id),
      isAsset: id => network.assets.has(id),
      documentsOf: id => (ui.docs ? documentsForAsset(ui.docs, id) : null),
      analyze: async id => {
        const hit = docCache.get(id);
        if (hit && Date.now() - hit.at < DOC_CACHE_MS) return hit.analysis;
        const a = await docTools.analyze(id, 'MAINTENANCE_HISTORY');
        docCache.set(id, { analysis: a, at: Date.now() });
        return a;
      },
    };
    let inv;
    try { inv = await runInvestigation(plan, tools, { isCurrent: () => mine === askToken, onProgress: progress }); }
    catch (error) {
      if (mine !== askToken) return;
      ui.view = { question, kind: 'Maintenance assessment', status: 'error', say: 'The investigation could not be completed.', say2: `${error?.message ?? error}`, actions: [{ label: 'Retry', primary: true, attrs: { 'data-ask': question } }] };
      render();
      return;
    }
    if (inv.cancelled || mine !== askToken) return;
    const m = buildMaintenanceAssessment(inv, { scopeLabel, describe: id => { const x = network.assets.get(id); return x ? { type: typeName(x), name: String(x.name ?? '').replace(new RegExp(`\\s*\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '') || null } : {}; } });
    ui.lastInvestigation = { ids: m.assets.map(a => a.assetId), assessment: m, question, at: Date.now() };
    ui.lastDoc = null;
    ui.maint = { assessment: m, open: m.assets.length === 1 ? m.assets[0].assetId : null };
    renderMaintenance(question);
    const ids = m.assets.map(a => a.assetId).filter(id => network.assets.has(id));
    if (ids.length === 1) { setAskResults(ids, question, { keep: ids[0], noun: 'assets' }); ui.selectedId = ids[0]; focusAsset(ids[0], { sound: false }); }
    else if (ids.length) { setAskResults(ids, question, { noun: 'assets' }); render(); frame(ids, { pitch: -58, minRange: 300 }); }
  }
  /**
   * "Prepare a report of these issues", "Generate a maintenance report", "Inform the maintenance team": the
   * maintenance report (PDF, corrective action register, draft) from the current investigation. Returns false
   * when the question is a report of another kind (an inspection report, a register by type or status).
   */
  /** The recipient group named in a request ("to the electrical maintenance team", "inform the maintenance team"). */
  const groupOf = q => recipientOf(q) ?? (/\b(?:inform|notify|tell|update|e-?mail|alert)\s+(?:the\s+)?((?:[\w&-]+\s+){0,3}team)\b/i.exec(q)?.[1] ?? null)?.replace(/\b[a-z]/g, c => c.toUpperCase()) ?? null;
  function askInvestigationReport(question, plan) {
    const inv = ui.lastInvestigation;
    const rec = ui.lastReport ? ui.reports.get(ui.lastReport) : null;
    // A report already made from this investigation: the email follows it.
    if (plan.primaryIntent === INTENT.EMAIL_DRAFT && inv && rec?.investigationAt === inv.at) {
      tracked(askReportFollowUp(question, { email: { regenerate: true, recipientGroup: groupOf(question) ?? undefined } }));
      return true;
    }
    if (/\brequiring inspection\b|\binspection (report|register)\b/i.test(question)) return false;
    const aboutInvestigation = /\b(these|those|this|them|it|investigation)\b/i.test(question) || /\b(maintenance|corrective|defects?|findings?|issues?|repairs?)\b/i.test(question);
    let ids = null, from = null;
    if (inv && (aboutInvestigation || plan.primaryIntent === INTENT.EMAIL_DRAFT)) { ids = inv.ids; from = inv; }
    else if (/\b(maintenance report|corrective action register|maintenance register)\b/i.test(question)) {
      // No investigation yet: its assets from the question (a status, a type, the area), as the investigation would find them.
      const p = planFor(question.replace(/\b(prepare|generate|create|make|produce)\b[^,]*?\b(report|register)\b( (of|for|on))?/i, 'what needs to be fixed for'));
      const tgt = resolveTargets(p, { scopeAssets: scope => (scope.type === 'SELECTED_AREA' && ui.area ? [...ui.area.inside] : [...network.assets.keys()]), statusOf: id => statuses.get(id) ?? null,
        categoryOf: id => categoryOfId(id), isAsset: id => network.assets.has(id) });
      if (!tgt.ids.length || p.target.kind === 'SCOPE') { ui.result = null; ui.question = question; ui.view = { question, kind: 'Report', status: 'answered', say: 'Which assets should the maintenance report cover?', say2: 'Ask what needs to be fixed first (for example for degraded assets), or name the assets.' }; render(); return true; }
      ids = tgt.ids; from = { question, assessment: { primaryIntent: INTENT.CORRECTIVE_ACTIONS, filters: p.assetFilters, scope: { label: p.scope.type === 'SELECTED_AREA' && ui.area ? areaScopeLabel(ui.area) : null } }, at: null };
    } else return false;
    const wantsEmail = plan.primaryIntent === INTENT.EMAIL_DRAFT || plan.supportingIntents.includes(INTENT.EMAIL_DRAFT) || /\b(e-?mail|inform|notify)\b/i.test(question);
    const onlyXlsx = /\b(excel|xlsx|spreadsheet|register)\b/i.test(question) && !/\b(pdf|report)\b/i.test(question);
    const onlyPdf = /\bpdf\b/i.test(question) && !/\b(excel|xlsx|spreadsheet|register)\b/i.test(question);
    const types = [...new Set(ids.map(id => network.assets.get(id)?.assetType).filter(Boolean))];
    const a = from.assessment;
    const areaOf = a?.scope?.type === 'SELECTED_AREA' && ui.area && a.scope.selectionId === ui.area.selectionId ? ui.area : null;
    ui.result = null; ui.question = question;
    tracked(startReport(question, { kind: 'MAINTENANCE', types, typeLabels: typeLabels(types), outputs: { pdf: !onlyXlsx, xlsx: !onlyPdf, email: wantsEmail },
      recipientGroup: groupOf(question) ?? null, filters: { condition: null, excludeNoRecords: false, recurring: false, status: null }, options: { historyDepth: null, includeSpecs: false, dueWithinDays: null },
      investigation: { question: from.question, primaryIntent: a?.primaryIntent ?? INTENT.CORRECTIVE_ACTIONS, statusFilters: a?.filters?.operationalStatus ?? [], scopeLabel: a?.scope?.label ?? null } },
    { ids, area: areaOf, investigationAt: from.at }));
    return true;
  }
  /** The assessment into its turn: one asset in detail, or the collection (and one opened from it). */
  function renderMaintenance(question = ui.question) {
    const m = ui.maint?.assessment;
    if (!m) return;
    const one = m.assets.length === 1;
    const say = maintenanceSayFor(m, ui.maint.open);
    ui.view = { question, kind: 'Maintenance assessment', status: 'answered', plain: false, say: say.say, say2: say.say2,
      ...(m.scope.label ? { scope: m.scope.label } : {}),
      extraHtml: maintenanceHtml(m, { open: ui.maint.open, statusPill: id => reportedPill(id), illustrative: m.illustrative, reports: Boolean(docTools?.report) }),
      followUps: maintenanceSuggestions(m, { open: ui.maint.open, reports: Boolean(docTools?.report) }), suggestLimit: 3 };
    void one;
    render();
  }

  // ---- Select Area: spatial electrical intelligence over a drawn area ----
  // The area (areaDraw.js) is drawn on the map; the server resolves which elements it holds (areaQuery.js,
  // POST /area); the answers use the twin's own engines (supply paths, statuses, the simulation, documents,
  // reports) over the whole network, with the area only saying where each asset is (areaIntel.js).

  const OUTSIDE_COLOR = '#b48cff'; // supply equipment and paths outside the area (not a status colour)
  const UNCOUNTABLE = /(switchgear|equipment|\(scada\))$/i;
  const pluralOf = (c, keepCase = false) => { const l = keepCase ? String(c) : String(c).toLowerCase(); return UNCOUNTABLE.test(l) || /s$/.test(l) ? l : /(ch|sh|x)$/.test(l) ? `${l}es` : /[^aeiou]y$/.test(l) ? `${l.slice(0, -1)}ies` : `${l}s`; };
  const approxDistance = m => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
  ui.area = null; // the active area: {selectionId, selectionType, geometry, ring, label, zone, versionKey, versionNumber, createdAt, m (membership), inside: Set}
  ui.areaState = null; // {kind: 'drawing' | 'resolving' | 'error', mode, points, message}
  let areaToken = 0;
  const areaHint = document.createElement('div');
  areaHint.className = 'isp-area-hint';
  areaHint.hidden = true;
  areaHint.setAttribute('role', 'status');
  askHost.parentElement?.append(areaHint);
  const areaDraw = areaTools && viewer ? createAreaDraw(viewer, {
    onComplete: (ring, mode) => { void commitArea(ring, mode); },
    onCancel: reason => {
      ui.areaState = reason === 'too-few-points' ? { kind: 'error', message: 'A polygon needs at least three corners. The selection was not changed.' }
        : reason === 'no-ground' ? { kind: 'error', message: 'Part of that area is off the ground (sky or horizon), so it could not be placed. The selection was not changed.' } : null;
      renderArea();
    },
    onProgress: p => { ui.areaState = { kind: 'drawing', mode: p.mode, points: p.points }; renderArea(); },
  }) : null;
  const areaZones = () => zonePoints.map(z => ({ name: titleCase(z.text), lon: z.at.lon, lat: z.at.lat }));
  const areaLabel = a => a?.zone ?? 'Custom selected area';
  const areaScopeLabel = a => `Selected area · ${areaLabel(a)}`;

  /** A drawn ring: validated here (the server validates again), resolved by the server, then shown. */
  async function commitArea(ring, mode, { quiet = false } = {}) {
    const v = validateAreaGeometry(polygonOf(ring));
    if (!v.ok) { ui.areaState = { kind: 'error', message: `${v.message} The selection was not changed.` }; renderArea(); return false; }
    const mine = ++areaToken;
    ui.areaState = { kind: 'resolving' };
    renderArea();
    let m;
    try {
      m = await areaTools.resolve(polygonOf(v.ring), { zones: areaZones() });
    } catch (error) {
      if (mine !== areaToken) return false;
      ui.areaState = { kind: 'error', message: `The area could not be resolved: ${error?.message ?? error}. The selection was not changed.` };
      areaDraw?.show(ui.area?.ring ?? null);
      renderArea();
      return false;
    }
    // A newer selection (or a cleared one) wins over this late result.
    if (mine !== areaToken) return false;
    const inside = new Set([...m.within, ...m.intersects, ...m.crosses]);
    ui.area = { selectionId: m.selectionId, selectionType: mode, geometry: m.geometry, coordinateSystem: m.coordinateSystem, ring: v.ring, zone: m.zone ?? null,
      versionKey: m.key, versionNumber: m.versionNumber, projectFile: m.fileName, createdAt: m.resolvedAt, m, inside, areaM2: m.areaM2 };
    remembered.area = { ring: v.ring, mode };
    ui.areaState = null;
    areaDraw?.show(v.ring);
    renderArea();
    if (!quiet) areaSelectedTurn();
    return true;
  }
  function clearArea() {
    areaToken += 1;
    ui.area = null; ui.areaState = null; remembered.area = null;
    areaDraw?.cancel();
    areaDraw?.show(null);
    renderArea();
  }
  /** The area's assets that are network assets (electrical equipment and cables). */
  const areaAssets = (a = ui.area) => [...(a?.inside ?? [])].filter(id => network.assets.has(id));
  const isCable = id => { const x = network.assets.get(id); return x?.assetType === 'FEEDER' || x?.electricalRole === ROLE.CONDUCTOR || x?.route?.length >= 2; };
  const consumersIn = ids => ids.filter(id => { const x = network.assets.get(id); return x && (x.electricalRole === ROLE.LOAD || CONSUMER_TYPES.has(x.assetType)); });
  const categoryOfId = id => spatial().byId.get(id)?.category ?? spatial().facilities.find(f => f.id === id)?.category ?? (network.assets.has(id) ? cap(TYPE_NAME[network.assets.get(id).assetType] ?? typeLabel(network.assets.get(id).assetType)) : 'Other');
  const statusOfId = id => statuses.get(id) ?? null;

  /** The compact context card under the header, the Select Area button, and the drawing hint on the map. */
  function renderArea() {
    const btn = askHost.querySelector('.isp-askp-areabtn');
    const card = askHost.querySelector('.isp-askp-area');
    const a = ui.area;
    btn?.classList.toggle('is-active', Boolean(a));
    btn?.setAttribute('aria-pressed', String(Boolean(a)));
    if (card) {
      card.hidden = !a && ui.areaState?.kind !== 'resolving';
      if (!a && ui.areaState?.kind === 'resolving') card.innerHTML = '<div class="isp-area-card is-busy"><span class="tw-spin" aria-hidden="true"></span><span>Resolving the selected area…</span></div>';
      else if (a) {
        const s = statusOfArea(areaAssets(a), statusOfId);
        const total = a.inside.size;
        const unknown = a.m.unknown.length;
        card.innerHTML = `<div class="isp-area-card">
          <div class="isp-area-h"><span class="isp-area-ic" aria-hidden="true">${ASK_ICONS.scan}</span>
            <div class="isp-area-t"><b>Selected area</b><small>${esc(a.versionNumber ? `IFC V${a.versionNumber}` : versionTag())} · ${esc(areaLabel(a))}</small></div>
            <button type="button" class="isp-area-icbtn" data-act="areaShow" aria-label="Show the selected area on the map" title="Show the selected area on the map">${ASK_ICONS.target}</button></div>
          <div class="isp-area-m"><span><b>${total}</b> ${total === 1 ? 'asset' : 'assets'}</span>${s.counts.NO_POWER ? `<span class="is-bad"><i></i><b>${s.counts.NO_POWER}</b> no power</span>` : ''}${s.counts.DEGRADED ? `<span class="is-warn"><i></i><b>${s.counts.DEGRADED}</b> degraded</span>` : ''}${!s.counts.NO_POWER && !s.counts.DEGRADED && s.monitored ? '<span class="is-ok"><i></i>no alerts</span>' : ''}${unknown ? `<span class="is-muted" title="Assets with no position in the model: not placed inside or outside">${unknown} unplaced</span>` : ''}</div>
          <div class="isp-area-acts"><button type="button" data-act="areaAssets">View assets</button><button type="button" data-act="areaMenu" data-change="1">Change area</button><button type="button" data-act="areaClear">Clear area</button></div></div>`;
      }
    }
    // The hint on the map while drawing, resolving, or when a drawing could not be used.
    const st = ui.areaState;
    if (!st || (st.kind === 'resolving' && !areaDraw)) { areaHint.hidden = true; return; }
    areaHint.hidden = false;
    areaHint.classList.toggle('is-error', st.kind === 'error');
    if (st.kind === 'drawing') {
      const poly = st.mode === AREA_MODE.POLYGON;
      areaHint.innerHTML = `<span class="isp-area-hint-ic" aria-hidden="true">${poly ? ASK_ICONS.polygon : ASK_ICONS.rect}</span>
        <span>${poly ? `Click to add corners${st.points ? ` (${st.points})` : ''}. Double-click or Finish to close the area.` : 'Press and drag on the map to draw a rectangle.'} <kbd>Esc</kbd> cancels.</span>
        ${poly ? `<button type="button" class="isp-area-hint-btn is-primary" data-area-hint="finish"${st.points >= 3 ? '' : ' disabled'}>Finish</button>` : ''}
        <button type="button" class="isp-area-hint-btn" data-area-hint="cancel">Cancel</button>`;
    } else if (st.kind === 'resolving') {
      areaHint.innerHTML = '<span class="tw-spin" aria-hidden="true"></span><span>Finding the assets in the area…</span>';
    } else {
      areaHint.innerHTML = `<span class="isp-area-hint-ic" aria-hidden="true">${ASK_ICONS.info}</span><span>${esc(st.message)}</span>
        <button type="button" class="isp-area-hint-btn" data-area-hint="retry">Try again</button><button type="button" class="isp-area-hint-btn" data-area-hint="dismiss">Dismiss</button>`;
    }
  }
  areaHint.addEventListener('click', e => {
    const b = e.target.closest('[data-area-hint]');
    if (!b) return;
    const act = b.dataset.areaHint;
    if (act === 'finish') areaDraw?.finish();
    else if (act === 'cancel') areaDraw?.cancel();
    else if (act === 'retry') { ui.areaState = null; openAreaMenu(true); }
    else { ui.areaState = null; renderArea(); }
  });
  function openAreaMenu(open = null) {
    const menu = askHost.querySelector('.isp-askp-areamenu');
    const btn = askHost.querySelector('.isp-askp-areabtn');
    if (!menu || !btn) return;
    const next = open ?? menu.hidden;
    menu.hidden = !next;
    btn.setAttribute('aria-expanded', String(next));
    if (next) menu.querySelector('button')?.focus();
  }
  document.addEventListener('pointerdown', e => { if (!e.target.closest?.('.isp-askp-areawrap')) { const menu = askHost.querySelector('.isp-askp-areamenu'); if (menu && !menu.hidden) openAreaMenu(false); } }, true);
  function startAreaDraw(mode) {
    openAreaMenu(false);
    if (!areaDraw) return;
    clearFocus();
    areaDraw.start(mode);
  }
  /** Fly to the selected area (the area stays as it is). */
  function showArea() {
    const ring = ui.area?.ring;
    if (!ring) return;
    const sphere = BoundingSphere.fromPoints(ring.map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat, baseHeight)));
    viewer.camera.flyToBoundingSphere(sphere, { duration: 1.2, offset: new HeadingPitchRange(CMath.toRadians(heading), CMath.toRadians(-62), Math.max(sphere.radius * 2.6, 220)) });
  }

  /** The suggestions after an area is selected: at most four, from what the area holds. */
  function areaSuggestions(a = ui.area) {
    const ids = areaAssets(a);
    if (!a.inside.size) return [{ label: 'Show assets within 50 m of this area', question: 'Show assets within 50 metres of this area', icon: 'target' }];
    const types = new Set(ids.map(id => network.assets.get(id)?.assetType));
    const s = statusOfArea(ids, statusOfId);
    const consumers = consumersIn(ids);
    const out = [{ label: 'Show electrical assets in this area', question: 'Show electrical assets in this area', icon: 'layers' }];
    if (s.attention.length) out.push({ label: 'Which assets require attention?', question: 'Which assets in this area require attention?', icon: 'bolt' });
    if (types.has('TRANSFORMER')) out.push({ label: 'Which transformers supply this area?', question: 'Which transformers supply this area?', icon: 'network' });
    else if (consumers.length) out.push({ label: 'Where does this area get its power from?', question: 'Where does this area get its power from?', icon: 'network' });
    if (docTools?.report) out.push(types.has('TRANSFORMER')
      ? { label: 'Prepare a transformer inspection report', question: 'Prepare an inspection report for transformers in this area', icon: 'doc' }
      : { label: 'Prepare an area inspection report', question: `Prepare an inspection report for ${[...new Set(ids.map(id => typeLabels([network.assets.get(id)?.assetType])[0]?.plural).filter(Boolean))].slice(0, 2).join(' and ') || 'assets'} in this area`, icon: 'doc' });
    return out.slice(0, 4);
  }
  function areaSelectedTurn() {
    const a = ui.area;
    beginTurn(null, { fromMap: true });
    ui.result = null; ui.question = null;
    const n = a.inside.size;
    ui.view = { kind: 'Selected area', status: 'answered', scope: areaScopeLabel(a),
      say: n ? 'Area selected. Ask about the assets in it, their power, supply, inspections or a report.' : 'Area selected. No modelled assets are inside it.',
      say2: a.m.unknown.length ? `${a.m.unknown.length} ${a.m.unknown.length === 1 ? 'asset has' : 'assets have'} no position in the model, so ${a.m.unknown.length === 1 ? 'it is' : 'they are'} neither inside nor outside.` : '',
      followUps: areaSuggestions(a), suggestLimit: 4 };
    render();
  }

  // ---- area answers ----

  const relationText = { WITHIN: 'inside', INTERSECTS: 'partly inside', CROSSES: 'crosses the boundary', OUTSIDE: 'outside', UNKNOWN_LOCATION: 'no position' };
  /** The area answers' common frame: scope, version, membership basis. */
  const areaSources = a => [`Area: ${areaLabel(a)} (${Math.round(a.areaM2).toLocaleString('en-US')} m², EPSG:4326), resolved on the server against ${a.versionNumber ? `IFC V${a.versionNumber}` : 'the loaded model'} through the map placement`,
    'Membership: cables by their modelled route, other equipment by its bounding-box footprint, substations by their equipment outline (positions in this IFC are illustrative, not surveyed)'];
  function areaView(question, a, view) {
    ui.result = null; ui.question = question;
    clearFocus(); ui.inspector = null;
    ui.view = { question, status: 'answered', scope: areaScopeLabel(a), sources: areaSources(a), ...view };
    render();
  }
  /** Highlight ids on the map (the area stays) and frame them. */
  function areaHighlight(ids, question, noun = 'results', colors = null) {
    setAskResults(ids, question, { noun });
    if (ui.ask && colors) ui.ask.colors = colors;
    render();
    if (ui.ask) frame(ui.ask.ids, { pitch: -58, minRange: 300 });
  }
  const statusRows = ids => ids.map(id => ({ id, name: network.assets.get(id)?.name, icon: ICON_OF[network.assets.get(id)?.assetType] ?? 'bolt', status: reportedPill(id) }));

  /** "How many assets are in this area?", "Show all transformers in this area", "… outside this area". */
  function askAreaInventory(question, a, { scope = 'AREA', ids: given = null, nearM = null } = {}) {
    const cats = categoriesIn(question, spatial());
    const filter = Array.isArray(cats) ? cats : null;
    const pool = given ?? (scope === 'OUTSIDE' ? Object.entries(a.m.relations).filter(([, r]) => r.relation === 'OUTSIDE').map(([id]) => id) : [...a.inside]);
    const inv = inventoryOf(pool, categoryOfId, { filter });
    const ids = inv.categories.flatMap(c => c.ids);
    const where = scope === 'OUTSIDE' ? 'outside the selected area' : scope === 'NEAR' ? `within ${approxDistance(nearM)} of the selected area (outside it)` : 'in the selected area';
    const noun = filter?.length === 1 ? (ids.length === 1 ? filter[0].toLowerCase() : pluralOf(filter[0])) : ids.length === 1 ? 'asset' : 'assets';
    if (!ids.length) {
      return areaView(question, a, { kind: 'Area inventory', say: `No ${filter ? pluralOf(filter[0]) : 'assets'} ${where}.`,
        say2: a.m.unknown.length ? `${a.m.unknown.length} assets have no position in the model and could not be placed.` : '',
        followUps: scope === 'AREA' ? [{ label: 'Within 50 m of this area', question: `Show ${filter ? pluralOf(filter[0]) : 'assets'} within 50 metres of this area`, icon: 'target' }] : [] });
    }
    const partial = ids.filter(id => a.m.relations[id]?.relation === 'INTERSECTS').length;
    const crossing = ids.filter(id => a.m.relations[id]?.relation === 'CROSSES').length;
    const breakdown = inv.categories.length > 1 ? `<div class="tw-abreak" aria-label="By category">${inv.categories.map(c => `<button type="button" class="tw-abreak-r" data-ask="${esc(`Show ${pluralOf(c.category)} ${scope === 'OUTSIDE' ? 'outside this area' : 'in this area'}`)}"><span>${esc(pluralOf(c.category, true))}</span><b>${c.ids.length}</b></button>`).join('')}</div>` : '';
    const c = { ...collectionOf(ids, { noun: 'assets', nounOne: 'asset' }), rows: statusRows(ids) };
    areaView(question, a, { kind: 'Area inventory',
      say: `${ids.length} ${noun} ${where}.`,
      say2: [partial ? `${partial} partly inside the boundary` : '', crossing ? `${crossing} ${crossing === 1 ? 'cable crosses' : 'cables cross'} it` : '', scope === 'AREA' && a.m.unknown.length ? `${a.m.unknown.length} with no position not counted` : ''].filter(Boolean).join(' · '),
      extraHtml: breakdown, collection: c,
      actions: [{ label: 'Show on map', primary: true, attrs: { 'data-area-show': ids.join(',') } }],
      followUps: [{ label: 'Which require attention?', question: 'Which assets in this area require attention?', icon: 'bolt' }, { label: 'Where does the power come from?', question: 'Where does this area get its power from?', icon: 'network' }] });
    areaHighlight(ids, question, filter?.length === 1 ? pluralOf(filter[0]) : 'assets');
  }

  /** "Which assets are degraded?", "Which have no power?", "Are all cranes operational in this area?". */
  function askAreaStatus(question, a) {
    const cats = categoriesIn(question, spatial());
    const filter = Array.isArray(cats) ? cats : null;
    const ids = areaAssets(a).filter(id => !filter || filter.includes(categoryOfId(id)));
    const s = statusOfArea(ids, statusOfId);
    const wantsDeg = /\bdegraded\b/i.test(question), wantsNo = /\b(no power|without power|unpowered|de-?energi[sz]ed)\b/i.test(question), wantsOff = /\boffline\b/i.test(question);
    const pick = wantsDeg || wantsNo || wantsOff ? [...(wantsNo ? s.lists.NO_POWER : []), ...(wantsDeg ? s.lists.DEGRADED : []), ...(wantsOff ? s.lists.OFFLINE : [])] : s.attention;
    const operational = /\b(operational|working|available|running)\b/i.test(question);
    const what = filter?.length === 1 ? pluralOf(filter[0]) : 'monitored assets';
    const say = !s.monitored ? `No ${filter ? pluralOf(filter[0]) : 'monitored assets'} in the selected area have a power status.`
      : operational && !s.attention.length ? `All ${s.monitored} ${what} in the selected area have power.`
        : pick.length ? `In the selected area, ${[s.counts.NO_POWER && (!wantsDeg || wantsNo) ? `${s.counts.NO_POWER} ${s.counts.NO_POWER === 1 ? 'asset has' : 'assets have'} no power` : '', s.counts.DEGRADED && (!wantsNo || wantsDeg) ? `${s.counts.DEGRADED} ${s.counts.DEGRADED === 1 ? 'is' : 'are'} degraded` : '', s.counts.OFFLINE && (!wantsDeg && !wantsNo || wantsOff) ? `${s.counts.OFFLINE} offline` : ''].filter(Boolean).join(', ')}.`
          : `None of the ${s.monitored} ${what} in the selected area ${wantsDeg && !wantsNo ? 'is degraded' : wantsNo && !wantsDeg ? 'is without power' : 'has an alert'}.`;
    const notes = [s.unmonitored ? `${s.unmonitored} ${s.unmonitored === 1 ? 'asset (a cable or structure) has' : 'assets (cables, structures) have'} no status of its own and ${s.unmonitored === 1 ? 'is' : 'are'} not counted.` : '',
      operational ? 'Power status is electrical only: an energized asset is not shown to be mechanically available.' : '',
      session.state().active ? 'These are reported statuses, not the running simulation.' : ''].filter(Boolean);
    const c = pick.length ? { ...collectionOf(pick, { noun: 'assets', nounOne: 'asset' }), rows: statusRows(pick) } : null;
    areaView(question, a, { kind: 'Area power status', say, say2: notes.join(' '),
      metrics: s.monitored ? [{ label: 'No power', value: s.counts.NO_POWER, tone: 'bad' }, { label: 'Degraded', value: s.counts.DEGRADED, tone: 'warn' }, { label: 'Powered', value: s.counts.POWERED, tone: 'ok' }, ...(s.counts.OFFLINE ? [{ label: 'Offline', value: s.counts.OFFLINE, tone: 'neutral' }] : []), ...(s.counts.UNKNOWN ? [{ label: 'Unknown', value: s.counts.UNKNOWN, tone: 'neutral' }] : [])] : [],
      collection: c,
      actions: s.lists.NO_POWER[0] ? [{ label: `Investigate ${s.lists.NO_POWER[0]}`, primary: true, attrs: { 'data-ops-investigate': s.lists.NO_POWER[0] } }] : [],
      followUps: [{ label: 'Where does the power come from?', question: 'Where does this area get its power from?', icon: 'network' }, { label: 'Which require inspection?', question: 'Which assets in this area require inspection?', icon: 'doc' }] });
    if (pick.length) areaHighlight(pick, question, 'assets'); else { clearAsk(); render(); }
  }

  /** "Where does this area get its power from?", "Which transformers supply this area?", "… supplied by TX-M1?". */
  function askAreaSupply(question, a) {
    const ids = areaAssets(a);
    const named = namedIds(question, new Set(network.assets.keys()));
    let consumers = consumersIn(ids);
    if (!consumers.length) consumers = ids.filter(id => network.assets.get(id)?.electricalRole !== ROLE.SOURCE && !isCable(id));
    const cats = categoriesIn(question, spatial());
    // A category filter only for consumers named in the question ("the cranes in this area"), never for the
    // equipment asked about upstream ("which transformers supply …") or a word like "supply".
    const filterCats = Array.isArray(cats) ? cats.filter(c => consumers.some(id => categoryOfId(id) === c)) : [];
    if (filterCats.length) consumers = consumers.filter(id => filterCats.includes(categoryOfId(id)));
    if (!consumers.length) return areaView(question, a, { kind: 'Area supply', say: 'The selected area holds no consumers or equipment with a supply path to trace.' });
    const roles = /\btransformers?\b/i.test(question) ? [ROLE.TRANSFORMER] : /\b(substations?|switchgear|switchboards?|rmus?)\b/i.test(question) ? [ROLE.DISTRIBUTION] : [ROLE.SOURCE, ROLE.TRANSFORMER, ROLE.DISTRIBUTION];
    const roleOfId = id => network.assets.get(id)?.electricalRole ?? ROLE.UNKNOWN;
    const sup = supplyOfArea({ consumers, supplyOf, roleOf: roleOfId, relations: a.m.relations, roles });
    // "Are any assets in this area supplied by TX-M1?"
    const by = named.find(id => network.assets.has(id) && /\b(supplied|fed|powered)\s+(by|from)\b/i.test(question));
    if (by) {
      const fed = consumers.filter(c => (supplyOf(c).primary?.path ?? []).includes(by));
      const c = fed.length ? { ...collectionOf(fed, { noun: 'assets', nounOne: 'asset' }), rows: statusRows(fed) } : null;
      areaView(question, a, { kind: 'Area supply', say: fed.length ? `Yes: ${fed.length} of the area’s ${consumers.length} ${consumers.length === 1 ? 'consumer is' : 'consumers are'} supplied through ${by} on ${fed.length === 1 ? 'its' : 'their'} normal supply path.` : `No: none of the area’s ${consumers.length} consumers has ${by} on its normal supply path in the model.`,
        say2: `${by} is ${relationText[a.m.relations[by]?.relation ?? 'UNKNOWN_LOCATION']} the area.`, collection: c });
      if (fed.length) areaHighlight([by, ...fed], question, 'assets');
      return;
    }
    ui.lastAreaSupply = { selectionId: a.selectionId, roles, upstream: sup.upstream.map(u => ({ id: u.id, inside: u.inside })) };
    const noun = roles.length === 1 && roles[0] === ROLE.TRANSFORMER ? 'transformer' : roles.length === 1 ? 'substation or switchboard' : 'supply equipment';
    const nouns = noun === 'transformer' ? 'transformers' : noun === 'substation or switchboard' ? 'substations and switchboards' : 'pieces of supply equipment';
    const n = sup.upstream.length;
    const say = !n ? `No modelled ${nouns} supply the area’s consumers.` : roles.length === 1
      ? `The selected area receives power through ${n} modelled ${n === 1 ? noun : nouns}${sup.inside.length && sup.outside.length ? `: ${sup.inside.length} inside the area and ${sup.outside.length} outside it` : sup.outside.length ? `, all outside the area` : ', all inside the area'}.`
      : `The selected area is supplied from ${sup.upstream.filter(u => u.role === ROLE.SOURCE).map(u => u.id).join(', ') || 'no modelled source'}, through ${sup.upstream.filter(u => u.role === ROLE.TRANSFORMER).length} transformers and ${sup.upstream.filter(u => u.role === ROLE.DISTRIBUTION).length} switchboards (${sup.outside.length} of them outside the area).`;
    const pill = u => { const p = reportedPill(u.id); return `<span class="tw-status is-${esc(p?.tone ?? 'neutral')}">${esc(p?.label ?? 'Unknown')}</span>`; };
    const rowsHtml = sup.upstream.map(u => `<div class="tw-dep-r"><button type="button" class="tw-dep-id" data-asset="${esc(u.id)}">${esc(u.id)}</button>
        <span class="tw-dep-where is-${u.inside ? 'in' : 'out'}">${u.inside ? 'Inside area' : 'Outside area'}</span>
        <span class="tw-dep-n">${u.consumers.length} of ${consumers.length} consumers</span>${pill(u)}
        <button type="button" class="tw-dep-path" data-area-path="${esc(u.id)}">View supply path</button></div>`).join('');
    const card = n ? `<section class="tw-card tw-dep" aria-label="Supplying equipment"><header class="tw-card-h"><h4>Supplying ${esc(nouns)}</h4><span class="tw-count">${n}</span></header>
        <div class="tw-dep-rows">${rowsHtml}</div>
        <p class="tw-dep-legend"><span><i class="is-in"></i>In or across the area</span><span><i class="is-out"></i>Outside the area</span><span><i class="is-area"></i>Selected area</span></p></section>` : '';
    areaView(question, a, { kind: 'Area supply', say,
      say2: [sup.unsupplied.length ? `${sup.unsupplied.length} ${sup.unsupplied.length === 1 ? 'consumer has' : 'consumers have'} no supply path in the model (${sup.unsupplied.slice(0, 4).join(', ')}${sup.unsupplied.length > 4 ? ', …' : ''}).` : '',
        sup.unverified.length ? `${sup.unverified.length} of the paths include connections with no direction in the IFC (taken from the source side).` : '',
        'Traced on the model’s supply paths through the whole network, not by distance.'].filter(Boolean).join(' '),
      extraHtml: card,
      actions: n ? [{ label: 'Highlight supply network', primary: true, attrs: { 'data-area-supplyhl': '1' } }, { label: 'View external dependencies', attrs: { 'data-ask': 'Which assets outside this area depend on equipment inside it?' } }] : [],
      followUps: [{ label: 'Alternate supply?', question: 'Do the consumers in this area have an alternate power supply?', icon: 'network' }] });
    ui.areaSupplyPaths = { consumers, pathIds: sup.pathIds, upstream: sup.upstream };
    highlightAreaSupply();
  }
  /** The area's supply paths on the map: inside the area in the answer colour, outside it in violet. */
  function highlightAreaSupply(onlyFrom = null) {
    const p = ui.areaSupplyPaths;
    const a = ui.area;
    if (!p || !a) return;
    let ids = p.pathIds;
    if (onlyFrom) {
      const set = new Set([onlyFrom]);
      for (const c of p.upstream.find(u => u.id === onlyFrom)?.consumers ?? []) { const path = supplyOf(c).primary?.path ?? []; const i = path.indexOf(onlyFrom); if (i >= 0) path.slice(i).forEach(x => set.add(x)); }
      ids = [...set];
    }
    const colors = new Map(ids.filter(id => !isInArea(a.m.relations[id]?.relation)).map(id => [id, OUTSIDE_COLOR]));
    areaHighlight(ids, ui.question, 'assets', colors);
  }
  /** "Are any of these transformers located outside the selected area?" — on the last supply answer. */
  function askAreaSupplyFollow(question, a) {
    const last = ui.lastAreaSupply;
    const outside = last.upstream.filter(u => !u.inside).map(u => u.id), inside = last.upstream.filter(u => u.inside).map(u => u.id);
    areaView(question, a, { kind: 'Area supply',
      say: outside.length ? `Yes: ${outside.length} of the ${last.upstream.length} ${outside.length === 1 ? 'is' : 'are'} outside the selected area: ${outside.join(', ')}.` : `No: all ${last.upstream.length} are inside the selected area.`,
      say2: inside.length ? `Inside the area: ${inside.join(', ')}.` : '', collection: outside.length ? { ...collectionOf(outside, { noun: 'assets', nounOne: 'asset' }), rows: statusRows(outside) } : null,
      followUps: outside[0] ? [{ label: `If ${outside[0]} shuts down`, question: `What happens if ${outside[0]} shuts down?`, icon: 'bolt' }] : [] });
    if (outside.length) areaHighlight(outside, question, 'assets', new Map(outside.map(id => [id, OUTSIDE_COLOR])));
  }

  /** "Which assets outside this area depend on equipment inside it?" */
  function askAreaDownstream(question, a) {
    const all = [...network.assets.keys()].filter(id => { const x = network.assets.get(id); return x.electricalRole === ROLE.LOAD || CONSUMER_TYPES.has(x.assetType); });
    const deps = dependentsOutside({ consumers: all, supplyOf, relations: a.m.relations });
    const via = [...new Set(deps.flatMap(d => d.via))];
    const ids = deps.map(d => d.id);
    areaView(question, a, { kind: 'Downstream impact',
      say: deps.length ? `${deps.length} ${deps.length === 1 ? 'consumer outside the area depends' : 'consumers outside the area depend'} on equipment inside it, through ${via.length} ${via.length === 1 ? 'asset' : 'assets'} in the area (${via.slice(0, 4).join(', ')}${via.length > 4 ? ', …' : ''}).` : 'No consumer outside the area has equipment inside it on its normal supply path.',
      say2: 'From the normal supply paths in the model (normally-open devices open).',
      collection: ids.length ? { ...collectionOf(ids, { noun: 'assets', nounOne: 'asset' }), rows: statusRows(ids) } : null,
      followUps: via[0] ? [{ label: `If ${via[0]} shuts down`, question: `What happens if ${via[0]} shuts down?`, icon: 'bolt' }] : [] });
    if (ids.length) areaHighlight([...via, ...ids], question, 'assets', new Map(ids.map(id => [id, OUTSIDE_COLOR])));
  }

  /** "Do the cranes in this area have an alternate power supply?" — coverage per consumer. */
  function askAreaAlternate(question, a) {
    const cats = categoriesIn(question, spatial());
    const filter = Array.isArray(cats) ? cats : null;
    const consumers = consumersIn(areaAssets(a)).filter(id => !filter || filter.includes(categoryOfId(id)));
    const what = filter?.length === 1 ? pluralOf(filter[0]) : 'consumers';
    if (!consumers.length) return areaView(question, a, { kind: 'Alternate supply', say: `No ${what} in the selected area.` });
    const cov = alternateCoverage(consumers, supplyOf);
    const closing = [...new Set(cov.covered.flatMap(c => c.needsClosing))];
    areaView(question, a, { kind: 'Alternate supply',
      say: cov.all ? `Yes: all ${cov.total} ${what} in the area have a modelled alternate route.` : cov.none ? `No: none of the ${cov.total} ${what} in the area has a modelled alternate route.` : `Partly: ${cov.covered.length} of the ${cov.total} ${what} in the area have a modelled alternate route; ${cov.without.length} ${cov.without.length === 1 ? 'has' : 'have'} none${cov.unknown.length ? ` and ${cov.unknown.length} ${cov.unknown.length === 1 ? 'has' : 'have'} no supply path in the model` : ''}.`,
      say2: [closing.length ? `The alternate routes need ${closing.join(', ')} closed.` : '', 'A modelled route is not an approved switching plan: capacity, protection coordination and site procedures still need engineering verification.'].filter(Boolean).join(' '),
      groups: [{ label: 'With an alternate route', tone: 'ok', noun: 'assets', items: cov.covered.map(c => ({ id: c.id, label: c.id, attrs: { 'data-asset': c.id } })) },
        { label: 'No alternate route', tone: 'warn', noun: 'assets', items: cov.without.map(id => ({ id, label: id, attrs: { 'data-asset': id } })) }] });
    areaHighlight(consumers, question, what);
  }

  /** "We are planning construction in this area…", "Which cables cross this area?" */
  async function askAreaConstruction(question, a) {
    const nearM = distanceIn(question);
    let m = a.m;
    const mine = ++askToken;
    if (nearM) {
      ui.view = { question, kind: 'Construction screening', status: 'loading', title: `Screening the area and a ${approxDistance(nearM)} buffer…`, scope: areaScopeLabel(a) };
      render();
      try { m = await areaTools.resolve(a.geometry, { nearM, zones: areaZones() }); } catch (error) { if (mine === askToken) areaView(question, a, { kind: 'Construction screening', status: 'error', say: `The buffer could not be computed: ${error?.message ?? error}` }); return; }
      if (mine !== askToken) return;
    }
    const scr = constructionScreen({ membership: m, kindOf: id => (isCable(id) ? 'CABLE' : 'EQUIPMENT'), nearM });
    const onlyCables = /\bcables?\b/i.test(question) && !/\bconstruction|excavat|dig|works?\b/i.test(question);
    const all = [...new Set([...scr.within, ...scr.intersects, ...scr.cables])].filter(id => network.assets.has(id) || spatial().byId.has(id));
    const consumersAll = [...network.assets.keys()].filter(id => { const x = network.assets.get(id); return x.electricalRole === ROLE.LOAD || CONSUMER_TYPES.has(x.assetType); });
    const deps = dependentsOutside({ consumers: consumersAll, supplyOf, relations: m.relations });
    const g = (label, list, tone) => ({ label, tone, noun: 'assets', items: list.map(id => ({ id, label: id, attrs: network.assets.has(id) ? { 'data-asset': id } : null })) });
    areaView(question, a, { kind: 'Construction screening',
      say: onlyCables ? (scr.cables.length ? `${scr.cablesCrossing.length} modelled ${scr.cablesCrossing.length === 1 ? 'cable crosses' : 'cables cross'} the area${scr.cablesWithin.length ? ` and ${scr.cablesWithin.length} ${scr.cablesWithin.length === 1 ? 'runs' : 'run'} entirely inside it` : ''}.` : 'No modelled cable route enters the area.')
        : `Preliminary screening: ${all.length} modelled ${all.length === 1 ? 'asset is' : 'assets are'} in or across the boundary (${scr.cables.length} ${scr.cables.length === 1 ? 'cable' : 'cables'}, ${scr.within.length} inside, ${scr.intersects.length} partly inside)${nearM ? `, and ${scr.near.length} more within ${approxDistance(nearM)}` : ''}.${deps.length ? ` ${deps.length} ${deps.length === 1 ? 'consumer elsewhere depends' : 'consumers elsewhere depend'} on equipment inside it.` : ''}`,
      say2: ['A screening of the IFC model only, not a construction clearance or permit: cable depths and surveyed positions are not in the model, positions are illustrative, and the absence of a modelled cable does not mean none is there.',
        nearM ? '' : 'No buffer was applied: name a distance (for example “within 10 m of this area”) to include nearby assets.'].filter(Boolean).join(' '),
      groups: [g('Cables crossing the boundary', scr.cablesCrossing, 'bad'), g('Cables inside the area', scr.cablesWithin, 'warn'), ...(onlyCables ? [] : [g('Equipment inside', scr.within, 'info'), g('Partly inside the boundary', scr.intersects, 'warn')]),
        ...(nearM ? [{ label: `Within ${approxDistance(nearM)} (proximity, not an intersection)`, tone: 'neutral', noun: 'assets', items: scr.near.map(n => ({ id: n.id, label: n.id, status: { label: approxMetres(n.distanceM), tone: 'neutral' }, attrs: network.assets.has(n.id) ? { 'data-asset': n.id } : null })) }] : [])],
      actions: deps.length ? [{ label: 'View external dependencies', attrs: { 'data-ask': 'Which assets outside this area depend on equipment inside it?' } }] : [] });
    areaHighlight(onlyCables ? scr.cables : [...all, ...scr.near.map(n => n.id)], question, 'assets');
  }

  /** "Within 50 m of this area": resolved again on the server with that buffer. */
  async function askAreaNear(question, a, distanceM) {
    const mine = ++askToken;
    ui.view = { question, kind: 'Area inventory', status: 'loading', title: `Finding assets within ${approxDistance(distanceM)} of the area…`, scope: areaScopeLabel(a) };
    render();
    let m;
    try { m = await areaTools.resolve(a.geometry, { nearM: distanceM, zones: areaZones() }); } catch (error) { if (mine === askToken) areaView(question, a, { kind: 'Area inventory', status: 'error', say: `The buffer could not be computed: ${error?.message ?? error}` }); return; }
    if (mine !== askToken) return;
    askAreaInventory(question, a, { scope: 'NEAR', ids: m.near.map(n => n.id), nearM: distanceM });
  }

  /** "Which assets in this area require inspection?", "… no linked inspection documents?", "… recurring defects?" */
  async function askAreaInspection(question, a) {
    const ids = areaAssets(a);
    const mine = ++askToken;
    // Report-style eligibility (inspection required) runs through the report pipeline, which reads every document.
    if (/\b(require|requiring|need|needs|due|overdue)\b[^?]*\binspect/i.test(question) && docTools?.report) {
      const types = [...new Set(ids.map(id => network.assets.get(id)?.assetType).filter(t => t && !['FEEDER'].includes(t)))];
      if (!types.length) return areaView(question, a, { kind: 'Inspection', say: 'The selected area holds no equipment to assess for inspection.' });
      tracked(startReport(question, { kind: 'INSPECTION', types, typeLabels: typeLabels(types), outputs: { pdf: false, xlsx: false, email: false }, recipientGroup: null,
        filters: { condition: null, excludeNoRecords: false, recurring: false, status: null }, options: { historyDepth: null, includeSpecs: false, dueWithinDays: null } }, { area: a }));
      return;
    }
    ui.view = { question, kind: 'Inspection', status: 'loading', title: 'Reading the asset documentation index…', scope: areaScopeLabel(a) };
    render();
    const docsOf = id => (ui.docs ? documentsForAsset(ui.docs, id) : []);
    const equipment = ids.filter(id => !isCable(id));
    if (!ui.docs) return areaView(question, a, { kind: 'Inspection', status: 'limited', say: 'The asset documentation index has not been read from ACC yet, so documents could not be checked.', say2: 'Open Asset documentation (or sign in to Autodesk), then ask again.' });
    const withDocs = equipment.filter(id => docsOf(id).length), without = equipment.filter(id => !docsOf(id).length);
    const docText = d => `${d.docType ?? ''} ${d.title ?? ''} ${d.fileName ?? d.name ?? ''}`;
    const isInspection = d => /inspect/i.test(docText(d));
    const isSpec = d => /spec|datasheet|data sheet/i.test(docText(d));
    if (/\b(no|without|missing|lack\w*)\b/i.test(question)) {
      const spec = /\bspec/i.test(question);
      const missing = equipment.filter(id => !docsOf(id).some(spec ? isSpec : isInspection));
      return areaView(question, a, { kind: 'Documents', say: `${missing.length} of the ${equipment.length} ${equipment.length === 1 ? 'asset' : 'assets'} in the area ${missing.length === 1 ? 'has' : 'have'} no linked ${spec ? 'technical specification' : 'inspection document'} in ACC.`,
        say2: 'Missing documents are a data gap, not evidence that an asset needs inspection.',
        collection: missing.length ? { ...collectionOf(missing, { noun: 'assets', nounOne: 'asset' }), rows: statusRows(missing) } : null });
    }
    // Recurring, worsening or open findings: the fleet analysis (documents read once and cached on the server).
    ui.view = { question, kind: 'Inspection', status: 'loading', title: `Reading inspection documents for ${withDocs.length} ${withDocs.length === 1 ? 'asset' : 'assets'} in the area…`, scope: areaScopeLabel(a) };
    render();
    let fleet = null;
    try { fleet = docTools?.fleet ? await docTools.fleet() : null; } catch (error) { if (mine === askToken) areaView(question, a, { kind: 'Inspection', status: 'error', say: `The inspection documents could not be read: ${error?.message ?? error}` }); return; }
    if (mine !== askToken) return;
    const inArea = new Set(ids);
    const rows = (fleet?.assets ?? []).filter(x => inArea.has(x.assetId));
    const flagged = rows.filter(x => x.recurring?.length || x.worsening);
    areaView(question, a, { kind: 'Inspection',
      say: `${withDocs.length} of the ${equipment.length} assets in the area have linked documents in ACC; ${flagged.length ? `${flagged.length} ${flagged.length === 1 ? 'has' : 'have'} recurring or worsening inspection findings` : 'none has a recurring or worsening finding in its inspection reports'}.`,
      say2: [without.length ? `${without.length} have no linked documents (no findings are assumed for them).` : '', fleet?.failures?.length ? `${fleet.failures.length} documents could not be read.` : ''].filter(Boolean).join(' '),
      extraHtml: fleet && rows.length ? fleetHtml({ ...fleet, assets: rows, withInspections: rows.length, checkedAssets: equipment.filter(id => docsOf(id).length >= 2).length }) : '',
      followUps: [{ label: 'Which require inspection?', question: 'Which assets in this area require inspection?', icon: 'doc' }, { label: 'Missing inspection documents', question: 'Which assets in this area have no linked inspection documents?', icon: 'doc' }] });
    if (flagged.length) areaHighlight(flagged.map(x => x.assetId), question, 'assets');
  }

  /**
   * Route a question while an area is selected. Returns true when it was answered here. Questions about one
   * named asset, versions and reports go their usual way (reports and the simulation take the area along).
   */
  function askArea(question, scopeInfo) {
    const a = ui.area;
    if (!a) return false;
    const intent = areaIntentOf(question);
    const named = namedIds(question, new Set(network.assets.keys()));
    if (intent === 'OUTAGE' || intent === 'VERSIONS') return false;
    if (scopeInfo.scope === 'NEAR') {
      if (!scopeInfo.distanceM) {
        areaView(question, a, { kind: 'Area inventory', say: 'Within what distance of the area?', say2: 'No default distance is configured; name one.',
          followUps: [10, 50, 100].map(d => ({ label: `Within ${d} m`, question: `${question.replace(/\?$/, '')} within ${d} metres of this area`, icon: 'target' })) });
        return true;
      }
      tracked(askAreaNear(question, a, scopeInfo.distanceM));
      return true;
    }
    if (named.length && !scopeInfo.explicit && !(intent === 'SUPPLY' && /\b(supplied|fed|powered)\s+(by|from)\b/i.test(question))) return false;
    if (/\b(these|those|them|they)\b/i.test(question) && /\b(outside|inside|located)\b/i.test(question) && ui.lastAreaSupply?.selectionId === a.selectionId) { askAreaSupplyFollow(question, a); return true; }
    switch (intent) {
      case 'SUPPLY': askAreaSupply(question, a); return true;
      case 'DOWNSTREAM': askAreaDownstream(question, a); return true;
      case 'ALTERNATE': askAreaAlternate(question, a); return true;
      case 'CONSTRUCTION': tracked(askAreaConstruction(question, a)); return true;
      case 'INSPECTION': tracked(askAreaInspection(question, a)); return true;
      case 'STATUS': askAreaStatus(question, a); return true;
      default:
        // Inventory only for questions about assets (a category, "assets", "equipment", "how many").
        if (!categoriesIn(question, spatial()) && !/\b(how many|count|list|show|which|what|any)\b/i.test(question)) return false;
        // Matched only by "what" / "which": Claude reads it first (when on); the inventory answers if it cannot.
        if (llmOn && !viaLlm && isWeakAreaInventory(question, { hasCategory: Boolean(categoriesIn(question, spatial())) })) {
          tracked(interpretAndAsk(question, () => askAreaInventory(question, a, { scope: scopeInfo.scope })));
          return true;
        }
        askAreaInventory(question, a, { scope: scopeInfo.scope });
        return true;
    }
  }
  // Re-resolve a remembered area on this model version (a new version or placement rebuilt the twin).
  if (remembered.area && areaTools) void commitArea(remembered.area.ring, remembered.area.mode, { quiet: true });

  // Esc in Ask the Twin stops the answer in progress (outside the email editor, where it is just a key).
  askHost.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.target.closest?.('.tw-mail.is-edit')) return;
    if (stopAsk()) { event.preventDefault(); event.stopPropagation(); }
  });

  function onClick(event) {
    const t = event.target.closest('button');
    if (!t) return false;
    if (t.dataset.ask) { askHost.querySelector('.isp-bank').hidden = true; askQuestion(t.dataset.ask); return true; }
    // The document review: tabs, citation numbers and its actions change only that answer's own DOM —
    // no request, no re-render, the map and the selection as they are.
    if (t.dataset.reportAct) { void reportAction(t); return true; }
    if (t.dataset.fmt) { format(t); return true; }
    if (t.dataset.chipRemove) {
      const d = draftOf(t.dataset.reportId);
      if (d) { d[t.dataset.chipRemove] = (d[t.dataset.chipRemove] ?? []).filter(x => x !== t.dataset.chipValue); redrawChips(t.closest('.tw-chips'), t.dataset.reportId, t.dataset.chipRemove, { focus: true }); }
      return true;
    }
    if (t.dataset.mailAttRemove || t.dataset.mailAttAdd) {
      const id = t.dataset.reportId;
      const d = draftOf(id);
      if (d) {
        d.attachmentIds = t.dataset.mailAttRemove ? d.attachmentIds.filter(x => x !== t.dataset.mailAttRemove) : [...new Set([...d.attachmentIds, t.dataset.mailAttAdd])];
        void saveDraft(id).then(() => renderReport(id));
      }
      return true;
    }
    if (t.dataset.docTab) { event.preventDefault(); switchReviewTab(t.closest('.tw-rev'), t.dataset.docTab, { open: t.dataset.docOpen ?? null, item: t.dataset.docItem ?? null }); return true; }
    if (t.dataset.refDoc) { event.preventDefault(); showCitation(t); return true; }
    if (t.dataset.act === 'refClose') { t.closest('.tw-cpop')?.remove(); return true; }
    if (t.dataset.act === 'docSimulate') { simulateFromReview(t.dataset.assetId); return true; }
    // A citation: the existing document preview, at the cited page; the conversation stays as it is.
    if (t.dataset.docCite) { onDocument(t.dataset.docCite, { page: Number(t.dataset.docPage) || null }); return true; }
    if (t.dataset.opsStatus) { ui.statusFilter = ui.statusFilter === t.dataset.opsStatus ? null : t.dataset.opsStatus; ui.alertPage = 0; ui.alertPageSize = 8; draw(); if (ui.statusFilter) frame(summary.ids[ui.statusFilter], { pitch: -55, minRange: 400 }); return true; }
    if (t.dataset.opsGroup) { ui.alertGroups[t.dataset.opsGroup] = !ui.alertGroups[t.dataset.opsGroup]; ui.alertPage = 0; ui.alertPageSize = 8; renderOps(); return true; }
    if (t.dataset.opsPage) { ui.alertPage = Math.max(0, ui.alertPage + Number(t.dataset.opsPage)); renderOps({ fit: false }); opsHost.querySelector(`[data-ops-page="${t.dataset.opsPage}"]:not(:disabled)`)?.focus(); return true; }
    if (t.dataset.opsAlert) { selectAsset(t.dataset.opsAlert); frame([t.dataset.opsAlert], { pitch: -50, minRange: 300 }); return true; }
    if (t.dataset.opsInvestigate) { investigateAsset(t.dataset.opsInvestigate); return true; }
    // A change in a comparison answer: that asset, focused on the current map (as any asset row does).
    if (t.dataset.cmpAsset) {
      if (network.assets.has(t.dataset.cmpAsset)) selectAsset(t.dataset.cmpAsset, { zoom: true });
      else if (ui.view && Number(t.closest('.isp-turn')?.dataset.turn) === ui.turn) {
        // Not in the loaded version (removed, for example): said on this answer, nothing else opens.
        ui.view = { ...ui.view, say2: `${t.dataset.cmpAsset} is not in the loaded model version; open the version comparison to see it.` };
        render();
      }
      return true;
    }
    // A set of changes on the current map: highlighted and framed (no comparison screen).
    if (t.dataset.cmpShow !== undefined) {
      const ids = t.dataset.cmpShow.split(',').filter(id => network.assets.has(id));
      if (ids.length) { setAskResults(ids, ui.question, { noun: 'assets' }); render(); frame(ids, { pitch: -55, minRange: 300 }); }
      return true;
    }
    if (t.dataset.cmpOpen && compareTools) {
      const [base, target] = t.dataset.cmpOpen.split(':').map(Number);
      compareTools.open(base, target, { focus: t.dataset.cmpFocus ?? null, ids: t.dataset.cmpIds ? t.dataset.cmpIds.split(',') : null, status: t.dataset.cmpStatus ?? null });
      return true;
    }
    // The maintenance assessment: open one asset from the collection, back to it, focus, all on the map.
    if (t.dataset.maintOpen && ui.maint) { ui.maint.open = t.dataset.maintOpen; renderMaintenance(); if (network.assets.has(ui.maint.open)) { ui.selectedId = ui.maint.open; focusAsset(ui.maint.open, { sound: false }); } return true; }
    if (t.dataset.maintBack && ui.maint) { ui.maint.open = null; clearFocus(); ui.inspector = null; ui.selectedId = null; renderMaintenance(); const ids = ui.maint.assessment.assets.map(a => a.assetId).filter(id => network.assets.has(id)); if (ids.length) { setAskResults(ids, ui.question, { noun: 'assets' }); render(); frame(ids, { pitch: -58, minRange: 300 }); } return true; }
    if (t.dataset.maintFocus) { if (network.assets.has(t.dataset.maintFocus)) { ui.selectedId = t.dataset.maintFocus; focusAsset(t.dataset.maintFocus, { recenter: true }); } return true; }
    if (t.dataset.maintReport && ui.maint) { askQuestion('Generate a maintenance report of these findings'); return true; }
    if (t.dataset.maintAll && ui.maint) { const ids = ui.maint.assessment.assets.map(a => a.assetId).filter(id => network.assets.has(id)); clearFocus(); setAskResults(ids, ui.question, { noun: 'assets' }); render(); frame(ids, { pitch: -58, minRange: 300 }); return true; }
    if (t.dataset.areaShow !== undefined) { const ids = t.dataset.areaShow.split(',').filter(Boolean); if (ids.length) areaHighlight(ids, ui.question, 'assets'); return true; }
    if (t.dataset.areaPath) { highlightAreaSupply(t.dataset.areaPath); return true; }
    if (t.dataset.areaSupplyhl) { highlightAreaSupply(); return true; }
    if (t.dataset.assetTab) { ui.assetTab = t.dataset.assetTab; render(); return true; }
    if (t.dataset.docPreview) { onDocument(t.dataset.docPreview); return true; }
    if (t.dataset.asset) { selectAsset(t.dataset.asset, { zoom: true }); return true; }
    if (t.dataset.scenario) { runScenario(t.dataset.scenario); return true; }
    if (t.dataset.close) { session.setSwitch(t.dataset.close, SWITCH.CLOSED); ui.preset = null; ui.result = null; ui.question = null; ui.selectedId = t.dataset.close; render(); return true; }
    if (t.dataset.path) { show(investigate('UPSTREAM', t.dataset.path, { network, session }), null); return true; }
    if (t.dataset.inv && (ui.inspector ?? ui.selectedId)) { show(investigate(t.dataset.inv, ui.inspector ?? ui.selectedId, { network, session }), null); return true; }
    if (t.dataset.simAsset) { focusAsset(t.dataset.simAsset); return true; }
    if (t.dataset.simTab) { ui.sim.tab = t.dataset.simTab; render(); return true; }
    if (t.dataset.simList) { ui.sim.list = t.dataset.simList; ui.sim.all = false; render(); return true; }
    if (t.dataset.simCircuit) {
      // A feeder: its de-energized cables on the map.
      const cables = simulationOf()?.circuitCables.get(t.dataset.simCircuit) ?? [];
      if (cables.length) { setAskResults(cables, `Circuit ${t.dataset.simCircuit}`); draw(); frame(cables, { pitch: -55, minRange: 300 }); }
      return true;
    }
    if (t.dataset.switch && ui.selectedId) { session.setSwitch(ui.selectedId, t.dataset.switch); ui.preset = null; ui.result = null; render(); return true; }
    switch (t.dataset.act) {
      case 'bank': { const bank = askHost.querySelector('.isp-bank'); bank.hidden = !bank.hidden; t.setAttribute('aria-expanded', String(!bank.hidden)); return true; }
      case 'askCollapse': expandAsk(false); askHost.querySelector('.isp-askp-launcher').focus(); return true;
      case 'askExpand': expandAsk(true); form.q.focus(); return true;
      case 'askWidth': setAskWidth(!askWide); return true;
      case 'areaMenu': openAreaMenu(); return true;
      case 'areaMenuClose': openAreaMenu(false); areaDraw?.cancel(); return true;
      case 'areaDraw': startAreaDraw(t.dataset.mode); return true;
      case 'areaClear': clearArea(); return true;
      case 'areaShow': showArea(); return true;
      case 'areaAssets': askQuestion('Show the assets in this area'); return true;
      case 'netClear': ui.result = null; ui.view = null; ui.selectedId = null; ui.question = null; ui.inspector = null; render(); return true;
      case 'focusRecenter': if (ui.focus) focusAsset(ui.focus.id, { recenter: true, sound: false }); else if (ui.sim) frameSimulation(); return true;
      case 'focusRetry': if (t.dataset.assetId) focusAsset(t.dataset.assetId); return true;
      case 'focusClear': clearFocus(); render(); return true;
      case 'supplyRoute': ui.chainOpen = !ui.chainOpen; draw(); return true;
      case 'relPath': { const ids = (t.dataset.ids ?? '').split(',').filter(id => network.assets.has(id)); if (ids.length) { setAskResults(ids, ui.question); draw(); frame(ids, { pitch: -62, minRange: 260 }); } return true; }
      case 'inspect': if (network.assets.has(t.dataset.assetId)) { ui.inspector = t.dataset.assetId; ui.selectedId = t.dataset.assetId; ui.assetTab = 'overview'; render(); } return true;
      case 'simulateAsset': if (network.assets.has(t.dataset.assetId)) show(investigate('OUTAGE', t.dataset.assetId, { network, session }), null, { newTurn: false }); return true;
      case 'supplyHighlight': {
        const sup = supplyOf(t.dataset.assetId);
        if (sup.primary) { setAskResults(sup.primary.path, `Supply of ${t.dataset.assetId}`, { keep: t.dataset.assetId }); draw(); frame(sup.primary.path, { pitch: -55, minRange: 300 }); }
        return true;
      }
      case 'supplyConnections': ui.inspector = t.dataset.assetId; ui.selectedId = t.dataset.assetId; ui.assetTab = 'connections'; render(); return true;
      case 'focusAsset': if (t.dataset.assetId) focusAsset(t.dataset.assetId, { recenter: true }); return true;
      case 'assetDocs': if (t.dataset.assetId && network.assets.has(t.dataset.assetId)) { ui.inspector = t.dataset.assetId; ui.selectedId = t.dataset.assetId; ui.assetTab = 'documents'; render(); } return true;
      case 'soundOn': case 'soundOff': {
        soundOn = t.dataset.act === 'soundOn';
        try { localStorage.setItem('ifcSpatial.locatorSound', soundOn ? 'on' : 'off'); } catch { /* not remembered */ }
        if (soundOn) locator.play(); else locator.stop();
        renderFocusBar();
        return true;
      }
      case 'fullscreen': {
        const el = askHost.parentElement;
        if (document.fullscreenElement) void document.exitFullscreen?.();
        else void el?.requestFullscreen?.();
        return true;
      }
      case 'answerWide': ui.answerWide = !ui.answerWide; render(); return true;
      case 'askBack': backToResults(); return true;
      case 'askClear': clearAsk(); clearFocus(); ui.inspector = null; if (ui.selectedId && !ui.result && !ui.view) ui.selectedId = null; render(); return true;
      case 'answerFrame': {
        const r = ui.result;
        const ids = r ? [...new Set([...(r.targetAssetIds ?? []), ...(r.cameraTargetAssetIds ?? [])])] : ui.ask?.ids ?? [];
        if (ids.length) frame(ids, { pitch: -55, minRange: 300 });
        return true;
      }
      case 'netReset': endSimulation(); return true;
      case 'simReset': endSimulation(); return true;
      case 'simPanel': if (ui.sim && session.state().active) { ui.sim.inChat = false; render(); frameSimulation(); } return true;
      case 'simOpen': if (ui.sim) { ui.inspector = null; render(); frameSimulation(); } return true;
      case 'simAll': ui.sim.all = !ui.sim.all; render(); return true;
      case 'simView': ui.sim.view = ui.sim.view === 'after' ? 'before' : 'after'; render(); return true;
      case 'assetsClose': onWorkspace('network'); return true;
      case 'unpowered': {
        ui.only = new Set(unpowered);
        onWorkspace('assets');
        draw();
        frame([...unpowered]);
        return true;
      }
      case 'affected': {
        const st = session.state();
        if (st.active) ui.only = new Set([...(st.result.lost ?? []), ...(st.scenario.offline ?? [])]);
        onWorkspace('assets');
        draw();
        return true;
      }
      case 'onlyClear': ui.only = null; draw(); return true;
      case 'opsClear': ui.statusFilter = null; draw(); return true;
      case 'opsCollapse':
        ui.opsCollapsed = !ui.opsCollapsed;
        remembered.opsCollapsed = ui.opsCollapsed;
        applyAlertMarkers();
        // The map follows: alert assets pulse and are named only while the panel is open.
        draw();
        return true;
      case 'resetInvestigation': ui.investigation = null; render(); return true;
      case 'zoomAsset': if (ui.selectedId) frame([ui.selectedId], { pitch: -50, minRange: 420 }); return true;
      default: return false;
    }
  }

  draw();
  return {
    network, built, session, overlay,
    onClick,
    /** A pick on the map: an overlay symbol or route, or a 3D element that belongs to an asset. */
    pick(picked, globalId = null) {
      const id = (focusFx.isOwn(picked) ? ui.focus?.id : null) ?? askHl.idAt(picked) ?? markers.idAt(picked) ?? overlay.assetAt(picked) ?? (globalId ? built.assetByGlobalId.get(globalId)?.id ?? built.structures.get(globalId) : null);
      if (!id) return false;
      if (id.startsWith('fac:')) { askQuestion(`What equipment belongs to ${id.slice(4)}?`); return true; }
      if (id.startsWith('area:')) return true;
      return selectAsset(id);
    },
    selectAsset,
    /** 'network' (the whole network) or 'assets' (the Assets panel; a selection is shown in its context). */
    setWorkspace(ws) { ui.workspace = ws; if (ws === 'network') ui.only = null; draw(); },
    ask: askQuestion,
    runScenario,
    // The whole network obliquely, so the 3D IFC geometry under the overlay reads as 3D.
    // The whole network from above (the opening view and Fit).
    frameAll: () => frame([...network.assets.keys()], { pitch: -85 }),
    /** Nothing selected, focused or highlighted (Reset view); the conversation and a running simulation stay. */
    resetView() { clearFocus(); clearAsk(); ui.inspector = null; ui.investigation = null; if (!ui.sim) ui.selectedId = null; render(); },
    setLayers: layers => overlay.setVisible(layers),
    investigate: investigateAsset,
    /** The asset documentation index (documentsPanel.js); an open asset panel shows its documents. */
    setDocuments(index) { ui.docs = index; if (ui.selectedId && !ui.result && !ui.investigation) render(); },
    setAssetTab(tab) { ui.assetTab = tab; if (ui.selectedId) render(); },
    /** Close an asset or investigation panel (entering the comparison keeps only Ask the Twin answers). */
    clearPanel() { if (!ui.view && !ui.result) { ui.selectedId = null; ui.investigation = null; render(); } },
    markerScreenPosition: id => markers.screenPosition(id),
    opsState: () => ({ summary: { total: summary.total, counts: summary.counts, poweredPct: summary.poweredPct, asOf: summary.asOf },
      alerts: alerts.map(a => ({ id: a.id, status: a.status, severity: a.severity, zone: a.zone })), filter: ui.statusFilter, collapsed: ui.opsCollapsed,
      investigation: ui.investigation && { id: ui.investigation.id, upstream: ui.investigation.upstream, confirmed: ui.investigation.confirmed, potential: ui.investigation.potential },
      markers: markers.state(), statusOf: Object.fromEntries([...statuses].map(([id, x]) => [id, x.status])) }),
    routeInfo: id => overlay.routeInfo(id),
    /** The model's unpowered assets, and the IFC elements that draw them (a crane's steel with its intake). */
    unpowered: () => [...unpowered],
    unpoweredGlobalIds: () => [
      ...[...unpowered].map(id => network.assets.get(id)?.globalId).filter(Boolean),
      ...[...built.structures].filter(([, intake]) => unpowered.has(intake)).map(([globalId]) => globalId),
    ],
    askState: () => ({ ...askHl.state(), ids: ui.ask?.ids ?? [], back: Boolean(ui.ask?.snapshot) }),
    askScreenPosition: id => askHl.screenPosition(id),
    focus: focusAsset,
    simState: () => { const s = ui.sim && simulationOf(); return ui.sim ? { id: ui.sim.id, tab: ui.sim.tab, view: ui.sim.view, consumers: s?.consumers ?? [], potential: s?.potential ?? [], active: session.state().active } : null; },
    supply: id => { const s = supplyOf(id); return { ...s, routes: s.routes.length, alternatives: s.alternatives.length, primary: s.primary && { path: s.primary.path, hops: s.primary.hops, inferred: s.primary.inferred, feedThrough: s.primary.feedThrough } }; },
    topologyReport: () => topologyReport(topo, network, { versionLabel: sourceLabel }),
    focusState: () => ({ id: ui.focus?.id ?? null, state: ui.focus?.state ?? null, inspector: ui.inspector, effects: focusFx.state(), sound: soundOn, bar: !focusBar.hidden }),
    state: () => ({ answer: ui.view && { kind: ui.view.kind, status: ui.view.status, title: ui.view.title },
      sim: ui.sim && session.state().active ? { id: ui.sim.id, tab: ui.sim.tab, view: ui.sim.view, consumers: simulationOf()?.consumers ?? [] } : null, cmp: ui.cmp && { base: ui.cmp.base, target: ui.cmp.target, lastIds: ui.cmp.lastIds?.length ?? 0 }, workspace: ui.workspace, selectedId: ui.selectedId, result: ui.result && { intent: ui.result.intent, title: ui.result.answer.title, status: ui.result.status, targets: ui.result.targetAssetIds },
      area: ui.area ? { selectionId: ui.area.selectionId, selectionType: ui.area.selectionType, zone: ui.area.zone, versionNumber: ui.area.versionNumber, inside: [...ui.area.inside], unknown: ui.area.m.unknown, ring: ui.area.ring } : null,
      areaState: ui.areaState?.kind ?? null, areaDrawing: Boolean(areaDraw?.drawing()),
      plan: ui.lastPlan ? { primaryIntent: ui.lastPlan.primaryIntent, supportingIntents: ui.lastPlan.supportingIntents, target: ui.lastPlan.target, scope: ui.lastPlan.scope.type } : null,
      investigation: ui.lastInvestigation ? { ids: ui.lastInvestigation.ids } : null,
      interpret: { on: llmOn, last: ui.lastInterpret ?? null },
      alertNames: ui.opsCollapsed || session.state().active ? [] : [...alertTone.keys()], askIds: ui.ask?.ids ?? [], askWidth: askWide ? 'expanded' : 'default', report: ui.lastReport ? { id: ui.lastReport, status: ui.reports.get(ui.lastReport)?.data.status ?? null } : null,
      scenario: session.state().active ? session.state().label : null, preset: ui.preset, counts: overlay.counts(), unpowered: [...unpowered],
      nodeStates: Object.fromEntries(networkState(network, session.state().active ? session.state().scenario : null).nodeState) }),
    /** Select Area: drawing in progress (the screen's map clicks are corners, not a selection). */
    areaDrawing: () => Boolean(areaDraw?.drawing()),
    /** Tests / diagnostics: select an area from a ring of [lon, lat] (as if drawn), and screen points of a ring. */
    selectArea: (ring, mode = 'POLYGON') => commitArea(ring, mode),
    areaScreen: ring => ring.map(p => areaDraw?.toScreen(p) ?? null),
    assetLonLat: id => { const x = network.assets.get(id); return Number.isFinite(x?.location?.longitude) ? { lon: x.location.longitude, lat: x.location.latitude } : null; },
    clearArea,
    destroy() { areaDraw?.destroy(); areaHint.remove(); window.removeEventListener('message', onGmailMessage); window.removeEventListener('resize', onOpsResize); overlay.destroy(); markers.destroy(); askHl.destroy(); focusFx.destroy(); locator.stop(); focusBar.remove(); },
  };
}
