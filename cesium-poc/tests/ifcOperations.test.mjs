import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { convertIfc } from '../server/ifcSpatial/convert.mjs';
import { buildIfcNetwork } from '../src/ifcSpatial/ifcNetwork.js';
import { activeAlerts, assetStatuses, investigateOutage, STATUS, statusSummary } from '../src/ifcSpatial/operations.js';
import { STATE } from '../src/seagirt/electricalGraph.js';

// The model in ACC as version 2: STS-06 and HM-3 reported "No power", TX-M2 "POOR CONDITION".
const converted = await convertIfc(readFileSync(new URL('./fixtures/ifc/seagirt-compare-v1.ifc', import.meta.url)), {});
const toLonLat = (x, y, z) => ({ lon: -76.54 + x / 86000, lat: 39.256 + y / 111000, height: z });
const network = () => buildIfcNetwork({ elements: converted.elements, connections: converted.connections, toLonLat }).network;

test('status per asset, counted once over monitored assets (cables are connections, not counted)', () => {
  const net = network();
  const st = assetStatuses(net);
  const s = statusSummary(st);
  assert.deepEqual(s.counts, { POWERED: 68, NO_POWER: 2, DEGRADED: 1, OFFLINE: 0, UNKNOWN: 0 });
  assert.equal(s.total, 71);
  assert.equal(s.total, [...net.assets.values()].filter(a => a.assetType !== 'FEEDER').length);
  assert.deepEqual(s.ids.NO_POWER.sort(), ['HM-3', 'STS-06']);
  assert.deepEqual(s.ids.DEGRADED, ['TX-M2']);
  assert.equal(s.poweredPct, 97.2);
  assert.equal(s.asOf, '2026-11-24');
  assert.equal(st.get('STS-06').source, 'REPORTED');
  assert.equal(st.get('AP-01').monitored, false);
});

test('alerts: one per asset, reported power loss first, then degraded; with zone and status date', () => {
  const net = network();
  const alerts = activeAlerts(net, assetStatuses(net), { zoneOf: a => (a.id === 'STS-06' ? 'Berth Zone C' : null) });
  assert.deepEqual(alerts.map(a => [a.id, a.severity, a.status]), [['HM-3', 'CRITICAL', 'NO_POWER'], ['STS-06', 'CRITICAL', 'NO_POWER'], ['TX-M2', 'WARNING', 'DEGRADED']]);
  assert.equal(alerts[1].zone, 'Berth Zone C');
  assert.equal(alerts[1].date, '2026-11-24');
  assert.equal(new Set(alerts.map(a => a.id)).size, alerts.length);
});

test('outage investigation uses the connectivity: STS-06 is a loss at the asset; HM-3 has two potentially affected', () => {
  const net = network();
  const sts = investigateOutage(net, 'STS-06');
  assert.deepEqual(sts.confirmed, []);
  assert.deepEqual(sts.potential, []);
  assert.ok(sts.upstream.includes('QSS-C') && sts.upstream.at(-1) === 'CR-06');
  assert.match(sts.notes[0], /reported at STS-06 itself/);
  const hm = investigateOutage(net, 'HM-3');
  assert.deepEqual(hm.potential.sort(), ['HM-4', 'L2d']);
  assert.deepEqual(hm.confirmed, []);
  assert.match(hm.notes.join(' '), /requires verification/);
});

test('reported on equipment: what only it feeds is confirmed affected; unknown is never no power', () => {
  const elements = converted.elements.map(e => (e.networkId === 'AP-03' ? { ...e, properties: { ...e.properties, SuperDNA_AssetStatus: { PowerStatus: 'No power' } } } : e));
  const net = buildIfcNetwork({ elements, connections: converted.connections, toLonLat }).network;
  const st = assetStatuses(net);
  for (const id of ['STS-03', 'STS-04']) assert.deepEqual([st.get(id).status, st.get(id).source], [STATUS.NO_POWER, 'TOPOLOGY']);
  const inv = investigateOutage(net, 'AP-03', st);
  for (const id of ['STS-03', 'STS-04']) assert.ok(inv.confirmed.includes(id));
  // An asset the engine cannot decide (UNKNOWN) is counted as unknown.
  const fake = { assets: new Map([['X', { id: 'X', assetType: 'CRANE' }]]) };
  const unknown = assetStatuses(fake, { networkState: () => ({ nodeState: new Map([['X', 'dead']]), energized: { nodes: new Map([['X', STATE.UNKNOWN]]) } }) });
  assert.equal(unknown.get('X').status, STATUS.UNKNOWN);
});
