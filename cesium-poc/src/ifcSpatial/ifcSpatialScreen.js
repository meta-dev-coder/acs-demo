/**
 * IFC Spatial Twin: the IFC models from Autodesk Forma, converted on the server (server/ifcSpatial/)
 * and shown on the Cesium globe at Seagirt Marine Terminal. By default the IFC's electrical network is
 * drawn the way the what-if mock draws it and works like the electrical twin (networkTwin.js:
 * outages, switching, Ask the Twin); the converted 3D geometry is a layer that can be turned on.
 *
 * Its own screen with its own Cesium viewer, made with the shared CesiumRenderer (same Esri imagery
 * and terrain as the electrical twin). The base map is Google Photorealistic 3D by default, or the
 * simple satellite map; the header switches between them. The viewer is created on show() and destroyed on hide(); the
 * electrical twin's viewer, layers and simulation are never touched, and no Autodesk Viewer is used.
 *
 * Identity: a pick returns the glTF feature, whose `globalId` property is the IFC GlobalId; that
 * GlobalId keys everything here (selection, isolation, the element index). Highlight, isolation and
 * opacity are a Cesium3DTileStyle on the model, keyed by GlobalId.
 */
import {
  Axis, Billboard, BoundingSphere, CameraEventType, Cartesian2, Cartesian3, Cartographic, Cesium3DTileStyle, ColorBlendMode, HeadingPitchRange, KeyboardEventModifier, Math as CMath, Ellipsoid,
  Matrix4, Model, SceneTransforms, ScreenSpaceEventHandler, ScreenSpaceEventType, Transforms, sampleTerrainMostDetailed,
} from 'cesium';
import { CesiumRenderer } from '../renderers/cesium.js';
import { cameraPivot, orbitView, ROTATE_STEP_DEG, TILT_STEP_DEG, zoomRange } from '../mapNavigationControls.js';
import { ApsRequestError, loginUrl, needsSignIn } from '../ifcExplorer/apsClient.js';
import { CATEGORIES } from '../ifcExplorer/modelIndex.js';
import { compareAssets } from '../ifcExplorer/assetMapping.js';
import { classifyEdit, defaultPlacement, modelMatrixFor, PLACEMENT_MODE, transformPoint } from './placement.js';
import { createNetworkTwin } from './networkTwin.js';
import { createGooglePhotorealistic3DService } from '../basePhotorealistic3D.js';
import { createCompareMode } from './compareMode.js';
import { createDocumentsPanel, documentListHtml } from './documentsPanel.js';
import './ifcSpatial.css';

const API = '/api/ifc-spatial';
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const bytes = n => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${Math.round(n / 1e3)} kB`);
const glyph = d => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  docs: glyph('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>'),
  compare: glyph('<rect x="3" y="4" width="7.5" height="16" rx="1.5"/><rect x="13.5" y="4" width="7.5" height="16" rx="1.5"/><path d="M12 2v20"/>'),
  fit: glyph('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  zoomIn: glyph('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3M11 8v6M8 11h6"/>'),
  zoomOut: glyph('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3M8 11h6"/>'),
  left: glyph('<path d="M9 7H5V3"/><path d="M5.3 7A8 8 0 1 1 4 12"/>'),
  right: glyph('<path d="M15 7h4V3"/><path d="M18.7 7A8 8 0 1 0 20 12"/>'),
  up: glyph('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  down: glyph('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  home: glyph('<path d="M4 11.5 12 5l8 6.5"/><path d="M6.5 10v9h11v-9"/><path d="M10 19v-5h4v5"/>'),
  reset: glyph('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/>'),
  google3d: glyph('<path d="M3 20h18"/><path d="M5 20V10l4-2v12M9 20V5l5-2v17M14 20v-9l5 1.5V20"/>'),
  simple: glyph('<path d="M9 4 3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/>'),
  labels: glyph('<path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1 1 0 0 1 0 1.4l-7.3 7.3a1 1 0 0 1-1.4 0z"/><circle cx="8" cy="8" r="1.4"/>'),
  dim: glyph('<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17" /><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/>'),
};
/** A category for the details panel, from the same rules as the IFC Model Explorer. */
const categoryOf = element => CATEGORIES.find(category => category.test({ ...element, name: element.name ?? '' }))?.label ?? 'Other';

async function request(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(`${API}${path}`, { method, credentials: 'same-origin', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch (error) { throw new ApsRequestError('NETWORK', 0, `The app server could not be reached (${error?.message ?? error}).`); }
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApsRequestError(json?.error?.code ?? `HTTP_${response.status}`, response.status, json?.error?.message ?? `The server answered ${response.status}.`, json?.error?.hint, json);
  return json;
}

/** /api/gmail/* (server/gmail/): the same error shape as the IFC Spatial routes. */
async function gmailRequest(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(`/api/gmail${path}`, { method, credentials: 'same-origin', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch (error) { throw new ApsRequestError('NETWORK', 0, `The app server could not be reached (${error?.message ?? error}).`); }
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApsRequestError(json?.error?.code ?? `HTTP_${response.status}`, response.status, json?.error?.message ?? `The server answered ${response.status}.`, null, json);
  return json;
}

export function mountIfcSpatial({ host = document.body, syncIntervalMs = 60_000, ionToken = import.meta.env?.VITE_CESIUM_ION_TOKEN, assetsUrl = `${import.meta.env?.BASE_URL ?? '/'}data/seagirt/electrical-assets.json`,
  referenceUrl = `${import.meta.env?.BASE_URL ?? '/'}data/seagirt/ifc-reference-alignment.json`,
  initialModel = null, onModelChange = () => {} } = {}) {
  const root = document.createElement('main');
  root.className = 'isp';
  root.setAttribute('aria-label', 'IFC Spatial Twin');
  root.hidden = true;
  root.innerHTML = `
    <header class="isp-top">
      <div class="isp-brand"><b>IFC Spatial Twin</b></div>
      <div class="isp-hbar" role="toolbar" aria-label="View">
        <button type="button" class="isp-hicon isp-ws" data-ws="network" aria-current="page" aria-label="Electrical Network" data-tip="Electrical Network">${glyph('<circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M8.2 7.2 10.6 16M15.8 7.2 13.4 16M8.4 6h7.2"/>')}</button>
        <button type="button" class="isp-hicon isp-ws isp-compare-btn" data-act="compare" aria-label="Compare versions" data-tip="Compare versions">${ICON.compare}</button>
        <button type="button" class="isp-hicon isp-ws" data-act="docs" aria-label="Asset documentation" data-tip="Asset documentation">${ICON.docs}</button>
        <button type="button" class="isp-hicon isp-ws" data-ws="assets" aria-label="Assets" data-tip="Assets">${glyph('<path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8z"/><path d="m3.5 12 8.5 4.5 8.5-4.5"/><path d="m3.5 16 8.5 4.5 8.5-4.5"/>')}</button>
        <span class="isp-hsep"></span>
        <div class="isp-seg" role="group" aria-label="Base map">
          <button type="button" class="isp-hbtn isp-hbtn-ic" data-base="google" aria-pressed="true" aria-label="Google 3D" data-tip="Google Photorealistic 3D map">${ICON.google3d}</button>
          <button type="button" class="isp-hbtn isp-hbtn-ic" data-base="simple" aria-pressed="false" aria-label="Simple map" data-tip="Simple satellite map">${ICON.simple}</button>
        </div>
        <button type="button" class="isp-hbtn isp-hbtn-ic" data-toggle="labels" aria-pressed="false" aria-label="Labels" data-tip="Labels">${ICON.labels}</button>
        <button type="button" class="isp-hbtn isp-hbtn-ic" data-toggle="dim" aria-pressed="true" aria-label="Dim imagery" data-tip="Dim imagery">${ICON.dim}</button>
        <!-- Hidden from the header on request; the settings stay (wireframe model shown, SCADA fibre drawn). -->
        <button type="button" class="isp-hbtn" data-toggle="wireframe" aria-pressed="true" hidden>Wireframe</button>
        <button type="button" class="isp-hbtn" data-toggle="show" aria-pressed="true" hidden>3D model</button>
        <button type="button" class="isp-hbtn" data-toggle="control" aria-pressed="true" hidden>SCADA</button>
        <span class="isp-hsep"></span>
        <button type="button" class="isp-hicon" data-cam="in" data-tip="Zoom in" aria-label="Zoom in">${ICON.zoomIn}</button>
        <button type="button" class="isp-hicon" data-cam="out" data-tip="Zoom out" aria-label="Zoom out">${ICON.zoomOut}</button>
        <button type="button" class="isp-hicon" data-cam="left" data-tip="Rotate left" aria-label="Rotate left">${ICON.left}</button>
        <button type="button" class="isp-hicon" data-cam="right" data-tip="Rotate right" aria-label="Rotate right">${ICON.right}</button>
        <button type="button" class="isp-hicon" data-cam="up" data-tip="Tilt up" aria-label="Tilt up">${ICON.up}</button>
        <button type="button" class="isp-hicon" data-cam="down" data-tip="Tilt down" aria-label="Tilt down">${ICON.down}</button>
        <button type="button" class="isp-hicon" data-cam="home" data-tip="Reset view" aria-label="Reset view">${ICON.home}</button>
        <button type="button" class="isp-hicon" data-cam="fit" data-tip="Fit to the network" aria-label="Fit to the network">${ICON.fit}</button>
      </div>
      <div class="isp-hstatus">
        <button type="button" class="isp-chip isp-sync" data-act="syncNow" title="Checks Autodesk ACC for a new version of the IFC model every minute. Click to check now.">ACC</button>
      </div>
      <button type="button" class="isp-chip isp-scenario-pill" data-act="netReset" title="Reset the simulation" hidden></button>
      <!-- The More menu is hidden for now (?more=1 shows it); its panel stays wired. -->
      <div class="isp-more-wrap"${new URLSearchParams(location.search).get('more') === '1' ? '' : ' hidden'}>
        <button type="button" class="isp-hbtn" data-act="more" aria-expanded="false">More ▾</button>
        <div class="isp-more-panel isp-card" hidden>
          <div class="isp-chips isp-status-chips">
            <span class="isp-chip isp-conn" role="status">Connecting…</span><span class="isp-chip isp-conv"></span><span class="isp-chip isp-place"></span>
          </div>
          <div class="isp-muted isp-source">Autodesk Forma Data Management</div>
          <label class="isp-field"><span>Model <span class="isp-model-name"></span></span><select class="isp-select" aria-label="IFC model" disabled></select></label>
          <div class="isp-net"></div>
          <details class="isp-more"><summary>More layers</summary>
            <label class="isp-check"><input type="checkbox" data-layer="network" checked> Network overlay</label>
            <label class="isp-check"><input type="checkbox" data-layer="zones" checked> Zones</label>
            <label class="isp-field isp-range"><span>3D opacity</span><input type="range" min="0.15" max="1" step="0.05" value="0.55" data-opt="opacity" aria-label="IFC layer opacity"></label>
            <label class="isp-check"><input type="checkbox" data-opt="belowGround" checked> Show below-ground geometry</label>
            <label class="isp-check"><input type="checkbox" data-opt="bounds"> Bounding volume</label>
            <button type="button" class="isp-btn" data-cam="reset">Reset camera</button>
          </details>
          <button type="button" class="isp-btn" data-act="placement">Placement…</button>
          <details class="isp-more"><summary>Conversion</summary><div class="isp-diag"></div></details>
          <details class="isp-more"><summary>Electrical connectivity</summary><div class="isp-topo"></div></details>
          <details class="isp-more"><summary>Asset mapping (read-only)</summary><div class="isp-mapping"></div></details>
        </div>
      </div>
      <button type="button" class="isp-power" data-act="opsCollapse" aria-expanded="true" hidden></button>
    </header>
    <div class="isp-map"></div>
    <div class="isp-compare-host"></div>
    <aside class="isp-assets isp-card" aria-label="Assets" hidden></aside>
    <nav class="isp-chain isp-card" aria-label="Supply path" hidden></nav>
    <aside class="isp-place-panel isp-card" aria-label="Model placement" hidden></aside>
    <aside class="isp-right isp-card" aria-label="IFC element" hidden></aside>
    <aside class="isp-right isp-net-panel isp-card" aria-label="Network asset or answer" hidden></aside>
    <section class="isp-ask" aria-label="Ask the Twin"></section>
    <aside class="isp-ops isp-card" aria-label="Power status and alerts" hidden></aside>
    <div class="isp-overlay" hidden></div>`;
  host.append(root);
  const $ = selector => root.querySelector(selector);
  const modelSelect = $('.isp-select'), overlay = $('.isp-overlay'), right = $('.isp-right'), placePanel = $('.isp-place-panel');

  const st = {
    visible: false, phase: 'idle', error: null, project: null, models: [], fileName: initialModel,
    manifest: null, elements: [], byGlobalId: new Map(), byFeature: new Map(), georef: null, placement: null, saved: null, terrainHeight: 0,
    // The IFC model from ACC is the base: shown as a wireframe over a translucent model, the network drawn on top.
    reference: null, selected: null, isolated: false, opacity: 0.55, show: true, belowGround: true,
    layers: { network: true, control: true, labels: false, zones: true, dim: true }, wireframe: true,
    // Base map: 'google' (Photorealistic 3D, the default) or 'simple' (satellite imagery on the globe).
    base: readBase(), baseNote: null, googleOffset: null,
    bounds: false, mapping: null, assets: null,
  };
  let renderer = null, viewer = null, model = null, handler = null, loadToken = 0, net = null, netIndex = null, google = null;
  // The ACC version check: every syncIntervalMs while the screen is open, for a newer version of this model.
  const sync = { timer: null, busy: false, checkedAt: null, pending: null, error: null, updatedFrom: null };
  const netPanel = $('.isp-net-panel');
  const matrix = () => modelMatrixFor(st.placement, st.georef, st.terrainHeight);

  // ---- phases ----

  function setPhase(phase, text) {
    st.phase = phase;
    if (phase !== 'error') st.error = null;
    overlay.hidden = phase === 'ready' || phase === 'idle';
    if (!overlay.hidden) overlay.innerHTML = `<div class="isp-card isp-wait"><span class="isp-spinner" aria-hidden="true"></span>${esc(text ?? 'Working…')}</div>`;
    renderHeader();
  }

  function fail(error) {
    st.phase = 'error';
    st.error = { code: error?.code ?? 'ERROR', message: error?.message ?? String(error), hint: error?.hint ?? null };
    const signIn = needsSignIn(error);
    const title = signIn ? 'Sign in to Autodesk' : {
      INVALID_IFC: 'Not a valid IFC file', UNSUPPORTED_SCHEMA: 'Unsupported IFC schema', PARSE_FAILED: 'The IFC file could not be read',
      NO_GEOMETRY: 'No renderable IFC geometry', DOWNLOAD_FAILED: 'The IFC file could not be downloaded', MODEL_LOAD_FAILED: 'Cesium could not load the converted model',
      APS_NOT_CONFIGURED: 'Autodesk is not configured',
    }[st.error.code] ?? 'The IFC model could not be shown';
    overlay.hidden = false;
    overlay.innerHTML = `<div class="isp-card isp-error" role="alert"><h2>${esc(title)}</h2><p>${esc(st.error.message)}</p>${st.error.hint ? `<p class="isp-muted">${esc(st.error.hint)}</p>` : ''}
      <div class="isp-actions">${signIn ? `<a class="isp-btn is-primary" href="${esc(loginUrl())}">Sign in with Autodesk</a>` : ''}
      <button type="button" class="isp-btn" data-act="retry">Try again</button></div><small class="isp-muted">Code ${esc(st.error.code)}. Nothing is shown in place of the model.</small></div>`;
    renderHeader();
  }

  // ---- data ----

  async function connect() {
    setPhase('connecting', 'Checking the Autodesk connection…');
    try {
      const list = await request('/models');
      st.project = list.project;
      st.models = list.models;
      if (!st.models.find(entry => entry.fileName === st.fileName)) st.fileName = st.models[0]?.fileName ?? null;
      if (!st.fileName) throw new ApsRequestError('FILES_MISSING', 404, 'The project has no IFC files.');
      renderHeader();
      await openModel();
    } catch (error) { fail(error); }
  }

  async function openModel({ force = false, keepView = false } = {}) {
    const mine = ++loadToken;
    clearSelection();
    removeModel();
    st.manifest = null; st.elements = []; st.byGlobalId = new Map(); st.byFeature = new Map(); st.mapping = null;
    renderHeader(); renderSide();
    try {
      const entry = st.models.find(item => item.fileName === st.fileName);
      setPhase('converting', entry?.status === 'converted' && !force ? 'Loading the converted model…' : 'Downloading the IFC from Autodesk Forma and converting its geometry…');
      const manifest = await request(`/prepare?file=${encodeURIComponent(st.fileName)}${force ? '&force=1' : ''}`, { method: 'POST' });
      if (mine !== loadToken) return;
      st.manifest = manifest;
      if (entry) { entry.status = 'converted'; entry.key = manifest.key; entry.diagnostics = manifest.diagnostics; }
      const index = await request(manifest.elementsUrl.slice(API.length));
      if (mine !== loadToken) return;
      st.elements = index.elements;
      for (const element of st.elements) {
        if (element.globalId) st.byGlobalId.set(element.globalId, element);
        if (element.featureId !== null) st.byFeature.set(element.featureId, element);
      }
      st.georef = manifest.placement.georeferenced;
      st.saved = manifest.placement.saved;
      // A version with nothing saved (a new one from ACC) starts aligned to the terminal when the documented
      // alignment covers the file: its IfcMapConversion puts the quay ~38° off and offshore.
      const reference = await loadReference();
      st.placement = st.saved ?? (reference ? { ...reference.placement, mode: PLACEMENT_MODE.CALIBRATED } : defaultPlacement(st.georef));
      if (!st.placement) {
        // No georeferencing and nothing saved: the user places it; the map shows the terminal meanwhile.
        st.placement = { mode: PLACEMENT_MODE.CALIBRATED, lon: -76.5394, lat: 39.2569, heightOffset: 0, headingDeg: 0, scale: 1, unplaced: true };
      }
      setPhase('placing', 'Reading the terrain height under the model origin…');
      st.terrainHeight = await terrainHeightAt(st.placement.lon, st.placement.lat);
      if (mine !== loadToken || !viewer) return;
      setPhase('loading', 'Loading the converted geometry into Cesium…');
      let loaded;
      try {
        loaded = await Model.fromGltfAsync({
          url: manifest.glbUrl, modelMatrix: Matrix4.fromArray(matrix()), upAxis: Axis.Z, forwardAxis: Axis.X,
          enableDebugWireframe: true, colorBlendMode: ColorBlendMode.HIGHLIGHT, allowPicking: true,
        });
      } catch (error) { throw new ApsRequestError('MODEL_LOAD_FAILED', 0, error?.message ?? String(error)); }
      if (mine !== loadToken || !viewer) { loaded.destroy?.(); return; }
      model = viewer.scene.primitives.add(loaded);
      await new Promise((resolve, reject) => {
        const done = model.readyEvent.addEventListener(() => { done(); resolve(); });
        const bad = model.errorEvent?.addEventListener?.(error => { bad?.(); reject(new ApsRequestError('MODEL_LOAD_FAILED', 0, error?.message ?? String(error))); });
      });
      if (mine !== loadToken) return;
      applyStyle(); applyOptions();
      netIndex = { elements: index.elements, connections: index.connections ?? [] };
      buildNetwork();
      setPhase('ready');
      renderSide();
      if (!keepView) { if (net) net.frameAll(); else fitModel({ duration: 0 }); }
      if (!homeView) rememberHomeView();
      if (st.placement.unplaced) openPlacement();
    } catch (error) {
      if (mine === loadToken) fail(error);
    }
  }

  async function terrainHeightAt(lon, lat) {
    try {
      const [point] = await sampleTerrainMostDetailed(viewer.terrainProvider, [Cartographic.fromDegrees(lon, lat)]);
      return Number.isFinite(point?.height) ? point.height : 0;
    } catch { return 0; }
  }

  /** IFC model metres → longitude / latitude / height through the current placement. */
  const modelToLonLat = (x, y, z = 0) => {
    const c = Cartographic.fromCartesian(Cartesian3.fromArray(transformPoint(matrix(), [x, y, z])), Ellipsoid.WGS84);
    return { lon: CMath.toDegrees(c.longitude), lat: CMath.toDegrees(c.latitude), height: c.height };
  };

  /** The IFC network twin (overlay, outages, Ask the Twin), built at the current placement. */
  function buildNetwork() {
    net?.destroy();
    net = null;
    netPanel.hidden = true;
    if (!viewer || !netIndex) return;
    net = createNetworkTwin({ viewer, ...netIndex, modelToLonLat, panel: netPanel, left: $('.isp-net'), askHost: $('.isp-ask'), header: $('.isp-scenario-pill'),
      assetsHost: $('.isp-assets'), chainHost: $('.isp-chain'), sourceLabel: `${st.fileName ?? ''}${st.manifest?.versionNumber ? ` v${st.manifest.versionNumber}` : ''}`,
      onWorkspace: ws => setWorkspace(ws), opsHost: $('.isp-ops'), powerHost: $('.isp-power'), onDocument: (id, opts) => docs.openPreview(id, opts), compareTools,
      // Select Area: membership is resolved by the server from its own elements, through the placement the area was drawn on.
      areaTools: {
        version: () => ({ key: st.manifest?.key ?? null, versionNumber: st.manifest?.versionNumber ?? null, fileName: st.fileName }),
        resolve: (geometry, { nearM = null, zones = [] } = {}) => request(`/area?file=${encodeURIComponent(st.fileName)}`, { method: 'POST',
          body: { key: st.manifest?.key, geometry, placement: st.placement, nearM, zones } }),
        placement: () => st.placement,
      },
      docTools: {
        analyze: (assetId, type) => request(`/documents/analysis?file=${encodeURIComponent(st.fileName)}&asset=${encodeURIComponent(assetId)}&type=${encodeURIComponent(type)}${st.manifest?.versionNumber ? `&version=${st.manifest.versionNumber}` : ''}`),
        fleet: () => request(`/documents/analysis/fleet?file=${encodeURIComponent(st.fileName)}`),
        // Generated reports (server/ifcSpatial/reports/): a job, its progress, the draft and the snapshot.
        report: {
          create: body => request(`/reports?file=${encodeURIComponent(st.fileName)}`, { method: 'POST', body }),
          get: id => request(`/reports/${encodeURIComponent(id)}?file=${encodeURIComponent(st.fileName)}`),
          cancel: id => request(`/reports/${encodeURIComponent(id)}/cancel?file=${encodeURIComponent(st.fileName)}`, { method: 'POST' }),
          retry: (id, type) => request(`/reports/${encodeURIComponent(id)}/retry?file=${encodeURIComponent(st.fileName)}&type=${encodeURIComponent(type)}`, { method: 'POST' }),
          email: (id, body) => request(`/reports/${encodeURIComponent(id)}/email?file=${encodeURIComponent(st.fileName)}`, { method: 'PUT', body }),
          snapshot: id => request(`/reports/${encodeURIComponent(id)}/snapshot?file=${encodeURIComponent(st.fileName)}`),
        },
        // The user's Gmail (server/gmail/): status, sign-in in a popup, an explicit send, history. No tokens here.
        gmail: {
          loginUrl: '/api/gmail/auth/login',
          status: () => gmailRequest('/status'),
          disconnect: () => gmailRequest('/disconnect', { method: 'POST' }),
          send: body => gmailRequest('/send', { method: 'POST', body: { fileName: st.fileName, ...body } }),
          history: reportId => gmailRequest(`/history?file=${encodeURIComponent(st.fileName)}&reportId=${encodeURIComponent(reportId)}`),
        },
      },
      // Questions the rules did not understand, read by Claude on the server (off unless SEAGIRT_ASK_LLM=on).
      interpretTools: { status: () => request('/interpret/status'), interpret: body => request('/interpret', { method: 'POST', body }) },
      onArtifact: spec => docs.openArtifact(spec),
      heading: st.placement?.headingDeg ?? 0, baseHeight: st.terrainHeight + (st.placement?.heightOffset ?? 0), onSelectElement: globalId => { st.selected = null; right.hidden = true; st.netGlobalId = globalId; applyStyle(); },
      onFocusElement: globalId => { st.focusGlobalId = globalId; applyStyle(); } });
    renderTopology();
    applyLayers();
    renderToggles();
    setWorkspace(st.workspace ?? 'network');
    if (st.base === 'google') void alignGoogle();
    applyStyle();
    dockPanels();
    // Asset documentation: the index for this model, read once (the server re-reads ACC only when stale).
    const loaded = docs.index();
    if (loaded && loaded.model?.fileName === st.fileName) net.setDocuments(loaded); else void docs.load();
  }

  /**
   * Two workspaces, as on the electrical twin: Electrical Network (the whole network, no side list)
   * and Assets (the Assets panel on the left; a selected asset is shown in its context).
   */
  function setWorkspace(ws) {
    st.workspace = ws;
    $('.isp-assets').hidden = ws !== 'assets';
    for (const b of root.querySelectorAll('[data-ws]')) { if (b.dataset.ws === ws) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
    net?.setWorkspace(ws);
    if (ws === 'assets') $('.isp-asearch')?.focus();
  }

  /** Header toggles: the view settings people change most, one click each. */
  function toggleView(name) {
    if (['labels', 'dim', 'control'].includes(name)) { st.layers[name] = !st.layers[name]; applyLayers(); }
    else if (name === 'wireframe' || name === 'show') { st[name] = !st[name]; applyOptions(); }
    renderToggles();
  }
  function renderToggles() {
    const on = { labels: st.layers.labels, dim: st.layers.dim, control: st.layers.control, wireframe: st.wireframe, show: st.show };
    for (const b of root.querySelectorAll('[data-toggle]')) b.setAttribute('aria-pressed', String(Boolean(on[b.dataset.toggle])));
    for (const b of root.querySelectorAll('[data-base]')) b.setAttribute('aria-pressed', String(b.dataset.base === st.base));
    const g = root.querySelector('[data-base="google"]');
    g.dataset.tip = st.baseNote ?? 'Google Photorealistic 3D map';
  }

  // ---- base map: Google Photorealistic 3D or the simple satellite map ----

  /** The details panels (network asset, IFC element) live in the status sidebar, above Power Status. */
  function dockPanels() {
    const slot = $('.isp-ops-detail');
    if (!slot) return;
    if (netPanel.parentElement !== slot) slot.append(netPanel);
    if (right.parentElement !== slot) slot.append(right);
  }

  function readBase() {
    try { return localStorage.getItem('ifcSpatial.base') === 'simple' ? 'simple' : 'google'; } catch { return 'google'; }
  }

  async function setBase(base) {
    st.base = base;
    st.baseNote = null;
    try { localStorage.setItem('ifcSpatial.base', base); } catch { /* a convenience only */ }
    renderToggles();
    await applyBase();
  }

  async function applyBase() {
    if (!google) return;
    if (st.base !== 'google') { google.disable(); applyLayers(); return; }
    const result = await google.enable();
    if (!google) return;
    if (!result.ok) {
      // Not available (no key, refused, offline): stay on the simple map and say why.
      st.base = 'simple';
      st.baseNote = result.message;
      google.disable();
      renderToggles();
      applyLayers();
      return;
    }
    applyLayers();
    await alignGoogle();
  }

  /**
   * The model and the network are placed on the terrain height (ellipsoidal; 0 without a terrain
   * provider), while Google's mesh carries its own heights (about 30 m lower here, the geoid). Move
   * the Google tiles vertically so their ground meets the model's base. A median of five samples
   * around the origin keeps a building or an overlay line under one point from skewing it.
   */
  async function alignGoogle() {
    const tileset = google?.tileset();
    if (!tileset || !st.placement || !viewer?.scene.sampleHeightSupported) return;
    const { lon, lat } = st.placement;
    tileset.modelMatrix = Matrix4.IDENTITY.clone();
    const d = 0.0015;
    const points = [[0, 0], [d, 0], [-d, 0], [0, d], [0, -d]].map(([x, y]) => Cartographic.fromDegrees(lon + x, lat + y));
    let heights;
    try {
      heights = (await viewer.scene.sampleHeightMostDetailed(points, [model].filter(Boolean))).map(p => p.height).filter(Number.isFinite).sort((a, b) => a - b);
    } catch { return; }
    if (!heights?.length || !google || google.tileset() !== tileset) return;
    const ground = heights[Math.floor(heights.length / 2)];
    const delta = st.terrainHeight + (st.placement.heightOffset ?? 0) - ground;
    const up = Ellipsoid.WGS84.geodeticSurfaceNormal(Cartesian3.fromDegrees(lon, lat), new Cartesian3());
    tileset.modelMatrix = Matrix4.fromTranslation(Cartesian3.multiplyByScalar(up, delta, new Cartesian3()));
    st.googleOffset = delta;
    viewer.scene.requestRender();
  }

  function applyLayers() {
    net?.setLayers({ network: st.layers.network, control: st.layers.control, zones: st.layers.zones, labels: st.layers.labels });
    // Dim imagery: quieter, with a little more contrast, so the network and its status colours lead.
    const base = viewer?.imageryLayers.get(0);
    if (base) { base.brightness = st.layers.dim ? 0.58 : 1; base.contrast = st.layers.dim ? 1.15 : 1; base.saturation = st.layers.dim ? 0.75 : 1; }
    // Google Photorealistic 3D Tiles take no brightness/contrast: a 3D Tiles style multiplies their colour instead.
    const tileset = google?.tileset();
    if (tileset) tileset.style = st.layers.dim ? new Cesium3DTileStyle({ color: "color('#8f959d')" }) : undefined;
  }

  function removeModel() {
    if (model && viewer && !viewer.isDestroyed()) viewer.scene.primitives.remove(model);
    model = null;
  }

  // ---- styling: highlight, isolation, opacity ----

  function applyStyle() {
    if (!model) return;
    const alpha = st.opacity;
    const id = st.selected?.globalId;
    // The selection in yellow; what the model leaves without power in red (an alarm stays red); the asset
    // Ask the Twin focused in cyan; the rest translucent white.
    const unpowered = (net?.unpoweredGlobalIds() ?? []).filter(g => /^[0-9A-Za-z_$]{22}$/.test(g));
    const focused = /^[0-9A-Za-z_$]{22}$/.test(st.focusGlobalId ?? '') ? st.focusGlobalId : null;
    model.style = new Cesium3DTileStyle({
      show: st.isolated && id ? `\${globalId} === '${id}'` : 'true',
      color: { conditions: [
        ...(id ? [[`\${globalId} === '${id}'`, `color('#ffd400', ${Math.max(alpha, 0.85)})`]] : []),
        ...unpowered.map(g => [`\${globalId} === '${g}'`, `color('#ff3b4f', ${Math.max(alpha, 0.9)})`]),
        ...(focused ? [[`\${globalId} === '${focused}'`, `color('#00e5ff', ${Math.max(alpha, 0.95)})`]] : []),
        ['true', `color('#ffffff', ${alpha})`],
      ] },
    });
  }

  function applyOptions() {
    if (!viewer) return;
    viewer.scene.globe.depthTestAgainstTerrain = !st.belowGround;
    if (!model) return;
    model.show = st.show;
    model.debugWireframe = st.wireframe;
    model.debugShowBoundingVolume = st.bounds;
  }

  // ---- selection ----

  function select(element, { zoom = false } = {}) {
    st.selected = element ?? null;
    if (!element) st.isolated = false;
    applyStyle();
    renderSide();
    if (element && zoom) zoomToElement(element);
  }
  function clearSelection() { st.selected = null; st.isolated = false; right.hidden = true; applyStyle(); }

  function elementSphere(element) {
    if (!element?.bbox) return null;
    const m = matrix();
    const { min, max } = element.bbox;
    const corners = [0, 1].flatMap(i => [0, 1].flatMap(j => [0, 1].map(k => Cartesian3.fromArray(transformPoint(m, [i ? max[0] : min[0], j ? max[1] : min[1], k ? max[2] : min[2]])))));
    return BoundingSphere.fromPoints(corners);
  }

  function zoomToElement(element) {
    const sphere = elementSphere(element);
    if (sphere) viewer.camera.flyToBoundingSphere(sphere, { duration: 0.9, offset: new HeadingPitchRange(viewer.camera.heading, CMath.toRadians(-35), Math.max(sphere.radius * 4, 45)) });
  }

  /** The connectivity validation of this model version (topology.js), for the model's developers. */
  function renderTopology() {
    const r = net?.topologyReport();
    const host = $('.isp-topo');
    if (!host || !r) return;
    const list = (label, ids) => `<dt>${esc(label)}</dt><dd>${ids.length ? esc(ids.join(', ')) : '<span class="isp-muted">none</span>'}</dd>`;
    host.innerHTML = `<dl class="isp-dl">
      <dt>Model</dt><dd>${esc(r.version)}</dd>
      <dt>Electrical assets</dt><dd>${r.counts.electricalAssets} · ${r.counts.ports} ports</dd>
      <dt>Port connections</dt><dd>${r.counts.physicalConnections}: ${r.counts.directedEdges} with a direction (SOURCE → SINK), ${r.counts.undirectedEdges} without (SOURCEANDSINK)</dd>
      <dt>Sources · loads</dt><dd>${r.counts.sources} · ${r.counts.loads}</dd>
      <dt>Loops</dt><dd>${r.counts.independentLoops} (rings and ties)</dd>
      ${list('Loads with a loop-in / loop-out', r.loadsAsFeedThrough)}${list('Loads unresolved (one port, two links)', r.loadsUnresolved)}
      ${list('Unconnected loads', r.unconnectedLoads)}${list('Not reachable from a source', r.notReachableFromSource)}
      ${list('Cables with a missing end', r.cablesWithMissingEnd)}${list('Voltage mismatches', r.voltageMismatches)}${list('Connected, no electrical role', r.unknownRole)}
      <dt>Not in this IFC</dt><dd class="isp-muted">${esc(r.notInIfc.join('; '))}</dd></dl>`;
  }

  // ---- camera ----

  function fitModel({ duration = 0.9 } = {}) {
    if (!model?.boundingSphere) return;
    viewer.camera.flyToBoundingSphere(model.boundingSphere, { duration, offset: new HeadingPitchRange(0, CMath.toRadians(-45), model.boundingSphere.radius * 2.2) });
  }
  // The view the screen first opened with (after its opening flight), for Reset view.
  let homeView = null;
  function rememberHomeView() {
    const save = () => {
      if (homeView || !viewer || viewer.isDestroyed()) return;
      const c = viewer.camera;
      homeView = { destination: Cartesian3.clone(c.positionWC), orientation: { heading: c.heading, pitch: c.pitch, roll: c.roll } };
    };
    // The opening flight (or an instant setView) ends with moveEnd; if none comes, the view as it is then.
    const off = viewer.camera.moveEnd.addEventListener(() => { off(); save(); });
    setTimeout(() => { off(); save(); }, 8000);
  }
  /** Back to the screen as it first opened: that view, nothing selected, focused or highlighted. */
  function resetView() {
    clearSelection();
    net?.resetView();
    renderSide();
    if (homeView) viewer.camera.flyTo({ destination: homeView.destination, orientation: homeView.orientation, duration: 1.2 });
    else if (net) net.frameAll(); else fitModel();
  }
  function zoom(factor) {
    const center = model?.boundingSphere?.center ?? viewer.camera.positionWC;
    const distance = Cartesian3.distance(viewer.camera.positionWC, center);
    viewer.camera.zoomIn(distance * factor);
  }
  /** Proportional zoom toward whatever is under the centre of the view (the wheel). */
  function wheelZoom(factor) {
    if (!viewer || viewer.isDestroyed()) return;
    const controller = viewer.scene.screenSpaceCameraController;
    viewer.camera.cancelFlight();
    const pivot = cameraPivot(viewer);
    const range = Cartesian3.distance(viewer.camera.positionWC, pivot);
    let move = range - zoomRange(range, factor, controller.minimumZoomDistance, controller.maximumZoomDistance);
    // Never through the ground: zooming in moves along the view, so stop above the site's ground level.
    if (move > 0) {
      const down = Math.max(0.05, Math.sin(-viewer.camera.pitch));
      const floor = (st.terrainHeight ?? 0) + 10;
      move = Math.max(0, Math.min(move, (viewer.camera.positionCartographic.height - floor) / down));
    }
    viewer.camera.zoomIn(move);
    viewer.scene.requestRender();
  }

  // ---- placement ----

  let rebuildTimer;
  function setPlacement(next, { preview = true } = {}) {
    st.placement = next;
    if (model && preview) model.modelMatrix = Matrix4.fromArray(matrix());
    renderHeader();
    // The network is drawn at the placement; redraw it there (a running simulation starts over).
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(buildNetwork, 300);
  }

  function openPlacement() {
    const p = st.placement;
    placePanel.hidden = false;
    placePanel.innerHTML = `<div class="isp-head"><b>Model placement</b><button type="button" class="isp-x" data-act="closePlacement" aria-label="Close placement">×</button></div>
      <p class="isp-muted">${st.georef?.mode === PLACEMENT_MODE.GEOREFERENCED
        ? `The file is georeferenced (IfcMapConversion, ${esc(st.georef.crs)}). Changing position, heading or scale makes the placement user-calibrated.`
        : 'The file has no usable georeferencing. Position it on the terminal; it is saved as user-calibrated.'}</p>
      <div class="isp-grid">
        <label>Longitude<input type="number" step="0.000001" data-p="lon" value="${p.lon.toFixed(7)}"></label>
        <label>Latitude<input type="number" step="0.000001" data-p="lat" value="${p.lat.toFixed(7)}"></label>
        <label>Elevation offset (m)<input type="number" step="0.1" data-p="heightOffset" value="${p.heightOffset}"></label>
        <label>Heading (°)<input type="number" step="0.1" data-p="headingDeg" value="${Number(p.headingDeg.toFixed(4))}"></label>
        <label>Scale<input type="number" step="0.001" min="0.001" data-p="scale" value="${p.scale}"></label>
      </div>
      <div class="isp-mode"></div>
      <div class="isp-ref"></div>
      <div class="isp-actions"><button type="button" class="isp-btn" data-act="alignReference" hidden>Align to terminal</button><button type="button" class="isp-btn" data-act="resetPlacement">Reset</button><button type="button" class="isp-btn is-primary" data-act="savePlacement">Save placement</button></div>
      <small class="isp-muted isp-saved"></small>`;
    renderPlacementMode();
    void loadReference().then(renderPlacementMode);
  }

  /** The documented alignment to the terminal (public/data/seagirt/ifc-reference-alignment.json), if it covers this file. */
  async function loadReference() {
    if (st.reference === null) {
      try { st.reference = await (await fetch(referenceUrl)).json(); } catch { st.reference = false; }
    }
    return st.reference && st.reference.appliesTo?.includes(st.fileName) ? st.reference : null;
  }
  const matchesReference = p => {
    const r = st.reference?.appliesTo?.includes(st.fileName) ? st.reference.placement : null;
    return Boolean(r && p && Math.abs(p.lon - r.lon) < 1e-7 && Math.abs(p.lat - r.lat) < 1e-7 && Math.abs(p.headingDeg - r.headingDeg) < 1e-3 && Math.abs(p.scale - r.scale) < 1e-4);
  };

  async function alignToReference() {
    const reference = await loadReference();
    if (!reference) return;
    const r = reference.placement;
    for (const [name, value] of Object.entries({ lon: r.lon.toFixed(7), lat: r.lat.toFixed(7), heightOffset: r.heightOffset, headingDeg: r.headingDeg, scale: r.scale })) {
      placePanel.querySelector(`[data-p="${name}"]`).value = value;
    }
    st.terrainHeight = await terrainHeightAt(r.lon, r.lat);
    setPlacement({ ...r, mode: PLACEMENT_MODE.CALIBRATED });
    renderPlacementMode();
  }

  function renderPlacementMode() {
    const mode = placePanel.querySelector('.isp-mode');
    if (!mode) return;
    const p = st.placement;
    mode.innerHTML = `<span class="isp-chip ${p.mode === PLACEMENT_MODE.GEOREFERENCED ? 'is-ok' : 'is-warn'}">${p.mode === PLACEMENT_MODE.GEOREFERENCED ? 'IFC georeferenced' : 'User calibrated'}</span>
      <span class="isp-muted">Vertical: model origin on the terrain${p.heightOffset ? ` ${p.heightOffset > 0 ? '+' : ''}${p.heightOffset} m` : ''}</span>`;
    placePanel.querySelector('.isp-saved').textContent = st.saved ? 'A saved placement is in use for this model version.' : 'No saved placement for this model version.';
    const reference = st.reference && st.reference.appliesTo?.includes(st.fileName) ? st.reference : null;
    placePanel.querySelector('[data-act="alignReference"]').hidden = !reference;
    placePanel.querySelector('.isp-ref').innerHTML = reference
      ? `<p class="isp-muted">${matchesReference(p) ? '<b>Aligned to the terminal:</b> ' : '<b>Align to terminal</b> fits the model to '}two quay corners from the OpenStreetMap terminal outline, through the reference image the model was drawn on (about 5–10 m). User-calibrated, not authoritative.</p>`
      : '';
  }

  async function placementEdited() {
    const value = name => Number(placePanel.querySelector(`[data-p="${name}"]`).value);
    const edited = { lon: value('lon'), lat: value('lat'), heightOffset: value('heightOffset'), headingDeg: value('headingDeg'), scale: value('scale') };
    if (Object.values(edited).some(n => !Number.isFinite(n)) || edited.scale <= 0) return;
    const moved = Math.abs(edited.lon - st.placement.lon) > 1e-9 || Math.abs(edited.lat - st.placement.lat) > 1e-9;
    const next = classifyEdit(st.georef, edited);
    if (moved) st.terrainHeight = await terrainHeightAt(next.lon, next.lat);
    setPlacement(next);
    renderPlacementMode();
  }

  async function savePlacement() {
    const saved = await request(`/placement?key=${st.manifest.key}`, { method: 'PUT', body: st.placement });
    st.saved = saved.saved;
    st.placement = { ...saved.saved };
    renderPlacementMode();
    renderHeader();
  }

  async function resetPlacement() {
    if (st.saved) await request(`/placement?key=${st.manifest.key}`, { method: 'DELETE' });
    st.saved = null;
    const base = defaultPlacement(st.georef) ?? { mode: PLACEMENT_MODE.CALIBRATED, lon: -76.5394, lat: 39.2569, heightOffset: 0, headingDeg: 0, scale: 1 };
    st.terrainHeight = await terrainHeightAt(base.lon, base.lat);
    setPlacement(base);
    openPlacement();
  }

  // ---- rendering ----

  // ---- ACC version check ----

  function startSync() {
    stopSync();
    if (syncIntervalMs > 0) sync.timer = setInterval(() => void checkForUpdate(), syncIntervalMs);
  }
  function stopSync() { clearInterval(sync.timer); sync.timer = null; }

  /**
   * Ask ACC (through the server, which re-reads the file list) for this model's latest version. A new
   * version is converted and loaded in place, keeping the view; during a simulation it waits, and the
   * chip offers it, so a what-if is not reset under the user.
   */
  async function checkForUpdate({ force = false } = {}) {
    if (compare.isActive() || sync.busy || !st.visible || st.phase !== 'ready' || !st.manifest || (!force && document.hidden)) return;
    sync.busy = true;
    renderSync();
    try {
      const list = await request('/models?refresh=1');
      st.project = list.project ?? st.project;
      st.models = list.models;
      sync.checkedAt = new Date();
      sync.error = null;
      const entry = list.models.find(item => item.fileName === st.fileName);
      sync.pending = entry && entry.versionId !== st.manifest.versionId ? entry : null;
    } catch (error) {
      sync.error = error;
    } finally {
      sync.busy = false;
      renderSync();
      renderHeader();
    }
    if (sync.pending && (force || !net?.state().scenario)) await applyUpdate();
  }

  async function applyUpdate() {
    if (!sync.pending) return;
    const keep = { selectedId: net?.state().selectedId ?? null };
    sync.updatedFrom = st.manifest?.versionNumber ?? null;
    sync.pending = null;
    await openModel({ keepView: true });
    if (keep.selectedId && net) net.selectAsset(keep.selectedId);
    renderSync();
  }

  function renderSync() {
    const chip = $('.isp-sync');
    const time = d => d?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) ?? '';
    const current = st.manifest?.versionNumber;
    let text, tone;
    if (sync.pending) { text = `ACC v${sync.pending.versionNumber} available · Load`; tone = 'is-warn'; }
    else if (sync.busy) { text = `ACC v${current ?? '?'} · checking…`; tone = ''; }
    else if (sync.error) { text = `ACC check failed · ${time(new Date())}`; tone = 'is-bad'; }
    else if (sync.checkedAt) { text = `ACC v${current ?? '?'}${sync.updatedFrom != null && sync.updatedFrom !== current ? ` (was v${sync.updatedFrom})` : ''} · checked ${time(sync.checkedAt)}`; tone = 'is-ok'; }
    else { text = current ? `ACC v${current}` : 'ACC'; tone = current ? 'is-ok' : ''; }
    chip.className = `isp-chip isp-sync ${tone}`;
    chip.textContent = text;
    chip.hidden = !st.manifest && !sync.error;
    const every = `every ${Math.round(syncIntervalMs / 1000)} s`;
    if (sync.error) chip.title = `The last check failed: ${sync.error.message ?? sync.error}. Click to try again.`;
    else chip.title = `Checks Autodesk ACC for a new version of the IFC model ${every}${sync.checkedAt ? ` (last ${sync.checkedAt.toLocaleTimeString()})` : ''}. Click to check now.`;
  }

  function renderHeader() {
    $('.isp-source').textContent = st.project ? `Autodesk Forma Data Management · ${st.project.name}` : 'Autodesk Forma Data Management';
    const conn = $('.isp-conn');
    const signIn = st.phase === 'error' && needsSignIn(st.error);
    conn.className = `isp-chip isp-conn ${signIn ? 'is-warn' : st.project ? 'is-ok' : st.phase === 'error' ? 'is-bad' : ''}`;
    conn.textContent = signIn ? 'Not signed in' : st.project ? 'Connected' : st.phase === 'error' ? 'Error' : 'Connecting…';
    const names = st.models.map(entry => entry.fileName);
    if (modelSelect.dataset.names !== names.join('|')) {
      modelSelect.innerHTML = names.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
      modelSelect.dataset.names = names.join('|');
    }
    modelSelect.value = st.fileName ?? '';
    modelSelect.disabled = !names.length || ['converting', 'placing', 'loading'].includes(st.phase);
    const entry = st.models.find(item => item.fileName === st.fileName);
    $('.isp-model-name').textContent = st.fileName ? `${st.fileName}${entry?.versionNumber ? ` · v${entry.versionNumber}` : ''}` : '';
    const conv = $('.isp-conv');
    const converting = st.phase === 'converting' || st.phase === 'loading' || st.phase === 'placing';
    conv.className = `isp-chip isp-conv ${st.manifest ? 'is-ok' : st.phase === 'error' ? 'is-bad' : ''}`;
    conv.textContent = st.manifest ? `Geometry converted${st.manifest.cached ? ' (cached)' : ''}` : converting ? 'Converting…' : st.phase === 'error' ? 'Not converted' : '';
    const place = $('.isp-place');
    place.hidden = !st.manifest;
    place.className = `isp-chip isp-place ${st.placement?.mode === PLACEMENT_MODE.GEOREFERENCED ? 'is-ok' : 'is-warn'}`;
    place.textContent = st.placement?.mode === PLACEMENT_MODE.GEOREFERENCED ? 'IFC georeferenced' : matchesReference(st.placement) ? 'User calibrated · aligned to terminal' : 'User calibrated';
    renderSync();
  }

  function renderSide() {
    const d = st.manifest?.diagnostics;
    const g = st.georef;
    $('.isp-diag').innerHTML = d ? `<dl class="isp-dl">
      <dt>Source</dt><dd>${esc(st.manifest.fileName)} · version ${esc(st.manifest.versionNumber)}</dd>
      <dt>IFC file</dt><dd>${bytes(d.sourceBytes)} · ${esc(d.schema)}</dd>
      <dt>IFC elements</dt><dd>${d.elements}</dd><dt>With geometry</dt><dd>${d.withGeometry}</dd><dt>Triangles</dt><dd>${d.triangles.toLocaleString()}</dd>
      <dt>Output</dt><dd>glTF (GLB) · ${bytes(d.glbBytes)}</dd><dt>Converter</dt><dd>${esc(d.library)}</dd>
      <dt>Converted</dt><dd>${esc(new Date(st.manifest.convertedAt).toLocaleString())}${st.manifest.cached ? ' (cached)' : ''}</dd>
      <dt>CRS</dt><dd>${g?.mode === PLACEMENT_MODE.GEOREFERENCED ? `${esc(g.crs)} ${esc(g.crsDescription ?? '')}, ${esc(g.verticalDatum ?? '')}` : 'none usable'}</dd>
      ${g?.siteCheck ? `<dt>IfcSite check</dt><dd>${g.siteCheck.metresFromMapOrigin} m from the map origin</dd>` : ''}
      </dl><button type="button" class="isp-link" data-act="reconvert">Convert again</button>` : '<p class="isp-muted">Not converted yet.</p>';
    renderMapping();
    renderDetails();
  }

  function renderMapping() {
    const box = $('.isp-mapping');
    if (!st.elements.length) { box.innerHTML = '<p class="isp-muted">Available once the model is loaded.</p>'; return; }
    if (!st.mapping) { box.innerHTML = '<p class="isp-muted">Comparing…</p>'; void loadMapping(); return; }
    if (st.mapping.error) { box.innerHTML = `<p class="isp-muted">${esc(st.mapping.error)}</p>`; return; }
    const m = st.mapping;
    const row = ref => `<button type="button" class="isp-row" data-gid="${esc(ref.globalId)}"><span>${esc(ref.name)}</span><small>${esc(ref.globalId)}</small></button>`;
    const pair = entry => `<div class="isp-pair ${entry.verdict === 'AMBIGUOUS' ? 'is-amb' : ''}"><b>${esc(entry.assetId)}</b> <small>${esc(entry.assetType.toLowerCase().replaceAll('_', ' '))}</small>${entry.ifc.map(row).join('')}<small>${entry.reasons.map(esc).join(' ')}</small></div>`;
    box.innerHTML = `<p class="isp-muted">Compared with the electrical twin's ${m.summary.twinAssets} illustrative assets. Nothing is linked or changed.</p>
      <details open><summary>Exact identifier candidates <span class="isp-badge">${m.candidates.length}</span></summary>${m.candidates.map(pair).join('') || '<p class="isp-muted">None.</p>'}</details>
      <details open><summary>Ambiguous or conflicting <span class="isp-badge">${m.ambiguous.length}</span></summary>${m.ambiguous.map(pair).join('') || '<p class="isp-muted">None.</p>'}</details>
      <details><summary>Twin assets not in the IFC <span class="isp-badge">${m.assetsOnly.length}</span></summary><p class="isp-chips">${m.assetsOnly.map(a => `<span>${esc(a.assetId)}</span>`).join('')}</p></details>
      <details><summary>IFC elements with no twin asset <span class="isp-badge">${m.ifcOnly.length}</span></summary>${m.ifcOnly.map(row).join('')}</details>
      <details><summary>IFC elements missing metadata <span class="isp-badge">${m.missingMetadata.length}</span></summary>${m.missingMetadata.map(entry => `<button type="button" class="isp-row" data-gid="${esc(entry.globalId)}"><span>${esc(entry.name)}</span><small>missing ${esc(entry.missing.join(', '))}</small></button>`).join('')}</details>`;
  }

  async function loadMapping() {
    if (st.mapping) return;
    st.mapping = { pending: true };
    try {
      st.assets ??= (await (await fetch(assetsUrl)).json()).assets;
      // Only elements with a GlobalId; the comparison is keyed by it.
      const elements = st.elements.filter(element => element.globalId).map(element => {
        const category = CATEGORIES.find(c => c.test({ ...element, name: element.name ?? '' }));
        return { ...element, dbId: element.featureId, electrical: Boolean(category?.electrical) };
      });
      st.mapping = compareAssets(elements, st.assets);
    } catch (error) { st.mapping = { error: `The electrical twin's assets could not be read (${error?.message ?? error}).` }; }
    renderMapping();
  }

  function renderDetails() {
    const e = st.selected;
    right.hidden = !e;
    if (!e) return;
    const props = e.properties ?? {};
    const electricalSets = Object.entries(props).filter(([name]) => /^SuperDNA_PowerNetwork$|^Pset_/i.test(name));
    const otherSets = Object.entries(props).filter(([name]) => !/^SuperDNA_PowerNetwork$|^Pset_/i.test(name));
    const table = values => `<table class="isp-props"><tbody>${Object.entries(values).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v === null || v === '' ? '<span class="isp-muted">(empty)</span>' : esc(v)}</td></tr>`).join('')}</tbody></table>`;
    right.innerHTML = `<div class="isp-head"><span class="isp-kicker">${esc(categoryOf(e))}</span><button type="button" class="isp-x" data-act="clear" aria-label="Clear selection">×</button></div>
      <h2 class="isp-title">${esc(e.name ?? '(no name)')}</h2>
      <dl class="isp-dl">
        <dt>IFC GlobalId</dt><dd>${esc(e.globalId ?? 'not in file')}</dd><dt>IFC class</dt><dd>${esc(e.ifcClass)}${e.predefinedType ? ` · ${esc(e.predefinedType)}` : ''}</dd>
        <dt>NetworkID</dt><dd>${e.networkId ? esc(e.networkId) : '<span class="isp-muted">not in file</span>'}</dd>
        ${e.tag ? `<dt>Tag</dt><dd>${esc(e.tag)}</dd>` : ''}
        <dt>Source</dt><dd>${esc(st.manifest?.fileName)} · v${esc(st.manifest?.versionNumber)}</dd>
        <dt>Feature</dt><dd>glTF feature ${e.featureId ?? '—'} · STEP #${e.expressId}</dd>
      </dl>
      <div class="isp-actions"><button type="button" class="isp-btn" data-act="zoomSel">Zoom to</button>
        <button type="button" class="isp-btn" data-act="isolate">${st.isolated ? 'Show all' : 'Isolate'}</button>
        <button type="button" class="isp-btn" data-act="clear">Clear</button></div>
      <div class="isp-sec">Documents</div>
      ${docs.index() ? documentListHtml(elementDocuments(e)) : '<p class="isp-muted isp-doc-none">Reading the asset documentation from ACC…</p>'}
      ${electricalSets.length ? electricalSets.map(([name, values]) => `<details class="isp-group" open><summary>${esc(name)}</summary>${table(values)}</details>`).join('') : '<p class="isp-muted">No electrical property set on this element.</p>'}
      ${otherSets.map(([name, values]) => `<details class="isp-group"><summary>${esc(name)}</summary>${table(values)}</details>`).join('')}`;
  }

  // ---- asset documentation (documentsPanel.js): PDFs in ACC Docs linked to the model's assets ----

  const docs = createDocumentsPanel({
    host: root, fileName: () => st.fileName,
    onIndex: index => { net?.setDocuments(index); if (st.selected) renderDetails(); },
    onSelectAsset: assetId => {
      $('[data-act="docs"]').setAttribute('aria-pressed', 'false');
      // A network asset opens on its Documents tab; any other element (MSS, a rack row) in the element panel.
      if (net?.selectAsset(assetId, { zoom: true })) { net.setAssetTab('documents'); return; }
      const element = st.elements.find(e => e.networkId === assetId || e.tag === assetId);
      if (element) select(element, { zoom: true });
    },
  });
  /**
   * Ask the Twin's read-only access to IFC versions: the file's versions in ACC, the server's
   * comparison (cached there), and opening the comparison viewer on a result.
   */
  const compareTools = {
    fileName: () => st.fileName,
    versions: async () => (await request(`/versions?file=${encodeURIComponent(st.fileName)}`)).versions,
    compare: (base, target) => request(`/compare?file=${encodeURIComponent(st.fileName)}&base=${base}&target=${target}`, { method: 'POST' }),
    active: () => { const c = compare.isActive() ? compare.state() : null; return c?.base && c?.target ? { base: c.base, target: c.target } : null; },
    async open(base, target, { focus = null, ids = null, status = null } = {}) {
      const c = compare.isActive() ? compare.state() : null;
      if (!c || c.base !== base || c.target !== target) await compare.start(base, target);
      if (!compare.isActive()) return;
      if (focus) compare.select(focus);
      else if (ids?.length) compare.focusIds(ids);
      else if (status) compare.filterStatus(status);
    },
  };

  /** The documents of an IFC element: linked to its GlobalId, or to its NetworkID / Tag. */
  function elementDocuments(e) {
    const id = e.networkId ?? e.tag;
    return (docs.index()?.documents ?? []).filter(d => d.mapping?.status === 'matched' && (d.mapping.ifcGlobalId === e.globalId || (id && d.mapping.assetId === id)));
  }

  // ---- version comparison (compareMode.js): its own two viewers; this screen's viewer is paused meanwhile ----

  const compare = createCompareMode({
    host: $('.isp-compare-host'), request,
    context: () => ({ fileName: st.fileName, placement: st.placement, terrainHeight: st.terrainHeight, base: st.base, googleOffset: st.googleOffset, ionToken, camera: viewer?.camera ?? null }),
    onEnter: () => {
      net?.clearPanel();
      root.classList.add('is-comparing');
      $('[data-act="compare"]').setAttribute('aria-pressed', 'true');
      if (viewer) viewer.useDefaultRenderLoop = false;
    },
    onExit: () => {
      root.classList.remove('is-comparing');
      $('[data-act="compare"]').setAttribute('aria-pressed', 'false');
      if (viewer && !viewer.isDestroyed()) { viewer.useDefaultRenderLoop = true; viewer.resize(); viewer.scene.requestRender(); }
    },
  });

  // ---- events ----


  // Header tooltips: one floating tip (the toolbar scrolls sideways, so a CSS ::after inside it would be clipped).
  const tip = document.createElement('div');
  tip.className = 'isp-tip'; tip.setAttribute('role', 'tooltip'); tip.hidden = true;
  root.append(tip);
  const showTip = el => {
    const text = el?.dataset.tip;
    if (!text) { tip.hidden = true; return; }
    tip.textContent = text; tip.hidden = false;
    const r = el.getBoundingClientRect(), host = root.getBoundingClientRect(), w = tip.offsetWidth;
    tip.style.left = `${Math.max(4, Math.min(host.width - w - 4, r.left - host.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${r.bottom - host.top + 6}px`;
  };
  const top = $('.isp-top');
  top.addEventListener('pointerover', e => showTip(e.target.closest('[data-tip]')));
  top.addEventListener('pointerleave', () => { tip.hidden = true; });
  top.addEventListener('focusin', e => showTip(e.target.closest('[data-tip]')));
  top.addEventListener('focusout', () => { tip.hidden = true; });
  top.addEventListener('click', () => { tip.hidden = true; });

  root.addEventListener('click', event => {
    const target = event.target.closest('button, a');
    if (!target || !root.contains(target)) return;
    if (net?.onClick(event)) { if (!netPanel.hidden) right.hidden = true; return; }
    if (target.dataset.gid) { select(st.byGlobalId.get(target.dataset.gid), { zoom: true }); return; }
    if (target.dataset.act === 'more') {
      const panelEl = $('.isp-more-panel');
      panelEl.hidden = !panelEl.hidden;
      target.setAttribute('aria-expanded', String(!panelEl.hidden));
      return;
    }
    if (target.dataset.toggle) { toggleView(target.dataset.toggle); return; }
    if (target.dataset.act === 'docs') { const open = docs.toggle(); target.setAttribute('aria-pressed', String(open)); return; }
    if (target.dataset.act === 'compare') { if (st.phase === 'ready' && !compare.isActive()) void compare.openDialog(); return; }
    if (target.dataset.act === 'syncNow') { if (sync.pending) void applyUpdate(); else void checkForUpdate({ force: true }); return; }
    if (target.dataset.base) { if (target.dataset.base !== st.base) void setBase(target.dataset.base); return; }
    if (target.dataset.ws) { setWorkspace(target.dataset.ws); return; }
    switch (target.dataset.cam) {
      case 'fit': if (net) net.frameAll(); else fitModel(); return;
      case 'in': zoom(0.35); return;
      case 'out': zoom(-0.6); return;
      case 'left': orbitView(viewer, -ROTATE_STEP_DEG, 0); return;
      case 'right': orbitView(viewer, ROTATE_STEP_DEG, 0); return;
      // As on the PortMiami twin: up looks down more steeply onto the site, down levels the view.
      case 'up': orbitView(viewer, 0, -TILT_STEP_DEG); return;
      case 'down': orbitView(viewer, 0, TILT_STEP_DEG); return;
      case 'home': resetView(); return;
      case 'reset': clearSelection(); renderSide(); if (net) net.frameAll(); else fitModel(); return;
      default: break;
    }
    switch (target.dataset.act) {
      case 'clear': clearSelection(); renderSide(); break;
      case 'zoomSel': if (st.selected) zoomToElement(st.selected); break;
      case 'isolate': st.isolated = !st.isolated; applyStyle(); renderDetails(); break;
      case 'placement': openPlacement(); break;
      case 'closePlacement': placePanel.hidden = true; break;
      case 'savePlacement': void savePlacement().catch(fail); break;
      case 'resetPlacement': void resetPlacement().catch(fail); break;
      case 'alignReference': void alignToReference().catch(fail); break;
      case 'reconvert': void openModel({ force: true }); break;
      case 'retry': if (st.models.length && !needsSignIn(st.error)) void openModel(); else void connect(); break;
      default: break;
    }
  });
  let editTimer;
  placePanel.addEventListener('input', () => { clearTimeout(editTimer); editTimer = setTimeout(() => { void placementEdited(); }, 250); });
  root.addEventListener('change', event => {
    const layer = event.target.dataset?.layer;
    if (layer) { st.layers[layer] = event.target.checked; applyLayers(); return; }
    const opt = event.target.dataset?.opt;
    if (!opt) return;
    if (opt === 'opacity') { st.opacity = Number(event.target.value); applyStyle(); return; }
    st[opt] = event.target.checked;
    applyOptions();
  });
  root.querySelector('[data-opt="opacity"]').addEventListener('input', event => { st.opacity = Number(event.target.value); applyStyle(); });
  modelSelect.addEventListener('change', () => { st.fileName = modelSelect.value; onModelChange(st.fileName); placePanel.hidden = true; void openModel(); });

  /**
   * What a click means: an asset symbol under the cursor wins over the cable that ends at it, and
   * the Google base map is looked through; otherwise the first thing drawn there.
   */
  function pickThrough(position) {
    const tileset = google?.tileset();
    const isBase = p => tileset && (p?.primitive === tileset || p?.tileset === tileset);
    const hits = viewer.scene.drillPick(position, 6).filter(p => !isBase(p));
    // An asset's own icon wins over another asset's alert pill drawn across it.
    const icon = hits.find(p => p.primitive instanceof Billboard && /^node:/.test(p.id?.id ?? ''));
    return icon ?? hits.find(p => p.primitive instanceof Billboard) ?? hits[0];
  }

  function pickAt(position) {
    // Drawing an area: its clicks are corners, never a selection.
    if (net?.areaDrawing?.()) return null;
    const picked = pickThrough(position);
    if (net?.pick(picked)) { right.hidden = true; return { globalId: net.state().selectedId }; }
    if (picked && picked.primitive === model && typeof picked.getProperty === 'function') {
      const element = st.byGlobalId.get(picked.getProperty('globalId')) ?? st.byFeature.get(picked.featureId);
      // An element of the network (or a crane's steel) opens the network panel; anything else, its IFC properties.
      if (element && net?.pick(null, element.globalId)) { right.hidden = true; return element; }
      if (element) { netPanel.hidden = true; select(element); return element; }
    }
    clearSelection();
    renderSide();
    return null;
  }

  async function createViewer() {
    const container = document.createElement('div');
    container.id = 'ifcSpatialContainer';
    container.className = 'isp-cesium';
    $('.isp-map').replaceChildren(container);
    renderer = new CesiumRenderer();
    viewer = await renderer.init(container.id, { ionToken });
    viewer.animation.container.style.display = 'none';
    viewer.timeline.container.style.display = 'none';
    viewer.forceResize();
    // The mouse: wheel zooms toward what is in the centre of the view, left-drag pans, right-drag (or
    // middle-drag, or Ctrl + left-drag) turns and tilts; pinch zooms on a touchpad or screen.
    const controller = viewer.scene.screenSpaceCameraController;
    Object.assign(controller, { enableInputs: true, enableRotate: true, enableTranslate: true, enableZoom: true, enableTilt: true, enableLook: true,
      minimumZoomDistance: 5, maximumZoomDistance: 60000 });
    controller.zoomEventTypes = [CameraEventType.PINCH];
    controller.tiltEventTypes = [CameraEventType.RIGHT_DRAG, CameraEventType.MIDDLE_DRAG, CameraEventType.PINCH, { eventType: CameraEventType.LEFT_DRAG, modifier: KeyboardEventModifier.CTRL }];
    viewer.canvas.addEventListener('wheel', event => {
      event.preventDefault();
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewer.canvas.clientHeight : 1);
      wheelZoom(Math.exp(Math.max(-0.4, Math.min(0.4, pixels * 0.002))));
    }, { passive: false });
    viewer.canvas.addEventListener('contextmenu', event => event.preventDefault());
    // The terminal, before any model is loaded.
    viewer.camera.setView({ destination: Cartesian3.fromDegrees(-76.5394, 39.2490, 1900), orientation: { heading: 0, pitch: CMath.toRadians(-85), roll: 0 } });
    handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(event => { pickAt(event.position); }, ScreenSpaceEventType.LEFT_CLICK);
    google = createGooglePhotorealistic3DService(viewer, { apiKey: import.meta.env?.VITE_GOOGLE_MAPS_API_KEY });
    void applyBase();
  }

  function destroyViewer() {
    loadToken += 1;
    handler?.destroy();
    handler = null;
    net?.destroy();
    net = null;
    google?.destroy();
    google = null;
    removeModel();
    if (viewer && !viewer.isDestroyed()) viewer.destroy();
    viewer = null;
    renderer = null;
    $('.isp-map').replaceChildren();
  }

  const api = {
    root,
    async show() {
      if (st.visible) return;
      st.visible = true;
      root.hidden = false;
      setPhase('starting', 'Starting the map…');
      await createViewer();
      if (!st.visible) return;
      startSync();
      if (st.models.length) await openModel(); else await connect();
      // Keep the refresh loader over the first complete model/map frame. Errors and
      // sign-in prompts are already rendered by connect/openModel and must remain accessible.
      if (st.phase === 'ready' && viewer && st.visible) {
        await new Promise(resolve => {
          const scene = viewer.scene;
          // The initial framing flight lasts 0.9 seconds; wait for it before checking tiles.
          const started = performance.now();
          const remove = scene.postRender.addEventListener(() => {
            // Capped: imagery that never finishes (offline, blocked provider) must not trap the loader.
            const waited = performance.now() - started;
            if (waited < 1000 || (!scene.globe.tilesLoaded && waited < 10_000)) {
              scene.requestRender();
              return;
            }
            remove();
            resolve();
          });
          scene.requestRender();
        });
      }
    },
    hide() {
      if (!st.visible) return;
      st.visible = false;
      root.hidden = true;
      placePanel.hidden = true;
      stopSync();
      if (compare.isActive()) compare.exit();
      destroyViewer();
      st.phase = 'idle';
    },
    destroy() { stopSync(); destroyViewer(); docs.destroy(); root.remove(); },
    state: () => ({
      ops: net?.opsState() ?? null,
      visible: st.visible, phase: st.phase, error: st.error,
      sync: { checkedAt: sync.checkedAt?.toISOString() ?? null, pending: sync.pending?.versionNumber ?? null, error: sync.error?.code ?? (sync.error ? 'ERROR' : null), version: st.manifest?.versionNumber ?? null },
      base: { map: st.base, google: Boolean(google?.tileset()?.show), note: st.baseNote, offset: st.googleOffset }, fileName: st.fileName, models: st.models.map(m => ({ fileName: m.fileName, status: m.status, versionNumber: m.versionNumber })),
      manifest: st.manifest && { key: st.manifest.key, cached: st.manifest.cached, diagnostics: st.manifest.diagnostics, versionId: st.manifest.versionId },
      elementCount: st.elements.length, selectable: st.byFeature.size,
      selected: st.selected && { globalId: st.selected.globalId, name: st.selected.name, ifcClass: st.selected.ifcClass, featureId: st.selected.featureId },
      isolated: st.isolated, placement: st.placement, saved: st.saved, terrainHeight: st.terrainHeight,
      viewerAlive: Boolean(viewer && !viewer.isDestroyed()), modelLoaded: Boolean(model?.ready),
      /** 3D IFC models in the scene (the overlay's own primitives are not counted). */
      primitives: viewer ? Array.from({ length: viewer.scene.primitives.length }, (_, i) => viewer.scene.primitives.get(i)).filter(p => p instanceof Model).length : 0,
      modelMatrix: model ? Matrix4.toArray(model.modelMatrix) : null, mapping: st.mapping?.summary ?? null,
      network: net?.state() ?? null, layers: { ...st.layers, geometry: st.show },
    }),
    /** Screen position (page px) of a network asset's symbol or route midpoint. */
    assetScreenPosition(id) {
      const a = net?.network.assets.get(id);
      if (!a || !viewer) return null;
      const p = a.route?.length ? a.route[Math.floor(a.route.length / 2)] : { lon: a.location.longitude, lat: a.location.latitude };
      const w = SceneTransforms.worldToWindowCoordinates(viewer.scene, Cartesian3.fromDegrees(p.lon, p.lat, 2), new Cartesian2());
      const box = viewer.canvas.getBoundingClientRect();
      return w && { x: box.left + w.x, y: box.top + w.y };
    },
    ask: q => net?.ask(q),
    scenario: id => net?.runScenario(id),
    selectAsset: id => net?.selectAsset(id, { zoom: true }),
    /** Run the ACC version check now (the timer does it every syncIntervalMs). */
    checkForUpdate: () => checkForUpdate({ force: true }),
    /** Where an element's bounding-box centre is on screen (CSS pixels, page coordinates), for clicking it in tests. */
    screenPositionOf(globalId) {
      const element = st.byGlobalId.get(globalId);
      if (!element?.bbox || !viewer) return null;
      const center = element.bbox.min.map((v, i) => (v + element.bbox.max[i]) / 2);
      const p = SceneTransforms.worldToWindowCoordinates(viewer.scene, Cartesian3.fromArray(transformPoint(matrix(), center)), new Cartesian2());
      const box = viewer.canvas.getBoundingClientRect();
      return p && { x: box.left + p.x, y: box.top + p.y };
    },
    pickAt: (x, y) => { const box = viewer.canvas.getBoundingClientRect(); return pickAt(new Cartesian2(x - box.left, y - box.top))?.globalId ?? null; },
    select: globalId => select(st.byGlobalId.get(globalId), { zoom: true }),
    find: text => st.elements.filter(element => `${element.name} ${element.networkId} ${element.ifcClass}`.toLowerCase().includes(String(text).toLowerCase())).map(element => element.globalId),
    tilesLoaded: () => Boolean(viewer?.scene.globe.tilesLoaded),
    /** Everything under a page position, front to back (diagnosis). */
    drillAt: (x, y) => { const box = viewer.canvas.getBoundingClientRect(); return viewer.scene.drillPick(new Cartesian2(x - box.left, y - box.top), 8).map(p => p.id?.id ?? p.primitive?.constructor?.name ?? '?'); },
    /** What Cesium returns for a pick at a page position (tests and diagnosis). */
    pickInfo: (x, y) => {
      const box = viewer.canvas.getBoundingClientRect();
      const picked = pickThrough(new Cartesian2(x - box.left, y - box.top));
      const at = picked ? viewer.scene.pickPosition(new Cartesian2(x - box.left, y - box.top)) : null;
      const local = at && model ? Matrix4.multiplyByPoint(Matrix4.inverse(model.modelMatrix, new Matrix4()), at, new Cartesian3()) : null;
      return picked ? { type: picked.constructor?.name, isModel: picked.primitive === model, featureId: picked.featureId ?? null,
        globalId: typeof picked.getProperty === 'function' ? picked.getProperty('globalId') : null,
        local: local && [local.x, local.y, local.z].map(v => Math.round(v * 100) / 100) } : null;
    },
  };
  window.__ifcSpatial = Object.freeze({ state: api.state, screenPositionOf: api.screenPositionOf, pickAt: api.pickAt, select: api.select, find: api.find, tilesLoaded: api.tilesLoaded, pickInfo: api.pickInfo, drillAt: api.drillAt,
    assetScreenPosition: api.assetScreenPosition, ask: api.ask, scenario: api.scenario, selectAsset: api.selectAsset, checkForUpdate: api.checkForUpdate, documents: Object.freeze({ load: docs.load, openPreview: docs.openPreview, closePreview: docs.closePreview, toggle: docs.toggle, state: docs.state }), investigate: id => net?.investigate(id) ?? false,
    markerScreenPosition: id => net?.markerScreenPosition(id) ?? null,
    askHighlights: Object.freeze({ state: () => net?.askState() ?? null, screenPosition: id => net?.askScreenPosition(id) ?? null }),
    focus: Object.freeze({ asset: id => net?.focus(id) ?? false, state: () => net?.focusState() ?? null }),
    supply: id => net?.supply(id) ?? null, topologyReport: () => net?.topologyReport() ?? null,
    cameraInfo: () => (viewer && !viewer.isDestroyed() ? { headingDeg: Math.round(CMath.toDegrees(viewer.camera.heading)), pitchDeg: Math.round(CMath.toDegrees(viewer.camera.pitch)),
      heightM: Math.round(viewer.camera.positionCartographic.height) } : null), compare: Object.freeze({ ...compare }), routeInfo: id => net?.routeInfo(id) ?? null,
    // Select Area: select a ring of [lon, lat] as if drawn; screen points of a ring; an asset's position; clear.
    area: Object.freeze({ select: (ring, mode) => net?.selectArea(ring, mode) ?? false, screen: ring => net?.areaScreen(ring) ?? [], clear: () => net?.clearArea(),
      lonLat: id => net?.assetLonLat(id) ?? null, drawing: () => net?.areaDrawing() ?? false }) });
  return api;
}
