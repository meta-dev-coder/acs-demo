/**
 * IFC version comparison, inside the IFC Spatial Twin screen: two versions of one ACC file side by
 * side, each in its own Cesium viewer, with the changes the server computed (server/ifcSpatial/
 * compare.mjs) as a design-change review.
 *
 * Why two viewers: the design shows each version whole, side by side. Cesium's split (swipe) shows
 * one place half in each version, and entities (the network overlay, the change annotations) cannot
 * be split at all. The cost is a second Google tileset session while comparing; the screen's own
 * viewer is paused (not destroyed) meanwhile, so Exit returns to it as it was.
 *
 * Adaptive to the size of the change set (changeGroups.js): up to 10 changes, every change on its own;
 * from 31 (settings), Significant Changes by default (added, removed, moved, geometry, connectivity;
 * property-only changes listed but not painted), the panel in change groups, and the map in
 * per-group clusters that split as the user zooms in.
 *
 * Map modes, one set of entities built once per comparison (switching only shows and hides):
 *  - All Changes (default): every change in its colour, the unchanged network faded and unlabelled,
 *    compact change labels (close ones of the same kind grouped: "+2 New Lights").
 *  - Focus on Change (selecting a change): that change prominent and framed, old and new positions
 *    both in view, the other changes dimmed.
 *  - Full Network: the network and its labels as on the screen, the changes still highlighted.
 *
 * Cameras: whichever view the user last pressed, scrolled or touched leads; after each of its frames
 * the other follows where they differ. Only the leader copies, so there is no echo.
 *
 * Read-only: nothing here writes to ACC.
 */
import {
  Cartesian2, Cartesian3, Cartographic, Cesium3DTileStyle, Color, ColorBlendMode, CustomDataSource, Ellipsoid, HorizontalOrigin,
  Math as CMath, Matrix4, Model, NearFarScalar, PolylineArrowMaterialProperty, PolylineDashMaterialProperty, SceneTransforms, ScreenSpaceEventHandler,
  ScreenSpaceEventType, VerticalOrigin, Axis, BoundingSphere, HeadingPitchRange,
} from 'cesium';
import { CesiumRenderer } from '../renderers/cesium.js';
import { createGooglePhotorealistic3DService } from '../basePhotorealistic3D.js';
import { defaultPlacement, modelMatrixFor, PLACEMENT_MODE, transformPoint } from './placement.js';
import { buildIfcNetwork, symbolOf } from './ifcNetwork.js';
import { createNetworkOverlay } from './networkOverlay.js';
import { tileImage } from './mockStyle.js';
import { flowDirections, networkState } from './networkTwin.js';
import { buildGroups, categoryOf, clusterLabel, densityOf, DENSITY_THRESHOLDS, isSignificant, modificationClasses, robustPoints } from './changeGroups.js';

/** One colour per kind of change, everywhere: annotations, model highlight, panel. */
export const CHANGE_COLORS = Object.freeze({ ADDED: '#2fbf71', REMOVED: '#e5484d', MOVED: '#8b5cf6', MODIFIED: '#f59e0b', SELECTED: '#ffd400' });
const LABEL = { ADDED: 'Added', REMOVED: 'Removed', MOVED: 'Moved', MODIFIED: 'Modified' };
const MODES = Object.freeze({ FOCUS: 'focus', SIGNIFICANT: 'significant', ALL: 'all', FULL: 'full' });
const GROUP_ICONS = {
  breaker: '<rect x="5" y="3" width="10" height="14" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 7h4M8 10h4M10 13v2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  switchgear: '<rect x="4" y="3" width="12" height="14" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7.5 6v8M10 6v8M12.5 6v8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  light: '<path d="M7 12.5c-1.6-1-2.5-2.6-2.5-4.4a5.5 5.5 0 0 1 11 0c0 1.8-.9 3.4-2.5 4.4V15H7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 17.5h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  cable: '<path d="M4 15c3 0 3-10 6-10s3 10 6 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="4" cy="15" r="1.6" fill="currentColor"/><circle cx="16" cy="15" r="1.6" fill="currentColor"/>',
  transformer: '<circle cx="10" cy="7.5" r="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="10" cy="12.5" r="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  crane: '<path d="M5 17 7.5 5M15 17 12.5 5M4 5h12M6.5 11h7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  control: '<rect x="4" y="5" width="12" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 17h4M10 14v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  network: '<circle cx="5" cy="13" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="15" cy="13" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6.6 11.8C8 6 12 6 13.4 11.8" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  properties: '<path d="m5 15 1-3.4 6.5-6.5 2.4 2.4-6.5 6.5zM11.4 6.2l2.4 2.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  other: '<rect x="5" y="5" width="10" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/>',
};
const groupIcon = icon => `<svg viewBox="0 0 20 20" width="22" height="22" aria-hidden="true">${GROUP_ICONS[icon] ?? GROUP_ICONS.other}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const cap = s => String(s ?? '').replace(/^./, c => c.toUpperCase());
const title = s => String(s ?? '').replace(/\b\w/g, c => c.toUpperCase());
const fmtDate = iso => { if (!iso) return ''; const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const fmtLonLat = g => (g ? `${g.lat.toFixed(6)}, ${g.lon.toFixed(6)}` : '—');
const fmtM = n => (Number.isFinite(n) ? `${n >= 100 ? Math.round(n) : n.toFixed(n >= 10 ? 1 : 2)} m` : '—');
const plural = (n, word) => `${word}${n === 1 ? '' : 's'}`;

/** The row title, as on the design: "New Light HM-12", "Switchgear UTIL-A", "Cable Routing C-UA". */
export function changeTitle(c) {
  const id = c.networkId ?? c.name ?? c.globalId;
  // The asset category the change groups use (a breaker is a Circuit Breaker, not switchgear).
  const category = categoryOf(c);
  const kind = category.key === 'other' ? title(c.kind) : category.one;
  if (c.status === 'ADDED') return `New ${kind} ${id}`;
  if (c.status === 'REMOVED') return `Removed ${kind} ${id}`;
  const kinds = new Set((c.modifications ?? []).map(m => m.kind));
  if (c.status === 'MODIFIED' && kinds.has('route')) return `Cable Routing ${id}`;
  if (c.status === 'MODIFIED' && kinds.has('ports')) return `${kind} Connections ${id}`;
  return `${kind} ${id}`;
}

/** The row's one line: "Relocated 515 m · also modified", "IfcLightFixture · Added". */
export function changeLine(c) {
  if (c.status === 'ADDED') return `${c.ifcClass} · Added`;
  if (c.status === 'REMOVED') return `${c.ifcClass} · Removed`;
  if (c.status === 'MOVED') return `Relocated ${fmtM(c.displacement?.distanceM)}${c.modified ? ' · also modified' : ''}`;
  const kinds = new Set((c.modifications ?? []).map(m => m.kind));
  const parts = [kinds.has('route') && 'Routing', kinds.has('ports') && 'Connections', kinds.has('geometry') && 'Geometry', kinds.has('rotation') && 'Rotation',
    kinds.has('properties') && 'Properties'].filter(Boolean);
  return `${parts.join(', ') || 'Element'} modified`;
}

const ICONS = {
  ADDED: '<path d="M10 5v10M5 10h10" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>',
  REMOVED: '<path d="M5 10h10" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>',
  MOVED: '<path d="M3.5 10h13M6.5 7 3.5 10l3 3M13.5 7l3 3-3 3" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
  MODIFIED: '<path d="m6 14 1-3.4 6-6 2.4 2.4-6 6zM12 5.6l2.4 2.4" fill="none" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/>',
};
const changeIcon = status => `<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">${ICONS[status]}</svg>`;

// ---- map labels: a pill with a pointer, measured so the text always fits ----

const FONT = 'system-ui, -apple-system, "Segoe UI", Arial, sans-serif';
let measurer = null;
const textWidth = (text, font) => {
  measurer ??= globalThis.document?.createElement('canvas')?.getContext('2d') ?? null;
  if (!measurer) return text.length * 7.6;
  measurer.font = font;
  return measurer.measureText(text).width;
};
const DARK = { ADDED: '#14532d', REMOVED: '#7f1d1d', MOVED: '#4c1d95', MODIFIED: '#78350f' };
/** A label pill (one or two lines) with a pointer at the bottom centre: the image's bottom is the anchor. */
export function pillImage({ lines, status, level = 0, pointer = true, strong = false, shift = 0, below = false }) {
  const fonts = [`700 13px ${FONT}`, `700 13px ${FONT}`];
  const widths = lines.map((l, i) => Math.ceil(textWidth(l, fonts[i])));
  const w = Math.max(...widths) + 24;
  const h = lines.length === 2 ? 40 : 26;
  const stem = pointer ? 10 + level * 30 : 0;
  const height = h + stem + 2;
  const border = CHANGE_COLORS[status];
  // The pointer sits at the asset; with the pill shifted (to stay inside the view) it moves the other way.
  const px = Math.min(Math.max(w / 2 - shift, 8), w - 8);
  const tspans = lines.map((l, i) => `<text x="${w / 2}" y="${lines.length === 2 ? 17 + i * 16 : 18}" text-anchor="middle" font-family='${FONT}' font-size="13" font-weight="700" fill="#fff" textLength="${widths[i]}" lengthAdjust="spacingAndGlyphs">${esc(l)}</text>`).join('');
  // Below the asset: the same drawing turned over (pointer up), with the text upright.
  const flip = below ? ` transform="translate(0 ${height}) scale(1 -1)"` : '';
  const textY = below ? height - h : 0;
  const tspansAt = below ? tspans.replace(/ y="(\d+(?:\.\d+)?)"/g, (m, y) => ` y="${Number(y) + textY}"`) : tspans;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w + 4}" height="${height}" viewBox="-2 0 ${w + 4} ${height}"><g${flip}>
  ${pointer ? `<path d="M${px - 7} ${h - 1} L${px} ${h + 7} L${px + 7} ${h - 1} Z" fill="${DARK[status]}" stroke="${border}" stroke-width="1.6"/><line x1="${px}" y1="${h + 7}" x2="${px}" y2="${height - 1}" stroke="${border}" stroke-width="1.6"/>` : ''}
  <rect x="0.8" y="0.8" width="${w - 1.6}" height="${h - 1.6}" rx="7" fill="${DARK[status]}" fill-opacity="0.96" stroke="${strong ? '#ffffff' : border}" stroke-width="${strong ? 2 : 1.6}"/>
  ${pointer ? `<path d="M${px - 6} ${h - 2.2} H${px + 6}" stroke="${DARK[status]}" stroke-width="2.4"/>` : ''}</g>${tspansAt}</svg>`;
  return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width: w + 4, height };
}

/**
 * @param {object} o
 * @param {HTMLElement} o.host        the map area the comparison covers
 * @param {Function}    o.request     the screen's API request helper (path relative to /api/ifc-spatial)
 * @param {Function}    o.context     () => {fileName, placement, terrainHeight, base: 'google'|'simple', ionToken, camera}
 * @param {Function}    o.onEnter / o.onExit
 */
export function createCompareMode({ host, request, context, onEnter = () => {}, onExit = () => {}, thresholds = DENSITY_THRESHOLDS }) {
  const root = document.createElement('section');
  root.className = 'isp-cmp';
  root.setAttribute('aria-label', 'Compare IFC versions');
  root.hidden = true;
  const layersIcon = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="m10 3 7.5 4L10 11 2.5 7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m2.5 10.5 7.5 4 7.5-4M2.5 13.8l7.5 4 7.5-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const fitIcon = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M3 7V3h4M17 7V3h-4M3 13v4h4M17 13v4h-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  const exitIcon = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M8 4H4v12h4M12 6l4 4-4 4M16 10H8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  root.innerHTML = `
    <div class="isp-cmp-panes">
      <div class="isp-cmp-pane" data-side="0"><div class="isp-cmp-map"></div><div class="isp-cmp-tag"></div></div>
      <div class="isp-cmp-divider" role="separator" aria-orientation="vertical" aria-label="Drag to resize the two views" tabindex="0"></div>
      <div class="isp-cmp-pane" data-side="1"><div class="isp-cmp-map"></div><div class="isp-cmp-tag"></div></div>
    </div>
    <aside class="isp-cmp-panel" aria-label="Design changes"></aside>
    <div class="isp-cmp-legend" aria-label="Legend"></div>
    <div class="isp-cmp-bar" role="toolbar" aria-label="Comparison">
      <button type="button" class="isp-cmp-versions" data-cmp="dialog">${layersIcon}<span></span></button>
      <div class="isp-cmp-modes" role="group" aria-label="Map mode">
        <button type="button" data-cmp-mode="focus">Focus on Change</button><button type="button" data-cmp-mode="all">All Changes</button><button type="button" data-cmp-mode="full">Full Network</button>
      </div>
      <label class="isp-cmp-sync"><input type="checkbox" data-cmp-opt="sync" checked> Sync Views</label>
      <button type="button" class="isp-cmp-fit" data-cmp="reset" title="Fit both views to the changes" aria-label="Fit both views to the changes">${fitIcon}</button>
      <button type="button" class="isp-cmp-exit" data-cmp="exit">${exitIcon} Exit Compare</button>
    </div>
    <div class="isp-cmp-wait" hidden></div>`;
  host.append(root);
  const dialog = document.createElement('div');
  dialog.className = 'isp-cmp-dialog-wrap';
  dialog.hidden = true;
  host.append(dialog);
  const $ = s => root.querySelector(s);
  const panel = $('.isp-cmp-panel');

  const st = { active: false, versions: null, base: null, target: null, result: null, selected: null, mode: MODES.ALL, sync: true,
    leader: 1, split: 50, filter: null, busy: null, error: null, token: 0, panelCollapsed: false,
    // Adaptive: the density, the groups (and each change's group), the selected / hidden / expanded groups.
    density: 'small', groups: [], groupOf: new Map(), groupsById: new Map(), group: null, hiddenGroups: new Set(), openGroup: null, groupSearch: '',
    panelView: 'list', listSearch: '', returnMode: MODES.ALL,
    // A set of changes handed over by Ask the Twin: only those are shown until "Show all".
    only: null };
  const groupCache = new Map();
  const sides = [null, null];
  // ---- version dialog ----

  async function openDialog() {
    const { fileName } = context();
    dialog.hidden = false;
    dialog.innerHTML = `<div class="isp-cmp-dialog isp-card" role="dialog" aria-modal="true" aria-label="Compare versions"><h2>Compare versions</h2><p class="isp-muted">Reading the versions of ${esc(fileName)} from ACC…</p></div>`;
    try {
      st.versions = await request(`/versions?file=${encodeURIComponent(fileName)}`);
    } catch (error) {
      dialog.innerHTML = `<div class="isp-cmp-dialog isp-card" role="alertdialog" aria-label="Compare versions"><h2>Compare versions</h2>
        <p class="isp-err">${esc(error.message)}</p><small class="isp-muted">Code ${esc(error.code ?? 'ERROR')}</small>
        <div class="isp-actions"><button type="button" class="isp-btn" data-cmp="cancel">Close</button></div></div>`;
      return;
    }
    const list = st.versions.versions;
    const option = v => `<option value="${esc(v.versionNumber)}">V${esc(v.versionNumber)}${v.latest ? ' (latest)' : ''} · ${esc(fmtDate(v.createTime ?? v.lastModifiedTime))}${v.createUserName ? ` · ${esc(v.createUserName)}` : ''}${v.status === 'converted' ? '' : ' · not converted yet'}</option>`;
    const [latest, previous] = [list[0], list[1]];
    dialog.innerHTML = `<form class="isp-cmp-dialog isp-card" role="dialog" aria-modal="true" aria-label="Compare versions">
      <h2>Compare versions</h2>
      <dl class="isp-dl"><dt>Model</dt><dd>${esc(st.versions.fileName)}</dd></dl>
      ${list.length < 2 ? '<p class="isp-err">This file has only one version in ACC: there is nothing to compare it with.</p>' : `
      <label class="isp-field">Base version<select name="base">${list.map(option).join('')}</select></label>
      <label class="isp-field">Compare with<select name="target">${list.map(option).join('')}</select></label>
      <p class="isp-err" data-cmp-msg hidden></p>
      <small class="isp-muted">Versions not converted yet are downloaded from ACC and converted on the server first. Nothing is written to ACC.</small>`}
      <div class="isp-actions"><button type="button" class="isp-btn" data-cmp="cancel">Cancel</button>
        ${list.length < 2 ? '' : '<button type="submit" class="isp-btn is-primary">Compare versions</button>'}</div></form>`;
    const form = dialog.querySelector('form');
    if (list.length >= 2) {
      form.base.value = String(st.base?.versionNumber ?? previous.versionNumber);
      form.target.value = String(st.target?.versionNumber ?? latest.versionNumber);
    }
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (form.base.value === form.target.value) {
        const msg = form.querySelector('[data-cmp-msg]');
        msg.hidden = false; msg.textContent = 'Choose two different versions.';
        return;
      }
      dialog.hidden = true;
      void start(Number(form.base.value), Number(form.target.value));
    });
    form.base?.focus();
  }

  // ---- entering, loading, leaving ----

  function setBusy(text) {
    st.busy = text;
    const wait = $('.isp-cmp-wait');
    wait.hidden = !text;
    if (text) wait.innerHTML = `<div class="isp-card isp-wait"><span class="isp-spinner" aria-hidden="true"></span>${esc(text)}</div>`;
  }

  async function start(baseNumber, targetNumber) {
    const ctx = context();
    const mine = ++st.token;
    if (!st.active) { st.active = true; root.hidden = false; onEnter(); st.split = 50; applySplit(); }
    st.error = null; st.selected = null; st.filter = null; st.mode = MODES.ALL; st.group = null; st.hiddenGroups = new Set(); st.openGroup = null; st.only = null;
    panel.innerHTML = '';
    setBusy(`Converting and comparing V${baseNumber} and V${targetNumber} from ACC…`);
    let result;
    try {
      result = await request(`/compare?file=${encodeURIComponent(ctx.fileName)}&base=${baseNumber}&target=${targetNumber}`, { method: 'POST' });
    } catch (error) {
      if (mine !== st.token) return;
      setBusy(null);
      st.error = error;
      panel.innerHTML = `<div class="isp-dc-top"><div class="isp-dc-head"><div><h2>Comparison failed</h2></div></div></div><div class="isp-dc-scroll"><p class="isp-err">${esc(error.message)}</p>
        <p class="isp-dc-sub">Code ${esc(error.code ?? 'ERROR')}</p><div class="isp-actions"><button type="button" class="isp-btn" data-cmp="dialog">Choose versions</button><button type="button" class="isp-btn" data-cmp="exit">Exit compare</button></div></div>`;
      return;
    }
    if (mine !== st.token) return;
    st.result = result;
    st.base = result.baseVersion; st.target = result.targetVersion;
    // Groups, once per comparison (cached by its id and the thresholds).
    const key = `${result.id}|${thresholds.small}|${thresholds.medium}`;
    if (!groupCache.has(key)) groupCache.set(key, buildGroups(result.changes ?? []));
    st.groups = groupCache.get(key);
    st.groupsById = new Map(st.groups.map(g => [g.id, g]));
    st.groupOf = new Map(st.groups.flatMap(g => g.members.map(c => [c, g])));
    st.density = densityOf(result.summary.listed ?? result.summary.total, thresholds);
    st.mode = st.density === 'large' ? MODES.SIGNIFICANT : MODES.ALL;
    st.returnMode = st.mode;
    st.panelView = st.density === 'large' ? 'groups' : 'list';
    setBusy('Loading both versions into the map…');
    const manifests = [result.baseManifest, result.targetManifest];
    try {
      for (const side of [0, 1]) {
        if (!sides[side]) sides[side] = await createSide(side, ctx);
        if (mine !== st.token) return;
        await loadVersion(sides[side], manifests[side], ctx, mine);
        if (mine !== st.token) return;
      }
    } catch (error) {
      if (mine !== st.token) return;
      setBusy(null);
      panel.innerHTML = `<h2 class="isp-title">The versions could not be shown</h2><p class="isp-err">${esc(error.message ?? error)}</p>`;
      return;
    }
    setBusy(null);
    copyCamera(ctx.camera);
    buildAnnotations();
    renderPanel();
    renderBar();
    resetCamera();
  }

  async function createSide(side, ctx) {
    const pane = root.querySelector(`.isp-cmp-pane[data-side="${side}"]`);
    const mapEl = pane.querySelector('.isp-cmp-map');
    mapEl.id = `ifcCompare${side}`;
    const renderer = new CesiumRenderer();
    const viewer = await renderer.init(mapEl.id, { ionToken: ctx.ionToken });
    viewer.animation.container.style.display = 'none';
    viewer.timeline.container.style.display = 'none';
    viewer.scene.screenSpaceCameraController.minimumZoomDistance = 5;
    viewer.forceResize();
    const s = { side, pane, viewer, renderer, model: null, overlay: null, network: null, markers: new CustomDataSource(`changes-${side}`), elements: new Map(), google: null, labels: [] };
    await viewer.dataSources.add(s.markers);
    // The same base map as the screen: Google Photorealistic 3D or the simple map.
    if (ctx.base === 'google') {
      s.google = createGooglePhotorealistic3DService(viewer, { apiKey: import.meta.env?.VITE_GOOGLE_MAPS_API_KEY });
      const ok = await s.google.enable();
      if (ok.ok && ctx.googleOffset) {
        const g = s.google.tileset();
        const up = Ellipsoid.WGS84.geodeticSurfaceNormal(Cartesian3.fromDegrees(ctx.placement.lon, ctx.placement.lat), new Cartesian3());
        g.modelMatrix = Matrix4.fromTranslation(Cartesian3.multiplyByScalar(up, ctx.googleOffset, new Cartesian3()));
        g.style = new Cesium3DTileStyle({ color: "color('#b4b4b4')" });
      }
    } else {
      const layer = viewer.imageryLayers.get(0);
      if (layer) { layer.brightness = 0.62; layer.saturation = 0.8; }
    }
    // The leader is whichever view was last used.
    for (const type of ['pointerdown', 'wheel', 'touchstart']) mapEl.addEventListener(type, () => { st.leader = side; }, { passive: true });
    viewer.scene.postRender.addEventListener(() => syncFrom(s));
    // Labels are laid out again whenever this view's camera comes to rest.
    viewer.camera.moveEnd.addEventListener(() => layoutLabels(s));
    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(event => pickAt(s, event.position), ScreenSpaceEventType.LEFT_CLICK);
    s.handler = handler;
    return s;
  }

  async function loadVersion(s, manifest, ctx, mine) {
    if (s.model) { s.viewer.scene.primitives.remove(s.model); s.model = null; }
    s.overlay?.destroy(); s.overlay = null;
    s.markers.entities.removeAll();
    const index = await request(manifest.elementsUrl.replace(/^\/api\/ifc-spatial/, ''));
    if (mine !== st.token) return;
    s.manifest = manifest;
    s.elements = new Map(index.elements.map(e => [e.globalId, e]));
    // Each version where the screen places the model: its own georeferencing, or the screen's calibration.
    const georef = manifest.placement?.georeferenced ?? null;
    const placement = ctx.placement?.mode === PLACEMENT_MODE.GEOREFERENCED ? (defaultPlacement(georef) ?? ctx.placement) : ctx.placement;
    s.matrix = modelMatrixFor(placement, georef, ctx.terrainHeight);
    s.toLonLat = (x, y, z = 0) => {
      const c = Cartographic.fromCartesian(Cartesian3.fromArray(transformPoint(s.matrix, [x, y, z])), Ellipsoid.WGS84);
      return { lon: CMath.toDegrees(c.longitude), lat: CMath.toDegrees(c.latitude), height: c.height };
    };
    const model = await Model.fromGltfAsync({ url: manifest.glbUrl, modelMatrix: Matrix4.fromArray(s.matrix), upAxis: Axis.Z, forwardAxis: Axis.X,
      enableDebugWireframe: true, colorBlendMode: ColorBlendMode.HIGHLIGHT, allowPicking: true });
    if (mine !== st.token) { model.destroy?.(); return; }
    s.model = s.viewer.scene.primitives.add(model);
    await new Promise((resolve, reject) => {
      const done = s.model.readyEvent.addEventListener(() => { done(); resolve(); });
      const bad = s.model.errorEvent?.addEventListener?.(error => { bad?.(); reject(error); });
    });
    s.model.debugWireframe = true;
    // The electrical network of this version, drawn as on the screen (normal state, live flow).
    const built = buildIfcNetwork({ elements: index.elements, connections: index.connections ?? [], toLonLat: s.toLonLat });
    s.network = built.network;
    s.built = built;
    s.overlay = createNetworkOverlay(s.viewer, { built: { assets: [...built.network.assets.values()] }, modelToLonLat: s.toLonLat, baseHeight: ctx.terrainHeight });
    s.overlay.setVisible({ network: true, control: false, zones: true, labels: false });
    s.viewer.scene.requestRender();
  }

  function exit() {
    st.token += 1;
    for (const side of [0, 1]) {
      const s = sides[side];
      if (!s) continue;
      s.handler?.destroy();
      s.overlay?.destroy();
      s.google?.destroy();
      if (!s.viewer.isDestroyed()) s.viewer.destroy();
      s.pane.querySelector('.isp-cmp-map').replaceChildren();
      sides[side] = null;
    }
    st.active = false; st.result = null; st.selected = null;
    root.hidden = true; dialog.hidden = true;
    setBusy(null);
    onExit();
  }

  // ---- camera ----

  function copyCamera(camera, targets = [0, 1]) {
    if (!camera) return;
    for (const side of targets) {
      const v = sides[side]?.viewer;
      if (!v) continue;
      // World coordinates: a camera that flew to a target can carry a local reference frame.
      v.camera.setView({ destination: Cartesian3.clone(camera.positionWC), orientation: { direction: Cartesian3.clone(camera.directionWC), up: Cartesian3.clone(camera.upWC) } });
    }
  }

  const cameraKey = c => [c.positionWC, c.directionWC, c.upWC].flatMap(v => [v.x, v.y, v.z]).map(n => n.toFixed(3)).join(',');

  /**
   * After the leading view renders, the other follows wherever the two differ (also when the
   * follower was moved some other way, by a flight still running, say: that flight is cancelled).
   */
  function syncFrom(s) {
    if (!st.sync || s.side !== st.leader) return;
    const other = sides[1 - s.side];
    if (!other) return;
    if (cameraKey(s.viewer.camera) === cameraKey(other.viewer.camera)) return;
    other.viewer.camera.cancelFlight();
    copyCamera(s.viewer.camera, [other.side]);
  }

  function lonLatOf(c, which) {
    const at = which === 'before' ? c.before : c.after;
    const s = sides[which === 'before' ? 0 : 1];
    return at?.model && s ? s.toLonLat(...at.model) : null;
  }

  /** Frame points in the leading view (the other follows); the margin is wider than usual, as each view is half the width. */
  function flyTo(points, { range = 160, margin = 3 } = {}) {
    const lead = sides[st.leader] ?? sides[1];
    if (!lead || !points.length) return;
    const sphere = BoundingSphere.fromPoints(points.map(p => Cartesian3.fromDegrees(p.lon, p.lat, p.height ?? 0)));
    st.leader = lead.side;
    const offset = new HeadingPitchRange(lead.viewer.camera.heading, CMath.toRadians(-50), Math.max(range, sphere.radius * margin));
    lead.viewer.camera.flyToBoundingSphere(sphere, { duration: 0.9, offset });
    if (!st.sync) sides[1 - lead.side]?.viewer.camera.flyToBoundingSphere(sphere, { duration: 0.9, offset });
  }

  /** Frame what the map shows now (far outliers left out), or the whole network when nothing changed. */
  function resetCamera() {
    const shown = changes().filter(shownOnMap);
    let points = (shown.length ? shown : changes()).flatMap(c => [lonLatOf(c, 'before'), lonLatOf(c, 'after')]).filter(Boolean);
    points = robustPoints(points);
    if (!points.length) for (const s of sides) if (s?.network) for (const a of s.network.assets.values()) if (Number.isFinite(a.location?.longitude)) points.push({ lon: a.location.longitude, lat: a.location.latitude, height: a.location.height });
    flyTo(points, { range: 500, margin: st.density === 'large' ? 2.5 : 4.6 });
  }

  // ---- what is shown ----

  const changes = () => st.result?.changes ?? [];
  const groupOf = c => st.groupOf.get(c) ?? null;
  const visible = c => (!st.filter || c.status === st.filter) && !st.hiddenGroups.has(groupOf(c)?.id);
  /** On the map now: by filter, hidden groups, the selected group, and Significant Changes. */
  const shownOnMap = c => visible(c) && (!st.only || st.only.has(c.globalId)) && (!st.group || groupOf(c)?.id === st.group) && (st.mode !== MODES.SIGNIFICANT || isSignificant(c) || c === st.selected);
  const sideHas = (c, side) => (side === 0 ? c.status !== 'ADDED' : c.status !== 'REMOVED');
  const idOn = (c, side) => (side === 0 ? (c.baseGlobalId ?? c.globalId) : c.globalId);

  /** The network asset a change is about, on one side (by NetworkID, else by GlobalId). */
  function assetOf(s, c, side) {
    if (!s?.network) return null;
    if (c.networkId && s.network.assets.has(c.networkId)) return c.networkId;
    return s.built?.assetByGlobalId.get(idOn(c, side))?.id ?? null;
  }

  /**
   * Annotations per side, built once per comparison: a label pill per change end, and for a move
   * the ghost, the arc and its distance. Modes and filters only show and hide them (refresh).
   */
  function buildAnnotations() {
    for (const s of sides) if (s) { s.markers.entities.removeAll(); s.labels = []; s.extras = []; }
    if (!st.result) return;
    const h = context().terrainHeight + 3;
    for (const c of changes()) {
      const id = c.networkId ?? c.name ?? c.globalId;
      const g = groupOf(c);
      const one = g?.one?.replace(/^(New|Removed|Relocated) /, '') ?? title(c.kind);
      const [before, after] = [lonLatOf(c, 'before'), lonLatOf(c, 'after')];
      const label = (side, at, lines, priority) => {
        const s = sides[side];
        if (!s || !at) return;
        const entity = s.markers.entities.add({ id: `cmp:${side}:${c.globalId}:${s.labels.length}`, position: Cartesian3.fromDegrees(at.lon, at.lat, h), properties: { globalId: c.globalId }, show: false,
          billboard: { image: pillImage({ lines, status: c.status }).url, verticalOrigin: VerticalOrigin.BOTTOM, horizontalOrigin: HorizontalOrigin.CENTER,
            disableDepthTestDistance: Number.POSITIVE_INFINITY, eyeOffset: new Cartesian3(0, 0, -4), scaleByDistance: new NearFarScalar(300, 1, 6000, 0.85) } });
        s.labels.push({ entity, change: c, lines, priority, position: entity.position.getValue(), group: g?.id ?? c.status });
      };
      const priority = { MOVED: 1, ADDED: 2, REMOVED: 3, MODIFIED: isSignificant(c) ? 4 : 6 }[c.status];
      if (c.status === 'ADDED') label(1, after, [`New ${one}`, id], priority);
      else if (c.status === 'REMOVED') label(0, before, [`Removed ${one}`, id], priority);
      else if (c.status === 'MOVED') {
        label(0, before, [`${id} (Original)`], priority);
        label(1, after, [`${id} (New Location)`], priority);
        if (before && after) drawMove(sides[1], c, before, after, h);
        if (before && sides[0]) drawGhost(sides[0], c, after, h, 0.55);
      } else {
        label(0, before, [changeLine(c), id], priority);
        label(1, after, [changeLine(c), id], priority);
      }
    }
    refresh();
  }

  /** Show what the mode, filters and selection call for; restyle; lay the labels out again. */
  function refresh() {
    for (const s of sides) for (const x of s?.extras ?? []) x.entity.show = shownOnMap(x.change) && (st.mode !== MODES.FOCUS || x.change === st.selected || !st.selected);
    applyStyles();
    for (const s of sides) if (s) layoutLabels(s);
  }

  /** V3: the old position as a dashed ghost of the asset, a dashed arc to the new one, the distance at its top. */
  function drawMove(s, c, from, to, h) {
    drawGhost(s, c, from, h, 0.85);
    const meters = c.displacement?.distanceM ?? 0;
    const lift = Math.min(Math.max(meters * 0.18, 20), 140);
    const points = Array.from({ length: 33 }, (_, i) => {
      const t = i / 32;
      return Cartesian3.fromDegrees(from.lon + (to.lon - from.lon) * t, from.lat + (to.lat - from.lat) * t, h + 2 + Math.sin(Math.PI * t) * lift);
    });
    const purple = Color.fromCssColorString(CHANGE_COLORS.MOVED);
    s.extras.push({ change: c, entity: s.markers.entities.add({ id: `cmp:arc:${c.globalId}`, properties: { globalId: c.globalId },
      polyline: { positions: points.slice(0, 30), width: 3, material: new PolylineDashMaterialProperty({ color: purple.withAlpha(0.95), gapColor: Color.TRANSPARENT, dashLength: 14 }),
        depthFailMaterial: new PolylineDashMaterialProperty({ color: purple.withAlpha(0.6), dashLength: 14 }) } }) });
    s.extras.push({ change: c, entity: s.markers.entities.add({ id: `cmp:arrow:${c.globalId}`, properties: { globalId: c.globalId },
      polyline: { positions: points.slice(28), width: 14, material: new PolylineArrowMaterialProperty(purple), depthFailMaterial: new PolylineArrowMaterialProperty(purple.withAlpha(0.6)) } }) });
    const top = points[16];
    const img = pillImage({ lines: [`Moved ${fmtM(meters)}`], status: 'MOVED', pointer: false });
    const entity = s.markers.entities.add({ id: `cmp:dist:${c.globalId}`, position: top, properties: { globalId: c.globalId }, show: false,
      billboard: { image: img.url, verticalOrigin: VerticalOrigin.BOTTOM, pixelOffset: new Cartesian2(0, -6), disableDepthTestDistance: Number.POSITIVE_INFINITY, eyeOffset: new Cartesian3(0, 0, -4) } });
    // The distance yields to the assets' own labels.
    s.labels.push({ entity, change: c, lines: [`Moved ${fmtM(meters)}`], priority: 5, position: top, group: 'dist', fixed: true });
  }

  /** The asset's own tile, dashed and faint, where it was (or will be). */
  function drawGhost(s, c, at, h, alpha) {
    const asset = s.network?.assets.get(c.networkId);
    const kind = asset ? symbolOf(asset) : 'vault';
    const url = tileImage(kind ?? 'vault', { tint: CHANGE_COLORS.MOVED });
    s.extras.push({ change: c, entity: s.markers.entities.add({ id: `cmp:ghost:${s.side}:${c.globalId}`, position: Cartesian3.fromDegrees(at.lon, at.lat, h), properties: { globalId: c.globalId },
      billboard: { image: url, width: 30, height: 30, color: Color.WHITE.withAlpha(alpha), disableDepthTestDistance: Number.POSITIVE_INFINITY } }) });
  }

  /**
   * Label layout for one view, after each camera move. First, labels of the same change group that
   * are close on screen are clustered into one ("+12 New Circuit Breakers"; wider apart for a large
   * comparison), so clusters split as the user zooms in; then clusters are placed by priority, each
   * lifted on a longer pointer, below its asset, or slid sideways if it would overlap one already
   * placed, and kept inside the view (the pointer still points at the asset). A label that cannot be
   * placed is left out; its asset stays highlighted.
   */
  function layoutLabels(s) {
    const scene = s.viewer.scene;
    const box = s.viewer.canvas.getBoundingClientRect();
    const focus = st.mode === MODES.FOCUS && st.selected;
    const items = [];
    const priorityOf = l => (l.change === st.selected ? 0 : l.priority);
    for (const l of [...(s.labels ?? [])].sort((a, b) => priorityOf(a) - priorityOf(b))) {
      // Small comparisons keep their clean look: modified elements are labelled in focus or with the full network.
      const show = focus ? l.change === st.selected
        : shownOnMap(l.change) && !(st.density === 'small' && st.mode !== MODES.FULL && l.change.status === 'MODIFIED');
      l.entity.show = false;
      if (!show) continue;
      const p = SceneTransforms.worldToWindowCoordinates(scene, l.position, new Cartesian2());
      if (!p || p.x < -40 || p.y < -40 || p.x > box.width + 40 || p.y > box.height + 40) continue;
      items.push({ l, p });
    }
    // 1. Clusters: the same change group, near on screen.
    const [rx, ry] = st.density === 'large' ? [220, 120] : [140, 70];
    const groups = [];
    for (const it of items) {
      const g = !focus && !it.l.fixed && groups.find(x => x.group === it.l.group && Math.abs(x.p.x - it.p.x) < rx && Math.abs(x.p.y - it.p.y) < ry);
      if (g) g.members.push(it.l); else groups.push({ group: it.l.group, p: it.p, lead: it.l, members: [it.l] });
    }
    // 2. Placement.
    const placed = [];
    for (const g of groups) {
      const l = g.lead;
      const n = g.members.length;
      const status = l.change.status;
      const names = g.members.map(m => m.change.networkId ?? m.change.name);
      const groupInfo = st.groupsById.get(l.group);
      const lines = n > 1 ? [groupInfo ? clusterLabel(groupInfo, n) : `+${n} ${LABEL[status]}`, names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ')] : l.lines;
      const pointer = !l.fixed;      // Candidates: straight up, lifted, then slid left or right (the pointer stays on the asset).
      const base = pillImage({ lines, status: l.fixed ? 'MOVED' : status, pointer, strong: l.change === st.selected });
      const slides = pointer ? [0, -0.35, 0.35] : [0, -0.6, 0.6];
      // Above the asset (lifted up to twice), then below it, then lifted higher.
      const candidates = [];
      const add = (levels, below) => { for (const level of levels) for (const f of slides) candidates.push([level, f * base.width, below]); };
      if (pointer) { add([0, 1, 2], false); add([0, 1], true); add([3, 4, 5], false); } else { add([0, 1, 2], false); add([0, 1], true); }
      for (const [level, slide, below] of candidates) {
        const [left, right] = [g.p.x - base.width / 2 + slide, g.p.x + base.width / 2 + slide];
        // Inside the view, with an 8 px margin.
        const shift = slide + (left < 8 ? 8 - left : right > box.width - 8 ? box.width - 8 - right : 0);
        // The pointer has to stay on the pill.
        if (pointer && Math.abs(shift) > base.width / 2 - 6) continue;
        const x0 = g.p.x - base.width / 2 + shift;
        const pill = base.height - 12;
        // A pointerless label (the distance on the arc) moves by its offset instead.
        const dy = pointer ? 0 : below ? 10 + level * 30 : -6 - level * 30;
        const r = !pointer ? { x0, x1: x0 + base.width, y0: g.p.y + dy - (below ? 0 : base.height), y1: g.p.y + dy + (below ? base.height : 0) }
          : below ? { x0, x1: x0 + base.width, y0: g.p.y + 10 + level * 30, y1: g.p.y + 10 + level * 30 + pill }
          : { x0, x1: x0 + base.width, y0: g.p.y - base.height - level * 30, y1: g.p.y - 10 - level * 30 };
        if (r.y0 < 4 || r.y1 > box.height - 4) continue;
        if (placed.some(q => overlaps(q, r))) continue;
        const img = pillImage({ lines, status: l.fixed ? 'MOVED' : status, level: pointer ? level : 0, pointer, strong: l.change === st.selected, shift: pointer ? shift : 0, below: pointer && below });
        l.entity.billboard.verticalOrigin = below ? VerticalOrigin.TOP : VerticalOrigin.BOTTOM;
        placed.push(r);
        l.shownLines = lines;
        setImage(l, img);
        l.entity.billboard.pixelOffset = new Cartesian2(shift, dy);
        l.entity.show = true;
        break;
      }
    }
    s.viewer.scene.requestRender();
  }
  const overlaps = (a, b) => a.x0 < b.x1 + 4 && b.x0 < a.x1 + 4 && a.y0 < b.y1 + 4 && b.y0 < a.y1 + 4;
  const setImage = (l, img) => { if (l.image !== img.url) { l.image = img.url; l.entity.billboard.image = img.url; } };

  /**
   * The IFC model and the network per side, for the mode: what the map shows in its change colour
   * (a property-only change lighter, without glow), the selection yellow, the rest faded. The model
   * is coloured by a lookup per feature, not one style condition per changed element.
   */
  function applyStyles() {
    const sel = st.selected?.status === 'UNCHANGED' ? null : st.selected;
    const focus = st.mode === MODES.FOCUS && sel;
    for (const s of sides) {
      if (!s?.model) continue;
      const colors = new Map();
      for (const c of changes()) {
        if (!shownOnMap(c) || !sideHas(c, s.side)) continue;
        const alpha = focus && c !== sel ? 0.35 : isSignificant(c) ? 0.95 : 0.6;
        colors.set(idOn(c, s.side), Color.fromCssColorString(CHANGE_COLORS[c.status]).withAlpha(alpha));
      }
      if (st.selected) for (const g of [st.selected.globalId, st.selected.baseGlobalId].filter(Boolean)) colors.set(g, Color.fromCssColorString(CHANGE_COLORS.SELECTED).withAlpha(0.95));
      const rest = Color.WHITE.withAlpha(st.mode === MODES.FULL ? 0.45 : 0.1);
      const style = new Cesium3DTileStyle();
      style.color = {
        evaluateColor: (feature, result) => Color.clone(colors.get(feature.getProperty('globalId')) ?? rest, result ?? new Color()),
        evaluate: feature => Color.clone(colors.get(feature.getProperty('globalId')) ?? rest),
      };
      s.model.style = style;
      if (s.overlay && s.network) {
        const highlight = new Map();
        for (const c of changes()) {
          if (!shownOnMap(c) || !sideHas(c, s.side)) continue;
          const id = assetOf(s, c, s.side);
          if (id) highlight.set(id, isSignificant(c) ? CHANGE_COLORS[c.status] : { hex: CHANGE_COLORS[c.status], weak: true });
        }
        const selId = sel ? assetOf(s, sel, s.side) : null;
        // Significant / All: the changes shown stand out; Focus: only the selected one; Full Network: everything.
        const focusSet = focus ? new Set([selId].filter(Boolean)) : st.mode === MODES.FULL && !st.group ? null : new Set(highlight.keys());
        s.overlay.update({ ...networkState(s.network, null), flowDir: flowDirections(s.network, null), selectedId: selId,
          focus: focusSet, emphasise: false, stateLabels: false, alert: null, highlight, dimAlpha: st.mode === MODES.FULL ? 0.3 : 0.2 });
        s.overlay.setVisible({ labels: st.mode === MODES.FULL, control: false });
      }
      s.viewer.scene.requestRender();
    }
  }

  // ---- selection ----

  function pickAt(s, position) {
    st.leader = s.side;
    const picked = s.viewer.scene.drillPick(position, 6).find(p => !(s.google?.tileset() && (p.primitive === s.google.tileset() || p.tileset === s.google.tileset())));
    let globalId = picked?.id?.properties?.globalId?.getValue?.() ?? null;
    if (!globalId && picked?.primitive === s.model && typeof picked.getProperty === 'function') globalId = picked.getProperty('globalId');
    if (!globalId && s.overlay) {
      const assetId = s.overlay.assetAt(picked);
      const change = assetId ? changes().find(c => assetOf(s, c, s.side) === assetId) : null;
      globalId = change?.globalId ?? (assetId ? s.network.assets.get(assetId)?.globalId ?? null : null);
    }
    if (!globalId) return null;
    select(globalId, { fly: false });
    return globalId;
  }

  /** Select by GlobalId: a change switches to Focus on Change and frames it; an unchanged element says so. */
  function select(globalId, { fly = true } = {}) {
    const change = changes().find(c => c.globalId === globalId || c.baseGlobalId === globalId);
    if (st.mode !== MODES.FOCUS) st.returnMode = st.mode;
    if (change) {
      st.selected = change;
      st.mode = MODES.FOCUS;
    } else {
      const [a, b] = [sides[0]?.elements.get(globalId), sides[1]?.elements.get(globalId)];
      const e = b ?? a;
      st.selected = e ? { globalId, status: 'UNCHANGED', name: e.name, networkId: e.networkId, ifcClass: e.ifcClass } : null;
    }
    refresh();
    renderPanel();
    renderBar();
    if (fly && change) focusCamera(change);
  }

  /** Frame a change; a move frames both its ends, however far apart. */
  function focusCamera(c) {
    const points = [lonLatOf(c, 'before'), lonLatOf(c, 'after')].filter(Boolean);
    flyTo(points, { range: c.status === 'MOVED' ? 260 : 180, margin: c.status === 'MOVED' ? 4.2 : 3 });
  }

  function setMode(mode) {
    if (mode === MODES.FOCUS && !st.selected) {
      const first = changes().find(c => shownOnMap(c));
      if (first) { select(first.globalId); return; }
    }
    st.mode = mode;
    if (mode !== MODES.FOCUS) { st.selected = null; st.returnMode = mode; }
    refresh();
    renderPanel();
    renderBar();
  }

  /** A change group: its elements stand out, the rest of the changes dim; the views frame them. Again: all groups. */
  function selectGroup(id, { fly = true } = {}) {
    st.group = st.group === id ? null : id;
    if (st.mode === MODES.FOCUS) { st.selected = null; st.mode = st.returnMode; }
    if (st.group) st.hiddenGroups.delete(st.group);
    refresh();
    renderPanel();
    renderBar();
    if (fly) resetCamera();
  }

  // ---- panel: Design Changes ----

  function detailHtml(c) {
    if (c.status === 'UNCHANGED') {
      return `<button type="button" class="isp-dc-back" data-cmp="back">‹ All changes</button>
        <div class="isp-dc-detail"><h3>${esc(c.networkId ?? c.name)}</h3><p class="isp-dc-sub">${esc(c.ifcClass)} · Unchanged between V${esc(st.base.versionNumber)} and V${esc(st.target.versionNumber)}</p></div>`;
    }
    const [a, b] = [sides[0]?.elements.get(c.baseGlobalId ?? c.globalId), sides[1]?.elements.get(c.globalId)];
    const statusText = c.status === 'MOVED' ? (c.modified ? 'Moved and modified' : 'Moved') : LABEL[c.status];
    const facts = [];
    const fact = (k, v) => { if (v !== null && v !== undefined && v !== '') facts.push(`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`); };
    fact('Status', statusText);
    if (c.status === 'MOVED') {
      fact('Movement', `${fmtM(c.displacement?.distanceM)}${Math.abs(c.displacement?.verticalM ?? 0) > 0.05 ? ` (${fmtM(Math.abs(c.displacement.verticalM))} vertical)` : ''}`);
      fact('Previous location', fmtLonLat(c.before?.geographic));
      fact('New location', fmtLonLat(c.after?.geographic));
    } else if (c.status === 'ADDED') fact('Location', fmtLonLat(c.after?.geographic));
    else if (c.status === 'REMOVED') fact('Was at', fmtLonLat(c.before?.geographic));
    fact('IFC class', c.ifcClass);
    fact('IFC GlobalId', c.globalId);
    if (c.match?.by === 'SECONDARY') fact('Matched by', `${c.match.reasons.join(', ')} (${Math.round(c.match.confidence * 100)}%)`);
    // Changed values only.
    const rows = [];
    const row = (k, x, y) => rows.push(`<tr><th>${esc(k)}</th><td>${esc(x ?? '—')}</td><td>${esc(y ?? '—')}</td></tr>`);
    if (c.status === 'MOVED') row('Position', fmtLonLat(c.before?.geographic), fmtLonLat(c.after?.geographic));
    for (const m of c.modifications ?? []) {
      if (m.kind === 'properties') for (const p of m.changes) row(p.key.replace(/^SuperDNA_PowerNetwork\./, ''), p.before, p.after);
      else if (m.kind === 'route') row('Cable route', m.before, m.after);
      else if (m.kind === 'ports') row('Connections (ports)', m.before, m.after);
      else if (m.kind === 'rotation') row('Rotation', '—', `${m.angleDeg}°`);
      else if (m.kind === 'geometry') row('Geometry', m.before ? `${m.before.triangles} triangles` : '—', m.after ? `${m.after.triangles} triangles` : '—');
    }
    const related = (c.relatedChanges ?? []).map(g => changes().find(x => x.globalId === g)).filter(Boolean);
    const psets = e => Object.entries(e?.properties ?? {}).map(([name, props]) => `<p class="isp-dc-pset">${esc(name)}</p><dl class="isp-dc-props">${Object.entries(props ?? {}).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v ?? '—')}</dd>`).join('')}</dl>`).join('');
    return `<button type="button" class="isp-dc-back" data-cmp="back">‹ All changes</button>
      <div class="isp-dc-detail is-${c.status.toLowerCase()}">
        <div class="isp-dc-dtitle"><span class="isp-dc-icon is-${c.status.toLowerCase()}">${changeIcon(c.status)}</span><h3>${esc(changeTitle(c))}</h3></div>
        <dl class="isp-dc-facts">${facts.join('')}</dl>
        ${rows.length ? `<h4>Changed</h4><table class="isp-dc-table"><thead><tr><th>Property</th><th>V${esc(st.base.versionNumber)}</th><th>V${esc(st.target.versionNumber)}</th></tr></thead><tbody>${rows.join('')}</tbody></table>` : ''}
        ${related.length ? `<p class="isp-dc-sub">Related: ${related.map(r => `<button type="button" class="isp-linkbtn" data-cmp-select="${esc(r.globalId)}">${esc(r.networkId ?? r.name)}</button>`).join(', ')}</p>` : ''}
        <details class="isp-dc-meta"><summary>Full IFC metadata</summary>
          ${a ? `<p class="isp-dc-ver">V${esc(st.base.versionNumber)}</p>${psets(a)}` : ''}${b ? `<p class="isp-dc-ver">V${esc(st.target.versionNumber)}</p>${psets(b)}` : ''}</details>
      </div>`;
  }

  function rowHtml(c) {
    const on = st.selected === c;
    return `<button type="button" class="isp-dc-row${on ? ' is-selected' : ''} is-${c.status.toLowerCase()}" data-cmp-select="${esc(c.globalId)}" aria-current="${on}">
      <span class="isp-dc-icon is-${c.status.toLowerCase()}">${changeIcon(c.status)}</span>
      <span class="isp-dc-text"><b>${esc(changeTitle(c))}</b><small>${esc(changeLine(c))}</small></span><span class="isp-dc-chev" aria-hidden="true">›</span></button>`;
  }

  function renderPanel() {
    const r = st.result;
    if (!r) return;
    const s = r.summary;
    const counts = { ADDED: s.added, MOVED: s.moved, MODIFIED: s.modified, REMOVED: s.removed };
    const card = k => `<button type="button" class="isp-dc-card is-${k.toLowerCase()}${st.filter === k ? ' is-on' : ''}" data-cmp-filter="${k}" aria-pressed="${st.filter === k}"><b>${counts[k]}</b><span>${LABEL[k]}</span></button>`;
    const chip = (k, n, text) => `<button type="button" class="isp-dc-chip${(st.filter ?? 'ALL') === k ? ' is-on' : ''}" data-cmp-filter="${k}">${text} (${n})</button>`;
    const notes = [...(r.notes ?? []), ...(r.warnings ?? [])];
    const ops = r.statusUpdates ?? [];
    const showingDetail = st.selected && st.mode === MODES.FOCUS;
    const grouped = st.density !== 'small' && st.panelView === 'groups';
    const significantCount = changes().filter(isSignificant).length;
    panel.classList.toggle('is-collapsed', st.panelCollapsed);
    const onlyBanner = st.only ? `<div class="isp-dc-only"><span>Showing ${st.only.size} ${st.only.size === 1 ? 'change' : 'changes'} from Ask the Twin</span><button type="button" class="isp-linkbtn" data-cmp="clearOnly">Show all</button></div>` : '';
    panel.innerHTML = `<div class="isp-dc-top">
        <div class="isp-dc-head"><div><h2>Design Changes</h2><p>IFC Version ${esc(st.base.versionNumber)} → Version ${esc(st.target.versionNumber)}</p></div>
          <span class="isp-dc-total">${s.total} ${plural(s.total, 'change')}</span>
          <button type="button" class="isp-dc-collapse" data-cmp="collapse" aria-expanded="${!st.panelCollapsed}" aria-label="${st.panelCollapsed ? 'Show' : 'Hide'} the changes">${st.panelCollapsed ? '‹' : '›'}</button></div>
        <div class="isp-dc-cards">${['ADDED', 'MOVED', 'MODIFIED', 'REMOVED'].map(card).join('')}</div>
        ${onlyBanner}
        ${showingDetail ? '' : st.density === 'small' ? `<div class="isp-dc-chips">${chip('ALL', s.listed ?? s.total, 'All')}${['ADDED', 'MOVED', 'MODIFIED', 'REMOVED'].filter(k => counts[k]).map(k => chip(k, counts[k], LABEL[k])).join('')}</div>`
          : `<div class="isp-dc-seg" role="tablist"><button type="button" role="tab" data-cmp-view="groups" aria-selected="${grouped}">Change Groups</button><button type="button" role="tab" data-cmp-view="list" aria-selected="${!grouped}">All Changes (${s.listed ?? s.total})</button></div>`}
      </div>
      <div class="isp-dc-scroll">${showingDetail ? detailHtml(st.selected) : grouped ? groupsHtml(significantCount) : `
        ${st.density === 'small' ? '' : `<div class="isp-dc-chips">${chip('ALL', s.listed ?? s.total, 'All')}${['ADDED', 'MOVED', 'MODIFIED', 'REMOVED'].filter(k => counts[k]).map(k => chip(k, counts[k], LABEL[k])).join('')}</div>
          <input type="search" class="isp-dc-search" data-cmp-list-search placeholder="Search changes" value="${esc(st.listSearch)}" aria-label="Search changes">`}
        <div class="isp-dc-list">${listRows()}</div>
        ${(r.modelWide ?? []).map(g => `<p class="isp-dc-note">Model-wide: ${esc(g.label)}.</p>`).join('')}
        ${notes.map(n => `<p class="isp-dc-note">${esc(n)}</p>`).join('')}
        ${ops.length ? `<details class="isp-dc-ops"><summary>Operational Updates (${ops.length})</summary>
          <p class="isp-dc-sub">Status set as the plant runs (power status, condition); not design changes, not counted.</p>
          ${ops.slice(0, 40).map(u => { const f = u.changes.find(p => /StatusFlag$|PowerStatus$|AssessmentCondition$/.test(p.key)) ?? u.changes[0];
            return `<button type="button" class="isp-dc-op" data-cmp-select="${esc(u.globalId)}"><b>${esc(u.networkId ?? u.name)}</b><span>${esc(f.key.split('.').pop())}: ${esc(f.before ?? '—')} → ${esc(f.after ?? '—')}</span></button>`; }).join('')}</details>` : ''}`}
      </div>`;
    renderLegend();
  }

  const matches = (c, q) => !q || `${c.networkId ?? ''} ${c.name ?? ''} ${c.ifcClass ?? ''} ${changeTitle(c)}`.toLowerCase().includes(q.toLowerCase());
  /** The flat list (filtered, searched); long lists are cut at 300 rows with a note, search narrows them. */
  function listRows() {
    const rows = changes().filter(c => visible(c) && (!st.only || st.only.has(c.globalId)) && matches(c, st.listSearch));
    if (!rows.length) return '<p class="isp-dc-none">No design changes of this kind.</p>';
    return rows.slice(0, 300).map(rowHtml).join('') + (rows.length > 300 ? `<p class="isp-dc-none">${rows.length - 300} more: search to narrow the list.</p>` : '');
  }

  /** Change groups: one row each (show / hide, select on the map, expand to its elements), then the map modes. */
  function groupsHtml(significantCount) {
    const r = st.result;
    const row = g => {
      const open = st.openGroup === g.id;
      const shown = !st.hiddenGroups.has(g.id);
      const members = open ? g.members.filter(c => matches(c, st.groupSearch)) : [];
      return `<div class="isp-dc-group${st.group === g.id ? ' is-selected' : ''}${open ? ' is-open' : ''}">
        <div class="isp-dc-grow">
          <input type="checkbox" class="isp-dc-gcheck" data-cmp-group-toggle="${esc(g.id)}" ${shown ? 'checked' : ''} aria-label="Show ${esc(g.label)} on the map">
          <button type="button" class="isp-dc-gmain" data-cmp-group="${esc(g.id)}" title="Show on map" aria-pressed="${st.group === g.id}">
            <span class="isp-dc-gicon is-${g.status.toLowerCase()}">${groupIcon(g.icon)}</span>
            <span class="isp-dc-text"><b>${esc(g.label)}</b><small>${esc(g.line)}${g.significant ? '' : ' · not drawn in Significant Changes'}</small></span></button>
          <button type="button" class="isp-dc-gexp" data-cmp-group-open="${esc(g.id)}" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} ${esc(g.label)}">${open ? '⌄' : '›'}</button>
        </div>
        ${open ? `<div class="isp-dc-gbody">
          ${g.members.length > 6 ? `<input type="search" class="isp-dc-search" data-cmp-group-search placeholder="Search ${esc(g.label.toLowerCase())}" value="${esc(st.groupSearch)}" aria-label="Search ${esc(g.label)}">` : ''}
          <div class="isp-dc-list">${members.slice(0, 300).map(rowHtml).join('') || '<p class="isp-dc-none">No match.</p>'}</div></div>` : ''}
      </div>`;
    };
    const radio = (mode, title, sub) => `<label class="isp-dc-radio"><input type="radio" name="cmp-vis" data-cmp-mode-radio="${mode}" ${st.mode === mode || (st.mode === MODES.FOCUS && st.returnMode === mode) ? 'checked' : ''}>
      <span><b>${esc(title)}</b><small>${esc(sub)}</small></span></label>`;
    return `<div class="isp-dc-groups">${st.groups.map(row).join('') || '<p class="isp-dc-none">No design changes.</p>'}</div>
      <section class="isp-dc-vis" aria-label="Visualization"><h4>Visualization</h4>
        ${radio(MODES.SIGNIFICANT, `Significant Changes (${significantCount})`, 'Added, moved, removed, geometry and connectivity changes')}
        ${radio(MODES.ALL, `All Changes (${r.summary.listed ?? r.summary.total})`, 'Every change, clustered on the map')}
        ${radio(MODES.FULL, 'Full Network', 'The complete network with the changes highlighted')}</section>`;
  }

  function renderLegend() {
    const s = st.result?.summary;
    if (!s) return;
    const item = (k, n) => `<span><i style="background:${CHANGE_COLORS[k]}"></i>${LABEL[k]} (${n})</span>`;
    $('.isp-cmp-legend').innerHTML = `${s.added ? item('ADDED', s.added) : ''}${s.moved ? item('MOVED', s.moved) : ''}${s.modified ? item('MODIFIED', s.modified) : ''}${s.removed ? item('REMOVED', s.removed) : ''}<span><i style="background:#9ca3af"></i>Unchanged (${s.unchanged})</span>`;
  }

  function renderBar() {
    $('.isp-cmp-versions span').innerHTML = `<span class="isp-cmp-vl">Comparing: </span><b>V${esc(st.base?.versionNumber)} vs V${esc(st.target?.versionNumber)}</b> ▾`;
    // Large comparisons lead with Significant Changes; small ones with Focus on Change.
    const first = root.querySelector('.isp-cmp-modes [data-cmp-mode]');
    first.dataset.cmpMode = st.density === 'large' ? MODES.SIGNIFICANT : MODES.FOCUS;
    first.textContent = st.density === 'large' ? 'Significant Changes' : 'Focus on Change';
    for (const b of root.querySelectorAll('[data-cmp-mode]')) b.setAttribute('aria-pressed', String(b.dataset.cmpMode === st.mode));
    for (const side of [0, 1]) {
      const v = side ? st.target : st.base;
      root.querySelector(`.isp-cmp-pane[data-side="${side}"] .isp-cmp-tag`).innerHTML = v
        ? `<b>Version ${esc(v.versionNumber)} (${side ? 'Compare' : 'Base'})</b> <span class="isp-cmp-vtag is-${side ? 'compare' : 'base'}">V${esc(v.versionNumber)}</span><br><small>${esc(fmtDate(v.createTime))}</small>` : '';
    }
  }

  // ---- divider ----

  function applySplit() { root.style.setProperty('--isp-split', `${st.split}%`); }
  const divider = $('.isp-cmp-divider');
  divider.addEventListener('pointerdown', event => {
    divider.setPointerCapture(event.pointerId);
    const box = $('.isp-cmp-panes').getBoundingClientRect();
    const move = e => { st.split = Math.min(80, Math.max(20, ((e.clientX - box.left) / box.width) * 100)); applySplit(); };
    const up = () => { divider.removeEventListener('pointermove', move); divider.removeEventListener('pointerup', up); for (const s of sides) if (s) layoutLabels(s); };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up);
  });
  divider.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { st.split = Math.min(80, Math.max(20, st.split + (event.key === 'ArrowLeft' ? -5 : 5))); applySplit(); event.preventDefault(); }
  });

  // ---- events ----

  function onClick(event) {
    const t = event.target.closest('button');
    if (!t) return;
    if (t.dataset.cmpSelect) { select(t.dataset.cmpSelect); return; }
    if (t.dataset.cmpMode) { setMode(t.dataset.cmpMode); return; }
    if (t.dataset.cmpGroup) { selectGroup(t.dataset.cmpGroup); return; }
    if (t.dataset.cmpGroupOpen) { st.openGroup = st.openGroup === t.dataset.cmpGroupOpen ? null : t.dataset.cmpGroupOpen; st.groupSearch = ''; renderPanel(); return; }
    if (t.dataset.cmpView) { st.panelView = t.dataset.cmpView; renderPanel(); return; }
    if (t.dataset.cmpFilter) {
      const k = t.dataset.cmpFilter === 'ALL' ? null : t.dataset.cmpFilter;
      st.filter = st.filter === k ? null : k;
      if (st.selected && st.filter && st.selected.status !== st.filter) { st.selected = null; st.mode = st.returnMode; }
      if (st.density !== 'small' && st.filter) st.panelView = 'list';
      refresh(); renderPanel(); renderBar();
      return;
    }
    switch (t.dataset.cmp) {
      case 'dialog': void openDialog(); break;
      case 'cancel': dialog.hidden = true; break;
      case 'reset': resetCamera(); break;
      case 'exit': exit(); break;
      case 'clearOnly': st.only = null; refresh(); renderPanel(); resetCamera(); break;
      case 'back': st.selected = null; st.mode = st.returnMode; refresh(); renderPanel(); renderBar(); break;
      case 'collapse': st.panelCollapsed = !st.panelCollapsed; root.classList.toggle('is-panel-collapsed', st.panelCollapsed); renderPanel(); break;
      default:
    }
  }
  root.addEventListener('click', onClick);
  dialog.addEventListener('click', onClick);
  root.addEventListener('change', event => {
    const d = event.target.dataset ?? {};
    if (d.cmpGroupToggle) {
      if (event.target.checked) st.hiddenGroups.delete(d.cmpGroupToggle); else st.hiddenGroups.add(d.cmpGroupToggle);
      if (st.group === d.cmpGroupToggle && !event.target.checked) st.group = null;
      refresh(); renderPanel();
      return;
    }
    if (d.cmpModeRadio) { setMode(d.cmpModeRadio); return; }
    if (d.cmpOpt !== 'sync') return;
    st.sync = event.target.checked;
    // Re-enabled: the other view takes the last-used view's camera.
    if (st.sync) { const lead = sides[st.leader]; if (lead) copyCamera(lead.viewer.camera, [1 - lead.side]); }
  });
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape') dialog.hidden = true; });
  // Search in a group or the list, keeping the caret where it was.
  root.addEventListener('input', event => {
    const d = event.target.dataset ?? {};
    if (!('cmpGroupSearch' in d) && !('cmpListSearch' in d)) return;
    if ('cmpGroupSearch' in d) st.groupSearch = event.target.value; else st.listSearch = event.target.value;
    const at = event.target.selectionStart;
    renderPanel();
    const input = panel.querySelector('cmpGroupSearch' in d ? '[data-cmp-group-search]' : '[data-cmp-list-search]');
    if (input) { input.focus(); input.setSelectionRange(at, at); }
  });

  return {
    openDialog,
    start,
    exit,
    select,
    setMode,
    selectGroup,
    /** Show only these changes (by GlobalId), framed: a set handed over by Ask the Twin. */
    focusIds(ids) {
      st.only = new Set(ids);
      st.selected = null; st.group = null; st.filter = null;
      if (st.mode === MODES.FOCUS) st.mode = st.returnMode;
      if (st.density !== 'small') st.panelView = 'list';
      refresh(); renderPanel(); renderBar(); resetCamera();
    },
    /** Show one kind of change (ADDED, MODIFIED…), as its summary card does. */
    filterStatus(status) {
      st.filter = status; st.only = null; st.selected = null; st.group = null;
      if (st.mode === MODES.FOCUS) st.mode = st.returnMode;
      if (st.density !== 'small') st.panelView = 'list';
      refresh(); renderPanel(); renderBar(); resetCamera();
    },
    isActive: () => st.active,
    /** Where a change's annotation (or, for a cable, its middle) is on screen in one view (tests). */
    screenPosition(globalId, side = 1) {
      const s = sides[side];
      const c = changes().find(x => x.globalId === globalId);
      const at = c && lonLatOf(c, side ? 'after' : 'before');
      if (!s || !at) return null;
      const p = s.viewer.scene.cartesianToCanvasCoordinates(Cartesian3.fromDegrees(at.lon, at.lat, context().terrainHeight + 3));
      const box = s.viewer.canvas.getBoundingClientRect();
      return p && { x: box.left + p.x, y: box.top + p.y };
    },
    pickAt: (side, x, y) => { const s = sides[side]; if (!s) return null; const box = s.viewer.canvas.getBoundingClientRect(); return pickAt(s, new Cartesian2(x - box.left, y - box.top)); },
    /** Every label of one view: its text, whether it is shown, where its anchor is on screen (diagnosis). */
    labelLayout: side => (sides[side]?.labels ?? []).map(l => { const q = SceneTransforms.worldToWindowCoordinates(sides[side].viewer.scene, l.position, new Cartesian2());
      return { lines: (l.shownLines ?? l.lines).join(' '), shown: l.entity.show, priority: l.priority, x: q && Math.round(q.x), y: q && Math.round(q.y) }; }),
    camera: side => { const c = sides[side]?.viewer.camera; return c && { position: [c.positionWC.x, c.positionWC.y, c.positionWC.z], heading: c.heading, pitch: c.pitch }; },
    zoom: (side, amount) => { const s = sides[side]; if (s) { st.leader = side; s.viewer.camera.zoomIn(amount); s.viewer.scene.requestRender(); } },
    state: () => ({
      active: st.active, busy: st.busy, error: st.error?.code ?? null, base: st.base?.versionNumber ?? null, target: st.target?.versionNumber ?? null,
      summary: st.result?.summary ?? null, frame: st.result?.frame ?? null, selected: st.selected?.globalId ?? null, selectedStatus: st.selected?.status ?? null,
      mode: st.mode, sync: st.sync, filter: st.filter, split: st.split, operationalUpdates: st.result?.statusUpdates?.length ?? 0,
      density: st.density, group: st.group, only: st.only ? st.only.size : null, hiddenGroups: [...st.hiddenGroups], significant: changes().filter(isSignificant).length,
      groups: st.groups.map(g => ({ id: g.id, label: g.label, count: g.members.length, significant: g.significant, tags: [...new Set(g.members.flatMap(c => [...modificationClasses(c)]))] })),
      shownOnMap: changes().filter(shownOnMap).length,
      models: sides.map(s => Boolean(s?.model)), markers: sides.map(s => s?.markers.entities.values.length ?? 0),
      labels: sides.map(s => (s?.labels ?? []).filter(l => l.entity.show).map(l => (l.shownLines ?? l.lines).join(' '))),
      changes: (st.result?.changes ?? []).map(c => ({ status: c.status, globalId: c.globalId, networkId: c.networkId, kind: c.kind, distanceM: c.displacement?.distanceM ?? null })),
    }),
  };
}
