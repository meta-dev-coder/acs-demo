/**
 * Create a work package in the real OpenProject instance.
 *
 * The only screen in this application that writes to a live external system, which is why it is
 * shaped the way it is:
 *
 *   THE SUBMIT BUTTON IS NOT THE GUARD. A disabled button stops the second click, and nothing
 *   else — not a refresh, not a flaky connection, not two tabs. The guard is an IDEMPOTENCY KEY
 *   minted once per draft and kept in sessionStorage, so the same draft submitted five times is
 *   one key, and one key is one work package. Disabling the button is a courtesy on top of it.
 *
 *   IT NEVER SAYS "CREATED" BEFORE THE SOURCE SAYS SO. Every success state here is drawn from a
 *   confirmed work-package id that OpenProject returned and we then read back.
 *
 *   IT HAS A THIRD ANSWER. Created and failed are not the only outcomes: a request can be sent
 *   with no reply, and the honest report of that is "outcome unknown", with a button that goes
 *   and LOOKS rather than one that sends again.
 *
 * The field list is not invented. It comes from `/openproject/create/options`, which reads the
 * types, statuses and priorities out of the instance — so a status this server does not have is
 * never offered, and a token that may not create is told so before anything is typed.
 */
import { ensureSession, escape, request } from './ciClient.js';

/** Where a resumable draft lives. A draft is about this sitting, so sessionStorage, not local. */
export const DRAFT_KEY = 'acs-create-task-draft';

/** What the drawer shows while an attempt is in flight or after it settles. */
export const PHASE = Object.freeze({
  EDITING: 'EDITING',
  SUBMITTING: 'SUBMITTING',
  CREATED: 'CREATED',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
});

const uuid = () => (globalThis.crypto?.randomUUID?.()
  ?? `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

/** A key is per DRAFT, not per click. That distinction is the whole duplicate guard. */
export function draftKeyFor(storage = globalThis.sessionStorage) {
  try {
    const existing = storage?.getItem(DRAFT_KEY);
    if (existing && /^[A-Za-z0-9_-]{8,128}$/.test(existing)) return existing;
  } catch { /* private window: fall through and use a fresh in-memory key */ }
  const key = uuid();
  try { storage?.setItem(DRAFT_KEY, key); } catch { /* nothing to resume after a reload, then */ }
  return key;
}

/** The draft is spent once it has an answer: the NEXT task must not reuse its key. */
export function clearDraftKey(storage = globalThis.sessionStorage) {
  try { storage?.removeItem(DRAFT_KEY); } catch { /* nothing stored, nothing to clear */ }
}

/** Only the fields the server accepts, and only the ones actually filled in. */
export function collectFields(form) {
  const value = name => String(form.elements[name]?.value ?? '').trim();
  const fields = { subject: value('subject'), description: value('description') };
  for (const name of ['startDate', 'dueDate', 'estimatedHours', 'typeId', 'statusId',
    'priorityId', 'percentageDone']) {
    const raw = value(name);
    // A blank optional field is ABSENT, not zero and not the empty string: `Number('')` is 0, and
    // sending that would set a progress of 0% or an estimate of nothing on purpose.
    if (raw !== '') fields[name] = raw;
  }
  return fields;
}

/** Client-side checks, as a courtesy. OpenProject's own answer is what is displayed. */
export function localErrors(fields) {
  const errors = {};
  if (!fields.subject) errors.subject = 'A task name is required.';
  if (fields.startDate && fields.dueDate && fields.dueDate < fields.startDate) {
    errors.dueDate = 'Finish date must be on or after the start date.';
  }
  if (fields.estimatedHours != null && !(Number(fields.estimatedHours) > 0)) {
    errors.estimatedHours = 'Estimated effort must be more than zero hours.';
  }
  return errors;
}

const option = (entry, selected) =>
  `<option value="${escape(entry.id)}"${String(selected) === String(entry.id) ? ' selected' : ''}>`
  + `${escape(entry.name)}</option>`;

function selectField(id, label, list, { selected = null, hint = null } = {}) {
  if (!list?.ok) {
    // A list the instance would not give us is reported as missing, not replaced by a guess.
    return `<label class="ctd-field ctd-field--wide"><span>${escape(label)}</span>
      <select id="${escape(id)}" name="${escape(id)}" disabled></select>
      <small data-tone="warn">Not available — ${escape(list?.reason
    ?? 'OpenProject did not return this list')}. The instance default will be used.</small></label>`;
  }
  const fallback = list.values.find(entry => entry.isDefault)?.id ?? null;
  return `<label class="ctd-field"><span>${escape(label)}</span>
    <select id="${escape(id)}" name="${escape(id)}">
      ${list.values.map(entry => option(entry, selected ?? fallback)).join('')}
    </select>${hint ? `<small>${escape(hint)}</small>` : ''}</label>`;
}

function elementsMarkup(elements) {
  if (!elements.length) return '';
  return `<section class="ctd-bim">
      <h4>${escape(elements.length)} BIM element${elements.length === 1 ? '' : 's'} selected</h4>
      <ul class="ctd-elements">${elements.map(element => `<li data-guid="${escape(element.ifcGuid)}">
        <span class="ci-chip" data-tone="info">${escape(element.ifcType ?? 'IFC')}</span>
        <strong>${escape(element.name ?? element.ifcGuid)}</strong>
        <code>${escape(element.ifcGuid)}</code>
        <button type="button" class="ctd-remove" data-remove="${escape(element.ifcGuid)}"
          aria-label="Remove ${escape(element.name ?? element.ifcGuid)}">Remove</button>
      </li>`).join('')}</ul>
      <p class="ci-card-note">These become <strong>proposed</strong> mappings. A BIM Coordinator
        decides whether they are what this activity builds — creating the task from a selection
        does not approve them.</p>
    </section>`;
}

function outcomeMarkup(phase, creation, error) {
  if (phase === PHASE.CREATED) {
    const differs = (creation?.reconciliationDetail ?? []).length > 0;
    return `<div class="ctd-outcome" data-tone="ok">
      <h4>Work package #${escape(creation.workPackageId)} created</h4>
      <p>OpenProject confirmed it and it was read back${differs ? '' : ' unchanged'}.</p>
      ${differs ? `<p class="ci-card-note">OpenProject stored some values differently from the
        request. It is authoritative, so these are shown rather than overwritten:</p>
        <ul class="ctd-diffs">${creation.reconciliationDetail.map(d => `<li>
          <strong>${escape(d.field)}</strong>: asked for ${escape(d.requested)},
          stored ${escape(d.stored ?? 'nothing')}</li>`).join('')}</ul>` : ''}
      ${creation.mappingStatus === 'PROPOSED'
    ? `<p class="ci-card-note">${escape(creation.mappingDetail?.proposed ?? 0)} BIM element
          mapping(s) proposed, awaiting a BIM Coordinator.</p>` : ''}
      ${creation.mappingStatus === 'FAILED'
    ? `<p class="ctd-warn" data-tone="warn">Task created — BIM mapping requires attention.
          ${escape(creation.mappingDetail?.error ?? '')}
          <button type="button" class="ci-button" data-action="retry-mapping">Retry mapping</button>
          </p>` : ''}
      <div class="ctd-actions">
        ${creation.sourceUrl ? `<a class="ci-button" href="${escape(creation.sourceUrl)}"
          target="_blank" rel="noreferrer noopener">View in OpenProject</a>` : ''}
        <button type="button" class="ci-button ci-button--primary" data-action="open-activity">
          Open in Construction Lifecycle</button>
        <button type="button" class="ci-button ci-button--quiet" data-action="another">
          Create another</button>
      </div></div>`;
  }
  if (phase === PHASE.UNKNOWN) {
    return `<div class="ctd-outcome" data-tone="warn">
      <h4>Creation outcome unknown — review required</h4>
      <p>The request was sent to OpenProject and no answer came back, so it is not known whether
        a work package was created. ${escape(creation?.error ?? '')}</p>
      <p class="ci-card-note">Submitting again could create a second task, so that is not offered.
        Reconciling searches OpenProject for this request's own reference and adopts whatever it
        finds.</p>
      <div class="ctd-actions">
        <button type="button" class="ci-button ci-button--primary" data-action="reconcile">
          Reconcile with OpenProject</button>
      </div></div>`;
  }
  if (phase === PHASE.FAILED) {
    return `<div class="ctd-outcome" data-tone="bad">
      <h4>Not created</h4>
      <p>${escape(error ?? creation?.error ?? 'OpenProject refused the request.')}</p>
      <p class="ci-card-note">Nothing was created. The draft is kept — correct the values and
        submit again.</p></div>`;
  }
  return '';
}

export function installCreateTaskDrawer(host, {
  fetchJson = request,
  onCreated = null,
  onClose = null,
  onRemove = null,
  bim = null,
  storage = globalThis.sessionStorage,
} = {}) {
  const root = document.createElement('aside');
  root.className = 'ci-drawer ctd-drawer';
  root.setAttribute('aria-label', 'Create construction task');
  host.append(root);

  let options = null;
  let loadError = null;
  let phase = PHASE.EDITING;
  let fieldErrors = {};
  let formError = null;
  let creation = null;
  let elements = (bim?.elements ?? []).slice();
  let draft = {};

  const form = () => root.querySelector('form');

  function render() {
    if (loadError) {
      root.innerHTML = `<div class="ci-drawer-head"><h3>Create Construction Task</h3>
        <button type="button" class="ci-button ci-button--quiet" data-action="close">Close</button></div>
        <p class="ci-status" data-state="error">${escape(loadError)}</p>`;
      return;
    }
    if (!options) {
      root.innerHTML = '<p class="ci-status" data-state="loading">Asking OpenProject what it '
        + 'accepts…</p>';
      return;
    }
    const blocked = !options.permittedHere || !options.sourcePermits;
    const head = `<div class="ci-drawer-head">
        <h3>Create Construction Task</h3>
        <button type="button" class="ci-button ci-button--quiet" data-action="close">Close</button>
      </div>`;

    if (blocked) {
      root.innerHTML = `${head}
        <p class="ci-status" data-state="error">${escape(!options.permittedHere
    ? options.permissionNote : options.sourceNote)}</p>
        <p class="ci-card-note">${escape(!options.permittedHere
    ? 'This is the demo role check. Switch to a role that may create work packages.'
    : 'This is OpenProject\'s own answer: the connected token is not permitted to add work '
      + 'packages to this project.')}</p>`;
      return;
    }
    if (phase === PHASE.CREATED || phase === PHASE.UNKNOWN) {
      root.innerHTML = `${head}${outcomeMarkup(phase, creation, formError)}`;
      return;
    }

    const busy = phase === PHASE.SUBMITTING;
    const err = name => (fieldErrors[name]
      ? `<small class="ctd-error" data-tone="bad">${escape(fieldErrors[name])}</small>` : '');
    root.innerHTML = `${head}
      <p class="ctd-dest">Destination <strong>OpenProject · project ${escape(options.projectId)}</strong>
        <small>created live in the source system</small></p>
      ${phase === PHASE.FAILED ? outcomeMarkup(PHASE.FAILED, creation, formError) : ''}
      ${formError && phase !== PHASE.FAILED
    ? `<p class="ci-status" data-state="error">${escape(formError)}</p>` : ''}
      <form class="ctd-form" novalidate>
        <label class="ctd-field ctd-field--wide"><span>Task name <em>required</em></span>
          <input name="subject" type="text" maxlength="255" required
            value="${escape(draft.subject ?? '')}" ${busy ? 'disabled' : ''}>
          ${err('subject')}</label>
        <label class="ctd-field ctd-field--wide"><span>Description</span>
          <textarea name="description" rows="3" ${busy ? 'disabled' : ''}
            >${escape(draft.description ?? '')}</textarea>
          ${err('description')}</label>
        <div class="ctd-row">
          <label class="ctd-field"><span>Start date</span>
            <input name="startDate" type="date" value="${escape(draft.startDate ?? '')}"
              ${busy ? 'disabled' : ''}>${err('startDate')}</label>
          <label class="ctd-field"><span>Finish date</span>
            <input name="dueDate" type="date" value="${escape(draft.dueDate ?? '')}"
              ${busy ? 'disabled' : ''}>${err('dueDate')}</label>
        </div>
        <div class="ctd-row">
          <label class="ctd-field"><span>Estimated effort (hours)</span>
            <input name="estimatedHours" type="number" min="0.25" step="0.25"
              value="${escape(draft.estimatedHours ?? '')}" ${busy ? 'disabled' : ''}>
            ${err('estimatedHours')}</label>
          ${selectField('typeId', 'Work-package type', options.types, { selected: draft.typeId })}
        </div>
        <details class="ctd-more"${draft.statusId || draft.priorityId ? ' open' : ''}>
          <summary>More fields</summary>
          <div class="ctd-row">
            ${selectField('statusId', 'Initial status', options.statuses, { selected: draft.statusId })}
            ${selectField('priorityId', 'Priority', options.priorities, { selected: draft.priorityId })}
          </div>
          <label class="ctd-field"><span>Initial progress (%)</span>
            <input name="percentageDone" type="number" min="0" max="100" step="1"
              value="${escape(draft.percentageDone ?? '')}" ${busy ? 'disabled' : ''}>
            ${err('percentageDone')}</label>
        </details>
        ${elementsMarkup(elements)}
        <div class="ctd-actions">
          <button type="submit" class="ci-button ci-button--primary" ${busy ? 'disabled' : ''}>
            ${busy ? 'Creating in OpenProject…' : 'Create in OpenProject'}</button>
          <button type="button" class="ci-button ci-button--quiet" data-action="close"
            ${busy ? 'disabled' : ''}>Cancel</button>
        </div>
        <p class="ci-card-note">Nothing is shown as created until OpenProject confirms it and the
          record has been read back.</p>
      </form>`;
    if (!busy) root.querySelector('[name="subject"]')?.focus();
  }

  async function load() {
    try {
      // The server takes the role from its own token, so the role chosen in the navigation has to
      // become a session before asking what this person may do.
      await ensureSession();
      options = await fetchJson('/openproject/create/options');
    } catch (cause) {
      loadError = `The create form could not be prepared: ${cause?.message ?? cause}`;
    }
    render();
  }

  /** Keep what was typed, so a refusal never costs the operator their text. */
  function remember() {
    const element = form();
    if (element) draft = { ...draft, ...collectFields(element) };
  }

  async function submit() {
    remember();
    const fields = { ...draft };
    fieldErrors = localErrors(fields);
    if (Object.keys(fieldErrors).length) { formError = null; render(); return; }

    phase = PHASE.SUBMITTING;
    formError = null;
    render();

    const body = { idempotencyKey: draftKeyFor(storage), fields };
    if (elements.length) {
      body.bim = { versionId: bim?.versionId ?? null, versionLabel: bim?.versionLabel ?? null,
        elements };
    }
    try {
      const result = await fetchJson('/openproject/work-packages', { method: 'POST', body });
      creation = result.creation ?? null;
      if (creation?.status === 'OUTCOME_UNKNOWN') {
        phase = PHASE.UNKNOWN;
      } else if (creation?.workPackageId) {
        phase = PHASE.CREATED;
        // The key is spent. The next task is a different task and must get a different key.
        clearDraftKey(storage);
        onCreated?.(creation);
      } else {
        phase = PHASE.FAILED;
        fieldErrors = creation?.fieldErrors ?? {};
        formError = creation?.error ?? 'OpenProject did not confirm a work package.';
      }
    } catch (cause) {
      const payload = cause?.payload ?? {};
      creation = payload.creation ?? creation;
      fieldErrors = payload.fieldErrors ?? creation?.fieldErrors ?? {};
      formError = Object.keys(fieldErrors).length ? null : (cause?.message ?? String(cause));
      phase = PHASE.FAILED;
    }
    render();
  }

  root.onsubmit = event => { event.preventDefault(); event.stopPropagation(); void submit(); };
  // Typing in the drawer is the drawer's business too; the BIM screen has its own search box.
  root.oninput = event => event.stopPropagation();
  root.onchange = event => event.stopPropagation();

  root.onclick = async event => {
    /*
     * THE DRAWER OWNS EVERY CLICK INSIDE IT.
     *
     * It is mounted inside the screen that opened it, so without this its clicks bubble into that
     * screen's handlers. The BIM screen's element rows also carry `data-guid`, so removing an
     * element here was additionally read there as "select this element", which replaced a
     * three-element selection with a one-element one.
     *
     * A `closest('.ctd-drawer')` guard on the other side is not enough on its own: this handler
     * re-renders the drawer during the same dispatch, which detaches the clicked node, and a
     * detached node's `closest()` finds nothing. Stopping here is what makes it reliable.
     */
    event.stopPropagation();
    const action = event.target.closest('[data-action]')?.dataset.action;
    const remove = event.target.closest('[data-remove]')?.dataset.remove;
    if (remove) {
      remember();
      elements = elements.filter(entry => entry.ifcGuid !== remove);
      // Tell the screen that opened us, so the model's highlight matches this list.
      onRemove?.(remove);
      render();
      return;
    }
    if (action === 'close') { onClose?.(); return; }
    if (action === 'another') {
      phase = PHASE.EDITING; creation = null; draft = {}; fieldErrors = {}; formError = null;
      clearDraftKey(storage);
      render();
      return;
    }
    if (action === 'open-activity') { onCreated?.(creation, { open: true }); onClose?.(); return; }
    if (action === 'reconcile' && creation) {
      event.target.disabled = true;
      try {
        const result = await fetchJson(
          `/openproject/work-packages/creations/${creation.id}/reconcile`, { method: 'POST' });
        creation = result.creation ?? creation;
        if (creation?.workPackageId) { phase = PHASE.CREATED; clearDraftKey(storage);
          onCreated?.(creation); } else if (result.outcome === 'NOT_CREATED') {
          phase = PHASE.FAILED;
          formError = 'Nothing was created, so it is safe to submit again.';
        } else {
          formError = result.reason ?? creation?.error ?? null;
        }
      } catch (cause) { formError = cause?.message ?? String(cause); }
      render();
      return;
    }
    if (action === 'retry-mapping' && creation) {
      event.target.disabled = true;
      try {
        const result = await fetchJson(
          `/openproject/work-packages/creations/${creation.id}/retry-mapping`, { method: 'POST' });
        creation = result.creation ?? creation;
      } catch (cause) { formError = cause?.message ?? String(cause); }
      render();
    }
  };

  render();
  const ready = load();
  return {
    root,
    ready,
    get phase() { return phase; },
    get creation() { return creation; },
    get elements() { return elements.slice(); },
    destroy() { root.remove(); },
  };
}
