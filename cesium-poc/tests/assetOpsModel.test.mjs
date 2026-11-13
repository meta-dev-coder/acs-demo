/**
 * The Asset Operations & Maintenance model.
 *
 * The point of most of these is the honesty rules rather than the arithmetic: a proximity match is
 * never a confirmed one, a figure the data cannot support is unavailable rather than zero, and a
 * record a dimension cannot read is counted under "Not recorded" rather than dropped.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  ASSOCIATION, CANDIDATE_RADIUS_M, DISTRIBUTION_DIMENSIONS, assetOperations, associateIncident,
  associateIncidents, associationCounts, dimensionById, distribution, filterIncidents, openRepairs,
  operationsKpis, recordedAtScene, repeatedDamage, segmentOf, severityOf, unresolvedInspections,
} from '../src/maintenance/assetOpsModel.js';

const asset = (id, extra = {}) => [id, { assetId: id, longitude: -80.25, latitude: 26.09, category: 'Lighting', segment: 'Central Segment', ...extra }];
const registry = (...entries) => new Map(entries);

const incident = (id, extra = {}) => ({
  id, title: 'Vehicle collision', assetId: null, segmentName: 'Central Segment',
  createdDate: '2026-01-10', related: {}, raw: {}, ...extra,
});

test('an incident that names an asset the registry carries is CONFIRMED', () => {
  const link = associateIncident(incident('INC-1', { assetId: 'A-1' }), registry(asset('A-1')));
  assert.equal(link.relationship, ASSOCIATION.CONFIRMED);
  assert.equal(link.assetId, 'A-1');
});

test('an incident naming an asset the registry does not carry is UNLINKED, and says which asset', () => {
  const link = associateIncident(incident('INC-2', { assetId: 'GHOST' }), registry(asset('A-1')));
  assert.equal(link.relationship, ASSOCIATION.UNLINKED);
  assert.equal(link.assetId, null);
  assert.match(link.reason, /GHOST/);
});

test('an incident with no asset and no coordinates is UNLINKED, not guessed at', () => {
  const link = associateIncident(incident('INC-3'), registry(asset('A-1')));
  assert.equal(link.relationship, ASSOCIATION.UNLINKED);
  assert.match(link.reason, /no coordinates/);
});

test('a nearby asset is a CANDIDATE, never a confirmed link', () => {
  const link = associateIncident(
    incident('INC-4', { longitude: -80.25, latitude: 26.09 }), registry(asset('A-1')));
  assert.equal(link.relationship, ASSOCIATION.CANDIDATE);
  assert.equal(link.assetId, 'A-1');
  assert.match(link.reason, /not a damaged asset/);
});

test('an asset beyond the candidate radius produces no link at all', () => {
  // ~0.01 degrees of latitude is about 1.1 km, far outside the radius.
  const link = associateIncident(
    incident('INC-5', { longitude: -80.25, latitude: 26.10 }), registry(asset('A-1')));
  assert.equal(link.relationship, ASSOCIATION.UNLINKED);
  assert.match(link.reason, new RegExp(String(CANDIDATE_RADIUS_M)));
});

test('every relationship kind is counted, including the ones with none', () => {
  const counts = associationCounts(associateIncidents(
    [incident('INC-1', { assetId: 'A-1' }), incident('INC-2')], registry(asset('A-1'))));
  assert.deepEqual(counts, { CONFIRMED: 1, INFERRED: 0, CANDIDATE: 0, UNLINKED: 1 });
});

test('repeated damage counts confirmed links only', () => {
  const incidents = [
    incident('INC-1', { assetId: 'A-1' }), incident('INC-2', { assetId: 'A-1' }),
    // Two proximity candidates on the same asset must not add up to a damage pattern.
    incident('INC-3', { longitude: -80.25, latitude: 26.09 }),
    incident('INC-4', { longitude: -80.25, latitude: 26.09 }),
  ];
  const assets = registry(asset('A-1'), asset('A-2', { longitude: -80.25, latitude: 26.09 }));
  const repeated = repeatedDamage(associateIncidents(incidents, assets), assets, incidents);
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].assetId, 'A-1');
  assert.equal(repeated[0].count, 2);
});

test('an inspection is unresolved until a completed work order on the same asset follows it', () => {
  const inspections = [
    { id: 'I-1', status: 'Fail', assetId: 'A-1', createdDate: '2026-01-10' },
    { id: 'I-2', status: 'Fail', assetId: 'A-2', createdDate: '2026-01-10' },
    { id: 'I-3', status: 'Pass', assetId: 'A-3', createdDate: '2026-01-10' },
  ];
  const workOrders = [
    { id: 'W-1', status: 'Completed', assetId: 'A-1', createdDate: '2026-02-01' },
    // Before the inspection, so it cannot be the answer to it.
    { id: 'W-2', status: 'Completed', assetId: 'A-2', createdDate: '2025-12-01' },
  ];
  assert.deepEqual(unresolvedInspections(inspections, workOrders).map(item => item.id), ['I-2']);
});

test('an open work order never clears a failed inspection', () => {
  assert.equal(unresolvedInspections(
    [{ id: 'I-1', status: 'Fail', assetId: 'A-1', createdDate: '2026-01-10' }],
    [{ id: 'W-1', status: 'Open', assetId: 'A-1', createdDate: '2026-02-01' }]).length, 1);
});

test('open repairs are the work orders whose own status is open', () => {
  assert.equal(openRepairs([
    { status: 'Open' }, { status: 'Closed' }, { status: 'In Progress' }, { status: null },
  ]).length, 2);
});

test('severity is derived from the register\'s own fields, worst first', () => {
  assert.equal(severityOf({ related: { fatalities: 1 } }), 'Fatality');
  assert.equal(severityOf({ related: {}, raw: { fatalities: 'Yes' } }), 'Fatality');
  assert.equal(severityOf({ related: { injuries: 'Yes' } }), 'Injury');
  assert.equal(severityOf({ related: { laneClosure: 'Y' } }), 'Lane closure');
  assert.equal(severityOf({ related: {} }), 'Property damage only');
});

test('the register\'s "-" is not a segment name', () => {
  assert.equal(segmentOf({ segmentName: '-' }), null);
  assert.equal(segmentOf({ segmentName: ' Central Segment ' }), 'Central Segment');
});

test('a record the dimension cannot read is counted, not dropped', () => {
  const rows = distribution(
    [incident('a'), incident('b', { title: null }), incident('c', { title: 'Debris' })],
    dimensionById('type'));
  assert.equal(rows.reduce((total, row) => total + row.count, 0), 3);
  assert.ok(rows.some(row => row.value === 'Not recorded' && row.count === 1));
});

test('a severity distribution keeps its declared order, not its counts', () => {
  const rows = distribution([
    { related: {} }, { related: {} }, { related: { fatalities: 1 } },
  ], dimensionById('severity'));
  assert.equal(rows[0].value, 'Fatality');
  assert.equal(rows[1].value, 'Property damage only');
});

test('every dimension has a reader and a unique id', () => {
  assert.equal(new Set(DISTRIBUTION_DIMENSIONS.map(entry => entry.id)).size, DISTRIBUTION_DIMENSIONS.length);
  for (const entry of DISTRIBUTION_DIMENSIONS) assert.equal(typeof entry.of, 'function');
});

test('an unset filter removes nothing, and "Not recorded" selects exactly the unreadable records', () => {
  const incidents = [incident('a'), incident('b', { title: null })];
  assert.equal(filterIncidents(incidents, {}).length, 2);
  assert.deepEqual(
    filterIncidents(incidents, { dimensions: { type: 'Not recorded' } }).map(item => item.id), ['b']);
});

test('the relationship filter reads the association, not the record', () => {
  const incidents = [incident('a', { assetId: 'A-1' }), incident('b')];
  const associations = associateIncidents(incidents, registry(asset('A-1')));
  assert.deepEqual(
    filterIncidents(incidents, { relationship: ASSOCIATION.CONFIRMED }, { associations }).map(item => item.id),
    ['a']);
});

test('the six operational figures carry their basis, and missing evidence is unavailable without the demo', () => {
  const kpis = operationsKpis({ incidents: [incident('a', { assetId: 'A-1' })], assets: registry(asset('A-1')),
    associations: associateIncidents([incident('a', { assetId: 'A-1' })], registry(asset('A-1'))) });
  assert.deepEqual(kpis.map(entry => entry.id),
    ['totalIncidents', 'assetLinked', 'repeatedDamage', 'openRepairs', 'unresolvedInspections', 'missingEvidence']);
  assert.deepEqual(kpis.map(entry => entry.basis),
    ['RECORDED', 'RECORDED', 'DERIVED', 'RECORDED', 'INFERRED', 'DEMO']);
  const evidence = kpis.at(-1);
  assert.equal(evidence.available, false);
  assert.equal(evidence.value, null, 'an uncountable figure is null, never 0');
});

test('with the demonstration on, the evidence figure comes from the case breakdown and is flagged DEMO', () => {
  const kpis = operationsKpis({ demoEnabled: true, demoBreakdown: { missingEvidence: 14, total: 7 } });
  const evidence = kpis.at(-1);
  assert.equal(evidence.value, 14);
  assert.equal(evidence.demo, true);
  assert.match(evidence.note, /no production incident is counted/i);
});

test('asset operations list only the assets a record names', () => {
  const assets = registry(asset('A-1'), asset('A-2'), asset('A-3'));
  const incidents = [incident('i1', { assetId: 'A-1' }), incident('i2', { assetId: 'A-1' })];
  const rows = assetOperations({
    assets, associations: associateIncidents(incidents, assets),
    workOrders: [{ status: 'Open', assetId: 'A-2', priority: 'High' }],
    inspections: [{ status: 'Fail', assetId: 'A-2', createdDate: '2026-01-01' }],
  });
  assert.deepEqual(rows.map(row => row.assetId), ['A-1', 'A-2'], 'A-3 is absent, not healthy');
  assert.equal(rows[0].incidents, 2);
  assert.equal(rows[0].repeated, true);
  assert.equal(rows[1].openRepairs, 1);
  assert.equal(rows[1].unresolvedQc, 1);
});

test('the scene facts read a live row\'s nested attributes as well as a flat export row', () => {
  const flat = recordedAtScene({ related: {}, raw: { weather: 'Clear', lane_closure_duration_hours: '3.5' } });
  const nested = recordedAtScene({ related: {}, raw: { attributes: { weather: 'Clear', lane_closure_duration_hours: '3.5' } } });
  assert.equal(flat.reportedWeather, 'Clear');
  assert.equal(nested.reportedWeather, 'Clear', 'a live DataConnect row nests its columns');
  assert.equal(nested.laneClosureHours, '3.5');
});

test('a field the register leaves empty reads as absent, never as a value', () => {
  const scene = recordedAtScene({ related: {}, raw: { weather: '', vehicle_count: null } });
  assert.equal(scene.reportedWeather, null);
  assert.equal(scene.vehicleCount, null);
});
