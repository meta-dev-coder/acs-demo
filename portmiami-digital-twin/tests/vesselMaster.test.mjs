/**
 * The vessel master and its join to the Dock Report: matching rules on hand-built records, then
 * the built November datasets themselves (public/data/cruise/, produced by
 * `npm run data:cruise` from data/cruise/source and data/cruise/vessel-research).
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  CAPACITY_STATUS, CAPACITY_TYPE, capacityStatusOf, coverageReport, enrichCalls, imoCheckDigitOk, matchVessel,
  normalizeVesselName, validateVesselMaster, vesselIndex,
} from '../src/cruise/vesselMaster.js';
import { importDockReport, isSimulable, coverage } from '../src/cruise/cruiseCalls.js';

const json = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const SOURCE = json('../data/cruise/source/portmiami_november_2026_dock_enriched_all.json');
const MASTER = json('../public/data/cruise/portmiami_vessel_master.json').vessels;
const ENRICHED = json('../public/data/cruise/portmiami_november_2026_enriched.json');
const SIMULATION = json('../public/data/cruise/portmiami_november_2026_simulation.json');
const REPORT = json('../public/data/cruise/portmiami_capacity_coverage_report.json');

const vessel = over => ({
  vessel_id: 'imo-9383936', imo: '9383936', canonical_name: 'Allure of the Seas', aliases: [], operator: 'Royal Caribbean International',
  passenger_capacity: 5718, capacity_type: CAPACITY_TYPE.DOUBLE_OCCUPANCY, capacity_source_url: 'https://example.org/allure.pdf',
  status: 'VERIFIED_OFFICIAL', ...over,
});

// ---- rules ---------------------------------------------------------------------------------------------

test('names normalise exactly: case, punctuation and spacing only', () => {
  assert.equal(normalizeVesselName('MSC  SEASIDE'), normalizeVesselName('Msc Seaside'));
  assert.equal(normalizeVesselName('Explora Iii'), normalizeVesselName('EXPLORA III'));
  assert.equal(normalizeVesselName('Aidadiva'), normalizeVesselName('AIDAdiva'));
  assert.notEqual(normalizeVesselName('Seven Seas Mariner'), normalizeVesselName('Regent Mariner'));
});

test('similar names never match: only exact normalised names and aliases', () => {
  const index = vesselIndex([vessel({}), vessel({ vessel_id: 'imo-9383948', imo: '9383948', canonical_name: 'Oasis of the Seas' })]);
  assert.equal(matchVessel({ ship_name: 'Allure Of The Seas' }, index).vessel.canonical_name, 'Allure of the Seas');
  assert.equal(matchVessel({ ship_name: 'Allure Of The Sea' }, index).vessel, null);
  assert.equal(matchVessel({ ship_name: 'Allure' }, index).vessel, null);
});

test('IMO is preferred when the call carries one', () => {
  const index = vesselIndex([vessel({})]);
  const m = matchVessel({ ship_name: 'Some Other Name', vessel_imo: '9383936' }, index);
  assert.equal(m.method, 'IMO');
  assert.equal(m.vessel.canonical_name, 'Allure of the Seas');
});

test('the master is rejected for duplicate IMOs, colliding names, bad IMOs and unsourced capacities', () => {
  assert.deepEqual(validateVesselMaster([vessel({})]), []);
  assert.match(validateVesselMaster([vessel({}), vessel({ vessel_id: 'x', canonical_name: 'Other' })]).join(), /IMO 9383936 is on two records/);
  assert.match(validateVesselMaster([vessel({}), vessel({ vessel_id: 'y', imo: null, canonical_name: 'ALLURE OF THE SEAS' })]).join(), /belongs to two records/);
  assert.match(validateVesselMaster([vessel({ imo: '9383937' })]).join(), /check digit/);
  assert.match(validateVesselMaster([vessel({ capacity_source_url: null, capacity_source_title: null })]).join(), /without a source/);
  assert.equal(imoCheckDigitOk('9383936'), true);
});

test('an ambiguous name matches nothing', () => {
  const index = vesselIndex([vessel({ aliases: ['Mariner'] }), vessel({ vessel_id: 'imo-9210139', imo: '9210139', canonical_name: 'Seven Seas Mariner', aliases: ['Mariner'] })]);
  const m = matchVessel({ ship_name: 'Mariner' }, index);
  assert.equal(m.vessel, null);
  assert.equal(m.method, 'AMBIGUOUS');
});

test('only a verified double-occupancy / lower-berth capacity is simulable', () => {
  assert.equal(capacityStatusOf(vessel({})), CAPACITY_STATUS.VALIDATED);
  assert.equal(capacityStatusOf(vessel({ capacity_type: CAPACITY_TYPE.LOWER_BERTH })), CAPACITY_STATUS.VALIDATED);
  assert.equal(capacityStatusOf(vessel({ capacity_type: CAPACITY_TYPE.MAXIMUM })), CAPACITY_STATUS.DEFINITION_NOT_COMPARABLE);
  assert.equal(capacityStatusOf(vessel({ capacity_type: CAPACITY_TYPE.UNSPECIFIED })), CAPACITY_STATUS.DEFINITION_NOT_COMPARABLE);
  assert.equal(capacityStatusOf(vessel({ status: 'UNRESOLVED', passenger_capacity: null })), CAPACITY_STATUS.NOT_YET_SOURCED);
  assert.equal(capacityStatusOf(vessel({ status: 'CONFLICT' })), CAPACITY_STATUS.CONFLICT);
  assert.equal(capacityStatusOf(null), CAPACITY_STATUS.UNMATCHED_VESSEL);
});

test('a capacity already on the call that disagrees with the master is flagged, not used', () => {
  const [c] = enrichCalls([{ id: 'c', ship_name: 'Allure Of The Seas', passenger_capacity: 6000 }], [vessel({})]);
  assert.equal(c.capacity_status, CAPACITY_STATUS.CONFLICT);
  assert.equal(c.passenger_capacity, null);
  assert.deepEqual(c.capacity_conflict, { master: 5718, original: 6000 });
});

test('a maximum-only capacity is kept and labelled, never passed off as passenger_capacity', () => {
  const [c] = enrichCalls([{ id: 'c', ship_name: 'Allure Of The Seas' }], [vessel({ capacity_type: CAPACITY_TYPE.MAXIMUM, passenger_capacity: 6780 })]);
  assert.equal(c.passenger_capacity, null);
  assert.equal(c.published_capacity, 6780);
  assert.equal(c.capacity_type, 'maximum');
  assert.equal(importDockReport({ cruise_calls: [{ ...c, arrival_datetime_local: '2026-11-03T06:00:00', departure_datetime_local: '2026-11-03T16:00:00' }] }).calls[0].passengerCapacity, null);
});

// ---- the built datasets ----------------------------------------------------------------------------------

test('all 149 original calls are present, once, with every Dock Report field unchanged', () => {
  const calls = ENRICHED.cruise_calls;
  assert.equal(calls.length, SOURCE.cruise_calls.length);
  assert.equal(calls.length, 149);
  assert.equal(new Set(calls.map(c => c.id)).size, 149);
  assert.equal(new Set(calls.map(c => c.dock_request_number)).size, new Set(SOURCE.cruise_calls.map(c => c.dock_request_number)).size);
  const byId = new Map(SOURCE.cruise_calls.map(c => [c.id, c]));
  for (const c of calls) {
    const o = byId.get(c.id);
    for (const k of ['dock_request_number', 'ship_name', 'arrival_datetime_local', 'departure_datetime_local', 'terminal_code', 'berth_movements', 'voyage_options', 'source_pdf_page']) {
      assert.deepEqual(c[k], o[k], `${c.id} ${k}`);
    }
  }
});

test('the vessel master is consistent, and every capacity in it has a source and a definition', () => {
  assert.deepEqual(validateVesselMaster(MASTER), []);
  for (const v of MASTER.filter(x => x.passenger_capacity)) {
    assert.ok(v.capacity_source_url || v.capacity_source_title, v.canonical_name);
    assert.ok(Object.values(CAPACITY_TYPE).includes(v.capacity_type), v.canonical_name);
    assert.ok(['VERIFIED_OFFICIAL', 'VERIFIED_SECONDARY', 'CONFLICT'].includes(v.status), v.canonical_name);
  }
  for (const v of MASTER.filter(x => !x.passenger_capacity)) assert.equal(v.status, 'UNRESOLVED', v.canonical_name);
});

test('every Dock Report ship name resolves to exactly one master record', () => {
  assert.deepEqual(REPORT.unmatched_ship_names, []);
  const names = new Set(SOURCE.cruise_calls.map(c => normalizeVesselName(c.ship_name)));
  assert.equal(REPORT.after.unique_vessels, names.size);
  for (const c of ENRICHED.cruise_calls) assert.equal(c.vessel_match === 'NAME' || c.vessel_match === 'IMO', true, c.ship_name);
});

test('no capacity is a crew or total-persons figure: the quoted figure is the capacity, and it is not the crew count', () => {
  for (const v of MASTER.filter(x => x.passenger_capacity && x.quote)) {
    const n = v.passenger_capacity;
    const figure = new RegExp(`(^|[^\\d,])(${n.toLocaleString('en-US').replace(/,/g, ',?')})(?![\\d,])`);
    const m = v.quote.match(figure);
    assert.ok(m, `${v.canonical_name}: the quote contains ${n}`);
    // A crew figure reads "Crew: 1,440" (label before) or "1,160 crew" (noun right after); a table
    // row's next label ("3,858 Crew: 1,440") is not that.
    const before = v.quote.slice(0, m.index + m[1].length).split(/\s+/).slice(-3).join(' ');
    const next = v.quote.slice(m.index + m[0].length).trim().split(/\s+/)[0] ?? '';
    assert.doesNotMatch(before, /\bcrew\b|total (persons|people)/i, `${v.canonical_name}: "${v.quote}"`);
    assert.doesNotMatch(next, /^crew\b(?!:)/i, `${v.canonical_name}: "${v.quote}"`);
  }
});

test('the earlier fleet-report capacities agree with the master (no silent conflicts)', () => {
  assert.deepEqual(REPORT.after.conflicts, []);
  for (const c of ENRICHED.cruise_calls.filter(x => x.original_passenger_capacity)) {
    assert.equal(c.published_capacity, c.original_passenger_capacity, c.ship_name);
  }
});

test('the simulation dataset is exactly the validated calls, and the loader agrees', () => {
  const validated = ENRICHED.cruise_calls.filter(c => c.capacity_status === CAPACITY_STATUS.VALIDATED);
  assert.deepEqual(SIMULATION.cruise_calls.map(c => c.id), validated.map(c => c.id));
  for (const c of SIMULATION.cruise_calls) {
    assert.ok(c.passenger_capacity > 0);
    assert.ok(['double_occupancy', 'lower_berth'].includes(c.capacity_type));
  }
  const { calls } = importDockReport(ENRICHED);
  assert.equal(calls.filter(isSimulable).length, validated.length);
  const cov = coverage(calls);
  assert.equal(cov.withCapacity, REPORT.after.modelled_calls);
  assert.equal(cov.totalVessels, REPORT.after.unique_vessels);
  assert.equal(cov.modelledVessels, REPORT.after.modelled_vessels);
  assert.ok(REPORT.after.modelled_calls >= REPORT.before.modelled_calls, 'enrichment never loses a modelled call');
});

test('the coverage report agrees with the data', () => {
  assert.deepEqual(coverageReport(ENRICHED.cruise_calls).calls_by_status, REPORT.after.calls_by_status);
  assert.equal(REPORT.before.modelled_calls, 29);
  assert.equal(REPORT.before.modelled_vessels, 8);
});
