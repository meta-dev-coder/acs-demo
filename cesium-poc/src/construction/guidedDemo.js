/**
 * The guided demonstration — a dismissible rail, not a mode.
 *
 * It never drives the application: each step names the workspace and the action, and a click
 * takes the operator there. The state comes from the server, which checks the database every time
 * it is asked — so a step is "done" because the records say so, and a step the operator does by
 * hand without the rail still turns green.
 *
 * It is optional and collapsed by default: a demonstration aid must not sit between an operator
 * and the six workspaces.
 */
import { escape, request } from './ciClient.js';

const STATE_TONE = Object.freeze({ done: 'ok', ready: 'warn', blocked: 'info' });

export function installGuidedDemo(host, { onGo = null } = {}) {
  const root = document.createElement('aside');
  root.className = 'gd-rail';
  root.hidden = true;
  host.append(root);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'gd-toggle';
  toggle.textContent = 'Guided demo';
  host.append(toggle);

  let data = null;
  let open = false;
  let view = 'steps';

  function render() {
    root.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (!open) return;
    if (!data) { root.innerHTML = '<p class="ci-status">Checking what has happened so far…</p>'; return; }
    root.innerHTML = `
      <header class="gd-head">
        <div><strong>Guided demo</strong>
          <small>${data.completed} of ${data.total} steps done</small></div>
        <button type="button" class="ci-button ci-button--quiet" data-gd="close">Hide</button>
      </header>
      <div class="aom-tabs ci-subtabs gd-tabs" role="tablist">
        <button role="tab" type="button" data-gd-view="steps" aria-selected="${view === 'steps'}">Walkthrough</button>
        <button role="tab" type="button" data-gd-view="scenarios" aria-selected="${view === 'scenarios'}">Scenarios</button>
      </div>
      ${view === 'steps' ? `<ol class="gd-steps">${data.steps.map((step, index) => `<li data-tone="${STATE_TONE[step.state]}">
          <button type="button" data-gd-go="${escape(step.workspace)}">
            <span class="gd-n">${index + 1}</span>
            <span class="gd-title">${escape(step.title)}</span>
            <span class="ci-chip" data-tone="${STATE_TONE[step.state]}">${escape(step.state)}</span>
          </button>
          <small>${escape(step.action)}</small>
          <small class="gd-detail">${escape(step.detail)}</small>
          ${step.blockedNote ? `<small class="gd-blocked">${escape(step.blockedNote)}</small>` : ''}
        </li>`).join('')}</ol>
        <p class="ci-card-note">${escape(data.note)}</p>`
    : `<ul class="gd-scenarios">${data.scenarios.map(entry => `<li>
          <button type="button" data-gd-go="${escape(entry.workspace)}">
            <span class="gd-title">${escape(entry.title)}</span>
            <span class="ci-chip" data-tone="${entry.inEvidence ? 'ok' : 'info'}">${entry.inEvidence ? `${entry.count} in evidence` : 'not yet'}</span>
          </button>
          <small>${escape(entry.how)}</small>
        </li>`).join('')}</ul>`}
      <button type="button" class="ci-button ci-button--quiet gd-reset" data-gd="reset">Reset demo data…</button>`;
  }

  async function load() {
    try { data = await request('/demo/walkthrough'); } catch { data = null; }
    render();
  }

  toggle.onclick = () => { open = !open; if (open) void load(); render(); };

  root.onclick = async event => {
    const view_ = event.target.closest('[data-gd-view]');
    if (view_) { view = view_.dataset.gdView; render(); return; }
    const go = event.target.closest('[data-gd-go]');
    if (go) { onGo?.(go.dataset.gdGo); return; }
    const action = event.target.closest('[data-gd]')?.dataset.gd;
    if (action === 'close') { open = false; render(); return; }
    if (action === 'reset') {
      // Confirmed before anything is cleared, and scoped to this project alone.
      const sure = globalThis.confirm?.(
        'Reset the Construction Integration Demo?\n\n'
        + 'This clears its synced records, mappings, exceptions, approvals and write-backs, and '
        + 'reseeds its synthetic source systems. It affects this project only — I-595 is a '
        + 'separate application with its own data and is untouched.');
      if (!sure) return;
      await request('/reset', { method: 'POST', body: {} });
      await load();
      onGo?.('integrationOverview', { reloaded: true });
    }
  };

  return {
    root, toggle, reload: load,
    get open() { return open; },
    destroy() { root.remove(); toggle.remove(); },
  };
}
