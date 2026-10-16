/**
 * The baseline a simulation runs against: what the register ACTUALLY recorded about one incident,
 * and what had to be assumed to simulate it at all.
 *
 * The register was audited before any of this was written. It carries an incident date and time, a
 * type, injury and fatality flags, a lane-closure flag and duration, weather and traffic words, an
 * assigned category and a damaged asset — and it carries NO detection time, no dispatch, no
 * responder arrival, no tow arrival, no lane-reopening timestamp, no blocked-lane count and no
 * measured traffic volume. Those are exactly the inputs an incident-response simulation needs.
 *
 * So every field here is classified, and the classification travels with the value to the screen
 * and into every result:
 *
 *   OBSERVED    — the register's own field, as recorded.
 *   DERIVED     — computed from observed values by a stated rule (AADT to an hourly demand).
 *   ASSUMED     — a configurable scenario input with a default. Not a measurement of anything.
 *   UNAVAILABLE — needed, not present, and not invented.
 *
 * A baseline built with assumed stage timings is a RECONSTRUCTION, never "the historical response".
 * `mode` says which, and nothing downstream is allowed to forget it.
 */

export const PROVENANCE = Object.freeze({
  OBSERVED: 'OBSERVED',
  DERIVED: 'DERIVED',
  ASSUMED: 'ASSUMED',
  UNAVAILABLE: 'UNAVAILABLE',
});

export const BASELINE_MODES = Object.freeze({
  /** Every timing used is one the register recorded. On this corpus, never reachable. */
  OBSERVED: 'OBSERVED',
  /** Observed conditions plus stated assumptions for what the register does not hold. */
  RECONSTRUCTED: 'RECONSTRUCTED',
  /** The operator's own numbers, for exploring a situation rather than reproducing one. */
  HYPOTHETICAL: 'HYPOTHETICAL',
});

const field = (value, provenance, note = null) => Object.freeze({ value, provenance, note });

/**
 * The traffic assumptions, in one place because they drive every number downstream.
 *
 * I-595's published AADT is a two-way annual average. Turning it into the demand on one carriageway
 * at one hour of one day needs two standard factors, and both are assumptions here rather than
 * measurements of this corridor:
 *
 *   K — the share of a day's traffic in the design hour. 9% is the usual urban-freeway figure.
 *   D — the directional split in that hour. 55/45 is the usual figure for a commuter corridor.
 *
 * Capacity per lane is the HCM's 1,900 passenger cars per hour per lane at free-flow speed. The
 * LANE COUNT is the weakest input in the whole model: nothing in the twin publishes how many lanes
 * each section carries, so it is an assumption the operator is expected to correct.
 */
export const TRAFFIC_ASSUMPTIONS = Object.freeze({
  peakHourFactorK: 0.09,
  directionalSplitD: 0.55,
  capacityPerLaneVph: 1900,
  lanesPerDirection: 4,
  /** What a blocked lane costs beyond its own capacity: rubbernecking and merging turbulence. */
  incidentCapacityPenalty: 0.14,
  /** Share of demand that leaves the corridor rather than waiting, once a queue is building. */
  divertedShare: 0.15,
  /** Share that gives up on the trip entirely. Deferred demand is NOT this. */
  lostShare: 0.02,
  heavyVehicleShare: 0.08,
});

export const ASSUMPTION_NOTES = Object.freeze({
  peakHourFactorK: 'Share of a day’s traffic in the design hour. A standard urban-freeway figure, '
    + 'not a count taken on this corridor.',
  directionalSplitD: 'Directional split in that hour. A standard commuter-corridor figure.',
  capacityPerLaneVph: 'Passenger cars per hour per lane at free-flow speed (HCM). Not measured here.',
  lanesPerDirection: 'Nothing in the twin publishes a lane count per section. This is the weakest '
    + 'input in the model and the first one an operator should correct.',
  incidentCapacityPenalty: 'Capacity lost beyond the blocked lane itself, to rubbernecking and '
    + 'merging turbulence. A planning figure.',
  divertedShare: 'Share of arrivals that leave the corridor once a queue is building.',
  lostShare: 'Share that abandons the trip. Separate from demand that is merely delayed.',
  heavyVehicleShare: 'Used only to weight the value of time. Not a measured classification count.',
});

/** Lanes blocked, inferred from what the register DOES say, with the rule stated. */
function blockedLanesFrom(fact, assumed) {
  if (!fact?.laneClosure) {
    return field(0, PROVENANCE.OBSERVED, 'The register’s own lane-closure flag says no lane was closed.');
  }
  return field(assumed, PROVENANCE.ASSUMED,
    'The register records THAT a lane was closed, never how many. This is a scenario input.');
}

/**
 * Build the baseline for one incident.
 *
 * @param {object} fact an incident fact from incidentFacts()
 * @param {{sectionProfile?: object, assumptions?: object, overrides?: object,
 *          nearbyRecords?: number, hotspotRecords?: number}} context
 */
export function buildIncidentBaseline(fact, {
  sectionProfile = null, assumptions = TRAFFIC_ASSUMPTIONS, overrides = {},
  nearbyRecords = 0, hotspotRecords = 0,
} = {}) {
  if (!fact) return null;
  const settings = Object.freeze({ ...TRAFFIC_ASSUMPTIONS, ...assumptions, ...overrides });
  const aadt = sectionProfile?.section?.aadt ?? null;

  /** Demand on this carriageway in the incident's hour, from the section's published AADT. */
  const demandVph = aadt
    ? Math.round(aadt * settings.peakHourFactorK * settings.directionalSplitD)
    : null;
  const lanes = settings.lanesPerDirection;
  const capacityVph = lanes * settings.capacityPerLaneVph;

  const blockedLanes = blockedLanesFrom(fact, Math.min(lanes - 1, settings.blockedLanes ?? 2));

  return Object.freeze({
    incidentId: fact.id,
    fact,
    mode: BASELINE_MODES.RECONSTRUCTED,
    modeNote: 'A reconstruction. The register holds no detection, dispatch, arrival or reopening '
      + 'time for any incident, so every stage timing below is a scenario assumption — this is not '
      + 'a record of how the incident was actually handled.',

    /* ---- what the register actually says ------------------------------------------------- */
    observed: Object.freeze({
      occurredAtMs: field(fact.when.ms, PROVENANCE.OBSERVED),
      type: field(fact.type, PROVENANCE.OBSERVED),
      severity: field(fact.severity.label, PROVENANCE.OBSERVED),
      laneClosure: field(fact.laneClosure, PROVENANCE.OBSERVED),
      laneClosureHours: fact.laneClosureHours != null
        ? field(fact.laneClosureHours, PROVENANCE.OBSERVED,
          'The one duration the register publishes. It is a closure duration, not a clearance time.')
        : field(null, PROVENANCE.UNAVAILABLE, 'No closure duration on this record.'),
      weather: fact.weather
        ? field(fact.weather, PROVENANCE.OBSERVED, 'The register’s own weather word, not a reading.')
        : field(null, PROVENANCE.UNAVAILABLE, 'No weather on this record.'),
      trafficConditions: fact.trafficConditions
        ? field(fact.trafficConditions, PROVENANCE.OBSERVED, 'A word, not a measured volume or speed.')
        : field(null, PROVENANCE.UNAVAILABLE, 'No traffic condition on this record.'),
      policeReport: fact.confirmed
        ? field(fact.policeReport, PROVENANCE.OBSERVED)
        : field(null, PROVENANCE.UNAVAILABLE, 'No police report number on this record.'),
      segment: sectionProfile
        ? field(sectionProfile.section.label, PROVENANCE.DERIVED,
          'The milepost range this record’s asset-derived position falls in.')
        : field(fact.segmentName, PROVENANCE.OBSERVED),
      carriageway: field(sectionProfile?.section.carriageway ?? 'UNKNOWN', PROVENANCE.UNAVAILABLE,
        'Carriageway is not verifiable: the position is the damaged asset’s.'),
      location: field({ longitude: fact.longitude, latitude: fact.latitude }, PROVENANCE.DERIVED,
        'The damaged asset’s position, not a surveyed crash point.'),
    }),

    /* ---- what had to be worked out --------------------------------------------------------- */
    traffic: Object.freeze({
      aadt: aadt
        ? field(aadt, PROVENANCE.OBSERVED, 'Published FDOT AADT for this milepost range, two-way.')
        : field(null, PROVENANCE.UNAVAILABLE, 'No AADT published for this stretch.'),
      aadtYear: field(sectionProfile?.section.aadtYear ?? null,
        aadt ? PROVENANCE.OBSERVED : PROVENANCE.UNAVAILABLE),
      demandVph: demandVph
        ? field(demandVph, PROVENANCE.DERIVED,
          `AADT × K ${settings.peakHourFactorK} × D ${settings.directionalSplitD}. Neither factor is `
          + 'measured on this corridor.')
        : field(null, PROVENANCE.UNAVAILABLE,
          'Without AADT there is no demand to model. Set one as a scenario assumption to continue.'),
      lanesPerDirection: field(lanes, PROVENANCE.ASSUMED, ASSUMPTION_NOTES.lanesPerDirection),
      capacityVph: field(capacityVph, PROVENANCE.DERIVED,
        `${lanes} lanes × ${settings.capacityPerLaneVph} veh/h/lane.`),
      blockedLanes,
      /** How saturated the stretch is before anything happens. Over 1.0 the results are nonsense. */
      baselineVolumeToCapacity: demandVph
        ? field(Number((demandVph / capacityVph).toFixed(2)), PROVENANCE.DERIVED)
        : field(null, PROVENANCE.UNAVAILABLE),
    }),

    /* ---- what the register simply does not hold -------------------------------------------- */
    unavailable: Object.freeze([
      { field: 'Detection time', reason: 'No field records when the incident was detected.' },
      { field: 'Verification time', reason: 'No field records when it was confirmed.' },
      { field: 'Dispatch time', reason: 'No dispatch record exists on this instance.' },
      { field: 'Responder arrival', reason: 'No Road Ranger or patrol dataset exists at all.' },
      { field: 'Tow arrival', reason: 'No tow record exists.' },
      { field: 'Lane reopening time', reason: 'The register holds a closure DURATION, not a reopening.' },
      { field: 'Blocked lane count', reason: 'The register records that a lane closed, not how many.' },
      { field: 'Measured traffic volume', reason: 'No count or speed for this date and location.' },
      { field: 'Toll rate in force', reason: 'No historical toll schedule is published here.' },
    ]),

    /* ---- context the risk side needs ------------------------------------------------------- */
    context: Object.freeze({
      nearbyRecords: field(nearbyRecords, PROVENANCE.OBSERVED,
        'Other register records within 300 m of this one.'),
      hotspotRecords: field(hotspotRecords, PROVENANCE.OBSERVED,
        'Records in the concentration this incident belongs to, if any.'),
      sectionRecords: field(sectionProfile?.records ?? 0, PROVENANCE.OBSERVED),
    }),

    assumptions: settings,
    assumptionNotes: ASSUMPTION_NOTES,
  });
}

/** Every field, flattened, for the data-quality readout. */
export function provenanceSummary(baseline) {
  if (!baseline) return null;
  const rows = [];
  const walk = (group, prefix) => {
    for (const [key, entry] of Object.entries(group)) {
      if (entry && typeof entry === 'object' && 'provenance' in entry) {
        rows.push({ key: `${prefix}.${key}`, label: key, ...entry });
      }
    }
  };
  walk(baseline.observed, 'observed');
  walk(baseline.traffic, 'traffic');
  walk(baseline.context, 'context');
  const count = provenance => rows.filter(row => row.provenance === provenance).length;
  const counted = rows.length + baseline.unavailable.length;
  return Object.freeze({
    rows: Object.freeze(rows),
    counts: Object.freeze({
      OBSERVED: count(PROVENANCE.OBSERVED),
      DERIVED: count(PROVENANCE.DERIVED),
      ASSUMED: count(PROVENANCE.ASSUMED),
      UNAVAILABLE: count(PROVENANCE.UNAVAILABLE) + baseline.unavailable.length,
    }),
    total: counted,
    observedShare: counted ? Number((count(PROVENANCE.OBSERVED) / counted).toFixed(2)) : 0,
  });
}

/**
 * The recorded closure against the reconstructed reopening, and whether the two are comparable.
 *
 * The register says this incident closed a lane for about 120 minutes; the reconstruction says the
 * lanes reopen at 101. It is tempting to treat the gap as model error and tune an assumption until
 * it closes — which would be fitting the model to one number by moving inputs nobody measured.
 *
 * The honest question is first whether the two measure the same thing, and they do not quite:
 *
 *   • `lane_closure_duration_hours` is a DURATION on the record. Nothing says when the clock
 *     started — at the incident, at the first report, or when a crew arrived and closed the lane
 *     properly — or when it stopped, at first reopening or at full reopening.
 *   • The reconstruction measures from the incident to ALL lanes open, which is one specific
 *     definition of several the recorded figure might be using.
 *   • Every stage timing in the reconstruction is an assumption, so the difference is at least as
 *     much a statement about those as about the register.
 *
 * So this reports the gap, states what would make them comparable, and does not adjust anything.
 */
export function calibration(baseline, run) {
  const recordedHours = baseline?.observed?.laneClosureHours?.value;
  if (recordedHours == null || !run) {
    return Object.freeze({
      comparable: false,
      recordedMinutes: null,
      reconstructedMinutes: run ? Math.round(run.timeline.roadwayClearanceMinutes) : null,
      reason: 'This record states no closure duration, so there is nothing to compare the '
        + 'reconstruction against.',
    });
  }
  const recorded = Math.round(recordedHours * 60);
  const reconstructed = Math.round(run.timeline.roadwayClearanceMinutes);
  const difference = reconstructed - recorded;
  return Object.freeze({
    comparable: false,
    recordedMinutes: recorded,
    recordedBasis: 'The register’s own lane-closure duration.',
    reconstructedMinutes: reconstructed,
    reconstructedBasis: 'Modelled: incident to all lanes open, from assumed stage timings.',
    /** Also reported, because it is the closer match to "closure" on some readings. */
    reconstructedToPartialMinutes: Math.round(run.timeline.partialReopen),
    differenceMinutes: difference,
    differencePercent: recorded ? Number(((difference / recorded) * 100).toFixed(0)) : null,
    /**
     * Why the two are not the same measurement, in the terms that would have to be settled before
     * the gap could be called an error.
     */
    whyNotComparable: Object.freeze([
      'The recorded duration has no start or end definition on the record: it may run from the '
        + 'incident, from the first report, or from when the lane was formally closed.',
      'The reconstruction measures from the incident to ALL lanes open. If the recorded figure '
        + `ends at first reopening, the comparable modelled value is `
        + `${Math.round(run.timeline.partialReopen)} minutes, not ${reconstructed}.`,
      'Every stage duration in the reconstruction is an assumption, so the gap reflects those as '
        + 'much as it reflects the register.',
      'No detection, dispatch, arrival or reopening timestamp exists for this incident, which is '
        + 'what calibration would need.',
    ]),
    wouldNeed: Object.freeze([
      'A definition of what the recorded closure duration measures, from the data owner.',
      'At least one observed stage timestamp per incident, to anchor the reconstruction.',
      'Enough incidents with both to compare distributions rather than a single pair.',
    ]),
    note: 'Reported, not reconciled. Nothing here is adjusted to make the model match the record: '
      + 'tuning unmeasured assumptions until one number agrees would make every other number worse '
      + 'evidence, not better.',
  });
}
