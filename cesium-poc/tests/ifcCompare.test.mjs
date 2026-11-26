import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { compareVersions } from '../server/ifcSpatial/compare.mjs';
import { convertIfc } from '../server/ifcSpatial/convert.mjs';
import { createIfcSpatialApi } from '../server/ifcSpatial/api.mjs';
import { ApsError } from '../server/aps/oauth.mjs';

// ---- synthetic versions: just the fields the converter writes ----

let next = 0;
const gid = () => `0${String(next++).padStart(21, 'A')}`;
function el(networkId, { globalId = gid(), ifcClass = 'IfcLightFixture', origin = [0, 0, 0], signature = 'shape-1', props = {}, name = networkId, xAxis = [1, 0, 0], route, hostGlobalId } = {}) {
  return { globalId, ifcClass, name, tag: networkId, networkId, networkRole: ifcClass === 'IfcLightFixture' ? 'High-mast light' : null,
    properties: { SuperDNA_PowerNetwork: { NetworkID: networkId, ...props } }, placement: { origin, xAxis, zAxis: [0, 0, 1] },
    geometry: { signature, triangles: 12, localExtent: { min: [0, 0, 0], max: [1, 1, 1] } }, ...(route ? { route } : {}), ...(hostGlobalId ? { hostGlobalId } : {}) };
}
const version = (n, elements, extra = {}) => ({ versionNumber: n, elements, connections: [], georeference: null, lengthUnitScale: 1, ...extra });
const clone = e => JSON.parse(JSON.stringify(e));
const network = () => [el('HM-1', { origin: [0, 0, 0] }), el('HM-2', { origin: [40, 0, 0] }), el('TX-1', { ifcClass: 'IfcTransformer', origin: [10, 20, 0], signature: 'tx' }),
  el('UTIL-A', { ifcClass: 'IfcElectricDistributionBoard', origin: [-100, 50, 0], signature: 'board' })];
const only = (r, status) => r.changes.filter(c => c.status === status);

test('identical versions: zero changes', () => {
  const v1 = network();
  const r = compareVersions(version(1, v1), version(2, v1.map(clone)));
  assert.deepEqual([r.summary.total, r.summary.unchanged], [0, 4]);
  assert.equal(r.frame, 'MODEL');
});

test('one asset moved, same GlobalId: MOVED with the distance', () => {
  const v1 = network();
  const v2 = v1.map(clone);
  v2[3].placement.origin = [-100, 350, 0];
  const r = compareVersions(version(1, v1), version(2, v2));
  assert.equal(r.summary.moved, 1);
  const [c] = only(r, 'MOVED');
  assert.equal(c.networkId, 'UTIL-A');
  assert.equal(c.displacement.distanceM, 300);
  assert.equal(c.modified, false);
  assert.deepEqual(c.before.model, [-100, 50, 0]);
  assert.deepEqual(c.after.model, [-100, 350, 0]);
});

test('two assets added and one removed', () => {
  const v1 = network();
  const v2 = [...v1.slice(0, 3).map(clone), el('HM-12', { origin: [200, 0, 0] }), el('HM-13', { origin: [240, 0, 0] })];
  const r = compareVersions(version(1, v1), version(2, v2));
  assert.deepEqual([r.summary.added, r.summary.removed, r.summary.moved, r.summary.modified], [2, 1, 0, 0]);
  assert.deepEqual(only(r, 'ADDED').map(c => c.networkId), ['HM-12', 'HM-13']);
  assert.equal(only(r, 'ADDED')[0].kind, 'light');
  assert.equal(only(r, 'REMOVED')[0].networkId, 'UTIL-A');
});

test('modified without movement: a property and a geometry change, each named', () => {
  const v1 = network();
  const v2 = v1.map(clone);
  v2[0].properties.SuperDNA_PowerNetwork.DemandkW = 2;
  v2[2].geometry = { signature: 'tx-bigger', triangles: 24, localExtent: { min: [0, 0, 0], max: [2, 1, 1] } };
  const r = compareVersions(version(1, v1), version(2, v2));
  assert.deepEqual([r.summary.modified, r.summary.moved], [2, 0]);
  const hm1 = r.changes.find(c => c.networkId === 'HM-1');
  assert.deepEqual(hm1.modifications[0].changes, [{ key: 'SuperDNA_PowerNetwork.DemandkW', group: 'property', before: null, after: 2 }]);
  assert.equal(r.changes.find(c => c.networkId === 'TX-1').modifications[0].kind, 'geometry');
});

test('moved and modified: both kept', () => {
  const v1 = network();
  const v2 = v1.map(clone);
  v2[3].placement.origin = [-90, 50, 0];
  v2[3].name = 'UTIL-A Utility intake (relocated)';
  const r = compareVersions(version(1, v1), version(2, v2));
  const [c] = r.changes;
  assert.equal(c.status, 'MOVED');
  assert.equal(c.moved, true);
  assert.equal(c.modified, true);
  assert.equal(c.displacement.distanceM, 10);
  assert.equal(c.modifications[0].changes[0].key, 'name');
  assert.equal(r.summary.movedAndModified, 1);
});

test('differences below the tolerance are ignored: floating-point noise, a re-export', () => {
  const v1 = network();
  const v2 = v1.map(clone);
  v2[0].placement.origin = [0.01, -0.02, 0.001];
  v2[1].properties.SuperDNA_PowerNetwork.DemandkW = 1.0000000001;
  v1[1].properties.SuperDNA_PowerNetwork.DemandkW = 1;
  v2[2].properties.SuperDNA_PowerNetwork.Note = '  same   text ';
  v1[2].properties.SuperDNA_PowerNetwork.Note = 'same text';
  assert.equal(compareVersions(version(1, v1), version(2, v2)).summary.total, 0);
  // A larger tolerance is honoured too.
  v2[3].placement.origin = [-99.7, 50, 0];
  assert.equal(compareVersions(version(1, v1), version(2, v2), { moveToleranceM: 0.5 }).summary.total, 0);
  assert.equal(compareVersions(version(1, v1), version(2, v2)).summary.moved, 1);
});

test('different unit scales: positions are compared in metres through each map conversion', () => {
  const georef = scale => ({ projectedCrs: { name: 'EPSG:26985' }, mapConversion: { eastings: 439753.887, northings: 176622.063, orthogonalHeight: 3, xAxisAbscissa: 1, xAxisOrdinate: 0, scale } });
  const v1 = network();
  // Version 2 exported in millimetres: the converter already writes metres; the map conversion's
  // scale (0.001, per millimetre) must be read per model unit.
  const r = compareVersions(version(1, v1, { georeference: georef(1) }), version(2, v1.map(clone), { georeference: georef(0.001), lengthUnitScale: 0.001 }));
  assert.equal(r.frame, 'PROJECTED');
  assert.equal(r.summary.total, 0);
});

test('a model origin change is not reported as moved assets; a real move on top of it still is', () => {
  const v1 = network();
  const shift = ([x, y, z]) => [x + 100, y + 50, z];
  const v2 = v1.map(clone).map(e => ({ ...e, placement: { ...e.placement, origin: shift(e.placement.origin) } }));
  v2[3].placement.origin = shift([-100, 80, 0]);
  const r = compareVersions(version(1, v1), version(2, v2));
  assert.deepEqual(r.originShift.vector, [100, 50, 0]);
  assert.equal(r.summary.moved, 1);
  assert.equal(only(r, 'MOVED')[0].displacement.distanceM, 30);
  assert.match(r.warnings.join(' '), /model origin/);
  // A changed IfcMapConversion with the model re-based under it: the same places on the map, no movement.
  const georef = (e, n) => ({ projectedCrs: { name: 'EPSG:26985' }, mapConversion: { eastings: e, northings: n, orthogonalHeight: 3, xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1 } });
  const rebased = v1.map(clone).map(e => ({ ...e, placement: { ...e.placement, origin: [e.placement.origin[0] - 100, e.placement.origin[1] - 50, 0] } }));
  const g = compareVersions(version(1, v1, { georeference: georef(1000, 2000) }), version(2, rebased, { georeference: georef(1100, 2050) }));
  assert.equal(g.summary.total, 0);
  assert.equal(g.originShift, null);
  assert.match(g.notes.join(' '), /georeference .* changed/);
});

test('changed GlobalIds: a strong unique match is accepted with its confidence; an ambiguous one is not', () => {
  const v1 = network();
  const v2 = v1.map(clone);
  v2[2].globalId = gid();
  let r = compareVersions(version(1, v1), version(2, v2));
  assert.equal(r.summary.total, 1);
  const c = r.changes[0];
  assert.equal(c.status, 'MODIFIED');
  assert.equal(c.match.by, 'SECONDARY');
  assert.ok(c.match.confidence >= 0.8 && c.match.reasons.includes('same NetworkID'));
  assert.match(r.warnings.join(' '), /matched by NetworkID/);
  // Two unnamed lights swapped for two new ones next to them: no automatic match.
  const a = [el(null, { origin: [0, 0, 0], name: 'Light' }), el(null, { origin: [3, 0, 0], name: 'Light' })];
  const b = [el(null, { origin: [0.5, 0, 0], name: 'Light' }), el(null, { origin: [3.5, 0, 0], name: 'Light' })];
  r = compareVersions(version(1, a), version(2, b));
  assert.deepEqual([r.summary.added, r.summary.removed], [2, 2]);
  assert.ok(r.changes.every(x => x.possibleMatch && x.possibleMatch.confidence < 0.8));
});

test('ports count on their element; spatial structure is left out; cables: re-route vs shifted route', () => {
  const tx = el('TX-6', { ifcClass: 'IfcTransformer', signature: 'tx' });
  const cable = el('C-1', { ifcClass: 'IfcCableSegment', route: [[0, 0, -1], [100, 0, -1], [100, 50, -1]], signature: 'c' });
  const v1 = [tx, cable, { globalId: gid(), ifcClass: 'IfcSite', name: 'Site' }, el(null, { ifcClass: 'IfcDistributionPort', hostGlobalId: tx.globalId })];
  const v2 = v1.map(clone);
  v2.push(el(null, { ifcClass: 'IfcDistributionPort', hostGlobalId: tx.globalId }));
  v2[1].route = [[0, 0, -1], [100, 0, -1], [130, 0, -1], [130, 50, -1]];
  let r = compareVersions(version(1, v1), version(2, v2));
  assert.equal(r.base.elements, 2);
  assert.deepEqual(r.changes.map(c => [c.networkId, c.status, c.modifications.map(m => m.kind).join()]).sort(), [['C-1', 'MODIFIED', 'route'], ['TX-6', 'MODIFIED', 'ports']]);
  // The whole route shifted 20 m: a move, not a re-route.
  const v3 = v1.map(clone);
  v3[1].route = v1[1].route.map(([x, y, z]) => [x, y + 20, z]);
  r = compareVersions(version(1, v1), version(2, v3));
  assert.equal(r.changes[0].status, 'MOVED');
  assert.equal(r.changes[0].displacement.distanceM, 20);
});

test('a property set added to every element is one model-wide change; an odd value stays with its element', () => {
  const v1 = Array.from({ length: 30 }, (_, i) => el(`HM-${i}`, { origin: [i * 10, 0, 0] }));
  const v2 = v1.map(clone).map((e, i) => ({ ...e, properties: { ...e.properties, Pset_Warranty: { Supplier: i === 7 ? 'Other Co' : 'Acme', WarrantyYears: 5 } } }));
  const r = compareVersions(version(1, v1), version(2, v2));
  assert.equal(r.summary.modified, 30);
  assert.equal(r.summary.onlyModelWide, 29);
  assert.deepEqual(r.modelWide.map(g => [g.kind, g.pset, g.elements]), [['PSET_ADDED', 'Pset_Warranty', 30]]);
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].networkId, 'HM-7');
  assert.deepEqual(r.changes[0].modifications[0].changes.map(p => [p.key, p.after]), [['Pset_Warranty.Supplier', 'Other Co']]);
});

test('status is not a version change: an element whose only difference is its status is unchanged, and listed as a status update', () => {
  const v1 = network();
  const v2 = v1.map(clone);
  // As between the ACC versions: the status property set and a status note in the description.
  v2[0].properties.SuperDNA_AssetStatus = { PowerStatus: 'No power', StatusFlag: 'NO POWER', StatusDate: '2026-11-24' };
  v2[0].description = 'NO POWER: Floodlight head supply fault (illustrative).';
  v2[2].properties.Pset_Condition = { AssessmentCondition: 'Poor' };
  // Status plus a real change: only the real change counts.
  v2[1].properties.SuperDNA_AssetStatus = { PowerStatus: 'Powered' };
  v2[1].properties.SuperDNA_PowerNetwork.DemandkW = 3;
  const r = compareVersions(version(1, v1), version(2, v2));
  assert.equal(r.summary.total, 1);
  assert.equal(r.changes[0].networkId, 'HM-2');
  assert.deepEqual(r.changes[0].modifications[0].changes.map(p => p.key), ['SuperDNA_PowerNetwork.DemandkW']);
  assert.equal(r.summary.statusOnly, 2);
  assert.deepEqual(r.statusUpdates.map(u => u.networkId).sort(), ['HM-1', 'HM-2', 'TX-1']);
  // A description change that is not a status note is still a change.
  const v3 = v1.map(clone);
  v3[3].description = 'Relocated intake';
  assert.equal(compareVersions(version(1, v1), version(2, v3)).summary.modified, 1);
});

// ---- the real files: seagirt_power_network_status.ifc → _status_v2.ifc ----

const V1 = readFileSync(new URL('./fixtures/ifc/seagirt-compare-v1.ifc', import.meta.url));
const V2 = readFileSync(new URL('./fixtures/ifc/seagirt-compare-v2.ifc', import.meta.url));

function harness() {
  const ids = ['urn:adsk.wipprod:fs.file:vf.N?version=1', 'urn:adsk.wipprod:fs.file:vf.N?version=2'];
  const files = { hub: { id: 'b.h' }, project: { id: 'b.p', name: 'Seagirt' }, files: [{ fileName: 'seagirt_power_network.ifc', itemId: 'urn:item:N', tipVersionId: ids[1],
    versions: [{ id: ids[1], versionNumber: 2, createTime: '2026-11-24T06:11:00Z', createUserName: 'Test User' }, { id: ids[0], versionNumber: 1, createTime: '2026-11-23T07:24:00Z', createUserName: 'Test User' }] }] };
  const downloads = [];
  const api = createIfcSpatialApi({ aps: { dataClient: () => ({}), projectFiles: async () => files }, cacheDir: mkdtempSync(join(tmpdir(), 'ifc-compare-')), logger: { info() {}, warn() {}, error() {} },
    download: async (client, project, versionId) => { downloads.push(versionId); return { bytes: versionId === ids[0] ? V1 : V2 }; } });
  async function call(method, path) {
    const req = Readable.from([]);
    Object.assign(req, { method, url: path, headers: {} });
    let status, payload;
    await api.handle(req, { writeHead(s) { status = s; }, end(b) { payload = b; } });
    return { status, json: JSON.parse(String(payload)) };
  }
  return { call, downloads };
}

test('the real versions: HM-12 and HM-13 added, UTIL-A moved 515 m; what else changed is reported, not hidden', async () => {
  const h = harness();
  const versions = await h.call('GET', '/api/ifc-spatial/versions?file=seagirt_power_network.ifc');
  assert.equal(versions.status, 200);
  assert.deepEqual(versions.json.versions.map(v => [v.versionNumber, v.latest, v.status]), [[2, true, 'not_converted'], [1, false, 'not_converted']]);
  assert.equal(versions.json.versions[0].createUserName, 'Test User');

  const { status, json } = await h.call('POST', '/api/ifc-spatial/compare?file=seagirt_power_network.ifc&base=1&target=2');
  assert.equal(status, 200);
  assert.equal(json.frame, 'PROJECTED');
  assert.deepEqual(json.summary, { added: 4, removed: 0, moved: 1, modified: 2, movedAndModified: 1, unchanged: 188, total: 7, listed: 7, onlyModelWide: 0, statusOnly: 1 });
  const lights = json.changes.filter(c => c.status === 'ADDED' && c.kind === 'light');
  assert.deepEqual(lights.map(c => [c.networkId, c.ifcClass]), [['HM-12', 'IfcLightFixture'], ['HM-13', 'IfcLightFixture']]);
  assert.ok(lights.every(c => c.after.geographic.lat > 39.25 && c.after.geographic.lon < -76.54), 'located at Seagirt');
  const moved = json.changes.find(c => c.status === 'MOVED');
  assert.equal(moved.networkId, 'UTIL-A');
  assert.ok(Math.abs(moved.displacement.distanceM - 515.46) < 0.1);
  assert.ok(moved.before.geographic && moved.after.geographic);
  // Also in the file: the new lights' feeder cables, the re-routed utility cable, TX-6's new ports, TX-M2's failure-impact text.
  assert.deepEqual(json.changes.filter(c => c.status === 'ADDED' && c.kind === 'cable').map(c => c.networkId), ['L6e', 'L6f']);
  // TX-M2's failure-impact note is status (SuperDNA_AssetStatus): listed as a status update, not a change.
  assert.deepEqual(json.changes.filter(c => c.status === 'MODIFIED').map(c => [c.networkId, c.modifications.map(m => m.kind).join()]),
    [['C-UA', 'route,properties'], ['TX-6', 'ports']]);
  assert.ok(json.statusUpdates.some(u => u.networkId === 'TX-M2'));
  assert.ok(moved.relatedChanges.length === 1, 'UTIL-A points at its re-routed cable');
  assert.deepEqual(h.downloads.length, 2);

  // Cached: no second download or conversion.
  const again = await h.call('POST', '/api/ifc-spatial/compare?file=seagirt_power_network.ifc&base=1&target=2');
  assert.equal(again.json.cached, true);
  assert.equal(h.downloads.length, 2);
});

test('the compare endpoint refuses the same version twice and a version that is not this file\'s', async () => {
  const h = harness();
  assert.equal((await h.call('POST', '/api/ifc-spatial/compare?file=seagirt_power_network.ifc&base=2&target=2')).json.error.code, 'SAME_VERSION');
  assert.equal((await h.call('POST', '/api/ifc-spatial/compare?file=seagirt_power_network.ifc&base=1&target=9')).json.error.code, 'VERSION_NOT_FOUND');
  assert.equal((await h.call('POST', '/api/ifc-spatial/compare?file=other.ifc&base=1&target=2')).json.error.code, 'FILE_NOT_FOUND');
  assert.equal((await h.call('POST', '/api/ifc-spatial/compare?file=seagirt_power_network.ifc&base=1')).json.error.code, 'VERSIONS_REQUIRED');
  assert.equal(h.downloads.length, 0, 'nothing is downloaded for a refused request');
});

test('the converter: placements in metres whatever the file unit, ports linked to their element', async () => {
  const src = readFileSync(new URL('./fixtures/ifc/minimal-georef.ifc', import.meta.url), 'latin1');
  const mm = src.replace(/IFCSIUNIT\(\*,\.LENGTHUNIT\.,\$,\.METRE\.\)/, 'IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)');
  const [m, k] = [await convertIfc(Buffer.from(src, 'latin1'), {}), await convertIfc(Buffer.from(mm, 'latin1'), {})];
  assert.equal(m.diagnostics.lengthUnitScale, 1);
  assert.equal(k.diagnostics.lengthUnitScale, 0.001);
  for (const r of [m, k]) {
    const board = r.elements.find(e => e.networkId === 'SW-T' || e.name?.startsWith('SW-T'));
    // The placement origin sits inside the element's own geometry, in both units.
    for (let i = 0; i < 2; i += 1) assert.ok(board.placement.origin[i] >= board.bbox.min[i] - 1e-6 && board.placement.origin[i] <= board.bbox.max[i] + 1e-6);
    assert.match(board.geometry.signature, /^[0-9a-f]{16}$/);
  }
  const real = await convertIfc(V2, {});
  const ports = real.elements.filter(e => e.ifcClass === 'IfcDistributionPort');
  assert.ok(ports.length > 0 && ports.every(p => p.hostGlobalId));
});

test('a failed download is reported as an error, not as an empty comparison', async () => {
  const api = createIfcSpatialApi({ aps: { dataClient: () => ({}), projectFiles: async () => ({ project: { id: 'p' }, files: [{ fileName: 'n.ifc', tipVersionId: 'v2', versions: [{ id: 'v2', versionNumber: 2 }, { id: 'v1', versionNumber: 1 }] }] }) },
    cacheDir: mkdtempSync(join(tmpdir(), 'ifc-compare-')), logger: { info() {}, warn() {}, error() {} },
    download: async () => { throw new ApsError('FORBIDDEN', 403, 'You do not have access to this file in ACC.'); } });
  const req = Readable.from([]);
  Object.assign(req, { method: 'POST', url: '/api/ifc-spatial/compare?file=n.ifc&base=1&target=2', headers: {} });
  let status, payload;
  await api.handle(req, { writeHead(s) { status = s; }, end(b) { payload = b; } });
  assert.equal(status, 403);
  assert.equal(JSON.parse(String(payload)).error.code, 'FORBIDDEN');
});
