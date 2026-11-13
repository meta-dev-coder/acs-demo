/**
 * Phase 9B — the real Speckle BIM model, end to end.
 *
 * Two kinds of test here, and the split is deliberate.
 *
 * THE ARTIFACT TESTS read a REAL converted model, committed under `tests/fixtures/speckle/`: the
 * actual GLB produced from Speckle version `84a80194f5`, with its `elements.json` and manifest.
 * They parse the glTF by hand and check the geometry — that the feature table resolves to the
 * right IFC GlobalIds, that the triangle count is what the source said, and that three elements'
 * transformed vertex bounds agree with the bounds recorded from the decoded Speckle data. A test
 * that only asserts "a .glb exists" would pass against an empty file.
 *
 * THE BEHAVIOUR TESTS drive the adapter, the store, the worker and the HTTP routes with an
 * injected `fetch` and an injected `spawn`, so nothing reaches Speckle, Python or the network.
 *
 * The guards most likely to be removed by a well-meaning change each have a test that fails if
 * they go: the version id that must not become a path, the conversion that must not run twice for
 * one version, the failed conversion that must not take the working model off the screen, and the
 * synthetic BIM data that must stay exactly where it is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConstructionApi } from '../server/construction/api.mjs';
import { countRows, openConstructionDb } from '../server/construction/db.mjs';
import { seedSourceSystems } from '../server/construction/seed.mjs';
import {
  DEFAULT_PLACEMENT, RUN_STATUS, STATE, TRIGGER, createSpeckleAdapter, parseVersionId,
  readPlacement,
} from '../server/construction/speckle.mjs';
import {
  activeVersion, elementDetail, elements as storedElements, ifcTypes, publishVersion,
  recordFailedConversion, syncLog, versions as storedVersions,
} from '../server/construction/speckleStore.mjs';
import {
  WORKER_STATE, createSpeckleSyncWorker, readSyncConfig,
} from '../server/construction/speckleSync.mjs';
import { resetSyncWorkerRegistry, syncWorkerRefs } from '../server/construction/workerRegistry.mjs';
import { buildStyle } from '../src/construction/bimViewer.js';
import { RUN_LABEL, TYPE_COLOUR, WORKER_LABEL } from '../src/construction/realBimModel.js';

const TOKEN = 'speckle-token-never-logged-9b';
const quiet = { warn() {}, error() {}, log() {} };
const FIXTURE = new URL('./fixtures/speckle/', import.meta.url);

/** The brief's own girder, the one the acceptance scenario names. */
const TARGET_GUID = '0fqX614OH1YO1Njdxms2$Q';
const VERSION = '84a80194f5';
const PROJECT = '13347d8410';
const MODEL = 'd1fdafff76';

const ENV = Object.freeze({
  SPECKLE_API_TOKEN: TOKEN,
  SPECKLE_SERVER_URL: 'https://app.speckle.systems',
  SPECKLE_PROJECT_ID: PROJECT,
  SPECKLE_MODEL_ID: MODEL,
  SPECKLE_AUTO_SYNC_ENABLED: 'true',
});

/* ── the real artifact ─────────────────────────────────────────────────────────────────────── */

/** Parse a GLB into its glTF JSON and binary chunk. Hand-rolled, like the writer. */
function parseGlb(raw) {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  const total = view.getUint32(8, true);
  const jsonLength = view.getUint32(12, true);
  const jsonType = view.getUint32(16, true);
  const json = JSON.parse(new TextDecoder().decode(raw.subarray(20, 20 + jsonLength)));
  const binLength = view.getUint32(20 + jsonLength, true);
  const bin = raw.subarray(28 + jsonLength, 28 + jsonLength + binLength);
  return { magic, version, total, jsonType, json, bin, size: raw.byteLength };
}

const bufferView = (glb, index) => {
  const spec = glb.json.bufferViews[index];
  const offset = spec.byteOffset ?? 0;
  return glb.bin.subarray(offset, offset + spec.byteLength);
};

/** A glTF STRING property: UTF-8 values plus a count+1 offsets table. */
function readStrings(glb, property) {
  const values = bufferView(glb, property.values);
  const offsetBytes = bufferView(glb, property.stringOffsets);
  const offsets = new Uint32Array(offsetBytes.buffer,
    offsetBytes.byteOffset, offsetBytes.byteLength / 4);
  const out = [];
  for (let i = 0; i < offsets.length - 1; i += 1) {
    out.push(new TextDecoder().decode(values.subarray(offsets[i], offsets[i + 1])));
  }
  return out;
}

function readPositions(glb, accessorIndex) {
  const accessor = glb.json.accessors[accessorIndex];
  const bytes = bufferView(glb, accessor.bufferView);
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset, accessor.count * 3);
  const points = [];
  for (let i = 0; i < accessor.count; i += 1) {
    points.push([floats[i * 3], floats[i * 3 + 1], floats[i * 3 + 2]]);
  }
  return points;
}

let fixture = null;
async function loadFixture() {
  if (fixture) return fixture;
  const glb = parseGlb(new Uint8Array(await readFile(new URL('model.glb', FIXTURE))));
  const elements = JSON.parse(await readFile(new URL('elements.json', FIXTURE), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL('manifest.json', FIXTURE), 'utf8'));
  fixture = { glb, elements: elements.elements, byGuid: elements.byGuid, manifest };
  return fixture;
}

test('the generated GLB is a structurally valid binary glTF', async () => {
  const { glb } = await loadFixture();
  assert.equal(glb.magic, 0x46546c67, 'the "glTF" magic');
  assert.equal(glb.version, 2);
  assert.equal(glb.total, glb.size, 'the declared total length matches the file');
  assert.equal(glb.json.asset.version, '2.0');
  assert.ok(glb.json.buffers[0].byteLength <= glb.bin.byteLength,
    'the declared buffer fits in the BIN chunk — a JSON built after the buffer was measured '
    + 'truncates here and still opens');
});

test('the GLB declares the two extensions element picking depends on', async () => {
  const { glb } = await loadFixture();
  assert.deepEqual([...glb.json.extensionsUsed].sort(),
    ['EXT_mesh_features', 'EXT_structural_metadata']);
  const table = glb.json.extensions.EXT_structural_metadata.propertyTables[0];
  assert.equal(table.class, 'element');
  assert.deepEqual(Object.keys(table.properties).sort(),
    ['elementIndex', 'ifcGuid', 'ifcType', 'name']);
});

test('EVERY element is its own node and primitive — nothing is merged into one anonymous mesh', async () => {
  const { glb, elements } = await loadFixture();
  const withGeometry = elements.filter(entry => entry.featureIndex != null);
  assert.equal(glb.json.nodes.length, withGeometry.length);
  assert.equal(glb.json.meshes.length, withGeometry.length);
  for (const mesh of glb.json.meshes) {
    assert.equal(mesh.primitives.length, 1, 'one primitive per element');
  }
});

test('the feature table resolves to the brief\'s girder, and the GUID is preserved exactly', async () => {
  const { glb } = await loadFixture();
  const table = glb.json.extensions.EXT_structural_metadata.propertyTables[0];
  const guids = readStrings(glb, table.properties.ifcGuid);
  const types = readStrings(glb, table.properties.ifcType);
  const names = readStrings(glb, table.properties.name);

  const index = guids.indexOf(TARGET_GUID);
  assert.ok(index >= 0, `${TARGET_GUID} is in the property table`);
  assert.equal(names[index], 'girder');
  assert.equal(types[index], 'IfcBeam');

  // The `$` is part of the IFC GlobalId alphabet. A converter that sanitised ids for a filename
  // or a CSS selector would quietly break every join to the source model.
  assert.ok(TARGET_GUID.includes('$'));
  assert.equal(guids[index], TARGET_GUID, 'byte for byte, not normalised');
  assert.equal(new Set(guids).size, guids.length, 'no duplicate GUIDs');
});

test('each primitive carries a CONSTANT feature id equal to its property-table row', async () => {
  const { glb } = await loadFixture();
  const table = glb.json.extensions.EXT_structural_metadata.propertyTables[0];
  const guids = readStrings(glb, table.properties.ifcGuid);
  const index = guids.indexOf(TARGET_GUID);

  const primitive = glb.json.meshes[index].primitives[0];
  const features = primitive.extensions.EXT_mesh_features.featureIds[0];
  assert.deepEqual(features, { featureCount: 1, attribute: 0, propertyTable: 0 });

  const accessor = glb.json.accessors[primitive.attributes._FEATURE_ID_0];
  const bytes = bufferView(glb, accessor.bufferView);
  const values = new Float32Array(bytes.buffer, bytes.byteOffset, accessor.count);
  assert.equal(new Set(values).size, 1, 'constant across the primitive');
  assert.equal(values[0], index,
    'an implicit feature id would number features by VERTEX, so a pick would resolve to a vertex '
    + 'rather than to an element');
  // The node is named with the GUID too, so identity survives a reader that ignores the extensions.
  assert.equal(glb.json.nodes[index].name, TARGET_GUID);
});

test('the converted geometry matches what Phase 9A measured on the source', async () => {
  const { glb, manifest } = await loadFixture();
  assert.equal(manifest.counts.objects, 20);
  assert.equal(manifest.counts.withGeometry, 16);
  assert.equal(manifest.counts.vertices, 4488);
  assert.equal(manifest.counts.triangles, 1496);
  assert.equal(manifest.units, 'm');

  // Counted from the GLB itself, not from the manifest that claims it.
  let vertices = 0;
  let indices = 0;
  for (const mesh of glb.json.meshes) {
    const primitive = mesh.primitives[0];
    vertices += glb.json.accessors[primitive.attributes.POSITION].count;
    indices += glb.json.accessors[primitive.indices].count;
  }
  assert.equal(vertices, manifest.counts.vertices);
  assert.equal(indices / 3, manifest.counts.triangles,
    'triangles counted from the index accessor, not by dividing a face array by three');
});

test('THREE elements\' GLB vertex bounds agree with the bounds decoded from Speckle', async () => {
  const { glb, elements } = await loadFixture();
  const table = glb.json.extensions.EXT_structural_metadata.propertyTables[0];
  const guids = readStrings(glb, table.properties.ifcGuid);

  const sample = elements.filter(entry => entry.featureIndex != null).slice(0, 3);
  assert.equal(sample.length, 3);

  for (const element of sample) {
    const index = guids.indexOf(element.ifcGuid);
    assert.ok(index >= 0, `${element.name} is in the table`);
    const points = readPositions(glb, glb.json.meshes[index].primitives[0].attributes.POSITION);
    assert.ok(points.length > 0);

    /*
     * The GLB is Y-up; `element.bounds` is the MODEL frame (Z-up metres) the converter recorded
     * from the decoded Speckle mesh after applying the placement transform. Undoing the one
     * rotation (x, z, -y) is what makes the two directly comparable — and comparing them is the
     * whole point: it checks the row-major transform and the up-axis flip against the source
     * rather than against the converter's own account of itself.
     */
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const [gx, gy, gz] of points) {
      const model = [gx, -gz, gy];
      for (let axis = 0; axis < 3; axis += 1) {
        lo[axis] = Math.min(lo[axis], model[axis]);
        hi[axis] = Math.max(hi[axis], model[axis]);
      }
    }
    for (let axis = 0; axis < 3; axis += 1) {
      // float32 in the GLB against float64 in the JSON: millimetre tolerance on a metre-scale
      // building is tight enough to catch a wrong matrix and loose enough to survive the cast.
      assert.ok(Math.abs(lo[axis] - element.bounds.min[axis]) < 1e-3,
        `${element.name} min[${axis}] ${lo[axis]} vs ${element.bounds.min[axis]}`);
      assert.ok(Math.abs(hi[axis] - element.bounds.max[axis]) < 1e-3,
        `${element.name} max[${axis}] ${hi[axis]} vs ${element.bounds.max[axis]}`);
    }
  }
});

test('the placement transform was applied, once, and the manifest says so', async () => {
  const { manifest, elements } = await loadFixture();
  assert.equal(manifest.transform.applied, true);
  assert.match(manifest.transform.layout, /row-major/);
  assert.match(manifest.transform.note, /Do NOT apply them again/);

  // The six girders are the proof the matrix was read the right way round: under a column-major
  // reading they all collapse to the same height.
  const girders = elements.filter(entry => entry.name === 'girder' && entry.bounds);
  assert.equal(girders.length, 6);
  const heights = new Set(girders.map(entry => entry.bounds.min[2].toFixed(2)));
  assert.ok(heights.size >= 4,
    `the girders sit at ${heights.size} distinct heights; a column-major reading puts all six at `
    + 'the same one');
});

test('the model is not georeferenced, and the manifest refuses to pretend otherwise', async () => {
  const { manifest } = await loadFixture();
  assert.equal(manifest.georeferenced, false);
  assert.match(manifest.georeferenceNote, /geo-reference/);
  assert.match(manifest.georeferenceNote, /NOT used for placement/);
  assert.equal(manifest.upAxis.gltf, 'Y-up (baked: x, z, -y)');
});

test('the IFC class comes from ifcType and the collection path, never from speckle_type', async () => {
  const { elements } = await loadFixture();
  assert.ok(elements.length > 0);
  for (const element of elements) {
    assert.notEqual(element.ifcType, 'Objects.Data.DataObject');
    assert.match(String(element.ifcType), /^Ifc/);
    assert.equal(element.speckleType, 'Objects.Data.DataObject',
      'the generic wrapper is recorded, and is NOT used as the classification');
  }
  const beams = elements.filter(entry => entry.ifcType === 'IfcBeam');
  assert.equal(beams.length, 6);
  // Both independent sources agree for every element that has them.
  for (const element of elements) {
    if (element.collectionEntity) assert.equal(element.ifcTypeAgrees, true);
  }
});

test('every element keeps its IFC GlobalId; none is generated', async () => {
  const { elements } = await loadFixture();
  assert.equal(elements.length, 20);
  assert.equal(elements.filter(entry => entry.ifcGuid).length, 20);
  for (const element of elements) {
    assert.equal(element.ifcGuidSource, 'properties.Attributes.GlobalId');
    assert.equal(element.ifcGuid.length, 22, 'an IFC GlobalId is 22 characters');
  }
});

/* ── configuration and validation ──────────────────────────────────────────────────────────── */

test('a version id that could become a path is refused', () => {
  assert.equal(parseVersionId('84a80194f5'), '84a80194f5');
  assert.equal(parseVersionId('a-b_C9'), 'a-b_C9');
  for (const bad of ['../../etc/passwd', 'a/b', '..', 'a.b', 'a b', '', null, undefined,
    'a'.repeat(65), 'x\u0000y', '%2e%2e']) {
    assert.equal(parseVersionId(bad), null, `${JSON.stringify(bad)} must be refused`);
  }
});

test('the placement anchor is configurable, and an empty variable is not zero', () => {
  assert.deepEqual(readPlacement({}).longitude, DEFAULT_PLACEMENT.longitude);
  const custom = readPlacement({ SPECKLE_ANCHOR_LONGITUDE: '-80.1', SPECKLE_ANCHOR_LATITUDE: '26.1',
    SPECKLE_ANCHOR_HEADING: '45' });
  assert.equal(custom.longitude, -80.1);
  assert.equal(custom.latitude, 26.1);
  assert.equal(custom.heading, 45);
  // `Number('')` is 0 AND finite, so an unset or blank variable must not silently become 0,0 —
  // which is a real place in the Atlantic.
  const blank = readPlacement({ SPECKLE_ANCHOR_LONGITUDE: '', SPECKLE_ANCHOR_LATITUDE: '   ' });
  assert.equal(blank.longitude, DEFAULT_PLACEMENT.longitude);
  assert.equal(blank.latitude, DEFAULT_PLACEMENT.latitude);
  assert.match(custom.note, /applied once/i);
});

test('the worker is off unless the environment says otherwise', () => {
  assert.equal(readSyncConfig({}).enabled, false);
  assert.equal(readSyncConfig({ SPECKLE_AUTO_SYNC_ENABLED: 'true' }).enabled, true);
  assert.equal(readSyncConfig({}).intervalSeconds, 60);
  // The floor is higher than OpenProject's because a cycle here can download a model.
  const clamped = readSyncConfig({ SPECKLE_SYNC_INTERVAL_SECONDS: '2' });
  assert.equal(clamped.intervalSeconds, 30);
  assert.match(clamped.intervalClamped, /clamped to 30 s/);
});

/* ── the adapter ───────────────────────────────────────────────────────────────────────────── */

const graphqlReply = (body, status = 200) => new Response(JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } });

function stubSpeckle({ versionId = VERSION, createdAt = '2026-11-11T04:28:04.378Z' } = {}) {
  const calls = [];
  const state = { versionId, fail: null };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method, headers: options.headers ?? {} });
    if (state.fail) return graphqlReply(state.fail.body, state.fail.status);
    return graphqlReply({ data: { project: { id: PROJECT, name: 'My First Project',
      model: { id: MODEL, name: 'Building-Structural',
        versions: { totalCount: 1, items: [{ id: state.versionId, createdAt,
          referencedObject: `bundle.${PROJECT}.${MODEL}.${state.versionId}`,
          sourceApplication: 'ifc-ifcopenshell-converter', message: null }] } } } } });
  };
  return { fetchImpl, calls, state };
}

/** A spawn that writes the real fixture into the staging directory, as the converter would. */
function stubSpawn({ fail = null, artifacts = true } = {}) {
  const runs = [];
  const impl = (command, args, options) => {
    runs.push({ command, args, options });
    const listeners = { close: [], error: [] };
    const stdout = { on: (event, handler) => { if (event === 'data') stdout.handler = handler; } };
    const stderr = { on: () => {} };
    queueMicrotask(async () => {
      if (fail) {
        stdout.handler?.(JSON.stringify({ ok: false, error: fail.error,
          errorClass: fail.errorClass }));
        listeners.close.forEach(fn => fn(1));
        return;
      }
      const outIndex = args.indexOf('--out');
      const dir = args[outIndex + 1];
      const manifest = JSON.parse(await readFile(new URL('manifest.json', FIXTURE), 'utf8'));
      if (artifacts) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'model.glb'), await readFile(new URL('model.glb', FIXTURE)));
        writeFileSync(join(dir, 'elements.json'),
          await readFile(new URL('elements.json', FIXTURE)));
        writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
      }
      stdout.handler?.(JSON.stringify({ ok: true, manifest }));
      listeners.close.forEach(fn => fn(0));
    });
    return { stdout, stderr, kill() {},
      on: (event, handler) => { listeners[event]?.push(handler); } };
  };
  return { impl, runs };
}

function createAdapter({ env = ENV, stub = stubSpeckle(), spawn = stubSpawn() } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'speckle-test-'));
  // The real interpreter and script must exist for `convert` to proceed; the repo's own paths are
  // used and the spawn is stubbed, so nothing is executed.
  return createSpeckleAdapter({ env, fetchImpl: stub.fetchImpl, logger: quiet,
    spawnImpl: spawn.impl, artifactRoot: root });
}

test('no token means no request is made at all', async () => {
  const stub = stubSpeckle();
  const adapter = createAdapter({ env: { ...ENV, SPECKLE_API_TOKEN: '' }, stub });
  const result = await adapter.latestVersion();
  assert.equal(result.state, STATE.NOT_CONFIGURED);
  assert.match(result.reason, /SPECKLE_API_TOKEN/);
  assert.equal(stub.calls.length, 0,
    'probing anonymously would turn a configuration state into a 401 to explain away');
});

test('the token travels as a Bearer header and never in a URL', async () => {
  const stub = stubSpeckle();
  const adapter = createAdapter({ stub });
  const result = await adapter.latestVersion();
  assert.equal(result.state, STATE.CONNECTED);
  assert.equal(result.version.versionId, VERSION);
  assert.equal(stub.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(!stub.calls[0].url.includes(TOKEN));
  // The CDN refuses a default agent with a 403 that reads exactly like an auth failure.
  assert.ok(stub.calls[0].headers['user-agent']);
});

test('a GraphQL error carried on HTTP 200 is a failure, not an empty success', async () => {
  const stub = stubSpeckle();
  stub.state.fail = { status: 200, body: { errors: [{ message: 'You are not logged in',
    extensions: { code: 'UNAUTHORIZED' } }] } };
  const adapter = createAdapter({ stub });
  const result = await adapter.latestVersion();
  assert.equal(result.state, STATE.AUTH_FAILED);
  assert.match(result.reason, /UNAUTHORIZED/);
});

test('a host that is not an allowed Speckle instance is refused', async () => {
  const stub = stubSpeckle();
  const adapter = createAdapter({ env: { ...ENV, SPECKLE_SERVER_URL: 'https://evil.example' },
    stub });
  const result = await adapter.latestVersion();
  assert.equal(result.state, STATE.CONNECTION_FAILED);
  assert.match(result.reason, /not an allowed Speckle host/);
  assert.equal(stub.calls.length, 0, 'and the credential was never sent there');
});

test('the converter is spawned without a shell, with the token in the environment', async () => {
  const spawn = stubSpawn();
  const adapter = createAdapter({ spawn });
  const outcome = await adapter.convert(VERSION);
  assert.equal(outcome.ok, true);
  const [run] = spawn.runs;
  assert.equal(run.options.shell, false, 'a shell would make an argument a command');
  assert.ok(Array.isArray(run.args));
  assert.equal(run.options.env.SPECKLE_API_TOKEN, TOKEN);
  // On the command line it would be visible to anything that can run `ps`.
  assert.ok(!run.args.join(' ').includes(TOKEN));
  assert.ok(run.args.includes(VERSION));
});

test('a version id that fails validation never reaches the converter', async () => {
  const spawn = stubSpawn();
  const adapter = createAdapter({ spawn });
  const outcome = await adapter.convert('../../../etc/passwd');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorClass, 'CONFIGURATION');
  assert.equal(spawn.runs.length, 0);
});

test('a failed conversion leaves no half-written model directory behind', async () => {
  const spawn = stubSpawn({ fail: { error: 'boom', errorClass: 'DATA_DECODING' } });
  const adapter = createAdapter({ spawn });
  const outcome = await adapter.convert(VERSION);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorClass, 'DATA_DECODING');
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(join(adapter.artifactRoot(), VERSION)), false,
    'the staging directory is removed; a server must never serve a partial model');
});

/* ── the store ─────────────────────────────────────────────────────────────────────────────── */

function createDb() {
  const db = openConstructionDb({ path: ':memory:' });
  if (countRows(db, ['src_p6_activity']).src_p6_activity === 0) seedSourceSystems(db);
  return db;
}

async function publishFixture(db, versionId = VERSION) {
  const { manifest, elements } = await loadFixture();
  return publishVersion(db, { projectId: PROJECT, modelId: MODEL, versionId,
    manifest, artifactDir: `/tmp/${versionId}`, elements });
}

test('publishing stores every element and makes exactly one version active', async () => {
  const db = createDb();
  const published = await publishFixture(db);
  assert.equal(published.status, 'CONVERTED');
  assert.equal(published.active, true);
  assert.equal(published.elementCount, 20);
  assert.equal(published.geometryCount, 16);

  const active = activeVersion(db, { projectId: PROJECT, modelId: MODEL });
  assert.equal(active.versionId, VERSION);
  assert.equal(storedElements(db, active.id).length, 20);
  const detail = elementDetail(db, active.id, TARGET_GUID);
  assert.equal(detail.name, 'girder');
  assert.equal(detail.ifcType, 'IfcBeam');
  assert.equal(detail.featureIndex, 0);
  assert.ok(Object.keys(detail.properties).length > 20, 'the real property set is kept');
  assert.deepEqual(ifcTypes(db, active.id).find(entry => entry.ifcType === 'IfcBeam'),
    { ifcType: 'IfcBeam', count: 6, withGeometry: 6 });
});

test('republishing the same version replaces its elements rather than doubling them', async () => {
  const db = createDb();
  await publishFixture(db);
  await publishFixture(db);
  const active = activeVersion(db, { projectId: PROJECT, modelId: MODEL });
  assert.equal(storedElements(db, active.id).length, 20);
  assert.equal(storedVersions(db, { projectId: PROJECT, modelId: MODEL })
    .filter(entry => entry.active).length, 1);
});

test('a newer version takes over, and only one stays active', async () => {
  const db = createDb();
  await publishFixture(db, 'v1aaaaaaaa');
  await publishFixture(db, 'v2bbbbbbbb');
  const rows = storedVersions(db, { projectId: PROJECT, modelId: MODEL });
  assert.equal(rows.filter(entry => entry.active).length, 1);
  assert.equal(activeVersion(db, { projectId: PROJECT, modelId: MODEL }).versionId, 'v2bbbbbbbb');
});

test('A FAILED CONVERSION KEEPS THE WORKING MODEL ON SCREEN', async () => {
  const db = createDb();
  await publishFixture(db, 'v1aaaaaaaa');
  recordFailedConversion(db, { projectId: PROJECT, modelId: MODEL, versionId: 'v2bbbbbbbb',
    error: 'the bundle could not be decoded', errorClass: 'DATA_DECODING' });

  const active = activeVersion(db, { projectId: PROJECT, modelId: MODEL });
  assert.equal(active.versionId, 'v1aaaaaaaa',
    'a screen that went blank because a NEW version failed would be strictly less useful');
  assert.equal(storedElements(db, active.id).length, 20);
  const failed = storedVersions(db, { projectId: PROJECT, modelId: MODEL })
    .find(entry => entry.versionId === 'v2bbbbbbbb');
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.active, false);
  assert.equal(failed.errorClass, 'DATA_DECODING');
});

test('publishing touches no synthetic BIM, P6, SYNCHRO, SAP or ACC row', async () => {
  const db = createDb();
  const watched = ['src_p6_activity', 'src_acc_element', 'src_sap_cost', 'element', 'activity',
    'cost', 'sync_run', 'outbound_proposal', 'mapping', 'progress_observation'];
  const before = countRows(db, watched);
  const beforeP6 = db.prepare('SELECT * FROM src_p6_activity ORDER BY activity_id').all();
  await publishFixture(db);
  assert.deepEqual(countRows(db, watched), before);
  assert.deepEqual(db.prepare('SELECT * FROM src_p6_activity ORDER BY activity_id').all(),
    beforeP6, 'byte for byte');
});

/* ── the worker ────────────────────────────────────────────────────────────────────────────── */

function fakeClock(start = 1_767_000_000_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { const id = nextId++; timers.set(id, { fn, at: now + ms, ms }); return { id, unref() {} }; },
    clearTimeout(handle) { if (handle) timers.delete(handle.id); },
    pending: () => [...timers.values()],
    tick(ms) { now += ms; },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.fn();
      }
      await flush();
    },
  };
}
const flush = async (turns = 6) => {
  for (let i = 0; i < turns; i += 1) await new Promise(r => setImmediate(r));
};
async function settled(worker) {
  for (let i = 0; i < 40 && worker.inFlight; i += 1) {
    try { await worker.inFlight; } catch { /* reported */ }
    await flush(2);
  }
  await flush(2);
}

function createWorker({ env = ENV, stub = stubSpeckle(), spawn = stubSpawn(),
  clock = fakeClock(), published = [], db = null } = {}) {
  const database = db ?? createDb();
  const adapter = createAdapter({ env, stub, spawn });
  const worker = createSpeckleSyncWorker({
    adapter: () => adapter, db: () => database,
    publish: (event, data) => published.push({ event, data }),
    env, logger: quiet,
    setTimeoutImpl: clock.setTimeout, clearTimeoutImpl: clock.clearTimeout, now: clock.now,
    manualMinIntervalMs: 0,
  });
  return { worker, db: database, stub, spawn, clock, published, adapter };
}

test('the first cycle converts, and the model becomes active', async () => {
  const { worker, db, spawn, published } = createWorker();
  const run = await worker.run({ trigger: TRIGGER.STARTUP });
  await settled(worker);
  assert.equal(run.status, RUN_STATUS.CONVERTED);
  assert.equal(run.versionId, VERSION);
  assert.equal(spawn.runs.length, 1);
  assert.equal(activeVersion(db, { projectId: PROJECT, modelId: MODEL }).versionId, VERSION);
  assert.equal(published.length, 1);
  assert.equal(published[0].event, 'speckle-sync-completed');
  assert.equal(published[0].data.versionId, VERSION);
  // Ids and counts only: no geometry rides on the notification.
  assert.ok(!JSON.stringify(published[0].data).includes('girder'));
  await worker.stop();
});

test('AN UNCHANGED VERSION IS NOT DOWNLOADED OR CONVERTED AGAIN', async () => {
  const { worker, spawn, stub, clock, published } = createWorker();
  await worker.run({ trigger: TRIGGER.STARTUP });
  await settled(worker);
  assert.equal(spawn.runs.length, 1);
  published.length = 0;

  for (let i = 0; i < 5; i += 1) {
    await clock.advance(60_000);
    await settled(worker);
  }
  assert.equal(spawn.runs.length, 1,
    'five more cycles and not one conversion — a Speckle version id is immutable, which is the '
    + 'whole reason a 60-second poll is reasonable');
  assert.equal(stub.calls.length, 6, 'but each cycle did ask, cheaply');
  assert.equal(published.length, 0, 'and published nothing, because nothing changed');
  assert.equal(worker.status().lastRun.status, RUN_STATUS.UNCHANGED);
  await worker.stop();
});

test('a new version published upstream is detected and converted', async () => {
  const { worker, db, spawn, stub, clock, published } = createWorker();
  await worker.run({ trigger: TRIGGER.STARTUP });
  await settled(worker);
  published.length = 0;

  stub.state.versionId = 'newversion1';
  await clock.advance(60_000);
  await settled(worker);

  assert.equal(spawn.runs.length, 2);
  assert.equal(activeVersion(db, { projectId: PROJECT, modelId: MODEL }).versionId, 'newversion1');
  assert.equal(published.length, 1);
  assert.equal(published[0].data.previousVersionId, VERSION);
  // Both versions are kept; only one is active.
  assert.equal(storedVersions(db, { projectId: PROJECT, modelId: MODEL })
    .filter(entry => entry.active).length, 1);
  await worker.stop();
});

test('a failed conversion of a new version keeps the previous model active', async () => {
  const { worker, db, stub, clock } = createWorker();
  await worker.run({ trigger: TRIGGER.STARTUP });
  await settled(worker);

  // Rebind a failing spawn by building a second worker over the same database.
  const failing = createWorker({ db,
    stub: (() => { const s = stubSpeckle({ versionId: 'badversion1' }); return s; })(),
    spawn: stubSpawn({ fail: { error: 'decode failed', errorClass: 'DATA_DECODING' } }) });
  const run = await failing.worker.run({ trigger: TRIGGER.SCHEDULED });
  await settled(failing.worker);

  assert.equal(run.status, RUN_STATUS.FAILED);
  assert.equal(run.keptPreviousModel, true);
  assert.equal(activeVersion(db, { projectId: PROJECT, modelId: MODEL }).versionId, VERSION);
  await failing.worker.stop();
  await worker.stop();
  assert.ok(stub && clock);
});

test('a scheduled tick that arrives mid-conversion is SKIPPED, not run concurrently', async () => {
  const { worker, db } = createWorker();
  const running = worker.run({ trigger: TRIGGER.SCHEDULED });
  await flush(1);
  assert.ok(worker.inFlight);
  const second = await worker.run({ trigger: TRIGGER.SCHEDULED });
  assert.equal(second.status, RUN_STATUS.SKIPPED);
  await running;
  await settled(worker);
  const skipped = syncLog(db, { projectId: PROJECT, modelId: MODEL })
    .filter(entry => entry.status === RUN_STATUS.SKIPPED);
  assert.equal(skipped.length, 1, 'recorded, because it explains a gap in the history');
  await worker.stop();
});

test('a manual run mid-conversion joins it rather than starting a second download', async () => {
  const { worker, spawn } = createWorker();
  const first = worker.run({ trigger: TRIGGER.SCHEDULED });
  await flush(1);
  const joined = await worker.run({ trigger: TRIGGER.MANUAL });
  assert.equal(joined.coalesced, true);
  await first;
  await settled(worker);
  assert.equal(spawn.runs.length, 1, 'one conversion, not two');
  await worker.stop();
});

test('the worker does not start when disabled, and arms no timer', async () => {
  const { worker, clock, stub } = createWorker({
    env: { ...ENV, SPECKLE_AUTO_SYNC_ENABLED: 'false' } });
  const outcome = worker.start();
  assert.equal(outcome.started, false);
  assert.equal(worker.state, WORKER_STATE.DISABLED);
  assert.equal(clock.pending().length, 0);
  await clock.advance(10 * 60_000);
  assert.equal(stub.calls.length, 0);
  await worker.stop();
});

test('a missing token prevents polling entirely', async () => {
  const { worker, clock, stub } = createWorker({ env: { ...ENV, SPECKLE_API_TOKEN: '' } });
  assert.equal(worker.start().started, false);
  assert.equal(worker.state, WORKER_STATE.NOT_CONFIGURED);
  assert.equal(clock.pending().length, 0);
  await clock.advance(10 * 60_000);
  assert.equal(stub.calls.length, 0);
});

test('a rejected token parks the worker instead of retrying for ever', async () => {
  const stub = stubSpeckle();
  stub.state.fail = { status: 401, body: { errors: [{ message: 'nope',
    extensions: { code: 'UNAUTHORIZED' } }] } };
  const { worker, clock } = createWorker({ stub });
  worker.start();
  await settled(worker);
  assert.equal(worker.state, WORKER_STATE.AUTH_PARKED);
  assert.equal(clock.pending().length, 0);
  const asked = stub.calls.length;
  await clock.advance(60 * 60_000);
  assert.equal(stub.calls.length, asked, 'an hour later, still no retry');
  await worker.stop();
});

test('only one timer exists at any moment, across many cycles', async () => {
  const { worker, clock } = createWorker();
  worker.start();
  await settled(worker);
  for (let i = 0; i < 4; i += 1) {
    assert.equal(clock.pending().length, 1, `after ${i} cycles`);
    await clock.advance(60_000);
    await settled(worker);
  }
  await worker.stop();
});

test('the Speckle worker has its own registry key and does not disturb OpenProject\'s', () => {
  resetSyncWorkerRegistry();
  const api = createConstructionApi({ path: ':memory:', logger: quiet, autoSync: false,
    speckleOptions: { env: ENV, fetchImpl: stubSpeckle().fetchImpl },
    syncOptions: { workerKey: 'op-test' }, speckleSyncOptions: { workerKey: 'speckle-test' } });
  assert.equal(api.syncStatus().sourceSystem, 'OPENPROJECT');
  assert.equal(syncWorkerRefs('speckle-test'), 0, 'built lazily, on first use');
  resetSyncWorkerRegistry();
  void api;
});

/* ── the HTTP routes ───────────────────────────────────────────────────────────────────────── */

function createApi({ env = ENV, stub = stubSpeckle(), spawn = stubSpawn() } = {}) {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'speckle-api-'));
  const api = createConstructionApi({ path: ':memory:', logger: quiet, autoSync: false,
    speckleOptions: { env, fetchImpl: stub.fetchImpl, spawnImpl: spawn.impl, artifactRoot },
    speckleSyncOptions: { workerKey: `t-${Math.random().toString(36).slice(2)}`,
      manualMinIntervalMs: 0 },
    syncOptions: { workerKey: `o-${Math.random().toString(36).slice(2)}` } });
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    let status = null;
    let payload = null;
    let head = null;
    const res = {
      writeHead(code, headers2) { status = code; head = headers2; return this; },
      end(text) { try { payload = text ? JSON.parse(text) : null; } catch { payload = null; } },
      on() { return this; }, once() { return this; }, emit() { return this; },
      write() { return true; },
    };
    const req = { method, url: `/api/construction${path}`, headers,
      on(event, handler) {
        if (event === 'data' && body) handler(Buffer.from(JSON.stringify(body)));
        if (event === 'end') handler();
        return this;
      } };
    await api.handle(req, res);
    return { status, payload, head };
  };
  return { api, call, stub, spawn };
}

async function session(call, role = 'bimCoordinator') {
  const issued = await call('/session', { method: 'POST', body: { role } });
  return { 'x-demo-session': issued.payload.token };
}

test('GET /speckle/status reports the worker without calling Speckle', async () => {
  const { call, stub } = createApi();
  const { status, payload } = await call('/speckle/status');
  assert.equal(status, 200);
  assert.equal(payload.source.system, 'SPECKLE');
  assert.equal(payload.sourceSystem, 'SPECKLE');
  assert.equal(payload.activeVersion, null);
  assert.match(payload.scope, /Read-only/);
  assert.match(payload.cache, /immutable/);
  assert.equal(stub.calls.length, 0);
});

test('GET /speckle/model says plainly that nothing has been converted yet', async () => {
  const { call } = createApi();
  const { payload } = await call('/speckle/model');
  assert.equal(payload.active, null);
  assert.equal(payload.state, STATE.NOT_READ);
  assert.match(payload.reason, /Press Sync Now/);
});

test('POST /speckle/sync converts, and a second call does not', async () => {
  const { call, spawn } = createApi();
  const headers = await session(call);
  const first = await call('/speckle/sync', { method: 'POST', body: {}, headers });
  assert.equal(first.status, 200);
  assert.equal(first.payload.converted, true);
  assert.equal(first.payload.run.versionId, VERSION);
  assert.match(first.payload.effect, /No Speckle model was modified/);

  const second = await call('/speckle/sync', { method: 'POST', body: {}, headers });
  assert.equal(second.payload.unchanged, true);
  assert.equal(second.payload.converted, false);
  assert.equal(spawn.runs.length, 1, 'idempotent: one conversion for one version');
});

test('POST /speckle/sync needs a session and says who may instead', async () => {
  const { call } = createApi();
  const refused = await call('/speckle/sync', { method: 'POST', body: {} });
  assert.equal(refused.status, 403);
  assert.match(refused.payload.error, /No demo session/);
});

test('the model, element and type endpoints serve the converted data', async () => {
  const { call } = createApi();
  const headers = await session(call);
  await call('/speckle/sync', { method: 'POST', body: {}, headers });

  const model = await call('/speckle/model');
  assert.equal(model.payload.active.versionId, VERSION);
  assert.equal(model.payload.elementCount, 20);
  assert.equal(model.payload.geometryCount, 16);
  assert.equal(model.payload.glbUrl, `/api/construction/speckle/model.glb?version=${VERSION}`);
  assert.equal(model.payload.placement.longitude, DEFAULT_PLACEMENT.longitude);

  const beams = await call('/speckle/elements?ifcType=IfcBeam');
  assert.equal(beams.payload.elements.length, 6, 'the acceptance scenario\'s six beams');
  assert.ok(beams.payload.elements.every(entry => entry.ifcType === 'IfcBeam'));

  const element = await call(`/speckle/elements/${encodeURIComponent(TARGET_GUID)}`);
  assert.equal(element.status, 200);
  assert.equal(element.payload.element.ifcGuid, TARGET_GUID);
  assert.equal(element.payload.element.name, 'girder');
  assert.equal(element.payload.element.featureIndex, 0);

  const missing = await call('/speckle/elements/NOT_A_REAL_GUID');
  assert.equal(missing.status, 404);
});

test('the GLB route refuses a path and takes no filename from the caller', async () => {
  const { call } = createApi();
  const headers = await session(call);
  await call('/speckle/sync', { method: 'POST', body: {}, headers });
  for (const bad of ['../../etc/passwd', '..%2f..%2fetc%2fpasswd', 'a/b', '.', '..']) {
    const result = await call(`/speckle/model.glb?version=${encodeURIComponent(bad)}`);
    assert.equal(result.status, 400, `${bad} must be refused`);
  }
  // A well-formed id that was never converted is a 404, not a file read.
  const unknown = await call('/speckle/model.glb?version=deadbeef99');
  assert.equal(unknown.status, 404);
});

test('no Speckle route leaks the token', async () => {
  const { call } = createApi();
  const headers = await session(call);
  await call('/speckle/sync', { method: 'POST', body: {}, headers });
  const payloads = [];
  for (const path of ['/speckle/status', '/speckle/model', '/speckle/models', '/speckle/elements',
    `/speckle/elements/${encodeURIComponent(TARGET_GUID)}`]) {
    payloads.push((await call(path)).payload);
  }
  const serialized = JSON.stringify(payloads);
  assert.ok(!serialized.includes(TOKEN));
  assert.ok(!/Bearer [A-Za-z0-9]{10,}/.test(serialized));
});

test('an unknown Speckle route is a 404, not a surprise', async () => {
  const { call } = createApi();
  const result = await call('/speckle/anything-else');
  assert.equal(result.status, 404);
});

test('converting through the API leaves the synthetic demo untouched', async () => {
  const { call } = createApi();
  const headers = await session(call);
  const before = await call('/overview');
  await call('/speckle/sync', { method: 'POST', body: {}, headers });
  const after = await call('/overview');
  assert.deepEqual(after.payload.interfaces, before.payload.interfaces,
    'the five pilot interfaces report exactly what they did before');
  assert.deepEqual(after.payload.rows, before.payload.rows);
});

/* ── the frontend's pure parts ─────────────────────────────────────────────────────────────── */

test('the Cesium style shows everything when nothing is filtered', () => {
  assert.deepEqual(buildStyle(), { show: 'true' });
  assert.deepEqual(buildStyle({ visibleTypes: null }), { show: 'true' });
});

test('the style filters by IFC class and highlights the selected GUID', () => {
  const style = buildStyle({ visibleTypes: ['IfcBeam', 'IfcWall'], selectedGuid: TARGET_GUID });
  assert.equal(style.show, "${ifcType} === 'IfcBeam' || ${ifcType} === 'IfcWall'");
  assert.equal(style.color.conditions[0][0], `\${ifcGuid} === '${TARGET_GUID}'`);
  // The `$` in an IFC GlobalId must survive into the expression; it is part of the id.
  assert.ok(style.color.conditions[0][0].includes('$Q'));
  assert.equal(style.color.conditions[1][0], 'true');
});

test('a quote in a filter value cannot break out of the style expression', () => {
  const style = buildStyle({ visibleTypes: ["Ifc' || true || '"], selectedGuid: "a'b" });
  assert.ok(!style.show.includes("' || true || '"), 'quotes are stripped, not interpolated');
  assert.ok(!style.color.conditions[0][0].includes("a'b"));
});

test('the frontend vocabulary covers every state the worker reports', () => {
  for (const state of Object.values(WORKER_STATE)) {
    assert.ok(WORKER_LABEL[state], `${state} has a label`);
    assert.ok(['ok', 'warn', 'bad', 'info'].includes(WORKER_LABEL[state].tone));
  }
  for (const status of Object.values(RUN_STATUS)) {
    assert.ok(RUN_LABEL[status], `${status} has a label`);
  }
  // UNCHANGED is the normal, healthy answer and must not read as a problem.
  assert.equal(RUN_LABEL.UNCHANGED.tone, 'info');
  assert.ok(TYPE_COLOUR.IfcBeam);
});
