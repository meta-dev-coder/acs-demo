import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVE_CLASS, PROJECT_CODE, liveClassDefinition, validateRecord, unknownAttributes, relationshipAttributes, diffRecords,
} from '../server/liveDc/classes.mjs';
import {
  loadWorkflowConfig, classifySubtype, milestonesFor, formatDcDate, formatDcTime, runWorkflow,
} from '../server/liveDc/workflow.mjs';

const T0 = Date.parse('2026-09-25T12:00:00Z');
const S = 1000;
const iso = (ms) => new Date(ms).toISOString();
const config = loadWorkflowConfig();
const WF_CLASSES = [LIVE_CLASS.TICKETS, LIVE_CLASS.TASKS, LIVE_CLASS.WORK_ORDERS, LIVE_CLASS.INSPECTIONS, LIVE_CLASS.ASSET_STATUS];

const P = { longitude: -80.2266, latitude: 26.0934 };
const M_PER_DEG_LAT = 111_195;
function asset(code, category, metersNorth, extra = {}) {
  return { code, category, systemClass: 'Roadway', longitude: P.longitude, latitude: P.latitude + metersNorth / M_PER_DEG_LAT, segmentCode: null, name: null, ...extra };
}
const ASSETS = [asset('L-50', 'Lighting', 50), asset('ATT-200', 'Attenuetors', 200), asset('ATT-300', 'Attenuetors', 300), asset('WGT-20', 'WGT', 20)];

function ev(over = {}) {
  const item = over.item ?? '868702';
  const key = `FL511-${item}`;
  const lon = over.longitude ?? P.longitude, lat = over.latitude ?? P.latitude;
  const rec = {
    keyInSource: key, code: key, name: 'Crash', description: 'Crash on I-595 West at Davie Rd. 2 right lanes blocked.',
    event_id: `FL511-incident-${item}`, event_type: 'INCIDENT', fl511_item_id: item, source: 'FL511', status: 'active', cleared_at: '',
    title: 'Crash', severity: 'Minor', first_seen_at: iso(T0), last_seen_at: iso(T0),
    latitude: lat, longitude: lon, x_coordinates: lon, y_coordinates: lat, geometry: { type: 'Point', coordinates: [lon, lat] },
    carriageway: 'WB_GENERAL', section_label: 'I-595 WB at Davie Rd', nearest_facility_label: 'I-595 Westbound',
    'segment ID': '103W', 'segment name': 'Segment_103W', full_closure: 'No', project: PROJECT_CODE,
    ...over,
  };
  delete rec.item;
  return rec;
}
const cleared = (e, at) => ({ ...e, status: 'cleared', cleared_at: iso(at) });

function run(now, events, { existing = {}, assets = ASSETS, ...rest } = {}) {
  return runWorkflow({ events, existing, assets, now, config, ...rest });
}
const byKey = (records, key) => records.find((r) => r.keyInSource === key);
const tickets = (out) => out.byClass[LIVE_CLASS.TICKETS];
const tasks = (out) => out.byClass[LIVE_CLASS.TASKS];
const wos = (out) => out.byClass[LIVE_CLASS.WORK_ORDERS];
const insps = (out) => out.byClass[LIVE_CLASS.INSPECTIONS];
const asts = (out) => out.byClass[LIVE_CLASS.ASSET_STATUS];

// Curated reads omit empty values; this is what the next cycle sees as `existing`.
function readBack(out) {
  const existing = {};
  for (const cls of WF_CLASSES) {
    existing[cls] = out.byClass[cls].map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== '' && v !== null && v !== undefined)));
  }
  return existing;
}

test('loadWorkflowConfig reads the committed config and validates overrides', () => {
  assert.equal(config.defaultProfile, 'demo');
  assert.deepEqual(config.spawnTypes, ['INCIDENT', 'DISABLED']);
  assert.equal(config.profiles.demo.workOrderAfterSeconds, 120);
  assert.deepEqual(loadWorkflowConfig({ spawnTypes: ['CLOSURE'] }).spawnTypes, ['CLOSURE']);
  assert.throws(() => loadWorkflowConfig({ defaultProfile: 'nope' }));
  assert.throws(() => loadWorkflowConfig({ profiles: { demo: { assignAfterSeconds: 200, workOrderAfterSeconds: 100, inspectionAfterClearSeconds: 1, closeAfterInspectionSeconds: 1 } } }));
  assert.throws(() => loadWorkflowConfig({ profiles: { demo: { assignAfterSeconds: -1, workOrderAfterSeconds: 100, inspectionAfterClearSeconds: 1, closeAfterInspectionSeconds: 1 } } }));
  assert.throws(() => run(T0, [ev()], { profileName: 'nope' }));
});

test('classifySubtype: keywords, express facility, disabled, other types and the sticky ticket', () => {
  const id = (e, opts) => classifySubtype(e, config, opts).id;
  assert.equal(id(ev()), 'crash');
  assert.equal(id(ev({ name: 'Incident', title: 'Incident', description: 'Vehicle on fire, smoke visible' })), 'fire');
  assert.equal(id(ev({ name: 'Incident', title: '', description: 'Truck rollover in right lane' })), 'rollover');
  assert.equal(id(ev({ name: 'Incident', title: '', description: 'Debris in roadway' })), 'debris');
  assert.equal(id(ev({ name: 'Incident', title: '', description: 'Standing water on the ramp' })), 'flood');
  assert.equal(id(ev({ carriageway: 'EXPRESS' })), 'crash_express');
  assert.equal(id(ev({ carriageway: 'EXPRESS', name: 'Incident', title: '', description: 'Lane blocked' })), 'crash_express');
  assert.equal(id(ev({ name: 'Incident', title: '', description: 'Lane blocked' })), 'crash');
  assert.equal(id(ev({ event_type: 'DISABLED', description: 'Disabled vehicle crash' })), 'disabled');
  assert.equal(id(ev({ event_type: 'CONSTRUCTION' })), 'no_damage');
  const inspected = { existingInspection: { inspected_at: iso(T0), pass_fail: 'Pass' } };
  assert.equal(id(ev(), { existingTicket: { incident_subtype: 'fire' }, ...inspected }), 'fire');
  assert.equal(id(ev({ event_type: 'CLOSURE' }), { existingTicket: { incident_subtype: 'fire' } }), 'fire');
  assert.equal(id(ev(), { existingTicket: { incident_subtype: 'fire' } }), 'crash', 'before the inspection the current details decide');
  assert.equal(id(ev(), { existingTicket: { incident_subtype: 'unknown-x' }, ...inspected }), 'crash');
});

test('milestonesFor derives every milestone from first_seen_at and cleared_at', () => {
  const profile = config.profiles.demo;
  assert.deepEqual(milestonesFor(ev(), { profile }), { t0: T0, assign: T0 + 60 * S, workOrder: T0 + 120 * S, cleared: null, inspection: null, close: null });
  const early = milestonesFor(cleared(ev(), T0 + 30 * S), { profile });
  assert.equal(early.cleared, T0 + 120 * S);
  assert.equal(early.inspection, T0 + 240 * S);
  assert.equal(early.close, T0 + 540 * S);
  const late = milestonesFor(cleared(ev(), T0 + 600 * S), { profile });
  assert.equal(late.inspection, T0 + 720 * S);
  const sticky = milestonesFor(ev(), { profile, existingInspection: { inspected_at: iso(T0 + 999 * S) } });
  assert.equal(sticky.inspection, T0 + 999 * S);
  assert.equal(sticky.cleared, T0 + 879 * S, 'an inspected event that reappeared keeps its earlier clearing');
  assert.equal(milestonesFor(ev({ first_seen_at: 'garbage' }), { profile }), null);
});

test('formatDcDate/formatDcTime render DataConnect local dates', () => {
  const ms = Date.parse('2026-09-25T03:30:00Z');
  assert.equal(formatDcDate(ms, 'America/New_York'), '24/09/2026');
  assert.equal(formatDcTime(ms, 'America/New_York'), '23:30');
  assert.equal(formatDcTime(Date.parse('2026-09-25T04:05:00Z'), 'America/New_York'), '00:05');
});

test('spawnTypes gate chains: construction produces nothing unless configured', () => {
  const construction = ev({ item: '900001', event_type: 'CONSTRUCTION', name: 'Construction' });
  const out = run(T0 + 1000 * S, [construction]);
  for (const cls of WF_CLASSES) assert.deepEqual(out.byClass[cls], []);
  assert.equal(out.stats.chains, 0);
  const custom = runWorkflow({ events: [construction], assets: ASSETS, now: T0, config: loadWorkflowConfig({ spawnTypes: ['CONSTRUCTION'] }) });
  assert.equal(tickets(custom).length, 1);
  assert.equal(tasks(custom).length, 1);
  assert.equal(tickets(custom)[0].incident_subtype, 'no_damage');
});

test('at t0 the ticket and all tasks are Open and there is no work order', () => {
  const out = run(T0, [ev()]);
  const t = byKey(tickets(out), 'TIC-FL511-868702');
  assert.equal(t['Ticket Status'], 'Open');
  assert.equal(t['Ticket ID'], 'TIC-FL511-868702');
  assert.equal(t.name, 'Crash');
  assert.equal(t['Issue Summary'], 'Crash - Crash');
  assert.equal(t['Issue Category'], 'impact repair');
  assert.equal(t.Priority, 'Medium');
  assert.equal(t['Ticket Opened Date'], '25/09/2026');
  assert.equal(t['Ticket Opened Time'], '08:00');
  assert.equal(t['Source Signal'], 'incident follow-up');
  assert.equal(t.Segment, 'I-595 WB at Davie Rd');
  assert.equal(t['segment ID'], '103W');
  assert.equal(t['X Coordinate'], P.longitude);
  assert.equal(t.created_at, iso(T0));
  assert.equal(t.status_changed_at, iso(T0));
  assert.equal(t['Asset ID'], '');
  assert.deepEqual(tasks(out).map((r) => [r.keyInSource, r['Task Status'], r['Task Type'], r.task_seq]), [
    ['TSK-FL511-868702-01', 'Open', 'Dispatch Field Crew', 1],
    ['TSK-FL511-868702-02', 'Open', 'Temporary Mitigation', 2],
    ['TSK-FL511-868702-03', 'Open', 'Inspect and Verify', 3],
  ]);
  const task = tasks(out)[0];
  assert.equal(task['Related Ticket ID'], 'TIC-FL511-868702');
  assert.equal(task['Task Notes'], 'Dispatch Field Crew for Crash (FL511-868702)');
  assert.equal(task['Assigned Team'], 'Roadway Response');
  assert.equal(task['Task Date'], '25/09/2026');
  assert.deepEqual(wos(out), []);
  assert.deepEqual(out.stats, { chains: 1, tickets: 1, tasks: 3, workOrders: 0, inspections: 0, damaged: 0, passed: 0 });
});

test('status progression through the demo milestones, then Fail on the prioritised asset', () => {
  const e = ev();
  let out = run(T0 + 60 * S, [e]);
  assert.equal(tickets(out)[0]['Ticket Status'], 'Assigned');
  assert.equal(tickets(out)[0].status_changed_at, iso(T0 + 60 * S));
  assert.deepEqual(tasks(out).map((r) => r['Task Status']), ['In Progress', 'Open', 'Open']);

  out = run(T0 + 119 * S, [e]);
  assert.deepEqual(wos(out), []);
  out = run(T0 + 120 * S, [e]);
  const wo = wos(out)[0];
  assert.equal(wo.keyInSource, 'WO-FL511-868702');
  assert.equal(wo['Work Order Status'], 'Open');
  assert.equal(wo['Work Type'], 'Field Restoration');
  assert.equal(wo.name, 'Field Restoration');
  assert.equal(wo['Related Ticket ID'], 'TIC-FL511-868702');
  assert.equal(wo['Related Task ID'], 'TSK-FL511-868702-01');
  assert.equal(wo['Work Description'], 'Crash response - Crash');
  assert.equal(wo['Repair Category'], 'impact repair');
  assert.equal(wo['Work Order Open Date'], '25/09/2026');
  assert.equal(wo['Close Date'], '');
  assert.equal(wo.created_at, iso(T0 + 120 * S));
  assert.equal(tickets(out)[0]['Ticket Status'], 'In Progress');
  assert.deepEqual(tasks(out).map((r) => r['Task Status']), ['In Progress', 'In Progress', 'Open']);

  out = run(T0 + 5000 * S, [e]);
  assert.deepEqual(insps(out), [], 'no inspection while the event is active');

  const c = cleared(e, T0 + 300 * S);
  out = run(T0 + 300 * S, [c]);
  assert.equal(wos(out)[0]['Work Order Status'], 'In Progress');
  assert.deepEqual(tasks(out).map((r) => r['Task Status']), ['Completed', 'Completed', 'In Progress']);
  out = run(T0 + 419 * S, [c]);
  assert.deepEqual(insps(out), []);

  out = run(T0 + 420 * S, [c]);
  const insp = insps(out)[0];
  assert.equal(insp.keyInSource, 'INSP-FL511-868702');
  assert.equal(insp.record_id, 'INSP-FL511-868702');
  assert.equal(insp.pass_fail, 'Fail');
  assert.equal(insp.inspection_result, 'Fail');
  assert.equal(insp.asset_id, 'ATT-200', 'Attenuetors outrank a nearer Lighting pole');
  assert.equal(insp.asset_type, 'Attenuetors');
  assert.equal(insp['system class'], 'Roadway');
  assert.ok(Math.abs(insp.distance_to_event_m - 200) < 1);
  assert.equal(insp.asset_condition, 'Poor');
  assert.equal(insp.risk_rating_1_5, 4);
  assert.equal(insp.recommended_action, 'Schedule WO to repair');
  assert.equal(insp.issue_summary, 'Attenuetors ATT-200 damaged after crash (FL511-868702)');
  assert.equal(insp.description, insp.issue_summary);
  assert.equal(insp.inspected_at, iso(T0 + 420 * S));
  assert.equal(insp.name, 'Post-incident inspection 868702');
  assert.equal(insp.inspection_form_family, 'Live Post-Incident Inspection');
  assert.ok(config.inspectors.includes(insp.inspector_name));
  assert.equal(insp.related_ticket_id, 'TIC-FL511-868702');
  assert.equal(insp.related_work_order_id, 'WO-FL511-868702');
  assert.equal(insp.segment, 'I-595 WB at Davie Rd');
  assert.deepEqual(insp.geometry.coordinates, [ASSETS[1].longitude, ASSETS[1].latitude]);

  const st = asts(out)[0];
  assert.equal(st.keyInSource, 'AST-ATT-200');
  assert.equal(st.status, 'Damaged');
  assert.equal(st.asset_id, 'ATT-200');
  assert.equal(st.asset_category, 'Attenuetors');
  assert.equal(st.name, 'Attenuetors ATT-200');
  assert.equal(st.description, `Damaged: ${insp.issue_summary}`);
  assert.equal(st.damaged_at, iso(T0 + 420 * S));
  assert.equal(st.created_at, st.damaged_at);
  assert.equal(st.source_inspection_id, 'INSP-FL511-868702');
  assert.equal(st.source_event_id, 'FL511-868702');
  assert.equal(st.x_coordinates, ASSETS[1].longitude);

  assert.equal(tickets(out)[0]['Ticket Status'], 'In Progress');
  assert.equal(tickets(out)[0]['Asset ID'], 'ATT-200');
  assert.equal(tickets(out)[0]['Asset Type'], 'Attenuetors');
  assert.equal(wos(out)[0]['Work Order Status'], 'In Progress');
  assert.equal(wos(out)[0]['Work Type'], 'Corrective Repair');
  assert.equal(wos(out)[0]['Asset ID'], 'ATT-200');
  assert.ok(tasks(out).every((r) => r['Task Status'] === 'Completed' && r['Asset ID'] === 'ATT-200'));
  assert.deepEqual(out.stats, { chains: 1, tickets: 1, tasks: 3, workOrders: 1, inspections: 1, damaged: 1, passed: 0 });

  // Still Fail and In Progress long after close.
  assert.equal(tickets(run(T0 + 100000 * S, [c]))[0]['Ticket Status'], 'In Progress');
});

test('clearing before the work order inspects at workOrder + inspectionAfterClear', () => {
  const c = cleared(ev(), T0 + 30 * S);
  assert.deepEqual(insps(run(T0 + 239 * S, [c])), []);
  assert.equal(insps(run(T0 + 240 * S, [c]))[0].inspected_at, iso(T0 + 240 * S));
});

test('Pass path: no asset in radius -> no Asset Status, WO Completed, ticket Resolved then Closed', () => {
  const c = cleared(ev(), T0 + 300 * S);
  const far = [asset('ATT-FAR', 'Attenuetors', 2000)];
  let out = run(T0 + 420 * S, [c], { assets: far });
  const insp = insps(out)[0];
  assert.equal(insp.pass_fail, 'Pass');
  assert.equal(insp.asset_id, '');
  assert.equal(insp.asset_condition, 'Good');
  assert.equal(insp.observed_condition, 'Good');
  assert.equal(insp.recommended_action, 'Schedule next inspection');
  assert.equal(insp.risk_rating_1_5, 1);
  assert.equal(insp.issue_summary, 'No asset damage found after crash (FL511-868702)');
  assert.equal('distance_to_event_m' in insp, false);
  assert.deepEqual(insp.geometry.coordinates, [P.longitude, P.latitude]);
  assert.deepEqual(asts(out), []);
  assert.equal(wos(out)[0]['Work Order Status'], 'Completed');
  assert.equal(wos(out)[0]['Close Date'], '25/09/2026');
  assert.equal(wos(out)[0]['Work Type'], 'Field Restoration');
  assert.equal(tickets(out)[0]['Ticket Status'], 'Resolved');
  assert.equal(tickets(out)[0]['Asset ID'], '');
  assert.equal(out.stats.passed, 1);
  out = run(T0 + 720 * S, [c], { assets: far });
  assert.equal(tickets(out)[0]['Ticket Status'], 'Closed');
  assert.equal(tickets(out)[0].status_changed_at, iso(T0 + 720 * S));
});

test('DISABLED chains use the DISABLED task list, Low priority and always Pass', () => {
  const d = ev({ item: '777001', event_type: 'DISABLED', name: 'Disabled Vehicle', description: 'Disabled vehicle crash on shoulder' });
  const out = run(T0 + 1000 * S, [cleared(d, T0 + 200 * S)]);
  const t = tickets(out)[0];
  assert.equal(t.incident_subtype, 'disabled');
  assert.equal(t.Priority, 'Low');
  assert.equal(t['Issue Category'], 'roadside assistance');
  assert.deepEqual(tasks(out).map((r) => [r.keyInSource, r['Assigned Team']]), [
    ['TSK-FL511-777001-01', 'Field Ops B'], ['TSK-FL511-777001-02', 'Roadway Response'],
  ]);
  assert.equal(insps(out)[0].pass_fail, 'Pass');
  assert.deepEqual(asts(out), []);
});

test('Priority is High for severe events or full closures', () => {
  assert.equal(tickets(run(T0, [ev({ severity: 'Major' })]))[0].Priority, 'High');
  assert.equal(tickets(run(T0, [ev({ full_closure: 'Yes' })]))[0].Priority, 'High');
});

test('events with an unparsable first_seen_at are skipped', () => {
  const out = run(T0, [ev({ first_seen_at: '' })]);
  assert.deepEqual(tickets(out), []);
});

function scenario() {
  return [
    cleared(ev(), T0 + 300 * S),
    ev({ item: '868800', first_seen_at: iso(T0 + 10 * S), latitude: P.latitude + 0.0001, longitude: P.longitude }),
    cleared(ev({ item: '777001', event_type: 'DISABLED', name: 'Disabled Vehicle' }), T0 + 200 * S),
    cleared(ev({ item: '555001', carriageway: 'EXPRESS', 'segment ID': '', 'segment name': '', section_label: '' }), T0 + 100 * S),
    ev({ item: '900001', event_type: 'CONSTRUCTION' }),
  ];
}

test('reruns are deterministic and a curated read-back produces zero upserts', () => {
  for (const now of [T0, T0 + 150 * S, T0 + 420 * S, T0 + 5000 * S]) {
    const events = scenario();
    const a = run(now, events);
    const b = run(now, structuredClone(events));
    assert.deepEqual(a, b);
    const existing = readBack(a);
    const again = run(now, events, { existing });
    assert.deepEqual(again, a);
    for (const cls of WF_CLASSES) assert.equal(diffRecords(again.byClass[cls], existing[cls]).upserts.length, 0, `${cls} @${now - T0}`);
  }
});

test('inputs are not mutated', () => {
  const events = scenario();
  const snapshot = structuredClone(events);
  const assets = structuredClone(ASSETS);
  const out = run(T0 + 5000 * S, events);
  const existing = readBack(out);
  const existingSnap = structuredClone(existing);
  run(T0 + 6000 * S, events, { existing, assets });
  assert.deepEqual(events, snapshot);
  assert.deepEqual(assets, ASSETS);
  assert.deepEqual(existing, existingSnap);
});

test('reactivation after inspection keeps the inspection and the damaged asset', () => {
  const c = cleared(ev(), T0 + 300 * S);
  const first = run(T0 + 420 * S, [c]);
  const reactivated = { ...ev(), last_seen_at: iso(T0 + 900 * S) };
  const out = run(T0 + 900 * S, [reactivated], { existing: readBack(first) });
  assert.deepEqual(insps(out), insps(first));
  assert.deepEqual(asts(out), asts(first));
  assert.equal(tickets(out)[0]['Asset ID'], 'ATT-200');
});

test('an event reappearing after its inspection never reopens completed tasks', () => {
  for (const assets of [[], ASSETS]) {
    const first = run(T0 + 1200 * S, [cleared(ev(), T0 + 200 * S)], { assets });
    assert.deepEqual(tasks(first).map((t) => t['Task Status']), ['Completed', 'Completed', 'Completed']);
    const reactivated = { ...ev(), last_seen_at: iso(T0 + 1260 * S) };
    const out = run(T0 + 1260 * S, [reactivated], { existing: readBack(first), assets });
    assert.deepEqual(tasks(out).map((t) => t['Task Status']), ['Completed', 'Completed', 'Completed']);
    for (const cls of WF_CLASSES) {
      assert.equal(diffRecords(out.byClass[cls], readBack(first)[cls]).upserts.length, 0, `${cls} unchanged (assets=${assets.length})`);
    }
  }
});

test('a type change from INCIDENT to CLOSURE keeps the chain and its task list', () => {
  const first = run(T0 + 150 * S, [ev()]);
  const closure = ev({ event_type: 'CLOSURE', event_id: 'FL511-closure-868702' });
  const out = run(T0 + 150 * S, [closure], { existing: readBack(first) });
  assert.equal(tickets(out).length, 1);
  assert.equal(tasks(out).length, 3);
  assert.equal(wos(out).length, 1);
  assert.equal(tickets(out)[0].incident_subtype, 'crash');
  for (const cls of WF_CLASSES) assert.equal(diffRecords(out.byClass[cls], readBack(first)[cls]).upserts.length, 0);
});

test("once inspected, the existing ticket's incident_subtype wins over keywords", () => {
  const c = cleared(ev(), T0 + 300 * S);
  const first = run(T0 + 420 * S, [c]);
  const existing = readBack(first);
  existing[LIVE_CLASS.TICKETS][0].incident_subtype = 'fire';
  const out = run(T0 + 420 * S, [c], { existing });
  assert.equal(tickets(out)[0].incident_subtype, 'fire');
  assert.equal(tickets(out)[0].name, 'Vehicle fire');
});

test('a subtype classified from a detail-less first poll is corrected once details arrive', () => {
  const bare = ev({ name: 'Incident on I-595', title: '', description: 'Incident on I-595', carriageway: 'UNKNOWN', 'segment ID': '', 'segment name': '' });
  const first = run(T0, [bare]);
  assert.equal(tickets(first)[0].incident_subtype, 'crash');

  const fire = ev({ name: 'Vehicle fire', title: 'Vehicle fire', description: 'Vehicle fire in express lanes', carriageway: 'EXPRESS' });
  const out = run(T0 + 30 * S, [fire], { existing: readBack(first) });
  assert.equal(tickets(out)[0].incident_subtype, 'fire');
  assert.equal(tickets(out)[0]['Issue Category'], 'impact repair');
  assert.equal(tickets(out)[0].name, 'Vehicle fire');

  const expressCrash = ev({ carriageway: 'EXPRESS' });
  const ex = run(T0 + 30 * S, [expressCrash], { existing: readBack(first) });
  assert.equal(tickets(ex)[0].incident_subtype, 'crash_express');

  // The corrected subtype drives the damage decision: WGT (express list) instead of the general crash list.
  const done = run(T0 + 420 * S, [cleared(expressCrash, T0 + 300 * S)], { existing: readBack(ex) });
  assert.equal(insps(done)[0].asset_id, 'WGT-20');
});

test('an existing Pass inspection stays Pass when a nearby asset appears in the catalog', () => {
  const c = cleared(ev(), T0 + 300 * S);
  const far = [asset('ATT-FAR', 'Attenuetors', 2000)];
  const first = run(T0 + 420 * S, [c], { assets: far });
  assert.equal(insps(first)[0].pass_fail, 'Pass');
  const near = [asset('ATT-NEW', 'Attenuetors', 5)];
  const out = run(T0 + 720 * S, [c], { existing: readBack(first), assets: near });
  assert.equal(insps(out)[0].pass_fail, 'Pass');
  assert.equal(insps(out)[0].asset_id, '');
  assert.deepEqual(asts(out), []);
  assert.equal(wos(out)[0]['Work Order Status'], 'Completed');
  assert.equal(tickets(out)[0]['Ticket Status'], 'Closed');
  assert.equal(tickets(out)[0]['Asset ID'], '');
});

test('changing the asset catalog does not move an existing damage', () => {
  const c = cleared(ev(), T0 + 300 * S);
  const first = run(T0 + 420 * S, [c]);
  const moved = [asset('ATT-NEW', 'Attenuetors', 5)];
  const out = run(T0 + 600 * S, [c], { existing: readBack(first), assets: moved });
  assert.equal(insps(out)[0].asset_id, 'ATT-200');
  assert.equal(asts(out)[0].keyInSource, 'AST-ATT-200');
  assert.equal(asts(out)[0].x_coordinates, ASSETS[1].longitude, 'falls back to the stored coordinates');
  assert.deepEqual(insps(out), insps(first));
});

test('the same asset damaged by two chains yields one Asset Status row, latest inspection wins', () => {
  const a = cleared(ev({ item: '100001' }), T0 + 300 * S);
  const b = cleared(ev({ item: '100002' }), T0 + 400 * S);
  const out = run(T0 + 1000 * S, [b, a]);
  assert.equal(insps(out).filter((r) => r.pass_fail === 'Fail').length, 2);
  assert.equal(asts(out).length, 1);
  assert.equal(asts(out)[0].source_event_id, 'FL511-100002');
  assert.equal(asts(out)[0].source_inspection_id, 'INSP-FL511-100002');
  const tie = run(T0 + 1000 * S, [a, cleared(ev({ item: '100003' }), T0 + 300 * S)]);
  assert.equal(asts(tie)[0].source_event_id, 'FL511-100003');
});

test('the realistic profile stretches the timings', () => {
  const out = runWorkflow({ events: [ev()], assets: ASSETS, now: T0 + 3599 * S, config, profileName: 'realistic' });
  assert.equal(tickets(out)[0]['Ticket Status'], 'Assigned');
  assert.deepEqual(wos(out), []);
  const c = cleared(ev(), T0 + 4000 * S);
  assert.deepEqual(insps(runWorkflow({ events: [c], assets: ASSETS, now: T0 + 4000 * S + 86399 * S, config, profileName: 'realistic' })), []);
  const done = runWorkflow({ events: [c], assets: ASSETS, now: T0 + 4000 * S + 86400 * S, config, profileName: 'realistic' });
  assert.equal(insps(done)[0].pass_fail, 'Fail');
});

for (const linkMode of ['live', 'linked']) {
  test(`contract (${linkMode}): known attributes, valid records, non-empty relationships, key formats`, () => {
    const out = run(T0 + 5000 * S, scenario(), { linkMode });
    const patterns = {
      [LIVE_CLASS.TICKETS]: /^TIC-FL511-\d+$/,
      [LIVE_CLASS.TASKS]: /^TSK-FL511-\d+-\d{2}$/,
      [LIVE_CLASS.WORK_ORDERS]: /^WO-FL511-\d+$/,
      [LIVE_CLASS.INSPECTIONS]: /^INSP-FL511-\d+$/,
      [LIVE_CLASS.ASSET_STATUS]: /^AST-.+$/,
    };
    for (const cls of WF_CLASSES) {
      const def = liveClassDefinition(cls, { linkMode });
      const rels = relationshipAttributes(def);
      assert.ok(out.byClass[cls].length > 0, `${cls} has records`);
      const keys = out.byClass[cls].map((r) => r.keyInSource);
      assert.deepEqual(keys, [...keys].sort());
      for (const rec of out.byClass[cls]) {
        assert.deepEqual(unknownAttributes(def, rec), [], `${cls} ${rec.keyInSource}`);
        const result = validateRecord(def, rec);
        assert.ok(result.valid, `${cls} ${rec.keyInSource}: ${JSON.stringify(result.failures)}`);
        for (const attr of rels) assert.ok(typeof rec[attr.name] === 'string' && rec[attr.name] !== '', `${cls}.${attr.name}`);
        assert.equal(rec.keyInSource, rec.code);
        assert.match(rec.keyInSource, patterns[cls]);
        assert.equal(rec.project, PROJECT_CODE);
        assert.ok(rec.source_event_id.startsWith('FL511-'));
        if (cls === LIVE_CLASS.ASSET_STATUS) {
          for (const k of ['segment ID', 'segment name', 'status_changed_at']) assert.equal(k in rec, false, k);
        } else {
          assert.ok(Number.isFinite(Date.parse(rec.status_changed_at)));
        }
      }
    }
    if (linkMode === 'linked') {
      assert.ok(relationshipAttributes(liveClassDefinition(LIVE_CLASS.ASSET_STATUS, { linkMode })).some((a) => a.name === 'asset_id'));
    }
  });
}
