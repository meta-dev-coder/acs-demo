import test from 'node:test';
import assert from 'node:assert/strict';
import { incidentFacts, incidentFact, instantOf, provenanceOf, severityOf,
  assetPositionIndex } from '../src/safetyIntelligence/analytics/incidentFacts.js';
import { closureExposure, conditionBreakdown, hourlyProfile, monthlyTrend, severityMix,
  tally, weekdayProfile } from '../src/safetyIntelligence/analytics/patternAnalysis.js';
import { findHotspots, metresBetween, segmentConcentration } from '../src/safetyIntelligence/analytics/hotspots.js';
import { accidentKpis, assetKpis, dataCoverage, KPI_STATUS, outcomeKpis, patrolKpis,
  secondaryKpis } from '../src/safetyIntelligence/analytics/safetyKpis.js';
import { coOccurrences, modelledRisk, observedSecondary } from '../src/safetyIntelligence/analytics/secondaryExposure.js';
import { assetSafetySummary, defectsNearHotspots, isSafetyRelevant, repairTargets,
  safetyDefects } from '../src/safetyIntelligence/analytics/assetSafety.js';
import { hazardEvidence, hazardObservation, deploymentHints,
  PATROL_DATA_GAPS } from '../src/safetyIntelligence/analytics/patrolCoverage.js';
import { buildPriorityQueue, URGENCY, withCrossDomainLinks } from '../src/safetyIntelligence/analytics/priorityQueue.js';
import { buildTimeline, compareWindows, frameAt, replaySeries } from '../src/safetyIntelligence/analytics/replay.js';
import { answerSafetyQuestion, parseSafetyQuestion,
  SAFETY_SUGGESTIONS } from '../src/safetyIntelligence/safetyAnswers.js';
import { parseSimulationQuestion,
  SIMULATION_SUGGESTIONS } from '../src/safetyIntelligence/simulationAnswers.js';
import { accidentPanel, kpiRow, queuePanel, replayBar, coveragePanel, outcomesPanel,
  investigationPanel, sectionComparison, OUTCOME_REQUIREMENTS } from '../src/safetyIntelligence/safetyPanels.js';
import { SCOPES, SELECTION_TYPES, scopedFacts, selectHotspot, selectIncident, selectNothing,
  selectAsset, selectPlace, selectSection } from '../src/safetyIntelligence/selection.js';
import { buildPlaces, membersOf, placeTotals } from '../src/safetyIntelligence/analytics/mapPlaces.js';
import { buildSections, clipLineToPoints, exposureOf, highlightStretch, sectionFor,
  sectionProfiles } from '../src/safetyIntelligence/analytics/corridorSections.js';
import { OWNERS, recommendationsFor, STALE_DEFECT_DAYS } from '../src/safetyIntelligence/analytics/recommendations.js';
import { incidentAssessment, investigate } from '../src/safetyIntelligence/analytics/investigation.js';

/** Escape a literal for a RegExp, after the same escaping the panels apply to it. */
const escapeHtmlRe = value => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ============================================================================================
   Fixtures — shaped like the real classes: `attributes` with the instance's own field names.
   ============================================================================================ */

const incident = (code, overrides = {}) => ({
  id: code,
  attributes: {
    code,
    incident_date: '15/03/2025 00:00',
    incident_time: '08:30',
    incident_type: 'Multi-vehicle crash',
    injuries_y_n: 'No',
    fatalities: 'No',
    lane_closure_y_n: 'Yes',
    lane_closure_duration_hours: 1.5,
    speeding_involved_y_n: 'No',
    weather: 'Clear',
    traffic_conditions: 'Heavy',
    root_cause_category: 'Driver behavior',
    root_cause: '',
    damaged_asset_id: 'A1',
    police_report_number: 'FHP-1',
    'segment name': 'Segment 3',
    ...overrides,
  },
});

const assets = [
  { attributes: { code: 'A1', x_coordinates: -80.300, y_coordinates: 26.100, 'asset category': 'CCTV',
    'system class': 'ITS' } },
  { attributes: { code: 'A2', x_coordinates: -80.3005, y_coordinates: 26.1001, 'asset category': 'Guardrail',
    'system class': 'Roadway' } },
  { attributes: { code: 'A3', x_coordinates: -80.400, y_coordinates: 26.110, 'asset category': 'Bridge',
    'system class': 'Structures' } },
];

const workOrder = (id, overrides = {}) => ({
  id,
  attributes: {
    'Work Order ID': id,
    'Asset ID': 'A1',
    'Asset Type': 'CCTV',
    'System Class': 'ITS',
    Priority: 'High',
    'Work Order Status': 'Open',
    'Work Description': 'Camera offline',
    'Work Order Open Date': '01/01/2025 00:00',
    'Close Date': 'N/A',
    ...overrides,
  },
});

const inspection = (code, overrides = {}) => ({
  id: code,
  attributes: {
    code,
    inspection_date: '02/02/2025',
    inspection_result: 'Pass',
    risk_rating_1_5: 2,
    debris_in_travel_lanes: 'OK',
    clear_zone_hazards: 'OK',
    'segment name': 'Segment 3',
    x_coordinates: -80.300,
    y_coordinates: 26.100,
    ...overrides,
  },
});

const index = assetPositionIndex(assets);
const facts = () => incidentFacts([
  incident('INC-1'),
  incident('INC-2', { incident_date: '16/03/2025 00:00', incident_time: '17:05', injuries_y_n: 'Yes',
    damaged_asset_id: 'A2', police_report_number: '', root_cause_category: 'Secondary collision' }),
  incident('INC-3', { incident_date: '20/04/2025 00:00', incident_time: '02:00', fatalities: 'Yes',
    damaged_asset_id: 'A2', weather: 'Rain', lane_closure_y_n: 'No', lane_closure_duration_hours: 'N/A' }),
  incident('INC-4', { incident_date: '21/04/2025 00:00', incident_time: '08:40', damaged_asset_id: 'A1',
    incident_type: 'Vehicle fire', root_cause_category: 'Secondary collision' }),
], index);

/* ============================================================================================
   1. Reading the register
   ============================================================================================ */

test('a record is read at its own date and time, as the corridor local day', () => {
  const when = instantOf(incident('INC-1'));
  assert.equal(when.monthKey, '2025-03');
  assert.equal(when.dayKey, '2025-03-15');
  assert.equal(when.hour, 8);
  assert.equal(when.weekday, new Date(Date.UTC(2025, 2, 15)).getUTCDay());
});

test('severity comes from the record’s own harm fields and nothing else', () => {
  assert.equal(severityOf(incident('a')).level, 'PROPERTY_DAMAGE');
  assert.equal(severityOf(incident('b', { injuries_y_n: 'Yes' })).level, 'INJURY');
  assert.equal(severityOf(incident('c', { fatalities: 'Yes' })).level, 'FATAL');
  // A fatality outranks an injury rather than being counted as both.
  assert.equal(severityOf(incident('d', { injuries_y_n: 'Yes', fatalities: 'Yes' })).level, 'FATAL');
});

test('a record is positioned at its damaged asset, and says so', () => {
  const fact = incidentFact(incident('INC-1'), index);
  assert.equal(fact.longitude, -80.300);
  assert.equal(fact.latitude, 26.100);
  assert.ok(fact.locationSource);
  // The cause category is carried, but never as a cause.
  assert.equal(fact.rootCauseCategory, 'Driver behavior');
});

test('provenance counts what is in hand and refuses the words "crash rate"', () => {
  const provenance = provenanceOf(facts());
  assert.equal(provenance.records, 4);
  assert.equal(provenance.firstMonth, '2025-03');
  assert.equal(provenance.lastMonth, '2025-04');
  assert.equal(provenance.confirmed, 3, 'the three records carrying a police report number');
  assert.match(provenance.locationBasis, /not at a surveyed crash point/);
  assert.match(provenance.statisticalStanding, /not an official crash statistic/);
  assert.doesNotMatch(provenance.statisticalStanding, /crash rate per/i);
});

test('a record with no readable date is dropped rather than given one', () => {
  const read = incidentFacts([incident('INC-1'), { attributes: { code: 'INC-X' } }], index);
  assert.equal(read.length, 1);
});

/* ============================================================================================
   2. Patterns
   ============================================================================================ */

test('the profiles cover every bucket, so an empty hour reads as zero rather than missing', () => {
  const read = facts();
  assert.equal(hourlyProfile(read).length, 24);
  assert.equal(weekdayProfile(read).length, 7);
  assert.equal(hourlyProfile(read).reduce((sum, row) => sum + row.count, 0), read.length);
  // Months between the first and last are present even when nothing happened in them.
  const trend = monthlyTrend(read);
  assert.deepEqual(trend.map(row => row.label), ['2025-03', '2025-04']);
});

test('severity mix adds up, and its index is called a local weighting', () => {
  const mix = severityMix(facts());
  assert.equal(mix.fatal + mix.injury + mix.propertyDamage, mix.total);
  assert.equal(mix.fatal, 1);
  assert.equal(mix.injury, 1);
  assert.equal(mix.index, Number(((3 + 2 + 1 + 1) / 4).toFixed(2)));
});

test('a condition is reported beside its share of the whole corpus, as an association', () => {
  const read = facts();
  const subset = read.filter(fact => fact.severity.rank >= 2);
  const breakdown = conditionBreakdown(subset, read);
  const rain = breakdown.weather.find(row => row.label === 'Rain');
  assert.ok(rain.corpusShare > 0, 'the whole-corpus share is carried');
  assert.ok(rain.lift > 0, 'over-represented in the severe subset');
  assert.match(breakdown.caveat, /not a demonstrated cause/);
});

test('closure exposure only sums the durations that exist', () => {
  const exposure = closureExposure(facts());
  assert.equal(exposure.withClosure, 3);
  assert.equal(exposure.hoursRecorded, 3);
  assert.equal(exposure.totalHours, 4.5);
});

/* ============================================================================================
   3. Hotspots
   ============================================================================================ */

test('records cluster by distance, and the cluster says its positions are asset-derived', () => {
  const found = findHotspots(facts(), { radiusMeters: 250, minimumRecords: 2 });
  assert.ok(found.clusters.length >= 1);
  const [cluster] = found.clusters;
  assert.ok(cluster.records >= 2);
  assert.match(cluster.locationBasis, /not a surveyed crash location/);
  assert.match(found.caveat, /asset-derived/);
  // Every clustered record is counted exactly once.
  assert.equal(found.clustered + found.unclustered, found.located);
});

test('a cluster below the minimum is not a cluster', () => {
  const found = findHotspots(facts(), { radiusMeters: 1, minimumRecords: 3 });
  assert.equal(found.clusters.length, 0);
  assert.equal(found.clustered, 0);
});

test('distance is metres on the ground, within a per-cent at corridor scale', () => {
  const metres = metresBetween({ longitude: -80.3, latitude: 26.1 }, { longitude: -80.3, latitude: 26.101 });
  assert.ok(Math.abs(metres - 110.6) < 2, `got ${metres}`);
});

test('only records carrying a segment name are grouped by segment', () => {
  const read = incidentFacts([incident('INC-1'), incident('INC-2', { 'segment name': '' })], index);
  const grouped = segmentConcentration(read);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].records, 1);
});

/* ============================================================================================
   4. KPIs — the availability contract
   ============================================================================================ */

test('a KPI that cannot be calculated is reported, not dropped, and names what it needs', () => {
  const read = facts();
  const kpis = accidentKpis(read, provenanceOf(read), { hotspots: findHotspots(read) });
  // Without section profiles there is no exposure to divide by, so the rate is unavailable...
  const perVmt = kpis.find(kpi => kpi.id === 'perVmt');
  assert.equal(perVmt.status, KPI_STATUS.UNAVAILABLE);
  assert.equal(perVmt.value, null);
  assert.match(perVmt.requires, /AADT/i);
  const cost = kpis.find(kpi => kpi.id === 'economicCost');
  assert.equal(cost.status, KPI_STATUS.UNAVAILABLE);
});

test('the exposure rate is reported where AADT exists, and is never called a crash rate', () => {
  const read = facts();
  const sections = sectionProfiles({ sections: buildSections(FDOT), facts: read, days: 730 });
  const kpi = accidentKpis(read, provenanceOf(read), { sections })
    .find(entry => entry.id === 'perVmt');
  // ...and available where it does. Saying "no exposure data exists" was wrong: the corridor's
  // FDOT segments publish AADT, and a count divided by vehicle-miles is a rate.
  assert.equal(kpi.status, KPI_STATUS.AVAILABLE);
  assert.equal(kpi.value, sections.corridorPerHundredMillionVmt);
  assert.match(kpi.label, /Recorded incidents/);
  assert.doesNotMatch(kpi.label, /crash/i);
  assert.match(kpi.basis, /not an FDOT crash rate/);
});

test('every available KPI carries the records it was counted from', () => {
  const read = facts();
  for (const kpi of [...accidentKpis(read, provenanceOf(read)), ...secondaryKpis(read, provenanceOf(read))]) {
    if (kpi.status !== KPI_STATUS.AVAILABLE) continue;
    assert.ok(kpi.basis, `${kpi.id} has no basis`);
    assert.ok(Number.isFinite(kpi.records), `${kpi.id} does not say how many records`);
  }
});

test('no safety KPI claims a rate, a cost or a reduction', () => {
  const read = facts();
  const all = [...accidentKpis(read, provenanceOf(read)), ...secondaryKpis(read, provenanceOf(read)),
    ...assetKpis(assetSafetySummary({ defects: [] }), provenanceOf(read)),
    ...patrolKpis({ hazards: 0, inspections: 0, locations: 0, period: 'x' })];
  for (const kpi of all.filter(kpi => kpi.status === KPI_STATUS.AVAILABLE)) {
    // The LABEL and UNIT are what a reader skims, so neither may name a rate, a cost or a saving.
    // The basis is where a disclaimer belongs ("not a validated secondary-crash rate"), so it is
    // checked for the disclaimer instead of for the words.
    assert.doesNotMatch(`${kpi.label} ${kpi.unit ?? ''}`, /crash rate|per 100 million|vmt|reduction|\$/i,
      `${kpi.id} names something the data does not support`);
    if (/rate|ratio|per 100/i.test(`${kpi.label} ${kpi.unit ?? ''}`)) {
      assert.match(kpi.basis, /not a validated|within this register|local/i,
        `${kpi.id} reads as a rate without saying it is not one`);
    }
  }
});

test('the patrol row reports hazards and refuses every response metric', () => {
  const kpis = patrolKpis({ hazards: 12, inspections: 40, locations: 5, period: '2025' });
  assert.equal(kpis.find(kpi => kpi.id === 'hazardRecords').value, 12);
  for (const id of ['detectionToClearance', 'responseTarget', 'patrolCoverage', 'hazardsPerPatrolHour', 'costPerHazard']) {
    assert.equal(kpis.find(kpi => kpi.id === id).status, KPI_STATUS.UNAVAILABLE, id);
  }
  assert.match(kpis.find(kpi => kpi.id === 'patrolCoverage').requires, /simulated/i);
});

test('coverage reports an absent source as absent rather than as zero records of data', () => {
  const coverage = dataCoverage({
    'Incident register': { records: 178 },
    'Road Ranger activity': { records: 0, note: 'No patrol dataset exists.' },
  });
  assert.equal(coverage.availableSets, 1);
  assert.equal(coverage.totalSets, 2);
  assert.equal(coverage.rows.find(row => row.label === 'Road Ranger activity').available, false);
});

/* ============================================================================================
   5. Secondary incidents — observed and modelled, never mixed
   ============================================================================================ */

test('observed secondary counts the register’s own label and says it is a label', () => {
  const observed = observedSecondary(facts());
  assert.equal(observed.count, 2);
  assert.equal(observed.corpus, 4);
  assert.match(observed.caveat, /not an investigated finding/);
  assert.equal(observed.kind, 'OBSERVED');
});

test('co-occurring records are reported as co-occurrence, with same-position called out', () => {
  const read = incidentFacts([
    incident('INC-1', { incident_time: '08:00' }),
    incident('INC-2', { incident_time: '08:30', root_cause_category: 'Secondary collision' }),
  ], index);
  const found = coOccurrences(read, { withinMeters: 500, withinMinutes: 60 });
  assert.equal(found.count, 1);
  assert.equal(found.pairs[0].minutesApart, 30);
  assert.equal(found.pairs[0].samePosition, true, 'both sit on asset A1');
  assert.equal(found.labelledSecondary, 1);
  assert.match(found.caveat, /shared asset, not a measured distance/);
});

test('the modelled side reads the TMC’s own live assessments and is null without them', () => {
  assert.equal(modelledRisk(null), null);
  const modelled = modelledRisk([{ risk: { level: 'SEVERE' } }, { risk: { level: 'LOW' } }, {}]);
  assert.equal(modelled.count, 2, 'an unscored entry is not counted');
  assert.equal(modelled.elevated, 1);
  assert.match(modelled.basis, /live on the corridor now/);
  assert.match(modelled.caveat, /Never add it/);
});

/* ============================================================================================
   6. Asset safety
   ============================================================================================ */

test('only safety-relevant classes are read, by a stated list', () => {
  assert.equal(isSafetyRelevant('CCTV'), true);
  assert.equal(isSafetyRelevant('Guardrail'), true);
  assert.equal(isSafetyRelevant('Landscaping'), false);
});

test('a work order is overdue only against a target the register itself publishes', () => {
  const orders = [workOrder('WO-1'), workOrder('WO-2', { 'Asset Type': 'Guardrail' })];
  const withoutTargets = safetyDefects({ workOrders: orders, assetIndex: index, now: Date.UTC(2025, 5, 1) });
  assert.equal(withoutTargets.length, 2);
  assert.equal(withoutTargets.every(defect => defect.overdue === false), true);
  assert.equal(withoutTargets[0].targetDays, null);

  const targets = repairTargets([{ attributes: { name: 'CCTV', repair_times_days: 30 } }]);
  const withTargets = safetyDefects({ workOrders: orders, assetIndex: index, targets, now: Date.UTC(2025, 5, 1) });
  const cctv = withTargets.find(defect => defect.assetType === 'CCTV');
  assert.equal(cctv.targetDays, 30);
  assert.equal(cctv.overdue, true, '151 days open against a 30-day target');
  assert.equal(withTargets.find(defect => defect.assetType === 'Guardrail').overdue, false,
    'no target published for guardrails, so nothing is judged');
});

test('a category published twice with different targets is treated as having none', () => {
  const targets = repairTargets([
    { attributes: { name: 'Fence', repair_times_days: 10 } },
    { attributes: { name: 'Fence', repair_times_days: 37 } },
    { attributes: { name: 'Camera', repair_times_days: 37 } },
  ]);
  assert.equal(targets.get('camera'), 37);
  assert.equal(targets.has('fence'), false, 'an ambiguous target must not be guessed');
  assert.deepEqual(targets.conflicts, [{ category: 'fence', published: [10, 37] }]);
});

test('an asset type with no category of its own gets no target rather than the nearest one', () => {
  const targets = repairTargets([{ attributes: { name: 'Lighting - Under Deck', repair_times_days: 37 } }]);
  const defects = safetyDefects({
    workOrders: [workOrder('WO-5', { 'Asset Type': 'Lighting' })],
    assetIndex: index, targets, now: Date.UTC(2025, 5, 1),
  });
  assert.equal(defects[0].targetDays, null);
  assert.equal(defects[0].overdue, false);
});

test('MTTR and the SLA share are null rather than zero when the dates are not there', () => {
  const open = safetyDefects({ workOrders: [workOrder('WO-1')], assetIndex: index, now: Date.UTC(2025, 5, 1) });
  const summary = assetSafetySummary({ defects: open, assetIndex: index });
  assert.equal(summary.mttrDays, null);
  assert.equal(summary.slaShare, null);
  assert.equal(summary.openDefects, 1);
  const kpis = assetKpis(summary, null);
  assert.equal(kpis.find(kpi => kpi.id === 'mttr').status, KPI_STATUS.UNAVAILABLE);
});

test('MTTR is measured from a closed work order’s own two dates', () => {
  const closed = safetyDefects({
    workOrders: [workOrder('WO-9', { 'Close Date': '11/01/2025 00:00' })],
    assetIndex: index, now: Date.UTC(2025, 5, 1),
  });
  assert.equal(closed[0].ageDays, 10);
  assert.equal(assetSafetySummary({ defects: closed, assetIndex: index }).mttrDays, 10);
});

test('a defect inside a concentration is reported as proximity only', () => {
  const read = facts();
  const hotspots = findHotspots(read, { radiusMeters: 250, minimumRecords: 2 });
  const defects = safetyDefects({ workOrders: [workOrder('WO-1')], assetIndex: index, now: Date.UTC(2025, 5, 1) });
  const near = defectsNearHotspots(defects, hotspots.clusters);
  assert.ok(near.length >= 1);
  assert.equal(near[0].relationship, 'PROXIMITY_ONLY');
  assert.match(near[0].caveat, /Proximity is not causation/);
});

/* ============================================================================================
   7. Hazards and patrols
   ============================================================================================ */

test('a hazard field is read in the vocabulary the forms actually use', () => {
  const ok = hazardObservation(inspection('I-1'));
  assert.equal(ok.hazardCount, 0);
  const issue = hazardObservation(inspection('I-2', { debris_in_travel_lanes: 'Issue',
    clear_zone_hazards: 'Issue', inspection_result: 'Fail', risk_rating_1_5: 5 }));
  assert.equal(issue.hazardCount, 2);
  assert.equal(issue.failed, true);
  assert.equal(issue.riskRating, 5);
});

test('hazard evidence groups by place and never calls itself a patrol log', () => {
  const evidence = hazardEvidence([
    inspection('I-1'),
    inspection('I-2', { debris_in_travel_lanes: 'Issue' }),
    inspection('I-3', { clear_zone_hazards: 'Issue', 'segment name': 'Segment 7' }),
  ]);
  assert.equal(evidence.inspections, 3);
  assert.equal(evidence.hazards, 2);
  assert.equal(evidence.locations, 2);
  assert.match(evidence.caveat, /not a patrol log/);
});

test('deployment hints point at evidence and claim no outcome', () => {
  const read = facts();
  const hints = deploymentHints({
    hazards: hazardEvidence([inspection('I-2', { debris_in_travel_lanes: 'Issue' })]),
    hotspots: findHotspots(read, { radiusMeters: 250, minimumRecords: 2 }),
    facts: read,
  });
  assert.ok(hints.hints.length >= 1);
  assert.equal(hints.hints.every(hint => hint.claimsNoOutcome), true);
  assert.match(hints.caveat, /no reduction in incidents is claimed/);
  assert.equal(PATROL_DATA_GAPS.length, 4);
});

/* ============================================================================================
   8. The priority queue
   ============================================================================================ */

const queueInput = () => {
  const read = facts();
  const hotspots = findHotspots(read, { radiusMeters: 250, minimumRecords: 2 });
  const targets = repairTargets([{ attributes: { name: 'CCTV', repair_times_days: 30 } }]);
  return {
    hotspots,
    defects: safetyDefects({ workOrders: [workOrder('WO-1')], assetIndex: index, targets, now: Date.UTC(2025, 5, 1) }),
    hazards: hazardEvidence([inspection('I-2', { debris_in_travel_lanes: 'Issue', inspection_result: 'Fail' })]),
    observedSecondary: observedSecondary(read),
  };
};

test('no entry carries a composite score, and the methodology says why', () => {
  const queue = buildPriorityQueue(queueInput());
  assert.ok(queue.total > 0);
  for (const entry of queue.entries) {
    assert.equal(entry.score, null, `${entry.id} has a score`);
    assert.ok(entry.rule, `${entry.id} does not say why it is listed`);
    assert.ok(Object.values(URGENCY).some(band => band.id === entry.urgency.id));
  }
  assert.match(queue.methodology.noCompositeScore, /no validated weighting/i);
});

test('a fatal record puts its concentration in the immediate band, by a stated rule', () => {
  const queue = buildPriorityQueue(queueInput());
  const hotspotEntry = queue.entries.find(entry => entry.domain.id === 'ACCIDENT');
  assert.equal(hotspotEntry.urgency.id, 'IMMEDIATE');
  assert.match(hotspotEntry.rule, /fatal/i);
});

test('two domains agreeing annotates one entry rather than adding another', () => {
  const input = queueInput();
  const annotated = buildPriorityQueue(input);
  const plain = buildPriorityQueue({ ...input, includeCrossDomain: false });
  assert.equal(annotated.total, plain.total, 'agreement must not inflate the queue');
  assert.equal(annotated.byDomain.CROSS, undefined, 'CROSS is a filter, not a domain of entries');
  const agreeing = annotated.entries.filter(entry => entry.agrees);
  assert.ok(agreeing.length >= 1);
  assert.match(agreeing[0].agreementNote, /not evidence that one caused the other/);
});

test('cross-domain links are symmetric and never pair an entry with its own domain', () => {
  const entries = withCrossDomainLinks([
    { id: 'a', domain: { id: 'ASSET', label: 'Asset condition' }, longitude: -80.3, latitude: 26.1 },
    { id: 'b', domain: { id: 'HAZARD', label: 'Inspection findings' }, longitude: -80.3, latitude: 26.1 },
    { id: 'c', domain: { id: 'ASSET', label: 'Asset condition' }, longitude: -80.3, latitude: 26.1 },
  ]);
  assert.equal(entries[0].agrees, 1);
  assert.equal(entries[1].agrees, 1);
  assert.equal(entries[1].alsoFlaggedBy[0].findings, 2, 'both asset entries are counted in the link');
  assert.equal(entries[0].alsoFlaggedBy.some(other => other.domain === 'Asset condition'), false);
});

test('an asset entry with no published target says so instead of being judged', () => {
  const defects = safetyDefects({ workOrders: [workOrder('WO-7', { 'Asset Type': 'Guardrail' })],
    assetIndex: index, now: Date.UTC(2025, 5, 1) });
  const queue = buildPriorityQueue({ defects });
  const entry = queue.entries.find(row => row.domain.id === 'ASSET');
  assert.match(entry.caveat, /No repair-time target is published/);
});

/* ============================================================================================
   9. Replay
   ============================================================================================ */

test('the timeline comes from the records, and the dwell window is declared a display choice', () => {
  const timeline = buildTimeline(facts(), { speedId: 'week' });
  assert.equal(timeline.empty, false);
  assert.equal(timeline.records, 4);
  assert.ok(timeline.steps >= 5);
  assert.match(timeline.dwellNote, /display choice/);
});

test('a frame is deterministic and cumulative counts never go backwards', () => {
  const read = facts();
  const timeline = buildTimeline(read, { speedId: 'week' });
  const first = frameAt(read, timeline, 3);
  assert.deepEqual(frameAt(read, timeline, 3).cumulative.map(fact => fact.id),
    first.cumulative.map(fact => fact.id));
  let previous = -1;
  for (const row of replaySeries(read, timeline)) {
    assert.ok(row.cumulative >= previous, 'cumulative fell');
    previous = row.cumulative;
  }
  assert.equal(replaySeries(read, timeline).at(-1).cumulative, read.length);
});

test('an empty register replays as empty rather than as a single empty frame of data', () => {
  const timeline = buildTimeline([], { speedId: 'week' });
  assert.equal(timeline.empty, true);
  assert.equal(frameAt([], timeline, 0).cumulativeCount, 0);
});

test('two compared windows report a difference and refuse to call it an improvement', () => {
  const read = facts();
  const span = 30 * 86_400_000;
  const comparison = compareWindows(read, { fromMs: read[0].when.ms, toMs: read[0].when.ms + span, spanMs: span });
  assert.equal(comparison.earlier.records + comparison.later.records <= read.length, true);
  assert.match(comparison.caveat, /not evidence that the corridor became safer/);
});

/* ============================================================================================
   10. The screen's own words
   ============================================================================================ */

const screenContext = () => {
  const read = facts();
  const provenance = provenanceOf(read);
  const hotspots = findHotspots(read, { radiusMeters: 250, minimumRecords: 2 });
  const queue = buildPriorityQueue(queueInput());
  return {
    provenance,
    records: read.length,
    concentrations: hotspots.clusters.map(cluster => ({ id: cluster.id, label: cluster.label,
      records: cluster.records, severeRecords: cluster.severeRecords,
      confirmationRate: cluster.confirmationRate, dominantType: cluster.dominantType })),
    hotspotCaveat: hotspots.caveat,
    queue: queue.entries.map(entry => ({ id: entry.id, title: entry.title, domain: entry.domain.label,
      urgency: entry.urgency.label, rule: entry.rule, counted: `${entry.quantity} ${entry.quantityLabel}` })),
    queueMethodology: queue.methodology,
    secondary: { observedRecords: 2, caveat: observedSecondary(read).caveat, modelledElevated: null,
      distinction: 'Observed counts and modelled risk answer different questions.' },
    assetSafety: assetSafetySummary({ defects: [], assetIndex: index }),
    hazards: { findings: 2, locations: 1, caveat: 'Not a patrol log.' },
    unavailable: [{ label: 'Accidents per 100M VMT', requires: 'Traffic volume' }],
  };
};

test('every panel renders, escapes its text and prints the caveat beside the number', () => {
  const read = facts();
  const provenance = provenanceOf(read);
  const hotspots = findHotspots(read, { radiusMeters: 250, minimumRecords: 2 });
  const html = accidentPanel({
    provenance, hotspots, trend: monthlyTrend(read), hourly: hourlyProfile(read),
    weekday: weekdayProfile(read), severity: severityMix(read),
    types: tally(read, fact => fact.type), conditions: conditionBreakdown(read, read),
  });
  assert.match(html, /not an official crash statistic/);
  assert.match(html, /asset-derived/i);
  assert.match(html, /not a demonstrated cause/);
});

test('the header shows only KPIs that have a number — never a dash standing in for one', () => {
  const read = facts();
  const kpis = accidentKpis(read, provenanceOf(read));
  const html = kpiRow(kpis, { title: 'Accident analysis' });
  assert.match(html, /Incident records/);
  // The uncalculable ones are absent from the header entirely rather than shown as an em dash.
  assert.doesNotMatch(html, /Accidents per 100M VMT/);
  assert.doesNotMatch(html, /Not available/);
  assert.doesNotMatch(html, /<script/i);
  assert.equal((html.match(/class="si-kpi"/g) ?? []).length,
    kpis.filter(kpi => kpi.status === KPI_STATUS.AVAILABLE).length);
});

test('but every uncalculable KPI is accounted for in the coverage disclosure', () => {
  const read = facts();
  const unavailable = accidentKpis(read, provenanceOf(read))
    .filter(kpi => kpi.status !== KPI_STATUS.AVAILABLE)
    .map(kpi => ({ label: kpi.label, requires: kpi.requires }));
  assert.ok(unavailable.length, 'this corpus cannot calculate everything');
  const html = coveragePanel(dataCoverage({ 'Incident register': { records: 178 } }), { unavailable });
  assert.match(html, /What cannot be calculated from them/);
  assert.match(html, /Economic cost/);
  assert.match(html, /Needs: A cost model/);
});

test('a malicious field value cannot reach the page as markup', () => {
  const read = incidentFacts([incident('INC-1', { incident_type: '<img src=x onerror=alert(1)>' })], index);
  const html = accidentPanel({
    provenance: provenanceOf(read), hotspots: findHotspots(read), trend: monthlyTrend(read),
    hourly: hourlyProfile(read), weekday: weekdayProfile(read), severity: severityMix(read),
    types: tally(read, fact => fact.type), conditions: conditionBreakdown(read, read),
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test('the queue panel offers agreement as a filter and prints the ordering method', () => {
  const queue = buildPriorityQueue(queueInput());
  const html = queuePanel(queue, {});
  assert.match(html, /How this list is ordered/);
  assert.match(html, /no validated weighting/i);
  if (queue.agreeing) assert.match(html, /two domains/);
});

test('the investigation answers what the removed detail pane used to', () => {
  // The queue's detail pane is gone: it only ever showed an empty prompt, because choosing an entry
  // switches the panel to the investigation. The investigation must still say what is here, what it
  // rests on and what to do — in more depth than the pane did.
  const read = facts();
  const sections = sectionProfiles({ sections: buildSections(FDOT), facts: read, days: 730 });
  const selection = selectSection(sections.rows[0].section);
  const scoped = scopedFacts(selection, { facts: read, sections });
  const html = investigationPanel(investigate(selection, { scoped, sections, allFacts: read }));
  assert.match(html, /What the records show here/);
  assert.match(html, /Related safety concerns/);
  assert.match(html, /What to investigate next/);
  assert.match(html, /Evidence/);
  assert.match(html, /asset-derived/);
});

test('a queue row carries its own reason, so the removed pane is not needed to read the list', () => {
  const queue = buildPriorityQueue(queueInput());
  const html = queuePanel(queue, {});
  // Each row prints the rule that put it there and what it counts.
  assert.match(html, /si-queue-rule/);
  assert.match(html, new RegExp(escapeHtmlRe(queue.entries[0].rule.slice(0, 30))));
  assert.match(html, /How this list is ordered/);
});

test('the replay bar is controls only; the dwell is explained in the disclosure', () => {
  const read = facts();
  const timeline = buildTimeline(read);
  const bar = replayBar(timeline, frameAt(read, timeline, 2), {});
  assert.match(bar, /si-scrub/);
  assert.doesNotMatch(bar, /display choice/, 'the explanation belongs in the disclosure');
  assert.match(coveragePanel(dataCoverage({ x: { records: 1 } }), { notes: [timeline.dwellNote] }),
    /display choice/);
  const html = outcomesPanel({ comparison: null, requirements: OUTCOME_REQUIREMENTS });
  assert.match(html, /no reduction is claimed/);
  assert.match(coveragePanel(dataCoverage({ 'Road Ranger activity': { records: 0 } })), /not available/);
});

/* ============================================================================================
   11. The chat answers from the screen, with the screen's caveats
   ============================================================================================ */

test('a safety question routes to one intent, or to none at all', () => {
  assert.equal(parseSafetyQuestion('Where do incident records concentrate?'), 'hotspots');
  assert.equal(parseSafetyQuestion('What is at the top of the safety priority queue?'), 'queue');
  assert.equal(parseSafetyQuestion('How many incidents were recorded as secondary?'), 'secondary');
  assert.equal(parseSafetyQuestion('Which defects are overdue?'), 'assets');
  assert.equal(parseSafetyQuestion('What can this screen not tell me?'), 'gaps');
  assert.equal(parseSafetyQuestion('Fly to bridge 860384'), null);
});

test('every safety answer carries the caveat that belongs to its number', () => {
  const context = screenContext();
  assert.match(answerSafetyQuestion('hotspots', context).answer, /asset-derived/);
  assert.match(answerSafetyQuestion('queue', context).answer, /no validated weighting/i);
  assert.match(answerSafetyQuestion('secondary', context).answer, /not an investigated finding/);
  assert.match(answerSafetyQuestion('hazards', context).answer, /No Road Ranger dataset/);
  assert.match(answerSafetyQuestion('gaps', context).answer, /Traffic volume/);
  assert.equal(answerSafetyQuestion('hotspots', null), null);
});

test('an answer about repairs says when a number cannot be calculated rather than reporting zero', () => {
  const context = screenContext();
  const answer = answerSafetyQuestion('assets', context).answer;
  assert.match(answer, /Mean time to repair cannot be calculated/);
  assert.match(answer, /No repair-time targets are published|open beyond the repair-time target/);
});

test('an agreement note names the other domain and how many findings it has', () => {
  const [entry] = withCrossDomainLinks([
    { id: 'a', domain: { id: 'ACCIDENT', label: 'Incident records' }, longitude: -80.3, latitude: 26.1 },
    { id: 'b', domain: { id: 'HAZARD', label: 'Inspection findings' }, longitude: -80.3, latitude: 26.1 },
  ]);
  assert.match(entry.agreementNote, /^Within 300 m: 1 from inspection findings\./);
  assert.doesNotMatch(entry.agreementNote, /undefined/);
});

test('a hazard place is named by whatever the record carries, never "unnamed"', () => {
  const evidence = hazardEvidence([
    inspection('I-1', { debris_in_travel_lanes: 'Issue', 'segment name': '', asset_id: 'A9' }),
    inspection('I-2', { clear_zone_hazards: 'Issue', 'segment name': '', asset_id: '' }),
  ]);
  assert.equal(evidence.places.length, 2);
  for (const place of evidence.places) {
    assert.doesNotMatch(place.label, /unnamed/i);
    assert.ok(place.label.length > 0);
  }
  assert.equal(evidence.places.some(place => place.label === 'Asset A9'), true);
});

test('the outcomes row is entirely unavailable, so its header is empty and its panel speaks', () => {
  const kpis = outcomeKpis(OUTCOME_REQUIREMENTS);
  assert.equal(kpis.length, OUTCOME_REQUIREMENTS.length);
  assert.equal(kpis.every(kpi => kpi.status === KPI_STATUS.UNAVAILABLE), true);
  assert.equal(kpis.every(kpi => kpi.value === null && kpi.requires), true);
  // No tiles at all rather than a row of dashes — the Outcomes panel states every requirement.
  assert.equal(kpiRow(kpis, { title: 'Performance and outcomes' }), '');
  assert.match(outcomesPanel({ comparison: null, requirements: OUTCOME_REQUIREMENTS }),
    /crash-modification factor/);
});

/* ============================================================================================
   12. The unified selection model, and the scopes it implies
   ============================================================================================ */

test('one selection carries its parent section, and a record never becomes the scope', () => {
  const read = facts();
  const section = { id: 'MP0.0-4.2', label: 'MP 0.0–4.2', carriageway: 'BOTH' };
  const sectionSelection = selectSection(section);
  assert.equal(sectionSelection.scope, SCOPES.SECTION);
  assert.equal(sectionSelection.sectionId, 'MP0.0-4.2');

  const recordSelection = selectIncident(read[0], { sectionId: 'MP0.0-4.2' });
  assert.equal(recordSelection.selectionType, SELECTION_TYPES.INCIDENT);
  // The record's SCOPE is RECORD but it keeps the section, which is what stops one incident's
  // figures replacing the stretch it happened on.
  assert.equal(recordSelection.scope, SCOPES.RECORD);
  assert.equal(recordSelection.sectionId, 'MP0.0-4.2');
});

test('scope resolution gives the section’s records for a record selection, not the one record', () => {
  const read = facts();
  const sections = { byId: new Map([['S1', { section: { label: 'MP 0.0–4.2' }, facts: read }]]) };
  const scoped = scopedFacts(selectIncident(read[0], { sectionId: 'S1' }), { facts: read, sections });
  assert.equal(scoped.facts.length, read.length, 'the stretch stays whole');
  assert.equal(scoped.scope, SCOPES.SECTION);
  assert.equal(scopedFacts(selectNothing(), { facts: read }).facts.length, read.length);
});

test('a hotspot selection narrows to its own records and says so', () => {
  const read = facts();
  const hotspots = findHotspots(read, { radiusMeters: 250, minimumRecords: 2 });
  const scoped = scopedFacts(selectHotspot(hotspots.clusters[0]), { facts: read, hotspots });
  assert.equal(scoped.scope, SCOPES.PLACE);
  assert.ok(scoped.facts.length < read.length || hotspots.clusters[0].records === read.length);
  assert.match(scoped.basis, /concentration/);
});

/* ============================================================================================
   13. Corridor sections and exposure
   ============================================================================================ */

const FDOT = {
  type: 'FeatureCollection',
  features: [
    { properties: { segment_id: 'EB-1', direction: 'EB', begin_post: 0, end_post: 2, aadt: 100000,
      aadt_year: 2025, desc_from: 'A', desc_to: 'B' },
      geometry: { type: 'LineString', coordinates: [[-80.300, 26.100], [-80.280, 26.100]] } },
    { properties: { segment_id: 'WB-1', direction: 'WB', begin_post: 0, end_post: 2, aadt: 100000,
      aadt_year: 2025 },
      geometry: { type: 'LineString', coordinates: [[-80.300, 26.1005], [-80.280, 26.1005]] } },
  ],
};

test('both carriageways of a milepost range are one section, with the AADT counted once', () => {
  const [section] = buildSections(FDOT);
  assert.equal(buildSections(FDOT).length, 1, 'EB and WB are one section');
  assert.equal(section.aadt, 100_000, 'the two-way count is taken once, not summed');
  assert.equal(section.carriageway, 'BOTH');
  assert.match(section.carriagewayBasis, /not verified/i);
  assert.equal(section.lengthMiles, 2);
  assert.equal(exposureOf(section, 730), 100_000 * 2 * 730);
  assert.equal(exposureOf({ aadt: null, lengthMiles: 2 }, 730), null, 'no AADT, no exposure');
});

test('a record is assigned to the nearest section, and one far from the road is left out', () => {
  const sections = buildSections(FDOT);
  assert.equal(sectionFor({ longitude: -80.290, latitude: 26.1002 }, sections).section.id, sections[0].id);
  // Well over a kilometre away: a ramp or an asset set back from the road, not this section.
  assert.equal(sectionFor({ longitude: -80.290, latitude: 26.130 }, sections), null);
  assert.equal(sectionFor({ longitude: null, latitude: null }, sections), null);
});

test('the rate is per 100M vehicle-miles, and is never called a crash rate', () => {
  const sections = buildSections(FDOT);
  const read = incidentFacts([incident('INC-1'), incident('INC-2', { damaged_asset_id: 'A2' })], index);
  const profiles = sectionProfiles({ sections, facts: read, days: 730 });
  const [row] = profiles.rows;
  assert.equal(row.records, 2);
  const expected = Number(((2 / (100_000 * 2 * 730)) * 100_000_000).toFixed(1));
  assert.equal(row.perHundredMillionVmt, expected);
  assert.match(profiles.assumptions.countNote, /not reported crashes/);
  assert.match(profiles.assumptions.countNote, /must not be read as, or compared with, an FDOT crash rate/);
});

test('records that fall outside every section are reported, not reassigned', () => {
  const sections = buildSections(FDOT);
  const far = incidentFacts([incident('INC-9', { damaged_asset_id: 'A3' })], index);
  const profiles = sectionProfiles({ sections, facts: far, days: 730 });
  assert.equal(profiles.unassigned.facts.length, 1);
  assert.equal(profiles.assignedRecords, 0);
});

/* ============================================================================================
   14. Recommendations and the investigation
   ============================================================================================ */

test('every recommendation names its evidence, owner, urgency and source records', () => {
  const read = facts();
  const defects = safetyDefects({ workOrders: [workOrder('WO-1')], assetIndex: index, now: Date.UTC(2025, 5, 1) });
  const items = recommendationsFor({ facts: read, defects, label: 'MP 0.0–4.2' });
  assert.ok(items.length, 'four records and an open defect should produce candidates');
  for (const item of items) {
    assert.ok(item.concern && item.evidence && item.action && item.whyItMatters);
    assert.ok(Object.values(OWNERS).includes(item.owner), `${item.id} has no named owner`);
    assert.ok(item.urgency.label && item.confidence.label);
    assert.ok(item.sourceRecords.length, `${item.id} has no traceable record`);
    // The hard rule: nothing predicts a reduction.
    assert.equal(item.claimsNoReduction, true);
    assert.doesNotMatch(`${item.action} ${item.whyItMatters}`, /\b\d+ ?% (reduction|fewer|decrease)/i);
    assert.match(item.successMeasure, /No reduction is predicted/);
  }
});

test('a cross-domain recommendation recommends inspection and denies causation', () => {
  const read = facts();
  const defects = safetyDefects({ workOrders: [workOrder('WO-1')], assetIndex: index, now: Date.UTC(2025, 5, 1) });
  const cross = recommendationsFor({ facts: read, defects, label: 'here' })
    .find(item => item.domain === 'CROSS');
  assert.ok(cross);
  assert.equal(cross.confidence.id, 'ASSOCIATED');
  assert.match(cross.caveat, /Proximity only/);
  assert.match(cross.action, /inspection|look at both/i);
});

test('a defect open over a year asks for validation rather than a crew', () => {
  const old = safetyDefects({
    workOrders: [workOrder('WO-OLD', { 'Work Order Open Date': '01/01/2023 00:00' })],
    assetIndex: index, now: Date.UTC(2025, 5, 1),
  });
  assert.ok(old[0].ageDays > STALE_DEFECT_DAYS);
  const items = recommendationsFor({ facts: [], defects: old, label: 'here' });
  const stale = items.find(item => item.id.startsWith('rec-stale'));
  assert.equal(stale.urgency.id, 'DATA_VALIDATION');
  assert.match(stale.whyItMatters, /never closed/);
  // And the queue agrees: it does not call a 900-day-old record an emergency.
  const queue = buildPriorityQueue({ defects: old });
  assert.equal(queue.entries[0].actionUrgency.id, 'DATA_VALIDATION');
  assert.equal(queue.entries[0].confidence.id, 'UNVERIFIED');
});

test('the investigation keeps the section profile when one record is opened', () => {
  const read = facts();
  const sections = buildSections(FDOT);
  const profiles = sectionProfiles({ sections, facts: read, days: 730 });
  const sectionId = profiles.rows[0].id;
  const selection = selectIncident(read[0], { sectionId });
  const scoped = scopedFacts(selection, { facts: read, sections: profiles });
  const investigation = investigate(selection, { scoped, sections: profiles, allFacts: read });
  // The stretch is reported in full, and the record sits beside it rather than replacing it.
  assert.equal(investigation.summary.records, scoped.facts.length);
  assert.ok(investigation.summary.records > 1);
  assert.equal(investigation.record.fact.id, read[0].id);
  assert.match(investigation.record.scopeNote, /not a live risk score/);
});

test('an incident assessment refuses a live risk score and lists what it cannot know', () => {
  const read = facts();
  const assessment = incidentAssessment(read[0], { allFacts: read });
  assert.equal(assessment.kind, 'HISTORICAL_RECORD');
  assert.ok(assessment.unavailable.length >= 3);
  assert.ok(assessment.unavailable.some(gap => /Verified primary/i.test(gap.field)));
  assert.equal(assessment.recorded.rootCauseCategory, 'Driver behavior');
});

test('verified primary-secondary pairs are null, never zero, and no rate is derived', () => {
  const found = coOccurrences(facts());
  assert.equal(found.verifiedPairs, null, 'absent, not zero');
  assert.match(found.verifiedPairsNote, /no secondary-incident rate is calculated/);
});

test('the queue states the kind of attention wanted, not one urgent band for everything', () => {
  const queue = buildPriorityQueue(queueInput());
  assert.ok(queue.byAction, 'the queue counts by kind of attention');
  for (const entry of queue.entries) {
    assert.ok(entry.actionUrgency?.label, `${entry.id} does not say what kind of attention it wants`);
    assert.ok(entry.owner, `${entry.id} has no owner`);
    assert.ok(entry.confidence?.label, `${entry.id} has no confidence`);
    assert.ok(entry.sourceRecords.length, `${entry.id} has no traceable record`);
    assert.notEqual(entry.actionUrgency.label, 'Look at now');
  }
  const labels = new Set(queue.entries.map(entry => entry.actionUrgency.label));
  assert.ok(labels.size > 1, 'the findings must not all want the same response');
});

test('the investigation panel renders evidence, owners and the no-prediction note', () => {
  const read = facts();
  const sections = sectionProfiles({ sections: buildSections(FDOT), facts: read, days: 730 });
  const selection = selectSection(sections.rows[0].section);
  const scoped = scopedFacts(selection, { facts: read, sections });
  const html = investigationPanel(investigate(selection, { scoped, sections, allFacts: read }));
  assert.match(html, /What to investigate next/);
  assert.match(html, /Who should review it/);
  assert.match(html, /supporting record/);
  assert.match(html, /No reduction in incidents is predicted/);
  assert.match(html, /asset-derived/);
  assert.equal(investigationPanel(null), '');
});

test('the section comparison states every exposure assumption beside the rates', () => {
  const read = facts();
  const sections = sectionProfiles({ sections: buildSections(FDOT), facts: read, days: 730 });
  const html = sectionComparison(sections, {});
  assert.match(html, /per 100 million vehicle-miles/);
  assert.match(html, /not reported crashes/);
  assert.match(html, /two-way count/);
  assert.match(html, /annual average/);
});

test('the chat answers about the selection, and refuses when nothing is selected', () => {
  assert.equal(parseSafetyQuestion('Why is this section high risk?'), 'selected');
  assert.equal(parseSafetyQuestion('What interventions should we consider?'), 'interventions');
  assert.match(answerSafetyQuestion('selected', { investigation: null }).answer, /Nothing is selected/);
  assert.match(answerSafetyQuestion('interventions', { investigation: { recommendations: [] } }).answer,
    /evidence threshold/);
  const answer = answerSafetyQuestion('interventions', {
    investigation: { label: 'MP 0.0–4.2', recommendations: [{ concern: 'c', evidence: 'e', action: 'a',
      owner: 'Traffic Engineering / Safety', urgency: 'Planned engineering assessment',
      confidence: 'Observed in the records', caveat: null }] },
  }).answer;
  assert.match(answer, /No reduction in incidents is predicted/);
});

test('a question about concentrations is not mistaken for one about rates', () => {
  // "concent-rate" contains "rate": an unanchored pattern sent every hotspot question to the
  // section ranking.
  assert.equal(parseSafetyQuestion('Where do incident records concentrate?'), 'hotspots');
  assert.equal(parseSafetyQuestion('Which section has the highest rate?'), 'sections');
});

/* ============================================================================================
   15. Map places — one badge per place, not one mark per finding
   ============================================================================================ */

test('findings within a radius become one place, counted once across all four domains', () => {
  const read = facts();
  const defects = safetyDefects({ workOrders: [workOrder('WO-1')], assetIndex: index, now: Date.UTC(2025, 5, 1) });
  const hazardPlaces = hazardEvidence([inspection('I-2', { debris_in_travel_lanes: 'Issue' })]).places;
  const places = buildPlaces({ facts: read, defects, hazardPlaces, radiusMeters: 250 });
  assert.ok(places.length >= 1);
  assert.ok(places.length < read.length + defects.length + hazardPlaces.length,
    'the point of a place is that it is fewer marks than findings');
  const counted = places.reduce((sum, place) => sum + place.records, 0);
  assert.equal(counted, read.filter(fact => Number.isFinite(fact.longitude)).length,
    'every positioned record belongs to exactly one place');
  assert.match(places[0].countBasis, /Not a count of crashes/);
});

test('a place with a fatal record takes the top band however few findings it has', () => {
  const fatal = incidentFacts([incident('INC-F', { fatalities: 'Yes' })], index);
  const [place] = buildPlaces({ facts: fatal });
  assert.equal(place.band.id, 'SEVERE');
  assert.equal(place.count, 1);
  // And a single property-damage record is not dressed up as a concentration.
  assert.equal(buildPlaces({ facts: incidentFacts([incident('INC-P')], index) })[0].band.id, 'LOW');
});

test('a place lists its members so the map can draw them individually when it is opened', () => {
  const read = facts();
  const defects = safetyDefects({ workOrders: [workOrder('WO-1')], assetIndex: index, now: Date.UTC(2025, 5, 1) });
  const [place] = buildPlaces({ facts: read, defects });
  const members = membersOf(place);
  assert.equal(members.length, place.facts.length + place.defects.length + place.hazards.length);
  assert.ok(members.every(member => Number.isFinite(member.longitude) && member.label));
  assert.ok(members.some(member => member.kind === 'incident'));
});

test('a place scopes by where it is, so changing tab does not change what it means', () => {
  const read = facts();
  const places = buildPlaces({ facts: read, tab: 'accidents' });
  const selection = selectPlace(places[0]);
  assert.ok(selection.anchor.radiusMeters >= 250, 'a place reaches at least the clustering radius');
  const scoped = scopedFacts(selection, { facts: read });
  assert.equal(scoped.scope, SCOPES.PLACE);
  // Every record the place holds is in scope...
  for (const fact of places[0].facts) {
    assert.ok(scoped.facts.some(entry => entry.id === fact.id), `${fact.id} fell out of its own place`);
  }
  // ...and the scope is the same when the reader is on a tab whose badges count something else.
  const secondaryPlaces = buildPlaces({ facts: read, tab: 'secondary' });
  const stillScoped = scopedFacts(selection, { facts: read, places: secondaryPlaces });
  assert.deepEqual(stillScoped.facts.map(fact => fact.id), scoped.facts.map(fact => fact.id));
  assert.match(scoped.basis, /asset-derived/);
});

test('the badges count what the open tab counts, and nothing else', () => {
  const read = facts();
  const defects = safetyDefects({ workOrders: [workOrder('WO-1')], assetIndex: index, now: Date.UTC(2025, 5, 1) });
  const hazardPlaces = hazardEvidence([inspection('I-2', { debris_in_travel_lanes: 'Issue' })]).places;
  const input = { facts: read, defects, hazardPlaces };

  const accidents = buildPlaces({ ...input, tab: 'accidents' });
  assert.equal(placeTotals(accidents, 'accidents').counted, read.length);

  // Secondary shows ONLY the records carrying that category — this is the whole point.
  const secondary = buildPlaces({ ...input, tab: 'secondary' });
  const labelled = read.filter(fact => /secondary/i.test(fact.rootCauseCategory ?? ''));
  assert.equal(placeTotals(secondary, 'secondary').counted, labelled.length);
  assert.ok(labelled.length < read.length, 'the fixture must have non-secondary records too');
  assert.ok(secondary.every(place => place.facts.every(fact =>
    /secondary/i.test(fact.rootCauseCategory ?? ''))), 'a non-secondary record reached the map');

  const assets = buildPlaces({ ...input, tab: 'assets' });
  assert.equal(placeTotals(assets, 'assets').counted, defects.filter(defect => defect.open).length);

  const patrol = buildPlaces({ ...input, tab: 'patrol' });
  assert.equal(placeTotals(patrol, 'patrol').counted,
    hazardPlaces.reduce((sum, place) => sum + place.hazards, 0));
});

test('each tab’s badge total equals that tab’s leading KPI', () => {
  const read = facts();
  const defects = safetyDefects({ workOrders: [workOrder('WO-1')], assetIndex: index, now: Date.UTC(2025, 5, 1) });
  const hazards = hazardEvidence([inspection('I-2', { debris_in_travel_lanes: 'Issue' })]);
  const provenance = provenanceOf(read);
  const summary = assetSafetySummary({ defects, assetIndex: index });
  const input = { facts: read, defects, hazardPlaces: hazards.places };

  const leading = kpis => kpis.find(kpi => kpi.status === KPI_STATUS.AVAILABLE).value;
  assert.equal(placeTotals(buildPlaces({ ...input, tab: 'accidents' }), 'accidents').counted,
    leading(accidentKpis(read, provenance)), 'Accidents: badges vs "Incident records"');
  assert.equal(placeTotals(buildPlaces({ ...input, tab: 'secondary' }), 'secondary').counted,
    leading(secondaryKpis(read, provenance)), 'Secondary: badges vs "Recorded as secondary"');
  assert.equal(placeTotals(buildPlaces({ ...input, tab: 'assets' }), 'assets').counted,
    leading(assetKpis(summary, provenance)), 'Assets: badges vs "Open safety-related defects"');
  assert.equal(placeTotals(buildPlaces({ ...input, tab: 'patrol' }), 'patrol').counted,
    leading(patrolKpis({ hazards: hazards.hazards, inspections: hazards.inspections,
      locations: hazards.locations, period: 'x' })), 'Hazards: badges vs "Hazard observations"');
});

test('a highlighted stretch covers where the findings are, not the whole milepost range', () => {
  const [section] = buildSections(FDOT);
  const points = [{ longitude: -80.292, latitude: 26.1002 }, { longitude: -80.286, latitude: 26.1002 }];
  const stretch = highlightStretch(section, points, { paddingMeters: 120 });
  assert.ok(stretch);
  // The section is two miles; the findings occupy a few hundred metres of it.
  assert.ok(stretch.metres < 1_200, `stretch was ${stretch.metres} m`);
  assert.ok(stretch.metres > 200);
  assert.match(stretch.basis, /not a surveyed extent/);
  // Nothing projects onto the line: no stretch rather than a guess.
  assert.equal(highlightStretch(section, [{ longitude: -80.0, latitude: 27.0 }]), null);
  assert.equal(highlightStretch(null, points), null);
});

test('clipping keeps the line’s own shape between the first and last finding', () => {
  const line = [[-80.30, 26.10], [-80.28, 26.10], [-80.26, 26.10]];
  const clipped = clipLineToPoints(line, [{ longitude: -80.292, latitude: 26.1001 },
    { longitude: -80.286, latitude: 26.1002 }], { paddingMeters: 50 });
  assert.ok(clipped.length >= 2);
  assert.ok(clipped[0][0] > line[0][0], 'starts after the line’s own start');
  assert.ok(clipped.at(-1)[0] < line.at(-1)[0], 'ends before the line’s own end');
});

test('every question the screen suggests is answered deterministically, never by the model', () => {
  // A suggested question that matches no intent falls through to the language model — which is the
  // one route these answers exist to avoid, and which fails outright when the key is rejected.
  for (const question of SAFETY_SUGGESTIONS) {
    assert.ok(parseSafetyQuestion(question) || parseSimulationQuestion(question),
      `"${question}" is offered to the operator but has no handler`);
  }
  for (const question of SIMULATION_SUGGESTIONS) {
    assert.ok(parseSimulationQuestion(question) || parseSafetyQuestion(question),
      `"${question}" is offered to the operator but has no handler`);
  }
});

test('a record chosen inside an open place keeps that place’s scope, not the section’s', () => {
  // Opening a place scoped the panels to its handful of records; choosing one of those records then
  // widened them to the whole milepost range, while the map carried on showing the place open. The
  // screen said two different things about what it was describing.
  const read = facts();
  const places = buildPlaces({ facts: read, tab: 'accidents' });
  const place = places.find(entry => entry.records > 1) ?? places[0];
  const sections = { byId: new Map([['S1', { section: { label: 'MP 0–4' }, facts: read }]]) };

  const placeSelection = selectPlace(place, { sectionId: 'S1' });
  const placeScope = scopedFacts(placeSelection, { facts: read, places, sections });

  const member = place.facts[0];
  const withAnchor = scopedFacts(selectIncident(member, { sectionId: 'S1',
    anchor: placeSelection.anchor, anchorLabel: place.label }), { facts: read, places, sections });
  assert.equal(withAnchor.facts.length, placeScope.facts.length,
    'selecting a record inside the place changed how many records the panels describe');
  assert.equal(withAnchor.label, place.label, 'the scope is still named after the place');

  // Without an open place, a record still keeps its SECTION context — that part was always right.
  const withoutAnchor = scopedFacts(selectIncident(member, { sectionId: 'S1' }),
    { facts: read, places, sections });
  assert.equal(withoutAnchor.facts.length, read.length);
  assert.equal(withoutAnchor.scope, SCOPES.SECTION);
});

test('an asset or hazard inside an open place keeps the place’s scope too', () => {
  const read = facts();
  const places = buildPlaces({ facts: read, tab: 'accidents' });
  const place = places.find(entry => entry.records > 1) ?? places[0];
  const anchor = selectPlace(place).anchor;
  const defects = safetyDefects({ workOrders: [workOrder('WO-1')], assetIndex: index,
    now: Date.UTC(2025, 5, 1) });
  const scoped = scopedFacts(selectAsset(defects[0], { anchor, anchorLabel: place.label }),
    { facts: read, places });
  assert.equal(scoped.scope, SCOPES.PLACE);
  assert.equal(scoped.label, place.label);
});
