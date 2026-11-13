/**
 * BIM Timeline — how did this building evolve, version by version?
 *
 * ONE QUESTION, and deliberately nothing else. Phase 9C put the comparison selectors, the IFC
 * class filter, the search box, the change-category filters and a full element table under this
 * viewer, which made the simplest screen in the application the densest one. All of that moved to
 * BIM Changes; what is left is a strip of versions, a model, and a summary of the stage you are
 * looking at.
 *
 * The viewer and every piece of state are the SHARED ones (`bimWorkspace.js`), so selecting V4 and
 * a wall here and then opening Changes arrives at V3 → V4 with that wall still selected — and
 * there is only ever one Cesium context for the two screens.
 *
 * The distinction this screen must not blur: a published version is a DESIGN. "19 added in V5"
 * means somebody drew 19 elements, not that anything was built.
 */
import { escape, num } from './ciClient.js';
import { CHANGE_COLOUR } from './bimViewer.js';
import { APPEARANCE } from './bimWorkspace.js';

/** How each change kind reads. Every colour is paired with a word — never colour alone. */
export const CHANGE_LABEL = Object.freeze({
  ADDED: { label: 'Added', tone: 'ok', colour: CHANGE_COLOUR.ADDED },
  MODIFIED: { label: 'Modified', tone: 'warn', colour: CHANGE_COLOUR.MODIFIED },
  RECLASSIFIED: { label: 'Reclassified', tone: 'info', colour: CHANGE_COLOUR.RECLASSIFIED },
  REMOVED: { label: 'Removed', tone: 'bad', colour: CHANGE_COLOUR.REMOVED },
  UNCHANGED: { label: 'Unchanged', tone: 'info', colour: CHANGE_COLOUR.UNCHANGED },
});

export const PLAY_INTERVAL_MS = 1800;

const stamp = iso => (iso
  ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

/**
 * The IFC classes an element was first drawn in at this version.
 *
 * Answers "when did architectural components appear?" without the operator reading a table: a
 * class that has elements added in this version and none before it is newly introduced.
 */
export function introducedClasses(comparison) {
  if (!comparison) return [];
  const added = new Map();
  const existing = new Set();
  for (const entry of comparison.elements ?? []) {
    const type = entry.ifcType ?? 'Unclassified';
    if (entry.kind === 'ADDED') added.set(type, (added.get(type) ?? 0) + 1);
    else existing.add(type);
  }
  return [...added.entries()]
    .map(([ifcType, count]) => ({ ifcType, count, isNew: !existing.has(ifcType) }))
    .sort((a, b) => (b.isNew - a.isNew) || (b.count - a.count));
}

/* ── markup ────────────────────────────────────────────────────────────────────────────────── */

function headerMarkup(state, selected) {
  return `<header class="bt-head">
      <div class="bt-head-main">
        <h3>Building-Structural <small>Speckle Cloud</small></h3>
        <p class="bt-head-sub">${selected
    ? `${escape(selected.label)} · published ${escape(stamp(selected.sourceCreatedAt))}`
    : 'No converted version'} ·
          ${escape(state.timeline.length)} version(s) published</p>
      </div>
      <div class="bt-head-side">
        <button type="button" class="ci-button ci-button--quiet" data-action="appearance"
          aria-pressed="${state.appearance === APPEARANCE.CHANGES}">
          ${state.appearance === APPEARANCE.CHANGES
    ? 'Showing changes' : 'Showing original materials'}</button>
        <button type="button" class="ci-button ci-button--quiet" data-action="fit">Zoom to building</button>
      </div>
    </header>`;
}

/**
 * The version strip — the ONE primary version control.
 *
 * Phase 9C had a strip and a slider side by side, which is two mechanisms for one choice. The
 * strip stayed because it carries the information a slider cannot: each version's date, element
 * count and delta.
 */
function stripMarkup(state) {
  if (!state.timeline.length) {
    return `<p class="ci-card-note">No Speckle versions have been converted yet. Use
      <strong>Sync Now</strong> on the Real BIM Model screen to fetch the published history.</p>`;
  }
  return `<ol class="bt-strip" role="listbox" aria-label="BIM versions">
      ${state.timeline.map(entry => {
    const changes = entry.changesFromPrevious;
    const on = entry.versionId === state.selectedVersionId;
    return `<li><button type="button" class="bt-node" role="option" aria-selected="${on}"
        data-version="${escape(entry.versionId)}" data-selected="${on}">
        <span class="bt-label">${escape(entry.label ?? '—')}</span>
        <span class="bt-count">${escape(num(entry.elementCount))} <small>elements</small></span>
        <span class="bt-delta">${changes
    ? `<em data-kind="ADDED">+${escape(changes.added)}</em>${changes.removed
      ? `<em data-kind="REMOVED">−${escape(changes.removed)}</em>` : ''}${changes.modified
      ? `<em data-kind="MODIFIED">~${escape(changes.modified)}</em>` : ''}`
    : '<em data-kind="UNCHANGED">baseline</em>'}</span>
      </button></li>`;
  }).join('')}
    </ol>`;
}

function controlsMarkup(state, playing) {
  const index = state.timeline.findIndex(entry => entry.versionId === state.selectedVersionId);
  return `<div class="bt-controls">
      <button type="button" class="ci-button ci-button--quiet" data-action="prev"
        ${index <= 0 ? 'disabled' : ''} aria-label="Previous version">◀</button>
      <button type="button" class="ci-button" data-action="play"
        ${state.timeline.length < 2 ? 'disabled' : ''}>${playing ? '❚❚ Pause' : '▶ Play'}</button>
      <button type="button" class="ci-button ci-button--quiet" data-action="next"
        ${index < 0 || index >= state.timeline.length - 1 ? 'disabled' : ''}
        aria-label="Next version">▶</button>
      <span class="bt-position">${index >= 0
    ? `${escape(state.timeline[index].label)} · ${index + 1} of ${state.timeline.length}` : '—'}</span>
    </div>`;
}

/** The right-hand stage summary. Counts for the step you are looking at, and nothing else. */
function stageMarkup(state, selected, comparison, previous) {
  if (!selected) return '';
  const counts = comparison?.counts;
  const classes = introducedClasses(comparison);
  const newClasses = classes.filter(entry => entry.isNew);

  const rows = [
    ['IFC elements', escape(num(selected.elementCount))],
    ...(counts ? [
      [`Added since ${escape(previous?.label ?? 'the previous version')}`,
        `<span data-kind="ADDED">${escape(num(counts.added))}</span>`],
      ['Removed', `<span data-kind="REMOVED">${escape(num(counts.removed))}</span>`],
      ['Geometry modified',
        `<span data-kind="MODIFIED">${escape(num(counts.geometryChanged ?? 0))}</span>`],
      // Kept apart from geometry on purpose: between V1 and V2 of this model twenty elements
      // gained an IFC PredefinedType and not one changed shape.
      ['Property-only changes', escape(num(counts.propertiesChanged ?? 0))],
      ['Reclassified', escape(num(counts.reclassified ?? 0))],
      ['Unchanged', escape(num(counts.unchanged))],
    ] : [['Stage', 'First published version — nothing to compare against']]),
  ];

  return `<section class="bt-stage-summary">
      <h4>${escape(selected.label)}${selected.versionId === state.timeline.at(-1)?.versionId
    ? ' — latest published' : ''}
        <span class="ci-chip" data-tone="info">DESIGN, NOT CONSTRUCTION</span></h4>
      <p class="bt-stage-when">${escape(stamp(selected.sourceCreatedAt))}</p>
      <dl class="bt-stage-facts">${rows.map(([label, value]) =>
    `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>
      ${classes.length ? `<div class="bt-introduced">
        <h5>Added in this version</h5>
        <ul class="ci-ws-list">${classes.slice(0, 8).map(entry =>
    `<li><span class="rbm-swatch" aria-hidden="true"
         style="background:${escape(CHANGE_COLOUR.ADDED)}"></span>
       ${escape(entry.ifcType)} <strong>${escape(entry.count)}</strong>
       ${entry.isNew ? '<em>new classification</em>' : ''}</li>`).join('')}</ul>
      </div>` : ''}
      ${newClasses.length ? `<p class="ci-card-note">${escape(newClasses.length)} IFC
        classification(s) appear for the first time in this version.</p>` : ''}
      <p class="ci-card-note">These count what has been <strong>drawn</strong>. Verified
        construction progress is on <strong>Schedule &amp; Progress</strong>.</p>
    </section>`;
}

/**
 * The compact element summary. Five facts and one way out — not a property inspector.
 *
 * The full property comparison lives in BIM Changes; putting it here is what made the Timeline
 * crowded in the first place.
 */
function elementMarkup(state, detail, change) {
  if (!state.selectedGuid) {
    return `<p class="ci-card-note bt-pick-hint">Select an element in the model to see what it is
      and when it first appeared.</p>`;
  }
  const element = detail?.element;
  const spec = change ? CHANGE_LABEL[change.kind] ?? { label: change.kind, tone: 'info' } : null;
  const firstSeen = change?.firstSeenOrdinal
    ?? (element ? state.timeline.find(entry => entry.versionId === state.selectedVersionId)?.ordinal
      : null);
  return `<section class="bt-element">
      <h5>${escape(element?.name ?? change?.name ?? state.selectedGuid)}</h5>
      <dl class="bt-element-facts">
        <div><dt>IFC class</dt><dd>${escape(element?.ifcType ?? change?.ifcType ?? '—')}</dd></div>
        <div><dt>IFC GlobalId</dt>
          <dd><code data-bim-guid>${escape(state.selectedGuid)}</code></dd></div>
        <div><dt>First seen</dt><dd>${firstSeen ? `V${escape(firstSeen)}` : '—'}</dd></div>
        <div><dt>In this step</dt><dd>${spec
    ? `<span class="ci-chip" data-tone="${escape(spec.tone)}"
         data-bim-change="${escape(change.kind)}">${escape(spec.label)}</span>`
    : '—'}</dd></div>
      </dl>
      <button type="button" class="ci-button" data-action="investigate">View detailed changes</button>
    </section>`;
}

/* ── the screen ────────────────────────────────────────────────────────────────────────────── */

export function installBimTimeline(host, {
  workspace,
  onInvestigate = null,
  setIntervalImpl = globalThis.setInterval,
  clearIntervalImpl = globalThis.clearInterval,
  playIntervalMs = PLAY_INTERVAL_MS,
} = {}) {
  const root = document.createElement('div');
  root.className = 'bt-root';
  host.append(root);

  const chrome = document.createElement('div');
  chrome.className = 'bt-chrome';
  const stage = document.createElement('div');
  stage.className = 'bt-stage';
  const aside = document.createElement('div');
  aside.className = 'bt-aside';
  root.append(chrome, stage, aside);

  let playing = false;
  let playTimer = null;
  let detail = null;
  let unsubscribe = null;

  const { state } = workspace;

  function render() {
    const asideTop = aside.scrollTop;
    if (state.error) {
      chrome.innerHTML = `<p class="ci-status" data-state="error">${escape(state.error)}</p>`;
      return;
    }
    const selected = workspace.selected();
    const previous = workspace.baseline();
    const change = state.selectedGuid ? workspace.changeFor(state.selectedGuid) : null;

    chrome.innerHTML = `
      ${headerMarkup(state, selected)}
      ${stripMarkup(state)}
      ${controlsMarkup(state, playing)}
      ${state.note ? `<p class="ci-actions-note" role="status">${escape(state.note)}</p>` : ''}`;
    aside.innerHTML = `
      ${stageMarkup(state, selected, state.comparison, previous)}
      ${elementMarkup(state, detail, change)}`;
    aside.scrollTop = asideTop;
  }

  async function pick(guid) {
    detail = guid ? await workspace.elementDetail(guid) : null;
    render();
  }

  function setPlaying(next) {
    playing = next;
    if (playTimer != null) { clearIntervalImpl?.(playTimer); playTimer = null; }
    if (!playing) { render(); return; }
    playTimer = setIntervalImpl?.(() => {
      const index = workspace.indexOf(state.selectedVersionId);
      // Stop at the end rather than looping: a silent restart makes a viewer think the model
      // changed back.
      if (index >= state.timeline.length - 1) { setPlaying(false); return; }
      workspace.step(1);
    }, playIntervalMs);
    playTimer?.unref?.();
    render();
  }

  root.onclick = event => {
    const node = event.target.closest('[data-version]');
    if (node) { setPlaying(false); void workspace.showVersion(node.dataset.version); return; }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'prev') { setPlaying(false); workspace.step(-1); return; }
    if (action === 'next') { setPlaying(false); workspace.step(1); return; }
    if (action === 'play') { setPlaying(!playing); return; }
    if (action === 'fit') { workspace.frame(); return; }
    if (action === 'appearance') {
      workspace.setAppearance(state.appearance === APPEARANCE.CHANGES
        ? APPEARANCE.ORIGINAL : APPEARANCE.CHANGES);
      return;
    }
    if (action === 'investigate') {
      // Hands over the version, the baseline and the element — the whole point of the shared
      // store. The operator never re-picks any of them.
      onInvestigate?.({ versionId: state.selectedVersionId,
        baselineVersionId: state.baselineVersionId, ifcGuid: state.selectedGuid });
    }
  };

  function activate() {
    workspace.attach(stage, { onPick: guid => { void pick(guid); } });
    // The canvas has just changed box; let the scene catch up before the next frame.
    try { workspace.viewer?.viewer.resize(); } catch { /* not built yet */ }
    void workspace.showVersion(state.selectedVersionId);
    render();
  }

  unsubscribe = workspace.subscribe(render);
  render();

  return {
    root,
    activate,
    render,
    get playing() { return playing; },
    setPlaying,
    destroy() {
      if (playTimer != null) clearIntervalImpl?.(playTimer);
      playTimer = null;
      unsubscribe?.();
      root.remove();
    },
  };
}
