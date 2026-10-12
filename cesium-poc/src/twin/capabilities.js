/**
 * What Ask the Twin can actually do, declared once.
 *
 * WHY THIS IS CLIENT-SIDE, which is the finding that shaped it: the analytical services the
 * assistant needs to reason with — the secondary-risk engine, upstream protection, the simulated
 * patrol provider, the dispatch and warning scenarios, the loaded maintenance classes — all run in
 * the browser. They depend on corridor geometry held in the Cesium viewer, on weather fetched per
 * selected incident, and on the assessment the screen is currently showing. The server's tool loop
 * cannot execute any of them, so a server-side registry of these names would be a registry of
 * things it could not run.
 *
 * So capabilities execute here, against the same services the screen uses. One consequence worth
 * stating plainly: an answer and the screen can never disagree, because they are the same call.
 *
 * Every capability declares its inputs, the screens it makes sense on, whether it reads live or
 * historical data, and what provenance its output carries. None of them writes anything.
 */

/** How much a result can be trusted, at the level of the finding rather than the response. */
export const PROVENANCE = Object.freeze({
  OBSERVED: 'OBSERVED',
  SIMULATED: 'SIMULATED',
  UNKNOWN: 'UNKNOWN',
  UNAVAILABLE: 'UNAVAILABLE',
  /** A response that genuinely mixes them. The parts carry their own. */
  MIXED: 'MIXED',
});

/** A uniform result, so a caller never has to know which capability produced it. */
export const ok = ({ data, evidence = [], provenance = PROVENANCE.OBSERVED, limitations = [],
  filtersApplied = {}, actions = [] } = {}) => Object.freeze({
  status: 'ok',
  data,
  evidence: Object.freeze(evidence),
  provenance,
  limitations: Object.freeze(limitations),
  filtersApplied: Object.freeze(filtersApplied),
  actions: Object.freeze(actions),
  retrievedAt: new Date().toISOString(),
});

/**
 * A capability that could not answer.
 *
 * Deliberately distinct from an empty `ok`: "there are no work orders here" and "I could not look"
 * are different answers, and collapsing them is how an assistant starts reassuring people falsely.
 */
export const unavailable = (reason, { limitations = [] } = {}) => Object.freeze({
  status: 'unavailable',
  reason,
  data: null,
  evidence: Object.freeze([]),
  provenance: PROVENANCE.UNAVAILABLE,
  limitations: Object.freeze(limitations),
  filtersApplied: Object.freeze({}),
  actions: Object.freeze([]),
  retrievedAt: new Date().toISOString(),
});

const evidenceOf = (entityType, entityId, source, timestamp = null) =>
  Object.freeze({ source, entityType, entityId: String(entityId), timestamp });

/**
 * Build the registry against the live application services.
 *
 * @param {{tmc, maintenanceRecords, assetIndex, centerline}} services
 */
export function createCapabilityRegistry({
  tmc = null, maintenanceRecords = null, assetIndex = null, centerline = [],
} = {}) {
  /** The entry for whichever incident the screen has open, or null. */
  const selectedEntry = () => {
    const id = tmc?.selectedIncidentId;
    if (!id) return null;
    return (tmc.assessment?.assessments ?? []).find(item => item.incident.id === id) ?? null;
  };
  const records = type => (typeof maintenanceRecords === 'function' ? maintenanceRecords(type) ?? [] : []);

  const DEFINITIONS = {
    // ───────────────────────────────────────────────────────────── TMC
    get_investigation_context: {
      category: 'CONTEXT',
      description: 'What the operator currently has open: screen, mode, selected incident and the moment being investigated.',
      screens: ['*'],
      requires: [],
      temporal: 'EITHER',
      handler() {
        const entry = selectedEntry();
        if (!entry) {
          return ok({
            data: { selectedIncidentId: null, mode: tmc?.temporal?.mode ?? null },
            limitations: ['No incident is selected.'],
            provenance: PROVENANCE.OBSERVED,
          });
        }
        return ok({
          data: {
            selectedIncidentId: entry.incident.id,
            mode: tmc.temporal?.mode ?? null,
            historicalDate: tmc.temporal?.date ?? null,
            section: entry.incident.sectionLabel ?? null,
            carriageway: entry.incident.carriageway ?? null,
            incidentTimestamp: tmc.upstreamProtection?.incidentTimestamp ?? null,
          },
          evidence: [evidenceOf('incident', entry.incident.id, 'DataConnect')],
        });
      },
    },

    get_incident_analysis: {
      category: 'TMC',
      description: "The selected incident's deterministic secondary-incident risk, its contributing factors and what could not be evaluated.",
      screens: ['tmc'],
      requires: ['selectedIncident'],
      temporal: 'EITHER',
      handler() {
        const entry = selectedEntry();
        if (!entry) return unavailable('No incident is selected, so there is nothing to analyse.');
        const risk = entry.risk;
        // Read from the engine, never recomputed here: the number an operator acts on must be the
        // one the screen shows.
        return ok({
          data: {
            incidentId: entry.incident.id,
            severity: entry.incident.severity ?? null,
            section: entry.incident.sectionLabel ?? null,
            carriageway: entry.incident.carriageway ?? null,
            score: risk.score,
            level: risk.level,
            levelLabel: risk.levelLabel,
            confidence: { ...risk.confidence },
            contributors: risk.contributors.map(f => ({ type: f.type, label: f.label, detail: f.detail, points: f.contribution })),
            neutral: risk.neutralFactors.map(f => ({ type: f.type, label: f.label, detail: f.detail })),
            unknown: risk.unknownFactors.map(f => ({ type: f.type, label: f.label, detail: f.detail })),
            unavailable: risk.unavailableFactors.map(f => ({ type: f.type, label: f.label, reason: f.reason })),
            weatherState: risk.weatherState,
          },
          evidence: [evidenceOf('incident', entry.incident.id, 'DataConnect',
            tmc.upstreamProtection?.incidentTimestamp ?? null)],
          provenance: PROVENANCE.OBSERVED,
          limitations: [
            'The score is a deterministic rule-based index, not a crash probability.',
            ...(risk.unknownFactors.length
              ? [`${risk.unknownFactors.length} factor(s) could not be evaluated and are not scored as zero risk.`]
              : []),
          ],
          actions: [{ type: 'SELECT_INCIDENT', incidentId: entry.incident.id, label: `Show ${entry.incident.id}` }],
        });
      },
    },

    analyze_upstream_protection: {
      category: 'TMC',
      description: 'The approach to the selected incident: whether it resolves, what traffic was observed, and which warning resources exist.',
      screens: ['tmc'],
      requires: ['selectedIncident'],
      temporal: 'EITHER',
      handler() {
        const entry = selectedEntry();
        if (!entry) return unavailable('No incident is selected.');
        const assessment = tmc.upstreamProtection;
        if (!assessment) return unavailable('The upstream assessment is not available for this incident.');
        const resolved = assessment.upstreamResolution.resolved;
        return ok({
          data: {
            incidentId: assessment.incidentId,
            resolved,
            reason: assessment.upstreamResolution.reason,
            sections: assessment.upstreamSections.map(s => s.sectionLabel ?? s.sectionId),
            traffic: { status: assessment.trafficObservationStatus, detail: assessment.traffic.detail },
            queue: { status: assessment.queueObservationStatus, detail: assessment.queue.detail },
            nearestDms: assessment.nearestDms
              ? { id: assessment.nearestDms.id, upstreamMiles: assessment.nearestDms.upstreamMiles } : null,
            nearestCamera: assessment.nearestCamera
              ? { id: assessment.nearestCamera.id, upstreamMiles: assessment.nearestCamera.upstreamMiles } : null,
            warningActivation: { status: assessment.warningActivationStatus, detail: assessment.warningActivation.detail },
            dataCoverage: { ...assessment.dataConfidence },
          },
          // Genuinely mixed: the approach and the resources are observed, the warning status is
          // unknown and the queue is unavailable. One label for all of it would be wrong.
          provenance: PROVENANCE.MIXED,
          evidence: [
            evidenceOf('incident', assessment.incidentId, 'DataConnect'),
            ...(assessment.nearestDms ? [evidenceOf('sign', assessment.nearestDms.id, 'Corridor message signs')] : []),
            ...(assessment.nearestCamera ? [evidenceOf('camera', assessment.nearestCamera.id, 'Corridor cameras')] : []),
          ],
          limitations: [
            'A sign being upstream does not establish that it displayed a warning — no activation records are published.',
            'Queue extent is not published by the connected feed.',
            ...(resolved ? [] : [`Upstream unresolved: ${assessment.upstreamResolution.reason}`]),
          ],
          actions: resolved ? [{ type: 'INSPECT_UPSTREAM', label: 'Inspect upstream' }] : [],
        });
      },
    },

    get_patrol_response_options: {
      category: 'TMC',
      description: 'The simulated Road Ranger options for the selected incident: who is eligible, who is not and why.',
      screens: ['tmc'],
      requires: ['selectedIncident'],
      temporal: 'HISTORICAL',
      handler() {
        const scenario = tmc?.patrolScenario;
        if (!scenario) {
          return unavailable('Patrol simulation runs on a historical date with an incident open.',
            { limitations: ['Patrol positions are simulated, never actual FDOT AVL.'] });
        }
        const minutes = option => Math.max(1, Math.round(option.travelSeconds / 60));
        return ok({
          data: {
            availability: { ...scenario.availability },
            eligible: scenario.eligible.map(option => ({
              patrolId: option.patrol.id, travelMinutes: minutes(option),
              routeKm: Math.round(option.route.distanceMeters / 100) / 10,
              routeConfidence: option.route.confidence,
            })),
            ineligible: scenario.options.filter(o => !o.eligible)
              .map(o => ({ patrolId: o.patrol.id, reason: o.ineligibleReason })),
            suggested: scenario.suggested?.patrol.id ?? null,
          },
          provenance: PROVENANCE.SIMULATED,
          evidence: [evidenceOf('incident', scenario.incident.id, 'DataConnect', scenario.anchorMs)],
          limitations: [
            'Patrol positions, availability and travel times are SIMULATED — not actual FDOT or ACS dispatch data.',
            'Routes follow the corridor centerline; no ramp or interchange topology is published, so every ETA is approximate.',
          ],
          actions: [{ type: 'SHOW_PATROLS', label: 'Show simulated patrols' },
            ...(scenario.suggested
              ? [{ type: 'SELECT_PATROL', patrolId: scenario.suggested.patrol.id, label: `Select ${scenario.suggested.patrol.id}` }]
              : [])],
        });
      },
    },

    compare_response_scenarios: {
      category: 'TMC',
      description: 'Deterministic comparison of an earlier versus later simulated dispatch, and of warning activation timing.',
      screens: ['tmc'],
      requires: ['selectedIncident'],
      temporal: 'HISTORICAL',
      handler() {
        const scenario = tmc?.patrolScenario;
        const warning = tmc?.warningScenario;
        if (!scenario && !warning) return unavailable('No response scenario is available for this incident.');
        const option = scenario?.suggested ?? scenario?.eligible?.[0] ?? null;
        return ok({
          data: {
            dispatch: option
              ? { patrolId: option.patrol.id, travelMinutes: Math.max(1, Math.round(option.travelSeconds / 60)) }
              : null,
            dispatchUnavailableReason: option ? null : 'No eligible simulated patrol to dispatch.',
            warning: warning?.resolved
              ? {
                scenarioA: { delayMinutes: warning.scenarioA.delayMinutes, queueMiles: warning.scenarioA.simulatedQueueMiles },
                scenarioB: { delayMinutes: warning.scenarioB.delayMinutes, queueMiles: warning.scenarioB.simulatedQueueMiles },
                earlierByMinutes: warning.earlierByMinutes,
                queueModelUnchanged: warning.queueModelUnchanged,
              }
              : null,
            warningUnavailableReason: warning?.resolved ? null : (warning?.reason ?? 'No warning scenario.'),
          },
          provenance: PROVENANCE.SIMULATED,
          limitations: [
            'Both scenarios are hypothetical: no queue observations and no DMS activation records are published.',
            'An earlier warning does NOT shorten the queue — the queue model is identical in both scenarios.',
            'Effect on actual collisions: not estimated. No crash reduction or clearance saving is claimed.',
          ],
          actions: [{ type: 'COMPARE_PATROLS', label: 'Compare dispatch scenarios' }],
        });
      },
    },

    // ───────────────────────────────────────────────────────── MAINTENANCE
    search_work_orders: {
      category: 'MAINTENANCE',
      description: 'Work orders from the loaded DataConnect class, filtered by status, asset or open state.',
      screens: ['*'],
      requires: [],
      temporal: 'EITHER',
      /** @param {{assetId?: string, openOnly?: boolean, limit?: number}} input */
      handler(input = {}) {
        const all = records('workOrder');
        if (!all.length) {
          return unavailable('The work-order class is not loaded, so none can be searched.');
        }
        const openOnly = input.openOnly !== false;
        const isOpen = record => Boolean(record?.status)
          && !/closed|completed|resolved|cancelled|cleared/i.test(record.status);
        let found = all;
        if (input.assetId) found = found.filter(r => String(r.assetId ?? '') === String(input.assetId));
        if (openOnly) found = found.filter(isOpen);
        const limit = Math.min(25, Math.max(1, Number(input.limit) || 10));
        // Due dates are not published on every record; overdue is therefore NOT derived here.
        const withDue = found.filter(r => r.dueDate).length;
        return ok({
          data: {
            total: found.length,
            shown: found.slice(0, limit).map(r => ({
              id: r.id, title: r.title ?? null, status: r.status ?? null,
              priority: r.priority ?? null, assetId: r.assetId ?? null,
            })),
          },
          filtersApplied: { assetId: input.assetId ?? null, openOnly, limit },
          evidence: found.slice(0, limit).map(r => evidenceOf('workOrder', r.id, 'DataConnect')),
          limitations: withDue === 0
            ? ['No due dates are published on these records, so overdue status cannot be determined.']
            : [],
        });
      },
    },

    get_asset_history: {
      category: 'MAINTENANCE',
      description: 'Every loaded maintenance record that names one asset: tickets, tasks, work orders and inspections.',
      screens: ['*'],
      requires: ['assetId'],
      temporal: 'EITHER',
      handler(input = {}) {
        const assetId = input.assetId ? String(input.assetId) : null;
        if (!assetId) return unavailable('No asset was given.');
        const groups = { ticket: 'tickets', task: 'tasks', workOrder: 'workOrders', inspection: 'inspections' };
        const data = {}; const evidence = []; let total = 0;
        for (const [type, key] of Object.entries(groups)) {
          const found = records(type).filter(r => String(r.assetId ?? '') === assetId);
          data[key] = found.map(r => ({ id: r.id, title: r.title ?? null, status: r.status ?? null }));
          for (const r of found) evidence.push(evidenceOf(type, r.id, 'DataConnect'));
          total += found.length;
        }
        if (!total) {
          return ok({ data: { assetId, ...data, total: 0 },
            limitations: [`No loaded maintenance record names asset ${assetId}.`] });
        }
        return ok({
          data: { assetId, ...data, total },
          evidence,
          filtersApplied: { assetId },
          limitations: [
            'Records are joined by the asset identifier the source publishes — nothing is inferred from proximity.',
            'A ticket is a record that work was raised, not a confirmed equipment failure.',
          ],
          actions: [{ type: 'FOCUS_ASSET', assetId, label: `Show asset ${assetId}` }],
        });
      },
    },
  };

  /** The registry, frozen, with each definition carrying its own name. */
  const registry = Object.freeze(Object.fromEntries(
    Object.entries(DEFINITIONS).map(([name, definition]) => [name, Object.freeze({ name, readOnly: true, ...definition })]),
  ));

  return registry;
}

/** Whether a capability makes sense where the operator is standing, and on the data they have. */
export function capabilityAvailable(capability, context) {
  if (!capability) return { available: false, reason: 'Unknown capability.' };
  const screens = capability.screens ?? ['*'];
  if (!screens.includes('*') && !screens.includes(context?.screen)) {
    return { available: false, reason: `Only on the ${screens.join(' / ')} screen.` };
  }
  if (capability.requires?.includes('selectedIncident') && !context?.tmc?.selectedIncidentId) {
    return { available: false, reason: 'No incident is selected.' };
  }
  // A historical-only capability must not be answered from a live screen state.
  if (capability.temporal === 'HISTORICAL' && context?.tmc?.mode && context.tmc.mode !== 'HISTORICAL') {
    return { available: false, reason: 'Available on a historical date only.' };
  }
  return { available: true, reason: null };
}
