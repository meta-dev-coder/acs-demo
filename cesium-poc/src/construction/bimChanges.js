/**
 * BIM Changes — what exactly changed between two published versions?
 *
 * The technical workspace. Everything that used to crowd the Timeline lives here: the version
 * pair, the filters, the search, the full element list and the property-level comparison.
 *
 * Two rules the comparison engine establishes and this screen must not undo:
 *
 *   1. A PROPERTY CHANGE IS NOT A GEOMETRY CHANGE. Between V1 and V2 of the real model twenty
 *      elements gained an IFC `PredefinedType` and not one moved. The summary counts them
 *      separately and the 3D uses a distinct marker, so "modified" never silently means "the
 *      shape changed".
 *   2. UNCHANGED GEOMETRY IS CONTEXT, NOT NOISE. Filtering the LIST to added walls must not strip
 *      the building out from under them, or an added wall becomes a rectangle floating in space.
 *      The list filter and the 3D visibility are separate controls, and the 3D one defaults to
 *      showing everything.
 *
 * It shares the viewer and the selection with BIM Timeline through `bimWorkspace.js`, so arriving
 * here from "View detailed changes" needs no re-picking.
 */
import { escape, num } from './ciClient.js';
import { installCreateTaskDrawer } from './createTaskDrawer.js';
import { CHANGE_COLOUR } from './bimViewer.js';
import { APPEARANCE } from './bimWorkspace.js';
import { CHANGE_LABEL } from './bimTimeline.js';

/**
 * The filter buckets.
 *
 * `MODIFIED` is split into its two real dimensions because the engine keeps them apart and a
 * single "modified" bucket would re-merge exactly what Phase 9C worked to separate.
 */
export const FILTERS = Object.freeze([
  { id: 'ADDED', label: 'Added', colour: CHANGE_COLOUR.ADDED },
  { id: 'REMOVED', label: 'Removed', colour: CHANGE_COLOUR.REMOVED },
  { id: 'GEOMETRY', label: 'Geometry modified', colour: CHANGE_COLOUR.MODIFIED },
  { id: 'PROPERTIES', label: 'Property modified', colour: CHANGE_COLOUR.RECLASSIFIED },
  { id: 'RECLASSIFIED', label: 'Reclassified', colour: CHANGE_COLOUR.RECLASSIFIED },
  { id: 'UNCHANGED', label: 'Unchanged', colour: CHANGE_COLOUR.UNCHANGED },
]);

/**
 * Does this element belong in the bucket?
 *
 * Exported because it is the one piece of real logic here and the mutually-exclusive-totals rule
 * depends on it: an element that is MODIFIED *and* reclassified appears under both GEOMETRY (or
 * PROPERTIES) and RECLASSIFIED, and is counted once in each — never added into a single total
 * that would then exceed the number of elements.
 */
export function matchesFilter(entry, id) {
  const dimensions = entry.dimensions ?? [];
  switch (id) {
    case 'ADDED': return entry.kind === 'ADDED';
    case 'REMOVED': return entry.kind === 'REMOVED';
    case 'GEOMETRY': return dimensions.includes('GEOMETRY');
    case 'PROPERTIES': return dimensions.includes('PROPERTIES');
    case 'RECLASSIFIED': return Boolean(entry.reclassified);
    case 'UNCHANGED': return entry.kind === 'UNCHANGED';
    default: return true;
  }
}

/** Apply the list filters. Pure, so the counts and the rows can never disagree. */
export function filterElements(elements, { kinds, ifcType, search }) {
  const needle = search ? String(search).trim().toLowerCase() : '';
  return (elements ?? []).filter(entry => {
    if (kinds?.size && ![...kinds].some(id => matchesFilter(entry, id))) return false;
    if (ifcType && entry.ifcType !== ifcType) return false;
    if (needle && !(String(entry.name ?? '').toLowerCase().includes(needle)
      || String(entry.ifcGuid ?? '').toLowerCase().includes(needle))) return false;
    return true;
  });
}

/* ── markup ────────────────────────────────────────────────────────────────────────────────── */

function toolbarMarkup(state, workspace) {
  const options = (selectedId, disabledId) => state.timeline.map(entry =>
    `<option value="${escape(entry.versionId)}" ${entry.versionId === selectedId ? 'selected' : ''}
       ${entry.versionId === disabledId ? 'disabled' : ''}>${escape(entry.label)} ·
       ${escape(num(entry.elementCount))} elements</option>`).join('');
  const previous = workspace.previousOf(state.selectedVersionId);
  return `<div class="bc-toolbar">
      <label>Compare from
        <select data-action="from">${options(state.baselineVersionId, state.selectedVersionId)}</select>
      </label>
      <button type="button" class="ci-button ci-button--quiet" data-action="swap"
        aria-label="Swap the two versions">⇄</button>
      <label>to
        <select data-action="to">${options(state.selectedVersionId, state.baselineVersionId)}</select>
      </label>
      <button type="button" class="ci-button ci-button--quiet" data-action="baseline"
        ${state.timeline[0]?.versionId === state.baselineVersionId ? 'disabled' : ''}>
        vs baseline</button>
      <button type="button" class="ci-button ci-button--quiet" data-action="previous"
        ${!previous || previous.versionId === state.baselineVersionId ? 'disabled' : ''}>
        vs previous</button>
      <span class="bc-spacer"></span>
      <button type="button" class="ci-button ci-button--quiet" data-action="appearance"
        aria-pressed="${state.appearance === APPEARANCE.CHANGES}">
        ${state.appearance === APPEARANCE.CHANGES
    ? 'Showing changes' : 'Showing original materials'}</button>
      <button type="button" class="ci-button ci-button--quiet" data-action="fit">Zoom to building</button>
    </div>
    <div class="bc-toolbar bc-toolbar--select">
      <label class="bc-multi">
        <input type="checkbox" data-action="multi" ${state.multiSelect ? 'checked' : ''}>
        Select several elements
      </label>
      <span class="bc-selected">${state.selectedGuids.length
    ? `${escape(state.selectedGuids.length)} BIM element${state.selectedGuids.length === 1 ? '' : 's'} selected`
    : 'Click an element in the model. Ctrl or Shift-click adds to the selection.'}</span>
      <button type="button" class="ci-button ci-button--quiet" data-action="clear-selection"
        ${state.selectedGuids.length ? '' : 'disabled'}>Clear</button>
      <span class="bc-spacer"></span>
      <button type="button" class="ci-button ci-button--primary" data-action="create-task"
        ${state.selectedGuids.length ? '' : 'disabled'}>+ Create Construction Task</button>
    </div>`;
}

/**
 * The counts.
 *
 * Every number is a count of elements matching that dimension. They are NOT mutually exclusive and
 * are never summed into a single total — an element can be geometry-modified and reclassified at
 * once, and forcing the figures to add up would mean dropping one of them.
 */
function summaryMarkup(comparison, activeKinds) {
  if (!comparison) return '';
  const elements = comparison.elements ?? [];
  const counts = FILTERS.map(filter => ({ ...filter,
    count: elements.filter(entry => matchesFilter(entry, filter.id)).length }));
  return `<div class="bc-summary" role="group" aria-label="Filter by change">
      ${counts.map(entry => {
    const on = activeKinds.has(entry.id);
    return `<button type="button" class="bc-count" data-filter="${escape(entry.id)}"
        aria-pressed="${on}" data-on="${on}">
        <span class="rbm-swatch" aria-hidden="true" style="background:${escape(entry.colour)}"></span>
        <strong>${escape(num(entry.count))}</strong> ${escape(entry.label)}</button>`;
  }).join('')}
      <span class="bc-total">${escape(num(elements.length))} elements compared</span>
    </div>`;
}

function listMarkup(rows, total, selectedGuid, filtered) {
  if (!rows.length) {
    return `<p class="ci-card-note">${filtered
      ? `No elements match. ${escape(num(total))} were compared in total.`
      : 'Choose two versions to compare.'}</p>`;
  }
  return `<ul class="bc-list" role="listbox" aria-label="Changed elements">
      ${rows.map(entry => {
    const spec = CHANGE_LABEL[entry.kind] ?? { label: entry.kind, tone: 'info' };
    return `<li><button type="button" class="bc-item" role="option"
        aria-selected="${selectedGuid === entry.ifcGuid}"
        data-guid="${escape(entry.ifcGuid)}" data-selected="${selectedGuid === entry.ifcGuid}">
        <span class="bc-item-head">
          <span class="ci-chip" data-tone="${escape(spec.tone)}"
            data-bim-change="${escape(entry.kind)}">${escape(spec.label)}</span>
          ${entry.reclassified && entry.kind !== 'RECLASSIFIED'
    ? '<span class="ci-chip" data-tone="info">reclassified</span>' : ''}
          <strong>${escape(entry.name ?? '—')}</strong>
        </span>
        <span class="bc-item-meta">${escape(entry.ifcType ?? '—')}
          <code>${escape(entry.ifcGuid)}</code></span>
        <span class="bc-item-detail">${escape(entry.detail ?? '')}</span>
      </button></li>`;
  }).join('')}
    </ul>`;
}

/** The property comparison. Only paths that ACTUALLY differ, with both values. */
function propertyMarkup(change) {
  const changes = change?.propertyChanges ?? [];
  if (!changes.length) return '';
  return `<section class="bc-props">
      <h5>Changed properties <small>${escape(changes.length)}</small></h5>
      <table class="ci-table bc-prop-table">
        <thead><tr><th scope="col" class="ci-col--text">Property</th>
          <th scope="col" class="ci-col--text">Before</th>
          <th scope="col" class="ci-col--text">After</th></tr></thead>
        <tbody>${changes.map(entry => `<tr>
          <th scope="row" class="ci-col--text"><code>${escape(entry.key)}</code></th>
          <td class="ci-col--text">${escape(entry.before ?? '—')}</td>
          <td class="ci-col--text">${escape(entry.after ?? '—')}</td>
        </tr>`).join('')}</tbody>
      </table>
      <p class="ci-card-note">Only properties whose value actually differs are listed. The
        exporter's own bookkeeping — internal ids, timestamps, owner history — is excluded.</p>
    </section>`;
}

function detailMarkup(state, detail, change) {
  if (!state.selectedGuid) {
    return `<p class="ci-card-note ops-detail-empty">Select an element — in the list or in the
      model — to see what changed about it.</p>`;
  }
  const element = detail?.element;
  const spec = change ? CHANGE_LABEL[change.kind] ?? { label: change.kind, tone: 'info' } : null;
  const geometry = (change?.dimensions ?? []).includes('GEOMETRY');

  const facts = [
    ['Name', escape(element?.name ?? change?.name ?? '—')],
    ['IFC GlobalId', `<code data-bim-guid>${escape(state.selectedGuid)}</code>
      <small>from the model, not generated here</small>`],
    ['IFC class', `${escape(element?.ifcType ?? change?.ifcType ?? '—')}${change?.previousIfcType
    ? ` <small>was ${escape(change.previousIfcType)}</small>` : ''}`],
    ['Change', spec
      ? `<span class="ci-chip" data-tone="${escape(spec.tone)}"
           data-bim-change="${escape(change.kind)}">${escape(spec.label)}</span>` : '—'],
    ['First seen', change?.firstSeenOrdinal ? `V${escape(change.firstSeenOrdinal)}` : '—'],
    ['Geometry', geometry
      ? `<span data-kind="MODIFIED">changed</span>`
      : change?.retessellated
        // Said plainly, because the counts deliberately do not call this a change.
        ? 'rebuilt by the exporter — same shape, position and surface area'
        : element?.hasGeometry ? 'unchanged' : 'none <small>a container element</small>'],
  ];

  return `<div class="ops-detail bc-detail">
      <h4>${escape(element?.name ?? change?.name ?? state.selectedGuid)}</h4>
      <dl class="ops-detail-facts">${facts.map(([label, value]) =>
    `<div><dt>${escape(label)}</dt><dd>${value}</dd></div>`).join('')}</dl>
      ${change?.detail ? `<p class="ci-card-note">${escape(change.detail)}</p>` : ''}
      ${!element && change?.kind === 'REMOVED' ? `<p class="ci-status" data-state="error">
        This element is not in the newer version. 3D visualisation of removed geometry is not
        implemented, so it is listed here but not drawn — the older version's model would have to
        be loaded alongside the newer one.</p>` : ''}
      ${propertyMarkup(change)}
    </div>`;
}

/* ── the screen ────────────────────────────────────────────────────────────────────────────── */

export function installBimChanges(host, { workspace, onNavigate = null } = {}) {
  const root = document.createElement('div');
  root.className = 'bc-root';
  host.append(root);

  const chrome = document.createElement('div');
  chrome.className = 'bc-chrome';
  const stage = document.createElement('div');
  stage.className = 'bc-stage';
  const panel = document.createElement('div');
  panel.className = 'bc-panel';
  root.append(chrome, stage, panel);

  const { state } = workspace;
  let activeKinds = new Set();
  let drawer = null;

  /**
   * Create a task from what is selected in the model.
   *
   * The elements are resolved to their PUBLISHED IFC identity first — the stored GlobalId and
   * class, not anything read off the viewer — because a Cesium feature id would be meaningless
   * in both OpenProject and Speckle, and the server refuses one anyway.
   */
  async function openCreate() {
    const elements = await workspace.selectedElements();
    if (!elements.length) return;
    const version = workspace.selected();
    drawer?.destroy();
    drawer = installCreateTaskDrawer(root, {
      bim: { versionId: version?.versionId ?? state.selectedVersionId,
        versionLabel: version?.label ?? null, elements },
      /* Removing an element in the drawer deselects it in the model, so the two never disagree. */
      onRemove(guid) { void workspace.toggle(guid); },
      onClose() { drawer?.destroy(); drawer = null; root.dataset.drawer = 'closed'; render(); },
      onCreated(created, { open = false } = {}) {
        if (open) {
          drawer?.destroy(); drawer = null; root.dataset.drawer = 'closed';
          // The mappings are PROPOSED; the lifecycle's Link BIM stage is where they are decided.
          onNavigate?.('lifecycle', { workPackageId: created.workPackageId });
        }
      },
    });
    root.dataset.drawer = 'open';
  }
  let ifcType = '';
  let search = '';
  let detail = null;
  let unsubscribe = null;
  let searchTimer = null;

  function render() {
    const panelTop = panel.scrollTop;
    const listTop = panel.querySelector('.bc-list-wrap')?.scrollTop ?? 0;

    if (state.error) {
      chrome.innerHTML = `<p class="ci-status" data-state="error">${escape(state.error)}</p>`;
      return;
    }
    if (state.timeline.length < 2) {
      chrome.innerHTML = `<p class="ci-card-note">Only ${escape(state.timeline.length)} version
        has been converted, so there is nothing to compare yet. Publish another version in Speckle,
        or use <strong>Sync Now</strong> on the Real BIM Model screen.</p>`;
      panel.innerHTML = '';
      return;
    }

    const comparison = state.comparison;
    const all = comparison?.elements ?? [];
    const rows = filterElements(all, { kinds: activeKinds, ifcType, search });
    const change = state.selectedGuid ? workspace.changeFor(state.selectedGuid) : null;
    const types = [...new Set(all.map(entry => entry.ifcType ?? 'Unclassified'))].sort();

    chrome.innerHTML = `
      ${toolbarMarkup(state, workspace)}
      ${summaryMarkup(comparison, activeKinds)}
      ${state.note ? `<p class="ci-actions-note" role="status">${escape(state.note)}</p>` : ''}`;

    panel.innerHTML = `
      <div class="bc-refine">
        <label>IFC class
          <select data-action="ifc">
            <option value="">All classes</option>
            ${types.map(type => `<option value="${escape(type)}"
              ${ifcType === type ? 'selected' : ''}>${escape(type)}</option>`).join('')}
          </select>
        </label>
        <label>Search
          <input type="search" data-action="search" value="${escape(search)}"
            placeholder="name or IFC GlobalId">
        </label>
        <label class="bc-context">
          <input type="checkbox" data-action="hide-unchanged"
            ${state.hiddenKinds.has('UNCHANGED') ? 'checked' : ''}>
          Hide unchanged in 3D
        </label>
      </div>
      <div class="bc-list-wrap">${listMarkup(rows, all.length, state.selectedGuid,
    Boolean(activeKinds.size || ifcType || search))}</div>
      ${detailMarkup(state, detail, change)}`;

    panel.scrollTop = panelTop;
    const wrap = panel.querySelector('.bc-list-wrap');
    if (wrap) wrap.scrollTop = listTop;
  }

  async function pick(guid, { zoom = false } = {}) {
    detail = guid ? await workspace.select(guid, { zoom }) : null;
    render();
  }

  root.onclick = event => {
    /*
     * The create drawer is a CHILD of this root, so its own clicks bubble through here.
     *
     * Its element list uses `data-guid` too, which meant removing an element inside the drawer
     * also hit the table's row handler and toggled the model selection a second time — the strip
     * and the drawer then disagreed about how many elements were chosen. The drawer owns its own
     * clicks; it tells us about the ones we need to know about through `onRemove`.
     */
    if (event.target.closest('.ctd-drawer')) return;
    const item = event.target.closest('[data-guid]');
    if (item) {
      // The table honours the same modifier as the model, so a selection can be built from
      // either and means the same thing in both.
      if (event.ctrlKey || event.metaKey || event.shiftKey || state.multiSelect) {
        void workspace.toggle(item.dataset.guid).then(found => { detail = found; render(); });
      } else void pick(item.dataset.guid, { zoom: true });
      return;
    }
    const filter = event.target.closest('[data-filter]')?.dataset.filter;
    if (filter) {
      if (activeKinds.has(filter)) activeKinds.delete(filter); else activeKinds.add(filter);
      render();
      return;
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'swap') { workspace.swap(); return; }
    if (action === 'baseline') {
      void workspace.setBaseline(state.timeline[0]?.versionId ?? null);
      return;
    }
    if (action === 'previous') {
      void workspace.setBaseline(workspace.previousOf(state.selectedVersionId)?.versionId ?? null);
      return;
    }
    if (action === 'fit') { workspace.frame(); return; }
    if (action === 'clear-selection') { workspace.clearSelection(); return; }
    if (action === 'create-task') { void openCreate(); return; }
    if (action === 'appearance') {
      workspace.setAppearance(state.appearance === APPEARANCE.CHANGES
        ? APPEARANCE.ORIGINAL : APPEARANCE.CHANGES);
    }
  };

  root.onchange = event => {
    const action = event.target.dataset.action;
    if (action === 'multi') { workspace.setMultiSelect(event.target.checked); return; }
    if (action === 'from') { void workspace.setBaseline(event.target.value); return; }
    if (action === 'to') { void workspace.showVersion(event.target.value); return; }
    if (action === 'ifc') { ifcType = event.target.value; render(); return; }
    if (action === 'hide-unchanged') {
      // Explicitly asked for. The 3D keeps unchanged geometry by default because it is the
      // spatial context that makes an added element legible.
      workspace.toggleKind('UNCHANGED');
    }
  };

  root.oninput = event => {
    if (event.target.dataset.action !== 'search') return;
    search = event.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 200);
  };

  function activate() {
    workspace.attach(stage, { onPick: guid => { void pick(guid); } });
    try { workspace.viewer?.viewer.resize(); } catch { /* not built yet */ }
    void workspace.showVersion(state.selectedVersionId);
    if (state.selectedGuid && !detail) void pick(state.selectedGuid);
    render();
  }

  unsubscribe = workspace.subscribe(render);
  render();

  return {
    root,
    activate,
    render,
    /** Arrive from the Timeline with a version pair and an element already chosen. */
    async focus({ versionId, baselineVersionId, ifcGuid } = {}) {
      if (baselineVersionId) await workspace.setBaseline(baselineVersionId);
      if (versionId) await workspace.showVersion(versionId);
      if (ifcGuid) await pick(ifcGuid);
      render();
    },
    get filters() { return { kinds: [...activeKinds], ifcType, search }; },
    destroy() {
      clearTimeout(searchTimer);
      unsubscribe?.();
      root.remove();
    },
  };
}
