/**
 * The KPIs, each with the question "can this be calculated at all?" answered first.
 *
 * A safety dashboard's worst failure mode is a confident number with nothing behind it. So every
 * KPI here is an object that knows its own availability: AVAILABLE with a value and the records it
 * was counted from, or UNAVAILABLE with the source that would be needed. Nothing is estimated, and
 * no unavailable KPI is quietly dropped from the row — it is shown, greyed, with its reason.
 *
 * What this corpus cannot support, and why:
 *   • An FDOT CRASH rate. A recorded-incident rate per 100 million vehicle-miles IS calculable —
 *     the corridor's FDOT segments publish AADT — but its numerator counts register records, not
 *     reported crashes, so it is reported under that name and never compared with a crash rate.
 *   • Economic cost: no cost model, no KABCO coding, no published unit costs.
 *   • Detection, verification, clearance and response times: the register records an incident date
 *     and time and a lane-closure duration — not a detection time, a verification time, an arrival
 *     or a clearance.
 *   • Intervention outcomes: nothing in the twin records an intervention being implemented, so
 *     before-and-after comparison has no "after".
 */
import { closureExposure, severityMix } from './patternAnalysis.js';

export const KPI_STATUS = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  /** Calculable, but from so few records that it would mislead. */
  INSUFFICIENT: 'INSUFFICIENT',
  UNAVAILABLE: 'UNAVAILABLE',
});

const available = (id, label, value, { unit = null, period = null, basis = null, records = null } = {}) =>
  Object.freeze({ id, label, status: KPI_STATUS.AVAILABLE, value, unit, period, basis, records });

const unavailable = (id, label, requires) =>
  Object.freeze({ id, label, status: KPI_STATUS.UNAVAILABLE, value: null, unit: null, period: null,
    basis: null, records: null, requires });

const periodOf = provenance => (provenance?.firstMonth && provenance?.lastMonth
  ? `${provenance.firstMonth} to ${provenance.lastMonth}` : 'selected range');

/**
 * The accident-analysis row.
 *
 * @param {object[]} facts the records in the current filter
 * @param {object} provenance from provenanceOf()
 */
export function accidentKpis(facts = [], provenance = null, { hotspots = null, sections = null } = {}) {
  const period = periodOf(provenance);
  const severity = severityMix(facts);
  const closures = closureExposure(facts);
  return Object.freeze([
    available('records', 'Incident records', facts.length, {
      unit: 'records', period, records: facts.length,
      basis: 'Counted from the incident register in the selected range.' }),
    available('severe', 'With injury or fatality', severity.fatal + severity.injury, {
      unit: 'records', period, records: facts.length,
      basis: `${severity.fatal} fatal, ${severity.injury} with injuries, from the records’ own fields.` }),
    available('severityIndex', 'Severity index', severity.index, {
      unit: 'weighted mean (1–3)', period, records: facts.length,
      basis: 'Local weighting of these records (fatal 3, injury 2, otherwise 1). Not a published index.' }),
    available('closureShare', 'Closed a lane', closures.withClosure, {
      unit: `of ${closures.incidents} records`, period, records: facts.length,
      basis: 'The register’s own lane-closure flag.' }),
    available('closureHours', 'Recorded closure time', closures.totalHours, {
      unit: 'hours', period, records: closures.hoursRecorded,
      basis: `Summed from ${closures.hoursRecorded} records that state a closure duration.` }),
    hotspots
      ? available('hotspots', 'Concentrations found', hotspots.clusters.length, {
        unit: `clusters ≥${hotspots.minimumRecords} records`, period, records: hotspots.clustered,
        basis: `Records within ${hotspots.radiusMeters} m of each other. Positions are asset-derived.` })
      : unavailable('hotspots', 'Concentrations found', 'record positions'),
    // Exposure DOES exist: the FDOT segments publish AADT. What does not exist is a crash file, so
    // this counts register records against vehicle-miles and is named accordingly.
    sections?.corridorPerHundredMillionVmt != null
      ? available('perVmt', 'Recorded incidents per 100M VMT', sections.corridorPerHundredMillionVmt, {
        unit: 'per 100M vehicle-miles', period, records: sections.assignedRecords,
        basis: `${sections.assignedRecords} records assigned to a milepost range, against `
          + `${(sections.totalExposure / 1_000_000).toFixed(0)}M vehicle-miles from published AADT. `
          + 'A recorded-incident rate from an operational register, not an FDOT crash rate.' })
      : unavailable('perVmt', 'Recorded incidents per 100M VMT',
        'Published AADT for the corridor’s milepost ranges, and records positioned on them.'),
    unavailable('economicCost', 'Economic cost',
      'A cost model and KABCO severity coding. Neither is present in the register.'),
  ]);
}

/**
 * The secondary-incident row.
 *
 * `root_cause_category = "Secondary collision"` is an OBSERVED label on the record. It is reported
 * as what it is, and kept apart from the TMC engine's modelled risk score, which is a prediction
 * about a live incident and not a count of anything that happened.
 */
export function secondaryKpis(facts = [], provenance = null) {
  const period = periodOf(provenance);
  const secondary = facts.filter(fact => /secondary/i.test(fact.rootCauseCategory ?? ''));
  const primary = facts.length - secondary.length;
  const hours = secondary.map(fact => fact.laneClosureHours).filter(Number.isFinite);
  return Object.freeze([
    available('secondaryRecords', 'Recorded as secondary', secondary.length, {
      unit: 'records', period, records: facts.length,
      basis: 'Records whose assigned category is a secondary collision.' }),
    primary > 0
      ? available('secondaryPer100', 'Per 100 other records',
        Number(((secondary.length / primary) * 100).toFixed(1)), {
        unit: 'per 100', period, records: facts.length,
        basis: 'Secondary-labelled records against all other records in range. A ratio within this '
          + 'register, not a validated secondary-crash rate.' })
      : unavailable('secondaryPer100', 'Per 100 other records', 'records that are not secondary'),
    available('secondaryWithClosure', 'Secondary with a lane closed',
      secondary.filter(fact => fact.laneClosure).length, {
      unit: `of ${secondary.length}`, period, records: secondary.length,
      basis: 'Lane-closure flag on the secondary-labelled records.' }),
    hours.length
      ? available('secondaryClosureHours', 'Median closure, secondary',
        Number([...hours].sort((a, b) => a - b)[Math.floor(hours.length / 2)].toFixed(2)), {
        unit: 'hours', period, records: hours.length, basis: 'Median of recorded closure durations.' })
      : unavailable('secondaryClosureHours', 'Median closure, secondary', 'closure durations on these records'),
    unavailable('detectionTime', 'Detection and verification time',
      'Timestamps for detection and verification. The register holds one incident time only.'),
    unavailable('clearanceTime', 'Roadway and incident clearance time',
      'Arrival and clearance timestamps. The register holds a closure duration, not a clearance record.'),
    unavailable('delayHours', 'Vehicle-hours of delay',
      'Traffic volume and speed during each incident. Not available for these dates.'),
  ]);
}

/** The asset-safety row, from maintenance and inspection records. */
export function assetKpis(summary, provenance = null) {
  const period = periodOf(provenance);
  return Object.freeze([
    available('openDefects', 'Open safety-related defects', summary.openDefects, {
      unit: 'work orders', period, records: summary.workOrders,
      basis: 'Work orders on safety-relevant asset classes that have no close date.' }),
    available('overdue', 'Open beyond the class target', summary.overdue, {
      unit: 'work orders', period, records: summary.withTarget,
      basis: 'Measured against the repair-time target published per asset category.' }),
    summary.mttrDays == null
      ? unavailable('mttr', 'Mean time to repair', 'work orders with both an open and a close date')
      : available('mttr', 'Mean time to repair', summary.mttrDays, {
        unit: 'days', period, records: summary.closedWithDates,
        basis: 'Closed work orders with both dates present.' }),
    summary.slaShare == null
      ? unavailable('sla', 'Repaired within target', 'repair-time targets for these asset categories')
      : available('sla', 'Repaired within target', Number((summary.slaShare * 100).toFixed(0)), {
        unit: '%', period, records: summary.closedWithTarget,
        basis: 'Closed work orders compared against their category target.' }),
    available('criticalAssets', 'Safety-relevant assets', summary.safetyAssets, {
      unit: 'assets', period, records: summary.assets,
      basis: 'Asset classes that serve detection, warning, lighting or restraint.' }),
    unavailable('riskPerDollar', 'Risk reduction per maintenance dollar',
      'Repair costs and a validated risk model. Neither is present.'),
    unavailable('assetCausedIncidents', 'Asset-caused incidents',
      'An investigated cause per incident. The register carries a category, never a finding.'),
  ]);
}

/** The Road Ranger row — mostly a statement of what would be needed. */
export function patrolKpis(summary) {
  return Object.freeze([
    available('hazardRecords', 'Hazard observations', summary.hazards, {
      unit: 'inspection findings', period: summary.period,
      records: summary.inspections,
      basis: 'Roadway and safety inspections reporting debris in lanes or clear-zone hazards.' }),
    available('hazardLocations', 'Locations with a hazard', summary.locations, {
      unit: 'locations', period: summary.period, records: summary.hazards,
      basis: 'Distinct positions among those findings.' }),
    unavailable('detectionToClearance', 'Hazard detection to clearance',
      'A Road Ranger activity log with detection and clearance times. No patrol dataset exists in this twin.'),
    unavailable('responseTarget', 'Meeting response targets',
      'Dispatch and arrival times, and a published target.'),
    unavailable('patrolCoverage', 'Patrol coverage of high-risk segments',
      'Actual patrol routes or AVL traces. The TMC patrol module is explicitly simulated and is not evidence.'),
    unavailable('hazardsPerPatrolHour', 'Hazards found per patrol-hour',
      'Patrol hours worked.'),
    unavailable('costPerHazard', 'Cost per hazard cleared', 'Patrol cost data.'),
  ]);
}

/**
 * The Outcomes row.
 *
 * Every one of these is UNAVAILABLE, and that is the finding: the twin records no intervention and
 * no exposure, so there is no "after" to measure against and no rate to measure in. The row exists
 * so the question is answered where it is asked rather than silently absent from the header.
 *
 * @param {{metric: string, requires: string}[]} requirements
 */
export const outcomeKpis = (requirements = []) => Object.freeze(requirements.map((item, position) =>
  unavailable(`outcome-${position}`, item.metric, item.requires)));

/** Everything the screen knows about how much it knows. */
export function dataCoverage(sets) {
  const rows = Object.entries(sets).map(([label, value]) => Object.freeze({
    label,
    records: value.records ?? 0,
    available: Boolean(value.records),
    note: value.note ?? null,
  }));
  return Object.freeze({
    rows: Object.freeze(rows),
    availableSets: rows.filter(row => row.available).length,
    totalSets: rows.length,
  });
}
