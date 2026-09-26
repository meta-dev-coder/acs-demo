/**
 * The DataConnect stand-in (a test double only), exercised over real loopback HTTP: the writer and
 * the cycle are tested against it, so its shapes and its refusals must match the real host where
 * they are known.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIVE_STANDIN_CLASS_IDS, registryRowToAssetRecord, createDcStandin,
} from '../server/liveDc/standin.mjs';
import {
  LIVE_CLASS_NAMES, placeholderObjectId, HISTORICAL_CLASSES, DC_SEGMENT_CODES, liveClassDefinition, relationshipAttributes,
} from '../server/liveDc/classes.mjs';

const DM = '/api/data-mgmt/v1';
const [EVENTS, TICKETS, TASKS] = LIVE_CLASS_NAMES;
const ASSET_STATUS = LIVE_CLASS_NAMES[5];
const ASSETS = HISTORICAL_CLASSES.find(c => c.className === 'Florida I595 Assets');
const SEGMENTS = HISTORICAL_CLASSES.find(c => c.className === 'Florida i595 Roadway Segments');
const silent = { log() {}, info() {}, warn() {}, error() {} };

const ASSET_ROWS = [
  { 'Asset ID': 101, 'Asset Category': 'Lighting', 'System Class': 'Roadway', 'Asset Description': null, 'Location Category': 'Roadway', Segment: 'East Segment', 'X Coordinates': -80.2, 'Y Coordinates': 26.09, Notes: 'pole', Status: 'In Service' },
  { 'Asset ID': 'A-2', 'Asset Category': 'Drainage', 'System Class': 'Roadway', 'Asset Description': 'Inlet', 'X Coordinates': 'bad', 'Y Coordinates': null, Notes: '' },
  { 'Asset ID': 'A-2', 'Asset Category': 'Lighting', 'Asset Description': 'dupe' },
];

const open = [];
after(async () => { for (const s of open) await s.close(); });

async function start(options = {}) {
  const standin = createDcStandin({ processingDelayMs: 1, curationDelayMs: 1, assetRows: ASSET_ROWS, logger: silent, ...options });
  const server = await standin.listen(0);
  open.push(server);
  return { standin, server, url: server.url };
}

async function call(url, path, { method = 'GET', body, token = 'dev' } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const classIdOf = className => 'CL' + String(LIVE_STANDIN_CLASS_IDS[className]).padStart(6, '0');

async function upload(url, id, text, token = 'dev') {
  const res = await fetch(`${url}/v1/loads/${id}/upload/json-file`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: text,
  });
  const body = await res.text();
  return { status: res.status, body: body ? JSON.parse(body) : null };
}

/** The load-service flow the writer uses: register, upload the JSON array, process. */
async function load(url, className, loadType, records, { token = 'dev', classId, payload } = {}) {
  const reg = await call(url, '/v1/loads', {
    method: 'POST', token, body: { classId: classId ?? classIdOf(className), classType: 'DATA_CLASS', loadType },
  });
  if (reg.status !== 200) return reg;
  const up = await upload(url, reg.body.id, payload ?? JSON.stringify(records), token);
  if (up.status !== 200) return up;
  const processed = await call(url, `/v1/loads/${reg.body.id}/process`, { method: 'POST', token });
  return { ...processed, load: reg.body };
}

const idOf = name => placeholderObjectId(name);
const curated = (url, name, body = {}) => call(url, `${DM}/class/${idOf(name)}/curated-data`, { method: 'POST', body });
const ev = (n, extra = {}) => ({ keyInSource: `FL511-${n}`, code: `FL511-${n}`, name: `Event ${n}`, description: 'd', status: 'active', ...extra });
const ticket = (n, extra = {}) => ({ keyInSource: `TIC-FL511-${n}`, code: `TIC-FL511-${n}`, name: 'Crash', description: 'd', source_event_id: `FL511-${n}`, ...extra });
const task = (n, extra = {}) => ({ keyInSource: `TSK-FL511-${n}-01`, code: `TSK-FL511-${n}-01`, name: 'Dispatch', description: 'd', source_event_id: `FL511-${n}`, 'Related Ticket ID': `TIC-FL511-${n}`, ...extra });
const lastRaw = (standin, name) => standin.processes(name).raw.at(-1);

test('constants and the asset seed mapping', () => {
  assert.deepEqual(LIVE_CLASS_NAMES.map(n => LIVE_STANDIN_CLASS_IDS[n]), [101, 102, 103, 104, 105, 106]);
  assert.ok(Object.isFrozen(LIVE_STANDIN_CLASS_IDS));
  assert.deepEqual(registryRowToAssetRecord(ASSET_ROWS[0]), {
    keyInSource: '101', code: '101', name: '101', description: 'Lighting', 'asset category': 'Lighting',
    'system class': 'Roadway', 'location category': 'Roadway', segment: 'East Segment', notes: 'pole',
    status: 'In Service', x_coordinates: -80.2, y_coordinates: 26.09, project: '2222FL',
  });
  const second = registryRowToAssetRecord(ASSET_ROWS[1]);
  assert.equal(second.description, 'Inlet');
  assert.equal('x_coordinates' in second, false);
  assert.equal('notes' in second, false);
  assert.equal('segment ID' in second, false);
  assert.equal('geometry' in second, false);
});

test('auth: no bearer is 401, the read role may read but not load', async () => {
  const { url } = await start({ tokens: { adm: 'admin', rd: 'read' } });
  const none = await call(url, `${DM}/class`, { token: null });
  assert.equal(none.status, 401);
  assert.equal(none.body.status, 401);
  assert.equal(none.body.instance, `${DM}/class`);
  assert.equal((await call(url, `${DM}/class`, { token: 'unknown' })).status, 401);
  assert.equal((await load(url, EVENTS, 'Incremental', [ev(1)], { token: 'rd' })).status, 403);
  assert.equal((await curated(url, EVENTS)).status, 401);
  const read = await call(url, `${DM}/class/${idOf(EVENTS)}/curated-data`, { method: 'POST', body: {}, token: 'rd' });
  assert.equal(read.status, 200);
  assert.equal((await load(url, EVENTS, 'Incremental', [ev(1)], { token: 'adm' })).status, 202);
});

test('class list: 6 Live classes with placeholder ids and 9 historical classes with real ids', async () => {
  const { url, standin } = await start();
  const { status, body } = await call(url, `${DM}/class`);
  assert.equal(status, 200);
  assert.equal(body.length, 15);
  for (const name of LIVE_CLASS_NAMES) {
    const dto = body.find(c => c.className === name);
    assert.equal(dto.id, placeholderObjectId(name));
    assert.equal(dto.classId, LIVE_STANDIN_CLASS_IDS[name]);
    assert.equal(dto.classType, 'DATA_CLASS');
  }
  for (const h of HISTORICAL_CLASSES) {
    const dto = body.find(c => c.className === h.className);
    assert.equal(dto.id, h.id);
    assert.equal(dto.classId, h.classId);
  }
  const search = await call(url, `${DM}/class/search?searchTerm=${encodeURIComponent('i595 live')}`);
  assert.deepEqual(search.body.map(c => c.className).sort(), [...LIVE_CLASS_NAMES].sort());
  const one = await call(url, `/api/v1/class/${idOf(TICKETS)}`);
  assert.equal(one.body.className, TICKETS);
  assert.equal((await call(url, `${DM}/class/000000000000000000000000`)).status, 404);
  assert.equal(standin.classByName(TASKS).classId, 103);
  assert.equal(standin.classByName('nope'), null);
  const assetIdOf = s => s.classByName(ASSET_STATUS).attributes.find(a => a.name === 'asset_id');
  assert.equal(assetIdOf(standin).relatedClassId, undefined);
  const linked = (await start({ linkMode: 'linked' })).standin;
  assert.equal(assetIdOf(linked).relatedClassId, ASSETS.id);
});

test('seeding: segments, assets (valid=false without segment ID) and no historical processes', async () => {
  const { url, standin } = await start();
  const segs = standin.snapshot(SEGMENTS.className);
  assert.equal(segs.length, 17);
  assert.deepEqual(segs.map(s => s.keyInSource).sort(), [...DC_SEGMENT_CODES].sort());
  const s103e = segs.find(s => s.keyInSource === '103E');
  assert.equal(s103e.valid, true);
  assert.deepEqual(s103e.record, { keyInSource: '103E', code: '103E', name: 'Segment_103E', description: '-', roadway: 'i595', traffic_direction: 'i595 East', west_end_marker_id: 'mmk_3', east_end_marker_id: 'mmk_4' });
  assert.equal(segs.find(s => s.keyInSource === '101W').record.traffic_direction, 'i595 West');
  assert.equal(segs.find(s => s.keyInSource === '105').record.traffic_direction, 'i595 Express');
  const assets = standin.snapshot(ASSETS.className);
  assert.deepEqual(assets.map(a => a.keyInSource), ['101', 'A-2']);
  assert.ok(assets.every(a => a.valid === false));
  for (const h of HISTORICAL_CLASSES) assert.deepEqual(standin.processes(h.className), { raw: [], curated: [] });
  const page = await call(url, `${DM}/class/${ASSETS.id}/curated-data`, { method: 'POST', body: {} });
  assert.equal(page.body.totalCount, 2);
  assert.equal(page.body.data[0].className, ASSETS.className);
});

test('the default asset registry seeds 5015 assets', async () => {
  const standin = createDcStandin({ logger: silent });
  assert.equal(standin.snapshot(ASSETS.className).length, 5015);
  const { url, close } = await standin.listen(0);
  try {
    const res = await call(url, `${DM}/class/${ASSETS.id}/curated-data`, { method: 'POST', body: { pageSize: 1 } });
    assert.equal(res.body.totalCount, 5015);
  } finally { await close(); }
});

describe('load processing', () => {
  test('Pending is visible before processing; Incremental counts new, updated, notChanged', async () => {
    const { url, standin } = await start({ processingDelayMs: 150 });
    const res = await load(url, EVENTS, 'Incremental', [ev(1), ev(2)]);
    assert.equal(res.status, 202);
    assert.equal(res.body, null);
    const pending = await call(url, `${DM}/class/${idOf(EVENTS)}/raw-data-process?latest=true`);
    assert.equal(pending.body.length, 1);
    assert.equal(pending.body[0].status, 'Pending');
    assert.equal((await curated(url, EVENTS)).body.totalCount, 0, 'nothing visible before curation');
    await standin.idle();
    const p1 = lastRaw(standin, EVENTS);
    assert.equal(p1.status, 'Finished');
    assert.equal(p1.loadType, 'Incremental');
    assert.equal(p1.classId, idOf(EVENTS));
    assert.equal(p1.triggeredBy, 'standin');
    assert.match(p1.id, /^[0-9a-f]{24}$/);
    assert.equal(p1.loadId, res.load.id, 'the raw process carries the load-service id');
    assert.match(p1.startedAt, /^\d{4}-\d\d-\d\dT[\d:.]+$/);
    assert.equal(p1.payloadIds.length, 1);
    assert.deepEqual(p1.stats, { totalRecords: 2, invalidRecords: 0, duplicateRecords: 0, new: 2, updated: 0, notChanged: 0, deleted: 0, notFound: 0 });
    assert.ok(p1.attributeMetadata.keys.includes('status'));
    assert.equal(p1.attributeMetadata.types.code, 'string');
    await load(url, EVENTS, 'Incremental', [ev(1), ev(2, { status: 'cleared' }), ev(3)]);
    await standin.idle();
    assert.deepEqual(lastRaw(standin, EVENTS).stats, { totalRecords: 3, invalidRecords: 0, duplicateRecords: 0, new: 1, updated: 1, notChanged: 1, deleted: 0, notFound: 0 });
    assert.equal((await curated(url, EVENTS)).body.totalCount, 3);
  });

  test('Full deletes absent keys; Deletion counts deleted and notFound', async () => {
    const { url, standin } = await start();
    await load(url, EVENTS, 'Incremental', [ev(1), ev(2), ev(3)]);
    await standin.idle();
    await load(url, EVENTS, 'Full', [ev(1), ev(4)]);
    await standin.idle();
    assert.deepEqual(lastRaw(standin, EVENTS).stats, { totalRecords: 2, invalidRecords: 0, duplicateRecords: 0, new: 1, updated: 0, notChanged: 1, deleted: 2, notFound: 0 });
    assert.deepEqual(standin.snapshot(EVENTS).map(r => r.keyInSource), ['FL511-1', 'FL511-4']);
    await load(url, EVENTS, 'Deletion', [{ keyInSource: 'FL511-1' }, 'FL511-9']);
    await standin.idle();
    const stats = lastRaw(standin, EVENTS).stats;
    assert.equal(stats.deleted, 1);
    assert.equal(stats.notFound, 1);
    assert.deepEqual(standin.snapshot(EVENTS).map(r => r.keyInSource), ['FL511-4']);
    assert.equal(standin.processes(EVENTS).curated.at(-1).stats.deleted, 1);
  });

  test('invalid rows and duplicate keys are counted and skipped', async () => {
    const { url, standin } = await start();
    await load(url, EVENTS, 'Incremental', [ev(1), ev(1, { name: 'x' }), ev(1), 7, { code: 'no-key' }, { keyInSource: '' }, ev(2)]);
    await standin.idle();
    const p = lastRaw(standin, EVENTS);
    assert.equal(p.stats.totalRecords, 7);
    assert.equal(p.stats.invalidRecords, 3);
    assert.equal(p.stats.duplicateRecords, 3);
    assert.equal(p.stats.new, 1);
    assert.deepEqual(p.duplicateKeys, [{ key: 'FL511-1', count: 3 }]);
    assert.deepEqual(standin.snapshot(EVENTS).map(r => r.keyInSource), ['FL511-2']);
  });

  test('replace mode drops omitted keys on Incremental', async () => {
    const { url, standin } = await start();
    await load(url, EVENTS, 'Incremental', [ev(1, { title: 'T', comment: 'C' })]);
    await standin.idle();
    await load(url, EVENTS, 'Incremental', [ev(1, { title: 'T' })]);
    await standin.idle();
    assert.equal('comment' in standin.snapshot(EVENTS)[0].record, false);
    assert.equal(lastRaw(standin, EVENTS).stats.updated, 1);
  });

  test("merge mode keeps omitted keys and '' overwrites (then vanishes from curated reads)", async () => {
    const { url, standin } = await start({ incrementalMode: 'merge' });
    await load(url, EVENTS, 'Incremental', [ev(1, { title: 'T', comment: 'C', cleared_at: '2026-09-25T12:00:00.000Z' })]);
    await standin.idle();
    await load(url, EVENTS, 'Incremental', [ev(1, { cleared_at: '' })]);
    await standin.idle();
    const rec = standin.snapshot(EVENTS)[0].record;
    assert.equal(rec.title, 'T');
    assert.equal(rec.comment, 'C');
    assert.equal(rec.cleared_at, '');
    const item = (await curated(url, EVENTS)).body.data[0];
    assert.equal('cleared_at' in item.attributes, false);
    assert.equal(item.attributes.comment, 'C');
    await load(url, EVENTS, 'Incremental', [ev(1, { cleared_at: '' })]);
    await standin.idle();
    assert.equal(lastRaw(standin, EVENTS).stats.notChanged, 1);
  });

  test('bad load forms are 400', async () => {
    const { url } = await start();
    assert.equal((await load(url, EVENTS, 'Incremental', [], { classId: 'CL999999' })).status, 400);
    assert.equal((await load(url, EVENTS, 'Incremental', [], { classId: '101' })).status, 400);
    assert.equal((await load(url, EVENTS, 'Upsert', [])).status, 400);
    const notArray = await load(url, EVENTS, 'Incremental', null, { payload: '{"a":1}' });
    assert.equal(notArray.status, 400);
    assert.equal(notArray.body.detail, 'Payload must be a JSON array');
    assert.equal((await load(url, EVENTS, 'Incremental', null, { payload: 'not json' })).status, 400);
  });
});

describe('load service (/v1/loads)', () => {
  test('register -> upload json-file -> process -> get, with the load id carried into the raw and curated processes', async () => {
    const { url, standin } = await start({ processingDelayMs: 50 });
    const reg = await call(url, '/v1/loads', { method: 'POST', body: { classId: classIdOf(EVENTS), classType: 'DATA_CLASS', loadType: 'Incremental' } });
    assert.equal(reg.status, 200);
    assert.equal(reg.body.classId, classIdOf(EVENTS));
    assert.equal(reg.body.loadType, 'Incremental');
    assert.equal(reg.body.status, 'Init');
    assert.deepEqual(reg.body.payloadIds, []);
    assert.deepEqual(reg.body.log.map(l => [l.loadEvent, l.status]), [['Registered', 'Finished']]);
    for (const key of ['id', 'createdBy', 'createdOn', 'lastUpdated']) assert.ok(reg.body[key], key);
    const id = reg.body.id;
    assert.equal((await call(url, `/v1/loads/${id}/process`, { method: 'POST' })).status, 400, 'no payload yet');
    assert.equal((await upload(url, id, JSON.stringify([ev(1)]))).status, 200);
    const uploaded = (await call(url, `/v1/loads/${id}`)).body;
    assert.equal(uploaded.payloadIds.length, 1);
    assert.deepEqual(uploaded.log.at(-1).loadEvent, 'LoadJSONFile');
    assert.equal(standin.processes(EVENTS).raw.length, 0, 'nothing is processed before /process');
    assert.equal((await call(url, `/v1/loads/${id}/process`, { method: 'POST' })).status, 202);
    assert.equal((await call(url, `/v1/loads/${id}/process`, { method: 'POST' })).status, 409);
    assert.equal((await upload(url, id, JSON.stringify([ev(2)]))).status, 409);
    assert.ok(['Pending', 'Running'].includes((await call(url, `/v1/loads/${id}`)).body.status));
    await standin.idle();
    const done = (await call(url, `/v1/loads/${id}`)).body;
    assert.equal(done.status, 'Finished');
    assert.deepEqual(done.log.at(-1), { loadEvent: 'Loading', status: 'Finished', time: done.log.at(-1).time });
    assert.equal(standin.processes(EVENTS).raw.at(-1).loadId, id);
    assert.equal(standin.processes(EVENTS).curated.at(-1).loadId, id);
    assert.deepEqual(standin.snapshot(EVENTS).map(r => r.keyInSource), ['FL511-1']);
  });

  test('two payloads uploaded to one load are processed together', async () => {
    const { url, standin } = await start();
    const reg = await call(url, '/v1/loads', { method: 'POST', body: { classId: classIdOf(EVENTS), loadType: 'Incremental' } });
    await upload(url, reg.body.id, JSON.stringify([ev(1)]));
    await upload(url, reg.body.id, JSON.stringify([ev(2)]));
    await call(url, `/v1/loads/${reg.body.id}/process`, { method: 'POST' });
    await standin.idle();
    assert.equal(lastRaw(standin, EVENTS).stats.new, 2);
  });

  test('unknown load ids are 404; the read role may GET a load but not create or process one', async () => {
    const { url } = await start({ tokens: { adm: 'admin', rd: 'read' } });
    assert.equal((await call(url, '/v1/loads/nope', { token: 'adm' })).status, 404);
    assert.equal((await call(url, '/v1/loads/nope/process', { method: 'POST', token: 'adm' })).status, 404);
    assert.equal((await upload(url, 'nope', '[]', 'adm')).status, 404);
    const reg = await call(url, '/v1/loads', { method: 'POST', token: 'adm', body: { classId: classIdOf(EVENTS), loadType: 'Incremental' } });
    assert.equal((await call(url, `/v1/loads/${reg.body.id}`, { token: 'rd' })).status, 200);
    assert.equal((await call(url, '/v1/loads', { method: 'POST', token: 'rd', body: { classId: classIdOf(EVENTS), loadType: 'Incremental' } })).status, 403);
    assert.equal((await call(url, `/v1/loads/${reg.body.id}/process`, { method: 'POST', token: 'rd' })).status, 403);
  });

  test('the multipart /api/loads/class gateway path is gone (WAF-blocked for API clients)', async () => {
    const { url, standin } = await start();
    const form = new FormData();
    form.append('classId', classIdOf(EVENTS));
    form.append('classType', 'DATA_CLASS');
    form.append('loadType', 'Incremental');
    form.append('payload', new Blob([JSON.stringify([ev(1)])], { type: 'application/json' }), 'p.json');
    const res = await fetch(url + '/api/loads/class', { method: 'POST', headers: { authorization: 'Bearer dev' }, body: form });
    assert.equal(res.status, 403);
    await standin.idle();
    assert.equal(standin.processes(EVENTS).raw.length, 0);
  });
});

describe('DateTime attributes', () => {
  test('milliseconds make the record invalid with the DataConnect reason; whole seconds read back as .000+00:00', async () => {
    const { url, standin } = await start();
    await load(url, EVENTS, 'Incremental', [
      ev(1, { reported_at: '2026-09-26T08:11:41.238Z', updated_at: '2026-09-26T08:11:41Z' }),
      ev(2, { reported_at: '2026-09-26T08:11:41Z', updated_at: '2026-09-26T08:14:32Z' }),
    ]);
    await standin.idle();
    const byKey = Object.fromEntries(standin.snapshot(EVENTS).map(r => [r.keyInSource, r.valid]));
    assert.deepEqual(byKey, { 'FL511-1': false, 'FL511-2': true });
    assert.deepEqual(standin.invalidReasons(EVENTS), {
      'FL511-1': [{ attribute: 'reported_at', reasonCode: 'Type', reason: 'DateTime type cannot have milliseconds' }],
    });
    const item = (await curated(url, EVENTS)).body.data.find(d => d.keyInSource === 'FL511-2');
    assert.equal(item.attributes.reported_at, '2026-09-26T08:11:41.000+00:00');
    assert.equal(item.attributes.updated_at, '2026-09-26T08:14:32.000+00:00');
    assert.equal(item.attributes.name, 'Event 2', 'String attributes are returned verbatim');
  });
});

describe('curated reads', () => {
  test('paging, totalCount, sort, filters, includeDescendants, and empty values omitted', async () => {
    const { url, standin } = await start();
    const geometry = { type: 'Point', coordinates: [-80.2, 26.09] };
    const recs = [
      ev('10', { event_type: 'INCIDENT', title: 'Crash West', comment: '' , geometry, x_coordinates: -80.2 }),
      ev('20', { event_type: 'CLOSURE', title: 'Ramp closed' }),
      ev('30', { event_type: 'INCIDENT', title: 'crash east', geometry: { type: 'LineString', coordinates: [[-80.3, 26.1], [-80.2, 26.1]] } }),
      ev('40', { event_type: 'DISABLED', title: 'Stalled' }),
    ];
    await load(url, EVENTS, 'Incremental', recs.slice().reverse());
    await standin.idle();
    const all = (await call(url, `${DM}/class/${idOf(EVENTS)}/curated-data?includeDescendants=false`, { method: 'POST', body: {} })).body;
    assert.equal(all.totalCount, 4);
    const ids = all.data.map(d => d.id);
    assert.deepEqual(ids, [...ids].sort(), 'default order is by record id');
    const first = all.data.find(d => d.keyInSource === 'FL511-10');
    // Like the real host, list items never carry geoDetails (only the single-record read does).
    for (const item of all.data) assert.deepEqual(Object.keys(item).sort(), ['attributes', 'classId', 'className', 'id', 'keyInSource', 'valid']);
    assert.equal(first.classId, idOf(EVENTS));
    assert.equal(first.className, EVENTS);
    assert.equal(first.valid, true);
    assert.equal('comment' in first.attributes, false);
    assert.equal('geometry' in first.attributes, false);
    assert.equal('keyInSource' in first.attributes, false);
    assert.equal(first.attributes.code, 'FL511-10');
    assert.equal(first.attributes.x_coordinates, -80.2);

    const sorted = await curated(url, EVENTS, { sort: { field: 'attributes.code', direction: 'desc' } });
    assert.deepEqual(sorted.body.data.map(d => d.keyInSource), ['FL511-40', 'FL511-30', 'FL511-20', 'FL511-10']);
    const page1 = await curated(url, EVENTS, { page: 1, pageSize: 3, sort: { field: 'attributes.code', direction: 'asc' } });
    assert.equal(page1.body.totalCount, 4);
    assert.deepEqual(page1.body.data.map(d => d.keyInSource), ['FL511-40']);

    const f = async filters => (await curated(url, EVENTS, { filters, sort: { field: 'keyInSource' } })).body.data.map(d => d.keyInSource);
    assert.deepEqual(await f([{ field: 'keyInSource', operator: 'equals', value: 'FL511-20' }]), ['FL511-20']);
    assert.deepEqual(await f([{ field: 'attributes.event_type', operator: 'equals', value: 'INCIDENT' }]), ['FL511-10', 'FL511-30']);
    assert.deepEqual(await f([{ field: 'event_type', operator: 'isAnyOf', value: ['CLOSURE', 'DISABLED'] }]), ['FL511-20', 'FL511-40']);
    assert.deepEqual(await f([{ field: 'attributes.title', operator: 'contains', value: 'CRASH' }]), ['FL511-10', 'FL511-30']);
    assert.deepEqual(await f([{ field: 'keyInSource', operator: 'startsWith', value: 'fl511-4' }]), ['FL511-40']);
    assert.deepEqual(await f([
      { field: 'attributes.title', operator: 'contains', value: 'crash' },
      { field: 'attributes.code', operator: 'startsWith', value: 'FL511-3' },
    ]), ['FL511-30']);
    const bad = await curated(url, EVENTS, { filters: [{ field: 'keyInSource', operator: 'endsWith', value: '0' }] });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.status, 400);
    assert.equal((await call(url, `${DM}/class/000000000000000000000000/curated-data`, { method: 'POST', body: {} })).status, 404);
  });
});

describe('validation and dependency re-curation', () => {
  test('a task loaded before its ticket self-heals when the ticket arrives', async () => {
    const { url, standin } = await start();
    await load(url, EVENTS, 'Incremental', [ev(1)]);
    await standin.idle();
    await load(url, TASKS, 'Incremental', [task(1)]);
    await standin.idle();
    assert.equal(standin.snapshot(TASKS)[0].valid, false);
    const tasksBefore = standin.processes(TASKS).curated.length;
    await load(url, TICKETS, 'Incremental', [ticket(1)]);
    await standin.idle();
    assert.equal(standin.snapshot(TICKETS)[0].valid, true);
    assert.equal(standin.snapshot(TASKS)[0].valid, true);
    const tasksCur = standin.processes(TASKS).curated;
    assert.equal(tasksCur.length, tasksBefore + 1);
    assert.equal(tasksCur.at(-1).curationType, 'DEPENDENCY_UPDATED');
    assert.equal(tasksCur.at(-1).loadId, null);
    assert.equal(tasksCur.at(-1).loadType, null);
    assert.equal(standin.processes(TASKS).raw.length, 1, 'the task was not reloaded');
    const item = (await curated(url, TASKS)).body.data[0];
    assert.equal(item.valid, true);
  });

  test('missing or empty relationships are ValueNotFound; plain attributes are not', async () => {
    const { url, standin } = await start();
    await load(url, EVENTS, 'Incremental', [ev(1)]);
    await standin.idle();
    assert.equal(standin.snapshot(EVENTS)[0].valid, true, 'Live Events without segment ID are valid');
    const missing = ticket(2);
    delete missing.source_event_id;
    await load(url, TICKETS, 'Incremental', [ticket(1), missing, ticket(3, { source_event_id: '' }), ticket(4, { source_event_id: 'FL511-404' })]);
    await standin.idle();
    const byKey = Object.fromEntries(standin.snapshot(TICKETS).map(r => [r.keyInSource, r.valid]));
    assert.deepEqual(byKey, { 'TIC-FL511-1': true, 'TIC-FL511-2': false, 'TIC-FL511-3': false, 'TIC-FL511-4': false });
    const cur = standin.processes(TICKETS).curated.at(-1);
    assert.deepEqual(cur.stats, { valid: 1, invalid: 3, deleted: 0 });
  });

  test('loading an event re-curates its direct dependants but never historical classes', async () => {
    const { url, standin } = await start();
    await load(url, TICKETS, 'Incremental', [ticket(1)]);
    await load(url, TASKS, 'Incremental', [task(1)]);
    await standin.idle();
    assert.equal(standin.snapshot(TICKETS)[0].valid, false);
    await load(url, EVENTS, 'Incremental', [ev(1)]);
    await standin.idle();
    assert.equal(standin.snapshot(TICKETS)[0].valid, true);
    assert.equal(standin.snapshot(TASKS)[0].valid, true);
    assert.equal(standin.processes(TICKETS).curated.at(-1).curationType, 'DEPENDENCY_UPDATED');
    // Work orders have no raw records, so they are not re-curated.
    assert.equal(standin.processes(LIVE_CLASS_NAMES[3]).curated.length, 1);
    for (const h of HISTORICAL_CLASSES) assert.deepEqual(standin.processes(h.className), { raw: [], curated: [] });
  });

  test('re-curation is transitive: a class linked only through another Live class is re-curated too', async () => {
    const [, , , WORK_ORDERS, INSPECTIONS] = LIVE_CLASS_NAMES;
    const def = liveClassDefinition(ASSET_STATUS);
    assert.deepEqual(relationshipAttributes(def).map(a => a.relatedClassName).sort(), [EVENTS, INSPECTIONS].sort(),
      'Asset Status reaches Tickets only through Inspections');
    const { url, standin } = await start();
    await load(url, EVENTS, 'Incremental', [ev(1)]);
    await load(url, TICKETS, 'Incremental', [ticket(1)]);
    await load(url, INSPECTIONS, 'Incremental', [{
      keyInSource: 'INSP-FL511-1', code: 'INSP-FL511-1', name: 'i', description: 'd', source_event_id: 'FL511-1',
      related_ticket_id: 'TIC-FL511-1', related_work_order_id: 'WO-FL511-1',
    }]);
    await load(url, ASSET_STATUS, 'Incremental', [{
      keyInSource: 'AST-H1', code: 'AST-H1', name: 'a', description: 'd', source_event_id: 'FL511-1', source_inspection_id: 'INSP-FL511-1',
    }]);
    await standin.idle();
    const astBefore = standin.processes(ASSET_STATUS).curated.length;
    const inspBefore = standin.processes(INSPECTIONS).curated.length;
    await load(url, TICKETS, 'Incremental', [ticket(1, { name: 'Rollover' })]);
    await standin.idle();
    assert.equal(standin.processes(INSPECTIONS).curated.length, inspBefore + 1);
    const ast = standin.processes(ASSET_STATUS).curated;
    assert.equal(ast.length, astBefore + 1, 'Asset Status re-curated via Inspections');
    assert.equal(ast.at(-1).curationType, 'DEPENDENCY_UPDATED');
    assert.equal(standin.processes(WORK_ORDERS).curated.length, 1, 'no raw records, so not re-curated');
    assert.equal(standin.processes(ASSET_STATUS).raw.length, 1, 'nothing was reloaded');
  });
});

describe('process lists', () => {
  test('raw list ascending with latest; curated list ascending, ignores latest, links loadId', async () => {
    const { url, standin } = await start();
    await load(url, EVENTS, 'Incremental', [ev(1)]);
    await standin.idle();
    await load(url, EVENTS, 'Incremental', [ev(2)]);
    await standin.idle();
    const raw = (await call(url, `${DM}/class/${idOf(EVENTS)}/raw-data-process`)).body;
    assert.equal(raw.length, 2);
    assert.ok(raw[0].startedAt <= raw[1].startedAt && raw[0].id < raw[1].id);
    const latest = (await call(url, `${DM}/class/${idOf(EVENTS)}/raw-data-process?latest=true`)).body;
    assert.deepEqual(latest, [raw[1]]);
    assert.equal((await call(url, `${DM}/class/${idOf(EVENTS)}/raw-data-process?status=Failed`)).body.length, 0);
    assert.equal((await call(url, `${DM}/class/${idOf(EVENTS)}/raw-data-process?status=Finished`)).body.length, 2);
    const cur = (await call(url, `/api/v1/class/${idOf(EVENTS)}/curated-data-process?latest=true`)).body;
    assert.equal(cur.length, 3);
    assert.equal(cur[0].curationType, 'CLASS_UPDATE');
    assert.equal(cur[0].loadId, null);
    assert.equal(cur[0].status, 'Finished');
    assert.deepEqual(cur.slice(1).map(c => c.loadId), raw.map(r => r.loadId));
    assert.ok(cur.slice(1).every(c => c.curationType === 'RAW_DATA_LOAD' && c.loadType === 'Incremental'));
    for (let i = 1; i < cur.length; i++) assert.ok(cur[i - 1].id < cur[i].id);
    assert.equal((await call(url, `${DM}/class/000000000000000000000000/raw-data-process`)).status, 404);
  });

  test('loads for one class run strictly in submission order', async () => {
    const { url, standin } = await start({ processingDelayMs: 5, curationDelayMs: 5 });
    await Promise.all([1, 2, 3].map(n => load(url, EVENTS, 'Incremental', [ev(1, { title: `v${n}` })])));
    const pending = standin.processes(EVENTS).raw;
    assert.equal(pending.length, 3);
    await standin.idle();
    const raw = standin.processes(EVENTS).raw;
    assert.ok(raw.every(p => p.status === 'Finished'));
    for (let i = 1; i < raw.length; i++) assert.ok(raw[i - 1].finishedAt <= raw[i].processingAt);
    assert.deepEqual(raw.map(p => p.stats.new + p.stats.updated), [1, 1, 1]);
  });
});

describe('safety', () => {
  test('loads into historical classes are 403 and change nothing', async () => {
    const { url, standin } = await start();
    const before = standin.snapshot(ASSETS.className);
    const res = await load(url, EVENTS, 'Incremental', [{ keyInSource: '101', code: '101', name: 'x', description: 'x' }], { classId: 'CL000008' });
    assert.equal(res.status, 403);
    assert.equal(res.body.detail, "You do not have permission to load data into class 'Florida I595 Assets'");
    await standin.idle();
    assert.deepEqual(standin.snapshot(ASSETS.className), before);
    assert.deepEqual(standin.processes(ASSETS.className), { raw: [], curated: [] });
    const logged = standin.requests.find(r => r.path === '/v1/loads');
    assert.deepEqual(logged, { method: 'POST', path: '/v1/loads', classId: 'CL000008', loadType: 'Incremental', status: 403 });
    assert.ok(standin.requests.every(r => !('authorization' in r) && !('body' in r)));
  });

  test('a restricted writable list refuses other Live classes too', async () => {
    const { url } = await start({ writableClassNames: [EVENTS] });
    assert.equal((await load(url, TICKETS, 'Incremental', [ticket(1)])).status, 403);
    assert.equal((await load(url, EVENTS, 'Incremental', [ev(1)])).status, 202);
  });

  test('class, admin and relationship-type mutations are 403; unknown GETs 404', async () => {
    const { url } = await start();
    const forbidden = [
      ['POST', `${DM}/class`], ['POST', `${DM}/class/${idOf(EVENTS)}`], ['PUT', `${DM}/class/${idOf(EVENTS)}`],
      ['DELETE', `${DM}/class/${ASSETS.id}`], ['POST', `${DM}/class/${ASSETS.id}/curate`],
      ['POST', `${DM}/admin/data/import`], ['DELETE', `${DM}/admin/data/purge`], ['PUT', `${DM}/relationship-types`],
      ['GET', `${DM}/relationship-types`], ['DELETE', '/api/loads/class'], ['POST', '/api/loads/other'],
      ['POST', `/api/v1/class`], ['POST', '/api/loads/class'],
      ['POST', '/v1/loads/purge-all'], ['GET', '/v1/loads/purge-all'], ['GET', '/v1/loads/groups'], ['POST', '/v1/loads/groups'],
      ['GET', '/v1/loads/groups/g1'], ['DELETE', '/v1/loads/groups/g1'], ['POST', '/v1/loads/groups/g1/process'],
      ['GET', '/v1/loads/groups/g1/loads'], ['DELETE', '/v1/loads/some-load'], ['PUT', '/v1/loads'],
    ];
    for (const [method, path] of forbidden) {
      const res = await call(url, path, { method, body: method === 'GET' || method === 'DELETE' ? undefined : {} });
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(res.body.detail, 'Not permitted in the DataConnect stand-in');
    }
    assert.equal((await call(url, '/api/nothing-here')).status, 404);
  });

  test('handle() declines paths outside /api/', async () => {
    const { standin } = await start();
    const res = { writeHead() { throw new Error('must not respond'); }, end() {} };
    assert.equal(await standin.handle({ url: '/index.html', method: 'GET', headers: {} }, res), false);
    assert.equal(await standin.handle({ url: '/v1x/loads', method: 'GET', headers: {} }, res), false);
  });
});

test('persistence: Live state survives a restart, historical data is never written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dc-standin-'));
  const dataFile = join(dir, 'nested', 'state.json');
  try {
    const first = createDcStandin({ processingDelayMs: 1, curationDelayMs: 1, assetRows: ASSET_ROWS, logger: silent, dataFile });
    const s1 = await first.listen(0);
    await load(s1.url, EVENTS, 'Incremental', [ev(1), ev(2)]);
    await first.idle();
    const ids1 = (await curated(s1.url, EVENTS)).body.data.map(d => d.id);
    await s1.close();
    assert.ok(existsSync(dataFile));
    const saved = JSON.parse(readFileSync(dataFile, 'utf8'));
    assert.equal(saved.version, 1);
    assert.deepEqual(Object.keys(saved.classes).sort(), LIVE_CLASS_NAMES.map(placeholderObjectId).sort());
    assert.ok(!JSON.stringify(saved).includes(ASSETS.id));

    const second = createDcStandin({ processingDelayMs: 1, curationDelayMs: 1, assetRows: ASSET_ROWS, logger: silent, dataFile });
    const s2 = await second.listen(0);
    try {
      assert.deepEqual((await curated(s2.url, EVENTS)).body.data.map(d => d.id), ids1);
      assert.equal(second.processes(EVENTS).raw.length, 1);
      assert.equal(second.snapshot(ASSETS.className).length, 2);
      await load(s2.url, EVENTS, 'Incremental', [ev(1), ev(3)]);
      await second.idle();
      assert.deepEqual(lastRaw(second, EVENTS).stats.new, 1);
      assert.deepEqual(lastRaw(second, EVENTS).stats.notChanged, 1);
      const ids2 = (await curated(s2.url, EVENTS)).body.data.map(d => d.id);
      assert.deepEqual(ids2.slice(0, 2), ids1, 'record ObjectIds are stable');
      assert.ok(ids2[2] > ids1[1], 'the id counter continues after a restart');
    } finally { await s2.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('close() cancels pending timers so the process can exit', async () => {
  const standin = createDcStandin({ processingDelayMs: 60_000, curationDelayMs: 60_000, assetRows: [], logger: silent });
  const { url, close } = await standin.listen(0);
  await load(url, EVENTS, 'Incremental', [ev(1)]);
  await close();
  assert.equal(standin.processes(EVENTS).raw[0].status, 'Pending');
  // node:test would hang past its timeout here if a server socket or a timer stayed referenced.
});

test('an injected clock drives ObjectIds and timestamps', async () => {
  let t = Date.parse('2026-09-25T12:00:00Z');
  const { url, standin } = await start({ now: () => t });
  t += 1000;
  await load(url, EVENTS, 'Incremental', [ev(1)]);
  await standin.idle();
  const p = lastRaw(standin, EVENTS);
  assert.equal(p.startedAt, '2026-09-25T12:00:01.000');
  assert.equal(p.id.slice(0, 8), Math.floor(t / 1000).toString(16).padStart(8, '0'));
});

test('the stand-in is a test double only: no runtime entry point and no npm script', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  assert.equal(existsSync(join(root, 'tools', 'dc-standin.mjs')), false);
  const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(scripts['dc:standin'], undefined);
  assert.ok(!Object.values(scripts).some(command => /standin/.test(command)));
  assert.match(readFileSync(join(root, 'server', 'liveDc', 'standin.mjs'), 'utf8').slice(0, 400), /test double/i);
});
