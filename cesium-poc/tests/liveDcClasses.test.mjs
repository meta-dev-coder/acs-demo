import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIVE_CLASS, LIVE_CLASS_NAMES, REF, HISTORICAL_CLASSES, HISTORICAL_CLASS_IDS, HISTORICAL_NUMERIC_CLASS_IDS,
  PROJECT_CODE, DC_SEGMENT_CODES, LINK_MODES, LIVE_RELATIONSHIP_TYPES,
  isLiveClassName, liveClassDefinitions, liveClassDefinition, placeholderObjectId, toClassDto,
  buildCreateRequests, buildRelationshipTypesDelta, buildClassReference,
  validateRecord, unknownAttributes, relationshipAttributes, completeRecord, fromCurated,
  comparableAttributes, diffRecords, dcSegmentCodeFor,
} from '../server/liveDc/classes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, 'config', 'liveDc');
const TOOL = join(ROOT, 'tools', 'live-dc-classes.mjs');
const readJson = (name) => JSON.parse(readFileSync(join(CONFIG, name), 'utf8'));
const normalize = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const CORE = ['keyInSource', 'code', 'name', 'description'];
const HIST_NAMES = HISTORICAL_CLASSES.map((c) => c.className);
const HIST_ID_BY_NAME = new Map(HISTORICAL_CLASSES.map((c) => [c.className, c.id]));
const createResolver = (name) => HIST_ID_BY_NAME.get(name) ?? (isLiveClassName(name) ? `<id of ${name}>` : (() => { throw new Error(name); })());

const LIVE_RELS = [
  [LIVE_CLASS.TICKETS, 'source_event_id', LIVE_CLASS.EVENTS, 'SDNA_Live_Event_Tickets'],
  [LIVE_CLASS.TASKS, 'source_event_id', LIVE_CLASS.EVENTS, 'SDNA_Live_Event_Tasks'],
  [LIVE_CLASS.WORK_ORDERS, 'source_event_id', LIVE_CLASS.EVENTS, 'SDNA_Live_Event_Work_Orders'],
  [LIVE_CLASS.INSPECTIONS, 'source_event_id', LIVE_CLASS.EVENTS, 'SDNA_Live_Event_Inspections'],
  [LIVE_CLASS.ASSET_STATUS, 'source_event_id', LIVE_CLASS.EVENTS, 'SDNA_Live_Event_Asset_Status'],
  [LIVE_CLASS.TASKS, 'Related Ticket ID', LIVE_CLASS.TICKETS, 'SDNA_Live_Ticket_Tasks'],
  [LIVE_CLASS.WORK_ORDERS, 'Related Ticket ID', LIVE_CLASS.TICKETS, 'SDNA_Live_Work_Order_Tickets'],
  [LIVE_CLASS.WORK_ORDERS, 'Related Task ID', LIVE_CLASS.TASKS, 'SDNA_Live_Work_Order_Tasks'],
  [LIVE_CLASS.INSPECTIONS, 'related_ticket_id', LIVE_CLASS.TICKETS, 'SDNA_Live_Inspection_Tickets'],
  [LIVE_CLASS.INSPECTIONS, 'related_work_order_id', LIVE_CLASS.WORK_ORDERS, 'SDNA_Live_Inspection_Work_Orders'],
  [LIVE_CLASS.ASSET_STATUS, 'source_inspection_id', LIVE_CLASS.INSPECTIONS, 'SDNA_Live_Inspection_Asset_Status'],
].map(([cls, attr, target, type]) => `${cls}|${attr}|${target}|${type}`).sort();

const relsOf = (defs) => defs.flatMap((d) => relationshipAttributes(d)
  .map((a) => `${d.className}|${a.name}|${a.relatedClassName}|${a.relationshipType}`)).sort();

describe('names and allowlist', () => {
  test('six Live names in load order', () => {
    assert.equal(LIVE_CLASS_NAMES.length, 6);
    assert.deepEqual([...LIVE_CLASS_NAMES], [LIVE_CLASS.EVENTS, LIVE_CLASS.TICKETS, LIVE_CLASS.TASKS,
      LIVE_CLASS.WORK_ORDERS, LIVE_CLASS.INSPECTIONS, LIVE_CLASS.ASSET_STATUS]);
    assert.equal(LIVE_CLASS.ASSET_STATUS, 'SDNA Florida I595 Live Asset Status');
    for (const n of LIVE_CLASS_NAMES) { assert.ok(n.startsWith('SDNA Florida I595 Live ')); assert.ok(isLiveClassName(n)); }
    assert.ok(Object.isFrozen(LIVE_CLASS) && Object.isFrozen(LIVE_CLASS_NAMES));
  });

  test('historical and case variants are not Live', () => {
    for (const n of HIST_NAMES) assert.equal(isLiveClassName(n), false);
    for (const n of LIVE_CLASS_NAMES) {
      assert.equal(isLiveClassName(n.toLowerCase()), false);
      assert.equal(isLiveClassName(n.toUpperCase()), false);
      assert.equal(isLiveClassName(` ${n}`), false);
    }
    assert.equal(isLiveClassName(undefined), false);
    assert.equal(isLiveClassName(null), false);
  });

  test('historical ids', () => {
    assert.equal(HISTORICAL_CLASSES.length, 9);
    assert.equal(HISTORICAL_CLASS_IDS.size, 9);
    assert.deepEqual([...HISTORICAL_NUMERIC_CLASS_IDS].sort((a, b) => a - b), [8, 9, 10, 11, 12, 13, 14, 15, 22]);
    assert.ok(HISTORICAL_CLASS_IDS.has('6aa3eb068ebd9193de0dbbd8'));
    assert.deepEqual({ ...REF }, { ASSETS: 'Florida I595 Assets', SEGMENTS: 'Florida i595 Roadway Segments' });
    const seg = HISTORICAL_CLASSES.find((c) => c.key === 'SEGMENTS');
    assert.deepEqual([seg.className, seg.id, seg.classId], ['Florida i595 Roadway Segments', '6aa3eb068ebd9193de0dbbd8', 22]);
    assert.equal(PROJECT_CODE, '2222FL');
    assert.deepEqual([...LINK_MODES], ['live', 'linked', 'none']);
  });

  test('historical sets cannot be mutated', () => {
    assert.throws(() => HISTORICAL_CLASS_IDS.add('x'));
    assert.throws(() => HISTORICAL_NUMERIC_CLASS_IDS.add(101));
    assert.equal(HISTORICAL_CLASS_IDS.size, 9);
  });

  test('no Live name normalizes to a historical name', () => {
    const hist = new Set(HIST_NAMES.map(normalize));
    for (const n of LIVE_CLASS_NAMES) assert.equal(hist.has(normalize(n)), false, n);
  });

  test('historical classes carry their attributes', () => {
    const assets = HISTORICAL_CLASSES.find((c) => c.className === REF.ASSETS);
    assert.equal(assets.id, '6a3bdcf6a4e4185131480658');
    assert.equal(assets.classId, 8);
    const segId = assets.attributes.find((a) => a.name === 'segment ID');
    assert.equal(segId.relatedClassId, '6aa3eb068ebd9193de0dbbd8');
    assert.equal(segId.relationshipType, 'Segment Assets');
    const seg = HISTORICAL_CLASSES.find((c) => c.className === REF.SEGMENTS);
    assert.ok(seg.attributes.length >= 9);
    assert.equal(seg.attributes.some((a) => a.relatedClassId), false);
    for (const c of HISTORICAL_CLASSES) {
      assert.deepEqual(c.attributes.slice(0, 4).map((a) => a.name), CORE);
      for (const a of c.attributes) assert.equal('owners' in a || 'createdBy' in a, false);
    }
  });
});

describe('class definitions', () => {
  for (const linkMode of LINK_MODES) {
    test(`shape in ${linkMode} mode`, () => {
      const defs = liveClassDefinitions({ linkMode });
      assert.deepEqual(defs.map((d) => d.className), [...LIVE_CLASS_NAMES]);
      for (const def of defs) {
        assert.equal(def.geometryAttributeName, 'geometry');
        assert.equal(typeof def.description, 'string');
        assert.ok(def.description.length > 10);
        assert.deepEqual(def.attributes.slice(0, 4).map((a) => a.name), CORE);
        for (const a of def.attributes.slice(0, 4)) {
          assert.equal(a.type, 'String'); assert.equal(a.core, true); assert.equal(a.mandatory, true);
        }
        assert.equal(def.attributes.find((a) => a.name === 'code').displayName, 'Id');
        for (const a of def.attributes.slice(4)) { assert.equal(a.core, false); assert.equal(a.mandatory, false); }
        for (const a of def.attributes) {
          assert.equal(a.array, false); assert.equal(a.displayInExplorer, true); assert.equal(a.openInIframe, false);
          assert.equal(typeof a.displayName, 'string'); assert.equal(typeof a.description, 'string');
          assert.ok(['String', 'Integer', 'Decimal', 'Date', 'DateTime', 'Timestamp', 'Boolean', 'Geospatial', 'URL'].includes(a.type));
          assert.equal('linkedOnly' in a, false);
        }
        assert.equal(def.attributes.find((a) => a.name === 'geometry').type, 'Geospatial');
        for (const n of ['x_coordinates', 'y_coordinates']) assert.equal(def.attributes.find((a) => a.name === n).type, 'Decimal');
        assert.equal(def.attributes.find((a) => a.name === 'project').type, 'String');
        const names = def.attributes.map((a) => a.name);
        assert.equal(new Set(names).size, names.length);
        for (const a of relationshipAttributes(def)) {
          assert.equal(a.relatedAttributeName, 'code');
          assert.equal(typeof a.relationshipType, 'string');
        }
      }
      const rels = relsOf(defs);
      if (linkMode === 'live') assert.deepEqual(rels, LIVE_RELS);
      if (linkMode === 'linked') {
        assert.deepEqual(rels, [...LIVE_RELS, `${LIVE_CLASS.ASSET_STATUS}|asset_id|${REF.ASSETS}|SDNA_Live_Asset_Status`].sort());
      }
      if (linkMode === 'none') assert.deepEqual(rels, []);
      if (linkMode !== 'linked') {
        for (const d of defs) for (const a of relationshipAttributes(d)) assert.ok(isLiveClassName(a.relatedClassName));
      }
    });
  }

  test('attribute order and types', () => {
    const ev = liveClassDefinition(LIVE_CLASS.EVENTS);
    const names = ev.attributes.map((a) => a.name);
    assert.equal(names[4], 'geometry');
    assert.deepEqual(names.slice(-3), ['x_coordinates', 'y_coordinates', 'project']);
    assert.equal(relationshipAttributes(ev).length, 0);
    const typeOf = (def, n) => def.attributes.find((a) => a.name === n)?.type;
    for (const n of ['latitude', 'longitude', 'secondary_latitude', 'secondary_longitude', 'distance_to_network_m']) assert.equal(typeOf(ev, n), 'Decimal');
    for (const n of ['blocked_lanes', 'segment ID', 'status', 'event_type', 'cleared_at', 'full_closure']) assert.equal(typeOf(ev, n), 'String');
    const tk = liveClassDefinition(LIVE_CLASS.TICKETS);
    assert.deepEqual(tk.attributes.map((a) => a.name).slice(-6),
      ['x_coordinates', 'y_coordinates', 'project', 'source_event_id', 'created_at', 'status_changed_at']);
    assert.equal(typeOf(tk, 'X Coordinate'), 'Decimal');
    assert.equal(typeOf(tk, 'Asset ID'), 'String');
    assert.equal(typeOf(liveClassDefinition(LIVE_CLASS.TASKS), 'task_seq'), 'Integer');
    const insp = liveClassDefinition(LIVE_CLASS.INSPECTIONS);
    assert.equal(typeOf(insp, 'risk_rating_1_5'), 'Integer');
    assert.equal(typeOf(insp, 'distance_to_event_m'), 'Decimal');
    for (const d of liveClassDefinitions()) {
      const plain = d.attributes.filter((a) => ['Asset ID', 'asset_id', 'segment ID'].includes(a.name));
      for (const a of plain) { assert.equal(a.type, 'String'); assert.equal(a.relatedClassName, undefined); }
    }
  });

  test('historical attribute names read by maintenanceRecords normalizers', () => {
    const has = (cls, list) => {
      const names = new Set(liveClassDefinition(cls).attributes.map((a) => a.name));
      for (const n of list) assert.ok(names.has(n), `${cls} lacks ${n}`);
    };
    has(LIVE_CLASS.TICKETS, ['Ticket ID', 'Issue Summary', 'Issue Category', 'Ticket Status', 'Priority', 'Asset ID',
      'Asset Type', 'System Class', 'Segment', 'Ticket Opened Date', 'Detailed Notes', 'Source Signal', 'X Coordinate', 'Y Coordinate']);
    has(LIVE_CLASS.TASKS, ['Task ID', 'Task Type', 'Task Status', 'Asset ID', 'Asset Type', 'System Class', 'Segment',
      'Task Date', 'Task Notes', 'Related Ticket ID', 'Assigned Team', 'X Coordinate', 'Y Coordinate']);
    has(LIVE_CLASS.WORK_ORDERS, ['Work Order ID', 'Work Type', 'Work Order Status', 'Priority', 'Asset ID', 'Asset Type',
      'System Class', 'Segment', 'Work Order Open Date', 'Close Date', 'Work Description', 'Related Ticket ID',
      'Related Task ID', 'Repair Category']);
  });

  test('Asset Status has no segment attributes or status_changed_at', () => {
    for (const linkMode of LINK_MODES) {
      const names = liveClassDefinition(LIVE_CLASS.ASSET_STATUS, { linkMode }).attributes.map((a) => a.name);
      for (const n of ['segment ID', 'segment name', 'segment', 'Segment', 'status_changed_at']) assert.equal(names.includes(n), false, n);
      for (const n of ['asset_id', 'asset_category', 'system class', 'status', 'damaged_at', 'source_inspection_id', 'source_event_id', 'created_at']) {
        assert.ok(names.includes(n), n);
      }
    }
    const linked = liveClassDefinition(LIVE_CLASS.ASSET_STATUS, { linkMode: 'linked' }).attributes.find((a) => a.name === 'asset_id');
    assert.deepEqual([linked.relatedClassName, linked.relatedAttributeName, linked.relationshipType], [REF.ASSETS, 'code', 'SDNA_Live_Asset_Status']);
  });

  test('fresh copies and argument errors', () => {
    const a = liveClassDefinition(LIVE_CLASS.EVENTS);
    a.attributes.push({ name: 'x' }); a.attributes[0].name = 'mutated';
    const b = liveClassDefinition(LIVE_CLASS.EVENTS);
    assert.equal(b.attributes[0].name, 'keyInSource');
    assert.equal(b.attributes.some((x) => x.name === 'x'), false);
    assert.throws(() => liveClassDefinition('Florida I595 Assets'), Error);
    assert.throws(() => liveClassDefinition(LIVE_CLASS.EVENTS, { linkMode: 'bogus' }), Error);
    assert.throws(() => liveClassDefinitions({ linkMode: 'bogus' }), Error);
  });

  test('placeholderObjectId is deterministic 24-hex and not historical', () => {
    const ids = LIVE_CLASS_NAMES.map(placeholderObjectId);
    for (const id of ids) { assert.match(id, /^[0-9a-f]{24}$/); assert.equal(HISTORICAL_CLASS_IDS.has(id), false); }
    assert.equal(new Set(ids).size, 6);
    assert.equal(placeholderObjectId(LIVE_CLASS.EVENTS), ids[0]);
  });
});

describe('DTOs and admin artifacts', () => {
  test('toClassDto resolves relationships and fills the envelope', () => {
    const def = liveClassDefinition(LIVE_CLASS.TASKS);
    const dto = toClassDto(def, { id: 'a'.repeat(24), classId: 103, resolveClassId: (n) => placeholderObjectId(n), now: Date.parse('2026-09-25T12:00:00Z') });
    assert.equal(dto.id, 'a'.repeat(24)); assert.equal(dto.classId, 103);
    assert.equal(dto.className, LIVE_CLASS.TASKS); assert.equal(dto.classType, 'DATA_CLASS');
    assert.equal(dto.status, 'Published'); assert.deepEqual(dto.owners, []);
    assert.equal(dto.createdOn, '2026-09-25T12:00:00.000'); assert.equal(dto.lastUpdated, '2026-09-25T12:00:00.000');
    assert.equal(dto.geometryAttributeName, 'geometry'); assert.equal(dto.parentId, null);
    assert.equal(dto.securityLevel, 0); assert.equal(dto.includeSecuritySettings, false); assert.equal(dto.displayInExplorer, true);
    const rel = dto.attributes.find((a) => a.name === 'Related Ticket ID');
    assert.equal(rel.relatedClassId, placeholderObjectId(LIVE_CLASS.TICKETS));
    assert.equal('relatedClassName' in rel, false);
    assert.equal(rel.relationshipType, 'SDNA_Live_Ticket_Tasks');
    assert.equal(def.attributes.find((a) => a.name === 'Related Ticket ID').relatedClassName, LIVE_CLASS.TICKETS);
  });

  test('an unknown relationship target throws', () => {
    const def = liveClassDefinition(LIVE_CLASS.TASKS);
    def.attributes.find((a) => a.name === 'Related Ticket ID').relatedClassName = 'Nope Class';
    assert.throws(() => toClassDto(def, { id: 'b'.repeat(24), classId: 1, resolveClassId: () => undefined }), /Nope Class/);
    assert.throws(() => buildCreateRequests({}), Error);
  });

  test('buildCreateRequests', () => {
    for (const linkMode of LINK_MODES) {
      const reqs = buildCreateRequests({ resolveClassId: createResolver, linkMode });
      assert.deepEqual(reqs.map((r) => r.className), [...LIVE_CLASS_NAMES]);
      for (const r of reqs) {
        assert.deepEqual(Object.keys(r.create).sort(),
          ['className', 'classType', 'description', 'displayInExplorer', 'includeSecuritySettings', 'owners', 'status']);
        assert.equal(r.create.classType, 'DATA_CLASS'); assert.equal(r.create.status, 'Published');
        assert.deepEqual(r.update.modify, []); assert.deepEqual(r.update.remove, []);
        assert.equal(r.update.geometryAttributeName, 'geometry');
        assert.equal(r.update.className, r.className);
        assert.equal(r.update.add.some((a) => a.core), false);
        assert.ok(r.update.add.some((a) => a.name === 'geometry'));
        for (const a of r.update.add) {
          assert.equal('relatedClassName' in a, false);
          if (a.relationshipType) assert.equal(typeof a.relatedClassId, 'string');
        }
      }
      const rels = reqs.flatMap((r) => r.update.add.filter((a) => a.relatedClassId));
      const expected = { live: 11, linked: 12, none: 0 }[linkMode];
      assert.equal(rels.length, expected);
      assert.ok(rels.filter((a) => !HISTORICAL_CLASS_IDS.has(a.relatedClassId)).every((a) => a.relatedClassId.startsWith('<id of SDNA Florida I595 Live ')));
    }
  });

  test('committed create-request files: default has no historical link, linked has exactly one', () => {
    const idsIn = (reqs) => reqs.flatMap((r) => r.update.add).map((a) => a.relatedClassId).filter(Boolean);
    const def = readJson('live-classes.create-requests.json');
    const linked = readJson('live-classes.create-requests.linked.json');
    assert.equal(idsIn(def).filter((id) => HISTORICAL_CLASS_IDS.has(id)).length, 0);
    assert.deepEqual(idsIn(linked).filter((id) => HISTORICAL_CLASS_IDS.has(id)), ['6a3bdcf6a4e4185131480658']);
  });

  test('buildRelationshipTypesDelta', () => {
    const counts = Object.fromEntries(LINK_MODES.map((m) => [m, buildRelationshipTypesDelta({ linkMode: m }).relationshipTypes.length]));
    assert.deepEqual(counts, { live: 11, linked: 12, none: 0 });
    const delta = buildRelationshipTypesDelta({ linkMode: 'linked' });
    assert.match(delta.note, /^ADDITIVE delta/);
    assert.match(delta.note, /never remove or rename/);
    const types = delta.relationshipTypes.map((t) => t.type);
    assert.equal(new Set(types).size, 12);
    // DataConnect rejects an order outside 1..total, so new types are numbered after the existing registry.
    assert.deepEqual(delta.relationshipTypes.map((t) => t.order), Array.from({ length: 12 }, (_, i) => i + 1));
    assert.match(delta.note, /order/);
    const after18 = buildRelationshipTypesDelta({ linkMode: 'live', existingCount: 18 });
    assert.deepEqual(after18.relationshipTypes.map((t) => t.order), Array.from({ length: 11 }, (_, i) => 19 + i));
    for (const t of delta.relationshipTypes) {
      assert.deepEqual(Object.keys(t).sort(), ['externalLabel', 'internalLabel', 'order', 'type']);
      assert.ok(t.externalLabel && t.internalLabel);
    }
    const existing = new Set(HISTORICAL_CLASSES.flatMap((c) => c.attributes.map((a) => a.relationshipType).filter(Boolean)));
    for (const n of ['Segment Assets', 'Tickets', 'Tasks', 'Work_Order', 'Work_Order_Tasks', 'Work_Order_Tickets']) assert.ok(existing.has(n), n);
    for (const t of types) assert.equal(existing.has(t), false, t);
    assert.equal(LIVE_RELATIONSHIP_TYPES.length, 12);
    assert.deepEqual(LIVE_RELATIONSHIP_TYPES.filter((t) => t.linkedOnly).map((t) => t.type), ['SDNA_Live_Asset_Status']);
    assert.equal(LIVE_RELATIONSHIP_TYPES[0].type, 'SDNA_Live_Event_Tickets');
    const used = new Set(liveClassDefinitions({ linkMode: 'linked' }).flatMap((d) => relationshipAttributes(d).map((a) => a.relationshipType)));
    assert.deepEqual([...used].sort(), [...types].sort());
  });

  test('buildClassReference', () => {
    const ref = buildClassReference({});
    assert.match(ref._note, /^REFERENCE DOCUMENT ONLY/);
    assert.equal(ref.linkMode, 'live');
    assert.deepEqual(ref.classes.map((c) => c.id), LIVE_CLASS_NAMES.map(placeholderObjectId));
    const tasks = ref.classes.find((c) => c.className === LIVE_CLASS.TASKS);
    assert.equal(tasks.attributes.find((a) => a.name === 'Related Ticket ID').relatedClassId, placeholderObjectId(LIVE_CLASS.TICKETS));
    assert.equal(tasks.attributes[0].core, true);
    const linked = buildClassReference({ linkMode: 'linked' });
    const ast = linked.classes.find((c) => c.className === LIVE_CLASS.ASSET_STATUS);
    assert.equal(ast.attributes.find((a) => a.name === 'asset_id').relatedClassId, '6a3bdcf6a4e4185131480658');
  });

  test('committed artifacts have no drift', () => {
    const r = spawnSync(process.execPath, [TOOL, '--check'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(readJson('live-classes.create-requests.json'), buildCreateRequests({ resolveClassId: createResolver }));
    assert.deepEqual(readJson('live-classes.create-requests.linked.json'), buildCreateRequests({ resolveClassId: createResolver, linkMode: 'linked' }));
    assert.deepEqual(readJson('live-classes.reference.json'), buildClassReference({}));
    const rt = readJson('live-relationship-types.json');
    assert.deepEqual(rt.relationshipTypes, buildRelationshipTypesDelta({ linkMode: 'live' }).relationshipTypes);
    assert.deepEqual(rt.linkedOnly.map((t) => t.type), ['SDNA_Live_Asset_Status']);
    for (const f of ['live-classes.create-requests.json', 'live-classes.create-requests.linked.json', 'live-relationship-types.json', 'live-classes.reference.json']) {
      const text = readFileSync(join(CONFIG, f), 'utf8');
      assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`, f);
    }
  });

  test('tool writes a no-relationship variant with --link-mode none --out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-dc-classes-'));
    try {
      const out = join(dir, 'none.json');
      execFileSync(process.execPath, [TOOL, '--link-mode', 'none', '--out', out], { cwd: ROOT, encoding: 'utf8' });
      const reqs = JSON.parse(readFileSync(out, 'utf8'));
      assert.equal(reqs.length, 6);
      assert.equal(reqs.flatMap((r) => r.update.add).some((a) => a.relatedClassId || a.relationshipType), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('validateRecord', () => {
  const tasks = liveClassDefinition(LIVE_CLASS.TASKS);
  const good = () => ({ keyInSource: 'TSK-FL511-1-01', code: 'TSK-FL511-1-01', name: 'Dispatch', description: 'd',
    'Related Ticket ID': 'TIC-FL511-1', source_event_id: 'FL511-1', task_seq: 1, x_coordinates: -80.2 });
  const reasons = (res) => res.failures.map((f) => `${f.attribute}:${f.reasonCode}`);

  test('a good record is valid; unknown attributes are not failures', () => {
    assert.deepEqual(validateRecord(tasks, { ...good(), bogus: 1 }), { valid: true, failures: [] });
  });

  test('missing mandatory', () => {
    const rec = good(); delete rec.description; rec.name = '';
    const res = validateRecord(tasks, rec);
    assert.equal(res.valid, false);
    assert.deepEqual(reasons(res), ['name:Mandatory', 'description:Mandatory']);
    assert.equal(res.failures[0].reason, 'Mandatory attribute is missing');
  });

  test('type checks', () => {
    assert.deepEqual(reasons(validateRecord(tasks, { ...good(), x_coordinates: '-80.2' })), ['x_coordinates:Type']);
    assert.deepEqual(reasons(validateRecord(tasks, { ...good(), task_seq: 1.5 })), ['task_seq:Type']);
    assert.deepEqual(reasons(validateRecord(tasks, { ...good(), x_coordinates: Number.NaN })), ['x_coordinates:Type']);
    assert.deepEqual(reasons(validateRecord(tasks, { ...good(), 'Task Type': 5 })), ['Task Type:Type']);
    assert.deepEqual(reasons(validateRecord(tasks, { ...good(), geometry: { type: 'Point' } })), ['geometry:Type']);
    assert.equal(validateRecord(tasks, { ...good(), geometry: { type: 'Point', coordinates: [-80, 26] } }).valid, true);
    assert.equal(validateRecord(tasks, { ...good(), x_coordinates: '' }).valid, true);
  });

  test('relationship absent or empty -> ValueNotFound', () => {
    const absent = good(); delete absent['Related Ticket ID'];
    const res = validateRecord(tasks, absent);
    assert.deepEqual(reasons(res), ['Related Ticket ID:ValueNotFound']);
    assert.equal(res.failures[0].reason, `No records were found in the '${LIVE_CLASS.TICKETS}' Class on the 'Id' attribute with your value.`);
    assert.deepEqual(reasons(validateRecord(tasks, { ...good(), source_event_id: '' })), ['source_event_id:ValueNotFound']);
    assert.deepEqual(reasons(validateRecord(tasks, { ...good(), source_event_id: null })), ['source_event_id:ValueNotFound']);
  });

  test('codesFor: Set checks, null skips', () => {
    const codesFor = (attr) => (attr.relatedClassName === LIVE_CLASS.TICKETS ? new Set(['TIC-FL511-2']) : null);
    assert.deepEqual(reasons(validateRecord(tasks, good(), { codesFor })), ['Related Ticket ID:ValueNotFound']);
    assert.equal(validateRecord(tasks, { ...good(), 'Related Ticket ID': 'TIC-FL511-2' }, { codesFor }).valid, true);
    assert.equal(validateRecord(tasks, good(), { codesFor: () => null }).valid, true);
  });

  test('a ClassDTO validates the same way', () => {
    const dto = toClassDto(tasks, { id: 'c'.repeat(24), classId: 103, resolveClassId: placeholderObjectId });
    assert.deepEqual(validateRecord(dto, good()), { valid: true, failures: [] });
    const absent = good(); delete absent['Related Ticket ID'];
    const res = validateRecord(dto, absent);
    assert.deepEqual(reasons(res), ['Related Ticket ID:ValueNotFound']);
    const ticketsId = placeholderObjectId(LIVE_CLASS.TICKETS);
    const codesFor = (attr) => (attr.relatedClassId === ticketsId ? new Set(['nope']) : null);
    assert.deepEqual(reasons(validateRecord(dto, good(), { codesFor })), ['Related Ticket ID:ValueNotFound']);
    assert.deepEqual(unknownAttributes(dto, { ...good(), zzz: 1 }), ['zzz']);
    assert.equal(relationshipAttributes(dto).length, 2);
  });

  test('unknownAttributes', () => {
    assert.deepEqual(unknownAttributes(tasks, good()), []);
    assert.deepEqual(unknownAttributes(liveClassDefinition(LIVE_CLASS.ASSET_STATUS), { keyInSource: 'a', 'segment ID': '103E' }), ['segment ID']);
  });
});

describe('completeRecord', () => {
  test('fills only String-like non-core non-relationship attributes and drops null', () => {
    const def = liveClassDefinition(LIVE_CLASS.TASKS);
    const input = { keyInSource: 'k', code: 'k', name: 'n', description: 'd', 'Task Type': null, x_coordinates: undefined, 'Task Notes': 'x' };
    const out = completeRecord(def, input);
    assert.notEqual(out, input);
    assert.equal(input['Task Type'], null);
    assert.equal(out['Task Notes'], 'x');
    assert.equal(out['Task Type'], '');
    assert.equal(out['Assigned Team'], '');
    assert.equal(out['segment ID'], '');
    assert.equal(out.project, '');
    assert.equal(out.created_at, '');
    assert.equal('x_coordinates' in out, false);
    assert.equal('X Coordinate' in out, false);
    assert.equal('task_seq' in out, false);
    assert.equal('geometry' in out, false);
    assert.equal('Related Ticket ID' in out, false);
    assert.equal('source_event_id' in out, false);
    assert.deepEqual(unknownAttributes(def, out), []);
    const core = completeRecord(def, {});
    for (const n of ['keyInSource', 'code', 'name', 'description']) assert.equal(n in core, false);
  });

  test('never adds unknown keys but keeps given ones', () => {
    const out = completeRecord(liveClassDefinition(LIVE_CLASS.EVENTS), { keyInSource: 'k', extra: 1 });
    assert.equal(out.extra, 1);
    assert.equal(out.blocked_lanes, '');
    assert.equal('latitude' in out, false);
  });
});

describe('fromCurated, comparableAttributes and diffRecords', () => {
  const item = { id: '6a3d0c2da4e4185131480000', classId: 'x', className: LIVE_CLASS.EVENTS, keyInSource: 'FL511-1', valid: true,
    attributes: { code: 'FL511-1', name: 'Crash', status: 'active', latitude: 26.1234568 },
    geoDetails: { source: { type: 'Point', coordinates: [-80.2, 26.1] }, centroid: { type: 'Point', coordinates: [-80.2, 26.1] } } };

  test('fromCurated', () => {
    const rec = fromCurated(item);
    assert.deepEqual(rec, { keyInSource: 'FL511-1', code: 'FL511-1', name: 'Crash', status: 'active', latitude: 26.1234568,
      geometry: { type: 'Point', coordinates: [-80.2, 26.1] } });
    const noCode = fromCurated({ keyInSource: 'K', attributes: { name: 'n' } });
    assert.deepEqual(noCode, { keyInSource: 'K', code: 'K', name: 'n' });
  });

  test('comparableAttributes', () => {
    const c = comparableAttributes({ keyInSource: 'k', z: 1, a: '', b: null, c: undefined, geometry: { type: 'Point' }, lat: 26.12345678, skip: 'x' }, { ignore: ['skip'] });
    assert.deepEqual(c, { lat: 26.1234568, z: 1 });
    assert.deepEqual(Object.keys(comparableAttributes({ b: 1, a: 2 })), ['a', 'b']);
  });

  test('diffRecords', () => {
    const current = [fromCurated(item)];
    const same = { keyInSource: 'FL511-1', code: 'FL511-1', name: 'Crash', status: 'active', latitude: 26.12345678, cleared_at: '',
      geometry: { type: 'Point', coordinates: [0, 0] }, last_seen_at: 'later' };
    assert.deepEqual(diffRecords([same], current, { ignore: ['last_seen_at'] }), { upserts: [], unchanged: 1 });
    const res = diffRecords([same], current);
    assert.equal(res.upserts.length, 1);
    assert.equal(res.upserts[0], same);
    const changed = { ...same, status: 'cleared' };
    const fresh = { keyInSource: 'FL511-2', code: 'FL511-2', name: 'n' };
    const out = diffRecords([fresh, changed], current, { ignore: ['last_seen_at'] });
    assert.deepEqual(out.upserts, [fresh, changed]);
    assert.equal(out.unchanged, 0);
    assert.throws(() => diffRecords([fresh, { ...fresh }], current), /duplicate keyInSource/);
    assert.deepEqual(diffRecords([], []), { upserts: [], unchanged: 0 });
  });

  test('a removed value counts as a change', () => {
    const cur = [{ keyInSource: 'k', code: 'k', status: 'x', extra: 'y' }];
    assert.equal(diffRecords([{ keyInSource: 'k', code: 'k', status: 'x' }], cur).upserts.length, 1);
  });
});

describe('dcSegmentCodeFor', () => {
  test('codes', () => {
    assert.equal(DC_SEGMENT_CODES.length, 17);
    assert.ok(Object.isFrozen(DC_SEGMENT_CODES));
    assert.equal(dcSegmentCodeFor({ longitude: -80.24, carriageway: 'EB_GENERAL' }), '103E');
    assert.equal(dcSegmentCodeFor({ longitude: -80.24, carriageway: 'WB_GENERAL' }), '103W');
    assert.equal(dcSegmentCodeFor({ longitude: -80.24, carriageway: 'EXPRESS' }), '103');
    assert.equal(dcSegmentCodeFor({ longitude: -80.15, carriageway: 'EXPRESS' }), null);
    assert.equal(dcSegmentCodeFor({ longitude: -80.15, carriageway: 'EB_GENERAL' }), '106E');
    assert.equal(dcSegmentCodeFor({ longitude: -80.24, carriageway: 'UNKNOWN' }), null);
    assert.equal(dcSegmentCodeFor({ longitude: -80.24, carriageway: null }), null);
    assert.equal(dcSegmentCodeFor({ longitude: -80.24 }), null);
    assert.equal(dcSegmentCodeFor({ longitude: -80.5, carriageway: 'EB_GENERAL' }), null);
    assert.equal(dcSegmentCodeFor({ longitude: -80.2657, carriageway: 'EB_GENERAL' }), '102E');
    assert.equal(dcSegmentCodeFor({ longitude: Number.NaN, carriageway: 'EB_GENERAL' }), null);
    assert.equal(dcSegmentCodeFor({ longitude: null, carriageway: 'EB_GENERAL' }), null);
    assert.equal(dcSegmentCodeFor({ longitude: '-80.24', carriageway: 'EB_GENERAL' }), null);
  });
});
