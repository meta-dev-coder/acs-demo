/**
 * IFC Model Explorer: a separate screen for the IFC models stored in Autodesk Forma Data
 * Management, shown with the Autodesk Viewer.
 *
 * Lifecycle. `mountIfcExplorer()` builds its own root element once. `show()` creates a viewer and
 * loads the selected model; `hide()` disposes the viewer (its WebGL context is released) and keeps
 * only the file list and the chosen model, so coming back reloads the same model. It never touches
 * the Seagirt map, its layers, its scenario or its panels: the Seagirt page only hides its own
 * chrome while this screen is shown (seagirtDemo.js).
 *
 * Data. Everything shown comes from the model as Autodesk serves it: the instance tree, the property
 * database and the file's Data Management metadata (/api/aps/files). Values are displayed as stated
 * in the model; an empty value is shown as empty, never filled in.
 */
import { ApsRequestError, createApsClient, loadViewerSdk, loginUrl, needsSignIn, viewableOf } from './apsClient.js';
import { createViewerSession, ViewerError } from './viewerSession.js';
import { buildIndex, CATEGORIES, categoryLabel, elementsIn, groupProperties, propertyCategories, searchElements, unitLabel } from './modelIndex.js';
import { compareAssets } from './assetMapping.js';
import './ifcExplorer.css';

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const stripClass = name => String(name ?? '').replace(/^Ifc[A-Za-z]+::/, '');
const when = iso => {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;
};
const glyph = d => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  fit: glyph('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  isolate: glyph('<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M3 3h3M18 3h3M3 21h3M18 21h3"/>'),
  showAll: glyph('<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>'),
  reset: glyph('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/>'),
  left: glyph('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9 4.5v15"/>'),
  right: glyph('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M15 4.5v15"/>'),
  refresh: glyph('<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4.5h-4.5"/>'),
};
const ELECTRICAL = CATEGORIES.filter(category => category.electrical);
const STRUCTURE = CATEGORIES.filter(category => !category.electrical);

export function mountIfcExplorer({ host = document.body, aps = createApsClient(), loadSdk = loadViewerSdk,
  assetsUrl = `${import.meta.env?.BASE_URL ?? '/'}data/seagirt/electrical-assets.json`, initialModel = null,
  onModelChange = () => {}, theme = () => document.documentElement.dataset.theme ?? 'light' } = {}) {
  const root = document.createElement('main');
  root.className = 'ifx';
  root.setAttribute('aria-label', 'IFC Model Explorer');
  root.hidden = true;
  root.innerHTML = `
    <header class="ifx-top">
      <div class="ifx-brand"><b>IFC Model Explorer</b><span class="ifx-source"></span></div>
      <span class="ifx-conn" role="status"></span>
      <label class="ifx-model"><span>Model</span><select aria-label="IFC model" disabled></select></label>
      <span class="ifx-version"></span>
      <span class="ifx-sync"></span>
      <button type="button" class="ifx-icon ifx-refresh" title="Re-read the file list from Autodesk" aria-label="Refresh file list">${ICON.refresh}</button>
    </header>
    <div class="ifx-body">
      <aside class="ifx-left" aria-label="Model browser">
        <div class="ifx-pane-head"><div class="ifx-kicker">Model browser</div></div>
        <input class="ifx-search" type="search" placeholder="Search name, GlobalId, IFC class, tag…" aria-label="Search model elements" disabled>
        <div class="ifx-tabs" role="tablist">
          <button type="button" role="tab" data-tab="hierarchy">Hierarchy</button>
          <button type="button" role="tab" data-tab="categories">Categories</button>
          <button type="button" role="tab" data-tab="mapping">Asset mapping</button>
        </div>
        <div class="ifx-list" tabindex="-1"></div>
      </aside>
      <section class="ifx-view" aria-label="Autodesk 3D viewer">
        <div class="ifx-viewer"></div>
        <div class="ifx-tools" role="toolbar" aria-label="View">
          <button type="button" class="ifx-icon" data-act="left" title="Show or hide the model browser" aria-label="Toggle model browser">${ICON.left}</button>
          <span class="ifx-sep"></span>
          <button type="button" class="ifx-icon" data-act="fit" title="Fit to view (the selection, or the whole model)" aria-label="Fit to view">${ICON.fit}</button>
          <button type="button" class="ifx-icon" data-act="isolate" title="Isolate the selection" aria-label="Isolate selection">${ICON.isolate}</button>
          <button type="button" class="ifx-icon" data-act="showAll" title="Show all elements" aria-label="Show all">${ICON.showAll}</button>
          <button type="button" class="ifx-icon" data-act="reset" title="Reset the view" aria-label="Reset view">${ICON.reset}</button>
          <span class="ifx-sep"></span>
          <button type="button" class="ifx-icon" data-act="right" title="Show or hide element properties" aria-label="Toggle properties">${ICON.right}</button>
        </div>
        <div class="ifx-overlay" hidden></div>
      </section>
      <aside class="ifx-right" aria-label="Element properties"></aside>
    </div>`;
  host.append(root);
  const $ = selector => root.querySelector(selector);
  const viewerBox = $('.ifx-viewer'), overlay = $('.ifx-overlay'), list = $('.ifx-list'), right = $('.ifx-right'),
    select = $('.ifx-model select'), search = $('.ifx-search');

  const st = {
    visible: false, phase: 'idle', error: null, status: null,
    files: null, fileName: initialModel, warning: null,
    index: null, raw: new Map(), categories: [], mapping: null, assets: null,
    selectedDbId: null, tab: 'hierarchy', query: '', expanded: new Set(), openCategories: new Set(['transformer']),
    showStructure: false, leftOpen: true, rightOpen: true, loadedAt: null,
  };
  let session = null;
  let sdk = null;
  let opening = 0;

  const file = () => st.files?.files.find(entry => entry.fileName === st.fileName) ?? null;

  // ---- connection, files, model ----

  async function connect({ refresh = false } = {}) {
    setPhase('connecting');
    try {
      st.status = await aps.status();
      if (!st.status.configured) throw new ApsRequestError('APS_NOT_CONFIGURED', 503, 'Autodesk sign-in is not configured on the server.', 'Set APS_CLIENT_ID, APS_CLIENT_SECRET and APS_CALLBACK_URL, then restart the dev server.');
      if (!st.status.authenticated) throw new ApsRequestError('NOT_AUTHENTICATED', 401, 'Sign in to Autodesk to open the models.');
      setPhase('files');
      st.files = await aps.files({ refresh });
      st.warning = st.files.warning ?? null;
      if (!st.files.files.length) throw new ApsRequestError('FILES_MISSING', 404, 'No IFC files were found in the project.');
      if (!file()) st.fileName = st.files.files[0].fileName;
      renderHeader();
      await openModel();
    } catch (error) { fail(error); }
  }

  async function openModel() {
    const mine = ++opening;
    st.index = null; st.raw = new Map(); st.categories = []; st.mapping = null; st.selectedDbId = null; st.expanded = new Set();
    renderHeader(); renderLeft(); renderRight();
    const target = file();
    const viewable = viewableOf(target);
    if (!viewable.ok) { fail(new ViewerError(viewable.code, viewable.message)); return; }
    try {
      setPhase('sdk');
      sdk ??= await loadSdk();
      if (mine !== opening || !st.visible) return;
      session ??= createViewerSession({ Autodesk: sdk, container: viewerBox, getAccessToken, onSelect, theme: theme() });
      setPhase('loading');
      const opened = await session.open(viewable, { elementTest: isSelectableElement });
      if (!opened || mine !== opening) return;
      setPhase('properties');
      const dbIds = allNodes(opened.tree);
      const results = await session.bulkProperties(dbIds);
      if (mine !== opening) return;
      st.raw = new Map(results.map(result => [result.dbId, result]));
      st.index = buildIndex(results);
      st.categories = propertyCategories(results);
      st.loadedAt = new Date().toISOString();
      setPhase('ready');
      renderLeft(); renderRight();
    } catch (error) {
      if (mine === opening) fail(error);
    }
  }

  function getAccessToken(callback) {
    aps.viewerToken().then(token => callback(token.access_token, token.expires_in), fail);
  }

  /** Geometry and port nodes are not selection targets: a click on one selects the element that owns it. */
  function isSelectableElement(dbId) {
    const element = st.index?.byDbId.get(dbId);
    return !element || !['geometry', 'port', 'group'].includes(element.category);
  }

  function allNodes(tree) {
    const ids = [];
    tree.enumNodeChildren(tree.getRootId(), id => { ids.push(id); }, true);
    return ids;
  }

  // ---- phases and errors ----

  const PHASE_TEXT = {
    connecting: 'Checking the Autodesk connection…', files: 'Reading the project files from Autodesk Forma…',
    sdk: 'Loading the Autodesk Viewer…', loading: 'Loading the model…', properties: 'Reading the model\'s properties…',
  };
  function setPhase(phase) {
    st.phase = phase;
    if (phase !== 'error') st.error = null;
    overlay.hidden = phase === 'ready' || phase === 'idle';
    if (!overlay.hidden) overlay.innerHTML = `<div class="ifx-card ifx-wait"><span class="ifx-spinner" aria-hidden="true"></span>${esc(PHASE_TEXT[phase] ?? 'Working…')}</div>`;
    renderHeader();
  }

  function fail(error) {
    const code = error?.code ?? 'ERROR';
    st.phase = 'error';
    st.error = { code, message: error?.message ?? String(error), hint: error?.hint ?? null };
    const signIn = needsSignIn(error) || code === 'AUTH';
    const title = signIn ? 'Sign in to Autodesk' : {
      NO_DERIVATIVE: 'No viewable derivative', TRANSLATION_NOT_READY: 'Translation not complete', NO_VIEWABLE: 'No viewable output',
      NO_GEOMETRY: 'No 3D geometry', WEBGL: 'WebGL unavailable', SDK_FAILED: 'Autodesk Viewer unavailable', SDK_TIMEOUT: 'Autodesk Viewer unavailable',
      APS_NOT_CONFIGURED: 'Autodesk is not configured', FILES_MISSING: 'Model files not found',
    }[code] ?? 'The model could not be shown';
    overlay.hidden = false;
    overlay.innerHTML = `<div class="ifx-card ifx-error" role="alert">
      <h2>${esc(title)}</h2><p>${esc(st.error.message)}</p>${st.error.hint ? `<p class="ifx-muted">${esc(st.error.hint)}</p>` : ''}
      <div class="ifx-actions">${signIn ? `<a class="ifx-btn is-primary" href="${esc(loginUrl())}">Sign in with Autodesk</a>` : ''}
        <button type="button" class="ifx-btn" data-act="retry">Try again</button></div>
      <small class="ifx-muted">Code ${esc(code)}</small></div>`;
    renderHeader();
  }

  // ---- selection ----

  function onSelect(dbId) {
    st.selectedDbId = dbId ?? null;
    if (dbId !== null && st.tab === 'hierarchy') revealInTree(dbId);
    renderLeft(); renderRight();
    root.querySelector('.ifx-list .is-selected')?.scrollIntoView?.({ block: 'nearest' });
  }

  function choose(dbId, { fit = false } = {}) {
    if (!session || !Number.isInteger(dbId)) return;
    session.select([dbId]);
    if (fit) session.fit([dbId]);
    onSelect(dbId);
  }

  function revealInTree(dbId) {
    const tree = session?.tree();
    if (!tree) return;
    for (let parent = tree.getNodeParentId(dbId), guard = 0; parent && guard < 20; parent = tree.getNodeParentId(parent), guard += 1) st.expanded.add(parent);
  }

  // ---- header ----

  function renderHeader() {
    const project = st.files?.project?.name;
    $('.ifx-source').textContent = project ? `Autodesk Forma Data Management · ${project}` : 'Autodesk Forma Data Management';
    const conn = $('.ifx-conn');
    const state = st.phase === 'error' && (needsSignIn(st.error) || st.error?.code === 'AUTH') ? ['is-off', 'Not signed in']
      : st.phase === 'error' ? ['is-bad', 'Error'] : st.status?.authenticated ? ['is-ok', 'Connected'] : ['is-wait', 'Connecting…'];
    conn.className = `ifx-conn ${state[0]}`;
    conn.textContent = state[1];
    const names = st.files?.files.map(entry => entry.fileName) ?? [];
    if (select.dataset.names !== names.join('|')) {
      select.innerHTML = names.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
      select.dataset.names = names.join('|');
    }
    select.value = st.fileName ?? '';
    select.disabled = !names.length || ['sdk', 'loading', 'properties'].includes(st.phase);
    const current = file();
    const tip = current?.versions?.find(version => version.id === current.tipVersionId) ?? current?.versions?.[0];
    $('.ifx-version').textContent = tip ? `Version ${tip.versionNumber}` : '';
    const synced = when(st.files?.generatedAt);
    $('.ifx-sync').textContent = synced ? `Synced ${synced}` : '';
    $('.ifx-sync').title = synced ? 'When the file list was last read from Autodesk Data Management' : '';
    search.disabled = !st.index;
  }

  // ---- left: browser ----

  function renderLeft() {
    for (const tab of root.querySelectorAll('.ifx-tabs [data-tab]')) tab.setAttribute('aria-selected', String(tab.dataset.tab === st.tab));
    if (!st.index) { list.innerHTML = `<p class="ifx-empty">${st.phase === 'error' ? 'No model loaded.' : 'The model hierarchy appears once the model has loaded.'}</p>`; return; }
    if (st.query) { list.innerHTML = searchHtml(); return; }
    list.innerHTML = st.tab === 'categories' ? categoriesHtml() : st.tab === 'mapping' ? mappingHtml() : hierarchyHtml();
  }

  const rowHtml = (element, extra = '') => `<button type="button" class="ifx-row${element.dbId === st.selectedDbId ? ' is-selected' : ''}" data-db="${element.dbId}">
    <span class="ifx-row-name">${esc(element.name || element.nodeName)}</span><span class="ifx-row-meta">${esc(element.ifcClass ?? '')}${extra}</span></button>`;

  function searchHtml() {
    const hits = searchElements(st.index, st.query);
    return `<p class="ifx-count">${hits.length === 200 ? 'First 200' : hits.length} result${hits.length === 1 ? '' : 's'} for “${esc(st.query)}”</p>${hits.map(hit => rowHtml(hit, hit.globalId ? ` · ${esc(hit.globalId)}` : '')).join('') || '<p class="ifx-empty">No element matches. Search covers name, IFC GlobalId, IFC class, tag, NetworkID and role.</p>'}`;
  }

  function hierarchyHtml() {
    const tree = session?.tree();
    if (!tree) return '';
    // Grouping nodes are the tree's structure and always shown; ports and body geometry only on request.
    const visible = id => st.showStructure || !['geometry', 'port'].includes(st.index.byDbId.get(id)?.category);
    const children = id => { const out = []; tree.enumNodeChildren(id, child => { out.push(child); }); return out; };
    const nodeHtml = (id, depth) => {
      const kids = children(id).filter(visible);
      const element = st.index.byDbId.get(id);
      const open = st.expanded.has(id);
      const label = stripClass(tree.getNodeName(id)) || element?.name || `Node ${id}`;
      return `<div class="ifx-node" style="--d:${depth}">
        ${kids.length ? `<button type="button" class="ifx-caret${open ? ' is-open' : ''}" data-toggle="${id}" aria-label="${open ? 'Collapse' : 'Expand'} ${esc(label)}" aria-expanded="${open}"></button>` : '<span class="ifx-caret is-leaf"></span>'}
        <button type="button" class="ifx-row${id === st.selectedDbId ? ' is-selected' : ''}" data-db="${id}">
          <span class="ifx-row-name">${esc(label)}</span><span class="ifx-row-meta">${esc(element?.ifcClass ?? '')}${kids.length ? ` · ${kids.length}` : ''}</span></button></div>
        ${open ? kids.map(kid => nodeHtml(kid, depth + 1)).join('') : ''}`;
    };
    const top = children(tree.getRootId());
    if (!st.expanded.size) for (const id of top) st.expanded.add(id);
    return `<label class="ifx-check"><input type="checkbox" data-structure ${st.showStructure ? 'checked' : ''}> Show ports and body geometry nodes</label>
      ${top.map(id => nodeHtml(id, 0)).join('')}`;
  }

  function categoriesHtml() {
    const group = (category) => {
      const count = st.index.counts[category.key];
      if (!count) return `<div class="ifx-cat is-none"><span>${esc(category.label)}</span><span class="ifx-row-meta">none in this model</span></div>`;
      const open = st.openCategories.has(category.key);
      return `<details class="ifx-cat" data-cat="${category.key}" ${open ? 'open' : ''}><summary><span>${esc(category.label)}</span><span class="ifx-badge">${count}</span></summary>
        ${open ? elementsIn(st.index, category.key).map(element => rowHtml(element, element.networkRole ? ` · ${esc(element.networkRole)}` : '')).join('') : ''}</details>`;
    };
    return `<p class="ifx-count">${st.index.electricalCount} electrical elements · ${st.index.elements.length} nodes with properties</p>
      <div class="ifx-sub">Electrical equipment</div>${ELECTRICAL.map(group).join('')}
      <div class="ifx-sub">Structure</div>${STRUCTURE.map(group).join('')}
      <small class="ifx-muted">Grouped by IFC class and the model's own NetworkRole property. A category the model does not contain is listed as none.</small>`;
  }

  function mappingHtml() {
    if (!st.mapping) {
      void loadMapping();
      return '<p class="ifx-empty">Comparing with the electrical twin\'s assets…</p>';
    }
    if (st.mapping.error) return `<p class="ifx-empty">${esc(st.mapping.error)}</p>`;
    const m = st.mapping;
    const ifcRow = ref => `<button type="button" class="ifx-row" data-db="${ref.dbId}"><span class="ifx-row-name">${esc(ref.name)}</span>
      <span class="ifx-ids"><span>dbId ${ref.dbId}</span><span>GlobalId ${esc(ref.globalId ?? '—')}</span>${ref.networkId ? `<span>NetworkID ${esc(ref.networkId)}</span>` : ''}</span></button>`;
    const pair = entry => `<div class="ifx-map is-${entry.verdict === 'AMBIGUOUS' ? 'amb' : 'cand'}">
      <div class="ifx-map-asset"><b>${esc(entry.assetId)}</b> <span class="ifx-row-meta">twin asset · ${esc(entry.assetType.toLowerCase().replaceAll('_', ' '))}</span></div>
      ${entry.ifc.map(ifcRow).join('')}<ul class="ifx-reasons">${entry.reasons.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul></div>`;
    const section = (title, count, body, open = false) => `<details class="ifx-cat" ${open ? 'open' : ''}><summary><span>${esc(title)}</span><span class="ifx-badge">${count}</span></summary>${body}</details>`;
    return `<p class="ifx-count">Read-only comparison with the illustrative electrical twin (${m.summary.twinAssets} assets). Nothing is linked or changed.</p>
      ${section('Identifier candidates (unconfirmed)', m.candidates.length, m.candidates.map(pair).join('') || '<p class="ifx-empty">None.</p>', true)}
      ${section('Ambiguous identifier matches', m.ambiguous.length, m.ambiguous.map(pair).join('') || '<p class="ifx-empty">None.</p>', true)}
      ${section('Twin assets not found in the IFC', m.assetsOnly.length, `<p class="ifx-chips">${m.assetsOnly.map(asset => `<span title="${esc(asset.assetName)}">${esc(asset.assetId)}</span>`).join('')}</p>`)}
      ${section('IFC electrical elements with no twin asset', m.ifcOnly.length, m.ifcOnly.map(ifcRow).join(''))}
      ${section('IFC elements missing metadata', m.missingMetadata.length, m.missingMetadata.map(entry => `<button type="button" class="ifx-row" data-db="${entry.dbId}"><span class="ifx-row-name">${esc(entry.name)}</span><span class="ifx-row-meta">missing ${esc(entry.missing.join(', '))}</span></button>`).join(''))}
      <ul class="ifx-rules">${m.rules.map(rule => `<li>${esc(rule)}</li>`).join('')}</ul>`;
  }

  async function loadMapping() {
    if (st.mapping || !st.index) return;
    st.mapping = { pending: true, summary: {} };
    try {
      st.assets ??= (await (await fetch(assetsUrl)).json()).assets;
      st.mapping = compareAssets(st.index.elements, st.assets);
    } catch (error) {
      st.mapping = { error: `The electrical twin's asset list could not be read (${error?.message ?? error}).` };
    }
    if (st.tab === 'mapping') renderLeft();
  }

  // ---- right: properties ----

  function renderRight() {
    if (!st.index) { right.innerHTML = `<div class="ifx-pane-head"><div class="ifx-kicker">Element properties</div></div><p class="ifx-empty">Select an element in the model or the browser.</p>`; return; }
    const result = st.selectedDbId !== null ? st.raw.get(st.selectedDbId) : null;
    right.innerHTML = result ? elementHtml(result) : modelHtml();
  }

  const dl = rows => `<dl class="ifx-dl">${rows.map(([label, value, title]) => `<dt>${esc(label)}</dt><dd${title ? ` title="${esc(title)}"` : ''}>${value === null || value === undefined || value === '' ? '<span class="ifx-muted">not in model</span>' : esc(value)}</dd>`).join('')}</dl>`;

  function versionRows() {
    const current = file();
    if (!current) return [];
    const tip = current.versions?.find(version => version.id === current.tipVersionId) ?? current.versions?.[0];
    const outputs = current.derivative?.manifest?.outputs?.map(output => `${output.outputType} ${output.status}`).join(', ');
    return [['File', current.fileName], ['Version', tip?.versionNumber], ['Version id', current.tipVersionId], ['Item id', current.itemId],
      ['Last modified', when(tip?.lastModifiedTime)], ['Derivative', outputs ? `${current.derivative.manifest.status} · ${outputs}` : null],
      ['Derivative URN', current.derivative?.urn, current.derivative?.urn]];
  }

  function elementHtml(result) {
    const element = st.index.byDbId.get(result.dbId);
    const groups = groupProperties(result);
    const electrical = groups.filter(group => group.electrical);
    const other = groups.filter(group => !group.electrical);
    const table = group => `<table class="ifx-props"><tbody>${group.props.map(prop => `<tr><th>${esc(prop.name)}</th><td>${prop.value === '' ? '<span class="ifx-muted">(empty)</span>' : esc(prop.value)}${prop.units ? ` <span class="ifx-muted" title="${esc(prop.units)}">${esc(unitLabel(prop.units))}</span>` : ''}</td></tr>`).join('')}</tbody></table>`;
    return `<div class="ifx-pane-head"><div class="ifx-kicker">${esc(categoryLabel(element?.category))}</div>
        <button type="button" class="ifx-link" data-act="clear">Model summary</button></div>
      <h2 class="ifx-title">${esc(element?.name || stripClass(result.name))}</h2>
      <div class="ifx-sub-title">${esc([element?.ifcClass, element?.predefinedType].filter(Boolean).join(' · '))}</div>
      ${dl([['Autodesk dbId', result.dbId], ['IFC GlobalId', element?.globalId], ['IFC Tag', element?.tag], ['NetworkID', element?.networkId], ['External id', result.externalId]])}
      <div class="ifx-actions"><button type="button" class="ifx-btn" data-act="fit">Fit</button><button type="button" class="ifx-btn" data-act="isolate">Isolate</button><button type="button" class="ifx-btn" data-act="showAll">Show all</button></div>
      <div class="ifx-sub">Electrical attributes</div>
      ${electrical.length ? electrical.map(group => `<details class="ifx-group" open><summary>${esc(group.category)} <span class="ifx-badge">${group.props.length}</span></summary>${table(group)}</details>`).join('') : '<p class="ifx-empty">This element carries no electrical property set.</p>'}
      <div class="ifx-sub">Property categories</div>
      ${other.map(group => `<details class="ifx-group" ${group.category === 'IFC Attributes' ? 'open' : ''}><summary>${esc(group.category)} <span class="ifx-badge">${group.props.length}</span></summary>${table(group)}</details>`).join('')}
      <details class="ifx-group"><summary>Model and version</summary>${dl(versionRows())}</details>`;
  }

  function modelHtml() {
    const statuses = [...new Set(st.index.elements.map(element => element.dataStatus).filter(Boolean))];
    return `<div class="ifx-pane-head"><div class="ifx-kicker">Model summary</div></div>
      <h2 class="ifx-title">${esc(st.fileName)}</h2>
      ${statuses.length ? `<p class="ifx-note">The model's DataStatus property says: ${statuses.map(status => `“${esc(status)}”`).join(', ')}.</p>` : ''}
      ${dl([['Nodes with properties', st.index.elements.length], ['With IFC GlobalId', st.index.withGlobalId], ['Electrical elements', st.index.electricalCount]])}
      <div class="ifx-sub">Electrical equipment found</div>
      <table class="ifx-props"><tbody>${ELECTRICAL.map(category => `<tr><th>${esc(category.label)}</th><td>${st.index.counts[category.key] || '<span class="ifx-muted">none</span>'}</td></tr>`).join('')}</tbody></table>
      <details class="ifx-group"><summary>Property categories in the model <span class="ifx-badge">${st.categories.length}</span></summary>
        <table class="ifx-props"><tbody>${st.categories.map(entry => `<tr><th>${esc(entry.category)}${entry.electrical ? ' <span class="ifx-tag">electrical</span>' : ''}</th><td>${entry.count}</td></tr>`).join('')}</tbody></table></details>
      <details class="ifx-group" open><summary>Model and version</summary>${dl(versionRows())}</details>
      ${st.warning ? `<p class="ifx-note">${esc(st.warning)}</p>` : ''}
      <p class="ifx-muted">Select an element in the viewer or the browser to see its properties.</p>`;
  }

  // ---- events ----

  root.addEventListener('click', event => {
    const target = event.target.closest('button, a');
    if (!target || !root.contains(target)) return;
    if (target.dataset.toggle) {
      const id = Number(target.dataset.toggle);
      if (st.expanded.has(id)) st.expanded.delete(id); else st.expanded.add(id);
      renderLeft();
      return;
    }
    if (target.dataset.db) { choose(Number(target.dataset.db), { fit: true }); return; }
    if (target.dataset.tab) { st.tab = target.dataset.tab; renderLeft(); return; }
    const selected = st.selectedDbId !== null ? [st.selectedDbId] : [];
    switch (target.dataset.act) {
      case 'fit': session?.fit(selected); break;
      case 'isolate': if (selected.length) session?.isolate(selected); break;
      case 'showAll': session?.showAll(); break;
      case 'reset': session?.reset(); onSelect(null); break;
      case 'clear': session?.select([]); onSelect(null); break;
      case 'left': st.leftOpen = !st.leftOpen; root.classList.toggle('ifx-no-left', !st.leftOpen); break;
      case 'right': st.rightOpen = !st.rightOpen; root.classList.toggle('ifx-no-right', !st.rightOpen); break;
      case 'retry': if (st.files && !needsSignIn(st.error)) void openModel(); else void connect(); break;
      default: break;
    }
  });
  list.addEventListener('toggle', event => {
    const details = event.target.closest?.('details[data-cat]');
    if (!details) return;
    const was = st.openCategories.has(details.dataset.cat);
    if (details.open === was) return;
    if (details.open) st.openCategories.add(details.dataset.cat); else st.openCategories.delete(details.dataset.cat);
    renderLeft();
  }, true);
  list.addEventListener('change', event => {
    if (event.target.matches('[data-structure]')) { st.showStructure = event.target.checked; renderLeft(); }
  });
  let searchTimer;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { st.query = search.value.trim(); renderLeft(); }, 120);
  });
  select.addEventListener('change', () => {
    st.fileName = select.value;
    onModelChange(st.fileName);
    void openModel();
  });
  $('.ifx-refresh').onclick = () => { void connect({ refresh: true }); };

  // The viewer sizes itself from its container: follow panel toggles and window resizes.
  const resizer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => session?.resize()) : null;
  resizer?.observe(viewerBox);
  const themeWatch = typeof MutationObserver === 'function' ? new MutationObserver(() => session?.setTheme(theme())) : null;
  themeWatch?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  function disposeViewer() {
    opening += 1;
    session?.dispose();
    session = null;
    viewerBox.replaceChildren();
    st.index = null; st.raw = new Map(); st.mapping = null; st.selectedDbId = null;
  }

  const api = {
    root,
    show() {
      if (st.visible) return;
      st.visible = true;
      root.hidden = false;
      if (st.files) void openModel(); else void connect();
    },
    hide() {
      if (!st.visible) return;
      st.visible = false;
      root.hidden = true;
      disposeViewer();
      setPhase('idle');
    },
    destroy() {
      disposeViewer();
      resizer?.disconnect();
      themeWatch?.disconnect();
      root.remove();
    },
    /** Read-only view for browser tests and the console. */
    state: () => ({
      visible: st.visible, phase: st.phase, error: st.error, fileName: st.fileName,
      files: st.files?.files.map(entry => entry.fileName) ?? [], project: st.files?.project ?? null,
      elementCount: st.index?.elements.length ?? 0, electricalCount: st.index?.electricalCount ?? 0,
      counts: st.index?.counts ?? null, propertyCategories: st.categories.map(entry => entry.category),
      selectedDbId: st.selectedDbId, selected: st.selectedDbId !== null ? st.index?.byDbId.get(st.selectedDbId) ?? null : null,
      viewerAlive: Boolean(session?.viewer), modelCount: session?.modelCount() ?? 0, tab: st.tab,
      mapping: st.mapping?.summary ?? null,
    }),
    select: dbId => choose(dbId, { fit: true }),
    find: query => (st.index ? searchElements(st.index, query).map(element => element.dbId) : []),
  };
  // For browser tests and the console, like window.__seagirt: state reads and element selection only.
  window.__ifc = Object.freeze({ state: api.state, select: api.select, find: api.find });
  return api;
}
