/**
 * The What-if panel: set up a failure, see what it does.
 *
 * Two views, not a wizard. The earlier Configure → Run → Results stepper made a three-stage
 * process out of what is really one question and one answer, and put the controls, the failure
 * list and the result in one scrolling column. Here the panel is either asking or answering.
 *
 * The vocabulary on screen is an operator's: "Equipment stops working", not COMPLETE_FAILURE;
 * "Impaired", not INTERMITTENT. Every enum travels unchanged underneath — the engine, its result
 * and its tests see exactly what they saw before. Technical identifiers, dependency reasoning and
 * the careful long-form statements live under a collapsed "Technical details".
 *
 * It owns the scenario and nothing else: the engine decides what a scenario means, the workspace
 * decides what the scene and the other panels do about it. No equipment record is ever written to.
 */
import { makeDraggable } from '../draggablePanel.js';
import { runScenario } from '../simulation/gantry/scenarioEngine.js';
import { addFailure, createScenario, FAILURE_MODES, nextSequence, removeFailure, withConditions,
  withDetails } from '../simulation/gantry/scenarioState.js';
import { normaliseWeather, WEATHER_PRESETS } from '../simulation/gantry/weatherImpact.js';
import { INCIDENT_PRESETS, normaliseIncident } from '../simulation/gantry/trafficImpact.js';
import { applyMitigations, MITIGATIONS, mitigationOutcome } from '../simulation/gantry/mitigations.js';
import { compareScenario } from '../simulation/gantry/scenarioComparison.js';
import { deleteScenario, listScenarios, loadScenario, saveScenario } from '../simulation/gantry/scenarioStore.js';
import { validateScenario } from '../simulation/gantry/scenarioValidation.js';
import { ASSUMPTION_FIELDS, DEMO_BASELINE, readPath, validateBaseline, withAssumption }
  from '../simulation/gantry/syntheticTollingBaseline.js';

const escape = value => String(value ?? '').replace(/[&<>"]/g, character => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));

/**
 * What an operator calls each failure. The enum is what the engine is given; this is what is read.
 * Ordered as they are offered: the common cases first.
 */
const MODE_WORDS = Object.freeze([
  { id: 'COMPLETE_FAILURE', label: 'Equipment stops working' },
  { id: 'INTERMITTENT_FAILURE', label: 'Equipment works intermittently' },
  { id: 'DEGRADED_PERFORMANCE', label: 'Equipment performs poorly' },
  { id: 'COMMUNICATION_FAILURE', label: 'Equipment loses communication' },
  { id: 'POWER_FAILURE', label: 'Equipment loses power' },
]);
const modeWord = id => MODE_WORDS.find(mode => mode.id === id)?.label ?? FAILURE_MODES[id]?.label ?? id;

/** Conditions in plain words. The enum values are untouched in the data. */
const STATUS_WORDS = Object.freeze({
  OPERATIONAL: 'Operational', DEGRADED: 'Degraded', FAILED: 'Failed',
  UNDER_MAINTENANCE: 'Under maintenance', INTERMITTENT: 'Intermittent',
  COMMUNICATION_LOST: 'Communication lost', NOT_CONNECTED: 'Not connected',
});
/** What the effective condition amounts to: out of service, or working but not properly. */
const CONDITION_WORDS = Object.freeze({ failed: 'Out of service', impaired: 'Impaired', none: 'Unaffected' });
const ZONE_WORDS = Object.freeze({
  UNKNOWN: 'Not yet determined', REDUCED: 'Reduced capability',
  UNAVAILABLE: 'Capability unavailable', UNAFFECTED: 'Unaffected',
});
const statusWord = status => STATUS_WORDS[status] ?? String(status ?? '—');
const band = state => (state.simulatedStatus === 'FAILED' ? 'failed'
  : state.simulatedStatus === 'OPERATIONAL' || state.simulatedStatus === 'NOT_CONNECTED' ? 'none' : 'impaired');

/** The durations an operator actually reaches for. Anything else is a question for later. */
const DURATIONS = Object.freeze([
  { minutes: 30, label: '30 min' }, { minutes: 60, label: '1 hour' }, { minutes: 120, label: '2 hours' },
]);
const durationWord = minutes => (minutes === 60 ? 'one hour'
  : minutes === 120 ? 'two hours' : `${minutes} minutes`);

/**
 * @param {HTMLElement} host
 * @param {{inventory: () => object[], selected: () => object|null, gantryId: string,
 *          onScenario: (result: object|null, scenario: object|null) => void,
 *          onFocusAsset?: (assetId: string, options?: object) => void,
 *          onOpenChange?: (open: boolean) => void}} deps
 */
export function installScenarioPanel(host, { inventory, selected, gantryId = null, onScenario = () => {},
  onFocusAsset = null, onOpenChange = () => {}, tollingZones = () => [] } = {}) {
  const panel = document.createElement('section');
  panel.className = 'sim-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Equipment what-if');
  panel.innerHTML = `
    <header class="sim-head">
      <div>
        <h2>Equipment What-if</h2>
        <p class="sim-sub">Explore how equipment failures affect tolling operations</p>
      </div>
      <span class="sim-demo" title="The equipment condition this starts from is demonstration data, not live telemetry.">Demo simulation</span>
      <button type="button" class="sim-close" aria-label="Close equipment what-if">×</button>
    </header>
    <div class="sim-body" data-body></div>`;
  host.append(panel);

  const body = panel.querySelector('[data-body]');
  const drag = makeDraggable(panel, panel.querySelector('.sim-head'));

  let scenario = null;
  let result = null;
  let sequence = 1;
  /** 'setup' while asking, 'impact' while answering. */
  let view = 'setup';
  /** The failure being configured, before it joins the scenario. */
  let mode = 'COMPLETE_FAILURE';
  let parameters = { availabilityPercent: 60, performancePercent: 70 };
  let durationMinutes = 60;
  let focusIndex = -1;
  let showTechnical = false;
  /**
   * Assets deliberately kept in the scenario through "Add another equipment".
   *
   * Without this, selecting a second asset and pressing See impact quietly produced a two-asset
   * scenario: the panel answered about equipment the operator had moved on from. The selected
   * asset is the subject; anything else is here because it was explicitly added.
   */
  let pinned = new Set();
  /** The synthetic financial assumptions in force. Editable, and resettable to the demo defaults. */
  let assumptions = DEMO_BASELINE;
  let showAssumptions = false;
  /** Phase 3 conditions, held beside the equipment failure until the scenario is built. */
  let weatherId = 'CLEAR';
  let incidentId = '';
  let mitigationIds = new Set();
  let comparison = null;
  let mitigated = null;
  let showMitigations = false;
  let showSaved = false;
  let saved = [];
  let loadWarnings = [];

  const selectedAsset = () => {
    const asset = selected();
    if (!asset) return null;
    const id = asset.assetId ?? asset.id;
    return inventory().find(item => item.assetId === id) ?? null;
  };

  function ensureScenario() {
    if (!scenario) scenario = createScenario({ gantryId, sequence, now: Date.now(), durationMinutes });
    return scenario;
  }

  /** Editing after a run: the answer no longer describes the question, so it is put away. */
  function invalidateResult() {
    if (!result) return;
    result = null;
    focusIndex = -1;
    onScenario(null, scenario);
  }

  // ── the question ──────────────────────────────────────────────────────────────────────────────
  function renderSetup() {
    const asset = selectedAsset();
    const entries = scenario?.failures ?? [];
    const parameter = FAILURE_MODES[mode]?.parameter ?? null;
    const extra = entries.filter(entry => entry.assetId !== asset?.assetId);
    body.innerHTML = `
      <div class="sim-tabs" role="tablist">
        <button type="button" role="tab" aria-selected="true">Set up scenario</button>
        <button type="button" role="tab" aria-selected="false" data-impact ${result ? '' : 'disabled'}>See impact</button>
      </div>
      <section class="sim-view">
        <h3 class="sim-label">Selected equipment</h3>
        ${asset ? `
          <p class="sim-asset-name">${escape(asset.name)}</p>
          <p class="sim-asset-meta">
            <span class="sim-chip" data-status="${escape(asset.operationalStatus ?? 'NOT_CONNECTED')}">
              Currently ${escape(statusWord(asset.operationalStatus).toLowerCase())}</span>
            ${asset.health?.score == null ? '' : `<span>Health ${escape(asset.health.score)}%</span>`}
          </p>`
        : '<p class="sim-empty">Select a piece of equipment on the gantry to begin.</p>'}

        <h3 class="sim-label">What do you want to simulate?</h3>
        <div class="sim-choices" role="radiogroup" aria-label="Failure type">
          ${MODE_WORDS.map(item => `
            <label class="sim-choice">
              <input type="radio" name="sim-mode" value="${item.id}" ${item.id === mode ? 'checked' : ''}>
              <span>${escape(item.label)}</span>
            </label>`).join('')}
        </div>

        ${parameter ? `
          <div class="sim-slider">
            <div class="sim-slider-head">
              <span>Equipment ${escape(parameter.label.toLowerCase())}</span>
              <b data-parameter-value>${parameters[parameter.key]}${parameter.unit}</b>
            </div>
            <input type="range" data-parameter min="${parameter.min}" max="${parameter.max}" step="5"
              value="${parameters[parameter.key]}" aria-label="Equipment ${escape(parameter.label.toLowerCase())}">
          </div>` : ''}

        <h3 class="sim-label">Conditions</h3>
        <div class="sim-grid">
          <label class="sim-field"><span>Weather</span>
            <select data-weather>${WEATHER_PRESETS.map(preset => `
              <option value="${preset.id}" ${preset.id === weatherId ? 'selected' : ''}>${escape(preset.label)}</option>`).join('')}
            </select></label>
          <label class="sim-field"><span>Traffic incident</span>
            <select data-incident>
              <option value="">None</option>
              ${INCIDENT_PRESETS.map(preset => `
                <option value="${preset.id}" ${preset.id === incidentId ? 'selected' : ''}>${escape(preset.label)}</option>`).join('')}
            </select></label>
        </div>
        ${incidentId ? `<p class="sim-mode-note">${escape(incidentSummary())}</p>` : ''}

        <h3 class="sim-label">How long will this condition last?</h3>
        <div class="sim-choices sim-inline" role="radiogroup" aria-label="Duration">
          ${DURATIONS.map(item => `
            <label class="sim-choice">
              <input type="radio" name="sim-duration" value="${item.minutes}"
                ${item.minutes === durationMinutes ? 'checked' : ''}>
              <span>${escape(item.label)}</span>
            </label>`).join('')}
        </div>

        ${extra.length ? `
          <h3 class="sim-label">Also in this scenario</h3>
          <ul class="sim-extra">${extra.map(entry => {
            const record = inventory().find(item => item.assetId === entry.assetId);
            return `<li><b>${escape(record?.name ?? entry.assetId)}</b>
              <span>${escape(modeWord(entry.failureMode))}</span>
              <button type="button" class="sim-remove" data-remove="${escape(entry.assetId)}"
                aria-label="Remove ${escape(record?.name ?? entry.assetId)}">×</button></li>`;
          }).join('')}</ul>` : ''}

        ${asset && asset.operationalStatus === 'FAILED' ? `
          <p class="sim-warn">This equipment is already out of service in the baseline. Simulating a
            failure on it will not add a further outage.</p>` : ''}

        <div class="sim-actions">
          <button type="button" class="sim-primary" data-run
            ${asset || weatherId !== 'CLEAR' || incidentId ? '' : 'disabled'}>See impact →</button>
          ${entries.length || weatherId !== 'CLEAR' || incidentId ? '<button type="button" class="sim-ghost" data-reset>Reset</button>' : ''}
        </div>
        ${renderSaved()}
        ${asset && entries.some(entry => entry.assetId !== asset.assetId) ? ''
          : asset ? `<button type="button" class="sim-add" data-add>+ Add another equipment</button>` : ''}
      </section>`;
  }

  // ── the answer ────────────────────────────────────────────────────────────────────────────────
  function headline() {
    const states = result?.equipment ?? [];
    if (!states.length) return { title: 'No equipment affected', detail: '' };
    const first = states[0];
    const parameter = FAILURE_MODES[first.failureMode]?.parameter;
    const value = parameter ? first[parameter.key] : null;
    const more = states.length > 1 ? ` and ${states.length - 1} other asset${states.length > 2 ? 's' : ''}` : '';
    return {
      title: first.impact.plain,
      detail: `${first.name}${more} · simulated as `
        + `${modeWord(first.failureMode).replace(/^Equipment /, '')}`
        + `${value ? ` at ${value}${parameter.unit}` : ''} for ${durationWord(result.durationMinutes)}.`,
    };
  }

  function renderImpact() {
    const states = result?.equipment ?? [];
    const impact = result?.equipmentImpact ?? {};
    const head = headline();
    const zones = result?.tollingImpact?.affectedZones ?? [];
    const undetermined = zones.filter(zone => zone.assessment === 'UNKNOWN');
    body.innerHTML = `
      <div class="sim-tabs" role="tablist">
        <button type="button" role="tab" aria-selected="false" data-setup>Set up scenario</button>
        <button type="button" role="tab" aria-selected="true">See impact</button>
      </div>
      <section class="sim-view">
        <p class="sim-headline">${escape(head.title)}</p>
        <p class="sim-headline-detail">${escape(head.detail)}</p>

        <h3 class="sim-label">Equipment affected</h3>
        <ul class="sim-affected">
          ${states.map((state, index) => `
            <li data-asset="${escape(state.assetId)}" data-current="${index === focusIndex}">
              <span class="sim-marker" data-tone="${band(state)}">${index + 1}</span>
              <span class="sim-affected-text">
                <b>${escape(state.name)}</b>
                <span>${escape(statusWord(state.baselineStatus))} → ${escape(CONDITION_WORDS[band(state)])}
                  ${state.change === 'NO_CHANGE' ? ' · no additional effect' : ''}</span>
              </span>
              <button type="button" class="sim-ghost sim-small" data-pick="${escape(state.assetId)}">View</button>
            </li>`).join('')}
        </ul>
        ${states.length > 1 ? `
          <div class="sim-step-nav">
            <button type="button" data-focus-prev aria-label="Previous affected asset">‹</button>
            <span>${focusIndex >= 0 ? escape(`${focusIndex + 1} of ${states.length}`) : 'Step through affected equipment'}</span>
            <button type="button" data-focus-next aria-label="Next affected asset">›</button>
          </div>` : ''}

        ${impact.indirectFailureCount
          ? `<p class="sim-note">${impact.indirectFailureCount} further asset(s) are affected through a
             verified dependency.</p>`
          : ''}

        <h3 class="sim-label">Tolling capability</h3>
        <p class="sim-body-text">${undetermined.length
          ? 'The effect on toll collection cannot yet be quantified because equipment coverage rules '
            + 'have not been verified for this gantry.'
          : zones.length
            ? zones.map(zone => `${escape(zone.zoneId)}: ${escape(ZONE_WORDS[zone.assessment] ?? zone.assessment)}`).join('; ')
            : 'No tolling zone contains the affected equipment.'}</p>

        ${renderTraffic(result?.revenueImpact)}
        ${renderFinancial(result?.revenueImpact)}
        ${renderComparison()}
        ${renderMitigations()}

        <button type="button" class="sim-disclose" data-technical aria-expanded="${showTechnical}">
          Technical details</button>
        ${showTechnical ? `
          <div class="sim-technical">
            <table class="sim-table"><tbody>
              <tr><th>Scenario</th><td>${escape(result.scenarioId)} · ${result.durationMinutes} min
                · assessment over the duration, not a playback</td></tr>
              ${states.map(state => `
                <tr><th>${escape(state.assetId)}</th><td>
                  baseline ${escape(state.baselineStatus)} · mode ${escape(state.failureMode)}
                  · effective ${escape(state.simulatedStatus)} · ${escape(state.change)}<br>
                  <span>${escape(state.impact.statement)}</span></td></tr>`).join('')}
              ${zones.map(zone => `<tr><th>${escape(zone.zoneId)}</th><td>${escape(zone.assessment)} —
                ${escape(zone.reason)}</td></tr>`).join('')}
              <tr><th>Counts</th><td>${impact.directFailureCount} failed · ${impact.directImpairedCount} impaired
                · ${impact.incrementalFailureCount} newly failed · ${impact.noAdditionalImpactCount} unchanged
                · ${impact.indirectFailureCount} indirect</td></tr>
              <tr><th>Not calculated</th><td>Revenue impact and traffic impact are not calculated in this phase.</td></tr>
            </tbody></table>
            <ul class="sim-limits">${(result.limitations ?? []).map(line => `<li>${escape(line)}</li>`).join('')}</ul>
          </div>` : ''}

        ${renderSaved()}

        <div class="sim-actions">
          <button type="button" class="sim-primary" data-setup>Change scenario</button>
          <button type="button" class="sim-ghost" data-reset>Reset</button>
        </div>
      </section>`;
  }

  const usd = value => `${value < 0 ? '−' : ''}$${Math.abs(Number(value) || 0)
    .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const count = value => Math.round(Number(value) || 0).toLocaleString('en-US');

  /** What the incident did to the vehicles, with deferral kept apart from loss. */
  function renderTraffic(money) {
    const traffic = money?.traffic;
    if (!traffic || !money?.incident) return '';
    return `
      <h3 class="sim-label">Traffic</h3>
      <p class="sim-body-text">
        ${count(traffic.crossings)} of ${count(traffic.plannedCrossings)} expected crossings passed the
        gantry during the assessment.
        ${traffic.deferredCrossings > 0.5 ? `${count(traffic.deferredCrossings)} are still queued when it
          ends — ${usd(traffic.deferredRevenueUSD)} deferred, not lost.` : ''}
        ${traffic.divertedCrossings > 0.5 ? `${count(traffic.divertedCrossings)} are assumed to divert away
          (${usd(traffic.divertedRevenueUSD)}).` : ''}
        ${traffic.lostCrossings > 0.5 ? `${count(traffic.lostCrossings)} do not cross at all
          (${usd(traffic.lostRevenueUSD)}).` : ''}
        ${traffic.unresolvedCrossings > 0.5 ? `${count(traffic.unresolvedCrossings)} are unclassified: the
          incident has no demand-handling policy.` : ''}
      </p>`;
  }

  /** The cases side by side, and whether the combination is worse than its parts. */
  function renderComparison() {
    if (!comparison?.cases?.length) return '';
    const rows = comparison.cases.map(item => `
      <tr><th>${escape(item.label)}</th>
        <td>${escape(usd(item.money?.delta?.netContributionUSD ?? 0))}</td>
        <td>${escape(count(item.money?.delta?.unrecovered ?? 0))}</td></tr>`).join('');
    return `
      <h3 class="sim-label">Compared with the parts</h3>
      <table class="sim-table sim-figures">
        <thead><tr><th>Case</th><th>Net change</th><th>Unrecovered</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${comparison.interaction ? `<p class="sim-note">Interaction:
        ${escape(usd(comparison.interaction.netContributionUSD))}. ${escape(comparison.interaction.reading)}</p>` : ''}`;
  }

  /** Measures to try, and what trying them would be worth under the stated assumption. */
  function renderMitigations() {
    if (!result?.valid) return '';
    const available = MITIGATIONS.filter(measure => measure.id !== 'SHORTEN_INCIDENT' || scenario?.trafficIncident)
      .filter(measure => measure.id !== 'REDUCE_DIVERSION' || scenario?.trafficIncident)
      .filter(measure => measure.id !== 'RESTORE_EQUIPMENT' || scenario?.failures?.length);
    if (!available.length) return '';
    return `
      <button type="button" class="sim-disclose" data-mitigations aria-expanded="${showMitigations}">
        What would help?</button>
      ${showMitigations ? `
        <div class="sim-assumptions">
          ${available.map(measure => `
            <label class="sim-choice">
              <input type="checkbox" data-mitigation="${measure.id}" ${mitigationIds.has(measure.id) ? 'checked' : ''}>
              <span>${escape(measure.label)}<br><em>${escape(measure.assumedEffect)}</em></span>
            </label>`).join('')}
          ${mitigated ? `
            <p class="sim-body-text"><b>${escape(usd(mitigated.outcome.netImprovementUSD))}</b> better than the
              unmitigated scenario; ${escape(usd(mitigated.outcome.remainingNetImpactUSD))} of impact remains.</p>
            <p class="sim-note">${escape(mitigated.outcome.assumptions.join(' '))}
              ${escape(mitigated.outcome.caveat)}</p>` : ''}
        </div>` : ''}`;
  }

  /** Saving a question so it can be asked again later, or compared with another. */
  function renderSaved() {
    return `
      <button type="button" class="sim-disclose" data-saved aria-expanded="${showSaved}">
        Saved scenarios (${saved.length})</button>
      ${showSaved ? `
        <div class="sim-assumptions">
          ${scenario ? '<button type="button" class="sim-ghost sim-small" data-save>Save this scenario</button>' : ''}
          ${saved.length ? `<ul class="sim-extra">${saved.map(entry => `
            <li><b>${escape(entry.name)}</b>
              <span>${escape(new Date(entry.savedAt).toLocaleString('en-US'))}</span>
              <button type="button" class="sim-ghost sim-small" data-load="${escape(entry.id)}">Load</button>
              <button type="button" class="sim-ghost sim-small" data-duplicate="${escape(entry.id)}">Copy</button>
              <button type="button" class="sim-remove" data-delete="${escape(entry.id)}"
                aria-label="Delete ${escape(entry.name)}">×</button></li>`).join('')}</ul>`
            : '<p class="sim-note">Nothing saved yet.</p>'}
          ${loadWarnings.length ? `<p class="sim-errors">${loadWarnings.map(escape).join('<br>')}</p>` : ''}
        </div>` : ''}`;
  }

  /**
   * The money, under the equipment.
   *
   * Four figures an operator can act on, then the baseline-versus-scenario table, then the
   * sentence explaining the move — and the synthetic label on all of it, because none of this is
   * I-595 revenue.
   */
  function renderFinancial(money) {
    if (!money || money.status === 'NOT_CALCULATED') return '';
    if (money.status === 'NOT_ASSESSED') {
      return `<h3 class="sim-label">Estimated financial impact</h3>
        <p class="sim-body-text">Not assessed. ${escape((money.missingAssumptions ?? []).join(' '))}</p>
        ${assumptionsBlock()}`;
    }
    const rows = [
      ['Expected crossings', money.baseline.transactions.crossings, money.scenario.transactions.crossings, count],
      ['Transponder transactions', money.baseline.transactions.rfidSuccess, money.scenario.transactions.rfidSuccess, count],
      ['Sent to video tolling', money.baseline.transactions.videoAttempts, money.scenario.transactions.videoAttempts, count],
      ['Recovered on video', money.baseline.transactions.videoRecovered, money.scenario.transactions.videoRecovered, count],
      ['Unrecovered transactions', money.baseline.transactions.unrecovered, money.scenario.transactions.unrecovered, count],
      ['Collected revenue', money.baseline.money.collectedRevenueUSD, money.scenario.money.collectedRevenueUSD, usd],
      ['Processing costs', money.baseline.money.processingCostUSD, money.scenario.money.processingCostUSD, usd],
      ['Net tolling contribution', money.baseline.money.netContributionUSD, money.scenario.money.netContributionUSD, usd],
    ];
    const headline = [
      { label: 'Expected transactions', value: count(money.scenario.transactions.crossings) },
      { label: 'Needing video fallback', value: count(money.scenario.transactions.videoAttempts) },
      { label: 'Unrecovered revenue', value: usd(money.scenario.money.unrecoveredRevenueUSD), tone: 'warn' },
      { label: 'Net change vs baseline', value: usd(money.delta.netContributionUSD),
        tone: money.delta.netContributionUSD < 0 ? 'bad' : 'none' },
    ];
    return `
      <h3 class="sim-label">Estimated financial impact</h3>
      <p class="sim-synthetic">Synthetic financial estimate — not actual I-595 toll revenue.</p>
      <div class="sim-money">${headline.map(item => `
        <div class="sim-money-cell" data-tone="${item.tone ?? 'none'}">
          <b>${escape(item.value)}</b><span>${escape(item.label)}</span></div>`).join('')}</div>
      <p class="sim-body-text">${(money.explanation ?? []).map(escape).join(' ')}</p>
      <table class="sim-table sim-figures">
        <thead><tr><th>Over ${money.durationMinutes} minutes</th><th>Baseline</th><th>What-if</th></tr></thead>
        <tbody>${rows.map(([label, before, after, format]) => `
          <tr><th>${escape(label)}</th><td>${escape(format(before))}</td><td>${escape(format(after))}</td></tr>`).join('')}
        </tbody>
      </table>
      ${money.status === 'PARTIALLY_ASSESSED' ? `
        <p class="sim-note">${money.notAssessedZoneIds.length} tolling zone(s) could not be assessed and are
          excluded, covering about ${count(money.excludedCrossings)} crossings.
          ${escape((money.missingAssumptions ?? []).join(' '))}</p>` : ''}
      ${assumptionsBlock()}`;
  }

  /** The assumptions, editable, and resettable. Collapsed: the primary workflow stays simple. */
  function assumptionsBlock() {
    const check = validateBaseline(assumptions);
    return `
      <button type="button" class="sim-disclose" data-assumptions aria-expanded="${showAssumptions}">
        Advanced assumptions</button>
      ${showAssumptions ? `
        <div class="sim-assumptions">
          ${ASSUMPTION_FIELDS.map(field => `
            <label class="sim-assumption">
              <span>${escape(field.label)}${field.kind === 'money' ? ' (USD)' : field.kind === 'share' ? ' (0–1)' : ''}</span>
              <input type="number" data-assumption="${escape(field.path)}" step="${field.step}"
                min="${field.min}" max="${field.max}" value="${readPath(assumptions, field.path)}">
            </label>`).join('')}
          ${check.valid ? '' : `<p class="sim-errors">${check.errors.map(error => escape(error.message)).join('<br>')}</p>`}
          <p class="sim-note">Demand is toll-eligible crossings at this gantry, split equally across the
            ${tollingZones().length} synthetic tolling zones. Video processing is charged per attempt.</p>
          <button type="button" class="sim-ghost sim-small" data-assumptions-reset>Reset to demo defaults</button>
        </div>` : ''}`;
  }

  function render() {
    if (panel.hidden) return;
    if (view === 'impact' && result?.valid) renderImpact(); else renderSetup();
  }

  // ── actions ───────────────────────────────────────────────────────────────────────────────────
  function addSelected({ keepExisting = true } = {}) {
    const asset = selectedAsset();
    if (!asset) return false;
    ensureScenario();
    invalidateResult();
    const parameter = FAILURE_MODES[mode]?.parameter;
    if (!keepExisting) {
      for (const entry of [...scenario.failures]) scenario = removeFailure(scenario, entry.assetId);
    }
    scenario = withDetails(addFailure(scenario, {
      assetId: asset.assetId,
      failureMode: mode,
      ...(parameter ? { [parameter.key]: parameters[parameter.key] } : {}),
    }), { durationMinutes });
    return true;
  }

  const conditionsNow = () => ({
    weather: weatherId && weatherId !== 'CLEAR'
      ? { ...normaliseWeather(weatherId), startOffsetMinutes: 0, durationMinutes }
      : null,
    trafficIncident: incidentId
      ? normaliseIncident({ type: incidentId, startOffsetMinutes: 0 })
      : null,
  });

  const incidentSummary = () => {
    const incident = conditionsNow().trafficIncident;
    if (!incident) return '';
    return `${incident.label}: ${incident.throughputReductionPercent}% less throughput for `
      + `${incident.durationMinutes} minutes. Held-back vehicles queue; `
      + `${Math.round((incident.demandHandling.divertedShare ?? 0) * 100)}% are assumed to divert.`;
  };

  function run() {
    const asset = selectedAsset();
    const conditions = conditionsNow();
    // A condition on its own is a scenario too: "suppose it rained" needs no equipment failure.
    if (!asset && !conditions.weather && !conditions.trafficIncident) return;
    ensureScenario();
    // The subject is what is selected now, plus whatever was pinned on purpose. Everything else is
    // dropped, so a scenario never grows by accident.
    for (const entry of [...scenario.failures]) {
      if (entry.assetId !== asset?.assetId && !pinned.has(entry.assetId)) {
        scenario = removeFailure(scenario, entry.assetId);
      }
    }
    if (asset) addSelected(); else scenario = withDetails(scenario, { durationMinutes });
    scenario = withConditions(scenario, conditions);
    focusIndex = -1;
    mitigated = null;
    result = runScenario(scenario, {
      inventory: inventory(), ranAt: Date.now(),
      // Phase 2: the synthetic money model. The equipment answer is computed exactly as before and
      // the financial estimate is derived from it.
      tolling: { baseline: assumptions, zones: tollingZones() },
    });
    scenario = { ...scenario, status: result.valid ? 'COMPLETED' : 'DRAFT' };
    // The same question asked one condition at a time, so the combination can be read against
    // its parts. Only worth running when there is more than one condition to separate.
    comparison = result.valid && scenario.failures.length && (scenario.weather || scenario.trafficIncident)
      ? compareScenario(scenario, { inventory: inventory(), zones: tollingZones(), baseline: assumptions })
      : null;
    onScenario(result.valid ? result : null, scenario);
    view = result.valid ? 'impact' : 'setup';
    render();
  }

  /** Re-run the same question with the chosen measures applied, and compare the two answers. */
  function runMitigated() {
    if (!result?.valid || !mitigationIds.size) { mitigated = null; render(); return; }
    const applied = [...mitigationIds].map(id => ({ id }));
    const changed = applyMitigations({ scenario, baseline: assumptions, applied });
    const after = runScenario(changed.scenario, {
      inventory: inventory(), ranAt: Date.now(),
      tolling: { baseline: changed.baseline, zones: tollingZones() },
    });
    mitigated = after.valid
      ? { outcome: mitigationOutcome({ original: result.revenueImpact, mitigated: after.revenueImpact, applied, notes: changed.notes }), result: after }
      : null;
    render();
  }

  function reset() {
    sequence = nextSequence(scenario?.scenarioId);
    scenario = null;
    result = null;
    comparison = null;
    mitigated = null;
    mitigationIds = new Set();
    loadWarnings = [];
    pinned = new Set();
    focusIndex = -1;
    view = 'setup';
    onScenario(null, null);
    render();
  }

  function focusAffected(direction, { close = true } = {}) {
    const states = result?.equipment ?? [];
    if (!states.length) return;
    focusIndex = (focusIndex + direction + states.length) % states.length;
    render();
    onFocusAsset?.(states[focusIndex].assetId, { close });
  }

  panel.addEventListener('change', event => {
    const target = event.target;
    if (target.matches('[data-weather]')) { weatherId = target.value; invalidateResult(); render(); return; }
    if (target.matches('[data-incident]')) { incidentId = target.value; invalidateResult(); render(); return; }
    if (target.matches('[data-mitigation]')) {
      if (target.checked) mitigationIds.add(target.dataset.mitigation);
      else mitigationIds.delete(target.dataset.mitigation);
      runMitigated();
      return;
    }
    if (target.name === 'sim-mode') { mode = target.value; invalidateResult(); render(); return; }
    if (target.name === 'sim-duration') {
      durationMinutes = Number(target.value);
      if (scenario) scenario = withDetails(scenario, { durationMinutes });
      invalidateResult();
      render();
    }
  });
  panel.addEventListener('change', event => {
    const field = event.target.closest('[data-assumption]');
    if (!field) return;
    assumptions = withAssumption(assumptions, field.dataset.assumption, Number(field.value));
    // A changed assumption makes the figures on screen stale: they are put away and the scenario
    // has to be run again rather than being quietly re-labelled.
    invalidateResult();
    view = 'setup';
    render();
  });
  panel.addEventListener('input', event => {
    if (!event.target.matches('[data-parameter]')) return;
    const parameter = FAILURE_MODES[mode]?.parameter;
    if (!parameter) return;
    parameters = { ...parameters, [parameter.key]: Number(event.target.value) };
    const label = panel.querySelector('[data-parameter-value]');
    if (label) label.textContent = `${parameters[parameter.key]}${parameter.unit}`;
    invalidateResult();
  });
  panel.addEventListener('click', event => {
    const remove = event.target.closest('[data-remove]');
    if (remove) {
      invalidateResult();
      pinned.delete(remove.dataset.remove);
      scenario = removeFailure(scenario, remove.dataset.remove);
      render();
      return;
    }
    const pick = event.target.closest('[data-pick]');
    if (pick) {
      const states = result?.equipment ?? [];
      focusIndex = Math.max(0, states.findIndex(state => state.assetId === pick.dataset.pick));
      render();
      onFocusAsset?.(pick.dataset.pick, { close: true });
      return;
    }
    if (event.target.closest('[data-focus-next]')) { focusAffected(1); return; }
    if (event.target.closest('[data-focus-prev]')) { focusAffected(-1); return; }
    if (event.target.closest('[data-add]')) {
      // Pinned: an explicitly added asset stays in the scenario when the selection moves on.
      const asset = selectedAsset();
      if (addSelected() && asset) pinned.add(asset.assetId);
      render();
      return;
    }
    if (event.target.closest('[data-run]')) { run(); return; }
    if (event.target.closest('[data-reset]')) { reset(); return; }
    if (event.target.closest('[data-setup]')) { view = 'setup'; render(); return; }
    if (event.target.closest('[data-impact]')) { if (result?.valid) { view = 'impact'; render(); } return; }
    if (event.target.closest('[data-technical]')) { showTechnical = !showTechnical; render(); return; }
    if (event.target.closest('[data-assumptions-reset]')) {
      assumptions = DEMO_BASELINE;
      invalidateResult();
      view = 'setup';
      render();
      return;
    }
    if (event.target.closest('[data-assumptions]')) { showAssumptions = !showAssumptions; render(); return; }
    if (event.target.closest('[data-mitigations]')) { showMitigations = !showMitigations; render(); return; }
    if (event.target.closest('[data-saved]')) { showSaved = !showSaved; saved = listScenarios(); render(); return; }
    if (event.target.closest('[data-save]')) {
      saveScenario({ name: scenario?.name, scenario, assumptions });
      saved = listScenarios();
      render();
      return;
    }
    const load = event.target.closest('[data-load]');
    if (load) {
      const entry = loadScenario(load.dataset.load, { inventory: inventory() });
      if (entry) {
        scenario = entry.scenario;
        assumptions = entry.assumptions ?? assumptions;
        weatherId = entry.scenario.weather?.type ?? 'CLEAR';
        incidentId = entry.scenario.trafficIncident?.type ?? '';
        durationMinutes = entry.scenario.durationMinutes;
        // A saved scenario is a question, not an answer: it is re-run rather than replayed.
        loadWarnings = [...entry.warnings];
        result = null;
        comparison = null;
        mitigated = null;
        view = 'setup';
        onScenario(null, scenario);
      }
      render();
      return;
    }
    const duplicate = event.target.closest('[data-duplicate]');
    if (duplicate) { duplicateSaved(duplicate.dataset.duplicate); return; }
    const discard = event.target.closest('[data-delete]');
    if (discard) { deleteScenario(discard.dataset.delete); saved = listScenarios(); render(); return; }
    if (event.target.closest('.sim-close')) api.close();
  });

  function duplicateSaved(id) {
    const entry = saved.find(item => item.id === id);
    if (!entry) return;
    saveScenario({ name: `${entry.name} copy`, scenario: entry.scenario, assumptions: entry.assumptions });
    saved = listScenarios();
    render();
  }

  const api = {
    root: panel,
    /** Opened from a KPI card, or from the selected asset's own "Simulate failure". */
    open({ view: initial = 'setup' } = {}) {
      view = result?.valid && initial === 'impact' ? 'impact' : 'setup';
      panel.hidden = false;
      render();
      onOpenChange(true);
    },
    close() {
      panel.hidden = true;
      // Closing takes the scenario off the scene with it: what is drawn is the baseline again.
      onScenario(null, scenario);
      onOpenChange(false);
    },
    toggle() { if (panel.hidden) api.open(); else api.close(); },
    get isOpen() { return !panel.hidden; },
    get view() { return view; },
    /** The explorer's selection changed, or the inventory did. */
    refresh() { if (!panel.hidden && view === 'setup') render(); },
    get scenario() { return scenario; },
    get result() { return result; },
    get assumptions() { return assumptions; },
    get comparison() { return comparison; },
    get mitigated() { return mitigated; },
    /** Diagnostics and the Cesium layer: the conditions as the panel currently has them. */
    get conditions() { return conditionsNow(); },
    focusAffected,
    reset,
    destroy() { drag.destroy(); panel.remove(); },
  };
  return api;
}
