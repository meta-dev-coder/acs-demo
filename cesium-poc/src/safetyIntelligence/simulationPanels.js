/**
 * The Simulation Lab's markup, as pure functions of a simulation result.
 *
 * Nothing here calculates. Every number comes from `simulationService.js`, so what the screen shows
 * and what Ask the Twin quotes are the same figures from the same run.
 *
 * The screen's job is to make the model arguable: each panel shows the number beside the assumption
 * that produced it, and the data-quality block says what the register actually recorded versus what
 * had to be assumed before any of this could be simulated at all.
 */
import { escape } from './safetyPanels.js';
import { PROVENANCE } from './simulation/incidentBaseline.js';
import { SCENARIO_PRESETS } from './simulation/scenarioPresets.js';
import { OBJECTIVES } from './simulation/scenarioOptimizer.js';
import { SIMULATION_BADGE } from './simulation/patrolOptions.js';
import { quickWins, settingChanges } from './simulation/criticalPath.js';

const money = value => (value == null ? '—' : `$${Math.round(value).toLocaleString('en-US')}`);
const minutes = value => (value == null ? '—' : `${Math.round(value)} min`);
const number = value => (value == null ? '—' : Number(value).toLocaleString('en-US',
  { maximumFractionDigits: 1 }));

const PROVENANCE_LABELS = Object.freeze({
  [PROVENANCE.OBSERVED]: 'Observed',
  [PROVENANCE.DERIVED]: 'Derived',
  [PROVENANCE.ASSUMED]: 'Assumed',
  [PROVENANCE.UNAVAILABLE]: 'Unavailable',
});

/* ============================================================================================
   The incident being simulated, and how much of it is real
   ============================================================================================ */

export function baselineBlock(baseline, provenance, calibration = null) {
  if (!baseline) {
    return `<p class="si-empty">Choose an incident record — from the map, the priority queue or the
      records list — to simulate a response to it.</p>`;
  }
  const observed = baseline.observed;
  const fact = (label, value) => (value
    ? `<span class="lab-fact"><em>${escape(label)}</em>${escape(value)}</span>` : '');
  return `
  <div class="sim-baseline">
    <h4 class="lab-incident-title">${escape(observed.type.value)}</h4>
    <div class="lab-facts">
      ${fact('Severity', observed.severity.value)}
      ${fact('When', `${baseline.fact.when.dayKey} ${String(baseline.fact.when.hour).padStart(2, '0')}:00`)}
      ${fact('Where', observed.segment.value ?? 'Location unknown')}
      ${fact('Carriageway', observed.carriageway.value === 'UNKNOWN'
        ? 'Not verifiable' : observed.carriageway.value)}
      ${fact('Lane closure', observed.laneClosure.value
        ? `Yes${observed.laneClosureHours.value != null
          ? ` · ${observed.laneClosureHours.value} h recorded` : ''}` : 'No')}
      ${fact('Weather on the record', observed.weather.value ?? 'Not recorded')}
      ${fact('Traffic on the record', observed.trafficConditions.value ?? 'Not recorded')}
      ${fact('Police report', observed.policeReport.value ?? 'None on this record')}
      ${fact('Demand modelled', baseline.traffic.demandVph.value
        ? `${number(baseline.traffic.demandVph.value)} veh/h · ${baseline.traffic.lanesPerDirection.value} lanes · v/c ${baseline.traffic.baselineVolumeToCapacity.value}`
        : 'No AADT published for this stretch')}
    </div>
    <p class="si-warn">${escape(baseline.modeNote)}</p>
    ${calibration ? calibrationBlock(calibration) : ''}
    ${provenance ? dataQuality(provenance, baseline) : ''}
  </div>`;
}

/**
 * The recorded closure beside the reconstructed one.
 *
 * Shown as two numbers that are NOT the same measurement, with the reasons, rather than as an
 * error to be closed.
 */
export function calibrationBlock(calibration) {
  if (!calibration || calibration.recordedMinutes == null) {
    return calibration?.reason ? `<p class="si-note">${escape(calibration.reason)}</p>` : '';
  }
  return `
  <details class="si-method sim-calibration">
    <summary>Recorded closure ${minutes(calibration.recordedMinutes)} · modelled reopening
      ${minutes(calibration.reconstructedMinutes)} · ${calibration.differenceMinutes > 0 ? '+' : ''}${calibration.differenceMinutes} min
      (${calibration.differencePercent}%)</summary>
    <dl class="si-detail">
      <dt>Recorded</dt><dd>${minutes(calibration.recordedMinutes)} — ${escape(calibration.recordedBasis)}</dd>
      <dt>Modelled, all lanes open</dt><dd>${minutes(calibration.reconstructedMinutes)} — ${escape(calibration.reconstructedBasis)}</dd>
      <dt>Modelled, first lane back</dt><dd>${minutes(calibration.reconstructedToPartialMinutes)}</dd>
    </dl>
    <h5>Why these are not the same measurement</h5>
    <ul class="si-facts">${calibration.whyNotComparable.map(reason => `<li>${escape(reason)}</li>`).join('')}</ul>
    <h5>What calibration would need</h5>
    <ul class="si-gaps">${calibration.wouldNeed.map(item => `<li><span>${escape(item)}</span></li>`).join('')}</ul>
    <p class="si-warn">${escape(calibration.note)}</p>
  </details>`;
}

/** Where every input came from — the first thing to read and the easiest thing to omit. */
export function dataQuality(provenance, baseline) {
  const counts = provenance.counts;
  return `
  <details class="si-method sim-quality">
    <summary>Data quality — ${counts.OBSERVED} observed, ${counts.DERIVED} derived,
      ${counts.ASSUMED} assumed, ${counts.UNAVAILABLE} unavailable</summary>
    <ul class="sim-provenance">${provenance.rows.map(row => `
      <li class="sim-p-${escape(row.provenance)}">
        <span class="sim-p-tag">${escape(PROVENANCE_LABELS[row.provenance])}</span>
        <span class="sim-p-label">${escape(row.label)}</span>
        ${row.note ? `<span class="sim-p-note">${escape(row.note)}</span>` : ''}
      </li>`).join('')}</ul>
    <h5>Not in the register at all</h5>
    <ul class="si-gaps">${baseline.unavailable.map(gap => `
      <li><strong>${escape(gap.field)}</strong><span>${escape(gap.reason)}</span></li>`).join('')}</ul>
  </details>`;
}

/* ============================================================================================
   Configuration
   ============================================================================================ */

const FIELDS = Object.freeze([
  { group: 'Detection and dispatch', rows: [
    ['detectionMinutes', 'Detection'], ['verificationMinutes', 'Verification'],
    ['dispatchMinutes', 'Dispatch'], ['warningActivationMinutes', 'Upstream warning active'],
  ] },
  { group: 'Resources', rows: [
    ['rangerTravelMinutes', 'Road Ranger travel'], ['towTravelMinutes', 'Tow travel'],
    ['towDispatchOffsetMinutes', 'Tow dispatch offset'],
    ['rangers', 'Road Rangers', 'units'], ['towTrucks', 'Tow trucks', 'units'],
  ] },
  { group: 'Clearance', rows: [
    ['sceneProtectionMinutes', 'Scene protection'], ['vehicleRemovalMinutes', 'Vehicle removal'],
    ['debrisClearanceMinutes', 'Debris clearance'],
    ['partialReopenAfterProtectionMinutes', 'Partial reopening after protection'],
  ] },
]);

/**
 * The response inputs, grouped, for the Response Analysis tab.
 *
 * Values come from `inputs` — the workspace's own copy — rather than from the run, so a number
 * typed on one tab is still there after a visit to another. The form is rebuilt on every render;
 * reading the DOM would have lost anything not currently on screen.
 */
export function responseInputsPanel(run, inputs = {}) {
  const settings = { ...(run?.inputs.response ?? {}), ...inputs };
  return `
  <div class="sim-config">
    ${FIELDS.map(group => `
      <fieldset class="sim-group">
        <legend>${escape(group.group)}</legend>
        ${group.rows.map(([key, label, unit = 'min']) => `
          <label class="sim-field">${escape(label)}
            <span><input type="number" data-sim-input="${key}" value="${settings[key] ?? ''}" />
              <em>${escape(unit)}</em></span>
          </label>`).join('')}
      </fieldset>`).join('')}
  </div>`;
}

/** The traffic inputs, for the Traffic Impact tab. */
export function trafficInputsPanel(run, inputs = {}) {
  const value = (key, fallback) => inputs[key] ?? run?.inputs.traffic?.[key] ?? fallback;
  return `
  <div class="sim-config">
    <fieldset class="sim-group">
      <legend>Traffic assumptions</legend>
      <label class="sim-field">Lanes per direction
        <span><input type="number" data-sim-traffic="lanesPerDirection"
          value="${value('lanesPerDirection', run?.inputs.traffic?.lanes ?? 4)}" /><em>lanes</em></span></label>
      <label class="sim-field">Lanes blocked
        <span><input type="number" data-sim-traffic="blockedLanes"
          value="${value('blockedLanes', 2)}" /><em>lanes</em></span></label>
      <label class="sim-field">Demand
        <span><input type="number" data-sim-traffic="demandVph"
          value="${value('demandVph', '')}" /><em>veh/h</em></span></label>
    </fieldset>
  </div>`;
}

export function configPanel(run, { presetId = 'standard', objective = 'BALANCED' } = {}) {
  const settings = run?.inputs.response ?? {};
  return `
  <div class="sim-config">
    <label class="sim-field sim-field-wide">Scenario
      <select data-sim="preset">${SCENARIO_PRESETS.map(preset => `
        <option value="${preset.id}"${preset.id === presetId ? ' selected' : ''}>${escape(preset.label)}</option>`).join('')}
      </select>
    </label>
    ${FIELDS.map(group => `
      <fieldset class="sim-group">
        <legend>${escape(group.group)}</legend>
        ${group.rows.map(([key, label, unit = 'min']) => `
          <label class="sim-field">${escape(label)}
            <span><input type="number" data-sim-input="${key}" value="${settings[key] ?? ''}" />
              <em>${escape(unit)}</em></span>
          </label>`).join('')}
      </fieldset>`).join('')}
    <fieldset class="sim-group">
      <legend>Traffic</legend>
      <label class="sim-field">Lanes per direction
        <span><input type="number" data-sim-traffic="lanesPerDirection"
          value="${run?.inputs.traffic.lanes ?? 4}" /><em>lanes</em></span></label>
      <label class="sim-field">Lanes blocked
        <span><input type="number" data-sim-traffic="blockedLanes"
          value="${run?.inputs.traffic.blockedLanes ?? 2}" /><em>lanes</em></span></label>
      <label class="sim-field">Demand
        <span><input type="number" data-sim-traffic="demandVph"
          value="${run?.inputs.traffic.demandVph ?? ''}" /><em>veh/h</em></span></label>
    </fieldset>
    <label class="sim-field sim-field-wide">Optimise for
      <select data-sim="objective">${Object.values(OBJECTIVES).map(entry => `
        <option value="${entry.id}"${entry.id === objective ? ' selected' : ''}>${escape(entry.label)}</option>`).join('')}
      </select>
    </label>
    <div class="sim-actions">
      <button class="si-action" type="button" data-sim="run">Run simulation</button>
      <button class="si-action si-action-quiet" type="button" data-sim="optimise">Run optimisation</button>
      <button class="si-action si-action-quiet" type="button" data-sim="reset">Reset to baseline</button>
    </div>
  </div>`;
}

/* ============================================================================================
   Results
   ============================================================================================ */

/** The response, stage by stage, as a bar per stage. */
export function timelineChart(run) {
  if (!run) return '';
  const total = Math.max(run.timeline.incidentClearance, 1);
  return `
  <h4>Response timeline</h4>
  <ul class="sim-timeline">${run.timeline.stages.map(stage => `
    <li${stage.parallel ? ' class="is-parallel"' : ''}>
      <span class="sim-stage-label">${escape(stage.label)}</span>
      <span class="sim-stage-bar"><i style="left:${((stage.at / total) * 100).toFixed(1)}%"></i></span>
      <span class="sim-stage-at">${minutes(stage.at)}</span>
    </li>`).join('')}</ul>
  <p class="si-note">${escape(run.timeline.clearanceNote)}</p>
  ${run.timeline.constraintsApplied.length ? `<p class="si-warn">Constraints applied:
    ${run.timeline.constraintsApplied.map(escape).join(' ')}</p>` : ''}`;
}

/** The queue over time. A bar per five-minute bucket. */
export function queueChart(run) {
  if (!run?.queue.buckets.length) return '';
  const max = Math.max(...run.queue.buckets.map(row => row.queued), 1);
  const width = Math.max(run.queue.buckets.length * 6, 120);
  return `
  <h4>Queue over time</h4>
  <svg class="si-chart sim-queue" viewBox="0 0 ${width} 110" preserveAspectRatio="none" role="img"
    aria-label="Vehicles queued, five minutes at a time">
    ${run.queue.buckets.map((row, index) => {
      const height = Math.max(1, (row.queued / max) * 92);
      // Read by the hover layer. A native SVG <title> showed once and then stopped, because the
      // panel is rebuilt on every render and the element the browser was tracking no longer exists.
      const tip = `${row.fromMinute}–${row.toMinute} min · ${Math.round(row.queued)} queued · `
        + `${row.blockedLanes} lane${row.blockedLanes === 1 ? '' : 's'} blocked · `
        + `${Math.round(row.crossed)} crossed · ${Math.round(row.capacity)} capacity`;
      return `<rect x="${index * 6}" y="${(92 - height).toFixed(1)}" width="5" height="${height.toFixed(1)}"
        fill="${row.blockedLanes > 0 ? '#E5484D' : '#38BDF8'}" opacity="0.85"
        data-tip="${escape(tip)}"></rect>`;
    }).join('')}
  </svg>
  <p class="si-chart-note">Peak ${number(run.queue.maxQueueVehicles)} vehicles at
    ${minutes(run.queue.maxQueueAtMinute)} (${number(run.queue.maxQueueMetres)} m per lane).
    Red while a lane is blocked.</p>
  <ul class="si-facts">
    <li><strong>${number(run.queue.vehicleHoursOfDelay)}</strong> vehicle-hours of delay</li>
    <li>Queue cleared ${run.queue.queueDissipationMinutes == null ? 'not within the horizon'
      : `${minutes(run.queue.queueDissipationMinutes)} after the last lane reopened`}</li>
    <li>${number(run.queue.diverted)} diverted · ${number(run.queue.lost)} abandoned the trip ·
      ${number(run.queue.deferred)} still queued at the horizon</li>
  </ul>
  <p class="si-note">${escape(run.queue.delayBasis)}
    Conservation check: demand = crossed + queued + diverted + abandoned
    (${run.queue.conserved ? 'holds' : 'FAILS — do not use these numbers'}).</p>
  ${run.queue.truncated ? '<p class="si-warn">The horizon ended with vehicles still queued, so the '
    + 'delay above is a floor rather than a total.</p>' : ''}`;
}

/** The three economic accounts, kept apart. */
export function economicsBlock(run) {
  if (!run) return '';
  const { delay, response, toll } = run.economics;
  return `
  <h4>Economic impact</h4>
  <table class="sim-table">
    <tbody>
      <tr><th>Road-user delay</th><td>${money(delay.totalUSD)}</td>
        <td class="sim-basis">${escape(delay.basis)}</td></tr>
      <tr><th>Agency response</th><td>${money(response.totalUSD)}</td>
        <td class="sim-basis">${response.rangerHours} ranger-hours, ${response.towHours} tow-hours.</td></tr>
      <tr><th>Toll deferred</th><td>${money(toll.deferredUSD)}</td>
        <td class="sim-basis">Paid later by the same vehicle. Not a loss.</td></tr>
      <tr><th>Toll unrecovered</th><td>${money(toll.unrecoveredUSD)}</td>
        <td class="sim-basis">The vehicle left the facility.</td></tr>
      <tr class="sim-total"><th>Total modelled cost</th><td>${money(run.economics.totalModelledCostUSD)}</td>
        <td class="sim-basis">${escape(run.economics.totalNote)}</td></tr>
    </tbody>
  </table>
  <p class="si-warn">${escape(toll.separation)} ${escape(toll.basis)}</p>`;
}

/** Secondary exposure — the quantity first, the index second, and never a probability. */
export function exposureBlock(run) {
  if (!run) return '';
  const exposure = run.exposure;
  return `
  <h4>Secondary-incident exposure</h4>
  <p class="si-lede"><strong>${number(exposure.vehicleHoursExposed)}</strong> vehicle-hours spent
    stationary in a queue on a live carriageway.</p>
  <ul class="si-facts">
    <li>${minutes(exposure.elevatedMinutes)} with a queue standing</li>
    <li>Peak ${number(exposure.maxQueueVehicles)} vehicles</li>
    <li>Warning ${exposure.warningLeadMinutes == null ? 'lead not applicable'
      : exposure.warningLeadMinutes >= 0 ? `active ${minutes(exposure.warningLeadMinutes)} before the queue formed`
        : `active ${minutes(Math.abs(exposure.warningLeadMinutes))} AFTER the queue formed`}</li>
  </ul>
  <p class="si-note">Ordinal index ${exposure.index} (${escape(exposure.band)}).
    ${escape(exposure.indexNote)}</p>`;
}

/* ============================================================================================
   Comparison and recommendation
   ============================================================================================ */

export function comparisonTable(runs, { activeId = null } = {}) {
  if (!runs.length) return '<p class="si-empty">Run a scenario to compare it with others.</p>';
  const best = Math.min(...runs.map(run => run.headline.totalModelledCostUSD));
  return `
  <h4>Scenario comparison</h4>
  <table class="sim-table sim-compare">
    <thead><tr><th>Scenario</th><th>Lanes&nbsp;open</th><th>Queue&nbsp;gone</th><th>Veh-hours</th>
      <th>Delay&nbsp;cost</th><th>Response&nbsp;cost</th><th>Total</th></tr></thead>
    <tbody>${runs.map(run => `
      <tr class="${run.id === activeId ? 'is-on' : ''}${run.headline.totalModelledCostUSD === best ? ' is-best' : ''}"
        data-sim-select="${escape(run.id)}">
        <th>${escape(run.label)}</th>
        <td>${minutes(run.headline.roadwayClearanceMinutes)}</td>
        <td>${run.headline.queueDissipationMinutes == null ? '—'
          : minutes(run.headline.queueDissipationMinutes)}</td>
        <td>${number(run.headline.vehicleHoursOfDelay)}</td>
        <td>${money(run.headline.delayCostUSD)}</td>
        <td>${money(run.headline.responseCostUSD)}</td>
        <td>${money(run.headline.totalModelledCostUSD)}</td>
      </tr>`).join('')}</tbody>
  </table>
  <p class="si-note">Lanes open is roadway clearance from the moment of the incident. Queue gone is
    measured from the last lane reopening. Total is road-user delay plus agency response plus
    unrecovered toll revenue.</p>`;
}

/** What the optimiser chose, and what it refused. */
export function recommendationBlock(optimisation, comparison, baselineResponse = null) {
  if (!optimisation?.best) return '';
  const run = optimisation.best.result;
  const settings = optimisation.best.settings;
  const changes = settingChanges(baselineResponse, settings);
  return `
  <div class="sim-recommend">
    <h4>Recommended — ${escape(optimisation.objectiveLabel.toLowerCase())}</h4>
    <ul class="si-facts">
      <li>Lanes open at <strong>${minutes(run.headline.roadwayClearanceMinutes)}</strong>,
        queue gone ${minutes(run.headline.queueDissipationMinutes)} later</li>
      <li><strong>${number(run.headline.vehicleHoursOfDelay)}</strong> vehicle-hours of delay</li>
      <li>Total modelled cost <strong>${money(run.headline.totalModelledCostUSD)}</strong></li>
    </ul>
    ${comparison ? `<ul class="si-facts">
      <li>Against the standard response: ${comparison.delay.percentChange ?? '—'}% delay,
        ${money(comparison.economics.netBenefitUSD)} net benefit</li>
      <li>Road users ${money(comparison.economics.byBearer.ROAD_USERS)} ·
        agency ${money(comparison.economics.byBearer.OPERATING_AGENCY)} ·
        toll operator ${money(comparison.economics.byBearer.TOLL_OPERATOR)}</li>
    </ul>` : ''}
    <h5>What the search changed</h5>
    ${baselineResponse ? (changes.length ? `
    <table class="sim-table sim-changes">
      <thead><tr><th>Input</th><th>Standard</th><th>Optimised</th><th>Change</th></tr></thead>
      <tbody>${changes.map(change => `
        <tr>
          <th>${escape(change.label)}</th>
          <td>${change.from} ${escape(change.unit)}</td>
          <td><strong>${change.to} ${escape(change.unit)}</strong></td>
          <td class="${change.tightened ? 'is-better' : ''}">${change.delta > 0 ? '+' : ''}${change.delta} ${escape(change.unit)}</td>
        </tr>`).join('')}</tbody>
    </table>
    <p class="si-note">${changes.length} of the searched inputs differ from the standard response.
      Every other input was left where it was — the search did not find a reason to move it.</p>`
    : `<p class="si-note">The search returned the standard response unchanged: no combination in
       the grid beat it on the ranked measure.</p>`) : ''}
    <h5>What it would take</h5>
    <ul class="si-facts">
      <li>${settings.rangers} patrol unit(s) arriving in ${minutes(settings.rangerTravelMinutes)}</li>
      <li>${settings.towTrucks} tow unit(s) arriving in ${minutes(settings.towTravelMinutes)}
        ${settings.towDispatchOffsetMinutes < 0 ? `(rolled ${Math.abs(settings.towDispatchOffsetMinutes)} min before verification)` : ''}</li>
      <li>Detection in ${minutes(settings.detectionMinutes)}, warning active at
        ${minutes(settings.warningActivationMinutes)}</li>
      <li>Partial reopening ${minutes(settings.partialReopenAfterProtectionMinutes)} after the scene is protected</li>
    </ul>
    <p class="si-note">${optimisation.evaluated} feasible strategies evaluated,
      ${optimisation.rejected} excluded as unavailable. ${escape(optimisation.method)}</p>
    ${optimisation.rejectedExamples.length ? `<details class="si-method">
      <summary>Why strategies were excluded</summary>
      <ul class="si-gaps">${optimisation.rejectedExamples.map(entry => `
        <li><span>${entry.reasons.map(escape).join(' ')}</span></li>`).join('')}</ul>
    </details>` : ''}
    ${optimisation.pareto.length > 1 ? `<p class="si-note">${optimisation.pareto.length} strategies are
      not beaten on every measure at once — the trade-offs worth looking at before committing.</p>` : ''}
    <p class="si-warn">A modelled comparison between sets of assumptions, not a forecast. No
      reduction in accidents is predicted and no crash-modification factor is applied.</p>
  </div>`;
}

/* ============================================================================================
   Critical path, sensitivity, and "explain this result"
   ============================================================================================ */

/**
 * What is controlling the reopening time.
 *
 * The gates are listed with their slack, so a reader can see not only which one won but by how
 * much — a gate two minutes behind the binding one is a different proposition from one that is
 * half an hour clear.
 */
export function criticalPathBlock(path) {
  if (!path) return '';
  return `
  <h4>Critical path — what is controlling reopening</h4>
  <p class="si-lede">${escape(path.explanation)}</p>
  <table class="sim-table sim-gates">
    <thead><tr><th>Gate on vehicle removal</th><th>Ready at</th><th>Slack</th></tr></thead>
    <tbody>${path.gates.map(gate => `
      <tr class="${gate.binding ? 'is-binding' : ''}">
        <th>${escape(gate.label)}${gate.binding ? ' — binding' : ''}</th>
        <td>${minutes(gate.at)}</td>
        <td>${gate.binding ? '—' : `${minutes(gate.slackMinutes)} early`}</td>
      </tr>`).join('')}</tbody>
  </table>
  ${path.constraints.length ? `<p class="si-warn">Constraints that cannot be optimised away:
    ${path.constraints.map(escape).join(' ')}</p>` : ''}
  <p class="si-note">Earliest reopening while the binding constraint stands:
    ${minutes(path.earliestReopening)}. Everything with slack can be improved without changing that.</p>`;
}

/**
 * Which inputs move the answer and which only cost money.
 *
 * Sorted by how much each moves the reopening time, so the levers worth arguing about are at the
 * top and the ones that merely spend are grouped at the bottom with that said plainly.
 */
export function sensitivityBlock(sensitivity) {
  if (!sensitivity) return '';
  const row = entry => `
    <tr class="sim-verdict-${escape(entry.verdict)}">
      <th>${escape(entry.label)}</th>
      <td>${entry.baselineValue} ${escape(entry.unit)}</td>
      <td>${entry.movesReopening ? `up to ${minutes(entry.reopeningRangeMinutes)}` : 'none'}</td>
      <td>${entry.movesReopening ? minutes(entry.bestReopeningMinutes) : '—'}</td>
      <td>${entry.costRangeUSD ? money(entry.costRangeUSD) : '—'}</td>
    </tr>`;
  const movers = sensitivity.movers.length;
  const wasted = sensitivity.inert.filter(entry => entry.verdict === 'COSTS_WITHOUT_REOPENING').length;
  return `
  <details class="sim-sensitivity-block">
    <summary>Sensitivity — ${movers} input${movers === 1 ? '' : 's'} move the reopening time${
      wasted ? `, ${wasted} only cost money` : ''}</summary>
  <table class="sim-table sim-sensitivity">
    <thead><tr><th>Input</th><th>Now</th><th>Effect on<br>reopening</th><th>Best<br>reachable</th>
      <th>Cost<br>swing</th></tr></thead>
    <tbody>${sensitivity.rows.map(row).join('')}</tbody>
  </table>
  ${sensitivity.inert.some(entry => entry.verdict === 'COSTS_WITHOUT_REOPENING') ? `
    <p class="si-warn">${sensitivity.inert.filter(entry => entry.verdict === 'COSTS_WITHOUT_REOPENING')
      .map(entry => escape(entry.label)).join(' and ')} change what the response costs without moving
      the reopening time at all, because they are not on the critical path for this incident.</p>` : ''}
  <p class="si-note">${escape(sensitivity.method)}</p>
  </details>`;
}

/** How much the answer rests on inputs nobody measured. */
export function assumptionBlock(assumptions) {
  if (!assumptions) return '';
  return `
  <h4>How much rests on the assumptions</h4>
  <p class="si-lede">Of the inputs nobody measured, <strong>${escape(assumptions.mostInfluential ?? '—')}</strong>
    moves the total cost most.</p>
  <table class="sim-table">
    <thead><tr><th>Assumption</th><th>Range tested</th><th>Cost swing</th></tr></thead>
    <tbody>${assumptions.groups.map(group => `
      <tr><th>${escape(group.label)}</th>
        <td>${group.points.map(point => escape(point.label)).join(', ')}</td>
        <td>${money(group.costSpreadUSD)}</td></tr>`).join('')}</tbody>
  </table>
  <p class="si-warn">${escape(assumptions.caveat)}</p>`;
}

/**
 * "Explain this result" — every sentence read off the model's own intermediate values.
 *
 * Nothing here is generated prose about the numbers; each line is assembled from a value the
 * engine produced, which is what makes it safe to put beside the figure it explains.
 */
export function explainBlock(run, path) {
  if (!run || !path) return '';
  const queue = run.queue;
  const recovery = queue.queueClearedAtMinute;
  return `
  <details class="si-method sim-explain">
    <summary>Explain these numbers</summary>
    <dl class="si-detail">
      <dt>Why do the lanes reopen at ${minutes(run.headline.roadwayClearanceMinutes)}?</dt>
      <dd>${escape(path.explanation)}</dd>

      <dt>Why is queue recovery later than reopening?</dt>
      <dd>${recovery == null
        ? 'The queue had not cleared when the model stopped, so the delay above is a floor.'
        : `The last lane reopened at ${minutes(run.timeline.fullReopen)}, but
           ${number(queue.maxQueueVehicles)} vehicles were already waiting. At full capacity the
           road clears them by ${minutes(recovery)} — ${minutes(queue.queueDissipationMinutes)}
           after reopening. Traffic is normal ${minutes(recovery)} after the incident, not
           ${minutes(run.headline.roadwayClearanceMinutes)}.`}</dd>

      <dt>Where do the ${number(queue.vehicleHoursOfDelay)} vehicle-hours come from?</dt>
      <dd>The queue standing through each five-minute bucket, summed over
        ${minutes(queue.queueMinutes)} with a queue. Demand ${number(Math.round(queue.demand))}
        = ${number(Math.round(queue.crossed))} crossed + ${number(Math.round(queue.diverted))}
        diverted + ${number(Math.round(queue.lost))} abandoned + ${number(Math.round(queue.deferred))}
        still queued${queue.conserved ? '' : ' — CONSERVATION FAILS, do not use these numbers'}.</dd>

      <dt>What makes up ${money(run.economics.totalModelledCostUSD)}?</dt>
      <dd>${money(run.economics.delay.totalUSD)} road-user delay +
        ${money(run.economics.response.totalUSD)} agency response +
        ${money(run.economics.toll.unrecoveredUSD)} toll that left the facility.
        ${money(run.economics.toll.deferredUSD)} of deferred toll is excluded: it is collected later.</dd>

      <dt>What does the exposure figure mean?</dt>
      <dd>${number(run.exposure.vehicleHoursExposed)} vehicle-hours spent stationary in a queue on a
        live carriageway${run.exposure.warningLeadMinutes != null && run.exposure.warningLeadMinutes < 0
          ? `, with the queue forming ${minutes(Math.abs(run.exposure.warningLeadMinutes))} before the
             upstream warning was active` : ''}.
        ${escape(run.exposure.indexNote)}</dd>
    </dl>
  </details>`;
}

/* ============================================================================================
   The Lab's own sub-tabs
   --------------------------------------------------------------------------------------------
   Everything below is layout. Not one number is calculated here: each panel is handed a run that
   `simulationService` produced and arranges what it already contains. Switching sub-tabs changes
   which arrangement is shown and nothing else — the run, its inputs and the optimiser's results
   are untouched.
   ============================================================================================ */

/**
 * Four views, not five.
 *
 * Optimization was its own tab, which meant reading the recommended strategy on one page and the
 * timeline it changes on another. The search, the comparison and the recommendation now sit under
 * Response Analysis, below the timeline and the sensitivity table they follow from.
 */
export const LAB_TABS = Object.freeze([
  { id: 'overview', label: 'Overview' },
  { id: 'traffic', label: 'Traffic Impact' },
  { id: 'response', label: 'Response Analysis' },
  { id: 'patrols', label: 'Patrols' },
  { id: 'economics', label: 'Economics' },
]);

/**
 * The strip that stays put.
 *
 * Which incident, which scenario, one button to run it, and the four numbers a reader checks
 * before anything else. It is sticky so those four never scroll away from the panel explaining
 * them — the complaint that started this restructuring was having to scroll back up to see what a
 * chart was about.
 */
/**
 * The Lab has no header of its own.
 *
 * It used to carry the incident's facts above the tab strip, which put the same seven fields on
 * screen twice — once in the sticky bar and again at the top of Overview — and cost a third of the
 * panel's height on every tab. Overview owns them now.
 */
export const labHeader = () => '';

/** Compact tab strip. Roving focus and arrow keys are wired by the workspace. */
export const labTabs = active => `
  <nav class="lab-tabs" role="tablist" aria-label="Simulation views">
    ${LAB_TABS.map(tab => `<button role="tab" type="button" data-lab-tab="${tab.id}"
      id="lab-tab-${tab.id}" aria-controls="lab-panel"
      aria-selected="${tab.id === active}" tabindex="${tab.id === active ? '0' : '-1'}"
      >${escape(tab.label)}</button>`).join('')}
  </nav>`;

/* --- Overview ------------------------------------------------------------------------------ */

/**
 * What a reader needs in the first ten seconds: what is being simulated, what the model found, how
 * it compares with the record, and what to do next.
 *
 * The findings are read off the critical path and the sensitivity sweep rather than restated, so
 * this page cannot drift from the pages that show the working.
 */
export function overviewTab({ baseline, provenance, calibration, run, path, sweep, comparison,
  optimisation }) {
  const movers = sweep?.movers.slice(0, 3) ?? [];
  const wasted = sweep?.inert.filter(row => row.verdict === 'COSTS_WITHOUT_REOPENING') ?? [];
  return `
  ${baselineBlock(baseline, provenance, calibration)}
  ${run?.saturation?.warning ? `<p class="si-warn">${escape(run.saturation.warning)}</p>` : ''}
  ${run ? `
    <h4>What the model found</h4>
    <ul class="si-facts">
      <li>${escape(path?.explanation ?? '')}</li>
      ${movers.length ? `<li>The inputs that move it: ${movers
        .map(row => `${escape(row.label.toLowerCase())} (up to ${minutes(row.reopeningRangeMinutes)})`)
        .join(', ')}.</li>` : ''}
      ${wasted.length ? `<li>${wasted.map(row => escape(row.label.toLowerCase())).join(' and ')}
        ${wasted.length === 1 ? 'changes' : 'change'} what the response costs without moving the
        reopening time at all.</li>` : ''}
      <li>Queue recovery is ${run.headline.queueDissipationMinutes == null ? 'beyond the horizon'
        : `${minutes(run.headline.queueDissipationMinutes)} after the last lane reopened`}, so traffic
        is normal later than the lanes are open.</li>
    </ul>
    ${comparison ? `
      <h4>Against the standard response</h4>
      <ul class="si-facts">
        <li>Lanes open ${comparison.timeline.roadwayClearanceChange > 0 ? '+' : ''}${comparison.timeline.roadwayClearanceChange} min</li>
        <li>Delay ${comparison.delay.percentChange}% (${number(comparison.delay.vehicleHoursChange)} vehicle-hours)</li>
        <li>Net benefit ${money(comparison.economics.netBenefitUSD)} —
          road users ${money(comparison.economics.byBearer.ROAD_USERS)},
          agency ${money(comparison.economics.byBearer.OPERATING_AGENCY)},
          toll operator ${money(comparison.economics.byBearer.TOLL_OPERATOR)}</li>
      </ul>
      <p class="si-warn">${escape(comparison.economics.note)}</p>` : ''}
    <h4>Recommended action</h4>
    ${optimisation?.best
      ? `<p class="si-lede">Best feasible strategy for ${escape(optimisation.objectiveLabel.toLowerCase())}:
          lanes open at ${minutes(optimisation.best.result.headline.roadwayClearanceMinutes)},
          ${money(optimisation.best.result.headline.totalModelledCostUSD)} total modelled cost.</p>
        <p class="si-note">The full strategy, what it would take and what was excluded are under
          “Finding a better response” on the Response Analysis tab.</p>`
      : `<p class="si-empty">No optimisation has been run for this incident yet. “Finding a better
          response”, on the Response Analysis tab, searches the feasible strategies and reports the
          best one.</p>`}`
    : '<p class="si-empty">Run a scenario to see what the model makes of it.</p>'}`;
}

/* --- Traffic Impact ------------------------------------------------------------------------ */

/**
 * The traffic the response is modelled against — the assumptions, not the results.
 *
 * Measured: the demand and capacity table is IDENTICAL across every scenario, because it is made
 * of inputs; the queue and the exposure CHANGE with every run, because they are what the response
 * did to that traffic. Mixing the two on one page meant half of it moved when a scenario was run
 * and half of it did not, with nothing saying which. The results moved to Response Analysis beside
 * the response that produced them; what stays here is what they rest on.
 */
export function trafficTab({ run, trafficInputs }) {
  if (!run) return '<p class="si-empty">Run a scenario to model the traffic impact.</p>';
  const traffic = run.inputs.traffic;
  const clean = traffic.lanes * traffic.capacityPerLaneVph;
  return `
  <h4>Demand and capacity</h4>
  <table class="sim-table">
    <tbody>
      <tr><th>Demand modelled</th><td>${number(traffic.demandVph)} veh/h</td>
        <td class="sim-basis">AADT × peak-hour share × directional split. None of the three is
          measured on this corridor.</td></tr>
      <tr><th>Capacity, nothing blocked</th><td>${number(clean)} veh/h</td>
        <td class="sim-basis">${traffic.lanes} lanes × ${number(traffic.capacityPerLaneVph)} veh/h/lane.</td></tr>
      <tr><th>Capacity while blocked</th>
        <td>${number(Math.round((traffic.lanes - traffic.blockedLanes) * traffic.capacityPerLaneVph
          * (1 - traffic.incidentCapacityPenalty)))} veh/h</td>
        <td class="sim-basis">${traffic.blockedLanes} of ${traffic.lanes} lanes blocked, less a
          ${Math.round(traffic.incidentCapacityPenalty * 100)}% penalty for rubbernecking and merging.</td></tr>
      <tr><th>Volume to capacity, before the incident</th>
        <td>${run.saturation?.volumeToCapacity ?? '—'}</td>
        <td class="sim-basis">Over 1.0 the queue below is the assumptions’ doing, not the incident’s.</td></tr>
    </tbody>
  </table>
  ${run.saturation?.warning ? `<p class="si-warn">${escape(run.saturation.warning)}</p>` : ''}
  ${trafficInputs}
  <p class="si-note">These are the inputs the response is modelled against, and they do not change
    when a scenario is run. What the response did to this traffic — the queue over time and the
    exposure it created — is on the Response Analysis tab, beside the timeline that produced it.</p>
  <details class="si-method">
    <summary>Segment-level capacity and ramps — not yet modelled</summary>
    <p class="si-note">The corridor is modelled as one uniform stretch at the blocked location: one
      lane count, one capacity, one demand. Ramp volumes, interchange weaving and per-segment
      capacity differences are not represented, so a queue that would in reality back through a
      junction is shown as a single growing line. This panel is where that analysis will go.</p>
  </details>`;
}

/* --- Response Analysis --------------------------------------------------------------------- */

/**
 * Before anything is run: the five single changes that would open the lanes soonest.
 *
 * It sits above the scenario control deliberately. The question a reader arrives with is "what
 * should we change?", and making them run a scenario first to find out which lever is worth
 * running is the wrong order.
 */
export function quickWinsBlock(sweep) {
  const wins = quickWins(sweep, { limit: 5 });
  if (!wins.length) {
    return `<div class="sim-quick"><h4>Where the time is</h4>
      <p class="si-empty">No single input, moved alone through its tested range, opens the lanes
      any sooner than the current settings do.</p></div>`;
  }
  const value = win => `${win.fromValue} → ${win.toValue} ${escape(win.unit)}`;
  return `
  <div class="sim-quick">
    <h4>Top ${wins.length} ways to open the lanes sooner</h4>
    <p class="si-note">Ranked before any scenario is run, from the baseline response. Each row moves
      one input alone and re-runs the engine; reopening is now
      ${minutes(sweep.baseline.reopening)}.</p>
    <ol class="sim-quick-list">${wins.map((win, index) => `
      <li>
        <span class="sim-quick-rank">${index + 1}</span>
        <span class="sim-quick-main">
          <strong>${escape(win.label)}</strong>
          <em>${value(win)}</em>
        </span>
        <span class="sim-quick-gain">−${win.savedMinutes} min
          <small>opens at ${minutes(win.reopeningMinutes)}</small></span>
        <span class="sim-quick-cost">${win.costDeltaUSD === 0 ? 'no cost change'
          : `${win.costDeltaUSD > 0 ? '+' : '−'}${money(Math.abs(win.costDeltaUSD))}`}</span>
      </li>`).join('')}</ol>
    <p class="si-note">One at a time, so these do not add up — two of them may relieve the same
      gate. Running the optimisation below searches them jointly.</p>
  </div>`;
}

export function responseTab({ run, path, sweep, responseInputs, presetId = 'standard',
  runs = [], activeId = null, optimisation = null, comparison = null,
  baselineResponse = null }) {
  // The scenario and the button that runs it belong with the inputs they act on, rather than in a
  // header above five tabs where only this one uses them.
  // Its own markup rather than the shared `.sim-field` label: that class is a grid carrying
  // inherited label styling, which left eleven pixels of space under the select, so the control
  // and the button could not be made to line up by styling alone.
  const controls = `
  <div class="lab-run">
    <div class="lab-run-field">
      <span class="lab-run-label" id="lab-scenario-label">Scenario</span>
      <select data-sim="preset" aria-labelledby="lab-scenario-label">${SCENARIO_PRESETS.map(preset => `
        <option value="${preset.id}"${preset.id === presetId ? ' selected' : ''}>${escape(preset.label)}</option>`).join('')}
      </select>
    </div>
    <button class="si-action" type="button" data-sim="run">Run simulation</button>
  </div>`;
  if (!run) return `${quickWinsBlock(sweep)}${controls}
    <p class="si-empty">Run a scenario to see the response timeline.</p>`;
  return `
  ${quickWinsBlock(sweep)}
  ${controls}
  ${responseInputs}
  ${timelineChart(run)}
  ${criticalPathBlock(path)}
  ${queueChart(run)}
  ${exposureBlock(run)}
  ${explainBlock(run, path)}
  ${sensitivityBlock(sweep)}
  ${optimizationSection({ runs, activeId, optimisation, comparison, baselineResponse })}`;
}

/* --- Economics ----------------------------------------------------------------------------- */

/**
 * The three accounts, plus the arithmetic that proves the total is the sum of what is shown.
 *
 * The reconciliation line exists because a rounding bug once put a $727 total beside components
 * adding to $728, which is exactly the kind of thing that makes a reader stop trusting a model.
 */
export function economicsTab({ run, assumptions }) {
  if (!run) return '<p class="si-empty">Run a scenario to see its economic impact.</p>';
  const economics = run.economics;
  const parts = economics.delay.totalUSD + economics.response.totalUSD + economics.toll.unrecoveredUSD;
  const reconciles = parts === economics.totalModelledCostUSD;
  return `
  ${economicsBlock(run)}
  <h4>Reconciliation</h4>
  <p class="si-note">
    ${money(economics.delay.totalUSD)} delay + ${money(economics.response.totalUSD)} response +
    ${money(economics.toll.unrecoveredUSD)} unrecovered toll =
    ${money(parts)}${reconciles ? ', which is the total shown above.'
      : ` — but the total shown is ${money(economics.totalModelledCostUSD)}. These must agree; do not
         use these figures.`}
    Deferred toll of ${money(economics.toll.deferredUSD)} is excluded by design.
  </p>
  ${assumptions ? assumptionBlock(assumptions) : ''}`;
}

/* --- Optimization -------------------------------------------------------------------------- */

/**
 * The search, the comparison and the recommendation — now a section of Response Analysis rather
 * than a tab of its own, so the strategy is read beside the timeline it would change.
 */
export function optimizationSection({ runs, activeId, optimisation, comparison,
  baselineResponse = null }) {
  return `
  <h4>Finding a better response</h4>
  <div class="lab-optimise">
    <div class="sim-actions">
      <button class="si-action" type="button" data-sim="optimise">Run optimisation</button>
      <button class="si-action si-action-quiet" type="button" data-sim="reset">Reset to baseline</button>
    </div>
    <p class="si-note">Optimised for the balanced outcome. The choice of objective was removed
      because in this model it barely is one: secondary exposure IS vehicle-hours queued, and both
      follow clearance — so fastest-clearance, least-delay and least-exposure always return the same
      strategy. Lowest-cost differs from them only by leaving a tow further away, worth tens of
      dollars. An objective that changes the answer needs a measure the others do not already
      contain.</p>
  </div>
  ${comparisonTable(runs, { activeId })}
  ${optimisation
    ? recommendationBlock(optimisation, comparison, baselineResponse)
    : `<p class="si-empty">Run the optimisation to search the feasible strategies. Infeasible ones
       are excluded before ranking and the reasons are reported.</p>`}`;
}

/* --- Patrols -------------------------------------------------------------------------------- */

/**
 * Which patrol responds, and what the choice is worth.
 *
 * The fleet is the TMC's simulated one, so the two screens cannot disagree about where the patrols
 * are. Everything here is labelled simulated, every time — a patrol drawn on a map looks like a
 * fact, and on this instance there is no Road Ranger data of any kind.
 */
/**
 * One patrol's own facts — the same fields the TMC screen's patrol card reports, plus what this
 * screen can add: the distance to this incident and, once a scenario is loaded, what sending this
 * unit instead of the current one does to reopening and cost.
 *
 * Opened by clicking the vehicle on the map or its row in either table.
 */
export function patrolDetail(patrol, { row = null, recommended = false, comparison = null } = {}) {
  if (!patrol) return '';
  const time = Number.isFinite(patrol.simulationTimestamp) && patrol.simulationTimestamp > 0
    ? new Date(patrol.simulationTimestamp).toLocaleString('en-US',
      { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'Not stated';
  const facts = [
    ['Status', patrol.statusLabel],
    ['Service area', patrol.serviceArea],
    ['Assigned route', patrol.assignedRoute ?? 'Not stated'],
    ['Simulation time', time],
    ['Distance to incident', `${(patrol.distanceMetres / 1000).toFixed(1)} km straight line`],
    ['Travel time used', patrol.dispatchable ? `${patrol.travelMinutes} min` : 'Not dispatchable'],
    ['Assumed cruise', patrol.speedKmh ? `${patrol.speedKmh} km/h` : 'Stationary'],
    ['Source', 'Simulated — not FDOT AVL'],
  ];
  return `
  <div class="sim-patrol-card">
    <div class="sim-patrol-head">
      <h4>${escape(patrol.id)}${recommended ? '<em class="sim-pick-tag">best</em>' : ''}</h4>
      <button class="si-collapse" type="button" data-patrol="" aria-label="Close ${escape(patrol.id)}">&#10005;</button>
    </div>
    <dl class="sim-patrol-facts">${facts.map(([label, value]) => `
      <div><dt>${escape(label)}</dt><dd>${escape(String(value))}</dd></div>`).join('')}</dl>
    ${patrol.floored ? `<p class="si-note">The drive itself is ${patrol.driveMinutes} min; the model
      will not use an arrival sooner than ${patrol.travelMinutes} min, so that is what is applied.</p>` : ''}
    ${patrol.dispatchable ? '' : `<p class="si-note">${escape(patrol.ineligibleReason)}</p>`}
    ${row ? `<p class="si-lede">With this unit the lanes open at
      <strong>${minutes(row.roadwayClearanceMinutes)}</strong> and the modelled cost is
      <strong>${money(row.totalModelledCostUSD)}</strong>${
        row.costChange === 0 && row.clearanceChange === 0
          ? ' — the same as the scenario loaded now.'
          : ` — ${row.clearanceChange === 0 ? 'no change to reopening'
            : `${Math.abs(row.clearanceChange)} min ${row.clearanceChange < 0 ? 'sooner' : 'later'}`}
             and ${money(Math.abs(row.costChange))} ${row.costChange < 0 ? 'less' : 'more'}${
               comparison ? ` than ${escape(comparison.baselineLabel ?? 'the loaded scenario')}` : ''}.`}</p>`
      : '<p class="si-note">Run a scenario to see what this unit would do to reopening and cost.</p>'}
    <p class="si-warn">A simulated vehicle at a simulated position. Nothing here is a record of
      where a Road Ranger was.</p>
  </div>`;
}

export function patrolsTab({ options, comparison, selectedPatrolId = null }) {
  if (!options) {
    return '<p class="si-empty">Select an incident to see which patrols could have responded to it.</p>';
  }
  if (!options.available) {
    return `<p class="si-empty">${escape(options.reason ?? 'No patrol positions are available.')}</p>`;
  }
  const minutes_ = value => `${Math.round(value)} min`;
  const signed = (value, unit) => `${value > 0 ? '+' : ''}${value}${unit}`;
  const selected = options.patrols.find(patrol => patrol.id === selectedPatrolId) ?? null;

  return `
  <p class="si-warn"><strong>${escape(SIMULATION_BADGE)}</strong> — ${escape(options.standing)}</p>

  ${selected ? patrolDetail(selected, {
    row: comparison?.rows.find(entry => entry.patrol.id === selected.id) ?? null,
    recommended: selected.id === comparison?.best?.patrol.id,
    comparison,
  }) : ''}

  <h4>The fleet at this incident</h4>
  <p class="si-note">${escape(options.basis)}</p>
  <table class="sim-table sim-patrols">
    <thead><tr><th>Patrol</th><th>Status</th><th>Distance</th><th>Travel</th></tr></thead>
    <tbody>${options.patrols.map(patrol => `
      <tr class="${patrol.dispatchable ? '' : 'is-out'}${patrol.id === selectedPatrolId ? ' is-on' : ''}${
        patrol.id === comparison?.best?.patrol.id ? ' is-best' : ''}"
        data-patrol="${escape(patrol.id)}">
        <th>${escape(patrol.id)}${patrol.id === comparison?.best?.patrol.id
          ? '<em class="sim-pick-tag">best</em>' : ''}</th>
        <td>${escape(patrol.statusLabel)}</td>
        <td>${(patrol.distanceMetres / 1000).toFixed(1)} km</td>
        <td>${patrol.dispatchable ? `${patrol.travelMinutes} min` : '—'}</td>
      </tr>`).join('')}</tbody>
  </table>
  <p class="si-note">${options.candidates.length} of ${options.fleetSize} are available to dispatch
    in this scenario. Carriageway is not filtered: an incident's position is its damaged asset's, so
    the direction it was travelling cannot be established from the record.</p>

  ${comparison ? `
    <h4>What the choice is worth</h4>
    <p class="si-lede">${comparison.choiceMatters
      ? `Sending the nearest available patrol rather than the furthest is worth
         <strong>${minutes_(comparison.clearanceSpreadMinutes)}</strong> on the road and
         <strong>${money(comparison.costSpreadUSD)}</strong> in modelled cost.`
      : 'Every available patrol arrives before the thing that is actually holding this incident up, '
        + 'so which one responds changes nothing about when the lanes reopen. The cost differs only '
        + 'by the hours each unit spends on scene.'}</p>
    <p class="sim-recommend-line"><span class="sim-pick">Recommended</span>
      <strong>${escape(comparison.best.patrol.id)}</strong> — on scene in
      ${comparison.best.patrol.travelMinutes} min, lanes open at
      ${minutes_(comparison.best.roadwayClearanceMinutes)},
      ${money(comparison.best.totalModelledCostUSD)} total modelled cost.
      <span class="si-note">Lowest total modelled cost, then soonest reopening. Both come from
      re-running the simulation for each patrol.</span></p>
    <table class="sim-table sim-patrol-compare">
      <thead><tr><th>Patrol</th><th>Travel</th><th>Lanes&nbsp;open</th><th>Veh-hours</th>
        <th>Total&nbsp;cost</th><th>vs&nbsp;now</th></tr></thead>
      <tbody>${comparison.rows.map((row, index) => `
        <tr class="${index === 0 ? 'is-best' : ''}${row.patrol.id === selectedPatrolId ? ' is-on' : ''}"
          data-patrol="${escape(row.patrol.id)}">
          <th>${escape(row.patrol.id)}${index === 0 ? '<em class="sim-pick-tag">best</em>' : ''}</th>
          <td>${row.patrol.travelMinutes} min</td>
          <td>${minutes_(row.roadwayClearanceMinutes)}</td>
          <td>${number(row.vehicleHoursOfDelay)}</td>
          <td>${money(row.totalModelledCostUSD)}</td>
          <td class="sim-delta ${row.costChange < 0 ? 'is-better' : row.costChange > 0 ? 'is-worse' : ''}">
            ${row.costChange === 0 ? '—' : signed(Math.round(row.costChange / 100) / 10, 'k')}${
              row.clearanceChange !== 0 ? ` · ${signed(row.clearanceChange, ' min')}` : ''}</td>
        </tr>`).join('')}</tbody>
    </table>
    <p class="si-note">Measured against the scenario currently loaded
      (${minutes_(comparison.baselineClearanceMinutes)}, ${money(comparison.baselineCostUSD)}).
      ${escape(comparison.note)}</p>
    <div class="sim-actions">
      <button class="si-action" type="button" data-sim="patrol">Run with the nearest patrol</button>
    </div>
    <p class="si-warn">A comparison between simulated fleet positions, not a dispatch recommendation.
      Where a real patrol was, and how long it actually took, is not recorded anywhere in this twin.</p>`
    : '<p class="si-empty">Run a scenario first, and each patrol’s effect on it will be shown here.</p>'}`;
}
