import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ConversionError, convertIfc, validateStep } from '../server/ifcSpatial/convert.mjs';
import { georeferencedPlacement, lccForward, lccInverse, modelToGrid, readGeoreference, stepArgs, SUPPORTED_CRS } from '../server/ifcSpatial/georef.mjs';
import { readGlb, readStringColumn } from '../server/ifcSpatial/glb.mjs';
import { cacheKey, createIfcSpatialApi, validatePlacement } from '../server/ifcSpatial/api.mjs';
import { downloadVersion } from '../server/aps/dataManagement.mjs';
import { ApsError } from '../server/aps/oauth.mjs';
import { calibratedMatrix, classifyEdit, defaultPlacement, geodeticToEcef, georeferencedMatrix, modelMatrixFor, PLACEMENT_MODE, transformPoint, enuBasis } from '../src/ifcSpatial/placement.js';

const IFC = readFileSync(new URL('./fixtures/ifc/minimal-georef.ifc', import.meta.url));
const IFC_TEXT = IFC.toString('latin1');
const withoutGeoref = Buffer.from(IFC_TEXT.replace(/^#1[78]=.*\n/gm, ''), 'latin1');
const quiet = { info() {}, warn() {}, error() {} };
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ---- file validation ----

test('a STEP file with an IFC schema is accepted; anything else is refused with a reason', () => {
  assert.equal(validateStep(IFC).schema, 'IFC4');
  assert.equal(validateStep(IFC).originatingSystem, 'acs-demo tests');
  assert.throws(() => validateStep(Buffer.from('PK\u0003\u0004 not a step file')), error => error instanceof ConversionError && error.code === 'INVALID_IFC');
  assert.throws(() => validateStep(IFC.subarray(0, IFC.length - 30)), error => error.code === 'INVALID_IFC' && /truncated/.test(error.message));
  assert.throws(() => validateStep(Buffer.from(IFC_TEXT.replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('AP214'))"), 'latin1')), error => error.code === 'UNSUPPORTED_SCHEMA');
});

// ---- georeferencing ----

test('STEP arguments split on top-level commas, keeping quotes and nested lists', () => {
  assert.deepEqual(stepArgs("('a,b',(1,2,3),$,.X.,'it''s')"), ["'a,b'", '(1,2,3)', '$', '.X.', "'it''s'"]);
});

test('IfcMapConversion, IfcProjectedCRS and IfcSite are read from the file', () => {
  const georef = readGeoreference(IFC_TEXT);
  assert.equal(georef.schema, 'IFC4');
  assert.equal(georef.lengthUnit, 'METRE');
  assert.deepEqual(georef.projectedCrs, { name: 'EPSG:26985', description: 'NAD83 / Maryland (metres)', geodeticDatum: 'NAD83', verticalDatum: 'NAVD88' });
  assert.equal(georef.mapConversion.eastings, 439753.887);
  assert.equal(georef.mapConversion.orthogonalHeight, 3);
  assert.ok(Math.abs(georef.site.refLatitude - 39.2568656664) < 1e-9);
  assert.ok(Math.abs(georef.site.refLongitude + 76.5394032694) < 1e-9);
  assert.equal(georef.supported, true);
});

test('EPSG:26985 projection: forward and inverse agree, and the map origin lands on the IfcSite reference point', () => {
  const crs = SUPPORTED_CRS['EPSG:26985'];
  const { lon, lat } = lccInverse(crs, 439753.887, 176622.063);
  const back = lccForward(crs, lon, lat);
  assert.ok(Math.abs(back.easting - 439753.887) < 1e-6 && Math.abs(back.northing - 176622.063) < 1e-6);
  // The projection's own origin (lat0, lon0) maps to (false easting, false northing).
  const origin = lccForward(crs, crs.lon0, crs.lat0);
  assert.ok(Math.abs(origin.easting - 400000) < 1e-6 && Math.abs(origin.northing) < 1e-6);
  const placement = georeferencedPlacement(readGeoreference(IFC_TEXT));
  assert.equal(placement.mode, 'IFC_GEOREFERENCED');
  assert.ok(placement.siteCheck.metresFromMapOrigin < 0.05, 'IfcMapConversion and IfcSite agree');
  assert.ok(Math.abs(placement.headingDeg) < 0.01, 'the file\'s grid rotation cancels the meridian convergence here');
});

test('IfcMapConversion: rotation and scale are applied to model x/y before the projection', () => {
  const conversion = { eastings: 1000, northings: 2000, orthogonalHeight: 0, xAxisAbscissa: 0, xAxisOrdinate: 2, scale: 0.5 };
  // A 90° rotation (abscissa 0, ordinate 1 after normalising) and half scale: model +x → grid north.
  assert.deepEqual(modelToGrid(conversion, 10, 0), { easting: 1000, northing: 2005 });
  assert.deepEqual(modelToGrid(conversion, 0, 10), { easting: 995, northing: 2000 });
});

test('no IfcMapConversion, or an unsupported CRS, is reported instead of guessed', () => {
  const none = georeferencedPlacement(readGeoreference(withoutGeoref.toString('latin1')));
  assert.equal(none.mode, 'UNGEOREFERENCED');
  assert.match(none.reason, /no IfcMapConversion/);
  const other = georeferencedPlacement(readGeoreference(IFC_TEXT.replace("'EPSG:26985'", "'EPSG:2248'")));
  assert.equal(other.mode, 'UNGEOREFERENCED');
  assert.match(other.reason, /EPSG:2248 is not supported/);
});

// ---- conversion: the file's own geometry, identifiers and properties ----

test('conversion: every IfcProduct listed, geometry placed in the IFC frame (metres, Z up)', async () => {
  const { elements, diagnostics } = await convertIfc(IFC, { sourceFile: 'minimal-georef.ifc', versionId: 'v1', versionNumber: 1 });
  assert.equal(diagnostics.elements, 4);
  assert.equal(diagnostics.withGeometry, 2);
  assert.equal(diagnostics.triangles, 24);
  assert.equal(diagnostics.library, 'web-ifc');
  assert.match(diagnostics.libraryVersion, /^\d+\.\d+\.\d+$/);
  const tx = elements.find(element => element.globalId === '3Ax9Lk0t95uO2QkM8XbJ1a');
  assert.equal(tx.ifcClass, 'IfcTransformer');
  assert.equal(tx.tag, 'TX-T');
  assert.equal(tx.predefinedType, 'VOLTAGE');
  assert.deepEqual(tx.bbox, { min: [8, -1.5, 0], max: [12, 1.5, 2] }, '4×3 profile at (10,0,0), extruded 2 m up');
  assert.equal(tx.networkId, 'TX-T');
  assert.equal(tx.voltageLevel, '13.8 kV');
  assert.deepEqual(tx.properties.SuperDNA_PowerNetwork, { NetworkID: 'TX-T', VoltageLevel: '13.8 kV', NetworkRole: 'Unit transformer' });
  const board = elements.find(element => element.ifcClass === 'IfcElectricDistributionBoard');
  assert.deepEqual(board.bbox, { min: [-1, 19.5, 0], max: [1, 20.5, 2.5] });
  const port = elements.find(element => element.ifcClass === 'IfcDistributionPort');
  assert.equal(port.featureId, null, 'an element without geometry is listed, not drawn');
  assert.equal(diagnostics.placement.mode, 'IFC_GEOREFERENCED');
});

test('conversion: the GLB keeps one feature per element, mapped to its IFC GlobalId', async () => {
  const { glb, elements } = await convertIfc(IFC, { sourceFile: 'minimal-georef.ifc' });
  const { json, bin } = readGlb(glb);
  assert.equal(json.asset.extras.upAxis, 'Z');
  assert.ok(json.extensionsUsed.includes('EXT_mesh_features') && json.extensionsUsed.includes('EXT_structural_metadata'));
  const table = json.extensions.EXT_structural_metadata.propertyTables[0];
  assert.equal(table.count, 2);
  const drawn = elements.filter(element => element.featureId !== null).sort((a, b) => a.featureId - b.featureId);
  assert.deepEqual(readStringColumn(glb, 'globalId'), drawn.map(element => element.globalId));
  assert.deepEqual(readStringColumn(glb, 'networkId'), drawn.map(element => element.networkId ?? ''));
  // Every vertex's feature id points at an element, and each element's vertices lie inside its own bbox.
  for (const primitive of json.meshes[0].primitives) {
    assert.equal(primitive.extensions.EXT_mesh_features.featureIds[0].featureCount, 2);
    const view = accessor => { const a = json.accessors[accessor]; const v = json.bufferViews[a.bufferView]; return new Float32Array(bin.buffer.slice(bin.byteOffset + v.byteOffset, bin.byteOffset + v.byteOffset + v.byteLength)); };
    const ids = view(primitive.attributes._FEATURE_ID_0), positions = view(primitive.attributes.POSITION);
    for (let i = 0; i < ids.length; i += 1) {
      const element = drawn[ids[i]];
      assert.ok(element, `feature ${ids[i]} exists`);
      for (let k = 0; k < 3; k += 1) assert.ok(positions[i * 3 + k] >= element.bbox.min[k] - 1e-4 && positions[i * 3 + k] <= element.bbox.max[k] + 1e-4);
    }
  }
});

test('conversion: no geometry, or not IFC, fails with a code and nothing is substituted', async () => {
  const empty = Buffer.from(IFC_TEXT.replace(/^#(3[0-9]|5[0-9])=.*\n/gm, '').replace('(#39,#57)', '()'), 'latin1');
  await assert.rejects(convertIfc(empty), error => error instanceof ConversionError && error.code === 'NO_GEOMETRY');
  await assert.rejects(convertIfc(Buffer.from('not an ifc file at all')), error => error.code === 'INVALID_IFC');
});

// ---- retrieval from Autodesk ----

test('download: version storage → signed S3 link → bytes, the signed link fetched without the Autodesk token', async () => {
  const calls = [];
  const client = { get: async (path) => {
    calls.push(path);
    if (path.startsWith('/data/v1/projects/b.p/versions/')) return { data: { attributes: { name: 'a.ifc', versionNumber: 3, storageSize: IFC.length }, relationships: { storage: { data: { id: 'urn:adsk.objects:os.object:wip.dm.prod/abc-123.ifc' } } } } };
    if (path === '/oss/v2/buckets/wip.dm.prod/objects/abc-123.ifc/signeds3download') return { url: 'https://s3.example/signed?x=1' };
    throw new Error(`unexpected ${path}`);
  } };
  let fetched;
  const fetchImpl = async (url, init) => { fetched = { url, init }; return { ok: true, arrayBuffer: async () => IFC.buffer.slice(IFC.byteOffset, IFC.byteOffset + IFC.length) }; };
  const file = await downloadVersion(client, 'b.p', 'urn:v?version=3', { fetchImpl });
  assert.equal(file.bytes.length, IFC.length);
  assert.equal(file.versionNumber, 3);
  assert.equal(calls[0], '/data/v1/projects/b.p/versions/urn%3Av%3Fversion%3D3');
  assert.equal(fetched.url, 'https://s3.example/signed?x=1');
  assert.equal(fetched.init.headers, undefined, 'no Authorization header goes to the signed URL');
  const noStorage = { get: async () => ({ data: { relationships: {} } }) };
  await assert.rejects(downloadVersion(noStorage, 'b.p', 'v'), error => error.code === 'NO_STORAGE');
});

// ---- the API: conversion cache, failures, placement ----

function harness({ bytes = IFC, versionId = 'urn:adsk.wipprod:fs.file:vf.A?version=1', signedIn = true } = {}) {
  const state = { downloads: 0, versionId, bytes, listings: [] };
  const files = () => ({ hub: { id: 'b.h', name: 'Hub' }, project: { id: 'b.p', name: 'Seagirt Electrical Digital Twin POC' }, generatedAt: '2026-11-23T00:00:00Z',
    files: [{ fileName: 'network.ifc', tipVersionId: state.versionId, versions: [{ id: state.versionId, versionNumber: Number(state.versionId.split('=')[1]) }] }] });
  const aps = {
    dataClient: () => { if (!signedIn) throw new ApsError('NOT_AUTHENTICATED', 401, 'Not signed in to Autodesk.'); return {}; },
    projectFiles: async (req, options = {}) => { state.listings.push(options); return files(); },
  };
  const api = createIfcSpatialApi({ aps, cacheDir: mkdtempSync(join(tmpdir(), 'ifc-spatial-')), logger: quiet,
    download: async () => { state.downloads += 1; return { bytes: state.bytes }; } });
  async function call(method, path, body) {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { method, url: path, headers: {} });
    let status, headers, payload;
    await api.handle(req, { writeHead(s, h) { status = s; headers = h; }, end(b) { payload = b; } });
    const json = String(headers?.['content-type'] ?? '').startsWith('application/json') ? JSON.parse(payload.toString()) : null;
    return { status, headers, raw: payload, json };
  }
  return { state, call };
}

test('api: a version is downloaded and converted once, then served from the cache', async () => {
  const h = harness();
  const first = await h.call('POST', '/api/ifc-spatial/prepare?file=network.ifc');
  assert.equal(first.status, 200);
  assert.equal(first.json.cached, false);
  assert.equal(first.json.key, cacheKey(h.state.versionId));
  assert.equal(first.json.placement.georeferenced.mode, 'IFC_GEOREFERENCED');
  const again = await h.call('POST', '/api/ifc-spatial/prepare?file=network.ifc');
  assert.equal(again.json.cached, true);
  assert.equal(h.state.downloads, 1, 'unchanged version: no second download or conversion');
  const glb = await h.call('GET', first.json.glbUrl);
  assert.equal(glb.headers['content-type'], 'model/gltf-binary');
  assert.equal(readGlb(glb.raw).json.extensions.EXT_structural_metadata.propertyTables[0].count, 2);
  const elements = (await h.call('GET', first.json.elementsUrl)).json;
  assert.equal(elements.elements.length, 4);
  assert.equal((await h.call('GET', '/api/ifc-spatial/models')).json.models[0].status, 'converted');
  // A new Autodesk version converts again; ?force=1 redoes the same version.
  h.state.versionId = 'urn:adsk.wipprod:fs.file:vf.A?version=2';
  const next = await h.call('POST', '/api/ifc-spatial/prepare?file=network.ifc');
  assert.equal(next.json.cached, false);
  assert.notEqual(next.json.key, first.json.key);
  await h.call('POST', '/api/ifc-spatial/prepare?file=network.ifc&force=1');
  assert.equal(h.state.downloads, 3);
});

test('api: a failed conversion answers with its code, is recorded, and serves no geometry', async () => {
  const h = harness({ bytes: Buffer.from('<html>not ifc</html>') });
  const failed = await h.call('POST', '/api/ifc-spatial/prepare?file=network.ifc');
  assert.equal(failed.status, 422);
  assert.equal(failed.json.error.code, 'INVALID_IFC');
  const models = (await h.call('GET', '/api/ifc-spatial/models')).json.models;
  assert.equal(models[0].status, 'failed');
  assert.equal(models[0].error.code, 'INVALID_IFC');
  assert.equal((await h.call('GET', `/api/ifc-spatial/cache/${models[0].key}/model.glb`)).status, 404);
  assert.equal((await h.call('POST', '/api/ifc-spatial/prepare?file=other.ifc')).json.error.code, 'FILE_NOT_FOUND');
});

test('api: every route needs the Autodesk sign-in', async () => {
  const h = harness({ signedIn: false });
  for (const [method, path] of [['GET', '/api/ifc-spatial/models'], ['POST', '/api/ifc-spatial/prepare?file=network.ifc'], ['GET', `/api/ifc-spatial/cache/${'a'.repeat(24)}/model.glb`]]) {
    const response = await h.call(method, path);
    assert.equal(response.status, 401);
    assert.equal(response.json.error.code, 'NOT_AUTHENTICATED');
  }
});

test('api: placements persist per model version, are validated, and can be removed', async () => {
  const h = harness();
  const { key } = (await h.call('POST', '/api/ifc-spatial/prepare?file=network.ifc')).json;
  assert.equal((await h.call('GET', `/api/ifc-spatial/placement?key=${key}`)).json.saved, null);
  const placement = { mode: 'USER_CALIBRATED', lon: -76.54, lat: 39.25, heightOffset: 1.5, headingDeg: -35, scale: 1 };
  const saved = await h.call('PUT', `/api/ifc-spatial/placement?key=${key}`, placement);
  assert.deepEqual(saved.json.saved, placement);
  assert.deepEqual((await h.call('GET', `/api/ifc-spatial/placement?key=${key}`)).json.saved, placement);
  assert.deepEqual((await h.call('POST', '/api/ifc-spatial/prepare?file=network.ifc')).json.placement.saved, placement);
  // Another version of the same file starts without it.
  h.state.versionId = 'urn:adsk.wipprod:fs.file:vf.A?version=2';
  const next = (await h.call('POST', '/api/ifc-spatial/prepare?file=network.ifc')).json;
  assert.equal(next.placement.saved, null);
  const bad = await h.call('PUT', `/api/ifc-spatial/placement?key=${key}`, { ...placement, lat: 123, mode: 'GUESSED' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error.message, /lat must be/);
  assert.match(bad.json.error.message, /mode must be/);
  await h.call('DELETE', `/api/ifc-spatial/placement?key=${key}`);
  assert.equal((await h.call('GET', `/api/ifc-spatial/placement?key=${key}`)).json.saved, null);
  assert.throws(() => validatePlacement({ ...placement, scale: 0 }), /scale must be/);
});

// ---- placement on the globe (src/ifcSpatial/placement.js) ----

const georef = georeferencedPlacement(readGeoreference(IFC_TEXT));

test('placement: the georeferenced matrix puts model +x / +y on the file\'s projected points', () => {
  const m = georeferencedMatrix(georef, 10);
  const at = (lon, lat) => geodeticToEcef(lon, lat, 10);
  assert.ok(distance(transformPoint(m, [0, 0, 0]), at(georef.origin.lon, georef.origin.lat)) < 1e-6);
  assert.ok(distance(transformPoint(m, [100, 0, 0]), at(georef.xAxis.lon, georef.xAxis.lat)) < 0.01);
  assert.ok(distance(transformPoint(m, [0, 100, 0]), at(georef.yAxis.lon, georef.yAxis.lat)) < 0.01);
  // z is the local vertical.
  const up = enuBasis(georef.origin.lon, georef.origin.lat).up;
  const lifted = transformPoint(m, [0, 0, 5]), base = transformPoint(m, [0, 0, 0]);
  assert.ok(distance(lifted, base.map((v, i) => v + up[i] * 5)) < 1e-6);
});

test('placement: a calibration turns clockwise from east, scales, and is labelled user-calibrated', () => {
  const lon = -76.54, lat = 39.25;
  const { east, north } = enuBasis(lon, lat);
  const along = (m, v) => { const d = transformPoint(m, v).map((c, i) => c - transformPoint(m, [0, 0, 0])[i]); return [d[0] * east[0] + d[1] * east[1] + d[2] * east[2], d[0] * north[0] + d[1] * north[1] + d[2] * north[2]]; };
  const [e0, n0] = along(calibratedMatrix({ lon, lat, height: 0, headingDeg: 0 }), [10, 0, 0]);
  assert.ok(Math.abs(e0 - 10) < 1e-6 && Math.abs(n0) < 1e-6, 'heading 0: +x east');
  const [e90, n90] = along(calibratedMatrix({ lon, lat, height: 0, headingDeg: 90 }), [10, 0, 0]);
  assert.ok(Math.abs(e90) < 1e-6 && Math.abs(n90 + 10) < 1e-6, 'heading 90: +x south');
  const [e2] = along(calibratedMatrix({ lon, lat, height: 0, scale: 2 }), [10, 0, 0]);
  assert.ok(Math.abs(e2 - 20) < 1e-6);
  const base = defaultPlacement(georef);
  assert.equal(base.mode, PLACEMENT_MODE.GEOREFERENCED);
  assert.equal(classifyEdit(georef, { ...base, heightOffset: 2 }).mode, PLACEMENT_MODE.GEOREFERENCED, 'a height offset keeps the file\'s georeferencing');
  assert.equal(classifyEdit(georef, { ...base, headingDeg: 10 }).mode, PLACEMENT_MODE.CALIBRATED);
  assert.equal(classifyEdit({ mode: 'UNGEOREFERENCED' }, { ...base }).mode, PLACEMENT_MODE.CALIBRATED);
  assert.equal(defaultPlacement({ mode: 'UNGEOREFERENCED' }), null, 'no georeferencing: no invented starting point');
});

test('placement: the model origin sits on the terrain height plus the offset', () => {
  const m = modelMatrixFor({ ...defaultPlacement(georef), heightOffset: 2 }, georef, 30);
  assert.ok(distance(transformPoint(m, [0, 0, 0]), geodeticToEcef(georef.origin.lon, georef.origin.lat, 32)) < 1e-6);
  const calibrated = modelMatrixFor({ mode: PLACEMENT_MODE.CALIBRATED, lon: -76.5, lat: 39.2, heightOffset: 0, headingDeg: 0, scale: 1 }, georef, 5);
  assert.ok(distance(transformPoint(calibrated, [0, 0, 0]), geodeticToEcef(-76.5, 39.2, 5)) < 1e-6);
});

test('reference alignment: the committed calibration puts both quay control points on their OpenStreetMap coordinates', () => {
  const reference = JSON.parse(readFileSync(new URL('../public/data/seagirt/ifc-reference-alignment.json', import.meta.url), 'utf8'));
  assert.equal(reference.placement.mode, 'USER_CALIBRATED', 'a fit to the terminal is a calibration, never labelled as the file\'s georeferencing');
  const m = calibratedMatrix({ ...reference.placement, height: 0 });
  for (const point of reference.controlPoints) {
    // IFC metres from reference-image pixels: x = (px - 974) * 5/3, y = -(py - 456) * 5/3.
    const [px, py] = point.imagePx;
    const ifc = [(px - 974) * 5 / 3, -(py - 456) * 5 / 3, 0];
    const misfit = distance(transformPoint(m, ifc), geodeticToEcef(point.lonLat[0], point.lonLat[1], 0));
    assert.ok(misfit < 1.5, `${point.name}: ${misfit.toFixed(2)} m from its OpenStreetMap position`);
  }
});

test('conversion: cable routes follow the IFC placement chain (explicit axes), and port relations become directed connections', async () => {
  const extra = [
    // A cable placed at (5, 5, 0) with its x axis along model +y, swept along local (0,0,0) → (10,0,0).
    "#80=IFCCARTESIANPOINT((5.,5.,0.));", '#81=IFCDIRECTION((0.,0.,1.));', '#82=IFCDIRECTION((0.,1.,0.));', '#83=IFCAXIS2PLACEMENT3D(#80,#81,#82);', '#84=IFCLOCALPLACEMENT(#21,#83);',
    '#85=IFCCARTESIANPOINT((0.,0.,0.));', '#86=IFCCARTESIANPOINT((10.,0.,0.));', '#87=IFCPOLYLINE((#85,#86));', '#88=IFCSWEPTDISKSOLID(#87,0.2,$,$,$);',
    "#89=IFCSHAPEREPRESENTATION(#15,'Body','AdvancedSweptSolid',(#88));", '#90=IFCPRODUCTDEFINITIONSHAPE($,$,(#89));',
    "#91=IFCCABLESEGMENT('1Cb7Yh2Fq3Lm9Pn0Qr4St5',$,'C-T test cable',$,$,#84,#90,'C-T',.CABLESEGMENT.);",
    // The transformer's SOURCE port joined to the cable's SINK port.
    "#92=IFCDISTRIBUTIONPORT('2Ab3Cd4Ef5Gh6Ij7Kl8Mn9',$,$,$,$,$,$,.SOURCE.,.CABLE.,.ELECTRICAL.);", "#93=IFCDISTRIBUTIONPORT('3Bc4De5Fg6Hi7Jk8Lm9No0',$,$,$,$,$,$,.SINK.,.CABLE.,.ELECTRICAL.);",
    "#94=IFCRELNESTS('0Zy1Xw2Vu3Ts4Rq5Po6Nm7',$,$,$,#39,(#92));", "#95=IFCRELNESTS('1Yx2Wv3Ut4Sr5Qp6On7Ml8',$,$,$,#91,(#93));",
    "#96=IFCRELCONNECTSPORTS('2Xw3Vu4Ts5Rq6Po7Nm8Lk9',$,$,$,#92,#93,$);", "#97=IFCRELCONNECTSPORTS('0Wv4Ut5Sr6Qp7On8Ml9Kj0',$,$,$,#93,#92,$);",
  ].join('\n');
  const ifc = Buffer.from(IFC_TEXT.replace('ENDSEC;\nEND-ISO-10303-21;', `${extra}\nENDSEC;\nEND-ISO-10303-21;`), 'latin1');
  const { elements, connections, diagnostics } = await convertIfc(ifc);
  const cable = elements.find(element => element.globalId === '1Cb7Yh2Fq3Lm9Pn0Qr4St5');
  assert.deepEqual(cable.route, [[5, 5, 0], [5, 15, 0]], 'local +x maps to the placement\'s RefDirection (model +y)');
  assert.equal(diagnostics.routes, 1);
  assert.deepEqual(connections, [{ from: '3Ax9Lk0t95uO2QkM8XbJ1a', to: '1Cb7Yh2Fq3Lm9Pn0Qr4St5', twoWay: false, fromFlow: 'SOURCE', toFlow: 'SINK',
    fromPort: '2Ab3Cd4Ef5Gh6Ij7Kl8Mn9', toPort: '3Bc4De5Fg6Hi7Jk8Lm9No0' }],
    'one connection per port pair (the file records it both ways), SOURCE → SINK');
});

test('the version check: /models?refresh=1 re-reads ACC, and a new tip version is reported as not converted', async () => {
  const h = harness();
  await h.call('POST', '/api/ifc-spatial/prepare?file=network.ifc');
  await h.call('GET', '/api/ifc-spatial/models');
  assert.equal(h.state.listings.at(-1).refresh, false);
  h.state.versionId = 'urn:adsk.wipprod:fs.file:vf.A?version=2';
  const { json } = await h.call('GET', '/api/ifc-spatial/models?refresh=1');
  assert.equal(h.state.listings.at(-1).refresh, true);
  assert.equal(json.models[0].versionNumber, 2);
  assert.equal(json.models[0].status, 'not_converted');
});

test('api: Select Area resolves membership on the server from the cached elements and the placement, and refuses bad areas', async () => {
  const h = harness();
  const prepared = (await h.call('POST', '/api/ifc-spatial/prepare?file=network.ifc')).json;
  const elements = (await h.call('GET', prepared.elementsUrl)).json.elements;
  const placement = { mode: 'USER_CALIBRATED', lon: -76.54, lat: 39.25, heightOffset: 0, headingDeg: 0, scale: 1 };
  const d = 0.05; // a box of roughly 8 × 11 km around the placement origin
  const geometry = { type: 'Polygon', coordinates: [[[-76.54 - d, 39.25 - d], [-76.54 + d, 39.25 - d], [-76.54 + d, 39.25 + d], [-76.54 - d, 39.25 + d], [-76.54 - d, 39.25 - d]]] };
  const ok = await h.call('POST', '/api/ifc-spatial/area?file=network.ifc', { key: prepared.key, geometry, placement });
  assert.equal(ok.status, 200);
  const ids = new Set(elements.filter(e => !['IfcDistributionPort', 'IfcSite', 'IfcElementAssembly'].includes(e.ifcClass)).map(e => e.networkId ?? e.tag).filter(Boolean));
  assert.equal(Object.keys(ok.json.relations).length, ids.size);
  assert.equal(ok.json.outside, 0);
  assert.equal(ok.json.coordinateSystem, 'EPSG:4326');
  assert.match(ok.json.selectionId, /^area-[0-9a-f]{8}$/);
  const far = await h.call('POST', '/api/ifc-spatial/area?file=network.ifc', { key: prepared.key, placement,
    geometry: { type: 'Polygon', coordinates: [[[-70, 30], [-69.99, 30], [-69.99, 30.01], [-70, 30.01]]] } });
  assert.equal(far.json.within.length + far.json.intersects.length + far.json.crosses.length, 0, 'an area elsewhere holds nothing');
  const crossing = await h.call('POST', '/api/ifc-spatial/area?file=network.ifc', { key: prepared.key, placement,
    geometry: { type: 'Polygon', coordinates: [[[-76.6, 39.2], [-76.5, 39.3], [-76.5, 39.2], [-76.6, 39.3]]] } });
  assert.equal(crossing.status, 400);
  assert.equal(crossing.json.error.code, 'INVALID_AREA');
  assert.equal((await h.call('POST', '/api/ifc-spatial/area?file=network.ifc', { key: 'nope', geometry, placement })).status, 400);
  assert.equal((await h.call('POST', '/api/ifc-spatial/area?file=network.ifc', { key: prepared.key, geometry, placement: { mode: 'X' } })).json.error.code, 'INVALID_PLACEMENT');
});
