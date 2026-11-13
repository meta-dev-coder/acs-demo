/**
 * SAP Sandbox Connectivity — the one section in this project that reports a real external call.
 *
 * It exists next to the five pilot interface cards, and the hardest thing it has to do is not
 * mislead. "SAP Sandbox — Connected" beside a screen full of SAP cost figures reads as the SAP
 * cost ledger being live, so the panel states the opposite claim with equal weight and in the same
 * visual rank: `SAP S/4HANA Project Data — Not Connected`, with the reason, on every render —
 * including when the sandbox call has just succeeded. Both statuses come from the server; neither
 * is written here.
 *
 * Three states, never conflated:
 *   NOT_CONFIGURED  the key is not on the server. Not a connection failure.
 *   CONNECTED       the sandbox answered 200 with a parsable OData collection.
 *   FAILED          anything else, with the server's own reason and the failure kind.
 *
 * It has no key, no endpoint of its own and no way to name one. The server chooses the host and
 * the path; the only value this panel sends is `top`, and the server validates it anyway.
 */
import { escape, request, when } from './ciClient.js';

export const SANDBOX_API = '/sap-sandbox';

/** How each state reads, and which way it leans. The app's own tone vocabulary. */
export const SANDBOX_STATE = Object.freeze({
  NOT_CONFIGURED: { label: 'Not configured', tone: 'warn' },
  CONNECTED: { label: 'Connected', tone: 'ok' },
  FAILED: { label: 'Connection failed', tone: 'bad' },
});

/** The failure kinds, in the words an operator can act on. */
export const SANDBOX_FAILURE = Object.freeze({
  AUTH: 'The API key was rejected',
  TIMEOUT: 'The sandbox did not answer in time',
  NETWORK: 'The sandbox could not be reached',
  HTTP: 'The sandbox returned an error',
  INVALID_RESPONSE: 'The response could not be read',
  CONFIG: 'The server configuration is invalid',
  /*
   * Panel-only. The server never reports this one, because if it answered at all it is not it
   * that is unreachable. Raised below when OUR OWN API cannot be reached, where the honest thing
   * to say is that we know nothing about SAP — "the sandbox could not be reached" would blame SAP
   * for our server being down.
   */
  API_UNREACHABLE: 'The construction API could not be reached, so the SAP connection is unknown',
});

/** How many records to ask for. A connectivity panel, not an import. */
export const PANEL_TOP = 5;

const stateOf = report => SANDBOX_STATE[report?.state] ?? { label: 'Unknown', tone: 'info' };

/** A date as the operator reads it, or an honest absence — `when` already says "Never". */
const day = iso => (iso ? when(iso) : 'Never');

/**
 * Where the panel's own numbers come from.
 *
 * `recordCount` is what we kept; `receivedCount` is what SAP sent. They differ only if a record
 * failed to sanitize, and showing both is how that becomes visible instead of silent.
 */
function connectionRows(report) {
  const connection = report.connection ?? {};
  const state = stateOf(report);
  const failure = report.failure ? SANDBOX_FAILURE[report.failure] ?? report.failure : null;
  const dropped = Number.isFinite(report.receivedCount) && Number.isFinite(report.recordCount)
    && report.receivedCount !== report.recordCount;
  return [
    ['Connection status', `<span class="ci-chip" data-tone="${escape(state.tone)}"
        data-sandbox-state="${escape(report.state)}">${escape(state.label)}</span>`
      + (failure ? ` <span class="ci-card-note">${escape(failure)}</span>` : '')],
    ['API provider', escape(connection.provider ?? 'Not reported')],
    ['Environment', escape(connection.environment ?? 'Not reported')],
    ['Service', escape(connection.service ?? 'Not reported')],
    ['Entity set', `${escape(connection.entitySet ?? 'Not reported')}
      <span class="ci-card-note">${escape(connection.protocol ?? '')}</span>`],
    ['Endpoint', connection.endpoint
      ? `<code>${escape(connection.endpoint)}</code>` : 'Not available'],
    ['Authentication', `${escape(connection.authScheme ?? 'Not reported')}
      <span class="ci-card-note">The key is never sent to the browser.</span>`],
    ['Response status', report.httpStatus == null ? 'No response'
      : `HTTP ${escape(report.httpStatus)}${report.elapsedMs == null ? ''
        : ` <span class="ci-card-note">in ${escape(report.elapsedMs)} ms</span>`}`],
    ['Records returned', report.state === 'CONNECTED'
      ? `${escape(report.recordCount)}${dropped
        ? ` <span class="ci-card-note">of ${escape(report.receivedCount)} received;
            ${escape(report.receivedCount - report.recordCount)} could not be read</span>` : ''}`
      : 'None'],
    ['Last successful request', escape(day(report.lastSuccessAt))],
  ];
}

function recordsMarkup(report) {
  if (report.state !== 'CONNECTED') return '';
  if (!report.records?.length) {
    return `<p class="ci-card-note">The call succeeded and the collection is empty. The sandbox
      tenant holds no ProjectControllingObject records at this page.</p>`;
  }
  return `<table class="ci-table ci-table--rows">
      <caption>Returned by the live call above, with only the fields the server keeps. The shared
        sandbox tenant is filled with placeholder values, so "string" is SAP's own test data and
        not a rendering fault.</caption>
      <thead><tr>
        <th scope="col">External code</th>
        <th scope="col" class="ci-col--text">Name</th>
        <th scope="col" class="ci-col--text">Status</th>
        <th scope="col">Effective from</th><th scope="col">Last modified</th>
      </tr></thead>
      <tbody>${report.records.map(record => `<tr>
        <th scope="row">${escape(record.externalCode ?? 'Not recorded')}</th>
        <td class="ci-col--text">${escape(record.name ?? 'Not recorded')}</td>
        <td class="ci-col--text">${escape(statusWord(record.effectiveStatus))}</td>
        <td>${escape(dateOnly(record.effectiveStartDate))}</td>
        <td>${escape(dateOnly(record.lastModifiedDateTime))}</td>
      </tr>`).join('')}</tbody>
    </table>`;
}

/** SuccessFactors effective-dating, spelled out. The code alone means nothing to a reader. */
export function statusWord(code) {
  if (code === 'A') return 'Active (A)';
  if (code === 'I') return 'Inactive (I)';
  return code ? `${code}` : 'Not recorded';
}

/** A date, or an honest absence. Never the raw OData `/Date(…)/`. */
export function dateOnly(iso) {
  if (!iso) return 'Not recorded';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Not recorded';
  // The year-9999 sentinel is SuccessFactors' "no end date" and is not a date worth printing.
  if (date.getUTCFullYear() >= 9999) return 'No end date';
  return date.toLocaleDateString('en-GB', { dateStyle: 'medium' });
}

/**
 * Mount the section.
 *
 * @param {HTMLElement} host
 * @param {{fetchJson?: Function}} [deps] overridable so a test can drive it without a server
 */
export function installSapSandboxPanel(host, { fetchJson = request } = {}) {
  const root = document.createElement('section');
  root.className = 'ci-ws-body ci-sandbox';
  host.append(root);

  let report = null;
  let note = '';
  let busy = false;

  function render() {
    if (!report) {
      root.innerHTML = `<h2>SAP sandbox connectivity</h2>
        <p class="ci-status" data-state="loading">Testing the SAP sandbox connection…</p>`;
      return;
    }
    const state = stateOf(report);
    const s4 = report.s4hanaProjectData ?? {};
    root.innerHTML = `
      <h2>SAP sandbox connectivity</h2>
      <div class="ci-sandbox-heads">
        <p class="ci-sandbox-head" data-tone="${escape(state.tone)}">
          <strong>SAP Sandbox — ${escape(state.label)}</strong>
          <span>${escape(report.connection?.scope ?? '')}</span>
        </p>
        <p class="ci-sandbox-head" data-tone="bad">
          <strong>${escape(s4.label ?? 'SAP S/4HANA Project Data — Not Connected')}</strong>
          <span>${escape(s4.detail ?? '')}</span>
        </p>
      </div>
      ${report.reason ? `<p class="ci-status" data-state="error">${escape(report.reason)}</p>` : ''}
      <dl class="ci-sandbox-rows">${connectionRows(report).map(([label, value]) =>
    `<div><dt>${escape(label)}</dt><dd>${value}</dd></div>`).join('')}</dl>
      <div class="ci-actions">
        <button type="button" class="ci-button" data-action="test-sap"
          ${busy ? 'disabled' : ''}>${busy ? 'Testing…' : 'Test SAP Connection'}</button>
        <span class="ci-actions-note" role="status">${escape(note)}</span>
      </div>
      ${recordsMarkup(report)}
      <p class="ci-card-note">${escape(report.connection?.notS4hana ?? '')}</p>`;
  }

  /**
   * One call, for both the first load and the button.
   *
   * It always asks for the records, never only the health probe: a panel that showed "Connected"
   * from a `top=1` health call and then an empty record table would be reporting two different
   * requests as one. The server's `/health` route exists for a monitor, not for this screen.
   */
  async function load({ announce = false } = {}) {
    busy = true;
    if (announce) { note = 'Calling the SAP sandbox…'; render(); }
    try {
      report = await fetchJson(`${SANDBOX_API}/project-controlling-objects?top=${PANEL_TOP}`);
      // What came back, not a cheerful summary of it.
      note = announce
        ? (report.state === 'CONNECTED'
          ? `HTTP ${report.httpStatus} · ${report.recordCount} record(s) in ${report.elapsedMs} ms`
          : stateOf(report).label)
        : '';
    } catch (error) {
      // The endpoint answers 200 for every reported state, so reaching here is the endpoint
      // itself being unreachable — which is our server, not SAP's.
      report = { state: 'FAILED', failure: 'API_UNREACHABLE', connection: {}, records: [],
        recordCount: 0, httpStatus: null, lastSuccessAt: report?.lastSuccessAt ?? null,
        s4hanaProjectData: report?.s4hanaProjectData ?? null,
        reason: `The construction API could not be reached: ${error?.message ?? error}. `
          + 'This is our own server, not SAP — the state of the SAP connection is unknown.' };
      note = announce ? 'Connection test failed' : '';
    }
    busy = false;
    render();
  }

  root.onclick = event => {
    if (!event.target.closest('button[data-action="test-sap"]')) return;
    void load({ announce: true });
  };

  render();
  const ready = load();
  return { root, reload: () => load(), get report() { return report; }, ready,
    destroy() { root.remove(); } };
}
