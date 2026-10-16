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
  return `
  <div class="sim-baseline">
    <h4>Incident being simulated</h4>
    <p class="si-lede">${escape(observed.type.value)} · ${escape(observed.severity.value)} ·
      ${escape(baseline.fact.when.dayKey)} ${String(baseline.fact.when.hour).padStart(2, '0')}:00</p>
    <dl class="si-detail">
      <dt>Where</dt><dd>${escape(observed.segment.value ?? 'Unknown')}
        ${observed.carriageway.value === 'UNKNOWN' ? '<span class="si-note">carriageway not verifiable</span>' : ''}</dd>
      <dt>Lane closure</dt><dd>${observed.laneClosure.value ? 'Yes' : 'No'}${observed.laneClosureHours.value != null
        ? ` · ${observed.laneClosureHours.value} h recorded` : ''}</dd>
      <dt>Weather on the record</dt><dd>${escape(observed.weather.value ?? 'Not recorded')}</dd>
      <dt>Demand modelled</dt><dd>${baseline.traffic.demandVph.value
        ? `${number(baseline.traffic.demandVph.value)} veh/h · ${baseline.traffic.lanesPerDirection.value} lanes ·
           v/c ${baseline.traffic.baselineVolumeToCapacity.value}`
        : 'No AADT published for this stretch — set a demand assumption to simulate it.'}</dd>
    </dl>
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
    <thead><tr><th>Scenario</th><th>Lanes open</th><th>Queue gone</th><th>Veh-hours</th>
      <th>Delay cost</th><th>Response</th><th>Total</th></tr></thead>
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
export function recommendationBlock(optimisation, comparison) {
  if (!optimisation?.best) return '';
  const run = optimisation.best.result;
  const settings = optimisation.best.settings;
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
  return `
  <h4>Sensitivity — which inputs actually matter</h4>
  <table class="sim-table sim-sensitivity">
    <thead><tr><th>Input</th><th>Now</th><th>Effect on reopening</th><th>Best reachable</th>
      <th>Cost swing</th></tr></thead>
    <tbody>${sensitivity.rows.map(row).join('')}</tbody>
  </table>
  ${sensitivity.inert.some(entry => entry.verdict === 'COSTS_WITHOUT_REOPENING') ? `
    <p class="si-warn">${sensitivity.inert.filter(entry => entry.verdict === 'COSTS_WITHOUT_REOPENING')
      .map(entry => escape(entry.label)).join(' and ')} change what the response costs without moving
      the reopening time at all, because they are not on the critical path for this incident.</p>` : ''}
  <p class="si-note">${escape(sensitivity.method)}</p>`;
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
