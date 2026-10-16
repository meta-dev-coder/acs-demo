/**
 * Candidate interventions, each one tied to the records that suggested it.
 *
 * Every recommendation answers seven questions — the concern, the evidence, why it matters, what to
 * do, who should look, how urgent, and how the result could be measured — and carries the ids of
 * the records behind it so a reader can open them. A recommendation with no traceable evidence is
 * not produced at all.
 *
 * Three rules this module will not break:
 *
 *   • No predicted reduction. Nothing here says "this will cut crashes by n%": no crash-modification
 *     factor is available, and inventing one would make an engineering claim out of a count.
 *   • Proximity is not cause. Where a recommendation rests on two things being near each other, it
 *     says so and recommends INSPECTION, not a fix.
 *   • Candidate, not decision. Each one is a prompt to investigate, addressed to a named team, and
 *     the wording says that.
 *
 * Deterministic: same evidence in, same recommendations out, no clock and no randomness.
 */

/**
 * Who would own the review. Named roles rather than people, matching how a corridor contract is
 * usually organised; a deployment with different teams can remap these in one place.
 */
export const OWNERS = Object.freeze({
  TRAFFIC_ENGINEERING: 'Traffic Engineering / Safety',
  MAINTENANCE: 'Maintenance',
  OPERATIONS: 'TMC Operations',
  FIELD: 'Field Operations / Road Rangers',
  DATA: 'Data Owner',
});

/**
 * How soon somebody should look, in words that say what KIND of attention is wanted.
 *
 * "Look at now" on every finding told an operator nothing — a 900-day-old work order and a fatal
 * concentration both read as emergencies. These distinguish the response, not just the rank.
 */
export const URGENCY = Object.freeze({
  IMMEDIATE_RESPONSE: { id: 'IMMEDIATE_RESPONSE', label: 'Immediate operational response', rank: 5 },
  URGENT_INSPECTION: { id: 'URGENT_INSPECTION', label: 'Urgent safety inspection', rank: 4 },
  OVERDUE_MAINTENANCE: { id: 'OVERDUE_MAINTENANCE', label: 'Overdue maintenance review', rank: 3 },
  PLANNED_ASSESSMENT: { id: 'PLANNED_ASSESSMENT', label: 'Planned engineering assessment', rank: 2 },
  DATA_VALIDATION: { id: 'DATA_VALIDATION', label: 'Data validation required', rank: 1 },
});

/** How much the evidence supports the concern. Stated, never implied by the ordering. */
export const CONFIDENCE = Object.freeze({
  OBSERVED: { id: 'OBSERVED', label: 'Observed in the records', rank: 3 },
  ASSOCIATED: { id: 'ASSOCIATED', label: 'Association only', rank: 2 },
  UNVERIFIED: { id: 'UNVERIFIED', label: 'Needs validation', rank: 1 },
});

/** A work order open this long is more likely a register artefact than a live failure. */
export const STALE_DEFECT_DAYS = 365;

const recommendation = fields => Object.freeze({
  successMeasure: 'Compare severity-weighted recorded incidents over equivalent exposure-adjusted '
    + 'periods before and after anything implemented. No reduction is predicted here.',
  claimsNoReduction: true,
  ...fields,
  sourceRecords: Object.freeze(fields.sourceRecords ?? []),
});

/**
 * Recommendations for one location, from everything known about it.
 *
 * @param {{facts: object[], defects: object[], hazards: object[], secondary: object,
 *          sectionProfile: object|null, label: string}} evidence
 */
export function recommendationsFor({
  facts = [], defects = [], hazards = [], secondary = null, sectionProfile = null, label = 'this location',
} = {}) {
  const found = [];
  const severe = facts.filter(fact => fact.severity.rank >= 2);
  const fatal = facts.filter(fact => fact.severity.level === 'FATAL');
  const openDefects = defects.filter(defect => defect.open);
  const overdue = openDefects.filter(defect => defect.overdue);
  const stale = openDefects.filter(defect => (defect.ageDays ?? 0) > STALE_DEFECT_DAYS);
  const live = openDefects.filter(defect => !stale.includes(defect));
  const hazardFindings = hazards.flatMap(place => place.observations ?? []);
  const failedInspections = hazardFindings.filter(observation => observation.failed);

  /* --- Accident patterns ------------------------------------------------------------------ */
  if (facts.length >= 3) {
    const topType = [...facts.reduce((map, fact) => map.set(fact.type, (map.get(fact.type) ?? 0) + 1), new Map())]
      .sort((a, b) => b[1] - a[1])[0];
    const hours = facts.map(fact => fact.when.hour);
    const peak = [...hours.reduce((map, hour) => map.set(hour, (map.get(hour) ?? 0) + 1), new Map())]
      .sort((a, b) => b[1] - a[1])[0];
    found.push(recommendation({
      id: `rec-pattern-${label}`,
      domain: 'ACCIDENT',
      concern: `Recorded incidents recur at ${label}.`,
      evidence: `${facts.length} records${topType ? `, most often ${topType[0].toLowerCase()} (${topType[1]})` : ''}`
        + `${peak && peak[1] > 1 ? `, concentrated around ${String(peak[0]).padStart(2, '0')}:00 (${peak[1]} records)` : ''}.`
        + ` ${severe.length} recorded an injury or fatality.`,
      whyItMatters: fatal.length
        ? 'A fatal record is present, so the consequence of recurrence here is at its highest.'
        : 'Recurrence is what distinguishes a location worth engineering attention from an isolated event.',
      action: 'Review geometry, lane guidance, signing and upstream warning coverage over this stretch, '
        + 'against the circumstances the records describe.',
      owner: OWNERS.TRAFFIC_ENGINEERING,
      urgency: fatal.length ? URGENCY.URGENT_INSPECTION : URGENCY.PLANNED_ASSESSMENT,
      confidence: CONFIDENCE.OBSERVED,
      caveat: 'Record positions are asset-derived, so the stretch is approximate and the exact '
        + 'collision points are not known.',
      sourceRecords: facts.slice(0, 12).map(fact => ({ kind: 'incident', id: fact.id,
        label: `${fact.type} · ${fact.when.dayKey} · ${fact.severity.label}` })),
    }));
  }

  /* --- Secondary exposure ----------------------------------------------------------------- */
  const secondaryRecords = facts.filter(fact => /secondary/i.test(fact.rootCauseCategory ?? ''));
  if (secondaryRecords.length >= 2) {
    const withClosure = secondaryRecords.filter(fact => fact.laneClosure).length;
    found.push(recommendation({
      id: `rec-secondary-${label}`,
      domain: 'SECONDARY',
      concern: `More than one record at ${label} is categorised as a secondary collision.`,
      evidence: `${secondaryRecords.length} secondary-labelled records, ${withClosure} of which closed a lane.`,
      whyItMatters: 'Where incidents are followed by others, the approach to an incident — what '
        + 'drivers are told and how early — is the thing to examine.',
      action: 'Review upstream detection and warning coverage for this stretch: camera sight lines, '
        + 'the nearest message sign and the time it takes to post a warning.',
      owner: OWNERS.OPERATIONS,
      urgency: URGENCY.PLANNED_ASSESSMENT,
      confidence: CONFIDENCE.UNVERIFIED,
      caveat: 'The secondary label is a category assigned on the record. No field in the register '
        + 'links a secondary record to the primary incident that caused it, so these are not '
        + 'verified primary-secondary pairs.',
      sourceRecords: secondaryRecords.slice(0, 10).map(fact => ({ kind: 'incident', id: fact.id,
        label: `${fact.type} · ${fact.when.dayKey}` })),
    }));
  }

  /* --- Asset condition -------------------------------------------------------------------- */
  for (const defect of overdue.filter(entry => !stale.includes(entry)).slice(0, 3)) {
    found.push(recommendation({
      id: `rec-defect-${defect.id}`,
      domain: 'ASSET',
      concern: `${defect.assetType ?? 'A safety-relevant asset'} ${defect.assetId ?? ''} has been open `
        + `past its repair target.`.replace(/\s+/g, ' '),
      evidence: `Work order ${defect.id}, open ${defect.ageDays} days against a published `
        + `${defect.targetDays}-day target for ${defect.assetType}. ${defect.description ?? ''}`.trim(),
      whyItMatters: 'This class serves detection, warning, lighting or restraint, so while it is out '
        + 'of service the corridor loses part of how it sees or protects.',
      action: 'Confirm the asset’s current state in the field and either close the work order or '
        + 'escalate it against the published target.',
      owner: OWNERS.MAINTENANCE,
      urgency: URGENCY.OVERDUE_MAINTENANCE,
      confidence: CONFIDENCE.OBSERVED,
      caveat: null,
      sourceRecords: [{ kind: 'workOrder', id: defect.id, label: `Work order ${defect.id}` },
        ...(defect.assetId ? [{ kind: 'asset', id: defect.assetId, label: `Asset ${defect.assetId}` }] : [])],
    }));
  }

  /* --- Defects too old to believe without checking ---------------------------------------- */
  if (stale.length) {
    found.push(recommendation({
      id: `rec-stale-${label}`,
      domain: 'ASSET',
      concern: `${stale.length} work order${stale.length === 1 ? '' : 's'} at ${label} ${stale.length === 1 ? 'has' : 'have'} `
        + `been open over a year.`,
      evidence: `Longest open ${Math.max(...stale.map(defect => defect.ageDays ?? 0))} days `
        + `(${stale.slice(0, 3).map(defect => defect.id).join(', ')}).`,
      whyItMatters: 'A work order open this long is as likely to be a record that was never closed '
        + 'as a fault still on the road. Treating it as a live failure would misdirect a crew; '
        + 'treating it as noise would hide a real one.',
      action: 'Verify in the field whether these faults still exist, then close the records or '
        + 'reschedule the repairs.',
      owner: OWNERS.MAINTENANCE,
      urgency: URGENCY.DATA_VALIDATION,
      confidence: CONFIDENCE.UNVERIFIED,
      caveat: 'Age alone does not establish that the asset is still faulty.',
      sourceRecords: stale.slice(0, 10).map(defect => ({ kind: 'workOrder', id: defect.id,
        label: `${defect.assetType ?? 'Asset'} ${defect.assetId ?? ''} · ${defect.ageDays} days` })),
    }));
  }

  /* --- Hazards ---------------------------------------------------------------------------- */
  if (hazardFindings.length >= 2) {
    const kinds = [...new Set(hazardFindings.flatMap(observation => observation.hazards))];
    found.push(recommendation({
      id: `rec-hazard-${label}`,
      domain: 'HAZARD',
      concern: `Inspections keep finding hazards at ${label}.`,
      evidence: `${hazardFindings.reduce((sum, observation) => sum + observation.hazardCount, 0)} findings `
        + `across ${hazardFindings.length} inspections: ${kinds.slice(0, 4).join(', ')}.`
        + (failedInspections.length ? ` ${failedInspections.length} inspection(s) failed.` : ''),
      whyItMatters: 'A hazard found repeatedly in the same place is a recurring source, not a '
        + 'one-off: clearing it again will not stop it coming back.',
      action: 'Inspect the location for what is producing the hazard — drainage, a damaged barrier, '
        + 'a shoulder defect — and treat the source rather than the symptom.',
      owner: OWNERS.FIELD,
      urgency: failedInspections.length ? URGENCY.URGENT_INSPECTION : URGENCY.PLANNED_ASSESSMENT,
      confidence: CONFIDENCE.OBSERVED,
      caveat: 'These are inspectors’ observations on a date. Nothing here records a hazard being '
        + 'reported, dispatched or cleared, so response performance cannot be assessed.',
      sourceRecords: hazardFindings.slice(0, 10).map(observation => ({ kind: 'inspection',
        id: observation.id, label: `${observation.inspectedOn ?? 'Inspection'} · ${observation.hazards.join(', ')}` })),
    }));
  }

  /* --- The one cross-domain claim --------------------------------------------------------- */
  if (facts.length >= 3 && live.length) {
    found.push(recommendation({
      id: `rec-cross-${label}`,
      domain: 'CROSS',
      concern: `Recorded incidents and an unresolved safety-relevant defect occupy the same stretch at ${label}.`,
      evidence: `${facts.length} incident records and ${live.length} open work order(s) on `
        + `${[...new Set(live.map(defect => defect.assetType))].filter(Boolean).join(', ')}.`,
      whyItMatters: 'Two domains pointing at one place is worth one visit rather than two separate '
        + 'reviews that never meet.',
      action: 'Send one inspection to look at both: the asset’s condition and the circumstances the '
        + 'incident records describe.',
      owner: OWNERS.TRAFFIC_ENGINEERING,
      urgency: URGENCY.URGENT_INSPECTION,
      confidence: CONFIDENCE.ASSOCIATED,
      caveat: 'Proximity only. Nothing in the register attributes any of these incidents to this '
        + 'asset, and no cause is implied by the two appearing together.',
      sourceRecords: [
        ...facts.slice(0, 5).map(fact => ({ kind: 'incident', id: fact.id,
          label: `${fact.type} · ${fact.when.dayKey}` })),
        ...live.slice(0, 5).map(defect => ({ kind: 'workOrder', id: defect.id,
          label: `Work order ${defect.id}` })),
      ],
    }));
  }

  /* --- Exposure, where it can be computed -------------------------------------------------- */
  if (sectionProfile?.perHundredMillionVmt != null && sectionProfile.records >= 3) {
    found.push(recommendation({
      id: `rec-exposure-${sectionProfile.id}`,
      domain: 'ACCIDENT',
      concern: `${label} carries ${sectionProfile.perHundredMillionVmt} recorded incidents per 100 million `
        + 'vehicle-miles.',
      evidence: `${sectionProfile.records} records against `
        + `${(sectionProfile.exposureVehicleMiles / 1_000_000).toFixed(0)} million vehicle-miles, from the `
        + `section’s published AADT (${sectionProfile.section.aadt.toLocaleString('en-US')}, `
        + `${sectionProfile.section.aadtYear}).`,
      whyItMatters: 'Counts alone rank the busiest stretches first. Against exposure, a short or '
        + 'quiet section with the same count moves up where it belongs.',
      action: 'Compare this section against the others at the same exposure before choosing where to '
        + 'send an engineering assessment.',
      owner: OWNERS.TRAFFIC_ENGINEERING,
      urgency: URGENCY.PLANNED_ASSESSMENT,
      confidence: CONFIDENCE.ASSOCIATED,
      caveat: 'A recorded-incident rate from an operational register, not an FDOT crash rate, and '
        + 'built on a single-year AADT applied across the whole period.',
      sourceRecords: sectionProfile.facts.slice(0, 8).map(fact => ({ kind: 'incident', id: fact.id,
        label: `${fact.type} · ${fact.when.dayKey}` })),
    }));
  }

  return Object.freeze(found.sort((a, b) => b.urgency.rank - a.urgency.rank
    || b.confidence.rank - a.confidence.rank));
}
