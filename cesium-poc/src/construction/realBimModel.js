/**
 * Real BIM Model — the actual Speckle building, beside the synthetic demo rather than instead of it.
 *
 * The thing this screen exists to prevent: it sits one click from a synthetic Tower A model, five
 * synthetic integration cards and a synthetic P6 schedule. A reader who comes away thinking the
 * demo's BIM elements are real, or that this model is linked to the schedule, has been misled by a
 * screen that was technically accurate. So:
 *
 *  - every figure carries REAL — Speckle Cloud, and the note says the synthetic BIM data is
 *    untouched and separate. Construction Progress still shows its own synthetic model.
 *  - the IFC GlobalId is shown verbatim on every selected element. It is the model's own
 *    identifier, not one this demo generated, and it is the only thing here that would join to
 *    anything outside Speckle.
 *  - no element is mapped to a schedule activity. That is Phase 9C and it needs an approval; this
 *    screen says so rather than leaving the absence to be inferred.
 *  - "converted at" and "published in Speckle at" are different timestamps and are labelled as
 *    such, because a model can be hours old and perfectly current.
 *
 * One contextual details panel, no modals, no second popup.
 */
import { API as API_BASE, escape, num, request, when } from './ciClient.js';
import { installBimViewer } from './bimViewer.js';
import { RUN_LABEL, WORKER_LABEL } from './bimWorkspace.js';

export const BIM_API = '/speckle';
export const BIM_EVENTS = '/speckle/events';
export const SYNC_EVENT = 'speckle-sync-completed';

/*
 * This screen is NO LONGER IN THE NAVIGATION (Phase 9E) — Construction Progress covers the same
 * ground with its BIM Timeline and BIM Changes subtabs, and its Overview carries the Speckle sync
 * status and Sync Now that used to live only here. The module is kept because it still passes its
 * own tests and the decision is reversible; nothing in the application imports it.
 *
 * The sync vocabulary moved to `bimWorkspace.js` and is re-exported here for those tests.
 */
export { RUN_LABEL, WORKER_LABEL } from './bimWorkspace.js';

/** A readable swatch per IFC class, matching the converter's own defaults. */
export const TYPE_COLOUR = Object.freeze({
  IfcBeam: '#a88448', IfcWall: '#cdc8be', IfcFooting: '#828288', IfcSlab: '#afafb4',
  IfcColumn: '#968c78', IfcRoof: '#965f50', IfcBuildingElementProxy: '#8ca0b9',
});

const bytes = value => {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB`
    : `${(n / 1024 / 1024).toFixed(1)} MB`;
};

/* ── markup ────────────────────────────────────────────────────────────────────────────────── */

function headerMarkup(report) {
  const active = report?.active;
  const name = active ? `${active.modelName} · ${active.projectName}` : 'Real BIM Model';
  return `<header class="ops-head">
      <div class="ops-head-main">
        <h2>${escape(name)}</h2>
        <p class="ops-head-sub">Speckle Cloud · project ${escape(report?.projectId ?? '—')} ·
          model ${escape(report?.modelId ?? '—')}${active
    ? ` · version ${escape(active.versionId)}` : ''}</p>
      </div>
      <div class="ops-head-side">
        <button type="button" class="ci-button ci-button--quiet" data-action="fit">Zoom to model</button>
        <button type="button" class="ci-button" data-action="sync-now">Sync Now</button>
      </div>
    </header>`;
}

/** The permanent provenance note. Not a footnote — it is the most likely misreading of the screen. */
function provenanceMarkup(source) {
  return `<p class="ops-provenance" role="note">
      <span class="ci-chip" data-tone="ok">REAL — Speckle Cloud</span>
      <span class="ci-chip" data-tone="info">SYNTHETIC — the demo's own BIM, P6 and SYNCHRO data</span>
      ${escape(source?.notSynthetic ?? '')} ${escape(source?.noAutoMap ?? '')}</p>`;
}

function syncRowMarkup(status) {
  if (!status) {
    return `<div class="ops-sync" data-sync-state="unknown">
      <span class="ci-chip" data-tone="info">Sync status unknown</span></div>`;
  }
  const worker = WORKER_LABEL[status.state] ?? { label: status.state ?? 'Unknown', tone: 'info' };
  const last = status.lastSync;
  const result = last?.status ? RUN_LABEL[last.status] ?? { label: last.status, tone: 'info' } : null;
  const active = status.activeVersion;
  const facts = [
    ['Automatic check', status.enabled ? `Every ${escape(status.intervalSeconds)} s` : 'Disabled'],
    ['Last checked', last ? escape(when(last.finishedAt)) : 'Never'],
    ['Last result', result
      ? `<span class="ci-chip" data-tone="${escape(result.tone)}"
           data-bim-run="${escape(last.status)}">${escape(result.label)}</span>
         <small>${escape(last.trigger ?? '')}${last.durationMs == null ? ''
    : ` · ${escape(last.durationMs)} ms`}</small>`
      : 'No check in this process'],
    ['Model converted', active?.convertedAt ? escape(when(active.convertedAt)) : 'Never'],
    ['Published in Speckle', active?.sourceCreatedAt ? escape(when(active.sourceCreatedAt)) : '—'],
  ];
  return `<div class="ops-sync" data-sync-state="${escape(status.state ?? '')}"
      data-sync-enabled="${Boolean(status.enabled)}">
      <div class="ops-sync-head">
        <span class="ci-chip" data-tone="${escape(worker.tone)}"
          data-bim-worker="${escape(status.state ?? '')}">Auto-sync: ${escape(worker.label)}</span>
        <span class="ci-actions-note">${escape(status.cache ?? '')}</span>
      </div>
      <dl class="ops-sync-facts">${facts.map(([label, value]) =>
    `<div><dt>${escape(label)}</dt><dd>${value}</dd></div>`).join('')}</dl>
      ${status.parkedReason ? `<p class="ci-status" data-state="error">${escape(status.parkedReason)}</p>` : ''}
      ${status.configuredReason ? `<p class="ci-status" data-state="error">${escape(status.configuredReason)}</p>` : ''}
      ${status.enableHint ? `<p class="ci-card-note">${escape(status.enableHint)}</p>` : ''}
    </div>`;
}

function summaryMarkup(report) {
  const active = report.active;
  if (!active) return '';
  const rows = [
    ['Elements', escape(num(report.elementCount))],
    ['With geometry <small>containers carry none</small>', escape(num(report.geometryCount))],
    ['Triangles', escape(num(active.triangleCount))],
    ['Model file', escape(bytes(active.glbBytes))],
    ['Units', escape(active.units ?? '—')],
    ['Source application', escape(active.sourceApplication ?? '—')],
  ];
  return `<dl class="ops-facts">${rows.map(([label, value]) =>
    `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
}

/** The IFC class filter. Every chip carries its count, so hiding one is an informed choice. */
function filtersMarkup(report, hidden) {
  const types = report.ifcTypes ?? [];
  if (!types.length) return '';
  return `<div class="rbm-filters" role="group" aria-label="Filter by IFC class">
      ${types.map(entry => {
    const off = hidden.has(entry.ifcType);
    return `<button type="button" class="rbm-filter" data-ifc-type="${escape(entry.ifcType)}"
        aria-pressed="${!off}" data-off="${off}">
        <span class="rbm-swatch" style="background:${escape(TYPE_COLOUR[entry.ifcType] ?? '#8ca0b9')}"
          aria-hidden="true"></span>
        ${escape(entry.ifcType)} <small>${escape(entry.count)}</small></button>`;
  }).join('')}
      <button type="button" class="ci-button ci-button--quiet" data-action="show-all">Show all</button>
    </div>`;
}

function elementListMarkup(report, elements, selected) {
  if (!elements.length) {
    return `<p class="ci-card-note">No elements to list.</p>`;
  }
  return `<table class="ci-table ci-table--rows rbm-table">
      <caption>Every element read from the Speckle model. Select one for its detail.</caption>
      <thead><tr>
        <th scope="col">IFC class</th><th scope="col" class="ci-col--text">Name</th>
        <th scope="col" class="ci-col--text">IFC GlobalId</th>
        <th scope="col">Storey</th><th scope="col">Triangles</th>
      </tr></thead>
      <tbody>${elements.map(entry => `<tr data-guid="${escape(entry.ifcGuid)}" tabindex="0"
        class="${selected === entry.ifcGuid ? 'is-selected' : ''}">
        <th scope="row"><span class="rbm-swatch" aria-hidden="true"
          style="background:${escape(TYPE_COLOUR[entry.ifcType] ?? '#8ca0b9')}"></span>
          ${escape(entry.ifcType ?? '—')}</th>
        <td class="ci-col--text">${escape(entry.name ?? '—')}</td>
        <td class="ci-col--text"><code>${escape(entry.ifcGuid ?? '—')}</code></td>
        <td>${escape(entry.level ?? '—')}</td>
        <td>${entry.hasGeometry ? escape(num(entry.triangleCount)) : '—'}</td>
      </tr>`).join('')}</tbody>
    </table>`;
}

/** The one details panel. Not a modal, and never a second one on top of it. */
function detailMarkup(report, selected, detail) {
  if (!selected) {
    return `<p class="ci-card-note ops-detail-empty">Select an element — in the model or in the
      list — to see its IFC GlobalId, classification and the properties the model actually
      carries.</p>`;
  }
  if (!detail) {
    return `<p class="ci-status" data-state="loading">Reading element ${escape(selected)}…</p>`;
  }
  const element = detail.element;
  if (!element) {
    return `<div class="ops-detail"><h3>${escape(selected)}</h3>
      <p class="ci-status" data-state="error">${escape(detail.reason ?? 'Not found.')}</p></div>`;
  }
  const properties = element.properties ?? {};
  const groups = new Map();
  for (const [key, value] of Object.entries(properties)) {
    // The model's own grouping: `properties.Attributes.GlobalId` becomes group "Attributes".
    const parts = String(key).split('.');
    const group = parts.length > 2 ? parts[1] : parts.length > 1 ? parts[0] : 'General';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push([parts[parts.length - 1], value]);
  }

  const facts = [
    ['Name', escape(element.name ?? '—')],
    // Verbatim, and marked as the model's own. Nothing here generated it.
    ['IFC GlobalId', `<code data-bim-guid>${escape(element.ifcGuid ?? '—')}</code>
      <small>from the model, not generated here</small>`],
    ['IFC class', escape(element.ifcType ?? '—')],
    ['Storey', element.level ? escape(element.level)
      : 'Not stated <small>this element is not assigned to a storey in the model</small>'],
    ['Geometry', element.hasGeometry
      ? `${escape(num(element.triangleCount))} triangles · ${escape(num(element.vertexCount))} vertices`
      : 'None <small>a container element; it has no mesh of its own</small>'],
    ['Model version', `${escape(report.active?.versionId ?? '—')}
      <small>Speckle version this element came from</small>`],
  ];

  return `<div class="ops-detail">
      <h3>${escape(element.name ?? element.ifcType ?? selected)}</h3>
      <dl class="ops-detail-facts">${facts.map(([label, value]) =>
    `<div><dt>${escape(label)}</dt><dd>${value}</dd></div>`).join('')}</dl>
      <p class="ci-card-note"><strong>Not linked to the schedule.</strong>
        ${escape(report.source?.noAutoMap ?? '')}</p>
      ${[...groups.entries()].map(([group, entries]) => `<details class="rbm-props" ${
    group === 'Attributes' ? 'open' : ''}>
        <summary>${escape(group)} <small>${escape(entries.length)}</small></summary>
        <dl class="ops-detail-facts">${entries.map(([key, value]) =>
    `<div><dt>${escape(key)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>
      </details>`).join('')}
    </div>`;
}

/* ── the screen ────────────────────────────────────────────────────────────────────────────── */

export function installRealBimModel(host, {
  fetchJson = request,
  eventSourceImpl = globalThis.EventSource,
  setIntervalImpl = globalThis.setInterval, clearIntervalImpl = globalThis.clearInterval,
  viewerFactory = installBimViewer,
  statusIntervalMs = 10_000,
} = {}) {
  const root = document.createElement('div');
  root.className = 'ops-root rbm-root';
  host.append(root);

  let report = null;
  let status = null;
  let elements = [];
  let error = null;
  let busy = false;
  let selected = null;
  let detail = null;
  let note = '';
  let hidden = new Set();
  let loadedVersion = null;
  let viewer = null;
  let stream = null;
  let statusTimer = null;
  let destroyed = false;

  /** The chrome, rendered into its own node so the viewer's canvas is never re-created. */
  const chrome = document.createElement('div');
  chrome.className = 'rbm-chrome';
  const stage = document.createElement('div');
  stage.className = 'rbm-stage';
  const details = document.createElement('div');
  details.className = 'rbm-details ops-detail-pane';
  const listHost = document.createElement('div');
  listHost.className = 'rbm-list ops-table-pane';
  root.append(chrome, stage, details, listHost);

  /**
   * What the reader is in the middle of, captured before the markup is replaced.
   *
   * A background sync must not scroll somebody back to the top or close a property group they
   * opened. The Cesium camera is never touched by a re-render at all — the viewer lives in its
   * own node, so the canvas and its camera survive every one of these.
   */
  function captureView() {
    return {
      pageTop: root.closest('.ci-workspaces')?.scrollTop ?? null,
      listTop: listHost.scrollTop,
      detailsTop: details.scrollTop,
      open: [...details.querySelectorAll('.rbm-props')].map(node => node.open),
    };
  }

  function restoreView(view) {
    if (!view) return;
    const scroller = root.closest('.ci-workspaces');
    if (view.pageTop != null && scroller) scroller.scrollTop = view.pageTop;
    listHost.scrollTop = view.listTop;
    details.scrollTop = view.detailsTop;
    const nodes = [...details.querySelectorAll('.rbm-props')];
    view.open.forEach((isOpen, index) => { if (nodes[index]) nodes[index].open = isOpen; });
  }

  function render() {
    const view = captureView();
    if (error) {
      chrome.innerHTML = `<p class="ci-status" data-state="error">${escape(error)}</p>`;
      return;
    }
    if (!report) {
      chrome.innerHTML = '<p class="ci-status" data-state="loading">Reading the converted Speckle model…</p>';
      return;
    }
    const visible = elements.filter(entry => !hidden.has(entry.ifcType));
    chrome.innerHTML = `
      ${headerMarkup(report)}
      ${provenanceMarkup(report.source)}
      ${syncRowMarkup(status)}
      ${report.active ? '' : `<p class="ci-status" data-state="error">${escape(report.reason ?? '')}</p>`}
      ${summaryMarkup(report)}
      ${note ? `<p class="ci-actions-note" role="status">${escape(note)}</p>` : ''}
      ${filtersMarkup(report, hidden)}`;
    details.innerHTML = detailMarkup(report, selected, detail);
    listHost.innerHTML = elementListMarkup(report, visible, selected);

    const syncButton = chrome.querySelector('[data-action="sync-now"]');
    if (syncButton && (busy || status?.running)) {
      syncButton.disabled = true;
      syncButton.textContent = 'Checking…';
    }
    restoreView(view);
  }

  /** The converted model, from OUR server. The browser never calls Speckle. */
  async function load({ background = false } = {}) {
    try {
      report = await fetchJson(`${BIM_API}/model`);
      const list = await fetchJson(`${BIM_API}/elements`);
      elements = list.elements ?? [];
      error = null;
    } catch (cause) {
      // Ours, not Speckle's: the construction API is what failed, and blaming the upstream for
      // our own server being down is a mistake this project has made once already.
      error = `The construction API could not be reached, so the BIM model is unknown: `
        + `${cause?.message ?? cause}`;
    }
    if (!background) render();
    await ensureModel();
  }

  /** Load the GLB into Cesium when the active version changes, and not otherwise. */
  async function ensureModel() {
    const active = report?.active;
    if (!active || !report.glbUrl) return;
    if (loadedVersion === active.versionId) return;
    if (!viewer) viewer = viewerFactory(stage, { onPick: guid => { if (guid) void select(guid); } });
    try {
      // `glbUrl` ALREADY carries the API base — the server builds it from its own BASE so the
      // version id can never be supplied by the browser. Prefixing it again here produced
      // /api/construction/api/construction/... and a 404 that looked like a missing model.
      await viewer.load(report.glbUrl, report.placement);
      loadedVersion = active.versionId;
      applyFilter();
      viewer.fit();
    } catch (cause) {
      note = `The model geometry could not be loaded: ${cause?.message ?? cause}`;
      render();
    }
  }

  function applyFilter() {
    if (!viewer) return;
    const types = (report?.ifcTypes ?? []).map(entry => entry.ifcType)
      .filter(type => !hidden.has(type));
    viewer.setVisibleTypes(hidden.size ? types : null);
  }

  async function select(guid, { background = false } = {}) {
    selected = guid ?? null;
    viewer?.select(selected);
    if (!selected) { detail = null; render(); return; }
    if (!background) { detail = null; render(); }
    try {
      detail = await fetchJson(`${BIM_API}/elements/${encodeURIComponent(selected)}`);
      // Frame it, but never on a BACKGROUND refresh: moving somebody's camera because a sync
      // happened is exactly the interruption this screen is supposed to avoid.
      if (!background && detail?.element?.bounds) viewer?.fitElement(detail.element.bounds);
    } catch (cause) {
      detail = { element: null, reason: `Could not read element ${selected}: ${cause?.message ?? cause}` };
    }
    render();
  }

  async function readStatus({ allowReload = true } = {}) {
    if (destroyed) return;
    try {
      status = await fetchJson(`${BIM_API}/status`);
    } catch {
      status = null;
      render();
      return;
    }
    const serverVersion = status.activeVersion?.versionId ?? null;
    if (allowReload && serverVersion && loadedVersion && serverVersion !== loadedVersion) {
      await applyUpdate('a newer model version was published');
      return;
    }
    render();
  }

  /**
   * A new version arrived. Reload, and keep the reader's place.
   *
   * The selected element survives IF ITS IFC GUID STILL EXISTS — the GUID is the model's own
   * identifier, so "the same element" is a question the model can answer. When the element is
   * gone from the new version the selection is cleared and said so, rather than silently pointing
   * at nothing.
   */
  async function applyUpdate(reason, { keepNote = false } = {}) {
    const previous = selected;
    await load({ background: true });
    const stillThere = previous && elements.some(entry => entry.ifcGuid === previous);
    /*
     * `keepNote` is for Sync Now, which has already said something more specific than this could.
     * Without it the generic "Updated automatically" overwrote "version X is already converted, so
     * nothing was downloaded" — the one sentence that tells an operator the cache worked.
     */
    if (previous && stillThere) {
      await select(previous, { background: true });
      if (!keepNote) note = `Updated automatically — ${reason}. Your selection was kept.`;
    } else if (previous) {
      selected = null;
      detail = null;
      viewer?.select(null);
      // Always said, even when the caller has its own note: silently dropping somebody's
      // selection is exactly the kind of thing a screen should admit to.
      note = `${keepNote ? `${note} ` : `Updated automatically — ${reason}. `}`
        + 'The element you had selected is not in the new version, so the selection was cleared.';
    } else if (!keepNote) {
      note = `Updated automatically — ${reason}.`;
    }
    render();
  }

  function listen() {
    if (!eventSourceImpl || destroyed) return;
    try { stream = new eventSourceImpl(`${API_BASE}${BIM_EVENTS}`); } catch { stream = null; return; }
    stream.addEventListener(SYNC_EVENT, event => {
      if (destroyed) return;
      let payload = null;
      try { payload = JSON.parse(event.data); } catch { payload = null; }
      void applyUpdate(`Speckle version ${payload?.versionId ?? 'changed'}`);
      void readStatus({ allowReload: false });
    });
  }

  async function syncNow() {
    busy = true;
    note = '';
    render();
    try {
      const outcome = await fetchJson(`${BIM_API}/sync`, { method: 'POST', body: {} });
      status = outcome.status ?? status;
      const run = outcome.run ?? {};
      note = outcome.unchanged
        ? `Checked Speckle: version ${run.versionId ?? ''} is already converted, so nothing was `
          + 'downloaded or converted.'
        : outcome.converted
          ? `Converted version ${run.versionId} — ${run.elementCount} elements, `
            + `${run.triangleCount} triangles. ${outcome.effect ?? ''}`
          : run.reason ?? 'Nothing was run.';
      await applyUpdate('Sync Now', { keepNote: true });
      await readStatus({ allowReload: false });
    } catch (cause) {
      note = `Sync Now refused: ${cause?.message ?? cause}`;
    }
    busy = false;
    render();
  }

  root.onclick = event => {
    const sync = event.target.closest('[data-action="sync-now"]');
    if (sync) { void syncNow(); return; }
    if (event.target.closest('[data-action="fit"]')) { viewer?.fit(); return; }
    if (event.target.closest('[data-action="show-all"]')) {
      hidden = new Set(); applyFilter(); render(); return;
    }
    const filter = event.target.closest('[data-ifc-type]');
    if (filter) {
      const type = filter.dataset.ifcType;
      if (hidden.has(type)) hidden.delete(type); else hidden.add(type);
      applyFilter();
      render();
      return;
    }
    const row = event.target.closest('tr[data-guid]');
    if (row) void select(row.dataset.guid);
  };

  root.onkeydown = event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest?.('tr[data-guid]');
    if (!row) return;
    event.preventDefault();
    void select(row.dataset.guid);
  };

  render();
  const ready = load()
    .then(() => readStatus({ allowReload: false }))
    .then(() => {
      listen();
      statusTimer = setIntervalImpl?.(() => { void readStatus(); }, statusIntervalMs);
      statusTimer?.unref?.();
    });

  return {
    root,
    get report() { return report; },
    get status() { return status; },
    get elements() { return elements; },
    get selected() { return selected; },
    get detail() { return detail; },
    get viewer() { return viewer; },
    select,
    syncNow,
    reload: load,
    ready,
    destroy() {
      destroyed = true;
      if (statusTimer != null) clearIntervalImpl?.(statusTimer);
      statusTimer = null;
      try { stream?.close(); } catch { /* already closed */ }
      stream = null;
      viewer?.destroy();
      root.remove();
    },
  };
}
