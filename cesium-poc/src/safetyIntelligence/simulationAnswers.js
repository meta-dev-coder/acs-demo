/**
 * Ask the Twin's side of the Simulation Lab.
 *
 * The rule that matters: the assistant NEVER produces a number. Each intent here maps to a
 * deterministic call on the same `simulationService` session the Lab uses, and the reply is
 * assembled from the result that comes back. If the engine cannot answer, the reply says so rather
 * than estimating.
 *
 * The second rule is lineage. "And what if the tow were another ten minutes earlier?" must clone
 * the run under discussion and change one field — not start from defaults and silently drop
 * everything else the conversation had established.
 */

export const SIMULATION_SUGGESTIONS = Object.freeze([
  'Simulate how we could have cleared this faster',
  'What if the tow truck arrived 10 minutes earlier?',
  'How much congestion could we avoid?',
  'Which strategy gives the best balance of safety and cost?',
  'Compare the scenarios so far',
]);

/**
 * Intents, in priority order.
 *
 * The "what if" patterns are matched before the general ones: a follow-up is a modification of the
 * active run, and reading it as a fresh request would throw the conversation away.
 */
const INTENTS = Object.freeze([
  { id: 'modify', test: /what if|suppose|try|instead|another \d+|(\d+)\s*(minutes?|min)\s*(earlier|sooner|later|faster)/i },
  { id: 'optimise', test: /(best|optimal|optimis|optimiz|which strategy|balance|minimis|minimiz|cheapest|fastest way)/i },
  { id: 'compare', test: /(compare|versus|against|difference between|scenarios so far)/i },
  { id: 'congestion', test: /(congestion|delay|queue|vehicle.?hours|how much traffic)/i },
  { id: 'economics', test: /(cost|economic|revenue|toll|dollars|\$|money|benefit)/i },
  { id: 'exposure', test: /(secondary|exposure|risk of another|rear.?end)/i },
  { id: 'simulate', test: /(simulat|what could|how could we|clear(ed)? (it )?faster|reopen)/i },
]);

export const parseSimulationQuestion = question =>
  INTENTS.find(intent => intent.test.test(String(question ?? '')))?.id ?? null;

/**
 * What a follow-up actually asks to change.
 *
 * Only the levers the engine has, and only when the question names one. Anything else returns null
 * so the assistant asks rather than guessing which number to move.
 */
export function parseModification(question, current = {}) {
  const text = String(question ?? '');
  const amount = Number(/(\d+)\s*(?:minutes?|min)/i.exec(text)?.[1] ?? NaN);
  if (!Number.isFinite(amount)) return null;
  const earlier = /(earlier|sooner|faster|quicker|less)/i.test(text);
  const direction = earlier ? -1 : 1;
  const lever = /tow/i.test(text) ? 'towTravelMinutes'
    : /ranger|patrol|responder/i.test(text) ? 'rangerTravelMinutes'
      : /detect/i.test(text) ? 'detectionMinutes'
        : /warn|sign|dms/i.test(text) ? 'warningActivationMinutes'
          : /reopen|partial/i.test(text) ? 'partialReopenAfterProtectionMinutes'
            : /dispatch/i.test(text) ? 'dispatchMinutes'
              : null;
  if (!lever) return null;
  const from = current[lever];
  return Object.freeze({
    lever,
    amount,
    direction,
    value: Math.max(0, (from ?? amount) + direction * amount),
    describe: `${lever.replace(/Minutes$/, '').replace(/([A-Z])/g, ' $1').toLowerCase().trim()} `
      + `${earlier ? 'reduced' : 'increased'} by ${amount} minutes`,
  });
}

const money = value => `$${Math.round(value).toLocaleString('en-US')}`;

/**
 * Answer from the engine.
 *
 * @param {string} intent from parseSimulationQuestion()
 * @param {object} session a simulation session from createSimulationSession()
 * @param {string} question the operator's own words, for the modification parser
 */
export function answerSimulationQuestion(intent, session, question = '') {
  if (!intent) return null;
  if (!session) {
    return { answer: 'No incident is open for simulation. Select an incident record on the Safety '
      + 'Intelligence screen first, then ask again.' };
  }
  const standard = session.all.find(run => run.presetId === 'standard') ?? session.all[0];

  switch (intent) {
    case 'simulate': {
      const runs = session.runAllPresets();
      const best = [...runs].sort((a, b) =>
        a.headline.totalModelledCostUSD - b.headline.totalModelledCostUSD)[0];
      const comparison = session.compare(standard.id, best.id);
      return {
        runId: best.id,
        answer: [
          `Ran ${runs.length} response scenarios against ${session.baseline.incidentId}.`,
          ...runs.map(run => `• ${run.label}: lanes open at ${run.headline.roadwayClearanceMinutes} min, `
            + `${run.headline.vehicleHoursOfDelay} vehicle-hours of delay, `
            + `${money(run.headline.totalModelledCostUSD)} total modelled cost`),
          '',
          `Lowest modelled cost: ${best.label}, ${money(comparison?.economics.netBenefitUSD ?? 0)} `
            + `better than the standard response.`,
          session.baseline.modeNote,
        ].join('\n'),
      };
    }

    case 'modify': {
      const parent = session.active ?? standard;
      const change = parseModification(question, parent.inputs.response);
      if (!change) {
        return { answer: 'I can change detection, dispatch, Road Ranger travel, tow travel, warning '
          + 'activation or partial reopening by a stated number of minutes. Name one of those and '
          + 'how many minutes, and I will clone the current scenario with just that changed.' };
      }
      const run = session.clone(parent.id, {
        response: { [change.lever]: change.value },
        label: `${parent.label} · ${change.describe}`,
      });
      const comparison = session.compare(parent.id, run.id);
      const moved = comparison.timeline.roadwayClearanceChange !== 0;
      return {
        runId: run.id,
        answer: [
          `Cloned “${parent.label}” with ${change.describe}; everything else is unchanged.`,
          moved
            ? `Lanes open at ${run.headline.roadwayClearanceMinutes} min `
              + `(${comparison.timeline.roadwayClearanceChange > 0 ? '+' : ''}`
              + `${comparison.timeline.roadwayClearanceChange} min).`
            // A lever that is not the binding constraint changes nothing, and saying only "no
            // change" would read as a broken model rather than as the finding it is.
            : `No change to clearance: lanes still open at ${run.headline.roadwayClearanceMinutes} min. `
              + `${run.timeline.bindingConstraint.note}`,
          `Delay ${run.headline.vehicleHoursOfDelay} vehicle-hours `
            + `(${comparison.delay.percentChange}%).`,
          `Net benefit against the parent scenario: ${money(comparison.economics.netBenefitUSD)}.`,
          moved ? '' : 'To move this incident’s clearance, change what it is actually waiting on.',
        ].filter(Boolean).join('\n'),
      };
    }

    case 'congestion': {
      const run = session.active ?? standard;
      const comparison = run.id === standard.id ? null : session.compare(standard.id, run.id);
      return {
        runId: run.id,
        answer: [
          `“${run.label}”: ${run.headline.vehicleHoursOfDelay} vehicle-hours of delay, peaking at `
            + `${run.headline.maxQueueVehicles} vehicles queued, cleared `
            + `${run.headline.queueDissipationMinutes ?? '—'} minutes after the last lane reopened.`,
          comparison ? `Against the standard response that is ${comparison.delay.vehicleHoursChange} `
            + `vehicle-hours (${comparison.delay.percentChange}%).` : '',
          run.queue.delayBasis,
        ].filter(Boolean).join('\n'),
      };
    }

    case 'economics': {
      const run = session.active ?? standard;
      const economics = run.economics;
      return {
        runId: run.id,
        answer: [
          `“${run.label}” — road-user delay ${money(economics.delay.totalUSD)}, agency response `
            + `${money(economics.response.totalUSD)}, toll deferred `
            + `${money(economics.toll.deferredUSD)}, toll unrecovered `
            + `${money(economics.toll.unrecoveredUSD)}.`,
          `Total modelled cost ${money(economics.totalModelledCostUSD)}.`,
          economics.totalNote,
          economics.toll.separation,
        ].join('\n'),
      };
    }

    case 'exposure': {
      const run = session.active ?? standard;
      const exposure = run.exposure;
      return {
        runId: run.id,
        answer: [
          `“${run.label}” — ${exposure.vehicleHoursExposed} vehicle-hours stationary in a queue, `
            + `over ${exposure.elevatedMinutes} minutes with a queue standing.`,
          exposure.warningLeadMinutes != null && exposure.warningLeadMinutes < 0
            ? `The queue formed ${Math.abs(exposure.warningLeadMinutes)} minutes BEFORE the upstream `
              + 'warning was active.'
            : `Upstream warning active ${exposure.warningLeadMinutes} minutes before the queue formed.`,
          exposure.indexNote,
        ].join('\n'),
      };
    }

    case 'compare': {
      const runs = session.all;
      if (runs.length < 2) {
        return { answer: 'Only one scenario has been run so far. Ask me to simulate alternatives, or '
          + 'change something, and I will have two to compare.' };
      }
      return {
        answer: [
          `${runs.length} scenarios on ${session.baseline.incidentId}:`,
          ...runs.map(run => `• ${run.label}: ${run.headline.roadwayClearanceMinutes} min to lanes `
            + `open, ${run.headline.vehicleHoursOfDelay} vehicle-hours, `
            + `${money(run.headline.totalModelledCostUSD)}`),
          '',
          'All measured from the same baseline and the same model version '
            + `(${runs[0].modelVersion}).`,
        ].join('\n'),
      };
    }

    case 'optimise': {
      const objective = /cost|economic|money|cheap/i.test(question) ? 'ECONOMIC'
        : /fast|clear|reopen/i.test(question) ? 'CLEARANCE'
          : /delay|congestion/i.test(question) ? 'DELAY'
            : /secondary|exposure|safety/i.test(question) && !/balance/i.test(question) ? 'EXPOSURE'
              : 'BALANCED';
      const found = session.optimise({ objective });
      if (!found.best) {
        return { answer: 'No strategy in the search was feasible against the configured resources. '
          + 'Raise the available units or relax the arrival times and ask again.' };
      }
      const run = found.best.result;
      const settings = found.best.settings;
      const comparison = session.compare(standard.id, session.all.find(entry => entry.optimised)?.id
        ?? standard.id);
      return {
        runId: run.id,
        answer: [
          `Best feasible strategy for “${found.objectiveLabel.toLowerCase()}”, from `
            + `${found.evaluated} feasible strategies (${found.rejected} excluded as unavailable):`,
          `• ${settings.rangers} patrol unit(s) arriving in ${settings.rangerTravelMinutes} min`,
          `• ${settings.towTrucks} tow unit(s) arriving in ${settings.towTravelMinutes} min`
            + (settings.towDispatchOffsetMinutes < 0
              ? `, rolled ${Math.abs(settings.towDispatchOffsetMinutes)} min before verification` : ''),
          `• Detection in ${settings.detectionMinutes} min, warning at `
            + `${settings.warningActivationMinutes} min`,
          `• Partial reopening ${settings.partialReopenAfterProtectionMinutes} min after the scene is protected`,
          '',
          `Lanes open at ${run.headline.roadwayClearanceMinutes} min, `
            + `${run.headline.vehicleHoursOfDelay} vehicle-hours of delay, `
            + `${money(run.headline.totalModelledCostUSD)} total modelled cost.`,
          comparison ? `Against the standard response: ${money(comparison.economics.netBenefitUSD)} `
            + 'net benefit.' : '',
          run.timeline.constraintsApplied.length
            ? `Constraints that could not be optimised away: ${run.timeline.constraintsApplied.join(' ')}`
            : '',
          'A modelled comparison between sets of assumptions. No accident reduction is predicted.',
        ].filter(Boolean).join('\n'),
      };
    }

    default:
      return null;
  }
}
