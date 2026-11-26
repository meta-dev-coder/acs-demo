import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGroups, clusterLabel, densityOf, isSignificant, modificationClasses, robustPoints } from '../src/ifcSpatial/changeGroups.js';
import { compareVersions } from '../server/ifcSpatial/compare.mjs';
import { convertIfc } from '../server/ifcSpatial/convert.mjs';

const ch = (status, ifcClass, mods = [], extra = {}) => ({ status, ifcClass, globalId: `${status}-${ifcClass}-${Math.random()}`, networkId: extra.networkId ?? null, modifications: mods, moved: status === 'MOVED', ...extra });
const props = { kind: 'properties', changes: [{ key: 'P.x' }] };

test('density: thresholds are settings; 7 is small, 20 medium, 131 large', () => {
  assert.deepEqual([0, 7, 10, 11, 30, 31, 131].map(n => densityOf(n)), ['small', 'small', 'small', 'medium', 'medium', 'large', 'large']);
  assert.equal(densityOf(131, { small: 200, medium: 500 }), 'small');
});

test('modification classes and significance: property-only is not significant; one element keeps all its tags', () => {
  const both = ch('MODIFIED', 'IfcCableSegment', [{ kind: 'route' }, props, { kind: 'ports' }]);
  assert.deepEqual([...modificationClasses(both)].sort(), ['connectivity', 'geometry', 'properties']);
  assert.equal(isSignificant(both), true);
  assert.equal(isSignificant(ch('MODIFIED', 'IfcCableSegment', [props])), false);
  assert.equal(isSignificant(ch('MODIFIED', 'IfcTransformer', [{ kind: 'ports' }, props])), true);
  assert.equal(isSignificant(ch('ADDED', 'IfcLightFixture')), true);
  assert.deepEqual([...modificationClasses(ch('MOVED', 'IfcElectricDistributionBoard', [props]))].sort(), ['placement', 'properties']);
});

test('groups: every change in exactly one group, by status and category; modified split into network and properties', () => {
  const changes = [
    ...Array.from({ length: 5 }, () => ch('ADDED', 'IfcProtectiveDevice')), ch('ADDED', 'IfcLightFixture'), ch('ADDED', 'IfcLightFixture'), ch('ADDED', 'IfcCableSegment'),
    ch('MOVED', 'IfcElectricDistributionBoard'), ch('REMOVED', 'IfcCableSegment'),
    ch('MODIFIED', 'IfcCableSegment', [{ kind: 'route' }, props]), ch('MODIFIED', 'IfcTransformer', [{ kind: 'ports' }]),
    ...Array.from({ length: 4 }, () => ch('MODIFIED', 'IfcCableSegment', [props])),
  ];
  const groups = buildGroups(changes);
  assert.deepEqual(groups.map(g => [g.label, g.members.length]), [
    ['New Circuit Breakers', 5], ['New Lights', 2], ['New Cables', 1], ['Relocated Switchgear', 1], ['Removed Cables', 1], ['Modified Network', 2], ['Modified Properties', 4]]);
  const all = groups.flatMap(g => g.members);
  assert.equal(all.length, changes.length);
  assert.equal(new Set(all).size, changes.length, 'no element counted twice');
  assert.equal(groups.find(g => g.id === 'modified-network').line, '2 assets (geometry/connectivity)');
  assert.equal(groups.find(g => g.id === 'modified-properties').significant, false);
  assert.equal(clusterLabel(groups[0], 3), '+3 New Circuit Breakers');
  assert.equal(clusterLabel(groups.find(g => g.id === 'modified-network'), 2), '2 Modified Network Elements');
});

test('framing leaves out a far outlier but not a real spread', () => {
  const near = Array.from({ length: 9 }, (_, i) => ({ lon: -76.54 + i * 0.001, lat: 39.256 }));
  assert.equal(robustPoints([...near, { lon: -76.2, lat: 39.4 }]).length, 9);
  const spread = [{ lon: -76.54, lat: 39.25 }, { lon: -76.53, lat: 39.25 }, { lon: -76.52, lat: 39.26 }, { lon: -76.51, lat: 39.26 }];
  assert.equal(robustPoints(spread).length, 4);
});

test('500+ changes group quickly and completely', () => {
  const changes = Array.from({ length: 1200 }, (_, i) => ch(['ADDED', 'MODIFIED', 'REMOVED'][i % 3], ['IfcCableSegment', 'IfcLightFixture', 'IfcProtectiveDevice'][i % 5 % 3], i % 3 === 1 ? [i % 2 ? props : { kind: 'ports' }] : []));
  const t0 = performance.now();
  const groups = buildGroups(changes);
  assert.ok(performance.now() - t0 < 200, 'grouping 1,200 changes is fast');
  assert.equal(groups.reduce((n, g) => n + g.members.length, 0), 1200);
});

test('no changes: no groups', () => assert.deepEqual(buildGroups([]), []));

test('the real V2 → V3 stays small: 7 changes, all significant (a re-route and a re-connection are network changes)', async () => {
  const conv = async f => { const r = await convertIfc(readFileSync(new URL(`./fixtures/ifc/${f}`, import.meta.url)), {}); return { elements: r.elements, connections: r.connections, georeference: r.diagnostics.georeference, lengthUnitScale: r.diagnostics.lengthUnitScale }; };
  const res = compareVersions(await conv('seagirt-compare-v1.ifc'), await conv('seagirt-compare-v2.ifc'));
  assert.equal(densityOf(res.summary.listed), 'small');
  const groups = buildGroups(res.changes);
  assert.deepEqual(groups.map(g => [g.id, g.members.length]), [['added-cable', 2], ['added-light', 2], ['moved-switchgear', 1], ['modified-network', 2]]);
  assert.equal(res.changes.filter(isSignificant).length, 7, 'the re-routed cable and the re-connected transformer are network changes');
});
