/**
 * Historical chain: Incident -> Ticket -> Task(s) -> Work Order -> Inspection for every Bentley
 * historical incident, written only to "SDNA Florida I595 Historical Chain".
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HISTORICAL_CHAIN_CLASS, HISTORICAL_CLASSES, LIVE_CLASS_NAMES, WRITABLE_CLASS_NAMES, isLiveClassName, isWritableClassName,
  sdnaClassDefinition, liveClassDefinitions, validateRecord, unknownAttributes,
} from '../server/liveDc/classes.mjs';
import { assertWritable, WRITER_ERRORS } from '../server/liveDc/dcWriter.mjs';
import {
  CHAIN_STEPS, parseChainDate, daysBetween, pickFollowing, buildHistoricalChains, chainStats, wallToDcDateTime,
} from '../server/liveDc/historicalChain.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readExport = (name) => JSON.parse(readFileSync(join(ROOT, 'public', 'dataconnect-data', `${name}.json`), 'utf8'));
const DAY = 86_400_000;
const wall = (y, m, d, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh, mm);

const incident = (id, date, assetId = null, extra = {}) => ({
  incident_id: id, incident_date: date, incident_time: '04:00', incident_type: 'Vehicle vs barrier',
  injuries_y_n: 'No', fatalities: 0, lane_closure_y_n: 'No', damaged_asset_id: assetId, damaged_asset_description: 'Lighting',
  Segment: 'Central Segment', 'x_coordinate (from asset)': -80.25, 'y_coordinate (from asset)': 26.1, ...extra,
});
const ticket = (id, assetId, date) => ({
  'Ticket ID': id, 'Asset ID': assetId, 'Asset Type': 'Lighting', 'Ticket Opened Date': date, 'Ticket Status': 'Completed',
  Priority: 'Medium', 'Issue Summary': `Lighting - knockdown ${id}`, Segment: 'Central Segment',
});
const task = (id, ticketId, date) => ({
  'Task ID': id, 'Related Ticket ID': ticketId, 'Task Date': date, 'Task Type': 'Inspect and Verify', 'Task Status': 'Closed',
  'Assigned Team': 'Roadway Response',
});
const workOrder = (id, ticketId, taskId, assetId, date) => ({
  'Work Order ID': id, 'Related Ticket ID': ticketId, 'Related Task ID': taskId, 'Asset ID': assetId,
  'Work Order Open Date': date, 'Work Order Status': 'Closed', 'Work Type': 'Field Restoration', Priority: 'Low',
});
const itsInspection = (id, assetId, date) => ({ record_id: id, inspection_id: `INSP-${id}`, asset_id: assetId, date, inspection_result: 'Pass' });
const roadwayInspection = (id, assetId, date) => ({ inspection_id: id, asset_id: assetId, inspection_date: date, inspection_result: 'Fail' });
const safetyInspection = (id, assetId, date) => ({ record_id: id, asset_id: assetId, date, pass_fail: 'Pass' });

const emptySources = () => ({
  incidents: [], tickets: [], tasks: [], workOrders: [], itsInspections: [], roadwayInspections: [], safetyInspections: [],
});
const stepsOf = (rows, incidentId) => rows.filter((r) => r.incident_id === incidentId).sort((a, b) => a.step_order - b.step_order);

describe('parseChainDate', () => {
  test('reads the mixed formats in the data as wall-clock time', () => {
    assert.equal(parseChainDate('2024-05-27T00:00:00'), wall(2024, 5, 27));
    assert.equal(parseChainDate('2024-05-27'), wall(2024, 5, 27));
    assert.equal(parseChainDate('27/05/2024'), wall(2024, 5, 27));
    assert.equal(parseChainDate('07/05/2024 14:30'), wall(2024, 5, 7, 14, 30));
    assert.equal(parseChainDate('7/5/2024 9:05'), wall(2024, 5, 7, 9, 5));
    assert.equal(parseChainDate('2024-05-27T08:15:00.000+00:00'), wall(2024, 5, 27, 8, 15));
    assert.equal(parseChainDate('2024-05-27T08:15:00Z'), wall(2024, 5, 27, 8, 15));
  });

  test('adds a separate time column when the date has no time', () => {
    assert.equal(parseChainDate('2024-05-27T00:00:00', '04:00'), wall(2024, 5, 27, 4));
    assert.equal(parseChainDate('27/05/2024', '01:43:00'), wall(2024, 5, 27, 1, 43));
    assert.equal(parseChainDate('27/05/2024 10:00', '04:00'), wall(2024, 5, 27, 10));
    assert.equal(parseChainDate('27/05/2024', 'garbage'), wall(2024, 5, 27));
  });

  test('refuses invalid dates', () => {
    for (const bad of ['1900-01-00', '1900-01-01', '31/02/2024', '00/05/2024', '2024-13-01', '', null, undefined, 'n/a', 45000, '13/13/2024']) {
      assert.equal(parseChainDate(bad), null, String(bad));
    }
  });

  test('daysBetween counts calendar days', () => {
    assert.equal(daysBetween(wall(2024, 1, 1, 23), wall(2024, 1, 2, 1)), 1);
    assert.equal(daysBetween(wall(2024, 1, 2, 1), wall(2024, 1, 2, 23)), 0);
    assert.equal(daysBetween(wall(2024, 1, 2), wall(2024, 1, 1)), -1);
  });

  test('wallToDcDateTime reads wall time in America/New_York, whole seconds, zoned', () => {
    assert.equal(wallToDcDateTime(wall(2024, 5, 27, 4)), '2024-05-27T08:00:00Z');
    assert.equal(wallToDcDateTime(wall(2024, 1, 15, 4)), '2024-01-15T09:00:00Z');
    assert.equal(wallToDcDateTime(wall(2024, 1, 15, 4) + 1234), '2024-01-15T09:00:01Z');
    assert.equal(wallToDcDateTime(null), null);
  });
});

describe('pickFollowing (the 0-90 day window)', () => {
  const anchor = wall(2024, 3, 1, 12);
  const at = (id, days) => ({ id, when: anchor + days * DAY });
  const pick = (candidates) => pickFollowing(candidates, anchor, { dateOf: (c) => c.when, idOf: (c) => c.id });

  test('window edges: same day and day 90 are in, day -1 and day 91 are out', () => {
    assert.equal(pick([at('A', 0)]).record.id, 'A');
    assert.equal(pick([at('A', 90)]).days, 90);
    assert.equal(pick([at('A', -1)]), null);
    assert.equal(pick([at('A', 91)]), null);
    assert.equal(pick([{ id: 'A', when: anchor - 11 * 3600_000 }]).days, 0, 'earlier on the same calendar day counts as day 0');
  });

  test('earliest wins, then the smaller id', () => {
    assert.equal(pick([at('C', 12), at('B', 30), at('A', 12.2)]).record.id, 'A');
    assert.equal(pick([at('Z', 5), at('Y', 5), at('X', 6)]).record.id, 'Y');
    assert.equal(pick([at('B', 3), at('A', 4)]).record.id, 'B');
  });

  test('candidates without a valid date or anchor are ignored', () => {
    assert.equal(pick([{ id: 'A', when: null }]), null);
    assert.equal(pickFollowing([at('A', 1)], null, { dateOf: (c) => c.when, idOf: (c) => c.id }), null);
  });
});

describe('buildHistoricalChains on fixtures', () => {
  test('real chain: inferred ticket, Bentley task and work order links, inferred inspection', () => {
    const s = emptySources();
    s.incidents = [incident('INC-200001', '2024-03-01T00:00:00', '11563')];
    s.tickets = [
      ticket('TIC-500002', '11563', '2024-03-20T00:00:00'),
      ticket('TIC-500001', '11563', '2024-03-13T00:00:00'),
      ticket('TIC-500003', '99999', '2024-03-02T00:00:00'),
      ticket('TIC-500000', '11563', '2024-02-28T00:00:00'),
    ];
    s.tasks = [task('TSK-700002', 'TIC-500001', '2024-03-14T00:00:00'), task('TSK-700001', 'TIC-500001', '2024-03-13T00:00:00')];
    s.workOrders = [workOrder('WO-900001', 'TIC-500001', 'TSK-700002', '11563', '2024-03-15T00:00:00')];
    s.itsInspections = [itsInspection('ITSV3-1', 11563, '2024-03-10'), itsInspection('ITSV3-2', 11563, '2024-04-01')];
    s.roadwayInspections = [roadwayInspection('INSP-100001', '11563', '2024-03-25T00:00:00')];
    s.safetyInspections = [safetyInspection('SAFE-000001', '11563', '2024-03-25T00:00:00')];

    const { rows } = buildHistoricalChains(s);
    const steps = stepsOf(rows, 'INC-200001');
    assert.deepEqual(steps.map((r) => [r.step, r.record_id, r.link_method, r.confidence, r.is_synthetic]), [
      ['incident', 'INC-200001', 'root', 'High', false],
      ['ticket', 'TIC-500001', 'inferred_same_asset', 'Medium', false],
      ['task', 'TSK-700001', 'bentley_link', 'High', false],
      ['task', 'TSK-700002', 'bentley_link', 'High', false],
      ['work_order', 'WO-900001', 'bentley_link', 'High', false],
      ['inspection', 'INSP-100001', 'inferred_same_asset', 'Medium', false],
    ]);
    assert.deepEqual(steps.map((r) => r.step_order), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(steps.map((r) => r.parent_record_id), ['NA', 'INC-200001', 'TIC-500001', 'TIC-500001', 'TSK-700002', 'WO-900001']);
    assert.deepEqual(steps.map((r) => r.record_class), ['Florida I595 Incidents', 'Florida I595 Tickets', 'Florida I595 Tasks',
      'Florida I595 Tasks', 'Florida I595 Work Orders', 'Florida I595 Roadway Inspections']);
    assert.equal(steps[1].link_detail, 'same asset, ticket 12 d after');
    assert.equal(steps[5].link_detail, 'same asset, inspection 10 d after');
    assert.equal(steps[1].keyInSource, 'CHAIN-INC-200001-2-ticket');
    assert.equal(steps[1].code, steps[1].keyInSource);
    for (const r of steps) {
      assert.equal(r.chain_id, 'CHAIN-INC-200001');
      assert.equal(r.asset_id, '11563');
      assert.equal(r.segment, 'Central Segment');
      assert.deepEqual(r.geometry, { type: 'Point', coordinates: [-80.25, 26.1] });
      assert.equal(r.x_coordinates, -80.25);
      assert.equal(r.y_coordinates, 26.1);
    }
    assert.equal(steps[0].step_date, '2024-03-01T09:00:00Z');
    assert.equal(steps[1].step_date, '2024-03-13T04:00:00Z');
  });

  test('inspection tie on the same day goes to the smaller record id across the three classes', () => {
    const s = emptySources();
    s.incidents = [incident('INC-200001', '2024-03-01T00:00:00', 'A1')];
    s.tickets = [ticket('TIC-1', 'A1', '2024-03-01T00:00:00')];
    s.tasks = [task('TSK-1', 'TIC-1', '2024-03-01T00:00:00')];
    s.workOrders = [workOrder('WO-1', 'TIC-1', 'TSK-1', 'A1', '2024-03-02T00:00:00')];
    s.roadwayInspections = [roadwayInspection('INSP-2', 'A1', '2024-03-05T00:00:00')];
    s.safetyInspections = [safetyInspection('INSP-1', 'A1', '2024-03-05T00:00:00')];
    const steps = stepsOf(buildHistoricalChains(s).rows, 'INC-200001');
    const insp = steps.at(-1);
    assert.equal(insp.record_id, 'INSP-1');
    assert.equal(insp.record_class, 'Florida I595 Safety Inspections');
    assert.equal(insp.link_detail, 'same asset, inspection 3 d after');
  });

  test('incident without an asset: fully synthetic chain with ids from the incident number', () => {
    const s = emptySources();
    s.incidents = [incident('INC-200062', '2024-05-27T00:00:00', null, { injuries_y_n: 'Yes' })];
    const steps = stepsOf(buildHistoricalChains(s).rows, 'INC-200062');
    assert.deepEqual(steps.map((r) => r.record_id), ['INC-200062', 'TIC-SYN-200062', 'TSK-SYN-200062-01', 'TSK-SYN-200062-02',
      'TSK-SYN-200062-03', 'WO-SYN-200062', 'INSP-SYN-200062']);
    assert.deepEqual(steps.map((r) => r.parent_record_id), ['NA', 'INC-200062', 'TIC-SYN-200062', 'TIC-SYN-200062', 'TIC-SYN-200062',
      'TSK-SYN-200062-01', 'WO-SYN-200062']);
    for (const r of steps.slice(1)) {
      assert.equal(r.link_method, 'synthetic');
      assert.equal(r.confidence, 'Synthetic');
      assert.equal(r.is_synthetic, true);
      assert.equal(r.record_class, 'synthetic');
      assert.equal(r.asset_id, 'NA');
      for (const k of ['summary', 'status', 'priority', 'assigned_team', 'work_type', 'inspection_result', 'asset_condition']) {
        assert.equal(typeof r[k], 'string', `${r.record_id} ${k}`);
        assert.notEqual(r[k], '', `${r.record_id} ${k}`);
      }
    }
    const byId = Object.fromEntries(steps.map((r) => [r.record_id, r]));
    assert.equal(byId['TIC-SYN-200062'].priority, 'High');
    assert.deepEqual(['TSK-SYN-200062-01', 'TSK-SYN-200062-02', 'TSK-SYN-200062-03'].map((id) => [byId[id].work_type, byId[id].assigned_team]), [
      ['Dispatch Field Crew', 'Roadway Response'], ['Temporary Mitigation', 'Field Ops A'], ['Inspect and Verify', 'Roadway Response']]);
    assert.equal(byId['INSP-SYN-200062'].inspection_result, 'Pass');
    assert.equal(byId['INSP-SYN-200062'].work_type, 'NA');
    assert.equal(byId['TIC-SYN-200062'].inspection_result, 'NA');
    const dates = steps.map((r) => Date.parse(r.step_date));
    for (let i = 1; i < dates.length; i += 1) assert.ok(dates[i] >= dates[i - 1], `${steps[i].record_id} follows its predecessor`);
    assert.ok(dates.at(-1) - dates[0] <= 30 * DAY);
  });

  test('real ticket without tasks or work order: synthetic task, work order and inspection follow the real ticket', () => {
    const s = emptySources();
    s.incidents = [incident('INC-200005', '2024-03-01T00:00:00', 'S-10001')];
    s.tickets = [ticket('TIC-9', 'S-10001', '2024-03-04T00:00:00')];
    const steps = stepsOf(buildHistoricalChains(s).rows, 'INC-200005');
    assert.deepEqual(steps.map((r) => [r.record_id, r.link_method]), [
      ['INC-200005', 'root'], ['TIC-9', 'inferred_same_asset'],
      ['TSK-SYN-200005-01', 'synthetic'], ['TSK-SYN-200005-02', 'synthetic'], ['TSK-SYN-200005-03', 'synthetic'],
      ['WO-SYN-200005', 'synthetic'], ['INSP-SYN-200005', 'synthetic']]);
    assert.ok(Date.parse(steps[2].step_date) >= Date.parse(steps[1].step_date));
    assert.equal(steps[2].asset_id, 'S-10001');
    assert.equal(steps.at(-2).work_type, 'Corrective Repair');
  });

  test('work order found through the task link only; a synthetic work order can still get a real inspection', () => {
    const s = emptySources();
    s.incidents = [incident('INC-1', '2024-03-01T00:00:00', 'A1'), incident('INC-2', '2024-06-01T00:00:00', 'B1')];
    s.tickets = [ticket('TIC-1', 'A1', '2024-03-02T00:00:00'), ticket('TIC-2', 'B1', '2024-06-01T00:00:00')];
    s.tasks = [task('TSK-1', 'TIC-1', '2024-03-02T00:00:00'), task('TSK-2', 'TIC-2', '2024-06-01T00:00:00')];
    s.workOrders = [workOrder('WO-1', 'TIC-OTHER', 'TSK-1', 'A1', '2024-03-03T00:00:00')];
    s.itsInspections = [itsInspection('ITSV3-B', 'B1', '2024-07-01')];
    const { rows } = buildHistoricalChains(s);
    const one = stepsOf(rows, 'INC-1');
    assert.deepEqual(one.find((r) => r.step === 'work_order'), { ...one.find((r) => r.step === 'work_order'), record_id: 'WO-1', link_method: 'bentley_link', parent_record_id: 'TSK-1' });
    assert.equal(one.at(-1).record_id, 'INSP-SYN-1');
    const two = stepsOf(rows, 'INC-2');
    const wo = two.find((r) => r.step === 'work_order');
    assert.equal(wo.record_id, 'WO-SYN-2');
    assert.equal(wo.parent_record_id, 'TSK-2');
    assert.equal(two.at(-1).record_id, 'ITSV3-B');
    assert.equal(two.at(-1).link_method, 'inferred_same_asset');
    assert.equal(two.at(-1).record_class, 'Florida I595 ITS Inspections');
  });

  test('incident with an invalid date: no inferred links, no step dates, still a full chain', () => {
    const s = emptySources();
    s.incidents = [incident('INC-7', '1900-01-00', 'A1', { incident_time: null })];
    s.tickets = [ticket('TIC-1', 'A1', '2024-03-02T00:00:00')];
    const steps = stepsOf(buildHistoricalChains(s).rows, 'INC-7');
    assert.equal(steps.length, 7);
    assert.equal(steps[1].record_id, 'TIC-SYN-7');
    for (const r of steps) assert.equal('step_date' in r, false, r.record_id);
  });

  test('reads DataConnect curated items (attributes envelope, code, geometry) like the export', () => {
    const s = emptySources();
    s.incidents = [{ keyInSource: 'INC-3', attributes: { code: 'INC-3', incident_date: '01/03/2024', incident_time: '04:00',
      damaged_asset_id: 'A1', Segment: 'East Segment', incident_type: 'Debris' }, geoDetails: { source: { type: 'Point', coordinates: [-80.2, 26.09] } } }];
    s.tickets = [{ keyInSource: 'TIC-1', attributes: { code: 'TIC-1', 'Ticket ID': 'TIC-1', 'Asset ID': 'A1', 'Ticket Opened Date': '05/03/2024 10:00' } }];
    const steps = stepsOf(buildHistoricalChains(s).rows, 'INC-3');
    assert.equal(steps[1].record_id, 'TIC-1');
    assert.equal(steps[1].link_detail, 'same asset, ticket 4 d after');
    assert.deepEqual(steps[0].geometry, { type: 'Point', coordinates: [-80.2, 26.09] });
    assert.equal(steps[0].step_date, '2024-03-01T09:00:00Z');
  });

  test('a Bentley incident id used by several incidents gets one chain per incident, told apart by -DUP<n>', () => {
    const s = emptySources();
    s.incidents = [incident('INC-200063', '2026-01-12T00:00:00', null, { incident_type: 'Debris' }),
      incident('INC-200063', '2024-06-03T00:00:00', 'A1')];
    const { rows } = buildHistoricalChains(s);
    const chains = [...new Set(rows.map((r) => r.chain_id))];
    assert.deepEqual(chains, ['CHAIN-INC-200063', 'CHAIN-INC-200063-DUP2']);
    const first = rows.filter((r) => r.chain_id === chains[0]);
    const second = rows.filter((r) => r.chain_id === chains[1]);
    assert.equal(first[0].step_date, '2024-06-03T08:00:00Z');
    assert.equal(first[0].asset_id, 'A1');
    assert.equal(second[0].record_id, 'INC-200063');
    assert.equal(second[0].incident_id, 'INC-200063');
    assert.match(second[0].link_detail, /shared by 2 incidents/);
    assert.deepEqual(second.slice(1).map((r) => r.record_id), ['TIC-SYN-200063-DUP2', 'TSK-SYN-200063-DUP2-01', 'TSK-SYN-200063-DUP2-02',
      'TSK-SYN-200063-DUP2-03', 'WO-SYN-200063-DUP2', 'INSP-SYN-200063-DUP2']);
    assert.equal(second[1].keyInSource, 'CHAIN-INC-200063-DUP2-2-ticket');
    assert.deepEqual(buildHistoricalChains({ ...s, incidents: [...s.incidents].reverse() }).rows, rows);
  });

  test('deterministic: same input gives identical output regardless of input order', () => {
    const s = emptySources();
    s.incidents = [incident('INC-2', '2024-03-01T00:00:00', 'A1'), incident('INC-1', '2024-04-01T00:00:00', null)];
    s.tickets = [ticket('TIC-2', 'A1', '2024-03-05T00:00:00'), ticket('TIC-1', 'A1', '2024-03-05T00:00:00')];
    const a = buildHistoricalChains(s);
    const reversed = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, [...v].reverse()]));
    const b = buildHistoricalChains(reversed);
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(a.rows), JSON.stringify(buildHistoricalChains(structuredClone(s)).rows));
    assert.equal(stepsOf(a.rows, 'INC-2')[1].record_id, 'TIC-1');
    assert.deepEqual(a.rows.map((r) => r.incident_id), [...a.rows.map((r) => r.incident_id)].sort());
  });
});

describe('class definition and row schema', () => {
  const def = sdnaClassDefinition(HISTORICAL_CHAIN_CLASS);
  const types = Object.fromEntries(def.attributes.map((a) => [a.name, a.type]));

  test('declares the chain columns with exact types; links to Bentley are plain strings', () => {
    assert.equal(HISTORICAL_CHAIN_CLASS, 'SDNA Florida I595 Historical Chain');
    assert.deepEqual(def.attributes.slice(0, 4).map((a) => [a.name, a.core, a.mandatory]),
      [['keyInSource', true, true], ['code', true, true], ['name', true, true], ['description', true, true]]);
    const expected = {
      chain_id: 'String', incident_id: 'String', step: 'String', step_order: 'Integer', record_id: 'String', parent_record_id: 'String',
      record_class: 'String', link_method: 'String', link_detail: 'String', confidence: 'String', is_synthetic: 'Boolean',
      asset_id: 'String', segment: 'String', step_date: 'DateTime', summary: 'String', status: 'String', priority: 'String',
      assigned_team: 'String', work_type: 'String', inspection_result: 'String', asset_condition: 'String',
      geometry: 'Geospatial', x_coordinates: 'Decimal', y_coordinates: 'Decimal',
    };
    for (const [name, type] of Object.entries(expected)) assert.equal(types[name], type, name);
    assert.equal(def.attributes.length, 4 + Object.keys(expected).length);
    for (const a of def.attributes) {
      assert.equal(a.relatedClassName, undefined, a.name);
      assert.equal(a.relationshipType, undefined, a.name);
      if (!a.core) assert.equal(a.mandatory, false, a.name);
    }
    assert.equal(def.geometryAttributeName, 'geometry');
  });

  test('is SDNA-prefixed, writable, but not one of the six synced Live classes', () => {
    assert.ok(HISTORICAL_CHAIN_CLASS.startsWith('SDNA '));
    assert.ok(isWritableClassName(HISTORICAL_CHAIN_CLASS));
    assert.equal(isLiveClassName(HISTORICAL_CHAIN_CLASS), false);
    assert.equal(LIVE_CLASS_NAMES.includes(HISTORICAL_CHAIN_CLASS), false);
    assert.equal(liveClassDefinitions().some((d) => d.className === HISTORICAL_CHAIN_CLASS), false);
    assert.deepEqual([...WRITABLE_CLASS_NAMES], [...LIVE_CLASS_NAMES, HISTORICAL_CHAIN_CLASS]);
    for (const name of WRITABLE_CLASS_NAMES) assert.ok(name.startsWith('SDNA '), name);
    for (const c of HISTORICAL_CLASSES) assert.equal(isWritableClassName(c.className), false, c.className);
    assert.equal(isWritableClassName('Florida I595 Historical Chain'), false);
    assert.equal(isWritableClassName(HISTORICAL_CHAIN_CLASS.toLowerCase()), false);
    assert.throws(() => sdnaClassDefinition('Florida I595 Incidents'), /not an SDNA class/);
  });

  test('writer allowlist accepts the chain class and still rejects Bentley classes and non-Incremental loads', () => {
    const dto = (className, id, classId) => ({ id, classId, className, classType: 'DATA_CLASS' });
    assert.doesNotThrow(() => assertWritable(dto(HISTORICAL_CHAIN_CLASS, 'aaaaaaaaaaaaaaaaaaaaaaaa', 130), 'Incremental'));
    for (const loadType of ['Full', 'Deletion']) {
      assert.throws(() => assertWritable(dto(HISTORICAL_CHAIN_CLASS, 'aaaaaaaaaaaaaaaaaaaaaaaa', 130), loadType), (e) => e.code === WRITER_ERRORS.LOAD_TYPE_REFUSED);
    }
    for (const c of HISTORICAL_CLASSES) {
      assert.throws(() => assertWritable(dto(c.className, c.id, c.classId), 'Incremental'), (e) => e.code === WRITER_ERRORS.NOT_ALLOWLISTED, c.className);
    }
    assert.throws(() => assertWritable(dto(HISTORICAL_CHAIN_CLASS, HISTORICAL_CLASSES[1].id, 130), 'Incremental'), (e) => e.code === WRITER_ERRORS.HISTORICAL_CLASS);
    assert.throws(() => assertWritable(dto(HISTORICAL_CHAIN_CLASS, 'aaaaaaaaaaaaaaaaaaaaaaaa', 9), 'Incremental'), (e) => e.code === WRITER_ERRORS.HISTORICAL_CLASS);
  });

  test('every row built from the local export validates against the class definition', () => {
    const { rows } = buildHistoricalChains(localSources());
    const keys = new Set();
    for (const r of rows) {
      assert.deepEqual(unknownAttributes(def, r), [], r.keyInSource);
      const { valid, failures } = validateRecord(def, r);
      assert.ok(valid, `${r.keyInSource}: ${JSON.stringify(failures)}`);
      assert.equal(r.code, r.keyInSource);
      assert.equal(r.keyInSource, `${r.chain_id}-${r.step_order}-${r.step}`);
      assert.ok(r.chain_id === `CHAIN-${r.incident_id}` || r.chain_id.startsWith(`CHAIN-${r.incident_id}-DUP`), r.chain_id);
      assert.ok(Number.isInteger(r.step_order));
      assert.equal(typeof r.is_synthetic, 'boolean');
      if ('step_date' in r) assert.match(r.step_date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.ok(CHAIN_STEPS.includes(r.step));
      assert.ok(!keys.has(r.keyInSource), `duplicate ${r.keyInSource}`);
      keys.add(r.keyInSource);
      for (const [k, v] of Object.entries(r)) if (types[k] === 'String') assert.notEqual(v, '', `${r.keyInSource} ${k}`);
    }
  });
});

function localSources() {
  return {
    incidents: readExport('incidents_v3'), tickets: readExport('tickets'), tasks: readExport('tasks'), workOrders: readExport('work_orders'),
    itsInspections: readExport('its_inspections_v3'), roadwayInspections: readExport('roadway_inspections_v3'),
    safetyInspections: readExport('safety_inspections_v3'),
  };
}

describe('stats against the local export', () => {
  const result = buildHistoricalChains(localSources());
  const stats = chainStats(result.rows);

  test('one complete chain per historical incident', () => {
    const incidents = readExport('incidents_v3');
    assert.equal(stats.chains, incidents.length);
    assert.equal(stats.chains, 178);
    assert.equal(stats.rows, result.rows.length);
    const chainIds = [...new Set(result.rows.map((r) => r.chain_id))];
    assert.equal(chainIds.length, incidents.length);
    assert.equal(new Set(incidents.map((i) => i.incident_id)).size, 144, 'the export reuses 34 incident ids');
    for (const chainId of chainIds) {
      const steps = result.rows.filter((r) => r.chain_id === chainId).sort((a, b) => a.step_order - b.step_order).map((r) => r.step);
      assert.equal(steps[0], 'incident');
      assert.equal(steps[1], 'ticket');
      assert.ok(steps.includes('task'));
      assert.equal(steps.at(-2), 'work_order');
      assert.equal(steps.at(-1), 'inspection');
    }
  });

  test('38 of 178 incidents have a real ticket on the same asset within 90 days', () => {
    assert.equal(stats.byStep.ticket.inferred_same_asset, 38);
    assert.equal(stats.byStep.ticket.synthetic, 140);
    assert.equal(stats.byStep.ticket.bentley_link, 0);
    assert.equal(stats.byStep.incident.root, 178);
  });

  test('every real ticket keeps its Bentley task link; per-step counts add up', () => {
    assert.equal(stats.byStep.task.bentley_link, 38);
    assert.equal(stats.byStep.task.synthetic, 140 * 3);
    assert.equal(stats.byStep.work_order.bentley_link, 33);
    assert.equal(stats.byStep.work_order.synthetic, 178 - 33);
    const insp = stats.byStep.inspection;
    assert.equal(insp.inferred_same_asset + insp.synthetic, 178);
    assert.ok(insp.inferred_same_asset > 0);
  });
});
