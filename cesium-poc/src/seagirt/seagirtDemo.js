/**
 * Seagirt Marine Terminal — Electrical Digital Twin: the page module.
 *
 * Shaped like `i595Demo.js` and `constructionDemo.js`: a module that owns `document.body`, builds
 * its chrome and its map, and exports nothing. One project is open per document load
 * (`projects.js`), so nothing from I-595 or the construction demo — layers, selections, scenarios,
 * chat — can leak in or out: switching project reloads the page.
 *
 * Reused rather than rebuilt: the project registry, the shared Cesium renderer (Esri imagery +
 * terrain), the shared map navigation controls and the theme. The chrome follows PortMiami's: a dark
 * navy workspace rail, a slim header with the active scenario, and floating panels that open only
 * when there is something to show.
 *
 * ONE INVESTIGATION, ONE PANEL. Every question — typed, picked from the question bank, or started
 * from an asset's buttons — produces one validated result (`askSeagirt.js`). The page keeps it as
 * `ui.investigation` and draws it twice from the same view model: on the map and in the single-line
 * diagram. The right-hand panel shows exactly one thing: an asset's details (opened from the map or
 * from a result, with a way back), the impact of the simulated scenario, or the investigation. A new
 * question replaces the investigation and closes any unpinned asset details; a pinned asset stays.
 *
 * The UI state below is the only selection state: the layer, the diagram and the panel read it.
 */
import { Cartesian3, CameraEventType } from 'cesium';
import { CesiumRenderer } from '../renderers/cesium.js';
import { cameraPivot, installMapNavigationControls, zoomRange } from '../mapNavigationControls.js';
import { createThemeMode } from '../themeMode.js';
import { createScenarioSession } from './outageScenario.js';
import { createElectricalLayer } from './electricalLayer.js';
import { compareScenario, energize, getDownstreamAssets, STATE, SWITCH, traceSupplyPath, findAlternativeSupplyPaths, SWITCHING_TYPES, CONSUMER_TYPES } from './electricalGraph.js';
import { anchorsOf, ask, INTENT, investigate, mapPositionOf, validateResult } from './askSeagirt.js';
import { focusOf } from './viewModel.js';
import { assetProvenance, IDENTITY, LOCATION, RECORDS, TOPOLOGY } from './provenance.js';
import { createSingleLine } from './singleLine.js';
import { QUESTION_BANK } from './questionBank.js';
import { iconSvg, typeStyle } from './seagirtIcons.js';
import '../theme.css';
import './seagirt.css';

/** Offered when the Ask box is focused outside the Ask workspace (the bank holds all 30). */
const SUGGESTED = Object.freeze(['What happens if Transformer T1 goes offline?', 'Which transformer supplies power to Crane C1?', 'What equipment is connected downstream of Switchgear S2?']);
const RAIL_KEY = 'seagirt.rail.expanded.v1';

const glyph = d => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const SPARKLE = glyph('<path d="M12 3.5 13.8 9 19.5 10.8 13.8 12.6 12 18.2 10.2 12.6 4.5 10.8 10.2 9z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>');
const PIN = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6l-1 6 3 3H7l3-3z"/><path d="M12 13v7"/></svg>';
const WORKSPACES = Object.freeze([
  { id: 'overview', label: 'Overview', hint: 'The terminal and its major electrical equipment',
    icon: glyph('<path d="M3.5 11 12 4l8.5 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>') },
  { id: 'network', label: 'Electrical Network', hint: 'Every schematic supply link, feeder and its direction',
    icon: glyph('<circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M8.2 7.2 10.6 16M15.8 7.2 13.4 16M8.4 6h7.2"/>') },
  { id: 'singleline', label: 'Single-Line Diagram', hint: 'The electrical topology as a schematic, in step with the map', toggle: true,
    icon: glyph('<path d="M12 3v4M12 11v3M6 14h12M6 14v3M18 14v3M12 14v3"/><circle cx="12" cy="9" r="2"/><rect x="4" y="17" width="4" height="3" rx=".6"/><rect x="10" y="17" width="4" height="3" rx=".6"/><rect x="16" y="17" width="4" height="3" rx=".6"/>') },
  { id: 'assets', label: 'Assets', hint: 'The equipment inventory, its state and records',
    icon: glyph('<path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8z"/><path d="m3.5 12 8.5 4.5 8.5-4.5"/><path d="m3.5 16 8.5 4.5 8.5-4.5"/>') },
  { id: 'ask', label: 'Ask the Twin', hint: 'Questions about assets, connectivity, outages and records', icon: SPARKLE },
  // A separate screen (src/ifcSpatial/), not a workspace of this map: see openScreen below.
  { id: 'ifc-spatial', label: 'IFC Spatial Twin', hint: 'The IFC models from Autodesk Forma, converted and placed on the globe', screen: true,
    icon: glyph('<path d="M12 3.2 20 7.6v8.8L12 20.8 4 16.4V7.6z"/><path d="M4 7.6 12 12l8-4.4M12 12v8.8"/><path d="M8 5.4l8 4.4"/>') },
]);

document.title = 'Seagirt Marine Terminal · Electrical Digital Twin';
const bootLoader = document.querySelector('#i595-boot-loader')?.outerHTML ?? '';
document.body.innerHTML = `${bootLoader}
  <nav class="sg-rail" aria-label="Workspaces">
    <div class="sg-rail-brand">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/></svg>
      <span class="sg-rail-name">SuperDNA<em>3D Lab</em></span>
    </div>
    <ul>${WORKSPACES.map(w => `<li${w.screen ? ' class="sg-rail-screen"' : ''}><button type="button" class="sg-rail-item" data-tab="${w.id}" data-tip="${w.label}" title="${w.hint}"${w.toggle ? ' aria-pressed="false"' : ''}>${w.icon}<span class="sg-rail-label">${w.label}</span></button></li>`).join('')}</ul>
    <button type="button" class="sg-rail-toggle" aria-label="Expand sidebar"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button>
  </nav>
  <header class="sg-top">
    <div class="sg-brand"><b>Seagirt Marine Terminal</b><span>Electrical Digital Twin</span></div>
    <div class="sg-scenario" aria-live="polite"></div>
    <div class="sg-top-end"></div>
  </header>
  <div id="cesiumContainer" aria-label="Seagirt Marine Terminal map"></div>
  <aside class="sg-layers sg-card" aria-label="Map layers">
    <details><summary>Layers</summary>
      <div class="sg-sub">Electrical network</div>
      <label><input type="checkbox" data-feeders> Feeders (schematic segments)</label>
      <div class="sg-sub">Geography</div>
      <label><input type="checkbox" data-layer="boundary" checked> Terminal outline</label>
      <label><input type="checkbox" data-layer="berth" checked> Berth face</label>
      <label><input type="checkbox" data-layer="building" checked> Buildings</label>
      <label><input type="checkbox" data-layer="road"> Terminal roads</label>
      <label><input type="checkbox" data-layer="osmSubstation" checked> Mapped substation (OSM) and its SS1 candidate link</label>
      <small>Geography © OpenStreetMap contributors (ODbL). Outline approximate.</small>
    </details>
  </aside>
  <aside class="sg-assets sg-card" aria-label="Asset inventory" hidden></aside>
  <aside class="sg-sld sg-card" aria-label="Single-line diagram" hidden>
    <header><div><div class="sg-kicker">Single-line diagram</div><small>Schematic topology · not to scale · same state as the map</small></div><button class="sg-close" aria-label="Close single-line diagram">×</button></header>
    <div class="sg-sld-body"></div>
  </aside>
  <aside class="sg-panel sg-card" aria-live="polite" hidden></aside>
  <details class="sg-legend sg-card" open hidden></details>
  <section class="sg-ask" aria-label="Ask the Twin">
    <div class="sg-suggest sg-card" hidden></div>
    <form class="sg-ask-bar sg-card">
      ${SPARKLE}
      <input name="q" autocomplete="off" placeholder="Ask the Twin — about assets, connectivity, outages or records" aria-label="Ask the Twin">
      <button class="sg-send" type="submit" aria-label="Ask"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>
    </form>
  </section>
  <button id="reset-view" type="button">⌖</button>`;
document.body.dataset.project = 'seagirt';

const themeMode = createThemeMode();

const $ = sel => document.querySelector(sel);
const panel = $('.sg-panel'), assetsPane = $('.sg-assets'), sldPane = $('.sg-sld'), legend = $('.sg-legend'), suggest = $('.sg-suggest'),
  pill = $('.sg-scenario'), askInput = $('.sg-ask input');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// ---- the rail: icon-only by default; the choice is remembered per browser ----
const setRail = open => {
  document.body.classList.toggle('sg-rail-open', open);
  $('.sg-rail-toggle').setAttribute('aria-label', open ? 'Collapse sidebar' : 'Expand sidebar');
  try { globalThis.localStorage?.setItem(RAIL_KEY, String(open)); } catch { /* the preference is lost, not the rail */ }
};
let railOpen = false;
try { railOpen = globalThis.localStorage?.getItem(RAIL_KEY) === 'true'; } catch { /* starts collapsed */ }
setRail(railOpen);
$('.sg-rail-toggle').onclick = () => setRail(!document.body.classList.contains('sg-rail-open'));

const load = path => fetch(`${import.meta.env.BASE_URL}data/seagirt/${path}`).then(r => (r.ok ? r.json() : Promise.reject(new Error(`${path}: HTTP ${r.status}`))));
const [geography, assetFile, edgeFile, inspectionFile, associationFile] = await Promise.all(
  ['terminal-geography.geojson', 'electrical-assets.json', 'electrical-connectivity.json', 'inspections.json', 'gis-associations.json'].map(load));
const inspections = inspectionFile.records;
const associations = associationFile.associations;

const renderer = new CesiumRenderer();
const viewer = await renderer.init('cesiumContainer', { ionToken: import.meta.env.VITE_CESIUM_ION_TOKEN });
viewer.animation.container.style.display = 'none';
viewer.timeline.container.style.display = 'none';
viewer.forceResize();
const controller = viewer.scene.screenSpaceCameraController;
controller.minimumZoomDistance = 30;
controller.maximumZoomDistance = 60000;
controller.zoomEventTypes = [CameraEventType.RIGHT_DRAG, CameraEventType.PINCH];
const zoom = factor => {
  viewer.camera.cancelFlight();
  const pivot = cameraPivot(viewer);
  const range = Cartesian3.distance(viewer.camera.positionWC, pivot);
  viewer.camera.zoomIn(range - zoomRange(range, factor, controller.minimumZoomDistance, controller.maximumZoomDistance));
  viewer.scene.requestRender();
};
viewer.canvas.addEventListener('wheel', event => {
  event.preventDefault();
  zoom(Math.exp(Math.max(-0.4, Math.min(0.4, event.deltaY * 0.002))));
}, { passive: false });

// ---- the model: registry + connectivity + a scenario session that never writes either ----
let layer = null;
const session = createScenarioSession({ assets: assetFile.assets, edges: edgeFile.edges }, {
  onChange: state => layer?.setScenario(state.active ? state.result : null),
});
const network = session.network;
const baseline = energize(network);
const scenario = () => (session.state().active ? session.state() : null);

/** The only selection state on the page. */
const ui = {
  tab: 'overview',
  investigation: null,   // the current validated result (askSeagirt contract)
  selectedId: null,      // the asset whose details are open
  pinnedId: null,        // an asset kept in view across questions
  association: null,     // the asset whose GIS association is open
  geography: null,       // a plain map feature's properties
  sldOpen: false,
  feedersLayer: false,
};

layer = createElectricalLayer(viewer, { geography, network, associations, reducedMotion,
  onSelect: pick => {
    if (pick?.assetId) return openDetails(pick.assetId);
    if (pick?.association) return openAssociation(pick.association);
    if (pick?.geography) {
      const a = associations.find(x => x.geographicFeatureId === pick.geography.featureId);
      return a ? openAssociation(a.electricalAssetId) : openGeography(pick.geography);
    }
    if (ui.selectedId || ui.association || ui.geography) closeDetails();
  } });
const sld = createSingleLine($('.sg-sld-body'), { network, reducedMotion, onSelect: id => openDetails(id) });
// The map controls sit in the header, so the bottom of the map is left to Ask the Twin.
const navigation = installMapNavigationControls($('.sg-top-end'), viewer, { zoom, themeMode, onToggleTheme: () => themeMode.toggle?.() });
for (const input of document.querySelectorAll('[data-layer]')) {
  layer.setLayerVisible(input.dataset.layer, input.checked);
  input.onchange = () => layer.setLayerVisible(input.dataset.layer, input.checked);
}
$('[data-feeders]').onchange = e => { ui.feedersLayer = e.target.checked; sync(); };

/** How much of the map each open panel covers, so the camera frames what is left visible. */
const insets = () => ({
  right: panel.hidden ? 0 : panel.offsetWidth + 32,
  left: (assetsPane.hidden ? 0 : assetsPane.offsetWidth + 32) + (sldPane.hidden ? 0 : sldPane.offsetWidth + 32),
  top: 0,
  bottom: 96,
});
$('#reset-view').onclick = () => layer.flyHome({ insets: insets() });
layer.flyHome({ duration: 0 });
const bootingIfc = new URLSearchParams(location.search).get('screen') === 'ifc-spatial';
if (!bootingIfc) document.querySelector('#i595-boot-loader')?.remove();

// ---- shared bits ----
const nameOf = id => network.assets.get(id)?.name ?? id;
const typeOf = id => network.assets.get(id)?.assetType;
const typeText = t => t.replaceAll('_', ' ').toLowerCase();
const typeLabel = t => typeStyle(t).label;
const fmtV = v => (v?.value === null || v?.value === undefined ? null : `${v.value} ${v.unit ?? ''}`.trim());
const listText = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const nodeState = id => (scenario() ? scenario().result.after.nodes : baseline.nodes).get(id);
const STATE_CHIP = {
  [STATE.ENERGIZED]: ['is-ok', 'Energized'], [STATE.DE_ENERGIZED]: ['is-lost', 'No power'], [STATE.OFFLINE]: ['is-lost', 'Offline'], [STATE.UNKNOWN]: ['is-unknown', 'Unknown'],
};
const stateChip = id => { const [cls, text] = STATE_CHIP[nodeState(id)] ?? ['', 'Not evaluated']; return `<span class="sg-state ${cls}">${esc(text)}</span>`; };
const stateDot = id => { const s = nodeState(id); return `<span class="sg-dot ${s === STATE.ENERGIZED ? 'is-ok' : s === STATE.UNKNOWN ? 'is-unknown' : s ? 'is-lost' : ''}" aria-hidden="true"></span>`; };
/** A clickable asset: its icon and name (or id only, in a long group). */
const assetChip = (id, { short = false } = {}) => `<button type="button" class="sg-chip" data-asset="${esc(id)}" title="${esc(nameOf(id))}">${stateDot(id)}${iconSvg(typeOf(id), 15)}<span>${esc(short ? id : nameOf(id))}</span></button>`;

function setPanelVars() {
  // Labels stay out from under the panels (16 px of the inset is the gap beside each panel).
  const i = insets();
  layer.setOcclusion({ left: Math.max(0, i.left - 16), right: Math.max(0, i.right - 16), bottom: 72 });
  document.body.style.setProperty('--sg-panel-w', `${panel.hidden ? 0 : panel.offsetWidth + 32}px`);
  document.body.style.setProperty('--sg-dock-w', `${!assetsPane.hidden ? assetsPane.offsetWidth + 16 : !sldPane.hidden ? sldPane.offsetWidth + 16 : 0}px`);
}

/** Draw everything from the UI state: the map and the diagram from one view model, then the panels. */
function sync() {
  const model = layer.setView({ mode: ui.tab === 'network' ? 'network' : ui.tab === 'assets' ? 'assets' : 'overview', feedersLayer: ui.feedersLayer,
    selectedId: ui.selectedId, pinnedId: ui.pinnedId, focus: focusOf(ui.investigation) });
  if (ui.sldOpen) sld.render(model);
  renderPanel();
  renderPill();
  renderAssetList();
  renderLegend();
  setPanelVars();
}

/** Frame what a result is about, once, when it arrives. */
function frameResult(r) {
  const ids = r.cameraTargetAssetIds;
  if (!ids.length) return;
  const one = ids.length === 1;
  const outage = r.visualization.mode === 'OUTAGE';
  layer.flyToAssets(ids, { insets: insets(), rangeScale: one ? 1 : outage ? 2.1 : 1.7, minRange: outage ? 900 : one ? 650 : 520 });
}

/** Show a result: it replaces the investigation and any unpinned details; the map follows it. */
function applyResult(raw, { fly = true } = {}) {
  const { result } = validateResult(raw, network);
  ui.investigation = result.intent === INTENT.RESET ? null : result;
  ui.selectedId = null;
  ui.association = null;
  ui.geography = null;
  sync();
  // Closing a tie inside the same outage keeps the camera where it is.
  if (fly && result.intent !== INTENT.SWITCH) frameResult(result);
}

/** Open an asset's details without leaving the investigation; fly only if it is not already in view. */
function openDetails(id) {
  if (!network.assets.has(id)) return;
  ui.selectedId = id;
  ui.association = null;
  ui.geography = null;
  sync();
  const anchors = anchorsOf(network, id);
  if (anchors.length && !layer.isVisible(typeOf(id) === 'FEEDER' ? [id] : anchors, insets())) layer.flyToAssets(typeOf(id) === 'FEEDER' ? [...anchors, id] : anchors, { insets: insets() });
}
function closeDetails() {
  ui.selectedId = null;
  ui.association = null;
  ui.geography = null;
  sync();
}
function openAssociation(assetId) {
  ui.association = assetId;
  ui.selectedId = null;
  ui.geography = null;
  sync();
  const a = associations.find(x => x.electricalAssetId === assetId);
  const pts = [assetId];
  if (a && !layer.isVisible(pts, insets())) layer.flyToAssets(pts, { insets: insets(), minRange: 700 });
}
function openGeography(p) {
  ui.geography = p;
  ui.selectedId = null;
  ui.association = null;
  sync();
}

// ---- the panel: exactly one of association, map feature, asset details, scenario impact, investigation ----
const MODE_KICKER = { ASSET: 'Asset', GROUP: 'Asset group', PATH: 'Supply path', DOWNSTREAM: 'Downstream network', ALTERNATE: 'Alternative supply',
  MAINTENANCE: 'Condition & maintenance', LIMITATION: 'Engineering question', OUTAGE: 'Simulated outage', NONE: 'Ask the Twin' };
const STATUS_BADGE = { NO_RESULTS: ['is-neutral', 'No matching assets'], DATA_UNAVAILABLE: ['is-warn', 'Data not available'], LIMITED: ['is-warn', 'Cannot be calculated from the model'],
  NOT_FOUND: ['is-bad', 'Not in the inventory'], UNSUPPORTED: ['is-neutral', 'Not supported'], NEEDS_SUBJECT: ['is-neutral', 'Needs an asset'] };

function renderPanel() {
  const sc = scenario();
  const kind = ui.association ? 'association' : ui.geography ? 'geography' : ui.selectedId ? 'asset' : sc ? 'impact' : ui.investigation ? 'result' : null;
  panel.hidden = !kind;
  panel.dataset.kind = kind ?? '';
  panel.classList.toggle('sg-impact', kind === 'impact');
  if (!kind) { panel.innerHTML = ''; return; }
  const back = ['asset', 'association', 'geography'].includes(kind) && (sc || ui.investigation)
    ? `<button type="button" class="sg-back" data-act="back">← ${esc(sc ? scenarioTitle(sc.scenario) : ui.investigation.answer.title)}</button>` : '';
  const pinned = ui.pinnedId && ui.pinnedId !== ui.selectedId
    ? `<div class="sg-pinned">${PIN}<span>Pinned</span><button type="button" class="sg-link" data-asset="${esc(ui.pinnedId)}">${esc(nameOf(ui.pinnedId))}</button><button type="button" class="sg-close" data-act="unpin" aria-label="Unpin">×</button></div>` : '';
  const body = kind === 'association' ? associationHtml(ui.association) : kind === 'geography' ? geographyHtml(ui.geography)
    : kind === 'asset' ? assetHtml(ui.selectedId) : kind === 'impact' ? impactHtml(sc) : resultHtml(ui.investigation);
  panel.innerHTML = `${pinned}${back}${body}`;
  wirePanel(kind);
}

function wirePanel(kind) {
  const on = (sel, fn) => { for (const b of panel.querySelectorAll(sel)) b.addEventListener('click', fn); };
  on('[data-asset]', e => openDetails(e.currentTarget.dataset.asset));
  on('[data-q]', e => runQuestion(e.currentTarget.dataset.q));
  on('[data-act="back"]', () => closeDetails());
  on('[data-act="unpin"]', () => { ui.pinnedId = null; sync(); });
  on('[data-act="pin"]', () => { ui.pinnedId = ui.pinnedId === ui.selectedId ? null : ui.selectedId; sync(); });
  on('[data-act="sld"]', () => toggleSld(true));
  on('[data-act="frame"]', () => ui.investigation && frameResult(ui.investigation));
  on('[data-inv]', e => applyResult(investigate(e.currentTarget.dataset.inv, e.currentTarget.dataset.id, deps())));
  on('[data-act="association"]', e => openAssociation(e.currentTarget.dataset.id));
  on('[data-act="reset"]', resetScenario);
  on('[data-tie]', e => runQuestion(`Close ${e.currentTarget.dataset.tie}`));
  const close = panel.querySelector(':scope > header .sg-close, :scope > .sg-head .sg-close');
  close?.addEventListener('click', () => {
    if (kind === 'impact') resetScenario();
    else if (kind === 'result') { ui.investigation = null; sync(); }
    else closeDetails();
  });
  const anchor = panel.querySelector('[data-act="anchor"]');
  if (anchor) anchor.onchange = e => {
    const a = associations.find(x => x.electricalAssetId === ui.association);
    layer.setAnchor(a.electricalAssetId, e.target.checked ? [a.anchor.longitude, a.anchor.latitude] : null);
    sync();
  };
  if (kind === 'impact') wireImpact();
}

const head = ({ kicker, kickerClass = '', title, icon = '', question = '' }) => `<header>${icon ? `<span class="sg-hicon">${icon}</span>` : ''}<div>${question ? `<div class="sg-q">${esc(question)}</div>` : ''}<div class="sg-kicker ${kickerClass}">${kicker}</div><h2>${esc(title)}</h2></div><button class="sg-close" aria-label="Close">×</button></header>`;

/** One path as steps: each component clickable, with its type and state — breakers and feeders included. */
function stepsHtml(p, ties = []) {
  const caption = p.style === 'alternate' ? `Alternate path${ties.length ? ` — needs ${esc(listText(ties))} closed` : ''}` : p.style === 'restored' ? 'Restored path (simulated)' : 'Supply path · direction of supply ↓';
  return `<div class="sg-steps-head">${caption}</div><ol class="sg-steps is-${esc(p.style)}">${p.assetIds.map(id => `<li><button type="button" data-asset="${esc(id)}" class="${Number.isFinite(network.assets.get(id)?.location?.longitude) ? '' : 'is-minor'}">
    ${iconSvg(typeOf(id), 15)}<b>${esc(id)}</b><span>${esc(typeLabel(typeOf(id)))}</span>${stateDot(id)}</button></li>`).join('')}</ol>`;
}
function groupHtml(g) {
  const short = g.assetIds.length > 6;
  return `<div class="sg-group tone-${esc(g.tone)}"><div class="sg-group-head"><span>${esc(g.label)}</span><b>${g.assetIds.length}</b></div>
    ${g.assetIds.length ? `<div class="sg-chips">${g.assetIds.map(id => assetChip(id, { short })).join('')}</div>` : '<div class="sg-none">None</div>'}
    ${g.note ? `<div class="sg-group-note">${esc(g.note)}</div>` : ''}</div>`;
}
const provLine = p => (p ? `Identity ${IDENTITY[p.identity]?.toLowerCase() ?? '—'} · location ${LOCATION[p.location]?.toLowerCase() ?? '—'} · topology ${TOPOLOGY[p.topology]?.toLowerCase() ?? '—'} · records ${RECORDS[p.records]?.toLowerCase() ?? '—'}` : '');

function resultHtml(r) {
  const A = r.answer;
  const badge = STATUS_BADGE[r.status];
  const pathText = r.paths[0]?.assetIds.join(' → ');
  const lines = A.lines.filter(l => l !== pathText && !l.startsWith('Path: ') && !(r.paths.length && /^(Normal|Alternate): /.test(l)));
  const ties = r.conditionalAssetIds.filter(id => SWITCHING_TYPES.has(typeOf(id)));
  const steps = r.paths.length && r.paths.length <= 2 ? r.paths.map(p => stepsHtml(p, p.style === 'alternate' ? ties : [])).join('') : '';
  return `${head({ kicker: MODE_KICKER[r.visualization.mode] ?? 'Ask the Twin', title: A.title, question: r.question })}
    ${badge ? `<div class="sg-status ${badge[0]}">${esc(badge[1])}</div>` : ''}
    ${A.summary ? `<p class="sg-summary">${esc(A.summary)}</p>` : ''}
    ${steps}
    ${r.resultGroups.map(groupHtml).join('')}
    ${A.determinable.length ? `<div class="sg-sub">What the model can tell</div><ul class="sg-bullets">${A.determinable.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
    ${A.missingInputs.length ? `<div class="sg-sub">Inputs needed to calculate it</div><ul class="sg-bullets is-missing">${A.missingInputs.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
    ${lines.length ? `<ul class="sg-bullets">${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
    ${A.explanation ? `<p class="sg-reason">${esc(A.explanation)}</p>` : ''}
    <div class="sg-actions">
      ${A.followUps.map(f => `<button class="sg-btn is-primary" data-q="${esc(f.question)}">${esc(f.label)}</button>`).join('')}
      ${r.primaryAssetId && ['ASSET', 'MAINTENANCE', 'LIMITATION'].includes(r.visualization.mode) ? `<button class="sg-btn is-primary" data-asset="${esc(r.primaryAssetId)}">Open ${esc(r.primaryAssetId)} details</button>` : ''}
      ${r.targetAssetIds.filter(id => associations.some(a => a.electricalAssetId === id)).map(id => `<button class="sg-btn" data-act="association" data-id="${esc(id)}">Inspect ${esc(id)} GIS association</button>`).join('')}
      ${r.cameraTargetAssetIds.length ? '<button class="sg-btn" data-act="frame">Show on map</button>' : ''}
      ${r.targetAssetIds.length || r.paths.length ? '<button class="sg-btn" data-act="sld">Single-line view</button>' : ''}
    </div>
    ${r.provenance ? `<p class="sg-note sg-provline">${esc(provLine(r.provenance))}</p>` : ''}
    ${A.limitations.length ? `<details class="sg-fold sg-limits"><summary>Limitations</summary><ul class="sg-list">${A.limitations.map(l => `<li>${esc(l)}</li>`).join('')}</ul></details>` : ''}`;
}

// ---- asset details ----
function assetHtml(id) {
  const a = network.assets.get(id);
  const pos = mapPositionOf(network, a.id);
  const prov = assetProvenance(a, { associations, records: inspections });
  const children = [...network.assets.values()].filter(x => x.location?.containerAssetId === a.id);
  const downstream = getDownstreamAssets(network, a.id);
  const consumers = downstream.filter(d => CONSUMER_TYPES.has(typeOf(d.assetId)));
  const records = inspections.filter(r => r.assetId === a.id).sort((x, y) => y.date.localeCompare(x.date));
  const switching = SWITCHING_TYPES.has(a.assetType);
  const feeder = a.assetType === 'FEEDER';
  const voltage = a.voltage ? [fmtV(a.voltage.primary), fmtV(a.voltage.secondary)].filter(Boolean).join(' / ') : null;
  const rows = (...pairs) => pairs.filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');
  const link = x => `<button class="sg-link" data-asset="${esc(x)}">${esc(x)}</button>`;
  const anchored = layer.anchorOf(a.id);
  const feeds = x => getDownstreamAssets(network, x).filter(d => CONSUMER_TYPES.has(typeOf(d.assetId))).map(d => d.assetId);
  let electrical, extra = '', actions;
  if (feeder) {
    const up = traceSupplyPath(network, a.id).path.slice(0, -1);
    const breaker = a.parentAssetId;
    const b = network.assets.get(breaker);
    const loads = feeds(a.id);
    electrical = rows(
      ['Feeder', esc(a.id)],
      ['Breaker', breaker ? `${link(breaker)}${b?.location?.cubicle ? ` · cubicle ${esc(b.location.cubicle)}` : ''}` : ''],
      ['Upstream', up.slice().reverse().map(link).join(' ← ')],
      ['Downstream loads', loads.map(link).join(', ') || '—'],
      ['Voltage', voltage && esc(voltage)],
      ['Rated capacity', fmtV(a.rating) ? esc(fmtV(a.rating)) : 'Not recorded'],
      ['Normal switching', b ? esc(`${b.id} normally ${(b.normalState ?? 'CLOSED').toLowerCase()}${b.normalState === 'OPEN' ? ` — ${a.id} is de-energized unless ${b.id} is closed` : ''}`) : ''],
      ['Geometry', 'Schematic segment — no cable route recorded'],
    );
    extra = `<div class="sg-sub">Inspection &amp; maintenance</div><p class="sg-note">No feeder inspection or cable test record is in the inventory.</p>`;
    actions = `<button class="sg-btn is-primary" data-inv="UPSTREAM" data-id="${esc(a.id)}">Trace Upstream</button>
      <button class="sg-btn" data-inv="DOWNSTREAM" data-id="${esc(a.id)}">Trace Downstream</button>
      <button class="sg-btn" data-inv="LOADS" data-id="${esc(a.id)}">Highlight Connected Loads</button>
      <button class="sg-btn is-danger" data-inv="OUTAGE" data-id="${esc(a.id)}">Simulate Disconnection</button>`;
  } else {
    electrical = rows(
      ['Supplied from', a.parentAssetId ? `<button class="sg-link" data-asset="${esc(a.parentAssetId)}">${esc(nameOf(a.parentAssetId))}</button>` : ''],
      ['Voltage', voltage && esc(voltage)],
      ['Rating', fmtV(a.rating) && esc(fmtV(a.rating))],
      ['Normal state', switching && esc((a.normalState ?? 'CLOSED').toLowerCase())],
      ['Position', anchored ? 'Shown at the candidate OSM footprint (display anchor; registry position unchanged)'
        : pos?.own ? 'Illustrative map position' : pos ? `Inside ${esc(nameOf(pos.via))}${a.location?.cubicle ? `, cubicle ${esc(a.location.cubicle)}` : ''}` : 'Not recorded'],
    );
    actions = `<button class="sg-btn is-primary" data-inv="CONNECTIONS" data-id="${esc(a.id)}">View Connections</button>
      ${a.assetType === 'UTILITY_SUPPLY' ? '' : switching
    ? `<button class="sg-btn is-danger" data-q="${esc(a.normalState === 'OPEN' ? `Close ${a.id}` : `What happens if ${a.id} is opened?`)}">Simulate ${a.normalState === 'OPEN' ? 'closing' : 'opening'}</button>`
    : `<button class="sg-btn is-danger" data-inv="OUTAGE" data-id="${esc(a.id)}">Simulate Outage</button>`}`;
  }
  const maintenance = rows(
    ['Record status', a.operationalStatus && esc(typeText(a.operationalStatus))],
    ['Last inspection', a.lastInspectionDate && esc(a.lastInspectionDate)],
    ['Next inspection', a.nextInspectionDate && esc(`${a.nextInspectionDate}${a.nextInspectionDate < new Date().toISOString().slice(0, 10) ? ' · overdue' : ''}`)],
  );
  const assoc = prov.association;
  return `${head({ kicker: `${esc(typeLabel(a.assetType))} · ${esc(a.id)}`, title: a.name, icon: iconSvg(a.assetType, 22) })}
    <div class="sg-chiprow">${stateChip(a.id)}<span class="sg-cond sg-cond-${esc(a.condition)}">Condition: ${esc(a.condition.toLowerCase())}</span>
      <button type="button" class="sg-pin${ui.pinnedId === a.id ? ' is-on' : ''}" data-act="pin" aria-pressed="${ui.pinnedId === a.id}" title="Keep this asset in view across questions">${PIN}${ui.pinnedId === a.id ? 'Pinned' : 'Pin'}</button></div>
    <div class="sg-actions">${actions}</div>
    <div class="sg-sub">Electrical</div><dl class="sg-dl">${electrical}</dl>
    ${children.length ? `<div class="sg-sub">Internal breakers (${children.length})</div>
      <table class="sg-breakers"><thead><tr><th>Cubicle</th><th>Breaker</th><th>Normal</th><th>Feeder</th><th>Feeds</th></tr></thead><tbody>${children.map(c => `<tr>
        <td>${esc(c.location.cubicle ?? '—')}</td><td>${link(c.id)}</td>
        <td><span class="sg-dot ${c.normalState === 'OPEN' ? 'is-open' : 'is-ok'}"></span>${esc((c.normalState ?? 'CLOSED').toLowerCase())}</td>
        <td>${(network.out.get(c.id) ?? []).map(e => e.toAssetId).filter(x => typeOf(x) === 'FEEDER').map(link).join(', ') || '—'}</td>
        <td>${feeds(c.id).map(link).join(', ') || '—'}</td></tr>`).join('')}</tbody></table>` : ''}
    ${assoc ? `<div class="sg-sub">Geographic association</div><div class="sg-assoc-mini"><span class="sg-prov">Candidate · unverified</span>
      <span>Mapped OSM substation ${esc(assoc.osmId)}, ${esc(assoc.distanceM)} m from this illustrative position.</span>
      <button class="sg-btn" data-act="association" data-id="${esc(a.id)}">Inspect association</button></div>` : ''}
    ${extra}
    ${maintenance ? `<div class="sg-sub">Maintenance</div><dl class="sg-dl">${maintenance}</dl>` : ''}
    ${a.conditionNote ? `<p class="sg-reason">${esc(a.conditionNote)}</p>` : ''}
    ${consumers.length && !feeder ? `<details class="sg-fold"><summary>Connected consumers (${consumers.length})</summary><ul class="sg-list">${consumers.map(d => `<li><span class="sg-dot ${d.viaNormallyOpen ? 'is-open' : 'is-ok'}"></span><button class="sg-link" data-asset="${esc(d.assetId)}">${esc(nameOf(d.assetId))}</button>${d.viaNormallyOpen ? '<small>only via a normally-open tie</small>' : ''}</li>`).join('')}</ul></details>` : ''}
    ${records.length ? `<details class="sg-fold"><summary>Inspection history (${records.length})</summary><ul class="sg-list">${records.map(r => `<li><span>${esc(r.date)}</span><span>${esc(r.type)} — ${esc(r.result.replaceAll('_', ' ').toLowerCase())}</span></li>`).join('')}</ul></details>` : ''}
    <div class="sg-sub">Data confidence</div>
    <dl class="sg-dl sg-provdl"><dt>Identity</dt><dd>${esc(IDENTITY[prov.identity])}</dd><dt>Location</dt><dd>${esc(LOCATION[prov.location])}</dd>
      <dt>Topology</dt><dd>${esc(TOPOLOGY[prov.topology])}</dd><dt>Condition &amp; records</dt><dd>${esc(RECORDS[prov.records])}</dd></dl>
    <p class="sg-note">${esc(prov.locationNote)} Not Seagirt equipment or maintenance data.</p>`;
}

// ---- GIS association: the electrical record and the public feature, side by side, never merged ----
function associationHtml(assetId) {
  const a = associations.find(x => x.electricalAssetId === assetId);
  const asset = network.assets.get(assetId);
  const tags = Object.entries(a.osmTags ?? {}).map(([k, v]) => `${k}=${v}`).join(', ');
  return `${head({ kicker: 'GIS association · candidate', title: `${asset.name} ↔ mapped OSM substation`, icon: iconSvg(asset.assetType, 22) })}
    <div class="sg-chiprow"><span class="sg-status is-warn">${esc(a.associationStatus)} · not verified</span></div>
    <div class="sg-pair">
      <div><div class="sg-sub">Electrical asset</div><dl class="sg-dl is-stack"><dt>Record</dt><dd><button class="sg-link" data-asset="${esc(assetId)}">${esc(asset.name)}</button></dd>
        <dt>Identity</dt><dd>Illustrative</dd><dt>Topology</dt><dd>${esc(a.topologyConfidence.toLowerCase())}</dd><dt>Position</dt><dd>Illustrative</dd></dl></div>
      <div><div class="sg-sub">Geographic feature</div><dl class="sg-dl is-stack"><dt>Source</dt><dd>${esc(a.geographicSource)} ${esc(a.osmId)}</dd>
        <dt>Tags</dt><dd>${esc(tags)}</dd><dt>Footprint</dt><dd>${esc(a.footprintM.eastWest)} × ${esc(a.footprintM.northSouth)} m</dd><dt>Geometry</dt><dd>Publicly mapped (ODbL)</dd></dl></div>
    </div>
    <div class="sg-sub">Why it may be ${esc(assetId)}</div><ul class="sg-bullets is-ok">${a.evidence.map(e => `<li>${esc(e)}</li>`).join('')}</ul>
    <div class="sg-sub">Why it is not verified</div><ul class="sg-bullets is-missing">${a.missingEvidence.map(e => `<li>${esc(e)}</li>`).join('')}</ul>
    <label class="sg-toggle"><input type="checkbox" data-act="anchor"${layer.anchorOf(assetId) ? ' checked' : ''}> Show ${esc(assetId)} at the mapped footprint (demonstration display anchor)</label>
    <p class="sg-note">${esc(a.note)}</p>`;
}
function geographyHtml(p) {
  return `${head({ kicker: 'Map feature', title: p.name ?? (p.layer === 'building' ? 'Building' : p.layer === 'road' ? 'Terminal road' : 'Feature') })}
    <dl class="sg-dl"><dt>Source</dt><dd>${esc(p.source ?? '—')}${p.osmId ? ` · ${esc(p.osmId)}` : ''}</dd><dt>Licence</dt><dd>${esc(p.licence ?? '—')}</dd><dt>Location</dt><dd>Public GIS</dd></dl>
    ${p.note ? `<p class="sg-note">${esc(p.note)}</p>` : ''}`;
}

// ---- the impact panel: the single place a simulated outage's numbers appear ----
/** Split a scenario into what failed (offline, breakers opened) and modelled actions (ties closed). */
function scenarioParts(sc) {
  const switches = Object.entries(sc.switches ?? {});
  const opened = switches.filter(([, s]) => s === SWITCH.OPEN).map(([id]) => id);
  const closed = switches.filter(([, s]) => s === SWITCH.CLOSED).map(([id]) => id);
  return { failed: [...sc.offline, ...opened], opened, closed };
}
function scenarioTitle(sc) {
  const { failed, closed } = scenarioParts(sc);
  if (failed.length) return failed.map(id => `${nameOf(id)} — ${sc.offline.includes(id) ? (typeOf(id) === 'FEEDER' ? 'Disconnected' : 'Offline') : 'Opened'}`).join(' · ');
  return closed.map(id => `${nameOf(id)} — Closed`).join(' · ');
}
let impact = null;   // what the impact panel's buttons act on
function impactHtml(state) {
  const { result: r, scenario: sc, limitations } = state;
  const { failed, closed } = scenarioParts(sc);
  // With a tie closed, compare against the same failure with the tie left alone: what it changed.
  const outageOnly = closed.length && failed.length
    ? compareScenario(network, Object.freeze({ ...sc, switches: Object.freeze(Object.fromEntries(Object.entries(sc.switches).filter(([id]) => !closed.includes(id)))) }))
    : null;
  const restored = outageOnly ? outageOnly.consumersLost.filter(id => !r.consumersLost.includes(id)) : [];
  const viaTransformer = id => traceSupplyPath(network, id, { scenario: sc }).path.find(x => typeOf(x) === 'TRANSFORMER');
  // Normally-open devices that could restore a consumer, offered as a scenario step (never advice).
  const alternates = r.consumersLost.flatMap(id => findAlternativeSupplyPaths(network, id, sc)
    .filter(p => !p.blocked.length && p.needsClosing.length).map(p => ({ id, ties: p.needsClosing, transformers: p.transformers })));
  const ties = [...new Set(alternates.flatMap(a => a.ties))];
  const causes = [...new Set(r.consumersLost.flatMap(id => traceSupplyPath(network, id).path.filter(x => failed.includes(x))))];
  const lostNames = r.consumersLost.map(nameOf);
  const rerouted = r.rerouted.length ? `${listText(r.rerouted.map(nameOf))} ${r.rerouted.length > 1 ? 'are' : 'is'} supplied through an alternate path. ` : '';
  const why = r.consumersLost.length
    ? `${rerouted}${listText(lostNames)} ${r.consumersLost.length > 1 ? 'are' : 'is'} normally supplied through ${listText(causes.map(nameOf)) || 'the failed equipment'}, and no energized alternative supply path reaches ${r.rerouted.length ? lostNames.join(' or ') : r.consumersLost.length > 1 ? 'them' : 'it'} in this scenario.`
      + `${ties.length ? ` ${listText(ties.map(nameOf))} ${ties.length > 1 ? 'are' : 'is'} normally open and could connect ${listText([...new Set(alternates.filter(a => a.ties.some(t => ties.includes(t))).map(a => nameOf(a.id)))])} to ${listText([...new Set(alternates.flatMap(a => a.transformers))].map(nameOf))}; the model does not close ${ties.length > 1 ? 'them' : 'it'} unless you simulate it.` : ''}`
    : `${rerouted}Every consumer still has an energized supply path.`;
  // The question that ran this scenario, when it asked for something specific (categories, a transfer).
  const inv = ui.investigation?.visualization.mode === 'OUTAGE' ? ui.investigation : null;
  const specific = inv && (inv.intent === INTENT.TRANSFER || inv.resultGroups.some(g => 'count' in g) || /^(No cranes|Crane )/.test(inv.answer.title));
  const equipment = [...r.offline, ...r.deEnergized.filter(id => !CONSUMER_TYPES.has(typeOf(id)))];
  impact = { r, restored, ties: ties.filter(t => !closed.includes(t)) };
  return `${head({ kicker: 'Simulated outage · not the live state', kickerClass: 'is-bad', title: scenarioTitle(sc), question: inv?.question })}
    ${closed.length && failed.length ? `<p class="sg-modelled">Modelled action: ${esc(listText(closed.map(id => `${nameOf(id)} closed`)))}</p>` : ''}
    ${specific ? `<p class="sg-answer-title">${esc(inv.answer.title)}</p>${inv.resultGroups.filter(g => g.key !== 'powered').map(groupHtml).join('')}` : `
    <div class="sg-count ${r.consumersLost.length ? 'is-bad' : 'is-ok'}"><b>${r.consumersLost.length}</b><span>consumer${r.consumersLost.length === 1 ? '' : 's'} without power</span></div>
    ${r.consumersLost.length ? `<div class="sg-chips">${r.consumersLost.map(id => assetChip(id)).join('')}</div>` : ''}`}
    ${restored.map(id => `<p class="sg-restored">Power restored to ${esc(nameOf(id))} via alternate supply from ${esc(nameOf(viaTransformer(id) ?? ''))}</p>`).join('')}
    ${outageOnly ? `<p class="sg-note">Compared with the outage alone: ${outageOnly.consumersLost.length} → ${r.consumersLost.length} consumers without power.</p>` : ''}
    ${r.consumersUncertain.length ? `<div class="sg-sub">State unknown (${r.consumersUncertain.length})</div><div class="sg-chips">${r.consumersUncertain.map(id => assetChip(id)).join('')}</div>` : ''}
    ${equipment.length ? `<details class="sg-fold"><summary>De-energized equipment · ${equipment.length}</summary><div class="sg-chips">${equipment.map(id => assetChip(id, { short: true })).join('')}</div></details>` : ''}
    <details class="sg-fold"><summary>Still powered · ${r.consumersPowered.length} consumer${r.consumersPowered.length === 1 ? '' : 's'}</summary><div class="sg-chips">${r.consumersPowered.map(id => assetChip(id)).join('')}</div></details>
    <details class="sg-fold"><summary>Why?</summary><p class="sg-reason">${esc(inv?.intent === INTENT.TRANSFER ? inv.answer.summary : why)}</p>
      ${inv?.answer.explanation ? `<p class="sg-note">${esc(inv.answer.explanation)}</p>` : ''}</details>
    <div class="sg-actions">
      <button class="sg-btn is-primary" data-act="reset">Reset Simulation</button>
      <button class="sg-btn" data-act="ipath">View Network Path</button>
      <button class="sg-btn" data-act="affected">View Affected Assets</button>
      ${impact.ties.map(t => `<button class="sg-btn" data-tie="${esc(t)}">Simulate Closing ${esc(t)}</button>`).join('')}
    </div>
    ${closed.length ? `<p class="sg-note">Closing ${esc(listText(closed))} is a hypothetical modelled action, not an approved switching instruction.</p>` : ''}
    <details class="sg-fold sg-limits"><summary>Model limitations</summary><ul class="sg-list"><li>Simulated on the illustrative model — not the terminal’s live operational state.</li>${limitations.map(l => `<li>${esc(l)}</li>`).join('')}</ul></details>`;
}
function wireImpact() {
  const { r, restored } = impact;
  panel.querySelector('[data-act="affected"]').onclick = () => layer.flyToAssets([...new Set([...r.offline, ...r.lost].flatMap(id => anchorsOf(network, id)))], { insets: insets(), rangeScale: 2 });
  panel.querySelector('[data-act="ipath"]').onclick = () => {
    const first = r.consumersLost[0] ?? restored[0] ?? r.rerouted[0];
    if (!first) return;
    // The path as it normally runs, drawn over the outage: red where the scenario cut it.
    const sc = scenario().scenario;
    const now = traceSupplyPath(network, first, { scenario: sc });
    const path = now.live ? now.path : traceSupplyPath(network, first).path;
    const res = investigate('UPSTREAM', first, deps());
    res.paths = [{ assetIds: path, edgeIds: res.paths[0]?.edgeIds ?? [], style: now.live ? 'restored' : 'interrupted' }];
    ui.investigation = { ...ui.investigation, paths: res.paths, feederIds: [...new Set([...(ui.investigation?.feederIds ?? []), ...path.filter(id => typeOf(id) === 'FEEDER')])] };
    sync();
    layer.flyToAssets([...new Set(path.flatMap(id => anchorsOf(network, id)))], { insets: insets() });
  };
}

function resetScenario() {
  session.reset();
  if (ui.investigation?.visualization.mode === 'OUTAGE') ui.investigation = null;
  sync();
}

function renderPill() {
  const sc = scenario();
  pill.dataset.state = sc ? 'scenario' : 'baseline';
  pill.innerHTML = sc
    ? `<i></i><span><b>Simulated outage</b> · ${esc(scenarioTitle(sc.scenario))}</span><button type="button" aria-label="Reset simulation">Reset</button>`
    : '<i></i><span>Baseline network · no scenario</span>';
  pill.querySelector('button')?.addEventListener('click', resetScenario);
}

// ---- legend: only the line styles on the map right now ----
function renderLegend() {
  const kinds = new Set(Object.values(layer.linkStates()));
  kinds.delete('hidden');
  const feeders = Object.values(layer.feederStates()).some(f => f.shown);
  legend.hidden = !kinds.size && !feeders;
  if (legend.hidden) return;
  const line = (k, cls, text) => (kinds.has(k) ? `<span><i class="sg-key ${cls}"></i>${text}</span>` : '');
  legend.innerHTML = `<summary>Legend</summary><div>
    ${line('flow', 'is-flow', 'Energized · direction of supply')}${line('flowSoft', 'is-flow', 'Energized · direction of supply')}${line('live', 'is-live', 'Energized in the simulation')}
    ${line('lost', 'is-lost', 'De-energized by the simulation')}${line('conditional', 'is-cond', 'Reachable only through a normally-open device')}${line('open', 'is-cond', 'Normally-open tie')}
    ${line('unknown', 'is-unknown', 'Undocumented connection')}${line('dim', 'is-open', 'Not energized')}
    ${feeders ? '<span><i class="sg-key-feeder">F3</i>Feeder segment (CB › feeder on a traced path)</span>' : ''}
    <span class="sg-rings"><i style="--c:var(--sg-green)"></i>Energized <i style="--c:var(--sg-red)"></i>No power <i style="--c:var(--sg-amber)"></i>Unknown</span>
    <small>Schematic connectivity between illustrative positions — not cable routes, and not current magnitude.</small></div>`;
}

// ---- workspaces ----
function setTab(tab) {
  if (SCREENS[tab]) { void openScreen(tab); return; }
  if (screen !== 'twin') {
    closeScreen();
    // Back to the workspace that was open: everything is as it was left, so nothing is reset.
    if (tab === ui.tab) return;
  }
  if (tab === 'singleline') { toggleSld(); return; }
  ui.tab = tab;
  for (const b of document.querySelectorAll('.sg-rail-item:not([aria-pressed])')) {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  if (tab === 'assets' && ui.sldOpen) toggleSld(false, { quiet: true });
  assetsPane.hidden = tab !== 'assets';
  $('.sg-layers').hidden = tab === 'assets';
  document.body.dataset.workspace = tab;
  // Overview and the full network start from a clean view; a running simulation stays until reset.
  if ((tab === 'overview' || tab === 'network') && !scenario()) { ui.investigation = null; ui.selectedId = null; ui.association = null; ui.geography = null; }
  sync();
  if (tab === 'network' && !scenario()) layer.flyToNetwork({ insets: insets() });
  if (tab === 'assets') assetsPane.querySelector('input')?.focus();
  if (tab === 'ask') askInput.focus();
  showSuggestions(tab === 'ask' || document.activeElement === askInput);
}
for (const b of document.querySelectorAll('.sg-rail-item')) b.onclick = () => setTab(b.dataset.tab);

function toggleSld(open = !ui.sldOpen, { quiet = false } = {}) {
  ui.sldOpen = open;
  sldPane.hidden = !open;
  document.body.classList.toggle('sg-sld-open', open);
  // The diagram explains the lines itself; with it open the map is narrower, so the legend folds away.
  legend.open = !open;
  $('.sg-rail-item[data-tab="singleline"]').setAttribute('aria-pressed', String(open));
  if (open && ui.tab === 'assets') { setTab('overview'); return; }
  if (quiet) return;
  sync();
  // The dock covers part of the map: re-frame the investigation if it is now hidden under it.
  const r = ui.investigation;
  if (open && r?.cameraTargetAssetIds.length && !layer.isVisible(r.cameraTargetAssetIds, insets())) frameResult(r);
}
sldPane.querySelector('.sg-close').onclick = () => toggleSld(false);

// ---- assets: icon, name and id, electrical state (condition is a separate, quieter fact) ----
const assetFilter = { text: '', type: '' };
const TYPES = [...new Set([...network.assets.values()].map(a => a.assetType))];
function renderAssetList() {
  if (assetsPane.hidden) return;
  if (!assetsPane.firstChild) {
    assetsPane.innerHTML = `<header><div class="sg-kicker">Assets</div><button class="sg-close" aria-label="Close assets">×</button></header>
      <input type="search" placeholder="Search by name or ID" aria-label="Search assets"><select aria-label="Asset type"><option value="">All types</option>${TYPES.map(t => `<option value="${t}">${esc(typeLabel(t))}</option>`).join('')}</select><ul></ul><p class="sg-note">${network.assets.size} illustrative assets · synthetic demonstration inventory</p>`;
    assetsPane.querySelector('input').oninput = e => { assetFilter.text = e.target.value.toLowerCase(); renderAssetList(); };
    assetsPane.querySelector('select').onchange = e => { assetFilter.type = e.target.value; renderAssetList(); };
    assetsPane.querySelector('.sg-close').onclick = () => setTab('overview');
  }
  const items = [...network.assets.values()].filter(a => (!assetFilter.type || a.assetType === assetFilter.type)
    && (!assetFilter.text || `${a.id} ${a.name} ${a.assetType}`.toLowerCase().includes(assetFilter.text)));
  const sub = a => (a.assetType === 'FEEDER' ? `${a.id} · ${a.from} → ${a.to}` : `${a.id}${a.location?.containerAssetId ? ` · in ${a.location.containerAssetId}` : ''}`);
  assetsPane.querySelector('ul').innerHTML = items.map(a => `<li><button data-asset="${esc(a.id)}" aria-current="${a.id === ui.selectedId}">
      ${iconSvg(a.assetType, 18)}<span class="sg-row-name"><b>${esc(a.name)}</b><small>${esc(sub(a))}${a.condition !== 'GOOD' ? ` · <span class="sg-cond-${esc(a.condition)}">${esc(a.condition.toLowerCase())} condition</span>` : ''}</small></span>${stateChip(a.id)}</button></li>`).join('')
    || '<li class="sg-note">No assets match.</li>';
  for (const b of assetsPane.querySelectorAll('[data-asset]')) b.onclick = () => openDetails(b.dataset.asset);
}

// ---- Ask the Twin: one compact bar, and the question bank in the Ask workspace ----
let context = {};
let bankCategory = 0;
const deps = () => ({ network, session, inspections, associations, today: new Date() });
function showSuggestions(show) {
  suggest.hidden = !show;
  if (!show) return;
  if (ui.tab === 'ask') {
    const cat = QUESTION_BANK[bankCategory];
    suggest.classList.add('is-bank');
    suggest.innerHTML = `<div class="sg-bank-tabs" role="tablist">${QUESTION_BANK.map((c, i) => `<button type="button" role="tab" aria-selected="${i === bankCategory}" data-cat="${i}">${esc(c.short)}</button>`).join('')}</div>
      <div class="sg-bank-list">${cat.questions.map(q => `<button type="button" data-ask="${esc(q)}">${esc(q)}</button>`).join('')}</div>`;
  } else {
    suggest.classList.remove('is-bank');
    suggest.innerHTML = `<span class="sg-kicker">Try asking</span>${SUGGESTED.map(s => `<button type="button" data-ask="${esc(s)}">${esc(s)}</button>`).join('')}`;
  }
  for (const b of suggest.querySelectorAll('button')) {
    b.onmousedown = e => e.preventDefault();   // keep the input focused, so the click lands
    b.onclick = () => {
      if (b.dataset.cat) { bankCategory = Number(b.dataset.cat); showSuggestions(true); return; }
      runQuestion(b.dataset.ask);
    };
  }
}
function runQuestion(question) {
  const { answer, context: next } = ask(question, { ...deps(), context: { ...context, selectedAssetId: ui.selectedId } });
  context = next;
  applyResult(answer);
  if (ui.tab !== 'ask') showSuggestions(false);
}
$('.sg-ask form').onsubmit = e => {
  e.preventDefault();
  const q = askInput.value.trim();
  if (q) runQuestion(q);
  askInput.value = '';
};
askInput.addEventListener('focus', () => showSuggestions(true));
askInput.addEventListener('blur', () => { if (ui.tab !== 'ask') showSuggestions(false); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || screen !== 'twin') return;
  if (ui.selectedId || ui.association || ui.geography) closeDetails();
  else showSuggestions(false);
  askInput.blur();
});

// ---- screens: this electrical twin, and the IFC screens (each its own module, lifecycle and DOM) ----
// A screen is loaded on first use. While one is shown, this page only hides its own chrome and
// pauses the map's render loop: the viewer, the layers, the selection and any simulated outage are
// left exactly as they were, and come back unchanged.
//  - ifc-spatial (rail): the IFC geometry converted on the server and drawn with Cesium. It has its
//    own Cesium viewer, created when it opens and destroyed when it closes, so nothing it draws can
//    reach this map.
//  - ifc (no rail entry, ?screen=ifc only): the earlier Autodesk Viewer explorer, kept as a
//    legacy/debug view of the model's property database.
const SCREENS = {
  'ifc-spatial': { load: async () => (await import('../ifcSpatial/ifcSpatialScreen.js')).mountIfcSpatial },
  ifc: { load: async () => (await import('../ifcExplorer/ifcExplorer.js')).mountIfcExplorer },
};
let screen = 'twin';
const mounted = {};
const setParams = changes => {
  const params = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(changes)) { if (value) params.set(key, value); else params.delete(key); }
  history.replaceState(history.state, '', `${location.pathname}?${params}${location.hash}`);
};
const markRail = id => {
  for (const b of document.querySelectorAll('.sg-rail-item:not([aria-pressed])')) {
    if (b.dataset.tab === id) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
};
async function openScreen(name) {
  if (screen === name) return;
  if (screen !== 'twin') closeScreen({ keepParams: true });
  screen = name;
  markRail(name);
  showSuggestions(false);
  askInput.blur();
  document.body.dataset.screen = name;
  viewer.useDefaultRenderLoop = false;
  setParams({ screen: name });
  if (!mounted[name]) {
    const mount = await SCREENS[name].load();
    mounted[name] ??= mount({ initialModel: new URLSearchParams(location.search).get('model'), onModelChange: model => setParams({ model }) });
  }
  if (screen === name) await mounted[name].show();
}
function closeScreen({ keepParams = false } = {}) {
  mounted[screen]?.hide();
  screen = 'twin';
  delete document.body.dataset.screen;
  viewer.useDefaultRenderLoop = true;
  viewer.resize();
  if (!keepParams) setParams({ screen: null, model: null });
  markRail(ui.tab);
}

setTab('overview');
{
  const requested = new URLSearchParams(location.search).get('screen');
  if (SCREENS[requested]) {
    void openScreen(requested).catch(error => {
      // A failed module/viewer startup must expose a useful error instead of trapping the loader.
      console.error('Could not open the requested screen', error);
      const notice = document.createElement('div');
      notice.setAttribute('role', 'alert');
      notice.textContent = `Could not load IFC Spatial Twin: ${error.message}. Please refresh to try again.`;
      notice.style.cssText = 'position:fixed;inset:20% 15%;z-index:99999;padding:32px;background:#071525;color:#edf8ff';
      document.body.append(notice);
    }).finally(() => {
      document.documentElement.classList.remove('i595-booting');
      document.querySelector('#i595-boot-loader')?.remove();
    });
  }
}
// For browser tests and the console: read-only views of state (no writes are exposed beyond asking).
window.__seagirt = Object.freeze({
  state: () => {
    const r = ui.investigation, sc = scenario(), m = layer.model();
    return {
      screen, tab: ui.tab, selected: ui.selectedId, pinned: ui.pinnedId, association: ui.association, sldOpen: ui.sldOpen, feedersLayer: ui.feedersLayer,
      anchored: Boolean(layer.anchorOf('SS1')),
      panel: { kind: panel.hidden ? null : panel.dataset.kind, title: panel.querySelector('h2')?.textContent ?? null,
        visible: [...document.querySelectorAll('.sg-panel, .sg-answer, .sg-path')].filter(el => !el.hidden && el.getClientRects().length).length },
      investigation: r && { intent: r.intent, mode: r.visualization.mode, status: r.status, title: r.answer.title, primary: r.primaryAssetId,
        targets: r.targetAssetIds, related: r.relatedAssetIds, conditional: r.conditionalAssetIds, feeders: r.feederIds,
        paths: r.paths.map(p => p.assetIds), pathEdges: r.pathEdgeIds, groups: r.resultGroups.map(g => ({ key: g.key, label: g.label, ids: g.assetIds })),
        camera: r.cameraTargetAssetIds, provenance: r.provenance, limitations: r.answer.limitations, missingInputs: r.answer.missingInputs },
      scenario: sc && { label: sc.label, lost: [...sc.result.lost], consumersLost: [...sc.result.consumersLost], rerouted: [...sc.result.rerouted] },
      markerStatus: layer.status(),
      roles: Object.fromEntries([...m.assets].map(([id, a]) => [id, a.role])),
      dimmed: [...m.assets].filter(([, a]) => a.dimmed).map(([id]) => id),
      links: layer.linkStates(), feeders: layer.feederStates(), labels: layer.labelsShown(),
      sldEdges: ui.sldOpen ? sld.edgeKinds() : null,
      trace: r ? r.paths.map(p => [...p.assetIds]) : [],
    };
  },
  ask: q => runQuestion(q),
  /** Switch screens as the rail does ('twin' returns); the legacy explorer has no rail entry. */
  openScreen: name => (name === 'twin' ? (screen !== 'twin' && closeScreen()) : SCREENS[name] && openScreen(name)),
  /** Where an asset's marker (or a feeder's label) is on screen (CSS pixels), for clicking it in browser tests. */
  screenPositionOf: id => {
    const p = layer.screenOf(id);
    const box = viewer.canvas.getBoundingClientRect();
    return p ? { x: box.left + p.x, y: box.top + p.y } : null;
  },
  /** Are these assets on screen and outside the open panels? */
  onScreen: ids => layer.isVisible(ids, insets()),
  labelBoxes: () => layer.labelBoxes(),
  tilesLoaded: () => viewer.scene.globe.tilesLoaded,
  flying: () => layer.flying(),
  camera: () => { const c = viewer.camera.positionCartographic; return { lon: c.longitude * 180 / Math.PI, lat: c.latitude * 180 / Math.PI, height: c.height }; },
});
if (import.meta.hot) import.meta.hot.dispose(() => { layer.destroy(); navigation.destroy(); sld.destroy(); for (const m of Object.values(mounted)) m.destroy(); });
