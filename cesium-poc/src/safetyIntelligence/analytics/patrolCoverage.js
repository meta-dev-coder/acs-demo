/**
 * Road Ranger analysis, built only from what the twin actually holds.
 *
 * The audit found NO patrol dataset in DataConnect: no Road Ranger activity log, no dispatch
 * record, no AVL trace, no debris-removal log. The TMC screen's patrol module is explicitly
 * simulated and is therefore not evidence about anything.
 *
 * What does exist is hazard EVIDENCE, in the inspection classes: `Florida I595 Roadway Inspections`
 * and `Florida I595 Safety Inspections` carry `debris_in_travel_lanes` and `clear_zone_hazards`
 * flags with a risk rating. That supports "where hazards are being found", which is a real input to
 * deployment planning. It does not support response times, coverage percentages, or hazards per
 * patrol-hour — those are reported UNAVAILABLE in `patrolKpis()` with the source that would be
 * needed, and this module never substitutes an estimate for them.
 */
const attributesOf = record => record?.attributes ?? record?.raw?.attributes ?? record ?? {};
const text = value => {
  const string = String(value ?? '').trim();
  return string && string.toUpperCase() !== 'N/A' ? string : null;
};
/**
 * What a flagged hazard field looks like in this instance.
 *
 * The inspection forms do not use yes/no: a field reads "OK" when the inspector found nothing and
 * "Issue" when they did. Testing for yes/true found nothing at all and the hazard count came out as
 * zero on 1,548 inspection records — so the vocabulary is read from the data rather than assumed.
 */
const flagged = value => /^(issue|issues|fail(ed)?|deficient|present|yes|y|true|1)$/i
  .test(String(value ?? '').trim());

/**
 * The hazard fields the inspection forms actually publish, named as the inspector would say it.
 *
 * Chosen as the ones a patrol could ACT on — something in or beside the travel way — rather than
 * every condition field on the form. A structural crack is a maintenance finding, not a hazard a
 * Road Ranger clears, so it is not counted here.
 */
export const HAZARD_FIELDS = Object.freeze([
  { field: 'debris_in_travel_lanes', label: 'Debris in travel lanes' },
  { field: 'clear_zone_hazards', label: 'Clear-zone hazard' },
  { field: 'standing_water_in_lanes', label: 'Standing water in lanes' },
  { field: 'guardrail_damaged_or_deflected', label: 'Guardrail damaged or deflected' },
  { field: 'crash_attenuator_issue', label: 'Crash attenuator damaged' },
  { field: 'exposed_hardware_or_sharp_edges', label: 'Exposed hardware or sharp edges' },
  { field: 'edge_drop_off_gt_2in', label: 'Edge drop-off over 2 inches' },
  { field: 'shoulder_not_driveable', label: 'Shoulder not driveable' },
  { field: 'potholes_or_surface_failures', label: 'Potholes or surface failure' },
  { field: 'missing_or_knocked_down_posts', label: 'Posts missing or knocked down' },
  { field: 'signs_not_legible_at_speed', label: 'Sign not legible at speed' },
  { field: 'markings_not_visible_day_night', label: 'Markings not visible' },
]);

/** One inspection record, read for the hazards it reports. */
export function hazardObservation(record) {
  const attributes = attributesOf(record);
  const hazards = HAZARD_FIELDS.filter(({ field }) => flagged(attributes[field])).map(({ label }) => label);
  const rating = Number(text(attributes.risk_rating_1_5) ?? text(attributes.risk_rating_1_5_v3));
  return Object.freeze({
    id: text(attributes.code) ?? record?.id ?? null,
    record,
    hazards: Object.freeze(hazards),
    hazardCount: hazards.length,
    riskRating: Number.isFinite(rating) ? rating : null,
    passFail: text(attributes.pass_fail) ?? text(attributes.inspection_result),
    // Two different forms, two different field names for the same verdict.
    failed: /fail/i.test(`${attributes.pass_fail ?? ''} ${attributes.inspection_result ?? ''}`),
    form: text(attributes.inspection_form_family),
    inspectedOn: text(attributes.inspection_date) ?? text(attributes.date),
    segmentName: text(attributes['segment name']) ?? text(attributes.segment),
    assetId: text(attributes.asset_id) ?? text(attributes['Asset ID']),
    longitude: Number.isFinite(record?.longitude) ? record.longitude : Number(attributes.x_coordinates) || null,
    latitude: Number.isFinite(record?.latitude) ? record.latitude : Number(attributes.y_coordinates) || null,
  });
}

/**
 * Where hazards are being found, and what that can and cannot say about deployment.
 *
 * @param {object[]} inspections roadway and safety inspection records
 * @param {{period?: string}} [options]
 */
export function hazardEvidence(inspections = [], { period = 'selected range' } = {}) {
  const observations = inspections.map(hazardObservation);
  const withHazards = observations.filter(observation => observation.hazardCount > 0);
  const places = new Map();
  for (const observation of withHazards) {
    // Most inspection records carry no segment name, so a place is named by whatever it does
    // carry: the segment, else the asset it was inspecting, else its own coordinates. "Unnamed
    // location" told the reader nothing and made every hazard entry in the queue look identical.
    const coordinates = Number.isFinite(observation.longitude) && Number.isFinite(observation.latitude)
      ? `${observation.latitude.toFixed(4)}, ${observation.longitude.toFixed(4)}` : null;
    const key = observation.segmentName ?? (observation.assetId ? `asset:${observation.assetId}` : coordinates);
    if (!key) continue;
    const entry = places.get(key) ?? {
      key,
      label: observation.segmentName
        ?? (observation.assetId ? `Asset ${observation.assetId}` : null)
        ?? coordinates,
      observations: [],
      longitude: observation.longitude,
      latitude: observation.latitude,
    };
    entry.observations.push(observation);
    places.set(key, entry);
  }
  const ranked = [...places.values()]
    .map(entry => Object.freeze({
      ...entry,
      observations: Object.freeze(entry.observations),
      hazards: entry.observations.reduce((sum, observation) => sum + observation.hazardCount, 0),
      worstRating: entry.observations.reduce((worst, observation) =>
        Math.max(worst, observation.riskRating ?? 0), 0) || null,
    }))
    .sort((a, b) => b.hazards - a.hazards || (b.worstRating ?? 0) - (a.worstRating ?? 0));
  return Object.freeze({
    period,
    inspections: observations.length,
    hazards: withHazards.reduce((sum, observation) => sum + observation.hazardCount, 0),
    inspectionsWithHazards: withHazards.length,
    locations: ranked.length,
    places: Object.freeze(ranked),
    byHazard: Object.freeze(HAZARD_FIELDS.map(({ label }) => Object.freeze({
      label,
      count: withHazards.filter(observation => observation.hazards.includes(label)).length,
    })).filter(row => row.count > 0)),
    basis: 'Roadway and safety inspection records that flag a hazard.',
    caveat: 'Inspection findings show where hazards are OBSERVED by inspectors. They are not a patrol '
      + 'log: nothing here records a hazard being reported, dispatched or cleared.',
  });
}

/** What the screen must say instead of a response-time number. */
export const PATROL_DATA_GAPS = Object.freeze([
  Object.freeze({
    metric: 'Response time to a hazard',
    requires: 'A Road Ranger activity log with detection, dispatch, arrival and clearance timestamps.',
  }),
  Object.freeze({
    metric: 'Patrol coverage of high-risk segments',
    requires: 'Actual patrol routes or AVL traces. The TMC patrol view is simulated and is not evidence.',
  }),
  Object.freeze({
    metric: 'Hazards found per patrol-hour, and cost per hazard cleared',
    requires: 'Patrol hours worked and patrol cost data.',
  }),
  Object.freeze({
    metric: 'Optimal beat boundaries and shift patterns',
    requires: 'Both of the above. Without them an optimisation would be an opinion dressed as a result.',
  }),
]);

/**
 * Deployment suggestions that stay inside the evidence.
 *
 * Each one names the records it rests on and makes no claim about the effect of acting on it. The
 * screen presents these as "where to look", never as a validated patrol plan or a saving.
 */
export function deploymentHints({ hazards = null, hotspots = null, facts = [] } = {}) {
  const hints = [];
  for (const place of (hazards?.places ?? []).slice(0, 5)) {
    hints.push(Object.freeze({
      id: `hazard:${place.key}`,
      kind: 'HAZARD_EVIDENCE',
      place: place.label,
      longitude: place.longitude,
      latitude: place.latitude,
      statement: `${place.hazards} hazard finding${place.hazards === 1 ? '' : 's'} recorded at ${place.label}.`,
      evidence: `${place.observations.length} inspection record${place.observations.length === 1 ? '' : 's'}.`,
      claimsNoOutcome: true,
    }));
  }
  for (const cluster of (hotspots?.clusters ?? []).slice(0, 5)) {
    const hour = hourConcentration(cluster.facts ?? []);
    hints.push(Object.freeze({
      id: `cluster:${cluster.id}`,
      kind: 'RECORD_CONCENTRATION',
      place: cluster.label ?? 'Records concentration',
      longitude: cluster.longitude,
      latitude: cluster.latitude,
      statement: `${cluster.records} incident records concentrate here`
        + (hour ? `, most often around ${hour}.` : '.'),
      evidence: 'Incident register, asset-derived positions.',
      claimsNoOutcome: true,
    }));
  }
  return Object.freeze({
    hints: Object.freeze(hints),
    corpus: facts.length,
    caveat: 'These point at where records and findings concentrate. They are not a patrol schedule, '
      + 'and no reduction in incidents is claimed or implied for acting on them.',
  });
}

const hourConcentration = (facts = []) => {
  if (!facts.length) return null;
  const counts = new Map();
  for (const fact of facts) counts.set(fact.when.hour, (counts.get(fact.when.hour) ?? 0) + 1);
  const [hour, count] = [...counts].sort((a, b) => b[1] - a[1])[0];
  return count > 1 ? `${String(hour).padStart(2, '0')}:00` : null;
};
